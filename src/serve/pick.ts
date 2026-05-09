import type { PgClient } from '../db/client.ts';

export type AdKind = 'regular' | 'house' | 'placeholder';

export type ServedAd = {
  id: string;
  kind: AdKind;
  title: string;
  body: string;
  linkUrl: string;
  imageKey: string | null;
};

type RawAdRow = {
  id: string;
  kind: string;
  title: string;
  body: string;
  link_url: string;
  image_key: string | null;
};

function mapRow(r: RawAdRow): ServedAd {
  return {
    id: r.id,
    kind: r.kind as AdKind,
    title: r.title,
    body: r.body,
    linkUrl: r.link_url,
    imageKey: r.image_key,
  };
}

const ACTIVE_FILTER = `
  status = 'approved'
  AND slot = $1
  AND (starts_at IS NULL OR starts_at <= now())
  AND (ends_at IS NULL OR ends_at > now())
`;

export async function pickRegularAds(
  client: PgClient,
  slot: string,
  n: number,
): Promise<ServedAd[]> {
  if (n <= 0) return [];
  const res = await client.query<RawAdRow>(
    `WITH candidates AS (
       SELECT id, kind, title, body, link_url, image_key, weight_snapshot
         FROM ads
        WHERE ${ACTIVE_FILTER}
          AND kind = 'regular'
          AND weight_snapshot IS NOT NULL
          AND weight_snapshot > 0
     )
     SELECT id, kind, title, body, link_url, image_key
       FROM candidates
      ORDER BY -ln(random()) / weight_snapshot ASC
      LIMIT $2`,
    [slot, n],
  );
  return res.rows.map(mapRow);
}

export async function pickHouseAds(
  client: PgClient,
  slot: string,
  n: number,
  excludeIds: string[],
): Promise<ServedAd[]> {
  if (n <= 0) return [];
  const res = await client.query<RawAdRow>(
    `SELECT id, kind, title, body, link_url, image_key
       FROM ads
      WHERE ${ACTIVE_FILTER}
        AND kind = 'house'
        AND id <> ALL($2::uuid[])
      ORDER BY random()
      LIMIT $3`,
    [slot, excludeIds, n],
  );
  return res.rows.map(mapRow);
}

export async function pickPlaceholder(client: PgClient, slot: string): Promise<ServedAd[]> {
  const res = await client.query<RawAdRow>(
    `SELECT id, kind, title, body, link_url, image_key
       FROM ads
      WHERE ${ACTIVE_FILTER}
        AND kind = 'placeholder'
      LIMIT 1`,
    [slot],
  );
  return res.rows.map(mapRow);
}

/**
 * 3-stage fallback selection. Returns up to `n` ads.
 * - Phase 1: regular weighted-random
 * - Phase 2: house equal-random fill (only if regular returned <n)
 * - Phase 3: placeholder single fallback (only if total still 0)
 *
 * `n` is clamped to [1, 5] (Discord embed practical limit).
 */
export async function serveAds(client: PgClient, slot: string, n: number): Promise<ServedAd[]> {
  const safeN = Math.max(1, Math.min(n, 5));
  const regulars = await pickRegularAds(client, slot, safeN);
  if (regulars.length >= safeN) return regulars;

  const houseN = safeN - regulars.length;
  // regular and house are different kinds, so no overlap is possible today.
  // The empty exclude list keeps the parameter shape future-proof.
  const houseExclude: string[] = [];
  const houses = await pickHouseAds(client, slot, houseN, houseExclude);
  const combined = [...regulars, ...houses];
  if (combined.length > 0) return combined;

  const placeholder = await pickPlaceholder(client, slot);
  return placeholder;
}
