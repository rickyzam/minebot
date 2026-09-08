# Perception: line of sight — Design and Contract Change

**Date:** 2026-09-08
**Status:** AGREED. Track B (Ricky) agreed §4, §6.3 and §6.4 in full on 2026-09-08. Not yet implemented.
**Affects:** `packages/contract/` (doc guarantee), `packages/mock-executor/` (suite + mock), `packages/executor/` (implementation)
**Supersedes nothing.** This restores a guarantee the design already claims.

## 1. The problem, in one sentence

`findBlocks` returns blocks that are entirely encased in solid rock, so the bot
has X-ray vision.

## 2. Why this is a bug, not a change of direction

The main design spec's §1 already states the intended behaviour, in the sentence
the whole perception/action split rests on:

> **`findBlocks` is perception.** Synchronous, free, and limited to what the
> client already has loaded. It answers "what can I see from here?"

The implementation honours the first half — it is limited to loaded chunks — and
ignores the second. It answers "what *exists* near here." Mineflayer's
`bot.findBlocks` is a query over the client's world model with no visibility
test of any kind, and nothing downstream added one.

So this is a defect measured against our own stated contract. It is not a new
requirement, and agreeing it is not a renegotiation of scope.

## 3. The evidence

Measured 2026-09-08 at the Phase 4 benchmark world, `(2343, 72, 2625)`, standing
on the surface in plains:

| Measurement | Value |
|---|---|
| Natural `coal_ore` within 64 blocks | **3219** |
| …of those, touching a non-solid block (visible from *anywhere*) | **1** |
| Position of that one | 27 blocks below the bot, inside a cave |
| `mineBlock` on it, holding a stone pickaxe | `unreachable: no path to the target` |
| `exploreFor(['coal_ore'], 64)` — travelled | **0.0 blocks** |
| `exploreFor(['coal_ore'], 64)` — elapsed | **0.0s** |
| `exploreFor(['coal_ore'], 64)` — found | 8, nearest 8.5 blocks away, all buried |

The bot does not move, because it "sees" coal under its own feet. Every one of
those hits is unactionable: movement is non-destructive by design
(`Movements.canDig = false`, Phase 2), so the planner's only possible follow-up
is `mine_block`, which returns `unreachable` forever.

This is the oscillation Phase 3 fought, with a root cause nobody had named.

## 4. The rule

**Perception is limited to what the bot could see from where it is standing.**
Telemetry may inform movement and physics; it may not inform what the bot knows
exists.

Concretely: a block is perceivable when a ray from the bot's eye position
reaches it before hitting anything else. Facing direction is deliberately
ignored — a player can turn their head, and making perception depend on yaw
would produce results that flicker as the pathfinder steers.

The reference model is a human player. Standing on a plain you can see the grass
surfaces around you; you cannot see the dirt beneath them, the ore inside the
hill, or the cave under your feet. Ore in an exposed cliff face you *can* see.

## 5. Implementation

Mineflayer already provides the exact primitive. `bot.canSeeBlock(block)`
(`lib/plugins/blocks.js:229`) raycasts from `position + eyeHeight` to the block
centre and returns true only when the ray's first hit is that block.

### 5.1 Two stages, because the raycast is not free

1. **Exposure pre-filter (cheap, necessary condition).** A block with all six
   faces against solid blocks cannot be seen from anywhere, ever. Six
   `blockAt` lookups, no raycast. At the benchmark start this reduces 3219
   candidates to 1 before any raycast runs.
2. **Line of sight (exact).** `canSeeBlock` on whatever survives stage 1.

Stage 1 is an optimisation and a *necessary* condition only. It is not the rule
— a block exposed to a sealed cavern passes stage 1 and correctly fails stage 2.

### 5.2 The nearest-first trap

This is the part most likely to be got wrong, so it is called out explicitly.

`findBlocks(names, maxDistance, limit)` returns the `limit` **nearest** matches.
Filtering that result for visibility returns nothing whenever the nearest
`limit` blocks are buried — even when a perfectly visible one sits 20 blocks
away. At the benchmark start, a limit of 8 returns 8 buried blocks and filtering
yields zero, which is a *worse* lie than the current behaviour: "there is no
coal here" rather than "there is coal here you cannot reach."

So the implementation must **over-fetch, then filter, then truncate to `limit`**
— not filter the truncated list. The over-fetch bound needs measuring; it cannot
be unbounded, because the underlying query cost scales with it.

### 5.3 Cost is unmeasured

`findBlocks` is documented as synchronous and free, and the planner calls it
freely on that basis. A two-stage filter over a few thousand candidates is
probably single-digit milliseconds, but that is a guess and must be measured
before this lands. If it turns out expensive, the honest options are a smaller
over-fetch bound (accepting some misses) or making the cost visible in the
contract — **not** quietly leaving perception synchronous while it takes 200ms.

## 6. What changes, and what does not

### 6.1 Does NOT change

- `exploreFor`'s signature, `ExploreOptions`, `ExplorationReport`, and all five
  contract-suite guarantees agreed on 2026-09-08. It inherits the fix through
  `findBlocks` and needs no edit.
- `findBlocks`' signature or return type.
- `moveTo`, `mineBlock(Vec3, …)`, the reflex layer, the `FailureReason` set.

### 6.2 Does change

| Surface | Change |
|---|---|
| `packages/contract` `findBlocks` doc comment | State the visibility guarantee explicitly, so it is a promise rather than an aspiration in a spec |
| `packages/mock-executor` contract suite | New shared guarantees (§6.3) |
| `packages/mock-executor` `MockOptions` | A way to seed a block as not-visible — the mock has no geometry and cannot compute this |
| `packages/executor` | The two-stage filter, in a pure module with its own unit tests |

### 6.3 Proposed contract-suite guarantees

1. A block seeded/known to be enclosed is **not** returned by `findBlocks`.
2. A block seeded/known to be exposed **is** returned.
3. Ordering, `limit`, and the disconnected-throws behaviour are unchanged.
4. `exploreFor` never reports a block `findBlocks` would not have returned from
   the same position — i.e. exploration cannot see further than perception.

### 6.4 Mock support

`MockExecutor` has no world geometry, so visibility cannot be derived. Proposal:
an optional `visible?: boolean` on seeded blocks, defaulting to `true`, so
existing Track B tests are unaffected and new ones can exercise both paths. This
is additive and backwards-compatible; it is listed here because `MockOptions` is
shared surface and additive changes still need agreement (spec §9 precedent).

## 7. GATE — what Track B needs to agree — SATISFIED

- [x] The rule in §4, including that facing direction is ignored.
- [x] The four contract-suite guarantees in §6.3.
- [x] The `MockOptions.visible` addition in §6.4.
- [x] That `findBlocks` returning **fewer** results is the intended outcome and
      not a regression, including where it returns none at all.

**Agreed by Ricky on 2026-09-08.**

The gate stays in this document rather than being deleted, for the same reason
the Phase 4 gate does: the record of *when and by whom* a change to the shared
surface was agreed is the thing main-spec §9 exists to preserve.

**This agreement covers §4, §6.3 and §6.4 as written.** Anything discovered
during implementation that changes the rule, the guarantees, or the mock's
surface is a new agreement, not a detail — stop and ask rather than adjusting
the contract to fit the code. In particular, if §5.3's cost measurement forces
`findBlocks` to stop being synchronous-and-free, that is a new agreement.

## 8. Impact on Track B

Expected to be an improvement, not a cost. The planner currently receives
thousands of unreachable targets for any buried resource, picks one, gets
`unreachable`, and retries — the exact loop the stuck-guard and the prompt merge
were built to suppress. Removing the bogus results removes the cause rather than
the symptom.

Two things Ricky should expect:

- `find_blocks` for coal in real terrain will usually return **empty**, which is
  the honest answer and the one design §1 assumed all along. The paired
  `find_blocks` / `explore_for` rule in Phase 4 Task 7 becomes meaningful
  instead of vacuous.
- Probe scenarios seeded with visible blocks are unaffected; any seeded with
  blocks that would be buried in a real world will need revisiting.

## 9. Consequences for Phase 4 Track A

- Tasks 1–6 stand. The contract method, the pure waypoint core, the benchmark
  world, the executor implementation, the integration tests and the scored
  baseline are all unaffected in shape.
- The benchmark's `emerald_block` target exists **only** to dodge this bug: a
  `coal_ore` target was found at the origin without the bot moving, so the run
  scored perception rather than search. Once this lands, coal becomes a usable
  target again. The synthetic target is still worth keeping for the
  *mechanism* benchmark, because it is deterministic; coal becomes the
  *realism* benchmark.
- Design §8 risk 1 ("a horizontal spiral may simply not find coal") becomes
  answerable for real, and §3's measurement predicts the answer: with 1 of 3219
  coal blocks visible-from-anywhere, a surface spiral will usually report
  `exhausted` with nothing found. That is an honest result which points at
  digging and cave-following as the next capability — on evidence rather than
  assumption.
- Tasks 7–8 need re-planning regardless; see the Phase 4 plan.

## 10. Forward compatibility with memory

A memory subsystem is planned (see
[`docs/notes/Memory and Recall.md`](../../notes/Memory%20and%20Recall.md)). It
consumes exactly what this change produces: *what was perceived, from where,
at what time*.

So the executor-side filter should be written as a pure module that yields
observations carrying that provenance, even though the contract's `findBlocks`
continues to return plain `BlockInfo[]` for now. Getting the internal shape
right costs nothing today; retrofitting it would mean touching `findBlocks`,
`exploreFor` and the contract a second time.

**Flagged as a likely future contract change, not proposed here:** `BlockInfo`
may eventually want `seenFrom` / `seenAt`. Raising it now so it is not a
surprise later.

The invariant that binds the two designs together: **memory may only be written
from perception output, never from the raw world model.** Otherwise the X-ray
hole reopens through the back door — the bot "remembering" a structure it never
saw.
