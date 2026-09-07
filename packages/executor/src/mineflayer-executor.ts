import mineflayer, { type Bot } from 'mineflayer'
import {
  ok,
  fail,
  type ActionOptions,
  type BlockInfo,
  type BlockQuery,
  type BotEvents,
  type BotExecutor,
  type Result,
  type Unsubscribe,
  type Vec3,
  type WorldSnapshot,
} from '@minebot/contract'
import { classifyEntity, toSnapshot, type MineflayerLike } from './snapshot.js'

export interface MineflayerExecutorOptions {
  host?: string
  port?: number
  username?: string
  version?: string
  connectTimeoutMs?: number
}

export class MineflayerExecutor implements BotExecutor {
  private bot: Bot | null = null
  private readonly host: string
  private readonly port: number
  private readonly username: string
  private readonly version: string
  private readonly connectTimeoutMs: number
  /**
   * Settles the currently in-flight cancellable action (currently only
   * `moveTo`) as `interrupted`, if one is running. `stop()` invokes this
   * before clearing control states — without it, `stop()` only cleared
   * control states for a single tick, and `moveTo`'s own `physicsTick`
   * handler re-asserted `setControlState('forward', true)` on the very next
   * tick (≤50ms later), so the bot kept walking through the "emergency
   * brake" Phase 5's reflex layer depends on.
   */
  private inFlightStop: (() => void) | null = null
  /**
   * Design spec §9.1. Handlers live on the executor, not on any single Bot, so
   * a subscription taken before connect() — or held across a reconnect — keeps
   * firing. Previously handlers bound to the Bot live at subscribe time, so
   * after a drop they attached to a dead emitter and silently went quiet, which
   * is exactly the failure the reflex layer could not survive.
   */
  private readonly handlers = new Map<keyof BotEvents, Set<(payload: never) => void>>()
  /** Detach functions for the Mineflayer listeners feeding the emitter. */
  private botWiring: Array<() => void> = []
  /**
   * Design spec §9.4. Without this, a second connect() before the first
   * resolves creates a second Bot; on an offline-mode server that is a
   * duplicate login, and the server kicks the first one.
   */
  private pendingConnect: Promise<Result> | null = null
  private disconnectRequested = false

  constructor(opts: MineflayerExecutorOptions = {}) {
    this.host = opts.host ?? 'localhost'
    this.port = opts.port ?? 25565
    this.username = opts.username ?? 'MineBot'
    this.version = opts.version ?? '1.21.10'
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 30_000
  }

  async connect(): Promise<Result> {
    if (this.bot) return ok(undefined)
    if (this.pendingConnect) return this.pendingConnect

    this.disconnectRequested = false
    this.pendingConnect = this.openConnection()
    try {
      const result = await this.pendingConnect
      if (result.ok && this.disconnectRequested) {
        // disconnect() was called while this was in flight — honour it rather
        // than handing back a connection the caller has already abandoned.
        await this.teardown()
        return fail('interrupted', 'disconnect() during connect()')
      }
      return result
    } finally {
      this.pendingConnect = null
    }
  }

  private async openConnection(): Promise<Result> {
    const bot = mineflayer.createBot({
      host: this.host,
      port: this.port,
      username: this.username,
      auth: 'offline',
      version: this.version,
    })

    return new Promise<Result>((resolve) => {
      let settled = false
      let healthTimer: ReturnType<typeof setTimeout> | undefined

      const finish = (result: Result): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (healthTimer) clearTimeout(healthTimer)
        bot.removeListener('spawn', onSpawn)
        bot.removeListener('error', onError)
        bot.removeListener('kicked', onKicked)
        resolve(result)
      }
      const proceed = (): void => {
        // DEVIATION (not in the brief): world chunks around the bot finish loading
        // shortly *after* the first health packet, not before or alongside it
        // (verified empirically against the live dev server: findBlocks() returns
        // nothing if called immediately on the health packet, and returns results
        // ~50-100ms later). Best-effort wait so connect() hands back a world that
        // findBlocks()/getState() can actually see; never fail connect() over it.
        bot
          .waitForChunksToLoad()
          .catch(() => {
            // Timed out or errored — proceed anyway; the bot is connected and
            // healthy, just possibly missing some distant chunks.
          })
          .finally(() => finish(ok(undefined)))
      }
      const onSpawn = (): void => {
        this.bot = bot
        // Order matters: watchForUnexpectedDisconnect's 'end' listener must be
        // registered before wireBotEvents' 'end' listener, so that on an
        // unexpected drop it runs first and clears this.bot/unwires before any
        // subscriber's 'disconnected' handler sees the event. Node's emit()
        // dispatches listeners in registration order but iterates a clone of
        // the array, so wireBotEvents' handler still fires even though the
        // watch handler unregisters everything mid-dispatch — the same
        // semantics the explicit spawned emit below already relies on.
        this.watchForUnexpectedDisconnect(bot)
        this.wireBotEvents(bot)
        // The 'spawn' listener added by wireBotEvents was attached during this
        // very 'spawn' dispatch, so it does not see the event that is firing
        // now. Emit it explicitly, or a handler registered before connect()
        // misses the spawn it was waiting for.
        this.emit('spawned', {})
        // VERIFIED 2026-09-07: bot.health is `undefined` at the 'spawn' event and
        // only populates when the server's first health packet lands, ~100ms later.
        // Resolving on 'spawn' alone would hand callers a snapshot reporting health 0.
        if (bot.health !== undefined) {
          proceed()
          return
        }
        healthTimer = setTimeout(() => proceed(), 5_000)
        bot.once('health', () => proceed())
      }
      const onError = (e: Error): void => {
        this.bot = null
        finish(fail('disconnected', e.message))
      }
      const onKicked = (reason: unknown): void => {
        this.bot = null
        finish(fail('disconnected', `kicked: ${JSON.stringify(reason)}`))
      }
      const timer = setTimeout(() => {
        this.bot = null
        try {
          bot.quit()
        } catch {
          // nothing to close
        }
        finish(fail('timeout', `no spawn within ${this.connectTimeoutMs}ms`))
      }, this.connectTimeoutMs)

      bot.once('spawn', onSpawn)
      bot.once('error', onError)
      bot.once('kicked', onKicked)
    })
  }

  async disconnect(): Promise<void> {
    this.disconnectRequested = true
    const pending = this.pendingConnect
    if (pending) await pending.catch(() => undefined)
    await this.teardown()
  }

  private async teardown(): Promise<void> {
    const bot = this.bot
    if (!bot) return
    this.bot = null
    this.unwireBotEvents()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000)
      bot.once('end', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        bot.quit()
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  getState(): WorldSnapshot {
    return toSnapshot(this.requireBot() as MineflayerLike)
  }

  findBlocks(query: BlockQuery): readonly BlockInfo[] {
    const bot = this.requireBot()
    if (query.names.length === 0) return []
    const names = new Set(query.names)
    const origin = bot.entity.position
    const positions = bot.findBlocks({
      matching: (block) => block !== null && names.has(block.name),
      maxDistance: query.maxDistance,
      count: query.limit,
    })
    return Object.freeze(
      positions
        .slice(0, query.limit)
        .map((p) =>
          Object.freeze({
            name: bot.blockAt(p)?.name ?? 'unknown',
            position: Object.freeze({ x: p.x, y: p.y, z: p.z }),
            distance: Math.hypot(p.x - origin.x, p.y - origin.y, p.z - origin.z),
          }),
        )
        // Fix 4 (post-review): Mineflayer's own findBlocks() sorts nearest-first
        // relative to a *floored* origin point, but we report `distance`
        // relative to the bot's exact (unfloored) position — the two can
        // disagree by up to ~sqrt(3) blocks, which was enough to occasionally
        // flip the reported order out of the nearest-first guarantee
        // BlockQuery/BlockInfo document. Re-sort by the exact distance we
        // actually report, so the array we hand back is self-consistently
        // ordered by its own `distance` field.
        .sort((a, b) => a.distance - b.distance),
    )
  }

  on<K extends keyof BotEvents>(
    event: K,
    handler: (payload: BotEvents[K]) => void,
  ): Unsubscribe {
    const set = this.handlers.get(event) ?? new Set<(payload: never) => void>()
    set.add(handler as (payload: never) => void)
    this.handlers.set(event, set)
    return () => {
      set.delete(handler as (payload: never) => void)
    }
  }

  private emit<K extends keyof BotEvents>(event: K, payload: BotEvents[K]): void {
    for (const h of this.handlers.get(event) ?? []) {
      try {
        ;(h as (p: BotEvents[K]) => void)(payload)
      } catch {
        // A subscriber's own bug must not take down the emitter or whatever
        // action (e.g. connect()) triggered this emit — swallow and keep
        // delivering to the remaining handlers.
      }
    }
  }

  /**
   * Wire one Bot's events into the long-lived emitter. NOT idempotent: calling
   * this twice with the same bot double-registers every listener. Callers
   * must only invoke it once per bot (currently: once, from onSpawn).
   */
  private wireBotEvents(bot: Bot): void {
    const add = <A extends unknown[]>(
      mineflayerEvent: string,
      handler: (...args: A) => void,
    ): void => {
      bot.on(mineflayerEvent as never, handler as never)
      this.botWiring.push(() => void bot.removeListener(mineflayerEvent as never, handler as never))
    }

    add('spawn', () => this.emit('spawned', {}))
    add('health', () => this.emit('health', { health: bot.health, food: bot.food }))
    add('entityHurt', (entity: { id: number }) => {
      if (entity.id !== bot.entity?.id) return
      this.emit('damaged', { health: bot.health, source: null })
    })
    add('entitySpawn', (e: { id: number; position: { x: number; y: number; z: number } }) => {
      const origin = bot.entity?.position
      if (!origin) return
      this.emit('entityNearby', {
        entity: {
          id: e.id,
          name: (e as { username?: string }).username ?? (e as { name?: string }).name ?? 'unknown',
          kind: classifyEntity(e as never),
          position: { x: e.position.x, y: e.position.y, z: e.position.z },
          distance: Math.hypot(
            e.position.x - origin.x,
            e.position.y - origin.y,
            e.position.z - origin.z,
          ),
        },
      })
    })
    add('chat', (username: string, message: string) => this.emit('chat', { username, message }))
    add('death', () => this.emit('death', {}))
    add('end', (reason: string) => this.emit('disconnected', { reason }))
  }

  private unwireBotEvents(): void {
    for (const detach of this.botWiring) detach()
    this.botWiring = []
  }

  async moveTo(target: Vec3, opts?: ActionOptions): Promise<Result> {
    if (opts?.signal?.aborted) return fail('interrupted', 'aborted before start')
    const bot = this.bot
    if (!bot) return fail('disconnected', 'not connected')

    const timeoutMs = opts?.timeoutMs ?? 30_000
    const tolerance = 1.5

    return new Promise<Result>((resolve) => {
      let settled = false
      const signal = opts?.signal

      const cleanup = (): void => {
        clearTimeout(timer)
        bot.removeListener('physicsTick', onTick)
        signal?.removeEventListener('abort', onAbort)
        if (this.inFlightStop === stopThisMove) this.inFlightStop = null
        try {
          bot.clearControlStates()
        } catch {
          // disconnected mid-move
        }
      }
      const finish = (result: Result): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }
      const onAbort = (): void => {
        finish(fail('interrupted', 'aborted mid-move'))
      }
      const stopThisMove = (): void => {
        finish(fail('interrupted', 'stopped via stop()'))
      }
      this.inFlightStop = stopThisMove
      const onTick = (): void => {
        const p = bot.entity.position
        const dx = target.x - p.x
        const dz = target.z - p.z
        if (Math.hypot(dx, dz) <= tolerance) {
          finish(ok(undefined))
          return
        }
        // Minecraft yaw: 0 faces -Z, increasing counter-clockwise.
        void bot.look(Math.atan2(-dx, -dz), 0, true)
        bot.setControlState('forward', true)
        // prismarine-entity's .d.ts doesn't declare isCollidedHorizontally, but
        // mineflayer's physics plugin sets it on the live entity at runtime
        // (verified against the dev server) — cast narrowly to read it.
        const entityWithCollisionFlags = bot.entity as unknown as {
          isCollidedHorizontally?: boolean
        }
        bot.setControlState('jump', entityWithCollisionFlags.isCollidedHorizontally === true)
      }
      const timer = setTimeout(
        () => finish(fail('timeout', `did not reach target within ${timeoutMs}ms`)),
        timeoutMs,
      )

      signal?.addEventListener('abort', onAbort, { once: true })
      bot.on('physicsTick', onTick)
    })
  }

  async followPlayer(_playerName: string, opts?: ActionOptions): Promise<Result> {
    if (opts?.signal?.aborted) return fail('interrupted', 'aborted before start')
    if (!this.bot) return fail('disconnected', 'not connected')
    return fail('internal', 'followPlayer arrives in Phase 5')
  }

  async mineBlock(
    _blockName: string,
    _maxDistance: number,
    opts?: ActionOptions,
  ): Promise<Result<{ position: Vec3; collected: boolean }>> {
    if (opts?.signal?.aborted) return fail('interrupted', 'aborted before start')
    if (!this.bot) return fail('disconnected', 'not connected')
    return fail('internal', 'mineBlock arrives in Phase 2')
  }

  async placeBlock(_blockName: string, _position: Vec3, opts?: ActionOptions): Promise<Result> {
    if (opts?.signal?.aborted) return fail('interrupted', 'aborted before start')
    if (!this.bot) return fail('disconnected', 'not connected')
    return fail('internal', 'placeBlock arrives in Phase 5')
  }

  async attack(_entityId: number, opts?: ActionOptions): Promise<Result> {
    if (opts?.signal?.aborted) return fail('interrupted', 'aborted before start')
    if (!this.bot) return fail('disconnected', 'not connected')
    return fail('internal', 'attack arrives in Phase 5')
  }

  async flee(opts?: ActionOptions): Promise<Result> {
    if (opts?.signal?.aborted) return fail('interrupted', 'aborted before start')
    if (!this.bot) return fail('disconnected', 'not connected')
    return fail('internal', 'flee arrives in Phase 5')
  }

  chat(message: string): void {
    this.bot?.chat(message)
  }

  stop(): void {
    // Settle any in-flight cancellable action first (as `interrupted`) — its
    // own cleanup clears control states, but we clear them again below
    // unconditionally, in case something set a control state outside of a
    // tracked action.
    const cancel = this.inFlightStop
    this.inFlightStop = null
    cancel?.()
    try {
      this.bot?.clearControlStates()
    } catch {
      // safe to call when disconnected
    }
  }

  private requireBot(): Bot {
    if (!this.bot) throw new Error('MineflayerExecutor is not connected')
    return this.bot
  }

  /**
   * FIX (post-review): once connect() has handed a bot to a caller, nothing was
   * watching for that connection dying on its own (kicked, network drop, server
   * restart). this.bot would stay a stale non-null reference forever, making a
   * later connect() short-circuit via the `if (this.bot) return ok(undefined)`
   * guard, and getState()/findBlocks()/on() silently operate on a dead bot
   * instead of throwing "not connected" as the contract promises.
   *
   * The identity check (`this.bot === bot`) makes this idempotent and safe to
   * layer under disconnect(): disconnect() already sets `this.bot = null` before
   * awaiting 'end', so by the time this fires there, the check is false and it
   * no-ops rather than double-clearing (which could otherwise wipe out a newer
   * connection established by a fresh connect() in between).
   */
  private watchForUnexpectedDisconnect(bot: Bot): void {
    bot.once('end', () => {
      if (this.bot === bot) {
        this.bot = null
        this.unwireBotEvents()
      }
    })
  }
}
