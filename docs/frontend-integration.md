# フロントエンドからバナーを表示する手順

ぶるもげちゃん広告サーバの配信エンドポイントを使って、任意の Web ページにバナー広告を埋め込むためのガイド。

- 配信ベース URL: `https://ads.nijiurachan.net`
- 入稿規格 (default slot): **468 × 80 px** (`117:20` 比率 ±2%), PNG/JPEG/WebP, 1 MB 以下
- CORS: 全オリジン許可 (`Access-Control-Allow-Origin: *`)
- レート制限: `/ads/serve` 60 req/min/IP, `/ads/click/:id` 10 req/min/IP

ライブで動作確認: [https://ads.nijiurachan.net/ads/demo](https://ads.nijiurachan.net/ads/demo)

---

## エンドポイント仕様

### `GET /ads/serve`

| パラメータ | 必須 | 説明 |
|---|---|---|
| `slot` | 任意 | 広告枠識別子（現在は `default` のみ。省略時 `default`） |
| `n` | 任意 | 取得件数 1–5（省略時 1） |

レスポンス：

```jsonc
// 200 OK
{
  "slot": "default",
  "served_at": "2026-06-06T03:58:21Z",
  "ads": [
    {
      "id": "ae8290c4-dae7-4f73-957e-09fbde244914",
      "kind": "regular",           // regular | house | placeholder
      "title": "あいもげFANBOX",
      "body": "同上",
      "image_url": "https://storage.nijiurachan.net/discordads/ads/ae82.../orig.png",
      "click_url": "https://ads.nijiurachan.net/ads/click/ae82...",
      "impression_token": "v1...."  // 現状はサーバが受信時に計上するため、クライアントは保存不要
    }
  ]
}

// 204 No Content … 該当する approved 広告がないとき
```

返ってきた `image_url` と `click_url` をそのまま使うだけで OK。**impression は `/ads/serve` を叩いた時点でサーバが記録するので、フロント側で追加の通信は不要**。クリックは `click_url` (= `/ads/click/:adId`) にアクセスされた瞬間に 302 リダイレクト + click 計上が走る。

### `GET /ads/click/:adId`

- 302 リダイレクトで `ad.link_url` (Discord 入稿時に指定された URL) に飛ばす
- ip_hash + adId 単位で 5 分以内の重複クリックは dedup（同一ユーザの連打を弾く）

---

## A. 静的 HTML に最小構成で埋め込む

```html
<div id="bmg-banner" style="display:inline-block;max-width:100%"></div>
<script>
(async () => {
  const res = await fetch('https://ads.nijiurachan.net/ads/serve?slot=default&n=1');
  if (res.status === 204) return;
  const ad = (await res.json()).ads?.[0];
  if (!ad) return;
  const a = document.createElement('a');
  a.href = ad.click_url;
  a.target = '_blank';
  a.rel = 'noopener sponsored';
  const img = document.createElement('img');
  img.src = ad.image_url;
  img.alt = ad.title;
  img.loading = 'lazy';
  img.style.maxWidth = '100%';
  img.style.height = 'auto';
  a.appendChild(img);
  document.getElementById('bmg-banner').appendChild(a);
})();
</script>
```

これだけで描画 + impression + click 計上まで通ります。

---

## B. React / Vue で

```tsx
import { useEffect, useState } from 'react';

type Ad = {
  id: string;
  kind: 'regular' | 'house' | 'placeholder';
  title: string;
  body: string;
  image_url: string;
  click_url: string;
};

export function BmgBanner({ slot = 'default' }: { slot?: string }) {
  const [ad, setAd] = useState<Ad | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`https://ads.nijiurachan.net/ads/serve?slot=${encodeURIComponent(slot)}&n=1`, {
      signal: ctrl.signal,
    })
      .then((r) => (r.status === 204 ? null : r.json()))
      .then((d) => setAd(d?.ads?.[0] ?? null))
      .catch(() => {});
    return () => ctrl.abort();
  }, [slot]);

  if (!ad) return null;
  return (
    <a href={ad.click_url} target="_blank" rel="noopener sponsored">
      <img
        src={ad.image_url}
        alt={ad.title}
        loading="lazy"
        style={{ maxWidth: '100%', height: 'auto' }}
      />
    </a>
  );
}
```

Vue 3 (Composition API)：

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue';
const props = defineProps<{ slot?: string }>();
const ad = ref<any>(null);
onMounted(async () => {
  const r = await fetch(`https://ads.nijiurachan.net/ads/serve?slot=${props.slot ?? 'default'}&n=1`);
  if (r.status === 204) return;
  ad.value = (await r.json()).ads?.[0] ?? null;
});
</script>

<template>
  <a v-if="ad" :href="ad.click_url" target="_blank" rel="noopener sponsored">
    <img :src="ad.image_url" :alt="ad.title" loading="lazy" style="max-width:100%;height:auto" />
  </a>
</template>
```

---

## C. Next.js / SSR

```tsx
// app/components/BmgBanner.tsx
async function getAd(slot = 'default') {
  const r = await fetch(
    `https://ads.nijiurachan.net/ads/serve?slot=${slot}&n=1`,
    { cache: 'no-store' }, // weighted random させたいので毎リクエスト
  );
  if (r.status === 204 || !r.ok) return null;
  const data = await r.json();
  return data.ads?.[0] ?? null;
}

export async function BmgBanner({ slot }: { slot?: string }) {
  const ad = await getAd(slot);
  if (!ad) return null;
  return (
    <a href={ad.click_url} target="_blank" rel="noopener sponsored">
      <img src={ad.image_url} alt={ad.title} loading="lazy" />
    </a>
  );
}
```

> ⚠ **SSR の注意**: サーバ側 `fetch` だと impression は **サーバの IP で計上** されます。エンドユーザの IP で計上したい場合は CSR (A/B) を使ってください。Next.js なら `<BmgBanner />` をクライアントコンポーネント化するか、App Router で `dynamic="force-dynamic"` の API route を経由する設計も可。

---

## 推奨設定

| 項目 | 推奨 | 理由 |
|---|---|---|
| `target` | `_blank` | 元ページに戻りやすい |
| `rel` | `noopener sponsored` | セキュリティ + 検索エンジンへスポンサーリンク明示 |
| `loading` | `lazy` | 画面外なら遅延ロード |
| サイズ指定 | `max-width: 100%; height: auto` | レスポンシブ対応 |
| キャッシュ | クライアント側で毎回新規 fetch | CDN キャッシュを噛ますと同じ広告が固定表示される |
| エラーハンドル | 204 → 何も描画しない / 5xx → スキップ | 広告が出ないことを許容する設計 |

---

## エラー時の挙動

| ステータス | 意味 | フロントの対応 |
|---|---|---|
| 200 | 配信成功 | `ads[0]` を描画 |
| 204 | 配信対象の approved 広告なし | 何も表示しない |
| 401 | `SITE_API_KEY` 設定時で `X-Site-Key` 不一致 | 設定確認 |
| 429 | レート制限 (60 req/min/IP) | 数十秒待つ |
| 5xx | 一時障害 | 描画スキップ、次回ロード時に再試行 |

---

## サンプル：複数枠を並べる

```html
<div id="bmg-1"></div>
<div id="bmg-2"></div>
<script>
async function loadBanner(slot, mountId) {
  const r = await fetch(`https://ads.nijiurachan.net/ads/serve?slot=${slot}&n=1`);
  if (r.status === 204) return;
  const ad = (await r.json()).ads?.[0];
  if (!ad) return;
  const a = Object.assign(document.createElement('a'), {
    href: ad.click_url, target: '_blank', rel: 'noopener sponsored',
  });
  a.appendChild(Object.assign(document.createElement('img'), {
    src: ad.image_url, alt: ad.title, loading: 'lazy',
  }));
  document.getElementById(mountId).appendChild(a);
}
loadBanner('default', 'bmg-1');
loadBanner('default', 'bmg-2');
</script>
```

> 同一 IP からの連続 impression は 5 分窓で dedup されるので、複数枠で同じ広告が出てもサーバ側は 1 件しか計上しません。

---

## チェックリスト (リリース前)

- [ ] バナーが表示される
- [ ] クリックで `https://aimoge.fanbox.cc/` 等の link_url にリダイレクトされる
- [ ] DevTools の Network で `/ads/serve` が 200 (or 204) を返している
- [ ] `image_url` が `https://storage.nijiurachan.net/` で始まっている (S3 直配信)
- [ ] CORS エラーが出ていない
- [ ] レスポンシブ崩れがない

トラブル時はまず [/ads/demo](https://ads.nijiurachan.net/ads/demo) と比較してみてください。
