/**
 * Print a layer-by-layer map of an arena volume — including the floor, so
 * *removed* floor shows up as clearly as added walls.
 *
 *   npm run arena:map                          # the Phase 3 demo arena
 *   npm run arena:map -- 1300 1330 0 8 199     # x0 x1 z0 z1 floorY
 *
 * Written during Phase 3, when a hand-built obstruction had to be recorded
 * rather than described, and it earned its keep twice over: it established
 * what the terrain actually was, and its before/after block counts proved the
 * bot had neither broken nor placed anything while crossing.
 *
 * Reads the world through a real bot, so it sees exactly what the executor
 * sees — which is the point. It reports what is *loaded and visible to a
 * client*, not what is on disk.
 */
import { execFileSync } from 'node:child_process'
import { MineflayerExecutor } from '@minebot/executor'

/**
 * Blocks worth looking for. `findBlocks` matches by name, so anything absent
 * here reads as air — if a map looks emptier than the world, add the material.
 */
const CANDIDATES = [
  'stone', 'cobblestone', 'dirt', 'grass_block', 'oak_planks', 'spruce_planks',
  'oak_log', 'spruce_log', 'sand', 'gravel', 'andesite', 'diorite', 'granite',
  'deepslate', 'cobbled_deepslate', 'stone_bricks', 'bricks', 'netherrack',
  'obsidian', 'glass', 'white_wool', 'terracotta', 'smooth_stone', 'sandstone',
  'mossy_cobblestone', 'blackstone', 'basalt', 'tuff', 'calcite',
  'coal_ore', 'iron_ore', 'deepslate_coal_ore',
  'oak_slab', 'stone_slab', 'oak_fence', 'ladder', 'scaffolding',
]

interface Bounds {
  x0: number
  x1: number
  z0: number
  z1: number
  floorY: number
}

function parseArgs(argv: readonly string[]): Bounds {
  const nums = argv.map(Number)
  if (nums.length === 0) return { x0: 1300, x1: 1330, z0: 0, z1: 8, floorY: 199 }
  if (nums.length !== 5 || nums.some((n) => !Number.isFinite(n))) {
    console.error('usage: npm run arena:map -- <x0> <x1> <z0> <z1> <floorY>')
    process.exit(2)
  }
  const [x0, x1, z0, z1, floorY] = nums as [number, number, number, number, number]
  return { x0, x1, z0, z1, floorY }
}

async function main(): Promise<void> {
  const b = parseArgs(process.argv.slice(2))
  const yLo = b.floorY
  const yHi = b.floorY + 4

  const executor = new MineflayerExecutor({ username: 'ArenaMap' })
  const connected = await executor.connect()
  if (!connected.ok) {
    console.error(`could not connect: ${connected.reason}: ${connected.detail}`)
    process.exit(1)
  }
  try {
    // Hover well above the platform. Teleporting onto it risks landing in a
    // hole, and this tool must not disturb what it is here to measure.
    const cx = Math.floor((b.x0 + b.x1) / 2)
    const cz = Math.floor((b.z0 + b.z1) / 2)
    execFileSync('tmux', [
      'send-keys', '-t', 'mc', `tp ArenaMap ${cx} ${b.floorY + 12} ${cz}`, 'Enter',
    ])
    await new Promise((r) => setTimeout(r, 3_000))

    const blocks = executor
      .findBlocks({ names: CANDIDATES, maxDistance: 64, limit: 8000 })
      .filter(
        (blk) =>
          blk.position.y >= yLo && blk.position.y <= yHi &&
          blk.position.x >= b.x0 && blk.position.x <= b.x1 &&
          blk.position.z >= b.z0 && blk.position.z <= b.z1,
      )

    const at = (x: number, y: number, z: number): string | null =>
      blocks.find((k) => k.position.x === x && k.position.y === y && k.position.z === z)?.name ??
      null

    const byName = new Map<string, number>()
    for (const blk of blocks) byName.set(blk.name, (byName.get(blk.name) ?? 0) + 1)
    console.log(`${blocks.length} block(s) in x${b.x0}..${b.x1} z${b.z0}..${b.z1} y${yLo}..${yHi}:`)
    for (const [name, count] of [...byName].sort()) console.log(`  ${name} x${count}`)

    const header = `     ${[...Array<number>(b.x1 - b.x0 + 1)].map((_, i) => (b.x0 + i) % 10).join('')}`
    for (let y = yLo; y <= yHi; y++) {
      const label = y === b.floorY ? " (THE FLOOR — '.' here is a HOLE)" : ''
      console.log(`\n--- y=${y}${label} ---`)
      console.log(header)
      for (let z = b.z0; z <= b.z1; z++) {
        let row = ''
        for (let x = b.x0; x <= b.x1; x++) {
          const name = at(x, y, z)
          row += name === null ? '.' : name.endsWith('_ore') ? 'C' : '#'
        }
        console.log(`z=${z}  ${row}`)
      }
    }
    console.log(`\nx runs ${b.x0}..${b.x1} left to right; z runs ${b.z0}..${b.z1} top to bottom.`)
    console.log("'#' solid, 'C' ore, '.' air.")
  } finally {
    await executor.disconnect()
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
