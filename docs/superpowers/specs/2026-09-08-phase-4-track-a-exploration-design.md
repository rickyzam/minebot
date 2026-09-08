# Phase 4 (Track A) — Exploration Design

**Date:** 2026-09-08
**Status:** proposed. §3's contract change needs Track B agreement before any of it lands.
**Blocked by:** nothing. Phase 3 is merged and the loop closes end to end.

## 1. The problem

Every success so far has been against an ore placed in plain sight, 12 blocks away. In a real world `find_blocks` returns empty, and **the model has no action that helps** — the menu is search / move / mine / chat / done / give_up. Its only correct move is `give_up`.

So "reliable find and mine coal" is not yet a retry-policy problem. It is a missing capability. Phase 4 Track A builds it.

The distinction that matters, and which the whole design turns on:

- **`findBlocks` is perception.** Synchronous, free, and limited to what the client already has loaded. It answers "what can I see from here?"
- **Exploration is action.** It moves the bot, takes real time, and can fail. It answers "go and look."

Conflating them is the main design risk: a model that thinks searching is free will spam it, and a model that thinks it is instantaneous will not reason about the cost.

## 2. Why this shape (and what was rejected)

Three shapes were considered.

**A. One long-running `searchFor` that returns when it finds something.** Rejected. A single action could run for minutes, which makes the loop's step budget meaningless and hides every interesting decision from the planner — the exact step-log evidence Phase 4 Track B exists to study.

**B. `explore_step(direction)`, one increment per model turn.** Rejected. It burns steps fast, and it asks a 14B model to run a spiral search by hand — spatial bookkeeping is the thing it is worst at. Track B's measurements already show it struggling with far simpler state (it re-mined a block it had been told was gone, twice).

**C. Bounded, resumable, progress-reporting search.** Chosen. The executor owns the algorithm, so the interesting logic stays in Track A where it is testable without a model. Each call is bounded in time, so steps stay observable and cancellable. And the decision the model is left holding — *keep looking, or give up?* — is precisely the judgment Phase 4 Track B wants to study.

The cost of C is a real contract change: a new method and a new result type.

## 3. The contract change — GATE

`packages/contract/` and `packages/mock-executor/` are the shared surface. **Nothing in this design may land before Track B agrees §3 in full.** Spec §4 and CLAUDE.md both require it, and spec §9 records the precedent: four changes held back until agreed, then applied as one unit.

### 3.1 The method

```ts
  /**
   * Go and look for blocks that are not currently visible.
   *
   * Unlike `findBlocks`, which is free perception over already-loaded chunks,
   * this is an *action*: it moves the bot, consumes real time, and can fail.
   *
   * Returns as soon as it finds anything matching, or when `budgetMs` is spent,
   * or when there is nowhere left to look within `maxDistance` — whichever
   * comes first. A call that finds nothing is `ok` with an empty `found`, not a
   * failure: "I looked and there was nothing here" is a successful search.
   *
   * Resumable by design. Calling it again continues outward from where the last
   * call stopped rather than starting over, so a caller can spend more effort
   * incrementally instead of committing to one unbounded search.
   */
  exploreFor(
    names: readonly string[],
    maxDistance: number,
    opts?: ExploreOptions,
  ): Promise<Result<ExplorationReport>>
```

### 3.2 The types

```ts
export interface ExploreOptions extends ActionOptions {
  /**
   * How long to spend looking before reporting back. Defaults to 20_000.
   * Bounding this is what keeps a step observable and the step budget
   * meaningful; an unbounded search would swallow the whole run.
   */
  readonly budgetMs?: number
}

export interface ExplorationReport {
  /** Matches found, nearest first. Empty means "looked, found nothing". */
  readonly found: readonly BlockInfo[]
  /**
   * True when there is nowhere left to look within `maxDistance`. This is the
   * difference between "spend more time" and "spending more time cannot help",
   * and it is the whole reason the search is resumable rather than one-shot.
   */
  readonly exhausted: boolean
  /**
   * How far from the search origin has actually been covered, in blocks. Lets
   * a caller judge progress and decide whether widening is worthwhile.
   */
  readonly searchedTo: number
  /** Blocks travelled during this call. The cost of the search, reported. */
  readonly travelled: number
}
```

### 3.3 Failure reasons

No new `FailureReason` values. The closed set already covers it:

| Reason | When |
|---|---|
| `interrupted` | aborted by the caller or by `stop()` — the contract rule applies unchanged |
| `disconnected` | not connected |
| `invalid_target` | a name the block registry does not know, checked before moving |
| `internal` | anything unexpected |

`not_found` is deliberately **not** used: an empty search is `ok`. Reserving `not_found` for "that specific thing is not there" keeps it meaningful for `mineBlock`.

### 3.4 What `MockExecutor` must do

The mock is Track B's whole world, so it needs a faithful `exploreFor`:

- Return blocks from its configured list that lie within `maxDistance`.
- Support `MockOptions.exploreDelayMs` so Track B can exercise a slow search.
- Track `searchedTo` across calls so **resumability is testable without a server** — a second call must not re-report the first call's ground.
- Honour failure injection (`setFailure('exploreFor', …)`), preserving the existing precedence: abort rule first, disconnected second, injection third.

### 3.5 Contract-suite additions

Behavioural guarantees, asserted against both implementations:

1. An already-aborted signal resolves `interrupted` before any work.
2. Disconnected resolves `disconnected`, never throws.
3. A search that finds nothing resolves `ok` with `found: []` — **not** a failure.
4. `exhausted: true` implies a subsequent identical call also returns `exhausted: true` and does no further work.
5. `searchedTo` never decreases across successive calls with the same origin.

## 4. The algorithm

### 4.1 A pure core, following `harvest.ts`

The decision — *given where I started and where I have already looked, where next?* — is a pure function over plain data. It goes in `packages/executor/src/explore.ts`, with no `mineflayer` import and no network, exactly as `harvest.ts` did for harvestability.

```ts
export interface SearchState {
  readonly origin: Vec3
  /** Waypoints already visited and searched from. */
  readonly visited: readonly Vec3[]
  readonly maxDistance: number
  /** Distance between ring waypoints. See §4.2. */
  readonly spacing: number
}

/** The next place worth standing, or null when the space is exhausted. */
export function nextWaypoint(state: SearchState): Vec3 | null

/** How far from the origin the visited set has actually covered. */
export function searchedRadius(state: SearchState): number
```

This is where most of the test value lives, and it is testable exhaustively in milliseconds.

### 4.2 The strategy: an expanding horizontal spiral

Waypoints on rings of increasing radius around the origin, at the bot's current elevation. At each waypoint the executor calls its own `findBlocks`, which is free.

**Spacing is the load-bearing parameter.** `findBlocks` at a waypoint covers a sphere of radius `R`. Waypoints spaced further than `2R` apart leave unsearched gaps between them; spaced much closer, the search re-covers ground and wastes travel. Spacing must be derived from the perception radius, not guessed — and §5.1 tests coverage directly rather than trusting the arithmetic.

Deliberately **horizontal only, and non-destructive**. Descending, digging down, and cave-following are later increments. Two reasons for that boundary:

1. Digging is destructive, and Phase 2 established movement as non-destructive on purpose. Introducing a digging search deserves its own design, not a footnote in this one.
2. A horizontal spiral is sufficient to make the capability real and measurable. If it turns out insufficient for coal specifically, that is a finding worth having *before* building something more elaborate.

### 4.3 The executor shell

`exploreFor` is another `runAction` body, so it inherits cancellation, timeout and the resolve-never-throw rule for free. Per waypoint: check the budget and the signal, `moveTo` the waypoint, `findBlocks` there, and return early on any match.

An `unreachable` waypoint is **skipped, not fatal** — a blocked direction is a normal fact about terrain, not a failed search. This is where PR #14's arrival verification and #15's bounded `searchRadius` earn their keep: without them, an unreachable waypoint would report a false arrival or burn 5 seconds of the budget reporting `timeout`.

## 5. Testing discipline

The harder half of this design, and the reason to build it before the algorithm. **The floating arena cannot test search.** Its whole virtue is being empty and known; search is about the unknown.

Four tiers, in descending order of value per second spent.

### 5.1 Pure unit tests over a fake world — most of the value

`nextWaypoint` and `searchedRadius` are pure. Assert:

- **Coverage.** Every point within `maxDistance` falls within perception radius of some generated waypoint. This is the property that makes the search correct, and it is checkable by enumeration rather than argument.
- **Termination.** The waypoint sequence is finite and `nextWaypoint` eventually returns `null`.
- **Monotonicity.** Waypoints are generated nearest-first, so a nearby ore is found before a distant one.
- **Resumability.** Feeding the visited set back in continues rather than restarting.

No Minecraft, no network, instant.

### 5.2 Synthetic arena with known ore — the cost metric

A large flat platform, ore placed at coordinates the *test* knows and the *bot* does not. This is not cheating: ground truth for the assertion, unknown to the subject.

Assert not merely "found it" but **how expensive it was**: blocks travelled and wall-clock to reach a target at a known distance. A pass/fail search cannot be improved; a search with a cost number can.

`/fill` caps at 32768 blocks, so a large platform needs chunked fills — and, per CLAUDE.md, a fixture that can silently no-op is worse than none, so the builder must verify its own floor before any test trusts it.

### 5.3 Fixed natural terrain, read-only — the reproducibility trick

Real terrain cannot be built, and the shared world cannot be reseeded. But there is a property that makes this work anyway:

> **Search does not modify the world.** It only moves and looks.

So a fixed, remote region of the existing world is a *reproducible* natural-terrain fixture, as long as the test only searches and never mines. Terrain is deterministic given the seed, and nothing in the test changes it.

Assert a bound rather than a path: *coal found within N blocks travelled from a fixed start*. Asserting an exact route would rot the moment anything about pathing changed.

The standing risk is a human mining there. Document the coordinates as reserved, and treat a sudden failure as "check whether someone dug it up" before assuming a regression.

### 5.4 Termination on a barren region

The failure I would fear most is not a bad search — it is one that never stops. An explicit test on a region with no coal at all, asserting `exhausted: true` within the budget.

### 5.5 What this deliberately does not test

Whether the *model* explores sensibly. That is Track B, measured through `agent:probe` with an `explore_for` scenario, and it cannot be assessed until the action exists.

## 6. The menu action (Track B's side, proposed here because it is joint)

```json
{"action":"explore_for","names":["coal_ore","deepslate_coal_ore"],"maxDistance":64}
```

The prompt must make the perception/action distinction unmissable, and Track B's own measurements say **where** that text goes decides whether it works:

- The rules block is order-sensitive, and a conflicting earlier rule beats a correct later one (measured while fixing the `not_found` oscillation).
- Guidance about *when* to choose something belongs in the rules, not the menu entry.

So the `find_blocks` entry and the `explore_for` entry must be written together, as one coherent instruction — not as two descriptions that happen to sit near each other. Suggested shape: *`find_blocks` looks around from where you are and is free; `explore_for` walks around looking and is slow. Use `explore_for` only when `find_blocks` found nothing.*

## 7. Not in scope

- **Digging or descending to search.** §4.2. Its own design when the horizontal spiral proves insufficient.
- **Cave-following.**
- **Retry policy.** Phase 4 Track B, against the step logs this produces.
- **Any change to `mineBlock`, `moveTo`, or the reflex layer.**

## 8. Risks

1. **A horizontal spiral may simply not find coal.** Coal is common but not reliably surface-exposed. This is the design's central bet, and §5.3 is what will tell us — early, and before anything more elaborate is built on top.
2. **Search is slow.** Each waypoint is a real walk. A 64-block search could take minutes of wall clock, which is fine for a demo and awkward for a test suite. §5.2's cost metric is what turns that from a complaint into a number.
3. **The contract grows.** `BotExecutor` gains a seventh action and Track B gains a menu entry. Ricky's measurement — that a bigger toolbox is a real test of whether a 14B model stays reliable at tool selection — applies directly, and the probe should be re-run across *all* scenarios after the menu changes, not just the new one.
4. **`spacing` is a guess until §5.1 runs.** Derived from the perception radius, but the coverage test is what makes it true rather than plausible.
