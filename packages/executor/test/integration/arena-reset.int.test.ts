import { describe, it, expect, afterEach } from 'vitest'
import { MineflayerExecutor } from '../../src/index.js'
import {
  buildArena,
  sendConsoleCommand,
  teleportAndWait,
  waitForOnGround,
  clearInventory,
  type ArenaBounds,
} from './mc-console.js'

const ARENA: ArenaBounds = { x0: 860, x1: 880, z0: 0, z1: 8, floorY: 199, clearance: 6 }
const START = { x: 865, y: ARENA.floorY + 1, z: 4 }

describe('arena reset despawns loose items', () => {
  let executor: MineflayerExecutor | null = null

  afterEach(async () => {
    await executor?.disconnect()
    executor = null
  })

  it('removes item entities left inside the arena by a previous run', async () => {
    executor = new MineflayerExecutor({ username: 'ITArenaReset' })
    expect((await executor.connect()).ok).toBe(true)

    await buildArena(ARENA)
    await teleportAndWait(executor, 'ITArenaReset', START)
    await waitForOnGround(executor, { expectedY: ARENA.floorY + 1 })
    clearInventory('ITArenaReset')

    // Simulate the litter a previous mining run leaves behind, far enough away
    // that the bot cannot simply pick it up during this test.
    sendConsoleCommand(
      `summon item 875 ${ARENA.floorY + 2} 4 {Item:{id:"minecraft:coal",count:1}}`,
    )
    await new Promise((r) => setTimeout(r, 1_500))

    const before = executor.getState().nearbyEntities.filter((e) => e.kind === 'item')
    expect(before.length).toBeGreaterThan(0) // the fixture must be able to fail

    await buildArena(ARENA)
    await new Promise((r) => setTimeout(r, 1_500))

    const after = executor.getState().nearbyEntities.filter((e) => e.kind === 'item')
    expect(after.length).toBe(0)
  })
})
