import type { Cache } from './cache.js';
import type { Db } from './db.js';
import { logger } from './logger.js';
import { hydratePostgres } from './steps/postgres.js';
import { hydrateValkey } from './steps/valkey.js';

export interface HydrationSummary {
  rowsWritten: number;
  keysWritten: number;
}

/**
 * Runs the hydration steps in order — Postgres first, then the cache is warmed
 * from what was just written. Clients come in as arguments (no network I/O at
 * import time), so tests can pass in-memory fakes.
 */
export async function runHydration(db: Db, cache: Cache): Promise<HydrationSummary> {
  const { rowsWritten } = await hydratePostgres(db);
  logger.info({ rowsWritten }, 'Postgres hydrated');

  const { keysWritten } = await hydrateValkey(db, cache);
  logger.info({ keysWritten }, 'Valkey hydrated');

  return { rowsWritten, keysWritten };
}
