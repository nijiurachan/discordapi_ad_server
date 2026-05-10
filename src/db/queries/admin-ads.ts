import type { PgClient } from '../client.ts';

export const AD_STATUS_VALUES = [
  'pending',
  'approved',
  'paused',
  'rejected',
  'expired',
  'withdrawn',
] as const;
export type AdStatus = (typeof AD_STATUS_VALUES)[number];

export const AD_KIND_VALUES = ['regular', 'house', 'placeholder'] as const;
export type AdKind = (typeof AD_KIND_VALUES)[number];

export type AdminAdRow = {
  id: string;
  sponsorId: string | null;
  kind: AdKind;
  slot: string;
  title: string;
  status: AdStatus;
  weightSnapshot: number | null;
  createdAt: Date;
  startsAt: Date | null;
  endsAt: Date | null;
};

export type AdminListFilters = {
  status?: AdStatus | undefined;
  kind?: AdKind | undefined;
  slot?: string | undefined;
  sponsorId?: string | undefined;
};

export type AdminListResult = {
  ads: AdminAdRow[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export async function listAdminAds(
  client: PgClient,
  filters: AdminListFilters,
  page: number,
  pageSize: number,
): Promise<AdminListResult> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.status) {
    params.push(filters.status);
    where.push(`status = $${params.length}`);
  }
  if (filters.kind) {
    params.push(filters.kind);
    where.push(`kind = $${params.length}`);
  }
  if (filters.slot) {
    params.push(filters.slot);
    where.push(`slot = $${params.length}`);
  }
  if (filters.sponsorId) {
    params.push(filters.sponsorId);
    where.push(`sponsor_id = $${params.length}`);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const countRes = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ads ${whereClause}`,
    [...params],
  );
  const totalCount = Number(countRes.rows[0]?.count ?? '0');
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const offset = (safePage - 1) * pageSize;

  const listParams = [...params, pageSize, offset];
  const limitParam = listParams.length - 1;
  const offsetParam = listParams.length;

  const res = await client.query<{
    id: string;
    sponsor_id: string | null;
    kind: string;
    slot: string;
    title: string;
    status: string;
    weight_snapshot: number | null;
    created_at: Date;
    starts_at: Date | null;
    ends_at: Date | null;
  }>(
    `SELECT id, sponsor_id, kind, slot, title, status, weight_snapshot,
            created_at, starts_at, ends_at
       FROM ads
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
    listParams,
  );

  const ads: AdminAdRow[] = res.rows.map((r) => ({
    id: r.id,
    sponsorId: r.sponsor_id,
    kind: r.kind as AdKind,
    slot: r.slot,
    title: r.title,
    status: r.status as AdStatus,
    weightSnapshot: r.weight_snapshot,
    createdAt: r.created_at,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
  }));

  return { ads, totalCount, page: safePage, pageSize, totalPages };
}

export async function getDistinctSlots(client: PgClient): Promise<string[]> {
  const res = await client.query<{ slot: string }>('SELECT DISTINCT slot FROM ads ORDER BY slot');
  return res.rows.map((r) => r.slot);
}
