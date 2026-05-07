# discordapi_ad_server 設計仕様書

| 項目 | 値 |
|---|---|
| Project | `nijiurachan/discordapi_ad_server` |
| Created | 2026-05-07 |
| Status | Draft (brainstorming completed, awaiting plan) |
| Authors | So4246la |

## 1. 目的とユースケース

Discord サーバーを軸にしたスポンサー支援型の広告配信プラットフォーム。

### 主要ユーザーロール

| ロール | 主な操作 |
|---|---|
| **スポンサー** | 起稿（Discord に支援金額連動の Server Role を保有） |
| **審査者** | Discord 上で承認/却下（審査ロール保持者） |
| **管理者** | ティア・入稿ルール・ハウス広告・統計を Discord 上で全管理（管理ロール保持者） |
| **エンドユーザー** | Web サイトで広告を閲覧・クリック |

### 配信フロー

1. スポンサーが Discord 上で広告を起稿（テキスト + リンク + 画像 / GIF）
2. 専用チャンネルで審査者が承認/却下（理由必須）
3. 承認された広告が Web サイトに **重み付きランダム**で配信
4. impression / click を記録、ダッシュボードと CTR レポートを提供

### 重み付き配信モデル

- スポンサーの Discord ロール（Tier）ごとに `weight`（重み）を定義
- 承認時点の Tier weight を `weight_snapshot` に凍結
- Web からの配信要求に対し、有効広告から重み付きランダムで選択

## 2. アーキテクチャ概要

```
[スポンサー]                              [Discord]
   │                                          │
   │ Slash/Button/Modal                       │ Interactions Endpoint URL (HTTPS)
   ▼                                          ▼
┌───────────────────────────────────────────────────────┐
│  Cloudflare Workers (Hono)                            │
│   ├ /interactions  : Discord 受信                     │
│   ├ /ads/serve     : 広告配信 API                      │
│   ├ /ads/click/:id : クリック計測 → 302                │
│   ├ /ads/image/:id : 画像配信 (S3 プロキシ)            │
│   └ /ads/track/*   : 補助計測エンドポイント            │
└──────┬─────────────────────┬──────────────────────────┘
       │ Postgres (HTTPS or  │ S3 互換 API (HTTPS)
       │  Hyperdrive)         │
       ▼                     ▼
  [既存 PostgreSQL]      [既存 NAS S3 互換]
```

### 技術スタック

| 層 | 採用 |
|---|---|
| Runtime | **Cloudflare Workers** |
| Language | **TypeScript** |
| Web Framework | **Hono** |
| DB | **既存 PostgreSQL** (Hyperdrive 経由 or 直接 pg) |
| ORM/Migration | **drizzle-orm** + **drizzle-kit** |
| Object Storage | **既存 NAS の S3 互換**（MinIO / Synology / TrueNAS 等） |
| S3 Client | **@aws-sdk/client-s3** (Workers 互換) |
| Discord 受信 | **HTTP Interactions Endpoint URL**（Gateway は使わない） |
| Discord 送信 | **Discord REST API**（Embed 投稿/編集、DM、コマンド登録） |
| 署名検証 | **Ed25519**（discord-interactions または自前） |
| Validation | **Zod** |
| Image probing | Workers WebAssembly 画像プローブ（軽量実装） |

### Web 管理画面は採用しない

すべての管理操作は Discord で完結する。OAuth、HTML レンダリング、Cookie、CSP/CSRF は不要。

### サーバレス制約

discord.js は **使用しない**（Gateway WebSocket 必須のため）。
Discord からの全イベントは Interactions Endpoint URL 経由の HTTP POST で受け取る。Bot からの能動アクション（メッセージ投稿・編集・DM 送信）は REST API を直接呼ぶ。

## 3. データモデル

### 3.1 sponsors

```sql
CREATE TABLE sponsors (
  discord_user_id  TEXT PRIMARY KEY,
  display_name     TEXT NOT NULL,
  current_tier_id  INT REFERENCES tiers(id),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`current_tier_id` は起稿時の lazy refresh で更新される（HTTP Bot は Gateway イベントを受け取れないため）。

### 3.2 tiers

```sql
CREATE TABLE tiers (
  id               SERIAL PRIMARY KEY,
  discord_role_id  TEXT UNIQUE NOT NULL,
  name             TEXT NOT NULL,
  weight           INT  NOT NULL CHECK (weight > 0),
  max_active_ads   INT  NOT NULL DEFAULT 1,
  rank             INT  NOT NULL
);
```

- `weight`: 重み付き選択の重み
- `max_active_ads`: 同時に出せる広告数の上限
- `rank`: 表示順序（管理画面で並べ替え用）

### 3.3 ads

```sql
CREATE TABLE ads (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsor_id       TEXT REFERENCES sponsors(discord_user_id),
  kind             TEXT NOT NULL DEFAULT 'regular'
                       CHECK (kind IN ('regular','house','placeholder')),
  slot             TEXT NOT NULL DEFAULT 'default',
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  link_url         TEXT NOT NULL,
  image_key        TEXT,
  image_mime       TEXT,
  image_bytes      INT,
  image_width      INT,
  image_height     INT,
  status           TEXT NOT NULL CHECK (status IN
                       ('pending','approved','paused','rejected','expired','withdrawn')),
  weight_snapshot  INT,
  reject_reason    TEXT,
  reviewed_by      TEXT,
  reviewed_at      TIMESTAMPTZ,
  starts_at        TIMESTAMPTZ,
  ends_at          TIMESTAMPTZ,
  created_by_admin TEXT,                                -- /admin submit 経由なら起稿管理者の Discord user id
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ads_kind_sponsor
    CHECK ((kind = 'regular'     AND sponsor_id IS NOT NULL)
        OR (kind IN ('house','placeholder') AND sponsor_id IS NULL))
);

CREATE INDEX ads_active_idx
  ON ads (status, kind, slot, starts_at, ends_at)
  WHERE status = 'approved';
```

- `kind`: 広告の種別
  - `regular`: 通常広告。Tier weight に基づく重み付き選択の候補
  - `house`: 通常広告がゼロのときに表示するハウス広告（管理者が CRUD、`sponsor_id` は NULL）
  - `placeholder`: 通常広告も house もないときの最終フォールバック（「スポンサー募集中」等）
- `weight_snapshot`: 通常広告は承認時点の Tier weight、`/admin submit` の場合は管理者が明示指定した値を凍結
- `ends_at`: NULL = 無期限、未来の値 = その時刻に自動失効
- `slot`: 掲載枠の識別子。MVP は `'default'` のみ運用
- `created_by_admin`: `/admin submit` 経由で起稿された場合、起稿管理者の Discord user id を記録（監査用）

### 配信時の優先順位

`/ads/serve` の選択ロジック:

1. `kind='regular' AND status='approved'` の中から重み付きランダムで N 件
2. 1 で件数不足なら `kind='house' AND status='approved'` から不足分を等確率ランダム
3. それでも足りなければ `kind='placeholder' AND status='approved'` から先頭 1 件（slot ごとに 1 つあれば十分）

### Modal/管理コンソールでの編集対象

- 通常広告: スポンサーが起稿、審査者が承認、管理者が編集/停止/再開/強制終了可
- house: 管理者が `🏠 ハウス広告` ボタンで CRUD（審査スキップ、`status='approved'` で直接登録）
- placeholder: 管理者が `🎯 プレースホルダー` ボタンで CRUD（slot ごとに 1 件のみ、審査スキップ）

### 3.4 ad_format_rules

```sql
CREATE TABLE ad_format_rules (
  id                    SERIAL PRIMARY KEY,
  slot                  TEXT NOT NULL UNIQUE,
  allowed_mimes         TEXT[] NOT NULL,
  allowed_extensions    TEXT[] NOT NULL,
  max_bytes             INT  NOT NULL,
  min_width             INT,
  max_width             INT,
  min_height            INT,
  max_height            INT,
  aspect_ratios         TEXT[],
  aspect_tolerance      NUMERIC(4,3) DEFAULT 0.02,
  title_max_len         INT  NOT NULL DEFAULT 80,
  body_max_len          INT  NOT NULL DEFAULT 500,
  link_url_max_len      INT  NOT NULL DEFAULT 2048,
  link_scheme           TEXT[] NOT NULL DEFAULT ARRAY['https'],
  link_domain_allowlist TEXT[],
  link_domain_blocklist TEXT[],
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            TEXT
);
```

すべての制約は **管理者が Discord 上で編集可能**。バリデーションは起稿時にこのテーブルに従い、違反は受け付け拒否（DB / S3 への書き込みなし）。

### 3.5 ad_drafts

```sql
CREATE TABLE ad_drafts (
  id           UUID PRIMARY KEY,
  sponsor_id   TEXT NOT NULL,
  slot         TEXT NOT NULL,
  image_key    TEXT NOT NULL,    -- staging/{id}/orig.{ext}
  image_mime   TEXT NOT NULL,
  image_bytes  INT  NOT NULL,
  image_width  INT,
  image_height INT,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`/ad submit` で添付画像を S3 staging へ PUT した後、Modal 提出までの一時保管。Workers Cron で TTL 切れを掃除（S3 staging も同期削除）。

### 3.6 ad_events

```sql
CREATE TABLE ad_events (
  id          BIGSERIAL PRIMARY KEY,
  ad_id       UUID NOT NULL REFERENCES ads(id),
  event_type  TEXT NOT NULL CHECK (event_type IN ('impression','click')),
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_hash     TEXT,
  ua          TEXT,
  slot        TEXT
);

CREATE INDEX ad_events_ad_ts_idx ON ad_events USING BRIN (ad_id, ts);

CREATE VIEW ad_stats_daily AS
  SELECT ad_id,
         date_trunc('day', ts) AS day,
         COUNT(*) FILTER (WHERE event_type='impression') AS impressions,
         COUNT(*) FILTER (WHERE event_type='click')      AS clicks
  FROM ad_events
  GROUP BY ad_id, date_trunc('day', ts);
```

- `ip_hash = sha256(ip || daily_salt)`、`daily_salt` は UTC 0 時にローテ
- 個別の生 IP は保存しない
- 保持期間: 180 日（Workers Cron で日次削除）

### 3.7 review_logs / admin_logs

```sql
CREATE TABLE review_logs (
  id          BIGSERIAL PRIMARY KEY,
  ad_id       UUID NOT NULL REFERENCES ads(id),
  reviewer_id TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('approved','rejected','withdrawn')),
  reason      TEXT,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_logs (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id   TEXT,
  before      JSONB,
  after       JSONB,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.8 system_settings

```sql
CREATE TABLE system_settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);
```

メニューメッセージ ID、ハウス広告枠の有無、salt ローテ時刻などを格納。

## 4. Discord UX 設計

### 4.1 チャンネル構成

| チャンネル | 役割 | 閲覧 | メッセージ送信 |
|---|---|---|---|
| **#広告起稿** | スポンサー向け常設メニュー + `/ad submit` | スポンサー以上 | Bot のみ可（ユーザー不可） |
| **#広告審査** | 審査 Embed + 承認/却下ボタン | 審査ロール以上 | Bot のみ可 |
| **#広告管理** | 管理コンソール常設メニュー | 管理ロールのみ | Bot のみ可 |

### 4.2 #広告起稿 の常設メニュー

```
📣 広告起稿システム

起稿は下のチャット欄から /ad submit
  slot を選び、image に画像を添付してください
添付後、タイトル/本文/リンクの入力画面が開きます

[📋 自分の広告一覧] [📊 統計]
[📐 入稿ルール]    [❓ 起稿の手順を見る]
```

### 4.3 起稿フロー

```
ユーザー: /ad submit  コマンドを開く
  ↓ Discord UI:
    slot:  [▼ default]            ← Select option (choices)
    image: [📎 ここに画像をドラッグ]   ← ATTACHMENT option

ユーザー: 画像添付して送信
  └─ Worker:
     1. Ed25519 署名検証
     2. sponsor の Tier を Discord REST で再取得（lazy refresh）
        - tier.max_active_ads と current_active_count をチェック
        - 上限超過なら ephemeral 拒否（S3 書き込みなし）
     3. attachment.url / size / content_type / dimensions を ad_format_rules で検証
     4. NG → ephemeral エラー、終了（DB / S3 書き込みなし）
     5. OK → S3 staging/{draft_id}/orig.{ext} に PUT
     6. ad_drafts INSERT (TTL 10分)
     7. Modal を返す（custom_id="submit:{draft_id}"）
        ┌────────────────────────────┐
        │ 📝 広告内容を入力             │
        │ タイトル  : [_____________]   │
        │ 本文     : [             ]   │
        │           [             ]   │
        │ リンクURL : [_____________]   │
        └────────────────────────────┘

ユーザー: Modal 提出
  └─ Worker:
     1. draft_id から下書き取得（期限切れなら ephemeral でやり直しを案内）
     2. テキストをルール検証
        - title/body 長さ
        - link_url の scheme (https のみ)
        - link_url の domain allowlist/blocklist
     3. NG → ephemeral エラー、staging は TTL で自動削除
     4. OK:
        - max_active_ads を再チェック（Modal 入力中に他で枠を埋めた可能性）
        - staging/{draft_id}/orig.* → ads/{adId}/orig.* に S3 内コピー
        - ads INSERT (status='pending')
        - ad_drafts DELETE + staging オブジェクト削除
        - 審査チャンネルへ Embed + ボタン (Approve / Reject) を投稿
        - ephemeral「✅ 受付完了 / 結果は DM で通知」
```

### 4.4 #広告起稿 のボタン挙動

| ボタン | 挙動 |
|---|---|
| 📋 自分の広告一覧 | ephemeral Embed 一覧（pending/approved/paused/rejected/withdrawn）。各広告に `↩ 取り下げ` `📊 個別統計` ボタン |
| 📊 統計 | ephemeral 期間 Select（24h/7d/30d/all）→ 自分の広告の合算 impressions/clicks/CTR を Embed |
| 📐 入稿ルール | ephemeral でスロットごとの ad_format_rules を Embed 表示 |
| ❓ 起稿の手順を見る | ephemeral でスクリーンショット風の手順ガイド Embed |

### 4.5 #広告審査 の挙動

```
レビュアー: 起稿 Embed の [✅承認] または [❌却下] を押下
  └─ Worker:
     1. 署名検証 + member.roles に審査ロール ID 含有を確認
        無ければ ephemeral 拒否
     2. ads.status を WHERE status='pending' で楽観ロック UPDATE
        既に処理済なら ephemeral「他のレビュアーが処理しました」

     3a. Approve（理由入力なしでそのまま確定）:
        - sponsor の現在 Tier weight → ads.weight_snapshot
        - status='approved', starts_at=now(), reviewed_by/at
        - review_logs INSERT
        - 元 Embed を「✅ 承認済 by @reviewer」に編集
        - sendResultDM(ad, 'approved') を実行（後述）

     3b. Reject（理由必須）:
        - レビュアーへ Modal を返す:
            ┌───────────────────────────────────┐
            │ ❌ 却下理由（必須）                │
            │ ┌───────────────────────────────┐ │
            │ │ (paragraph, 10〜500 字)        │ │
            │ │                               │ │
            │ └───────────────────────────────┘ │
            │ ※ この理由は起稿者に DM で通知されます │
            └───────────────────────────────────┘
        - Modal の reject_reason は **required=true, min_length=10, max_length=500**
        - 空文字・10字未満は Discord 側で送信不可（クライアントブロック）
        - サーバ側でも改めて長さ検証、不足なら ephemeral 「理由は10字以上で入力してください」
        - status='rejected', reject_reason, reviewed_by/at を更新
        - review_logs INSERT (action='rejected', reason=reject_reason)
        - Embed を「❌ 却下 by @reviewer / 理由: ...」に編集
        - sendResultDM(ad, 'rejected', reject_reason) を実行（後述）
```

### 4.5.1 起稿者への DM 通知（承認・却下共通）

承認・却下のどちらの場合も、起稿者の Discord アカウントへ **必ず** DM を送信する。house / placeholder（sponsor_id NULL）は対象外。

**DM の送信フロー**

```
sendResultDM(ad, action, reject_reason?)
  1. Discord REST  POST /users/@me/channels  body: {recipient_id: ad.sponsor_id}
     → DM チャンネル ID を取得（既に開いていれば既存 ID が返る）
  2. POST /channels/{dm_channel_id}/messages  body: {embeds: [...]}
  3. レスポンスが 403 (Cannot send messages to this user) の場合は
     プライベート個別通知チャンネルを作成してフォールバック（後述 §4.5.2）
```

### 4.5.2 DM 失敗時のプライベート個別チャンネル fallback

DM が拒否された場合、起稿者以外には見えない一時プライベートチャンネルを作成し、そこで結果を通知する。起稿者が「了解」ボタンを押下、または TTL 経過で自動削除される。

**1. チャンネル作成**

```
fallbackToPrivateChannel(ad, action, reject_reason?)
  1. Discord REST POST /guilds/{GUILD_ID}/channels
     body:
       {
         "name": "result-{ad.id 先頭8字}",
         "type": 0,                          // GUILD_TEXT
         "parent_id": FALLBACK_CHANNEL_CATEGORY_ID,
         "permission_overwrites": [
           { "id": GUILD_ID,            "type": 0, "deny":  "1024" },  // @everyone: VIEW_CHANNEL deny
           { "id": ad.sponsor_id,       "type": 1, "allow": "1024 | 65536" },  // 起稿者: VIEW + READ_MESSAGE_HISTORY
           { "id": DISCORD_APP_BOT_ID,  "type": 1, "allow": "1024 | 2048 | 65536 | 16384" }
                                                                       // Bot: VIEW + SEND + READ_HISTORY + MANAGE_MESSAGES
         ],
         "topic": "個別通知（このチャンネルは「了解」ボタン押下または7日後に自動削除されます）"
       }
     → channel_id を取得

  2. POST /channels/{channel_id}/messages
     body:
       {
         "content": "<@{ad.sponsor_id}> 広告審査の結果通知です（DM がオフのためこちらに送信しました）",
         "embeds": [<同じ承認/却下 Embed>],
         "components": [
           { "type": 1, "components": [
             { "type": 2, "style": 1, "label": "✅ 了解", "custom_id": "ack:{dm_fallback_id}" }
           ]}
         ]
       }

  3. INSERT INTO dm_fallback_channels (id, ad_id, sponsor_id, channel_id, expires_at)
     VALUES (..., now() + interval '7 days')

  4. UPDATE ads SET dm_delivery_status = 'fallback_posted', dm_delivered_at = now()

  5. admin_logs INSERT (action='dm_fallback_created', target=ad.id)
```

**2. 「了解」ボタン押下時**

```
ボタン custom_id = "ack:<dm_fallback_id>"
  1. 署名検証
  2. SELECT FROM dm_fallback_channels WHERE id = $1
  3. interactions.member.user.id != sponsor_id なら ephemeral「あなたは対象ではありません」
     （起稿者本人以外がボタンを押せないチャンネル設計だが、念のため再検証）
  4. UPDATE dm_fallback_channels SET acknowledged_at = now() WHERE id = $1
  5. UPDATE ads SET dm_delivery_status = 'fallback_acknowledged'
  6. Discord REST DELETE /channels/{channel_id}
     失敗（既に削除されている等）は無視、admin_logs に warn として記録
  7. admin_logs INSERT (action='dm_fallback_acknowledged')
```

ボタン応答は ack の前段階で `interactions.callback_type=4` (CHANNEL_MESSAGE_WITH_SOURCE) または `5` (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE) を返す必要があるが、その後の DELETE channel は非同期で OK。

**3. 自動削除（Cron）**

毎時実行する Cron ジョブで TTL 切れの未確認チャンネルを掃除：

```sql
SELECT id, channel_id FROM dm_fallback_channels
 WHERE acknowledged_at IS NULL
   AND expires_at < now();
```

各レコードについて:
- Discord REST DELETE /channels/{channel_id}
- UPDATE dm_fallback_channels SET acknowledged_at = now() （`auto_expired` を区別したいなら別カラム追加可）
- ads.dm_delivery_status は `failed` に再遷移（起稿者は気付かなかったまま終了）
- admin_logs INSERT (action='dm_fallback_expired')

**4. 同一広告で複数回作らない**

同じ ad_id について `dm_fallback_channels.acknowledged_at IS NULL` のレコードが既にある場合、新規作成せず既存チャンネルへ追記投稿する。

**5. 必要な Bot 権限**

- `MANAGE_CHANNELS` (権限ビット `0x10` = 16): プライベートチャンネル作成・削除
- `MANAGE_ROLES` (権限ビット `0x10000000`): permission_overwrites の設定
- `SEND_MESSAGES` (`0x800`)
- `EMBED_LINKS` (`0x4000`)
- `MENTION_EVERYONE` は不要（個別ユーザーのメンションは標準権限で可能）

**6. 追加 env**

```
FALLBACK_CHANNEL_CATEGORY_ID=  # プライベート通知チャンネルが作成されるカテゴリ
DISCORD_APP_BOT_ID=            # Bot ユーザーの id（権限上書きで参照）
```

**7. プライバシー上のメリット**

- 結果は起稿者以外には永久に見えない
- 了解後または TTL 後に Discord 側からも削除されるため痕跡が残らない
- 監査が必要な情報（誰がいつ承認/却下した、理由）は `review_logs` / `admin_logs` に残るので運用上の透明性は維持される

### 4.5.3 未確認 fallback がある間は再起稿を禁止

未確認の fallback 通知を放置したまま新規起稿することを禁止し、必ず「了解」を押させてから次の起稿に進むようにする。

**ブロック対象のアクション**

| アクション | ブロック対象スポンサー | 動作 |
|---|---|---|
| `/ad submit` | 実行者（起稿者本人） | コマンド受信直後に検査、未確認があれば ephemeral 拒否 |
| `/admin submit` で `kind='regular'` かつ `sponsor_id` 指定 | 指定された sponsor_id | 同上、ephemeral で「対象スポンサーが未確認通知を持っています」 |
| `/admin submit` で `kind='regular'` で `sponsor_id` 未指定 | 起稿管理者本人（自身を sponsor として記録するため） | 同上 |
| `/admin submit` で `kind='house'` または `'placeholder'` | （sponsor_id NULL なので適用外） | ブロックしない |
| `/ad replace-image` | ads.sponsor_id | 同上 |
| `📋 自分の広告一覧` から `↩ 取り下げ` | ボタン押下者 | ブロックしない（取り下げは妨げない） |

**検査ロジック**

```ts
async function blockIfUnackedFallback(sponsor_id: string) {
  const rows = await db.query<{
    id: string; channel_id: string; created_at: Date;
  }>(`
    SELECT id, channel_id, created_at
      FROM dm_fallback_channels
     WHERE sponsor_id      = $1
       AND acknowledged_at IS NULL
       AND expires_at      > now()
     ORDER BY created_at ASC
  `, [sponsor_id]);

  if (rows.length === 0) return;  // OK

  const channelMentions = rows.map(r => `<#${r.channel_id}>`).join('\n');
  throw new EphemeralBlock(
    `🚫 未確認の審査結果通知があります。\n` +
    `先に下記チャンネルで「✅ 了解」ボタンを押してから再起稿してください:\n` +
    channelMentions
  );
}
```

`/ad submit` のフローに組み込む位置（§4.3 の手順を更新）:

```
ユーザー: /ad submit を送信
  └─ Worker:
     1. Ed25519 署名検証
     2. blockIfUnackedFallback(actor_id)  ← NEW
        未確認 fallback あれば ephemeral 拒否、終了（S3/DB 書き込みなし）
     3. sponsor の Tier を Discord REST で再取得（lazy refresh）
     4. tier.max_active_ads と current_active_count をチェック
     ...（以下同じ）
```

`/admin submit` も `kind='regular'` のときは対象 sponsor について同じ検査を行う。

**チャンネルが消えていた場合の整合性**

定期検査で chamber 自身が手動削除されているケースをカバーする。`blockIfUnackedFallback` の前段に以下を入れる:

```ts
// 該当 sponsor の未確認 fallback について、Discord 上にチャンネルが
// 既に無いものは acknowledged_at を now() にしてレコードを閉じる
for (const row of rows) {
  const exists = await discord.getChannel(row.channel_id).then(() => true)
                 .catch(err => err.status === 404 ? false : 'unknown');
  if (exists === false) {
    await db.execute(`
      UPDATE dm_fallback_channels
         SET acknowledged_at = now()
       WHERE id = $1`, [row.id]);
    await db.execute(`
      UPDATE ads SET dm_delivery_status = 'fallback_acknowledged'
       WHERE id = $1`, [row.ad_id]);
    await adminLog('dm_fallback_auto_closed', row.id);
  }
}
```

これにより「Bot が消し損ねた」「モデレーターが手動削除した」等のケースで永久にブロックされる事態を防ぐ。

**管理者向け解除手段**

万一 Bot の不具合等でロックされた場合、管理者は #広告管理 の `📜 全広告一覧` から該当広告 → `🔁 fallback 強制クローズ` ボタンで `dm_fallback_channels` を強制的に acknowledged 扱いにできる（admin_logs に記録）。

**DM Embed のフォーマット**

承認時:

```
✅ 広告が承認されました

タイトル: <title>
スロット: <slot>
広告 ID: <id>
配信開始: <starts_at>
重み (weight): <weight_snapshot>

統計や取り下げは #広告起稿 の「📋 自分の広告一覧」から確認できます。
```

却下時:

```
❌ 広告が却下されました

タイトル: <title>
スロット: <slot>
広告 ID: <id>
却下日時: <reviewed_at>

却下理由:
> <reject_reason>

修正のうえ再起稿してください。質問は審査者にメンションで問い合わせ可能です。
```

**追加スキーマ**

```sql
ALTER TABLE ads
  ADD COLUMN dm_delivery_status TEXT
    CHECK (dm_delivery_status IN
      ('pending','sent','failed','fallback_posted','fallback_acknowledged')),
  ADD COLUMN dm_delivered_at    TIMESTAMPTZ;

CREATE TABLE dm_fallback_channels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_id           UUID NOT NULL REFERENCES ads(id),
  sponsor_id      TEXT NOT NULL,
  channel_id      TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  acknowledged_at TIMESTAMPTZ
);

CREATE INDEX dm_fallback_pending_idx
  ON dm_fallback_channels (expires_at)
  WHERE acknowledged_at IS NULL;
```

`dm_delivery_status` の状態遷移:

```
 pending ──[DM POST 200]──► sent
 pending ──[DM POST 403]──► failed ──[fallback channel 作成]──► fallback_posted
                                                                    │
                                       ┌──[Cron TTL 期限切れ]──── ┤
                                       ▼                           │
                                     failed                        │
                                                                    │
                                                              [了解ボタン押下]
                                                                    │
                                                                    ▼
                                                          fallback_acknowledged
```

**再送機能**

`failed` または `fallback_posted` の広告については管理者が #広告管理 の `📜 全広告一覧` から該当広告を選択 → `🔁 DM 再送信` ボタンで再試行できる。再送信時は再度 DM を試み、また失敗したらプライベートチャンネル作成（既存 fallback がアクティブなら追記投稿）に進む。

### 4.6 #広告管理 の常設メニュー

```
🛠 広告管理コンソール

現在の状況: 配信中 12 / 審査待ち 3 / ハウス 2 / プレースホルダー 1

── 広告 ──
[📜 全広告一覧] [⏸ 一時停止] [▶ 再開]
[✂ 強制終了] [📝 編集] [📤 管理者として起稿]

── 設定 ──
[📐 入稿ルール] [🏆 ティア管理]
[🏠 ハウス広告] [🎯 プレースホルダー]

── 統計 ──
[📊 全体統計] [📈 期間別レポート] [📁 CSV出力]

── システム ──
[🔄 メニュー再投稿] [🧂 ソルト即時ローテ] [🩺 ヘルスチェック]
```

`📤 管理者として起稿` ボタンは ephemeral で「下のチャット欄から `/admin submit` を実行してください」とガイドを表示する（添付制約のため）。

| ボタン | 挙動 |
|---|---|
| 📜 全広告一覧 | ephemeral Embed + ページング Select。status / sponsor / slot / kind で絞り込み |
| ⏸ 一時停止 | 広告選択 Select → status='paused'（履歴・統計は残るが配信から外れる） |
| ▶ 再開 | paused → approved に戻す |
| ✂ 強制終了 | 広告選択 → 確認ボタン → ends_at=now()。起稿者へ DM 通知 |
| 📝 編集 | 広告選択 → Modal で title/body/link 編集（画像差し替えは `/ad replace-image`） |
| 📐 入稿ルール | スロット選択 → Modal で **JSON 編集**。構文エラーは ephemeral で拒否、保存しない |
| 🏆 ティア管理 | 既存ティア一覧 + ➕追加 / ✏編集 / 🗑削除。ロール ID は Discord の Role Select で指定 |
| 🏠 ハウス広告 | 候補ゼロ時の表示用広告 (`kind='house'`) を CRUD |
| 🎯 プレースホルダー | 「スポンサー募集中」等の最終フォールバック (`kind='placeholder'`) を slot ごとに CRUD |
| 📊 全体統計 | 期間 Select → Top10 + 合計 impressions/clicks/CTR を Embed |
| 📈 期間別レポート | 開始日 + 終了日 Modal → 日別 CTR を Embed（チャート画像は Worker 生成 → 添付 or URL） |
| 📁 CSV出力 | 期間 Select → Bot が **CSV 添付ファイル**で返信（Discord 添付 10MB 内） |
| 🔄 メニュー再投稿 | コマンド/メニューのスキーマ更新時に各チャンネルのメニューを貼り直す |
| 🧂 ソルト即時ローテ | IP_HASH_SALT を即時更新（インシデント対応用） |
| 🩺 ヘルスチェック | DB / S3 / Discord API 到達性を ephemeral で表示 |

### 4.7 スラッシュコマンド一覧

| コマンド | 利用者 | 用途 |
|---|---|---|
| `/ad submit slot:<choice> image:<attachment>` | スポンサー | 起稿（添付制約のため Slash） |
| `/ad replace-image id:<string> image:<attachment>` | スポンサー / 管理者 | 既存広告の画像差し替え |
| `/admin submit kind:<choice> slot:<choice> image:<attachment> [weight:<int>] [sponsor_id:<string>] [auto_approve:<bool>] [ends_in_days:<int>]` | 管理者 | 管理者起稿（種別・重み・代行起稿・自動承認を明示指定） |
| `/ad-setup channel:<channel> kind:<submit\|review\|admin>` | 管理者 | 常設メニューを指定チャンネルに投稿（または再投稿） |

それ以外（一覧/取下/統計/ルール/管理操作）はすべて常設メニューのボタンで完結。

### 4.8 `/admin submit` の挙動詳細

**コマンド option**

| option | 必須 | 値 | 説明 |
|---|---|---|---|
| `kind` | ✅ | `regular` / `house` / `placeholder` | 広告種別 |
| `slot` | ✅ | choices = ad_format_rules の slot 一覧 | 配信枠 |
| `image` | ✅ | attachment | 画像。ad_format_rules で検証 |
| `weight` | △ | 整数 1〜1000 | `kind=regular` のときのみ有効、未指定なら 1 |
| `sponsor_id` | △ | Discord user id | `kind=regular` で代行起稿する場合に指定。未指定なら起稿管理者自身を sponsor として記録（ただし起稿者が Tier ロールを持たないことは許容） |
| `auto_approve` | △ | bool | `kind=regular` のときのみ有効、`true` で審査スキップして即配信開始 |
| `ends_in_days` | △ | 整数 1〜365 | 終了までの日数。未指定なら無期限 |

**フロー**

```
管理者: /admin submit kind:regular slot:default image:<file> weight:10 auto_approve:true
  └─ Worker:
     1. Ed25519 署名検証
     2. member.roles に管理ロール ID 含有を確認、無ければ ephemeral 拒否
     3. kind=regular なら sponsor_id (省略時は actor) で sponsors UPSERT
        kind=house/placeholder なら sponsor_id 必須エラー
     4. attachment を ad_format_rules で検証 → NG なら ephemeral 拒否
     5. S3 staging に PUT、ad_drafts INSERT (TTL 10分)
     6. Modal を返す（custom_id="admin_submit:{draft_id}:{kind}:{weight}:{sponsor_id}:{auto_approve}:{ends_in_days}"）
        ※ custom_id 100字制限のため長い値は ad_drafts に追加カラムを設けて DB に保存

管理者: Modal 提出 (title/body/link)
  └─ Worker:
     1. テキストをルール検証 → NG なら ephemeral 拒否
     2. staging → ads/{adId}/orig.* にコピー
     3. ads INSERT
        - kind, slot, weight_snapshot=weight, created_by_admin=actor_id
        - auto_approve=true → status='approved', starts_at=now(), reviewed_by=actor_id, reviewed_at=now()
        - auto_approve=false → status='pending'（通常広告のみ。house/placeholder は無条件 approved）
        - ends_in_days 指定なら ends_at = now() + interval
     4. admin_logs INSERT (action='admin_submit')
     5. auto_approve=false なら審査チャンネルへ Embed + ボタン投稿
     6. ephemeral「✅ 起稿完了」（auto_approve=true なら「即配信開始」）
```

**バリデーションのバイパスはしない**: 管理者起稿でも ad_format_rules（容量・MIME・比率・URL allowlist）は通常起稿と同じく適用される。

## 5. 配信 API

### 5.1 GET /ads/serve

| Query | 必須 | 説明 |
|---|---|---|
| `slot` | ✅ | 掲載枠 |
| `n` | | 取得件数（デフォルト 1、上限 5） |

#### レスポンス

```json
{
  "slot": "default",
  "served_at": "2026-05-07T15:30:00Z",
  "ads": [
    {
      "id": "01HXXX...",
      "kind": "regular",
      "title": "...",
      "body": "...",
      "image_url": "https://<worker>/ads/image/01HXXX...",
      "click_url": "https://<worker>/ads/click/01HXXX...",
      "impression_token": "v1.<hmac>"
    }
  ]
}
```

`kind` フィールドで `regular` / `house` / `placeholder` を区別できるため、Web 側で見た目やクリック挙動を変更可能（例: placeholder は CTA を変える、impression のみ計測しクリックは記録しない等）。

#### フォールバック動作

1. `kind='regular' AND status='approved'` から重み付きで N 件取得
2. 不足分は `kind='house' AND status='approved'` から等確率ランダムで補充
3. それでもゼロなら `kind='placeholder' AND status='approved'` から先頭 1 件
4. placeholder すら無い場合のみ 204 No Content（ただし運用上 placeholder は常に 1 件用意することを推奨）

placeholder の `click_url` は通常クリックと同様に記録するが、Web 側の慣例として「クリックを促さない / 別タブで開かない」の表示が望ましい。仕様としては `kind='placeholder'` の click を `ad_events.event_type='click'` で記録するが、レポート上は集計から除外することを推奨（クエリ例は §5.6）。

### 5.2 重み付き選択クエリ

```sql
-- 通常広告の重み付き選択（kind='regular' のみ）
WITH candidates AS (
  SELECT id, kind, title, body, link_url, image_key, weight_snapshot
    FROM ads
   WHERE status = 'approved'
     AND kind   = 'regular'
     AND slot   = $1
     AND starts_at <= now()
     AND (ends_at IS NULL OR ends_at > now())
)
SELECT *
  FROM candidates
 ORDER BY -ln(random()) / weight_snapshot ASC
 LIMIT $2;
```

不足分の house 補充クエリ:

```sql
SELECT id, kind, title, body, link_url, image_key
  FROM ads
 WHERE status = 'approved' AND kind = 'house' AND slot = $1
 ORDER BY random()
 LIMIT $2;
```

最終フォールバック (placeholder) クエリ:

```sql
SELECT id, kind, title, body, link_url, image_key
  FROM ads
 WHERE status = 'approved' AND kind = 'placeholder' AND slot = $1
 LIMIT 1;
```

候補数が 1000 を超えた段階で materialized view + キャッシュへ移行（将来オプション）。

### 5.3 GET /ads/click/:adId

```
1. ads.link_url を DB から取得（クエリ ?to= は無視、オープンリダイレクト防止）
2. INSERT INTO ad_events('click') ※ ip_hash + adId の 5 分窓重複は除外
3. 302 Location: <ads.link_url>
```

### 5.4 GET /ads/image/:adId

S3 から `fetch` → Cache-API でエッジキャッシュ → レスポンス。
Cache-Control / ETag を適切に設定。NAS の認証情報は外に出さない。

### 5.5 計測の重複・bot 除外

- `User-Agent` に `bot|crawl|spider|preview` を含むものは記録しない
- `ip_hash = sha256(ip || daily_salt)` で 5 分以内の同一 (ip_hash, ad_id) はカウントしない
- HEAD リクエストは impression としてカウントしない

### 5.6 placeholder を除外した集計クエリ例

```sql
SELECT a.id, a.title,
       COUNT(*) FILTER (WHERE e.event_type='impression') AS impressions,
       COUNT(*) FILTER (WHERE e.event_type='click')      AS clicks
FROM ads a
LEFT JOIN ad_events e ON e.ad_id = a.id
WHERE a.kind <> 'placeholder'
  AND e.ts >= now() - interval '7 days'
GROUP BY a.id, a.title
ORDER BY impressions DESC;
```

### 5.7 レート制限

- `/ads/serve`: 1 IP あたり 60 req/min
- `/ads/click/:adId`: 1 IP + adId あたり 10 req/min
- `/interactions`: 制限なし（Discord 署名検証で十分）

Cloudflare の Rate Limiting Rules を利用。

## 6. セキュリティ

| 項目 | 対策 |
|---|---|
| Discord 真正性 | Ed25519 署名検証（`X-Signature-Ed25519` / `X-Signature-Timestamp`）、失敗は 401 |
| 管理操作の認可 | interactions.member.roles に **管理ロール ID** が含まれるか毎回サーバ側で再検証 |
| 審査操作の認可 | 同様に **審査ロール ID** を再検証 |
| オープンリダイレクト | `/ads/click/:adId` は `to` パラメータを受け取っても無視、サーバ側 `ads.link_url` のみ使用 |
| XSS | 広告本文/タイトルは全層テキスト扱い、HTML 入稿不可（Modal 受信時にバリデート） |
| 画像偽装 | Content-Type + 拡張子に加えて **マジックバイト**で二重判定 |
| SSRF | MVP では画像は Discord 添付のみ受け付け（外部 URL 取得なし）。将来外部 URL を許す場合は private IP / metadata IP を解決時にブロック |
| Secrets | Workers Secrets に保存、コードへの直書き禁止 |
| 個人情報 | 生 IP は保存せず ip_hash のみ、daily_salt は UTC 0 時にローテ |
| データ保持 | `ad_events` は 180 日で削除、`ad_drafts` は 10 分 TTL、staging S3 は同期削除 |
| Rate limit | 上記 5.6 |

## 7. 運用

### 7.1 環境

- **dev**: `wrangler dev` + ローカル / staging Postgres + ローカル MinIO
- **staging**: 本番と同等構成、別 DB / 別バケット
- **prod**: 本番

### 7.2 デプロイ

- Workers: `wrangler deploy`（`prod` / `staging` 環境分離）
- Postgres マイグレーション: `drizzle-kit migrate` を CI から実行
- Discord コマンド登録: `scripts/register-commands.ts`（環境ごとにギルド限定で登録）

### 7.3 監視

- Cloudflare Workers の `tail` ログ
- Postgres の `review_logs` / `admin_logs` で監査追跡
- 5xx 検知時に管理用 Webhook で監視 Discord チャンネルへ通知

### 7.4 バックアップ

- Postgres: 既存 NAS 側のスナップショット運用に乗せる
- S3 バケット: NAS 側で週次レプリケーション

### 7.5 Cron ジョブ（Workers Cron Triggers）

| 頻度 | 処理 |
|---|---|
| 毎時 | `ad_drafts` の期限切れ削除 + 対応する S3 staging オブジェクト削除 |
| 毎時 | `ads` の `ends_at < now()` を `expired` に遷移 |
| 毎時 | `dm_fallback_channels.acknowledged_at IS NULL AND expires_at < now()` のチャンネルを Discord REST で削除 + status 更新 |
| 1日 1回（UTC 0 時） | `daily_salt` ローテ |
| 1日 1回 | 180 日超過の `ad_events` を削除 |
| 1日 1回 | `system_settings` のヘルスサマリーを管理チャンネルへ投稿 |

## 8. 環境変数

```bash
# Discord
DISCORD_APP_ID=
DISCORD_APP_BOT_ID=                     # Bot ユーザーの id（permission_overwrites 用）
DISCORD_PUBLIC_KEY=
DISCORD_BOT_TOKEN=
GUILD_ID=
SUBMIT_CHANNEL_ID=
REVIEW_CHANNEL_ID=
ADMIN_CHANNEL_ID=
FALLBACK_CHANNEL_CATEGORY_ID=           # DM 失敗時のプライベート通知チャンネル親カテゴリ
REVIEWER_ROLE_ID=
ADMIN_ROLE_ID=

# Storage
POSTGRES_URL=postgres://user:pass@nas-host:5432/discordadserver
HYPERDRIVE_ID=                  # CF Hyperdrive 利用時のみ
S3_ENDPOINT=https://nas-host:9000
S3_REGION=us-east-1
S3_BUCKET=ad-server
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=

# Worker
SITE_API_KEY=                   # /ads/serve への site key（任意）
IP_HASH_SALT_BOOTSTRAP=         # 初回起動用シード。以降の daily_salt は system_settings or KV で永続化・自動ローテ
WORKER_BASE_URL=https://ads.example.com
```

`daily_salt` の現在値はランタイムでローテするため env ではなく `system_settings` テーブル（または Workers KV）に格納する。`IP_HASH_SALT_BOOTSTRAP` は初回起動時の初期値供給にのみ使用。

## 9. ディレクトリ構成

```
discordapi_ad_server/
├ src/
│ ├ index.ts                  # Hono ルータ
│ ├ interactions/
│ │  ├ verify.ts              # Ed25519 検証
│ │  ├ commands.ts            # /ad submit, /ad-setup, /ad replace-image
│ │  ├ buttons.ts             # 一覧/取下/統計/ルール/管理 ボタン
│ │  ├ modals.ts              # 各 Modal handler
│ │  └ review.ts              # Approve/Reject ボタン
│ ├ serve/
│ │  ├ pick.ts                # 重み付きランダム
│ │  ├ image.ts               # /ads/image/:adId プロキシ
│ │  ├ click.ts               # /ads/click/:adId
│ │  └ track.ts               # impression/click 記録
│ ├ db/
│ │  ├ client.ts              # Postgres pool / Hyperdrive
│ │  └ schema.ts              # drizzle schema
│ ├ storage/
│ │  └ s3.ts                  # AWS SDK v3 S3 client
│ ├ validation/
│ │  ├ rules.ts               # ad_format_rules ロード/キャッシュ
│ │  ├ image.ts               # マジックバイト/サイズ/比率
│ │  └ text.ts                # title/body/url
│ ├ discord/
│ │  ├ rest.ts                # REST 呼び出し
│ │  ├ menus.ts               # 常設メニュー定義
│ │  └ embeds.ts              # Embed builder
│ ├ admin/
│ │  ├ ads.ts                 # 一覧/編集/停止/再開/強制終了
│ │  ├ rules.ts               # ad_format_rules CRUD
│ │  ├ tiers.ts               # ティア CRUD
│ │  ├ house.ts               # ハウス広告 CRUD
│ │  ├ stats.ts               # 集計クエリ + チャート生成
│ │  └ system.ts              # ソルトローテ / メニュー再投稿
│ ├ cron/
│ │  └ index.ts               # scheduled handler
│ └ utils/
├ migrations/                 # SQL
├ scripts/
│  └ register-commands.ts     # Discord コマンド登録
├ wrangler.toml
├ drizzle.config.ts
├ package.json
├ tsconfig.json
├ .env.example
├ README.md
└ docs/
   └ superpowers/
      └ specs/
         └ 2026-05-07-discord-ad-server-design.md  # 本書
```

## 10. MVP スコープ

| 機能 | MVP | 将来 |
|---|---|---|
| `/ad submit` 添付 + Modal 起稿 | ✅ | |
| 承認/却下ボタン + reject reason | ✅ | |
| 重み付きランダム配信 `/ads/serve` | ✅ | |
| impression/click 計測 + CTR | ✅ | |
| `ad_format_rules` Discord 編集（JSON Modal） | ✅ | フィールド別 Modal |
| 自分の広告一覧 / 取下 / 自分の統計 | ✅ | |
| 管理コンソール（一覧/編集/停止/再開/終了） | ✅ | |
| ティア管理（CRUD） | ✅ | |
| ハウス広告 | ✅ | |
| 全体統計 / 期間別レポート / CSV 出力 | ✅ | チャート画像 / 自動定期送信 |
| 監査ログ（review_logs / admin_logs） | ✅ | |
| Cron（draft 掃除 / expire / salt rot / event 削除） | ✅ | |
| `/admin submit`（管理者起稿、weight/sponsor 代行/auto_approve） | ✅ | |
| プレースホルダー広告（kind='placeholder' / 募集中表示） | ✅ | |
| 審査結果 DM（承認/却下とも、却下理由必須・DM 失敗時のプライベートチャンネル fallback + 了解ボタン自己破棄） | ✅ | DM 再送 UI |
| 複数 slot 運用 | スキーマのみ | UI 整備 |
| 期間予約（未来 starts_at） | スキーマのみ | UI 追加 |
| Tier ロール変更の自動反映 | lazy refresh | Cron 同期 |
| 不正クリック対策 | UA + ip_hash 5分窓 | スコアリング |
| Web 管理画面 | ❌ 採用しない | ❌ 採用しない |

## 11. オープンクエスチョン

- **Hyperdrive**: 既存 Postgres が外部から TLS で到達できるなら Hyperdrive 推奨。NAS の Postgres ポート公開可否を確認すること
- **画像差し替え時の旧オブジェクト**: `/ad replace-image` で旧 `image_key` を即削除するか、監査用に N 日保持するか（推奨: 30 日保持後 Cron で削除）
- **Tier ダウン時の挙動**: 現行は `weight_snapshot` 凍結。将来 Tier 喪失で `paused` にする運用に変えるか要検討
- **CSV エクスポートが 10MB を超える場合**: R2 への一時 PUT + presigned URL を Discord に貼る方式へ切り替え
