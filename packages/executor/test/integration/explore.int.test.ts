import { describe, it, expect, afterEach } from 'vitest'
import { MineflayerExecutor } from '../../src/index.js'
import {
  buildLargePlatform,
  placeArenaBlock,
  sendConsoleCommand,
  teleportAndWait,
  waitForOnGround,
  type ArenaBounds,
} from './mc-console.js'

/**
 * Sized against the SEARCH, not against the ore.
 *
 * A 32-block search from START proposes waypoints up to 32 blocks away in
 * every direction, so the platform has to contain a 32-block disc around
 * START with margin — not merely the corridor between START and the ore. At
 * y=199 the penalty for getting that wrong is the bot walking off the edge
 * and falling onto whatever terrain is 130 blocks below, which would look
 * like an executor bug rather than an arena that was too small.
 *
 * Clear of every other arena (500-1330) by more than the 32-block perception
 * radius, per the plan's arena-separation rule.
 */
const ARENA: ArenaBounds = { x0: 1600, x1: 1760, z0: -48, z1: 48, floorY: 199, clearance: 10 }
const START = { x: 1650, y: ARENA.floorY + 1, z: 0 }
/**
 * 50 blocks east of START: beyond the 32-block perception radius, so genuinely
 * invisible from the start, but within perception of the first ring waypoint
 * the spiral proposes at (1682, 0). Found by exploring, never by looking.
 */
const HIDDEN_ORE = { x: 1700, y: ARENA.floorY + 1, z: 0 }
/** First of four 1-block risers, so the east waypoint sits 4 blocks up. */
const STEP_START = 1666
/** On top of the raised ground, past the staircase. */
const RAISED_ORE = { x: 1700, y: ARENA.floorY + 5, z: 0 }

describe('exploreFor against the live server', () => {
  let executor: MineflayerExecutor | null = null

  afterEach(async () => {
    await executor?.disconnect()
    executor = null
  })

  async function arenaBot(username: string, ore: boolean): Promise<MineflayerExecutor> {
    const e = new MineflayerExecutor({ username })
    expect((await e.connect()).ok).toBe(true)
    await buildLargePlatform(ARENA)
    await teleportAndWait(e, username, START)
    await waitForOnGround(e, { expectedY: ARENA.floorY + 1 })
    if (ore) placeArenaBlock(HIDDEN_ORE, 'coal_ore')
    await new Promise((r) => setTimeout(r, 1_000))
    return e
  }

  it('cannot see the ore before it goes looking', async () => {
    // The premise. If findBlocks can already see it, every assertion below is
    // vacuous and this suite proves nothing about exploration.
    executor = await arenaBot('ITExploreSetup', true)
    expect(executor.findBlocks({ names: ['coal_ore'], maxDistance: 32, limit: 5 })).toHaveLength(0)
  }, 120_000)

  it('finds an ore it could not see', async () => {
    executor = await arenaBot('ITExploreFind', true)
    const r = await executor.exploreFor(['coal_ore'], 32, { budgetMs: 60_000 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.found.map((b) => b.position)).toContainEqual(HIDDEN_ORE)
      // It got there by walking. A find with zero travel would mean the ore
      // was visible all along and the premise test above is lying.
      expect(r.value.travelled).toBeGreaterThan(0)
    }
  }, 150_000)

  it('reports exhausted rather than searching forever when there is nothing', async () => {
    // The failure worth fearing most is not a bad search but one that never
    // stops. This walks the whole 32-block ring — eight waypoints, ~230 blocks
    // — and must come back saying there is nowhere left to look.
    executor = await arenaBot('ITExploreEmpty', false)
    const r = await executor.exploreFor(['diamond_ore'], 32, { budgetMs: 150_000 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.found).toEqual([])
      expect(r.value.exhausted).toBe(true)
    }
  }, 240_000)

  it('stays exhausted, and does no further work, once exhausted', async () => {
    // The guarantee that lets a caller stop asking. A second call must not
    // re-walk the ring, so it has to return promptly.
    executor = await arenaBot('ITExploreAgain', false)
    const first = await executor.exploreFor(['diamond_ore'], 16, { budgetMs: 60_000 })
    expect(first.ok && first.value.exhausted).toBe(true)
    const startedAt = Date.now()
    const second = await executor.exploreFor(['diamond_ore'], 16, { budgetMs: 60_000 })
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.value.exhausted).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  }, 150_000)

  it('resolves interrupted and stops when aborted mid-search', async () => {
    executor = await arenaBot('ITExploreAbort', true)
    const controller = new AbortController()
    const pending = executor.exploreFor(['coal_ore'], 32, {
      signal: controller.signal,
      budgetMs: 90_000,
    })
    setTimeout(() => controller.abort(), 2_000)
    const r = await pending
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('interrupted')
  }, 150_000)

  it('crosses a step in the terrain to find an ore beyond it', async () => {
    // REGRESSION, found by a human watching the benchmark. The spiral is
    // horizontal, so a waypoint carries the ORIGIN's elevation — and the goal
    // used to be GoalNear(x, origin.y, z, 2), which on any ground that is not
    // at the origin's level asks the bot to stand inside a point hanging in
    // mid-air. Those waypoints came back `unreachable` and were skipped, so
    // most of a real search was silently discarded.
    //
    // A FLAT arena cannot catch this — every waypoint is at the origin's
    // elevation there, which is exactly why five green integration tests and
    // 291 unit tests all missed it. This one puts the target up a staircase.
    executor = await arenaBot('ITExploreStep', false)
    for (let i = 0; i < 4; i++) {
      const x = STEP_START + i * 2
      sendConsoleCommand(
        `fill ${x} ${ARENA.floorY + 1} ${ARENA.z0} ${ARENA.x1} ${ARENA.floorY + 1 + i} ${ARENA.z1} stone`,
      )
    }
    await new Promise((r) => setTimeout(r, 2_000))
    placeArenaBlock(RAISED_ORE, 'coal_ore')
    await new Promise((r) => setTimeout(r, 1_000))

    // Still invisible from the start, so this measures the search and not
    // perception, exactly as the flat case does.
    expect(executor.findBlocks({ names: ['coal_ore'], maxDistance: 32, limit: 5 })).toHaveLength(0)

    const r = await executor.exploreFor(['coal_ore'], 32, { budgetMs: 90_000 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.found.map((b) => b.position)).toContainEqual(RAISED_ORE)
  }, 180_000)

  it('fails invalid_target for a block the registry does not know', async () => {
    // Checked before the bot moves: an unknown name must not read as "looked,
    // found nothing", which is what findBlocks alone would have reported.
    executor = await arenaBot('ITExploreBadName', false)
    const r = await executor.exploreFor(['not_a_real_block'], 32)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid_target')
  }, 120_000)
})
