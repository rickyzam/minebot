# Phase 2 (Track A) — Pathfinding and Mining — Design

**Date:** 2026-09-07
**Status:** Awaiting review
**Builds on:** [`2026-09-07-minecraft-agent-design.md`](./2026-09-07-minecraft-agent-design.md) — the binding contract. This
document does not relitigate it; it applies §9's four pending changes and specifies
the Phase 2 slice the notes describe as "pathfinding + hardcoded mining."

---

## 1. Scope

Per [`docs/notes/Phase Plan and Parallel Work Split.md`](../../notes/Phase%20Plan%20and%20Parallel%20Work%20Split.md):

> **Phase 2 — Pathfinding + hardcoded mining.** Add `mineflayer-pathfinder`, path to a
> known coal-ore coordinate, mine it. Still no LLM — this proves out the execution
> layer on its own.

Concretely, this phase delivers three things:

1. The four contract changes recorded as agreed-pending in design spec §9.
2. `moveTo` reimplemented on `mineflayer-pathfinder`, replacing Phase 1's raw movement.
3. `mineBlock` implemented end to end: resolve a target, equip a tool that can actually
   harvest it, approach, dig, and collect the drop.

**Out of scope, and deliberately still stubs:** `placeBlock`, `followPlayer`, `attack`,
`flee`. They keep returning `fail('internal', '… arrives in Phase N')` after the
`opts?.signal?.aborted` check the contract suite asserts for all six actions.

**Also out of scope:** any search or explore strategy. Finding coal that is not already
in a loaded chunk is Phase 4's problem. Phase 2 mines a block it was told about.

## 2. Verified environment facts (measured 2026-09-07)

These were measured against the live dev server while designing this phase, using
throwaway probe scripts. They are the evidence base for the decisions below, and
several of them contradict the obvious assumption.

| Fact | Consequence |
|---|---|
| `mineflayer-pathfinder@2.4.5` (published 2023-09-04) loads and paths correctly on Minecraft 1.21.10 / protocol 773 | The phase is feasible on a three-year-stale dependency. Verified by routing around a deliberately built wall, not merely by walking forward |
| A `GoalNear` path of ~30 blocks around a wall completed in **6.1s** with `canDig: false` | Movement timeouts must allow for pathing that is much slower than a straight line |
| `bot.pathfinder.stop()` rejects the in-flight `goto` with `Path was stopped before it could be completed!`, and `isMoving()` reads `false` ~770ms later | This is the mechanism `interrupted` is built on |
| **`bot.canDigBlock()` returns `true` bare-handed, holding a shovel, and holding a pickaxe** | It means "breakable at all", *not* "harvestable". It is the wrong signal for `missing_tool` and must not be used for it |
| Coal ore, **bare-handed**: `digTime` 15000ms, block breaks, **drops nothing** | Digging without a valid tool destroys the resource for zero gain, slowly |
| Coal ore, **holding an iron shovel**: `digTime` 15000ms, block breaks, **drops nothing** | Holding *a* tool is not holding *the* tool |
| Coal ore, **wooden pickaxe**: `digTime` 2300ms, drops coal. **Stone pickaxe**: 1150ms | Dig deadlines should derive from `bot.digTime`, not a fixed constant |
| `bot.pathfinder.bestHarvestTool(coalOre)` returned **`iron_shovel`** when that was the only inventory item | Unreliable. Do not delegate the harvest decision to it |
| `block.harvestTools` is a map of item-type ids, e.g. `{913: true, 918: true, …}` for coal ore | This is the reliable harvestability signal |
| After a successful dig, the coal drop sat as an item entity **1.72 blocks away and was still uncollected 3 seconds later** | Mining does not collect. `collected: true` requires deliberately moving onto the drop |
| A stale coal drop left in the arena by an earlier probe run was silently picked up by a later run, making a no-drop case look like a successful collection | Arena reset must despawn loose items, or tests report false greens |

The last row is the same class of failure as the two traps already recorded in
[CLAUDE.md](../../../CLAUDE.md): a fixture that can no-op without shouting. It was caught
only because two probe runs disagreed.

## 3. Contract changes (design spec §9)

All four §9 items land together, in a single commit, **before** any executor work —
`contract`, `mock-executor`, and the contract suite move as one unit, and the executor
is written against the result.

**This is a change to the shared integration surface.** Spec §4 and CLAUDE.md both say
`contract/` and `mock-executor/` change only by mutual agreement with Track B. The
implementation plan carries this as an explicit gate: Ricky's agreement is confirmed
before the commit lands, not after. The changes are cheapest now — `packages/agent/`
does not yet exist and Track B has no code depending on the current shapes.

### 3.1 `on()` survives reconnect, and works before connect

Today handlers bind to the `Bot` instance live at subscribe time, so after a drop the
subscription is attached to a dead emitter and silently never fires again. The reflex
layer subscribes once at startup and expects to hear about damage for the whole session.

The executor gains a long-lived internal emitter that outlives any single `Bot`.
`connect()` wires the new bot's Mineflayer events into it; `disconnect()` unwires them.
`on()` registers against the emitter, so it is legal before the first `connect()` and
keeps working across reconnects. The returned `Unsubscribe` detaches from the emitter,
not from the bot.

No signature change — this is a behavioural guarantee, and the contract suite gains
tests for it.

### 3.2 `mineBlock` accepts a position

```ts
mineBlock(
  target: string | Vec3,
  maxDistance: number,
  opts?: ActionOptions,
): Promise<Result<{ position: Vec3; collected: boolean }>>
```

`findBlocks` yields `BlockInfo` with a `position`, but the current name-only signature
re-searches and may mine a different block than the planner reasoned about. The obvious
agent loop — search, choose, approach, mine *that one* — is currently inexpressible.

`maxDistance` keeps its meaning in both forms: with a `string` it bounds the search, and
with a `Vec3` it bounds how far the bot will travel to reach it. A `Vec3` further away
than `maxDistance` fails `not_found` rather than silently walking across the world.

### 3.3 `MockExecutor` can inject failures

The mock currently emits only `interrupted`, `not_found` and `disconnected` — three of
nine `FailureReason` values. Track B builds entirely against the mock, so five reasons,
including every one Phase 4's retry policy needs to branch on, are untestable.

`MockOptions` gains a failure-injection map keyed by action name:

```ts
failures?: Partial<Record<MockActionName, { reason: FailureReason; detail?: string }>>
```

An entry makes that action fail with that reason until it is cleared. A setter lets a test
change injections between calls on a live mock, so a retry policy can be driven through
"fail, then succeed" without constructing a second executor. All nine `FailureReason`
values must be producible this way, and a unit test asserts exactly that.

Injected failures are checked **after** the contract's abort rule, never before: an
already-aborted signal still resolves `interrupted` regardless of what is injected, so
injection cannot be used to violate §3.1 of the design spec.

### 3.4 `connect()` is reentrant

`this.bot` is set only on `spawn`, so a second `connect()` before the first resolves
creates a second bot — which on an offline-mode server duplicate-logins and kicks the
first. `disconnect()` during an in-flight `connect()` is likewise a no-op today.

Both are fixed together with a pending-promise guard: a concurrent `connect()` returns
the in-flight promise rather than starting a second bot, and `disconnect()` during a
pending connect cancels it and tears down whatever was built.

## 4. Pathfinder-backed movement

`mineflayer-pathfinder@2.4.5`, pinned exactly, added to `packages/executor` only.
`packages/contract` keeps its zero runtime dependencies; `packages/agent` never sees it.

Phase 1's raw movement — walk forward, auto-jump on horizontal collision — was explicitly
a stopgap. It is **removed**, not kept as a fallback: two movement code paths would make
`unreachable` mean two different things, and the naive path cannot route around the
terrain Phase 4 will put in front of it.

`moveTo(target)` becomes a `GoalNear(target.x, target.y, target.z, 1)`.

Phase 1's arrival tolerance was 1.5 blocks, horizontal-only. `GoalNear`'s range is a 3D
radius, so the two are not identical and the existing `moveTo` integration tests are the
regression net for the swap: they must pass unchanged. If any of them fails on tolerance
alone, the goal's range is what moves — **not** the assertion. Weakening an arrival test
to accommodate a new movement implementation would discard the only evidence that the
replacement still arrives.

**`Movements` is configured with `canDig = false`.** Movement stays non-destructive, so
the only blocks this phase breaks are the ones `mineBlock` was explicitly asked to break.
A pathfinder allowed to tunnel would quietly rewrite the terrain that the integration
tests depend on, and would make "unreachable" nearly unreachable in the wrong sense.

Outcome mapping:

| Pathfinder outcome | `Result` |
|---|---|
| `goto` resolves | `ok` |
| No path exists (`NoPath`) | `unreachable` |
| `pathfinder.stop()`, or the caller's `AbortSignal` fires | `interrupted` |
| `opts.timeoutMs` elapses | `timeout` |
| Bot is not connected | `disconnected` |

The `NoPath`-versus-stopped distinction is load-bearing: `unreachable` tells the planner
to pick a different target, `interrupted` tells it to re-plan from current state. The
stopped case's error text is measured (§2); the `NoPath` case is verified during
implementation with a walled-off target, and the plan carries a test for it.

`stop()` additionally calls `bot.pathfinder.stop()` and `setGoal(null)`, alongside the
existing in-flight settle and `clearControlStates()`.

## 5. `mineBlock`

The probe results in §2 make this a four-step cancellable sequence rather than a single
call. Every step checks for abort; any of them can settle the action as `interrupted`.

**Step 1 — resolve the target.**
A `string` resolves to the nearest match via the same search `findBlocks` uses. A `Vec3`
resolves via `blockAt`, and is checked against `maxDistance`. A block name the registry
does not know is `invalid_target`; a coordinate holding air, or no match within range, is
`not_found`. The resolved `Vec3` is what the success result reports, so a caller that
passed a position gets exactly that position back.

**Step 2 — harvest check and equip, before any digging.**
Consult `block.harvestTools` against the inventory and equip the best tool that can
actually harvest the block. If nothing in inventory can, return `missing_tool` **and
leave the block standing**.

This ordering is the whole point of the step. Bare-handed or wrong-tooled, the bot will
happily spend 15 seconds breaking coal ore and receive nothing for it (§2) — a silent,
slow, irreversible waste of the exact resource the agent was sent to get. Checking after
the fact would be too late.

Inventory space is checked here too: no free slot means `inventory_full` before the dig,
not a lost drop after it.

**Step 3 — approach and dig.**
`GoalLookAtBlock` puts the bot within reach with line of sight, then `bot.dig`. The dig
deadline derives from `bot.digTime(block)` rather than a fixed constant, since the
measured range spans 1150ms to 15000ms depending on tooling.

**Step 4 — collect the drop.**
Mining does not collect (§2). Locate the item entity that appeared, path onto it, and
poll inventory until the item lands or a short budget expires.

Collection is best-effort by design: the block *was* mined, and reporting that as a
failure would lose the fact. A drop that cannot be retrieved — it fell in lava, another
mob grabbed it — resolves `ok` with `collected: false`, which is exactly the distinction
the contract's `collected` boolean exists to carry.

## 6. Structure

`MineflayerExecutor` stays a single class implementing `BotExecutor`. Two extractions,
both narrow:

**`harvest.ts` — pure, no network, no Mineflayer import.** Holds the harvestability
decision: given a block's `harvestTools` and a list of inventory items, can this be
harvested, and which item is best? Unit-tested with plain object literals, using fixtures
taken from the real measured `harvestTools` map. It follows the precedent `snapshot.ts`
set, and for the same reason: this is the piece with real logic in it, so it belongs where
it can be tested instantly and exhaustively.

It deliberately does **not** delegate to `bot.pathfinder.bestHarvestTool()`, which
returned an iron shovel as the best tool for coal ore (§2).

**`withAction()` — one owner for the cancellation bookkeeping.** `moveTo` already carries
~40 lines of abort-listener, timeout-timer, `inFlightStop` registration and cleanup.
`mineBlock`'s four steps would otherwise repeat it, and every repetition is a fresh chance
to get the contract's resolve-never-throw rule subtly wrong.

This is a refactor of code the contract suite covers, and this repository has already
reverted one such refactor (`requireBot()`) after it introduced contract violations. So it
is introduced test-first, with the full contract suite green against both `MockExecutor`
and `MineflayerExecutor` before and after the change, as a separate commit from the
behaviour it later serves.

## 7. Testing

Three layers, per design spec §5. Nothing here weakens `runContractSuite` — if the real
executor fails an assertion, the executor is what changes.

**Contract suite additions.** Behavioural guarantees added in §3 get suite coverage, so
both implementations are held to them: mining a `Vec3` target returns that exact position;
`on()` registered before `connect()` still fires after it; a subscription survives a
disconnect/reconnect cycle; concurrent `connect()` calls do not produce two bots.

**Unit tests.** `harvest.ts` against fixtures — bare hands, wrong tool, valid tool, a
block with no `harvestTools` at all. The mock's failure injection, proving all nine
`FailureReason` values are now producible.

**Integration tests, in the arena.** Fixed coordinates, floating platform, rebuilt every
run — never real terrain, per the trap CLAUDE.md records. `placeArenaBlock` puts a coal
ore at a known coordinate; the server console `/give`s the tool.

Every guard must be shown firing. A safety check nobody has seen trigger is not yet known
to work:

- `missing_tool` asserts **the ore is still standing afterwards** — not merely that the
  call failed. Without that assertion the test passes just as well against an executor
  that digs first and checks later, which is the exact bug the guard exists to prevent.
- `unreachable` uses a target walled off from the bot, and asserts `NoPath` maps to
  `unreachable` rather than `timeout`.
- `interrupted` aborts mid-path and asserts the bot stopped moving.
- `collected: false` is exercised deliberately, not just observed.

**One fixture change, earned by the probe.** `buildArena` — or the tests' reset path —
must despawn loose item entities (`kill @e[type=item]`). A stale coal drop from an earlier
run was silently collected by a later one, turning a no-drop case green (§2). This is the
third instance in this repository of a fixture that could no-op without shouting, and it
is caught here only by accident.

## 8. Deliverable and verification

**Deliverable:** the bot paths to a known coal-ore coordinate, equips a pickaxe, mines it,
and collects the coal — reported through `Result` with `collected: true`.

**Verification:** the integration suite is the primary evidence, plus a Phase 2 demo
script in the style of `npm run demo`, watched from a second client. The demo uses the
arena so it is reproducible on any world.

## 9. Risks

**`mineflayer-pathfinder` is unmaintained.** Last published 2023-09-04, no newer release,
no active fork with meaningful adoption. It works on protocol 773 today — measured, not
assumed — and is pinned exactly. But there is no upstream to fix it if a later Minecraft
version breaks it, and Phases 4–6 will lean on it much harder than this one does. Worth
knowing now rather than discovering at Phase 4.

**Dig deadlines are tool-dependent.** A 15-second bare-handed dig is longer than most
plausible default timeouts. The §5 harvest guard means the bot should never attempt one,
but if the guard is ever bypassed the failure mode is a timeout rather than an obvious
error, so the guard's test matters more than usual.

**Item drops are shared world state.** Anything that mines in a shared arena leaves
collectable litter for the next run. §7's despawn step addresses it for tests; the same
hazard applies to any future multi-bot work.

## 10. Decisions log

| Decision | Choice | Rationale |
|---|---|---|
| §9 contract changes | Land all four, before executor work | Cheapest possible moment: Track B has no code yet. Requires Ricky's agreement per spec §4 |
| Raw movement | Removed entirely, not kept as fallback | Two movement paths make `unreachable` ambiguous; the naive walk cannot serve Phase 4 |
| `Movements.canDig` | `false` | Movement stays non-destructive; only explicit `mineBlock` calls change the world |
| Harvest check | `block.harvestTools`, before digging | `canDigBlock` is not a harvest signal, and `bestHarvestTool` returned a shovel for coal ore |
| `missing_tool` | Fails without breaking the block | Otherwise 15 seconds destroys the resource for nothing |
| Drop collection | Explicit step; best-effort | Drops are not auto-collected at 1.7 blocks. A failed collection must not erase the fact that mining succeeded |
| Dig deadline | Derived from `bot.digTime` | Measured range is 1150ms–15000ms |
| Test targets | Arena-placed blocks | Terrain-independent and reproducible, per CLAUDE.md's recorded traps |
| Executor structure | One class, plus pure `harvest.ts` and shared `withAction()` | Follows the `snapshot.ts` precedent; avoids triplicating cancellation bookkeeping |
