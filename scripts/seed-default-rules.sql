-- Seed: default-slot format rules locked to the IAB Full Banner (468×60).
-- Input must be EXACTLY 468×60 — no auto-resize on the server, so the rule
-- enforces the delivered display size at /ad submit time. Aspect ratio is
-- carried alongside as a defensive check (already implied by the exact dims).
-- Apply with:
--   npx wrangler d1 execute discordadserver --remote \
--       --file=scripts/seed-default-rules.sql
-- After running, re-execute `/ad-setup kind:submit` so the submit menu
-- picks up the new rules in its inline summary.
INSERT INTO ad_format_rules (
  slot, allowed_mimes, allowed_extensions, max_bytes,
  min_width, max_width, min_height, max_height,
  aspect_ratios, aspect_tolerance,
  title_max_len, body_max_len, link_url_max_len, link_scheme,
  updated_at, updated_by
) VALUES (
  'default',
  '["image/png","image/jpeg","image/webp"]',
  '["png","jpg","jpeg","webp"]',
  1048576,
  468, 468, 60, 60,
  -- aspect_ratios kept NULL: min=max=W and min=max=H already pin the shape,
  -- so a separate ratio check would just print noise in the submit menu.
  NULL, 0.02,
  80, 500, 2048,
  '["https"]',
  (unixepoch() * 1000),
  'seed-script'
)
ON CONFLICT (slot) DO UPDATE SET
  allowed_mimes        = excluded.allowed_mimes,
  allowed_extensions   = excluded.allowed_extensions,
  max_bytes            = excluded.max_bytes,
  min_width            = excluded.min_width,
  max_width            = excluded.max_width,
  min_height           = excluded.min_height,
  max_height           = excluded.max_height,
  aspect_ratios        = excluded.aspect_ratios,
  aspect_tolerance     = excluded.aspect_tolerance,
  title_max_len        = excluded.title_max_len,
  body_max_len         = excluded.body_max_len,
  link_url_max_len     = excluded.link_url_max_len,
  link_scheme          = excluded.link_scheme,
  updated_at           = excluded.updated_at,
  updated_by           = excluded.updated_by;
