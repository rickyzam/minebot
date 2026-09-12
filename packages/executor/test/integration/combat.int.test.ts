import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import type { EntityInfo, Result } from '@minebot/contract'
import { MineflayerExecutor } from '../../src/index.js'
import {
  buildArena,
  clearInventory,
  queryConsole,
  sendConsoleCommand,
  teleportAndWait,
  waitForOnGround,
  type ArenaBounds,
} from './mc-console.js'

/**
 * The Phase 5 combat arena, **enclosed** — floor, four walls and a glowstone
 * ceiling. Both halves are load-bearing and both are measured, not assumed
 * (spec §4.1-4.2): under open sky a named, `PersistenceRequired` zombie on the
 * y=199 platform burned to death at 21 seconds, and a hostile pathing at the
 * bot walks off a platform floating ~130 blocks above real terrain. The
 * glowstone is what stops the sealed box breeding its own hostiles.
 *
 * Clear of every other arena by ≥80 blocks, so nothing here can see or chase
 * another test's fixtures.
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

/** Walls sit inside the cleared volume, so the usable floor is one block in. */
const INTERIOR = { x0: ARENA.x0 + 1, x1: ARENA.x1 - 1, z0: ARENA.z0 + 1, z1: ARENA.z1 - 1 }

/**
 * The arena expressed as a selector volume, so cleanup reaches everything
 * inside it and nothing outside it. `dy` covers the floor through the ceiling.
 */
const ARENA_VOLUME =
  `x=${ARENA.x0},y=${ARENA.floorY},z=${ARENA.z0},` +
  `dx=${ARENA.x1 - ARENA.x0},dy=${(ARENA.clearance ?? 6) + 1},dz=${ARENA.z1 - ARENA.z0}`

const ATTACKER = 'ITCombat'
const WATCHER = 'ITCombatWatch'

/** Where the attacker starts: the west end of the arena. */
const BOT_START = { x: 1953, y: FLOOR, z: 4 }
/** Nine blocks east of the bot, so reaching it is a walk and not a no-op. */
const MOB_SPAWN = { x: 1962, y: FLOOR, z: 4 }
/** A second connection's viewpoint, clear of the fight. */
const WATCH_VIEW = { x: 1952, y: FLOOR, z: 7 }

/**
 * Tags the mobs this file summons, so cleanup kills exactly ours and the
 * health query reads exactly ours. A custom name would also do, but a tag
 * survives `data get` and selector syntax without quoting a text component.
 */
const MOB_TAG = 'itcombat'

/**
 * A solid stone block with a sealed 1×1×2 pocket at its centre, for the
 * `unreachable` case. Three blocks of stone on every side, which is the point:
 * with a thinner wall the nearest standing position outside would be within
 * `ATTACK_REACH` of the mob inside, and the swing would land **through the
 * wall** — the server checks distance for an attack, not line of sight. At
 * three blocks the closest the bot can stand is 4 away, so no approach can
 * satisfy the goal and the pathfinder has to report there is no path.
 *
 * Sits inside the cleared volume, so `buildArena` erases it for the next test.
 */
const CHAMBER = { x0: 1963, x1: 1969, z0: 1, z1: 7, y0: FLOOR, y1: FLOOR + 4 }
const CHAMBER_POCKET = { x: 1966, y: FLOOR, z: 4 }

type Pos = { x: number; y: number; z: number }
const dist = (a: Pos, b: Pos): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Sweep the arena until the SERVER itself says nothing is left in it.
 *
 * Cleanup that fires commands and never reads the answer is precisely the
 * fixture that can no-op without shouting, which this repo rates as worse than
 * no fixture at all — and it is guarding shared world state that outlives the
 * run. `sendConsoleCommand` throws only when tmux is unreachable, so a command
 * the server rejected, or a drop that landed a moment too late, would leak in
 * silence. Reading the kill back turns that into a loud failure.
 *
 * Loops rather than trusting one delay: a killed mob's loot spawns AFTER the
 * kill that produced it (measured — see the `afterEach`), so the pass that
 * removes the mob cannot also remove its flesh, and how long the drop takes to
 * appear is not something a fixed sleep should be asked to guarantee.
 */
async function sweepArenaUntilEmpty(attempts = 4): Promise<void> {
  let last = ''
  for (let i = 0; i < attempts; i++) {
    sendConsoleCommand(`kill @e[type=item,${ARENA_VOLUME}]`)
    // An empty selector answers "No entity was found"; a non-empty one answers
    // "Killed …". Either is a valid reply — only the former ends the sweep.
    const m = await queryConsole(
      `kill @e[type=!player,${ARENA_VOLUME}]`,
      /No entity was found|Killed /,
    )
    last = m[0] ?? ''
    if (last.includes('No entity was found')) return
    await sleep(500)
  }
  expect(last, `the arena still held entities after ${attempts} sweeps`).toContain(
    'No entity was found',
  )
}

/**
 * Read the difficulty back. It is the one piece of global, world-wide state
 * this file changes, so "the restore command was sent" is not good enough —
 * a restore that silently failed would leave the shared dev server on a combat
 * difficulty for everyone.
 */
async function expectDifficultyPeaceful(): Promise<void> {
  const m = await queryConsole('difficulty', /The difficulty is (\w+)/)
  expect(
    m[1],
    'the difficulty was NOT restored — the shared server is left on a combat difficulty',
  ).toBe('Peaceful')
}

describe('MineflayerExecutor.attack', () => {
  let attacker: MineflayerExecutor | null = null
  let watcher: MineflayerExecutor | null = null
  /** Every `death` event the attacker emitted during the current test. */
  let deaths: number[] = []

  beforeEach(async () => {
    await buildArena(ARENA)
    // Hostiles are removed instantly on Peaceful, so nothing combat-related can
    // run without this. Standing permission, spec §4 Decision 2. Restored in
    // afterEach's `finally`, so a failing test still puts it back.
    sendConsoleCommand('difficulty easy')
    deaths = []
  })

  afterEach(async () => {
    try {
      await attacker?.disconnect()
      await watcher?.disconnect()
      attacker = null
      watcher = null
    } finally {
      // Difficulty FIRST: it is the shared, world-wide state, so it is the one
      // thing that must be put back even if everything after it fails. It also
      // does half the cleanup on its own — Peaceful removes existing hostiles
      // immediately, which is why nothing combat-related can run under it.
      sendConsoleCommand('difficulty peaceful')
      // `type=!player` rather than `tag=itcombat`: it also catches anything
      // that spawned on its own, and the bots are players so they are never in
      // scope. Scoped to the arena volume, so a concurrent test elsewhere in
      // the world is untouched.
      sendConsoleCommand(`kill @e[type=!player,${ARENA_VOLUME}]`)
      // Then the drops, in a SECOND pass.
      //
      // MEASURED 2026-09-12: a killed zombie's rotten flesh spawns *after* the
      // kill that produced it, so one sweep cannot remove both — the flesh did
      // not exist when the sweep ran. Every test but the last one hid this,
      // because the next `buildArena` kills items in the arena; the final test
      // of a run left its drop in the world. A drop is an entity, so `/fill`
      // would not have removed it either.
      await sleep(500)
      // Both of these read the SERVER back rather than firing and hoping, so a
      // cleanup that did not take fails the run instead of leaking quietly.
      await sweepArenaUntilEmpty()
      await expectDifficultyPeaceful()
    }
  })

  /**
   * The attacker on the arena floor, empty-handed, with its deaths recorded.
   *
   * Bare hands are deliberate: a swing's damage depends on what is held, and
   * the hit-point assertions below are arithmetic about one bare-handed swing.
   * The `death` subscription is taken before `connect()` — handlers live on the
   * executor, not on a Bot — so nothing can be missed in the connect window.
   */
  async function attackerAt(start: Pos, build?: () => void): Promise<MineflayerExecutor> {
    build?.()
    // Assigned before connecting, so afterEach disconnects even a failed setup.
    const e = (attacker = new MineflayerExecutor({ username: ATTACKER }))
    e.on('death', () => deaths.push(Date.now()))
    expect((await e.connect()).ok).toBe(true)
    await teleportAndWait(e, ATTACKER, start)
    await waitForOnGround(e, { expectedY: start.y })
    clearInventory(ATTACKER)
    await waitUntil(
      () => e.getState().self.inventory.length === 0,
      'the attacker still held items after /clear',
    )
    return e
  }

  function summonZombie(at: Pos): void {
    // PersistenceRequired stops it despawning. It does NOT stop it burning —
    // that is the ceiling's job (spec §4.1: PersistenceRequired was tried, and
    // the mob still burned to death at 21 seconds under open sky).
    sendConsoleCommand(
      `summon zombie ${at.x} ${at.y} ${at.z} {PersistenceRequired:1b,Tags:["${MOB_TAG}"]}`,
    )
  }

  /**
   * The mob's hit points **as the server records them**, or null when it is
   * gone.
   *
   * This has to come from the server. MEASURED 2026-09-12 against mineflayer
   * 4.39.0: `entity.health` is assigned in exactly two places — the bot itself
   * (`plugins/health.js:25`) and boss bars (`plugins/boss_bar.js:33`) — so
   * `nearbyEntities[].health` is `undefined` for a mob on EVERY connection.
   *
   * That is a statement about what mineflayer *reports*, not about what
   * arrives: the health metadata does reach the client and persists in
   * `entity.metadata` (`entities.js:456-457`), keyed by metadata index. What is
   * missing is any code surfacing it as `entity.health`, and the executor does
   * not expose raw metadata.
   *
   * Either way no connection can witness that a mob lost hit points. The
   * console is the server's own record, which is strictly stronger evidence
   * than any client's view; the second connection below still provides
   * independent confirmation that the mob is present and where the fight said
   * it was.
   */
  async function serverMobHealth(): Promise<number | null> {
    const m = await queryConsole(
      `data get entity @e[tag=${MOB_TAG},limit=1] Health`,
      /has the following entity data: ([0-9.]+)f|No entity was found/,
    )
    return m[1] === undefined ? null : Number(m[1])
  }

  /** Polls the attacker's own snapshot until it reports a zombie, and returns it. */
  async function waitForZombie(e: MineflayerExecutor, timeoutMs = 15_000): Promise<EntityInfo> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const seen = e.getState().nearbyEntities.find((x) => x.name === 'zombie')
      if (seen) return seen
      if (Date.now() >= deadline) {
        throw new Error(
          `waitForZombie: the summoned zombie never appeared among the bot's nearby entities ` +
            `within ${timeoutMs}ms. Saw: ${JSON.stringify(
              e.getState().nearbyEntities.map((x) => `${x.name}/${x.kind}`),
            )}. Either the summon failed, or difficulty is still peaceful (which removes ` +
            `hostiles instantly).`,
        )
      }
      await sleep(150)
    }
  }

  /** The inverse: polls until the attacker no longer tracks `entityId`. */
  async function waitForEntityGone(
    e: MineflayerExecutor,
    entityId: number,
    timeoutMs = 10_000,
  ): Promise<void> {
    await waitUntil(
      () => !e.getState().nearbyEntities.some((x) => x.id === entityId),
      `entity ${entityId} was still tracked ${timeoutMs}ms after being killed`,
      timeoutMs,
    )
  }

  async function waitUntil(
    predicate: () => boolean,
    complaint: string,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (predicate()) return
      if (Date.now() >= deadline) throw new Error(`${complaint} (within ${timeoutMs}ms)`)
      await sleep(150)
    }
  }

  /**
   * The attacker is alive, and still where the fight happened.
   *
   * Health alone cannot see a death: Mineflayer respawns automatically, so a
   * bot that died reads 20 health a moment later — at world spawn, hundreds of
   * blocks away. The `death` event and the arena bounds are what actually
   * catch it, and they must, because every assertion after a silent death
   * would be measuring a different bot in a different place.
   */
  function expectAttackerAliveInArena(e: MineflayerExecutor): void {
    const self = e.getState().self
    expect(deaths, 'the attacker DIED during the test — every later assertion is void').toEqual([])
    expect(self.health).toBeGreaterThan(0)
    expect(
      self.position.x > INTERIOR.x0 - 1 &&
        self.position.x < INTERIOR.x1 + 2 &&
        self.position.z > INTERIOR.z0 - 1 &&
        self.position.z < INTERIOR.z1 + 2 &&
        Math.abs(self.position.y - FLOOR) < 3,
      `the attacker left the arena: ${JSON.stringify(self.position)}`,
    ).toBe(true)
  }

  const expectReason = (r: Result<unknown>, reason: string): void => {
    expect(r.ok, JSON.stringify(r)).toBe(false)
    if (!r.ok) expect(r.reason, r.detail).toBe(reason)
  }

  it('sees the zombie as hostile, walks into reach, and lands exactly one swing', async () => {
    const e = await attackerAt(BOT_START)
    summonZombie(MOB_SPAWN)
    const zombie = await waitForZombie(e)

    // THE measurement the whole reflex chain rests on, asserted before anything
    // else: `evaluateReflex` only ever fires on `kind === 'hostile'`, and
    // `classifyEntity` derives that from Mineflayer's `entity.kind`, which is
    // minecraft-data's `category`. Plausible, and until now unmeasured against
    // a live mob.
    expect(zombie.kind).toBe('hostile')
    expect(zombie.name).toBe('zombie')
    // Mob hit points are not perceivable on any connection — see
    // serverMobHealth. Asserted so the day Mineflayer starts tracking them,
    // this test says so rather than the verification quietly weakening.
    expect(zombie.health).toBeUndefined()

    const before = await serverMobHealth()
    expect(before).toBe(20)

    const startedAt = e.getState().self.position
    const gap = dist(startedAt, zombie.position)
    const r = await e.attack(zombie.id, { timeoutMs: 10_000 })
    expect(r, JSON.stringify(r)).toEqual({ ok: true, value: undefined })

    // Still ALIVE at the assertion point, not merely at the start — a mob that
    // died mid-approach would make every "it took damage" reading meaningless.
    const after = await serverMobHealth()
    expect(after, 'the zombie was gone by the assertion point').not.toBeNull()
    expect(after!).toBeGreaterThan(0)

    // It took damage, and only about one swing's worth. A bare hand does 1.0,
    // and a zombie's 2 armour points absorb 8% of it, so one swing leaves
    // ~19.08 and a critical (1.5x) no less than ~18.62; two landed swings could
    // not leave more than ~18.16. The upper bound is what says "one swing, not
    // a fight to the death" — the contract's own words.
    expect(after!).toBeLessThan(20)
    expect(after!).toBeGreaterThan(18.4)

    expectAttackerAliveInArena(e)
    // Independent confirmation from a SECOND connection that the mob is there
    // and where the fight said it was. It cannot see hit points (nothing can),
    // so this is liveness and position, with the server owning the damage.
    const w = (watcher = new MineflayerExecutor({ username: WATCHER }))
    expect((await w.connect()).ok).toBe(true)
    await teleportAndWait(w, WATCHER, WATCH_VIEW)
    await waitForOnGround(w, { expectedY: FLOOR })
    const seenByWatcher = await waitForZombie(w)
    expect(seenByWatcher.kind).toBe('hostile')
    expect(Math.abs(seenByWatcher.position.y - FLOOR)).toBeLessThan(2)

    // Reported for the record rather than asserted: the mob closes the gap
    // itself, so how much of it the bot walked is not under the test's control.
    expect(gap).toBeGreaterThan(0)
  })

  it('fails not_found once the entity is gone', async () => {
    const e = await attackerAt(BOT_START)
    summonZombie(MOB_SPAWN)
    const zombie = await waitForZombie(e)

    sendConsoleCommand(`kill @e[tag=${MOB_TAG}]`)
    await waitForEntityGone(e, zombie.id)
    expect(await serverMobHealth()).toBeNull()

    const started = Date.now()
    const r = await e.attack(zombie.id, { timeoutMs: 10_000 })
    expectReason(r, 'not_found')
    // Rejected before moving: resolving the entity is the first thing it does.
    expect(Date.now() - started).toBeLessThan(1_000)
    expectAttackerAliveInArena(e)
  })

  // Ruling R9 — executor behaviour, deliberately NOT written into the contract's
  // doc comment, which is shared surface and not yet agreed with Track B.
  it('fails unreachable for a mob sealed where the bot cannot path', async () => {
    const e = await attackerAt(BOT_START, () => {
      sendConsoleCommand(
        `fill ${CHAMBER.x0} ${CHAMBER.y0} ${CHAMBER.z0} ${CHAMBER.x1} ${CHAMBER.y1} ` +
          `${CHAMBER.z1} stone`,
      )
      sendConsoleCommand(
        `fill ${CHAMBER_POCKET.x} ${CHAMBER_POCKET.y} ${CHAMBER_POCKET.z} ` +
          `${CHAMBER_POCKET.x} ${CHAMBER_POCKET.y + 1} ${CHAMBER_POCKET.z} air`,
      )
    })
    summonZombie(CHAMBER_POCKET)
    const zombie = await waitForZombie(e)
    // The precondition: it is tracked (so this is not `not_found` in disguise)
    // and far enough that no legal standing position is within reach.
    expect(dist(e.getState().self.position, zombie.position)).toBeGreaterThan(4)

    const before = e.getState().self.position
    const started = Date.now()
    const r = await e.attack(zombie.id, { timeoutMs: 10_000 })
    expectReason(r, 'unreachable')
    // WHICH `unreachable` — three paths produce that one reason, and only the
    // detail tells them apart:
    //   'no path to the target'                     gotoGoal, A* reported NoPath
    //   'the pathfinder stopped short of the goal'  gotoGoal, goto() resolved on
    //                                               a zero-length path
    //   'entity N is X blocks away'                 attack's own reach check
    //
    // MEASURED 2026-09-12: this is the FIRST — A* genuinely finds no path, in
    // ~2.0s. Asserting the reason alone would not notice it changing.
    //
    // That distinction is worth a test because the failure mode is silent and
    // bad: `searchRadius: 128` is what buys the honest NoPath here. Left
    // unbounded (-1), an unreachable target instead burns the whole 5s
    // thinkTimeout and reports `timeout` (CLAUDE.md), which tells the planner
    // "retry" about a mob sealed inside three blocks of stone.
    if (!r.ok) expect(r.detail).toBe('no path to the target')
    expect(Date.now() - started).toBeLessThan(10_000)

    // The mob is untouched — the swing must not have landed through three
    // blocks of stone, which the server would have allowed on distance alone.
    expect(await serverMobHealth()).toBe(20)

    // And the follow goal was cleared on the way out. GoalFollow is dynamic:
    // left set, the bot would still be walking at the mob long after the caller
    // was told there was no path. Task 4 learned this the hard way.
    await sleep(3_000)
    const after = e.getState().self.position
    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeLessThan(2)
    expectAttackerAliveInArena(e)
  })
})
