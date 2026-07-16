import type { Server } from 'node:http';
import { createApp } from './app.js';
import { cache } from './cache.js';
import { config, isAuthConfigured, isDataConfigured, isProduction } from './config.js';
import { closeDb } from './db.js';
import { logger } from './logger.js';

// Fail fast in production if token validation can't work; warn in dev so the
// app still boots for local work that doesn't hit protected routes.
if (!isAuthConfigured()) {
  const msg =
    'Entra ID auth is not fully configured (AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_AD_AUDIENCE)';
  if (isProduction) {
    logger.error(msg);
    process.exit(1);
  }
  logger.warn(msg + ' — protected /api routes will reject all requests');
}

// Same policy for the data stores (items live in Postgres/Valkey now).
if (!isDataConfigured()) {
  const msg = 'Data stores are not fully configured (DATABASE_URL or DB_* / VALKEY_URL)';
  if (isProduction) {
    logger.error(msg);
    process.exit(1);
  }
  logger.warn(msg + ' — /api/items will fail; run `docker compose up -d` and set .env');
}

const app = createApp();

// Kick off the cache connection in the background. A down cache is degraded
// mode (reads fall back to Postgres), never a boot failure — the client keeps
// reconnecting with backoff.
cache.connect().catch((err: unknown) => {
  logger.warn({ err }, 'Valkey connection failed — item reads fall back to Postgres');
});

const server: Server = app.listen(config.port, config.host, () => {
  logger.info({ port: config.port, host: config.host }, 'Server listening');
});

// Avoid 502s behind an ALB: Node must not close keep-alive sockets before the
// load balancer does. keepAliveTimeout > ALB idle timeout, headersTimeout > it.
server.keepAliveTimeout = config.keepAliveTimeoutMs;
server.headersTimeout = config.headersTimeoutMs;

/**
 * Graceful shutdown. ECS sends SIGTERM before stopping a task (and again
 * during deploys). We stop accepting new connections, let in-flight requests
 * finish, then exit. A hard timeout guarantees the task eventually dies so a
 * hung connection can't block the deployment.
 */
function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutting down');

  const timer = setTimeout(() => {
    logger.error('Shutdown timed out, forcing exit');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  timer.unref();

  server.close((err) => {
    if (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
    // In-flight requests are done — release the data-store connections.
    cache.disconnect();
    closeDb()
      .catch((dbErr: unknown) => logger.error({ err: dbErr }, 'Error draining the pg pool'))
      .finally(() => {
        logger.info('Shutdown complete');
        process.exit(0);
      });
  });
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => shutdown(signal));
}
