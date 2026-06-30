import pino from 'pino';
import { config, isProduction } from './config.js';

/**
 * Paths scrubbed from every log line before it's written. The biggest real
 * exposure is pino-http logging request headers, which carry the bearer token
 * and cookies — those are redacted here, along with common secret-bearing
 * field names (top level and one level deep, e.g. a logged request body).
 */
const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'clientSecret',
  '*.clientSecret',
  'authorization',
  '*.authorization',
];

/**
 * Structured JSON logger tuned for CloudWatch.
 *  - `base` adds stable dimensions (service, env) for filtering/grouping.
 *  - level is emitted as a label ("error") rather than a number (50).
 *  - ISO timestamps read cleanly in Logs Insights.
 *  - sensitive values are redacted (see redactPaths).
 * Pretty-printing is enabled only in local dev.
 */
export const logger = pino({
  level: config.logLevel,
  base: { service: config.serviceName, env: config.env },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  transport: isProduction
    ? undefined
    : { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } },
});
