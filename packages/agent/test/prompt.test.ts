import { describe, it, expect } from 'vitest'
import type { WorldSnapshot } from '@minebot/contract'
import { ok, fail } from '@minebot/contract'
import { renderAction, renderOutcome, renderPrompt, HISTORY_WINDOW } from '../src/prompt.js'
import type { Step } from '../src/step.js'

const snapshot: WorldSnapshot = {
  takenAt: 1_700_000_000_000,
  self: {
    position: { x: 12, y: 64, z: -30 },
    health: 20,
    food: 18,
    dimension: 'overworld',
    onGround: true,
    inventory: [{ name: 'stone_pickaxe', count: 1, slot: 0 }],
    heldItem: { name: 'stone_pickaxe', count: 1, slot: 0 },
  },
  nearbyEntities: [
    { id: 7, name: 'zombie', kind: 'hostile', position: { x: 14, y: 64, z: -28 }, distance: 2.83 },
  ],
}

const step = (n: number, over: Partial<Step> = {}): Step => ({
  n,
  raw: '{}',
  action: { action: 'done', summary: 'x' },
  decodeError: null,
  outcome: { kind: 'done' },
  ...over,
})

describe('renderAction', () => {
  it('renders every action compactly', () => {
    expect(renderAction({ action: 'find_blocks', names: ['coal_ore'], maxDistance: 32, limit: 5 }))
      .toBe('find_blocks(coal_ore within 32)')
    expect(renderAction({ action: 'move_to', x: 1, y: 64, z: -3 })).toBe('move_to(1, 64, -3)')
    expect(renderAction({ action: 'mine_nearest_block', name: 'coal_ore', maxDistance: 8 }))
      .toBe('mine_nearest_block(coal_ore within 8)')
    expect(renderAction({ action: 'mine_block_at', x: 18, y: 60, z: -34, maxDistance: 32 }))
      .toBe('mine_block_at(18, 60, -34)')
    expect(renderAction({ action: 'chat', message: 'hi' })).toBe('chat("hi")')
    expect(renderAction({ action: 'done', summary: 'got it' })).toBe('done("got it")')
    expect(renderAction({ action: 'give_up', reason: 'no pickaxe' })).toBe('give_up("no pickaxe")')
  })
})

describe('renderOutcome', () => {
  it('lists found blocks with positions and distances', () => {
    const out = renderOutcome({
      kind: 'blocks',
      blocks: [{ name: 'coal_ore', position: { x: 18, y: 60, z: -34 }, distance: 7.94 }],
    })
    expect(out).toBe('1 found: coal_ore at (18, 60, -34), 7.9 away')
  })

  it('says so plainly when a search found nothing', () => {
    expect(renderOutcome({ kind: 'blocks', blocks: [] })).toBe('none found')
  })

  it('names the failure reason and its detail', () => {
    expect(renderOutcome({ kind: 'result', result: fail('missing_tool', 'no pickaxe') }))
      .toBe('FAILED (missing_tool): no pickaxe')
  })

  // Mining can succeed while the drop is lost. The contract makes that an ok
  // result carrying collected:false precisely so the success is not thrown
  // away — the model has to see the distinction to decide what comes next.
  it('surfaces collected:false on an otherwise successful mine', () => {
    expect(renderOutcome({ kind: 'result', result: ok({ position: { x: 1, y: 2, z: 3 }, collected: false }) }))
      .toBe('OK (drop collected: false)')
  })

  it('renders a bare success', () => {
    expect(renderOutcome({ kind: 'result', result: ok(undefined) })).toBe('OK')
  })
})

describe('renderPrompt', () => {
  it('states the goal and the current state', () => {
    const text = renderPrompt('get me some coal', snapshot, []).map((m) => m.content).join('\n')
    expect(text).toContain('get me some coal')
    expect(text).toContain('(12, 64, -30)')
    expect(text).toContain('20/20')
    expect(text).toContain('18/20')
    expect(text).toContain('stone_pickaxe x1')
    expect(text).toContain('zombie')
  })

  it('offers the action menu in the system message', () => {
    const [system] = renderPrompt('goal', snapshot, [])
    expect(system?.role).toBe('system')
    expect(system?.content).toContain('find_blocks')
    expect(system?.content).toContain('mine_block_at')
  })

  it('says so explicitly when there is no history yet', () => {
    const text = renderPrompt('goal', snapshot, []).map((m) => m.content).join('\n')
    expect(text).toContain('(none yet)')
  })

  it('numbers history entries and shows their outcomes', () => {
    const steps = [
      step(1, {
        action: { action: 'find_blocks', names: ['coal_ore'], maxDistance: 32, limit: 5 },
        outcome: {
          kind: 'blocks',
          blocks: [{ name: 'coal_ore', position: { x: 18, y: 60, z: -34 }, distance: 7.94 }],
        },
      }),
      step(2, {
        action: { action: 'mine_block_at', x: 18, y: 60, z: -34, maxDistance: 32 },
        outcome: { kind: 'result', result: fail('missing_tool', 'no pickaxe in inventory') },
      }),
    ]
    const text = renderPrompt('goal', snapshot, steps).map((m) => m.content).join('\n')
    expect(text).toContain('1. find_blocks(coal_ore within 32) -> 1 found')
    expect(text).toContain('2. mine_block_at(18, 60, -34) -> FAILED (missing_tool): no pickaxe in inventory')
  })

  it('shows an undecodable step so the model sees its own mistake', () => {
    const text = renderPrompt('goal', snapshot, [
      step(1, {
        action: null,
        decodeError: { kind: 'not_json', detail: 'could not parse JSON from: hmm' },
        outcome: { kind: 'undecodable' },
      }),
    ]).map((m) => m.content).join('\n')
    expect(text).toContain('invalid reply')
    expect(text).toContain('not_json')
  })

  // Prompt size must stay flat however long a goal runs (design §7.1).
  it('renders at most HISTORY_WINDOW entries even when handed more', () => {
    const many = Array.from({ length: HISTORY_WINDOW + 5 }, (_, i) => step(i + 1))
    const text = renderPrompt('goal', snapshot, many).map((m) => m.content).join('\n')
    expect(text).not.toContain(`\n  1. `)
    expect(text).toContain(`${HISTORY_WINDOW + 5}. `)
    const rendered = text.split('\n').filter((l) => /^ {2}\d+\. /.test(l))
    expect(rendered).toHaveLength(HISTORY_WINDOW)
  })
})
