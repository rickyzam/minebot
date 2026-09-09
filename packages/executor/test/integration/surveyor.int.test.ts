import { describe, it, expect, afterEach } from 'vitest'
import { MineflayerExecutor } from '../../src/index.js'
import { surveyBlocks } from '../../../../scripts/bench-world.js'
import {
  buildArena,
  placeArenaBlock,
  sendConsoleCommand,
  teleportAndWait,
  waitForOnGround,
  type ArenaBounds,
} from './mc-console.js'

/**
 * `bench:world` measures GROUND TRUTH about the terrain. It must not go through
 * the bot's perception, and this is the test that says so.
 *
 * The regression it exists to catch happened for real on 2026-09-09: making
 * `findBlocks` line-of-sight limited silently broke `bench:world setup` and
 * `verify`, which died with EPIPE on every run. Two things went wrong at once —
 *
 *   - WRONG ANSWER. A surveyor asking "what can the bot see from here" cannot
 *     answer "did this setblock land", because a block encased in rock is
 *     invisible and still has to count. Measured: 2088 hits where the raw world
 *     model has 60000.
 *   - DROPPED CONNECTION. The filtered query took 4896ms against 99ms raw, and
 *     `surfaceProfile` issues four of them. ~20 seconds of synchronous work
 *     starves the keepalive Mineflayer answers on the same event loop, so the
 *     server closed the socket mid-scan.
 *
 * Nothing caught it: `bench:world` is in neither `npm test` nor the integration
 * suite, so the sweep after the perception change ran entirely green while the
 * tool was broken. That gap is what this file closes.
 *
 * The assertions are deliberately about CORRECTNESS rather than timing. A
 * wall-clock threshold would be the more direct guard against the second
 * failure, but it is machine-dependent and would flake; routing the surveyor
 * back through perception fails the encased-block assertion immediately and
 * deterministically, on any machine.
 */
const ARENA: ArenaBounds = { x0: 1500, x1: 1520, z0: 0, z1: 8, floorY: 199, clearance: 6 }
const START = { x: 1505, y: ARENA.floorY + 1, z: 4 }
/** Sealed inside a 3x3x3 stone shell: present in the world, visible to nobody. */
const ENCASED = { x: 1512, y: ARENA.floorY + 1, z: 4 }
/** In the open, so a fixture that placed nothing cannot pass as a fixture that worked. */
const EXPOSED = { x: 1500, y: ARENA.floorY + 1, z: 4 }
/** Does not occur in worldgen, so a hit is unambiguously ours. */
const MARKER = 'gold_block'

describe('the bench:world surveyor sees ground truth, not perception', () => {
  let executor: MineflayerExecutor | null = null

  afterEach(async () => {
    await executor?.disconnect()
    executor = null
  })

  const arena = async (username: string): Promise<MineflayerExecutor> => {
    await buildArena(ARENA)
    const e = new MineflayerExecutor({ username })
    const connected = await e.connect()
    if (!connected.ok) throw new Error(`could not connect: ${connected.reason}`)
    executor = e
    await teleportAndWait(e, username, START)
    await waitForOnGround(e, { expectedY: ARENA.floorY + 1 })
    sendConsoleCommand(
      `fill ${ENCASED.x - 1} ${ENCASED.y - 1} ${ENCASED.z - 1} ` +
        `${ENCASED.x + 1} ${ENCASED.y + 1} ${ENCASED.z + 1} stone`,
    )
    placeArenaBlock(ENCASED, MARKER)
    placeArenaBlock(EXPOSED, MARKER)
    await new Promise((r) => setTimeout(r, 1_000))
    return e
  }

  const at = (p: { x: number; y: number; z: number }) => (b: { position: typeof p }) =>
    b.position.x === p.x && b.position.y === p.y && b.position.z === p.z

  it('finds a block that perception cannot see, and agrees on one it can', async () => {
    const e = await arena('ITSurvey')

    // The control first: if this fails the fixture never placed anything, and
    // the encased assertion below would pass for the wrong reason.
    const perceived = e.findBlocks({ names: [MARKER], maxDistance: 32, limit: 20 })
    expect(perceived.some(at(EXPOSED))).toBe(true)
    expect(perceived.some(at(ENCASED))).toBe(false)

    const surveyed = surveyBlocks(e, [MARKER], 32, 1_000)
    expect(surveyed.some(at(EXPOSED))).toBe(true)
    // The whole point. Route this through findBlocks and this line goes red.
    expect(surveyed.some(at(ENCASED))).toBe(true)
  })

  it('survives a survey the size the real one issues', async () => {
    const e = await arena('ITSurveyBig')

    // The shape of query surfaceProfile makes: wide radius, huge limit. Through
    // perception this took ~5s and the server dropped the bot before the scan
    // finished. `getState()` throws when disconnected, so it is the assertion.
    const surveyed = surveyBlocks(e, ['stone', 'dirt', 'grass_block'], 105, 60_000)
    expect(surveyed.length).toBeGreaterThan(0)
    expect(() => e.getState()).not.toThrow()

    // Four in a row, as surfaceProfile issues, so a per-call cost that only
    // becomes fatal in aggregate still shows up here.
    for (let i = 0; i < 3; i++) surveyBlocks(e, ['stone', 'dirt', 'grass_block'], 105, 60_000)
    expect(() => e.getState()).not.toThrow()
  })
})
