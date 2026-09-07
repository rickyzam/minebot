import { describe, it, expect, afterEach } from 'vitest'
import { MineflayerExecutor } from '../../src/index.js'

describe('MineflayerExecutor.moveTo', () => {
  let executor: MineflayerExecutor | null = null

  afterEach(async () => {
    await executor?.disconnect()
    executor = null
  })

  it('walks to a nearby coordinate', async () => {
    executor = new MineflayerExecutor({ username: 'ITMove' })
    await executor.connect()
    const start = executor.getState().self.position
    const target = { x: Math.round(start.x) + 6, y: start.y, z: Math.round(start.z) }

    const r = await executor.moveTo(target, { timeoutMs: 30_000 })
    expect(r.ok).toBe(true)

    const end = executor.getState().self.position
    expect(Math.hypot(end.x - target.x, end.z - target.z)).toBeLessThanOrEqual(2)
  })

  it('resolves interrupted when the signal is already aborted, without moving', async () => {
    executor = new MineflayerExecutor({ username: 'ITMovePreAbort' })
    await executor.connect()
    const start = executor.getState().self.position

    const r = await executor.moveTo(
      { x: start.x + 40, y: start.y, z: start.z + 40 },
      { signal: AbortSignal.abort() },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('interrupted')

    const end = executor.getState().self.position
    expect(Math.hypot(end.x - start.x, end.z - start.z)).toBeLessThan(2)
  })

  it('resolves interrupted when aborted mid-walk and stops moving', async () => {
    executor = new MineflayerExecutor({ username: 'ITMoveAbort' })
    await executor.connect()
    const start = executor.getState().self.position
    const controller = new AbortController()

    const pending = executor.moveTo(
      { x: start.x + 60, y: start.y, z: start.z },
      { signal: controller.signal, timeoutMs: 30_000 },
    )
    setTimeout(() => controller.abort(), 1_000)
    const r = await pending

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('interrupted')

    const atAbort = executor.getState().self.position
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const later = executor.getState().self.position
    expect(Math.hypot(later.x - atAbort.x, later.z - atAbort.z)).toBeLessThan(2)
  })

  it('times out on an unreachable target', async () => {
    executor = new MineflayerExecutor({ username: 'ITMoveTimeout' })
    await executor.connect()
    const start = executor.getState().self.position

    const r = await executor.moveTo(
      { x: start.x + 5_000, y: start.y, z: start.z + 5_000 },
      { timeoutMs: 6_000 },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('timeout')
  })
})
