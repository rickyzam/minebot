# Phase 5 (Track A) Implementation Plan — the full toolbox

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the executor's four remaining stubs — `attack`, `flee`, `followPlayer`, `placeBlock` — into working behaviour, and build the reflex arbiter the design has specified since Phase 1 but never implemented.

**Architecture:** The arbiter is a **decorator over `BotExecutor`** living in `packages/executor`. It wraps another executor, subscribes to the push event stream, and when a trigger rule fires it aborts the in-flight action, runs its own recovery, and returns `interrupted` to the caller. `packages/agent` needs no change: `loop.ts` already re-plans on an `interrupted` result with no outer abort (verified — Task 2 Step 1). Trigger rules stay pure functions over `WorldSnapshot`, testable exhaustively with no server and no model.

**Tech Stack:** TypeScript, ESM, Node 24+, Vitest, `mineflayer` + `mineflayer-pathfinder`, the live dev server for integration.

**Spec:** [docs/superpowers/specs/2026-09-09-phase-5-full-toolbox-design.md](../specs/2026-09-09-phase-5-full-toolbox-design.md)

---

## v2 — what changed, and why

Three independent reviews ran against v1. They agreed the architecture was right and the plan was not executable. v1 is in git history; this replaces it. The substantive changes:

| v1 defect | Fix in v2 |
|---|---|
| Decided new failure semantics for four **shared-surface** methods while touching neither `MockExecutor`, `runContractSuite`, nor the contract's doc comments — the exact mock/real divergence the suite exists to catch | **New Task 0**, gated on Ricky, does contract + mock + suite together *before* any executor work. This is what the Phase 4 plan did and v1 failed to copy |
| Arbiter subscribed to `damaged`/`health` only, so the `attack` trigger could never fire before the bot was hit — unreachable in production while all seven tests stayed green | Subscribes to `entityNearby` too, with a test that emits **only** `entityNearby` |
| Re-entrancy flag was a single boolean, so `flee` could never escalate over a running `attack` recovery — **the bot dies mid-attack** | Priority-aware latch: `flee` supersedes `attack`, same-or-lower is ignored |
| `stop()` listed as pass-through, so the bot resumed walking *after* the emergency brake | `stop()` overridden: suppresses the pending recovery, then delegates |
| Reflex inert whenever no action was in flight — i.e. during the multi-second model round trip that dominates the wall clock | Idle triggers run recovery immediately, serialized against caller actions |
| Latch cleared only on the happy path; `emit()` swallows exceptions, so a leak silently disables the safety layer forever | `finally`-clearing, plus a test at `actionDelayMs: 0` where the aborted action still resolves `ok` |
| Enumerated six actions; the contract has **eight abortable cases across seven actions**, leaving `exploreFor` — the longest — un-preemptible | Generic wrapper over all of them, preserving `Result<T>` |
| `ReflexPreemption` used four times, defined nowhere; Step 6 contained literal `[...]` and `{ ... }` | Both defined in full below |
| Re-entrancy rule provably failed its own test (microtask ordering) | Latch set synchronously at abort, not at recovery start |
| `missing_tool` for "not in inventory" — Track B measured `missing_tool → give_up 5/5` | `not_found`, with the rationale recorded in the contract doc comment |
| A roofed arena still lets a zombie walk off a floating platform | Fully enclosed box; liveness asserted at the assertion point, not just at the start |
| Task 5 claimed to consume `placeBlock` while Step 3 said "no executor dependency", and nothing ever built from a schematic | Contradiction removed; **Task 5b** wires it to `placeBlock` and verifies a built structure |
| `ReflexExecutor` placed in `packages/bot` on a rationale that the decorator design made false | Moved to `packages/executor` — it depends only on contract types plus `evaluateReflex`. Spec §2.1 must be corrected to match (Task 0 Step 5) |

## Global Constraints

- **`packages/contract/` and `packages/mock-executor/` are shared surface.** Track B builds against them with no server. Changing a type, a signature, or **a documented guarantee** needs agreement. Task 0 is the only task allowed to touch them, and it is gated.
- **Never weaken `runContractSuite`.** The suite has **eight abortable cases across seven actions** — `moveTo`, `followPlayer`, `mineBlock(name)`, `mineBlock(Vec3)`, `placeBlock`, `attack`, `flee`, `exploreFor` (`contract-suite.ts:267-285`). All must keep resolving `{ ok: false, reason: 'interrupted' }`, never throwing, for an already-aborted signal.
- **The `FailureReason` set is closed.** `not_found | unreachable | interrupted | invalid_target | missing_tool | inventory_full | timeout | disconnected | internal`.
- **`packages/agent/` must not depend on `mineflayer` or `@minebot/executor`**, transitively included. Do not add menu entries to `ACTION_MENU` — prompt text is Phase 5 Track B.
- **`scripts/` and `demo:*` are outside `npm test`.** Phase 4 broke `bench:world` and `demo:phase2` while the whole sweep stayed green.
- **Prove every guard can fire.**
- **`erasableSyntaxOnly: true`** (`tsconfig.base.json`). Constructor parameter properties (`constructor(private readonly inner: X)`) will not compile — declare fields explicitly.
- **Exact version pins.** Cross-package deps use `"0.1.0"`. Relative imports carry `.js`.
- **`goto()` resolves as SUCCESS on a zero-length path**, so a resolved promise is not evidence of arrival. Every method that moves the bot must verify against the world afterwards, as `gotoGoal` does.
- **`bot.dig()` and block placement update Mineflayer's local world model optimistically.** Verify from a **second connection**, never the acting bot's own view.

### Arena coordinate registry

In use today (x-ranges): `500-560`, `800-840`, `860-880`, `900-930`, `950-980`, `1000-1020`, `1100-1130`, `1200-1230`, `1300-1330`, `1395-1415`, `1500-1520`, `1600-1760`; the benchmark world occupies `2279-2407`.

Separation must exceed the largest radius anything might **search**, not the arena's own width — the Phase 3 demo found a neighbouring arena's ore 24 blocks away and chased it. The model now issues `find_blocks` at ≤32 and `exploreFor` reaches 64. This phase claims, all ≥80 blocks from any neighbour:

| Task | Arena | Floor |
|---|---|---|
| 4, 5b (`placeBlock`, schematic) | `x 1850-1870, z 0-8` | y=199 |
| 6a, 6b (combat) | `x 1950-1970, z 0-8` | y=199, **fully enclosed** |
| 7 (demo) | `x 2050-2070, z 0-8` | y=199, **fully enclosed** |

## File structure

| File | Responsibility |
|---|---|
| `packages/contract/src/index.ts` | **Modify — SHARED SURFACE, Task 0 only.** Doc comments for the four methods |
| `packages/mock-executor/src/mock-executor.ts` | **Modify — SHARED SURFACE, Task 0 only.** Teach the mock the agreed semantics |
| `packages/mock-executor/src/contract-suite.ts` | **Modify — SHARED SURFACE, Task 0 only.** Guarantees enforcing them |
| `packages/executor/src/reflex.ts` | **Create.** Pure trigger rules over `WorldSnapshot` |
| `packages/executor/test/reflex.test.ts` | **Create.** Exhaustive unit tests for the rules |
| `packages/executor/src/reflex-executor.ts` | **Create.** The arbiter — a preempting `BotExecutor` decorator |
| `packages/executor/test/reflex-executor.test.ts` | **Create.** Arbitration tests against `MockExecutor`, no server |
| `packages/executor/src/schematic.ts` | **Create.** Pure parsing and placement ordering |
| `packages/executor/test/schematic.test.ts` | **Create.** Unit tests |
| `packages/executor/src/mineflayer-executor.ts` | **Modify.** Replace four stubs; add `buildSchematic` |
| `packages/executor/src/index.ts` | **Modify.** Export the new modules |
| `packages/executor/test/integration/mc-console.ts` | **Modify.** Enclosed-arena helper (opt-in; `ArenaBounds` stays backward compatible) |
| `packages/executor/test/integration/place.int.test.ts` | **Create.** `placeBlock` + schematic build |
| `packages/executor/test/integration/combat.int.test.ts` | **Create.** Enclosed arena, live mob |
| `packages/executor/test/integration/follow.int.test.ts` | **Create.** `followPlayer` (Task 3 only) |
| `packages/bot/src/phase5-demo.ts` | **Create.** The deliverable |
| `package.json`, `README.md`, `CLAUDE.md` | **Modify.** Task 7 |

---

## Task 0: GATE — contract, mock and suite, together

**Nothing else starts until this lands.** Turning four stubs into real behaviour necessarily gives them semantics the mock does not have. `MockExecutor.flee`, `.placeBlock` and `.followPlayer` today return unconditional `ok` (`mock-executor.ts:252-255, 298-316`); only `attack` already checks `entities`. If Track A ships real failures without teaching the mock, Track B writes `switch (r.reason)` against one implementation and gets an unhandled rejection against the other — the exact hazard `contract-suite.ts:338-344` records.

**Files:**
- Modify: `packages/contract/src/index.ts`, `packages/mock-executor/src/mock-executor.ts`, `packages/mock-executor/src/contract-suite.ts`
- Modify: `docs/superpowers/specs/2026-09-09-phase-5-full-toolbox-design.md`

**Interfaces produced:** documented guarantees for `followPlayer`, `placeBlock`, `attack`, `flee`; `MockOptions.inventory` becomes load-bearing for `placeBlock`; new contract-suite guarantees.

- [ ] **Step 1: Put ONE bundled question to Ricky.** Spec §7 Decision 3 plus the mapping below — one conversation, not four.

  | Method | Proposed guarantee | Rationale to give him |
  |---|---|---|
  | `followPlayer` | Follows until aborted or until `timeoutMs` elapses; **elapsing resolves `ok`** (it followed as asked), default `timeoutMs` **30_000** | `GoalFollow` never finishes by itself. `timeout` would read as failure for a request that succeeded. The planner's step budget needs a bounded action |
  | `placeBlock` | `not_found` — block not in inventory | **Measured:** Track B's probe answers `give_up` 5/5 after `missing_tool`. "Out of dirt" must not inherit "give up" |
  | `placeBlock` | `invalid_target` — no adjacent face to place against, or target occupied | Geometry, not inventory |
  | `placeBlock` | `unreachable` — cannot path within reach | Matches `mineBlock` |
  | `attack` | One swing, then `ok`. `not_found` if the entity id is gone | A method that loops until something dies cannot be cancelled cleanly; repeated swings are the planner's decision |
  | `flee` | Moves away from the nearest hostile; `not_found` when there is no hostile to flee from | Distinguishes "fled" from "nothing to flee from" |

- [ ] **Step 2: Record his answer in spec §7** before writing code, as Phase 4 did. If he rejects any row, this table changes and Tasks 3/4/6 follow it — not the other way round.

- [ ] **Step 3: Write the contract doc comments** for the four methods, stating the agreed guarantees. These are the only record Track B reads.

- [ ] **Step 4: Teach `MockExecutor` the same semantics, and add suite guarantees.**

```ts
// mock-executor.ts — placeBlock becomes inventory-aware
async placeBlock(blockName: string, position: Vec3, opts?: ActionOptions): Promise<Result> {
  this.record('placeBlock', blockName, position)
  const r = await this.simulate('placeBlock', opts)
  if (!r.ok) return r
  // Agreed Task 0: not_found, NOT missing_tool. Track B measured that
  // missing_tool draws give_up 5/5, which is wrong for "go get more dirt".
  const held = this.inventory.find((i) => i.name === blockName)
  if (!held) return fail('not_found', `${blockName} is not in the inventory`)
  this.inventory = this.inventory
    .map((i) => (i.name === blockName ? { ...i, count: i.count - 1 } : i))
    .filter((i) => i.count > 0)
  this.blocks = [...this.blocks, { name: blockName, position, distance: 0 }]
  return ok(undefined)
}

// flee becomes hostile-aware
async flee(opts?: ActionOptions): Promise<Result> {
  this.record('flee')
  const r = await this.simulate('flee', opts)
  if (!r.ok) return r
  if (!this.entities.some((e) => e.kind === 'hostile')) {
    return fail('not_found', 'nothing to flee from')
  }
  return ok(undefined)
}
```

  Add to `runContractSuite`, in a new `describe('the Phase 5 toolbox')`: `placeBlock` with an empty inventory resolves `not_found`; `flee` with no hostile resolves `not_found`; `followPlayer` with an already-elapsed `timeoutMs` resolves (does not hang). Each needs a context declaration so it skips loudly rather than passing vacuously — follow the `prepareVisibilityFixture` pattern (`contract-suite.ts:193-205`), which reports SKIPPED rather than green.

- [ ] **Step 5: Correct spec §2.1.** It justifies `packages/bot` because the arbiter needs "the planner's `AbortController`". The decorator needs no planner. Change the placement to `packages/executor` and the rationale with it.

- [ ] **Step 6: Verify and commit**

```bash
npm test && npm run typecheck && node scripts/check-invariants.mjs && npm run test:integration
git add packages/contract packages/mock-executor docs
git commit -m "feat(contract): document the Phase 5 toolbox guarantees, and teach the mock

Agreed with Ricky on <date>. Turning four stubs into real behaviour gives them
semantics MockExecutor did not have — flee, placeBlock and followPlayer all
returned unconditional ok. Shipping the real failures without the mock is the
divergence the contract suite exists to catch.

placeBlock uses not_found rather than missing_tool for an absent block, on
evidence: Track B's probe measures missing_tool drawing give_up 5/5, which is
the wrong response to 'go get more dirt'."
```

---

## Task 1: Reflex trigger rules (pure)

**Files:**
- Create: `packages/executor/src/reflex.ts`, `packages/executor/test/reflex.test.ts`
- Modify: `packages/executor/src/index.ts`

**Interfaces:**
- Consumes: `WorldSnapshot`, `EntityInfo` from `@minebot/contract`.
- Produces: `evaluateReflex(snapshot, thresholds?) => ReflexTrigger | null`, `DEFAULT_REFLEX_THRESHOLDS`, types `ReflexThresholds`, `ReflexTrigger`. Task 2 consumes all four.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import type { EntityInfo, EntityKind, WorldSnapshot } from '@minebot/contract'
import { evaluateReflex, DEFAULT_REFLEX_THRESHOLDS } from '../src/reflex.js'

const at = (id: number, distance: number, kind: EntityKind, name = 'thing'): EntityInfo => ({
  id, name, kind, position: { x: distance, y: 64, z: 0 }, distance,
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
    const t = evaluateReflex(snap(20, [at(2, 6, 'hostile'), at(1, 3, 'hostile')]))
    expect(t).toEqual({ kind: 'attack', entityId: 1, reason: expect.any(String) })
  })

  it('flees instead of attacking at or below the health threshold', () => {
    const t = evaluateReflex(snap(DEFAULT_REFLEX_THRESHOLDS.fleeBelowHealth, [at(1, 3, 'hostile')]))
    expect(t?.kind).toBe('flee')
  })

  it('does NOT flee on low health with no hostile nearby', () => {
    // Fleeing from nothing costs an action and moves the bot away from whatever
    // it was doing. The planner is a better judge of "go eat" than a reflex is.
    expect(evaluateReflex(snap(1, []))).toBeNull()
  })

  it('ignores hostiles beyond the radius', () => {
    expect(evaluateReflex(snap(20, [at(1, DEFAULT_REFLEX_THRESHOLDS.hostileRadius + 1, 'hostile')]))).toBeNull()
  })

  it.each<EntityKind>(['passive', 'player', 'item', 'other'])(
    'ignores a %s entity standing right next to the bot', (kind) => {
      expect(evaluateReflex(snap(20, [at(1, 1, kind)]))).toBeNull()
    },
  )

  it('honours overridden thresholds', () => {
    expect(evaluateReflex(snap(20, [at(1, 12, 'hostile')]), { hostileRadius: 16 })?.kind).toBe('attack')
  })
})
```

- [ ] **Step 2: Run and confirm they fail.** `npx vitest run --project unit packages/executor/test/reflex.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement** `packages/executor/src/reflex.ts`:

```ts
/**
 * The reflex layer's decision, kept pure so every rule is testable without a
 * server, a model, or a mob. Design §3.5: reflex beats plan, always — but only
 * when there is something to react to.
 */
import type { EntityInfo, WorldSnapshot } from '@minebot/contract'

export interface ReflexThresholds {
  /** At or below this health, disengage rather than fight. */
  readonly fleeBelowHealth: number
  /** How close a hostile must be to matter, in blocks. */
  readonly hostileRadius: number
}

/**
 * 6 of 20 is three hearts — two hits from most early hostiles. The radius is a
 * little beyond a zombie's reach so the trigger can fire before contact, which
 * requires the arbiter to subscribe to `entityNearby` and not only `damaged`.
 */
export const DEFAULT_REFLEX_THRESHOLDS: ReflexThresholds = Object.freeze({
  fleeBelowHealth: 6,
  hostileRadius: 8,
})

export type ReflexTrigger =
  | { readonly kind: 'flee'; readonly reason: string }
  | { readonly kind: 'attack'; readonly entityId: number; readonly reason: string }

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
  const where = `${nearest.name} ${nearest.distance.toFixed(1)} away`

  if (snapshot.self.health <= fleeBelowHealth) {
    return { kind: 'flee', reason: `health ${snapshot.self.health} at or below ${fleeBelowHealth} with ${where}` }
  }
  return { kind: 'attack', entityId: nearest.id, reason: where }
}
```

- [ ] **Step 4: Run and confirm they pass** — 10 tests (the `it.each` counts as four).

- [ ] **Step 5: Export** from `packages/executor/src/index.ts`:

```ts
export { evaluateReflex, DEFAULT_REFLEX_THRESHOLDS } from './reflex.js'
export type { ReflexThresholds, ReflexTrigger } from './reflex.js'
```

- [ ] **Step 6: Verify and commit.** `npm test && npm run typecheck && node scripts/check-invariants.mjs`

---

## Task 2: The arbiter — a preempting `BotExecutor` decorator

**Files:**
- Create: `packages/executor/src/reflex-executor.ts`, `packages/executor/test/reflex-executor.test.ts`
- Modify: `packages/executor/src/index.ts`

**Interfaces:**
- Consumes: Task 1's four exports; `BotExecutor`, `Result`, `ActionOptions`, `ExploreOptions` from `@minebot/contract`.
- Produces: `class ReflexExecutor implements BotExecutor`, `ReflexPreemption`, `ReflexExecutorOptions`.

`packages/executor` already has `@minebot/mock-executor` as a devDependency, so no manifest change is needed.

- [x] **Step 1: The premise — VERIFIED 2026-09-09**

`packages/agent/src/loop.ts:160-168` already falls through and re-plans when an action resolves `interrupted` and no outer signal was aborted:

```ts
// The caller aborting ends the goal. An `interrupted` result *without* an
// outer abort is the reflex layer preempting: fall through, re-observe,
// and decide again from fresh state. Never retry the interrupted action
// against the snapshot it was chosen for — after a flee, that position is
// a lie (design §8, spec §3.5).
if (outer?.aborted) { … }
```

Track B built the planner half of §3.5 and left the arbiter-shaped hole. Re-read before starting; if it has changed, the design changes with it.

- [ ] **Step 2: Write the type declarations**

```ts
export interface ReflexPreemption {
  readonly trigger: ReflexTrigger
  /** `Date.now()` when the trigger fired. */
  readonly at: number
  /** The caller action preempted, or `'idle'` when nothing was in flight. */
  readonly action: string
  /** What the recovery actually returned. `null` while it is still running. */
  readonly recovery: Result | null
}

export interface ReflexExecutorOptions {
  readonly thresholds?: Partial<ReflexThresholds>
  readonly onPreempt?: (p: ReflexPreemption) => void
  /** Bounds a recovery so it cannot inherit an action's 30s default. */
  readonly recoveryTimeoutMs?: number
  /** After this many consecutive failed recoveries, stop preempting. */
  readonly maxConsecutiveFailures?: number
}
```

- [ ] **Step 3: Write the failing tests.** These must cover **more than one interleaving** — v1's seven all emitted during a `MockExecutor.wait()` that aborts synchronously, so they exercised a single path.

```ts
import { describe, it, expect, vi } from 'vitest'
import { MockExecutor } from '@minebot/mock-executor'
import type { EntityInfo } from '@minebot/contract'
import { ReflexExecutor } from '../src/reflex-executor.js'

const zombie = (distance: number): EntityInfo => ({
  id: 1, name: 'zombie', kind: 'hostile', position: { x: distance, y: 64, z: 0 }, distance,
})
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('ReflexExecutor', () => {
  it('passes actions through untouched when nothing triggers', async () => {
    const inner = new MockExecutor()
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    expect((await reflex.moveTo({ x: 5, y: 64, z: 5 })).ok).toBe(true)
    expect(reflex.preemptions).toHaveLength(0)
  })

  it('preempts on entityNearby ALONE, before any damage is taken', async () => {
    // The attack rule is about proximity, not damage. Subscribing only to
    // `damaged` would make it unreachable until after the first hit.
    const inner = new MockExecutor({ actionDelayMs: 500, entities: [zombie(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    const pending = reflex.moveTo({ x: 99, y: 64, z: 99 })
    inner.emit('entityNearby', { entity: zombie(3) })
    const r = await pending
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('interrupted')
    expect(reflex.preemptions[0]?.trigger.kind).toBe('attack')
  })

  it('names the trigger in the interrupted detail, so the model can read it', async () => {
    const inner = new MockExecutor({ actionDelayMs: 500, entities: [zombie(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    const pending = reflex.moveTo({ x: 99, y: 64, z: 99 })
    inner.emit('damaged', { health: 20, source: null })
    const r = await pending
    if (!r.ok) expect(r.detail).toMatch(/reflex/i)
  })

  it('awaits the recovery before resolving the caller', async () => {
    const inner = new MockExecutor({ actionDelayMs: 200, entities: [zombie(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    const pending = reflex.moveTo({ x: 99, y: 64, z: 99 })
    inner.emit('damaged', { health: 20, source: null })
    await pending
    expect(inner.calls.map((c) => c.name)).toContain('attack')
    expect(reflex.preemptions[0]?.recovery).not.toBeNull()
  })

  it('ESCALATES: flee supersedes an attack recovery already running', async () => {
    // The killer bug in v1. A single boolean latch swallows the damage that
    // would have triggered flee, and the bot dies mid-attack.
    const inner = new MockExecutor({ actionDelayMs: 300, entities: [zombie(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    const pending = reflex.moveTo({ x: 99, y: 64, z: 99 })
    inner.emit('damaged', { health: 20, source: null })   // -> attack recovery
    await settle()
    inner.setHealth(2)                                     // see Step 4 note
    inner.emit('damaged', { health: 2, source: null })     // -> must escalate
    await pending
    expect(inner.calls.map((c) => c.name)).toContain('flee')
  })

  it('does NOT re-preempt for the same or lower priority', async () => {
    const inner = new MockExecutor({ actionDelayMs: 300, health: 3, entities: [zombie(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    const pending = reflex.moveTo({ x: 99, y: 64, z: 99 })
    inner.emit('damaged', { health: 3, source: null })
    inner.emit('damaged', { health: 2, source: null })
    inner.emit('damaged', { health: 1, source: null })
    await pending
    expect(inner.calls.filter((c) => c.name === 'flee')).toHaveLength(1)
  })

  it('stop() cancels a pending recovery instead of letting it walk', async () => {
    // The emergency brake must win. v1 delegated stop() and the bot resumed
    // walking after the brake was pulled.
    const inner = new MockExecutor({ actionDelayMs: 300, entities: [zombie(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    const pending = reflex.moveTo({ x: 99, y: 64, z: 99 })
    inner.emit('damaged', { health: 20, source: null })
    reflex.stop()
    await pending
    expect(inner.calls.map((c) => c.name)).not.toContain('attack')
  })

  it('returns promptly when the caller aborts during recovery', async () => {
    const inner = new MockExecutor({ actionDelayMs: 300, entities: [zombie(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    const c = new AbortController()
    const pending = reflex.moveTo({ x: 99, y: 64, z: 99 }, { signal: c.signal })
    inner.emit('damaged', { health: 20, source: null })
    await settle()
    c.abort()
    const r = await pending
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('interrupted')
  })

  it('recovers its latch when the aborted action still resolves ok', async () => {
    // actionDelayMs 0: simulate() resolves before any abort listener exists,
    // so the action returns ok despite the abort. If the latch is cleared only
    // on the interrupted path it leaks, and emit() swallows the evidence.
    const inner = new MockExecutor({ actionDelayMs: 0, entities: [zombie(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    await reflex.moveTo({ x: 1, y: 64, z: 1 })
    inner.emit('damaged', { health: 20, source: null })
    await settle()
    const pending = reflex.moveTo({ x: 2, y: 64, z: 2 })
    inner.emit('damaged', { health: 20, source: null })
    await pending
    expect(reflex.preemptions.length).toBeGreaterThanOrEqual(1)
  })

  it('survives getState() throwing inside the handler', async () => {
    const inner = new MockExecutor({ entities: [zombie(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    await inner.disconnect()                 // getState() now throws
    expect(() => inner.emit('damaged', { health: 5, source: null })).not.toThrow()
    expect(reflex.preemptions).toHaveLength(0)
  })

  it('acts when idle, not only during an action', async () => {
    // The model round trip dominates the wall clock. A reflex that only works
    // during an action guards the minority of the timeline.
    const inner = new MockExecutor({ entities: [zombie(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    inner.emit('damaged', { health: 20, source: null })
    await settle()
    expect(inner.calls.map((c) => c.name)).toContain('attack')
  })

  it('does not preempt a caller-issued attack or flee', async () => {
    // Otherwise the reflex aborts the planner's attack to run its own, forever.
    const inner = new MockExecutor({ actionDelayMs: 300, entities: [zombie(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    const pending = reflex.attack(1)
    inner.emit('damaged', { health: 20, source: null })
    expect((await pending).ok).toBe(true)
    expect(reflex.preemptions).toHaveLength(0)
  })

  it('stops preempting after repeated recovery failures', async () => {
    const inner = new MockExecutor({ actionDelayMs: 0, entities: [zombie(3)], failures: { attack: { reason: 'unreachable' } } })
    const reflex = new ReflexExecutor(inner, { maxConsecutiveFailures: 2 })
    await reflex.connect()
    for (let i = 0; i < 5; i++) { inner.emit('damaged', { health: 20, source: null }); await settle() }
    expect(reflex.preemptions.length).toBeLessThanOrEqual(2)
  })

  it('forwards timeoutMs and other options to the inner action', async () => {
    const inner = new MockExecutor()
    const spy = vi.spyOn(inner, 'moveTo')
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    await reflex.moveTo({ x: 1, y: 64, z: 1 }, { timeoutMs: 1234 })
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 1234 })
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

- [ ] **Step 4: Run and confirm they fail.** Two will need a mock affordance: `setHealth`. If `MockExecutor` has no such setter, add one — it is a **test-only affordance on shared surface**, so it belongs in Task 0's agreed change, not smuggled in here. If Task 0 did not include it, go back and add it there.

- [ ] **Step 5: Implement.** The state machine, explicitly — this is what v1 got wrong by writing prose:

```ts
type Priority = 1 | 2
const priorityOf = (t: ReflexTrigger): Priority => (t.kind === 'flee' ? 2 : 1)
```

- Fields: `inFlight: Map<symbol, { controller: AbortController; name: string }>` (a Map, not a single slot — nothing in the contract says a `BotExecutor` is single-flight, and `MineflayerExecutor` guards its own singular assumption with an identity check at `mineflayer-executor.ts:772`); `recovery: { controller: AbortController; priority: Priority } | null`; `suppressed = false`; `consecutiveFailures = 0`; `preemptions: ReflexPreemption[]`.
- **Subscribe** in the constructor to `damaged`, `health` **and `entityNearby`**. Subscriptions are safe before `connect()` and survive reconnects (contract-suite `subscription lifetime`).
- **Handler**, synchronous: return if `suppressed`; take the snapshot in a `try/catch` and return on throw; `evaluateReflex`; on `null`, reset `consecutiveFailures` and return; return if `consecutiveFailures >= maxConsecutiveFailures`; compute priority and return if `recovery !== null && p <= recovery.priority`; otherwise **synchronously** create the recovery controller and store it (this is the latch — set at abort time, not at recovery start, or the three-synchronous-emit test fails on microtask ordering), abort every in-flight controller, then kick off the recovery.
- **Recovery**: run `inner.attack(id, { signal, timeoutMs: recoveryTimeoutMs })` or `inner.flee({ … })` inside `try { … } finally { this.recovery = null }`. Record the `Result` on the preemption; increment `consecutiveFailures` on `!ok`, reset on `ok`.
- **Action wrapper**, generic in `T`: check `opts?.signal?.aborted` synchronously first and return `fail('interrupted', …)` — `addEventListener` never fires for an already-aborted signal (`mock-executor.ts:428-430` records this exact bug); register the caller's abort onto both the internal and the current recovery controller with `{ once: true }` and remove it in a `finally`; pass `{ ...opts, signal: internal }` down so `timeoutMs` and `budgetMs` survive; on caller abort, return immediately rather than awaiting the recovery.
- **Which actions are wrapped**: `moveTo`, `followPlayer`, `mineBlock`, `placeBlock`, `exploreFor`. **`attack` and `flee` are NOT** — a caller-issued attack must not be preempted to run the reflex's own attack.
- **`stop()`** is overridden, not delegated: set `suppressed`, abort the recovery controller, clear it, then call `inner.stop()`. Clear `suppressed` at the start of the next wrapped action.
- **Pass-through**: `connect`, `disconnect`, `getState`, `findBlocks`, `on`, `chat`.
- `erasableSyntaxOnly` forbids parameter properties — declare `private readonly inner: BotExecutor` and assign in the body.

- [ ] **Step 6: Run and confirm they pass** — 15 tests.

- [ ] **Step 7: Run the contract suite against the decorator**

```ts
import { runContractSuite } from '@minebot/mock-executor/contract-suite'
// Copy SEEDED_BLOCK_NAMES, seededBlocks AND visibilityBlocks verbatim from
// packages/mock-executor/test/mock-executor.test.ts:12-33 — they are two
// separate arrays on purpose, because expectFindable.minCount is
// seededBlocks.length and must not count the visibility pair.
runContractSuite('ReflexExecutor over MockExecutor', async () => {
  const inner = new MockExecutor({ actionDelayMs: 20, blocks: [...seededBlocks, ...visibilityBlocks] })
  const executor = new ReflexExecutor(inner)
  await executor.connect()
  return {
    executor,
    cleanup: () => executor.disconnect(),
    expectFindable: { names: SEEDED_BLOCK_NAMES, minCount: seededBlocks.length },
    prepareVisibilityFixture: () => Promise.resolve({
      hidden: { name: 'coal_ore', position: visibilityBlocks[0]!.position },
      control: { name: 'coal_ore', position: visibilityBlocks[1]!.position },
      maxDistance: 16,
    }),
  }
})
```

  **Seed no entities here, deliberately.** A hostile would preempt every action in the suite and the run would be meaningless. This factory verifies that the decorator is a faithful `BotExecutor` — delegation, throw-when-disconnected, the eight abort cases; arbitration is covered by Step 3's dedicated tests. Confirm the run reports **zero skipped** tests: omitting the fixture thunk yields four SKIPPED, not failures (`contract-suite.ts:193-205`).

- [ ] **Step 8: Export, verify, commit.** Export `ReflexExecutor` and its types from `packages/executor/src/index.ts`. Then `npm test && npm run typecheck && node scripts/check-invariants.mjs`.

---

## Task 3: `followPlayer` — needs Task 0's answer

**Files:** Modify `packages/executor/src/mineflayer-executor.ts`; create `packages/executor/test/integration/follow.int.test.ts`.

- [ ] **Step 1: Confirm Task 0 Step 2 recorded the agreed termination rule.** If not, stop.
- [ ] **Step 2: Write the integration test** in the Task 4 arena (`x 1850-1870`), two bots: the follower and a `ITFollowTarget` teleported twice. Assert the follower closes to within 4 blocks of each new position, that an aborted call resolves `interrupted` promptly (<2s), and that an elapsed `timeoutMs` resolves per the agreed rule.
- [ ] **Step 3: Implement** with the pathfinder's `GoalFollow`, honouring that rule and clearing the goal in a `finally`.
- [ ] **Step 4: Verify and commit.**

---

## Task 4: `placeBlock`

**Files:** Modify `packages/executor/src/mineflayer-executor.ts`; create `packages/executor/test/integration/place.int.test.ts`. Arena `x 1850-1870, z 0-8`, floor y=199.

Failure mapping is Task 0's agreed table: `not_found` (not in inventory), `invalid_target` (no reference face, or occupied), `unreachable` (cannot path within reach).

- [ ] **Step 1: Write the integration test.** Cover: places a block on the arena floor and a **second connection** confirms it (the placing bot's world model updates optimistically — the same trap `bot.dig()` has); an empty inventory gives `not_found`; a position with no adjacent solid neighbour gives `invalid_target`; an already-occupied position gives `invalid_target`.
- [ ] **Step 2: Run and confirm it fails** with the stub's `internal`.
- [ ] **Step 3: Implement** — find and `equip` the block; reject early when absent; pick an adjacent solid neighbour as the reference face and reject when there is none; `gotoGoal` within reach; `bot.placeBlock(reference, faceVector)`.
- [ ] **Step 4: Verify arrival and placement against the world**, not the bot's own view.
- [ ] **Step 5: Prove each failure guard fires**, then commit.

---

## Task 5: Schematics — the loader (5a) and the builder (5b)

Task 5a is pure and has **no dependency on Task 4**; 5b does.

### Task 5a — the loader

**Files:** Create `packages/executor/src/schematic.ts`, `packages/executor/test/schematic.test.ts`; modify `packages/executor/src/index.ts`.

```ts
export interface SchematicBlock { readonly dx: number; readonly dy: number; readonly dz: number; readonly block: string }
export interface Schematic { readonly name: string; readonly blocks: readonly SchematicBlock[] }
```

Input JSON is exactly that shape. `parseSchematic(json: unknown): Schematic` **throws** with a message naming the offending entry — it is a developer-supplied file, not model output, so a `Result` would only be unwrapped and thrown anyway.

- [ ] **Step 1: Write failing tests** — rejects a missing `blocks`, a non-integer offset, an empty `block` name; `placementOrder` sorts **ascending by `dy`** so every block has support when placed; ties within a layer are ordered deterministically by `dx` then `dz`.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement**, pure.
- [ ] **Step 4: Run, export, commit.**

### Task 5b — the builder

**Files:** Modify `packages/executor/src/mineflayer-executor.ts`; extend `place.int.test.ts`.

Without this the loader is dead code and the blueprint deliverable does not exist — the bottom-up ordering constraint is never exercised against a real world.

- [ ] **Step 1: Write the integration test** — build a 2×2×2 cube from a schematic at a known origin in the Task 4 arena; verify all eight blocks from a second connection; assert a partial failure reports which block failed.
- [ ] **Step 2: Run and confirm it fails.**
- [ ] **Step 3: Implement `buildSchematic(s: Schematic, origin: Vec3, opts?: ActionOptions): Promise<Result<{ placed: number }>>`** — iterate `placementOrder`, call `placeBlock` per block, stop on the first failure and report it. Check `opts?.signal?.aborted` between blocks so a long build is cancellable.
- [ ] **Step 4: Verify and commit.** `buildSchematic` is executor-only and **not** on `BotExecutor` — adding it to the contract would be a shared-surface change and it is not needed by Track B yet.

---

## Task 6a: `attack`

**Files:** Modify `packages/executor/src/mineflayer-executor.ts` and `mc-console.ts`; create `packages/executor/test/integration/combat.int.test.ts`. Arena `x 1950-1970, z 0-8`, floor y=199.

- [ ] **Step 1: Add an enclosed-arena helper** to `mc-console.ts` — floor, four walls, **and** ceiling. Both are required: an undead mob burns to death in **21 seconds** under open sky (spec §4.1), and a mob pathing at the bot walks off a *floating* platform and dies on impact. Make it opt-in (`enclosed?: boolean` on `ArenaBounds`) so the ~10 existing files that use `buildArena` are unaffected.
- [ ] **Step 2: Write the integration test.** In `beforeEach`: build the enclosed arena, `difficulty easy`, summon `zombie` with `{PersistenceRequired:1b}` at a known coordinate. In `afterEach`, **in a `finally`**: `kill @e[type=zombie,…]` and `difficulty peaceful`. Assert first that `getState().nearbyEntities` reports the zombie with `kind: 'hostile'` — the whole reflex chain depends on `classifyEntity` (`snapshot.ts:59-64`) keying on `'Hostile'`, which is plausible but unmeasured. Then assert the mob is **still alive at the assertion point**, not only at the start.
- [ ] **Step 3: Run and confirm it fails** with the stub's `internal`.
- [ ] **Step 4: Implement** — resolve the entity by id and return `not_found` when it is gone; path into reach with `GoalFollow` (the target moves, which is the case spec §3 asks about); `bot.attack(entity)` once; resolve `ok`. Timeout 10_000, not the stub's 30_000 — a reflex recovery that can run for 30s is not a reflex.
- [ ] **Step 5: Verify** the mob took damage (health from a second connection), confirm the server is left on `peaceful` with no leftover mobs, and commit.

## Task 6b: `flee`

- [ ] **Step 1: Write the integration test** in the same arena — with a hostile present, `flee()` resolves `ok` and the bot ends **further from the mob than it started**; with no hostile, it resolves `not_found`.
- [ ] **Step 2: Run and confirm it fails.**
- [ ] **Step 3: Implement.** Candidate generation, explicitly: take the snapshot's nearest hostile; generate 8 candidate points on a circle of radius 12 around the bot; discard any whose distance to that hostile is not greater than the bot's current distance; sort by descending distance from the hostile; `gotoGoal` to each in turn until one succeeds. `not_found` when there is no hostile; `unreachable` when every candidate fails. Timeout 10_000.
- [ ] **Step 4: Verify arrival against the world** — `goto()` resolves ok on a zero-length path, so a resolved promise is not evidence the bot moved. Compare start and end positions.
- [ ] **Step 5: Prove `unreachable` fires** by walling the bot into a 1×1 space with a hostile adjacent, then commit.

---

## Task 7: Demo, docs and the pull request

**Files:** Create `packages/bot/src/phase5-demo.ts`; modify `package.json`, `README.md`, `CLAUDE.md`. Arena `x 2050-2070, z 0-8`, enclosed.

- [ ] **Step 1: Decide where the demo's console helper comes from.** `mc-console.ts` lives in `packages/executor/test/integration/` and `@minebot/executor`'s exports map is `"." only`, so `packages/bot/src` **cannot import it**. Either promote the two commands the demo needs into the demo file (as `phase3-demo.ts` already does with its own local `mc`), or export a console helper properly. Do not discover this at runtime.
- [ ] **Step 2: Write the demo** — enclosed arena, a real model pursuing a mining goal, a zombie summoned mid-run, the executor wrapped in `ReflexExecutor`. It must fail unless **a preemption actually occurred and its recovery ran**: assert `preemptions.length > 0` **and** that `preemptions[0].recovery?.ok === true`. `preemptions` being non-empty proves only that a trigger fired.
- [ ] **Step 3: Restore the world in a `finally`** — `difficulty peaceful`, kill the mob — even when the demo fails. The dev server is shared and someone may be logged in.
- [ ] **Step 4: Add `"demo:phase5"`** and run it **twice**.
- [ ] **Step 5: Update the docs.** README status/counts/table/roadmap; CLAUDE.md commands, counts, and this phase's facts — at minimum the 21-second burn, the enclosure requirement, and whatever `attack`/`flee` measure. If Task 3 did not land, say so explicitly rather than implying all four stubs shipped.
- [ ] **Step 6: Full verification.** Record actual numbers in the commit message:

```bash
npm test && npm run typecheck && node scripts/check-invariants.mjs
npm run smoke && npm run test:integration
OLLAMA_HOST=… npm run agent:probe
npm run bench:world -- verify && npm run bench:explore -- 1 && npm run bench:perception -- 1
npm run demo && npm run demo:phase2 && npm run demo:phase3 && npm run demo:phase4 && npm run demo:phase5
```

  Every `bench:*` and `demo:*` is outside `npm test`. Phase 4 broke two of them while the sweep stayed green; this list is the correction.

- [ ] **Step 7: Commit and open the PR**, stating what the reflex layer did under a live mob and whether `attack`/`flee` behaved as specified.

---

## Self-review

**Spec coverage.** §1 stubs → Tasks 3, 4, 6a, 6b. §2 arbiter → Task 2. §2.1 placement → **corrected** by Task 0 Step 5 (the decorator needs no planner, so it belongs in `executor`). §2.2 / §7 Decision 1 → answered by existing code; Task 2 Step 1 quotes `loop.ts:160-168`. §3 `attack`/`flee` semantics → Task 0's table, implemented in 6a/6b, including the moving-target question (`GoalFollow`). §4.1/§4.2 daylight → Task 6a Step 1, now **enclosure** rather than a roof. §4.3 synthetic first → Task 2 precedes Task 6. §5 `followPlayer` → Task 3, gated on Task 0. §6 `placeBlock` + schematics → Tasks 4, 5a, 5b. §7 Decision 3 → folded into Task 0's single bundled ask. §9 testing → per task, plus Task 7 Step 6. §10 risks → risk 1 in Task 6a Step 1, risk 2 across Task 2's 15 tests, risk 3 in Tasks 4/6b's arrival verification.

**Deliberate gaps.** Task 3 still carries no implementation code: it depends on an answer that does not exist yet, and inventing one would be guessing at a shared-surface guarantee. Tasks 4, 5b and 6 give algorithms and failure mappings but not full method bodies — the mob's real behaviour is unmeasured, and Phase 4 repeatedly showed that numbers invented before measurement are wrong.

**Ordering.** Task 0 → everything. Task 1 → Task 2. Task 4 → Task 5b. Task 5a is independent. Task 6a → Task 6b (shared arena helper). Task 7 last.
