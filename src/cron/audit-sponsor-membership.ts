import type { PgClient } from '../db/client.ts';
import { type DiscordRest, DiscordRestError } from '../discord/rest.ts';

export type AuditResult = {
  sponsorsChecked: number;
  sponsorsLeft: number;
  adsWithdrawn: number;
  errors: number;
};

type MembershipStatus = 'member' | 'left' | 'error';

const DISCORD_ERR_UNKNOWN_MEMBER = 10007;

async function classifyMembership(
  rest: DiscordRest,
  guildId: string,
  userId: string,
): Promise<MembershipStatus> {
  try {
    await rest.getGuildMember(guildId, userId);
    return 'member';
  } catch (err) {
    if (err instanceof DiscordRestError && err.status === 404) {
      // Only treat Discord's explicit "Unknown Member" (10007) as "left".
      // Bare 404 without that code could mean unknown guild / transient
      // routing issue — fall through to 'error' so we retry next run.
      try {
        const body = JSON.parse(err.bodyText);
        if (body?.code === DISCORD_ERR_UNKNOWN_MEMBER) return 'left';
      } catch {
        /* malformed body — be conservative */
      }
    }
    return 'error';
  }
}

/**
 * Daily audit: any sponsor whose ads are still serving (approved / pending /
 * paused) but who is no longer a member of the guild has implicitly cancelled
 * their plan. Mark each of their active ads as `withdrawn` and write a
 * review_logs row so the audit trail shows it was a system action.
 *
 * Conservative: only acts on Discord's explicit Unknown Member (code 10007)
 * response. Transient REST errors are counted but ignored, picked up next run.
 * No DM goes out — the user has left, so a DM channel would fail; admins can
 * see the activity via admin_logs entries.
 */
export async function auditSponsorMembership(
  client: PgClient,
  rest: DiscordRest,
  guildId: string,
): Promise<AuditResult> {
  const sponsorsRes = await client.query<{ sponsor_id: string }>(
    `SELECT DISTINCT sponsor_id
       FROM ads
      WHERE sponsor_id IS NOT NULL
        AND status IN ('approved', 'pending', 'paused')`,
  );

  const result: AuditResult = {
    sponsorsChecked: 0,
    sponsorsLeft: 0,
    adsWithdrawn: 0,
    errors: 0,
  };

  for (const { sponsor_id: sponsorId } of sponsorsRes.rows) {
    result.sponsorsChecked++;
    const status = await classifyMembership(rest, guildId, sponsorId);
    if (status === 'error') {
      result.errors++;
      continue;
    }
    if (status === 'member') continue;

    // Left the guild — withdraw every still-active ad of theirs.
    result.sponsorsLeft++;
    const withdrawn = await client.query<{ id: string }>(
      `UPDATE ads
          SET status = 'withdrawn',
              ends_at = (unixepoch() * 1000)
        WHERE sponsor_id = ?
          AND status IN ('approved', 'pending', 'paused')
       RETURNING id`,
      [sponsorId],
    );

    for (const { id } of withdrawn.rows) {
      await client.query(
        `INSERT INTO review_logs (ad_id, reviewer_id, action, reason)
           VALUES (?, 'system', 'withdrawn', 'sponsor left guild (auto-withdraw)')`,
        [id],
      );
      result.adsWithdrawn++;
    }

    if (withdrawn.rows.length > 0) {
      await client.query(
        `INSERT INTO admin_logs (actor_id, action, target_kind, target_id, after)
           VALUES ('system', 'auto_withdraw_on_leave', 'sponsor', ?, ?)`,
        [sponsorId, JSON.stringify({ ad_ids: withdrawn.rows.map((r) => r.id) })],
      );
    }
  }

  return result;
}
