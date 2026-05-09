import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import {
  insertReviewLog,
  setAdReviewMessageId,
  updateAdStatusOptimistic,
} from '../../../src/db/queries/review.ts';

type CapturedCall = { sql: string; params: unknown[] | undefined };

function mockClient(rowCount: number, captured: CapturedCall[] = []): PgClient {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return { rows: [], rowCount };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

function first(captured: CapturedCall[]): CapturedCall {
  const c = captured[0];
  if (!c) throw new Error('expected at least one captured query');
  return c;
}

describe('updateAdStatusOptimistic', () => {
  it('builds SQL with status only when patch contains only status', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(1, captured);
    const result = await updateAdStatusOptimistic(client, 'ad-1', 'pending', {
      status: 'approved',
    });
    expect(result).toEqual({ ok: true, rowsAffected: 1 });
    expect(captured).toHaveLength(1);
    expect(first(captured).sql).toBe('UPDATE ads SET status = $3 WHERE id = $1 AND status = $2');
    expect(first(captured).params).toEqual(['ad-1', 'pending', 'approved']);
  });

  it('builds SQL with reject_reason + reviewed_by + status (and reviewed_at = now())', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(1, captured);
    await updateAdStatusOptimistic(client, 'ad-1', 'pending', {
      status: 'rejected',
      rejectReason: 'spam',
      reviewedBy: 'reviewer-1',
    });
    const sql = first(captured).sql;
    expect(sql).toContain('status = $3');
    expect(sql).toContain('reject_reason = $4');
    expect(sql).toContain('reviewed_by = $5');
    expect(sql).toContain('reviewed_at = now()');
    expect(sql).toContain('WHERE id = $1 AND status = $2');
    expect(first(captured).params).toEqual(['ad-1', 'pending', 'rejected', 'spam', 'reviewer-1']);
  });

  it('uses starts_at = now() literal when patch.startsAt === "now"', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(1, captured);
    await updateAdStatusOptimistic(client, 'ad-1', 'pending', {
      status: 'approved',
      reviewedBy: 'reviewer-1',
      startsAt: 'now',
      weightSnapshot: 10,
    });
    const sql = first(captured).sql;
    expect(sql).toContain('starts_at = now()');
    // starts_at literal should not consume a parameter slot — weight_snapshot follows reviewed_by ($4)
    expect(sql).toContain('weight_snapshot = $5');
    expect(first(captured).params).toEqual(['ad-1', 'pending', 'approved', 'reviewer-1', 10]);
  });

  it('returns { ok: false, reason: "race" } when rowCount is 0', async () => {
    const client = mockClient(0);
    const result = await updateAdStatusOptimistic(client, 'ad-1', 'pending', {
      status: 'approved',
    });
    expect(result).toEqual({ ok: false, reason: 'race' });
  });

  it('returns ok when rowCount is 1', async () => {
    const client = mockClient(1);
    const result = await updateAdStatusOptimistic(client, 'ad-1', 'pending', {
      status: 'approved',
    });
    expect(result).toEqual({ ok: true, rowsAffected: 1 });
  });

  it('passes Date for non-"now" startsAt', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(1, captured);
    const startDate = new Date('2026-01-01T00:00:00Z');
    await updateAdStatusOptimistic(client, 'ad-1', 'pending', {
      status: 'approved',
      startsAt: startDate,
    });
    const sql = first(captured).sql;
    expect(sql).toContain('starts_at = $4');
    expect(first(captured).params).toEqual(['ad-1', 'pending', 'approved', startDate]);
  });

  it('handles null rejectReason explicitly (Object.hasOwn keeps the column in SET)', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(1, captured);
    await updateAdStatusOptimistic(client, 'ad-1', 'rejected', {
      status: 'approved',
      rejectReason: null,
    });
    const sql = first(captured).sql;
    expect(sql).toContain('reject_reason = $4');
    expect(first(captured).params).toEqual(['ad-1', 'rejected', 'approved', null]);
  });
});

describe('insertReviewLog', () => {
  it('inserts a log with the provided reason', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(1, captured);
    await insertReviewLog(client, 'ad-1', 'reviewer-1', 'approved', 'looks good');
    expect(captured).toHaveLength(1);
    expect(first(captured).sql).toContain('INSERT INTO review_logs');
    expect(first(captured).params).toEqual(['ad-1', 'reviewer-1', 'approved', 'looks good']);
  });

  it('inserts a log with null when reason is omitted', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(1, captured);
    await insertReviewLog(client, 'ad-1', 'reviewer-1', 'approved');
    expect(first(captured).params).toEqual(['ad-1', 'reviewer-1', 'approved', null]);
  });

  it('inserts a log with null when reason is explicitly null', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(1, captured);
    await insertReviewLog(client, 'ad-1', 'reviewer-1', 'rejected', null);
    expect(first(captured).params).toEqual(['ad-1', 'reviewer-1', 'rejected', null]);
  });
});

describe('setAdReviewMessageId', () => {
  it('issues an UPDATE setting review_message_id', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(1, captured);
    await setAdReviewMessageId(client, 'ad-1', 'msg-42');
    expect(captured).toHaveLength(1);
    expect(first(captured).sql).toContain('UPDATE ads SET review_message_id = $1 WHERE id = $2');
    expect(first(captured).params).toEqual(['msg-42', 'ad-1']);
  });
});
