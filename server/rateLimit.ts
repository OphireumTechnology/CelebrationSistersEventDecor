import type { NextFunction, Request, Response } from 'express';
import { logStructured, observability } from './observability.ts';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAtMs: number;
  degradedFallback?: boolean;
}

export interface RateLimitConsumeOptions {
  /**
   * When true (default for authentication, MFA, recovery, and privileged endpoints),
   * distributed limiter failures fail closed with RateLimitUnavailableError (HTTP 503)
   * rather than silently degrading to process-local memory.
   */
  failClosed?: boolean;
  endpointGroup?: string;
}

export class RateLimitUnavailableError extends Error {
  readonly code = 'RATE_LIMITER_UNAVAILABLE';
  readonly retryAfterSeconds: number;

  constructor(message = 'Security rate-limiting service is temporarily unavailable.', retryAfterSeconds = 15) {
    super(message);
    this.name = 'RateLimitUnavailableError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface RateLimitStore {
  consume(
    key: string,
    maxRequests: number,
    windowMs: number,
    options?: RateLimitConsumeOptions,
  ): Promise<RateLimitResult>;
}

/**
 * Process-local rate limit store for single-instance dev/test and noncritical fallback.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  async consume(key: string, maxRequests: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      const resetAt = now + windowMs;
      this.buckets.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: Math.max(0, maxRequests - 1), resetAtMs: resetAt };
    }

    if (existing.count >= maxRequests) {
      return { allowed: false, remaining: 0, resetAtMs: existing.resetAt };
    }

    existing.count += 1;
    return {
      allowed: true,
      remaining: Math.max(0, maxRequests - existing.count),
      resetAtMs: existing.resetAt,
    };
  }
}

export interface PgQueryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface PostgresRateLimitStoreOptions {
  queryTimeoutMs?: number;
  retryAfterSecondsOnOutage?: number;
}

async function queryWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`RATE_LIMIT_DB_TIMEOUT: Query exceeded ${timeoutMs}ms`);
      (err as { code?: string }).code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Multi-replica PostgreSQL rate-limit store backed by rate_limit_buckets (migration 004).
 * Security-sensitive endpoints (`failClosed: true`) fail closed with HTTP 503 during PostgreSQL
 * outages so attackers cannot bypass distributed limits across Railway replicas.
 * Noncritical public endpoints (`failClosed: false`) degrade safely to process-local memory
 * with structured error logging and zero internal error exposure.
 */
export class PostgresRateLimitStore implements RateLimitStore {
  private readonly fallback = new InMemoryRateLimitStore();
  private readonly queryTimeoutMs: number;
  private readonly retryAfterSecondsOnOutage: number;

  constructor(
    private readonly db: PgQueryable,
    options: PostgresRateLimitStoreOptions = {},
  ) {
    this.queryTimeoutMs = options.queryTimeoutMs ?? (Number(process.env.RATE_LIMIT_DB_TIMEOUT_MS) || 3_000);
    this.retryAfterSecondsOnOutage = options.retryAfterSecondsOnOutage ?? 15;
  }

  async consume(
    key: string,
    maxRequests: number,
    windowMs: number,
    options: RateLimitConsumeOptions = {},
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const resetAt = new Date(now + windowMs);
    const startedAt = Date.now();
    try {
      const res = await queryWithTimeout(
        this.db.query<{ request_count: number; reset_at: string }>(
          `INSERT INTO rate_limit_buckets (bucket_key, request_count, reset_at)
           VALUES ($1, 1, $2)
           ON CONFLICT (bucket_key) DO UPDATE
           SET request_count = CASE
                 WHEN rate_limit_buckets.reset_at <= NOW() THEN 1
                 ELSE rate_limit_buckets.request_count + 1
               END,
               reset_at = CASE
                 WHEN rate_limit_buckets.reset_at <= NOW() THEN EXCLUDED.reset_at
                 ELSE rate_limit_buckets.reset_at
               END
           RETURNING request_count, reset_at`,
          [key, resetAt.toISOString()],
        ),
        this.queryTimeoutMs,
      );
      observability.recordDbQuery(Date.now() - startedAt, false);

      const row = res.rows[0];
      if (!row) {
        throw new Error('RATE_LIMIT_EMPTY_RESULT');
      }
      const count = Number(row.request_count);
      const resetAtMs = new Date(row.reset_at).getTime();
      return {
        allowed: count <= maxRequests,
        remaining: Math.max(0, maxRequests - count),
        resetAtMs,
      };
    } catch (err) {
      observability.recordDbQuery(Date.now() - startedAt, true);
      const errCode =
        typeof err === 'object' && err && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
          ? (err as { code: string }).code
          : 'DB_ERROR';

      logStructured('error', 'rate_limit_store_error', {
        endpointGroup: options.endpointGroup || 'general',
        failClosed: Boolean(options.failClosed),
        errorCode: errCode,
      });

      if (options.failClosed) {
        observability.recordRateLimitEvent('failClosed503');
        throw new RateLimitUnavailableError(
          'Security rate-limiting service is temporarily unavailable. Please try again shortly.',
          this.retryAfterSecondsOnOutage,
        );
      }

      observability.recordRateLimitEvent('fallback');
      const fallbackResult = await this.fallback.consume(key, maxRequests, windowMs);
      return { ...fallbackResult, degradedFallback: true };
    }
  }
}

export function resolveTrustedClientIp(req: Request): string {
  // Never trust a caller-controlled X-Forwarded-For header directly.
  // Express req.ip honors the explicitly configured `trust proxy` setting (or socket address otherwise),
  // preventing trivial header-rotation rate-limit bypasses (reconciles PR #7).
  return req.ip || req.socket?.remoteAddress || 'local';
}

export function createRateLimiter(store: RateLimitStore, enabled: boolean) {
  return function rateLimit(
    maxRequests: number,
    windowMs: number,
    options: RateLimitConsumeOptions = {},
  ) {
    return async (req: Request, res: Response, next: NextFunction) => {
      if (!enabled) return next();
      const clientIp = resolveTrustedClientIp(req);
      const key = `${clientIp}:${req.method.toUpperCase()}:${req.path}`;

      try {
        const result = await store.consume(key, maxRequests, windowMs, options);
        res.setHeader('RateLimit-Limit', String(maxRequests));
        res.setHeader('RateLimit-Remaining', String(result.remaining));
        res.setHeader('RateLimit-Reset', String(Math.ceil(result.resetAtMs / 1000)));

        if (!result.allowed) {
          observability.recordRateLimitEvent('blocked429');
          const retryAfterSec = Math.max(1, Math.ceil((result.resetAtMs - Date.now()) / 1000));
          res.setHeader('Retry-After', String(retryAfterSec));
          return res.status(429).json({
            error: 'Too many requests. Please wait a moment before trying again.',
            code: 'RATE_LIMIT_EXCEEDED',
          });
        }

        return next();
      } catch (err) {
        if (err instanceof RateLimitUnavailableError) {
          res.setHeader('Retry-After', String(err.retryAfterSeconds));
          return res.status(503).json({
            error: err.message,
            code: err.code,
            requestId: res.getHeader('X-Request-Id'),
          });
        }
        // Fail closed on unexpected limiter errors for protected endpoints; never leak raw DB details
        if (options.failClosed) {
          observability.recordRateLimitEvent('failClosed503');
          res.setHeader('Retry-After', '15');
          return res.status(503).json({
            error: 'Security rate-limiting service is temporarily unavailable. Please try again shortly.',
            code: 'RATE_LIMITER_UNAVAILABLE',
            requestId: res.getHeader('X-Request-Id'),
          });
        }
        return next();
      }
    };
  };
}
