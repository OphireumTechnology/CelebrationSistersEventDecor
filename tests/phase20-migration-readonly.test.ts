import assert from 'node:assert/strict';
import test from 'node:test';
import { runMigrationsOnClient, loadMigrationFiles } from '../scripts/run-migrations.ts';

const files = await loadMigrationFiles();

test('connected migration dry-run on fresh PostgreSQL performs SELECT only', async () => {
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (/to_regclass/i.test(sql)) return { rows: [{ migrations_table: null }] };
      throw new Error('Unexpected query in fresh-db dry-run');
    },
  };
  const result = await runMigrationsOnClient(client as never, { dryRun: true });
  assert.equal(result.applied.length, 0);
  assert.equal(result.pending.length, files.length);
  assert.equal(result.skipped.length, 0);
  assert.equal(queries.length, 1);
  assert.ok(queries.every((sql) => /^\\s*SELECT\\b/i.test(sql)));
});

test('connected migration dry-run reports matching checksums without writes', async () => {
  const queries: string[] = [];
  const first = files[0];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (/to_regclass/i.test(sql)) return { rows: [{ migrations_table: 'schema_migrations' }] };
      if (/FROM public.schema_migrations/i.test(sql)) {
        return { rows: [{ version: first.version, checksum_sha256: first.checksumSha256 }] };
      }
      throw new Error('Unexpected SQL');
    },
  };
  const result = await runMigrationsOnClient(client as never, { dryRun: true });
  assert.deepEqual(result.skipped, [first.filename]);
  assert.equal(result.pending.length, files.length - 1);
  assert.ok(queries.every((sql) => /^\\s*SELECT\\b/i.test(sql)));
});

test('connected migration dry-run fails closed on checksum drift', async () => {
  const client = {
    async query(sql: string) {
      if (/to_regclass/i.test(sql)) return { rows: [{ migrations_table: 'schema_migrations' }] };
      return { rows: [{ version: files[0].version, checksum_sha256: 'wrong-checksum' }] };
    },
  };
  await assert.rejects(
    () => runMigrationsOnClient(client as never, { dryRun: true }),
    /MIGRATION_CHECKSUM_MISMATCH/,
  );
});
