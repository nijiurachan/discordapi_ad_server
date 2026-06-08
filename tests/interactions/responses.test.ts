import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { deferredEphemeral, updateMessage } from '../../src/interactions/responses.ts';

function ctx() {
  const app = new Hono();
  let captured: unknown;
  app.post('/', (c) => {
    captured = null;
    return c.json({});
  });
  // Build a minimal Context by invoking a handler that returns our helper's Response.
  return { app };
}

describe('deferredEphemeral', () => {
  it('returns type 5 with ephemeral flag', async () => {
    const app = new Hono();
    app.post('/', (c) => deferredEphemeral(c));
    const res = await app.request('/', { method: 'POST' });
    expect(await res.json()).toEqual({ type: 5, data: { flags: 64 } });
  });
});

describe('updateMessage', () => {
  it('returns type 7 with provided content/embeds/components', async () => {
    const app = new Hono();
    app.post('/', (c) =>
      updateMessage(c, { content: 'x', embeds: [{ title: 't' }], components: [] }),
    );
    const res = await app.request('/', { method: 'POST' });
    expect(await res.json()).toEqual({
      type: 7,
      data: { content: 'x', embeds: [{ title: 't' }], components: [] },
    });
  });
});
