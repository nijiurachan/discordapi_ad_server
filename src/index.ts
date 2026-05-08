import { Hono } from 'hono';
import type { Bindings } from './env.ts';
import { health } from './health.ts';
import { interactions } from './interactions/router.ts';

const app = new Hono<{ Bindings: Bindings }>();

app.route('/health', health);
app.route('/interactions', interactions);

app.get('/', (c) => c.text('discordapi_ad_server'));

export default {
  fetch: app.fetch,
  // P1: scheduled は空ハンドラ。P7 で実装
  scheduled: async (
    _ev: ScheduledController,
    _env: Bindings,
    _ctx: ExecutionContext,
  ): Promise<void> => {
    // intentionally empty for P1
  },
} satisfies ExportedHandler<Bindings>;
