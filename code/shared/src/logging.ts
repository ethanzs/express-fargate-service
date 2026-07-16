import pino from 'pino';

/**
 * Redact paths every service scrubs, regardless of what it logs: common
 * secret-bearing field names, matched at the top level and one level deep.
 * Services add their own exposure on top (e.g. the api redacts request
 * headers, the hydrator redacts connection strings).
 */
const baseRedactPaths = [
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

export interface CreateLoggerOptions {
  /** Stable identifier attached to every log line (a dimension for dashboards). */
  serviceName: string;
  env: string;
  /** Release version baked into the image (SERVICE_VERSION); 'dev' locally. */
  version?: string;
  level: string;
  /** Service-specific redact paths, merged with the shared base list. */
  extraRedactPaths?: string[];
  /** Pretty-print for local dev only — production emits raw JSON to stdout. */
  pretty?: boolean;
}

/**
 * Structured JSON logger tuned for CloudWatch.
 *  - `base` adds stable dimensions (service, env) for filtering/grouping.
 *  - level is emitted as a label ("error") rather than a number (50).
 *  - ISO timestamps read cleanly in Logs Insights.
 *  - sensitive values are redacted (base list + extraRedactPaths).
 */
export function createLogger(options: CreateLoggerOptions): pino.Logger {
  return pino({
    level: options.level,
    base: {
      service: options.serviceName,
      env: options.env,
      ...(options.version ? { version: options.version } : {}),
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [...baseRedactPaths, ...(options.extraRedactPaths ?? [])],
      censor: '[REDACTED]',
    },
    transport: options.pretty
      ? { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } }
      : undefined,
  });
}
