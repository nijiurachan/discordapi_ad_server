import type { PgClient } from '../db/client.ts';
import { SystemSettingKey } from '../db/settings.ts';
import type { DiscordRest } from '../discord/rest.ts';

export type HealthSummaryStats = {
  activeAds: number;
  pendingFallbacks: number;
  lastSaltRotation: Date | null;
};

const EMBED_COLOR = 0x5865f2;

/**
 * Daily health summary: count active ads, pending DM fallback channels, and
 * the last salt rotation timestamp; post as an embed to ADMIN_CHANNEL_ID.
 *
 * "Active" matches the serve query: status=approved AND the time window is
 * open. "Pending" fallback channels are unacknowledged regardless of expiry
 * (DC1 of issue #38). Salt timestamp comes from system_settings.updated_at
 * for the ip_hash_salt row (DC2) — the rotation cron writes that column
 * every time it runs.
 */
export async function collectHealthStats(client: PgClient): Promise<HealthSummaryStats> {
  const [activeAdsRes, pendingRes, saltRes] = await Promise.all([
    client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM ads
        WHERE status = 'approved'
          AND (starts_at IS NULL OR starts_at <= now())
          AND (ends_at   IS NULL OR ends_at   >  now())`,
    ),
    client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM dm_fallback_channels
        WHERE acknowledged_at IS NULL`,
    ),
    client.query<{ updated_at: Date | string | null }>(
      'SELECT updated_at FROM system_settings WHERE key = $1 LIMIT 1',
      [SystemSettingKey.IP_HASH_SALT],
    ),
  ]);
  const raw = saltRes.rows[0]?.updated_at ?? null;
  const lastSaltRotation = raw instanceof Date ? raw : raw ? new Date(raw) : null;
  return {
    activeAds: Number(activeAdsRes.rows[0]?.count ?? '0'),
    pendingFallbacks: Number(pendingRes.rows[0]?.count ?? '0'),
    lastSaltRotation,
  };
}

export function buildHealthSummaryEmbed(stats: HealthSummaryStats): {
  embeds: Array<{
    title: string;
    color: number;
    fields: Array<{ name: string; value: string; inline?: boolean }>;
    timestamp: string;
  }>;
} {
  const saltValue =
    stats.lastSaltRotation === null ? 'unknown' : stats.lastSaltRotation.toISOString();
  return {
    embeds: [
      {
        title: '📈 System Health Summary',
        color: EMBED_COLOR,
        fields: [
          { name: 'Active ads', value: String(stats.activeAds), inline: true },
          { name: 'Pending DM fallbacks', value: String(stats.pendingFallbacks), inline: true },
          { name: 'Last salt rotation', value: saltValue, inline: false },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

export async function postSystemHealthSummary(
  client: PgClient,
  rest: DiscordRest,
  channelId: string,
): Promise<HealthSummaryStats> {
  const stats = await collectHealthStats(client);
  await rest.createMessage(channelId, buildHealthSummaryEmbed(stats));
  return stats;
}
