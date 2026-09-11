import { describe, it, expect } from 'vitest'
import type { EntityInfo, EntityKind, WorldSnapshot } from '@minebot/contract'
import { evaluateReflex, DEFAULT_REFLEX_THRESHOLDS } from '../src/reflex.js'

const at = (id: number, distance: number, kind: EntityKind, name = 'thing'): EntityInfo => ({
  id, name, kind, position: { x: distance, y: 64, z: 0 }, distance,
})
const snap = (health: number, nearbyEntities: EntityInfo[]): WorldSnapshot => ({
  takenAt: 0,
  self: {
    position: { x: 0, y: 64, z: 0 }, health, food: 20, dimension: 'overworld',
    onGround: true, inventory: [], heldItem: null,
  },
  nearbyEntities,
})

describe('evaluateReflex', () => {
  it('does nothing when healthy and alone', () => {
    expect(evaluateReflex(snap(20, []))).toBeNull()
  })

  it('attacks the nearest hostile in range when healthy', () => {
    const t = evaluateReflex(snap(20, [at(2, 6, 'hostile'), at(1, 3, 'hostile')]))
    expect(t).toEqual({ kind: 'attack', entityId: 1, reason: expect.any(String) })
  })

  it('flees instead of attacking at or below the health threshold', () => {
    const t = evaluateReflex(snap(DEFAULT_REFLEX_THRESHOLDS.fleeBelowHealth, [at(1, 3, 'hostile')]))
    expect(t?.kind).toBe('flee')
  })

  it('does NOT flee on low health with no hostile nearby', () => {
    // Fleeing from nothing costs an action and moves the bot away from whatever
    // it was doing. The planner is a better judge of "go eat" than a reflex is.
    expect(evaluateReflex(snap(1, []))).toBeNull()
  })

  it('ignores hostiles beyond the radius', () => {
    expect(evaluateReflex(snap(20, [at(1, DEFAULT_REFLEX_THRESHOLDS.hostileRadius + 1, 'hostile')]))).toBeNull()
  })

  it.each<EntityKind>(['passive', 'player', 'item', 'other'])(
    'ignores a %s entity standing right next to the bot', (kind) => {
      expect(evaluateReflex(snap(20, [at(1, 1, kind)]))).toBeNull()
    },
  )

  it('honours overridden thresholds', () => {
    expect(evaluateReflex(snap(20, [at(1, 12, 'hostile')]), { hostileRadius: 16 })?.kind).toBe('attack')
  })
})
