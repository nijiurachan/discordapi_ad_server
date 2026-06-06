import type { S3Client } from '@aws-sdk/client-s3';
import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import { isAdmin } from '../../discord/admin-auth.ts';
import {
  InteractionResponseType,
  type MessageComponentInteractionPayload,
  type ModalResponse,
  type ModalSubmitInteractionPayload,
} from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { createS3Client, deleteObject, putObject } from '../../storage/s3.ts';
import { type DetectedMime, validateMagicBytes } from '../../validation/image.ts';
import { type FormatRules, fetchFormatRules } from '../../validation/rules.ts';
import { validateBody, validateLinkUrl, validateTitle } from '../../validation/text.ts';
import { ephemeral } from '../responses.ts';

export const ADMIN_QUICK_SUBMIT_PREFIX = 'admin-qsubmit:';

const MIME_EXT: Record<DetectedMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const IMAGE_FETCH_TIMEOUT_MS = 5000;
const ALLOWED_KINDS = new Set(['house', 'placeholder']);

// kind=house defaults to weight 1 in the picker; placeholder is special-cased
// to zero so it never wins the weighted draw, only the fallback path.
const DEFAULT_WEIGHTS: Record<string, number> = {
  house: 1,
  placeholder: 0,
};

function buildModal(rules: FormatRules): ModalResponse {
  return {
    custom_id: `${ADMIN_QUICK_SUBMIT_PREFIX}${rules.slot}`,
    title: `管理者起稿 (slot=${rules.slot})`,
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: 'title',
            label: 'タイトル',
            style: 1,
            required: true,
            min_length: 1,
            max_length: rules.titleMaxLen,
            placeholder: '広告のタイトル',
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: 'body',
            label: '本文',
            style: 2,
            required: true,
            min_length: 1,
            max_length: rules.bodyMaxLen,
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: 'link_url',
            label: 'リンク URL',
            style: 1,
            required: true,
            min_length: 8,
            max_length: rules.linkUrlMaxLen,
            placeholder: 'https://example.com',
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: 'image_url',
            label: '画像 URL (HTTPS, PNG/JPEG/WebP/GIF)',
            style: 1,
            required: true,
            min_length: 10,
            max_length: 1000,
            placeholder: 'https://cdn.example.com/banner.png',
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: 'kind',
            label: 'kind (house / placeholder)',
            style: 1,
            required: false,
            min_length: 0,
            max_length: 16,
            value: 'house',
          },
        ],
      },
    ],
  };
}

export async function handleAdminQuickSubmitEntry(
  c: Context<{ Bindings: Bindings }>,
  payload: MessageComponentInteractionPayload,
): Promise<Response> {
  if (!isAdmin(payload, c.env.ADMIN_ROLE_ID)) {
    return ephemeral(c, '⚠ この操作には管理者ロールが必要です。');
  }
  const rules = await withPgClient(c.env, (client) => fetchFormatRules(client, 'default'));
  if (!rules) {
    return ephemeral(c, 'slot=default の入稿ルールが未設定です。先に「📐 入稿ルール」で設定してください。');
  }
  return c.json({ type: InteractionResponseType.MODAL, data: buildModal(rules) });
}

function findValue(payload: ModalSubmitInteractionPayload, customId: string): string {
  for (const row of payload.data.components) {
    for (const comp of row.components) {
      if (comp.custom_id === customId) return comp.value;
    }
  }
  return '';
}

function parseImageUrl(
  raw: string,
  rules: FormatRules,
): { ok: true; url: URL; ext: string } | { ok: false; error: string } {
  if (!raw) return { ok: false, error: '画像 URL を入力してください' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: '画像 URL が不正です' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, error: '画像 URL は https のみ受け付けます' };
  }
  const path = url.pathname;
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot === path.length - 1) {
    return { ok: false, error: '画像 URL に拡張子が見当たりません' };
  }
  const ext = path.slice(dot + 1).toLowerCase();
  if (!rules.allowedExtensions.includes(ext)) {
    return {
      ok: false,
      error: `拡張子が許可されていません (.${ext}; 許可: ${rules.allowedExtensions.join(', ')})`,
    };
  }
  return { ok: true, url, ext };
}

export type AdminQuickSubmitDeps = {
  client: PgClient;
  s3: S3Client;
  bucket: string;
  adminRoleId: string;
  fetchImpl?: typeof fetch;
  uuid?: () => string;
};

export async function runAdminQuickSubmitModal(
  c: Context,
  payload: ModalSubmitInteractionPayload,
  deps: AdminQuickSubmitDeps,
): Promise<Response> {
  if (!isAdmin(payload, deps.adminRoleId)) {
    return ephemeral(c, '⚠ この操作には管理者ロールが必要です。');
  }
  const slot = payload.data.custom_id.slice(ADMIN_QUICK_SUBMIT_PREFIX.length) || 'default';
  const rules = await fetchFormatRules(deps.client, slot);
  if (!rules) {
    return ephemeral(c, `slot=${slot} の入稿ルールが未設定です`);
  }

  const title = findValue(payload, 'title');
  const body = findValue(payload, 'body');
  const linkUrl = findValue(payload, 'link_url');
  const imageUrlRaw = findValue(payload, 'image_url').trim();
  const kindRaw = findValue(payload, 'kind').trim().toLowerCase() || 'house';

  if (!ALLOWED_KINDS.has(kindRaw)) {
    return ephemeral(c, `kind は house または placeholder のみ指定可能です (入力: ${kindRaw})`);
  }
  const kind = kindRaw as 'house' | 'placeholder';

  const titleR = validateTitle(rules, title);
  if (!titleR.ok) return ephemeral(c, titleR.error);
  const bodyR = validateBody(rules, body);
  if (!bodyR.ok) return ephemeral(c, bodyR.error);
  const linkR = validateLinkUrl(rules, linkUrl);
  if (!linkR.ok) return ephemeral(c, linkR.error);
  const imgR = parseImageUrl(imageUrlRaw, rules);
  if (!imgR.ok) return ephemeral(c, imgR.error);

  const actorId = payload.member?.user?.id ?? payload.user?.id;
  if (!actorId) {
    return ephemeral(c, 'ユーザー情報を特定できませんでした');
  }

  // Placeholder uniqueness: at most one approved placeholder per slot.
  if (kind === 'placeholder') {
    const dup = await deps.client.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM ads
        WHERE kind = 'placeholder' AND slot = ? AND status = 'approved'`,
      [slot],
    );
    if (Number(dup.rows[0]?.count ?? 0) > 0) {
      return ephemeral(
        c,
        `❌ slot=\`${slot}\` の placeholder は既に存在します。先に既存を強制終了してください。`,
      );
    }
  }

  // Fetch image with a hard timeout so a hung CDN can't burn the 3s modal ack.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMAGE_FETCH_TIMEOUT_MS);
  let bodyBytes: Uint8Array;
  try {
    const res = await (deps.fetchImpl ?? fetch)(imgR.url.toString(), {
      signal: ctrl.signal,
      // Set a UA so origin servers don't 403 a bot-empty request.
      headers: { 'user-agent': 'discordapi-ad-server/quick-submit' },
    });
    if (!res.ok) {
      return ephemeral(c, `画像の取得に失敗しました (HTTP ${res.status})`);
    }
    bodyBytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    console.error('admin-quick-submit: image fetch failed', err);
    return ephemeral(c, '画像の取得に失敗しました（タイムアウトまたは接続不可）');
  } finally {
    clearTimeout(timer);
  }

  if (bodyBytes.byteLength > rules.maxBytes) {
    return ephemeral(
      c,
      `画像サイズが上限を超えています (${bodyBytes.byteLength} > ${rules.maxBytes} bytes)`,
    );
  }
  const detected = validateMagicBytes(bodyBytes);
  if (!detected) {
    return ephemeral(c, '画像形式を判定できませんでした (PNG/JPEG/GIF/WebP のみ対応)');
  }
  if (!rules.allowedMimes.includes(detected)) {
    return ephemeral(c, `画像形式が許可されていません (${detected})`);
  }

  const adId = (deps.uuid ?? (() => crypto.randomUUID()))();
  const finalKey = `ads/${adId}/orig.${MIME_EXT[detected]}`;
  try {
    await putObject(deps.s3, deps.bucket, finalKey, bodyBytes, detected);
  } catch (err) {
    console.error('admin-quick-submit: S3 putObject failed', err);
    return ephemeral(c, '画像の保存に失敗しました');
  }

  const weight = DEFAULT_WEIGHTS[kind] ?? 1;
  try {
    await deps.client.query(
      `INSERT INTO ads
         (id, sponsor_id, kind, slot, title, body, link_url,
          image_key, image_mime, image_bytes,
          status, weight_snapshot, starts_at,
          reviewed_by, reviewed_at, created_by_admin)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?,
               'approved', ?, (unixepoch() * 1000),
               ?, ?, ?)`,
      [
        adId,
        kind,
        slot,
        title,
        body,
        linkUrl,
        finalKey,
        detected,
        bodyBytes.byteLength,
        weight,
        actorId,
        Date.now(),
        actorId,
      ],
    );
    await deps.client.query(
      `INSERT INTO admin_logs (actor_id, action, target_kind, target_id, after)
       VALUES (?, 'admin_quick_submit', 'ad', ?, ?)`,
      [
        actorId,
        adId,
        JSON.stringify({ kind, slot, weight, image_url: imgR.url.toString() }),
      ],
    );
  } catch (err) {
    console.error('admin-quick-submit: INSERT failed', err);
    try {
      await deleteObject(deps.s3, deps.bucket, finalKey);
    } catch (cleanupErr) {
      console.error('admin-quick-submit: cleanup deleteObject failed', cleanupErr);
    }
    return ephemeral(c, '広告の登録に失敗しました');
  }

  return ephemeral(
    c,
    `✅ 起稿完了（kind=${kind}, slot=${slot}, weight=${weight}）\n` +
      `ad_id: \`${adId}\`\n` +
      `image: ${imgR.url.toString()}`,
  );
}

export async function handleAdminQuickSubmitModal(
  c: Context<{ Bindings: Bindings }>,
  payload: ModalSubmitInteractionPayload,
): Promise<Response> {
  const s3 = createS3Client({
    endpoint: c.env.S3_ENDPOINT,
    region: c.env.S3_REGION,
    accessKeyId: c.env.S3_ACCESS_KEY_ID,
    secretAccessKey: c.env.S3_SECRET_ACCESS_KEY,
  });
  return withPgClient(c.env, (client) =>
    runAdminQuickSubmitModal(c, payload, {
      client,
      s3,
      bucket: c.env.S3_BUCKET,
      adminRoleId: c.env.ADMIN_ROLE_ID,
    }),
  );
}
