/**
 * Shared API transport. GitHub Pages is a static host; it cannot run Express.
 * VITE_API_BASE_URL must point to a separately deployed HTTPS backend (or localhost in dev).
 * Relative /api routes remain supported for local development or same-origin hosting.
 */

export interface ApiEnvConfig {
  apiBaseUrl?: string;
  baseUrl?: string;
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
      parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
    if (parsed.protocol === 'https:' || (isLocalhost && parsed.protocol === 'http:')) {
      return `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}`.replace(/\/+$/, '');
    }
    return '';
  } catch {
    return '';
  }
}

export function resolveApiEnvironment(env?: ApiEnvConfig) {
  const rawBase =
    env?.apiBaseUrl !== undefined
      ? env.apiBaseUrl
      : typeof import.meta !== 'undefined'
        ? import.meta.env?.VITE_API_BASE_URL
        : '';
  const viteBase =
    env?.baseUrl !== undefined
      ? env.baseUrl
      : typeof import.meta !== 'undefined'
        ? import.meta.env?.BASE_URL ?? '/'
        : '/';

  const configuredApiBase = sanitizeApiBaseUrl(rawBase);
  const onStaticPages = viteBase !== '/';
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
  return new Response(
    JSON.stringify({
      error:
        'Online booking, AI and account services are temporarily unavailable. Please contact Celebration Sisters directly until secure backend hosting is connected.',
      code: 'BACKEND_NOT_CONFIGURED',
    }),
    { status: 503, headers: { 'Content-Type': 'application/json' } },
  );
}

export async function readApiJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    return {} as T;
  }
}

export function apiFetch(
  path: string,
  init?: RequestInit,
  envOverride?: ApiEnvConfig,
): Promise<Response> {
  if (!path.startsWith('/api/')) {
    throw new Error('API requests must begin with /api/');
  }

  const resolved = envOverride ? resolveApiEnvironment(envOverride) : runtimeConfig;

  if (!resolved.backendConfigured) {
    return Promise.resolve(buildApiResponseNotConfigured());
  }

  const headers = new Headers(init?.headers || {});
  if (!headers.has('X-Requested-With')) {
    headers.set('X-Requested-With', 'XMLHttpRequest');
  }
  if (activeAccessToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${activeAccessToken}`);
  }
  const method = (init?.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !headers.has('X-CSRF-Token')) {
    const csrfToken = activeCsrfToken || readCookieValue('cs_csrf');
    if (csrfToken) {
      headers.set('X-CSRF-Token', csrfToken);
    }
  }

  return fetch(`${resolved.configuredApiBase}${path}`, {
    credentials: 'include',
    ...init,
    headers,
  });
}
