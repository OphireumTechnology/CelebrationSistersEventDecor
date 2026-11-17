/**
 * Production PostgreSQL / Supabase Repository Adapter & Startup Readiness Guard.
 * Ensures production deployments NEVER silently fall back to local JSON persistence.
 */

export interface PersistenceReadinessStatus {
  adapter: 'json-local' | 'postgres';
  ready: boolean;
  reason: string;
}

export function getPersistenceStatus(): PersistenceReadinessStatus {
  const isProd = process.env.NODE_ENV === 'production';
  const adapterPref = (process.env.PERSISTENCE_ADAPTER || (isProd ? 'postgres' : 'json-local')).toLowerCase();
  const hasDatabaseUrl = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0);

  if (adapterPref === 'postgres') {
    if (!hasDatabaseUrl) {
      return {
        adapter: 'postgres',
        ready: false,
        reason: 'PERSISTENCE_ADAPTER=postgres requires DATABASE_URL to be configured.',
      };
    }
    return {
      adapter: 'postgres',
      ready: true,
      reason: 'PostgreSQL connection string configured; migrations 001 and 002 ready for execution.',
    };
  }

  if (isProd) {
    return {
      adapter: 'json-local',
      ready: false,
      reason: 'Local JSON persistence is prohibited in production mode. Configure PostgreSQL (DATABASE_URL).',
    };
  }

  return {
    adapter: 'json-local',
    ready: true,
    reason: 'Isolated local development / test JSON transactional store active.',
  };
}

export function assertPersistenceReady(): void {
  const status = getPersistenceStatus();
  if (!status.ready) {
    throw new Error(`PERSISTENCE_READINESS_FAILURE: ${status.reason}`);
  }
}
