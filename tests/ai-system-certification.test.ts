
import {
  acquireConceptLease,
  assertConceptLeaseOwnership,
  completeConceptLease,
  releaseConceptLease,
  CONCEPT_LEASE_TTL_MS,
  MAX_DURABLE_CONCEPT_LEASES,
} from '../server/repositories/conceptLeaseRepository.ts';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.ts';
import { readDb, withTransaction } from '../server/store.ts';
import { verifySessionToken, signSessionToken } from '../server/auth.ts';
import {
  classifyGeminiProviderError,
  DEFAULT_GEMINI_MODEL,
  getGeminiConfigStatus,
  normalizeGeminiModelName,
  setGeminiExecutorForTests,
  setGeminiSleepForTests,
} from '../server/gemini.ts';
import { observability } from '../server/observability.ts';
import { setInjectedPgPoolForTests, type PgPoolLike } from '../server/repositories/postgresRepository.ts';
import { apiFetch, parseApiErrorResponse } from '../src/lib/apiClient.ts';

async function startIsolatedServer() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-ai-cert-'));
  const prevDbPath = process.env.CS_DB_PATH;
  const prevAdapter = process.env.PERSISTENCE_ADAPTER;
  process.env.CS_DB_PATH = path.join(tmpDir, 'db.json');
  process.env.PERSISTENCE_ADAPTER = 'json-local';

  const app = createApp({ enableRateLimit: false });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

  return {
    baseUrl,
    cleanup: async () => {
      setGeminiExecutorForTests(null);
      setGeminiSleepForTests(null);
      setInjectedPgPoolForTests(null);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(tmpDir, { recursive: true, force: true });
      if (prevDbPath === undefined) delete process.env.CS_DB_PATH;
      else process.env.CS_DB_PATH = prevDbPath;
      if (prevAdapter === undefined) delete process.env.PERSISTENCE_ADAPTER;
      else process.env.PERSISTENCE_ADAPTER = prevAdapter;
    },
  };
}

const SAMPLE_WEDDING_PROPOSAL = {
  themeName: 'Royal Estate Candlelit Heirloom',
  visionSummary:
    'An atmospheric Southern estate celebration balancing deep royal purple velvet accents with warm champagne-gold floral towers and ivory candlelight for 150 guests.',
  colorPalette: [
    { name: 'Royal Purple', hex: '#4b2087', usage: 'Velvet lounge seating, silk napkins, and menu cresting' },
    { name: 'Champagne Gold', hex: '#B99045', usage: 'Tall floral risers, chargers, flatware, and candle tapers' },
    { name: 'Soft Ivory', hex: '#FAF8F4', usage: 'Estate drapery, floor-length linens, and garden roses' },
    { name: 'Warm Charcoal', hex: '#292929', usage: 'Calligraphy signage and architectural framing' },
  ],
  floralConcept:
    'Elevated cloud-like ivory garden rose, hydrangea, and ruscus towers set atop 36-inch brushed gold risers alternating with low candlelit compote bowls.',
  tableArrangement:
    'A balanced mix of 72-inch ivory silk round tables and a central king estate table dressed in pleated royal purple runners with gold-rimmed glass chargers.',
  stageBackdrop:
    'Curved ivory architectural plaster installation framed with champagne-gold trim and asymmetrical ground-level white rose meadows behind the sweetheart table.',
  lightingPlan:
    'Warm 2700K amber pin-spots highlighting every floral installation paired with dimmable royal-purple perimeter wall grazing during evening dancing.',
  recommendedDivisions: [
    'Wedding Planning and Design',
    'Luxury Event Decoration and Styling',
    'Event Lighting and Production',
    'Event Rentals and Logistics',
  ],
};

const SAMPLE_BABY_SHOWER_PROPOSAL = {
  themeName: 'Botanical Ivory Garden Welcome',
  visionSummary:
    'A sunlit Midlands conservatory baby shower for 45 guests combining soft sage botanicals, blush-cream balloon sculptures, and intimate tea-service tablescapes.',
  colorPalette: [
    { name: 'Conservatory Sage', hex: '#8FA382', usage: 'Eucalyptus garlands, linen runners, and stationery' },
    { name: 'Warm Cream', hex: '#FAF6EE', usage: 'Table linens, drapery, and organic balloon clusters' },
    { name: 'Champagne Mist', hex: '#D8B979', usage: 'Cutlery, cake pedestals, and welcome sign frame' },
  ],
  floralConcept:
    'Petite ceramic bud vases filled with white ranunculus, chamomile daisies, and olive sprigs clustered along long garden tables.',
  tableArrangement:
    'Three intimate rectangular garden tables seating 15 guests each with scalloped porcelain plates, sage gauze runners, and woven rattan chargers.',
  stageBackdrop:
    'Custom cream arched welcome panel paired with a sculptural organic matte-cream and sage balloon garland framing the dessert display and gift lounge.',
  lightingPlan:
    'Natural filtered conservatory daylight enhanced with soft warm bistro string accents and delicate fairy-light canopy highlights.',
  recommendedDivisions: [
    'Baby Showers and Gender Reveals',
    'Balloon Garlands and Custom Installations',
    'Luxury Event Decoration and Styling',
  ],
};

const SAMPLE_CORPORATE_PROPOSAL = {
  themeName: 'Palmetto Executive Luminescence',
  visionSummary:
    'A crisp black-tie corporate awards gala for 300 executives integrating architectural stage lighting, branded monogram projection, and structured banquet styling.',
  colorPalette: [
    { name: 'Executive Plum', hex: '#3B186B', usage: 'Stage wash, satin table overlays, and VIP lounge' },
    { name: 'Brushed Brass', hex: '#C29B48', usage: 'Podium framing, centerpiece pedestals, and awards risers' },
    { name: 'Crisp Alabaster', hex: '#F7F5F0', usage: 'Banquet rounds, architectural uplight contrast, and florals' },
  ],
  floralConcept:
    'Architectural white phalaenopsis orchids and structured monstera accents arranged in sleek metallic geometric vessels for unobstructed stage sightlines.',
  tableArrangement:
    'Thirty 72-inch executive banquet rounds seating 10 guests each with tailored alabaster linens, plum satin napkins, and numbered brass table beacons.',
  stageBackdrop:
    'Wide-format modular matte-plum and gold fluted keynote stage flanked by twin HD sponsor projection wings and an illuminated central awards lectern.',
  lightingPlan:
    'Broadcast-grade 3200K front-of-house keynote wash, synchronized DMX award-reveal cues, and subtle perimeter architectural uplighting.',
  recommendedDivisions: [
    'Corporate Events',
    'Event Lighting and Production',
    'DJ, Entertainment and Hosting',
  ],
};

const SAMPLE_ANNIVERSARY_PROPOSAL = {
  themeName: 'Golden Milestone Conservatory Soiree',
  visionSummary:
    'An intimate 25th anniversary dinner celebration for 80 guests featuring candlelit heirloom styling, velvet lounge vignettes, and acoustic string ambiance.',
  colorPalette: [
    { name: 'Heirloom Gold', hex: '#B99045', usage: 'Candelabras, rimmed stemware, and milestone signage' },
    { name: 'Deep Aubergine', hex: '#4B2087', usage: 'Velvet lounge sofas, wax seals, and silk runners' },
    { name: 'Ivory Silk', hex: '#FBF9F5', usage: 'Floor-length dining linens and floral installations' },
  ],
  floralConcept:
    'Low lush arrangements of ivory garden roses, burgundy scabiosa, and gilded magnolia leaves designed for effortless cross-table conversation.',
  tableArrangement:
    'Two grand candlelit feasting tables seating 40 guests each alongside a dedicated champagne lounge vignette and custom portrait guestbook station.',
  stageBackdrop:
    'Custom draped ivory silk frame accented with a gilded 25th milestone crest and flanking tall brass hurricane lanterns behind the toast space.',
  lightingPlan:
    'Layered amber taper candlelight supported by overhead warm-dim pin spots and gentle golden architectural grazing on conservatory columns.',
  recommendedDivisions: [
    'Anniversaries and Private Events',
    'Luxury Event Decoration and Styling',
    'Photo Booths and Guest Experiences',
  ],
};

const SAMPLE_CONCIERGE_RESULT = {
  reply:
    'Congratulations on your upcoming Columbia estate wedding! We would be delighted to guide your planning, luxury floral styling, and lighting production for 150 guests. Because final itemized quotations and date availability require Lead Planner confirmation, would you like me to transfer this brief directly to our consultation scheduler?',
  extractedLead: {
    eventCategory: 'Wedding Planning and Design',
    eventDate: 'October 2027',
    location: 'Columbia, SC',
    guestCount: 150,
    theme: 'Royal Purple, Champagne Gold & Ivory Estate Reception',
    budgetRange: '$25,000 - $35,000',
    recommendedDivisions: [
      'Wedding Planning and Design',
      'Luxury Event Decoration and Styling',
      'Event Lighting and Production',
    ],
    needsHumanEscalation: true,
    summary:
      'Prospective couple planning an October 2027 estate wedding in Columbia, SC for 150 guests seeking full design, floral towers, and lighting; requested custom quote review.',
  },
};

test('Gemini model normalization honors GEMINI_MODEL overrides, strips models/ prefix, and warns on deprecated models', () => {
  assert.equal(normalizeGeminiModelName('').model, DEFAULT_GEMINI_MODEL);
  assert.equal(normalizeGeminiModelName('').source, 'default');

  const stagingModel = normalizeGeminiModelName('gemini-3.8-flash');
  assert.equal(stagingModel.model, 'gemini-3.8-flash');
  assert.equal(stagingModel.source, 'env');
  assert.equal(stagingModel.warning, undefined);

  const prefixed = normalizeGeminiModelName('models/gemini-3.8-flash');
  assert.equal(prefixed.model, 'gemini-3.8-flash');

  const deprecated = normalizeGeminiModelName('gemini-2.5-flash');
  assert.equal(deprecated.model, 'gemini-2.5-flash');
  assert.match(deprecated.warning || '', /deprecated|unavailable/i);

  const invalid = normalizeGeminiModelName('bad model with spaces!!!');
  assert.equal(invalid.model, DEFAULT_GEMINI_MODEL);
  assert.match(invalid.warning || '', /Invalid GEMINI_MODEL/i);

  const prevModel = process.env.GEMINI_MODEL;
  const prevTimeout = process.env.GEMINI_TIMEOUT_MS;
  const prevRetries = process.env.GEMINI_MAX_RETRIES;
  try {
    process.env.GEMINI_MODEL = 'gemini-3.8-flash';
    process.env.GEMINI_TIMEOUT_MS = '55000';
    process.env.GEMINI_MAX_RETRIES = '3';
    const status = getGeminiConfigStatus();
    assert.equal(status.model, 'gemini-3.8-flash');
    assert.equal(status.modelSource, 'env');
    assert.equal(status.timeoutMs, 55_000);
    assert.equal(status.maxRetries, 3);
  } finally {
    if (prevModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = prevModel;
    if (prevTimeout === undefined) delete process.env.GEMINI_TIMEOUT_MS;
    else process.env.GEMINI_TIMEOUT_MS = prevTimeout;
    if (prevRetries === undefined) delete process.env.GEMINI_MAX_RETRIES;
    else process.env.GEMINI_MAX_RETRIES = prevRetries;
  }
});

test('Gemini error classifier accurately distinguishes transient vs non-retryable upstream failures', () => {
  const err503 = classifyGeminiProviderError({ status: 503, message: 'UNAVAILABLE: high demand' }, 'gemini-3.8-flash', 1);
  assert.equal(err503.code, 'AI_PROVIDER_TEMPORARILY_UNAVAILABLE');
  assert.equal(err503.httpStatus, 503);
  assert.equal(err503.retryable, true);

  const err429 = classifyGeminiProviderError(
    { status: 429, message: 'RESOURCE_EXHAUSTED', headers: { 'retry-after': '4' } },
    'gemini-3.8-flash',
    1,
  );
  assert.equal(err429.code, 'AI_PROVIDER_RATE_LIMITED');
  assert.equal(err429.httpStatus, 429);
  assert.equal(err429.retryable, true);
  assert.equal(err429.retryAfterSeconds, 4);

  const err404 = classifyGeminiProviderError({ status: 404, message: 'models/gemini-2.5-flash is not found' }, 'gemini-2.5-flash', 1);
  assert.equal(err404.code, 'AI_MODEL_UNAVAILABLE');
  assert.equal(err404.httpStatus, 502);
  assert.equal(err404.retryable, false);

  const err401 = classifyGeminiProviderError({ status: 401, message: 'API_KEY_INVALID' }, 'gemini-3.8-flash', 1);
  assert.equal(err401.code, 'AI_AUTH_ERROR');
  assert.equal(err401.retryable, false);

  const err400 = classifyGeminiProviderError({ status: 400, message: 'INVALID_ARGUMENT' }, 'gemini-3.8-flash', 1);
  assert.equal(err400.code, 'AI_BAD_REQUEST');
  assert.equal(err400.retryable, false);
});

test('Concept Studio retries transient 503 UNAVAILABLE and succeeds on attempt 2 without losing persistence', async () => {
  const { baseUrl, cleanup } = await startIsolatedServer();
  let attempts = 0;
  setGeminiSleepForTests(async () => {});
  setGeminiExecutorForTests(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw Object.assign(new Error('503 UNAVAILABLE: This model is currently experiencing high demand.'), {
        status: 503,
      });
    }
    return { text: JSON.stringify(SAMPLE_WEDDING_PROPOSAL) };
  });

  try {
    const res = await fetch(`${baseUrl}/api/ai/concept-studio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'Wedding Planning and Design',
        guestCount: 150,
        venueStyle: 'Historic Southern Estate & Ballroom',
        preferredPalette: 'Royal Purple, Champagne Gold, and Soft Ivory',
        visionDescription:
          'Candlelit estate reception with elevated ivory floral towers, velvet lounge seating, and warm gold table details.',
      }),
    });

    assert.equal(res.status, 200);
    assert.equal(attempts, 2);
    const data = (await res.json()) as {
      success: boolean;
      persisted: boolean;
      requestId: string;
      concept: {
        id: string;
        currentVersion: number;
        revisions: Array<{
          themeName: string;
          colorPalette: Array<{ hex: string }>;
          recommendedDivisions: string[];
        }>;
      };
    };
    assert.equal(data.success, true);
    assert.equal(data.persisted, true);
    assert.ok(data.requestId);
    assert.ok(data.concept.id.startsWith('cnc-'));
    assert.equal(data.concept.currentVersion, 1);
    assert.equal(data.concept.revisions[0].themeName, SAMPLE_WEDDING_PROPOSAL.themeName);
    // Verifies lowercase HEX #4b2087 was normalized to #4B2087
    assert.equal(data.concept.revisions[0].colorPalette[0].hex, '#4B2087');
    assert.equal(data.concept.revisions[0].recommendedDivisions.length, 4);
  } finally {
    await cleanup();
  }
});

test('Concept Studio returns clean structured 503 retryable error when overload persists across bounded retries', async () => {
  const { baseUrl, cleanup } = await startIsolatedServer();
  let attempts = 0;
  setGeminiSleepForTests(async () => {});
  setGeminiExecutorForTests(async () => {
    attempts += 1;
    throw Object.assign(new Error('503 UNAVAILABLE: high demand'), { status: 503 });
  });

  try {
    const res = await fetch(`${baseUrl}/api/ai/concept-studio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'Wedding Planning and Design',
        guestCount: 150,
        venueStyle: 'Historic Southern Estate & Ballroom',
        preferredPalette: 'Royal Purple, Champagne Gold, and Soft Ivory',
        visionDescription: 'Candlelit estate reception with ivory florals.',
      }),
    });

    assert.equal(res.status, 503);
    assert.equal(attempts, 3); // initial + 2 retries
    assert.ok(res.headers.get('retry-after'));
    const data = (await res.json()) as {
      success: boolean;
      code: string;
      retryable: boolean;
      error: string;
      requestId: string;
      errorDetail: { code: string; retryable: boolean; message: string };
    };
    assert.equal(data.success, false);
    assert.equal(data.code, 'AI_PROVIDER_TEMPORARILY_UNAVAILABLE');
    assert.equal(data.retryable, true);
    assert.equal(data.errorDetail.retryable, true);
    assert.ok(data.requestId);
    assert.doesNotMatch(data.error, /stack|GEMINI_API_KEY|Bearer/i);
  } finally {
    await cleanup();
  }
});

test('Concept Studio NEVER retries non-retryable 404 model error, malformed JSON, or invalid HEX schema output', async () => {
  const { baseUrl, cleanup } = await startIsolatedServer();
  setGeminiSleepForTests(async () => {});

  try {
    // 1. 404 Model Not Found -> single attempt, no retries
    let attempts404 = 0;
    setGeminiExecutorForTests(async () => {
      attempts404 += 1;
      throw Object.assign(new Error('404 NOT_FOUND: models/gemini-2.5-flash is not found'), { status: 404 });
    });
    const res404 = await fetch(`${baseUrl}/api/ai/concept-studio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'Corporate Events',
        guestCount: 200,
        venueStyle: 'Convention Ballroom',
        preferredPalette: 'Plum & Gold',
        visionDescription: 'Executive gala stage lighting and banquet styling.',
      }),
    });
    assert.equal(res404.status, 502);
    assert.equal(attempts404, 1);
    const body404 = (await res404.json()) as { code: string; retryable: boolean };
    assert.equal(body404.code, 'AI_MODEL_UNAVAILABLE');
    assert.equal(body404.retryable, false);

    // 2. Malformed JSON -> single attempt, 502 AI_INVALID_OUTPUT
    let attemptsMalformed = 0;
    setGeminiExecutorForTests(async () => {
      attemptsMalformed += 1;
      return { text: '{broken json' };
    });
    const resMalformed = await fetch(`${baseUrl}/api/ai/concept-studio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'Corporate Events',
        guestCount: 200,
        venueStyle: 'Convention Ballroom',
        preferredPalette: 'Plum & Gold',
        visionDescription: 'Executive gala stage lighting and banquet styling.',
      }),
    });
    assert.equal(resMalformed.status, 502);
    assert.equal(attemptsMalformed, 1);
    const bodyMalformed = (await resMalformed.json()) as { code: string };
    assert.equal(bodyMalformed.code, 'AI_INVALID_OUTPUT');

    // 3. Invalid HEX swatch -> rejected by Zod schema
    setGeminiExecutorForTests(async () => ({
      text: JSON.stringify({
        ...SAMPLE_WEDDING_PROPOSAL,
        colorPalette: [
          { name: 'Bad', hex: '#XYZ123', usage: 'Invalid color' },
          { name: 'Gold', hex: '#B99045', usage: 'Gold' },
          { name: 'Ivory', hex: '#FAF8F4', usage: 'Ivory' },
        ],
      }),
    }));
    const resBadHex = await fetch(`${baseUrl}/api/ai/concept-studio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'Wedding Planning and Design',
        guestCount: 150,
        venueStyle: 'Historic Estate',
        preferredPalette: 'Purple & Gold',
        visionDescription: 'Candlelit estate celebration.',
      }),
    });
    assert.equal(resBadHex.status, 502);
    const bodyBadHex = (await resBadHex.json()) as { code: string };
    assert.equal(bodyBadHex.code, 'AI_INVALID_OUTPUT');

    // 4. Markdown-fenced valid JSON -> stripped & accepted cleanly
    setGeminiExecutorForTests(async () => ({
      text: `\`\`\`json\n${JSON.stringify(SAMPLE_BABY_SHOWER_PROPOSAL)}\n\`\`\``,
    }));
    const resFenced = await fetch(`${baseUrl}/api/ai/concept-studio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'Baby Showers and Gender Reveals',
        guestCount: 45,
        venueStyle: 'Botanical Conservatory',
        preferredPalette: 'Sage, Cream, and Champagne',
        visionDescription: 'Intimate garden tea baby shower with organic balloon arch.',
      }),
    });
    assert.equal(resFenced.status, 200);
    const bodyFenced = (await resFenced.json()) as { concept: { revisions: Array<{ themeName: string }> } };
    assert.equal(bodyFenced.concept.revisions[0].themeName, SAMPLE_BABY_SHOWER_PROPOSAL.themeName);
  } finally {
    await cleanup();
  }
});

test('Concept Studio enforces Idempotency-Key deduplication, multi-event persistence, revision history, dual-approval lock, and Customer A/B isolation', async () => {
  const { baseUrl, cleanup } = await startIsolatedServer();
  setGeminiSleepForTests(async () => {});

  let geminiCalls = 0;
  setGeminiExecutorForTests(async (params) => {
    geminiCalls += 1;
    const textPrompt = String(params.contents || '');
    if (textPrompt.includes('Baby Showers')) return { text: JSON.stringify(SAMPLE_BABY_SHOWER_PROPOSAL) };
    if (textPrompt.includes('Corporate Events')) return { text: JSON.stringify(SAMPLE_CORPORATE_PROPOSAL) };
    if (textPrompt.includes('Anniversaries')) return { text: JSON.stringify(SAMPLE_ANNIVERSARY_PROPOSAL) };
    return { text: JSON.stringify(SAMPLE_WEDDING_PROPOSAL) };
  });

  try {
    // Authenticate as Customer A (Camille)
    const camilleAuth = await fetch(`${baseUrl}/api/auth/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-client-camille' }),
    });
    const { token: camilleToken } = (await camilleAuth.json()) as { token: string };

    // Authenticate as Customer B (Elena)
    const elenaAuth = await fetch(`${baseUrl}/api/auth/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-client-elena' }),
    });
    const { token: elenaToken } = (await elenaAuth.json()) as { token: string };

    // 1. Idempotency-Key deduplication
    const idemKey = 'idem-wedding-150-guests-001';
    const weddingPayload = {
      eventType: 'Wedding Planning and Design',
      guestCount: 150,
      venueStyle: 'Historic Southern Estate & Ballroom',
      preferredPalette: 'Royal Purple, Champagne Gold, and Soft Ivory',
      visionDescription:
        'Candlelit estate reception with elevated ivory floral towers, velvet lounge seating, and warm gold table details.',
    };

    const firstRes = await fetch(`${baseUrl}/api/ai/concept-studio`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${camilleToken}`,
        'Idempotency-Key': idemKey,
      },
      body: JSON.stringify(weddingPayload),
    });
    assert.equal(firstRes.status, 200);
    const firstBody = (await firstRes.json()) as {
      deduplicated: boolean;
      concept: { id: string; currentVersion: number };
    };
    assert.equal(firstBody.deduplicated, false);
    const createdId = firstBody.concept.id;

    const duplicateRes = await fetch(`${baseUrl}/api/ai/concept-studio`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${camilleToken}`,
        'Idempotency-Key': idemKey,
      },
      body: JSON.stringify(weddingPayload),
    });
    assert.equal(duplicateRes.status, 200);
    const dupBody = (await duplicateRes.json()) as {
      deduplicated: boolean;
      concept: { id: string };
    };
    assert.equal(dupBody.deduplicated, true);
    assert.equal(dupBody.concept.id, createdId);
    assert.equal(geminiCalls, 1);

    // 2. Create Corporate Gala & Anniversary concepts for multi-event matrix
    for (const evt of [
      {
        eventType: 'Corporate Events',
        guestCount: 300,
        venueStyle: 'Convention Ballroom',
        preferredPalette: 'Executive Plum & Brushed Brass',
        visionDescription: 'Annual awards banquet with twin keynote screens and structured florals.',
        expectedTheme: SAMPLE_CORPORATE_PROPOSAL.themeName,
      },
      {
        eventType: 'Anniversaries and Private Events',
        guestCount: 80,
        venueStyle: 'Lakefront Conservatory',
        preferredPalette: 'Heirloom Gold, Aubergine & Ivory',
        visionDescription: '25th anniversary candlelit dinner with acoustic strings and lounge vignette.',
        expectedTheme: SAMPLE_ANNIVERSARY_PROPOSAL.themeName,
      },
    ]) {
      const r = await fetch(`${baseUrl}/api/ai/concept-studio`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${camilleToken}`,
        },
        body: JSON.stringify(evt),
      });
      assert.equal(r.status, 200);
      const b = (await r.json()) as { concept: { revisions: Array<{ themeName: string }> } };
      assert.equal(b.concept.revisions[0].themeName, evt.expectedTheme);
    }

    // 3. Create Revision v2 on Camille's wedding concept
    const revRes = await fetch(`${baseUrl}/api/ai/concept-studio`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${camilleToken}`,
      },
      body: JSON.stringify({
        conceptId: createdId,
        eventType: 'Anniversaries and Private Events',
        guestCount: 150,
        venueStyle: 'Historic Estate Ballroom',
        preferredPalette: 'Heirloom Gold & Aubergine',
        visionDescription: 'Refined revision with candlelit long banquet feasting tables.',
      }),
    });
    assert.equal(revRes.status, 200);
    const revBody = (await revRes.json()) as {
      concept: { id: string; currentVersion: number; revisions: Array<{ version: number; themeName: string }> };
    };
    assert.equal(revBody.concept.id, createdId);
    assert.equal(revBody.concept.currentVersion, 2);
    assert.equal(revBody.concept.revisions.length, 2);
    assert.equal(revBody.concept.revisions[0].version, 2);
    assert.equal(revBody.concept.revisions[1].version, 1);

    // 4. Customer B (Elena) cannot list or revise Customer A's concept
    const elenaListRes = await fetch(`${baseUrl}/api/concepts`, {
      headers: { Authorization: `Bearer ${elenaToken}` },
    });
    assert.equal(elenaListRes.status, 200);
    const elenaList = (await elenaListRes.json()) as { concepts: Array<{ id: string }> };
    assert.equal(elenaList.concepts.some((c) => c.id === createdId), false);

    const elenaReviseRes = await fetch(`${baseUrl}/api/ai/concept-studio`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${elenaToken}`,
      },
      body: JSON.stringify({
        conceptId: createdId,
        ...weddingPayload,
      }),
    });
    assert.equal(elenaReviseRes.status, 403);

    // 5. Dual-approved concept cannot be mutated by client (409 CONCEPT_ALREADY_APPROVED)
    const approveSeedRes = await fetch(`${baseUrl}/api/concepts/cnc-101/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${camilleToken}` },
    });
    assert.equal(approveSeedRes.status, 200);

    const lockedReviseRes = await fetch(`${baseUrl}/api/ai/concept-studio`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${camilleToken}`,
      },
      body: JSON.stringify({
        conceptId: 'cnc-101',
        ...weddingPayload,
      }),
    });
    assert.equal(lockedReviseRes.status, 409);
    const lockedBody = (await lockedReviseRes.json()) as { code: string };
    assert.equal(lockedBody.code, 'CONCEPT_ALREADY_APPROVED');
  } finally {
    await cleanup();
  }
});

test('Concept Studio surfaces clean 500 AI_PERSISTENCE_FAILED when PostgreSQL write transaction fails', async () => {
  const { baseUrl, cleanup } = await startIsolatedServer();
  setGeminiSleepForTests(async () => {});
  setGeminiExecutorForTests(async () => ({ text: JSON.stringify(SAMPLE_WEDDING_PROPOSAL) }));

  // Inject a PostgreSQL test pool that serves preflight reads cleanly but fails on UPDATE inside transaction
  let inTx = false;
  const failingPgPool: PgPoolLike = {
    async query() {
      return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
    },
    async connect() {
      return {
        async query(sql: string) {
          if (sql.includes('BEGIN')) {
            inTx = true;
            return { rows: [], rowCount: 0, command: 'BEGIN', oid: 0, fields: [] };
          }
          if (sql.includes('ROLLBACK')) {
            inTx = false;
            return { rows: [], rowCount: 0, command: 'ROLLBACK', oid: 0, fields: [] };
          }
          if (sql.includes('UPDATE app_state_snapshots') && inTx) {
            throw Object.assign(new Error('ERROR: relation "app_state_snapshots" disk full / serialization failure'), {
              code: '40001',
            });
          }
          return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
        },
        release() {},
      };
    },
    async end() {},
  };

  process.env.PERSISTENCE_ADAPTER = 'postgres';
  setInjectedPgPoolForTests(failingPgPool);
  const beforeErrors = observability.getSnapshot().ai.persistenceErrors;

  try {
    const res = await fetch(`${baseUrl}/api/ai/concept-studio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'Wedding Planning and Design',
        guestCount: 150,
        venueStyle: 'Historic Estate',
        preferredPalette: 'Royal Purple & Gold',
        visionDescription: 'Candlelit estate celebration with ivory roses.',
      }),
    });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { code: string; retryable: boolean; error: string };
    assert.equal(body.code, 'AI_PERSISTENCE_FAILED');
    assert.equal(body.retryable, true);
    assert.doesNotMatch(body.error, /app_state_snapshots|40001|relation/i);
    assert.ok(observability.getSnapshot().ai.persistenceErrors >= beforeErrors + 1);
  } finally {
    await cleanup();
  }
});

test('AI Event Concierge supports multi-turn extraction, escalation flag, and retryable 429 recovery', async () => {
  const { baseUrl, cleanup } = await startIsolatedServer();
  setGeminiSleepForTests(async () => {});

  let calls = 0;
  setGeminiExecutorForTests(async () => {
    calls += 1;
    if (calls === 1) {
      throw Object.assign(new Error('429 RESOURCE_EXHAUSTED'), {
        status: 429,
        headers: { 'retry-after': '1' },
      });
    }
    return { text: JSON.stringify(SAMPLE_CONCIERGE_RESULT) };
  });

  try {
    const turn1 = await fetch(`${baseUrl}/api/ai/concierge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'We are planning a Columbia estate wedding for 150 guests and need a custom contract quote.',
      }),
    });
    assert.equal(turn1.status, 200);
    assert.equal(calls, 2);
    const data1 = (await turn1.json()) as {
      success: boolean;
      persisted: boolean;
      sessionId: string;
      reply: string;
      extractedLead: { guestCount: number; needsHumanEscalation: boolean; recommendedDivisions: string[] };
    };
    assert.equal(data1.success, true);
    assert.equal(data1.persisted, true);
    assert.ok(data1.sessionId.startsWith('ais-'));
    assert.equal(data1.extractedLead.guestCount, 150);
    assert.equal(data1.extractedLead.needsHumanEscalation, true);
    assert.equal(data1.extractedLead.recommendedDivisions.length, 3);

    // Turn 2 continues existing session
    const turn2 = await fetch(`${baseUrl}/api/ai/concierge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: data1.sessionId,
        message: 'Please also include velvet lounge rentals.',
        history: [
          { role: 'user', content: 'Planning a Columbia estate wedding for 150 guests.' },
          { role: 'assistant', content: data1.reply },
        ],
      }),
    });
    assert.equal(turn2.status, 200);
    const data2 = (await turn2.json()) as { sessionId: string };
    assert.equal(data2.sessionId, data1.sessionId);
  } finally {
    await cleanup();
  }
});

test('apiFetch aborts stalled requests at timeoutMs and parseApiErrorResponse extracts structured metadata', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
  }) as typeof fetch;

  try {
    const res = await apiFetch(
      '/api/ai/concept-studio',
      { method: 'POST', body: '{}', timeoutMs: 40 },
      { baseUrl: '/', apiBaseUrl: 'https://api.celebrationsisters.com' },
    );
    assert.equal(res.status, 504);
    const parsed = await parseApiErrorResponse(res);
    assert.equal(parsed.status, 504);
    assert.equal(parsed.code, 'REQUEST_TIMEOUT');
    assert.equal(parsed.retryable, true);
    assert.match(parsed.message, /longer than expected/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('AI-SEC: request fingerprint and caller isolation', async () => {
  const { baseUrl, cleanup } = await startIsolatedServer();

  setGeminiSleepForTests(async () => {});

  let calls = 0;

  setGeminiExecutorForTests(async () => {
    calls += 1;
    return {
      text: JSON.stringify(SAMPLE_WEDDING_PROPOSAL),
    };
  });

  try {
    const login = async (userId: string) => {
      const response = await fetch(
        `${baseUrl}/api/auth/switch`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ userId }),
        }
      );

      assert.equal(response.status, 200);

      const body = await response.json() as {
        token: string;
      };

      assert.ok(body.token);
      return body.token;
    };

    const customerA = await login('user-client-camille');
    const customerB = await login('user-client-elena');

    const payload = {
      eventType: 'Wedding Planning and Design',
      guestCount: 150,
      venueStyle: 'Historic Estate Ballroom',
      preferredPalette: 'Royal Purple and Gold',
      visionDescription:
        'Elegant candlelit wedding with ivory floral arrangements.',
    };

    const submit = async (
      token: string | undefined,
      key: string,
      data: object
    ) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      };

      if (token) headers.Authorization = `Bearer ${token}`;

      return fetch(`${baseUrl}/api/ai/concept-studio`, {
        method: 'POST',
        headers,
        body: JSON.stringify(data),
      });
    };

    const key = 'ai-sec-request-fingerprint-001';

    // Same caller, same key, same payload.
    const first = await submit(customerA, key, payload);
    assert.equal(first.status, 200);

    const firstBody = await first.json() as {
      concept: { id: string };
      deduplicated: boolean;
    };

    assert.equal(firstBody.deduplicated, false);

    const repeat = await submit(customerA, key, payload);
    assert.equal(repeat.status, 200);

    const repeatBody = await repeat.json() as {
      concept: { id: string };
      deduplicated: boolean;
    };

    assert.equal(repeatBody.deduplicated, true);
    assert.equal(repeatBody.concept.id, firstBody.concept.id);
    assert.equal(calls, 1);

    // Same caller and key, changed payload: reject.
    const changed = await submit(customerA, key, {
      ...payload,
      guestCount: 200,
    });

    assert.equal(changed.status, 409);

    const changedBody = await changed.json() as {
      code: string;
      concept?: unknown;
    };

    assert.equal(changedBody.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(changedBody.concept, undefined);
    assert.equal(calls, 1);

    // Another customer using the same key must not
    // receive Customer A's proposal.
    const other = await submit(customerB, key, payload);
    assert.equal(other.status, 200);

    const otherBody = await other.json() as {
      concept: { id: string };
      deduplicated: boolean;
    };

    assert.equal(otherBody.deduplicated, false);
    assert.notEqual(otherBody.concept.id, firstBody.concept.id);

    // Customer B cannot revise Customer A's proposal.
    const forbidden = await submit(
      customerB,
      'ai-sec-cross-customer-001',
      {
        ...payload,
        conceptId: firstBody.concept.id,
      }
    );

    assert.equal(forbidden.status, 403);

    // Anonymous callers cannot retrieve a shared cached
    // proposal by supplying an identical request key.
    const guestKey = 'ai-sec-shared-guest-001';

    const guestOne = await submit(undefined, guestKey, payload);
    const guestTwo = await submit(undefined, guestKey, payload);

    assert.equal(guestOne.status, 200);
    assert.equal(guestTwo.status, 200);

    const g1 = await guestOne.json() as {
      concept: { id: string };
      deduplicated: boolean;
    };

    const g2 = await guestTwo.json() as {
      concept: { id: string };
      deduplicated: boolean;
    };

    assert.notEqual(g1.concept.id, g2.concept.id);
    assert.equal(g1.deduplicated, false);
    assert.equal(g2.deduplicated, false);
    assert.equal(calls, 4);

  } finally {
    await cleanup();
  }
});

test('AI-CONC-01: concurrent identical requests persist one concept', async () => {
  const { baseUrl, cleanup } = await startIsolatedServer();

  setGeminiSleepForTests(async () => {});

  let providerCalls = 0;

  setGeminiExecutorForTests(async () => {
    providerCalls += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    return {
      text: JSON.stringify(SAMPLE_WEDDING_PROPOSAL),
    };
  });

  try {
    const login = await fetch(`${baseUrl}/api/auth/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'user-client-camille',
      }),
    });

    assert.equal(login.status, 200);

    const { token } = await login.json() as { token: string };
    assert.ok(token);

    const payload = {
      eventType: 'Wedding Planning and Design',
      guestCount: 150,
      venueStyle: 'Historic Estate Ballroom',
      preferredPalette: 'Royal Purple and Gold',
      visionDescription:
        'Elegant candlelit wedding with ivory floral arrangements.',
    };

    const submit = () => fetch(
      `${baseUrl}/api/ai/concept-studio`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': 'ai-concurrent-identical-001',
        },
        body: JSON.stringify(payload),
      },
    );

    const responses = await Promise.all([
      submit(),
      submit(),
      submit(),
    ]);

    for (const response of responses) {
      assert.equal(response.status, 200);
    }

    const results = await Promise.all(
      responses.map(async (response) =>
        await response.json() as {
          concept: { id: string; currentVersion: number };
          deduplicated: boolean;
          persisted: boolean;
        },
      ),
    );

    assert.equal(
      new Set(results.map((result) => result.concept.id)).size,
      1,
      'Concurrent requests must return the same concept ID',
    );

    assert.equal(
      results.filter((result) => !result.deduplicated).length,
      1,
      'Exactly one request may create a concept',
    );

    assert.ok(
      results.every((result) =>
        result.concept.currentVersion === 1),
    );

    console.log(
      `[AI-CONC-01] Upstream provider calls: ${providerCalls}`,
    );

    assert.equal(
      providerCalls,
      1,
      'Identical concurrent requests must invoke Gemini only once',
    );
  } finally {
    await cleanup();
  }
});

test('AI-CONC-02: concurrent conflicting payloads fail closed', async () => {
  const { baseUrl, cleanup } = await startIsolatedServer();

  setGeminiSleepForTests(async () => {});

  let providerCalls = 0;

  setGeminiExecutorForTests(async () => {
    providerCalls += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    return {
      text: JSON.stringify(SAMPLE_WEDDING_PROPOSAL),
    };
  });

  try {
    const login = await fetch(`${baseUrl}/api/auth/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'user-client-camille',
      }),
    });

    assert.equal(login.status, 200);

    const { token } = await login.json() as { token: string };
    assert.ok(token);

    const submit = (guestCount: number) => fetch(
      `${baseUrl}/api/ai/concept-studio`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': 'ai-concurrent-conflict-002',
        },
        body: JSON.stringify({
          eventType: 'Wedding Planning and Design',
          guestCount,
          venueStyle: 'Historic Estate Ballroom',
          preferredPalette: 'Royal Purple and Gold',
          visionDescription:
            'Elegant candlelit wedding with ivory floral arrangements.',
        }),
      },
    );

    const responses = await Promise.all([
      submit(150),
      submit(200),
    ]);

    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 409],
      'Exactly one request must succeed',
    );

    const rejected = responses.find(
      (response) => response.status === 409,
    );

    assert.ok(rejected);

    const rejection = await rejected.json() as {
      code: string;
      concept?: unknown;
      retryable: boolean;
    };

    assert.equal(rejection.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(rejection.concept, undefined);
    assert.equal(rejection.retryable, false);

    assert.equal(
      providerCalls,
      1,
      'Conflicting concurrent payloads must not invoke Gemini twice',
    );

    console.log(
      `[AI-CONC-02] Upstream provider calls: ${providerCalls}`,
    );
  } finally {
    await cleanup();
  }
});


// Phase 46F3C: deterministic authorization invalidation tests.
// All mutations occur exclusively in the isolated JSON fixture.

const authorizationScenarios = [
  {
    id: 'AI-AUTH-01',
    name: 'account suspended during generation',
    change: 'suspend',
  },
  {
    id: 'AI-AUTH-02',
    name: 'session revoked during generation',
    change: 'revoke',
  },
  {
    id: 'AI-AUTH-03',
    name: 'account role changed during generation',
    change: 'role',
  },
  {
    id: 'AI-AUTH-04',
    name: 'account deleted during generation',
    change: 'delete',
  },
] as const;

for (const scenario of authorizationScenarios) {
  test(
    `${scenario.id}: ${scenario.name} prevents persistence`,
    async () => {
      const { baseUrl, cleanup } = await startIsolatedServer();

      let providerCalls = 0;
      let markStarted!: () => void;
      let releaseProvider!: () => void;
      let pending: Promise<Response> | undefined;

      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });

      const providerBarrier = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });

      setGeminiSleepForTests(async () => {});

      setGeminiExecutorForTests(async () => {
        providerCalls += 1;
        markStarted();
        await providerBarrier;

        return {
          text: JSON.stringify(SAMPLE_WEDDING_PROPOSAL),
        };
      });

      try {
        assert.equal(
          process.env.PERSISTENCE_ADAPTER,
          'json-local',
        );

        assert.ok(
          process.env.CS_DB_PATH?.includes('cs-ai-cert-'),
          'Test must use the isolated fixture database',
        );

        const userId = 'user-client-camille';

        const login = await fetch(`${baseUrl}/api/auth/switch`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ userId }),
        });

        assert.equal(login.status, 200);

        const { token } = await login.json() as {
          token: string;
        };

        const session = verifySessionToken(token);

        assert.ok(session?.jti);
        const sessionJti = session.jti;

        const before = await readDb();
        const conceptCount = before.concepts.length;

        const requestKey = `${scenario.id}-security-test`;

        pending = fetch(`${baseUrl}/api/ai/concept-studio`, {
          method: 'POST',
          signal: AbortSignal.timeout(20000),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'Idempotency-Key': requestKey,
          },
          body: JSON.stringify({
            eventType: 'Wedding Planning and Design',
            guestCount: 150,
            venueStyle: 'Historic Estate Ballroom',
            preferredPalette: 'Royal Purple and Gold',
            visionDescription:
              'Elegant candlelit wedding with ivory floral arrangements.',
          }),
        });

        // Register a rejection handler immediately.
        void pending.catch(() => {});

        let timer: ReturnType<typeof setTimeout> | undefined;

        try {
          await Promise.race([
            started,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('Provider did not start')),
                5000,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }

        // Change authorization while generation is in progress.
        await withTransaction((db) => {
          const user = db.users.find((u) => u.id === userId);
          assert.ok(user);

          switch (scenario.change) {
            case 'suspend':
              user.accountStatus = 'suspended';
              break;

            case 'revoke':
              db.revokedSessionIds =
                db.revokedSessionIds || {};

              db.revokedSessionIds[sessionJti] =
                session.expiresAt;
              break;

            case 'role':
              user.role = 'staff';
              break;

            case 'delete':
              db.users = db.users.filter(
                (u) => u.id !== userId,
              );
              break;
          }
        });

        releaseProvider();

        const response = await pending;

        const result = await response.json() as {
          code?: string;
          success?: boolean;
          concept?: unknown;
          retryable?: boolean;
        };

        assert.equal(response.status, 403);
        assert.equal(result.code, 'AI_AUTHORIZATION_CHANGED');
        assert.equal(result.success, false);
        assert.equal(result.concept, undefined);
        assert.equal(result.retryable, false);
        assert.equal(providerCalls, 1);

        const after = await readDb();

        assert.equal(
          after.concepts.length,
          conceptCount,
          'Invalidated authorization must not persist a concept',
        );

        assert.equal(
          after.conceptIdempotencyKeys?.[
            `${userId}:${requestKey}`
          ],
          undefined,
          'Rejected requests must not create idempotency records',
        );

        if (scenario.change !== 'role') {
          // Replaying an explicitly invalidated credential
          // must fail before invoking the provider again.
          const replay = await fetch(
            `${baseUrl}/api/ai/concept-studio`,
            {
              method: 'POST',
              signal: AbortSignal.timeout(10000),
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                'Idempotency-Key': requestKey,
              },
              body: JSON.stringify({
                eventType: 'Wedding Planning and Design',
                guestCount: 150,
                venueStyle: 'Historic Estate Ballroom',
                preferredPalette: 'Royal Purple and Gold',
                visionDescription:
                  'Elegant candlelit wedding with ivory floral arrangements.',
              }),
            },
          );

          assert.equal(replay.status, 403);
          await replay.json();
          assert.equal(providerCalls, 1);
        }

        console.log(
          `[${scenario.id}] Authorization invalidated; zero new concepts persisted`,
        );
      } finally {
        releaseProvider();

        if (pending) {
          await pending.catch(() => {});
        }

        await cleanup();
      }
    },
  );
}


const recoveryTestPayload = {
  eventType: 'Wedding Planning and Design',
  guestCount: 150,
  venueStyle: 'Historic Estate Ballroom',
  preferredPalette: 'Royal Purple and Gold',
  visionDescription:
    'Elegant candlelit wedding with ivory floral arrangements.',
};

test(
  'AI-RECOVERY-01: provider failure releases coordination and permits retry',
  async () => {
    const { baseUrl, cleanup } = await startIsolatedServer();

    setGeminiSleepForTests(async () => {});

    let providerCalls = 0;
    let providerHealthy = false;

    setGeminiExecutorForTests(async () => {
      providerCalls += 1;

      if (!providerHealthy) {
        throw new Error(
          'Simulated provider failure for isolated recovery test',
        );
      }

      return {
        text: JSON.stringify(SAMPLE_WEDDING_PROPOSAL),
      };
    });

    try {
      assert.equal(
        process.env.PERSISTENCE_ADAPTER,
        'json-local',
      );

      assert.ok(
        process.env.CS_DB_PATH?.includes('cs-ai-cert-'),
      );

      const userId = 'user-client-camille';
      const requestKey = 'ai-provider-recovery-001';

      const login = await fetch(`${baseUrl}/api/auth/switch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userId }),
      });

      assert.equal(login.status, 200);

      const { token } = await login.json() as {
        token: string;
      };

      assert.ok(token);

      const before = await readDb();

      const submit = () => fetch(
        `${baseUrl}/api/ai/concept-studio`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(20000),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'Idempotency-Key': requestKey,
          },
          body: JSON.stringify(recoveryTestPayload),
        },
      );

      const failed = await submit();

      assert.ok(
        failed.status >= 400 && failed.status < 600,
        `Expected provider failure, received ${failed.status}`,
      );

      const failureBody = await failed.json() as {
        success?: boolean;
        concept?: unknown;
      };

      assert.equal(failureBody.success, false);
      assert.equal(failureBody.concept, undefined);

      const afterFailure = await readDb();

      assert.equal(
        afterFailure.concepts.length,
        before.concepts.length,
      );

      assert.equal(
        afterFailure.conceptIdempotencyKeys?.[
          `${userId}:${requestKey}`
        ],
        undefined,
      );

      const callsAfterFailure = providerCalls;
      assert.ok(callsAfterFailure >= 1);

      providerHealthy = true;

      // Retry the exact same request and idempotency key.
      const recovered = await submit();

      assert.equal(recovered.status, 200);

      const recoveredBody = await recovered.json() as {
        success: boolean;
        persisted: boolean;
        deduplicated: boolean;
        concept: { id: string };
      };

      assert.equal(recoveredBody.success, true);
      assert.equal(recoveredBody.persisted, true);
      assert.equal(recoveredBody.deduplicated, false);

      assert.equal(
        providerCalls,
        callsAfterFailure + 1,
        'Recovery must start one fresh provider operation',
      );

      const afterRecovery = await readDb();

      assert.equal(
        afterRecovery.concepts.length,
        before.concepts.length + 1,
      );

      const replay = await submit();

      assert.equal(replay.status, 200);

      const replayBody = await replay.json() as {
        deduplicated: boolean;
        concept: { id: string };
      };

      assert.equal(replayBody.deduplicated, true);

      assert.equal(
        replayBody.concept.id,
        recoveredBody.concept.id,
      );

      assert.equal(
        providerCalls,
        callsAfterFailure + 1,
      );

      console.log(
        '[AI-RECOVERY-01] Failure cleanup and same-key recovery verified',
      );
    } finally {
      await cleanup();
    }
  },
);

test(
  'AI-REVISION-01: concurrent identical revisions persist exactly once',
  async () => {
    const { baseUrl, cleanup } = await startIsolatedServer();

    setGeminiSleepForTests(async () => {});

    let providerCalls = 0;

    setGeminiExecutorForTests(async () => {
      providerCalls += 1;

      await new Promise<void>(
        (resolve) => setTimeout(resolve, 100),
      );

      return {
        text: JSON.stringify(SAMPLE_WEDDING_PROPOSAL),
      };
    });

    try {
      assert.equal(
        process.env.PERSISTENCE_ADAPTER,
        'json-local',
      );

      assert.ok(
        process.env.CS_DB_PATH?.includes('cs-ai-cert-'),
      );

      const login = await fetch(`${baseUrl}/api/auth/switch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: 'user-client-camille',
        }),
      });

      assert.equal(login.status, 200);

      const { token } = await login.json() as {
        token: string;
      };

      const submit = (
        payload: object,
        key: string,
      ) => fetch(
        `${baseUrl}/api/ai/concept-studio`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(20000),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'Idempotency-Key': key,
          },
          body: JSON.stringify(payload),
        },
      );

      const created = await submit(
        recoveryTestPayload,
        'ai-revision-create-001',
      );

      assert.equal(created.status, 200);

      const original = await created.json() as {
        concept: {
          id: string;
          currentVersion: number;
        };
      };

      assert.equal(original.concept.currentVersion, 1);

      const conceptId = original.concept.id;

      const beforeRevision = await readDb();

      const originalRecord = beforeRevision.concepts.find(
        (c) => c.id === conceptId,
      );

      assert.ok(originalRecord);

      const revisionCount =
        originalRecord.revisions.length;

      const callsBeforeRevision = providerCalls;

      const revisedPayload = {
        ...recoveryTestPayload,
        conceptId,
        guestCount: 180,
      };

      const responses = await Promise.all([
        submit(revisedPayload, 'ai-revision-shared-001'),
        submit(revisedPayload, 'ai-revision-shared-001'),
        submit(revisedPayload, 'ai-revision-shared-001'),
      ]);

      const results = await Promise.all(
        responses.map(async (response) => {
          assert.equal(response.status, 200);

          return await response.json() as {
            deduplicated: boolean;
            concept: {
              id: string;
              currentVersion: number;
            };
          };
        }),
      );

      assert.ok(
        results.every(
          (result) => result.concept.id === conceptId,
        ),
      );

      assert.ok(
        results.every(
          (result) => result.concept.currentVersion === 2,
        ),
      );

      assert.equal(
        results.filter((r) => !r.deduplicated).length,
        1,
      );

      assert.equal(
        providerCalls,
        callsBeforeRevision + 1,
      );

      const afterRevision = await readDb();

      assert.equal(
        afterRevision.concepts.length,
        beforeRevision.concepts.length,
      );

      const saved = afterRevision.concepts.find(
        (c) => c.id === conceptId,
      );

      assert.ok(saved);
      assert.equal(saved.currentVersion, 2);

      assert.equal(
        saved.revisions.length,
        revisionCount + 1,
      );

      console.log(
        '[AI-REVISION-01] One provider operation and exactly one stored revision',
      );
    } finally {
      await cleanup();
    }
  },
);


test(
  'AI-AUTH-05: session expiration during generation prevents persistence',
  async () => {
    const { baseUrl, cleanup } = await startIsolatedServer();

    const originalNow = Date.now;
    let clockOffset = 0;
    let providerCalls = 0;

    setGeminiSleepForTests(async () => {});

    try {
      assert.equal(
        process.env.PERSISTENCE_ADAPTER,
        'json-local',
      );

      assert.ok(
        process.env.CS_DB_PATH?.includes('cs-ai-cert-'),
      );

      const userId = 'user-client-camille';
      const requestKey = 'ai-session-expiration-001';

      const login = await fetch(`${baseUrl}/api/auth/switch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userId }),
      });

      assert.equal(login.status, 200);

      const { token } = await login.json() as {
        token: string;
      };

      const session = verifySessionToken(token);
      assert.ok(session);

      const now = originalNow();

      const shortSessionToken = signSessionToken({
        ...session,
        issuedAt: now,
        expiresAt: now + 60000,
      });

      assert.ok(verifySessionToken(shortSessionToken));

      const before = await readDb();

      Date.now = () => originalNow() + clockOffset;

      setGeminiExecutorForTests(async () => {
        providerCalls += 1;

        // Advance the isolated test process clock beyond
        // the signed session's expiration boundary.
        clockOffset = 120000;

        return {
          text: JSON.stringify(SAMPLE_WEDDING_PROPOSAL),
        };
      });

      const response = await fetch(
        `${baseUrl}/api/ai/concept-studio`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(20000),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${shortSessionToken}`,
            'Idempotency-Key': requestKey,
          },
          body: JSON.stringify(recoveryTestPayload),
        },
      );

      const result = await response.json() as {
        code?: string;
        success?: boolean;
        concept?: unknown;
        retryable?: boolean;
      };

      assert.equal(response.status, 403);
      assert.equal(result.code, 'AI_AUTHORIZATION_CHANGED');
      assert.equal(result.success, false);
      assert.equal(result.concept, undefined);
      assert.equal(result.retryable, false);
      assert.equal(providerCalls, 1);

      assert.equal(
        verifySessionToken(shortSessionToken),
        null,
      );

      const after = await readDb();

      assert.equal(
        after.concepts.length,
        before.concepts.length,
      );

      assert.equal(
        after.conceptIdempotencyKeys?.[
          `${userId}:${requestKey}`
        ],
        undefined,
      );

      console.log(
        '[AI-AUTH-05] Expired session rejected; zero new concepts persisted',
      );

    } finally {
      Date.now = originalNow;
      await cleanup();
    }
  },
);


test(
  'AI-SNAPSHOT-01: delayed stale snapshot reuses durable result',
  async (t) => {
    const { baseUrl, cleanup } = await startIsolatedServer();

    const fsModule = await import('node:fs/promises');
    const fileSystem = fsModule.default;

    let providerCalls = 0;
    let snapshotCaptured!: () => void;
    let releaseSnapshot!: () => void;
    let delayedRequest: Promise<Response> | undefined;

    const captured = new Promise<void>((resolve) => {
      snapshotCaptured = resolve;
    });

    const snapshotBarrier = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });

    setGeminiSleepForTests(async () => {});

    setGeminiExecutorForTests(async () => {
      providerCalls += 1;

      return {
        text: JSON.stringify(SAMPLE_WEDDING_PROPOSAL),
      };
    });

    try {
      assert.equal(
        process.env.PERSISTENCE_ADAPTER,
        'json-local',
      );

      const databasePath = process.env.CS_DB_PATH;

      assert.ok(databasePath?.includes('cs-ai-cert-'));

      const login = await fetch(`${baseUrl}/api/auth/switch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: 'user-client-camille',
        }),
      });

      assert.equal(login.status, 200);

      const { token } = await login.json() as {
        token: string;
      };

      assert.ok(token);

      const before = await readDb();
      const requestKey = 'ai-stale-snapshot-001';

      const submit = () => fetch(
        `${baseUrl}/api/ai/concept-studio`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(20000),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'Idempotency-Key': requestKey,
          },
          body: JSON.stringify(recoveryTestPayload),
        },
      );

      const originalReadFile = fileSystem.readFile;
      let interceptNextRead = true;

      const readMock = t.mock.method(
        fileSystem,
        'readFile',
        async (...args: unknown[]) => {
          const data = await Reflect.apply(
            originalReadFile,
            fileSystem,
            args,
          );

          if (
            interceptNextRead &&
            String(args[0]) === databasePath
          ) {
            interceptNextRead = false;

            snapshotCaptured();

            // Retain the original database contents until
            // the second request commits its proposal.
            await snapshotBarrier;
          }

          return data;
        },
      );

      delayedRequest = submit();
      void delayedRequest.catch(() => {});

      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        await Promise.race([
          captured,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(
                new Error('Stale snapshot interception did not occur'),
              ),
              5000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      assert.equal(providerCalls, 0);

      const completed = await submit();

      assert.equal(completed.status, 200);

      const completedBody = await completed.json() as {
        deduplicated: boolean;
        concept: {
          id: string;
          currentVersion: number;
        };
      };

      assert.equal(completedBody.deduplicated, false);
      assert.equal(providerCalls, 1);

      const committed = await readDb();

      assert.equal(
        committed.concepts.length,
        before.concepts.length + 1,
      );

      // Allow Request A to continue with its old snapshot.
      releaseSnapshot();

      const delayed = await delayedRequest;

      assert.equal(delayed.status, 200);

      const delayedBody = await delayed.json() as {
        deduplicated: boolean;
        concept: {
          id: string;
          currentVersion: number;
        };
      };

      assert.equal(delayedBody.deduplicated, true);

      assert.equal(
        delayedBody.concept.id,
        completedBody.concept.id,
      );

      assert.equal(
        delayedBody.concept.currentVersion,
        completedBody.concept.currentVersion,
      );

      assert.equal(
        providerCalls,
        1,
        'Stale snapshots must not invoke Gemini again',
      );

      readMock.mock.restore();

      const after = await readDb();

      assert.equal(
        after.concepts.length,
        before.concepts.length + 1,
      );

      console.log(
        '[AI-SNAPSHOT-01] Stale snapshot recovered; one provider call; one persisted concept',
      );

    } finally {
      releaseSnapshot();

      if (delayedRequest) {
        await delayedRequest.catch(() => {});
      }

      t.mock.restoreAll();

      await cleanup();
    }
  },
);


const cacheBookingSecurityScenarios = [
  {
    id: 'AI-CACHE-01',
    change: 'revoke',
    cached: true,
    status: 403,
  },
  {
    id: 'AI-CACHE-02',
    change: 'suspend',
    cached: true,
    status: 403,
  },
  {
    id: 'AI-CACHE-03',
    change: 'transfer',
    cached: true,
    status: 403,
  },
  {
    id: 'AI-BOOKING-01',
    change: 'transfer',
    cached: false,
    status: 403,
  },
  {
    id: 'AI-BOOKING-02',
    change: 'delete-booking',
    cached: false,
    status: 403,
  },
  {
    id: 'AI-BOOKING-03',
    change: 'reassign',
    cached: false,
    status: 409,
  },
  {
    id: 'AI-REVISION-02',
    change: 'delete-concept',
    cached: false,
    status: 404,
  },
] as const;

for (const scenario of cacheBookingSecurityScenarios) {
  test(
    `${scenario.id}: ${scenario.change} fails closed`,
    async (t) => {
      const { baseUrl, cleanup } =
        await startIsolatedServer();

      let providerCalls = 0;
      let blockProvider = false;
      let markStarted!: () => void;
      let releaseProvider!: () => void;
      let captureSnapshot!: () => void;
      let releaseSnapshot!: () => void;
      let pending: Promise<Response> | undefined;

      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });

      const providerBarrier = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });

      const captured = new Promise<void>((resolve) => {
        captureSnapshot = resolve;
      });

      const snapshotBarrier = new Promise<void>((resolve) => {
        releaseSnapshot = resolve;
      });

      const waitFor = async (
        signal: Promise<void>,
        message: string,
      ) => {
        let timer: ReturnType<typeof setTimeout> | undefined;

        try {
          await Promise.race([
            signal,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(message)),
                5000,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      setGeminiSleepForTests(async () => {});

      setGeminiExecutorForTests(async () => {
        providerCalls += 1;

        if (blockProvider) {
          markStarted();
          await providerBarrier;
        }

        return {
          text: JSON.stringify(SAMPLE_WEDDING_PROPOSAL),
        };
      });

      try {
        assert.equal(
          process.env.PERSISTENCE_ADAPTER,
          'json-local',
        );

        const databasePath = process.env.CS_DB_PATH;

        assert.ok(databasePath?.includes('cs-ai-cert-'));

        const userId = 'user-client-camille';
        const bookingId = 'bkg-101';
        const requestKey = `${scenario.id}-security-test`;

        const login = await fetch(`${baseUrl}/api/auth/switch`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ userId }),
        });

        assert.equal(login.status, 200);

        const { token } = await login.json() as {
          token: string;
        };

        const session = verifySessionToken(token);

        assert.ok(session?.jti);

        const submit = (
          payload: Record<string, unknown>,
          key = requestKey,
        ) => fetch(`${baseUrl}/api/ai/concept-studio`, {
          method: 'POST',
          signal: AbortSignal.timeout(20000),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'Idempotency-Key': key,
          },
          body: JSON.stringify(payload),
        });

        let payload: Record<string, unknown> = {
          ...recoveryTestPayload,
          bookingId,
        };

        const seed = await readDb();

        assert.ok(seed.bookings.some(
          (b) => b.id === bookingId && b.clientId === userId,
        ));

        if (
          scenario.cached ||
          scenario.change === 'reassign' ||
          scenario.change === 'delete-concept'
        ) {
          const created = await submit(
            payload,
            scenario.cached
              ? requestKey
              : `${requestKey}-create`,
          );

          assert.equal(created.status, 200);

          const result = await created.json() as {
            concept: { id: string; bookingId: string };
          };

          assert.ok(result.concept.id);
          assert.equal(result.concept.bookingId, bookingId);

          if (scenario.change === 'reassign') {
            payload = {
              ...payload,
              conceptId: result.concept.id,
              bookingId: 'bkg-103',
              guestCount: 180,
            };
          }

          if (scenario.change === 'delete-concept') {
            payload = {
              ...payload,
              conceptId: result.concept.id,
              guestCount: 180,
            };
          }
        }

        const before = await readDb();
        const callsBefore = providerCalls;

        if (scenario.cached) {
          // Capture an authorized old database snapshot,
          // then revoke access before the cache is returned.
          const originalReadFile = fs.readFile;
          let intercept = true;

          t.mock.method(
            fs,
            'readFile',
            async (...args: unknown[]) => {
              const data = await Reflect.apply(
                originalReadFile, fs, args,
              );

              if (
                intercept &&
                String(args[0]) === databasePath
              ) {
                intercept = false;
                captureSnapshot();
                await snapshotBarrier;
              }

              return data;
            },
          );

          pending = submit(payload);
          void pending.catch(() => {});

          await waitFor(
            captured,
            'Cache snapshot interception timed out',
          );

        } else if (scenario.change !== 'reassign') {
          blockProvider = true;

          pending = submit(payload);
          void pending.catch(() => {});

          await waitFor(
            started,
            'Provider interception timed out',
          );
        }

        if (scenario.change === 'reassign') {
          pending = submit(payload);
        } else {
          await withTransaction((db) => {
            switch (scenario.change) {
              case 'revoke':
                db.revokedSessionIds = db.revokedSessionIds || {};
                db.revokedSessionIds[session.jti!] =
                  session.expiresAt;
                break;

              case 'suspend': {
                const user = db.users.find(
                  (u) => u.id === userId,
                );
                assert.ok(user);
                user.accountStatus = 'suspended';
                break;
              }

              case 'transfer': {
                const booking = db.bookings.find(
                  (b) => b.id === bookingId,
                );
                assert.ok(booking);

                const newOwner = db.users.find(
                  (u) => u.role === 'client' && u.id !== userId,
                );

                assert.ok(newOwner);
                booking.clientId = newOwner.id;
                break;
              }

              case 'delete-booking':
                db.bookings = db.bookings.filter(
                  (b) => b.id !== bookingId,
                );
                break;

              case 'delete-concept':
                db.concepts = db.concepts.filter(
                  (c) => c.id !== payload.conceptId,
                );
                break;
            }
          });
        }

        const expectedState = await readDb();

        releaseSnapshot();
        releaseProvider();

        assert.ok(pending);

        const response = await pending;

        const result = await response.json() as {
          success?: boolean;
          code?: string;
          concept?: unknown;
          retryable?: boolean;
        };

        assert.equal(
          response.status,
          scenario.status,
          JSON.stringify(result),
        );

        assert.equal(result.success, false);
        assert.equal(result.concept, undefined);
        assert.equal(result.retryable, false);

        const expectedCode =
          scenario.change === 'revoke' ||
          scenario.change === 'suspend'
            ? 'AI_AUTHORIZATION_CHANGED'
            : scenario.change === 'reassign'
              ? 'CONCEPT_BOOKING_CONFLICT'
              : scenario.change === 'delete-concept'
                ? 'CONCEPT_NOT_FOUND'
                : 'FORBIDDEN';

        assert.equal(result.code, expectedCode);

        const expectedCalls =
          scenario.cached ||
          scenario.change === 'reassign'
            ? callsBefore
            : callsBefore + 1;

        assert.equal(providerCalls, expectedCalls);

        t.mock.restoreAll();

        const after = await readDb();

        assert.deepEqual(
          after.concepts,
          expectedState.concepts,
          'Rejected requests must not persist or revise concepts',
        );

        const scopedKey = `${userId}:${requestKey}`;

        assert.equal(
          after.conceptIdempotencyKeys?.[scopedKey],
          before.conceptIdempotencyKeys?.[scopedKey],
        );

        console.log(
          `[${scenario.id}] Access rejected; zero unauthorized concept changes`,
        );

      } finally {
        releaseSnapshot();
        releaseProvider();

        if (pending) {
          await pending.catch(() => {});
        }

        t.mock.restoreAll();
        await cleanup();
      }
    },
  );
}


test(
  'AI-SATURATION-01: excess concurrent participants are rejected safely',
  async () => {
    const { baseUrl, cleanup } =
      await startIsolatedServer();

    let providerCalls = 0;
    let releaseProvider!: () => void;

    const barrier = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });

    const pending: Promise<Response>[] = [];

    let timer: ReturnType<typeof setTimeout> | undefined;

    setGeminiSleepForTests(async () => {});

    setGeminiExecutorForTests(async () => {
      providerCalls += 1;

      await barrier;

      return {
        text: JSON.stringify(SAMPLE_WEDDING_PROPOSAL),
      };
    });

    try {
      assert.equal(
        process.env.PERSISTENCE_ADAPTER,
        'json-local',
      );

      assert.ok(
        process.env.CS_DB_PATH?.includes('cs-ai-cert-'),
      );

      const userId = 'user-client-camille';
      const requestKey = 'ai-saturation-test-001';

      const login = await fetch(`${baseUrl}/api/auth/switch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userId }),
      });

      assert.equal(login.status, 200);

      const { token } = await login.json() as {
        token: string;
      };

      assert.ok(token);

      const before = await readDb();

      const submit = () => fetch(
        `${baseUrl}/api/ai/concept-studio`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(20000),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'Idempotency-Key': requestKey,
          },
          body: JSON.stringify(recoveryTestPayload),
        },
      );

      // Hold the provider open while 17 requests compete
      // for the 16 available participant positions.
      for (let i = 0; i < 17; i += 1) {
        const request = submit();
        void request.catch(() => {});
        pending.push(request);
      }

      const firstCompleted = await Promise.race([
        ...pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(
              new Error('Participant saturation was not enforced'),
            ),
            10000,
          );
        }),
      ]);

      if (timer) clearTimeout(timer);

      assert.equal(firstCompleted.status, 503);

      const busy = await firstCompleted.clone().json() as {
        success: boolean;
        code: string;
        retryable: boolean;
        concept?: unknown;
      };

      assert.equal(busy.success, false);
      assert.equal(busy.code, 'AI_SERVICE_BUSY');
      assert.equal(busy.retryable, true);
      assert.equal(busy.concept, undefined);

      // Release the 16 accepted participants.
      releaseProvider();

      const responses = await Promise.all(pending);

      const accepted = responses.filter(
        (r) => r.status === 200,
      );

      const rejected = responses.filter(
        (r) => r.status === 503,
      );

      assert.equal(accepted.length, 16);
      assert.equal(rejected.length, 1);
      assert.equal(providerCalls, 1);

      const results = await Promise.all(
        accepted.map(async (response) =>
          await response.json() as {
            success: boolean;
            persisted: boolean;
            deduplicated: boolean;
            concept: {
              id: string;
              currentVersion: number;
            };
          },
        ),
      );

      const conceptId = results[0].concept.id;

      for (const result of results) {
        assert.equal(result.success, true);
        assert.equal(result.persisted, true);
        assert.equal(result.concept.id, conceptId);
        assert.equal(result.concept.currentVersion, 1);
      }

      assert.equal(
        results.filter((r) => !r.deduplicated).length,
        1,
      );

      const after = await readDb();

      assert.equal(
        after.concepts.length,
        before.concepts.length + 1,
      );

      // The rejected participant can retry safely after
      // capacity becomes available.
      const retry = await submit();

      assert.equal(retry.status, 200);

      const retryResult = await retry.json() as {
        deduplicated: boolean;
        concept: { id: string };
      };

      assert.equal(retryResult.deduplicated, true);
      assert.equal(retryResult.concept.id, conceptId);
      assert.equal(providerCalls, 1);

      const finalState = await readDb();

      assert.equal(
        finalState.concepts.length,
        before.concepts.length + 1,
      );

      console.log(
        '[AI-SATURATION-01] 16 accepted; 1 safely rejected; 1 provider call; 1 persisted concept; retry recovered',
      );

    } finally {
      if (timer) clearTimeout(timer);

      releaseProvider();

      await Promise.allSettled(pending);

      await cleanup();
    }
  },
);


const leaseFingerprintA = 'a'.repeat(64);
const leaseFingerprintB = 'b'.repeat(64);
const leaseScope = 'user-client-camille:lease-test-001';

async function requireTestLease(
  scope = leaseScope,
  fingerprint = leaseFingerprintA,
) {
  const result = await acquireConceptLease(
    scope, fingerprint,
  );

  assert.equal(result.status, 'acquired');

  if (result.status !== 'acquired') {
    throw new Error('Expected acquired lease');
  }

  return result.lease;
}

async function withIsolatedLeaseTest(
  fn: () => Promise<void>,
) {
  const { cleanup } = await startIsolatedServer();

  try {
    assert.equal(
      process.env.PERSISTENCE_ADAPTER,
      'json-local',
    );

    assert.ok(
      process.env.CS_DB_PATH?.includes('cs-ai-cert-'),
    );

    await fn();
  } finally {
    await cleanup();
  }
}

async function expireTestLease(key: string) {
  await withTransaction((db) => {
    const lease = db.conceptGenerationLeases?.[key];

    assert.ok(lease);

    lease.expiresAt = Date.now() - 1;
  });
}

test(
  'DC-01: twenty concurrent acquisitions permit one owner',
  async () => withIsolatedLeaseTest(async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        acquireConceptLease(
          leaseScope,
          leaseFingerprintA,
        ),
      ),
    );

    assert.equal(
      results.filter((r) => r.status === 'acquired').length,
      1,
    );

    assert.equal(
      results.filter((r) => r.status === 'busy').length,
      19,
    );

    const db = await readDb();

    assert.equal(
      Object.keys(db.conceptGenerationLeases || {}).length,
      1,
    );
  }),
);

test(
  'DC-02: conflicting fingerprints are rejected',
  async () => withIsolatedLeaseTest(async () => {
    const owner = await requireTestLease();

    const conflict = await acquireConceptLease(
      leaseScope,
      leaseFingerprintB,
    );

    assert.equal(conflict.status, 'conflict');

    await withTransaction((db) => {
      assertConceptLeaseOwnership(
        db, owner, leaseScope, leaseFingerprintA,
      );
    });
  }),
);

test(
  'DC-03: independent client scopes remain isolated',
  async () => withIsolatedLeaseTest(async () => {
    const first = await requireTestLease();

    const secondScope = 'different-client:lease-test-001';

    const second = await requireTestLease(secondScope);

    assert.notEqual(first.key, second.key);
    assert.notEqual(first.ownerToken, second.ownerToken);

    await withTransaction((db) => {
      assertConceptLeaseOwnership(
        db, first, leaseScope, leaseFingerprintA,
      );

      assertConceptLeaseOwnership(
        db, second, secondScope, leaseFingerprintA,
      );
    });

    assert.equal(await releaseConceptLease(first), true);

    const db = await readDb();

    assert.ok(db.conceptGenerationLeases?.[second.key]);
  }),
);

test(
  'DC-04: expired lease permits safe recovery',
  async () => withIsolatedLeaseTest(async () => {
    const first = await requireTestLease();

    assert.ok(
      first.expiresAt > Date.now(),
    );

    assert.ok(
      first.expiresAt <= Date.now() + CONCEPT_LEASE_TTL_MS,
    );

    await expireTestLease(first.key);

    const replacement = await requireTestLease();

    assert.equal(first.key, replacement.key);
    assert.notEqual(
      first.ownerToken,
      replacement.ownerToken,
    );

    await withTransaction((db) => {
      assertConceptLeaseOwnership(
        db, replacement, leaseScope, leaseFingerprintA,
      );
    });
  }),
);

test(
  'DC-05: expired and replaced owners fail fencing',
  async () => withIsolatedLeaseTest(async () => {
    const original = await requireTestLease();

    await expireTestLease(original.key);

    await assert.rejects(
      withTransaction((db) => {
        assertConceptLeaseOwnership(
          db, original, leaseScope, leaseFingerprintA,
        );
      }),
      /AI_CONCEPT_LEASE_LOST/,
    );

    const replacement = await requireTestLease();

    await assert.rejects(
      withTransaction((db) => {
        assertConceptLeaseOwnership(
          db, original, leaseScope, leaseFingerprintA,
        );
      }),
      /AI_CONCEPT_LEASE_LOST/,
    );

    await withTransaction((db) => {
      assertConceptLeaseOwnership(
        db, replacement, leaseScope, leaseFingerprintA,
      );
    });
  }),
);

test(
  'DC-06: former owners cannot release replacement leases',
  async () => withIsolatedLeaseTest(async () => {
    const original = await requireTestLease();

    await expireTestLease(original.key);

    const replacement = await requireTestLease();

    assert.equal(
      await releaseConceptLease(original),
      false,
    );

    await withTransaction((db) => {
      assertConceptLeaseOwnership(
        db, replacement, leaseScope, leaseFingerprintA,
      );
    });

    assert.equal(
      await releaseConceptLease(replacement),
      true,
    );
  }),
);

test(
  'DC-07: durable result prevents regeneration',
  async () => withIsolatedLeaseTest(async () => {
    const lease = await requireTestLease();

    let durableRecord = '';

    await withTransaction((db) => {
      const concept = db.concepts[0];

      assert.ok(
        concept,
        'Expected existing concept in isolated seed',
      );

      durableRecord =
        `v2:${leaseFingerprintA}:${concept.id}`;

      db.conceptIdempotencyKeys ||= {};

      db.conceptIdempotencyKeys[leaseScope] =
        durableRecord;

      completeConceptLease(
        db, lease, leaseScope, leaseFingerprintA,
      );
    });

    const completed = await acquireConceptLease(
      leaseScope,
      leaseFingerprintA,
    );

    assert.deepEqual(completed, {
      status: 'completed',
      record: durableRecord,
    });

    const conflict = await acquireConceptLease(
      leaseScope,
      leaseFingerprintB,
    );

    assert.equal(conflict.status, 'conflict');

    const db = await readDb();

    assert.equal(
      db.conceptGenerationLeases?.[lease.key],
      undefined,
    );
  }),
);

test(
  'DC-08: release permits retry and capacity remains bounded',
  async () => withIsolatedLeaseTest(async () => {
    const first = await requireTestLease();

    assert.equal(await releaseConceptLease(first), true);

    const replacement = await requireTestLease();

    assert.notEqual(first.ownerToken, replacement.ownerToken);

    await withTransaction((db) => {
      const leases = db.conceptGenerationLeases ||= {};

      const now = Date.now();

      for (
        let i = 1;
        i < MAX_DURABLE_CONCEPT_LEASES;
        i += 1
      ) {
        leases[`capacity-fixture-${i}`] = {
          fingerprint: leaseFingerprintA,
          ownerToken: `fixture-owner-${i}`,
          acquiredAt: now,
          expiresAt: now + CONCEPT_LEASE_TTL_MS,
        };
      }
    });

    const saturated = await acquireConceptLease(
      'another-client:capacity-test',
      leaseFingerprintA,
    );

    assert.equal(saturated.status, 'saturated');

    assert.equal(
      await releaseConceptLease(replacement),
      true,
    );

    const available = await acquireConceptLease(
      'another-client:capacity-test',
      leaseFingerprintA,
    );

    assert.equal(available.status, 'acquired');
  }),
);

test(
  'DC-09: failed finalization rolls back all changes',
  async () => withIsolatedLeaseTest(async () => {
    const lease = await requireTestLease();

    const before = await readDb();

    await assert.rejects(
      withTransaction((db) => {
        db.conceptIdempotencyKeys ||= {};

        db.conceptIdempotencyKeys[leaseScope] =
          `v2:${leaseFingerprintA}:nonexistent-concept`;

        completeConceptLease(
          db, lease, leaseScope, leaseFingerprintA,
        );
      }),
      /AI_CONCEPT_LEASE_RESULT_MISSING/,
    );

    const after = await readDb();

    assert.deepEqual(
      after.conceptIdempotencyKeys,
      before.conceptIdempotencyKeys,
    );

    assert.deepEqual(
      after.conceptGenerationLeases,
      before.conceptGenerationLeases,
    );

    assert.deepEqual(after.concepts, before.concepts);

    await withTransaction((db) => {
      assertConceptLeaseOwnership(
        db, lease, leaseScope, leaseFingerprintA,
      );
    });
  }),
);


// Phase 46F.4E.5B transport acceptance.
// Injected executors avoid external provider calls.

const TRANSPORT_TEST_INPUT = {
  eventType: 'Wedding Planning and Design',
  guestCount: 150,
  venueStyle: 'Historic Estate Ballroom',
  preferredPalette: 'Royal Purple and Gold',
  visionDescription: 'Elegant candlelit wedding with ivory floral arrangements.',
};

test('AI-TRANSPORT-01: executor receives a live AbortSignal', async () => {
  const { generateConceptProposal } = await import('../server/gemini.ts');

  let calls = 0;
  let observedSignal: AbortSignal | undefined;

  setGeminiExecutorForTests(async (params) => {
    calls += 1;

    assert.ok(params.config.abortSignal instanceof AbortSignal);

    observedSignal = params.config.abortSignal;

    assert.equal(observedSignal.aborted, false);

    return {
      text: JSON.stringify(SAMPLE_WEDDING_PROPOSAL),
    };
  });

  try {
    const proposal = await generateConceptProposal(
      TRANSPORT_TEST_INPUT,
      { timeoutMs: 3000, maxRetries: 0 },
    );

    assert.ok(proposal.themeName);
    assert.equal(calls, 1);
    assert.ok(observedSignal);
    assert.equal(observedSignal.aborted, false);
  } finally {
    setGeminiExecutorForTests(null);
  }
});

test('AI-TRANSPORT-02: elapsed timeout aborts the executor signal', async () => {
  const { generateConceptProposal } = await import('../server/gemini.ts');

  let aborted = false;
  let calls = 0;

  setGeminiExecutorForTests(async (params) => {
    calls += 1;

    const signal = params.config.abortSignal;

    assert.ok(signal instanceof AbortSignal);

    return new Promise((_resolve, reject) => {
      const onAbort = () => {
        aborted = true;
        reject(new DOMException('Aborted', 'AbortError'));
      };

      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, {
          once: true,
        });
      }
    });
  });

  try {
    await assert.rejects(
      generateConceptProposal(
        TRANSPORT_TEST_INPUT,
        { timeoutMs: 1000, maxRetries: 0 },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as Error & { code?: string }).code,
          'AI_TIMEOUT',
        );
        return true;
      },
    );

    assert.equal(calls, 1);
    assert.equal(aborted, true);
  } finally {
    setGeminiExecutorForTests(null);
  }
});

test('AI-TRANSPORT-03: ambiguous timeout is never automatically retried', async () => {
  const { generateConceptProposal } = await import('../server/gemini.ts');

  let calls = 0;
  let retrySleeps = 0;

  setGeminiSleepForTests(async () => {
    retrySleeps += 1;
  });

  setGeminiExecutorForTests(async () => {
    calls += 1;

    throw new Error(
      'AI_TIMEOUT: Controlled ambiguous provider timeout',
    );
  });

  try {
    await assert.rejects(
      generateConceptProposal(
        TRANSPORT_TEST_INPUT,
        { timeoutMs: 30000, maxRetries: 2 },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as Error & { code?: string }).code,
          'AI_TIMEOUT',
        );

        return true;
      },
    );

    assert.equal(calls, 1);
    assert.equal(retrySleeps, 0);
  } finally {
    setGeminiExecutorForTests(null);
    setGeminiSleepForTests(null);
  }
});

test('AI-TRANSPORT-04: short remaining deadline bounds provider attempt', async () => {
  const { generateConceptProposal } = await import('../server/gemini.ts');

  const originalNow = Date.now;
  const observedSignals: AbortSignal[] = [];

  let calls = 0;
  let clockAdvance = 0;
  let secondStarted = 0;
  let secondAborted = 0;

  Date.now = () => originalNow() + clockAdvance;

  setGeminiSleepForTests(async () => {
    // Leave less than the previous 2000ms attempt floor.
    clockAdvance = 4800;
  });

  setGeminiExecutorForTests(async (params) => {
    calls += 1;

    const signal = params.config.abortSignal;

    assert.ok(signal instanceof AbortSignal);

    observedSignals.push(signal);

    if (calls === 1) {
      throw Object.assign(
        new Error('503 UNAVAILABLE'),
        { status: 503 },
      );
    }

    secondStarted = originalNow();

    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        secondAborted = originalNow();
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  });

  try {
    await assert.rejects(
      generateConceptProposal(
        TRANSPORT_TEST_INPUT,
        { timeoutMs: 5000, maxRetries: 2 },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as Error & { code?: string }).code,
          'AI_TIMEOUT',
        );
        return true;
      },
    );

    assert.equal(calls, 2);

    assert.equal(observedSignals.length, 2);

    assert.notEqual(
      observedSignals[0],
      observedSignals[1],
    );

    assert.equal(observedSignals[0].aborted, false);
    assert.equal(observedSignals[1].aborted, true);

    assert.ok(secondStarted > 0);
    assert.ok(secondAborted >= secondStarted);

    // Allow scheduler overhead while still detecting
    // the former incorrect 2000ms timeout floor.
    assert.ok(
      secondAborted - secondStarted < 1200,
      'Attempt exceeded remaining overall timeout budget',
    );
  } finally {
    Date.now = originalNow;
    setGeminiExecutorForTests(null);
    setGeminiSleepForTests(null);
  }
});

test('AI-REPAIR-01: Attempt 1 uses full configured timeout budget instead of prematurely aborting at 72%', async () => {
  const { generateConceptProposal } = await import('../server/gemini.ts');

  let calls = 0;
  setGeminiExecutorForTests(async () => {
    calls += 1;
    // Simulate a slow-but-valid Gemini response taking ~82% of a 300ms timeout window
    await new Promise((resolve) => setTimeout(resolve, 240));
    return { text: JSON.stringify(SAMPLE_WEDDING_PROPOSAL) };
  });

  try {
    const proposal = await generateConceptProposal(TRANSPORT_TEST_INPUT, {
      timeoutMs: 320,
      maxRetries: 2,
    });
    assert.equal(calls, 1);
    assert.equal(proposal.themeName, SAMPLE_WEDDING_PROPOSAL.themeName);
  } finally {
    setGeminiExecutorForTests(null);
  }
});

test('AI-REPAIR-02: resolveThinkingLevelForModel enforces safe per-model ThinkingLevel defaults and overrides', async () => {
  const { resolveThinkingLevelForModel } = await import('../server/gemini.ts');

  assert.equal(resolveThinkingLevelForModel('gemini-3.5-flash-lite', ''), 'MINIMAL');
  assert.equal(resolveThinkingLevelForModel('gemini-3.8-flash', ''), 'LOW');
  assert.equal(resolveThinkingLevelForModel('gemini-4-hydrogen', ''), 'LOW');
  assert.equal(resolveThinkingLevelForModel('gemini-4-hydrogen', 'MINIMAL'), 'LOW');
  assert.equal(resolveThinkingLevelForModel('gemini-3.8-flash', 'MEDIUM'), 'MEDIUM');
  assert.equal(resolveThinkingLevelForModel('gemini-3.5-flash-lite', 'LOW'), 'LOW');
  assert.equal(resolveThinkingLevelForModel('gemini-2.5-pro', ''), 'DEFAULT');
});

test('AI-REPAIR-03: CONCEPT_LEASE_TTL_MS is certified to 180_000ms (2x MAX_GEMINI_TIMEOUT_MS)', async () => {
  const { MAX_GEMINI_TIMEOUT_MS } = await import('../server/gemini.ts');
  assert.equal(CONCEPT_LEASE_TTL_MS, 180_000);
  assert.equal(CONCEPT_LEASE_TTL_MS, MAX_GEMINI_TIMEOUT_MS * 2);
});

test('AI-REPAIR-04: Concept Studio responseSchema requires centerpieceDesign, venueStyling, and guestExperience and persists all 15 elements', async () => {
  const { generateConceptProposal } = await import('../server/gemini.ts');

  let capturedRequired: string[] = [];
  const full15ElementProposal = {
    ...SAMPLE_WEDDING_PROPOSAL,
    centerpieceDesign: 'Tiered champagne-gold candelabras with low ivory rose compotes preserving clear table sightlines.',
    venueStyling: 'Floor-to-ceiling sheer ivory column drapery framing royal-purple velvet cocktail vignettes.',
    guestExperience: 'Live string quartet champagne welcome, wax-sealed escort cards, and late-evening espresso lounge.',
  };

  setGeminiExecutorForTests(async (params) => {
    const schema = params.config.responseSchema as { required?: string[] } | undefined;
    capturedRequired = Array.isArray(schema?.required) ? schema.required : [];
    return { text: JSON.stringify(full15ElementProposal) };
  });

  try {
    const proposal = await generateConceptProposal(TRANSPORT_TEST_INPUT, {
      timeoutMs: 5000,
      maxRetries: 0,
    });
    assert.ok(capturedRequired.includes('centerpieceDesign'));
    assert.ok(capturedRequired.includes('venueStyling'));
    assert.ok(capturedRequired.includes('guestExperience'));
    assert.equal(proposal.centerpieceDesign, full15ElementProposal.centerpieceDesign);
    assert.equal(proposal.venueStyling, full15ElementProposal.venueStyling);
    assert.equal(proposal.guestExperience, full15ElementProposal.guestExperience);
  } finally {
    setGeminiExecutorForTests(null);
  }
});

test('AI-REPAIR-05: /ready and /api/health expose thinkingLevel and abortSignalSupported AI diagnostics', async () => {
  const env = await startIsolatedServer();
  try {
    const [readyRes, healthRes] = await Promise.all([
      fetch(`${env.baseUrl}/ready`),
      fetch(`${env.baseUrl}/api/health`),
    ]);
    assert.equal(readyRes.status, 200);
    assert.equal(healthRes.status, 200);
    const readyBody = (await readyRes.json()) as { ai?: { thinkingLevel?: string; abortSignalSupported?: boolean } };
    const healthBody = (await healthRes.json()) as { ai?: { thinkingLevel?: string; abortSignalSupported?: boolean } };
    assert.ok(typeof readyBody.ai?.thinkingLevel === 'string' && readyBody.ai.thinkingLevel.length > 0);
    assert.equal(readyBody.ai?.abortSignalSupported, true);
    assert.ok(typeof healthBody.ai?.thinkingLevel === 'string' && healthBody.ai.thinkingLevel.length > 0);
    assert.equal(healthBody.ai?.abortSignalSupported, true);
  } finally {
    await env.cleanup();
  }
});

