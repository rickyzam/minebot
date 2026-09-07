import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { ActionOptions, BotExecutor, Result } from '@minebot/contract'

export interface ContractSuiteContext {
  executor: BotExecutor
  cleanup?: () => Promise<void>
  /**
   * Declares that this executor instance is seeded (or, for a live world,
   * known) to have at least `minCount` blocks matching `names` findable with
   * a generous query. Without this, the suite's findBlocks assertions run
   * against an executor that may have zero matching blocks in its world —
   * `found.length <= limit` passes trivially on an empty array, and any
   * per-block assertions never execute. Optional so a factory that genuinely
   * cannot guarantee findable blocks can omit it, but every current factory
   * (the mock's seeded suite instance, and the real executor's integration
   * factory against blocks reliably near dev-server spawn) supplies it, and
   * new factories should too rather than let the block section degrade back
   * to vacuous.
   */
  expectFindable?: { names: readonly string[]; minCount: number }
}

/**
 * Behavioural contract every BotExecutor must satisfy. Runs identically against
 * the mock and the real Mineflayer implementation; a passing run on both is what
 * makes the Phase 3 mock-to-real swap safe.
 *
 * Coverage note: this suite verifies the pre-abort contract — every abortable
 * action must resolve `{ ok: false, reason: 'interrupted' }` (and never throw)
 * when handed a signal that is already aborted before the action starts. It
 * deliberately does NOT test mid-flight cancellation here: that is
 * timing-dependent and cannot be asserted portably against a live networked
 * server without flaking. Mid-flight abort stays covered per-implementation —
 * the mock's `actionDelayMs`-based test, and a Task 6 integration test for the
 * real executor.
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
      // Reuse the fixture's seeded names when declared, so this actually
      // exercises the per-block loop below instead of running (vacuously)
      // against an executor with zero matching blocks in its world.
      const names = ctx.expectFindable?.names ?? ['stone', 'dirt', 'grass_block']
      const found = ctx.executor.findBlocks({ names: [...names], maxDistance: 32, limit: 2 })
      expect(found.length).toBeLessThanOrEqual(2)
      for (const b of found) {
        expect(typeof b.name).toBe('string')
        expect(b.distance).toBeGreaterThanOrEqual(0)
      }
    })

    it('finds seeded blocks nearest-first (BlockQuery/BlockInfo ordering guarantee)', () => {
      // Skipped (not failed) when a factory hasn't declared expectFindable —
      // see the field's doc comment. Both factories in this repo declare it,
      // so in practice this always runs.
      if (!ctx.expectFindable) return
      const { names, minCount } = ctx.expectFindable

      const found = ctx.executor.findBlocks({ names: [...names], maxDistance: 64, limit: 20 })

      // The core false-green fix: assert a *non-empty*, seed-backed result,
      // not just "no more than the limit" (which an always-[] findBlocks
      // would also satisfy).
      expect(found.length).toBeGreaterThanOrEqual(minCount)
      for (const b of found) {
        expect(names).toContain(b.name)
        expect(b.distance).toBeGreaterThanOrEqual(0)
      }
      // Nearest-first: distances must be non-decreasing across the result.
      for (let i = 1; i < found.length; i++) {
        expect(found[i]!.distance).toBeGreaterThanOrEqual(found[i - 1]!.distance)
      }
    })

    // Valid-shape arguments that need no matching world state: the point of
    // each case is that the signal check happens before any work, so the
    // call must resolve `interrupted` regardless of whether the target,
    // player, block, or entity actually exists.
    const abortableActions: Array<{
      name: string
      run: (executor: BotExecutor, opts: ActionOptions) => Promise<Result<unknown>>
    }> = [
      { name: 'moveTo', run: (e, opts) => e.moveTo({ x: 0, y: 64, z: 0 }, opts) },
      { name: 'followPlayer', run: (e, opts) => e.followPlayer('nonexistent-player', opts) },
      { name: 'mineBlock', run: (e, opts) => e.mineBlock('stone', 16, opts) },
      {
        name: 'mineBlock(Vec3)',
        run: (e, opts) => e.mineBlock({ x: 0, y: 64, z: 0 }, 16, opts),
      },
      {
        name: 'placeBlock',
        run: (e, opts) => e.placeBlock('dirt', { x: 0, y: 64, z: 0 }, opts),
      },
      { name: 'attack', run: (e, opts) => e.attack(0, opts) },
      { name: 'flee', run: (e, opts) => e.flee(opts) },
    ]

    it.each(abortableActions)(
      'resolves interrupted — never throws — for $name when the signal is already aborted',
      async ({ run }) => {
        const r = await run(ctx.executor, { signal: AbortSignal.abort() })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.reason).toBe('interrupted')
      },
    )

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

    // Fix 1 (post-review): stop() must be an emergency brake, not just a
    // best-effort request. Before the fix, stop() cleared control states once,
    // but moveTo's own physicsTick handler re-asserted forward movement on the
    // very next tick, so a moveTo already in flight sailed on regardless and
    // eventually resolved 'timeout' (or 'ok', if it happened to arrive) —
    // never 'interrupted'. Target a point far enough away that neither
    // implementation could possibly have arrived (or even come close) between
    // starting the call and stop() cancelling it one line later.
    it('stop() settles an in-flight action as interrupted', async () => {
      const start = ctx.executor.getState().self.position
      const pending = ctx.executor.moveTo(
        { x: start.x + 10_000, y: start.y, z: start.z },
        { timeoutMs: 5_000 },
      )
      ctx.executor.stop()
      const result = await pending
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('interrupted')

      // Not just "reports interrupted" — actually halted. A bot that kept
      // walking after stop() but merely mislabeled the eventual timeout as
      // interrupted would still fail this.
      const after = ctx.executor.getState().self.position
      expect(Math.hypot(after.x - start.x, after.z - start.z)).toBeLessThan(5)
    })

    // Fix 2 (post-review): the mock and real executor used to disagree about
    // what "not connected" means. The real executor threw synchronously from
    // every action (via requireBot()); the mock silently succeeded — moveTo
    // while disconnected returned `ok` and updated its position, findBlocks
    // returned `[]` instead of throwing. Nothing here exercised any of it, so
    // Track B could write `if (!r.ok) switch (r.reason)` against one
    // implementation and get an unhandled rejection against the other.
    describe('disconnected behaviour', () => {
      it.each(abortableActions)(
        'resolves disconnected — never throws — for $name after disconnect()',
        async ({ run }) => {
          await ctx.executor.disconnect()
          const r = await run(ctx.executor, {})
          expect(r.ok).toBe(false)
          if (!r.ok) expect(r.reason).toBe('disconnected')
        },
      )

      it('throws from getState() after disconnect(), same as before connecting', async () => {
        await ctx.executor.disconnect()
        expect(() => ctx.executor.getState()).toThrow()
      })

      it('throws from findBlocks() after disconnect() rather than returning []', async () => {
        await ctx.executor.disconnect()
        expect(() =>
          ctx.executor.findBlocks({ names: ['stone'], maxDistance: 16, limit: 1 }),
        ).toThrow()
      })

      it('registers safely (never throws) from on() after disconnect()', async () => {
        await ctx.executor.disconnect()
        let off: (() => void) | undefined
        expect(() => {
          off = ctx.executor.on('health', () => {})
        }).not.toThrow()
        expect(typeof off).toBe('function')
        expect(() => off?.()).not.toThrow()
      })
    })

    // Design spec §9.1: the reflex layer subscribes once at startup and expects
    // to keep hearing about damage for the session's lifetime. Handlers bound
    // to a single Bot instance silently stopped firing after any reconnect.
    describe('subscription lifetime', () => {
      it('delivers events to a handler registered while not connected', async () => {
        await ctx.executor.disconnect()
        let seen = 0
        const off = ctx.executor.on('spawned', () => {
          seen += 1
        })
        const r = await ctx.executor.connect()
        expect(r.ok).toBe(true)
        expect(seen).toBeGreaterThan(0)
        off()
      })

      it('keeps a subscription alive across a disconnect/reconnect cycle', async () => {
        let seen = 0
        const off = ctx.executor.on('spawned', () => {
          seen += 1
        })
        await ctx.executor.disconnect()
        const before = seen
        const r = await ctx.executor.connect()
        expect(r.ok).toBe(true)
        expect(seen).toBeGreaterThan(before)
        off()
      })

      it('stops delivering after unsubscribe, even across a reconnect', async () => {
        let seen = 0
        const off = ctx.executor.on('spawned', () => {
          seen += 1
        })
        off()
        const atUnsubscribe = seen
        await ctx.executor.disconnect()
        await ctx.executor.connect()
        expect(seen).toBe(atUnsubscribe)
      })

      // Post-review Important 2: emit() must not let one bad subscriber take
      // down the emitter or the action that triggered it (here, connect()'s
      // own explicit `emit('spawned', {})`). A throwing handler used to hang
      // the real executor until connectTimeoutMs and reject the mock's
      // connect() outright — divergent failure modes for the same bug.
      it('keeps delivering to other handlers, and resolves connect() ok, when one spawned handler throws', async () => {
        const offThrower = ctx.executor.on('spawned', () => {
          throw new Error('deliberately broken subscriber')
        })
        let seen = 0
        const offRecorder = ctx.executor.on('spawned', () => {
          seen += 1
        })
        await ctx.executor.disconnect()
        const before = seen
        const r = await ctx.executor.connect()
        expect(r.ok).toBe(true)
        expect(seen).toBeGreaterThan(before)
        offThrower()
        offRecorder()
      })
    })

    // Design spec §9.4: this.bot was set only on spawn, so a second connect()
    // before the first resolved built a *second* bot — which on an offline-mode
    // server duplicate-logins and kicks the first. Pairs with disconnect()
    // during an in-flight connect() being a silent no-op.
    describe('connect() reentrancy', () => {
      // Discriminating via ok/getState() alone is not enough: a
      // not-actually-shared second attempt costs a mock nothing observable
      // (it just also succeeds), so a naive "both ok" assertion passes even
      // with the sharing guard deleted. 'spawned' firing exactly once is the
      // signal that only one underlying connection attempt ran — two
      // independent attempts would each emit it.
      it('shares one connection attempt between concurrent connect() calls', async () => {
        await ctx.executor.disconnect()
        let spawnCount = 0
        const off = ctx.executor.on('spawned', () => {
          spawnCount += 1
        })
        const [a, b] = await Promise.all([ctx.executor.connect(), ctx.executor.connect()])
        off()
        expect(a.ok).toBe(true)
        expect(b.ok).toBe(true)
        expect(spawnCount).toBe(1)
        // Still usable afterwards — a duplicate login would have kicked one off.
        expect(() => ctx.executor.getState()).not.toThrow()
      })

      it('is idempotent when already connected', async () => {
        const r = await ctx.executor.connect()
        expect(r.ok).toBe(true)
        expect(() => ctx.executor.getState()).not.toThrow()
      })

      // Post-review Important 1 + 2: the disconnect-honouring check (and the
      // clearing of the pending-attempt slot) must live *inside* the shared
      // promise, not in a per-caller wrapper around it — otherwise (a)
      // disconnect() can return before teardown has actually finished, and
      // (b) only the caller that owns the wrapper sees the corrected
      // `interrupted` result while a caller merely sharing the pending
      // attempt gets back the pre-correction `ok: true`. Racing a disconnect()
      // against *two* concurrent connect() callers, and pinning both results,
      // catches both: (a) via the disconnected getState() below, (b) via `b`
      // (the sharer) being asserted equal to `a` (the owner) rather than
      // left unchecked.
      it('leaves the executor disconnected when disconnect() races a pending connect()', async () => {
        await ctx.executor.disconnect()
        const connectingA = ctx.executor.connect()
        const connectingB = ctx.executor.connect()
        await ctx.executor.disconnect()
        const [a, b] = await Promise.all([connectingA, connectingB])
        expect(a.ok).toBe(false)
        if (!a.ok) expect(a.reason).toBe('interrupted')
        expect(b.ok).toBe(false)
        if (!b.ok) expect(b.reason).toBe('interrupted')
        expect(() => ctx.executor.getState()).toThrow()
      })
    })
  })
}
