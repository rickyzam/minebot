import type { BotExecutor } from '@minebot/contract'
import { runGoal, type Decider, type GoalOutcome } from '@minebot/agent'

/**
 * The composition root: the one place `@minebot/agent` and `@minebot/executor`
 * are both in scope.
 *
 * It lives here rather than in either track's package because both would break
 * a design spec §4 guarantee — `packages/agent` must be buildable with no game
 * libraries at all, and `packages/executor` has no business knowing an LLM
 * exists. See the Phase 3 design §3.
 */
export interface RunBotGoalOptions {
  /**
   * Built but NOT connected. `runGoal` requires an already-connected executor
   * and leaves lifecycle to its caller; this function is that caller.
   */
  readonly executor: BotExecutor
  readonly decider: Decider
  readonly maxSteps?: number
  readonly stuckThreshold?: number
  readonly signal?: AbortSignal
}

/**
 * Connect, pursue `goal`, and always disconnect.
 *
 * The `finally` is load-bearing: an integration test that leaks a bot onto the
 * shared dev server poisons every test that runs after it, and `runGoal`
 * returning failure as a value means the only way out of here without
 * disconnecting would be a thrown error.
 */
export async function runBotGoal(
  goal: string,
  opts: RunBotGoalOptions,
): Promise<GoalOutcome> {
  const { executor, decider, maxSteps, stuckThreshold, signal } = opts

  const connected = await executor.connect()
  if (!connected.ok) {
    // Never consult the model for a session that never opened — it costs a
    // round trip to answer a question about a world nobody can see.
    return {
      status: 'disconnected',
      detail: `connect() failed: ${connected.reason}: ${connected.detail}`,
      steps: [],
    }
  }

  try {
    return await runGoal(goal, { executor, decider, maxSteps, stuckThreshold, signal })
  } finally {
    await executor.disconnect()
  }
}
