import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { installFabricHandshake, type PacketData, type PacketMeta } from '../src/fabric-handshake.js'
import { FABRIC_SYNC_COMPLETE, FABRIC_SYNC_DIRECT } from '../src/fabric-registry.js'

const FIXTURE = readFileSync(fileURLToPath(new URL('./fixtures/fabric-registry-sync.bin', import.meta.url)))

interface Written {
  name: string
  params: { channel?: string; data?: Buffer }
}

/** Fake protocol client that records writes and lets a test drive the phases. */
function fakeClient(opts: { state?: string } = {}) {
  const written: Written[] = []
  let stateHandler: ((s: string) => void) | undefined
  let packetHandler: ((d: PacketData, m: PacketMeta) => void) | undefined

  const client = {
    state: opts.state,
    write(name: string, params: unknown) {
      written.push({ name, params: params as Written['params'] })
    },
    on(event: string, handler: (...args: never[]) => void) {
      if (event === 'state') stateHandler = handler as unknown as (s: string) => void
      else if (event === 'packet') packetHandler = handler as unknown as (d: PacketData, m: PacketMeta) => void
    },
  }

  return {
    client: client as unknown as Parameters<typeof installFabricHandshake>[0],
    written,
    enterConfiguration: () => stateHandler?.('configuration'),
    enterPlay: () => stateHandler?.('play'),
    sendSyncChunk: (data: Buffer) =>
      packetHandler?.({ channel: FABRIC_SYNC_DIRECT, data }, { name: 'custom_payload', state: 'configuration' }),
    sendPacket: (d: PacketData, m: PacketMeta) => packetHandler?.(d, m),
    registrations: () => written.filter((w) => w.params.channel === 'minecraft:register'),
    completions: () => written.filter((w) => w.params.channel === FABRIC_SYNC_COMPLETE),
  }
}

describe('installFabricHandshake', () => {
  it('advertises the Fabric channels on entering configuration', () => {
    const f = fakeClient()
    installFabricHandshake(f.client)
    expect(f.registrations()).toHaveLength(0)
    f.enterConfiguration()
    expect(f.registrations()).toHaveLength(1)
    expect(f.registrations()[0]!.params.data!.toString('utf8').split('\0')).toEqual([
      FABRIC_SYNC_DIRECT,
      FABRIC_SYNC_COMPLETE,
    ])
  })

  it('advertises only once even if configuration is entered again', () => {
    const f = fakeClient()
    installFabricHandshake(f.client)
    f.enterConfiguration()
    f.enterConfiguration()
    expect(f.registrations()).toHaveLength(1)
  })

  it('does not advertise for other states', () => {
    const f = fakeClient()
    installFabricHandshake(f.client)
    f.enterPlay()
    expect(f.registrations()).toHaveLength(0)
  })

  it('acknowledges exactly once, on the terminator — never per chunk', () => {
    // The bug this pins: acknowledging a chunk ends Fabric's task early, and the
    // next acknowledgement arrives during vanilla registry sync, which kicks with
    // "Unexpected request for task finish, current task: synchronize_registries".
    const f = fakeClient()
    installFabricHandshake(f.client)
    f.enterConfiguration()

    f.sendSyncChunk(FIXTURE)
    expect(f.completions()).toHaveLength(0)

    f.sendSyncChunk(Buffer.alloc(0))
    expect(f.completions()).toHaveLength(1)
    expect(f.completions()[0]!.params.data!.length).toBe(0)
  })

  it('reassembles a multi-chunk payload before decoding it', () => {
    const f = fakeClient()
    const handshake = installFabricHandshake(f.client)
    f.enterConfiguration()

    const half = Math.floor(FIXTURE.length / 2)
    f.sendSyncChunk(FIXTURE.subarray(0, half))
    f.sendSyncChunk(FIXTURE.subarray(half))
    expect(f.completions()).toHaveLength(0)

    f.sendSyncChunk(Buffer.alloc(0))
    expect(handshake.completed).toBe(true)
    expect(handshake.moddedEntries.map((e) => e.name)).toContain('nitwitmap:map_book')
  })

  it('exposes modded entries generically, with vanilla ids intact', () => {
    const f = fakeClient()
    const handshake = installFabricHandshake(f.client)
    f.enterConfiguration()
    f.sendSyncChunk(FIXTURE)
    f.sendSyncChunk(Buffer.alloc(0))

    expect(handshake.moddedEntries.every((e) => !e.name.startsWith('minecraft:'))).toBe(true)
    const coal = handshake.allEntries.find((e) => e.name === 'minecraft:coal')
    expect(coal?.id).toBe(896)
  })

  it('still acknowledges when the payload cannot be decoded', () => {
    // Failing to reply hangs the configuration phase and kills the connection.
    // A mapping we cannot read costs only the modded names, so acknowledge anyway.
    const f = fakeClient()
    const handshake = installFabricHandshake(f.client)
    f.enterConfiguration()
    f.sendSyncChunk(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]))
    f.sendSyncChunk(Buffer.alloc(0))

    expect(f.completions()).toHaveLength(1)
    expect(handshake.completed).toBe(true)
    expect(handshake.moddedEntries).toEqual([])
  })

  it('ignores unrelated packets and channels', () => {
    const f = fakeClient()
    const handshake = installFabricHandshake(f.client)
    f.enterConfiguration()
    f.sendPacket({ channel: 'minecraft:brand', data: Buffer.from('x') }, { name: 'custom_payload', state: 'configuration' })
    f.sendPacket({ channel: FABRIC_SYNC_DIRECT, data: Buffer.alloc(0) }, { name: 'custom_payload', state: 'play' })
    f.sendPacket({}, { name: 'registry_data', state: 'configuration' })

    expect(f.completions()).toHaveLength(0)
    expect(handshake.completed).toBe(false)
  })

  it('advertises extra channels alongside the Fabric ones', () => {
    // Escape hatch for a mod running its own canSend check on its own channel,
    // so accommodating one needs no change to this module.
    const f = fakeClient()
    installFabricHandshake(f.client, { extraChannels: ['somemod:handshake'] })
    f.enterConfiguration()
    expect(f.registrations()[0]!.params.data!.toString('utf8').split('\0')).toEqual([
      FABRIC_SYNC_DIRECT,
      FABRIC_SYNC_COMPLETE,
      'somemod:handshake',
    ])
  })

  it('advertises immediately when installed after configuration already began', () => {
    // The 'state' transition has already fired by then, so waiting for it would
    // mean never advertising — and the kick would give no hint that install
    // timing was the cause.
    const f = fakeClient({ state: 'configuration' })
    installFabricHandshake(f.client)
    expect(f.registrations()).toHaveLength(1)
  })

  it('does not advertise early when the client is not yet in configuration', () => {
    const f = fakeClient({ state: 'login' })
    installFabricHandshake(f.client)
    expect(f.registrations()).toHaveLength(0)
  })

  it('surfaces a decode failure instead of looking like a vanilla server', () => {
    const f = fakeClient()
    const handshake = installFabricHandshake(f.client)
    f.enterConfiguration()
    f.sendSyncChunk(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]))
    f.sendSyncChunk(Buffer.alloc(0))
    expect(handshake.decodeError).toBeInstanceOf(Error)
    expect(handshake.completed).toBe(true)
  })

  it('leaves decodeError null on a clean sync', () => {
    const f = fakeClient()
    const handshake = installFabricHandshake(f.client)
    f.enterConfiguration()
    f.sendSyncChunk(FIXTURE)
    f.sendSyncChunk(Buffer.alloc(0))
    expect(handshake.decodeError).toBeNull()
  })

  it('does not acknowledge a stream it abandoned for exceeding the cap', () => {
    // Acknowledging would tell the server we synced when we did not.
    const f = fakeClient()
    const handshake = installFabricHandshake(f.client, { maxAssembledBytes: 10 })
    f.enterConfiguration()
    f.sendSyncChunk(Buffer.alloc(64))
    expect(f.completions()).toHaveLength(0)
    expect(handshake.completed).toBe(false)
    expect(handshake.decodeError?.message).toMatch(/exceeded/)
  })

  it('reports nothing for a vanilla server that never syncs', () => {
    const f = fakeClient()
    const handshake = installFabricHandshake(f.client)
    f.enterConfiguration()
    expect(handshake.completed).toBe(false)
    expect(handshake.moddedEntries).toEqual([])
    expect(f.completions()).toHaveLength(0)
  })
})
