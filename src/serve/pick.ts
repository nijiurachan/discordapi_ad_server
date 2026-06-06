import type { PgClient } from '../db/client.ts';
import { sha256Hex, seededShuffle } from '../utils/seeded-shuffle.ts';

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

type RawWeightedRow = RawAdRow & { weight_snapshot: number };

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
  AND slot = ?
  AND (starts_at IS NULL OR starts_at <= (unixepoch() * 1000))
  AND (ends_at IS NULL OR ends_at > (unixepoch() * 1000))
`;

// UTC day key for the deck. Cron rotations and Workers run in UTC, so a UTC
// day is the simplest shared boundary. Switch to a different TZ here if we
// ever want JST-aligned deck resets.
function utcDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

async function buildBag(ads: RawWeightedRow[], seed: string): Promise<string[]> {
  const flat: string[] = [];
  for (const a of ads) {
    for (let i = 0; i < a.weight_snapshot; i++) flat.push(a.id);
  }
  return seededShuffle(flat, seed);
}

/**
 * Pick `n` regular ads from a per-(slot, day) shuffled deck.
 *
 * Within a UTC day, each approved regular ad is represented in the deck
 * `weight_snapshot` times; the deck is a deterministic Fisher-Yates shuffle
 * seeded by `${slot}-${day}`, so the long-run order is stable but unpredictable
 * within the day. Each /serve call atomically advances `cursor` by `n` in
 * serve_rotation; concurrent calls get disjoint slices via the single
 * INSERT...ON CONFLICT...UPDATE statement.
 *
 * Mid-day changes (new approval, withdraw, weight edit) shift the (id, weight)
 * signature; on the next /serve we detect the diff, rebuild the bag, and reset
 * the cursor. Slight unfairness during the day of change is the explicit
 * trade-off for "newly approved ads appear immediately".
 *
 * Falls back to weighted-random behavior when only one ad qualifies (bag is
 * just `[id, id, …]` so the shuffle is moot — short-circuit and avoid the
 * extra D1 write).
 */
export async function pickRegularAds(
  client: PgClient,
  slot: string,
  n: number,
): Promise<ServedAd[]> {
  if (n <= 0) return [];
  const adsRes = await client.query<RawWeightedRow>(
    `SELECT id, kind, title, body, link_url, image_key, weight_snapshot
       FROM ads
      WHERE ${ACTIVE_FILTER}
        AND kind = 'regular'
        AND weight_snapshot IS NOT NULL
        AND weight_snapshot > 0
      ORDER BY id`,
    [slot],
  );
  const ads = adsRes.rows;
  if (ads.length === 0) return [];

  // Trivial deck: one ad, just return it (possibly repeated up to n times will
  // be deduped by Set below — but normally n=1 so this is the common path).
  const only = ads[0];
  if (ads.length === 1 && only) {
    return [mapRow(only)];
  }

  const day = utcDay();
  const signature = await sha256Hex(
    ads.map((a) => `${a.id}:${a.weight_snapshot}`).join('|'),
  );
  const seed = `${slot}-${day}-${signature.slice(0, 16)}`;
  const newBag = await buildBag(ads, seed);
  if (newBag.length === 0) return [];

  // Atomic upsert + advance: same-signature increments cursor by n, different
  // signature (or fresh row) resets bag and starts at n. Both branches return
  // the bag we should use and the new cursor (= one past the last position we
  // consumed). `excluded.cursor` carries our intended initial-advance n.
  const advRes = await client.query<{ bag: string; cursor: number }>(
    `INSERT INTO serve_rotation (slot, day, bag, cursor, signature)
       VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (slot, day) DO UPDATE SET
       bag = CASE WHEN serve_rotation.signature = excluded.signature
                   THEN serve_rotation.bag
                   ELSE excluded.bag END,
       cursor = CASE WHEN serve_rotation.signature = excluded.signature
                      THEN serve_rotation.cursor + excluded.cursor
                      ELSE excluded.cursor END,
       signature = excluded.signature,
       updated_at = (unixepoch() * 1000)
     RETURNING bag, cursor`,
    [slot, day, JSON.stringify(newBag), n, signature],
  );
  const row = advRes.rows[0];
  if (!row) return [];
  const bag: string[] = JSON.parse(row.bag);
  if (bag.length === 0) return [];
  const cursor = row.cursor;

  // Consumed slice: [cursor - n, cursor). Modular into bag for wrap-around.
  const adsById = new Map(ads.map((a) => [a.id, a]));
  const seen = new Set<string>();
  const ordered: ServedAd[] = [];
  for (let i = 0; i < n; i++) {
    const pos = ((cursor - n + i) % bag.length + bag.length) % bag.length;
    const id = bag[pos];
    if (!id || seen.has(id)) continue;
    const raw = adsById.get(id);
    if (!raw) continue; // shouldn't happen — bag built from this exact list
    seen.add(id);
    ordered.push(mapRow(raw));
  }
  return ordered;
}

export async function pickHouseAds(
  client: PgClient,
  slot: string,
  n: number,
  excludeIds: string[],
): Promise<ServedAd[]> {
  if (n <= 0) return [];
  // SQLite has no `ALL(array)` operator. Build a dynamic NOT IN list when
  // we have anything to exclude; skip the clause entirely when empty so we
  // don't emit `NOT IN ()` (a syntax error).
  const excludeClause =
    excludeIds.length > 0 ? `AND id NOT IN (${excludeIds.map(() => '?').join(',')})` : '';
  const res = await client.query<RawAdRow>(
    `SELECT id, kind, title, body, link_url, image_key
       FROM ads
      WHERE ${ACTIVE_FILTER}
        AND kind = 'house'
        ${excludeClause}
      ORDER BY random()
      LIMIT ?`,
    [slot, ...excludeIds, n],
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
