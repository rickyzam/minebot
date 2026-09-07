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
  findBlocks(query: BlockQuery): readonly BlockInfo[]

  on<K extends keyof BotEvents>(
    event: K,
    handler: (payload: BotEvents[K]) => void,
  ): Unsubscribe

  moveTo(target: Vec3, opts?: ActionOptions): Promise<Result>
  followPlayer(playerName: string, opts?: ActionOptions): Promise<Result>
  mineBlock(
    blockName: string,
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
