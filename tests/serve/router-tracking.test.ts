import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../src/db/client.ts';
import type { Bindings } from '../../src/env.ts';
import type { ServedAd } from '../../src/serve/pick.ts';

// vi.hoisted is required because vi.mock calls are hoisted above all imports.
// We need the mock fns to be initialized before vi.mock factories run.
const { queryMock, isRecentEventMock, insertAdEventMock, getDailySaltMock } = vi.hoisted(() => {
  return {
    queryMock:
      vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>>(),
    isRecentEventMock:
      vi.fn<
        (
          client: PgClient,
          adId: string,
          ipHash: string,
          eventType: 'impression' | 'click',
          windowMs?: number,
        ) => Promise<boolean>
      >(),
    insertAdEventMock:
      vi.fn<
        (
          client: PgClient,
          args: {
            adId: string;
            eventType: 'impression' | 'click';
            ipHash: string | null;
            ua: string | null;
            slot: string | null;
          },
        ) => Promise<void>
      >(),
    getDailySaltMock: vi.fn<(client: PgClient, fallback: string) => Promise<string>>(),
  };
});

vi.mock('../../src/db/client.ts', () => ({
  withPgClient: vi.fn(async (_url: string, fn: (client: PgClient) => Promise<unknown>) => {
    return fn({
      query: queryMock,
      end: vi.fn(async () => {}),
    } as unknown as PgClient);
  }),
}));

vi.mock('../../src/db/queries/ad-events.ts', () => ({
  isRecentEvent: isRecentEventMock,
  insertAdEvent: insertAdEventMock,
}));

vi.mock('../../src/utils/salt.ts', () => ({
  getDailySalt: getDailySaltMock,
}));

import { trackImpressions } from '../../src/serve/router.ts';

function makeAd(overrides: Partial<ServedAd> = {}): ServedAd {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    kind: 'regular',
    title: 't',
    body: 'b',
    linkUrl: 'https://example.com/landing',
    imageKey: null,
    ...overrides,
  };
}

function makeEnv(): Bindings {
  return {
    POSTGRES_URL: 'postgres://test',
    IP_HASH_SALT_BOOTSTRAP: 'bootstrap',
  } as unknown as Bindings;
}

describe('trackImpressions', () => {
  beforeEach(() => {
    queryMock.mockReset();
    isRecentEventMock.mockReset();
    isRecentEventMock.mockResolvedValue(false);
    insertAdEventMock.mockReset();
    insertAdEventMock.mockResolvedValue(undefined);
    getDailySaltMock.mockReset();
    getDailySaltMock.mockResolvedValue('test-salt');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('inserts one impression per non-placeholder ad', async () => {
    const ads = [
      makeAd({ id: '00000000-0000-0000-0000-000000000001' }),
      makeAd({ id: '00000000-0000-0000-0000-000000000002', kind: 'house' }),
    ];
    await trackImpressions(makeEnv(), ads, 'default', '1.2.3.4', 'Mozilla/5.0');
    expect(insertAdEventMock).toHaveBeenCalledTimes(2);
    const calls = insertAdEventMock.mock.calls;
    expect(calls[0]?.[1]).toMatchObject({
      adId: '00000000-0000-0000-0000-000000000001',
      eventType: 'impression',
      slot: 'default',
      ua: 'Mozilla/5.0',
    });
    expect(calls[1]?.[1]).toMatchObject({
      adId: '00000000-0000-0000-0000-000000000002',
      eventType: 'impression',
    });
  });

  it('skips placeholder ads', async () => {
    const ads = [makeAd({ id: '00000000-0000-0000-0000-000000000003', kind: 'placeholder' })];
    await trackImpressions(makeEnv(), ads, 'default', '1.2.3.4', 'ua');
    expect(insertAdEventMock).not.toHaveBeenCalled();
  });

  it('skips DB work entirely if all ads are placeholders', async () => {
    const ads = [makeAd({ kind: 'placeholder' })];
    await trackImpressions(makeEnv(), ads, 'default', '1.2.3.4', null);
    expect(getDailySaltMock).not.toHaveBeenCalled();
    expect(isRecentEventMock).not.toHaveBeenCalled();
    expect(insertAdEventMock).not.toHaveBeenCalled();
  });

  it('skips INSERT when isRecentEvent returns true (dedup)', async () => {
    isRecentEventMock.mockResolvedValueOnce(true);
    const ads = [makeAd()];
    await trackImpressions(makeEnv(), ads, 'default', '1.2.3.4', 'ua');
    expect(isRecentEventMock).toHaveBeenCalledTimes(1);
    expect(insertAdEventMock).not.toHaveBeenCalled();
  });

  it('swallows errors and does not throw', async () => {
    insertAdEventMock.mockRejectedValueOnce(new Error('boom'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ads = [makeAd()];
    await expect(
      trackImpressions(makeEnv(), ads, 'default', '1.2.3.4', 'ua'),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('records nothing when ads array is empty', async () => {
    await trackImpressions(makeEnv(), [], 'default', '1.2.3.4', 'ua');
    expect(insertAdEventMock).not.toHaveBeenCalled();
  });
});
