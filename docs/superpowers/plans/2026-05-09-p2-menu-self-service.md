# P2 Remaining: Persistent Menu + Sponsor Self-Service Implementation Plan

> Plan synthesized from CodeRabbit's per-issue plans on Issues #5 (P2.4) and #6 (P2.5). Implements the remainder of the P2 milestone.

**Goal:** P2 を完了させる。 `#広告起稿` の常設メニュー（`/ad-setup`）とスポンサー自己サービスコマンド（`/ad list` / `/ad withdraw` / `/ad stats`、ボタンも併設）を実装する。

**Architecture:** 既存 P2 実装（`/ad submit` / Modal / S3 / DB）の上に、`APPLICATION_COMMAND` および `MESSAGE_COMPONENT` のディスパッチを `src/interactions/router.ts` に追加し、コマンド/ボタンハンドラ群を `src/interactions/commands/`, `src/interactions/buttons/` 配下に整理する。`system_settings` を活用してメニューメッセージ ID を永続化する。

**Tech Stack:** 既存 P2 スタックそのまま（Workers + Hono + TypeScript + Postgres + S3）。

---

## Issue #5 (P2.4): 常設メニュー + `/ad-setup`

### 仕様サマリ
- 管理者が `/ad-setup channel:#chan kind:submit|review|admin` を実行 → bot が指定チャンネルに常設メニューを投稿
- メニューの message_id を `system_settings` に保存し、再投稿時は古いメッセージを削除
- submit メニューには 4 ボタン: 📋 自分の広告一覧, 📊 統計, 📐 入稿ルール, ❓ 起稿の手順
- review/admin はスタブ（"coming soon"）

### 新規 / 変更ファイル
1. `src/discord/types.ts` — `ButtonComponent`, `ActionRowComponent`, `ComponentType`, `ButtonStyle`、コマンドオプション拡張型
2. `src/discord/rest.ts` — `deleteMessage(channelId, messageId)` 追加
3. `src/db/settings.ts` (新) — `getSystemSetting<T>(client, key)` / `setSystemSetting<T>(client, key, value)` の汎用ヘルパー + キー定数 (`SUBMIT_MENU_MESSAGE_ID` 等)
4. `scripts/register-commands.ts` — `/ad-setup` コマンド追加（`channel`: type 7 CHANNEL、`kind`: type 3 STRING choices、`default_member_permissions: '8'` (ADMIN)）
5. `src/interactions/router.ts` — `APPLICATION_COMMAND` ディスパッチに `/ad-setup` を追加（既存 `/ad submit` 経路は維持）
6. `src/interactions/commands/ad-setup.ts` (新) — メニュー投稿ロジック。kind=submit のみ実装、review/admin は ephemeral で "後続フェーズで対応" を返す
7. `tests/interactions/commands/ad-setup.test.ts` (新) — メニュー投稿、置換、permission check、kind 不正値

### 設計判断
- 権限制御は Discord 側（`default_member_permissions: '8'`）に委譲。ハンドラ側で再チェックは不要（Discord が UI レベルで非表示にする）。ただし防御的に member.roles を 1 度確認するのは可。
- 古いメッセージ削除が 404 で失敗した場合は warn ログのみ（既に消えているため）。

---

## Issue #6 (P2.5): スポンサー自己サービス

### 仕様サマリ
- `/ad list`, `/ad withdraw id:<string>`, `/ad stats period:<24h|7d|30d|all>?` をスラッシュコマンドで提供
- 同じ機能を `#広告起稿` メニューのボタンからも呼び出せる（custom_id ディスパッチ）
- 広告 list には title + image preview を含める（presigned S3 URL を embed.image.url に設定）
- 統計は ad_events を集計（クリック / インプレッション / CTR）。P5 完了前は 0 件のまま動作

### 新規 / 変更ファイル
1. `src/db/queries/ads.ts` (新) — sponsor_id 単位のヘルパー:
   - `getSponsorAds(client, sponsorId)`: 自分の広告を status 順で取得（最大 5 件）
   - `withdrawAd(client, sponsorId, adId)`: トランザクション内で `UPDATE ads SET status='withdrawn'` + `INSERT INTO review_logs`
   - `getAggregateStats(client, sponsorId, periodFrom)`: ad_events を JOIN して impressions/clicks/CTR を返す
2. `src/storage/s3-presign.ts` (新) — `presignGetUrl(s3, bucket, key, ttlSeconds)`: `@aws-sdk/s3-request-presigner` でプリサイン URL を発行
3. `src/interactions/commands/ad-list.ts` (新) — `/ad list` ハンドラ + ボタンハンドラ共通核
4. `src/interactions/commands/ad-withdraw.ts` (新) — `/ad withdraw id:<...>` ハンドラ
5. `src/interactions/commands/ad-stats.ts` (新) — `/ad stats period:<...>` ハンドラ + ボタンの period 選択フロー
6. `src/interactions/commands/ad-rules.ts` (新) — 入稿ルール表示（`#広告起稿` の 📐 ボタンと共有）
7. `src/interactions/router.ts` — `MESSAGE_COMPONENT` ディスパッチを追加し、custom_id で各ハンドラへ振り分け
8. `scripts/register-commands.ts` — `/ad list`, `/ad withdraw`, `/ad stats` を `ad` コマンドのサブコマンドとして追加
9. テスト: `tests/interactions/commands/ad-{list,withdraw,stats,rules}.test.ts`

### 設計判断
- **画像配信**: P4.3 (`/ads/image/:adId` プロキシ) は別 Issue で扱うため、ここではプリサイン S3 URL を直接 embed に貼る（5 分有効）。Discord は外部画像を直接埋め込み可能。
- **CTR 集計**: `ad_events` が空でも `0/0` を 0% として安全に返す（NULLIF + COALESCE）。
- **list 上限**: Discord Action Row の制約により、ボタン付き行は 5 件まで。それ以上はページング（後続）。MVP は 5 件で truncate + 「さらに見るには /ad list を実行」と案内。
- **withdraw 権限**: `sponsor_id` が呼び出し者と一致しているか必ず検証。一致しない場合は ephemeral 拒否。
- **status 遷移**: `pending` / `approved` / `paused` の広告のみ `withdrawn` 化可。`rejected` / `expired` / `withdrawn` は対象外。

### custom_id 規約
- `ad:list` — 一覧表示
- `ad:withdraw:{adId}` — 取り下げ確認 → 確定
- `ad:stats:period` — 期間選択 select menu
- `ad:stats:{period}` — 期間別統計表示
- `ad:rules` — ルール表示

---

## 実装順序
1. **#5 共通基盤 → メニュー実装**（types / settings / rest 拡張、ad-setup）
2. **#6 自己サービス**（queries / presign / 4 ハンドラ / ボタンディスパッチ）
3. **テスト / 統合確認**
4. **PR 作成** — issue #5 と #6 を `Closes` で参照

---

## スコープ外（後続 Issue）
- P4.3: `/ads/image/:adId` Worker プロキシ + edge cache（プリサイン URL の代替に）
- P5: ad_events への impression/click 記録（統計の実データ化）
- ページング（自分の広告 5 件超）
- review/admin 用メニュー（P3 / P6 で実装）
