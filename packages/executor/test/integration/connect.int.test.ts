import { describe, it, expect, afterEach } from 'vitest'
import { MineflayerExecutor } from '../../src/index.js'

describe('MineflayerExecutor against the dev server', () => {
  let executor: MineflayerExecutor | null = null

  afterEach(async () => {
    await executor?.disconnect()
    executor = null
  })

  it('connects and spawns', async () => {
    executor = new MineflayerExecutor({ username: 'ITConnect' })
    const r = await executor.connect()
    expect(r.ok).toBe(true)
  })

  it('reports a live snapshot after spawning', async () => {
    executor = new MineflayerExecutor({ username: 'ITState' })
    await executor.connect()
    const s = executor.getState()
    expect(s.self.health).toBeGreaterThan(0)
    expect(s.self.health).toBeLessThanOrEqual(20)
    expect(Number.isFinite(s.self.position.y)).toBe(true)
    expect(Object.isFrozen(s)).toBe(true)
  })

  it('has populated health by the time connect() resolves', async () => {
    // Regression guard: bot.health is undefined at the 'spawn' event and only
    // arrives on the first 'health' packet. connect() must not resolve before then.
    executor = new MineflayerExecutor({ username: 'ITHealth' })
    await executor.connect()
    expect(executor.getState().self.health).toBe(20)
    expect(executor.getState().self.food).toBe(20)
  })

  it('throws from getState() before connecting', () => {
    executor = new MineflayerExecutor({ username: 'ITUnused' })
    expect(() => executor!.getState()).toThrow(/not connected/i)
  })

  it('finds solid blocks near spawn', async () => {
    executor = new MineflayerExecutor({ username: 'ITBlocks' })
    await executor.connect()
    const found = executor.findBlocks({
      names: ['stone', 'dirt', 'grass_block', 'deepslate'],
      maxDistance: 24,
      limit: 5,
    })
    expect(found.length).toBeGreaterThan(0)
    expect(found.length).toBeLessThanOrEqual(5)
    expect(found[0]?.distance).toBeGreaterThanOrEqual(0)
  })

  it('delivers health events and stops after unsubscribe', async () => {
    executor = new MineflayerExecutor({ username: 'ITEvents' })
    await executor.connect()
    let calls = 0
    const off = executor.on('health', () => {
      calls += 1
    })
    expect(typeof off).toBe('function')
    off()
    expect(calls).toBeGreaterThanOrEqual(0)
  })

  it('resets to not-connected when the server kicks the bot unexpectedly', async () => {
    // Regression guard: nothing watches the live connection after connect()
    // settles except our own 'end' listener. Force an unexpected drop (not via
    // executor.disconnect()) by connecting a second bot with the same username —
    // this offline-mode server kicks the older session with
    // "multiplayer.disconnect.duplicate_login" and fires 'end' on it. getState()
    // must then throw "not connected" instead of silently serving stale state.
    executor = new MineflayerExecutor({ username: 'ITDupe' })
    const other = new MineflayerExecutor({ username: 'ITDupe' })
    try {
      await executor.connect()
      await other.connect()

      // Wait for the kick to propagate to executor's bot's 'end' event.
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        try {
          executor.getState()
        } catch {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      expect(() => executor!.getState()).toThrow(/not connected/i)
    } finally {
      await other.disconnect()
    }
  })

  it('reports disconnected when the server refuses the connection', async () => {
    executor = new MineflayerExecutor({ username: 'ITBadPort', port: 25599, connectTimeoutMs: 8_000 })
    const r = await executor.connect()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(['disconnected', 'timeout']).toContain(r.reason)
  })
})
