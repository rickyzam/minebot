# Perception: line of sight — Design and Contract Change

**Date:** 2026-09-08
**Status:** AGREED for §4, §6.3 and §6.4 (Ricky, 2026-09-08). **IMPLEMENTED
2026-09-08** under §7.1 option A, on Dorel's instruction to proceed. §7.1 remains
open for Ricky to confirm the *cost wording* — it changes no signature, guarantee
or behaviour, so it did not block the code. 310 unit tests and 101 integration
tests green.
**Affects:** `packages/contract/` (doc guarantee), `packages/mock-executor/` (suite + mock), `packages/executor/` (implementation)
**Supersedes nothing.** This restores a guarantee the design already claims.

> **Amended 2026-09-08, after measurement.** §3, §5.1, §5.2 and §5.3 were written
> before the cost measurement existed. All four have been corrected against real
> data from the live server (`npm run bench:perception`). The corrections are
> marked in place rather than silently applied, because §3 was the evidence Ricky
> was shown when agreeing. **§4, §6.3 and §6.4 — the agreed text — are unchanged.**
> The direction of every correction is the same: the bug is real and the case for
> fixing it is *stronger*, but it costs materially more than this document assumed.

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
| Natural `coal_ore` within 64 blocks | **3216** |
| …of those, touching air or cave_air | **50** |
| …of those, touching **any** non-solid block (air, cave_air or water) | **60** |
| …of those, actually visible from the bot's eye (`canSeeBlock`) | **0** |
| `mineBlock` on the nearest, holding a stone pickaxe | `unreachable: no path to the target` |
| `exploreFor(['coal_ore'], 64)` — travelled | **0.0 blocks** |
| `exploreFor(['coal_ore'], 64)` — elapsed | **0.0s** |
| `exploreFor(['coal_ore'], 64)` — found | 8, nearest 8.5 blocks away, all buried |

The bot does not move, because it "sees" coal under its own feet. Every one of
those hits is unactionable: movement is non-destructive by design
(`Movements.canDig = false`, Phase 2), so the planner's only possible follow-up
is `mine_block`, which returns `unreachable` forever.

This is the oscillation Phase 3 fought, with a root cause nobody had named.

> **Correction, 2026-09-08.** This table originally claimed **1** coal block
> touched a non-solid neighbour. Re-measured with `npm run bench:perception --
> --detail`, the real figure is **60** — 50 touching air or cave_air, 10 more
> touching only water. The original number was off by 60×, and it was the number
> §5.1 built its cost argument on, so the error propagated.
>
> The conclusion does not merely survive the correction, it strengthens. The
> earlier table conflated "touching a non-solid block" with "visible", which are
> different claims — §5.1 itself says so. Running the actual raycast, **0** of
> those 60 are visible from the bot's eye. So the honest answer at the benchmark
> start is not "one distant coal in a cave" but "no coal at all", and the bot
> currently reports eight. The gap between what the bot claims to see and what it
> can see is total, not near-total.
>
> The 3219 → 3216 difference is chunk-load variance between runs and is not
> significant.

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

### 5.1 Two stages — and what the pre-filter is actually worth

1. **Exposure pre-filter (cheap, necessary condition).** A block with all six
   faces against solid blocks cannot be seen from anywhere, ever. Six
   `blockAt` lookups, no raycast.
2. **Line of sight (exact).** `canSeeBlock` on whatever survives stage 1.

Stage 1 is an optimisation and a *necessary* condition only. It is not the rule
— a block exposed to a sealed cavern passes stage 1 and correctly fails stage 2.
The benchmark start is exactly that case: 60 coal blocks pass stage 1 and **all
60 fail stage 2**. Shipping stage 1 alone would replace "8 unreachable hits"
with "8 different unreachable hits", not with the truth.

> **Correction, 2026-09-08.** This section originally justified stage 1 by
> claiming it "reduces 3219 candidates to 1 before any raycast runs". Both halves
> are wrong. It reduces 3216 to 60 (§3), and the saving that buys is far smaller
> than assumed, because **the raycast is usually cheaper than the pre-filter**:
>
> | Target, r=64 | exposure + LOS | LOS with no pre-filter | Pre-filter saves |
> |---|---|---|---|
> | `coal_ore` (3.7k candidates) | 322ms | 335ms | ~4% — noise |
> | `stone` (302k candidates) | 891ms | 1431ms | 38% |
>
> The reason is geometry, not implementation. `canSeeBlock` raycasts from the eye
> and stops at the **first** solid hit. For a bot standing on a plain looking at
> buried ore, that first hit is the ground a block or two away, so the ray is
> short and costs about what six `blockAt` lookups cost. Stage 1 only pays when
> the candidate set is huge enough that even a cheap per-candidate test dominates.
>
> **Keep stage 1** — it wins big in the pathological case and costs at most a
> fraction of a millisecond when it does not help (measured: `grass_block` 2.3ms
> with it vs 2.2ms without, `emerald_block` 138.8 vs 138.5). But do not size the
> design around it, and do not describe it as the thing that makes this
> affordable. It is not.

### 5.2 The nearest-first trap — and why no over-fetch bound is needed

*(Free of a tuning parameter, not free of cost. The cost is §5.3.)*

The trap is real and worth stating plainly, because it is the failure mode a
naive implementation lands in:

`findBlocks(names, maxDistance, limit)` returns the `limit` **nearest** matches.
Filtering *that array* for visibility returns nothing whenever the nearest
`limit` blocks are buried — even when a perfectly visible one sits 20 blocks
away. That is a *worse* lie than today's behaviour: "there is no coal here"
rather than "there is coal here you cannot reach."

> **Correction, 2026-09-08.** This section originally concluded that the
> implementation must **over-fetch, then filter, then truncate**, with an
> over-fetch bound to be tuned. That is not necessary. Reading Mineflayer's
> source (`lib/plugins/blocks.js`) shows the filter can go **inside** the search,
> which avoids the trap by construction and needs no bound at all.

`bot.findBlocks` takes **two** predicates, and they are invoked at very
different rates:

| Hook | Where | Invoked |
|---|---|---|
| `matching` | `blocks.js:130`, then `blocks.js:182-188` | Once per **palette entry** per section as a section-skip test, then once per **block in the volume** for every section that survives. Per-volume. |
| `useExtraInfo`, **when passed a function** | `blocks.js:146-149` | `matcher(block) && useExtraInfo(block)` — the `&&` short-circuits, so only on blocks that **already matched by type**. Per-candidate. |

`useExtraInfo` is therefore the correct home for the visibility test, and putting
it there fixes the trap outright, because it runs *upstream of the count*:

- `blocks.push` is gated on it (`blocks.js:185`), so only survivors accumulate.
- The early break reads `blocks.length >= count` (`blocks.js:193`), so **`count`
  counts survivors**, not candidates.
- The final truncation (`blocks.js:203`) slices an already-filtered,
  distance-sorted list.

The result is the `limit` nearest **visible** blocks — exactly the semantics this
section asked for, with no over-fetch bound to pick, tune, or get wrong.

Three supporting details, all verified rather than assumed:

- The block handed to `useExtraInfo` comes from `bot.world.getBlock`, which sets
  `block.position` (`prismarine-world/src/worldsync.js:102`), so both the
  six-face test and `canSeeBlock` have the position they need.
- The palette section-skip **still runs** on this path. The bypass at
  `blocks.js:178` tests `useExtraInfo === true`, strictly against the boolean, and
  a function is not `true`. Sections with no matching block in their palette are
  still skipped; only real type-matches pay for the visibility test.
- `useExtraInfo?: boolean | ((block: Block) => boolean)` is already in
  `mineflayer/index.d.ts:601`, and `canSeeBlock` is synchronous
  (`world.raycast` on the sync world). No cast, no `async`.

**Do not put the visibility test in `matching`.** Besides being per-volume, it is
also called at `blocks.js:130` on `Block.fromStateId(stateId, 0)` — a synthetic,
**positionless** block used only to test the section palette. A position-dependent
predicate there is not merely slow, it is meaningless, and returning `false`
would skip the entire section.

### 5.3 Cost — measured, and it fires the §7 trigger

Measured 2026-09-08 at the benchmark start with `npm run bench:perception`,
median of 5 reps, `maxDistance=64`, `limit=8`. Stable across two independent runs.

| Target | in volume | exposed | visible | baseline (today) | exposure only | **exposure + LOS** |
|---|---|---|---|---|---|---|
| `coal_ore` | 3216 | 60 | 0 | **1.0ms** (8 hits) | 76.8ms (8 hits) | **322ms** (0 hits) |
| `emerald_block` | 3 | 3 | 1 | **73.4ms** (3 hits) | 140.6ms (3 hits) | **139ms** (1 hit) |
| `stone` | 258333 | 8302 | 0 | 1.1ms (8 hits) | 25.2ms (8 hits) | **891ms** (0 hits) |
| `grass_block` | 12304 | 12304 | 658 | 1.0ms (8 hits) | 1.7ms (8 hits) | **2.3ms** (8 hits) |

By radius, for the two targets that matter to Phase 4:

| Target | r=16 | r=32 | r=64 |
|---|---|---|---|
| `coal_ore` baseline | 1.0ms | 1.0ms | 1.0ms |
| `coal_ore` honest | 23ms | 75ms | **330ms** |
| `emerald_block` baseline | 5.3ms | 17.6ms | 73.4ms |
| `emerald_block` honest | 8.0ms | 30.6ms | **140ms** |

**The verdict: 322ms at r=64 is over the 200ms line this section itself drew.**
The trigger in §7 has fired. See §7.1.

#### 5.3.1 Reading the numbers — the cost is scarcity, not the filter

The 1.0ms → 322ms jump looks like the filter is 300× expensive. It is not, and
misreading this would lead to optimising the wrong thing.

`findBlocks` walks an octahedron of 16³ sections outward and **stops early only
when it has accumulated `count` hits** (`blocks.js:193`). That gives two
completely different cost regimes:

- **Target abundant near the bot** — the count is satisfied in the first section
  or two, a few thousand blocks are scanned, and the call costs ~1ms.
- **Target scarce** — the count is *never* satisfied, so the entire volume is
  walked. At r=64 that is 350k–920k blocks at roughly 0.21µs each, i.e. **75–165ms
  before any filtering happens at all**.

So the honest split of coal's 322ms is roughly **160ms of volume walk plus 160ms
of filtering** — not 1ms of walk plus 321ms of filter.

Two consequences follow, and the second is the important one:

1. **Perception is already not free today.** `emerald_block` at r=64 costs
   **73.4ms in main**, with no filtering of any kind, purely because the target is
   scarce. The contract's "synchronous and free" is already false for scarce
   targets; `bench:explore` has been paying this cost every run without anyone
   measuring it. Line-of-sight roughly **doubles** that cost — it does not
   introduce it.
2. **Honest perception converts abundant targets into scarce ones.** Coal is
   cheap today *only* because it is abundant-and-buried, so the early break fires
   immediately. Telling the truth about coal makes it scarce (0 visible), which
   moves the query from the ~1ms path onto the full-scan path. That is the entire
   300× jump, and it will happen to **every** buried resource — iron, copper,
   diamond, redstone — not just coal.

The corollary for anyone tempted to optimise: the ceiling on this cost is set by
`maxDistance`, which the *planner* chooses, not by how clever the filter is.
r=32 costs a quarter of r=64.

#### 5.3.2 The over-fetch route, measured for comparison

§5.2's original proposal was measured alongside, so the choice rests on numbers:

| Target, r=64 | over-fetch(512) + filter | in-search (`useExtraInfo`) |
|---|---|---|
| `coal_ore` | 46ms, 0 hits | 322ms, 0 hits |
| `emerald_block` | 75.5ms, 1 hit | 139ms, 1 hit |
| `grass_block` | 7.3ms, 8 hits | 2.3ms, 8 hits |

Over-fetch is cheaper for scarce targets, for the same reason it is wrong: it
stops after 512 *candidates* rather than after 8 *survivors*, so it never pays for
the full walk — and correspondingly can miss a visible block sitting past the 512th
nearest buried one. **In this world that failure did not manifest**: both routes
returned the same results on all four targets, because 0 coal is visible at all,
so there is nothing for over-fetch to miss. The difference is structural and
remains unmeasured here; it is not evidence that over-fetch is safe.

Recommendation stands with the in-search route: it is correct by construction,
has no bound to tune, and its cost is dominated by a volume walk that the
over-fetch route also pays whenever the target is scarce *and* the bound is high.

#### 5.3.3 The shipped implementation costs what the prototype predicted

Re-measured through the public contract method after wiring, same conditions.
The prototype above measured raw Mineflayer calls; this is what a caller pays:

| Target, r=64 | prototype | `executor.findBlocks` |
|---|---|---|
| `coal_ore` | 341ms | **339ms** |
| `emerald_block` | 146.6ms | **146.6ms** |
| `stone` | 895ms | **909ms** |
| `grass_block` | 2.4ms | **2.4ms** |

Within noise. The executor's adapter and `BlockInfo` mapping add nothing
measurable, so the numbers quoted throughout this section are the real ones.

### 5.4 What to build

1. A pure module in `packages/executor/` — per §10, yielding observations with
   `seenFrom` / `seenAt` provenance even though `findBlocks` still returns plain
   `BlockInfo[]`.
2. Visibility folded into `findBlocks` via `useExtraInfo`, not applied to the
   returned array, and **not** in `matching`.
3. Exposure test first, `canSeeBlock` second, per §5.1 — retained despite its
   modest measured value.
4. Whatever §7.1 concludes about making the cost visible in the contract.

### 5.5 What implementation turned up

Three things that were not predicted here, all found by the tests rather than by
reasoning, and all now covered:

1. **Three of the contract suite's four `expectFindable` names stopped being
   findable.** That fixture exists so the suite's block assertions are not
   vacuous. Measured across three spawns: `stone` 213k present / **0 visible**,
   `dirt` 24k / **0 visible**, `deepslate` absent from the volume entirely (it
   had been contributing nothing all along). Only surface vegetation survives a
   visibility test from a bot standing on the surface. The list was narrowed to
   `grass_block` / `short_grass`. Relaxing the assertion instead would have been
   the "never weaken `runContractSuite`" mistake.
2. **The suite had a latent position-rot bug that honest perception exposed.**
   A bot's position persists in player data, the suite's own `exploreFor` tests
   walk it up to 32 blocks, and the new visibility fixture teleports it to an
   arena — so each test began wherever the *previous run* left off. Harmless
   while `stone` was the declared findable (it exists everywhere), fatal once the
   list was surface vegetation (it does not). The factory now teleports to a
   fixed surface start every test, which fixes the class rather than the symptom.
3. **Perception under-reports while chunks are still loading**, and more so than
   before. `isExposed` treats an unloaded neighbour as solid — deliberately, so
   the bot never claims to see through a chunk it does not have — so during load
   it reports "not exposed" for blocks in plain sight. The old unfiltered query
   needed only the block itself; the rule needs its neighbours too. This is a
   property of the rule, not a defect: the alternative is the X-ray hole again.
   The integration factory waits for perception and fails loudly if it never
   arrives.

Also re-grounded: the suite's `never lets searchedTo go backwards` test searched
for `stone` at radius 32. That returned instantly under X-ray; under honest
perception it walks the full spiral and exhausts its budget. It now uses the
factory's declared findable names.

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

## 7.1 SECOND GATE — ANSWERED 2026-09-08, except the regression.

> **Ricky's answers, 2026-09-08.** Recorded here because this section was the
> single index of what was open. Entry point is
> [PR #20](https://github.com/rickyzam/minebot/pull/20).
>
> | # | Decision | Answer |
> |---|---|---|
> | 1 | The cost budget, and that perception was never free | **Accepted** |
> | 2 | The contract doc wording | **Accepted as drafted** — already on the branch |
> | 3 | Option A / B / C / D | **A** — ship it, document the cost |
> | 4 | Prompt edit 1 — the paired `find_blocks`/`explore_for` rule | **Accepted as drafted** |
> | 5 | Prompt edit 2 — the `not_found` tail | **Accepted as drafted** |
> | 6 | Is `explore_for` the right answer to a dead position? | **Yes** |
>
> **One thing is still open, and it is not a wording preference.** Answer 6 makes
> the branch's measured behaviour wrong rather than merely unverified: the
> `not_found already` scenario answers `move_to` ×5, which is neither
> `explore_for` nor `give_up` and is forbidden by the rules two lines earlier.
> Edits 1 and 2 are accepted and stay, but they do not fix it. A candidate fix is
> drafted below under "The regression, and the candidate fix" — **unapplied and
> unmeasured**, because the probe is the only thing that can judge it.

**Status: code landed, gate answered, Option A confirmed.** The clause above fired —
§5.3's measurement puts honest perception at **339ms** for coal at r=64, against a
contract that called `findBlocks` "synchronous and free" and a planner that calls
it on that basis. It was implemented anyway on Dorel's instruction, under option
A, because it changes no signature, guarantee or behaviour: only whether a doc
comment tells the truth about a cost that already existed. **Ricky confirmed A on
2026-09-08**, so the doc comment already on the branch is the whole of A's
implementation and no revert is needed.

Nothing here reopens §4, §6.3 or §6.4. The rule, the guarantees and the mock
surface are all unchanged.

### What Ricky is being asked to accept

1. **Perception is not free, and already was not.** `findBlocks` for a scarce
   target costs 73ms **today, in main**, with no line-of-sight filtering at all
   (§5.3.1). This is a pre-existing property of Mineflayer's octahedron walk that
   nobody had measured. The contract's wording was already wrong before this
   change was proposed.
2. **Line-of-sight roughly doubles the scarce-target cost**, and converts buried
   resources from the cheap regime into the scarce one. Budget: **~2ms** when the
   target is genuinely visible and abundant, **~75ms** at r=32, **~140–330ms** at
   r=64. Every buried ore lands at the top of that range.
3. **The contract doc comment stops saying "free".** Proposed replacement wording,
   for `packages/contract`:

   > Synchronous, and limited to what the bot can actually see from where it is
   > standing. Cost scales with `maxDistance` and with how *rare* the block is:
   > a common visible block costs ~1–2ms, a scarce or fully-buried one at
   > `maxDistance: 64` costs 100–350ms because the whole volume must be searched
   > before the answer "none" can be given. Prefer `maxDistance: 32` or less in a
   > loop.

### The options, with the numbers attached

| Option | Coal @ r=64 | Correct? | Cost to Track B |
|---|---|---|---|
| **A. Ship it, document the cost** (recommended) | 322ms | Yes | Prompt guidance to prefer r≤32 |
| B. Over-fetch bound (§5.3.2) | 46ms | No — can miss visible blocks past the bound | None, but reintroduces a lie |
| C. Cap `maxDistance` inside the executor | ~75ms @ 32 | Yes, but silently answers a different question than asked | Surprising: asks for 64, searches 32 |
| D. Make `findBlocks` async | 322ms | Yes | Large — changes the action loop's shape |

**Track A recommends A.** B trades a correctness bug for a smaller correctness
bug, which is the thing this whole document exists to stop. C hides the truncation
where no one can see it. D is a real change to the integration boundary for a
problem that is, in practice, a few hundred milliseconds inside a loop that
already spends seconds waiting on a model.

The one thing A costs Track B is prompt guidance: `find_blocks` at
`maxDistance: 64` is a ~1/3-second call and should not be issued speculatively in
a tight loop. That belongs in the system rules rather than the action menu, per
the measured finding in CLAUDE.md that menu wording moves nothing and rules
wording moves everything.

### Proposed prompt text — drafted, then MEASURED NOT TO WORK

> **Read this before the drafts below.** They were written as a plausible fix,
> then applied and measured. **They do not fix the regression they were meant to
> fix.** They are recorded here as a starting point and a record of what has
> already been ruled out — not as a recommendation.

The cost wording above is not abstract: it lands as prompt text in Track B's
package, in Phase 4 Task 7. Drafted here so the ask is one conversation.

Task 7 Step 4 already drafts a paired `find_blocks`/`explore_for` rule, and one
clause of it is now measurably false — *"it is instant and free"*. Two edits are
proposed. **Both are wording, so both are Ricky's.**

**Edit 1 — replace the first rule** (currently *"find_blocks is the only way to
locate one"*, which stops being true once `explore_for` exists):

```
- Blocks are NOT listed in the state. find_blocks looks around from where the bot
  is standing and reports only what it can actually SEE — ore buried inside rock
  is invisible to it, so an empty result is normal and does NOT mean the block is
  absent. If find_blocks comes up empty, use explore_for to go and look somewhere
  new; repeating find_blocks from the same spot cannot help.
- Keep find_blocks maxDistance at 32 or less. When it finds nothing it must
  search the whole area before it can answer, so a large radius is slow.
- After find_blocks, mine the exact block you found with mine_block_at.
```

**Edit 2 — the tail of the `not_found` rule**, which Task 7 did not anticipate.
It currently reads *"Search elsewhere with find_blocks, or give_up."* That named
the only two options at the time. It is now actively wrong: the bot has not moved,
so `find_blocks` sees exactly what it saw before, and `give_up` is premature.

```
  again — it cannot help. Go looking somewhere new with explore_for, or give_up.
```

This is a behaviour change, not a tidy-up. The probe's *"mine_block_at already
returned not_found"* scenario answers `give_up` 5/5 today; the intended answer
after this edit is `explore_for`. Task 7 Step 5 should assert that, and its
`hoped` list updated — otherwise the scenario keeps passing while measuring the
old behaviour.

Both edits belong in the **rules block, not the menu entry**: measured earlier in
this project, sharpening a menu entry moved nothing (5/5 unchanged) while
near-identical wording in the system rules flipped the answer outright (5/5).

### What happened when the drafts were measured — decisions 4, 5, 6

`qwen3:14b`, the probe's six scenarios, 5 attempts each, 30/30 decoded in every
state. Reproduce with `OLLAMA_HOST=... npm run agent:probe`.

| Scenario | baseline (7 actions) | + `explore_for` menu entry | + menu + both drafts |
|---|---|---|---|
| no history | `find_blocks` ×5 | = | = |
| after a search | `mine_block_at` ×5 | = | = |
| after missing_tool | `give_up` ×5 | = | = |
| mined but drop lost | `move_to` ×5 | = | = |
| **not_found already** | **`give_up` ×5** | **`move_to` ×5** | **`move_to` ×5** |
| goal met | `done` ×5 | = | = |

**Five of six scenarios are unmoved**, so a 14B model handles the larger menu
fine on size alone — that was the risk Task 7 Step 1 was written to check, and it
is not the problem.

**The sixth regresses, and into an action the rules forbid.** `move_to` on that
position is explicitly prohibited two lines earlier ("Do NOT move to or mine that
position again — it cannot help"). So the model is not picking a defensible
alternative; the earlier *"use move_to that position ONCE"* rule is beating the
later prohibition. That is the order-sensitivity Task 7 Step 4 is about, and it is
why Step 4 says to rewrite the pair **together** rather than adjacently.

**The drafts change nothing.** Still `move_to` ×5. One hypothesis, untested:
edit 1 grows the rules block from one line to seven and pushes the prohibition
further from the top, so it may be making things worse rather than merely failing
to help. Track A stopped here rather than iterating on wording by intuition —
that is what the probe exists to prevent, and this is Track B's package.

**This regression is on the branch, in commit 2 of PR #20, deliberately.**
Reverting it would have left nothing to reproduce. Commit 1 (perception) is
independent and can merge without it.

### Checklist — ANSWERED 2026-09-08

- [x] Perception is not free, and already was not (§5.3.1). **Accepted.**
- [x] The cost budget in point 2 above is acceptable for the planning loop.
      **Accepted** — ~2ms visible and abundant, ~75ms at r=32, 140–330ms at r=64.
- [x] The replacement doc wording. **Accepted as drafted**; it is already in
      `packages/contract/src/index.ts` on this branch.
- [x] Option A over B/C/D. **A.**
- [x] The §3 correction is noted — 60 exposed rather than 1, **0 visible** — and
      does not change the agreement already given. **Noted; agreement stands.**
- [x] Prompt edit 1 (the paired `find_blocks`/`explore_for` rule).
      **Accepted as drafted**, and stays on the branch. It does not fix the
      regression; that is now tracked separately below.
- [x] Prompt edit 2 (the `not_found` tail). **Accepted as drafted**, same.
- [x] Whether `explore_for` rather than `give_up` is the intended answer to a
      dead position. **Yes — `explore_for`.** `probe.ts` already encodes this as
      `hoped: ['explore_for', 'give_up']`; `give_up` stays acceptable only
      because a goal can be genuinely unachievable, not because standing still
      is a defensible answer to a dead position.
- [ ] **The regression itself** — STILL OPEN, and answer 6 sharpens it from
      "unverified" to "wrong". `not_found already` answers `move_to` ×5, an
      action the rules forbid and which the accepted edits do not correct.
      See below.

### The regression, and the candidate fix — UNAPPLIED, UNMEASURED

The accepted edits are on the branch and the regression survives them. The
remaining hypothesis is **rule order**, not rule wording: the permission

> `- "OK (drop collected: false)" means … Use move_to that position ONCE to walk
>    over the item and pick it up.`

sits immediately **above** the prohibition that forbids exactly that move once
the position is finished. Nothing in either bullet is false; the model is
reaching past the later prohibition to the earlier permission. Adding
`explore_for` to the menu is what tipped it — the regression appeared with the
menu entry **alone**, before either edit was applied.

Candidate: state the terminal condition **first** and qualify the permission, so
the two bullets stop competing. Swaps order, changes no fact:

```
- A position is FINISHED once you have already moved to it and the item is still
  not in your inventory, or once mining it returns not_found. Do NOT move to or
  mine a finished position again — it cannot help. Go looking somewhere new with
  explore_for, or give_up.
- "OK (drop collected: false)" means the block IS broken and its item is lying on
  the ground at that position. Mining it again will fail — there is nothing left
  to mine. If you have NOT already tried, use move_to that position ONCE to walk
  over the item and pick it up.
```

**This is not on the branch and must not be committed unmeasured.** The branch
deliberately holds the reproducible regression and a known-good baseline;
replacing it with an unprobed guess would destroy both. One
`OLLAMA_HOST=… npm run agent:probe` run decides it, and the bar is the
`not_found already` row answering `explore_for` while the other five scenarios
stay unmoved.

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
  instead of vacuous. Measurement has since made "usually" concrete: at the
  benchmark start it returns empty **always**, because 0 of 3216 nearby coal
  blocks are visible (§3).
- Probe scenarios seeded with visible blocks are unaffected; any seeded with
  blocks that would be buried in a real world will need revisiting.
- **New, from the cost measurement (§5.3):** an empty answer is the *expensive*
  one. `find_blocks` can only report "none" after searching the whole volume, so
  a fruitless call at `maxDistance: 64` costs ~1/3 second while a fruitful one
  costs ~1ms. This inverts the usual intuition and is the reason §7.1 asks for
  prompt guidance to prefer `maxDistance: 32` or less.

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
  answerable for real, and §3's measurement predicts the answer: with **0 of 3216**
  coal blocks visible from the start, a surface spiral will report `exhausted`
  with nothing found. That is an honest result which points at digging and
  cave-following as the next capability — on evidence rather than assumption.
  (The original text said "1 of 3219 … will *usually* report exhausted". The
  corrected census removes the hedge.)
- **The `emerald_block` fixture partially collapses under honest perception, and
  Tasks 7–8 must account for it.** Measured: the 3 placed markers at 48 blocks
  are all exposed, but only **1** is visible from the start, at 49.1 blocks. The
  other two are occluded by terrain. So the deliberate three-bearing design —
  east, north-west, south-west, chosen so no single direction is privileged —
  degrades to effectively one bearing at *t=0*. It is not broken: `exploreFor`
  moves, and the other two come into view as it travels, which is arguably the
  more realistic test. But any Task 7–8 assertion of the form "the bot can see a
  target on each bearing from the start" is false and would need the markers
  re-sited, not merely re-counted.
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
