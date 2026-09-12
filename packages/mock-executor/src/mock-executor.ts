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

/**
 * A block seeded into the mock's world, optionally hidden from perception.
 *
 * `findBlocks` returns only what the bot could see from where it stands, and
 * the real executor derives that from world geometry with a raycast. The mock
 * has no geometry, so visibility cannot be derived and has to be declared.
 *
 * Defaults to `true`, which is why this is additive: every existing seeding of
 * plain `BlockInfo` keeps behaving exactly as before. Seed `visible: false` to
 * exercise the buried case — a block that exists, is close, and must never be
 * reported.
 */
export interface SeededBlock extends BlockInfo {
  readonly visible?: boolean
}

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
  /**
   * Blocks in the mock's world. Plain {@link BlockInfo} entries are visible;
   * see {@link SeededBlock} to seed one that exists but cannot be seen.
   */
  blocks?: readonly SeededBlock[]
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
  private blocks: readonly SeededBlock[]
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
        // Perception is limited to what the bot could see from where it
        // stands. The real executor derives this from geometry; the mock has
        // none, so it is declared per block (see SeededBlock).
        //
        // The filter runs BEFORE `slice(query.limit)`, matching the real
        // executor, where the visibility test runs inside Mineflayer's search
        // and `count` therefore counts visible blocks. Filtering after the
        // slice would let buried blocks consume the limit and report "none"
        // while a visible one sat just past it.
        .filter((b) => b.visible !== false)
        .filter((b) => names.has(b.name) && b.distance <= query.maxDistance)
        // Nearest-first, matching the real executor (which inherits Mineflayer's
        // nearest-first search order) — see BlockQuery/BlockInfo in the contract.
        .sort((a, b) => a.distance - b.distance)
        .slice(0, query.limit)
        // Explicit fields rather than a spread: `visible` is mock-side seeding
        // and must never leak into a contract BlockInfo.
        .map((b) => Object.freeze({ name: b.name, position: b.position, distance: b.distance })),
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

  /**
   * Follows until aborted. `timeoutMs` is honoured when passed, with no
   * default, and elapsing resolves `ok` — it followed as asked. Agreed
   * 2026-09-11, Phase 5 spec §7. The mock has no players, so any name follows.
   */
  async followPlayer(playerName: string, opts?: ActionOptions): Promise<Result> {
    this.record('followPlayer', playerName)
    const r = await this.simulate('followPlayer', opts)
    if (!r.ok) return r
    // Non-finite means "never elapses", and must not reach wait(): see
    // untilAborted() for what setTimeout does with Infinity.
    const timeoutMs = opts?.timeoutMs
    if (timeoutMs !== undefined && Number.isFinite(timeoutMs)) return this.wait(timeoutMs, opts)
    return this.untilAborted(opts)
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
        ? // By NAME the executor searches, so it can only reach what it can
          // see — MineflayerExecutor.mineBlock() resolves a name through its
          // own findBlocks(). By POSITION it does not: an explicit coordinate
          // came from somewhere the caller already knows about, and the real
          // executor digs at it without re-perceiving. Keeping that asymmetry
          // is what makes the two implementations agree.
          this.blocks.find(
            (b) => b.visible !== false && b.name === target && b.distance <= maxDistance,
          )
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

  /**
   * Inventory-aware, agreed 2026-09-11 (Phase 5 spec §7). The mock has no
   * geometry, so of the real failures it can produce `not_found` and the
   * occupied half of `invalid_target`; "no adjacent face" and `unreachable`
   * are reachable through failure injection.
   *
   * **One divergence this enumeration used to omit, which is worse than saying
   * nothing:** the real executor rejects a NON-BLOCK item up front —
   * `placeBlock('stick', …)` returns `invalid_target`, because
   * `bot.registry.blocksByName` has no entry for it (executor ruling R24). The
   * mock has no notion of placeability, so the same call resolves **`ok`**,
   * spends the stick, and pushes a stick *block* into `this.blocks` — after
   * which `findBlocks({ names: ['stick'] })` reports a stick standing in the
   * world. Anything built against the mock alone can therefore depend on a
   * success the real executor never gives.
   *
   * Deliberately NOT fixed here: R24 is executor-only and this is shared
   * surface, so making the mock reject non-blocks is a behaviour change to the
   * integration boundary and needs agreeing first (it is on the list for
   * Ricky, with R5's `followPlayer` → `not_found` and R9's `attack` →
   * `unreachable`). Documented so the gap is visible in the meantime.
   */
  async placeBlock(blockName: string, position: Vec3, opts?: ActionOptions): Promise<Result> {
    this.record('placeBlock', blockName, position)
    const r = await this.simulate('placeBlock', opts)
    if (!r.ok) return r

    // Inventory before target, the order the real executor checks in.
    // not_found, NOT missing_tool: "no material to place" and "no tool to
    // harvest" are different facts, and the planner will need different
    // policies for them once acquiring actions exist.
    if (!this.inventory.some((i) => i.name === blockName)) {
      return fail('not_found', `${blockName} is not in the inventory`)
    }
    // Occupancy is a fact about the world, not about perception, so a block
    // seeded invisible still occupies its position.
    const occupant = this.blocks.find(
      (b) => b.position.x === position.x && b.position.y === position.y && b.position.z === position.z,
    )
    if (occupant) {
      return fail('invalid_target', `${describeVec(position)} is occupied by ${occupant.name}`)
    }

    this.inventory = this.inventory
      .map((i) => (i.name === blockName ? { ...i, count: i.count - 1 } : i))
      .filter((i) => i.count > 0)
    const distance = Math.hypot(
      position.x - this.position.x,
      position.y - this.position.y,
      position.z - this.position.z,
    )
    this.blocks = [...this.blocks, { name: blockName, position: { ...position }, distance }]
    return ok(undefined)
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

  /**
   * `ok` either way, agreed 2026-09-11 (Phase 5 spec §7): `fled: false` when
   * there is no hostile. Nothing to flee from is the safest outcome, not a
   * failure.
   */
  async flee(opts?: ActionOptions): Promise<Result<{ fled: boolean }>> {
    this.record('flee')
    const r = await this.simulate('flee', opts)
    if (!r.ok) return r
    return ok({ fled: this.entities.some((e) => e.kind === 'hostile') })
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
      // Exploration cannot see further than perception: a block findBlocks
      // would not return from here must not surface through exploreFor either,
      // or the X-ray hole reopens through the back door.
      .filter((b) => b.visible !== false)
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

  /**
   * Change the health a snapshot reports, so a test can drive the state a
   * reflex layer escalates on (e.g. low health while a hostile is near).
   * Emits nothing: pair it with `emit('damaged' | 'health', …)` when the test
   * needs the push stream too. Agreed 2026-09-11, Phase 5 spec §7.
   */
  setHealth(health: number): void {
    this.health = health
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

  /**
   * Settles only on abort or `stop()` — never on its own.
   *
   * Deliberately NOT `this.wait(Infinity, opts)`. `wait` arms a setTimeout,
   * and setTimeout(fn, Infinity) fires after ~2ms in Node (measured
   * 2026-09-11): the delay overflows and clamps. A mock built that way would
   * report a follow that never ends as one that finished instantly.
   */
  private untilAborted(opts?: ActionOptions): Promise<Result> {
    // Same re-check as wait(): the caller awaited simulate() first.
    if (opts?.signal?.aborted) return Promise.resolve(fail('interrupted', 'aborted mid-action'))
    return new Promise<Result>((resolve) => {
      let settled = false
      const signal = opts?.signal
      const finish = (result: Result): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        if (this.inFlightStop === stopThisAction) this.inFlightStop = null
        resolve(result)
      }
      const onAbort = (): void => finish(fail('interrupted', 'aborted mid-action'))
      const stopThisAction = (): void => finish(fail('interrupted', 'stopped via stop()'))
      this.inFlightStop = stopThisAction
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}
