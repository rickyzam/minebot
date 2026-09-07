import { createHmac } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import {
  offlineUuid,
  formatUuid,
  encodeForwardingData,
  buildForwardingResponse,
  FORWARDING_VERSION,
  VELOCITY_PLAYER_INFO_CHANNEL,
  texturesProperty,
} from '../src/velocity-forwarding.js'

describe('offlineUuid', () => {
  it('matches the UUID an offline-mode server derives for a name', () => {
    // Java's UUID.nameUUIDFromBytes("OfflinePlayer:Notch") — the same value a
    // vanilla offline server assigns, which is the point: a bot's identity, and
    // so its inventory, survives the proxy being added or removed.
    expect(formatUuid(offlineUuid('Notch'))).toBe('b50ad385-829d-3141-a216-7e7d7539ba7f')
  })

  it('stamps version 3 and the RFC 4122 variant', () => {
    const uuid = offlineUuid('AnyName')
    expect(uuid).toHaveLength(16)
    expect(uuid[6]! & 0xf0).toBe(0x30)
    expect(uuid[8]! & 0xc0).toBe(0x80)
  })

  it('is stable for a name and distinct between names', () => {
    expect(offlineUuid('MineBot')).toEqual(offlineUuid('MineBot'))
    expect(offlineUuid('MineBot')).not.toEqual(offlineUuid('MineBot2'))
  })

  it('formats as a canonical dashed UUID', () => {
    expect(formatUuid(offlineUuid('MineBot'))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })
})

describe('encodeForwardingData', () => {
  const identity = {
    address: '127.0.0.1',
    uuid: offlineUuid('MineBot'),
    username: 'MineBot',
  }

  it('starts with forwarding version 1', () => {
    // Later versions only add a Mojang public key, which a bot does not have.
    expect(encodeForwardingData(identity)[0]).toBe(FORWARDING_VERSION.DEFAULT)
  })

  it('encodes address and username as length-prefixed UTF-8, with the raw uuid between', () => {
    const encoded = encodeForwardingData(identity)
    let offset = 1
    expect(encoded[offset]).toBe(identity.address.length)
    offset += 1
    expect(encoded.subarray(offset, offset + identity.address.length).toString('utf8')).toBe('127.0.0.1')
    offset += identity.address.length
    expect(encoded.subarray(offset, offset + 16)).toEqual(identity.uuid)
    offset += 16
    expect(encoded[offset]).toBe(identity.username.length)
    offset += 1
    expect(encoded.subarray(offset, offset + identity.username.length).toString('utf8')).toBe('MineBot')
    offset += identity.username.length
    expect(encoded[offset]).toBe(0) // no properties
  })

  it('encodes properties, marking the absence of a signature', () => {
    const encoded = encodeForwardingData({
      ...identity,
      properties: [{ name: 'textures', value: 'abc' }],
    })
    expect(encoded[encoded.length - 1]).toBe(0) // hasSignature = false
    expect(encoded.toString('utf8')).toContain('textures')
    expect(encoded.toString('utf8')).toContain('abc')
  })

  it('encodes a signed property with its signature', () => {
    const encoded = encodeForwardingData({
      ...identity,
      properties: [{ name: 'textures', value: 'abc', signature: 'sig' }],
    })
    const text = encoded.toString('utf8')
    expect(text).toContain('sig')
    // Tail is: hasSignature(1) + varint length(1) + "sig"(3).
    expect(encoded[encoded.length - 5]).toBe(1) // hasSignature = true
    expect(encoded[encoded.length - 4]).toBe(3) // signature length
  })

  it('rejects a uuid that is not 16 bytes rather than sending a malformed login', () => {
    expect(() => encodeForwardingData({ ...identity, uuid: Buffer.alloc(8) })).toThrow(/16 bytes/)
  })
})

describe('buildForwardingResponse', () => {
  const identity = {
    address: '127.0.0.1',
    uuid: offlineUuid('MineBot'),
    username: 'MineBot',
  }

  it('prefixes a 32-byte HMAC-SHA256 over exactly the payload that follows', () => {
    const response = buildForwardingResponse('s3cret', identity)
    const signature = response.subarray(0, 32)
    const payload = response.subarray(32)
    expect(payload).toEqual(encodeForwardingData(identity))
    expect(signature).toEqual(createHmac('sha256', 's3cret').update(payload).digest())
  })

  it('produces a different signature under a different secret', () => {
    // A backend with another secret answers "Secret check failed."
    const a = buildForwardingResponse('secret-a', identity).subarray(0, 32)
    const b = buildForwardingResponse('secret-b', identity).subarray(0, 32)
    expect(a).not.toEqual(b)
  })

  it('is deterministic for the same secret and identity', () => {
    expect(buildForwardingResponse('k', identity)).toEqual(buildForwardingResponse('k', identity))
  })

  it('refuses an empty secret instead of signing with nothing', () => {
    expect(() => buildForwardingResponse('', identity)).toThrow(/secret/i)
  })

  it('names the channel the backend demands', () => {
    expect(VELOCITY_PLAYER_INFO_CHANNEL).toBe('velocity:player_info')
  })
})

describe('texturesProperty', () => {
  const url = 'http://textures.minecraft.net/texture/abc123'

  it('produces a base64 textures property Mojang-style', () => {
    const p = texturesProperty({ url, username: 'MineBot' })
    expect(p.name).toBe('textures')
    const decoded = JSON.parse(Buffer.from(p.value, 'base64').toString('utf8'))
    expect(decoded.textures.SKIN.url).toBe(url)
    expect(decoded.profileName).toBe('MineBot')
  })

  it('is unsigned, which a forwarded login accepts', () => {
    expect(texturesProperty({ url }).signature).toBeUndefined()
  })

  it('marks the slim model only when asked', () => {
    const slim = JSON.parse(Buffer.from(texturesProperty({ url, model: 'slim' }).value, 'base64').toString('utf8'))
    expect(slim.textures.SKIN.metadata.model).toBe('slim')
    const classic = JSON.parse(Buffer.from(texturesProperty({ url, model: 'classic' }).value, 'base64').toString('utf8'))
    expect(classic.textures.SKIN.metadata).toBeUndefined()
  })

  it('writes the profile id undashed, as Mojang does', () => {
    const p = texturesProperty({ url, uuid: offlineUuid('MineBot') })
    const decoded = JSON.parse(Buffer.from(p.value, 'base64').toString('utf8'))
    expect(decoded.profileId).toMatch(/^[0-9a-f]{32}$/)
  })

  it('round-trips through the forwarding payload', () => {
    const property = texturesProperty({ url, username: 'MineBot' })
    const encoded = encodeForwardingData({
      address: '127.0.0.1',
      uuid: offlineUuid('MineBot'),
      username: 'MineBot',
      properties: [property],
    })
    expect(encoded.toString('utf8')).toContain(property.value)
  })
})
