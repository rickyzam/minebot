import { describe, it, expect, afterEach } from 'vitest'
import type { Result } from '@minebot/contract'
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

  it('delivers disconnected only after the bot is already marked not-connected', async () => {
    // Regression guard: wireBotEvents' own 'end' listener must not fire before
    // watchForUnexpectedDisconnect's — otherwise a 'disconnected' handler (the
    // natural place to react by calling connect() again) would see this.bot
    // still pointing at the dead bot, and getState()/findBlocks() would
    // silently operate on it instead of throwing "not connected".
    executor = new MineflayerExecutor({ username: 'ITOrder' })
    const other = new MineflayerExecutor({ username: 'ITOrder' })
    try {
      await executor.connect()
      let sawDisconnected = false
      let threwOnGetState = false
      const off = executor.on('disconnected', () => {
        sawDisconnected = true
        try {
          executor!.getState()
        } catch {
          threwOnGetState = true
        }
      })

      // Force an unexpected drop the same way the test above does: a second
      // bot with the same username kicks this one via duplicate_login.
      await other.connect()

      const deadline = Date.now() + 5_000
      while (Date.now() < deadline && !sawDisconnected) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      off()
      expect(sawDisconnected).toBe(true)
      expect(threwOnGetState).toBe(true)
    } finally {
      await other.disconnect()
    }
  })

  it('shares the in-flight attempt when connect() is re-entered from the spawned handler', async () => {
    // Regression guard for connect()'s guard ordering: this.bot is assigned
    // in onSpawn, but openConnection() doesn't resolve until well after —
    // it still has to wait for the first health packet and (best-effort) for
    // chunks to load, ~550ms total. If `if (this.bot) return ok(undefined)`
    // were checked before the `pendingConnect` guard, a second connect()
    // fired from inside the 'spawned' handler would see a non-null this.bot
    // and resolve `ok` immediately — before health has populated — instead
    // of sharing the in-flight attempt. This window only exists against the
    // real bot; MockExecutor flips `connected` inside its IIFE only once the
    // attempt completes, so this cannot be expressed as a unit/mock test.
    executor = new MineflayerExecutor({ username: 'ITReentrant' })

    // Discriminator: does `second` settle only once the *whole* first attempt
    // (openConnection(), including its chunk-load wait) has settled, or does
    // it resolve on its own via a fast path? Measuring this by reading
    // `bot.health` at the moment `second` resolves turned out to be
    // unreliable in practice — the real 'health' packet can arrive close
    // enough behind 'spawn' that it lands within the same synchronous
    // packet-processing batch, populating health before even a same-tick
    // fast-path resolution's microtask runs. Promise identity/ordering is
    // immune to that: under the fix, `second` IS `this.pendingConnect`, the
    // exact same promise the outer `firstPromise` below holds, so a `.then()`
    // attached to `firstPromise` before `second` is ever created is
    // guaranteed (same-promise `.then()` callbacks fire in attachment order)
    // to run first. Under the bug, `second` resolves on its own via a fresh,
    // near-instant microtask — well before `firstPromise` (which additionally
    // awaits the best-effort chunk-load wait) can settle.
    let firstSettled = false
    const firstPromise = executor.connect()
    void firstPromise.then(() => {
      firstSettled = true
    })

    let second: Promise<Result> | null = null
    let firstSettledBeforeSecond = false
    const off = executor.on('spawned', () => {
      // Fired synchronously from inside onSpawn, before openConnection() has
      // resolved: this.bot is already non-null here, so a buggy guard order
      // would let this call take the `if (this.bot) return ok(undefined)`
      // fast path instead of sharing the in-flight attempt.
      second = executor!.connect()
      void second.then(() => {
        firstSettledBeforeSecond = firstSettled
      })
    })

    const first = await firstPromise
    off()

    expect(first.ok).toBe(true)
    expect(second).not.toBeNull()
    const secondResult = await second!
    expect(secondResult.ok).toBe(true)
    // The discriminating assertion: `second` must not settle before `first`
    // — i.e. it genuinely shared the in-flight attempt rather than
    // short-circuiting on a spawned-but-not-ready bot.
    expect(firstSettledBeforeSecond).toBe(true)
    expect(executor.getState().self.health).toBeGreaterThan(0)
  })

  it('reports disconnected when the server refuses the connection', async () => {
    executor = new MineflayerExecutor({ username: 'ITBadPort', port: 25599, connectTimeoutMs: 8_000 })
    const r = await executor.connect()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(['disconnected', 'timeout']).toContain(r.reason)
  })
})
