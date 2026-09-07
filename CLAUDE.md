# CLAUDE.md

Guidance for Claude Code working in this repository. Read [README.md](README.md) for what the project is; this file is about how to work in it without stepping on rakes.

## Read first

- [Design spec](docs/superpowers/specs/2026-09-07-minecraft-agent-design.md) — the binding authority. §3 explains why `BotExecutor` is shaped as it is; §9 records the four contract changes that were agreed with Track B and **applied** at the start of Phase 2. There are no outstanding agreed-pending changes — but the rule that produced that list still stands: see "The one rule that matters" below.
- [Phase 2 design](docs/superpowers/specs/2026-09-07-phase-2-pathfinding-and-mining-design.md) — pathfinding and mining. Its §2 table is measurements against the live server, and three of them contradict the obvious assumption.
- [Phase 1 plan](docs/superpowers/plans/2026-09-07-phase-1-track-a.md) — its "Verified environment facts" block is measurements, not assumptions.

## Commands

```bash
npm test                  # 168 unit tests. No network. Fast. Run these constantly.
npm run typecheck         # Whole repo, including scripts/.
npm run test:integration  # 61 tests. Requires the live dev server.
npm run smoke             # Minimal "can a bot connect at all" check.
npm run demo              # Connect, print snapshot, walk. The Phase 1 deliverable.
```

When an integration test fails, run `npm run smoke` first. It separates "my code is broken" from "the server is unreachable," and that distinction saves a lot of wasted debugging.

## The one rule that matters

**`packages/contract/` and `packages/mock-executor/` are a shared surface.** A second developer builds the LLM planning loop against them, with no Minecraft server. Changing a type, a method signature, or a documented guarantee there is a change to the integration boundary between two people's work.

Do not change them to make something convenient. Additive changes still need agreement — spec §9 records four that were held back until Track B agreed, then applied together as one unit.

The corollary: **never weaken `runContractSuite` to make an implementation pass.** That suite is the entire mechanism by which the mock-to-real swap is verified. If the real executor fails an assertion, fix the executor. A suite bent to fit its implementations verifies nothing.

## Verified environment facts

These cost real debugging time to discover. Treat them as settled.

| Fact | Consequence |
|---|---|
| `bot.health` and `bot.food` are `undefined` at the `spawn` event, populating ~100ms later on the first health packet | `connect()` must wait, or every snapshot taken right after connecting reports health 0 |
| World chunks finish loading **~450ms after** the first health packet | `connect()` also awaits `waitForChunksToLoad()`, best-effort. Without it, any block search immediately after connecting returns empty |
| `bot.version` reports `'1.21.9'` for a requested `'1.21.10'` — both map to protocol 773 | Never assert on it |
| Player spawn position varies between runs, and between generations of the **same seed** | Never hard-code a spawn coordinate or assume a run starts where the last one ended |
| `bot.game.dimension` is `'overworld'`, not `'minecraft:overworld'` | |
| `bot.entities` includes the bot's **own** entity | `toSnapshot` filters it out; anything reading raw Mineflayer entities must too |
| `bot.entity.isCollidedHorizontally` is real at runtime but missing from `prismarine-entity`'s `.d.ts` | Needs a narrow cast |
| Mineflayer's `findBlocks` sorts by distance from the **floored** origin | The executor re-sorts by exact distance to match what it reports |
| A Fabric server running any content-registering mod rejects a plain Mineflayer client: *"This server requires Fabric Loader and Fabric API installed on your client!"* | Not a Mineflayer limitation — the client is kicked for never answering, not for failing a check. `installFabricHandshake` fixes it |
| Fabric's `canSend` is satisfied purely by advertising the channel via `minecraft:register` in the **configuration** phase | Advertise before spawn; registering later misses the window |
| The `fabric:registry/sync/direct` payload is chunked, terminated by a **zero-length** chunk | Acknowledge once, on the terminator. Acknowledging a chunk ends Fabric's task early and the next reply kills the connection with `Unexpected request for task finish, current task: synchronize_registries` |
| Modded registry ids are appended **after** vanilla and delta-encoded, so vanilla ids do not move | Measured with a mod loaded: `coal` stayed 896, `stone_pickaxe` stayed 923. `minecraft-data` stays valid |
| The sync payload is zero-padded to the chunk size | Decode to the declared structure, not to the end of the buffer |
| nmp logs a non-fatal `partial packet` warning for packets carrying a **modded data component** | Expected, not a bug in our code. Unknown component codecs cannot be decoded; the bot degrades rather than failing |
| The Velocity backend rejects unforwarded logins: *"This server requires you to connect with Velocity."* | Bots must sign a forwarding payload. `installVelocityForwarding` does it; the secret is shared with the proxy |
| **node-minecraft-protocol already answers `login_plugin_request`** with "not understood" | Adding a second handler sends two responses for one message id and the server kicks with `Unexpected custom data from client`. Displace nmp's handler, do not stack on it |
| A **wrong** secret kicks with `Unable to verify player details`; **no** forwarding kicks with `This server requires you to connect with Velocity` | Two distinct failures. `Secret check failed.` is only a server-side log line and never reaches the client |
| The backend advertises forwarding version **4**, but version **1** is accepted | Later versions only add a Mojang public key, which a bot does not have |
| Bot UUIDs are the offline-mode ones (`MD5("OfflinePlayer:<name>")`, v3) | Deliberate: a bot's identity and player data survive the proxy being added or removed |
| `/fill` silently refuses unloaded chunks with "That position is not loaded" | The test arena is `forceload`ed. This bug once made every test pass against a freefalling bot |

## The dev server

Two processes, two tmux sessions:

| | Port | Session | Notes |
|---|---|---|---|
| **Velocity proxy** | `0.0.0.0:25565` | `velocity` | `online-mode=true` — real Mojang auth. Where **people** connect |
| **Fabric backend** | `127.0.0.1:25566` | `mc` | 1.21.10, offline mode, survival + peaceful. Loopback only, so unreachable from the network |

Players authenticate at the proxy and are forwarded to the backend with their
**real Mojang UUID**, so inventories and advancements are keyed to the same
identity they would have on an online-mode server. The backend rejects anything
that cannot present forwarding data signed with the shared secret.

Bots have no Mojang account, so they connect **directly to the backend on 25566**
and sign their own forwarding payload — hence `MineflayerExecutor`'s default port
is 25566, not 25565. See [`velocity-forwarding.ts`](packages/executor/src/velocity-forwarding.ts).

The secret lives at `~/minecraft/velocity/forwarding.secret`, outside this repo,
and is read via `resolveForwardingSecret()` (env `VELOCITY_FORWARDING_SECRET`
first, then that file). **Never commit it** — `.gitignore` covers `*.secret`.

- **Do not stop, restart, or reconfigure either without asking.** Someone may be logged in, and both are shared state outside the repo.
- Drive its console with `tmux send-keys -t mc '<command>' Enter`. This is how integration tests build reproducible scenarios.
- Use `stop` for shutdown, never `kill` — the world needs to flush.
- Mods are supported. A mod that registers content makes the server reject a *plain* Mineflayer client, but the executor completes Fabric's registry-sync handshake, so it connects anyway — see [`fabric-registry.ts`](packages/executor/src/fabric-registry.ts). Currently loaded: `fabric-api`, `nitwitmap` (adds an item), `fabrictailor` (skins, server-side only).
- Adding another mod needs **no code change**. The handshake reports whatever the server registered, keyed on namespace rather than any mod list. If a new mod ever does break it, the failing test will be `fabric.int.test.ts`.

## Testing discipline

Three layers, and they are not interchangeable:

1. **Pure unit tests** — `snapshot.ts`, the mock, contract helpers. No network. Most test value lives here because the logic is pure and the tests are instant.
2. **The contract suite** — runs against every `BotExecutor` implementation. Add to it when you add a behavioural guarantee to the contract.
3. **Integration tests** — the real executor against the live server, under `packages/*/test/integration/`. Configured `fileParallelism: false`; concurrent bots fight each other. Every test connects with a distinct username and **must** disconnect in `afterEach` or it leaks a bot onto the server.

### Two traps this repo has already fallen into

**Tests that rot.** A `moveTo` test once targeted "current position + 6 blocks" against a persistent world. Every success walked the bot further along until it wedged against a tree — green when written, reliably red a day later. Any test whose outcome depends on accumulated world state will eventually fail for reasons unrelated to the code. Use the arena.

**Fixtures that silently skip themselves.** The arena's `/fill` was failing for an entire session because the chunks were unloaded, while `/tp` succeeded independently — so the tests "passed" with the bot in freefall and no platform beneath it. A fixture that can no-op without shouting is worse than no fixture. `mc-console.ts` now verifies the bot is standing at the expected height, not merely that it is on *some* ground.

When you add a guard, prove it can fire. A safety check nobody has seen trigger is not yet known to work.

### The arena

`packages/executor/test/integration/mc-console.ts` builds a stone platform at **y=199**, deliberately floating above all terrain so tests are independent of biome and world generation. It survived a full world reseed unchanged. `placeArenaBlock` generalises it for Phase 2's "mine a known block" tests.

## Scope boundaries

Deliberately unimplemented — do not "helpfully" fill these in:

- `mineBlock`, `placeBlock`, `followPlayer`, `attack`, `flee` are stubs returning `fail('internal', '… arrives in Phase N')`. They **do** still check `opts?.signal?.aborted` first and return `interrupted` — the contract suite asserts this for all six actions.
- No `mineflayer-pathfinder`. Phase 1 movement is raw by design; the pathfinder arrives in Phase 2.
- `packages/agent/` does not exist. It is the other track's package and must never depend on `mineflayer`.

## Conventions

- TypeScript, ESM (`"type": "module"`), Node 24+. `verbatimModuleSyntax` is on — use `import type` for type-only imports.
- Exact version pins in every manifest. No `^` or `~`.
- Cross-package dependencies use the exact string `"0.1.0"`.
- Relative imports carry the `.js` extension (`./snapshot.js`), per NodeNext resolution.
- `packages/contract/` has and must keep **zero runtime dependencies**.
- Commit messages explain *why*, not just what. Several commits here record measurements that would otherwise be lost.
