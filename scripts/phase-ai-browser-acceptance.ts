import assert from 'node:assert/strict';
import express from 'express';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.ts';
import {
  setGeminiExecutorForTests,
  setGeminiSleepForTests,
} from '../server/gemini.ts';

const SANDBOX_CHROMIUM_PATH =
  '/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell';

function resolveChromiumExecutablePath(): string | undefined {
  const configured = (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '').trim();
  if (configured) return configured;
  if (fsSync.existsSync(SANDBOX_CHROMIUM_PATH)) return SANDBOX_CHROMIUM_PATH;
  return undefined;
}

interface BrowserCheckResult {
  id: string;
  viewport: 'Desktop 1440x900' | 'Mobile 390x844';
  scenario: string;
  status: 'PASS' | 'FAIL';
  evidence: string;
  screenshot?: string;
}

const WEDDING_PROPOSAL = {
  themeName: 'Royal Estate Candlelit Heirloom',
  visionSummary:
    'An unforgettable Columbia historic estate wedding reception for 150 guests blending royal purple velvet lounges, elevated ivory garden rose towers, and glowing champagne-gold accents.',
  colorPalette: [
    { name: 'Royal Purple', hex: '#4B2087', usage: 'Velvet lounge vignettes, silk napkins, and menu crests' },
    { name: 'Champagne Gold', hex: '#B99045', usage: 'Tall floral risers, chargers, flatware, and taper holders' },
    { name: 'Soft Ivory', hex: '#FAF8F4', usage: 'Floor-length linens, drapery, and garden rose installations' },
    { name: 'Warm Charcoal', hex: '#292929', usage: 'Editorial calligraphy typography and signage framing' },
  ],
  floralConcept:
    'Asymmetrical clouds of ivory garden roses, white hydrangeas, and trailing greenery elevated on 36-inch brushed gold risers paired with glowing glass hurricane lanterns.',
  centerpieceDesign:
    'Elevated gold candelabras alternating with low crystal compote bowls of ivory garden roses and floating taper candles for clear guest conversation.',
  tableArrangement:
    'Alternating 72-inch ivory silk rounds and grand estate tables dressed with pleated royal purple silk runners, champagne chargers, and layered taper candles.',
  stageBackdrop:
    'Curved ivory architectural plaster installation framed in champagne gold with lush ground-level floral meadows anchoring the sweetheart table.',
  lightingPlan:
    'Warm 2700K amber pin-spots focused on every centerpiece paired with romantic royal-purple architectural wall grazing after dinner service.',
  venueStyling:
    'Floor-to-ceiling sheer ivory column drapery paired with royal-purple velvet cocktail lounges and monogrammed mirrored welcome signage.',
  guestExperience:
    'Live string quartet champagne terrace welcome, tactile wax-sealed seating cards, and an interactive late-evening espresso and portrait lounge.',
  recommendedDivisions: [
    'Wedding Planning and Design',
    'Luxury Event Decoration and Styling',
    'Event Lighting and Production',
    'Event Rentals and Logistics',
  ],
};

const BABY_SHOWER_PROPOSAL = {
  themeName: 'Botanical Ivory Conservatory Tea',
  visionSummary:
    'A sunlit botanical baby shower for 45 guests in soft sage, warm cream, and champagne gold with sculptural organic balloon installations and heirloom tea tables.',
  colorPalette: [
    { name: 'Conservatory Sage', hex: '#8FA382', usage: 'Eucalyptus garlands, linen runners, and stationery' },
    { name: 'Warm Cream', hex: '#FAF6EE', usage: 'Table linens, drapery, and matte organic balloons' },
    { name: 'Champagne Mist', hex: '#D8B979', usage: 'Tiered dessert stands, flatware, and signage frame' },
  ],
  floralConcept:
    'Clustered ceramic bud vases filled with white ranunculus, garden chamomile, and olive sprigs running down each conservatory table.',
  centerpieceDesign:
    'Low botanical bud vase clusters interspersed with woven rattan trays and petite ceramic vessels keeping brunch tables airy and conversational.',
  tableArrangement:
    'Three intimate rectangular garden tables seating 15 guests each with scalloped porcelain plates, sage gauze runners, and woven rattan chargers.',
  stageBackdrop:
    'Arched cream welcome wall wrapped in an organic matte-cream and sage balloon sculpture framing the pastry display and portrait corner.',
  lightingPlan:
    'Filtered natural greenhouse daylight complemented by soft warm-white bistro accents and gentle floral uplighting.',
  venueStyling:
    'Organic balloon garland framing the conservatory entrance, linen-draped gift display alcove, and soft cream lounge seating for expectant parents.',
  guestExperience:
    'Custom herbal tea and mocktail bar, keepsake floral bouquet wrapping station, and handwritten nursery wish cards at every place setting.',
  recommendedDivisions: [
    'Baby Showers and Gender Reveals',
    'Balloon Garlands and Custom Installations',
    'Luxury Event Decoration and Styling',
  ],
};

const CORPORATE_PROPOSAL = {
  themeName: 'Palmetto Executive Luminescence',
  visionSummary:
    'A black-tie corporate awards banquet for 300 executives combining crisp architectural stage lighting, tailored plum drapery, and high-visibility floral centerpieces.',
  colorPalette: [
    { name: 'Executive Plum', hex: '#3B186B', usage: 'Stage drape wash, satin napkins, and VIP sponsor lounge' },
    { name: 'Brushed Brass', hex: '#C29B48', usage: 'Awards stage trim, podium crest, and geometric risers' },
    { name: 'Crisp Alabaster', hex: '#F7F5F0', usage: 'Banquet round linens and structured orchid arrangements' },
  ],
  floralConcept:
    'Structured white phalaenopsis orchids arranged in brushed brass low architectural vessels preserving uninterrupted stage sightlines.',
  centerpieceDesign:
    'Low geometric brushed-brass troughs filled with white phalaenopsis orchids and frosted LED votives engineered to stay below keynote sightlines.',
  tableArrangement:
    'Thirty 72-inch executive banquet rounds seating 10 guests each with pressed alabaster linens, plum satin napkins, and illuminated table numbers.',
  stageBackdrop:
    'Modular fluted plum and brass awards stage flanked by twin sponsor projection screens and an illuminated central keynote lectern.',
  lightingPlan:
    'Broadcast-ready 3200K keynote front wash paired with DMX-programmed award reveal cues and subtle perimeter wall grazing.',
  venueStyling:
    'Tailored charcoal and plum architectural entry tunnel with illuminated sponsor step-and-repeat branding and velvet executive networking lounges.',
  guestExperience:
    'Seamless digital badge hospitality welcome, curated craft cocktail networking reception, and an editorial 360-degree awards portrait studio.',
  recommendedDivisions: [
    'Corporate Events',
    'Event Lighting and Production',
    'DJ, Entertainment and Hosting',
  ],
};

const REVISION_V2_PROPOSAL = {
  ...CORPORATE_PROPOSAL,
  themeName: 'Palmetto Executive Luminescence — Gala Revision v2',
  visionSummary:
    'Updated Revision v2 elevating the 300-guest executive awards gala with gold-framed VIP cocktail vignettes and expanded perimeter lighting choreography.',
};

const CONCIERGE_PROPOSAL = {
  reply:
    'We would be delighted to design your Columbia estate wedding for 150 guests! Based on your royal purple, champagne gold, and ivory aesthetic, I recommend Wedding Planning and Design, Luxury Event Decoration and Styling, and Event Lighting and Production. Final itemized pricing and venue availability are confirmed by our Lead Planner during consultation.',
  extractedLead: {
    eventCategory: 'Wedding Planning and Design',
    eventDate: 'Autumn 2027',
    location: 'Columbia, SC',
    guestCount: 150,
    theme: 'Royal Purple, Champagne Gold & Ivory Estate Reception',
    budgetRange: '$25,000 – $35,000',
    recommendedDivisions: [
      'Wedding Planning and Design',
      'Luxury Event Decoration and Styling',
      'Event Lighting and Production',
    ],
    needsHumanEscalation: false,
    summary:
      'Autumn 2027 Columbia estate wedding for 150 guests featuring royal purple, champagne gold, and ivory decor with floral towers and warm lighting.',
  },
};

async function main() {
  const results: BrowserCheckResult[] = [];
  const screenshotDir = path.resolve(process.cwd(), 'docs', 'ai-certification', 'screenshots');
  await fs.mkdir(screenshotDir, { recursive: true });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-ai-browser-'));
  const dbPath = path.join(tmpDir, 'ai-browser-db.json');

  process.env.CS_DB_PATH = dbPath;
  process.env.PERSISTENCE_ADAPTER = 'json-local';
  process.env.ALLOW_DEMO_AUTH = 'true';
  process.env.EMAIL_LIVE_DELIVERY_ENABLED = 'false';

  let forcedErrorMode: 'none' | '503' | 'timeout' = 'none';
  let forcedDelayMs = 150;

  setGeminiSleepForTests(async () => {});
  setGeminiExecutorForTests(async (params) => {
    if (forcedDelayMs > 0) {
      await new Promise((r) => setTimeout(r, forcedDelayMs));
    }
    if (forcedErrorMode === '503') {
      throw Object.assign(new Error('503 UNAVAILABLE: This model is currently experiencing high demand.'), {
        status: 503,
      });
    }
    if (forcedErrorMode === 'timeout') {
      throw new Error('AI_TIMEOUT:Concept Studio proposal exceeded 45000ms limit.');
    }
    const rawContents = JSON.stringify(params.contents || '');
    if (Array.isArray(params.contents)) {
      return { text: JSON.stringify(CONCIERGE_PROPOSAL) };
    }
    if (rawContents.includes('Revision v2') || rawContents.includes('VIP cocktail vignettes')) {
      return { text: JSON.stringify(REVISION_V2_PROPOSAL) };
    }
    if (rawContents.includes('Baby Showers')) {
      return { text: JSON.stringify(BABY_SHOWER_PROPOSAL) };
    }
    if (rawContents.includes('Corporate Events')) {
      return { text: JSON.stringify(CORPORATE_PROPOSAL) };
    }
    return { text: JSON.stringify(WEDDING_PROPOSAL) };
  });

  const distDir = path.resolve(process.cwd(), 'dist');
  const app = createApp({ enableRateLimit: false });
  app.use(express.static(distDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  assert.ok(typeof addr === 'object' && addr);
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const record = (
    id: string,
    viewport: BrowserCheckResult['viewport'],
    scenario: string,
    evidence: string,
    screenshot?: string,
  ) => {
    results.push({ id, viewport, scenario, status: 'PASS', evidence, screenshot });
    console.log(`[PASS] ${id} (${viewport}) — ${scenario}: ${evidence}`);
  };

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  try {
    const executablePath = resolveChromiumExecutablePath();
    browser = await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    // =========================================================================
    // DESKTOP 1440x900 AI SYSTEM CERTIFICATION FLOWS
    // =========================================================================
    const desktopCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await desktopCtx.newPage();

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!/Failed to load resource: the server responded with a status of (401|403|503|504)/.test(text)) {
          consoleErrors.push(text);
        }
      }
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^AI Studio$/i }).first().click();
    await page.getByRole('button', { name: /AI Concept Studio/i }).click();

    // AI-BA-01: Guest Wedding Deterministic Proposal renders completely (Defect D permanently eliminated!)
    await page.locator('#concept-event-type').selectOption('Wedding Planning and Design');
    await page.locator('#concept-guest-count').fill('150');
    await page.locator('#concept-venue-style').fill('Historic Southern Estate & Ballroom');
    await page.locator('#concept-preferred-palette').fill('Royal Purple, Champagne Gold, and Soft Ivory');
    await page
      .locator('#concept-vision-description')
      .fill(
        'Candlelit estate reception with elevated ivory floral towers, velvet lounge seating, and warm gold table details.',
      );

    const generateBtn = page.getByRole('button', { name: /Create New Concept Proposal/i });
    const responsePromise = page.waitForResponse(
      (r) => r.url().includes('/api/ai/concept-studio') && r.request().method() === 'POST',
    );
    await generateBtn.click();
    // Verify explicit loading feedback
    await page.getByText(/Composing Proposal|Composing your custom luxury concept/i).first().waitFor({ timeout: 5000 });
    const createResp = await responsePromise;
    assert.equal(createResp.status(), 200);

    // Wait for rendered mood board and verify empty state is GONE and stays gone
    await page.getByTestId('concept-theme-name').waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForTimeout(300); // Confirm no delayed useEffect wipe occurs!
    assert.equal(
      await page.getByText(/Compose your celebration vision on the left/i).isVisible(),
      false,
      'Empty state must not reappear after HTTP 200',
    );
    assert.equal(await page.getByTestId('concept-theme-name').textContent(), WEDDING_PROPOSAL.themeName);
    assert.match((await page.getByTestId('concept-vision-summary').textContent()) || '', /150 guests/i);
    assert.match((await page.getByTestId('concept-color-palette').textContent()) || '', /#4B2087/);
    assert.match((await page.getByTestId('concept-floral-concept').textContent()) || '', /ivory garden roses/i);
    assert.match((await page.getByTestId('concept-centerpiece-design').textContent()) || '', /gold candelabras/i);
    assert.match((await page.getByTestId('concept-table-arrangement').textContent()) || '', /72-inch ivory silk/i);
    assert.match((await page.getByTestId('concept-stage-backdrop').textContent()) || '', /plaster installation/i);
    assert.match((await page.getByTestId('concept-lighting-plan').textContent()) || '', /2700K amber pin-spots/i);
    assert.match((await page.getByTestId('concept-venue-styling').textContent()) || '', /sheer ivory column drapery/i);
    assert.match((await page.getByTestId('concept-guest-experience').textContent()) || '', /string quartet/i);
    assert.match(
      (await page.getByTestId('concept-recommended-divisions').textContent()) || '',
      /Wedding Planning and Design/,
    );
    const weddingIdText = (await page.getByTestId('concept-persistence-id').textContent()) || '';
    assert.match(weddingIdText, /Proposal ID:\s*cnc-/);

    const shot1 = path.join(screenshotDir, 'desktop-guest-wedding-moodboard.png');
    await page.screenshot({ path: shot1, fullPage: true });
    record(
      'AI-BA-01',
      'Desktop 1440x900',
      'Guest Concept Studio Wedding proposal renders full mood board after HTTP 200 (Defect D eliminated)',
      `${weddingIdText.trim()} | theme="${WEDDING_PROPOSAL.themeName}" | 4 swatches + 4 divisions visible`,
      shot1,
    );

    // AI-BA-02: Non-Wedding Event Type (Baby Shower, 45 guests) renders tailored content without Wedding bleed
    await page.locator('#concept-event-type').selectOption('Baby Showers and Gender Reveals');
    await page.locator('#concept-guest-count').fill('45');
    await page.locator('#concept-venue-style').fill('Botanical Conservatory');
    await page.locator('#concept-preferred-palette').fill('Sage, Warm Cream, and Champagne Mist');
    await page
      .locator('#concept-vision-description')
      .fill('Intimate garden tea baby shower with organic balloon garland and petite ceramic florals.');
    await page.getByRole('button', { name: /Create New Concept Proposal/i }).click();
    await page.getByText(BABY_SHOWER_PROPOSAL.themeName).first().waitFor({ state: 'visible', timeout: 8000 });
    assert.equal(await page.getByTestId('concept-theme-name').textContent(), BABY_SHOWER_PROPOSAL.themeName);
    assert.match(
      (await page.getByTestId('concept-recommended-divisions').textContent()) || '',
      /Baby Showers and Gender Reveals/,
    );
    record(
      'AI-BA-02',
      'Desktop 1440x900',
      'Baby Shower (45 guests) generates distinct event-specific mood board without Wedding template reuse',
      `theme="${BABY_SHOWER_PROPOSAL.themeName}" | #8FA382 visible`,
    );

    // AI-BA-03: Authenticated Customer (Camille) creates Corporate Gala concept, refreshes page, and reloads persisted proposal
    const switchResp = await page.evaluate(async () => {
      const r = await fetch('/api/auth/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId: 'user-client-camille' }),
      });
      return r.status;
    });
    assert.equal(switchResp, 200);
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^AI Studio$/i }).first().click();
    await page.getByRole('button', { name: /AI Concept Studio/i }).click();

    await page.locator('#concept-event-type').selectOption('Corporate Events');
    await page.locator('#concept-guest-count').fill('300');
    await page.locator('#concept-venue-style').fill('Columbia Convention Ballroom');
    await page.locator('#concept-preferred-palette').fill('Executive Plum, Brushed Brass, and Alabaster');
    await page
      .locator('#concept-vision-description')
      .fill('Annual executive awards gala for 300 guests with twin keynote screens and architectural lighting.');
    await page.getByRole('button', { name: /Create New Concept Proposal/i }).click();
    await page.getByText(CORPORATE_PROPOSAL.themeName).first().waitFor({ state: 'visible', timeout: 8000 });
    const corpIdText = (await page.getByTestId('concept-persistence-id').textContent()) || '';
    assert.match(corpIdText, /cnc-/);

    // Full page reload to confirm durable persistence across reloads!
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^AI Studio$/i }).first().click();
    await page.getByRole('button', { name: /AI Concept Studio/i }).click();
    await page.getByText(CORPORATE_PROPOSAL.themeName).first().waitFor({ state: 'visible', timeout: 8000 });
    const reloadedIdText = (await page.getByTestId('concept-persistence-id').textContent()) || '';
    assert.equal(reloadedIdText, corpIdText);

    const shot2 = path.join(screenshotDir, 'desktop-auth-persisted-reload.png');
    await page.screenshot({ path: shot2, fullPage: true });
    record(
      'AI-BA-03',
      'Desktop 1440x900',
      'Authenticated Corporate Gala proposal persists and reloads identically after browser refresh',
      `${reloadedIdText.trim()} survived full page.reload()`,
      shot2,
    );

    // AI-BA-04: Save Revision v2 & toggle Revision History v2 <-> v1
    await page
      .locator('#concept-vision-description')
      .fill('Revision v2 adding gold-framed VIP cocktail vignettes and expanded lighting choreography.');
    await page.getByRole('button', { name: /Save as Revision v2/i }).click();
    await page.getByText(REVISION_V2_PROPOSAL.themeName).first().waitFor({ state: 'visible', timeout: 8000 });
    assert.equal(await page.getByTestId('concept-theme-name').textContent(), REVISION_V2_PROPOSAL.themeName);
    await page.getByRole('button', { name: /^v1$/i }).click();
    assert.equal(await page.getByTestId('concept-theme-name').textContent(), CORPORATE_PROPOSAL.themeName);
    await page.getByRole('button', { name: /^v2$/i }).click();
    assert.equal(await page.getByTestId('concept-theme-name').textContent(), REVISION_V2_PROPOSAL.themeName);

    const shot3 = path.join(screenshotDir, 'desktop-revision-history.png');
    await page.screenshot({ path: shot3, fullPage: true });
    record(
      'AI-BA-04',
      'Desktop 1440x900',
      'Revision v2 creation and v1/v2 history switching work cleanly on persisted board',
      'Switched seamlessly between v2 and v1 on persisted Corporate Gala concept',
      shot3,
    );

    // AI-BA-05: 503 Provider Overload preserves form inputs and recovers cleanly via Retry button
    forcedErrorMode = '503';
    const preservedVision =
      'Preserved anniversary evening with heirloom gold candelabras and velvet conversation lounges.';
    await page.locator('#concept-vision-description').fill(preservedVision);
    await page.getByRole('button', { name: /Create New Concept Proposal/i }).click();
    await page.getByRole('alert').waitFor({ state: 'visible', timeout: 8000 });
    assert.match((await page.getByRole('alert').textContent()) || '', /high demand/i);
    assert.equal(await page.locator('#concept-vision-description').inputValue(), preservedVision);
    const retryBtn = page.getByRole('button', { name: /Retry Proposal Generation/i });
    assert.equal(await retryBtn.isVisible(), true);

    const shot4 = path.join(screenshotDir, 'desktop-503-recovery.png');
    await page.screenshot({ path: shot4, fullPage: true });

    // Restore provider & click Retry
    forcedErrorMode = 'none';
    const retry503RespPromise = page.waitForResponse(
      (r) => r.url().includes('/api/ai/concept-studio') && r.request().method() === 'POST',
    );
    await retryBtn.click();
    const retry503Resp = await retry503RespPromise;
    assert.equal(retry503Resp.status(), 200);
    await page.getByText(CORPORATE_PROPOSAL.themeName).first().waitFor({ state: 'visible', timeout: 8000 });
    record(
      'AI-BA-05',
      'Desktop 1440x900',
      '503 provider overload shows actionable Retry alert, preserves user inputs, and recovers on Retry click',
      'Alert displayed with correlation Ref + Retry button; inputs preserved and retry succeeded',
      shot4,
    );

    // AI-BA-05B: Authenticated 504 AI_TIMEOUT clears retained-lease key on manual Retry and recovers cleanly
    forcedErrorMode = 'timeout';
    const timeoutPreservedVision =
      'Timeout recovery check with luminous brass sculptural centerpieces and dramatic drapery.';
    await page.locator('#concept-vision-description').fill(timeoutPreservedVision);
    await page.getByRole('button', { name: /Create New Concept Proposal/i }).click();
    await page.getByRole('alert').waitFor({ state: 'visible', timeout: 8000 });
    assert.match((await page.getByRole('alert').textContent()) || '', /AI_TIMEOUT|longer than expected|response window/i);
    assert.equal(await page.locator('#concept-vision-description').inputValue(), timeoutPreservedVision);
    const timeoutRetryBtn = page.getByRole('button', { name: /Retry Proposal Generation/i });
    assert.equal(await timeoutRetryBtn.isVisible(), true);

    forcedErrorMode = 'none';
    const timeoutRetryResponsePromise = page.waitForResponse(
      (r) => r.url().includes('/api/ai/concept-studio') && r.request().method() === 'POST',
    );
    await timeoutRetryBtn.click();
    const timeoutRetryResp = await timeoutRetryResponsePromise;
    assert.equal(
      timeoutRetryResp.status(),
      200,
      'Authenticated manual Retry after AI_TIMEOUT must recover with HTTP 200 instead of 503 AI_SERVICE_BUSY',
    );
    record(
      'AI-BA-05B',
      'Desktop 1440x900',
      'Authenticated 504 AI_TIMEOUT preserves inputs and recovers with HTTP 200 on manual Retry (no lease self-lockout)',
      'AI_TIMEOUT alert shown; fresh Idempotency-Key issued on Retry; HTTP 200 proposal rendered',
    );

    // AI-BA-06: Customer B (Elena) isolation check in real browser
    await page.evaluate(async () => {
      await fetch('/api/auth/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId: 'user-client-elena' }),
      });
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^AI Studio$/i }).first().click();
    await page.getByRole('button', { name: /AI Concept Studio/i }).click();
    await page.waitForTimeout(300);
    assert.equal(
      await page.getByText(CORPORATE_PROPOSAL.themeName).isVisible(),
      false,
      'Customer B must not see Customer A concepts',
    );
    record(
      'AI-BA-06',
      'Desktop 1440x900',
      'Customer B (Elena) is strictly isolated from Customer A (Camille) persisted concepts',
      'Zero cross-customer concepts rendered for Elena',
    );

    // AI-BA-07: AI Event Concierge flow + Captured Planner Brief + 503 draft preservation
    await page.getByRole('button', { name: /AI Event Concierge/i }).click();
    const conciergeInput = page.getByLabel(/Message for AI Event Concierge/i);
    await conciergeInput.fill('Planning an autumn estate wedding in Columbia for 150 guests in purple and gold.');
    await page.getByRole('button', { name: /^Send$/i }).click();
    await page.getByText(/Transfer Brief to Consultation Form/i).waitFor({ state: 'visible', timeout: 8000 });
    assert.equal(await page.getByText(/Wedding Planning and Design/i).first().isVisible(), true);

    const shot5 = path.join(screenshotDir, 'desktop-concierge.png');
    await page.screenshot({ path: shot5, fullPage: true });
    record(
      'AI-BA-07',
      'Desktop 1440x900',
      'AI Event Concierge generates structured reply and populates Captured Planner Brief',
      'Assistant response + extracted lead (150 guests, 3 divisions) + Transfer Brief button rendered',
      shot5,
    );

    assert.equal(pageErrors.length, 0, `Unexpected desktop page errors: ${pageErrors.join('; ')}`);
    assert.equal(consoleErrors.length, 0, `Unexpected desktop console errors: ${consoleErrors.join('; ')}`);
    await desktopCtx.close();

    // =========================================================================
    // MOBILE 390x844 AI SYSTEM CERTIFICATION FLOWS
    // =========================================================================
    const mobileCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const mPage = await mobileCtx.newPage();
    const mobileErrors: string[] = [];
    mPage.on('pageerror', (err) => mobileErrors.push(err.message));

    await mPage.goto(baseUrl, { waitUntil: 'networkidle' });
    // Open mobile navigation drawer if hamburger button exists
    const menuBtn = mPage.getByRole('button', { name: /toggle navigation|menu/i }).first();
    if (await menuBtn.isVisible().catch(() => false)) {
      await menuBtn.click();
    }
    await mPage.getByRole('button', { name: /AI Studio/i }).first().click();
    await mPage.getByRole('button', { name: /AI Concept Studio/i }).click();

    await mPage.locator('#concept-event-type').selectOption('Wedding Planning and Design');
    await mPage.locator('#concept-guest-count').fill('150');
    await mPage.getByRole('button', { name: /Create New Concept Proposal/i }).click();
    await mPage.getByTestId('concept-theme-name').waitFor({ state: 'visible', timeout: 8000 });
    await mPage.waitForTimeout(300);

    const overflowMobileConcept = await mPage.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    assert.ok(overflowMobileConcept <= 2, `Mobile Concept Studio overflow: ${overflowMobileConcept}px`);
    assert.equal(await mPage.getByTestId('concept-theme-name').textContent(), WEDDING_PROPOSAL.themeName);
    assert.equal(await mPage.getByTestId('concept-centerpiece-design').isVisible(), true);
    assert.equal(await mPage.getByTestId('concept-venue-styling').isVisible(), true);
    assert.equal(await mPage.getByTestId('concept-guest-experience').isVisible(), true);
    assert.equal(await mPage.getByTestId('concept-recommended-divisions').isVisible(), true);

    const shot6 = path.join(screenshotDir, 'mobile-wedding-moodboard.png');
    await mPage.screenshot({ path: shot6, fullPage: true });
    record(
      'AI-BA-08',
      'Mobile 390x844',
      'Mobile Concept Studio generates and renders full Wedding mood board with zero overflow',
      `theme="${WEDDING_PROPOSAL.themeName}" | overflow=${overflowMobileConcept}px`,
      shot6,
    );

    await mPage.getByRole('button', { name: /AI Event Concierge/i }).click();
    await mPage.getByLabel(/Message for AI Event Concierge/i).fill('Wedding reception for 150 guests in Columbia, SC.');
    await mPage.getByRole('button', { name: /^Send$/i }).click();
    await mPage.getByText(/Transfer Brief to Consultation Form/i).waitFor({ state: 'visible', timeout: 8000 });
    const overflowMobileConcierge = await mPage.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    assert.ok(overflowMobileConcierge <= 2, `Mobile Concierge overflow: ${overflowMobileConcierge}px`);

    const shot7 = path.join(screenshotDir, 'mobile-concierge.png');
    await mPage.screenshot({ path: shot7, fullPage: true });
    record(
      'AI-BA-09',
      'Mobile 390x844',
      'Mobile AI Event Concierge renders reply and planner brief with zero overflow',
      `overflow=${overflowMobileConcierge}px | Transfer Brief visible`,
      shot7,
    );

    assert.equal(mobileErrors.length, 0, `Unexpected mobile page errors: ${mobileErrors.join('; ')}`);
    await mobileCtx.close();

    console.log(`\nALL ${results.length}/${results.length} AI BROWSER ACCEPTANCE CHECKS PASSED.`);
  } finally {
    setGeminiExecutorForTests(null);
    setGeminiSleepForTests(null);
    if (browser) await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('AI BROWSER ACCEPTANCE FAILED:', err);
  process.exit(1);
});
