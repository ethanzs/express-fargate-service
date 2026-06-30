/**
 * Centralized, validated runtime configuration.
 * Reads from environment variables so the same image runs in any environment
 * (12-factor). On Fargate these come from the task definition.
 */

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Expected an integer but got "${value}"`);
  }
  return parsed;
}

const tenantId = process.env.AZURE_TENANT_ID ?? '';
const clientId = process.env.AZURE_CLIENT_ID ?? '';
// Cloud instance (sovereign clouds differ, e.g. login.microsoftonline.us).
const instance = process.env.AZURE_AD_INSTANCE ?? 'https://login.microsoftonline.com';

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  // Stable identifier attached to every log line (a dimension for dashboards).
  serviceName: process.env.SERVICE_NAME ?? 'express-fargate-service',
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
    jwksUri:
      process.env.AZURE_AD_JWKS_URI ?? `${instance}/${tenantId}/discovery/v2.0/keys`,
  },
} as const;

export const isProduction = config.env === 'production';

/** True only when enough is configured to validate tokens. */
export function isAuthConfigured(): boolean {
  const { tenantId, clientId, audience } = config.auth;
  return Boolean(tenantId && clientId && audience);
}
