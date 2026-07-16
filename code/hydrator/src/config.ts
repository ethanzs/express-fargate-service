import { toInt } from '@app/shared';

/**
 * Centralized, validated runtime configuration.
 * Reads from environment variables so the same image runs in any environment
 * (12-factor). On Fargate these come from the EventBridge-scheduled task
 * definition.
 */

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  // Stable identifier attached to every log line (a dimension for dashboards).
  serviceName: process.env.SERVICE_NAME ?? 'hydrator-service',
  // Release version baked into the image by the release build; 'dev' locally.
  serviceVersion: process.env.SERVICE_VERSION ?? 'dev',
  logLevel: process.env.LOG_LEVEL ?? 'info',

  // Hard wall-clock cap on a single run. EventBridge starts the next run on
  // schedule regardless, so a hung run must die rather than pile up tasks.
  jobTimeoutMs: toInt(process.env.JOB_TIMEOUT_MS, 300_000),

  /**
   * RDS Postgres. Two auth modes:
   *  - 'password' (default, local dev): DATABASE_URL carries everything.
   *  - 'iam' (AWS): no credential at all — DB_HOST/PORT/NAME/USER plus a
   *    short-lived token minted per connection via the task role (db.ts).
   */
  database: {
    authMode: process.env.DB_AUTH ?? 'password',
    url: process.env.DATABASE_URL ?? '',
    host: process.env.DB_HOST ?? '',
    port: toInt(process.env.DB_PORT, 5432),
    name: process.env.DB_NAME ?? '',
    user: process.env.DB_USER ?? '',
    connectTimeoutMs: toInt(process.env.DB_CONNECT_TIMEOUT_MS, 10_000),
  },

  /**
   * ElastiCache Valkey. `redis://` (or `rediss://` for TLS, which ElastiCache
   * in-transit encryption requires) — Valkey speaks the same protocol.
   */
  cache: {
    url: process.env.VALKEY_URL ?? '',
    connectTimeoutMs: toInt(process.env.CACHE_CONNECT_TIMEOUT_MS, 10_000),
    // TTL on hydrated keys — a safety net so stale data ages out even if a
    // later run fails; keep it comfortably above the hydration schedule.
    ttlSeconds: toInt(process.env.CACHE_TTL_SECONDS, 3600),
  },
} as const;

export const isProduction = config.env === 'production';

/** True only when enough is configured to reach both stores. */
export function isHydratorConfigured(): boolean {
  const db =
    config.database.authMode === 'iam'
      ? Boolean(config.database.host && config.database.name && config.database.user)
      : Boolean(config.database.url);
  return db && Boolean(config.cache.url);
}
