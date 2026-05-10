import type { AdFormatRulesInput } from '../../validation/schemas.ts';
import type { PgClient } from '../client.ts';

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
       VALUES ($1, $2, $3, $4,
               $5, $6, $7, $8,
               $9, $10,
               $11, $12, $13,
               $14, $15, $16,
               now(), $17)
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
        updated_at = now(),
        updated_by = EXCLUDED.updated_by`,
    [
      rules.slot,
      rules.allowedMimes,
      rules.allowedExtensions,
      rules.maxBytes,
      rules.minWidth ?? null,
      rules.maxWidth ?? null,
      rules.minHeight ?? null,
      rules.maxHeight ?? null,
      rules.aspectRatios ?? null,
      rules.aspectTolerance ?? null,
      rules.titleMaxLen,
      rules.bodyMaxLen,
      rules.linkUrlMaxLen,
      rules.linkScheme,
      rules.linkDomainAllowlist ?? null,
      rules.linkDomainBlocklist ?? null,
      updatedBy,
    ],
  );
}
