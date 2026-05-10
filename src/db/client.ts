import pg from 'pg';
import type { Bindings } from '../env.ts';

export type PgClient = {
  query: pg.Pool['query'];
  end: () => Promise<void>;
};

export type CreatePgClientOptions = {
  connectionTimeoutMillis?: number;
  queryTimeoutMillis?: number;
};

const DEFAULT_TIMEOUT_MS = 3000;
const POOL_MAX = 5;

/**
 * Per-isolate cache of pg.Pool instances keyed by connection string.
 * Cloudflare Workers isolates are short-lived but reused across many
 * requests; allocating a Pool per request (the original behaviour) was
 * wasteful. With this cache, the same isolate reuses a single Pool for
 * the same URL, and Hyperdrive's own server-side pooling stays effective
 * when its connection string differs from POSTGRES_URL.
 */
const POOLS = new Map<string, pg.Pool>();

function getOrCreatePool(url: string, opts: CreatePgClientOptions): pg.Pool {
  const cached = POOLS.get(url);
  if (cached) return cached;
  const pool = new pg.Pool({
    connectionString: url,
    max: POOL_MAX,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? DEFAULT_TIMEOUT_MS,
    query_timeout: opts.queryTimeoutMillis ?? DEFAULT_TIMEOUT_MS,
  });
  // pg.Pool emits 'error' on background connection failures (idle client
  // disconnect, backend restart, etc.). An unhandled 'error' on an
  // EventEmitter crashes Node — log instead and let the pool's own
  // reconnect logic recover. We deliberately don't evict the pool here:
  // aggressive teardown could race with in-flight queries and the next
  // borrow will exercise reconnect anyway.
  pool.on('error', (err) => {
    console.error('pg pool: background client error', { url, err });
  });
  POOLS.set(url, pool);
  return pool;
}

/**
 * One-shot client backed by a brand-new Pool with `max: 1`. Kept for direct
 * unit tests of pool construction; production code should go through
 * `withPgClient` so it benefits from the per-isolate pool cache.
 */
export function createPgClient(url: string, opts: CreatePgClientOptions = {}): PgClient {
  if (!url || !url.trim()) {
    throw new Error('POSTGRES_URL is required and must not be empty or whitespace');
  }
  const pool = new pg.Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? DEFAULT_TIMEOUT_MS,
    query_timeout: opts.queryTimeoutMillis ?? DEFAULT_TIMEOUT_MS,
  });
  return {
    query: pool.query.bind(pool),
    end: () => pool.end(),
  };
}

/**
 * Resolve the database URL for a given Bindings, preferring a Hyperdrive
 * binding's connection string when available. The fallback to POSTGRES_URL
 * keeps `wrangler dev` and tests (which don't have HYPERDRIVE bound) working.
 */
export function resolveDbUrl(env: Bindings): string {
  return env.HYPERDRIVE?.connectionString ?? env.POSTGRES_URL;
}

/**
 * Run `fn` with a PgClient backed by the per-isolate pool cache.
 * `client.end()` is a no-op because the pool is intentionally shared
 * across requests; the pool drains naturally when the isolate evicts.
 */
export async function withPgClient<T>(
  url: string,
  fn: (client: PgClient) => Promise<T>,
): Promise<T> {
  if (!url || !url.trim()) {
    throw new Error('POSTGRES_URL is required and must not be empty or whitespace');
  }
  const pool = getOrCreatePool(url, {});
  const client: PgClient = {
    query: pool.query.bind(pool),
    end: async () => undefined,
  };
  return await fn(client);
}

/**
 * Test-only: drain and forget every cached pool. Production code never calls
 * this; it exists so unit tests can assert pool reuse behaviour without
 * leaking sockets between test files.
 */
export async function _resetPoolCacheForTests(): Promise<void> {
  const pools = Array.from(POOLS.values());
  POOLS.clear();
  await Promise.allSettled(pools.map((p) => p.end()));
}
