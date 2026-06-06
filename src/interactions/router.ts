import { Hono } from 'hono';
import type {
  ApplicationCommandInteractionPayload,
  MessageComponentInteractionPayload,
  ModalSubmitInteractionPayload,
} from '../discord/types.ts';
import { InteractionResponseType, InteractionType } from '../discord/types.ts';
import { verifyDiscordSignature } from '../discord/verify.ts';
import type { Bindings } from '../env.ts';
import { handleAdminAdsListButton } from './admin-ads-list.ts';
import { handleAdminButton } from './buttons/admin-buttons.ts';
import { handleAckButton } from './buttons/fallback-ack-button.ts';
import { handleReviewApproveButton } from './buttons/review-approve-button.ts';
import { handleReviewRejectButton } from './buttons/review-reject-button.ts';
import { handleAdList } from './commands/ad-list.ts';
import { handleAdRules } from './commands/ad-rules.ts';
import { handleAdSetup } from './commands/ad-setup.ts';
import { handleAdStatsButton, handleAdStatsCommand } from './commands/ad-stats.ts';
import { handleAdSubmit } from './commands/ad-submit.ts';
import { handleAdWithdrawButton, handleAdWithdrawCommand } from './commands/ad-withdraw.ts';
import { handleAdminReplaceImage } from './commands/admin-replace-image.ts';
import { handleAdminStats } from './commands/admin-stats.ts';
import { handleAdminSubmit } from './commands/admin-submit.ts';
import { handleAdminActionModal } from './modals/admin-action-modal.ts';
import {
  ADMIN_EDIT_MODAL_PREFIX,
  ADMIN_EDIT_OPEN_PREFIX,
  ADMIN_EDIT_PICK_PREFIX,
  handleAdminEditOpenButton,
  handleAdminEditPickModal,
  handleAdminEditSubmitModal,
} from './modals/admin-edit-modal.ts';
import {
  ADMIN_RULES_MODAL_PREFIX,
  handleAdminRulesSubmitModal,
} from './modals/admin-rules-modal.ts';
import { handleAdminSubmitModal } from './modals/admin-submit-modal.ts';
import {
  ADMIN_TIERS_MODAL_PREFIX,
  handleAdminTiersSubmitModal,
} from './modals/admin-tiers-modal.ts';
import { handleRejectModal } from './modals/review-reject-modal.ts';
import { handleSubmitModal } from './modals/submit-modal.ts';
import { ephemeral } from './responses.ts';

function isInteractionPayload(value: unknown): value is { type: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'number'
  );
}

const HELP_TEXT =
  '📝 起稿の手順:\n' +
  '1. /ad submit を実行\n' +
  '2. slot を選択（現在は default のみ）\n' +
  '3. 画像を添付（PNG/JPEG/GIF/WebP、5MB 以下）\n' +
  '4. タイトル / 本文 / リンク URL を入力\n' +
  '5. 審査結果は DM で通知（または自動作成されるプライベートチャンネル）';

export const interactions = new Hono<{ Bindings: Bindings }>();

interactions.post('/', async (c) => {
  const sig = c.req.header('X-Signature-Ed25519');
  const ts = c.req.header('X-Signature-Timestamp');
  if (!sig || !ts) return c.text('missing signature headers', 401);

  // 公開鍵の上書きは TEST_OVERRIDE_ALLOWED='true' の binding がある時のみ許可。
  // 本番環境ではこの binding は未設定であり、override ヘッダは無視される。
  const override = c.req.header('X-Public-Key-Override');
  const publicKeyHex =
    c.env.TEST_OVERRIDE_ALLOWED === 'true' && override ? override : c.env.DISCORD_PUBLIC_KEY;

  const body = await c.req.text();
  const ok = await verifyDiscordSignature({
    publicKeyHex,
    signatureHex: sig,
    timestamp: ts,
    body,
  });
  if (!ok) return c.text('invalid signature', 401);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return c.json({ error: 'Bad Request' }, 400);
  }

  if (!isInteractionPayload(parsed)) {
    return c.json({ error: 'Bad Request' }, 400);
  }
  const payload = parsed;

  switch (payload.type) {
    case InteractionType.PING:
      return c.json({ type: InteractionResponseType.PONG });

    case InteractionType.APPLICATION_COMMAND: {
      const cmd = parsed as ApplicationCommandInteractionPayload;
      if (cmd.data?.name === 'ad') {
        const opts = cmd.data.options ?? [];
        // /ad has multiple subcommands (submit / list / withdraw / stats / rules).
        // Find the first one with type=1 (SUB_COMMAND); fall back to 501 otherwise.
        const sub = opts.find((o) => o.type === 1);
        switch (sub?.name) {
          case 'submit':
            return handleAdSubmit(c, cmd);
          case 'list':
            return handleAdList(c, cmd);
          case 'withdraw':
            return handleAdWithdrawCommand(c, cmd);
          case 'stats':
            return handleAdStatsCommand(c, cmd);
          case 'rules':
            return handleAdRules(c, cmd);
          default:
            return c.json({ error: 'unknown ad subcommand' }, 501);
        }
      }
      if (cmd.data?.name === 'ad-setup') {
        return handleAdSetup(c, cmd);
      }
      if (cmd.data?.name === 'admin') {
        const opts = cmd.data.options ?? [];
        const sub = opts.find((o) => o.type === 1);
        switch (sub?.name) {
          case 'submit':
            return handleAdminSubmit(c, cmd);
          case 'replace-image':
            return handleAdminReplaceImage(c, cmd);
          case 'stats':
            return handleAdminStats(c, cmd);
          default:
            return c.json({ error: 'unknown admin subcommand' }, 501);
        }
      }
      return c.json({ error: 'unknown command' }, 501);
    }

    case InteractionType.MESSAGE_COMPONENT: {
      const mc = parsed as MessageComponentInteractionPayload;
      const cid = mc.data?.custom_id ?? '';
      if (cid === 'ad:list') {
        return handleAdList(c, mc);
      }
      if (cid === 'ad:rules') {
        return handleAdRules(c, mc);
      }
      if (cid === 'ad:help') {
        return ephemeral(c, HELP_TEXT);
      }
      if (cid.startsWith('ad:stats:')) {
        return handleAdStatsButton(c, mc);
      }
      if (cid.startsWith('ad:withdraw:')) {
        return handleAdWithdrawButton(c, mc);
      }
      if (cid.startsWith('review:approve:')) {
        return handleReviewApproveButton(c, mc);
      }
      if (cid.startsWith('review:reject:')) {
        return handleReviewRejectButton(c, mc);
      }
      if (cid.startsWith('ack:')) {
        return handleAckButton(c, mc);
      }
      if (cid.startsWith('adm:')) {
        return handleAdminButton(c, mc);
      }
      if (cid.startsWith('adlist:')) {
        return handleAdminAdsListButton(c, mc);
      }
      if (cid.startsWith(ADMIN_EDIT_OPEN_PREFIX)) {
        return handleAdminEditOpenButton(c, mc);
      }
      return c.json({ error: 'unknown component' }, 501);
    }

    case InteractionType.MODAL_SUBMIT: {
      const modal = parsed as ModalSubmitInteractionPayload;
      const modalCid = modal.data?.custom_id;
      if (typeof modalCid === 'string') {
        if (modalCid.startsWith('submit:')) {
          return handleSubmitModal(c, modal);
        }
        if (modalCid.startsWith('admin-submit:')) {
          return handleAdminSubmitModal(c, modal);
        }
        if (modalCid.startsWith('admin-action:')) {
          return handleAdminActionModal(c, modal);
        }
        if (modalCid.startsWith(ADMIN_EDIT_PICK_PREFIX)) {
          return handleAdminEditPickModal(c, modal);
        }
        if (modalCid.startsWith(ADMIN_EDIT_MODAL_PREFIX)) {
          return handleAdminEditSubmitModal(c, modal);
        }
        if (modalCid.startsWith(ADMIN_RULES_MODAL_PREFIX)) {
          return handleAdminRulesSubmitModal(c, modal);
        }
        if (modalCid.startsWith(ADMIN_TIERS_MODAL_PREFIX)) {
          return handleAdminTiersSubmitModal(c, modal);
        }
        if (modalCid.startsWith('review-reject-modal:')) {
          return handleRejectModal(c, modal);
        }
      }
      return c.json({ error: 'unknown modal' }, 501);
    }

    default:
      return c.json({ error: 'not implemented' }, 501);
  }
});
