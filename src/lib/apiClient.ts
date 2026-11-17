/**
 * Shared API transport. GitHub Pages is a static host; it cannot run Express.
 * VITE_API_BASE_URL must point to a separately deployed HTTPS backend.
 * Relative /api routes remain supported for local development or same-origin hosting.
 */
const configuredApiBase = (import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');
const onStaticPages = import.meta.env.BASE_URL !== '/';

export const isBackendConfigured = !onStaticPages || Boolean(configuredApiBase);

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!path.startsWith('/api/')) {
    throw new Error('API requests must begin with /api/');
  }

  if (!isBackendConfigured) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          error: 'Online booking, AI and account services are temporarily unavailable. Please contact Celebration Sisters directly until secure backend hosting is connected.',
          code: 'BACKEND_NOT_CONFIGURED',
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      ),
    );
  }

  return fetch(`${configuredApiBase}${path}`, init);
}
