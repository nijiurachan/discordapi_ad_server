# Migrations

drizzle-kit が生成した SQL を `migrations/` 配下に時系列で並べて運用する。
適用済みマイグレーション (`0000_…`〜`0006_…`) は **絶対に編集しない** こと。
スキーマ変更は必ず新規ファイルを追加して行う。

## 運用コマンド

```bash
# スキーマ変更を SQL 化（src/db/schema.ts を変更したあと）
npm run db:generate

# 生成された SQL を DB に適用
npm run db:migrate
```

`drizzle-kit generate` は `meta/_journal.json` も自動更新する。手で書いた SQL を
追加した場合は `_journal.json` を手動でメンテし、`npx drizzle-kit check` で
シーケンス整合性を確認する（既存ファイルの並びを尊重したまま新規エントリを追記する）。

## ファイル命名

- 4桁連番 + アンダースコア + 短いケバブケース説明: `0007_add_xxx_index.sql`
- `meta/<seq>_snapshot.json` は drizzle-kit が自動生成
- 同じ `<seq>` 番号を二度使わない（マージコンフリクト時は番号をリベース）

## 制約 (constraint) の追加ポリシー

新しい NOT NULL / CHECK / FOREIGN KEY を本番テーブルに足す場合、行が存在するかで
書き方を変える。**空テーブル**ならそのまま `ALTER TABLE … ADD CONSTRAINT …` で
即時 VALIDATE される。**既にデータが入っているテーブル**は、`NOT VALID` で先に
スキーマだけ確定させ、`VALIDATE CONSTRAINT` を別ステートメントで実行する 2 段構え
を採る。これにより、ALTER TABLE が長時間 `ACCESS EXCLUSIVE` ロックを保持する
リスクと、「制約違反データが既に入っていて ALTER 自体が失敗する」リスクの両方を
分離できる。

### 空テーブル (= 0000〜0002 のときに使ったパターン)

```sql
ALTER TABLE "ads"
  ADD CONSTRAINT "ads_kind_check"
  CHECK ("ads"."kind" IN ('regular','house','placeholder'));
```

`0002_constraints.sql` で全制約を即時付与しているのは、テーブルが新規でこの
タイミングまで本番データが存在しなかったからである。

### 既にデータがあるテーブル (= P7 以降の運用ベース)

```sql
-- Step 1: NOT VALID で書き込み新規行のみ検証する制約を付ける
DO $$ BEGIN
  ALTER TABLE "ads"
    ADD CONSTRAINT "ads_status_check_v2"
    CHECK ("ads"."status" IN ('pending','approved','paused','rejected','expired','withdrawn'))
    NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- Step 2: 既存行を別ステートメント（=別トランザクション）で検証
ALTER TABLE "ads" VALIDATE CONSTRAINT "ads_status_check_v2";
```

ポイント:

- Step 1 は短時間で完了する（既存行をスキャンしない）。
- Step 2 は `SHARE UPDATE EXCLUSIVE` ロックで済むので、書き込みをブロックしない。
- Step 1 が冪等になるよう `DO $$ … EXCEPTION WHEN duplicate_object THEN NULL` で
  既存制約を握りつぶす（`db:migrate` が同じファイルを再実行しても落ちない）。
- 既存制約の差し替えなら、新しい制約名 (`…_v2`) を付けて `ADD … NOT VALID` →
  `VALIDATE` のあとに `DROP CONSTRAINT <旧名>` を別ステートメントで実行する。
- どうしても 1 ファイル内に Step 1/Step 2 を両方書く場合は `--> statement-breakpoint`
  で必ず分割すること（drizzle-kit のデフォルト出力に揃える）。

### FK の場合のテンプレート

```sql
DO $$ BEGIN
  ALTER TABLE "child"
    ADD CONSTRAINT "child_parent_id_fk"
    FOREIGN KEY ("parent_id") REFERENCES "public"."parent"("id")
    ON DELETE no action ON UPDATE no action
    NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "child" VALIDATE CONSTRAINT "child_parent_id_fk";
```

`ON DELETE` の選択基準は `src/db/schema.ts` のコメント (P1.F6 で整備) を参照。

## 判断基準

| 状況 | 制約付与方法 |
|---|---|
| まだ誰もデータを INSERT していない新規テーブル | 即時 `ADD CONSTRAINT …` |
| 本番に行が入っている既存テーブル | `NOT VALID` → `VALIDATE` の 2 段 |
| 列追加 + NOT NULL | `ADD COLUMN` → `UPDATE` で埋める → `ALTER COLUMN … SET NOT NULL` の 3 段（巨大テーブルは避けて DEFAULT 経由が無難） |
| 一時的に運用を緩めたい | `NOT VALID` だけ付けて `VALIDATE` は別 PR に分割（再 deploy 後に保証する選択も可） |
