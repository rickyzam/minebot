import { ok, type BotExecutor } from '@minebot/contract'
import { positionOf, type ActionRequest } from './actions.js'
import type { StepOutcome } from './step.js'

/**
 * The one place the model's menu is translated into contract calls. No LLM
 * here, which is what makes this exhaustively testable against `MockExecutor`.
 *
 * `find_blocks` is the exception to "everything resolves": `findBlocks` throws
 * when disconnected, and that throw is deliberately allowed through rather
 * than converted. `runGoal` catches it and reports `disconnected`; swallowing
 * it here would make a dropped connection look like an empty search, which is
 * exactly the confusion the contract's doc comment says to avoid.
 */
export async function dispatch(
  action: ActionRequest,
  executor: BotExecutor,
  signal: AbortSignal,
): Promise<StepOutcome> {
  switch (action.action) {
    case 'find_blocks':
      return {
        kind: 'blocks',
        blocks: executor.findBlocks({
          names: action.names,
          maxDistance: action.maxDistance,
          limit: action.limit,
        }),
      }

    case 'move_to':
      return { kind: 'result', result: await executor.moveTo(positionOf(action), { signal }) }

    case 'mine_nearest_block':
      return {
        kind: 'result',
        result: await executor.mineBlock(action.name, action.maxDistance, { signal }),
      }

    case 'mine_block_at':
      return {
        kind: 'result',
        result: await executor.mineBlock(positionOf(action), action.maxDistance, { signal }),
      }

    case 'chat':
      // `chat` returns void on the contract — there is nothing to await and no
      // Result to report, so a synchronous success stands in for one.
      executor.chat(action.message)
      return { kind: 'result', result: ok(undefined) }

    case 'done':
      return { kind: 'done' }

    case 'give_up':
      return { kind: 'gave_up' }
  }
}
