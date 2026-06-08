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
  weightAlloc: number | null;
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

// D1 stores epoch ms in integer columns; wrap to Date so downstream code that
// expects Date | null (admin-ads-list embed formatter etc.) keeps working.
function toDate(v: number | string | Date | null): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  // Defensive: if a legacy row arrives as ISO string, parse it.
  return new Date(v);
}

export async function listAdminAds(
  client: PgClient,
  filters: AdminListFilters,
  page: number,
  pageSize: number,
): Promise<AdminListResult> {
  // D1/SQLite only supports `?` placeholders; positional binding by push-order.
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.status) {
    params.push(filters.status);
    where.push('status = ?');
  }
  if (filters.kind) {
    params.push(filters.kind);
    where.push('kind = ?');
  }
  if (filters.slot) {
    params.push(filters.slot);
    where.push('slot = ?');
  }
  if (filters.sponsorId) {
    params.push(filters.sponsorId);
    where.push('sponsor_id = ?');
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const countRes = await client.query<{ count: number | string }>(
    `SELECT COUNT(*) AS count FROM ads ${whereClause}`,
    [...params],
  );
  const totalCount = Number(countRes.rows[0]?.count ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const offset = (safePage - 1) * pageSize;

  const res = await client.query<{
    id: string;
    sponsor_id: string | null;
    kind: string;
    slot: string;
    title: string;
    status: string;
    weight_snapshot: number | null;
    weight_alloc: number | null;
    created_at: number | string | Date;
    starts_at: number | string | Date | null;
    ends_at: number | string | Date | null;
  }>(
    `SELECT id, sponsor_id, kind, slot, title, status, weight_snapshot, weight_alloc,
            created_at, starts_at, ends_at
       FROM ads
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );

  const ads: AdminAdRow[] = res.rows.map((r) => ({
    id: r.id,
    sponsorId: r.sponsor_id,
    kind: r.kind as AdKind,
    slot: r.slot,
    title: r.title,
    status: r.status as AdStatus,
    weightSnapshot: r.weight_snapshot,
    weightAlloc: r.weight_alloc,
    createdAt: toDate(r.created_at) ?? new Date(0),
    startsAt: toDate(r.starts_at),
    endsAt: toDate(r.ends_at),
  }));

  return { ads, totalCount, page: safePage, pageSize, totalPages };
}

export async function getDistinctSlots(client: PgClient): Promise<string[]> {
  const res = await client.query<{ slot: string }>('SELECT DISTINCT slot FROM ads ORDER BY slot');
  return res.rows.map((r) => r.slot);
}
