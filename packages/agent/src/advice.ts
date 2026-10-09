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
