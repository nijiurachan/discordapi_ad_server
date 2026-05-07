import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            DISCORD_APP_ID: 'test-app',
            DISCORD_APP_BOT_ID: 'test-bot',
            DISCORD_PUBLIC_KEY: '0'.repeat(64),
            DISCORD_BOT_TOKEN: 'test-token',
            GUILD_ID: 'test-guild',
            SUBMIT_CHANNEL_ID: '1',
            REVIEW_CHANNEL_ID: '2',
            ADMIN_CHANNEL_ID: '3',
            FALLBACK_CHANNEL_CATEGORY_ID: '4',
            REVIEWER_ROLE_ID: '5',
            ADMIN_ROLE_ID: '6',
            POSTGRES_URL: 'postgres://localhost/test',
            S3_ENDPOINT: 'http://localhost:9000',
            S3_REGION: 'us-east-1',
            S3_BUCKET: 'test',
            S3_ACCESS_KEY_ID: 'test',
            S3_SECRET_ACCESS_KEY: 'test',
            IP_HASH_SALT_BOOTSTRAP: 'test-salt',
            WORKER_BASE_URL: 'http://localhost:8787',
          },
        },
      },
    },
  },
});
