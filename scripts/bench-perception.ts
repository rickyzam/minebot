/**
 * Measure what an honest `findBlocks` costs, per the line-of-sight spec §5.3.
 *
 *   npm run bench:perception            # 5 timed repetitions per variant
 *   npm run bench:perception -- 10
 *
 * §5.3 says the two-stage filter's cost "must be measured before this lands",
 * because `findBlocks` is documented synchronous and free and the planner calls
 * it on that basis. This script produces that number, and it also settles the
 * question §5.2 was written without an answer to.
 *
 * Reading `node_modules/mineflayer/lib/plugins/blocks.js` shows TWO predicate
 * hooks, invoked at different rates:
 *
 *   `matching`      — once per palette entry per section (blocks.js:130, on a
 *                     SYNTHETIC positionless block), then once per block in
 *                     every surviving section (blocks.js:182-188). Per-volume.
 *   `useExtraInfo`  — when passed a FUNCTION, `matcher(block) && useExtraInfo(block)`
 *                     (blocks.js:146-149). The `&&` short-circuits, so this runs
 *                     only on blocks that already matched by type. Per-candidate.
 *
 * That matters because `useExtraInfo` runs INSIDE the search, upstream of the
 * count: `blocks.push` is gated on it (blocks.js:185) and the early break reads
 * `blocks.length >= count` (blocks.js:193). So `count` counts SURVIVORS, and the
 * nearest-first trap §5.2 warns about — filtering an already-truncated list —
 * simply does not arise. The `overfetch+filter` variant below is §5.2's proposed
 * route, measured alongside so the comparison is evidence rather than argument.
 *
 * Every variant reports its own predicate call counts, so the per-candidate vs
 * per-volume claim above is measured here too, not merely read off the source.
 */
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Vec3 } from 'vec3'
import { MineflayerExecutor } from '@minebot/executor'
import { mc, sleep, readFixture, fixtureRegion, forceloadArgs } from './bench-world.js'

const MAX_DISTANCE = 64
/** The spec's own §5.2 example uses a limit of 8. */
const LIMIT = 8
/** Big enough to never early-break, so a census scans the whole volume. */
const CENSUS_COUNT = 1_000_000
/** §5.2's over-fetch route needs a bound; this is a generous one. */
const OVERFETCH = 512

const FACES = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const

/**
 * Stage 1 of §5.1: a block with all six faces against solid blocks cannot be
 * seen from anywhere, ever. Six lookups, no raycast.
 *
 * A null neighbour means an unloaded chunk, which is counted as solid — the
 * bot cannot claim to see through a chunk it has not got.
 */
const isExposed = (bot: Bot, block: Block): boolean => {
  for (const [dx, dy, dz] of FACES) {
    const n = bot.blockAt(block.position.offset(dx, dy, dz), false)
    if (n !== null && n.boundingBox !== 'block') return true
  }
  return false
}

interface Counters {
  matchCalls: number
  extraCalls: number
  raycasts: number
}

interface VariantResult {
  positions: Vec3[]
  counters: Counters
}

type Variant = (bot: Bot, names: ReadonlySet<string>) => VariantResult

/** Today's behaviour: type match only, no visibility test of any kind. */
const baseline: Variant = (bot, names) => {
  const c: Counters = { matchCalls: 0, extraCalls: 0, raycasts: 0 }
  const positions = bot.findBlocks({
    matching: (b) => {
      c.matchCalls++
      return b !== null && names.has(b.name)
    },
    maxDistance: MAX_DISTANCE,
    count: LIMIT,
  })
  return { positions, counters: c }
}

/** Stage 1 only, folded into the per-candidate hook. */
const exposureOnly: Variant = (bot, names) => {
  const c: Counters = { matchCalls: 0, extraCalls: 0, raycasts: 0 }
  const positions = bot.findBlocks({
    matching: (b) => {
      c.matchCalls++
      return b !== null && names.has(b.name)
    },
    useExtraInfo: (b) => {
      c.extraCalls++
      return isExposed(bot, b)
    },
    maxDistance: MAX_DISTANCE,
    count: LIMIT,
  })
  return { positions, counters: c }
}

/** Both stages of §5.1, folded into the per-candidate hook. The proposal. */
const exposureThenLos: Variant = (bot, names) => {
  const c: Counters = { matchCalls: 0, extraCalls: 0, raycasts: 0 }
  const positions = bot.findBlocks({
    matching: (b) => {
      c.matchCalls++
      return b !== null && names.has(b.name)
    },
    useExtraInfo: (b) => {
      c.extraCalls++
      if (!isExposed(bot, b)) return false
      c.raycasts++
      return bot.canSeeBlock(b)
    },
    maxDistance: MAX_DISTANCE,
    count: LIMIT,
  })
  return { positions, counters: c }
}

/**
 * Stage 2 with no stage-1 pre-filter. §5.1 asserts the exposure test earns its
 * place as an optimisation; this is the variant that tests that assertion
 * rather than assuming it.
 */
const losOnly: Variant = (bot, names) => {
  const c: Counters = { matchCalls: 0, extraCalls: 0, raycasts: 0 }
  const positions = bot.findBlocks({
    matching: (b) => {
      c.matchCalls++
      return b !== null && names.has(b.name)
    },
    useExtraInfo: (b) => {
      c.extraCalls++
      c.raycasts++
      return bot.canSeeBlock(b)
    },
    maxDistance: MAX_DISTANCE,
    count: LIMIT,
  })
  return { positions, counters: c }
}

/**
 * §5.2's route: over-fetch, filter outside the search, then truncate. Measured
 * so the choice between the two is made on numbers.
 */
const overfetchThenFilter: Variant = (bot, names) => {
  const c: Counters = { matchCalls: 0, extraCalls: 0, raycasts: 0 }
  const raw = bot.findBlocks({
    matching: (b) => {
      c.matchCalls++
      return b !== null && names.has(b.name)
    },
    maxDistance: MAX_DISTANCE,
    count: OVERFETCH,
  })
  const positions: Vec3[] = []
  for (const p of raw) {
    const block = bot.blockAt(p, false)
    if (block === null) continue
    c.extraCalls++
    if (!isExposed(bot, block)) continue
    c.raycasts++
    if (!bot.canSeeBlock(block)) continue
    positions.push(p)
    if (positions.length >= LIMIT) break
  }
  return { positions, counters: c }
}

const VARIANTS: ReadonlyArray<readonly [string, Variant]> = [
  ['baseline (today)', baseline],
  ['exposure', exposureOnly],
  ['exposure+los', exposureThenLos],
  ['los only', losOnly],
  [`overfetch(${OVERFETCH})+filter`, overfetchThenFilter],
]

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!
}

/**
 * How many blocks of this type exist in the volume, how many are exposed, and
 * how many are genuinely visible. Reproduces the spec §3 census, which is what
 * makes this script's own numbers checkable against a figure already agreed.
 */
function census(bot: Bot, names: ReadonlySet<string>): {
  total: number
  exposed: number
  visible: number
  scanned: number
} {
  let scanned = 0
  const all = bot.findBlocks({
    matching: (b) => {
      scanned++
      return b !== null && names.has(b.name)
    },
    maxDistance: MAX_DISTANCE,
    count: CENSUS_COUNT,
  })
  let exposed = 0
  let visible = 0
  for (const p of all) {
    const block = bot.blockAt(p, false)
    if (block === null || !isExposed(bot, block)) continue
    exposed++
    if (bot.canSeeBlock(block)) visible++
  }
  return { total: all.length, exposed, visible, scanned }
}

/**
 * Why the exposure census disagrees with spec §3, and what the cost looks like
 * at the radii the planner actually uses. §3 recorded "1 touching a non-solid
 * block"; this breaks the predicate apart so the difference is attributable
 * rather than merely noted.
 */
function detail(bot: Bot): void {
  const coal = new Set(['coal_ore'])
  const all = bot.findBlocks({
    matching: (b) => b !== null && coal.has(b.name),
    maxDistance: MAX_DISTANCE,
    count: CENSUS_COUNT,
  })

  const kinds = new Map<string, number>()
  let airTouching = 0
  let anyNonSolid = 0
  for (const p of all) {
    const block = bot.blockAt(p, false)
    if (block === null) continue
    let touchesAir = false
    let touchesNonSolid = false
    for (const [dx, dy, dz] of FACES) {
      const n = bot.blockAt(p.offset(dx, dy, dz), false)
      if (n === null || n.boundingBox === 'block') continue
      touchesNonSolid = true
      kinds.set(n.name, (kinds.get(n.name) ?? 0) + 1)
      if (n.name === 'air' || n.name === 'cave_air') touchesAir = true
    }
    if (touchesAir) airTouching++
    if (touchesNonSolid) anyNonSolid++
  }

  console.log('=== exposure predicate breakdown, coal_ore ===')
  console.log(`  total in volume                  ${all.length}`)
  console.log(`  touching air/cave_air            ${airTouching}`)
  console.log(`  touching ANY non-solid           ${anyNonSolid}`)
  console.log(
    `  non-solid neighbours by kind     ` +
      [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '),
  )
  console.log('')

  console.log('=== radius sweep (median of 5) ===')
  for (const label of ['coal_ore', 'emerald_block'] as const) {
    const names = new Set<string>([label])
    for (const radius of [16, 32, 64]) {
      const time = (fn: () => Vec3[]): [number, number] => {
        const ts: number[] = []
        let n = 0
        for (let i = 0; i < 5; i++) {
          const t0 = performance.now()
          n = fn().length
          ts.push(performance.now() - t0)
        }
        return [median(ts), n]
      }
      const [base, baseN] = time(() =>
        bot.findBlocks({
          matching: (b) => b !== null && names.has(b.name),
          maxDistance: radius,
          count: LIMIT,
        }),
      )
      const [honest, honestN] = time(() =>
        bot.findBlocks({
          matching: (b) => b !== null && names.has(b.name),
          useExtraInfo: (b) => isExposed(bot, b) && bot.canSeeBlock(b),
          maxDistance: radius,
          count: LIMIT,
        }),
      )
      console.log(
        `  ${label.padEnd(14)} r=${String(radius).padStart(2)}  ` +
          `baseline ${base.toFixed(1).padStart(7)}ms (${baseN} hits)   ` +
          `honest ${honest.toFixed(1).padStart(7)}ms (${honestN} hits)`,
      )
    }
  }
  console.log('')
}

/**
 * What is actually visible from a dev-server spawn, for the block names the
 * contract suite's `expectFindable` relies on.
 *
 * That fixture exists so the suite's findBlocks assertions are not vacuous, and
 * honest perception threatens it: a name that is abundant but always buried goes
 * from "reliably found" to "reliably empty". Spawn position varies between runs
 * (CLAUDE.md), so this is run repeatedly and reports the WORST case — a fixture
 * that holds only at a lucky spawn is not a fixture.
 */
async function spawnCensus(): Promise<void> {
  const NAMES = [
    // The four the contract suite currently declares.
    'stone',
    'dirt',
    'grass_block',
    'deepslate',
    // Plausible surface alternatives, for re-grounding the list.
    'sand',
    'gravel',
    'water',
    'oak_log',
    'birch_log',
    'short_grass',
    'sandstone',
    'snow',
    'terracotta',
  ]
  const rounds = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 3)
  const worst = new Map<string, { total: number; exposed: number; visible: number }>()

  for (let round = 1; round <= rounds; round++) {
    const username = `SpawnCensus${round}`
    const executor = new MineflayerExecutor({ username })
    const connected = await executor.connect()
    if (!connected.ok) {
      console.error(`round ${round}: could not connect: ${connected.reason}`)
      process.exit(1)
    }
    try {
      const bot = (executor as unknown as { bot: Bot | null }).bot
      if (bot === null) throw new Error('connected but no bot')
      const at = bot.entity.position
      console.log(
        `round ${round}: spawned at (${at.x.toFixed(0)}, ${at.y.toFixed(0)}, ${at.z.toFixed(0)})`,
      )
      for (const name of NAMES) {
        const c = census(bot, new Set([name]))
        const prev = worst.get(name)
        // Worst case across rounds, per column: the fixture must hold at the
        // unluckiest spawn, not the luckiest.
        worst.set(name, {
          total: Math.min(prev?.total ?? Infinity, c.total),
          exposed: Math.min(prev?.exposed ?? Infinity, c.exposed),
          visible: Math.min(prev?.visible ?? Infinity, c.visible),
        })
        console.log(
          `    ${name.padEnd(12)} total=${String(c.total).padStart(6)}  ` +
            `exposed=${String(c.exposed).padStart(5)}  visible=${String(c.visible).padStart(4)}`,
        )
      }
    } finally {
      await executor.disconnect()
      await sleep(1_000)
    }
  }

  console.log(`\n=== worst case across ${rounds} spawns, r=${MAX_DISTANCE} ===`)
  for (const [name, c] of [...worst.entries()].sort((a, b) => b[1].visible - a[1].visible)) {
    const verdict =
      c.visible > 0 ? 'USABLE' : c.total > 0 ? 'present but never visible' : 'absent'
    console.log(
      `  ${name.padEnd(12)} total=${String(c.total).padStart(6)}  ` +
        `exposed=${String(c.exposed).padStart(5)}  visible=${String(c.visible).padStart(4)}  ${verdict}`,
    )
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--spawn')) {
    await spawnCensus()
    return
  }

  const reps = Number(process.argv[2] ?? 5)
  if (!Number.isFinite(reps) || reps < 1) {
    console.error('usage: npm run bench:perception -- [reps] [--detail] | -- --spawn [rounds]')
    process.exit(2)
  }

  const fixture = readFixture()
  mc(`forceload add ${forceloadArgs(fixtureRegion(fixture))}`)
  await sleep(2_000)

  // Place the fixture markers, so `emerald_block` measures the "a few, and
  // genuinely visible" case rather than an empty result.
  for (const o of fixture.ore) mc(`setblock ${o.x} ${o.y} ${o.z} ${o.block}`)
  await sleep(1_500)

  const username = 'PerceptBench'
  const executor = new MineflayerExecutor({ username })
  const connected = await executor.connect()
  if (!connected.ok) {
    console.error(`could not connect: ${connected.reason}`)
    process.exit(1)
  }

  try {
    mc(`tp ${username} ${fixture.start.x} ${fixture.start.y} ${fixture.start.z}`)
    await sleep(4_000)

    // The executor deliberately keeps its Bot private; this script measures
    // Mineflayer's own behaviour rather than the executor's, so it reaches
    // through rather than widening the executor's surface for a measurement.
    const bot = (executor as unknown as { bot: Bot | null }).bot
    if (bot === null) {
      console.error('connected but no bot — cannot measure')
      process.exit(1)
    }

    const at = bot.entity.position
    console.log(
      `standing at (${at.x.toFixed(1)}, ${at.y.toFixed(1)}, ${at.z.toFixed(1)}), ` +
        `radius ${MAX_DISTANCE}, limit ${LIMIT}, ${reps} reps\n`,
    )

    if (process.argv.includes('--detail')) detail(bot)

    const targets: ReadonlyArray<readonly [string, string[]]> = [
      ['coal_ore', ['coal_ore']],
      ['emerald_block', ['emerald_block']],
      ['stone', ['stone']],
      ['grass_block', ['grass_block']],
    ]

    for (const [label, names] of targets) {
      const set = new Set(names)
      const c = census(bot, set)
      console.log(`=== ${label} ===`)
      console.log(
        `  census: ${c.total} in volume, ${c.exposed} exposed, ${c.visible} visible ` +
          `(${c.scanned.toLocaleString()} blocks scanned by \`matching\`)`,
      )

      for (const [name, variant] of VARIANTS) {
        const times: number[] = []
        let last: VariantResult | null = null
        for (let i = 0; i < reps; i++) {
          const t0 = performance.now()
          last = variant(bot, set)
          times.push(performance.now() - t0)
        }
        const r = last!
        const nearest =
          r.positions.length > 0
            ? Math.hypot(
                r.positions[0]!.x - at.x,
                r.positions[0]!.y - at.y,
                r.positions[0]!.z - at.z,
              ).toFixed(1)
            : '-'
        console.log(
          `  ${name.padEnd(24)} ` +
            `median ${median(times).toFixed(1).padStart(8)}ms  ` +
            `min ${Math.min(...times).toFixed(1).padStart(8)}ms  ` +
            `max ${Math.max(...times).toFixed(1).padStart(8)}ms  ` +
            `returned=${String(r.positions.length).padStart(3)}  ` +
            `nearest=${nearest.padStart(5)}  ` +
            `matching=${r.counters.matchCalls.toLocaleString().padStart(10)}  ` +
            `extra=${r.counters.extraCalls.toLocaleString().padStart(6)}  ` +
            `raycasts=${r.counters.raycasts.toLocaleString().padStart(6)}`,
        )
      }
      // The shipped implementation, through the public contract method, so the
      // number quoted in the spec is the one callers actually pay rather than
      // the prototype's. Differs from `exposure+los` above only in going
      // through the executor's own adapter and BlockInfo mapping.
      const shipped: number[] = []
      let shippedHits = 0
      for (let i = 0; i < reps; i++) {
        const t0 = performance.now()
        shippedHits = executor.findBlocks({
          names: [...names],
          maxDistance: MAX_DISTANCE,
          limit: LIMIT,
        }).length
        shipped.push(performance.now() - t0)
      }
      console.log(
        `  ${'executor.findBlocks'.padEnd(24)} ` +
          `median ${median(shipped).toFixed(1).padStart(8)}ms  ` +
          `min ${Math.min(...shipped).toFixed(1).padStart(8)}ms  ` +
          `max ${Math.max(...shipped).toFixed(1).padStart(8)}ms  ` +
          `returned=${String(shippedHits).padStart(3)}   <-- SHIPPED`,
      )
      console.log('')
    }
  } finally {
    await executor.disconnect()
    await sleep(500)
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
