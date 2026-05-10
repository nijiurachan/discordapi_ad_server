import type { Context } from 'hono';
import { z } from 'zod';
import { withPgClient } from '../../db/client.ts';
import { writeAdminLog } from '../../db/queries/admin-logs.ts';
import { upsertTier } from '../../db/queries/tiers.ts';
import { isAdmin } from '../../discord/admin-auth.ts';
import {
  InteractionResponseType,
  type MessageComponentInteractionPayload,
  type ModalResponse,
  type ModalSubmitInteractionPayload,
} from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { ephemeral } from '../responses.ts';

export const ADMIN_TIERS_MODAL_PREFIX = 'admin-tiers:';

const tierInputSchema = z.object({
  discordRoleId: z.string().regex(/^\d{15,21}$/, 'Discord ロール ID は数値文字列で 15〜21 桁'),
  name: z.string().min(1).max(64),
  weight: z.number().int().positive().max(10000),
  maxActiveAds: z.number().int().positive().max(100),
  rank: z.number().int().nonnegative().max(10000),
});

function findValue(payload: ModalSubmitInteractionPayload, customId: string): string {
  for (const row of payload.data.components) {
    for (const c of row.components) {
      if (c.custom_id === customId) return c.value;
    }
  }
  return '';
}

export function buildTierUpsertModal(): ModalResponse {
  return {
    custom_id: `${ADMIN_TIERS_MODAL_PREFIX}upsert`,
    title: 'ティア追加 / 編集',
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: 'discord_role_id',
            label: 'Discord Role ID',
            style: 1,
            required: true,
            min_length: 15,
            max_length: 21,
            placeholder: '111122223333444455',
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: 'name',
            label: 'ティア名',
            style: 1,
            required: true,
            min_length: 1,
            max_length: 64,
            placeholder: 'Bronze',
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: 'weight',
            label: 'weight (重み, 1-10000)',
            style: 1,
            required: true,
            min_length: 1,
            max_length: 5,
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: 'max_active_ads',
            label: 'max_active_ads (同時配信数, 1-100)',
            style: 1,
            required: true,
            min_length: 1,
            max_length: 3,
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: 'rank',
            label: 'rank (順位, 数値が大きいほど上位)',
            style: 1,
            required: true,
            min_length: 1,
            max_length: 5,
          },
        ],
      },
    ],
  };
}

export async function handleAdminTiersEntry(
  c: Context<{ Bindings: Bindings }>,
  payload: MessageComponentInteractionPayload,
): Promise<Response> {
  if (!isAdmin(payload, c.env.ADMIN_ROLE_ID)) {
    return ephemeral(c, '⚠ この操作には管理者ロールが必要です。');
  }
  return c.json({ type: InteractionResponseType.MODAL, data: buildTierUpsertModal() });
}

export async function handleAdminTiersSubmitModal(
  c: Context<{ Bindings: Bindings }>,
  payload: ModalSubmitInteractionPayload,
): Promise<Response> {
  if (!isAdmin(payload, c.env.ADMIN_ROLE_ID)) {
    return ephemeral(c, '⚠ この操作には管理者ロールが必要です。');
  }
  const raw = {
    discordRoleId: findValue(payload, 'discord_role_id').trim(),
    name: findValue(payload, 'name').trim(),
    weight: Number(findValue(payload, 'weight').trim()),
    maxActiveAds: Number(findValue(payload, 'max_active_ads').trim()),
    rank: Number(findValue(payload, 'rank').trim()),
  };
  const parsed = tierInputSchema.safeParse(raw);
  if (!parsed.success) {
    const head = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .slice(0, 5)
      .join('\n• ');
    return ephemeral(c, `❌ 入力エラー:\n• ${head}`);
  }
  const actorId = payload.member?.user?.id ?? payload.user?.id ?? 'unknown';
  const result = await withPgClient(c.env.POSTGRES_URL, async (client) => {
    const out = await upsertTier(client, parsed.data);
    if (out.ok) {
      await writeAdminLog(client, {
        actorId,
        action: 'upsert_tier',
        targetKind: 'tier',
        targetId: parsed.data.discordRoleId,
        after: parsed.data,
      });
    }
    return out;
  });
  if (!result.ok) {
    if (result.reason === 'duplicate_rank') {
      return ephemeral(c, `❌ rank=${parsed.data.rank} は既に他のティアで使用されています。`);
    }
    return ephemeral(c, '❌ 競合エラー: 同じ Role ID または rank が重複しています。');
  }
  return ephemeral(
    c,
    `✅ ティア \`${parsed.data.name}\` を保存しました（rank=${parsed.data.rank}）`,
  );
}
