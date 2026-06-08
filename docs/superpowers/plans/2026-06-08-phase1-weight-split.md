# Weight-Split Budget (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Let a sponsor split their tier weight (the budget `T = tiers.weight`) across multiple regular banners (each `weight_alloc ≥ 1`, `Σ weight_alloc ≤ T`) while keeping their total impression share proportional to `T`. Implement the write-path budget enforcement (submit + approve, transactional and sponsor-scoped), the nightly cron rescale (proportional + smallest-first pause + admin_log + DM), a sponsor-aware serve spread (same-sponsor banners do not sit adjacent, best-effort, share-invariant), and minimal budget display in the admin/user list.

**Architecture:** Cloudflare Workers + D1 (SQLite). All DB access is raw SQL via the `PgClient` wrapper (`client.query(sql, params)` with `?` placeholders). **D1 has NO interactive transactions and NO row locks** — the Workers D1 client makes `BEGIN`/`COMMIT`/`ROLLBACK` effectively no-ops (true multi-statement atomicity is only `env.DB.batch`), so a read-then-write budget check does NOT serialize concurrent writers. The budget invariant (`Σ weight_alloc over a sponsor's pending+approved regular non-admin ads ≤ tierWeight`) is therefore enforced with **atomic single-statement conditional writes**: a conditional `INSERT ... SELECT ... WHERE (SUM subquery) + requested <= T` on submit, and a conditional `UPDATE ... WHERE (SUM subquery, excluding this ad) <= T` on approve. SQLite runs one statement atomically and is single-writer, so concurrent writers see each other's committed rows; the affected-row count (`meta.changes` / `rowCount`) tells us whether the budget held (`0` ⇒ `budget_exceeded`, nothing written). The stale Postgres `BEGIN ISOLATION LEVEL REPEATABLE READ` / `starts_at = now()` strings in `approve.ts` are removed. The single source of truth for deck weights is the pure function `effectiveWeights(allocs, tierWeight)` in `src/sponsors/tier.ts`, called identically by `approve.ts` and the audit cron. `weight_alloc` is the sponsor's *intent*; `weight_snapshot` is the *effective deck weight* derived from `effectiveWeights`.

**Tech Stack:** TypeScript (ESM, `.ts` import specifiers), Drizzle schema (`src/db/schema.ts`) + hand-written SQL migrations in `/migrations/`, vitest (`@cloudflare/vitest-pool-workers`). Test command: `npx vitest run <path>`. Typecheck: `npx tsc --noEmit`.

---

## File Structure

| File | Create/Modify | Responsibility |
|------|---------------|----------------|
| `migrations/0003_weight_alloc.sql` | Create | `ALTER TABLE ads ADD COLUMN weight_alloc INTEGER`; SQLite cannot add a table-level CHECK via ALTER, so document the cross-row budget invariant and the per-row constraints that are enforced in app code. |
| `migrations/meta/_journal.json` | Modify | Ensure `0001`/`0002` entries exist (they're on disk but missing from the journal) then append the `0003` entry, so `wrangler d1 migrations apply` actually runs them. |
| `src/db/schema.ts` | Modify (`ads` table, ~L51–106) | Add `weightAlloc: integer('weight_alloc')`; add `weightAllocPositive` and `weightSnapshotPositive` CHECK constraints. Drizzle schema is the documentation of intent; runtime DDL is the migration. |
| `src/sponsors/tier.ts` | Modify (append) | Add pure `effectiveWeights(allocs, tierWeight)`; add `sumActiveWeight(client, sponsorId)`; add `getSponsorBudget(client, sponsorId)`. Keep `countActiveAds`/`checkMaxActiveAds` as-is (no longer the gate, but other code may reference them). |
| `src/services/review/approve.ts` | Modify | On approve: flip `pending → approved` via the **atomic conditional UPDATE** `approvePendingWithinBudget` (no `REPEATABLE READ` tx — D1 has none), then compute `effectiveWeights` over the sponsor's active regular allocs and write the approved ad's `weight_snapshot` (its effective weight) + re-snapshot siblings; return `{ ok:false, reason:'budget_exceeded' }` when the guarded UPDATE matched 0 rows because the budget no longer fits. Also remove the stale Postgres `BEGIN ISOLATION LEVEL REPEATABLE READ` / `starts_at = now()` strings. |
| `src/interactions/buttons/review-approve-button.ts` | Modify (~L104–113) | Surface the new `budget_exceeded` reason with a Japanese message. |
| `src/db/queries/review.ts` | Modify (append) | Add `getSponsorActiveRegularAllocs(client, sponsorId)` returning `{ id, weightAlloc }[]` over `status IN ('pending','approved')` regular non-admin ads; `applyEffectiveWeights(client, weights, paused)` to write `weight_snapshot` and `status='paused'`; and `approvePendingWithinBudget(client, adId, sponsorId, thisAlloc, reviewerId)` — the **atomic single-statement conditional UPDATE** (pending→approved guarded by the SUM≤T subquery, excluding this ad) returning `'approved' | 'budget_exceeded' | 'race'`. |
| `src/interactions/commands/ad-submit.ts` | Modify | Replace count-only gate (`countActiveAds`/`checkMaxActiveAds`) with a budget pre-check using `getSponsorBudget`; thread the requested `weight` (`/ad submit weight` option, default 1) into the draft (`ad_drafts.weight`). |
| `src/interactions/modals/submit-modal.ts` | Modify | Replace `fetchTierLimit`/count gate with the **atomic conditional INSERT** (`INSERT INTO ads ... SELECT ... WHERE (SUM(weight_alloc) over pending+approved regular non-admin) + requested <= tier weight`); inspect `meta.changes` (0 ⇒ `budget_exceeded`, no row inserted). The pending row carries `weight_alloc = requested` (= the budget reservation). This replaces the unsafe read-then-write check because D1 has no row locks. |
| `scripts/register-commands.ts` | Modify (~L29–47) | Add `weight` INTEGER option (min 1, max 1000) to `/ad submit`. |
| `src/cron/audit-sponsor-membership.ts` | Modify (`syncWeightForSponsor`, ~L90–131; types ~L4–12) | Rewrite weight sync: recompute `effectiveWeights` per sponsor, write `weight_snapshot`, pause smallest-alloc-first when `count > T`, record `admin_log` before/after, DM the sponsor on pause. Keep `created_by_admin IS NULL` exclusion. |
| `src/utils/seeded-shuffle.ts` | Modify (`trySwap`, `spreadShuffle`) | Generalize to a `keyOf` function so adjacency is judged by key (sponsor id) rather than element identity. Keep current single-arg behavior as the default (`keyOf = identity`). |
| `src/serve/pick.ts` | Modify (SELECT ~L88–96, `buildBag` ~L51–61) | Add `sponsor_id` to the regular SELECT; build an `id → sponsor_id` map and pass `keyOf` to `spreadShuffle`. Share is unchanged (bag composition unchanged). |
| `src/discord/admin-ads-list.ts` | Modify (`adLine` ~L62–66) | Show `alloc=` for regular ads in the admin list line. |
| `tests/sponsors/tier-budget.test.ts` | Create | Unit tests for `effectiveWeights`, `sumActiveWeight`, `getSponsorBudget`. |
| `tests/services/review/approve-budget.test.ts` | Create | Tests for budget re-check + `budget_exceeded` + sibling re-snapshot in `approveAd`. |
| `tests/interactions/commands/ad-submit-budget.test.ts` | Create | Test the submit budget pre-check + weight threading. |
| `tests/interactions/modals/submit-modal-budget.test.ts` | Create | Test the modal atomic conditional INSERT budget gate (`meta.changes` 0 ⇒ rejected) + `weight_alloc` reservation. |
| `tests/cron/audit-sponsor-membership.test.ts` | Create | Tests for proportional rescale, smallest-first pause, admin_log, DM, admin exclusion. |
| `tests/utils/seeded-shuffle.test.ts` | Create | Tests for `keyOf` non-adjacency (best-effort) and share-invariance. |
| `tests/discord/admin-ads-list-budget.test.ts` | Create | Test the admin list shows `alloc=` per row + a budget summary line via `getSponsorBudget`. |

---

### Task 1: `effectiveWeights` pure function

The single source of truth for deriving deck weights from allocs. Pure (no DB), so it can be unit-tested exhaustively and reused identically by approve + cron.

**Files:**
- Modify: `src/sponsors/tier.ts` (append after `checkMaxActiveAds`, ~L81)
- Test: `tests/sponsors/tier-budget.test.ts` (Create)

- [ ] **Step 1: Write failing test for the S <= T identity branch.**
  Create `tests/sponsors/tier-budget.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { effectiveWeights } from '../../src/sponsors/tier.ts';

  describe('effectiveWeights', () => {
    it('S <= T: snapshot equals alloc, nothing paused', () => {
      const r = effectiveWeights(
        [
          { id: 'a', weightAlloc: 50 },
          { id: 'b', weightAlloc: 20 },
          { id: 'c', weightAlloc: 10 },
        ],
        80,
      );
      expect(r.paused).toEqual([]);
      expect(r.weights).toEqual([
        { id: 'a', weightSnapshot: 50 },
        { id: 'b', weightSnapshot: 20 },
        { id: 'c', weightSnapshot: 10 },
      ]);
    });
  });
  ```

- [ ] **Step 2: Run to confirm FAIL.**
  `npx vitest run tests/sponsors/tier-budget.test.ts`
  Expected: FAIL with `effectiveWeights is not a function` / import error.

- [ ] **Step 3: Minimal implementation of the identity branch.**
  Append to `src/sponsors/tier.ts`:
  ```ts
  export type EffectiveWeightsInput = { id: string; weightAlloc: number };
  export type EffectiveWeightsResult = {
    weights: Array<{ id: string; weightSnapshot: number }>;
    paused: string[];
  };

  /**
   * Derive each banner's effective deck weight (`weight_snapshot`) from the
   * sponsor's intended allocations and the tier budget `tierWeight` (= T).
   *
   * Used IDENTICALLY by approve.ts and the audit cron so the two paths can
   * never drift. Pure: no DB, deterministic.
   *
   * - If S = Σ weightAlloc <= T: snapshot = alloc (upper-bound semantics; the
   *   unused budget T - S simply yields a smaller total share, never inflates).
   * - Else (S > T, e.g. after a downgrade): proportionally rescale
   *   snapshot_i = max(1, round(alloc_i * T / S)); the integer remainder is
   *   absorbed on the largest-alloc banner so Σ snapshot == T. If count > T the
   *   min-1 floor would still overshoot, so move smallest-alloc-first to
   *   'paused' until count <= T, then recompute over the survivors.
   */
  export function effectiveWeights(
    allocs: EffectiveWeightsInput[],
    tierWeight: number,
  ): EffectiveWeightsResult {
    const S = allocs.reduce((sum, a) => sum + a.weightAlloc, 0);
    if (S <= tierWeight) {
      return {
        weights: allocs.map((a) => ({ id: a.id, weightSnapshot: a.weightAlloc })),
        paused: [],
      };
    }
    throw new Error('not implemented');
  }
  ```

- [ ] **Step 4: Run to confirm PASS.**
  `npx vitest run tests/sponsors/tier-budget.test.ts`
  Expected: 1 passed.

- [ ] **Step 5: Commit.**
  `git add src/sponsors/tier.ts tests/sponsors/tier-budget.test.ts && git commit -m "feat(tier): effectiveWeights identity branch (S<=T)"`

- [ ] **Step 6: Write failing test for the S > T proportional branch (no pause needed).**
  Append inside the `describe('effectiveWeights', ...)` block:
  ```ts
    it('S > T: proportional rescale, remainder absorbed on largest alloc, sum == T', () => {
      // S = 100, T = 50. raw = 25,10,15 -> round = 25,10,15 (sum 50, no remainder)
      const r = effectiveWeights(
        [
          { id: 'a', weightAlloc: 50 },
          { id: 'b', weightAlloc: 20 },
          { id: 'c', weightAlloc: 30 },
        ],
        50,
      );
      expect(r.paused).toEqual([]);
      const sum = r.weights.reduce((s, w) => s + w.weightSnapshot, 0);
      expect(sum).toBe(50);
      const byId = Object.fromEntries(r.weights.map((w) => [w.id, w.weightSnapshot]));
      expect(byId.a).toBe(25);
      expect(byId.b).toBe(10);
      expect(byId.c).toBe(15);
    });

    it('S > T: rounding remainder is added to the largest-alloc banner so sum == T', () => {
      // S = 3 (1,1,1), T = 2. raw each = 0.666 -> max(1,round)=1,1,1 sum 3 > T.
      // count(3) > T(2) so smallest-alloc-first pause until count <= T.
      // Tie on alloc=1: pause by ascending alloc then by id; survivors recompute.
      const r = effectiveWeights(
        [
          { id: 'a', weightAlloc: 1 },
          { id: 'b', weightAlloc: 1 },
          { id: 'c', weightAlloc: 1 },
        ],
        2,
      );
      expect(r.paused).toEqual(['a']);
      const sum = r.weights.reduce((s, w) => s + w.weightSnapshot, 0);
      expect(sum).toBe(2);
      expect(r.weights.map((w) => w.id).sort()).toEqual(['b', 'c']);
    });

    it('S > T with a genuine rounding remainder lands on the largest alloc', () => {
      // S = 10 (7,2,1), T = 7. raw = 4.9, 1.4, 0.7 -> round = 5,1,1 sum 7 (=T).
      const r1 = effectiveWeights(
        [
          { id: 'a', weightAlloc: 7 },
          { id: 'b', weightAlloc: 2 },
          { id: 'c', weightAlloc: 1 },
        ],
        7,
      );
      const sum1 = r1.weights.reduce((s, w) => s + w.weightSnapshot, 0);
      expect(sum1).toBe(7);
      // S = 6 (3,2,1), T = 4. raw = 2,1.33,0.66 -> round 2,1,1 sum 4 (=T), no remainder.
      // S = 6 (3,2,1), T = 5. raw = 2.5,1.66,0.83 -> round 3,2,1 sum 6 != 5;
      //   remainder = 5 - 6 = -1 absorbed on largest alloc 'a' -> 2,2,1 sum 5.
      const r2 = effectiveWeights(
        [
          { id: 'a', weightAlloc: 3 },
          { id: 'b', weightAlloc: 2 },
          { id: 'c', weightAlloc: 1 },
        ],
        5,
      );
      const sum2 = r2.weights.reduce((s, w) => s + w.weightSnapshot, 0);
      expect(sum2).toBe(5);
      const byId2 = Object.fromEntries(r2.weights.map((w) => [w.id, w.weightSnapshot]));
      expect(byId2.a).toBe(2);
      expect(byId2.b).toBe(2);
      expect(byId2.c).toBe(1);
    });

    it('negative-remainder min-1 floor: absorber never drops below 1, residual rolls to next-largest, Σ==T', () => {
      // allocs [3,3,1,1], S=10, T=4, count 4 <= 4 so NO pause.
      // raw = 1.5,1.5,0.5,0.5 -> round (half-up) = 2,2,1,1, sum = 6.
      // remainder = T - 6 = -2. Absorb largest-first WITHOUT going below 1:
      //   a (alloc 3, snap 2) can take 1 -> a=1, residual -1
      //   b (alloc 3, snap 2) can take 1 -> b=1, residual 0
      // Result: 1,1,1,1, Σ == 4 == T, every weight >= 1 (a did NOT go to 0).
      const r = effectiveWeights(
        [
          { id: 'a', weightAlloc: 3 },
          { id: 'b', weightAlloc: 3 },
          { id: 'c', weightAlloc: 1 },
          { id: 'd', weightAlloc: 1 },
        ],
        4,
      );
      expect(r.paused).toEqual([]);
      const sum = r.weights.reduce((s, w) => s + w.weightSnapshot, 0);
      expect(sum).toBe(4);
      // Critical invariant: no survivor weight is below the min of 1.
      expect(r.weights.every((w) => w.weightSnapshot >= 1)).toBe(true);
      const byId = Object.fromEntries(r.weights.map((w) => [w.id, w.weightSnapshot]));
      expect(byId.a).toBe(1); // absorber clamped at 1, not 0
      expect(byId.b).toBe(1); // residual rolled here, also clamped at 1
      expect(byId.c).toBe(1);
      expect(byId.d).toBe(1);
    });
  ```

- [ ] **Step 7: Run to confirm FAIL.**
  `npx vitest run tests/sponsors/tier-budget.test.ts`
  Expected: the new cases FAIL with `not implemented`.

- [ ] **Step 8: Implement the S > T branch (rescale + remainder + smallest-first pause).**
  Replace the `throw new Error('not implemented');` line in `effectiveWeights` with:
  ```ts
    // S > T. If count exceeds the budget, the min-1 floor cannot fit: pause the
    // smallest-alloc banners first (ties broken by id, ascending — deterministic)
    // until count <= T, then recompute proportional weights over the survivors.
    const paused: string[] = [];
    let survivors = allocs.slice();
    while (survivors.length > tierWeight) {
      const victim = survivors
        .slice()
        .sort((x, y) => x.weightAlloc - y.weightAlloc || (x.id < y.id ? -1 : 1))[0];
      if (!victim) break;
      paused.push(victim.id);
      survivors = survivors.filter((a) => a.id !== victim.id);
    }
    const Ssurv = survivors.reduce((sum, a) => sum + a.weightAlloc, 0);
    // Map id -> alloc so we can order absorption by descending alloc.
    const allocById = new Map(survivors.map((a) => [a.id, a.weightAlloc]));
    const weights = survivors.map((a) => ({
      id: a.id,
      weightSnapshot: Math.max(1, Math.round((a.weightAlloc * tierWeight) / Ssurv)),
    }));
    // Absorb the integer remainder (can be NEGATIVE when rounding overshot) so
    // Σ weightSnapshot == tierWeight exactly. Apply it largest-alloc-first, but
    // NEVER let an absorber drop below the min weight of 1: when a negative
    // remainder would push the largest below 1, only take it down to 1 and roll
    // the residual onto the NEXT-largest survivor, and so on. survivors satisfy
    // count <= T (we paused until that held), so assigning each a floor of 1
    // leaves enough headroom that the residual is always fully absorbed and the
    // loop terminates with Σ == T and every weightSnapshot >= 1.
    let remainder = tierWeight - weights.reduce((sum, w) => sum + w.weightSnapshot, 0);
    if (remainder !== 0) {
      const order = weights
        .map((w, idx) => ({ idx, alloc: allocById.get(w.id) ?? 0, id: w.id }))
        .sort((x, y) => y.alloc - x.alloc || (x.id < y.id ? -1 : 1));
      for (const { idx } of order) {
        if (remainder === 0) break;
        const target = weights[idx];
        if (!target) continue;
        if (remainder > 0) {
          // Positive remainder: pile it all on the first (largest) absorber.
          target.weightSnapshot += remainder;
          remainder = 0;
        } else {
          // Negative remainder: subtract only down to the floor of 1, roll the rest.
          const canTake = target.weightSnapshot - 1; // >= 0
          const take = Math.min(canTake, -remainder);
          target.weightSnapshot -= take;
          remainder += take;
        }
      }
    }
    return { weights, paused };
  ```

- [ ] **Step 9: Run to confirm PASS.**
  `npx vitest run tests/sponsors/tier-budget.test.ts`
  Expected: all `effectiveWeights` cases passed.

- [ ] **Step 10: Typecheck and commit.**
  `npx tsc --noEmit && git add src/sponsors/tier.ts tests/sponsors/tier-budget.test.ts && git commit -m "feat(tier): effectiveWeights proportional rescale + smallest-first pause"`

---

### Task 2: `sumActiveWeight` + `getSponsorBudget`

DB-backed budget primitives. `sumActiveWeight` = `SUM(weight_alloc)` over the sponsor's regular `pending`/`approved` ads. `getSponsorBudget` joins the sponsor's tier to expose `{ tierWeight, used, remaining }` or `null` when there is no current tier.

**Files:**
- Modify: `src/sponsors/tier.ts` (append after `effectiveWeights`)
- Test: `tests/sponsors/tier-budget.test.ts` (extend)

- [ ] **Step 1: Write failing test for `sumActiveWeight`.**
  Append to `tests/sponsors/tier-budget.test.ts`:
  ```ts
  import { vi } from 'vitest';
  import type { PgClient } from '../../src/db/client.ts';
  import { getSponsorBudget, sumActiveWeight } from '../../src/sponsors/tier.ts';

  type CapturedCall = { sql: string; params: unknown[] | undefined };
  function mockClient(
    responses: Array<{ rows: unknown[] }>,
    captured: CapturedCall[] = [],
  ): PgClient {
    let i = 0;
    return {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        return responses[i++] ?? { rows: [] };
      }) as unknown as PgClient['query'],
      end: vi.fn(async () => undefined),
    };
  }

  describe('sumActiveWeight', () => {
    it('returns SUM(weight_alloc) over pending+approved regular ads', async () => {
      const captured: CapturedCall[] = [];
      const client = mockClient([{ rows: [{ used: 70 }] }], captured);
      const used = await sumActiveWeight(client, 'sp-1');
      expect(used).toBe(70);
      expect(captured[0]?.params).toEqual(['sp-1']);
      expect(captured[0]?.sql).toMatch(/SUM\(weight_alloc\)/);
      expect(captured[0]?.sql).toMatch(/kind = 'regular'/);
      expect(captured[0]?.sql).toMatch(/status IN \('pending', 'approved'\)/);
    });

    it('returns 0 when there are no active ads', async () => {
      const client = mockClient([{ rows: [{ used: null }] }]);
      expect(await sumActiveWeight(client, 'sp-2')).toBe(0);
    });
  });
  ```

- [ ] **Step 2: Run to confirm FAIL.**
  `npx vitest run tests/sponsors/tier-budget.test.ts`
  Expected: FAIL — `sumActiveWeight is not a function`.

- [ ] **Step 3: Implement `sumActiveWeight`.**
  Append to `src/sponsors/tier.ts`:
  ```ts
  /**
   * Σ weight_alloc over the sponsor's regular ads currently holding budget
   * (status pending or approved). admin-contributed ads (created_by_admin set)
   * are excluded — they are intentionally out of the budget. Returns 0 when the
   * sponsor has no active regular ads.
   */
  export async function sumActiveWeight(client: PgClient, sponsorId: string): Promise<number> {
    const res = await client.query<{ used: number | null }>(
      `SELECT COALESCE(SUM(weight_alloc), 0) AS used
         FROM ads
        WHERE sponsor_id = ?
          AND kind = 'regular'
          AND created_by_admin IS NULL
          AND status IN ('pending', 'approved')`,
      [sponsorId],
    );
    return Number(res.rows[0]?.used ?? 0);
  }
  ```

- [ ] **Step 4: Run to confirm PASS.**
  `npx vitest run tests/sponsors/tier-budget.test.ts`
  Expected: `sumActiveWeight` cases passed.

- [ ] **Step 5: Commit.**
  `git add src/sponsors/tier.ts tests/sponsors/tier-budget.test.ts && git commit -m "feat(tier): sumActiveWeight over pending+approved regular allocs"`

- [ ] **Step 6: Write failing test for `getSponsorBudget`.**
  Append to `tests/sponsors/tier-budget.test.ts`:
  ```ts
  describe('getSponsorBudget', () => {
    it('returns tierWeight/used/remaining when the sponsor has a tier', async () => {
      const captured: CapturedCall[] = [];
      const client = mockClient(
        [
          { rows: [{ weight: 80 }] }, // tier lookup
          { rows: [{ used: 30 }] }, // sumActiveWeight
        ],
        captured,
      );
      const b = await getSponsorBudget(client, 'sp-1');
      expect(b).toEqual({ tierWeight: 80, used: 30, remaining: 50 });
      expect(captured[0]?.sql).toMatch(/FROM sponsors s/);
      expect(captured[0]?.sql).toMatch(/JOIN tiers t/);
      expect(captured[0]?.params).toEqual(['sp-1']);
    });

    it('clamps remaining at 0 when used exceeds the tier (post-downgrade)', async () => {
      const client = mockClient([{ rows: [{ weight: 10 }] }, { rows: [{ used: 25 }] }]);
      const b = await getSponsorBudget(client, 'sp-1');
      expect(b).toEqual({ tierWeight: 10, used: 25, remaining: 0 });
    });

    it('returns null when the sponsor has no current tier', async () => {
      const client = mockClient([{ rows: [] }]);
      expect(await getSponsorBudget(client, 'sp-3')).toBeNull();
    });
  });
  ```

- [ ] **Step 7: Run to confirm FAIL.**
  `npx vitest run tests/sponsors/tier-budget.test.ts`
  Expected: FAIL — `getSponsorBudget is not a function`.

- [ ] **Step 8: Implement `getSponsorBudget`.**
  Append to `src/sponsors/tier.ts`:
  ```ts
  export type SponsorBudget = { tierWeight: number; used: number; remaining: number };

  /**
   * The sponsor's budget snapshot: T (= tiers.weight via current_tier_id),
   * used (= sumActiveWeight), remaining = max(0, T - used). Returns null when the
   * sponsor has no current tier (e.g. FANBOX/DLsite/tier-less sponsors), which
   * the caller must treat as "budget gate does not apply".
   */
  export async function getSponsorBudget(
    client: PgClient,
    sponsorId: string,
  ): Promise<SponsorBudget | null> {
    const tierRes = await client.query<{ weight: number }>(
      `SELECT t.weight
         FROM sponsors s
         JOIN tiers t ON t.id = s.current_tier_id
        WHERE s.discord_user_id = ?`,
      [sponsorId],
    );
    const tierRow = tierRes.rows[0];
    if (!tierRow) return null;
    const tierWeight = Number(tierRow.weight);
    const used = await sumActiveWeight(client, sponsorId);
    return { tierWeight, used, remaining: Math.max(0, tierWeight - used) };
  }
  ```

- [ ] **Step 9: Run to confirm PASS.**
  `npx vitest run tests/sponsors/tier-budget.test.ts`
  Expected: all cases passed.

- [ ] **Step 10: Typecheck and commit.**
  `npx tsc --noEmit && git add src/sponsors/tier.ts tests/sponsors/tier-budget.test.ts && git commit -m "feat(tier): getSponsorBudget (tierWeight/used/remaining, null when tier-less)"`

---

### Task 3: `ads.weight_alloc` migration + schema + CHECK constraints

Add the `weight_alloc` column and the two per-row CHECK constraints. SQLite `ALTER TABLE ADD COLUMN` cannot attach a CHECK that references existing rows nor a table-level CHECK; document the cross-row budget invariant as enforced in app code (Task 1/2 + the gates in later tasks).

**Files:**
- Create: `migrations/0003_weight_alloc.sql`
- Modify: `migrations/meta/_journal.json` (ensure 0001/0002 present, append 0003)
- Modify: `src/db/schema.ts` (`ads` table block, ~L51–106)

- [ ] **Step 1: Write the migration file.**
  Create `migrations/0003_weight_alloc.sql`:
  ```sql
  -- Phase 1: sponsor weight-split budget.
  --
  -- `weight_alloc` is the sponsor's INTENT (how they choose to split their tier
  -- budget T across banners). regular ads only; default 1; admin/house/placeholder
  -- stay NULL (out of budget). `weight_snapshot` (existing) is the EFFECTIVE deck
  -- weight derived from effectiveWeights(allocs, T) at approve time and on the
  -- nightly cron.
  --
  -- Cross-row budget invariant
  --   Σ weight_alloc over a sponsor's status IN ('pending','approved') regular ads <= T
  -- is NOT expressible as a SQLite CHECK (no cross-row aggregates). It is enforced
  -- in app code under a sponsor-scoped transaction (see ad-submit.ts / submit-modal.ts
  -- / approve.ts). The per-row positivity CHECKs below ARE schema-enforced.
  --
  -- SQLite cannot ADD a column with a CHECK that scans existing rows, and it cannot
  -- ALTER an existing table to add a CHECK at all. We therefore add the column here;
  -- the per-row positivity guards (weight_alloc > 0, weight_snapshot > 0) are encoded
  -- in src/db/schema.ts for new-DB/test creation and asserted in app code on write.
  ALTER TABLE `ads` ADD COLUMN `weight_alloc` INTEGER;
  ```

- [ ] **Step 2: Register the migration in the Drizzle journal so `wrangler d1 migrations apply` runs it.**
  `wrangler` only applies migrations that have an entry in `migrations/meta/_journal.json`. First read it:
  `cat migrations/meta/_journal.json`
  The on-disk migrations are `0000_spicy_guardian.sql`, `0001_ad_stats_daily_view.sql`,
  `0002_serve_rotation.sql`, plus our new `0003_weight_alloc.sql`. As of this writing the journal
  only contains `idx: 0` (the `0000` entry) — `0001` and `0002` exist on disk but are **missing**
  from the journal, so they (and anything after) would not be applied. Ensure `0001` and `0002`
  are present, then append `0003`. Use a deterministic ascending `when` (any monotonically
  increasing epoch-ms is fine; reuse `0000`'s `when` + N as a simple deterministic choice).
  Rewrite `migrations/meta/_journal.json` to:
  ```json
  {
    "version": "7",
    "dialect": "sqlite",
    "entries": [
      { "idx": 0, "version": "6", "when": 1780711206468, "tag": "0000_spicy_guardian", "breakpoints": true },
      { "idx": 1, "version": "6", "when": 1780711206469, "tag": "0001_ad_stats_daily_view", "breakpoints": true },
      { "idx": 2, "version": "6", "when": 1780711206470, "tag": "0002_serve_rotation", "breakpoints": true },
      { "idx": 3, "version": "6", "when": 1780711206471, "tag": "0003_weight_alloc", "breakpoints": true }
    ]
  }
  ```
  Note: if the journal already lists `0001`/`0002` (someone fixed it earlier), keep their existing
  `idx`/`when`/`tag` verbatim and only append the `0003` entry with the next `idx`. The invariant is:
  every `.sql` in `migrations/` has exactly one journal entry, ordered by `idx`, with no gaps.

- [ ] **Step 3: Add `weightAlloc` column to the schema.**
  In `src/db/schema.ts`, in the `ads` table column list, after the `weightSnapshot` line (currently `weightSnapshot: integer('weight_snapshot'),`), add:
  ```ts
    weightAlloc: integer('weight_alloc'),
  ```

- [ ] **Step 4: Add the two positivity CHECK constraints.**
  In `src/db/schema.ts`, inside the `ads` table's constraints object `(t) => ({ ... })`, after the `periodCheck` entry, add:
  ```ts
    weightAllocPositive: check(
      'ads_weight_alloc_positive',
      sql`${t.weightAlloc} IS NULL OR ${t.weightAlloc} > 0`,
    ),
    weightSnapshotPositive: check(
      'ads_weight_snapshot_positive',
      sql`${t.weightSnapshot} IS NULL OR ${t.weightSnapshot} > 0`,
    ),
  ```

- [ ] **Step 5: Typecheck.**
  `npx tsc --noEmit`
  Expected: no errors (schema is type-only at compile time).

- [ ] **Step 6: Confirm existing tests still pass (schema/migration are additive).**
  `npx vitest run tests/serve/pick.test.ts tests/sponsors/tier-budget.test.ts`
  Expected: all passed.

- [ ] **Step 7: Commit.**
  `git add migrations/0003_weight_alloc.sql migrations/meta/_journal.json src/db/schema.ts && git commit -m "feat(db): add ads.weight_alloc + positivity CHECKs + journal entries"`

---

### Task 4: review-query helpers for sibling read + effective-weight write + atomic approve

`approve.ts` and the cron both need (a) the sponsor's active regular allocs and (b) a way to persist `effectiveWeights` output. `approve.ts` additionally needs (c) an **atomic, single-statement conditional `UPDATE`** that flips `pending → approved` only when the sponsor's budget still fits — because **D1 has no interactive transactions or row locks** (the Workers D1 client makes `BEGIN`/`COMMIT` effectively no-ops), so a read-then-write budget check does NOT serialize. SQLite executes one statement atomically and is single-writer, so a conditional `UPDATE ... WHERE (SUM subquery) <= T` is the correct concurrency primitive. Put all three in `src/db/queries/review.ts` so the SQL lives in one place.

**Files:**
- Modify: `src/db/queries/review.ts` (append)
- Test: `tests/services/review/approve-budget.test.ts` (Create — shared mock helper defined here, reused in Task 5)

- [ ] **Step 1: Write failing test for `getSponsorActiveRegularAllocs`.**
  Create `tests/services/review/approve-budget.test.ts`:
  ```ts
  import { describe, expect, it, vi } from 'vitest';
  import type { PgClient } from '../../../src/db/client.ts';
  import {
    applyEffectiveWeights,
    getSponsorActiveRegularAllocs,
  } from '../../../src/db/queries/review.ts';

  type CapturedCall = { sql: string; params: unknown[] | undefined };
  function mockClient(
    responses: Array<{ rows: unknown[]; rowCount?: number }>,
    captured: CapturedCall[] = [],
  ): PgClient {
    let i = 0;
    return {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        const r = responses[i++];
        if (!r) return { rows: [], rowCount: 0 };
        return { rowCount: r.rowCount ?? r.rows.length, ...r };
      }) as unknown as PgClient['query'],
      end: vi.fn(async () => undefined),
    };
  }

  describe('getSponsorActiveRegularAllocs', () => {
    it('returns {id, weightAlloc} for pending+approved regular non-admin ads', async () => {
      const captured: CapturedCall[] = [];
      const client = mockClient(
        [{ rows: [{ id: 'a', weight_alloc: 50 }, { id: 'b', weight_alloc: 20 }] }],
        captured,
      );
      const rows = await getSponsorActiveRegularAllocs(client, 'sp-1');
      expect(rows).toEqual([
        { id: 'a', weightAlloc: 50 },
        { id: 'b', weightAlloc: 20 },
      ]);
      expect(captured[0]?.params).toEqual(['sp-1']);
      expect(captured[0]?.sql).toMatch(/kind = 'regular'/);
      expect(captured[0]?.sql).toMatch(/status IN \('pending', 'approved'\)/);
      expect(captured[0]?.sql).toMatch(/created_by_admin IS NULL/);
    });

    it('coerces NULL weight_alloc to 1 (legacy rows / default intent)', async () => {
      const client = mockClient([{ rows: [{ id: 'a', weight_alloc: null }] }]);
      const rows = await getSponsorActiveRegularAllocs(client, 'sp-1');
      expect(rows).toEqual([{ id: 'a', weightAlloc: 1 }]);
    });
  });
  ```

- [ ] **Step 2: Run to confirm FAIL.**
  `npx vitest run tests/services/review/approve-budget.test.ts`
  Expected: FAIL — exports not found.

- [ ] **Step 3: Implement `getSponsorActiveRegularAllocs`.**
  Append to `src/db/queries/review.ts`:
  ```ts
  export type ActiveAlloc = { id: string; weightAlloc: number };

  /**
   * The sponsor's regular, non-admin ads currently holding budget (pending or
   * approved), with their intended weight_alloc. NULL alloc (legacy rows or the
   * implicit default) is coerced to 1. Ordered by id for deterministic
   * effectiveWeights output. Read inside the caller's transaction.
   */
  export async function getSponsorActiveRegularAllocs(
    client: PgClient,
    sponsorId: string,
  ): Promise<ActiveAlloc[]> {
    const res = await client.query<{ id: string; weight_alloc: number | null }>(
      `SELECT id, weight_alloc
         FROM ads
        WHERE sponsor_id = ?
          AND kind = 'regular'
          AND created_by_admin IS NULL
          AND status IN ('pending', 'approved')
        ORDER BY id`,
      [sponsorId],
    );
    return res.rows.map((r) => ({ id: r.id, weightAlloc: r.weight_alloc ?? 1 }));
  }
  ```

- [ ] **Step 4: Run to confirm PASS.**
  `npx vitest run tests/services/review/approve-budget.test.ts`
  Expected: `getSponsorActiveRegularAllocs` cases passed.

- [ ] **Step 5: Commit.**
  `git add src/db/queries/review.ts tests/services/review/approve-budget.test.ts && git commit -m "feat(review): getSponsorActiveRegularAllocs query"`

- [ ] **Step 6: Write failing test for `applyEffectiveWeights`.**
  Append to `tests/services/review/approve-budget.test.ts`:
  ```ts
  describe('applyEffectiveWeights', () => {
    it('UPDATEs weight_snapshot per id and pauses the listed ids', async () => {
      const captured: CapturedCall[] = [];
      const client = mockClient([{ rows: [] }, { rows: [] }, { rows: [] }], captured);
      await applyEffectiveWeights(
        client,
        [
          { id: 'a', weightSnapshot: 25 },
          { id: 'b', weightSnapshot: 10 },
        ],
        ['c'],
      );
      // two weight UPDATEs + one pause UPDATE
      const weightUpdates = captured.filter((c) => /SET weight_snapshot = \?/.test(c.sql));
      expect(weightUpdates).toHaveLength(2);
      expect(weightUpdates[0]?.params).toEqual([25, 'a']);
      expect(weightUpdates[1]?.params).toEqual([10, 'b']);
      const pause = captured.find((c) => /SET status = 'paused'/.test(c.sql));
      expect(pause?.params).toEqual(['c']);
    });

    it('skips the pause UPDATE when nothing is paused', async () => {
      const captured: CapturedCall[] = [];
      const client = mockClient([{ rows: [] }], captured);
      await applyEffectiveWeights(client, [{ id: 'a', weightSnapshot: 5 }], []);
      expect(captured.some((c) => /SET status = 'paused'/.test(c.sql))).toBe(false);
    });
  });
  ```

- [ ] **Step 7: Run to confirm FAIL.**
  `npx vitest run tests/services/review/approve-budget.test.ts`
  Expected: FAIL — `applyEffectiveWeights is not a function`.

- [ ] **Step 8: Implement `applyEffectiveWeights`.**
  Append to `src/db/queries/review.ts`:
  ```ts
  /**
   * Persist effectiveWeights() output: set weight_snapshot per surviving id and
   * move paused ids to status='paused' (one UPDATE per id keeps `?`-placeholder
   * binding simple and avoids a dynamic IN list). Caller runs this inside its
   * transaction.
   */
  export async function applyEffectiveWeights(
    client: PgClient,
    weights: Array<{ id: string; weightSnapshot: number }>,
    paused: string[],
  ): Promise<void> {
    for (const w of weights) {
      await client.query('UPDATE ads SET weight_snapshot = ? WHERE id = ?', [
        w.weightSnapshot,
        w.id,
      ]);
    }
    for (const id of paused) {
      await client.query(
        `UPDATE ads
            SET status = 'paused'
          WHERE id = ?`,
        [id],
      );
    }
  }
  ```

- [ ] **Step 9: Run to confirm PASS.**
  `npx vitest run tests/services/review/approve-budget.test.ts`
  Expected: all cases passed.

- [ ] **Step 10: Typecheck and commit.**
  `npx tsc --noEmit && git add src/db/queries/review.ts tests/services/review/approve-budget.test.ts && git commit -m "feat(review): applyEffectiveWeights writer (snapshot + smallest-first pause)"`

- [ ] **Step 11: Write failing test for the atomic conditional approve `UPDATE`.**
  Append to `tests/services/review/approve-budget.test.ts`:
  ```ts
  import { approvePendingWithinBudget } from '../../../src/db/queries/review.ts';

  const AD = '11111111-1111-1111-1111-111111111111';

  describe('approvePendingWithinBudget', () => {
    it('flips pending->approved and returns approved when budget fits (changes=1)', async () => {
      const captured: CapturedCall[] = [];
      const client = mockClient([{ rows: [], rowCount: 1 }], captured);
      const r = await approvePendingWithinBudget(client, AD, 'sp-1', 8, 'rev-1');
      expect(r).toBe('approved');
      // Single atomic statement: UPDATE ... SET status='approved' WHERE status='pending'
      // AND ((SUM over OTHER pending/approved regular non-admin allocs) + ?) <= tier weight.
      expect(captured).toHaveLength(1);
      const sql = captured[0]?.sql ?? '';
      expect(sql).toMatch(/UPDATE ads/);
      expect(sql).toMatch(/SET status = 'approved'/);
      expect(sql).toMatch(/status = 'pending'/);
      expect(sql).toMatch(/COALESCE\(SUM\(weight_alloc\), 0\)/);
      expect(sql).toMatch(/created_by_admin IS NULL/);
      expect(sql).toMatch(/status IN \('pending', 'approved'\)/);
      // params: [reviewerId, adId(for UPDATE WHERE), this ad's alloc, sponsorId, adId(SUM exclude)] etc.
      expect(captured[0]?.params).toContain(AD);
      expect(captured[0]?.params).toContain('sp-1');
      expect(captured[0]?.params).toContain(8);
    });

    it('returns budget_exceeded when the conditional UPDATE matches 0 rows and the ad is still pending', async () => {
      const captured: CapturedCall[] = [];
      const client = mockClient(
        [
          { rows: [], rowCount: 0 }, // conditional UPDATE matched nothing
          { rows: [{ status: 'pending' }] }, // disambiguation read: still pending => budget
        ],
        captured,
      );
      const r = await approvePendingWithinBudget(client, AD, 'sp-1', 99, 'rev-1');
      expect(r).toBe('budget_exceeded');
    });

    it('returns race when the conditional UPDATE matches 0 rows and the ad is no longer pending', async () => {
      const client = mockClient([
        { rows: [], rowCount: 0 }, // conditional UPDATE matched nothing
        { rows: [{ status: 'approved' }] }, // already moved by another reviewer
      ]);
      const r = await approvePendingWithinBudget(client, AD, 'sp-1', 1, 'rev-1');
      expect(r).toBe('race');
    });

    it('returns race when the disambiguation read finds no row at all', async () => {
      const client = mockClient([
        { rows: [], rowCount: 0 },
        { rows: [] }, // row vanished
      ]);
      expect(await approvePendingWithinBudget(client, AD, 'sp-1', 1, 'rev-1')).toBe('race');
    });
  });
  ```

- [ ] **Step 12: Run to confirm FAIL.**
  `npx vitest run tests/services/review/approve-budget.test.ts`
  Expected: FAIL — `approvePendingWithinBudget is not a function`.

- [ ] **Step 13: Implement `approvePendingWithinBudget`.**
  Append to `src/db/queries/review.ts`:
  ```ts
  export type ApproveOutcome = 'approved' | 'budget_exceeded' | 'race';

  /**
   * Atomic, single-statement conditional approve. D1/SQLite has no interactive
   * transactions or row locks (the Workers D1 client makes BEGIN/COMMIT no-ops),
   * so a read-then-write budget check does NOT serialize. SQLite runs ONE
   * statement atomically and is single-writer, so this conditional UPDATE is the
   * correct concurrency primitive: it flips pending->approved only when the ad is
   * still pending AND Σ weight_alloc over the sponsor's OTHER pending/approved
   * regular non-admin ads, plus this ad's alloc, is still <= the live tier weight.
   *
   * `meta.changes` (rowCount) == 1  => approved.
   * == 0 => either the budget no longer fits (tier shrank since submit) OR another
   *   reviewer already moved the row. We disambiguate with ONE follow-up read of
   *   the ad's status (the write already failed atomically, so this read cannot
   *   reintroduce a TOCTOU): still 'pending' => 'budget_exceeded', else 'race'.
   *
   * Note: starts_at uses `(unixepoch() * 1000)` (D1 epoch-ms), NOT the Postgres
   * `now()`; reviewed_at/reviewed_by are set here too so the whole approve write is
   * one atomic statement.
   */
  export async function approvePendingWithinBudget(
    client: PgClient,
    adId: string,
    sponsorId: string,
    thisAlloc: number,
    reviewerId: string,
  ): Promise<ApproveOutcome> {
    const res = await client.query(
      `UPDATE ads
          SET status = 'approved',
              reviewed_by = ?,
              reviewed_at = (unixepoch() * 1000),
              starts_at = (unixepoch() * 1000)
        WHERE id = ?
          AND status = 'pending'
          AND (
            (SELECT COALESCE(SUM(weight_alloc), 0)
               FROM ads
              WHERE sponsor_id = ?
                AND kind = 'regular'
                AND created_by_admin IS NULL
                AND status IN ('pending', 'approved')
                AND id != ?) + ?
          ) <= (SELECT t.weight
                  FROM sponsors s
                  JOIN tiers t ON t.id = s.current_tier_id
                 WHERE s.discord_user_id = ?)`,
      [reviewerId, adId, sponsorId, adId, thisAlloc, sponsorId],
    );
    if ((res.rowCount ?? 0) === 1) return 'approved';
    const probe = await client.query<{ status: string }>(
      'SELECT status FROM ads WHERE id = ?',
      [adId],
    );
    return probe.rows[0]?.status === 'pending' ? 'budget_exceeded' : 'race';
  }
  ```

- [ ] **Step 14: Run to confirm PASS.**
  `npx vitest run tests/services/review/approve-budget.test.ts`
  Expected: all `approvePendingWithinBudget` cases passed.

- [ ] **Step 15: Typecheck and commit.**
  `npx tsc --noEmit && git add src/db/queries/review.ts tests/services/review/approve-budget.test.ts && git commit -m "feat(review): atomic conditional approve (single-statement budget guard)"`

---

### Task 5: approve.ts — atomic budget-guarded approve + effectiveWeights write + `budget_exceeded`

Replace "freeze whole tier weight onto the ad" with: flip `pending → approved` atomically via `approvePendingWithinBudget` (the single-statement budget guard from Task 4 — **no `REPEATABLE READ` tx**, because D1 has none), then read the sponsor's active allocs (including this just-approved ad), run `effectiveWeights`, persist via `applyEffectiveWeights`, and return `budget_exceeded` when the guarded UPDATE matched 0 rows because the tier shrank. Also delete the stale Postgres strings (`BEGIN ISOLATION LEVEL REPEATABLE READ`, `starts_at = now()`).

**Files:**
- Modify: `src/services/review/approve.ts`
- Test: `tests/services/review/approve-budget.test.ts` (extend)

- [ ] **Step 1: Write failing test for `budget_exceeded` (atomic UPDATE matched 0 rows, ad still pending).**
  Append to `tests/services/review/approve-budget.test.ts`:
  ```ts
  import { approveAd } from '../../../src/services/review/approve.ts';

  const AD_ID = '11111111-1111-1111-1111-111111111111';
  const REVIEWER = 'rev-1';

  describe('approveAd budget', () => {
    it('returns budget_exceeded when the atomic conditional UPDATE matches 0 rows (tier shrank)', async () => {
      const captured: CapturedCall[] = [];
      const client = mockClient(
        [
          // lookup: sponsor + tier weight + this ad's alloc
          { rows: [{ sponsor_id: 'sp-1', status: 'pending', weight: 10, weight_alloc: 8 }] },
          // approvePendingWithinBudget: conditional UPDATE matches nothing
          { rows: [], rowCount: 0 },
          // disambiguation probe: ad still pending => budget, not race
          { rows: [{ status: 'pending' }] },
        ],
        captured,
      );
      const result = await approveAd(client, AD_ID, REVIEWER);
      expect(result).toEqual({ ok: false, reason: 'budget_exceeded' });
      // No effectiveWeights write and no COMMIT/BEGIN noise (D1 has no interactive tx).
      expect(captured.every((c) => !/SET weight_snapshot = \?/.test(c.sql))).toBe(true);
      expect(captured.every((c) => !/SET status = 'paused'/.test(c.sql))).toBe(true);
      expect(captured.every((c) => !/BEGIN ISOLATION LEVEL REPEATABLE READ/.test(c.sql))).toBe(true);
    });

    it('returns race when the atomic UPDATE matches 0 rows and the ad is no longer pending', async () => {
      const client = mockClient([
        { rows: [{ sponsor_id: 'sp-1', status: 'pending', weight: 10, weight_alloc: 1 }] }, // lookup
        { rows: [], rowCount: 0 }, // conditional UPDATE
        { rows: [{ status: 'approved' }] }, // already moved by another reviewer
      ]);
      const result = await approveAd(client, AD_ID, REVIEWER);
      expect(result).toEqual({ ok: false, reason: 'race' });
    });
  });
  ```

- [ ] **Step 2: Run to confirm FAIL.**
  `npx vitest run tests/services/review/approve-budget.test.ts`
  Expected: FAIL — `budget_exceeded`/`race` not yet produced this way; current code uses `BEGIN ISOLATION LEVEL REPEATABLE READ` + freeze-weight.

- [ ] **Step 3: Update `ApproveResult`, the lookup, and rewrite the approve body (atomic, no tx).**
  In `src/services/review/approve.ts`:
  - Change the result type:
    ```ts
    export type ApproveResult =
      | { ok: true; weightSnapshot: number; startsAt: Date }
      | { ok: false; reason: 'not_found' | 'no_sponsor' | 'no_tier' | 'race' | 'budget_exceeded' };
    ```
  - Replace the imports at the top so `review.ts` is imported once and `effectiveWeights` is available:
    ```ts
    import {
      applyEffectiveWeights,
      approvePendingWithinBudget,
      getSponsorActiveRegularAllocs,
      insertReviewLog,
    } from '../../db/queries/review.ts';
    import { effectiveWeights } from '../../sponsors/tier.ts';
    ```
    (drop the old `import { insertReviewLog, updateAdStatusOptimistic } ...` line — `updateAdStatusOptimistic` is no longer used here.)
  - Extend `AdLookup` and `lookupAdAndTierWeight` to also read this ad's alloc:
    ```ts
    type AdLookup = {
      sponsorId: string | null;
      status: string;
      weight: number | null; // tiers.weight via JOIN
      weightAlloc: number;   // this ad's intended alloc (NULL coerced to 1)
    };
    ```
    In the SELECT, add `a.weight_alloc` to the column list and the row generic
    (`weight_alloc: number | null;`), and return `weightAlloc: row.weight_alloc ?? 1`.
  - Replace the **entire body** of `approveAd` (the `BEGIN ... try ... COMMIT ... catch` block) with the tx-free atomic flow:
    ```ts
    export async function approveAd(
      client: PgClient,
      adId: string,
      reviewerId: string,
    ): Promise<ApproveResult> {
      // D1 has no interactive transactions or row locks, so we do NOT wrap this in
      // BEGIN/COMMIT (those are no-ops on the Workers D1 client and would be
      // misleading). Concurrency safety comes from the single-statement atomic
      // conditional UPDATE in approvePendingWithinBudget.
      const lookup = await lookupAdAndTierWeight(client, adId);
      if (!lookup) return { ok: false, reason: 'not_found' };
      if (!lookup.sponsorId) return { ok: false, reason: 'no_sponsor' };
      if (lookup.weight === null) return { ok: false, reason: 'no_tier' };

      // Atomic, budget-guarded flip pending -> approved. pending already reserved
      // budget at submit time, so this only fails if the tier shrank since then.
      const outcome = await approvePendingWithinBudget(
        client,
        adId,
        lookup.sponsorId,
        lookup.weightAlloc,
        reviewerId,
      );
      if (outcome === 'budget_exceeded') return { ok: false, reason: 'budget_exceeded' };
      if (outcome === 'race') return { ok: false, reason: 'race' };

      // Now approved: derive + persist effective deck weights for the whole sponsor
      // so the newly approved banner and its siblings stay consistent. S <= T here
      // (the guard held), so no pause; we still call applyEffectiveWeights for the
      // single source of truth shared with the cron.
      const allocs = await getSponsorActiveRegularAllocs(client, lookup.sponsorId);
      const eff = effectiveWeights(allocs, lookup.weight);
      await applyEffectiveWeights(client, eff.weights, eff.paused);
      const mine = eff.weights.find((w) => w.id === adId);
      const weightSnapshot = mine?.weightSnapshot ?? 0;

      const startsRes = await client.query<{ starts_at: Date }>(
        'SELECT starts_at FROM ads WHERE id = ?',
        [adId],
      );
      const startsAt = startsRes.rows[0]?.starts_at ?? new Date();

      await insertReviewLog(client, adId, reviewerId, 'approved', null);
      return { ok: true, weightSnapshot, startsAt };
    }
    ```

- [ ] **Step 4: Run to confirm the budget_exceeded + race tests PASS.**
  `npx vitest run tests/services/review/approve-budget.test.ts`
  Expected: the new cases passed.

- [ ] **Step 5: Write failing happy-path test (atomic approve + effective weight write).**
  Append to `tests/services/review/approve-budget.test.ts` inside `describe('approveAd budget', ...)`:
  ```ts
    it('happy path: atomic approve, then writes effective weight_snapshot for the approved ad', async () => {
      const captured: CapturedCall[] = [];
      const startsAt = new Date('2026-06-08T00:00:00.000Z');
      const client = mockClient(
        [
          // lookup
          { rows: [{ sponsor_id: 'sp-1', status: 'pending', weight: 80, weight_alloc: 50 }] },
          // approvePendingWithinBudget conditional UPDATE -> 1 row (approved)
          { rows: [], rowCount: 1 },
          // getSponsorActiveRegularAllocs Σ=70 <= 80
          { rows: [{ id: AD_ID, weight_alloc: 50 }, { id: 'other', weight_alloc: 20 }] },
          // applyEffectiveWeights UPDATE id=AD_ID
          { rows: [] },
          // applyEffectiveWeights UPDATE id=other
          { rows: [] },
          // SELECT starts_at
          { rows: [{ starts_at: startsAt }] },
          // INSERT review_logs
          { rows: [] },
        ],
        captured,
      );
      const result = await approveAd(client, AD_ID, REVIEWER);
      expect(result).toEqual({ ok: true, weightSnapshot: 50, startsAt });
      // The atomic approve UPDATE ran with status='approved' guard + SUM subquery.
      const approveUpdate = captured.find((c) => /SET status = 'approved'/.test(c.sql));
      expect(approveUpdate?.sql).toMatch(/COALESCE\(SUM\(weight_alloc\), 0\)/);
      expect(approveUpdate?.sql).toMatch(/starts_at = \(unixepoch/);
      expect(approveUpdate?.sql).not.toMatch(/now\(\)/);
      // effective weight_snapshot for this ad is its alloc (S<=T branch).
      const w = captured.find(
        (c) => /SET weight_snapshot = \?/.test(c.sql) && c.params?.[1] === AD_ID,
      );
      expect(w?.params?.[0]).toBe(50);
      // No Postgres tx control statements.
      expect(captured.every((c) => !/^BEGIN/.test(c.sql) && !/^COMMIT/.test(c.sql))).toBe(true);
    });
  ```

- [ ] **Step 6: Run to confirm PASS (implementation already covers it).**
  `npx vitest run tests/services/review/approve-budget.test.ts`
  Expected: all `approveAd budget` cases passed.

- [ ] **Step 7: Reconcile the legacy approve test (`tests/services/review/approve.test.ts`).**
  The legacy file asserts the old Postgres-era flow. Rewrite its expectations to the new atomic, tx-free flow. Make these EXACT changes (do not leave conditional language):
  - **Remove every `expect(captured[...]?.sql).toMatch(/^BEGIN ISOLATION LEVEL REPEATABLE READ/)` and `/^ROLLBACK/` / `/^COMMIT/` assertion** — there is no BEGIN/ROLLBACK/COMMIT anymore. The error branches (`not_found`, `no_sponsor`, `no_tier`) just return early.
  - **`not_found` case** — responses become a single lookup returning `{ rows: [] }`; assert `captured` has length 1 and `captured[0]?.sql` matches `/FROM ads a/`; assert no `UPDATE`, no `INSERT INTO review_logs`.
  - **`no_sponsor` case** — single lookup row `{ sponsor_id: null, status: 'pending', weight: 5, weight_alloc: 1 }`; expect `{ ok:false, reason:'no_sponsor' }`; `captured` length 1.
  - **`no_tier` case** — single lookup row `{ sponsor_id: 'sponsor-1', status: 'pending', weight: null, weight_alloc: 1 }`; expect `no_tier`; `captured` length 1.
  - **`race` case** — responses: lookup `{ sponsor_id:'sponsor-1', status:'pending', weight:7, weight_alloc:1 }`, then conditional UPDATE `{ rows:[], rowCount:0 }`, then probe `{ rows:[{ status:'approved' }] }`; expect `{ ok:false, reason:'race' }`; assert no `weight_snapshot` UPDATE and no review_logs INSERT.
  - **`happy path` case** — responses:
    ```ts
    { rows: [{ sponsor_id: 'sponsor-1', status: 'pending', weight: 7, weight_alloc: 7 }] }, // lookup
    { rows: [], rowCount: 1 },                                  // atomic approve UPDATE
    { rows: [{ id: AD_ID, weight_alloc: 7 }] },                 // getSponsorActiveRegularAllocs
    { rows: [] },                                               // applyEffectiveWeights UPDATE
    { rows: [{ starts_at: persistedStartsAt }] },               // SELECT starts_at
    { rows: [] },                                               // INSERT review_logs
    ```
    expect `{ ok:true, weightSnapshot:7, startsAt: persistedStartsAt }`. Replace the old
    `expect(update?.sql).toMatch(/starts_at = now\(\)/)` and `/weight_snapshot = \$/` assertions
    with: the approve UPDATE matches `/SET status = 'approved'/` and `/starts_at = \(unixepoch/`;
    the `weight_snapshot` is written by a SEPARATE `UPDATE ads SET weight_snapshot = ?` (from
    applyEffectiveWeights) whose `params` are `[7, AD_ID]`. Keep the `SELECT starts_at` and
    `INSERT INTO review_logs` param assertions (`[AD_ID, REVIEWER_ID, 'approved', null]`).
  - **`fallback to new Date()` case** — same as happy path but the `SELECT starts_at` response is `{ rows: [] }`; assert `result.ok === true`, `weightSnapshot === 7`, `startsAt instanceof Date`.
  - **`weight=0` case** — the legacy lookup `{ ..., weight: 0, weight_alloc: 0 }` is no longer valid (`weight_alloc > 0` CHECK) and the old "weight=0 is a valid frozen snapshot" semantics are gone. With the atomic guard, a tier weight of 0 cannot fit any alloc ≥ 1, so the guard rejects. Rewrite this case to assert the tier-weight-0 rejection: lookup `{ sponsor_id:'sponsor-1', status:'pending', weight: 0, weight_alloc: 1 }`, then the conditional UPDATE matches 0 rows (`{ rows:[], rowCount:0 }`) because `(0 + 1) <= 0` is false, then the probe finds it still pending (`{ rows:[{ status:'pending' }] }`); expect `{ ok:false, reason:'budget_exceeded' }`. Rename the test to reflect the new semantics (e.g. `'tier weight 0 rejects approval as budget_exceeded'`).

- [ ] **Step 8: Run both approve test files to confirm PASS.**
  `npx vitest run tests/services/review/approve.test.ts tests/services/review/approve-budget.test.ts`
  Expected: all passed.

- [ ] **Step 9: Surface `budget_exceeded` in the approve button.**
  In `src/interactions/buttons/review-approve-button.ts`, in the `if (!result.ok)` ternary (~L105–112), add a branch before the final fallback:
  ```ts
            : result.reason === 'no_tier'
              ? '対象スポンサーにティアロールが付与されていません。'
              : result.reason === 'budget_exceeded'
                ? 'スポンサーの重み予算を超過しています（ティア降格の可能性）。配分を見直してください。'
                : '他のレビュアーが既に処理しました。';
  ```

- [ ] **Step 10: Typecheck, run approve button tests, commit.**
  `npx tsc --noEmit && npx vitest run tests/interactions/buttons/review-approve-button.test.ts tests/services/review/approve.test.ts tests/services/review/approve-budget.test.ts && git add src/services/review/approve.ts src/interactions/buttons/review-approve-button.ts tests/services/review/approve.test.ts tests/services/review/approve-budget.test.ts && git commit -m "feat(approve): atomic budget-guarded approve + effectiveWeights write + budget_exceeded"`

---

### Task 6: `/ad submit` weight option + register-commands + submit pre-check

Add the `weight` slash option, thread it into the draft, and convert the count-only gate into a budget pre-check.

**Files:**
- Modify: `scripts/register-commands.ts` (~L29–47)
- Modify: `src/interactions/commands/ad-submit.ts`
- Test: `tests/interactions/commands/ad-submit-budget.test.ts` (Create)

- [ ] **Step 1: Add the `weight` option to register-commands.**
  In `scripts/register-commands.ts`, inside the `submit` subcommand's `options` array (after the `image` ATTACHMENT option, ~L46), add:
  ```ts
          {
            name: 'weight',
            description: '重み（1-1000、規定: 1）。残り予算を超えると拒否されます',
            type: 4, // INTEGER
            required: false,
            min_value: 1,
            max_value: 1000,
          },
  ```

- [ ] **Step 2: Write failing test for the submit budget pre-check.**
  Create `tests/interactions/commands/ad-submit-budget.test.ts`. It mirrors the
  `tests/interactions/commands/ad-submit.test.ts` harness exactly (same `mockClient`, `mockRest`,
  `mockS3`, `PNG_HEADER`, `mockFetchOk`, `buildAttachment`, `invoke`, `formatRulesRow`). The only
  difference is `buildPayload` adds a `weight` INTEGER option and the response sequence now feeds
  `getSponsorBudget` (a tier-JOIN SELECT then a `SUM(weight_alloc)` SELECT) where the old test fed
  `countActiveAds`. The query order after the budget pre-check replaces step 4 is:
  `1) fallback gate, 2) tiers (refreshSponsorTier), 3) upsert sponsors, 4) getSponsorBudget tier-JOIN,
  5) getSponsorBudget sumActiveWeight, 6) fetchFormatRules, 7) INSERT ad_drafts`.
  ```ts
  import type { S3Client } from '@aws-sdk/client-s3';
  import { Hono } from 'hono';
  import { describe, expect, it, vi } from 'vitest';
  import type { PgClient } from '../../../src/db/client.ts';
  import type { DiscordRest } from '../../../src/discord/rest.ts';
  import type {
    ApplicationCommandInteractionPayload,
    Attachment,
  } from '../../../src/discord/types.ts';
  import type { Bindings } from '../../../src/env.ts';
  import { type AdSubmitDeps, runAdSubmit } from '../../../src/interactions/commands/ad-submit.ts';

  type CapturedCall = { sql: string; params: unknown[] | undefined };

  function mockClient(
    responses: Array<{ rows: unknown[] }>,
    captured: CapturedCall[] = [],
  ): PgClient {
    let i = 0;
    return {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        return responses[i++] ?? { rows: [] };
      }) as unknown as PgClient['query'],
      end: vi.fn(async () => undefined),
    };
  }

  function mockRest(roles: string[] = ['role-bronze']): DiscordRest {
    return {
      getGuildMember: vi.fn(async () => ({
        user: { id: 'user-1', username: 'sponsor-display' },
        roles,
      })),
    } as unknown as DiscordRest;
  }

  function mockS3(): S3Client {
    return { send: vi.fn(async () => ({})) } as unknown as S3Client;
  }

  const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

  function mockFetchOk(body: Uint8Array): typeof fetch {
    return vi.fn<typeof fetch>(
      async () =>
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
    );
  }

  function buildAttachment(overrides: Partial<Attachment> = {}): Attachment {
    return {
      id: 'att-1',
      url: 'https://cdn.discordapp.com/attachments/1/2/foo.png',
      filename: 'foo.png',
      content_type: 'image/png',
      size: 500_000,
      width: 800,
      height: 800,
      ...overrides,
    };
  }

  function buildPayload(weight?: number): ApplicationCommandInteractionPayload {
    const attachment = buildAttachment();
    const options: Array<{ name: string; type: number; value: unknown }> = [
      { name: 'slot', type: 3, value: 'default' },
      { name: 'image', type: 11, value: attachment.id },
    ];
    if (weight !== undefined) options.push({ name: 'weight', type: 4, value: weight });
    return {
      type: 2,
      id: 'int-1',
      application_id: 'app-1',
      guild_id: 'guild-1',
      channel_id: 'chan-1',
      member: { user: { id: 'user-1', username: 'sponsor-display' }, roles: [] },
      data: {
        id: 'cmd-1',
        name: 'ad',
        type: 1,
        options: [{ name: 'submit', type: 1, options }],
        resolved: { attachments: { [attachment.id]: attachment } },
      },
    };
  }

  const tierRow = {
    id: 1,
    discordRoleId: 'role-bronze',
    name: 'Bronze',
    weight: 80,
    maxActiveAds: 80,
    rank: 10,
  };

  const formatRulesRow = {
    slot: 'default',
    allowedMimes: ['image/png', 'image/jpeg'],
    allowedExtensions: ['png', 'jpg', 'jpeg'],
    maxBytes: 1_000_000,
    minWidth: 200,
    maxWidth: 2000,
    minHeight: 200,
    maxHeight: 2000,
    aspectRatios: ['1:1'],
    aspectTolerance: 0.02,
    titleMaxLen: 80,
    bodyMaxLen: 500,
    linkUrlMaxLen: 2048,
    linkScheme: ['https'],
    linkDomainAllowlist: null,
    linkDomainBlocklist: null,
  };

  async function invoke(
    payload: ApplicationCommandInteractionPayload,
    deps: AdSubmitDeps,
  ): Promise<Response> {
    const app = new Hono<{ Bindings: Bindings }>();
    app.post('/', (c) => runAdSubmit(c, payload, deps));
    return app.request('http://test/', { method: 'POST' });
  }

  function deps(client: PgClient): AdSubmitDeps {
    return {
      client,
      rest: mockRest(['role-bronze']),
      s3: mockS3(),
      bucket: 'test-bucket',
      guildId: 'guild-1',
      fetchImpl: mockFetchOk(PNG_HEADER),
      uuid: () => '00000000-0000-0000-0000-000000000001',
    };
  }

  describe('runAdSubmit budget gate', () => {
    it('rejects when requested weight exceeds remaining budget', async () => {
      const captured: CapturedCall[] = [];
      const client = mockClient(
        [
          { rows: [] }, // fallback gate
          { rows: [tierRow] }, // tiers (refreshSponsorTier)
          { rows: [] }, // upsert sponsors
          { rows: [{ weight: 80 }] }, // getSponsorBudget: tier JOIN
          { rows: [{ used: 80 }] }, // getSponsorBudget: sumActiveWeight => remaining 0
        ],
        captured,
      );
      const res = await invoke(buildPayload(1), deps(client));
      const json = (await res.json()) as { type: number; data: { content: string } };
      expect(json.type).toBe(4);
      expect(json.data.content).toContain('予算');
      // Gate fired before format rules / draft insert.
      expect(captured.every((c) => !/INSERT INTO ad_drafts/.test(c.sql))).toBe(true);
    });

    it('passes the gate and stores weight_alloc intent (weight) in the draft when within budget', async () => {
      const captured: CapturedCall[] = [];
      const client = mockClient(
        [
          { rows: [] }, // fallback gate
          { rows: [tierRow] }, // tiers
          { rows: [] }, // upsert sponsors
          { rows: [{ weight: 80 }] }, // getSponsorBudget: tier JOIN
          { rows: [{ used: 30 }] }, // getSponsorBudget: sumActiveWeight => remaining 50
          { rows: [formatRulesRow] }, // fetchFormatRules
          { rows: [] }, // INSERT ad_drafts
        ],
        captured,
      );
      const res = await invoke(buildPayload(20), deps(client));
      expect(res.status).toBe(200);
      const json = (await res.json()) as { type: number };
      expect(json.type).toBe(9); // Modal
      const insert = captured.find((c) => /INSERT INTO ad_drafts/.test(c.sql));
      expect(insert).toBeDefined();
      // weight is the 4th column/param (id, sponsor_id, slot, weight, ...).
      expect(insert?.params?.[3]).toBe(20);
    });

    it('defaults weight to 1 when the option is omitted', async () => {
      const captured: CapturedCall[] = [];
      const client = mockClient(
        [
          { rows: [] }, // fallback gate
          { rows: [tierRow] }, // tiers
          { rows: [] }, // upsert sponsors
          { rows: [{ weight: 80 }] }, // tier JOIN
          { rows: [{ used: 0 }] }, // remaining 80
          { rows: [formatRulesRow] }, // rules
          { rows: [] }, // insert
        ],
        captured,
      );
      await invoke(buildPayload(), deps(client));
      const insert = captured.find((c) => /INSERT INTO ad_drafts/.test(c.sql));
      expect(insert?.params?.[3]).toBe(1);
    });
  });
  ```

- [ ] **Step 3: Run to confirm FAIL.**
  `npx vitest run tests/interactions/commands/ad-submit-budget.test.ts`
  Expected: FAIL (gate not implemented; draft INSERT lacks `weight`).

- [ ] **Step 4: Parse the `weight` option.**
  In `src/interactions/commands/ad-submit.ts`, after the `imageId` extraction (~L83), add:
  ```ts
    const weightOpt = findOption(submitCmd?.options, 'weight');
    const requestedWeight =
      typeof weightOpt?.value === 'number' && Number.isInteger(weightOpt.value) && weightOpt.value >= 1
        ? weightOpt.value
        : 1;
  ```

- [ ] **Step 5: Replace the count gate with a budget pre-check.**
  In `src/interactions/commands/ad-submit.ts`, replace the import line
  `import { type Tier, checkMaxActiveAds, countActiveAds, refreshSponsorTier } from '../../sponsors/tier.ts';`
  with:
  ```ts
  import { type Tier, getSponsorBudget, refreshSponsorTier } from '../../sponsors/tier.ts';
  ```
  Then replace the "5. Active ad count + max check" block (the `countActiveAds` + `checkMaxActiveAds` lines, ~L122–127) with:
  ```ts
    // 5. Budget pre-check (best-effort; submit-modal re-checks transactionally).
    // tier-less sponsors never reach here (refreshSponsorTier returned a tier),
    // so getSponsorBudget should be non-null; treat null defensively as "allow".
    const budget = await getSponsorBudget(client, userId);
    if (budget && requestedWeight > budget.remaining) {
      return ephemeral(
        c,
        `重み ${requestedWeight} は残予算 ${budget.remaining}（ティア枠 ${budget.tierWeight} / 配分済 ${budget.used}）を超えています。`,
      );
    }
  ```

- [ ] **Step 6: Thread `requestedWeight` into the draft INSERT.**
  In the `ad_drafts` INSERT (~L190–204), add `weight` to the column list and value list:
  change `(id, sponsor_id, slot, image_key, image_mime, image_bytes, image_width, image_height, expires_at)`
  to `(id, sponsor_id, slot, weight, image_key, image_mime, image_bytes, image_width, image_height, expires_at)`,
  the `VALUES (?, ?, ?, ?, ?, ?, ?, ?, (unixepoch() * 1000) + 600000)` to
  `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (unixepoch() * 1000) + 600000)`,
  and insert `requestedWeight` into the params array right after `slot`:
  ```ts
      [
        draftId,
        userId,
        slot,
        requestedWeight,
        imageKey,
        detected,
        attachment.size,
        attachment.width ?? null,
        attachment.height ?? null,
      ],
  ```

- [ ] **Step 7: Run to confirm PASS.**
  `npx vitest run tests/interactions/commands/ad-submit-budget.test.ts`
  Expected: both cases passed.

- [ ] **Step 8: Reconcile the existing ad-submit test (count gate removed).**
  `npx vitest run tests/interactions/commands/ad-submit.test.ts`
  The legacy file feeds a `countActiveAds` response (`{ rows: [{ count: '0' }] }`) where the new flow
  feeds `getSponsorBudget` (a tier-JOIN SELECT then a `SUM(weight_alloc)` SELECT). Make these exact
  fixes:
  - **`happy path` / `missing format rules` / `image validation failure` / `magic-bytes mismatch` /
    `image fetch fails` cases** — replace the single `{ rows: [{ count: '0' }] }` response with TWO
    responses: `{ rows: [{ weight: 10 }] }` (tier JOIN) then `{ rows: [{ used: 0 }] }`
    (sumActiveWeight, remaining 10), so the default weight 1 passes the gate.
  - **`over-limit` case** — the count-based limit no longer exists. DELETE this case (or repurpose it
    to a budget-exceeded case: responses `{ rows: [] }` fallback, `{ rows: [tierRow] }`, `{ rows: [] }`
    upsert, `{ rows: [{ weight: 10 }] }`, `{ rows: [{ used: 10 }] }` (remaining 0), payload weight
    option = 1; assert the message contains `予算` and no `INSERT INTO ad_drafts`). The dedicated
    budget cases now live in `ad-submit-budget.test.ts`, so deleting is fine.
  - Any case that asserts the draft INSERT params must account for the new `weight` column at index 3
    (id, sponsor_id, slot, weight, image_key, ...) — the `insertCall?.params?.[3]` staging-key
    assertion in the happy path becomes `params?.[4]`.

- [ ] **Step 9: Typecheck.**
  `npx tsc --noEmit`
  Expected: no errors. (`countActiveAds`/`checkMaxActiveAds` remain exported from tier.ts; this file no longer imports them.)

- [ ] **Step 10: Commit.**
  `git add scripts/register-commands.ts src/interactions/commands/ad-submit.ts tests/interactions/commands/ad-submit-budget.test.ts tests/interactions/commands/ad-submit.test.ts && git commit -m "feat(ad-submit): weight option + budget pre-check, store alloc intent in draft"`

---

### Task 7: submit-modal — atomic conditional INSERT (budget reservation) + `weight_alloc`

The pending INSERT is the point where budget is first reserved. Because **D1 has no row locks**, a read-then-write check (`getSponsorBudget` then INSERT) does NOT serialize concurrent submits. Replace it with the **atomic conditional INSERT** from spec §4: a single `INSERT INTO ads ... SELECT ... WHERE (SUM subquery) + requested <= tier weight`. SQLite runs the statement atomically and is single-writer, so two concurrent submits cannot both pass. Inspect `meta.changes` (rowCount): 0 ⇒ over budget, no row inserted ⇒ `budget_exceeded`. The inserted pending row carries `weight_alloc = requested`. (The `BEGIN`/`SELECT id`/`DELETE`/`COMMIT` scaffolding around the draft stays for call-site consistency, but the budget guarantee comes from the conditional INSERT, not the tx.)

**Files:**
- Modify: `src/interactions/modals/submit-modal.ts`
- Test: `tests/interactions/modals/submit-modal-budget.test.ts` (Create)

- [ ] **Step 1: Confirm the existing harness (already read for this plan).**
  The modal test harness lives in `tests/interactions/modals/submit-modal.test.ts`: it uses a
  `mockClient(responses, captured)` returning `{ rows }` per call, `mockRest` (createMessage),
  `mockS3` (send), a `draftRow`, a `formatRulesRow`, `buildPayload`, `invoke`, and
  `defaultDeps(client, rest)`. The production query order is:
  `1) fetchDraft, 2) fetchFormatRules, 3) BEGIN, 4) SELECT id FROM ad_drafts, <gate>, INSERT ads,
  DELETE ad_drafts, COMMIT, UPDATE review_message_id`. Reuse those helpers verbatim. Note the
  mock's `query` returns `{ rows }` only; for the affected-row check, return `{ rows: [], rowCount }`
  on the INSERT response (extend the local `mockClient` to spread `rowCount` like the approve test's).

- [ ] **Step 2: Write failing tests for the atomic conditional INSERT gate.**
  Create `tests/interactions/modals/submit-modal-budget.test.ts`:
  ```ts
  import type { S3Client } from '@aws-sdk/client-s3';
  import { Hono } from 'hono';
  import { describe, expect, it, vi } from 'vitest';
  import type { PgClient } from '../../../src/db/client.ts';
  import type { DiscordRest } from '../../../src/discord/rest.ts';
  import type { ModalSubmitInteractionPayload } from '../../../src/discord/types.ts';
  import type { Bindings } from '../../../src/env.ts';
  import {
    type ModalSubmitDeps,
    runSubmitModal,
  } from '../../../src/interactions/modals/submit-modal.ts';

  type CapturedCall = { sql: string; params: unknown[] | undefined };

  function mockClient(
    responses: Array<{ rows: unknown[]; rowCount?: number }>,
    captured: CapturedCall[] = [],
  ): PgClient {
    let i = 0;
    return {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        const r = responses[i++];
        if (!r) return { rows: [], rowCount: 0 };
        return { rowCount: r.rowCount ?? r.rows.length, ...r };
      }) as unknown as PgClient['query'],
      end: vi.fn(async () => undefined),
    };
  }

  function mockRest(): DiscordRest {
    return {
      createMessage: vi.fn(async () => ({ id: 'msg-1', channel_id: 'review-chan' })),
    } as unknown as DiscordRest;
  }

  function mockS3(): S3Client {
    return { send: vi.fn(async () => ({})) } as unknown as S3Client;
  }

  const FUTURE = new Date(Date.now() + 5 * 60 * 1000);

  // draftRow now carries `weight` (the reserved alloc).
  function draftRow(weight: number | null) {
    return {
      id: 'draft-1',
      sponsor_id: 'user-1',
      slot: 'default',
      image_key: 'staging/draft-1/orig.png',
      image_mime: 'image/png',
      image_bytes: 100_000,
      image_width: 800,
      image_height: 800,
      weight,
      expires_at: FUTURE,
    };
  }

  const formatRulesRow = {
    slot: 'default',
    allowedMimes: ['image/png'],
    allowedExtensions: ['png'],
    maxBytes: 1_000_000,
    minWidth: 200,
    maxWidth: 2000,
    minHeight: 200,
    maxHeight: 2000,
    aspectRatios: ['1:1'],
    aspectTolerance: 0.02,
    titleMaxLen: 80,
    bodyMaxLen: 500,
    linkUrlMaxLen: 2048,
    linkScheme: ['https'],
    linkDomainAllowlist: null,
    linkDomainBlocklist: null,
  };

  function buildPayload(): ModalSubmitInteractionPayload {
    return {
      type: 5,
      id: 'int-1',
      application_id: 'app-1',
      guild_id: 'guild-1',
      channel_id: 'chan-1',
      member: { user: { id: 'user-1', username: 'sponsor-display' } },
      data: {
        custom_id: 'submit:draft-1',
        components: [
          { type: 1, components: [{ type: 4, custom_id: 'title', value: 'My Ad' }] },
          { type: 1, components: [{ type: 4, custom_id: 'body', value: 'Hello world' }] },
          {
            type: 1,
            components: [{ type: 4, custom_id: 'link_url', value: 'https://example.com/promo' }],
          },
        ],
      },
    };
  }

  function invoke(payload: ModalSubmitInteractionPayload, deps: ModalSubmitDeps): Promise<Response> {
    const app = new Hono<{ Bindings: Bindings }>();
    app.post('/', (c) => runSubmitModal(c, payload, deps));
    return app.request('http://test/', { method: 'POST' });
  }

  function defaultDeps(client: PgClient): ModalSubmitDeps {
    return {
      rest: mockRest(),
      client,
      s3: mockS3(),
      bucket: 'test-bucket',
      reviewChannelId: 'review-chan',
      s3PublicBaseUrl: 'https://cdn.example',
      uuid: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    };
  }

  describe('runSubmitModal budget gate (atomic conditional INSERT)', () => {
    it('rejects with budget message when the conditional INSERT affects 0 rows', async () => {
      const captured: CapturedCall[] = [];
      // fetchDraft, fetchFormatRules, BEGIN, SELECT id, conditional INSERT(0 rows), ROLLBACK
      const client = mockClient(
        [
          { rows: [draftRow(30)] }, // fetchDraft (reserved weight 30)
          { rows: [formatRulesRow] }, // fetchFormatRules
          { rows: [] }, // BEGIN
          { rows: [{ id: 'draft-1' }] }, // SELECT id FROM ad_drafts
          { rows: [], rowCount: 0 }, // conditional INSERT INTO ads -> over budget
          { rows: [] }, // ROLLBACK
        ],
        captured,
      );
      const res = await invoke(buildPayload(), defaultDeps(client));
      const json = (await res.json()) as { type: number; data: { content: string } };
      expect(json.type).toBe(4);
      expect(json.data.content).toContain('予算');
      // The INSERT was the conditional form and the draft was NOT deleted.
      const insert = captured.find((c) => /INSERT INTO ads/.test(c.sql));
      expect(insert?.sql).toMatch(/COALESCE\(SUM\(weight_alloc\), 0\)/);
      expect(insert?.sql).toMatch(/status IN \('pending', 'approved'\)/);
      expect(captured.every((c) => !/DELETE FROM ad_drafts/.test(c.sql))).toBe(true);
      expect(captured.every((c) => !/^COMMIT$/.test(c.sql.trim()))).toBe(true);
    });

    it('inserts the pending ad with weight_alloc = draft.weight when within budget', async () => {
      const captured: CapturedCall[] = [];
      const client = mockClient(
        [
          { rows: [draftRow(20)] }, // fetchDraft
          { rows: [formatRulesRow] }, // fetchFormatRules
          { rows: [] }, // BEGIN
          { rows: [{ id: 'draft-1' }] }, // SELECT id
          { rows: [], rowCount: 1 }, // conditional INSERT -> 1 row
          { rows: [] }, // DELETE ad_drafts
          { rows: [] }, // COMMIT
          { rows: [] }, // UPDATE review_message_id
        ],
        captured,
      );
      const res = await invoke(buildPayload(), defaultDeps(client));
      const json = (await res.json()) as { type: number; data: { content: string } };
      expect(json.type).toBe(4);
      expect(json.data.content).toContain('受付完了');
      const insert = captured.find((c) => /INSERT INTO ads/.test(c.sql));
      expect(insert).toBeDefined();
      // requested weight (20) is bound as a param (alloc reservation) and as the
      // SUM addend in the WHERE clause; assert it's present and the sponsor + ad id are too.
      expect(insert?.params).toContain(20);
      expect(insert?.params).toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      expect(insert?.params).toContain('user-1');
      // draft cleared + committed.
      expect(captured.some((c) => /DELETE FROM ad_drafts/.test(c.sql))).toBe(true);
      expect(captured.some((c) => /^COMMIT$/.test(c.sql.trim()))).toBe(true);
    });

    it('defaults the reservation to 1 when draft.weight is null', async () => {
      const captured: CapturedCall[] = [];
      const client = mockClient(
        [
          { rows: [draftRow(null)] },
          { rows: [formatRulesRow] },
          { rows: [] }, // BEGIN
          { rows: [{ id: 'draft-1' }] }, // SELECT id
          { rows: [], rowCount: 1 }, // INSERT
          { rows: [] }, // DELETE
          { rows: [] }, // COMMIT
          { rows: [] }, // UPDATE review_message_id
        ],
        captured,
      );
      await invoke(buildPayload(), defaultDeps(client));
      const insert = captured.find((c) => /INSERT INTO ads/.test(c.sql));
      expect(insert?.params).toContain(1);
    });
  });
  ```

- [ ] **Step 3: Run to confirm FAIL.**
  `npx vitest run tests/interactions/modals/submit-modal-budget.test.ts`
  Expected: FAIL (INSERT is unconditional and has no `weight_alloc`/SUM guard; `weight` not fetched).

- [ ] **Step 4: Add `weight` to the draft fetch.**
  In `src/interactions/modals/submit-modal.ts`, add `weight: number | null` to the `AdDraft` type, add `weight` to the `fetchDraft` SELECT column list and its row type, and map it:
  - In `type AdDraft`, after `expiresAt: Date;` add `weight: number | null;`
  - In `fetchDraft`'s row generic, after `expires_at: Date;` add `weight: number | null;`
  - In the SELECT string, change `image_width, image_height, expires_at` to `image_width, image_height, weight, expires_at`
  - In the returned object, add `weight: row.weight,` next to the other fields.

- [ ] **Step 5: Remove the count gate; the conditional INSERT carries the budget guard.**
  In `src/interactions/modals/submit-modal.ts`:
  - Remove `import { countActiveAds } from '../../sponsors/tier.ts';` (no longer used here; budget
    is enforced in the INSERT itself).
  - Delete the `fetchTierLimit` function (~L83–92).
  - Delete the entire "Recheck tier limit inside the locked transaction" block (the
    `fetchTierLimit` + `countActiveAds` + over-limit `ROLLBACK` branch, ~L179–196). The conditional
    INSERT in Step 6 replaces it.
  - Just before the INSERT, capture the reservation: `const requested = draft.weight ?? 1;`.

- [ ] **Step 6: Replace the unconditional INSERT with the atomic conditional INSERT.**
  Replace the `INSERT INTO ads (...) VALUES (...)` statement (~L198–216) with the conditional
  `INSERT ... SELECT ... WHERE`, then inspect `meta.changes`:
  ```ts
      const insertRes = await deps.client.query(
        // D1/SQLite has no row locks, so we cannot read-then-write the budget
        // safely. This single atomic statement inserts the pending row ONLY when
        // Σ weight_alloc over the sponsor's existing pending+approved regular
        // non-admin ads, plus `requested`, is still <= the live tier weight.
        // `meta.changes` (rowCount) == 0 ⇒ over budget ⇒ nothing inserted.
        `INSERT INTO ads
           (id, sponsor_id, kind, slot, title, body, link_url,
            image_key, image_mime, image_bytes, image_width, image_height, status, weight_alloc)
         SELECT ?, ?, 'regular', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?
          WHERE (
            (SELECT COALESCE(SUM(weight_alloc), 0)
               FROM ads
              WHERE sponsor_id = ?
                AND kind = 'regular'
                AND created_by_admin IS NULL
                AND status IN ('pending', 'approved')) + ?
          ) <= (SELECT t.weight
                  FROM sponsors s
                  JOIN tiers t ON t.id = s.current_tier_id
                 WHERE s.discord_user_id = ?)`,
        [
          adId,
          draft.sponsorId,
          draft.slot,
          title,
          body,
          linkUrl,
          finalKey,
          draft.imageMime,
          draft.imageBytes,
          draft.imageWidth,
          draft.imageHeight,
          requested, // weight_alloc value
          draft.sponsorId, // SUM scope
          requested, // SUM addend
          draft.sponsorId, // tier lookup
        ],
      );
      if ((insertRes.rowCount ?? 0) === 0) {
        // Over budget (or sponsor has no tier ⇒ the subquery is NULL ⇒ the
        // comparison is false ⇒ 0 rows). Roll back the draft scaffolding and
        // clean up the freshly-copied final image.
        await deps.client.query('ROLLBACK');
        txOpen = false;
        try {
          await deleteObject(deps.s3, deps.bucket, finalKey);
        } catch (cleanupErr) {
          console.error('submit-modal: over-budget cleanup failed', { finalKey, cleanupErr });
        }
        return ephemeral(
          c,
          `重み ${requested} はティアの重み予算を超えています。配分を見直して再度起稿してください。`,
        );
      }
  ```
  Note: a tier-less sponsor (no `current_tier_id`) makes the right-hand subquery NULL, so the
  `<=` comparison is NULL/false and 0 rows insert. In Phase 1 only sponsors with a tier reach the
  modal (submit pre-check refreshed a tier), so this is acceptable; if a tier-less submit path is
  ever added, special-case it before this INSERT.

- [ ] **Step 7: Run to confirm PASS.**
  `npx vitest run tests/interactions/modals/submit-modal-budget.test.ts`
  Expected: all three cases passed.

- [ ] **Step 8: Run the existing modal test for regressions.**
  `npx vitest run tests/interactions/modals/submit-modal.test.ts`
  Expected: the two over-limit cases (`exceed tier limit` and `rolls back and cleans up finalKey when over-limit recheck fails`) now reference the removed `fetchTierLimit`/`countActiveAds` path. Rewrite them to the conditional-INSERT form: drop the `max_active_ads`/`count` responses, make the INSERT response `{ rows: [], rowCount: 0 }`, keep the `ROLLBACK` + finalKey-cleanup assertions, and assert the message contains `予算`. The happy-path cases need `weight` added to `draftRow` and the INSERT response changed to `{ rows: [], rowCount: 1 }` (remove the two tier/count responses). Update the `insert?.params` index assertions to the new column order if any case asserts them.

- [ ] **Step 9: Typecheck.**
  `npx tsc --noEmit`
  Expected: no errors.

- [ ] **Step 10: Commit.**
  `git add src/interactions/modals/submit-modal.ts tests/interactions/modals/submit-modal-budget.test.ts tests/interactions/modals/submit-modal.test.ts && git commit -m "feat(submit-modal): atomic conditional INSERT budget gate + weight_alloc reservation"`

---

### Task 8: nightly cron rewrite — proportional rescale, smallest-first pause, admin_log + DM

Rewrite `syncWeightForSponsor` to recompute `effectiveWeights` per sponsor and persist it (including smallest-first pause), log before/after to `admin_logs`, and DM the sponsor when banners are paused. Keep the `created_by_admin IS NULL` exclusion. This MUST ship in the same PR (decision #1 risk: without it the first nightly run reinflates every banner to full weight).

**Files:**
- Modify: `src/cron/audit-sponsor-membership.ts` (`syncWeightForSponsor` ~L90–131, `AuditResult` ~L4–12, `auditSponsorMembership` signature/call ~L153+, caller in `src/cron/index.ts` is unchanged because rest is already passed)
- Test: `tests/cron/audit-sponsor-membership.test.ts` (Create)

- [ ] **Step 1: Write failing test for proportional rescale (no pause) + admin_log.**
  Create `tests/cron/audit-sponsor-membership.test.ts`:
  ```ts
  import { describe, expect, it, vi } from 'vitest';
  import type { PgClient } from '../../src/db/client.ts';
  import type { DiscordRest } from '../../src/discord/rest.ts';
  import { auditSponsorMembership } from '../../src/cron/audit-sponsor-membership.ts';

  type CapturedCall = { sql: string; params: unknown[] | undefined };
  function mockClient(
    responses: Array<{ rows: unknown[]; rowCount?: number }>,
    captured: CapturedCall[] = [],
  ): PgClient {
    let i = 0;
    return {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        const r = responses[i++];
        if (!r) return { rows: [], rowCount: 0 };
        return { rowCount: r.rowCount ?? r.rows.length, ...r };
      }) as unknown as PgClient['query'],
      end: vi.fn(async () => undefined),
    };
  }

  // rest that reports the sponsor present with a single tier role.
  function restWithRole(roleId: string): DiscordRest {
    return {
      getGuildMember: vi.fn(async () => ({ user: { id: 'sp-1' }, roles: [roleId] })),
      createDmChannel: vi.fn(async () => ({ id: 'dm-1', type: 1 })),
      createMessage: vi.fn(async () => ({ id: 'm-1', channel_id: 'dm-1' })),
    } as unknown as DiscordRest;
  }

  describe('auditSponsorMembership weight rescale', () => {
    it('rescales proportionally on downgrade and writes weight_snapshot (no pause)', async () => {
      const captured: CapturedCall[] = [];
      // Order: distinct-sponsors SELECT, tiers SELECT, then per-sponsor:
      //   1) `before` SELECT (id, weight_snapshot over pending+approved),
      //   2) getSponsorActiveRegularAllocs, 3) applyEffectiveWeights UPDATE(s),
      //   4) admin_log INSERT.
      const client = mockClient(
        [
          { rows: [{ sponsor_id: 'sp-1' }] }, // distinct sponsors
          { rows: [{ id: 1, discord_role_id: 'role-low', weight: 50, rank: 10 }] }, // tiers (downgraded T=50)
          { rows: [{ id: 'a', weight_snapshot: 50 }, { id: 'b', weight_snapshot: 30 }, { id: 'c', weight_snapshot: 20 }] }, // before
          { rows: [{ id: 'a', weight_alloc: 50 }, { id: 'b', weight_alloc: 30 }, { id: 'c', weight_alloc: 20 }] }, // allocs Σ=100>50
          { rows: [] }, // UPDATE a -> 25
          { rows: [] }, // UPDATE b -> 15
          { rows: [] }, // UPDATE c -> 10
          { rows: [] }, // admin_log INSERT
        ],
        captured,
      );
      const result = await auditSponsorMembership(client, restWithRole('role-low'), 'g1');
      expect(result.sponsorsWeightSynced).toBe(1);
      const updates = captured.filter((cc) => /SET weight_snapshot = \?/.test(cc.sql));
      const sum = updates.reduce((s, u) => s + Number(u.params?.[0] ?? 0), 0);
      expect(sum).toBe(50); // total snapshot == new T
      expect(captured.some((cc) => /INSERT INTO admin_logs/.test(cc.sql))).toBe(true);
      expect(captured.every((cc) => !/SET status = 'paused'/.test(cc.sql))).toBe(true);
    });
  });
  ```

- [ ] **Step 2: Run to confirm FAIL.**
  `npx vitest run tests/cron/audit-sponsor-membership.test.ts`
  Expected: FAIL — the current `syncWeightForSponsor` writes a scalar tier weight and a different response sequence; the snapshot sum won't be 50.

- [ ] **Step 3: Rewrite `syncWeightForSponsor` to use effectiveWeights.**
  In `src/cron/audit-sponsor-membership.ts`, add imports at the top:
  ```ts
  import { applyEffectiveWeights, getSponsorActiveRegularAllocs } from '../db/queries/review.ts';
  import { effectiveWeights } from '../sponsors/tier.ts';
  ```
  Replace the entire `syncWeightForSponsor` function (~L90–131) with:
  ```ts
  type SyncOutcome = {
    changed: { id: string; oldWeight: number | null; newWeight: number }[];
    paused: string[];
  };

  /**
   * Recompute effective deck weights for one sponsor from their intended allocs
   * and the live tier weight, then persist (smallest-alloc-first pause when the
   * banner count exceeds the new budget). Records a before/after admin_log.
   * Returns what changed so the caller can DM and tally. created_by_admin ads
   * are excluded by getSponsorActiveRegularAllocs.
   */
  async function syncWeightForSponsor(
    client: PgClient,
    sponsorId: string,
    newWeight: number,
  ): Promise<SyncOutcome> {
    const before = await client.query<{ id: string; weight_snapshot: number | null }>(
      // Read the SAME status set the budget reads (pending+approved) so the
      // before/after admin_log mirrors exactly what getSponsorActiveRegularAllocs
      // recomputes. Do NOT include 'paused' here (paused ads are out of the active
      // budget set; they re-enter only if un-paused, which is a separate action).
      `SELECT id, weight_snapshot
         FROM ads
        WHERE sponsor_id = ?
          AND created_by_admin IS NULL
          AND status IN ('pending', 'approved')`,
      [sponsorId],
    );
    const oldById = new Map(before.rows.map((r) => [r.id, r.weight_snapshot]));

    const allocs = await getSponsorActiveRegularAllocs(client, sponsorId);
    if (allocs.length === 0) return { changed: [], paused: [] };
    const eff = effectiveWeights(allocs, newWeight);

    const changed = eff.weights
      .map((w) => ({
        id: w.id,
        oldWeight: oldById.get(w.id) ?? null,
        newWeight: w.weightSnapshot,
      }))
      .filter((w) => w.oldWeight !== w.newWeight);

    if (changed.length === 0 && eff.paused.length === 0) return { changed: [], paused: [] };

    await applyEffectiveWeights(client, eff.weights, eff.paused);

    await client.query(
      `INSERT INTO admin_logs (actor_id, action, target_kind, target_id, before, after)
         VALUES ('system', 'auto_rescale_weight', 'sponsor', ?, ?, ?)`,
      [
        sponsorId,
        JSON.stringify({ tier_weight: newWeight, weights: before.rows }),
        JSON.stringify({ weights: eff.weights, paused: eff.paused }),
      ],
    );

    return { changed, paused: eff.paused };
  }
  ```
  Note: `getSponsorActiveRegularAllocs` reads `status IN ('pending','approved')`; pending ads have no `weight_snapshot` yet, so `effectiveWeights` will assign them one here. That is acceptable — they still belong to the budget and the share invariant must hold across them. (If pending should be excluded from serve, that is already handled by `pick.ts`'s `status='approved'` filter; the snapshot is harmless until approval.)

- [ ] **Step 4: Run to confirm the rescale test PASS.**
  `npx vitest run tests/cron/audit-sponsor-membership.test.ts`
  Expected: rescale case passed (snapshot sum == 50, admin_log inserted, no pause).

- [ ] **Step 5: Wire DM + tally into the caller.**
  In `src/cron/audit-sponsor-membership.ts`, extend `AuditResult` (~L4–12) with:
  ```ts
    adsPaused: number;
  ```
  (and initialize `adsPaused: 0` in the `result` object ~L178–186.)
  Replace the `const changed = await syncWeightForSponsor(...)` block at the end of the loop (~L223–227) with:
  ```ts
      const outcome = await syncWeightForSponsor(client, sponsorId, tier.weight);
      if (outcome.changed.length > 0 || outcome.paused.length > 0) {
        result.sponsorsWeightSynced++;
        result.adsWeightChanged += outcome.changed.length;
        result.adsPaused += outcome.paused.length;
      }
      if (outcome.paused.length > 0) {
        await notifySponsorPaused(rest, sponsorId, outcome.paused.length, tier.weight);
      }
  ```
  Add the DM helper above `auditSponsorMembership`:
  ```ts
  async function notifySponsorPaused(
    rest: DiscordRest,
    sponsorId: string,
    pausedCount: number,
    tierWeight: number,
  ): Promise<void> {
    // Best-effort DM; a blocked/closed DM must not fail the audit. The user is
    // in a sensitive (downgrade) state, so keep the copy factual and brief.
    try {
      const ch = await rest.createDmChannel(sponsorId);
      await rest.createMessage(ch.id, {
        content:
          `ティア枠（重み ${tierWeight}）の縮小により、配分の小さいバナー ${pausedCount} 件を一時停止しました。` +
          `残りのバナーは新しい枠に比例して配信されます。配分の見直しは \`/ad list\` から行えます。`,
      });
    } catch (err) {
      console.error('audit: pause DM failed (continuing)', { sponsorId, err });
    }
  }
  ```

- [ ] **Step 6: Write failing test for smallest-first pause + DM + admin exclusion.**
  Append to `tests/cron/audit-sponsor-membership.test.ts`:
  ```ts
  describe('auditSponsorMembership pause', () => {
    it('pauses smallest-alloc-first when count > new T, DMs the sponsor', async () => {
      const captured: CapturedCall[] = [];
      const rest = restWithRole('role-tiny');
      const client = mockClient(
        [
          { rows: [{ sponsor_id: 'sp-1' }] }, // distinct sponsors
          { rows: [{ id: 1, discord_role_id: 'role-tiny', weight: 2, rank: 10 }] }, // tiers T=2
          { rows: [{ id: 'a', weight_snapshot: 1 }, { id: 'b', weight_snapshot: 1 }, { id: 'c', weight_snapshot: 1 }] }, // before (status pending/approved)
          { rows: [{ id: 'a', weight_alloc: 1 }, { id: 'b', weight_alloc: 1 }, { id: 'c', weight_alloc: 1 }] }, // allocs
          { rows: [] }, // UPDATE weight_snapshot survivor 1
          { rows: [] }, // UPDATE weight_snapshot survivor 2
          { rows: [] }, // UPDATE status='paused' for victim
          { rows: [] }, // admin_log INSERT
        ],
        captured,
      );
      const result = await auditSponsorMembership(client, rest, 'g1');
      expect(result.adsPaused).toBe(1);
      const pause = captured.find((cc) => /SET status = 'paused'/.test(cc.sql));
      expect(pause?.params).toEqual(['a']); // smallest alloc, id-tiebreak ascending
      expect(rest.createDmChannel).toHaveBeenCalledWith('sp-1');
      expect(rest.createMessage).toHaveBeenCalledTimes(1);
    });

    it('excludes admin-contributed ads from the audit entirely', async () => {
      const captured: CapturedCall[] = [];
      // distinct-sponsors SELECT already filters created_by_admin IS NULL, so an
      // admin-only sponsor yields zero rows -> no per-sponsor work.
      const client = mockClient(
        [
          { rows: [] }, // distinct sponsors (admin ads excluded by the query)
          { rows: [{ id: 1, discord_role_id: 'role-x', weight: 10, rank: 10 }] }, // tiers
        ],
        captured,
      );
      const result = await auditSponsorMembership(client, restWithRole('role-x'), 'g1');
      expect(result.sponsorsChecked).toBe(0);
      expect(captured.some((cc) => /SET weight_snapshot/.test(cc.sql))).toBe(false);
    });
  });
  ```

- [ ] **Step 7: Run to confirm PASS.**
  `npx vitest run tests/cron/audit-sponsor-membership.test.ts`
  Expected: all cases passed. (The `before` SELECT and the `allocs` SELECT are separate queries; mirror the response order if assertions misalign.)

- [ ] **Step 8: Confirm the distinct-sponsors SELECT still excludes admin ads.**
  Read the query at ~L163–169 — it already has `created_by_admin IS NULL`. No change needed; the exclusion test in Step 6 documents this.

- [ ] **Step 9: Typecheck + cron dispatch unchanged.**
  `npx tsc --noEmit`
  Expected: no errors. `src/cron/index.ts` already calls `auditSponsorMembership(client, rest, env.GUILD_ID)` with `rest` available, so the DM path needs no dispatch change.

- [ ] **Step 10: Commit.**
  `git add src/cron/audit-sponsor-membership.ts tests/cron/audit-sponsor-membership.test.ts && git commit -m "feat(cron): proportional weight rescale + smallest-first pause + DM on downgrade"`

---

### Task 9: sponsor-aware serve spread — generalize `seeded-shuffle`

Generalize `trySwap`/`spreadShuffle` to compare by a `keyOf(element)` function so adjacency is judged on sponsor identity (which subsumes ad identity). Default `keyOf = identity` keeps current callers and tests working.

**Files:**
- Modify: `src/utils/seeded-shuffle.ts` (`trySwap`, `spreadShuffle`)
- Test: `tests/utils/seeded-shuffle.test.ts` (Create)

- [ ] **Step 1: Write failing test for keyed non-adjacency + share invariance.**
  Create `tests/utils/seeded-shuffle.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { spreadShuffle } from '../../src/utils/seeded-shuffle.ts';

  describe('spreadShuffle keyOf', () => {
    it('default (identity) still separates identical elements best-effort', () => {
      const out = spreadShuffle(['x', 'y', 'x', 'y']);
      let adj = 0;
      for (let i = 1; i < out.length; i++) if (out[i] === out[i - 1]) adj++;
      expect(adj).toBe(0);
    });

    it('keyOf groups by sponsor: different ads of one sponsor are not adjacent', () => {
      // a1,a2 belong to sponsor A; b1 to sponsor B. With identity, a1 != a2 so
      // they could sit adjacent; with keyOf=sponsor they must be separated.
      const sponsorOf: Record<string, string> = { a1: 'A', a2: 'A', b1: 'B' };
      const deck = ['a1', 'a2', 'b1', 'a1', 'a2', 'b1'];
      const out = spreadShuffle(deck, (id) => sponsorOf[id] ?? id);
      let adjSameSponsor = 0;
      for (let i = 1; i < out.length; i++) {
        if ((sponsorOf[out[i] as string] ?? out[i]) === (sponsorOf[out[i - 1] as string] ?? out[i - 1])) {
          adjSameSponsor++;
        }
      }
      expect(adjSameSponsor).toBe(0);
    });

    it('share invariance: spreadShuffle is a permutation (multiset unchanged)', () => {
      const sponsorOf: Record<string, string> = { a1: 'A', a2: 'A', b1: 'B' };
      const deck = ['a1', 'a2', 'b1', 'a1', 'a2', 'b1'];
      const out = spreadShuffle(deck, (id) => sponsorOf[id] ?? id);
      expect(out.slice().sort()).toEqual(deck.slice().sort());
    });

    it('dominant sponsor (> ceil(N/2)): residual same-sponsor adjacencies minimized, share unchanged', () => {
      // Sponsor A holds 5 of N=8 impressions (5 > ceil(8/2)=4), so perfect
      // non-adjacency is mathematically impossible. Best-effort lower bound on
      // same-sponsor adjacencies for one sponsor with count m out of N is
      // m - (N - m) - 1 = 2m - N - 1 = 2*5 - 8 - 1 = 1. Assert we hit that bound.
      const sponsorOf: Record<string, string> = {
        a1: 'A', a2: 'A', a3: 'A', a4: 'A', a5: 'A',
        b1: 'B', c1: 'C', d1: 'D',
      };
      const deck = ['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'c1', 'd1'];
      const out = spreadShuffle(deck, (id) => sponsorOf[id] ?? id);
      let adjSameSponsor = 0;
      for (let i = 1; i < out.length; i++) {
        if ((sponsorOf[out[i] as string] ?? out[i]) === (sponsorOf[out[i - 1] as string] ?? out[i - 1])) {
          adjSameSponsor++;
        }
      }
      // Theoretical floor for a dominant sponsor with count m of N. Best-effort:
      // the swap heuristic must get CLOSE to it and far below the fully-grouped
      // worst case (m-1 = 4 adjacencies). We assert it is minimized to within a
      // small slack of the floor (1), which the 4-sweep heuristic reliably meets
      // for small N; if a future heuristic guarantees the exact floor, tighten
      // this to `toBe(floor)`.
      const m = 5;
      const N = deck.length;
      const floor = Math.max(0, 2 * m - N - 1); // = 1
      expect(adjSameSponsor).toBeLessThanOrEqual(floor + 1);
      expect(adjSameSponsor).toBeLessThan(m - 1); // strictly better than fully grouped
      // per-ad share is unchanged: spreadShuffle is a permutation (each ad once).
      expect(out.slice().sort()).toEqual(deck.slice().sort());
    });
  });
  ```

- [ ] **Step 2: Run to confirm FAIL.**
  `npx vitest run tests/utils/seeded-shuffle.test.ts`
  Expected: FAIL — `spreadShuffle` takes one arg; the keyed case still sees a1/a2 adjacent.

- [ ] **Step 3: Generalize `trySwap` to use `keyOf`.**
  In `src/utils/seeded-shuffle.ts`, change `trySwap` to accept a `keyOf`:
  ```ts
  function trySwap<T>(arr: T[], i: number, j: number, keyOf: (v: T) => unknown): boolean {
    if (i === j) return false;
    const a = arr[i];
    const b = arr[j];
    if (a === undefined || b === undefined) return false;
    if (keyOf(a) === keyOf(b)) return false; // pointless: same key
    arr[i] = b;
    arr[j] = a;
    const positions = new Set([i - 1, i, i + 1, j - 1, j, j + 1]);
    for (const p of positions) {
      if (p <= 0 || p >= arr.length) continue;
      const cur = arr[p];
      const prev = arr[p - 1];
      if (cur !== undefined && prev !== undefined && keyOf(cur) === keyOf(prev)) {
        arr[i] = a;
        arr[j] = b;
        return false;
      }
    }
    return true;
  }
  ```

- [ ] **Step 4: Generalize `spreadShuffle` to accept and thread `keyOf`.**
  In `src/utils/seeded-shuffle.ts`, change the `spreadShuffle` signature and the adjacency check + swap call:
  ```ts
  export function spreadShuffle<T>(
    deck: readonly T[],
    keyOf: (v: T) => unknown = (v) => v,
  ): T[] {
    if (deck.length <= 1) return deck.slice();
    const result = deck.slice();
    const MAX_SWEEPS = 4;
    for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
      let swaps = 0;
      for (let i = 1; i < result.length; i++) {
        const cur = result[i];
        const prev = result[i - 1];
        if (cur === undefined || prev === undefined || keyOf(cur) !== keyOf(prev)) continue;
        for (let j = i + 1; j < result.length; j++) {
          if (trySwap(result, i, j, keyOf)) {
            swaps++;
            break;
          }
        }
      }
      if (swaps === 0) break;
    }
    return result;
  }
  ```

- [ ] **Step 5: Run to confirm PASS.**
  `npx vitest run tests/utils/seeded-shuffle.test.ts`
  Expected: all cases passed.

- [ ] **Step 6: Run the serve pick test to confirm the default-arg call still works.**
  `npx vitest run tests/serve/pick.test.ts`
  Expected: passed (the pick.ts call still passes a single arg until Task 10).

- [ ] **Step 7: Typecheck.**
  `npx tsc --noEmit`
  Expected: no errors.

- [ ] **Step 8: Commit.**
  `git add src/utils/seeded-shuffle.ts tests/utils/seeded-shuffle.test.ts && git commit -m "feat(serve): generalize spreadShuffle/trySwap to a keyOf function"`

---

### Task 10: pick.ts — fetch `sponsor_id`, pass sponsor `keyOf` to spreadShuffle

Add `sponsor_id` to the regular SELECT, build an `id → sponsor_id` map, and pass `keyOf(id) = sponsor_id ?? id` so same-sponsor banners are spread. Bag composition (and therefore share) is unchanged.

**Files:**
- Modify: `src/serve/pick.ts` (SELECT ~L88–96, `buildBag` ~L51–61, callsite ~L113)
- Test: `tests/serve/pick.test.ts` (extend; reconcile stale assertions)

- [ ] **Step 1: Read the current pick test expectations.**
  `npx vitest run tests/serve/pick.test.ts`
  Note: `pick.test.ts` asserts `-ln(random()) / weight_snapshot ASC`, `<> ALL(?::uuid[])`, and house params `['default', ['x-1'], 2]` — these are Postgres-era and DON'T match the current `pick.ts` (which uses a deck/rotation and `NOT IN (...)`). Do NOT depend on those regexes. Only add assertions that match the real SQL produced by `pick.ts`.

- [ ] **Step 2: Write failing test that the regular SELECT now includes `sponsor_id`.**
  Append to `tests/serve/pick.test.ts` a focused case (reuse the file's `mockClient`):
  ```ts
  describe('pickRegularAds sponsor_id', () => {
    it('selects sponsor_id in the regular deck query', async () => {
      const captured: CapturedCall[] = [];
      const client = mockClient(
        [
          {
            rows: [
              { ...REGULAR_ROW('a-1'), sponsor_id: 'A', weight_snapshot: 1 },
              { ...REGULAR_ROW('a-2'), sponsor_id: 'A', weight_snapshot: 1 },
            ],
          },
          { rows: [{ bag: JSON.stringify(['a-1', 'a-2']), cursor: 1 }] }, // rotation upsert
        ],
        captured,
      );
      await pickRegularAds(client, 'default', 1);
      expect(captured[0]?.sql).toMatch(/sponsor_id/);
    });
  });
  ```

- [ ] **Step 3: Run to confirm FAIL.**
  `npx vitest run tests/serve/pick.test.ts -t "sponsor_id"`
  Expected: FAIL — current SELECT has no `sponsor_id`.

- [ ] **Step 4: Add `sponsor_id` to the row type and SELECT.**
  In `src/serve/pick.ts`:
  - Extend `RawWeightedRow`:
    ```ts
    type RawWeightedRow = RawAdRow & { weight_snapshot: number; sponsor_id: string | null };
    ```
  - In `pickRegularAds`, change the SELECT column list from
    `SELECT id, kind, title, body, link_url, image_key, weight_snapshot`
    to `SELECT id, kind, title, body, link_url, image_key, weight_snapshot, sponsor_id`.

- [ ] **Step 5: Thread `keyOf` through `buildBag`.**
  In `src/serve/pick.ts`, change `buildBag` to accept the sponsor map and pass a `keyOf` to `spreadShuffle`:
  ```ts
  async function buildBag(ads: RawWeightedRow[], seed: string): Promise<string[]> {
    const flat: string[] = [];
    const sponsorOf = new Map<string, string>();
    for (const a of ads) {
      sponsorOf.set(a.id, a.sponsor_id ?? a.id);
      for (let i = 0; i < a.weight_snapshot; i++) flat.push(a.id);
    }
    // Spread by sponsor identity (subsumes ad identity): two back-to-back
    // impressions almost never share the same sponsor, let alone the same ad.
    // Bag composition is unchanged, so per-ad share is unchanged.
    return spreadShuffle(await seededShuffle(flat, seed), (id) => sponsorOf.get(id) ?? id);
  }
  ```

- [ ] **Step 6: Run the new case to confirm PASS.**
  `npx vitest run tests/serve/pick.test.ts -t "sponsor_id"`
  Expected: passed.

- [ ] **Step 7: Reconcile the pre-existing stale pick assertions if the full file fails.**
  `npx vitest run tests/serve/pick.test.ts`
  If the `-ln(random())`, `<> ALL`, and `['default', ['x-1'], 2]` assertions were already failing before this task (they reference Postgres-era SQL not present in current `pick.ts`), update them to match the actual SQL in `pick.ts` (deck SELECT with `ORDER BY id`, house `NOT IN (...)`, params `['default', 'x-1', 2]`). Do not weaken assertions you add for `sponsor_id`/share.

- [ ] **Step 8: Add a share-invariance regression test at the pick level.**
  Append to `tests/serve/pick.test.ts`:
  ```ts
  it('share invariance: deck still contains each ad weight_snapshot times', async () => {
    const captured: CapturedCall[] = [];
    let capturedBag: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        if (/SELECT id, kind/.test(sql)) {
          return {
            rows: [
              { ...REGULAR_ROW('a-1'), sponsor_id: 'A', weight_snapshot: 3 },
              { ...REGULAR_ROW('b-1'), sponsor_id: 'B', weight_snapshot: 1 },
            ],
          };
        }
        // rotation upsert: echo back the bag we were given so we can inspect it.
        const bagArg = params?.[2];
        if (typeof bagArg === 'string') capturedBag = JSON.parse(bagArg);
        return { rows: [{ bag: bagArg, cursor: 1 }] };
      }) as unknown as PgClient['query'],
      end: vi.fn(async () => undefined),
    } as PgClient;
    await pickRegularAds(client, 'default', 1);
    const counts = capturedBag.reduce<Record<string, number>>((m, id) => {
      m[id] = (m[id] ?? 0) + 1;
      return m;
    }, {});
    expect(counts['a-1']).toBe(3);
    expect(counts['b-1']).toBe(1);
  });
  ```

- [ ] **Step 9: Run + typecheck.**
  `npx vitest run tests/serve/pick.test.ts && npx tsc --noEmit`
  Expected: passed, no type errors.

- [ ] **Step 10: Commit.**
  `git add src/serve/pick.ts tests/serve/pick.test.ts && git commit -m "feat(serve): sponsor-aware deck spread (fetch sponsor_id, key by sponsor)"`

---

### Task 11: admin/user list budget display

Expose per-banner `weight_alloc` and a sponsor budget summary in the admin list. **Phase 1 does NOT define `getSponsorActiveBanners`** — that symbol's canonical definition lives only in Phase 2 (`src/db/queries/portal.ts`, returning `{ id, slot, title, status, weightAlloc }`). Phase 1 instead (a) adds `weight_alloc` to the existing admin-list SELECT/row so each line shows `alloc=`, and (b) renders a budget summary line (`tierWeight / used / remaining`) computed via the shared `getSponsorBudget` when the list is filtered to a single sponsor. If a banner list is ever needed in Phase 1, use the existing `getSponsorAds`.

**Files:**
- Modify: `src/db/queries/admin-ads.ts` (add `weightAlloc` to `AdminAdRow` + SELECT)
- Modify: `src/discord/admin-ads-list.ts` (`adLine` shows `alloc=`; `buildAdminAdsListEmbed` accepts an optional budget summary)
- Modify: `src/discord/admin-ads-list.ts` caller (where the embed is built — pass `getSponsorBudget(client, state.sponsorId)` when `state.sponsorId` is set)
- Test: `tests/discord/admin-ads-list-budget.test.ts` (Create)

- [ ] **Step 1: Add `weightAlloc` to the admin list row + SELECT.**
  In `src/db/queries/admin-ads.ts`:
  - Add `weightAlloc: number | null;` to `AdminAdRow` (after `weightSnapshot: number | null;`).
  - Add `weight_alloc` to the SELECT column list — change
    `SELECT id, sponsor_id, kind, slot, title, status, weight_snapshot,` to
    `SELECT id, sponsor_id, kind, slot, title, status, weight_snapshot, weight_alloc,`
    and add `weight_alloc: number | null;` to the inline row generic (after `weight_snapshot`).
  - In the `.map`, add `weightAlloc: r.weight_alloc,` (after `weightSnapshot: r.weight_snapshot,`).

- [ ] **Step 2: Write failing test for the alloc column + budget summary.**
  Create `tests/discord/admin-ads-list-budget.test.ts` (mirrors the row/embed style of the existing
  `tests/discord/admin-ads-list.test.ts`):
  ```ts
  import { describe, expect, it } from 'vitest';
  import type { AdminAdRow, AdminListResult } from '../../src/db/queries/admin-ads.ts';
  import type { SponsorBudget } from '../../src/sponsors/tier.ts';
  import { buildAdminAdsListEmbed } from '../../src/discord/admin-ads-list.ts';

  function row(overrides: Partial<AdminAdRow> = {}): AdminAdRow {
    return {
      id: '11111111-2222-3333-4444-555555555555',
      sponsorId: 'sponsor-1',
      kind: 'regular',
      slot: 'default',
      title: 'Sample',
      status: 'approved',
      weightSnapshot: 10,
      weightAlloc: 20,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      startsAt: null,
      endsAt: null,
      ...overrides,
    };
  }

  const result = (ads: AdminAdRow[]): AdminListResult => ({
    ads,
    totalCount: ads.length,
    page: 1,
    pageSize: 5,
    totalPages: 1,
  });

  describe('buildAdminAdsListEmbed budget display', () => {
    it('shows alloc= per regular row', () => {
      const embed = buildAdminAdsListEmbed(result([row({ weightAlloc: 20 })]), { page: 1 });
      expect(embed.description).toContain('alloc=20');
    });

    it('omits alloc= when weightAlloc is null (admin/house ads)', () => {
      const embed = buildAdminAdsListEmbed(
        result([row({ weightAlloc: null, kind: 'house', sponsorId: null })]),
        { page: 1 },
      );
      expect(embed.description).not.toContain('alloc=');
    });

    it('renders a budget summary line when a sponsor budget is supplied', () => {
      const budget: SponsorBudget = { tierWeight: 80, used: 30, remaining: 50 };
      const embed = buildAdminAdsListEmbed(
        result([row()]),
        { page: 1, sponsorId: 'sponsor-1' },
        budget,
      );
      expect(embed.description).toContain('予算');
      expect(embed.description).toContain('80'); // tierWeight
      expect(embed.description).toContain('30'); // used
      expect(embed.description).toContain('50'); // remaining
    });

    it('renders no budget line when no budget is supplied (unfiltered list)', () => {
      const embed = buildAdminAdsListEmbed(result([row()]), { page: 1 });
      expect(embed.description).not.toContain('残予算');
    });
  });
  ```

- [ ] **Step 3: Run to confirm FAIL.**
  `npx vitest run tests/discord/admin-ads-list-budget.test.ts`
  Expected: FAIL — `alloc=` not rendered, `buildAdminAdsListEmbed` takes no budget arg.

- [ ] **Step 4: Show alloc in the admin list line.**
  In `src/discord/admin-ads-list.ts`, in `adLine` (~L62–66), after the `const w = ...` line add:
  ```ts
    const al = a.weightAlloc !== null ? ` alloc=${a.weightAlloc}` : '';
  ```
  and insert `${al}` into the returned string right after `${w}`:
  ```ts
    return `\`${a.id.slice(0, 8)}\` [${a.status}] ${a.title} ─ slot:${a.slot} kind:${a.kind} ${w}${al} sp:${sp} created:${fmtDate(a.createdAt)}`;
  ```

- [ ] **Step 5: Accept an optional budget summary in the embed builder.**
  In `src/discord/admin-ads-list.ts`, import the shared budget type and extend the signature:
  ```ts
  import type { SponsorBudget } from '../sponsors/tier.ts';
  ```
  Change `buildAdminAdsListEmbed(result, state)` to also accept `budget?: SponsorBudget | null`, and
  build a summary line when present:
  ```ts
  export function buildAdminAdsListEmbed(
    result: AdminListResult,
    state: AdminListState,
    budget?: SponsorBudget | null,
  ): { title: string; description: string; color: number } {
    // ...existing filterParts / filterLabel...
    const budgetLine = budget
      ? `\n💰 予算: ティア枠 ${budget.tierWeight} / 配分済 ${budget.used} / 残予算 ${budget.remaining}`
      : '';
    const desc =
      result.ads.length === 0
        ? `${filterLabel}${budgetLine}\n\n該当する広告はありません。`
        : `${filterLabel}${budgetLine}\n\n${result.ads.map(adLine).join('\n')}`;
    return {
      title: `📋 全広告一覧 (${result.totalCount} 件 / page ${result.page}/${result.totalPages})`,
      description: desc,
      color: 0x5865f2,
    };
  }
  ```

- [ ] **Step 6: Run to confirm PASS.**
  `npx vitest run tests/discord/admin-ads-list-budget.test.ts`
  Expected: all four cases passed.

- [ ] **Step 7: Plumb `getSponsorBudget` at the embed call site.**
  Find where `buildAdminAdsListEmbed(result, state)` is invoked (the admin-list interaction handler;
  `grep -rn "buildAdminAdsListEmbed(" src/`). Where a `PgClient` is in scope, compute the budget only
  when the list is filtered to one sponsor and pass it through:
  ```ts
  const budget = state.sponsorId ? await getSponsorBudget(client, state.sponsorId) : null;
  const embed = buildAdminAdsListEmbed(result, state, budget);
  ```
  Add `import { getSponsorBudget } from '../../sponsors/tier.ts';` (adjust depth) at that call site.

- [ ] **Step 8: Update the existing admin-list test row factory + run both admin-list tests.**
  In `tests/discord/admin-ads-list.test.ts`, add `weightAlloc: null,` to the `sampleAd` object (after
  `weightSnapshot: 10,`) so it matches the extended `AdminAdRow` type. Then:
  `npx vitest run tests/discord/admin-ads-list.test.ts tests/discord/admin-ads-list-budget.test.ts`
  Expected: all passed.

- [ ] **Step 9: Typecheck.**
  `npx tsc --noEmit`
  Expected: no errors. Confirm `getSponsorActiveBanners` is NOT defined anywhere in Phase 1:
  `grep -rn "getSponsorActiveBanners" src/ tests/` should print nothing.

- [ ] **Step 10: Commit.**
  `git add src/db/queries/admin-ads.ts src/discord/admin-ads-list.ts tests/discord/admin-ads-list.test.ts tests/discord/admin-ads-list-budget.test.ts && git commit -m "feat(admin-list): per-row weight_alloc + getSponsorBudget summary line"`

---

### Task 12: full-suite green + final verification

Make sure the whole suite passes and nothing drifted (the cron-rewrite-in-same-PR invariant from the spec's risk #1).

**Files:** (none new) — verification only.

- [ ] **Step 1: Run the entire test suite.**
  `npx vitest run`
  Expected: all test files passed (0 failed).

- [ ] **Step 2: Typecheck the whole project.**
  `npx tsc --noEmit`
  Expected: no errors.

- [ ] **Step 3: Lint.**
  `npx biome check .`
  Expected: no errors (fix any with `npx biome check --write .` and re-run).

- [ ] **Step 4: Confirm the cron + approve share the SAME effectiveWeights source.**
  `grep -rn "effectiveWeights" src/services/review/approve.ts src/cron/audit-sponsor-membership.ts`
  Expected: both import from `../../sponsors/tier.ts` / `../sponsors/tier.ts` — single source of truth (spec §2 / risk #3).

- [ ] **Step 5: Confirm the migration exists and the schema column matches.**
  `grep -n "weight_alloc" migrations/0003_weight_alloc.sql src/db/schema.ts`
  Expected: column present in both; CHECK constraints present in schema.

- [ ] **Step 6: Confirm the migration journal is complete (every .sql has an entry).**
  `ls migrations/*.sql && cat migrations/meta/_journal.json`
  Expected: the journal `entries` array has one object per `.sql` file (`0000`–`0003`), ordered by
  ascending `idx` with no gaps, so `wrangler d1 migrations apply` will run `0003` (and the
  previously-unjournaled `0001`/`0002`).

- [ ] **Step 7: Confirm the budget writes are ATOMIC single statements (no unsafe read-then-write).**
  `grep -rn "COALESCE(SUM(weight_alloc), 0)" src/db/queries/review.ts src/interactions/modals/submit-modal.ts`
  Expected: the SUM-guarded subquery appears in BOTH the approve conditional UPDATE
  (`approvePendingWithinBudget`) and the submit-modal conditional INSERT — the budget is enforced in
  the write statement, not by a preceding read (D1 has no row locks; spec §4 / risk #2). Also confirm
  the stale Postgres strings are gone:
  `grep -rn "BEGIN ISOLATION LEVEL REPEATABLE READ\|starts_at = now()" src/` should print nothing.

- [ ] **Step 8: Confirm Phase 1 did NOT define `getSponsorActiveBanners` (Phase-2-only symbol).**
  `grep -rn "getSponsorActiveBanners" src/ tests/`
  Expected: no output. Phase 1's list uses per-row `weight_alloc` + `getSponsorBudget` only.

- [ ] **Step 9: Final commit (if lint/format changed anything).**
  `git add -A && git commit -m "chore(weight-split): finalize phase 1 (suite green, typecheck, lint)"`

---
