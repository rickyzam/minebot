/**
 * Harvestability decisions, kept pure so they can be tested exhaustively
 * without a server. This is the guard behind `missing_tool`.
 *
 * Why this exists rather than using Mineflayer's own helpers — both VERIFIED
 * against the live dev server on 2026-09-07:
 *
 *  - `bot.canDigBlock()` returned `true` bare-handed, holding an iron shovel,
 *    and holding a pickaxe. It answers "is this breakable at all", not "will
 *    this drop anything", so it is the wrong signal entirely.
 *  - `bot.pathfinder.bestHarvestTool()` returned `iron_shovel` as the best
 *    tool for coal ore when that was the only inventory item.
 *
 * Getting this wrong is expensive, not merely incorrect: bare-handed or
 * wrong-tooled, coal ore takes 15 seconds to break and drops nothing. The
 * block is destroyed and the resource is gone.
 */

/** Structural subset of prismarine-block's Block that this module reads. */
export interface HarvestableBlock {
  name: string
  /**
   * Map of item-type ids that can harvest this block, e.g.
   * `{913: true, 918: true, …}` for coal ore. `undefined` means the block has
   * no tool requirement and anything harvests it — that is the common case.
   */
  harvestTools?: Record<string, boolean>
}

/** Structural subset of prismarine-item's Item. */
export interface ToolItem {
  name: string
  type: number
  slot: number
}

/**
 * Would mining `block` while holding `tool` actually yield its drop?
 * `null` means bare hands.
 */
export function canHarvest(block: HarvestableBlock, tool: ToolItem | null): boolean {
  const required = block.harvestTools
  if (required === undefined) return true
  if (tool === null) return false
  return required[String(tool.type)] === true
}

/**
 * The best inventory item for harvesting `block`, or `null` if none qualifies
 * — which is also what a block needing no tool returns, since bare hands
 * already suffice there and equipping something would be pointless work.
 *
 * "Best" is the highest item type id among valid tools. Minecraft's item
 * registry is ordered by material tier within a tool family (wooden, stone,
 * iron, diamond, netherite), so the highest valid id is the best tier
 * available. Measured: stone pickaxe digs coal ore in 1150ms against the
 * wooden pickaxe's 2300ms, so this halves the dig under a timeout.
 */
export function bestHarvestTool(
  block: HarvestableBlock,
  items: readonly ToolItem[],
): ToolItem | null {
  if (block.harvestTools === undefined) return null
  let best: ToolItem | null = null
  for (const item of items) {
    if (!canHarvest(block, item)) continue
    if (best === null || item.type > best.type) best = item
  }
  return best
}
