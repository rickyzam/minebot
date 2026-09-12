import mineflayer, { type Bot } from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import type { GoalPlaceBlockOptions, goals as PathfinderGoals } from 'mineflayer-pathfinder'
import {
  ok,
  fail,
  type ActionOptions,
  type BlockInfo,
  type BlockQuery,
  type BotEvents,
  type BotExecutor,
  type ExplorationReport,
  type ExploreOptions,
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
import {
  nextWaypoint,
  searchedRadius,
  DEFAULT_PERCEPTION_RADIUS,
  type SearchState,
} from './explore.js'
import { isPerceivable, observe, type PerceptionWorld } from './visibility.js'
import { placementOrder, type Schematic } from './schematic.js'

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
/** One of the entities Mineflayer tracks, derived for the same reason as above. */
type MineflayerEntity = NonNullable<Bot['entities'][number]>

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

/**
 * How far from the bot's eye a face may be and still be placed against, as
 * `GoalPlaceBlock` measures it: from the standing node's eye to the centre of
 * the reference block's face. 4.5 is vanilla survival's block interaction
 * range — the bot stands where a player could have placed from, rather than at
 * the edge of whatever the server might tolerate.
 */
const PLACE_REACH = 4.5

/**
 * How close the bot must be to an entity before a swing is believable, and how
 * close the approach asks to get.
 *
 * Vanilla's survival attack range is 3 blocks, and the server rejects an
 * interaction beyond 6 — so anything past 3 was never a swing a player could
 * have made, whatever the server would tolerate. The same reasoning as
 * `DIG_REACH`: the bot stands where a player could have struck from.
 *
 * The follow range is one block tighter than the reach, so arriving at the
 * goal leaves margin for a mob that is still moving when the swing goes out.
 *
 * NOTE the reach check is what makes ruling R9's `unreachable` honest, and it
 * is not redundant with the pathfinder: **the server does not check line of
 * sight for an attack**, only distance. A bot that could stand within 3 blocks
 * of a mob sealed behind a thin wall would land a swing through it. The
 * enclosure in `combat.int.test.ts` is three blocks thick for exactly that
 * reason.
 */
const ATTACK_REACH = 3
const ATTACK_FOLLOW_RANGE = 2

/** Blocks that count as an empty cell for `placeBlock`. Anything else occupies it. */
const EMPTY_BLOCKS: ReadonlySet<string> = new Set(['air', 'cave_air', 'void_air'])

/** The six neighbours of a cell, as offsets. */
const NEIGHBOUR_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
  [-1, 0, 0],
  [1, 0, 0],
]

/**
 * A* detour budget, in path cost. See the measurement table at the call site
 * in `openConnection`, and issue #15 for why it must not be left unbounded.
 */
const PATHFINDER_SEARCH_RADIUS = 128

/**
 * How close `followPlayer` keeps to its target, in blocks — `GoalFollow`'s
 * range. The pathfinder re-plans only once the target has moved further than
 * this from where the current path was aimed, and considers the bot there
 * once within it. Close enough to read as following; far enough that the bot
 * is not forever shuffling into the player's own block.
 */
const FOLLOW_RANGE = 2

/** Default wall-clock a single exploreFor call may spend. Design §3.2. */
const DEFAULT_EXPLORE_BUDGET_MS = 20_000

/**
 * How close the bot must get to a waypoint before its search counts.
 *
 * MEASURED, the hard way: this was originally the perception radius, on the
 * reasoning that arriving "close enough to see what the waypoint was meant to
 * see" was the honest bar. But waypoints are spaced one perception radius
 * apart, so a bot that had not moved at ALL was already within tolerance of
 * the next waypoint — the check passed vacuously, waypoints were marked
 * visited without being reached, and the search punched exactly the coverage
 * holes explore.test.ts exists to forbid. A human watching the benchmark spotted
 * it: the bot kept walking past the nearest target and reporting a further one.
 *
 * The tolerance must be small RELATIVE TO SPACING for arrival to mean
 * anything. `GoalNear(..., 2)` is satisfied within 2 blocks, so a genuine
 * arrival lands under ~3; this leaves margin for that without ever being
 * satisfiable from the previous waypoint.
 */
const WAYPOINT_ARRIVAL_TOLERANCE = 4

/**
 * Headroom between the search budget and runAction's own timeout.
 *
 * The action must outlast the search, or the timeout fires first and the
 * caller is told `timeout` instead of getting an honest report of how far the
 * search actually got — which is the whole point of a bounded search. Sized to
 * cover one in-flight walk to a waypoint (moveTo's own budget is 60s, but a
 * single 32-block leg measured ~6s) plus the pathfinder's 5s think time.
 */
const EXPLORE_TIMEOUT_HEADROOM_MS = 15_000

/**
 * The longest delay `setTimeout` honours: a signed 32-bit millisecond count.
 *
 * MEASURED 2026-09-11 in Node 24: any delay past this — `Infinity`, `NaN`, and
 * a perfectly finite `3e9` alike — is clamped to 1ms with only a
 * `TimeoutOverflowWarning`, and fired after 2ms. So "no timeout" must be
 * expressed by not arming a timer, and a very long timeout by clamping to this.
 */
const MAX_TIMER_MS = 2_147_483_647

/**
 * Per-block share of `buildSchematic`'s default timeout, so the default scales
 * with the structure instead of a fixed number that is absurd for one block and
 * far too tight for fifty.
 *
 * `placeBlock` already bounds each placement at 30s of its own, so a build can
 * never hang indefinitely on a single block — this only turns that per-block
 * bound into an honest whole-call one.
 *
 * The 15s above `placeBlock`'s 30s is **slack, not a budget for anything in
 * particular**. An earlier version of this comment justified it as covering
 * "the equip and the server's placement acknowledgement after the approach has
 * used its budget", which is not true: both of those happen INSIDE `placeBlock`
 * and are already inside its own 30s. The margin exists so a per-block timeout
 * fires at `placeBlock`'s boundary, where the failure names the block, rather
 * than at this outer one, where it would only name the build — and measured
 * cost is ~572ms/block, so the whole figure is ~80× typical either way.
 */
const BUILD_PER_BLOCK_BUDGET_MS = 45_000

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
   * The in-progress search, so a second exploreFor continues outward instead of
   * re-walking ground already covered. Keyed on the search itself — different
   * names or radius is a different search and starts fresh. Cleared on
   * disconnect, since the origin refers to a session the bot has left.
   */
  private exploreState: { key: string; origin: Vec3; visited: Vec3[] } | null = null
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
        // Movement does not dig: canDig false means the pathfinder never
        // tunnels. The only blocks this executor breaks are the ones mineBlock
        // was explicitly asked to break — a pathfinder allowed to dig would
        // quietly rewrite the terrain the integration tests depend on.
        //
        // But movement CAN BUILD, and this does not stop it. Movements defaults
        // scafoldingBlocks to [dirt, cobblestone] and allow1by1towers to true,
        // so a bot carrying either may pillar, bridge a gap, or place a step
        // while pathing, and leave those blocks behind. Only pillaring is gated
        // on allow1by1towers; bridging and stepping up (getMoveForward,
        // getMoveJumpUp) spend scaffolding regardless. MEASURED 2026-09-11 in
        // place.int.test.ts: told to place its only dirt on a ledge, the bot
        // pillared on that dirt and failed not_found. placeBlock guards its own
        // material (see there); towers built from other scaffolding are still
        // possible. Not switched off globally, because that changes which
        // targets every other action can reach.
        bot.loadPlugin(pathfinder)
        const movements = new Movements(bot)
        movements.canDig = false
        bot.pathfinder.setMovements(movements)
        // Issue #15. Left unbounded (-1), A* explores until it exhausts the
        // whole 5s thinkTimeout and reports `timeout` for a target that is
        // simply unreachable — telling the planner "retry" when the truth is
        // "pick a different target".
        //
        // This is a DETOUR budget, not a distance: maxCost = h(start) +
        // searchRadius (lib/astar.js), so it scales with how far the target is
        // and bounds only how much longer than the direct line a path may be.
        //
        // Measured against a full-width 5-block chasm, unreachable by
        // construction, with a reachable target as the control:
        //
        //   searchRadius | unreachable target   | reachable target
        //   -1 (default) | timeout      5.0s    | ok  0.5s
        //   32           | unreachable  0.0s    | ok  0.8s
        //   128          | unreachable  0.1s    | ok  0.8s
        //   512          | timeout      5.0s    | ok  0.5s
        //
        // Note the tension: too LARGE a budget degrades back to `timeout`,
        // because the bounded set grows too big to exhaust inside thinkTimeout.
        // 128 answers instantly while still allowing a path up to 128 cost
        // longer than the straight line. If Phase 4 finds a legitimate detour
        // being called unreachable, this is the number to raise — and the table
        // above is the trade-off to re-measure.
        //
        // `searchRadius` is set on the pathfinder at runtime (the plugin's own
        // index.js:41 initialises it to -1) but is declared only as a per-call
        // option in its .d.ts, never as a property — and `goto()` takes no
        // options object, so the property is the only way in. Cast narrowly to
        // reach it, as this class already does for `isCollidedHorizontally`.
        ;(bot.pathfinder as unknown as { searchRadius: number }).searchRadius =
          PATHFINDER_SEARCH_RADIUS
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
    // Before the early return: the search origin refers to a session the bot
    // has left, so it must not survive even a teardown that finds nothing to
    // tear down.
    this.exploreState = null
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

  /**
   * Adapt the live bot to the pure visibility rule in `visibility.ts`.
   *
   * The cast in `canSee` is safe in the direction it is used: the blocks that
   * reach it come from Mineflayer's own search and are real prismarine `Block`
   * instances; `BlockView` is only the structural subset the rule reads.
   */
  private perceptionWorld(bot: Bot): PerceptionWorld {
    return {
      blockAt: (p) => bot.blockAt(this.toBlockPos(bot, p.x, p.y, p.z), false),
      canSee: (block) => bot.canSeeBlock(block as Parameters<Bot['canSeeBlock']>[0]),
    }
  }

  findBlocks(query: BlockQuery): readonly BlockInfo[] {
    const bot = this.requireBot()
    if (query.names.length === 0) return []
    const names = new Set(query.names)
    const origin = bot.entity.position
    const world = this.perceptionWorld(bot)
    const seenAt = Date.now()
    const positions = bot.findBlocks({
      matching: (block) => block !== null && names.has(block.name),
      // Perception is limited to what the bot could see from where it stands.
      //
      // This MUST be `useExtraInfo` rather than a filter over the returned
      // array, and it must not move into `matching`. Both are load-bearing,
      // and both were established by reading Mineflayer's source rather than
      // guessed — see the line-of-sight spec §5.2:
      //
      //  - `useExtraInfo`, when a function, runs as `matcher(b) && extra(b)`
      //    (blocks.js:146-149), so only on blocks that already matched by
      //    type, and — crucially — INSIDE the search. `blocks.push` is gated
      //    on it (blocks.js:185) and the early break reads
      //    `blocks.length >= count` (blocks.js:193), so `count` counts
      //    VISIBLE blocks. Filtering the returned array instead would apply
      //    `limit` to buried candidates first and then discard them, reporting
      //    "no coal here" while a visible one sat just past the limit — a
      //    worse lie than the X-ray it replaces.
      //  - `matching` runs once per block in the volume, and is ALSO called on
      //    a synthetic positionless block to test each section's palette
      //    (blocks.js:130). A position-dependent test there is meaningless and
      //    would skip whole sections.
      useExtraInfo: (block) => isPerceivable(world, block),
      maxDistance: query.maxDistance,
      count: query.limit,
    })
    return Object.freeze(
      positions
        .slice(0, query.limit)
        .map((p) => {
          const block = bot.blockAt(p, false)
          // Provenance is produced here and dropped at the return, because the
          // contract's BlockInfo carries none yet. See visibility.observe().
          const seen = observe(
            block ?? { name: 'unknown', position: p, boundingBox: 'block' },
            origin,
            seenAt,
          )
          return Object.freeze({
            name: seen.name,
            position: Object.freeze({ x: p.x, y: p.y, z: p.z }),
            distance: seen.distance,
          })
        })
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
   *    (caller abort or stop()) or, for an elapsed `timeoutMs`, as whatever
   *    `onElapsed` decides — `timeout` by default. **A caller abort or `stop()`
   *    is never reported as success; an elapsed timeout CAN be**, because
   *    `followPlayer` passes `onElapsed: () => ok(undefined)` — "followed for
   *    the requested time" is a success, not a failure. See the `onElapsed`
   *    paragraph below; this bullet used to claim "never as success" flatly,
   *    which that action has contradicted since Task 3.
   *
   * It never throws: a body that rejects becomes `internal`, per the contract's
   * resolve-don't-throw rule.
   *
   * Exists because `moveTo` carried ~40 lines of this scaffolding that
   * `mineBlock`'s four cancellable steps would each have repeated, and every
   * repetition is a chance to get the resolve-never-throw rule subtly wrong.
   *
   * `defaultTimeoutMs: null` means the action has no timeout unless the caller
   * passes one, and a non-finite effective timeout (`Infinity`, `NaN`) means
   * none at all: the timer is simply not armed. It must never be expressed as
   * `setTimeout(fn, Infinity)`, which fires after ~1ms — see MAX_TIMER_MS.
   *
   * `onElapsed`, when given, replaces `fail('timeout')` as the result of the
   * timer firing. Only `followPlayer` passes it: for an action that runs until
   * stopped, running for the whole time it was asked to is success. Every other
   * action leaves it out, and a timer abort stays a `timeout` failure.
   */
  private async runAction<T>(
    opts: ActionOptions | undefined,
    defaultTimeoutMs: number | null,
    body: (bot: Bot, signal: AbortSignal) => Promise<Result<T>>,
    onElapsed?: () => Result<T>,
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
    const timer =
      timeoutMs === null || !Number.isFinite(timeoutMs)
        ? undefined
        : setTimeout(
            () => {
              cause ??= 'timeout'
              controller.abort()
            },
            // Clamped, not passed through: a finite delay past the 32-bit limit
            // overflows exactly as Infinity does. The clamp is ~24.8 days.
            Math.min(timeoutMs, MAX_TIMER_MS),
          )

    opts?.signal?.addEventListener('abort', onCallerAbort, { once: true })
    this.inFlightStop = stopThisAction

    /** The single mapping from "this run was aborted" to a failure reason. */
    const abortedResult = (): Result<T> =>
      cause === 'timeout'
        ? (onElapsed?.() ?? fail('timeout', `did not finish within ${timeoutMs}ms`))
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
   * Stop the pathfinder and drop the goal `ours` — but ONLY if the pathfinder
   * still holds it.
   *
   * Called wherever an action that set a goal finishes, however it finishes. A
   * goal left set outlives the call that set it, and `GoalFollow` — which both
   * `followPlayer` and `attack` use — is dynamic, so the bot keeps walking at
   * a target that has moved on long after the caller was told the action had
   * ended. Task 4 measured that failure for `placeBlock`.
   *
   * **The identity check is load-bearing, not defensive.** The pathfinder holds
   * ONE goal for the whole bot, and `ReflexExecutor` runs a reflex recovery
   * CONCURRENTLY with the action it preempted — by design (rulings R13, R20,
   * R21): `preempt()` launches `runRecovery` BEFORE it aborts the preempted
   * actions, and `runRecovery` yields only a single microtask. Meanwhile an
   * aborted `followPlayer` resolves synchronously from its abort listener, so
   * its `finally` lands exactly one microtask later — after the recovery has
   * already called `setGoal`, because `runAction`, `attack`'s body and
   * `gotoGoal` are synchronous all the way into `goto()`'s executor.
   *
   * Clearing unconditionally there destroyed the RECOVERY's goal: `setGoal`
   * emits `goal_updated` synchronously (index.js:142-146), `goto`'s
   * `goalChangedListener` rejects `GoalChanged` for any different goal, `null`
   * included (lib/goto.js:31-35), and that maps to
   * `interrupted`/'path stopped before completion'. Because the recovery's own
   * controller was never aborted, `runRecovery` counted it as a FAILURE, and
   * three in a row disarm every trigger of that kind — a bot that stops
   * defending itself while following a player. Found by the whole-branch review
   * of this phase, and deterministic rather than a race.
   *
   * So a stale clear is skipped: after `goal_reached` the plugin has already
   * nulled its own `stateGoal`, and if another action owns the goal it owns the
   * cleanup too. `stop()` is inside the same gate deliberately — it ends the
   * path in progress, which for someone else's goal means their `goto` rejects
   * `PathStopped`, the same defect by a different route.
   *
   * Swallowing the error is the point rather than a shortcut: the only way
   * these throw is a bot that has already disconnected, and every caller is on
   * a path where that is a normal outcome — the action is ending regardless,
   * and there is no pathfinder left to stop.
   *
   * `placeBlock` deliberately does NOT use this. Its cleanup is a superset —
   * it also restores the shared movements, and the goal must be cleared BEFORE
   * that restore, because `setMovements` resets the path and would re-arm
   * re-planning against a goal still in place. That ordering was Task 4's fix
   * and factoring it away would regress it. It applies the same identity gate
   * inline, next to the one its movements restore already had.
   */
  private clearPathfinderGoal(bot: Bot, ours: PathfinderGoal): void {
    try {
      if (bot.pathfinder.goal !== ours) return
      bot.pathfinder.stop()
      bot.pathfinder.setGoal(null)
    } catch {
      // Disconnected mid-action.
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
    const onAbort = (): void => this.clearPathfinderGoal(bot, goal)
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

  /**
   * Follow a player until aborted (signal or `stop()`), or until a passed
   * `timeoutMs` elapses — which resolves `ok`. No default timeout. Agreed
   * 2026-09-11, Phase 5 spec §7; see the contract's doc comment.
   *
   * Consequence recorded at Ricky's request: the planning loop dispatches with
   * a signal only (`loop.ts:143`), so a follow issued there does not return
   * until something aborts it. Bounding it is Track B's.
   *
   * Fails `not_found` when the named player has no entity this bot is tracking
   * at call start, or when that entity goes away mid-follow — the player logged
   * off, left range, or died. Ruling R5: executor behaviour, not yet in the
   * agreed contract. Without the mid-follow half the call would never return:
   * `GoalFollow.isValid()` only checks that it holds an entity reference, which
   * a departed player's stale entity still is, so the pathfinder carries on
   * chasing its last known position.
   */
  async followPlayer(playerName: string, opts?: ActionOptions): Promise<Result> {
    return this.runAction(
      opts,
      null,
      async (bot, signal) => {
        const entity = bot.players[playerName]?.entity
        if (!entity) {
          return fail('not_found', `no player named "${playerName}" is in sight`)
        }

        // Following, not arriving. `goto(new GoalFollow(...))` resolves as soon
        // as the bot is within range, which is arrival. A dynamic goal stays
        // set as the target moves, and this call settles only on an abort, the
        // target leaving, or the connection ending.
        // Held rather than inlined, so the cleanup below can prove the goal it
        // drops is still this call's own — see clearPathfinderGoal.
        const ours = new goals.GoalFollow(entity, FOLLOW_RANGE)
        bot.pathfinder.setGoal(ours, true)

        let detach = (): void => undefined
        try {
          return await new Promise<Result>((resolve) => {
            // An aborted run is relabelled by runAction — `interrupted`, or
            // `ok` for an elapsed timeoutMs — so ok here is safe.
            const onAbort = (): void => resolve(ok(undefined))
            const onEntityGone = (gone: typeof entity): void => {
              if (gone === entity) {
                resolve(fail('not_found', `${playerName} is no longer in sight`))
              }
            }
            const onPlayerLeft = (player: { username: string }): void => {
              if (player.username === playerName) {
                resolve(fail('not_found', `${playerName} left the game`))
              }
            }
            const onEnd = (): void => resolve(fail('disconnected', 'connection ended mid-follow'))

            signal.addEventListener('abort', onAbort, { once: true })
            bot.on('entityGone', onEntityGone)
            bot.on('playerLeft', onPlayerLeft)
            bot.once('end', onEnd)
            detach = () => {
              signal.removeEventListener('abort', onAbort)
              bot.removeListener('entityGone', onEntityGone)
              bot.removeListener('playerLeft', onPlayerLeft)
              bot.removeListener('end', onEnd)
            }
            // Checked after subscribing, so an abort in between is not missed.
            if (signal.aborted) onAbort()
          })
        } finally {
          detach()
          // Clear the goal whatever ended the call. Left set, the bot would keep
          // walking after the caller was told the action had ended. Gated on the
          // goal still being ours: when a reflex preempted this call, the
          // recovery's goal is already in place by the time this runs.
          this.clearPathfinderGoal(bot, ours)
        }
      },
      () => ok(undefined),
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

  /**
   * Place one `blockName` from the inventory at `position`. Agreed 2026-09-11,
   * Phase 5 spec §7; see the contract's doc comment for the failure table.
   *
   * Checks run cheapest and least invasive first, the order the mock uses:
   * inventory, then the target cell, then the approach. Nothing moves until
   * the call is known to be answerable.
   */
  async placeBlock(blockName: string, position: Vec3, opts?: ActionOptions): Promise<Result> {
    return this.runAction(opts, 30_000, async (bot, signal) => {
      // --- Step 1: the material ---
      if (!bot.inventory.items().some((i) => i.name === blockName)) {
        return fail('not_found', `no ${blockName} in the inventory`)
      }
      // Executor behaviour, not in the agreed table: an item that is not a
      // block (a stick) would otherwise walk into reach and then be refused by
      // the server as `internal`. `invalid_target` is what mineBlock and
      // exploreFor already answer for an unknown block name.
      if (!bot.registry.blocksByName[blockName]) {
        return fail('invalid_target', `"${blockName}" is not a placeable block`)
      }

      // --- Step 2: the target cell ---
      const target = this.toBlockPos(
        bot,
        Math.floor(position.x),
        Math.floor(position.y),
        Math.floor(position.z),
      )
      const where = `(${target.x}, ${target.y}, ${target.z})`
      const existing = bot.blockAt(target)
      if (!existing) return fail('unreachable', `${where} is not in a loaded chunk`)
      if (!EMPTY_BLOCKS.has(existing.name)) {
        return fail('invalid_target', `${where} is occupied by ${existing.name}`)
      }
      const supported = NEIGHBOUR_OFFSETS.some(
        ([dx, dy, dz]) => bot.blockAt(target.offset(dx, dy, dz))?.boundingBox === 'block',
      )
      if (!supported) {
        // Freestanding mid-air placement is out of scope (PR #22): build bottom-up.
        return fail('invalid_target', `nothing solid beside ${where} to place against`)
      }
      if (signal.aborted) return ok(undefined)

      // --- Step 3: approach ---
      // GoalPlaceBlock, not GoalNear (ruling R8). Its end condition is a
      // standing node whose eye has LINE OF SIGHT to a reference face within
      // PLACE_REACH, and it refuses any node whose feet or head would be in
      // the target cell — Minecraft will not place a block into a cell an
      // entity occupies, and the bot counts. GoalNear would happily park the
      // bot on the very cell it was asked to fill.
      //
      // The line-of-sight requirement is our honesty rule, not the server's.
      // MEASURED 2026-09-11: with LOS off, the bot placed into the empty centre
      // of a sealed stone box from outside it, and the server accepted it. LOS
      // keeps the bot from building through a wall it cannot see through, as
      // perception already refuses to look through one.
      //
      // The .d.ts marks `faces` and `facing` required; the implementation
      // (lib/goals.js:383) defaults both — every face, any facing — and that
      // default is what is wanted. Built fresh per call: the constructor
      // mutates its options object.
      const goal = new goals.GoalPlaceBlock(target, bot.world, {
        range: PLACE_REACH,
        LOS: true,
      } as unknown as GoalPlaceBlockOptions)
      // Runtime methods of the pinned 2.4.5 goal. `isEnd` is typed for the
      // pathfinder's own Move nodes and `getFaceAndRef` is not declared at
      // all; both only read x/y/z and Vec3 arithmetic off what they are given.
      const placeGoal = goal as unknown as {
        isEnd(node: MineflayerVec3): boolean
        getFaceAndRef(
          eye: MineflayerVec3,
        ): { face: MineflayerVec3; ref: MineflayerVec3 } | null
      }
      /**
       * The face to place against from where the bot stands now, or null.
       * Used for both the arrival check and the placement, so they never
       * disagree.
       *
       * The bot's own cell — plus the cell above only when it stands on a
       * partial block. That is the pathfinder's own rule for which node a
       * standing bot occupies (index.js:78-84: the floored position, offset by
       * one when the block there is solid, not full height, and the bot is on
       * the ground).
       *
       * Review round 1, Important 2 — MEASURED 2026-09-11. This used to try
       * the cell above unconditionally, copying the post-walk check at
       * index.js:590. On the floor right against a two-high ledge the bot's
       * own eye (y+1.62) is below the ledge top and cannot see the face beside
       * the target, but an eye one block higher can. A zero-length path then
       * passed as arrival, and the server — which does not check line of
       * sight — accepted a placement on a surface the bot could not see:
       * {"ok":true} where `unreachable` is right.
       */
      const faceFromHere = (): { face: MineflayerVec3; ref: MineflayerVec3 } | null => {
        const node = bot.entity.position.floored()
        const standingIn = bot.blockAt(node)
        const onPartialBlock =
          standingIn !== null &&
          standingIn.boundingBox === 'block' &&
          bot.entity.position.y - node.y > 0.001 &&
          bot.entity.onGround
        for (const n of onPartialBlock ? [node, node.offset(0, 1, 0)] : [node]) {
          if (placeGoal.isEnd(n)) return placeGoal.getFaceAndRef(n.offset(0.5, 1.6, 0.5))
        }
        return null
      }

      // The approach must not spend the material it is walking over to place.
      //
      // MEASURED 2026-09-11 (place.int.test.ts, the ledge tests): with one
      // dirt and the shared movements, the bot reached a ledge target by
      // pillaring on that dirt, then had nothing left to place — not_found for
      // a block the caller did have, and a pillar left behind. So for this
      // approach the pathfinder gets a copy of the shared movements whose
      // scafoldingBlocks leaves out the material.
      //
      // A shallow copy, not `new Movements(bot)`: a fresh instance would
      // silently drop every setting made on the shared one, including
      // canDig = false. And swapped only when the material IS scaffolding,
      // because setMovements resets any path in progress.
      const shared = bot.pathfinder.movements
      const materialId = bot.registry.itemsByName[blockName]?.id
      const spare = shared.scafoldingBlocks.filter((id) => id !== materialId)
      const guarded =
        spare.length === shared.scafoldingBlocks.length
          ? null
          : Object.assign(Object.create(Object.getPrototypeOf(shared)) as typeof shared, shared, {
              scafoldingBlocks: spare,
            })
      if (guarded) bot.pathfinder.setMovements(guarded)
      let approach: Result
      try {
        approach = await this.gotoGoal(bot, signal, goal, () => faceFromHere() !== null)
      } finally {
        try {
          // Clear the goal FIRST, whatever the outcome. Review round 1,
          // Important 1 — MEASURED 2026-09-11. A failed approach (NoPath, or a
          // zero-length path `reached()` rejects) leaves the goal set, and
          // setMovements runs resetPath, which re-arms re-planning
          // (`pathUpdated = false`, index.js:123-139). The pathfinder then
          // re-planned the same GoalPlaceBlock with the SHARED movements —
          // dirt allowed again — and pillared on the dirt within 8s of this
          // call returning `unreachable` with the dirt still held. On success
          // the same restart could move the bot while it equips and places.
          //
          // Gated on the goal still being ours, for the same reason the
          // movements restore below is: a reflex recovery preempting this call
          // has already set its own goal by the time this runs, and clearing it
          // makes the recovery report `interrupted` without having acted. See
          // clearPathfinderGoal for the full mechanism. The ORDER is unchanged —
          // goal first, movements second — which is what Task 4 measured.
          if (bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null)
          // Only if nothing replaced it meanwhile: restoring over someone
          // else's movements would be a second surprise, not a cleanup.
          if (guarded && bot.pathfinder.movements === guarded) bot.pathfinder.setMovements(shared)
        } catch {
          // disconnected mid-approach
        }
      }
      if (!approach.ok) return approach
      if (signal.aborted) return ok(undefined)

      // --- Step 4: equip and place ---
      const placement = faceFromHere()
      if (!placement) return fail('unreachable', `lost sight of a face beside ${where}`)
      const reference = bot.blockAt(placement.ref)
      if (!reference) return fail('unreachable', `the block beside ${where} is not loaded`)
      // Looked up again rather than reused: the approach took time, and the
      // equip needs the item as it is now.
      const item = bot.inventory.items().find((i) => i.name === blockName)
      if (!item) return fail('not_found', `no ${blockName} left in the inventory after the approach`)
      await bot.equip(item, 'hand')
      if (signal.aborted) return ok(undefined)

      // `face` points from the target to the reference block; Mineflayer wants
      // the vector from the reference to the cell being filled.
      //
      // Verified against the server, not the bot's own view: in mineflayer
      // 4.39 placeBlock (lib/plugins/place_block.js) sends the packet and then
      // waits for the SERVER's block update at the destination, rejecting with
      // "Server refused to place …" if the type did not change. It does not
      // write the block into the local world model first, unlike bot.dig().
      await bot.placeBlock(reference, placement.face.scaled(-1))
      return ok(undefined)
    })
  }

  /**
   * Build `s` with its origin at `origin`: one `placeBlock` per block, in
   * `placementOrder` — ascending `dy`, so every block already has something
   * beneath it to place against by the time its turn comes. That ordering is
   * not a nicety: `placeBlock` refuses a cell with no adjacent solid block, so
   * a top-down build fails `invalid_target` on its very first block.
   *
   * Executor-only, and deliberately NOT on `BotExecutor`. Adding it there is a
   * change to the shared surface Track B builds against, and the planning loop
   * does not need it yet.
   *
   * Stops at the first failure and reports that failure's own reason, with a
   * detail naming the offending block, its absolute position, and how many
   * blocks were already placed. A bare reason would leave the caller unable to
   * tell a build that died on block 1 from one that died on block 8 — the first
   * is "this plan was wrong", the second "something interfered halfway", and
   * they call for different recoveries. The count is in the detail because a
   * failed `Result` carries no value.
   *
   * Verification is `placeBlock`'s, not re-implemented here: it already checks
   * the cell, and confirms the placement against the SERVER's block update
   * rather than the bot's own world model.
   */
  async buildSchematic(
    s: Schematic,
    origin: Vec3,
    opts?: ActionOptions,
  ): Promise<Result<{ placed: number }>> {
    const order = placementOrder(s)
    return this.runAction(
      opts,
      // Scaled, not fixed — see BUILD_PER_BLOCK_BUDGET_MS.
      //
      // The empty schematic is `null` ("no timeout"), not the 0 the
      // multiplication would give. runAction treats only `null` and a
      // non-finite delay as "no timeout", so 0 arms a real `setTimeout(fn, 0)`
      // — which this body survives only because an empty loop has no `await`
      // and so settles on the microtask queue before any macrotask can run.
      // That is correct by accident; say what is meant instead.
      order.length === 0 ? null : order.length * BUILD_PER_BLOCK_BUDGET_MS,
      async (_bot, signal) => {
        let placed = 0
        for (const block of order) {
          // Between blocks, so a long build is cancellable even while no single
          // placement is in flight. Returning ok with the honest count is safe:
          // runAction relabels an aborted run as `interrupted` (caller abort or
          // stop()) or `timeout`, and keeping that mapping in one place is the
          // whole reason runAction exists.
          if (signal.aborted) return ok({ placed })

          const at: Vec3 = {
            x: origin.x + block.dx,
            y: origin.y + block.dy,
            z: origin.z + block.dz,
          }
          // Our signal is passed down, so an abort settles the placement in
          // flight too rather than waiting for it to walk and place first.
          //
          // This nests a runAction inside a runAction, the first place in this
          // class that does. It buys each placement its own 30s bound and its
          // own goal/movements cleanup. It costs `stop()` coverage BETWEEN
          // blocks: placeBlock's runAction overwrites `inFlightStop` and clears
          // it on the way out, so a stop() landing between two placements halts
          // the pathfinder but does not abort this loop — the next placeBlock
          // then re-registers and a stop() during it works normally. Nothing
          // calls stop() on a build today (this is not a contract action, so
          // the reflex layer never dispatches it); if that changes, this loop
          // needs its own stop registration rather than borrowing placeBlock's.
          const result = await this.placeBlock(block.block, at, { signal })
          if (!result.ok) {
            // An aborted run's failure is the abort, not the block — let
            // runAction label it rather than blaming whatever placeBlock said.
            if (signal.aborted) return ok({ placed })
            return fail(
              result.reason,
              `${s.name}: ${block.block} at (${at.x}, ${at.y}, ${at.z}) failed after ` +
                `${placed} of ${order.length} placed — ${result.detail}`,
            )
          }
          placed += 1
        }
        return ok({ placed })
      },
    )
  }

  /**
   * Swing once at an entity, then resolve `ok`. Agreed 2026-09-11, Phase 5
   * spec §7; see the contract's doc comment. `ok` says the swing happened, not
   * that the entity died — call again to keep attacking.
   *
   * The default timeout is **10s, not the 30s the stub carried**. This is what
   * the reflex layer dispatches as its recovery when a hostile closes
   * (`ReflexExecutor`, whose own `recoveryTimeoutMs` default is the same 10s),
   * and a reflex that can run for thirty seconds is not a reflex — it is an
   * action the planner cannot get out of.
   *
   * Fails:
   * - `not_found` — no entity with that id, at call time or by the time the
   *   approach finishes. Agreed; it died, despawned, or left the loaded world.
   * - `unreachable` — the bot cannot get within reach of it. **Ruling R9,
   *   executor behaviour only**, mirroring `placeBlock`'s agreed row; it is
   *   deliberately NOT in the contract's doc comment, which is shared surface
   *   and not yet agreed with Track B.
   *
   * `GoalFollow`, not `GoalNear`: the target is a mob with its own AI, so it
   * moves while the bot walks at it, and a fixed point would be stale before
   * the bot arrived. This is the case spec §3 asks about.
   */
  async attack(entityId: number, opts?: ActionOptions): Promise<Result> {
    return this.runAction(opts, 10_000, async (bot, signal) => {
      /** The entity as Mineflayer tracks it now, or null once it is gone. */
      const live = (): MineflayerEntity | null => {
        const e = bot.entities[entityId]
        // Both halves matter: on `entity_destroy` Mineflayer sets `isValid`
        // false and then deletes the entry, so a caller holding an id can be
        // looking at either state depending on when it asks.
        return e === undefined || e.isValid === false ? null : e
      }

      const target = live()
      if (!target) return fail('not_found', `no entity ${entityId} is in sight`)

      // Held rather than inlined, so the cleanup below can prove the goal it
      // drops is still this call's own — see clearPathfinderGoal.
      const ours = new goals.GoalFollow(target, ATTACK_FOLLOW_RANGE)
      let approach: Result
      try {
        approach = await this.gotoGoal(bot, signal, ours, () => {
          const now = live()
          return now !== null && distanceFrom(bot, now.position) <= ATTACK_REACH
        })
      } finally {
        // Whatever the outcome, and BEFORE returning — see clearPathfinderGoal.
        // Gated: a flee recovery superseding this attack (ruling R22) has its own
        // goal set by the time this runs, and dropping it would report the flee
        // as interrupted without it ever having fled.
        this.clearPathfinderGoal(bot, ours)
      }
      if (!approach.ok) return approach
      if (signal.aborted) return ok(undefined)

      // Re-read rather than reusing `target`: the approach took time, and the
      // mob may have died to something else — its own fall, another mob, a
      // player — while the bot walked at it.
      const now = live()
      if (!now) return fail('not_found', `entity ${entityId} was gone before the swing`)
      const reach = distanceFrom(bot, now.position)
      if (reach > ATTACK_REACH) {
        return fail('unreachable', `entity ${entityId} is ${reach.toFixed(1)} blocks away`)
      }

      // Face it before swinging. Not required by the server, which checks only
      // distance — which is precisely why it is here: a swing that lands while
      // the bot faces the other way is not something a player could have done.
      await bot.lookAt(now.position.offset(0, now.height / 2, 0), true)
      if (signal.aborted) return ok(undefined)
      bot.attack(now)
      return ok(undefined)
    })
  }

  async flee(opts?: ActionOptions): Promise<Result<{ fled: boolean }>> {
    return this.runAction(opts, 30_000, async () => fail('internal', 'flee arrives in Phase 5'))
  }

  /**
   * Walk an expanding spiral of waypoints, looking around at each. Design §4.3.
   *
   * A `runAction` body, so cancellation, timeout and the resolve-never-throw
   * rule come for free — and so an abort is relabelled `interrupted` by
   * runAction regardless of what this returns.
   */
  async exploreFor(
    names: readonly string[],
    maxDistance: number,
    opts?: ExploreOptions,
  ): Promise<Result<ExplorationReport>> {
    const budgetMs = opts?.budgetMs ?? DEFAULT_EXPLORE_BUDGET_MS
    return this.runAction(
      opts,
      budgetMs + EXPLORE_TIMEOUT_HEADROOM_MS,
      async (bot, signal) => {
        // Checked before moving, so a typo costs nothing. findBlocks would
        // simply return [] for an unknown name, which reads as "looked, found
        // nothing" — the one answer that must not be given for a name that
        // could never have matched anything.
        for (const name of names) {
          if (!bot.registry.blocksByName[name]) {
            return fail('invalid_target', `unknown block name "${name}"`)
          }
        }

        const key = `${[...names].sort().join(',')}|${maxDistance}`
        const here: Vec3 = {
          x: Math.round(bot.entity.position.x),
          y: Math.round(bot.entity.position.y),
          z: Math.round(bot.entity.position.z),
        }
        if (this.exploreState?.key !== key) {
          this.exploreState = { key, origin: here, visited: [] }
        }
        const search = this.exploreState

        const state = (): SearchState => ({
          origin: search.origin,
          visited: search.visited,
          maxDistance,
          spacing: DEFAULT_PERCEPTION_RADIUS,
        })

        const deadline = Date.now() + budgetMs
        let travelled = 0

        const report = (
          found: readonly BlockInfo[],
          exhausted: boolean,
        ): Result<ExplorationReport> =>
          ok({ found, exhausted, searchedTo: searchedRadius(state()), travelled })

        for (;;) {
          if (signal.aborted) return report([], false)
          if (Date.now() >= deadline) return report([], false)

          const waypoint = nextWaypoint(state())
          if (waypoint === null) return report([], true)

          const before = bot.entity.position.clone()
          const arrival = await this.gotoGoal(
            bot,
            signal,
            // XZ, not GoalNear. The spiral is horizontal, so a waypoint carries
            // the ORIGIN's elevation — which on real terrain is usually not the
            // elevation of the ground there. GoalNear(x, origin.y, z, 2) then
            // asks the bot to stand within 2 blocks of a point hanging in the
            // air (or buried), which is unreachable, so the waypoint was
            // skipped. Over the benchmark region's 19-block height range that
            // silently discarded most of the search: the bot walked past the
            // nearest target and reported a further one it happened to see.
            new goals.GoalNearXZ(waypoint.x, waypoint.z, 2),
            // Horizontal for the same reason, and small relative to the
            // waypoint spacing — see WAYPOINT_ARRIVAL_TOLERANCE.
            () =>
              Math.hypot(bot.entity.position.x - waypoint.x, bot.entity.position.z - waypoint.z) <=
              WAYPOINT_ARRIVAL_TOLERANCE,
          )
          travelled += bot.entity.position.distanceTo(before)

          // A waypoint we cannot reach is a fact about terrain, not a failed
          // search: mark it seen and carry on. Anything else — disconnected,
          // internal — is real and ends the call.
          search.visited.push(waypoint)
          if (
            !arrival.ok &&
            arrival.reason !== 'unreachable' &&
            arrival.reason !== 'timeout'
          ) {
            return arrival
          }
          if (signal.aborted) return report([], false)

          const found = this.findBlocks({
            names: [...names],
            maxDistance: DEFAULT_PERCEPTION_RADIUS,
            limit: 8,
          })
          if (found.length > 0) return report(found, false)
        }
      },
    )
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
        // An unexpected drop never reaches teardown(), so clear the search
        // here too or a reconnect would resume a spiral around coordinates
        // from the previous session.
        this.exploreState = null
      }
    })
  }
}
