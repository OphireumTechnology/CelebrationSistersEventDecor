import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { verifyResendWebhookSignature } from '../server/notifications.ts';
import { withTransaction } from '../server/store.ts';
import {
  apiFetch,
  isStaticPagesHostname,
  resolveApiEnvironment,
} from '../src/lib/apiClient.ts';

function futureIsoDate(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

describe('Phase 17 — Live Availability Routing Repair, Zero-404 Production Auth & Resilience Regressions', () => {
  let tmpDir: string;
  let server: Server;
  let baseUrl: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-phase17-'));
    process.env.CS_DB_PATH = path.join(tmpDir, 'phase17-db.json');
    process.env.PERSISTENCE_ADAPTER = 'json-local';
    process.env.ALLOW_DEMO_AUTH = 'true';
    process.env.EMAIL_LIVE_DELIVERY_ENABLED = 'false';
    process.env.SUPPRESS_STRUCTURED_LOGS = 'true';

    const app = createApp({ enableRateLimit: false });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    delete process.env.SUPPRESS_STRUCTURED_LOGS;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('detects custom apex GitHub Pages domain (celebrationsistersdecor.com) as static host when VITE_API_BASE_URL is empty', async () => {
    assert.equal(isStaticPagesHostname('celebrationsistersdecor.com'), true);
    assert.equal(isStaticPagesHostname('www.celebrationsistersdecor.com'), true);
    assert.equal(isStaticPagesHostname('ophireumtechnology.github.io'), true);
    assert.equal(isStaticPagesHostname('localhost'), false);

    // Build-time flag detection (GITHUB_PAGES=true + custom domain base='/')
    const byBuildFlag = resolveApiEnvironment({
      baseUrl: '/',
      apiBaseUrl: '',
      staticPagesBuild: true,
      hostname: 'celebrationsistersdecor.com',
    });
    assert.equal(byBuildFlag.onStaticPages, true);
    assert.equal(byBuildFlag.backendConfigured, false);

    // Runtime hostname detection even if build flag absent
    const byHostname = resolveApiEnvironment({
      baseUrl: '/',
      apiBaseUrl: '',
      staticPagesBuild: false,
      hostname: 'celebrationsistersdecor.com',
    });
    assert.equal(byHostname.onStaticPages, true);
    assert.equal(byHostname.backendConfigured, false);

    // Must return clean JSON 503 BACKEND_NOT_CONFIGURED instead of issuing HTML 404 to GitHub Pages
    const res = await apiFetch('/api/consultations/availability?days=14', undefined, {
      baseUrl: '/',
      apiBaseUrl: '',
      staticPagesBuild: true,
      hostname: 'celebrationsistersdecor.com',
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { code?: string; error?: string };
    assert.equal(body.code, 'BACKEND_NOT_CONFIGURED');
    assert.ok(body.error && body.error.length > 15);
  });

  it('enables cross-origin Railway API calls when VITE_API_BASE_URL is configured on celebrationsistersdecor.com', async () => {
    const resolved = resolveApiEnvironment({
      baseUrl: '/',
      apiBaseUrl: 'https://celebrationsisters-api.up.railway.app/',
      staticPagesBuild: true,
      hostname: 'celebrationsistersdecor.com',
    });
    assert.equal(resolved.onStaticPages, true);
    assert.equal(resolved.backendConfigured, true);
    assert.equal(resolved.configuredApiBase, 'https://celebrationsisters-api.up.railway.app');

    // Full-stack localhost / Railway container mode continues to work with relative /api/*
    const localResolved = resolveApiEnvironment({
      baseUrl: '/',
      apiBaseUrl: '',
      staticPagesBuild: false,
      hostname: 'localhost',
    });
    assert.equal(localResolved.onStaticPages, false);
    assert.equal(localResolved.backendConfigured, true);
  });

  it('advertises demoPersonasAvailable accurately on /api/auth/config across non-production and production modes', async () => {
    const prevEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'development';
      const devConfig = (await (await fetch(`${baseUrl}/api/auth/config`)).json()) as {
        demoPersonasAvailable?: boolean;
      };
      assert.equal(devConfig.demoPersonasAvailable, true);

      process.env.NODE_ENV = 'production';
      const prodConfig = (await (await fetch(`${baseUrl}/api/auth/config`)).json()) as {
        demoPersonasAvailable?: boolean;
      };
      assert.equal(prodConfig.demoPersonasAvailable, false);

      // Direct call to /api/auth/personas in production remains fail-closed 404
      const prodPersonas = await fetch(`${baseUrl}/api/auth/personas`);
      assert.equal(prodPersonas.status, 404);
    } finally {
      if (prevEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv;
    }
  });

  it('rejects expired and revoked consultation tokens fail-closed (HTTP 403) on status and reschedule', async () => {
    const availRes = await fetch(
      `${baseUrl}/api/consultations/availability?startDate=${futureIsoDate(7)}&days=10&timezone=America/New_York&method=video`,
    );
    assert.equal(availRes.status, 200);
    const availJson = (await availRes.json()) as {
      days: Array<{ slots: Array<{ startUtc: string; plannerId: string; available: boolean }> }>;
    };
    const openSlots = availJson.days.flatMap((d) => d.slots).filter((s) => s.available);
    assert.ok(openSlots.length >= 2);

    const createRes = await fetch(`${baseUrl}/api/consultations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName: 'Token Lifecycle Client',
        clientEmail: 'token.lifecycle@example.com',
        clientPhone: '(803) 555-0133',
        preferredContactMethod: 'email',
        eventType: 'Luxury Wedding',
        eventTitle: 'Token Expiry Verification Gala',
        serviceDivisionIds: ['div-event-decor'],
        eventDate: futureIsoDate(110),
        venueName: 'Columbia Estate',
        location: 'Columbia, SC',
        guestCount: 140,
        budgetRange: '$25,000 - $50,000',
        consultationMethod: 'video',
        consultationStartUtc: openSlots[0].startUtc,
        plannerId: openSlots[0].plannerId,
        clientTimezone: 'America/New_York',
        privacyConsentAccepted: true,
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as {
      consultation: { id: string; referenceCode: string };
      accessToken: string;
    };

    // 1. Simulate token expiration -> status & reschedule must return 403
    await withTransaction((db) => {
      const rec = db.consultations.find((c) => c.id === created.consultation.id);
      assert.ok(rec);
      rec.accessTokenExpiresAt = new Date(Date.now() - 60_000).toISOString();
    });
    const expiredStatus = await fetch(
      `${baseUrl}/api/consultations/status?referenceCode=${encodeURIComponent(created.consultation.referenceCode)}`,
      { headers: { 'X-Consultation-Token': created.accessToken } },
    );
    assert.equal(expiredStatus.status, 403);

    const expiredReschedule = await fetch(
      `${baseUrl}/api/consultations/${created.consultation.id}/reschedule`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Consultation-Token': created.accessToken,
        },
        body: JSON.stringify({ newStartUtc: openSlots[1].startUtc, plannerId: openSlots[1].plannerId }),
      },
    );
    assert.equal(expiredReschedule.status, 403);

    // 2. Restore expiry and mark revoked -> must return 403
    await withTransaction((db) => {
      const rec = db.consultations.find((c) => c.id === created.consultation.id);
      assert.ok(rec);
      rec.accessTokenExpiresAt = new Date(Date.now() + 86_400_000).toISOString();
      rec.accessTokenRevokedAt = new Date().toISOString();
    });
    const revokedStatus = await fetch(
      `${baseUrl}/api/consultations/status?referenceCode=${encodeURIComponent(created.consultation.referenceCode)}`,
      { headers: { 'X-Consultation-Token': created.accessToken } },
    );
    assert.equal(revokedStatus.status, 403);
  });

  it('rejects expired Svix webhook signatures beyond the 300-second replay window', () => {
    const secret = `whsec_${Buffer.from('phase17-svix-replay-guard-secret').toString('base64')}`;
    const rawBody = JSON.stringify({ type: 'email.delivered', data: { email_id: 're_replay_probe' } });
    const nowSec = Math.floor(Date.now() / 1000);
    const staleTs = String(nowSec - 600); // 10 minutes old
    const svixId = 'msg_stale_replay_17';
    const keyBytes = Buffer.from(secret.slice('whsec_'.length), 'base64');
    const sig = crypto
      .createHmac('sha256', keyBytes)
      .update(`${svixId}.${staleTs}.${rawBody}`, 'utf8')
      .digest('base64');

    const check = verifyResendWebhookSignature({
      rawBody,
      svixId,
      svixTimestamp: staleTs,
      svixSignature: `v1,${sig}`,
      webhookSecret: secret,
      nowSeconds: nowSec,
    });
    assert.equal(check.valid, false);
    assert.match(check.reason || '', /replay tolerance/i);
  });
});
