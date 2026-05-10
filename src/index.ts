import { Hono } from 'hono';
import { dispatchCron } from './cron/index.ts';
import type { Bindings } from './env.ts';
import { health } from './health.ts';
import { interactions } from './interactions/router.ts';
import { serveRouter } from './serve/router.ts';

const app = new Hono<{ Bindings: Bindings }>();

app.route('/health', health);
app.route('/interactions', interactions);
app.route('/ads', serveRouter);

app.get('/', (c) => c.text('discordapi_ad_server'));

export default {
  fetch: app.fetch,
  scheduled: async (
    ev: ScheduledController,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<void> => {
    try {
      await dispatchCron(ev, env, ctx);
    } catch (err) {
      console.error('scheduled: dispatch failed', { cron: ev.cron, err });
      throw err;
    }
  },
} satisfies ExportedHandler<Bindings>;
