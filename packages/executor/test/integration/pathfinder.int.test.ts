import { describe, it, expect, afterEach } from 'vitest'
import pathfinderPkg from 'mineflayer-pathfinder'
import { MineflayerExecutor } from '../../src/index.js'
import {
  buildArena,
  sendConsoleCommand,
  teleportAndWait,
  waitForOnGround,
  type ArenaBounds,
} from './mc-console.js'

// VERIFIED 2026-09-07: `goals` is NOT an ESM named export of this CJS package.
// Node's named-export detection yields only Movements, pathfinder, default and
// 'module.exports'. Destructuring the default import is the only form that works.
const { pathfinder, Movements, goals } = pathfinderPkg

describe('mineflayer-pathfinder on this server', () => {
  let executor: MineflayerExecutor | null = null

  afterEach(async () => {
    await executor?.disconnect()
    executor = null
  })

  it('exposes the pieces we depend on via the default import', () => {
    expect(typeof pathfinder).toBe('function')
    expect(typeof Movements).toBe('function')
    expect(typeof goals.GoalNear).toBe('function')
    expect(typeof goals.GoalLookAtBlock).toBe('function')
  })

  it('loads as a plugin and builds Movements for this protocol version', async () => {
    // The real risk with a dependency last published in 2023: minecraft-data
    // lookups for a 2025 protocol version. This is where that would blow up.
    executor = new MineflayerExecutor({ username: 'ITPathLoad' })
    const r = await executor.connect()
    expect(r.ok).toBe(true)
    expect(executor.hasPathfinder()).toBe(true)
  })
})

// A private arena, deliberately away from move.int.test.ts's (x 500-560) so
// the two files cannot disturb each other. Floating at y=199 so it is
// independent of biome and world generation.
const ARENA: ArenaBounds = { x0: 800, x1: 840, z0: 0, z1: 8, floorY: 199, clearance: 6 }
const START = { x: 805, y: ARENA.floorY + 1, z: 4 }

describe('moveTo via the pathfinder', () => {
  let executor: MineflayerExecutor | null = null

  afterEach(async () => {
    await executor?.disconnect()
    executor = null
  })

  async function arenaBot(username: string): Promise<MineflayerExecutor> {
    const e = new MineflayerExecutor({ username })
    const r = await e.connect()
    expect(r.ok).toBe(true)
    await buildArena(ARENA)
    await teleportAndWait(e, username, START)
    await waitForOnGround(e, { expectedY: ARENA.floorY + 1 })
    return e
  }

  it('routes around a wall instead of wedging against it', async () => {
    executor = await arenaBot('ITPathWall')
    // A wall across the runway with a single gap. Phase 1's raw movement
    // walked into obstacles and jumped; only a real path finds the gap.
    sendConsoleCommand(
      `fill 820 ${ARENA.floorY + 1} ${ARENA.z0} 820 ${ARENA.floorY + 3} ${ARENA.z1} stone`,
    )
    sendConsoleCommand(`fill 820 ${ARENA.floorY + 1} 1 820 ${ARENA.floorY + 3} 1 air`)
    await new Promise((r) => setTimeout(r, 800))

    const target = { x: 835, y: ARENA.floorY + 1, z: 4 }
    const r = await executor.moveTo(target, { timeoutMs: 45_000 })
    expect(r.ok).toBe(true)

    const p = executor.getState().self.position
    expect(Math.hypot(p.x - target.x, p.z - target.z)).toBeLessThan(2)
  })

  it('reports unreachable — not timeout — for a target sealed behind stone', async () => {
    executor = await arenaBot('ITPathNoPath')
    // Fully enclose a target block so no path exists. The distinction matters:
    // 'unreachable' tells the planner to pick a different target, 'timeout'
    // tells it to try again. Getting this wrong makes retry policy loop.
    sendConsoleCommand(`fill 830 ${ARENA.floorY + 1} 3 832 ${ARENA.floorY + 4} 5 stone`)
    await new Promise((r) => setTimeout(r, 800))

    const r = await executor.moveTo({ x: 831, y: ARENA.floorY + 2, z: 4 }, { timeoutMs: 30_000 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('unreachable')
  })

  it('resolves interrupted and actually halts when aborted mid-path', async () => {
    executor = await arenaBot('ITPathAbort')
    const controller = new AbortController()
    const pending = executor.moveTo(
      { x: 838, y: ARENA.floorY + 1, z: 4 },
      { signal: controller.signal, timeoutMs: 45_000 },
    )
    await new Promise((r) => setTimeout(r, 1_200))
    controller.abort()

    const r = await pending
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('interrupted')

    // Not just labelled interrupted — actually stopped. Sample twice.
    const a = executor.getState().self.position
    await new Promise((r) => setTimeout(r, 1_000))
    const b = executor.getState().self.position
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThan(1)
  })
})
