import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../src/db/client.ts';
import { fetchFormatRules } from '../../src/validation/rules.ts';

type CapturedCall = { sql: string; params: unknown[] | undefined };

function mockClient(rows: unknown[], captured: CapturedCall[] = []): PgClient {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return { rows };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

describe('fetchFormatRules', () => {
  it('issues the expected SQL with the slot parameter', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        {
          slot: 'default',
          allowedMimes: ['image/png'],
          allowedExtensions: ['png'],
          maxBytes: 1000,
          minWidth: null,
          maxWidth: null,
          minHeight: null,
          maxHeight: null,
          aspectRatios: null,
          aspectTolerance: 0.02,
          titleMaxLen: 80,
          bodyMaxLen: 500,
          linkUrlMaxLen: 2048,
          linkScheme: ['https'],
          linkDomainAllowlist: null,
          linkDomainBlocklist: null,
        },
      ],
      captured,
    );

    const rules = await fetchFormatRules(client, 'default');
    expect(rules?.slot).toBe('default');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sql).toMatch(/FROM ad_format_rules/);
    expect(captured[0]?.sql).toMatch(/WHERE slot = \$1/);
    expect(captured[0]?.params).toEqual(['default']);
  });

  it('returns null when no row matches', async () => {
    const client = mockClient([]);
    const rules = await fetchFormatRules(client, 'unknown');
    expect(rules).toBeNull();
  });
});
