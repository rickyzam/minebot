/**
 * The benchmark world: a fixed region of REAL terrain with ore at coordinates
 * we place and therefore know exactly.
 *
 * Natural ore cannot be ground truth, because finding out where it is means
 * solving the problem under test. Placing it ourselves gives exact ground truth
 * while keeping real terrain underfoot — and because setup re-places the ore
 * before every run, mining during a run does not rot the fixture.
 *
 *   npm run bench:world -- qualify 3000 3000   # is this region usable?
 *   npm run bench:world -- setup               # place the ore
 *   npm run bench:world -- verify              # terrain and ore still as recorded
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { Bot } from 'mineflayer'
import { MineflayerExecutor } from '@minebot/executor'

/**
 * Ground truth about the terrain, deliberately BYPASSING the bot's perception.
 *
 * `executor.findBlocks` answers "what can the bot see from here", which is the
 * right question for a bot and the wrong one for a surveyor. This file measures
 * what the world IS — where the surface sits, whether the region is wet, and
 * whether a `setblock` actually landed. A block encased in rock still has to
 * count when the question is "did the command take effect".
 *
 * It is also the difference between working and not. MEASURED 2026-09-09 at the
 * benchmark region, `maxDistance: 105`, `limit: 60000`:
 *
 *   perception  4896ms, 2088 hits
 *   raw           99ms, 60000 hits
 *
 * `surfaceProfile` issues four such queries, so going through perception spent
 * ~20 SECONDS blocking the event loop. Mineflayer answers keepalives on that
 * same loop, so the server dropped the scanner mid-scan and `bench:world setup`
 * died with EPIPE. Nothing caught it because `bench:world` is in neither
 * `npm test` nor the integration suite.
 *
 * This is not a licence to route around perception elsewhere. The bot's own
 * knowledge, and anything memory is written from, must come through
 * `findBlocks` — see the line-of-sight spec §10. A diagnostic surveyor is not
 * the bot.
 */
export function surveyBlocks(
  executor: MineflayerExecutor,
  names: readonly string[],
  maxDistance: number,
  limit: number,
): { name: string; position: { x: number; y: number; z: number } }[] {
  const bot = (executor as unknown as { bot: Bot | null }).bot
  if (bot === null) throw new Error('surveyBlocks: executor is not connected')
  const wanted = new Set(names)
  return bot
    .findBlocks({
      matching: (b) => b !== null && wanted.has(b.name),
      maxDistance,
      count: limit,
    })
    .map((p) => ({
      name: bot.blockAt(p, false)?.name ?? 'unknown',
      position: { x: p.x, y: p.y, z: p.z },
    }))
}

/**
 * Gentle biomes only. Jungle, swamp, ocean and mountain variants are excluded
 * deliberately: canopy, water and cliffs would dominate the measurement with
 * the bot's one-block-short parkour reach rather than test the search.
 */
const ALLOWED_BIOMES = [
  'minecraft:plains',
  'minecraft:sunflower_plains',
  'minecraft:forest',
  'minecraft:birch_forest',
  'minecraft:savanna',
  'minecraft:savanna_plateau',
  'minecraft:taiga',
  'minecraft:snowy_taiga',
  'minecraft:meadow',
  'minecraft:snowy_plains',
]

/**
 * Blocks that mark the TOP of a column and essentially never occur in bulk
 * underground.
 *
 * This list is load-bearing and deliberately narrow, for two measured reasons.
 *
 * `findBlocks` is nearest-first with a hard `limit`, so including `stone` or
 * `dirt` — which fill the volume below the surface — would return thousands of
 * underground blocks from a few metres away and truncate before reaching the
 * edge of the region. The profile would then look perfectly flat because it
 * only ever saw the bot's own feet. Surface markers keep the result count
 * proportional to the region's AREA rather than its volume.
 *
 * Every entry here also needs light to generate, so none of them appears deep
 * underground. `sand`, `moss_block` and `terracotta` were dropped after they
 * did: cave and lakebed exposures pulled the measured height range at
 * (3000,3000) down to y=27 and reported a 71-block range for terrain whose
 * actual surface is nowhere near that varied.
 */
const SURFACE_MARKERS = [
  'grass_block',
  'podzol',
  'coarse_dirt',
  'mycelium',
  'snow_block',
]

/**
 * Ground cover used ONLY to answer "did this tile stream at all", never to
 * measure height.
 *
 * Beaches and gravel patches otherwise read as terrain nobody saw, and a good
 * region gets rejected for a coverage failure it does not have. But these
 * genuinely do occur underground: folding them into the height profile pulled
 * measured surfaces at (2500,2500) down to y=-35 and invented a 99-block
 * "step" out of a cave pocket. Coverage and elevation are different questions
 * and need different evidence.
 */
const COVERAGE_MARKERS = [...SURFACE_MARKERS, 'sand', 'red_sand', 'gravel', 'snow']

/** Fluids disqualify a region outright: swimming and boats are not this phase's problem. */
const FLUIDS = ['water', 'lava']

/**
 * Biomes probed only to NAME a rejection. Knowing a region failed because its
 * edge is river rather than ocean is the difference between "shift 100 blocks"
 * and "abandon this area", and a verdict that just says "unknown" makes the
 * next candidate a guess.
 */
const DIAGNOSTIC_BIOMES = [
  'minecraft:river',
  'minecraft:beach',
  'minecraft:ocean',
  'minecraft:deep_ocean',
  'minecraft:cold_ocean',
  'minecraft:lukewarm_ocean',
  'minecraft:swamp',
  'minecraft:desert',
  'minecraft:jungle',
  'minecraft:dark_forest',
  'minecraft:old_growth_birch_forest',
  'minecraft:old_growth_pine_taiga',
  'minecraft:windswept_hills',
  'minecraft:windswept_forest',
  'minecraft:stony_shore',
  'minecraft:frozen_river',
  'minecraft:snowy_beach',
  'minecraft:badlands',
  'minecraft:cherry_grove',
  'minecraft:grove',
]

/**
 * What actually stops the bot is LOCAL steepness, not total elevation change.
 *
 * The design's first cut was "surface height range within the region <= 8
 * blocks", on the reasoning that cliffs and peaks would let the bot's
 * one-block-short parkour reach dominate the measurement. Measured against
 * real terrain, that criterion rejects the wrong regions: (2800,2200) is
 * unbroken plains, dry, fully loaded, and was rejected for a 50-block range
 * that is a gentle slope the bot walks up without noticing — while the
 * genuinely awkward terrain is a 3-block step it has to path around.
 *
 * So the gate is the step between ADJACENT columns. The pathfinder climbs a
 * 1-block rise as a normal move; a 2-block step needs a detour, and a wall of
 * them is impassable. Regions are accepted when such steps are rare rather
 * than absent, because real terrain always has a few and demanding zero would
 * only ever accept a flat slab — the thing §5 says is not worth measuring on.
 */
const MAX_ROUGH_FRACTION = 0.02
/** How far the terrain profile may drift before verify calls it terraformed. */
const PROFILE_DRIFT_TOLERANCE = 2
/**
 * How far an ore may sit from its column's measured surface. Placing the ore
 * replaces the surface block itself, so 1 covers the legitimate case and
 * anything larger is ore the horizontal search could never reach.
 */
const ORE_SURFACE_TOLERANCE = 1
/** Fraction of 16x16 tiles that must yield at least one sample. See the criterion. */
const MIN_TILE_COVERAGE = 0.98
/** Hard ceiling on findBlocks results. Hitting it means the scan truncated. */
const SCAN_LIMIT = 60_000

const TMUX_SESSION = 'mc'

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Send one line to the server console. Fails loudly rather than silently
 * no-opping — a qualification that quietly skipped its own biome check would
 * report a verdict it never actually measured.
 */
export function mc(command: string): void {
  try {
    execFileSync('tmux', ['has-session', '-t', TMUX_SESSION], { stdio: 'ignore' })
  } catch {
    throw new Error(
      `bench-world: tmux session "${TMUX_SESSION}" is not reachable, so "${command}" ` +
        `cannot be sent to the server console. Refusing to continue with an ` +
        `unverified world.`,
    )
  }
  execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION, command, 'Enter'])
}

/** The console pane plus scrollback — a batch of probes overflows one screen. */
const pane = (): string =>
  execFileSync('tmux', ['capture-pane', '-t', TMUX_SESSION, '-p', '-S', '-400']).toString()

/**
 * The marker a `say` actually prints, as opposed to the command that asked for
 * it.
 *
 * MEASURED: `say X` prints `[13:05:17] [Server thread/INFO]: [Not Secure]
 * [Server] X`. Searching the pane for a bare `X` matches the ECHO of the
 * command line that contains `run say X`, so every biome probe returned true
 * for whichever biome was tried first — which is why ungenerated ocean at
 * (-3000,-3000) confidently reported "plains". Anchoring on the `[Server] `
 * prefix is what makes the probe honest, since the echoed command never
 * contains it.
 */
const sayMarker = (tag: string): string => `[Server] ${tag}`

/**
 * Ask the server which allowlisted biome a point is in, if any.
 *
 * `/execute if biome` is a definitive server-side check; the bot's own client
 * biome data is not exposed through the executor and would be a second source
 * of truth anyway.
 */
async function probeBiomes(
  x: number,
  y: number,
  z: number,
  candidates: readonly string[],
): Promise<string | null> {
  // All probes at once, then one read. Sequential probe-and-read costs 350ms
  // per biome, and scouting a grid needs hundreds of points.
  //
  // Nonced per probe so a tag from an earlier run still in the scrollback
  // cannot be mistaken for this one's answer.
  const tags = candidates.map((biome) => ({
    biome,
    tag: `BENCHBIOME_${Math.random().toString(36).slice(2, 10)}`,
  }))
  for (const { biome, tag } of tags) {
    mc(`execute if biome ${x} ${y} ${z} ${biome} run say ${tag}`)
  }
  await sleep(600)
  const output = pane()
  return tags.find(({ tag }) => output.includes(sayMarker(tag)))?.biome ?? null
}

const biomeAt = (x: number, y: number, z: number): Promise<string | null> =>
  probeBiomes(x, y, z, ALLOWED_BIOMES)

/** Allowlisted biome, or the name of why it was rejected, or a bare 'unknown'. */
async function biomeOrReason(x: number, y: number, z: number): Promise<string> {
  const allowed = await biomeAt(x, y, z)
  if (allowed !== null) return allowed.replace('minecraft:', '')
  const actual = await probeBiomes(x, y, z, DIAGNOSTIC_BIOMES)
  return actual === null ? 'REJECTED/unknown' : `REJECTED/${actual.replace('minecraft:', '')}`
}

export interface Region {
  x: number
  z: number
  radius: number
}

interface Profile {
  /** Highest surface-marker block per column, keyed "x,z". Heights and roughness. */
  top: Map<string, number>
  /** Columns with ANY ground cover, including secondary. Coverage only. */
  anyGround: Map<string, number>
  /** True when findBlocks returned exactly its limit — the scan was truncated. */
  truncated: boolean
  /** True when the FLUID scan truncated, which makes its count a floor, not a total. */
  fluidsTruncated: boolean
  /** Fluid blocks at surface level in the region. */
  fluids: number
}

/** How many 16x16 tiles the region spans. */
const tileCount = (region: Region): number => Math.ceil((region.radius * 2 + 1) / 16) ** 2

/**
 * How many distinct 16x16 tiles produced at least one surface sample.
 *
 * The honest test of "did the client actually stream this region": a tile with
 * no samples at all is terrain nobody looked at, which is a different and much
 * more dangerous thing than a column whose surface happens not to be grass.
 */
function sampledTiles(top: Map<string, number>): number {
  const seen = new Set<string>()
  for (const key of top.keys()) {
    const [x, z] = key.split(',').map(Number) as [number, number]
    seen.add(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)
  }
  return seen.size
}

interface Roughness {
  /** Adjacent-column pairs compared. */
  pairs: number
  /** Pairs whose height differs by 2 or more — a step the bot must path around. */
  rough: number
  /** The worst single step found, in blocks. */
  worst: number
}

/**
 * How steep the terrain is between neighbouring columns.
 *
 * Only compares columns that are ACTUALLY adjacent and both sampled, so an
 * unsampled gap (water, a beach, a chunk that never streamed) is skipped
 * rather than silently reported as a cliff.
 */
function roughness(top: Map<string, number>): Roughness {
  let pairs = 0
  let rough = 0
  let worst = 0
  for (const [key, y] of top) {
    const [x, z] = key.split(',').map(Number) as [number, number]
    for (const neighbour of [`${x + 1},${z}`, `${x},${z + 1}`]) {
      const other = top.get(neighbour)
      if (other === undefined) continue
      const step = Math.abs(other - y)
      pairs += 1
      if (step >= 2) rough += 1
      if (step > worst) worst = step
    }
  }
  return { pairs, rough, worst }
}

/** Value at the given percentile of a sorted-ascending copy of `xs`. */
function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!
}

/**
 * Highest surface block per column, from what the bot can actually see.
 *
 * Reads the world through a real bot on purpose: it reports what is loaded and
 * visible to a CLIENT, which is exactly what the search under test will have
 * to work with.
 */
function surfaceProfile(
  executor: MineflayerExecutor,
  region: Region,
  verticalAllowance = 48,
): Profile {
  // The region is a square; findBlocks searches a SPHERE, in three dimensions.
  // Reaching only to the horizontal corner silently drops them once the
  // scanner is any distance above the ground — hovering at y=160 over a
  // surface at y=76 put the corners 123 blocks away inside a 92-block sphere,
  // which read as "16% of tiles never streamed" when the chunks were fine.
  const reach =
    Math.ceil(Math.hypot(region.radius * Math.SQRT2, verticalAllowance)) + 2
  const inRegion = (p: { x: number; z: number }): boolean =>
    Math.abs(p.x - region.x) <= region.radius && Math.abs(p.z - region.z) <= region.radius

  const highestPerColumn = (names: readonly string[]): Map<string, number> => {
    const out = new Map<string, number>()
    for (const b of surveyBlocks(executor, names, reach, SCAN_LIMIT)) {
      if (!inRegion(b.position)) continue
      const key = `${b.position.x},${b.position.z}`
      const seen = out.get(key)
      if (seen === undefined || b.position.y > seen) out.set(key, b.position.y)
    }
    return out
  }

  const surfaces = surveyBlocks(executor, SURFACE_MARKERS, reach, SCAN_LIMIT)
  const top = new Map<string, number>()
  for (const b of surfaces) {
    if (!inRegion(b.position)) continue
    const key = `${b.position.x},${b.position.z}`
    const seen = top.get(key)
    if (seen === undefined || b.position.y > seen) top.set(key, b.position.y)
  }
  const anyGround = highestPerColumn(COVERAGE_MARKERS)

  // Only fluids at SURFACE level disqualify a region. Counting every water
  // block in the sphere counts deep aquifers and flooded caves too, which the
  // bot will never meet — at (3000,3000) that returned the scan limit outright
  // and told us nothing about whether the surface was wet.
  const heights = [...top.values()]
  const mid = percentile(heights, 0.5)
  const allFluids = surveyBlocks(executor, FLUIDS, reach, SCAN_LIMIT)
  const fluids = allFluids.filter(
    (b) => inRegion(b.position) && b.position.y >= mid - 4 && b.position.y <= mid + 12,
  ).length

  return {
    top,
    anyGround,
    truncated: surfaces.length >= SCAN_LIMIT,
    fluidsTruncated: allFluids.length >= SCAN_LIMIT,
    fluids,
  }
}

interface Criterion {
  name: string
  ok: boolean
  detail: string
}

/** The forceload rectangle covering a region, as `x0 z0 x1 z1`. */
export const forceloadArgs = (region: Region): string =>
  `${region.x - region.radius} ${region.z - region.radius} ` +
  `${region.x + region.radius} ${region.z + region.radius}`

/**
 * Wait until the client has actually streamed the region in, rather than
 * sleeping and hoping.
 *
 * A fixed sleep reported 0 columns for terrain that had simply not generated
 * yet, and 50.8% vs 68.3% for the SAME region on two runs — a profile whose
 * completeness depends on how busy the server was is not a measurement. Polls
 * until coverage reaches the threshold or stops improving.
 */
async function awaitChunks(
  executor: MineflayerExecutor,
  region: Region,
  timeoutMs = 90_000,
): Promise<void> {
  const tiles = tileCount(region)
  const deadline = Date.now() + timeoutMs
  let best = -1
  let stalled = 0
  for (;;) {
    await sleep(3_000)
    const sampled = sampledTiles(surfaceProfile(executor, region).anyGround)
    if (sampled / tiles >= MIN_TILE_COVERAGE) return
    stalled = sampled > best ? 0 : stalled + 1
    if (sampled > best) best = sampled
    // Three polls with no new ground is as loaded as it is going to get.
    if (stalled >= 3 || Date.now() >= deadline) return
  }
}

async function qualifyOne(executor: MineflayerExecutor, region: Region): Promise<boolean> {
  // forceload first: it makes the server GENERATE and keep the chunks, which
  // is what lets the client stream them at all. A ±96 region is 12x12 = 144
  // chunks, inside the 256-chunk forceload cap.
  mc(`forceload add ${forceloadArgs(region)}`)
  try {
    // Two passes. The first hovers high to find roughly where the ground is;
    // the second drops to just above it so the whole region fits inside
    // findBlocks' sphere. A single high pass measures the middle of the region
    // and guesses at its corners.
    mc(`tp BenchScan ${region.x} 160 ${region.z}`)
    await awaitChunks(executor, region)
    const coarse = surfaceProfile(executor, region, 120)
    const groundish = percentile([...coarse.top.values()], 0.5) || 70
    mc(`tp BenchScan ${region.x} ${groundish + 12} ${region.z}`)
    await awaitChunks(executor, region)

    const profile = surfaceProfile(executor, region)
    const heights = [...profile.top.values()]
    const columns = (region.radius * 2 + 1) ** 2
    const coverage = profile.top.size / columns

    const tiles = tileCount(region)
    const tileCoverage = sampledTiles(profile.anyGround) / tiles
    const min = heights.length > 0 ? Math.min(...heights) : 0
    const max = heights.length > 0 ? Math.max(...heights) : 0
    const range = max - min
    const rough = roughness(profile.top)

    // Biome at the centre and at four points near the edges, so a region
    // straddling a boundary is caught rather than judged by its middle alone.
    const r = Math.floor(region.radius * 0.7)
    const samplePoints: Array<[number, number]> = [
      [region.x, region.z],
      [region.x + r, region.z],
      [region.x - r, region.z],
      [region.x, region.z + r],
      [region.x, region.z - r],
    ]
    const biomes: string[] = []
    for (const [x, z] of samplePoints) {
      // 70 rather than (min+max)/2: with no surface found at all, that average
      // is 0, and a biome probe at bedrock level answers about caves.
      const fallbackY = heights.length > 0 ? Math.round((min + max) / 2) : 70
      const y = profile.top.get(`${x},${z}`) ?? fallbackY
      biomes.push(await biomeOrReason(x, y, z))
    }
    const rejectedBiome = biomes.some((b) => b.startsWith('REJECTED'))

    const criteria: Criterion[] = [
      {
        name: 'scan not truncated',
        ok: !profile.truncated,
        detail: profile.truncated
          ? `findBlocks returned its ${SCAN_LIMIT} limit — the profile is a fragment, not the region`
          : `${profile.top.size} columns sampled`,
      },
      {
        // Per-TILE, not per-column. Raw column coverage conflates two very
        // different things: a chunk that never streamed (dangerous — terrain we
        // have not measured) and a column whose surface simply is not grass
        // (harmless — sand, gravel, stone). Requiring 80% of columns rejected
        // regions that had streamed perfectly well. Asking instead whether
        // every 16x16 tile produced at least one sample separates them: a tile
        // with no samples at all is a tile we never saw.
        name: 'every tile streamed',
        ok: tileCoverage >= MIN_TILE_COVERAGE,
        detail:
          `${(tileCoverage * 100).toFixed(1)}% of ${tiles} 16x16 tiles sampled ` +
          `(need ${(MIN_TILE_COVERAGE * 100).toFixed(0)}%); ` +
          `${(coverage * 100).toFixed(1)}% of ${columns} columns are grass-topped`,
      },
      {
        name: `walkable: <${(MAX_ROUGH_FRACTION * 100).toFixed(0)}% of steps >= 2 blocks`,
        ok: rough.pairs > 0 && rough.rough / rough.pairs < MAX_ROUGH_FRACTION,
        detail:
          rough.pairs > 0
            ? `${((rough.rough / rough.pairs) * 100).toFixed(2)}% of ${rough.pairs} ` +
              `adjacent pairs step >= 2 (worst single step ${rough.worst})`
            : 'no adjacent columns to compare',
      },
      {
        // Reported, not gated — see MAX_ROUGH_FRACTION. Percentiles alongside
        // the absolute range so a stray column reads differently from a cliff.
        name: 'elevation profile (informational)',
        ok: heights.length > 0,
        detail:
          heights.length > 0
            ? `y ${min}..${max} (range ${range}); p2=${percentile(heights, 0.02)} ` +
              `p50=${percentile(heights, 0.5)} p98=${percentile(heights, 0.98)}`
            : 'no surface found',
      },
      {
        name: 'biome on the allowlist, everywhere sampled',
        ok: !rejectedBiome,
        detail: samplePoints
          .map(([x, z], i) => `(${x},${z})=${biomes[i] ?? 'REJECTED/unknown'}`)
          .join(' '),
      },
      {
        // Truncation is reported but not fatal. Underground aquifers fill the
        // scan sphere and swamp the limit, while what matters is water the bot
        // would WALK INTO — and a lake big enough to matter also blanks the
        // tiles under it, which the tile criterion above already catches.
        name: 'no surface water or lava',
        ok: profile.fluids === 0,
        detail:
          `${profile.fluids} fluid block(s) at surface level` +
          (profile.fluidsTruncated
            ? ` (scan hit its ${SCAN_LIMIT} limit on underground fluid, so distant ` +
              `surface water is covered by the tile check rather than this count)`
            : ''),
      },
    ]

    console.log(`\nRegion (${region.x}, ${region.z}) radius ${region.radius}:`)
    for (const c of criteria) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`)

    const accepted = criteria.every((c) => c.ok)
    if (accepted) {
      console.log(
        `\nVERDICT: ACCEPTED. surface y ${min}..${max} (range ${range}), biome ${biomes[0]}`,
      )
    } else {
      const failed = criteria.filter((c) => !c.ok).map((c) => c.name)
      console.log(`\nVERDICT: REJECTED — ${failed.join('; ')}`)
    }
    return accepted
  } finally {
    // Leave no trace: a rejected candidate must not keep 144 chunks resident
    // on a server other people use. The accepted region gets its own permanent
    // forceload from `setup`.
    mc(`forceload remove ${forceloadArgs(region)}`)
  }
}

/**
 * Qualify each candidate in turn, over ONE connection. Reconnecting per
 * candidate costs ~15s of handshake and chunk-wait before any measurement
 * happens, and finding a usable region is genuine search — the plan expects
 * several rejections before an acceptance.
 */
async function qualify(regions: readonly Region[]): Promise<void> {
  const executor = new MineflayerExecutor({ username: 'BenchScan' })
  const connected = await executor.connect()
  if (!connected.ok) {
    console.error(`could not connect: ${connected.reason}: ${connected.detail}`)
    process.exit(1)
  }

  const accepted: Region[] = []
  try {
    // Spectator so the scanner cannot die on the way in, cannot take fall
    // damage from being dropped above unknown terrain, and cannot disturb the
    // very terrain it is here to measure.
    mc('gamemode spectator BenchScan')
    await sleep(500)
    for (const region of regions) {
      if (await qualifyOne(executor, region)) accepted.push(region)
    }
  } finally {
    mc('gamemode survival BenchScan')
    await executor.disconnect()
  }

  console.log(`\n=== ${accepted.length} of ${regions.length} candidate(s) accepted ===`)
  for (const r of accepted) console.log(`  (${r.x}, ${r.z}) radius ${r.radius}`)
  process.exitCode = accepted.length > 0 ? 0 : 1
}

/**
 * Cheap biome-only sweep, to decide WHERE to spend the expensive scan.
 *
 * Qualifying one region costs a forceload, a teleport and up to 90s of chunk
 * streaming. A biome probe costs ~0.6s and needs no bot at all, so sweeping a
 * grid first turns "hunt for a gentle region" from hours into minutes. A point
 * that fails here can never pass qualify; one that passes still has to.
 */
async function scout(
  origin: { x: number; z: number },
  span: number,
  step: number,
  radius: number,
): Promise<void> {
  const points: Array<{ x: number; z: number }> = []
  for (let dx = -span; dx <= span; dx += step) {
    for (let dz = -span; dz <= span; dz += step) {
      points.push({ x: origin.x + dx, z: origin.z + dz })
    }
  }

  const hits: Array<{ x: number; z: number; biome: string }> = []
  // MEASURED: `execute if biome` (and `if block`) silently fail on an UNLOADED
  // chunk — no output, indistinguishable from "condition false". With no
  // player online nothing is loaded, so a botless sweep reported 0 hits over
  // 81 points of a 2400-block area. Even bedrock at y=-64 failed to match
  // until the chunk was forceloaded. So each probe point must be forceloaded
  // first; batched to stay well inside the 256-chunk forceload cap.
  const BATCH = 64
  for (let i = 0; i < points.length; i += BATCH) {
    const batch = points.slice(i, i + BATCH)
    for (const p of batch) mc(`forceload add ${p.x} ${p.z} ${p.x} ${p.z}`)
    await sleep(5_000)
    try {
      for (const p of batch) {
        const biome = await biomeAt(p.x, 70, p.z)
        if (biome !== null) {
          hits.push({ ...p, biome })
          console.log(`  HIT  (${p.x}, ${p.z}) ${biome}`)
        }
      }
    } finally {
      for (const p of batch) mc(`forceload remove ${p.x} ${p.z} ${p.x} ${p.z}`)
    }
    console.log(`  ...${Math.min(i + BATCH, points.length)}/${points.length} probed`)
  }
  const probed = points.length
  console.log(`\n${hits.length} of ${probed} probe(s) on an allowlisted biome.`)
  if (hits.length > 0) {
    const args = hits.map((h) => `${h.x} ${h.z}`).join(' ')
    console.log(`\nnpm run bench:world -- qualify --radius=${radius} ${args}`)
  }
  process.exitCode = hits.length > 0 ? 0 : 1
}

/**
 * Report the measured surface height at specific columns.
 *
 * Ore `y` in the fixture must come from the terrain, not from an assumption
 * that the region is flat — it is not, and a `setblock` a few blocks off
 * either buries the ore or leaves it floating.
 */
async function surfaceAt(region: Region, columns: ReadonlyArray<[number, number]>): Promise<void> {
  const executor = new MineflayerExecutor({ username: 'BenchScan' })
  const connected = await executor.connect()
  if (!connected.ok) {
    console.error(`could not connect: ${connected.reason}: ${connected.detail}`)
    process.exit(1)
  }
  mc(`forceload add ${forceloadArgs(region)}`)
  try {
    mc('gamemode spectator BenchScan')
    await sleep(500)
    mc(`tp BenchScan ${region.x} 160 ${region.z}`)
    await awaitChunks(executor, region)
    const coarse = surfaceProfile(executor, region, 120)
    const groundish = percentile([...coarse.top.values()], 0.5) || 70
    mc(`tp BenchScan ${region.x} ${groundish + 12} ${region.z}`)
    await awaitChunks(executor, region)
    const profile = surfaceProfile(executor, region)

    for (const [x, z] of columns) {
      const y = profile.top.get(`${x},${z}`)
      const distance = Math.hypot(x - region.x, z - region.z).toFixed(1)
      console.log(
        y === undefined
          ? `  (${x}, ${z})  NO SURFACE MEASURED — not grass-topped, pick another column`
          : `  (${x}, ${z})  surface y=${y}  ${distance} blocks from centre`,
      )
    }
  } finally {
    mc('gamemode survival BenchScan')
    mc(`forceload remove ${forceloadArgs(region)}`)
    await executor.disconnect()
  }
}

interface OreSpec {
  x: number
  y: number
  z: number
  block: string
  /** Human label for reports — which direction from the start this ore lies. */
  bearing?: string
  /** The column's measured surface height when the fixture was written. */
  surfaceY?: number
}

export interface BenchFixture {
  verifiedOn: string
  biome: string
  radius: number
  start: { x: number; y: number; z: number }
  surface: { min: number; max: number; range: number; p2: number; p50: number; p98: number }
  walkability: { roughFraction: number; worstStep: number; pairs: number }
  ore: OreSpec[]
}

const FIXTURE_PATH = new URL('./bench-world.fixture.json', import.meta.url)

export const readFixture = (): BenchFixture =>
  JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as BenchFixture

export const fixtureRegion = (f: BenchFixture): Region => ({
  x: f.start.x,
  z: f.start.z,
  radius: f.radius,
})

/**
 * Open a scanner on the fixture's region, positioned so the whole region is
 * inside findBlocks' sphere. Shared by setup's verification pass and verify.
 */
async function withScanner<T>(
  region: Region,
  body: (executor: MineflayerExecutor) => Promise<T>,
): Promise<T> {
  const executor = new MineflayerExecutor({ username: 'BenchScan' })
  const connected = await executor.connect()
  if (!connected.ok) {
    throw new Error(`could not connect: ${connected.reason}: ${connected.detail}`)
  }
  mc(`forceload add ${forceloadArgs(region)}`)
  try {
    mc('gamemode spectator BenchScan')
    await sleep(500)
    mc(`tp BenchScan ${region.x} 160 ${region.z}`)
    await awaitChunks(executor, region)
    const coarse = surfaceProfile(executor, region, 120)
    const groundish = percentile([...coarse.top.values()], 0.5) || 70
    mc(`tp BenchScan ${region.x} ${groundish + 12} ${region.z}`)
    await awaitChunks(executor, region)
    return await body(executor)
  } finally {
    mc('gamemode survival BenchScan')
    await executor.disconnect()
  }
}

/**
 * The surface height at a column, falling back to its neighbours.
 *
 * A column directly under a placed ore has no marker of its own: Minecraft
 * turns a covered `grass_block` into `dirt`, so the very block the profile is
 * measured from dies as soon as the fixture is set up. Reading the neighbours
 * keeps the reachability check a real measurement of the world instead of a
 * check that passes only on the first run and fails on every one after.
 */
function surfaceNear(top: Map<string, number>, x: number, z: number): number | undefined {
  const own = top.get(`${x},${z}`)
  if (own !== undefined) return own
  const nearby: number[] = []
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const y = top.get(`${x + dx},${z + dz}`)
      if (y !== undefined) nearby.push(y)
    }
  }
  return nearby.length === 0 ? undefined : percentile(nearby, 0.5)
}

/** Which fixture ore the bot can actually see in the world right now. */
function missingOre(executor: MineflayerExecutor, fixture: BenchFixture): OreSpec[] {
  const names = [...new Set(fixture.ore.map((o) => o.block))]
  const seen = new Set(
    surveyBlocks(executor, names, 160, SCAN_LIMIT).map(
      (b) => `${b.position.x},${b.position.y},${b.position.z}`,
    ),
  )
  return fixture.ore.filter((o) => !seen.has(`${o.x},${o.y},${o.z}`))
}

/**
 * Place the fixture's ore, idempotently, and PROVE each one landed.
 *
 * Re-placing before every run is what stops mining during a run from rotting
 * the fixture — which is what lets the benchmark score the whole find-and-mine
 * loop rather than just the looking. A setup that could silently no-op would
 * be worse than none, so this verifies from a second connection rather than
 * trusting that the commands were accepted.
 */
async function setup(): Promise<void> {
  const fixture = readFixture()
  const region = fixtureRegion(fixture)
  mc(`forceload add ${forceloadArgs(region)}`)
  await sleep(2_000)

  // Clear first, so a re-run replaces rather than accumulates, and so a stale
  // ore left at an old coordinate cannot be mistaken for a fresh placement.
  for (const o of fixture.ore) mc(`setblock ${o.x} ${o.y} ${o.z} air`)
  await sleep(1_000)
  for (const o of fixture.ore) mc(`setblock ${o.x} ${o.y} ${o.z} ${o.block}`)
  await sleep(1_500)

  const { missing, buried } = await withScanner(region, async (executor) => {
    const profile = surfaceProfile(executor, region)
    return {
      missing: missingOre(executor, fixture),
      // Existing is not the same as REACHABLE. `setblock` happily writes into
      // solid rock — an ore at y=-40 places fine and scans fine, and setup
      // called it verified. But the search is horizontal by design (§4.2), so
      // ore off the surface tests nothing except a limitation we already know
      // about. Compare each ore against the measured surface of its own
      // column rather than assuming the region is flat.
      buried: fixture.ore.filter((o) => {
        const surface = surfaceNear(profile.top, o.x, o.z)
        return surface === undefined || Math.abs(o.y - surface) > ORE_SURFACE_TOLERANCE
      }),
    }
  })

  for (const o of fixture.ore) {
    const why = missing.includes(o) ? 'FAIL (not placed)' : buried.includes(o) ? 'FAIL (off-surface)' : 'ok  '
    console.log(`  ${why}  ${o.block} at (${o.x}, ${o.y}, ${o.z})`)
  }
  if (missing.length > 0 || buried.length > 0) {
    console.error(
      `\nsetup FAILED: ${missing.length} ore did not land, ${buried.length} are not at ` +
        `surface level. A coordinate in an unloaded chunk or outside the world height ` +
        `will not place; one inside rock places but can never be found by a horizontal ` +
        `search. The fixture is NOT usable.`,
    )
    process.exit(1)
  }
  console.log(`\nsetup OK: ${fixture.ore.length} ore placed, verified, and at surface level.`)
}

/**
 * Re-measure the terrain and the ore against what the fixture recorded.
 *
 * Exists so a region someone has terraformed is DETECTED, rather than
 * surfacing later as a mysterious benchmark regression.
 */
async function verify(): Promise<void> {
  const fixture = readFixture()
  const region = fixtureRegion(fixture)
  const { profile, missing } = await withScanner(region, async (executor) => ({
    profile: surfaceProfile(executor, region),
    missing: missingOre(executor, fixture),
  }))

  const heights = [...profile.top.values()]
  const min = heights.length > 0 ? Math.min(...heights) : 0
  const max = heights.length > 0 ? Math.max(...heights) : 0
  const rough = roughness(profile.top)
  const roughFraction = rough.pairs > 0 ? rough.rough / rough.pairs : 1

  // Percentiles, not min/max. Two scans of untouched terrain differ by a
  // block or two at the extremes — a column that streamed this time and not
  // last, or one of the three grass blocks the ore itself replaced — and a
  // verify that fails on that cries wolf every run. What terraforming actually
  // moves is the bulk of the terrain, which is what p2/p50/p98 track.
  const measured = {
    p2: percentile(heights, 0.02),
    p50: percentile(heights, 0.5),
    p98: percentile(heights, 0.98),
  }
  const drift = Math.max(
    Math.abs(measured.p2 - fixture.surface.p2),
    Math.abs(measured.p50 - fixture.surface.p50),
    Math.abs(measured.p98 - fixture.surface.p98),
  )

  const checks: Criterion[] = [
    {
      name: `surface profile unchanged (within ${PROFILE_DRIFT_TOLERANCE})`,
      ok: drift <= PROFILE_DRIFT_TOLERANCE,
      detail:
        `p2=${measured.p2} p50=${measured.p50} p98=${measured.p98} ` +
        `(fixture ${fixture.surface.p2}/${fixture.surface.p50}/${fixture.surface.p98}, ` +
        `max drift ${drift}); absolute y ${min}..${max}`,
    },
    {
      name: 'still walkable',
      ok: roughFraction < MAX_ROUGH_FRACTION && rough.worst <= fixture.walkability.worstStep,
      detail:
        `${(roughFraction * 100).toFixed(2)}% rough, worst step ${rough.worst} ` +
        `(fixture recorded ${(fixture.walkability.roughFraction * 100).toFixed(2)}%, ` +
        `worst ${fixture.walkability.worstStep})`,
    },
    {
      name: 'every fixture ore present',
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? `${fixture.ore.length} of ${fixture.ore.length} found`
          : `MISSING ${missing.map((o) => `(${o.x},${o.y},${o.z})`).join(' ')} — run setup`,
    },
  ]

  console.log(`\nBenchmark world (${region.x}, ${region.z}) radius ${region.radius}:`)
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`)
  const ok = checks.every((c) => c.ok)
  console.log(ok ? '\nVERIFY: clean.' : '\nVERIFY: the world has drifted from the fixture.')
  process.exitCode = ok ? 0 : 1
}

const USAGE =
  'usage: npm run bench:world -- qualify [--radius=N] <x> <z> [<x> <z> ...]\n' +
  '       npm run bench:world -- scout [--radius=N] [--span=N] [--step=N] <x> <z>\n' +
  '       npm run bench:world -- surface [--radius=N] <cx> <cz> <x> <z> [<x> <z> ...]\n' +
  '       npm run bench:world -- setup\n' +
  '       npm run bench:world -- verify'

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'setup') {
    await setup()
    return
  }
  if (command === 'verify') {
    await verify()
    return
  }
  if (command !== 'qualify' && command !== 'scout' && command !== 'surface') {
    console.error(USAGE)
    process.exit(2)
  }

  const flag = (name: string, fallback: number): number => {
    const found = rest.find((a) => a.startsWith(`--${name}=`))
    return found ? Number(found.slice(name.length + 3)) : fallback
  }
  const radius = flag('radius', 96)
  const coords = rest.filter((a) => !a.startsWith('--')).map(Number)

  if (command === 'surface') {
    // <centreX> <centreZ> then the columns to report on.
    if (coords.length < 4 || coords.length % 2 !== 0 || coords.some((n) => !Number.isFinite(n))) {
      console.error(USAGE)
      process.exit(2)
    }
    const columns: Array<[number, number]> = []
    for (let i = 2; i < coords.length; i += 2) columns.push([coords[i]!, coords[i + 1]!])
    await surfaceAt({ x: coords[0]!, z: coords[1]!, radius }, columns)
    return
  }

  if (command === 'scout') {
    if (coords.length !== 2 || coords.some((n) => !Number.isFinite(n))) {
      console.error(USAGE)
      process.exit(2)
    }
    await scout(
      { x: coords[0]!, z: coords[1]! },
      flag('span', 1_500),
      flag('step', 250),
      radius,
    )
    return
  }

  if (!Number.isFinite(radius) || coords.length === 0 || coords.length % 2 !== 0) {
    console.error(USAGE)
    process.exit(2)
  }
  if (coords.some((n) => !Number.isFinite(n))) {
    console.error(`${USAGE}\n  (coordinates must be numbers)`)
    process.exit(2)
  }

  const regions: Region[] = []
  for (let i = 0; i < coords.length; i += 2) {
    regions.push({ x: coords[i]!, z: coords[i + 1]!, radius })
  }
  await qualify(regions)
}

// Only when run as a command. bench-explore.ts imports the fixture helpers
// above, and an unguarded main() would make that import execute a CLI.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
}
