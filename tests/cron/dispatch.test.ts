import { describe, expect, it, vi } from 'vitest';
import { DAILY_CRON, HOURLY_CRON, dispatchCron } from '../../src/cron/index.ts';
import type { Bindings } from '../../src/env.ts';

const ENV = {} as Bindings;
const CTX = {} as ExecutionContext;

function mkEvent(cron: string): ScheduledController {
  return { cron, scheduledTime: 0, noRetry: () => undefined } as ScheduledController;
}

describe('dispatchCron', () => {
  it('routes the hourly cron without throwing', async () => {
    await expect(dispatchCron(mkEvent(HOURLY_CRON), ENV, CTX)).resolves.toBeUndefined();
  });

  it('routes the daily cron without throwing', async () => {
    await expect(dispatchCron(mkEvent(DAILY_CRON), ENV, CTX)).resolves.toBeUndefined();
  });

  it('warns and ignores an unrecognized schedule', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await dispatchCron(mkEvent('*/5 * * * *'), ENV, CTX);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
