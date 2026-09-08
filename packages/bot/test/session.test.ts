import { describe, it, expect } from 'vitest'
import { MockExecutor } from '@minebot/mock-executor'
import { FakeLlmClient, SchemaDecider } from '@minebot/agent'
import { fail, type Result } from '@minebot/contract'
import { runBotGoal } from '../src/session.js'

const decider = (...replies: string[]): SchemaDecider =>
  new SchemaDecider(new FakeLlmClient(replies))

describe('runBotGoal', () => {
  it('connects before running and disconnects after', async () => {
    const executor = new MockExecutor({
      blocks: [{ name: 'coal_ore', position: { x: 4, y: 64, z: 0 }, distance: 4 }],
    })
    const outcome = await runBotGoal('get me some coal', {
      executor,
      decider: decider('{"action":"done","summary":"nothing to do"}'),
    })

    expect(outcome.status).toBe('done')
    const calls = executor.calls.map((c) => c.name)
    expect(calls[0]).toBe('connect')
    expect(calls.at(-1)).toBe('disconnect')
    // getState() throws once disconnected — the cheapest proof it really happened.
    expect(() => executor.getState()).toThrow()
  })

  it('disconnects even when the goal ends badly', async () => {
    const executor = new MockExecutor()
    // Six junk replies for three undecodable steps, not three: SchemaDecider
    // spends TWO model calls on a step it cannot decode — the initial reply
    // plus exactly one repair attempt. A three-reply script exhausts the fake
    // mid-repair and surfaces as llm_error instead, which is a different exit
    // path and would not prove what this test is about.
    const outcome = await runBotGoal('impossible', {
      executor,
      decider: decider('junk 1', 'junk 2', 'junk 3', 'junk 4', 'junk 5', 'junk 6'),
    })

    expect(outcome.status).toBe('undecodable')
    expect(() => executor.getState()).toThrow()
  })

  it('reports disconnected without running the loop when connect() fails', async () => {
    // MockExecutor's failure injection covers the six actions, not connect(),
    // so subclass rather than stub — it keeps the executor fully typed.
    class UnconnectableExecutor extends MockExecutor {
      override async connect(): Promise<Result> {
        return fail('disconnected', 'no server')
      }
    }

    const llm = new FakeLlmClient(['{"action":"done","summary":"never reached"}'])
    const outcome = await runBotGoal('anything', {
      executor: new UnconnectableExecutor(),
      decider: new SchemaDecider(llm),
    })

    expect(outcome.status).toBe('disconnected')
    expect(outcome.steps).toHaveLength(0)
    // The model must never be consulted for a session that never opened.
    expect(llm.requests).toHaveLength(0)
  })
})
