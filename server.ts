import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './server/app.ts';
import { getAllowedOrigins } from './server/authz.ts';
import { getGeminiConfigStatus } from './server/gemini.ts';
import { getIdentityProviderStatus } from './server/identityProvider.ts';
import { getEmailProviderStatus } from './server/notifications.ts';
import { logStructured } from './server/observability.ts';
import { NotificationOutboxWorker } from './server/outbox.ts';
import {
  assertPersistenceReady,
  checkPersistenceHealth,
  closePgPool,
  getPersistenceStatus,
} from './server/repositories/postgresRepository.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

export function validateProductionStartupConfig(): void {
  const isProd = process.env.NODE_ENV === 'production';
  assertPersistenceReady();

  if (isProd) {
    if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.trim().length < 24) {
      throw new Error(
        'STARTUP_CONFIG_FAILURE: SESSION_SECRET (minimum 24 characters) is required in production.',
      );
    }
  }
}

export function resolveDistDirectory(): string {
  // Supports running from both root (tsx server.ts) and compiled dist-server/server.mjs
  const candidates = [
    path.resolve(__dirname, 'dist'),
    path.resolve(__dirname, '..', 'dist'),
    path.resolve(process.cwd(), 'dist'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      return dir;
    }
  }
  return candidates[0];
}

function logSafeStartupDiagnostics(distPath: string): void {
  const persistence = getPersistenceStatus();
  const identity = getIdentityProviderStatus();
  const email = getEmailProviderStatus();
  const ai = getGeminiConfigStatus();

  logStructured('info', 'server_startup_diagnostics', {
    service: 'Celebration Sisters Event Decor Platform',
    nodeEnv: process.env.NODE_ENV || 'development',
    port: PORT,
    persistenceAdapter: persistence.adapter,
    persistenceConfigReady: persistence.ready,
    identityProvider: identity.provider,
    supabaseReady: identity.readyForProductionAuth,
    emailProvider: email.provider,
    emailLiveEnabled: email.liveDeliveryEnabled,
    aiConfigured: ai.configured,
    aiModel: ai.model,
    aiModelSource: ai.modelSource,
    aiTimeoutMs: ai.timeoutMs,
    aiMaxRetries: ai.maxRetries,
    allowedOriginsCount: getAllowedOrigins().length,
    staticFrontendPresent: fs.existsSync(path.join(distPath, 'index.html')),
  });
  if (ai.modelWarning) {
    logStructured('warn', 'ai_model_configuration_warning', {
      model: ai.model,
      warning: ai.modelWarning,
    });
  }
}

async function startServer() {
  validateProductionStartupConfig();

  const persistenceCheck = await checkPersistenceHealth();
  if (process.env.NODE_ENV === 'production' && !persistenceCheck.ready) {
    logStructured('error', 'startup_database_readiness_warning', {
      adapter: persistenceCheck.adapter,
      reason: persistenceCheck.reason,
    });
  }

  const outboxWorker = new NotificationOutboxWorker();
  const app = createApp({ enableRateLimit: true, outboxWorker });
  const distPath = resolveDistDirectory();

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    // Ensure unknown /api/* routes return structured JSON 404 rather than index.html
    app.use('/api', (_req, res) => {
      res.status(404).json({ error: 'API endpoint not found.', code: 'NOT_FOUND' });
    });
    app.get('*', (_req, res) => {
      const indexFile = path.join(distPath, 'index.html');
      if (fs.existsSync(indexFile)) {
        return res.sendFile(indexFile);
      }
      return res.status(404).json({ error: 'Frontend bundle not present on API-only deployment.' });
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    logSafeStartupDiagnostics(distPath);
    console.log(`Celebration Sisters Event Decor server listening on http://0.0.0.0:${PORT}`);
  });

  // Node requestTimeout limits receipt of the inbound HTTP request.
  const aiConfig = getGeminiConfigStatus();
  const aiTimeoutMs = Math.max(
    aiConfig.timeoutMs,
    aiConfig.conciergeTimeoutMs,
    aiConfig.conceptTimeoutMs,
  );
  const minRecommendedHttpTimeoutMs = Math.max(75_000, aiTimeoutMs + 20_000);
  const configuredHttpTimeoutMs = Number(process.env.HTTP_REQUEST_TIMEOUT_MS);
  const effectiveHttpRequestTimeoutMs =
    Number.isFinite(configuredHttpTimeoutMs) && configuredHttpTimeoutMs >= 10_000
      ? Math.max(configuredHttpTimeoutMs, aiTimeoutMs + 10_000)
      : minRecommendedHttpTimeoutMs;
  if (Number.isFinite(configuredHttpTimeoutMs) && configuredHttpTimeoutMs < aiTimeoutMs + 10_000) {
    logStructured('warn', 'http_request_timeout_adjusted_for_ai', {
      configuredHttpTimeoutMs,
      aiTimeoutMs,
      effectiveHttpRequestTimeoutMs,
    });
  }
  server.requestTimeout = effectiveHttpRequestTimeoutMs;
  server.headersTimeout = Number(process.env.HTTP_HEADERS_TIMEOUT_MS) || 35_000;
  server.keepAliveTimeout = Number(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS) || 65_000;

  if (process.env.DISABLE_OUTBOX_POLLING !== 'true') {
    outboxWorker.startPolling(Number(process.env.OUTBOX_POLL_INTERVAL_MS) || 15_000);
  }

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logStructured('info', 'server_shutdown_initiated', { signal });
    outboxWorker.stop();

    const forceTimer = setTimeout(() => {
      logStructured('error', 'server_shutdown_forced', { signal });
      process.exit(1);
    }, 10_000);
    forceTimer.unref();

    server.close(async () => {
      try {
        await closePgPool();
        clearTimeout(forceTimer);
        logStructured('info', 'server_shutdown_complete', { signal });
        process.exit(0);
      } catch {
        clearTimeout(forceTimer);
        process.exit(1);
      }
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const isDirectEntry =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  startServer().catch((err) => {
    logStructured('error', 'server_startup_failed', {
      error: err instanceof Error ? err.message : 'Unknown startup error',
    });
    process.exit(1);
  });
}
