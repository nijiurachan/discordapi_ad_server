# P1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cloudflare Workers + Hono + TypeScript + Postgres + S3 + Discord Interactions の最小土台を構築し、`/health` と `/interactions` (PING/PONG) が動く状態にする。後続フェーズ (P2–P7) はこの土台に乗せて開発する。

**Architecture:** 単一の Cloudflare Worker (Hono) がエントリポイント。Postgres は `pg` クライアント（将来 Hyperdrive 化可）、S3 互換ストレージは `@aws-sdk/client-s3` 経由。Discord 受信は HTTP Interactions Endpoint URL、署名は Ed25519 検証。drizzle-orm でスキーマ管理、drizzle-kit でマイグレーション。

**Tech Stack:**
- Runtime: Cloudflare Workers (Module Workers, ESM)
- Language: TypeScript 5.x (strict)
- Framework: Hono v4
- DB: PostgreSQL via `pg` (node-postgres, Workers `nodejs_compat` モード)
- ORM/Migrations: drizzle-orm + drizzle-kit
- Object Storage: `@aws-sdk/client-s3`
- Crypto: `tweetnacl` (Ed25519)
- Test: vitest + `@cloudflare/vitest-pool-workers`
- Lint/Format: biome
- CI: GitHub Actions

---

## File Structure

| パス | 役割 |
|---|---|
| `package.json` | 依存・スクリプト |
| `tsconfig.json` | strict TypeScript 設定 |
| `wrangler.toml` | Workers 設定（環境分離・nodejs_compat） |
| `biome.json` | Lint/format |
| `.gitignore` | node_modules, dist, .dev.vars, .wrangler 等を除外 |
| `.editorconfig` | 行末 LF、UTF-8、インデント 2 |
| `.env.example` | 必要な env 一覧（spec §8 と整合） |
| `README.md` | セットアップ・実行・デプロイ手順 |
| `vitest.config.ts` | Vitest + workers pool |
| `drizzle.config.ts` | drizzle-kit 設定 |
| `src/index.ts` | Hono エントリ。`/health` `/interactions` をマウント |
| `src/env.ts` | env 型定義 (Bindings) |
| `src/health.ts` | `/health` ハンドラ（DB/S3/Discord 到達性チェック） |
| `src/db/client.ts` | Postgres クライアント生成 |
| `src/db/schema.ts` | drizzle スキーマ（spec §3 のテーブル全部） |
| `src/storage/s3.ts` | S3 クライアントラッパ |
| `src/discord/verify.ts` | Ed25519 署名検証 |
| `src/discord/rest.ts` | Discord REST 呼び出しラッパ（最小実装） |
| `src/discord/types.ts` | Discord interaction 型定義（必要分のみ） |
| `src/interactions/router.ts` | `/interactions` PING/PONG 応答 + 後続フェーズの拡張点 |
| `src/cron/index.ts` | scheduled handler の枠だけ（空ハンドラ + logger） |
| `migrations/0000_init.sql` | 初期マイグレーション (drizzle-kit generate 出力) |
| `tests/health.test.ts` | `/health` テスト |
| `tests/discord/verify.test.ts` | Ed25519 署名検証テスト |
| `tests/interactions/ping.test.ts` | PING/PONG テスト |
| `.github/workflows/ci.yml` | typecheck + test |
| `scripts/register-commands.ts` | Discord スラッシュコマンド登録（雛形のみ。P2 で本格使用） |

---

## Task 1: プロジェクト初期化（package.json / tsconfig / wrangler / .gitignore / .editorconfig / .env.example）

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `wrangler.toml`
- Create: `.gitignore`
- Create: `.editorconfig`
- Create: `.env.example`
- Create: `biome.json`

- [ ] **Step 1: `.gitignore` を作成**

```
node_modules/
dist/
.wrangler/
.dev.vars
.env
.env.local
*.log
.DS_Store
coverage/
```

- [ ] **Step 2: `.editorconfig` を作成**

```
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

- [ ] **Step 3: `package.json` を作成**

```json
{
  "name": "discordapi_ad_server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "deploy:staging": "wrangler deploy --env staging",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "biome check .",
    "format": "biome format --write .",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "discord:register": "tsx scripts/register-commands.ts"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.700.0",
    "drizzle-orm": "^0.36.0",
    "hono": "^4.6.0",
    "pg": "^8.13.0",
    "tweetnacl": "^1.0.3"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "@cloudflare/workers-types": "^4.20250101.0",
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0",
    "drizzle-kit": "^0.28.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "wrangler": "^3.90.0"
  },
  "engines": {
    "node": ">=20.10.0"
  }
}
```

- [ ] **Step 4: `tsconfig.json` を作成**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types", "vitest/globals"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "jsxImportSource": "hono/jsx",
    "baseUrl": ".",
    "paths": {
      "~/*": ["./src/*"]
    }
  },
  "include": ["src/**/*", "tests/**/*", "scripts/**/*", "*.ts", "*.config.ts"],
  "exclude": ["node_modules", "dist", ".wrangler"]
}
```

- [ ] **Step 5: `wrangler.toml` を作成**

```toml
name = "discordapi-ad-server"
main = "src/index.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

[observability]
enabled = true

[triggers]
crons = ["0 * * * *"]

[env.staging]
name = "discordapi-ad-server-staging"

[env.production]
name = "discordapi-ad-server"
```

- [ ] **Step 6: `.env.example` を作成（spec §8 と整合）**

```bash
# Discord
DISCORD_APP_ID=
DISCORD_APP_BOT_ID=
DISCORD_PUBLIC_KEY=
DISCORD_BOT_TOKEN=
GUILD_ID=
SUBMIT_CHANNEL_ID=
REVIEW_CHANNEL_ID=
ADMIN_CHANNEL_ID=
FALLBACK_CHANNEL_CATEGORY_ID=
REVIEWER_ROLE_ID=
ADMIN_ROLE_ID=

# Storage
POSTGRES_URL=postgres://user:pass@host:5432/discordadserver
S3_ENDPOINT=https://nas-host:9000
S3_REGION=us-east-1
S3_BUCKET=ad-server
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=

# Worker
SITE_API_KEY=
IP_HASH_SALT_BOOTSTRAP=
WORKER_BASE_URL=https://ads.example.com
```

- [ ] **Step 7: `biome.json` を作成**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "ignore": [".wrangler/**", "dist/**", "migrations/**"] },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": { "recommended": true }
  }
}
```

- [ ] **Step 8: 依存をインストール**

Run: `npm install`
Expected: `node_modules/` が作られる、`package-lock.json` が生成される。エラーなし。

- [ ] **Step 9: typecheck が通ることを確認（まだソース無し、設定の妥当性チェック）**

Run: `npx tsc --noEmit`
Expected: 何もエラーなし。`include` に該当ファイルが無くても OK。

- [ ] **Step 10: コミット**

```bash
git add package.json package-lock.json tsconfig.json wrangler.toml \
        .gitignore .editorconfig .env.example biome.json
git commit -m "chore: initialize Cloudflare Workers + Hono + TypeScript scaffold"
```

---

## Task 2: Hono アプリと `/health` の最小実装

**Files:**
- Create: `src/env.ts`
- Create: `src/index.ts`
- Create: `src/health.ts`

- [ ] **Step 1: `src/env.ts` で env 型を定義**

```ts
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
  WORKER_BASE_URL: string;
};
```

- [ ] **Step 2: `src/health.ts` で `/health` ハンドラを書く（DB/S3 はまだ繋がない、土台のみ）**

```ts
import { Hono } from 'hono';
import type { Bindings } from './env.ts';

export const health = new Hono<{ Bindings: Bindings }>();

health.get('/', (c) =>
  c.json({
    status: 'ok',
    service: 'discordapi_ad_server',
    time: new Date().toISOString(),
  }),
);
```

- [ ] **Step 3: `src/index.ts` でルーター束ねる**

```ts
import { Hono } from 'hono';
import type { Bindings } from './env.ts';
import { health } from './health.ts';

const app = new Hono<{ Bindings: Bindings }>();

app.route('/health', health);

app.get('/', (c) => c.text('discordapi_ad_server'));

export default {
  fetch: app.fetch,
  // P1: scheduled は空ハンドラ。P7 で実装
  scheduled: async (
    _ev: ScheduledController,
    _env: Bindings,
    _ctx: ExecutionContext,
  ): Promise<void> => {
    // intentionally empty for P1
  },
} satisfies ExportedHandler<Bindings>;
```

- [ ] **Step 4: typecheck が通ることを確認**

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/
git commit -m "feat: add Hono app skeleton with /health endpoint"
```

---

## Task 3: Vitest + workers pool セットアップと `/health` テスト

**Files:**
- Create: `vitest.config.ts`
- Create: `tests/health.test.ts`

- [ ] **Step 1: `vitest.config.ts` を作成**

```ts
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
```

- [ ] **Step 2: 失敗するテストを書く**

`tests/health.test.ts`:

```ts
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('/health', () => {
  it('returns ok with timestamp', async () => {
    const res = await SELF.fetch('http://example.com/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string; time: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('discordapi_ad_server');
    expect(new Date(body.time).toString()).not.toBe('Invalid Date');
  });
});
```

- [ ] **Step 3: テスト実行で PASS することを確認**

Run: `npm test`
Expected: `1 passed`

（既に Task 2 で実装済みなので即 PASS する。これは setup 確認）

- [ ] **Step 4: コミット**

```bash
git add vitest.config.ts tests/
git commit -m "test: set up vitest with workers pool and /health test"
```

---

## Task 4: Drizzle スキーマ（spec §3 の全テーブル）

**Files:**
- Create: `src/db/schema.ts`
- Create: `drizzle.config.ts`

- [ ] **Step 1: `src/db/schema.ts` で全テーブルを定義**

```ts
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const tiers = pgTable('tiers', {
  id: serial('id').primaryKey(),
  discordRoleId: text('discord_role_id').notNull().unique(),
  name: text('name').notNull(),
  weight: integer('weight').notNull(),
  maxActiveAds: integer('max_active_ads').notNull().default(1),
  rank: integer('rank').notNull(),
}, (t) => ({
  weightCheck: check('tiers_weight_positive', sql`${t.weight} > 0`),
}));

export const sponsors = pgTable('sponsors', {
  discordUserId: text('discord_user_id').primaryKey(),
  displayName: text('display_name').notNull(),
  currentTierId: integer('current_tier_id').references(() => tiers.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ads = pgTable('ads', {
  id: uuid('id').primaryKey().defaultRandom(),
  sponsorId: text('sponsor_id').references(() => sponsors.discordUserId),
  kind: text('kind').notNull().default('regular'),
  slot: text('slot').notNull().default('default'),
  title: text('title').notNull(),
  body: text('body').notNull(),
  linkUrl: text('link_url').notNull(),
  imageKey: text('image_key'),
  imageMime: text('image_mime'),
  imageBytes: integer('image_bytes'),
  imageWidth: integer('image_width'),
  imageHeight: integer('image_height'),
  status: text('status').notNull(),
  weightSnapshot: integer('weight_snapshot'),
  rejectReason: text('reject_reason'),
  reviewedBy: text('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  createdByAdmin: text('created_by_admin'),
  dmDeliveryStatus: text('dm_delivery_status'),
  dmDeliveredAt: timestamp('dm_delivered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  kindCheck: check(
    'ads_kind_check',
    sql`${t.kind} IN ('regular','house','placeholder')`,
  ),
  statusCheck: check(
    'ads_status_check',
    sql`${t.status} IN ('pending','approved','paused','rejected','expired','withdrawn')`,
  ),
  dmStatusCheck: check(
    'ads_dm_status_check',
    sql`${t.dmDeliveryStatus} IS NULL OR ${t.dmDeliveryStatus} IN
        ('pending','sent','failed','fallback_posted','fallback_acknowledged')`,
  ),
  kindSponsorCheck: check(
    'ads_kind_sponsor',
    sql`(${t.kind} = 'regular' AND ${t.sponsorId} IS NOT NULL)
     OR (${t.kind} IN ('house','placeholder') AND ${t.sponsorId} IS NULL)`,
  ),
  activeIdx: index('ads_active_idx')
    .on(t.status, t.kind, t.slot, t.startsAt, t.endsAt)
    .where(sql`${t.status} = 'approved'`),
}));

export const adFormatRules = pgTable('ad_format_rules', {
  id: serial('id').primaryKey(),
  slot: text('slot').notNull().unique(),
  allowedMimes: text('allowed_mimes').array().notNull(),
  allowedExtensions: text('allowed_extensions').array().notNull(),
  maxBytes: integer('max_bytes').notNull(),
  minWidth: integer('min_width'),
  maxWidth: integer('max_width'),
  minHeight: integer('min_height'),
  maxHeight: integer('max_height'),
  aspectRatios: text('aspect_ratios').array(),
  aspectTolerance: numeric('aspect_tolerance', { precision: 4, scale: 3 }).default('0.020'),
  titleMaxLen: integer('title_max_len').notNull().default(80),
  bodyMaxLen: integer('body_max_len').notNull().default(500),
  linkUrlMaxLen: integer('link_url_max_len').notNull().default(2048),
  linkScheme: text('link_scheme').array().notNull().default(sql`ARRAY['https']::text[]`),
  linkDomainAllowlist: text('link_domain_allowlist').array(),
  linkDomainBlocklist: text('link_domain_blocklist').array(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by'),
});

export const adDrafts = pgTable('ad_drafts', {
  id: uuid('id').primaryKey().defaultRandom(),
  sponsorId: text('sponsor_id').notNull(),
  slot: text('slot').notNull(),
  imageKey: text('image_key').notNull(),
  imageMime: text('image_mime').notNull(),
  imageBytes: integer('image_bytes').notNull(),
  imageWidth: integer('image_width'),
  imageHeight: integer('image_height'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const adEvents = pgTable('ad_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  adId: uuid('ad_id').notNull().references(() => ads.id),
  eventType: text('event_type').notNull(),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  ipHash: text('ip_hash'),
  ua: text('ua'),
  slot: text('slot'),
}, (t) => ({
  typeCheck: check('ad_events_type_check', sql`${t.eventType} IN ('impression','click')`),
}));

export const reviewLogs = pgTable('review_logs', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  adId: uuid('ad_id').notNull().references(() => ads.id),
  reviewerId: text('reviewer_id').notNull(),
  action: text('action').notNull(),
  reason: text('reason'),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  actionCheck: check(
    'review_logs_action_check',
    sql`${t.action} IN ('approved','rejected','withdrawn')`,
  ),
}));

export const adminLogs = pgTable('admin_logs', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  actorId: text('actor_id').notNull(),
  action: text('action').notNull(),
  targetKind: text('target_kind').notNull(),
  targetId: text('target_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
});

export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by'),
});

export const dmFallbackChannels = pgTable('dm_fallback_channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  adId: uuid('ad_id').notNull().references(() => ads.id),
  sponsorId: text('sponsor_id').notNull(),
  channelId: text('channel_id').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
}, (t) => ({
  pendingIdx: index('dm_fallback_pending_idx')
    .on(t.expiresAt)
    .where(sql`${t.acknowledgedAt} IS NULL`),
}));
```

- [ ] **Step 2: `drizzle.config.ts` を作成**

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.POSTGRES_URL ?? 'postgres://localhost/discordadserver',
  },
  strict: true,
  verbose: true,
});
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 4: マイグレーション生成**

Run: `npm run db:generate`
Expected: `migrations/0000_<random_name>.sql` と `migrations/meta/` が作成される。

- [ ] **Step 5: 生成された SQL を `migrations/0000_init.sql` にリネーム**

Run: `mv migrations/0000_*.sql migrations/0000_init.sql`
Expected: ファイル名が変わる。drizzle-kit のメタは生成名でも参照可能。
変更があった場合の影響を避けるため、`migrations/meta/_journal.json` 内のエントリ名も `0000_init` に書き換える。

- [ ] **Step 6: コミット**

```bash
git add src/db/schema.ts drizzle.config.ts migrations/
git commit -m "feat: add drizzle schema and initial migration for all tables"
```

---

## Task 5: Postgres クライアント生成と `/health` への DB ヘルスチェック組み込み

**Files:**
- Create: `src/db/client.ts`
- Modify: `src/health.ts`
- Create: `tests/db/client.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`tests/db/client.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createPgClient } from '../../src/db/client.ts';

describe('createPgClient', () => {
  it('returns an object with end() and a query() method bound to a pool', () => {
    const c = createPgClient('postgres://localhost/test');
    expect(typeof c.query).toBe('function');
    expect(typeof c.end).toBe('function');
  });

  it('throws when url is empty', () => {
    expect(() => createPgClient('')).toThrow(/POSTGRES_URL/);
  });
});
```

- [ ] **Step 2: テスト実行で FAIL することを確認**

Run: `npm test -- tests/db/client.test.ts`
Expected: ファイルが見つからずエラー。

- [ ] **Step 3: `src/db/client.ts` を実装**

```ts
import pg from 'pg';

export type PgClient = {
  query: pg.Pool['query'];
  end: () => Promise<void>;
};

export function createPgClient(url: string): PgClient {
  if (!url) throw new Error('POSTGRES_URL is required');
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  return {
    query: pool.query.bind(pool),
    end: () => pool.end(),
  };
}
```

- [ ] **Step 4: テスト実行で PASS することを確認**

Run: `npm test -- tests/db/client.test.ts`
Expected: `2 passed`

- [ ] **Step 5: `src/health.ts` を更新して DB 到達性をチェック**

```ts
import { Hono } from 'hono';
import type { Bindings } from './env.ts';
import { createPgClient } from './db/client.ts';

export const health = new Hono<{ Bindings: Bindings }>();

health.get('/', async (c) => {
  const checks: Record<string, 'ok' | string> = {};
  let overall: 'ok' | 'degraded' = 'ok';

  try {
    const db = createPgClient(c.env.POSTGRES_URL);
    await db.query('SELECT 1');
    await db.end();
    checks.db = 'ok';
  } catch (err) {
    checks.db = err instanceof Error ? err.message : 'unknown error';
    overall = 'degraded';
  }

  return c.json(
    {
      status: overall,
      service: 'discordapi_ad_server',
      time: new Date().toISOString(),
      checks,
    },
    overall === 'ok' ? 200 : 503,
  );
});
```

- [ ] **Step 6: 既存 `/health` テストが互換動作することを確認**

`tests/health.test.ts` を更新（DB が無い環境でも 503 になるが、JSON 形式は維持）:

```ts
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('/health', () => {
  it('returns json with status field and timestamp regardless of dependency state', async () => {
    const res = await SELF.fetch('http://example.com/health');
    expect([200, 503]).toContain(res.status);
    const body = (await res.json()) as {
      status: string;
      service: string;
      time: string;
      checks: Record<string, string>;
    };
    expect(body.service).toBe('discordapi_ad_server');
    expect(['ok', 'degraded']).toContain(body.status);
    expect(typeof body.checks.db).toBe('string');
    expect(new Date(body.time).toString()).not.toBe('Invalid Date');
  });
});
```

- [ ] **Step 7: テスト実行で全 PASS することを確認**

Run: `npm test`
Expected: 全て pass（DB が無くても `degraded` で 503 を返すので OK）。

- [ ] **Step 8: コミット**

```bash
git add src/db/client.ts src/health.ts tests/db/ tests/health.test.ts
git commit -m "feat: add Postgres client wrapper and wire DB check into /health"
```

---

## Task 6: S3 クライアントラッパと `/health` への S3 ヘルスチェック組み込み

**Files:**
- Create: `src/storage/s3.ts`
- Modify: `src/health.ts`
- Create: `tests/storage/s3.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`tests/storage/s3.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createS3Client } from '../../src/storage/s3.ts';

describe('createS3Client', () => {
  it('returns a client with HeadBucketCommand-capable send()', () => {
    const client = createS3Client({
      endpoint: 'http://localhost:9000',
      region: 'us-east-1',
      accessKeyId: 'a',
      secretAccessKey: 'b',
    });
    expect(typeof client.send).toBe('function');
  });

  it('throws when endpoint is empty', () => {
    expect(() =>
      createS3Client({ endpoint: '', region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 'b' }),
    ).toThrow(/endpoint/);
  });
});
```

- [ ] **Step 2: テスト実行で FAIL することを確認**

Run: `npm test -- tests/storage/s3.test.ts`
Expected: ファイルが見つからずエラー。

- [ ] **Step 3: `src/storage/s3.ts` を実装**

```ts
import { S3Client } from '@aws-sdk/client-s3';

export type S3Config = {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export function createS3Client(cfg: S3Config): S3Client {
  if (!cfg.endpoint) throw new Error('S3 endpoint is required');
  return new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });
}
```

- [ ] **Step 4: テスト実行で PASS することを確認**

Run: `npm test -- tests/storage/s3.test.ts`
Expected: `2 passed`

- [ ] **Step 5: `src/health.ts` に S3 チェックを追加**

`src/health.ts` の DB チェック直後に以下を挿入:

```ts
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { createS3Client } from './storage/s3.ts';

// ... 既存 import 群の下

  try {
    const s3 = createS3Client({
      endpoint: c.env.S3_ENDPOINT,
      region: c.env.S3_REGION,
      accessKeyId: c.env.S3_ACCESS_KEY_ID,
      secretAccessKey: c.env.S3_SECRET_ACCESS_KEY,
    });
    await s3.send(new HeadBucketCommand({ Bucket: c.env.S3_BUCKET }));
    checks.s3 = 'ok';
  } catch (err) {
    checks.s3 = err instanceof Error ? err.message : 'unknown error';
    overall = 'degraded';
  }
```

- [ ] **Step 6: 全テスト実行で PASS（または 503 で互換）**

Run: `npm test`
Expected: 全 PASS。

- [ ] **Step 7: コミット**

```bash
git add src/storage/s3.ts src/health.ts tests/storage/
git commit -m "feat: add S3 client wrapper and wire S3 check into /health"
```

---

## Task 7: Ed25519 署名検証ユーティリティ

**Files:**
- Create: `src/discord/verify.ts`
- Create: `tests/discord/verify.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`tests/discord/verify.test.ts`:

```ts
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import { verifyDiscordSignature } from '../../src/discord/verify.ts';

function toHex(u8: Uint8Array) {
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('verifyDiscordSignature', () => {
  const keypair = nacl.sign.keyPair();
  const publicKeyHex = toHex(keypair.publicKey);

  it('returns true for a valid signature', async () => {
    const timestamp = '1700000000';
    const body = '{"type":1}';
    const message = new TextEncoder().encode(timestamp + body);
    const sig = toHex(nacl.sign.detached(message, keypair.secretKey));
    const ok = await verifyDiscordSignature({
      publicKeyHex,
      signatureHex: sig,
      timestamp,
      body,
    });
    expect(ok).toBe(true);
  });

  it('returns false for a tampered body', async () => {
    const timestamp = '1700000000';
    const body = '{"type":1}';
    const message = new TextEncoder().encode(timestamp + body);
    const sig = toHex(nacl.sign.detached(message, keypair.secretKey));
    const ok = await verifyDiscordSignature({
      publicKeyHex,
      signatureHex: sig,
      timestamp,
      body: '{"type":2}',
    });
    expect(ok).toBe(false);
  });

  it('returns false when signature hex is malformed', async () => {
    const ok = await verifyDiscordSignature({
      publicKeyHex,
      signatureHex: 'not-hex',
      timestamp: '1',
      body: '',
    });
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: テスト実行で FAIL することを確認**

Run: `npm test -- tests/discord/verify.test.ts`
Expected: ファイルが見つからずエラー。

- [ ] **Step 3: `src/discord/verify.ts` を実装**

```ts
import nacl from 'tweetnacl';

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

export type VerifyArgs = {
  publicKeyHex: string;
  signatureHex: string;
  timestamp: string;
  body: string;
};

export async function verifyDiscordSignature(args: VerifyArgs): Promise<boolean> {
  const sig = hexToBytes(args.signatureHex);
  const pub = hexToBytes(args.publicKeyHex);
  if (!sig || !pub) return false;
  const msg = new TextEncoder().encode(args.timestamp + args.body);
  try {
    return nacl.sign.detached.verify(msg, sig, pub);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: テスト実行で PASS することを確認**

Run: `npm test -- tests/discord/verify.test.ts`
Expected: `3 passed`

- [ ] **Step 5: コミット**

```bash
git add src/discord/verify.ts tests/discord/
git commit -m "feat: add Ed25519 signature verification for Discord interactions"
```

---

## Task 8: `/interactions` エンドポイント（PING/PONG + 署名検証）

**Files:**
- Create: `src/discord/types.ts`
- Create: `src/interactions/router.ts`
- Modify: `src/index.ts`
- Create: `tests/interactions/ping.test.ts`

- [ ] **Step 1: `src/discord/types.ts` で必要な型を定義**

```ts
export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  MODAL: 9,
} as const;

export type InteractionType = (typeof InteractionType)[keyof typeof InteractionType];
export type InteractionResponseType =
  (typeof InteractionResponseType)[keyof typeof InteractionResponseType];

export type InteractionPayload = {
  type: InteractionType;
  // 後続フェーズで拡張。P1 では PING の判定だけできれば十分
};
```

- [ ] **Step 2: 失敗するテストを書く**

`tests/interactions/ping.test.ts`:

```ts
import { SELF } from 'cloudflare:test';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

function toHex(u8: Uint8Array) {
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}

const keypair = nacl.sign.keyPair();
const publicKeyHex = toHex(keypair.publicKey);

function sign(timestamp: string, body: string) {
  const msg = new TextEncoder().encode(timestamp + body);
  return toHex(nacl.sign.detached(msg, keypair.secretKey));
}

describe('/interactions', () => {
  it('rejects requests with bad signature with 401', async () => {
    const res = await SELF.fetch('http://example.com/interactions', {
      method: 'POST',
      headers: {
        'X-Signature-Ed25519': '00'.repeat(64),
        'X-Signature-Timestamp': '1',
        'Content-Type': 'application/json',
        'X-Public-Key-Override': publicKeyHex,
      },
      body: '{"type":1}',
    });
    expect(res.status).toBe(401);
  });

  it('responds PONG (type=1) for a signed PING', async () => {
    const timestamp = '1700000000';
    const body = '{"type":1}';
    const sig = sign(timestamp, body);
    const res = await SELF.fetch('http://example.com/interactions', {
      method: 'POST',
      headers: {
        'X-Signature-Ed25519': sig,
        'X-Signature-Timestamp': timestamp,
        'Content-Type': 'application/json',
        'X-Public-Key-Override': publicKeyHex,
      },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number };
    expect(json.type).toBe(1);
  });
});
```

`X-Public-Key-Override` はテスト時に env の固定値を上書きするための専用ヘッダ（後段で実装）。本番は無視されるよう gating する。

- [ ] **Step 3: テスト実行で FAIL することを確認**

Run: `npm test -- tests/interactions/ping.test.ts`
Expected: ルート未定義で 404 が返り FAIL。

- [ ] **Step 4: `src/interactions/router.ts` を実装**

```ts
import { Hono } from 'hono';
import type { Bindings } from '../env.ts';
import { verifyDiscordSignature } from '../discord/verify.ts';
import { InteractionResponseType, InteractionType } from '../discord/types.ts';

export const interactions = new Hono<{ Bindings: Bindings }>();

interactions.post('/', async (c) => {
  const sig = c.req.header('X-Signature-Ed25519');
  const ts = c.req.header('X-Signature-Timestamp');
  if (!sig || !ts) return c.text('missing signature headers', 401);

  // テスト時のみ public key を上書き可。本番環境では env を信頼する。
  const override = c.req.header('X-Public-Key-Override');
  const publicKeyHex =
    c.env.DISCORD_PUBLIC_KEY === '0'.repeat(64) && override ? override : c.env.DISCORD_PUBLIC_KEY;

  const body = await c.req.text();
  const ok = await verifyDiscordSignature({
    publicKeyHex,
    signatureHex: sig,
    timestamp: ts,
    body,
  });
  if (!ok) return c.text('invalid signature', 401);

  const payload = JSON.parse(body) as { type: number };
  if (payload.type === InteractionType.PING) {
    return c.json({ type: InteractionResponseType.PONG });
  }

  // P1 では PING のみ対応。それ以外は 501 でフェーズ未実装を示す。
  return c.json({ error: 'not implemented in P1' }, 501);
});
```

- [ ] **Step 5: `src/index.ts` を更新してマウント**

```ts
import { Hono } from 'hono';
import type { Bindings } from './env.ts';
import { health } from './health.ts';
import { interactions } from './interactions/router.ts';

const app = new Hono<{ Bindings: Bindings }>();

app.route('/health', health);
app.route('/interactions', interactions);

app.get('/', (c) => c.text('discordapi_ad_server'));

export default {
  fetch: app.fetch,
  scheduled: async (
    _ev: ScheduledController,
    _env: Bindings,
    _ctx: ExecutionContext,
  ): Promise<void> => {},
} satisfies ExportedHandler<Bindings>;
```

- [ ] **Step 6: テスト実行で全 PASS することを確認**

Run: `npm test`
Expected: 全テスト pass。

- [ ] **Step 7: コミット**

```bash
git add src/discord/types.ts src/interactions/ src/index.ts tests/interactions/
git commit -m "feat: add /interactions endpoint with Ed25519 verify and PING/PONG"
```

---

## Task 9: Discord REST 呼び出しラッパ（最小実装）

**Files:**
- Create: `src/discord/rest.ts`
- Create: `tests/discord/rest.test.ts`

P1 では「実際に Discord を叩く」テストは不要。fetch をモック注入して URL/headers/body の組み立て確認だけする。

- [ ] **Step 1: 失敗するテストを書く**

`tests/discord/rest.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createDiscordRest } from '../../src/discord/rest.ts';

describe('createDiscordRest', () => {
  it('GETs the right URL with bot auth', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'c1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const rest = createDiscordRest({ token: 'tkn', fetch: fetchMock });
    const ch = await rest.getChannel('123');
    expect(ch.id).toBe('c1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://discord.com/api/v10/channels/123');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bot tkn',
    });
  });

  it('throws DiscordRestError on non-2xx', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ message: 'unknown' }), { status: 404 }),
    );
    const rest = createDiscordRest({ token: 'tkn', fetch: fetchMock });
    await expect(rest.getChannel('x')).rejects.toThrow(/404/);
  });
});
```

- [ ] **Step 2: テスト実行で FAIL することを確認**

Run: `npm test -- tests/discord/rest.test.ts`
Expected: ファイルが見つからずエラー。

- [ ] **Step 3: `src/discord/rest.ts` を実装**

```ts
const BASE_URL = 'https://discord.com/api/v10';

export class DiscordRestError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
  ) {
    super(`Discord API error ${status}: ${bodyText.slice(0, 200)}`);
    this.name = 'DiscordRestError';
  }
}

export type DiscordRestOptions = {
  token: string;
  fetch?: typeof fetch;
};

type Json = Record<string, unknown>;

async function request<T>(
  opts: Required<DiscordRestOptions>,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: Json,
): Promise<T> {
  const res = await opts.fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${opts.token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new DiscordRestError(res.status, text);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export type Channel = { id: string; name?: string; type: number };
export type Message = { id: string; channel_id: string };

export function createDiscordRest(o: DiscordRestOptions) {
  const opts = { token: o.token, fetch: o.fetch ?? fetch };
  return {
    getChannel: (id: string) => request<Channel>(opts, 'GET', `/channels/${id}`),
    deleteChannel: (id: string) => request<void>(opts, 'DELETE', `/channels/${id}`),
    createDmChannel: (recipientId: string) =>
      request<Channel>(opts, 'POST', '/users/@me/channels', { recipient_id: recipientId }),
    createMessage: (channelId: string, body: Json) =>
      request<Message>(opts, 'POST', `/channels/${channelId}/messages`, body),
    editMessage: (channelId: string, messageId: string, body: Json) =>
      request<Message>(opts, 'PATCH', `/channels/${channelId}/messages/${messageId}`, body),
    createGuildChannel: (guildId: string, body: Json) =>
      request<Channel>(opts, 'POST', `/guilds/${guildId}/channels`, body),
  };
}

export type DiscordRest = ReturnType<typeof createDiscordRest>;
```

- [ ] **Step 4: テスト実行で PASS することを確認**

Run: `npm test -- tests/discord/rest.test.ts`
Expected: `2 passed`

- [ ] **Step 5: コミット**

```bash
git add src/discord/rest.ts tests/discord/rest.test.ts
git commit -m "feat: add Discord REST wrapper with channel/message/dm primitives"
```

---

## Task 10: Discord スラッシュコマンド登録スクリプトの雛形

**Files:**
- Create: `scripts/register-commands.ts`

P1 ではコマンド本体はまだ無い。雛形だけ用意して P2 で本格化する。

- [ ] **Step 1: 雛形を作成**

```ts
// Usage: tsx scripts/register-commands.ts
//
// Reads env from .env (or .dev.vars) and registers slash commands to a guild.
// In P1 this only registers a placeholder /ping command for liveness testing.

const APP_ID = process.env.DISCORD_APP_ID;
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;

if (!APP_ID || !TOKEN || !GUILD_ID) {
  console.error('DISCORD_APP_ID, DISCORD_BOT_TOKEN, GUILD_ID are required');
  process.exit(1);
}

const commands = [
  {
    name: 'ping',
    description: 'liveness check (P1 placeholder)',
    type: 1,
  },
];

const url = `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`;
const res = await fetch(url, {
  method: 'PUT',
  headers: {
    Authorization: `Bot ${TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(commands),
});

if (!res.ok) {
  console.error('register failed:', res.status, await res.text());
  process.exit(1);
}

console.log('registered:', await res.json());
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 3: コミット**

```bash
git add scripts/register-commands.ts
git commit -m "chore: add slash command registration script skeleton"
```

---

## Task 11: GitHub Actions CI（typecheck + test）

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: ファイルを作成**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run lint
```

- [ ] **Step 2: コミット**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions for typecheck, test, and lint"
```

- [ ] **Step 3: push して CI が緑になることを確認**

Run: `git push`
Expected: GitHub の Actions タブで CI が PASS。失敗したら原因を修正してから次タスクへ。

---

## Task 12: README にセットアップ手順を書く

**Files:**
- Create: `README.md`

- [ ] **Step 1: 内容を作成**

````markdown
# discordapi_ad_server

Discord 連動の広告配信サーバ。詳細は [仕様書](docs/superpowers/specs/2026-05-07-discord-ad-server-design.md) を参照。

## P1 (Foundation) スコープ

- Cloudflare Workers + Hono + TypeScript
- `/health` で DB / S3 到達性チェック
- `/interactions` で Discord PING/PONG（Ed25519 検証）
- drizzle-orm + 全テーブルの初期マイグレーション
- vitest + GitHub Actions CI

## セットアップ

### 必要要件

- Node.js 20.10 以上
- 既存 PostgreSQL（外部から TLS で到達可能）
- 既存 NAS の S3 互換エンドポイント（HTTPS、AWS SDK 互換）
- Cloudflare Workers アカウント
- Discord アプリケーション（Application + Bot ユーザー）

### 1. 依存インストール

```bash
npm install
```

### 2. env を用意

```bash
cp .env.example .dev.vars
# 各値を埋める。.dev.vars は wrangler dev で読まれる
```

### 3. DB マイグレーション

```bash
export POSTGRES_URL=postgres://...
npm run db:generate     # schema.ts から SQL を生成
npm run db:migrate      # 実 DB に適用
```

### 4. ローカル起動

```bash
npm run dev
```

`http://localhost:8787/health` を開いて DB/S3 のチェック結果を確認。

### 5. Discord コマンド登録（雛形のみ）

```bash
npm run discord:register
```

### 6. デプロイ

```bash
npx wrangler secret put DISCORD_BOT_TOKEN
# 他 secrets も同様に登録
npm run deploy
```

## ディレクトリ構成

| パス | 役割 |
|---|---|
| `src/index.ts` | Hono ルーター |
| `src/health.ts` | `/health` |
| `src/interactions/` | Discord 受信 |
| `src/discord/` | Discord 通信ユーティリティ |
| `src/db/` | DB クライアント・スキーマ |
| `src/storage/` | S3 クライアント |
| `migrations/` | drizzle-kit が生成する SQL |
| `docs/superpowers/specs/` | 仕様書 |
| `docs/superpowers/plans/` | フェーズ別実装計画 |

## 開発フロー

1. PR 作成 → CI (typecheck + test + lint) が PASS
2. レビュー → main へマージ
3. main の push で staging へ自動デプロイ（後続フェーズで設定）

## ライセンス

未設定。
````

- [ ] **Step 2: コミット**

```bash
git add README.md
git commit -m "docs: add README with P1 setup, env, and deploy instructions"
```

- [ ] **Step 3: push**

Run: `git push`
Expected: CI が PASS。

---

## Task 13: P1 完了の動作確認チェックリスト

このタスクは「コード変更を伴わない動作確認」。実機やステージング DB を使って Foundation が正しく機能するかを確認する。

- [ ] **Step 1: ローカル DB を用意して migrate**

```bash
docker run -d --name pg-ad-test -e POSTGRES_PASSWORD=test \
  -p 55432:5432 postgres:16-alpine
export POSTGRES_URL=postgres://postgres:test@localhost:55432/postgres
npm run db:migrate
```

Run: `psql $POSTGRES_URL -c '\dt'`
Expected: `ads`, `sponsors`, `tiers`, `ad_format_rules`, `ad_drafts`, `ad_events`, `review_logs`, `admin_logs`, `system_settings`, `dm_fallback_channels` の 10 テーブルが出力される。

- [ ] **Step 2: ローカル MinIO を起動して bucket 作成**

```bash
docker run -d --name minio-ad-test \
  -p 19000:9000 -e MINIO_ROOT_USER=test -e MINIO_ROOT_PASSWORD=testtest \
  quay.io/minio/minio server /data
docker exec minio-ad-test sh -c \
  'mc alias set local http://localhost:9000 test testtest && mc mb local/ad-server'
```

- [ ] **Step 3: `.dev.vars` に上記の接続情報を書いて wrangler dev を起動**

```bash
npm run dev
```

別ターミナルで:

```bash
curl -s http://localhost:8787/health | jq
```

Expected: `{ "status": "ok", "checks": { "db": "ok", "s3": "ok" } }`

- [ ] **Step 4: Discord PING/PONG をローカルで擬似的に確認**

```bash
node -e "
const nacl = require('tweetnacl');
const kp = nacl.sign.keyPair();
console.log('PUBLIC=' + Buffer.from(kp.publicKey).toString('hex'));
console.log('SECRET=' + Buffer.from(kp.secretKey).toString('hex'));
"
```

`.dev.vars` の `DISCORD_PUBLIC_KEY` を生成した PUBLIC で上書き、`wrangler dev` を再起動。

```bash
TS=$(date +%s)
BODY='{"type":1}'
SIG=$(node -e "
const nacl = require('tweetnacl');
const sk = Buffer.from(process.env.SECRET, 'hex');
const msg = Buffer.from(process.env.TS + process.env.BODY);
console.log(Buffer.from(nacl.sign.detached(msg, sk)).toString('hex'));
" SECRET=<上で取得したSECRET> TS=$TS BODY=$BODY)

curl -s -X POST http://localhost:8787/interactions \
  -H "X-Signature-Ed25519: $SIG" \
  -H "X-Signature-Timestamp: $TS" \
  -H "Content-Type: application/json" \
  -d "$BODY"
```

Expected: `{"type":1}`

- [ ] **Step 5: 後始末**

```bash
docker rm -f pg-ad-test minio-ad-test
```

- [ ] **Step 6: P1 完了タグ**

```bash
git tag -a p1-foundation -m "P1: foundation phase complete"
git push --tags
```

---

## Self-Review

仕様書 §1〜§9 のうち P1 で扱う範囲（土台 + /health + 署名検証 + interactions PING/PONG + 全テーブルのスキーマ）はすべて Task 1〜13 にマップされている。

- §2 アーキ: Task 1 (wrangler), Task 2 (Hono), Task 5 (Postgres), Task 6 (S3), Task 7+8 (Discord)
- §3 データモデル全テーブル: Task 4
- §6 セキュリティ Ed25519: Task 7+8
- §8 環境変数: Task 1 (.env.example), Task 2 (env.ts)
- §7 運用 (CI / デプロイ): Task 11 + README

P1 で扱わない（後続フェーズで実装）:
- §4 Discord UX 詳細 (P2/P3/P6)
- §5 配信 API (P4)
- 計測 (P5)
- Cron 詳細 (P7)
- §4.5 / §4.5.1 / §4.5.2 / §4.5.3 DM フォールバックロジック (P3 で実装)

placeholder 文言や TODO は無い。型と関数名は前後タスクで一貫している（`createPgClient` / `createS3Client` / `createDiscordRest` / `verifyDiscordSignature`）。drizzle スキーマで参照される `ads.id` 等のカラム名は他タスクから言及していないので不整合なし。

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-07-p1-foundation.md`.**

**実行方法の選択肢:**

1. **Subagent-Driven (推奨)** — 1 タスクごとに新規サブエージェントを派遣、間にレビューを挟む。コンテキスト枯渇を抑えながら高速イテレーション
2. **Inline Execution** — 同一セッションでタスクを順次実行、チェックポイントごとに確認

どちらで進めますか？
