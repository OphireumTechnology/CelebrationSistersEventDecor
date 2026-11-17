import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { apiFetch, resolveApiEnvironment, sanitizeApiBaseUrl } from '../src/lib/apiClient.ts';
import { createApp } from '../server/app.ts';

test('sanitizeApiBaseUrl enforces HTTPS origins or localhost HTTP and strips trailing slashes', () => {
  assert.equal(sanitizeApiBaseUrl('https://api.celebrationsisters.com/'), 'https://api.celebrationsisters.com');
  assert.equal(sanitizeApiBaseUrl('https://api.celebrationsisters.com/v1/'), 'https://api.celebrationsisters.com/v1');
  assert.equal(sanitizeApiBaseUrl('http://localhost:3000/'), 'http://localhost:3000');
  assert.equal(sanitizeApiBaseUrl('http://insecure.example.com'), '');
  assert.equal(sanitizeApiBaseUrl('javascript:alert(1)'), '');
});

test('apiFetch returns graceful 503 BACKEND_NOT_CONFIGURED on static GitHub Pages without VITE_API_BASE_URL', async () => {
  const resolved = resolveApiEnvironment({
    baseUrl: '/CelebrationSistersEventDecor/',
    apiBaseUrl: '',
  });
  assert.equal(resolved.onStaticPages, true);
  assert.equal(resolved.backendConfigured, false);

  const response = await apiFetch('/api/health', undefined, {
    baseUrl: '/CelebrationSistersEventDecor/',
    apiBaseUrl: '',
  });
  assert.equal(response.status, 503);
  const body = (await response.json()) as { code?: string; error?: string };
  assert.equal(body.code, 'BACKEND_NOT_CONFIGURED');
  assert.ok(body.error && body.error.length > 10);
});

test('apiFetch rejects non-/api/ paths', () => {
  assert.throws(() => apiFetch('https://evil.example.com/steal'), /must begin with \/api\//);
});

test('GET /api/health reports readiness, AI configuration status, and non-production fallback safely', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-health-test-'));
  const prevDbPath = process.env.CS_DB_PATH;
  process.env.CS_DB_PATH = path.join(tempDir, 'db.json');

  const app = createApp({ enableRateLimit: false });
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      ok: boolean;
      service: string;
      persistence: { ready: boolean; adapter: string };
      ai: { model: string; configured: boolean };
    };
    assert.equal(json.ok, true);
    assert.equal(json.persistence.ready, true);
    assert.equal(json.persistence.adapter, 'json-local');
    assert.equal(json.ai.model, 'gemini-4-hydrogen');
  } finally {
    server.close();
    if (prevDbPath === undefined) delete process.env.CS_DB_PATH;
    else process.env.CS_DB_PATH = prevDbPath;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
