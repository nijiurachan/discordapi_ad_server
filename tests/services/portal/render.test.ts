import { describe, expect, it, vi } from 'vitest';
import type { ActiveBanner } from '../../../src/db/queries/portal.ts';
import type { DiscordRest } from '../../../src/discord/rest.ts';
import {
  buildPortalDashboard,
  renderPortalDashboard,
} from '../../../src/services/portal/render.ts';

const banners: ActiveBanner[] = [
  { id: 'a-1', slot: 'default', title: 'Banner One', status: 'approved', weightAlloc: 4 },
  { id: 'a-2', slot: 'default', title: 'Banner Two', status: 'pending', weightAlloc: 2 },
];

describe('buildPortalDashboard', () => {
  it('renders plan, remaining weight, cap+used, and banner lines', () => {
    const msg = buildPortalDashboard({
      tierName: 'Gold',
      budget: { tierWeight: 10, used: 6, remaining: 4 },
      maxActiveAds: 3,
      usedCount: 2,
      banners,
    });
    const embed = msg.embeds[0] as { title: string; fields: { name: string; value: string }[] };
    expect(embed.title).toContain('広告ポータル');
    const text = JSON.stringify(embed.fields);
    expect(text).toContain('Gold');
    expect(text).toContain('4'); // remaining weight
    expect(text).toContain('2 / 3'); // used / cap
    expect(text).toContain('Banner One');
    expect(text).toContain('Banner Two');
    // 4 dashboard buttons present
    const row = msg.components[0] as { components: { custom_id: string }[] };
    expect(row.components.map((b) => b.custom_id)).toEqual([
      'portal:add',
      'portal:manage',
      'portal:refresh',
      'portal:close',
    ]);
  });

  it('handles null budget (no tier) and empty banners', () => {
    const msg = buildPortalDashboard({
      tierName: null,
      budget: null,
      maxActiveAds: 0,
      usedCount: 0,
      banners: [],
    });
    const embed = msg.embeds[0] as { fields: { value: string }[] };
    const text = JSON.stringify(embed.fields);
    expect(text).toContain('ティアロール'); // no-tier note
  });
});

describe('renderPortalDashboard', () => {
  it('creates a message and persists dashboard_message_id when none exists', async () => {
    const captured: { sql: string; params: unknown[] | undefined }[] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }),
      end: vi.fn(),
    } as unknown as Parameters<typeof renderPortalDashboard>[0]['client'];
    const rest = {
      createMessage: vi.fn(async () => ({ id: 'msg-new', channel_id: 'c-1' })),
      editMessage: vi.fn(),
    } as unknown as DiscordRest;

    await renderPortalDashboard({
      client,
      rest,
      portalId: 'p-1',
      channelId: 'c-1',
      dashboardMessageId: null,
      dashboard: buildPortalDashboard({
        tierName: 'Gold',
        budget: { tierWeight: 10, used: 0, remaining: 10 },
        maxActiveAds: 3,
        usedCount: 0,
        banners: [],
      }),
    });

    expect(rest.createMessage).toHaveBeenCalledTimes(1);
    expect(rest.editMessage).not.toHaveBeenCalled();
    expect(
      captured.find((c) => /UPDATE portal_channels SET dashboard_message_id/.test(c.sql)),
    ).toBeDefined();
  });

  it('edits the existing dashboard message in place', async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      end: vi.fn(),
    } as unknown as Parameters<typeof renderPortalDashboard>[0]['client'];
    const rest = {
      createMessage: vi.fn(),
      editMessage: vi.fn(async () => ({ id: 'm-1', channel_id: 'c-1' })),
    } as unknown as DiscordRest;

    await renderPortalDashboard({
      client,
      rest,
      portalId: 'p-1',
      channelId: 'c-1',
      dashboardMessageId: 'm-1',
      dashboard: buildPortalDashboard({
        tierName: 'Gold',
        budget: { tierWeight: 10, used: 0, remaining: 10 },
        maxActiveAds: 3,
        usedCount: 0,
        banners: [],
      }),
    });

    expect(rest.editMessage).toHaveBeenCalledTimes(1);
    expect((rest.editMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.slice(0, 2)).toEqual([
      'c-1',
      'm-1',
    ]);
    expect(rest.createMessage).not.toHaveBeenCalled();
  });
});
