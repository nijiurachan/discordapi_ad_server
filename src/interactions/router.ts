import { Hono } from 'hono';
import type {
  ApplicationCommandInteractionPayload,
  ModalSubmitInteractionPayload,
} from '../discord/types.ts';
import { InteractionResponseType, InteractionType } from '../discord/types.ts';
import { verifyDiscordSignature } from '../discord/verify.ts';
import type { Bindings } from '../env.ts';
import { handleAdSubmit } from './commands/ad-submit.ts';
import { handleSubmitModal } from './modals/submit-modal.ts';

function isInteractionPayload(value: unknown): value is { type: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'number'
  );
}

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
        // Forward-compatible: future subcommands like /ad list, /ad withdraw
        // may sit alongside submit. Use Array.find rather than indexing opts[0].
        const subcommand = opts.find((o) => o.type === 1 && o.name === 'submit');
        if (subcommand) {
          return handleAdSubmit(c, cmd);
        }
      }
      return c.json({ error: 'unknown command' }, 501);
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
