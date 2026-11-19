import fs from 'node:fs/promises';
import path from 'node:path';

export interface MigrationValidationResult {
  passed: boolean;
  files: string[];
  errors: string[];
  rlsTablesChecked: number;
}

const EXPECTED_SEQUENCE = [
  '001_initial_schema.sql',
  '002_rls_policies.sql',
  '003_auth_identity.sql',
  '004_production_hardening.sql',
  '005_rls_event_planner_and_invoices.sql',
  '006_normalized_and_outbox.sql',
];

const REQUIRED_RLS_TABLES = [
  'users',
  'clients',
  'leads',
  'consultations',
  'bookings',
  'quotations',
  'quote_items',
  'contracts',
  'invoices',
  'payments',
  'messages',
  'design_concepts',
  'vendors',
  'vendor_assignments',
  'staff_assignments',
  'event_tasks',
  'inventory_reservations',
  'ai_sessions',
  'notifications',
  'audit_logs',
  'staff_vendor_invitations',
  'auth_security_events',
  'app_state_snapshots',
  'booking_idempotency_keys',
  'notification_deliveries',
  'user_mfa_factors',
  'rate_limit_buckets',
  'notification_outbox',
  'revoked_sessions',
  'user_mfa_recovery_codes',
  'payment_intents_prep',
  'payment_webhook_events',
];

export async function validateMigrationsDirectory(
  migrationsDir = path.resolve(process.cwd(), 'db', 'migrations'),
): Promise<MigrationValidationResult> {
  const entries = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const errors: string[] = [];

  for (const expected of EXPECTED_SEQUENCE) {
    if (!entries.includes(expected)) {
      errors.push(`Missing required migration file: ${expected}`);
    }
  }

  // Validate strictly ascending numeric prefixes (001, 002, ...)
  let prevNum = 0;
  let combinedSql = '';
  for (const filename of entries) {
    const match = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(filename);
    if (!match) {
      errors.push(`Invalid migration filename format: ${filename}`);
      continue;
    }
    const num = Number(match[1]);
    if (num !== prevNum + 1) {
      errors.push(`Non-contiguous migration version: expected ${String(prevNum + 1).padStart(3, '0')}, found ${filename}`);
    }
    prevNum = num;

    const sql = await fs.readFile(path.join(migrationsDir, filename), 'utf8');
    combinedSql += `\n-- FILE: ${filename}\n${sql}\n`;

    // Guard against destructive DDL statements in forward migrations
    if (/\bDROP\s+TABLE\b/i.test(sql) || /\bTRUNCATE\s+TABLE\b/i.test(sql)) {
      errors.push(`Destructive DDL (DROP TABLE / TRUNCATE TABLE) detected in forward migration ${filename}`);
    }
  }

  // Verify every sensitive table has BOTH ENABLE ROW LEVEL SECURITY and at least one CREATE POLICY
  for (const table of REQUIRED_RLS_TABLES) {
    const enablePattern = new RegExp(`ALTER\\s+TABLE\\s+${table}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i');
    const policyPattern = new RegExp(`CREATE\\s+POLICY\\s+[a-z0-9_]+\\s+ON\\s+${table}\\b`, 'i');
    if (!enablePattern.test(combinedSql)) {
      errors.push(`Missing ENABLE ROW LEVEL SECURITY for sensitive table: ${table}`);
    }
    if (!policyPattern.test(combinedSql)) {
      errors.push(`Missing CREATE POLICY coverage for RLS-enabled table: ${table}`);
    }
  }

  // Verify event_planner RLS alignment, user_roles resolution, and security_invoker view protection
  if (!/app_current_role\(\)\s+IN\s*\('admin',\s*'staff',\s*'event_planner'\)/i.test(combinedSql)) {
    errors.push('RLS policies do not include operational role event_planner.');
  }
  if (!/FROM\s+user_roles\s+ur\s+JOIN\s+roles\s+r/i.test(combinedSql)) {
    errors.push('app_current_role() must resolve authoritative roles from user_roles JOIN roles for Supabase Auth JWTs.');
  }
  if (!/ALTER\s+VIEW\s+v_vendor_booking_briefs\s+SET\s*\(\s*security_invoker\s*=\s*true\s*\)/i.test(combinedSql)) {
    errors.push('Vendor brief view v_vendor_booking_briefs is missing security_invoker = true.');
  }

  return {
    passed: errors.length === 0,
    files: entries,
    errors,
    rlsTablesChecked: REQUIRED_RLS_TABLES.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  validateMigrationsDirectory()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (!result.passed) {
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
