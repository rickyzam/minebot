/**
 * Phase 2 deliverable: path to a known coal-ore coordinate, mine it, collect
 * the drop. Uses the floating arena so it is reproducible on any world rather
 * than depending on terrain that may not contain surface coal.
 */
import { execFileSync } from 'node:child_process'
import { MineflayerExecutor } from './index.js'

const USERNAME = 'Phase2Demo'
const FLOOR = 199
const ARENA = { x0: 950, x1: 980, z0: 0, z1: 8 }
const START = { x: 955, y: FLOOR + 1, z: 4 }
const ORE = { x: 968, y: FLOOR + 1, z: 4 }

const mc = (command: string): void => {
  execFileSync('tmux', ['send-keys', '-t', 'mc', command, 'Enter'])
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<number> {
  const executor = new MineflayerExecutor({ username: USERNAME })
  try {
    console.log('connecting…')
    const connected = await executor.connect()
    if (!connected.ok) {
      console.error(`FAIL: could not connect — ${connected.reason}: ${connected.detail}`)
      return 1
    }

    console.log('building the arena…')
    mc(`forceload add ${ARENA.x0} ${ARENA.z0} ${ARENA.x1} ${ARENA.z1}`)
    await sleep(800)
    mc(`fill ${ARENA.x0} ${FLOOR + 1} ${ARENA.z0} ${ARENA.x1} ${FLOOR + 6} ${ARENA.z1} air`)
    mc(`fill ${ARENA.x0} ${FLOOR} ${ARENA.z0} ${ARENA.x1} ${FLOOR} ${ARENA.z1} stone`)
    // Loose drops are entities, not blocks — the air fill above does not touch
    // them, and one left by a previous run would be collected by this one.
    mc(`kill @e[type=item,x=965,y=${FLOOR},z=4,distance=..40]`)
    await sleep(700)
    mc(`tp ${USERNAME} ${START.x} ${START.y} ${START.z}`)
    mc(`clear ${USERNAME}`)
    mc(`give ${USERNAME} stone_pickaxe 1`)
    await sleep(1_200)
    // A wall with one gap, so arriving proves pathing rather than walking.
    mc(`fill 962 ${FLOOR + 1} ${ARENA.z0} 962 ${FLOOR + 3} ${ARENA.z1} stone`)
    mc(`fill 962 ${FLOOR + 1} 1 962 ${FLOOR + 3} 1 air`)
    mc(`setblock ${ORE.x} ${ORE.y} ${ORE.z} coal_ore`)
    await sleep(1_200)

    const before = executor.getState()
    console.log(
      `at x=${before.self.position.x.toFixed(1)} z=${before.self.position.z.toFixed(1)}, ` +
        `health ${before.self.health}, holding ${before.self.heldItem?.name ?? 'nothing'}`,
    )

    const found = executor.findBlocks({ names: ['coal_ore'], maxDistance: 32, limit: 5 })
    console.log(
      `found ${found.length} coal_ore; nearest at ` +
        `${found[0] ? `(${found[0].position.x}, ${found[0].position.y}, ${found[0].position.z})` : 'n/a'}`,
    )
    if (!found[0]) {
      console.error('FAIL: no coal ore found — the arena setup did not take')
      return 1
    }

    console.log('mining it…')
    const mined = await executor.mineBlock(found[0].position, 32, { timeoutMs: 90_000 })
    if (!mined.ok) {
      console.error(`FAIL: ${mined.reason}: ${mined.detail}`)
      return 1
    }

    const after = executor.getState()
    const coal = after.self.inventory.find((i) => i.name === 'coal')
    console.log(
      `mined at (${mined.value.position.x}, ${mined.value.position.y}, ${mined.value.position.z}), ` +
        `collected=${mined.value.collected}`,
    )
    console.log(
      `inventory: ${after.self.inventory.map((i) => `${i.name}x${i.count}`).join(', ') || '(empty)'}`,
    )

    if (!mined.value.collected || !coal) {
      console.error('FAIL: the ore was mined but the coal was not collected')
      return 1
    }
    console.log('DONE: pathed around a wall, mined coal ore, collected the drop.')
    return 0
  } finally {
    await executor.disconnect()
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error('FAIL:', e instanceof Error ? e.message : String(e))
    process.exit(1)
  },
)
