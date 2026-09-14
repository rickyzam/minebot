import { connect, type Socket } from 'node:net'

/** The backend's port, matching `MineflayerExecutor`'s default. */
const DEFAULT_PORT = 25566

/**
 * Resolves if something is listening on the backend's port; rejects with the
 * command that fixes it if not.
 *
 * The backend is deliberately NOT autostarted (see `mc.service` and CLAUDE.md:
 * a world must be flushed on the way down, so bringing one up stays a deliberate
 * act). The consequence is that after every reboot it is down, and everything
 * that needs it — 134 integration tests, five demos, three benches — fails at
 * that point with a connection error per bot, which reads as "my code is broken"
 * rather than "the server is not running".
 *
 * This turns that into one line naming the fix. It is a TCP check and nothing
 * more: it does not log in, so it cannot be confused with `npm run smoke`, which
 * proves a bot can actually complete the Fabric and Velocity handshakes. A green
 * preflight and a red smoke is a real and useful distinction — the server is up
 * but the bot cannot join it.
 *
 * Deliberately does NOT start the server. A test run that silently brings up
 * shared infrastructure is a side effect on state outside the repo that nobody
 * asked for, and on a machine where someone may be playing.
 */
export async function requireBackend(
  opts: { host?: string; port?: number; timeoutMs?: number } = {},
): Promise<void> {
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? DEFAULT_PORT
  const timeoutMs = opts.timeoutMs ?? 3_000

  const reachable = await new Promise<boolean>((resolve) => {
    let socket: Socket | undefined
    // `settle` rather than resolving inline: connect, error and timeout can all
    // fire, and the socket must be destroyed exactly once either way or the
    // process keeps a handle open and a demo never exits.
    const settle = (result: boolean): void => {
      socket?.removeAllListeners()
      socket?.destroy()
      resolve(result)
    }
    socket = connect({ host, port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })

  if (!reachable) {
    throw new Error(
      `the Minecraft backend is not listening on ${host}:${port} — start it with:\n` +
        `\n    systemctl --user start mc\n\n` +
        `It is deliberately not autostarted (a world has to be flushed on the way ` +
        `down, so starting one stays a deliberate act), which means it is down ` +
        `after every reboot.\n` +
        `\nThis check only proves the port is open. Whether a bot can actually ` +
        `log in — the Fabric registry sync and the Velocity forwarding handshake ` +
        `— is what \`npm run smoke\` proves.`,
    )
  }
}
