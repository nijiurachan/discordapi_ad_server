import { defineConfig } from 'drizzle-kit';

const { POSTGRES_URL } = process.env;

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: POSTGRES_URL ?? 'postgres://localhost/discordadserver',
  },
  strict: true,
  verbose: true,
});
