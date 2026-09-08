import { describe, it, expect } from 'vitest'
import { MockExecutor } from '@minebot/mock-executor'
import { runContractSuite } from '@minebot/mock-executor/contract-suite'
import type { FailureReason } from '@minebot/contract'

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

  it('mines the exact block a Vec3 target names, not the nearest match', async () => {
    const m = new MockExecutor({
      blocks: [
        { name: 'coal_ore', position: { x: 2, y: 60, z: 0 }, distance: 2 },
        { name: 'coal_ore', position: { x: 9, y: 60, z: 0 }, distance: 9 },
      ],
    })
    await m.connect()
    const r = await m.mineBlock({ x: 9, y: 60, z: 0 }, 32)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.position).toEqual({ x: 9, y: 60, z: 0 })
    // The nearer block must still be standing — a name-based re-search would
    // have taken it instead.
    expect(m.findBlocks({ names: ['coal_ore'], maxDistance: 32, limit: 5 })).toHaveLength(1)
  })

  it('fails not_found for a Vec3 target with no block at it', async () => {
    const m = new MockExecutor({
      blocks: [{ name: 'coal_ore', position: { x: 2, y: 60, z: 0 }, distance: 2 }],
    })
    await m.connect()
    const r = await m.mineBlock({ x: 40, y: 60, z: 0 }, 32)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_found')
  })

  it('fails not_found for a Vec3 target beyond maxDistance', async () => {
    const m = new MockExecutor({
      blocks: [{ name: 'coal_ore', position: { x: 9, y: 60, z: 0 }, distance: 9 }],
    })
    await m.connect()
    const r = await m.mineBlock({ x: 9, y: 60, z: 0 }, 4)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_found')
  })

  it('delivers events to a handler registered before the first connect()', async () => {
    const m = new MockExecutor()
    let seen = 0
    const off = m.on('spawned', () => {
      seen += 1
    })
    await m.connect()
    expect(seen).toBe(1)
    off()
  })
})

describe('MockExecutor failure injection', () => {
  const ALL_REASONS: FailureReason[] = [
    'not_found', 'unreachable', 'interrupted', 'invalid_target', 'missing_tool',
    'inventory_full', 'timeout', 'disconnected', 'internal',
  ]

  it.each(ALL_REASONS)('can produce %s from moveTo', async (reason) => {
    const m = new MockExecutor({ failures: { moveTo: { reason } } })
    await m.connect()
    const r = await m.moveTo({ x: 1, y: 64, z: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe(reason)
  })

  it('carries the injected detail string', async () => {
    const m = new MockExecutor({ failures: { mineBlock: { reason: 'missing_tool', detail: 'need a pickaxe' } } })
    await m.connect()
    const r = await m.mineBlock('coal_ore', 16)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toBe('need a pickaxe')
  })

  it('injects per action, leaving others working', async () => {
    const m = new MockExecutor({ failures: { flee: { reason: 'internal' } } })
    await m.connect()
    expect((await m.moveTo({ x: 1, y: 64, z: 1 })).ok).toBe(true)
    expect((await m.flee()).ok).toBe(false)
  })

  it('setFailure drives a fail-then-succeed retry sequence on one instance', async () => {
    const m = new MockExecutor()
    await m.connect()
    m.setFailure('moveTo', { reason: 'unreachable' })
    expect((await m.moveTo({ x: 5, y: 64, z: 5 })).ok).toBe(false)
    m.setFailure('moveTo', null)
    expect((await m.moveTo({ x: 5, y: 64, z: 5 })).ok).toBe(true)
    expect(m.getState().self.position).toEqual({ x: 5, y: 64, z: 5 })
  })

  it('does not let injection override the abort rule', async () => {
    // The contract's resolve-interrupted-on-abort rule outranks injection;
    // otherwise a test could use injection to fake a contract violation.
    const m = new MockExecutor({ failures: { moveTo: { reason: 'internal' } } })
    await m.connect()
    const r = await m.moveTo({ x: 1, y: 64, z: 1 }, { signal: AbortSignal.abort() })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('interrupted')
  })

  it('does not let injection mask being disconnected', async () => {
    const m = new MockExecutor({ failures: { moveTo: { reason: 'internal' } } })
    const r = await m.moveTo({ x: 1, y: 64, z: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('disconnected')
  })
})

describe('MockExecutor.exploreFor', () => {
  const near = { name: 'coal_ore', position: { x: 5, y: 64, z: 0 }, distance: 5 }
  const far = { name: 'coal_ore', position: { x: 90, y: 64, z: 0 }, distance: 90 }

  it('finds blocks within maxDistance and reports the cost', async () => {
    const m = new MockExecutor({ blocks: [near, far] })
    await m.connect()
    const r = await m.exploreFor(['coal_ore'], 32)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.found.map((b) => b.position)).toEqual([near.position])
      expect(r.value.travelled).toBeGreaterThanOrEqual(0)
    }
  })

  it('resolves ok with an empty result when nothing is there', async () => {
    // "I looked and there was nothing" is a successful search, not a failure.
    // Reporting not_found here would make the reason meaningless for mineBlock.
    const m = new MockExecutor({ blocks: [far] })
    await m.connect()
    const r = await m.exploreFor(['coal_ore'], 32)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.found).toEqual([])
      expect(r.value.exhausted).toBe(true)
    }
  })

  it('does not re-report ground already covered by an earlier call', async () => {
    const m = new MockExecutor({ blocks: [far] })
    await m.connect()
    const first = await m.exploreFor(['coal_ore'], 128)
    const second = await m.exploreFor(['coal_ore'], 128)
    expect(first.ok && second.ok).toBe(true)
    if (first.ok && second.ok) {
      expect(second.value.searchedTo).toBeGreaterThanOrEqual(first.value.searchedTo)
      // Design §3.4: the point of tracking searchedTo is that a resumed search
      // makes *progress*. Equal-and-unmoved would satisfy the >= above while
      // re-walking the same ground forever, which is exactly what this forbids.
      expect(second.value.searchedTo).toBeGreaterThan(first.value.searchedTo)
      // Once exhausted, staying exhausted is the guarantee that lets a caller
      // stop asking rather than looping forever.
      if (first.value.exhausted) expect(second.value.exhausted).toBe(true)
    }
  })

  it('restarts when the search changes', async () => {
    const m = new MockExecutor({ blocks: [near] })
    await m.connect()
    // Advance an unrelated search well past the origin first — otherwise a mock
    // that ignored the key entirely would still report 0 here and the test
    // would pass without discriminating anything.
    await m.exploreFor(['iron_ore'], 128)
    const advanced = await m.exploreFor(['iron_ore'], 128)
    expect(advanced.ok && advanced.value.searchedTo > 0).toBe(true)

    const other = await m.exploreFor(['coal_ore'], 128)
    expect(other.ok).toBe(true)
    if (other.ok) expect(other.value.searchedTo).toBe(0)
  })

  it('honours injection, but never above the abort rule', async () => {
    const m = new MockExecutor({ failures: { exploreFor: { reason: 'internal' } } })
    await m.connect()
    const injected = await m.exploreFor(['coal_ore'], 32)
    expect(injected.ok).toBe(false)
    if (!injected.ok) expect(injected.reason).toBe('internal')

    const aborted = await m.exploreFor(['coal_ore'], 32, { signal: AbortSignal.abort() })
    expect(aborted.ok).toBe(false)
    if (!aborted.ok) expect(aborted.reason).toBe('interrupted')
  })

  it('fails disconnected when not connected', async () => {
    const m = new MockExecutor()
    const r = await m.exploreFor(['coal_ore'], 32)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('disconnected')
  })

  it('takes exploreDelayMs to search, and stays cancellable while it does', async () => {
    // §3.4 asks for a slow search Track B can exercise. A delay that ignored
    // the signal would turn every "abort mid-search" test into a timeout.
    const m = new MockExecutor({ exploreDelayMs: 5_000 })
    await m.connect()
    const controller = new AbortController()
    const pending = m.exploreFor(['coal_ore'], 32, { signal: controller.signal })
    controller.abort()
    const r = await pending
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('interrupted')
  })
})
