import type { AdFormatRulesInput } from '../../validation/schemas.ts';
import type { PgClient } from '../client.ts';

// SQLite has no native arrays — `text[]` columns are stored as JSON strings.
// Serialize on write; the read path in src/validation/rules.ts JSON.parses.
const arr = (v: readonly string[] | null | undefined): string | null =>
  v == null ? null : JSON.stringify(v);

export async function upsertAdFormatRules(
  client: PgClient,
  rules: AdFormatRulesInput,
  updatedBy: string,
): Promise<void> {
  await client.query(
    `INSERT INTO ad_format_rules (
        slot, allowed_mimes, allowed_extensions, max_bytes,
        min_width, max_width, min_height, max_height,
        aspect_ratios, aspect_tolerance,
        title_max_len, body_max_len, link_url_max_len,
        link_scheme, link_domain_allowlist, link_domain_blocklist,
        updated_at, updated_by)
       VALUES (?, ?, ?, ?,
               ?, ?, ?, ?,
               ?, ?,
               ?, ?, ?,
               ?, ?, ?,
               (unixepoch() * 1000), ?)
     ON CONFLICT (slot) DO UPDATE SET
        allowed_mimes = EXCLUDED.allowed_mimes,
        allowed_extensions = EXCLUDED.allowed_extensions,
        max_bytes = EXCLUDED.max_bytes,
        min_width = EXCLUDED.min_width,
        max_width = EXCLUDED.max_width,
        min_height = EXCLUDED.min_height,
        max_height = EXCLUDED.max_height,
        aspect_ratios = EXCLUDED.aspect_ratios,
        aspect_tolerance = EXCLUDED.aspect_tolerance,
        title_max_len = EXCLUDED.title_max_len,
        body_max_len = EXCLUDED.body_max_len,
        link_url_max_len = EXCLUDED.link_url_max_len,
        link_scheme = EXCLUDED.link_scheme,
        link_domain_allowlist = EXCLUDED.link_domain_allowlist,
        link_domain_blocklist = EXCLUDED.link_domain_blocklist,
        updated_at = (unixepoch() * 1000),
        updated_by = EXCLUDED.updated_by`,
    [
      rules.slot,
      arr(rules.allowedMimes),
      arr(rules.allowedExtensions),
      rules.maxBytes,
      rules.minWidth ?? null,
      rules.maxWidth ?? null,
      rules.minHeight ?? null,
      rules.maxHeight ?? null,
      arr(rules.aspectRatios),
      rules.aspectTolerance ?? null,
      rules.titleMaxLen,
      rules.bodyMaxLen,
      rules.linkUrlMaxLen,
      arr(rules.linkScheme),
      arr(rules.linkDomainAllowlist),
      arr(rules.linkDomainBlocklist),
      updatedBy,
    ],
  );
}
