import {
  AD_KIND_VALUES,
  AD_STATUS_VALUES,
  type AdKind,
  type AdStatus,
  type AdminAdRow,
  type AdminListFilters,
  type AdminListResult,
} from '../db/queries/admin-ads.ts';
import { type ActionRowComponent, ButtonStyle, ComponentType } from './types.ts';

export type AdminListState = AdminListFilters & { page: number };

export const ADMIN_LIST_PREFIX = 'adlist:';
export const ADMIN_LIST_PAGE_SIZE = 5;

const KEYS = {
  page: 'p',
  status: 's',
  kind: 'k',
  slot: 'sl',
  sponsorId: 'sp',
} as const;

export function encodeState(state: AdminListState): string {
  const parts: string[] = [`${KEYS.page}=${state.page}`];
  if (state.status) parts.push(`${KEYS.status}=${state.status}`);
  if (state.kind) parts.push(`${KEYS.kind}=${state.kind}`);
  if (state.slot) parts.push(`${KEYS.slot}=${encodeURIComponent(state.slot)}`);
  if (state.sponsorId) parts.push(`${KEYS.sponsorId}=${state.sponsorId}`);
  return parts.join('&');
}

export function decodeState(encoded: string): AdminListState {
  const state: AdminListState = { page: 1 };
  for (const seg of encoded.split('&')) {
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    const k = seg.slice(0, eq);
    const v = seg.slice(eq + 1);
    if (k === KEYS.page) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 1) state.page = Math.floor(n);
    } else if (k === KEYS.status && (AD_STATUS_VALUES as readonly string[]).includes(v)) {
      state.status = v as AdStatus;
    } else if (k === KEYS.kind && (AD_KIND_VALUES as readonly string[]).includes(v)) {
      state.kind = v as AdKind;
    } else if (k === KEYS.slot) {
      state.slot = decodeURIComponent(v);
    } else if (k === KEYS.sponsorId) {
      state.sponsorId = v;
    }
  }
  return state;
}

function fmtDate(d: Date | null): string {
  if (!d) return '—';
  return d.toISOString().slice(0, 10);
}

function adLine(a: AdminAdRow): string {
  const sp = a.sponsorId ? `<@${a.sponsorId}>` : `(${a.kind})`;
  const w = a.weightSnapshot !== null ? `w=${a.weightSnapshot}` : 'w=—';
  return `\`${a.id.slice(0, 8)}\` [${a.status}] ${a.title} ─ slot:${a.slot} kind:${a.kind} ${w} sp:${sp} created:${fmtDate(a.createdAt)}`;
}

export function buildAdminAdsListEmbed(
  result: AdminListResult,
  state: AdminListState,
): { title: string; description: string; color: number } {
  const filterParts: string[] = [];
  if (state.status) filterParts.push(`status=${state.status}`);
  if (state.kind) filterParts.push(`kind=${state.kind}`);
  if (state.slot) filterParts.push(`slot=${state.slot}`);
  if (state.sponsorId) filterParts.push(`sponsor=<@${state.sponsorId}>`);
  const filterLabel =
    filterParts.length > 0 ? `🔍 ${filterParts.join(' / ')}` : '🔍 (フィルタなし)';
  const desc =
    result.ads.length === 0
      ? `${filterLabel}\n\n該当する広告はありません。`
      : `${filterLabel}\n\n${result.ads.map(adLine).join('\n')}`;
  return {
    title: `📋 全広告一覧 (${result.totalCount} 件 / page ${result.page}/${result.totalPages})`,
    description: desc,
    color: 0x5865f2,
  };
}

function selectMenu(
  customId: string,
  placeholder: string,
  options: Array<{ label: string; value: string; default?: boolean }>,
) {
  return {
    type: 1,
    components: [
      {
        type: ComponentType.STRING_SELECT,
        custom_id: customId,
        placeholder,
        options: options.slice(0, 25),
      },
    ],
  } as unknown as ActionRowComponent;
}

const STATUS_LABELS: Record<AdStatus | 'any', string> = {
  any: '— status: すべて —',
  pending: 'pending',
  approved: 'approved',
  paused: 'paused',
  rejected: 'rejected',
  expired: 'expired',
  withdrawn: 'withdrawn',
};

const KIND_LABELS: Record<AdKind | 'any', string> = {
  any: '— kind: すべて —',
  regular: 'regular',
  house: 'house',
  placeholder: 'placeholder',
};

export function buildAdminAdsListComponents(
  result: AdminListResult,
  state: AdminListState,
  knownSlots: string[],
): ActionRowComponent[] {
  const baseState = (override: Partial<AdminListState>): string =>
    encodeState({ ...state, ...override, page: override.page ?? 1 });

  const statusOptions = (['any', ...AD_STATUS_VALUES] as const).map((v) => ({
    label: STATUS_LABELS[v],
    value: baseState({ status: v === 'any' ? undefined : (v as AdStatus) }),
    default: (state.status ?? 'any') === v,
  }));
  const kindOptions = (['any', ...AD_KIND_VALUES] as const).map((v) => ({
    label: KIND_LABELS[v],
    value: baseState({ kind: v === 'any' ? undefined : (v as AdKind) }),
    default: (state.kind ?? 'any') === v,
  }));
  const slotOptions: Array<{ label: string; value: string; default?: boolean }> = [
    { label: '— slot: すべて —', value: baseState({ slot: undefined }), default: !state.slot },
  ];
  for (const slot of knownSlots.slice(0, 24)) {
    slotOptions.push({
      label: `slot: ${slot}`,
      value: baseState({ slot }),
      default: state.slot === slot,
    });
  }

  const prevPage = Math.max(1, state.page - 1);
  const nextPage = Math.min(result.totalPages, state.page + 1);

  const navRow: ActionRowComponent = {
    type: 1,
    components: [
      {
        type: 2,
        style: ButtonStyle.SECONDARY,
        custom_id: `${ADMIN_LIST_PREFIX}${encodeState({ ...state, page: prevPage })}`,
        label: '⬅ 前へ',
        disabled: state.page <= 1,
      },
      {
        type: 2,
        style: ButtonStyle.SECONDARY,
        custom_id: `${ADMIN_LIST_PREFIX}${encodeState({ ...state, page: nextPage })}`,
        label: '➡ 次へ',
        disabled: state.page >= result.totalPages,
      },
      {
        type: 2,
        style: ButtonStyle.DANGER,
        custom_id: `${ADMIN_LIST_PREFIX}${encodeState({ page: 1 })}`,
        label: '🔄 フィルタ解除',
      },
    ],
  };

  return [
    selectMenu(`${ADMIN_LIST_PREFIX}select`, 'status を変更…', statusOptions),
    selectMenu(`${ADMIN_LIST_PREFIX}select`, 'kind を変更…', kindOptions),
    selectMenu(`${ADMIN_LIST_PREFIX}select`, 'slot を変更…', slotOptions),
    navRow,
  ];
}
