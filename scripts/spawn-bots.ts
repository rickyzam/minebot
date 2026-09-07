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
import { execFileSync } from 'node:child_process'
import { MineflayerExecutor } from '../packages/executor/src/index.js'

/**
 * Distinct names and armour colours, so several bots standing together are
 * telnameable apart at a glance. Dyed leather is used rather than skins because
 * it needs no external texture hosting — a real skin needs a `textures` property,
 * which the forwarding path supports but which needs a URL someone has chosen.
 */
const ROSTER = [
  { username: 'RubyBot', colour: 0xd4342b, label: 'red' },
  { username: 'JadeBot', colour: 0x3fa34d, label: 'green' },
  { username: 'AzureBot', colour: 0x2f7fd1, label: 'blue' },
  { username: 'AmberBot', colour: 0xe8a020, label: 'amber' },
  { username: 'VioletBot', colour: 0x8b4fbf, label: 'violet' },
]

const count = Math.min(Math.max(Number(process.argv[2] ?? 3) || 3, 1), ROSTER.length)
const roster = ROSTER.slice(0, count)

const mc = (command: string): void => {
  try {
    execFileSync('tmux', ['send-keys', '-t', 'mc', command, 'Enter'])
  } catch {
    // No tmux console reachable: bots still connect, just undyed.
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const executors: Array<{ username: string; executor: MineflayerExecutor }> = []

  for (const { username, colour, label } of roster) {
    const executor = new MineflayerExecutor({ username })
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
        `uuid=${executor.uuid()}`,
    )

    // Colour-code them so they are distinguishable in-world at a glance.
    for (const slot of ['head', 'chest', 'legs', 'feet'] as const) {
      const piece = { head: 'helmet', chest: 'chestplate', legs: 'leggings', feet: 'boots' }[slot]
      mc(
        `item replace entity ${username} armor.${slot} with leather_${piece}[dyed_color=${colour}]`,
      )
    }
    mc(`say ${username} (${label}) joined`)
    await sleep(400)
  }

  if (executors.length === 0) {
    console.error('No bots connected.')
    process.exit(1)
  }

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
