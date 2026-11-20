/**
 * Structured Observability, Secret Redaction & Operational Metrics (Blocks 13.12 & 13.15).
 * Never logs raw tokens, passwords, TOTP secrets, API keys, or cookies.
 */

const SENSITIVE_KEY_PATTERN =
  /(secret|token|password|passwd|authorization|cookie|api[-_]?key|totp|recovery|private[-_]?key|connectionstring|database_url|email)/i;

const SECRET_VALUE_PATTERN =
  /(Bearer\s+[A-Za-z0-9._~+/-]+=*|postgres(?:ql)?:\/\/[^@\s]+@|re_[A-Za-z0-9]{12,}|AIzaSy[A-Za-z0-9_-]{20,}|whsec_[A-Za-z0-9]{10,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/gi;

export function redactStringValue(input: string): string {
  return input.replace(SECRET_VALUE_PATTERN, '[REDACTED]');
}

const SAFE_OPERATIONAL_DIAGNOSTIC_KEYS = new Set([
  'emailProvider',
  'emailLiveEnabled',
  'emailConfigured',
  'emailVerified',
]);

export function redactSensitiveFields<T>(value: T, depth = 0): T {
  if (depth > 6 || value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return redactStringValue(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveFields(item, depth + 1)) as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!SAFE_OPERATIONAL_DIAGNOSTIC_KEYS.has(k) && SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactSensitiveFields(v, depth + 1);
      }
    }
    return out as T;
  }
  return value;
}

export type LogLevel = 'info' | 'warn' | 'error';

export function logStructured(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): string {
  const safePayload = redactSensitiveFields({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  const serialized = JSON.stringify(safePayload);
  if (process.env.SUPPRESS_STRUCTURED_LOGS !== 'true') {
    if (level === 'error') {
      console.error(serialized);
    } else if (level === 'warn') {
      console.warn(serialized);
    } else {
      console.info(serialized);
    }
  }
  return serialized;
}

export interface OperationalMetricsSnapshot {
  startedAt: string;
  uptimeSeconds: number;
  http: {
    totalRequests: number;
    error4xxCount: number;
    error5xxCount: number;
    errorRatePercent: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
  };
  database: {
    queryCount: number;
    errorCount: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
  };
  bookings: {
    attempts: number;
    succeeded: number;
    failed: number;
    failureRatePercent: number;
  };
  notifications: {
    enqueued: number;
    accepted: number;
    delivered: number;
    failed: number;
    deadLettered: number;
    lastWorkerHeartbeatAt: string | null;
    workerHealthy: boolean;
  };
  ai: {
    requests: number;
    failures: number;
    timeouts: number;
    avgLatencyMs: number;
  };
  rateLimiter: {
    blocked429: number;
    failClosed503: number;
    fallbackEvents: number;
  };
  webhooks: {
    received: number;
    reconciled: number;
    deduplicated: number;
    rejectedSignature: number;
    unconfigured503: number;
  };
  auth: {
    unauthorized401: number;
    forbidden403: number;
    mfaRequired403: number;
    invalidConsultationToken403: number;
  };
}

function pushSample(arr: number[], value: number, maxSamples = 200): void {
  arr.push(Math.max(0, value));
  if (arr.length > maxSamples) {
    arr.shift();
  }
}

function summarizeSamples(samples: number[]): { avg: number; p95: number } {
  if (samples.length === 0) return { avg: 0, p95: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, n) => acc + n, 0);
  const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return {
    avg: Number((sum / sorted.length).toFixed(2)),
    p95: Number(sorted[p95Index].toFixed(2)),
  };
}

export class ObservabilityMetrics {
  private readonly startedAtMs = Date.now();
  private totalRequests = 0;
  private error4xx = 0;
  private error5xx = 0;
  private httpLatencies: number[] = [];

  private dbQueries = 0;
  private dbErrors = 0;
  private dbLatencies: number[] = [];

  private bookingAttempts = 0;
  private bookingSucceeded = 0;
  private bookingFailed = 0;

  private ntfEnqueued = 0;
  private ntfAccepted = 0;
  private ntfDelivered = 0;
  private ntfFailed = 0;
  private ntfDeadLettered = 0;
  private lastWorkerHeartbeatAt: string | null = null;

  private aiRequests = 0;
  private aiFailures = 0;
  private aiTimeouts = 0;
  private aiLatencies: number[] = [];

  private rateBlocked429 = 0;
  private rateFailClosed503 = 0;
  private rateFallbackEvents = 0;

  private webhookReceived = 0;
  private webhookReconciled = 0;
  private webhookDeduplicated = 0;
  private webhookRejectedSignature = 0;
  private webhookUnconfigured503 = 0;

  private authUnauthorized401 = 0;
  private authForbidden403 = 0;
  private authMfaRequired403 = 0;
  private authInvalidConsultationToken403 = 0;

  recordHttpRequest(statusCode: number, durationMs: number): void {
    this.totalRequests += 1;
    if (statusCode >= 500) this.error5xx += 1;
    else if (statusCode >= 400) this.error4xx += 1;
    pushSample(this.httpLatencies, durationMs);
  }

  recordDbQuery(durationMs: number, failed = false): void {
    this.dbQueries += 1;
    if (failed) this.dbErrors += 1;
    pushSample(this.dbLatencies, durationMs);
  }

  recordBookingOutcome(succeeded: boolean): void {
    this.bookingAttempts += 1;
    if (succeeded) this.bookingSucceeded += 1;
    else this.bookingFailed += 1;
  }

  recordNotificationEnqueued(count = 1): void {
    this.ntfEnqueued += count;
  }

  recordNotificationOutcome(outcome: 'accepted' | 'delivered' | 'failed' | 'dead_letter'): void {
    if (outcome === 'accepted') this.ntfAccepted += 1;
    else if (outcome === 'delivered') this.ntfDelivered += 1;
    else if (outcome === 'failed') this.ntfFailed += 1;
    else if (outcome === 'dead_letter') this.ntfDeadLettered += 1;
  }

  recordWorkerHeartbeat(): void {
    this.lastWorkerHeartbeatAt = new Date().toISOString();
  }

  recordAiCall(durationMs: number, outcome: 'ok' | 'timeout' | 'error'): void {
    this.aiRequests += 1;
    if (outcome === 'timeout') {
      this.aiTimeouts += 1;
      this.aiFailures += 1;
    } else if (outcome === 'error') {
      this.aiFailures += 1;
    }
    pushSample(this.aiLatencies, durationMs);
  }

  recordRateLimitEvent(event: 'blocked429' | 'failClosed503' | 'fallback'): void {
    if (event === 'blocked429') this.rateBlocked429 += 1;
    else if (event === 'failClosed503') this.rateFailClosed503 += 1;
    else if (event === 'fallback') this.rateFallbackEvents += 1;
  }

  recordWebhookEvent(
    event: 'received' | 'reconciled' | 'deduplicated' | 'rejectedSignature' | 'unconfigured503',
  ): void {
    if (event === 'received') this.webhookReceived += 1;
    else if (event === 'reconciled') this.webhookReconciled += 1;
    else if (event === 'deduplicated') this.webhookDeduplicated += 1;
    else if (event === 'rejectedSignature') this.webhookRejectedSignature += 1;
    else if (event === 'unconfigured503') this.webhookUnconfigured503 += 1;
  }

  recordAuthFailure(
    kind: 'unauthorized401' | 'forbidden403' | 'mfaRequired403' | 'invalidConsultationToken403',
  ): void {
    if (kind === 'unauthorized401') this.authUnauthorized401 += 1;
    else if (kind === 'forbidden403') this.authForbidden403 += 1;
    else if (kind === 'mfaRequired403') this.authMfaRequired403 += 1;
    else if (kind === 'invalidConsultationToken403') this.authInvalidConsultationToken403 += 1;
  }

  getSnapshot(): OperationalMetricsSnapshot {
    const httpSummary = summarizeSamples(this.httpLatencies);
    const dbSummary = summarizeSamples(this.dbLatencies);
    const aiSummary = summarizeSamples(this.aiLatencies);
    const workerHealthy = this.lastWorkerHeartbeatAt
      ? Date.now() - new Date(this.lastWorkerHeartbeatAt).getTime() < 120_000
      : true;

    return {
      startedAt: new Date(this.startedAtMs).toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAtMs) / 1000),
      http: {
        totalRequests: this.totalRequests,
        error4xxCount: this.error4xx,
        error5xxCount: this.error5xx,
        errorRatePercent:
          this.totalRequests > 0 ? Number(((this.error5xx / this.totalRequests) * 100).toFixed(2)) : 0,
        avgLatencyMs: httpSummary.avg,
        p95LatencyMs: httpSummary.p95,
      },
      database: {
        queryCount: this.dbQueries,
        errorCount: this.dbErrors,
        avgLatencyMs: dbSummary.avg,
        p95LatencyMs: dbSummary.p95,
      },
      bookings: {
        attempts: this.bookingAttempts,
        succeeded: this.bookingSucceeded,
        failed: this.bookingFailed,
        failureRatePercent:
          this.bookingAttempts > 0 ? Number(((this.bookingFailed / this.bookingAttempts) * 100).toFixed(2)) : 0,
      },
      notifications: {
        enqueued: this.ntfEnqueued,
        accepted: this.ntfAccepted,
        delivered: this.ntfDelivered,
        failed: this.ntfFailed,
        deadLettered: this.ntfDeadLettered,
        lastWorkerHeartbeatAt: this.lastWorkerHeartbeatAt,
        workerHealthy,
      },
      ai: {
        requests: this.aiRequests,
        failures: this.aiFailures,
        timeouts: this.aiTimeouts,
        avgLatencyMs: aiSummary.avg,
      },
      rateLimiter: {
        blocked429: this.rateBlocked429,
        failClosed503: this.rateFailClosed503,
        fallbackEvents: this.rateFallbackEvents,
      },
      webhooks: {
        received: this.webhookReceived,
        reconciled: this.webhookReconciled,
        deduplicated: this.webhookDeduplicated,
        rejectedSignature: this.webhookRejectedSignature,
        unconfigured503: this.webhookUnconfigured503,
      },
      auth: {
        unauthorized401: this.authUnauthorized401,
        forbidden403: this.authForbidden403,
        mfaRequired403: this.authMfaRequired403,
        invalidConsultationToken403: this.authInvalidConsultationToken403,
      },
    };
  }
}

export const observability = new ObservabilityMetrics();
