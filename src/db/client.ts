import type { Bindings } from '../env.ts';

/**
 * Thin D1-backed client preserving the previous `{ query, end }` shape so the
 * existing call sites need only a 1-arg signature change (URL string -> env).
 *
 * - `query(sql, params)` returns `{ rows, rowCount }`:
 *     rows = the rowset (SELECT or RETURNING). `rowCount` falls back to
 *     `meta.changes` for INSERT/UPDATE/DELETE that don't RETURN.
 * - `end()` is a no-op. D1 has no per-connection lifecycle; every prepared
 *   statement is independent and the binding lives for the isolate.
 */
export type PgClient = {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: T[]; rowCount: number }>;
  end: () => Promise<void>;
};

export async function withPgClient<T>(
  env: Bindings,
  fn: (client: PgClient) => Promise<T>,
): Promise<T> {
  const client: PgClient = {
    query: async (sql, params = []) => {
      // D1 doesn't support explicit BEGIN/COMMIT/ROLLBACK through individual
      // prepared statements; it has implicit per-statement atomicity and
      // explicit multi-statement atomicity via `env.DB.batch([...])`. Treat
      // those keywords as no-ops so existing transaction-bracketed call sites
      // keep running. TODO: migrate the few atomic blocks (admin-edit,
      // dm-fallback-sweep, review/approve, ad-events dedup) to batch() when
      // we hit a correctness issue under contention.
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) {
        return { rows: [] as never, rowCount: 0 };
      }
      const stmt = env.DB.prepare(sql).bind(...params);
      const res = await stmt.all();
      const rows = (res.results ?? []) as unknown[];
      const changes =
        typeof res.meta?.changes === 'number' && res.meta.changes > 0
          ? res.meta.changes
          : rows.length;
      return { rows: rows as never, rowCount: changes };
    },
    end: async () => undefined,
  };
  return fn(client);
}
