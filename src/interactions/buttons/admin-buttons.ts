import type { Context } from 'hono';
import { isAdmin } from '../../discord/admin-auth.ts';
import { type AdminButtonId, AdminButtonIds, adminButtonLabel } from '../../discord/admin-menu.ts';
import {
  InteractionResponseType,
  type MessageComponentInteractionPayload,
  type ModalResponse,
} from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { handleAdminAdsListEntry } from '../admin-ads-list.ts';
import { ADMIN_ACTION_MODAL_PREFIX } from '../modals/admin-action-modal.ts';
import { handleAdminRulesEntry } from '../modals/admin-rules-modal.ts';
import { ephemeral } from '../responses.ts';

const KNOWN_BUTTON_IDS = new Set<string>(Object.values(AdminButtonIds));

const ACTION_BY_BUTTON: Record<string, { action: string; title: string }> = {
  [AdminButtonIds.ADS_PAUSE]: { action: 'pause', title: '広告を一時停止' },
  [AdminButtonIds.ADS_RESUME]: { action: 'resume', title: '広告を再開' },
  [AdminButtonIds.ADS_END]: { action: 'force-end', title: '広告を強制終了' },
};

function adIdEditPickModal(): ModalResponse {
  return {
    custom_id: 'admin-edit-pick:open',
    title: '編集対象の広告 ID',
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: 'ad_id',
            label: '対象広告 ID',
            style: 1,
            required: true,
            min_length: 8,
            max_length: 40,
            placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
          },
        ],
      },
    ],
  };
}

function adIdModal(action: string, title: string): ModalResponse {
  return {
    custom_id: `${ADMIN_ACTION_MODAL_PREFIX}${action}`,
    title,
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: 'ad_id',
            label: '対象広告 ID（一覧で表示される UUID）',
            style: 1,
            required: true,
            min_length: 8,
            max_length: 40,
            placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
          },
        ],
      },
    ],
  };
}

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
  if (id === AdminButtonIds.ADS_EDIT) {
    return c.json({ type: InteractionResponseType.MODAL, data: adIdEditPickModal() });
  }
  if (id === AdminButtonIds.SETTINGS_RULES) {
    return handleAdminRulesEntry(c, payload);
  }
  const actionMapping = ACTION_BY_BUTTON[id];
  if (actionMapping) {
    return c.json({
      type: InteractionResponseType.MODAL,
      data: adIdModal(actionMapping.action, actionMapping.title),
    });
  }
  const label = adminButtonLabel(id as AdminButtonId);
  return ephemeral(c, `🛠 「${label}」は後続タスクで実装予定です。`);
}
