# Phase 5 (Track A): the full toolbox — reflex, follow, building

**Date:** 2026-09-09
**Status:** AGREED 2026-09-11 (Ricky, PR #22), with `flee` counter-proposed and adopted. One detail is still open — flee's distance and timeout, blocking only Task 6b. Not started.
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

## 4. Combat testing: the constraint is daylight, not difficulty

The server runs Peaceful — CLAUDE.md says so and the console confirms it
(`difficulty` answers *"The difficulty is Peaceful"*, checked 2026-09-09). On
Peaceful, hostile mobs do not spawn and existing ones are removed immediately,
so nothing combat-related can be exercised without changing it.

**RESOLVED 2026-09-09: Dorel granted standing permission to change the difficulty
and restart the server as needed.** So the constraint is not permission. What
remains is a set of measured facts about what a hostile mob actually does once
summoned, and those change the arena design rather than the plan.

### 4.1 Measured on the live server, 2026-09-09

| Measurement | Result |
|---|---|
| `difficulty` before any change | **Peaceful** |
| `difficulty easy` then `summon zombie` at the y=199 arena | Summoned, present at 3s |
| The same zombie 30s later | **Gone** |
| Re-run with `{PersistenceRequired:1b}` and a name, watching the console | **`"TestZed" burned to death` at 21 seconds** |

So the failure is **daylight**, not despawn, and `PersistenceRequired` does not
help — it prevents despawn, not fire. An undead mob on an open-sky platform is
dead in about twenty seconds, which is shorter than a single pathfinding leg.

This was nearly misdiagnosed. `time query daytime` returned 14806 — night — a few
minutes before the summon, so the first disappearance was written off as despawn.
The clock had simply advanced into daylight by the time the second zombie was
summoned. **Read the death message, not the clock**: the server states the cause
outright, and it is the only thing here that distinguished burning from despawn.

### 4.2 What this means for the arena

Combat tests need a hostile that survives long enough to be fought. Options:

| Option | Verdict |
|---|---|
| **Roof the combat arena** | **Recommended.** Local, deterministic, changes no global state, and `buildArena` already fills a volume — a ceiling is one more `/fill`. Nothing outside the arena is affected |
| `time set midnight` + `doDaylightCycle false` | Works, but it is global: it changes the sky for anyone playing, and any test that assumes daylight |
| Use a mob that does not burn (spider, creeper) | Spiders are neutral in daylight, so the trigger being tested would not fire. Creepers do not burn but explode, which destroys the arena |
| Fire resistance / `NoAI` on the summoned mob | `NoAI` stops it attacking, so it cannot exercise the reflex layer at all |

**A roofed arena plus `difficulty easy` for the duration of the test, restored
after.** That gives a deterministic mob at a known coordinate, no daylight, and
no lasting change to the shared world.

### 4.3 Sequencing still favours synthetic events first

Even with combat now testable, the arbiter should still be built against
`MockExecutor` events emitting `damaged` on demand. Not because the server is
blocked — it is not — but because the arbiter is concurrency (§10 risk 2) and
deserves exhaustive, instant, deterministic tests before a live mob with its own
AI is added to the picture. Live combat then tests `attack`/`flee`, not the
arbitration.

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

## 7. Decisions — all three answered

### Decision 1 — how does the planner learn it was preempted? — ANSWERED 2026-09-09

**It already does, and Track B built it.** `packages/agent/src/loop.ts:160-168`
falls through and re-plans on an `interrupted` result whenever no outer signal
was aborted, with a comment naming §3.5 and warning never to retry the
interrupted action against the snapshot it was chosen for. So the arbiter can be
a plain `BotExecutor` decorator: no new `FailureReason`, no new flag, no change
to `packages/agent`. The original framing below is kept because the options it
rejected are still the wrong answers.

*Original framing:* `interrupted` currently means both "you aborted me" and "the reflex layer
preempted you". Options: a distinct `FailureReason` (**no** — that set is closed
and shared, and widening it is a contract change); an `interrupted` result plus
a flag on the goal outcome; or the arbiter re-invoking the planner itself so the
distinction never reaches it. Track A's lean is the third — the arbiter owns the
handback, and the planner just sees a fresh state.

### Decision 2 — the dev server's difficulty — ANSWERED 2026-09-09

Dorel granted standing permission to change difficulty and restart the server.
No longer a blocker. §4.1 replaces it with measured facts: the real constraint
was never permission, it was that an undead mob burns to death in 21 seconds on
an open-sky arena. §4.2 settles that with a roof.

### Decision 3 — the four methods' guarantees — ANSWERED 2026-09-11 (Ricky, PR #22)

Decision 3 was bundled with the rest of Task 0 into one ask. Five rows accepted,
one accepted with its policy deferred, one counter-proposed, plus `setHealth()`.

| Method | Agreed | Changed from the proposal? |
|---|---|---|
| `followPlayer` | Follows **until aborted**. `timeoutMs` honoured **when passed**, **no default**; elapsing resolves `ok` | **Yes** — the proposal had a 30_000 default |
| `placeBlock` | `not_found` — block not in inventory | No; the policy is deferred |
| `placeBlock` | `invalid_target` — no adjacent face, or target occupied | No |
| `placeBlock` | `unreachable` — cannot path within reach | No |
| `attack` | One swing, then `ok`; `not_found` if the entity id is gone | No |
| `flee` | **`Result<{ fled: boolean }>`, `ok` either way** — `fled: false` when there was no hostile | **Yes — a return-type change** |
| `MockExecutor.setHealth()` | Test affordance | No |

No new `FailureReason`. Nothing in `packages/agent` changes in Task 0.

**`followPlayer` — the consequence Ricky asked to have recorded.** "Follows until
aborted" is what the action means. But `loop.ts:143` dispatches with only
`controller.signal`, and `timeoutMs` appears nowhere in `packages/agent`
(verified 2026-09-11) — the planner never bounds an action. So without a
`timeoutMs`, `followPlayer` blocks `runGoal` until something aborts it, and in
Phase 5 the only thing that will is the reflex arbiter. **A peaceful follow never
returns.** Bounding it is Track B's: either the planner passes `timeoutMs`, or it
guarantees something aborts.

**`flee` — why the counter-proposal is right.** "Nothing to flee from" is the
safest outcome, not a failure, and reporting it as one costs twice: the reflex
path hits it as a race whenever a hostile dies or despawns between trigger and
call, and once `flee` reaches the menu the failure lands in a step log where this
project has repeatedly measured the model over-reacting. `mineBlock`'s
`collected` is the precedent — *"mining succeeded, and that fact must not be lost
by reporting a failure."* Ricky owns the `prompt.ts` renderer, so `{ fled }` does
not reach the model as `[object Object]`, the bug `ExplorationReport` hit.

**Still open, blocking only Task 6b:** flee *where* and *for how long*. §3 leaves
N and the timeout unspecified, and unagreed, the implementation picks them.
Track A proposes a 12-block candidate circle and a 10_000ms bound (plan Task 6b).

**`placeBlock` → `not_found` — the policy, deliberately deferred.** Ricky's
eventual intent is that "out of dirt" and `missing_tool` both produce *go and get
more* — check the relevant chest, then gather from a designated area. That is
prompt policy and belongs to Phase 4 Track B. It is not encoded now because the
contract has **no container actions** and **"designated area" does not exist**
anywhere in the repo: a model told to fetch would pick something, fail, and pick
again. The two reason codes stay distinct because they are distinct facts.

**A correction to the rationale Track A gave for `not_found`.** The ask cited
Track B's probe answering `give_up` 5/5 after `missing_tool`. That scenario
(`after missing_tool, inventory empty`) has an **empty inventory** and a `hoped`
answer of `give_up` — it shows the model giving up with `missing_tool` *and*
nothing to work with, which is what the scenario was written to want. It does not
isolate `missing_tool` as the cause. The row stands on its reasoning; the
citation was weaker than it read and should not be re-cited as evidence.

**Two things Track A verified while recording this — both change the plan.**

- **`setTimeout(fn, Infinity)` fires after ~2ms in Node** (measured
  2026-09-11: the delay overflows and clamps, with only a
  `TimeoutOverflowWarning`). `runAction` arms its timer unconditionally
  (`mineflayer-executor.ts:747-751`), so "no default" implemented as a default of
  `Infinity` would make `followPlayer` report `timeout` almost at once — and the
  same bug already reaches any action whose caller passes `timeoutMs: Infinity`.
  `runAction` also maps its own timer to `fail('timeout')` (`:757-760`), while the
  agreed rule resolves `ok` on elapse. Plan Task 3 handles both.
- **Movement can build.** `Movements` defaults `allow1by1towers = true` with
  `scafoldingBlocks = [dirt, cobblestone]` (`movements.js:31, 75-77`), and the
  executor overrides only `canDig` (`mineflayer-executor.ts:431-433`). Ricky
  flagged it, and it checks out. It has never bitten because no test, demo or
  script has ever given a bot dirt or cobblestone. `placeBlock` will — a bot told
  to place its last dirt can pillar on it while pathing, then fail `not_found` for
  a block it had. Plan Task 4 handles it.

### 7.1 Follow-on scope — agreed in PR #22, NOT Phase 5 Track A

None of it blocks anything here.

1. **A designated-area allowlist, enforced in the executor** — one concept serving
   both "never build over a player's base" and "gather from here". Enforcement,
   not inference: world data carries no player-placed flag, and crafted-block
   heuristics misfire on generated villages, which is exactly where a base might be.
2. **Incoming chat into `WorldSnapshot`, and a build-confirmation flow** — Phase 5
   Track B. `BotEvents.chat` already exists; what is missing is a snapshot field
   and a renderer. A goal has no requester today, an unanswered question must be
   bounded, and the default on no answer must be *do not build* — building over a
   base is irreversible, not building is not. **The asking must not be the safety
   mechanism:** this project watched a prompt rule fail four times before a change
   to what the model *checks* worked. Allowlist enforces; asking is courtesy.
3. **Retry and failure policy**, including "go get more" for `not_found` and
   `missing_tool` — Phase 4 Track B, unstarted.
4. **Scaffolding** — overhangs, where bottom-up ordering does not save you, and
   safe self-removal of a tower the bot is standing on. Freestanding mid-air
   placement is a named Phase 5 limitation.

## 8. Suggested order

1. **Trigger rules** — pure, exhaustively testable, no server. Start here.
2. **The arbiter**, driven by `MockExecutor` events. Proves preemption end to end
   with no live mobs and no server change.
3. **`followPlayer`**, once Decision 3 lands.
4. **`placeBlock` + schematic loader** — the largest, and independent of the rest.
5. **`attack` / `flee`** against a roofed arena under `difficulty easy`,
   restored to `peaceful` after. No longer gated on anything.

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

1. **Combat needs a roofed arena** (§4.2). Measured, not assumed: an undead mob
   on the open y=199 platform burns to death in 21 seconds. A combat test built
   on the existing arena would lose its mob mid-run and read as the bot failing.
2. **The arbiter is concurrency**, which this repo has already been bitten by —
   `connect()`/`disconnect()` races produced the `pendingConnect` machinery. Two
   signals, a handback, and a reflex firing *during* recovery all need explicit
   rules rather than discovery.
3. **`placeBlock` moves the bot**, so it inherits every arrival-verification
   lesson from Phase 2 — `goto()` resolving on a zero-length path meant "resolved"
   never implied "arrived", and `mineBlock` reported success from 8.6 blocks away
   before `gotoGoal` verified the world afterwards.
