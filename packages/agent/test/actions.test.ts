import { describe, it, expect } from 'vitest'
import { ACTION_NAMES, ACTION_SCHEMA, ACTION_MENU } from '../src/actions.js'

describe('action menu', () => {
  it('names exactly the seven actions the model may choose', () => {
    expect([...ACTION_NAMES]).toEqual([
      'find_blocks',
      'move_to',
      'mine_nearest_block',
      'mine_block_at',
      'chat',
      'done',
      'give_up',
    ])
  })

  // The Phase 5 stubs return fail('internal', '… arrives in Phase 5'). Offering
  // them spends a step on certain failure and teaches the model nothing, so they
  // stay out until Track A lands them (design §4.3).
  it('omits the actions the executor has not implemented', () => {
    for (const absent of ['place_block', 'follow_player', 'attack', 'flee']) {
      expect(ACTION_NAMES as readonly string[]).not.toContain(absent)
      expect(ACTION_MENU).not.toContain(absent)
    }
  })

  it('gives every action a schema branch keyed by its name', () => {
    const branches = ACTION_SCHEMA.oneOf
    expect(branches).toHaveLength(ACTION_NAMES.length)

    const keyed = branches.map((b) => {
      const nameProp = b.properties.action
      expect(nameProp.enum).toHaveLength(1)
      return nameProp.enum[0]
    })
    expect(keyed.sort()).toEqual([...ACTION_NAMES].sort())
  })

  // Nested unions are the shape constrained decoding handles worst, so every
  // branch must be a flat object of scalars and string arrays (design §4.2).
  it('keeps every schema branch flat', () => {
    for (const branch of ACTION_SCHEMA.oneOf) {
      expect(branch.type).toBe('object')
      expect(branch.additionalProperties).toBe(false)
      for (const [prop, shape] of Object.entries(branch.properties)) {
        const kind = (shape as { type?: string; enum?: unknown[] }).type
        const isEnum = Array.isArray((shape as { enum?: unknown[] }).enum)
        expect(
          isEnum || kind === 'string' || kind === 'number' || kind === 'integer' || kind === 'array',
          `${prop} must be a scalar, enum or array — no nested objects`,
        ).toBe(true)
      }
    }
  })

  it('documents every action in the menu text with a JSON example', () => {
    for (const name of ACTION_NAMES) {
      expect(ACTION_MENU).toContain(name)
      expect(ACTION_MENU).toContain(`"action":"${name}"`)
    }
  })
})
