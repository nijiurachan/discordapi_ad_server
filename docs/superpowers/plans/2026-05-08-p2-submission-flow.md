# P2: Submission Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Plan provided directly by the user (not via brainstorming skill).

**Goal:** `/ad submit` スラッシュコマンドの完全フロー（コマンド登録、バリデーション、S3 ステージング、Modal 提出、ads INSERT、レビュー Embed 投稿）を実装し、ルーターへ統合してテストする。

**Architecture:** P1 で構築した Hono ルーター + Discord Interactions 受信基盤の上に、`/ad submit` のハンドラ群を追加。S3 / pg / Discord REST は P1 のクライアントを利用。新規モジュールは `src/sponsors/`, `src/validation/`, `src/interactions/commands/`, `src/interactions/modals/`, `src/discord/review-embed.ts`。

**Tech Stack:**
- 既存 P1 スタック（Workers + Hono + TypeScript + Postgres + S3 + drizzle + tweetnacl）
- 追加: zod（バリデーションに採用するか、または手書きの guard）

**スコープ外（後続 Issue で実装）:**
- `#広告起稿` 常設メニュー (P2.4)
- 自分の広告一覧 / 取り下げ / 統計 (P2.5)
- 承認/却下ボタン (P3)
- DM 通知・fallback (P3)

---

## Task 1: 基盤インフラ整備

フェーズ 1 では、後続フェーズで使用する基盤的なインフラ（コマンド登録・S3 ヘルパー・Discord 型定義）を整備する。

### Task 1.1: `/ad submit` コマンド登録

- `scripts/register-commands.ts` の `commands` 配列に `/ad submit` コマンドを追加
- `slot` オプション: type 3 (STRING)、required: true、choices 配列に初期値 `default` を設定（将来的に DB 連動可能な構造）
- `image` オプション: type 11 (ATTACHMENT)、required: true

### Task 1.2: S3 操作ヘルパー追加

- `src/storage/s3.ts` に 3 関数を追加:
  - `putObject(client, bucket, key, body, contentType)`: `PutObjectCommand` のラッパー
  - `copyObject(client, bucket, sourceKey, destKey)`: `CopyObjectCommand` のラッパー（同一バケット内コピー）
  - `deleteObject(client, bucket, key)`: `DeleteObjectCommand` のラッパー
- エラーは throw し、`@aws-sdk/client-s3` から各コマンドをインポート
- 既存の `createS3Client` パターンに従って実装

### Task 1.3: Discord 型定義の拡張

- `src/discord/types.ts` に以下の型を追加:
  - `ApplicationCommandInteractionPayload` 型（`data.name`、`data.options`、`data.resolved.attachments` を含む）
  - `ModalSubmitInteractionPayload` 型（`data.custom_id`、`data.components` を含む）
  - `Attachment` 型（`id`、`url`、`content_type`、`size`、`width`、`height` フィールド）
  - `InteractionResponseType.MODAL = 9` が未定義の場合は追加
- Modal 応答の JSON 構造（`custom_id`、`title`、`components` 配列）の型定義を追加

---

## Task 2: コマンドハンドラ + バリデーション + S3 ステージング

フェーズ 2 では、`/ad submit` スラッシュコマンドの Tier 検証・フォールバックゲート・画像バリデーション・S3 ステージングアップロード・Modal 返却までの完全フローを実装する。

### Task 2.1: Tier 検証ヘルパー

- `src/sponsors/` ディレクトリを新規作成し、`tier.ts` を追加
- `refreshSponsorTier(discordRest, db, guildId, userId)`:
  - Discord REST `GET /guilds/{guild}/members/{user}` でユーザーのロール一覧を取得
  - `tiers` テーブルの `discord_role_id` とマッチングし、最高 `rank` の Tier を特定
  - `sponsors` テーブルを `current_tier_id` で UPSERT（`display_name` も更新）
  - Tier 情報（`weight`、`max_active_ads` 等）を返却
- `countActiveAds(db, sponsorId)`: `ads` テーブルで `status='approved'` または `status='pending'` の件数を返却
- `checkMaxActiveAds(tier, activeCount)`: 制限超過時にエラーオブジェクトを返却

### Task 2.2: フォールバック確認ゲート

- `src/sponsors/fallback-gate.ts` を新規作成
- `blockIfUnackedFallback(db, sponsorId)`:
  - `dm_fallback_channels` テーブルで `acknowledged_at IS NULL AND expires_at > now()` を検索
  - 該当行があれば `channel_id` 一覧を含むエラーオブジェクトを返却
  - 該当なしなら `null` を返却（通過 OK）
  - 戻り値はエフェメラルメッセージ用のエラー情報として構造化

### Task 2.3: 画像バリデーション

- `src/validation/` ディレクトリを新規作成し、`image.ts` を追加
- `validateImage(rules, attachment)` を以下の順でチェック:
  - MIME type（`allowed_mimes` との照合）
  - 拡張子（URL から抽出し `allowed_extensions` と照合）
  - サイズ（`max_bytes` 以下か）
  - 寸法（`min_width` / `max_width` / `min_height` / `max_height`）
  - アスペクト比（`aspect_ratios` と `aspect_tolerance` で許容範囲判定）
- `validateMagicBytes(buffer)`: PNG / JPEG / GIF / WebP の先頭バイトパターン検証
- `fetchFormatRules(db, slot)`: `ad_format_rules` から slot 指定でルール取得

### Task 2.4: `/ad submit` コマンドハンドラ

- `src/interactions/commands/ad-submit.ts` を新規作成
- `handleAdSubmit(c, payload)` を以下の順序で実装:
  1. オプションから slot 値と attachment ID を抽出
  2. `resolved.attachments` から添付ファイル情報を取得
  3. `blockIfUnackedFallback` でフォールバックゲート確認
  4. `refreshSponsorTier` で Tier 遅延リフレッシュ
  5. `countActiveAds` + `checkMaxActiveAds` で制限確認
  6. `fetchFormatRules` + `validateImage` で画像検証
  7. Discord CDN から画像を fetch し `validateMagicBytes` を実行
  8. UUID を生成して `staging/{draft_id}/orig.{ext}` へ S3 PUT
  9. `ad_drafts` に INSERT（`expires_at = now() + 10 分`）
  10. Modal 応答を返却（`custom_id=submit:{draft_id}`、title/body/link フィールドを含む）
- 各ステップ失敗時はエフェメラルエラーメッセージで早期 return

---

## Task 3: Modal 提出 + ads INSERT + レビュー Embed + ルーター統合 + テスト

フェーズ 3 では、Modal 送信の処理から S3 永続化・DB 挿入・レビュー Embed 投稿までを実装し、ルーターへ統合してテストを作成する。

### Task 3.1: テキストバリデーション

- `src/validation/text.ts` を新規作成
- `validateTitle(rules, title)`: `title_max_len` 以下か検証
- `validateBody(rules, body)`: `body_max_len` 以下か検証
- `validateLinkUrl(rules, url)` を以下の順でチェック:
  - `link_url_max_len` 以下か
  - `link_scheme` 配列に含まれるスキームか（デフォルト `https` のみ）
  - `link_domain_allowlist` が設定されていれば許可ドメインか
  - `link_domain_blocklist` が設定されていれば拒否ドメインでないか
- 各関数はエラー時にユーザー向けメッセージを含むエラーオブジェクトを返却

### Task 3.2: Modal 送信ハンドラ

- `src/interactions/modals/submit-modal.ts` を新規作成
- `handleSubmitModal(c, payload)` を以下の順序で実装:
  1. `custom_id` から `draft_id` を抽出（`submit:` プレフィックス除去）
  2. `ad_drafts` から draft 取得、`expires_at` 確認（期限切れならエフェメラルエラー）
  3. Modal コンポーネントから `title` / `body` / `link_url` を抽出
  4. `fetchFormatRules` + テキストバリデーション
  5. `countActiveAds` で再度 `max_active_ads` を確認（競合状態対策）
  6. 新規 `ad_id`（UUID）を生成
  7. S3 `copyObject` で `staging/{draft_id}/orig.*` → `ads/{ad_id}/orig.*` にコピー
  8. `ads` に INSERT（`status='pending'`、`image_key` 等は draft から引き継ぎ）
  9. `ad_drafts` 行 DELETE + S3 `deleteObject` でステージング削除
  10. レビュー Embed 投稿（Task 3.3 の関数を呼び出し）
  11. エフェメラル確認メッセージを返却（「✅ 受付完了 / 結果は DM で通知」）
- トランザクション的整合性: S3 コピー成功後に DB 操作。失敗時の部分的ロールバックは不要（staging 自動 TTL 削除に任せる）

### Task 3.3: レビュー Embed 投稿ユーティリティ

- `src/discord/review-embed.ts` を新規作成
- `postReviewEmbed(discordRest, channelId, ad, sponsor)`:
  - Embed 構造にタイトル・本文・リンク URL・画像（S3 パスから Worker 経由の URL 生成）・スポンサー情報を含める
  - Approve / Reject ボタンは本チケットのスコープ外、Embed のみ投稿する土台を作成
  - `createMessage` REST 呼び出しで `REVIEW_CHANNEL_ID` へ投稿
  - 画像 URL は `{WORKER_BASE_URL}/images/ads/{ad_id}/orig.{ext}` 形式（将来のプロキシエンドポイント想定）

### Task 3.4: インタラクションルーター統合

- `src/interactions/router.ts` を更新:
  - `InteractionType.APPLICATION_COMMAND` の分岐を追加し、`payload.data.name === 'ad'` かつサブコマンド `submit` の場合に `handleAdSubmit` を呼び出す
  - `InteractionType.MODAL_SUBMIT` の分岐を追加し、`payload.data.custom_id` が `submit:` プレフィックスの場合に `handleSubmitModal` を呼び出す
  - `c`（Hono コンテキスト）と `payload` をハンドラへ渡す
  - 未対応のコマンド/Modal は既存の 501 応答を維持

### Task 3.5: テスト実装

- `tests/interactions/ad-submit.test.ts` を新規作成し、以下のテストケースを実装:
  - 正常系: コマンド → Modal 応答、Modal 送信 → エフェメラル確認
  - Tier 制限超過時のエフェメラルエラー
  - フォールバックゲートブロック
  - 画像バリデーションエラー（サイズ超過、MIME 不一致等）
  - テキストバリデーションエラー（URL 不正等）
  - draft 期限切れエラー
- 既存パターンに従い、nacl keypair 生成・`X-Public-Key-Override` ヘッダ・`SELF.fetch` を使用
- DB / S3 は Miniflare バインディング経由で利用し、必要に応じてモック
