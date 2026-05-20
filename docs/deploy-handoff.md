# デプロイ手順書（ネットワーク管理者向け）

discordapi_ad_server を **Cloudflare Workers** に本番デプロイするための手順。
DB・ストレージ・Tunnel・Hyperdrive・secrets・デプロイ・配線まで一式を含む。

> このアプリは **Cloudflare Workers**（Pages ではない）。Cron Triggers / Rate Limiter /
> `caches.default` など Workers 専用機能を使うため、Pages にはデプロイできません。
> デプロイは `wrangler deploy --env staging|production`。

---

## 0. 前提と登場するインフラ

| 要素 | 値 / 場所 | 備考 |
|---|---|---|
| アプリ | Cloudflare Worker `discordapi-ad-server`（staging: `-staging`） | リポジトリ: 〈このリポジトリ〉 / ブランチ `main` |
| Postgres | NAS 上 `aimg-backend-containers.tail8232f5.ts.net:5432`（origin 219.104.141.160） | PostgreSQL 18.3。Tailscale/LAN 内のみ到達可 |
| S3 (RustFS) | `https://rustfs.nijiurachan.net`（Cloudflare Tunnel で公開済み） | S3 互換。バケット名 = 〈要確認〉 |
| Tunnel | `aimg-backend-containers`（cloudflared、NAS 上） | 既存ルートは HTTP storage 系のみ |

**重要な制約:** デプロイ後の Worker は **Cloudflare のエッジ**で動くため、Tailscale
(`*.ts.net`) や LAN (192.168.x.x) に直接到達できません。S3 は公開ホスト名で解決済みですが、
**Postgres は別途 Hyperdrive + Tunnel 経由の経路が必要**です（§2）。

---

## 1. Postgres: DB 作成と権限

現状 DB ユーザー `so4246la` は `rolsuper=f rolcreatedb=f`（DB 作成不可）。管理者権限で以下を実行：

```sql
-- 専用 DB を so4246la 所有で新規作成（既存 development / production は流用しない）
CREATE DATABASE discordadserver OWNER so4246la;
```

- `so4246la` がこの DB に対しテーブル/ビュー/インデックス/制約を作成できること（OWNER なので可）。
- 既存の `development` / `production` DB は他用途の可能性があるため**流用しない**（テーブル名衝突回避）。

確認:
```sql
\l discordadserver
-- Owner が so4246la であること
```

---

## 2. Postgres を Cloudflare から到達可能にする（Hyperdrive + Tunnel）

Worker は raw TCP で PG に直結できないため、**Cloudflare Hyperdrive をプライベート DB
（Cloudflare Tunnel 経由）に接続**する。S3 と違い、現在の Tunnel には PG 用ルートが無いので追加が必要。

手順の骨子（詳細は Cloudflare ドキュメント "Hyperdrive → Connect to a private database
using Tunnel" 参照、UI 細部は最新版に従う）:

1. **cloudflared 側**: NAS の Tunnel `aimg-backend-containers` に Postgres を到達対象として追加。
   - HTTP の「公開アプリケーション」ではなく、**Hyperdrive 用のプライベート接続**として
     PG の `host:5432`（`aimg-backend-containers.tail8232f5.ts.net:5432` または NAS 内部アドレス）を指定。
2. **Cloudflare ダッシュボード → Hyperdrive**: 新規コンフィグを作成。
   - DB タイプ: PostgreSQL
   - 接続方法: **Cloudflare Tunnel（プライベート）** を選択し、上記 Tunnel を紐付け
   - host / port: PG の内部到達先 / 5432
   - database: `discordadserver`
   - user: `so4246la`
   - password: 〈ユーザーから別途安全に共有。チャットに貼られた値は使用後ローテーション必須〉
3. 生成された **Hyperdrive ID** を控える（§4 で wrangler.toml に記入）。

> ⚠️ **コード側の既知の制約（要対応・開発側で修正可）**:
> 現状コードは hot path（`/ads/serve`, `/ads/click`, `/ads/image`）だけ Hyperdrive を使い、
> **cron 6本（sweep-drafts / expire-ads / dm-fallback-sweep / rotate-salt / sweep-ad-events /
> health-summary）は `POSTGRES_URL` を直接使う**。Tailscale-only PG のままだとデプロイ後に
> **cron が全部 DB 接続失敗**する。対応はどちらか:
>   - (A) 開発側で cron も `resolveDbUrl(env)`（= Hyperdrive）を使うよう小修正する（推奨。依頼可）。
>   - (B) `POSTGRES_URL` に Cloudflare から到達可能な PG エンドポイントを設定する。
> hot path だけ動けばよい初回検証なら一旦 (A) 未対応でも可だが、本番では (A) 必須。

---

## 3. DB マイグレーション（スキーマ作成）

**Tailnet 内のホスト**（この NAS 自身、または Tailscale 接続済み端末）でリポジトリを clone し実行。
Cloudflare 経由ではなく直接 PG に流す。

```bash
npm ci
export POSTGRES_URL='postgres://so4246la:〈PASSWORD〉@aimg-backend-containers.tail8232f5.ts.net:5432/discordadserver'
npm run db:migrate      # migrations/0000〜0006 + view を適用
```

確認:
```bash
psql "$POSTGRES_URL" -c '\dt'   # ads, ad_events, ad_drafts, sponsors, tiers, ... が出ること
psql "$POSTGRES_URL" -c '\dv'   # ad_stats_daily ビューがあること
```

> SSL: Tailscale が経路を暗号化するため PG 側 SSL 無しなら接続文字列に `?sslmode=disable` を付ける。
> SSL 有効なら `?sslmode=require`。接続エラー時に調整。

---

## 4. Cloudflare Workers デプロイ（staging 先行）

### 4-1. 認証
```bash
npx wrangler login          # ブラウザ認証（または CLOUDFLARE_API_TOKEN を export）
```

### 4-2. wrangler.toml に Hyperdrive ID を記入
`wrangler.toml` の該当ブロックのコメントを外し、§2 の ID を入れる:
```toml
[[env.staging.hyperdrive]]
binding = "HYPERDRIVE"
id = "〈staging の Hyperdrive ID〉"
```
（production も同様に `[[env.production.hyperdrive]]`）

### 4-3. secrets / vars を staging に登録
以下を Worker 環境に設定。**機密**は `wrangler secret put`（画面に出ない）、非機密は
`wrangler.toml` の `[env.staging.vars]` でも可。一括なら `wrangler secret bulk`。

**機密（必ず secret）:**
| キー | 値の出どころ |
|---|---|
| `DISCORD_BOT_TOKEN` | Discord Developer Portal → Bot |
| `DISCORD_PUBLIC_KEY` | 同 → General Information |
| `POSTGRES_URL` | §3 の接続文字列（cron 用フォールバック。§2 の制約参照） |
| `S3_ACCESS_KEY_ID` | RustFS のアクセスキー |
| `S3_SECRET_ACCESS_KEY` | RustFS のシークレット |
| `IP_HASH_SALT_BOOTSTRAP` | 任意のランダム 32+ byte hex（初期ソルト） |
| `IMPRESSION_TOKEN_SECRET` | 任意のランダム長文字列（HMAC 鍵） |
| `SITE_API_KEY`（任意） | /ads/serve を site key で保護する場合のみ |

**非機密（vars でも secret でも可）:**
| キー | 値 |
|---|---|
| `DISCORD_APP_ID` / `DISCORD_APP_BOT_ID` | Discord アプリ ID / Bot ユーザー ID |
| `GUILD_ID` | 対象 Discord サーバ ID |
| `SUBMIT_CHANNEL_ID` / `REVIEW_CHANNEL_ID` / `ADMIN_CHANNEL_ID` | 各チャンネル ID |
| `FALLBACK_CHANNEL_CATEGORY_ID` | フォールバック用カテゴリ ID |
| `REVIEWER_ROLE_ID` / `ADMIN_ROLE_ID` | ロール ID |
| `S3_ENDPOINT` | `https://rustfs.nijiurachan.net` |
| `S3_REGION` | RustFS のリージョン（例 `us-east-1` / 〈要確認〉） |
| `S3_BUCKET` | バケット名 〈要確認〉 |
| `WORKER_BASE_URL` | デプロイ後に確定（§4-5 で上書き） |

secret 投入例:
```bash
echo -n '〈値〉' | npx wrangler secret put DISCORD_BOT_TOKEN --env staging
# 以下同様に各機密キー
```

### 4-4. デプロイ
```bash
npm run deploy:staging      # = wrangler deploy --env staging
```
※ `npm run deploy`（無印）は誤爆防止で exit 1 する仕様。`:staging` / `:production` を明示する。

### 4-5. WORKER_BASE_URL を確定して上書き
デプロイ完了で `https://discordapi-ad-server-staging.<account>.workers.dev` が確定するので:
```bash
echo -n 'https://discordapi-ad-server-staging.<account>.workers.dev' \
  | npx wrangler secret put WORKER_BASE_URL --env staging
npm run deploy:staging      # 反映のため再デプロイ
```
（独自ドメインを使うならそのドメインを設定）

---

## 5. デプロイ後の配線

1. **Discord Interactions Endpoint**: Discord Developer Portal → アプリ → General Information
   → "Interactions Endpoint URL" に `https://<worker-url>/interactions` を設定し保存
   （署名検証が通れば保存成功。失敗時は `DISCORD_PUBLIC_KEY` を確認）。
2. **スラッシュコマンド登録**: Tailnet 内端末で
   `DISCORD_APP_ID`, `DISCORD_BOT_TOKEN`, `GUILD_ID` を `.dev.vars` に入れて
   ```bash
   npm run discord:register
   ```
3. **Cron Triggers**: デプロイで自動有効化（hourly `0 * * * *` + daily `0 0 * * *`）。

---

## 6. 動作確認

```bash
curl https://<worker-url>/health                       # db / s3 のヘルス
curl 'https://<worker-url>/ads/serve?slot=default'      # 204 か広告 JSON
npx wrangler tail --env staging                         # cron 実行時 cron.hourly.* ログ確認
```

- `/health` が db ok / s3 ok を返せば DB(Hyperdrive) と S3 経路が成立。
- `wrangler tail` で cron が `cron task failed: ...` を出している場合は §2 の制約(A)未対応が原因。

---

## 7. 本番(production)展開

staging で疎通確認後、同じ手順を `--env production` で実施:
- `[[env.production.hyperdrive]]` に production の Hyperdrive ID
- secrets を `--env production` で登録
- `npm run deploy:production`
- `WORKER_BASE_URL` を production URL（または独自ドメイン）で設定

---

## チェックリスト

- [ ] `CREATE DATABASE discordadserver OWNER so4246la;`（§1）
- [ ] Hyperdrive コンフィグ作成（Tunnel 経由・PG プライベート接続）→ ID 取得（§2）
- [ ] cron の Hyperdrive 対応（開発側修正(A)）or POSTGRES_URL 到達性確保（§2 制約）
- [ ] `npm run db:migrate` 完了・テーブル/ビュー確認（§3）
- [ ] `wrangler login`（§4-1）
- [ ] wrangler.toml に Hyperdrive ID 記入（§4-2）
- [ ] secrets/vars 登録（§4-3）
- [ ] `npm run deploy:staging`（§4-4）
- [ ] `WORKER_BASE_URL` 確定 → 再デプロイ（§4-5）
- [ ] Discord Interactions Endpoint 設定 + コマンド登録（§5）
- [ ] `/health` / `/ads/serve` / `wrangler tail` 確認（§6）
- [ ] **作業後: ユーザーが共有した DB パスワードをローテーション**

---

## 補足

- wrangler が古い場合（3.x）警告が出る。`npm i -D wrangler@4` 推奨だが必須ではない。
- DB の接続元 IP 制限がある場合、Hyperdrive/Tunnel の egress を許可すること。
- 不明値〈要確認〉: S3 バケット名 / S3 リージョン / 各 Discord ID 群はユーザーから取得。
