import {
  ok,
  fail,
  type ActionOptions,
  type BlockInfo,
  type BlockQuery,
  type BotEvents,
  type BotExecutor,
  type EntityInfo,
  type ItemStack,
  type Result,
  type Unsubscribe,
  type Vec3,
  type WorldSnapshot,
} from '@minebot/contract'

export interface MockOptions {
  position?: Vec3
  health?: number
  food?: number
  inventory?: ItemStack[]
  entities?: EntityInfo[]
  blocks?: BlockInfo[]
  /** Simulated duration of each action, so cancellation can be exercised. */
  actionDelayMs?: number
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
  private readonly handlers = new Map<string, Set<Handler>>()

  constructor(opts: MockOptions = {}) {
    this.position = opts.position ?? { x: 0, y: 64, z: 0 }
    this.health = opts.health ?? 20
    this.food = opts.food ?? 20
    this.inventory = opts.inventory ?? []
    this.entities = opts.entities ?? []
    this.blocks = opts.blocks ?? []
    this.delayMs = opts.actionDelayMs ?? 0
  }

  async connect(): Promise<Result> {
    this.record('connect')
    this.connected = true
    return ok(undefined)
  }

  async disconnect(): Promise<void> {
    this.record('disconnect')
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
    const names = new Set(query.names)
    return Object.freeze(
      this.blocks
        .filter((b) => names.has(b.name) && b.distance <= query.maxDistance)
        .slice(0, query.limit)
        .map((b) => Object.freeze({ ...b })),
    )
  }

  on<K extends keyof BotEvents>(
    event: K,
    handler: (payload: BotEvents[K]) => void,
  ): Unsubscribe {
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
      ;(h as (p: BotEvents[K]) => void)(payload)
    }
  }

  async moveTo(target: Vec3, opts?: ActionOptions): Promise<Result> {
    this.record('moveTo', target)
    const r = await this.simulate(opts)
    if (!r.ok) return r
    this.position = { ...target }
    return ok(undefined)
  }

  async followPlayer(playerName: string, opts?: ActionOptions): Promise<Result> {
    this.record('followPlayer', playerName)
    return this.simulate(opts)
  }

  async mineBlock(
    blockName: string,
    maxDistance: number,
    opts?: ActionOptions,
  ): Promise<Result<{ position: Vec3; collected: boolean }>> {
    this.record('mineBlock', blockName, maxDistance)
    const r = await this.simulate(opts)
    if (!r.ok) return r
    const match = this.blocks.find(
      (b) => b.name === blockName && b.distance <= maxDistance,
    )
    if (!match) return fail('not_found', `no ${blockName} within ${maxDistance} blocks`)
    this.blocks = this.blocks.filter((b) => b !== match)
    this.inventory = [
      ...this.inventory,
      { name: blockName, count: 1, slot: this.inventory.length },
    ]
    return ok({ position: match.position, collected: true })
  }

  async placeBlock(blockName: string, position: Vec3, opts?: ActionOptions): Promise<Result> {
    this.record('placeBlock', blockName, position)
    return this.simulate(opts)
  }

  async attack(entityId: number, opts?: ActionOptions): Promise<Result> {
    this.record('attack', entityId)
    const r = await this.simulate(opts)
    if (!r.ok) return r
    if (!this.entities.some((e) => e.id === entityId)) {
      return fail('not_found', `no entity ${entityId}`)
    }
    return ok(undefined)
  }

  async flee(opts?: ActionOptions): Promise<Result> {
    this.record('flee')
    return this.simulate(opts)
  }

  chat(message: string): void {
    this.record('chat', message)
  }

  stop(): void {
    this.record('stop')
  }

  private record(name: string, ...args: unknown[]): void {
    this.calls.push({ name, args })
  }

  /** Honour the contract's cancellation rule: resolve interrupted, never throw. */
  private simulate(opts?: ActionOptions): Promise<Result> {
    if (opts?.signal?.aborted) return Promise.resolve(fail('interrupted', 'aborted before start'))
    if (this.delayMs === 0) return Promise.resolve(ok(undefined))
    return new Promise<Result>((resolve) => {
      const signal = opts?.signal
      const onAbort = () => {
        clearTimeout(timer)
        resolve(fail('interrupted', 'aborted mid-action'))
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve(ok(undefined))
      }, this.delayMs)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}
