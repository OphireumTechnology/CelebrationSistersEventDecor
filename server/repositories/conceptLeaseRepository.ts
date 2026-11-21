import { createHash, randomUUID } from 'node:crypto';
import {
  readDb,
  withTransaction,
  withClockedTransaction,
} from '../store.ts';

type LeaseState = Awaited<ReturnType<typeof readDb>>;

// Provisional lease duration covering the known provider
// retry window. Final runtime budget certification is required.
export const CONCEPT_LEASE_TTL_MS = 600_000;
export const MAX_DURABLE_CONCEPT_LEASES = 256;

export type ConceptLease = {
  key: string;
  fingerprint: string;
  ownerToken: string;
  expiresAt: number;
};

export type ConceptLeaseAcquisition =
  | { status: 'acquired'; lease: ConceptLease }
  | { status: 'completed'; record: string }
  | { status: 'busy' }
  | { status: 'conflict' }
  | { status: 'saturated' };

function leaseKey(scopedKey: string): string {
  return createHash('sha256')
    .update(scopedKey)
    .digest('hex');
}

function validateInputs(
  scopedKey: string,
  fingerprint: string,
): void {
  if (
    !scopedKey ||
    scopedKey.length > 1024 ||
    !/^[a-f0-9]{64}$/.test(fingerprint)
  ) {
    throw new Error('INVALID_CONCEPT_LEASE_INPUT');
  }
}

/**
 * Acquire a lease atomically using the persistence adapter.
 * No external provider calls occur inside this transaction.
 */
export async function acquireConceptLease(
  scopedKey: string,
  fingerprint: string,
  validateAuthorization?: (db: LeaseState) => Promise<void> | void,
): Promise<ConceptLeaseAcquisition> {
  validateInputs(scopedKey, fingerprint);

  const key = leaseKey(scopedKey);
  const ownerToken = randomUUID();

  return withClockedTransaction(async (db, clock) => {
    if (validateAuthorization) {
      await validateAuthorization(db);
    }

    const now = await clock();

    const durableRecord =
      db.conceptIdempotencyKeys?.[scopedKey];

    if (durableRecord) {
      if (
        !durableRecord.startsWith(`v2:${fingerprint}:`)
      ) {
        return { status: 'conflict' };
      }

      return {
        status: 'completed',
        record: durableRecord,
      };
    }

    const leases = db.conceptGenerationLeases ||= {};

    // Remove expired leases while holding the state lock.
    for (const [storedKey, lease] of Object.entries(leases)) {
      if (lease.expiresAt <= now) {
        delete leases[storedKey];
      }
    }

    const existing = leases[key];

    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return { status: 'conflict' };
      }

      return { status: 'busy' };
    }

    if (
      Object.keys(leases).length >=
      MAX_DURABLE_CONCEPT_LEASES
    ) {
      return { status: 'saturated' };
    }

    const expiresAt = now + CONCEPT_LEASE_TTL_MS;

    leases[key] = {
      fingerprint,
      ownerToken,
      acquiredAt: now,
      expiresAt,
    };

    return {
      status: 'acquired',
      lease: {
        key,
        fingerprint,
        ownerToken,
        expiresAt,
      },
    };
  });
}

/**
 * Assert ownership inside the SAME transaction that will
 * persist the AI result. Expired owners fail closed.
 */
export function assertConceptLeaseOwnership(
  db: LeaseState,
  lease: ConceptLease,
  scopedKey: string,
  fingerprint: string,
  now: number = Date.now(),
): void {
  const current = db.conceptGenerationLeases?.[lease.key];

  if (
    lease.key !== leaseKey(scopedKey) ||
    lease.fingerprint !== fingerprint ||
    !current ||
    current.ownerToken !== lease.ownerToken ||
    current.fingerprint !== fingerprint ||
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    current.expiresAt <= now
  ) {
    throw new Error('AI_CONCEPT_LEASE_LOST');
  }
}

/**
 * Finalization must be called in the same transaction as
 * concept persistence and durable idempotency recording.
 */
export function completeConceptLease(
  db: LeaseState,
  lease: ConceptLease,
  scopedKey: string,
  fingerprint: string,
  now: number = Date.now(),
): void {
  assertConceptLeaseOwnership(
    db, lease, scopedKey, fingerprint, now,
  );

  const record = db.conceptIdempotencyKeys?.[scopedKey];
  const prefix = `v2:${fingerprint}:`;

  if (
    !record?.startsWith(prefix) ||
    !db.concepts.some((c) => c.id === record.slice(prefix.length))
  ) {
    throw new Error('AI_CONCEPT_LEASE_RESULT_MISSING');
  }

  delete db.conceptGenerationLeases![lease.key];
}

/**
 * Release only the caller's own lease.
 * A former owner cannot release its successor's lease.
 */
export async function releaseConceptLease(
  lease: ConceptLease,
): Promise<boolean> {
  return withTransaction((db) => {
    const current =
      db.conceptGenerationLeases?.[lease.key];

    if (
      !current ||
      current.ownerToken !== lease.ownerToken ||
      current.fingerprint !== lease.fingerprint
    ) {
      return false;
    }

    delete db.conceptGenerationLeases![lease.key];

    return true;
  });
}
