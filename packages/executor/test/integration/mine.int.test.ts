import { describe, it, expect, afterEach } from 'vitest'
import { MineflayerExecutor } from '../../src/index.js'
import {
  buildArena,
  placeArenaBlock,
  teleportAndWait,
  waitForOnGround,
  giveItem,
  clearInventory,
  placeInSlot,
  type ArenaBounds,
} from './mc-console.js'

const ARENA: ArenaBounds = { x0: 900, x1: 930, z0: 0, z1: 8, floorY: 199, clearance: 6 }
const START = { x: 905, y: ARENA.floorY + 1, z: 4 }
const ORE = { x: 912, y: ARENA.floorY + 1, z: 4 }

describe('mineBlock against the dev server', () => {
  let executor: MineflayerExecutor | null = null

  afterEach(async () => {
    await executor?.disconnect()
    executor = null
  })

  async function arenaBot(
    username: string,
    tool: string | null,
    opts: { toolInBackpack?: boolean } = {},
  ): Promise<MineflayerExecutor> {
    const e = new MineflayerExecutor({ username })
    expect((await e.connect()).ok).toBe(true)
    await buildArena(ARENA)
    await teleportAndWait(e, username, START)
    await waitForOnGround(e, { expectedY: ARENA.floorY + 1 })
    clearInventory(username)
    await new Promise((r) => setTimeout(r, 500))
    if (tool) {
      // `toolInBackpack` puts the tool in the main inventory rather than the
      // hotbar, so it can never be the held item whatever slot the player
      // happens to have selected — see placeInSlot for why /give cannot
      // express that reliably.
      if (opts.toolInBackpack) placeInSlot(username, 'inventory.0', `minecraft:${tool}`)
      else giveItem(username, tool)
      await new Promise((r) => setTimeout(r, 1_000))
    }
    placeArenaBlock(ORE, 'coal_ore')
    await new Promise((r) => setTimeout(r, 800))
    return e
  }

  it('mines a coal ore named by position', async () => {
    executor = await arenaBot('ITMinePos', 'stone_pickaxe')
    const r = await executor.mineBlock(ORE, 32, { timeoutMs: 60_000 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.position).toEqual(ORE)
    expect(executor.findBlocks({ names: ['coal_ore'], maxDistance: 32, limit: 5 })).toHaveLength(0)
  })

  it('mines a coal ore named by block name', async () => {
    executor = await arenaBot('ITMineName', 'stone_pickaxe')
    const r = await executor.mineBlock('coal_ore', 32, { timeoutMs: 60_000 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.position).toEqual(ORE)
  })

  it('equips a pickaxe from inventory rather than requiring it be held', async () => {
    executor = await arenaBot('ITMineEquip', 'stone_pickaxe', { toolInBackpack: true })
    // The precondition is the test: the pickaxe is in the inventory but not in
    // the hand. If this ever reads 'stone_pickaxe', the fixture has stopped
    // setting up the case and the assertion below proves nothing.
    expect(executor.getState().self.heldItem?.name).not.toBe('stone_pickaxe')
    const r = await executor.mineBlock(ORE, 32, { timeoutMs: 60_000 })
    expect(r.ok).toBe(true)
    expect(executor.getState().self.heldItem?.name).toBe('stone_pickaxe')
  })

  it('fails missing_tool AND LEAVES THE BLOCK STANDING with no pickaxe', async () => {
    executor = await arenaBot('ITMineNoTool', null)
    const r = await executor.mineBlock(ORE, 32, { timeoutMs: 30_000 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('missing_tool')

    // The assertion that gives the guard teeth. Without it this test passes
    // just as well against an executor that digs first and checks afterwards —
    // which is the exact bug the guard exists to prevent. Measured: bare-handed
    // coal ore takes 15 seconds to break and drops nothing.
    const still = executor.findBlocks({ names: ['coal_ore'], maxDistance: 32, limit: 5 })
    expect(still).toHaveLength(1)
    expect(still[0]?.position).toEqual(ORE)
  })

  it('fails missing_tool holding a wrong tool, and leaves the block standing', async () => {
    executor = await arenaBot('ITMineWrongTool', 'iron_shovel')
    const r = await executor.mineBlock(ORE, 32, { timeoutMs: 30_000 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('missing_tool')
    expect(executor.findBlocks({ names: ['coal_ore'], maxDistance: 32, limit: 5 })).toHaveLength(1)
  })

  it('fails not_found for a position holding air', async () => {
    executor = await arenaBot('ITMineAir', 'stone_pickaxe')
    const r = await executor.mineBlock({ x: 920, y: ARENA.floorY + 3, z: 4 }, 32)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_found')
  })

  it('fails not_found for a name with no match in range', async () => {
    executor = await arenaBot('ITMineNoMatch', 'stone_pickaxe')
    const r = await executor.mineBlock('diamond_ore', 32)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_found')
  })

  it('fails invalid_target for a block name the registry does not know', async () => {
    executor = await arenaBot('ITMineBadName', 'stone_pickaxe')
    const r = await executor.mineBlock('not_a_real_block', 32)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid_target')
  })

  it('fails not_found for a position beyond maxDistance', async () => {
    executor = await arenaBot('ITMineFar', 'stone_pickaxe')
    const r = await executor.mineBlock(ORE, 2)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_found')
  })

  it('resolves interrupted when aborted before the dig completes', async () => {
    executor = await arenaBot('ITMineAbort', 'stone_pickaxe')
    const controller = new AbortController()
    const pending = executor.mineBlock(ORE, 32, { signal: controller.signal, timeoutMs: 60_000 })
    setTimeout(() => controller.abort(), 400)
    const r = await pending
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('interrupted')
  })
})
