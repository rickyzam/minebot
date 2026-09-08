# minebot

A tool-calling LLM agent that plays Minecraft as a bot — a "smarter NPC" that can navigate, mine, build from blueprints, fight or flee, and talk to players, all through one shared local model rather than a specialised model per behaviour.

**Status: Phase 2 complete, and the planning loop is built.** The bot connects to a server, reports immutable world state, paths around obstacles to a coordinate, and mines a block with the right tool and collects the drop — all under cancellable control. Separately, `packages/agent/` turns game state into an LLM decision and back into an action, tested against the mock and measured against a real model. Wiring the two together is Phase 3 and is not done yet. Building and combat are later phases.

## The core idea

Most published work on LLM game agents spends its difficulty budget on **perception** — turning pixels into "there's a tree 4 blocks northwest, partially occluded" — and that is the unreliable part, not the planning.

minebot skips it. A Minecraft bot library gives structured game telemetry directly: block coordinates, inventory contents, entity positions. What remains is much closer to classical game AI — pathfinding plus a task queue — with the LLM making only the high-level judgement calls.

### Three layers

| Layer | Runs | Job |
|---|---|---|
| **Reflex / safety** | Constantly, no LLM | Health checks, immediate danger. Always wins; can interrupt the current plan. |
| **LLM planning** | Periodically, or on state change | Picks the next goal or tool call given current state. |
| **Execution** | Plain code | Carries out whatever was decided, via Mineflayer. |

The split exists because LLM latency (multi-second) is fine for "decide to go mine coal" and actively wrong for "dodge this incoming hit." Survival-critical reactions belong in layer 1.

## Architecture

Four packages. The dependency direction is enforced structurally, not by convention — the agent package cannot import `mineflayer`, because it is not among its dependencies.

```
packages/
├── contract/        Types only, ZERO runtime dependencies.
│                    BotExecutor, Result<T>, WorldSnapshot, BotEvents.
├── mock-executor/   A BotExecutor test double + runContractSuite.
├── executor/        The real implementation over Mineflayer.
└── agent/           The LLM planning loop. Deps: contract, mock-executor.
```

### `BotExecutor` — the contract

Both development tracks build against this one interface. Its three load-bearing properties:

- **Every action is cancellable.** Actions take an `AbortSignal`. On abort an implementation **resolves** `{ ok: false, reason: 'interrupted' }` — it must never throw. Interruption is an expected outcome, not an error, so callers are forced to handle it explicitly rather than lose it in a `catch`.
- **Failures are typed.** `Result<T>` is a discriminated union over nine closed reasons. `not_found` (search wider), `unreachable` (pick another target) and `interrupted` (resume later) are three different decisions, and the retry policy cannot be written without telling them apart.
- **Observation has two channels.** `getState()` returns an immutable, deep-frozen point-in-time snapshot for the planner to reason over; `on(event, handler)` is a push stream for the reflex layer, which needs to be *told* about damage rather than poll for it.

### The planning loop

`packages/agent/` decides what the bot does next. Each turn it takes a
`WorldSnapshot`, renders it into a prompt with a bounded history of what just
happened, asks a local model for exactly one action under a JSON Schema
constraint, validates the reply, and dispatches it through `BotExecutor`.

Three properties are worth knowing:

- **It never opens a socket in tests.** The model sits behind an `LlmClient`
  interface and every test uses a scripted fake, the same way every test uses
  `MockExecutor` instead of a Minecraft server.
- **It codes no retry policy.** Failures — with their `FailureReason` and
  detail — are rendered into the next prompt and the model decides. The only
  hardcoded guards are a step budget and a repetition check. Phase 4 writes the
  real policy against the step logs this produces.
- **Prompt changes are measured, not assumed.** `npm run agent:probe` runs five
  scenarios against a real model and reports what it chose. This caught two
  defects that every unit test passed straight through, and established that the
  system-rules block outweighs the action menu for guidance about *when* to
  choose something.

### The cross-implementation test suite

`runContractSuite` is a behavioural suite that runs against **any** `BotExecutor`. Both the mock and the real Mineflayer-backed executor must pass it, unmodified. That is what makes swapping the mock for the real implementation a verified step rather than a hopeful one — and it is why the mock can be developed against with no Minecraft server at all.

## Quickstart

**Requires Node 24+.**

```bash
npm install
npm test        # 260 unit tests — no network, no Minecraft, no model
npm run typecheck
```

That is the whole loop for anything that does not touch the game.

### Running against Minecraft

The integration tests and the demo need a **dedicated development server**. Do not point them at a server you care about: the bot breaks blocks, dies, and the tests build a stone platform.

1. Set up a Fabric **1.21.10** server in its own directory.
2. In `server.properties`:

   | Setting | Value | Why |
   |---|---|---|
   | `online-mode` | `false` | Bots have no Microsoft account. Never flip an existing world to this — it rewrites player UUIDs and can orphan inventories. |
   | `enforce-secure-profile` | `false` | Offline clients have no signed chat key. |
   | `gamemode` | `survival` | Creative produces **no block drops**, so mining cannot be verified. |
   | `difficulty` | `peaceful` | Nothing attacks the bot while combat is unimplemented. |
   | `allow-flight` | `true` | Avoids spurious anti-cheat kicks during movement. |
   | `pause-when-empty-seconds` | `0` | Otherwise the world stops ticking between runs. |
   | `level-seed` | fixed | Reproducibility. Prefer a spawn in open terrain — see below. |

3. Leave the server on port **25565** if you are not using a proxy, and pass `{ port: 25565 }` to `MineflayerExecutor` — the library defaults to **25566**, the backend port used behind Velocity (step 5).
4. **Mods are supported — you do not need to strip them.** A mod that registers content (map mods especially) makes a Fabric server reject a plain vanilla-protocol client, which is exactly what a Mineflayer bot is. The executor completes Fabric's registry-sync handshake, so it connects anyway, and it learns the modded registry ids rather than guessing at them. This is on by default (`fabricCompat`) and is inert against a vanilla server. Adding another mod needs no code change.
5. Run the server inside `tmux` under the session name `mc`. The integration tests drive its console to build a deterministic test arena.
6. **Optional but recommended: put a Velocity proxy in front.** It lets players authenticate against Mojang and keep their real UUIDs — so no inventories or advancements are orphaned — while the bots connect to the backend directly for free. See [docs/velocity-proxy-setup.md](docs/velocity-proxy-setup.md). With a proxy, the backend moves to port 25566, which is `MineflayerExecutor`'s default.

Then:

```bash
npm run smoke            # Does a bot connect at all?
npm run test:integration # 82 tests against the live server
npm run demo             # Connect, print a snapshot, walk to a coordinate
npm run demo:phase2      # Path around a wall, mine coal ore, collect the drop
npm run demo:phase3      # The whole loop: real state, real model, real action
```

**Biome no longer matters much.** Phase 1's movement was deliberately naive — look at the target, walk forward, jump when blocked — and had no answer to a tree. Phase 2 replaced it with `mineflayer-pathfinder`, which routes around obstacles, so a jungle spawn is now workable rather than a dead stop. Movement is non-destructive by design (`canDig` is off), so terrain the bot cannot climb or walk around still reports `unreachable`.

## Commands

| Command | What it does | Needs a server? |
|---|---|---|
| `npm test` | Unit tests | No |
| `npm run typecheck` | Whole-repo typecheck | No |
| `npm run test:integration` | Integration tests | Yes |
| `npm run smoke` | Minimal connect check | Yes |
| `npm run demo` | Phase 1 deliverable | Yes |
| `npm run demo:phase2` | Phase 2 deliverable | Yes |
| `npm run demo:phase3` | Phase 3 deliverable | Yes — server **and** Ollama |
| `npm run agent:demo` | Track B deliverable: the loop against a fake model and a mock world | No |
| `npm run agent:probe` | Ask a real model for one action across five scenarios; report what it chose | No (needs Ollama) |

## Roadmap

| Phase | Scope | State |
|---|---|---|
| 1 | Connect, read state, walk to a coordinate | **Done** |
| 2 | Pathfinding + mining a known block | **Done** |
| 3 | Close the LLM loop once, end to end | **Done** |
| 4 | Reliable "find and mine coal" — search, retry, recovery | Next — the bulk of the work |
| 5 | Full toolbox: building, follow, chat, reflex combat | |
| 6 | Multi-bot scaling against one shared model | |

Track B's planning loop is built, tested against the mock, and measured against
`qwen3:14b`. Phase 3 is the swap, and with Phase 2 complete nothing blocks it.

## Documentation

- [Design spec](docs/superpowers/specs/2026-09-07-minecraft-agent-design.md) — the contract, structure, testing strategy, and **§9: contract changes awaiting agreement**
- [Phase 1 plan](docs/superpowers/plans/2026-09-07-phase-1-track-a.md) — task breakdown plus verified environment facts
- [Phase 2 design](docs/superpowers/specs/2026-09-07-phase-2-pathfinding-and-mining-design.md) and [plan](docs/superpowers/plans/2026-09-07-phase-2-track-a.md) — pathfinding and mining, with the measurements that shaped them
- [Design notes](docs/notes/) — original architecture reasoning, phase plan, feasibility

Contributors and agents working in this repo should also read [CLAUDE.md](CLAUDE.md).
