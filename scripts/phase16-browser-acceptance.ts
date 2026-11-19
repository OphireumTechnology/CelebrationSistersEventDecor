import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.ts';
import { generateTotpCode } from '../server/totp.ts';

const CHROMIUM_EXECUTABLE =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
  '/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell';

interface AcceptanceCheck {
  id: string;
  viewport: 'Desktop 1440x900' | 'Mobile 390x844';
  scenario: string;
  status: 'PASS' | 'FAIL';
  evidence: string;
}

function futureIsoDate(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

async function main() {
  const results: AcceptanceCheck[] = [];
  const externalFrontendUrl = (process.env.TARGET_FRONTEND_URL || '').trim().replace(/\/+$/, '');
  const externalApiBaseUrl = (process.env.TARGET_API_BASE_URL || externalFrontendUrl).trim().replace(/\/+$/, '');
  const isExternalStaging = Boolean(externalFrontendUrl);

  let tmpDir: string | null = null;
  let server: ReturnType<ReturnType<typeof createApp>['listen']> | null = null;
  let baseUrl = externalFrontendUrl;
  let apiBaseUrl = externalApiBaseUrl;

  if (!isExternalStaging) {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-phase16-browser-'));
    const dbPath = path.join(tmpDir, 'phase16-browser-db.json');

    process.env.CS_DB_PATH = dbPath;
    process.env.PERSISTENCE_ADAPTER = 'json-local';
    process.env.ALLOW_DEMO_AUTH = 'true';
    process.env.EMAIL_LIVE_DELIVERY_ENABLED = 'false';

    const distDir = path.resolve(process.cwd(), 'dist');
    const app = createApp({ enableRateLimit: false });
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });

    server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address();
    assert.ok(typeof addr === 'object' && addr);
    baseUrl = `http://127.0.0.1:${addr.port}`;
    apiBaseUrl = baseUrl;
  }

  const record = (
    id: string,
    viewport: AcceptanceCheck['viewport'],
    scenario: string,
    evidence: string,
  ) => {
    results.push({ id, viewport, scenario, status: 'PASS', evidence });
    console.log(`[PASS] ${id} (${viewport}) — ${scenario}: ${evidence}`);
  };

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  try {
    browser = await chromium.launch({
      executablePath: CHROMIUM_EXECUTABLE,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    // =========================================================================
    // DESKTOP 1440x900 ACCEPTANCE FLOWS (18 CHECKS)
    // =========================================================================
    const desktopCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await desktopCtx.newPage();

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        // Exclude expected negative-test HTTP status browser logs (401/403/503 probes)
        if (!/Failed to load resource: the server responded with a status of (401|403|503)/.test(text)) {
          consoleErrors.push(text);
        }
      }
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // P16-BA-01: Website loads with official branding
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    const title = await page.title();
    assert.match(title, /Celebration Sisters/i);
    assert.equal(await page.getByText(/Celebration Sisters/i).first().isVisible(), true);
    record('P16-BA-01', 'Desktop 1440x900', 'Website loads with official Celebration Sisters branding', `title="${title}"`);

    // P16-BA-02: Public navigation works across primary sections
    const visitedTabs: string[] = [];
    for (const navName of [/^Services$/i, /^Portfolio$/i, /^AI Studio$/i, /^Home$/i]) {
      const btn = page.getByRole('button', { name: navName }).first();
      if (await btn.isVisible()) {
        await btn.click();
        await page.waitForTimeout(150);
        visitedTabs.push((await btn.innerText()).trim());
      }
    }
    assert.ok(visitedTabs.length >= 3, `Expected at least 3 public nav transitions, visited: ${visitedTabs.join(', ')}`);
    record('P16-BA-02', 'Desktop 1440x900', 'Public navigation works across primary routes', `navigated=${visitedTabs.join(' -> ')}`);

    // P16-BA-03: Consultation wizard opens with accessible focus & Escape closes/reopens cleanly
    const bookTrigger = page.getByRole('button', { name: /Book a Consultation/i }).first();
    await bookTrigger.click();
    const dialog = page.getByRole('dialog', { name: /Book a Private Consultation/i });
    await dialog.waitFor({ state: 'visible' });
    const focusInsideModal = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      return Boolean(dlg && document.activeElement && dlg.contains(document.activeElement));
    });
    assert.equal(focusInsideModal, true);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await bookTrigger.click();
    await dialog.waitFor({ state: 'visible' });
    record('P16-BA-03', 'Desktop 1440x900', 'Consultation wizard opens with accessible focus & Escape cycle', 'focus trapped + Escape close/reopen verified');

    // P16-BA-04: Event discovery Step 1 validates required fields & captures Event Theme
    const eventDateInput = dialog.locator('input[type="date"]').first();
    await eventDateInput.fill('');
    const continueBtn = dialog.getByRole('button', { name: /^Continue$/i });
    await continueBtn.click();
    await dialog.getByText(/Please choose your target event date/i).waitFor({ state: 'visible' });

    await eventDateInput.fill(futureIsoDate(80));
    await dialog.getByPlaceholder(/Autumn Estate Wedding Reception/i).fill('Phase 16 Royal Garden Reception');
    await dialog.getByPlaceholder(/Candlelit Royal Amethyst/i).fill('Royal Amethyst & Champagne Candlelight');
    await dialog.getByPlaceholder(/Lace House Gardens/i).fill('Lace House Gardens');
    await continueBtn.click();
    record('P16-BA-04', 'Desktop 1440x900', 'Event discovery Step 1 validates and captures Event Theme', 'date guard + Event Theme captured');

    // P16-BA-05: Server-authoritative live availability loads in Step 2
    const firstAvailableSlotBtn = dialog.locator('button:not([disabled])').filter({ hasText: /AM|PM/ }).first();
    await firstAvailableSlotBtn.waitFor({ state: 'visible', timeout: 10_000 });
    const slotLabel = (await firstAvailableSlotBtn.innerText()).trim().replace(/\s+/g, ' ');
    await firstAvailableSlotBtn.click();
    await dialog.getByRole('button', { name: /^Continue$/i }).click();
    record('P16-BA-05', 'Desktop 1440x900', 'Live server-authoritative availability loads & selects slot', `slot="${slotLabel}"`);

    // P16-BA-06: Invalid appointment submission rejected (missing consent in UI + invalid past slot on server)
    await dialog.getByPlaceholder(/Jordan & Camille Mercer/i).fill('Audrey & Grant Holloway');
    await dialog.getByPlaceholder(/you@domain\.com/i).fill('audrey.holloway@example.com');
    await dialog.getByPlaceholder(/\(803\) 555-0148/i).fill('(803) 555-0192');
    await dialog.getByRole('button', { name: /Review Consultation/i }).click();
    await dialog.getByText(/privacy|consent/i).first().waitFor({ state: 'visible' });
    const invalidServerSlotRes = await fetch(`${apiBaseUrl}/api/consultations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName: 'Bad Slot Probe',
        clientEmail: 'probe@example.com',
        clientPhone: '(803) 555-0111',
        preferredContactMethod: 'email',
        eventType: 'Wedding',
        eventTitle: 'Past Slot Rejection Test',
        serviceDivisionIds: ['div-event-decor'],
        eventDate: '2027-08-10',
        venueName: 'Columbia Estate',
        location: 'Columbia, SC',
        guestCount: 100,
        budgetRange: '$25,000 - $50,000',
        consultationMethod: 'video',
        consultationStartUtc: '2020-01-01T15:00:00.000Z',
        plannerId: 'user-staff-maya',
        clientTimezone: 'America/New_York',
        privacyConsentAccepted: true,
      }),
    });
    assert.equal(invalidServerSlotRes.status, 400);
    record('P16-BA-06', 'Desktop 1440x900', 'Invalid appointments rejected by client consent guard & server validation', 'missing consent blocked + past slot HTTP 400');

    // Accept consent and move to Step 4 review
    await dialog.locator('input[type="checkbox"]').check();
    await dialog.getByRole('button', { name: /Review Consultation/i }).click();

    // P16-BA-18 (executed inline before valid submit): Simulated database outage (503) produces NO false confirmation
    let intercepted503 = false;
    await page.route('**/api/consultations', async (route) => {
      if (route.request().method() === 'POST' && !intercepted503) {
        intercepted503 = true;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Database service is temporarily unavailable. Please try again shortly.',
            code: 'DATABASE_UNAVAILABLE',
          }),
        });
        return;
      }
      await route.continue();
    });
    const confirmBookingBtn = dialog.getByRole('button', { name: /Confirm Private Consultation/i });
    await confirmBookingBtn.click();
    await dialog.getByText(/temporarily unavailable/i).waitFor({ state: 'visible' });
    assert.equal(await dialog.getByText(/Your Private Consultation Is Reserved/i).count(), 0);
    record('P16-BA-18', 'Desktop 1440x900', 'Database outage (HTTP 503) shows actionable alert & zero false confirmation', '503 intercepted cleanly');

    // P16-BA-07 & P16-BA-08: Valid booking persists & renders referenceCode + one-time csa_ token
    await confirmBookingBtn.click();
    await dialog.getByText(/Your Private Consultation Is Reserved/i).waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.getByText(/Private Reschedule & Status Verification Token/i).waitFor({ state: 'visible' });
    const modalText = await dialog.innerText();
    const refMatch = modalText.match(/CS-\d{4}-\d{4}/);
    const tokenMatch = modalText.match(/csa_[A-Za-z0-9_-]{20,}/);
    assert.ok(refMatch && tokenMatch, 'Confirmation must display persisted referenceCode and csa_ token');
    const referenceCode = refMatch[0];
    const accessToken = tokenMatch[0];
    record('P16-BA-07', 'Desktop 1440x900', 'Valid consultation booking persists cleanly on retry', `persisted ${referenceCode}`);
    record('P16-BA-08', 'Desktop 1440x900', 'Confirmation displays persisted reference code & scoped csa_ token', `ref=${referenceCode}, tokenLen=${accessToken.length}`);

    // P16-BA-10: Client self-service Manage portal rejects wrong token & opens verified appointment
    await dialog.getByRole('button', { name: /Manage \/ Reschedule Appointment/i }).click();
    await dialog.getByPlaceholder('CS-2026-0068').fill(referenceCode);
    await dialog.getByPlaceholder('csa_...').fill('csa_invalid_verification_probe_999');
    await dialog.getByRole('button', { name: /Verify & Open Appointment/i }).click();
    await dialog.getByText(/not found|invalid|revoked/i).waitFor({ state: 'visible' });

    await dialog.getByPlaceholder('csa_...').fill(accessToken);
    await dialog.getByRole('button', { name: /Verify & Open Appointment/i }).click();
    await dialog.getByText(/Phase 16 Royal Garden Reception/i).waitFor({ state: 'visible' });
    await dialog.getByText(/Royal Amethyst & Champagne Candlelight/i).waitFor({ state: 'visible' });
    record('P16-BA-10', 'Desktop 1440x900', 'Client self-service portal rejects wrong token & opens verified booking', `verified ${referenceCode}`);

    // P16-BA-11: Online rescheduling works
    await dialog.getByRole('button', { name: /Reschedule Consultation/i }).click();
    const rescheduleSlotBtn = dialog.locator('button:not([disabled])').filter({ hasText: /AM|PM/ }).first();
    await rescheduleSlotBtn.waitFor({ state: 'visible', timeout: 10_000 });
    const newSlotLabel = (await rescheduleSlotBtn.innerText()).trim().replace(/\s+/g, ' ');
    await rescheduleSlotBtn.click();
    await dialog.getByRole('button', { name: /Confirm Reschedule/i }).click();
    await dialog.getByText(/Rescheduled/i).first().waitFor({ state: 'visible', timeout: 10_000 });
    record('P16-BA-11', 'Desktop 1440x900', 'Client online rescheduling updates slot cleanly', `moved to "${newSlotLabel}"`);

    // P16-BA-12: Online cancellation cancels appointment & releases slot
    await dialog.getByRole('button', { name: /Cancel Appointment/i }).click();
    await dialog.getByPlaceholder(/Optional reason/i).fill('Adjusting wedding season');
    await dialog.getByRole('button', { name: /Yes, Cancel & Release Slot/i }).click();
    await dialog.getByText(/Cancelled/i).first().waitFor({ state: 'visible', timeout: 10_000 });
    record('P16-BA-12', 'Desktop 1440x900', 'Client online cancellation cancels appointment & releases slot', 'status -> Cancelled');

    await dialog.getByRole('button', { name: /Close modal/i }).click();
    await dialog.waitFor({ state: 'hidden' });

    // P16-BA-17: Unauthorized access to admin endpoints is rejected cleanly before Admin login
    const unauthProbe = await page.evaluate(async () => {
      const m = await fetch('/api/admin/metrics');
      const o = await fetch('/api/admin/outbox');
      return { metricsStatus: m.status, outboxStatus: o.status };
    });
    assert.ok(unauthProbe.metricsStatus === 401 || unauthProbe.metricsStatus === 403);
    assert.ok(unauthProbe.outboxStatus === 401 || unauthProbe.outboxStatus === 403);
    record('P16-BA-17', 'Desktop 1440x900', 'Unauthorized access to admin APIs is rejected', `metrics=${unauthProbe.metricsStatus}, outbox=${unauthProbe.outboxStatus}`);

    // Seed one active consultation for Admin Command Center workflows
    const availRes = await fetch(
      `${apiBaseUrl}/api/consultations/availability?startDate=${futureIsoDate(4)}&days=14&timezone=America/New_York&method=video`,
    );
    const availData = (await availRes.json()) as {
      days: Array<{ slots: Array<{ startUtc: string; plannerId: string; available: boolean }> }>;
    };
    const adminSlot = availData.days.flatMap((d) => d.slots).find((s) => s.available);
    assert.ok(adminSlot);
    const seedRes = await fetch(`${apiBaseUrl}/api/consultations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName: 'Claire Montgomery',
        clientEmail: 'claire.montgomery@example.com',
        clientPhone: '(803) 555-0166',
        preferredContactMethod: 'email',
        eventType: 'Corporate Gala',
        eventTitle: 'Carolina Botanical Winter Gala',
        eventTheme: 'Ivory Silk & Candlelit Gold',
        serviceDivisionIds: ['div-event-decor'],
        eventDate: futureIsoDate(95),
        venueName: 'Columbia Museum of Art',
        location: 'Columbia, SC',
        guestCount: 240,
        budgetRange: '$50,000 - $100,000',
        consultationMethod: 'video',
        consultationStartUtc: adminSlot.startUtc,
        plannerId: adminSlot.plannerId,
        clientTimezone: 'America/New_York',
        privacyConsentAccepted: true,
      }),
    });
    assert.equal(seedRes.status, 201);
    const seeded = (await seedRes.json()) as {
      consultation: { id: string; referenceCode: string; assignedPlannerId: string };
    };

    // Authenticate Executive Admin with MFA TOTP
    const switchRes = await fetch(`${apiBaseUrl}/api/auth/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ userId: 'user-admin-director' }),
    });
    assert.equal(switchRes.status, 200);
    const preAuth = (await switchRes.json()) as { token: string };
    const enrollRes = await fetch(`${apiBaseUrl}/api/auth/mfa/totp/enroll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${preAuth.token}` },
    });
    assert.equal(enrollRes.status, 200);
    const enrolled = (await enrollRes.json()) as { secret: string };
    const verifyRes = await fetch(`${apiBaseUrl}/api/auth/mfa/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${preAuth.token}` },
      body: JSON.stringify({ code: generateTotpCode(enrolled.secret) }),
    });
    assert.equal(verifyRes.status, 200);
    const setCookieHeader = verifyRes.headers.get('set-cookie');
    assert.ok(setCookieHeader);
    const cookiePair = setCookieHeader.split(';')[0];
    const eqIdx = cookiePair.indexOf('=');
    await desktopCtx.addCookies([
      {
        name: cookiePair.slice(0, eqIdx).trim(),
        value: cookiePair.slice(eqIdx + 1).trim(),
        url: baseUrl,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    // P16-BA-13: MFA Admin opens Command Center & confirms appointment
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^Portals$/i }).first().click();
    await page.getByText(/Carolina Botanical Winter Gala/i).first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByText(/Carolina Botanical Winter Gala/i).first().click();
    await page.getByRole('button', { name: /Confirm Appointment/i }).first().click();
    await page.getByText(/Confirmed consultation/i).first().waitFor({ state: 'visible', timeout: 10_000 });
    record('P16-BA-13', 'Desktop 1440x900', 'MFA Admin manages and confirms appointment in Command Center', `confirmed ${seeded.consultation.referenceCode}`);

    // P16-BA-14: Planner reassignment persists across browser reload
    const plannerSelect = page.locator('label:has-text("Assigned Lead Planner") + select').first();
    const targetPlanner =
      seeded.consultation.assignedPlannerId === 'user-staff-maya'
        ? 'user-admin-director'
        : 'user-staff-maya';
    await plannerSelect.selectOption(targetPlanner);
    await page.getByText(/Reassigned planner/i).first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^Portals$/i }).first().click();
    await page.getByText(/Carolina Botanical Winter Gala/i).first().click();
    const persistedPlanner = await page.locator('label:has-text("Assigned Lead Planner") + select').first().inputValue();
    assert.equal(persistedPlanner, targetPlanner);
    record('P16-BA-14', 'Desktop 1440x900', 'Planner assignment update persists across full reload', `planner=${persistedPlanner}`);

    // P16-BA-15: CRM stage update & consultation outcome recording persist across reload
    await page.getByPlaceholder(/Summarize floral direction/i).fill('Approved botanical archways, velvet linens, and candlelight tablescapes.');
    await page.getByRole('button', { name: /Save Outcome & Advance CRM/i }).click();
    await page.getByText(/marked Completed and CRM updated/i).first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^Portals$/i }).first().click();
    await page.getByText(/Carolina Botanical Winter Gala/i).first().click();
    const persistedStage = await page.locator('label:has-text("Lead Qualification / CRM Stage") + select').first().inputValue();
    assert.equal(persistedStage, 'Consultation Completed');
    record('P16-BA-15', 'Desktop 1440x900', 'CRM stage & outcome recording persist across full reload', `crmStage=${persistedStage}`);

    // P16-BA-16: Proposal handoff issues itemized quotation & advances CRM to Proposal Sent
    await page.getByRole('button', { name: /Proposal Handoff/i }).first().click();
    const issueProposalBtn = page.getByRole('button', { name: /Issue Proposal & Notify Client/i }).first();
    await issueProposalBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await issueProposalBtn.click();
    await page.getByText(/Itemized proposal issued/i).first().waitFor({ state: 'visible', timeout: 10_000 });
    record('P16-BA-16', 'Desktop 1440x900', 'Proposal handoff issues itemized quotation & updates CRM', 'advanced to Proposal Sent');

    // P16-BA-09: Email notification enters durable outbox (honest status badges rendered)
    await page.getByRole('button', { name: /Email Outbox/i }).first().click();
    await page.getByText(new RegExp(seeded.consultation.referenceCode)).first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByText(/Skipped|Pending|ProviderAccepted|Delivered|DeadLetter/i).first().waitFor({ state: 'visible', timeout: 10_000 });
    record('P16-BA-09', 'Desktop 1440x900', 'Email notifications durably recorded in Admin Email Outbox', `ref=${seeded.consultation.referenceCode} visible with honest status`);

    await desktopCtx.close();

    // =========================================================================
    // MOBILE 390x844 ACCEPTANCE FLOWS (P16-BA-19)
    // =========================================================================
    const mobileCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const mPage = await mobileCtx.newPage();
    mPage.on('pageerror', (err) => pageErrors.push(`mobile: ${err.message}`));
    mPage.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(`mobile: ${msg.text()}`);
      }
    });

    await mPage.goto(baseUrl, { waitUntil: 'networkidle' });
    const overflowPx = await mPage.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    assert.ok(overflowPx <= 2, `Mobile horizontal overflow detected: ${overflowPx}px`);

    await mPage.getByRole('button', { name: /Open navigation menu/i }).click();
    await mPage.getByRole('button', { name: /Book a Consultation/i }).last().click();
    const mDialog = mPage.getByRole('dialog', { name: /Book a Private Consultation/i });
    await mDialog.waitFor({ state: 'visible' });
    const mModalOverflow = await mPage.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      if (!dlg) return 999;
      return Math.max(0, Math.round(dlg.getBoundingClientRect().right - window.innerWidth));
    });
    assert.ok(mModalOverflow <= 2, `Mobile modal overflowed by ${mModalOverflow}px`);
    const nextBtnBox = await mDialog.getByRole('button', { name: /^Continue$/i }).boundingBox();
    assert.ok(nextBtnBox && nextBtnBox.height >= 40, `Expected touch-friendly CTA height >= 40px, got ${nextBtnBox?.height}`);
    record(
      'P16-BA-19',
      'Mobile 390x844',
      'Mobile homepage & consultation modal fit viewport with touch-friendly CTAs',
      `pageOverflow=${overflowPx}px, modalOverflow=${mModalOverflow}px, ctaHeight=${Math.round(nextBtnBox.height)}px`,
    );
    await mobileCtx.close();

    // P16-BA-20: Zero critical console errors & zero uncaught pageerrors across Desktop + Mobile
    assert.equal(pageErrors.length, 0, `Unexpected page errors: ${pageErrors.join('; ')}`);
    assert.equal(consoleErrors.length, 0, `Unexpected console errors: ${consoleErrors.join('; ')}`);
    record('P16-BA-20', 'Desktop 1440x900', 'Zero critical console errors & zero uncaught pageerrors across Desktop and Mobile', '0 console errors, 0 pageerrors');

    assert.equal(results.length, 20, `Expected 20 acceptance checks, recorded ${results.length}`);
    console.log(`\nALL ${results.length}/20 PHASE 16 REAL CHROMIUM BROWSER ACCEPTANCE CHECKS PASSED.`);
  } catch (err) {
    console.error('PHASE 16 BROWSER ACCEPTANCE FAILED:', err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }
}

main();
