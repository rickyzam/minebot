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

  constructor(opts: MineflayerExecutorOptions = {}) {
    this.host = opts.host ?? 'localhost'
    this.port = opts.port ?? 25565
    this.username = opts.username ?? 'MineBot'
    this.version = opts.version ?? '1.21.10'
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 30_000
  }

  async connect(): Promise<Result> {
    if (this.bot) return ok(undefined)

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
    const bot = this.bot
    if (!bot) return
    this.bot = null
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
    return toSnapshot(this.requireBot() as unknown as MineflayerLike)
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
      positions.slice(0, query.limit).map((p) =>
        Object.freeze({
          name: bot.blockAt(p)?.name ?? 'unknown',
          position: Object.freeze({ x: p.x, y: p.y, z: p.z }),
          distance: Math.hypot(p.x - origin.x, p.y - origin.y, p.z - origin.z),
        }),
      ),
    )
  }

  on<K extends keyof BotEvents>(
    event: K,
    handler: (payload: BotEvents[K]) => void,
  ): Unsubscribe {
    const bot = this.requireBot()
    const emit = handler as (p: unknown) => void

    switch (event) {
      case 'spawned': {
        const h = (): void => emit({})
        bot.on('spawn', h)
        return () => void bot.removeListener('spawn', h)
      }
      case 'health': {
        const h = (): void => emit({ health: bot.health, food: bot.food })
        bot.on('health', h)
        return () => void bot.removeListener('health', h)
      }
      case 'damaged': {
        const h = (entity: { id: number }): void => {
          if (entity.id !== bot.entity.id) return
          emit({ health: bot.health, source: null })
        }
        bot.on('entityHurt', h)
        return () => void bot.removeListener('entityHurt', h)
      }
      case 'entityNearby': {
        const h = (e: { id: number; position: { x: number; y: number; z: number } }): void => {
          const origin = bot.entity.position
          emit({
            entity: {
              id: e.id,
              name:
                (e as { username?: string }).username ??
                (e as { name?: string }).name ??
                'unknown',
              kind: classifyEntity(e as never),
              position: { x: e.position.x, y: e.position.y, z: e.position.z },
              distance: Math.hypot(
                e.position.x - origin.x,
                e.position.y - origin.y,
                e.position.z - origin.z,
              ),
            },
          })
        }
        bot.on('entitySpawn', h)
        return () => void bot.removeListener('entitySpawn', h)
      }
      case 'chat': {
        const h = (username: string, message: string): void => emit({ username, message })
        bot.on('chat', h)
        return () => void bot.removeListener('chat', h)
      }
      case 'death': {
        const h = (): void => emit({})
        bot.on('death', h)
        return () => void bot.removeListener('death', h)
      }
      case 'disconnected': {
        const h = (reason: string): void => emit({ reason })
        bot.on('end', h)
        return () => void bot.removeListener('end', h)
      }
      default:
        return () => {}
    }
  }

  async moveTo(_target: Vec3, opts?: ActionOptions): Promise<Result> {
    if (opts?.signal?.aborted) return fail('interrupted', 'aborted before start')
    return fail('internal', 'moveTo is implemented in Task 6')
  }

  async followPlayer(_playerName: string, opts?: ActionOptions): Promise<Result> {
    if (opts?.signal?.aborted) return fail('interrupted', 'aborted before start')
    return fail('internal', 'followPlayer arrives in Phase 5')
  }

  async mineBlock(
    _blockName: string,
    _maxDistance: number,
    opts?: ActionOptions,
  ): Promise<Result<{ position: Vec3; collected: boolean }>> {
    if (opts?.signal?.aborted) return fail('interrupted', 'aborted before start')
    return fail('internal', 'mineBlock arrives in Phase 2')
  }

  async placeBlock(_blockName: string, _position: Vec3, opts?: ActionOptions): Promise<Result> {
    if (opts?.signal?.aborted) return fail('interrupted', 'aborted before start')
    return fail('internal', 'placeBlock arrives in Phase 5')
  }

  async attack(_entityId: number, opts?: ActionOptions): Promise<Result> {
    if (opts?.signal?.aborted) return fail('interrupted', 'aborted before start')
    return fail('internal', 'attack arrives in Phase 5')
  }

  async flee(opts?: ActionOptions): Promise<Result> {
    if (opts?.signal?.aborted) return fail('interrupted', 'aborted before start')
    return fail('internal', 'flee arrives in Phase 5')
  }

  chat(message: string): void {
    this.bot?.chat(message)
  }

  stop(): void {
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
}
