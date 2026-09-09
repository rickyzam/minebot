# Phase 5 (Track A): the full toolbox — reflex, follow, building

**Date:** 2026-09-09
**Status:** DRAFT. Not agreed, not started. Three decisions below need answers before implementation, and one of them needs Ricky.
**Affects:** `packages/executor/` (four stubs), `packages/bot/` (the arbiter), `packages/contract/` (one doc-comment gap, §7.1)
**Blocked by:** nothing. Phase 4 Track A is merged; the
[work split](../../notes/Phase%20Plan%20and%20Parallel%20Work%20Split.md) runs
`P4A → P5A` and `P4B → P5B` as separate chains that rejoin only at Phase 6.

## 1. What this phase is

Four executor methods are stubs returning `fail('internal', '… arrives in Phase 5')`:

| Stub | Phase 5 Track A item |
|---|---|
| `attack(entityId)` / `flee()` | The reflex/safety layer |
| `followPlayer(playerName)` | A thin re-targeting wrapper over the pathfinder |
| `placeBlock(blockName, position)` | Building, plus a schematic loader |

They already have contract signatures, and `runAction()` already gives each of
them the pre-abort check the contract suite asserts for all six actions. So this
phase adds behaviour behind an interface that already exists — the same shape as
`explore_for`, which worked.

**What it is not.** The retry/failure policy and the prompt/menu entries for
these tools are Phase 5 **Track B**. `packages/agent/` deliberately codes no
per-`FailureReason` branching, and `ACTION_MENU` deliberately omits actions the
executor has not implemented. Track A lands the capability; Track B decides when
the model is told about it. Do not add menu entries here.

## 2. The reflex layer is first, and the arbiter is the actual work

The main design already specifies the interruption protocol (§3.5) and assigns
the arbiter to Track A. **It has never been built.** The evidence that it has not
is in CLAUDE.md: *"`runGoal` returns `interrupted` only on an outer abort. An
`interrupted` result without one means the reflex layer preempted — Phase 5, so
unreachable today."*

Everything the protocol needs already exists and is tested:

- `on('damaged' | 'health' | 'entityNearby')` — a push stream that survives
  reconnects and can be subscribed before the first `connect()`.
- `ActionOptions.signal` on every action, with resolve-not-throw semantics.
- `stop()` as an always-safe emergency brake, asserted idempotent by the
  contract suite.

So the reflex layer is assembly of parts that are individually proven, which is
why it goes first — and doing it first fixes the interrupt semantics *before*
`placeBlock` and `followPlayer` are written against them, rather than after.

### 2.1 Where the pieces live

| Piece | Package | Why |
|---|---|---|
| Trigger rules — pure predicates over `WorldSnapshot` | `packages/executor/` | Design §5 already plans them as pure functions over a fake snapshot: no Minecraft, no model, exhaustively testable |
| Recovery actions (`attack`, `flee`) | `packages/executor/` | Ordinary executor methods |
| **The arbiter** — subscribes, decides, preempts, hands back | `packages/bot/` | It needs the executor's event stream *and* the planner's `AbortController`, and `packages/bot/` is the only package allowed to depend on both. Putting it in `agent` would pull Mineflayer into the planning track transitively, which `check-invariants.mjs` fails on |

### 2.2 The one semantic that does not exist yet

`runGoal` currently cannot distinguish "the caller aborted me" from "the reflex
layer preempted me". Both surface as `interrupted`. The planner's correct
response differs: an outer abort means stop, a reflex preemption means **re-plan
from the new state** — the bot has moved, taken damage, and possibly fled.

This is Decision 1 in §7.

## 3. `attack` and `flee`

Both are underspecified in the contract, and neither can be implemented without
answering "when is it done?".

- **`attack(entityId)`** — swing at an entity. Open: is success one swing, or
  swing until the entity dies, or until it leaves range? Does it path into reach
  first (`GoalFollow`), and what happens when the entity moves? Which
  `FailureReason` covers "that entity no longer exists" — `not_found`, or
  `invalid_target`?
- **`flee()`** — flee *what*, *where*, and *for how long*? The design says only
  "low health → flee". Candidate: move to the safest reachable point at least N
  blocks from the nearest hostile, bounded by a timeout.

These need measurement against real mobs before they are specified, not after.
Which runs straight into §4.

## 4. **The dev server is peaceful. There are no hostile mobs to test against.**

CLAUDE.md records the backend as *"1.21.10, offline mode, survival + peaceful"*,
and that is confirmed against the running server rather than taken from the doc
— `difficulty` on the console answers **"The difficulty is Peaceful"** (checked
2026-09-09). On peaceful, hostile mobs do not spawn **and existing ones are
removed immediately**, including ones placed with `/summon`. So today there is no
way to exercise a single line of combat code against the live server.

This is the phase's biggest practical constraint and it is not a code problem.
Options, none of which Track A can choose unilaterally:

| Option | Cost |
|---|---|
| **A. Raise difficulty to `easy` on the dev backend** | Changes shared state. Hostiles would then spawn around anyone playing, and around every other integration test's bot. `/difficulty` is per-world and immediate |
| **B. Raise difficulty only for the duration of combat tests, restore after** | The arena is at y=199 in the open; mobs need light level and space, so spawning is not guaranteed where we want it. A test that silently gets no mob is the vacuous-fixture trap this repo has been bitten by twice |
| **C. Summon a specific mob at a known coordinate under `easy`, then restore** | Deterministic placement, which B lacks. Still needs the difficulty change, still shared state |
| **D. Test the reflex layer against synthetic events only** | No server change at all. The trigger rules are pure and the arbiter can be driven by a `MockExecutor` emitting `damaged`. Proves the arbitration, proves nothing about `attack`/`flee` actually working in-world |

**Track A's recommendation: D now, C later.** D covers the arbiter — the part
that is genuinely hard and genuinely ours — with no server change and no shared
state. C is what `attack`/`flee` eventually need, and it needs the server
decision in §7 Decision 2 before it can be planned honestly.

Doing D first also means the phase is not blocked on that decision at all.

## 5. `followPlayer`

The work-split note calls this "genuinely trivial; good pick for a quick win",
and the pathfinding half is — `GoalFollow` re-targets continuously and Phase 2
already owns the pathfinder.

The non-trivial half is that **`followPlayer` returns a `Promise<Result>`, so it
must terminate**, and the contract does not say when. `GoalFollow` never
finishes by itself. Candidates: until aborted; until within N blocks; until a
timeout. "Until aborted" makes it the only action in the contract that
*requires* a signal to ever return, which the planner's step budget would then
have to know about.

This is a gap in a **shared surface** doc comment, so it is Decision 3 and it
needs Ricky.

## 6. `placeBlock` and schematics

`placeBlock(blockName, position)` is a friendlier signature than Mineflayer's
`placeBlock(referenceBlock, faceVector)`, and the gap between them is the work:

- The executor must pick a **reference face** — an adjacent solid block to place
  against. A position floating in air with no neighbour cannot be built on, and
  that is a real, common failure.
- The block must be **in the inventory** and equipped first.
- The bot must be **in reach**, so this moves the bot, like `mineBlock`.

Failure mapping needs deciding: `invalid_target` for "nothing to place against",
`not_found` for "not in inventory", or a different split. Whatever is chosen must
not need a new `FailureReason` — that set is closed and shared.

**Schematics** are a loader over that: a list of `{dx, dy, dz, block}` relative to
an origin. The one non-obvious constraint is **placement order** — bottom-up, so
each block has support when it is placed. Anything else fails on the first
floating block. Scope: a saved list, per the work-split note. Not `.schem` /
`.litematic` parsing.

## 7. Decisions needed before implementation

### Decision 1 — how does the planner learn it was preempted? (Track A, but Track B feels it)

`interrupted` currently means both "you aborted me" and "the reflex layer
preempted you". Options: a distinct `FailureReason` (**no** — that set is closed
and shared, and widening it is a contract change); an `interrupted` result plus
a flag on the goal outcome; or the arbiter re-invoking the planner itself so the
distinction never reaches it. Track A's lean is the third — the arbiter owns the
handback, and the planner just sees a fresh state.

### Decision 2 — the dev server's difficulty (needs Dorel; it is shared state)

Per §4 and CLAUDE.md's standing rule not to reconfigure the server without
asking. Recommendation: leave it peaceful, build the arbiter against synthetic
events, and revisit when `attack`/`flee` are actually being written.

### Decision 3 — when does `followPlayer` return? (needs Ricky; shared surface)

Per §5. This is a documented-guarantee gap in `packages/contract`, which is the
one surface the project's central rule protects. It is additive clarification
rather than a signature change, but it still needs agreement.

## 8. Suggested order

1. **Trigger rules** — pure, exhaustively testable, no server. Start here.
2. **The arbiter**, driven by `MockExecutor` events. Proves preemption end to end
   with no live mobs and no server change.
3. **`followPlayer`**, once Decision 3 lands.
4. **`placeBlock` + schematic loader** — the largest, and independent of the rest.
5. **`attack` / `flee`**, once Decision 2 lands.

## 9. Testing strategy

Nothing here changes the three-layer discipline, but two Phase 4 lessons apply
directly and are worth stating before they are re-learned:

- **`scripts/` and `demo:*` are outside `npm test`.** Phase 4 broke `bench:world`
  and `demo:phase2` while the whole sweep stayed green. A Phase 5 demo must be
  run, not assumed.
- **Prove each guard can fire.** Every new reflex trigger needs a test that shows
  it firing, and the contract suite's existing "resolves interrupted when
  pre-aborted" assertion must keep passing for all six actions as they stop being
  stubs.

The reflex layer specifically is testable without a server at all: trigger rules
are pure, and `MockExecutor` can emit `damaged` on demand. That is the phase's
best property and the plan should lean on it.

## 10. Risks

1. **Combat is untestable on the current server** (§4). The largest risk, and it
   is environmental rather than technical.
2. **The arbiter is concurrency**, which this repo has already been bitten by —
   `connect()`/`disconnect()` races produced the `pendingConnect` machinery. Two
   signals, a handback, and a reflex firing *during* recovery all need explicit
   rules rather than discovery.
3. **`placeBlock` moves the bot**, so it inherits every arrival-verification
   lesson from Phase 2 — `goto()` resolving on a zero-length path meant "resolved"
   never implied "arrived", and `mineBlock` reported success from 8.6 blocks away
   before `gotoGoal` verified the world afterwards.
