import { Hono } from 'hono';
import type { Bindings } from './env.ts';

export const health = new Hono<{ Bindings: Bindings }>();

health.get('/', (c) =>
  c.json({
    status: 'ok',
    service: 'discordapi_ad_server',
    time: new Date().toISOString(),
  }),
);
