import type { BotExecutor, WorldSnapshot } from '@minebot/contract'
import type { DecideResult, Decider } from './decide.js'
import { dispatch } from './dispatch.js'
import { isAbortError } from './llm.js'
import { renderPrompt } from './prompt.js'
import type { GoalOutcome, Step, StepOutcome } from './step.js'

export const DEFAULT_MAX_STEPS = 16
export const DEFAULT_STUCK_THRESHOLD = 3
export const DEFAULT_MAX_UNDECODABLE = 3

export interface RunGoalOptions {
  /** Must already be connected. Session lifecycle belongs to the caller. */
  readonly executor: BotExecutor
  readonly decider: Decider
  readonly maxSteps?: number
  readonly stuckThreshold?: number
  readonly maxUndecodable?: number
  readonly signal?: AbortSignal
}

const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e))

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

const signatureOf = (s: Step): string | null =>
  s.action === null ? null : `${JSON.stringify(s.action)}|${outcomeSignature(s.outcome)}`

/**
 * Has the run stopped making progress?
 *
 * Fires when one action-and-outcome signature occurs `threshold` times inside
 * the last `threshold * 2` steps — NOT only when they are consecutive.
 *
 * VERIFIED against the live server: the loop oscillated
 * `move_to -> mine_block_at -> move_to -> mine_block_at` around a block that no
 * longer existed. The old rule required `threshold` IDENTICAL CONSECUTIVE
 * signatures, so each interleaved action reset it and the guard never fired.
 * That run ended only because the model chose to give up; nothing in the loop
 * would have stopped it. Two useless actions taking turns is exactly as stuck
 * as one repeated, and far more likely than a model repeating itself verbatim.
 *
 * A window rather than a global count, so a long run is not condemned by
 * something it did and recovered from many steps ago. The signature includes
 * the action's arguments, so mining three different blocks is three different
 * signatures and never trips this.
 */
const isStuck = (steps: readonly Step[], threshold: number): boolean => {
  if (threshold < 1 || steps.length < threshold) return false
  const counts = new Map<string, number>()
  for (const s of steps.slice(-threshold * 2)) {
    const signature = signatureOf(s)
    if (signature === null) continue
    const seen = (counts.get(signature) ?? 0) + 1
    if (seen >= threshold) return true
    counts.set(signature, seen)
  }
  return false
}

/**
 * Observe, decide, dispatch, record — until the model says done or give_up, or
 * a guard stops it. Failure is always a returned value; nothing here throws.
 *
 * Deliberately no per-`FailureReason` branching. Every outcome is rendered into
 * the history the model reads next turn, and the model decides. Phase 4 writes
 * the real policy against the step logs this produces, rather than against
 * failures nobody has observed yet.
 */
export async function runGoal(goal: string, opts: RunGoalOptions): Promise<GoalOutcome> {
  const { executor, decider, signal: outer } = opts
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS
  const stuckThreshold = opts.stuckThreshold ?? DEFAULT_STUCK_THRESHOLD
  const maxUndecodable = opts.maxUndecodable ?? DEFAULT_MAX_UNDECODABLE

  const steps: Step[] = []
  let consecutiveUndecodable = 0

  for (let n = 1; n <= maxSteps; n++) {
    if (outer?.aborted) {
      return { status: 'interrupted', detail: 'the caller aborted the goal', steps }
    }

    // getState() throws when disconnected — one of only two such sites, the
    // other being find_blocks inside dispatch (design §7.3).
    let snapshot: WorldSnapshot
    try {
      snapshot = executor.getState()
    } catch (e) {
      return { status: 'disconnected', detail: `getState() threw: ${describeError(e)}`, steps }
    }

    const controller = new AbortController()
    const relay = (): void => controller.abort()
    outer?.addEventListener('abort', relay, { once: true })

    try {
      let decided: DecideResult
      try {
        decided = await decider.decide(renderPrompt(goal, snapshot, steps), controller.signal)
      } catch (e) {
        return isAbortError(e)
          ? { status: 'interrupted', detail: 'the model call was aborted', steps }
          : { status: 'llm_error', detail: describeError(e), steps }
      }

      if (!decided.ok) {
        consecutiveUndecodable += 1
        steps.push({
          n,
          raw: decided.raw,
          action: null,
          decodeError: decided.error,
          outcome: { kind: 'undecodable' },
        })
        if (consecutiveUndecodable >= maxUndecodable) {
          return {
            status: 'undecodable',
            detail: `${consecutiveUndecodable} unusable replies in a row; the last was ${decided.error.kind}`,
            steps,
          }
        }
        continue
      }
      consecutiveUndecodable = 0

      let outcome: StepOutcome
      try {
        outcome = await dispatch(decided.action, executor, controller.signal)
      } catch (e) {
        return { status: 'disconnected', detail: `findBlocks() threw: ${describeError(e)}`, steps }
      }

      steps.push({ n, raw: decided.raw, action: decided.action, decodeError: null, outcome })

      if (decided.action.action === 'done') {
        return { status: 'done', summary: decided.action.summary, steps }
      }

      // The model's own verdict that the goal is unreachable, carrying its
      // reason. Distinguishable from budget_exhausted, which is the loop
      // running out of patience rather than the model reaching a conclusion.
      if (decided.action.action === 'give_up') {
        return { status: 'gave_up', detail: decided.action.reason, steps }
      }

      // The caller aborting ends the goal. An `interrupted` result *without* an
      // outer abort is the reflex layer preempting: fall through, re-observe,
      // and decide again from fresh state. Never retry the interrupted action
      // against the snapshot it was chosen for — after a flee, that position is
      // a lie (design §8, spec §3.5).
      if (outer?.aborted) {
        return { status: 'interrupted', detail: 'the caller aborted the goal', steps }
      }

      if (isStuck(steps, stuckThreshold)) {
        return {
          status: 'stuck',
          detail: `the same action produced the same result ${stuckThreshold} times running`,
          steps,
        }
      }
    } finally {
      outer?.removeEventListener('abort', relay)
    }
  }

  return { status: 'budget_exhausted', detail: `no done after ${maxSteps} steps`, steps }
}
