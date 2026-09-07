import { describe, it, expect } from 'vitest'
import {
  classifyEntity,
  toSnapshot,
  NEARBY_ENTITY_RADIUS,
  NEARBY_ENTITY_LIMIT,
  type MineflayerLike,
  type RawEntity,
} from '../src/snapshot.js'

const bot = (over: Partial<MineflayerLike> = {}): MineflayerLike => ({
  entity: { id: 0, position: { x: 10, y: 64, z: -20 }, onGround: true },
  health: 18,
  food: 15,
  game: { dimension: 'minecraft:overworld' },
  entities: {},
  inventory: { items: () => [] },
  heldItem: null,
  ...over,
})

describe('classifyEntity', () => {
  it('classifies players', () => {
    expect(classifyEntity({ id: 1, type: 'player', username: 'Steve', position: { x: 0, y: 0, z: 0 } })).toBe('player')
  })

  it('classifies hostile mobs by kind', () => {
    expect(classifyEntity({ id: 2, type: 'mob', name: 'zombie', kind: 'Hostile mobs', position: { x: 0, y: 0, z: 0 } })).toBe('hostile')
  })

  it('classifies passive mobs by kind', () => {
    expect(classifyEntity({ id: 3, type: 'mob', name: 'cow', kind: 'Passive mobs', position: { x: 0, y: 0, z: 0 } })).toBe('passive')
  })

  it('classifies dropped items', () => {
    expect(classifyEntity({ id: 4, type: 'object', name: 'item', position: { x: 0, y: 0, z: 0 } })).toBe('item')
  })

  it('falls back to other for anything unrecognised', () => {
    expect(classifyEntity({ id: 5, type: 'object', name: 'boat', position: { x: 0, y: 0, z: 0 } })).toBe('other')
  })
})

describe('toSnapshot', () => {
  it('maps self state from the bot', () => {
    const s = toSnapshot(bot(), 1000)
    expect(s.takenAt).toBe(1000)
    expect(s.self.position).toEqual({ x: 10, y: 64, z: -20 })
    expect(s.self.health).toBe(18)
    expect(s.self.food).toBe(15)
    expect(s.self.dimension).toBe('minecraft:overworld')
    expect(s.self.onGround).toBe(true)
  })

  it('deep-freezes the snapshot so callers cannot mutate it', () => {
    const s = toSnapshot(bot(), 1000)
    expect(Object.isFrozen(s)).toBe(true)
    expect(Object.isFrozen(s.self)).toBe(true)
    expect(Object.isFrozen(s.self.position)).toBe(true)
    expect(() => {
      ;(s.self.position as { x: number }).x = 999
    }).toThrow()
  })

  it('copies values so later bot mutation does not change a taken snapshot', () => {
    const live = bot()
    const s = toSnapshot(live, 1000)
    live.entity!.position.x = 999
    expect(s.self.position.x).toBe(10)
  })

  it('maps inventory stacks', () => {
    const s = toSnapshot(
      bot({ inventory: { items: () => [{ name: 'coal', count: 3, slot: 9 }] } }),
      1000,
    )
    expect(s.self.inventory).toEqual([{ name: 'coal', count: 3, slot: 9 }])
  })

  it('computes entity distance from the bot and sorts nearest first', () => {
    const s = toSnapshot(
      bot({
        entity: { id: 0, position: { x: 0, y: 64, z: 0 }, onGround: true },
        entities: {
          '2': { id: 2, type: 'mob', name: 'cow', kind: 'Passive mobs', position: { x: 30, y: 64, z: 0 } },
          '1': { id: 1, type: 'mob', name: 'zombie', kind: 'Hostile mobs', position: { x: 3, y: 64, z: 4 } },
        },
      }),
      1000,
    )
    expect(s.nearbyEntities.map((e) => e.id)).toEqual([1, 2])
    expect(s.nearbyEntities[0]?.distance).toBeCloseTo(5)
    expect(s.nearbyEntities[0]?.kind).toBe('hostile')
  })

  it('prefers username as the display name for players', () => {
    const s = toSnapshot(
      bot({
        entities: {
          '7': { id: 7, type: 'player', username: 'Onetruezman', position: { x: 1, y: 64, z: 0 } },
        },
      }),
      1000,
    )
    expect(s.nearbyEntities[0]?.name).toBe('Onetruezman')
  })

  it('defaults health, food and dimension when the bot has not reported them', () => {
    const s = toSnapshot(
      bot({ health: undefined, food: undefined, game: undefined }),
      1000,
    )
    expect(s.self.health).toBe(0)
    expect(s.self.food).toBe(0)
    expect(s.self.dimension).toBe('unknown')
  })

  it('throws a clear error when the bot has not spawned', () => {
    expect(() => toSnapshot(bot({ entity: null }), 1000)).toThrow(/not spawned/i)
  })

  it('excludes the bot itself from nearbyEntities', () => {
    // Mineflayer registers the bot's own entity in bot.entities. Left in, every
    // snapshot would report a phantom player standing exactly where the bot
    // stands (distance 0) — misleading noise for the planning layer.
    const s = toSnapshot(
      bot({
        entity: { id: 42, position: { x: 0, y: 64, z: 0 }, onGround: true },
        entities: {
          '42': { id: 42, type: 'player', username: 'MineBot', position: { x: 0, y: 64, z: 0 } },
          '7': { id: 7, type: 'player', username: 'Someone', position: { x: 3, y: 64, z: 4 } },
        },
      }),
      1000,
    )
    expect(s.nearbyEntities.map((e) => e.id)).toEqual([7])
  })

  it('drops entities beyond the documented radius and caps the list at the documented limit', () => {
    const entities: Record<string, RawEntity> = {}
    // One clearly outside the radius — must never appear.
    entities['far'] = {
      id: 900,
      type: 'mob',
      name: 'cow',
      kind: 'Passive mobs',
      position: { x: NEARBY_ENTITY_RADIUS + 50, y: 64, z: 0 },
    }
    // More in-radius entities than the cap, at strictly increasing distance,
    // so "nearest N" is unambiguous.
    for (let i = 0; i < NEARBY_ENTITY_LIMIT + 5; i++) {
      entities[`near-${i}`] = {
        id: i,
        type: 'mob',
        name: 'cow',
        kind: 'Passive mobs',
        position: { x: i + 1, y: 64, z: 0 },
      }
    }
    const s = toSnapshot(
      // Self id -1 doesn't collide with any of the 0..NEARBY_ENTITY_LIMIT+4
      // ids used above.
      bot({ entity: { id: -1, position: { x: 0, y: 64, z: 0 }, onGround: true }, entities }),
      1000,
    )
    expect(s.nearbyEntities.length).toBe(NEARBY_ENTITY_LIMIT)
    expect(s.nearbyEntities.every((e) => e.distance <= NEARBY_ENTITY_RADIUS)).toBe(true)
    expect(s.nearbyEntities.some((e) => e.id === 900)).toBe(false)
    // Nearest N: ids 0..NEARBY_ENTITY_LIMIT-1 are the closest, in order.
    expect(s.nearbyEntities.map((e) => e.id)).toEqual(
      Array.from({ length: NEARBY_ENTITY_LIMIT }, (_, i) => i),
    )
  })
})
