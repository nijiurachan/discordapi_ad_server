import { Hono } from 'hono';
import type {
  ApplicationCommandInteractionPayload,
  MessageComponentInteractionPayload,
  ModalSubmitInteractionPayload,
} from '../discord/types.ts';
import { InteractionResponseType, InteractionType } from '../discord/types.ts';
import { verifyDiscordSignature } from '../discord/verify.ts';
import type { Bindings } from '../env.ts';
import { handleAdList } from './commands/ad-list.ts';
import { handleAdRules } from './commands/ad-rules.ts';
import { handleAdSetup } from './commands/ad-setup.ts';
import { handleAdStatsButton, handleAdStatsCommand } from './commands/ad-stats.ts';
import { handleAdSubmit } from './commands/ad-submit.ts';
import { handleAdWithdrawButton, handleAdWithdrawCommand } from './commands/ad-withdraw.ts';
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
      return c.json({ error: 'unknown component' }, 501);
    }

    case InteractionType.MODAL_SUBMIT: {
      const modal = parsed as ModalSubmitInteractionPayload;
      if (typeof modal.data?.custom_id === 'string' && modal.data.custom_id.startsWith('submit:')) {
        return handleSubmitModal(c, modal);
      }
      return c.json({ error: 'unknown modal' }, 501);
    }

    default:
      return c.json({ error: 'not implemented' }, 501);
  }
});
