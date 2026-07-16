import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { itemCacheKey, items } from '@app/shared';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Cache } from '../src/cache.js';
import type { Db } from '../src/db.js';
import { createItem, getItem, listItems } from '../src/repo/items.js';

// The hydrator owns the migration history; tests reuse it so the api is
// exercised against the exact schema production has.
const MIGRATIONS = fileURLToPath(new URL('../../hydrator/drizzle', import.meta.url));

/** In-memory fake of the Valkey surface the repo uses. */
class FakeCache implements Cache {
  readonly store = new Map<string, string>();
  readonly ttls = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, _mode: 'EX', ttlSeconds: number): Promise<string> {
    this.store.set(key, value);
    this.ttls.set(key, ttlSeconds);
    return 'OK';
  }
}

let pglite: PgliteDatabase;
let db: Db;
let cache: FakeCache;

beforeEach(async () => {
  pglite = drizzle({ client: new PGlite() });
  await migrate(pglite, { migrationsFolder: MIGRATIONS });
  db = pglite as unknown as Db;
  cache = new FakeCache();
  // Seed without ids — the identity column generates 1 and 2.
  await pglite.insert(items).values([{ name: 'first' }, { name: 'second' }]);
});

describe('listItems', () => {
  it('returns all items from Postgres in id order', async () => {
    expect(await listItems(db)).toEqual([
      { id: 1, name: 'first' },
      { id: 2, name: 'second' },
    ]);
  });
});

describe('getItem', () => {
  it('prefers the cache when the key is present', async () => {
    cache.store.set(itemCacheKey(1), JSON.stringify({ id: 1, name: 'cached-first' }));
    expect(await getItem(db, cache, 1)).toEqual({ id: 1, name: 'cached-first' });
  });

  it('falls back to Postgres on a miss and writes the key back with a TTL', async () => {
    expect(await getItem(db, cache, 2)).toEqual({ id: 2, name: 'second' });
    expect(cache.store.get(itemCacheKey(2))).toBe(JSON.stringify({ id: 2, name: 'second' }));
    expect(cache.ttls.get(itemCacheKey(2))).toBe(3600);
  });

  it('treats a garbage cache value as a miss and overwrites it', async () => {
    cache.store.set(itemCacheKey(1), 'not json');
    expect(await getItem(db, cache, 1)).toEqual({ id: 1, name: 'first' });
    expect(cache.store.get(itemCacheKey(1))).toBe(JSON.stringify({ id: 1, name: 'first' }));
  });

  it('treats a cache error as a miss (and survives a failed write-back)', async () => {
    const broken: Cache = {
      get: async () => {
        throw new Error('cache down');
      },
      set: async () => {
        throw new Error('cache down');
      },
    };
    expect(await getItem(db, broken, 1)).toEqual({ id: 1, name: 'first' });
  });

  it('returns undefined for a missing item and caches nothing', async () => {
    expect(await getItem(db, cache, 999)).toBeUndefined();
    expect(cache.store.has(itemCacheKey(999))).toBe(false);
  });
});

describe('createItem', () => {
  it('inserts with a generated id', async () => {
    const created = await createItem(db, 'third');
    expect(created).toEqual({ id: 3, name: 'third' });
    expect(await pglite.$count(items)).toBe(3);
  });
});
