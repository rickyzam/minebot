import { createHmac, createHash } from 'node:crypto'

/**
 * Velocity "modern" player-info forwarding, from the client side.
 *
 * When a Minecraft server sits behind a Velocity proxy, the backend is put in
 * offline mode and trusts the proxy to have authenticated the player. To stop
 * anyone simply connecting to the backend directly and claiming to be whoever
 * they like, the backend demands a forwarding payload signed with a secret it
 * shares with the proxy, and rejects every login that cannot produce one:
 *
 *   This server requires you to connect with Velocity.
 *
 * That lock is the point — but it also shuts out our bots, which have no Mojang
 * account to authenticate with and so cannot come through the proxy. Since the
 * bots run on the same trusted machine as the proxy, they can hold the same
 * secret and sign their own forwarding data. The backend stays closed to the
 * internet, humans keep their real Mojang UUIDs through the proxy, and bots cost
 * nothing.
 *
 * The exchange, observed against FabricProxy-Lite 2.11.0 on 1.21.10:
 *
 *  - During the **login** phase the backend sends `login_plugin_request` on
 *    channel `velocity:player_info`, with a one-byte body holding the highest
 *    forwarding version it supports (observed: `4`).
 *  - The client replies `login_plugin_response` with
 *    `HMAC-SHA256(secret, payload) || payload`.
 *
 * Everything here is pure and testable without a server or a network.
 */

/** Channel the backend uses to demand forwarding data. */
export const VELOCITY_PLAYER_INFO_CHANNEL = 'velocity:player_info'

/**
 * Forwarding payload versions, named as Velocity names them. We send
 * `DEFAULT`: the later versions only add the player's Mojang public key, which
 * a bot does not have and the backend does not require.
 */
export const FORWARDING_VERSION = {
  DEFAULT: 1,
  WITH_KEY: 2,
  WITH_KEY_V2: 3,
  LAZY_SESSION: 4,
} as const

/** A profile property, e.g. `textures`, forwarded to the backend. */
export interface ProfileProperty {
  readonly name: string
  readonly value: string
  readonly signature?: string
}

export interface ForwardingIdentity {
  /** Address the backend should believe the player connected from. */
  readonly address: string
  /** 16-byte player UUID. */
  readonly uuid: Buffer
  readonly username: string
  /** Profile properties. `textures` here is what gives a bot a skin. */
  readonly properties?: readonly ProfileProperty[]
}

const writeVarInt = (value: number): Buffer => {
  const bytes: number[] = []
  let v = value >>> 0
  do {
    let byte = v & 0x7f
    v >>>= 7
    if (v !== 0) byte |= 0x80
    bytes.push(byte)
  } while (v !== 0)
  return Buffer.from(bytes)
}

const writeString = (value: string): Buffer => {
  const utf8 = Buffer.from(value, 'utf8')
  return Buffer.concat([writeVarInt(utf8.length), utf8])
}

/**
 * The offline UUID a vanilla server would assign to `username`: a version-3
 * (name-based, MD5) UUID over `OfflinePlayer:<username>`.
 *
 * Deliberately the same value an offline-mode server would generate, so a bot's
 * identity — and therefore its inventory and position — survives the proxy being
 * added or removed. Inventing a random UUID would silently orphan its player data
 * the first time the topology changed.
 */
export function offlineUuid(username: string): Buffer {
  const hash = createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest()
  // Stamp version 3 and the RFC 4122 variant, exactly as Java's
  // UUID.nameUUIDFromBytes does.
  hash[6] = (hash[6]! & 0x0f) | 0x30
  hash[8] = (hash[8]! & 0x3f) | 0x80
  return hash
}

/** Format a 16-byte UUID buffer as the canonical dashed string. */
export function formatUuid(uuid: Buffer): string {
  const hex = uuid.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Encode the forwarding payload the backend verifies and then trusts as the
 * player's identity.
 */
export function encodeForwardingData(identity: ForwardingIdentity): Buffer {
  if (identity.uuid.length !== 16) {
    throw new Error(`velocity forwarding: uuid must be 16 bytes, got ${identity.uuid.length}`)
  }
  const properties = identity.properties ?? []
  const parts: Buffer[] = [
    writeVarInt(FORWARDING_VERSION.DEFAULT),
    writeString(identity.address),
    identity.uuid,
    writeString(identity.username),
    writeVarInt(properties.length),
  ]
  for (const property of properties) {
    parts.push(writeString(property.name), writeString(property.value))
    if (property.signature === undefined) {
      parts.push(Buffer.from([0]))
    } else {
      parts.push(Buffer.from([1]), writeString(property.signature))
    }
  }
  return Buffer.concat(parts)
}

/**
 * Build the `textures` profile property that gives a bot a skin.
 *
 * This is the same shape Mojang serves for a real account, so forwarding it
 * makes the bot render with that skin for everyone on the server — useful once
 * several bots are on screen at once and need telling apart.
 *
 * The property is unsigned, which a backend accepts because it already trusts
 * the forwarding payload's HMAC. It does mean the skin must be reachable by the
 * *clients* viewing it, so use a URL served by Mojang's texture CDN.
 */
export function texturesProperty(opts: {
  url: string
  username?: string
  uuid?: Buffer
  model?: 'classic' | 'slim'
}): ProfileProperty {
  const skin: { url: string; metadata?: { model: string } } = { url: opts.url }
  if (opts.model === 'slim') skin.metadata = { model: 'slim' }

  const value = {
    timestamp: 0,
    profileId: opts.uuid ? formatUuid(opts.uuid).replaceAll('-', '') : undefined,
    profileName: opts.username,
    textures: { SKIN: skin },
  }
  return {
    name: 'textures',
    value: Buffer.from(JSON.stringify(value), 'utf8').toString('base64'),
  }
}

/**
 * Build the full `login_plugin_response` body: the HMAC-SHA256 signature over
 * the payload, followed by the payload itself. A backend with a different secret
 * rejects it with "Secret check failed."
 */
export function buildForwardingResponse(secret: string, identity: ForwardingIdentity): Buffer {
  if (secret.length === 0) {
    throw new Error('velocity forwarding: secret must not be empty')
  }
  const data = encodeForwardingData(identity)
  const signature = createHmac('sha256', secret).update(data).digest()
  return Buffer.concat([signature, data])
}
