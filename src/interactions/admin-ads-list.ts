import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../db/client.ts';
import { type AdminListFilters, getDistinctSlots, listAdminAds } from '../db/queries/admin-ads.ts';
import {
  ADMIN_LIST_PAGE_SIZE,
  ADMIN_LIST_PREFIX,
  type AdminListState,
  buildAdminAdsListComponents,
  buildAdminAdsListEmbed,
  decodeState,
} from '../discord/admin-ads-list.ts';
import { isAdmin } from '../discord/admin-auth.ts';
import {
  InteractionResponseType,
  type MessageComponentInteractionPayload,
} from '../discord/types.ts';
import type { Bindings } from '../env.ts';
import { ephemeral } from './responses.ts';

function stateToFilters(state: AdminListState): AdminListFilters {
  return {
    status: state.status,
    kind: state.kind,
    slot: state.slot,
    sponsorId: state.sponsorId,
  };
}

export async function runAdminAdsList(
  c: Context,
  state: AdminListState,
  client: PgClient,
  responseType: number = InteractionResponseType.UPDATE_MESSAGE,
): Promise<Response> {
  const result = await listAdminAds(
    client,
    stateToFilters(state),
    state.page,
    ADMIN_LIST_PAGE_SIZE,
  );
  const slots = await getDistinctSlots(client);
  const embed = buildAdminAdsListEmbed(result, { ...state, page: result.page });
  const components = buildAdminAdsListComponents(result, { ...state, page: result.page }, slots);
  return c.json({
    type: responseType,
    data: { embeds: [embed], components },
  });
}

export async function handleAdminAdsListButton(
  c: Context<{ Bindings: Bindings }>,
  payload: MessageComponentInteractionPayload,
): Promise<Response> {
  if (!isAdmin(payload, c.env.ADMIN_ROLE_ID)) {
    return ephemeral(c, '⚠ この操作には管理者ロールが必要です。');
  }
  const cid = payload.data.custom_id;
  let state: AdminListState;
  if (cid === `${ADMIN_LIST_PREFIX}select`) {
    const value = payload.data.values?.[0];
    state = value ? decodeState(value) : { page: 1 };
  } else if (cid.startsWith(ADMIN_LIST_PREFIX)) {
    state = decodeState(cid.slice(ADMIN_LIST_PREFIX.length));
  } else {
    return ephemeral(c, '不正なリスト操作です。');
  }
  return withPgClient(c.env.POSTGRES_URL, (client) => runAdminAdsList(c, state, client));
}

export async function handleAdminAdsListEntry(
  c: Context<{ Bindings: Bindings }>,
  payload: MessageComponentInteractionPayload,
  initialFilters: Partial<AdminListState> = {},
): Promise<Response> {
  if (!isAdmin(payload, c.env.ADMIN_ROLE_ID)) {
    return ephemeral(c, '⚠ この操作には管理者ロールが必要です。');
  }
  const initial: AdminListState = { page: 1, ...initialFilters };
  return withPgClient(c.env.POSTGRES_URL, (client) =>
    runAdminAdsList(c, initial, client, InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE),
  );
}
