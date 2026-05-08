import { Hono } from 'hono';
import { InteractionResponseType, InteractionType } from '../discord/types.ts';
import { verifyDiscordSignature } from '../discord/verify.ts';
import type { Bindings } from '../env.ts';

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

  if (payload.type === InteractionType.PING) {
    return c.json({ type: InteractionResponseType.PONG });
  }

  // P1 では PING のみ対応。それ以外は 501 でフェーズ未実装を示す。
  return c.json({ error: 'not implemented in P1' }, 501);
});
