# Track B — LLM Planning Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `packages/agent/` decides what the bot does next — it observes a `WorldSnapshot`, asks a local LLM for exactly one action, validates the reply, and dispatches it through `BotExecutor`, looping until the goal is met or a guard stops it.

**Architecture:** Eight small modules, six of them pure functions over plain data. The LLM sits behind an `LlmClient` interface with a scripted fake as the only implementation any test uses, so `npm test` never opens a socket. The action menu is defined once as a TypeScript union plus a JSON Schema; `SchemaDecider` uses Ollama's constrained-output `format` field to get it back. Failures are fed to the model as history rather than branched on in code — Phase 4 owns policy.

**Tech Stack:** TypeScript 7, Node 24 (ESM), npm workspaces, Vitest 5. No new runtime dependencies — `fetch` is built in.

**Spec:** [`docs/superpowers/specs/2026-09-07-track-b-planning-loop-design.md`](../specs/2026-09-07-track-b-planning-loop-design.md)

## Global Constraints

- Node `>=24`. All packages are ESM (`"type": "module"`). `verbatimModuleSyntax` is on — use `import type` for type-only imports.
- `erasableSyntaxOnly` is on. **Constructor parameter properties (`constructor(private readonly x: T)`) are banned** — declare the field, then assign it in the constructor body. `MockExecutor` shows the pattern.
- `noUncheckedIndexedAccess` is on. Indexing an array yields `T | undefined`; narrow before use.
- Relative imports carry the `.js` extension (`./actions.js`), per NodeNext resolution.
- Exact version pins in every manifest. No `^` or `~`. Cross-package deps use the exact string `"0.1.0"`.
- **`packages/agent/` must never depend on `mineflayer`, `mineflayer-*`, or `prismarine-*`.** `scripts/check-invariants.mjs` enforces it; run it before every commit that touches a manifest.
- **`packages/contract/` and `packages/mock-executor/` MUST NOT be modified by this plan.** They are the shared surface with Track A. The spec (§9) verified that everything needed already exists. If a task appears to need a change there, **stop and report** — that is a conversation, not a commit.
- Unit tests never touch the network. This package adds no integration tests.
- No package declares `vitest` as a dependency; it comes from the root. Follow that.
- Commit messages explain *why*, not just what.

## Verified repository facts

Checked against the tree on 2026-09-07. These are measurements, not assumptions.

- `scripts/check-invariants.mjs` currently prints `agent package not yet created` and checks 1 of 2 invariants. Creating `packages/agent/package.json` activates the second.
- `vitest.config.ts` needs **no change**: the `unit` project glob is `packages/*/test/**/*.test.ts` and excludes only `packages/*/test/integration/**`.
- `MockExecutor` already provides everything this plan needs: `MockOptions.blocks` seeds `findBlocks`, `setFailure(action, failure | null)` drives any of the nine `FailureReason` values, and `calls` records every invocation with its arguments.
- `MockExecutor.getState()` and `findBlocks()` **throw** when disconnected. The six actions **resolve** `fail('disconnected', …)`. Both implementations agree; the contract documents why.
- `@minebot/contract` exports `ok` and `fail` as runtime values, not just types. Importing them is fine — the package has zero runtime dependencies.
- `packages/executor` is the template for a package manifest: `exports` points at `./src/index.ts` directly, there is no build step, and `devDependencies` lists only `@minebot/mock-executor`.
- Root `package.json` currently defines `test`, `test:integration`, `typecheck`, `smoke`, `demo`. Scripts run through `tsx`.

## File structure

| File | Responsibility |
|---|---|
| `packages/agent/package.json` | **Create.** Manifest. Deps: `@minebot/contract`. DevDeps: `@minebot/mock-executor` |
| `packages/agent/src/actions.ts` | **Create.** `ActionRequest` union, its JSON Schema, the menu text shown to the model |
| `packages/agent/src/llm.ts` | **Create.** `LlmClient`, `ChatMessage`, `ChatRequest`, `ChatReply`. Pure types, no logic |
| `packages/agent/src/fake-llm.ts` | **Create.** `FakeLlmClient` — scripted replies, records requests, fails loudly when exhausted |
| `packages/agent/src/decide.ts` | **Create.** `DecodeError`, `decode()`, `Decider`, `SchemaDecider` |
| `packages/agent/src/step.ts` | **Create.** `Step`, `StepOutcome`, `GoalOutcome` — the shared vocabulary of a run |
| `packages/agent/src/prompt.ts` | **Create.** Snapshot + history → `ChatMessage[]`. Pure |
| `packages/agent/src/dispatch.ts` | **Create.** `ActionRequest` + `BotExecutor` → `StepOutcome`. No LLM |
| `packages/agent/src/loop.ts` | **Create.** `runGoal()` and its termination guards |
| `packages/agent/src/ollama.ts` | **Create.** `OllamaClient`. The only module that opens a socket |
| `packages/agent/src/probe.ts` | **Create.** Live-model check. Not part of `npm test` |
| `packages/agent/src/demo.ts` | **Create.** The deliverable script: fake state in, executed actions out |
| `packages/agent/src/index.ts` | **Create.** Public surface |
| `package.json` | **Modify.** Add `agent:demo` and `agent:probe` scripts |
| `README.md` | **Modify.** Roadmap and package table |
| `CLAUDE.md` | **Modify.** `packages/agent/` now exists; test counts |

---

## Task 1: Package skeleton and the action menu

The menu is the contract between the model and the code, so it lands first — every later task imports from it.

**Files:**
- Create: `packages/agent/package.json`
- Create: `packages/agent/src/actions.ts`
- Test: `packages/agent/test/actions.test.ts`

**Interfaces:**
- Consumes: `Vec3` from `@minebot/contract` (type only).
- Produces: `ActionRequest` union, `ActionName`, `ACTION_NAMES`, `ACTION_SCHEMA`, `ACTION_MENU`, `positionOf(a: {x,y,z}): Vec3`. Tasks 3, 4, 5, 6 all import from here; Task 5 uses `positionOf`.

- [ ] **Step 1: Create the manifest**

`packages/agent/package.json` — mirrors `packages/executor/package.json`, minus the game libraries:

```json
{
  "name": "@minebot/agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": { "types": "./src/index.ts", "default": "./src/index.ts" }
  },
  "dependencies": {
    "@minebot/contract": "0.1.0"
  },
  "devDependencies": {
    "@minebot/mock-executor": "0.1.0"
  }
}
```

- [ ] **Step 2: Link the workspace and confirm the invariant activates**

```bash
npm install
node scripts/check-invariants.mjs
```

Expected: `Structural invariants OK (checked 2 of 2; agent package present)`.

The change from `1 of 2` to `2 of 2` is the point of this step. If it still says `1 of 2`, the manifest is not where the script looks.

- [ ] **Step 3: Write the failing test**

`packages/agent/test/actions.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { ACTION_NAMES, ACTION_SCHEMA, ACTION_MENU } from '../src/actions.js'

describe('action menu', () => {
  it('names exactly the six actions the model may choose', () => {
    expect([...ACTION_NAMES]).toEqual([
      'find_blocks',
      'move_to',
      'mine_nearest_block',
      'mine_block_at',
      'chat',
      'done',
    ])
  })

  // The Phase 5 stubs return fail('internal', '… arrives in Phase 5'). Offering
  // them spends a step on certain failure and teaches the model nothing, so they
  // stay out until Track A lands them (design §4.3).
  it('omits the actions the executor has not implemented', () => {
    for (const absent of ['place_block', 'follow_player', 'attack', 'flee']) {
      expect(ACTION_NAMES as readonly string[]).not.toContain(absent)
      expect(ACTION_MENU).not.toContain(absent)
    }
  })

  it('gives every action a schema branch keyed by its name', () => {
    const branches = ACTION_SCHEMA.oneOf
    expect(branches).toHaveLength(ACTION_NAMES.length)

    const keyed = branches.map((b) => {
      const nameProp = b.properties.action
      expect(nameProp.enum).toHaveLength(1)
      return nameProp.enum[0]
    })
    expect(keyed.sort()).toEqual([...ACTION_NAMES].sort())
  })

  // Nested unions are the shape constrained decoding handles worst, so every
  // branch must be a flat object of scalars and string arrays (design §4.2).
  it('keeps every schema branch flat', () => {
    for (const branch of ACTION_SCHEMA.oneOf) {
      expect(branch.type).toBe('object')
      expect(branch.additionalProperties).toBe(false)
      for (const [prop, shape] of Object.entries(branch.properties)) {
        const kind = (shape as { type?: string; enum?: unknown[] }).type
        const isEnum = Array.isArray((shape as { enum?: unknown[] }).enum)
        expect(
          isEnum || kind === 'string' || kind === 'number' || kind === 'integer' || kind === 'array',
          `${prop} must be a scalar, enum or array — no nested objects`,
        ).toBe(true)
      }
    }
  })

  it('documents every action in the menu text with a JSON example', () => {
    for (const name of ACTION_NAMES) {
      expect(ACTION_MENU).toContain(name)
      expect(ACTION_MENU).toContain(`"action":"${name}"`)
    }
  })
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run --project unit packages/agent`
Expected: FAIL — `Failed to resolve import "../src/actions.js"`.

- [ ] **Step 5: Write `actions.ts`**

```ts
import type { Vec3 } from '@minebot/contract'

/**
 * What the model is allowed to choose. Deliberately NOT a mirror of
 * `BotExecutor` — see design §4:
 *
 * - `find_blocks` exists because `WorldSnapshot` carries no blocks at all
 *   (a 16-chunk radius is ~10^5 of them), so the only way to learn where a
 *   block is, is to ask.
 * - Mining is two actions rather than one `string | Vec3` target, so every
 *   schema branch stays a flat object and the schema has exactly one union.
 *   `dispatch.ts` collapses them back onto the single contract method.
 * - `done` has no executor counterpart. Without it a run could only ever end
 *   by exhausting its step budget.
 */
export type ActionRequest =
  | {
      readonly action: 'find_blocks'
      readonly names: readonly string[]
      readonly maxDistance: number
      readonly limit: number
    }
  | { readonly action: 'move_to'; readonly x: number; readonly y: number; readonly z: number }
  | { readonly action: 'mine_nearest_block'; readonly name: string; readonly maxDistance: number }
  | {
      readonly action: 'mine_block_at'
      readonly x: number
      readonly y: number
      readonly z: number
      readonly maxDistance: number
    }
  | { readonly action: 'chat'; readonly message: string }
  | { readonly action: 'done'; readonly summary: string }

export type ActionName = ActionRequest['action']

export const ACTION_NAMES = [
  'find_blocks',
  'move_to',
  'mine_nearest_block',
  'mine_block_at',
  'chat',
  'done',
] as const satisfies readonly ActionName[]

export const positionOf = (a: {
  readonly x: number
  readonly y: number
  readonly z: number
}): Vec3 => ({ x: a.x, y: a.y, z: a.z })

// A single-valued `enum` rather than `const`: both are legal JSON Schema, but
// `enum` is the form every schema-to-grammar converter supports, and this
// schema's whole job is to be converted into a decoding grammar.
const named = (name: ActionName) => ({ enum: [name] as const })
const coordinate = { type: 'number' } as const

export const ACTION_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        action: named('find_blocks'),
        names: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
        maxDistance: { type: 'number' },
        limit: { type: 'integer' },
      },
      required: ['action', 'names', 'maxDistance', 'limit'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { action: named('move_to'), x: coordinate, y: coordinate, z: coordinate },
      required: ['action', 'x', 'y', 'z'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        action: named('mine_nearest_block'),
        name: { type: 'string' },
        maxDistance: { type: 'number' },
      },
      required: ['action', 'name', 'maxDistance'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        action: named('mine_block_at'),
        x: coordinate,
        y: coordinate,
        z: coordinate,
        maxDistance: { type: 'number' },
      },
      required: ['action', 'x', 'y', 'z', 'maxDistance'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { action: named('chat'), message: { type: 'string' } },
      required: ['action', 'message'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { action: named('done'), summary: { type: 'string' } },
      required: ['action', 'summary'],
      additionalProperties: false,
    },
  ],
} as const

/** The human-readable menu, rendered into the system prompt. */
export const ACTION_MENU = [
  'find_blocks         {"action":"find_blocks","names":["coal_ore","deepslate_coal_ore"],"maxDistance":32,"limit":5}',
  '                    Search for blocks by name, nearest first. This is the ONLY way',
  '                    to learn where blocks are — they are not in the state above.',
  'move_to             {"action":"move_to","x":18,"y":60,"z":-34}',
  '                    Walk to a coordinate.',
  'mine_nearest_block  {"action":"mine_nearest_block","name":"coal_ore","maxDistance":32}',
  '                    Mine the nearest matching block. Use only when you have not searched.',
  'mine_block_at       {"action":"mine_block_at","x":18,"y":60,"z":-34,"maxDistance":32}',
  '                    Mine one exact block. Prefer this after find_blocks.',
  'chat                {"action":"chat","message":"hello"}',
  '                    Say something in game chat.',
  'done                {"action":"done","summary":"mined one coal ore"}',
  '                    The goal is achieved. This ends the run.',
].join('\n')
```

- [ ] **Step 6: Run tests and typecheck**

```bash
npx vitest run --project unit packages/agent
npm run typecheck
```

Expected: 5 passing tests, clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add packages/agent package-lock.json
git commit -m "Add packages/agent skeleton and the action menu

The menu is not a mirror of BotExecutor. find_blocks exists because
WorldSnapshot carries no blocks — a 16-chunk radius is ~10^5 of them, so
asking is the only way to learn a position. Mining is two flat actions
rather than one string|Vec3 target, which leaves the schema with exactly
one union (the top-level discriminator) instead of a nested one: nested
unions are what constrained decoding handles worst.

The Phase 5 stubs stay out of the menu. They return fail('internal') by
design, so offering them spends a step on certain failure.

Creating the manifest also activates check-invariants' second guarantee,
which was reporting 'agent package not yet created' until now."
```

---

## Task 2: The LLM seam and a fake that fails loudly

**Files:**
- Create: `packages/agent/src/llm.ts`
- Create: `packages/agent/src/fake-llm.ts`
- Test: `packages/agent/test/fake-llm.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ChatMessage`, `ChatRequest`, `ChatReply`, `ToolCall`, `LlmClient`, `FakeLlmClient`, `FakeLlmOptions`, `abortError(): Error`, `isAbortError(e: unknown): boolean`. Tasks 3, 6, 7 depend on these; Task 6 uses `isAbortError`.

- [ ] **Step 1: Write `llm.ts`**

No test of its own — it is types plus one three-line helper, and every later task's tests exercise it.

```ts
/** One message in a prompt. */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

/** Present only once a tool-calling Decider exists (design §5). */
export interface ToolCall {
  readonly name: string
  readonly arguments: unknown
}

/**
 * The model's reply. An object rather than a bare string on purpose: a
 * tool-calling reply is not text, and `Promise<string>` would have made that
 * swap a signature change across every implementation instead of an added
 * field.
 */
export interface ChatReply {
  readonly content: string
  readonly toolCalls?: readonly ToolCall[]
}

export interface ChatRequest {
  readonly messages: readonly ChatMessage[]
  /** JSON Schema the reply must satisfy. Ollama's `format` field. */
  readonly schema?: unknown
  readonly signal?: AbortSignal
}

export interface LlmClient {
  chat(req: ChatRequest): Promise<ChatReply>
}

/**
 * The rejection an aborted model call produces. `fetch` rejects with an error
 * whose `.name` is `'AbortError'`; the fake matches it so the loop's
 * cancellation path is exercised by tests rather than only in production.
 * Discriminating on `.name` is the same technique Track A uses for
 * pathfinder errors.
 */
export const abortError = (): Error => {
  const e = new Error('the model call was aborted')
  e.name = 'AbortError'
  return e
}

export const isAbortError = (e: unknown): boolean =>
  e instanceof Error && e.name === 'AbortError'
```

- [ ] **Step 2: Write the failing test**

`packages/agent/test/fake-llm.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { FakeLlmClient } from '../src/fake-llm.js'
import { isAbortError } from '../src/llm.js'

const msg = (content: string) => [{ role: 'user' as const, content }]

describe('FakeLlmClient', () => {
  it('returns queued replies in order', async () => {
    const llm = new FakeLlmClient(['first', 'second'])
    expect((await llm.chat({ messages: msg('a') })).content).toBe('first')
    expect((await llm.chat({ messages: msg('b') })).content).toBe('second')
  })

  it('records every request it received', async () => {
    const llm = new FakeLlmClient(['x'])
    await llm.chat({ messages: msg('the prompt'), schema: { oneOf: [] } })
    expect(llm.requests).toHaveLength(1)
    expect(llm.requests[0]?.schema).toEqual({ oneOf: [] })
    expect(llm.lastPromptText()).toContain('the prompt')
  })

  // CLAUDE.md: "A fixture that can no-op without shouting is worse than no
  // fixture." An exhausted script must not look like an empty reply — that is
  // a legitimate decode case, and returning '' would turn a script that ran
  // out into a passing test.
  it('throws loudly when the script runs out, rather than returning empty', async () => {
    const llm = new FakeLlmClient(['only one'])
    await llm.chat({ messages: msg('a') })
    await expect(llm.chat({ messages: msg('b') })).rejects.toThrow(/script exhausted after 2/)
  })

  it('repeats the last reply forever when asked, for budget and stuck tests', async () => {
    const llm = new FakeLlmClient(['again'], { repeatLast: true })
    for (let i = 0; i < 5; i++) {
      expect((await llm.chat({ messages: msg('a') })).content).toBe('again')
    }
  })

  it('rejects with an AbortError when handed an aborted signal', async () => {
    const llm = new FakeLlmClient(['never reached'])
    const ac = new AbortController()
    ac.abort()
    const err = await llm.chat({ messages: msg('a'), signal: ac.signal }).catch((e) => e)
    expect(isAbortError(err)).toBe(true)
    expect(llm.requests).toHaveLength(1)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run --project unit packages/agent/test/fake-llm.test.ts`
Expected: FAIL — `Failed to resolve import "../src/fake-llm.js"`.

- [ ] **Step 4: Write `fake-llm.ts`**

```ts
import { abortError, type ChatRequest, type ChatReply, type LlmClient } from './llm.js'

export interface FakeLlmOptions {
  /**
   * Keep returning the final queued reply instead of throwing once the script
   * runs out. For the budget-exhaustion and stuck-guard tests, which need an
   * endless supply of the same answer.
   */
  readonly repeatLast?: boolean
}

/**
 * A scripted stand-in for a model. The only `LlmClient` any test uses, which
 * is what keeps `npm test` free of sockets.
 */
export class FakeLlmClient implements LlmClient {
  readonly requests: ChatRequest[] = []

  private readonly queue: string[]
  private readonly repeatLast: boolean
  private last: string | null = null

  constructor(replies: readonly string[], opts: FakeLlmOptions = {}) {
    this.queue = [...replies]
    this.repeatLast = opts.repeatLast ?? false
  }

  async chat(req: ChatRequest): Promise<ChatReply> {
    this.requests.push(req)
    if (req.signal?.aborted) throw abortError()

    const next = this.queue.shift()
    if (next !== undefined) {
      this.last = next
      return { content: next }
    }
    if (this.repeatLast && this.last !== null) return { content: this.last }

    // Loud on purpose — see the test.
    throw new Error(
      `FakeLlmClient: script exhausted after ${this.requests.length} request(s). ` +
        'Queue more replies, or pass { repeatLast: true } if the test needs an endless supply.',
    )
  }

  /** Every message of the most recent request, joined. For prompt assertions. */
  lastPromptText(): string {
    const req = this.requests[this.requests.length - 1]
    return req ? req.messages.map((m) => m.content).join('\n') : ''
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

```bash
npx vitest run --project unit packages/agent
npm run typecheck
```

Expected: all green, 10 tests in the package.

- [ ] **Step 6: Commit**

```bash
git add packages/agent
git commit -m "Add the LlmClient seam and a fake that fails loudly

No model endpoint is reachable from this machine, so the transport goes
behind an interface from the first commit and every test uses the fake.
That buys a property worth keeping permanently: npm test opens no sockets.

ChatReply is an object rather than a string because a tool-calling reply
is not text — if Phase 3's measurements favour native tool-calling, that
becomes an added field rather than a signature change everywhere.

The fake throws when its script runs out instead of returning ''. An empty
reply is a legitimate decode case, so a quiet fake would turn an exhausted
script into a green test — the same failure mode CLAUDE.md records for the
arena fixture that silently no-opped."
```

---

## Task 3: Decode and validate the model's reply

**Files:**
- Create: `packages/agent/src/decide.ts`
- Test: `packages/agent/test/decide.test.ts`

**Interfaces:**
- Consumes: `ACTION_NAMES`, `ACTION_SCHEMA`, `ActionRequest`, `ActionName` (Task 1); `LlmClient`, `ChatMessage` (Task 2).
- Produces: `DecodeError`, `DecodeResult`, `decode(raw: string): DecodeResult`, `Decider`, `DecideResult`, `SchemaDecider`. Task 6 depends on `Decider`, `DecideResult` and `DecodeError`; Task 4 depends on `DecodeError`.

- [ ] **Step 1: Write the failing tests**

`packages/agent/test/decide.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { decode, SchemaDecider } from '../src/decide.js'
import { FakeLlmClient } from '../src/fake-llm.js'
import { ACTION_SCHEMA } from '../src/actions.js'

const expectOk = (raw: string) => {
  const r = decode(raw)
  if (!r.ok) throw new Error(`expected ok, got ${r.error.kind}: ${r.error.detail}`)
  return r.action
}
const expectBad = (raw: string) => {
  const r = decode(raw)
  if (r.ok) throw new Error(`expected failure, got ${JSON.stringify(r.action)}`)
  return r.error
}

describe('decode — accepted replies', () => {
  it('reads a find_blocks action', () => {
    expect(
      expectOk('{"action":"find_blocks","names":["coal_ore"],"maxDistance":32,"limit":5}'),
    ).toEqual({ action: 'find_blocks', names: ['coal_ore'], maxDistance: 32, limit: 5 })
  })

  it('reads each of the other five actions', () => {
    expect(expectOk('{"action":"move_to","x":1,"y":64,"z":-3}')).toEqual({
      action: 'move_to', x: 1, y: 64, z: -3,
    })
    expect(
      expectOk('{"action":"mine_nearest_block","name":"coal_ore","maxDistance":16}'),
    ).toEqual({ action: 'mine_nearest_block', name: 'coal_ore', maxDistance: 16 })
    expect(
      expectOk('{"action":"mine_block_at","x":18,"y":60,"z":-34,"maxDistance":32}'),
    ).toEqual({ action: 'mine_block_at', x: 18, y: 60, z: -34, maxDistance: 32 })
    expect(expectOk('{"action":"chat","message":"hi"}')).toEqual({
      action: 'chat', message: 'hi',
    })
    expect(expectOk('{"action":"done","summary":"got the coal"}')).toEqual({
      action: 'done', summary: 'got the coal',
    })
  })

  // Constrained decoding should prevent this, but a model that ignores the
  // constraint must not take the run down with it.
  it('digs the object out of surrounding prose', () => {
    expect(
      expectOk('Sure! Here you go:\n{"action":"done","summary":"ok"}\nHope that helps.'),
    ).toEqual({ action: 'done', summary: 'ok' })
  })

  // Mineflayer block names are bare; a model trained on Minecraft data emits
  // the namespaced form constantly. Normalising costs two lines; rejecting
  // costs a turn (design §6).
  it('strips a minecraft: namespace and lowercases', () => {
    expect(
      expectOk('{"action":"mine_nearest_block","name":"Minecraft:Coal_Ore","maxDistance":8}'),
    ).toEqual({ action: 'mine_nearest_block', name: 'coal_ore', maxDistance: 8 })
  })

  it('floors fractional coordinates rather than rejecting them', () => {
    expect(expectOk('{"action":"move_to","x":1.7,"y":64.2,"z":-3.9}')).toEqual({
      action: 'move_to', x: 1, y: 64, z: -4,
    })
  })
})

describe('decode — rejected replies', () => {
  it('reports an empty reply distinctly', () => {
    expect(expectBad('   ').kind).toBe('empty_reply')
  })

  it('reports unparseable text', () => {
    expect(expectBad('I think I should mine some coal.').kind).toBe('not_json')
  })

  it('reports a non-object', () => {
    expect(expectBad('[1, 2, 3]').kind).toBe('not_an_object')
  })

  it('reports an action name outside the menu', () => {
    const e = expectBad('{"action":"craft","item":"torch"}')
    expect(e.kind).toBe('unknown_action')
    expect(e.detail).toContain('find_blocks')
  })

  it('rejects the Phase 5 stubs by name', () => {
    expect(expectBad('{"action":"attack","entityId":7}').kind).toBe('unknown_action')
  })

  it.each([
    ['missing field', '{"action":"move_to","x":1,"y":64}'],
    ['wrong type', '{"action":"chat","message":42}'],
    ['empty message', '{"action":"chat","message":"   "}'],
    ['over-long message', `{"action":"chat","message":"${'x'.repeat(300)}"}`],
    ['zero distance', '{"action":"mine_nearest_block","name":"coal_ore","maxDistance":0}'],
    ['negative distance', '{"action":"find_blocks","names":["coal_ore"],"maxDistance":-5,"limit":3}'],
    ['distance past the cap', '{"action":"find_blocks","names":["coal_ore"],"maxDistance":999,"limit":3}'],
    ['limit past the cap', '{"action":"find_blocks","names":["coal_ore"],"maxDistance":32,"limit":900}'],
    ['empty names', '{"action":"find_blocks","names":[],"maxDistance":32,"limit":3}'],
    ['punctuated block name', '{"action":"mine_nearest_block","name":"coal ore!","maxDistance":8}'],
    ['y below the world', '{"action":"move_to","x":0,"y":-500,"z":0}'],
    ['non-finite coordinate', '{"action":"move_to","x":0,"y":null,"z":0}'],
    ['empty summary', '{"action":"done","summary":""}'],
  ])('rejects %s', (_label, raw) => {
    expect(expectBad(raw).kind).toBe('bad_arguments')
  })

  it('says specifically what was wrong, so the repair prompt can quote it', () => {
    expect(expectBad('{"action":"find_blocks","names":["coal_ore"],"maxDistance":999,"limit":3}').detail)
      .toContain('maxDistance')
  })
})

describe('SchemaDecider', () => {
  const messages = [{ role: 'user' as const, content: 'go' }]

  it('constrains the request with the action schema', async () => {
    const llm = new FakeLlmClient(['{"action":"done","summary":"ok"}'])
    await new SchemaDecider(llm).decide(messages)
    expect(llm.requests[0]?.schema).toBe(ACTION_SCHEMA)
  })

  it('returns the decoded action and the raw reply', async () => {
    const llm = new FakeLlmClient(['{"action":"done","summary":"ok"}'])
    const r = await new SchemaDecider(llm).decide(messages)
    expect(r.ok && r.action).toEqual({ action: 'done', summary: 'ok' })
    expect(r.raw).toContain('summary')
  })

  it('repairs once, quoting what was wrong', async () => {
    const llm = new FakeLlmClient(['not json at all', '{"action":"done","summary":"second try"}'])
    const r = await new SchemaDecider(llm).decide(messages)
    expect(r.ok && r.action).toEqual({ action: 'done', summary: 'second try' })
    expect(llm.requests).toHaveLength(2)
    expect(llm.lastPromptText()).toContain('not_json')
  })

  // Design §3/§6.2: the repair message is scoped to the retry. Nothing about
  // it may survive into the next turn, because the loop rebuilds the prompt
  // from a fresh snapshot each time.
  it('does not repair more than once', async () => {
    const llm = new FakeLlmClient(['nope', 'still nope'])
    const r = await new SchemaDecider(llm).decide(messages)
    expect(r.ok).toBe(false)
    expect(llm.requests).toHaveLength(2)
  })

  it('passes the abort signal through to the model call', async () => {
    const llm = new FakeLlmClient(['unused'])
    const ac = new AbortController()
    ac.abort()
    await expect(new SchemaDecider(llm).decide(messages, ac.signal)).rejects.toThrow()
    expect(llm.requests[0]?.signal).toBe(ac.signal)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project unit packages/agent/test/decide.test.ts`
Expected: FAIL — `Failed to resolve import "../src/decide.js"`.

- [ ] **Step 3: Write `decide.ts`**

```ts
import { ACTION_NAMES, ACTION_SCHEMA, type ActionName, type ActionRequest } from './actions.js'
import type { ChatMessage, LlmClient } from './llm.js'

/**
 * Why this is not a `FailureReason`: that union is a closed vocabulary about
 * things going wrong in the game world. `invalid_target` means "no such block
 * name", not "the model returned broken JSON". Reusing it would make the two
 * indistinguishable downstream and would quietly widen what the shared
 * contract means (design §6.1).
 */
export interface DecodeError {
  readonly kind: 'empty_reply' | 'not_json' | 'not_an_object' | 'unknown_action' | 'bad_arguments'
  readonly detail: string
}

export type DecodeResult =
  | { readonly ok: true; readonly action: ActionRequest }
  | { readonly ok: false; readonly error: DecodeError }

const MAX_DISTANCE = 128
const MAX_LIMIT = 16
const MAX_CHAT = 256
const MAX_SUMMARY = 512
const Y_MIN = -64
const Y_MAX = 320
const XZ_MAX = 30_000_000
const BARE_NAME = /^[a-z0-9_]+$/

const bad = (kind: DecodeError['kind'], detail: string): DecodeResult => ({
  ok: false,
  error: { kind, detail },
})

const clip = (s: string, n = 120): string =>
  s.length <= n ? s : `${s.slice(0, n)}… (${s.length} chars)`

/** Bare, lowercase, no namespace — the form Mineflayer and `BlockQuery` use. */
const blockName = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const n = v.trim().toLowerCase().replace(/^minecraft:/, '')
  return BARE_NAME.test(n) ? n : null
}

const distance = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_DISTANCE ? v : null

const coord = (v: unknown, lo: number, hi: number): number | null => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const n = Math.floor(v)
  return n >= lo && n <= hi ? n : null
}

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 && t.length <= max ? t : null
}

/** Direct parse, then a first-brace-to-last-brace rescue for prose-wrapped JSON. */
const parseLoose = (raw: string): unknown | undefined => {
  try {
    return JSON.parse(raw)
  } catch {
    // fall through to the rescue
  }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return undefined
  }
}

export function decode(raw: string): DecodeResult {
  if (raw.trim().length === 0) return bad('empty_reply', 'the model returned nothing')

  const parsed = parseLoose(raw)
  if (parsed === undefined) return bad('not_json', `could not parse JSON from: ${clip(raw)}`)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const got = Array.isArray(parsed) ? 'an array' : typeof parsed
    return bad('not_an_object', `expected a JSON object, got ${got}`)
  }

  const o = parsed as Record<string, unknown>
  const name = o['action']
  if (typeof name !== 'string' || !(ACTION_NAMES as readonly string[]).includes(name)) {
    return bad('unknown_action', `"${String(name)}" is not one of: ${ACTION_NAMES.join(', ')}`)
  }

  switch (name as ActionName) {
    case 'find_blocks': {
      const rawNames = o['names']
      if (!Array.isArray(rawNames) || rawNames.length === 0) {
        return bad('bad_arguments', 'find_blocks needs a non-empty "names" array')
      }
      const names: string[] = []
      for (const candidate of rawNames) {
        const clean = blockName(candidate)
        if (clean === null) {
          return bad('bad_arguments', `"${String(candidate)}" is not a valid block name`)
        }
        names.push(clean)
      }
      const maxDistance = distance(o['maxDistance'])
      if (maxDistance === null) {
        return bad('bad_arguments', `maxDistance must be a number in (0, ${MAX_DISTANCE}]`)
      }
      const limit = o['limit']
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        return bad('bad_arguments', `limit must be an integer in [1, ${MAX_LIMIT}]`)
      }
      return { ok: true, action: { action: 'find_blocks', names, maxDistance, limit } }
    }

    case 'move_to': {
      const x = coord(o['x'], -XZ_MAX, XZ_MAX)
      const y = coord(o['y'], Y_MIN, Y_MAX)
      const z = coord(o['z'], -XZ_MAX, XZ_MAX)
      if (x === null || y === null || z === null) {
        return bad(
          'bad_arguments',
          `move_to needs finite x/z within ±${XZ_MAX} and y in [${Y_MIN}, ${Y_MAX}]`,
        )
      }
      return { ok: true, action: { action: 'move_to', x, y, z } }
    }

    case 'mine_nearest_block': {
      const blockTarget = blockName(o['name'])
      if (blockTarget === null) {
        return bad('bad_arguments', `"${String(o['name'])}" is not a valid block name`)
      }
      const maxDistance = distance(o['maxDistance'])
      if (maxDistance === null) {
        return bad('bad_arguments', `maxDistance must be a number in (0, ${MAX_DISTANCE}]`)
      }
      return { ok: true, action: { action: 'mine_nearest_block', name: blockTarget, maxDistance } }
    }

    case 'mine_block_at': {
      const x = coord(o['x'], -XZ_MAX, XZ_MAX)
      const y = coord(o['y'], Y_MIN, Y_MAX)
      const z = coord(o['z'], -XZ_MAX, XZ_MAX)
      if (x === null || y === null || z === null) {
        return bad(
          'bad_arguments',
          `mine_block_at needs finite x/z within ±${XZ_MAX} and y in [${Y_MIN}, ${Y_MAX}]`,
        )
      }
      const maxDistance = distance(o['maxDistance'])
      if (maxDistance === null) {
        return bad('bad_arguments', `maxDistance must be a number in (0, ${MAX_DISTANCE}]`)
      }
      return { ok: true, action: { action: 'mine_block_at', x, y, z, maxDistance } }
    }

    case 'chat': {
      const message = text(o['message'], MAX_CHAT)
      if (message === null) {
        return bad('bad_arguments', `message must be non-empty and at most ${MAX_CHAT} characters`)
      }
      return { ok: true, action: { action: 'chat', message } }
    }

    case 'done': {
      const summary = text(o['summary'], MAX_SUMMARY)
      if (summary === null) return bad('bad_arguments', 'summary must be a non-empty string')
      return { ok: true, action: { action: 'done', summary } }
    }
  }
}

// ---------- The mechanism seam ----------

export type DecideResult =
  | { readonly ok: true; readonly action: ActionRequest; readonly raw: string }
  | { readonly ok: false; readonly error: DecodeError; readonly raw: string }

/**
 * How one action is obtained from the model. `SchemaDecider` is the only
 * implementation today; a `ToolCallDecider` reading `ChatReply.toolCalls`
 * would reuse `decode`, `actions.ts` and `prompt.ts` unchanged, which is what
 * lets Phase 3 choose between the two mechanisms on measurements rather than
 * on a guess made before any model was reachable (design §5).
 */
export interface Decider {
  decide(messages: readonly ChatMessage[], signal?: AbortSignal): Promise<DecideResult>
}

export class SchemaDecider implements Decider {
  private readonly llm: LlmClient

  constructor(llm: LlmClient) {
    this.llm = llm
  }

  async decide(messages: readonly ChatMessage[], signal?: AbortSignal): Promise<DecideResult> {
    const first = await this.llm.chat({ messages, schema: ACTION_SCHEMA, signal })
    const decoded = decode(first.content)
    if (decoded.ok) return { ok: true, action: decoded.action, raw: first.content }

    // Exactly one repair. The two extra messages are scoped to this retry and
    // discarded with it — the next turn rebuilds the prompt from a fresh
    // snapshot, so no transcript accumulates (design §3, §6.2).
    const repaired = await this.llm.chat({
      messages: [
        ...messages,
        { role: 'assistant', content: first.content },
        {
          role: 'user',
          content:
            `That reply was rejected (${decoded.error.kind}): ${decoded.error.detail}\n` +
            'Reply with one valid action object and nothing else.',
        },
      ],
      schema: ACTION_SCHEMA,
      signal,
    })
    const second = decode(repaired.content)
    return second.ok
      ? { ok: true, action: second.action, raw: repaired.content }
      : { ok: false, error: second.error, raw: repaired.content }
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

```bash
npx vitest run --project unit packages/agent
npm run typecheck
```

Expected: all green. The `it.each` table contributes 13 cases on its own.

- [ ] **Step 5: Commit**

```bash
git add packages/agent
git commit -m "Add decode and the SchemaDecider seam

Decode failures get an agent-local error type rather than a FailureReason.
That union is a closed vocabulary about the game world — invalid_target
means 'no such block name', not 'broken JSON' — so reusing it would make
the two indistinguishable downstream and would widen the shared contract's
meaning without agreement.

Two normalisations are deliberate rather than lax. A minecraft: prefix is
stripped, because Mineflayer's names are bare and a model trained on
Minecraft data emits the namespaced form constantly; rejecting it spends a
turn teaching what two lines settle. Fractional coordinates are floored,
because the contract's Vec3 is integer block coordinates.

One repair attempt per decision, and its two extra messages are discarded
with the retry. Nothing may survive into the next turn: the loop rebuilds
the prompt from a fresh snapshot precisely so a stale position cannot leak
back in after an interruption."
```

---

## Task 4: The run vocabulary and prompt rendering

**Files:**
- Create: `packages/agent/src/step.ts`
- Create: `packages/agent/src/prompt.ts`
- Test: `packages/agent/test/prompt.test.ts`

**Interfaces:**
- Consumes: `ActionRequest` (Task 1); `DecodeError` (Task 3); `WorldSnapshot`, `BlockInfo`, `Result`, `Vec3` from `@minebot/contract`.
- Produces: `Step`, `StepOutcome`, `GoalOutcome`, `GoalStatus` from `step.ts`; `HISTORY_WINDOW`, `renderAction`, `renderOutcome`, `renderStep`, `renderSnapshot`, `renderPrompt` from `prompt.ts`. Tasks 5 and 6 depend on `StepOutcome`; Task 6 depends on all of it.

**Note on `llm_error`:** the spec's §7.2 table lists six goal statuses and does not cover the model itself being unreachable — a real case once `OllamaClient` exists, and one that must not violate the spec's own "failure is a returned value, never a thrown error" rule. A seventh status, `llm_error`, is added here. Update the spec's §7.2 table in the same commit so the two do not drift.

- [ ] **Step 1: Write `step.ts`**

Types only; `prompt.test.ts` exercises them.

```ts
import type { BlockInfo, Result } from '@minebot/contract'
import type { ActionRequest } from './actions.js'
import type { DecodeError } from './decide.js'

/**
 * `find_blocks` is the one menu entry whose outcome is not a `Result` —
 * `findBlocks` returns an array and throws when disconnected, because it has
 * no `Result` to report failure through and a silent `[]` would be
 * indistinguishable from "searched, found nothing" (contract, design §7.3).
 */
export type StepOutcome =
  | { readonly kind: 'blocks'; readonly blocks: readonly BlockInfo[] }
  | { readonly kind: 'result'; readonly result: Result<unknown> }
  | { readonly kind: 'undecodable' }
  | { readonly kind: 'done' }

export interface Step {
  readonly n: number
  readonly raw: string
  readonly action: ActionRequest | null
  readonly decodeError: DecodeError | null
  readonly outcome: StepOutcome
}

export type GoalStatus =
  | 'done'
  | 'budget_exhausted'
  | 'stuck'
  | 'undecodable'
  | 'interrupted'
  | 'disconnected'
  | 'llm_error'

/**
 * Failure is a returned value, never a thrown error — the same reasoning the
 * contract gives for `Result`, one layer up. Every outcome carries the full
 * step log, which is the debugging artifact and the raw material Phase 4's
 * retry policy gets written against.
 */
export type GoalOutcome =
  | { readonly status: 'done'; readonly summary: string; readonly steps: readonly Step[] }
  | {
      readonly status: Exclude<GoalStatus, 'done'>
      readonly detail: string
      readonly steps: readonly Step[]
    }
```

- [ ] **Step 2: Write the failing tests**

`packages/agent/test/prompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { WorldSnapshot } from '@minebot/contract'
import { ok, fail } from '@minebot/contract'
import { renderAction, renderOutcome, renderStep, renderPrompt, HISTORY_WINDOW } from '../src/prompt.js'
import type { Step } from '../src/step.js'

const snapshot: WorldSnapshot = {
  takenAt: 1_700_000_000_000,
  self: {
    position: { x: 12, y: 64, z: -30 },
    health: 20,
    food: 18,
    dimension: 'overworld',
    onGround: true,
    inventory: [{ name: 'stone_pickaxe', count: 1, slot: 0 }],
    heldItem: { name: 'stone_pickaxe', count: 1, slot: 0 },
  },
  nearbyEntities: [
    { id: 7, name: 'zombie', kind: 'hostile', position: { x: 14, y: 64, z: -28 }, distance: 2.83 },
  ],
}

const step = (n: number, over: Partial<Step> = {}): Step => ({
  n,
  raw: '{}',
  action: { action: 'done', summary: 'x' },
  decodeError: null,
  outcome: { kind: 'done' },
  ...over,
})

describe('renderAction', () => {
  it('renders every action compactly', () => {
    expect(renderAction({ action: 'find_blocks', names: ['coal_ore'], maxDistance: 32, limit: 5 }))
      .toBe('find_blocks(coal_ore within 32)')
    expect(renderAction({ action: 'move_to', x: 1, y: 64, z: -3 })).toBe('move_to(1, 64, -3)')
    expect(renderAction({ action: 'mine_nearest_block', name: 'coal_ore', maxDistance: 8 }))
      .toBe('mine_nearest_block(coal_ore within 8)')
    expect(renderAction({ action: 'mine_block_at', x: 18, y: 60, z: -34, maxDistance: 32 }))
      .toBe('mine_block_at(18, 60, -34)')
    expect(renderAction({ action: 'chat', message: 'hi' })).toBe('chat("hi")')
    expect(renderAction({ action: 'done', summary: 'got it' })).toBe('done("got it")')
  })
})

describe('renderOutcome', () => {
  it('lists found blocks with positions and distances', () => {
    const out = renderOutcome({
      kind: 'blocks',
      blocks: [{ name: 'coal_ore', position: { x: 18, y: 60, z: -34 }, distance: 7.94 }],
    })
    expect(out).toBe('1 found: coal_ore at (18, 60, -34), 7.9 away')
  })

  it('says so plainly when a search found nothing', () => {
    expect(renderOutcome({ kind: 'blocks', blocks: [] })).toBe('none found')
  })

  it('names the failure reason and its detail', () => {
    expect(renderOutcome({ kind: 'result', result: fail('missing_tool', 'no pickaxe') }))
      .toBe('FAILED (missing_tool): no pickaxe')
  })

  // Mining can succeed while the drop is lost. The contract makes that an ok
  // result carrying collected:false precisely so the success is not thrown
  // away — the model has to see the distinction to decide what comes next.
  it('surfaces collected:false on an otherwise successful mine', () => {
    expect(renderOutcome({ kind: 'result', result: ok({ position: { x: 1, y: 2, z: 3 }, collected: false }) }))
      .toBe('OK (drop collected: false)')
  })

  it('renders a bare success', () => {
    expect(renderOutcome({ kind: 'result', result: ok(undefined) })).toBe('OK')
  })
})

describe('renderPrompt', () => {
  it('states the goal and the current state', () => {
    const text = renderPrompt('get me some coal', snapshot, []).map((m) => m.content).join('\n')
    expect(text).toContain('get me some coal')
    expect(text).toContain('(12, 64, -30)')
    expect(text).toContain('20/20')
    expect(text).toContain('18/20')
    expect(text).toContain('stone_pickaxe x1')
    expect(text).toContain('zombie')
  })

  it('offers the action menu in the system message', () => {
    const [system] = renderPrompt('goal', snapshot, [])
    expect(system?.role).toBe('system')
    expect(system?.content).toContain('find_blocks')
    expect(system?.content).toContain('mine_block_at')
  })

  it('says so explicitly when there is no history yet', () => {
    const text = renderPrompt('goal', snapshot, []).map((m) => m.content).join('\n')
    expect(text).toContain('(none yet)')
  })

  it('numbers history entries and shows their outcomes', () => {
    const steps = [
      step(1, {
        action: { action: 'find_blocks', names: ['coal_ore'], maxDistance: 32, limit: 5 },
        outcome: {
          kind: 'blocks',
          blocks: [{ name: 'coal_ore', position: { x: 18, y: 60, z: -34 }, distance: 7.94 }],
        },
      }),
      step(2, {
        action: { action: 'mine_block_at', x: 18, y: 60, z: -34, maxDistance: 32 },
        outcome: { kind: 'result', result: fail('missing_tool', 'no pickaxe in inventory') },
      }),
    ]
    const text = renderPrompt('goal', snapshot, steps).map((m) => m.content).join('\n')
    expect(text).toContain('1. find_blocks(coal_ore within 32) -> 1 found')
    expect(text).toContain('2. mine_block_at(18, 60, -34) -> FAILED (missing_tool): no pickaxe in inventory')
  })

  it('shows an undecodable step so the model sees its own mistake', () => {
    const text = renderPrompt('goal', snapshot, [
      step(1, {
        action: null,
        decodeError: { kind: 'not_json', detail: 'could not parse JSON from: hmm' },
        outcome: { kind: 'undecodable' },
      }),
    ]).map((m) => m.content).join('\n')
    expect(text).toContain('invalid reply')
    expect(text).toContain('not_json')
  })

  // Prompt size must stay flat however long a goal runs (design §7.1).
  it('renders at most HISTORY_WINDOW entries even when handed more', () => {
    const many = Array.from({ length: HISTORY_WINDOW + 5 }, (_, i) => step(i + 1))
    const text = renderPrompt('goal', snapshot, many).map((m) => m.content).join('\n')
    expect(text).not.toContain(`\n  1. `)
    expect(text).toContain(`${HISTORY_WINDOW + 5}. `)
    const rendered = text.split('\n').filter((l) => /^ {2}\d+\. /.test(l))
    expect(rendered).toHaveLength(HISTORY_WINDOW)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run --project unit packages/agent/test/prompt.test.ts`
Expected: FAIL — `Failed to resolve import "../src/prompt.js"`.

- [ ] **Step 4: Write `prompt.ts`**

```ts
import type { EntityInfo, ItemStack, Vec3, WorldSnapshot } from '@minebot/contract'
import { ACTION_MENU, type ActionRequest } from './actions.js'
import type { ChatMessage } from './llm.js'
import type { Step, StepOutcome } from './step.js'

/**
 * How many past steps reach the prompt. The full log is kept for the outcome;
 * only this tail is rendered, so prompt size stays flat however long a goal
 * runs (design §7.1).
 */
export const HISTORY_WINDOW = 8

const vec = (v: Vec3): string => `(${v.x}, ${v.y}, ${v.z})`
const dist = (d: number): string => d.toFixed(1)

export const renderAction = (a: ActionRequest): string => {
  switch (a.action) {
    case 'find_blocks':
      return `find_blocks(${a.names.join(', ')} within ${a.maxDistance})`
    case 'move_to':
      return `move_to${vec(a)}`
    case 'mine_nearest_block':
      return `mine_nearest_block(${a.name} within ${a.maxDistance})`
    case 'mine_block_at':
      return `mine_block_at${vec(a)}`
    case 'chat':
      return `chat(${JSON.stringify(a.message)})`
    case 'done':
      return `done(${JSON.stringify(a.summary)})`
  }
}

/**
 * `mineBlock` resolves ok with `collected: false` when the block was mined but
 * its drop could not be retrieved. That is a success the contract deliberately
 * refuses to report as a failure, so the model has to see the distinction.
 */
const describeValue = (v: unknown): string => {
  if (v !== null && typeof v === 'object' && 'collected' in v) {
    return ` (drop collected: ${String((v as { collected: unknown }).collected)})`
  }
  return ''
}

export const renderOutcome = (o: StepOutcome): string => {
  switch (o.kind) {
    case 'blocks':
      if (o.blocks.length === 0) return 'none found'
      return `${o.blocks.length} found: ${o.blocks
        .map((b) => `${b.name} at ${vec(b.position)}, ${dist(b.distance)} away`)
        .join('; ')}`
    case 'result':
      return o.result.ok
        ? `OK${describeValue(o.result.value)}`
        : `FAILED (${o.result.reason}): ${o.result.detail || 'no detail given'}`
    case 'undecodable':
      return 'your reply could not be used'
    case 'done':
      return 'goal declared complete'
  }
}

export const renderStep = (s: Step): string => {
  const what = s.action ? renderAction(s.action) : 'invalid reply'
  const why = s.decodeError ? ` [${s.decodeError.kind}: ${s.decodeError.detail}]` : ''
  return `  ${s.n}. ${what} -> ${renderOutcome(s.outcome)}${why}`
}

const renderItem = (i: ItemStack): string => `${i.name} x${i.count}`

const renderEntity = (e: EntityInfo): string =>
  `${e.name} (${e.kind}) at ${vec(e.position)}, ${dist(e.distance)} away`

export const renderSnapshot = (s: WorldSnapshot): string => {
  const { self } = s
  return [
    `Position: ${vec(self.position)}   Dimension: ${self.dimension}   On ground: ${self.onGround ? 'yes' : 'no'}`,
    `Health: ${self.health}/20   Food: ${self.food}/20`,
    `Inventory: ${self.inventory.length === 0 ? '(empty)' : self.inventory.map(renderItem).join(', ')}`,
    `Holding: ${self.heldItem ? renderItem(self.heldItem) : '(nothing)'}`,
    `Nearby entities: ${
      s.nearbyEntities.length === 0 ? 'none' : s.nearbyEntities.map(renderEntity).join('; ')
    }`,
  ].join('\n')
}

const SYSTEM = [
  'You control a Minecraft bot. Each turn you are shown the bot\'s current state and',
  'what happened recently. Choose exactly ONE action and reply with a single JSON',
  'object and nothing else.',
  '',
  'Rules:',
  '- Blocks are NOT listed in the state. find_blocks is the only way to locate one.',
  '- After find_blocks, mine the exact block you found with mine_block_at.',
  '- If an action failed, read the reason before choosing again. Repeating an action',
  '  that just failed the same way will not help.',
  '- Choose done as soon as the goal is met.',
  '',
  'Actions:',
  ACTION_MENU,
].join('\n')

/**
 * Built fresh every turn rather than appended to a transcript. Token cost stays
 * flat, and — more importantly — a transcript would carry stale world state the
 * model can anchor on. After the reflex layer has fled a mob, the bot's old
 * position is a lie (design §3, §8).
 */
export const renderPrompt = (
  goal: string,
  snapshot: WorldSnapshot,
  steps: readonly Step[],
): ChatMessage[] => {
  const window = steps.slice(-HISTORY_WINDOW)
  const history =
    window.length === 0
      ? 'Recent actions: (none yet)'
      : ['Recent actions:', ...window.map(renderStep)].join('\n')

  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [`Goal: ${goal}`, '', renderSnapshot(snapshot), '', history].join('\n'),
    },
  ]
}
```

- [ ] **Step 5: Update the spec's status table**

In `docs/superpowers/specs/2026-09-07-track-b-planning-loop-design.md` §7.2, add `llm_error` to the `GoalOutcome` union's second branch and to the status table, with the cause: *"The model could not be reached or returned an error. Keeps the never-throws property true for an unreachable endpoint."*

- [ ] **Step 6: Run tests and typecheck**

```bash
npx vitest run --project unit packages/agent
npm run typecheck
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add packages/agent docs/superpowers/specs/2026-09-07-track-b-planning-loop-design.md
git commit -m "Add the run vocabulary and prompt rendering

The prompt is rebuilt from scratch each turn rather than appended to a
transcript. Flat token cost is the smaller reason; the real one is that a
transcript carries stale world state the model can anchor on, and after an
interruption the bot's old position is a lie. Design spec §3.3 chose
immutable snapshots so a prompt could never be serialized from a state that
never existed — rebuilding preserves that at the prompt layer.

renderOutcome surfaces collected:false on an otherwise successful mine.
The contract deliberately reports that as ok rather than a failure, so the
model has to see the distinction or it cannot tell 'mined and got it' from
'mined and lost it'.

Also adds a seventh goal status, llm_error, and updates spec §7.2 to match.
The table listed six and none covered an unreachable model — which would
have forced a throw and broken the spec's own 'failure is a returned value'
rule the first time Ollama was down."
```

---

## Task 5: Dispatch an action to the executor

**Files:**
- Create: `packages/agent/src/dispatch.ts`
- Test: `packages/agent/test/dispatch.test.ts`

**Interfaces:**
- Consumes: `ActionRequest`, `positionOf` (Task 1); `StepOutcome` (Task 4); `BotExecutor`, `ok` from `@minebot/contract`.
- Produces: `dispatch(action, executor, signal): Promise<StepOutcome>`. Task 6 depends on it.

- [ ] **Step 1: Write the failing tests**

`packages/agent/test/dispatch.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { MockExecutor } from '@minebot/mock-executor'
import { dispatch } from '../src/dispatch.js'

const coal = { name: 'coal_ore', position: { x: 18, y: 60, z: -34 }, distance: 7.94 }
const live = () => new AbortController().signal

const connected = async () => {
  const m = new MockExecutor({ blocks: [coal] })
  await m.connect()
  return m
}

describe('dispatch', () => {
  it('turns find_blocks into a findBlocks query', async () => {
    const m = await connected()
    const out = await dispatch(
      { action: 'find_blocks', names: ['coal_ore'], maxDistance: 32, limit: 5 },
      m,
      live(),
    )
    expect(out).toEqual({ kind: 'blocks', blocks: [coal] })
  })

  it('turns move_to into moveTo with a Vec3', async () => {
    const m = await connected()
    await dispatch({ action: 'move_to', x: 1, y: 64, z: -3 }, m, live())
    expect(m.calls.at(-1)).toEqual({ name: 'moveTo', args: [{ x: 1, y: 64, z: -3 }] })
  })

  // Both mining actions collapse onto the one contract method. The distinction
  // that matters is the target form: a name re-searches, a position names the
  // exact block the planner reasoned about (design §4.2).
  it('sends a name for mine_nearest_block', async () => {
    const m = await connected()
    await dispatch({ action: 'mine_nearest_block', name: 'coal_ore', maxDistance: 32 }, m, live())
    expect(m.calls.at(-1)).toEqual({ name: 'mineBlock', args: ['coal_ore', 32] })
  })

  it('sends a position for mine_block_at', async () => {
    const m = await connected()
    await dispatch({ action: 'mine_block_at', x: 18, y: 60, z: -34, maxDistance: 32 }, m, live())
    expect(m.calls.at(-1)).toEqual({ name: 'mineBlock', args: [{ x: 18, y: 60, z: -34 }, 32] })
  })

  it('reports a failed action as its Result, not a throw', async () => {
    const m = await connected()
    m.setFailure('moveTo', { reason: 'unreachable', detail: 'wall in the way' })
    const out = await dispatch({ action: 'move_to', x: 1, y: 64, z: -3 }, m, live())
    expect(out).toEqual({
      kind: 'result',
      result: { ok: false, reason: 'unreachable', detail: 'wall in the way' },
    })
  })

  it('passes the abort signal to the executor', async () => {
    const m = await connected()
    const ac = new AbortController()
    ac.abort()
    const out = await dispatch({ action: 'move_to', x: 1, y: 64, z: -3 }, m, ac.signal)
    expect(out).toEqual({
      kind: 'result',
      result: { ok: false, reason: 'interrupted', detail: 'aborted before start' },
    })
  })

  it('treats chat as an immediate success — it has no Result of its own', async () => {
    const m = await connected()
    const out = await dispatch({ action: 'chat', message: 'hello' }, m, live())
    expect(out).toEqual({ kind: 'result', result: { ok: true, value: undefined } })
    expect(m.calls.at(-1)).toEqual({ name: 'chat', args: ['hello'] })
  })

  it('reports done without touching the executor', async () => {
    const m = await connected()
    const before = m.calls.length
    expect(await dispatch({ action: 'done', summary: 'finished' }, m, live())).toEqual({
      kind: 'done',
    })
    expect(m.calls).toHaveLength(before)
  })

  // The asymmetry the contract documents: findBlocks throws where the six
  // actions resolve. dispatch does not swallow it — runGoal catches it and
  // reports `disconnected` (design §7.3).
  it('lets a disconnected findBlocks throw through to the caller', async () => {
    const m = new MockExecutor({ blocks: [coal] })
    await expect(
      dispatch({ action: 'find_blocks', names: ['coal_ore'], maxDistance: 32, limit: 5 }, m, live()),
    ).rejects.toThrow(/disconnected/)
  })

  it('does not throw for a disconnected action — it resolves disconnected', async () => {
    const m = new MockExecutor({})
    const out = await dispatch({ action: 'move_to', x: 1, y: 64, z: -3 }, m, live())
    expect(out).toEqual({
      kind: 'result',
      result: { ok: false, reason: 'disconnected', detail: 'not connected' },
    })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project unit packages/agent/test/dispatch.test.ts`
Expected: FAIL — `Failed to resolve import "../src/dispatch.js"`.

- [ ] **Step 3: Write `dispatch.ts`**

```ts
import { ok, type BotExecutor } from '@minebot/contract'
import { positionOf, type ActionRequest } from './actions.js'
import type { StepOutcome } from './step.js'

/**
 * The one place the model's menu is translated into contract calls. No LLM
 * here, which is what makes this exhaustively testable against `MockExecutor`.
 *
 * `find_blocks` is the exception to "everything resolves": `findBlocks` throws
 * when disconnected, and that throw is deliberately allowed through rather
 * than converted. `runGoal` catches it and reports `disconnected`; swallowing
 * it here would make a dropped connection look like an empty search, which is
 * exactly the confusion the contract's doc comment says to avoid.
 */
export async function dispatch(
  action: ActionRequest,
  executor: BotExecutor,
  signal: AbortSignal,
): Promise<StepOutcome> {
  switch (action.action) {
    case 'find_blocks':
      return {
        kind: 'blocks',
        blocks: executor.findBlocks({
          names: action.names,
          maxDistance: action.maxDistance,
          limit: action.limit,
        }),
      }

    case 'move_to':
      return { kind: 'result', result: await executor.moveTo(positionOf(action), { signal }) }

    case 'mine_nearest_block':
      return {
        kind: 'result',
        result: await executor.mineBlock(action.name, action.maxDistance, { signal }),
      }

    case 'mine_block_at':
      return {
        kind: 'result',
        result: await executor.mineBlock(positionOf(action), action.maxDistance, { signal }),
      }

    case 'chat':
      // `chat` returns void on the contract — there is nothing to await and no
      // Result to report, so a synchronous success stands in for one.
      executor.chat(action.message)
      return { kind: 'result', result: ok(undefined) }

    case 'done':
      return { kind: 'done' }
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

```bash
npx vitest run --project unit packages/agent
npm run typecheck
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/agent
git commit -m "Add dispatch from the action menu to BotExecutor

Both mining actions collapse back onto the single contract method; the
distinction that survives is the target form, which is the one that
matters — a name re-searches and may pick a different block, a position
names the exact one the planner reasoned about.

find_blocks' throw is allowed through rather than converted to an empty
result. Swallowing it would make a dropped connection indistinguishable
from a search that found nothing, which is the precise confusion the
contract's findBlocks doc comment exists to prevent."
```

---

## Task 6: The goal loop

**Files:**
- Create: `packages/agent/src/loop.ts`
- Test: `packages/agent/test/loop.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `runGoal(goal, opts): Promise<GoalOutcome>`, `RunGoalOptions`, `DEFAULT_MAX_STEPS`, `DEFAULT_STUCK_THRESHOLD`, `DEFAULT_MAX_UNDECODABLE`. Tasks 7 and 8 depend on `runGoal`.

- [ ] **Step 1: Write the failing tests**

`packages/agent/test/loop.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { MockExecutor, type MockOptions } from '@minebot/mock-executor'
import { runGoal } from '../src/loop.js'
import { SchemaDecider, type Decider } from '../src/decide.js'
import { FakeLlmClient } from '../src/fake-llm.js'

const coal = { name: 'coal_ore', position: { x: 18, y: 60, z: -34 }, distance: 7.94 }
const pickaxe = { name: 'stone_pickaxe', count: 1, slot: 0 }

const connected = async (over: MockOptions = {}) => {
  const m = new MockExecutor({ blocks: [coal], inventory: [pickaxe], ...over })
  await m.connect()
  return m
}

const FIND = '{"action":"find_blocks","names":["coal_ore"],"maxDistance":32,"limit":5}'
const MINE_AT = '{"action":"mine_block_at","x":18,"y":60,"z":-34,"maxDistance":32}'
const DONE = '{"action":"done","summary":"mined one coal ore"}'
const WALK = '{"action":"move_to","x":1,"y":64,"z":1}'

const run = (executor: MockExecutor, llm: FakeLlmClient, over = {}) =>
  runGoal('get me some coal', { executor, decider: new SchemaDecider(llm), ...over })

describe('runGoal — the happy path', () => {
  it('searches, mines the exact block it found, and stops on done', async () => {
    const m = await connected()
    const out = await run(m, new FakeLlmClient([FIND, MINE_AT, DONE]))

    expect(out.status).toBe('done')
    expect(out.status === 'done' && out.summary).toBe('mined one coal ore')
    expect(out.steps).toHaveLength(3)

    // The position form proves the loop mined the block it had just found,
    // rather than re-searching by name and possibly getting another.
    expect(m.calls.map((c) => c.name)).toEqual(['connect', 'mineBlock'])
    expect(m.calls[1]?.args[0]).toEqual({ x: 18, y: 60, z: -34 })
    expect(m.getState().self.inventory.some((i) => i.name === 'coal_ore')).toBe(true)
  })

  it('shows the search result to the model on the next turn', async () => {
    const m = await connected()
    const llm = new FakeLlmClient([FIND, MINE_AT, DONE])
    await run(m, llm)
    expect(llm.requests[1]?.messages.map((x) => x.content).join('\n')).toContain(
      'coal_ore at (18, 60, -34)',
    )
  })
})

describe('runGoal — the guards', () => {
  it('stops at the step budget', async () => {
    const m = await connected()
    const out = await run(m, new FakeLlmClient([WALK], { repeatLast: true }), {
      maxSteps: 4,
      stuckThreshold: 99,
    })
    expect(out.status).toBe('budget_exhausted')
    expect(out.steps).toHaveLength(4)
  })

  it('stops when the same action keeps producing the same result', async () => {
    const m = await connected()
    const out = await run(m, new FakeLlmClient([WALK], { repeatLast: true }), {
      maxSteps: 20,
      stuckThreshold: 3,
    })
    expect(out.status).toBe('stuck')
    expect(out.steps).toHaveLength(3)
  })

  it('stops after consecutive unusable replies', async () => {
    const m = await connected()
    const out = await run(m, new FakeLlmClient(['not an action'], { repeatLast: true }), {
      maxUndecodable: 3,
    })
    expect(out.status).toBe('undecodable')
    expect(out.steps).toHaveLength(3)
    expect(out.steps.every((s) => s.action === null && s.decodeError !== null)).toBe(true)
  })

  it('recovers when a bad reply is followed by a good one', async () => {
    const m = await connected()
    const out = await run(m, new FakeLlmClient(['junk', 'junk again', DONE]))
    expect(out.status).toBe('done')
  })
})

describe('runGoal — cancellation', () => {
  it('reports interrupted when the caller aborts before the first step', async () => {
    const m = await connected()
    const ac = new AbortController()
    ac.abort()
    const out = await run(m, new FakeLlmClient([DONE], { repeatLast: true }), { signal: ac.signal })
    expect(out.status).toBe('interrupted')
    expect(out.steps).toHaveLength(0)
  })

  // Design §8 rule 3, and the one obligation spec §3.5 places on this track:
  // an interrupted action is a re-plan, not a failure and not a retry. The
  // reflex layer preempting must not end the goal.
  it('re-plans after an interrupted action instead of ending the goal', async () => {
    const m = await connected({ failures: { moveTo: { reason: 'interrupted', detail: 'reflex' } } })
    const out = await run(m, new FakeLlmClient([WALK, DONE]), { maxSteps: 5 })

    expect(out.status).toBe('done')
    expect(out.steps).toHaveLength(2)
    const first = out.steps[0]?.outcome
    expect(first?.kind === 'result' && first.result.ok === false && first.result.reason).toBe(
      'interrupted',
    )
  })
})

describe('runGoal — things going wrong outside the model', () => {
  it('reports disconnected rather than throwing when getState throws', async () => {
    const m = new MockExecutor({ blocks: [coal] }) // never connected
    const out = await run(m, new FakeLlmClient([DONE], { repeatLast: true }))
    expect(out.status).toBe('disconnected')
    expect(out.status !== 'done' && out.detail).toContain('getState')
  })

  it('reports llm_error rather than throwing when the model is unreachable', async () => {
    const m = await connected()
    const broken: Decider = {
      async decide() {
        throw new Error('connect ECONNREFUSED 127.0.0.1:11434')
      },
    }
    const out = await runGoal('anything', { executor: m, decider: broken })
    expect(out.status).toBe('llm_error')
    expect(out.status !== 'done' && out.detail).toContain('ECONNREFUSED')
  })
})

// The single most important test in this package. It is the only one that
// proves the feedback path — the thing standing in for a retry policy until
// Phase 4 — actually carries a failure back to the model. CLAUDE.md: when you
// add a guard, prove it can fire.
describe('runGoal — failure feedback', () => {
  it('puts the failure reason and detail into the next prompt', async () => {
    const m = await connected({ inventory: [] })
    m.setFailure('mineBlock', { reason: 'missing_tool', detail: 'no pickaxe in inventory' })

    const llm = new FakeLlmClient(['{"action":"mine_nearest_block","name":"coal_ore","maxDistance":32}', DONE])
    const out = await run(m, llm)

    expect(out.status).toBe('done')
    expect(llm.requests).toHaveLength(2)
    expect(llm.lastPromptText()).toContain('FAILED (missing_tool): no pickaxe in inventory')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project unit packages/agent/test/loop.test.ts`
Expected: FAIL — `Failed to resolve import "../src/loop.js"`.

- [ ] **Step 3: Write `loop.ts`**

```ts
import type { BotExecutor, WorldSnapshot } from '@minebot/contract'
import type { DecideResult, Decider } from './decide.js'
import { dispatch } from './dispatch.js'
import { isAbortError } from './llm.js'
import { renderPrompt } from './prompt.js'
import type { GoalOutcome, Step, StepOutcome } from './step.js'

export const DEFAULT_MAX_STEPS = 16
export const DEFAULT_STUCK_THRESHOLD = 3
export const DEFAULT_MAX_UNDECODABLE = 3

export interface RunGoalOptions {
  /** Must already be connected. Session lifecycle belongs to the caller. */
  readonly executor: BotExecutor
  readonly decider: Decider
  readonly maxSteps?: number
  readonly stuckThreshold?: number
  readonly maxUndecodable?: number
  readonly signal?: AbortSignal
}

const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Collapses an outcome to what "the same thing happened again" means. */
const outcomeSignature = (o: StepOutcome): string => {
  switch (o.kind) {
    case 'blocks':
      return `blocks:${o.blocks.length}`
    case 'result':
      return o.result.ok ? 'result:ok' : `result:${o.result.reason}`
    case 'undecodable':
      return 'undecodable'
    case 'done':
      return 'done'
  }
}

const signatureOf = (s: Step): string | null =>
  s.action === null ? null : `${JSON.stringify(s.action)}|${outcomeSignature(s.outcome)}`

const isStuck = (steps: readonly Step[], threshold: number): boolean => {
  if (threshold < 1 || steps.length < threshold) return false
  const tail = steps.slice(-threshold)
  const first = tail[0]
  const target = first ? signatureOf(first) : null
  if (target === null) return false
  return tail.every((s) => signatureOf(s) === target)
}

/**
 * Observe, decide, dispatch, record — until the model says done or a guard
 * stops it. Failure is always a returned value; nothing here throws.
 *
 * Deliberately no per-`FailureReason` branching. Every outcome is rendered into
 * the history the model reads next turn, and the model decides. Phase 4 writes
 * the real policy against the step logs this produces, rather than against
 * failures nobody has observed yet.
 */
export async function runGoal(goal: string, opts: RunGoalOptions): Promise<GoalOutcome> {
  const { executor, decider, signal: outer } = opts
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS
  const stuckThreshold = opts.stuckThreshold ?? DEFAULT_STUCK_THRESHOLD
  const maxUndecodable = opts.maxUndecodable ?? DEFAULT_MAX_UNDECODABLE

  const steps: Step[] = []
  let consecutiveUndecodable = 0

  for (let n = 1; n <= maxSteps; n++) {
    if (outer?.aborted) {
      return { status: 'interrupted', detail: 'the caller aborted the goal', steps }
    }

    // getState() throws when disconnected — one of only two such sites, the
    // other being find_blocks inside dispatch (design §7.3).
    let snapshot: WorldSnapshot
    try {
      snapshot = executor.getState()
    } catch (e) {
      return { status: 'disconnected', detail: `getState() threw: ${describeError(e)}`, steps }
    }

    const controller = new AbortController()
    const relay = (): void => controller.abort()
    outer?.addEventListener('abort', relay, { once: true })

    try {
      let decided: DecideResult
      try {
        decided = await decider.decide(renderPrompt(goal, snapshot, steps), controller.signal)
      } catch (e) {
        return isAbortError(e)
          ? { status: 'interrupted', detail: 'the model call was aborted', steps }
          : { status: 'llm_error', detail: describeError(e), steps }
      }

      if (!decided.ok) {
        consecutiveUndecodable += 1
        steps.push({
          n,
          raw: decided.raw,
          action: null,
          decodeError: decided.error,
          outcome: { kind: 'undecodable' },
        })
        if (consecutiveUndecodable >= maxUndecodable) {
          return {
            status: 'undecodable',
            detail: `${consecutiveUndecodable} unusable replies in a row; the last was ${decided.error.kind}`,
            steps,
          }
        }
        continue
      }
      consecutiveUndecodable = 0

      let outcome: StepOutcome
      try {
        outcome = await dispatch(decided.action, executor, controller.signal)
      } catch (e) {
        return { status: 'disconnected', detail: `findBlocks() threw: ${describeError(e)}`, steps }
      }

      steps.push({ n, raw: decided.raw, action: decided.action, decodeError: null, outcome })

      if (decided.action.action === 'done') {
        return { status: 'done', summary: decided.action.summary, steps }
      }

      // The caller aborting ends the goal. An `interrupted` result *without* an
      // outer abort is the reflex layer preempting: fall through, re-observe,
      // and decide again from fresh state. Never retry the interrupted action
      // against the snapshot it was chosen for — after a flee, that position is
      // a lie (design §8, spec §3.5).
      if (outer?.aborted) {
        return { status: 'interrupted', detail: 'the caller aborted the goal', steps }
      }

      if (isStuck(steps, stuckThreshold)) {
        return {
          status: 'stuck',
          detail: `the same action produced the same result ${stuckThreshold} times running`,
          steps,
        }
      }
    } finally {
      outer?.removeEventListener('abort', relay)
    }
  }

  return { status: 'budget_exhausted', detail: `no done after ${maxSteps} steps`, steps }
}
```

- [ ] **Step 4: Run tests and typecheck**

```bash
npx vitest run --project unit packages/agent
npm run typecheck
```

Expected: all green.

- [ ] **Step 5: Prove the stuck guard can actually fire on its own**

CLAUDE.md: *"When you add a guard, prove it can fire. A safety check nobody has seen trigger is not yet known to work."* The `stuck` test above passes `stuckThreshold: 3` explicitly. Confirm the default value also fires, so the guard is not dead in production:

```bash
npx vitest run --project unit packages/agent/test/loop.test.ts -t 'stops when the same action'
```

Then temporarily change that test to omit `stuckThreshold` and re-run. It must still report `stuck`. Restore the explicit value afterwards — the explicit form documents the threshold under test.

- [ ] **Step 6: Commit**

```bash
git add packages/agent
git commit -m "Add runGoal — the observe/decide/dispatch loop

No per-FailureReason branching, on purpose. Every outcome is rendered into
the history the model reads next turn and the model decides; Phase 4 writes
the real policy against the step logs this produces rather than against
failures nobody has observed yet. The only hardcoded protections are a step
budget and a repetition guard.

An interrupted action is a re-plan, not a retry — the one obligation design
spec §3.5 places on this track. The loop discards its snapshot and observes
again, because after the reflex layer has fled a mob the position that
action was chosen for no longer exists. A caller-initiated abort is the
separate case and does end the goal.

Failure is always a returned value. getState() and findBlocks() throw where
the six actions resolve, so the loop has exactly two catch sites, and both
report disconnected rather than letting an exception escape runGoal."
```

---

## Task 7: The real Ollama client and a live probe

Nothing here is exercised by `npm test` beyond its request shape. That is the point: no test opens a socket.

**Files:**
- Create: `packages/agent/src/ollama.ts`
- Create: `packages/agent/src/probe.ts`
- Test: `packages/agent/test/ollama.test.ts`

**Interfaces:**
- Consumes: `ChatRequest`, `ChatReply`, `LlmClient` (Task 2); `ACTION_SCHEMA` (Task 1); `decode` (Task 3); `renderPrompt` (Task 4).
- Produces: `OllamaClient`, `OllamaOptions`, `DEFAULT_HOST`, `DEFAULT_MODEL`. Task 8 depends on `OllamaClient`.

- [ ] **Step 1: Write the failing tests**

`packages/agent/test/ollama.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { OllamaClient } from '../src/ollama.js'
import { ACTION_SCHEMA } from '../src/actions.js'

const messages = [{ role: 'user' as const, content: 'hello' }]

const recordingFetch = (body: unknown, status = 200) => {
  const seen: { url: string; init: RequestInit }[] = []
  const impl = (async (url: unknown, init: unknown) => {
    seen.push({ url: String(url), init: init as RequestInit })
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'Test',
      json: async () => body,
      text: async () => JSON.stringify(body),
    }
  }) as unknown as typeof fetch
  return { impl, seen }
}

const parseBody = (init: RequestInit): Record<string, unknown> =>
  JSON.parse(String(init.body)) as Record<string, unknown>

describe('OllamaClient request shape', () => {
  it('posts to /api/chat on the configured host', async () => {
    const { impl, seen } = recordingFetch({ message: { content: '{}' } })
    await new OllamaClient({ host: 'http://box:11434/', fetchImpl: impl }).chat({ messages })
    expect(seen[0]?.url).toBe('http://box:11434/api/chat')
    expect(seen[0]?.init.method).toBe('POST')
  })

  // Design §5.1 and design spec §8.1: qwen3 advertises a thinking mode whose
  // traces inflate latency and wrap JSON in prose. Temperature 0 because this
  // is classification over a fixed menu, not generation.
  it('disables thinking, streaming and sampling', async () => {
    const { impl, seen } = recordingFetch({ message: { content: '{}' } })
    await new OllamaClient({ model: 'qwen3:14b', fetchImpl: impl }).chat({ messages })
    const body = parseBody(seen[0]!.init)
    expect(body['model']).toBe('qwen3:14b')
    expect(body['stream']).toBe(false)
    expect(body['think']).toBe(false)
    expect(body['options']).toEqual({ temperature: 0 })
  })

  it('sends the schema as `format` when one is given, and omits it otherwise', async () => {
    const withSchema = recordingFetch({ message: { content: '{}' } })
    await new OllamaClient({ fetchImpl: withSchema.impl }).chat({ messages, schema: ACTION_SCHEMA })
    expect(parseBody(withSchema.seen[0]!.init)['format']).toEqual(ACTION_SCHEMA)

    const without = recordingFetch({ message: { content: '{}' } })
    await new OllamaClient({ fetchImpl: without.impl }).chat({ messages })
    expect(parseBody(without.seen[0]!.init)).not.toHaveProperty('format')
  })

  it('forwards the abort signal to fetch', async () => {
    const { impl, seen } = recordingFetch({ message: { content: '{}' } })
    const ac = new AbortController()
    await new OllamaClient({ fetchImpl: impl }).chat({ messages, signal: ac.signal })
    expect(seen[0]?.init.signal).toBe(ac.signal)
  })

  it('returns the reply content', async () => {
    const { impl } = recordingFetch({ message: { content: '{"action":"done","summary":"ok"}' } })
    const reply = await new OllamaClient({ fetchImpl: impl }).chat({ messages })
    expect(reply.content).toBe('{"action":"done","summary":"ok"}')
    expect(reply.toolCalls).toBeUndefined()
  })

  it('surfaces tool calls when the server returns them', async () => {
    const { impl } = recordingFetch({
      message: { content: '', tool_calls: [{ function: { name: 'move_to', arguments: { x: 1 } } }] },
    })
    const reply = await new OllamaClient({ fetchImpl: impl }).chat({ messages })
    expect(reply.toolCalls).toEqual([{ name: 'move_to', arguments: { x: 1 } }])
  })

  it('throws with the status and body on a non-2xx response', async () => {
    const { impl } = recordingFetch({ error: 'model not found' }, 404)
    await expect(new OllamaClient({ fetchImpl: impl }).chat({ messages })).rejects.toThrow(
      /404.*model not found/s,
    )
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project unit packages/agent/test/ollama.test.ts`
Expected: FAIL — `Failed to resolve import "../src/ollama.js"`.

- [ ] **Step 3: Write `ollama.ts`**

```ts
import type { ChatReply, ChatRequest, LlmClient } from './llm.js'

export const DEFAULT_HOST = 'http://127.0.0.1:11434'
export const DEFAULT_MODEL = 'qwen3:14b'

export interface OllamaOptions {
  /** Defaults to `$OLLAMA_HOST`, then {@link DEFAULT_HOST}. */
  readonly host?: string
  /** Defaults to `$MINEBOT_MODEL`, then {@link DEFAULT_MODEL}. */
  readonly model?: string
  readonly temperature?: number
  readonly think?: boolean
  /** Injected so the request shape can be asserted without a socket. */
  readonly fetchImpl?: typeof fetch
}

interface OllamaChatResponse {
  message?: {
    content?: string
    tool_calls?: { function?: { name?: string; arguments?: unknown } }[]
  }
}

/**
 * The only module in this package that opens a socket, and the only one no
 * test exercises end to end — there is no reachable endpoint (design §2).
 * `probe.ts` is where it meets a real model.
 */
export class OllamaClient implements LlmClient {
  readonly host: string
  readonly model: string

  private readonly temperature: number
  private readonly think: boolean
  private readonly fetchImpl: typeof fetch

  constructor(opts: OllamaOptions = {}) {
    this.host = (opts.host ?? process.env['OLLAMA_HOST'] ?? DEFAULT_HOST).replace(/\/+$/, '')
    this.model = opts.model ?? process.env['MINEBOT_MODEL'] ?? DEFAULT_MODEL
    this.temperature = opts.temperature ?? 0
    // Thinking off: its traces inflate latency and wrap JSON in prose, which
    // fights constrained output. Design spec §8.1 recommends starting here.
    this.think = opts.think ?? false
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  buildBody(req: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
      think: this.think,
      options: { temperature: this.temperature },
    }
    if (req.schema !== undefined) body['format'] = req.schema
    return body
  }

  async chat(req: ChatRequest): Promise<ChatReply> {
    const res = await this.fetchImpl(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(this.buildBody(req)),
      signal: req.signal,
    })

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300)
      throw new Error(`Ollama ${res.status} ${res.statusText}: ${detail}`)
    }

    const parsed = (await res.json()) as OllamaChatResponse
    const toolCalls = parsed.message?.tool_calls?.map((c) => ({
      name: c.function?.name ?? '',
      arguments: c.function?.arguments,
    }))

    return toolCalls && toolCalls.length > 0
      ? { content: parsed.message?.content ?? '', toolCalls }
      : { content: parsed.message?.content ?? '' }
  }
}
```

- [ ] **Step 4: Write `probe.ts`**

This is the script that answers spec §12's first open question when an endpoint exists.

```ts
/**
 * Ask a real model for one action, N times, and report how often the reply
 * decoded. Run by hand — never part of `npm test`:
 *
 *   OLLAMA_HOST=http://box:11434 npm run agent:probe -- 10
 *
 * Spec §12 question 1 ("does qwen3:14b actually hold the format?") is answered
 * here and nowhere else.
 */
import type { WorldSnapshot } from '@minebot/contract'
import { decode } from './decide.js'
import { OllamaClient } from './ollama.js'
import { renderPrompt } from './prompt.js'
import { ACTION_SCHEMA } from './actions.js'

const SNAPSHOT: WorldSnapshot = Object.freeze({
  takenAt: Date.now(),
  self: {
    position: { x: 12, y: 64, z: -30 },
    health: 20,
    food: 18,
    dimension: 'overworld',
    onGround: true,
    inventory: [{ name: 'stone_pickaxe', count: 1, slot: 0 }],
    heldItem: { name: 'stone_pickaxe', count: 1, slot: 0 },
  },
  nearbyEntities: [],
})

const attempts = Number(process.argv[2] ?? '5')

const main = async (): Promise<void> => {
  const client = new OllamaClient()
  console.log(`Probing ${client.host} with ${client.model}, ${attempts} attempt(s)\n`)

  const messages = renderPrompt('get me some coal', SNAPSHOT, [])
  let decoded = 0
  const latencies: number[] = []

  for (let i = 1; i <= attempts; i++) {
    const started = Date.now()
    try {
      const reply = await client.chat({ messages, schema: ACTION_SCHEMA })
      const elapsed = Date.now() - started
      latencies.push(elapsed)
      const result = decode(reply.content)
      if (result.ok) decoded += 1
      console.log(
        `${i}. ${elapsed}ms  ${result.ok ? 'OK  ' + JSON.stringify(result.action) : 'REJECTED (' + result.error.kind + ') ' + result.error.detail}`,
      )
      if (!result.ok) console.log(`   raw: ${reply.content.slice(0, 200)}`)
    } catch (e) {
      console.log(`${i}. ERROR ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const median =
    latencies.length === 0
      ? 0
      : [...latencies].sort((a, b) => a - b)[Math.floor(latencies.length / 2)] ?? 0
  console.log(`\nDecoded ${decoded}/${attempts}. Median latency ${median}ms.`)
  if (decoded < attempts) {
    console.log('Record the failures in spec §12 — that is what the question is for.')
  }
}

await main()
```

- [ ] **Step 5: Add the script and run everything**

In root `package.json` scripts, add:

```json
"agent:probe": "tsx packages/agent/src/probe.ts"
```

```bash
npx vitest run --project unit packages/agent
npm run typecheck
```

Expected: all green. Do **not** run `agent:probe` — there is no endpoint. Its first real run is the moment spec §12 question 1 gets an answer.

- [ ] **Step 6: Commit**

```bash
git add packages/agent package.json
git commit -m "Add the Ollama client and a live probe script

Tests assert the request shape and nothing else — fetch is injected, no
socket opens. That is deliberate rather than a shortcut: there is no
reachable endpoint, and a test that pretends otherwise would be the kind of
fixture that passes without doing anything.

think:false and temperature:0 are both deliberate. Design spec §8.1 flags
qwen3's thinking traces as inflating latency and wrapping JSON in prose,
which fights constrained output; choosing from a fixed menu is
classification, not generation.

probe.ts is where spec §12's first open question — does qwen3:14b actually
hold the format — gets answered, and it is the only place. It reports a
decode rate and median latency rather than a pass/fail, because the useful
answer is a number."
```

---

## Task 8: The deliverable script and documentation

The phase plan's stated Track B deliverable: *"a script that takes a fake game state and produces a validated action, with zero dependency on a live Minecraft connection."*

**Files:**
- Create: `packages/agent/src/index.ts`
- Create: `packages/agent/src/demo.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: the package's public surface.

- [ ] **Step 1: Write `index.ts`**

```ts
export { ACTION_MENU, ACTION_NAMES, ACTION_SCHEMA, positionOf } from './actions.js'
export type { ActionName, ActionRequest } from './actions.js'

export { abortError, isAbortError } from './llm.js'
export type { ChatMessage, ChatReply, ChatRequest, LlmClient, ToolCall } from './llm.js'

export { FakeLlmClient } from './fake-llm.js'
export type { FakeLlmOptions } from './fake-llm.js'

export { OllamaClient, DEFAULT_HOST, DEFAULT_MODEL } from './ollama.js'
export type { OllamaOptions } from './ollama.js'

export { decode, SchemaDecider } from './decide.js'
export type { DecodeError, DecodeResult, DecideResult, Decider } from './decide.js'

export { HISTORY_WINDOW, renderAction, renderOutcome, renderPrompt, renderSnapshot, renderStep } from './prompt.js'
export type { GoalOutcome, GoalStatus, Step, StepOutcome } from './step.js'

export { dispatch } from './dispatch.js'
export {
  runGoal,
  DEFAULT_MAX_STEPS,
  DEFAULT_STUCK_THRESHOLD,
  DEFAULT_MAX_UNDECODABLE,
} from './loop.js'
export type { RunGoalOptions } from './loop.js'
```

- [ ] **Step 2: Write `demo.ts`**

```ts
/**
 * The Track B deliverable: fake game state in, validated actions out, with no
 * Minecraft server and no model. The LLM is scripted and the world is a
 * MockExecutor, so this runs anywhere `npm install` has.
 *
 *   npm run agent:demo
 *
 * Swap FakeLlmClient for OllamaClient to drive it with a real model, and swap
 * MockExecutor for MineflayerExecutor to drive it against a real server — that
 * second swap is Phase 3, and it changes this file only.
 */
import { MockExecutor } from '@minebot/mock-executor'
import { FakeLlmClient } from './fake-llm.js'
import { SchemaDecider } from './decide.js'
import { runGoal } from './loop.js'
import { renderStep } from './prompt.js'

const main = async (): Promise<void> => {
  const executor = new MockExecutor({
    position: { x: 12, y: 64, z: -30 },
    inventory: [{ name: 'stone_pickaxe', count: 1, slot: 0 }],
    blocks: [
      { name: 'coal_ore', position: { x: 18, y: 60, z: -34 }, distance: 7.94 },
      { name: 'iron_ore', position: { x: 25, y: 58, z: -30 }, distance: 14.3 },
    ],
  })
  await executor.connect()

  const llm = new FakeLlmClient([
    '{"action":"find_blocks","names":["coal_ore","deepslate_coal_ore"],"maxDistance":32,"limit":5}',
    '{"action":"mine_block_at","x":18,"y":60,"z":-34,"maxDistance":32}',
    '{"action":"done","summary":"mined one coal ore and collected the drop"}',
  ])

  const outcome = await runGoal('get me some coal', {
    executor,
    decider: new SchemaDecider(llm),
  })

  console.log(`Goal: get me some coal`)
  console.log(`Result: ${outcome.status}`)
  console.log(
    outcome.status === 'done' ? `Summary: ${outcome.summary}` : `Detail: ${outcome.detail}`,
  )
  console.log('\nStep log:')
  for (const step of outcome.steps) console.log(renderStep(step))

  console.log('\nExecutor calls:')
  for (const call of executor.calls) console.log(`  ${call.name}(${JSON.stringify(call.args)})`)

  console.log('\nFinal inventory:')
  for (const item of executor.getState().self.inventory) {
    console.log(`  ${item.name} x${item.count}`)
  }

  await executor.disconnect()
}

await main()
```

- [ ] **Step 3: Add the script and run it**

In root `package.json` scripts, add:

```json
"agent:demo": "tsx packages/agent/src/demo.ts"
```

Run: `npm run agent:demo`

Expected output ends with `coal_ore x1` in the final inventory, a step log of three entries, and `mineBlock([{"x":18,"y":60,"z":-34},32])` among the executor calls. If the mine used a name rather than a position, the loop is re-searching instead of mining what it found — fix that before continuing.

- [ ] **Step 4: Update `README.md`**

Three edits:

1. In the packages block, change `└── agent/           (not yet built) The LLM planning loop.` to `└── agent/           The LLM planning loop. Deps: contract, mock-executor.`
2. In the Commands table, add two rows: `npm run agent:demo` — "Track B deliverable: the loop against a fake model and a mock world" — Needs a server? **No**; and `npm run agent:probe` — "Ask a real model for one action, N times; report the decode rate" — Needs a server? **No (needs Ollama)**.
3. In the Roadmap table, leave the phase rows alone but add a line beneath it: *"Track B's planning loop is built and tested against the mock; Phase 3 is the swap."*

Also add a short section after "The cross-implementation test suite":

```markdown
### The planning loop

`packages/agent/` decides what the bot does next. Each turn it takes a
`WorldSnapshot`, renders it into a prompt with a bounded history of what just
happened, asks a local model for exactly one action under a JSON Schema
constraint, validates the reply, and dispatches it through `BotExecutor`.

Two properties are worth knowing:

- **It never opens a socket in tests.** The model sits behind an `LlmClient`
  interface and every test uses a scripted fake, the same way every test uses
  `MockExecutor` instead of a Minecraft server.
- **It codes no retry policy.** Failures — with their `FailureReason` and
  detail — are rendered into the next prompt and the model decides. The only
  hardcoded guards are a step budget and a repetition check. Phase 4 writes the
  real policy against the step logs this produces.
```

- [ ] **Step 5: Update `CLAUDE.md`**

Four edits:

1. Under **Commands**, update the unit-test count. Run `npm test` first and use the number it prints; add `npm run agent:demo   # Track B deliverable. No server, no model.`
2. Under **Scope boundaries**, replace `packages/agent/ does not exist. It is the other track's package and must never depend on mineflayer.` with:
   `packages/agent/ is the planning loop. It must never depend on mineflayer — check-invariants.mjs enforces it. It codes no per-FailureReason retry policy; that is Phase 4's, and the loop feeds failures back to the model instead.`
3. Under **Read first**, add: `[Track B design](docs/superpowers/specs/2026-09-07-track-b-planning-loop-design.md) — the planning loop. §4 explains why the action menu is not a mirror of BotExecutor, and §12 lists what is still unmeasured because no model endpoint is reachable.`
4. Under **Testing discipline**, add a fourth bullet after the three layers:
   `4. **The agent's fakes** — packages/agent tests run between FakeLlmClient and MockExecutor. Neither the network nor a model is involved. If a test there needs a real model, it belongs in probe.ts instead.`

- [ ] **Step 6: Run everything**

```bash
npm test
npm run typecheck
node scripts/check-invariants.mjs
npm run agent:demo
```

Expected: all unit tests green, clean typecheck, `Structural invariants OK (checked 2 of 2; agent package present)`, and a demo run ending with `coal_ore x1`.

Do **not** run `npm run test:integration` — this plan changes nothing Track A owns, and the integration suite needs the dev server.

- [ ] **Step 7: Commit**

```bash
git add packages/agent package.json README.md CLAUDE.md
git commit -m "Add the Track B deliverable script and update the docs

demo.ts is the phase plan's stated deliverable: fake game state in,
validated actions out, no Minecraft and no model. It doubles as the
integration checklist — Phase 3 changes this file and nothing else, since
runGoal takes a BotExecutor and cannot tell which one it has.

The demo asserts something worth asserting by eye: the mine call carries a
position, not a name. A name there would mean the loop re-searched instead
of mining the block it had just found, which is the failure the contract's
Vec3 target form was added to prevent."
```

---

## Task 9: Open the pull request

- [ ] **Step 1: Confirm the whole suite is green from a clean state**

```bash
npm test && npm run typecheck && node scripts/check-invariants.mjs && npm run agent:demo
```

All four must pass. Do not open the PR on a red suite.

- [ ] **Step 2: Confirm the shared surface is untouched**

```bash
git diff --stat main -- packages/contract packages/mock-executor
```

Expected: **no output.** Any change here is a change to the integration boundary with Track A and needs agreement before it lands (spec §9, CLAUDE.md). If this prints anything, stop and report rather than opening the PR.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin track-b-planning-loop
gh pr create --title "Track B: the LLM planning loop" --body-file -
```

Body:

```markdown
## What

`packages/agent/` — the head for the bot's hands. It observes a `WorldSnapshot`,
asks a local model for exactly one action under a JSON Schema constraint,
validates the reply, dispatches it through `BotExecutor`, and loops until the
goal is met or a guard stops it.

`npm run agent:demo` is the phase plan's stated Track B deliverable: fake game
state in, validated actions out, with no Minecraft server and no model.

## Three decisions worth reviewing

**The action menu is not a mirror of `BotExecutor`.** `find_blocks` is an action
the model chooses, because `WorldSnapshot` carries no blocks at all — a 16-chunk
radius is ~10^5 of them. Mining is two flat actions rather than one
`string | Vec3` target, so the schema has exactly one union instead of a nested
one. The Phase 5 stubs stay out of the menu entirely: they return
`fail('internal')` by design, so offering them spends a step on certain failure.

**No retry policy.** Failures are rendered into the next prompt with their
reason and detail, and the model decides. Only a step budget and a repetition
guard are hardcoded. Phase 4 writes the real policy against the step logs this
produces, rather than against failures nobody has observed yet.

**Nothing opens a socket.** No model endpoint is reachable from this machine, so
the transport is behind an `LlmClient` interface with a scripted fake as the
only implementation any test uses. `npm test` already never talked to Minecraft;
now it never talks to a model either.

## What this cannot tell you

Whether `qwen3:14b` actually holds the format. There is no endpoint to measure
against. `npm run agent:probe` answers it in one run when there is one, and spec
§12 carries the question openly rather than pretending it is settled.

## Testing

`npm test` — all unit tests, no network. `npm run typecheck`.
`node scripts/check-invariants.mjs` now reports **2 of 2**: creating the manifest
activated the guarantee that the planning track cannot import `mineflayer`.

`packages/contract/` and `packages/mock-executor/` are untouched — verified with
`git diff --stat main`. Everything this needed already existed, which is a direct
dividend of the four design-spec §9 changes that landed at the start of Phase 2.

## Note for Track A

Phase 3's end-to-end run is blocked on Phase 2's executor half: `mineBlock` still
returns `fail('internal', 'mineBlock arrives in Phase 2')` and
`mineflayer-pathfinder` is not a dependency yet. The contract changes landed;
tasks 5–13 of the Phase 2 plan did not.
```
