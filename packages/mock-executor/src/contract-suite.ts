import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { BotExecutor } from '@minebot/contract'

export interface ContractSuiteContext {
  executor: BotExecutor
  cleanup?: () => Promise<void>
}

/**
 * Behavioural contract every BotExecutor must satisfy. Runs identically against
 * the mock and the real Mineflayer implementation; a passing run on both is what
 * makes the Phase 3 mock-to-real swap safe.
 */
export function runContractSuite(
  name: string,
  createExecutor: () => Promise<ContractSuiteContext>,
): void {
  describe(`BotExecutor contract: ${name}`, () => {
    let ctx: ContractSuiteContext

    beforeEach(async () => {
      ctx = await createExecutor()
    })

    afterEach(async () => {
      await ctx.cleanup?.()
    })

    it('reports a snapshot with plausible self state', () => {
      const s = ctx.executor.getState()
      expect(typeof s.takenAt).toBe('number')
      expect(s.takenAt).toBeLessThanOrEqual(Date.now())
      expect(s.self.health).toBeGreaterThanOrEqual(0)
      expect(s.self.health).toBeLessThanOrEqual(20)
      expect(s.self.food).toBeGreaterThanOrEqual(0)
      expect(s.self.food).toBeLessThanOrEqual(20)
      expect(Number.isFinite(s.self.position.x)).toBe(true)
      expect(Number.isFinite(s.self.position.y)).toBe(true)
      expect(Number.isFinite(s.self.position.z)).toBe(true)
      expect(Array.isArray(s.self.inventory)).toBe(true)
      expect(Array.isArray(s.nearbyEntities)).toBe(true)
    })

    it('returns a frozen snapshot that cannot be mutated', () => {
      const s = ctx.executor.getState()
      expect(Object.isFrozen(s)).toBe(true)
      expect(Object.isFrozen(s.self)).toBe(true)
      expect(Object.isFrozen(s.self.position)).toBe(true)
      const before = s.self.position.x
      expect(() => {
        ;(s.self.position as { x: number }).x = before + 999
      }).toThrow()
      expect(s.self.position.x).toBe(before)
    })

    it('returns a distinct snapshot object on each call', () => {
      const a = ctx.executor.getState()
      const b = ctx.executor.getState()
      expect(a).not.toBe(b)
      expect(b.takenAt).toBeGreaterThanOrEqual(a.takenAt)
    })

    it('returns no blocks for an empty name list', () => {
      expect(ctx.executor.findBlocks({ names: [], maxDistance: 16, limit: 5 })).toEqual([])
    })

    it('never returns more blocks than the requested limit', () => {
      const found = ctx.executor.findBlocks({
        names: ['stone', 'dirt', 'grass_block'],
        maxDistance: 16,
        limit: 2,
      })
      expect(found.length).toBeLessThanOrEqual(2)
      for (const b of found) {
        expect(typeof b.name).toBe('string')
        expect(b.distance).toBeGreaterThanOrEqual(0)
      }
    })

    it('resolves interrupted — never throws — when the signal is already aborted', async () => {
      const before = ctx.executor.getState().self.position
      const r = await ctx.executor.moveTo(
        { x: before.x + 50, y: before.y, z: before.z + 50 },
        { signal: AbortSignal.abort() },
      )
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('interrupted')
    })

    it('returns a callable unsubscribe from on()', () => {
      const off = ctx.executor.on('health', () => {})
      expect(typeof off).toBe('function')
      expect(() => off()).not.toThrow()
      expect(() => off()).not.toThrow()
    })

    it('accepts chat without throwing', () => {
      expect(() => ctx.executor.chat('contract suite check')).not.toThrow()
    })

    it('treats stop() as safe and idempotent', () => {
      expect(() => ctx.executor.stop()).not.toThrow()
      expect(() => ctx.executor.stop()).not.toThrow()
    })
  })
}
