const STATUS_LABEL: Record<string, string> = {
  pending: '⏳ 審査待ち',
  approved: '✅ 配信中',
  paused: '⏸ 一時停止',
  rejected: '❌ 却下',
  expired: '🕒 期限切れ',
  withdrawn: '↩ 取り下げ',
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`;
}

export function formatJpDate(d: Date | null): string {
  if (!d) return '—';
  return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}
