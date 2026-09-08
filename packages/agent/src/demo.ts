/**
 * The Track B deliverable: fake game state in, validated actions out, with no
 * Minecraft server and no model. The LLM is scripted and the world is a
 * MockExecutor, so this runs anywhere `npm install` has.
 *
 *   npm run agent:demo
 *
 * Swap FakeLlmClient for OllamaClient to drive it with a real model. Driving it
 * against a real server does NOT happen here: packages/agent must not depend on
 * @minebot/executor, or Mineflayer lands in the planning track transitively
 * (design spec §4, enforced by scripts/check-invariants.mjs). That composition
 * lives in packages/bot — see `npm run demo:phase3`.
 */
import { MockExecutor } from '@minebot/mock-executor'
import { FakeLlmClient } from './fake-llm.js'
import { SchemaDecider } from './decide.js'
import { runGoal } from './loop.js'
import { renderStep } from './prompt.js'

const main = async (): Promise<void> => {
  const executor = new MockExecutor({
    position: { x: 12, y: 64, z: -30 },
    inventory: [{ name: 'stone_pickaxe', count: 1, slot: 0 }],
    blocks: [
      { name: 'coal_ore', position: { x: 18, y: 60, z: -34 }, distance: 7.94 },
      { name: 'iron_ore', position: { x: 25, y: 58, z: -30 }, distance: 14.3 },
    ],
  })
  await executor.connect()

  const llm = new FakeLlmClient([
    '{"action":"find_blocks","names":["coal_ore","deepslate_coal_ore"],"maxDistance":32,"limit":5}',
    '{"action":"mine_block_at","x":18,"y":60,"z":-34,"maxDistance":32}',
    '{"action":"done","summary":"mined one coal ore and collected the drop"}',
  ])

  const outcome = await runGoal('get me some coal', {
    executor,
    decider: new SchemaDecider(llm),
  })

  console.log('Goal: get me some coal')
  console.log(`Result: ${outcome.status}`)
  console.log(
    outcome.status === 'done' ? `Summary: ${outcome.summary}` : `Detail: ${outcome.detail}`,
  )
  console.log('\nStep log:')
  for (const step of outcome.steps) console.log(renderStep(step))

  console.log('\nExecutor calls:')
  for (const call of executor.calls) console.log(`  ${call.name}(${JSON.stringify(call.args)})`)

  console.log('\nFinal inventory:')
  for (const item of executor.getState().self.inventory) {
    console.log(`  ${item.name} x${item.count}`)
  }

  await executor.disconnect()
}

await main()
