# Phase 2 (Track A) Implementation Plan — Pathfinding and Mining

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The bot paths around obstacles to a known coal-ore coordinate, equips a tool that can actually harvest it, mines it, and collects the drop — reported through `Result` with `collected: true`.

**Architecture:** Four contract changes land first (design spec §9), as one agreed unit across `contract`, `mock-executor` and the contract suite. Then `mineflayer-pathfinder` replaces Phase 1's raw movement in `moveTo`, a shared `runAction()` helper takes over the cancellation bookkeeping, a pure `harvest.ts` decides tool harvestability, and `mineBlock` is built on top as a four-step cancellable sequence: resolve → equip → dig → collect.

**Tech Stack:** TypeScript 7, Node 24 (ESM), npm workspaces, Vitest 5, Mineflayer 4.39.0, mineflayer-pathfinder 2.4.5, tsx.

**Spec:** [`docs/superpowers/specs/2026-09-07-phase-2-pathfinding-and-mining-design.md`](../specs/2026-09-07-phase-2-pathfinding-and-mining-design.md)

## STATUS — read before starting

**The GATE and Tasks 1-4 are DONE** (merged in PR #3). Track B's agreement was
confirmed and all four design-spec §9 contract changes shipped. Do not re-run
them; **start at Task 5.**

Their checkboxes below are left unticked because the file was committed as an
un-executed plan and never ticked in place — the git history is the record, not
the boxes.

**The environment changed after this plan was written.** Three things happened
between Task 4 and Task 5, none of which this plan anticipated:

1. **The dev server now runs content mods** (`nitwitmap`, `fabrictailor`). A
   Fabric server with such a mod rejects a plain Mineflayer client; the executor
   completes Fabric's registry-sync handshake automatically. Nothing to do —
   just know that `fabric.int.test.ts` failing means that handshake broke.
2. **A Velocity proxy now fronts the server.** Humans connect to the proxy on
   25565 with Mojang auth; the backend moved to `127.0.0.1:25566` and bots reach
   it directly with signed forwarding. `MineflayerExecutor`'s **default port is
   now 25566**, so tests and scripts need no change — but any hard-coded 25565
   is wrong.
3. **Test baselines moved.** Before starting Task 5 the tree is at **168 unit
   tests** and **61 integration tests**. Task 6 asks you to record counts before
   and after a refactor; those are the numbers to expect, not the ones written
   when this plan was drafted.

See [`CLAUDE.md`](../../../CLAUDE.md) for the current topology and the
environment facts both changes produced.

## Global Constraints

- Node `>=24`. All packages are ESM (`"type": "module"`). `verbatimModuleSyntax` is on — use `import type` for type-only imports.
- Relative imports carry the `.js` extension (`./harvest.js`), per NodeNext resolution.
- Exact version pins in every manifest. No `^` or `~`. Cross-package deps use the exact string `"0.1.0"`.
- `packages/contract` MUST keep **zero runtime dependencies**.
- `packages/agent` MUST NOT depend on `mineflayer` or `mineflayer-pathfinder`. `scripts/check-invariants.mjs` enforces this; run it before every commit that touches a manifest.
- **Contract rule:** on abort, an action MUST resolve `{ ok: false, reason: 'interrupted' }`. It MUST NOT throw and MUST NOT resolve `ok: true`.
- **Never weaken `runContractSuite` to make an implementation pass.** If the real executor fails an assertion, fix the executor.
- Unit tests never touch the network. Integration tests live under `packages/*/test/integration/` and are the only tests requiring a running server.
- Dev server: Fabric 1.21.10 backend on `127.0.0.1:25566` (tmux session `mc`), behind a Velocity proxy on `0.0.0.0:25565` (tmux session `velocity`). Bots connect to the **backend**, which is the executor's default port. Do not stop or restart either without asking. Drive the backend console with `tmux send-keys -t mc '<command>' Enter`.
- Integration tests connect with a distinct username each and MUST disconnect in `afterEach`, or they leak a bot onto the server.

## Verified environment facts

Measured against the live dev server on 2026-09-07 while designing this phase. These are measurements, not assumptions — see spec §2 for the full table.

- `mineflayer-pathfinder@2.4.5` works on 1.21.10 / protocol 773. A ~30-block `GoalNear` path around a wall took **6.1s** with `canDig: false`.
- **`goals` is not an ESM named export.** `Object.keys()` on the module namespace yields `Movements`, `pathfinder`, `default`, `module.exports` — no `goals`. You MUST use the default import and destructure: `import pathfinderPkg from 'mineflayer-pathfinder'`, then `const { pathfinder, Movements, goals } = pathfinderPkg`.
- `goto()` rejects with an `Error` whose **`.name`** is the discriminator: `'NoPath'`, `'Timeout'`, `'PathStopped'`, or `'GoalChanged'`. This is read from `node_modules/mineflayer-pathfinder/lib/goto.js` — it is the mapping `unreachable`-vs-`interrupted` depends on.
- `bot.pathfinder.stop()` rejects the in-flight `goto` with `.name === 'PathStopped'`; `isMoving()` reads `false` ~770ms later.
- **`bot.canDigBlock()` returns `true` bare-handed, holding a shovel, and holding a pickaxe.** It means "breakable", not "harvestable". Do NOT use it for `missing_tool`.
- **`bot.pathfinder.bestHarvestTool(coalOre)` returned `iron_shovel`** when that was the only inventory item. Do NOT delegate the harvest decision to it.
- `block.harvestTools` is a map of item-type ids (`{913: true, 918: true, …}` for coal ore) and is the reliable signal. A block with `harvestTools === undefined` is harvestable by anything.
- Coal ore `digTime`: **15000ms** bare-handed, **15000ms** with an iron shovel (both drop nothing), **2300ms** wooden pickaxe, **1150ms** stone pickaxe.
- **A mined drop 1.72 blocks away was still uncollected 3 seconds later.** Mining does not collect.
- A stale coal drop left by an earlier run was silently collected by a later one, turning a no-drop case green. Arena reset must despawn loose items.

## File structure

| File | Responsibility |
|---|---|
| `packages/contract/src/index.ts` | **Modify.** `mineBlock` target widens to `string \| Vec3`; document the `on()` reconnect and `connect()` reentrancy guarantees |
| `packages/mock-executor/src/mock-executor.ts` | **Modify.** Failure injection; `mineBlock` Vec3 targeting; emitter survives disconnect; `connect()` reentrancy |
| `packages/mock-executor/src/contract-suite.ts` | **Modify.** New shared guarantees only. Never weakened |
| `packages/executor/src/harvest.ts` | **Create.** Pure harvestability logic. No network, no `mineflayer` import |
| `packages/executor/src/mineflayer-executor.ts` | **Modify.** Long-lived emitter, `connect()` guard, `runAction()`, pathfinder `moveTo`, `mineBlock` |
| `packages/executor/test/integration/mc-console.ts` | **Modify.** Despawn loose items in the arena reset; `giveItem` helper |
| `packages/executor/src/phase2-demo.ts` | **Create.** The Phase 2 deliverable script |

---

## GATE: Track B agreement (do this before Task 1)

`packages/contract/` and `packages/mock-executor/` are the shared integration surface. Spec §4 and [CLAUDE.md](../../../CLAUDE.md) both say they change **only by mutual agreement** with Track B. Tasks 1–4 change them.

- [ ] **Confirm Ricky has agreed to all four design-spec §9 changes** before committing Task 1.

Send him spec §9 plus §3 of the Phase 2 design. If agreement is not yet in hand, **stop and report** rather than proceeding — Tasks 5–12 depend on Tasks 1–4, so there is no useful work to skip ahead to. Do not soften this into "I'll assume yes."

---

## Task 1: `mineBlock` accepts a position

Design spec §3.2. `findBlocks` yields positions, but `mineBlock` re-searches by name and may mine a different block than the planner chose.

**Files:**
- Modify: `packages/contract/src/index.ts`
- Modify: `packages/mock-executor/src/mock-executor.ts`
- Modify: `packages/mock-executor/src/contract-suite.ts`
- Test: `packages/mock-executor/test/mock-executor.test.ts`

**Interfaces:**
- Consumes: existing `@minebot/contract` surface.
- Produces: `mineBlock(target: string | Vec3, maxDistance: number, opts?: ActionOptions): Promise<Result<{ position: Vec3; collected: boolean }>>` on `BotExecutor`. Tasks 2, 10 and 11 depend on this signature.

- [ ] **Step 1: Write the failing tests**

Append to `packages/mock-executor/test/mock-executor.test.ts` inside the existing `describe('MockExecutor specifics', …)`:

```ts
  it('mines the exact block a Vec3 target names, not the nearest match', async () => {
    const m = new MockExecutor({
      blocks: [
        { name: 'coal_ore', position: { x: 2, y: 60, z: 0 }, distance: 2 },
        { name: 'coal_ore', position: { x: 9, y: 60, z: 0 }, distance: 9 },
      ],
    })
    await m.connect()
    const r = await m.mineBlock({ x: 9, y: 60, z: 0 }, 32)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.position).toEqual({ x: 9, y: 60, z: 0 })
    // The nearer block must still be standing — a name-based re-search would
    // have taken it instead.
    expect(m.findBlocks({ names: ['coal_ore'], maxDistance: 32, limit: 5 })).toHaveLength(1)
  })

  it('fails not_found for a Vec3 target with no block at it', async () => {
    const m = new MockExecutor({
      blocks: [{ name: 'coal_ore', position: { x: 2, y: 60, z: 0 }, distance: 2 }],
    })
    await m.connect()
    const r = await m.mineBlock({ x: 40, y: 60, z: 0 }, 32)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_found')
  })

  it('fails not_found for a Vec3 target beyond maxDistance', async () => {
    const m = new MockExecutor({
      blocks: [{ name: 'coal_ore', position: { x: 9, y: 60, z: 0 }, distance: 9 }],
    })
    await m.connect()
    const r = await m.mineBlock({ x: 9, y: 60, z: 0 }, 4)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_found')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `mineBlock` rejects a `Vec3` argument at the type level and mines by name at runtime.

- [ ] **Step 3: Widen the contract signature**

In `packages/contract/src/index.ts`, replace the `mineBlock` declaration inside `interface BotExecutor`:

```ts
  /**
   * Mine a block and try to collect its drop.
   *
   * `target` is either a block name (mine the nearest match within
   * `maxDistance`) or an exact position (mine *that* block — the block
   * `findBlocks` returned and the planner reasoned about). Accepting a
   * position is what makes the search-choose-approach-mine loop expressible;
   * a name-only signature re-searches and may pick a different block.
   *
   * `maxDistance` bounds the search for a name target, and bounds how far the
   * bot will travel for a position target. A position further away than
   * `maxDistance` fails `not_found` rather than walking across the world.
   *
   * Resolves `ok` with `collected: false` when the block was mined but its
   * drop could not be retrieved — mining succeeded, and that fact must not be
   * lost by reporting a failure.
   */
  mineBlock(
    target: string | Vec3,
    maxDistance: number,
    opts?: ActionOptions,
  ): Promise<Result<{ position: Vec3; collected: boolean }>>
```

- [ ] **Step 4: Update the mock**

In `packages/mock-executor/src/mock-executor.ts`, replace the `mineBlock` method:

```ts
  async mineBlock(
    target: string | Vec3,
    maxDistance: number,
    opts?: ActionOptions,
  ): Promise<Result<{ position: Vec3; collected: boolean }>> {
    this.record('mineBlock', target, maxDistance)
    const r = await this.simulate(opts)
    if (!r.ok) return r

    const match =
      typeof target === 'string'
        ? this.blocks.find((b) => b.name === target && b.distance <= maxDistance)
        : this.blocks.find(
            (b) =>
              b.position.x === target.x &&
              b.position.y === target.y &&
              b.position.z === target.z &&
              b.distance <= maxDistance,
          )

    if (!match) {
      const what = typeof target === 'string' ? target : `block at ${describeVec(target)}`
      return fail('not_found', `no ${what} within ${maxDistance} blocks`)
    }

    this.blocks = this.blocks.filter((b) => b !== match)
    this.inventory = [
      ...this.inventory,
      { name: match.name, count: 1, slot: this.inventory.length },
    ]
    return ok({ position: match.position, collected: true })
  }
```

Add this module-level helper above the class (it is reused by Task 2):

```ts
const describeVec = (v: Vec3): string => `(${v.x}, ${v.y}, ${v.z})`
```

- [ ] **Step 5: Add the shared guarantee to the contract suite**

In `packages/mock-executor/src/contract-suite.ts`, update the `mineBlock` entry of `abortableActions` so the pre-abort rule still covers a string target:

```ts
      { name: 'mineBlock', run: (e, opts) => e.mineBlock('stone', 16, opts) },
```

(unchanged — confirm it still compiles against the widened signature), and add a new entry directly after it so the position form is covered too:

```ts
      {
        name: 'mineBlock(Vec3)',
        run: (e, opts) => e.mineBlock({ x: 0, y: 64, z: 0 }, 16, opts),
      },
```

- [ ] **Step 6: Run tests, typecheck and invariants**

```bash
npm test
npm run typecheck
node scripts/check-invariants.mjs
```

Expected: PASS. The three new mock tests pass, and the contract suite now runs its pre-abort and disconnected cases for `mineBlock(Vec3)` as well.

- [ ] **Step 7: Commit**

```bash
git add packages/contract packages/mock-executor
git commit -m "feat(contract): let mineBlock target an exact position

Design spec §9.2. findBlocks yields positions, but mineBlock re-searched
by name and could mine a different block than the planner chose, making
the search-choose-approach-mine loop inexpressible.

Agreed with Track B before landing, per spec §4."
```

---

## Task 2: `MockExecutor` failure injection

Design spec §3.3. The mock emits only 3 of 9 `FailureReason` values, so Track B cannot test the retry policy that design spec §3.2 exists to enable.

**Files:**
- Modify: `packages/mock-executor/src/mock-executor.ts`
- Modify: `packages/mock-executor/src/index.ts`
- Test: `packages/mock-executor/test/mock-executor.test.ts`

**Interfaces:**
- Consumes: `mineBlock(string | Vec3, …)` from Task 1.
- Produces:
  - `type MockActionName = 'moveTo' | 'followPlayer' | 'mineBlock' | 'placeBlock' | 'attack' | 'flee'`
  - `interface InjectedFailure { reason: FailureReason; detail?: string }`
  - `MockOptions.failures?: Partial<Record<MockActionName, InjectedFailure>>`
  - `MockExecutor.setFailure(action: MockActionName, failure: InjectedFailure | null): void`

- [ ] **Step 1: Write the failing tests**

Append to `packages/mock-executor/test/mock-executor.test.ts`:

```ts
import type { FailureReason } from '@minebot/contract'

describe('MockExecutor failure injection', () => {
  const ALL_REASONS: FailureReason[] = [
    'not_found', 'unreachable', 'interrupted', 'invalid_target', 'missing_tool',
    'inventory_full', 'timeout', 'disconnected', 'internal',
  ]

  it.each(ALL_REASONS)('can produce %s from moveTo', async (reason) => {
    const m = new MockExecutor({ failures: { moveTo: { reason } } })
    await m.connect()
    const r = await m.moveTo({ x: 1, y: 64, z: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe(reason)
  })

  it('carries the injected detail string', async () => {
    const m = new MockExecutor({ failures: { mineBlock: { reason: 'missing_tool', detail: 'need a pickaxe' } } })
    await m.connect()
    const r = await m.mineBlock('coal_ore', 16)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toBe('need a pickaxe')
  })

  it('injects per action, leaving others working', async () => {
    const m = new MockExecutor({ failures: { flee: { reason: 'internal' } } })
    await m.connect()
    expect((await m.moveTo({ x: 1, y: 64, z: 1 })).ok).toBe(true)
    expect((await m.flee()).ok).toBe(false)
  })

  it('setFailure drives a fail-then-succeed retry sequence on one instance', async () => {
    const m = new MockExecutor()
    await m.connect()
    m.setFailure('moveTo', { reason: 'unreachable' })
    expect((await m.moveTo({ x: 5, y: 64, z: 5 })).ok).toBe(false)
    m.setFailure('moveTo', null)
    expect((await m.moveTo({ x: 5, y: 64, z: 5 })).ok).toBe(true)
    expect(m.getState().self.position).toEqual({ x: 5, y: 64, z: 5 })
  })

  it('does not let injection override the abort rule', async () => {
    // The contract's resolve-interrupted-on-abort rule outranks injection;
    // otherwise a test could use injection to fake a contract violation.
    const m = new MockExecutor({ failures: { moveTo: { reason: 'internal' } } })
    await m.connect()
    const r = await m.moveTo({ x: 1, y: 64, z: 1 }, { signal: AbortSignal.abort() })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('interrupted')
  })

  it('does not let injection mask being disconnected', async () => {
    const m = new MockExecutor({ failures: { moveTo: { reason: 'internal' } } })
    const r = await m.moveTo({ x: 1, y: 64, z: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('disconnected')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `MockOptions.failures` and `setFailure` do not exist.

- [ ] **Step 3: Implement injection**

In `packages/mock-executor/src/mock-executor.ts`, add `FailureReason` to the type imports from `@minebot/contract`, then add above the class:

```ts
export type MockActionName =
  | 'moveTo'
  | 'followPlayer'
  | 'mineBlock'
  | 'placeBlock'
  | 'attack'
  | 'flee'

export interface InjectedFailure {
  reason: FailureReason
  detail?: string
}
```

Add to `MockOptions`:

```ts
  /**
   * Force an action to fail with a chosen reason. Exists because the mock can
   * otherwise only produce 3 of 9 FailureReason values, leaving Track B unable
   * to test the retry policy the contract's closed reason set exists for.
   */
  failures?: Partial<Record<MockActionName, InjectedFailure>>
```

Add the field and the setter to the class:

```ts
  private readonly failures = new Map<MockActionName, InjectedFailure>()
```

In the constructor, after the existing assignments:

```ts
    for (const [action, failure] of Object.entries(opts.failures ?? {})) {
      if (failure) this.failures.set(action as MockActionName, failure)
    }
```

And a public setter:

```ts
  /**
   * Change (or clear, with `null`) an injected failure on a live mock, so a
   * fail-then-succeed retry sequence can be driven without building a second
   * executor.
   */
  setFailure(action: MockActionName, failure: InjectedFailure | null): void {
    if (failure) this.failures.set(action, failure)
    else this.failures.delete(action)
  }
```

- [ ] **Step 4: Apply injection at the one choke point**

Change `simulate` to take the action name and consult the map. Ordering is load-bearing: the abort rule and the disconnected check both outrank injection.

```ts
  private simulate(action: MockActionName, opts?: ActionOptions): Promise<Result> {
    // Contract rule first: an already-aborted signal resolves `interrupted`
    // whatever is injected. Injection must not be able to fake a violation.
    if (opts?.signal?.aborted) return Promise.resolve(fail('interrupted', 'aborted before start'))
    if (!this.connected) return Promise.resolve(fail('disconnected', 'not connected'))
    const injected = this.failures.get(action)
    if (injected) return Promise.resolve(fail(injected.reason, injected.detail ?? `injected ${injected.reason}`))
    if (this.delayMs === 0) return Promise.resolve(ok(undefined))
    return new Promise<Result>((resolve) => {
      let settled = false
      const signal = opts?.signal
      const finish = (result: Result): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (this.inFlightStop === stopThisAction) this.inFlightStop = null
        resolve(result)
      }
      const onAbort = (): void => finish(fail('interrupted', 'aborted mid-action'))
      const stopThisAction = (): void => finish(fail('interrupted', 'stopped via stop()'))
      this.inFlightStop = stopThisAction
      const timer = setTimeout(() => finish(ok(undefined)), this.delayMs)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
```

Update all six call sites to pass their action name: `this.simulate('moveTo', opts)`, `this.simulate('followPlayer', opts)`, `this.simulate('mineBlock', opts)`, `this.simulate('placeBlock', opts)`, `this.simulate('attack', opts)`, `this.simulate('flee', opts)`.

- [ ] **Step 5: Export the new types**

`packages/mock-executor/src/index.ts`:

```ts
export { MockExecutor } from './mock-executor.js'
export type {
  MockOptions,
  RecordedCall,
  MockActionName,
  InjectedFailure,
} from './mock-executor.js'
```

- [ ] **Step 6: Run tests and typecheck**

```bash
npm test
npm run typecheck
```

Expected: PASS, including all nine `FailureReason` values produced from `moveTo`.

- [ ] **Step 7: Commit**

```bash
git add packages/mock-executor
git commit -m "feat(mock-executor): inject arbitrary failure reasons

Design spec §9.3. The mock could produce only interrupted, not_found and
disconnected, so Track B — which builds entirely against it — could not
exercise the five reasons Phase 4's retry policy branches on.

Injection is checked after the abort and disconnected rules, never
before, so it cannot be used to fake a contract violation."
```

---

## Task 3: `on()` survives reconnect and works before connect

Design spec §3.1. Handlers currently bind to the `Bot` live at subscribe time, so after a drop the subscription attaches to a dead emitter and silently never fires again.

**Files:**
- Modify: `packages/contract/src/index.ts` (doc comment only)
- Modify: `packages/mock-executor/src/mock-executor.ts`
- Modify: `packages/executor/src/mineflayer-executor.ts`
- Modify: `packages/mock-executor/src/contract-suite.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: the behavioural guarantee that a subscription taken before `connect()`, or held across a disconnect/reconnect cycle, still receives events. No signature change.

- [ ] **Step 1: Write the failing contract-suite tests**

In `packages/mock-executor/src/contract-suite.ts`, replace the `it('registers safely (never throws) from on() after disconnect()', …)` test's surrounding `describe` with an additional sibling `describe` placed just before the closing of the outer `describe`:

```ts
    // Design spec §9.1: the reflex layer subscribes once at startup and expects
    // to keep hearing about damage for the session's lifetime. Handlers bound
    // to a single Bot instance silently stopped firing after any reconnect.
    describe('subscription lifetime', () => {
      it('delivers events to a handler registered before connect()', async () => {
        // A fresh, not-yet-connected executor of the same kind as ctx's.
        const fresh = await createExecutor()
        try {
          await fresh.executor.disconnect()
          let seen = 0
          const off = fresh.executor.on('spawned', () => {
            seen += 1
          })
          const r = await fresh.executor.connect()
          expect(r.ok).toBe(true)
          expect(seen).toBeGreaterThan(0)
          off()
        } finally {
          await fresh.cleanup?.()
        }
      })

      it('keeps a subscription alive across a disconnect/reconnect cycle', async () => {
        let seen = 0
        const off = ctx.executor.on('spawned', () => {
          seen += 1
        })
        await ctx.executor.disconnect()
        const before = seen
        const r = await ctx.executor.connect()
        expect(r.ok).toBe(true)
        expect(seen).toBeGreaterThan(before)
        off()
      })

      it('stops delivering after unsubscribe, even across a reconnect', async () => {
        let seen = 0
        const off = ctx.executor.on('spawned', () => {
          seen += 1
        })
        off()
        const atUnsubscribe = seen
        await ctx.executor.disconnect()
        await ctx.executor.connect()
        expect(seen).toBe(atUnsubscribe)
      })
    })
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test
```

Expected: FAIL — the mock drops handlers when disconnected (`on()` returns an inert no-op), so `seen` stays 0.

- [ ] **Step 3: Make the mock's emitter outlive the connection**

In `packages/mock-executor/src/mock-executor.ts`, replace the `on` method — the handler map is already an instance field, so it already outlives a connection; the only change is to stop refusing to register while disconnected:

```ts
  on<K extends keyof BotEvents>(
    event: K,
    handler: (payload: BotEvents[K]) => void,
  ): Unsubscribe {
    // Design spec §9.1: the executor owns a long-lived handler registry, so a
    // subscription taken before connect() — or held across a reconnect — keeps
    // working. Registering while disconnected is legal and is NOT a no-op.
    const set = this.handlers.get(event) ?? new Set<Handler>()
    set.add(handler as Handler)
    this.handlers.set(event, set)
    return () => {
      set.delete(handler as Handler)
    }
  }
```

And make `connect()` emit `spawned`, so there is an observable event for the suite to key on:

```ts
  async connect(): Promise<Result> {
    this.record('connect')
    if (this.connected) return ok(undefined)
    this.connected = true
    this.emit('spawned', {})
    return ok(undefined)
  }
```

- [ ] **Step 4: Give the real executor a long-lived emitter**

In `packages/executor/src/mineflayer-executor.ts`, add these fields to the class:

```ts
  /**
   * Design spec §9.1. Handlers live on the executor, not on any single Bot, so
   * a subscription taken before connect() — or held across a reconnect — keeps
   * firing. Previously handlers bound to the Bot live at subscribe time, so
   * after a drop they attached to a dead emitter and silently went quiet, which
   * is exactly the failure the reflex layer could not survive.
   */
  private readonly handlers = new Map<keyof BotEvents, Set<(payload: never) => void>>()
  /** Detach functions for the Mineflayer listeners feeding the emitter. */
  private botWiring: Array<() => void> = []
```

Add the emit helper and the wiring:

```ts
  private emit<K extends keyof BotEvents>(event: K, payload: BotEvents[K]): void {
    for (const h of this.handlers.get(event) ?? []) {
      ;(h as (p: BotEvents[K]) => void)(payload)
    }
  }

  /** Wire one Bot's events into the long-lived emitter. Idempotent per bot. */
  private wireBotEvents(bot: Bot): void {
    const add = <A extends unknown[]>(
      mineflayerEvent: string,
      handler: (...args: A) => void,
    ): void => {
      bot.on(mineflayerEvent as never, handler as never)
      this.botWiring.push(() => void bot.removeListener(mineflayerEvent as never, handler as never))
    }

    add('spawn', () => this.emit('spawned', {}))
    add('health', () => this.emit('health', { health: bot.health, food: bot.food }))
    add('entityHurt', (entity: { id: number }) => {
      if (entity.id !== bot.entity?.id) return
      this.emit('damaged', { health: bot.health, source: null })
    })
    add('entitySpawn', (e: { id: number; position: { x: number; y: number; z: number } }) => {
      const origin = bot.entity?.position
      if (!origin) return
      this.emit('entityNearby', {
        entity: {
          id: e.id,
          name: (e as { username?: string }).username ?? (e as { name?: string }).name ?? 'unknown',
          kind: classifyEntity(e as never),
          position: { x: e.position.x, y: e.position.y, z: e.position.z },
          distance: Math.hypot(
            e.position.x - origin.x,
            e.position.y - origin.y,
            e.position.z - origin.z,
          ),
        },
      })
    })
    add('chat', (username: string, message: string) => this.emit('chat', { username, message }))
    add('death', () => this.emit('death', {}))
    add('end', (reason: string) => this.emit('disconnected', { reason }))
  }

  private unwireBotEvents(): void {
    for (const detach of this.botWiring) detach()
    this.botWiring = []
  }
```

Replace the whole existing `on()` method body with registration against the emitter:

```ts
  on<K extends keyof BotEvents>(
    event: K,
    handler: (payload: BotEvents[K]) => void,
  ): Unsubscribe {
    const set = this.handlers.get(event) ?? new Set<(payload: never) => void>()
    set.add(handler as (payload: never) => void)
    this.handlers.set(event, set)
    return () => {
      set.delete(handler as (payload: never) => void)
    }
  }
```

In `connect()`, inside `onSpawn`, call `this.wireBotEvents(bot)` immediately after `this.bot = bot`. Because wiring happens on `spawn`, wire *then* emit the first `spawned` yourself so a pre-connect subscriber sees it:

```ts
      const onSpawn = (): void => {
        this.bot = bot
        this.wireBotEvents(bot)
        this.watchForUnexpectedDisconnect(bot)
        // The 'spawn' listener added by wireBotEvents was attached during this
        // very 'spawn' dispatch, so it does not see the event that is firing
        // now. Emit it explicitly, or a handler registered before connect()
        // misses the spawn it was waiting for.
        this.emit('spawned', {})
        ...
```

In `disconnect()`, call `this.unwireBotEvents()` right after `this.bot = null`. In `watchForUnexpectedDisconnect`, call it too, inside the identity check:

```ts
  private watchForUnexpectedDisconnect(bot: Bot): void {
    bot.once('end', () => {
      if (this.bot === bot) {
        this.bot = null
        this.unwireBotEvents()
      }
    })
  }
```

- [ ] **Step 5: Document the guarantee in the contract**

In `packages/contract/src/index.ts`, above `on` in `interface BotExecutor`:

```ts
  /**
   * Subscribe to the push event stream. Safe to call before `connect()`, and
   * the subscription survives disconnect/reconnect cycles — the executor owns
   * the emitter, not any single underlying connection. The reflex layer
   * subscribes once at startup and must keep hearing about damage for the
   * whole session.
   */
```

- [ ] **Step 6: Run unit tests, then integration**

```bash
npm test
npm run typecheck
npm run smoke && npm run test:integration
```

Expected: PASS in both. If integration fails, run `npm run smoke` first to separate "my code is broken" from "the server is unreachable."

- [ ] **Step 7: Commit**

```bash
git add packages/contract packages/mock-executor packages/executor
git commit -m "feat: keep on() subscriptions alive across reconnects

Design spec §9.1. Handlers bound to the Bot instance live at subscribe
time, so after a drop connect() built a new bot and the old subscription
sat on a dead emitter, silently never firing again. on() also threw
before connect(). Both break the reflex layer, which subscribes once at
startup for the session's lifetime.

The executor now owns a long-lived emitter; connect() wires a bot into
it and disconnect() unwires. The first 'spawned' is emitted explicitly
because wiring happens during the spawn dispatch itself."
```

---

## Task 4: `connect()` is reentrant

Design spec §3.4. `this.bot` is set only on `spawn`, so a second `connect()` before the first resolves builds a second bot — which on an offline-mode server duplicate-logins and kicks the first.

**Files:**
- Modify: `packages/executor/src/mineflayer-executor.ts`
- Modify: `packages/mock-executor/src/mock-executor.ts`
- Modify: `packages/mock-executor/src/contract-suite.ts`

**Interfaces:**
- Consumes: the emitter from Task 3.
- Produces: the guarantee that concurrent `connect()` calls share one connection attempt, and `disconnect()` during a pending connect tears it down. No signature change.

- [ ] **Step 1: Write the failing contract-suite tests**

Add inside the `describe('subscription lifetime', …)`'s parent, as a new sibling `describe`:

```ts
    // Design spec §9.4: this.bot was set only on spawn, so a second connect()
    // before the first resolved built a *second* bot — which on an offline-mode
    // server duplicate-logins and kicks the first. Pairs with disconnect()
    // during an in-flight connect() being a silent no-op.
    describe('connect() reentrancy', () => {
      it('shares one connection attempt between concurrent connect() calls', async () => {
        await ctx.executor.disconnect()
        const [a, b] = await Promise.all([ctx.executor.connect(), ctx.executor.connect()])
        expect(a.ok).toBe(true)
        expect(b.ok).toBe(true)
        // Still usable afterwards — a duplicate login would have kicked one off.
        expect(() => ctx.executor.getState()).not.toThrow()
      })

      it('is idempotent when already connected', async () => {
        const r = await ctx.executor.connect()
        expect(r.ok).toBe(true)
        expect(() => ctx.executor.getState()).not.toThrow()
      })

      it('leaves the executor disconnected when disconnect() races a pending connect()', async () => {
        await ctx.executor.disconnect()
        const connecting = ctx.executor.connect()
        await ctx.executor.disconnect()
        await connecting
        expect(() => ctx.executor.getState()).toThrow()
      })
    })
```

- [ ] **Step 2: Run to verify they fail**

```bash
npm test
```

Expected: FAIL — the mock's `connect()` has no pending-promise guard, and the last test finds the executor connected.

- [ ] **Step 3: Guard the mock**

In `packages/mock-executor/src/mock-executor.ts`, add a field:

```ts
  private pendingConnect: Promise<Result> | null = null
  private disconnectRequested = false
```

Replace `connect()` and `disconnect()`:

```ts
  async connect(): Promise<Result> {
    this.record('connect')
    if (this.connected) return ok(undefined)
    if (this.pendingConnect) return this.pendingConnect

    this.disconnectRequested = false
    this.pendingConnect = (async (): Promise<Result> => {
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs))
      if (this.disconnectRequested) return fail('interrupted', 'disconnect() during connect()')
      this.connected = true
      this.emit('spawned', {})
      return ok(undefined)
    })()

    try {
      return await this.pendingConnect
    } finally {
      this.pendingConnect = null
    }
  }

  async disconnect(): Promise<void> {
    this.record('disconnect')
    this.disconnectRequested = true
    const pending = this.pendingConnect
    if (pending) await pending.catch(() => undefined)
    this.connected = false
  }
```

- [ ] **Step 4: Guard the real executor**

In `packages/executor/src/mineflayer-executor.ts`, add fields:

```ts
  /**
   * Design spec §9.4. Without this, a second connect() before the first
   * resolves creates a second Bot; on an offline-mode server that is a
   * duplicate login, and the server kicks the first one.
   */
  private pendingConnect: Promise<Result> | null = null
  private disconnectRequested = false
```

Wrap the existing body. Rename the current `connect()` to `private openConnection()` (its body is unchanged apart from the `onSpawn` edit from Task 3), and add:

```ts
  async connect(): Promise<Result> {
    if (this.bot) return ok(undefined)
    if (this.pendingConnect) return this.pendingConnect

    this.disconnectRequested = false
    this.pendingConnect = this.openConnection()
    try {
      const result = await this.pendingConnect
      if (result.ok && this.disconnectRequested) {
        // disconnect() was called while this was in flight — honour it rather
        // than handing back a connection the caller has already abandoned.
        await this.teardown()
        return fail('interrupted', 'disconnect() during connect()')
      }
      return result
    } finally {
      this.pendingConnect = null
    }
  }
```

Split the existing `disconnect()` into a reusable teardown plus the guard:

```ts
  async disconnect(): Promise<void> {
    this.disconnectRequested = true
    const pending = this.pendingConnect
    if (pending) await pending.catch(() => undefined)
    await this.teardown()
  }

  private async teardown(): Promise<void> {
    const bot = this.bot
    if (!bot) return
    this.bot = null
    this.unwireBotEvents()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000)
      bot.once('end', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        bot.quit()
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
  }
```

- [ ] **Step 5: Run unit tests, then integration**

```bash
npm test
npm run typecheck
npm run smoke && npm run test:integration
```

Expected: PASS. The reentrancy test is the one that matters against the live server — a duplicate login would kick a bot and fail the follow-up `getState()`.

- [ ] **Step 6: Commit**

```bash
git add packages/mock-executor packages/executor
git commit -m "fix: make connect() reentrant and disconnect() cancel it

Design spec §9.4. this.bot was set only on spawn, so a second connect()
before the first resolved created a second Bot. On an offline-mode
server that is a duplicate login and the server kicks the first bot.
disconnect() during a pending connect() was a silent no-op.

Both are fixed together with a pending-promise guard, before any
supervisor or reconnect logic is written on top of them."
```

---

## Task 5: Add mineflayer-pathfinder and prove it loads

The dependency is three years stale. This task proves it works here before anything is built on it.

**Files:**
- Modify: `packages/executor/package.json`
- Test: `packages/executor/test/integration/pathfinder.int.test.ts`

**Interfaces:**
- Consumes: `MineflayerExecutor` from Task 4.
- Produces: the `mineflayer-pathfinder` dependency at exactly `2.4.5`, available to Tasks 7 and 10.

- [ ] **Step 1: Add the dependency**

In `packages/executor/package.json`, add to `dependencies` (keep the existing two, exact pin, no caret):

```json
    "mineflayer-pathfinder": "2.4.5"
```

Then:

```bash
npm install
```

- [ ] **Step 2: Write the failing integration test**

`packages/executor/test/integration/pathfinder.int.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import pathfinderPkg from 'mineflayer-pathfinder'
import { MineflayerExecutor } from '../../src/index.js'

// VERIFIED 2026-09-07: `goals` is NOT an ESM named export of this CJS package.
// Node's named-export detection yields only Movements, pathfinder, default and
// 'module.exports'. Destructuring the default import is the only form that works.
const { pathfinder, Movements, goals } = pathfinderPkg

describe('mineflayer-pathfinder on this server', () => {
  let executor: MineflayerExecutor | null = null

  afterEach(async () => {
    await executor?.disconnect()
    executor = null
  })

  it('exposes the pieces we depend on via the default import', () => {
    expect(typeof pathfinder).toBe('function')
    expect(typeof Movements).toBe('function')
    expect(typeof goals.GoalNear).toBe('function')
    expect(typeof goals.GoalLookAtBlock).toBe('function')
  })

  it('loads as a plugin and builds Movements for this protocol version', async () => {
    // The real risk with a dependency last published in 2023: minecraft-data
    // lookups for a 2025 protocol version. This is where that would blow up.
    executor = new MineflayerExecutor({ username: 'ITPathLoad' })
    const r = await executor.connect()
    expect(r.ok).toBe(true)
    expect(executor.hasPathfinder()).toBe(true)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

```bash
npm run smoke && npm run test:integration -- pathfinder
```

Expected: FAIL — `hasPathfinder` does not exist.

- [ ] **Step 4: Load the plugin on connect**

In `packages/executor/src/mineflayer-executor.ts`, add the import at the top:

```ts
import pathfinderPkg from 'mineflayer-pathfinder'

// VERIFIED 2026-09-07: `goals` is not an ESM named export of this CJS package
// — only `Movements`, `pathfinder` and `default` are detected. Destructuring
// the default import is the only form that resolves all three.
const { pathfinder, Movements, goals } = pathfinderPkg
```

In `openConnection()`'s `onSpawn`, immediately after `this.wireBotEvents(bot)`:

```ts
        // Movement is non-destructive by design: canDig false means the
        // pathfinder never tunnels. The only blocks this executor breaks are
        // the ones mineBlock was explicitly asked to break — a pathfinder
        // allowed to dig would quietly rewrite the terrain the integration
        // tests depend on.
        bot.loadPlugin(pathfinder)
        const movements = new Movements(bot)
        movements.canDig = false
        bot.pathfinder.setMovements(movements)
```

Add the test accessor:

```ts
  /** Integration-test accessor: is the pathfinder plugin live on this bot? */
  hasPathfinder(): boolean {
    return typeof this.bot?.pathfinder?.goto === 'function'
  }
```

- [ ] **Step 5: Run it to verify it passes**

```bash
npm run test:integration -- pathfinder
npm run typecheck
node scripts/check-invariants.mjs
```

Expected: PASS. `check-invariants.mjs` must still confirm no `mineflayer*` dependency reaches `contract` or `agent`.

- [ ] **Step 6: Commit**

```bash
git add packages/executor package-lock.json
git commit -m "feat(executor): load mineflayer-pathfinder with canDig disabled

Pinned at 2.4.5, last published 2023-09-04. Verified working on
1.21.10/protocol 773 before building on it — the real risk with a
dependency this stale is minecraft-data lookups for a 2025 version.

canDig is false so movement stays non-destructive: the only blocks this
executor breaks are ones mineBlock was explicitly asked to break.

Note for future readers: 'goals' is not an ESM named export of this CJS
package. Only the default import resolves it."
```

---

## Task 6: Extract `runAction()`

`moveTo` carries ~40 lines of abort-listener, timeout-timer, `inFlightStop` and cleanup. `mineBlock`'s four steps would repeat it, and each repetition is a chance to get the resolve-never-throw rule wrong.

This refactors code the contract suite covers. This repository has already reverted one such refactor (`requireBot()`) after it introduced contract violations, so the suite must be green before and after, and this lands as its own commit with **no behaviour change**.

**Files:**
- Modify: `packages/executor/src/mineflayer-executor.ts`

**Interfaces:**
- Consumes: the `inFlightStop` field already on the class.
- Produces:
  ```ts
  private runAction<T>(
    opts: ActionOptions | undefined,
    defaultTimeoutMs: number,
    body: (bot: Bot, signal: AbortSignal) => Promise<Result<T>>,
  ): Promise<Result<T>>
  ```
  Tasks 7, 10 and 11 build every action on it.

- [ ] **Step 1: Confirm the suite is green before touching anything**

```bash
npm test && npm run smoke && npm run test:integration
```

Expected: PASS. Record the test counts. If anything is red, stop — a refactor onto a red baseline cannot be verified.

- [ ] **Step 2: Add `runAction()` alongside the existing code**

Add to `packages/executor/src/mineflayer-executor.ts`:

```ts
  /**
   * The single owner of cancellation bookkeeping for every action.
   *
   * Guarantees, in this order:
   *  - an already-aborted signal resolves `interrupted` before any work;
   *  - no bot resolves `disconnected`;
   *  - the caller's signal, `stop()`, and the timeout all abort `signal`,
   *    which `body` is responsible for reacting to;
   *  - whatever `body` returns, an aborted run is reported as `interrupted`
   *    (caller abort or stop()) or `timeout`, never as success.
   *
   * It never throws: a body that rejects becomes `internal`, per the contract's
   * resolve-don't-throw rule.
   */
  private async runAction<T>(
    opts: ActionOptions | undefined,
    defaultTimeoutMs: number,
    body: (bot: Bot, signal: AbortSignal) => Promise<Result<T>>,
  ): Promise<Result<T>> {
    if (opts?.signal?.aborted) return fail('interrupted', 'aborted before start')
    const bot = this.bot
    if (!bot) return fail('disconnected', 'not connected')

    const controller = new AbortController()
    let cause: 'abort' | 'stop' | 'timeout' | null = null

    const onCallerAbort = (): void => {
      cause ??= 'abort'
      controller.abort()
    }
    const stopThisAction = (): void => {
      cause ??= 'stop'
      controller.abort()
    }
    const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs
    const timer = setTimeout(() => {
      cause ??= 'timeout'
      controller.abort()
    }, timeoutMs)

    opts?.signal?.addEventListener('abort', onCallerAbort, { once: true })
    this.inFlightStop = stopThisAction

    try {
      const result = await body(bot, controller.signal)
      if (controller.signal.aborted) {
        if (cause === 'timeout') return fail('timeout', `did not finish within ${timeoutMs}ms`)
        return fail('interrupted', cause === 'stop' ? 'stopped via stop()' : 'aborted mid-action')
      }
      return result
    } catch (e) {
      if (controller.signal.aborted) {
        if (cause === 'timeout') return fail('timeout', `did not finish within ${timeoutMs}ms`)
        return fail('interrupted', cause === 'stop' ? 'stopped via stop()' : 'aborted mid-action')
      }
      return fail('internal', e instanceof Error ? e.message : String(e))
    } finally {
      clearTimeout(timer)
      opts?.signal?.removeEventListener('abort', onCallerAbort)
      if (this.inFlightStop === stopThisAction) this.inFlightStop = null
    }
  }
```

- [ ] **Step 3: Move `moveTo` onto it, keeping raw movement for now**

Replace `moveTo`'s body — behaviour identical, bookkeeping delegated. The physics-tick walk is unchanged; only the cancellation scaffolding moves out. It is replaced wholesale in Task 7.

```ts
  async moveTo(target: Vec3, opts?: ActionOptions): Promise<Result> {
    return this.runAction(opts, 30_000, async (bot, signal) => {
      const tolerance = 1.5
      return new Promise<Result>((resolve) => {
        const cleanup = (): void => {
          bot.removeListener('physicsTick', onTick)
          signal.removeEventListener('abort', onAbort)
          try {
            bot.clearControlStates()
          } catch {
            // disconnected mid-move
          }
        }
        const finish = (result: Result): void => {
          cleanup()
          resolve(result)
        }
        // runAction maps an aborted run to interrupted/timeout; this just
        // unblocks the promise so it can do so.
        const onAbort = (): void => finish(ok(undefined))
        const onTick = (): void => {
          const p = bot.entity.position
          const dx = target.x - p.x
          const dz = target.z - p.z
          if (Math.hypot(dx, dz) <= tolerance) {
            finish(ok(undefined))
            return
          }
          void bot.look(Math.atan2(-dx, -dz), 0, true)
          bot.setControlState('forward', true)
          const entityWithCollisionFlags = bot.entity as unknown as {
            isCollidedHorizontally?: boolean
          }
          bot.setControlState('jump', entityWithCollisionFlags.isCollidedHorizontally === true)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        bot.on('physicsTick', onTick)
      })
    })
  }
```

- [ ] **Step 4: Move the five stubs onto it**

Each stub keeps its documented behaviour — abort check first, then disconnected, then the phase message — but gets both checks from `runAction`:

```ts
  async followPlayer(_playerName: string, opts?: ActionOptions): Promise<Result> {
    return this.runAction(opts, 30_000, async () => fail('internal', 'followPlayer arrives in Phase 5'))
  }

  async placeBlock(_blockName: string, _position: Vec3, opts?: ActionOptions): Promise<Result> {
    return this.runAction(opts, 30_000, async () => fail('internal', 'placeBlock arrives in Phase 5'))
  }

  async attack(_entityId: number, opts?: ActionOptions): Promise<Result> {
    return this.runAction(opts, 30_000, async () => fail('internal', 'attack arrives in Phase 5'))
  }

  async flee(opts?: ActionOptions): Promise<Result> {
    return this.runAction(opts, 30_000, async () => fail('internal', 'flee arrives in Phase 5'))
  }
```

Leave `mineBlock` as its existing stub for now; Task 10 replaces it.

- [ ] **Step 5: Run the full suite and confirm nothing moved**

```bash
npm test
npm run typecheck
npm run smoke && npm run test:integration
```

Expected: PASS, with the **same test counts as Step 1**. This is a pure refactor — a changed count means behaviour moved and something is wrong.

- [ ] **Step 6: Commit**

```bash
git add packages/executor
git commit -m "refactor(executor): centralise action cancellation in runAction()

Pure refactor, no behaviour change: same tests, same counts, contract
suite green against both implementations before and after.

moveTo carried ~40 lines of abort-listener, timeout-timer, inFlightStop
and cleanup that mineBlock's four cancellable steps would each repeat,
and every repetition is a chance to get the contract's
resolve-never-throw rule subtly wrong.

Kept as its own commit deliberately — the last refactor of this class
(requireBot()) had to be reverted for contract violations, so this one
is isolated from the behaviour it exists to serve."
```

---

## Task 7: `moveTo` on the pathfinder

**Files:**
- Modify: `packages/executor/src/mineflayer-executor.ts`
- Test: `packages/executor/test/integration/pathfinder.int.test.ts`

**Interfaces:**
- Consumes: `runAction()` (Task 6), the loaded pathfinder (Task 5).
- Produces:
  - `private gotoGoal(bot: Bot, signal: AbortSignal, goal: unknown): Promise<Result>` — shared by `moveTo` and Task 10's approach step.
  - `moveTo` mapping `NoPath` → `unreachable`.

- [ ] **Step 1: Write the failing integration tests**

Append to `packages/executor/test/integration/pathfinder.int.test.ts`. Import the arena helpers at the top of the file:

```ts
import { buildArena, teleportAndWait, waitForOnGround, type ArenaBounds } from './mc-console.js'
```

```ts
// A private arena, deliberately away from move.int.test.ts's (x 500-560) so
// the two files cannot disturb each other. Floating at y=199 so it is
// independent of biome and world generation.
const ARENA: ArenaBounds = { x0: 800, x1: 840, z0: 0, z1: 8, floorY: 199, clearance: 6 }
const START = { x: 805, y: ARENA.floorY + 1, z: 4 }

describe('moveTo via the pathfinder', () => {
  let executor: MineflayerExecutor | null = null

  afterEach(async () => {
    await executor?.disconnect()
    executor = null
  })

  async function arenaBot(username: string): Promise<MineflayerExecutor> {
    const e = new MineflayerExecutor({ username })
    const r = await e.connect()
    expect(r.ok).toBe(true)
    await buildArena(ARENA)
    await teleportAndWait(e, username, START)
    await waitForOnGround(e, { expectedY: ARENA.floorY + 1 })
    return e
  }

  it('routes around a wall instead of wedging against it', async () => {
    executor = await arenaBot('ITPathWall')
    // A wall across the runway with a single gap. Phase 1's raw movement
    // walked into obstacles and jumped; only a real path finds the gap.
    sendConsoleCommand(`fill 820 ${ARENA.floorY + 1} ${ARENA.z0} 820 ${ARENA.floorY + 3} ${ARENA.z1} stone`)
    sendConsoleCommand(`fill 820 ${ARENA.floorY + 1} 1 820 ${ARENA.floorY + 3} 1 air`)
    await new Promise((r) => setTimeout(r, 800))

    const target = { x: 835, y: ARENA.floorY + 1, z: 4 }
    const r = await executor.moveTo(target, { timeoutMs: 45_000 })
    expect(r.ok).toBe(true)

    const p = executor.getState().self.position
    expect(Math.hypot(p.x - target.x, p.z - target.z)).toBeLessThan(2)
  })

  it('reports unreachable — not timeout — for a target sealed behind stone', async () => {
    executor = await arenaBot('ITPathNoPath')
    // Fully enclose a target block so no path exists. The distinction matters:
    // 'unreachable' tells the planner to pick a different target, 'timeout'
    // tells it to try again. Getting this wrong makes retry policy loop.
    sendConsoleCommand(`fill 830 ${ARENA.floorY + 1} 3 832 ${ARENA.floorY + 4} 5 stone`)
    await new Promise((r) => setTimeout(r, 800))

    const r = await executor.moveTo(
      { x: 831, y: ARENA.floorY + 2, z: 4 },
      { timeoutMs: 30_000 },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('unreachable')
  })

  it('resolves interrupted and actually halts when aborted mid-path', async () => {
    executor = await arenaBot('ITPathAbort')
    const controller = new AbortController()
    const pending = executor.moveTo(
      { x: 838, y: ARENA.floorY + 1, z: 4 },
      { signal: controller.signal, timeoutMs: 45_000 },
    )
    await new Promise((r) => setTimeout(r, 1_200))
    controller.abort()

    const r = await pending
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('interrupted')

    // Not just labelled interrupted — actually stopped. Sample twice.
    const a = executor.getState().self.position
    await new Promise((r) => setTimeout(r, 1_000))
    const b = executor.getState().self.position
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThan(1)
  })
})
```

Also add `sendConsoleCommand` to the `mc-console.js` import at the top of the file.

- [ ] **Step 2: Run to verify they fail**

```bash
npm run smoke && npm run test:integration -- pathfinder
```

Expected: FAIL — raw movement wedges on the wall, and the sealed target reports `timeout`, not `unreachable`.

- [ ] **Step 3: Implement `gotoGoal` and rewrite `moveTo`**

In `packages/executor/src/mineflayer-executor.ts`:

```ts
  /**
   * Run a pathfinder goal under an AbortSignal, mapping the plugin's outcomes
   * onto the contract's failure reasons.
   *
   * VERIFIED 2026-09-07 by reading node_modules/mineflayer-pathfinder/lib/goto.js:
   * goto() rejects with an Error whose `.name` is one of 'NoPath', 'Timeout',
   * 'PathStopped' or 'GoalChanged'. That name is the only reliable
   * discriminator, and the NoPath/PathStopped split is what separates
   * 'unreachable' (pick a different target) from 'interrupted' (re-plan from
   * current state) for Track B's retry policy.
   */
  private async gotoGoal(bot: Bot, signal: AbortSignal, goal: never): Promise<Result> {
    const onAbort = (): void => {
      try {
        bot.pathfinder.stop()
        bot.pathfinder.setGoal(null)
      } catch {
        // disconnected mid-path
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await bot.pathfinder.goto(goal)
      return ok(undefined)
    } catch (e) {
      const name = e instanceof Error ? e.name : ''
      // An aborted run is relabelled by runAction, so returning ok here is
      // safe and keeps the mapping in one place.
      if (signal.aborted) return ok(undefined)
      if (name === 'NoPath') return fail('unreachable', 'no path to the target')
      if (name === 'Timeout') return fail('timeout', 'pathfinder could not compute a path in time')
      if (name === 'PathStopped' || name === 'GoalChanged') {
        return fail('interrupted', 'path stopped before completion')
      }
      return fail('internal', e instanceof Error ? e.message : String(e))
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  async moveTo(target: Vec3, opts?: ActionOptions): Promise<Result> {
    return this.runAction(opts, 60_000, async (bot, signal) =>
      this.gotoGoal(bot, signal, new goals.GoalNear(target.x, target.y, target.z, 1) as never),
    )
  }
```

The default timeout rises from 30s to 60s: a measured 30-block path around a wall took 6.1s, and Phase 4 will ask for much longer routes.

- [ ] **Step 4: Delete the raw movement**

Remove the `physicsTick`-based walk entirely — no fallback. Two movement paths would make `unreachable` mean two different things. `stop()` gains the pathfinder halt:

```ts
  stop(): void {
    const cancel = this.inFlightStop
    this.inFlightStop = null
    cancel?.()
    try {
      this.bot?.pathfinder?.stop()
      this.bot?.pathfinder?.setGoal(null)
    } catch {
      // pathfinder not loaded, or disconnected
    }
    try {
      this.bot?.clearControlStates()
    } catch {
      // safe to call when disconnected
    }
  }
```

- [ ] **Step 5: Run everything**

```bash
npm test
npm run typecheck
npm run smoke && npm run test:integration
```

Expected: PASS, **including the pre-existing `move.int.test.ts` unchanged**. Those tests are the regression net for this swap. If one fails on arrival tolerance alone, adjust `GoalNear`'s range — never the assertion. Weakening an arrival test to fit a new movement implementation discards the only evidence the replacement still arrives.

- [ ] **Step 6: Commit**

```bash
git add packages/executor
git commit -m "feat(executor): move on the pathfinder, mapping NoPath to unreachable

Phase 1's raw walk-and-jump was an explicit stopgap; it wedged against
anything it could not climb. Removed outright rather than kept as a
fallback — two movement paths would make 'unreachable' ambiguous.

goto() rejects with an Error whose .name is NoPath/Timeout/PathStopped/
GoalChanged (read from the plugin's lib/goto.js). That split is what
separates unreachable — pick a different target — from interrupted —
re-plan from current state.

Default timeout 30s -> 60s: a measured 30-block path around a wall took
6.1s, and Phase 4 will ask for far longer routes.

move.int.test.ts passes unchanged; it is the regression net for the swap."
```

---

## Task 8: `harvest.ts` — pure harvestability logic

The probe results make this the piece with real logic in it, so it lives where it can be tested instantly, following `snapshot.ts`'s precedent.

**Files:**
- Create: `packages/executor/src/harvest.ts`
- Modify: `packages/executor/src/index.ts`
- Test: `packages/executor/test/harvest.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface HarvestableBlock { name: string; harvestTools?: Record<string, boolean> }`
  - `interface ToolItem { name: string; type: number; slot: number }`
  - `function canHarvest(block: HarvestableBlock, tool: ToolItem | null): boolean`
  - `function bestHarvestTool(block: HarvestableBlock, items: readonly ToolItem[]): ToolItem | null`
  - Task 10 consumes both.

- [ ] **Step 1: Write the failing tests**

`packages/executor/test/harvest.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { canHarvest, bestHarvestTool, type HarvestableBlock, type ToolItem } from '../src/harvest.js'

// VERIFIED 2026-09-07 against the live dev server: coal_ore reports
// harvestTools as a map of item-type ids. These ids are from that measurement.
const COAL_ORE: HarvestableBlock = {
  name: 'coal_ore',
  harvestTools: { 913: true, 918: true, 923: true, 928: true, 933: true, 938: true, 943: true },
}
// Blocks like dirt have no harvestTools at all — anything harvests them.
const DIRT: HarvestableBlock = { name: 'dirt' }

const woodenPick: ToolItem = { name: 'wooden_pickaxe', type: 913, slot: 0 }
const stonePick: ToolItem = { name: 'stone_pickaxe', type: 918, slot: 1 }
const ironShovel: ToolItem = { name: 'iron_shovel', type: 800, slot: 2 }

describe('canHarvest', () => {
  it('rejects bare hands for a block that requires a tool', () => {
    expect(canHarvest(COAL_ORE, null)).toBe(false)
  })

  it('rejects a tool that is not in the block harvest list', () => {
    // Measured: holding an iron shovel, coal ore still breaks in 15s and drops
    // nothing. Holding *a* tool is not holding *the* tool.
    expect(canHarvest(COAL_ORE, ironShovel)).toBe(false)
  })

  it('accepts a tool that is in the harvest list', () => {
    expect(canHarvest(COAL_ORE, woodenPick)).toBe(true)
  })

  it('accepts bare hands for a block with no harvestTools', () => {
    expect(canHarvest(DIRT, null)).toBe(true)
  })

  it('accepts any tool for a block with no harvestTools', () => {
    expect(canHarvest(DIRT, ironShovel)).toBe(true)
  })

  it('treats an empty harvestTools map as harvestable by nothing', () => {
    expect(canHarvest({ name: 'bedrock', harvestTools: {} }, stonePick)).toBe(false)
  })
})

describe('bestHarvestTool', () => {
  it('returns null when nothing in inventory can harvest the block', () => {
    expect(bestHarvestTool(COAL_ORE, [ironShovel])).toBeNull()
  })

  it('returns null for an empty inventory', () => {
    expect(bestHarvestTool(COAL_ORE, [])).toBeNull()
  })

  it('picks the valid tool and ignores the invalid one', () => {
    expect(bestHarvestTool(COAL_ORE, [ironShovel, stonePick])?.name).toBe('stone_pickaxe')
  })

  it('prefers the later-tier tool when several are valid', () => {
    // Measured digTime for coal ore: wooden 2300ms, stone 1150ms. Preferring
    // the better tool halves the dig, which matters under a timeout.
    expect(bestHarvestTool(COAL_ORE, [woodenPick, stonePick])?.name).toBe('stone_pickaxe')
  })

  it('returns null for a block needing no tool, since bare hands suffice', () => {
    expect(bestHarvestTool(DIRT, [ironShovel])).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
npm test
```

Expected: FAIL — `../src/harvest.js` does not exist.

- [ ] **Step 3: Write the module**

`packages/executor/src/harvest.ts`:

```ts
/**
 * Harvestability decisions, kept pure so they can be tested exhaustively
 * without a server. This is the guard behind `missing_tool`.
 *
 * Why this exists rather than using Mineflayer's own helpers — both VERIFIED
 * against the live dev server on 2026-09-07:
 *
 *  - `bot.canDigBlock()` returned `true` bare-handed, holding an iron shovel,
 *    and holding a pickaxe. It answers "is this breakable at all", not "will
 *    this drop anything", so it is the wrong signal entirely.
 *  - `bot.pathfinder.bestHarvestTool()` returned `iron_shovel` as the best
 *    tool for coal ore when that was the only inventory item.
 *
 * Getting this wrong is expensive, not merely incorrect: bare-handed or
 * wrong-tooled, coal ore takes 15 seconds to break and drops nothing. The
 * block is destroyed and the resource is gone.
 */

/** Structural subset of prismarine-block's Block that this module reads. */
export interface HarvestableBlock {
  name: string
  /**
   * Map of item-type ids that can harvest this block, e.g.
   * `{913: true, 918: true, …}` for coal ore. `undefined` means the block has
   * no tool requirement and anything harvests it — that is the common case.
   */
  harvestTools?: Record<string, boolean>
}

/** Structural subset of prismarine-item's Item. */
export interface ToolItem {
  name: string
  type: number
  slot: number
}

/**
 * Would mining `block` while holding `tool` actually yield its drop?
 * `null` means bare hands.
 */
export function canHarvest(block: HarvestableBlock, tool: ToolItem | null): boolean {
  const required = block.harvestTools
  if (required === undefined) return true
  if (tool === null) return false
  return required[String(tool.type)] === true
}

/**
 * The best inventory item for harvesting `block`, or `null` if none qualifies
 * — which is also what a block needing no tool returns, since bare hands
 * already suffice there and equipping something would be pointless work.
 *
 * "Best" is the highest item type id among valid tools. Minecraft's item
 * registry is ordered by material tier within a tool family (wooden, stone,
 * iron, diamond, netherite), so the highest valid id is the best tier
 * available. Measured: stone pickaxe digs coal ore in 1150ms against the
 * wooden pickaxe's 2300ms, so this halves the dig under a timeout.
 */
export function bestHarvestTool(
  block: HarvestableBlock,
  items: readonly ToolItem[],
): ToolItem | null {
  if (block.harvestTools === undefined) return null
  let best: ToolItem | null = null
  for (const item of items) {
    if (!canHarvest(block, item)) continue
    if (best === null || item.type > best.type) best = item
  }
  return best
}
```

- [ ] **Step 4: Export it**

`packages/executor/src/index.ts`, append:

```ts
export { canHarvest, bestHarvestTool } from './harvest.js'
export type { HarvestableBlock, ToolItem } from './harvest.js'
```

- [ ] **Step 5: Run tests and typecheck**

```bash
npm test
npm run typecheck
```

Expected: PASS — 13 new tests.

- [ ] **Step 6: Commit**

```bash
git add packages/executor
git commit -m "feat(executor): add pure harvestability logic for missing_tool

Mineflayer's own helpers are both wrong for this, verified against the
live server: canDigBlock() returns true bare-handed, with a shovel, and
with a pickaxe — it means 'breakable', not 'harvestable'. And
pathfinder.bestHarvestTool() returned iron_shovel as the best tool for
coal ore when that was the only inventory item.

block.harvestTools, a map of item-type ids, is the reliable signal.

This matters because the failure is expensive rather than merely wrong:
bare-handed or wrong-tooled, coal ore takes 15 seconds to break and
drops nothing, destroying the resource."
```

---

## Task 9: Arena fixture despawns loose items

A stale coal drop from an earlier probe run was silently collected by a later run, turning a no-drop case green. This is the third fixture in this repository that could no-op without shouting, and mining tests cannot be trusted until it is closed.

**Files:**
- Modify: `packages/executor/test/integration/mc-console.ts`

**Interfaces:**
- Consumes: `sendConsoleCommand` (already present).
- Produces:
  - `buildArena` additionally despawns loose item entities.
  - `function giveItem(username: string, item: string, count?: number): void`
  - `function clearInventory(username: string): void`
  - Tasks 10–12 use all three.

- [ ] **Step 1: Add the helpers and the despawn**

In `packages/executor/test/integration/mc-console.ts`, inside `buildArena`, after the two `fill` commands:

```ts
  // VERIFIED 2026-09-07, the hard way: a coal drop left in the arena by an
  // earlier run was silently picked up by a later one, so a case that should
  // have shown "mined but collected nothing" reported a successful collection
  // instead. Mined drops are shared world state that outlives the run that
  // created them, and the arena is reused. Despawn them with the rest of the
  // reset, or every collection assertion is suspect.
  //
  // Scoped to the arena volume rather than `kill @e[type=item]` globally, so a
  // concurrently running test elsewhere in the world is not disturbed.
  const cx = Math.floor((x0 + x1) / 2)
  const cz = Math.floor((z0 + z1) / 2)
  const radius = Math.ceil(Math.hypot(x1 - x0, clearance, z1 - z0) / 2) + 4
  sendConsoleCommand(
    `kill @e[type=item,x=${cx},y=${floorY},z=${cz},distance=..${radius}]`,
  )
```

Append at the end of the file:

```ts
/**
 * Gives `username` an item via the server console. Mining tests need a tool
 * the bot could not otherwise obtain in a fresh world.
 */
export function giveItem(username: string, item: string, count = 1): void {
  sendConsoleCommand(`give ${username} ${item} ${count}`)
}

/**
 * Empties `username`'s inventory. Mining tests assert on what arrived in the
 * inventory, so they must start from a known-empty one — otherwise an item
 * left by a previous test reads as this test's drop.
 */
export function clearInventory(username: string): void {
  sendConsoleCommand(`clear ${username}`)
}
```

- [ ] **Step 2: Write a test proving the despawn actually fires**

A guard nobody has seen trigger is not known to work. Create `packages/executor/test/integration/arena-reset.int.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { MineflayerExecutor } from '../../src/index.js'
import {
  buildArena,
  sendConsoleCommand,
  teleportAndWait,
  waitForOnGround,
  clearInventory,
  type ArenaBounds,
} from './mc-console.js'

const ARENA: ArenaBounds = { x0: 860, x1: 880, z0: 0, z1: 8, floorY: 199, clearance: 6 }
const START = { x: 865, y: ARENA.floorY + 1, z: 4 }

describe('arena reset despawns loose items', () => {
  let executor: MineflayerExecutor | null = null

  afterEach(async () => {
    await executor?.disconnect()
    executor = null
  })

  it('removes item entities left inside the arena by a previous run', async () => {
    executor = new MineflayerExecutor({ username: 'ITArenaReset' })
    expect((await executor.connect()).ok).toBe(true)

    await buildArena(ARENA)
    await teleportAndWait(executor, 'ITArenaReset', START)
    await waitForOnGround(executor, { expectedY: ARENA.floorY + 1 })
    clearInventory('ITArenaReset')

    // Simulate the litter a previous mining run leaves behind, far enough away
    // that the bot cannot simply pick it up during this test.
    sendConsoleCommand(`summon item 875 ${ARENA.floorY + 2} 4 {Item:{id:"minecraft:coal",count:1}}`)
    await new Promise((r) => setTimeout(r, 1_500))

    const before = executor.getState().nearbyEntities.filter((e) => e.kind === 'item')
    expect(before.length).toBeGreaterThan(0) // the fixture must be able to fail

    await buildArena(ARENA)
    await new Promise((r) => setTimeout(r, 1_500))

    const after = executor.getState().nearbyEntities.filter((e) => e.kind === 'item')
    expect(after.length).toBe(0)
  })
})
```

- [ ] **Step 3: Run it**

```bash
npm run smoke && npm run test:integration -- arena-reset
```

Expected: PASS. The `before.length > 0` assertion is what stops this test from passing vacuously — if the `summon` silently failed, the test fails rather than reporting a clean arena it never dirtied.

- [ ] **Step 4: Confirm the rest of the integration suite still passes**

```bash
npm run test:integration
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/executor/test/integration
git commit -m "test(executor): despawn loose items in the arena reset

Found the hard way while probing Phase 2: a coal drop left in the arena
by one run was silently collected by the next, so a case that should
have reported 'mined but collected nothing' showed a successful
collection instead.

Mined drops are shared world state that outlives the run creating them,
and the arena is reused. This is the third fixture here that could
no-op without shouting, so the despawn ships with a test that dirties
the arena first and asserts the litter was actually there — a guard
nobody has watched fire is not yet known to work.

Scoped to the arena volume, not a global kill, so concurrent work
elsewhere in the world is untouched."
```

---

## Task 10: `mineBlock` — resolve, equip, dig

Steps 1–3 of the four-step sequence. Collection is Task 11.

**Files:**
- Modify: `packages/executor/src/mineflayer-executor.ts`
- Test: `packages/executor/test/integration/mine.int.test.ts`

**Interfaces:**
- Consumes: `runAction()` (Task 6), `gotoGoal()` (Task 7), `canHarvest`/`bestHarvestTool` (Task 8), arena helpers (Task 9).
- Produces: `mineBlock(target: string | Vec3, maxDistance, opts?)` returning `ok({ position, collected: false })` on a successful dig. Task 11 fills in `collected`.

- [ ] **Step 1: Write the failing integration tests**

`packages/executor/test/integration/mine.int.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { MineflayerExecutor } from '../../src/index.js'
import {
  buildArena,
  placeArenaBlock,
  teleportAndWait,
  waitForOnGround,
  giveItem,
  clearInventory,
  type ArenaBounds,
} from './mc-console.js'

const ARENA: ArenaBounds = { x0: 900, x1: 930, z0: 0, z1: 8, floorY: 199, clearance: 6 }
const START = { x: 905, y: ARENA.floorY + 1, z: 4 }
const ORE = { x: 912, y: ARENA.floorY + 1, z: 4 }

describe('mineBlock against the dev server', () => {
  let executor: MineflayerExecutor | null = null

  afterEach(async () => {
    await executor?.disconnect()
    executor = null
  })

  async function arenaBot(username: string, tool: string | null): Promise<MineflayerExecutor> {
    const e = new MineflayerExecutor({ username })
    expect((await e.connect()).ok).toBe(true)
    await buildArena(ARENA)
    await teleportAndWait(e, username, START)
    await waitForOnGround(e, { expectedY: ARENA.floorY + 1 })
    clearInventory(username)
    await new Promise((r) => setTimeout(r, 500))
    if (tool) {
      giveItem(username, tool)
      await new Promise((r) => setTimeout(r, 1_000))
    }
    placeArenaBlock(ORE, 'coal_ore')
    await new Promise((r) => setTimeout(r, 800))
    return e
  }

  it('mines a coal ore named by position', async () => {
    executor = await arenaBot('ITMinePos', 'stone_pickaxe')
    const r = await executor.mineBlock(ORE, 32, { timeoutMs: 60_000 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.position).toEqual(ORE)
    expect(executor.findBlocks({ names: ['coal_ore'], maxDistance: 32, limit: 5 })).toHaveLength(0)
  })

  it('mines a coal ore named by block name', async () => {
    executor = await arenaBot('ITMineName', 'stone_pickaxe')
    const r = await executor.mineBlock('coal_ore', 32, { timeoutMs: 60_000 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.position).toEqual(ORE)
  })

  it('equips a pickaxe from inventory rather than requiring it be held', async () => {
    executor = await arenaBot('ITMineEquip', 'stone_pickaxe')
    expect(executor.getState().self.heldItem?.name).not.toBe('stone_pickaxe')
    const r = await executor.mineBlock(ORE, 32, { timeoutMs: 60_000 })
    expect(r.ok).toBe(true)
    expect(executor.getState().self.heldItem?.name).toBe('stone_pickaxe')
  })

  it('fails missing_tool AND LEAVES THE BLOCK STANDING with no pickaxe', async () => {
    executor = await arenaBot('ITMineNoTool', null)
    const r = await executor.mineBlock(ORE, 32, { timeoutMs: 30_000 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('missing_tool')

    // The assertion that gives the guard teeth. Without it this test passes
    // just as well against an executor that digs first and checks afterwards —
    // which is the exact bug the guard exists to prevent. Measured: bare-handed
    // coal ore takes 15 seconds to break and drops nothing.
    const still = executor.findBlocks({ names: ['coal_ore'], maxDistance: 32, limit: 5 })
    expect(still).toHaveLength(1)
    expect(still[0]?.position).toEqual(ORE)
  })

  it('fails missing_tool holding a wrong tool, and leaves the block standing', async () => {
    executor = await arenaBot('ITMineWrongTool', 'iron_shovel')
    const r = await executor.mineBlock(ORE, 32, { timeoutMs: 30_000 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('missing_tool')
    expect(executor.findBlocks({ names: ['coal_ore'], maxDistance: 32, limit: 5 })).toHaveLength(1)
  })

  it('fails not_found for a position holding air', async () => {
    executor = await arenaBot('ITMineAir', 'stone_pickaxe')
    const r = await executor.mineBlock({ x: 920, y: ARENA.floorY + 3, z: 4 }, 32)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_found')
  })

  it('fails not_found for a name with no match in range', async () => {
    executor = await arenaBot('ITMineNoMatch', 'stone_pickaxe')
    const r = await executor.mineBlock('diamond_ore', 32)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_found')
  })

  it('fails invalid_target for a block name the registry does not know', async () => {
    executor = await arenaBot('ITMineBadName', 'stone_pickaxe')
    const r = await executor.mineBlock('not_a_real_block', 32)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid_target')
  })

  it('fails not_found for a position beyond maxDistance', async () => {
    executor = await arenaBot('ITMineFar', 'stone_pickaxe')
    const r = await executor.mineBlock(ORE, 2)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_found')
  })

  it('resolves interrupted when aborted before the dig completes', async () => {
    executor = await arenaBot('ITMineAbort', 'stone_pickaxe')
    const controller = new AbortController()
    const pending = executor.mineBlock(ORE, 32, { signal: controller.signal, timeoutMs: 60_000 })
    setTimeout(() => controller.abort(), 400)
    const r = await pending
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('interrupted')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
npm run smoke && npm run test:integration -- mine
```

Expected: FAIL — `mineBlock` still returns `fail('internal', 'mineBlock arrives in Phase 2')`.

- [ ] **Step 3: Implement resolve, equip and dig**

In `packages/executor/src/mineflayer-executor.ts`, add the imports:

```ts
import { canHarvest, bestHarvestTool, type ToolItem } from './harvest.js'
```

Replace the `mineBlock` stub:

```ts
  async mineBlock(
    target: string | Vec3,
    maxDistance: number,
    opts?: ActionOptions,
  ): Promise<Result<{ position: Vec3; collected: boolean }>> {
    return this.runAction(opts, 60_000, async (bot, signal) => {
      // --- Step 1: resolve the target to a concrete block ---
      const resolved = this.resolveMineTarget(bot, target, maxDistance)
      if (!resolved.ok) return resolved
      const block = resolved.value
      const position: Vec3 = {
        x: block.position.x,
        y: block.position.y,
        z: block.position.z,
      }

      // --- Step 2: harvest check BEFORE digging ---
      // Ordering is the whole point. Bare-handed or wrong-tooled, coal ore
      // takes 15 seconds to break and drops nothing (measured), so checking
      // afterwards would mean destroying the resource to discover we could
      // not have collected it.
      const items: ToolItem[] = bot.inventory.items().map((i) => ({
        name: i.name,
        type: i.type,
        slot: i.slot,
      }))
      const held = bot.heldItem ? { name: bot.heldItem.name, type: bot.heldItem.type, slot: bot.heldItem.slot } : null

      if (!canHarvest(block, held)) {
        const better = bestHarvestTool(block, items)
        if (!better) {
          return fail(
            'missing_tool',
            `nothing in inventory can harvest ${block.name}; the block was left standing`,
          )
        }
        const toEquip = bot.inventory.items().find((i) => i.slot === better.slot)
        if (!toEquip) return fail('internal', `tool in slot ${better.slot} vanished before equipping`)
        await bot.equip(toEquip, 'hand')
      }

      if (bot.inventory.emptySlotCount() === 0) {
        return fail('inventory_full', 'no free inventory slot for the drop')
      }
      if (signal.aborted) return ok({ position, collected: false })

      // --- Step 3: approach, then dig ---
      const approach = await this.gotoGoal(
        bot,
        signal,
        new goals.GoalLookAtBlock(block.position, bot.world) as never,
      )
      if (!approach.ok) return approach
      if (signal.aborted) return ok({ position, collected: false })

      const fresh = bot.blockAt(block.position)
      if (!fresh || fresh.name === 'air') {
        return fail('not_found', `${block.name} at ${position.x},${position.y},${position.z} is gone`)
      }
      await bot.dig(fresh)

      return ok({ position, collected: false })
    })
  }

  /**
   * Resolve a mine target to a live block. A name searches for the nearest
   * match; a position names one block exactly — which is the point of
   * accepting a Vec3 at all, since a name re-search may pick a different
   * block than the planner reasoned about.
   */
  private resolveMineTarget(
    bot: Bot,
    target: string | Vec3,
    maxDistance: number,
  ): Result<ReturnType<Bot['blockAt']> & { name: string; position: { x: number; y: number; z: number } }> {
    const origin = bot.entity.position

    if (typeof target === 'string') {
      if (!bot.registry.blocksByName[target]) {
        return fail('invalid_target', `unknown block name "${target}"`)
      }
      const found = this.findBlocks({ names: [target], maxDistance, limit: 1 })
      const nearest = found[0]
      if (!nearest) return fail('not_found', `no ${target} within ${maxDistance} blocks`)
      const block = bot.blockAt(bot.entity.position.offset(0, 0, 0).set(
        nearest.position.x, nearest.position.y, nearest.position.z,
      ))
      if (!block) return fail('not_found', `block at ${target} position is not loaded`)
      return ok(block as never)
    }

    const distance = Math.hypot(target.x - origin.x, target.y - origin.y, target.z - origin.z)
    if (distance > maxDistance) {
      return fail('not_found', `target is ${distance.toFixed(1)} blocks away, beyond maxDistance ${maxDistance}`)
    }
    const block = bot.blockAt(bot.entity.position.offset(0, 0, 0).set(target.x, target.y, target.z))
    if (!block || block.name === 'air') {
      return fail('not_found', `no block at (${target.x}, ${target.y}, ${target.z})`)
    }
    return ok(block as never)
  }
```

- [ ] **Step 4: Run the mining tests**

```bash
npm run test:integration -- mine
```

Expected: PASS, except the two collection-related expectations that Task 11 delivers. If `missing_tool` passes but its "block still standing" assertion fails, the harvest check is running after the dig — fix the ordering, do not relax the assertion.

- [ ] **Step 5: Run everything**

```bash
npm test
npm run typecheck
npm run test:integration
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/executor
git commit -m "feat(executor): mine a block, checking harvestability first

Implements resolve/equip/dig. Collection is the next commit; this
reports collected:false throughout.

The harvest check runs BEFORE the dig, which is the entire point:
measured against the live server, coal ore bare-handed or with the wrong
tool takes 15 seconds to break and drops nothing. Checking afterwards
would mean destroying the resource to learn we could not collect it. So
missing_tool leaves the block standing, and the integration test asserts
the block is still there rather than only that the call failed — without
that assertion the test would pass against a dig-first implementation."
```

---

## Task 11: Collect the drop

Mining does not collect. Measured: a coal drop 1.72 blocks away was still uncollected 3 seconds later.

**Files:**
- Modify: `packages/executor/src/mineflayer-executor.ts`
- Test: `packages/executor/test/integration/mine.int.test.ts`

**Interfaces:**
- Consumes: everything from Task 10.
- Produces: `mineBlock` resolving `collected: true` when the drop reaches the inventory.

- [ ] **Step 1: Write the failing tests**

Append to `packages/executor/test/integration/mine.int.test.ts` inside the existing `describe`:

```ts
  it('collects the coal and reports collected: true', async () => {
    executor = await arenaBot('ITMineCollect', 'stone_pickaxe')
    const before = executor.getState().self.inventory.filter((i) => i.name === 'coal').length
    expect(before).toBe(0) // clearInventory must actually have fired

    const r = await executor.mineBlock(ORE, 32, { timeoutMs: 60_000 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.collected).toBe(true)

    const coal = executor.getState().self.inventory.find((i) => i.name === 'coal')
    expect(coal?.count).toBeGreaterThanOrEqual(1)
  })

  it('reports collected: false — still ok — when the drop cannot be retrieved', async () => {
    executor = await arenaBot('ITMineNoCollect', 'stone_pickaxe')
    // Mine the ore, then destroy the drop before the bot can reach it, by
    // killing item entities the instant the dig finishes. The block WAS
    // mined, so this must stay ok: reporting a failure would lose that fact,
    // which is exactly the distinction `collected` exists to carry.
    const pending = executor.mineBlock(ORE, 32, { timeoutMs: 60_000 })
    const killer = setInterval(() => sendConsoleCommand('kill @e[type=item,x=912,y=199,z=4,distance=..20]'), 200)
    const r = await pending
    clearInterval(killer)

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.collected).toBe(false)
    expect(executor.findBlocks({ names: ['coal_ore'], maxDistance: 32, limit: 5 })).toHaveLength(0)
  })
```

Add `sendConsoleCommand` to the `mc-console.js` import at the top of the file.

- [ ] **Step 2: Run to verify they fail**

```bash
npm run test:integration -- mine
```

Expected: FAIL — `collected` is hard-coded `false`, so the first test fails and the second passes vacuously.

- [ ] **Step 3: Implement collection**

In `packages/executor/src/mineflayer-executor.ts`, replace the final `return ok({ position, collected: false })` of `mineBlock` with:

```ts
      const collected = await this.collectDrop(bot, signal, block.position)
      return ok({ position, collected })
```

Add the method:

```ts
  /**
   * Walk onto whatever the dig dropped and wait for it to reach the inventory.
   *
   * VERIFIED 2026-09-07: mining does not collect. After a successful dig the
   * coal sat as an item entity 1.72 blocks away and was still uncollected
   * three seconds later — Minecraft's pickup radius is roughly one block, so
   * waiting longer would not have helped. The bot has to go and get it.
   *
   * Best-effort by design, and never fails the action: the block WAS mined,
   * and reporting a failure would lose that. A drop that fell in lava or was
   * grabbed by a mob resolves `collected: false`, which is precisely the
   * distinction the contract's boolean exists to carry.
   */
  private async collectDrop(
    bot: Bot,
    signal: AbortSignal,
    origin: { x: number; y: number; z: number },
  ): Promise<boolean> {
    const countItems = (): number =>
      bot.inventory.items().reduce((n, i) => n + i.count, 0)
    const before = countItems()
    const deadline = Date.now() + 8_000

    // Give the drop a moment to spawn and settle before looking for it.
    await new Promise((r) => setTimeout(r, 400))

    while (Date.now() < deadline && !signal.aborted) {
      if (countItems() > before) return true

      const drop = Object.values(bot.entities)
        .filter((e) => e?.name === 'item' && e.position)
        .map((e) => ({ e, d: e.position.distanceTo(bot.entity.position) }))
        .filter(({ e }) => e.position.distanceTo(bot.entity.position.offset(0, 0, 0).set(origin.x, origin.y, origin.z)) < 6)
        .sort((a, b) => a.d - b.d)[0]

      if (!drop) {
        await new Promise((r) => setTimeout(r, 300))
        continue
      }

      try {
        await this.gotoGoal(
          bot,
          signal,
          new goals.GoalNear(
            Math.floor(drop.e.position.x),
            Math.floor(drop.e.position.y),
            Math.floor(drop.e.position.z),
            0,
          ) as never,
        )
      } catch {
        // The drop can despawn or be collected mid-path; fall through and
        // re-check the inventory rather than treating it as an error.
      }
      await new Promise((r) => setTimeout(r, 500))
    }

    return countItems() > before
  }
```

- [ ] **Step 4: Run the mining tests**

```bash
npm run test:integration -- mine
```

Expected: PASS, all of them.

- [ ] **Step 5: Run everything**

```bash
npm test
npm run typecheck
npm run smoke && npm run test:integration
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/executor
git commit -m "feat(executor): walk onto the drop so mining actually collects

Mining does not collect. Measured against the live server: after a
successful dig the coal sat as an item entity 1.72 blocks away and was
still uncollected three seconds later. Minecraft's pickup radius is
roughly one block, so waiting longer does not help — the bot has to go
and get it.

Collection is best-effort and never fails the action. The block WAS
mined, and reporting a failure would lose that fact; a drop that cannot
be retrieved resolves ok with collected:false, which is exactly the
distinction the contract's boolean exists to carry."
```

---

## Task 12: Phase 2 demo and documentation

**Files:**
- Create: `packages/executor/src/phase2-demo.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the finished executor.
- Produces: `npm run demo:phase2`.

- [ ] **Step 1: Write the demo**

`packages/executor/src/phase2-demo.ts`:

```ts
/**
 * Phase 2 deliverable: path to a known coal-ore coordinate, mine it, collect
 * the drop. Uses the floating arena so it is reproducible on any world rather
 * than depending on terrain that may not contain surface coal.
 */
import { execFileSync } from 'node:child_process'
import { MineflayerExecutor } from './index.js'

const USERNAME = 'Phase2Demo'
const FLOOR = 199
const ARENA = { x0: 950, x1: 980, z0: 0, z1: 8 }
const START = { x: 955, y: FLOOR + 1, z: 4 }
const ORE = { x: 968, y: FLOOR + 1, z: 4 }

const mc = (command: string): void => {
  execFileSync('tmux', ['send-keys', '-t', 'mc', command, 'Enter'])
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<number> {
  const executor = new MineflayerExecutor({ username: USERNAME })
  try {
    console.log('connecting…')
    const connected = await executor.connect()
    if (!connected.ok) {
      console.error(`FAIL: could not connect — ${connected.reason}: ${connected.detail}`)
      return 1
    }

    console.log('building the arena…')
    mc(`forceload add ${ARENA.x0} ${ARENA.z0} ${ARENA.x1} ${ARENA.z1}`)
    await sleep(800)
    mc(`fill ${ARENA.x0} ${FLOOR + 1} ${ARENA.z0} ${ARENA.x1} ${FLOOR + 6} ${ARENA.z1} air`)
    mc(`fill ${ARENA.x0} ${FLOOR} ${ARENA.z0} ${ARENA.x1} ${FLOOR} ${ARENA.z1} stone`)
    mc(`kill @e[type=item,x=965,y=${FLOOR},z=4,distance=..40]`)
    await sleep(700)
    mc(`tp ${USERNAME} ${START.x} ${START.y} ${START.z}`)
    mc(`clear ${USERNAME}`)
    mc(`give ${USERNAME} stone_pickaxe 1`)
    await sleep(1_200)
    // A wall with one gap, so arriving proves pathing rather than walking.
    mc(`fill 962 ${FLOOR + 1} ${ARENA.z0} 962 ${FLOOR + 3} ${ARENA.z1} stone`)
    mc(`fill 962 ${FLOOR + 1} 1 962 ${FLOOR + 3} 1 air`)
    mc(`setblock ${ORE.x} ${ORE.y} ${ORE.z} coal_ore`)
    await sleep(1_200)

    const before = executor.getState()
    console.log(`at x=${before.self.position.x.toFixed(1)} z=${before.self.position.z.toFixed(1)}, ` +
      `health ${before.self.health}, holding ${before.self.heldItem?.name ?? 'nothing'}`)

    const found = executor.findBlocks({ names: ['coal_ore'], maxDistance: 32, limit: 5 })
    console.log(`found ${found.length} coal_ore; nearest at ` +
      `${found[0] ? `(${found[0].position.x}, ${found[0].position.y}, ${found[0].position.z})` : 'n/a'}`)
    if (!found[0]) {
      console.error('FAIL: no coal ore found — the arena setup did not take')
      return 1
    }

    console.log('mining it…')
    const mined = await executor.mineBlock(found[0].position, 32, { timeoutMs: 90_000 })
    if (!mined.ok) {
      console.error(`FAIL: ${mined.reason}: ${mined.detail}`)
      return 1
    }

    const after = executor.getState()
    const coal = after.self.inventory.find((i) => i.name === 'coal')
    console.log(`mined at (${mined.value.position.x}, ${mined.value.position.y}, ${mined.value.position.z}), ` +
      `collected=${mined.value.collected}`)
    console.log(`inventory: ${after.self.inventory.map((i) => `${i.name}x${i.count}`).join(', ') || '(empty)'}`)

    if (!mined.value.collected || !coal) {
      console.error('FAIL: the ore was mined but the coal was not collected')
      return 1
    }
    console.log('DONE: pathed around a wall, mined coal ore, collected the drop.')
    return 0
  } finally {
    await executor.disconnect()
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error('FAIL:', e instanceof Error ? e.message : String(e))
    process.exit(1)
  },
)
```

- [ ] **Step 2: Add the script**

In the root `package.json` `scripts`:

```json
    "demo:phase2": "tsx packages/executor/src/phase2-demo.ts"
```

- [ ] **Step 3: Run it**

```bash
npm run smoke && npm run demo:phase2
```

Expected: exit 0 and `DONE: pathed around a wall, mined coal ore, collected the drop.` Watch from a second client to confirm the bot visibly routes through the gap rather than jamming against the wall.

- [ ] **Step 4: Update the documentation**

In `README.md`, add `npm run demo:phase2` to the commands list and note that Phase 2 delivers pathfinder movement and mining.

In `CLAUDE.md`, make these edits:

- Add to the commands block: `npm run demo:phase2   # Connect, path around a wall, mine coal. The Phase 2 deliverable.`
- Add to the "Verified environment facts" table:

| Fact | Consequence |
|---|---|
| `bot.canDigBlock()` returns `true` bare-handed, with a shovel, and with a pickaxe | It means "breakable", not "harvestable". Never use it for `missing_tool`; use `block.harvestTools` |
| `bot.pathfinder.bestHarvestTool()` returned `iron_shovel` for coal ore when that was the only inventory item | Untrustworthy. `harvest.ts` owns the decision instead |
| Mining does not collect — a drop 1.72 blocks away was uncollected 3s later | `mineBlock` walks onto the drop; `collected: false` is a real outcome, not a bug |
| Coal ore `digTime`: 15000ms bare-handed or wrong-tooled (drops nothing), 2300ms wooden pickaxe, 1150ms stone | The harvest guard exists to avoid the 15s no-drop case |
| `goals` is not an ESM named export of `mineflayer-pathfinder` | Use the default import and destructure |
| `goto()` rejects with `.name` of `NoPath` / `Timeout` / `PathStopped` / `GoalChanged` | That name is the only discriminator between `unreachable` and `interrupted` |
| Mined item drops persist in the world across runs | The arena reset despawns them, or collection assertions report false greens |

- Replace the "Scope boundaries" bullet about stubs so `mineBlock` is no longer listed, and remove the "No `mineflayer-pathfinder`" bullet — both are now false.

- [ ] **Step 5: Run the full verification**

```bash
npm test
npm run typecheck
node scripts/check-invariants.mjs
npm run smoke && npm run test:integration
npm run demo && npm run demo:phase2
```

Expected: all green. Record the actual test counts in the commit message rather than asserting "all tests pass" without them.

- [ ] **Step 6: Commit**

```bash
git add package.json README.md CLAUDE.md packages/executor
git commit -m "feat: add the Phase 2 demo and record what it cost to learn

npm run demo:phase2 paths around a wall to a known coal-ore coordinate,
mines it and collects the drop — the Phase 2 deliverable. It builds its
own arena so it is reproducible on any world, rather than depending on
surface coal the openfield seed does not have.

CLAUDE.md gains the environment facts this phase paid for, notably that
canDigBlock is not a harvest check and that mining does not collect."
```

---

## Task 13: Open the pull request

- [ ] **Step 1: Final verification**

```bash
npm test && npm run typecheck && node scripts/check-invariants.mjs && npm run test:integration
```

Do not proceed on a red result, and do not describe the branch as passing without having seen this output.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin phase-2-track-a
gh pr create --title "Phase 2 (Track A): pathfinding and tool-aware mining" --body "$(cat <<'EOF'
## What

- Lands all four design-spec §9 contract changes, agreed with Track B beforehand: `mineBlock` accepts a position, `on()` survives reconnects, `MockExecutor` can inject any `FailureReason`, `connect()` is reentrant.
- Replaces Phase 1's raw movement with `mineflayer-pathfinder`, mapping `NoPath` to `unreachable`.
- Implements `mineBlock` as resolve → equip → dig → collect.

## Three measurements that shaped this

- **`bot.canDigBlock()` is not a harvest check.** It returns `true` bare-handed, holding a shovel, and holding a pickaxe. Bare-handed or wrong-tooled, coal ore takes 15 seconds to break and drops nothing, so the harvest guard runs *before* the dig and `missing_tool` leaves the block standing.
- **Mining does not collect.** A drop 1.72 blocks away was still uncollected 3 seconds later, so `mineBlock` walks onto it.
- **`mineflayer-pathfinder` is unmaintained** (last published 2023-09-04) but verified working on protocol 773. Phases 4–6 will lean on it much harder.

## Testing

Integration tests require the live dev server and were run locally; CI covers unit tests, typecheck and invariants only. Every guard is tested firing — `missing_tool` asserts the ore is still standing, not merely that the call failed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

**Spec coverage.** §3.1 → Task 3. §3.2 → Task 1. §3.3 → Task 2. §3.4 → Task 4. §4 pathfinder movement → Tasks 5, 7. §5 mineBlock steps 1–3 → Task 10, step 4 → Task 11. §6 `harvest.ts` → Task 8, `runAction()` → Task 6. §7 contract-suite additions → Tasks 1, 3, 4; unit tests → Tasks 2, 8; integration and the arena despawn → Tasks 9, 10, 11. §8 deliverable → Task 12. No spec section is unimplemented.

**Type consistency.** `mineBlock(target: string | Vec3, maxDistance, opts?)` is used identically in Tasks 1, 2, 10, 11. `runAction(opts, defaultTimeoutMs, body)` as defined in Task 6 is called that way in Tasks 6, 7, 10. `gotoGoal(bot, signal, goal)` from Task 7 is reused in Tasks 10 and 11. `canHarvest`/`bestHarvestTool` signatures in Task 8 match their use in Task 10. `giveItem`/`clearInventory` from Task 9 are used in Tasks 10 and 11.

**Verified while writing this plan, so execution need not rediscover them:**

- `GoalLookAtBlock`'s constructor is `(pos: Vec3, world: World, options?: { reach?, entityHeight? })` — the Task 10 call `new goals.GoalLookAtBlock(block.position, bot.world)` matches.
- `bot.registry.blocksByName.coal_ore` is truthy and `bot.registry.blocksByName.not_a_real_block` is falsy against the live server, so Task 10's `invalid_target` check works as written.
- `bot.inventory.emptySlotCount` is a function, as Task 10's `inventory_full` check assumes.

**Known risks carried into execution:**

1. **The `collected: false` test** (Task 11) races a console `kill` loop against the bot's pickup. If it proves flaky, make the drop unreachable by construction — mine an ore over a one-block lava pit — rather than loosening the assertion.
2. **`ToolItem.type`** (Task 8) assumes prismarine-item exposes `.type` as the numeric id that `block.harvestTools` is keyed by. The `harvestTools` keys were measured (`{913: true, …}`), but the probe's inventory was empty at the moment of checking, so the item side is inferred rather than observed. Confirm it in Task 10's first run: if `canHarvest` rejects a pickaxe that visibly works, this is why.
3. **`mineflayer-pathfinder` is unmaintained** (spec §9). It works today; there is no upstream if a future version breaks it.
