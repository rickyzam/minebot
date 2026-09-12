import { describe, it, expect } from 'vitest'
import { parseSchematic, placementOrder, type Schematic } from '../src/schematic.js'

describe('parseSchematic', () => {
  it('accepts a valid schematic and round-trips its blocks exactly', () => {
    const input = {
      name: 'pillar',
      blocks: [
        { dx: 0, dy: 0, dz: 0, block: 'stone' },
        { dx: 0, dy: 1, dz: 0, block: 'stone' },
      ],
    }
    const result = parseSchematic(input)
    expect(result).toEqual(input)
  })

  it('rejects a non-object', () => {
    expect(() => parseSchematic('not an object')).toThrow()
    expect(() => parseSchematic(null)).toThrow()
    expect(() => parseSchematic(42)).toThrow()
    expect(() => parseSchematic([])).toThrow()
  })

  it('rejects a missing name', () => {
    expect(() => parseSchematic({ blocks: [] })).toThrow(/name/)
  })

  it('rejects an empty name', () => {
    expect(() => parseSchematic({ name: '', blocks: [] })).toThrow(/name/)
  })

  it('rejects a non-string name', () => {
    expect(() => parseSchematic({ name: 5, blocks: [] })).toThrow(/name/)
  })

  it('rejects a missing blocks field', () => {
    expect(() => parseSchematic({ name: 'x' })).toThrow(/blocks/)
  })

  it('rejects blocks that is not an array', () => {
    expect(() => parseSchematic({ name: 'x', blocks: 'nope' })).toThrow(/blocks/)
  })

  it('rejects a non-object block entry and names its index', () => {
    expect(() => parseSchematic({ name: 'x', blocks: [null] })).toThrow(/blocks\[0\]/)
    expect(() => parseSchematic({ name: 'x', blocks: ['stone'] })).toThrow(/blocks\[0\]/)
  })

  it('rejects a non-integer offset and names the offending entry', () => {
    expect(() =>
      parseSchematic({ name: 'x', blocks: [{ dx: 0.5, dy: 0, dz: 0, block: 'stone' }] }),
    ).toThrow(/blocks\[0\]/)
    expect(() =>
      parseSchematic({ name: 'x', blocks: [{ dx: 0, dy: 0, dz: 0, block: 'stone' }, { dx: 0, dy: NaN, dz: 0, block: 'stone' }] }),
    ).toThrow(/blocks\[1\]/)
  })

  it('rejects a missing offset field', () => {
    expect(() =>
      parseSchematic({ name: 'x', blocks: [{ dy: 0, dz: 0, block: 'stone' }] }),
    ).toThrow(/blocks\[0\]/)
  })

  it('rejects a missing block field', () => {
    expect(() =>
      parseSchematic({ name: 'x', blocks: [{ dx: 0, dy: 0, dz: 0 }] }),
    ).toThrow(/blocks\[0\]/)
  })

  it('rejects a non-string block field', () => {
    expect(() =>
      parseSchematic({ name: 'x', blocks: [{ dx: 0, dy: 0, dz: 0, block: 7 }] }),
    ).toThrow(/blocks\[0\]/)
  })

  it('rejects an empty block name and names the offending entry', () => {
    expect(() =>
      parseSchematic({ name: 'x', blocks: [{ dx: 0, dy: 0, dz: 0, block: '' }] }),
    ).toThrow(/blocks\[0\]/)
  })

  /**
   * Without this the error surfaces from `buildSchematic` as "(x, y, z) is
   * occupied by dirt" — the world blamed for a malformed input file. Both
   * indices are named so the author can find the pair.
   */
  it('rejects two blocks at the same offset, naming both entries', () => {
    expect(() =>
      parseSchematic({
        name: 'x',
        blocks: [
          { dx: 0, dy: 0, dz: 0, block: 'dirt' },
          { dx: 1, dy: 0, dz: 0, block: 'dirt' },
          { dx: 0, dy: 0, dz: 0, block: 'stone' },
        ],
      }),
    ).toThrow(/blocks\[2\] repeats the offset \(0,0,0\) already used by blocks\[0\]/)
  })

  it('allows the same block name at different offsets', () => {
    const s = parseSchematic({
      name: 'x',
      blocks: [
        { dx: 0, dy: 0, dz: 0, block: 'dirt' },
        { dx: 0, dy: 1, dz: 0, block: 'dirt' },
      ],
    })
    expect(s.blocks).toHaveLength(2)
  })
})

describe('placementOrder', () => {
  it('sorts ascending by dy so every block has support when placed', () => {
    const s: Schematic = {
      name: 'stack',
      blocks: [
        { dx: 0, dy: 2, dz: 0, block: 'stone' },
        { dx: 0, dy: 0, dz: 0, block: 'stone' },
        { dx: 0, dy: 1, dz: 0, block: 'stone' },
      ],
    }
    const ordered = placementOrder(s)
    expect(ordered.map((b) => b.dy)).toEqual([0, 1, 2])
  })

  it('breaks ties within a layer deterministically by dx then dz', () => {
    // Natural (input) order deliberately differs from the expected output
    // order, so a test that only checked "is sorted" could pass vacuously.
    const s: Schematic = {
      name: 'layer',
      blocks: [
        { dx: 1, dy: 0, dz: 0, block: 'stone' },
        { dx: 0, dy: 0, dz: 1, block: 'stone' },
        { dx: 0, dy: 0, dz: 0, block: 'stone' },
        { dx: 1, dy: 0, dz: -1, block: 'stone' },
      ],
    }
    const ordered = placementOrder(s)
    expect(ordered.map((b) => [b.dx, b.dz])).toEqual([
      [0, 0],
      [0, 1],
      [1, -1],
      [1, 0],
    ])
  })

  it('combines the dy-then-dx-then-dz ordering across multiple layers', () => {
    const s: Schematic = {
      name: 'cube-ish',
      blocks: [
        { dx: 1, dy: 1, dz: 0, block: 'stone' },
        { dx: 0, dy: 0, dz: 1, block: 'stone' },
        { dx: 0, dy: 1, dz: 0, block: 'stone' },
        { dx: 1, dy: 0, dz: 0, block: 'stone' },
        { dx: 0, dy: 0, dz: 0, block: 'stone' },
      ],
    }
    const ordered = placementOrder(s)
    expect(ordered.map((b) => [b.dy, b.dx, b.dz])).toEqual([
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
      [1, 0, 0],
      [1, 1, 0],
    ])
  })

  it('round-trips: returns exactly the blocks given, none added or dropped', () => {
    const s: Schematic = {
      name: 'round-trip',
      blocks: [
        { dx: 3, dy: -1, dz: 2, block: 'dirt' },
        { dx: 0, dy: 0, dz: 0, block: 'stone' },
      ],
    }
    const ordered = placementOrder(s)
    expect(ordered).toHaveLength(2)
    expect([...ordered].sort((a, b) => a.dy - b.dy)).toEqual(
      [...s.blocks].sort((a, b) => a.dy - b.dy),
    )
  })

  it('is pure: does not mutate its input array or its input schematic', () => {
    const s: Schematic = {
      name: 'purity',
      blocks: [
        { dx: 0, dy: 1, dz: 0, block: 'stone' },
        { dx: 0, dy: 0, dz: 0, block: 'stone' },
      ],
    }
    const originalBlocksRef = s.blocks
    const originalCopy = [...s.blocks]
    const ordered = placementOrder(s)
    expect(s.blocks).toBe(originalBlocksRef)
    expect(s.blocks).toEqual(originalCopy)
    expect(ordered).not.toBe(s.blocks)
  })
})
