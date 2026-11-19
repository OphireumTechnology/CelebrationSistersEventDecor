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
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-15r-browser-'));
  const dbPath = path.join(tmpDir, 'browser-acceptance-db.json');
  const screenshotDir = '/tmp/phase15r-screenshots';
  await fs.mkdir(screenshotDir, { recursive: true });

  process.env.CS_DB_PATH = dbPath;
  process.env.PERSISTENCE_ADAPTER = 'json-local';
  process.env.ALLOW_DEMO_AUTH = 'true';
  process.env.EMAIL_LIVE_DELIVERY_ENABLED = 'false';

  // Mount real Express API + compiled production frontend bundle (`dist/`)
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
    // DESKTOP 1440x900 ACCEPTANCE FLOWS
    // =========================================================================
    const desktopCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await desktopCtx.newPage();

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        // Ignore expected HTTP status logs from intentional negative test scenarios (wrong token 403, simulated 503)
        if (!/Failed to load resource: the server responded with a status of (403|503)/.test(text)) {
          consoleErrors.push(text);
        }
      }
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // BA-01: Public website loads with official branding and zero console errors
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    const title = await page.title();
    assert.match(title, /Celebration Sisters/i);
    const brandVisible = await page.getByText(/Celebration Sisters/i).first().isVisible();
    assert.equal(brandVisible, true);
    await page.screenshot({ path: path.join(screenshotDir, '01-desktop-home.png') });
    record('BA-01', 'Desktop 1440x900', 'Public website loads with official branding', `title="${title}"`);

    // BA-02: Open Consultation modal & verify initial keyboard focus lands inside modal
    const bookTrigger = page.getByRole('button', { name: /Book a Consultation/i }).first();
    await bookTrigger.click();
    const dialog = page.getByRole('dialog', { name: /Book a Private Consultation/i });
    await dialog.waitFor({ state: 'visible' });

    const focusInsideModal = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      return Boolean(dlg && document.activeElement && dlg.contains(document.activeElement));
    });
    assert.equal(focusInsideModal, true, 'Initial keyboard focus must enter modal');
    record('BA-02', 'Desktop 1440x900', 'Modal opens with accessible focus management', 'activeElement inside [role="dialog"]');

    // BA-03: Escape closes modal cleanly & re-opening works
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await bookTrigger.click();
    await dialog.waitFor({ state: 'visible' });
    record('BA-03', 'Desktop 1440x900', 'Escape closes modal cleanly & re-opening works', 'closed via Escape and re-opened');

    // BA-04: Step 1 validation rejects empty target event date, then accepts valid input incl. Event Theme
    const eventDateInput = dialog.locator('input[type="date"]').first();
    await eventDateInput.fill('');
    const continueBtn = dialog.getByRole('button', { name: /^Continue$/i });
    await continueBtn.click();
    await dialog.getByText(/Please choose your target event date/i).waitFor({ state: 'visible' });
    record('BA-04', 'Desktop 1440x900', 'Step 1 validation rejects empty target event date', 'inline validation alert displayed');

    await eventDateInput.fill(futureIsoDate(75));
    await dialog.getByPlaceholder(/Autumn Estate Wedding Reception/i).fill('Royal Autumn Candlelight Gala');
    await dialog.getByPlaceholder(/Candlelit Royal Amethyst/i).fill('Candlelit Royal Amethyst & Champagne Gold');
    await dialog.getByPlaceholder(/Lace House Gardens/i).fill('Lace House Gardens');
    await continueBtn.click();

    // BA-05: Step 2 live availability slots display & time selection works
    const firstAvailableSlotBtn = dialog.locator('button:not([disabled])').filter({ hasText: /AM|PM/ }).first();
    await firstAvailableSlotBtn.waitFor({ state: 'visible', timeout: 10_000 });
    const slotLabel = (await firstAvailableSlotBtn.innerText()).trim().replace(/\s+/g, ' ');
    await firstAvailableSlotBtn.click();
    await page.screenshot({ path: path.join(screenshotDir, '02-desktop-step2-slots.png') });
    record('BA-05', 'Desktop 1440x900', 'Step 2 renders live availability slots & selects time', `selected="${slotLabel}"`);

    await dialog.getByRole('button', { name: /^Continue$/i }).click();

    // BA-06: Step 3 client contact info & privacy consent advance to Step 4 review
    await dialog.getByPlaceholder(/Jordan & Camille Mercer/i).fill('Evelyn & Marcus Vance');
    await dialog.getByPlaceholder(/you@domain\.com/i).fill('evelyn.vance@example.com');
    await dialog.getByPlaceholder(/\(803\) 555-0148/i).fill('(803) 555-0188');
    await dialog.locator('input[type="checkbox"]').check();
    await dialog.getByRole('button', { name: /Review Consultation/i }).click();
    record('BA-06', 'Desktop 1440x900', 'Step 3 client contact info & privacy consent advance to review', 'reached Step 4 review');

    // BA-07: Simulated 503 backend failure -> actionable error & zero false confirmation
    let intercepted503 = false;
    await page.route('**/api/consultations', async (route) => {
      if (route.request().method() === 'POST' && !intercepted503) {
        intercepted503 = true;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Primary database temporarily unavailable. Please retry shortly.',
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
    const falseConfirmCount = await dialog.getByText(/Your Private Consultation Is Reserved/i).count();
    assert.equal(falseConfirmCount, 0, '503 failure must NEVER display confirmation screen');
    record('BA-07', 'Desktop 1440x900', 'Simulated 503 error shows actionable alert & zero false confirmation', 'HTTP 503 intercepted cleanly');

    // BA-08: Retry submission -> real booking persisted & renders referenceCode + accessToken
    await confirmBookingBtn.click();
    await dialog.getByText(/Your Private Consultation Is Reserved/i).waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.getByText(/Private Reschedule & Status Verification Token/i).waitFor({ state: 'visible' });
    const modalText = await dialog.innerText();
    const refMatch = modalText.match(/CS-\d{4}-\d{4}/);
    const tokenMatch = modalText.match(/csa_[A-Za-z0-9_-]{20,}/);
    assert.ok(refMatch, 'Expected persisted booking reference code in confirmation UI');
    assert.ok(tokenMatch, 'Expected private verification token in confirmation UI');
    const referenceCode = refMatch[0];
    const accessToken = tokenMatch[0];
    await page.screenshot({ path: path.join(screenshotDir, '03-desktop-confirmation.png') });
    record('BA-08', 'Desktop 1440x900', 'Booking confirmation renders persisted referenceCode & csa_ token', `ref=${referenceCode}`);

    // BA-09: Manage / Track portal rejects wrong token cleanly
    await dialog.getByRole('button', { name: /Manage \/ Reschedule Appointment/i }).click();
    await dialog.getByPlaceholder('CS-2026-0068').fill(referenceCode);
    await dialog.getByPlaceholder('csa_...').fill('csa_wrong_token_probe_123456');
    await dialog.getByRole('button', { name: /Verify & Open Appointment/i }).click();
    await dialog.getByText(/not found|invalid|revoked/i).waitFor({ state: 'visible' });
    record('BA-09', 'Desktop 1440x900', 'Manage portal rejects wrong verification token cleanly', '403 error rendered');

    // BA-10: Manage / Track portal opens verified appointment & displays Event Theme
    await dialog.getByPlaceholder('csa_...').fill(accessToken);
    await dialog.getByRole('button', { name: /Verify & Open Appointment/i }).click();
    await dialog.getByText(/Royal Autumn Candlelight Gala/i).waitFor({ state: 'visible' });
    await dialog.getByText(/Candlelit Royal Amethyst & Champagne Gold/i).waitFor({ state: 'visible' });
    record('BA-10', 'Desktop 1440x900', 'Manage portal opens verified appointment & displays Event Theme', `opened ${referenceCode}`);

    // BA-11: Online reschedule works inside Manage portal
    await dialog.getByRole('button', { name: /Reschedule Consultation/i }).click();
    const rescheduleSlotBtn = dialog.locator('button:not([disabled])').filter({ hasText: /AM|PM/ }).first();
    await rescheduleSlotBtn.waitFor({ state: 'visible', timeout: 10_000 });
    const newSlotLabel = (await rescheduleSlotBtn.innerText()).trim().replace(/\s+/g, ' ');
    await rescheduleSlotBtn.click();
    await dialog.getByRole('button', { name: /Confirm Reschedule/i }).click();
    await dialog.getByText(/Rescheduled/i).first().waitFor({ state: 'visible', timeout: 10_000 });
    record('BA-11', 'Desktop 1440x900', 'Client online reschedule updates appointment cleanly', `rescheduled to "${newSlotLabel}"`);

    // BA-12: Online cancellation cancels appointment & releases slot
    await dialog.getByRole('button', { name: /Cancel Appointment/i }).click();
    await dialog.getByPlaceholder(/Optional reason/i).fill('Moving celebration to spring');
    await dialog.getByRole('button', { name: /Yes, Cancel & Release Slot/i }).click();
    await dialog.getByText(/Cancelled/i).first().waitFor({ state: 'visible', timeout: 10_000 });
    record('BA-12', 'Desktop 1440x900', 'Client online cancellation cancels appointment & releases slot', 'status updated to Cancelled');

    await dialog.getByRole('button', { name: /Close modal/i }).click();
    await dialog.waitFor({ state: 'hidden' });

    // Seed one active consultation for Admin Command Center verification
    const availRes = await fetch(
      `${baseUrl}/api/consultations/availability?startDate=${futureIsoDate(4)}&days=14&timezone=America/New_York&method=video`,
    );
    const availData = (await availRes.json()) as {
      days: Array<{ slots: Array<{ startUtc: string; plannerId: string; available: boolean }> }>;
    };
    const adminTestSlot = availData.days.flatMap((d) => d.slots).find((s) => s.available);
    assert.ok(adminTestSlot, 'Expected available slot for admin workflow test');
    const createForAdminRes = await fetch(`${baseUrl}/api/consultations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName: 'Sloane Harrington',
        clientEmail: 'sloane@example.com',
        clientPhone: '(803) 555-0177',
        preferredContactMethod: 'email',
        eventType: 'Corporate Gala',
        eventTitle: 'Midlands Symphony Annual Gala',
        eventTheme: 'Velvet Noir & Brushed Gold',
        serviceDivisionIds: ['div-event-decor'],
        eventDate: futureIsoDate(90),
        venueName: 'Columbia Museum of Art',
        location: 'Columbia, SC',
        guestCount: 220,
        budgetRange: '$50,000 - $100,000',
        consultationMethod: 'video',
        consultationStartUtc: adminTestSlot.startUtc,
        plannerId: adminTestSlot.plannerId,
        clientTimezone: 'America/New_York',
        privacyConsentAccepted: true,
      }),
    });
    assert.equal(createForAdminRes.status, 201);
    const adminBooking = (await createForAdminRes.json()) as {
      consultation: { id: string; referenceCode: string };
    };

    // BA-13: Admin MFA Sign-In -> Portals -> Consultation Command Center loads live booking
    const switchRes = await fetch(`${baseUrl}/api/auth/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ userId: 'user-admin-director' }),
    });
    assert.equal(switchRes.status, 200);
    const preAuth = (await switchRes.json()) as { token: string };
    const enrollRes = await fetch(`${baseUrl}/api/auth/mfa/totp/enroll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${preAuth.token}` },
    });
    assert.equal(enrollRes.status, 200);
    const enrolled = (await enrollRes.json()) as { secret: string };
    const totpCode = generateTotpCode(enrolled.secret);
    const verifyRes = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${preAuth.token}` },
      body: JSON.stringify({ code: totpCode }),
    });
    assert.equal(verifyRes.status, 200);
    const setCookieHeader = verifyRes.headers.get('set-cookie');
    assert.ok(setCookieHeader, 'Expected HttpOnly session cookie from MFA verify');
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

    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^Portals$/i }).first().click();
    await page.getByText(/Midlands Symphony Annual Gala/i).first().waitFor({ state: 'visible', timeout: 10_000 });
    record('BA-13', 'Desktop 1440x900', 'MFA Admin opens Consultation Command Center & sees live booking', `visible=${adminBooking.consultation.referenceCode}`);

    // BA-14: Admin confirms consultation inside Command Center
    await page.getByText(/Midlands Symphony Annual Gala/i).first().click();
    const confirmAdminBtn = page.getByRole('button', { name: /Confirm Appointment/i }).first();
    await confirmAdminBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await confirmAdminBtn.click();
    await page.getByText(/Confirmed consultation/i).first().waitFor({ state: 'visible', timeout: 10_000 });
    record('BA-14', 'Desktop 1440x900', 'Admin confirms consultation inside Command Center', 'status updated to Confirmed');

    // BA-15: Admin Email Outbox tab renders honest delivery states
    const emailOutboxTab = page.getByRole('button', { name: /Email Outbox/i }).first();
    await emailOutboxTab.click();
    await page.getByText(/Skipped|Pending|ProviderAccepted|Delivered|DeadLetter/i).first().waitFor({
      state: 'visible',
      timeout: 10_000,
    });
    await page.screenshot({ path: path.join(screenshotDir, '04-desktop-admin-outbox.png') });
    record('BA-15', 'Desktop 1440x900', 'Admin Email Outbox tab renders honest delivery states', 'outbox status badges visible');

    // BA-16: Zero unhandled console errors or pageerrors across desktop flows
    assert.equal(pageErrors.length, 0, `Unexpected desktop page errors: ${pageErrors.join('; ')}`);
    assert.equal(consoleErrors.length, 0, `Unexpected desktop console errors: ${consoleErrors.join('; ')}`);
    record('BA-16', 'Desktop 1440x900', 'Zero unhandled console errors or pageerrors across desktop flows', '0 console errors, 0 pageerrors');
    await desktopCtx.close();

    // =========================================================================
    // MOBILE 390x844 ACCEPTANCE FLOWS
    // =========================================================================
    const mobileCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const mPage = await mobileCtx.newPage();
    const mobileErrors: string[] = [];
    mPage.on('pageerror', (err) => mobileErrors.push(err.message));

    await mPage.goto(baseUrl, { waitUntil: 'networkidle' });
    const overflowPx = await mPage.evaluate(() => {
      return document.documentElement.scrollWidth - document.documentElement.clientWidth;
    });
    assert.ok(overflowPx <= 2, `Mobile horizontal overflow detected: ${overflowPx}px`);
    record('BA-17', 'Mobile 390x844', 'Mobile viewport renders with zero horizontal overflow', `overflow=${overflowPx}px`);

    // Open mobile navigation menu and tap Book a Consultation
    await mPage.getByRole('button', { name: /Open navigation menu/i }).click();
    await mPage.getByRole('button', { name: /Book a Consultation/i }).last().click();
    const mDialog = mPage.getByRole('dialog', { name: /Book a Private Consultation/i });
    await mDialog.waitFor({ state: 'visible' });
    const mModalOverflow = await mPage.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      if (!dlg) return 999;
      const rect = dlg.getBoundingClientRect();
      return Math.max(0, Math.round(rect.right - window.innerWidth));
    });
    assert.ok(mModalOverflow <= 2, `Mobile consultation modal overflowed viewport by ${mModalOverflow}px`);
    const nextBtnBox = await mDialog.getByRole('button', { name: /^Continue$/i }).boundingBox();
    assert.ok(nextBtnBox && nextBtnBox.height >= 40, `Expected touch-friendly CTA height, got ${nextBtnBox?.height}`);
    await mPage.screenshot({ path: path.join(screenshotDir, '05-mobile-modal.png') });
    assert.equal(mobileErrors.length, 0, `Unexpected mobile page errors: ${mobileErrors.join('; ')}`);
    record(
      'BA-18',
      'Mobile 390x844',
      'Mobile consultation modal fits viewport with touch-friendly CTA & 0 pageerrors',
      `modalOverflow=${mModalOverflow}px, ctaHeight=${Math.round(nextBtnBox.height)}px`,
    );
    await mobileCtx.close();

    console.log(`\nALL ${results.length}/18 REAL CHROMIUM BROWSER ACCEPTANCE CHECKS PASSED.`);
    console.log(JSON.stringify({ passed: results.length, total: results.length, checks: results }, null, 2));
  } catch (err) {
    console.error('BROWSER ACCEPTANCE FAILED:', err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main();
