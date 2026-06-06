import type { PgClient } from '../db/client.ts';

export type FormatRules = {
  slot: string;
  allowedMimes: string[];
  allowedExtensions: string[];
  maxBytes: number;
  minWidth: number | null;
  maxWidth: number | null;
  minHeight: number | null;
  maxHeight: number | null;
  aspectRatios: string[] | null;
  aspectTolerance: number;
  titleMaxLen: number;
  bodyMaxLen: number;
  linkUrlMaxLen: number;
  linkScheme: string[];
  linkDomainAllowlist: string[] | null;
  linkDomainBlocklist: string[] | null;
};

// SQLite stores `text[]` columns as JSON strings (see upsertAdFormatRules).
// Parse on read; treat null/empty as null arrays where appropriate.
function parseArray(v: unknown): string[] | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v as string[];
  if (typeof v !== 'string' || v.length === 0) return null;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

type RawFormatRules = Omit<
  FormatRules,
  | 'allowedMimes'
  | 'allowedExtensions'
  | 'aspectRatios'
  | 'linkScheme'
  | 'linkDomainAllowlist'
  | 'linkDomainBlocklist'
> & {
  allowedMimes: unknown;
  allowedExtensions: unknown;
  aspectRatios: unknown;
  linkScheme: unknown;
  linkDomainAllowlist: unknown;
  linkDomainBlocklist: unknown;
};

export async function fetchFormatRules(
  client: PgClient,
  slot: string,
): Promise<FormatRules | null> {
  const res = await client.query<RawFormatRules>(
    `SELECT slot,
            allowed_mimes        AS allowedMimes,
            allowed_extensions   AS allowedExtensions,
            max_bytes            AS maxBytes,
            min_width            AS minWidth,
            max_width            AS maxWidth,
            min_height           AS minHeight,
            max_height           AS maxHeight,
            aspect_ratios        AS aspectRatios,
            COALESCE(aspect_tolerance, 0.02) AS aspectTolerance,
            title_max_len        AS titleMaxLen,
            body_max_len         AS bodyMaxLen,
            link_url_max_len     AS linkUrlMaxLen,
            link_scheme          AS linkScheme,
            link_domain_allowlist AS linkDomainAllowlist,
            link_domain_blocklist AS linkDomainBlocklist
       FROM ad_format_rules
      WHERE slot = ?
      LIMIT 1`,
    [slot],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    ...r,
    allowedMimes: parseArray(r.allowedMimes) ?? [],
    allowedExtensions: parseArray(r.allowedExtensions) ?? [],
    aspectRatios: parseArray(r.aspectRatios),
    linkScheme: parseArray(r.linkScheme) ?? ['https'],
    linkDomainAllowlist: parseArray(r.linkDomainAllowlist),
    linkDomainBlocklist: parseArray(r.linkDomainBlocklist),
  };
}
