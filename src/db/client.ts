import pg from 'pg';

export type PgClient = {
  query: pg.Pool['query'];
  end: () => Promise<void>;
};

export type CreatePgClientOptions = {
  connectionTimeoutMillis?: number;
  queryTimeoutMillis?: number;
};

const DEFAULT_TIMEOUT_MS = 3000;

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

export async function withPgClient<T>(
  url: string,
  fn: (client: PgClient) => Promise<T>,
): Promise<T> {
  const client = createPgClient(url);
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
