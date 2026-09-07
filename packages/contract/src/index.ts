/** A point in the world. Integer block coordinates unless stated otherwise. */
export interface Vec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

// ---------- Results ----------

export type Result<T = void> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: FailureReason; readonly detail: string }

export type FailureReason =
  | 'not_found'
  | 'unreachable'
  | 'interrupted'
  | 'invalid_target'
  | 'missing_tool'
  | 'inventory_full'
  | 'timeout'
  /**
   * Every action (`moveTo`, `followPlayer`, `mineBlock`, `placeBlock`,
   * `attack`, `flee`) resolves `fail('disconnected', …)` — never throws —
   * when called while not connected. This is the one place `getState()` and
   * `findBlocks()` differ from the rest of the surface: both of those throw
   * instead (see their doc comments) because they have no `Result` to report
   * failure through.
   */
  | 'disconnected'
  | 'internal'

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })

export const fail = (reason: FailureReason, detail = ''): Result<never> => ({
  ok: false,
  reason,
  detail,
})

// ---------- Cancellation ----------

export interface ActionOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

// ---------- Observation ----------

export interface ItemStack {
  readonly name: string
  readonly count: number
  readonly slot: number
}

export type EntityKind = 'player' | 'hostile' | 'passive' | 'item' | 'other'

export interface EntityInfo {
  readonly id: number
  readonly name: string
  readonly kind: EntityKind
  readonly position: Vec3
  readonly distance: number
  readonly health?: number
}

/** Result of a {@link BlockQuery}. See {@link BotExecutor.findBlocks} for ordering. */
export interface BlockInfo {
  readonly name: string
  readonly position: Vec3
  readonly distance: number
}

export interface BlockQuery {
  readonly names: readonly string[]
  readonly maxDistance: number
  readonly limit: number
}

export interface SelfState {
  readonly position: Vec3
  readonly health: number
  readonly food: number
  readonly dimension: string
  readonly onGround: boolean
  readonly inventory: readonly ItemStack[]
  readonly heldItem: ItemStack | null
}

export interface WorldSnapshot {
  readonly takenAt: number
  readonly self: SelfState
  /**
   * Other entities near the bot — never includes the bot's own entity.
   * Bounded (nearest-first, up to an implementation-defined radius and
   * count — see the executor package for the current defaults) rather than
   * a full world dump: an unfiltered entity list can run into the dozens
   * even in ordinary play, which doesn't fit in an LLM prompt any better
   * than an unfiltered block dump does (§3.3).
   */
  readonly nearbyEntities: readonly EntityInfo[]
}

// ---------- Events ----------

export interface BotEvents {
  spawned: Record<string, never>
  health: { health: number; food: number }
  damaged: { health: number; source: EntityInfo | null }
  entityNearby: { entity: EntityInfo }
  chat: { username: string; message: string }
  death: Record<string, never>
  disconnected: { reason: string }
}

export type Unsubscribe = () => void

// ---------- The executor ----------

export interface BotExecutor {
  connect(): Promise<Result>
  disconnect(): Promise<void>

  /** Immutable point-in-time snapshot. Throws if not connected. */
  getState(): WorldSnapshot
  /**
   * Nearest-first: results are ordered by ascending {@link BlockInfo.distance}.
   * Throws if not connected, for the same reason as {@link getState}: there
   * is no world to search, and a silent `[]` would be indistinguishable from
   * "connected, searched, found nothing" — an important difference for a
   * caller deciding whether to retry.
   */
  findBlocks(query: BlockQuery): readonly BlockInfo[]

  /**
   * Subscribe to a push event. Registering while not connected is a no-op
   * that returns a callable (but inert) unsubscribe — there is no live bot to
   * attach a listener to, and a later `connect()` does not retroactively wire
   * it up (subscriptions surviving a reconnect is an open contract question,
   * deferred — see the design spec).
   */
  on<K extends keyof BotEvents>(
    event: K,
    handler: (payload: BotEvents[K]) => void,
  ): Unsubscribe

  // Every action below resolves `fail('disconnected', …)` — never throws —
  // when called while not connected. See the `disconnected` FailureReason
  // doc comment above.
  moveTo(target: Vec3, opts?: ActionOptions): Promise<Result>
  followPlayer(playerName: string, opts?: ActionOptions): Promise<Result>
  /**
   * Mine a block and try to collect its drop.
   *
   * `target` is either a block name (mine the nearest match within
   * `maxDistance`) or an exact position (mine *that* block — the block
   * `findBlocks` returned and the planner reasoned about). Accepting a
   * position is what makes the search-choose-approach-mine loop expressible;
   * a name-only signature re-searches and may pick a different block.
   *
   * `maxDistance` bounds the search for a name target, and bounds how far the
   * bot will travel for a position target. A position further away than
   * `maxDistance` fails `not_found` rather than walking across the world.
   *
   * Resolves `ok` with `collected: false` when the block was mined but its
   * drop could not be retrieved — mining succeeded, and that fact must not be
   * lost by reporting a failure.
   */
  mineBlock(
    target: string | Vec3,
    maxDistance: number,
    opts?: ActionOptions,
  ): Promise<Result<{ position: Vec3; collected: boolean }>>
  placeBlock(blockName: string, position: Vec3, opts?: ActionOptions): Promise<Result>
  attack(entityId: number, opts?: ActionOptions): Promise<Result>
  flee(opts?: ActionOptions): Promise<Result>

  chat(message: string): void
  /** Halt movement immediately. Always safe to call, including when disconnected. */
  stop(): void
}
