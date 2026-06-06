import { defineConfig } from 'drizzle-kit';

// D1 (SQLite). Migrations live under ./migrations as plain SQL files generated
// by `npx drizzle-kit generate`. Apply them to the deployed D1 with:
//   npx wrangler d1 execute discordadserver --remote --file=migrations/<N>_<name>.sql
// (or `wrangler d1 migrations apply discordadserver --remote` if you use
// the wrangler-managed migration tracker).
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'sqlite',
  strict: true,
  verbose: true,
});
