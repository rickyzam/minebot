/**
 * Print — and optionally mark in the world — the exact waypoints `exploreFor`
 * will visit, so a target can be placed at a known point on the search path
 * rather than at a guessed distance.
 *
 *   npm run explore:path                  # list the waypoints
 *   npm run explore:path -- --mark        # build a visible column at each one
 *   npm run explore:path -- --clear       # take the markers back down
 *
 * The waypoints come from the same pure `nextWaypoint` the executor uses, so
 * this is the real path, not a reconstruction of it.
 */
import { nextWaypoint, searchedRadius, DEFAULT_PERCEPTION_RADIUS } from '@minebot/executor'
import type { Vec3 } from '@minebot/contract'
import { mc, sleep, readFixture } from './bench-world.js'

const RADIUS = 64
/** Tall enough to see from the ground, cheap enough to remove. */
const MARKER = 'glowstone'
const MARKER_HEIGHT = 12

const fixture = readFixture()
const origin: Vec3 = { x: fixture.start.x, y: fixture.start.y, z: fixture.start.z }

const visited: Vec3[] = []
for (;;) {
  const next = nextWaypoint({
    origin,
    visited,
    maxDistance: RADIUS,
    spacing: DEFAULT_PERCEPTION_RADIUS,
  })
  if (next === null) break
  visited.push(next)
}

const bearing = (p: Vec3): string => {
  const dx = p.x - origin.x
  const dz = p.z - origin.z
  if (dx === 0 && dz === 0) return 'origin'
  const ns = dz < 0 ? 'N' : dz > 0 ? 'S' : ''
  const ew = dx > 0 ? 'E' : dx < 0 ? 'W' : ''
  return `${ns}${ew}` || 'origin'
}

const args = process.argv.slice(2)
console.log(
  `exploreFor origin (${origin.x}, ${origin.z}), radius ${RADIUS}, ` +
    `spacing ${DEFAULT_PERCEPTION_RADIUS} -> ${visited.length} waypoints\n`,
)
const rings = new Map<number, Vec3[]>()
for (const w of visited) {
  const r = Math.round(Math.hypot(w.x - origin.x, w.z - origin.z))
  const ring = rings.get(r) ?? []
  ring.push(w)
  rings.set(r, ring)
}
for (const [r, ws] of [...rings.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  ring r=${String(r).padStart(3)}  ${ws.length} waypoint(s)`)
  for (const w of ws) {
    console.log(
      `      (${String(w.x).padStart(5)}, ${String(w.z).padStart(5)})  ${bearing(w).padEnd(3)}` +
        `  searchedTo=${searchedRadius({ origin, visited: [w], maxDistance: RADIUS, spacing: DEFAULT_PERCEPTION_RADIUS })}`,
    )
  }
}

const outer = [...rings.entries()].sort((a, b) => b[0] - a[0])[0]
if (outer) {
  console.log(
    `\nOUTERMOST ring r=${outer[0]}: ${outer[1].length} waypoints, ` +
      `the last ground the search covers before it reports exhausted.`,
  )
}

if (args.includes('--mark') || args.includes('--clear')) {
  const clearing = args.includes('--clear')
  const region = { x: origin.x, z: origin.z, radius: RADIUS }
  mc(`forceload add ${region.x - RADIUS} ${region.z - RADIUS} ${region.x + RADIUS} ${region.z + RADIUS}`)
  await sleep(2_000)
  for (const w of visited) {
    // A column from well below the surface upward, so it is visible whatever
    // the local ground height turns out to be. Air on --clear.
    const y0 = 60
    const y1 = y0 + MARKER_HEIGHT + 40
    mc(`fill ${w.x} ${y0 + 25} ${w.z} ${w.x} ${y1} ${w.z} ${clearing ? 'air' : MARKER}`)
    await sleep(120)
  }
  console.log(`\n${clearing ? 'cleared' : 'marked'} ${visited.length} waypoint columns.`)
  if (!clearing) console.log('Take them down with: npm run explore:path -- --clear')
}
