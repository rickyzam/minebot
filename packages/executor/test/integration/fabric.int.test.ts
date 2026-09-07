import { describe, it, expect, afterEach } from 'vitest'
import { MineflayerExecutor } from '../../src/index.js'
import { buildArena, teleportAndWait, waitForOnGround, giveItem, clearInventory, type ArenaBounds } from './mc-console.js'

/**
 * These run against the dev server with Fabric content mods loaded. Without the
 * registry-sync handshake the server rejects Mineflayer outright:
 *
 *   This server requires Fabric Loader and Fabric API installed on your client!
 *
 * so `connects to a modded server at all` is the regression guard for the whole
 * feature — it fails closed if the handshake breaks.
 */
const ARENA: ArenaBounds = { x0: 1000, x1: 1020, z0: 0, z1: 8, floorY: 199, clearance: 6 }
const START = { x: 1005, y: ARENA.floorY + 1, z: 4 }

describe('Fabric mod compatibility', () => {
  let executor: MineflayerExecutor | null = null

  afterEach(async () => {
    await executor?.disconnect()
    executor = null
  })

  it('connects to a modded server at all', async () => {
    executor = new MineflayerExecutor({ username: 'ITFabric' })
    const r = await executor.connect()
    expect(r.ok).toBe(true)
    expect(executor.getState().self.health).toBeGreaterThan(0)
  })

  it('is rejected when the handshake is disabled — proving the guard fires', async () => {
    // Without this, the test above would pass just as well on a vanilla server
    // and tell us nothing. This asserts the server genuinely demands the
    // handshake, so the feature is doing real work.
    executor = new MineflayerExecutor({ username: 'ITNoFabric', fabricCompat: false, connectTimeoutMs: 20_000 })
    const r = await executor.connect()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('disconnected')
      expect(r.detail).toMatch(/Fabric Loader and Fabric API/i)
    }
  })

  it('discovers the modded registry entries the server reports', async () => {
    executor = new MineflayerExecutor({ username: 'ITFabricRegistry' })
    expect((await executor.connect()).ok).toBe(true)

    const modded = executor.moddedRegistryEntries()
    expect(modded.length).toBeGreaterThan(0)
    // Namespace-based, not mod-specific: whatever this server has loaded shows up.
    expect(modded.every((e) => !e.name.startsWith('minecraft:'))).toBe(true)
    expect(modded.every((e) => Number.isInteger(e.id) && e.id >= 0)).toBe(true)
    expect(modded.every((e) => e.registry.includes(':'))).toBe(true)
  })

  it('reports no modded entries when the handshake is disabled', async () => {
    executor = new MineflayerExecutor({ username: 'ITFabricOff', fabricCompat: false, connectTimeoutMs: 20_000 })
    await executor.connect()
    expect(executor.moddedRegistryEntries()).toEqual([])
  })

  it('still reads vanilla blocks and items correctly with a mod loaded', async () => {
    // The connection succeeding is not enough. If the mod had renumbered vanilla
    // registry ids, the bot would connect and then silently misread everything.
    executor = new MineflayerExecutor({ username: 'ITFabricVanilla' })
    expect((await executor.connect()).ok).toBe(true)

    await buildArena(ARENA)
    await teleportAndWait(executor, 'ITFabricVanilla', START)
    await waitForOnGround(executor, { expectedY: ARENA.floorY + 1 })

    clearInventory('ITFabricVanilla')
    await new Promise((r) => setTimeout(r, 500))
    giveItem('ITFabricVanilla', 'stone_pickaxe')
    giveItem('ITFabricVanilla', 'coal', 5)
    await new Promise((r) => setTimeout(r, 1_200))

    const inventory = executor.getState().self.inventory
    expect(inventory.find((i) => i.name === 'stone_pickaxe')).toBeDefined()
    expect(inventory.find((i) => i.name === 'coal')?.count).toBe(5)

    const found = executor.findBlocks({ names: ['stone'], maxDistance: 16, limit: 5 })
    expect(found.length).toBeGreaterThan(0)
    expect(found.every((b) => b.name === 'stone')).toBe(true)
  })
})
