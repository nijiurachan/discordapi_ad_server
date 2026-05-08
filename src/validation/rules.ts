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

export async function fetchFormatRules(
  client: PgClient,
  slot: string,
): Promise<FormatRules | null> {
  const res = await client.query<FormatRules>(
    `SELECT slot,
            allowed_mimes        AS "allowedMimes",
            allowed_extensions   AS "allowedExtensions",
            max_bytes            AS "maxBytes",
            min_width            AS "minWidth",
            max_width            AS "maxWidth",
            min_height           AS "minHeight",
            max_height           AS "maxHeight",
            aspect_ratios        AS "aspectRatios",
            COALESCE(aspect_tolerance::float, 0.02) AS "aspectTolerance",
            title_max_len        AS "titleMaxLen",
            body_max_len         AS "bodyMaxLen",
            link_url_max_len     AS "linkUrlMaxLen",
            link_scheme          AS "linkScheme",
            link_domain_allowlist AS "linkDomainAllowlist",
            link_domain_blocklist AS "linkDomainBlocklist"
       FROM ad_format_rules
      WHERE slot = $1
      LIMIT 1`,
    [slot],
  );
  return res.rows[0] ?? null;
}
