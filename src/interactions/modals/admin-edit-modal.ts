import type { Context } from 'hono';
import { withPgClient } from '../../db/client.ts';
import { getAdEditable, updateAdContent } from '../../db/queries/ad-edits.ts';
import { writeAdminLog } from '../../db/queries/admin-logs.ts';
import { isAdmin } from '../../discord/admin-auth.ts';
import {
  ButtonStyle,
  InteractionResponseType,
  type MessageComponentInteractionPayload,
  type ModalResponse,
  type ModalSubmitInteractionPayload,
} from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { fetchFormatRules } from '../../validation/rules.ts';
import { validateBody, validateLinkUrl, validateTitle } from '../../validation/text.ts';
import { ephemeral } from '../responses.ts';

export const ADMIN_EDIT_PICK_PREFIX = 'admin-edit-pick:';
export const ADMIN_EDIT_OPEN_PREFIX = 'admin-edit-open:';
export const ADMIN_EDIT_MODAL_PREFIX = 'admin-edit-modal:';

function findValue(payload: ModalSubmitInteractionPayload, customId: string): string {
  for (const row of payload.data.components) {
    for (const c of row.components) {
      if (c.custom_id === customId) return c.value;
    }
  }
  return '';
}

export async function handleAdminEditPickModal(
  c: Context<{ Bindings: Bindings }>,
  payload: ModalSubmitInteractionPayload,
): Promise<Response> {
  if (!isAdmin(payload, c.env.ADMIN_ROLE_ID)) {
    return ephemeral(c, '⚠ この操作には管理者ロールが必要です。');
  }
  const adId = findValue(payload, 'ad_id').trim();
  if (!adId) return ephemeral(c, '広告 ID を入力してください');
  return c.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: `編集対象: \`${adId}\` — 下のボタンで編集 Modal を開きます。`,
      flags: 64,
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: ButtonStyle.PRIMARY,
              custom_id: `${ADMIN_EDIT_OPEN_PREFIX}${adId}`,
              label: '✏ 編集 Modal を開く',
            },
          ],
        },
      ],
    },
  });
}

export async function handleAdminEditOpenButton(
  c: Context<{ Bindings: Bindings }>,
  payload: MessageComponentInteractionPayload,
): Promise<Response> {
  if (!isAdmin(payload, c.env.ADMIN_ROLE_ID)) {
    return ephemeral(c, '⚠ この操作には管理者ロールが必要です。');
  }
  const adId = payload.data.custom_id.slice(ADMIN_EDIT_OPEN_PREFIX.length);
  const ad = await withPgClient(c.env.POSTGRES_URL, (client) => getAdEditable(client, adId));
  if (!ad) {
    return ephemeral(c, `広告 \`${adId}\` が見つかりません。`);
  }
  const modal: ModalResponse = {
    custom_id: `${ADMIN_EDIT_MODAL_PREFIX}${adId}`,
    title: '広告内容の編集',
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
            max_length: 100,
            value: ad.title.slice(0, 100),
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
            max_length: 1000,
            value: ad.body.slice(0, 1000),
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
            max_length: 2048,
            value: ad.linkUrl.slice(0, 2048),
          },
        ],
      },
    ],
  };
  return c.json({ type: InteractionResponseType.MODAL, data: modal });
}

export async function handleAdminEditSubmitModal(
  c: Context<{ Bindings: Bindings }>,
  payload: ModalSubmitInteractionPayload,
): Promise<Response> {
  if (!isAdmin(payload, c.env.ADMIN_ROLE_ID)) {
    return ephemeral(c, '⚠ この操作には管理者ロールが必要です。');
  }
  const customId = payload.data.custom_id;
  const adId = customId.slice(ADMIN_EDIT_MODAL_PREFIX.length);
  const title = findValue(payload, 'title').trim();
  const body = findValue(payload, 'body').trim();
  const linkUrl = findValue(payload, 'link_url').trim();
  const actorId = payload.member?.user?.id ?? payload.user?.id ?? 'unknown';

  return withPgClient(c.env.POSTGRES_URL, async (client) => {
    const before = await getAdEditable(client, adId);
    if (!before) return ephemeral(c, `広告 \`${adId}\` が見つかりません。`);
    const rules = await fetchFormatRules(client, before.slot);
    if (!rules) return ephemeral(c, '指定 slot の入稿ルールが未設定です');
    const t = validateTitle(rules, title);
    if (!t.ok) return ephemeral(c, t.error);
    const b = validateBody(rules, body);
    if (!b.ok) return ephemeral(c, b.error);
    const l = validateLinkUrl(rules, linkUrl);
    if (!l.ok) return ephemeral(c, l.error);

    const ok = await updateAdContent(client, adId, { title, body, linkUrl });
    if (!ok) return ephemeral(c, '広告の更新に失敗しました。');
    await writeAdminLog(client, {
      actorId,
      action: 'edit_ad',
      targetKind: 'ad',
      targetId: adId,
      before: { title: before.title, body: before.body, link_url: before.linkUrl },
      after: { title, body, link_url: linkUrl },
    });
    return ephemeral(c, `✅ 広告 \`${adId}\` を更新しました。`);
  });
}
