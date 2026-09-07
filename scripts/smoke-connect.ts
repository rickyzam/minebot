import mineflayer from 'mineflayer'
import {
  installFabricHandshake,
  type ProtocolClientLike,
} from '../packages/executor/src/fabric-handshake.js'

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'SmokeBot',
  auth: 'offline',
  version: '1.21.10',
})

// The dev server runs Fabric content mods, which reject a client that has not
// completed the registry-sync handshake. Without this the smoke check fails
// before it can tell you anything about the server, which defeats its purpose
// of separating "my code is broken" from "the server is unreachable".
const fabric = installFabricHandshake(bot._client as unknown as ProtocolClientLike)

const finish = (message: string, code: number): void => {
  console.log(message)
  try {
    bot.quit()
  } catch {
    // already gone
  }
  process.exit(code)
}

const timer = setTimeout(() => finish('FAIL: no spawn within 25s', 1), 25_000)

bot.once('spawn', () => {
  clearTimeout(timer)
  const p = bot.entity.position
  console.log('OK: spawned')
  console.log(`  version:   ${bot.version}`)
  console.log(`  position:  x=${p.x.toFixed(1)} y=${p.y.toFixed(1)} z=${p.z.toFixed(1)}`)
  console.log(`  health:    ${bot.health}  food: ${bot.food}`)
  console.log(`  gameMode:  ${bot.game.gameMode}`)
  console.log(
    `  fabric:    ${fabric.completed ? `registry sync completed, ${fabric.moddedEntries.length} modded entries` : 'no registry sync (vanilla server)'}`,
  )
  setTimeout(() => finish('DONE', 0), 1_000)
})

bot.on('error', (e: Error) => finish(`FAIL: ${e.message}`, 1))
bot.on('kicked', (reason: unknown) => finish(`FAIL kicked: ${JSON.stringify(reason)}`, 1))
