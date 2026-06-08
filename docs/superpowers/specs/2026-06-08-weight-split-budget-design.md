# Phase 1 設計: スポンサー重み予算の分割（複数バナー）

- 日付: 2026-06-08
- ステータス: ドラフト（ユーザーレビュー待ち）
- スコープ: バックエンドのみ。UX（広告ポータル）は Phase 2 として別 spec。

## 1. 背景と目的

現在は「1スポンサー = 1広告」で、承認時にスポンサーの tier 重みを丸ごと1広告の
`weight_snapshot` に凍結している（`maxActiveAds = 1`）。

本フェーズでは、スポンサーが自分の **tier 重みを予算**として複数バナーに**自由分割**
できるようにする。例: Planet（weight 80）は重み 50/20/10 の3本でも、1×80本でも可。
スポンサーの総インプレッションシェアは tier 重みに比例したまま（変えない）で、
クリエイティブの多様性だけを得る。

配信ロジック（`src/serve/pick.ts`）は広告ごとに `weight_snapshot` 回デッキ展開し
シェア = W_ad / Σ(全 W) で算出するため、分割そのものは既に成立する。本質的な変更は
**書き込み経路の予算管理**と**夜間 cron**、および**配信の隣接回避のスポンサー対応**。

## 2. 決定事項（確定）

| # | 決定 | 採用 |
|---|---|---|
| 1 | 分割方法 | 自由分割（各バナー weight ≥ 1、合計 ≤ 枠、既定 1） |
| 2 | 本数上限 | 枠に連動（各 ≥1 かつ 合計 ≤ 枠 ⇒ 本数 ≤ 枠 が自動成立。独立カウントゲートは廃止） |
| 3 | 重み指定 | `/ad submit` に `weight` オプション（既定1）。pending 段階で予算予約 |
| 4 | tier 重み変更時 | 比例リスケール |
| 5 | 予算 | 上限（合計 ≤ 枠。使い切らなくてよい） |
| 6 | 降格で枠 < 本数 | 重みの小さい順に停止（pause）＋ `admin_log` ＋ DM |
| 7 | n≥2 同一スポンサー同時表示 | 許す（1レスポンス内の dedup はしない） |
| 8 | admin 投稿（created_by_admin） | 予算対象外（残予算は管理UIに表示） |
| 9 | 連続配信 | 同一広告に加え **同一スポンサーも連続しない**よう散らす（best-effort） |

## 3. データモデル

`src/db/schema.ts` + 新規 migration。

- `ads.weight_alloc INTEGER`（新規, nullable）
  - スポンサーが選んだ配分点（**意図**）。regular のみ設定、既定 1。
  - admin/house/placeholder は NULL（予算対象外）。
- `ads.weight_snapshot`（既存）の意味を「**実効デッキ重み**」と明確化。
  - 承認・cron で **同一の純関数** `effectiveWeights(allocs, T)` から導出する。
- 制約: `CHECK (weight_alloc IS NULL OR weight_alloc > 0)`、
  既存の `weight_snapshot` についても `CHECK (weight_snapshot IS NULL OR weight_snapshot > 0)`
  を追加（現状この CHECK は無い）。
- `tiers.maxActiveAds` はカラムとして残置するが、**ゲートとしては不使用**（予算不変条件に置換）。

### 実効重み関数（承認と cron で共通使用）

スポンサー S の承認済み regular バナー群の `weight_alloc` を a_1..a_k、tier 重みを T とする。

```
S = Σ a_i
if S <= T:
    weight_snapshot_i = a_i                       # 意図そのまま（上限なので余りは未使用シェア）
else:                                             # 降格で alloc 合計が新枠を超過
    weight_snapshot_i = max(1, round(a_i * T / S))
    # min-1 床で k > T のため合計が依然 T を超える場合:
    #   weight_alloc 昇順に status='paused' へ落とす（決定 #6）→ 残りで再計算
```

- 旧 tier 重みを保存せずに比例リスケールが成立する（基準はスポンサー自身の Σalloc）。
- 昇格（T 増加）時は S ≤ T となり weight_snapshot = weight_alloc（意図不変。余剰枠は
  スポンサーが再分割するまで未使用＝決定 #5 の上限セマンティクスと整合）。
- 整数丸めの余りは **S > T の縮小時のみ** 最大 alloc のバナーで吸収し、縮小後の
  スポンサー内 Σweight_snapshot を T に一致させる。S ≤ T 時は weight_snapshot = weight_alloc
  なので Σ = S（≤ T。上限セマンティクスにより余剰枠は未使用シェアのまま）。
- **min-1 床と負の余りの両立**: 余りが負（丸め超過の解消で吸収バナーから減算する）場合でも、
  吸収バナーの `weight_snapshot` を 1 未満にしてはならない。最大 alloc バナーへの吸収で 1 を
  割るなら、**次に大きい alloc のバナーへ繰り越して**吸収する。survivor は count ≤ T を満たすよう
  既に pause 済みなので、各 survivor に weight 1 を割り当てても Σ ≤ T が成立し、吸収先は必ず
  見つかる。結果として常に `Σ weight_snapshot == T` かつ各 `weight_snapshot ≥ 1`。

### 予算不変条件

```
Σ weight_alloc  over  S の status ∈ {pending, approved} の regular 広告  ≤  T
```

- T は `tiers.weight`（スポンサーの `current_tier_id` 経由）。
- **tier を持たないスポンサー**（current_tier_id = NULL: 例 FANBOX/DLsite/株スレ）は
  予算対象外。weight は従来どおり（FANBOX/DLsite は repo 外リバランストリガが管理）。

## 4. 不変条件の担保（方式: 単文アトミック条件付き書き込み）

SQLite/D1 の行単位 CHECK では集計（クロス行 SUM）不変条件を表現できない。さらに
**D1 にはインタラクティブ・トランザクションも行ロックも無い**（Workers の D1 クライアントでは
`BEGIN`/`COMMIT` は実質 no-op）。したがって「再読込 → 判定 → 書き込み」は直列化されず、
読み取りと書き込みの間に別ライタが割り込み得る。read-then-write による予算チェックは
競合下で安全でない。

代わりに **単一文のアトミックな条件付き書き込み**で担保する。SQLite は 1 文を
アトミックに実行し single-writer なので、同時ライタは互いのコミット済み行を見る。

- **投稿（pending INSERT）**: 予算条件付きの `INSERT ... SELECT ... WHERE` にする。
  ```sql
  INSERT INTO ads ( ...columns... )
  SELECT ...values...
  WHERE (SELECT COALESCE(SUM(weight_alloc), 0) FROM ads
           WHERE sponsor_id = ? AND kind = 'regular' AND created_by_admin IS NULL
             AND status IN ('pending', 'approved')) + ?   -- 要求 weight
        <= (SELECT t.weight FROM tiers t
              JOIN sponsors s ON s.current_tier_id = t.id
             WHERE s.discord_user_id = ?);
  ```
  影響行数（D1 の `meta.changes` / `rows_written`）を見る。0 ⇒ `budget_exceeded`
  （行は挿入されていない）。
- **承認（pending→approved）**: pending が既に予算を予約済みなので、承認は投稿後に
  tier が縮小した場合のみ失敗すればよい。同じ `SUM ≤ T` サブクエリ（当該広告を除外）で
  ガードしたアトミックな条件付き `UPDATE` を行い、`meta.changes` を見る。0 ⇒ `budget_exceeded`。
- スキーマでは保証できない旨（クロス行 SUM 不変条件）はコメントで明記。
- 競合（同時投稿/同時承認）で各々が個別チェックを通過して合算超過するのを、
  この単文アトミック書き込みが防ぐ（read-then-write では防げない）。

## 5. 投稿フロー

対象: `src/interactions/commands/ad-submit.ts`、`src/interactions/modals/submit-modal.ts`、
`scripts/register-commands.ts`。

- `/ad submit` に INTEGER オプション `weight`（既定 1・最小 1・最大 = 残予算）を追加。
- pending 広告に `weight_alloc` を保持（= 予算予約）。
  - 現状 `submit-modal.ts` は `weight_snapshot = NULL` で INSERT。これを
    `weight_alloc = 要求値` で保持するよう変更（pending は weight_snapshot 未設定のまま）。
- 既存のカウントのみのゲート（`ad-submit.ts` / `submit-modal.ts`）を **予算ゲート**へ置換。
  - `ad-submit.ts`（モーダル表示前）: `getSponsorBudget` による **ベストエフォートの事前チェック**
    （`要求 > remaining` なら即拒否・理由表示）。権威的な担保はモーダル側の単文書き込み。
  - `submit-modal.ts`（pending INSERT）: §4 の **アトミックな条件付き INSERT**
    （`Σ(pending+approved alloc) + 要求 ≤ T` を WHERE で満たす行のみ挿入）。影響行数 0 ⇒
    超過として拒否（行は未挿入）。D1 に行ロックが無いため read-then-write は使わない。

## 6. 承認フロー

対象: `src/services/review/approve.ts`、`src/db/queries/review.ts`。

- 現状の `weight_snapshot = lookup.weight`（tier 重み丸ごと凍結）を廃止。
- 承認時に `effectiveWeights()` を適用して当該バナーの `weight_snapshot` を書き込む。
- 予算 SUM の再検証は **D1 にインタラクティブ tx が無い**ため、`REPEATABLE READ` tx ではなく
  §4 の **アトミックな条件付き `UPDATE`**（`SUM(weight_alloc) ≤ T` サブクエリでガード、
  当該広告を除外、pending→approved）で行う。`meta.changes`（影響行数）が 0 なら
  新しい結果型 `{ ok:false, reason:'budget_exceeded' }` を返す（投稿〜承認の間に tier が
  下がった場合を捕捉）。pending は既に予算を予約しているので、承認は tier 縮小時のみ失敗する。
- 既存 `approve.ts` の Postgres 由来の文字列を是正する:
  `BEGIN ISOLATION LEVEL REPEATABLE READ` を撤去し（D1 では no-op で誤解を招く）、
  ステータス更新の `starts_at` も `now()` ではなく `(unixepoch() * 1000)` を使う
  （`updateAdStatusOptimistic` の `startsAt: 'now'` 経路が既にこれを発行する）。

## 7. 夜間 cron 書き換え（必須・同一 PR）

対象: `src/cron/audit-sponsor-membership.ts`（`syncWeightForSponsor`, 概ね 90–131 行）。

- 「承認済み全広告に tier 重みをスカラー貼付」を廃止。
- スポンサー単位で `effectiveWeights(allocs, T)` を再計算して各バナーの `weight_snapshot` を更新。
- 降格で枠 < 本数の場合は重み小さい順に `paused`、`admin_log` に before/after を記録、DM 通知。
- `created_by_admin IS NULL` 除外は維持（admin 投稿は対象外）。
- before/after ログ用の「変更前」読み取りも `getSponsorActiveRegularAllocs` と同じ
  `status IN ('pending','approved')` 集合を読む（予算対象集合と一致させ、`paused` を含めない）。
- **理由**: これを直さないと、分割後の初回夜間実行で各バナーが満額重みに戻り、
  スポンサーの総シェアがバナー数倍に膨張する（最重要リスク）。承認/投稿変更と同一 PR で出す。

## 8. 配信（serve）— スポンサー単位の隣接回避

対象: `src/utils/seeded-shuffle.ts`、`src/serve/pick.ts`。

- `pick.ts` の deck 構築クエリ（現 89 行 SELECT）に `sponsor_id` を追加取得。
- `spreadShuffle`/`trySwap` を **key 関数版**に一般化。隣接判定を「要素一致」から
  `keyOf(要素)` 一致へ。`keyOf(adId) = sponsor_id ?? adId`。
  - 同一スポンサー判定は同一広告を内包（同じ広告＝同じスポンサー）ため、現行の
    「同じ広告を連続させない」も自動的に満たす。
- bag は ad-id 配列のまま。`pick.ts` で `id → sponsor_id` の Map を作り `spreadShuffle` に渡す。
- **シェアは不変**（並べ替えのみ。`seededShuffle` の重み比は不変）。
- 数学的限界: あるスポンサーの合計重みが `ceil(N/2)` を超えると完全な非連続は不可能
  → best-effort（現行 spreadShuffle と同じ挙動）。
- 決定 #7 のとおり、n≥2 の1レスポンス内 dedup は **しない**（serve のスライス内同居は許容）。

## 9. 管理・一覧 UI（最小）

対象: `src/discord/admin-ads-list.ts`、`src/interactions/commands/ad-list.ts`、`src/db/queries/ads.ts`。

- 管理一覧・スポンサー一覧に、スポンサーの **配分済 / 残予算 / 枠** を表示。
  - 各行に `weight_alloc` を表示（既存一覧クエリに当該カラムを追加）。
  - 加えて `getSponsorBudget(client, sponsorId)` から得る予算サマリ行
    （`tierWeight` / `used` / `remaining`）を表示。
- admin 投稿時の誤超過を防ぐため、admin UI にも対象スポンサーの残予算を表示。
- Phase 1 でバナー一覧が必要な場面では既存の `getSponsorAds` を使う。
  **`getSponsorActiveBanners` は Phase 1 では定義しない**（このシンボルの正準定義は
  Phase 2 の `src/db/queries/portal.ts` にのみ存在し、`{ id, slot, title, status, weightAlloc }`
  を返す。Phase 1 がそれを先取り定義すると Phase 2 と契約が衝突する）。
- 注: リッチな UX 改修は Phase 2（広告ポータル）に委譲。本フェーズは情報露出の最小限に留める。

## 10. repo 外リバランストリガとの関係

`~/ad-tools/ad_rebalance_triggers.sql`（FANBOX 10% / DLsite 3%）は「**他**の eligible regular
重みの合計」を基準に再計算するため、分割しても合計は不変＝**シェア中立**（確認済み）。
分割でバナー行が増える分トリガ発火回数は増えるが、挙動は変わらない。

## 11. テスト方針

- 予算境界: 合計 = T / 超過拒否 / 同時投稿の競合（単文アトミック書き込みの有効性。
  影響行数 0 ⇒ 拒否、行は未挿入/未更新）。
- 承認と cron の **同値性**（同じ `effectiveWeights` を返す）。
- 降格リスケール: 比例配分・整数丸め余りの一致・min-1 床・小さい順 pause。
- `effectiveWeights` の **負の余り min-1 床エッジ**: 最大 alloc バナーで吸収すると 1 を割る
  ケースで、吸収先が次に大きい alloc へ繰り越され、各 weight ≥ 1 かつ Σ == T を満たすこと。
- pending の予算予約（pending alloc が SUM に算入される）。
- admin / tier-less スポンサーの除外。
- 配信: 同一スポンサー非隣接（best-effort）、シェア不変。
  - **支配的スポンサーでの劣化（best-effort）**: あるスポンサーの合計重みが `ceil(N/2)` を
    超える場合、完全な非連続は数学的に不可能。残存する同一スポンサー隣接が最小化されること、
    かつ per-ad シェア（各 ad の出現回数）が不変であることを assert。

## 12. 影響ファイル

- `src/db/schema.ts` + 新規 migration（weight_alloc、CHECK 群）
- `src/services/review/approve.ts`、`src/db/queries/review.ts`
- `src/cron/audit-sponsor-membership.ts`
- `src/sponsors/tier.ts`（`sumActiveWeight` / 予算ゲート primitives）
- `src/interactions/commands/ad-submit.ts`、`src/interactions/modals/submit-modal.ts`、`scripts/register-commands.ts`
- `src/serve/pick.ts`、`src/utils/seeded-shuffle.ts`
- `src/discord/admin-ads-list.ts`、`src/interactions/commands/ad-list.ts`、`src/db/queries/ads.ts`

## 13. 非目標（このフェーズでやらないこと）

- 広告ポータル UI（private channel ダッシュボード）→ Phase 2。
- admin 投稿への予算適用（意図的に対象外のまま）。
- 1レスポンス内（n≥2）のスポンサー dedup。
- repo 外リバランストリガの変更。

## 14. 主要リスク

1. **cron 未修正によるシェア膨張**（最優先。承認/投稿変更と同一 PR で cron 書換必須）。
2. **競合での予算超過**（クロス行 SUM は CHECK 不可、かつ D1 に行ロック/インタラクティブ tx 無し →
   read-then-write は不可。§4 の単文アトミック条件付き書き込み必須）。
3. **複数ゲートのドリフト**（投稿/承認/admin で予算ゲートを統一。admin 経路の既存バイパスに注意）。
4. **降格時の取りこぼし**（枠 < 本数で min-1 床 → 小さい順 pause ＋ 通知が必要）。
5. **UX スケール**（枠 80 ⇒ 最大 80 本。一覧・編集 UI は Phase 2 で本格対応）。
