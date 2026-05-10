import type { PgClient } from '../client.ts';

export type AdminLogEntry = {
  actorId: string;
  action: string;
  targetKind: string;
  targetId: string | null;
  before?: unknown;
  after?: unknown;
};

export async function writeAdminLog(client: PgClient, entry: AdminLogEntry): Promise<void> {
  await client.query(
    `INSERT INTO admin_logs (actor_id, action, target_kind, target_id, before, after)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [
      entry.actorId,
      entry.action,
      entry.targetKind,
      entry.targetId,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
    ],
  );
}
