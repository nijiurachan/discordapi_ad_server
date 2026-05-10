import type { S3Client } from '@aws-sdk/client-s3';
import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import { type StatsPeriod, getTopAdsStats } from '../../db/queries/admin-stats.ts';
import { isAdmin } from '../../discord/admin-auth.ts';
import type { ApplicationCommandInteractionPayload, CommandOption } from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { rowsToCsv } from '../../services/admin/stats-csv.ts';
import { presignGetUrl } from '../../storage/s3-presign.ts';
import { createS3Client, putObject } from '../../storage/s3.ts';
import { ephemeral } from '../responses.ts';

const VALID_PERIODS: ReadonlySet<StatsPeriod> = new Set(['24h', '7d', '30d', '90d', 'all']);

export type AdminStatsDeps = {
  client: PgClient;
  s3: S3Client;
  bucket: string;
  adminRoleId: string;
  uuid?: () => string;
};

function findSubcommand(
  opts: CommandOption[] | undefined,
  name: string,
): CommandOption | undefined {
  return opts?.find((o) => o.name === name && (o.type === 1 || o.type === 2));
}
function findOption(opts: CommandOption[] | undefined, name: string): CommandOption | undefined {
  return opts?.find((o) => o.name === name);
}

export async function runAdminStats(
  c: Context<{ Bindings: Bindings }>,
  payload: ApplicationCommandInteractionPayload,
  deps: AdminStatsDeps,
): Promise<Response> {
  if (!isAdmin(payload, deps.adminRoleId)) {
    return ephemeral(c, '⚠ この操作には管理者ロールが必要です。');
  }
  const sub = findSubcommand(payload.data.options, 'stats');
  if (!sub) return ephemeral(c, '不明なサブコマンドです');
  const periodRaw = (findOption(sub.options, 'period')?.value ?? '7d') as string;
  const period = (VALID_PERIODS.has(periodRaw as StatsPeriod) ? periodRaw : '7d') as StatsPeriod;
  const limitRaw = findOption(sub.options, 'top_n')?.value;
  const limit = typeof limitRaw === 'number' ? Math.max(1, Math.min(1000, limitRaw)) : 50;
  const csvOpt = findOption(sub.options, 'csv')?.value;
  const wantCsv = typeof csvOpt === 'boolean' ? csvOpt : false;

  const rows = await getTopAdsStats(deps.client, period, limit);

  if (!wantCsv) {
    if (rows.length === 0) return ephemeral(c, `期間 \`${period}\` の対象データはありません。`);
    const lines = rows
      .slice(0, 10)
      .map(
        (r, i) =>
          `${i + 1}. \`${r.adId.slice(0, 8)}\` ${r.title} — imp:${r.impressions} clk:${r.clicks} ctr:${(r.ctr * 100).toFixed(2)}%`,
      );
    return ephemeral(
      c,
      `📊 期間: ${period} / Top ${Math.min(10, rows.length)} (合計 ${rows.length} 件)\n${lines.join('\n')}`,
    );
  }

  const csv = rowsToCsv(rows);
  const id = (deps.uuid ?? (() => crypto.randomUUID()))().slice(0, 8);
  const key = `reports/stats-${period}-${id}.csv`;
  try {
    await putObject(deps.s3, deps.bucket, key, csv, 'text/csv');
  } catch (err) {
    console.error('admin-stats: putObject failed', err);
    return ephemeral(c, 'CSV のアップロードに失敗しました。');
  }
  let url: string;
  try {
    url = await presignGetUrl(deps.s3, deps.bucket, key, 600);
  } catch (err) {
    console.error('admin-stats: presign failed', err);
    return ephemeral(c, 'CSV の URL 生成に失敗しました。');
  }
  return ephemeral(
    c,
    `📤 CSV (期間: ${period}, ${rows.length} 行) — 10 分間有効な署名付き URL:\n${url}`,
  );
}

export async function handleAdminStats(
  c: Context<{ Bindings: Bindings }>,
  payload: ApplicationCommandInteractionPayload,
): Promise<Response> {
  const s3 = createS3Client({
    endpoint: c.env.S3_ENDPOINT,
    region: c.env.S3_REGION,
    accessKeyId: c.env.S3_ACCESS_KEY_ID,
    secretAccessKey: c.env.S3_SECRET_ACCESS_KEY,
  });
  return withPgClient(c.env.POSTGRES_URL, (client) =>
    runAdminStats(c, payload, {
      client,
      s3,
      bucket: c.env.S3_BUCKET,
      adminRoleId: c.env.ADMIN_ROLE_ID,
    }),
  );
}
