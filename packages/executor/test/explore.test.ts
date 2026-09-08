import { describe, it, expect } from 'vitest'
import {
  nextWaypoint,
  searchedRadius,
  DEFAULT_PERCEPTION_RADIUS,
  type SearchState,
} from '../src/explore.js'

const ORIGIN = { x: 0, y: 64, z: 0 }
/** Waypoints are whole blocks, so each sits up to sqrt(2)/2 off its ring. */
const ROUNDING_SLACK = Math.SQRT2 / 2 + 1e-6
const base = (over: Partial<SearchState> = {}): SearchState => ({
  origin: ORIGIN,
  visited: [],
  maxDistance: 64,
  spacing: DEFAULT_PERCEPTION_RADIUS,
  ...over,
})

/** Walk the search to completion, returning every waypoint it produced. */
function runToExhaustion(state: SearchState, cap = 5_000): { x: number; y: number; z: number }[] {
  const visited: { x: number; y: number; z: number }[] = []
  for (let i = 0; i < cap; i++) {
    const next = nextWaypoint({ ...state, visited })
    if (next === null) return visited
    visited.push(next)
  }
  throw new Error(`search did not terminate within ${cap} waypoints`)
}

describe('nextWaypoint', () => {
  it('starts where the bot is standing', () => {
    expect(nextWaypoint(base())).toEqual(ORIGIN)
  })

  it('terminates', () => {
    // The failure mode to fear is not a bad search but one that never stops.
    const all = runToExhaustion(base())
    expect(all.length).toBeGreaterThan(1)
    expect(nextWaypoint({ ...base(), visited: all })).toBeNull()
  })

  it('never proposes a waypoint beyond maxDistance', () => {
    for (const wp of runToExhaustion(base())) {
      expect(Math.hypot(wp.x - ORIGIN.x, wp.z - ORIGIN.z)).toBeLessThanOrEqual(64 + 1e-9)
    }
  })

  it('goes outward, so a near block is found before a far one', () => {
    const all = runToExhaustion(base())
    const radii = all.map((w) => Math.hypot(w.x - ORIGIN.x, w.z - ORIGIN.z))
    // Non-decreasing by ring. Points in one ring do NOT share a radius exactly:
    // waypoints are whole blocks, so each sits up to sqrt(2)/2 off its nominal
    // ring and two points on the same ring can differ by up to sqrt(2). That is
    // sub-block jitter, not a search that doubled back — a genuine ordering bug
    // would regress by a whole `spacing` (32 blocks), which this still catches.
    const ROUNDING_JITTER = Math.SQRT2 + 1e-6
    for (let i = 1; i < radii.length; i++) {
      expect(radii[i]! + ROUNDING_JITTER).toBeGreaterThanOrEqual(radii[i - 1]!)
    }
  })

  it('orders rings strictly, ignoring within-ring jitter', () => {
    // The assertion above tolerates sqrt(2); this one proves that tolerance is
    // not hiding an out-of-order ring. Every waypoint on the inner ring must
    // precede every waypoint on the outer one.
    const all = runToExhaustion(base())
    const radii = all.map((w) => Math.hypot(w.x - ORIGIN.x, w.z - ORIGIN.z))
    const lastInner = radii.findLastIndex((r) => r < DEFAULT_PERCEPTION_RADIUS + ROUNDING_SLACK)
    const firstOuter = radii.findIndex((r) => r >= DEFAULT_PERCEPTION_RADIUS + ROUNDING_SLACK)
    expect(firstOuter).toBeGreaterThan(0)
    expect(lastInner).toBeLessThan(firstOuter)
  })

  it('covers every point within maxDistance', () => {
    // THE correctness property. Perception at each waypoint reaches `spacing`
    // blocks, so every point must lie within `spacing` of some waypoint or the
    // search has a hole in it. Checked by enumeration, not by argument.
    const all = runToExhaustion(base())
    for (let x = -64; x <= 64; x += 4) {
      for (let z = -64; z <= 64; z += 4) {
        if (Math.hypot(x, z) > 64) continue
        const nearest = Math.min(...all.map((w) => Math.hypot(w.x - x, w.z - z)))
        expect(nearest).toBeLessThanOrEqual(DEFAULT_PERCEPTION_RADIUS)
      }
    }
  })

  it('resumes rather than restarting when handed its own history', () => {
    const first = nextWaypoint(base())!
    const second = nextWaypoint({ ...base(), visited: [first] })
    expect(second).not.toEqual(first)
  })

  it('proposes nothing at all for a zero-radius search', () => {
    const state = base({ maxDistance: 0 })
    expect(nextWaypoint({ ...state, visited: [ORIGIN] })).toBeNull()
  })

  it("keeps the search on the bot's own level", () => {
    for (const wp of runToExhaustion(base())) expect(wp.y).toBe(ORIGIN.y)
  })

  it('treats a visited waypoint as covered regardless of elevation', () => {
    // The executor records where it MEANT to stand, but terrain means the bot
    // may end up a few blocks up or down. A search that failed to recognise its
    // own history because the y differed would re-walk the same column forever.
    const first = nextWaypoint(base())!
    const landedLower = { ...first, y: first.y - 3 }
    expect(nextWaypoint({ ...base(), visited: [landedLower] })).not.toEqual(first)
  })

  it('searches around wherever the origin actually is, not around zero', () => {
    // The benchmark world is at x~3000. An implementation that quietly assumed
    // an origin at the world centre would still pass every test above.
    const origin = { x: 3000, y: 72, z: -1500 }
    const all = runToExhaustion(base({ origin }))
    expect(all[0]).toEqual(origin)
    for (const wp of all) {
      expect(Math.hypot(wp.x - origin.x, wp.z - origin.z)).toBeLessThanOrEqual(64 + 1e-9)
    }
  })
})

describe('searchedRadius', () => {
  it('is zero before anything is visited', () => {
    expect(searchedRadius(base())).toBe(0)
  })

  it('reports how far out the search has reached', () => {
    const state = base({ visited: [ORIGIN, { x: 32, y: 64, z: 0 }] })
    expect(searchedRadius(state)).toBeCloseTo(32, 5)
  })

  it('ignores elevation, since the search is horizontal', () => {
    const state = base({ visited: [{ x: 0, y: 200, z: 0 }] })
    expect(searchedRadius(state)).toBe(0)
  })
})
