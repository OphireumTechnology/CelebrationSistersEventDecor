import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.ts';
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
