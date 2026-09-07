import type {
  EntityInfo,
  EntityKind,
  ItemStack,
  SelfState,
  Vec3,
  WorldSnapshot,
} from '@minebot/contract'

/**
 * Structural subset of Mineflayer's Bot that the mapper reads. Declared here
 * rather than imported so this module stays testable with plain object literals.
 */
export interface RawPosition {
  x: number
  y: number
  z: number
}

export interface RawEntity {
  id: number
  type?: string
  name?: string
  kind?: string
  username?: string
  position: RawPosition
  health?: number
}

export interface RawItem {
  name: string
  count: number
  slot: number
}

export interface MineflayerLike {
  entity: { position: RawPosition; onGround?: boolean } | null
  health?: number
  food?: number
  game?: { dimension?: string }
  entities: Record<string, RawEntity | undefined>
  inventory: { items(): RawItem[] }
  heldItem?: RawItem | null
}

export function classifyEntity(e: RawEntity): EntityKind {
  if (e.type === 'player') return 'player'
  if (e.name === 'item' || e.type === 'orb') return 'item'
  const kind = e.kind ?? ''
  if (kind.includes('Hostile')) return 'hostile'
  if (kind.includes('Passive') || kind.includes('Animals')) return 'passive'
  return 'other'
}

const freezeVec = (p: RawPosition): Vec3 => Object.freeze({ x: p.x, y: p.y, z: p.z })

const freezeItem = (i: RawItem): ItemStack =>
  Object.freeze({ name: i.name, count: i.count, slot: i.slot })

const distance = (a: RawPosition, b: RawPosition): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/**
 * Take an immutable snapshot of the bot's world view. Values are copied, so a
 * snapshot stays valid even as the live bot object keeps changing underneath it.
 */
export function toSnapshot(bot: MineflayerLike, now: number = Date.now()): WorldSnapshot {
  if (!bot.entity) {
    throw new Error('toSnapshot: bot has not spawned yet (bot.entity is null)')
  }
  const origin = bot.entity.position

  const inventory = Object.freeze(bot.inventory.items().map(freezeItem))

  const self: SelfState = Object.freeze({
    position: freezeVec(origin),
    health: bot.health ?? 0,
    food: bot.food ?? 0,
    dimension: bot.game?.dimension ?? 'unknown',
    onGround: bot.entity.onGround ?? false,
    inventory,
    heldItem: bot.heldItem ? freezeItem(bot.heldItem) : null,
  })

  const nearbyEntities: readonly EntityInfo[] = Object.freeze(
    Object.values(bot.entities)
      .filter((e): e is RawEntity => e !== undefined && e.position !== undefined)
      .map((e) =>
        Object.freeze({
          id: e.id,
          name: e.username ?? e.name ?? 'unknown',
          kind: classifyEntity(e),
          position: freezeVec(e.position),
          distance: distance(origin, e.position),
          ...(e.health === undefined ? {} : { health: e.health }),
        }),
      )
      .sort((a, b) => a.distance - b.distance),
  )

  return Object.freeze({ takenAt: now, self, nearbyEntities })
}
