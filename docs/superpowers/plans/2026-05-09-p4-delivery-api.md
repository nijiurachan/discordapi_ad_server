# P4: Delivery API Implementation Plan

> Synthesized from CodeRabbit's per-issue plans on Issues #14–#18. Implements the public web-facing delivery API.

**Goal:** Web サイトが広告を取得・クリック・画像表示できる公開 API を実装。重み付き選択 + house/placeholder フォールバック、署名トークン、画像 S3 プロキシ、レート制限・Site Key 認証を備える。

**Architecture:** `src/serve/` 配下に新規モジュール群を構築し、Hono ルーター `/ads/*` として `src/index.ts` にマウント。`ad_events` への書き込みは P5（Tracking）で扱う方針 — P4 のエンドポイントは観測無しでも正しく動作する設計。

**Tech Stack:** P3 と同一。新規依存なし（WebCrypto + 既存 S3 SDK）。

---

## 実装順序

1. **P4.4** (#17) — impression_token utility（gen / verify、HMAC-SHA256、5-min TTL）
2. **P4.1** (#14) — `/ads/serve` 重み付き選択 + house/placeholder + token 付きレスポンス
3. **P4.3** (#16) — `/ads/image/:adId` S3 プロキシ + edge cache
4. **P4.2** (#15) — `/ads/click/:adId` 302 リダイレクト（open-redirect 防止）
5. **P4.5** (#18) — rate limit + site key middleware を全 `/ads/*` ルートに適用

---

## P4.4 (#17): impression_token

**スコープ:** Pure HMAC token utility。生成と検証両方を提供（検証は P5/P6 で利用、P4.1 では生成のみ呼ぶ）。

**新規 / 変更:**
- `src/env.ts` — `IMPRESSION_TOKEN_SECRET: string` を Bindings に追加
- `vitest.config.ts` — テスト用 binding 追加（適当な固定 hex 値）
- `wrangler.toml` — `vars` ではなく Worker secret として運用（README に記載）。.env.example に追記
- `src/serve/token.ts` (新):
  - `generateImpressionToken(adId, slot, servedAt: Date, ipHash, secret): string` — `v1.<base64url-hmac>` を返す
  - `verifyImpressionToken(token, expected: { adId, slot, ipHash }, secret, now?: Date): { valid: true } | { valid: false, reason: 'malformed' | 'expired' | 'mismatch' }`
  - HMAC メッセージ: `${adId}|${slot}|${servedAt.toISOString()}|${ipHash}`
  - timingSafeEqual で検証
  - TTL 5 分（300 秒）

- tests: 生成 → 検証 round-trip、各 reason、timing-safe 比較

---

## P4.1 (#14): `/ads/serve` 重み付き + フォールバック

**スコープ:** 3 段階選択（regular weighted random → house equal random fill → placeholder single）。NULL の `starts_at`/`ends_at` は無制限扱い。

**新規 / 変更:**
- `src/serve/pick.ts` (新) — 3 段階選択ロジック:
  - `pickRegularAds(client, slot, n)`: spec §5.2 のクエリ（`-ln(random()) / weight_snapshot ASC`）
  - `pickHouseAds(client, slot, n)`: 等確率ランダム（`ORDER BY random()`）
  - `pickPlaceholder(client, slot)`: 先頭 1 件
  - `serveAds(client, slot, n)`: 上記を組み合わせて `n` 件返す。不足分を house/placeholder で埋める
- `src/serve/router.ts` (新) — Hono ルーター。`GET /serve` ハンドラ
- `src/utils/ip-hash.ts` (新) — `hashIP(ip, salt): Promise<string>`、WebCrypto SHA-256 → hex
- `src/index.ts` (編集) — `app.route('/ads', serveRouter)` をマウント
- レスポンス shape: `{ slot, served_at: ISO, ads: [{ id, kind, title, body, image_url, click_url, impression_token }] }`
  - 0 件かつ placeholder 無し → 204 No Content
- `image_url` = `${WORKER_BASE_URL}/ads/image/${id}`
- `click_url` = `${WORKER_BASE_URL}/ads/click/${id}`
- `impression_token` = `generateImpressionToken(...)`
- IP は `c.req.header('cf-connecting-ip') || 'unknown'`

- tests: pick.ts のクエリパターン、router の n=1/3/5、フォールバック動作

---

## P4.3 (#16): `/ads/image/:adId` S3 プロキシ

**スコープ:** S3 から画像を取得し edge cache 経由で返却。24h cache（`Cache-Control: public, max-age=86400`）。

**新規 / 変更:**
- `src/storage/s3.ts` (編集) — `getObject(client, bucket, key): Promise<{ body: ReadableStream | null; contentType?: string; contentLength?: number; etag?: string } | null>` を追加（404 は null）
- `src/serve/image.ts` (新):
  - UUID validation
  - `ads.image_key` を DB から取得（404 なら null）
  - Cache API hit/miss 判定
  - S3 GetObject → response with appropriate headers
  - 404 / 500 ハンドリング
- `src/serve/router.ts` — `GET /image/:adId` を追加
- tests: 200 cache miss → S3 取得、cache hit、404 missing image_key、404 missing ad

---

## P4.2 (#15): `/ads/click/:adId` 302 redirect

**スコープ:** Open-redirect 完全防止のため `?to=` 等のクエリは無視。サーバ側で `ads.link_url` を解決し 302。

**新規 / 変更:**
- `src/serve/click.ts` (新):
  - UUID validation
  - SELECT `ads.link_url` で取得（404 → return 404）
  - 302 with `Location: <link_url>`
- `src/serve/router.ts` — `GET /click/:adId` を追加
- tests: 302 redirect to link_url、UUID 不正 → 400、未存在 → 404、`?to=` クエリは無視される

**Note:** ad_events への click INSERT は P5.1 で別途編集して追加する（P4 では純粋なリダイレクトのみ）。

---

## P4.5 (#18): rate limit + site key

**スコープ:** Cloudflare Rate Limiter binding を 2 つ宣言、`/ads/serve` 60/min IP、`/ads/click/:adId` 10/min IP+adId。`SITE_API_KEY` env が設定されている場合のみ X-Site-Key ヘッダで検証。

**新規 / 変更:**
- `wrangler.toml` (編集):

  ```toml
  [[unsafe.bindings]]
  name = "SERVE_RATE_LIMITER"
  type = "ratelimit"
  namespace_id = "1001"
  simple = { limit = 60, period = 60 }

  [[unsafe.bindings]]
  name = "CLICK_RATE_LIMITER"
  type = "ratelimit"
  namespace_id = "1002"
  simple = { limit = 10, period = 60 }
  ```

  注: 2026 時点の wrangler RateLimit Binding 構文は要確認。`[[ratelimits]]` 形式で書ける場合はそちら優先。
- `src/env.ts` (編集) — `SERVE_RATE_LIMITER`, `CLICK_RATE_LIMITER` を Bindings に追加（型は `{ limit(arg: { key: string }): Promise<{ success: boolean }> }`）
- `src/serve/rate-limit.ts` (新) — Hono ミドルウェア。429 + `{ error: 'rate limit exceeded' }`
- `src/serve/site-key.ts` (新) — `requireSiteKey(c)`: `SITE_API_KEY` 未設定 → スキップ、設定済 → ヘッダ照合
- `src/serve/router.ts` (編集) — `app.use('/serve', siteKeyMw)`、`app.use('/serve', serveRateLimitMw)`、`app.use('/click/:adId', clickRateLimitMw)`
- vitest.config.ts に rate limiter mock binding 追加
- tests: 429 動作、site key OK/NG、未設定時の通過

---

## スコープ外（P5 以降で対応）

- impression / click の `ad_events` INSERT（P5.1）
- bot UA フィルタ（P5.3）
- daily_salt の cron ローテ（P7）
- impression_token verify エンドポイント（P5 が利用）
- placeholder click のレポート除外（P5.4）
