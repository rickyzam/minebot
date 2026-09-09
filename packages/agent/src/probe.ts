/**
 * Ask a real model for one action, N times per scenario, and report how often
 * the reply decoded and what it chose. Run by hand — never part of `npm test`:
 *
 *   OLLAMA_HOST=http://192.168.1.21:11434 npm run agent:probe -- 5
 *
 * This is the only place model behaviour is measured. It reports numbers, not
 * pass/fail: at temperature 0 the model is near-deterministic, so "5/5" is
 * consistency rather than robustness, and a flaky assertion dressed as a test
 * would be worse than an honest number.
 *
 * The scenarios below are the ones design §2.1 recorded. Re-run this after ANY
 * change to the action menu or the prompt — §2.1 measured a terse menu rewrite
 * changing one turn's answer in 5 of 5 samples, and no unit test covers that.
 */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { ItemStack, Vec3, WorldSnapshot } from '@minebot/contract'
import { ok, fail } from '@minebot/contract'
import { ACTION_SCHEMA, type ActionName } from './actions.js'
import { decode } from './decide.js'
import { OllamaClient } from './ollama.js'
import { renderPrompt } from './prompt.js'
import type { Step } from './step.js'

const PICKAXE: ItemStack = { name: 'stone_pickaxe', count: 1, slot: 0 }
const COAL: ItemStack = { name: 'coal', count: 1, slot: 1 }
const COAL_AT = { x: 18, y: 60, z: -34 }

/** Where the bot starts, for every scenario that has not walked anywhere. */
const START = { x: 12, y: 64, z: -30 }

/**
 * `position` defaults to {@link START}, and a scenario whose history contains a
 * successful `move_to` MUST override it.
 *
 * MEASURED 2026-09-09: it was previously hardcoded, so the `not_found already`
 * scenario told the model "you are at (12, 64, -30)" directly above "step 3:
 * move_to(18, 60, -34) -> OK". The bot cannot both have moved there and still
 * be 8.2 blocks away, and against that state `move_to` is a defensible reading
 * rather than the rule violation the scenario is trying to catch. A fixture
 * that contradicts itself cannot tell "the model ignored a rule" from "the
 * model noticed it was not where it should be".
 */
const snapshot = (inventory: ItemStack[], position: Vec3 = START): WorldSnapshot => ({
  takenAt: Date.now(),
  self: {
    position,
    health: 20,
    food: 18,
    dimension: 'overworld',
    onGround: true,
    inventory,
    heldItem: inventory[0] ?? null,
  },
  nearbyEntities: [],
})

const step = (n: number, action: Step['action'], outcome: Step['outcome']): Step => ({
  n,
  raw: '',
  action,
  decodeError: null,
  outcome,
})

const found = step(
  1,
  { action: 'find_blocks', names: ['coal_ore'], maxDistance: 32, limit: 5 },
  { kind: 'blocks', blocks: [{ name: 'coal_ore', position: COAL_AT, distance: 7.94 }] },
)

interface Scenario {
  readonly name: string
  readonly goal: string
  readonly inventory: ItemStack[]
  readonly history: readonly Step[]
  /** Defaults to {@link START}. Required when the history moved the bot. */
  readonly position?: Vec3
  /** What a competent player would do. Reported, never asserted. */
  readonly hoped: readonly ActionName[]
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'no history',
    goal: 'get me some coal',
    inventory: [PICKAXE],
    history: [],
    hoped: ['find_blocks'],
  },
  {
    name: 'after a search',
    goal: 'get me some coal',
    inventory: [PICKAXE],
    history: [found],
    hoped: ['mine_block_at'],
  },
  {
    // The decision the whole action exists to enable. Before explore_for this
    // position had no right answer: nothing in the menu could help, so give_up
    // was correct. Now that perception is line-of-sight limited, an empty
    // find_blocks is the NORMAL result for buried ore and means "not visible
    // from here", not "not present" — so going to look is the move.
    name: 'find_blocks found nothing',
    goal: 'get me some coal',
    inventory: [PICKAXE],
    history: [
      step(
        1,
        { action: 'find_blocks', names: ['coal_ore'], maxDistance: 32, limit: 5 },
        { kind: 'blocks', blocks: [] },
      ),
    ],
    hoped: ['explore_for'],
  },
  {
    name: 'after missing_tool, inventory empty',
    goal: 'get me some coal',
    inventory: [],
    history: [
      found,
      step(
        2,
        { action: 'mine_block_at', ...COAL_AT, maxDistance: 32 },
        { kind: 'result', result: fail('missing_tool', 'no pickaxe in inventory') },
      ),
    ],
    hoped: ['give_up'],
  },
  {
    name: 'mined but the drop was lost',
    goal: 'get me some coal',
    inventory: [PICKAXE],
    history: [
      found,
      step(
        2,
        { action: 'mine_block_at', ...COAL_AT, maxDistance: 32 },
        { kind: 'result', result: ok({ position: COAL_AT, collected: false }) },
      ),
    ],
    hoped: ['move_to'],
  },
  {
    // Observed twice against the live server, in unrelated circumstances: after
    // mine_block_at came back not_found, the model mined the SAME position
    // again rather than accepting the block was gone. The block is not coming
    // back; the useful moves are to search elsewhere or give up.
    name: 'mine_block_at already returned not_found',
    goal: 'get me some coal',
    inventory: [PICKAXE],
    // Step 3 below is a SUCCESSFUL move_to, so the bot is standing here. The
    // default START would contradict its own history — see `snapshot`.
    position: COAL_AT,
    history: [
      found,
      step(
        2,
        { action: 'mine_block_at', ...COAL_AT, maxDistance: 32 },
        { kind: 'result', result: ok({ position: COAL_AT, collected: false }) },
      ),
      step(3, { action: 'move_to', ...COAL_AT }, { kind: 'result', result: ok(undefined) }),
      step(
        4,
        { action: 'mine_block_at', ...COAL_AT, maxDistance: 32 },
        {
          kind: 'result',
          result: fail('not_found', `no block at ${COAL_AT.x},${COAL_AT.y},${COAL_AT.z}`),
        },
      ),
    ],
    // Was ['find_blocks', 'give_up']. `find_blocks` stopped being a sensible
    // answer here once perception became line-of-sight limited: the bot has not
    // moved, so it would see exactly what it just saw. `explore_for` is the
    // move this position calls for; `give_up` stays acceptable because the goal
    // may genuinely be out of reach.
    hoped: ['explore_for', 'give_up'],
  },
  {
    name: 'goal met',
    goal: 'get me some coal',
    inventory: [PICKAXE, COAL],
    history: [
      found,
      step(
        2,
        { action: 'mine_block_at', ...COAL_AT, maxDistance: 32 },
        { kind: 'result', result: ok({ position: COAL_AT, collected: true }) },
      ),
    ],
    hoped: ['done'],
  },
]

const median = (xs: number[]): number =>
  xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0

/** One scenario's outcome within a single replicate. */
interface ReplicateResult {
  readonly scenario: string
  readonly chose: Record<string, number>
  readonly decoded: number
  readonly attempts: number
  readonly medianMs: number
}

/**
 * Run every scenario once, in THIS process. The unit of replication.
 */
async function runReplicate(attempts: number): Promise<ReplicateResult[]> {
  const client = new OllamaClient()
  const results: ReplicateResult[] = []

  for (const scenario of SCENARIOS) {
    const messages = renderPrompt(
      scenario.goal,
      snapshot(scenario.inventory, scenario.position),
      scenario.history,
    )
    const chose: Record<string, number> = {}
    const latencies: number[] = []
    let decoded = 0

    for (let i = 0; i < attempts; i++) {
      const started = Date.now()
      try {
        const reply = await client.chat({ messages, schema: ACTION_SCHEMA })
        latencies.push(Date.now() - started)
        const result = decode(reply)
        if (result.ok) {
          decoded += 1
          chose[result.action.action] = (chose[result.action.action] ?? 0) + 1
        } else {
          const label = `REJECTED:${result.error.kind}`
          chose[label] = (chose[label] ?? 0) + 1
        }
      } catch (e) {
        const label = `ERROR:${e instanceof Error ? e.message.slice(0, 40) : String(e)}`
        chose[label] = (chose[label] ?? 0) + 1
      }
    }
    results.push({
      scenario: scenario.name,
      chose,
      decoded,
      attempts,
      medianMs: median(latencies),
    })
  }
  return results
}

/** The single answer a replicate settled on, or null when it was split. */
const modeOf = (chose: Record<string, number>): string | null => {
  const entries = Object.entries(chose).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return null
  const [top, second] = entries
  return second && second[1] === top![1] ? null : top![0]
}

/**
 * Spawn one fresh process per replicate and aggregate.
 *
 * MEASURED 2026-09-09, and the reason this is not a simple loop: the same
 * prompt — verified byte-identical by hash — produced `give_up` in nine runs
 * and `move_to` in five others. Each run was internally unanimous, one of them
 * 40/40. So a single process's "5/5" says how that process settled, not how the
 * prompt behaves, and prompt work judged on it is unfalsifiable: three separate
 * candidate fixes for the `not_found already` scenario were each declared
 * ineffective on one-session evidence that could not support the claim.
 *
 * Replicates are separate PROCESSES rather than separate loops because that is
 * the boundary the instability was observed across; within a process the answer
 * was always stable, which is exactly what made it deceptive.
 */
async function runParent(replicates: number, attempts: number): Promise<void> {
  const client = new OllamaClient()
  console.log(
    `Probing ${client.host} with ${client.model}\n` +
      `${replicates} replicates x ${attempts} attempts, each replicate a FRESH PROCESS\n`,
  )

  const self = fileURLToPath(import.meta.url)
  const runs: ReplicateResult[][] = []
  for (let r = 1; r <= replicates; r++) {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        ['--import', 'tsx', self, '--replicate', String(attempts)],
        { env: process.env, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      )
    })
    runs.push(JSON.parse(out) as ReplicateResult[])
    process.stdout.write(`  replicate ${r}/${replicates} done\n`)
  }
  console.log('')

  let unstable = 0
  let offTarget = 0
  const allLatencies: number[] = []

  for (const [i, scenario] of SCENARIOS.entries()) {
    const perRun = runs.map((r) => r[i]!)
    for (const p of perRun) allLatencies.push(p.medianMs)
    const modes = perRun.map((p) => modeOf(p.chose))
    const tally = new Map<string, number>()
    for (const m of modes) tally.set(m ?? 'SPLIT', (tally.get(m ?? 'SPLIT') ?? 0) + 1)
    const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1])
    const agreed = ranked.length === 1 && ranked[0]![0] !== 'SPLIT'
    const winner = ranked[0]![0]
    const decoded = perRun.reduce((n, p) => n + p.decoded, 0)
    const attempted = perRun.reduce((n, p) => n + p.attempts, 0)

    console.log(`  ${scenario.name}`)
    console.log(`     hoped for: ${scenario.hoped.join(' or ')}`)
    console.log(
      `     chose:     ${ranked.map(([k, n]) => `${k} in ${n}/${replicates} replicates`).join(', ')}`,
    )
    if (!agreed) {
      unstable += 1
      console.log(
        `     ** UNSTABLE — replicates disagree on an identical prompt. Any conclusion`,
      )
      console.log(`        drawn from a single run of this scenario is unsupported.`)
    } else if (!(scenario.hoped as readonly string[]).includes(winner)) {
      offTarget += 1
      console.log(`     ** consistently off target`)
    }
    console.log(`     ${decoded}/${attempted} decoded\n`)
  }

  console.log(
    `${SCENARIOS.length - unstable - offTarget}/${SCENARIOS.length} scenarios stable and on target; ` +
      `${offTarget} stable but wrong; ${unstable} UNSTABLE.`,
  )
  console.log(`median latency ${median(allLatencies)}ms.`)
  if (unstable > 0) {
    console.log(
      '\nAn unstable scenario cannot judge a prompt change: it will "confirm" or\n' +
        '"refute" a candidate depending on which way the replicates fall. Raise the\n' +
        'replicate count before drawing any conclusion from it.',
    )
  }
}

const args = process.argv.slice(2)
if (args[0] === '--replicate') {
  // Child mode: one replicate, JSON on stdout, nothing else.
  process.stdout.write(JSON.stringify(await runReplicate(Number(args[1] ?? '5'))))
} else {
  const replicates = Number(args[0] ?? '4')
  const attempts = Number(args[1] ?? '5')
  if (!Number.isFinite(replicates) || replicates < 1 || !Number.isFinite(attempts) || attempts < 1) {
    console.error('usage: npm run agent:probe -- [replicates] [attempts]')
    process.exit(2)
  }
  await runParent(replicates, attempts)
}
