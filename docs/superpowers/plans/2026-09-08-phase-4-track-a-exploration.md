# Phase 4 (Track A) Implementation Plan — Exploration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The bot can go and look for blocks it cannot currently see — a bounded, resumable, progress-reporting search — and the search's *cost* is measured rather than merely passing.

**Architecture:** A pure `explore.ts` owns the "where next?" decision, following `harvest.ts`'s precedent, and holds most of the test value. `exploreFor` on the executor is a thin `runAction` shell that walks the waypoints and calls its own `findBlocks` at each. The contract gains one method and one result type, agreed with Track B as a single unit before anything else lands.

**Tech Stack:** TypeScript 7, Node 24 (ESM), npm workspaces, Vitest 5, Mineflayer 4.39.0, mineflayer-pathfinder 2.4.5, Ollama (`qwen3:14b`), tsx.

**Spec:** [`docs/superpowers/specs/2026-09-08-phase-4-track-a-exploration-design.md`](../specs/2026-09-08-phase-4-track-a-exploration-design.md)

## Global Constraints

- Node `>=24`, ESM, `verbatimModuleSyntax` on — `import type` for type-only imports.
- Relative imports carry `.js` (`./explore.js`), per NodeNext resolution.
- Exact version pins. No `^`/`~`. Cross-package deps use the exact string `"0.1.0"`.
- `packages/contract` MUST keep **zero runtime dependencies**.
- `packages/agent` MUST NOT depend on `mineflayer`, `mineflayer-pathfinder`, `prismarine-*` or `@minebot/executor`. `check-invariants.mjs` enforces this including the transitive case.
- **Contract rule:** on abort, an action MUST resolve `{ ok: false, reason: 'interrupted' }` — never throw, never resolve `ok: true`.
- **Never weaken `runContractSuite`.** If an implementation fails an assertion, fix the implementation.
- Unit tests never touch the network **and never require Ollama**. Only `agent:probe` and the demos do.
- Dev server: Fabric 1.21.10 backend on `127.0.0.1:25566` (tmux `mc`), Velocity proxy on `0.0.0.0:25565` (tmux `velocity`). Do not stop or restart either without asking. Drive the backend with `tmux send-keys -t mc '<command>' Enter`.
- Integration tests use a distinct username each and MUST disconnect in `afterEach`. **Usernames are capped at 16 characters.**
- Arena x-ranges in use: **500–560, 800–840, 860–880, 900–930, 950–980, 1000–1020, 1100–1130, 1200–1230, 1300–1330**. This plan uses **1600–1760** (synthetic) and the benchmark world's region, chosen in Task 3.
- Arenas must be separated by more than the largest radius anything might **search** — this plan searches to 64, so leave a wide margin.

## Verified environment facts

Carried in from earlier phases; these are measurements, not assumptions.

- `goto()` resolves as **success** on a zero-length path. A resolved promise is not evidence of arrival — `gotoGoal` takes a post-condition, and any new caller must supply one.
- `bot.pathfinder.searchRadius` is bounded to 128 (issue #15). An unreachable waypoint now reports `unreachable` in ~0.1s rather than burning 5s on `timeout`. Exploration depends on this being fast.
- Parkour reach is **4 blocks displacement = 3 air blocks**, one block shorter than a player's sprint-jump. Real terrain will contain gaps the bot cannot cross; a waypoint beyond one is `unreachable`, which §4.3 of the spec says to skip rather than fail on.
- `/fill` caps at **32768 blocks** and silently refuses unloaded chunks. Large platforms need chunked fills inside a `forceload`ed region, and the fixture must verify its own floor.
- The rules block is **order-sensitive**: a conflicting earlier rule beats a correct later one. Rewrite the rule that is firing rather than adding one that argues with it.
- `SchemaDecider` spends **two** model calls on an undecodable reply.

## File structure

| File | Responsibility |
|---|---|
| `packages/contract/src/index.ts` | **Modify.** `exploreFor`, `ExploreOptions`, `ExplorationReport` |
| `packages/mock-executor/src/mock-executor.ts` | **Modify.** Faithful `exploreFor`, resumable, injectable |
| `packages/mock-executor/src/contract-suite.ts` | **Modify.** Five new shared guarantees |
| `packages/executor/src/explore.ts` | **Create.** Pure waypoint logic. No `mineflayer` import |
| `packages/executor/test/explore.test.ts` | **Create.** Coverage, termination, ordering, resumability |
| `packages/executor/src/mineflayer-executor.ts` | **Modify.** `exploreFor` on `runAction`; resumable state |
| `packages/executor/test/integration/mc-console.ts` | **Modify.** `buildLargePlatform` with self-verification |
| `scripts/bench-world.ts` | **Create.** Qualify a region, place ore reproducibly, verify it |
| `scripts/bench-world.fixture.json` | **Create.** The region's qualification and ore ground truth, committed |
| `scripts/bench-explore.ts` | **Create.** Scored benchmark: N runs, metrics, medians |
| `packages/executor/test/integration/explore.int.test.ts` | **Create.** Fast merge-gating guarantees on a synthetic arena |
| `packages/agent/src/actions.ts`, `prompt.ts`, `dispatch.ts`, `probe.ts` | **Modify.** Menu entry, paired rules, dispatch, probe scenario |
| `packages/bot/src/phase4-demo.ts` | **Create.** Find coal that was never visible |

---

## GATE: Track B agreement (before Task 1) — SATISFIED

Spec §3 changes `packages/contract/` and `packages/mock-executor/` — the shared surface. CLAUDE.md and design spec §4 both require mutual agreement.

- [x] **Confirm Ricky has agreed to design §3 in full** — the method signature, both new types, the "empty search is `ok`" decision, and the five contract-suite guarantees.

**Agreed by Ricky on 2026-09-08**, covering Tasks 1 and 2. Task 1 is the shared
surface and is what the gate exists for; Task 2 (`explore.ts`) is Track A's own
package and needed no agreement, but was reviewed alongside it.

The gate stays in this document rather than being deleted, because the record of
*when and by whom* a contract change was agreed is the thing spec §9 exists to
preserve — the four Phase 2 changes are still legible for the same reason.

**This agreement covers §3 as written.** Any change to the signature, the types,
or the five guarantees discovered during implementation is a new agreement, not
a detail — stop and ask rather than adjusting the contract to fit the code.

---

## Task 1: The contract change

**Files:**
- Modify: `packages/contract/src/index.ts`
- Modify: `packages/mock-executor/src/mock-executor.ts`
- Modify: `packages/mock-executor/src/index.ts`
- Modify: `packages/mock-executor/src/contract-suite.ts`
- Test: `packages/mock-executor/test/mock-executor.test.ts`

**Interfaces:**
- Produces: `exploreFor(names, maxDistance, opts?): Promise<Result<ExplorationReport>>`, `ExploreOptions`, `ExplorationReport`. Tasks 4, 6 and 7 depend on these exact shapes.

- [ ] **Step 1: Write the failing mock tests**

Append to `packages/mock-executor/test/mock-executor.test.ts`:

```ts
describe('MockExecutor.exploreFor', () => {
  const near = { name: 'coal_ore', position: { x: 5, y: 64, z: 0 }, distance: 5 }
  const far = { name: 'coal_ore', position: { x: 90, y: 64, z: 0 }, distance: 90 }

  it('finds blocks within maxDistance and reports the cost', async () => {
    const m = new MockExecutor({ blocks: [near, far] })
    await m.connect()
    const r = await m.exploreFor(['coal_ore'], 32)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.found.map((b) => b.position)).toEqual([near.position])
      expect(r.value.travelled).toBeGreaterThanOrEqual(0)
    }
  })

  it('resolves ok with an empty result when nothing is there', async () => {
    // "I looked and there was nothing" is a successful search, not a failure.
    // Reporting not_found here would make the reason meaningless for mineBlock.
    const m = new MockExecutor({ blocks: [far] })
    await m.connect()
    const r = await m.exploreFor(['coal_ore'], 32)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.found).toEqual([])
      expect(r.value.exhausted).toBe(true)
    }
  })

  it('does not re-report ground already covered by an earlier call', async () => {
    const m = new MockExecutor({ blocks: [far] })
    await m.connect()
    const first = await m.exploreFor(['coal_ore'], 128)
    const second = await m.exploreFor(['coal_ore'], 128)
    expect(first.ok && second.ok).toBe(true)
    if (first.ok && second.ok) {
      expect(second.value.searchedTo).toBeGreaterThanOrEqual(first.value.searchedTo)
      // Once exhausted, staying exhausted is the guarantee that lets a caller
      // stop asking rather than looping forever.
      if (first.value.exhausted) expect(second.value.exhausted).toBe(true)
    }
  })

  it('restarts when the search changes', async () => {
    const m = new MockExecutor({ blocks: [near] })
    await m.connect()
    await m.exploreFor(['coal_ore'], 32)
    const other = await m.exploreFor(['iron_ore'], 32)
    expect(other.ok).toBe(true)
    if (other.ok) expect(other.value.searchedTo).toBe(0)
  })

  it('honours injection, but never above the abort rule', async () => {
    const m = new MockExecutor({ failures: { exploreFor: { reason: 'internal' } } })
    await m.connect()
    const injected = await m.exploreFor(['coal_ore'], 32)
    expect(injected.ok).toBe(false)
    if (!injected.ok) expect(injected.reason).toBe('internal')

    const aborted = await m.exploreFor(['coal_ore'], 32, { signal: AbortSignal.abort() })
    expect(aborted.ok).toBe(false)
    if (!aborted.ok) expect(aborted.reason).toBe('interrupted')
  })

  it('fails disconnected when not connected', async () => {
    const m = new MockExecutor()
    const r = await m.exploreFor(['coal_ore'], 32)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('disconnected')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
npm test
```

Expected: FAIL — `exploreFor` does not exist.

- [ ] **Step 3: Add the contract surface**

In `packages/contract/src/index.ts`, after `BlockQuery`:

```ts
export interface ExploreOptions extends ActionOptions {
  /**
   * How long to spend looking before reporting back. Defaults to 20_000.
   * Bounding this keeps a step observable and the planner's step budget
   * meaningful; an unbounded search would swallow a whole run.
   */
  readonly budgetMs?: number
}

export interface ExplorationReport {
  /** Matches found, nearest first. Empty means "looked, found nothing". */
  readonly found: readonly BlockInfo[]
  /**
   * True when there is nowhere left to look within `maxDistance`. This is the
   * difference between "spend more time" and "spending more time cannot help".
   */
  readonly exhausted: boolean
  /** How far from the search origin the search has reached, in blocks. */
  readonly searchedTo: number
  /** Blocks travelled during this call — the cost of the search, reported. */
  readonly travelled: number
}
```

and inside `interface BotExecutor`:

```ts
  /**
   * Go and look for blocks that are not currently visible.
   *
   * Unlike `findBlocks`, which is free perception over already-loaded chunks,
   * this is an *action*: it moves the bot, consumes real time, and can fail.
   *
   * Returns as soon as it finds anything matching, when `budgetMs` is spent, or
   * when there is nowhere left to look within `maxDistance` — whichever comes
   * first. Finding nothing is `ok` with an empty `found`, NOT a failure:
   * `not_found` stays reserved for "that specific thing is not there".
   *
   * Resumable: calling it again continues outward from where the last call
   * stopped rather than starting over, so a caller can spend effort
   * incrementally. Changing `names` or `maxDistance` starts a fresh search.
   */
  exploreFor(
    names: readonly string[],
    maxDistance: number,
    opts?: ExploreOptions,
  ): Promise<Result<ExplorationReport>>
```

- [ ] **Step 4: Implement it on the mock**

In `packages/mock-executor/src/mock-executor.ts`, add `'exploreFor'` to `MockActionName`, add to `MockOptions`:

```ts
  /** Wall-clock a single exploreFor call should appear to take. Default 0. */
  exploreDelayMs?: number
```

add fields and the method:

```ts
  private exploreSearch: { key: string; searchedTo: number } | null = null

  async exploreFor(
    names: readonly string[],
    maxDistance: number,
    opts?: ExploreOptions,
  ): Promise<Result<ExplorationReport>> {
    this.record('exploreFor', names, maxDistance)
    const r = await this.simulate('exploreFor', opts)
    if (!r.ok) return r

    // Resumability is keyed on the search, not the caller: a different target
    // or radius is a different search and starts from zero. Track B tests the
    // resume path against this, with no server involved.
    const key = `${[...names].sort().join(',')}|${maxDistance}`
    if (this.exploreSearch?.key !== key) this.exploreSearch = { key, searchedTo: 0 }

    if (this.exploreDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.exploreDelayMs))
    }

    const wanted = new Set(names)
    const found = this.blocks
      .filter((b) => wanted.has(b.name) && b.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance)
      .map((b) => ({ name: b.name, position: b.position, distance: b.distance }))

    this.exploreSearch.searchedTo = maxDistance
    return ok({
      found: Object.freeze(found),
      exhausted: found.length === 0,
      searchedTo: this.exploreSearch.searchedTo,
      travelled: found.length === 0 ? maxDistance : (found[0]?.distance ?? 0),
    })
  }
```

Import `ExploreOptions` and `ExplorationReport` from `@minebot/contract`, and read `exploreDelayMs` in the constructor as the other options are read.

- [ ] **Step 5: Add the shared guarantees**

In `packages/mock-executor/src/contract-suite.ts`, add `exploreFor` to `abortableActions`:

```ts
      { name: 'exploreFor', run: (e, opts) => e.exploreFor(['stone'], 16, opts) },
```

and a new sibling `describe` before the outer one closes:

```ts
    // Design: exploration is an ACTION, not perception. These are the
    // behavioural promises Track B builds retry logic against.
    describe('exploreFor', () => {
      it('treats finding nothing as success, not failure', async () => {
        const r = await ctx.executor.exploreFor(['bedrock'], 8)
        expect(r.ok).toBe(true)
        if (r.ok) expect(r.value.found).toEqual([])
      })

      it('never lets searchedTo go backwards within one search', async () => {
        const first = await ctx.executor.exploreFor(['stone'], 32)
        const second = await ctx.executor.exploreFor(['stone'], 32)
        expect(first.ok && second.ok).toBe(true)
        if (first.ok && second.ok) {
          expect(second.value.searchedTo).toBeGreaterThanOrEqual(first.value.searchedTo)
        }
      })

      it('stays exhausted once exhausted', async () => {
        const first = await ctx.executor.exploreFor(['bedrock'], 8)
        if (first.ok && first.value.exhausted) {
          const second = await ctx.executor.exploreFor(['bedrock'], 8)
          expect(second.ok).toBe(true)
          if (second.ok) expect(second.value.exhausted).toBe(true)
        }
      })
    })
```

- [ ] **Step 6: Export and verify**

`packages/mock-executor/src/index.ts` already re-exports the mock's types; no change needed unless `MockActionName` is re-listed there — if it is, leave it as is, since `exploreFor` is a member of that union rather than a new export.

```bash
npm test
npm run typecheck
node scripts/check-invariants.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contract packages/mock-executor
git commit -m "feat(contract): add exploreFor, a bounded resumable search

Phase 4 design §3. The bot had no action that helps when findBlocks
comes back empty, so an unfindable target was indistinguishable from a
broken loop.

Finding nothing resolves ok with an empty result rather than not_found:
'I looked and there was nothing here' is a successful search, and
reserving not_found for 'that specific thing is not there' keeps it
meaningful for mineBlock.

Bounded and resumable rather than one long search, so each step stays
observable and cancellable and the planner keeps the choice of how much
effort to spend.

Agreed with Track B before landing, per design spec §4."
```

---

## Task 2: `explore.ts` — the pure core

Where the real logic lives, following `harvest.ts`. Testable exhaustively in milliseconds.

**Files:**
- Create: `packages/executor/src/explore.ts`
- Modify: `packages/executor/src/index.ts`
- Test: `packages/executor/test/explore.test.ts`

**Interfaces:**
- Produces: `SearchState`, `nextWaypoint`, `searchedRadius`, `DEFAULT_PERCEPTION_RADIUS`. Task 4 consumes all four.

- [ ] **Step 1: Write the failing tests**

`packages/executor/test/explore.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  nextWaypoint,
  searchedRadius,
  DEFAULT_PERCEPTION_RADIUS,
  type SearchState,
} from '../src/explore.js'

const ORIGIN = { x: 0, y: 64, z: 0 }
const base = (over: Partial<SearchState> = {}): SearchState => ({
  origin: ORIGIN,
  visited: [],
  maxDistance: 64,
  spacing: DEFAULT_PERCEPTION_RADIUS,
  ...over,
})

/** Walk the search to completion, returning every waypoint it produced. */
function runToExhaustion(state: SearchState, cap = 5_000): { x: number; y: number; z: number }[] {
  const visited: { x: number; y: number; z: number }[] = []
  for (let i = 0; i < cap; i++) {
    const next = nextWaypoint({ ...state, visited })
    if (next === null) return visited
    visited.push(next)
  }
  throw new Error(`search did not terminate within ${cap} waypoints`)
}

describe('nextWaypoint', () => {
  it('starts where the bot is standing', () => {
    expect(nextWaypoint(base())).toEqual(ORIGIN)
  })

  it('terminates', () => {
    // The failure mode to fear is not a bad search but one that never stops.
    const all = runToExhaustion(base())
    expect(all.length).toBeGreaterThan(1)
    expect(nextWaypoint({ ...base(), visited: all })).toBeNull()
  })

  it('never proposes a waypoint beyond maxDistance', () => {
    for (const wp of runToExhaustion(base())) {
      expect(Math.hypot(wp.x - ORIGIN.x, wp.z - ORIGIN.z)).toBeLessThanOrEqual(64 + 1e-9)
    }
  })

  it('goes outward, so a near block is found before a far one', () => {
    const all = runToExhaustion(base())
    const radii = all.map((w) => Math.hypot(w.x - ORIGIN.x, w.z - ORIGIN.z))
    // Non-decreasing by ring. Points within one ring share a radius.
    for (let i = 1; i < radii.length; i++) {
      expect(radii[i]! + 1e-6).toBeGreaterThanOrEqual(radii[i - 1]!)
    }
  })

  it('covers every point within maxDistance', () => {
    // THE correctness property. Perception at each waypoint reaches `spacing`
    // blocks, so every point must lie within `spacing` of some waypoint or the
    // search has a hole in it. Checked by enumeration, not by argument.
    const all = runToExhaustion(base())
    for (let x = -64; x <= 64; x += 4) {
      for (let z = -64; z <= 64; z += 4) {
        if (Math.hypot(x, z) > 64) continue
        const nearest = Math.min(...all.map((w) => Math.hypot(w.x - x, w.z - z)))
        expect(nearest).toBeLessThanOrEqual(DEFAULT_PERCEPTION_RADIUS)
      }
    }
  })

  it('resumes rather than restarting when handed its own history', () => {
    const first = nextWaypoint(base())!
    const second = nextWaypoint({ ...base(), visited: [first] })
    expect(second).not.toEqual(first)
  })

  it('proposes nothing at all for a zero-radius search', () => {
    const state = base({ maxDistance: 0 })
    expect(nextWaypoint({ ...state, visited: [ORIGIN] })).toBeNull()
  })

  it('keeps the search on the bot\'s own level', () => {
    for (const wp of runToExhaustion(base())) expect(wp.y).toBe(ORIGIN.y)
  })
})

describe('searchedRadius', () => {
  it('is zero before anything is visited', () => {
    expect(searchedRadius(base())).toBe(0)
  })

  it('reports how far out the search has reached', () => {
    const state = base({ visited: [ORIGIN, { x: 32, y: 64, z: 0 }] })
    expect(searchedRadius(state)).toBeCloseTo(32, 5)
  })

  it('ignores elevation, since the search is horizontal', () => {
    const state = base({ visited: [{ x: 0, y: 200, z: 0 }] })
    expect(searchedRadius(state)).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
npm test
```

Expected: FAIL — `../src/explore.js` does not exist.

- [ ] **Step 3: Write the module**

`packages/executor/src/explore.ts`:

```ts
/**
 * Where to look next, kept pure so the search can be tested exhaustively
 * without a server — the same reasoning that put harvestability in
 * `harvest.ts`. This module decides; the executor walks.
 *
 * The strategy is an expanding horizontal spiral: rings of increasing radius
 * around the origin, at the bot's own elevation, with `findBlocks` (free) run
 * at each waypoint. Deliberately horizontal and non-destructive — descending
 * and digging are their own design, and Phase 2 established movement as
 * non-destructive on purpose.
 */
import type { Vec3 } from '@minebot/contract'

/**
 * How far `findBlocks` is asked to see from a waypoint, and therefore how far
 * apart waypoints may sit without leaving a hole between them. Ring spacing
 * and arc spacing both use it, which is what makes the coverage property in
 * explore.test.ts hold.
 */
export const DEFAULT_PERCEPTION_RADIUS = 32

export interface SearchState {
  /** Where the search started. NOT the bot's current position — it moves. */
  readonly origin: Vec3
  /** Waypoints already visited and searched from. */
  readonly visited: readonly Vec3[]
  readonly maxDistance: number
  /** Distance between waypoints; see DEFAULT_PERCEPTION_RADIUS. */
  readonly spacing: number
}

const sameColumn = (a: Vec3, b: Vec3): boolean => a.x === b.x && a.z === b.z

/**
 * Every waypoint this search will ever propose, nearest ring first.
 *
 * Rings are `spacing` apart radially, and each ring carries enough points that
 * neighbours are at most `spacing` apart along the arc. Coordinates are
 * rounded to blocks, which can collide, so callers must tolerate duplicates —
 * `nextWaypoint` does by skipping anything already visited.
 */
function* candidates(state: SearchState): Generator<Vec3> {
  const { origin, maxDistance, spacing } = state
  yield origin
  if (spacing <= 0) return
  for (let radius = spacing; radius <= maxDistance; radius += spacing) {
    const count = Math.max(4, Math.ceil((2 * Math.PI * radius) / spacing))
    for (let i = 0; i < count; i++) {
      const angle = (2 * Math.PI * i) / count
      yield {
        x: Math.round(origin.x + radius * Math.cos(angle)),
        y: origin.y,
        z: Math.round(origin.z + radius * Math.sin(angle)),
      }
    }
  }
}

/**
 * The next place worth standing, or `null` when the space is exhausted.
 *
 * Deterministic given the same state, so a resumed search continues rather
 * than restarting — the executor stores `visited` and hands it straight back.
 */
export function nextWaypoint(state: SearchState): Vec3 | null {
  for (const candidate of candidates(state)) {
    if (!state.visited.some((v) => sameColumn(v, candidate))) return candidate
  }
  return null
}

/**
 * How far from the origin the search has reached, horizontally.
 *
 * Elevation is ignored because the search is horizontal: a waypoint directly
 * above the origin has covered no new ground.
 */
export function searchedRadius(state: SearchState): number {
  let furthest = 0
  for (const v of state.visited) {
    const d = Math.hypot(v.x - state.origin.x, v.z - state.origin.z)
    if (d > furthest) furthest = d
  }
  return furthest
}
```

- [ ] **Step 4: Export it**

Append to `packages/executor/src/index.ts`:

```ts
export { nextWaypoint, searchedRadius, DEFAULT_PERCEPTION_RADIUS } from './explore.js'
export type { SearchState } from './explore.js'
```

- [ ] **Step 5: Run tests and typecheck**

```bash
npm test
npm run typecheck
```

Expected: PASS. If the coverage test fails, **do not widen its tolerance** — that assertion is the entire correctness argument for the search. Reduce `spacing` relative to the perception radius instead.

- [ ] **Step 6: Commit**

```bash
git add packages/executor
git commit -m "feat(executor): add the pure waypoint logic for exploration

Phase 4 design §4.1. The 'where next?' decision is a pure function over
plain data, so it is tested exhaustively in milliseconds rather than
against a server — the same split that put harvestability in harvest.ts.

The load-bearing test is coverage: every point within maxDistance must
lie within perception range of some waypoint, checked by enumeration
rather than by arithmetic argument. A spiral that looks reasonable and
leaves holes is the failure this catches.

Termination is tested explicitly. A search that never stops is a worse
failure than a search that finds nothing."
```

---

## Task 3: The benchmark world

Built **before** the executor work, because everything downstream is easier to iterate on once it can be measured and impossible to evaluate before. Needs no `exploreFor`.

**Files:**
- Create: `scripts/bench-world.ts`
- Create: `scripts/bench-world.fixture.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: `MineflayerExecutor`, `arena-map`'s scanning approach.
- Produces: `npm run bench:world -- qualify|setup|verify`, and the committed fixture Task 6 reads.

- [ ] **Step 1: Write the region qualifier**

`scripts/bench-world.ts`, with a `qualify` subcommand that samples a candidate region and prints a verdict against spec §5.2's criteria:

```ts
/**
 * The benchmark world: a fixed region of REAL terrain with ore at coordinates
 * we place and therefore know exactly.
 *
 * Natural ore cannot be ground truth, because finding out where it is means
 * solving the problem under test. Placing it ourselves gives exact ground truth
 * while keeping real terrain underfoot — and because setup re-places the ore
 * before every run, mining during a run does not rot the fixture.
 *
 *   npm run bench:world -- qualify 3000 3000   # is this region usable?
 *   npm run bench:world -- setup               # place the ore
 *   npm run bench:world -- verify              # terrain and ore still as recorded
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { MineflayerExecutor } from '@minebot/executor'

/** Gentle biomes only. Jungle, swamp, ocean and mountain variants are excluded
 *  deliberately: canopy, water and cliffs would dominate the measurement with
 *  the bot's one-block-short parkour reach rather than test the search. */
const ALLOWED_BIOMES = [
  'minecraft:plains', 'minecraft:sunflower_plains', 'minecraft:forest',
  'minecraft:birch_forest', 'minecraft:savanna', 'minecraft:taiga',
  'minecraft:meadow',
]
/** Surfaces the profile scan treats as ground. */
const GROUND = [
  'grass_block', 'dirt', 'coarse_dirt', 'podzol', 'sand', 'gravel', 'stone',
  'sandstone', 'snow_block', 'clay', 'moss_block',
]
const MAX_SURFACE_RANGE = 8

const mc = (c: string): void => {
  execFileSync('tmux', ['send-keys', '-t', 'mc', c, 'Enter'])
}
const pane = (): string =>
  execFileSync('tmux', ['capture-pane', '-t', 'mc', '-p']).toString()
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Ask the server which allowlisted biome a point is in, if any. */
async function biomeAt(x: number, y: number, z: number): Promise<string | null> {
  for (const biome of ALLOWED_BIOMES) {
    const tag = `BENCHBIOME_${biome.replace('minecraft:', '')}`
    mc(`execute if biome ${x} ${y} ${z} ${biome} run say ${tag}`)
    await sleep(400)
    if (pane().includes(tag)) return biome
  }
  return null
}

/** Highest ground block per column, from what the bot can see. */
function surfaceProfile(
  executor: MineflayerExecutor,
  radius: number,
): Map<string, number> {
  const top = new Map<string, number>()
  for (const b of executor.findBlocks({ names: GROUND, maxDistance: radius, limit: 8000 })) {
    const key = `${b.position.x},${b.position.z}`
    const seen = top.get(key)
    if (seen === undefined || b.position.y > seen) top.set(key, b.position.y)
  }
  return top
}
```

The `qualify` command teleports a scanner bot to the candidate, waits for chunks, builds the profile, and reports: biome, surface min/max/range, and whether any water is present. It **prints a verdict** — accepted or the specific criterion that failed — rather than a wall of numbers.

- [ ] **Step 2: Qualify a real region**

```bash
npm run bench:world -- qualify 3000 3000
```

Try candidates until one is accepted. This is genuine discovery, not a value to guess — the world's terrain decides it. Record what was tried and rejected in the commit message; a rejected candidate is useful information for whoever needs a second region later.

- [ ] **Step 3: Write the fixture**

`scripts/bench-world.fixture.json`, filled from the accepted region:

```json
{
  "verifiedOn": "2026-09-08",
  "biome": "minecraft:plains",
  "start": { "x": 3000, "y": 72, "z": 3000 },
  "surface": { "min": 68, "max": 74, "range": 6 },
  "ore": [
    { "x": 3060, "y": 72, "z": 3004, "block": "coal_ore" },
    { "x": 2940, "y": 71, "z": 3050, "block": "coal_ore" },
    { "x": 3020, "y": 73, "z": 2930, "block": "coal_ore" }
  ]
}
```

Three ore at different bearings and distances, all beyond the 32-block perception radius so none is visible from `start`, and all at surface level because the search is horizontal (design §4.2). Placing one where a horizontal spiral could never reach would test nothing but a known limitation.

`y` per ore comes from the measured surface at that column — not assumed flat.

- [ ] **Step 4: Write `setup` and `verify`**

`setup` must be idempotent and must verify itself:

1. `forceload add` the region.
2. Remove previously placed ore — `setblock <each ore coord> air` — so a re-run does not accumulate.
3. `setblock` each fixture ore.
4. **Verify each one landed**, by scanning from a bot teleported near it. Fail loudly listing any that did not.

`verify` re-reads the surface profile and compares against the fixture's min/max/range, then confirms the ore is present. It exists so a rotted fixture is *detected*, not discovered as a mysterious benchmark regression.

Add to `package.json`:

```json
    "bench:world": "tsx scripts/bench-world.ts",
```

- [ ] **Step 5: Prove setup can fail**

A fixture that can silently no-op is worse than none. Point one fixture ore at a coordinate inside solid rock far underground, run `setup`, and confirm it reports that ore as unverified rather than passing. Restore the fixture afterwards.

```bash
npm run bench:world -- setup
npm run bench:world -- verify
```

Expected: both clean once the fixture is correct, and Step 5's deliberate breakage reported loudly.

- [ ] **Step 6: Commit**

```bash
git add scripts/bench-world.ts scripts/bench-world.fixture.json package.json
git commit -m "test: add a reproducible, realistic benchmark world

The floating arena cannot test search — its virtue is being empty and
known, and search is about the unknown. A flat slab is not much better:
it measures a search against conditions it will never meet.

This is real generated terrain, qualified against measured criteria
rather than eyeballed: a gentle biome from an allowlist, surface height
range within 8 blocks, no surface water. Jungle, swamp and mountains are
excluded on purpose — canopy, water and cliffs would dominate the result
with the bot's one-block-short parkour reach instead of testing search.

Ore is PLACED rather than found, which is what makes exact ground truth
possible on real terrain: discovering where natural ore is means solving
the problem under test. Because setup re-places it before each run,
mining during a run cannot rot the fixture, so the whole find-and-mine
loop is measurable rather than just the looking.

Setup verifies every placement and fails loudly, and verify re-checks
the terrain profile so a region someone has terraformed is detected
rather than surfacing later as a mysterious regression."
```

---

## Task 4: `exploreFor` on the real executor

**Files:**
- Modify: `packages/executor/src/mineflayer-executor.ts`

**Interfaces:**
- Consumes: `runAction`, `gotoGoal` (which REQUIRES a post-condition), `findBlocks`, Task 2's pure core.
- Produces: `MineflayerExecutor.exploreFor` satisfying Task 1's contract.

- [ ] **Step 1: Add the resumable state and the method**

Add the import:

```ts
import { nextWaypoint, searchedRadius, DEFAULT_PERCEPTION_RADIUS, type SearchState } from './explore.js'
```

Add a constant beside the other tuning constants:

```ts
/** Default wall-clock a single exploreFor call may spend. Design §3.2. */
const DEFAULT_EXPLORE_BUDGET_MS = 20_000
```

Add the field:

```ts
  /**
   * The in-progress search, so a second exploreFor continues outward instead of
   * re-walking ground already covered. Keyed on the search itself — different
   * names or radius is a different search and starts fresh. Cleared on
   * disconnect, since the origin refers to a session the bot has left.
   */
  private exploreState: { key: string; origin: Vec3; visited: Vec3[] } | null = null
```

Add the method:

```ts
  async exploreFor(
    names: readonly string[],
    maxDistance: number,
    opts?: ExploreOptions,
  ): Promise<Result<ExplorationReport>> {
    const budgetMs = opts?.budgetMs ?? DEFAULT_EXPLORE_BUDGET_MS
    // The action budget must outlast the search budget, or runAction's timeout
    // fires first and the caller gets `timeout` instead of an honest report of
    // how far the search actually got.
    return this.runAction(opts, budgetMs + 15_000, async (bot, signal) => {
      for (const name of names) {
        if (!bot.registry.blocksByName[name]) {
          return fail('invalid_target', `unknown block name "${name}"`)
        }
      }

      const key = `${[...names].sort().join(',')}|${maxDistance}`
      const here: Vec3 = {
        x: Math.round(bot.entity.position.x),
        y: Math.round(bot.entity.position.y),
        z: Math.round(bot.entity.position.z),
      }
      if (this.exploreState?.key !== key) {
        this.exploreState = { key, origin: here, visited: [] }
      }
      const search = this.exploreState

      const state = (): SearchState => ({
        origin: search.origin,
        visited: search.visited,
        maxDistance,
        spacing: DEFAULT_PERCEPTION_RADIUS,
      })

      const deadline = Date.now() + budgetMs
      let travelled = 0

      const report = (found: readonly BlockInfo[], exhausted: boolean): Result<ExplorationReport> =>
        ok({ found, exhausted, searchedTo: searchedRadius(state()), travelled })

      for (;;) {
        if (signal.aborted) return report([], false)
        if (Date.now() >= deadline) return report([], false)

        const waypoint = nextWaypoint(state())
        if (waypoint === null) return report([], true)

        const before = bot.entity.position.clone()
        const arrival = await this.gotoGoal(
          bot,
          signal,
          new goals.GoalNear(waypoint.x, waypoint.y, waypoint.z, 2),
          () => distanceFrom(bot, waypoint) <= DEFAULT_PERCEPTION_RADIUS,
        )
        travelled += bot.entity.position.distanceTo(before)

        // A waypoint we cannot reach is a fact about terrain, not a failed
        // search: mark it seen and carry on. Anything else — disconnected,
        // internal — is real and ends the call.
        search.visited.push(waypoint)
        if (!arrival.ok && arrival.reason !== 'unreachable' && arrival.reason !== 'timeout') {
          return arrival
        }
        if (signal.aborted) return report([], false)

        const found = this.findBlocks({
          names: [...names],
          maxDistance: DEFAULT_PERCEPTION_RADIUS,
          limit: 8,
        })
        if (found.length > 0) return report(found, false)
      }
    })
  }
```

Import `ExploreOptions` and `ExplorationReport` from `@minebot/contract`.

- [ ] **Step 2: Clear the search on teardown**

In `teardown()`, beside `this.fabricModdedEntries = []`:

```ts
    this.exploreState = null
```

- [ ] **Step 3: Check the arrival post-condition is deliberate**

`gotoGoal`'s fourth argument must not be `() => true` here. The waypoint only needs to be reached closely enough that perception from there covers what it was meant to cover — hence `DEFAULT_PERCEPTION_RADIUS`, not `ARRIVAL_TOLERANCE`. Stopping 3 blocks short is fine; stopping 40 short is a hole in the search that nothing else would catch.

- [ ] **Step 4: Verify**

```bash
npm test
npm run typecheck
node scripts/check-invariants.mjs
npm run smoke && npm run test:integration
```

Expected: PASS. The contract suite now runs its `exploreFor` guarantees against the real executor via `contract.int.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/executor
git commit -m "feat(executor): implement exploreFor as a bounded waypoint walk

Design §4.3. A runAction body, so cancellation, timeout and the
resolve-never-throw rule come for free.

An unreachable waypoint is skipped rather than fatal — a blocked
direction is a fact about terrain, not a failed search. That is only
affordable because #15 bounded searchRadius: an unreachable waypoint now
costs ~0.1s instead of 5s of the budget.

The arrival post-condition is the perception radius, not the movement
tolerance: stopping a few blocks short of a waypoint is harmless,
stopping far short leaves a hole in the search that no test would see."
```

---

## Task 5: Fast integration tests, on a synthetic arena

These gate merges. Task 6's benchmark measures progress; these are the quick correctness guarantees, deliberately on a flat platform where they are fast and deterministic.

**Files:**
- Modify: `packages/executor/test/integration/mc-console.ts`
- Test: `packages/executor/test/integration/explore.int.test.ts`

**Interfaces:**
- Produces: `buildLargePlatform(bounds)`.

- [ ] **Step 1: Add the platform builder**

Append to `mc-console.ts`:

```ts
/**
 * Builds a platform too large for a single `/fill`, in chunked slices.
 *
 * `/fill` caps at 32768 blocks and silently refuses unloaded chunks, so a big
 * arena needs both a forceload and slicing. Search tests need a platform much
 * larger than the perception radius, or the bot sees everything from its start
 * and the test measures nothing.
 *
 * Returns without verifying — call `waitForOnGround` with the expected height
 * before trusting it, exactly as the smaller `buildArena` requires.
 */
export async function buildLargePlatform(bounds: ArenaBounds): Promise<void> {
  const { x0, x1, z0, z1, floorY } = bounds
  const clearance = bounds.clearance ?? 6
  sendConsoleCommand(`forceload add ${x0} ${z0} ${x1} ${z1}`)
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  for (let x = x0; x <= x1; x += 16) {
    const xEnd = Math.min(x + 15, x1)
    sendConsoleCommand(`fill ${x} ${floorY + 1} ${z0} ${xEnd} ${floorY + clearance} ${z1} air`)
    sendConsoleCommand(`fill ${x} ${floorY} ${z0} ${xEnd} ${floorY} ${z1} stone`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const cx = Math.floor((x0 + x1) / 2)
  const cz = Math.floor((z0 + z1) / 2)
  const radius = Math.ceil(Math.hypot(x1 - x0, clearance, z1 - z0) / 2) + 4
  sendConsoleCommand(`kill @e[type=item,x=${cx},y=${floorY},z=${cz},distance=..${radius}]`)
  await new Promise((resolve) => setTimeout(resolve, 800))
}
```

- [ ] **Step 2: Write the tests**

`packages/executor/test/integration/explore.int.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { MineflayerExecutor } from '../../src/index.js'
import {
  buildLargePlatform,
  placeArenaBlock,
  teleportAndWait,
  waitForOnGround,
  type ArenaBounds,
} from './mc-console.js'

// Far larger than the 32-block perception radius, so the ore is genuinely
// invisible from the start. Clear of every other arena.
const ARENA: ArenaBounds = { x0: 1600, x1: 1760, z0: -40, z1: 40, floorY: 199, clearance: 6 }
const START = { x: 1620, y: ARENA.floorY + 1, z: 0 }
const HIDDEN_ORE = { x: 1710, y: ARENA.floorY + 1, z: 0 }

describe('exploreFor against the live server', () => {
  let executor: MineflayerExecutor | null = null

  afterEach(async () => {
    await executor?.disconnect()
    executor = null
  })

  async function arenaBot(username: string, ore: boolean): Promise<MineflayerExecutor> {
    const e = new MineflayerExecutor({ username })
    expect((await e.connect()).ok).toBe(true)
    await buildLargePlatform(ARENA)
    await teleportAndWait(e, username, START)
    await waitForOnGround(e, { expectedY: ARENA.floorY + 1 })
    if (ore) placeArenaBlock(HIDDEN_ORE, 'coal_ore')
    await new Promise((r) => setTimeout(r, 1_000))
    return e
  }

  it('cannot see the ore before it goes looking', async () => {
    // The premise. If findBlocks can already see it, every assertion below is
    // vacuous and this suite proves nothing about exploration.
    executor = await arenaBot('ITExploreSetup', true)
    expect(executor.findBlocks({ names: ['coal_ore'], maxDistance: 32, limit: 5 })).toHaveLength(0)
  })

  it('finds an ore it could not see', async () => {
    executor = await arenaBot('ITExploreFind', true)
    const r = await executor.exploreFor(['coal_ore'], 128, { budgetMs: 90_000 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.found.map((b) => b.position)).toContainEqual(HIDDEN_ORE)
      expect(r.value.travelled).toBeGreaterThan(0)
    }
  })

  it('reports exhausted rather than searching forever when there is nothing', async () => {
    // The failure worth fearing most is not a bad search but one that never
    // stops. A short radius keeps this quick.
    executor = await arenaBot('ITExploreEmpty', false)
    const r = await executor.exploreFor(['diamond_ore'], 48, { budgetMs: 90_000 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.found).toEqual([])
      expect(r.value.exhausted).toBe(true)
    }
  })

  it('resolves interrupted and stops when aborted mid-search', async () => {
    executor = await arenaBot('ITExploreAbort', true)
    const controller = new AbortController()
    const pending = executor.exploreFor(['coal_ore'], 128, {
      signal: controller.signal,
      budgetMs: 90_000,
    })
    setTimeout(() => controller.abort(), 2_000)
    const r = await pending
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('interrupted')
  })

  it('fails invalid_target for a block the registry does not know', async () => {
    executor = await arenaBot('ITExploreBadName', false)
    const r = await executor.exploreFor(['not_a_real_block'], 32)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid_target')
  })
})
```

- [ ] **Step 3: Run them**

```bash
npm run smoke && npm run test:integration -- explore
```

Expected: PASS. Watch the first test — if it fails, the ore is visible from the start and the rest is meaningless.

- [ ] **Step 4: Prove the fixture can fail**

```bash
node -e "
const fs=require('fs');const p='packages/executor/test/integration/explore.int.test.ts';
let s=fs.readFileSync(p,'utf8');
s=s.replace(\"if (ore) placeArenaBlock(HIDDEN_ORE, 'coal_ore')\",'// disabled');
fs.writeFileSync(p,s);"
npm run test:integration -- explore
git checkout packages/executor/test/integration/explore.int.test.ts
```

Expected: FAIL on the find test, PASS again after restoring.

- [ ] **Step 5: Run the whole integration suite, twice**

```bash
npm run test:integration
npm run test:integration
```

Twice, because this repo has been bitten by tests that pass alone and fail together.

- [ ] **Step 6: Commit**

```bash
git add packages/executor/test/integration
git commit -m "test(executor): merge-gating guarantees for exploreFor

Deliberately on a flat platform: these are the fast, deterministic
correctness checks, and the benchmark world measures progress
separately. Mixing the two would make merges wait on a slow measurement
and make the measurement gate on flakiness.

Asserts the premise explicitly — that findBlocks cannot see the ore
before the search runs — because without it every other assertion here
would pass against a bot that simply looked around. Verified the find
test fails with the ore placement disabled."
```

---

## Task 6: The scored benchmark

The thing that makes the search improvable rather than merely working.

**Files:**
- Create: `scripts/bench-explore.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `exploreFor` (Task 4), the benchmark world (Task 3).
- Produces: `npm run bench:explore`.

- [ ] **Step 1: Write the harness**

`scripts/bench-explore.ts`. For each of N runs:

1. `bench-world setup` — re-place the ore, so mining in a previous run cannot affect this one.
2. Connect a bot, teleport to `start`, wait for ground.
3. `exploreFor(['coal_ore'], <radius>, { budgetMs })`, timing it.
4. Record: `found` (and which fixture ore), `travelled`, `elapsed`, `searchedTo`, `exhausted`.
5. Disconnect.

Then print a per-run table and an aggregate: success rate, median `travelled`, median `elapsed`. Medians rather than means, because a single unlucky run should not move the headline number — the same reasoning the probe already uses for latency.

```json
    "bench:explore": "tsx scripts/bench-explore.ts",
```

- [ ] **Step 2: Take the baseline**

```bash
npm run bench:world -- verify
npm run bench:explore -- 10
```

Record the output verbatim in the commit message. **This is the number every future change is compared against**, so it needs to exist before anyone starts tuning.

- [ ] **Step 3: Answer the design's central bet**

Design §8 risk 1: a horizontal spiral may simply not find coal. The benchmark answers it directly — success rate across runs on real terrain.

If the rate is poor, that is a **finding, not a defect to patch around**. Record it plainly; it is the evidence that decides whether descending and cave-following are needed, which is exactly the question this phase exists to settle. Do not quietly widen the radius or the budget until the number looks better.

- [ ] **Step 4: Confirm the fixture survived**

```bash
npm run bench:world -- verify
```

Expected: clean. If terrain drifted, the benchmark modified the world it measures and the reproducibility claim is void.

- [ ] **Step 5: Commit**

```bash
git add scripts/bench-explore.ts package.json
git commit -m "test: score the search, so it can be improved rather than just pass

A pass/fail search cannot be made better; one with a distribution
attached can. Ten runs from a fixed start on real terrain, reporting
success rate and median travelled and elapsed.

Medians rather than means: one unlucky run should not move the headline,
the same reasoning the probe already uses for latency. Repeated runs also
expose variance, which no single demo run can show — and this project has
already been misled once by reading a single run as representative.

Baseline recorded in this commit for future changes to be measured
against."
```

---

## Task 7: The menu action (JOINT — Track B owns the prompt text)

> **UNBLOCKED 2026-09-08.** Tasks 1–6 shipped in PR 19; the
> [perception fix](../specs/2026-09-08-perception-line-of-sight-design.md) has now
> landed, so `find_blocks` no longer returns coal through solid rock and the
> paired `find_blocks` / `explore_for` rule this task tests is no longer vacuous.
>
> Three measured findings from `npm run bench:perception` (2026-09-08) that change
> this task's content, not merely its timing:
>
> 1. **The `emerald_block` fixture gives one usable bearing at *t=0*, not three.**
>    All 3 markers are exposed, but only **1** is visible from the start (49.1
>    blocks). Any step here asserting "a target on each bearing is visible from the
>    start" is false and needs the markers re-sited.
> 2. **`find_blocks` at `maxDistance: 64` is a ~1/3-second call**, and the *empty*
>    answer is the expensive one (perception spec §5.3.1). Step 2's menu entry and
>    the system rules should steer the model to `maxDistance: 32` or less. Per the
>    measured finding in CLAUDE.md, that guidance belongs in the **system rules**,
>    not the menu entry — menu wording moved nothing in the last probe, rules
>    wording flipped 5/5.
> 3. **`find_blocks` for coal will return empty, always**, at the benchmark start
>    (0 of 3216 visible). Step 1's before-measurement should be retaken after the
>    perception fix lands, or the before/after comparison spans two different
>    worlds and attributes the perception change to the menu change.

`packages/agent` is Track B's package. The action shape is proposed in design §6; **the wording is Ricky's call**, and it must be measured rather than assumed.

**Files:**
- Modify: `packages/agent/src/actions.ts`, `dispatch.ts`, `prompt.ts`, `probe.ts`

- [x] **Step 1: Measure the current menu first**

```bash
OLLAMA_HOST=http://127.0.0.1:11434 npm run agent:probe
```

Record every scenario's choice. A bigger toolbox is a real test of whether a 14B model stays reliable at tool selection, so this is the before-number that says whether adding an action cost anything.

**Baseline retaken 2026-09-08, AFTER the line-of-sight fix landed** — `qwen3:14b`,
5 attempts each. Retaken deliberately: the earlier baseline was measured against a
bot with X-ray vision, and comparing a post-perception "after" against a
pre-perception "before" would credit the menu change with the perception change.

| Scenario | Hoped | Chose | Decoded |
|---|---|---|---|
| no history | `find_blocks` | `find_blocks` ×5 | 5/5 |
| after a search | `mine_block_at` | `mine_block_at` ×5 | 5/5 |
| after missing_tool, inventory empty | `give_up` | `give_up` ×5 | 5/5 |
| mined but the drop was lost | `move_to` | `move_to` ×5 | 5/5 |
| mine_block_at already returned not_found | `find_blocks` or `give_up` | `give_up` ×5 | 5/5 |
| goal met | `done` | `done` ×5 | 5/5 |

**TOTAL 30/30 decoded, median 353ms.** Every scenario matched its hope, so any
post-change deviation is attributable to the change rather than to noise.

Note the fifth row for Step 5: it currently answers `give_up` 5/5. Once
`explore_for` exists, `give_up` is arguably the *wrong* answer there — see the
second rule edit in the §7.1 draft, which is a behaviour change this plan did not
anticipate.

### Step 1a: the larger menu DID degrade tool selection — RICKY NEEDED

Step 1 exists to catch exactly this, and it caught it. Same model, same
scenarios, 5 attempts each, three states measured:

| Scenario | baseline (7 actions) | + `explore_for` in menu | + menu + drafted rules |
|---|---|---|---|
| no history | `find_blocks` ×5 | `find_blocks` ×5 | `find_blocks` ×5 |
| after a search | `mine_block_at` ×5 | `mine_block_at` ×5 | `mine_block_at` ×5 |
| after missing_tool | `give_up` ×5 | `give_up` ×5 | `give_up` ×5 |
| mined but drop lost | `move_to` ×5 | `move_to` ×5 | `move_to` ×5 |
| **not_found already** | **`give_up` ×5** | **`move_to` ×5** | **`move_to` ×5** |
| goal met | `done` ×5 | `done` ×5 | `done` ×5 |

30/30 decoded in all three states, so this is tool *selection* degrading, not
decoding.

**What it means.** Five of six scenarios are unmoved by the bigger menu — the
14B model holds up fine on size alone. The sixth breaks, and it breaks into
`move_to`, which the rules block explicitly forbids for that position ("Do NOT
move to or mine that position again — it cannot help"). So the model is not
choosing a defensible alternative; it is being pulled by the earlier
`move_to that position ONCE` rule over the later prohibition. That is precisely
the order-sensitivity Step 4 is written about.

**The drafted rules did not fix it.** Both §7.1 edits were applied and measured:
no change, still `move_to` ×5. Plausibly the first edit makes things worse by
growing the rules block from one line to seven, pushing the prohibition further
from the top — but that is a hypothesis, not a measurement.

**This is Ricky's call and Track A stopped here deliberately.** Iterating on
wording by intuition is what the probe exists to prevent, and prompt text is his
package. What he has to work with: a reproducible regression, a baseline to
return to, and a draft that is measured NOT to work.

- [ ] **Step 2: Add the action to the schema and menu**

In `actions.ts`, add `explore_for` to `ACTION_NAMES`, its variant to `ACTION_SCHEMA` (`names: string[]`, `maxDistance: number`), and a menu entry:

```
explore_for         {"action":"explore_for","names":["coal_ore"],"maxDistance":64}
                    Walk around looking for blocks you cannot currently see.
                    Slow — it moves the bot and takes time.
```

- [ ] **Step 3: Dispatch it**

```ts
    case 'explore_for':
      return {
        kind: 'result',
        result: await executor.exploreFor(action.names, action.maxDistance, { signal }),
      }
```

`StepOutcome`'s `result` case already carries `Result<unknown>`, so no new outcome kind is needed — but give the report a readable rendering in `renderOutcome` (found count, `searchedTo`, `exhausted`) rather than letting an object stringify into the prompt.

- [ ] **Step 4: Rewrite the find/explore rules TOGETHER**

Not as two adjacent descriptions. The rules block is order-sensitive, and a conflicting earlier rule beats a correct later one — measured while fixing the `not_found` oscillation, where *adding* a rule changed nothing and *merging* fixed it outright.

Replace the existing `find_blocks` rule with one paired instruction:

```
- Blocks are NOT listed in the state. find_blocks looks around from where you
  already are — it is instant and free, but only sees nearby loaded ground.
  If find_blocks returns nothing, the block may still exist further away:
  use explore_for to go and look. explore_for is slow and moves the bot, so
  use it only after find_blocks has come up empty.
```

- [ ] **Step 5: Add a probe scenario and measure**

```ts
  {
    // The decision the whole action exists to enable: find_blocks came up
    // empty, so the useful move is to go looking rather than to give up.
    name: 'find_blocks found nothing',
    goal: 'get me some coal',
    inventory: [PICKAXE],
    history: [
      step(
        1,
        { action: 'find_blocks', names: ['coal_ore'], maxDistance: 32, limit: 5 },
        { kind: 'blocks', blocks: [] },
      ),
    ],
    hoped: ['explore_for'],
  },
```

```bash
npm test
npm run agent:probe
```

Expected: the new scenario chooses `explore_for`, **and every pre-existing scenario chooses what it chose in Step 1**. A regression elsewhere means the larger menu has degraded tool selection — report it rather than accepting it, and iterate with the probe rather than by intuition.

- [ ] **Step 6: Commit**

```bash
git add packages/agent
git commit -m "feat(agent): let the model go looking when find_blocks comes up empty

Design §6. Until now an empty search was a dead end: nothing in the menu
could help, so give_up was the only correct move.

find_blocks and explore_for are written as ONE paired instruction rather
than two adjacent descriptions, because the rules block is
order-sensitive — measured earlier, where adding a rule changed nothing
and merging the conflicting pair fixed it.

Probe re-run across every scenario, not only the new one: a bigger menu
is a real test of whether a 14B model stays reliable at tool selection."
```

---

## Task 8: Demo, docs and the pull request

**Files:**
- Create: `packages/bot/src/phase4-demo.ts`
- Modify: `package.json`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: Write the demo**

`packages/bot/src/phase4-demo.ts`, modelled on `phase3-demo.ts` but running in the **benchmark world** rather than a built arena — the deliverable is finding coal in real terrain, and a demo on a flat slab would not show it.

Run `bench-world setup`, teleport to `start`, then `runBotGoal('get me some coal')`.

The demo must fail unless the model actually explored: assert the step log contains an `explore_for` step, not merely that coal was collected. A run that succeeded by luck of the starting position proves nothing.

- [ ] **Step 2: Add the script**

```json
    "demo:phase4": "tsx packages/bot/src/phase4-demo.ts",
```

- [ ] **Step 3: Run it**

```bash
npm run smoke && npm run demo:phase4
```

Expected: exit 0, with `explore_for` in the step log.

- [ ] **Step 4: Update the docs**

- `README.md`: status line, test counts, `demo:phase4` and the two `bench:*` commands in the table, roadmap Phase 4 Track A marked done.
- `CLAUDE.md`: commands block, test counts, and the facts this phase produced — at minimum the benchmark baseline from Task 6, the benchmark world's coordinates and why that region was chosen, and the answer to design §8 risk 1.

- [ ] **Step 5: Full verification**

```bash
npm test
npm run typecheck
node scripts/check-invariants.mjs
npm run smoke && npm run test:integration
npm run agent:probe
npm run bench:world -- verify
npm run demo:phase2 && npm run demo:phase3 && npm run demo:phase4
```

Record actual counts and the benchmark numbers in the commit message rather than asserting "all tests pass".

- [ ] **Step 6: Commit and open the PR**

```bash
git add package.json README.md CLAUDE.md packages/bot
git commit -m "feat: add the Phase 4 demo and record what exploration cost"
git push -u origin phase-4-exploration
gh pr create --base main --title "Phase 4 (Track A): exploration" --body "..."
```

The PR body must state the benchmark baseline and answer design §8 risk 1 — whether a horizontal spiral finds coal on real terrain — because that answer decides whether descending and cave-following come next.

---

## Self-review

**Spec coverage.** §1 problem → whole plan. §2 option C → Tasks 1, 4. §3 contract + GATE → GATE, Task 1. §3.4 mock → Task 1 Step 4. §3.5 suite → Task 1 Step 5. §4.1 pure core → Task 2. §4.2 spiral and spacing → Task 2 Step 3, coverage test in Step 1. §4.3 executor shell → Task 4. §5.1 unit tests → Task 2. §5.2 benchmark world, terrain qualification, placed ore, idempotent setup → Task 3. §5.3 the score → Task 6. §5.4 fast integration tests → Task 5. §5.5 model behaviour → Task 7. §6 menu → Task 7. §7 not-in-scope → nothing here digs or descends. §8 risks → Task 6 Step 3 and Task 8 Step 6 both require answering risk 1. No spec section is unimplemented.

**Type consistency.** `exploreFor(names, maxDistance, opts?)` is called identically in Tasks 1, 4, 5, 6, 7. `ExplorationReport`'s four fields are produced in Tasks 1 and 4 and consumed in Tasks 1, 5 and 6. `SearchState`'s four fields are defined in Task 2 and constructed in Task 4. `nextWaypoint` / `searchedRadius` / `DEFAULT_PERCEPTION_RADIUS` are defined in Task 2 Step 3 and used in Task 4 Step 1. `gotoGoal`'s four-argument form matches its current signature. `buildLargePlatform(bounds: ArenaBounds)` is defined in Task 5 Step 1 and used in Task 5 Step 2. The fixture shape written in Task 3 Step 3 is read in Tasks 6 and 8.

**Known risks carried into execution:**

1. **The spiral may not find coal on real terrain.** Design §8 risk 1, and the central bet. Task 6 answers it with a number. If the rate is poor, that is a finding to report, not a defect to patch around by widening the radius until it looks better.
2. **`DEFAULT_PERCEPTION_RADIUS = 32` is asserted correct only by Task 2's coverage test.** If it fails, reduce spacing; never widen the tolerance, because that assertion *is* the correctness argument.
3. **Region qualification is genuine discovery.** Task 3 Step 2 may reject several candidates before one passes. That is the work, not a blocker — but it means Task 3 cannot be time-boxed confidently.
4. **The benchmark region depends on nobody terraforming it.** `bench:world verify` detects it, which turns a silently rotted fixture into a loud failure.
5. **The menu grows to seven actions.** Task 7 Step 1 takes a before-measurement precisely so degraded tool selection is visible rather than assumed away.
6. **Trees.** A gentle biome still has them, and the bot may path around or get stuck on them in ways a flat arena never showed. That is the point of using real terrain, but expect Task 6's first baseline to be worse than the synthetic arena suggests.
