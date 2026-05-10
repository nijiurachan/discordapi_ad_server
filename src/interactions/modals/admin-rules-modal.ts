import type { Context } from 'hono';
import { withPgClient } from '../../db/client.ts';
import { writeAdminLog } from '../../db/queries/admin-logs.ts';
import { upsertAdFormatRules } from '../../db/queries/format-rules.ts';
import { isAdmin } from '../../discord/admin-auth.ts';
import {
  InteractionResponseType,
  type MessageComponentInteractionPayload,
  type ModalResponse,
  type ModalSubmitInteractionPayload,
} from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { parseAdFormatRules } from '../../validation/schemas.ts';
import { ephemeral } from '../responses.ts';

export const ADMIN_RULES_MODAL_PREFIX = 'admin-rules:';

const RULES_TEMPLATE = JSON.stringify(
  {
    slot: 'default',
    allowedMimes: ['image/png', 'image/jpeg'],
    allowedExtensions: ['png', 'jpg', 'jpeg'],
    maxBytes: 1000000,
    minWidth: 200,
    maxWidth: 2000,
    minHeight: 200,
    maxHeight: 2000,
    aspectRatios: ['1:1'],
    aspectTolerance: 0.02,
    titleMaxLen: 80,
    bodyMaxLen: 500,
    linkUrlMaxLen: 2048,
    linkScheme: ['https'],
  },
  null,
  2,
);

export function buildRulesEditorModal(): ModalResponse {
  return {
    custom_id: `${ADMIN_RULES_MODAL_PREFIX}edit`,
    title: '入稿ルール（JSON）の編集',
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: 'rules_json',
            label: 'AdFormatRules JSON',
            style: 2,
            required: true,
            min_length: 10,
            max_length: 4000,
            placeholder: RULES_TEMPLATE,
          },
        ],
      },
    ],
  };
}

export async function handleAdminRulesEntry(
  c: Context<{ Bindings: Bindings }>,
  payload: MessageComponentInteractionPayload,
): Promise<Response> {
  if (!isAdmin(payload, c.env.ADMIN_ROLE_ID)) {
    return ephemeral(c, '⚠ この操作には管理者ロールが必要です。');
  }
  return c.json({ type: InteractionResponseType.MODAL, data: buildRulesEditorModal() });
}

function findValue(payload: ModalSubmitInteractionPayload, customId: string): string {
  for (const row of payload.data.components) {
    for (const comp of row.components) {
      if (comp.custom_id === customId) return comp.value;
    }
  }
  return '';
}

export async function handleAdminRulesSubmitModal(
  c: Context<{ Bindings: Bindings }>,
  payload: ModalSubmitInteractionPayload,
): Promise<Response> {
  if (!isAdmin(payload, c.env.ADMIN_ROLE_ID)) {
    return ephemeral(c, '⚠ この操作には管理者ロールが必要です。');
  }
  const raw = findValue(payload, 'rules_json').trim();
  if (!raw) return ephemeral(c, 'JSON を入力してください');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ephemeral(c, '❌ JSON 形式が不正です');
  }

  const result = parseAdFormatRules(parsed);
  if (!result.ok) {
    const head = result.errors.slice(0, 8).join('\n• ');
    return ephemeral(c, `❌ スキーマ違反:\n• ${head}`);
  }

  const actorId = payload.member?.user?.id ?? payload.user?.id ?? 'unknown';
  await withPgClient(c.env.POSTGRES_URL, async (client) => {
    await upsertAdFormatRules(client, result.value, actorId);
    await writeAdminLog(client, {
      actorId,
      action: 'upsert_format_rules',
      targetKind: 'format_rules',
      targetId: result.value.slot,
      after: result.value,
    });
  });

  return ephemeral(c, `✅ slot=\`${result.value.slot}\` の入稿ルールを更新しました。`);
}
