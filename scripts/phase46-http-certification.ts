import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { createApp } from '../server/app.ts';

import {
  setGeminiExecutorForTests,
  setGeminiSleepForTests,
} from '../server/gemini.ts';

import {
  readDb,
  withTransaction,
  withClockedTransaction,
} from '../server/store.ts';

import {
  closePgPool,
  getPgPool,
} from '../server/repositories/postgresRepository.ts';

import {
  verifySessionToken,
  signSessionToken,
} from '../server/auth.ts';

const databaseUrl = new URL(process.env.DATABASE_URL || '');

assert.equal(databaseUrl.hostname, '127.0.0.1');
assert.equal(databaseUrl.pathname, '/cs_cert');
assert.equal(databaseUrl.username, 'cs_cert');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.PERSISTENCE_ADAPTER, 'postgres');
assert.equal(process.env.LIVE_EMAIL_SENDING_ENABLED, 'false');
assert.equal(process.env.LIVE_PAYMENTS_ENABLED, 'false');
assert.ok(process.env.SESSION_SECRET);

const payload = {
  eventType: 'Wedding Planning and Design',
  guestCount: 150,
  venueStyle: 'Historic Estate Ballroom',
  preferredPalette: 'Royal Purple and Gold',
  visionDescription:
    'Elegant candlelit wedding with ivory floral arrangements.',
};

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

type WorkerMessage = {
  type: string;
  port?: number;
};

type Backend = {
  child: ChildProcess;
  url: string;
  calls: number;
};

type Result = {
  code?: string;
  success?: boolean;
  retryable?: boolean;
  persisted?: boolean;
  deduplicated?: boolean;
  concept?: {
    id: string;
    currentVersion: number;
  };
};

const workers: Backend[] = [];
let passed = 0;

async function waitFor(
  condition: () => boolean,
  description: string,
  timeout = 10000,
) {
  const deadline = Date.now() + timeout;

  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`TIMEOUT: ${description}`);
    }

    await sleep(20);
  }
}

async function worker() {
  assert.ok(process.send);

  let releaseProvider: (() => void) | undefined;
  let failProvider = false;
  let timeoutProvider = false;

  process.on('message', (message: WorkerMessage) => {
    if (message.type === 'release' ||
        message.type === 'fail-provider' ||
        message.type === 'timeout-provider') {
      failProvider = message.type === 'fail-provider';
      timeoutProvider = message.type === 'timeout-provider';
      releaseProvider?.();
    }
  });

  setGeminiSleepForTests(async () => {});

  setGeminiExecutorForTests(async () => {
    const barrier = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });

    process.send?.({ type: 'provider-started' });

    await barrier;

    releaseProvider = undefined;

    if (timeoutProvider) {
      timeoutProvider = false;
      throw new Error(
        'AI_TIMEOUT: Controlled ambiguous upstream timeout',
      );
    }

    if (failProvider) {
      failProvider = false;
      throw Object.assign(
        new Error('Controlled invalid provider request'),
        { status: 400, code: 400 },
      );
    }

    return {
      text: JSON.stringify(SAMPLE_WEDDING_PROPOSAL),
    };
  });

  const app = createApp({ enableRateLimit: false });

  const server = await new Promise<
    ReturnType<typeof app.listen>
  >((resolve) => {
    const listening = app.listen(
      0, '127.0.0.1', () => resolve(listening),
    );
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object');

  process.send({
    type: 'ready',
    port: address.port,
  });

  process.on('disconnect', () => {
    releaseProvider?.();
    server.close();
  });
}

async function startBackend(): Promise<Backend> {
  const child = fork(
    fileURLToPath(import.meta.url),
    ['--worker'],
    {
      execArgv: ['--import', 'tsx'],
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    },
  );

  const backend: Backend = {
    child,
    calls: 0,
    url: '',
  };

  workers.push(backend);

  child.on('message', (message: WorkerMessage) => {
    if (message.type === 'ready') {
      backend.url = `http://127.0.0.1:${message.port}`;
    }

    if (message.type === 'provider-started') {
      backend.calls++;
    }
  });

  await waitFor(
    () => Boolean(backend.url),
    'Backend startup',
    20000,
  );

  return backend;
}

function submit(
  backend: Backend,
  token: string,
  key: string,
  body = payload,
) {
  return fetch(`${backend.url}/api/ai/concept-studio`, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': key,
    },
    body: JSON.stringify(body),
  });
}

async function result(response: Response): Promise<Result> {
  return await response.json() as Result;
}

function pass(name: string) {
  passed++;
  console.log(`PASS: ${name}`);
}

function customerToken(userId = 'user-client-camille') {
  const now = Date.now();

  return signSessionToken({
    userId,
    role: 'client',
    mfaVerified: false,
    issuedAt: now,
    expiresAt: now + 300000,
  });
}

async function main() {
  const a = await startBackend();
  const b = await startBackend();

  assert.notEqual(a.child.pid, b.child.pid);
  assert.notEqual(a.url, b.url);

  pass('HTTP-DI-01: independent HTTP backends');

  const token = customerToken();
  const key = `http-cert-${randomUUID()}`;
  const scopedKey = `user-client-camille:${key}`;

  const before = await readDb();
  const initialCount = before.concepts.length;

  const first = submit(a, token, key);
  void first.catch(() => {});

  await waitFor(
    () => a.calls === 1,
    'Backend A provider invocation',
  );

  const busyResponse = await submit(b, token, key);
  const busy = await result(busyResponse);

  assert.equal(busyResponse.status, 503);
  assert.equal(busy.code, 'AI_SERVICE_BUSY');
  assert.equal(busy.retryable, true);
  assert.equal(busy.concept, undefined);
  assert.ok(busyResponse.headers.get('Retry-After'));

  pass('HTTP-DI-02: competing identical request receives safe retry');

  assert.equal(a.calls + b.calls, 1);

  pass('HTTP-DI-03: exactly one provider invocation');

  const conflictResponse = await submit(
    b, token, key,
    { ...payload, guestCount: 200 },
  );

  const conflict = await result(conflictResponse);

  assert.equal(conflictResponse.status, 409);
  assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(conflict.retryable, false);
  assert.equal(conflict.concept, undefined);
  assert.equal(a.calls + b.calls, 1);

  pass('HTTP-DI-05: cross-instance fingerprint conflict');

  a.child.send({ type: 'release' });

  const firstResponse = await first;
  const created = await result(firstResponse);

  assert.equal(firstResponse.status, 200);
  assert.equal(created.persisted, true);
  assert.equal(created.deduplicated, false);
  assert.ok(created.concept?.id);
  assert.equal(created.concept.currentVersion, 1);

  const after = await readDb();

  assert.equal(after.concepts.length, initialCount + 1);

  pass('HTTP-DI-04: exactly one persisted proposal');

  const replayResponse = await submit(b, token, key);
  const replay = await result(replayResponse);

  assert.equal(replayResponse.status, 200);
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.concept?.id, created.concept.id);
  assert.equal(a.calls + b.calls, 1);

  pass('HTTP-DI-06: durable replay from another backend');

  const record = after.conceptIdempotencyKeys?.[scopedKey];

  assert.ok(record?.startsWith('v2:'));
  assert.ok(record.endsWith(`:${created.concept.id}`));

  assert.equal(
    Object.keys(after.conceptGenerationLeases || {}).length,
    0,
  );

  pass('HTTP-DI-12: durable result and lease completion');

  const revocationToken = customerToken();
  const session = verifySessionToken(revocationToken);

  assert.ok(session?.jti);

  const sessionId = session.jti;
  const revocationKey = `http-revoke-${randomUUID()}`;

  const pending = submit(a, revocationToken, revocationKey);
  void pending.catch(() => {});

  await waitFor(
    () => a.calls === 2,
    'Revocation test provider invocation',
  );

  await withTransaction((db) => {
    const revoked = db.revokedSessionIds ||= {};
    revoked[sessionId] = session.expiresAt;
  });

  a.child.send({ type: 'release' });

  const revokedResponse = await pending;
  const rejected = await result(revokedResponse);

  assert.equal(revokedResponse.status, 403);
  assert.equal(rejected.code, 'AI_AUTHORIZATION_CHANGED');
  assert.equal(rejected.concept, undefined);
  assert.equal(rejected.retryable, false);

  const final = await readDb();

  assert.equal(final.concepts.length, initialCount + 1);

  assert.equal(
    final.conceptIdempotencyKeys?.[
      `user-client-camille:${revocationKey}`
    ],
    undefined,
  );

  const revokedReplay = await submit(
    b, revocationToken, revocationKey,
  );

  assert.equal(revokedReplay.status, 403);
  await revokedReplay.json();

  assert.equal(a.calls + b.calls, 2);

  pass('HTTP-DI-08: cross-instance session revocation');


  // HTTP-DI-07: authenticated client isolation.
  const customerState = await readDb();

  const otherClient = customerState.users.find(
    user => user.role === 'client' &&
      user.id !== 'user-client-camille' &&
      (!user.accountStatus || user.accountStatus === 'active'),
  );

  assert.ok(otherClient, 'Second active client fixture required');

  const otherToken = customerToken(otherClient.id);
  const callsBeforeIsolation = a.calls + b.calls;

  const isolationRequest = submit(b, otherToken, key);
  void isolationRequest.catch(() => {});

  await waitFor(
    () => a.calls + b.calls >= callsBeforeIsolation + 1,
    'Second customer independent provider invocation',
  );

  b.child.send({ type: 'release' });

  const isolationResponse = await isolationRequest;
  const isolationResult = await result(isolationResponse);

  assert.equal(isolationResponse.status, 200);
  assert.equal(isolationResult.deduplicated, false);
  assert.ok(isolationResult.concept?.id);
  assert.notEqual(isolationResult.concept.id, created.concept.id);

  assert.equal(a.calls + b.calls, callsBeforeIsolation + 1);

  const isolationDb = await readDb();

  assert.ok(
    isolationDb.conceptIdempotencyKeys?.[
      `${otherClient.id}:${key}`
    ]?.endsWith(`:${isolationResult.concept.id}`),
  );

  assert.ok(
    isolationDb.conceptIdempotencyKeys?.[scopedKey]
      ?.endsWith(`:${created.concept.id}`),
  );

  const foreignRevision = await fetch(
    `${b.url}/api/ai/concept-studio`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${otherToken}`,
        'Idempotency-Key': `foreign-${randomUUID()}`,
      },
      body: JSON.stringify({
        ...payload,
        conceptId: created.concept.id,
      }),
    },
  );

  assert.equal(foreignRevision.status, 403);
  assert.equal((await result(foreignRevision)).concept, undefined);
  assert.equal(a.calls + b.calls, callsBeforeIsolation + 1);

  pass('HTTP-DI-07: cross-instance customer isolation');

  // HTTP-DI-09: expired lease fencing.
  const leaseKey = `http-expiry-${randomUUID()}`;
  const expiryBaseline = await readDb();
  const aBeforeExpiry = a.calls;
  const bBeforeExpiry = b.calls;

  const staleRequest = submit(a, token, leaseKey);
  void staleRequest.catch(() => {});

  await waitFor(
    () => a.calls === aBeforeExpiry + 1,
    'Original lease owner',
  );

  let expiredOwnerToken = '';

  await withClockedTransaction(async (db, clock) => {
    const entries = Object.values(
      db.conceptGenerationLeases || {},
    );

    assert.equal(entries.length, 1);

    expiredOwnerToken = entries[0].ownerToken;
    entries[0].expiresAt = (await clock()) - 1;
  });

  const successorRequest = submit(b, token, leaseKey);
  void successorRequest.catch(() => {});

  await waitFor(
    () => b.calls === bBeforeExpiry + 1,
    'Successor lease owner',
  );

  const successorState = await readDb();
  const successorLeases = Object.values(
    successorState.conceptGenerationLeases || {},
  );

  assert.equal(successorLeases.length, 1);
  assert.notEqual(
    successorLeases[0].ownerToken,
    expiredOwnerToken,
  );

  const successorToken = successorLeases[0].ownerToken;

  // Release stale owner while successor is still running.
  a.child.send({ type: 'release' });

  const staleResponse = await staleRequest;
  const staleResult = await result(staleResponse);

  assert.equal(staleResponse.status, 503);
  assert.equal(staleResult.concept, undefined);

  const fencedState = await readDb();

  assert.equal(
    fencedState.concepts.length,
    expiryBaseline.concepts.length,
  );

  assert.equal(
    Object.values(
      fencedState.conceptGenerationLeases || {},
    )[0]?.ownerToken,
    successorToken,
  );

  b.child.send({ type: 'release' });

  const successorResponse = await successorRequest;
  const successorResult = await result(successorResponse);

  assert.equal(successorResponse.status, 200);
  assert.ok(successorResult.concept?.id);

  const expiryFinal = await readDb();

  assert.equal(
    expiryFinal.concepts.length,
    expiryBaseline.concepts.length + 1,
  );

  assert.equal(
    Object.keys(expiryFinal.conceptGenerationLeases || {}).length,
    0,
  );

  pass('HTTP-DI-09: expired owner cannot persist or remove successor lease');

  // HTTP-DI-10: controlled provider rejection and recovery.
  const recoveryKey = `http-recovery-${randomUUID()}`;
  const recoveryBaseline = await readDb();
  const aBeforeFailure = a.calls;
  const bBeforeRecovery = b.calls;

  const failingRequest = submit(a, token, recoveryKey);
  void failingRequest.catch(() => {});

  await waitFor(
    () => a.calls === aBeforeFailure + 1,
    'Provider failure invocation',
  );

  a.child.send({ type: 'fail-provider' });

  const failedResponse = await failingRequest;
  const failedResult = await result(failedResponse);

  assert.ok(failedResponse.status >= 400);
  assert.equal(failedResult.concept, undefined);

  const failedState = await readDb();

  assert.equal(
    failedState.concepts.length,
    recoveryBaseline.concepts.length,
  );

  assert.equal(
    failedState.conceptIdempotencyKeys?.[
      `user-client-camille:${recoveryKey}`
    ],
    undefined,
  );

  assert.equal(
    Object.keys(failedState.conceptGenerationLeases || {}).length,
    0,
  );

  const recoveredRequest = submit(b, token, recoveryKey);
  void recoveredRequest.catch(() => {});

  await waitFor(
    () => b.calls === bBeforeRecovery + 1,
    'Cross-instance provider recovery',
  );

  b.child.send({ type: 'release' });

  const recoveredResponse = await recoveredRequest;
  const recoveredResult = await result(recoveredResponse);

  assert.equal(recoveredResponse.status, 200);
  assert.ok(recoveredResult.concept?.id);

  const recoveredState = await readDb();

  assert.equal(
    recoveredState.concepts.length,
    recoveryBaseline.concepts.length + 1,
  );

  const recoveredReplay = await submit(a, token, recoveryKey);

  assert.equal(recoveredReplay.status, 200);
  assert.equal(
    (await result(recoveredReplay)).concept?.id,
    recoveredResult.concept.id,
  );

  assert.equal(a.calls, aBeforeFailure + 1);
  assert.equal(b.calls, bBeforeRecovery + 1);

  pass('HTTP-DI-10: provider failure and cross-instance recovery');

  // HTTP-DI-11: actual PostgreSQL write rejection.
  // The temporary trigger exists ONLY in the isolated test database.
  const pool = getPgPool();
  const databaseFailureKey = `http-db-failure-${randomUUID()}`;

  const databaseBaseline = await readDb();
  const aBeforeDbFailure = a.calls;
  const bBeforeDbRecovery = b.calls;

  const databaseRequest = submit(a, token, databaseFailureKey);
  void databaseRequest.catch(() => {});

  await waitFor(
    () => a.calls === aBeforeDbFailure + 1,
    'Database failure scenario provider invocation',
  );

  await pool.query(`
    CREATE FUNCTION public.cert_reject_concept_write()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.payload->'concepts'
         IS DISTINCT FROM OLD.payload->'concepts' THEN
        RAISE EXCEPTION 'CERT_CONTROLLED_DATABASE_WRITE_FAILURE';
      END IF;
      RETURN NEW;
    END;
    $$
  `);

  try {
    await pool.query(`
      CREATE TRIGGER cert_reject_concept_write
      BEFORE UPDATE ON public.app_state_snapshots
      FOR EACH ROW
      EXECUTE FUNCTION public.cert_reject_concept_write()
    `);

    a.child.send({ type: 'release' });

    const databaseResponse = await databaseRequest;
    const databaseResult = await result(databaseResponse);

    assert.ok(databaseResponse.status >= 500);
    assert.equal(databaseResult.concept, undefined);

    const rollbackState = await readDb();

    assert.equal(
      rollbackState.concepts.length,
      databaseBaseline.concepts.length,
    );

    assert.equal(
      rollbackState.conceptIdempotencyKeys?.[
        `user-client-camille:${databaseFailureKey}`
      ],
      undefined,
    );

    assert.equal(
      Object.keys(rollbackState.conceptGenerationLeases || {}).length,
      0,
    );
  } finally {
    await pool.query(`
      DROP TRIGGER IF EXISTS cert_reject_concept_write
      ON public.app_state_snapshots
    `);

    await pool.query(`
      DROP FUNCTION IF EXISTS public.cert_reject_concept_write()
    `);
  }

  const databaseRecovery = submit(b, token, databaseFailureKey);
  void databaseRecovery.catch(() => {});

  await waitFor(
    () => b.calls === bBeforeDbRecovery + 1,
    'Database recovery provider invocation',
  );

  b.child.send({ type: 'release' });

  const databaseRecoveryResponse = await databaseRecovery;
  const databaseRecoveryResult = await result(databaseRecoveryResponse);

  assert.equal(databaseRecoveryResponse.status, 200);
  assert.ok(databaseRecoveryResult.concept?.id);

  const databaseFinal = await readDb();

  assert.equal(
    databaseFinal.concepts.length,
    databaseBaseline.concepts.length + 1,
  );

  assert.ok(
    databaseFinal.conceptIdempotencyKeys?.[
      `user-client-camille:${databaseFailureKey}`
    ]?.endsWith(`:${databaseRecoveryResult.concept.id}`),
  );

  assert.equal(
    Object.keys(databaseFinal.conceptGenerationLeases || {}).length,
    0,
  );

  pass('HTTP-DI-11: PostgreSQL write failure rolls back and permits recovery');


  // HTTP-DI-19: ambiguous provider timeout protection.
  const timeoutKey = `http-timeout-${randomUUID()}`;
  const timeoutBaseline = await readDb();

  const aBeforeTimeout = a.calls;
  const bBeforeTimeout = b.calls;

  const timeoutRequest = submit(a, token, timeoutKey);
  void timeoutRequest.catch(() => {});

  await waitFor(
    () => a.calls === aBeforeTimeout + 1,
    'Ambiguous provider timeout invocation',
  );

  a.child.send({ type: 'timeout-provider' });

  const timeoutResponse = await timeoutRequest;
  const timeoutResult = await result(timeoutResponse);

  assert.equal(timeoutResponse.status, 504);
  assert.equal(timeoutResult.code, 'AI_TIMEOUT');
  assert.equal(timeoutResult.concept, undefined);

  assert.equal(a.calls, aBeforeTimeout + 1);

  const retainedState = await readDb();

  assert.equal(
    retainedState.concepts.length,
    timeoutBaseline.concepts.length,
  );

  assert.equal(
    retainedState.conceptIdempotencyKeys?.[
      `user-client-camille:${timeoutKey}`
    ],
    undefined,
  );

  const retainedLeases = Object.entries(
    retainedState.conceptGenerationLeases || {},
  );

  assert.equal(retainedLeases.length, 1);

  const [retainedKey, retainedLease] = retainedLeases[0];

  const timeoutReplay = await submit(b, token, timeoutKey);
  const timeoutReplayResult = await result(timeoutReplay);

  assert.equal(timeoutReplay.status, 503);
  assert.equal(timeoutReplayResult.code, 'AI_SERVICE_BUSY');
  assert.equal(timeoutReplayResult.concept, undefined);
  assert.equal(b.calls, bBeforeTimeout);

  const conflictingTimeoutReplay = await submit(
    b, token, timeoutKey,
    { ...payload, guestCount: 250 },
  );

  assert.equal(conflictingTimeoutReplay.status, 409);
  assert.equal(
    (await result(conflictingTimeoutReplay)).code,
    'IDEMPOTENCY_CONFLICT',
  );

  assert.equal(b.calls, bBeforeTimeout);

  const blockedState = await readDb();

  assert.equal(
    blockedState.conceptGenerationLeases?.[
      retainedKey
    ]?.ownerToken,
    retainedLease.ownerToken,
  );

  pass('HTTP-DI-19: ambiguous timeout blocks duplicate cross-instance generation');

  // HTTP-DI-20: controlled recovery after durable expiry.
  await withClockedTransaction(async (db, clock) => {
    const lease = db.conceptGenerationLeases?.[retainedKey];

    assert.ok(lease);
    assert.equal(lease.ownerToken, retainedLease.ownerToken);

    lease.expiresAt = (await clock()) - 1;
  });

  const timeoutRecovery = submit(b, token, timeoutKey);
  void timeoutRecovery.catch(() => {});

  await waitFor(
    () => b.calls === bBeforeTimeout + 1,
    'Recovery following controlled lease expiry',
  );

  b.child.send({ type: 'release' });

  const timeoutRecoveryResponse = await timeoutRecovery;
  const timeoutRecoveryResult = await result(
    timeoutRecoveryResponse,
  );

  assert.equal(timeoutRecoveryResponse.status, 200);
  assert.ok(timeoutRecoveryResult.concept?.id);

  const timeoutFinal = await readDb();

  assert.equal(
    timeoutFinal.concepts.length,
    timeoutBaseline.concepts.length + 1,
  );

  assert.equal(
    Object.keys(timeoutFinal.conceptGenerationLeases || {}).length,
    0,
  );

  assert.ok(
    timeoutFinal.conceptIdempotencyKeys?.[
      `user-client-camille:${timeoutKey}`
    ]?.endsWith(`:${timeoutRecoveryResult.concept.id}`),
  );

  const finalTimeoutReplay = await submit(a, token, timeoutKey);

  assert.equal(finalTimeoutReplay.status, 200);
  assert.equal(
    (await result(finalTimeoutReplay)).concept?.id,
    timeoutRecoveryResult.concept.id,
  );

  assert.equal(a.calls, aBeforeTimeout + 1);
  assert.equal(b.calls, bBeforeTimeout + 1);

  pass('HTTP-DI-20: expired timeout lease permits controlled recovery');


  // Phase 46F.4E.6: Authorization changes while another
  // backend is waiting for the actual PostgreSQL row lock.

  type RaceState = Awaited<ReturnType<typeof readDb>>;

  const runAuthorizationRace = async (
    name: string,
    requestToken: string,
    body: typeof payload & {
      bookingId?: string;
      conceptId?: string;
    },
    mutate: (db: RaceState) => void,
    restore: (db: RaceState) => void,
    expectedStatus: number,
    expectedCode?: string,
  ) => {
    const raceKey = `authorization-race-${randomUUID()}`;

    const baseline = await readDb();
    const callsBefore = a.calls + b.calls;

    let pending: Promise<Response> | undefined;

    try {
      // Hold the same database row lock needed by the
      // durable generation lease acquisition transaction.
      await withTransaction(async (db) => {
        pending = submit(a, requestToken, raceKey, body);
        void pending.catch(() => {});

        const lockDeadline = Date.now() + 8000;
        let waiting = false;

        while (Date.now() < lockDeadline) {
          const activity = await getPgPool().query<{
            waiting: boolean;
          }>(`
            SELECT EXISTS (
              SELECT 1
              FROM pg_stat_activity
              WHERE datname = current_database()
                AND pid <> pg_backend_pid()
                AND wait_event_type = 'Lock'
                AND query ILIKE '%app_state_snapshots%'
            ) AS waiting
          `);

          if (activity.rows[0]?.waiting) {
            waiting = true;
            break;
          }

          await new Promise(resolve => setTimeout(resolve, 20));
        }

        assert.equal(
          waiting,
          true,
          `${name}: backend never reached database lock boundary`,
        );

        assert.equal(
          a.calls + b.calls,
          callsBefore,
          `${name}: provider invoked before authorization`,
        );

        // Commit the authorization change before the
        // waiting generation transaction obtains ownership.
        mutate(db);
      });

      assert.ok(pending);

      const response = await pending;
      const rejected = await result(response);

      assert.equal(response.status, expectedStatus, name);

      if (expectedCode) {
        assert.equal(rejected.code, expectedCode, name);
      }

      assert.equal(rejected.concept, undefined, name);

      assert.equal(
        a.calls + b.calls,
        callsBefore,
        `${name}: unauthorized provider invocation`,
      );

      const final = await readDb();

      assert.equal(
        final.concepts.length,
        baseline.concepts.length -
          (
            name.startsWith('HTTP-DI-16')
              ? 1 : 0
          ),
        `${name}: unauthorized persistence`,
      );

      assert.deepEqual(
        final.conceptGenerationLeases || {},
        baseline.conceptGenerationLeases || {},
        `${name}: unexpected durable lease`,
      );

      assert.deepEqual(
        final.conceptIdempotencyKeys || {},
        baseline.conceptIdempotencyKeys || {},
        `${name}: unexpected idempotency result`,
      );

    } finally {
      // Restore only the isolated certification fixtures.
      await withTransaction(db => restore(db));
    }

    pass(name);
  };

  // HTTP-DI-13: session revocation while awaiting ownership.
  const raceToken = customerToken();
  const raceSession = verifySessionToken(raceToken);

  assert.ok(raceSession?.jti);

  const raceSessionId = raceSession.jti;

  await runAuthorizationRace(
    'HTTP-DI-13: session revoked during lease acquisition',
    raceToken,
    payload,
    db => {
      (db.revokedSessionIds ||= {})[raceSessionId] =
        raceSession.expiresAt;
    },
    db => {
      delete db.revokedSessionIds?.[raceSessionId];
    },
    403,
    'AI_AUTHORIZATION_CHANGED',
  );

  // HTTP-DI-14: suspension while awaiting ownership.
  const suspensionState = await readDb();

  const suspensionUser = suspensionState.users.find(
    user => user.id === 'user-client-camille',
  );

  assert.ok(suspensionUser);

  const originalAccountStatus = suspensionUser.accountStatus;

  await runAuthorizationRace(
    'HTTP-DI-14: suspended account cannot acquire lease',
    customerToken(),
    payload,
    db => {
      const user = db.users.find(
        item => item.id === 'user-client-camille',
      );

      assert.ok(user);
      user.accountStatus = 'suspended';
    },
    db => {
      const user = db.users.find(
        item => item.id === 'user-client-camille',
      );

      assert.ok(user);
      user.accountStatus = originalAccountStatus;
    },
    403,
    'AI_AUTHORIZATION_CHANGED',
  );

  // HTTP-DI-15: booking ownership transfer.
  const bookingState = await readDb();

  const raceBooking = bookingState.bookings.find(
    booking => booking.clientId === 'user-client-camille',
  );

  assert.ok(raceBooking, 'Owned booking fixture required');

  await runAuthorizationRace(
    'HTTP-DI-15: booking transferred during lease acquisition',
    customerToken(),
    { ...payload, bookingId: raceBooking.id },
    db => {
      const booking = db.bookings.find(
        item => item.id === raceBooking.id,
      );

      assert.ok(booking);
      booking.clientId = otherClient.id;
    },
    db => {
      const booking = db.bookings.find(
        item => item.id === raceBooking.id,
      );

      assert.ok(booking);
      booking.clientId = raceBooking.clientId;
    },
    403,
  );

  // Preserve the original successfully generated proposal
  // as the revision fixture.
  const revisionState = await readDb();

  const revisionIndex = revisionState.concepts.findIndex(
    concept => concept.id === created.concept!.id,
  );

  assert.ok(revisionIndex >= 0);

  const revisionFixture = structuredClone(
    revisionState.concepts[revisionIndex],
  );

  const revisionBody = {
    ...payload,
    conceptId: revisionFixture.id,
  };

  // HTTP-DI-16: revision deleted while awaiting ownership.
  await runAuthorizationRace(
    'HTTP-DI-16: deleted revision cannot invoke provider',
    customerToken(),
    revisionBody,
    db => {
      db.concepts = db.concepts.filter(
        item => item.id !== revisionFixture.id,
      );
    },
    db => {
      if (!db.concepts.some(
        item => item.id === revisionFixture.id,
      )) {
        db.concepts.splice(
          revisionIndex, 0,
          structuredClone(revisionFixture),
        );
      }
    },
    404,
    'CONCEPT_NOT_FOUND',
  );

  // HTTP-DI-17: concept ownership changes.
  await runAuthorizationRace(
    'HTTP-DI-17: transferred concept ownership blocks revision',
    customerToken(),
    revisionBody,
    db => {
      const concept = db.concepts.find(
        item => item.id === revisionFixture.id,
      );

      assert.ok(concept);
      concept.clientId = otherClient.id;
    },
    db => {
      const concept = db.concepts.find(
        item => item.id === revisionFixture.id,
      );

      assert.ok(concept);
      concept.clientId = revisionFixture.clientId;
    },
    403,
  );

  // HTTP-DI-18: newly dual-approved revision is locked.
  await runAuthorizationRace(
    'HTTP-DI-18: newly dual-approved concept blocks revision',
    customerToken(),
    revisionBody,
    db => {
      const concept = db.concepts.find(
        item => item.id === revisionFixture.id,
      );

      assert.ok(concept);
      concept.clientApproved = true;
      concept.staffApproved = true;
    },
    db => {
      const concept = db.concepts.find(
        item => item.id === revisionFixture.id,
      );

      assert.ok(concept);
      concept.clientApproved = revisionFixture.clientApproved;
      concept.staffApproved = revisionFixture.staffApproved;
    },
    409,
  );

  assert.equal(passed, 20);

  console.log('HTTP_CERTIFICATION_RESULT: 20/20');



}

async function run() {
  if (process.argv[2] === '--worker') {
    await worker();
    return;
  }

  try {
    await main();
  } finally {
    for (const backend of workers) {
      if (backend.child.connected) {
        backend.child.send({ type: 'release' });
      }

      backend.child.kill();
    }

    await closePgPool();
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error
    ? error.message
    : 'Unknown certification error';

  console.error(
    message.replace(
      /postgresql:\/\/[^\s]+/g,
      'postgresql://[REDACTED]',
    ),
  );

  process.exitCode = 1;
});
