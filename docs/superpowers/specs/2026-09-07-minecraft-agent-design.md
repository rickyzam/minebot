# Minecraft AI Agent — Design

**Date:** 2026-09-07
**Status:** Awaiting review
**Source notes:** [`docs/notes/`](../../notes/) — architecture, phase plan, and feasibility are settled there and are not relitigated here.

This spec covers the decisions the notes left open: the exact shared contract, the
repository structure, and the testing strategy. It is the document both tracks build
against.

---

## 1. Scope

Build a tool-calling LLM agent that plays Minecraft as a bot on a real server, per
`docs/notes/Minecraft AI Agent.md`. This spec defines Phase 0.5 — the shared contract
and project skeleton — plus the Phase 1 slice. Phases 2–6 are planned in the notes and
get their own implementation plans.

**Out of scope for now:** multi-bot orchestration (Phase 6), blueprint library
(Phase 5), any vision-based perception (rejected in the notes).

## 2. Environment (verified 2026-09-07)

| | |
|---|---|
| Host | 16-core/32-thread desktop CPU, 32GB RAM, 16GB consumer GPU, headless Linux |
| Dev server | Fabric **1.21.10**, local, `localhost:25565` |
| Dev world | seed `openfield`, survival + peaceful, `online-mode=false`, `allow-flight=true` |
| LLM | Ollama on `:11434` — `qwen3:14b` (9.3GB, tools) is the default target |
| Node | v24.18.0, npm 11.16.0 |

The production survival world shares port 25565 and must be stopped while the dev
server runs. Only one can be up at a time.

## 3. The shared contract

The notes correctly identify this interface as the crux of the two-track plan. The
sketch there had three gaps that would surface painfully at Phase 3 integration. All
three are fixed below.

### 3.1 Gap 1 — nothing was cancellable

The reflex layer's stated job is to *interrupt whatever the LLM's current plan is*,
but every action returned a bare `Promise<Result>` with no abort path. Mining or
pathing takes many seconds; a drowning bot cannot wait for `mineBlock()` to finish.

**Fix:** every action accepts an `ActionOptions` bag carrying an `AbortSignal`.

**Contract rule:** on abort, an implementation MUST *resolve* with
`reason: 'interrupted'` — it MUST NOT throw. Interruption is an expected outcome, not
an error, and Track B's retry policy has to distinguish it from failure. Making it a
resolved value forces explicit handling instead of letting it vanish into a `catch`.

### 3.2 Gap 2 — `Result` was referenced but never defined

Phase 4's entire retry/failure policy depends on this shape. "No coal nearby" (search
wider), "unreachable" (pick a different target), and "interrupted" (resume later) are
three different decisions and must be distinguishable.

**Fix:** a discriminated union with a closed set of failure reasons. The executor
reports *facts*; the agent decides *policy*. Deliberately no `retryable` flag — that is
policy, and it belongs to Track B.

### 3.3 Gap 3 — `getState()` was a synchronous dump of a mutating world

Two problems. It returned a live object that changes mid-use, so an LLM prompt could be
serialized from a state that never existed. And it offered no way to *react* to change —
the reflex layer needs push notification of damage, not polling.

**Fix:** split observation into two channels matching the architecture's own layering.

- `getState()` stays synchronous but returns an **immutable point-in-time snapshot**
  (Mineflayer keeps a live world model in memory, so this is cheap). Pull-based, for the
  planning layer.
- `on(event, handler)` provides a **push event stream**. For the reflex layer.

**Additional refinement found while designing:** the sketch's `nearbyBlocks` field
cannot work as a state dump — a 16-chunk radius is on the order of 10^5 blocks, which
fits in no prompt. Replaced with a `findBlocks(query)` method that filters server-side.

### 3.4 The contract

```ts
// packages/contract/src/index.ts

export interface Vec3 { readonly x: number; readonly y: number; readonly z: number }

// ---------- Results ----------

export type Result<T = void> =
  | { readonly ok: true;  readonly value: T }
  | { readonly ok: false; readonly reason: FailureReason; readonly detail: string }

export type FailureReason =
  | 'not_found'      // no matching block/entity within range
  | 'unreachable'    // pathfinder could not reach the target
  | 'interrupted'    // aborted via signal (reflex layer or caller)
  | 'invalid_target' // unknown block/entity name, malformed args
  | 'missing_tool'   // cannot harvest with current inventory
  | 'inventory_full'
  | 'timeout'
  | 'disconnected'
  | 'internal'       // bug or unexpected library error

export const ok  = <T>(value: T): Result<T> => ({ ok: true, value })
export const fail = (reason: FailureReason, detail = ''): Result<never> =>
  ({ ok: false, reason, detail })

// ---------- Cancellation ----------

export interface ActionOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

// ---------- Observation ----------

export interface WorldSnapshot {
  readonly takenAt: number          // Date.now() at capture
  readonly self: SelfState
  readonly nearbyEntities: readonly EntityInfo[]
}

export interface SelfState {
  readonly position: Vec3
  readonly health: number           // 0–20
  readonly food: number             // 0–20
  readonly dimension: string
  readonly onGround: boolean
  readonly inventory: readonly ItemStack[]
  readonly heldItem: ItemStack | null
}

export interface ItemStack {
  readonly name: string
  readonly count: number
  readonly slot: number
}

export interface EntityInfo {
  readonly id: number
  readonly name: string
  readonly kind: 'player' | 'hostile' | 'passive' | 'item' | 'other'
  readonly position: Vec3
  readonly distance: number
  readonly health?: number
}

export interface BlockInfo {
  readonly name: string
  readonly position: Vec3
  readonly distance: number
}

export interface BlockQuery {
  readonly names: readonly string[]  // e.g. ['coal_ore', 'deepslate_coal_ore']
  readonly maxDistance: number
  readonly limit: number
}

// ---------- Events (push channel for the reflex layer) ----------

export interface BotEvents {
  spawned:      Record<string, never>
  health:       { health: number; food: number }
  damaged:      { health: number; source: EntityInfo | null }
  entityNearby: { entity: EntityInfo }
  chat:         { username: string; message: string }
  death:        Record<string, never>
  disconnected: { reason: string }
}

export type Unsubscribe = () => void

// ---------- The executor ----------

export interface BotExecutor {
  connect(): Promise<Result>
  disconnect(): Promise<void>

  getState(): WorldSnapshot
  findBlocks(query: BlockQuery): readonly BlockInfo[]

  on<K extends keyof BotEvents>(
    event: K,
    handler: (payload: BotEvents[K]) => void,
  ): Unsubscribe

  moveTo(target: Vec3, opts?: ActionOptions): Promise<Result>
  followPlayer(playerName: string, opts?: ActionOptions): Promise<Result>
  mineBlock(
    blockName: string,
    maxDistance: number,
    opts?: ActionOptions,
  ): Promise<Result<{ position: Vec3; collected: boolean }>>
  placeBlock(blockName: string, position: Vec3, opts?: ActionOptions): Promise<Result>
  attack(entityId: number, opts?: ActionOptions): Promise<Result>
  flee(opts?: ActionOptions): Promise<Result>

  chat(message: string): void
  stop(): void   // halt movement immediately; always safe to call
}
```

Changes from the notes' sketch, for Track B's review: `attack` takes a numeric entity id
(Mineflayer's type, not a string); `nearbyBlocks` became `findBlocks()`; `connect`,
`disconnect`, `on`, and `stop` were added; every action gained `ActionOptions`;
`Result` is now defined.

### 3.5 Interruption protocol

Cancellation is only meaningful if something arbitrates. Priority: **reflex beats plan,
always.**

1. Track B's planner wraps each action in an `AbortController` and passes its signal.
2. Track A's reflex layer subscribes to `damaged` / `health` events. On a trigger rule
   (low health, hostile in range) it aborts the in-flight planned action, then runs its
   own recovery action under its own signal.
3. The aborted action resolves `{ ok: false, reason: 'interrupted' }`. The planner
   treats that as "re-plan from current state," not as a failure to retry blindly.

Track A owns the arbiter, since the reflex layer is Track A's. Track B's only
obligation is to handle `'interrupted'` distinctly.

## 4. Repository structure — npm workspaces

```
minebot/
├── package.json                 # workspaces root
├── tsconfig.base.json
├── packages/
│   ├── contract/                # types only, ZERO runtime deps
│   ├── mock-executor/           # shared test double  → deps: contract
│   ├── executor/                # TRACK A: mineflayer → deps: contract
│   └── agent/                   # TRACK B: ollama     → deps: contract, mock-executor
└── docs/
    ├── notes/                   # original design notes
    └── superpowers/specs/
```

The dependency direction is enforced structurally: `agent` cannot import `mineflayer`,
because it is not among its dependencies. The notes call the shared interface an
agreement; workspaces make it a constraint. This is the entire reason for the extra
setup.

**Ownership:** Track A owns `executor`. Track B owns `agent`. `contract` and
`mock-executor` are shared and change only by mutual agreement — a change there is a
change to the integration surface.

## 5. Testing strategy

Chosen approach is TDD. Track A builds the *real* executor, so its testing story differs
from Track B's; three layers:

**a. Contract tests (shared, highest value).** A single suite, exported from
`mock-executor`, that runs against *any* `BotExecutor`. Both the mock and the real
Mineflayer implementation must pass it. This is what actually guarantees the Phase 3
swap works — right now that swap is a hope, and this converts it into a test. Written
before either implementation.

**b. Pure logic unit tests (Track A).** The Phase 4 spiral/search strategy and the
reflex trigger rules are pure functions over a fake `WorldSnapshot`. No Minecraft, no
network, fast. This is where most Track A test value lives.

**c. Integration tests (Track A).** The real executor against the live dev server,
using `tmux send-keys` to set up reproducible scenarios (teleport, place a known block,
clear inventory). Slow and tagged separately from the default `npm test`.

**Runner:** Vitest — first-class TypeScript with no loader configuration, and workspace
support that matches the package layout.

## 6. Phase 1 slice (Track A)

Per the notes: connect, read state, walk to a fixed coordinate. Concretely —

1. Workspace skeleton, `contract` package, Vitest wired up.
2. Contract test suite written against the interface.
3. `mock-executor` implemented until the contract suite passes.
4. `executor`: `connect()`, `getState()`, `moveTo()` over raw Mineflayer movement — no
   pathfinder yet, per the notes.
5. Run the same contract suite against the real executor.

**Deliverable:** the bot logs into `localhost:25565`, prints a state snapshot, and
reaches a fixed coordinate.
**Verification:** watch from a second client, and confirm the printed snapshot matches
what is visible in-game.

## 7. Decisions log

| Decision | Choice | Rationale |
|---|---|---|
| Bot auth | Separate offline-mode dev server, port 25565 | Survival world untouched; flipping it to offline would rewrite player UUIDs |
| Language | TypeScript | Makes the cross-track contract compile-time enforceable |
| Structure | npm workspaces | Enforces dependency direction between tracks |
| Testing | TDD, contract-test suite shared across implementations | Converts the Phase 3 mock→real swap from hope into a test |
| Track A scope | Game execution | Mineflayer, executor, search, reflex layer |
| Track B scope | Agent / LLM | Ollama loop, prompts, parsing, retry policy |
| Model | `qwen3:14b` | Matches the notes' 14B-class sizing; 9.3GB fits 16GB VRAM with headroom |
| Cancellation | `AbortSignal`, resolve-not-throw | Reflex layer must preempt; interruption is an outcome, not an error |

## 8. Open questions

1. **qwen3 thinking mode.** `qwen3:14b` advertises a `thinking` capability. Reasoning
   traces inflate latency and can wrap JSON in prose, which fights structured output.
   Track B should test with thinking disabled first. Not blocking Track A.
2. **Ollama native tool-calling vs. hand-rolled JSON.** All four local models report
   `tools=true`. The notes assume a hand-parsed JSON action format; native tool-calling
   may be more reliable. Track B's call, resolvable at Phase 3.
3. **`qwen3:30b-a3b` as an alternative.** MoE with ~3B active params — potentially
   faster per decision than the dense 14B — but 18.6GB exceeds 16GB VRAM and would spill
   to system RAM. Worth benchmarking at Phase 6, not before.

## 9. Contract changes proposed after Phase 1 — AGREED AND APPLIED

**Status: all four applied at the start of Phase 2**, agreed with Track B beforehand per
§4. This section is kept as the record of what changed and why; it is no longer a list of
pending proposals. Nothing here is outstanding.

Phase 1's final review surfaced four gaps in `BotExecutor`. All were additive, and all
would have grown more expensive once Track B had code depending on the old shapes — so
they were settled before the planning loop was built, while `packages/agent/` did not yet
exist.

1. **`on()` subscriptions did not survive a reconnect.** *Applied.* The executor now owns
   a long-lived emitter; `connect()` wires a bot into it and `disconnect()` unwires. `on()`
   works before the first connect and across reconnects, so the reflex layer can subscribe
   once at startup and keep hearing about damage for the session's lifetime.

   Two things surfaced in review and are part of the guarantee: the executor registers its
   unexpected-disconnect watch *before* wiring events, so a `disconnected` subscriber
   observes the executor as already not-connected (otherwise a handler reacting by calling
   `connect()` hits the already-connected guard, silently no-ops, and reports success); and
   `emit()` isolates each handler in a `try`/`catch`, so one throwing subscriber cannot
   break the emitter or the connect path.

2. **`mineBlock` could not target a block `findBlocks` returned.** *Applied* as
   `mineBlock(target: string | Vec3, maxDistance, opts?)`. A name still searches for the
   nearest match; a position names one block exactly, which makes the
   search-choose-approach-mine loop expressible. `maxDistance` bounds the search for a
   name and bounds travel for a position.

3. **`MockExecutor` could produce only three of the nine `FailureReason` values.**
   *Applied* as `MockOptions.failures` plus `setFailure(action, failure | null)` for
   driving fail-then-succeed sequences on a live mock. All nine reasons are now producible,
   asserted by test. Injection is checked *after* the abort and disconnected rules, never
   before, so it cannot be used to fake a contract violation.

4. **`connect()` was not reentrant.** *Applied.* A pending-promise guard makes concurrent
   `connect()` calls share one attempt instead of creating a second bot (a duplicate login
   on an offline-mode server, which kicks the first). `disconnect()` during an in-flight
   `connect()` now cancels it and tears down, rather than silently no-opping.

   Review note worth keeping: the disconnect-honouring check belongs *inside* the shared
   promise, not in the per-caller wrapper. Outside it, `disconnect()` could return while
   `pendingConnect` was still set, so a `connect()` in that window resolved `ok` against a
   disconnected executor — and a caller *sharing* an attempt got a different answer from
   the mock than from the real executor.

### Known gaps in the shared contract suite

The suite is strong on freezing, snapshot distinctness, the pre-abort rule for all six
actions (and for both `mineBlock` target forms), `stop()` cancellation, disconnected
behaviour, and `findBlocks` non-emptiness and ordering. The §9 work added: subscription
lifetime (registered while disconnected, surviving a reconnect, and staying unsubscribed
across one), isolation of a throwing subscriber, and `connect()` reentrancy.

It does **not** verify: mid-flight cancellation (timing-dependent, deliberately left to
per-implementation tests), or `nearbyEntities`' documented 32-block radius — that last one
has a unit test, but the fixture cannot actually fail if the radius filter were removed,
because the count cap masks it. Also, `ContractSuiteContext.expectFindable` is optional and
its test silently no-ops when absent, so a future implementation that forgets to declare it
regresses to a vacuous pass with no signal.

One caveat carried over from the §9 review, worth remembering when adding cases: a suite
test that asserts an executor still *works* after some operation tends to pass against the
mock no matter what, because a duplicate or skipped attempt has no observable cost there.
Where the guarantee is "only one thing happened," assert on something observable through
the interface — an event firing exactly once, say — rather than on the executor merely
still being usable.
