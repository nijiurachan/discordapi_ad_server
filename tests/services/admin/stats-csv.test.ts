import { describe, expect, it } from 'vitest';
import type { AdminStatsRow } from '../../../src/db/queries/admin-stats.ts';
import { rowsToCsv } from '../../../src/services/admin/stats-csv.ts';

const baseRow: AdminStatsRow = {
  adId: 'ad-1',
  sponsorId: 'sponsor-1',
  kind: 'regular',
  slot: 'default',
  title: 'Hello',
  impressions: 100,
  clicks: 5,
  ctr: 0.05,
};

describe('rowsToCsv', () => {
  it('emits a header row even when data is empty', () => {
    const csv = rowsToCsv([]);
    expect(csv.split('\n')).toEqual(['ad_id,sponsor_id,kind,slot,title,impressions,clicks,ctr']);
  });

  it('formats CTR to 4 decimals', () => {
    const csv = rowsToCsv([baseRow]);
    const lastLine = csv.split('\n').at(-1) ?? '';
    expect(lastLine.endsWith('0.0500')).toBe(true);
  });

  it('escapes commas, quotes and newlines in title', () => {
    const csv = rowsToCsv([{ ...baseRow, title: 'Hello, "world"\nbye' }]);
    expect(csv).toContain('"Hello, ""world""\nbye"');
  });

  it('uses an empty cell for missing sponsor_id (house/placeholder)', () => {
    const csv = rowsToCsv([{ ...baseRow, sponsorId: null }]);
    const dataLine = csv.split('\n').at(-1) ?? '';
    // ad-1,,regular,...  ← second column empty
    expect(dataLine.startsWith('ad-1,,regular,')).toBe(true);
  });
});
