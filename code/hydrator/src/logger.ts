import { createLogger } from '@app/shared';
import { config, isProduction } from './config.js';

/**
 * Paths scrubbed on top of the shared base list (common secret-bearing field
 * names — see createLogger in @app/shared). The biggest real exposure here is
 * a logged error or config object carrying a connection string, which embeds
 * the database password.
 */
const redactPaths = ['connectionString', '*.connectionString', 'url', '*.url'];

/** Structured JSON logger tuned for CloudWatch; pretty-printed only in dev. */
export const logger = createLogger({
  serviceName: config.serviceName,
  env: config.env,
  version: config.serviceVersion,
  level: config.logLevel,
  extraRedactPaths: redactPaths,
  pretty: !isProduction,
});
