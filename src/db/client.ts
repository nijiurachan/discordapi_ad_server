import pg from 'pg';

export type PgClient = {
  query: pg.Pool['query'];
  end: () => Promise<void>;
};

export function createPgClient(url: string): PgClient {
  if (!url) throw new Error('POSTGRES_URL is required');
  const pool = new pg.Pool({ connectionString: url, max: 1 });
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
