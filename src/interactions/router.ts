import { Hono } from 'hono';
import type { Bindings } from '../env.ts';
import { verifyDiscordSignature } from '../discord/verify.ts';
import { InteractionResponseType, InteractionType } from '../discord/types.ts';

export const interactions = new Hono<{ Bindings: Bindings }>();

interactions.post('/', async (c) => {
  const sig = c.req.header('X-Signature-Ed25519');
  const ts = c.req.header('X-Signature-Timestamp');
  if (!sig || !ts) return c.text('missing signature headers', 401);

  // テスト時のみ public key を上書き可。本番環境では env を信頼する。
  const override = c.req.header('X-Public-Key-Override');
  const publicKeyHex =
    c.env.DISCORD_PUBLIC_KEY === '0'.repeat(64) && override ? override : c.env.DISCORD_PUBLIC_KEY;

  const body = await c.req.text();
  const ok = await verifyDiscordSignature({
    publicKeyHex,
    signatureHex: sig,
    timestamp: ts,
    body,
  });
  if (!ok) return c.text('invalid signature', 401);

  const payload = JSON.parse(body) as { type: number };
  if (payload.type === InteractionType.PING) {
    return c.json({ type: InteractionResponseType.PONG });
  }

  // P1 では PING のみ対応。それ以外は 501 でフェーズ未実装を示す。
  return c.json({ error: 'not implemented in P1' }, 501);
});
