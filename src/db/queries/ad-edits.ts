import type { PgClient } from '../client.ts';

export type AdEditableFields = {
  title: string;
  body: string;
  linkUrl: string;
  slot: string;
};

export async function getAdEditable(
  client: PgClient,
  adId: string,
): Promise<AdEditableFields | null> {
  const res = await client.query<{
    title: string;
    body: string;
    link_url: string;
    slot: string;
  }>('SELECT title, body, link_url, slot FROM ads WHERE id = ? LIMIT 1', [adId]);
  const row = res.rows[0];
  if (!row) return null;
  return { title: row.title, body: row.body, linkUrl: row.link_url, slot: row.slot };
}

export async function updateAdContent(
  client: PgClient,
  adId: string,
  fields: { title: string; body: string; linkUrl: string },
): Promise<boolean> {
  const res = await client.query('UPDATE ads SET title = ?, body = ?, link_url = ? WHERE id = ?', [
    fields.title,
    fields.body,
    fields.linkUrl,
    adId,
  ]);
  return (res.rowCount ?? 0) > 0;
}

export async function updateAdImage(
  client: PgClient,
  adId: string,
  fields: {
    imageKey: string;
    imageMime: string;
    imageBytes: number;
    imageWidth: number | null;
    imageHeight: number | null;
  },
): Promise<{ previous: { imageKey: string | null; imageMime: string | null } } | null> {
  const before = await client.query<{ image_key: string | null; image_mime: string | null }>(
    'SELECT image_key, image_mime FROM ads WHERE id = ? LIMIT 1',
    [adId],
  );
  if (before.rows.length === 0) return null;
  const previous = {
    imageKey: before.rows[0]?.image_key ?? null,
    imageMime: before.rows[0]?.image_mime ?? null,
  };
  const upd = await client.query(
    `UPDATE ads
        SET image_key = ?,
            image_mime = ?,
            image_bytes = ?,
            image_width = ?,
            image_height = ?
      WHERE id = ?`,
    [
      fields.imageKey,
      fields.imageMime,
      fields.imageBytes,
      fields.imageWidth,
      fields.imageHeight,
      adId,
    ],
  );
  if ((upd.rowCount ?? 0) === 0) return null;
  return { previous };
}
