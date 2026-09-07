import { describe, it, expect } from 'vitest'
import {
  canHarvest,
  bestHarvestTool,
  type HarvestableBlock,
  type ToolItem,
} from '../src/harvest.js'

// VERIFIED 2026-09-07 against the live dev server: coal_ore reports
// harvestTools as a map of item-type ids. These ids are from that measurement.
const COAL_ORE: HarvestableBlock = {
  name: 'coal_ore',
  harvestTools: { 913: true, 918: true, 923: true, 928: true, 933: true, 938: true, 943: true },
}
// Blocks like dirt have no harvestTools at all — anything harvests them.
const DIRT: HarvestableBlock = { name: 'dirt' }

const woodenPick: ToolItem = { name: 'wooden_pickaxe', type: 913, slot: 0 }
const stonePick: ToolItem = { name: 'stone_pickaxe', type: 918, slot: 1 }
const ironShovel: ToolItem = { name: 'iron_shovel', type: 800, slot: 2 }

describe('canHarvest', () => {
  it('rejects bare hands for a block that requires a tool', () => {
    expect(canHarvest(COAL_ORE, null)).toBe(false)
  })

  it('rejects a tool that is not in the block harvest list', () => {
    // Measured: holding an iron shovel, coal ore still breaks in 15s and drops
    // nothing. Holding *a* tool is not holding *the* tool.
    expect(canHarvest(COAL_ORE, ironShovel)).toBe(false)
  })

  it('accepts a tool that is in the harvest list', () => {
    expect(canHarvest(COAL_ORE, woodenPick)).toBe(true)
  })

  it('accepts bare hands for a block with no harvestTools', () => {
    expect(canHarvest(DIRT, null)).toBe(true)
  })

  it('accepts any tool for a block with no harvestTools', () => {
    expect(canHarvest(DIRT, ironShovel)).toBe(true)
  })

  it('treats an empty harvestTools map as harvestable by nothing', () => {
    expect(canHarvest({ name: 'bedrock', harvestTools: {} }, stonePick)).toBe(false)
  })
})

describe('bestHarvestTool', () => {
  it('returns null when nothing in inventory can harvest the block', () => {
    expect(bestHarvestTool(COAL_ORE, [ironShovel])).toBeNull()
  })

  it('returns null for an empty inventory', () => {
    expect(bestHarvestTool(COAL_ORE, [])).toBeNull()
  })

  it('picks the valid tool and ignores the invalid one', () => {
    expect(bestHarvestTool(COAL_ORE, [ironShovel, stonePick])?.name).toBe('stone_pickaxe')
  })

  it('prefers the later-tier tool when several are valid', () => {
    // Measured digTime for coal ore: wooden 2300ms, stone 1150ms. Preferring
    // the better tool halves the dig, which matters under a timeout.
    expect(bestHarvestTool(COAL_ORE, [woodenPick, stonePick])?.name).toBe('stone_pickaxe')
  })

  it('returns null for a block needing no tool, since bare hands suffice', () => {
    expect(bestHarvestTool(DIRT, [ironShovel])).toBeNull()
  })
})
