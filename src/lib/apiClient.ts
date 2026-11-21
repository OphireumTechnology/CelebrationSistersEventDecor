/**
 * Shared API transport for Celebration Sisters Event Decor.
 * GitHub Pages is a static host; it cannot run Express.
 * VITE_API_BASE_URL must point to a separately deployed HTTPS backend (or localhost in dev).
 * Relative /api routes remain supported for local development or same-origin hosting.
 */

export interface ApiEnvConfig {
  apiBaseUrl?: string;
  baseUrl?: string;
  staticPagesBuild?: boolean;
  hostname?: string;
}

export interface ApiFetchInit extends RequestInit {
  /** Optional coordinated client-side timeout in milliseconds using AbortController. */
  timeoutMs?: number;
}

export interface ParsedApiError {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  requestId?: string;
}

const STATIC_PAGES_HOSTNAMES = new Set([
  'celebrationsistersdecor.com',
  'www.celebrationsistersdecor.com',
]);

export function isStaticPagesHostname(hostname: string | undefined): boolean {
  const normalized = (hostname || '').trim().toLowerCase();
  if (!normalized) return false;
  return STATIC_PAGES_HOSTNAMES.has(normalized) || normalized.endsWith('.github.io');
}

let activeAccessToken: string | null = null;
let activeCsrfToken: string | null = null;

export function setApiAccessToken(token: string | null): void {
  activeAccessToken = token && token.trim().length > 0 ? token.trim() : null;
}

export function setApiCsrfToken(token: string | null): void {
  activeCsrfToken = token && token.trim().length > 0 ? token.trim() : null;
}

export function readCookieValue(name: string): string | null {
  if (typeof document === 'undefined' || !document.cookie) return null;
  const parts = document.cookie.split(';');
  for (const rawPart of parts) {
    const idx = rawPart.indexOf('=');
    if (idx <= 0) continue;
    const key = rawPart.slice(0, idx).trim();
    if (key === name) {
      return decodeURIComponent(rawPart.slice(idx + 1).trim());
    }
  }
  return null;
}

export function sanitizeApiBaseUrl(rawUrl: string | undefined): string {
  const trimmed = (rawUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    const isLocalhost =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '::1';
    if (parsed.protocol === 'https:' || (isLocalhost && parsed.protocol === 'http:')) {
      return `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}`.replace(/\/+$/, '');
    }
    return '';
  } catch {
    return '';
  }
}

export function resolveApiEnvironment(env?: ApiEnvConfig) {
  const metaEnv =
    typeof import.meta !== 'undefined' &&
    typeof (import.meta as { env?: Record<string, string | undefined> }).env === 'object'
      ? (import.meta as { env: Record<string, string | undefined> }).env
      : {};

  const rawBase = env?.apiBaseUrl !== undefined ? env.apiBaseUrl : metaEnv.VITE_API_BASE_URL || '';
  const viteBase = env?.baseUrl !== undefined ? env.baseUrl : metaEnv.BASE_URL ?? '/';
  const staticPagesBuild =
    env?.staticPagesBuild !== undefined
      ? env.staticPagesBuild
      : metaEnv.VITE_GITHUB_PAGES === 'true';
  const runtimeHostname =
    env?.hostname !== undefined
      ? env.hostname
      : typeof window !== 'undefined' && window.location
        ? window.location.hostname
        : '';

  const configuredApiBase = sanitizeApiBaseUrl(rawBase);
  const onStaticPages =
    viteBase !== '/' || staticPagesBuild || isStaticPagesHostname(runtimeHostname);
  const backendConfigured = !onStaticPages || Boolean(configuredApiBase);

  return {
    configuredApiBase,
    onStaticPages,
    backendConfigured,
  };
}

const runtimeConfig = resolveApiEnvironment();
export const isBackendConfigured = runtimeConfig.backendConfigured;

export function buildApiResponseNotConfigured(): Response {
  const message =
    'Online booking, AI and account services are temporarily unavailable. Please contact Celebration Sisters directly until secure backend hosting is connected.';
  return new Response(
    JSON.stringify({
      success: false,
      error: message,
      code: 'BACKEND_NOT_CONFIGURED',
      retryable: false,
      errorDetail: {
        code: 'BACKEND_NOT_CONFIGURED',
        message,
        retryable: false,
      },
    }),
    { status: 503, headers: { 'Content-Type': 'application/json' } },
  );
}

function buildApiResponseTimeout(timeoutMs: number): Response {
  const message =
    'The server took longer than expected to respond. Your details are preserved — please click Retry in a moment.';
  return new Response(
    JSON.stringify({
      success: false,
      error: message,
      code: 'REQUEST_TIMEOUT',
      retryable: true,
      timeoutMs,
      errorDetail: {
        code: 'REQUEST_TIMEOUT',
        message,
        retryable: true,
      },
    }),
    { status: 504, headers: { 'Content-Type': 'application/json' } },
  );
}

export async function readApiJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    return {} as T;
  }
}

export async function parseApiErrorResponse(
  res: Response,
  fallbackMessage = 'Unable to complete your request right now. Please try again.',
): Promise<ParsedApiError> {
  const headerRequestId = res.headers?.get?.('X-Request-Id') || undefined;
  const headerRetryAfterRaw = res.headers?.get?.('Retry-After');
  const headerRetryAfter =
    headerRetryAfterRaw && Number.isFinite(Number(headerRetryAfterRaw))
      ? Number(headerRetryAfterRaw)
      : undefined;

  const body = await readApiJson<Record<string, unknown>>(res);
  const detail =
    body.errorDetail && typeof body.errorDetail === 'object'
      ? (body.errorDetail as Record<string, unknown>)
      : body.error && typeof body.error === 'object'
        ? (body.error as Record<string, unknown>)
        : null;

  const message =
    (typeof detail?.message === 'string' && detail.message.trim()) ||
    (typeof body.error === 'string' && body.error.trim()) ||
    (typeof body.message === 'string' && body.message.trim()) ||
    fallbackMessage;

  const code =
    (typeof detail?.code === 'string' && detail.code.trim()) ||
    (typeof body.code === 'string' && body.code.trim()) ||
    (res.status === 401
      ? 'AUTH_REQUIRED'
      : res.status === 403
        ? 'FORBIDDEN'
        : res.status === 429
          ? 'AI_PROVIDER_RATE_LIMITED'
          : res.status === 503
            ? 'SERVICE_UNAVAILABLE'
            : res.status === 504
              ? 'REQUEST_TIMEOUT'
              : 'API_ERROR');

  const retryable =
    typeof detail?.retryable === 'boolean'
      ? detail.retryable
      : typeof body.retryable === 'boolean'
        ? body.retryable
        : res.status === 429 || res.status === 503 || res.status === 504;

  const retryAfterSeconds =
    typeof detail?.retryAfterSeconds === 'number'
      ? detail.retryAfterSeconds
      : typeof body.retryAfterSeconds === 'number'
        ? body.retryAfterSeconds
        : headerRetryAfter;

  const requestId =
    (typeof body.requestId === 'string' && body.requestId.trim()) || headerRequestId;

  return {
    status: res.status,
    code,
    message,
    retryable,
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

export function apiFetch(
  path: string,
  init?: ApiFetchInit,
  envOverride?: ApiEnvConfig,
): Promise<Response> {
  if (!path.startsWith('/api/')) {
    throw new Error('API requests must begin with /api/');
  }

  const resolved = envOverride ? resolveApiEnvironment(envOverride) : runtimeConfig;
  if (!resolved.backendConfigured) {
    return Promise.resolve(buildApiResponseNotConfigured());
  }

  const { timeoutMs, signal: externalSignal, ...restInit } = init || {};
  const headers = new Headers(restInit.headers || {});
  if (!headers.has('X-Requested-With')) {
    headers.set('X-Requested-With', 'XMLHttpRequest');
  }
  if (activeAccessToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${activeAccessToken}`);
  }
  const method = (restInit.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !headers.has('X-CSRF-Token')) {
    const csrfToken = activeCsrfToken || readCookieValue('cs_csrf');
    if (csrfToken) {
      headers.set('X-CSRF-Token', csrfToken);
    }
  }

  const targetUrl = `${resolved.configuredApiBase}${path}`;
  if (!timeoutMs || timeoutMs <= 0) {
    return fetch(targetUrl, {
      credentials: 'include',
      ...restInit,
      ...(externalSignal ? { signal: externalSignal } : {}),
      headers,
    });
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  return fetch(targetUrl, {
    credentials: 'include',
    ...restInit,
    signal: controller.signal,
    headers,
  })
    .catch((err) => {
      if (timedOut) {
        return buildApiResponseTimeout(timeoutMs);
      }
      throw err;
    })
    .finally(() => {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    });
}
