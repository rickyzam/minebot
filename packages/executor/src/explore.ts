/**
 * Where to look next, kept pure so the search can be tested exhaustively
 * without a server — the same reasoning that put harvestability in
 * `harvest.ts`. This module decides; the executor walks.
 *
 * The strategy is an expanding horizontal spiral: rings of increasing radius
 * around the origin, at the bot's own elevation, with `findBlocks` (free) run
 * at each waypoint. Deliberately horizontal and non-destructive — descending
 * and digging are their own design, and Phase 2 established movement as
 * non-destructive on purpose.
 */
import type { Vec3 } from '@minebot/contract'

/**
 * How far `findBlocks` is asked to see from a waypoint, and therefore how far
 * apart waypoints may sit without leaving a hole between them. Ring spacing
 * and arc spacing both use it, which is what makes the coverage property in
 * explore.test.ts hold.
 */
export const DEFAULT_PERCEPTION_RADIUS = 32

export interface SearchState {
  /** Where the search started. NOT the bot's current position — it moves. */
  readonly origin: Vec3
  /** Waypoints already visited and searched from. */
  readonly visited: readonly Vec3[]
  readonly maxDistance: number
  /** Distance between waypoints; see DEFAULT_PERCEPTION_RADIUS. */
  readonly spacing: number
}

/**
 * Two waypoints are the same place if they share a column. Elevation is
 * ignored on purpose: the executor records the waypoint it aimed for, but
 * terrain decides where the bot actually stands, and a search that failed to
 * recognise its own history because the y differed would re-walk that column
 * forever.
 */
const sameColumn = (a: Vec3, b: Vec3): boolean => a.x === b.x && a.z === b.z

/**
 * Every waypoint this search will ever propose, nearest ring first.
 *
 * Rings are `spacing` apart radially, and each ring carries enough points that
 * neighbours are at most `spacing` apart along the arc. Coordinates are
 * rounded to blocks, which can collide, so callers must tolerate duplicates —
 * `nextWaypoint` does by skipping anything already visited.
 */
function* candidates(state: SearchState): Generator<Vec3> {
  const { origin, maxDistance, spacing } = state
  yield origin
  if (spacing <= 0) return
  for (let radius = spacing; radius <= maxDistance; radius += spacing) {
    const count = Math.max(4, Math.ceil((2 * Math.PI * radius) / spacing))
    for (let i = 0; i < count; i++) {
      const angle = (2 * Math.PI * i) / count
      const dx = radius * Math.cos(angle)
      const dz = radius * Math.sin(angle)
      // Round to whole blocks, but never outward past what the caller asked
      // for: rounding both axes up can add ~0.71 blocks, which on the outermost
      // ring puts the waypoint outside maxDistance. Truncating instead shortens
      // each axis, so the result is provably no further out than `radius`.
      let x = Math.round(dx)
      let z = Math.round(dz)
      if (Math.hypot(x, z) > maxDistance) {
        x = Math.trunc(dx)
        z = Math.trunc(dz)
      }
      yield { x: origin.x + x, y: origin.y, z: origin.z + z }
    }
  }
}

/**
 * The next place worth standing, or `null` when the space is exhausted.
 *
 * Deterministic given the same state, so a resumed search continues rather
 * than restarting — the executor stores `visited` and hands it straight back.
 */
export function nextWaypoint(state: SearchState): Vec3 | null {
  for (const candidate of candidates(state)) {
    if (!state.visited.some((v) => sameColumn(v, candidate))) return candidate
  }
  return null
}

/**
 * How far from the origin the search has reached, horizontally.
 *
 * Elevation is ignored because the search is horizontal: a waypoint directly
 * above the origin has covered no new ground.
 */
export function searchedRadius(state: SearchState): number {
  let furthest = 0
  for (const v of state.visited) {
    const d = Math.hypot(v.x - state.origin.x, v.z - state.origin.z)
    if (d > furthest) furthest = d
  }
  return furthest
}
