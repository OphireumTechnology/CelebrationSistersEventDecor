import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.ts';

async function startIsolatedServer() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-ai-test-'));
  process.env.CS_DB_PATH = path.join(tmpDir, 'db.json');
  const app = createApp({ enableRateLimit: false });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  return {
    baseUrl,
    cleanup: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(tmpDir, { recursive: true, force: true });
      delete process.env.CS_DB_PATH;
    },
  };
}

test('protects AI Concept Studio records and enforces server-side dual approval persistence', async () => {
  const { baseUrl, cleanup } = await startIsolatedServer();
  try {
    // Unauthenticated guest cannot read saved concepts
    const unauthRes = await fetch(`${baseUrl}/api/concepts`);
    assert.equal(unauthRes.status, 401);

    // Client B (Elena) cannot approve Client A (Camille) concept cnc-101
    const elenaSwitch = await fetch(`${baseUrl}/api/auth/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-client-elena' }),
    });
    const { token: elenaToken } = (await elenaSwitch.json()) as { token: string };

    const crossApprove = await fetch(`${baseUrl}/api/concepts/cnc-101/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${elenaToken}` },
    });
    assert.equal(crossApprove.status, 403);

    // Client A (Camille) can approve her own concept cnc-101 and it persists
    const camilleSwitch = await fetch(`${baseUrl}/api/auth/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-client-camille' }),
    });
    const { token: camilleToken } = (await camilleSwitch.json()) as { token: string };

    const approveRes = await fetch(`${baseUrl}/api/concepts/cnc-101/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${camilleToken}` },
    });
    assert.equal(approveRes.status, 200);
    const approvedData = (await approveRes.json()) as {
      concept: { clientApproved: boolean; staffApproved: boolean; isConceptualVisualization: boolean };
    };
    assert.equal(approvedData.concept.clientApproved, true);
    assert.equal(approvedData.concept.staffApproved, true);
    assert.equal(approvedData.concept.isConceptualVisualization, true);
  } finally {
    await cleanup();
  }
});

test('propagates explicit error when GEMINI_API_KEY is absent instead of masking with mock output', async () => {
  const { baseUrl, cleanup } = await startIsolatedServer();
  const savedKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const res = await fetch(`${baseUrl}/api/ai/concierge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Planning a wedding for 150 guests' }),
    });
    assert.equal(res.status, 502);
    const data = (await res.json()) as { error: string };
    assert.match(data.error, /GEMINI_API_KEY/i);
  } finally {
    if (savedKey !== undefined) {
      process.env.GEMINI_API_KEY = savedKey;
    }
    await cleanup();
  }
});
