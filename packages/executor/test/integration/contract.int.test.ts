import { runContractSuite } from '@minebot/mock-executor/contract-suite'
import { MineflayerExecutor } from '../../src/index.js'

runContractSuite('MineflayerExecutor', async () => {
  const executor = new MineflayerExecutor({ username: 'ITContract' })
  const connected = await executor.connect()
  if (!connected.ok) {
    throw new Error(`could not reach the dev server: ${connected.reason} ${connected.detail}`)
  }
  return { executor, cleanup: () => executor.disconnect() }
})
