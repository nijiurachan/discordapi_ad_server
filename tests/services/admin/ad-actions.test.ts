import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import type { DiscordRest } from '../../../src/discord/rest.ts';
import { forceEndAdAction, pauseAd, resumeAd } from '../../../src/services/admin/ad-actions.ts';

type Capture = { sql: string; params: unknown[] | undefined };

function mockClient(
  responses: Array<{ rows?: unknown[]; rowCount?: number }>,
  captured: Capture[],
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

const adRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'ad-1',
  sponsor_id: 'sponsor-1',
  kind: 'regular',
  status: 'approved',
  title: 'Sample',
  starts_at: null,
  ends_at: null,
  ...overrides,
});

describe('pauseAd', () => {
  it('returns ok when transitioning approved -> paused', async () => {
    const captured: Capture[] = [];
    const client = mockClient(
      [
        { rows: [adRow()] }, // SELECT
        { rowCount: 1 }, // UPDATE
        { rowCount: 1 }, // INSERT admin_logs
      ],
      captured,
    );
    const result = await pauseAd(client, 'admin-1', 'ad-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.before.status).toBe('approved');
      expect(result.after.status).toBe('paused');
    }
    const updateSql = captured[1]?.sql ?? '';
    expect(updateSql).toContain('UPDATE ads');
    const logSql = captured[2]?.sql ?? '';
    expect(logSql).toContain('admin_logs');
  });

  it('returns invalid_status when ad is not approved', async () => {
    const captured: Capture[] = [];
    const client = mockClient([{ rows: [adRow({ status: 'paused' })] }], captured);
    const result = await pauseAd(client, 'admin-1', 'ad-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_status');
    expect(captured).toHaveLength(1); // no UPDATE/INSERT
  });

  it('returns not_found when ad does not exist', async () => {
    const captured: Capture[] = [];
    const client = mockClient([{ rows: [] }], captured);
    const result = await pauseAd(client, 'admin-1', 'missing');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });
});

describe('resumeAd', () => {
  it('returns ok when transitioning paused -> approved', async () => {
    const client = mockClient(
      [{ rows: [adRow({ status: 'paused' })] }, { rowCount: 1 }, { rowCount: 1 }],
      [],
    );
    const result = await resumeAd(client, 'admin-1', 'ad-1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.after.status).toBe('approved');
  });
});

describe('forceEndAdAction', () => {
  it('marks status=expired and ends_at=now for approved ad', async () => {
    const captured: Capture[] = [];
    const client = mockClient([{ rows: [adRow()] }, { rowCount: 1 }, { rowCount: 1 }], captured);
    const result = await forceEndAdAction(client, 'admin-1', 'ad-1');
    expect(result.ok).toBe(true);
    const updateSql = captured[1]?.sql ?? '';
    expect(updateSql).toContain("status = 'expired'");
    expect(updateSql).toContain('ends_at = now()');
  });

  it('rejects ads in non-active status (e.g. expired)', async () => {
    const client = mockClient([{ rows: [adRow({ status: 'expired' })] }], []);
    const result = await forceEndAdAction(client, 'admin-1', 'ad-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_status');
  });

  it('sends DM notification to sponsor for kind=regular but swallows DM errors', async () => {
    const dmSpy = vi.fn(async () => {
      throw new Error('discord 403 cannot dm');
    });
    const rest = {
      createDmChannel: vi.fn(async () => ({ id: 'dm-1' })),
      createMessage: dmSpy,
    } as unknown as DiscordRest;
    const client = mockClient([{ rows: [adRow()] }, { rowCount: 1 }, { rowCount: 1 }], []);
    const result = await forceEndAdAction(client, 'admin-1', 'ad-1', { rest });
    expect(result.ok).toBe(true); // DM failure is non-fatal
    expect(dmSpy).toHaveBeenCalledTimes(1);
  });

  it('skips DM for house/placeholder ads (no sponsor)', async () => {
    const rest = {
      createDmChannel: vi.fn(),
      createMessage: vi.fn(),
    } as unknown as DiscordRest;
    const client = mockClient(
      [{ rows: [adRow({ kind: 'house', sponsor_id: null })] }, { rowCount: 1 }, { rowCount: 1 }],
      [],
    );
    const result = await forceEndAdAction(client, 'admin-1', 'ad-1', { rest });
    expect(result.ok).toBe(true);
    expect(rest.createDmChannel).not.toHaveBeenCalled();
  });

  it('returns reason="race" when the optimistic UPDATE affects 0 rows', async () => {
    // SELECT returns the ad as approved, but UPDATE finds it already moved.
    const client = mockClient([{ rows: [adRow()] }, { rowCount: 0 }], []);
    const result = await forceEndAdAction(client, 'admin-1', 'ad-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('race');
  });
});
