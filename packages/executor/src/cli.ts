/**
 * Phase 1 deliverable: connect, print a state snapshot, walk to a coordinate.
 *
 *   npm run demo
 *
 * **The target is pinned, and the ground under it is built.** This demo used to
 * walk to "wherever I am now, plus 8 blocks in x, at my current y" against a
 * persistent world — and a bot's position carries over between runs, so every
 * run started wherever the last one stopped, on whatever terrain that happened
 * to be. MEASURED 2026-09-12: from (74.1, 72, -4.5) it reported `unreachable`
 * — "no path to the target" — and left the bot at (77.3, 71, -3.0); the very
 * next run, starting from there, targeted x=85 and arrived. That is exactly the
 * "tests that rot" trap CLAUDE.md documents, and it made a red run say nothing
 * at all about the code.
 *
 * The fix is the same one the rest of the repo uses: a floating arena at a
 * fixed coordinate, so the walk is reproducible on any world, in any biome,
 * regardless of where the previous run left the bot. `phase2-demo.ts` is the
 * established pattern in this package and this follows it.
 */
import { execFileSync } from 'node:child_process'
import { MineflayerExecutor } from './index.js'

const USERNAME = 'MineBot'
const FLOOR = 199

/**
 * Clear of every other fixture: the Phase 5 arena ends at x2070, 80 blocks
 * west, and the benchmark world is at x2343, 173 blocks east.
 */
const ARENA = { x0: 2150, x1: 2170, z0: 0, z1: 8 }
const START = { x: 2153, y: FLOOR + 1, z: 4 }
/** Twelve blocks of flat floor away — far enough to be a walk, not a step. */
const TARGET = { x: 2165, y: FLOOR + 1, z: 4 }

const mc = (command: string): void => {
  execFileSync('tmux', ['send-keys', '-t', 'mc', command, 'Enter'])
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Wait until the bot reports standing on solid ground **at the height the arena
 * puts it at**, or throw.
 *
 * This is the demo's fixture check, and it is not decoration. `/fill` silently
 * refuses a chunk that is not loaded — it answers "That position is not loaded"
 * rather than failing — so a floor that never got built produces a bot in
 * freefall, not an error. Height matters as well as `onGround`: a bot falling
 * through a missing arena floor does not fall forever, it lands on whatever
 * real terrain is ~130 blocks below, which satisfies `onGround` at the wrong
 * place. Same reasoning as `mc-console.ts`'s `waitForOnGround`.
 */
async function waitForFooting(
  executor: MineflayerExecutor,
  expectedY: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const self = executor.getState().self
    if (self.onGround && Math.abs(self.position.y - expectedY) <= 1) return
    if (Date.now() >= deadline) {
      const p = self.position
      throw new Error(
        `the bot never settled onto the arena floor at y≈${expectedY} within ${timeoutMs}ms ` +
          `(last at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}), ` +
          `onGround=${self.onGround}). The floor fill most likely did not land — check the ` +
          `server console for "That position is not loaded" or "No blocks were filled".`,
      )
    }
    await sleep(150)
  }
}

const main = async (): Promise<void> => {
  const executor = new MineflayerExecutor({ username: USERNAME })

  console.log('connecting to localhost:25566 …')
  const connected = await executor.connect()
  if (!connected.ok) {
    console.error(`FAILED: ${connected.reason} — ${connected.detail}`)
    process.exitCode = 1
    return
  }

  try {
    console.log('building the arena…')
    mc(`forceload add ${ARENA.x0} ${ARENA.z0} ${ARENA.x1} ${ARENA.z1}`)
    await sleep(800)
    mc(`fill ${ARENA.x0} ${FLOOR + 1} ${ARENA.z0} ${ARENA.x1} ${FLOOR + 6} ${ARENA.z1} air`)
    mc(`fill ${ARENA.x0} ${FLOOR} ${ARENA.z0} ${ARENA.x1} ${FLOOR} ${ARENA.z1} stone`)
    await sleep(700)
    mc(`tp ${USERNAME} ${START.x} ${START.y} ${START.z}`)
    await sleep(1_200)

    // Proves the fixture before anything is measured against it.
    await waitForFooting(executor, START.y)

    const before = executor.getState()
    console.log('spawned. state snapshot:')
    console.log(JSON.stringify(before, null, 2))

    console.log(`walking to x=${TARGET.x} z=${TARGET.z} …`)
    const moved = await executor.moveTo(TARGET, { timeoutMs: 30_000 })
    if (!moved.ok) {
      console.log(`did not arrive: ${moved.reason} — ${moved.detail}`)
      process.exitCode = 1
      return
    }

    // `moveTo` already verifies arrival against the world — a resolved goto()
    // is not evidence of having got there — but this demo's whole subject is
    // the walk, so it reports the distance it actually closed.
    const after = executor.getState().self.position
    const gap = Math.hypot(after.x - TARGET.x, after.z - TARGET.z)
    console.log(`arrived at x=${after.x.toFixed(1)} y=${after.y.toFixed(1)} z=${after.z.toFixed(1)}`)
    console.log(`DONE: walked to a pinned target, ${gap.toFixed(2)} blocks from its centre.`)
  } finally {
    // The arena is rebuilt from scratch every run, so nothing needs the chunks
    // kept resident afterwards. Released rather than left pinned on a shared
    // server.
    //
    // Guarded for the same reason the disconnect below is: this runs on every
    // exit path, including one where `waitForFooting` is already propagating a
    // fixture failure. An unreachable tmux here would throw and REPLACE that
    // exception, losing the very diagnosis the footing check exists to give.
    try {
      mc(`forceload remove ${ARENA.x0} ${ARENA.z0} ${ARENA.x1} ${ARENA.z1}`)
    } catch (e) {
      // Narrowed rather than cast: a `(e as Error).message` on a non-Error would
      // throw from inside this `finally` and mask the very error the guard exists
      // to preserve.
      console.error(
        `warning: failed to release the forceload: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      )
    }
    // Disconnect on every path — including an unexpected throw above — so a
    // failed run never strands the bot connected on the live server. A
    // failure here is reported but must not mask whatever error (if any) is
    // already propagating out of the try block above.
    try {
      await executor.disconnect()
      console.log('disconnected.')
    } catch (e) {
      console.error(`warning: failed to disconnect cleanly: ${(e as Error).message}`)
    }
  }
}

await main()
