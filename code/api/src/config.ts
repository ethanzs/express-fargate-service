import { toInt } from '@app/shared';

/**
 * Centralized, validated runtime configuration.
 * Reads from environment variables so the same image runs in any environment
 * (12-factor). On Fargate these come from the task definition.
 */

const tenantId = process.env.AZURE_TENANT_ID ?? '';
const clientId = process.env.AZURE_CLIENT_ID ?? '';
// Cloud instance (sovereign clouds differ, e.g. login.microsoftonline.us).
const instance = process.env.AZURE_AD_INSTANCE ?? 'https://login.microsoftonline.com';

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  // Stable identifier attached to every log line (a dimension for dashboards).
  serviceName: process.env.SERVICE_NAME ?? 'express-fargate-service',
  // Release version baked into the image by the release build; 'dev' locally.
  serviceVersion: process.env.SERVICE_VERSION ?? 'dev',
  // Bind to 0.0.0.0 so the container is reachable from outside (ALB/awsvpc).
  host: process.env.HOST ?? '0.0.0.0',
  port: toInt(process.env.PORT, 3000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  // How long to wait for in-flight requests to drain on shutdown (ms).
  shutdownTimeoutMs: toInt(process.env.SHUTDOWN_TIMEOUT_MS, 10_000),

  // Keep-alive must exceed the ALB idle timeout (default 60s), or the ALB will
  // reuse a socket Node has already closed → intermittent 502s. Keep
  // headersTimeout greater than keepAliveTimeout.
  keepAliveTimeoutMs: toInt(process.env.KEEP_ALIVE_TIMEOUT_MS, 65_000),
  headersTimeoutMs: toInt(process.env.HEADERS_TIMEOUT_MS, 66_000),

  // Browser (SPA) origins allowed to call the API, comma-separated. Empty = deny
  // all cross-origin requests (safe default; set this for your frontend).
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  // Max accepted JSON request body. Caps memory use / a trivial DoS vector.
  jsonBodyLimit: process.env.JSON_BODY_LIMIT ?? '100kb',

  /**
   * RDS Postgres (system of record for items). Two auth modes:
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
   * ElastiCache Valkey. Cache-aside: reads hit the cache first, and a
   * Postgres fallback re-populates the key with a fresh TTL. A cache problem
   * degrades to Postgres reads, never to an error.
   */
  cache: {
    url: process.env.VALKEY_URL ?? '',
    connectTimeoutMs: toInt(process.env.CACHE_CONNECT_TIMEOUT_MS, 10_000),
    // TTL on keys the api writes back — keep in step with the hydrator's.
    ttlSeconds: toInt(process.env.CACHE_TTL_SECONDS, 3600),
  },

  /**
   * Microsoft Entra ID (Azure AD) JWT validation settings.
   * The defaults assume v2.0 access tokens. If your API app registration still
   * issues v1.0 tokens (accessTokenAcceptedVersion !== 2), override
   * AZURE_AD_ISSUER to https://sts.windows.net/<tenant-id>/.
   */
  auth: {
    tenantId,
    clientId,
    // Expected `aud` claim. Usually the API's client id or its Application ID
    // URI (api://<client-id>). Defaults to the client id when unset.
    audience: process.env.AZURE_AD_AUDIENCE ?? clientId,
    issuer: process.env.AZURE_AD_ISSUER ?? `${instance}/${tenantId}/v2.0`,
    jwksUri: process.env.AZURE_AD_JWKS_URI ?? `${instance}/${tenantId}/discovery/v2.0/keys`,
  },
} as const;

export const isProduction = config.env === 'production';

/** True only when enough is configured to reach the data stores. */
export function isDataConfigured(): boolean {
  const db =
    config.database.authMode === 'iam'
      ? Boolean(config.database.host && config.database.name && config.database.user)
      : Boolean(config.database.url);
  return db && Boolean(config.cache.url);
}

/** True only when enough is configured to validate tokens. */
export function isAuthConfigured(): boolean {
  const { tenantId, clientId, audience } = config.auth;
  return Boolean(tenantId && clientId && audience);
}
