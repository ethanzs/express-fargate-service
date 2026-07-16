import { items, type Item } from '@app/shared';
import { sql } from 'drizzle-orm';
import type { Db } from '../db.js';

/**
 * Reference data hydrated into Postgres. This is the seam for the real source
 * (S3 export, upstream API, …) — swap the seed for a fetch, but keep the writes
 * idempotent (upserts) so a scheduled re-run is always safe.
 */
const SEED_ITEMS: readonly Item[] = [
  { id: 1, name: 'first' },
  { id: 2, name: 'second' },
];

/** Upserts the reference data into Postgres. Idempotent by design. */
export async function hydratePostgres(db: Db): Promise<{ rowsWritten: number }> {
  await db
    .insert(items)
    .values([...SEED_ITEMS])
    .onConflictDoUpdate({
      target: items.id,
      set: { name: sql`excluded.name` },
    });

  // The seed inserts explicit ids, which doesn't advance the identity
  // sequence — bump it past MAX(id) so the api's generated inserts never
  // collide with seeded rows.
  await db.execute(
    sql`SELECT setval(pg_get_serial_sequence('items', 'id'), (SELECT COALESCE(MAX(id), 1) FROM items))`,
  );

  return { rowsWritten: SEED_ITEMS.length };
}
