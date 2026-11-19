import type { NextFunction, Request, Response } from 'express';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAtMs: number;
}

export interface RateLimitStore {
  consume(key: string, maxRequests: number, windowMs: number): Promise<RateLimitResult>;
}

/**
 * Process-local rate limit store for single-instance dev/test.
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

/**
 * Multi-replica PostgreSQL rate-limit store backed by rate_limit_buckets (migration 004).
 * Falls back cleanly to in-memory limiter if the rate-limit table is unavailable.
 */
export class PostgresRateLimitStore implements RateLimitStore {
  private readonly fallback = new InMemoryRateLimitStore();

  constructor(private readonly db: PgQueryable) {}

  async consume(key: string, maxRequests: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const resetAt = new Date(now + windowMs);
    try {
      const res = await this.db.query<{ request_count: number; reset_at: string }>(
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
      );

      const row = res.rows[0];
      if (!row) {
        return this.fallback.consume(key, maxRequests, windowMs);
      }
      const count = Number(row.request_count);
      const resetAtMs = new Date(row.reset_at).getTime();
      return {
        allowed: count <= maxRequests,
        remaining: Math.max(0, maxRequests - count),
        resetAtMs,
      };
    } catch {
      return this.fallback.consume(key, maxRequests, windowMs);
    }
  }
}

export function createRateLimiter(store: RateLimitStore, enabled: boolean) {
  return function rateLimit(maxRequests: number, windowMs: number) {
    return async (req: Request, res: Response, next: NextFunction) => {
      if (!enabled) return next();
      const forwarded = (req.header('x-forwarded-for') || '').split(',')[0]?.trim();
      const clientIp = forwarded || req.ip || 'local';
      const key = `${clientIp}:${req.method}:${req.path}`;

      const result = await store.consume(key, maxRequests, windowMs);
      res.setHeader('RateLimit-Limit', String(maxRequests));
      res.setHeader('RateLimit-Remaining', String(result.remaining));
      res.setHeader('RateLimit-Reset', String(Math.ceil(result.resetAtMs / 1000)));

      if (!result.allowed) {
        const retryAfterSec = Math.max(1, Math.ceil((result.resetAtMs - Date.now()) / 1000));
        res.setHeader('Retry-After', String(retryAfterSec));
        return res.status(429).json({
          error: 'Too many requests. Please wait a moment before trying again.',
          code: 'RATE_LIMIT_EXCEEDED',
        });
      }

      return next();
    };
  };
}
