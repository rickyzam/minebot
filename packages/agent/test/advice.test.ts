import { describe, it, expect } from 'vitest'
import { advise, repeatCounts, repeatWarnAt, signatureOf } from '../src/advice.js'
import type { Step } from '../src/step.js'

const step = (n: number, action: Step['action'], outcome: Step['outcome']): Step => ({
  n,
  raw: '',
  action,
  decodeError: null,
  outcome,
})

const MOVE = { action: 'move_to', x: 1, y: 2, z: 3 } as const
const OTHER = { action: 'move_to', x: 9, y: 9, z: 9 } as const
const FAILED = { kind: 'result', result: { ok: false, reason: 'not_found', detail: '' } } as const
const OK = { kind: 'result', result: { ok: true, value: undefined } } as const

const opts = { stepsTaken: 1, maxSteps: 16, stuckThreshold: 4 }

describe('signatureOf', () => {
  it('is null for a step with no action, so undecodable replies never count as repeats', () => {
    expect(signatureOf(step(1, null, { kind: 'undecodable' }))).toBeNull()
  })

  it('separates the same action by its arguments', () => {
    const a = signatureOf(step(1, MOVE, FAILED))
    const b = signatureOf(step(2, OTHER, FAILED))
    expect(a).not.toBeNull()
    expect(a).not.toEqual(b)
  })

  it('separates the same action by its outcome', () => {
    expect(signatureOf(step(1, MOVE, FAILED))).not.toEqual(signatureOf(step(2, MOVE, OK)))
  })
})

describe('repeatCounts', () => {
  it('counts within the window only', () => {
    const steps = [step(1, MOVE, FAILED), step(2, OTHER, OK), step(3, MOVE, FAILED)]
    const counts = repeatCounts(steps, 2)
    expect(counts.get(signatureOf(steps[2]!)!)).toBe(1)
  })

  it('counts non-consecutive repeats — two useless actions taking turns are still stuck', () => {
    const steps = [
      step(1, MOVE, FAILED),
      step(2, OTHER, FAILED),
      step(3, MOVE, FAILED),
      step(4, OTHER, FAILED),
    ]
    expect(repeatCounts(steps, 8).get(signatureOf(steps[0]!)!)).toBe(2)
  })
})

describe('advise', () => {
  it('reports zero repeats for an empty history', () => {
    expect(advise([], opts).repeatedTimes).toBe(0)
  })

  it('counts the LATEST step, not whichever signature is most common', () => {
    const steps = [step(1, OTHER, FAILED), step(2, OTHER, FAILED), step(3, MOVE, FAILED)]
    expect(advise(steps, opts).repeatedTimes).toBe(1)
  })

  it('does not warn on a first attempt, whatever the threshold', () => {
    const steps = [step(1, MOVE, FAILED)]
    expect(advise(steps, { ...opts, stuckThreshold: 3 }).warnRepeat).toBe(false)
    expect(advise(steps, { ...opts, stuckThreshold: 99 }).warnRepeat).toBe(false)
  })

  it('warns from the second occurrence at the default threshold', () => {
    const steps = [step(1, MOVE, FAILED), step(2, MOVE, FAILED)]
    expect(advise(steps, opts).warnRepeat).toBe(true)
  })

  it('reports the remaining budget and never goes negative', () => {
    expect(advise([], { ...opts, stepsTaken: 13 }).stepsRemaining).toBe(3)
    expect(advise([], { ...opts, stepsTaken: 99 }).stepsRemaining).toBe(0)
  })

  it('warns on budget only at the threshold', () => {
    expect(advise([], { ...opts, stepsTaken: 12 }).warnBudget).toBe(false)
    expect(advise([], { ...opts, stepsTaken: 13 }).warnBudget).toBe(true)
  })
})

describe('repeatWarnAt', () => {
  it('is floored at 2 so it can never fire on a first attempt', () => {
    expect(repeatWarnAt(3)).toBe(2)
    expect(repeatWarnAt(1)).toBe(2)
  })

  it('leaves two turns to recover at the default threshold', () => {
    expect(repeatWarnAt(4)).toBe(2)
  })
})

import { isStuckForTest } from '../src/loop.js'

describe('advise and the stuck guard agree', () => {
  // If these drift, the model is told "you have tried this twice" while the
  // guard counts something else — a bug invisible to every other test, since
  // the guard's arithmetic had no test before this one and the prompt's never
  // will.
  it('a latest-step repeat at the threshold always means the guard has fired', () => {
    const steps = [step(1, MOVE, FAILED), step(2, MOVE, FAILED), step(3, MOVE, FAILED)]
    const a = advise(steps, { ...opts, stuckThreshold: 3 })
    expect(a.repeatedTimes).toBe(3)
    expect(isStuckForTest(steps, 3)).toBe(true)
  })

  it('a warning always arrives strictly before the guard fires', () => {
    const steps = [step(1, MOVE, FAILED), step(2, MOVE, FAILED)]
    const a = advise(steps, { ...opts, stuckThreshold: 4 })
    expect(a.warnRepeat).toBe(true)
    expect(isStuckForTest(steps, 4)).toBe(false)
  })
})
