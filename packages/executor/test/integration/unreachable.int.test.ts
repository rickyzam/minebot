import { describe, it, expect, afterEach } from 'vitest'
import { MineflayerExecutor } from '../../src/index.js'
import {
  buildArena,
  placeArenaBlock,
  sendConsoleCommand,
  teleportAndWait,
  waitForOnGround,
  giveItem,
  clearInventory,
  type ArenaBounds,
} from './mc-console.js'

/**
 * Regression tests for a false-success bug found during Phase 3 — by a human
 * watching the bot, not by any assertion in this suite.
 *
 * `mineflayer-pathfinder`'s `goto()` resolves SUCCESSFULLY when the computed
 * path has zero length; that branch is checked before its `noPath` and
 * `timeout` branches (lib/goto.js). A bot with no legal move therefore gets a
 * resolved promise rather than a rejection, and the executor reported `ok`:
 *
 *   move_to(1318, 200, 4)       -> OK     (the bot was 8.6 blocks away)
 *   mine_block_at(1318, 200, 4) -> OK     (the ore was never touched)
 *
 * `bot.dig()` compounds it: Mineflayer applies the break to its LOCAL world
 * model optimistically, so afterwards the bot sincerely believes the block is
 * air and reports `not_found` for a block that is still standing.
 *
 * Every other integration test uses an open arena where the pathfinder always
 * succeeds, so "goto resolved" and "the bot arrived" were indistinguishable.
 * A sealed pen makes them distinguishable, which is the whole point.
 */
const ARENA: ArenaBounds = { x0: 1200, x1: 1230, z0: 0, z1: 8, floorY: 199, clearance: 6 }
const START = { x: 1205, y: ARENA.floorY + 1, z: 4 }
const ORE = { x: 1220, y: ARENA.floorY + 1, z: 4 }

/**
 * Seals the bot into a 1x1 pen three blocks high, built around it after it has
 * landed. With no reachable neighbour, A* returns a zero-length path — the
 * exact condition that made `goto()` resolve as success.
 *
 * Three high because the bot can jump one block, and empty-handed because
 * `canDig` is off and the pathfinder will pillar up given any placeable block.
 */
function sealBotIn(): void {
  const y0 = ARENA.floorY + 1
  const y1 = ARENA.floorY + 3
  sendConsoleCommand(`fill 1204 ${y0} 3 1204 ${y1} 5 stone`)
  sendConsoleCommand(`fill 1206 ${y0} 3 1206 ${y1} 5 stone`)
  sendConsoleCommand(`fill 1204 ${y0} 3 1206 ${y1} 3 stone`)
  sendConsoleCommand(`fill 1204 ${y0} 5 1206 ${y1} 5 stone`)
}

async function penned(username: string): Promise<MineflayerExecutor> {
  const e = new MineflayerExecutor({ username })
  expect((await e.connect()).ok).toBe(true)
  await buildArena(ARENA)
  await teleportAndWait(e, username, START)
  await waitForOnGround(e, { expectedY: ARENA.floorY + 1 })
  clearInventory(username)
  giveItem(username, 'stone_pickaxe')
  placeArenaBlock(ORE, 'coal_ore')
  await new Promise((r) => setTimeout(r, 800))
  sealBotIn()
  await new Promise((r) => setTimeout(r, 1_200))
  return e
}

describe('a bot that cannot move', () => {
  let executor: MineflayerExecutor | null = null

  afterEach(async () => {
    await executor?.disconnect()
    executor = null
  })

  it('is actually sealed in, and the ore is actually out there', async () => {
    // The rest of this suite is meaningless if the pen did not get built: an
    // unpenned bot simply walks over and every assertion below inverts. Prove
    // the fixture before trusting it.
    executor = await penned('ITPenFixture')
    const walls = executor.findBlocks({ names: ['stone'], maxDistance: 8, limit: 200 })
    const ring = walls.filter(
      (b) => b.position.y > ARENA.floorY && Math.abs(b.position.x - START.x) <= 1,
    )
    expect(ring.length).toBeGreaterThan(0)

    const ore = executor.findBlocks({ names: ['coal_ore'], maxDistance: 32, limit: 5 })
    expect(ore.map((b) => b.position)).toContainEqual(ORE)

    const p = executor.getState().self.position
    expect(Math.abs(p.x - START.x)).toBeLessThan(1.5)
  })

  it('moveTo must not report success it did not achieve', async () => {
    executor = await penned('ITPenMove')
    const before = executor.getState().self.position

    const r = await executor.moveTo(ORE, { timeoutMs: 20_000 })

    // The heart of the bug: this returned `ok` while the bot stood still.
    expect(r.ok).toBe(false)
    // Issue #15: and the reason must be the useful one. `unreachable` tells the
    // planner to choose a different target; `timeout` tells it to retry
    // something that can never work. Bounding searchRadius is what makes A*
    // conclude noPath instead of exhausting its think budget.
    if (!r.ok) expect(r.reason).toBe('unreachable')

    // And it must not have moved, whatever it reported.
    const after = executor.getState().self.position
    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeLessThan(2)
    expect(Math.hypot(after.x - ORE.x, after.z - ORE.z)).toBeGreaterThan(2)
  })

  it('mineBlock must not report mining a block it never reached', async () => {
    executor = await penned('ITPenMine')
    const r = await executor.mineBlock(ORE, 32, { timeoutMs: 20_000 })

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('unreachable')

    // Verified from a SECOND connection, because the digging bot's own world
    // model is precisely what cannot be trusted here — after an optimistic dig
    // it reports air for a block that still exists.
    const observer = new MineflayerExecutor({ username: 'ITPenWatch' })
    try {
      expect((await observer.connect()).ok).toBe(true)
      await teleportAndWait(observer, 'ITPenWatch', { x: ORE.x + 2, y: ORE.y, z: ORE.z })
      await waitForOnGround(observer, { expectedY: ARENA.floorY + 1 })
      const still = observer.findBlocks({ names: ['coal_ore'], maxDistance: 16, limit: 5 })
      expect(still.map((b) => b.position)).toContainEqual(ORE)
    } finally {
      await observer.disconnect()
    }
  })
})
