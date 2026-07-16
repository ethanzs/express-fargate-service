import { Redis as Valkey } from 'iovalkey';
import { config } from './config.js';

/**
 * The command surface the repositories depend on. The api reads the cache and
 * re-populates expired/missing keys after a Postgres fallback (cache-aside);
 * the hydrator does the bulk write-through on its schedule. Tests pass a fake.
 */
export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
}

/**
 * Long-lived client for a server: unlike the hydrator's one-shot client it
 * reconnects with backoff (iovalkey's default), but it never queues commands
 * while disconnected — a cache that's down must fail fast so reads fall back
 * to Postgres instead of hanging requests. Lazy: server.ts initiates the
 * connection at boot; createApp()/tests do no network I/O.
 */
export const cache: Valkey = new Valkey(config.cache.url, {
  lazyConnect: true,
  connectTimeout: config.cache.connectTimeoutMs,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});
