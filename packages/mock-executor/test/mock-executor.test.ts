import { describe, it, expect } from 'vitest'
import { MockExecutor } from '@minebot/mock-executor'
import { runContractSuite } from '@minebot/mock-executor/contract-suite'

// Fix 4 (post-review): a suite instance seeded with zero blocks made every
// findBlocks assertion in the shared suite vacuous (`[].length <= limit`
// passes trivially, and the per-block loop body never runs). Seed a handful
// of matching blocks at distinct, increasing distances — more than the
// suite's smallest `limit` — so both the "respects limit" and "nearest-first,
// non-empty" assertions actually exercise real data.
const SEEDED_BLOCK_NAMES = ['stone', 'dirt', 'grass_block']
const seededBlocks = [
  { name: 'stone', position: { x: 3, y: 64, z: 0 }, distance: 3 },
  { name: 'dirt', position: { x: 5, y: 64, z: 0 }, distance: 5 },
  { name: 'grass_block', position: { x: 8, y: 64, z: 0 }, distance: 8 },
  { name: 'stone', position: { x: 12, y: 64, z: 0 }, distance: 12 },
]

runContractSuite('MockExecutor', async () => {
  const executor = new MockExecutor({ actionDelayMs: 20, blocks: [...seededBlocks] })
  await executor.connect()
  return {
    executor,
    cleanup: () => executor.disconnect(),
    expectFindable: { names: SEEDED_BLOCK_NAMES, minCount: seededBlocks.length },
  }
})

describe('MockExecutor specifics', () => {
  it('records the calls made against it', async () => {
    const m = new MockExecutor()
    await m.connect()
    await m.moveTo({ x: 1, y: 2, z: 3 })
    m.chat('hello')
    expect(m.calls.map((c) => c.name)).toEqual(['connect', 'moveTo', 'chat'])
  })

  it('updates its position after a successful moveTo', async () => {
    const m = new MockExecutor({ position: { x: 0, y: 64, z: 0 } })
    await m.connect()
    const r = await m.moveTo({ x: 10, y: 64, z: -5 })
    expect(r.ok).toBe(true)
    expect(m.getState().self.position).toEqual({ x: 10, y: 64, z: -5 })
  })

  it('does not move when the action is aborted mid-flight', async () => {
    const m = new MockExecutor({ position: { x: 0, y: 64, z: 0 }, actionDelayMs: 500 })
    await m.connect()
    const c = new AbortController()
    const p = m.moveTo({ x: 99, y: 64, z: 99 }, { signal: c.signal })
    setTimeout(() => c.abort(), 10)
    const r = await p
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('interrupted')
    expect(m.getState().self.position).toEqual({ x: 0, y: 64, z: 0 })
  })

  it('returns canned blocks filtered by name, distance and limit', async () => {
    const m = new MockExecutor({
      blocks: [
        { name: 'coal_ore', position: { x: 5, y: 60, z: 0 }, distance: 5 },
        { name: 'coal_ore', position: { x: 40, y: 60, z: 0 }, distance: 40 },
        { name: 'iron_ore', position: { x: 6, y: 60, z: 0 }, distance: 6 },
      ],
    })
    await m.connect()
    const found = m.findBlocks({ names: ['coal_ore'], maxDistance: 32, limit: 10 })
    expect(found).toHaveLength(1)
    expect(found[0]?.name).toBe('coal_ore')
  })

  it('delivers emitted events to subscribers and stops after unsubscribe', async () => {
    const m = new MockExecutor()
    await m.connect()
    const seen: number[] = []
    const off = m.on('health', (p) => seen.push(p.health))
    m.emit('health', { health: 12, food: 20 })
    off()
    m.emit('health', { health: 3, food: 20 })
    expect(seen).toEqual([12])
  })
})
