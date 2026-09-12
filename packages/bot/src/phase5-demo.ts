/**
 * The Phase 5 deliverable: the reflex layer beats the plan, under a live mob.
 *
 *   npm run demo:phase5
 *
 * Needs the dev server and Ollama. A real model pursues a mining goal inside an
 * enclosed arena; part-way through, a zombie is summoned next to the bot. The
 * `ReflexExecutor` wrapping the real executor must notice it, abort whatever
 * the planner had in flight, run its own recovery, and hand the planner back
 * `interrupted` so it re-observes rather than continuing from a stale snapshot.
 *
 * **The pass condition is deliberately narrow.** `preemptions.length > 0` alone
 * proves only that a trigger fired — the arbiter could have recorded it and
 * then failed to do anything about it. The demo therefore also requires
 * `preemptions[0].recovery?.ok === true`: the reflex actually ran its recovery
 * against the live world and it succeeded. Nothing about the mining goal is
 * asserted; a preemption is *supposed* to derail it, and the planner's own
 * recovery from that is Track B's business.
 *
 * **`flee` is still a stub.** Task 6b is gated on a decision that has not been
 * made — flee's distance and timeout are unagreed shared surface — so
 * `MineflayerExecutor.flee` still returns `fail('internal', 'flee arrives in
 * Phase 5')`. A healthy bot's trigger is `attack`, which is implemented, so
 * that is what this demo exercises. If the bot's health ever reaches the flee
 * threshold (6), the reflex will attempt `flee` and get `internal` back: the
 * demo prints that rather than hiding it.
 *
 * Step 1 of the brief, decided here rather than at runtime: the console
 * helpers below are a local copy. `mc-console.ts` lives in
 * `packages/executor/test/integration/`, and `@minebot/executor`'s exports map
 * is `"."` only, so `packages/bot/src` cannot import it — `phase3-demo.ts` and
 * `phase4-demo.ts` already carry their own local `mc` for the same reason.
 * Widening the package's public API to export a tmux-driving test helper is a
 * worse trade than ~40 duplicated lines. `mc-console.ts` remains the canonical
 * copy; the reasoning behind each command lives there.
 */
import { execFileSync } from 'node:child_process'
import type { WorldSnapshot } from '@minebot/contract'
import {
  DEFAULT_REFLEX_THRESHOLDS,
  MineflayerExecutor,
  ReflexExecutor,
  type ReflexPreemption,
} from '@minebot/executor'
import { OllamaClient, SchemaDecider, renderStep } from '@minebot/agent'
import { runBotGoal } from './session.js'

/** Ten characters. Minecraft rejects anything over 16 at login. */
const USERNAME = 'Phase5Demo'
const FLOOR = 199

/**
 * Clear of every other arena by ≥80 blocks: the combat integration arena ends
 * at x1970, the Phase 3 demo at x1330, and the benchmark world is at x2343.
 * Arenas must be separated by more than the largest radius anything might
 * *search*, not merely their own width (CLAUDE.md) — the model picks its own
 * `find_blocks` radius, so the gap is deliberately wide.
 */
const ARENA = { x0: 2050, x1: 2070, z0: 0, z1: 8 }
const CLEARANCE = 6
/** Walls are built inside the cleared volume, so the usable floor is one block in. */
const START = { x: 2053, y: FLOOR + 1, z: 4 }
const ORE = { x: 2062, y: FLOOR + 1, z: 4 }
/** On the bot's route from START to ORE, so the summon lands mid-approach. */
const MOB_SPAWN = { x: 2058, y: FLOOR + 1, z: 4 }
/** Tags this run's mobs so cleanup kills exactly ours. */
const MOB_TAG = 'phase5demo'

const ARENA_VOLUME =
  `x=${ARENA.x0},y=${FLOOR},z=${ARENA.z0},` +
  `dx=${ARENA.x1 - ARENA.x0},dy=${CLEARANCE + 1},dz=${ARENA.z1 - ARENA.z0}`

const MAX_STEPS = 10
/**
 * A hard ceiling on the run. A zombie keeps hitting the bot for as long as the
 * goal lasts, and an outer abort ends the goal cleanly (`status: 'interrupted'`)
 * rather than leaving a fight running on a shared server indefinitely. The pass
 * condition is about the preemption, not about the goal finishing, so cutting
 * the goal short costs the demo no evidence.
 */
const RUN_BUDGET_MS = 180_000

/**
 * Summon no earlier than this into the run, so the mob arrives while the
 * planner is working rather than before it starts.
 *
 * MEASURED 2026-09-12, and the reason this is not larger: with the ore 8.5
 * blocks away the model can finish the whole goal in **three steps in under
 * eight seconds** (`find_blocks` → `mine_block_at` → `done`). An 8s delay
 * missed an entire run — the goal ended before the zombie existed, and the
 * demo failed reporting exactly that. The planner's first model round trip is
 * still in flight at 1.5s, so this lands the mob inside the run without
 * racing its end.
 */
const SUMMON_AFTER_MS = 1_500
/** Within this many blocks of the bot, so the spawn event itself trips the reflex. */
const SUMMON_WITHIN = 7
/** Summon regardless once the run has gone this long without the bot coming close. */
const SUMMON_DEADLINE_MS = 45_000

type Pos = { x: number; y: number; z: number }
const dist = (a: Pos, b: Pos): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------- console helpers (local copy — see the header) ----------

const TMUX_SESSION = 'mc'

/** Fails loudly if tmux is unreachable: a fixture that silently no-ops is worse than none. */
function mc(command: string): void {
  try {
    execFileSync('tmux', ['has-session', '-t', TMUX_SESSION], { stdio: 'ignore' })
  } catch {
    throw new Error(
      `phase5-demo: tmux session "${TMUX_SESSION}" is not reachable, so "${command}" ` +
        `cannot be sent to the Minecraft server console.`,
    )
  }
  execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION, command, 'Enter'])
}

/**
 * Sends `command` and returns the server's own reply, matched by `pattern`.
 *
 * The restore below is the one piece of shared, world-wide state this demo
 * changes, so "the command was sent" is not good enough: `mc` throws only when
 * tmux is unreachable, and a command the *server* rejected would restore
 * nothing, silently. Correlating the reply with the command is the difficulty —
 * the pane holds every earlier reply too — so this counts tmux's echoes of the
 * command line and reads only what followed a new one.
 */
async function queryConsole(
  command: string,
  pattern: RegExp,
  timeoutMs = 8_000,
): Promise<RegExpMatchArray> {
  const capture = (): string[] =>
    execFileSync('tmux', ['capture-pane', '-t', TMUX_SESSION, '-p', '-S', '-400'], {
      encoding: 'utf8',
    }).split('\n')
  const echoes = (lines: string[]): number[] =>
    lines.flatMap((line, i) => (line.trim() === command ? [i] : []))

  const before = echoes(capture()).length
  mc(command)

  const deadline = Date.now() + timeoutMs
  for (;;) {
    const lines = capture()
    const at = echoes(lines)
    if (at.length > before) {
      for (const line of lines.slice(at[at.length - 1]! + 1)) {
        const m = line.match(pattern)
        if (m) return m
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `queryConsole: "${command}" produced no line matching ${pattern} within ${timeoutMs}ms. ` +
          `Last console lines: ${JSON.stringify(lines.slice(-6, -1))}`,
      )
    }
    await sleep(150)
  }
}

/**
 * Asserts, from the SERVER's own answer, that `block` is at `position`.
 *
 * `execute if block` replies "Test passed" or "Test failed", so this turns a
 * fixture command that quietly did nothing into a loud failure. It has to
 * exist: `/fill` silently refuses a chunk that is not loaded — it answers
 * "That position is not loaded" rather than failing — and `mc()` throws only
 * when tmux is unreachable, so nothing else in this file would notice.
 *
 * Without it the demo misattributes its own broken fixture. A floor fill that
 * never landed drops the bot ~130 blocks and trips the death guard ("the bot
 * DIED during the run"); an ore that never landed ends the goal in two steps
 * and trips "the run ended before a zombie was ever summoned… the demo's own
 * timing at fault". Both would point at the wrong thing.
 */
async function expectBlockAt(
  position: Pos,
  block: string,
  what: string,
): Promise<void> {
  const m = await queryConsole(
    `execute if block ${position.x} ${position.y} ${position.z} ${block}`,
    /Test passed|Test failed/,
  )
  if (!m[0]?.includes('Test passed')) {
    throw new Error(
      `fixture check failed: ${what} — the server reports no ${block} at (${position.x}, ` +
        `${position.y}, ${position.z}). The command that should have built it silently did ` +
        `nothing (an unloaded chunk answers "That position is not loaded"), so the run would ` +
        `have measured a broken fixture rather than the reflex layer.`,
    )
  }
}

/**
 * Polls until the bot reports standing on solid ground at the arena's height.
 *
 * `onGround` alone is not enough: a bot falling through a missing floor lands
 * on real terrain ~130 blocks below, which satisfies it at the wrong place.
 */
async function waitForFooting(
  reflex: { getState: () => WorldSnapshot },
  expectedY: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const self = reflex.getState().self
    if (self.onGround && Math.abs(self.position.y - expectedY) <= 1) return
    if (Date.now() >= deadline) {
      const p = self.position
      throw new Error(
        `the bot never settled onto the arena floor at y≈${expectedY} within ${timeoutMs}ms ` +
          `(last at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}), ` +
          `onGround=${self.onGround})`,
      )
    }
    await sleep(150)
  }
}

/**
 * Builds the arena **enclosed** — floor, four walls and a glowstone ceiling.
 * Both halves are measured requirements (Phase 5 spec §4.1-4.2): under open sky
 * a named, `PersistenceRequired` zombie on the y=199 platform burned to death
 * at 21 seconds, and a hostile pathing at the bot walks off a platform floating
 * ~130 blocks above real terrain. The ceiling is glowstone rather than stone
 * because a sealed *unlit* box on any difficulty above peaceful is a mob
 * spawner; light 15 at the ceiling is still ~10 at the floor, and hostile
 * spawning needs 0.
 */
async function buildEnclosedArena(): Promise<void> {
  const { x0, x1, z0, z1 } = ARENA
  mc(`forceload add ${x0} ${z0} ${x1} ${z1}`)
  await sleep(800)
  mc(`fill ${x0} ${FLOOR + 1} ${z0} ${x1} ${FLOOR + CLEARANCE} ${z1} air`)
  mc(`fill ${x0} ${FLOOR} ${z0} ${x1} ${FLOOR} ${z1} stone`)

  const ceilingY = FLOOR + CLEARANCE
  const wallTop = ceilingY - 1
  mc(`fill ${x0} ${ceilingY} ${z0} ${x1} ${ceilingY} ${z1} glowstone`)
  mc(`fill ${x0} ${FLOOR + 1} ${z0} ${x1} ${wallTop} ${z0} stone`)
  mc(`fill ${x0} ${FLOOR + 1} ${z1} ${x1} ${wallTop} ${z1} stone`)
  mc(`fill ${x0} ${FLOOR + 1} ${z0} ${x0} ${wallTop} ${z1} stone`)
  mc(`fill ${x1} ${FLOOR + 1} ${z0} ${x1} ${wallTop} ${z1} stone`)

  // Drops are entities, not blocks: the air fill above does not remove them,
  // and a coal left by an earlier run would be collected by this one.
  mc(`kill @e[type=item,${ARENA_VOLUME}]`)
  await sleep(700)

  // Read the fixture back before anything is measured against it.
  await expectBlockAt({ x: START.x, y: FLOOR, z: START.z }, 'stone', 'the arena floor')
  await expectBlockAt(
    { x: ARENA.x0, y: FLOOR + CLEARANCE, z: START.z },
    'glowstone',
    'the glowstone ceiling (without it a zombie burns to death in 21s)',
  )
}

/**
 * Releases the chunks `buildEnclosedArena` pinned with `forceload add`.
 *
 * **Called unconditionally from `main`'s `finally`, and deliberately NOT from
 * `restoreWorld`.** That distinction is the entire point of this function.
 * `forceload add` is the first thing the arena build issues — long before
 * `difficultyRaised` is set — and the fixture checks that follow it
 * (`expectBlockAt`, `waitForFooting`) are designed to THROW when the fixture is
 * broken. Releasing the chunks from inside the difficulty-gated restore would
 * therefore leak them on precisely the failure path those checks exist to
 * produce: the loud one. Every exit path from the moment `forceload add` runs
 * has to come through here.
 *
 * Removing a region that was never added is harmless, and that path is REACHABLE
 * — `connect()` failing returns before the arena is ever pinned, and the release
 * still runs. So the no-op reply has to match. **MEASURED against the live
 * server 2026-09-12: it is "No chunks were removed from force loading".**
 * `commands.forceload.removed.failure`, not the `added.failure` string ("No
 * chunks were marked…") an earlier version of this comment quoted — that one
 * answers a failed *add* and can never appear here.
 *
 * **Both alternatives are deliberately SHORT and match near the start of the
 * reply, because `tmux capture-pane` hard-wraps at the pane width (80) and
 * `queryConsole` matches line by line.** MEASURED: the success reply breaks
 * mid-word as `…from [` / `128, 0] to …`, so a pattern reaching the trailing
 * "for force loading" does NOT match, while `Unmarked \d+ chunk` does. The
 * 33-character `[HH:MM:SS] [Server thread/INFO]: ` prefix counts against the
 * 80, leaving roughly 47 usable characters. A read-back pattern here is not
 * free to be as descriptive as it looks.
 *
 * The read-back's real job is to prove the command reached a live server at all:
 * `queryConsole` throws when no matching reply arrives within its timeout, and
 * that throw is the failure signal. It is caught here rather than propagating,
 * so a tmux failure in cleanup cannot replace an exception already on its way
 * out of `main`.
 */
async function releaseForceload(): Promise<string[]> {
  try {
    await queryConsole(
      `forceload remove ${ARENA.x0} ${ARENA.z0} ${ARENA.x1} ${ARENA.z1}`,
      /Unmarked (\d+ )?chunk|No chunks were removed/,
    )
    return []
  } catch (e) {
    return [
      `the forceload on ${ARENA.x0},${ARENA.z0}..${ARENA.x1},${ARENA.z1} could not be ` +
        `confirmed released — the chunks may still be pinned on the shared server: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    ]
  }
}

/**
 * Puts the world back: peaceful difficulty first (it is the global state, and
 * it removes hostiles on its own), then the arena volume, then the drops the
 * kills themselves create.
 *
 * Every command is read back. A killed mob's loot spawns *after* the kill that
 * produced it (measured in Task 6a), so one sweep cannot remove both — this
 * loops until the server itself answers "No entity was found". Returns the
 * complaints it could not resolve, so the caller can fail loudly.
 */
async function restoreWorld(): Promise<string[]> {
  const problems: string[] = []
  try {
    mc('difficulty peaceful')
    mc(`kill @e[type=!player,${ARENA_VOLUME}]`)
    await sleep(600)
    let last = ''
    for (let i = 0; i < 4; i++) {
      mc(`kill @e[type=item,${ARENA_VOLUME}]`)
      const m = await queryConsole(
        `kill @e[type=!player,${ARENA_VOLUME}]`,
        /No entity was found|Killed /,
      )
      last = m[0] ?? ''
      if (last.includes('No entity was found')) break
      await sleep(500)
    }
    if (!last.includes('No entity was found')) {
      problems.push(`the arena still held entities after 4 sweeps (last reply: ${last})`)
    }
    const d = await queryConsole('difficulty', /The difficulty is (\w+)/)
    if (d[1] !== 'Peaceful') {
      problems.push(
        `difficulty was NOT restored (server reports ${d[1]}) — the shared dev server is ` +
          `left on a combat difficulty`,
      )
    } else {
      console.log('world restored: difficulty Peaceful, arena empty (server-confirmed).')
    }
  } catch (e) {
    problems.push(`restore failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  return problems
}

// ---------- the demo ----------

function describePreemption(p: ReflexPreemption, i: number): string {
  const recovery =
    p.recovery === null
      ? 'still running'
      : p.recovery.ok
        ? 'ok'
        : `${p.recovery.reason}: ${p.recovery.detail}`
  return (
    `  [${i}] trigger=${p.trigger.kind} (${p.trigger.reason}) ` +
    `preempted=${p.action} recovery=${recovery}`
  )
}

async function main(): Promise<number> {
  const inner = new MineflayerExecutor({ username: USERNAME })
  const reflex = new ReflexExecutor(inner, {
    // Printed as it happens, so the console shows the reflex reacting live
    // rather than only in the summary. `recovery` is null at this point by
    // design — the callback runs synchronously, before the recovery starts.
    onPreempt: (p) => console.log(`\n  ⚡ REFLEX: ${p.trigger.kind} — ${p.trigger.reason} ` +
      `(preempting: ${p.action})`),
  })

  const deaths: number[] = []
  reflex.on('death', () => deaths.push(Date.now()))

  let difficultyRaised = false
  try {
    console.log('connecting…')
    const connected = await reflex.connect()
    if (!connected.ok) {
      console.error(`FAIL: could not connect — ${connected.reason}: ${connected.detail}`)
      return 1
    }

    console.log('building the enclosed arena…')
    await buildEnclosedArena()
    mc(`tp ${USERNAME} ${START.x} ${START.y} ${START.z}`)
    mc(`clear ${USERNAME}`)
    mc(`give ${USERNAME} stone_pickaxe 1`)
    await sleep(1_200)
    mc(`setblock ${ORE.x} ${ORE.y} ${ORE.z} coal_ore`)
    await sleep(1_200)

    // The bot is where the fixture says, on the floor the fixture built, and
    // the ore it is being sent after actually exists. Each is read back from
    // the world rather than assumed from a command having been sent.
    await waitForFooting(reflex, START.y)
    await expectBlockAt(ORE, 'coal_ore', 'the coal ore the goal is about')

    // Hostiles are removed instantly on Peaceful, so nothing combat-related can
    // run without this. Standing permission, Phase 5 spec §4.1 — and it is put
    // back in the `finally` below, verified against the server.
    console.log('raising difficulty to easy (restored at the end)…')
    mc('difficulty easy')
    difficultyRaised = true
    await sleep(500)

    // The summon runs alongside the goal: a mob that was already there before
    // the planner started would not demonstrate a plan being interrupted.
    let goalRunning = true
    // NOTE the `.catch` attached at creation, below. `await summon` further down
    // is the only other handler, and it is SKIPPED when runBotGoal throws — so a
    // watcher rejection (its `mc()` throws if the tmux session goes away
    // mid-run) would become an unhandled rejection, terminating the process
    // while `main`'s `finally` was still restoring the shared world: difficulty
    // left on easy, a live zombie, a pinned chunk. Handled at creation so no
    // path can leave it unobserved.
    const summon = (async (): Promise<{ summoned: boolean; note: string }> => {
      const startedAt = Date.now()
      await sleep(SUMMON_AFTER_MS)
      for (;;) {
        if (!goalRunning) {
          return { summoned: false, note: 'never summoned — the goal ended first' }
        }
        let here: Pos | null = null
        try {
          here = reflex.getState().self.position
        } catch {
          return { summoned: false, note: 'never summoned — the bot disconnected' }
        }
        const gap = dist(here, MOB_SPAWN)
        const overdue = Date.now() - startedAt >= SUMMON_DEADLINE_MS
        if (gap <= SUMMON_WITHIN || overdue) {
          // PersistenceRequired stops it despawning; it does NOT stop it
          // burning — the glowstone ceiling is what does that.
          mc(
            `summon zombie ${MOB_SPAWN.x} ${MOB_SPAWN.y} ${MOB_SPAWN.z} ` +
              `{PersistenceRequired:1b,Tags:["${MOB_TAG}"]}`,
          )
          const note =
            `summoned a zombie at (${MOB_SPAWN.x}, ${MOB_SPAWN.y}, ${MOB_SPAWN.z}), ` +
            `${gap.toFixed(1)} blocks from the bot, ` +
            `${((Date.now() - startedAt) / 1000).toFixed(1)}s into the run` +
            (overdue && gap > SUMMON_WITHIN ? ' (deadline reached, summoned anyway)' : '')
          console.log(`\n  → ${note}`)
          return { summoned: true, note }
        }
        await sleep(250)
      }
    })().catch((e: unknown) => ({
      summoned: false,
      note: `never summoned — the watcher itself failed: ${e instanceof Error ? e.message : String(e)}`,
    }))

    const llm = new OllamaClient()
    console.log(`\nasking ${llm.model} for decisions…\n`)

    let outcome
    try {
      outcome = await runBotGoal('get me some coal', {
        executor: reflex,
        decider: new SchemaDecider(llm),
        maxSteps: MAX_STEPS,
        signal: AbortSignal.timeout(RUN_BUDGET_MS),
      })
    } finally {
      // In a `finally`, not after the await: if the goal THROWS, a watcher left
      // running would keep polling and could summon a zombie during
      // `restoreWorld` — the one path where this demo could put a mob into the
      // shared world after having declared it clean. The watcher re-reads this
      // flag with no await between the check and the summon, so clearing it
      // synchronously here is enough to stop it.
      goalRunning = false
    }
    const summonResult = await summon

    console.log('\nStep log:')
    for (const step of outcome.steps) console.log(`  ${renderStep(step)}`)
    console.log(`\nOutcome: ${outcome.status}`)
    console.log(
      outcome.status === 'done' ? `Summary: ${outcome.summary}` : `Detail: ${outcome.detail}`,
    )
    console.log(`Mob: ${summonResult.note}`)

    const preemptions = reflex.preemptions
    console.log(`\nReflex preemptions: ${preemptions.length}`)
    preemptions.forEach((p, i) => console.log(describePreemption(p, i)))
    // `idle` means the trigger fired between actions — while the planner was
    // waiting on the model. Those are real preemptions, but only the others
    // show a plan actually being cut short, which is the point of the layer.
    const onPlan = preemptions.filter((p) => p.action !== 'idle')
    console.log(
      `  (${onPlan.length} of ${preemptions.length} interrupted an action the planner had ` +
        `in flight${onPlan.length > 0 ? `: ${[...new Set(onPlan.map((p) => p.action))].join(', ')}` : ''})`,
    )

    // flee is a stub (Task 6b is gated on an unagreed contract decision), so a
    // flee trigger can only ever record `internal`. Say so rather than letting
    // it read as a reflex defect.
    const fleeAttempts = preemptions.filter((p) => p.trigger.kind === 'flee')
    if (fleeAttempts.length > 0) {
      console.log(
        `\nNOTE: ${fleeAttempts.length} flee trigger(s) fired — the bot dropped to the flee ` +
          `threshold (health ≤ 6). \`flee\` is STILL A STUB (Phase 5 Task 6b is gated on an ` +
          `unagreed distance/timeout), so each returned internal: "flee arrives in Phase 5". ` +
          `That is the known gap, not a reflex failure.`,
      )
    }

    if (deaths.length > 0) {
      console.error(
        `FAIL: the bot DIED during the run (${deaths.length} death event(s)). Mineflayer ` +
          `respawns automatically at world spawn, so everything measured after that point ` +
          `describes a different situation.`,
      )
      return 1
    }
    if (preemptions.length === 0) {
      console.error(
        summonResult.summoned
          ? `FAIL: a zombie was summoned but no reflex preemption occurred. Either it never ` +
            `came within the ${DEFAULT_REFLEX_THRESHOLDS.hostileRadius}-block hostile radius, ` +
            `or no event reached the arbiter while it was there.`
          : `FAIL: the run ended before a zombie was ever summoned (${summonResult.note}), so ` +
            `the reflex layer was never given anything to react to. This is the demo's own ` +
            `timing at fault, not the reflex layer — see SUMMON_AFTER_MS.`,
      )
      return 1
    }
    const first = preemptions[0]!
    if (first.recovery?.ok !== true) {
      console.error(
        `FAIL: the reflex fired but its recovery did not succeed — ` +
          `${first.recovery === null ? 'it never settled' : `${first.recovery.reason}: ${first.recovery.detail}`}. ` +
          `A recorded trigger alone proves only that the rules noticed something.`,
      )
      return 1
    }

    console.log(
      `\nDONE: a zombie came within reach mid-goal; the reflex layer preempted ` +
        `"${first.action}", ran its ${first.trigger.kind} recovery against the live world, and ` +
        `it returned ok. The planner was handed back \`interrupted\` and re-observed. ` +
        `(\`flee\` remains a stub — this demo exercises the attack trigger.)`,
    )
    return 0
  } finally {
    // Whatever happened above, including a throw: put the shared world back.
    // Someone may be logged in, and difficulty is world-wide.
    try {
      await reflex.disconnect()
    } catch {
      // A disconnect that fails must not stop the world being restored.
    }
    // The forceload is released UNCONDITIONALLY — `forceload add` happens at the
    // top of buildEnclosedArena, whereas `difficultyRaised` is not set until
    // after the fixture checks, so gating the release the same way would leave
    // the chunks pinned on exactly the path those checks are designed to take
    // when a fixture is broken. See releaseForceload.
    //
    // But it is released **LAST**, after the sweeps. An entity selector only
    // matches inside LOADED chunks, so releasing the pin first lets the bot's
    // departure unload the arena and turns every `kill @e` into "No entity was
    // found" — a reply byte-identical to the true green, which would leave the
    // demo printing "arena empty (server-confirmed)" over a zombie still in the
    // saved chunk. That is the "fixture that can no-op without shouting" trap,
    // and the pin is what stops it. restoreWorld is nonetheless wrapped: it
    // catches internally today and returns complaints rather than throwing, and
    // this keeps the release unconditional even if that ever changes. `catch`
    // and not `finally`, because a throw raised inside this `finally` block
    // would replace whatever error is already propagating out of `main`.
    const problems: string[] = []
    try {
      if (difficultyRaised) problems.push(...(await restoreWorld()))
    } catch (e) {
      problems.push(`the world restore threw: ${e instanceof Error ? e.message : String(e)}`)
    }
    problems.push(...(await releaseForceload()))
    for (const p of problems) console.error(`RESTORE FAILED: ${p}`)
    if (problems.length > 0) process.exitCode = 1
  }
}

main().then(
  (code) => process.exit(process.exitCode === 1 ? 1 : code),
  (e: unknown) => {
    console.error('FAIL:', e instanceof Error ? e.message : String(e))
    process.exit(1)
  },
)
