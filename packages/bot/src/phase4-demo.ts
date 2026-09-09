/**
 * The Phase 4 deliverable: the model finds coal it cannot see, on real terrain,
 * by going to look for it.
 *
 *   npm run demo:phase4
 *
 * Needs the dev server and Ollama. Unlike the Phase 3 demo this does NOT build
 * an arena — the whole point is real ground with real elevation, and a flat
 * slab would prove nothing about exploration. It runs in the benchmark world,
 * whose terrain is qualified and whose ore sits at coordinates we placed and
 * therefore know exactly.
 *
 * The demo fails unless the model actually EXPLORED. Collecting coal is not
 * sufficient evidence on its own: a run that happened to start in sight of the
 * ore would collect it without the capability this phase adds ever being
 * exercised. So the step log must contain an `explore_for`.
 *
 * Why this can be asserted at all, which it could not before: measured
 * 2026-09-09, zero natural coal is visible anywhere in the search area, so the
 * bot cannot see any coal from the start and cannot stumble onto a natural
 * one; and the fixture's three targets sit on the OUTERMOST ring of the actual
 * search path, where they are found 3/3 with the search running essentially to
 * completion. Both halves are needed — the first makes the start honest, the
 * second makes success possible.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { MineflayerExecutor } from '@minebot/executor'
import { OllamaClient, SchemaDecider, renderStep } from '@minebot/agent'
import { runBotGoal } from './session.js'

const USERNAME = 'Phase4Demo'

/**
 * Enough for several `explore_for` calls plus the mine and the finish. One
 * call is bounded by ExploreOptions' 20s default, which covers roughly two
 * waypoints, and the outermost ring is 21 waypoints out — so the model has to
 * choose to keep looking, repeatedly, which is itself part of what this
 * demonstrates.
 */
const MAX_STEPS = 24

interface Fixture {
  start: { x: number; y: number; z: number }
  ore: { x: number; y: number; z: number; block: string; bearing?: string }[]
}

const fixture = JSON.parse(
  readFileSync(new URL('../../../scripts/bench-world.fixture.json', import.meta.url), 'utf8'),
) as Fixture

const mc = (command: string): void => {
  execFileSync('tmux', ['send-keys', '-t', 'mc', command, 'Enter'])
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<number> {
  // Shelled out rather than reimplemented: `bench:world setup` places the ore
  // AND proves each one landed at surface level, from its own connection. A
  // demo that placed its own ore without that check could fail for a fixture
  // that silently no-opped and report it as the model's fault.
  console.log('placing and verifying the benchmark fixture…')
  try {
    execFileSync('npm', ['run', 'bench:world', '--', 'setup'], { stdio: 'inherit' })
  } catch {
    console.error('FAIL: the benchmark fixture could not be placed')
    return 1
  }

  const executor = new MineflayerExecutor({ username: USERNAME })
  console.log('\nconnecting…')
  const connected = await executor.connect()
  if (!connected.ok) {
    console.error(`FAIL: could not connect — ${connected.reason}: ${connected.detail}`)
    return 1
  }

  const { start } = fixture
  mc(`tp ${USERNAME} ${start.x} ${start.y} ${start.z}`)
  mc(`clear ${USERNAME}`)
  mc(`give ${USERNAME} stone_pickaxe 1`)
  // Drops are entities, so a coal left lying by an earlier run would be
  // collected by this one and read as a success it did not earn.
  mc(`kill @e[type=item,x=${start.x},y=${start.y},z=${start.z},distance=..120]`)
  await sleep(3_000)

  // The premise, checked rather than assumed: the run must START unable to see
  // any coal, or it measures perception instead of exploration.
  const visibleAtStart = executor.findBlocks({
    names: ['coal_ore'],
    maxDistance: 32,
    limit: 5,
  })
  if (visibleAtStart.length > 0) {
    console.error(
      `FAIL: ${visibleAtStart.length} coal_ore already visible from the start — ` +
        `this run would measure perception, not exploration.`,
    )
    await executor.disconnect()
    return 1
  }
  console.log('premise OK: no coal visible from the start.\n')

  const llm = new OllamaClient()
  console.log(`asking ${process.env['MINEBOT_MODEL'] ?? 'qwen3:14b'} for decisions…\n`)

  const outcome = await runBotGoal('get me some coal', {
    executor,
    decider: new SchemaDecider(llm),
    maxSteps: MAX_STEPS,
  })

  console.log('Step log:')
  for (const step of outcome.steps) console.log(`  ${renderStep(step)}`)
  console.log(`\nOutcome: ${outcome.status}`)
  console.log(
    outcome.status === 'done' ? `Summary: ${outcome.summary}` : `Detail: ${outcome.detail}`,
  )

  const explored = outcome.steps.filter((s) => s.action?.action === 'explore_for').length
  console.log(`explore_for steps: ${explored}`)

  // Verified from a fresh connection as the SAME username, for the reason the
  // Phase 3 demo records: the goal has disconnected its bot, and offline-mode
  // player data persists, so this is the same inventory.
  const check = new MineflayerExecutor({ username: USERNAME })
  try {
    if (!(await check.connect()).ok) {
      console.error('FAIL: could not reconnect to verify the result')
      return 1
    }
    const coal = check.getState().self.inventory.find((i) => i.name === 'coal')
    console.log(`verification: coal x${coal?.count ?? 0}`)

    if (explored === 0) {
      console.error(
        'FAIL: the model never called explore_for. Whatever else happened, the ' +
          'capability this phase adds was not exercised.',
      )
      return 1
    }
    if (outcome.status !== 'done') {
      console.error(`FAIL: the goal ended ${outcome.status}`)
      return 1
    }
    if (!coal) {
      console.error('FAIL: the model reported done, but no coal reached the inventory')
      return 1
    }
  } finally {
    await check.disconnect()
  }

  console.log(
    `\nDONE: no coal was visible from the start; the model explored (${explored} call(s)), ` +
      `found ore it could not originally see, mined it, and collected the drop.`,
  )
  return 0
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error('FAIL:', e instanceof Error ? e.message : String(e))
    process.exit(1)
  },
)
