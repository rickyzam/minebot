import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import type { Result } from '@minebot/contract'
import { MineflayerExecutor, ReflexExecutor, type ReflexPreemption } from '../../src/index.js'
import {
  arenaVolume,
  buildArena,
  clearInventory,
  expectDifficultyPeaceful,
  sendConsoleCommand,
  sweepArenaUntilEmpty,
  teleportAndWait,
  waitForOnGround,
  waitUntil,
  type ArenaBounds,
} from './mc-console.js'

/**
 * The seam between `ReflexExecutor` and `MineflayerExecutor`.
 *
 * **This file exists because that seam had no test at all.** Task 2's 28
 * arbiter tests run against `MockExecutor`, which has no pathfinder; Tasks 3, 4
 * and 6a test the real executor without ever wrapping it. The only composition
 * proof was `demo:phase5`, and every preemption it has ever recorded preempted
 * `idle`, `moveTo` or `mineBlock` — the three actions that happen NOT to clear a
 * pathfinder goal late. The whole-branch review of Phase 5 found a defect living
 * exactly in that blind spot, and this is its regression test.
 *
 * The defect: the pathfinder holds ONE goal for the whole bot, and a reflex
 * recovery runs concurrently with the action it preempted (by design — rulings
 * R13, R20, R21). `followPlayer`'s cleanup cleared that goal unconditionally, so
 * it destroyed the RECOVERY's goal, the recovery reported
 * `interrupted`/'path stopped before completion', and because its own controller
 * was never aborted `runRecovery` counted it a FAILURE. Three of those disarm
 * every attack trigger — a bot that stops defending itself while following a
 * player. See `clearPathfinderGoal`'s comment for the microtask-level trace.
 */
const ARENA: ArenaBounds = {
  x0: 1950,
  x1: 1970,
  z0: 0,
  z1: 8,
  floorY: 199,
  clearance: 6,
  enclosed: true,
}
const FLOOR = ARENA.floorY + 1

/**
 * The same enclosed arena the combat tests use, and for the same measured
 * reasons (spec §4.1-4.2): under open sky a `PersistenceRequired` zombie on this
 * platform burns to death in 21 seconds, a hostile pathing at the bot walks off
 * a platform floating ~130 blocks up, and an unlit sealed box breeds its own
 * hostiles — hence the glowstone ceiling. Reusing the bounds is safe because
 * `fileParallelism: false` means no two integration files run at once, and every
 * test here rebuilds the arena from scratch in `beforeEach`.
 */
const ARENA_VOLUME = arenaVolume(ARENA)

const FOLLOWER = 'ITSeamFollow'
const TARGET = 'ITSeamTarget'

const FOLLOWER_START = { x: 1953, y: FLOOR, z: 4 }
/** Far enough that `followPlayer` has somewhere to walk, well inside the walls. */
const TARGET_START = { x: 1966, y: FLOOR, z: 4 }
/**
 * Two blocks from the follower — inside the 8-block attack radius, so
 * `entityNearby` fires, and already within reach, so the recovery's approach is
 * short and the test does not hinge on a long walk.
 */
const MOB_SPAWN = { x: 1955, y: FLOOR, z: 4 }

const MOB_TAG = 'itseam'

type Pos = { x: number; y: number; z: number }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))




describe('ReflexExecutor over MineflayerExecutor', () => {
  let follower: MineflayerExecutor | null = null
  let target: MineflayerExecutor | null = null

  beforeEach(async () => {
    await buildArena(ARENA)
    // Hostiles are removed instantly on Peaceful. Standing permission, spec §4
    // Decision 2; restored in afterEach's `finally` so a failing test puts it back.
    sendConsoleCommand('difficulty easy')
  })

  afterEach(async () => {
    try {
      // Separate `try`s: a throwing first disconnect must not leak the second
      // bot onto the shared server.
      try {
        await follower?.disconnect()
      } finally {
        await target?.disconnect()
      }
      follower = null
      target = null
    } finally {
      sendConsoleCommand('difficulty peaceful')
      sendConsoleCommand(`kill @e[type=!player,${ARENA_VOLUME}]`)
      // A killed mob's loot spawns AFTER the kill, so the sweep needs a second
      // pass — measured in Task 6a.
      await sleep(500)
      await sweepArenaUntilEmpty(ARENA)
      await expectDifficultyPeaceful()
    }
  })

  function summonZombie(at: Pos): void {
    sendConsoleCommand(
      `summon zombie ${at.x} ${at.y} ${at.z} {PersistenceRequired:1b,Tags:["${MOB_TAG}"]}`,
    )
  }

  it('does not destroy the reflex recovery’s pathfinder goal when it preempts followPlayer', async () => {
    // --- the pair, the follower wrapped in the arbiter ---
    const inner = (follower = new MineflayerExecutor({ username: FOLLOWER }))
    expect((await inner.connect()).ok).toBe(true)
    await teleportAndWait(inner, FOLLOWER, FOLLOWER_START)
    await waitForOnGround(inner, { expectedY: FOLLOWER_START.y })
    // Bare hands: a swing's damage depends on what is held, and an empty
    // inventory also keeps the pathfinder from having scaffolding to pillar with.
    clearInventory(FOLLOWER)
    await waitUntil(
      () => inner.getState().self.inventory.length === 0,
      'the follower still held items after /clear',
    )

    const t = (target = new MineflayerExecutor({ username: TARGET }))
    expect((await t.connect()).ok).toBe(true)
    await teleportAndWait(t, TARGET, TARGET_START)
    await waitForOnGround(t, { expectedY: TARGET_START.y })

    const reflex = new ReflexExecutor(inner)

    // --- followPlayer left in flight, deliberately not awaited ---
    // It settles only on an abort, the target leaving, or the connection ending,
    // so the preemption below lands on a LIVE action holding a live goal. That
    // is the whole point: an `idle` preemption cannot reproduce this.
    const following = reflex.followPlayer(TARGET)
    // Let the follow actually set its goal before the trigger fires. Without
    // this the test can preempt `idle` and pass while proving nothing.
    await waitUntil(
      () => inner.getState().self.position.x > FOLLOWER_START.x + 0.5,
      'the follower never started moving, so followPlayer never held a live goal',
    )

    // --- the trigger ---
    summonZombie(MOB_SPAWN)

    const settled = (): ReflexPreemption | undefined =>
      reflex.preemptions.find((p) => p.action === 'followPlayer' && p.recovery !== null)
    await waitUntil(
      () => settled() !== undefined,
      'no preemption of followPlayer ever settled — either the zombie never came ' +
        'within the 8-block radius, or difficulty is still peaceful (which removes ' +
        'hostiles instantly)',
    )

    const p = settled()
    expect(p).toBeDefined()
    const recovery = p?.recovery as Result<unknown>

    // The regression, asserted first so its failure message is the precise one.
    // Before the fix this was exactly `interrupted` / 'path stopped before
    // completion': followPlayer's cleanup cleared the goal the recovery had just
    // set, `goto` rejected GoalChanged, and the arbiter counted a failure for an
    // attack that was never attempted.
    if (!recovery.ok) {
      expect(
        `${recovery.reason}: ${recovery.detail ?? ''}`,
        'the attack recovery was killed by the preempted followPlayer’s goal clear',
      ).not.toMatch(/path stopped before completion/)
    }
    // And the positive: an adjacent zombie is a recovery that should simply work.
    expect(recovery.ok, `recovery failed: ${JSON.stringify(recovery)}`).toBe(true)

    // --- unwind ---
    // `stop()` is synchronous (it aborts; it does not wait), so the follow is
    // awaited separately to keep the action from outliving the test.
    reflex.stop()
    await following
  })
})
