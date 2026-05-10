import { type ActionRowComponent, ButtonStyle } from './types.ts';

type InteractiveButtonStyle =
  | typeof ButtonStyle.PRIMARY
  | typeof ButtonStyle.SECONDARY
  | typeof ButtonStyle.SUCCESS
  | typeof ButtonStyle.DANGER;

export const AdminButtonIds = {
  ADS_LIST: 'adm:ads:list',
  ADS_PAUSE: 'adm:ads:pause',
  ADS_RESUME: 'adm:ads:resume',
  ADS_END: 'adm:ads:end',
  ADS_EDIT: 'adm:ads:edit',
  ADS_ADMIN_SUBMIT: 'adm:ads:admin-submit',
  SETTINGS_RULES: 'adm:settings:rules',
  SETTINGS_TIERS: 'adm:settings:tiers',
  SETTINGS_HOUSE: 'adm:settings:house',
  SETTINGS_PLACEHOLDER: 'adm:settings:placeholder',
  STATS_OVERVIEW: 'adm:stats:overview',
  STATS_PERIOD: 'adm:stats:period',
  STATS_CSV: 'adm:stats:csv',
  SYSTEM_REPOST: 'adm:system:repost',
  SYSTEM_ROTATE_SALT: 'adm:system:rotate-salt',
  SYSTEM_HEALTH: 'adm:system:health',
} as const;

export type AdminButtonId = (typeof AdminButtonIds)[keyof typeof AdminButtonIds];

const ADMIN_BUTTON_LABELS: Record<AdminButtonId, string> = {
  [AdminButtonIds.ADS_LIST]: '📋 全広告一覧',
  [AdminButtonIds.ADS_PAUSE]: '⏸ 一時停止',
  [AdminButtonIds.ADS_RESUME]: '▶ 再開',
  [AdminButtonIds.ADS_END]: '⏹ 強制終了',
  [AdminButtonIds.ADS_EDIT]: '✏ 編集',
  [AdminButtonIds.ADS_ADMIN_SUBMIT]: '➕ 管理者として起稿',
  [AdminButtonIds.SETTINGS_RULES]: '📐 入稿ルール',
  [AdminButtonIds.SETTINGS_TIERS]: '🏷 ティア管理',
  [AdminButtonIds.SETTINGS_HOUSE]: '🏠 ハウス広告',
  [AdminButtonIds.SETTINGS_PLACEHOLDER]: '🧱 プレースホルダー',
  [AdminButtonIds.STATS_OVERVIEW]: '📊 全体統計',
  [AdminButtonIds.STATS_PERIOD]: '📈 期間別レポート',
  [AdminButtonIds.STATS_CSV]: '📤 CSV出力',
  [AdminButtonIds.SYSTEM_REPOST]: '🔄 メニュー再投稿',
  [AdminButtonIds.SYSTEM_ROTATE_SALT]: '🔁 ソルト即時ローテ',
  [AdminButtonIds.SYSTEM_HEALTH]: '❤ ヘルスチェック',
};

export type AdminMenuMessage = {
  embeds: Array<{ title: string; description: string; color?: number }>;
  components: ActionRowComponent[];
};

export function buildAdminMenuMessage(): AdminMenuMessage {
  const row = (ids: AdminButtonId[], style: InteractiveButtonStyle): ActionRowComponent => ({
    type: 1,
    components: ids.map((id) => ({
      type: 2,
      style,
      custom_id: id,
      label: ADMIN_BUTTON_LABELS[id],
    })),
  });

  return {
    embeds: [
      {
        title: '🛠 広告管理コンソール',
        description:
          '管理者操作のエントリポイントです。\n各ボタンの動作は段階的に実装されます（本バージョンでは統計カウント表示は後続で実装）。',
        color: 0x5865f2,
      },
    ],
    components: [
      row(
        [
          AdminButtonIds.ADS_LIST,
          AdminButtonIds.ADS_PAUSE,
          AdminButtonIds.ADS_RESUME,
          AdminButtonIds.ADS_END,
          AdminButtonIds.ADS_EDIT,
        ],
        ButtonStyle.SECONDARY,
      ),
      row(
        [
          AdminButtonIds.ADS_ADMIN_SUBMIT,
          AdminButtonIds.SETTINGS_RULES,
          AdminButtonIds.SETTINGS_TIERS,
          AdminButtonIds.SETTINGS_HOUSE,
          AdminButtonIds.SETTINGS_PLACEHOLDER,
        ],
        ButtonStyle.PRIMARY,
      ),
      row(
        [AdminButtonIds.STATS_OVERVIEW, AdminButtonIds.STATS_PERIOD, AdminButtonIds.STATS_CSV],
        ButtonStyle.SECONDARY,
      ),
      row(
        [
          AdminButtonIds.SYSTEM_REPOST,
          AdminButtonIds.SYSTEM_ROTATE_SALT,
          AdminButtonIds.SYSTEM_HEALTH,
        ],
        ButtonStyle.DANGER,
      ),
    ],
  };
}

export function adminButtonLabel(id: AdminButtonId | string): string {
  return ADMIN_BUTTON_LABELS[id as AdminButtonId] ?? id;
}
