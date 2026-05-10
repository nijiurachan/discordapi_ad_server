import { describe, expect, it } from 'vitest';
import type { AdminAdRow, AdminListResult } from '../../src/db/queries/admin-ads.ts';
import {
  ADMIN_LIST_PREFIX,
  buildAdminAdsListComponents,
  buildAdminAdsListEmbed,
  decodeState,
  encodeState,
} from '../../src/discord/admin-ads-list.ts';

const sampleAd: AdminAdRow = {
  id: '11111111-2222-3333-4444-555555555555',
  sponsorId: 'sponsor-1',
  kind: 'regular',
  slot: 'default',
  title: 'Sample',
  status: 'approved',
  weightSnapshot: 10,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  startsAt: null,
  endsAt: null,
};

const emptyResult: AdminListResult = {
  ads: [],
  totalCount: 0,
  page: 1,
  pageSize: 5,
  totalPages: 1,
};

describe('encodeState/decodeState', () => {
  it('round-trips empty state', () => {
    expect(decodeState(encodeState({ page: 1 }))).toEqual({ page: 1 });
  });

  it('round-trips full state', () => {
    const s = {
      page: 3,
      status: 'approved' as const,
      kind: 'regular' as const,
      slot: 'default',
      sponsorId: 'user-9',
    };
    expect(decodeState(encodeState(s))).toEqual(s);
  });

  it('rejects unknown values silently (no injection)', () => {
    const decoded = decodeState('p=1&s=evil&k=bogus&sl=ok');
    expect(decoded.status).toBeUndefined();
    expect(decoded.kind).toBeUndefined();
    expect(decoded.slot).toBe('ok');
  });
});

describe('buildAdminAdsListEmbed', () => {
  it('shows "no results" when ads list is empty', () => {
    const embed = buildAdminAdsListEmbed(emptyResult, { page: 1 });
    expect(embed.description).toContain('該当する広告はありません');
  });

  it('renders ad title and id prefix when results exist', () => {
    const result: AdminListResult = {
      ads: [sampleAd],
      totalCount: 1,
      page: 1,
      pageSize: 5,
      totalPages: 1,
    };
    const embed = buildAdminAdsListEmbed(result, { page: 1 });
    expect(embed.description).toContain('Sample');
    expect(embed.description).toContain(sampleAd.id.slice(0, 8));
  });
});

describe('buildAdminAdsListComponents', () => {
  it('produces 4 action rows (3 selects + nav row)', () => {
    const comps = buildAdminAdsListComponents(emptyResult, { page: 1 }, ['default']);
    expect(comps).toHaveLength(4);
  });

  it('disables prev button on page 1 and next button on last page', () => {
    const result: AdminListResult = { ...emptyResult, totalCount: 3, totalPages: 1 };
    const comps = buildAdminAdsListComponents(result, { page: 1 }, []);
    const navRow = comps[comps.length - 1];
    if (!navRow) throw new Error('nav row missing');
    const prev = navRow.components[0];
    const next = navRow.components[1];
    expect(prev?.disabled).toBe(true);
    expect(next?.disabled).toBe(true);
  });

  it('all select option values can be decoded back to a state object', () => {
    const comps = buildAdminAdsListComponents(emptyResult, { page: 1 }, ['default']);
    for (const row of comps.slice(0, 3)) {
      const select = row.components[0] as unknown as {
        options?: Array<{ value: string }>;
      };
      for (const opt of select.options ?? []) {
        expect(() => decodeState(opt.value)).not.toThrow();
      }
    }
  });

  it('nav button custom_ids carry the ADMIN_LIST_PREFIX', () => {
    const result: AdminListResult = { ...emptyResult, totalCount: 30, totalPages: 6 };
    const comps = buildAdminAdsListComponents(result, { page: 3 }, []);
    const navRow = comps[comps.length - 1];
    if (!navRow) throw new Error('nav row missing');
    for (const btn of navRow.components) {
      const cid = 'custom_id' in btn ? btn.custom_id : '';
      expect(cid.startsWith(ADMIN_LIST_PREFIX)).toBe(true);
    }
  });
});
