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
import { handleAdminTiersEntry } from '../modals/admin-tiers-modal.ts';
import { ephemeral } from '../responses.ts';
import { handleAdminSystemButton } from './admin-system-buttons.ts';

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
  if (id === AdminButtonIds.ADS_ADMIN_SUBMIT) {
    // Discord modals can't carry attachments, so admin contribution stays on
    // the slash-command path. The button just surfaces the usage here.
    return ephemeral(
      c,
      '➕ **管理者として起稿** はスラッシュコマンド経由です。\n\n' +
        '```\n/admin submit kind:<regular|house|placeholder> slot:default image:<画像添付>\n```\n\n' +
        '主要オプション：\n' +
        '• `kind` regular = 通常広告（sponsor_id 必須 or 自分名義）/ house = ハウス広告 / placeholder = 在庫切れ表示\n' +
        '• `sponsor_id` regular で他人を代理起稿する場合のみ（省略時は自分）\n' +
        '• `weight` 重み（省略時は kind と tier から自動）\n' +
        '• `ends_in_days` 配信終了までの日数（1-365、省略で無期限）\n' +
        '• `auto_approve` true なら審査スキップで即時 approved',
    );
  }
  if (id === AdminButtonIds.ADS_EDIT) {
    return c.json({ type: InteractionResponseType.MODAL, data: adIdEditPickModal() });
  }
  if (id === AdminButtonIds.SETTINGS_RULES) {
    return handleAdminRulesEntry(c, payload);
  }
  if (id === AdminButtonIds.SETTINGS_TIERS) {
    return handleAdminTiersEntry(c, payload);
  }
  if (id === AdminButtonIds.SETTINGS_HOUSE) {
    return handleAdminAdsListEntry(c, payload, { kind: 'house' });
  }
  if (id === AdminButtonIds.SETTINGS_PLACEHOLDER) {
    return handleAdminAdsListEntry(c, payload, { kind: 'placeholder' });
  }
  if (
    id === AdminButtonIds.SYSTEM_REPOST ||
    id === AdminButtonIds.SYSTEM_ROTATE_SALT ||
    id === AdminButtonIds.SYSTEM_HEALTH
  ) {
    return handleAdminSystemButton(c, payload, id);
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
