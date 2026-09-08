import type { BlockInfo, Result } from '@minebot/contract'
import type { ActionRequest } from './actions.js'
import type { DecodeError } from './decide.js'

/**
 * `find_blocks` is the one menu entry whose outcome is not a `Result` —
 * `findBlocks` returns an array and throws when disconnected, because it has
 * no `Result` to report failure through and a silent `[]` would be
 * indistinguishable from "searched, found nothing" (contract, design §7.3).
 */
export type StepOutcome =
  | { readonly kind: 'blocks'; readonly blocks: readonly BlockInfo[] }
  | { readonly kind: 'result'; readonly result: Result<unknown> }
  | { readonly kind: 'undecodable' }
  | { readonly kind: 'done' }
  | { readonly kind: 'gave_up' }

export interface Step {
  readonly n: number
  readonly raw: string
  readonly action: ActionRequest | null
  readonly decodeError: DecodeError | null
  readonly outcome: StepOutcome
}

export type GoalStatus =
  | 'done'
  | 'gave_up'
  | 'budget_exhausted'
  | 'stuck'
  | 'undecodable'
  | 'interrupted'
  | 'disconnected'
  | 'llm_error'

/**
 * Failure is a returned value, never a thrown error — the same reasoning the
 * contract gives for `Result`, one layer up. Every outcome carries the full
 * step log, which is the debugging artifact and the raw material Phase 4's
 * retry policy gets written against.
 */
export type GoalOutcome =
  | { readonly status: 'done'; readonly summary: string; readonly steps: readonly Step[] }
  | {
      readonly status: Exclude<GoalStatus, 'done'>
      readonly detail: string
      readonly steps: readonly Step[]
    }
