import { PGlite } from '@electric-sql/pglite';
import { items } from '@app/shared';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Cache } from '../src/cache.js';
import type { Db } from '../src/db.js';
import { migrationsFolder } from '../src/db.js';
import { runHydration } from '../src/hydrate.js';

/** In-memory stand-in for Valkey, recording SET calls with their TTLs. */
class FakeCache implements Cache {
  readonly entries = new Map<string, { value: string; mode: string; ttlSeconds: number }>();

  async set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<string> {
    this.entries.set(key, { value, mode, ttlSeconds });
    return 'OK';
  }
}

/**
 * Real Postgres via PGlite (in-memory, WASM) — the steps run the exact SQL
 * drizzle produces in production, including the upsert and the migrations.
 */
let pglite: PgliteDatabase;
let db: Db;

beforeEach(async () => {
  pglite = drizzle({ client: new PGlite() });
  await migrate(pglite, { migrationsFolder: migrationsFolder() });
  db = pglite as unknown as Db;
});

describe('runHydration', () => {
  it('hydrates Postgres then warms Valkey from it', async () => {
    const cache = new FakeCache();

    const summary = await runHydration(db, cache);

    expect(summary).toEqual({ rowsWritten: 2, keysWritten: 2 });
    expect(await pglite.select().from(items).orderBy(items.id)).toEqual([
      { id: 1, name: 'first' },
      { id: 2, name: 'second' },
    ]);
    expect(cache.entries.get('items:1')).toEqual({
      value: JSON.stringify({ id: 1, name: 'first' }),
      mode: 'EX',
      ttlSeconds: 3600,
    });
  });

  it('is idempotent — a rerun writes the same data, not duplicates', async () => {
    const cache = new FakeCache();

    await runHydration(db, cache);
    const second = await runHydration(db, cache);

    expect(second).toEqual({ rowsWritten: 2, keysWritten: 2 });
    expect(await pglite.$count(items)).toBe(2);
    expect(cache.entries.size).toBe(2);
  });

  it('surfaces a database failure instead of swallowing it', async () => {
    await pglite.execute('DROP TABLE items');
    await expect(runHydration(db, new FakeCache())).rejects.toThrow();
  });
});
