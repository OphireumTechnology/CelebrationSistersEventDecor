import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  acquireConceptLease,
  assertConceptLeaseOwnership,
  releaseConceptLease,
  completeConceptLease,
  CONCEPT_LEASE_TTL_MS,
  type ConceptLeaseAcquisition,
} from '../server/repositories/conceptLeaseRepository.ts';

import {
  readDb,
  withClockedTransaction,
} from '../server/store.ts';

import {
  closePgPool,
} from '../server/repositories/postgresRepository.ts';

const url = new URL(process.env.DATABASE_URL || '');

assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.pathname, '/cs_cert');
assert.equal(url.username, 'cs_cert');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.PERSISTENCE_ADAPTER, 'postgres');
assert.equal(process.env.LIVE_EMAIL_SENDING_ENABLED, 'false');
assert.equal(process.env.LIVE_PAYMENTS_ENABLED, 'false');

const execute = promisify(execFile);
const filename = fileURLToPath(import.meta.url);

const hash = createHash('sha256').update('certification').digest('hex');
const otherHash = createHash('sha256').update('conflict').digest('hex');

const scope = () => `cert-${randomUUID()}`;

let passed = 0;

async function verify(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`PASS: ${name}`);
}

async function remoteAcquire(
  key: string,
  fingerprint = hash,
): Promise<ConceptLeaseAcquisition> {
  const result = await execute(
    process.execPath,
    ['--import', 'tsx', filename, '--worker', key, fingerprint],
    { env: process.env, timeout: 60000 },
  );

  const line = result.stdout
    .split('\n')
    .find((value) => value.startsWith('LEASE_RESULT:'));

  assert.ok(line);

  return JSON.parse(
    line.slice('LEASE_RESULT:'.length),
  ) as ConceptLeaseAcquisition;
}

async function main() {
  if (process.argv[2] === '--worker') {
    const result = await acquireConceptLease(
      process.argv[3], process.argv[4],
    );
    console.log('LEASE_RESULT:' + JSON.stringify(result));
    return;
  }

  await verify('PG-DI-01: eight processes elect one owner', async () => {
    const key = scope();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => remoteAcquire(key)),
    );

    const owners = results.filter(r => r.status === 'acquired');

    assert.equal(owners.length, 1);
    assert.equal(results.filter(r => r.status === 'busy').length, 7);

    const owner = owners[0];
    assert.equal(owner.status, 'acquired');
    assert.equal(await releaseConceptLease(owner.lease), true);
  });

  await verify('PG-DI-02: conflicting fingerprints rejected', async () => {
    const key = scope();
    const owner = await remoteAcquire(key);

    assert.equal(owner.status, 'acquired');

    assert.equal(
      (await remoteAcquire(key, otherHash)).status,
      'conflict',
    );

    assert.equal(await releaseConceptLease(owner.lease), true);
  });

  await verify('PG-DI-03: independent scopes remain isolated', async () => {
    const results = await Promise.all([
      remoteAcquire(scope()),
      remoteAcquire(scope()),
    ]);

    for (const result of results) {
      assert.equal(result.status, 'acquired');
      assert.equal(await releaseConceptLease(result.lease), true);
    }
  });

  await verify('PG-DI-04: database clock overrides app clock skew', async () => {
    const before = await withClockedTransaction(
      async (_db, clock) => clock(),
    );

    const originalNow = Date.now;
    let result: ConceptLeaseAcquisition;

    try {
      Date.now = () => originalNow() + 86400000;
      result = await acquireConceptLease(scope(), hash);
    } finally {
      Date.now = originalNow;
    }

    const after = await withClockedTransaction(
      async (_db, clock) => clock(),
    );

    assert.equal(result.status, 'acquired');

    assert.ok(result.lease.expiresAt >= before + CONCEPT_LEASE_TTL_MS);
    assert.ok(result.lease.expiresAt <= after + CONCEPT_LEASE_TTL_MS);

    assert.equal(await releaseConceptLease(result.lease), true);
  });

  await verify('PG-DI-05: expired owner cannot overwrite successor', async () => {
    const key = scope();
    const first = await remoteAcquire(key);

    assert.equal(first.status, 'acquired');

    await withClockedTransaction(async (db, clock) => {
      db.conceptGenerationLeases![first.lease.key].expiresAt =
        (await clock()) - 1;
    });

    const second = await remoteAcquire(key);
    assert.equal(second.status, 'acquired');

    assert.notEqual(first.lease.ownerToken, second.lease.ownerToken);

    await assert.rejects(
      withClockedTransaction(async (db, clock) => {
        assertConceptLeaseOwnership(
          db, first.lease, key, hash, await clock(),
        );
      }),
      /AI_CONCEPT_LEASE_LOST/,
    );

    assert.equal(await releaseConceptLease(first.lease), false);

    await withClockedTransaction(async (db, clock) => {
      assertConceptLeaseOwnership(
        db, second.lease, key, hash, await clock(),
      );
    });

    assert.equal(await releaseConceptLease(second.lease), true);
  });

  await verify('PG-DI-06: failed completion rolls back transaction', async () => {
    const key = scope();
    const owner = await remoteAcquire(key);

    assert.equal(owner.status, 'acquired');

    await assert.rejects(
      withClockedTransaction(async (db, clock) => {
        const records = db.conceptIdempotencyKeys ||= {};
        records[key] = `v2:${hash}:missing-${randomUUID()}`;

        completeConceptLease(
          db, owner.lease, key, hash, await clock(),
        );
      }),
      /AI_CONCEPT_LEASE_RESULT_MISSING/,
    );

    const snapshot = await readDb();

    assert.equal(snapshot.conceptIdempotencyKeys?.[key], undefined);

    assert.equal(
      snapshot.conceptGenerationLeases?.[owner.lease.key]?.ownerToken,
      owner.lease.ownerToken,
    );

    assert.equal(await releaseConceptLease(owner.lease), true);
  });

  await verify('PG-DI-07: released lease allows safe recovery', async () => {
    const key = scope();
    const first = await remoteAcquire(key);

    assert.equal(first.status, 'acquired');
    assert.equal(await releaseConceptLease(first.lease), true);

    const second = await remoteAcquire(key);
    assert.equal(second.status, 'acquired');

    assert.notEqual(first.lease.ownerToken, second.lease.ownerToken);

    assert.equal(await releaseConceptLease(first.lease), false);
    assert.equal(await releaseConceptLease(second.lease), true);
  });


  await verify(
    'PG-DI-08: transactional authorization rejection creates no lease',
    async () => {
      const key = scope();
      const before = await readDb();
      let authorizationChecks = 0;

      await assert.rejects(
        acquireConceptLease(
          key,
          hash,
          async () => {
            authorizationChecks++;
            throw new Error('AI_AUTHORIZATION_CHANGED');
          },
        ),
        /AI_AUTHORIZATION_CHANGED/,
      );

      assert.equal(authorizationChecks, 1);

      const after = await readDb();

      assert.deepEqual(
        after.conceptGenerationLeases || {},
        before.conceptGenerationLeases || {},
      );

      assert.deepEqual(
        after.conceptIdempotencyKeys || {},
        before.conceptIdempotencyKeys || {},
      );

      assert.equal(
        after.concepts.length,
        before.concepts.length,
      );

      const authorized = await acquireConceptLease(
        key,
        hash,
        async () => {
          authorizationChecks++;
        },
      );

      assert.equal(authorized.status, 'acquired');
      assert.equal(authorizationChecks, 2);

      assert.equal(
        await releaseConceptLease(authorized.lease),
        true,
      );
    },
  );

  assert.equal(passed, 8);
  console.log('CERTIFICATION_RESULT: 8/8');

}

main()
  .finally(() => closePgPool())
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(message.replace(
      /postgresql:\/\/[^\s]+/g,
      'postgresql://[REDACTED]',
    ));
    process.exitCode = 1;
  });
