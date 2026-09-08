import { describe, it, expect } from 'vitest'
import { MockExecutor } from '@minebot/mock-executor'
import { dispatch } from '../src/dispatch.js'

const coal = { name: 'coal_ore', position: { x: 18, y: 60, z: -34 }, distance: 7.94 }
const live = () => new AbortController().signal

const connected = async () => {
  const m = new MockExecutor({ blocks: [coal] })
  await m.connect()
  return m
}

describe('dispatch', () => {
  it('turns find_blocks into a findBlocks query', async () => {
    const m = await connected()
    const out = await dispatch(
      { action: 'find_blocks', names: ['coal_ore'], maxDistance: 32, limit: 5 },
      m,
      live(),
    )
    expect(out).toEqual({ kind: 'blocks', blocks: [coal] })
  })

  it('turns move_to into moveTo with a Vec3', async () => {
    const m = await connected()
    await dispatch({ action: 'move_to', x: 1, y: 64, z: -3 }, m, live())
    expect(m.calls.at(-1)).toEqual({ name: 'moveTo', args: [{ x: 1, y: 64, z: -3 }] })
  })

  // Both mining actions collapse onto the one contract method. The distinction
  // that matters is the target form: a name re-searches, a position names the
  // exact block the planner reasoned about (design §4.2).
  it('sends a name for mine_nearest_block', async () => {
    const m = await connected()
    await dispatch({ action: 'mine_nearest_block', name: 'coal_ore', maxDistance: 32 }, m, live())
    expect(m.calls.at(-1)).toEqual({ name: 'mineBlock', args: ['coal_ore', 32] })
  })

  it('sends a position for mine_block_at', async () => {
    const m = await connected()
    await dispatch({ action: 'mine_block_at', x: 18, y: 60, z: -34, maxDistance: 32 }, m, live())
    expect(m.calls.at(-1)).toEqual({ name: 'mineBlock', args: [{ x: 18, y: 60, z: -34 }, 32] })
  })

  it('reports a failed action as its Result, not a throw', async () => {
    const m = await connected()
    m.setFailure('moveTo', { reason: 'unreachable', detail: 'wall in the way' })
    const out = await dispatch({ action: 'move_to', x: 1, y: 64, z: -3 }, m, live())
    expect(out).toEqual({
      kind: 'result',
      result: { ok: false, reason: 'unreachable', detail: 'wall in the way' },
    })
  })

  it('passes the abort signal to the executor', async () => {
    const m = await connected()
    const ac = new AbortController()
    ac.abort()
    const out = await dispatch({ action: 'move_to', x: 1, y: 64, z: -3 }, m, ac.signal)
    expect(out).toEqual({
      kind: 'result',
      result: { ok: false, reason: 'interrupted', detail: 'aborted before start' },
    })
  })

  it('treats chat as an immediate success — it has no Result of its own', async () => {
    const m = await connected()
    const out = await dispatch({ action: 'chat', message: 'hello' }, m, live())
    expect(out).toEqual({ kind: 'result', result: { ok: true, value: undefined } })
    expect(m.calls.at(-1)).toEqual({ name: 'chat', args: ['hello'] })
  })

  it('reports the two terminal actions without touching the executor', async () => {
    const m = await connected()
    const before = m.calls.length
    expect(await dispatch({ action: 'done', summary: 'finished' }, m, live())).toEqual({
      kind: 'done',
    })
    expect(await dispatch({ action: 'give_up', reason: 'no pickaxe' }, m, live())).toEqual({
      kind: 'gave_up',
    })
    expect(m.calls).toHaveLength(before)
  })

  // The asymmetry the contract documents: findBlocks throws where the six
  // actions resolve. dispatch does not swallow it — runGoal catches it and
  // reports `disconnected` (design §7.3).
  it('lets a disconnected findBlocks throw through to the caller', async () => {
    const m = new MockExecutor({ blocks: [coal] })
    await expect(
      dispatch({ action: 'find_blocks', names: ['coal_ore'], maxDistance: 32, limit: 5 }, m, live()),
    ).rejects.toThrow(/disconnected/)
  })

  it('does not throw for a disconnected action — it resolves disconnected', async () => {
    const m = new MockExecutor({})
    const out = await dispatch({ action: 'move_to', x: 1, y: 64, z: -3 }, m, live())
    expect(out).toEqual({
      kind: 'result',
      result: { ok: false, reason: 'disconnected', detail: 'not connected' },
    })
  })
})
