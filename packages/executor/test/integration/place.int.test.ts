import { describe, it, expect, afterEach } from 'vitest'
import type { Result } from '@minebot/contract'
import {
  MineflayerExecutor,
  parseSchematic,
  placementOrder,
  type Schematic,
} from '../../src/index.js'
import {
  buildArena,
  clearInventory,
  giveItem,
  itemCount,
  placeArenaBlock,
  sendConsoleCommand,
  teleportAndWait,
  waitForBlockVisible,
  waitForItemCount,
  waitForOnGround,
  type ArenaBounds,
} from './mc-console.js'

/**
 * The Phase 5 arena, shared with follow.int.test.ts. Integration files run one
 * at a time, and every test here rebuilds it, which clears whatever the last
 * test built or placed.
 */
const ARENA: ArenaBounds = { x0: 1850, x1: 1870, z0: 0, z1: 8, floorY: 199, clearance: 6 }
const FLOOR = ARENA.floorY + 1

const PLACER = 'ITPlacer'
const WATCH = 'ITPlaceWatch'

/** Where the placer starts, unless a test says otherwise. */
const START = { x: 1854, y: FLOOR, z: 4 }
/** A second connection's viewpoint on the arena floor, clear of every target. */
const FLOOR_VIEW = { x: 1866, y: FLOOR, z: 8 }

type Pos = { x: number; y: number; z: number }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * A raised stone ledge, two blocks high: taller than the bot can step or jump.
 * x 1858-1866, z 0-7, so a one-block corridor at z=8 runs past it on the floor.
 */
function buildLedge(): void {
  sendConsoleCommand(`fill 1858 ${FLOOR} 0 1866 ${FLOOR + 1} 7 stone`)
}
/** One stone step at the ledge's far corner: the only way up without building. */
const RAMP_STEP = { x: 1867, y: FLOOR, z: 7 }
/**
 * On top of the ledge, three blocks in from its front edge. Invisible from the
 * floor — an eye at 1.62 is below the ledge's top — and so reachable only by
 * standing higher. MEASURED 2026-09-11: a bot holding one dirt, unguarded,
 * pillars that dirt one block high and places from on top of it. A pillar at
 * the FRONT (x 1857) reaches this target, while the ramp is a ~20-block detour
 * round the back, so the pillar is by far the cheaper path — which is what
 * makes this geometry able to tell the guard from its absence. (With the
 * target deeper in, at x 1863, the only pillar in reach stood on the ramp's own
 * route, and the unguarded bot took the ramp: a test that could not fail.)
 */
const LEDGE_TARGET = { x: 1861, y: FLOOR + 2, z: 3 }
/** On the floor, directly against the ledge's front face, in line with LEDGE_TARGET. */
const LEDGE_FRONT = { x: 1857, y: FLOOR, z: 3 }
/** Standing on the ledge's near corner, with a view across its top. */
const LEDGE_VIEW = { x: 1858, y: FLOOR + 2, z: 0 }

describe('MineflayerExecutor.placeBlock', () => {
  let placer: MineflayerExecutor | null = null
  let watcher: MineflayerExecutor | null = null

  afterEach(async () => {
    await placer?.disconnect()
    await watcher?.disconnect()
    placer = null
    watcher = null
  })

  /**
   * The placer on the arena floor holding exactly `count` of `item` — or
   * nothing at all. `build` runs after the arena is rebuilt and before the bot
   * lands, so extra geometry is never built on top of it.
   */
  async function placerAt(
    start: Pos,
    hold: { item: string; count: number } | null,
    build?: () => void,
  ): Promise<MineflayerExecutor> {
    await buildArena(ARENA)
    build?.()
    // Assigned before connecting, so afterEach disconnects even a failed setup.
    const e = (placer = new MineflayerExecutor({ username: PLACER }))
    expect((await e.connect()).ok).toBe(true)
    // Default tolerance: /tp centres integer coordinates on the block. A test
    // needing an exact fractional position asserts it itself.
    await teleportAndWait(e, PLACER, start)
    await waitForOnGround(e, { expectedY: start.y })
    clearInventory(PLACER)
    await waitForItemCount(e, hold?.item ?? 'dirt', 0)
    if (hold) {
      giveItem(PLACER, hold.item, hold.count)
      await waitForItemCount(e, hold.item, hold.count)
    }
    return e
  }

  /**
   * Confirm `blockName` stands at `position` from a SECOND connection. The
   * placing bot's own world model is exactly what cannot be trusted here: it
   * is the same trap `bot.dig()` has, where the acting bot believes its own
   * action.
   */
  async function confirmFrom(viewpoint: Pos, blockName: string, position: Pos): Promise<void> {
    const w = (watcher = new MineflayerExecutor({ username: WATCH }))
    expect((await w.connect()).ok).toBe(true)
    await teleportAndWait(w, WATCH, viewpoint)
    await waitForOnGround(w, { expectedY: viewpoint.y })
    await waitForBlockVisible(w, blockName, position)
  }

  // `Result<unknown>`, not `Result`: buildSchematic reports a `{ placed }`
  // value, and a failure's reason is the same shape whatever the success type.
  const expectReason = (r: Result<unknown>, reason: string): void => {
    expect(r.ok, JSON.stringify(r)).toBe(false)
    if (!r.ok) expect(r.reason, r.detail).toBe(reason)
  }

  const flatDistance = (a: Pos, b: Pos): number => Math.hypot(a.x - b.x, a.z - b.z)

  it('walks into reach, places, and a second connection sees it; spends exactly one', async () => {
    const target = { x: 1862, y: FLOOR, z: 4 }
    const e = await placerAt(START, { item: 'dirt', count: 3 })
    // The approach is part of what is under test, so it must be needed.
    expect(flatDistance(e.getState().self.position, target)).toBeGreaterThan(6)

    const r = await e.placeBlock('dirt', target, { timeoutMs: 30_000 })
    expect(r, JSON.stringify(r)).toEqual({ ok: true, value: undefined })

    await waitForItemCount(e, 'dirt', 2)
    // And it stays there: not a count that dips by one and then keeps falling.
    await sleep(1_000)
    expect(itemCount(e, 'dirt')).toBe(2)

    await confirmFrom(FLOOR_VIEW, 'dirt', target)
  })

  // Ruling R8: Minecraft refuses to place a block into a cell an entity stands
  // in, and the bot counts.
  it('steps out of the target cell when standing in it, then places', async () => {
    const target = { x: 1858, y: FLOOR, z: 4 }
    const e = await placerAt(target, { item: 'dirt', count: 1 })

    const r = await e.placeBlock('dirt', target, { timeoutMs: 30_000 })
    expect(r, JSON.stringify(r)).toEqual({ ok: true, value: undefined })

    const p = e.getState().self.position
    expect([Math.floor(p.x), Math.floor(p.z)]).not.toEqual([target.x, target.z])
    await waitForItemCount(e, 'dirt', 0)
    await confirmFrom(FLOOR_VIEW, 'dirt', target)
  })

  it('places into a cell the bot straddles from the next one', async () => {
    const target = { x: 1858, y: FLOOR, z: 4 }
    // Centre at x=1857.95: a 0.6-wide body spans 1857.65-1858.25, a quarter of
    // a block into the target cell, while its floored position is the cell
    // beside it — which a goal checking only the floored cell accepts as-is.
    //
    // What saves it is the pathfinder's own fullStop(), which recentres the bot
    // in its cell when the goal is already satisfied. MEASURED 2026-09-11: this
    // passed even with GoalPlaceBlock's isStandingIn disabled. So it is a
    // behavioural check on ruling R8, not a test of the executor's goal choice.
    const e = await placerAt({ x: 1857.95, y: FLOOR, z: 4.5 }, { item: 'dirt', count: 1 })
    expect(e.getState().self.position.x).toBeGreaterThan(target.x - 0.3)

    const r = await e.placeBlock('dirt', target, { timeoutMs: 30_000 })
    expect(r, JSON.stringify(r)).toEqual({ ok: true, value: undefined })

    await waitForItemCount(e, 'dirt', 0)
    await confirmFrom(FLOOR_VIEW, 'dirt', target)
  })

  it('fails not_found with none in the inventory — before moving, and before judging the target', async () => {
    const far = { x: 1866, y: FLOOR, z: 4 }
    const occupied = { x: 1860, y: FLOOR, z: 4 }
    const e = await placerAt(START, null)
    placeArenaBlock(occupied, 'stone')
    await waitForBlockVisible(e, 'stone', occupied)
    const before = e.getState().self.position

    const started = Date.now()
    expectReason(await e.placeBlock('dirt', far, { timeoutMs: 30_000 }), 'not_found')
    // Rejected early: a target 12 blocks away would take seconds to walk to.
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(flatDistance(e.getState().self.position, before)).toBeLessThan(0.5)

    // Inventory before target, the order the mock uses: an occupied position
    // with nothing to place is still not_found.
    expectReason(await e.placeBlock('dirt', occupied, { timeoutMs: 30_000 }), 'not_found')
  })

  it('fails invalid_target for an occupied position, and keeps the block', async () => {
    const occupied = { x: 1858, y: FLOOR, z: 4 }
    const e = await placerAt(START, { item: 'dirt', count: 1 })
    placeArenaBlock(occupied, 'stone')
    await waitForBlockVisible(e, 'stone', occupied)

    expectReason(await e.placeBlock('dirt', occupied, { timeoutMs: 30_000 }), 'invalid_target')
    await sleep(500)
    expect(itemCount(e, 'dirt')).toBe(1)
  })

  it('fails invalid_target at once for a position with nothing solid beside it', async () => {
    // Two blocks above the floor: every one of its six neighbours is air.
    const midAir = { x: 1858, y: FLOOR + 2, z: 4 }
    const e = await placerAt(START, { item: 'dirt', count: 1 })

    const started = Date.now()
    expectReason(await e.placeBlock('dirt', midAir, { timeoutMs: 30_000 }), 'invalid_target')
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(itemCount(e, 'dirt')).toBe(1)
  })

  it('fails invalid_target for a name that is not a placeable block', async () => {
    const e = await placerAt(START, { item: 'stick', count: 1 })
    const r = await e.placeBlock('stick', { x: 1856, y: FLOOR, z: 4 }, { timeoutMs: 30_000 })
    expectReason(r, 'invalid_target')
    expect(itemCount(e, 'stick')).toBe(1)
  })

  it('fails unreachable — promptly, not a pathfinder timeout — for a cell sealed in stone', async () => {
    // A hollow 3x3x3 stone box. Its centre is empty and has six solid
    // neighbours, so it is a valid target in every respect but one: nothing
    // outside can see a face of it, and nothing can get in.
    const inside = { x: 1862, y: FLOOR + 1, z: 4 }
    const e = await placerAt(START, { item: 'dirt', count: 1 }, () =>
      sendConsoleCommand(`fill 1861 ${FLOOR} 3 1863 ${FLOOR + 2} 5 stone hollow`),
    )
    // Prove the box stands: its west face looks straight at the placer.
    await waitForBlockVisible(e, 'stone', { x: 1861, y: FLOOR + 1, z: 4 })

    const started = Date.now()
    expectReason(await e.placeBlock('dirt', inside, { timeoutMs: 30_000 }), 'unreachable')
    // The pathfinder's thinkTimeout is 5s. Under that, it concluded noPath
    // rather than exhausting its budget and reporting "retry".
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(itemCount(e, 'dirt')).toBe(1)
  })

  // The scaffolding hazard: Movements may place dirt and cobblestone to climb
  // or bridge, and would happily spend the very block it was asked to place.

  it('does not spend the block being placed on the approach, when there is another way up', async () => {
    const e = await placerAt(START, { item: 'dirt', count: 1 }, () => {
      buildLedge()
      placeArenaBlock(RAMP_STEP, 'stone')
    })
    await waitForBlockVisible(e, 'stone', { x: 1858, y: FLOOR + 1, z: 4 })

    const r = await e.placeBlock('dirt', LEDGE_TARGET, { timeoutMs: 45_000 })
    expect(r, JSON.stringify(r)).toEqual({ ok: true, value: undefined })

    // It went up the ramp and is standing ON THE LEDGE. A bot that pillared
    // stands one block lower, on its dirt; one that placed from the top of a
    // pillar jump lands back on the floor. Neither may pass.
    await waitForOnGround(e, { expectedY: FLOOR + 2, yTolerance: 0.5 })
    // The one dirt is AT THE TARGET — not a step in front of the ledge.
    await waitForItemCount(e, 'dirt', 0)
    await confirmFrom(LEDGE_VIEW, 'dirt', LEDGE_TARGET)
  })

  /**
   * After a failed placement on the no-ramp ledge, prove nothing is still
   * working on it: the dirt stays held, the bot stays where the call left it,
   * and a second connection sees no dirt anywhere.
   *
   * Review round 1, Important 1: a failed approach leaves the pathfinder's goal
   * set, and anything that resets the path — restoring the shared movements
   * does — re-plans it with dirt allowed as scaffolding. That walk plus a
   * pillar jump takes a few seconds, so a check straight after the call cannot
   * see it; 8s can.
   */
  async function expectNothingBuiltAfterwards(e: MineflayerExecutor): Promise<void> {
    const settled = e.getState().self.position
    await sleep(8_000)
    const now = e.getState().self.position
    expect(itemCount(e, 'dirt'), 'the dirt was spent after the call returned').toBe(1)
    expect(flatDistance(now, settled), 'the bot moved after the call returned').toBeLessThan(0.5)
    expect(Math.abs(now.y - settled.y), 'the bot climbed after the call returned').toBeLessThan(0.5)

    const w = (watcher = new MineflayerExecutor({ username: WATCH }))
    expect((await w.connect()).ok).toBe(true)
    await teleportAndWait(w, WATCH, LEDGE_VIEW)
    await waitForOnGround(w, { expectedY: LEDGE_VIEW.y })
    // Positive control: this viewpoint can see the floor in front of the
    // ledge, where a pillar would stand. Without it, "no dirt visible" could be
    // a connection whose chunks had not loaded.
    await waitForBlockVisible(w, 'stone', { x: 1855, y: ARENA.floorY, z: 1 })
    expect(w.findBlocks({ names: ['dirt'], maxDistance: 16, limit: 8 })).toEqual([])
  }

  it('fails unreachable and keeps the block, when building is the only way up', async () => {
    const e = await placerAt(START, { item: 'dirt', count: 1 }, buildLedge)
    await waitForBlockVisible(e, 'stone', { x: 1858, y: FLOOR + 1, z: 4 })

    expectReason(await e.placeBlock('dirt', LEDGE_TARGET, { timeoutMs: 45_000 }), 'unreachable')
    await expectNothingBuiltAfterwards(e)
  })

  // Review round 1, Important 2. Standing on the floor right against the
  // ledge, the bot's eye (y 201.62) is below the ledge top and cannot see the
  // target's face. The cell ABOVE the bot could: from an eye at 202.6 the face
  // is ~4.05 away with a clear ray. A viewpoint the bot does not occupy must
  // not count as arrival — the server does not check line of sight, so it
  // would accept a placement on a surface the bot cannot see.
  it('fails unreachable from the floor against the ledge, not from a viewpoint a block higher', async () => {
    const e = await placerAt(LEDGE_FRONT, { item: 'dirt', count: 1 }, buildLedge)
    await waitForBlockVisible(e, 'stone', { x: 1858, y: FLOOR + 1, z: 3 })

    expectReason(await e.placeBlock('dirt', LEDGE_TARGET, { timeoutMs: 45_000 }), 'unreachable')
    await expectNothingBuiltAfterwards(e)
  })

  /**
   * Task 5b. `buildSchematic` joins Task 5a's pure loader to Task 4's
   * `placeBlock`: without it the loader is dead code and the bottom-up
   * ordering constraint is never exercised against a real world.
   *
   * Nested here rather than in its own file so it shares this arena, the
   * placer/watcher fixtures, and the `afterEach` that disconnects both.
   */
  describe('buildSchematic', () => {
    /**
     * Where the 2x2x2 cube goes: eight blocks east of START, so the bot walks
     * to it instead of standing in it. Ruling R8 — Minecraft refuses to place
     * into a cell an entity occupies, so a bot inside the footprint cannot
     * finish the layer it is standing in. The cube spans x 1862-1863,
     * y 200-201, z 4-5; START is at x 1854 and the approach comes in from the
     * west, clear of every cell.
     */
    const CUBE_ORIGIN = { x: 1862, y: FLOOR, z: 4 }

    /** A 2x2x2 cube of `block`, built through the real loader. */
    function cubeSchematic(block: string): Schematic {
      const blocks: Array<{ dx: number; dy: number; dz: number; block: string }> = []
      for (const dy of [0, 1]) {
        for (const dx of [0, 1]) {
          for (const dz of [0, 1]) blocks.push({ dx, dy, dz, block })
        }
      }
      return parseSchematic({ name: 'cube2', blocks })
    }

    const absolute = (b: { dx: number; dy: number; dz: number }): Pos => ({
      x: CUBE_ORIGIN.x + b.dx,
      y: CUBE_ORIGIN.y + b.dy,
      z: CUBE_ORIGIN.z + b.dz,
    })
    const key = (p: Pos): string => `${p.x},${p.y},${p.z}`

    /**
     * One floor viewpoint on each of the cube's four sides, each with a nearby
     * floor block to use as a positive control.
     *
     * No single viewpoint can see all eight: every block of a 2x2x2 cube is a
     * corner, the far ones present only faces pointing away, and perception is
     * line-of-sight limited — "not visible from here" is the honest answer.
     *
     * MEASURED 2026-09-11: two viewpoints on OPPOSITE DIAGONAL corners are not
     * enough either. They saw 6 of 8, missing both blocks of the x=1862/z=5
     * column — a diagonal view grazes the far column of each face rather than
     * facing it. Cardinal viewpoints face each of the four columns head-on, and
     * both blocks of a column are exposed on that side.
     */
    const CUBE_VIEWS = [
      // West of the cube, facing the x=1862 columns.
      { at: { x: 1858, y: FLOOR, z: 4 }, control: { x: 1859, y: ARENA.floorY, z: 4 } },
      // East, facing the x=1863 columns.
      { at: { x: 1867, y: FLOOR, z: 5 }, control: { x: 1866, y: ARENA.floorY, z: 5 } },
      // South (-z), facing the z=4 columns.
      { at: { x: 1863, y: FLOOR, z: 1 }, control: { x: 1863, y: ARENA.floorY, z: 2 } },
      // North (+z), facing the z=5 columns.
      { at: { x: 1862, y: FLOOR, z: 8 }, control: { x: 1862, y: ARENA.floorY, z: 7 } },
    ]

    /**
     * Every dirt a SECOND connection can see from `CUBE_VIEWS`, as sorted
     * position keys. One connection, teleported between viewpoints — connecting
     * is the slow part, teleporting is not.
     *
     * The building bot's own world model is precisely what cannot be trusted
     * here; this is the same rule `bot.dig()` taught the hard way.
     */
    async function dirtSeenFromCorners(): Promise<string[]> {
      const w = (watcher = new MineflayerExecutor({ username: WATCH }))
      expect((await w.connect()).ok).toBe(true)
      const seen = new Set<string>()
      for (const view of CUBE_VIEWS) {
        await teleportAndWait(w, WATCH, view.at)
        await waitForOnGround(w, { expectedY: view.at.y })
        // Positive control: without it, "no dirt visible" cannot be told apart
        // from a connection whose chunks have not loaded yet.
        await waitForBlockVisible(w, 'stone', view.control)
        for (const b of w.findBlocks({ names: ['dirt'], maxDistance: 16, limit: 64 })) {
          seen.add(key(b.position))
        }
      }
      return [...seen].sort()
    }

    /** Poll `predicate` until true, or throw `what` after `timeoutMs`. */
    async function waitUntil(
      predicate: () => boolean,
      timeoutMs: number,
      what: string,
    ): Promise<void> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        if (predicate()) return
        if (Date.now() >= deadline) throw new Error(`waitUntil: ${what} (within ${timeoutMs}ms)`)
        await sleep(100)
      }
    }

    it(
      'builds a 2x2x2 cube bottom-up, and a second connection sees all eight',
      async () => {
        const s = cubeSchematic('dirt')
        const order = placementOrder(s)
        // The constraint this task exists to exercise against a real world: the
        // whole bottom layer goes down before any of the top one, or the top
        // has nothing to place against and fails invalid_target.
        expect(order.map((b) => b.dy)).toEqual([0, 0, 0, 0, 1, 1, 1, 1])

        const e = await placerAt(START, { item: 'dirt', count: 8 })
        // The approach is part of what is under test, so it must be needed.
        expect(flatDistance(e.getState().self.position, CUBE_ORIGIN)).toBeGreaterThan(6)

        const started = Date.now()
        const r = await e.buildSchematic(s, CUBE_ORIGIN, { timeoutMs: 240_000 })
        const elapsed = Date.now() - started
        expect(r, JSON.stringify(r)).toEqual({ ok: true, value: { placed: 8 } })
        console.log(
          `buildSchematic: 8 blocks in ${elapsed}ms (${Math.round(elapsed / 8)}ms per block)`,
        )

        // Exactly eight spent — not one over, which would mean the approach
        // spent a block as scaffolding somewhere.
        await waitForItemCount(e, 'dirt', 0)
        expect(await dirtSeenFromCorners()).toEqual(order.map((b) => key(absolute(b))).sort())
      },
      300_000,
    )

    it(
      'stops at the first failure, naming the block and how far it got',
      async () => {
        const s = cubeSchematic('dirt')
        const order = placementOrder(s)
        // The fourth block in placement order — last of the bottom layer. Made
        // unplaceable by filling it in advance, so the build fails on a block
        // it can name rather than by running out of material.
        const blocked = absolute(order[3]!)

        const e = await placerAt(START, { item: 'dirt', count: 8 }, () =>
          placeArenaBlock(blocked, 'stone'),
        )
        await waitForBlockVisible(e, 'stone', blocked)

        const r = await e.buildSchematic(s, CUBE_ORIGIN, { timeoutMs: 240_000 })
        expect(r.ok, JSON.stringify(r)).toBe(false)
        if (!r.ok) {
          expect(r.reason).toBe('invalid_target')
          // Which block, where, and how far it got — a caller cannot otherwise
          // tell a build that died on block 1 from one that died on block 8.
          expect(r.detail).toContain('dirt')
          expect(r.detail).toContain(`(${blocked.x}, ${blocked.y}, ${blocked.z})`)
          expect(r.detail).toContain('after 3 of 8')
        }

        // It stopped there: three spent, five still held.
        await waitForItemCount(e, 'dirt', 5)
        await sleep(3_000)
        expect(itemCount(e, 'dirt'), 'the build kept going after it reported a failure').toBe(5)
      },
      300_000,
    )

    it(
      'aborts between blocks as interrupted, and leaves what it already built standing',
      async () => {
        const s = cubeSchematic('dirt')
        const order = placementOrder(s)
        const e = await placerAt(START, { item: 'dirt', count: 8 })

        const controller = new AbortController()
        const build = e.buildSchematic(s, CUBE_ORIGIN, { signal: controller.signal })
        // Abort only once at least one block is genuinely down, so this tests
        // cancelling a build in progress rather than one that never started.
        await waitUntil(
          () => itemCount(e, 'dirt') <= 7,
          120_000,
          'no dirt was placed before the abort',
        )
        controller.abort()
        expectReason(await build, 'interrupted')

        const atReturn = 8 - itemCount(e, 'dirt')
        expect(atReturn).toBeGreaterThanOrEqual(1)

        // MEASURED 2026-09-11: the count can still tick up by exactly one after
        // the call reports `interrupted`. An abort landing inside
        // `bot.placeBlock` cannot recall a placement packet already sent — the
        // block lands, and the inventory update arrives after the promise has
        // settled. That is an honest `interrupted`, not a runaway loop, and one
        // committed placement is the whole of the window: the abort check
        // before the equip catches everything earlier.
        await sleep(8_000)
        const settled = 8 - itemCount(e, 'dirt')
        expect(settled).toBeGreaterThanOrEqual(atReturn)
        expect(settled).toBeLessThanOrEqual(atReturn + 1)
        // It stopped well short of the whole cube — the point of aborting.
        expect(settled).toBeLessThan(8)

        // And the loop really is finished, not merely slow: a running build
        // places a block every couple of seconds, so another 8s would show it.
        await sleep(8_000)
        expect(8 - itemCount(e, 'dirt'), 'the build kept going after it was aborted').toBe(settled)

        // What it did build is still standing. order[0] is placed first, so it
        // is there whenever anything is.
        const first = absolute(order[0]!)
        const seen = await dirtSeenFromCorners()
        expect(seen).toContain(key(first))
        expect(seen.length).toBe(settled)
      },
      300_000,
    )
  })
})
