import { describe, it, expect } from 'vitest'
import type { Vec3 } from '@minebot/contract'
import {
  isExposed,
  isPerceivable,
  observe,
  type BlockView,
  type PerceptionWorld,
} from '../src/visibility.js'

const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`

const block = (position: Vec3, name = 'stone', boundingBox = 'block'): BlockView => ({
  name,
  position,
  boundingBox,
})

/**
 * A world built from an explicit map, so every test states exactly what is
 * around the block under test. Anything not named is `null` — an unloaded
 * chunk, which the rule treats as solid.
 */
function worldOf(
  blocks: readonly BlockView[],
  canSee: (b: BlockView) => boolean = () => true,
): PerceptionWorld & { canSeeCalls: BlockView[] } {
  const byPos = new Map(blocks.map((b) => [key(b.position), b]))
  const canSeeCalls: BlockView[] = []
  return {
    canSeeCalls,
    blockAt: (p) => byPos.get(key(p)) ?? null,
    canSee: (b) => {
      canSeeCalls.push(b)
      return canSee(b)
    },
  }
}

/** The six neighbours of the origin, all solid. The fully-encased case. */
const encasedNeighbours: BlockView[] = [
  block({ x: 1, y: 0, z: 0 }),
  block({ x: -1, y: 0, z: 0 }),
  block({ x: 0, y: 1, z: 0 }),
  block({ x: 0, y: -1, z: 0 }),
  block({ x: 0, y: 0, z: 1 }),
  block({ x: 0, y: 0, z: -1 }),
]

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 }

describe('isExposed', () => {
  it('rejects a block with all six faces against solid cubes', () => {
    // The case the whole change exists for: 3216 coal at the benchmark start,
    // all of them like this, all of them reported as findable.
    const world = worldOf(encasedNeighbours)
    expect(isExposed(world, ORIGIN)).toBe(false)
  })

  it.each([
    ['east', { x: 1, y: 0, z: 0 }],
    ['west', { x: -1, y: 0, z: 0 }],
    ['above', { x: 0, y: 1, z: 0 }],
    ['below', { x: 0, y: -1, z: 0 }],
    ['south', { x: 0, y: 0, z: 1 }],
    ['north', { x: 0, y: 0, z: -1 }],
  ])('accepts a block whose %s neighbour is air', (_face, position) => {
    // Each face checked individually: a loop that skipped a face would still
    // pass a test that only ever opened one of them.
    const neighbours = encasedNeighbours.map((b) =>
      key(b.position) === key(position as Vec3) ? block(b.position, 'air', 'empty') : b,
    )
    expect(isExposed(worldOf(neighbours), ORIGIN)).toBe(true)
  })

  it('treats water as non-solid, so ore in a flooded cave is exposed', () => {
    // Measured at the benchmark start: 50 coal touch air or cave_air, 60 touch
    // any non-solid. The extra 10 touch only water. A player can see through
    // water, so excluding it would under-report.
    const neighbours = [...encasedNeighbours.slice(1), block({ x: 1, y: 0, z: 0 }, 'water', 'empty')]
    expect(isExposed(worldOf(neighbours), ORIGIN)).toBe(true)
  })

  it('treats a non-full shape like a slab as non-solid', () => {
    const neighbours = [
      ...encasedNeighbours.slice(1),
      block({ x: 1, y: 0, z: 0 }, 'stone_slab', 'shaped'),
    ]
    expect(isExposed(worldOf(neighbours), ORIGIN)).toBe(true)
  })

  it('treats an unloaded neighbour as solid rather than as empty space', () => {
    // A world with NOTHING in it: every neighbour lookup returns null. Guessing
    // "unloaded means empty" would reintroduce X-ray vision at every chunk
    // boundary, which is the exact hole this module closes.
    expect(isExposed(worldOf([]), ORIGIN)).toBe(false)
  })
})

describe('isPerceivable', () => {
  const target = block(ORIGIN, 'coal_ore')

  it('rejects an encased block without ever casting a ray', () => {
    const world = worldOf(encasedNeighbours)
    expect(isPerceivable(world, target)).toBe(false)
    // The ordering, asserted rather than assumed. Stage 1 exists to keep the
    // raycast off candidates that cannot possibly qualify; a refactor that ran
    // both stages unconditionally would still return the right answer here and
    // would silently cost 1431ms instead of 891ms on the `stone` case.
    expect(world.canSeeCalls).toEqual([])
  })

  it('rejects a block that is exposed but not in line of sight', () => {
    // The sealed-cavern case. At the benchmark start this is ALL 60 exposed
    // coal blocks: stage 1 passes, stage 2 fails, and the honest answer is
    // "no coal here" rather than "eight you cannot reach".
    const neighbours = [...encasedNeighbours.slice(1), block({ x: 1, y: 0, z: 0 }, 'air', 'empty')]
    const world = worldOf(neighbours, () => false)
    expect(isPerceivable(world, target)).toBe(false)
    expect(world.canSeeCalls).toHaveLength(1)
  })

  it('accepts a block that is exposed and in line of sight', () => {
    const neighbours = [...encasedNeighbours.slice(1), block({ x: 1, y: 0, z: 0 }, 'air', 'empty')]
    const world = worldOf(neighbours, () => true)
    expect(isPerceivable(world, target)).toBe(true)
  })
})

describe('observe', () => {
  it('records what was seen, from where, and when', () => {
    const seenFrom: Vec3 = { x: 10, y: 64, z: 10 }
    const o = observe(block({ x: 13, y: 68, z: 10 }, 'coal_ore'), seenFrom, 1_700_000_000_000)
    expect(o.name).toBe('coal_ore')
    expect(o.position).toEqual({ x: 13, y: 68, z: 10 })
    expect(o.seenFrom).toEqual(seenFrom)
    expect(o.seenAt).toBe(1_700_000_000_000)
    expect(o.distance).toBeCloseTo(5, 10)
  })

  it('freezes the observation and copies its vectors', () => {
    // Memory will hold these. A caller mutating the bot's live position vector
    // must not retroactively change where a past observation says it stood.
    const seenFrom = { x: 1, y: 2, z: 3 }
    const o = observe(block({ x: 1, y: 2, z: 4 }), seenFrom, 1)
    seenFrom.x = 999
    expect(o.seenFrom.x).toBe(1)
    expect(Object.isFrozen(o)).toBe(true)
    expect(Object.isFrozen(o.position)).toBe(true)
    expect(Object.isFrozen(o.seenFrom)).toBe(true)
  })
})
