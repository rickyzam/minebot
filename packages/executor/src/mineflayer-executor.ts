import mineflayer, { type Bot } from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import type { goals as PathfinderGoals } from 'mineflayer-pathfinder'
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
import { installFabricHandshake, type ProtocolClientLike } from './fabric-handshake.js'
import type { RegistryEntry } from './fabric-registry.js'
import {
  installVelocityForwarding,
  type LoginClientLike,
  type VelocityForwarding,
  type VelocityForwardingOptions,
} from './velocity-handshake.js'
import { resolveForwardingSecret } from './forwarding-secret.js'
import { canHarvest, bestHarvestTool, type ToolItem } from './harvest.js'

// VERIFIED 2026-09-07: `goals` is not an ESM named export of this CJS package
// — Node's named-export detection finds only `Movements`, `pathfinder` and
// `default`. Destructuring the default import is the only form that resolves
// all three.
const { pathfinder, Movements, goals } = pathfinderPkg

/**
 * A pathfinder goal. Taken from the plugin's own declarations rather than
 * widened to `unknown`, so the goal constructors below are argument-checked at
 * compile time instead of trusted.
 */
type PathfinderGoal = PathfinderGoals.Goal

/**
 * The Block and Vec3 types Mineflayer hands back, derived from its own
 * signatures rather than imported from `prismarine-block`/`vec3`. Those are
 * only transitive dependencies, and this repository pins every dependency it
 * imports explicitly; deriving keeps the types exact with no manifest change.
 *
 * Note `MineflayerVec3` is prismarine's class — with `.offset()`, `.set()`,
 * `.distanceTo()` — not the contract's plain `{ x, y, z }` `Vec3`.
 */
type MineflayerBlock = NonNullable<ReturnType<Bot['blockAt']>>
type MineflayerVec3 = MineflayerBlock['position']

/**
 * How close counts as having arrived, for `moveTo`.
 *
 * `GoalNear(..., 1)` is satisfied within 1 block of the target's block
 * coordinates, and a bot standing on that block sits ~0.87 from its corner
 * origin, so a genuine arrival lands under ~1.9. The margin above that is
 * deliberate: this check exists to catch a pathfinder that stopped metres
 * short, not to re-litigate the goal's own tolerance.
 */
const ARRIVAL_TOLERANCE = 2.5

/**
 * How close the bot must be before a dig is believable. `GoalLookAtBlock`
 * defaults to a reach of 4.5, and the server enforces roughly 4.5-6 for
 * survival block breaking, so anything beyond this was never going to break
 * the block whatever the local world model says afterwards.
 */
const DIG_REACH = 5

/** Straight-line distance from the bot to a point, in blocks. */
const distanceFrom = (bot: Bot, p: { x: number; y: number; z: number }): number => {
  const o = bot.entity.position
  return Math.hypot(o.x - p.x, o.y - p.y, o.z - p.z)
}

export interface MineflayerExecutorOptions {
  host?: string
  /**
   * Defaults to 25566, the backend server. Port 25565 belongs to the Velocity
   * proxy, which authenticates against Mojang and so rejects a bot; bots reach
   * the backend directly and prove themselves with signed forwarding data
   * instead. See `velocitySecret`.
   */
  port?: number
  username?: string
  version?: string
  connectTimeoutMs?: number
  /**
   * Complete Fabric API's registry-sync handshake so the bot can join a server
   * running content-registering mods. Defaults to `true`.
   *
   * On by default because it is inert against a vanilla server — the channel
   * advertisement goes unused and no sync payload ever arrives — while being
   * required by any modded one. Set `false` only to reproduce the unpatched
   * behaviour.
   */
  fabricCompat?: boolean
  /**
   * Shared secret for Velocity modern forwarding. Required when the target
   * server sits behind a Velocity proxy, because such a backend rejects any
   * login that cannot present signed forwarding data.
   *
   * Defaults to `resolveForwardingSecret()` — the `VELOCITY_FORWARDING_SECRET`
   * environment variable, else the proxy's secret file. Pass `null` to force it
   * off for a plain server.
   */
  velocitySecret?: string | null
  /**
   * Profile properties to forward. A `textures` entry gives the bot a skin, so
   * several bots are distinguishable on screen. Only used when forwarding is on.
   */
  velocityProperties?: VelocityForwardingOptions['properties']
  /**
   * Identity to claim when forwarding. Defaults to the offline UUID for the
   * username. Randomise it for disposable bots so viewers do not show a cached
   * skin from a previous run.
   */
  velocityUuid?: Buffer
}

/** Is `host` this machine, and therefore trusted to receive a signed payload? */
function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

export class MineflayerExecutor implements BotExecutor {
  private bot: Bot | null = null
  private readonly host: string
  private readonly port: number
  private readonly username: string
  private readonly version: string
  private readonly connectTimeoutMs: number
  private readonly fabricCompat: boolean
  /**
   * Held in a closure rather than a field so the secret is not an enumerable
   * property: `JSON.stringify(executor)` in a log must not be able to print it.
   * Returns null when forwarding is off.
   */
  private readonly velocitySecret: () => string | null
  private readonly velocityProperties: VelocityForwardingOptions['properties']
  private readonly velocityUuid: Buffer | undefined
  private velocityForwardingState: VelocityForwarding | null = null
  /**
   * Registry entries the server reported that a vanilla client would not know —
   * anything outside the `minecraft` namespace. Empty against a vanilla server.
   * Refreshed on each connect, since a reconnect may reach a differently-modded
   * server.
   */
  private fabricModdedEntries: readonly RegistryEntry[] = []
  /**
   * Cancels the currently in-flight action, if one is running, so it settles
   * as `interrupted`. Owned and cleared by `runAction()`, which sets it for
   * every action rather than only `moveTo`.
   *
   * `stop()` invokes this before clearing control states — without it,
   * `stop()` only cleared control states for a single tick, and `moveTo`'s own
   * `physicsTick` handler re-asserted `setControlState('forward', true)` on
   * the very next tick (≤50ms later), so the bot kept walking through the
   * "emergency brake" Phase 5's reflex layer depends on.
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
    this.port = opts.port ?? 25566
    this.username = opts.username ?? 'MineBot'
    this.version = opts.version ?? '1.21.10'
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 30_000
    this.fabricCompat = opts.fabricCompat ?? true
    // An explicit secret is always honoured. An *auto-discovered* one is used
    // only for a loopback host: signing is an oracle, and pointing the executor
    // at someone else's server should not hand its operator a replayable
    // forwarding token for this bot's username. The proxied backend is loopback
    // by design, so this costs nothing in practice.
    const secret =
      opts.velocitySecret === undefined
        ? isLoopbackHost(this.host)
          ? resolveForwardingSecret()
          : null
        : opts.velocitySecret
    this.velocitySecret = () => secret
    this.velocityProperties = opts.velocityProperties
    this.velocityUuid = opts.velocityUuid
  }

  /**
   * UUID the server assigned this bot, or null when not connected. With
   * forwarding on, this is the identity we asserted — so it is the thing to
   * assert against, not merely that a connection succeeded.
   */
  uuid(): string | null {
    const raw = (this.bot?._client as { uuid?: string } | undefined)?.uuid
    return raw ?? null
  }

  /**
   * State of the Velocity forwarding exchange for the current connection, or
   * null when forwarding is disabled or no connection has been made.
   */
  velocityForwarding(): VelocityForwarding | null {
    return this.velocityForwardingState
  }

  /**
   * Registry entries the connected server reported outside the `minecraft`
   * namespace — modded items, blocks and data components. Empty against a
   * vanilla server, or when `fabricCompat` is disabled.
   *
   * Populated from whatever the server actually registered, so a newly added mod
   * appears here with no code change.
   */
  moddedRegistryEntries(): readonly RegistryEntry[] {
    return this.fabricModdedEntries
  }

  /** Integration-test accessor: is the pathfinder plugin live on this bot? */
  hasPathfinder(): boolean {
    return typeof this.bot?.pathfinder?.goto === 'function'
  }

  async connect(): Promise<Result> {
    // `pendingConnect` must be checked BEFORE `this.bot`. `this.bot` is
    // assigned in onSpawn, but openConnection() doesn't resolve until the
    // health-packet/chunk-load wait finishes, ~550ms later — so for most of
    // every connect(), `this.bot` is already non-null while `pendingConnect`
    // is still unresolved. A spawned-but-not-ready bot must not satisfy the
    // fast path: if the `this.bot` guard ran first, a concurrent connect()
    // in that window would return `ok` immediately, and the caller would see
    // health 0 / an empty findBlocks() — exactly what the health/chunk waits
    // exist to prevent. It would also let that caller resolve `ok` while
    // every caller sharing `pendingConnect` resolves `interrupted` in the
    // disconnect race, contradicting the invariant at lines ~90-100 below.
    if (this.pendingConnect) return this.pendingConnect
    if (this.bot) return ok(undefined)

    this.disconnectRequested = false
    // The disconnect-honouring check and the `pendingConnect = null` clear
    // both live *inside* this shared promise, not in a per-caller wrapper
    // around it. disconnect() awaits this exact promise, so it cannot
    // observe completion — and therefore cannot return, or let a fresh
    // connect() see a cleared slot — until teardown has actually finished.
    // Every caller sharing `this.pendingConnect` also resolves to the same
    // (possibly disconnect-corrected) result, not just the first one to
    // await it. (Fix, post-review: previously this logic sat in connect()'s
    // own try/finally *around* the shared promise, so only the first caller
    // got the correction and disconnect() could return while teardown was
    // still in flight and the slot still non-null.)
    const attempt = (async (): Promise<Result> => {
      try {
        const result = await this.openConnection()
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
    })()
    // The IIFE above runs synchronously up to its first `await`
    // (this.openConnection()'s own synchronous setup), so this assignment
    // still lands before any other synchronous connect() call could run —
    // the reentrancy guarantee (a second concurrent connect() sees a
    // non-null pendingConnect) survives moving the logic inside.
    this.pendingConnect = attempt
    return attempt
  }

  private async openConnection(): Promise<Result> {
    const bot = mineflayer.createBot({
      host: this.host,
      port: this.port,
      username: this.username,
      auth: 'offline',
      version: this.version,
    })

    // Reset first, so nothing from a previous connection can survive even if
    // the install below throws.
    this.fabricModdedEntries = []

    // Install before anything can await: the handshake lives entirely in the
    // configuration phase, which begins immediately after login and well before
    // 'spawn'. Registering later would miss it, and the server would kick us for
    // never advertising the channels.
    const fabric = this.fabricCompat
      ? installFabricHandshake(bot._client as unknown as ProtocolClientLike)
      : null

    // Must also be installed before any await: the forwarding demand arrives
    // during the login phase, earlier still than the Fabric exchange.
    this.velocityForwardingState = null
    const velocitySecret = this.velocitySecret()
    if (velocitySecret) {
      this.velocityForwardingState = installVelocityForwarding(
        bot._client as unknown as LoginClientLike,
        {
          secret: velocitySecret,
          username: this.username,
          properties: this.velocityProperties,
          uuid: this.velocityUuid,
        },
      )
    }

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
        // Movement is non-destructive by design: canDig false means the
        // pathfinder never tunnels. The only blocks this executor breaks are
        // the ones mineBlock was explicitly asked to break — a pathfinder
        // allowed to dig would quietly rewrite the terrain the integration
        // tests depend on.
        bot.loadPlugin(pathfinder)
        const movements = new Movements(bot)
        movements.canDig = false
        bot.pathfinder.setMovements(movements)
        // By 'spawn' the configuration phase is over, so the handshake has
        // either completed or the server never asked for one.
        this.fabricModdedEntries = fabric?.moddedEntries ?? []
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
      // Fix (post-review): onError/onKicked/the connect timeout can all fire
      // *after* onSpawn already ran — during the ~550ms health/chunk wait —
      // at which point wireBotEvents() has already attached its seven
      // listeners to this bot. Nulling this.bot without unwiring them left a
      // dead bot's listeners attached to the executor's long-lived emitter
      // forever (teardown() can't reach them either, since it early-returns
      // when this.bot is already null), including firing 'disconnected' at
      // subscribers for a bot no caller ever knew was live. A duplicate-login
      // kick during that window is realistic on this offline-mode server —
      // the integration tests deliberately provoke it. unwireBotEvents() is a
      // safe no-op when onSpawn never ran (botWiring is still empty).
      const onError = (e: Error): void => {
        this.bot = null
        this.unwireBotEvents()
        this.fabricModdedEntries = []
        finish(fail('disconnected', e.message))
      }
      const onKicked = (reason: unknown): void => {
        this.bot = null
        this.unwireBotEvents()
        this.fabricModdedEntries = []
        finish(fail('disconnected', `kicked: ${JSON.stringify(reason)}`))
      }
      const timer = setTimeout(() => {
        this.bot = null
        this.unwireBotEvents()
        this.fabricModdedEntries = []
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
    this.fabricModdedEntries = []
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

  /**
   * The single owner of cancellation bookkeeping for every action.
   *
   * Guarantees, in this order:
   *  - an already-aborted signal resolves `interrupted` before any work;
   *  - no bot resolves `disconnected`;
   *  - the caller's signal, `stop()`, and the timeout all abort `signal`,
   *    which `body` is responsible for reacting to;
   *  - whatever `body` returns, an aborted run is reported as `interrupted`
   *    (caller abort or stop()) or `timeout`, never as success.
   *
   * It never throws: a body that rejects becomes `internal`, per the contract's
   * resolve-don't-throw rule.
   *
   * Exists because `moveTo` carried ~40 lines of this scaffolding that
   * `mineBlock`'s four cancellable steps would each have repeated, and every
   * repetition is a chance to get the resolve-never-throw rule subtly wrong.
   */
  private async runAction<T>(
    opts: ActionOptions | undefined,
    defaultTimeoutMs: number,
    body: (bot: Bot, signal: AbortSignal) => Promise<Result<T>>,
  ): Promise<Result<T>> {
    if (opts?.signal?.aborted) return fail('interrupted', 'aborted before start')
    const bot = this.bot
    if (!bot) return fail('disconnected', 'not connected')

    const controller = new AbortController()
    let cause: 'abort' | 'stop' | 'timeout' | null = null

    const onCallerAbort = (): void => {
      cause ??= 'abort'
      controller.abort()
    }
    const stopThisAction = (): void => {
      cause ??= 'stop'
      controller.abort()
    }
    const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs
    const timer = setTimeout(() => {
      cause ??= 'timeout'
      controller.abort()
    }, timeoutMs)

    opts?.signal?.addEventListener('abort', onCallerAbort, { once: true })
    this.inFlightStop = stopThisAction

    /** The single mapping from "this run was aborted" to a failure reason. */
    const abortedResult = (): Result<T> =>
      cause === 'timeout'
        ? fail('timeout', `did not finish within ${timeoutMs}ms`)
        : fail('interrupted', cause === 'stop' ? 'stopped via stop()' : 'aborted mid-action')

    try {
      const result = await body(bot, controller.signal)
      if (controller.signal.aborted) return abortedResult()
      return result
    } catch (e) {
      if (controller.signal.aborted) return abortedResult()
      return fail('internal', e instanceof Error ? e.message : String(e))
    } finally {
      clearTimeout(timer)
      opts?.signal?.removeEventListener('abort', onCallerAbort)
      if (this.inFlightStop === stopThisAction) this.inFlightStop = null
    }
  }

  /**
   * Run a pathfinder goal under an AbortSignal, mapping the plugin's outcomes
   * onto the contract's failure reasons.
   *
   * VERIFIED 2026-09-07 by reading node_modules/mineflayer-pathfinder/lib/goto.js:
   * goto() rejects with an Error whose `.name` is one of 'NoPath', 'Timeout',
   * 'PathStopped' or 'GoalChanged'. That name is the only reliable
   * discriminator, and the NoPath/PathStopped split is what separates
   * 'unreachable' (pick a different target) from 'interrupted' (re-plan from
   * current state) for Track B's retry policy.
   */
  private async gotoGoal(
    bot: Bot,
    signal: AbortSignal,
    goal: PathfinderGoal,
    reached: () => boolean,
  ): Promise<Result> {
    const onAbort = (): void => {
      try {
        bot.pathfinder.stop()
        bot.pathfinder.setGoal(null)
      } catch {
        // disconnected mid-path
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await bot.pathfinder.goto(goal)
      // VERIFIED 2026-09-08, the hard way — a human watched the bot stand still
      // while this reported success. goto() resolves SUCCESSFULLY when the
      // computed path has zero length: lib/goto.js checks
      // `results.path.length === 0` BEFORE it checks `noPath` or `timeout`, and
      // a bot with no legal move produces exactly that. So a resolved promise
      // is not evidence of arrival, and `ok` here was a lie the planner had no
      // way to detect — it reported move_to OK from 8.6 blocks away, then
      // mine_block_at OK for an ore it never touched.
      //
      // Trust the world, not the library's resolve.
      if (!reached()) {
        return fail('unreachable', 'the pathfinder stopped short of the goal')
      }
      return ok(undefined)
    } catch (e) {
      // An aborted run is relabelled by runAction, so returning ok here is
      // safe and keeps the mapping in one place.
      if (signal.aborted) return ok(undefined)
      const name = e instanceof Error ? e.name : ''
      if (name === 'NoPath') return fail('unreachable', 'no path to the target')
      if (name === 'Timeout') {
        return fail('timeout', 'pathfinder could not compute a path in time')
      }
      if (name === 'PathStopped' || name === 'GoalChanged') {
        return fail('interrupted', 'path stopped before completion')
      }
      return fail('internal', e instanceof Error ? e.message : String(e))
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  async moveTo(target: Vec3, opts?: ActionOptions): Promise<Result> {
    // 60s rather than Phase 1's 30s: a measured 30-block path around a wall
    // took 6.1s, and Phase 4 will ask for much longer routes.
    return this.runAction(opts, 60_000, async (bot, signal) =>
      this.gotoGoal(
        bot,
        signal,
        new goals.GoalNear(target.x, target.y, target.z, 1),
        () => distanceFrom(bot, target) <= ARRIVAL_TOLERANCE,
      ),
    )
  }

  async followPlayer(_playerName: string, opts?: ActionOptions): Promise<Result> {
    return this.runAction(opts, 30_000, async () =>
      fail('internal', 'followPlayer arrives in Phase 5'),
    )
  }

  async mineBlock(
    target: string | Vec3,
    maxDistance: number,
    opts?: ActionOptions,
  ): Promise<Result<{ position: Vec3; collected: boolean }>> {
    return this.runAction(opts, 60_000, async (bot, signal) => {
      // --- Step 1: resolve the target to a concrete block ---
      const resolved = this.resolveMineTarget(bot, target, maxDistance)
      if (!resolved.ok) return resolved
      const block = resolved.value
      const position: Vec3 = {
        x: block.position.x,
        y: block.position.y,
        z: block.position.z,
      }

      // --- Step 2: harvest check BEFORE digging ---
      // Ordering is the whole point. Bare-handed or wrong-tooled, coal ore
      // takes 15 seconds to break and drops nothing (measured), so checking
      // afterwards would mean destroying the resource to discover we could
      // not have collected it.
      const items: ToolItem[] = bot.inventory
        .items()
        .map((i) => ({ name: i.name, type: i.type, slot: i.slot }))
      const held = bot.heldItem
        ? { name: bot.heldItem.name, type: bot.heldItem.type, slot: bot.heldItem.slot }
        : null

      if (!canHarvest(block, held)) {
        const better = bestHarvestTool(block, items)
        if (!better) {
          return fail(
            'missing_tool',
            `nothing in inventory can harvest ${block.name}; the block was left standing`,
          )
        }
        const toEquip = bot.inventory.items().find((i) => i.slot === better.slot)
        if (!toEquip) {
          return fail('internal', `tool in slot ${better.slot} vanished before equipping`)
        }
        await bot.equip(toEquip, 'hand')
      }

      if (bot.inventory.emptySlotCount() === 0) {
        return fail('inventory_full', 'no free inventory slot for the drop')
      }
      if (signal.aborted) return ok({ position, collected: false })

      // --- Step 3: approach, then dig ---
      const approach = await this.gotoGoal(
        bot,
        signal,
        new goals.GoalLookAtBlock(block.position, bot.world),
        () => distanceFrom(bot, position) <= DIG_REACH,
      )
      if (!approach.ok) return approach
      if (signal.aborted) return ok({ position, collected: false })

      // Re-read the block: the approach took time, and something else may have
      // broken it while we walked.
      const fresh = bot.blockAt(block.position)
      if (!fresh || fresh.name === 'air') {
        return fail(
          'not_found',
          `${block.name} at ${position.x},${position.y},${position.z} is gone`,
        )
      }
      await bot.dig(fresh)

      // --- Step 4: collect the drop ---
      const collected = await this.collectDrop(bot, signal, block.position)
      return ok({ position, collected })
    })
  }

  /**
   * Walk onto whatever the dig dropped and wait for it to reach the inventory.
   *
   * VERIFIED 2026-09-07: mining does not collect. After a successful dig the
   * coal sat as an item entity 1.72 blocks away and was still uncollected
   * three seconds later — Minecraft's pickup radius is roughly one block, so
   * waiting longer would not have helped. The bot has to go and get it.
   *
   * Best-effort by design, and never fails the action: the block WAS mined,
   * and reporting a failure would lose that. A drop that fell in lava or was
   * grabbed by a mob resolves `collected: false`, which is precisely the
   * distinction the contract's boolean exists to carry.
   */
  private async collectDrop(
    bot: Bot,
    signal: AbortSignal,
    origin: MineflayerVec3,
  ): Promise<boolean> {
    const countItems = (): number => bot.inventory.items().reduce((n, i) => n + i.count, 0)
    const before = countItems()
    const deadline = Date.now() + 8_000

    // Give the drop a moment to spawn and settle before looking for it.
    await new Promise((r) => setTimeout(r, 400))

    while (Date.now() < deadline && !signal.aborted) {
      if (countItems() > before) return true

      // Only drops near where we dug — anything further away is someone
      // else's litter, not this dig's product.
      const drop = Object.values(bot.entities)
        .filter((e) => e?.name === 'item' && e.position && e.position.distanceTo(origin) < 6)
        .map((e) => ({ entity: e, distance: e.position.distanceTo(bot.entity.position) }))
        .sort((a, b) => a.distance - b.distance)[0]

      if (!drop) {
        await new Promise((r) => setTimeout(r, 300))
        continue
      }

      // The drop can despawn, be collected, or be killed mid-path; none of
      // that is an error here, so fall through and re-check the inventory.
      await this.gotoGoal(
        bot,
        signal,
        new goals.GoalNear(
          Math.floor(drop.entity.position.x),
          Math.floor(drop.entity.position.y),
          Math.floor(drop.entity.position.z),
          0,
        ),
        // Collection is best-effort and its result is discarded: the loop below
        // re-checks the inventory, which is the only thing that actually
        // settles whether the drop was picked up. Failing to reach a drop that
        // has already despawned is normal, not an error worth reporting.
        () => true,
      )
      await new Promise((r) => setTimeout(r, 500))
    }

    return countItems() > before
  }

  /**
   * Resolve a mine target to a live block. A name searches for the nearest
   * match; a position names one block exactly — which is the point of
   * accepting a Vec3 at all, since a name re-search may pick a different
   * block than the planner reasoned about.
   */
  private resolveMineTarget(
    bot: Bot,
    target: string | Vec3,
    maxDistance: number,
  ): Result<MineflayerBlock> {
    if (typeof target === 'string') {
      if (!bot.registry.blocksByName[target]) {
        return fail('invalid_target', `unknown block name "${target}"`)
      }
      const nearest = this.findBlocks({ names: [target], maxDistance, limit: 1 })[0]
      if (!nearest) return fail('not_found', `no ${target} within ${maxDistance} blocks`)
      const block = bot.blockAt(
        this.toBlockPos(bot, nearest.position.x, nearest.position.y, nearest.position.z),
      )
      if (!block) return fail('not_found', `the ${target} found is no longer loaded`)
      return ok(block)
    }

    const origin = bot.entity.position
    const distance = Math.hypot(target.x - origin.x, target.y - origin.y, target.z - origin.z)
    if (distance > maxDistance) {
      return fail(
        'not_found',
        `target is ${distance.toFixed(1)} blocks away, beyond maxDistance ${maxDistance}`,
      )
    }
    const block = bot.blockAt(this.toBlockPos(bot, target.x, target.y, target.z))
    if (!block || block.name === 'air') {
      return fail('not_found', `no block at (${target.x}, ${target.y}, ${target.z})`)
    }
    return ok(block)
  }

  /**
   * Build a prismarine Vec3 without importing `vec3` directly. `vec3` is only
   * a transitive dependency of mineflayer, and this repository pins every
   * dependency it imports explicitly — cloning a Vec3 the bot already owns
   * gets the same instance type with no manifest change. `offset()` returns a
   * new vector, so the bot's own position is never mutated.
   */
  private toBlockPos(bot: Bot, x: number, y: number, z: number): MineflayerVec3 {
    return bot.entity.position.offset(0, 0, 0).set(x, y, z)
  }

  async placeBlock(_blockName: string, _position: Vec3, opts?: ActionOptions): Promise<Result> {
    return this.runAction(opts, 30_000, async () =>
      fail('internal', 'placeBlock arrives in Phase 5'),
    )
  }

  async attack(_entityId: number, opts?: ActionOptions): Promise<Result> {
    return this.runAction(opts, 30_000, async () => fail('internal', 'attack arrives in Phase 5'))
  }

  async flee(opts?: ActionOptions): Promise<Result> {
    return this.runAction(opts, 30_000, async () => fail('internal', 'flee arrives in Phase 5'))
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
    // Halt the pathfinder explicitly as well. Cancelling the action aborts its
    // signal, which gotoGoal reacts to — but stop() is the emergency brake, and
    // it must also stop a bot left walking by anything not currently tracked as
    // an in-flight action.
    try {
      this.bot?.pathfinder?.stop()
      this.bot?.pathfinder?.setGoal(null)
    } catch {
      // pathfinder not loaded, or disconnected
    }
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
        this.fabricModdedEntries = []
      }
    })
  }
}
