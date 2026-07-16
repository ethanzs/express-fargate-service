import { Redis as Valkey } from 'iovalkey';
import { config } from './config.js';

/**
 * The minimal command surface the hydration steps depend on. Steps take this
 * interface (not the Valkey client) so tests can pass an in-memory fake.
 */
export interface Cache {
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
}

/**
 * Lazy client: nothing touches the network until connect() is called, and a
 * failed connection is a failed run — no reconnect loop. A scheduled job must
 * exit (the next invocation is the retry), never sit retrying inside a task.
 */
export function createCacheClient(): Valkey {
  return new Valkey(config.cache.url, {
    lazyConnect: true,
    connectTimeout: config.cache.connectTimeoutMs,
    retryStrategy: () => null,
    maxRetriesPerRequest: 1,
  });
}
