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
