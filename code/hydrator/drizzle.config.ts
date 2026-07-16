import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit tooling config (generate/studio) — not part of the app runtime,
 * so reading process.env directly here is fine. The schema lives in the shared
 * package; generated SQL lands in ./drizzle and is applied by the hydrator at
 * the start of each run.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: '../shared/src/items.ts',
  out: './drizzle',
  dbCredentials: {
    // Only needed for `drizzle-kit studio`/`push`; `generate` works offline.
    url: process.env.DATABASE_URL ?? '',
  },
});
