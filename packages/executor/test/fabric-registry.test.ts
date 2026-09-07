import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  encodeRegisterPayload,
  createChunkAssembler,
  parseRegistrySync,
  MAX_ASSEMBLED_BYTES,
  moddedEntries,
  FABRIC_CHANNELS,
  FABRIC_SYNC_DIRECT,
  FABRIC_SYNC_COMPLETE,
} from '../src/fabric-registry.js'

/**
 * A real `fabric:registry/sync/direct` payload captured from the dev server on
 * 2026-09-07 with fabric-api 0.138.4 and one content-registering mod loaded.
 * Kept verbatim because the wire format is undocumented and was derived by
 * inspection — a synthetic fixture would only re-encode whatever the parser
 * already believes, and could not have caught either mistake made deriving it.
 */
const FIXTURE = readFileSync(fileURLToPath(new URL('./fixtures/fabric-registry-sync.bin', import.meta.url)))

describe('encodeRegisterPayload', () => {
  it('joins channels with NUL bytes', () => {
    expect(encodeRegisterPayload(['a:b', 'c:d'])).toEqual(Buffer.from('a:b\0c:d', 'utf8'))
  })

  it('encodes a single channel with no separator', () => {
    expect(encodeRegisterPayload(['only:one'])).toEqual(Buffer.from('only:one', 'utf8'))
  })

  it('encodes the Fabric channels the handshake depends on', () => {
    expect([...FABRIC_CHANNELS]).toEqual([FABRIC_SYNC_DIRECT, FABRIC_SYNC_COMPLETE])
    expect(encodeRegisterPayload(FABRIC_CHANNELS).toString('utf8').split('\0')).toHaveLength(2)
  })
})

describe('createChunkAssembler', () => {
  it('returns null until the zero-length terminator arrives', () => {
    const a = createChunkAssembler()
    expect(a.push(Buffer.from([1, 2, 3]))).toBeNull()
    expect(a.push(Buffer.from([4, 5]))).toBeNull()
    expect(a.push(Buffer.alloc(0))).toEqual(Buffer.from([1, 2, 3, 4, 5]))
  })

  it('does NOT complete on a single full chunk', () => {
    // The bug this guards: acknowledging a chunk instead of the terminator ends
    // Fabric's task early, and the next acknowledgement lands while the server is
    // on vanilla registry sync, which disconnects with "Unexpected request for
    // task finish, current task: synchronize_registries".
    const a = createChunkAssembler()
    expect(a.push(Buffer.alloc(32768, 7))).toBeNull()
  })

  it('rejects a stream that never terminates, instead of growing forever', () => {
    // The remote server decides how much it sends. Proven to fire rather than
    // assumed: a small cap here is the same code path as the 8MB default.
    const a = createChunkAssembler(10)
    expect(a.push(Buffer.alloc(6))).toBeNull()
    expect(() => a.push(Buffer.alloc(6))).toThrow(/exceeded 10 bytes/)
  })

  it('recovers after rejecting an oversized stream', () => {
    const a = createChunkAssembler(10)
    expect(() => a.push(Buffer.alloc(20))).toThrow()
    // The abandoned chunks must not count against the next payload.
    expect(a.push(Buffer.from([1, 2]))).toBeNull()
    expect(a.push(Buffer.alloc(0))).toEqual(Buffer.from([1, 2]))
  })

  it('defaults to a generous but bounded cap', () => {
    expect(MAX_ASSEMBLED_BYTES).toBeGreaterThan(32768)
    expect(Number.isFinite(MAX_ASSEMBLED_BYTES)).toBe(true)
  })

  it('handles a terminator with no preceding chunks', () => {
    expect(createChunkAssembler().push(Buffer.alloc(0))).toEqual(Buffer.alloc(0))
  })

  it('resets between payloads so a second sync does not inherit the first', () => {
    const a = createChunkAssembler()
    a.push(Buffer.from([1]))
    expect(a.push(Buffer.alloc(0))).toEqual(Buffer.from([1]))
    a.push(Buffer.from([2]))
    expect(a.push(Buffer.alloc(0))).toEqual(Buffer.from([2]))
  })
})

describe('parseRegistrySync', () => {
  const entries = parseRegistrySync(FIXTURE)
  const byName = new Map(entries.map((e) => [`${e.registry}|${e.name}`, e.id]))
  const itemId = (name: string): number | undefined => byName.get(`minecraft:item|${name}`)

  it('decodes every entry the payload declares', () => {
    expect(entries.length).toBe(1488 + 1 + 96 + 3)
  })

  it('reports the registries the server synced', () => {
    expect([...new Set(entries.map((e) => e.registry))]).toEqual([
      'minecraft:item',
      'minecraft:data_component_type',
    ])
  })

  it('recovers vanilla item ids exactly as the live server reported them', () => {
    // Read back from a real bot's inventory on the modded server, so these are
    // measurements rather than expectations copied out of the parser.
    expect(itemId('minecraft:air')).toBe(0)
    expect(itemId('minecraft:coal')).toBe(896)
    expect(itemId('minecraft:diamond')).toBe(898)
    expect(itemId('minecraft:stone_pickaxe')).toBe(923)
  })

  it('places modded entries after vanilla, leaving vanilla ids untouched', () => {
    const vanilla = entries.filter((e) => e.registry === 'minecraft:item' && e.name.startsWith('minecraft:'))
    const modded = entries.filter((e) => e.registry === 'minecraft:item' && !e.name.startsWith('minecraft:'))
    const highestVanilla = Math.max(...vanilla.map((e) => e.id))
    expect(modded.every((e) => e.id > highestVanilla)).toBe(true)
  })

  it('decodes the delta-encoded modded ids', () => {
    // Cross-checked against a live packet: an entity_equipment packet carried
    // itemId 1488 and component type 96 while this mod was loaded.
    expect(itemId('nitwitmap:map_book')).toBe(1488)
    expect(byName.get('minecraft:data_component_type|nitwitmap:map_book_ref')).toBe(96)
  })

  it('assigns consecutive ids within a run', () => {
    const components = entries
      .filter((e) => e.registry === 'minecraft:data_component_type' && !e.name.startsWith('minecraft:'))
      .map((e) => e.id)
      .sort((x, y) => x - y)
    expect(components).toEqual([96, 97, 98])
  })

  it('stops at the declared structure rather than the zero padding', () => {
    // The payload is padded to the chunk size; a parser that ran to the end of
    // the buffer would read garbage entries out of the padding.
    expect(entries.some((e) => e.name.endsWith(':'))).toBe(false)
    expect(FIXTURE.subarray(25607).every((b) => b === 0)).toBe(true)
  })

  it('returns nothing for an empty payload', () => {
    expect(parseRegistrySync(Buffer.alloc(0))).toEqual([])
  })

  it('throws rather than inventing entries when the payload is truncated', () => {
    expect(() => parseRegistrySync(FIXTURE.subarray(0, 200))).toThrow(/truncated|varint/i)
  })

  it('rejects an over-long varint rather than decoding it wrongly', () => {
    // Six continuation bytes. JS bitwise operands are 32-bit, so a sixth byte
    // would be OR'd at `<< 35` — evaluated as `<< 3` — silently corrupting the
    // value. This guard must fire before that shift, so prove it does.
    const evil = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01])
    expect(() => parseRegistrySync(evil)).toThrow(/varint too long/)
  })

  it('rejects a string whose declared length runs past the buffer', () => {
    // nRegistryNamespaces=1, then a namespace string claiming 200 bytes that
    // are not there. Without the bounds check this would read whatever follows.
    const evil = Buffer.from([0x01, 0xc8, 0x01, 0x41, 0x42])
    expect(() => parseRegistrySync(evil)).toThrow(/truncated string/)
  })

  it('does not hang or over-allocate on absurd declared counts', () => {
    // A hostile payload declaring 4 billion registries must fail fast, not spin.
    const evil = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0f])
    const started = Date.now()
    expect(() => parseRegistrySync(evil)).toThrow()
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe('moddedEntries', () => {
  it('selects everything outside the minecraft namespace', () => {
    const modded = moddedEntries(parseRegistrySync(FIXTURE))
    expect(modded.map((e) => e.name).sort()).toEqual([
      'nitwitmap:map_book',
      'nitwitmap:map_book_contents',
      'nitwitmap:map_book_pending_op',
      'nitwitmap:map_book_ref',
    ])
  })

  it('is namespace-based, so an unrelated future mod needs no code change', () => {
    const modded = moddedEntries([
      { registry: 'minecraft:item', name: 'minecraft:stone', id: 1 },
      { registry: 'minecraft:item', name: 'somefuturemod:widget', id: 2 },
      { registry: 'minecraft:block', name: 'another_mod:gadget', id: 3 },
    ])
    expect(modded.map((e) => e.name)).toEqual(['somefuturemod:widget', 'another_mod:gadget'])
  })

  it('returns nothing for a purely vanilla server', () => {
    expect(moddedEntries([{ registry: 'minecraft:item', name: 'minecraft:stone', id: 1 }])).toEqual([])
  })
})
