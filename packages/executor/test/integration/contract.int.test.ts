import { runContractSuite } from '@minebot/mock-executor/contract-suite'
import { MineflayerExecutor } from '../../src/index.js'

runContractSuite('MineflayerExecutor', async () => {
  const executor = new MineflayerExecutor({ username: 'ITContract' })
  const connected = await executor.connect()
  if (!connected.ok) {
    throw new Error(`could not reach the dev server: ${connected.reason} ${connected.detail}`)
  }
  return {
    executor,
    cleanup: () => executor.disconnect(),
    // Fix 4 (post-review): these names are reliably present within a modest
    // radius of any dev-server spawn (surface terrain and the layer beneath
    // it), so the suite's findBlocks assertions exercise real, non-empty
    // results here rather than passing vacuously against an empty world.
    expectFindable: { names: ['stone', 'dirt', 'grass_block', 'deepslate'], minCount: 1 },
  }
})
