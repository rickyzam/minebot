/**
 * Perception is limited to what the bot could see from where it is standing.
 *
 * Kept pure — no Mineflayer import — so the rule can be tested exhaustively
 * without a server, and so the two stages can be asserted in the right ORDER
 * rather than merely in aggregate.
 *
 * Why this exists (see the line-of-sight spec, and CLAUDE.md's verified facts):
 * Mineflayer's `bot.findBlocks` queries the client's world model with no
 * visibility test of any kind, so it returns blocks entirely encased in solid
 * rock. Measured at the Phase 4 benchmark start on 2026-09-08: 3216 natural
 * `coal_ore` within 64 blocks, 60 of them touching a non-solid block, and
 * **zero** actually visible. The bot reported eight and did not move, because
 * it "saw" coal under its own feet. Every one of those hits was unactionable —
 * movement is non-destructive by design, so the only follow-up is `mineBlock`,
 * which returns `unreachable` forever.
 *
 * Facing direction is deliberately ignored. A player can turn their head, and
 * making perception depend on yaw would produce results that flicker as the
 * pathfinder steers.
 */
import type { Vec3 } from '@minebot/contract'

/** Structural subset of prismarine-block's Block that this module reads. */
export interface BlockView {
  readonly name: string
  readonly position: Vec3
  /**
   * prismarine-block's collision shape class. `'block'` is a full solid cube;
   * everything else (`'empty'` for air, cave_air and water, `'shaped'` for
   * slabs and stairs) is something a line of sight can pass through or reach
   * into. Only `'block'` seals a face.
   */
  readonly boundingBox: string
}

/**
 * The world, and the raycast, as this module needs them. Injected rather than
 * imported so the rule is testable without a server — and so the raycast can be
 * counted in tests, which is how the stage ordering below is verified rather
 * than assumed.
 */
export interface PerceptionWorld {
  /** `null` means the chunk is not loaded, not that the space is empty. */
  blockAt(position: Vec3): BlockView | null
  /**
   * True when a ray from the bot's eye reaches this block before hitting
   * anything else. Backed by `bot.canSeeBlock` in production.
   */
  canSee(block: BlockView): boolean
}

/** A block, and the provenance of having seen it. */
export interface Observation {
  readonly name: string
  readonly position: Vec3
  readonly distance: number
  /** Where the bot was standing when this was perceived. */
  readonly seenFrom: Vec3
  /** `Date.now()` at the moment of perception. */
  readonly seenAt: number
}

const FACES: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
]

/**
 * Stage 1: could this block be seen from *anywhere*? A block with all six faces
 * against full solid cubes cannot, ever.
 *
 * This is a NECESSARY condition, never a sufficient one — a block exposed only
 * to a sealed cavern passes here and correctly fails stage 2. At the benchmark
 * start all 60 exposed coal blocks fail stage 2, so shipping this alone would
 * swap eight unreachable hits for a different eight rather than for the truth.
 *
 * An unloaded neighbour (`null`) counts as SOLID. The bot may not claim to see
 * through a chunk it does not have; guessing the other way would reintroduce
 * the X-ray hole at chunk boundaries.
 */
export function isExposed(world: PerceptionWorld, position: Vec3): boolean {
  for (const [dx, dy, dz] of FACES) {
    const neighbour = world.blockAt({
      x: position.x + dx,
      y: position.y + dy,
      z: position.z + dz,
    })
    if (neighbour !== null && neighbour.boundingBox !== 'block') return true
  }
  return false
}

/**
 * The rule: exposure first, then the exact line-of-sight test.
 *
 * The order is load-bearing rather than stylistic. `canSee` is the only part
 * that can be expensive — its cost scales with how far the ray travels — and
 * stage 1 keeps it off the overwhelming majority of candidates in the case that
 * actually hurts. Measured 2026-09-08 at r=64: for `stone`, 302k candidates,
 * 891ms with this ordering against 1431ms with the raycast alone.
 *
 * The saving is smaller than it looks for buried ore (322ms vs 335ms for coal),
 * because a ray from a surface bot toward buried ore stops at the ground a
 * block away and costs about what six `blockAt` lookups cost. Stage 1 is kept
 * because it wins big in the pathological case and costs a fraction of a
 * millisecond when it does not help — not because it is what makes this
 * affordable. It is not; see the spec's §5.3.1.
 */
export function isPerceivable(world: PerceptionWorld, block: BlockView): boolean {
  if (!isExposed(world, block.position)) return false
  return world.canSee(block)
}

/**
 * Attach provenance to a perceived block.
 *
 * The contract's `findBlocks` still returns plain `BlockInfo[]`, so `seenFrom`
 * and `seenAt` are dropped at the boundary today. They are produced anyway
 * because the planned memory subsystem consumes exactly this — *what was
 * perceived, from where, at what time* — and its binding invariant is that
 * memory may only be written from perception output, never from the raw world
 * model. Getting the internal shape right costs nothing now; retrofitting it
 * would mean touching `findBlocks`, `exploreFor` and the contract a second
 * time. See `docs/notes/Memory and Recall.md` §10.
 */
export function observe(block: BlockView, seenFrom: Vec3, seenAt: number): Observation {
  return Object.freeze({
    name: block.name,
    position: Object.freeze({ ...block.position }),
    distance: Math.hypot(
      block.position.x - seenFrom.x,
      block.position.y - seenFrom.y,
      block.position.z - seenFrom.z,
    ),
    seenFrom: Object.freeze({ ...seenFrom }),
    seenAt,
  })
}
