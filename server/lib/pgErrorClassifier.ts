export interface ClassifiedDatabaseError {
  httpStatus: 403 | 409 | 503;
  code: 'FORBIDDEN' | 'SLOT_CONFLICT' | 'DATABASE_UNAVAILABLE';
  message: string;
  sqlState?: string;
}

const CONFLICT_SQLSTATES = new Set(['23P01', '23505', '40001', '40P01']);
const FORBIDDEN_SQLSTATES = new Set(['42501']);
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  '08001',
  '08003',
  '08006',
  '57P01',
  '57P02',
  '57P03',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

/**
 * Classifies PostgreSQL SQLSTATE and transport failures into safe, sanitized
 * HTTP responses without ever exposing table names, constraint details, or PII.
 */
export function classifyDatabaseError(err: unknown): ClassifiedDatabaseError | null {
  const errMsg = err instanceof Error ? err.message : '';
  const errCode =
    typeof err === 'object' && err && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code
      : '';

  if (
    errMsg.includes('PERSISTENCE_READINESS_FAILURE') ||
    errMsg.includes('DATABASE_URL is not configured') ||
    errMsg.includes('TLS_CONFIG_FAILURE') ||
    UNAVAILABLE_CODES.has(errCode)
  ) {
    return {
      httpStatus: 503,
      code: 'DATABASE_UNAVAILABLE',
      message: 'Database service is temporarily unavailable. Please try again shortly.',
      ...(errCode ? { sqlState: errCode } : {}),
    };
  }

  if (CONFLICT_SQLSTATES.has(errCode)) {
    return {
      httpStatus: 409,
      code: 'SLOT_CONFLICT',
      message: 'This consultation time slot was just reserved or modified. Please select another available studio window.',
      sqlState: errCode,
    };
  }

  if (FORBIDDEN_SQLSTATES.has(errCode)) {
    return {
      httpStatus: 403,
      code: 'FORBIDDEN',
      message: 'You are not authorized to access or modify this record.',
      sqlState: errCode,
    };
  }

  return null;
}
