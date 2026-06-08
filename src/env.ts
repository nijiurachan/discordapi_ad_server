export type RateLimitBinding = {
  limit(args: { key: string }): Promise<{ success: boolean }>;
};

export type Bindings = {
  DISCORD_APP_ID: string;
  DISCORD_APP_BOT_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  GUILD_ID: string;
  SUBMIT_CHANNEL_ID: string;
  REVIEW_CHANNEL_ID: string;
  ADMIN_CHANNEL_ID: string;
  FALLBACK_CHANNEL_CATEGORY_ID: string;
  PORTAL_CHANNEL_CATEGORY_ID: string;
  REVIEWER_ROLE_ID: string;
  ADMIN_ROLE_ID: string;
  S3_ENDPOINT: string;
  S3_REGION: string;
  S3_BUCKET: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  // Public base URL for direct image delivery (bucket must be public-read).
  // /ads/serve returns `${S3_PUBLIC_BASE_URL}<image_key>` so clients fetch
  // images straight from object storage instead of through the Worker proxy.
  // Trailing slash optional — joined safely.
  S3_PUBLIC_BASE_URL: string;
  SITE_API_KEY?: string;
  IP_HASH_SALT_BOOTSTRAP: string;
  IMPRESSION_TOKEN_SECRET: string;
  WORKER_BASE_URL: string;
  TEST_OVERRIDE_ALLOWED?: string;
  SERVE_RATE_LIMITER: RateLimitBinding;
  CLICK_RATE_LIMITER: RateLimitBinding;
  // Cloudflare D1 (SQLite) database. The only DB binding; replaces the prior
  // Postgres + Hyperdrive setup. Bound in wrangler.toml as `DB`.
  DB: D1Database;
};
