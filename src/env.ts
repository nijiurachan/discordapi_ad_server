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
  REVIEWER_ROLE_ID: string;
  ADMIN_ROLE_ID: string;
  POSTGRES_URL: string;
  S3_ENDPOINT: string;
  S3_REGION: string;
  S3_BUCKET: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  SITE_API_KEY?: string;
  IP_HASH_SALT_BOOTSTRAP: string;
  IMPRESSION_TOKEN_SECRET: string;
  WORKER_BASE_URL: string;
  TEST_OVERRIDE_ALLOWED?: string;
  SERVE_RATE_LIMITER: RateLimitBinding;
  CLICK_RATE_LIMITER: RateLimitBinding;
  // Optional Cloudflare Hyperdrive binding. When present (Workers Paid plan
  // + provisioned Hyperdrive instance), `resolveDbUrl()` in src/db/client.ts
  // prefers HYPERDRIVE.connectionString over POSTGRES_URL. Stays optional so
  // local `wrangler dev` and unit tests can run without it.
  HYPERDRIVE?: Hyperdrive;
};
