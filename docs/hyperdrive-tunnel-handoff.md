# 依頼：Hyperdrive ↔ private PostgreSQL（Cloudflare Tunnel）接続の 403 解消

## やりたいこと
Cloudflare Hyperdrive を、NAS 上の **private PostgreSQL** に **Cloudflare Tunnel 経由**で接続させたい。
`wrangler hyperdrive create` が **403 Forbidden** で失敗するので、**Cloudflare Access / WAF（Bot対策）側**の設定を確認・修正してほしい。

DB を公開せずトンネル経由にする構成のため、PostgreSQL 本体（pg_hba 等）はこれ以上触らなくてよい。

## 構成（意図する経路）
```
Worker (discordapi-ad-server)
  → Hyperdrive binding
  → Cloudflare Hyperdrive
  → [Cloudflare Access: Service Auth で認証]
  → Tunnel 公開ホスト名 pg.nijiurachan.net (Type=TCP)
  → cloudflared (NAS)
  → PostgreSQL  (localhost:5432, database=discordadserver, user=discordads)
```

## 参照情報
| 項目 | 値 |
|---|---|
| Cloudflare account ID | `650b93a7d47bda394e68458be3783b65` |
| Tunnel | `aimg-backend-containers`（cloudflared, NAS 上） |
| Tunnel 公開ホスト名 | `pg.nijiurachan.net`（Type **TCP** → `localhost:5432`） |
| Hyperdrive 設定名 | `discordadserver-prod` |
| DB | database=`discordadserver`, user=`discordads` |
| Access Service Token client-id | `27143b072cdc1b79ced69833965b0b24.access`（client-id は半公開、secret は別途共有） |
| zone | `nijiurachan.net` |

## 失敗しているコマンド（開発側が実行）
```
wrangler hyperdrive create discordadserver-prod \
  --host=pg.nijiurachan.net \
  --user=discordads --password=<...> --database=discordadserver \
  --access-client-id=27143b072cdc1b79ced69833965b0b24.access \
  --access-client-secret=<...>      # ← --port は付けない（仕様）
```
結果:
```
Failed to connect to the provided database:
Connecting to database via Cloudflare Tunnel failed: 403 Forbidden [code: 2015]
```
→ **トンネルのルーティング自体は成立**（以前は pg_hba エラーだったが、今は手前の 403 に変化）。**403 は Access か WAF/Bot 対策のどちらか。**

---

## 手順1：403 の出どころを特定（最優先）

### A. Access ログ
Zero Trust → **Logs → Access** → `pg.nijiurachan.net` 宛の **Block** エントリを探す。
- **ある** → Access ポリシー問題（→ 手順2-A）。Block の「理由」を控える。
- **無い** → Access は通過している。403 は別レイヤ（→ 手順2-B）。

### B. WAF / Bot イベント
zone `nijiurachan.net` → Security → **Events** → `pg.nijiurachan.net` 宛の Block / Managed Challenge を探す。
- **このゾーンは Bot 対策が有効**（別ホスト `ads.nijiurachan.net` が「Just a moment…」チャレンジを返すことを確認済み）。Hyperdrive の接続が Bot/WAF で弾かれている疑いが強い。

---

## 手順2-A：Access ポリシーを修正（Access ログに Block がある場合）

Zero Trust → Access → Applications → **`pg.nijiurachan.net`** → Policies：
- **Action = `Service Auth`**（`Allow` ではない。Service Token は Service Auth でないと非対話認証が通らず 403）
- **Include = Service Token**（該当トークン、または `Any Access Service Token`）
- アプリの **ドメインが `pg.nijiurachan.net` と完全一致**（サブドメイン/パスのズレ無し）
- 上位に **Block 系ポリシーが先にマッチしていない**こと（順序は上が優先）
- `*.nijiurachan.net` 等の**ワイルドカード Access アプリ**が先に拾っていないか確認

## 手順2-B：WAF / Bot 対策をスキップ（Access ログに Block が無い場合・本命）

`pg.nijiurachan.net` は機械（Hyperdrive）専用エンドポイントなので、Bot/チャレンジ対策を**この1ホストだけ無効化**する。

**WAF カスタムルール（推奨）**: zone `nijiurachan.net` → Security → WAF → Custom rules → Create
- **If**: `Hostname` equals `pg.nijiurachan.net`
- **Then**: アクション **Skip**
  - Skip: **Super Bot Fight Mode**
  - Skip: **Managed Challenge / Security Level**（チェック可能な保護を全てスキップ）
  - 「Skip remaining custom rules」も有効化
- 保存・デプロイ

補足:
- **Bot Fight Mode（無料版）**はホスト単位の除外ができないため、切り分け目的で一時的にオフにして再試行 → 通れば Super Bot Fight Mode（有料）へ移行してホスト除外、が筋。
- **Configuration Rules** で `pg.nijiurachan.net` の Security Level を `Essentially Off` + Bot Fight Mode Off にする手もある。

---

## 手順3：検証
管理者の設定後、開発側が再度 `wrangler hyperdrive create ...` を実行 → **成功すると設定 `id` が出力**される。
そこから先（`wrangler.toml` に bind → デプロイ → `/health` が `db: ok`）は開発側で対応する。

## セキュリティ（作業後に必須）
- 検証のため共有した **DB パスワード** と **Access Service Token の secret** は、開通確認後に**ローテーション**（DB パスワード変更 ＋ Service Token 再生成 → Hyperdrive 設定を更新）。

## 補足：もっと簡単な代替
- どうしても Access/Bot の調整が難しい場合、**PG を公開 IP のまま `pg_hba.conf` に `hostssl all all 0.0.0.0/0 scram-sha-256` を追加**して、Tunnel を使わず Hyperdrive を直結する方法もある（その場合 Access/Tunnel 不要）。ただし PG を公開にする分、Tunnel 方式より露出は増える。
