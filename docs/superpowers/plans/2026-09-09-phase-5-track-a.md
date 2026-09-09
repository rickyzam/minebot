# Phase 5 (Track A) Implementation Plan — the full toolbox

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the executor's four remaining stubs — `attack`, `flee`, `followPlayer`, `placeBlock` — into working behaviour, and build the reflex arbiter the design has specified since Phase 1 but never implemented.

**Architecture:** The arbiter is a **decorator over `BotExecutor`**, not a change to the planning loop. It wraps a real executor, subscribes to the push event stream, and when a trigger rule fires it aborts the in-flight action and runs its own recovery before returning `interrupted` to the caller. This is what makes the phase possible without touching `packages/agent`: the planner already treats `interrupted` as "re-plan from current state", which is exactly the documented protocol (design §3.5). Trigger rules stay pure functions over `WorldSnapshot` so they can be tested exhaustively with no server and no model.

**Tech Stack:** TypeScript, ESM, Node 24+, Vitest, `mineflayer` + `mineflayer-pathfinder`, the live dev server for integration.

**Spec:** [docs/superpowers/specs/2026-09-09-phase-5-full-toolbox-design.md](../specs/2026-09-09-phase-5-full-toolbox-design.md)

## Global Constraints

- **`packages/contract/` and `packages/mock-executor/` are shared surface.** Track B builds against them with no server. Do not change a type, signature, or documented guarantee without agreement. Additive changes still need agreement.
- **Never weaken `runContractSuite`.** All six actions must keep resolving `{ ok: false, reason: 'interrupted' }` — never throwing — when handed an already-aborted signal. `runAction()` provides this; do not re-add it by hand.
- **The `FailureReason` set is closed.** `not_found | unreachable | interrupted | invalid_target | missing_tool | inventory_full | timeout | disconnected | internal`. Map new failures onto these; adding one is a contract change.
- **`packages/agent/` must not depend on `mineflayer` or `@minebot/executor`**, including transitively. `check-invariants.mjs` enforces it. Anything needing both tracks goes in `packages/bot/`.
- **Do not add menu entries to `ACTION_MENU`.** Prompt text and tool exposure are Phase 5 Track B.
- **`scripts/` and `demo:*` are outside `npm test`.** Run them before claiming a phase is green — Phase 4 broke `bench:world` and `demo:phase2` while the whole sweep stayed green.
- **Exact version pins**, no `^`/`~`. Cross-package deps use the exact string `"0.1.0"`. Relative imports carry `.js`.
- **Prove every guard can fire.** A safety check nobody has seen trigger is not known to work.
- Verified environment facts that bear on this plan: **an undead mob on the open y=199 arena burns to death in 21 seconds** (spec §4.1) — combat arenas must be roofed. **`goto()` resolves as SUCCESS on a zero-length path**, so a resolved promise is not evidence of arrival; verify against the world.

## File structure

| File | Responsibility |
|---|---|
| `packages/executor/src/reflex.ts` | **Create.** Pure trigger rules over `WorldSnapshot`. No Mineflayer, no I/O |
| `packages/executor/test/reflex.test.ts` | **Create.** Exhaustive unit tests for the rules |
| `packages/bot/src/reflex-executor.ts` | **Create.** The arbiter: a `BotExecutor` decorator that preempts |
| `packages/bot/test/reflex-executor.test.ts` | **Create.** Arbitration tests against `MockExecutor` — no server |
| `packages/executor/src/mineflayer-executor.ts` | **Modify.** Replace four stubs |
| `packages/executor/src/schematic.ts` | **Create.** Pure schematic parsing and placement ordering |
| `packages/executor/test/schematic.test.ts` | **Create.** Unit tests for ordering and validation |
| `packages/executor/test/integration/combat.int.test.ts` | **Create.** Roofed arena, live mob |
| `packages/executor/test/integration/place.int.test.ts` | **Create.** `placeBlock` against the arena |
| `packages/executor/test/integration/follow.int.test.ts` | **Create.** `followPlayer` against a second bot |
| `packages/bot/src/phase5-demo.ts` | **Create.** The deliverable |

---

## Task 1: Reflex trigger rules (pure)

**Files:**
- Create: `packages/executor/src/reflex.ts`
- Create: `packages/executor/test/reflex.test.ts`
- Modify: `packages/executor/src/index.ts`

**Interfaces:**
- Consumes: `WorldSnapshot`, `EntityInfo` from `@minebot/contract`.
- Produces: `evaluateReflex(snapshot, thresholds?) => ReflexTrigger | null`, `DEFAULT_REFLEX_THRESHOLDS`, types `ReflexTrigger` and `ReflexThresholds`. Task 2 consumes all of these.

- [ ] **Step 1: Write the failing tests**

`packages/executor/test/reflex.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { EntityInfo, WorldSnapshot } from '@minebot/contract'
import { evaluateReflex, DEFAULT_REFLEX_THRESHOLDS } from '../src/reflex.js'

const hostile = (id: number, distance: number): EntityInfo => ({
  id, name: 'zombie', kind: 'hostile', position: { x: distance, y: 64, z: 0 }, distance,
})
const passive = (id: number, distance: number): EntityInfo => ({
  id, name: 'cow', kind: 'passive', position: { x: distance, y: 64, z: 0 }, distance,
})

const snap = (health: number, nearbyEntities: EntityInfo[]): WorldSnapshot => ({
  takenAt: 0,
  self: {
    position: { x: 0, y: 64, z: 0 }, health, food: 20, dimension: 'overworld',
    onGround: true, inventory: [], heldItem: null,
  },
  nearbyEntities,
})

describe('evaluateReflex', () => {
  it('does nothing when healthy and alone', () => {
    expect(evaluateReflex(snap(20, []))).toBeNull()
  })

  it('attacks the nearest hostile in range when healthy', () => {
    const t = evaluateReflex(snap(20, [hostile(2, 6), hostile(1, 3)]))
    expect(t).toEqual({ kind: 'attack', entityId: 1, reason: expect.any(String) })
  })

  it('flees instead of attacking when health is at or below the threshold', () => {
    const t = evaluateReflex(snap(DEFAULT_REFLEX_THRESHOLDS.fleeBelowHealth, [hostile(1, 3)]))
    expect(t?.kind).toBe('flee')
  })

  it('does NOT flee on low health with no hostile nearby', () => {
    // Fleeing from nothing wastes the action and moves the bot away from
    // whatever it was doing. Low health alone is not an emergency.
    expect(evaluateReflex(snap(1, []))).toBeNull()
  })

  it('ignores hostiles beyond the radius', () => {
    const far = DEFAULT_REFLEX_THRESHOLDS.hostileRadius + 1
    expect(evaluateReflex(snap(20, [hostile(1, far)]))).toBeNull()
  })

  it('ignores passive and player entities entirely', () => {
    expect(evaluateReflex(snap(20, [passive(1, 1)]))).toBeNull()
  })

  it('honours overridden thresholds', () => {
    expect(evaluateReflex(snap(20, [hostile(1, 12)]), { hostileRadius: 16 })?.kind).toBe('attack')
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run --project unit packages/executor/test/reflex.test.ts`
Expected: FAIL — `Cannot find module '../src/reflex.js'`.

- [ ] **Step 3: Implement the rules**

`packages/executor/src/reflex.ts`:

```ts
/**
 * The reflex layer's decision, kept pure so every rule can be tested
 * exhaustively without a server, a model, or a mob. Design §3.5: reflex beats
 * plan, always — but only when there is something to react to.
 */
import type { EntityInfo, WorldSnapshot } from '@minebot/contract'

export interface ReflexThresholds {
  /** At or below this health, disengage rather than fight. */
  readonly fleeBelowHealth: number
  /** How close a hostile must be to matter, in blocks. */
  readonly hostileRadius: number
}

/**
 * 6 of 20 health is three hearts: two hits from most early hostiles. The
 * radius is a little beyond a zombie's reach, so the trigger fires while there
 * is still room to react rather than after the first hit lands.
 */
export const DEFAULT_REFLEX_THRESHOLDS: ReflexThresholds = Object.freeze({
  fleeBelowHealth: 6,
  hostileRadius: 8,
})

export type ReflexTrigger =
  | { readonly kind: 'flee'; readonly reason: string }
  | { readonly kind: 'attack'; readonly entityId: number; readonly reason: string }

/**
 * What, if anything, the reflex layer should do about this snapshot.
 *
 * `null` means "nothing" and is the overwhelmingly common answer. Note that low
 * health ALONE returns null: fleeing from nothing costs an action and moves the
 * bot away from whatever it was doing, and the planner is a better judge of
 * "should I go eat" than a reflex is.
 */
export function evaluateReflex(
  snapshot: WorldSnapshot,
  thresholds: Partial<ReflexThresholds> = {},
): ReflexTrigger | null {
  const { fleeBelowHealth, hostileRadius } = { ...DEFAULT_REFLEX_THRESHOLDS, ...thresholds }

  const hostiles = snapshot.nearbyEntities.filter(
    (e: EntityInfo) => e.kind === 'hostile' && e.distance <= hostileRadius,
  )
  if (hostiles.length === 0) return null

  const nearest = hostiles.reduce((a, b) => (b.distance < a.distance ? b : a))

  if (snapshot.self.health <= fleeBelowHealth) {
    return {
      kind: 'flee',
      reason: `health ${snapshot.self.health} at or below ${fleeBelowHealth} with ${nearest.name} ${nearest.distance.toFixed(1)} away`,
    }
  }
  return {
    kind: 'attack',
    entityId: nearest.id,
    reason: `${nearest.name} ${nearest.distance.toFixed(1)} away`,
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run --project unit packages/executor/test/reflex.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Export from the package index**

Add to `packages/executor/src/index.ts`:

```ts
export { evaluateReflex, DEFAULT_REFLEX_THRESHOLDS } from './reflex.js'
export type { ReflexThresholds, ReflexTrigger } from './reflex.js'
```

- [ ] **Step 6: Verify and commit**

```bash
npm test && npm run typecheck && node scripts/check-invariants.mjs
git add packages/executor/src/reflex.ts packages/executor/test/reflex.test.ts packages/executor/src/index.ts
git commit -m "feat(executor): reflex trigger rules, as pure functions

Design §3.5 plans these as pure predicates over a fake WorldSnapshot so they
can be tested exhaustively with no server, no model and no mob. Kept that way.

Low health ALONE deliberately returns null. Fleeing from nothing costs an
action and moves the bot away from whatever it was doing, and the planner is a
better judge of 'should I go eat' than a reflex is. The trigger is health AND
a hostile in range."
```

---

## Task 2: The arbiter — a preempting `BotExecutor` decorator

**Files:**
- Create: `packages/bot/src/reflex-executor.ts`
- Create: `packages/bot/test/reflex-executor.test.ts`
- Modify: `packages/bot/src/index.ts`

**Interfaces:**
- Consumes: `evaluateReflex`, `ReflexThresholds` (Task 1); `BotExecutor`, `BotEvents`, `Result` from `@minebot/contract`.
- Produces: `class ReflexExecutor implements BotExecutor`, constructed as `new ReflexExecutor(inner, { thresholds?, onPreempt? })`, plus `readonly preemptions: ReflexPreemption[]`. Task 7's demo consumes it.

**Why a decorator.** It needs the executor's events and the ability to abort an in-flight action. Wrapping the executor gives both without touching `packages/agent` — the planner keeps passing its own signal and keeps seeing `interrupted`, which design §3.5 already tells it to treat as "re-plan from current state".

- [x] **Step 1: Confirm the premise before building on it — VERIFIED 2026-09-09**

The arbiter's design rests on the planner re-planning rather than stopping when an action resolves `interrupted` with no outer abort. That is already true, and already deliberate — `packages/agent/src/loop.ts:161-165`:

```ts
// The caller aborting ends the goal. An `interrupted` result *without* an
// outer abort is the reflex layer preempting: fall through, re-observe,
// and decide again from fresh state. Never retry the interrupted action
// against the snapshot it was chosen for — after a flee, that position is
// a lie (design §8, spec §3.5).
if (outer?.aborted) {
  return { status: 'interrupted', detail: 'the caller aborted the goal', steps }
}
```

So Track B built the planner half of §3.5 already and left the arbiter-shaped hole for Track A. Nothing in `packages/agent` needs to change, and the decorator plugs straight into a contract the loop is already written against. Re-read it before starting anyway — if it has changed, the design changes with it.

- [ ] **Step 2: Write the failing tests**

`packages/bot/test/reflex-executor.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { MockExecutor } from '@minebot/mock-executor'
import { ReflexExecutor } from '../src/reflex-executor.js'

const hostileAt = (distance: number) => ({
  id: 1, name: 'zombie', kind: 'hostile' as const,
  position: { x: distance, y: 64, z: 0 }, distance,
})

describe('ReflexExecutor', () => {
  it('passes actions through untouched when nothing triggers', async () => {
    const inner = new MockExecutor({ position: { x: 0, y: 64, z: 0 } })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    expect((await reflex.moveTo({ x: 5, y: 64, z: 5 })).ok).toBe(true)
    expect(reflex.preemptions).toHaveLength(0)
  })

  it('preempts an in-flight action when a hostile appears', async () => {
    const inner = new MockExecutor({ actionDelayMs: 500, entities: [hostileAt(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()

    const pending = reflex.moveTo({ x: 99, y: 64, z: 99 })
    inner.emit('damaged', { health: 20, source: null })
    const r = await pending

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('interrupted')
    expect(reflex.preemptions).toHaveLength(1)
    expect(reflex.preemptions[0]?.trigger.kind).toBe('attack')
  })

  it('runs the recovery action, not just the abort', async () => {
    const inner = new MockExecutor({ actionDelayMs: 500, entities: [hostileAt(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    const pending = reflex.moveTo({ x: 99, y: 64, z: 99 })
    inner.emit('damaged', { health: 20, source: null })
    await pending
    expect(inner.calls.map((c) => c.name)).toContain('attack')
  })

  it('flees rather than attacking when health is low', async () => {
    const inner = new MockExecutor({ actionDelayMs: 500, health: 3, entities: [hostileAt(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    const pending = reflex.moveTo({ x: 99, y: 64, z: 99 })
    inner.emit('damaged', { health: 3, source: null })
    await pending
    expect(inner.calls.map((c) => c.name)).toContain('flee')
  })

  it('does not preempt its own recovery action', async () => {
    // Re-entrancy: the recovery runs while the same events keep arriving. A
    // reflex that aborts its own flee never actually flees.
    const inner = new MockExecutor({ actionDelayMs: 300, health: 3, entities: [hostileAt(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    const pending = reflex.moveTo({ x: 99, y: 64, z: 99 })
    inner.emit('damaged', { health: 3, source: null })
    inner.emit('damaged', { health: 2, source: null })
    inner.emit('damaged', { health: 1, source: null })
    await pending
    expect(reflex.preemptions).toHaveLength(1)
    expect(inner.calls.filter((c) => c.name === 'flee')).toHaveLength(1)
  })

  it('still honours the caller\'s own signal', async () => {
    const inner = new MockExecutor({ actionDelayMs: 500 })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    const c = new AbortController()
    const pending = reflex.moveTo({ x: 99, y: 64, z: 99 }, { signal: c.signal })
    c.abort()
    const r = await pending
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('interrupted')
    expect(reflex.preemptions).toHaveLength(0)
  })

  it('resolves interrupted — never throws — for a pre-aborted signal', async () => {
    const inner = new MockExecutor()
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    const r = await reflex.moveTo({ x: 1, y: 64, z: 1 }, { signal: AbortSignal.abort() })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('interrupted')
  })
})
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run --project unit packages/bot/test/reflex-executor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the decorator**

Write `packages/bot/src/reflex-executor.ts` implementing `BotExecutor` by delegation. Required behaviour, each point matching a test above:

1. Constructor `(inner: BotExecutor, opts?: { thresholds?: Partial<ReflexThresholds>; onPreempt?: (p: ReflexPreemption) => void })`.
2. Subscribe to `damaged` and `health` in the constructor — the contract guarantees subscriptions are safe before `connect()` and survive reconnects.
3. On an event: if no action is in flight, or a recovery is already running, do nothing. Otherwise call `inner.getState()`, pass it to `evaluateReflex`, and if it returns a trigger, abort the in-flight action's internal controller and record a `ReflexPreemption { trigger, at: Date.now() }`.
4. Wrap every action: build an internal `AbortController`, forward `caller.signal` aborts onto it, pass the internal signal down.
5. After the aborted action settles, run the recovery — `inner.attack(entityId)` or `inner.flee()` — under a **separate** controller, with a re-entrancy flag set so rule 3 ignores events during it.
6. Return `fail('interrupted', …)` to the caller for the preempted action.
7. `getState`, `findBlocks`, `on`, `chat`, `stop`, `connect`, `disconnect` delegate straight through.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run --project unit packages/bot/test/reflex-executor.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Run the shared contract suite against the decorator**

The decorator is a `BotExecutor`, so it must satisfy the same contract. Add to `packages/bot/test/reflex-executor.test.ts`:

```ts
import { runContractSuite } from '@minebot/mock-executor/contract-suite'

runContractSuite('ReflexExecutor over MockExecutor', async () => {
  const inner = new MockExecutor({ actionDelayMs: 20, blocks: [...] }) // mirror the mock suite's seeding
  const executor = new ReflexExecutor(inner)
  await executor.connect()
  return { executor, cleanup: () => executor.disconnect(), expectFindable: { ... }, prepareVisibilityFixture: ... }
})
```

Copy the seeding from `packages/mock-executor/test/mock-executor.test.ts` verbatim so the same guarantees are exercised. If any assertion fails, fix the decorator — never the suite.

- [ ] **Step 7: Verify and commit**

```bash
npm test && npm run typecheck && node scripts/check-invariants.mjs
git add packages/bot
git commit -m "feat(bot): the reflex arbiter, as an executor decorator

Design §3.5 specified this protocol in Phase 1 and assigned the arbiter to
Track A; it has never existed, and CLAUDE.md records the evidence — a reflex
preemption was unreachable.

A decorator rather than a change to the planning loop. Wrapping BotExecutor
gives the arbiter both things it needs — the event stream and the ability to
abort an in-flight action — without touching packages/agent. The planner keeps
passing its own signal and keeps seeing 'interrupted', which §3.5 already tells
it to treat as re-plan-from-current-state.

Re-entrancy is explicit, not discovered: a reflex that preempts its own
recovery never actually flees, so events arriving during recovery are ignored
and the test proves it with three damage events and one flee.

Runs the full contract suite against the decorator, because it is a
BotExecutor and must satisfy the same guarantees as the thing it wraps."
```

---

## Task 3: `followPlayer` — BLOCKED on spec Decision 3

**Do not start this task until Ricky has answered spec §7 Decision 3:** when does `followPlayer` return? `GoalFollow` never finishes by itself, and the contract's doc comment does not say. This is a documented-guarantee gap in a shared surface.

Track A's recommendation to put to him: **follow until aborted, or until `timeoutMs` elapses**, documented as the one action that requires a signal or a timeout to terminate.

**Files:**
- Modify: `packages/executor/src/mineflayer-executor.ts` (the `followPlayer` stub)
- Modify: `packages/contract/src/index.ts` (doc comment only, once agreed)
- Create: `packages/executor/test/integration/follow.int.test.ts`

- [ ] **Step 1: Get the answer, and record it in the spec's §7 before writing code.**
- [ ] **Step 2: Write the integration test** — two bots in an arena, one teleported repeatedly, asserting the follower's distance closes and stays closed, and that abort ends it promptly.
- [ ] **Step 3: Implement** using the pathfinder's `GoalFollow`, honouring the agreed termination rule.
- [ ] **Step 4: Verify** the whole integration suite, then commit.

---

## Task 4: `placeBlock`

**Files:**
- Modify: `packages/executor/src/mineflayer-executor.ts`
- Create: `packages/executor/test/integration/place.int.test.ts`

**Interfaces:**
- Produces: a working `placeBlock(blockName, position, opts)`. Task 5 depends on it.

The gap to close: the contract takes `(blockName, position)`, Mineflayer takes `(referenceBlock, faceVector)`. The executor must choose a reference face, equip the block, and be in reach.

Failure mapping, using only the closed set:

| Situation | `FailureReason` |
|---|---|
| Block not in inventory | `missing_tool` |
| No adjacent solid block to place against | `invalid_target` |
| Target position already occupied | `invalid_target` |
| Cannot path within reach | `unreachable` |

- [ ] **Step 1: Write the integration test** in a fresh arena (pick coordinates ≥170 blocks from every existing arena — see the verified fact about search radius versus arena separation). Cover: places on the floor and the world shows it from a second connection; a floating position with no neighbour fails `invalid_target`; an empty inventory fails `missing_tool`.
- [ ] **Step 2: Run it and confirm it fails** for the right reason (the stub's `internal`).
- [ ] **Step 3: Implement** — find the block in inventory and `equip`, pick an adjacent solid neighbour as the reference, `gotoGoal` within reach, then `bot.placeBlock`.
- [ ] **Step 4: Verify against the world from a second connection**, not the placing bot's own view — its local world model updates optimistically, the same trap `bot.dig()` has.
- [ ] **Step 5: Prove each failure guard fires**, then commit.

---

## Task 5: Schematic loader

**Files:**
- Create: `packages/executor/src/schematic.ts`
- Create: `packages/executor/test/schematic.test.ts`

**Interfaces:**
- Consumes: `placeBlock` (Task 4).
- Produces: `parseSchematic(json: unknown) => Schematic`, `placementOrder(s: Schematic) => SchematicBlock[]`, types `Schematic` and `SchematicBlock { dx, dy, dz, block }`.

Scope is a saved list of block-type + relative-position pairs, per the work-split note. **Not** `.schem`/`.litematic` parsing.

- [ ] **Step 1: Write failing unit tests** — parsing rejects malformed input with a clear message; **`placementOrder` sorts ascending by `dy`** so every block has support when placed; ties within a layer are ordered deterministically.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement**, pure — no executor dependency.
- [ ] **Step 4: Run and confirm they pass**, then commit.

Bottom-up ordering is the one non-obvious constraint: any other order fails on the first block with nothing beneath it.

---

## Task 6: `attack` and `flee`, against a live mob

**Files:**
- Modify: `packages/executor/src/mineflayer-executor.ts`
- Modify: `packages/executor/test/integration/mc-console.ts` (a roofed-arena helper)
- Create: `packages/executor/test/integration/combat.int.test.ts`

Semantics to implement (Track A's call; none of it is shared surface):

- **`attack(entityId)`** — path into reach, swing once, resolve `ok`. One swing, not a fight to the death: repeated swings are the *planner's* decision, and a method that loops until something dies cannot be cancelled cleanly. `not_found` when the entity id is gone.
- **`flee()`** — move to the reachable point furthest from the nearest hostile within a bounded radius, with a timeout. `not_found` when there is nothing to flee from.

- [ ] **Step 1: Add a roofed-arena helper** to `mc-console.ts`, extending `buildArena` with a ceiling. **This is required, not cosmetic:** spec §4.1 measured an undead mob burning to death in 21 seconds on the open y=199 platform, which is shorter than one pathfinding leg.
- [ ] **Step 2: Write the integration test.** Set `difficulty easy`, summon a zombie at a known coordinate inside the roof, run the action, restore `difficulty peaceful` in `afterEach` **even on failure**. Assert the mob is still alive at the start of the test body — a test whose mob burned or despawned before it began is the vacuous fixture this repo has been bitten by twice.
- [ ] **Step 3: Run and confirm it fails** with the stub's `internal`.
- [ ] **Step 4: Implement both methods.**
- [ ] **Step 5: Verify**, confirm the server is left on `peaceful` with no leftover mobs, then commit.

---

## Task 7: Demo, docs and the pull request

**Files:**
- Create: `packages/bot/src/phase5-demo.ts`
- Modify: `package.json`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: Write the demo** — a roofed arena, a real model pursuing a goal, and a zombie summoned mid-run. It must fail unless a **preemption actually occurred**: assert `ReflexExecutor.preemptions` is non-empty, not merely that the bot survived. A run where nothing attacked proves nothing.
- [ ] **Step 2: Add `"demo:phase5"`** to `package.json`.
- [ ] **Step 3: Run it twice.** One green run is not evidence of stability.
- [ ] **Step 4: Update the docs** — README status/counts/table/roadmap; CLAUDE.md commands, counts, and the facts this phase produced (at minimum the 21-second burn measurement and whatever `attack`/`flee` turn up).
- [ ] **Step 5: Full verification.** Record actual numbers in the commit message rather than asserting "all tests pass":

```bash
npm test && npm run typecheck && node scripts/check-invariants.mjs
npm run smoke && npm run test:integration
OLLAMA_HOST=… npm run agent:probe
npm run bench:world -- verify
npm run demo:phase2 && npm run demo:phase3 && npm run demo:phase4 && npm run demo:phase5
```

- [ ] **Step 6: Commit and open the PR.** The body must state what the reflex layer actually did under a live mob, and whether `attack`/`flee` behaved as specified — that is the evidence Phase 6 needs.

---

## Self-review

**Spec coverage.** §1 four stubs → Tasks 3, 4, 6. §2 arbiter → Task 2. §2.1 placement → Tasks 1, 2 (rules in `executor`, arbiter in `bot`). §2.2 / §7 Decision 1 → **answered**, and by existing code rather than by this plan: `loop.ts:161-165` already falls through and re-plans on an `interrupted` result with no outer abort, citing §3.5 by name. The decorator needs no new signal, no new `FailureReason`, and no change to `packages/agent`. Verified, not assumed — Task 2 Step 1. §3 `attack`/`flee` semantics → Task 6, decided there. §4.1/§4.2 daylight and the roof → Task 6 Step 1, and a global constraint. §4.3 synthetic events first → Task 2 precedes Task 6. §5 `followPlayer` → Task 3, gated. §6 `placeBlock` + schematics → Tasks 4, 5. §7 Decision 3 → Task 3's gate. §9 testing → per-task, plus Task 7 Step 5. §10 risks → risk 1 in Task 6 Step 1, risk 2 in Task 2's re-entrancy test, risk 3 in Task 4 Step 4.

**Gaps deliberately left.** Task 3 has no code, because writing it before Decision 3 lands would be guessing at a shared-surface guarantee. Task 6's steps are coarser than Tasks 1–2 because the mob's behaviour is not yet measured — that measurement is Step 2's job, and pretending to know the numbers now would be the assumption this project keeps punishing.

**Ordering.** Tasks 1 → 2 must be sequential. Tasks 4 → 5 must be sequential. Task 3 is independent and gated. Task 6 depends on Task 1 only. Task 7 is last.
