import crypto from 'node:crypto';
import type { DatabaseSchema } from '../server/store.ts';
import { readDb } from '../server/store.ts';

/**
 * Snapshot-to-Normalized PostgreSQL Reconciliation & Performance Benchmark Utility (Block 13.5).
 * Safely inspects app_state_snapshots (or local JSON) and computes exact normalized row plans,
 * financial checksums, and conflict checks without deleting or mutating existing snapshot data.
 */

export interface EntityReconciliationSummary {
  entity: string;
  targetTable: string;
  snapshotCount: number;
  checksumSha256: string;
}

export interface ReconciliationReport {
  mode: 'dry-run';
  generatedAt: string;
  snapshotPreserved: true;
  totalEntities: number;
  totalFinancialCents: number;
  paidFinancialCents: number;
  anomalies: string[];
  entities: EntityReconciliationSummary[];
  benchmark: {
    iterations: number;
    snapshotCloneAvgMs: number;
    normalizedRowLookupAvgMs: number;
  };
}

function hashRows(rows: unknown[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(rows), 'utf8').digest('hex').slice(0, 16);
}

export function buildReconciliationReport(db: DatabaseSchema): ReconciliationReport {
  const anomalies: string[] = [];
  const seenRefs = new Set<string>();
  const seenVenueDates = new Set<string>();
  let totalFinancialCents = 0;
  let paidFinancialCents = 0;

  const quoteRows: unknown[] = [];
  const quoteItemRows: unknown[] = [];
  const contractRows: unknown[] = [];
  const paymentRows: unknown[] = [];
  const messageRows: unknown[] = [];

  for (const b of db.bookings) {
    if (seenRefs.has(b.referenceCode)) {
      anomalies.push(`Duplicate booking referenceCode detected: ${b.referenceCode}`);
    }
    seenRefs.add(b.referenceCode);

    if (b.status !== 'Cancelled') {
      const key = `${b.eventDate}|${b.venueName.trim().toLowerCase()}`;
      if (seenVenueDates.has(key)) {
        anomalies.push(`Active venue/date conflict detected: ${key}`);
      }
      seenVenueDates.add(key);
    }

    for (const q of b.quotations) {
      quoteRows.push({ bookingId: b.id, version: q.version, totalCents: Math.round(q.totalAmount * 100) });
      for (const item of q.items) {
        quoteItemRows.push({
          bookingId: b.id,
          version: q.version,
          id: item.id,
          quantity: item.quantity,
          unitPriceCents: Math.round(item.unitPrice * 100),
        });
      }
    }

    contractRows.push({ bookingId: b.id, id: b.contract.id, clientSigned: b.contract.clientSigned });

    for (const p of b.payments) {
      const cents = Math.round(p.amount * 100);
      totalFinancialCents += cents;
      if (p.status === 'Paid') paidFinancialCents += cents;
      paymentRows.push({ bookingId: b.id, id: p.id, cents, status: p.status });
    }

    for (const m of b.messages) {
      messageRows.push({ bookingId: b.id, id: m.id, role: m.role });
    }
  }

  const entities: EntityReconciliationSummary[] = [
    { entity: 'users', targetTable: 'users', snapshotCount: db.users.length, checksumSha256: hashRows(db.users.map((u) => u.id)) },
    { entity: 'bookings', targetTable: 'bookings', snapshotCount: db.bookings.length, checksumSha256: hashRows(db.bookings.map((b) => b.referenceCode)) },
    { entity: 'quotations', targetTable: 'quotations', snapshotCount: quoteRows.length, checksumSha256: hashRows(quoteRows) },
    { entity: 'quote_items', targetTable: 'quote_items', snapshotCount: quoteItemRows.length, checksumSha256: hashRows(quoteItemRows) },
    { entity: 'contracts', targetTable: 'contracts', snapshotCount: contractRows.length, checksumSha256: hashRows(contractRows) },
    { entity: 'payments', targetTable: 'payments', snapshotCount: paymentRows.length, checksumSha256: hashRows(paymentRows) },
    { entity: 'messages', targetTable: 'messages', snapshotCount: messageRows.length, checksumSha256: hashRows(messageRows) },
    { entity: 'concepts', targetTable: 'design_concepts', snapshotCount: db.concepts.length, checksumSha256: hashRows(db.concepts.map((c) => c.id)) },
    { entity: 'vendors', targetTable: 'vendors', snapshotCount: db.vendors.length, checksumSha256: hashRows(db.vendors.map((v) => v.id)) },
    { entity: 'inventory', targetTable: 'inventory_items', snapshotCount: db.inventory.length, checksumSha256: hashRows(db.inventory.map((i) => i.sku)) },
    { entity: 'aiSessions', targetTable: 'ai_sessions', snapshotCount: db.aiSessions.length, checksumSha256: hashRows(db.aiSessions.map((a) => a.id)) },
    { entity: 'auditLogs', targetTable: 'audit_logs', snapshotCount: db.auditLogs.length, checksumSha256: hashRows(db.auditLogs.map((a) => a.id)) },
    { entity: 'notificationOutbox', targetTable: 'notification_outbox', snapshotCount: db.notificationOutbox.length, checksumSha256: hashRows(db.notificationOutbox.map((n) => n.idempotencyKey)) },
  ];

  // Lightweight deterministic micro-benchmark: full JSONB snapshot serialization vs indexed row lookup
  const iterations = 100;
  const bookingById = new Map(db.bookings.map((b) => [b.id, b]));
  const targetId = db.bookings[0]?.id ?? '';

  const t0 = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    JSON.parse(JSON.stringify(db));
  }
  const snapshotCloneAvgMs = Number(((performance.now() - t0) / iterations).toFixed(4));

  const t1 = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    bookingById.get(targetId);
  }
  const normalizedRowLookupAvgMs = Number(((performance.now() - t1) / iterations).toFixed(6));

  return {
    mode: 'dry-run',
    generatedAt: new Date().toISOString(),
    snapshotPreserved: true,
    totalEntities: entities.reduce((s, e) => s + e.snapshotCount, 0),
    totalFinancialCents,
    paidFinancialCents,
    anomalies,
    entities,
    benchmark: {
      iterations,
      snapshotCloneAvgMs,
      normalizedRowLookupAvgMs,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  readDb()
    .then((db) => {
      const report = buildReconciliationReport(db);
      console.log(JSON.stringify(report, null, 2));
      if (report.anomalies.length > 0) {
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
