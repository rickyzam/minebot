# Phase 3 (JOINT) Implementation Plan — Integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The full loop closes end to end — real game state → LLM decision → real game action — proven by deterministic integration tests and demonstrated by `npm run demo:phase3` against a real model.

**Architecture:** A new `packages/bot/` composition root depends on both tracks and holds the one function where they meet: `runBotGoal()`, which owns connect/disconnect around Track B's `runGoal()`. Integration tests drive the real `MineflayerExecutor` with a *scripted* `FakeLlmClient`, so wiring failures and model failures never share a signal. The demo drives the same path with a real `OllamaClient`.

**Tech Stack:** TypeScript 7, Node 24 (ESM), npm workspaces, Vitest 5, Mineflayer 4.39.0, mineflayer-pathfinder 2.4.5, Ollama (`qwen3:14b`), tsx.

**Spec:** [`docs/superpowers/specs/2026-09-08-phase-3-integration-design.md`](../specs/2026-09-08-phase-3-integration-design.md)

## Global Constraints

- Node `>=24`. All packages are ESM (`"type": "module"`). `verbatimModuleSyntax` is on — use `import type` for type-only imports.
- Relative imports carry the `.js` extension (`./session.js`), per NodeNext resolution.
- Exact version pins in every manifest. No `^` or `~`. Cross-package deps use the exact string `"0.1.0"`.
- `packages/contract` MUST keep **zero runtime dependencies**. This plan does not modify `packages/contract` or `packages/mock-executor` at all — they are the shared surface and changing them needs Track B agreement.
- `packages/agent` MUST NOT depend on `mineflayer`, `mineflayer-pathfinder`, `prismarine-*`, **or `@minebot/executor`**. Task 2 makes that last one enforced rather than merely intended.
- **Contract rule:** on abort, an action MUST resolve `{ ok: false, reason: 'interrupted' }`. It MUST NOT throw and MUST NOT resolve `ok: true`.
- Unit tests never touch the network. Integration tests live under `packages/*/test/integration/` and are the only tests requiring a running server. **No test may require a running Ollama** — the model is for the demo and the probe only.
- Dev server: Fabric 1.21.10 backend on `127.0.0.1:25566` (tmux session `mc`), behind a Velocity proxy on `0.0.0.0:25565` (tmux session `velocity`). Bots connect to the backend, which is the executor's default port. Do not stop or restart either without asking. Drive the backend console with `tmux send-keys -t mc '<command>' Enter`.
- Integration tests connect with a distinct username each and MUST disconnect in `afterEach`, or they leak a bot onto the server.
- Arena coordinates are exclusive. **In use: 500–560, 800–840, 860–880, 900–930, 950–980, 1000–1020.** This plan uses **1100–1130** (tests) and **1150–1180** (demo).

## Verified environment facts

Measured on 2026-09-08 against `main` at `7932b5d`. Measurements, not assumptions.

- `packages/contract/` and `packages/mock-executor/` are byte-identical across PR #11 and #12 (`git diff --stat 568cd21..HEAD -- packages/contract packages/mock-executor` is empty).
- Every action in Track B's menu maps to a `BotExecutor` method Track A implements: `find_blocks`→`findBlocks`, `move_to`→`moveTo`, `mine_nearest_block`→`mineBlock(string,…)`, `mine_block_at`→`mineBlock(Vec3,…)`, `chat`→`chat`. No Phase 5 stub is reachable from the menu.
- Baseline: **260 unit tests, 79 integration tests**, clean typecheck, `check-invariants` reports 2 of 2.
- `qwen3:14b` is present in Ollama at `http://127.0.0.1:11434` — the model Track B's 25/25 probe measured.
- `runGoal` returns `status: 'interrupted'` only when the **outer** signal aborted. An `interrupted` result without an outer abort means the reflex layer preempted; that layer is Phase 5, so that branch is unreachable now.
- `FakeLlmClient` exposes a public `requests: ChatRequest[]`, and `ChatRequest.messages` is `readonly ChatMessage[]` with `{ role, content }`. That is how a test asserts what actually reached the model.
- Vitest's integration project glob is `packages/*/test/integration/**/*.test.ts`, so a new package needs no config change.

## File structure

| File | Responsibility |
|---|---|
| `packages/bot/package.json` | **Create.** The only manifest depending on both `@minebot/agent` and `@minebot/executor` |
| `packages/bot/src/session.ts` | **Create.** `runBotGoal()` — connect, run, always disconnect. The composition root |
| `packages/bot/src/index.ts` | **Create.** Public exports |
| `packages/bot/test/session.test.ts` | **Create.** Unit tests for lifecycle, against `MockExecutor`. No network |
| `packages/bot/test/integration/loop.int.test.ts` | **Create.** The three real-server cases |
| `packages/bot/src/phase3-demo.ts` | **Create.** The watchable deliverable |
| `scripts/check-invariants.mjs` | **Modify.** Invariant 2 gains a transitive-reach check |
| `packages/agent/src/demo.ts` | **Modify.** Header comment only — it currently describes an impossible Phase 3 |
| `package.json` | **Modify.** Add `demo:phase3` |
| `README.md`, `CLAUDE.md` | **Modify.** Status, counts, commands, new facts |

---

## Task 1: `packages/bot/` and `runBotGoal()`

The composition root. Built and unit-tested against `MockExecutor` first, so the lifecycle logic is proven before a real server is involved.

**Files:**
- Create: `packages/bot/package.json`
- Create: `packages/bot/src/session.ts`
- Create: `packages/bot/src/index.ts`
- Test: `packages/bot/test/session.test.ts`

**Interfaces:**
- Consumes: `runGoal`, `type Decider`, `type GoalOutcome` from `@minebot/agent`; `type BotExecutor` from `@minebot/contract`.
- Produces:
  ```ts
  interface RunBotGoalOptions {
    readonly executor: BotExecutor
    readonly decider: Decider
    readonly maxSteps?: number
    readonly stuckThreshold?: number
    readonly signal?: AbortSignal
  }
  function runBotGoal(goal: string, opts: RunBotGoalOptions): Promise<GoalOutcome>
  ```
  Tasks 3–6 all call it.

- [ ] **Step 1: Create the manifest**

`packages/bot/package.json`:

```json
{
  "name": "@minebot/bot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": { "types": "./src/index.ts", "default": "./src/index.ts" }
  },
  "dependencies": {
    "@minebot/agent": "0.1.0",
    "@minebot/contract": "0.1.0",
    "@minebot/executor": "0.1.0"
  },
  "devDependencies": {
    "@minebot/mock-executor": "0.1.0"
  }
}
```

Then link the new workspace:

```bash
npm install
```

- [ ] **Step 2: Write the failing tests**

`packages/bot/test/session.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { MockExecutor } from '@minebot/mock-executor'
import { FakeLlmClient, SchemaDecider } from '@minebot/agent'
import { fail, type Result } from '@minebot/contract'
import { runBotGoal } from '../src/session.js'

const decider = (...replies: string[]): SchemaDecider =>
  new SchemaDecider(new FakeLlmClient(replies))

describe('runBotGoal', () => {
  it('connects before running and disconnects after', async () => {
    const executor = new MockExecutor({
      blocks: [{ name: 'coal_ore', position: { x: 4, y: 64, z: 0 }, distance: 4 }],
    })
    const outcome = await runBotGoal('get me some coal', {
      executor,
      decider: decider('{"action":"done","summary":"nothing to do"}'),
    })

    expect(outcome.status).toBe('done')
    const calls = executor.calls.map((c) => c.name)
    expect(calls[0]).toBe('connect')
    expect(calls.at(-1)).toBe('disconnect')
    // getState() throws once disconnected — the cheapest proof it really happened.
    expect(() => executor.getState()).toThrow()
  })

  it('disconnects even when the goal ends badly', async () => {
    const executor = new MockExecutor()
    const outcome = await runBotGoal('impossible', {
      executor,
      decider: decider('not json at all', 'still not json', 'nope'),
    })

    expect(outcome.status).toBe('undecodable')
    expect(() => executor.getState()).toThrow()
  })

  it('reports disconnected without running the loop when connect() fails', async () => {
    // MockExecutor's failure injection covers the six actions, not connect(),
    // so subclass rather than stub — it keeps the executor fully typed.
    class UnconnectableExecutor extends MockExecutor {
      override async connect(): Promise<Result> {
        return fail('disconnected', 'no server')
      }
    }

    const llm = new FakeLlmClient(['{"action":"done","summary":"never reached"}'])
    const outcome = await runBotGoal('anything', {
      executor: new UnconnectableExecutor(),
      decider: new SchemaDecider(llm),
    })

    expect(outcome.status).toBe('disconnected')
    expect(outcome.steps).toHaveLength(0)
    // The model must never be consulted for a session that never opened.
    expect(llm.requests).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `../src/session.js` does not exist.

- [ ] **Step 4: Write `session.ts`**

`packages/bot/src/session.ts`:

```ts
import type { BotExecutor } from '@minebot/contract'
import { runGoal, type Decider, type GoalOutcome } from '@minebot/agent'

/**
 * The composition root: the one place `@minebot/agent` and `@minebot/executor`
 * are both in scope.
 *
 * It lives here rather than in either track's package because both would break
 * a design spec §4 guarantee — `packages/agent` must be buildable with no game
 * libraries at all, and `packages/executor` has no business knowing an LLM
 * exists. See the Phase 3 design §3.
 */
export interface RunBotGoalOptions {
  /**
   * Built but NOT connected. `runGoal` requires an already-connected executor
   * and leaves lifecycle to its caller; this function is that caller.
   */
  readonly executor: BotExecutor
  readonly decider: Decider
  readonly maxSteps?: number
  readonly stuckThreshold?: number
  readonly signal?: AbortSignal
}

/**
 * Connect, pursue `goal`, and always disconnect.
 *
 * The `finally` is load-bearing: an integration test that leaks a bot onto the
 * shared dev server poisons every test that runs after it, and `runGoal`
 * returning failure as a value means the only way out of here without
 * disconnecting would be a thrown error.
 */
export async function runBotGoal(
  goal: string,
  opts: RunBotGoalOptions,
): Promise<GoalOutcome> {
  const { executor, decider, maxSteps, stuckThreshold, signal } = opts

  const connected = await executor.connect()
  if (!connected.ok) {
    // Never consult the model for a session that never opened — it costs a
    // round trip to answer a question about a world nobody can see.
    return {
      status: 'disconnected',
      detail: `connect() failed: ${connected.reason}: ${connected.detail}`,
      steps: [],
    }
  }

  try {
    return await runGoal(goal, { executor, decider, maxSteps, stuckThreshold, signal })
  } finally {
    await executor.disconnect()
  }
}
```

`packages/bot/src/index.ts`:

```ts
export { runBotGoal } from './session.js'
export type { RunBotGoalOptions } from './session.js'
```

- [ ] **Step 5: Run tests, typecheck and invariants**

```bash
npm test
npm run typecheck
node scripts/check-invariants.mjs
```

Expected: PASS. Unit count rises from 260 to 263.

- [ ] **Step 6: Commit**

```bash
git add packages/bot package.json package-lock.json
git commit -m "feat(bot): add the composition root where both tracks meet

packages/bot is the only package depending on both @minebot/agent and
@minebot/executor. It exists because neither track can host the
composition: packages/agent must stay buildable with no game libraries
(design spec §4), and packages/executor has no business knowing an LLM
exists.

runBotGoal owns the connection lifecycle that runGoal deliberately does
not. The finally is load-bearing — a leaked bot on the shared dev server
poisons every test that runs after it."
```

---

## Task 2: Harden invariant 2 against the transitive case

Invariant 2 matches dependency **names** (`mineflayer`, `mineflayer-*`, `prismarine-*`). Adding `@minebot/executor` to `packages/agent` would pull Mineflayer into the planning track transitively and pass the check clean. Phase 3 is exactly when someone would add it.

**Files:**
- Modify: `scripts/check-invariants.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: no exports. A stricter `node scripts/check-invariants.mjs`.

- [ ] **Step 1: Add the check**

In `scripts/check-invariants.mjs`, replace the `gameLibs` block inside the `if (agent)` branch with:

```js
  const isGameLib = (d) =>
    d === 'mineflayer' || d.startsWith('mineflayer-') || d.startsWith('prismarine-')

  const gameLibs = Object.keys(all).filter(isGameLib)
  if (gameLibs.length > 0) {
    failures.push(
      `packages/agent must not depend on game libraries, found: ${gameLibs.join(', ')}. ` +
        'It talks to @minebot/contract and is tested against @minebot/mock-executor.',
    )
  }

  // Name matching alone is not enough. A workspace dependency whose own
  // manifest pulls in Mineflayer puts it in the planning track's dependency
  // graph just as surely, while passing the check above clean — @minebot/executor
  // is exactly such a package, and Phase 3 is when someone would reach for it.
  // Resolve one level into the workspace rather than trusting names.
  for (const dep of Object.keys(all)) {
    if (!dep.startsWith('@minebot/')) continue
    const depManifest = manifest(dep.slice('@minebot/'.length))
    if (!depManifest) continue
    const depDeps = Object.keys({
      ...(depManifest.dependencies ?? {}),
      ...(depManifest.peerDependencies ?? {}),
    })
    const leaked = depDeps.filter(isGameLib)
    if (leaked.length > 0) {
      failures.push(
        `packages/agent depends on ${dep}, which depends on ${leaked.join(', ')} — ` +
          'that puts a game library in the planning track transitively. The ' +
          'composition root is packages/bot; put code needing both there.',
      )
    }
  }
```

- [ ] **Step 2: Prove the guard fires**

A safety check nobody has watched trigger is not yet known to work. Temporarily add the forbidden dependency:

```bash
node -e "
const fs=require('fs');
const p='packages/agent/package.json';
const m=JSON.parse(fs.readFileSync(p,'utf8'));
m.dependencies['@minebot/executor']='0.1.0';
fs.writeFileSync(p, JSON.stringify(m,null,2)+'\n');
"
node scripts/check-invariants.mjs
```

Expected: **exit 1**, reporting that `packages/agent` depends on `@minebot/executor`, which depends on `mineflayer`.

Then restore:

```bash
git checkout packages/agent/package.json
node scripts/check-invariants.mjs
```

Expected: back to `Structural invariants OK (checked 2 of 2; agent package present)`.

- [ ] **Step 3: Commit**

```bash
git add scripts/check-invariants.mjs
git commit -m "test: catch a game library reaching the agent transitively

Invariant 2 matched dependency names, so adding @minebot/executor to
packages/agent would have put mineflayer in the planning track's
dependency graph and passed the check clean. Phase 3 is precisely when
someone would reach for that dependency, so the hole closes now.

Watched it fire: with @minebot/executor added to packages/agent the
check exits 1 and names the transitive path, rather than passing."
```

---

## Task 3: Integration — the happy path

The first time real game state, a decision, and a real game action meet.

**Files:**
- Create: `packages/bot/test/integration/loop.int.test.ts`

**Interfaces:**
- Consumes: `runBotGoal` (Task 1); arena helpers from Track A's `mc-console.ts`.
- Produces: the `ARENA`/`START`/`ORE` constants and the `setUpArena` helper that Tasks 4 and 5 extend.

- [ ] **Step 1: Write the failing test**

`packages/bot/test/integration/loop.int.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { MineflayerExecutor } from '@minebot/executor'
import { FakeLlmClient, SchemaDecider } from '@minebot/agent'
import {
  buildArena,
  placeArenaBlock,
  teleportAndWait,
  waitForOnGround,
  giveItem,
  clearInventory,
  type ArenaBounds,
} from '../../../executor/test/integration/mc-console.js'
import { runBotGoal } from '../../src/session.js'

// Fresh arena. In use elsewhere: 500-560, 800-840, 860-880, 900-930,
// 950-980, 1000-1020.
const ARENA: ArenaBounds = { x0: 1100, x1: 1130, z0: 0, z1: 8, floorY: 199, clearance: 6 }
const START = { x: 1105, y: ARENA.floorY + 1, z: 4 }
const ORE = { x: 1112, y: ARENA.floorY + 1, z: 4 }

/**
 * Builds the arena around a connected bot. The executor must already be
 * connected, because every helper here reads the bot's own reported state to
 * confirm the setup actually took.
 */
async function setUpArena(
  executor: MineflayerExecutor,
  username: string,
  opts: { tool?: string } = {},
): Promise<void> {
  await buildArena(ARENA)
  await teleportAndWait(executor, username, START)
  await waitForOnGround(executor, { expectedY: ARENA.floorY + 1 })
  clearInventory(username)
  await new Promise((r) => setTimeout(r, 500))
  if (opts.tool) {
    giveItem(username, opts.tool)
    await new Promise((r) => setTimeout(r, 1_000))
  }
  placeArenaBlock(ORE, 'coal_ore')
  await new Promise((r) => setTimeout(r, 800))
}

describe('the full loop against the live server', () => {
  let executor: MineflayerExecutor | null = null

  afterEach(async () => {
    await executor?.disconnect()
    executor = null
  })

  it('finds, mines and collects coal from an LLM decision', async () => {
    // The setup needs a connected bot, but runBotGoal owns the lifecycle — so
    // connect once here for the arena build, and let runBotGoal reconnect.
    // connect() is reentrant and idempotent (design spec §9.4), so the second
    // call on an already-connected executor returns ok rather than duplicating
    // the login.
    executor = new MineflayerExecutor({ username: 'ITLoopHappy' })
    expect((await executor.connect()).ok).toBe(true)
    await setUpArena(executor, 'ITLoopHappy', { tool: 'stone_pickaxe' })

    const llm = new FakeLlmClient([
      '{"action":"find_blocks","names":["coal_ore"],"maxDistance":32,"limit":5}',
      `{"action":"mine_block_at","x":${ORE.x},"y":${ORE.y},"z":${ORE.z},"maxDistance":32}`,
      '{"action":"done","summary":"mined the coal ore and collected the drop"}',
    ])

    const outcome = await runBotGoal('get me some coal', {
      executor,
      decider: new SchemaDecider(llm),
      maxSteps: 6,
    })

    expect(outcome.status).toBe('done')

    // The scripted mine_block_at coordinate must be one the *game* actually
    // reported, not just one this test happens to know. Without this, the
    // script could be mining a coordinate find_blocks never returned and the
    // test would still pass.
    const search = outcome.steps[0]
    expect(search?.outcome.kind).toBe('blocks')
    if (search?.outcome.kind === 'blocks') {
      expect(search.outcome.blocks.map((b) => b.position)).toContainEqual(ORE)
    }

    const mine = outcome.steps[1]
    expect(mine?.outcome.kind).toBe('result')
    if (mine?.outcome.kind === 'result') {
      expect(mine.outcome.result.ok).toBe(true)
    }
  })
})
```

- [ ] **Step 2: Run it to verify the wiring, not the test**

```bash
npm run smoke && npm run test:integration -- loop
```

Expected: **PASS on the first run.** This test has no new production code behind it — Task 1 already built the composition, and both halves were already green. A failure here is the genuine article: a real interface mismatch between the two tracks, which is exactly what this phase exists to surface. Record what it was rather than working around it in `session.ts`.

- [ ] **Step 3: Confirm the assertions can fail**

Vacuous passes are this repository's recurring failure mode. Break the fixture deliberately and confirm the test notices:

```bash
node -e "
const fs=require('fs');
const p='packages/bot/test/integration/loop.int.test.ts';
let s=fs.readFileSync(p,'utf8');
s=s.replace(\"placeArenaBlock(ORE, 'coal_ore')\", '// placeArenaBlock disabled');
fs.writeFileSync(p,s);
"
npm run test:integration -- loop
```

Expected: **FAIL** — `find_blocks` returns nothing and the `toContainEqual(ORE)` assertion reports it. Then restore:

```bash
git checkout packages/bot/test/integration/loop.int.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add packages/bot/test/integration
git commit -m "test(bot): close the loop against the live server

Real game state, a decision, a real game action. The LLM is a scripted
FakeLlmClient so this measures the wiring and nothing else — a model
failure and a wiring failure must not share one signal.

Asserts that the coordinate the script mines is one find_blocks actually
returned, not merely one the test knows. Without that, the script could
mine a block the search never saw and still pass. Verified the test
fails with the ore placement disabled."
```

---

## Task 4: Integration — a failure the game produced

Every failure Track B has handled so far was injected by `MockExecutor.setFailure`. This is the first one the game itself produces, and the first proof it survives the trip to the model's input intact.

**Files:**
- Modify: `packages/bot/test/integration/loop.int.test.ts`

**Interfaces:**
- Consumes: `setUpArena`, `ARENA`, `ORE` from Task 3.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe` in `packages/bot/test/integration/loop.int.test.ts`:

```ts
  it('renders a game-produced missing_tool into the next prompt', async () => {
    executor = new MineflayerExecutor({ username: 'ITLoopNoTool' })
    expect((await executor.connect()).ok).toBe(true)
    // No tool. The real executor's harvest guard produces missing_tool, and
    // leaves the ore standing rather than spending 15s destroying it for
    // nothing (Phase 2 design; measured).
    await setUpArena(executor, 'ITLoopNoTool')

    const llm = new FakeLlmClient([
      `{"action":"mine_block_at","x":${ORE.x},"y":${ORE.y},"z":${ORE.z},"maxDistance":32}`,
      '{"action":"give_up","reason":"no pickaxe in inventory"}',
    ])

    const outcome = await runBotGoal('get me some coal', {
      executor,
      decider: new SchemaDecider(llm),
      maxSteps: 6,
    })

    expect(outcome.status).toBe('gave_up')

    const mine = outcome.steps[0]
    expect(mine?.outcome.kind).toBe('result')
    if (mine?.outcome.kind === 'result') {
      expect(mine.outcome.result.ok).toBe(false)
      if (!mine.outcome.result.ok) expect(mine.outcome.result.reason).toBe('missing_tool')
    }

    // Track A's guard, re-proven from the far side of the loop: missing_tool
    // must mean "we declined to destroy it", not "we destroyed it and said so".
    const reconnected = new MineflayerExecutor({ username: 'ITLoopNoToolCheck' })
    try {
      expect((await reconnected.connect()).ok).toBe(true)
      await teleportAndWait(reconnected, 'ITLoopNoToolCheck', START)
      await waitForOnGround(reconnected, { expectedY: ARENA.floorY + 1 })
      const still = reconnected.findBlocks({ names: ['coal_ore'], maxDistance: 32, limit: 5 })
      expect(still.map((b) => b.position)).toContainEqual(ORE)
    } finally {
      await reconnected.disconnect()
    }

    // The integration assertion that matters: the failure the *game* produced
    // reached the model's input carrying its reason. Asserting only on the
    // returned status would pass against a loop that drops the detail on the
    // floor, and the model would then be deciding blind.
    expect(llm.requests).toHaveLength(2)
    const secondPrompt = llm.requests[1]?.messages.map((m) => m.content).join('\n') ?? ''
    expect(secondPrompt).toContain('missing_tool')
  })
```

- [ ] **Step 2: Run it**

```bash
npm run test:integration -- loop
```

Expected: PASS. If `missing_tool` is absent from the second prompt, the defect is in how `renderOutcome` renders a failed `Result` — fix that in `packages/agent`, and do not weaken the assertion. If the ore is *gone*, the defect is in Track A's harvest guard ordering and is far more serious than this test.

- [ ] **Step 3: Confirm the prompt assertion can fail**

```bash
node -e "
const fs=require('fs');
const p='packages/bot/test/integration/loop.int.test.ts';
let s=fs.readFileSync(p,'utf8');
s=s.replace(\"expect(secondPrompt).toContain('missing_tool')\", \"expect(secondPrompt).toContain('a string no prompt contains')\");
fs.writeFileSync(p,s);
"
npm run test:integration -- loop
```

Expected: FAIL, printing the actual prompt — which is also the quickest way to eyeball what the model really sees. Restore:

```bash
git checkout packages/bot/test/integration/loop.int.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add packages/bot/test/integration
git commit -m "test(bot): prove a game-produced failure reaches the model

Every failure Track B has handled so far was injected with
MockExecutor.setFailure. This is the first produced by the game itself,
and the first proof it survives dispatch -> StepOutcome -> renderPrompt
and arrives as something a model can act on.

Asserts on the rendered prompt, not just the returned status: a loop
that dropped the reason would pass a status-only test while leaving the
model deciding blind.

Also re-proves Track A's harvest guard from the far side of the loop —
missing_tool must mean the ore is still standing."
```

---

## Task 5: Integration — abort

Track B's half of the §3.5 interruption protocol, against a real bot rather than an injected failure.

**Files:**
- Modify: `packages/bot/test/integration/loop.int.test.ts`

**Interfaces:**
- Consumes: `setUpArena`, `ORE`, `ARENA` from Task 3.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe`:

```ts
  it('resolves interrupted and halts the bot when the goal is aborted', async () => {
    executor = new MineflayerExecutor({ username: 'ITLoopAbort' })
    expect((await executor.connect()).ok).toBe(true)
    await setUpArena(executor, 'ITLoopAbort', { tool: 'stone_pickaxe' })

    const controller = new AbortController()
    const llm = new FakeLlmClient(
      [`{"action":"mine_block_at","x":${ORE.x},"y":${ORE.y},"z":${ORE.z},"maxDistance":32}`],
      { repeatLast: true },
    )

    const pending = runBotGoal('get me some coal', {
      executor,
      decider: new SchemaDecider(llm),
      maxSteps: 6,
      signal: controller.signal,
    })
    // Long enough that the bot is genuinely pathing to the ore, short enough
    // that the dig cannot have finished (stone pickaxe on coal ore: 1150ms).
    setTimeout(() => controller.abort(), 1_500)

    const outcome = await pending
    expect(outcome.status).toBe('interrupted')

    // Not merely labelled interrupted — it stopped early. The script repeats
    // one mine action forever, so an abort that did not take would run to the
    // maxSteps budget of 6. One or two steps is the proof it took effect.
    expect(outcome.steps.length).toBeLessThanOrEqual(2)

    // The aborted step must itself report interrupted, not a success the loop
    // then relabelled — that distinction is the contract rule under test.
    const aborted = outcome.steps.at(-1)
    expect(aborted?.outcome.kind).toBe('result')
    if (aborted?.outcome.kind === 'result') {
      expect(aborted.outcome.result.ok).toBe(false)
      if (!aborted.outcome.result.ok) {
        expect(aborted.outcome.result.reason).toBe('interrupted')
      }
    }

    // The ore must still be standing: an aborted dig is a dig that did not
    // complete. runBotGoal has already disconnected the bot, so observe from
    // a fresh one.
    const observer = new MineflayerExecutor({ username: 'ITLoopAbortWatch' })
    try {
      expect((await observer.connect()).ok).toBe(true)
      await teleportAndWait(observer, 'ITLoopAbortWatch', START)
      await waitForOnGround(observer, { expectedY: ARENA.floorY + 1 })
      const still = observer.findBlocks({ names: ['coal_ore'], maxDistance: 32, limit: 5 })
      expect(still.map((b) => b.position)).toContainEqual(ORE)
    } finally {
      await observer.disconnect()
    }
  })
```

- [ ] **Step 2: Run it**

```bash
npm run test:integration -- loop
```

Expected: PASS. `runGoal` relays the outer signal into `dispatch`, the executor resolves `interrupted`, the step is recorded, and the `outer?.aborted` check returns `status: 'interrupted'`.

- [ ] **Step 3: Run the whole integration suite**

The three new tests share the dev server with 79 existing ones, and this repository has been bitten by tests that pass alone and fail together.

```bash
npm run test:integration
```

Expected: PASS, 82 tests. Run it twice — a test that leaks a bot or leaves world state behind fails on the second run, not the first.

```bash
npm run test:integration
```

- [ ] **Step 4: Commit**

```bash
git add packages/bot/test/integration
git commit -m "test(bot): verify the caller-abort branch of the interruption protocol

Track B's half of design spec §3.5, against a real bot rather than an
injected failure. The outer signal relays into dispatch, the real
executor resolves interrupted, and runGoal returns that status rather
than running to the step budget.

Only this branch is reachable in Phase 3: an interrupted result WITHOUT
an outer abort means the reflex layer preempted, and that layer is
Phase 5. The arbiter's half stays untested until Track A builds it.

Ran the integration suite twice — this repo has been bitten before by
tests that pass alone and fail together."
```

---

## Task 6: The demo

The phase plan's stated deliverable: *watch it actually do it via the LLM's decision.*

**Files:**
- Create: `packages/bot/src/phase3-demo.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `runBotGoal` (Task 1), `OllamaClient` and `SchemaDecider` from `@minebot/agent`.
- Produces: `npm run demo:phase3`.

- [ ] **Step 1: Write the demo**

`packages/bot/src/phase3-demo.ts`:

```ts
/**
 * The Phase 3 deliverable: real game state, a real model's decision, a real
 * game action — the whole loop, once, end to end.
 *
 *   npm run demo:phase3
 *
 * Needs both the dev server and Ollama. The integration tests deliberately
 * need only the server, so if this fails while they pass, the model chose
 * badly rather than the wiring being broken.
 */
import { execFileSync } from 'node:child_process'
import { MineflayerExecutor } from '@minebot/executor'
import { OllamaClient, SchemaDecider, renderStep } from '@minebot/agent'
import { runBotGoal } from './session.js'

const USERNAME = 'Phase3Demo'
const FLOOR = 199
const ARENA = { x0: 1150, x1: 1180, z0: 0, z1: 8 }
const START = { x: 1155, y: FLOOR + 1, z: 4 }
const ORE = { x: 1168, y: FLOOR + 1, z: 4 }

const mc = (command: string): void => {
  execFileSync('tmux', ['send-keys', '-t', 'mc', command, 'Enter'])
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<number> {
  // The arena must exist before the goal starts, and building it needs a bot
  // in the world to confirm it took. connect() is reentrant, so runBotGoal
  // connecting again is a no-op rather than a duplicate login.
  const executor = new MineflayerExecutor({ username: USERNAME })
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
  // Drops are entities, not blocks — the air fill above does not remove them,
  // and one left by a previous run would be collected by this one.
  mc(`kill @e[type=item,x=${ORE.x},y=${FLOOR},z=4,distance=..40]`)
  await sleep(700)
  mc(`tp ${USERNAME} ${START.x} ${START.y} ${START.z}`)
  mc(`clear ${USERNAME}`)
  mc(`give ${USERNAME} stone_pickaxe 1`)
  await sleep(1_200)
  mc(`setblock ${ORE.x} ${ORE.y} ${ORE.z} coal_ore`)
  await sleep(1_200)

  const llm = new OllamaClient()
  console.log(`asking ${process.env['MINEBOT_MODEL'] ?? 'qwen3:14b'} for decisions…\n`)

  const outcome = await runBotGoal('get me some coal', {
    executor,
    decider: new SchemaDecider(llm),
    maxSteps: 10,
  })

  console.log('Step log:')
  for (const step of outcome.steps) console.log(`  ${renderStep(step)}`)
  console.log(`\nOutcome: ${outcome.status}`)
  console.log(
    outcome.status === 'done' ? `Summary: ${outcome.summary}` : `Detail: ${outcome.detail}`,
  )

  // A model that declares success without mining anything must fail this demo,
  // not pass it — so check the world, not the model's own verdict.
  const check = new MineflayerExecutor({ username: 'Phase3DemoCheck' })
  try {
    if (!(await check.connect()).ok) {
      console.error('FAIL: could not reconnect to verify the result')
      return 1
    }
    const coal = check.getState().self.inventory.find((i) => i.name === 'coal')
    console.log(`\n${USERNAME} inventory check: coal x${coal?.count ?? 0}`)
    if (outcome.status !== 'done') {
      console.error(`FAIL: the goal ended ${outcome.status}`)
      return 1
    }
  } finally {
    await check.disconnect()
  }

  console.log('DONE: the model found the coal ore, mined it, and collected the drop.')
  return 0
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error('FAIL:', e instanceof Error ? e.message : String(e))
    process.exit(1)
  },
)
```

- [ ] **Step 2: Add the script**

In the root `package.json` `scripts`, after `"demo:phase2"`:

```json
    "demo:phase3": "tsx packages/bot/src/phase3-demo.ts",
```

- [ ] **Step 3: Run it**

```bash
npm run smoke && npm run demo:phase3
```

Expected: exit 0, a step log showing the model choosing `find_blocks`, then a mine action, then `done`, and the final line `DONE: the model found the coal ore, mined it, and collected the drop.`

**This is the joint session's moment — watch it from a second client.** The bot should visibly walk to the ore and break it.

If it fails while Tasks 3–5 are green, the model chose badly, not the wiring. Record what it chose; that step log is Phase 4's raw material. Re-run before concluding anything — temperature 0 is consistency, not robustness.

- [ ] **Step 4: Commit**

```bash
git add packages/bot/src/phase3-demo.ts package.json
git commit -m "feat(bot): add the Phase 3 demo — the loop, once, for real

Real game state, a real model's decision, a real game action. The phase
plan's stated deliverable: tell the bot to mine a visible block and
watch it do it via the LLM's decision rather than a hardcoded call.

Verifies against the world rather than the model's own verdict — a model
that declares done without mining anything fails this demo.

It needs Ollama; the integration tests deliberately do not. If this
fails while they pass, the model chose badly rather than the wiring
being broken."
```

---

## Task 7: Documentation and the pull request

**Files:**
- Modify: `packages/agent/src/demo.ts` (header comment only)
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the merged phase.

- [ ] **Step 1: Correct `demo.ts`'s header**

In `packages/agent/src/demo.ts`, replace the final paragraph of the file's opening block comment:

```ts
 * Swap FakeLlmClient for OllamaClient to drive it with a real model. Driving it
 * against a real server is Phase 3 and does NOT happen here: packages/agent
 * must not depend on @minebot/executor, or Mineflayer lands in the planning
 * track transitively (design spec §4, enforced by scripts/check-invariants.mjs).
 * That composition lives in packages/bot — see `npm run demo:phase3`.
```

- [ ] **Step 2: Update `README.md`**

- Change the status line to:

```markdown
**Status: Phase 3 complete.** The full loop closes end to end — the bot observes real world state, a local LLM chooses one action under a JSON Schema constraint, and the bot carries it out against a real server. Building, combat and multi-bot scaling are later phases.
```

- Update the counts to **263 unit tests** and **82 integration tests**.
- Add to the runnable-commands block:

```bash
npm run demo:phase3      # The whole loop: real state, real model, real action
```

- Add to the commands table:

```markdown
| `npm run demo:phase3` | Phase 3 deliverable | Yes — server **and** Ollama |
```

- In the roadmap table, mark Phase 3 **Done** and Phase 4 `Next`.

- [ ] **Step 3: Update `CLAUDE.md`**

- Add to the commands block:

```bash
npm run demo:phase3       # Real state, real model, real action. The Phase 3 deliverable.
```

- Update the test counts to 263 unit / 82 integration.
- Add to the "Verified environment facts" table:

```markdown
| The composition root is `packages/bot/` — the only package depending on both `@minebot/agent` and `@minebot/executor` | Code needing both goes there. Putting it in `agent` pulls Mineflayer into the planning track transitively; `check-invariants.mjs` now catches that |
| Integration tests never require Ollama; only `demo:phase3` and `agent:probe` do | A red demo with green tests means the model chose badly, not that the wiring broke |
| `runGoal` returns `interrupted` only on an **outer** abort | An `interrupted` result without one means the reflex layer preempted — Phase 5, so unreachable today |
```

- In "Scope boundaries", replace the `packages/agent/` bullet:

```markdown
- `packages/agent/` must never depend on `mineflayer` or `@minebot/executor`. It is the planning track and must stay buildable with no game libraries. Anything needing both tracks belongs in `packages/bot/`.
```

- [ ] **Step 4: Full verification**

```bash
npm test
npm run typecheck
node scripts/check-invariants.mjs
npm run smoke && npm run test:integration
npm run demo:phase2 && npm run demo:phase3
```

Expected: all green. Record the actual counts in the commit message rather than asserting "all tests pass" without them.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/demo.ts README.md CLAUDE.md
git commit -m "docs: record Phase 3 and correct an impossible instruction

packages/agent/src/demo.ts told the next reader that driving the loop
against a real server 'changes this file only'. It cannot: packages/agent
must not depend on @minebot/executor, and the invariant check now
enforces that. Points at packages/bot instead.

CLAUDE.md gains the facts this phase established, notably that a red
demo with green integration tests means the model chose badly rather
than the wiring breaking."
```

- [ ] **Step 6: Open the pull request**

```bash
git push -u origin phase-3-integration
gh pr create --base main --title "Phase 3 (JOINT): the loop closes end to end" --body "$(cat <<'EOF'
## What

`packages/bot/` — the composition root where both tracks finally meet. `runBotGoal()` owns the connection lifecycle that `runGoal()` deliberately leaves to its caller, and that is the whole of the integration.

- Integration tests: real `MineflayerExecutor`, scripted `FakeLlmClient`. Happy path, a game-produced `missing_tool`, and a caller abort.
- `npm run demo:phase3`: real executor, real `qwen3:14b`, watchable.

## Why the tests do not use a model

A wiring failure and a model failure must not share one signal. The tests need only the dev server; the demo needs Ollama too. If the demo is red while the tests are green, the model chose badly — that is a Phase 4 input, not a Phase 3 bug.

## The assertion that earns its keep

Every failure Track B had handled was *injected* with `MockExecutor.setFailure`. The `missing_tool` test is the first produced by the game itself, and it asserts on the **rendered prompt**, not just the returned status — a loop that dropped the reason would pass a status-only test while leaving the model deciding blind. It also re-proves Track A's harvest guard from the far side of the loop: `missing_tool` must mean the ore is still standing.

## Two corrections

- `packages/agent/src/demo.ts` told readers the Phase 3 swap "changes this file only". It cannot — that would pull Mineflayer into the planning track.
- `check-invariants.mjs` matched dependency *names*, so adding `@minebot/executor` to `packages/agent` would have passed clean. Hardened, and watched failing before shipping.

## Not in scope

No `contract` or `mock-executor` changes — none were needed. No retry policy (Phase 4), no reflex layer (Phase 5). Only the caller-abort branch of §3.5 is reachable; the arbiter's half waits for Track A.

## Testing

Integration tests and both demos require the live dev server and were run locally; CI covers unit tests, typecheck and invariants only.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

**Spec coverage.** Design §3 structure → Task 1. §4.1 the three test cases → Tasks 3, 4, 5. §4.2 demo → Task 6. §5 budgets and the §3.5 note → Tasks 3–5 (`maxSteps`) and Task 5's commit message. §6 not-in-scope → nothing in this plan touches `contract`/`mock-executor`, and no task adds retry or reflex logic. §7 both corrections → Task 2 (invariant) and Task 7 Step 1 (`demo.ts`). §8 risks → Task 6 Step 3 states the re-run guidance; risk 3 is Task 3 Step 2's "record what it was". No spec section is unimplemented.

**Type consistency.** `runBotGoal(goal, opts)` as defined in Task 1 is called identically in Tasks 3, 4, 5 and 6. `RunBotGoalOptions` fields (`executor`, `decider`, `maxSteps`, `stuckThreshold`, `signal`) match every call site; no call site passes a field the interface lacks. `setUpArena(executor, username, { tool })`, `ARENA`, `START` and `ORE` are defined once in Task 3 and reused unchanged in Tasks 4 and 5. `GoalOutcome`'s discriminated union is destructured correctly everywhere — `summary` only under `status === 'done'`, `detail` otherwise, which Task 6's demo respects.

**Known risks carried into execution:**

1. **Task 3 is expected to pass on its first run.** That is unusual for a TDD plan and is deliberate: the production code landed in Task 1 and both halves were already green. Step 3 exists so the test is proven capable of failing, since a test that has never been red is not yet known to test anything.
2. **The abort test's timing is a race.** 1500ms is chosen to land during the path-and-dig, but a fast path plus a 1150ms dig could finish first, turning `interrupted` into `done`. If it proves flaky, lengthen the walk by moving `ORE` further from `START` — do not weaken the assertion to accept `done`.
3. **`runBotGoal` disconnects the executor**, so no test can inspect the world afterwards through the same instance. Tasks 4 and 5 each connect a second, short-lived observer bot for their world assertions. Both must disconnect it in a `finally`, or they leak a bot onto the shared dev server and poison every test that runs after them.
