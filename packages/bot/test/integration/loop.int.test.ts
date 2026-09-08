import { describe, it, expect, afterEach } from 'vitest'
import { MineflayerExecutor } from '@minebot/executor'
import { FakeLlmClient, SchemaDecider } from '@minebot/agent'
import {
  buildArena,
  placeArenaBlock,
  teleportAndWait,
  waitForOnGround,
  giveItem,
  clearInventory,
  type ArenaBounds,
} from '../../../executor/test/integration/mc-console.js'
import { runBotGoal } from '../../src/session.js'

// Fresh arena. In use elsewhere: 500-560, 800-840, 860-880, 900-930,
// 950-980, 1000-1020.
const ARENA: ArenaBounds = { x0: 1100, x1: 1130, z0: 0, z1: 8, floorY: 199, clearance: 6 }
const START = { x: 1105, y: ARENA.floorY + 1, z: 4 }
const ORE = { x: 1112, y: ARENA.floorY + 1, z: 4 }

/**
 * Builds the arena around a connected bot. The executor must already be
 * connected, because every helper here reads the bot's own reported state to
 * confirm the setup actually took.
 */
async function setUpArena(
  executor: MineflayerExecutor,
  username: string,
  opts: { tool?: string } = {},
): Promise<void> {
  await buildArena(ARENA)
  await teleportAndWait(executor, username, START)
  await waitForOnGround(executor, { expectedY: ARENA.floorY + 1 })
  clearInventory(username)
  await new Promise((r) => setTimeout(r, 500))
  if (opts.tool) {
    giveItem(username, opts.tool)
    await new Promise((r) => setTimeout(r, 1_000))
  }
  placeArenaBlock(ORE, 'coal_ore')
  await new Promise((r) => setTimeout(r, 800))
}

describe('the full loop against the live server', () => {
  let executor: MineflayerExecutor | null = null

  afterEach(async () => {
    await executor?.disconnect()
    executor = null
  })

  it('finds, mines and collects coal from an LLM decision', async () => {
    // The setup needs a connected bot, but runBotGoal owns the lifecycle — so
    // connect once here for the arena build, and let runBotGoal reconnect.
    // connect() is reentrant and idempotent (design spec §9.4), so the second
    // call on an already-connected executor returns ok rather than duplicating
    // the login.
    executor = new MineflayerExecutor({ username: 'ITLoopHappy' })
    expect((await executor.connect()).ok).toBe(true)
    await setUpArena(executor, 'ITLoopHappy', { tool: 'stone_pickaxe' })

    const llm = new FakeLlmClient([
      '{"action":"find_blocks","names":["coal_ore"],"maxDistance":32,"limit":5}',
      `{"action":"mine_block_at","x":${ORE.x},"y":${ORE.y},"z":${ORE.z},"maxDistance":32}`,
      '{"action":"done","summary":"mined the coal ore and collected the drop"}',
    ])

    const outcome = await runBotGoal('get me some coal', {
      executor,
      decider: new SchemaDecider(llm),
      maxSteps: 6,
    })

    expect(outcome.status).toBe('done')

    // The scripted mine_block_at coordinate must be one the *game* actually
    // reported, not just one this test happens to know. Without this, the
    // script could be mining a coordinate find_blocks never returned and the
    // test would still pass.
    const search = outcome.steps[0]
    expect(search?.outcome.kind).toBe('blocks')
    if (search?.outcome.kind === 'blocks') {
      expect(search.outcome.blocks.map((b) => b.position)).toContainEqual(ORE)
    }

    const mine = outcome.steps[1]
    expect(mine?.outcome.kind).toBe('result')
    if (mine?.outcome.kind === 'result') {
      expect(mine.outcome.result.ok).toBe(true)
    }
  })

  it('renders a game-produced missing_tool into the next prompt', async () => {
    executor = new MineflayerExecutor({ username: 'ITLoopNoTool' })
    expect((await executor.connect()).ok).toBe(true)
    // No tool. The real executor's harvest guard produces missing_tool, and
    // leaves the ore standing rather than spending 15s destroying it for
    // nothing (Phase 2 design; measured).
    await setUpArena(executor, 'ITLoopNoTool')

    const llm = new FakeLlmClient([
      `{"action":"mine_block_at","x":${ORE.x},"y":${ORE.y},"z":${ORE.z},"maxDistance":32}`,
      '{"action":"give_up","reason":"no pickaxe in inventory"}',
    ])

    const outcome = await runBotGoal('get me some coal', {
      executor,
      decider: new SchemaDecider(llm),
      maxSteps: 6,
    })

    expect(outcome.status).toBe('gave_up')

    const mine = outcome.steps[0]
    expect(mine?.outcome.kind).toBe('result')
    if (mine?.outcome.kind === 'result') {
      expect(mine.outcome.result.ok).toBe(false)
      if (!mine.outcome.result.ok) expect(mine.outcome.result.reason).toBe('missing_tool')
    }

    // Track A's guard, re-proven from the far side of the loop: missing_tool
    // must mean "we declined to destroy it", not "we destroyed it and said so".
    //
    // Keep observer usernames to 16 characters. Minecraft caps them there, and
    // a longer one is rejected at login — connect() returns disconnected, which
    // reads as a mysterious fixture failure rather than a naming mistake. This
    // one was originally 'ITLoopNoToolCheck', which is 17.
    const observer = new MineflayerExecutor({ username: 'ITNoToolWatch' })
    try {
      expect((await observer.connect()).ok).toBe(true)
      await teleportAndWait(observer, 'ITNoToolWatch', START)
      await waitForOnGround(observer, { expectedY: ARENA.floorY + 1 })
      const still = observer.findBlocks({ names: ['coal_ore'], maxDistance: 32, limit: 5 })
      expect(still.map((b) => b.position)).toContainEqual(ORE)
    } finally {
      await observer.disconnect()
    }

    // The integration assertion that matters: the failure the *game* produced
    // reached the model's input carrying its reason. Asserting only on the
    // returned status would pass against a loop that drops the detail on the
    // floor, and the model would then be deciding blind.
    expect(llm.requests).toHaveLength(2)
    const secondPrompt = llm.requests[1]?.messages.map((m) => m.content).join('\n') ?? ''
    expect(secondPrompt).toContain('missing_tool')
  })
})
