import { Signer } from '@aws-sdk/rds-signer';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from './config.js';

/** The database handle the repositories depend on (PGlite in tests). */
export type Db = NodePgDatabase;

/**
 * Connection settings per auth mode:
 *  - 'password': everything rides in DATABASE_URL (local dev / compose).
 *  - 'iam': no standing credential — `password` is an async function, so each
 *    NEW pool connection mints a fresh 15-minute RDS auth token via the task
 *    role (rds-db:connect). TLS is required for IAM auth; rejectUnauthorized
 *    is off (encrypted, not CA-pinned) — pin the RDS CA bundle to harden.
 */
function connectionConfig(): pg.PoolConfig {
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
 * A pool, not a single client — the api serves concurrent requests. Nothing
 * connects until the first query, so createApp() and the test suite stay free
 * of network I/O.
 */
const pool = new pg.Pool(connectionConfig());

export const db: Db = drizzle({ client: pool });

/** Drains the pool on shutdown (see server.ts). */
export function closeDb(): Promise<void> {
  return pool.end();
}
