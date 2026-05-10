import type { Context } from 'hono';
import { withPgClient } from '../../db/client.ts';
import { isAdmin } from '../../discord/admin-auth.ts';
import { createDiscordRest } from '../../discord/rest.ts';
import type { ModalSubmitInteractionPayload } from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { forceEndAdAction, pauseAd, resumeAd } from '../../services/admin/ad-actions.ts';
import { ephemeral } from '../responses.ts';

export const ADMIN_ACTION_MODAL_PREFIX = 'admin-action:';

const ACTION_LABELS: Record<string, string> = {
  pause: '一時停止',
  resume: '再開',
  'force-end': '強制終了',
};

function findAdId(payload: ModalSubmitInteractionPayload): string | null {
  for (const row of payload.data.components) {
    for (const comp of row.components) {
      if (comp.custom_id === 'ad_id') {
        return comp.value.trim();
      }
    }
  }
  return null;
}

export async function handleAdminActionModal(
  c: Context<{ Bindings: Bindings }>,
  payload: ModalSubmitInteractionPayload,
): Promise<Response> {
  if (!isAdmin(payload, c.env.ADMIN_ROLE_ID)) {
    return ephemeral(c, '⚠ この操作には管理者ロールが必要です。');
  }
  const customId = payload.data.custom_id;
  if (!customId.startsWith(ADMIN_ACTION_MODAL_PREFIX)) {
    return ephemeral(c, '不正な custom_id です');
  }
  const action = customId.slice(ADMIN_ACTION_MODAL_PREFIX.length);
  if (!Object.hasOwn(ACTION_LABELS, action)) {
    return ephemeral(c, '未対応のアクションです');
  }
  const adId = findAdId(payload);
  if (!adId) {
    return ephemeral(c, '広告 ID を入力してください');
  }
  const actorId = payload.member?.user?.id ?? payload.user?.id ?? 'unknown';
  const rest = createDiscordRest({ token: c.env.DISCORD_BOT_TOKEN });

  const result = await withPgClient(c.env.POSTGRES_URL, async (client) => {
    if (action === 'pause') return pauseAd(client, actorId, adId);
    if (action === 'resume') return resumeAd(client, actorId, adId);
    if (action === 'force-end') return forceEndAdAction(client, actorId, adId, { rest });
    // Unreachable: hasOwn guard above already rejected unknown actions.
    return { ok: false as const, reason: 'invalid_status' as const };
  });

  if (!result.ok) {
    if (result.reason === 'not_found') {
      return ephemeral(c, `広告 \`${adId}\` が見つかりません。`);
    }
    if (result.reason === 'invalid_status') {
      return ephemeral(c, `この広告は ${ACTION_LABELS[action]} できないステータスです。`);
    }
    return ephemeral(c, '操作の競合が発生しました。一覧を更新して再試行してください。');
  }
  return ephemeral(
    c,
    `✅ ${ACTION_LABELS[action]} を実行しました（${result.before.status} → ${result.after.status}）`,
  );
}
