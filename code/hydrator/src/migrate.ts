import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { config } from './config.js';
import { createDb, createDbClient, migrationsFolder } from './db.js';
import { logger } from './logger.js';

/**
 * Standalone migration runner (`npm run db:migrate -w hydrator`): applies any
 * pending drizzle migrations and exits 0/1. The scheduled hydrator run also
 * migrates before hydrating (main.ts) — this exists to apply schema changes
 * on demand (local dev, or a one-off deploy step) without running a hydration.
 */
if (!config.database.url) {
  logger.error('DATABASE_URL is not set');
  process.exit(1);
}

const client = createDbClient();
const db = createDb(client);

try {
  await client.connect();
  await migrate(db, { migrationsFolder: migrationsFolder() });
  logger.info('Migrations applied');
} catch (err) {
  logger.error({ err }, 'Migration failed');
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
