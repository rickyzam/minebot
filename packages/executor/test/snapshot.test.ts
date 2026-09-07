import { describe, it, expect } from 'vitest'
import { classifyEntity, toSnapshot, type MineflayerLike } from '../src/snapshot.js'

const bot = (over: Partial<MineflayerLike> = {}): MineflayerLike => ({
  entity: { position: { x: 10, y: 64, z: -20 }, onGround: true },
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
        entity: { position: { x: 0, y: 64, z: 0 }, onGround: true },
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
})
