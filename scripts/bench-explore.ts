/**
 * Score the search, so it can be improved rather than merely pass.
 *
 * A pass/fail search cannot be made better; one with a distribution attached
 * can. Runs the same search N times from the benchmark world's fixed start and
 * reports success rate plus medians — medians rather than means, because one
 * unlucky run should not move the headline number, the same reasoning the
 * probe already uses for latency.
 *
 *   npm run bench:explore              # 10 runs against the placed fixture target
 *   npm run bench:explore -- 5         # 5 runs
 *   npm run bench:explore -- 5 --natural
 *
 * The two modes answer DIFFERENT questions, and conflating them is the trap
 * this script is shaped to avoid:
 *
 *   default   — the emerald_block targets we placed, at coordinates we know.
 *               Measures whether the search MECHANISM works on real terrain,
 *               and what it costs. The target must be a block worldgen never
 *               produces, or natural copies of it are found at the origin and
 *               the run scores perception instead of search.
 *   --natural — searching for real coal_ore instead. This is what answers
 *               design §8 risk 1 ("a horizontal spiral may simply not find
 *               coal"), and it needs no ground truth: "did it find any coal at
 *               all, and did it have to move to do it" is answerable without
 *               knowing where the coal is.
 */
import { MineflayerExecutor } from '@minebot/executor'
import { mc, sleep, readFixture, fixtureRegion, forceloadArgs } from './bench-world.js'

/** Rings at 32 and 64 around the start; the fixture target sits at 48. */
const SEARCH_RADIUS = 64
/** Generous: walking the full 64-block spiral on real terrain is ~20 waypoints. */
const BUDGET_MS = 180_000

interface RunResult {
  run: number
  ok: boolean
  reason: string | null
  found: number
  /** Which fixture ore, by bearing, or 'natural' when not one of ours. */
  which: string | null
  travelled: number
  elapsedMs: number
  searchedTo: number
  exhausted: boolean
}

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const natural = args.includes('--natural')
  const runs = Number(args.find((a) => !a.startsWith('--')) ?? 10)
  if (!Number.isFinite(runs) || runs < 1) {
    console.error('usage: npm run bench:explore -- [runs] [--natural]')
    process.exit(2)
  }

  const fixture = readFixture()
  const region = fixtureRegion(fixture)
  mc(`forceload add ${forceloadArgs(region)}`)
  await sleep(2_000)

  // The target block comes from the fixture, and must be one that does NOT
  // occur in worldgen. findBlocks has no line-of-sight: it answers from the
  // client's world model and happily returns ore encased in stone. Measured at
  // this start: 3219 natural coal_ore within 64 blocks, all buried, so a
  // coal_ore target is "found" at the origin before the bot moves and the run
  // scores perception instead of search.
  const placed = fixture.ore[0]?.block ?? 'emerald_block'
  // --natural searches for REAL coal instead of the placed marker. That is a
  // different question and needs the premise check off: coal being visible
  // from the start without moving is precisely the thing being measured.
  const target = natural ? 'coal_ore' : placed
  const oreKey = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`
  const byPosition = new Map(fixture.ore.map((o) => [oreKey(o), o.bearing ?? 'fixture']))

  console.log(
    `${runs} run(s), ${natural ? 'NATURAL coal_ore, fixture targets removed' : `fixture ${target} placed`}, ` +
      `radius ${SEARCH_RADIUS}, budget ${BUDGET_MS}ms, ` +
      `start (${fixture.start.x}, ${fixture.start.y}, ${fixture.start.z})\n`,
  )

  const results: RunResult[] = []
  for (let run = 1; run <= runs; run++) {
    // Re-place (or remove) the ore BEFORE every run, so mining or any other
    // change during a run cannot carry into the next one. This is what lets
    // the fixture score a whole find-and-mine loop rather than only the
    // looking.
    for (const o of fixture.ore) mc(`setblock ${o.x} ${o.y} ${o.z} air`)
    await sleep(800)
    if (!natural) {
      for (const o of fixture.ore) mc(`setblock ${o.x} ${o.y} ${o.z} ${o.block}`)
      await sleep(800)
    }

    const username = `BenchRun${run}`
    const executor = new MineflayerExecutor({ username })
    const connected = await executor.connect()
    if (!connected.ok) {
      console.error(`run ${run}: could not connect: ${connected.reason}`)
      process.exit(1)
    }

    try {
      mc(`tp ${username} ${fixture.start.x} ${fixture.start.y} ${fixture.start.z}`)
      await sleep(3_000)

      // The premise, checked every run rather than assumed: the search must
      // start unable to see what it is looking for, or the run measures
      // perception instead of exploration.
      const visible = natural
        ? []
        : executor.findBlocks({ names: [target], maxDistance: 32, limit: 5 })
      if (visible.length > 0) {
        console.error(
          `run ${run}: ABORTED — ${visible.length} ${target} already visible within 32 blocks ` +
            `of the start. The run would measure perception, not exploration.`,
        )
        process.exit(1)
      }

      const from = executor.getState().self.position
      const startedAt = Date.now()
      const r = await executor.exploreFor([target], SEARCH_RADIUS, { budgetMs: BUDGET_MS })
      const elapsedMs = Date.now() - startedAt

      const at = executor.getState().self.position
      const first = r.ok ? r.value.found[0] : undefined
      results.push({
        run,
        ok: r.ok,
        reason: r.ok ? null : r.reason,
        found: r.ok ? r.value.found.length : 0,
        which: first ? (byPosition.get(oreKey(first.position)) ?? 'natural') : null,
        travelled: r.ok ? r.value.travelled : NaN,
        elapsedMs,
        searchedTo: r.ok ? r.value.searchedTo : NaN,
        exhausted: r.ok ? r.value.exhausted : false,
      })
      const last = results[results.length - 1]!
      console.log(
        `  run ${String(run).padStart(2)}  ` +
          (last.ok
            ? `found=${last.found} ${(last.which ?? '-').padEnd(11)} ` +
              `travelled=${last.travelled.toFixed(1).padStart(6)}  ` +
              `elapsed=${(last.elapsedMs / 1000).toFixed(1).padStart(5)}s  ` +
              `searchedTo=${last.searchedTo.toFixed(0).padStart(3)}  ` +
              `exhausted=${last.exhausted}  ` +
              `ended at (${at.x.toFixed(0)},${at.z.toFixed(0)}) ` +
              `${Math.hypot(at.x - from.x, at.z - from.z).toFixed(0)} from start; ` +
              `hit ${first ? first.distance.toFixed(1) : '-'} away`
            : `FAILED ${last.reason}  elapsed=${(last.elapsedMs / 1000).toFixed(1)}s`),
      )
    } finally {
      await executor.disconnect()
      await sleep(1_000)
    }
  }

  const successes = results.filter((r) => r.ok && r.found > 0)
  console.log(`\n=== ${natural ? 'NATURAL coal_ore' : `FIXTURE ${target}`}, ${runs} run(s) ===`)
  console.log(`  success rate     ${successes.length}/${runs}`)
  if (successes.length > 0) {
    console.log(`  median travelled ${median(successes.map((r) => r.travelled)).toFixed(1)} blocks`)
    console.log(
      `  median elapsed   ${(median(successes.map((r) => r.elapsedMs)) / 1000).toFixed(1)}s`,
    )
    console.log(`  median searchedTo ${median(successes.map((r) => r.searchedTo)).toFixed(0)}`)
  }
  const exhausted = results.filter((r) => r.ok && r.found === 0 && r.exhausted).length
  const budgetOut = results.filter((r) => r.ok && r.found === 0 && !r.exhausted).length
  if (exhausted > 0) console.log(`  ${exhausted} run(s) exhausted the search space finding nothing`)
  if (budgetOut > 0) console.log(`  ${budgetOut} run(s) ran out of budget still searching`)
  const failed = results.filter((r) => !r.ok)
  if (failed.length > 0) {
    console.log(`  ${failed.length} run(s) FAILED: ${[...new Set(failed.map((r) => r.reason))].join(', ')}`)
  }

  if (natural) {
    console.log(
      '\nRestore the fixture before any other benchmark run:\n' +
        '  npm run bench:world -- setup',
    )
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
