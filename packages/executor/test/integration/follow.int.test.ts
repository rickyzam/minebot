import { describe, it, expect, afterEach } from 'vitest'
import type { Result } from '@minebot/contract'
import { MineflayerExecutor } from '../../src/index.js'
import {
  buildArena,
  teleportAndWait,
  waitForOnGround,
  waitForPlayerGone,
  waitForPlayerVisible,
  type ArenaBounds,
} from './mc-console.js'

/**
 * The Phase 5 arena Task 4 shares, clear of every other arena by far more than
 * anything here searches.
 */
const ARENA: ArenaBounds = { x0: 1850, x1: 1870, z0: 0, z1: 8, floorY: 199, clearance: 6 }
const FLOOR = ARENA.floorY + 1

/**
 * Somewhere the follower cannot see. Players are tracked out to the server's
 * view distance at most — 16 or 32 chunks, 256 or 512 blocks, on this dev
 * server — so 800 blocks is out of range either way. Built as an arena like
 * the other, so the target lands on a floor rather than falling 130 blocks
 * while the test waits.
 */
const FAR_ARENA: ArenaBounds = { x0: 1850, x1: 1856, z0: 800, z1: 804, floorY: 199, clearance: 6 }
const FAR = { x: 1853, y: FLOOR, z: 802 }

const FOLLOWER = 'ITFollower'
const TARGET = 'ITFollowTarget'

const FOLLOWER_START = { x: 1856, y: FLOOR, z: 4 }
const TARGET_START = { x: 1860, y: FLOOR, z: 4 }
/** ~10 blocks from wherever the follower settles near TARGET_START. */
const TARGET_EAST = { x: 1868, y: FLOOR, z: 4 }
/** ~15 blocks back the other way. */
const TARGET_WEST = { x: 1852, y: FLOOR, z: 4 }

/** How close counts as "caught up". The brief's bar; the follow range is 2. */
const CAUGHT_UP = 4

type Pos = { x: number; y: number; z: number }
const dist = (a: Pos, b: Pos): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/** Resolves to `'pending'` if `p` has not settled within `ms`. */
const settledWithin = <T>(p: Promise<T>, ms: number): Promise<T | 'pending'> =>
  Promise.race([p, new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))])

describe('MineflayerExecutor.followPlayer', () => {
  let follower: MineflayerExecutor | null = null
  let target: MineflayerExecutor | null = null

  afterEach(async () => {
    await follower?.disconnect()
    await target?.disconnect()
    follower = null
    target = null
  })

  /** Both bots on the arena floor, 4 blocks apart, each visible to the follower. */
  async function pair(): Promise<{ f: MineflayerExecutor; t: MineflayerExecutor }> {
    await buildArena(ARENA)
    // Assigned before connecting, so afterEach disconnects even a failed setup.
    const f = (follower = new MineflayerExecutor({ username: FOLLOWER }))
    const t = (target = new MineflayerExecutor({ username: TARGET }))
    expect((await f.connect()).ok).toBe(true)
    expect((await t.connect()).ok).toBe(true)
    await teleportAndWait(f, FOLLOWER, FOLLOWER_START)
    await waitForOnGround(f, { expectedY: FLOOR })
    await teleportAndWait(t, TARGET, TARGET_START)
    await waitForOnGround(t, { expectedY: FLOOR })
    await waitForPlayerVisible(f, TARGET)
    return { f, t }
  }

  /** Move the target and prove the follower is now genuinely far from it. */
  async function sendTarget(f: MineflayerExecutor, t: MineflayerExecutor, to: Pos): Promise<void> {
    await teleportAndWait(t, TARGET, to)
    await waitForOnGround(t, { expectedY: FLOOR })
    // Without this the "caught up" assertion that follows could be satisfied by
    // a follower that never moved.
    expect(dist(f.getState().self.position, t.getState().self.position)).toBeGreaterThan(CAUGHT_UP)
  }

  /** Polls until the follower is within CAUGHT_UP of the target; returns the closest seen. */
  async function waitCaughtUp(
    f: MineflayerExecutor,
    t: MineflayerExecutor,
    timeoutMs = 20_000,
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs
    let closest = Infinity
    for (;;) {
      const d = dist(f.getState().self.position, t.getState().self.position)
      closest = Math.min(closest, d)
      if (d <= CAUGHT_UP || Date.now() >= deadline) return closest
      await new Promise((r) => setTimeout(r, 150))
    }
  }

  /**
   * Proves the follow goal was cleared: move the target away and check the
   * follower stays put. A goal left set after the call returned would keep the
   * bot walking after the caller was told the action had ended.
   */
  async function expectStaysPut(
    f: MineflayerExecutor,
    t: MineflayerExecutor,
    sendTo: Pos,
  ): Promise<void> {
    const before = f.getState().self.position
    await sendTarget(f, t, sendTo)
    await new Promise((r) => setTimeout(r, 3_000))
    const after = f.getState().self.position
    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeLessThan(1)
  }

  const expectReason = (r: Result | 'pending', reason: string): void => {
    expect(r).not.toBe('pending')
    if (r !== 'pending') {
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe(reason)
    }
  }

  it('re-targets a player teleported twice, and stops when aborted', async () => {
    const { f, t } = await pair()
    const controller = new AbortController()
    const pending = f.followPlayer(TARGET, { signal: controller.signal })

    try {
      for (const to of [TARGET_EAST, TARGET_WEST]) {
        await sendTarget(f, t, to)
        expect(await waitCaughtUp(f, t)).toBeLessThanOrEqual(CAUGHT_UP)
        // Following, not arriving: catching up must not end the call.
        expect(await settledWithin(pending, 500)).toBe('pending')
      }
    } finally {
      controller.abort()
    }

    const abortedAt = Date.now()
    const r = await settledWithin(pending, 2_000)
    expectReason(r, 'interrupted')
    expect(Date.now() - abortedAt).toBeLessThan(2_000)

    await expectStaysPut(f, t, TARGET_EAST)
  })

  it('resolves ok — not timeout — when a passed timeoutMs elapses, having followed', async () => {
    const { f, t } = await pair()
    await sendTarget(f, t, TARGET_EAST)

    const timeoutMs = 5_000
    const started = Date.now()
    const r = await f.followPlayer(TARGET, { timeoutMs })
    const elapsed = Date.now() - started

    expect(r).toEqual({ ok: true, value: undefined })
    // The lower bound catches a timer that fires early and reports ok.
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 50)
    expect(elapsed).toBeLessThan(timeoutMs + 3_000)
    // And it was following during those five seconds, not standing still.
    expect(dist(f.getState().self.position, t.getState().self.position)).toBeLessThanOrEqual(
      CAUGHT_UP,
    )

    await expectStaysPut(f, t, TARGET_WEST)
  })

  it('with no timeoutMs is still pending after 10s, then resolves interrupted on abort', async () => {
    const { f } = await pair()
    const controller = new AbortController()
    const pending = f.followPlayer(TARGET, { signal: controller.signal })
    try {
      // No default timeout. A timer armed with Infinity would have fired
      // after ~2ms; 10s also catches any short default slipping back in.
      expect(await settledWithin(pending, 10_000)).toBe('pending')
    } finally {
      controller.abort()
    }
    const abortedAt = Date.now()
    expectReason(await settledWithin(pending, 2_000), 'interrupted')
    expect(Date.now() - abortedAt).toBeLessThan(2_000)
  })

  it('resolves interrupted when stop() is called, with no options at all', async () => {
    const { f } = await pair()
    const pending = f.followPlayer(TARGET)
    expect(await settledWithin(pending, 1_500)).toBe('pending')
    f.stop()
    expectReason(await settledWithin(pending, 2_000), 'interrupted')
  })

  // Ruling R5 — executor behaviour, not (yet) in the agreed contract.

  it('fails not_found at once for a player who is not online', async () => {
    const { f } = await pair()
    const started = Date.now()
    // timeoutMs bounds the test only: without the guard this must not hang.
    const r = await settledWithin(f.followPlayer('ITNoSuchPlayer', { timeoutMs: 8_000 }), 10_000)
    expectReason(r, 'not_found')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('fails not_found at once for an online player out of sight', async () => {
    const { f, t } = await pair()
    await buildArena(FAR_ARENA)
    await teleportAndWait(t, TARGET, FAR)
    await waitForOnGround(t, { expectedY: FLOOR })
    // Proves the precondition as far as it can be proved from here: the target
    // has left THIS bot's snapshot radius. It does NOT prove the server stopped
    // tracking the player for us — an earlier comment claimed that, and a
    // snapshot is not evidence of it. What the test actually needs is only the
    // weaker fact: `bot.players[TARGET].entity` is undefined, which is what
    // makes `followPlayer` answer `not_found` rather than walk.
    await waitForPlayerGone(f, TARGET)

    const started = Date.now()
    const r = await settledWithin(f.followPlayer(TARGET, { timeoutMs: 8_000 }), 10_000)
    expectReason(r, 'not_found')
    // "At once" means before the 8s timeout could plausibly be what answered —
    // not a latency measurement. 1s was tight enough to flake on a loaded box
    // for a check whose only job is to separate the fast path from the timeout.
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('fails not_found when the followed player logs off mid-follow', async () => {
    const { f, t } = await pair()
    const controller = new AbortController()
    const pending = f.followPlayer(TARGET, { signal: controller.signal })
    try {
      expect(await settledWithin(pending, 1_500)).toBe('pending')
      await t.disconnect()
      target = null
      expectReason(await settledWithin(pending, 5_000), 'not_found')
    } finally {
      controller.abort()
    }
  })

  it('fails not_found when the followed player leaves range mid-follow', async () => {
    const { f, t } = await pair()
    await buildArena(FAR_ARENA)
    const controller = new AbortController()
    const pending = f.followPlayer(TARGET, { signal: controller.signal })
    try {
      expect(await settledWithin(pending, 1_500)).toBe('pending')
      await teleportAndWait(t, TARGET, FAR)
      expectReason(await settledWithin(pending, 5_000), 'not_found')
    } finally {
      controller.abort()
    }
    // Chasing a player it can no longer see would walk it off the platform.
    await waitForOnGround(f, { expectedY: FLOOR })
  })
})
