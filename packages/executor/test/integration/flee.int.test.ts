import { describe, it, expect, afterEach, beforeEach } from 'vitest'
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
 * Task 6b: `flee`. Agreed 2026-09-14 (Phase 5 spec §7, Decision 4) — aim for
 * **100 blocks** from the nearest hostile, bounded by **10 seconds**, with the
 * 100 as a target rather than a requirement.
 *
 * **A CORRIDOR, not a square, and it is 120 blocks long for a measured reason.**
 * `flee` generates candidate destinations out at its target distance, and the
 * pathfinder plans to the candidate — so if no candidate is pathable the bot
 * does not move at all. A 20-block arena like the combat one puts every
 * 100-block candidate in the void off the platform's edge, which would make this
 * test assert `unreachable` and prove nothing about fleeing. 120 long means the
 * due-east candidate at radius 100 is on solid floor, so the real escape path
 * gets exercised. The bot cannot reach it inside 10s anyway — 100 blocks needs
 * ≥17.9s at the measured 5.60 blocks/sec — which is exactly the truncation the
 * agreement anticipates.
 *
 * **Enclosed**, because the mob is the point: an undead mob under open sky on
 * this platform burns to death in 21 seconds (spec §4.1), and a hostile pathing
 * at the bot walks off a platform floating ~130 blocks above real terrain.
 *
 * Placed at **z≈1000**, ~1000 blocks clear of every other fixture. The corridor
 * along z 0-8 is occupied from x800 to x2170 and could not hold this without
 * abutting the force-loaded benchmark world.
 */
const ARENA: ArenaBounds = {
  x0: 1000,
  x1: 1120,
  z0: 1000,
  z1: 1012,
  floorY: 199,
  clearance: 6,
  enclosed: true,
}
const FLOOR = ARENA.floorY + 1

const ARENA_VOLUME =
  `x=${ARENA.x0},y=${ARENA.floorY},z=${ARENA.z0},` +
  `dx=${ARENA.x1 - ARENA.x0},dy=${(ARENA.clearance ?? 6) + 1},dz=${ARENA.z1 - ARENA.z0}`

const RUNNER = 'ITFlee'
const MOB_TAG = 'itflee'

/** Near the WEST wall, so the whole corridor is open to the east to run down. */
const START = { x: 1005, y: FLOOR, z: 1006 }
/** Three blocks west of the bot: close enough to be the thing being fled. */
const MOB_SPAWN = { x: 1002, y: FLOOR, z: 1006 }

/**
 * A sealed 1x1 pocket against the west wall, for the `unreachable` case — plan
 * Task 6b Step 5. The bot stands in it with a hostile adjacent and has nowhere
 * to go that is further away, so no candidate can succeed.
 */
const BOX_AT = { x: 1004, y: FLOOR, z: 1002 }

type Pos = { x: number; y: number; z: number }
const dist = (a: Pos, b: Pos): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitUntil(
  predicate: () => boolean,
  complaint: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() >= deadline) throw new Error(`${complaint} (within ${timeoutMs}ms)`)
    await sleep(150)
  }
}

async function sweepArenaUntilEmpty(attempts = 4): Promise<void> {
  let last = ''
  for (let i = 0; i < attempts; i++) {
    sendConsoleCommand(`kill @e[type=item,${ARENA_VOLUME}]`)
    const m = await queryConsole(
      `kill @e[type=!player,${ARENA_VOLUME}]`,
      /No entity was found|Killed /,
    )
    last = m[0] ?? ''
    if (last.includes('No entity was found')) return
    await sleep(500)
  }
  throw new Error(`the arena still held entities after ${attempts} sweeps (last reply: ${last})`)
}

async function expectDifficultyPeaceful(): Promise<void> {
  const d = await queryConsole('difficulty', /The difficulty is (\w+)/)
  if (d[1] !== 'Peaceful') throw new Error(`difficulty was NOT restored (reports ${d[1]})`)
}

describe('MineflayerExecutor.flee', () => {
  let runner: MineflayerExecutor | null = null

  beforeEach(async () => {
    await buildArena(ARENA)
    // Hostiles are removed instantly on Peaceful. Standing permission, spec §4
    // Decision 2; restored in afterEach's `finally`.
    sendConsoleCommand('difficulty easy')
  })

  afterEach(async () => {
    try {
      await runner?.disconnect()
      runner = null
    } finally {
      sendConsoleCommand('difficulty peaceful')
      sendConsoleCommand(`kill @e[type=!player,${ARENA_VOLUME}]`)
      // A killed mob's loot spawns AFTER the kill, so one sweep cannot catch
      // both — measured in Task 6a.
      await sleep(500)
      await sweepArenaUntilEmpty()
      await expectDifficultyPeaceful()
    }
  })

  /** Empty-handed, so nothing in the inventory can be used as scaffolding. */
  async function runnerAt(start: Pos): Promise<MineflayerExecutor> {
    const e = (runner = new MineflayerExecutor({ username: RUNNER }))
    expect((await e.connect()).ok).toBe(true)
    await teleportAndWait(e, RUNNER, start)
    await waitForOnGround(e, { expectedY: start.y })
    clearInventory(RUNNER)
    await waitUntil(
      () => e.getState().self.inventory.length === 0,
      'the runner still held items after /clear',
    )
    return e
  }

  function summonZombie(at: Pos): void {
    sendConsoleCommand(
      `summon zombie ${at.x} ${at.y} ${at.z} {PersistenceRequired:1b,Tags:["${MOB_TAG}"]}`,
    )
  }

  /** The hostile as the bot sees it, or null. */
  const hostile = (e: MineflayerExecutor): { position: Pos } | null =>
    e.getState().nearbyEntities.find((x) => x.kind === 'hostile') ?? null

  it('resolves ok with fled: false when there is no hostile', async () => {
    const e = await runnerAt(START)
    const before = e.getState().self.position

    const r = await e.flee({ timeoutMs: 12_000 })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (r.ok) expect(r.value.fled).toBe(false)

    // Nothing to flee from means it should not have wandered off either.
    const after = e.getState().self.position
    expect(dist(before, after)).toBeLessThan(2)
  })

  it('resolves ok with fled: true and ends further from the mob than it started', async () => {
    const e = await runnerAt(START)
    summonZombie(MOB_SPAWN)
    await waitUntil(
      () => hostile(e) !== null,
      'the summoned zombie never appeared among the bot’s nearby entities — either ' +
        'the summon failed, or difficulty is still peaceful (which removes hostiles at once)',
    )

    const startSelf = e.getState().self.position
    const startGap = dist(startSelf, hostile(e)!.position)

    const r = await e.flee({ timeoutMs: 15_000 })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (r.ok) expect(r.value.fled).toBe(true)

    // Verified against the world, not inferred from the promise resolving:
    // goto() resolves ok on a zero-length path, so a resolved promise is not
    // evidence the bot moved (plan Task 6b Step 4).
    const endSelf = e.getState().self.position
    const mobNow = hostile(e)
    expect(dist(startSelf, endSelf)).toBeGreaterThan(10)
    if (mobNow) expect(dist(endSelf, mobNow.position)).toBeGreaterThan(startGap)
  })

  it('fails unreachable when sealed in with a hostile outside the wall', async () => {
    // Plan Task 6b Step 5: prove the guard fires.
    //
    // FIRST ATTEMPT WAS WRONG, and usefully so: it walled four sides and left
    // the mob's own cell as the fifth opening, on the assumption that a zombie
    // standing in a doorway blocks it. Entities do not obstruct the pathfinder —
    // the bot walked straight past it and `flee` correctly returned
    // `ok({ fled: true })`. So the seal has to be total, and the hostile has to
    // be OUTSIDE it: what makes this `unreachable` is that no candidate is
    // reachable, not that the mob is in the way.
    //
    // The mob is still seen from in there: `nearbyEntities` is distance-based,
    // not line-of-sight, which is the same asymmetry CLAUDE.md records for the
    // server's own reach checks.
    const e = await runnerAt(BOX_AT)
    const { x, z } = BOX_AT
    for (const [wx, wz] of [
      [x - 1, z],
      [x + 1, z],
      [x, z - 1],
      [x, z + 1],
    ]) {
      sendConsoleCommand(`fill ${wx} ${FLOOR} ${wz} ${wx} ${FLOOR + 1} ${wz} stone`)
    }
    // A lid, so the only remaining option — pillaring out — is closed too. The
    // inventory is already empty, so there is nothing to pillar with either.
    sendConsoleCommand(`setblock ${x} ${FLOOR + 2} ${z} stone`)
    await sleep(700)
    // Outside the box, well inside the 8-block reflex radius.
    summonZombie({ x: x + 3, y: FLOOR, z })
    await waitUntil(
      () => hostile(e) !== null,
      'the zombie never appeared among the sealed-in bot’s nearby entities',
    )

    const r = await e.flee({ timeoutMs: 15_000 })
    expect(r.ok, `expected a failure, got ${JSON.stringify(r)}`).toBe(false)
    if (!r.ok) expect(r.reason, r.detail).toBe('unreachable')
    // And it did not somehow leave the box.
    const end = e.getState().self.position
    expect(Math.abs(end.x - BOX_AT.x)).toBeLessThan(1.5)
    expect(Math.abs(end.z - BOX_AT.z)).toBeLessThan(1.5)
  })
})
