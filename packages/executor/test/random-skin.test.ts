import { describe, it, expect } from 'vitest'
import { pickRandom, toCandidates } from '../../../scripts/random-skin.js'
import {
  emptyHistory,
  remember,
  unused,
  DEFAULT_HISTORY_LIMIT,
} from '../../../scripts/skin-history.js'

const entry = (id: string, texture: string) => ({ uuid: id, texture })
const hash = (c: string) => c.repeat(64)

describe('toCandidates', () => {
  it('keeps the upload id, which is what the signed data is fetched by', () => {
    expect(toCandidates([entry('abc', hash('a'))])).toEqual([{ id: 'abc', texture: hash('a') }])
  })

  it('drops entries missing an id or a usable texture', () => {
    expect(
      toCandidates([
        { texture: hash('a') }, // no id
        entry('x', 'not-hex!!'),
        entry('y', 'abc'), // too short
        {},
        entry('z', hash('b')),
      ]),
    ).toEqual([{ id: 'z', texture: hash('b') }])
  })

  it('de-duplicates by texture id', () => {
    // Observed live: one texture appeared under two upload ids and two bots
    // spawned in identical skins. Shuffling cannot fix that — the duplicates
    // are distinct entries, so they have to be collapsed here.
    expect(toCandidates([entry('one', hash('a')), entry('two', hash('a'))])).toHaveLength(1)
  })

  it('returns nothing for an empty listing', () => {
    expect(toCandidates([])).toEqual([])
  })
})

describe('pickRandom', () => {
  const items = Array.from({ length: 20 }, (_, i) => i)

  it('returns the requested number of items', () => {
    expect(pickRandom(items, 5)).toHaveLength(5)
  })

  it('never repeats an item within one pick', () => {
    expect(new Set(pickRandom(items, 20)).size).toBe(20)
  })

  it('returns everything when asked for more than exists', () => {
    expect(pickRandom([1, 2], 10)).toHaveLength(2)
  })

  it('does not mutate the input', () => {
    const original = [...items]
    pickRandom(items, 5)
    expect(items).toEqual(original)
  })

  it('actually shuffles rather than returning a prefix', () => {
    const firsts = new Set(Array.from({ length: 40 }, () => pickRandom(items, 1)[0]))
    expect(firsts.size).toBeGreaterThan(1)
  })
})

describe('skin history', () => {
  it('excludes skins used before', () => {
    const history = remember(emptyHistory(), [hash('a')])
    const candidates = [
      { id: '1', texture: hash('a') },
      { id: '2', texture: hash('b') },
    ]
    expect(unused(history, candidates).map((c) => c.texture)).toEqual([hash('b')])
  })

  it('keeps a skin excluded until the cap pushes it out', () => {
    // The requirement: do not reuse a skin until a large number of others have
    // been used. Filling the history past the cap is what frees the oldest.
    let history = remember(emptyHistory(), [hash('a')], 3)
    history = remember(history, [hash('b'), hash('c')], 3)
    expect(unused(history, [{ id: '1', texture: hash('a') }])).toHaveLength(0)

    history = remember(history, [hash('d')], 3)
    expect(unused(history, [{ id: '1', texture: hash('a') }])).toHaveLength(1)
  })

  it('drops the oldest entries first', () => {
    const history = remember(emptyHistory(), [hash('a'), hash('b'), hash('c')], 2)
    expect(history.used).toEqual([hash('b'), hash('c')])
  })

  it('does not let a repeated id evict newer entries', () => {
    const history = remember(emptyHistory(), [hash('a'), hash('b')], 2)
    expect(remember(history, [hash('a')], 2).used).toEqual([hash('a'), hash('b')])
  })

  it('defaults to a cap that costs about 70 KB', () => {
    // 1000 entries x 64-character texture ids. Small enough that there is no
    // reason to trim it.
    expect(DEFAULT_HISTORY_LIMIT).toBe(1000)
    const full = remember(
      emptyHistory(),
      Array.from({ length: 1200 }, (_, i) => String(i).padStart(64, '0')),
    )
    expect(full.used).toHaveLength(1000)
    expect(JSON.stringify(full).length).toBeLessThan(150_000)
  })

  it('keeps everything when under the cap', () => {
    expect(remember(emptyHistory(), [hash('a'), hash('b')]).used).toHaveLength(2)
  })
})
