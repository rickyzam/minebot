import {
  FABRIC_CHANNELS,
  FABRIC_SYNC_COMPLETE,
  FABRIC_SYNC_DIRECT,
  createChunkAssembler,
  encodeRegisterPayload,
  moddedEntries,
  parseRegistrySync,
  type RegistryEntry,
} from './fabric-registry.js'

/**
 * Minimal view of node-minecraft-protocol's client, declared structurally so this
 * module stays testable with a plain fake and does not drag the protocol types in.
 */
export interface ProtocolClientLike {
  write(name: string, params: unknown): void
  on(event: 'state', handler: (state: string) => void): void
  on(event: 'packet', handler: (data: PacketData, meta: PacketMeta) => void): void
}

export interface PacketData {
  channel?: string
  data?: Buffer
}

export interface PacketMeta {
  name: string
  state: string
}

export interface FabricHandshake {
  /**
   * Registry entries outside the `minecraft` namespace that the server reported.
   * Empty against a vanilla server, and populated for any mod without code
   * changes — the handshake reports whatever the server registered.
   */
  readonly moddedEntries: readonly RegistryEntry[]
  /** Every entry the server reported, vanilla included. */
  readonly allEntries: readonly RegistryEntry[]
  /** Whether a Fabric registry sync was seen and completed. */
  readonly completed: boolean
}

/**
 * Make a Mineflayer client acceptable to a Fabric server running content mods.
 *
 * Installs two behaviours on the configuration phase:
 *
 *  1. Advertise the Fabric sync channels via `minecraft:register`. Fabric's
 *     `canSend` check is what decides whether a client is mod-capable, and it is
 *     satisfied purely by having advertised the channel — a silent client is
 *     kicked without ever failing a check.
 *  2. Reassemble the chunked registry mapping and acknowledge it exactly once,
 *     on the zero-length terminator.
 *
 * Safe to install unconditionally. Against a vanilla server the advertisement is
 * inert: nothing consumes those channels, no sync payload is ever sent, and the
 * returned handshake simply reports no entries.
 *
 * Nothing here is specific to any mod, so a newly added mod requires no change.
 */
export function installFabricHandshake(client: ProtocolClientLike): FabricHandshake {
  const assembler = createChunkAssembler()
  const state = {
    moddedEntries: [] as RegistryEntry[],
    allEntries: [] as RegistryEntry[],
    completed: false,
  }
  let advertised = false

  const advertise = (): void => {
    if (advertised) return
    advertised = true
    client.write('custom_payload', {
      channel: 'minecraft:register',
      data: encodeRegisterPayload(FABRIC_CHANNELS),
    })
  }

  client.on('state', (next: string) => {
    if (next === 'configuration') advertise()
  })

  client.on('packet', (data: PacketData, meta: PacketMeta) => {
    if (meta.state !== 'configuration' || meta.name !== 'custom_payload') return
    if (data.channel !== FABRIC_SYNC_DIRECT || !data.data) return

    const payload = assembler.push(data.data)
    if (payload === null) return

    try {
      const entries = parseRegistrySync(payload)
      state.allEntries = entries
      state.moddedEntries = moddedEntries(entries)
    } catch {
      // A payload we cannot decode must not stop us acknowledging: failing to
      // reply hangs the configuration phase and the connection dies, whereas an
      // unparsed mapping only costs us the modded names.
    }
    state.completed = true
    client.write('custom_payload', { channel: FABRIC_SYNC_COMPLETE, data: Buffer.alloc(0) })
  })

  return {
    get moddedEntries() {
      return state.moddedEntries
    },
    get allEntries() {
      return state.allEntries
    },
    get completed() {
      return state.completed
    },
  }
}
