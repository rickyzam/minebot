/**
 * The Phase 3 deliverable: real game state, a real model's decision, a real
 * game action — the whole loop, once, end to end.
 *
 *   npm run demo:phase3
 *
 * Needs both the dev server and Ollama. The integration tests deliberately
 * need only the server, so if this fails while they pass, the model chose
 * badly rather than the wiring being broken.
 */
import { execFileSync } from 'node:child_process'
import { MineflayerExecutor } from '@minebot/executor'
import { OllamaClient, SchemaDecider, renderStep } from '@minebot/agent'
import { runBotGoal } from './session.js'

const USERNAME = 'Phase3Demo'
const FLOOR = 199
/**
 * Far from every test arena, and deliberately so.
 *
 * This demo first sat at x 1150-1180, twenty blocks from the integration
 * arena's 1100-1130 — and the model's own find_blocks call, which chooses its
 * own 32-block radius, reached straight back into it and returned the ore the
 * abort test leaves standing at 1126. The demo then mined its own ore, saw a
 * second one still listed, and went chasing it instead of finishing.
 *
 * Arenas must be separated by more than the largest radius anything might
 * search, not merely by more than their own width. The model picks that radius,
 * so the separation cannot be tuned against a known value — leave a wide gap.
 */
const ARENA = { x0: 1300, x1: 1330, z0: 0, z1: 8 }
const START = { x: 1305, y: FLOOR + 1, z: 4 }
const ORE = { x: 1318, y: FLOOR + 1, z: 4 }

const mc = (command: string): void => {
  execFileSync('tmux', ['send-keys', '-t', 'mc', command, 'Enter'])
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<number> {
  // The arena must exist before the goal starts, and building it needs a bot
  // in the world to confirm it took. connect() is reentrant, so runBotGoal
  // connecting again is a no-op rather than a duplicate login.
  const executor = new MineflayerExecutor({ username: USERNAME })
  console.log('connecting…')
  const connected = await executor.connect()
  if (!connected.ok) {
    console.error(`FAIL: could not connect — ${connected.reason}: ${connected.detail}`)
    return 1
  }

  console.log('building the arena…')
  mc(`forceload add ${ARENA.x0} ${ARENA.z0} ${ARENA.x1} ${ARENA.z1}`)
  await sleep(800)
  mc(`fill ${ARENA.x0} ${FLOOR + 1} ${ARENA.z0} ${ARENA.x1} ${FLOOR + 6} ${ARENA.z1} air`)
  mc(`fill ${ARENA.x0} ${FLOOR} ${ARENA.z0} ${ARENA.x1} ${FLOOR} ${ARENA.z1} stone`)
  // Drops are entities, not blocks — the air fill above does not remove them,
  // and one left by a previous run would be collected by this one.
  mc(`kill @e[type=item,x=${ORE.x},y=${FLOOR},z=4,distance=..40]`)
  await sleep(700)
  mc(`tp ${USERNAME} ${START.x} ${START.y} ${START.z}`)
  mc(`clear ${USERNAME}`)
  mc(`give ${USERNAME} stone_pickaxe 1`)
  await sleep(1_200)
  mc(`setblock ${ORE.x} ${ORE.y} ${ORE.z} coal_ore`)
  await sleep(1_200)

  const llm = new OllamaClient()
  console.log(`asking ${process.env['MINEBOT_MODEL'] ?? 'qwen3:14b'} for decisions…\n`)

  const outcome = await runBotGoal('get me some coal', {
    executor,
    decider: new SchemaDecider(llm),
    maxSteps: 10,
  })

  console.log('Step log:')
  for (const step of outcome.steps) console.log(`  ${renderStep(step)}`)
  console.log(`\nOutcome: ${outcome.status}`)
  console.log(
    outcome.status === 'done' ? `Summary: ${outcome.summary}` : `Detail: ${outcome.detail}`,
  )

  // A model that declares success without mining anything must fail this demo,
  // not pass it — so verify against the world, not the model's own verdict.
  //
  // Reconnect as the SAME username: runBotGoal has disconnected the bot, and
  // the inventory being checked is Phase3Demo's. A differently-named bot would
  // report its own empty inventory and the check would always fail (or, with
  // the assertion inverted, always pass) for reasons having nothing to do with
  // the run. Offline-mode player data persists across the reconnect.
  const check = new MineflayerExecutor({ username: USERNAME })
  try {
    if (!(await check.connect()).ok) {
      console.error('FAIL: could not reconnect to verify the result')
      return 1
    }
    const coal = check.getState().self.inventory.find((i) => i.name === 'coal')
    const oreLeft = check.findBlocks({ names: ['coal_ore'], maxDistance: 40, limit: 5 })
    console.log(`\nverification: coal x${coal?.count ?? 0}, coal_ore still standing: ${oreLeft.length}`)

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

  console.log('DONE: the model found the coal ore, mined it, and collected the drop.')
  return 0
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error('FAIL:', e instanceof Error ? e.message : String(e))
    process.exit(1)
  },
)
