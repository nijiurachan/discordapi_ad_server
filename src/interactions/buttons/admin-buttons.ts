import type { Context } from 'hono';
import { isAdmin } from '../../discord/admin-auth.ts';
import { type AdminButtonId, AdminButtonIds, adminButtonLabel } from '../../discord/admin-menu.ts';
import type { MessageComponentInteractionPayload } from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { handleAdminAdsListEntry } from '../admin-ads-list.ts';
import { ephemeral } from '../responses.ts';

const KNOWN_BUTTON_IDS = new Set<string>(Object.values(AdminButtonIds));

export async function handleAdminButton(
  c: Context<{ Bindings: Bindings }>,
  payload: MessageComponentInteractionPayload,
): Promise<Response> {
  if (!isAdmin(payload, c.env.ADMIN_ROLE_ID)) {
    return ephemeral(c, '⚠ この操作には管理者ロールが必要です。');
  }
  const id = payload.data.custom_id;
  if (!KNOWN_BUTTON_IDS.has(id)) {
    return ephemeral(c, '未対応のボタンです。');
  }
  if (id === AdminButtonIds.ADS_LIST) {
    return handleAdminAdsListEntry(c, payload);
  }
  const label = adminButtonLabel(id as AdminButtonId);
  return ephemeral(c, `🛠 「${label}」は後続タスクで実装予定です。`);
}
