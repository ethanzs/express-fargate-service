import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createCacheClient } from './cache.js';
import { config, isHydratorConfigured } from './config.js';
import { createDb, createDbClient, migrationsFolder } from './db.js';
import { runHydration } from './hydrate.js';
import { logger } from './logger.js';
import { emitRunMetric } from './metrics.js';

// Fail fast: a scheduled job with missing config should die loudly (and alarm
// via HydrationFailureCount / the task exit code), never hang or half-run.
if (!isHydratorConfigured()) {
  logger.error('Hydrator is not fully configured (DATABASE_URL or DB_* / VALKEY_URL)');
  process.exit(1);
}

// Hard wall-clock cap. EventBridge starts the next run on schedule regardless,
// so a hung run must be killed rather than allowed to pile up alongside it.
const timer = setTimeout(() => {
  logger.error({ jobTimeoutMs: config.jobTimeoutMs }, 'Hydration timed out, forcing exit');
  process.exit(1);
}, config.jobTimeoutMs);

// ECS sends SIGTERM when a task is stopped. A half-finished run is a failed
// run: exit non-zero and let the next scheduled invocation redo it (steps are
// idempotent, so a rerun is always safe).
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.error({ signal }, 'Interrupted, aborting run');
    process.exit(1);
  });
}

const start = process.hrtime.bigint();
const elapsedMs = (): number => Number(process.hrtime.bigint() - start) / 1e6;

const client = createDbClient();
const db = createDb(client);
const cache = createCacheClient();

try {
  await client.connect();
  await cache.connect();

  // The hydrator owns the schema: apply any pending drizzle migrations before
  // touching data, so a run never writes against an outdated shape.
  await migrate(db, { migrationsFolder: migrationsFolder() });

  const summary = await runHydration(db, cache);

  emitRunMetric({ outcome: 'success', durationMs: elapsedMs(), ...summary });
  logger.info({ ...summary, durationMs: elapsedMs() }, 'Hydration complete');
} catch (err) {
  emitRunMetric({ outcome: 'failure', durationMs: elapsedMs(), rowsWritten: 0, keysWritten: 0 });
  logger.error({ err }, 'Hydration failed');
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await client.end().catch(() => undefined);
  cache.disconnect();
}
