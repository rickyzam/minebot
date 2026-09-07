import { describe, it, expect, afterEach } from 'vitest'
import pathfinderPkg from 'mineflayer-pathfinder'
import { MineflayerExecutor } from '../../src/index.js'

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
