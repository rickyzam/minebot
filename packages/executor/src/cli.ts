import { MineflayerExecutor } from './index.js'

const main = async (): Promise<void> => {
  const executor = new MineflayerExecutor({ username: 'MineBot' })

  console.log('connecting to localhost:25566 …')
  const connected = await executor.connect()
  if (!connected.ok) {
    console.error(`FAILED: ${connected.reason} — ${connected.detail}`)
    process.exitCode = 1
    return
  }

  try {
    const before = executor.getState()
    console.log('spawned. state snapshot:')
    console.log(JSON.stringify(before, null, 2))

    const target = {
      x: Math.round(before.self.position.x) + 8,
      y: before.self.position.y,
      z: Math.round(before.self.position.z),
    }
    console.log(`walking to x=${target.x} z=${target.z} …`)

    const moved = await executor.moveTo(target, { timeoutMs: 30_000 })
    if (moved.ok) {
      const after = executor.getState().self.position
      console.log(`arrived at x=${after.x.toFixed(1)} y=${after.y.toFixed(1)} z=${after.z.toFixed(1)}`)
    } else {
      console.log(`did not arrive: ${moved.reason} — ${moved.detail}`)
      process.exitCode = 1
    }
  } finally {
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
