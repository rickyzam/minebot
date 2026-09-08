# Phase 3 — Integration Design (JOINT)

**Date:** 2026-09-08
**Status:** agreed by both tracks, ready to implement
**Blocked by:** nothing. Phase 2 (Track A, PR #11) and the Track B planning loop (PR #12) are both merged.

## 1. Goal

Close the loop once, end to end: real game state → LLM decision → real game action.

The phase plan's verification is *"tell the bot to mine a specific, visible block by
name and watch it actually do it via the LLM's decision, not a hardcoded call."*
That is a demo you watch. This design adds automated tests alongside it, because a
demo that passes today cannot tell anyone next month that the wiring still works.

## 2. What is already true

Measured on 2026-09-08 against `main` at `7932b5d`, not assumed:

| Fact | Consequence |
|---|---|
| `packages/contract/` and `packages/mock-executor/` are byte-identical across PR #11 and #12 | The shared surface needs no changes and no re-agreement. Phase 3 is wiring, not negotiation |
| Every action in Track B's menu maps to a `BotExecutor` method Track A implements — `findBlocks`, `moveTo`, `mineBlock(string)`, `mineBlock(Vec3)`, `chat` | No Phase 5 stub is reachable from the menu, so the loop cannot spend a step on certain failure |
| `runGoal` takes a `BotExecutor` and documents *"must already be connected; session lifecycle belongs to the caller"* | The seam is a parameter, not a rewrite |
| The contract suite passes against both implementations | Design spec §5a: the swap is already a test rather than a hope |
| `qwen3:14b` is present in Ollama at `http://127.0.0.1:11434` | The demo can run against the exact model Track B's 25/25 probe measured |
| 260 unit tests, 79 integration tests, clean typecheck, `check-invariants` at 2 of 2 | The baseline both halves start from |

The single most useful consequence: **the integration risk is not the interfaces.**
They line up, method by method. The risk is behavioural — what a *game-produced*
failure looks like by the time it reaches the model, which no mock can answer.

## 3. Structure — `packages/bot/`

A composition root that depends on both tracks:

```
packages/bot/
  package.json                     # @minebot/agent, @minebot/contract, @minebot/executor
  src/session.ts                   # runBotGoal(): connect → runGoal → always disconnect
  src/index.ts
  src/phase3-demo.ts               # the watchable deliverable
  test/integration/loop.int.test.ts
```

`session.ts` is the only place all three packages meet. This keeps `packages/agent`
free of game libraries and `packages/executor` unaware that an LLM exists — both
guarantees the design spec §4 makes, and neither survives putting the composition in
either package.

**`packages/agent` is not an option for this, and the reason is worth recording.**
Adding `@minebot/executor` there would pull `mineflayer` into the planning track
transitively, defeating §4's "buildable with no game libraries at all" — and it would
pass `check-invariants.mjs` clean, because invariant 2 matches dependency *names*
(`mineflayer`, `mineflayer-*`, `prismarine-*`) and `@minebot/executor` is none of
those. See §7.

`packages/*/test/integration/**` is the Vitest integration glob, so a new package
picks up test discovery with no configuration change.

## 4. Testing — a deliberate split

Two questions fail for different reasons and must not share one signal:

- **Does the wiring work?** Deterministic. Tested.
- **Does the model choose well?** Statistical. Demonstrated and probed, not asserted.

### 4.1 Integration tests — `FakeLlmClient` + real `MineflayerExecutor`

Scripted replies, real game. No model socket, preserving Track B's rule that nothing
in the test suite depends on a box being up; the game socket is the exception
integration tests already make.

Arena at **x 1100–1130**, floor y=199. Clear of all five arenas in use (500–560,
800–840, 860–880, 900–930, 1000–1020) and of the Phase 2 demo (950–980).

| Case | Setup | Asserts |
|---|---|---|
| Happy path | coal_ore at a known coordinate, `stone_pickaxe` | `status: 'done'`; `find_blocks` returned the coordinate actually placed; the ore is gone; coal is in the inventory |
| Real failure | same arena, **no pickaxe** | the step outcome is `missing_tool`; **the ore is still standing**; the prompt rendered for the next step contains the reason and detail |
| Abort | happy setup, abort mid-mine | `status: 'interrupted'`; the bot actually halted, sampled twice |

The middle row is the one that earns its keep. Every failure Track B has handled so
far was *injected* by `MockExecutor.setFailure`. This is the first time a failure the
game itself produced has to survive the trip through `dispatch` → `StepOutcome` →
`renderPrompt` and arrive intact as something a model can act on. Asserting on the
rendered prompt is what makes that trip visible; asserting only on the returned status
would pass against a loop that drops the detail on the floor.

The "ore still standing" assertion is Track A's harvest guard, re-proven from the far
side of the loop. It is cheap and it is the difference between `missing_tool` meaning
"we declined to destroy it" and meaning "we destroyed it and then said so."

### 4.2 Demo — `npm run demo:phase3`

Real `MineflayerExecutor` + `OllamaClient` (`qwen3:14b`) + `SchemaDecider`. Arena at
**x 1150–1180**, one visible coal ore, goal `"get me some coal"`. Prints the step log,
then exits non-zero unless `status === 'done'` **and** coal is actually in the
inventory — a model that declares success without mining anything must fail the demo,
not pass it.

This is the phase plan's stated deliverable and the thing to watch in the joint
session.

## 5. Error handling and budgets

`runGoal` returns failure as a value and never throws; `session.ts` adds only
connection lifecycle around it, and disconnects in a `finally` so a thrown error
cannot leak a bot onto the server.

Budgets must be set explicitly rather than inherited. The executor defaults are 60s
per `moveTo`/`mineBlock` and `DEFAULT_MAX_STEPS` is 16, so a worst-case run is minutes
— fine for a demo, wrong for a test. Each integration test sets its own `maxSteps` and
per-action timeouts.

**Only one branch of the §3.5 interruption protocol is reachable in Phase 3.** An
`interrupted` result *without* an outer abort means the reflex layer preempted, and
the reflex layer is Phase 5 — so the loop re-observes and continues, a path nothing
can currently trigger. The abort test covers the caller-abort branch, which is Track
B's half of the protocol. The arbiter's half stays untested until Track A builds it.

## 6. Explicitly not in scope

- **No `contract` or `mock-executor` changes.** Verified unnecessary; changing them
  needs Track B agreement and there is nothing to agree.
- **No retry policy.** Phase 4, written against the step logs this produces.
- **No reflex layer or arbiter.** Phase 5.
- **No search strategy.** Phase 4. The arena places the ore where the bot can see it.

## 7. Two corrections that ship with this phase

**`packages/agent/src/demo.ts`'s header comment is wrong.** It says swapping in
`MineflayerExecutor` "changes this file only — that second swap is Phase 3." Under the
invariant Ricky's own manifest activated, that swap cannot happen in that file at all.
Correct it to point at `packages/bot/`.

**`check-invariants.mjs` invariant 2 is name-based and misses the transitive case.**
It should resolve what `packages/agent` can actually reach — at minimum by forbidding
`@minebot/executor` explicitly — so the guarantee cannot be undone by a dependency
whose name happens not to match a pattern. Phase 3 is precisely when someone would
add it, so the hardening belongs here rather than later.

Per CLAUDE.md's rule that an untriggered guard is not known to work, the hardened
check must be watched failing against a deliberately bad manifest before it ships.

## 8. Risks carried into implementation

1. **Temperature 0 is consistency, not robustness.** Track B's 5/5 scenario results
   say the model is repeatable, not that it is reliable. The demo passing once is
   evidence the loop closes, not that it closes reliably. Stated in Track B's spec
   §12 and restated here so Phase 4 does not inherit false confidence.
2. **A demo failure has two possible causes** — bad wiring or a bad model decision.
   The integration tests exist to tell those apart: if they are green and the demo is
   red, the model chose badly.
3. **First real contact may still surface a mismatch** the contract suite does not
   cover. That is the entire reason the phase plan calls this a joint session. Any
   mismatch found is a finding to record, not a thing to paper over in `session.ts`.
