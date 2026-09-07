# minebot

A tool-calling LLM agent that plays Minecraft as a bot — a "smarter NPC" that can navigate, mine, build from blueprints, fight or flee, and talk to players, all through one shared local model rather than a specialised model per behaviour.

**Status: Phase 1 complete.** The bot connects to a server, reports immutable world state, and walks to a coordinate under cancellable control. Mining, pathfinding, building and combat are later phases.

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
└── agent/           (not yet built) The LLM planning loop.
```

### `BotExecutor` — the contract

Both development tracks build against this one interface. Its three load-bearing properties:

- **Every action is cancellable.** Actions take an `AbortSignal`. On abort an implementation **resolves** `{ ok: false, reason: 'interrupted' }` — it must never throw. Interruption is an expected outcome, not an error, so callers are forced to handle it explicitly rather than lose it in a `catch`.
- **Failures are typed.** `Result<T>` is a discriminated union over nine closed reasons. `not_found` (search wider), `unreachable` (pick another target) and `interrupted` (resume later) are three different decisions, and the retry policy cannot be written without telling them apart.
- **Observation has two channels.** `getState()` returns an immutable, deep-frozen point-in-time snapshot for the planner to reason over; `on(event, handler)` is a push stream for the reflex layer, which needs to be *told* about damage rather than poll for it.

### The cross-implementation test suite

`runContractSuite` is a behavioural suite that runs against **any** `BotExecutor`. Both the mock and the real Mineflayer-backed executor must pass it, unmodified. That is what makes swapping the mock for the real implementation a verified step rather than a hopeful one — and it is why the mock can be developed against with no Minecraft server at all.

## Quickstart

**Requires Node 24+.**

```bash
npm install
npm test        # 168 unit tests — no network, no Minecraft needed
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
npm run test:integration # 37 tests against the live server
npm run demo             # Connect, print a snapshot, walk to a coordinate
```

**Pick an open biome.** Phase 1 movement is deliberately naive — look at the target, walk forward, jump when blocked. It has no answer to a tree. A jungle spawn leaves the bot with zero walkable blocks in any direction; open plains gives it 20+.

## Commands

| Command | What it does | Needs a server? |
|---|---|---|
| `npm test` | Unit tests | No |
| `npm run typecheck` | Whole-repo typecheck | No |
| `npm run test:integration` | Integration tests | Yes |
| `npm run smoke` | Minimal connect check | Yes |
| `npm run demo` | Phase 1 deliverable | Yes |

## Roadmap

| Phase | Scope | State |
|---|---|---|
| 1 | Connect, read state, walk to a coordinate | **Done** |
| 2 | Pathfinding + mining a known block | Next |
| 3 | Close the LLM loop once, end to end | |
| 4 | Reliable "find and mine coal" — search, retry, recovery | The bulk of the work |
| 5 | Full toolbox: building, follow, chat, reflex combat | |
| 6 | Multi-bot scaling against one shared model | |

## Documentation

- [Design spec](docs/superpowers/specs/2026-09-07-minecraft-agent-design.md) — the contract, structure, testing strategy, and **§9: contract changes awaiting agreement**
- [Phase 1 plan](docs/superpowers/plans/2026-09-07-phase-1-track-a.md) — task breakdown plus verified environment facts
- [Design notes](docs/notes/) — original architecture reasoning, phase plan, feasibility

Contributors and agents working in this repo should also read [CLAUDE.md](CLAUDE.md).
