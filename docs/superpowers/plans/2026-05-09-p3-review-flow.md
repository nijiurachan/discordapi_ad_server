# P3: Review Flow Implementation Plan

> Synthesized from CodeRabbit's per-issue plans on Issues #8–#13. Implements the complete review flow on top of P2.

**Goal:** スポンサーが起稿した広告を、審査者が `#広告審査` でボタン操作で承認/却下し、結果を起稿者に DM で通知。DM が拒否された場合はプライベートチャンネルでフォールバック。フォールバック未確認の間は再起稿を block する。

**Architecture:** P2 で構築した `interactions/router.ts` の `MESSAGE_COMPONENT` / `MODAL_SUBMIT` 経路を拡張。新規モジュール: `src/discord/embeds/review.ts` (Embed 構築), `src/services/review/{approve,reject,dm,fallback}.ts` (ビジネスロジック), `src/interactions/{buttons,modals}/review-*.ts` (ハンドラ群)。

**Tech Stack:** P2 と同一。新規依存なし。

---

## 実装順序（CodeRabbit 推奨）

1. **P3.1** (#8) — レビュー Embed 共通基盤 + ボタン投稿 + ルーター拡張
2. **P3.2** (#9) — 却下 Modal（理由必須 10–500 字）
3. **P3.3** (#10) — 承認フロー（weight_snapshot 凍結 + status 遷移）
4. **P3.4** (#11) — 結果 DM（承認/却下両ケース、`dm_delivery_status` 追跡）
5. **P3.5** (#12) — DM 失敗時のプライベートチャンネル fallback + 了解ボタン
6. **P3.6** (#13) — fallback 未確認時の再起稿 block

---

## P3.1 (#8): 審査 Embed 基盤 + Approve/Reject ボタン infra

**スコープ:** Embed builder 群、ボタン components、`MESSAGE_COMPONENT` dispatcher、楽観ロック付き status UPDATE ヘルパー。実際の承認/却下ビジネスロジックは P3.3/3.2 で実装。

**新規 / 変更:**
- `migrations/0003_add_review_message_id.sql` — `ads.review_message_id` (TEXT, nullable) を追加
- `src/db/schema.ts` — drizzle 反映
- `src/discord/embeds/review.ts` (新) — `buildReviewEmbed(ad, sponsor)`, `buildReviewOutcomeEmbed(ad, action, reviewerId, reason?)`, `buildReviewButtons(adId)` の 3 関数
- `src/db/queries/review.ts` (新) — `updateAdStatusOptimistic(client, adId, fromStatus, patch)` (楽観ロック)、`insertReviewLog(client, adId, reviewerId, action, reason?)`
- `src/discord/review-embed.ts` — `postReviewEmbed` を更新し、message_id を返却 (caller が `ads.review_message_id` に保存)
- `src/interactions/modals/submit-modal.ts` — `postReviewEmbed` 戻り値を `ads.review_message_id` に永続化
- `src/interactions/router.ts` — MESSAGE_COMPONENT で `review:approve:*` / `review:reject:*` の prefix 仮 dispatch 経路を追加（実装は次 commit）
- `src/sponsors/reviewer-auth.ts` (新) — `verifyReviewer(payload, reviewerRoleId)` ヘルパー、ephemeral 拒否レスポンス
- `tests/discord/embeds/review.test.ts`, `tests/db/queries/review.test.ts`

**custom_id 規約:**
- `review:approve:{adId}` — 承認ボタン
- `review:reject:{adId}` — 却下ボタン（→ Modal）

---

## P3.2 (#9): 却下 Modal

**スコープ:** Reject ボタン押下時に Modal を返却し、Modal 提出を処理して `status='rejected'` + `reject_reason` 更新、Embed を outcome 表示に編集、review_logs INSERT。

**新規 / 変更:**
- `src/interactions/buttons/review-reject-button.ts` (新) — Reject ボタン押下 → Modal を返す。custom_id `reject-modal:{adId}`
- `src/interactions/modals/review-reject-modal.ts` (新) — Modal 提出受信 → サーバ側で再検証（10–500 字） → status update + log insert + Embed 編集
- `src/interactions/router.ts` — `review:reject:*` ボタン → reject button handler、`reject-modal:*` MODAL_SUBMIT → reject modal handler の dispatch を追加
- `tests/interactions/buttons/review-reject-button.test.ts`, `tests/interactions/modals/review-reject-modal.test.ts`

**Modal 仕様:**
- title: 「却下理由を入力」
- 1 ACTION_ROW × 1 TEXT_INPUT (PARAGRAPH, required, min=10, max=500)
- 末尾注意書き: 「この理由は起稿者に DM で通知されます」

---

## P3.3 (#10): 承認フロー

**スコープ:** Approve ボタン押下 → sponsor の `current_tier_id` から `tiers.weight` を引いて `weight_snapshot` に凍結 → `status='approved'`, `starts_at=now()`, `reviewed_by/at` 更新 → review_logs INSERT → Embed 編集。

**新規 / 変更:**
- `src/services/review/approve.ts` (新) — `approveAd(client, adId, reviewerId)` サービス。トランザクション内で楽観ロック+ tier lookup + weight snapshot + log insert
- `src/interactions/buttons/review-approve-button.ts` (新) — Approve ボタン押下 → `approveAd` 呼び出し → Embed 編集 → 暫定 ephemeral 確認（DM は P3.4）
- `src/interactions/router.ts` — `review:approve:*` の本実装に切り替え
- `tests/services/review/approve.test.ts`, `tests/interactions/buttons/review-approve-button.test.ts`

**Result 型:**
```ts
type ApproveResult =
  | { ok: true; ad: ApprovedAd }
  | { ok: false; reason: 'not_pending' | 'no_tier' | 'not_found' };
```

---

## P3.4 (#11): 結果 DM

**スコープ:** 承認/却下確定後に起稿者へ DM Embed を送信。`dm_delivery_status` を `pending → sent` または `failed` に更新。403（DM オフ）時は `failed` を返し、P3.5 の fallback トリガーへ繋げる。

**新規 / 変更:**
- `src/discord/embeds/result-dm.ts` (新) — `buildApproveDmEmbed(ad)`, `buildRejectDmEmbed(ad, reason)`
- `src/services/review/dm.ts` (新) — `sendResultDM(rest, client, ad, action, reason?)`. Discord REST `POST /users/@me/channels` → `POST /channels/{}/messages`。403 catch + `dm_delivery_status='failed'` 更新 + `{ ok: false, reason: 'dm_blocked' }` 返却
- `src/db/queries/review.ts` — `updateDmDeliveryStatus(client, adId, status, deliveredAt?)` を追加
- `src/interactions/buttons/review-approve-button.ts` & `review-reject-modal.ts` — 確定後に `sendResultDM` を呼び、結果に応じて P3.5 の fallback も呼ぶ（P3.5 完了まで stub）
- tests

**DM Embed 仕様（spec §4.5.1 準拠）:**
- Approve: title「✅ 広告が承認されました」、fields に title/slot/ad_id/starts_at/weight_snapshot
- Reject: title「❌ 広告が却下されました」、fields に title/slot/ad_id/reviewed_at + 却下理由を blockquote で

---

## P3.5 (#12): プライベートチャンネル fallback + 了解ボタン

**スコープ:** DM 失敗時にプライベートチャンネルを動的作成し、permission_overwrites で起稿者と Bot のみ可視。結果 Embed + `[✅ 了解]` ボタンを投稿。ボタン押下でチャンネル削除 + 状態更新。

**新規 / 変更:**
- `src/services/review/fallback.ts` (新) — `createFallbackChannel(rest, client, ad, action, reason?)`:
  1. Discord REST `POST /guilds/{}/channels` でプライベートチャンネル作成
  2. `dm_fallback_channels` INSERT (TTL 7 日)
  3. `ads.dm_delivery_status='fallback_posted'` 更新
  4. 結果 Embed + 了解ボタン (`custom_id=ack:{fallback_id}`) を `createMessage`
- `src/interactions/buttons/fallback-ack-button.ts` (新) — 了解ボタン押下 → 起稿者本人検証 → `acknowledged_at=now()` 更新 → `ads.dm_delivery_status='fallback_acknowledged'` → `DELETE /channels/{}`
- `src/discord/embeds/result-dm.ts` — 既存の DM Embed builder を再利用（fallback でも同じ shape）
- `src/interactions/router.ts` — `ack:*` の dispatch 追加
- 環境変数: `FALLBACK_CHANNEL_CATEGORY_ID`, `DISCORD_APP_BOT_ID` （既に env.ts/Bindings にあるはず → 無ければ追加）
- tests

**permission_overwrites:**
```
{ id: GUILD_ID, type: 0, deny: '1024' }                       // @everyone: VIEW_CHANNEL deny
{ id: sponsorId, type: 1, allow: '1024 | 65536' }              // sponsor: VIEW + READ_MSG_HISTORY
{ id: BOT_ID,    type: 1, allow: '1024 | 2048 | 65536 | 16384' } // Bot: VIEW + SEND + READ_HISTORY + MANAGE_MSGS
```

---

## P3.6 (#13): 再起稿 block

**スコープ:** `blockIfUnackedFallback` を `/ad submit`, `/admin submit (kind=regular)`, `/ad replace-image` の入口で実行。未確認 fallback があれば ephemeral 拒否し、対象チャンネルをメンション。Discord 上で削除済みチャンネルは auto-close。

**注:** `src/sponsors/fallback-gate.ts` には既に `blockIfUnackedFallback` がある（P2.4 で実装済）。この commit では:
1. **auto-close ロジックを追加** — Discord REST で `getChannel(channelId)` を呼び 404 が返ったら `acknowledged_at=now()`, `ads.dm_delivery_status='fallback_acknowledged'` に更新
2. **`/admin submit` 入口に組み込み** — 既存 `/admin submit` ハンドラがあれば（P6 でなければ未実装）、kind=regular のときだけ呼ぶように。**この PR の範囲では `/admin submit` は未実装の可能性あり** → 該当ハンドラがあれば組み込む、なければ TODO コメントで P6 へ送る。
3. **既存 `/ad submit` (P2 で組み込み済み) を確認** — auto-close 拡張版を呼ぶ

**新規 / 変更:**
- `src/sponsors/fallback-gate.ts` — auto-close 拡張、戻り値型整備
- `src/interactions/commands/ad-submit.ts` — 新版 `blockIfUnackedFallback` 利用
- tests — auto-close (Discord 404)、ephemeral block、normal pass-through

---

## スコープ外（後続 milestone）

- 任意の管理者向け `🔁 fallback 強制クローズ` ボタン (P6)
- TTL 切れチャンネルの自動削除 cron (P7)
- `/admin submit` でのフルゲート組み込み (P6)
