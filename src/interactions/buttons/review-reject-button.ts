import type { Context } from 'hono';
import type { MessageComponentInteractionPayload, ModalResponse } from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { isReviewer } from '../../sponsors/reviewer-auth.ts';
import { ephemeral, modalResponse } from '../responses.ts';

const MODAL_PREFIX = 'review-reject-modal:';

/**
 * Reject button handler. Verifies reviewer role, then returns a Modal asking
 * for a 10–500 char reject reason. The Modal's custom_id encodes the ad id so
 * the submit handler can recover it without a round-trip.
 *
 * Pure (no I/O) — relies only on the payload + the reviewer role from env.
 */
export function handleReviewRejectButton(
  c: Context<{ Bindings: Bindings }>,
  payload: MessageComponentInteractionPayload,
): Response {
  const reviewerCheck = payload.member ? { member: payload.member } : {};
  if (!isReviewer(reviewerCheck, c.env.REVIEWER_ROLE_ID)) {
    return ephemeral(c, '⚠ レビュアー権限が必要です。');
  }
  // custom_id format: review:reject:{adId}
  const parts = payload.data.custom_id.split(':');
  const adId = parts[2] ?? '';
  if (!adId) return ephemeral(c, '広告 ID を取得できません。');

  const modal: ModalResponse = {
    custom_id: `${MODAL_PREFIX}${adId}`,
    title: '❌ 却下理由を入力',
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: 'reason',
            label: '却下理由（必須・10〜500 文字）',
            style: 2, // PARAGRAPH
            required: true,
            min_length: 10,
            max_length: 500,
            placeholder: 'この理由は起稿者に DM で通知されます。',
          },
        ] as const,
      },
    ],
  };
  return modalResponse(c, modal);
}
