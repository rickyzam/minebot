# CLAUDE.md

Guidance for Claude Code working in this repository. Read [README.md](README.md) for what the project is; this file is about how to work in it without stepping on rakes.

## Read first

- [Design spec](docs/superpowers/specs/2026-09-07-minecraft-agent-design.md) — the binding authority. §3 explains why `BotExecutor` is shaped as it is; §9 records the four contract changes that were agreed with Track B and **applied** at the start of Phase 2. There are no outstanding agreed-pending changes — but the rule that produced that list still stands: see "The one rule that matters" below.
- [Track B design](docs/superpowers/specs/2026-09-07-track-b-planning-loop-design.md) — the planning loop. §4 explains why the action menu is not a mirror of `BotExecutor`, §2.1–2.2 record what the real model actually does, and §12 lists what is still unmeasured.
- [Phase 2 design](docs/superpowers/specs/2026-09-07-phase-2-pathfinding-and-mining-design.md) — pathfinding and mining. Its §2 table is measurements against the live server, and three of them contradict the obvious assumption.
- [Phase 1 plan](docs/superpowers/plans/2026-09-07-phase-1-track-a.md) — its "Verified environment facts" block is measurements, not assumptions.
- [Perception: line of sight](docs/superpowers/specs/2026-09-08-perception-line-of-sight-design.md) — **Implemented 2026-09-08.** `findBlocks` used to see through solid rock; it no longer does. Read §5.2 before touching perception — the filter belongs in `useExtraInfo`, not in `matching` and not in the returned array, and §5.2 says why. §5.5 records what implementation turned up. §7.1 stays open for Ricky to confirm the cost wording only.
- [Memory and recall](docs/notes/Memory%20and%20Recall.md) — roadmap. Its two invariants ("memory is written only from perception output", "memory produces search hints, never action targets") constrain work being done now, not just later.

## Commands

```bash
npm test                  # 263 unit tests. No network, no model. Fast. Run these constantly.
npm run typecheck         # Whole repo, including scripts/.
npm run test:integration  # 85 tests. Requires the live dev server.
npm run smoke             # Minimal "can a bot connect at all" check.
npm run demo              # Connect, print snapshot, walk. The Phase 1 deliverable.
npm run demo:phase2       # Connect, path around a wall, mine coal. The Phase 2 deliverable.
npm run demo:phase3       # Real state, real model, real action. The Phase 3 deliverable.
npm run agent:demo        # The planning loop against a fake model and a mock world. No server.
npm run agent:probe       # Ask a real model for one action, five scenarios. Needs OLLAMA_HOST.
npm run arena:map         # Print an arena layer by layer, floor holes included. Diagnostic.
npm run bench:perception  # What honest (line-of-sight) perception costs. Live server. `-- 5 --detail`
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
| `bot.canDigBlock()` returns `true` bare-handed, with a shovel, and with a pickaxe | It means "breakable", not "harvestable". Never use it for `missing_tool`; use `block.harvestTools` |
| `bot.pathfinder.bestHarvestTool()` returned `iron_shovel` for coal ore when that was the only inventory item | Untrustworthy. `harvest.ts` owns the decision instead |
| Mining does not collect — a drop 1.72 blocks away was uncollected 3s later | `mineBlock` walks onto the drop; `collected: false` is a real outcome, not a bug |
| Coal ore `digTime`: 15000ms bare-handed or wrong-tooled (drops nothing), 2300ms wooden pickaxe, 1150ms stone | The harvest guard exists to avoid the 15s no-drop case |
| `goals` is not an ESM named export of `mineflayer-pathfinder` | Use the default import and destructure |
| `goto()` rejects with `.name` of `NoPath` / `Timeout` / `PathStopped` / `GoalChanged` | That name is the only discriminator between `unreachable` and `interrupted` |
| Mined item drops persist in the world across runs | The arena reset despawns them (`/fill` does not — a drop is an entity, not a block), or collection assertions report false greens |
| A player's selected hotbar slot persists in player data, survives `/clear`, and is moved by `bot.equip()` | `/give` alone cannot put an item "in the inventory but not in the hand" — use `placeInSlot()`. A test that equips changes what its own next run starts holding |
| The composition root is `packages/bot/` — the only package depending on both `@minebot/agent` and `@minebot/executor` | Code needing both goes there. Putting it in `agent` pulls Mineflayer into the planning track transitively; `check-invariants.mjs` now catches that |
| Integration tests never require Ollama; only `demo:phase3` and `agent:probe` do | A red demo with green tests means the model chose badly, not that the wiring broke |
| `runGoal` returns `interrupted` only on an **outer** abort | An `interrupted` result without one means the reflex layer preempted — Phase 5, so unreachable today |
| `SchemaDecider` spends **two** model calls on an undecodable reply — the reply plus one repair | A scripted `FakeLlmClient` needs 2 replies per undecodable step, or it exhausts mid-repair and the loop exits `llm_error` instead |
| Minecraft usernames are capped at **16 characters** | A longer one is rejected at login, and `connect()` returning `disconnected` reads as a broken fixture rather than a naming mistake |
| Arenas must be separated by more than the largest radius anything might **search**, not merely their own width | The Phase 3 demo at x1150 found the integration arena's ore at x1126 through the model's own 32-block `find_blocks`, and chased it until the step budget ran out |
| **`goto()` resolves as SUCCESS on a zero-length path** — `lib/goto.js` checks `results.path.length === 0` before its `noPath` and `timeout` branches | A resolved promise is **not** evidence of arrival. `gotoGoal` verifies the world afterwards; without that, `moveTo` reported ok from 8.6 blocks away and `mineBlock` reported ok for an ore it never touched |
| `bot.dig()` applies the break to Mineflayer's **local** world model optimistically | A dig that the server ignored still leaves the bot reporting `not_found` for a block that is still standing. Never treat the digging bot's own view as verification — check from a second connection |
| Parkour reach is **4 blocks displacement = 3 air blocks**, regardless of elevation | Measured across five arenas. Elevation does not extend it: a 1-block **drop** keeps full reach, a 1-block **rise** loses one (fails at 4, works at 3). Cardinal directions only — diagonal jumps are never generated |
| A player's sprint-jump clears **4 air blocks**; the bot manages **3** | The bot's reach is strictly one block shorter than a human's. Terrain designed by walking it yourself will not necessarily be traversable by the bot — this cost a session to discover |
| **`findBlocks` is line-of-sight limited** as of 2026-09-08 — it returns only what the bot could see from where it stands | Was X-ray: measured at the Phase 4 benchmark start, 3216 natural `coal_ore` within 64 blocks, **60** touching a non-solid block and **0** actually visible. `exploreFor` for coal returned 8 hits having travelled 0.0 blocks. Fixed in `visibility.ts`; expect **empty** for buried ore, and that is the honest answer |
| Perception **under-reports while chunks are still loading**, worse than it used to | `isExposed` treats an unloaded neighbour as solid, deliberately, so the bot never claims to see through a chunk it lacks. The old unfiltered query needed only the block; the rule needs its neighbours. `connect()`'s chunk wait is best-effort, so anything asserting on perception right after connecting must wait for it and fail loudly if it never arrives |
| A **bot's position persists in player data** between runs, and tests move it | The contract integration suite's own `exploreFor` tests walk the bot 32 blocks and its visibility fixture teleports it to an arena, so each run started wherever the last one ended. Any fixture declaring "these blocks are findable" must pin the bot's position first — `contract.int.test.ts` teleports to a fixed surface start every test |
| `bot.findBlocks` takes **two** predicates, invoked at different rates: `matching` runs per **block in the volume**, `useExtraInfo` — *when passed a function* — runs only on blocks that already matched by type | `useExtraInfo` is the per-candidate hook, and it runs **upstream of `count`**, so `count` counts survivors and a filter there cannot be defeated by nearest-first truncation. Never put a position-dependent test in `matching`: it is also called on a synthetic **positionless** block to test each section's palette |
| **`findBlocks` is not "free"**, and never was — it walks an octahedron outward and early-breaks only once `count` hits accumulate | A target it cannot satisfy forces a full-volume walk. Measured through the shipped executor at `maxDistance: 64`: `grass_block` 2.4ms, `emerald_block` 147ms, `coal_ore` 339ms, `stone` 909ms. The *empty* answer is the expensive one. Cost is set by `maxDistance`, not by filter cleverness — r=32 costs a quarter of r=64 |
| `bot.pathfinder.searchRadius` defaults to `-1` (unlimited) | A genuinely unreachable target burns the whole `thinkTimeout` (5s) and reports `timeout` rather than `noPath`, so the planner is told "retry" when the truth is "pick another target". See issue on bounding it |

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
4. **The agent's fakes** — `packages/agent` tests run between `FakeLlmClient` and `MockExecutor`. Neither the network nor a model is involved. If a test there needs a real model, it belongs in `probe.ts` instead — model behaviour is reported as numbers, never asserted, because at temperature 0 a 5/5 result is consistency rather than robustness.

**Prompt text is behavioural code that no test covers.** Changing `ACTION_MENU` or the system rules in `prompt.ts` changes what the bot does, and `npm test` will stay green regardless. Re-run `npm run agent:probe` after any such edit. Measured example: sharpening a menu entry did nothing (5/5 unchanged), while near-identical wording in the system-rules block flipped the answer completely (5/5). Guidance about *when* to choose an action belongs in the rules, not the menu.

### Two traps this repo has already fallen into

**Tests that rot.** A `moveTo` test once targeted "current position + 6 blocks" against a persistent world. Every success walked the bot further along until it wedged against a tree — green when written, reliably red a day later. Any test whose outcome depends on accumulated world state will eventually fail for reasons unrelated to the code. Use the arena.

**Fixtures that silently skip themselves.** The arena's `/fill` was failing for an entire session because the chunks were unloaded, while `/tp` succeeded independently — so the tests "passed" with the bot in freefall and no platform beneath it. A fixture that can no-op without shouting is worse than no fixture. `mc-console.ts` now verifies the bot is standing at the expected height, not merely that it is on *some* ground.

When you add a guard, prove it can fire. A safety check nobody has seen trigger is not yet known to work.

### The arena

`packages/executor/test/integration/mc-console.ts` builds a stone platform at **y=199**, deliberately floating above all terrain so tests are independent of biome and world generation. It survived a full world reseed unchanged. `placeArenaBlock` generalises it for Phase 2's "mine a known block" tests.

## Scope boundaries

Deliberately unimplemented — do not "helpfully" fill these in:

- `placeBlock`, `followPlayer`, `attack` and `flee` are stubs returning `fail('internal', '… arrives in Phase 5')`. They **do** still check `opts?.signal?.aborted` first and return `interrupted` — the contract suite asserts this for all six actions. `runAction()` now gives them that check for free; do not re-add it by hand.
- `packages/agent/` is the planning loop. It must never depend on `mineflayer` **or `@minebot/executor`** — `check-invariants.mjs` enforces both, including the transitive case, and reports 2 of 2. Anything needing both tracks belongs in `packages/bot/`. It codes **no per-`FailureReason` retry policy**; that is Phase 4's, and the loop feeds failures back to the model instead. Do not "helpfully" add branching there.
- `packages/bot/` is only the composition root — `runBotGoal()` plus the demo. Planning logic belongs in `agent`, game logic in `executor`; code landing here that is really one or the other is in the wrong package.

## Conventions

- TypeScript, ESM (`"type": "module"`), Node 24+. `verbatimModuleSyntax` is on — use `import type` for type-only imports.
- Exact version pins in every manifest. No `^` or `~`.
- Cross-package dependencies use the exact string `"0.1.0"`.
- Relative imports carry the `.js` extension (`./snapshot.js`), per NodeNext resolution.
- `packages/contract/` has and must keep **zero runtime dependencies**.
- Commit messages explain *why*, not just what. Several commits here record measurements that would otherwise be lost.
