import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runJsonToPostgresMigrationAudit } from '../scripts/migrate-json-to-postgres.ts';
import { getPersistenceStatus } from '../server/repositories/postgresRepository.ts';
import { readDb } from '../server/store.ts';

test('migration dry-run validates referential integrity and reconciles lifecycle states', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-mig-test-'));
  const tmpDb = path.join(tmpDir, 'db.json');
  process.env.CS_DB_PATH = tmpDb;
  try {
    await readDb(); // Ensure clean seed exists in temp file
    const report = await runJsonToPostgresMigrationAudit({
      sourcePath: tmpDb,
      backupDir: path.join(tmpDir, 'backups'),
      createBackup: true,
      dryRun: true,
    });

    assert.equal(report.mode, 'dry-run');
    assert.equal(report.integrityChecks.passed, true);
    assert.equal(report.integrityChecks.errors.length, 0);
    assert.ok(report.recordCounts.bookings >= 3);
    assert.ok(report.recordCounts.users >= 5);
    assert.ok(report.lifecycleReconciliation.length >= 3);

    await assert.rejects(
      () => runJsonToPostgresMigrationAudit({ sourcePath: tmpDb, dryRun: false }),
      /LIVE_MIGRATION_BLOCKED/,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    delete process.env.CS_DB_PATH;
  }
});

test('production persistence readiness fails safely when DATABASE_URL is absent', () => {
  const prevEnv = process.env.NODE_ENV;
  const prevUrl = process.env.DATABASE_URL;
  const prevAdapter = process.env.PERSISTENCE_ADAPTER;

  try {
    process.env.NODE_ENV = 'production';
    delete process.env.DATABASE_URL;
    delete process.env.PERSISTENCE_ADAPTER;

    const prodNoDb = getPersistenceStatus();
    assert.equal(prodNoDb.ready, false);
    assert.equal(prodNoDb.adapter, 'postgres');

    process.env.PERSISTENCE_ADAPTER = 'json-local';
    const prodJsonAttempt = getPersistenceStatus();
    assert.equal(prodJsonAttempt.ready, false);
  } finally {
    if (prevEnv !== undefined) process.env.NODE_ENV = prevEnv;
    else delete process.env.NODE_ENV;
    if (prevUrl !== undefined) process.env.DATABASE_URL = prevUrl;
    else delete process.env.DATABASE_URL;
    if (prevAdapter !== undefined) process.env.PERSISTENCE_ADAPTER = prevAdapter;
    else delete process.env.PERSISTENCE_ADAPTER;
  }
});
