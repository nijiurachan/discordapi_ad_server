import { describe, expect, it } from 'vitest';
import type { AdminAdRow, AdminListResult } from '../../src/db/queries/admin-ads.ts';
import { buildAdminAdsListEmbed } from '../../src/discord/admin-ads-list.ts';
import type { SponsorBudget } from '../../src/sponsors/tier.ts';

function row(overrides: Partial<AdminAdRow> = {}): AdminAdRow {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    sponsorId: 'sponsor-1',
    kind: 'regular',
    slot: 'default',
    title: 'Sample',
    status: 'approved',
    weightSnapshot: 10,
    weightAlloc: 20,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    startsAt: null,
    endsAt: null,
    ...overrides,
  };
}

const result = (ads: AdminAdRow[]): AdminListResult => ({
  ads,
  totalCount: ads.length,
  page: 1,
  pageSize: 5,
  totalPages: 1,
});

describe('buildAdminAdsListEmbed budget display', () => {
  it('shows alloc= per regular row', () => {
    const embed = buildAdminAdsListEmbed(result([row({ weightAlloc: 20 })]), { page: 1 });
    expect(embed.description).toContain('alloc=20');
  });

  it('omits alloc= when weightAlloc is null (admin/house ads)', () => {
    const embed = buildAdminAdsListEmbed(
      result([row({ weightAlloc: null, kind: 'house', sponsorId: null })]),
      { page: 1 },
    );
    expect(embed.description).not.toContain('alloc=');
  });

  it('renders a budget summary line when a sponsor budget is supplied', () => {
    const budget: SponsorBudget = { tierWeight: 80, used: 30, remaining: 50 };
    const embed = buildAdminAdsListEmbed(
      result([row()]),
      { page: 1, sponsorId: 'sponsor-1' },
      budget,
    );
    expect(embed.description).toContain('予算');
    expect(embed.description).toContain('80'); // tierWeight
    expect(embed.description).toContain('30'); // used
    expect(embed.description).toContain('50'); // remaining
  });

  it('renders no budget line when no budget is supplied (unfiltered list)', () => {
    const embed = buildAdminAdsListEmbed(result([row()]), { page: 1 });
    expect(embed.description).not.toContain('残予算');
  });
});
