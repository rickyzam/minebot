/**
 * Connect a handful of bots and keep them online.
 *
 * Exists so humans and bots can be seen sharing the world — the end-to-end check
 * that the Velocity topology works for both at once. Each bot connects straight
 * to the backend and proves itself with signed forwarding data, exactly as the
 * executor does everywhere else.
 *
 *   npm run bots            # default roster
 *   npm run bots -- 5       # five bots
 *
 * Ctrl-C disconnects them cleanly; without that they linger on the server as
 * ghost players until it notices the socket died.
 */
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { MineflayerExecutor } from '../packages/executor/src/index.js'
import { fetchRandomSkins, type SkinChoice } from './random-skin.js'
import { loadHistory, saveHistory, remember, DEFAULT_HISTORY_LIMIT } from './skin-history.js'

/** Gitignored; ~70 KB at the default 1000-entry cap. */
const HISTORY_PATH = new URL('../.skin-history.json', import.meta.url).pathname

/**
 * Distinct names, plus an armour colour used only as a fallback.
 *
 * By default each bot gets a **random** skin, sourced fresh on every run, so a
 * spawned group looks different each time. When skins cannot be fetched the bot
 * is dyed instead, so it is still tellable apart rather than being another
 * anonymous Steve. Pass `--no-skins` to always dye.
 */
const ROSTER = [
  { username: 'RubyBot', colour: 0xd4342b, label: 'red' },
  { username: 'JadeBot', colour: 0x3fa34d, label: 'green' },
  { username: 'AzureBot', colour: 0x2f7fd1, label: 'blue' },
  { username: 'AmberBot', colour: 0xe8a020, label: 'amber' },
  { username: 'VioletBot', colour: 0x8b4fbf, label: 'violet' },
  { username: 'CoralBot', colour: 0xf07f6e, label: 'coral' },
  { username: 'OnyxBot', colour: 0x2b2b30, label: 'black' },
  { username: 'IvoryBot', colour: 0xe8e2d0, label: 'ivory' },
  { username: 'CobaltBot', colour: 0x1f4fa0, label: 'cobalt' },
  { username: 'SiennaBot', colour: 0x9c5a33, label: 'sienna' },
  { username: 'TealBot', colour: 0x2f9d9a, label: 'teal' },
  { username: 'CrimsonBot', colour: 0x8f1d2f, label: 'crimson' },
]

const args = process.argv.slice(2)
const wantSkins = !args.includes('--no-skins')
const countArg = args.find((a) => /^\d+$/.test(a))
const count = Math.min(Math.max(Number(countArg ?? 3) || 3, 1), ROSTER.length)
const roster = ROSTER.slice(0, count)

const mc = (command: string): void => {
  try {
    execFileSync('tmux', ['send-keys', '-t', 'mc', command, 'Enter'])
  } catch {
    // No tmux console reachable: bots still connect, just undyed.
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Random v4 UUID, so each run's bots are new players to any viewer. */
function randomUuidV4(): Buffer {
  const bytes = randomBytes(16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  return bytes
}

async function main(): Promise<void> {
  const executors: Array<{ username: string; executor: MineflayerExecutor }> = []

  // Fetched before connecting: the skin travels in the login payload, so it has
  // to be chosen up front rather than applied afterwards.
  const history = wantSkins ? loadHistory(HISTORY_PATH) : { used: [] }
  const skins: SkinChoice[] = wantSkins
    ? await fetchRandomSkins(roster.length, { history })
    : []
  if (wantSkins && skins.length === 0) {
    console.log('No skins available (offline or rate-limited) — falling back to dyed armour.')
  } else if (wantSkins) {
    saveHistory(HISTORY_PATH, remember(history, skins.map((s) => s.texture)))
    console.log(
      `${skins.length} skin(s) chosen; ${history.used.length}/${DEFAULT_HISTORY_LIMIT} previously used skins excluded.`,
    )
  }

  for (const [index, { username, colour, label }] of roster.entries()) {
    const skin = skins[index]
    // A fresh identity per run. Viewers cache skins per player identity, so a
    // bot reusing its offline UUID keeps showing whatever skin that client saw
    // last time — which looked like duplicate and repeated skins even though
    // the server was advertising ten distinct ones.
    const uuid = randomUuidV4()
    const executor = new MineflayerExecutor({
      username,
      velocityUuid: uuid,
      // Mojang's signed pair, forwarded verbatim. Building the property by
      // hand produces an unsigned one, which clients silently discard.
      velocityProperties: skin
        ? [{ name: 'textures', value: skin.value, signature: skin.signature }]
        : undefined,
    })
    const result = await executor.connect()
    if (!result.ok) {
      console.error(`FAIL ${username}: ${result.reason} — ${result.detail}`)
      continue
    }
    executors.push({ username, executor })

    const state = executor.getState()
    const forwarding = executor.velocityForwarding()
    console.log(
      `${username.padEnd(10)} online  ` +
        `pos=(${state.self.position.x.toFixed(0)}, ${state.self.position.y.toFixed(0)}, ${state.self.position.z.toFixed(0)})  ` +
        `health=${state.self.health}  ` +
        `forwarding=${forwarding?.answered ? 'signed' : 'none'}  ` +
        `skin=${skin ? skin.texture.slice(0, 12) : 'none'}`,
    )

    // Only dye when there is no skin: armour would cover the skin we just went
    // to the trouble of picking.
    if (!skin) {
      for (const slot of ['head', 'chest', 'legs', 'feet'] as const) {
        const piece = { head: 'helmet', chest: 'chestplate', legs: 'leggings', feet: 'boots' }[slot]
        mc(
          `item replace entity ${username} armor.${slot} with leather_${piece}[dyed_color=${colour}]`,
        )
      }
    }
    mc(`say ${username} joined${skin ? '' : ` (${label})`}`)
    await sleep(400)
  }

  if (executors.length === 0) {
    console.error('No bots connected.')
    process.exit(1)
  }

  // New players are placed at a random point inside the server's spawn radius,
  // so with several bots two can land on the same block — seen for real. Spread
  // them once everyone is in, which also puts each on solid ground rather than
  // wherever the spawn roll happened to leave them.
  //
  // Targets are named explicitly rather than using @a: this must never move a
  // human who happens to be standing at spawn.
  const names = executors.map((e) => e.username).join(' ')
  mc(`spreadplayers 0 0 4 24 false ${names}`)
  await sleep(1500)

  const positions = new Map<string, string>()
  for (const { username, executor } of executors) {
    try {
      const p = executor.getState().self.position
      positions.set(username, `${Math.round(p.x)},${Math.round(p.z)}`)
    } catch {
      // Disconnected mid-spread; the status loop below will report it.
    }
  }
  const overlapping = positions.size - new Set(positions.values()).size
  console.log(
    overlapping === 0
      ? `Spread: all ${positions.size} bots on distinct blocks.`
      : `Spread: ${overlapping} bot(s) still sharing a block.`,
  )

  console.log(`\n${executors.length} bot(s) online. Ctrl-C to disconnect them.`)

  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    console.log('\nDisconnecting…')
    await Promise.all(executors.map(({ executor }) => executor.disconnect()))
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  // Report every 30s so the session shows the bots are still alive, and so a
  // silent disconnect is visible rather than looking like everything is fine.
  for (;;) {
    await sleep(30_000)
    if (shuttingDown) return
    const alive = executors
      .map(({ username, executor }) => {
        try {
          return `${username}=${executor.getState().self.health}hp`
        } catch {
          return `${username}=DISCONNECTED`
        }
      })
      .join('  ')
    console.log(`[${new Date().toLocaleTimeString()}] ${alive}`)
  }
}

main().catch((e: unknown) => {
  console.error('FAIL:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})
