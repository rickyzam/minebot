# Phase 4 (Track B) Implementation Plan — Failure Policy and Prompt Refinement

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the planning loop to tell the model what it knows, and teach the model that `exhausted` — not a hunch — is what justifies giving up.

**Architecture:** One new pure module (`advice.ts`) reports what the loop can see and the model cannot; `prompt.ts` renders it; the model still decides everything. Every behaviour fix is prompt text first, measured with the replicating probe, and a code rule is added only for a case the prompt measurably fails.

**Tech Stack:** TypeScript, ESM, Node 24+, vitest. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-09-10-phase-4-track-b-failure-policy-design.md](../specs/2026-09-10-phase-4-track-b-failure-policy-design.md)

## Global Constraints

- **`packages/agent` only.** No change to `packages/contract`, `packages/mock-executor` or `packages/executor`. The shared surface is untouched (spec §8).
- **`packages/agent` must never import `mineflayer` or `@minebot/executor`** — `scripts/check-invariants.mjs` enforces this and reports 2 of 2.
- TypeScript ESM, `verbatimModuleSyntax` on: use `import type` for type-only imports.
- Relative imports carry the `.js` extension (`./step.js`), per NodeNext.
- Exact version pins in every manifest. No `^` or `~`.
- **`advise` returns facts, never actions** (spec §3). It has no power to rewrite or veto the model's choice.
- **No code rule may be added without citing the measurement of the prompt fix it replaces** (spec §2).
- **Prompt text is behavioural code that no test covers.** After any edit to `SYSTEM` or `ACTION_MENU`, re-run `npm run agent:probe`. `npm test` stays green regardless.
- Probe replicates: **4 while iterating, 6 for the merge sweep** (spec §6).

## Verified environment facts

Measured, not assumed. These shape the tasks below.

| Fact | Consequence |
|---|---|
| `OLLAMA_HOST` is `http://100.96.8.28:11434` (`bellatrix` over Tailscale); Ollama 0.33.3, `qwen3:14b` present | Every probe step below needs this exported. A bare `npm run agent:probe` defaults to `127.0.0.1` and will fail |
| The Minecraft backend is loopback-only on bellatrix; port 25566 is closed from the tailnet and SSH is refused | Task 7's live validation **cannot be run by Track B**. It is a handoff, not a step |
| `DEFAULT_MAX_STEPS` is 16, `DEFAULT_STUCK_THRESHOLD` is 3, `DEFAULT_MAX_UNDECODABLE` is 3 (`loop.ts:8-10`) | Task 3 changes the second of these and nothing else |
| `outcomeSignature` and `signatureOf` are private to `loop.ts:25-41` | Task 1 moves them; nothing outside `loop.ts` imports them today, so the move is safe |
| A single probe run cannot judge a prompt change — one byte-identical prompt gave `give_up` in nine runs and `move_to` in five | Never draw a conclusion from one run. The probe flags `UNSTABLE` when replicates disagree; treat that as "no result", not "a result" |
| Rewording or reordering a *claim* failed 4/4; changing *what the model is asked to check* worked 7/7 | Task 4's rule is positional//checkable by construction. Do not "improve" it into a claim |

## File structure

| File | Responsibility |
|---|---|
| `packages/agent/src/advice.ts` | **New.** Pure. Owns `signatureOf`, the repeat counting, and the warn thresholds. The only module that does arithmetic about the run |
| `packages/agent/test/advice.test.ts` | **New.** Unit tests for the above, including that `advise` and `isStuck` agree |
| `packages/agent/src/loop.ts` | Loses `outcomeSignature`/`signatureOf` to `advice.ts`; calls `advise`; `DEFAULT_STUCK_THRESHOLD` 3 → 4 |
| `packages/agent/src/prompt.ts` | Gains `renderAdvice` and a fourth `renderPrompt` parameter. Renders; does no arithmetic |
| `packages/agent/src/step.ts` | Doc comments for `stuck` and `budget_exhausted` gain their stronger meanings |
| `packages/agent/src/probe.ts` | Gains the scenarios for Tasks 4 and 5, each with its paired control |
| `packages/agent/src/index.ts` | Exports `advise`, `Advice`, `signatureOf` |
| `docs/superpowers/specs/2026-09-10-phase-4-track-b-failure-policy-design.md` | Gains the measured results as they land |

---

## Task 0: GATE — retake the baseline

**Nothing else starts until this is recorded.** The numbers in the Phase 4A docs were taken with the old single-process probe and are **not comparable** to anything measured after it started replicating. Phase 4A lost real time to a before/after comparison that spanned two different conditions; this is the same mistake one phase later.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-10-phase-4-track-b-failure-policy-design.md`

- [ ] **Step 1: Confirm the model is reachable**

```bash
curl -s -m 5 http://100.96.8.28:11434/api/version
```

Expected: `{"version":"0.33.3"}` or later. If this times out, STOP — every measurement in this plan is worthless without it, and guessing at prompt behaviour is the one thing the probe exists to prevent.

- [ ] **Step 2: Take the baseline, 6 replicates**

```bash
OLLAMA_HOST=http://100.96.8.28:11434 npm run agent:probe -- 6 5
```

- [ ] **Step 3: Record it verbatim in the spec**

Add a `## 11. Baseline — measured <date>` section to the spec containing the full table: every scenario, its `hoped`, the modal answer, and how many of the 6 replicates agreed. Note any scenario the probe flags `UNSTABLE` — that scenario cannot be used as evidence for or against anything in this plan until the replicate count is raised.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-10-phase-4-track-b-failure-policy-design.md
git commit -m "docs(phase4b): baseline on the replicating probe, before any change

The recorded Phase 4A numbers came from the single-process probe and are
not comparable to anything measured after it started replicating. Retaken
so the before and after span one condition."
```

---

## Task 1: `advice.ts` — the pure core

**Files:**
- Create: `packages/agent/src/advice.ts`
- Create: `packages/agent/test/advice.test.ts`
- Modify: `packages/agent/src/loop.ts:25-41` (remove the moved functions), `packages/agent/src/index.ts`

**Interfaces:**
- Consumes: `Step`, `StepOutcome` from `./step.js`
- Produces: `signatureOf(s: Step): string | null`, `repeatCounts(steps: readonly Step[], window: number): Map<string, number>`, `advise(steps: readonly Step[], opts: AdviseOptions): Advice`, `interface Advice`, `interface AdviseOptions`, `BUDGET_WARN_AT: number`, `repeatWarnAt(stuckThreshold: number): number`

- [ ] **Step 1: Write the failing tests**

Create `packages/agent/test/advice.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { advise, repeatCounts, repeatWarnAt, signatureOf } from '../src/advice.js'
import type { Step } from '../src/step.js'

const step = (n: number, action: Step['action'], outcome: Step['outcome']): Step => ({
  n,
  raw: '',
  action,
  decodeError: null,
  outcome,
})

const MOVE = { action: 'move_to', x: 1, y: 2, z: 3 } as const
const OTHER = { action: 'move_to', x: 9, y: 9, z: 9 } as const
const FAILED = { kind: 'result', result: { ok: false, reason: 'not_found', detail: '' } } as const
const OK = { kind: 'result', result: { ok: true, value: undefined } } as const

const opts = { stepsTaken: 1, maxSteps: 16, stuckThreshold: 4 }

describe('signatureOf', () => {
  it('is null for a step with no action, so undecodable replies never count as repeats', () => {
    expect(signatureOf(step(1, null, { kind: 'undecodable' }))).toBeNull()
  })

  it('separates the same action by its arguments', () => {
    const a = signatureOf(step(1, MOVE, FAILED))
    const b = signatureOf(step(2, OTHER, FAILED))
    expect(a).not.toBeNull()
    expect(a).not.toEqual(b)
  })

  it('separates the same action by its outcome', () => {
    expect(signatureOf(step(1, MOVE, FAILED))).not.toEqual(signatureOf(step(2, MOVE, OK)))
  })
})

describe('repeatCounts', () => {
  it('counts within the window only', () => {
    const steps = [step(1, MOVE, FAILED), step(2, OTHER, OK), step(3, MOVE, FAILED)]
    const counts = repeatCounts(steps, 2)
    expect(counts.get(signatureOf(steps[2]!)!)).toBe(1)
  })

  it('counts non-consecutive repeats — two useless actions taking turns are still stuck', () => {
    const steps = [
      step(1, MOVE, FAILED),
      step(2, OTHER, FAILED),
      step(3, MOVE, FAILED),
      step(4, OTHER, FAILED),
    ]
    expect(repeatCounts(steps, 8).get(signatureOf(steps[0]!)!)).toBe(2)
  })
})

describe('advise', () => {
  it('reports zero repeats for an empty history', () => {
    expect(advise([], opts).repeatedTimes).toBe(0)
  })

  it('counts the LATEST step, not whichever signature is most common', () => {
    const steps = [step(1, OTHER, FAILED), step(2, OTHER, FAILED), step(3, MOVE, FAILED)]
    expect(advise(steps, opts).repeatedTimes).toBe(1)
  })

  it('does not warn on a first attempt, whatever the threshold', () => {
    const steps = [step(1, MOVE, FAILED)]
    expect(advise(steps, { ...opts, stuckThreshold: 3 }).warnRepeat).toBe(false)
    expect(advise(steps, { ...opts, stuckThreshold: 99 }).warnRepeat).toBe(false)
  })

  it('warns from the second occurrence at the default threshold', () => {
    const steps = [step(1, MOVE, FAILED), step(2, MOVE, FAILED)]
    expect(advise(steps, opts).warnRepeat).toBe(true)
  })

  it('reports the remaining budget and never goes negative', () => {
    expect(advise([], { ...opts, stepsTaken: 13 }).stepsRemaining).toBe(3)
    expect(advise([], { ...opts, stepsTaken: 99 }).stepsRemaining).toBe(0)
  })

  it('warns on budget only at the threshold', () => {
    expect(advise([], { ...opts, stepsTaken: 12 }).warnBudget).toBe(false)
    expect(advise([], { ...opts, stepsTaken: 13 }).warnBudget).toBe(true)
  })
})

describe('repeatWarnAt', () => {
  it('is floored at 2 so it can never fire on a first attempt', () => {
    expect(repeatWarnAt(3)).toBe(2)
    expect(repeatWarnAt(1)).toBe(2)
  })

  it('leaves two turns to recover at the default threshold', () => {
    expect(repeatWarnAt(4)).toBe(2)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
npm test -- advice
```

Expected: FAIL — `Cannot find module '../src/advice.js'`.

- [ ] **Step 3: Write the module**

Create `packages/agent/src/advice.ts`:

```ts
import type { Step, StepOutcome } from './step.js'

/**
 * Warn when this many steps or fewer remain. A number rather than a fraction
 * of the budget: the useful question is "can I still finish", and the answer
 * depends on how many actions a wrap-up takes, not on how long the run was.
 */
export const BUDGET_WARN_AT = 3

/** Collapses an outcome to what "the same thing happened again" means. */
const outcomeSignature = (o: StepOutcome): string => {
  switch (o.kind) {
    case 'blocks':
      return `blocks:${o.blocks.length}`
    case 'result':
      return o.result.ok ? 'result:ok' : `result:${o.result.reason}`
    case 'undecodable':
      return 'undecodable'
    case 'done':
      return 'done'
    case 'gave_up':
      return 'gave_up'
  }
}

/**
 * What "the same thing again" means, for both the stuck guard and the notice
 * the model reads.
 *
 * Null for a step with no action: an undecodable reply is a decoding problem,
 * not the model repeating itself, and counting it would warn about something
 * the model cannot act on.
 *
 * The signature includes the action's arguments, so mining three different
 * blocks is three different signatures.
 */
export const signatureOf = (s: Step): string | null =>
  s.action === null ? null : `${JSON.stringify(s.action)}|${outcomeSignature(s.outcome)}`

/**
 * How many times each signature occurs in the last `window` steps.
 *
 * A window rather than a global count, so a long run is not condemned by
 * something it did and recovered from many steps ago.
 *
 * THE SHARED DEFINITION. `isStuck` and `advise` both call this, so the number
 * the model is shown and the number that ends the goal cannot drift apart.
 * `advice.test.ts` asserts that agreement directly rather than leaving it a
 * property of them happening to call the same function today.
 */
export const repeatCounts = (steps: readonly Step[], window: number): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const s of steps.slice(-window)) {
    const signature = signatureOf(s)
    if (signature === null) continue
    counts.set(signature, (counts.get(signature) ?? 0) + 1)
  }
  return counts
}

/**
 * The repeat count at which the model is warned.
 *
 * Derived from `stuckThreshold` rather than configured separately — one knob,
 * not two that can be set into contradiction. Floored at 2 so it can never
 * fire on a first attempt, which would make the notice meaningless.
 */
export const repeatWarnAt = (stuckThreshold: number): number => Math.max(2, stuckThreshold - 2)

export interface AdviseOptions {
  /** Steps completed so far. */
  readonly stepsTaken: number
  readonly maxSteps: number
  readonly stuckThreshold: number
}

/**
 * What the loop knows and the model cannot see.
 *
 * FACTS, NEVER ACTIONS (spec §3). Nothing here can rewrite or veto the
 * model's choice; `prompt.ts` renders these and the model decides. The
 * booleans live here rather than in `prompt.ts` so that the arithmetic
 * deciding when to warn is somewhere `npm test` can reach.
 */
export interface Advice {
  readonly repeatedTimes: number
  readonly stepsRemaining: number
  readonly warnRepeat: boolean
  readonly warnBudget: boolean
}

export const advise = (steps: readonly Step[], opts: AdviseOptions): Advice => {
  const latest = steps[steps.length - 1]
  const signature = latest === undefined ? null : signatureOf(latest)
  const counts = repeatCounts(steps, opts.stuckThreshold * 2)
  const repeatedTimes = signature === null ? 0 : (counts.get(signature) ?? 0)
  const stepsRemaining = Math.max(0, opts.maxSteps - opts.stepsTaken)
  return {
    repeatedTimes,
    stepsRemaining,
    warnRepeat: repeatedTimes >= repeatWarnAt(opts.stuckThreshold),
    warnBudget: stepsRemaining <= BUDGET_WARN_AT,
  }
}
```

- [ ] **Step 4: Rewrite `isStuck` to use the shared counter**

In `packages/agent/src/loop.ts`, delete `outcomeSignature` and `signatureOf` (lines 24-41), import from `advice.js`, and replace the body of `isStuck`. **Keep its doc comment** — it records a verified live-server failure and is not this plan's to discard.

```ts
import { advise, repeatCounts } from './advice.js'

const isStuck = (steps: readonly Step[], threshold: number): boolean => {
  if (threshold < 1 || steps.length < threshold) return false
  for (const count of repeatCounts(steps, threshold * 2).values()) {
    if (count >= threshold) return true
  }
  return false
}
```

- [ ] **Step 5: Add the agreement test**

This is the test the module exists for. Append to `packages/agent/test/advice.test.ts`:

```ts
import { isStuckForTest } from '../src/loop.js'

describe('advise and the stuck guard agree', () => {
  // If these drift, the model is told "you have tried this twice" while the
  // guard counts something else — a bug invisible to every other test, since
  // the guard's arithmetic had no test before this one and the prompt's never
  // will.
  it('a latest-step repeat at the threshold always means the guard has fired', () => {
    const steps = [step(1, MOVE, FAILED), step(2, MOVE, FAILED), step(3, MOVE, FAILED)]
    const a = advise(steps, { ...opts, stuckThreshold: 3 })
    expect(a.repeatedTimes).toBe(3)
    expect(isStuckForTest(steps, 3)).toBe(true)
  })

  it('a warning always arrives strictly before the guard fires', () => {
    const steps = [step(1, MOVE, FAILED), step(2, MOVE, FAILED)]
    const a = advise(steps, { ...opts, stuckThreshold: 4 })
    expect(a.warnRepeat).toBe(true)
    expect(isStuckForTest(steps, 4)).toBe(false)
  })
})
```

Export the guard for testing in `loop.ts`, directly beneath `isStuck`:

```ts
/** Exported for `advice.test.ts`, which asserts the guard and the notice agree. */
export const isStuckForTest = isStuck
```

- [ ] **Step 6: Export from the package index**

In `packages/agent/src/index.ts`, after the `dispatch` export:

```ts
export { advise, signatureOf, repeatCounts, repeatWarnAt, BUDGET_WARN_AT } from './advice.js'
export type { Advice, AdviseOptions } from './advice.js'
```

- [ ] **Step 7: Run everything**

```bash
npm test && npm run typecheck && node scripts/check-invariants.mjs
```

Expected: all green, `Structural invariants OK (checked 2 of 2; agent package present)`. The pre-existing loop tests must still pass — `isStuck`'s behaviour is unchanged by this task, only its implementation.

- [ ] **Step 8: Commit**

```bash
git add packages/agent/src/advice.ts packages/agent/test/advice.test.ts packages/agent/src/loop.ts packages/agent/src/index.ts
git commit -m "feat(agent): advice.ts — what the loop knows and the model cannot see

Spec §3. The loop watches a model repeat itself and then ends the goal
without ever telling it. advise() reports that, plus the remaining budget,
as plain facts — never actions.

signatureOf and the repeat counting move out of loop.ts so the stuck guard
and the notice share one definition of 'the same thing again'. If they
drifted the model would be told 'you have tried this twice' while the guard
counted something else, and no test would see it: the guard's arithmetic
had no test before this one, and the prompt's never will. A test asserts
the agreement directly."
```

---

## Task 2: Render the notices

**Files:**
- Modify: `packages/agent/src/prompt.ts`, `packages/agent/src/loop.ts`, `packages/agent/src/index.ts`
- Modify: `packages/agent/test/prompt.test.ts`

**Interfaces:**
- Consumes: `Advice`, `advise` from Task 1
- Produces: `renderAdvice(a: Advice): string | null`; `renderPrompt(goal, snapshot, steps, advice)` — a **fourth required parameter**

- [ ] **Step 1: Write the failing tests**

Append to `packages/agent/test/prompt.test.ts`:

```ts
import { renderAdvice, renderPrompt } from '../src/prompt.js'
import type { Advice } from '../src/advice.js'

const quiet: Advice = {
  repeatedTimes: 0,
  stepsRemaining: 16,
  warnRepeat: false,
  warnBudget: false,
}

describe('renderAdvice', () => {
  it('renders nothing when there is nothing to say', () => {
    expect(renderAdvice(quiet)).toBeNull()
  })

  it('states the repeat count, so the claim is checkable rather than vague', () => {
    const out = renderAdvice({ ...quiet, repeatedTimes: 2, warnRepeat: true })
    expect(out).toContain('2 times')
  })

  it('states the remaining budget as a fact and gives no instruction', () => {
    const out = renderAdvice({ ...quiet, stepsRemaining: 2, warnBudget: true })!
    expect(out).toContain('2')
    // Minimal intervention (spec §5): if the bare fact measurably does nothing,
    // guidance is added THEN, with the measurement as its justification.
    // Instructing first would bake in the early-give_up risk of spec §4.3.
    expect(out.toLowerCase()).not.toContain('give up')
    expect(out.toLowerCase()).not.toContain('wrap up')
  })

  it('renders both notices together', () => {
    const out = renderAdvice({
      repeatedTimes: 3,
      stepsRemaining: 1,
      warnRepeat: true,
      warnBudget: true,
    })!
    expect(out).toContain('3 times')
    expect(out).toContain('1')
  })
})

describe('renderPrompt with advice', () => {
  it('omits the notices block entirely when there is nothing to say', () => {
    const [, user] = renderPrompt('get coal', SNAPSHOT, [], quiet)
    expect(user!.content).not.toContain('Notices')
  })

  it('puts the notices in the user message, not the system rules', () => {
    const advice = { ...quiet, repeatedTimes: 2, warnRepeat: true }
    const [system, user] = renderPrompt('get coal', SNAPSHOT, [], advice)
    expect(user!.content).toContain('Notices')
    expect(system!.content).not.toContain('Notices')
  })
})
```

`SNAPSHOT` already exists in that file; reuse it rather than defining another.

- [ ] **Step 2: Run to verify they fail**

```bash
npm test -- prompt
```

Expected: FAIL — `renderAdvice is not a function`.

- [ ] **Step 3: Implement**

In `packages/agent/src/prompt.ts`, add above `renderPrompt`:

```ts
/**
 * What the loop knows and the model cannot see, as a notices block.
 *
 * Conditional on purpose. Rendering "Steps remaining: 14" every turn is noise
 * the model has to read past on every one of sixteen prompts.
 *
 * States facts and gives no instruction. Spec §5: if the bare fact measurably
 * does nothing, guidance is added then, with the measurement as its
 * justification. Instructing first would bake in the early-give_up risk
 * before knowing whether it exists.
 */
export const renderAdvice = (a: Advice): string | null => {
  const lines: string[] = []
  if (a.warnRepeat) {
    lines.push(
      `- You have already tried this exact action and got the same result ${a.repeatedTimes} times.`,
    )
  }
  if (a.warnBudget) {
    lines.push(`- Steps remaining: ${a.stepsRemaining}.`)
  }
  return lines.length === 0 ? null : ['Notices:', ...lines].join('\n')
}
```

Change `renderPrompt` to take the advice and render it between the state and the history:

```ts
export const renderPrompt = (
  goal: string,
  snapshot: WorldSnapshot,
  steps: readonly Step[],
  advice: Advice,
): ChatMessage[] => {
  const window = steps.slice(-HISTORY_WINDOW)
  const history =
    window.length === 0
      ? 'Recent actions: (none yet)'
      : ['Recent actions:', ...window.map(renderStep)].join('\n')
  const notices = renderAdvice(advice)

  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        `Goal: ${goal}`,
        '',
        renderSnapshot(snapshot),
        '',
        ...(notices === null ? [] : [notices, '']),
        history,
      ].join('\n'),
    },
  ]
}
```

Add the import at the top of the file:

```ts
import type { Advice } from './advice.js'
```

- [ ] **Step 4: Call it from the loop**

In `packages/agent/src/loop.ts`, replace the `decider.decide(...)` call's first argument:

```ts
        const advice = advise(steps, { stepsTaken: steps.length, maxSteps, stuckThreshold })
        decided = await decider.decide(
          renderPrompt(goal, snapshot, steps, advice),
          controller.signal,
        )
```

- [ ] **Step 5: Export and verify**

Add `renderAdvice` to the `prompt.js` export block in `packages/agent/src/index.ts`.

```bash
npm test && npm run typecheck && node scripts/check-invariants.mjs
```

**`packages/agent/src/probe.ts` is a known caller and WILL fail to typecheck** (it imports `renderPrompt` at line 23). That is the intended safety net. Fix it by calling `advise` with the scenario's own history, never by hand-making a quiet `Advice`:

```ts
import { advise } from './advice.js'
import { DEFAULT_MAX_STEPS, DEFAULT_STUCK_THRESHOLD } from './loop.js'

const advice = advise(scenario.history, {
  stepsTaken: scenario.history.length,
  maxSteps: DEFAULT_MAX_STEPS,
  stuckThreshold: DEFAULT_STUCK_THRESHOLD,
})
const messages = renderPrompt(scenario.goal, snapshot(...), scenario.history, advice)
```

This matters more than it looks. A hand-made `Advice` would make the probe measure a prompt the loop never actually produces — and the probe is the only instrument this phase has.

- [ ] **Step 6: Probe — a render change is a prompt change**

```bash
OLLAMA_HOST=http://100.96.8.28:11434 npm run agent:probe -- 4 5
```

Expected: identical to Task 0's baseline. No notice fires in any probe scenario (none has a repeat or a low budget), so **any movement here is a regression from the blank line, not from the notices** — investigate rather than accept it.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/prompt.ts packages/agent/src/loop.ts packages/agent/src/index.ts packages/agent/test/prompt.test.ts
git commit -m "feat(agent): show the model what the loop already knew

Spec §4.3. The loop could see that the model was repeating itself and how
close the budget was, and told it neither. Both now render as a conditional
notices block.

The block states facts and gives no instruction. Telling a model it has
three steps left may make it give up early — that is a real risk and it is
measured in a later task, not guessed at here.

Probed: unchanged against the baseline, which is the expected result since
no probe scenario triggers a notice."
```

---

## Task 3: The guards become nudges

**Files:**
- Modify: `packages/agent/src/loop.ts:9`, `packages/agent/src/step.ts:26-49`
- Modify: `packages/agent/test/loop.test.ts`

**Interfaces:**
- Consumes: `advise`, `isStuckForTest` from Task 1
- Produces: `DEFAULT_STUCK_THRESHOLD` — value changes 3 → 4, name and type unchanged

- [ ] **Step 1: Write the failing tests**

Append to `packages/agent/test/loop.test.ts`. **Use that file's existing harness** — `connected()`, `run(executor, llm, over)`, `FakeLlmClient(replies, { repeatLast })`, and `llm.requests` for inspecting what the model was shown. Do not add a second harness.

First add one constant beside the existing `WALK`/`FIND`/`DONE` ones:

```ts
const CHAT = '{"action":"chat","message":"hi"}'
```

Then:

```ts
describe('the stuck guard is a nudge before it is an executioner', () => {
  const promptsOf = (llm: FakeLlmClient): string[] =>
    llm.requests.map((r) => r.messages.map((x) => x.content).join('\n'))

  it('warns the model before ending the goal', async () => {
    const m = await connected()
    const llm = new FakeLlmClient([WALK], { repeatLast: true })
    const out = await run(m, llm, { maxSteps: 20 })

    expect(out.status).toBe('stuck')
    expect(promptsOf(llm).some((p) => p.includes('You have already tried'))).toBe(true)
  })

  it('does not fire at three repeats, which used to be fatal', async () => {
    // At the old default of 3 this run was already dead on the third WALK.
    // At 4 the model has had a notice and two turns to act on it.
    const m = await connected()
    const out = await run(m, new FakeLlmClient([WALK, WALK, WALK, DONE]))
    expect(out.status).toBe('done')
  })

  it('still stops a model that ignores the warning', async () => {
    const m = await connected()
    const out = await run(m, new FakeLlmClient([WALK], { repeatLast: true }), { maxSteps: 50 })
    expect(out.status).toBe('stuck')
    expect(out.steps.length).toBeLessThan(10)
  })
})

describe('the budget notice', () => {
  it('reaches the model before the budget runs out', async () => {
    const m = await connected()
    const llm = new FakeLlmClient([CHAT], { repeatLast: true })
    // stuckThreshold: 99 so this measures the BUDGET notice and nothing else —
    // repeated identical chats would otherwise trip the stuck guard first.
    await run(m, llm, { maxSteps: 5, stuckThreshold: 99 })

    const prompts = llm.requests.map((r) => r.messages.map((x) => x.content).join('\n'))
    expect(prompts.some((p) => p.includes('Steps remaining'))).toBe(true)
  })
})
```

**VERIFIED 2026-09-10: no existing test relies on the default threshold.** Every
`stuck` test in `loop.test.ts` passes `stuckThreshold` explicitly (lines 55, 65,
82, 105), so changing the default from 3 to 4 cannot break them. If one starts
failing, something other than this task is wrong.

- [ ] **Step 2: Run to verify they fail**

```bash
npm test -- loop
```

Expected: the "does not fire at three repeats" test FAILS with `expected 'stuck' to be 'done'` — the threshold is still 3.

- [ ] **Step 3: Raise the threshold**

In `packages/agent/src/loop.ts`:

```ts
/**
 * Ends a goal when one action-and-outcome signature occurs this many times
 * inside the last `threshold * 2` steps.
 *
 * WAS 3. Raised to 4 when the model started being WARNED at 2 (spec §5).
 * Warning at 2 while still killing at 3 gives it exactly one turn to act on
 * information it has never had before, then ends the goal anyway — which
 * would be shipping the old behaviour while claiming a nudge. Two turns is a
 * real chance, and costs one step out of sixteen.
 */
export const DEFAULT_STUCK_THRESHOLD = 4
```

- [ ] **Step 4: Give the statuses their stronger meanings**

In `packages/agent/src/step.ts`, replace the `GoalStatus` union with a documented one. The values are unchanged; only what they assert is:

```ts
export type GoalStatus =
  | 'done'
  | 'gave_up'
  /**
   * The budget ran out. As of Phase 4B the model was WARNED first — it saw
   * "Steps remaining: 3" and did not finish — so this is no longer "the loop
   * ran out of patience" but "the model had notice and did not use it".
   */
  | 'budget_exhausted'
  /**
   * The same action-and-outcome repeated past `stuckThreshold`. As of Phase 4B
   * the model was warned from the second occurrence, so this now means "the
   * model was told it was repeating and repeated anyway" rather than merely
   * "the loop noticed".
   */
  | 'stuck'
  | 'undecodable'
  | 'interrupted'
  | 'disconnected'
  | 'llm_error'
```

- [ ] **Step 5: Prove both guards can fire**

A notice that never renders and a threshold that never trips would both leave every test green (spec §6). Verify each fails when its guard is removed:

```bash
# 1. Break the repeat notice: in advice.ts, force warnRepeat to false.
npm test -- loop
# Expected: "warns the model before ending the goal" FAILS. Revert.

# 2. Break the budget notice: force warnBudget to false.
npm test -- loop
# Expected: "reaches the model before the budget runs out" FAILS. Revert.

# 3. Put the threshold back to 3.
npm test -- loop
# Expected: "does not fire at three repeats" FAILS. Revert.
```

Record in the commit that all three were seen to fail. A guard nobody has watched trigger is not yet known to work.

- [ ] **Step 6: Verify and commit**

```bash
npm test && npm run typecheck && node scripts/check-invariants.mjs
```

```bash
git add packages/agent/src/loop.ts packages/agent/src/step.ts packages/agent/test/loop.test.ts
git commit -m "feat(agent): the stuck guard warns before it kills

Spec §5. stuckThreshold 3 -> 4, because the model is now warned at 2.
Warning at 2 while killing at 3 leaves exactly one turn to act on
information it has never had, which would be the old behaviour wearing a
nudge's clothes. Two turns is a real chance and costs one step of sixteen.

stuck and budget_exhausted keep their values and gain stronger meanings:
both now assert the model had notice and continued anyway. Documented on
GoalStatus, because that is what a caller reads.

All three guards verified to fail when removed — the notice, the budget
notice, and the threshold."
```

---

## Task 4: The `exhausted` rule — spec §4.1 and §4.2

The flagship fix, and the one most likely to need more than one attempt. **Budget for that.** Phase 4A spent four candidates on a defect of exactly this shape, and three of them were wrongly declared ineffective on an unsound instrument.

**Files:**
- Modify: `packages/agent/src/prompt.ts` (the `SYSTEM` rules block), `packages/agent/src/probe.ts`
- Modify: `docs/superpowers/specs/2026-09-10-phase-4-track-b-failure-policy-design.md`

**Interfaces:**
- Consumes: Task 0's recorded baseline
- Produces: no code interface — prompt text and probe scenarios only

- [ ] **Step 1: Add BOTH scenarios before touching the prompt**

A rule that always answers `explore_for` passes the first scenario while being useless, so the control ships with it (spec §4.5). In `packages/agent/src/probe.ts`, after the `find_blocks found nothing` scenario:

```ts
  {
    // Spec §4.1. The measured defect: the model reasons "no more coal can be
    // collected from this position" and gives up on the GOAL. The position is
    // finished; the goal is not, and the report says so — "more ground
    // remains" is on the screen in front of it.
    name: 'position dead, ground remains',
    goal: 'get me some coal',
    inventory: [PICKAXE],
    position: COAL_AT,
    history: [
      found,
      step(
        2,
        { action: 'mine_block_at', ...COAL_AT, maxDistance: 32 },
        { kind: 'result', result: fail('not_found', `no block at ${COAL_AT.x},${COAL_AT.y},${COAL_AT.z}`) },
      ),
      step(
        3,
        { action: 'explore_for', names: ['coal_ore'], maxDistance: 64 },
        {
          kind: 'result',
          result: ok({ found: [], searchedTo: 32, exhausted: false }),
        },
      ),
    ],
    hoped: ['explore_for'],
  },
  {
    // THE PAIRED CONTROL (spec §4.5). Identical but exhausted: true. Without
    // this, "the rule works" and "the rule fires unconditionally" are
    // indistinguishable — the same reason the contract suite pairs every
    // hidden block with a visible one.
    name: 'position dead, search exhausted',
    goal: 'get me some coal',
    inventory: [PICKAXE],
    position: COAL_AT,
    history: [
      found,
      step(
        2,
        { action: 'mine_block_at', ...COAL_AT, maxDistance: 32 },
        { kind: 'result', result: fail('not_found', `no block at ${COAL_AT.x},${COAL_AT.y},${COAL_AT.z}`) },
      ),
      step(
        3,
        { action: 'explore_for', names: ['coal_ore'], maxDistance: 64 },
        {
          kind: 'result',
          result: ok({ found: [], searchedTo: 64, exhausted: true }),
        },
      ),
    ],
    hoped: ['give_up'],
  },
```

- [ ] **Step 2: Measure BEFORE the rule**

```bash
OLLAMA_HOST=http://100.96.8.28:11434 npm run agent:probe -- 4 5
```

Record both new rows. The expectation is that `position dead, ground remains` answers `give_up` — reproducing the defect. **If it already answers `explore_for`, stop and re-read:** either the scenario does not reproduce the defect, or the defect is gone, and writing a rule for it either way is writing a rule for nothing.

- [ ] **Step 3: Add the rule**

In `packages/agent/src/prompt.ts`, insert immediately **before** the `- Choose done as soon as the goal is met.` line:

```ts
  // Spec §4.1/§4.2. Positional and checkable by construction, which is the
  // whole point: Phase 4A measured that rewording a CLAIM failed 4/4 while
  // changing what the model is asked to CHECK worked 7/7. "Did the last
  // explore_for say nowhere left to search" is two lines of the prompt, not
  // an inference across the history.
  '- A position being finished does NOT mean the goal is impossible. Only give_up on',
  '  a search once an explore_for has reported "nowhere left to search". While any',
  '  report says "more ground remains", there is somewhere left to look — use',
  '  explore_for again.',
```

- [ ] **Step 4: Measure again, all scenarios**

```bash
OLLAMA_HOST=http://100.96.8.28:11434 npm run agent:probe -- 4 5
```

The bar (spec §6):

| Scenario | Required |
|---|---|
| `position dead, ground remains` | `explore_for` |
| `position dead, search exhausted` | `give_up` — **the control; if this also answers `explore_for` the rule is unconditional and has proved nothing** |
| every pre-existing scenario | unchanged from Task 0's baseline |

- [ ] **Step 5: If it did not work, iterate — but only on the check, never the claim**

Do **not** reword the sentence into a firmer version of the same assertion; that is the move Phase 4A measured failing three times. Change what the model is asked to look at. Candidates, in order of preference:

1. Make the report's own words the trigger, quoting the exact string `renderOutcome` emits.
2. Move the rule above the `not_found` rule that currently ends in `or give_up`, so the permissive one is read second.
3. Remove `or give_up` from that earlier rule, leaving `give_up` mentioned in exactly one place.

After each: re-run at 4 replicates. **Record every candidate and its result in the spec, including the failures** — Phase 4A's record of what did not work is the most reused part of that document.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/prompt.ts packages/agent/src/probe.ts docs/superpowers/specs/2026-09-10-phase-4-track-b-failure-policy-design.md
git commit -m "fix(agent): a dead position is not a dead goal

Spec §4.1/§4.2. The model reasoned 'no more coal can be collected from
this position' and gave up on the GOAL, with 'more ground remains' on the
screen in front of it.

The rule ties give_up to an observable fact — has an explore_for reported
'nowhere left to search' — rather than to a judgement. Phase 4A measured
that rewording a claim fails and changing what the model CHECKS works;
this is built that way on purpose.

This also answers the work-split note's 'retry with a wider radius?': no.
find_blocks is line-of-sight limited, so a bigger radius returns the same
nothing and costs 339ms instead of 75ms. The ladder is find_blocks ->
explore_for -> exhausted -> give_up, and it is ONE rule, not two that can
drift apart.

Ships with its paired control: an identical scenario with exhausted true,
where give_up is correct. Without it a rule that always says explore_for
would pass."
```

---

## Task 5: The `missing_tool` discrimination — spec §4.4

**Files:**
- Modify: `packages/agent/src/probe.ts`
- Modify: `docs/superpowers/specs/2026-09-10-phase-4-track-b-failure-policy-design.md`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: no code interface — one probe scenario

- [ ] **Step 1: Understand what is and is not being fixed**

The existing `after missing_tool, inventory empty` scenario answers `give_up`, and **that is correct**: empty inventory, no acquiring actions in the contract, nothing that can help. Making the model persist there would make it worse, and this task must not try.

What is measurable today is the discrimination: `missing_tool` on one target while another route remains open is not the same as the goal being impossible.

- [ ] **Step 2: Add the scenario**

In `packages/agent/src/probe.ts`, after the existing `after missing_tool, inventory empty` scenario:

```ts
  {
    // Spec §4.4. The DISCRIMINATION, not the acquire policy. The bot holds a
    // usable pickaxe and a second target is visible; missing_tool on ONE block
    // (deepslate needs better than stone) does not make the goal impossible.
    // The paired control is the pre-existing 'inventory empty' scenario above,
    // where give_up IS right — together they show the model is reading the
    // situation rather than reacting to the word missing_tool.
    name: 'missing_tool but another route remains',
    goal: 'get me some coal',
    inventory: [PICKAXE],
    history: [
      step(
        1,
        { action: 'find_blocks', names: ['coal_ore'], maxDistance: 32, limit: 5 },
        {
          kind: 'blocks',
          blocks: [
            { name: 'deepslate_coal_ore', position: { x: 20, y: 55, z: -30 }, distance: 9.5 },
            { name: 'coal_ore', position: COAL_AT, distance: 7.94 },
          ],
        },
      ),
      step(
        2,
        { action: 'mine_block_at', x: 20, y: 55, z: -30, maxDistance: 32 },
        { kind: 'result', result: fail('missing_tool', 'needs an iron pickaxe or better') },
      ),
    ],
    hoped: ['mine_block_at'],
  },
```

- [ ] **Step 3: Measure**

```bash
OLLAMA_HOST=http://100.96.8.28:11434 npm run agent:probe -- 4 5
```

Two outcomes, both useful and both recorded:

- **On target (`mine_block_at`)** — the model already discriminates. **Write no rule.** Spec §2 requires a code or prompt addition to be earned by a measured failure, and this would be neither.
- **Off target (`give_up`)** — a real defect. Add a rule on the §4.1 pattern: tie it to something checkable, such as whether another target appears in the most recent `find_blocks` result. Re-measure, and confirm the `inventory empty` control still answers `give_up`.

- [ ] **Step 4: Record and commit**

Record the result in the spec under §4.4 either way — "measured, no fix needed" is a result, and an undocumented one gets re-investigated by the next person.

```bash
git add packages/agent/src/probe.ts docs/superpowers/specs/2026-09-10-phase-4-track-b-failure-policy-design.md
git commit -m "test(agent): missing_tool on one target is not a dead goal

Spec §4.4. The existing 'inventory empty' scenario answers give_up and
that is CORRECT — nothing in the contract can fetch a pickaxe. What is
measurable today is the discrimination: one unminable target while another
is visible.

The two scenarios are each other's control. Together they show whether the
model reads the situation or reacts to the word missing_tool."
```

---

## Task 6: The acquire requirement, and the docs

**Files:**
- Create: `docs/notes/resource-acquisition-requirement.md`
- Modify: `CLAUDE.md`, `docs/notes/Phase Plan and Parallel Work Split.md`

**Interfaces:**
- Consumes: spec §8
- Produces: the written requirement the new Track A phase starts from

- [ ] **Step 1: Write the requirement**

Create `docs/notes/resource-acquisition-requirement.md`. This is Phase 4B's entire output for the deferred half, so it must stand alone for someone who has read none of this:

```markdown
# Requirement: Resource Acquisition

**Owner:** a Track A phase after Phase 5. **Agreed with Ricky 2026-09-10.**

## What is wanted

When the bot lacks something it needs — no pickaxe, no dirt — the right
response is to go and get more, not to abandon the goal:

1. Check the relevant container first.
2. If it is empty, gather from a **designated** area, never an undesignated one.

## Why it is not in Phase 4B

The actions do not exist. Measured 2026-09-10:

- `packages/contract` has **no container actions at all** — no chest, open,
  withdraw or deposit.
- **"Designated area" exists nowhere** in the repo.

A model told to go and get dirt with nothing that can get dirt will pick an
action, fail, and pick again. Phase 4B therefore fixes only the half that needs
no new actions: `missing_tool` on one target must not end the goal when another
route remains.

## What the phase must deliver

- Contract actions for containers. Shared surface, so it needs agreement before
  it lands.
- A designated-area allowlist, **enforced in the executor**. Not a prompt rule:
  a check the model cannot argue its way past. This repo has measured prompt
  prohibitions failing — the Phase 4A `move_to` rule took four candidates.
- The gathering behaviour on top.

## Why it belongs with Phase 5's build safety

Phase 5 needs to know whether a block in the way is a player's build or a
natural tree. That is **not reliably decidable** — Minecraft's world data carries
no player-placed flag, and crafted block types misfire on villages. The robust
mechanism is the same designated-area allowlist. Designing it once serves both.
```

- [ ] **Step 2: Record the phase in the split note**

In `docs/notes/Phase Plan and Parallel Work Split.md`, add between Phase 5 and Phase 6:

```markdown
## Phase 6 — Resource acquisition (Track A)

**Blocked by:** Phase 5. **Agreed 2026-09-10.**

Containers, the designated-area allowlist, and gathering. See
[the requirement](./resource-acquisition-requirement.md). Multi-bot scaling,
previously Phase 6, becomes Phase 7.
```

Renumber the old Phase 6 heading to Phase 7 and update the mermaid graph's `P6` node accordingly.

- [ ] **Step 3: Update CLAUDE.md**

The scope boundary for `packages/agent` currently reads *"It codes **no per-`FailureReason` retry policy**; that is Phase 4's"*. That is now stale in a way that will mislead. Replace with:

```markdown
- `packages/agent/` is the planning loop. It must never depend on `mineflayer` **or `@minebot/executor`** — `check-invariants.mjs` enforces both, including the transitive case, and reports 2 of 2. Anything needing both tracks belongs in `packages/bot/`. It still codes **no per-`FailureReason` branching**: Phase 4B kept that bet and put the burden of proof on any code rule — fix it in the prompt, measure it replicated, add code only for a case the prompt measurably fails, citing the measurement. `advice.ts` reports facts about the run and has no power to rewrite or veto the model's choice.
```

Add to the Verified environment facts table:

```markdown
| A single `agent:probe` run cannot judge a prompt change | One byte-identical prompt gave `give_up` in nine runs and `move_to` in five, each run internally unanimous. The probe spawns a fresh process per replicate; treat an `UNSTABLE` flag as "no result", not "a result" |
| Rewording or reordering a prompt *claim* measured 4/4 failures; changing *what the model is asked to check* worked 7/7 | Write rules the model can verify against two lines of its own prompt, not ones it must infer from the step history |
```

- [ ] **Step 4: Commit**

```bash
git add docs CLAUDE.md
git commit -m "docs: record the acquire requirement and renumber the phases

Spec §8. Resource acquisition becomes its own Track A phase after Phase 5,
carrying containers, the designated-area allowlist and gathering; multi-bot
scaling moves to Phase 7.

The allowlist is also what Phase 5's build-safety problem needs — whether a
block in the way is a player's build is not reliably decidable, so the
robust answer is a permission list rather than an inference. Designing it
once serves both.

CLAUDE.md's 'no retry policy, that is Phase 4's' is now stale and would
mislead: Phase 4B kept the bet rather than spending it."
```

---

## Task 7: The merge sweep, the live gate, and the PR

**Files:**
- Modify: `docs/superpowers/specs/2026-09-10-phase-4-track-b-failure-policy-design.md`, `README.md`

**Interfaces:**
- Consumes: everything above
- Produces: the PR

- [ ] **Step 1: Full offline sweep**

```bash
npm test
npm run typecheck
node scripts/check-invariants.mjs
npm run agent:demo
OLLAMA_HOST=http://100.96.8.28:11434 npm run agent:probe -- 6 5
```

`agent:demo` is in this list on purpose: it runs the loop end to end against the fake model and mock world, and it lives **outside `npm test`**. Phase 4A shipped two broken scripts past a green suite for exactly that reason.

- [ ] **Step 2: Record the final measurements in the spec**

A `## 12. Results` section: the Task 0 baseline and the final table side by side, every scenario, at 6 replicates. Include each candidate that failed along the way (Task 4 Step 5) — the record of what did not work is the most reused part of a document like this.

- [ ] **Step 3: Open the PR with the live gate stated as blocking**

The PR body must carry, prominently:

```markdown
## BLOCKING: live validation, and I could not run it

Everything above ran offline. That is precisely the condition under which
Phase 4A shipped `bench:world` dead and `demo:phase2` passing only because
`findBlocks` saw through stone — `scripts/` and `demo:*` are outside `npm test`.

**Do not merge without someone on the dev box confirming:**

1. A goal that genuinely cannot be satisfied ends in a clean `gave_up` carrying
   `exhausted` evidence — not `budget_exhausted`, not `stuck`.
2. The notices appear in real step logs, in real runs.
3. `demo:phase3` and `demo:phase4` still exit 0.

The Minecraft backend is loopback-only on bellatrix and SSH is refused, so this
is a handoff, not an oversight.
```

- [ ] **Step 4: Commit and push**

```bash
git add docs README.md
git commit -m "docs(phase4b): record the measured results, and the live gate

Baseline and final side by side at 6 replicates, plus every candidate that
failed on the way to the one that worked."
git push -u origin phase-4-track-b
```

Then write the PR body to a file and open it — the body is long and carries the
blocking gate above, so it does not belong inline in a shell argument:

```bash
gh pr create --title "Phase 4 (Track B): failure policy — prompt first" --body-file pr-body.md
rm pr-body.md
```

---

## Self-review

**Spec coverage**

| Spec section | Task |
|---|---|
| §2 the bet, code rules must be earned | Global Constraints; Task 5 Step 3 applies it |
| §3 `advice.ts`, facts never actions | Task 1 |
| §3.1 the shared signature | Task 1 Steps 4-5 |
| §4.1/§4.2 the `exhausted` rule | Task 4 |
| §4.3 the guard notices, early-give_up risk | Tasks 2 and 3 |
| §4.4 `missing_tool` discrimination | Task 5 |
| §4.5 paired controls | Task 4 Step 1, Task 5 Step 2 |
| §5 `stuck`/`budget_exhausted` | Task 3 |
| §6 testing, baseline, prove guards fire | Task 0, Task 1 Step 7, Task 3 Step 5 |
| §7 the live gate | Task 7 Step 3 |
| §8 scope boundaries, the acquire requirement | Task 6 |
| §9 decisions | recorded in the spec; no task needed |
| §10 risks | 1 → Task 4 Step 5; 2 → Task 2 Step 6 and Task 3; 3 → Task 4 Step 4; 4 → Task 7 Step 3 |

**Type consistency:** `Advice` has the same four fields in Tasks 1, 2 and 3. `advise(steps, opts)` takes `{stepsTaken, maxSteps, stuckThreshold}` at every call site. `renderPrompt`'s fourth parameter is `Advice` in both the definition and the loop's call.

**Harness check (was a defect, now fixed):** Task 3's tests originally named
`recordingDecider`, `scripted`, `repeat`, `failing` and `ok` as if they existed
in `loop.test.ts`. None do. They are rewritten against the real harness —
`connected()`, `run()`, `FakeLlmClient(replies, { repeatLast })` and
`llm.requests` — and the threshold change is confirmed safe against every
existing test that touches it.
