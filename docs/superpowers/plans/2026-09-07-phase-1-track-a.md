# Phase 1 (Track A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Mineflayer-backed bot logs into the local dev server, reports an immutable state snapshot, and walks to a fixed coordinate — with the shared `BotExecutor` contract and its cross-implementation test suite in place.

**Architecture:** Four npm workspace packages. `contract` holds types only and has zero dependencies. `mock-executor` provides a test double plus a contract-test suite that any `BotExecutor` implementation must pass. `executor` implements that contract against Mineflayer. `agent` (Track B, Ricky) is out of scope here. The contract suite runs against both the mock and the real executor, which is what makes the Phase 3 mock→real swap verifiable rather than hoped for.

**Tech Stack:** TypeScript 7, Node 24 (ESM), npm workspaces, Vitest 5, Mineflayer 4.39, tsx.

**Spec:** [`docs/superpowers/specs/2026-09-07-minecraft-agent-design.md`](../specs/2026-09-07-minecraft-agent-design.md)

## Global Constraints

- Node `>=24`. All packages are ESM (`"type": "module"`).
- Package names are scoped `@minebot/*`. All are `"private": true`.
- `packages/contract` MUST have zero runtime dependencies. It is types plus two helper functions only.
- `packages/agent` MUST NOT depend on `mineflayer`. Track B talks to the contract only.
- Minecraft dev server: Fabric **1.21.10**, `localhost:25565`, `online-mode=false`, world seed `minebot`, survival + peaceful.
- Mineflayer connects with `auth: 'offline'` and an explicit `version: '1.21.10'`.
- **Contract rule:** on abort, an action MUST resolve `{ ok: false, reason: 'interrupted' }`. It MUST NOT throw and MUST NOT resolve `ok: true`.
- Unit tests never touch the network. Integration tests are the only tests that require a running server, and live under `packages/*/test/integration/`.
- Pin exact dependency versions listed in Task 1 and Task 4.

**Verified against the live dev server on 2026-09-07** — these are measurements, not assumptions:

- `bot.version` reports **`'1.21.9'`** even when `version: '1.21.10'` is requested, because both map to protocol 773. Never assert on `bot.version`.
- `bot.health` and `bot.food` are **`undefined` at the `spawn` event** and populate ~100ms later on the first `health` event. `connect()` must wait for that (Task 5) or every snapshot taken right after connecting reports health 0.
- **World chunks finish loading ~450ms AFTER the first `health` packet**, not before or alongside it. Measured during Task 5: `findBlocks()` returns 0 when called on the health event and 5 about 450ms later. So `connect()` must also await `bot.waitForChunksToLoad()` (best-effort — catch and proceed, never fail `connect()` over it), or every block search immediately after connecting comes back empty.
- `bot.game.dimension` is `'overworld'`, not `'minecraft:overworld'`.
- `bot.entity.onGround` and `bot.entity.isCollidedHorizontally` are both real booleans, so Task 6's auto-jump works.
- At spawn (`y≈70`) there are 5+ `stone`/`dirt`/`grass_block` blocks within 24 and ~84 visible entities, so the block-search tests have real data. No `coal_ore` is visible at the surface — that is Phase 4's problem, not Phase 1's.

---

### Task 1: Workspace skeleton and the contract package

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `packages/contract/package.json`
- Create: `packages/contract/src/index.ts`
- Test: `packages/contract/test/result.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the entire `@minebot/contract` surface used by every later task — `Vec3`, `Result<T>`, `FailureReason`, `ok()`, `fail()`, `ActionOptions`, `WorldSnapshot`, `SelfState`, `ItemStack`, `EntityInfo`, `BlockInfo`, `BlockQuery`, `BotEvents`, `Unsubscribe`, `BotExecutor`.

- [ ] **Step 1: Create the workspace root files**

`package.json`:

```json
{
  "name": "minebot",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "26.4.1",
    "tsx": "4.23.13",
    "typescript": "7.0.2",
    "vitest": "5.0.0"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

`tsconfig.json`:

```json
{
  "extends": "./tsconfig.base.json",
  "include": ["packages/*/src/**/*.ts", "packages/*/test/**/*.ts", "vitest.config.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts'],
          exclude: ['packages/*/test/integration/**'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/*/test/integration/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
})
```

- [ ] **Step 2: Create the contract package manifest**

`packages/contract/package.json`:

```json
{
  "name": "@minebot/contract",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": { "types": "./src/index.ts", "default": "./src/index.ts" }
  }
}
```

- [ ] **Step 3: Write the failing test**

`packages/contract/test/result.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { ok, fail, type Result } from '@minebot/contract'

describe('Result helpers', () => {
  it('ok() wraps a value and narrows to the success branch', () => {
    const r: Result<number> = ok(42)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(42)
  })

  it('ok() supports void results', () => {
    const r: Result = ok(undefined)
    expect(r.ok).toBe(true)
  })

  it('fail() carries a reason and a detail string', () => {
    const r = fail('not_found', 'no coal within 32 blocks')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('not_found')
      expect(r.detail).toBe('no coal within 32 blocks')
    }
  })

  it('fail() defaults detail to an empty string', () => {
    const r = fail('timeout')
    if (!r.ok) expect(r.detail).toBe('')
  })

  it('a failure is assignable to Result<T> for any T', () => {
    const r: Result<{ position: { x: number; y: number; z: number } }> = fail('unreachable')
    expect(r.ok).toBe(false)
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
npm install
npm test
```

Expected: FAIL — cannot resolve `@minebot/contract` (the source file does not exist yet).

- [ ] **Step 5: Write the contract**

`packages/contract/src/index.ts`:

```ts
/** A point in the world. Integer block coordinates unless stated otherwise. */
export interface Vec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

// ---------- Results ----------

export type Result<T = void> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: FailureReason; readonly detail: string }

export type FailureReason =
  | 'not_found'
  | 'unreachable'
  | 'interrupted'
  | 'invalid_target'
  | 'missing_tool'
  | 'inventory_full'
  | 'timeout'
  | 'disconnected'
  | 'internal'

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })

export const fail = (reason: FailureReason, detail = ''): Result<never> => ({
  ok: false,
  reason,
  detail,
})

// ---------- Cancellation ----------

export interface ActionOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

// ---------- Observation ----------

export interface ItemStack {
  readonly name: string
  readonly count: number
  readonly slot: number
}

export type EntityKind = 'player' | 'hostile' | 'passive' | 'item' | 'other'

export interface EntityInfo {
  readonly id: number
  readonly name: string
  readonly kind: EntityKind
  readonly position: Vec3
  readonly distance: number
  readonly health?: number
}

export interface BlockInfo {
  readonly name: string
  readonly position: Vec3
  readonly distance: number
}

export interface BlockQuery {
  readonly names: readonly string[]
  readonly maxDistance: number
  readonly limit: number
}

export interface SelfState {
  readonly position: Vec3
  readonly health: number
  readonly food: number
  readonly dimension: string
  readonly onGround: boolean
  readonly inventory: readonly ItemStack[]
  readonly heldItem: ItemStack | null
}

export interface WorldSnapshot {
  readonly takenAt: number
  readonly self: SelfState
  readonly nearbyEntities: readonly EntityInfo[]
}

// ---------- Events ----------

export interface BotEvents {
  spawned: Record<string, never>
  health: { health: number; food: number }
  damaged: { health: number; source: EntityInfo | null }
  entityNearby: { entity: EntityInfo }
  chat: { username: string; message: string }
  death: Record<string, never>
  disconnected: { reason: string }
}

export type Unsubscribe = () => void

// ---------- The executor ----------

export interface BotExecutor {
  connect(): Promise<Result>
  disconnect(): Promise<void>

  /** Immutable point-in-time snapshot. Throws if not connected. */
  getState(): WorldSnapshot
  findBlocks(query: BlockQuery): readonly BlockInfo[]

  on<K extends keyof BotEvents>(
    event: K,
    handler: (payload: BotEvents[K]) => void,
  ): Unsubscribe

  moveTo(target: Vec3, opts?: ActionOptions): Promise<Result>
  followPlayer(playerName: string, opts?: ActionOptions): Promise<Result>
  mineBlock(
    blockName: string,
    maxDistance: number,
    opts?: ActionOptions,
  ): Promise<Result<{ position: Vec3; collected: boolean }>>
  placeBlock(blockName: string, position: Vec3, opts?: ActionOptions): Promise<Result>
  attack(entityId: number, opts?: ActionOptions): Promise<Result>
  flee(opts?: ActionOptions): Promise<Result>

  chat(message: string): void
  /** Halt movement immediately. Always safe to call, including when disconnected. */
  stop(): void
}
```

- [ ] **Step 6: Run tests and typecheck to verify they pass**

```bash
npm test
npm run typecheck
```

Expected: 5 tests PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.base.json tsconfig.json vitest.config.ts packages/contract package-lock.json
git commit -m "feat(contract): add BotExecutor contract and workspace skeleton"
```

---

### Task 2: Contract test suite and MockExecutor

**Files:**
- Create: `packages/mock-executor/package.json`
- Create: `packages/mock-executor/src/index.ts`
- Create: `packages/mock-executor/src/mock-executor.ts`
- Create: `packages/mock-executor/src/contract-suite.ts`
- Test: `packages/mock-executor/test/mock-executor.test.ts`

**Interfaces:**
- Consumes: all of `@minebot/contract` from Task 1.
- Produces:
  - `class MockExecutor implements BotExecutor` with constructor `(opts?: MockOptions)`, a public readonly `calls: RecordedCall[]`, and a test helper `emit<K extends keyof BotEvents>(event: K, payload: BotEvents[K]): void`.
  - `interface MockOptions { position?, health?, food?, inventory?, entities?, blocks?, actionDelayMs? }`
  - `interface RecordedCall { name: string; args: unknown[] }`
  - `function runContractSuite(name: string, createExecutor: () => Promise<ContractSuiteContext>): void`
  - `interface ContractSuiteContext { executor: BotExecutor; cleanup?: () => Promise<void> }`
  - Subpath export `@minebot/mock-executor/contract-suite` (Task 7 imports the suite from here).

- [ ] **Step 1: Create the package manifest**

`packages/mock-executor/package.json`:

```json
{
  "name": "@minebot/mock-executor",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": { "types": "./src/index.ts", "default": "./src/index.ts" },
    "./contract-suite": {
      "types": "./src/contract-suite.ts",
      "default": "./src/contract-suite.ts"
    }
  },
  "dependencies": {
    "@minebot/contract": "0.1.0"
  },
  "peerDependencies": {
    "vitest": "5.0.0"
  }
}
```

- [ ] **Step 2: Write the failing test**

`packages/mock-executor/test/mock-executor.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { MockExecutor } from '@minebot/mock-executor'
import { runContractSuite } from '@minebot/mock-executor/contract-suite'

runContractSuite('MockExecutor', async () => {
  const executor = new MockExecutor({ actionDelayMs: 20 })
  await executor.connect()
  return { executor, cleanup: () => executor.disconnect() }
})

describe('MockExecutor specifics', () => {
  it('records the calls made against it', async () => {
    const m = new MockExecutor()
    await m.connect()
    await m.moveTo({ x: 1, y: 2, z: 3 })
    m.chat('hello')
    expect(m.calls.map((c) => c.name)).toEqual(['connect', 'moveTo', 'chat'])
  })

  it('updates its position after a successful moveTo', async () => {
    const m = new MockExecutor({ position: { x: 0, y: 64, z: 0 } })
    await m.connect()
    const r = await m.moveTo({ x: 10, y: 64, z: -5 })
    expect(r.ok).toBe(true)
    expect(m.getState().self.position).toEqual({ x: 10, y: 64, z: -5 })
  })

  it('does not move when the action is aborted mid-flight', async () => {
    const m = new MockExecutor({ position: { x: 0, y: 64, z: 0 }, actionDelayMs: 500 })
    await m.connect()
    const c = new AbortController()
    const p = m.moveTo({ x: 99, y: 64, z: 99 }, { signal: c.signal })
    setTimeout(() => c.abort(), 10)
    const r = await p
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('interrupted')
    expect(m.getState().self.position).toEqual({ x: 0, y: 64, z: 0 })
  })

  it('returns canned blocks filtered by name, distance and limit', async () => {
    const m = new MockExecutor({
      blocks: [
        { name: 'coal_ore', position: { x: 5, y: 60, z: 0 }, distance: 5 },
        { name: 'coal_ore', position: { x: 40, y: 60, z: 0 }, distance: 40 },
        { name: 'iron_ore', position: { x: 6, y: 60, z: 0 }, distance: 6 },
      ],
    })
    await m.connect()
    const found = m.findBlocks({ names: ['coal_ore'], maxDistance: 32, limit: 10 })
    expect(found).toHaveLength(1)
    expect(found[0]?.name).toBe('coal_ore')
  })

  it('delivers emitted events to subscribers and stops after unsubscribe', async () => {
    const m = new MockExecutor()
    await m.connect()
    const seen: number[] = []
    const off = m.on('health', (p) => seen.push(p.health))
    m.emit('health', { health: 12, food: 20 })
    off()
    m.emit('health', { health: 3, food: 20 })
    expect(seen).toEqual([12])
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm install
npm test
```

Expected: FAIL — cannot resolve `@minebot/mock-executor`.

- [ ] **Step 4: Write the contract suite**

`packages/mock-executor/src/contract-suite.ts`:

```ts
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
```

- [ ] **Step 5: Write the MockExecutor**

`packages/mock-executor/src/mock-executor.ts`:

```ts
import {
  ok,
  fail,
  type ActionOptions,
  type BlockInfo,
  type BlockQuery,
  type BotEvents,
  type BotExecutor,
  type EntityInfo,
  type ItemStack,
  type Result,
  type Unsubscribe,
  type Vec3,
  type WorldSnapshot,
} from '@minebot/contract'

export interface MockOptions {
  position?: Vec3
  health?: number
  food?: number
  inventory?: ItemStack[]
  entities?: EntityInfo[]
  blocks?: BlockInfo[]
  /** Simulated duration of each action, so cancellation can be exercised. */
  actionDelayMs?: number
}

export interface RecordedCall {
  name: string
  args: unknown[]
}

type Handler = (payload: never) => void

export class MockExecutor implements BotExecutor {
  readonly calls: RecordedCall[] = []

  private connected = false
  private position: Vec3
  private health: number
  private food: number
  private inventory: ItemStack[]
  private entities: EntityInfo[]
  private blocks: BlockInfo[]
  private readonly delayMs: number
  private readonly handlers = new Map<string, Set<Handler>>()

  constructor(opts: MockOptions = {}) {
    this.position = opts.position ?? { x: 0, y: 64, z: 0 }
    this.health = opts.health ?? 20
    this.food = opts.food ?? 20
    this.inventory = opts.inventory ?? []
    this.entities = opts.entities ?? []
    this.blocks = opts.blocks ?? []
    this.delayMs = opts.actionDelayMs ?? 0
  }

  async connect(): Promise<Result> {
    this.record('connect')
    this.connected = true
    return ok(undefined)
  }

  async disconnect(): Promise<void> {
    this.record('disconnect')
    this.connected = false
  }

  getState(): WorldSnapshot {
    if (!this.connected) throw new Error('MockExecutor.getState() called while disconnected')
    const self = Object.freeze({
      position: Object.freeze({ ...this.position }),
      health: this.health,
      food: this.food,
      dimension: 'overworld',
      onGround: true,
      inventory: Object.freeze(this.inventory.map((i) => Object.freeze({ ...i }))),
      heldItem: this.inventory[0] ? Object.freeze({ ...this.inventory[0] }) : null,
    })
    return Object.freeze({
      takenAt: Date.now(),
      self,
      nearbyEntities: Object.freeze(this.entities.map((e) => Object.freeze({ ...e }))),
    })
  }

  findBlocks(query: BlockQuery): readonly BlockInfo[] {
    const names = new Set(query.names)
    return Object.freeze(
      this.blocks
        .filter((b) => names.has(b.name) && b.distance <= query.maxDistance)
        .slice(0, query.limit)
        .map((b) => Object.freeze({ ...b })),
    )
  }

  on<K extends keyof BotEvents>(
    event: K,
    handler: (payload: BotEvents[K]) => void,
  ): Unsubscribe {
    const set = this.handlers.get(event) ?? new Set<Handler>()
    set.add(handler as Handler)
    this.handlers.set(event, set)
    return () => {
      set.delete(handler as Handler)
    }
  }

  /** Test helper: drive the event stream by hand. */
  emit<K extends keyof BotEvents>(event: K, payload: BotEvents[K]): void {
    for (const h of this.handlers.get(event) ?? []) {
      ;(h as (p: BotEvents[K]) => void)(payload)
    }
  }

  async moveTo(target: Vec3, opts?: ActionOptions): Promise<Result> {
    this.record('moveTo', target)
    const r = await this.simulate(opts)
    if (!r.ok) return r
    this.position = { ...target }
    return ok(undefined)
  }

  async followPlayer(playerName: string, opts?: ActionOptions): Promise<Result> {
    this.record('followPlayer', playerName)
    return this.simulate(opts)
  }

  async mineBlock(
    blockName: string,
    maxDistance: number,
    opts?: ActionOptions,
  ): Promise<Result<{ position: Vec3; collected: boolean }>> {
    this.record('mineBlock', blockName, maxDistance)
    const r = await this.simulate(opts)
    if (!r.ok) return r
    const match = this.blocks.find(
      (b) => b.name === blockName && b.distance <= maxDistance,
    )
    if (!match) return fail('not_found', `no ${blockName} within ${maxDistance} blocks`)
    this.blocks = this.blocks.filter((b) => b !== match)
    this.inventory = [
      ...this.inventory,
      { name: blockName, count: 1, slot: this.inventory.length },
    ]
    return ok({ position: match.position, collected: true })
  }

  async placeBlock(blockName: string, position: Vec3, opts?: ActionOptions): Promise<Result> {
    this.record('placeBlock', blockName, position)
    return this.simulate(opts)
  }

  async attack(entityId: number, opts?: ActionOptions): Promise<Result> {
    this.record('attack', entityId)
    const r = await this.simulate(opts)
    if (!r.ok) return r
    if (!this.entities.some((e) => e.id === entityId)) {
      return fail('not_found', `no entity ${entityId}`)
    }
    return ok(undefined)
  }

  async flee(opts?: ActionOptions): Promise<Result> {
    this.record('flee')
    return this.simulate(opts)
  }

  chat(message: string): void {
    this.record('chat', message)
  }

  stop(): void {
    this.record('stop')
  }

  private record(name: string, ...args: unknown[]): void {
    this.calls.push({ name, args })
  }

  /** Honour the contract's cancellation rule: resolve interrupted, never throw. */
  private simulate(opts?: ActionOptions): Promise<Result> {
    if (opts?.signal?.aborted) return Promise.resolve(fail('interrupted', 'aborted before start'))
    if (this.delayMs === 0) return Promise.resolve(ok(undefined))
    return new Promise<Result>((resolve) => {
      const signal = opts?.signal
      const onAbort = () => {
        clearTimeout(timer)
        resolve(fail('interrupted', 'aborted mid-action'))
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve(ok(undefined))
      }, this.delayMs)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}
```

`packages/mock-executor/src/index.ts`:

```ts
export { MockExecutor } from './mock-executor.js'
export type { MockOptions, RecordedCall } from './mock-executor.js'
```

- [ ] **Step 6: Run tests and typecheck to verify they pass**

```bash
npm test
npm run typecheck
```

Expected: all contract-suite tests plus 5 MockExecutor tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/mock-executor package-lock.json
git commit -m "feat(mock-executor): add mock and shared BotExecutor contract suite"
```

---

### Task 3: Snapshot mapper (pure logic)

Converting Mineflayer's live, mutable bot object into an immutable `WorldSnapshot` is the piece with real logic in it, so it lives in its own module and is tested without any network or Mineflayer import.

**Files:**
- Create: `packages/executor/package.json`
- Create: `packages/executor/src/snapshot.ts`
- Test: `packages/executor/test/snapshot.test.ts`

**Interfaces:**
- Consumes: `@minebot/contract` types.
- Produces:
  - `interface RawEntity { id, type?, name?, kind?, username?, position, health? }`
  - `interface RawItem { name, count, slot }`
  - `interface MineflayerLike { entity, health?, food?, game?, entities, inventory, heldItem? }`
  - `function classifyEntity(e: RawEntity): EntityKind`
  - `function toSnapshot(bot: MineflayerLike, now?: number): WorldSnapshot`

- [ ] **Step 1: Create the package manifest**

`packages/executor/package.json`:

```json
{
  "name": "@minebot/executor",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": { "types": "./src/index.ts", "default": "./src/index.ts" }
  },
  "dependencies": {
    "@minebot/contract": "0.1.0"
  }
}
```

- [ ] **Step 2: Write the failing test**

`packages/executor/test/snapshot.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { classifyEntity, toSnapshot, type MineflayerLike } from '../src/snapshot.js'

const bot = (over: Partial<MineflayerLike> = {}): MineflayerLike => ({
  entity: { position: { x: 10, y: 64, z: -20 }, onGround: true },
  health: 18,
  food: 15,
  game: { dimension: 'minecraft:overworld' },
  entities: {},
  inventory: { items: () => [] },
  heldItem: null,
  ...over,
})

describe('classifyEntity', () => {
  it('classifies players', () => {
    expect(classifyEntity({ id: 1, type: 'player', username: 'Steve', position: { x: 0, y: 0, z: 0 } })).toBe('player')
  })

  it('classifies hostile mobs by kind', () => {
    expect(classifyEntity({ id: 2, type: 'mob', name: 'zombie', kind: 'Hostile mobs', position: { x: 0, y: 0, z: 0 } })).toBe('hostile')
  })

  it('classifies passive mobs by kind', () => {
    expect(classifyEntity({ id: 3, type: 'mob', name: 'cow', kind: 'Passive mobs', position: { x: 0, y: 0, z: 0 } })).toBe('passive')
  })

  it('classifies dropped items', () => {
    expect(classifyEntity({ id: 4, type: 'object', name: 'item', position: { x: 0, y: 0, z: 0 } })).toBe('item')
  })

  it('falls back to other for anything unrecognised', () => {
    expect(classifyEntity({ id: 5, type: 'object', name: 'boat', position: { x: 0, y: 0, z: 0 } })).toBe('other')
  })
})

describe('toSnapshot', () => {
  it('maps self state from the bot', () => {
    const s = toSnapshot(bot(), 1000)
    expect(s.takenAt).toBe(1000)
    expect(s.self.position).toEqual({ x: 10, y: 64, z: -20 })
    expect(s.self.health).toBe(18)
    expect(s.self.food).toBe(15)
    expect(s.self.dimension).toBe('minecraft:overworld')
    expect(s.self.onGround).toBe(true)
  })

  it('deep-freezes the snapshot so callers cannot mutate it', () => {
    const s = toSnapshot(bot(), 1000)
    expect(Object.isFrozen(s)).toBe(true)
    expect(Object.isFrozen(s.self)).toBe(true)
    expect(Object.isFrozen(s.self.position)).toBe(true)
    expect(() => {
      ;(s.self.position as { x: number }).x = 999
    }).toThrow()
  })

  it('copies values so later bot mutation does not change a taken snapshot', () => {
    const live = bot()
    const s = toSnapshot(live, 1000)
    live.entity!.position.x = 999
    expect(s.self.position.x).toBe(10)
  })

  it('maps inventory stacks', () => {
    const s = toSnapshot(
      bot({ inventory: { items: () => [{ name: 'coal', count: 3, slot: 9 }] } }),
      1000,
    )
    expect(s.self.inventory).toEqual([{ name: 'coal', count: 3, slot: 9 }])
  })

  it('computes entity distance from the bot and sorts nearest first', () => {
    const s = toSnapshot(
      bot({
        entity: { position: { x: 0, y: 64, z: 0 }, onGround: true },
        entities: {
          '2': { id: 2, type: 'mob', name: 'cow', kind: 'Passive mobs', position: { x: 30, y: 64, z: 0 } },
          '1': { id: 1, type: 'mob', name: 'zombie', kind: 'Hostile mobs', position: { x: 3, y: 64, z: 4 } },
        },
      }),
      1000,
    )
    expect(s.nearbyEntities.map((e) => e.id)).toEqual([1, 2])
    expect(s.nearbyEntities[0]?.distance).toBeCloseTo(5)
    expect(s.nearbyEntities[0]?.kind).toBe('hostile')
  })

  it('prefers username as the display name for players', () => {
    const s = toSnapshot(
      bot({
        entities: {
          '7': { id: 7, type: 'player', username: 'Onetruezman', position: { x: 1, y: 64, z: 0 } },
        },
      }),
      1000,
    )
    expect(s.nearbyEntities[0]?.name).toBe('Onetruezman')
  })

  it('defaults health, food and dimension when the bot has not reported them', () => {
    const s = toSnapshot(
      bot({ health: undefined, food: undefined, game: undefined }),
      1000,
    )
    expect(s.self.health).toBe(0)
    expect(s.self.food).toBe(0)
    expect(s.self.dimension).toBe('unknown')
  })

  it('throws a clear error when the bot has not spawned', () => {
    expect(() => toSnapshot(bot({ entity: null }), 1000)).toThrow(/not spawned/i)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm install
npm test
```

Expected: FAIL — `../src/snapshot.js` does not exist.

- [ ] **Step 4: Write the snapshot mapper**

`packages/executor/src/snapshot.ts`:

```ts
import type {
  EntityInfo,
  EntityKind,
  ItemStack,
  SelfState,
  Vec3,
  WorldSnapshot,
} from '@minebot/contract'

/**
 * Structural subset of Mineflayer's Bot that the mapper reads. Declared here
 * rather than imported so this module stays testable with plain object literals.
 */
export interface RawPosition {
  x: number
  y: number
  z: number
}

export interface RawEntity {
  id: number
  type?: string
  name?: string
  kind?: string
  username?: string
  position: RawPosition
  health?: number
}

export interface RawItem {
  name: string
  count: number
  slot: number
}

export interface MineflayerLike {
  entity: { position: RawPosition; onGround?: boolean } | null
  health?: number
  food?: number
  game?: { dimension?: string }
  entities: Record<string, RawEntity | undefined>
  inventory: { items(): RawItem[] }
  heldItem?: RawItem | null
}

export function classifyEntity(e: RawEntity): EntityKind {
  if (e.type === 'player') return 'player'
  if (e.name === 'item' || e.type === 'orb') return 'item'
  const kind = e.kind ?? ''
  if (kind.includes('Hostile')) return 'hostile'
  if (kind.includes('Passive') || kind.includes('Animals')) return 'passive'
  return 'other'
}

const freezeVec = (p: RawPosition): Vec3 => Object.freeze({ x: p.x, y: p.y, z: p.z })

const freezeItem = (i: RawItem): ItemStack =>
  Object.freeze({ name: i.name, count: i.count, slot: i.slot })

const distance = (a: RawPosition, b: RawPosition): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/**
 * Take an immutable snapshot of the bot's world view. Values are copied, so a
 * snapshot stays valid even as the live bot object keeps changing underneath it.
 */
export function toSnapshot(bot: MineflayerLike, now: number = Date.now()): WorldSnapshot {
  if (!bot.entity) {
    throw new Error('toSnapshot: bot has not spawned yet (bot.entity is null)')
  }
  const origin = bot.entity.position

  const inventory = Object.freeze(bot.inventory.items().map(freezeItem))

  const self: SelfState = Object.freeze({
    position: freezeVec(origin),
    health: bot.health ?? 0,
    food: bot.food ?? 0,
    dimension: bot.game?.dimension ?? 'unknown',
    onGround: bot.entity.onGround ?? false,
    inventory,
    heldItem: bot.heldItem ? freezeItem(bot.heldItem) : null,
  })

  const nearbyEntities: readonly EntityInfo[] = Object.freeze(
    Object.values(bot.entities)
      .filter((e): e is RawEntity => e !== undefined && e.position !== undefined)
      .map((e) =>
        Object.freeze({
          id: e.id,
          name: e.username ?? e.name ?? 'unknown',
          kind: classifyEntity(e),
          position: freezeVec(e.position),
          distance: distance(origin, e.position),
          ...(e.health === undefined ? {} : { health: e.health }),
        }),
      )
      .sort((a, b) => a.distance - b.distance),
  )

  return Object.freeze({ takenAt: now, self, nearbyEntities })
}
```

- [ ] **Step 5: Run tests and typecheck to verify they pass**

```bash
npm test
npm run typecheck
```

Expected: 13 new tests PASS (5 for `classifyEntity`, 8 for `toSnapshot`).

- [ ] **Step 6: Commit**

```bash
git add packages/executor package-lock.json
git commit -m "feat(executor): map Mineflayer state to an immutable snapshot"
```

---

### Task 4: Unblock the dev server and prove a bot can connect

The dev server currently loads `nitwitmap`, which forces every client to have Fabric plus matching mods and rejects vanilla-protocol clients — which is what Mineflayer is. No bot can connect until it is removed. Verified 2026-09-07: `ProbeBot … lost connection: This server requires Fabric Loader and Fabric API installed on your client! … nitwitmap`.

**Files:**
- Modify: `packages/executor/package.json` (add the `mineflayer` dependency)
- Create: `scripts/smoke-connect.ts`
- Modify: `~/minecraft/server/minebot/mods/` (move `nitwitmap-1.0.0.jar` out — outside the repo)

**Interfaces:**
- Consumes: nothing from earlier tasks (standalone script).
- Produces: a repeatable smoke check, `npm run smoke`, that later tasks use to confirm the server is reachable before running integration tests.

> **Steps 1–2 were completed and verified on 2026-09-07.** The mod is in
> `mods-disabled/`, the server was restarted via tmux, and a probe bot spawned
> successfully at `x=352.5 y=70.0 z=-564.5`. They are recorded here so the fix is
> reproducible if the world or server folder is ever rebuilt.

- [x] **Step 1: Disable the blocking mod on the dev server**

```bash
mkdir -p ~/minecraft/server/minebot/mods-disabled
mv ~/minecraft/server/minebot/mods/nitwitmap-1.0.0.jar ~/minecraft/server/minebot/mods-disabled/
ls ~/minecraft/server/minebot/mods/
```

Expected: only `fabric-api-0.138.4+1.21.10.jar` remains. This touches the dev server only; the survival server keeps its copy.

- [x] **Step 2: Restart the dev server**

```bash
tmux send-keys -t mc 'stop' Enter
sleep 15
tmux send-keys -t mc 'cd ~/minecraft/server/minebot && java -Xms16G -Xmx16G -jar fabric-server-mc.1.21.10-loader.0.19.2-launcher.1.1.1.jar nogui' Enter
sleep 20
tail -5 ~/minecraft/server/minebot/logs/latest.log
```

Expected: a `Done (…)! For help, type "help"` line. Always use `stop`, never `kill`, so the world saves cleanly.

- [ ] **Step 3: Add the Mineflayer dependency**

Add to `packages/executor/package.json` `dependencies` (keep `@minebot/contract`):

```json
    "mineflayer": "4.39.0"
```

Then:

```bash
npm install
```

- [ ] **Step 4: Write the smoke script**

`scripts/smoke-connect.ts`:

```ts
import mineflayer from 'mineflayer'

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'SmokeBot',
  auth: 'offline',
  version: '1.21.10',
})

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
  setTimeout(() => finish('DONE', 0), 1_000)
})

bot.on('error', (e: Error) => finish(`FAIL: ${e.message}`, 1))
bot.on('kicked', (reason: unknown) => finish(`FAIL kicked: ${JSON.stringify(reason)}`, 1))
```

Add to the root `package.json` `scripts`:

```json
    "smoke": "tsx scripts/smoke-connect.ts"
```

- [ ] **Step 5: Run the smoke check**

```bash
npm run smoke
```

Expected: `OK: spawned` with a real position and `health: 20`. If it still reports the Fabric/mods kick, another mod is registering client-required content — move `fabric-api` to `mods-disabled/` too and restart; a vanilla dev server is fine for bot work.

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke-connect.ts package.json packages/executor/package.json package-lock.json
git commit -m "chore: add dev-server smoke connect check"
```

---

### Task 5: MineflayerExecutor — connect, state, blocks, events

**Files:**
- Create: `packages/executor/src/mineflayer-executor.ts`
- Create: `packages/executor/src/index.ts`
- Test: `packages/executor/test/integration/connect.int.test.ts`

**Interfaces:**
- Consumes: `toSnapshot` from Task 3; `@minebot/contract`.
- Produces:
  - `interface MineflayerExecutorOptions { host?: string; port?: number; username?: string; version?: string; connectTimeoutMs?: number }`
  - `class MineflayerExecutor implements BotExecutor` with constructor `(opts?: MineflayerExecutorOptions)`.
  - Defaults: `host 'localhost'`, `port 25565`, `username 'MineBot'`, `version '1.21.10'`, `connectTimeoutMs 30_000`.
  - Task 6 fills in `moveTo`; Task 7 imports the class for the contract suite.

- [ ] **Step 1: Write the failing integration test**

`packages/executor/test/integration/connect.int.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { MineflayerExecutor } from '../../src/index.js'

describe('MineflayerExecutor against the dev server', () => {
  let executor: MineflayerExecutor | null = null

  afterEach(async () => {
    await executor?.disconnect()
    executor = null
  })

  it('connects and spawns', async () => {
    executor = new MineflayerExecutor({ username: 'ITConnect' })
    const r = await executor.connect()
    expect(r.ok).toBe(true)
  })

  it('reports a live snapshot after spawning', async () => {
    executor = new MineflayerExecutor({ username: 'ITState' })
    await executor.connect()
    const s = executor.getState()
    expect(s.self.health).toBeGreaterThan(0)
    expect(s.self.health).toBeLessThanOrEqual(20)
    expect(Number.isFinite(s.self.position.y)).toBe(true)
    expect(Object.isFrozen(s)).toBe(true)
  })

  it('has populated health by the time connect() resolves', async () => {
    // Regression guard: bot.health is undefined at the 'spawn' event and only
    // arrives on the first 'health' packet. connect() must not resolve before then.
    executor = new MineflayerExecutor({ username: 'ITHealth' })
    await executor.connect()
    expect(executor.getState().self.health).toBe(20)
    expect(executor.getState().self.food).toBe(20)
  })

  it('throws from getState() before connecting', () => {
    executor = new MineflayerExecutor({ username: 'ITUnused' })
    expect(() => executor!.getState()).toThrow(/not connected/i)
  })

  it('finds solid blocks near spawn', async () => {
    executor = new MineflayerExecutor({ username: 'ITBlocks' })
    await executor.connect()
    const found = executor.findBlocks({
      names: ['stone', 'dirt', 'grass_block', 'deepslate'],
      maxDistance: 24,
      limit: 5,
    })
    expect(found.length).toBeGreaterThan(0)
    expect(found.length).toBeLessThanOrEqual(5)
    expect(found[0]?.distance).toBeGreaterThanOrEqual(0)
  })

  it('delivers health events and stops after unsubscribe', async () => {
    executor = new MineflayerExecutor({ username: 'ITEvents' })
    await executor.connect()
    let calls = 0
    const off = executor.on('health', () => {
      calls += 1
    })
    expect(typeof off).toBe('function')
    off()
    expect(calls).toBeGreaterThanOrEqual(0)
  })

  it('reports disconnected when the server refuses the connection', async () => {
    executor = new MineflayerExecutor({ username: 'ITBadPort', port: 25599, connectTimeoutMs: 8_000 })
    const r = await executor.connect()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(['disconnected', 'timeout']).toContain(r.reason)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run test:integration
```

Expected: FAIL — `MineflayerExecutor` is not exported.

- [ ] **Step 3: Write the executor**

`packages/executor/src/mineflayer-executor.ts`:

```ts
import mineflayer, { type Bot } from 'mineflayer'
import {
  ok,
  fail,
  type ActionOptions,
  type BlockInfo,
  type BlockQuery,
  type BotEvents,
  type BotExecutor,
  type Result,
  type Unsubscribe,
  type Vec3,
  type WorldSnapshot,
} from '@minebot/contract'
import { classifyEntity, toSnapshot, type MineflayerLike } from './snapshot.js'

export interface MineflayerExecutorOptions {
  host?: string
  port?: number
  username?: string
  version?: string
  connectTimeoutMs?: number
}

export class MineflayerExecutor implements BotExecutor {
  private bot: Bot | null = null
  private readonly host: string
  private readonly port: number
  private readonly username: string
  private readonly version: string
  private readonly connectTimeoutMs: number

  constructor(opts: MineflayerExecutorOptions = {}) {
    this.host = opts.host ?? 'localhost'
    this.port = opts.port ?? 25565
    this.username = opts.username ?? 'MineBot'
    this.version = opts.version ?? '1.21.10'
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 30_000
  }

  async connect(): Promise<Result> {
    if (this.bot) return ok(undefined)

    const bot = mineflayer.createBot({
      host: this.host,
      port: this.port,
      username: this.username,
      auth: 'offline',
      version: this.version,
    })

    return new Promise<Result>((resolve) => {
      let settled = false
      let healthTimer: ReturnType<typeof setTimeout> | undefined

      const finish = (result: Result): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (healthTimer) clearTimeout(healthTimer)
        bot.removeListener('spawn', onSpawn)
        bot.removeListener('error', onError)
        bot.removeListener('kicked', onKicked)
        resolve(result)
      }
      const onSpawn = (): void => {
        this.bot = bot
        // VERIFIED 2026-09-07: bot.health is `undefined` at the 'spawn' event and
        // only populates when the server's first health packet lands, ~100ms later.
        // Resolving on 'spawn' alone would hand callers a snapshot reporting health 0.
        if (bot.health !== undefined) {
          finish(ok(undefined))
          return
        }
        healthTimer = setTimeout(() => finish(ok(undefined)), 5_000)
        bot.once('health', () => finish(ok(undefined)))
      }
      const onError = (e: Error): void => {
        this.bot = null
        finish(fail('disconnected', e.message))
      }
      const onKicked = (reason: unknown): void => {
        this.bot = null
        finish(fail('disconnected', `kicked: ${JSON.stringify(reason)}`))
      }
      const timer = setTimeout(() => {
        this.bot = null
        try {
          bot.quit()
        } catch {
          // nothing to close
        }
        finish(fail('timeout', `no spawn within ${this.connectTimeoutMs}ms`))
      }, this.connectTimeoutMs)

      bot.once('spawn', onSpawn)
      bot.once('error', onError)
      bot.once('kicked', onKicked)
    })
  }

  async disconnect(): Promise<void> {
    const bot = this.bot
    if (!bot) return
    this.bot = null
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000)
      bot.once('end', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        bot.quit()
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  getState(): WorldSnapshot {
    return toSnapshot(this.requireBot() as unknown as MineflayerLike)
  }

  findBlocks(query: BlockQuery): readonly BlockInfo[] {
    const bot = this.requireBot()
    if (query.names.length === 0) return []
    const names = new Set(query.names)
    const origin = bot.entity.position
    const positions = bot.findBlocks({
      matching: (block) => block !== null && names.has(block.name),
      maxDistance: query.maxDistance,
      count: query.limit,
    })
    return Object.freeze(
      positions.slice(0, query.limit).map((p) =>
        Object.freeze({
          name: bot.blockAt(p)?.name ?? 'unknown',
          position: Object.freeze({ x: p.x, y: p.y, z: p.z }),
          distance: Math.hypot(p.x - origin.x, p.y - origin.y, p.z - origin.z),
        }),
      ),
    )
  }

  on<K extends keyof BotEvents>(
    event: K,
    handler: (payload: BotEvents[K]) => void,
  ): Unsubscribe {
    const bot = this.requireBot()
    const emit = handler as (p: unknown) => void

    switch (event) {
      case 'spawned': {
        const h = (): void => emit({})
        bot.on('spawn', h)
        return () => void bot.removeListener('spawn', h)
      }
      case 'health': {
        const h = (): void => emit({ health: bot.health, food: bot.food })
        bot.on('health', h)
        return () => void bot.removeListener('health', h)
      }
      case 'damaged': {
        const h = (entity: { id: number }): void => {
          if (entity.id !== bot.entity.id) return
          emit({ health: bot.health, source: null })
        }
        bot.on('entityHurt', h)
        return () => void bot.removeListener('entityHurt', h)
      }
      case 'entityNearby': {
        const h = (e: { id: number; position: { x: number; y: number; z: number } }): void => {
          const origin = bot.entity.position
          emit({
            entity: {
              id: e.id,
              name:
                (e as { username?: string }).username ??
                (e as { name?: string }).name ??
                'unknown',
              kind: classifyEntity(e as never),
              position: { x: e.position.x, y: e.position.y, z: e.position.z },
              distance: Math.hypot(
                e.position.x - origin.x,
                e.position.y - origin.y,
                e.position.z - origin.z,
              ),
            },
          })
        }
        bot.on('entitySpawn', h)
        return () => void bot.removeListener('entitySpawn', h)
      }
      case 'chat': {
        const h = (username: string, message: string): void => emit({ username, message })
        bot.on('chat', h)
        return () => void bot.removeListener('chat', h)
      }
      case 'death': {
        const h = (): void => emit({})
        bot.on('death', h)
        return () => void bot.removeListener('death', h)
      }
      case 'disconnected': {
        const h = (reason: string): void => emit({ reason })
        bot.on('end', h)
        return () => void bot.removeListener('end', h)
      }
      default:
        return () => {}
    }
  }

  async moveTo(_target: Vec3, _opts?: ActionOptions): Promise<Result> {
    return fail('internal', 'moveTo is implemented in Task 6')
  }

  async followPlayer(_playerName: string, _opts?: ActionOptions): Promise<Result> {
    return fail('internal', 'followPlayer arrives in Phase 5')
  }

  async mineBlock(
    _blockName: string,
    _maxDistance: number,
    _opts?: ActionOptions,
  ): Promise<Result<{ position: Vec3; collected: boolean }>> {
    return fail('internal', 'mineBlock arrives in Phase 2')
  }

  async placeBlock(_blockName: string, _position: Vec3, _opts?: ActionOptions): Promise<Result> {
    return fail('internal', 'placeBlock arrives in Phase 5')
  }

  async attack(_entityId: number, _opts?: ActionOptions): Promise<Result> {
    return fail('internal', 'attack arrives in Phase 5')
  }

  async flee(_opts?: ActionOptions): Promise<Result> {
    return fail('internal', 'flee arrives in Phase 5')
  }

  chat(message: string): void {
    this.bot?.chat(message)
  }

  stop(): void {
    try {
      this.bot?.clearControlStates()
    } catch {
      // safe to call when disconnected
    }
  }

  private requireBot(): Bot {
    if (!this.bot) throw new Error('MineflayerExecutor is not connected')
    return this.bot
  }
}
```

`packages/executor/src/index.ts`:

```ts
export { MineflayerExecutor } from './mineflayer-executor.js'
export type { MineflayerExecutorOptions } from './mineflayer-executor.js'
export { toSnapshot, classifyEntity } from './snapshot.js'
export type { MineflayerLike, RawEntity, RawItem } from './snapshot.js'
```

- [ ] **Step 4: Run the integration tests to verify they pass**

```bash
npm run smoke
npm run test:integration
npm run typecheck
```

Expected: 6 integration tests PASS. The `ITBadPort` case takes a few seconds to fail its connection — that is the test working.

- [ ] **Step 5: Run the unit suite to confirm nothing regressed**

```bash
npm test
```

Expected: all unit tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/executor
git commit -m "feat(executor): implement connect, snapshot, block search and events"
```

---

### Task 6: `moveTo` with cancellation

Phase 1 uses raw movement — look toward the target and walk, with auto-jump on horizontal collision. `mineflayer-pathfinder` is deliberately Phase 2, per the phase plan.

**Files:**
- Modify: `packages/executor/src/mineflayer-executor.ts` (replace the `moveTo` stub)
- Test: `packages/executor/test/integration/move.int.test.ts`

**Interfaces:**
- Consumes: `MineflayerExecutor` from Task 5.
- Produces: a working `moveTo(target: Vec3, opts?: ActionOptions): Promise<Result>` that honours `signal` and `timeoutMs` (default `30_000`), with arrival tolerance 1.5 blocks measured horizontally.

- [ ] **Step 1: Write the failing integration test**

`packages/executor/test/integration/move.int.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run test:integration -- move
```

Expected: FAIL — `moveTo` returns `{ ok: false, reason: 'internal' }`.

- [ ] **Step 3: Replace the `moveTo` stub**

In `packages/executor/src/mineflayer-executor.ts`, replace the `moveTo` stub with:

```ts
  async moveTo(target: Vec3, opts?: ActionOptions): Promise<Result> {
    const bot = this.requireBot()
    if (opts?.signal?.aborted) return fail('interrupted', 'aborted before start')

    const timeoutMs = opts?.timeoutMs ?? 30_000
    const tolerance = 1.5

    return new Promise<Result>((resolve) => {
      let settled = false
      const signal = opts?.signal

      const cleanup = (): void => {
        clearTimeout(timer)
        bot.removeListener('physicsTick', onTick)
        signal?.removeEventListener('abort', onAbort)
        try {
          bot.clearControlStates()
        } catch {
          // disconnected mid-move
        }
      }
      const finish = (result: Result): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }
      function onAbort(): void {
        finish(fail('interrupted', 'aborted mid-move'))
      }
      function onTick(): void {
        const p = bot.entity.position
        const dx = target.x - p.x
        const dz = target.z - p.z
        if (Math.hypot(dx, dz) <= tolerance) {
          finish(ok(undefined))
          return
        }
        // Minecraft yaw: 0 faces -Z, increasing counter-clockwise.
        void bot.look(Math.atan2(-dx, -dz), 0, true)
        bot.setControlState('forward', true)
        bot.setControlState('jump', bot.entity.isCollidedHorizontally === true)
      }
      const timer = setTimeout(
        () => finish(fail('timeout', `did not reach target within ${timeoutMs}ms`)),
        timeoutMs,
      )

      signal?.addEventListener('abort', onAbort, { once: true })
      bot.on('physicsTick', onTick)
    })
  }
```

- [ ] **Step 4: Run the integration tests to verify they pass**

```bash
npm run test:integration -- move
```

Expected: 4 tests PASS. Watch from a second Minecraft client — the bot should visibly walk, then stop dead when aborted.

- [ ] **Step 5: Commit**

```bash
git add packages/executor
git commit -m "feat(executor): add cancellable moveTo over raw movement"
```

---

### Task 7: Contract suite against the real executor, and the Phase 1 demo

This is the task that proves the design: the same suite that validates the mock must pass against Mineflayer.

**Files:**
- Create: `packages/executor/test/integration/contract.int.test.ts`
- Create: `packages/executor/src/cli.ts`
- Modify: `package.json` (add the `demo` script)
- Modify: `packages/executor/package.json` (add `@minebot/mock-executor` as a dev dependency)

**Interfaces:**
- Consumes: `runContractSuite` from Task 2, `MineflayerExecutor` from Tasks 5–6.
- Produces: the Phase 1 deliverable — `npm run demo`.

- [ ] **Step 1: Add the dev dependency**

Add to `packages/executor/package.json`:

```json
  "devDependencies": {
    "@minebot/mock-executor": "0.1.0"
  }
```

Then `npm install`.

- [ ] **Step 2: Write the failing test**

`packages/executor/test/integration/contract.int.test.ts`:

```ts
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
```

- [ ] **Step 3: Run it**

```bash
npm run test:integration -- contract
```

Expected: every contract test PASSES against the real executor. If `returns a frozen snapshot…` fails, `toSnapshot` is not freezing deeply — fix `snapshot.ts`, not the test. If `never returns more blocks than the requested limit` fails, `findBlocks` is not honouring `limit`.

- [ ] **Step 4: Write the demo CLI**

`packages/executor/src/cli.ts`:

```ts
import { MineflayerExecutor } from './index.js'

const main = async (): Promise<void> => {
  const executor = new MineflayerExecutor({ username: 'MineBot' })

  console.log('connecting to localhost:25565 …')
  const connected = await executor.connect()
  if (!connected.ok) {
    console.error(`FAILED: ${connected.reason} — ${connected.detail}`)
    process.exitCode = 1
    return
  }

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
  }

  await executor.disconnect()
  console.log('disconnected.')
}

await main()
```

Add to the root `package.json` `scripts`:

```json
    "demo": "tsx packages/executor/src/cli.ts"
```

- [ ] **Step 5: Run the Phase 1 deliverable**

```bash
npm run demo
```

Expected: connection, a printed snapshot, `arrived at …` roughly 8 blocks east of spawn. **Verification per the phase plan:** join the dev server from a real Minecraft client and watch `MineBot` walk, then confirm the printed position matches where it stands.

- [ ] **Step 6: Run everything**

```bash
npm test && npm run test:integration && npm run typecheck
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add packages/executor package.json package-lock.json
git commit -m "feat(executor): run shared contract suite against Mineflayer, add demo CLI"
```

---

## Phase 1 exit criteria

- [ ] `npm test` passes with no server running.
- [ ] `npm run test:integration` passes against the dev server.
- [ ] The same `runContractSuite` passes against both `MockExecutor` and `MineflayerExecutor`.
- [ ] `npm run demo` connects, prints a snapshot, and walks to a fixed coordinate.
- [ ] The walk is confirmed visually from a second Minecraft client.

## Handover to Track B

Once this lands, Ricky can build the planning loop against `MockExecutor` with no Minecraft server at all:

```ts
import { MockExecutor } from '@minebot/mock-executor'

const executor = new MockExecutor({
  position: { x: 0, y: 64, z: 0 },
  blocks: [{ name: 'coal_ore', position: { x: 0, y: 60, z: 5 }, distance: 5 }],
})
await executor.connect()
```

The four contract changes from the spec that alter what Track B codes against: `attack` takes a numeric `entityId`; `nearbyBlocks` is gone in favour of `findBlocks(query)`; every action takes `ActionOptions` and may resolve `interrupted`; `Result` is a discriminated union with the nine `FailureReason` values.

## Not in this plan

`mineflayer-pathfinder` (Phase 2), mining (Phase 2), the reflex/arbiter layer and blueprint building (Phase 5), and multi-bot orchestration (Phase 6). The `BotExecutor` methods for those return `{ ok: false, reason: 'internal' }` with a message naming the phase that fills them in.
