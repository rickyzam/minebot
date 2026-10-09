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
 * Sends `command` and returns the server's own reply to it, matched by
 * `pattern`.
 *
 * Some facts can only be had from the server itself. Mob health is one:
 * MEASURED 2026-09-12 against mineflayer 4.39.0, `entity.health` is assigned in
 * exactly two places — `plugins/health.js:25` (the bot itself) and
 * `plugins/boss_bar.js:33` — so `WorldSnapshot.nearbyEntities[].health` is
 * always `undefined` for a mob, on every connection.
 *
 * Note precisely what that does and does not say. The value DOES reach the
 * client: `entities.js:456-457` stores every `entity_metadata` packet as
 * `entity.metadata`, keyed by metadata index (`parseMetadata`, :936-943), and
 * health is a standard `LivingEntity` metadata field. What mineflayer omits is
 * surfacing it as `entity.health`; the raw value survives only in
 * `entity.metadata`, which this executor does not expose. So the accurate
 * claim is "no connection *reports* a mob's health", not "the data never
 * arrives".
 *
 * Either way a second bot cannot witness that a mob lost hit points. The
 * console can (`data get entity … Health`), and it is the server's own record
 * rather than any client's view of it — strictly stronger evidence than a
 * second connection, which is what the "never trust the acting bot's world
 * model" rule is actually asking for.
 *
 * Correlating the reply with the command is the whole difficulty, because the
 * pane holds every earlier reply too — and a before/after health check sends
 * the *same* command twice, so "the last matching line" would happily return
 * the previous call's answer.
 *
 * **This used to count the echoes of the command and wait for the count to
 * rise. That is unsound, and it was MEASURED failing 2026-09-12.** The count is
 * taken over `capture-pane -S -400`, a BOUNDED, EVICTING window: measured at
 * 424 captured lines against 1904 lines of history, holding 3 echoes of a bare
 * `difficulty`. A burst of server output (a `demo:phase5` run with 17 reflex
 * preemptions did it) evicts older echoes, so after sending, the count is no
 * higher than `before` and the match branch never runs — `demo:phase5` reported
 * a FALSE "RESTORE FAILED" with the reply "The difficulty is Peaceful" sitting
 * in the captured lines. The inverse is worse and is why this had to change
 * rather than merely widen: evict OUR echo while an older one survives and the
 * count test passes against the wrong echo, returning a STALE reply as the
 * current one — a false green in exactly the before/after case above.
 *
 * So correlation is now anchored on something that cannot be confused with
 * anything else: a nonce. A deliberately invalid command is sent first, the
 * server answers "Unknown or incomplete command" quoting it back, and the real
 * command's reply is whatever matches AFTER the last line mentioning the nonce.
 * Commands are processed in order, so every nonce line precedes the reply.
 * Eviction can now only remove the anchor entirely, which fails loudly with a
 * message saying so — it can never silently select an older reply.
 *
 * The cost is one junk line per query in the server log, tagged `minebot_probe_`
 * so anyone reading the log can see what it is.
 */
let probeCounter = 0

export async function queryConsole(
  command: string,
  pattern: RegExp,
  opts: { timeoutMs?: number } = {},
): Promise<RegExpMatchArray> {
  const timeoutMs = opts.timeoutMs ?? 8_000
  // Counter AND random: the counter keeps two probes in one process distinct
  // even inside the same millisecond, the random suffix keeps two processes
  // (a demo and a test run) from colliding in one pane's scrollback.
  const nonce = `minebot_probe_${++probeCounter}_${Math.random().toString(36).slice(2, 10)}`
  const capture = (): string[] =>
    execFileSync('tmux', ['capture-pane', '-t', TMUX_SESSION, '-p', '-S', '-400'], {
      encoding: 'utf8',
    }).split('\n')

  // Both sent up front, in this order. The server executes console commands in
  // order, so its reply to `command` lands after every line the nonce produced.
  sendConsoleCommand(nonce)
  sendConsoleCommand(command)

  const deadline = Date.now() + timeoutMs
  for (;;) {
    const lines = capture()
    // The LAST mention, not the first: the nonce appears twice, once as the
    // echoed input and again in the server's error quoting it back.
    let anchor = -1
    for (const [i, line] of lines.entries()) if (line.includes(nonce)) anchor = i
    if (anchor !== -1) {
      for (const line of lines.slice(anchor + 1)) {
        const m = line.match(pattern)
        if (m) return m
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `queryConsole: "${command}" produced no line matching ${pattern} within ${timeoutMs}ms` +
          (anchor === -1
            ? ` — and its ${nonce} anchor never appeared in the captured pane, so either the ` +
              `server is not reading its console or the pane scrolled past it`
            : '') +
          `. Last 5 console lines: ${JSON.stringify(lines.slice(-6, -1))}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
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

/**
 * Polls `executor`'s own snapshot until it reports a player named `playerName`
 * among its nearby entities, or throws if it has not within `timeoutMs`.
 *
 * A second bot connecting and teleporting is not the same as the first bot
 * having received the spawn packet for it. A follow fixture that returned
 * before this would hand `followPlayer` a name the executor cannot see yet,
 * and the test would measure the fixture's race instead of the action.
 */
export async function waitForPlayerVisible(
  executor: MineflayerExecutor,
  playerName: string,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const seen = executor
      .getState()
      .nearbyEntities.some((e) => e.kind === 'player' && e.name === playerName)
    if (seen) return
    if (Date.now() >= deadline) {
      const p = executor.getState().self.position
      throw new Error(
        `waitForPlayerVisible: ${playerName} never appeared among the bot's nearby entities ` +
          `within ${timeoutMs}ms (bot at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})). ` +
          `Either the second connection failed to land near it, or it was placed beyond ` +
          `the snapshot's entity radius.`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

/**
 * The inverse of {@link waitForPlayerVisible}: polls until `executor` no longer
 * reports `playerName` nearby, or throws. A fixture that sends a player "out of
 * range" must prove it left, or a later `not_found` assertion would be
 * checking against a player the bot can still see.
 */
export async function waitForPlayerGone(
  executor: MineflayerExecutor,
  playerName: string,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const seen = executor
      .getState()
      .nearbyEntities.some((e) => e.kind === 'player' && e.name === playerName)
    if (!seen) return
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForPlayerGone: ${playerName} was still among the bot's nearby entities ` +
          `${timeoutMs}ms after being sent away`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

/** How many of `itemName` the executor's own snapshot says it holds, across all slots. */
export function itemCount(executor: MineflayerExecutor, itemName: string): number {
  return executor
    .getState()
    .self.inventory.filter((i) => i.name === itemName)
    .reduce((n, i) => n + i.count, 0)
}

/**
 * Polls until the executor holds exactly `count` of `itemName`, or throws.
 *
 * `/give` and `/clear` are console commands with no acknowledgement, and the
 * inventory reaches the bot as later slot packets. A test that gives an item
 * and calls an action straight away measures that race, not the action — and
 * a `not_found` read against an inventory that has not arrived yet looks
 * exactly like a correct guard.
 */
export async function waitForItemCount(
  executor: MineflayerExecutor,
  itemName: string,
  count: number,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 8_000
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const held = itemCount(executor, itemName)
    if (held === count) return
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForItemCount: expected ${count} ${itemName} in the inventory within ${timeoutMs}ms, ` +
          `last saw ${held}. The /give or /clear did not land, or something spent the item.`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

/**
 * Polls `executor`'s own `findBlocks` until it reports `blockName` at exactly
 * `position`, or throws.
 *
 * `findBlocks` is line-of-sight limited, so this proves two things at once:
 * the console command that built the block landed, and this connection can
 * actually see it. Use it on a SECOND connection to confirm what another bot
 * did — the acting bot's own world model is not evidence (see `bot.dig()`).
 */
export async function waitForBlockVisible(
  executor: MineflayerExecutor,
  blockName: string,
  position: { x: number; y: number; z: number },
  opts: { timeoutMs?: number; maxDistance?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const maxDistance = opts.maxDistance ?? 16
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const seen = executor
      .findBlocks({ names: [blockName], maxDistance, limit: 64 })
      .map((b) => b.position)
    if (seen.some((p) => p.x === position.x && p.y === position.y && p.z === position.z)) return
    if (Date.now() >= deadline) {
      const me = executor.getState().self.position
      throw new Error(
        `waitForBlockVisible: no ${blockName} visible at (${position.x}, ${position.y}, ` +
          `${position.z}) within ${timeoutMs}ms from (${me.x.toFixed(1)}, ${me.y.toFixed(1)}, ` +
          `${me.z.toFixed(1)}). Saw ${seen.length} other(s): ` +
          `${JSON.stringify(seen.slice(0, 8))}. Either the block is not there, or this ` +
          `viewpoint has no line of sight to it.`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
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
  /**
   * Wall the platform in on all six sides: four walls around the perimeter of
   * the cleared volume, and a **glowstone ceiling** as its top layer.
   * Off by default, so every existing caller keeps the open platform it was
   * written against.
   *
   * Both halves are required by the combat tests, and each answers a measured
   * failure (Phase 5 spec §4.1-4.2):
   *
   *  - **The ceiling** is what keeps an undead mob alive. Under open sky a
   *    named, `PersistenceRequired` zombie on the y=199 platform *burned to
   *    death at 21 seconds* — shorter than a single pathfinding leg. Roofing it
   *    removes the sky light locally, instead of `time set midnight` +
   *    `doDaylightCycle false`, which would change the sky for anyone playing.
   *  - **The walls** are what keeps it on the platform. A hostile paths straight
   *    at the bot, and the platform floats ~130 blocks above real terrain: a mob
   *    (or a bot backing away from one) that walks off the edge dies on impact,
   *    and the test reads that as the action failing.
   *
   * The ceiling is glowstone rather than stone to **prevent natural spawns**.
   * A sealed, unlit box on any difficulty above peaceful is a mob spawner: it
   * would make combat tests flaky (someone else's zombie in the arena) and
   * leave hostiles behind afterwards. Hostile spawning needs block light 0;
   * glowstone emits 15, which still reaches 10 at the floor of a 6-high box.
   * Done locally rather than by touching the `doMobSpawning` gamerule, which is
   * global shared state.
   *
   * The walls and ceiling are built INSIDE the cleared volume, so the usable
   * interior is `x0+1..x1-1` by `z0+1..z1-1`, from `floorY + 1` up to
   * `floorY + clearance - 1`. Keeping them inside is what makes the enclosure
   * self-healing: every block it writes sits in the volume the air fill just
   * cleared, so a rebuild cannot leave a stale block from a previous test
   * standing in a wall.
   */
  enclosed?: boolean
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

  if (bounds.enclosed) {
    // See ArenaBounds.enclosed for why each of these exists. Order matters only
    // in that all of it lands after the air fill above — which is what makes a
    // rebuild restore a wall an earlier test knocked a hole in.
    const ceilingY = floorY + clearance
    const wallTop = ceilingY - 1
    sendConsoleCommand(`fill ${x0} ${ceilingY} ${z0} ${x1} ${ceilingY} ${z1} glowstone`)
    sendConsoleCommand(`fill ${x0} ${floorY + 1} ${z0} ${x1} ${wallTop} ${z0} stone`)
    sendConsoleCommand(`fill ${x0} ${floorY + 1} ${z1} ${x1} ${wallTop} ${z1} stone`)
    sendConsoleCommand(`fill ${x0} ${floorY + 1} ${z0} ${x0} ${wallTop} ${z1} stone`)
    sendConsoleCommand(`fill ${x1} ${floorY + 1} ${z0} ${x1} ${wallTop} ${z1} stone`)
  }

  // VERIFIED 2026-09-07, the hard way: a coal drop left in the arena by an
  // earlier run was silently picked up by a later one, so a case that should
  // have shown "mined but collected nothing" reported a successful collection
  // instead. Mined drops are shared world state that outlives the run that
  // created them, and the arena is reused. Despawn them with the rest of the
  // reset, or every collection assertion is suspect.
  //
  // Note the air fill above does NOT do this: /fill replaces blocks, and a
  // dropped item is an entity, not a block. It survives being filled over.
  //
  // Scoped to the arena volume rather than `kill @e[type=item]` globally, so a
  // concurrently running test elsewhere in the world is not disturbed.
  const cx = Math.floor((x0 + x1) / 2)
  const cz = Math.floor((z0 + z1) / 2)
  const radius = Math.ceil(Math.hypot(x1 - x0, clearance, z1 - z0) / 2) + 4
  sendConsoleCommand(`kill @e[type=item,x=${cx},y=${floorY},z=${cz},distance=..${radius}]`)
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

/**
 * Gives `username` an item via the server console. Tests need items the bot
 * could not otherwise obtain in a fresh world.
 */
export function giveItem(username: string, item: string, count = 1): void {
  sendConsoleCommand(`give ${username} ${item} ${count}`)
}

/**
 * Empties `username`'s inventory. Tests asserting on what arrived in the
 * inventory must start from a known-empty one, or an item left by an earlier
 * test reads as this test's result.
 */
export function clearInventory(username: string): void {
  sendConsoleCommand(`clear ${username}`)
}

/**
 * Puts `item` in an exact inventory slot, using vanilla's slot names —
 * `hotbar.0`…`hotbar.8`, `inventory.0`…`inventory.26`, `weapon.mainhand`.
 *
 * `giveItem` cannot express "in the inventory but NOT in the hand", and the
 * difference is not academic: `/give` fills the first free slot, and whether
 * that slot is the *held* one depends on the player's selected hotbar slot.
 * That selection persists in player data, survives `/clear`, and carries over
 * between runs — `bot.equip()` moves it, so a test that equips a tool changes
 * what the next run of that same test starts out holding. A test needing the
 * tool out of the hand must place it exactly, or it passes or fails according
 * to what the previous run left behind. (Learned here: the equip test passed
 * alone and failed in the full suite for exactly this reason.)
 */
export function placeInSlot(username: string, slot: string, item: string, count = 1): void {
  sendConsoleCommand(`item replace entity ${username} ${slot} with ${item} ${count}`)
}

/**
 * Builds a platform too large for a single `/fill`, in chunked slices.
 *
 * `/fill` caps at 32768 blocks and silently refuses unloaded chunks, so a big
 * arena needs both a forceload and slicing. Search tests need a platform much
 * larger than the perception radius, or the bot sees everything from its start
 * and the test measures nothing.
 *
 * SIZE THE PLATFORM AGAINST THE SEARCH, not against the distance to the
 * target. A spiral with `maxDistance` R proposes waypoints up to R blocks from
 * the search origin in EVERY direction, so a platform that only extends
 * towards the hidden block walks the bot off the edge — and at y=199 that is a
 * 130-block fall onto whatever terrain happens to be underneath.
 *
 * Returns without verifying — call `waitForOnGround` with the expected height
 * before trusting it, exactly as the smaller `buildArena` requires.
 */
export async function buildLargePlatform(bounds: ArenaBounds): Promise<void> {
  const { x0, x1, z0, z1, floorY } = bounds
  const clearance = bounds.clearance ?? 6
  sendConsoleCommand(`forceload add ${x0} ${z0} ${x1} ${z1}`)
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  for (let x = x0; x <= x1; x += 16) {
    const xEnd = Math.min(x + 15, x1)
    sendConsoleCommand(`fill ${x} ${floorY + 1} ${z0} ${xEnd} ${floorY + clearance} ${z1} air`)
    sendConsoleCommand(`fill ${x} ${floorY} ${z0} ${xEnd} ${floorY} ${z1} stone`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  // Same reasoning as buildArena: a drop left by an earlier run is an entity,
  // not a block, so the air fill above does not remove it.
  const cx = Math.floor((x0 + x1) / 2)
  const cz = Math.floor((z0 + z1) / 2)
  const radius = Math.ceil(Math.hypot(x1 - x0, clearance, z1 - z0) / 2) + 4
  sendConsoleCommand(`kill @e[type=item,x=${cx},y=${floorY},z=${cz},distance=..${radius}]`)
  await new Promise((resolve) => setTimeout(resolve, 800))
}

// ---------------------------------------------------------------------------
// Shared arena/console helpers.
//
// Hoisted here 2026-09-14. The whole-branch review deferred this with "hoist
// before a fourth", and the fourth arrived — `waitUntil` had reached four copies
// and `sweepArenaUntilEmpty` / `expectDifficultyPeaceful` / `ARENA_VOLUME`
// three, two of each added by `flee` and `reflex-seam` on the same day.
//
// These THROW rather than using `expect`, which is why they can live here at
// all: this module has no vitest import and deliberately keeps none, so it is
// usable from a demo as well as a test. An `expect`-based helper belongs in the
// test file, not here.
// ---------------------------------------------------------------------------

/**
 * An arena as an entity-selector volume, so a cleanup sweep reaches everything
 * inside it and nothing outside it.
 *
 * `dy` spans the floor through the ceiling — a mob standing on the floor and an
 * item resting on it are both inside, and so is anything a test put on the roof.
 */
export function arenaVolume(bounds: ArenaBounds): string {
  const clearance = bounds.clearance ?? 6
  return (
    `x=${bounds.x0},y=${bounds.floorY},z=${bounds.z0},` +
    `dx=${bounds.x1 - bounds.x0},dy=${clearance + 1},dz=${bounds.z1 - bounds.z0}`
  )
}

/**
 * Polls `predicate` until it is true, or throws naming what did not happen.
 *
 * The complaint is mandatory and not defaulted: a bare "timed out" in an
 * integration run tells you nothing about which of a dozen awaited conditions
 * gave up.
 */
export async function waitUntil(
  predicate: () => boolean,
  complaint: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() >= deadline) throw new Error(`${complaint} (within ${timeoutMs}ms)`)
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

/**
 * Kills everything in the arena and does not return until the SERVER says it is
 * empty — items included.
 *
 * Two passes minimum, and that is measured rather than defensive: killing a mob
 * creates its drop AFTER the kill resolves (Task 6a), so the flesh does not
 * exist when the sweep that produced it runs. Only the last test of a run leaks
 * without this, because every earlier one is hidden by the next `buildArena`,
 * and `/fill` would not help — a drop is an entity, not a block.
 */
export async function sweepArenaUntilEmpty(
  bounds: ArenaBounds,
  attempts = 4,
): Promise<void> {
  const volume = arenaVolume(bounds)
  let last = ''
  for (let i = 0; i < attempts; i++) {
    sendConsoleCommand(`kill @e[type=item,${volume}]`)
    const m = await queryConsole(`kill @e[type=!player,${volume}]`, /No entity was found|Killed /)
    last = m[0] ?? ''
    if (last.includes('No entity was found')) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`the arena still held entities after ${attempts} sweeps (last reply: ${last})`)
}

/**
 * Reads difficulty back from the server and throws unless it is Peaceful.
 *
 * Difficulty is world-wide, so a combat test that leaves it raised changes the
 * game for anyone logged in. Read back rather than assumed: `difficulty
 * peaceful` has no acknowledgement, and a `finally` that fired and failed looks
 * exactly like one that worked.
 */
export async function expectDifficultyPeaceful(): Promise<void> {
  const d = await queryConsole('difficulty', /The difficulty is (\w+)/)
  if (d[1] !== 'Peaceful') {
    throw new Error(
      `difficulty was NOT restored (the server reports ${d[1]}) — the shared dev server is ` +
        `left on a combat difficulty`,
    )
  }
}
