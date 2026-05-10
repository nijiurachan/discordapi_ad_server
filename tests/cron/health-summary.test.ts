import { describe, expect, it, vi } from 'vitest';
import {
  buildHealthSummaryEmbed,
  collectHealthStats,
  postSystemHealthSummary,
} from '../../src/cron/health-summary.ts';
import type { PgClient } from '../../src/db/client.ts';
import type { DiscordRest } from '../../src/discord/rest.ts';

type Capture = { sql: string; params: unknown[] | undefined };

function mockClient(
  responses: Array<{ rows?: unknown[]; rowCount?: number }>,
  captured: Capture[] = [],
): PgClient {
  let i = 0;
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      const r = responses[i++] ?? {};
      return { rows: r.rows ?? [], rowCount: r.rowCount ?? r.rows?.length ?? 0 };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

describe('collectHealthStats', () => {
  it('aggregates active ads, pending fallbacks, and last salt rotation', async () => {
    const captured: Capture[] = [];
    const rotated = new Date('2026-04-30T12:34:56.000Z');
    const client = mockClient(
      [
        { rows: [{ count: '12' }] }, // active ads
        { rows: [{ count: '3' }] }, // pending fallbacks
        { rows: [{ updated_at: rotated }] }, // last salt rotation
      ],
      captured,
    );
    const stats = await collectHealthStats(client);
    expect(stats).toEqual({ activeAds: 12, pendingFallbacks: 3, lastSaltRotation: rotated });

    const sqls = captured.map((c) => c.sql);
    expect(sqls.some((s) => /FROM ads\s+WHERE status = 'approved'/.test(s))).toBe(true);
    expect(
      sqls.some((s) => /dm_fallback_channels/.test(s) && /acknowledged_at IS NULL/.test(s)),
    ).toBe(true);
    expect(sqls.some((s) => /FROM system_settings/.test(s))).toBe(true);
    expect(captured.find((c) => /FROM system_settings/.test(c.sql))?.params).toEqual([
      'ip_hash_salt',
    ]);
  });

  it('returns lastSaltRotation=null when the row is missing', async () => {
    const client = mockClient([
      { rows: [{ count: '0' }] },
      { rows: [{ count: '0' }] },
      { rows: [] },
    ]);
    const stats = await collectHealthStats(client);
    expect(stats.lastSaltRotation).toBeNull();
  });

  it('coerces an updated_at returned as ISO string into a Date', async () => {
    const iso = '2026-04-30T12:34:56.000Z';
    const client = mockClient([
      { rows: [{ count: '0' }] },
      { rows: [{ count: '0' }] },
      { rows: [{ updated_at: iso }] },
    ]);
    const stats = await collectHealthStats(client);
    expect(stats.lastSaltRotation?.toISOString()).toBe(iso);
  });
});

describe('buildHealthSummaryEmbed', () => {
  it('produces an embed with three fields and a 0x5865f2 color', () => {
    const body = buildHealthSummaryEmbed({
      activeAds: 5,
      pendingFallbacks: 2,
      lastSaltRotation: new Date('2026-04-30T00:00:00.000Z'),
    });
    const embed = body.embeds[0];
    if (!embed) throw new Error('embed missing');
    expect(embed.color).toBe(0x5865f2);
    expect(embed.fields).toHaveLength(3);
    expect(embed.fields[0]).toEqual({ name: 'Active ads', value: '5', inline: true });
    expect(embed.fields[2]?.value).toBe('2026-04-30T00:00:00.000Z');
  });

  it('reports "unknown" when the salt has never rotated', () => {
    const body = buildHealthSummaryEmbed({
      activeAds: 0,
      pendingFallbacks: 0,
      lastSaltRotation: null,
    });
    expect(body.embeds[0]?.fields[2]?.value).toBe('unknown');
  });
});

describe('postSystemHealthSummary', () => {
  it('posts the embed to ADMIN_CHANNEL_ID and returns the stats', async () => {
    const client = mockClient([
      { rows: [{ count: '7' }] },
      { rows: [{ count: '1' }] },
      { rows: [] },
    ]);
    const createMessage = vi.fn(async (_channelId: string, _body: Record<string, unknown>) => ({
      id: 'msg-1',
      channel_id: 'admin',
    }));
    const rest = { createMessage } as unknown as DiscordRest;
    const result = await postSystemHealthSummary(client, rest, 'admin');
    expect(result).toEqual({ activeAds: 7, pendingFallbacks: 1, lastSaltRotation: null });
    expect(createMessage).toHaveBeenCalledTimes(1);
    const [postedChannel, postedBody] = createMessage.mock.calls[0] ?? [];
    expect(postedChannel).toBe('admin');
    const body = postedBody as { embeds: Array<{ title: string }> };
    expect(body.embeds[0]?.title).toContain('Health Summary');
  });
});
