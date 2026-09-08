import {
  ok,
  fail,
  type ActionOptions,
  type BlockInfo,
  type BlockQuery,
  type BotEvents,
  type BotExecutor,
  type EntityInfo,
  type ExplorationReport,
  type ExploreOptions,
  type FailureReason,
  type ItemStack,
  type Result,
  type Unsubscribe,
  type Vec3,
  type WorldSnapshot,
} from '@minebot/contract'

const describeVec = (v: Vec3): string => `(${v.x}, ${v.y}, ${v.z})`

export type MockActionName =
  | 'moveTo'
  | 'followPlayer'
  | 'mineBlock'
  | 'placeBlock'
  | 'attack'
  | 'flee'
  | 'exploreFor'

/**
 * How far the mock pretends perception reaches from a waypoint, and therefore
 * how far outward one `exploreFor` call advances. Mirrors the real executor's
 * DEFAULT_PERCEPTION_RADIUS — deliberately duplicated rather than imported,
 * because `@minebot/mock-executor` must not depend on `@minebot/executor`.
 */
const MOCK_PERCEPTION_RADIUS = 32

export interface InjectedFailure {
  reason: FailureReason
  detail?: string
}

export interface MockOptions {
  position?: Vec3
  health?: number
  food?: number
  inventory?: ItemStack[]
  entities?: EntityInfo[]
  blocks?: BlockInfo[]
  /** Simulated duration of each action, so cancellation can be exercised. */
  actionDelayMs?: number
  /**
   * Wall-clock a single `exploreFor` call should appear to take. Default 0.
   * Separate from `actionDelayMs` because exploration is slow by nature and
   * Track B needs a slow search without every other action becoming slow too.
   */
  exploreDelayMs?: number
  /**
   * Force an action to fail with a chosen reason. Exists because the mock can
   * otherwise only produce 3 of 9 FailureReason values, leaving Track B unable
   * to test the retry policy the contract's closed reason set exists for.
   */
  failures?: Partial<Record<MockActionName, InjectedFailure>>
}

export interface RecordedCall {
  name: string
  args: unknown[]
}

type Handler = (payload: never) => void

export class MockExecutor implements BotExecutor {
  readonly calls: RecordedCall[] = []

  private connected = false
  private position: Vec3
  private health: number
  private food: number
  private inventory: ItemStack[]
  private entities: EntityInfo[]
  private blocks: BlockInfo[]
  private readonly delayMs: number
  private readonly exploreDelayMs: number
  /**
   * The in-progress search. `searchedTo` is the radius the NEXT call will
   * stand at, which is 0 for a fresh search because the first waypoint is the
   * origin the bot is already on — the same shape the real executor reports.
   * Keyed on the search itself: different names or radius is a different
   * search and starts from zero.
   */
  private exploreSearch: { key: string; searchedTo: number } | null = null
  private readonly handlers = new Map<string, Set<Handler>>()
  /**
   * Settles the currently in-flight simulated action as `interrupted`, if
   * one is running. Mirrors MineflayerExecutor's `stop()`/in-flight-action
   * behaviour so the contract suite's stop() assertions hold identically
   * against both implementations.
   */
  private inFlightStop: (() => void) | null = null
  private readonly failures = new Map<MockActionName, InjectedFailure>()
  private pendingConnect: Promise<Result> | null = null
  private disconnectRequested = false

  constructor(opts: MockOptions = {}) {
    this.position = opts.position ?? { x: 0, y: 64, z: 0 }
    this.health = opts.health ?? 20
    this.food = opts.food ?? 20
    this.inventory = opts.inventory ?? []
    this.entities = opts.entities ?? []
    this.blocks = opts.blocks ?? []
    this.delayMs = opts.actionDelayMs ?? 0
    this.exploreDelayMs = opts.exploreDelayMs ?? 0
    for (const [action, failure] of Object.entries(opts.failures ?? {})) {
      if (failure) this.failures.set(action as MockActionName, failure)
    }
  }

  async connect(): Promise<Result> {
    this.record('connect')
    if (this.connected) return ok(undefined)
    if (this.pendingConnect) return this.pendingConnect

    this.disconnectRequested = false
    this.pendingConnect = (async (): Promise<Result> => {
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs))
      if (this.disconnectRequested) return fail('interrupted', 'disconnect() during connect()')
      this.connected = true
      this.emit('spawned', {})
      return ok(undefined)
    })()

    try {
      return await this.pendingConnect
    } finally {
      this.pendingConnect = null
    }
  }

  async disconnect(): Promise<void> {
    this.record('disconnect')
    this.disconnectRequested = true
    const pending = this.pendingConnect
    if (pending) await pending.catch(() => undefined)
    this.connected = false
  }

  getState(): WorldSnapshot {
    if (!this.connected) throw new Error('MockExecutor.getState() called while disconnected')
    const self = Object.freeze({
      position: Object.freeze({ ...this.position }),
      health: this.health,
      food: this.food,
      dimension: 'overworld',
      onGround: true,
      inventory: Object.freeze(this.inventory.map((i) => Object.freeze({ ...i }))),
      heldItem: this.inventory[0] ? Object.freeze({ ...this.inventory[0] }) : null,
    })
    return Object.freeze({
      takenAt: Date.now(),
      self,
      nearbyEntities: Object.freeze(this.entities.map((e) => Object.freeze({ ...e }))),
    })
  }

  findBlocks(query: BlockQuery): readonly BlockInfo[] {
    // Agrees with MineflayerExecutor: throws (never returns `[]`) when
    // disconnected, for the same reason getState() throws — see the
    // contract's findBlocks doc comment.
    if (!this.connected) throw new Error('MockExecutor.findBlocks() called while disconnected')
    const names = new Set(query.names)
    return Object.freeze(
      this.blocks
        .filter((b) => names.has(b.name) && b.distance <= query.maxDistance)
        // Nearest-first, matching the real executor (which inherits Mineflayer's
        // nearest-first search order) — see BlockQuery/BlockInfo in the contract.
        .sort((a, b) => a.distance - b.distance)
        .slice(0, query.limit)
        .map((b) => Object.freeze({ ...b })),
    )
  }

  on<K extends keyof BotEvents>(
    event: K,
    handler: (payload: BotEvents[K]) => void,
  ): Unsubscribe {
    // Design spec §9.1: the executor owns a long-lived handler registry, so a
    // subscription taken before connect() — or held across a reconnect — keeps
    // working. Registering while disconnected is legal and is NOT a no-op.
    const set = this.handlers.get(event) ?? new Set<Handler>()
    set.add(handler as Handler)
    this.handlers.set(event, set)
    return () => {
      set.delete(handler as Handler)
    }
  }

  /** Test helper: drive the event stream by hand. */
  emit<K extends keyof BotEvents>(event: K, payload: BotEvents[K]): void {
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

  async moveTo(target: Vec3, opts?: ActionOptions): Promise<Result> {
    this.record('moveTo', target)
    const r = await this.simulate('moveTo', opts)
    if (!r.ok) return r
    this.position = { ...target }
    return ok(undefined)
  }

  async followPlayer(playerName: string, opts?: ActionOptions): Promise<Result> {
    this.record('followPlayer', playerName)
    return this.simulate('followPlayer', opts)
  }

  async mineBlock(
    target: string | Vec3,
    maxDistance: number,
    opts?: ActionOptions,
  ): Promise<Result<{ position: Vec3; collected: boolean }>> {
    this.record('mineBlock', target, maxDistance)
    const r = await this.simulate('mineBlock', opts)
    if (!r.ok) return r

    const match =
      typeof target === 'string'
        ? this.blocks.find((b) => b.name === target && b.distance <= maxDistance)
        : this.blocks.find(
            (b) =>
              b.position.x === target.x &&
              b.position.y === target.y &&
              b.position.z === target.z &&
              b.distance <= maxDistance,
          )

    if (!match) {
      const what = typeof target === 'string' ? target : `block at ${describeVec(target)}`
      return fail('not_found', `no ${what} within ${maxDistance} blocks`)
    }

    this.blocks = this.blocks.filter((b) => b !== match)
    this.inventory = [
      ...this.inventory,
      { name: match.name, count: 1, slot: this.inventory.length },
    ]
    return ok({ position: match.position, collected: true })
  }

  async placeBlock(blockName: string, position: Vec3, opts?: ActionOptions): Promise<Result> {
    this.record('placeBlock', blockName, position)
    return this.simulate('placeBlock', opts)
  }

  async attack(entityId: number, opts?: ActionOptions): Promise<Result> {
    this.record('attack', entityId)
    const r = await this.simulate('attack', opts)
    if (!r.ok) return r
    if (!this.entities.some((e) => e.id === entityId)) {
      return fail('not_found', `no entity ${entityId}`)
    }
    return ok(undefined)
  }

  async flee(opts?: ActionOptions): Promise<Result> {
    this.record('flee')
    return this.simulate('flee', opts)
  }

  /**
   * Walk outward one perception-radius step per call, reporting what came into
   * view. Incremental rather than one-shot on purpose: design §3.4 requires
   * resumability to be testable *without a server*, and a mock that searched
   * everything in a single call would make `searchedTo` and the resume path
   * unobservable — a second call would re-report the first call's ground.
   */
  async exploreFor(
    names: readonly string[],
    maxDistance: number,
    opts?: ExploreOptions,
  ): Promise<Result<ExplorationReport>> {
    this.record('exploreFor', names, maxDistance)
    const r = await this.simulate('exploreFor', opts)
    if (!r.ok) return r

    // Resumability is keyed on the search, not the caller: a different target
    // or radius is a different search and starts from zero.
    const key = `${[...names].sort().join(',')}|${maxDistance}`
    if (this.exploreSearch?.key !== key) this.exploreSearch = { key, searchedTo: 0 }
    const search = this.exploreSearch

    if (this.exploreDelayMs > 0) {
      const delayed = await this.wait(this.exploreDelayMs, opts)
      if (!delayed.ok) return delayed
    }

    // Where this call stands, and how far it can see from there.
    const at = search.searchedTo
    const covered = at + MOCK_PERCEPTION_RADIUS
    const wanted = new Set(names)
    const found = this.blocks
      .filter((b) => wanted.has(b.name) && b.distance <= covered)
      .sort((a, b) => a.distance - b.distance)
      .map((b) => Object.freeze({ name: b.name, position: b.position, distance: b.distance }))

    // Nowhere further to look: perception from here already reaches the edge.
    const exhausted = found.length === 0 && covered >= maxDistance
    // Advance only when this call neither found anything nor ran out of ground,
    // so `exhausted` stays sticky and a fruitful call does not skip past its
    // own waypoint.
    if (found.length === 0 && !exhausted) search.searchedTo = covered

    return ok({
      found: Object.freeze(found),
      exhausted,
      searchedTo: at,
      // The step taken to reach this call's waypoint. A fresh search starts on
      // the origin, so its first call costs nothing.
      travelled: at === 0 ? 0 : MOCK_PERCEPTION_RADIUS,
    })
  }

  chat(message: string): void {
    this.record('chat', message)
  }

  stop(): void {
    this.record('stop')
    const cancel = this.inFlightStop
    this.inFlightStop = null
    cancel?.()
  }

  /**
   * Change (or clear, with `null`) an injected failure on a live mock, so a
   * fail-then-succeed retry sequence can be driven without building a second
   * executor.
   */
  setFailure(action: MockActionName, failure: InjectedFailure | null): void {
    if (failure) this.failures.set(action, failure)
    else this.failures.delete(action)
  }

  private record(name: string, ...args: unknown[]): void {
    this.calls.push({ name, args })
  }

  /**
   * Honour the contract's cancellation rule: resolve interrupted, never
   * throw. Also the single choke point all six actions share, so the
   * `disconnected` check lives here once rather than duplicated across
   * moveTo/followPlayer/mineBlock/placeBlock/attack/flee — order matches
   * MineflayerExecutor's per-action checks: already-aborted first, then
   * disconnected.
   */
  private simulate(action: MockActionName, opts?: ActionOptions): Promise<Result> {
    // Contract rule first: an already-aborted signal resolves `interrupted`
    // whatever is injected. Injection must not be able to fake a violation.
    if (opts?.signal?.aborted) return Promise.resolve(fail('interrupted', 'aborted before start'))
    if (!this.connected) return Promise.resolve(fail('disconnected', 'not connected'))
    const injected = this.failures.get(action)
    if (injected) return Promise.resolve(fail(injected.reason, injected.detail ?? `injected ${injected.reason}`))
    if (this.delayMs === 0) return Promise.resolve(ok(undefined))
    return this.wait(this.delayMs, opts)
  }

  /**
   * Sleep for `ms`, but stay cancellable while doing it — by `signal` and by
   * `stop()`, exactly as a real in-flight action would be. A delay that
   * ignored both would turn every mid-action cancellation test into a wait
   * for the full duration.
   */
  private wait(ms: number, opts?: ActionOptions): Promise<Result> {
    // Re-check rather than trusting the caller's earlier check: exploreFor
    // awaits simulate() before getting here, and a signal aborted during that
    // await would otherwise be seen only by an 'abort' listener that can never
    // fire again — the wait would run to completion and report success.
    if (opts?.signal?.aborted) return Promise.resolve(fail('interrupted', 'aborted mid-action'))
    return new Promise<Result>((resolve) => {
      let settled = false
      const signal = opts?.signal
      const finish = (result: Result): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (this.inFlightStop === stopThisAction) this.inFlightStop = null
        resolve(result)
      }
      const onAbort = (): void => finish(fail('interrupted', 'aborted mid-action'))
      const stopThisAction = (): void => finish(fail('interrupted', 'stopped via stop()'))
      this.inFlightStop = stopThisAction
      const timer = setTimeout(() => finish(ok(undefined)), ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}
