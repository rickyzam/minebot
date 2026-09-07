import { execFileSync } from 'node:child_process'
import type { MineflayerExecutor } from '../../src/index.js'

const TMUX_SESSION = 'mc'

/**
 * Sends a single command line to the Minecraft server console via the `mc`
 * tmux session (see docs/superpowers/specs/2026-09-07-minecraft-agent-design.md
 * §5: integration tests use `tmux send-keys` to set up reproducible scenarios —
 * teleport, place a known block, clear inventory).
 *
 * Fails loudly if the session isn't reachable — this must never silently
 * no-op. A test that silently skips its server-side reset degrades back into
 * exactly the terrain-dependent flake this helper exists to eliminate,
 * without anyone noticing until the assertions start failing downstream.
 */
export function sendConsoleCommand(command: string): void {
  try {
    execFileSync('tmux', ['has-session', '-t', TMUX_SESSION], { stdio: 'ignore' })
  } catch {
    throw new Error(
      `mc-console: tmux session "${TMUX_SESSION}" is not reachable. Cannot send ` +
        `"${command}" to the Minecraft server console. Refusing to silently skip ` +
        `the reset — start/attach a "${TMUX_SESSION}" tmux session running the ` +
        `dev server console before running integration tests.`,
    )
  }
  execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION, command, 'Enter'])
}

/**
 * Teleports `username` to a fixed coordinate via the server console, then
 * polls the bot's own reported position until it reflects the teleport
 * (or throws if it hasn't within `timeoutMs`). Polling the bot's own state —
 * rather than firing the command and hoping a fixed delay was long enough —
 * is what makes this a real synchronization point instead of a race.
 */
export async function teleportAndWait(
  executor: MineflayerExecutor,
  username: string,
  target: { x: number; y: number; z: number },
  opts: { timeoutMs?: number; tolerance?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  // `/tp <player> <x> <y> <z>` with integer coordinates centers the entity on that
  // block, so the reported position lands at (x + 0.5, y, z + 0.5) — a fixed ~0.707
  // horizontal offset from the integer target. The default tolerance must clear that
  // predictable offset with margin, or every teleport to integer coordinates times out
  // waiting for an exact match that never arrives.
  const tolerance = opts.tolerance ?? 1.0

  sendConsoleCommand(`tp ${username} ${target.x} ${target.y} ${target.z}`)

  const deadline = Date.now() + timeoutMs
  for (;;) {
    const p = executor.getState().self.position
    const dist = Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z)
    if (dist <= tolerance) return
    if (Date.now() >= deadline) {
      throw new Error(
        `teleportAndWait: ${username} did not reach (${target.x}, ${target.y}, ` +
          `${target.z}) within ${timeoutMs}ms (last seen at (${p.x.toFixed(2)}, ` +
          `${p.y.toFixed(2)}, ${p.z.toFixed(2)}))`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

/**
 * Polls the bot's own reported `self.onGround` (and, if `expectedY` is
 * given, that its height matches) until satisfied, or throws if it hasn't
 * within `timeoutMs`.
 *
 * `teleportAndWait` only confirms *position* converged near the target —
 * that says nothing about whether there was actually a floor there. `/tp`
 * succeeds regardless of what's beneath the destination, and a bot in
 * freefall reads a position close to the teleport target for a brief
 * moment before gravity pulls it away, so a position-only check can
 * converge on a bot that is falling through empty air. Since `moveTo`'s
 * arrival check is horizontal-only, that falling bot could still drift
 * horizontally into a target and report `ok: true` — a test passing
 * without its fixture (the arena floor) having actually been there.
 *
 * `onGround` alone is not quite enough, though — proven empirically while
 * building this fix: a bot falling through a missing arena floor doesn't
 * fall forever, it falls all the way down to whatever real terrain exists
 * far below, and *that* eventually satisfies `onGround: true` too, just at
 * the wrong height. Pass `expectedY` (the arena's `floorY + 1`) so this
 * only accepts "on the ground" at the height the fixture is supposed to put
 * it at, not "on the ground" anywhere in the world.
 *
 * Poll rather than assert instantly: immediately after a teleport the bot
 * is still settling (typically through the ~0.7 block corner-of-block
 * offset `/tp` leaves — see `teleportAndWait`), so a brief `onGround: false`
 * right after landing is expected, not a failure.
 */
export async function waitForOnGround(
  executor: MineflayerExecutor,
  opts: { timeoutMs?: number; expectedY?: number; yTolerance?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 8_000
  const yTolerance = opts.yTolerance ?? 1.0
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const self = executor.getState().self
    const atExpectedHeight =
      opts.expectedY === undefined || Math.abs(self.position.y - opts.expectedY) <= yTolerance
    if (self.onGround && atExpectedHeight) return
    if (Date.now() >= deadline) {
      const heightNote =
        opts.expectedY !== undefined ? ` at the expected height (y ≈ ${opts.expectedY})` : ''
      throw new Error(
        `waitForOnGround: bot did not settle onto solid ground${heightNote} within ` +
          `${timeoutMs}ms (last position (${self.position.x.toFixed(2)}, ` +
          `${self.position.y.toFixed(2)}, ${self.position.z.toFixed(2)}), ` +
          `onGround=${self.onGround}). The arena floor is most likely missing, its /fill ` +
          `didn't take, or its chunk wasn't loaded when the fill ran — check buildArena's ` +
          `bounds and forceload call, and check the server log for "Successfully filled" ` +
          `vs "That position is not loaded" / "No blocks were filled".`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

export interface ArenaBounds {
  /** Inclusive world-space bounds of the platform, in blocks. */
  x0: number
  x1: number
  z0: number
  z1: number
  /** Y of the solid floor layer; a bot standing on it reports position.y === floorY + 1. */
  floorY: number
  /**
   * Blocks of clear air built above the floor. Default 6 — enough headroom for
   * a jump plus margin.
   */
  clearance?: number
}

/**
 * Builds (or rebuilds) a flat, solid stone platform at a fixed world
 * coordinate, with a clear air volume above it, via the server console.
 * Always rebuilds — never assumes a previous run's platform survived —
 * which is what makes a test using this self-healing against anything that
 * disturbed the arena between runs (weather, mobs, block updates, a
 * differently-seeded world). Because the platform is built fresh at a fixed
 * coordinate regardless of what's around it, it is biome- and
 * terrain-independent: it does not matter whether that coordinate sits in
 * jungle, ocean, or open sky before the fill runs.
 *
 * Not specific to `moveTo`: Phase 2's `mineBlock` tests need the same
 * "known coordinate, known content" guarantee — `placeArenaBlock` below
 * builds directly on this pattern for placing a single known block (e.g. a
 * coal ore) inside an arena built here.
 *
 * Call this *before* teleporting a bot onto the platform, not after — every
 * test in this file does `buildArena` then `teleportAndWait`. Keep the
 * volume (`(x1-x0+1) * (clearance+1) * (z1-z0+1)`, applied twice — once for
 * the air fill, once for the floor) well under `/fill`'s 32768-block limit.
 *
 * `/fill` silently refuses to touch a chunk that isn't currently loaded — it
 * reports "That position is not loaded" or "No blocks were filled" rather
 * than failing the command outright, so nothing in the console output on its
 * own signals the no-op to a caller that isn't watching for it. Nothing
 * keeps chunks this far from spawn loaded on their own (view-distance is
 * finite, and no bot is near this coordinate until *after* the arena is
 * supposed to already exist) — confirmed happening for real: every fill this
 * suite issued before this fix failed exactly this way (see
 * task-6-report.md). `/forceload` keeps chunks loaded independently of
 * player proximity, closing that gap at the root rather than only detecting
 * it after the fact (`waitForOnGround` below remains the detection layer —
 * the two are complementary, not alternatives).
 *
 * Left forceloaded permanently: `forceload remove` is never called. This is
 * a tiny, isolated region on a dev server, so the ongoing simulation cost is
 * negligible, and leaving it loaded means every subsequent call skips
 * re-paying the chunk-load race — `forceload add` is idempotent, so calling
 * it again on an already-forceloaded region is a harmless no-op.
 */
export async function buildArena(bounds: ArenaBounds): Promise<void> {
  const { x0, x1, z0, z1, floorY } = bounds
  const clearance = bounds.clearance ?? 6
  sendConsoleCommand(`forceload add ${x0} ${z0} ${x1} ${z1}`)
  // Give the server a moment to actually load/generate the chunks before
  // filling them — forceload registering the region is not the same as the
  // chunks already being resident.
  await new Promise((resolve) => setTimeout(resolve, 500))
  sendConsoleCommand(`fill ${x0} ${floorY + 1} ${z0} ${x1} ${floorY + clearance} ${z1} air`)
  sendConsoleCommand(`fill ${x0} ${floorY} ${z0} ${x1} ${floorY} ${z1} stone`)
}

/**
 * Places a single known block at a known coordinate via the server console.
 * Generalizes the same "deterministic via console" pattern `buildArena` uses
 * to whatever Phase 2's `mineBlock`/`placeBlock` tests need next (e.g. a coal
 * ore at a fixed spot inside an arena built here).
 */
export function placeArenaBlock(position: { x: number; y: number; z: number }, block: string): void {
  sendConsoleCommand(`setblock ${position.x} ${position.y} ${position.z} ${block}`)
}
