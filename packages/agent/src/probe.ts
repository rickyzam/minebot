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
import type { ItemStack, WorldSnapshot } from '@minebot/contract'
import { ok, fail } from '@minebot/contract'
import { ACTION_SCHEMA, type ActionName } from './actions.js'
import { decode } from './decide.js'
import { OllamaClient } from './ollama.js'
import { renderPrompt } from './prompt.js'
import type { Step } from './step.js'

const PICKAXE: ItemStack = { name: 'stone_pickaxe', count: 1, slot: 0 }
const COAL: ItemStack = { name: 'coal', count: 1, slot: 1 }
const COAL_AT = { x: 18, y: 60, z: -34 }

const snapshot = (inventory: ItemStack[]): WorldSnapshot => ({
  takenAt: Date.now(),
  self: {
    position: { x: 12, y: 64, z: -30 },
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

const main = async (): Promise<void> => {
  const attempts = Number(process.argv[2] ?? '5')
  const client = new OllamaClient()
  console.log(`Probing ${client.host} with ${client.model}, ${attempts} attempt(s) per scenario\n`)

  let decodedTotal = 0
  let attemptedTotal = 0
  const allLatencies: number[] = []

  for (const scenario of SCENARIOS) {
    const messages = renderPrompt(scenario.goal, snapshot(scenario.inventory), scenario.history)
    const chose = new Map<string, number>()
    const latencies: number[] = []
    let decoded = 0

    for (let i = 0; i < attempts; i++) {
      attemptedTotal += 1
      const started = Date.now()
      try {
        const reply = await client.chat({ messages, schema: ACTION_SCHEMA })
        const elapsed = Date.now() - started
        latencies.push(elapsed)
        allLatencies.push(elapsed)

        const result = decode(reply)
        if (result.ok) {
          decoded += 1
          decodedTotal += 1
          chose.set(result.action.action, (chose.get(result.action.action) ?? 0) + 1)
        } else {
          const label = `REJECTED:${result.error.kind}`
          chose.set(label, (chose.get(label) ?? 0) + 1)
          console.log(`      raw: ${reply.slice(0, 160)}`)
        }
      } catch (e) {
        chose.set('ERROR', (chose.get('ERROR') ?? 0) + 1)
        console.log(`      ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`)
      }
    }

    const picks = [...chose.entries()].map(([k, v]) => `${k} x${v}`).join(', ')
    console.log(`  ${scenario.name}`)
    console.log(`     hoped for: ${scenario.hoped.join(' or ')}`)
    console.log(`     chose:     ${picks || '(nothing)'}`)
    console.log(`     ${decoded}/${attempts} decoded, median ${median(latencies)}ms\n`)
  }

  console.log(
    `TOTAL ${decodedTotal}/${attemptedTotal} decoded, median ${median(allLatencies)}ms across all scenarios.`,
  )
  console.log('The first request of a run is slow while the model loads; that is why this is a median.')
  if (decodedTotal < attemptedTotal) {
    console.log('\nRecord the failures in spec §12 — that is what the open questions are for.')
  }
}

await main()
