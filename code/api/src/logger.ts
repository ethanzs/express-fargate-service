import { createLogger } from '@app/shared';
import { config, isProduction } from './config.js';

/**
 * Paths scrubbed on top of the shared base list (common secret-bearing field
 * names — see createLogger in @app/shared). The biggest real exposure here is
 * pino-http logging request headers, which carry the bearer token and cookies.
 */
const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

/** Structured JSON logger tuned for CloudWatch; pretty-printed only in dev. */
export const logger = createLogger({
  serviceName: config.serviceName,
  env: config.env,
  version: config.serviceVersion,
  level: config.logLevel,
  extraRedactPaths: redactPaths,
  pretty: !isProduction,
});
