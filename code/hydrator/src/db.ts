import { fileURLToPath } from 'node:url';
import { Signer } from '@aws-sdk/rds-signer';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from './config.js';

/**
 * The database handle the hydration steps depend on. Production wraps a pg
 * client; tests pass a drizzle instance over PGlite (in-memory Postgres), so
 * the steps run real SQL either way.
 */
export type Db = NodePgDatabase;

/**
 * Connection settings per auth mode:
 *  - 'password': everything rides in DATABASE_URL (local dev / compose).
 *  - 'iam': no standing credential — a fresh 15-minute RDS auth token is
 *    minted via the task role (rds-db:connect). TLS is required for IAM auth;
 *    rejectUnauthorized is off (encrypted, not CA-pinned) — pin the RDS CA
 *    bundle to harden.
 */
function connectionConfig(): pg.ClientConfig {
  const db = config.database;
  if (db.authMode === 'iam') {
    const signer = new Signer({ hostname: db.host, port: db.port, username: db.user });
    return {
      host: db.host,
      port: db.port,
      database: db.name,
      user: db.user,
      password: () => signer.getAuthToken(),
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: db.connectTimeoutMs,
    };
  }
  return {
    connectionString: db.url,
    connectionTimeoutMillis: db.connectTimeoutMs,
  };
}

/**
 * One plain client, not a pool — a run-to-completion job issues its queries
 * sequentially and exits. Connection failures should surface fast (the run is
 * retried by the next scheduled invocation, not by hanging around).
 */
export function createDbClient(): pg.Client {
  return new pg.Client(connectionConfig());
}

export function createDb(client: pg.Client): Db {
  return drizzle({ client });
}

/**
 * Generated SQL migrations (hydrator/drizzle), located relative to this file
 * so the same path works from src (tsx) and dist (node) — both are siblings
 * of the drizzle/ folder.
 */
export function migrationsFolder(): string {
  return fileURLToPath(new URL('../drizzle', import.meta.url));
}
