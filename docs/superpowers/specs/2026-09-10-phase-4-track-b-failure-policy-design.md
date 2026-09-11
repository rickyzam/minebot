# Phase 4 (Track B) Design — Failure Policy and Prompt Refinement

**Status:** agreed with Ricky on 2026-09-10, through the four decisions in §9. Not started.

**Scope:** `packages/agent` only. No contract change, no mock change, no executor
change. The shared surface is untouched, so this needs no Track A agreement.

---

## 1. What this phase is

The work-split note gives Track B's half of Phase 4 as *"the retry/failure policy
and prompt refinement — what should the agent do when a search comes up empty?
When does it escalate, retry with a wider radius, or give up and report back?"*

`runGoal` today has **no per-`FailureReason` branching at all**. Every outcome is
rendered into the history the model reads next turn, and the model decides.
`loop.ts:79-82` says so, and commits this phase to writing the real policy
*"against the step logs this produces, rather than against failures nobody has
observed yet."*

The only code-level policies that exist are three blunt guards, and all three are
terminal:

| Guard | Default | Result |
|---|---|---|
| `maxSteps` | 16 | `budget_exhausted` |
| `isStuck` — one signature 3× inside the last 6 steps | 3 | `stuck` |
| `maxUndecodable` | 3 | `undecodable` |

None of them adapts, and none of them tells the model anything. The loop watches
a model repeat itself three times in silence and then ends the goal.

## 2. The bet: prompt first, code only where the prompt measurably fails

A code-level policy layer would partly reverse the design's central bet — that
the model decides and the loop reports. This phase keeps that bet and puts the
burden of proof on any code rule:

1. Fix the behaviour in prompt text.
2. Measure it with `agent:probe`, replicated.
3. Add a code rule **only** for a case the prompt measurably fails, citing the
   measurement as the justification.

Two measured facts from Phase 4A make this affordable now, and neither was true
when `loop.ts:79` was written.

**The probe became a sound instrument.** Until 2026-09-09 a single probe run was
unfalsifiable: the same prompt, verified byte-identical by sha256, produced
`give_up` in nine runs and `move_to` in five, every run internally unanimous and
one reporting 40/40. `agent:probe` now spawns a fresh process per replicate and
flags scenarios whose replicates disagree. Prompt work can be judged.

**Prompt fixes have a known shape.** Phase 4A tried four candidates against one
defect. Every candidate that reworded or reordered the **claim** failed 4/4. The
one that worked changed **what the model is asked to check** — from *"did I
already go there"*, which needs the whole step history, to *"does my Position
equal this coordinate"*, which needs two lines of the prompt. This design applies
that lesson deliberately rather than rediscovering it.

## 3. `advice.ts` — the pure core

Three of this phase's four fixes are prompt text. One is not: the loop knows two
things the model cannot see — that it has repeated itself, and how many steps
remain. Something has to compute and deliver those.

```ts
export interface Advice {
  /** How many times the latest step's signature appears in the stuck window. */
  readonly repeatedTimes: number
  /** Steps left before budget_exhausted. */
  readonly stepsRemaining: number
}

export const advise = (steps: readonly Step[], opts: AdviseOptions): Advice
```

Pure — no I/O, no executor, no model — in the shape of `explore.ts` and
`snapshot.ts`. `runGoal` calls it each turn and passes the result to
`renderPrompt`, which gains a fourth parameter and renders it. `prompt.ts` stays
a pure renderer and does no arithmetic.

**`advise` returns facts, never actions.** It has no power to rewrite or veto the
model's choice. That is what distinguishes this from the policy layer §2 declined
to build.

### 3.1 The shared signature is the load-bearing part

`outcomeSignature` and `signatureOf` are currently private to `loop.ts:25-41`,
where `isStuck` uses them to decide when to kill a goal. They move into
`advice.ts` and **both callers use the same function**.

If they drift, the model is told "you have tried this twice" while the guard
counts something else. That bug would be invisible: the guard's arithmetic has no
test today, and the prompt's never will. A unit test asserts the two agree
directly, rather than leaving it a property of them happening to share a call.

This is also why `advise` is a module rather than four lines inside
`renderPrompt`. The counting becomes something `npm test` can assert; only the
wording stays probe-measured.

### 3.2 Deliberately not in `Advice`

Nothing about position, targets, or what the model *should* do next. The
dead-position and empty-search fixes are prompt rules. Folding them in here would
quietly turn a fact-reporter into the policy engine this phase declined to build.

## 4. The four fixes

Working through them collapsed two and thinned a third. Both are recorded because
the original framing is what a reader will arrive with.

### 4.1 A dead position must not end the goal

Phase 4A diagnosed this precisely: after `mine_block_at` returns `not_found`, the
model reasons *"no more coal can be collected from this position"* and gives up on
the **goal**. It conflates "this position is finished" with "this goal is
impossible". `explore_for` is the better answer and is not reached. A rule
written for exactly that measured as no help.

Per §2's lesson, the fix gives the model something to **check** rather than a
claim to weigh. `explore_for` already reports `exhausted`, and `renderOutcome`
already renders it as *"nowhere left to search"* versus *"more ground remains"*.

> **`exhausted` is the only evidence that justifies giving up on a search goal.**

### 4.2 Empty search: the ladder, not the radius

The work-split note asks whether an empty search should *"retry with a wider
radius"*. **Phase 4A's architecture already answered that, and the answer is no.**
`find_blocks` is line-of-sight limited from where the bot stands, so a larger
radius returns the same nothing and costs more doing it — measured at r=64:
`coal_ore` 339ms against ~75ms at r=32, because the *empty* answer is the
expensive one.

The real ladder is `find_blocks` → `explore_for` → `explore_for` until
`exhausted` → `give_up`. That is the same rule as §4.1, so the two share one
mechanism rather than becoming two rules that can drift apart.

### 4.3 The guard notices

`Advice`'s two facts render as a notices block:

- a repetition line when `repeatedTimes >= 2`;
- a steps-remaining line only when `stepsRemaining <= 3`.

Both conditional. Rendering *"Steps remaining: 14"* every turn is noise.

**Known risk, to be probed rather than assumed:** telling a model it has 3 steps
left may make it give up early. A scenario with a low budget where continuing is
still correct tests exactly that.

### 4.4 `missing_tool` — thinner than billed

The existing `after missing_tool, inventory empty` scenario answers `give_up`,
and **that is correct**: empty inventory, no acquiring actions, nothing that can
help. Making the model persist there would make it worse.

What is measurable today is the discrimination: `missing_tool` on one target
while another route remains is not the same as the goal being impossible. The fix
is a scenario where the tool is missing but the inventory or the world still
offers an option, checking the model does not abandon.

The "go and acquire it" half is **out of scope** — see §8.

### 4.5 Every fix ships with a paired control

A rule that always answers `explore_for` passes §4.1's scenario while being
useless. So each fix carries a companion scenario where the **opposite** answer is
correct — a search that *has* reported `exhausted`, where `give_up` is right.

Without the pair, "the rule works" and "the rule fires unconditionally" are
indistinguishable. This is the same pairing the contract suite's hidden/control
visibility fixture exists to enforce.

## 5. What `stuck` and `budget_exhausted` become

Both guards keep their backstop role — an infinite loop needs a hard stop — but
stop being the first the model hears of it.

| | Today | After |
|---|---|---|
| Warning | none | from the 2nd occurrence, floored at 2 |
| `stuckThreshold` default | 3 | **4** |
| Budget warning | none | when `stepsRemaining <= 3` |

**Why the threshold rises.** Warning at 2 while killing at 3 gives the model one
turn to act on information it has never had, then ends the goal anyway — which
would let this phase claim a nudge while shipping the old behaviour. Two turns is
a real chance. The cost is one extra step out of 16.

The warning point **derives** from `stuckThreshold`; no new options.

**The budget notice states the fact and nothing else** — *"Steps remaining: 2."*,
not *"you should wrap up"*. Minimal intervention: if the bare fact measurably does
nothing, guidance is added then, with the measurement as its justification.
Instructing first would bake in §4.3's early-give-up risk before knowing whether
it is needed.

**Both statuses gain stronger meanings, and their docs must say so.** `stuck`
stops meaning *"the loop noticed a repeat"* and starts meaning *"the model was
told it was repeating and did it again"*. `budget_exhausted` becomes *"the model
was warned and still did not finish"*.

## 6. Testing

| Layer | Covers |
|---|---|
| Unit (`advice.ts`) | repeat counting, budget arithmetic, the floor at 2, **and that `advise` agrees with `isStuck`** |
| Loop (`FakeLlmClient` + `MockExecutor`) | the notice reaches the rendered prompt; `stuck` fires at 4 and not 3; a warned model that changes action does not trip the guard |
| Probe | the prompt behaviour, replicated |

**Retake the baseline first**, on current `main`, with the current replicating
probe. The recorded numbers were taken with the old single-process probe and are
not comparable. Phase 4A lost real time to a before/after comparison that spanned
two different conditions.

**The bar is every pre-existing scenario unmoved**, not only the new ones on
target. A bigger rules block is a real test of whether the model still picks
correctly everywhere else.

4 replicates while iterating, 6 for the merge sweep.

**Prove the guards fire.** This phase adds two things that can silently no-op — a
notice that never renders, a threshold that never trips — and both would leave
every test green. Each gets a test that fails when its guard is removed.

## 7. The live-validation gate — blocking

Everything in §6 runs with no Minecraft server. That is exactly the condition
under which Phase 4A shipped two broken scripts past 310 green unit tests:
`bench:world` was dead and `demo:phase2` had been passing only because
`findBlocks` saw through stone. `scripts/` and `demo:*` are outside `npm test`.

**This phase must not merge on an offline sweep alone.** Before the PR merges,
someone with dev-server access must confirm:

1. A goal that genuinely cannot be satisfied ends in a clean `gave_up` carrying
   `exhausted` evidence — not `budget_exhausted`, not `stuck`.
2. The notices appear in real step logs, in real runs.
3. `agent:demo`, `demo:phase3` and `demo:phase4` all still exit 0.

## 8. Scope boundaries

**Out: resource acquisition.** *"Out of dirt"* and `missing_tool` should
eventually mean *"go and get more"* — check the relevant container, and failing
that gather from a permitted area. It is not in this phase because the actions it
needs do not exist:

- there are **no container actions in the contract at all** — no chest, open,
  withdraw or deposit;
- **"designated area" exists nowhere** in the repo.

A model told to go and get dirt with nothing that can get dirt will pick an
action, fail, and pick again. **Agreed 2026-09-10:** this becomes its own Track A
phase after Phase 5, carrying the container actions, the designated-area
allowlist and the gathering behaviour. The allowlist is also what Phase 5's
build-safety problem needs, so designing it once serves both. This phase's output
for it is a written requirement, nothing more.

**Out: a policy layer that overrides the model.** See §2. Any code rule must cite
the measurement of the prompt fix it replaces.

**Out: anything in `packages/contract`, `packages/mock-executor` or
`packages/executor`.** This phase changes no shared surface.

## 9. Decisions — answered 2026-09-10

| # | Question | Answer |
|---|---|---|
| 1 | Prompt refinement, a code policy layer, or both? | **Both, prompt first.** Code rules must be earned by a measured prompt failure |
| 2 | What is the policy designed against? | **Probe-driven now, validated live before merge.** Real step logs need the dev server, which Track B cannot reach |
| 3 | Which behaviours are in scope? | All four of §4 — with 4.2 collapsed into 4.1's mechanism and 4.4 reduced to the discrimination case |
| 4 | Where does resource acquisition land? | **Its own Track A phase after Phase 5** — see §8 |

## 10. Risks

1. **The `exhausted` rule may measure no better than the wording it replaces.**
   Then Phase 4A's lesson did not generalise, and the honest response is a code
   rule in `advice.ts` with that measurement as its justification — the path §2
   requires be earned rather than assumed.
2. **The budget notice may cause early `give_up`.** §4.3 probes it directly.
3. **A larger rules block may degrade tool selection elsewhere.** Measured
   before in this project, which is why §6's bar is every scenario, not the new
   ones.
4. **Two turns may still be too few to recover from a repeat.** The probe
   measures one decision, not a run; only §7's live validation would show it.
