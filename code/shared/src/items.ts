import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { z } from 'zod';

/**
 * The `items` Postgres table — the single source of truth for the database
 * schema. drizzle-kit generates SQL migrations from it (`npm run db:generate
 * -w hydrator`), and the hydrator applies them at the start of each run.
 */
export const items = pgTable('items', {
  // "by default" identity: the api inserts without an id (generated), while
  // the hydrator's seed can still upsert explicit ids (it resets the sequence
  // after seeding so generated ids never collide).
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: text('name').notNull(),
});

/**
 * The `items` domain object as validated at the edges: the api derives its
 * request schemas from this (`.pick`/`.omit`), the hydrator types its seed
 * data with it. Kept in lockstep with the table above.
 */
export const ItemSchema = z.object({
  id: z.coerce.number().int().positive(),
  name: z.string().trim().min(1).max(100),
});

export type Item = z.infer<typeof ItemSchema>;

/**
 * Valkey key for a single item — the cache contract between the hydrator
 * (bulk write-through on its schedule) and the api (cache-aside: reads, and
 * re-populates expired keys after a Postgres fallback).
 */
export function itemCacheKey(id: number): string {
  return `items:${id}`;
}
