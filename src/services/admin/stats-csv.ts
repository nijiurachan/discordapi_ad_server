import type { AdminStatsRow } from '../../db/queries/admin-stats.ts';

function escapeCell(value: string | number): string {
  const raw = String(value);
  // Neutralize CSV/spreadsheet formula injection: prefix with single quote when
  // the cell starts with a formula trigger char (=, +, -, @, tab, CR).
  const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function rowsToCsv(rows: AdminStatsRow[]): string {
  const header = [
    'ad_id',
    'sponsor_id',
    'kind',
    'slot',
    'title',
    'impressions',
    'clicks',
    'ctr',
  ].join(',');
  const body = rows.map((r) =>
    [r.adId, r.sponsorId ?? '', r.kind, r.slot, r.title, r.impressions, r.clicks, r.ctr.toFixed(4)]
      .map(escapeCell)
      .join(','),
  );
  return [header, ...body].join('\n');
}
