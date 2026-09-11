import { describe, it, expect, vi } from 'vitest'
import { MockExecutor } from '@minebot/mock-executor'
import { runContractSuite } from '@minebot/mock-executor/contract-suite'
import type { EntityInfo } from '@minebot/contract'
import { ReflexExecutor } from '../src/reflex-executor.js'

const zombie = (distance: number): EntityInfo => ({
  id: 1, name: 'zombie', kind: 'hostile', position: { x: distance, y: 64, z: 0 }, distance,
})
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('ReflexExecutor', () => {
  it('passes actions through untouched when nothing triggers', async () => {
    const inner = new MockExecutor()
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    expect((await reflex.moveTo({ x: 5, y: 64, z: 5 })).ok).toBe(true)
    expect(reflex.preemptions).toHaveLength(0)
  })

  it('preempts on entityNearby ALONE, before any damage is taken', async () => {
    // The attack rule is about proximity, not damage. Subscribing only to
    // `damaged` would make it unreachable until after the first hit.
    const inner = new MockExecutor({ actionDelayMs: 500, entities: [zombie(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    const pending = reflex.moveTo({ x: 99, y: 64, z: 99 })
    inner.emit('entityNearby', { entity: zombie(3) })
    const r = await pending
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('interrupted')
    expect(reflex.preemptions[0]?.trigger.kind).toBe('attack')
  })

  it('names the trigger in the interrupted detail, so the model can read it', async () => {
    const inner = new MockExecutor({ actionDelayMs: 500, entities: [zombie(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    const pending = reflex.moveTo({ x: 99, y: 64, z: 99 })
    inner.emit('damaged', { health: 20, source: null })
    const r = await pending
    // Without this the detail check below is skipped for an `ok` result, and
    // the test passes against a decorator that never preempts at all.
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toMatch(/reflex/i)
  })

  it('awaits the recovery before resolving the caller', async () => {
    const inner = new MockExecutor({ actionDelayMs: 200, entities: [zombie(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    const pending = reflex.moveTo({ x: 99, y: 64, z: 99 })
    inner.emit('damaged', { health: 20, source: null })
    await pending
    expect(inner.calls.map((c) => c.name)).toContain('attack')
    expect(reflex.preemptions[0]?.recovery).not.toBeNull()
  })

  it('ESCALATES: flee supersedes an attack recovery already running', async () => {
    // The killer bug in v1. A single boolean latch swallows the damage that
    // would have triggered flee, and the bot dies mid-attack.
    const inner = new MockExecutor({ actionDelayMs: 300, entities: [zombie(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    const pending = reflex.moveTo({ x: 99, y: 64, z: 99 })
    inner.emit('damaged', { health: 20, source: null })   // -> attack recovery
    await settle()
    inner.setHealth(2)
    inner.emit('damaged', { health: 2, source: null })     // -> must escalate
    await pending
    expect(inner.calls.map((c) => c.name)).toContain('flee')
  })

  it('does NOT re-preempt for the same or lower priority', async () => {
    const inner = new MockExecutor({ actionDelayMs: 300, health: 3, entities: [zombie(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    const pending = reflex.moveTo({ x: 99, y: 64, z: 99 })
    inner.emit('damaged', { health: 3, source: null })
    inner.emit('damaged', { health: 2, source: null })
    inner.emit('damaged', { health: 1, source: null })
    await pending
    // The call count alone cannot see a missing latch: each re-preemption
    // supersedes the last before its yield ends, so only one flee ever reaches
    // the inner executor. Three recorded preemptions is what a missing latch
    // looks like.
    expect(reflex.preemptions).toHaveLength(1)
    expect(inner.calls.filter((c) => c.name === 'flee')).toHaveLength(1)
  })

  it('stop() cancels a pending recovery instead of letting it walk', async () => {
    // The emergency brake must win. v1 delegated stop() and the bot resumed
    // walking after the brake was pulled.
    const inner = new MockExecutor({ actionDelayMs: 300, entities: [zombie(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    const pending = reflex.moveTo({ x: 99, y: 64, z: 99 })
    inner.emit('damaged', { health: 20, source: null })
    reflex.stop()
    await pending
    // Proves the trigger fired. Without it, "no attack was issued" is also
    // what a decorator that never preempts would produce.
    expect(reflex.preemptions).toHaveLength(1)
    expect(inner.calls.map((c) => c.name)).not.toContain('attack')
  })

  it('returns promptly when the caller aborts during recovery', async () => {
    const inner = new MockExecutor({ actionDelayMs: 300, entities: [zombie(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    const c = new AbortController()
    const pending = reflex.moveTo({ x: 99, y: 64, z: 99 }, { signal: c.signal })
    inner.emit('damaged', { health: 20, source: null })
    await settle()
    c.abort()
    // "Promptly", without a clock: settled within one macrotask, while the
    // recovery it interrupted had 300ms left. Awaiting `pending` alone passes
    // just as well if the caller sits out the whole recovery.
    const r = await Promise.race([pending, settle().then(() => 'pending' as const)])
    expect(r).not.toBe('pending')
    if (r !== 'pending') {
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('interrupted')
    }
  })

  it('recovers its latch when the aborted action still resolves ok', async () => {
    // actionDelayMs 0: simulate() resolves before any abort listener exists,
    // so the action returns ok despite the abort. If the latch is cleared only
    // on the interrupted path it leaks, and emit() swallows the evidence.
    const inner = new MockExecutor({ actionDelayMs: 0, entities: [zombie(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    await reflex.moveTo({ x: 1, y: 64, z: 1 })
    inner.emit('damaged', { health: 20, source: null })   // 1: idle
    await settle()
    const pending = reflex.moveTo({ x: 2, y: 64, z: 2 })
    inner.emit('damaged', { health: 20, source: null })   // 2: during the delay-0 action
    // The inner moveTo resolved ok, but the recovery moved the bot after it
    // was chosen: reporting ok would let the planner continue from a stale
    // snapshot, so a preempted action is interrupted regardless.
    expect((await pending).ok).toBe(false)
    await settle()
    inner.emit('damaged', { health: 20, source: null })   // 3: idle again — only if the latch was released
    await settle()
    // Exactly 3. `>= 1` is satisfied by the first idle preemption alone, so it
    // could not tell a released latch from a leaked one.
    expect(reflex.preemptions).toHaveLength(3)
  })

  it('survives getState() throwing inside the handler', async () => {
    const inner = new MockExecutor({ entities: [zombie(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    await inner.disconnect()                 // getState() now throws
    expect(() => inner.emit('damaged', { health: 5, source: null })).not.toThrow()
    expect(reflex.preemptions).toHaveLength(0)
  })

  it('acts when idle, not only during an action', async () => {
    // The model round trip dominates the wall clock. A reflex that only works
    // during an action guards the minority of the timeline.
    const inner = new MockExecutor({ entities: [zombie(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    inner.emit('damaged', { health: 20, source: null })
    await settle()
    expect(inner.calls.map((c) => c.name)).toContain('attack')
  })

  it('does not preempt a caller-issued attack or flee', async () => {
    // Otherwise the reflex aborts the planner's attack to run its own, forever.
    const inner = new MockExecutor({ actionDelayMs: 300, entities: [zombie(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    const pending = reflex.attack(1)
    inner.emit('damaged', { health: 20, source: null })
    expect((await pending).ok).toBe(true)
    expect(reflex.preemptions).toHaveLength(0)
  })

  it('lets a flee trigger preempt a caller-issued attack', async () => {
    // Reflex beats plan (design §3.5). A caller attack occupies the reflex at
    // attack priority only: were it opaque, a planner swinging at low health
    // would block the flee that keeps the bot alive.
    const inner = new MockExecutor({ actionDelayMs: 300, health: 5, entities: [zombie(3)] })
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    const pending = reflex.attack(1)
    inner.emit('damaged', { health: 5, source: null })
    const r = await pending
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('interrupted')
    expect(inner.calls.map((c) => c.name)).toContain('flee')
    expect(reflex.preemptions).toHaveLength(1)
    expect(reflex.preemptions[0]?.action).toBe('attack')
  })

  it('stops preempting after repeated recovery failures', async () => {
    const inner = new MockExecutor({ actionDelayMs: 0, entities: [zombie(3)], failures: { attack: { reason: 'unreachable' } } })
    const reflex = new ReflexExecutor(inner, { maxConsecutiveFailures: 2 })
    await reflex.connect()
    for (let i = 0; i < 5; i++) { inner.emit('damaged', { health: 20, source: null }); await settle() }
    // Exactly 2: `<= 2` also passes at 0, against a decorator that never fires.
    expect(reflex.preemptions).toHaveLength(2)
  })

  it('forwards timeoutMs and other options to the inner action', async () => {
    const inner = new MockExecutor()
    const spy = vi.spyOn(inner, 'moveTo')
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    await reflex.moveTo({ x: 1, y: 64, z: 1 }, { timeoutMs: 1234 })
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 1234 })
  })

  it('resolves interrupted — never throws — for a pre-aborted signal', async () => {
    const inner = new MockExecutor()
    const reflex = new ReflexExecutor(inner)
    await reflex.connect()
    const r = await reflex.moveTo({ x: 1, y: 64, z: 1 }, { signal: AbortSignal.abort() })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('interrupted')
  })
})

// Copied verbatim from packages/mock-executor/test/mock-executor.test.ts. Two
// separate arrays on purpose: `expectFindable.minCount` is seededBlocks.length
// and must not count the visibility pair.
const SEEDED_BLOCK_NAMES = ['stone', 'dirt', 'grass_block']
const seededBlocks = [
  { name: 'stone', position: { x: 3, y: 64, z: 0 }, distance: 3 },
  { name: 'dirt', position: { x: 5, y: 64, z: 0 }, distance: 5 },
  { name: 'grass_block', position: { x: 8, y: 64, z: 0 }, distance: 8 },
  { name: 'stone', position: { x: 12, y: 64, z: 0 }, distance: 12 },
]
const visibilityBlocks = [
  { name: 'coal_ore', position: { x: 2, y: 60, z: 0 }, distance: 2, visible: false },
  { name: 'coal_ore', position: { x: 6, y: 64, z: 0 }, distance: 6 },
]

// Verifies the decorator is a faithful BotExecutor: delegation,
// throw-when-disconnected, the eight abort cases, followPlayer's no-timeout
// guarantee. Seeded with NO entities, deliberately — a hostile would preempt
// every action and make the run meaningless. Arbitration is covered above.
runContractSuite('ReflexExecutor over MockExecutor', async () => {
  const inner = new MockExecutor({ actionDelayMs: 20, blocks: [...seededBlocks, ...visibilityBlocks] })
  const executor = new ReflexExecutor(inner)
  await executor.connect()
  return {
    executor,
    cleanup: () => executor.disconnect(),
    expectFindable: { names: SEEDED_BLOCK_NAMES, minCount: seededBlocks.length },
    prepareVisibilityFixture: () =>
      Promise.resolve({
        hidden: { name: 'coal_ore', position: visibilityBlocks[0]!.position },
        control: { name: 'coal_ore', position: visibilityBlocks[1]!.position },
        maxDistance: 16,
      }),
    prepareFollowFixture: () => Promise.resolve({ playerName: 'SomePlayer' }),
    preparePlaceFixture: () =>
      Promise.resolve({ blockName: 'dirt', position: { x: 1, y: 64, z: 1 } }),
    prepareFleeFixture: () => Promise.resolve({}),
  }
})
