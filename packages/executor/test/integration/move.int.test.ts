import { describe, it, expect, afterEach } from 'vitest'
import { MineflayerExecutor } from '../../src/index.js'
import { buildArena, teleportAndWait, waitForOnGround, type ArenaBounds } from './mc-console.js'

/**
 * A fixed, self-healing test surface, built fresh via the server console
 * before every test rather than found by searching the world for a clear
 * spot. The previous version of this suite targeted "current position + 6
 * on x" against whatever terrain a fixed username's persisted position
 * happened to carry over from the last run — on a persistent shared world,
 * every successful run walked the bot further into unknown terrain, so the
 * test degraded from green-when-written to reliably red once it wandered
 * into an obstacle raw movement can't climb (see task-6-report.md for the
 * root-cause diagnosis). Building a platform at a fixed coordinate makes
 * this biome- and terrain-independent: it verifies that moveTo walks the
 * bot to a target, not that the world happens to be cooperative.
 *
 * Coordinates picked well clear of spawn and any structures, high enough in
 * the sky that no terrain (jungle canopy included) intrudes on the arena
 * regardless of what generates around it.
 */
const ARENA: ArenaBounds = {
  x0: 500,
  x1: 560,
  z0: 0,
  z1: 8,
  floorY: 199,
  clearance: 6,
}
const START = { x: 505, y: ARENA.floorY + 1, z: 4 }

async function resetToArena(executor: MineflayerExecutor, username: string): Promise<void> {
  await buildArena(ARENA)
  await teleportAndWait(executor, username, START)
  // teleportAndWait only confirms *position* converged — it says nothing about
  // whether the floor is actually there (/tp succeeds regardless, and a falling
  // bot's position briefly looks "close enough" too). Confirm the bot actually
  // landed on solid ground *at the arena's height* before any test proceeds —
  // checking onGround alone isn't enough, since a bot falling through a missing
  // floor eventually lands on real terrain far below and satisfies onGround too,
  // just at the wrong height — so a broken or missing arena fails loudly here
  // instead of moveTo silently passing on a bot that's drifting through (or
  // resting far beneath) empty air.
  await waitForOnGround(executor, { expectedY: START.y })
}

describe('MineflayerExecutor.moveTo', () => {
  let executor: MineflayerExecutor | null = null

  afterEach(async () => {
    await executor?.disconnect()
    executor = null
  })

  it('walks to a nearby coordinate', async () => {
    executor = new MineflayerExecutor({ username: 'ITMove' })
    await executor.connect()
    await resetToArena(executor, 'ITMove')
    const start = executor.getState().self.position
    const target = { x: Math.round(start.x) + 6, y: start.y, z: Math.round(start.z) }

    const r = await executor.moveTo(target, { timeoutMs: 30_000 })
    expect(r.ok).toBe(true)

    const end = executor.getState().self.position
    expect(Math.hypot(end.x - target.x, end.z - target.z)).toBeLessThanOrEqual(2)
  })

  it('resolves interrupted when the signal is already aborted, without moving', async () => {
    executor = new MineflayerExecutor({ username: 'ITMovePreAbort' })
    await executor.connect()
    await resetToArena(executor, 'ITMovePreAbort')
    const start = executor.getState().self.position

    const r = await executor.moveTo(
      { x: start.x + 40, y: start.y, z: start.z + 40 },
      { signal: AbortSignal.abort() },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('interrupted')

    const end = executor.getState().self.position
    expect(Math.hypot(end.x - start.x, end.z - start.z)).toBeLessThan(2)
  })

  it('resolves interrupted when aborted mid-walk and stops moving', async () => {
    executor = new MineflayerExecutor({ username: 'ITMoveAbort' })
    await executor.connect()
    await resetToArena(executor, 'ITMoveAbort')
    const start = executor.getState().self.position
    const controller = new AbortController()

    // The target must be ON the runway (which ends at ARENA.x1 = 560), and far
    // enough that the walk is still in progress a second from now. It used to
    // be start.x + 60 ≈ 565 — off the platform's east edge, over open air.
    // Phase 1's raw movement never evaluated reachability, so it set off
    // toward the void and aborting mid-stride produced 'interrupted'. The
    // pathfinder decides up front that there is no path to a spot with no
    // floor and returns 'unreachable' in well under a second, so the abort
    // never lands and this test measured the old implementation's blindness
    // rather than its own subject. ~50 blocks along the runway is reachable
    // and takes ~10s (measured: 30 blocks ≈ 6.1s), so the 1s abort is
    // comfortably mid-walk.
    const pending = executor.moveTo(
      { x: ARENA.x1 - 5, y: start.y, z: start.z },
      { signal: controller.signal, timeoutMs: 30_000 },
    )
    setTimeout(() => controller.abort(), 1_000)
    const r = await pending

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('interrupted')

    const atAbort = executor.getState().self.position
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const later = executor.getState().self.position
    expect(Math.hypot(later.x - atAbort.x, later.z - atAbort.z)).toBeLessThan(2)
  })

  it('times out on a reachable target it cannot arrive at in time', async () => {
    executor = new MineflayerExecutor({ username: 'ITMoveTimeout' })
    await executor.connect()
    await resetToArena(executor, 'ITMoveTimeout')
    const start = executor.getState().self.position

    // Aim along +x only, not diagonally. The arena runway (see ARENA above) is
    // 60 blocks long in x but only 9 blocks wide in z — a 45° target sends the
    // bot off the platform's edge within a second or two, and it falls ~130
    // blocks from y≈199 to real terrain, likely dying and respawning
    // elsewhere. The test still went green because it only asserted
    // `reason === 'timeout'`, which a respawned-and-idle bot also satisfies —
    // passing for the wrong reason instead of exercising an in-bounds walk
    // that legitimately does not arrive in time.
    //
    // The target used to be start.x + 5000, which under Phase 1's raw movement
    // was "walk forward forever until the clock runs out". Under the
    // pathfinder that coordinate has no floor and no path, so it now reports
    // 'unreachable' — which is the correct answer for it, and precisely the
    // distinction Task 7 exists to draw. Timing out is a different outcome and
    // still needs covering, so this walks somewhere genuinely reachable and
    // cuts the clock short: ~50 blocks along the runway takes ~10s (measured:
    // 30 blocks ≈ 6.1s), so a 3s budget expires mid-walk.
    const r = await executor.moveTo(
      { x: ARENA.x1 - 5, y: start.y, z: start.z },
      { timeoutMs: 3_000 },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('timeout')

    // Confirm the bot is still on the runway, not fallen off / dead / respawned.
    const end = executor.getState().self.position
    expect(Math.abs(end.y - start.y)).toBeLessThanOrEqual(2)
  })
})
