# Phase 3 設計: ポータルUX拡張（移行促進 / 統計 / 重み変更）

- 日付: 2026-06-08
- ステータス: ドラフト
- 前提: Phase 1（重み分割バックエンド）+ Phase 2（広告ポータル）は実装・本番デプロイ済み。
  関連: [2026-06-08-weight-split-budget-design.md](2026-06-08-weight-split-budget-design.md) /
  [2026-06-08-ad-portal-design.md](2026-06-08-ad-portal-design.md)

## 1. 目的

(A) 旧 submit メニューを **広告ポータル主体**に作り替えて移行を促す。
(B) スポンサーが **統計**をポータルから見られるようにする。
(C) スポンサーが **バナーの重み(weight_alloc)** をポータルから変更できるようにする。

既存資産（統計フロー・予算ガード・effectiveWeights・ポータル描画）を最大限再利用する。

## 2. 決定事項（確定）

| # | 項目 | 採用 |
|---|---|---|
| A | 移行の強さ | 旧メニューを **ポータル主体に作り替え**（`/ad submit` と従来ボタンは補助として残す） |
| B | 統計の中身/場所 | 既存集計（imp/click/CTR・期間選択）を **エフェメラル**。新規ハンドラ/クエリなし |
| C | 重み変更UX | 管理ビューの **バナー毎「重み変更」ボタン → 数値モーダル** |

## 3. コンポーネント設計

### A. 旧メニューのポータル主体化
対象: `src/interactions/commands/ad-setup.ts` の `buildSubmitMenu`。
- content を「## 📣 広告ポータル（推奨）」主体に変更し、**先頭に `portal:open` ボタン**（style 1）を配置。
- 従来の `/ad submit` 案内＋既存ボタン（`ad:list` / `ad:stats:period` / `ad:rules` / `ad:help`）は
  「━ 従来の操作 ━」として下段に残す（完全互換・挙動不変）。
- `buildSubmitMenu` の戻り値 `components` を2行（ポータル行＋従来行）に。`/ad submit` 等は無改修。
- 注: `portal:open` は既に `router.ts` の `portal:` arm に到達するため配線追加不要。

### B. ポータルに統計
対象: `src/services/portal/render.ts`（ダッシュボードのボタン行）。
- ボタン行に **📊統計**（`type:2, style:2, custom_id:'ad:stats:period'`）を追加。**既存の統計フローを再利用**：
  `ad:stats:period` → `periodSelectMenuResponse`（24h/7d/30d/all セレクト）→ `ad:stats:<period>` →
  `runAdStats(userId, period)` → `getAggregateStats`。
- 表示はエフェメラル・クリッカー自身の集計のみ＝**漏洩リスク無し**（他者データに触れない）。新規ハンドラ/クエリ/列なし。
- コンポーネント上限に注意（1行5ボタン）。現行4ボタン＋📊＝5でちょうど上限。超える場合は2行目へ。

### C. ポータルで重み変更
対象: `src/interactions/buttons/portal-dashboard-buttons.ts`（管理ビュー）、新規 weight ハンドラ、`router.ts`。

**C-1 管理ビューに編集ボタン**
- `portal:manage`（所有権チェック済み）でバナー一覧を出す際、各バナーに
  **「重み変更」ボタン `portal:weight:<adId>`** を付与（`getSponsorActiveBanners(owner)` 由来）。
- コンポーネント制約（5行×5）に収まる件数で出す。超過時は先頭 N 件＋「続きは /ad list」等の注記（YAGNI: まず N=4〜5）。

**C-2 編集ボタン → モーダル**
- `portal:weight:<adId>`（button）ハンドラ：所有権（その ad の `sponsor_id == clicker`）を確認し、
  **モーダル** `portal:weight-modal:<adId>` を返す。テキスト入力1つ「新しい重み（1以上）」。

**C-3 モーダル送信 → 更新**
- `portal:weight-modal:<adId>`（modal submit）ハンドラ：
  1. 入力を整数パース。`< 1` や非数値はエフェメラルエラー。
  2. **所有権＋予算を単一文の原子的 UPDATE で担保**（submit/approve と同じ方式）。
     ※ `?1/?2/?3` は説明用の番号付け。実装は既存 submit-modal.ts / approve.ts の原子的
     条件付き書き込みに倣い、プレースホルダ `?` を繰り返し束縛する形（params 配列で同値を再掲）にする:
     ```sql
     UPDATE ads SET weight_alloc = ?1
     WHERE id = ?2 AND sponsor_id = ?3 AND kind='regular'
       AND status IN ('pending','approved')
       AND ( (SELECT COALESCE(SUM(weight_alloc),0) FROM ads
                WHERE sponsor_id = ?3 AND kind='regular' AND created_by_admin IS NULL
                  AND status IN ('pending','approved') AND id != ?2) + ?1 )
           <= (SELECT t.weight FROM tiers t
                 JOIN sponsors s ON s.current_tier_id = t.id
                 WHERE s.discord_user_id = ?3);
     ```
     `meta.changes === 0` → 予算超過 or 対象外（他者/存在しない/終了状態）→ エフェメラルで理由表示。
  3. **effectiveWeights 即再計算**：`getSponsorActiveRegularAllocs(client, sponsorId)` ＋
     `applyEffectiveWeights(client, sponsorId, effectiveWeights(allocs, tierWeight))`（Phase 1 の既存資産）で
     `weight_snapshot` を更新 → serve_rotation 署名変化 → 次の `/serve` でデッキ再構築・反映。
  4. **ダッシュボード再描画**：`findOpenPortalBySponsor(client, sponsorId)` で `channel_id`/`dashboard_message_id`
     を引き、`rest.editMessage(channelId, messageId, buildPortalDashboard(...))` で更新＋`touchPortalActivity(portal.id)`。
     ポータル行が無ければ再描画はスキップ（情報のみ更新済み）。
  5. モーダルにはエフェメラル「重みを変更しました（残りウェイト N）」を返す。

**C-4 配線**: `router.ts` に `portal:weight:`（button → weight ボタンハンドラ）と
`portal:weight-modal:`（modal submit → weight モーダルハンドラ）の振り分けを追加。

## 4. 横断方針
- **所有権ガード徹底**：weight ボタン/モーダルは対象 ad の `sponsor_id == clicker` を必ず検証
  （Phase 2 最終レビューのクロススポンサー教訓）。
- **再利用最大化**：統計（runAdStats/getAggregateStats/periodSelectMenuResponse）、予算単一文ガード、
  effectiveWeights/applyEffectiveWeights/getSponsorActiveRegularAllocs、findOpenPortalBySponsor、
  buildPortalDashboard/getSponsorActiveBanners は既存をそのまま使う。
- **トリガ整合**：weight_alloc/weight_snapshot 変更で out-of-repo FANBOX/DLsite トリガが発火するが
  「他の eligible regular 重み合計」基準＝split中立で影響なし。

## 5. テスト方針
- A: `buildSubmitMenu` の content にポータル CTA、components に `portal:open` ボタンが含まれる。従来ボタンも残る。
- B: ダッシュボード components に `ad:stats:period` ボタンが含まれる。
- C 成功: 予算内の新重み → `changes` あり、weight_alloc 更新、`applyEffectiveWeights` 呼出、`editMessage` 再描画、
  エフェメラル確認。
- C 予算超過: 残予算を超える重み → `changes===0` → エフェメラルで拒否、weight_snapshot 不変、再描画なし。
- C 非所有者: 他人の adId のモーダル送信 → `changes===0`（sponsor_id 不一致）→ 拒否。データ変化なし。
- C 入力不正: 非数値/0/負 → バリデーションエラー。
- effectiveWeights 連携: 重み変更後に getSponsorActiveRegularAllocs→applyEffectiveWeights で snapshot が新 alloc を反映。

## 6. 影響ファイル
- `src/interactions/commands/ad-setup.ts`（buildSubmitMenu）
- `src/services/portal/render.ts`（📊統計ボタン）
- `src/interactions/buttons/portal-dashboard-buttons.ts`（manage に重み変更ボタン；weight button/modal ハンドラ or 新規ファイル `portal-weight.ts`）
- `src/interactions/router.ts`（`portal:weight:` / `portal:weight-modal:` 振り分け）
- `src/db/queries/portal.ts` / `src/db/queries/review.ts`（既存の budget 単一文 UPDATE と applyEffectiveWeights を再利用。必要なら weight 更新用 helper を portal.ts に薄く追加）
- 各テスト

## 7. 非目標
- ポータル内テキスト編集/画像差し替え/一時停止（将来）。
- 統計のバナー別内訳（今回は既存集計の再利用に限定）。
- 旧 submit メニューの完全廃止（主体化に留め、`/ad submit` と従来ボタンは残す）。
