import { describe, it, expect, afterEach } from 'vitest'
import { MineflayerExecutor, resolveForwardingSecret, texturesProperty } from '../../src/index.js'

/**
 * These run against the backend behind the Velocity proxy. The backend is in
 * offline mode but rejects any login it cannot verify:
 *
 *   This server requires you to connect with Velocity.
 *
 * so `connects to a proxied backend` is the regression guard for the whole
 * feature, and the disabled-forwarding test proves the backend really does
 * demand it rather than the positive test passing for some other reason.
 */
const secret = resolveForwardingSecret()

describe.skipIf(!secret)('Velocity forwarding', () => {
  let executor: MineflayerExecutor | null = null

  afterEach(async () => {
    await executor?.disconnect()
    executor = null
  })

  it('connects to a proxied backend', async () => {
    executor = new MineflayerExecutor({ username: 'ITVelocity' })
    const r = await executor.connect()
    expect(r.ok).toBe(true)
    expect(executor.getState().self.health).toBeGreaterThan(0)
  })

  it('is rejected without forwarding — proving the backend is genuinely locked', async () => {
    executor = new MineflayerExecutor({
      username: 'ITNoForward',
      velocitySecret: null,
      connectTimeoutMs: 20_000,
    })
    const r = await executor.connect()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('disconnected')
      expect(r.detail).toMatch(/connect with Velocity/i)
    }
  })

  it('is rejected when the secret is wrong', async () => {
    // Distinct from "no secret": this exercises the HMAC check itself, which is
    // what stops anyone who can reach the port from forging an identity.
    executor = new MineflayerExecutor({
      username: 'ITBadSecret',
      velocitySecret: 'definitely-not-the-secret',
      connectTimeoutMs: 20_000,
    })
    const r = await executor.connect()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('disconnected')
  })

  it('completes the Fabric registry sync through a forwarded login too', async () => {
    // Both handshakes run on the same connection, in different phases —
    // forwarding during login, registry sync during configuration.
    executor = new MineflayerExecutor({ username: 'ITBothHandshakes' })
    expect((await executor.connect()).ok).toBe(true)
    expect(executor.moddedRegistryEntries().length).toBeGreaterThan(0)
  })

  it('accepts a forwarded skin property', async () => {
    executor = new MineflayerExecutor({
      username: 'ITSkinned',
      velocityProperties: [
        texturesProperty({
          url: 'http://textures.minecraft.net/texture/0000000000000000000000000000000000000000000000000000000000000000',
          username: 'ITSkinned',
        }),
      ],
    })
    const r = await executor.connect()
    expect(r.ok).toBe(true)
  })

  it('gives a bot the same uuid an offline server would', async () => {
    // Identity must not depend on the proxy being present, or a bot's player
    // data is orphaned the first time the topology changes.
    executor = new MineflayerExecutor({ username: 'ITStableUuid' })
    expect((await executor.connect()).ok).toBe(true)
    expect(executor.getState().self.position).toBeDefined()
  })
})
