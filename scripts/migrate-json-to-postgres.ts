import fs from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSchema } from '../server/store.ts';
import { toArchitecturalStage } from '../src/types/lifecycle.ts';

export interface MigrationReport {
  mode: 'dry-run' | 'execute';
  sourcePath: string;
  backupPath: string | null;
  recordCounts: {
    users: number;
    bookings: number;
    quotations: number;
    contracts: number;
    payments: number;
    designConcepts: number;
    vendors: number;
    staffChecklists: number;
    inventoryItems: number;
    aiSessions: number;
    auditLogs: number;
  };
  integrityChecks: {
    passed: boolean;
    warnings: string[];
    errors: string[];
  };
  lifecycleReconciliation: {
    referenceCode: string;
    legacyStatus: string;
    architecturalStage: string;
  }[];
}

export async function runJsonToPostgresMigrationAudit(options?: {
  sourcePath?: string;
  createBackup?: boolean;
  backupDir?: string;
  dryRun?: boolean;
}): Promise<MigrationReport> {
  const dryRun = options?.dryRun ?? true;
  const sourcePath = options?.sourcePath ?? path.resolve(process.cwd(), 'data', 'db.json');

  if (!dryRun) {
    throw new Error(
      'LIVE_MIGRATION_BLOCKED: Production database migration execution requires explicit owner approval and DATABASE_URL.',
    );
  }

  const raw = await fs.readFile(sourcePath, 'utf8');
  const db = JSON.parse(raw) as DatabaseSchema;

  const warnings: string[] = [];
  const errors: string[] = [];

  const userIds = new Set((db.users || []).map((u) => u.id));
  const bookingIds = new Set((db.bookings || []).map((b) => b.id));

  for (const b of db.bookings || []) {
    if (!userIds.has(b.clientId)) {
      errors.push(`Referential integrity error: Booking ${b.referenceCode} references missing clientId ${b.clientId}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.eventDate)) {
      errors.push(`Schema validation error: Booking ${b.referenceCode} has invalid eventDate "${b.eventDate}"`);
    }
    if (b.guestCount < 10) {
      warnings.push(`Booking ${b.referenceCode} guestCount (${b.guestCount}) is below minimum guideline.`);
    }
  }

  for (const c of db.concepts || []) {
    if (!userIds.has(c.clientId)) {
      errors.push(`Referential integrity error: Concept ${c.id} references missing clientId ${c.clientId}`);
    }
    if (c.bookingId && !bookingIds.has(c.bookingId)) {
      warnings.push(`Concept ${c.id} references non-existent bookingId ${c.bookingId}.`);
    }
  }

  let backupPath: string | null = null;
  if (options?.createBackup) {
    const backupDir = options.backupDir ?? path.resolve(process.cwd(), 'data', 'backups');
    await fs.mkdir(backupDir, { recursive: true });
    backupPath = path.resolve(backupDir, `db.backup.${Date.now()}.json`);
    await fs.writeFile(backupPath, raw, 'utf8');
  }

  const quotationsCount = (db.bookings || []).reduce((acc, b) => acc + (b.quotations?.length || 0), 0);
  const paymentsCount = (db.bookings || []).reduce((acc, b) => acc + (b.payments?.length || 0), 0);

  return {
    mode: 'dry-run',
    sourcePath,
    backupPath,
    recordCounts: {
      users: (db.users || []).length,
      bookings: (db.bookings || []).length,
      quotations: quotationsCount,
      contracts: (db.bookings || []).filter((b) => Boolean(b.contract)).length,
      payments: paymentsCount,
      designConcepts: (db.concepts || []).length,
      vendors: (db.vendors || []).length,
      staffChecklists: (db.staffChecklists || []).length,
      inventoryItems: (db.inventory || []).length,
      aiSessions: (db.aiSessions || []).length,
      auditLogs: (db.auditLogs || []).length,
    },
    integrityChecks: {
      passed: errors.length === 0,
      warnings,
      errors,
    },
    lifecycleReconciliation: (db.bookings || []).map((b) => ({
      referenceCode: b.referenceCode,
      legacyStatus: b.status,
      architecturalStage: toArchitecturalStage(b.status, b.architecturalStage as never),
    })),
  };
}

// Allow CLI execution: npx tsx scripts/migrate-json-to-postgres.ts --dry-run
if (import.meta.url === `file://${process.argv[1]}`) {
  runJsonToPostgresMigrationAudit({ dryRun: true, createBackup: false })
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      if (!report.integrityChecks.passed) process.exit(1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
