import { runContractSuite, type VisibilityFixture } from '@minebot/mock-executor/contract-suite'
import { MineflayerExecutor } from '../../src/index.js'
import {
  buildArena,
  placeArenaBlock,
  sendConsoleCommand,
  teleportAndWait,
  waitForOnGround,
  type ArenaBounds,
} from './mc-console.js'

/**
 * Its own arena, well clear of the others (500s, 860s, 1100s, 1200s). Arenas
 * must be separated by more than the largest radius anything might *search*,
 * not merely their own width — the Phase 3 demo once found a neighbouring
 * arena's ore 24 blocks away and chased it until its step budget ran out.
 */
const ARENA: ArenaBounds = { x0: 1395, x1: 1415, z0: 0, z1: 8, floorY: 199, clearance: 6 }
const START = { x: 1405, y: ARENA.floorY + 1, z: 4 }
/** Encased in a 3x3x3 stone shell: exists, is nearest, must never be reported. */
const HIDDEN = { x: 1408, y: ARENA.floorY + 1, z: 4 }
/** Standing in the open on the arena floor, further away, must be reported. */
const CONTROL = { x: 1400, y: ARENA.floorY + 1, z: 4 }
/**
 * `emerald_block` does not occur in worldgen, so a hit is unambiguously the
 * block placed here rather than something the terrain happened to contain.
 */
const MARKER = 'emerald_block'

/** What the suite's findBlocks assertions are declared against. */
const FINDABLE = ['grass_block', 'short_grass']

/**
 * A fixed patch of surface terrain every test starts from.
 *
 * MEASURED 2026-09-08, after this suite started failing when run alone while
 * passing in a full run. The bot's position PERSISTS in player data between
 * runs, and two things move it: the suite's own `exploreFor` tests walk it up
 * to 32 blocks, and the visibility fixture below teleports it to an arena.
 * So "where the bot is when a test starts" is really "wherever the previous
 * run left it" — and after a visibility test that is a floating stone platform
 * at y=199 with no vegetation within 64 blocks.
 *
 * That drift was harmless while `expectFindable` named `stone`, which exists
 * everywhere the bot could possibly be. It stopped being harmless when honest
 * perception forced the list down to surface vegetation, which exists only
 * where there is actual surface. Teleporting to a known patch each time fixes
 * the whole class rather than the symptom, and also removes a latent rot the
 * suite already had.
 */
const SURFACE_START = { x: -6, y: 88, z: 1 }

/**
 * Wait until perception actually works, rather than assuming `connect()` left
 * it working.
 *
 * MEASURED 2026-09-08, and it caught a real regression in this very run:
 * `connect()` awaits `waitForChunksToLoad()` only best-effort, and a
 * line-of-sight `findBlocks` needs strictly more of the world loaded than the
 * old unfiltered one did. The old query could answer from a single loaded
 * section — `stone` is under the bot's feet — whereas the visibility rule needs
 * a block's NEIGHBOURS too, and `isExposed` deliberately treats an unloaded
 * neighbour as solid so the bot never claims to see through a chunk it does not
 * have. During chunk load that conservative choice reports "not exposed" for
 * blocks that are in fact in plain sight, so this suite failed reproducibly
 * when run alone and passed in a full run, purely on timing.
 *
 * That is a property of honest perception, not a bug to fix in the executor:
 * the alternative — guessing that unloaded means empty — is the X-ray hole
 * again. So the fixture waits, and fails loudly if the wait is not enough,
 * rather than letting a test report "nothing is there".
 */
async function waitForPerception(executor: MineflayerExecutor): Promise<void> {
  const deadline = Date.now() + 15_000
  for (;;) {
    if (executor.findBlocks({ names: FINDABLE, maxDistance: 64, limit: 1 }).length > 0) return
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForPerception: no ${FINDABLE.join('/')} became visible within 15s of connecting. ` +
          `Either the world never finished loading, or this spawn genuinely has none in ` +
          `sight — in which case expectFindable needs re-grounding, NOT relaxing. ` +
          `Re-measure with: npm run bench:perception -- --spawn`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

runContractSuite('MineflayerExecutor', async () => {
  const executor = new MineflayerExecutor({ username: 'ITContract' })
  const connected = await executor.connect()
  if (!connected.ok) {
    throw new Error(`could not reach the dev server: ${connected.reason} ${connected.detail}`)
  }
  await teleportAndWait(executor, 'ITContract', SURFACE_START)
  await waitForOnGround(executor, { expectedY: SURFACE_START.y })
  await waitForPerception(executor)
  return {
    executor,
    cleanup: () => executor.disconnect(),
    // Re-grounded 2026-09-08, when findBlocks became line-of-sight limited.
    // This list was ['stone', 'dirt', 'grass_block', 'deepslate'], and three of
    // those four stopped being findable — measured across three spawns with
    // `npm run bench:perception -- --spawn`: `stone` 213k present / 0 visible,
    // `dirt` 24k present / 0 visible, `deepslate` absent from the volume
    // entirely (it was already contributing nothing). Only surface vegetation
    // survives a visibility test from a bot standing on the surface, which is
    // the honest answer and exactly what the change intends.
    //
    // Narrowing the list is the right fix; relaxing the assertion would not be.
    // This declaration is the only thing keeping the block section non-vacuous.
    expectFindable: { names: FINDABLE, minCount: 1 },
    prepareVisibilityFixture: async (): Promise<VisibilityFixture> => {
      // Built in an arena rather than around wherever the bot spawned, for the
      // reason the arena exists at all: a floating platform at y=199 makes the
      // fixture independent of biome and world generation. Encasing a block in
      // real terrain would depend on there being solid ground where we guessed,
      // and a cave under the spawn point would silently turn "hidden" into
      // "visible" — a fixture that lies in the direction of a false pass.
      await buildArena(ARENA)
      await teleportAndWait(executor, 'ITContract', START)
      await waitForOnGround(executor, { expectedY: ARENA.floorY + 1 })

      // A 3x3x3 stone shell, then the marker at its centre. Every one of the
      // centre's six neighbours is stone from this fill, so it is enclosed
      // regardless of what the arena floor looked like before.
      sendConsoleCommand(
        `fill ${HIDDEN.x - 1} ${HIDDEN.y - 1} ${HIDDEN.z - 1} ` +
          `${HIDDEN.x + 1} ${HIDDEN.y + 1} ${HIDDEN.z + 1} stone`,
      )
      placeArenaBlock(HIDDEN, MARKER)
      placeArenaBlock(CONTROL, MARKER)
      // The fills and setblocks are console commands with no acknowledgement;
      // give the server a moment to apply them and the client a moment to
      // receive the block updates before anything reads the world.
      await new Promise((resolve) => setTimeout(resolve, 1_000))

      return {
        hidden: { name: MARKER, position: HIDDEN },
        control: { name: MARKER, position: CONTROL },
        maxDistance: 16,
        // No release: buildArena rebuilds the floor and the air above it on
        // every call, which removes both markers and the shell.
      }
    },
  }
})
