# Track B — The LLM Planning Loop — Design

**Date:** 2026-09-07
**Status:** Awaiting review
**Builds on:** [`2026-09-07-minecraft-agent-design.md`](./2026-09-07-minecraft-agent-design.md) — the binding
contract. This document does not relitigate it. It specifies `packages/agent/`, the
work the phase plan calls *"Meanwhile — Track B works ahead"*, which runs parallel to
Phases 1–2 and is the second input to Phase 3.

---

## 1. Scope

From [`docs/notes/Phase Plan and Parallel Work Split.md`](../../notes/Phase%20Plan%20and%20Parallel%20Work%20Split.md):

> Set up the Ollama client call. Design the prompt/tool schema. Build the
> parsing/validation layer. Test this whole loop against the **mock** `BotExecutor`.
> **Deliverable:** a script that takes a fake game state and produces a validated
> action, with zero dependency on a live Minecraft connection.

This spec delivers that, plus the loop that runs it repeatedly toward a goal.

**In scope:** `packages/agent/` — the LLM transport, the action menu and its schema,
prompt rendering, decode and validation, dispatch to `BotExecutor`, and the goal loop
with its termination guards.

**Out of scope, deliberately:**

| Not here | Where it belongs |
|---|---|
| The reflex/safety layer and the interruption arbiter | Track A (design spec §3.5) |
| Coded per-`FailureReason` retry policy | Phase 4 |
| Chat-driven goals, blueprint building, combat judgement | Phase 5 |
| Multi-step plan queues | Not planned; see §11 |
| Verification against a real model | Deferred — see §2 |
| **Any change to `contract/` or `mock-executor/`** | Nowhere. See §9. |

## 2. Environment

The model runs on another machine on the LAN: **Ollama 0.33.3 at `192.168.1.21:11434`**,
holding `qwen3:14b` (9.3GB, Q4_K_M) alongside `qwen3:30b-a3b`, `qwen2.5-coder:14b` and
`llama3.2:3b`. It is reachable from the development machine, so the measurements in §2.1
are real rather than deferred.

`OLLAMA_HOST` and `MINEBOT_MODEL` configure the client; the defaults are
`http://127.0.0.1:11434` and `qwen3:14b`, so a colocated setup needs no configuration and
this one sets `OLLAMA_HOST`.

**`npm test` still never opens a socket.** That was forced when no endpoint existed; it is
now a deliberate discipline, and the more important for being optional. A reachable box is a
standing temptation to write tests that depend on a machine being up, and this repo already
separates its server-dependent tests into their own Vitest project for exactly that reason.
Model behaviour is measured by `npm run agent:probe`, which reports numbers, and never by a
pass/fail unit test.

### 2.1 Measured model behaviour (2026-09-07)

Against `qwen3:14b` at temperature 0, five samples per cell, over five hand-built turns of
the coal scenario — no history, after a search, after a `missing_tool` failure, after a mine
that lost its drop, and after the goal was met.

| | Replies decoded | Median latency |
|---|---|---|
| **Schema-constrained, `think:false`** | **25/25** | **370ms** |
| Native tool-calling, `think:false` | 20/25 | 469ms |
| Schema-constrained, `think:true` | 10/10 | 7641ms |

Read these as consistency, not robustness: temperature 0 makes the model near-deterministic,
so `5/5` means "it does this every time," not "it survives rephrasing."

Five findings, each of which changed a decision below:

1. **Tool-calling fails on `done`.** All five of its rejections were the same case — asked to
   end the run, the model answers in prose instead of calling the tool, because "the goal is
   achieved" reads as a conversational conclusion rather than a function call. That is the
   *terminal* action; a loop that cannot reliably reach it always burns its full budget.
   This resolves design spec §8.2 — see §5.
2. **Thinking mode costs 20× latency and accuracy.** It also degraded turn 2, choosing a
   redundant `move_to` in 4 of 5 samples where `think:false` chose `mine_block_at` every
   time. Design spec §8.1 guessed `think: false`; the measurement is decisive.
3. **The menu wording is load-bearing.** A terse auto-generated menu produced a wasted
   `move_to` on turn 2 in 5 of 5 samples; the hand-written menu of §4, with JSON examples and
   the hint *"Prefer this after find_blocks"*, produced `mine_block_at` in 5 of 5. Same model,
   same temperature, same scenario. Prompt edits are behavioural changes and need re-probing.
4. **First call is cold.** 2884ms on the first request, ~370ms after. The three-layer
   architecture's premise — reflexes cannot wait for the planner — still holds, but the margin
   is far more comfortable than the notes' "multi-second" estimate.
5. **`collected: false` was misread**, and is now fixed. See §2.2.

### 2.2 Tuning the prompt (measured 2026-09-07, `probe.ts` at 5 samples per scenario)

The first implemented run reproduced §2.1 — 25/25 decoded, 359ms median — but got two of the
five scenarios wrong: handed `missing_tool` with an empty inventory it chose `chat` 5/5 rather
than `give_up`, and handed `collected: false` it chose to re-mine the block it had just
destroyed 5/5.

Both are now 5/5 correct. What fixed them is the finding worth keeping:

| Change | Scenario | Before | After |
|---|---|---|---|
| Sharpened the `give_up` **menu entry** (*"Prefer this over chatting about being stuck — chat does NOT end the run"*) | `missing_tool` | `chat` 5/5 | `chat` 5/5 — **no effect** |
| Added one line to the **system rules** (*"chat does NOT end the run and nobody is guaranteed to answer it. If you cannot make progress, choose give_up and say why."*) | `missing_tool` | `chat` 5/5 | **`give_up` 5/5** |
| Added a system rule explaining that `drop collected: false` means the block is already broken and the item is on the ground | drop lost | `mine_block_at` 5/5 | **`move_to` 5/5** |

**The rules block outweighs the menu description.** Near-identical wording placed in the menu
did nothing and placed in the rules flipped the answer completely, 5/5 both times. The menu
appears to be read as *what the actions are*; the rules as *what to do*. Guidance about **when**
to choose something belongs in the rules — putting it in the menu entry looks like it should
work and measurably does not.

The ineffective menu edit was reverted rather than kept. A change that measures as doing
nothing is not free: it is future wording that looks load-bearing and is not.

All five scenarios now answer correctly 5/5, at a 297ms median, with no regression in the three
that were already right.

## 3. Architecture — one action per turn

The loop is stateless per turn. Each iteration:

1. **Observe** — `executor.getState()`.
2. **Render** — build a fresh prompt from the goal, the snapshot, and a bounded tail of
   the step log.
3. **Decide** — send it to the model, constrained to the action schema; decode and
   validate the reply into one `ActionRequest`.
4. **Dispatch** — call the matching `BotExecutor` method under a per-step `AbortSignal`.
5. **Record** — append the step and its outcome to the log.

**The prompt is rebuilt each turn, not appended to.** There is no growing chat transcript.
Two reasons: token cost stays flat no matter how long a goal runs, and a transcript would
carry stale world state the model can anchor on — after an interruption the bot's old
position is a lie, and design spec §3.3 chose immutable snapshots precisely so a prompt is
never serialized from a state that never existed. Rebuilding preserves that guarantee at
the prompt layer.

**One action per turn, not a plan.** The architecture note describes the planning layer as
picking "the next goal/tool call from the full toolbox given current state," and the
interruption protocol (§3.5) assumes any single action can be preempted at any moment. A
multi-step plan queue would need invalidating on every interrupt, which is the same
re-planning cost with extra machinery. Rejected as YAGNI.

## 4. The action menu

The menu is **not** a mirror of `BotExecutor`. It is what the model is allowed to choose
from, which is a smaller and differently-shaped set.

```ts
export type ActionRequest =
  | { action: 'find_blocks'; names: string[]; maxDistance: number; limit: number }
  | { action: 'move_to'; x: number; y: number; z: number }
  | { action: 'mine_nearest_block'; name: string; maxDistance: number }
  | { action: 'mine_block_at'; x: number; y: number; z: number; maxDistance: number }
  | { action: 'chat'; message: string }
  | { action: 'done'; summary: string }
  | { action: 'give_up'; reason: string }
```

### 4.0 Why `give_up` exists

Probing (§2.1) showed the model, handed a `missing_tool` failure with a genuinely empty
inventory, choosing `chat("I need a pickaxe to mine coal ore")` in 5 of 5 samples. That is a
sensible read of the situation and a dead end: with no way to say the goal is unreachable, the
run then grinds on to `budget_exhausted` or `stuck`, and neither distinguishes *"impossible,
and here is why"* from *"the loop malfunctioned"*.

`give_up` is `done`'s twin — a terminal action carrying the model's own reason, surfaced as the
`gave_up` outcome. The phase plan lists *"when does it escalate, retry with a wider radius, or
give up and report back"* as explicitly Track B's question; this is the smallest thing that
makes the last of those expressible. It also stops roughly a dozen wasted model calls per
impossible goal.

It is deliberately **not** folded into `done` with a success flag. The probe shows `done` being
chosen correctly and reliably, and conflating "achieved" with "abandoned" at the schema level
puts that at risk for no gain.

### 4.1 Why `find_blocks` is an action the model chooses

`WorldSnapshot` contains no blocks at all. Design spec §3.3 measured why: a 16-chunk radius
is on the order of 10^5 blocks, which fits in no prompt. Blocks are reachable only by
asking for specific ones.

Exposing that as an action is what makes the search → choose → approach → mine sequence
expressible, and it is the same loop Phase 2 widened `mineBlock` to accept a `Vec3` for
(design spec §9.2): the model searches, sees positions in its history, and mines the
*specific* block it reasoned about rather than re-searching and possibly getting another.

The type above, and every other in this document, drops `readonly` for legibility. The
implemented types carry it throughout, matching `packages/contract/`.

`find_blocks` is the one menu entry whose outcome is not a `Result` — `findBlocks` returns
an array and **throws** when disconnected. §7 handles that asymmetry.

### 4.2 Why mining is two actions, not one

`mineBlock`'s contract target is `string | Vec3`. Modelled directly, that is a nested union
inside the action object, and nested unions are the shape JSON-Schema-constrained decoding
handles worst — and the shape a 14B model is likeliest to get half-right.

Splitting it into `mine_nearest_block` and `mine_block_at` makes every member of the menu a
**flat object**, so the schema has exactly one union: the top-level `oneOf` discriminated by
`action`, which is needed regardless. `dispatch.ts` collapses the two back onto the single
contract method. The contract is unchanged; only the model's view of it is reshaped.

### 4.3 What is deliberately absent

`placeBlock`, `followPlayer`, `attack` and `flee` are stubs that return
`fail('internal', '… arrives in Phase 5')`. Offering the model actions guaranteed to fail
teaches it nothing and spends steps on certain failure. They enter the menu as Track A
lands them — which is exactly what the phase plan lists as Phase 5's Track B task:
"expanding the tool-selection prompt/schema as each Track A tool lands."

`done` has no executor counterpart at all. Without it the loop could only ever end by
exhausting its budget.

## 5. The LLM seam

Design spec §8.2 left "Ollama native tool-calling vs. hand-rolled JSON" open, to be resolved at
Phase 3. **It is resolved here instead, by measurement: schema-constrained output wins** —
25/25 decoded against 20/25, and 370ms against 469ms (§2.1). More decisively than the totals
suggest, since every tool-calling failure was the terminal `done` action.

So the design commits to schema-constrained output and does **not** carry a tool-calling
implementation. Keeping one would be an abstraction maintained for a choice the evidence has
already made.

Two layers:

```ts
// llm.ts — transport. Messages in, reply out.
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface ChatRequest {
  messages: readonly ChatMessage[]
  /** JSON Schema the reply must satisfy. Ollama's `format` field. */
  schema?: unknown
  signal?: AbortSignal
}

export interface LlmClient {
  chat(req: ChatRequest): Promise<string>
}

// decide.ts — mechanism. Prompt in, one validated action out.
export interface Decider {
  decide(messages: readonly ChatMessage[], signal?: AbortSignal): Promise<DecideResult>
}

export type DecideResult =
  | { ok: true;  action: ActionRequest; raw: string }
  | { ok: false; error: DecodeError;    raw: string }
```

`SchemaDecider` is the only implementation: it sets `format` to the action schema and parses
the reply's content.

`Decider` survives the resolution of §8.2, but it earns its place as a **testing** seam rather
than a mechanism one. `runGoal` needs something injectable to depend on — the `llm_error` test
supplies a decider that throws, which is not expressible against a concrete class. Should a
future model behave differently enough to reopen the question, §2.1 is the measurement to
repeat and `probe.ts` is the tool for it.

`LlmClient` has exactly two implementations: `OllamaClient`, the only module in the package
that opens a socket, and `FakeLlmClient`, which returns replies a test queued and records
every request it received. Every test uses the fake.

### 5.1 Ollama request shape

`POST {host}/api/chat`, `stream: false`, with `format` set to the action schema,
`think: false`, and `temperature: 0`.

`think: false` settles design spec §8.1, which recommended testing with thinking disabled
first. Measured (§2.1), it is not close: thinking costs **20× latency** — 7641ms against
370ms — and made the model *worse*, choosing a redundant `move_to` in 4 of 5 samples on a turn
that `think:false` got right every time. Temperature 0 because this is classification over a
fixed menu, not generation.

Configuration is environment-driven with defaults: `OLLAMA_HOST`
(`http://127.0.0.1:11434`) and `MINEBOT_MODEL` (`qwen3:14b`). The dev box is
`http://192.168.1.21:11434`.

## 6. Decoding and validation

Two distinct failures, handled in order.

**Structural.** Constrained decoding makes malformed JSON rare rather than impossible — an
empty reply, or a model that ignores the constraint, still has to be handled. `not_json`,
`not_an_object`, `empty_reply` and `unknown_action` cover it.

**Semantic.** The schema cannot express these; they are checked in code:

| Field | Rule |
|---|---|
| `maxDistance` | finite, `0 < d <= 128` |
| `limit` | integer, `1 <= n <= 16` |
| `names` / `name` | non-empty; a leading `minecraft:` namespace is stripped, then the bare name must match `^[a-z0-9_]+$` |
| coordinates | finite; floored to integers; `-64 <= y <= 320`; `abs(x)`, `abs(z) <= 3e7` |
| `message` | non-empty, `<= 256` characters (Minecraft's own limit) |
| `summary` | non-empty |
| `reason` | non-empty (`give_up`) |

Stripping the namespace prefix is a deliberate normalisation, not laxity: Mineflayer's block
names are bare (`coal_ore`), the contract's own `BlockQuery` example uses bare names, and a
model trained on Minecraft data will frequently emit the namespaced form. Rejecting it would
spend a turn teaching the model something a two-line normalisation settles.

### 6.1 Decode failures do not use `Result`

`FailureReason` is a closed vocabulary describing things that go wrong *in the game world*.
`invalid_target` means "no such block name," not "the model returned broken JSON." Reusing it
would make the two indistinguishable downstream and would quietly widen what the shared
contract means — the change-for-convenience CLAUDE.md prohibits.

So decode failures get an agent-local type, and nothing about parsing reaches
`packages/contract/`:

```ts
export interface DecodeError {
  kind: 'empty_reply' | 'not_json' | 'not_an_object' | 'unknown_action' | 'bad_arguments'
  detail: string
}
```

### 6.2 One repair attempt per step

On a decode failure the loop re-asks once, appending the specific `DecodeError.detail` as an
extra user message so the model sees what was wrong. That repair message is scoped to the
retry and discarded with it — the next turn rebuilds the prompt from scratch per §3, so no
transcript accumulates. If the retry also fails, the step
is recorded as `undecodable` and rendered into history, so the model sees it next turn too.
Only **three consecutive** undecodable steps end the goal.

## 7. Failure handling and termination

Per the scope decision, this slice does **not** code a per-reason retry policy. Phase 4 does,
informed by evidence this slice produces rather than by guesses made before any failure has
been observed.

Instead every outcome — success or failure, with its reason and detail — is rendered into the
history the model reads on the next turn, and the model decides:

```
Recent actions:
  1. find_blocks(coal_ore, deepslate_coal_ore within 32) -> 1 found:
     coal_ore at (18, 60, -34), 7.9 away
  2. mine_block_at(18, 60, -34) -> FAILED (missing_tool): no pickaxe in inventory
```

The only hardcoded protections are a step budget and a repetition guard.

### 7.1 The step log

```ts
export interface Step {
  n: number
  raw: string
  action: ActionRequest | null
  decodeError: DecodeError | null
  outcome:
    | { kind: 'blocks'; blocks: readonly BlockInfo[] }   // find_blocks
    | { kind: 'result'; result: Result<unknown> }        // an executor action
    | { kind: 'undecodable' }
    | { kind: 'done' }
}
```

Every step is retained for the outcome; only the last **8** are rendered into the prompt, so
prompt size stays flat however long a goal runs.

The log is the deliverable's real output. There is currently no data on how a 14B-class model
fails at this task, and Phase 4's policy has to be written against something. This is that
something.

### 7.2 Goal outcomes

```ts
export type GoalOutcome =
  | { status: 'done'; summary: string; steps: readonly Step[] }
  | {
      status:
        | 'gave_up'
        | 'budget_exhausted'
        | 'stuck'
        | 'undecodable'
        | 'interrupted'
        | 'disconnected'
        | 'llm_error'
      detail: string
      steps: readonly Step[]
    }
```

| Status | Cause |
|---|---|
| `done` | The model chose `done`. |
| `gave_up` | The model chose `give_up`. `detail` carries its stated reason. |
| `budget_exhausted` | `maxSteps` reached. Default **16**. |
| `stuck` | The same `(action, outcome)` pair three times running. |
| `undecodable` | Three consecutive undecodable steps. |
| `interrupted` | The caller's `AbortSignal` fired. |
| `disconnected` | `getState()` or `findBlocks()` threw. |
| `llm_error` | The model could not be reached, or returned an error. |

Failure is a returned value, never a thrown error — the same reasoning the contract gives for
`Result`, applied one layer up. `llm_error` exists so that stays true when the endpoint is
down: without it an unreachable model would be the one thing that had to throw.

### 7.3 The throw/resolve asymmetry

`getState()` and `findBlocks()` **throw** when disconnected. The six actions **resolve**
`fail('disconnected', …)`. The contract documents this explicitly and gives the reason: those
two have no `Result` to report failure through, and a silent `[]` would be indistinguishable
from "searched, found nothing."

The loop therefore has exactly two `try`/`catch` sites — the observe step and the
`find_blocks` dispatch — and reads a `Result` everywhere else. Both catches produce
`status: 'disconnected'`. This is a trap worth naming in the plan, because it is invisible
until a bot drops mid-goal.

## 8. Interruption

Design spec §3.5 assigns Track A the arbiter and leaves Track B one obligation: handle
`'interrupted'` distinctly. Three rules discharge it.

1. **Every dispatched action gets a signal.** The loop owns an `AbortController` per step; the
   caller's outer signal chains into it.
2. **The model call is cancellable too.** `OllamaClient` passes the signal to `fetch`.
   Otherwise an abort during a multi-second inference still waits it out, and the reflex
   layer's whole purpose is not waiting.
3. **`interrupted` is a re-plan, not a retry.** The loop discards its snapshot, re-observes,
   and decides again from fresh state. It never retries the interrupted action against the old
   snapshot: after the reflex layer has fled a mob, the position that action was chosen for no
   longer exists.

Rule 3 is the contract obligation stated literally, and it is why §3's "rebuild the prompt
each turn" is load-bearing rather than stylistic.

## 9. Package structure

```
packages/agent/
  package.json          deps:    @minebot/contract "0.1.0"
                        devDeps: @minebot/mock-executor "0.1.0"
                        (vitest comes from the root, as in every other package)
  src/
    index.ts            public surface
    actions.ts          ActionRequest, its JSON Schema, the menu text
    llm.ts              LlmClient, ChatMessage, ChatRequest — pure, zero deps
    ollama.ts           OllamaClient — the only module that opens a socket
    fake-llm.ts         FakeLlmClient — queued replies, records requests
    decide.ts           Decider, SchemaDecider, DecodeError
    prompt.ts           goal + snapshot + history -> ChatMessage[]   (pure)
    dispatch.ts         ActionRequest + BotExecutor -> outcome       (no LLM)
    loop.ts             runGoal()
    probe.ts            live-model check; not part of npm test
  test/
    *.test.ts           picked up by the existing `unit` vitest project
```

Six of the eight logic modules are pure functions over plain data. That is deliberate:
CLAUDE.md observes that most test value in this repo lives in pure logic because the tests are
instant, and that holds at least as strongly here.

**This slice changes nothing on the shared surface.** `packages/contract/` and
`packages/mock-executor/` are untouched, and were checked against this design rather than
assumed adequate: `MockOptions.blocks` seeds findable blocks, `setFailure` drives the failure
paths, and `calls` records dispatch. Everything needed already exists — a direct dividend of
the four §9 changes that landed at the start of Phase 2. If something later turns out to be
missing, that is a conversation with Track A, not a commit.

Two structural constraints hold automatically. `scripts/check-invariants.mjs` currently
reports "1 of 2" because no `agent` manifest exists; creating one activates the check that
the package never depends on `mineflayer`. And `vitest.config.ts` needs no change — its
`unit` project glob is `packages/*/test/**/*.test.ts`.

`runGoal` receives an **already-connected** executor and never calls `connect()` or
`disconnect()`. Session lifecycle belongs to the caller; the loop's job is deciding.

## 10. Testing strategy

Layer one, the bulk — pure unit tests with no fakes needed at all:

- **`decode.ts`**: a table of raw replies to expected action or `DecodeError` — prose-wrapped
  JSON, an unknown action name, wrong types, a missing field, a negative `maxDistance`, a
  namespaced block name, an over-long chat message.
- **`prompt.ts`**: a fixed snapshot and history render to expected text. Catches accidental
  prompt drift, which is otherwise silent.
- **`actions.ts`**: the schema is well-formed and every menu member is representable.
- **`dispatch.ts`**: each `ActionRequest` produces the right `BotExecutor` call with the right
  arguments, asserted off `MockExecutor.calls`. In particular both mining actions collapse
  onto `mineBlock` with the correct target form.

Layer two — the loop between the two fakes, `FakeLlmClient` and `MockExecutor`:

- **Happy path.** Script `find_blocks` → `mine_block_at` → `done`, seed the mock with a coal
  block, assert `status: 'done'` and that the mock recorded exactly those calls in order.
- **Budget exhaustion**, **the stuck guard**, and **`interrupted` causing a re-plan** rather
  than ending the goal.
- **Failure feedback — the important one.** With `mock.setFailure('mineBlock', { reason:
  'missing_tool' })`, assert that the *next prompt the fake model receives contains that
  failure*. This is the only test that proves the feedback path — the thing standing in for a
  retry policy — actually works. CLAUDE.md's rule applies directly: when you add a guard,
  prove it can fire.
- **Disconnected.** An executor that throws from `getState()` yields `status: 'disconnected'`,
  not an exception escaping `runGoal`.

Layer three — `OllamaClient` gets **request-shape tests only**: build the HTTP body, assert
`format`, `think`, `model` and messages, never send it. Talking to a real model is `probe.ts`,
run by hand.

The trap CLAUDE.md records about fixtures that silently skip themselves applies to
`FakeLlmClient`: a fake that runs out of queued replies must throw loudly, never return an
empty string. An empty reply is a legitimate decode case, and a fake that produces one by
accident would turn an exhausted script into a passing test.

## 11. Decisions log

| Decision | Choice | Rationale |
|---|---|---|
| Loop shape | One action per turn, prompt rebuilt each turn | §3.5 preemption makes plan queues re-planning with extra steps; rebuilding keeps snapshots from going stale in a transcript |
| Model access | Interface + scripted fake in every test; real client used only by `probe.ts` | The endpoint is reachable, so socket-free tests are now a discipline rather than a constraint — and the more worth keeping for being optional |
| Decode mechanism | JSON-Schema-constrained output; no tool-calling implementation | Measured: 25/25 vs 20/25 and 370ms vs 469ms, with every tool-calling failure landing on the terminal `done` action (§2.1) |
| `Decider` seam | Kept, as a testing seam | §8.2 is answered, so it no longer preserves a mechanism choice; it still lets `runGoal` be handed a decider that throws |
| Terminal actions | `done` and `give_up`, kept separate | The model reliably chooses `done`; folding "abandoned" into it risks that for no gain (§4.0) |
| Mining actions | Split into `mine_nearest_block` / `mine_block_at` | Keeps every schema member a flat object; one top-level union instead of a nested one |
| Failure policy | Feed outcomes back to the model; budget + repetition guards only | Phase 4 owns policy, and should write it against observed failures |
| Decode errors | Agent-local type, not `FailureReason` | `Result`'s vocabulary is about the game world; reusing it would widen the shared contract |
| Phase 5 stubs | Kept out of the menu | Actions guaranteed to fail spend steps and teach nothing |
| Connection lifecycle | Caller's, not the loop's | The loop decides; it does not manage sessions |

## 12. Open questions

1. ~~**Does `qwen3:14b` actually hold the format?**~~ **Answered** (§2.1): 25/25 under
   schema-constrained decoding at 370ms median. Design spec §8.1 and §8.2 are both resolved.
   The measurement is five samples per cell at temperature 0, so it establishes consistency,
   not robustness — re-run `probe.ts` after any prompt or menu change.
2. ~~**The model mines a block it has already destroyed.**~~ **Fixed** (§2.2): a system rule
   explaining `collected: false` moved it from `mine_block_at` 5/5 to `move_to` 5/5.
3. **How brittle is the current prompt?** §2.2 established that the rules block outweighs the
   menu, and that all five scenarios now answer correctly — but "correct on five hand-built
   scenarios at temperature 0" is a low bar. Unknown: how it behaves on scenarios nobody
   anticipated, how much the ordering of the rules matters, and whether the rules block has a
   length past which earlier rules stop being honoured.
4. **Is the repetition guard too aggressive?** Three identical `(action, outcome)` pairs is a
   guess. Legitimately repeating an action after two interruptions would trip it. The step log
   will show whether it fires on real runs; tune with evidence.
5. **Is an 8-step history window enough?** Long enough to see a failed approach, short enough
   to stay cheap. Unmeasured.
6. **Should `find_blocks` results persist beyond the window?** A block found at step 2 falls
   out of the prompt by step 11, and the model would have to search again. A small dedicated
   "known blocks" section may be warranted. Deferred until a run demonstrates the problem.

## 13. What Phase 3 integration needs

By construction, swapping the mock for the real executor changes **only the caller** —
`runGoal` takes a `BotExecutor` and does not know which one it has. That is the whole point of
the contract, and `runContractSuite` is what makes it a verified step rather than a hope.

**Phase 2 landed while this spec was being written** (PR #11). `moveTo` runs on
`mineflayer-pathfinder`, and `mineBlock` resolves a target, checks harvestability, digs, and
walks onto the drop. Every action the menu of §4 exposes is now genuinely implemented on the
real executor, so the coal trace is executable end to end rather than blocked at the mining
step. The earlier draft of this section said otherwise; it was true when written.

Three things to know before wiring it up:

- **The dev server moved.** A Velocity proxy now fronts it: people connect on 25565, the Fabric
  backend listens on loopback 25566, and `MineflayerExecutor` defaults to 25566 and signs its
  own forwarding payload. Nothing in `packages/agent/` cares — it never constructs an executor
  — but the Phase 3 caller does.
- **`collected: false` is a live failure mode**, not a hypothetical. §12 question 2 records the
  model mishandling it, and Phase 2 measured that mining genuinely does not collect on its own.
  A first real run is likely to hit this.
- **The reflex layer still does not exist**, so nothing drives the interruption path in a real
  game. This slice's `interrupted` handling is exercised by injection against the mock, which
  verifies the loop's half of the protocol but not the arbiter's.
