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

- Node.js 24 以上
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
