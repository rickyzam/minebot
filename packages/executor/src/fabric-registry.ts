/**
 * Decoding for Fabric API's registry-sync handshake.
 *
 * A Fabric server running any mod that registers content refuses vanilla-protocol
 * clients. `RegistrySyncManager` asks
 * `ServerConfigurationNetworking.canSend(handler, DirectRegistryPacketHandler.PAYLOAD_ID)`
 * and, when that is false, disconnects with:
 *
 *   This server requires Fabric Loader and Fabric API installed on your client!
 *   The following registry entry namespaces may be related: <namespace>
 *
 * `canSend` is true only for channels the client advertised via `minecraft:register`,
 * so a silent client is rejected — it never fails a check, it simply never answers.
 * Advertising the two sync channels and completing the exchange is enough.
 *
 * Nothing here knows about any particular mod. The payload describes whatever the
 * server has registered, so a new mod needs no new code.
 *
 * Everything in this module is pure: no network, no Mineflayer. The wire format was
 * derived from a real 32768-byte capture, kept as a test fixture, and validated
 * against ids read back from a live server.
 */

/** Channel carrying the chunked registry mapping, server -> client. */
export const FABRIC_SYNC_DIRECT = 'fabric:registry/sync/direct'
/** Channel acknowledging a completed sync, client -> server. */
export const FABRIC_SYNC_COMPLETE = 'fabric:registry/sync/complete'

/** The channels a client must advertise to be treated as Fabric-capable. */
export const FABRIC_CHANNELS: readonly string[] = [FABRIC_SYNC_DIRECT, FABRIC_SYNC_COMPLETE]

/** One registry entry the server reported: its full id and its numeric id. */
export interface RegistryEntry {
  /** Registry this entry belongs to, e.g. `minecraft:item`. */
  readonly registry: string
  /** Namespaced entry id, e.g. `nitwitmap:map_book`. */
  readonly name: string
  /** Numeric ("raw") id used on the wire. */
  readonly id: number
}

/**
 * Encode a `minecraft:register` payload: channel names joined by NUL bytes.
 * This is what makes the server treat the connection as mod-capable.
 */
export function encodeRegisterPayload(channels: readonly string[]): Buffer {
  return Buffer.from(channels.join('\0'), 'utf8')
}

/**
 * Reassembles the chunked `fabric:registry/sync/direct` payload.
 *
 * The server sends full chunks (32768 bytes observed) followed by a **zero-length
 * chunk** marking the end. Acknowledging any chunk but the last finishes Fabric's
 * task early, and the next acknowledgement then arrives while the server has moved
 * on to vanilla registry sync, which drops the connection with:
 *
 *   Unexpected request for task finish, current task: synchronize_registries,
 *   requested: fabric:registry/sync
 *
 * So `push` returns `null` until the terminator arrives, and the assembled buffer
 * exactly once when it does.
 */
export function createChunkAssembler(): { push(chunk: Buffer): Buffer | null } {
  let chunks: Buffer[] = []
  return {
    push(chunk: Buffer): Buffer | null {
      if (chunk.length > 0) {
        chunks.push(chunk)
        return null
      }
      const assembled = Buffer.concat(chunks)
      chunks = []
      return assembled
    },
  }
}

/** Minimal sequential reader for the Minecraft `PacketByteBuf` primitives used here. */
class Reader {
  offset = 0
  private readonly buf: Buffer

  constructor(buf: Buffer) {
    this.buf = buf
  }

  get done(): boolean {
    return this.offset >= this.buf.length
  }

  varInt(): number {
    let value = 0
    let shift = 0
    let byte: number
    do {
      if (this.offset >= this.buf.length) throw new Error('registry sync: truncated varint')
      byte = this.buf[this.offset++]!
      value |= (byte & 0x7f) << shift
      shift += 7
      if (shift > 35) throw new Error('registry sync: varint too long')
    } while (byte & 0x80)
    return value >>> 0
  }

  string(): string {
    const length = this.varInt()
    if (this.offset + length > this.buf.length) throw new Error('registry sync: truncated string')
    const value = this.buf.subarray(this.offset, this.offset + length).toString('utf8')
    this.offset += length
    return value
  }
}

/**
 * Decode the assembled registry-sync payload into a flat list of entries.
 *
 * Wire format, derived from a real capture and validated against a live server:
 *
 * ```
 * varint            number of registry-id namespaces
 *   string          registry namespace ("" means "minecraft")
 *   varint          number of registries in this namespace
 *     string        registry path, e.g. "item"
 *     varint        registry attribute bitset
 *     varint        number of entry-id namespaces
 *       string      entry namespace ("" means "minecraft")
 *       varint      number of runs
 *         varint    id delta from the last id assigned in this registry
 *         varint    number of entries in the run
 *         string[]  entry paths; ids run consecutively from the run's start
 * ```
 *
 * Ids are delta-encoded per registry and entries within a run are consecutive, so
 * vanilla arrives as one large run starting at 0 and modded entries follow *after*
 * it. That is why adding a mod does not renumber vanilla content — verified live:
 * `minecraft:coal` stayed 896 and `minecraft:stone_pickaxe` stayed 923 with a mod
 * loaded.
 *
 * The buffer is zero-padded to the chunk size, so decoding stops when the declared
 * structure is complete rather than at the end of the buffer.
 */
export function parseRegistrySync(payload: Buffer): RegistryEntry[] {
  // A terminator arriving with no preceding chunks assembles to an empty buffer,
  // which legitimately means "nothing synced" rather than a malformed payload.
  if (payload.length === 0) return []

  const reader = new Reader(payload)
  const entries: RegistryEntry[] = []

  const registryNamespaceCount = reader.varInt()
  for (let a = 0; a < registryNamespaceCount; a++) {
    const registryNamespace = reader.string() || 'minecraft'
    const registryCount = reader.varInt()

    for (let b = 0; b < registryCount; b++) {
      const registry = `${registryNamespace}:${reader.string()}`
      reader.varInt() // attribute bitset; unused here
      const entryNamespaceCount = reader.varInt()

      // Delta base is per registry, not per namespace group.
      let lastId = 0
      for (let c = 0; c < entryNamespaceCount; c++) {
        const entryNamespace = reader.string() || 'minecraft'
        const runCount = reader.varInt()

        for (let d = 0; d < runCount; d++) {
          const start = lastId + reader.varInt()
          const count = reader.varInt()
          for (let e = 0; e < count; e++) {
            entries.push({
              registry,
              name: `${entryNamespace}:${reader.string()}`,
              id: start + e,
            })
          }
          lastId = start + count - 1
        }
      }
    }
  }

  return entries
}

/**
 * The entries a vanilla client would not know about — everything outside the
 * `minecraft` namespace. Deliberately namespace-based rather than a mod list, so
 * a newly added mod is picked up with no code change.
 */
export function moddedEntries(entries: readonly RegistryEntry[]): RegistryEntry[] {
  return entries.filter((e) => !e.name.startsWith('minecraft:'))
}
