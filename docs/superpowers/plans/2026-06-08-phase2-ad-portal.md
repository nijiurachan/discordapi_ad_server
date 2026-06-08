# Ad Portal UI (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add a per-sponsor private "Ad Portal" channel. A persistent public-channel button (`portal:open`) creates/reuses a sponsor-scoped private channel and renders a live dashboard (plan / remaining weight / cap+used / active banners) with buttons to add (deep-link to `/ad submit`), manage, refresh, and close. Channels are created on demand and idle-deleted by an hourly sweep, with `getChannel`-404 self-heal on reopen. The legacy `/ad submit` menu and `dm_fallback` machinery stay fully intact (coexistence).

**Architecture:** Cloudflare Workers + Hono. Entry button → DEFERRED ephemeral (type 5) ACK within 3s → `c.executionCtx.waitUntil((async () => { await withPgClient(env, async (client) => { ... }) })())` opens a FRESH `withPgClient` INSIDE the waitUntil callback (never reusing the request-scoped client) to do channel create/reuse + dashboard render → webhook followup `PATCH /webhooks/{app_id}/{token}/messages/@original` returns the channel link. Dashboard buttons inside the channel respond with UPDATE_MESSAGE (type 7) to re-render in place. All DB access is raw SQL through the `PgClient` wrapper (`client.query(sql, params)` with `?` placeholders; `BEGIN`/`COMMIT`/`ROLLBACK` are no-ops under D1 but kept for shape parity, matching `dm-fallback-sweep.ts`). New table `portal_channels` modeled on `dm_fallback_channels`, with `UNIQUE(sponsor_id) WHERE archived_at IS NULL` for double-click safety. The dashboard's "remaining weight" consumes the Phase-1 primitive `getSponsorBudget`; until Phase 1 lands, a thin stub keeps Phase 2 independently testable.

**Tech Stack:** TypeScript (ESM, `.ts` import specifiers), Hono, Drizzle schema (raw-SQL queries), Cloudflare D1 (SQLite), vitest (`@cloudflare/vitest-pool-workers`). Test command: `npx vitest run <path>`. Typecheck: `npx tsc --noEmit`.

---

## File Structure

### Create

| Path | Responsibility |
|---|---|
| `migrations/0004_portal_channels.sql` | Hand-written SQL: `CREATE TABLE portal_channels` + `UNIQUE(channel_id)` + partial unique index `portal_active_sponsor_idx ON (sponsor_id) WHERE archived_at IS NULL`. (Phase 1 owns `0003_weight_alloc.sql`; Phase 2 is the next sequence, `0004`.) |
| `src/db/queries/portal.ts` | Portal-row CRUD: `findOpenPortalBySponsor`, `findOpenPortalByChannel` (owner check on `portal:close`), `findPortalById`, `createPortalRow`, `setPortalDashboardMessageId`, `touchPortalActivity`, `closePortalRow`, plus the canonical dashboard read `getSponsorActiveBanners` (`{ id, slot, title, status, weightAlloc }`). |
| `src/sponsors/portal-budget.ts` | **Temporary stub** of `getSponsorBudget` (Phase-1 shared contract: `(client, sponsorId) => { tierWeight, used, remaining } | null`; `used` = SUM(weight_alloc) WHERE `kind='regular' AND created_by_admin IS NULL AND status IN ('pending','approved')`) so Phase 2 is testable standalone. The WHERE must match Phase 1 exactly so `remaining` is unchanged at cutover. Removed once Phase 1 lands (Task 12). |
| `src/services/portal/open.ts` | `openOrReusePortalChannel`: insert-row-first, create channel under `PORTAL_CHANNEL_CATEGORY_ID` with `buildPortalOverwrites`, compensating cleanup on failure; self-heal reused row whose channel 404s. |
| `src/services/portal/render.ts` | `buildPortalDashboard(args)`: pure builder returning `{ embeds, components }` from tier/budget/cap/banners; `renderPortalDashboard(...)`: posts (or edits) the dashboard message and persists `dashboard_message_id`. |
| `src/services/portal/teardown.ts` | `closePortal`: owner-checked atomic archive + 404-tolerant `deleteChannel` (ack-button style). |
| `src/interactions/buttons/portal-open-button.ts` | Handles `portal:open`: returns DEFERRED (type5) immediately, schedules open+followup via `c.executionCtx.waitUntil`. |
| `src/interactions/buttons/portal-dashboard-buttons.ts` | Handles `portal:add` / `portal:manage` / `portal:refresh` / `portal:close` (in-channel dashboard buttons). |
| `src/cron/portal-sweep.ts` | `sweepPortalChannels`: hourly idle-delete of stale `portal_channels` (modeled on `dm-fallback-sweep.ts`). |
| `tests/db/queries/portal.test.ts` | Unit tests for the portal queries (SQL shape + mapping). |
| `tests/sponsors/portal-budget.test.ts` | Unit tests for the `getSponsorBudget` stub. |
| `tests/services/portal/open.test.ts` | Unit tests for `openOrReusePortalChannel` (reuse / create / compensating cleanup / self-heal). |
| `tests/services/portal/render.test.ts` | Unit tests for `buildPortalDashboard` + `renderPortalDashboard`. |
| `tests/services/portal/teardown.test.ts` | Unit tests for `closePortal`. |
| `tests/interactions/buttons/portal-open-button.test.ts` | Tests deferred ACK + followup wiring. |
| `tests/interactions/buttons/portal-dashboard-buttons.test.ts` | Tests dashboard button dispatch. |
| `tests/cron/portal-sweep.test.ts` | Tests the hourly idle sweep. |
| `tests/discord/portal-rest.test.ts` | Tests `editOriginalInteractionResponse` (webhook followup PATCH). |

### Modify

| Path | Change |
|---|---|
| `src/discord/rest.ts` | Add `editOriginalInteractionResponse(appId, token, body)` → `PATCH /webhooks/{appId}/{token}/messages/@original`. |
| `src/interactions/responses.ts` | Add `deferredEphemeral(c)` (type5) and `updateMessage(c, { content?, embeds?, components? })` (type7) helpers. |
| `src/discord/permissions.ts` | Add `buildPortalOverwrites` (deny @everyone, allow sponsor+bot+`REVIEWER_ROLE_ID`+`ADMIN_ROLE_ID`). |
| `src/interactions/router.ts` | Add `portal:` arm to the MESSAGE_COMPONENT switch. |
| `src/interactions/commands/ad-setup.ts` | Extend to post the persistent "広告ポータルを開く" panel (`portal:open`) + persist its message/channel id. |
| `src/db/settings.ts` | Add `PORTAL_PANEL_MESSAGE_ID` / `PORTAL_PANEL_CHANNEL_ID` setting keys. |
| `src/cron/index.ts` | Register `portal-sweep` inside `runHourly`. |
| `src/env.ts` | Add `PORTAL_CHANNEL_CATEGORY_ID` (and confirm existing `REVIEWER_ROLE_ID`/`ADMIN_ROLE_ID`). |
| `vitest.config.ts` | Add `PORTAL_CHANNEL_CATEGORY_ID` to miniflare test bindings. |
| `scripts/register-commands.ts` | Add `portal` to the `ad-setup` `kind` choices. |

---

### Task 1: REST webhook-followup helper (`editOriginalInteractionResponse`)

**Files:**
- Modify: `src/discord/rest.ts:54-73` (add method to the returned object), `src/discord/rest.ts:76` (type derives automatically)
- Test: `tests/discord/portal-rest.test.ts` (Create)

- [ ] **Step 1: Write failing test.** Create `tests/discord/portal-rest.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { createDiscordRest } from '../../src/discord/rest.ts';

describe('editOriginalInteractionResponse', () => {
  it('PATCHes /webhooks/{appId}/{token}/messages/@original with bot auth', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ id: 'm1', channel_id: 'c1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const rest = createDiscordRest({ token: 'tkn', fetch: fetchMock });
    const msg = await rest.editOriginalInteractionResponse('app-1', 'tok-1', {
      content: 'done',
    });
    expect(msg.id).toBe('m1');
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error('expected fetch to have been called');
    const [url, init] = firstCall;
    expect(url).toBe('https://discord.com/api/v10/webhooks/app-1/tok-1/messages/@original');
    expect((init as RequestInit).method).toBe('PATCH');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bot tkn' });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ content: 'done' });
  });
});
```
- [ ] **Step 2: Run to confirm FAIL.** `npx vitest run tests/discord/portal-rest.test.ts` — expect failure: `rest.editOriginalInteractionResponse is not a function`.
- [ ] **Step 3: Minimal impl.** In `src/discord/rest.ts`, inside the object returned by `createDiscordRest` (after `getGuildMember`, before the closing `};` at line 73), add:
```ts
    editOriginalInteractionResponse: (appId: string, token: string, body: Json) =>
      request<Message>(
        opts,
        'PATCH',
        `/webhooks/${appId}/${token}/messages/@original`,
        body,
      ),
```
- [ ] **Step 4: Run to confirm PASS.** `npx vitest run tests/discord/portal-rest.test.ts` — expect 1 passed. Then `npx tsc --noEmit` — expect no errors.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(discord): add editOriginalInteractionResponse webhook-followup helper"`

---

### Task 2: Interaction response helpers (DEFERRED type5 + UPDATE_MESSAGE type7)

**Files:**
- Modify: `src/interactions/responses.ts:1-19` (add two helpers; `InteractionResponseType` + `MessageFlags` already exported from `../discord/types.ts`)
- Test: `tests/interactions/responses.test.ts` (Create)

- [ ] **Step 1: Write failing test.** Create `tests/interactions/responses.test.ts`:
```ts
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { deferredEphemeral, updateMessage } from '../../src/interactions/responses.ts';

function ctx() {
  const app = new Hono();
  let captured: unknown;
  app.post('/', (c) => {
    captured = null;
    return c.json({});
  });
  // Build a minimal Context by invoking a handler that returns our helper's Response.
  return { app };
}

describe('deferredEphemeral', () => {
  it('returns type 5 with ephemeral flag', async () => {
    const app = new Hono();
    app.post('/', (c) => deferredEphemeral(c));
    const res = await app.request('/', { method: 'POST' });
    expect(await res.json()).toEqual({ type: 5, data: { flags: 64 } });
  });
});

describe('updateMessage', () => {
  it('returns type 7 with provided content/embeds/components', async () => {
    const app = new Hono();
    app.post('/', (c) =>
      updateMessage(c, { content: 'x', embeds: [{ title: 't' }], components: [] }),
    );
    const res = await app.request('/', { method: 'POST' });
    expect(await res.json()).toEqual({
      type: 7,
      data: { content: 'x', embeds: [{ title: 't' }], components: [] },
    });
  });
});
```
- [ ] **Step 2: Run to confirm FAIL.** `npx vitest run tests/interactions/responses.test.ts` — expect failure: `deferredEphemeral is not a function`.
- [ ] **Step 3: Minimal impl.** In `src/interactions/responses.ts`, import `InteractionResponseType` (already imported) and append after `modalResponse`:
```ts
export function deferredEphemeral(c: Context): Response {
  return c.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: EPHEMERAL_FLAG },
  });
}

export function updateMessage(
  c: Context,
  data: {
    content?: string;
    embeds?: Record<string, unknown>[];
    components?: Record<string, unknown>[];
  },
): Response {
  return c.json({
    type: InteractionResponseType.UPDATE_MESSAGE,
    data,
  });
}
```
- [ ] **Step 4: Run to confirm PASS.** `npx vitest run tests/interactions/responses.test.ts` — expect 2 passed. `npx tsc --noEmit` — no errors.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(interactions): add deferredEphemeral(type5) and updateMessage(type7) helpers"`

---

### Task 3: `buildPortalOverwrites` (staff-visible private ACL)

**Files:**
- Modify: `src/discord/permissions.ts:21-38` (add builder; reuse `PERM_DENY_EVERYONE`/`PERM_ALLOW_SPONSOR`/`PERM_ALLOW_BOT`)
- Test: `tests/discord/permissions.test.ts` (Modify — append a describe block)

- [ ] **Step 1: Write failing test.** Append to `tests/discord/permissions.test.ts`:
```ts
import { buildPortalOverwrites } from '../../src/discord/permissions.ts';

describe('buildPortalOverwrites', () => {
  it('denies @everyone and allows sponsor, bot, reviewer role, admin role', () => {
    const ow = buildPortalOverwrites({
      guildId: 'g',
      sponsorId: 's',
      botId: 'b',
      reviewerRoleId: 'rev',
      adminRoleId: 'adm',
    });
    expect(ow).toEqual([
      { id: 'g', type: 0, deny: '1024' },
      { id: 's', type: 1, allow: '66560' },
      { id: 'b', type: 1, allow: '76800' },
      { id: 'rev', type: 0, allow: '66560' },
      { id: 'adm', type: 0, allow: '66560' },
    ]);
  });

  it('dedupes staff roles equal to @everyone and skips empty ids', () => {
    const ow = buildPortalOverwrites({
      guildId: 'g',
      sponsorId: 's',
      botId: 'b',
      reviewerRoleId: '',
      adminRoleId: 'g',
    });
    expect(ow.map((o) => o.id)).toEqual(['g', 's', 'b']);
  });
});
```
- [ ] **Step 2: Run to confirm FAIL.** `npx vitest run tests/discord/permissions.test.ts` — expect failure: `buildPortalOverwrites is not a function`.
- [ ] **Step 3: Minimal impl.** Append to `src/discord/permissions.ts`:
```ts
export function buildPortalOverwrites(args: {
  guildId: string;
  sponsorId: string;
  botId: string;
  reviewerRoleId: string;
  adminRoleId: string;
}): PermissionOverwrite[] {
  const overwrites: PermissionOverwrite[] = [
    { id: args.guildId, type: 0, deny: PERM_DENY_EVERYONE },
    { id: args.sponsorId, type: 1, allow: PERM_ALLOW_SPONSOR },
    { id: args.botId, type: 1, allow: PERM_ALLOW_BOT },
  ];
  // Staff get VIEW + READ_HISTORY only (same bitmask as a sponsor). Skip empty
  // env ids and any staff role equal to @everyone (already covered by the deny).
  for (const roleId of [args.reviewerRoleId, args.adminRoleId]) {
    if (!roleId || roleId === args.guildId) continue;
    overwrites.push({ id: roleId, type: 0, allow: PERM_ALLOW_SPONSOR });
  }
  return overwrites;
}
```
- [ ] **Step 4: Run to confirm PASS.** `npx vitest run tests/discord/permissions.test.ts` — expect all passed. `npx tsc --noEmit` — no errors.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(discord): add buildPortalOverwrites with reviewer+admin staff visibility"`

---

### Task 4: `portal_channels` table + migration + setting keys + env

**Files:**
- Modify: `src/db/schema.ts:238` (add `portalChannels` table after `dmFallbackChannels`)
- Create: `migrations/0004_portal_channels.sql`
- Modify: `migrations/meta/_journal.json` (reconcile + append Phase-2 entry)
- Modify: `src/db/settings.ts:3-11` (add panel keys)
- Modify: `src/env.ts:14-16` (add `PORTAL_CHANNEL_CATEGORY_ID`)
- Modify: `vitest.config.ts` (add `PORTAL_CHANNEL_CATEGORY_ID` binding)

- [ ] **Step 1: Add the schema table (no test; schema is declarative — typecheck is the gate).** In `src/db/schema.ts`, after the `dmFallbackChannels` table block (closes at line 238), add:
```ts
export const portalChannels = sqliteTable(
  'portal_channels',
  {
    id: text('id').primaryKey(),
    sponsorId: text('sponsor_id')
      .notNull()
      .references(() => sponsors.discordUserId, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull().unique(),
    dashboardMessageId: text('dashboard_message_id'),
    createdAt: integer('created_at').notNull().default(NOW_MS),
    lastActiveAt: integer('last_active_at').notNull().default(NOW_MS),
    archivedAt: integer('archived_at'),
  },
  (t) => ({
    // One active portal per sponsor; the partial unique index makes the
    // INSERT-first double-click race fail loudly instead of double-creating.
    activeSponsorIdx: uniqueIndex('portal_active_sponsor_idx')
      .on(t.sponsorId)
      .where(sql`${t.archivedAt} IS NULL`),
    idleIdx: index('portal_idle_idx')
      .on(t.lastActiveAt)
      .where(sql`${t.archivedAt} IS NULL`),
  }),
);
```
- [ ] **Step 2: Import `uniqueIndex`.** In `src/db/schema.ts:2-12` import list, add `uniqueIndex` to the `drizzle-orm/sqlite-core` import (alongside `unique`). Run `npx tsc --noEmit` — expect no errors.
- [ ] **Step 3: Write the migration SQL.** Create `migrations/0004_portal_channels.sql` (Phase 1's `0003_weight_alloc.sql` is the prior sequence; Phase 2 is `0004`):
```sql
-- Per-sponsor private "Ad Portal" channel (Phase 2). Modeled on
-- dm_fallback_channels. The dashboard (plan / remaining weight / cap+used /
-- active banners) is rendered into `dashboard_message_id`; `last_active_at`
-- drives the hourly idle sweep; `archived_at` soft-closes a row.
CREATE TABLE IF NOT EXISTS `portal_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`sponsor_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`dashboard_message_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`last_active_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`sponsor_id`) REFERENCES `sponsors`(`discord_user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `portal_channels_channel_id_unique` ON `portal_channels` (`channel_id`);--> statement-breakpoint
-- One active portal per sponsor. Partial unique index defends the INSERT-first
-- double-click race in openOrReusePortalChannel.
CREATE UNIQUE INDEX `portal_active_sponsor_idx` ON `portal_channels` (`sponsor_id`) WHERE "portal_channels"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX `portal_idle_idx` ON `portal_channels` (`last_active_at`) WHERE "portal_channels"."archived_at" IS NULL;
```
- [ ] **Step 4: Reconcile the journal, then register Phase 2's migration.** `wrangler d1 migrations apply` only runs files that have a matching `entries[]` record in `migrations/meta/_journal.json`. **First read the current `migrations/meta/_journal.json`** and compare its `entries` against the files on disk (`ls migrations/*.sql`). At time of writing the journal holds only `idx: 0` (`0000_spicy_guardian`) while `0001_ad_stats_daily_view.sql` and `0002_serve_rotation.sql` already exist on disk **without journal entries**. Reconcile in three moves, keeping `entries` strictly ordered by ascending `idx`:
  1. **Ensure 0001 and 0002 are present** (they exist on disk). If missing, add their entries:
```json
    {
      "idx": 1,
      "version": "6",
      "when": 1780711300000,
      "tag": "0001_ad_stats_daily_view",
      "breakpoints": true
    },
    {
      "idx": 2,
      "version": "6",
      "when": 1780711400000,
      "tag": "0002_serve_rotation",
      "breakpoints": true
    }
```
  2. **Do NOT add an entry for Phase 1's `0003_weight_alloc` here** — Phase 1's plan owns that `idx: 3` entry. If Phase 1 has already merged, its `0003` entry will already be present; leave it untouched. If Phase 1 has not merged yet, expect `idx: 3` to be missing and added by Phase 1 later. (Never claim `idx: 3` for the portal migration — that would collide with Phase 1.)
  3. **Append Phase 2's own entry** as `idx: 4`, after `0003` (use a current epoch-ms `when`):
```json
    {
      "idx": 4,
      "version": "6",
      "when": 1780900000000,
      "tag": "0004_portal_channels",
      "breakpoints": true
    }
```
(Place a comma after each prior entry's closing `}` so the array stays valid JSON. Verify with `node -e "JSON.parse(require('fs').readFileSync('migrations/meta/_journal.json','utf8'))"`.)
- [ ] **Step 5: Add setting keys.** In `src/db/settings.ts`, in the `SystemSettingKey` object (after `ADMIN_MENU_CHANNEL_ID`, before `IP_HASH_SALT`), add:
```ts
  PORTAL_PANEL_MESSAGE_ID: 'menu.portal.message_id',
  PORTAL_PANEL_CHANNEL_ID: 'menu.portal.channel_id',
```
- [ ] **Step 6: Add env var.** In `src/env.ts`, after `FALLBACK_CHANNEL_CATEGORY_ID: string;` (line 14), add:
```ts
  PORTAL_CHANNEL_CATEGORY_ID: string;
```
- [ ] **Step 7: Add test binding.** In `vitest.config.ts`, in the `bindings` object after `FALLBACK_CHANNEL_CATEGORY_ID: '4',`, add:
```ts
            PORTAL_CHANNEL_CATEGORY_ID: '7',
```
- [ ] **Step 8: Typecheck + full suite sanity.** `npx tsc --noEmit` — expect no errors. `npx vitest run tests/cron/dispatch.test.ts` — expect pass (proves env/schema additions didn't break the build).
- [ ] **Step 9: Commit.** `git add -A && git commit -m "feat(db): add portal_channels table, migration, panel keys, PORTAL_CHANNEL_CATEGORY_ID env"`

---

### Task 5: Portal queries (`src/db/queries/portal.ts`) including `getSponsorActiveBanners`

**Files:**
- Create: `src/db/queries/portal.ts`
- Test: `tests/db/queries/portal.test.ts` (Create)

- [ ] **Step 1: Write failing test.** Create `tests/db/queries/portal.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import {
  closePortalRow,
  createPortalRow,
  findOpenPortalByChannel,
  findOpenPortalBySponsor,
  findPortalById,
  getSponsorActiveBanners,
  setPortalDashboardMessageId,
  touchPortalActivity,
} from '../../../src/db/queries/portal.ts';

type Capture = { sql: string; params: unknown[] | undefined };

function mockClient(rows: unknown[], captured: Capture[] = []): PgClient {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return { rows, rowCount: rows.length };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

const dbRow = {
  id: 'p-1',
  sponsor_id: 's-1',
  channel_id: 'c-1',
  dashboard_message_id: 'm-1',
  created_at: new Date('2026-06-01T00:00:00Z'),
  last_active_at: new Date('2026-06-02T00:00:00Z'),
  archived_at: null,
};

describe('findOpenPortalBySponsor', () => {
  it('selects active row (archived_at IS NULL) and maps fields', async () => {
    const captured: Capture[] = [];
    const r = await findOpenPortalBySponsor(mockClient([dbRow], captured), 's-1');
    expect(r).toEqual({
      id: 'p-1',
      sponsorId: 's-1',
      channelId: 'c-1',
      dashboardMessageId: 'm-1',
      createdAt: dbRow.created_at,
      lastActiveAt: dbRow.last_active_at,
      archivedAt: null,
    });
    expect(captured[0]?.sql).toMatch(/WHERE sponsor_id = \?[\s\S]*archived_at IS NULL/);
    expect(captured[0]?.params).toEqual(['s-1']);
  });
  it('returns null on empty', async () => {
    expect(await findOpenPortalBySponsor(mockClient([]), 's-1')).toBeNull();
  });
});

describe('createPortalRow', () => {
  it('INSERTs id, sponsor_id, channel_id', async () => {
    const captured: Capture[] = [];
    await createPortalRow(mockClient([], captured), {
      id: 'p-1',
      sponsorId: 's-1',
      channelId: 'c-1',
    });
    expect(captured[0]?.sql).toMatch(/INSERT INTO portal_channels/);
    expect(captured[0]?.params).toEqual(['p-1', 's-1', 'c-1']);
  });
});

describe('setPortalDashboardMessageId', () => {
  it('UPDATEs dashboard_message_id by id', async () => {
    const captured: Capture[] = [];
    await setPortalDashboardMessageId(mockClient([], captured), 'p-1', 'm-9');
    expect(captured[0]?.sql).toMatch(/UPDATE portal_channels SET dashboard_message_id = \?/);
    expect(captured[0]?.params).toEqual(['m-9', 'p-1']);
  });
});

describe('touchPortalActivity', () => {
  it('bumps last_active_at by id', async () => {
    const captured: Capture[] = [];
    await touchPortalActivity(mockClient([], captured), 'p-1');
    expect(captured[0]?.sql).toMatch(/UPDATE portal_channels SET last_active_at = \(unixepoch\(\) \* 1000\)/);
    expect(captured[0]?.params).toEqual(['p-1']);
  });
});

describe('closePortalRow', () => {
  it('archives only while still active', async () => {
    const captured: Capture[] = [];
    await closePortalRow(mockClient([], captured), 'p-1');
    expect(captured[0]?.sql).toMatch(
      /UPDATE portal_channels SET archived_at = \(unixepoch\(\) \* 1000\) WHERE id = \? AND archived_at IS NULL/,
    );
    expect(captured[0]?.params).toEqual(['p-1']);
  });
});

describe('findPortalById', () => {
  it('selects by id', async () => {
    const captured: Capture[] = [];
    await findPortalById(mockClient([dbRow], captured), 'p-1');
    expect(captured[0]?.sql).toMatch(/WHERE id = \?/);
    expect(captured[0]?.params).toEqual(['p-1']);
  });
});

describe('findOpenPortalByChannel', () => {
  it('selects the active row by channel_id', async () => {
    const captured: Capture[] = [];
    const r = await findOpenPortalByChannel(mockClient([dbRow], captured), 'c-1');
    expect(r?.sponsorId).toBe('s-1');
    expect(captured[0]?.sql).toMatch(/WHERE channel_id = \?[\s\S]*archived_at IS NULL/);
    expect(captured[0]?.params).toEqual(['c-1']);
  });
  it('returns null on empty', async () => {
    expect(await findOpenPortalByChannel(mockClient([]), 'c-1')).toBeNull();
  });
});

describe('getSponsorActiveBanners', () => {
  it('selects approved+pending regular ads with weight_alloc, maps to camelCase', async () => {
    const captured: Capture[] = [];
    const banners = await getSponsorActiveBanners(
      mockClient(
        [{ id: 'a-1', slot: 'default', title: 'T', status: 'approved', weight_alloc: 5 }],
        captured,
      ),
      's-1',
    );
    expect(banners).toEqual([
      { id: 'a-1', slot: 'default', title: 'T', status: 'approved', weightAlloc: 5 },
    ]);
    expect(captured[0]?.sql).toMatch(/FROM ads/);
    expect(captured[0]?.sql).toMatch(/status IN \('approved', 'pending'\)/);
    expect(captured[0]?.sql).toMatch(/kind = 'regular'/);
    expect(captured[0]?.params).toEqual(['s-1']);
  });
});
```
- [ ] **Step 2: Run to confirm FAIL.** `npx vitest run tests/db/queries/portal.test.ts` — expect failure: cannot find module `portal.ts`.
- [ ] **Step 3: Minimal impl.** Create `src/db/queries/portal.ts`:
```ts
import type { PgClient } from '../client.ts';

export type PortalRow = {
  id: string;
  sponsorId: string;
  channelId: string;
  dashboardMessageId: string | null;
  createdAt: Date;
  lastActiveAt: Date;
  archivedAt: Date | null;
};

type PortalDbRow = {
  id: string;
  sponsor_id: string;
  channel_id: string;
  dashboard_message_id: string | null;
  created_at: Date;
  last_active_at: Date;
  archived_at: Date | null;
};

function mapRow(r: PortalDbRow): PortalRow {
  return {
    id: r.id,
    sponsorId: r.sponsor_id,
    channelId: r.channel_id,
    dashboardMessageId: r.dashboard_message_id,
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
    archivedAt: r.archived_at,
  };
}

export async function findOpenPortalBySponsor(
  client: PgClient,
  sponsorId: string,
): Promise<PortalRow | null> {
  const res = await client.query<PortalDbRow>(
    `SELECT id, sponsor_id, channel_id, dashboard_message_id,
            created_at, last_active_at, archived_at
       FROM portal_channels
      WHERE sponsor_id = ?
        AND archived_at IS NULL
      LIMIT 1`,
    [sponsorId],
  );
  const r = res.rows[0];
  return r ? mapRow(r) : null;
}

export async function findPortalById(
  client: PgClient,
  id: string,
): Promise<PortalRow | null> {
  const res = await client.query<PortalDbRow>(
    `SELECT id, sponsor_id, channel_id, dashboard_message_id,
            created_at, last_active_at, archived_at
       FROM portal_channels
      WHERE id = ?
      LIMIT 1`,
    [id],
  );
  const r = res.rows[0];
  return r ? mapRow(r) : null;
}

/**
 * Look a portal up by the Discord channel the interaction happened in. Used by
 * the owner check on portal:close so the not_owner branch is reachable (we
 * compare the stored sponsor_id to the clicker, NOT findOpenPortalBySponsor of
 * the clicker — which would only ever find the clicker's own portal).
 */
export async function findOpenPortalByChannel(
  client: PgClient,
  channelId: string,
): Promise<PortalRow | null> {
  const res = await client.query<PortalDbRow>(
    `SELECT id, sponsor_id, channel_id, dashboard_message_id,
            created_at, last_active_at, archived_at
       FROM portal_channels
      WHERE channel_id = ?
        AND archived_at IS NULL
      LIMIT 1`,
    [channelId],
  );
  const r = res.rows[0];
  return r ? mapRow(r) : null;
}

export async function createPortalRow(
  client: PgClient,
  args: { id: string; sponsorId: string; channelId: string },
): Promise<void> {
  await client.query(
    `INSERT INTO portal_channels (id, sponsor_id, channel_id)
     VALUES (?, ?, ?)`,
    [args.id, args.sponsorId, args.channelId],
  );
}

export async function setPortalDashboardMessageId(
  client: PgClient,
  id: string,
  messageId: string,
): Promise<void> {
  await client.query(
    'UPDATE portal_channels SET dashboard_message_id = ? WHERE id = ?',
    [messageId, id],
  );
}

export async function touchPortalActivity(client: PgClient, id: string): Promise<void> {
  await client.query(
    'UPDATE portal_channels SET last_active_at = (unixepoch() * 1000) WHERE id = ?',
    [id],
  );
}

export async function closePortalRow(client: PgClient, id: string): Promise<void> {
  await client.query(
    'UPDATE portal_channels SET archived_at = (unixepoch() * 1000) WHERE id = ? AND archived_at IS NULL',
    [id],
  );
}

export type ActiveBanner = {
  id: string;
  slot: string;
  title: string;
  status: string;
  weightAlloc: number | null;
};

/**
 * CANONICAL `getSponsorActiveBanners` — this is the ONLY definition of this
 * function in the codebase (Phase 1 must NOT define a function of this name;
 * if Phase 1 needs a banner list it uses its existing getSponsorAds).
 *
 * Dashboard read: the sponsor's approved+pending REGULAR ads with their
 * per-banner weight allocation. Returns `{ id, slot, title, status, weightAlloc }`.
 * Distinct from getSponsorAds (LIMIT 5, includes terminal statuses).
 * `weight_alloc` is the Phase-1 column.
 */
export async function getSponsorActiveBanners(
  client: PgClient,
  sponsorId: string,
): Promise<ActiveBanner[]> {
  const res = await client.query<{
    id: string;
    slot: string;
    title: string;
    status: string;
    weight_alloc: number | null;
  }>(
    `SELECT id, slot, title, status, weight_alloc
       FROM ads
      WHERE sponsor_id = ?
        AND kind = 'regular'
        AND status IN ('approved', 'pending')
      ORDER BY
        CASE status WHEN 'approved' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
        created_at DESC`,
    [sponsorId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    slot: r.slot,
    title: r.title,
    status: r.status,
    weightAlloc: r.weight_alloc,
  }));
}
```
- [ ] **Step 4: Run to confirm PASS.** `npx vitest run tests/db/queries/portal.test.ts` — expect all passed. `npx tsc --noEmit` — no errors.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(db): add portal queries and getSponsorActiveBanners dashboard read"`

> NOTE: `getSponsorActiveBanners` reads `ads.weight_alloc` (the Phase-1 column). Until the Phase-1 migration that adds `weight_alloc` is applied, this query errors against a real DB but passes its unit test (mocked client). The integration relies on Phase 1 landing first (one-directional dependency per the spec).

---

### Task 6: `getSponsorBudget` stub (Phase-1 contract, removed in Task 12)

**Files:**
- Create: `src/sponsors/portal-budget.ts`
- Test: `tests/sponsors/portal-budget.test.ts` (Create)

- [ ] **Step 1: Write failing test.** Create `tests/sponsors/portal-budget.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../src/db/client.ts';
import { getSponsorBudget } from '../../src/sponsors/portal-budget.ts';

function mockClient(rows: unknown[]): PgClient {
  return {
    query: vi.fn(async () => ({ rows, rowCount: rows.length })) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

describe('getSponsorBudget (Phase-2 stub)', () => {
  it('returns null when the sponsor has no current tier', async () => {
    expect(await getSponsorBudget(mockClient([]), 's-1')).toBeNull();
  });

  it('computes used = SUM(weight_alloc) and remaining = max(0, tierWeight - used)', async () => {
    const r = await getSponsorBudget(
      mockClient([{ tier_weight: 10, used: 7 }]),
      's-1',
    );
    expect(r).toEqual({ tierWeight: 10, used: 7, remaining: 3 });
  });

  it('clamps remaining at 0 when over budget', async () => {
    const r = await getSponsorBudget(
      mockClient([{ tier_weight: 10, used: 15 }]),
      's-1',
    );
    expect(r).toEqual({ tierWeight: 10, used: 15, remaining: 0 });
  });
});
```
- [ ] **Step 2: Run to confirm FAIL.** `npx vitest run tests/sponsors/portal-budget.test.ts` — expect failure: cannot find module `portal-budget.ts`.
- [ ] **Step 3: Minimal impl.** Create `src/sponsors/portal-budget.ts`:
```ts
import type { PgClient } from '../db/client.ts';

export type SponsorBudget = {
  tierWeight: number;
  used: number;
  remaining: number;
};

/**
 * PHASE-2 STUB of the Phase-1 contract `getSponsorBudget`.
 *
 * SHARED CONTRACT (must match src/sponsors/tier.ts#getSponsorBudget once Phase 1
 * lands — getSponsorBudget(client, sponsorId) => { tierWeight, used, remaining } | null):
 *   used      = SUM(weight_alloc) over the sponsor's ads WHERE
 *               kind='regular' AND created_by_admin IS NULL
 *               AND status IN ('pending','approved')
 *   remaining = max(0, tierWeight - used)
 *   returns null when the sponsor has no current tier.
 *
 * The WHERE here MUST stay byte-for-byte aligned with Phase 1's (especially
 * `created_by_admin IS NULL` and `kind='regular'`) so `remaining` does NOT
 * change at cutover (Task 12).
 *
 * This stub lets Phase 2 ship and be tested independently. Task 12 deletes
 * this file and repoints imports to `src/sponsors/tier.ts#getSponsorBudget`.
 */
export async function getSponsorBudget(
  client: PgClient,
  sponsorId: string,
): Promise<SponsorBudget | null> {
  const res = await client.query<{ tier_weight: number; used: number }>(
    `SELECT t.weight AS tier_weight,
            COALESCE(SUM(a.weight_alloc), 0) AS used
       FROM sponsors s
       JOIN tiers t ON t.id = s.current_tier_id
       LEFT JOIN ads a
              ON a.sponsor_id = s.discord_user_id
             AND a.kind = 'regular'
             AND a.created_by_admin IS NULL
             AND a.status IN ('pending', 'approved')
      WHERE s.discord_user_id = ?
      GROUP BY t.weight`,
    [sponsorId],
  );
  const row = res.rows[0];
  if (!row) return null;
  const tierWeight = Number(row.tier_weight);
  const used = Number(row.used);
  return { tierWeight, used, remaining: Math.max(0, tierWeight - used) };
}
```
- [ ] **Step 4: Run to confirm PASS.** `npx vitest run tests/sponsors/portal-budget.test.ts` — expect 3 passed. `npx tsc --noEmit` — no errors.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(sponsors): add getSponsorBudget Phase-2 stub (removed after Phase 1)"`

---

### Task 7: Dashboard render (`buildPortalDashboard` + `renderPortalDashboard`)

**Files:**
- Create: `src/services/portal/render.ts`
- Test: `tests/services/portal/render.test.ts` (Create)

- [ ] **Step 1: Write failing test.** Create `tests/services/portal/render.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import type { ActiveBanner } from '../../../src/db/queries/portal.ts';
import type { DiscordRest } from '../../../src/discord/rest.ts';
import {
  buildPortalDashboard,
  renderPortalDashboard,
} from '../../../src/services/portal/render.ts';

const banners: ActiveBanner[] = [
  { id: 'a-1', slot: 'default', title: 'Banner One', status: 'approved', weightAlloc: 4 },
  { id: 'a-2', slot: 'default', title: 'Banner Two', status: 'pending', weightAlloc: 2 },
];

describe('buildPortalDashboard', () => {
  it('renders plan, remaining weight, cap+used, and banner lines', () => {
    const msg = buildPortalDashboard({
      tierName: 'Gold',
      budget: { tierWeight: 10, used: 6, remaining: 4 },
      maxActiveAds: 3,
      usedCount: 2,
      banners,
    });
    const embed = msg.embeds[0] as { title: string; fields: { name: string; value: string }[] };
    expect(embed.title).toContain('広告ポータル');
    const text = JSON.stringify(embed.fields);
    expect(text).toContain('Gold');
    expect(text).toContain('4'); // remaining weight
    expect(text).toContain('2 / 3'); // used / cap
    expect(text).toContain('Banner One');
    expect(text).toContain('Banner Two');
    // 4 dashboard buttons present
    const row = msg.components[0] as { components: { custom_id: string }[] };
    expect(row.components.map((b) => b.custom_id)).toEqual([
      'portal:add',
      'portal:manage',
      'portal:refresh',
      'portal:close',
    ]);
  });

  it('handles null budget (no tier) and empty banners', () => {
    const msg = buildPortalDashboard({
      tierName: null,
      budget: null,
      maxActiveAds: 0,
      usedCount: 0,
      banners: [],
    });
    const embed = msg.embeds[0] as { fields: { value: string }[] };
    const text = JSON.stringify(embed.fields);
    expect(text).toContain('ティアロール'); // no-tier note
  });
});

describe('renderPortalDashboard', () => {
  it('creates a message and persists dashboard_message_id when none exists', async () => {
    const captured: { sql: string; params: unknown[] | undefined }[] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }),
      end: vi.fn(),
    } as unknown as Parameters<typeof renderPortalDashboard>[0]['client'];
    const rest = {
      createMessage: vi.fn(async () => ({ id: 'msg-new', channel_id: 'c-1' })),
      editMessage: vi.fn(),
    } as unknown as DiscordRest;

    await renderPortalDashboard({
      client,
      rest,
      portalId: 'p-1',
      channelId: 'c-1',
      dashboardMessageId: null,
      dashboard: buildPortalDashboard({
        tierName: 'Gold',
        budget: { tierWeight: 10, used: 0, remaining: 10 },
        maxActiveAds: 3,
        usedCount: 0,
        banners: [],
      }),
    });

    expect(rest.createMessage).toHaveBeenCalledTimes(1);
    expect(rest.editMessage).not.toHaveBeenCalled();
    expect(captured.find((c) => /UPDATE portal_channels SET dashboard_message_id/.test(c.sql)))
      .toBeDefined();
  });

  it('edits the existing dashboard message in place', async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      end: vi.fn(),
    } as unknown as Parameters<typeof renderPortalDashboard>[0]['client'];
    const rest = {
      createMessage: vi.fn(),
      editMessage: vi.fn(async () => ({ id: 'm-1', channel_id: 'c-1' })),
    } as unknown as DiscordRest;

    await renderPortalDashboard({
      client,
      rest,
      portalId: 'p-1',
      channelId: 'c-1',
      dashboardMessageId: 'm-1',
      dashboard: buildPortalDashboard({
        tierName: 'Gold',
        budget: { tierWeight: 10, used: 0, remaining: 10 },
        maxActiveAds: 3,
        usedCount: 0,
        banners: [],
      }),
    });

    expect(rest.editMessage).toHaveBeenCalledTimes(1);
    expect((rest.editMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.slice(0, 2)).toEqual([
      'c-1',
      'm-1',
    ]);
    expect(rest.createMessage).not.toHaveBeenCalled();
  });
});
```
- [ ] **Step 2: Run to confirm FAIL.** `npx vitest run tests/services/portal/render.test.ts` — expect failure: cannot find module `render.ts`.
- [ ] **Step 3: Minimal impl.** Create `src/services/portal/render.ts`:
```ts
import type { PgClient } from '../../db/client.ts';
import type { ActiveBanner } from '../../db/queries/portal.ts';
import { setPortalDashboardMessageId } from '../../db/queries/portal.ts';
import type { DiscordRest } from '../../discord/rest.ts';
import type { SponsorBudget } from '../../sponsors/portal-budget.ts';

export type PortalDashboardMessage = {
  embeds: Record<string, unknown>[];
  components: Record<string, unknown>[];
};

const STATUS_LABEL: Record<string, string> = {
  approved: '配信中',
  pending: '審査中',
};

function dashboardButtons(): Record<string, unknown> {
  return {
    type: 1,
    components: [
      { type: 2, style: 1, custom_id: 'portal:add', label: '➕ バナーを追加' },
      { type: 2, style: 2, custom_id: 'portal:manage', label: '🗂 管理' },
      { type: 2, style: 2, custom_id: 'portal:refresh', label: '🔄 更新' },
      { type: 2, style: 4, custom_id: 'portal:close', label: '✖ 閉じる' },
    ],
  };
}

/**
 * Pure builder for the portal dashboard (embed + button row). Re-rendered on
 * every open/operation since there's no push channel.
 */
export function buildPortalDashboard(args: {
  tierName: string | null;
  budget: SponsorBudget | null;
  maxActiveAds: number;
  usedCount: number;
  banners: ActiveBanner[];
}): PortalDashboardMessage {
  const planValue = args.tierName ?? '（ティアロール未付与）';
  const remainingValue =
    args.budget === null
      ? 'ティアロールが付与されていません'
      : `残り ${args.budget.remaining} / ${args.budget.tierWeight}（使用 ${args.budget.used}）`;
  const capValue = `${args.usedCount} / ${args.maxActiveAds}`;
  const bannerValue =
    args.banners.length === 0
      ? '_出稿中のバナーはありません_'
      : args.banners
          .map((b) => {
            const status = STATUS_LABEL[b.status] ?? b.status;
            const w = b.weightAlloc ?? 0;
            return `• ${b.title}（${status}・weight ${w}・slot ${b.slot}）`;
          })
          .join('\n');

  return {
    embeds: [
      {
        title: '📣 広告ポータル',
        color: 0x5865f2,
        fields: [
          { name: 'プラン', value: planValue, inline: true },
          { name: '残り利用可能ウェイト', value: remainingValue, inline: true },
          { name: '件数（使用 / 上限）', value: capValue, inline: true },
          { name: '出稿中バナー', value: bannerValue.slice(0, 1024) },
        ],
      },
    ],
    components: [dashboardButtons()],
  };
}

/**
 * Post the dashboard message (and persist its id) when none exists yet, or
 * edit the existing message in place.
 */
export async function renderPortalDashboard(args: {
  client: PgClient;
  rest: DiscordRest;
  portalId: string;
  channelId: string;
  dashboardMessageId: string | null;
  dashboard: PortalDashboardMessage;
}): Promise<string> {
  if (args.dashboardMessageId) {
    await args.rest.editMessage(args.channelId, args.dashboardMessageId, {
      embeds: args.dashboard.embeds,
      components: args.dashboard.components,
    });
    return args.dashboardMessageId;
  }
  const msg = await args.rest.createMessage(args.channelId, {
    embeds: args.dashboard.embeds,
    components: args.dashboard.components,
  });
  await setPortalDashboardMessageId(args.client, args.portalId, msg.id);
  return msg.id;
}
```
- [ ] **Step 4: Run to confirm PASS.** `npx vitest run tests/services/portal/render.test.ts` — expect all passed. `npx tsc --noEmit` — no errors.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(portal): add dashboard builder + renderPortalDashboard"`

---

### Task 8: `openOrReusePortalChannel` (insert-first, compensating cleanup, self-heal)

**Files:**
- Create: `src/services/portal/open.ts`
- Test: `tests/services/portal/open.test.ts` (Create)

- [ ] **Step 1: Write failing test.** Create `tests/services/portal/open.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import { type DiscordRest, DiscordRestError } from '../../../src/discord/rest.ts';
import { openOrReusePortalChannel } from '../../../src/services/portal/open.ts';

type Capture = { sql: string; params: unknown[] | undefined };

function clientWith(handler: (sql: string) => { rows: unknown[]; rowCount?: number }): {
  client: PgClient;
  captured: Capture[];
} {
  const captured: Capture[] = [];
  const client: PgClient = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      const r = handler(sql);
      return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
  return { client, captured };
}

const ARGS = {
  guildId: 'g-1',
  botId: 'bot-1',
  categoryId: 'cat-1',
  sponsorId: 's-1',
  reviewerRoleId: 'rev',
  adminRoleId: 'adm',
  uuid: () => 'p-1',
};

const portalRow = {
  id: 'p-existing',
  sponsor_id: 's-1',
  channel_id: 'c-existing',
  dashboard_message_id: 'm-1',
  created_at: new Date(),
  last_active_at: new Date(),
  archived_at: null,
};

describe('openOrReusePortalChannel — reuse', () => {
  it('reuses an active row whose channel still exists', async () => {
    const { client } = clientWith((sql) =>
      /SELECT/.test(sql) ? { rows: [portalRow] } : { rows: [] },
    );
    const rest = {
      getChannel: vi.fn(async () => ({ id: 'c-existing', type: 0 })),
      createGuildChannel: vi.fn(),
    } as unknown as DiscordRest;

    const res = await openOrReusePortalChannel({ ...ARGS, client, rest });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.reusedExisting).toBe(true);
      expect(res.channelId).toBe('c-existing');
      expect(res.portalId).toBe('p-existing');
    }
    expect(rest.createGuildChannel).not.toHaveBeenCalled();
  });
});

describe('openOrReusePortalChannel — self-heal', () => {
  it('archives the orphan row when getChannel 404s, then creates fresh', async () => {
    const { client, captured } = clientWith((sql) =>
      /SELECT/.test(sql) ? { rows: [portalRow] } : { rows: [], rowCount: 1 },
    );
    const rest = {
      getChannel: vi.fn(async () => {
        throw new DiscordRestError(404, 'Unknown Channel');
      }),
      createGuildChannel: vi.fn(async () => ({ id: 'c-new', type: 0 })),
      deleteChannel: vi.fn(),
    } as unknown as DiscordRest;

    const res = await openOrReusePortalChannel({ ...ARGS, client, rest });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.reusedExisting).toBe(false);
      expect(res.channelId).toBe('c-new');
    }
    // Orphan archived, then a fresh INSERT for the new channel.
    expect(captured.some((c) => /UPDATE portal_channels SET archived_at/.test(c.sql))).toBe(true);
    expect(captured.some((c) => /INSERT INTO portal_channels/.test(c.sql))).toBe(true);
    expect(rest.createGuildChannel).toHaveBeenCalledTimes(1);
  });
});

describe('openOrReusePortalChannel — create', () => {
  it('INSERTs row first, then creates the channel under category with overwrites', async () => {
    const { client, captured } = clientWith((sql) =>
      /SELECT/.test(sql) ? { rows: [] } : { rows: [], rowCount: 1 },
    );
    const rest = {
      getChannel: vi.fn(),
      createGuildChannel: vi.fn(async () => ({ id: 'c-new', type: 0 })),
    } as unknown as DiscordRest;

    const res = await openOrReusePortalChannel({ ...ARGS, client, rest });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.channelId).toBe('c-new');

    const insertIdx = captured.findIndex((c) => /INSERT INTO portal_channels/.test(c.sql));
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    // INSERT used a placeholder channel id (the row exists before the channel).
    const insertParams = captured[insertIdx]?.params as unknown[];
    expect(insertParams[0]).toBe('p-1');
    expect(insertParams[1]).toBe('s-1');

    const [guild, body] = (rest.createGuildChannel as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { parent_id: string; permission_overwrites: { id: string }[] },
    ];
    expect(guild).toBe('g-1');
    expect(body.parent_id).toBe('cat-1');
    expect(body.permission_overwrites.map((o) => o.id)).toEqual([
      'g-1',
      's-1',
      'bot-1',
      'rev',
      'adm',
    ]);
    // After createGuildChannel, the row's channel_id is updated to the real id.
    expect(
      captured.some((c) => /UPDATE portal_channels SET channel_id = \?/.test(c.sql)),
    ).toBe(true);
  });

  it('rolls back the row when createGuildChannel fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { client, captured } = clientWith((sql) =>
      /SELECT/.test(sql) ? { rows: [] } : { rows: [], rowCount: 1 },
    );
    const rest = {
      getChannel: vi.fn(),
      createGuildChannel: vi.fn(async () => {
        throw new DiscordRestError(500, 'boom');
      }),
    } as unknown as DiscordRest;

    const res = await openOrReusePortalChannel({ ...ARGS, client, rest });
    expect(res.ok).toBe(false);
    // The pre-created row was deleted (compensating cleanup), no orphan left.
    expect(captured.some((c) => /DELETE FROM portal_channels WHERE id = \?/.test(c.sql))).toBe(
      true,
    );
  });
});
```
- [ ] **Step 2: Run to confirm FAIL.** `npx vitest run tests/services/portal/open.test.ts` — expect failure: cannot find module `open.ts`.
- [ ] **Step 3: Minimal impl.** Create `src/services/portal/open.ts`:
```ts
import type { PgClient } from '../../db/client.ts';
import {
  closePortalRow,
  createPortalRow,
  findOpenPortalBySponsor,
} from '../../db/queries/portal.ts';
import { buildPortalOverwrites } from '../../discord/permissions.ts';
import { type DiscordRest, DiscordRestError } from '../../discord/rest.ts';

export type OpenPortalArgs = {
  client: PgClient;
  rest: DiscordRest;
  guildId: string;
  botId: string;
  categoryId: string;
  sponsorId: string;
  reviewerRoleId: string;
  adminRoleId: string;
  uuid: () => string;
};

export type OpenPortalResult =
  | {
      ok: true;
      portalId: string;
      channelId: string;
      dashboardMessageId: string | null;
      reusedExisting: boolean;
    }
  | { ok: false; reason: 'rest_error' | 'db_error'; error: unknown };

/**
 * Find-or-create the sponsor's private portal channel. Mirrors
 * createOrReuseFallbackChannel's insert-first + compensating-cleanup ordering,
 * plus getChannel-404 self-heal: a reused row whose Discord channel is gone is
 * archived and recreated.
 */
export async function openOrReusePortalChannel(
  args: OpenPortalArgs,
): Promise<OpenPortalResult> {
  // 1. Reuse path.
  const existing = await findOpenPortalBySponsor(args.client, args.sponsorId);
  if (existing) {
    try {
      await args.rest.getChannel(existing.channelId);
      return {
        ok: true,
        portalId: existing.id,
        channelId: existing.channelId,
        dashboardMessageId: existing.dashboardMessageId,
        reusedExisting: true,
      };
    } catch (err) {
      if (err instanceof DiscordRestError && err.status === 404) {
        // Self-heal: channel manually deleted. Archive the orphan row so the
        // partial unique index frees up, then fall through to create fresh.
        try {
          await closePortalRow(args.client, existing.id);
        } catch (closeErr) {
          console.error('portal: self-heal closePortalRow failed', {
            portalId: existing.id,
            closeErr,
          });
          return { ok: false, reason: 'db_error', error: closeErr };
        }
      } else {
        console.error('portal: getChannel failed', { channelId: existing.channelId, err });
        return { ok: false, reason: 'rest_error', error: err };
      }
    }
  }

  // 2. Create path. Row first (channel_id starts as a placeholder = the
  // portalId) so the UNIQUE(sponsor_id) partial index serializes double-clicks
  // before any Discord side effect.
  const portalId = args.uuid();
  try {
    await createPortalRow(args.client, {
      id: portalId,
      sponsorId: args.sponsorId,
      channelId: portalId,
    });
  } catch (err) {
    console.error('portal: createPortalRow failed (likely double-click)', {
      sponsorId: args.sponsorId,
      err,
    });
    return { ok: false, reason: 'db_error', error: err };
  }

  // 3. Create the Discord channel.
  let channelId: string;
  try {
    const ch = await args.rest.createGuildChannel(args.guildId, {
      name: `portal-${args.sponsorId.slice(0, 12)}`,
      type: 0,
      parent_id: args.categoryId,
      permission_overwrites: buildPortalOverwrites({
        guildId: args.guildId,
        sponsorId: args.sponsorId,
        botId: args.botId,
        reviewerRoleId: args.reviewerRoleId,
        adminRoleId: args.adminRoleId,
      }),
      topic: '広告ポータル（プラン・残予算・出稿中バナーの確認 / アイドルで自動削除）',
    });
    channelId = ch.id;
  } catch (err) {
    console.error('portal: createGuildChannel failed; rolling back row', {
      portalId,
      err,
    });
    try {
      await args.client.query('DELETE FROM portal_channels WHERE id = ?', [portalId]);
    } catch (delErr) {
      console.error('portal: rollback DELETE failed', { portalId, delErr });
    }
    return { ok: false, reason: 'rest_error', error: err };
  }

  // 4. Point the row at the real channel id.
  try {
    await args.client.query('UPDATE portal_channels SET channel_id = ? WHERE id = ?', [
      channelId,
      portalId,
    ]);
  } catch (err) {
    console.error('portal: channel_id UPDATE failed; deleting orphan channel', {
      portalId,
      channelId,
      err,
    });
    try {
      await args.rest.deleteChannel(channelId);
    } catch (delErr) {
      console.error('portal: orphan channel delete failed', { channelId, delErr });
    }
    try {
      await args.client.query('DELETE FROM portal_channels WHERE id = ?', [portalId]);
    } catch (rowErr) {
      console.error('portal: orphan row delete failed', { portalId, rowErr });
    }
    return { ok: false, reason: 'db_error', error: err };
  }

  return {
    ok: true,
    portalId,
    channelId,
    dashboardMessageId: null,
    reusedExisting: false,
  };
}
```
- [ ] **Step 4: Run to confirm PASS.** `npx vitest run tests/services/portal/open.test.ts` — expect all passed. `npx tsc --noEmit` — no errors.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(portal): add openOrReusePortalChannel with insert-first + self-heal"`

---

### Task 9: `closePortal` teardown (owner-checked archive + 404-tolerant delete)

**Files:**
- Create: `src/services/portal/teardown.ts`
- Test: `tests/services/portal/teardown.test.ts` (Create)

- [ ] **Step 1: Write failing test.** Create `tests/services/portal/teardown.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import { type DiscordRest, DiscordRestError } from '../../../src/discord/rest.ts';
import { closePortal } from '../../../src/services/portal/teardown.ts';

const row = {
  id: 'p-1',
  sponsor_id: 's-1',
  channel_id: 'c-1',
  dashboard_message_id: null,
  created_at: new Date(),
  last_active_at: new Date(),
  archived_at: null,
};

function client(rows: unknown[], captured: { sql: string; params: unknown[] | undefined }[] = []) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return { rows, rowCount: rows.length };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  } as PgClient;
}

describe('closePortal', () => {
  it('rejects a non-owner', async () => {
    const rest = { deleteChannel: vi.fn() } as unknown as DiscordRest;
    const res = await closePortal({
      client: client([row]),
      rest,
      portalId: 'p-1',
      userId: 'someone-else',
    });
    expect(res).toEqual({ ok: false, reason: 'not_owner' });
    expect(rest.deleteChannel).not.toHaveBeenCalled();
  });

  it('returns not_found when missing', async () => {
    const rest = { deleteChannel: vi.fn() } as unknown as DiscordRest;
    const res = await closePortal({ client: client([]), rest, portalId: 'p-1', userId: 's-1' });
    expect(res).toEqual({ ok: false, reason: 'not_found' });
  });

  it('archives the row and deletes the channel for the owner', async () => {
    const captured: { sql: string; params: unknown[] | undefined }[] = [];
    const rest = { deleteChannel: vi.fn(async () => ({ id: 'c-1', type: 0 })) } as unknown as DiscordRest;
    const res = await closePortal({
      client: client([row], captured),
      rest,
      portalId: 'p-1',
      userId: 's-1',
    });
    expect(res).toEqual({ ok: true });
    expect(captured.some((c) => /UPDATE portal_channels SET archived_at/.test(c.sql))).toBe(true);
    expect(rest.deleteChannel).toHaveBeenCalledWith('c-1');
  });

  it('tolerates a 404 on deleteChannel (already gone)', async () => {
    const rest = {
      deleteChannel: vi.fn(async () => {
        throw new DiscordRestError(404, 'Unknown Channel');
      }),
    } as unknown as DiscordRest;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await closePortal({ client: client([row]), rest, portalId: 'p-1', userId: 's-1' });
    expect(res).toEqual({ ok: true });
  });
});
```
- [ ] **Step 2: Run to confirm FAIL.** `npx vitest run tests/services/portal/teardown.test.ts` — expect failure: cannot find module `teardown.ts`.
- [ ] **Step 3: Minimal impl.** Create `src/services/portal/teardown.ts`:
```ts
import type { PgClient } from '../../db/client.ts';
import { closePortalRow, findPortalById } from '../../db/queries/portal.ts';
import { type DiscordRest, DiscordRestError } from '../../discord/rest.ts';

export type ClosePortalResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'not_owner' };

/**
 * Owner-checked teardown: archive the row (atomic, only-while-active), then
 * best-effort delete the channel. A 404 on delete is fine — the cron sweep or
 * a manual delete may have raced us.
 */
export async function closePortal(args: {
  client: PgClient;
  rest: DiscordRest;
  portalId: string;
  userId: string;
}): Promise<ClosePortalResult> {
  const row = await findPortalById(args.client, args.portalId);
  if (!row || row.archivedAt) return { ok: false, reason: 'not_found' };
  if (row.sponsorId !== args.userId) return { ok: false, reason: 'not_owner' };

  await closePortalRow(args.client, args.portalId);

  try {
    await args.rest.deleteChannel(row.channelId);
  } catch (err) {
    if (err instanceof DiscordRestError && err.status === 404) {
      console.warn('portal close: channel already deleted', { channelId: row.channelId });
    } else {
      console.error('portal close: deleteChannel failed', { channelId: row.channelId, err });
    }
  }
  return { ok: true };
}
```
- [ ] **Step 4: Run to confirm PASS.** `npx vitest run tests/services/portal/teardown.test.ts` — expect all passed. `npx tsc --noEmit` — no errors.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(portal): add closePortal owner-checked teardown"`

---

### Task 10: `portal:open` button — deferred ACK + waitUntil open + followup

**Files:**
- Create: `src/interactions/buttons/portal-open-button.ts`
- Test: `tests/interactions/buttons/portal-open-button.test.ts` (Create)

- [ ] **Step 1: Write failing test.** Create `tests/interactions/buttons/portal-open-button.test.ts`:
```ts
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import type { DiscordRest } from '../../../src/discord/rest.ts';
import type { MessageComponentInteractionPayload } from '../../../src/discord/types.ts';
import { runPortalOpenButton } from '../../../src/interactions/buttons/portal-open-button.ts';

function payload(): MessageComponentInteractionPayload {
  return {
    type: 3,
    id: 'i-1',
    application_id: 'app-1',
    token: 'tok-1',
    guild_id: 'g-1',
    member: { user: { id: 's-1', username: 'spon' } },
    data: { custom_id: 'portal:open', component_type: 2 },
  } as unknown as MessageComponentInteractionPayload;
}

function ctx(scheduled: Promise<unknown>[]) {
  const app = new Hono();
  let response: Response | undefined;
  app.post('/', async (c) => {
    // attach a fake executionCtx.waitUntil that records promises
    (c as unknown as { executionCtx: { waitUntil: (p: Promise<unknown>) => void } }).executionCtx =
      { waitUntil: (p) => scheduled.push(p) };
    response = await runPortalOpenButton(c, payload(), deps);
    return response;
  });
  return app;
}

const followup = vi.fn(async () => ({ id: 'm-1', channel_id: 'c-1' }));
// The scheduled work opens a FRESH client inside the waitUntil callback via
// deps.withClient (production: `(fn) => withPgClient(env, fn)`). The test injects
// a withClient that hands the callback a fresh mock client each time — proving
// the request-scoped client is NOT reused.
const mockClient = {
  query: vi.fn(async (sql: string) =>
    /SELECT/.test(sql) ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 },
  ),
  end: vi.fn(),
} as unknown as PgClient;
const withClient = vi.fn(
  async <T>(fn: (client: PgClient) => Promise<T>): Promise<T> => fn(mockClient),
);
const deps = {
  rest: {
    getChannel: vi.fn(async () => ({ id: 'c-new', type: 0 })),
    createGuildChannel: vi.fn(async () => ({ id: 'c-new', type: 0 })),
    createMessage: vi.fn(async () => ({ id: 'dash-1', channel_id: 'c-new' })),
    editMessage: vi.fn(),
    editOriginalInteractionResponse: followup,
    getGuildMember: vi.fn(async () => ({ user: { id: 's-1' }, roles: [] })),
  } as unknown as DiscordRest,
  withClient,
  appId: 'app-1',
  guildId: 'g-1',
  botId: 'bot-1',
  categoryId: 'cat-1',
  reviewerRoleId: 'rev',
  adminRoleId: 'adm',
  uuid: () => 'p-1',
};

describe('runPortalOpenButton', () => {
  // Reset shared mocks (followup, withClient) so per-test call counts are exact.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a deferred ephemeral (type 5) immediately', async () => {
    const scheduled: Promise<unknown>[] = [];
    const res = await ctx(scheduled).request('/', { method: 'POST' });
    expect(await res.json()).toEqual({ type: 5, data: { flags: 64 } });
    // The heavy work was scheduled on waitUntil, not awaited inline.
    expect(scheduled.length).toBe(1);
  });

  it('opens a fresh client inside waitUntil and posts a followup with the channel link', async () => {
    const scheduled: Promise<unknown>[] = [];
    await ctx(scheduled).request('/', { method: 'POST' });
    // withClient must NOT be touched during the synchronous ACK path...
    expect(withClient).not.toHaveBeenCalled();
    await Promise.all(scheduled);
    // ...only inside the scheduled (post-ACK) work.
    expect(withClient).toHaveBeenCalledTimes(1);
    expect(followup).toHaveBeenCalledTimes(1);
    const [appId, token, body] = followup.mock.calls[0] as [
      string,
      string,
      { content: string },
    ];
    expect(appId).toBe('app-1');
    expect(token).toBe('tok-1');
    expect(body.content).toContain('<#c-new>');
  });
});
```
- [ ] **Step 2: Run to confirm FAIL.** `npx vitest run tests/interactions/buttons/portal-open-button.test.ts` — expect failure: cannot find module `portal-open-button.ts`.
- [ ] **Step 3: Add `token` to the payload type.** In `src/discord/types.ts`, in `MessageComponentInteractionPayload` (after `application_id: string;`, line ~183), add `token: string;` (the followup needs the interaction token; Discord always sends it). Run `npx tsc --noEmit` to confirm no breakage.
- [ ] **Step 4: Minimal impl.** Create `src/interactions/buttons/portal-open-button.ts`:
```ts
import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import { findPortalById } from '../../db/queries/portal.ts';
import {
  getSponsorActiveBanners,
  touchPortalActivity,
} from '../../db/queries/portal.ts';
import { type DiscordRest, createDiscordRest } from '../../discord/rest.ts';
import type { MessageComponentInteractionPayload } from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { getSponsorBudget } from '../../sponsors/portal-budget.ts';
import { refreshSponsorTier } from '../../sponsors/tier.ts';
import { openOrReusePortalChannel } from '../../services/portal/open.ts';
import { buildPortalDashboard, renderPortalDashboard } from '../../services/portal/render.ts';
import { deferredEphemeral } from '../responses.ts';

export type PortalOpenDeps = {
  rest: DiscordRest;
  /**
   * Opens a FRESH PgClient for the duration of `fn`. In production this is
   * `(fn) => withPgClient(env, fn)`. The scheduled (post-ACK) work calls this
   * INSIDE the waitUntil callback so it never reuses the request-scoped client
   * (which D1 would tear down when the request handler returns its Response).
   */
  withClient: <T>(fn: (client: PgClient) => Promise<T>) => Promise<T>;
  appId: string;
  guildId: string;
  botId: string;
  categoryId: string;
  reviewerRoleId: string;
  adminRoleId: string;
  uuid: () => string;
};

/**
 * Build + render the dashboard for a freshly opened/reused portal, then push a
 * webhook followup linking the channel. Runs inside waitUntil (post-ACK) and is
 * handed a FRESH `client` opened inside the waitUntil callback (NOT the
 * request-scoped one).
 */
async function fulfillPortalOpen(
  client: PgClient,
  token: string,
  sponsorId: string,
  displayName: string,
  deps: PortalOpenDeps,
): Promise<void> {
  // Live tier refresh (accurate plan name; matches ad-submit's lazy refresh).
  let tierName: string | null = null;
  try {
    const tier = await refreshSponsorTier({
      rest: deps.rest,
      client,
      guildId: deps.guildId,
      userId: sponsorId,
      displayName,
    });
    tierName = tier?.name ?? null;
  } catch (err) {
    console.error('portal open: refreshSponsorTier failed', { sponsorId, err });
  }

  const opened = await openOrReusePortalChannel({
    client,
    rest: deps.rest,
    guildId: deps.guildId,
    botId: deps.botId,
    categoryId: deps.categoryId,
    sponsorId,
    reviewerRoleId: deps.reviewerRoleId,
    adminRoleId: deps.adminRoleId,
    uuid: deps.uuid,
  });
  if (!opened.ok) {
    await deps.rest.editOriginalInteractionResponse(deps.appId, token, {
      content: '⚠ ポータルを開けませんでした。しばらくしてから再度お試しください。',
    });
    return;
  }

  const [budget, banners] = await Promise.all([
    getSponsorBudget(client, sponsorId),
    getSponsorActiveBanners(client, sponsorId),
  ]);

  // used-count numerator = regular non-admin pending+approved banner count
  // (banners.length), NOT the broad countActiveAds (which counts all kinds).
  // cap denominator = tierWeight (each banner ≥1 weight and Σ≤tierWeight ⇒
  // count≤tierWeight). `remaining` is shown separately via budget.remaining.
  const dashboard = buildPortalDashboard({
    tierName,
    budget,
    maxActiveAds: budget?.tierWeight ?? 0,
    usedCount: banners.length,
    banners,
  });

  // dashboardMessageId may be stale after a self-heal; re-read the row when we
  // reused so we don't try to edit a message in a different (deleted) channel.
  let dashboardMessageId = opened.dashboardMessageId;
  if (opened.reusedExisting) {
    const fresh = await findPortalById(client, opened.portalId);
    dashboardMessageId = fresh?.dashboardMessageId ?? null;
  }

  try {
    await renderPortalDashboard({
      client,
      rest: deps.rest,
      portalId: opened.portalId,
      channelId: opened.channelId,
      dashboardMessageId,
      dashboard,
    });
    await touchPortalActivity(client, opened.portalId);
  } catch (err) {
    console.error('portal open: renderPortalDashboard failed', { portalId: opened.portalId, err });
  }

  await deps.rest.editOriginalInteractionResponse(deps.appId, token, {
    content: `✅ 広告ポータルを開きました: <#${opened.channelId}>`,
  });
}

export async function runPortalOpenButton(
  c: Context,
  payload: MessageComponentInteractionPayload,
  deps: PortalOpenDeps,
): Promise<Response> {
  const sponsorId = payload.member?.user.id ?? payload.user?.id ?? '';
  const displayName =
    payload.member?.user.username ?? payload.user?.username ?? sponsorId ?? 'unknown';
  const token = payload.token;
  if (sponsorId && token) {
    // Open a FRESH withPgClient INSIDE the waitUntil callback. We deliberately
    // do NOT reuse a request-scoped client: the channel-create + dashboard work
    // outlives the request, and D1 ties a client to the request that opened it.
    c.executionCtx.waitUntil(
      (async () => {
        try {
          await deps.withClient((client) =>
            fulfillPortalOpen(client, token, sponsorId, displayName, deps),
          );
        } catch (err) {
          console.error('portal open: scheduled work failed', { sponsorId, err });
        }
      })(),
    );
  }
  // ACK within 3s no matter what; failures surface via the followup.
  return deferredEphemeral(c);
}

export function handlePortalOpenButton(
  c: Context<{ Bindings: Bindings }>,
  payload: MessageComponentInteractionPayload,
): Promise<Response> {
  const env = c.env;
  const rest = createDiscordRest({ token: env.DISCORD_BOT_TOKEN });
  const guildId = payload.guild_id ?? env.GUILD_ID;
  // No request-scoped client here. The scheduled work opens its own fresh client
  // via `withClient` inside the waitUntil callback (see runPortalOpenButton).
  return runPortalOpenButton(c, payload, {
    rest,
    withClient: (fn) => withPgClient(env, fn),
    appId: env.DISCORD_APP_ID,
    guildId,
    botId: env.DISCORD_APP_BOT_ID,
    categoryId: env.PORTAL_CHANNEL_CATEGORY_ID,
    reviewerRoleId: env.REVIEWER_ROLE_ID,
    adminRoleId: env.ADMIN_ROLE_ID,
    uuid: () => crypto.randomUUID(),
  });
}
```
- [ ] **Step 5: Run to confirm PASS.** `npx vitest run tests/interactions/buttons/portal-open-button.test.ts` — expect 2 passed. `npx tsc --noEmit` — no errors.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(portal): add portal:open deferred-ACK button with waitUntil followup"`

---

### Task 11: Dashboard buttons (`portal:add` / `manage` / `refresh` / `close`)

**Files:**
- Create: `src/interactions/buttons/portal-dashboard-buttons.ts`
- Test: `tests/interactions/buttons/portal-dashboard-buttons.test.ts` (Create)

- [ ] **Step 1: Write failing test.** Create `tests/interactions/buttons/portal-dashboard-buttons.test.ts`:
```ts
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import { type DiscordRest, DiscordRestError } from '../../../src/discord/rest.ts';
import type { MessageComponentInteractionPayload } from '../../../src/discord/types.ts';
import { runPortalDashboardButton } from '../../../src/interactions/buttons/portal-dashboard-buttons.ts';

const portalRow = {
  id: 'p-1',
  sponsor_id: 's-1',
  channel_id: 'c-1',
  dashboard_message_id: 'm-1',
  created_at: new Date(),
  last_active_at: new Date(),
  archived_at: null,
};

function payload(customId: string): MessageComponentInteractionPayload {
  return {
    type: 3,
    id: 'i-1',
    application_id: 'app-1',
    token: 'tok-1',
    guild_id: 'g-1',
    channel_id: 'c-1',
    member: { user: { id: 's-1', username: 'spon' } },
    data: { custom_id: customId, component_type: 2 },
  } as unknown as MessageComponentInteractionPayload;
}

function deps(handler: (sql: string) => { rows: unknown[]; rowCount?: number }) {
  return {
    rest: {
      createMessage: vi.fn(async () => ({ id: 'm-2', channel_id: 'c-1' })),
      editMessage: vi.fn(async () => ({ id: 'm-1', channel_id: 'c-1' })),
      deleteChannel: vi.fn(async () => ({ id: 'c-1', type: 0 })),
      getGuildMember: vi.fn(async () => ({ user: { id: 's-1' }, roles: [] })),
    } as unknown as DiscordRest,
    client: {
      query: vi.fn(async (sql: string) => {
        const r = handler(sql);
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
      }),
      end: vi.fn(),
    } as unknown as PgClient,
    guildId: 'g-1',
  };
}

async function run(customId: string, d: ReturnType<typeof deps>) {
  const app = new Hono();
  app.post('/', (c) => runPortalDashboardButton(c, payload(customId), d));
  return app.request('/', { method: 'POST' });
}

describe('portal:add', () => {
  it('returns an ephemeral pointing to /ad submit', async () => {
    const res = await run('portal:add', deps((sql) => ({ rows: /SELECT/.test(sql) ? [portalRow] : [] })));
    const body = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain('/ad submit');
  });
});

describe('portal:refresh', () => {
  it('re-renders the dashboard via UPDATE_MESSAGE (type 7)', async () => {
    const res = await run(
      'portal:refresh',
      deps((sql) => ({ rows: /SELECT id, sponsor_id, channel_id/.test(sql) ? [portalRow] : [] })),
    );
    const body = (await res.json()) as { type: number; data: { embeds: unknown[] } };
    expect(body.type).toBe(7);
    expect(Array.isArray(body.data.embeds)).toBe(true);
  });
});

describe('portal:manage', () => {
  it('returns an ephemeral management view', async () => {
    const res = await run(
      'portal:manage',
      deps((sql) => ({ rows: /SELECT/.test(sql) ? [portalRow] : [] })),
    );
    const body = (await res.json()) as { type: number; data: { flags: number } };
    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(64);
  });
});

describe('portal:close', () => {
  it('archives + deletes for the owner and acks', async () => {
    const d = deps((sql) => ({ rows: /SELECT id, sponsor_id, channel_id/.test(sql) ? [portalRow] : [] }));
    const res = await run('portal:close', d);
    const body = (await res.json()) as { type: number };
    // type 4 (ephemeral confirmation) is acceptable since the channel is gone.
    expect([4, 7]).toContain(body.type);
    expect(d.rest.deleteChannel).toHaveBeenCalledWith('c-1');
  });

  it('rejects a non-owner', async () => {
    const notOwner = {
      ...portalRow,
      sponsor_id: 'other',
    };
    const d = deps((sql) => ({ rows: /SELECT id, sponsor_id, channel_id/.test(sql) ? [notOwner] : [] }));
    const res = await run('portal:close', d);
    const body = (await res.json()) as { data: { content: string } };
    expect(body.data.content).toContain('スポンサー');
    expect(d.rest.deleteChannel).not.toHaveBeenCalled();
  });
});
```
- [ ] **Step 2: Run to confirm FAIL.** `npx vitest run tests/interactions/buttons/portal-dashboard-buttons.test.ts` — expect failure: cannot find module `portal-dashboard-buttons.ts`.
- [ ] **Step 3: Minimal impl.** Create `src/interactions/buttons/portal-dashboard-buttons.ts`:
```ts
import type { Context } from 'hono';
import { type PgClient, withPgClient } from '../../db/client.ts';
import {
  findOpenPortalByChannel,
  findOpenPortalBySponsor,
  getSponsorActiveBanners,
  touchPortalActivity,
} from '../../db/queries/portal.ts';
import { type DiscordRest, createDiscordRest } from '../../discord/rest.ts';
import type { MessageComponentInteractionPayload } from '../../discord/types.ts';
import type { Bindings } from '../../env.ts';
import { closePortal } from '../../services/portal/teardown.ts';
import { buildPortalDashboard } from '../../services/portal/render.ts';
import { getSponsorBudget } from '../../sponsors/portal-budget.ts';
import { refreshSponsorTier } from '../../sponsors/tier.ts';
import { ephemeral, updateMessage } from '../responses.ts';

export type PortalDashboardDeps = {
  rest: DiscordRest;
  client: PgClient;
  guildId: string;
};

const ADD_HELP =
  '➕ バナーの追加は `/ad submit` から行います。\n' +
  'slot を選び画像を添付すると、タイトル / 本文 / リンクの入力画面が開きます。\n' +
  '（残り利用可能ウェイトが 0 の場合は追加できません。）';

export async function runPortalDashboardButton(
  c: Context,
  payload: MessageComponentInteractionPayload,
  deps: PortalDashboardDeps,
): Promise<Response> {
  const cid = payload.data.custom_id;
  const userId = payload.member?.user.id ?? payload.user?.id ?? '';
  const displayName = payload.member?.user.username ?? payload.user?.username ?? userId ?? 'unknown';
  if (!userId) return ephemeral(c, 'ユーザー情報を取得できませんでした。');

  if (cid === 'portal:add') {
    return ephemeral(c, ADD_HELP);
  }

  if (cid === 'portal:close') {
    // Owner check must use the channel the button was clicked in (payload
    // .channel_id), NOT findOpenPortalBySponsor(clickerUserId) — otherwise a
    // non-owner would only ever look up their own portal and the not_owner
    // branch is unreachable. We look the portal up by channel and compare its
    // stored sponsor_id to the clicker inside closePortal.
    const channelId = payload.channel_id ?? '';
    const portal = channelId
      ? await findOpenPortalByChannel(deps.client, channelId)
      : null;
    if (!portal) return ephemeral(c, 'ポータルが見つかりません。既に閉じられた可能性があります。');
    const res = await closePortal({
      client: deps.client,
      rest: deps.rest,
      portalId: portal.id,
      userId,
    });
    if (!res.ok && res.reason === 'not_owner') {
      return ephemeral(c, 'この操作を行えるのは対象のスポンサーのみです。');
    }
    if (!res.ok) {
      return ephemeral(c, 'ポータルが見つかりません。既に閉じられた可能性があります。');
    }
    return ephemeral(c, '✅ ポータルを閉じました。チャンネルは削除されます。');
  }

  if (cid === 'portal:manage') {
    const banners = await getSponsorActiveBanners(deps.client, userId);
    const lines =
      banners.length === 0
        ? '_管理対象のバナーはありません_'
        : banners
            .map((b) => `• \`${b.id}\` ${b.title}（${b.status}・weight ${b.weightAlloc ?? 0}）`)
            .join('\n');
    return ephemeral(
      c,
      `🗂 出稿中バナーの管理\n${lines}\n\n取り下げは \`/ad withdraw id:<広告ID>\` で行えます。`,
    );
  }

  // portal:refresh — re-render the dashboard in place (type 7).
  const portal = await findOpenPortalBySponsor(deps.client, userId);
  if (!portal) return ephemeral(c, 'ポータルが見つかりません。再度開いてください。');

  let tierName: string | null = null;
  try {
    const tier = await refreshSponsorTier({
      rest: deps.rest,
      client: deps.client,
      guildId: deps.guildId,
      userId,
      displayName,
    });
    tierName = tier?.name ?? null;
  } catch (err) {
    console.error('portal refresh: refreshSponsorTier failed', { userId, err });
  }

  const [budget, banners] = await Promise.all([
    getSponsorBudget(deps.client, userId),
    getSponsorActiveBanners(deps.client, userId),
  ]);

  await touchPortalActivity(deps.client, portal.id);

  // used-count numerator = banners.length (regular non-admin pending+approved),
  // NOT countActiveAds; cap = tierWeight; remaining shown separately.
  const dashboard = buildPortalDashboard({
    tierName,
    budget,
    maxActiveAds: budget?.tierWeight ?? 0,
    usedCount: banners.length,
    banners,
  });
  return updateMessage(c, {
    embeds: dashboard.embeds,
    components: dashboard.components,
  });
}

export async function handlePortalDashboardButton(
  c: Context<{ Bindings: Bindings }>,
  payload: MessageComponentInteractionPayload,
): Promise<Response> {
  const env = c.env;
  const rest = createDiscordRest({ token: env.DISCORD_BOT_TOKEN });
  const guildId = payload.guild_id ?? env.GUILD_ID;
  return withPgClient(env, (client) =>
    runPortalDashboardButton(c, payload, { rest, client, guildId }),
  );
}
```
- [ ] **Step 4: Run to confirm PASS.** `npx vitest run tests/interactions/buttons/portal-dashboard-buttons.test.ts` — expect all passed. `npx tsc --noEmit` — no errors.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(portal): add dashboard buttons (add/manage/refresh/close)"`

---

### Task 12: Router wiring (`portal:` arm) + flip stub to Phase-1 primitive when available

**Files:**
- Modify: `src/interactions/router.ts:143-179` (MESSAGE_COMPONENT switch)
- Test: `tests/interactions/router-portal.test.ts` (Create)

- [ ] **Step 1: Write failing test.** Create `tests/interactions/router-portal.test.ts`. This mirrors the EXACT harness in `tests/interactions/ad-submit-flow.test.ts` (read it first to confirm it is unchanged): `SELF` from `cloudflare:test`, the shared `toHex` helper, a module-level `nacl` keypair, and the `X-Public-Key-Override` header so the signature verifies against the test key:
```ts
import { SELF } from 'cloudflare:test';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import { toHex } from '../_helpers/hex.ts';

const keypair = nacl.sign.keyPair();
const publicKeyHex = toHex(keypair.publicKey);

function sign(timestamp: string, body: string) {
  const msg = new TextEncoder().encode(timestamp + body);
  return toHex(nacl.sign.detached(msg, keypair.secretKey));
}

async function post(body: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign(ts, body);
  return SELF.fetch('http://example.com/interactions', {
    method: 'POST',
    headers: {
      'X-Signature-Ed25519': sig,
      'X-Signature-Timestamp': ts,
      'Content-Type': 'application/json',
      'X-Public-Key-Override': publicKeyHex,
    },
    body,
  });
}

describe('/interactions router → portal: arm (integration)', () => {
  it('routes portal:open to a deferred ephemeral ACK (type 5)', async () => {
    const body = JSON.stringify({
      type: 3, // MESSAGE_COMPONENT
      id: 'int-portal-1',
      application_id: 'app-1',
      token: 'tok-1',
      guild_id: 'guild-1',
      member: { user: { id: 'user-1', username: 'u1' }, roles: [] },
      data: { custom_id: 'portal:open', component_type: 2 },
    });
    const res = await post(body);
    // portal:open ACKs inline with a DEFERRED ephemeral; the heavy create/render
    // work is scheduled on waitUntil (a no-op DB in the test env is fine — the
    // followup just won't post). The dispatch-level assertion: it is NOT the
    // 501 "unknown component", and the inline ACK is type 5.
    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number; data?: { flags?: number } };
    expect(json.type).toBe(5);
    expect(json.data?.flags).toBe(64);
  });

  it('routes a non-open portal: id (portal:refresh) to the dashboard handler, not the 501 dispatch fallback', async () => {
    // With an unreachable/empty test DB the handler returns a user-facing
    // ephemeral (type 4) rather than the dispatch-level 501 "unknown component".
    const body = JSON.stringify({
      type: 3,
      id: 'int-portal-2',
      application_id: 'app-1',
      token: 'tok-2',
      guild_id: 'guild-1',
      channel_id: 'chan-1',
      member: { user: { id: 'user-1', username: 'u1' }, roles: [] },
      data: { custom_id: 'portal:refresh', component_type: 2 },
    });
    const res = await post(body);
    // Reached the handler (not the 501 fallback). In the test env it may 200
    // (ephemeral "ポータルが見つかりません") or 500 (DB error escaped); both prove routing.
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      const json = (await res.json()) as { type: number; data?: { flags?: number } };
      // type 4 ephemeral or type 7 update — never the dispatch 501.
      expect([4, 7]).toContain(json.type);
    }
  });
});
```
- [ ] **Step 2: Run to confirm FAIL.** `npx vitest run tests/interactions/router-portal.test.ts` — expect failure: the router still returns 501 "unknown component" for `portal:open`, so `json.type` is `undefined` (not `5`).
- [ ] **Step 3: Wire the router.** In `src/interactions/router.ts`, add imports near the other button handlers (after line 12's `handleAckButton` import):
```ts
import { handlePortalOpenButton } from './buttons/portal-open-button.ts';
import { handlePortalDashboardButton } from './buttons/portal-dashboard-buttons.ts';
```
Then in the MESSAGE_COMPONENT block, before `return c.json({ error: 'unknown component' }, 501);` (line 179), add:
```ts
      if (cid === 'portal:open') {
        return handlePortalOpenButton(c, mc);
      }
      if (cid.startsWith('portal:')) {
        return handlePortalDashboardButton(c, mc);
      }
```
- [ ] **Step 4: Run to confirm PASS.** `npx vitest run tests/interactions/router-portal.test.ts` — expect pass. `npx tsc --noEmit` — no errors.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(interactions): route portal: component ids to portal handlers"`
- [ ] **Step 6: Phase-1 cutover (only run AFTER Phase 1 has merged `getSponsorBudget` AND the `SponsorBudget` type into `src/sponsors/tier.ts`).** Repoint **all THREE importers** of the stub (grep first to confirm: `grep -rn "sponsors/portal-budget" src/`):
  1. `src/interactions/buttons/portal-open-button.ts` — value import: change `import { getSponsorBudget } from '../../sponsors/portal-budget.ts';` to `import { getSponsorBudget } from '../../sponsors/tier.ts';`
  2. `src/interactions/buttons/portal-dashboard-buttons.ts` — value import: same change.
  3. `src/services/portal/render.ts` — **TYPE import**: change `import type { SponsorBudget } from '../../sponsors/portal-budget.ts';` to `import type { SponsorBudget } from '../../sponsors/tier.ts';` (this is the third site, easy to miss because it is a `import type`).

  Then `git rm src/sponsors/portal-budget.ts tests/sponsors/portal-budget.test.ts`.
- [ ] **Step 7: Verify cutover.** `grep -rn "sponsors/portal-budget" src/ tests/` — expect ZERO hits (all 3 importers, incl. render.ts's `import type { SponsorBudget }`, are repointed and the stub is deleted). `npx tsc --noEmit` — no errors (confirms `tier.ts` exports both `getSponsorBudget` with the `{ tierWeight; used; remaining } | null` shape AND the `SponsorBudget` type). `npx vitest run tests/services/portal tests/interactions/buttons` — expect all passed.
- [ ] **Step 8: Commit cutover.** `git add -A && git commit -m "refactor(portal): consume Phase-1 getSponsorBudget, drop Phase-2 stub"`

> If Phase 1 has NOT merged yet, SKIP Steps 6-8 and leave the stub in place. Track removal as the single remaining follow-up.

---

### Task 13: Hourly portal idle sweep

**Files:**
- Create: `src/cron/portal-sweep.ts`
- Modify: `src/cron/index.ts:63-67` (register inside `runHourly`)
- Test: `tests/cron/portal-sweep.test.ts` (Create)

- [ ] **Step 1: Write failing test.** Create `tests/cron/portal-sweep.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { sweepPortalChannels } from '../../src/cron/portal-sweep.ts';
import type { PgClient } from '../../src/db/client.ts';
import { type DiscordRest, DiscordRestError } from '../../src/discord/rest.ts';

type Capture = { sql: string; params: unknown[] | undefined };

function mockClient(responses: Array<{ rows?: unknown[]; rowCount?: number }>, captured: Capture[] = []): PgClient {
  let i = 0;
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      const r = responses[i++] ?? {};
      return { rows: r.rows ?? [], rowCount: r.rowCount ?? r.rows?.length ?? 0 };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

const restWith = (deleteChannel: ReturnType<typeof vi.fn>): DiscordRest =>
  ({ deleteChannel }) as unknown as DiscordRest;

describe('sweepPortalChannels', () => {
  it('returns zeros when nothing is idle, bounded by a batch LIMIT', async () => {
    const captured: Capture[] = [];
    const result = await sweepPortalChannels(mockClient([{ rows: [] }], captured), restWith(vi.fn()));
    expect(result).toEqual({ selected: 0, channelDeleted: 0, channelGone: 0, failed: 0 });
    expect(captured[0]?.sql).toMatch(/LIMIT \?/);
    // SELECT filters archived_at IS NULL and last_active_at older than the TTL cutoff.
    expect(captured[0]?.sql).toMatch(/archived_at IS NULL/);
    expect(captured[0]?.sql).toMatch(/last_active_at < \(unixepoch\(\) \* 1000\)/);
  });

  it('deletes the channel then archives the row', async () => {
    const captured: Capture[] = [];
    const client = mockClient(
      [
        { rows: [{ id: 'p-1', channel_id: 'c-1' }] }, // SELECT
        { rowCount: 1 }, // UPDATE archived_at
      ],
      captured,
    );
    const deleteChannel = vi.fn(async () => ({ id: 'c-1', type: 0 }));
    const result = await sweepPortalChannels(client, restWith(deleteChannel));
    expect(result).toEqual({ selected: 1, channelDeleted: 1, channelGone: 0, failed: 0 });
    expect(deleteChannel).toHaveBeenCalledWith('c-1');
    expect(captured.some((c) => /UPDATE portal_channels SET archived_at/.test(c.sql))).toBe(true);
  });

  it('treats 404 as already-gone and still archives', async () => {
    const captured: Capture[] = [];
    const client = mockClient(
      [{ rows: [{ id: 'p-1', channel_id: 'gone' }] }, { rowCount: 1 }],
      captured,
    );
    const deleteChannel = vi.fn(async () => {
      throw new DiscordRestError(404, 'Unknown Channel');
    });
    const result = await sweepPortalChannels(client, restWith(deleteChannel));
    expect(result).toEqual({ selected: 1, channelDeleted: 0, channelGone: 1, failed: 0 });
    expect(captured.some((c) => /UPDATE portal_channels SET archived_at/.test(c.sql))).toBe(true);
  });

  it('counts a failure and skips the row on non-404 Discord errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const captured: Capture[] = [];
    const client = mockClient([{ rows: [{ id: 'p-1', channel_id: 'c-1' }] }], captured);
    const deleteChannel = vi.fn(async () => {
      throw new DiscordRestError(500, 'boom');
    });
    const result = await sweepPortalChannels(client, restWith(deleteChannel));
    expect(result).toEqual({ selected: 1, channelDeleted: 0, channelGone: 0, failed: 1 });
    expect(captured.some((c) => /UPDATE portal_channels SET archived_at/.test(c.sql))).toBe(false);
  });
});
```
- [ ] **Step 2: Run to confirm FAIL.** `npx vitest run tests/cron/portal-sweep.test.ts` — expect failure: cannot find module `portal-sweep.ts`.
- [ ] **Step 3: Minimal impl.** Create `src/cron/portal-sweep.ts`:
```ts
import type { PgClient } from '../db/client.ts';
import { type DiscordRest, DiscordRestError } from '../discord/rest.ts';

export type PortalSweepResult = {
  selected: number;
  channelDeleted: number;
  channelGone: number;
  failed: number;
};

const BATCH_LIMIT = 100;
// Idle TTL: portals untouched for 24h are reclaimed. Recreate-on-demand makes
// this cheap — the sponsor just presses "広告ポータルを開く" again.
const IDLE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Hourly idle sweep of portal_channels. Per row: Discord DELETE (404 == gone,
 * treated as success), then archive the row. Non-404 Discord errors skip the
 * row (retried next hour) so we never leave a dangling channel un-archived.
 * Bounded by BATCH_LIMIT so a backlog drains across ticks.
 */
export async function sweepPortalChannels(
  client: PgClient,
  rest: DiscordRest,
): Promise<PortalSweepResult> {
  const cutoff = Date.now() - IDLE_TTL_MS;
  const sel = await client.query<{ id: string; channel_id: string }>(
    `SELECT id, channel_id
       FROM portal_channels
      WHERE archived_at IS NULL
        AND last_active_at < (unixepoch() * 1000) - ?
      LIMIT ?`,
    [IDLE_TTL_MS, BATCH_LIMIT],
  );
  void cutoff;

  let channelDeleted = 0;
  let channelGone = 0;
  let failed = 0;

  for (const row of sel.rows) {
    try {
      await rest.deleteChannel(row.channel_id);
      channelDeleted++;
    } catch (err) {
      if (err instanceof DiscordRestError && err.status === 404) {
        channelGone++;
      } else {
        failed++;
        console.error('portal-sweep: deleteChannel failed', {
          rowId: row.id,
          channelId: row.channel_id,
          err,
        });
        continue;
      }
    }
    try {
      await client.query(
        'UPDATE portal_channels SET archived_at = (unixepoch() * 1000) WHERE id = ? AND archived_at IS NULL',
        [row.id],
      );
    } catch (err) {
      failed++;
      console.error('portal-sweep: archive UPDATE failed after channel cleanup', {
        rowId: row.id,
        err,
      });
    }
  }

  return { selected: sel.rows.length, channelDeleted, channelGone, failed };
}
```
> Drop the unused `cutoff`/`void cutoff` lines (they are vestigial) — the SQL uses `(unixepoch() * 1000) - ?` with `IDLE_TTL_MS`. Keep only `const IDLE_TTL_MS` and the SELECT. Confirm the test's regex `last_active_at < \(unixepoch\(\) \* 1000\)` still matches.
- [ ] **Step 4: Remove the vestigial lines.** Delete `const cutoff = Date.now() - IDLE_TTL_MS;` and `void cutoff;` from the impl. Re-run `npx vitest run tests/cron/portal-sweep.test.ts` — expect all passed.
- [ ] **Step 5: Register in cron dispatch.** In `src/cron/index.ts`, add the import near the others (after line 6's `sweepDmFallbackChannels` import):
```ts
import { sweepPortalChannels } from './portal-sweep.ts';
```
Then inside `runHourly` (after the `dm-fallback-sweep` block, before `runHourly` closes at line 68), add:
```ts
  await runSafely('portal-sweep', async () => {
    const rest = createDiscordRest({ token: env.DISCORD_BOT_TOKEN });
    const result = await withPgClient(env, (client) => sweepPortalChannels(client, rest));
    console.log('cron.hourly.portal-sweep', result);
  });
```
- [ ] **Step 6: Confirm dispatch still routes.** `npx vitest run tests/cron/dispatch.test.ts tests/cron/portal-sweep.test.ts` — expect all passed. `npx tsc --noEmit` — no errors.
- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat(cron): add hourly portal idle sweep"`

---

### Task 14: Persistent entry panel in `ad-setup.ts` + register-commands choice

**Files:**
- Modify: `src/interactions/commands/ad-setup.ts:31-43` (MenuKind + key maps), `:82-107` (add builder), `:118-160` (handle `portal`)
- Modify: `scripts/register-commands.ts:227-235` (add `portal` choice)
- Test: `tests/interactions/commands/ad-setup-portal.test.ts` (Create)

- [ ] **Step 1: Write failing test.** Create `tests/interactions/commands/ad-setup-portal.test.ts`:
```ts
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import type { DiscordRest } from '../../../src/discord/rest.ts';
import type { ApplicationCommandInteractionPayload } from '../../../src/discord/types.ts';
import { runAdSetup } from '../../../src/interactions/commands/ad-setup.ts';

function payload(): ApplicationCommandInteractionPayload {
  return {
    type: 2,
    id: 'i',
    application_id: 'app',
    member: { user: { id: 'admin-1' }, permissions: '8' }, // ADMINISTRATOR
    data: {
      id: 'd',
      name: 'ad-setup',
      type: 1,
      options: [
        { name: 'channel', type: 7, value: 'chan-1' },
        { name: 'kind', type: 3, value: 'portal' },
      ],
    },
  } as unknown as ApplicationCommandInteractionPayload;
}

describe('ad-setup kind:portal', () => {
  it('posts a panel with a portal:open button and persists message/channel id', async () => {
    const captured: { sql: string; params: unknown[] | undefined }[] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        return { rows: [], rowCount: 0 };
      }),
      end: vi.fn(),
    } as unknown as PgClient;
    const rest = {
      createMessage: vi.fn(async () => ({ id: 'panel-msg-1', channel_id: 'chan-1' })),
      deleteMessage: vi.fn(),
    } as unknown as DiscordRest;

    const app = new Hono();
    app.post('/', (c) => runAdSetup(c, payload(), { rest, client, actorId: 'admin-1' }));
    const res = await app.request('/', { method: 'POST' });
    expect(res.status).toBe(200);

    const [, body] = (rest.createMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { components: { components: { custom_id: string; label: string }[] }[] },
    ];
    const btn = body.components[0]?.components[0];
    expect(btn?.custom_id).toBe('portal:open');
    expect(btn?.label).toContain('ポータル');

    // Persists under the portal panel keys.
    const settingInserts = captured.filter((c) => /INSERT INTO system_settings/.test(c.sql));
    const keys = settingInserts.map((c) => (c.params as unknown[])[0]);
    expect(keys).toContain('menu.portal.message_id');
    expect(keys).toContain('menu.portal.channel_id');
  });
});
```
- [ ] **Step 2: Run to confirm FAIL.** `npx vitest run tests/interactions/commands/ad-setup-portal.test.ts` — expect failure (currently `kind:portal` is rejected by the `['submit','review','admin']` allowlist).
- [ ] **Step 3: Add the `portal` MenuKind + key maps.** In `src/interactions/commands/ad-setup.ts`:
  - Change `type MenuKind = 'submit' | 'review' | 'admin';` to `type MenuKind = 'submit' | 'review' | 'admin' | 'portal';`
  - In `MESSAGE_KEY`, add `portal: SystemSettingKey.PORTAL_PANEL_MESSAGE_ID,`
  - In `CHANNEL_KEY`, add `portal: SystemSettingKey.PORTAL_PANEL_CHANNEL_ID,`
- [ ] **Step 4: Add the panel builder.** After `buildSubmitMenu` (closes at line 107), add:
```ts
function buildPortalPanel(): { content: string; components: ActionRowComponent[] } {
  return {
    content: `## 📣 広告ポータル

下のボタンを押すと、あなた専用の広告ポータル（プライベートチャンネル）を開きます。
プラン / 残り利用可能ウェイト / 出稿中バナーを確認し、バナーの追加・管理ができます。
（旧来の \`/ad submit\` も引き続き利用できます。）`,
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 1, custom_id: 'portal:open', label: '📣 広告ポータルを開く' },
        ],
      },
    ],
  };
}
```
- [ ] **Step 5: Accept `portal` in the allowlist + branch the builder.** In `runAdSetup`:
  - Change the validation line `if (!channelId || !['submit', 'review', 'admin'].includes(kindRaw)) {` to `if (!channelId || !['submit', 'review', 'admin', 'portal'].includes(kindRaw)) {`
  - Change the menu selection (lines 150-153) from the two-way ternary to:
```ts
  const menu: Record<string, unknown> =
    kind === 'admin'
      ? buildAdminMenuMessage()
      : kind === 'portal'
        ? buildPortalPanel()
        : buildSubmitMenu(await fetchFormatRules(deps.client, 'default'));
```
  (The existing `kind === 'review'` early-return at line 127-129 stays; `portal` is not review so it proceeds normally.)
- [ ] **Step 6: Run to confirm PASS.** `npx vitest run tests/interactions/commands/ad-setup-portal.test.ts` — expect pass. Re-run the existing setup tests too: `npx vitest run tests/interactions` — expect all passed. `npx tsc --noEmit` — no errors.
- [ ] **Step 7: Add the register-commands choice.** In `scripts/register-commands.ts`, in the `ad-setup` command's `kind` option `choices` array (lines 229-234), add after the `admin` choice:
```ts
          { name: 'portal', value: 'portal' },
```
- [ ] **Step 8: Typecheck script.** `npx tsc --noEmit` — no errors (the script is plain TS).
- [ ] **Step 9: Commit.** `git add -A && git commit -m "feat(ad-setup): add persistent portal entry panel + register portal kind"`

---

### Task 15: Full-suite verification + migration apply note

**Files:** none (verification only)

- [ ] **Step 1: Typecheck.** `npx tsc --noEmit` — expect no errors.
- [ ] **Step 2: Lint.** `npx biome check .` — expect no errors (fix any import-ordering or formatting nits Biome reports, then re-run).
- [ ] **Step 3: Full test suite.** `npx vitest run` — expect all passed (new portal tests + untouched existing suites green, proving coexistence with `/ad submit` and `dm_fallback`).
- [ ] **Step 4: Document the migration apply step (no code).** Confirm `migrations/0004_portal_channels.sql` is the next sequence after Phase 1's `0003_weight_alloc.sql` and applies via the repo's D1 flow: `npx wrangler d1 migrations apply discordadserver --remote` (production) / `--local` (dev). This is an operator step run at deploy time — do not run it here. Verify the journal `entries[]` are contiguous (`0000`→`0004`, including the `0001`/`0002` reconciliation from Task 4) and that the Phase-2 entry `idx: 4` matches the file tag `0004_portal_channels`. Phase 1's `0003_weight_alloc` must already be applied before `0004` (the `weight_alloc` column the dashboard reads is added by it).
- [ ] **Step 5: Final commit (if Biome reformatted anything).** `git add -A && git commit -m "chore(portal): biome formatting pass for phase-2 portal"`

---

## Coexistence & lifecycle summary (acceptance crosswalk)

- **3s ACK:** `portal:open` returns `deferredEphemeral` (type 5) inline; channel create/reuse + dashboard render run on `c.executionCtx.waitUntil`, opening a FRESH `withPgClient(env, ...)` INSIDE the waitUntil callback (never reusing the request-scoped client), then `editOriginalInteractionResponse` posts the channel link (Tasks 2, 10).
- **Create/reuse + double-click safety:** `openOrReusePortalChannel` reuses an active row, else INSERTs first (guarded by `UNIQUE(sponsor_id) WHERE archived_at IS NULL`) then creates the channel (Tasks 4, 8).
- **Compensating cleanup:** createGuildChannel failure deletes the pre-created row; channel_id-update failure deletes both orphan channel and row (Task 8).
- **Dashboard:** `buildPortalDashboard` shows plan / remaining weight (`getSponsorBudget().remaining`, separate field) / used+cap (used = `getSponsorActiveBanners().length`, cap = `tierWeight`; NOT `countActiveAds`) / active banners (`getSponsorActiveBanners`); re-rendered via UPDATE_MESSAGE on `portal:refresh` (Tasks 5, 6, 7, 11).
- **Permissions:** `buildPortalOverwrites` denies @everyone, allows sponsor+bot+REVIEWER+ADMIN (Task 3).
- **Lifecycle:** hourly `sweepPortalChannels` idle-deletes (Task 13); `getChannel`-404 self-heal recreates on reopen (Task 8); `portal:close` owner-checked archive + 404-tolerant delete — owner resolved via `findOpenPortalByChannel(payload.channel_id)` then compared to the clicker so the not_owner branch is reachable (Tasks 9, 11).
- **Add flow:** `portal:add` deep-links to `/ad submit` (MVP), leaving the existing stage1/stage2 + tier/fallback gates untouched (Task 11). The legacy submit menu and `dm_fallback` machinery are not modified anywhere.
- **Phase 1 contract:** Phase 2 consumes `getSponsorBudget` via a stub (Task 6) whose WHERE (`kind='regular' AND created_by_admin IS NULL AND status IN ('pending','approved')`) matches Phase 1 exactly so `remaining` is unchanged at cutover. Cutover flips all THREE importers (`portal-open-button.ts`, `portal-dashboard-buttons.ts` value imports + `render.ts`'s `import type { SponsorBudget }`) to `src/sponsors/tier.ts` then `git rm`s the stub (Task 12, Steps 6-8). `getSponsorActiveBanners` reads the Phase-1 `weight_alloc` column.
