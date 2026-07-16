import { itemCacheKey, items } from '@app/shared';
import type { Cache } from '../cache.js';
import { config } from '../config.js';
import type { Db } from '../db.js';

/**
 * Warms Valkey from what is now in Postgres, so reads hit the cache from the
 * first request after a run. Every key carries a TTL as a safety net: if
 * hydration stops running, stale entries age out instead of living forever.
 */
export async function hydrateValkey(db: Db, cache: Cache): Promise<{ keysWritten: number }> {
  const rows = await db.select().from(items).orderBy(items.id);

  let keysWritten = 0;
  for (const item of rows) {
    await cache.set(itemCacheKey(item.id), JSON.stringify(item), 'EX', config.cache.ttlSeconds);
    keysWritten += 1;
  }
  return { keysWritten };
}
