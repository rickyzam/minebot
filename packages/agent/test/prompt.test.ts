import { describe, it, expect } from 'vitest'
import type { WorldSnapshot } from '@minebot/contract'
import { ok, fail } from '@minebot/contract'
import { renderAction, renderAdvice, renderOutcome, renderPrompt, HISTORY_WINDOW } from '../src/prompt.js'
import type { Advice } from '../src/advice.js'
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

const quiet: Advice = {
  repeatedTimes: 0,
  stepsRemaining: 16,
  warnRepeat: false,
  warnBudget: false,
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

  // The two strings this asserts are the ones the decision block quotes back at
  // the model. Four candidate rules failed to make it treat an empty
  // explore_for as an UNFINISHED search rather than proof the block is absent;
  // naming the state outright is what broke that. The phrasing is therefore
  // load-bearing prompt behaviour, not cosmetics.
  it('names whether an exploration report is a finished search or an unfinished one', () => {
    const running = renderOutcome({
      kind: 'result',
      result: ok({ found: [], searchedTo: 32.2024, exhausted: false }),
    })
    expect(running).toBe(
      'OK (found nothing; searched out to 32; this search is UNFINISHED - more ground remains)',
    )

    const done = renderOutcome({
      kind: 'result',
      result: ok({ found: [], searchedTo: 64, exhausted: true }),
    })
    expect(done).toBe(
      'OK (found nothing; searched out to 64; this search is FINISHED - nowhere left to search)',
    )
  })
})

describe('renderPrompt', () => {
  it('states the goal and the current state', () => {
    const text = renderPrompt('get me some coal', snapshot, [], quiet).map((m) => m.content).join('\n')
    expect(text).toContain('get me some coal')
    expect(text).toContain('(12, 64, -30)')
    expect(text).toContain('20/20')
    expect(text).toContain('18/20')
    expect(text).toContain('stone_pickaxe x1')
    expect(text).toContain('zombie')
  })

  it('offers the action menu in the system message', () => {
    const [system] = renderPrompt('goal', snapshot, [], quiet)
    expect(system?.role).toBe('system')
    expect(system?.content).toContain('find_blocks')
    expect(system?.content).toContain('mine_block_at')
  })

  it('says so explicitly when there is no history yet', () => {
    const text = renderPrompt('goal', snapshot, [], quiet).map((m) => m.content).join('\n')
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
    const text = renderPrompt('goal', snapshot, steps, quiet).map((m) => m.content).join('\n')
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
    ], quiet).map((m) => m.content).join('\n')
    expect(text).toContain('invalid reply')
    expect(text).toContain('not_json')
  })

  // Prompt size must stay flat however long a goal runs (design §7.1).
  it('renders at most HISTORY_WINDOW entries even when handed more', () => {
    const many = Array.from({ length: HISTORY_WINDOW + 5 }, (_, i) => step(i + 1))
    const text = renderPrompt('goal', snapshot, many, quiet).map((m) => m.content).join('\n')
    expect(text).not.toContain(`\n  1. `)
    expect(text).toContain(`${HISTORY_WINDOW + 5}. `)
    const rendered = text.split('\n').filter((l) => /^ {2}\d+\. /.test(l))
    expect(rendered).toHaveLength(HISTORY_WINDOW)
  })
})

describe('renderAdvice', () => {
  it('renders nothing when there is nothing to say', () => {
    expect(renderAdvice(quiet)).toBeNull()
  })

  it('states the repeat count, so the claim is checkable rather than vague', () => {
    const out = renderAdvice({ ...quiet, repeatedTimes: 2, warnRepeat: true })
    expect(out).toContain('2 times')
  })

  it('states the remaining budget as a fact and gives no instruction', () => {
    const out = renderAdvice({ ...quiet, stepsRemaining: 2, warnBudget: true })!
    expect(out).toContain('2')
    // Minimal intervention (spec §5): if the bare fact measurably does nothing,
    // guidance is added THEN, with the measurement as its justification.
    // Instructing first would bake in the early-give_up risk of spec §4.3.
    expect(out.toLowerCase()).not.toContain('give up')
    expect(out.toLowerCase()).not.toContain('wrap up')
  })

  it('renders both notices together', () => {
    const out = renderAdvice({
      repeatedTimes: 3,
      stepsRemaining: 1,
      warnRepeat: true,
      warnBudget: true,
    })!
    expect(out).toContain('3 times')
    expect(out).toContain('1')
  })
})

describe('renderPrompt with advice', () => {
  it('omits the notices block entirely when there is nothing to say', () => {
    const [, user] = renderPrompt('get coal', snapshot, [], quiet)
    expect(user!.content).not.toContain('Notices')
  })

  it('puts the notices in the user message, not the system rules', () => {
    const advice = { ...quiet, repeatedTimes: 2, warnRepeat: true }
    const [system, user] = renderPrompt('get coal', snapshot, [], advice)
    expect(user!.content).toContain('Notices')
    expect(system!.content).not.toContain('Notices')
  })
})

describe('renderPrompt decision block', () => {
  // Its position is the entire reason it works. The same guidance sat in the
  // system rules in four earlier forms and left `position dead, ground remains`
  // off target every time; rendered after the history it lands 4/4. A test that
  // only checked the text was present would pass on a version that does not
  // work, so this one pins that nothing follows it.
  it('is the last thing in the user message, after the history', () => {
    const steps = [step(1, { outcome: { kind: 'result', result: ok(undefined) } })]
    const [, user] = renderPrompt('get coal', snapshot, steps, quiet)
    const text = user!.content
    expect(text).toContain('Before you answer, look at the LAST line above')
    expect(text.indexOf('Recent actions:')).toBeLessThan(
      text.indexOf('Before you answer, look at the LAST line above'),
    )
    expect(text.trimEnd().endsWith('so give_up.')).toBe(true)
  })

  // The block tells the model to act on two phrases. If `describeValue` ever
  // stops emitting them verbatim the instruction silently addresses nothing,
  // and `npm test` would otherwise stay green while the bot regressed.
  it('quotes the exact words an exploration report uses', () => {
    const [, user] = renderPrompt('get coal', snapshot, [], quiet)
    const unfinished = renderOutcome({
      kind: 'result',
      result: ok({ found: [], searchedTo: 32, exhausted: false }),
    })
    const finished = renderOutcome({
      kind: 'result',
      result: ok({ found: [], searchedTo: 64, exhausted: true }),
    })
    expect(unfinished).toContain('this search is UNFINISHED')
    expect(finished).toContain('this search is FINISHED')
    expect(user!.content).toContain('"this search is UNFINISHED"')
    expect(user!.content).toContain('FINISHED')
  })

  // It is unconditional on purpose: making it appear only after an unfinished
  // explore_for would be a code rule choosing what the model is told, which
  // spec §2 requires a prompt failure to earn first.
  it('is rendered even on the very first turn, when there is no history', () => {
    const [, user] = renderPrompt('get coal', snapshot, [], quiet)
    expect(user!.content).toContain('(none yet)')
    expect(user!.content).toContain('Before you answer, look at the LAST line above')
  })
})
