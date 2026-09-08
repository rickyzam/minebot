import { describe, it, expect } from 'vitest'
import { MockExecutor, type MockOptions } from '@minebot/mock-executor'
import { runGoal } from '../src/loop.js'
import { SchemaDecider, type Decider } from '../src/decide.js'
import { FakeLlmClient } from '../src/fake-llm.js'

const coal = { name: 'coal_ore', position: { x: 18, y: 60, z: -34 }, distance: 7.94 }
const pickaxe = { name: 'stone_pickaxe', count: 1, slot: 0 }

const connected = async (over: MockOptions = {}) => {
  const m = new MockExecutor({ blocks: [coal], inventory: [pickaxe], ...over })
  await m.connect()
  return m
}

const FIND = '{"action":"find_blocks","names":["coal_ore"],"maxDistance":32,"limit":5}'
const MINE_AT = '{"action":"mine_block_at","x":18,"y":60,"z":-34,"maxDistance":32}'
const DONE = '{"action":"done","summary":"mined one coal ore"}'
const WALK = '{"action":"move_to","x":1,"y":64,"z":1}'

const run = (executor: MockExecutor, llm: FakeLlmClient, over = {}) =>
  runGoal('get me some coal', { executor, decider: new SchemaDecider(llm), ...over })

describe('runGoal — the happy path', () => {
  it('searches, mines the exact block it found, and stops on done', async () => {
    const m = await connected()
    const out = await run(m, new FakeLlmClient([FIND, MINE_AT, DONE]))

    expect(out.status).toBe('done')
    expect(out.status === 'done' && out.summary).toBe('mined one coal ore')
    expect(out.steps).toHaveLength(3)

    // The position form proves the loop mined the block it had just found,
    // rather than re-searching by name and possibly getting another.
    expect(m.calls.map((c) => c.name)).toEqual(['connect', 'mineBlock'])
    expect(m.calls[1]?.args[0]).toEqual({ x: 18, y: 60, z: -34 })
    expect(m.getState().self.inventory.some((i) => i.name === 'coal_ore')).toBe(true)
  })

  it('shows the search result to the model on the next turn', async () => {
    const m = await connected()
    const llm = new FakeLlmClient([FIND, MINE_AT, DONE])
    await run(m, llm)
    expect(llm.requests[1]?.messages.map((x) => x.content).join('\n')).toContain(
      'coal_ore at (18, 60, -34)',
    )
  })
})

describe('runGoal — the guards', () => {
  it('stops at the step budget', async () => {
    const m = await connected()
    const out = await run(m, new FakeLlmClient([WALK], { repeatLast: true }), {
      maxSteps: 4,
      stuckThreshold: 99,
    })
    expect(out.status).toBe('budget_exhausted')
    expect(out.steps).toHaveLength(4)
  })

  it('stops when the same action keeps producing the same result', async () => {
    const m = await connected()
    const out = await run(m, new FakeLlmClient([WALK], { repeatLast: true }), {
      maxSteps: 20,
      stuckThreshold: 3,
    })
    expect(out.status).toBe('stuck')
    expect(out.steps).toHaveLength(3)
  })

  it('stops when two useless actions alternate instead of repeating', async () => {
    // VERIFIED against the live server: the loop oscillated
    //   move_to -> mine_block_at -> move_to -> mine_block_at -> ...
    // making no progress. The old guard needed `stuckThreshold` IDENTICAL
    // consecutive signatures, so the interleaving broke the run every time and
    // it never fired. That run only ended because the model volunteered
    // give_up; a less cooperative one would have burned the whole budget.
    const m = await connected()
    const llm = new FakeLlmClient([WALK, FIND, WALK, FIND, WALK, FIND, WALK, FIND], {
      repeatLast: true,
    })
    const out = await run(m, llm, { maxSteps: 20, stuckThreshold: 3 })

    expect(out.status).toBe('stuck')
    // Three occurrences of one signature inside a window of six steps.
    expect(out.steps.length).toBeLessThanOrEqual(6)
  })

  it('does not call genuine progress stuck', async () => {
    // The guard must not fire on a run that repeats an ACTION TYPE while
    // actually getting somewhere — mining three different ores is
    // find/mine/find/mine, which is exactly the shape the alternating guard
    // looks for. The signature includes the action's arguments, so different
    // targets are different signatures and this must still reach done.
    const m = await connected()
    const llm = new FakeLlmClient([
      FIND,
      '{"action":"mine_block_at","x":18,"y":60,"z":-34,"maxDistance":32}',
      FIND,
      '{"action":"move_to","x":5,"y":64,"z":5}',
      FIND,
      '{"action":"move_to","x":9,"y":64,"z":9}',
      DONE,
    ])
    const out = await run(m, llm, { maxSteps: 20, stuckThreshold: 3 })
    expect(out.status).toBe('done')
  })

  it('stops after consecutive unusable replies', async () => {
    const m = await connected()
    const out = await run(m, new FakeLlmClient(['not an action'], { repeatLast: true }), {
      maxUndecodable: 3,
    })
    expect(out.status).toBe('undecodable')
    expect(out.steps).toHaveLength(3)
    expect(out.steps.every((s) => s.action === null && s.decodeError !== null)).toBe(true)
  })

  it('recovers when a bad reply is followed by a good one', async () => {
    const m = await connected()
    const out = await run(m, new FakeLlmClient(['junk', 'junk again', DONE]))
    expect(out.status).toBe('done')
  })

  // Probing showed the model handed an impossible goal chatting about it and
  // then grinding to the budget, where "impossible" and "the loop
  // malfunctioned" are the same outcome. give_up separates them and carries
  // the reason (design §4.0).
  it("ends on give_up, carrying the model's reason, without spending the budget", async () => {
    const m = await connected({ inventory: [] })
    const llm = new FakeLlmClient([
      '{"action":"give_up","reason":"no pickaxe and no way to get one"}',
    ])
    const out = await run(m, llm, { maxSteps: 16 })

    expect(out.status).toBe('gave_up')
    expect(out.status !== 'done' && out.detail).toBe('no pickaxe and no way to get one')
    expect(out.steps).toHaveLength(1)
    expect(llm.requests).toHaveLength(1)
  })
})

describe('runGoal — cancellation', () => {
  it('reports interrupted when the caller aborts before the first step', async () => {
    const m = await connected()
    const ac = new AbortController()
    ac.abort()
    const out = await run(m, new FakeLlmClient([DONE], { repeatLast: true }), { signal: ac.signal })
    expect(out.status).toBe('interrupted')
    expect(out.steps).toHaveLength(0)
  })

  // Design §8 rule 3, and the one obligation spec §3.5 places on this track:
  // an interrupted action is a re-plan, not a failure and not a retry. The
  // reflex layer preempting must not end the goal.
  it('re-plans after an interrupted action instead of ending the goal', async () => {
    const m = await connected({ failures: { moveTo: { reason: 'interrupted', detail: 'reflex' } } })
    const out = await run(m, new FakeLlmClient([WALK, DONE]), { maxSteps: 5 })

    expect(out.status).toBe('done')
    expect(out.steps).toHaveLength(2)
    const first = out.steps[0]?.outcome
    expect(first?.kind === 'result' && first.result.ok === false && first.result.reason).toBe(
      'interrupted',
    )
  })
})

describe('runGoal — things going wrong outside the model', () => {
  it('reports disconnected rather than throwing when getState throws', async () => {
    const m = new MockExecutor({ blocks: [coal] }) // never connected
    const out = await run(m, new FakeLlmClient([DONE], { repeatLast: true }))
    expect(out.status).toBe('disconnected')
    expect(out.status !== 'done' && out.detail).toContain('getState')
  })

  it('reports llm_error rather than throwing when the model is unreachable', async () => {
    const m = await connected()
    const broken: Decider = {
      async decide() {
        throw new Error('connect ECONNREFUSED 127.0.0.1:11434')
      },
    }
    const out = await runGoal('anything', { executor: m, decider: broken })
    expect(out.status).toBe('llm_error')
    expect(out.status !== 'done' && out.detail).toContain('ECONNREFUSED')
  })
})

// The single most important test in this package. It is the only one that
// proves the feedback path — the thing standing in for a retry policy until
// Phase 4 — actually carries a failure back to the model. CLAUDE.md: when you
// add a guard, prove it can fire.
describe('runGoal — failure feedback', () => {
  it('puts the failure reason and detail into the next prompt', async () => {
    const m = await connected({ inventory: [] })
    m.setFailure('mineBlock', { reason: 'missing_tool', detail: 'no pickaxe in inventory' })

    const llm = new FakeLlmClient(['{"action":"mine_nearest_block","name":"coal_ore","maxDistance":32}', DONE])
    const out = await run(m, llm)

    expect(out.status).toBe('done')
    expect(llm.requests).toHaveLength(2)
    expect(llm.lastPromptText()).toContain('FAILED (missing_tool): no pickaxe in inventory')
  })
})
