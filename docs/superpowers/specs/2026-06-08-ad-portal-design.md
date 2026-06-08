# Phase 2 設計: 広告ポータル（per-user private channel ダッシュボード）

- 日付: 2026-06-08
- ステータス: ドラフト（ユーザーレビュー待ち）
- 依存: **Phase 1（重み分割バックエンド）が先行必須**。ポータルの目玉「残り利用可能ウェイト」は
  Phase 1 の `weight_alloc` ＋ `getSponsorBudget()` が無いと計算できない（一方向依存）。
  関連 spec: [2026-06-08-weight-split-budget-design.md](2026-06-08-weight-split-budget-design.md)

## 1. 背景と目的

現在の入稿 UX は2段階（`/ad submit` slash → モーダル）で、専用チャンネルは無く全てエフェメラル。
スポンサーは自分のプラン・残予算・本数を一目で把握できない。

本フェーズでは「**広告ポータル**」を追加する。公開チャンネルに常設した「広告ポータルを開く」
ボタンを押すと、**スポンサーごとの private channel** を生成し、開くと即座に
**現在のプラン / 残り利用可能ウェイト / 件数上限と使用数 / 出稿中バナー一覧**を表示する。
そこからバナーの追加・管理を行う。

大半は既存の DM フォールバック機構（`dm_fallback_channels` 系）の**コピペ改変**で実現できる。

## 2. 決定事項（確定）

| # | 決定 | 採用 |
|---|---|---|
| 1 | 画像入力 | `/ad submit` slash を画像入口として維持（MVP）。ポータルの「バナー追加」は実行へ誘導 |
| 2 | チャンネル寿命 | **必要時生成 → アイドル削除**（規模未知のためスケール非依存）。専用 category |
| 3 | 旧メニュー/結果配信 | **完全共存**（旧 submit メニューも dm_fallback も残し、ポータルは追加） |
| 4 | スタッフ可視 | `REVIEWER_ROLE_ID` ＋ `ADMIN_ROLE_ID` を overwrite に明示付与 |
| 5 | ダッシュボード鮮度 | 開放/操作のたびに再描画（push は無いため） |

### レビューで確定する細目（推奨デフォルト）

- **tier 鮮度（開放時）**: 推奨=ライブ `refreshSponsorTier`（getGuildMember 1回、正確）。代替=キャッシュ即時。
- **専用 category**: 推奨=新規 `PORTAL_CHANNEL_CATEGORY_ID`（fallback と分離。category 50枚上限の二重消費回避）。
- **開放時ゲート**: 推奨=`blockIfUnackedFallback` はポータル開放では課さない（情報表示のため）。
  ただし「バナー追加」は `/ad submit` 経由＝既存ゲートがそのまま効く。
- **残予算0時の add**: 推奨=件数上限未達でも残ウェイト0なら add をブロック。

## 3. アーキテクチャ（エントリ→生成→描画→入稿/管理）

[0] **常設パネル**（一回設定）: `ad-setup.ts` を拡張し、公開チャンネルに「広告ポータルを開く」
ボタン（custom_id `portal:open`）付きメッセージを投稿。message_id/channel_id を `system_settings`
に保持（既存 submit メニューと同方式）。`router.ts` の custom_id switch に `portal:` アームを追加。

[1] **エントリ（3秒 ACK 対策）**: `portal:open` 押下 → **DEFERRED ephemeral（type 5）で即 ACK** →
`c.executionCtx.waitUntil((async () => { await withPgClient(env, async (client) => { ... }) })())`
で **waitUntil コールバック内で新規に `withPgClient` を開いて**（リクエストスコープの client は再利用しない）
チャンネル生成 → webhook followup（`PATCH /webhooks/{app_id}/{token}/messages/@original`）
でチャンネルリンクを返す。※type5 は定義のみ・未使用、followup ヘルパも未実装＝**前提として追加**。

[2] **チャンネル生成 or 再利用**: 新サービス `openOrReusePortalChannel`（`createOrReuseFallbackChannel`
を雛形に）。`findOpenPortalBySponsor(sponsorId)`（新クエリ、`archived_at IS NULL`）→ あれば再利用。
無ければ **行を先に INSERT**（`UNIQUE(sponsor_id)` 部分インデックスでダブルクリック競合を防ぐ）→
`createGuildChannel`（`PORTAL_CHANNEL_CATEGORY_ID` 下、`buildPortalOverwrites`）→
生成失敗時は行をロールバック（fallback の補償的クリーンアップ順序を踏襲）。

[3] **ダッシュボード描画**: チャンネルに1枚のリッチメッセージ（embed + ボタン行）を投稿し、
message_id を行に保持。表示内容：
- プラン（tier 名）
- 残り利用可能ウェイト = `getSponsorBudget(sponsorId).remaining`（**Phase 1 primitive**）
- 件数（使用数 / 上限）。使用数 = `getSponsorActiveBanners().length`（= regular・非admin の
  pending+approved 本数。広範な `countActiveAds`〔全 kind 計上〕は使わない）。上限 = `tierWeight`
  （各バナー weight≥1 かつ Σ≤tierWeight ⇒ 本数≤tierWeight）。残ウェイトは別フィールドで表示
- 出稿中バナー一覧（per-banner `weight_alloc`。**canonical** な新クエリ `getSponsorActiveBanners`
  （定義は Phase 2 の `src/db/queries/portal.ts` にのみ存在し、`{ id, slot, title, status, weightAlloc }`
  を返す。Phase 1 は同名関数を定義せず、必要なら既存 `getSponsorAds` を使う）。
  既存 `getSponsorAds` は LIMIT 5 で終了状態も混ざるため不可）
- ボタン: 新規バナーを追加 `portal:add` / 管理 `portal:manage` / 更新 `portal:refresh` / 閉じる `portal:close`
- 鮮度: 各操作後に **UPDATE_MESSAGE（type 7）で再描画**（`responses.ts` に type7 ヘルパ追加）。

[4] **バナー追加** `portal:add`: 画像はモーダルで運べないため、`/ad submit` 実行へ誘導（MVP）。
既存 stage1（検証+S3+`ad_drafts`）/stage2（モーダル）を再利用し、**stage2 モーダルに weight 入力を追加**、
コミット tx 内で残予算に対し検証（Phase 1 の予算不変条件）。

[5] **管理** `portal:manage`: `ad-list.ts`（状態/slot/日付＋取り下げ）を吸収・拡張。将来はテキスト編集/
画像差し替え/一時停止/重み再配分。各操作後に [3] を再描画。

[6] **撤去/整合**: `portal:close`（ack-button 方式：所有者確認＋atomic close＋404寛容 deleteChannel）。
所有者確認はクリックされたチャンネル（`payload.channel_id`）でポータルを引き当て、その
`sponsor_id` をクリッカーと突き合わせる（`findOpenPortalBySponsor(clickerUserId)` は使わない＝
非所有者でも自分のポータルしか引けず not_owner 分岐が到達不能になるため）。
新規 **hourly ポータル sweep**（`dm-fallback-sweep` 雛形）でアイドル削除。
`getChannel`-404 自己修復で、ユーザーが手動削除しても次回開放で復帰。

## 4. データモデル

`portal_channels`（`dm_fallback_channels` を雛形に新規）:
- `id TEXT PK`、`sponsor_id TEXT NOT NULL`、`channel_id TEXT NOT NULL`、`dashboard_message_id TEXT`、
  `created_at`、`last_active_at`（アイドル判定）、`archived_at`（nullable）
- **`UNIQUE(sponsor_id) WHERE archived_at IS NULL`**（1スポンサー1アクティブch、競合防止）
- `UNIQUE(channel_id)`

`env.ts` に `PORTAL_CHANNEL_CATEGORY_ID`、（未設定なら）`REVIEWER_ROLE_ID`/`ADMIN_ROLE_ID` を追加。

## 5. 再利用 vs 新規

**再利用（コピペ改変）**: チャンネル生成+再利用フロー（`fallback.ts:72`）、補償的クリーンアップ、
private ACL（`permissions.ts:28` → `buildPortalOverwrites`）、所有者スコープのボタン処理
（`fallback-ack-button.ts`）、TTL/アイドル sweep（`dm-fallback-sweep.ts` + `cron/index.ts`）、
自己修復（`fallback-gate.ts`）、テーブル雛形 + migration、REST 面（`createGuildChannel/getChannel/
deleteChannel/createMessage/editMessage` は無改修）、env 配線、エントリボタン機構（`ad-setup.ts`）。

**新規（要実装）**: `UNIQUE(sponsor_id)`、**DEFERRED 応答 + webhook followup ヘルパ**（`rest.ts` に
`PATCH /webhooks/...`）、**UPDATE_MESSAGE(type7) ヘルパ**（`responses.ts`）、ダッシュボード描画、
`getSponsorActiveBanners` クエリ、`buildPortalOverwrites`（staff ロール追加）、ポータル sweep。

## 6. テスト方針

- エントリ: 3秒以内 ACK（deferred）→ followup でリンク返却。
- 生成/再利用: 既存アクティブ ch があれば再利用、無ければ生成。ダブルクリックで二重生成しない
  （`UNIQUE(sponsor_id)` + INSERT-first）。
- 失敗時補償: createGuildChannel 失敗 → 行ロールバック（孤児 ch を残さない）。
- ダッシュボード: tier/残予算/上限/使用数/バナー一覧が DB と一致。操作後の再描画。
- 権限: deny @everyone / allow sponsor+bot+REVIEWER+ADMIN。他スポンサーに漏れない。
- ライフサイクル: アイドル削除、手動削除後の自己修復、close。
- Phase 1 連携: `getSponsorBudget` の値がダッシュボードに正しく反映。

## 7. 影響ファイル

- `scripts/register-commands.ts` / `src/interactions/commands/ad-setup.ts`（エントリパネル）
- `src/interactions/router.ts`（`portal:` アーム）
- 新規 `src/services/portal/*`（open/render/teardown）、`src/interactions/buttons/portal-*.ts`
- `src/discord/rest.ts`（webhook followup PATCH）、`src/discord/responses.ts`（type7）、`src/discord/permissions.ts`（buildPortalOverwrites）
- `src/db/schema.ts` + migration（`portal_channels`）、`src/db/queries/portal.ts`、`getSponsorActiveBanners`
- `src/cron/index.ts` + 新規 portal sweep
- `src/env.ts`（PORTAL_CHANNEL_CATEGORY_ID / REVIEWER_ROLE_ID / ADMIN_ROLE_ID）

## 8. 非目標（このフェーズでやらないこと）

- ポータル内での画像直接アップロード（SEND 権限＋メッセージ取り込み経路）→ 将来。
- 旧 submit メニュー/`dm_fallback` の廃止（完全共存。統一は将来検討）。
- ポータル内テキスト編集/画像差し替え/重み再配分の本格 UI（最小は管理ボタンのみ、拡張は後続）。

## 9. 主要リスク

1. **3秒 ACK**: deferred + followup を前提として最初に実装（同期生成は「Interaction Failed」）。
2. **category 上限**: 完全共存で portal と fallback が別々に 50/category を消費。専用 category 分離＋
   アイドル削除で緩和。規模が判明したら再評価。
3. **権限漏れ**: 予算/プランを表示するため overwrite を誤ると他スポンサーへ漏洩。deny@everyone/
   allow member/bot/staff を厳密に。`DISCORD_APP_BOT_ID` が bot user id であることを確認。
4. **Phase 1 依存**: 「残予算」は Phase 1 未完だと表示不能。Phase 1 → Phase 2 の順守。
5. **ダッシュボード陳腐化**: push が無いため操作のたび再描画。tier はライブ取得を推奨。
6. **孤児チャンネル**: アイドル sweep ＋ 自己修復で回収（必要なら audit-sponsor-membership に teardown）。
