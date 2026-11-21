#!/usr/bin/env node
/**
 * Live Staging AI End-to-End Verification Runner (Zero Mocks).
 *
 * Exercises the REAL deployed Railway staging backend and live Google Gemini API
 * across the mandatory real-world test cases:
 *  - Health, readiness & repaired AI stack diagnostics (/health, /ready, /api/health)
 *  - CORS preflight for https://celebrationsistersdecor.com
 *  - Concept Studio: Wedding, Corporate Gala, Milestone Birthday, Baby Shower
 *    (validates HTTP 200, latency, X-Request-Id, all 15 Section 8 elements,
 *     valid #RRGGBB swatches, and zero wedding contamination in non-wedding events)
 *  - AI Event Concierge: multi-turn inquiry + structured extractedLead
 *  - Validation guardrails (HTTP 400 on invalid Concept Studio input)
 *  - Unauthenticated /api/concepts isolation boundary (HTTP 401)
 *
 * Usage:
 *   node scripts/verify-live-ai-staging.mjs --url https://isolated-staging.example.com --output live-ai-staging-report.json
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { AI_RESPONSE_TIMEOUT_MS } from '../src/lib/aiTimeouts.mjs';

const PUBLIC_ORIGIN = 'https://celebrationsistersdecor.com';
const LIVE_HOSTS = new Set([
  new URL(PUBLIC_ORIGIN).hostname,
  'www.celebrationsistersdecor.com',
  'celebrationsisterseventdecor-production.up.railway.app',
  'celebrationsisterseventdecor-staging-staging.up.railway.app',
]);

const WEDDING_CONTAMINATION_TERMS = [
  'bridal bouquet',
  'sweetheart table',
  'wedding arch',
  'ceremony aisle',
  'bride and groom',
];

function parseArgs(argv) {
  const args = { url: process.env.STAGING_URL?.trim() || '', output: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url' && argv[i + 1]) {
      args.url = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--output' && argv[i + 1]) {
      args.output = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function timedFetchJson(url, options = {}, timeoutMs = AI_RESPONSE_TIMEOUT_MS) {
  const startedAt = Date.now();
  const res = await fetch(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    status: res.status,
    ok: res.ok,
    durationMs: Date.now() - startedAt,
    requestId: res.headers.get('x-request-id') || null,
    corsOrigin: res.headers.get('access-control-allow-origin') || null,
    json,
    rawText: text.slice(0, 600),
  };
}

function validateConceptPayload(concept, { isWedding }) {
  const issues = [];
  if (!concept || typeof concept !== 'object') {
    return ['Missing concept object'];
  }
  if (!concept.id || typeof concept.id !== 'string') issues.push('Missing Proposal ID');
  if (!concept.eventType) issues.push('Missing eventType');
  if (!Array.isArray(concept.revisions) || concept.revisions.length === 0) {
    return [...issues, 'Missing revisions array'];
  }
  const rev = concept.revisions[0];
  const requiredTextFields = [
    'themeName',
    'visionSummary',
    'floralConcept',
    'centerpieceDesign',
    'tableArrangement',
    'stageBackdrop',
    'lightingPlan',
    'venueStyling',
    'guestExperience',
  ];
  for (const field of requiredTextFields) {
    if (typeof rev[field] !== 'string' || rev[field].trim().length < 10) {
      issues.push(`Missing or too-short field: ${field}`);
    }
  }
  if (!Array.isArray(rev.colorPalette) || rev.colorPalette.length < 3) {
    issues.push('Expected at least 3 colorPalette swatches');
  } else {
    for (const swatch of rev.colorPalette) {
      if (!/^#[0-9A-Fa-f]{6}$/.test(String(swatch?.hex || ''))) {
        issues.push(`Invalid HEX swatch: ${String(swatch?.hex)}`);
      }
    }
  }
  if (!Array.isArray(rev.recommendedDivisions) || rev.recommendedDivisions.length < 1) {
    issues.push('Missing recommendedDivisions');
  }
  if (concept.isConceptualVisualization !== true) {
    issues.push('Missing isConceptualVisualization=true flag');
  }
  if (!isWedding) {
    const combined = JSON.stringify(rev).toLowerCase();
    for (const term of WEDDING_CONTAMINATION_TERMS) {
      if (combined.includes(term)) {
        issues.push(`Wedding contamination detected in non-wedding proposal: "${term}"`);
      }
    }
  }
  return issues;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    throw new Error('Set --url or STAGING_URL to an isolated staging origin.');
  }
  const origin = new URL(args.url);
  const localhost = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && localhost)) {
    throw new Error('Staging requires HTTPS, or HTTP on localhost.');
  }
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Supply the isolated staging origin without credentials, path, query, or fragment.');
  }
  if (LIVE_HOSTS.has(origin.hostname.replace(/\.$/, ''))) {
    throw new Error('This host serves or backs public traffic. Use an isolated staging origin.');
  }

  const results = [];
  const addResult = (id, name, passed, details) => {
    results.push({ id, name, passed, ...details });
    const icon = passed ? 'PASS' : 'FAIL';
    console.log(`[${icon}] ${id}: ${name} (${details.durationMs ?? 0}ms, HTTP ${details.status ?? 'n/a'})`);
    if (!passed && details.detail) {
      console.log(`       -> ${details.detail}`);
    }
  };

  // 1. /api/health & repaired AI diagnostics check
  const health = await timedFetchJson(new URL('/api/health', origin), {}, 15_000);
  const aiDiag = health.json?.ai || {};
  const hasRepairedAiStack =
    health.ok &&
    aiDiag.configured === true &&
    typeof aiDiag.thinkingLevel === 'string' &&
    aiDiag.abortSignalSupported === true;
  addResult('LIVE-AI-00', 'Backend /api/health reports repaired AI stack (thinkingLevel + abortSignal)', hasRepairedAiStack, {
    status: health.status,
    durationMs: health.durationMs,
    requestId: health.requestId,
    ai: aiDiag,
    detail: hasRepairedAiStack
      ? `model=${aiDiag.model}, thinkingLevel=${aiDiag.thinkingLevel}, timeoutMs=${aiDiag.timeoutMs}`
      : `Stale or unconfigured AI backend detected: ${JSON.stringify(aiDiag)}`,
  });

  if (!hasRepairedAiStack) {
    throw new Error('Staging health check failed. No generation requests were sent.');
  }

  // 2. CORS Preflight
  const preflightStart = Date.now();
  const preflightRes = await fetch(new URL('/api/ai/concept-studio', origin), {
    method: 'OPTIONS',
    redirect: 'error',
    headers: {
      Origin: PUBLIC_ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,idempotency-key',
    },
    signal: AbortSignal.timeout(10_000),
  });
  const corsOk =
    (preflightRes.status === 204 || preflightRes.status === 200) &&
    preflightRes.headers.get('access-control-allow-origin') === PUBLIC_ORIGIN;
  addResult('LIVE-AI-CORS', 'CORS preflight allows celebrationsistersdecor.com with Idempotency-Key', corsOk, {
    status: preflightRes.status,
    durationMs: Date.now() - preflightStart,
    corsOrigin: preflightRes.headers.get('access-control-allow-origin'),
    detail: corsOk ? 'CORS preflight passed' : 'Unexpected CORS preflight response',
  });

  // 3. Mandatory Concept Studio Scenarios (Wedding, Corporate, Birthday, Baby Shower)
  const conceptCases = [
    {
      id: 'LIVE-AI-01',
      name: 'Concept Studio — Luxury Wedding',
      isWedding: true,
      payload: {
        eventType: 'Wedding Planning and Design',
        guestCount: 180,
        venueStyle: 'Glass Conservatory Ballroom',
        preferredPalette: 'Ivory, Blush Rose, and Champagne Gold',
        visionDescription:
          'Candlelit garden romance with floral walkway, tall crystal centerpieces, draped ceiling fabric, and warm champagne lounge areas.',
      },
    },
    {
      id: 'LIVE-AI-02',
      name: 'Concept Studio — Corporate Gala',
      isWedding: false,
      payload: {
        eventType: 'Corporate Events',
        guestCount: 300,
        venueStyle: 'Modern Metropolitan Convention Ballroom',
        preferredPalette: 'Midnight Navy, Brushed Silver, and Crisp White',
        visionDescription:
          'Executive leadership awards gala featuring branded LED stage wall, sleek architectural centerpieces, and interactive networking lounges.',
      },
    },
    {
      id: 'LIVE-AI-03',
      name: 'Concept Studio — Milestone Birthday',
      isWedding: false,
      payload: {
        eventType: 'Birthday Celebrations',
        guestCount: 85,
        venueStyle: 'Rooftop Conservatory & Terrace Lounge',
        preferredPalette: 'Emerald Green, Warm Gold, and Velvet Black',
        visionDescription:
          '40th milestone birthday supper club with sculptural balloon art, candlelit emerald dining tables, craft cocktail lounge, and custom DJ stage.',
      },
    },
    {
      id: 'LIVE-AI-04',
      name: 'Concept Studio — Baby Shower',
      isWedding: false,
      payload: {
        eventType: 'Baby Showers and Gender Reveals',
        guestCount: 60,
        venueStyle: 'Sunlit Garden Pavilion',
        preferredPalette: 'Sage Green, Buttercream Yellow, and Soft Ivory',
        visionDescription:
          'Botanical garden baby shower with organic balloon garland entrance, teddy-and-florals dessert display, linen brunch tables, and keepsake photo corner.',
      },
    },
  ];

  for (const tc of conceptCases) {
    const resp = await timedFetchJson(
      new URL('/api/ai/concept-studio', origin),
      {
        method: 'POST',
        headers: {
          Origin: PUBLIC_ORIGIN,
          'Content-Type': 'application/json',
          'Idempotency-Key': `live-verify-${tc.id.toLowerCase()}-${Date.now()}`,
        },
        body: JSON.stringify(tc.payload),
      },
      AI_RESPONSE_TIMEOUT_MS,
    );

    const issues = resp.ok ? validateConceptPayload(resp.json?.concept, { isWedding: tc.isWedding }) : [`HTTP ${resp.status}: ${resp.json?.code || resp.rawText}`];
    addResult(tc.id, tc.name, resp.ok && issues.length === 0, {
      status: resp.status,
      durationMs: resp.durationMs,
      requestId: resp.requestId,
      conceptId: resp.json?.concept?.id || null,
      themeName: resp.json?.concept?.revisions?.[0]?.themeName || null,
      detail: issues.length === 0 ? `Generated "${resp.json.concept.revisions[0].themeName}" (${resp.json.concept.id})` : issues.join('; '),
    });
  }

  // 4. AI Event Concierge — Multi-turn live conversation
  const firstMessage = 'We are planning a 150-guest luxury anniversary dinner in Columbia, SC next autumn with royal purple and gold styling.';
  const turn1 = await timedFetchJson(
    new URL('/api/ai/concierge', origin),
    {
      method: 'POST',
      headers: { Origin: PUBLIC_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: firstMessage,
        history: [],
      }),
    },
    AI_RESPONSE_TIMEOUT_MS,
  );
  const turn1Ok =
    turn1.ok &&
    turn1.json?.persisted === true &&
    typeof turn1.json?.sessionId === 'string' &&
    turn1.json.sessionId.length > 0 &&
    typeof turn1.json?.reply === 'string' &&
    turn1.json.reply.length >= 20 &&
    typeof turn1.json?.extractedLead?.eventCategory === 'string';
  addResult('LIVE-AI-05', 'AI Event Concierge — Turn 1 structured brief extraction', turn1Ok, {
    status: turn1.status,
    durationMs: turn1.durationMs,
    requestId: turn1.requestId,
    sessionId: turn1.json?.sessionId || null,
    detail: turn1Ok ? `eventCategory=${turn1.json.extractedLead.eventCategory}` : `HTTP ${turn1.status}: ${turn1.json?.code || turn1.rawText}`,
  });

  if (turn1Ok) {
    const turn2 = await timedFetchJson(new URL('/api/ai/concierge', origin), {
      method: 'POST',
      headers: { Origin: PUBLIC_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Please update the guest count to 120 and keep the venue in Columbia.',
        sessionId: turn1.json.sessionId,
        history: [
          { role: 'user', content: firstMessage },
          { role: 'assistant', content: turn1.json.reply.slice(0, 2_000) },
        ],
      }),
    });
    const turn2Ok =
      turn2.ok &&
      turn2.json?.persisted === true &&
      turn2.json?.sessionId === turn1.json.sessionId &&
      turn2.json?.extractedLead?.guestCount === 120;
    addResult('LIVE-AI-05B', 'AI Event Concierge — Turn 2 updates the same session', turn2Ok, {
      status: turn2.status,
      durationMs: turn2.durationMs,
      requestId: turn2.requestId,
      detail: turn2Ok ? 'Guest count updated to 120' : 'Expected a persisted guest count of 120 in the same session',
    });
  } else {
    addResult('LIVE-AI-05B', 'AI Event Concierge — Turn 2 updates the same session', false, {
      detail: 'Turn 1 did not return a persisted session',
    });
  }

  // 5. Validation & Isolation checks
  const badInput = await timedFetchJson(
    new URL('/api/ai/concept-studio', origin),
    {
      method: 'POST',
      headers: { Origin: PUBLIC_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType: 'Wedding', guestCount: 3, venueStyle: 'A', preferredPalette: 'B', visionDescription: 'no' }),
    },
    15_000,
  );
  addResult('LIVE-AI-06', 'Invalid Concept Studio payload rejected cleanly with HTTP 400', badInput.status === 400, {
    status: badInput.status,
    durationMs: badInput.durationMs,
    requestId: badInput.requestId,
    detail: badInput.status === 400 ? `code=${badInput.json?.code || '400'}` : `Expected 400, got ${badInput.status}`,
  });

  const unauthConcepts = await timedFetchJson(new URL('/api/concepts', origin), {}, 15_000);
  addResult('LIVE-AI-07', 'Unauthenticated /api/concepts fails closed with HTTP 401', unauthConcepts.status === 401, {
    status: unauthConcepts.status,
    durationMs: unauthConcepts.durationMs,
    requestId: unauthConcepts.requestId,
    detail: unauthConcepts.status === 401 ? 'Unauthorized access blocked' : `Expected 401, got ${unauthConcepts.status}`,
  });

  const passedCount = results.filter((r) => r.passed).length;
  const summary = {
    executedAt: new Date().toISOString(),
    stagingUrl: origin.origin,
    classification: passedCount === results.length ? 'LIVE_AI_VERIFIED' : 'FAILED',
    passed: passedCount,
    total: results.length,
    results,
  };

  if (args.output) {
    await fs.mkdir(path.dirname(path.resolve(args.output)), { recursive: true });
    await fs.writeFile(args.output, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }

  console.log(`\nLIVE AI STAGING SUMMARY: ${passedCount}/${results.length} passed — ${summary.classification}`);
  process.exit(passedCount === results.length ? 0 : 1);
}

run().catch((err) => {
  console.error('Live AI staging verification failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
