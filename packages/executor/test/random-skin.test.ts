import { describe, it, expect } from 'vitest'
import { pickRandom, toSkinChoices, TEXTURE_CDN } from '../../../scripts/random-skin.js'

describe('toSkinChoices', () => {
  it('builds Mojang CDN urls, the only host a vanilla client loads skins from', () => {
    const hash = 'b7650f47dfb39ffe539b3977a083cbdab59e335677afd78dc94a20fff297bd5a'
    expect(toSkinChoices([{ texture: hash }])).toEqual([{ texture: hash, url: `${TEXTURE_CDN}/${hash}` }])
  })

  it('drops malformed entries rather than producing a url that cannot load', () => {
    expect(
      toSkinChoices([
        { texture: 'not-hex!!' },
        { texture: 'abc' }, // too short
        {},
        { texture: 'a'.repeat(64) },
      ]),
    ).toHaveLength(1)
  })

  it('returns nothing for an empty listing', () => {
    expect(toSkinChoices([])).toEqual([])
  })

  it('de-duplicates by texture hash', () => {
    // Observed live: the listing carried one texture under two upload ids, and
    // two bots spawned in identical skins. Shuffling cannot fix that, because
    // the duplicates are distinct entries — they have to be collapsed here.
    const hash = 'a'.repeat(64)
    const other = 'b'.repeat(64)
    expect(toSkinChoices([{ texture: hash }, { texture: hash }, { texture: other }])).toEqual([
      { texture: hash, url: `${TEXTURE_CDN}/${hash}` },
      { texture: other, url: `${TEXTURE_CDN}/${other}` },
    ])
  })

  it('preserves listing order for the entries it keeps', () => {
    const a = 'a'.repeat(64)
    const b = 'b'.repeat(64)
    expect(toSkinChoices([{ texture: b }, { texture: a }]).map((c) => c.texture)).toEqual([b, a])
  })
})

describe('pickRandom', () => {
  const items = Array.from({ length: 20 }, (_, i) => i)

  it('returns the requested number of items', () => {
    expect(pickRandom(items, 5)).toHaveLength(5)
  })

  it('never repeats an item within one pick', () => {
    const picked = pickRandom(items, 20)
    expect(new Set(picked).size).toBe(20)
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
    // A "random" pick that always returned items[0..n] would give every bot the
    // same skin on every run, which is the whole thing this is meant to avoid.
    const firsts = new Set(Array.from({ length: 40 }, () => pickRandom(items, 1)[0]))
    expect(firsts.size).toBeGreaterThan(1)
  })
})
