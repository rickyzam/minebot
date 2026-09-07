# Minecraft AI Agent

---

## Background

An earlier brainstorm raised **"AI game-playing agent (e.g. Minecraft via vision+LLM) — novelty/research-hobbyist territory"** as a low-conviction idea. On closer look, the *vision*+LLM framing is the hard, unreliable part — most published work in this space (e.g. Voyager) spends most of its difficulty budget on turning pixels into usable state, not on the planning itself. Skipping straight to **structured game telemetry** (via a Minecraft bot library instead of a screen) removes that bottleneck entirely. What's left is much closer to classical game-AI — pathfinding plus a task queue — with the LLM only doing the high-level judgment calls, not motor control or perception. That reframing is what turned this from a backlog curiosity into an actual project worth scoping out.

## Goal

Build a **generic, tool-calling LLM agent** that connects to a real Minecraft server as a bot and can act like a reasonably capable player — a "smarter NPC" — not a single-purpose script:

- Move around, navigate to a location, follow a player
- Mine specific resources on request (e.g. "go find and mine coal")
- Basic building from a pre-made blueprint/schematic
- Fight or flee from monsters to stay alive (handled by a fast reflex layer, not the LLM directly)
- Chat with other players in-game

**One shared local model handles all of these via different tool calls — not a separate specialized model per behavior.** Full reasoning: [Architecture and Approach](./Architecture%20and%20Approach.md).

## Plan — Phases

Phases 1–6 below are the overview; **[Phase Plan and Parallel Work Split](./Phase%20Plan%20and%20Parallel%20Work%20Split.md) has the detailed task breakdown, a dependency diagram, and which phases the two tracks can work on at the same time versus which need to happen together.**

### Phase 1 — Bare Mineflayer PoC
A Node + Mineflayer script logs into the (now-local) server, reads its own position/inventory, and walks to a fixed coordinate. No LLM yet. Confirms the server accepts bot connections at all and that the bridge to game state actually works — the two things worth confirming before writing anything more elaborate.

### Phase 2 — Pathfinding + hardcoded mining
Add `mineflayer-pathfinder`, path to a known coal-ore coordinate, mine it. Still no LLM — this proves out the execution layer on its own.

### Phase 3 — Close the LLM loop once
Wire a single local Ollama call into the loop: feed it current inventory + nearby-block state as text, have it emit a structured action (e.g. `{"action": "mine", "target": "coal_ore"}`), execute that action. The goal here is just proving the loop closes end to end.

### Phase 4 — Reliable "go find and mine coal"
The real engineering work. Coal isn't always visible in already-loaded chunks, so "find" means a genuine search/explore strategy (spiral outward, check exposed caves, dig down), not just path-to-known-coordinate. Also: basic robustness (mob interrupts, falling in lava, getting stuck). Mostly plain code, not LLM reasoning — this is the bulk of the total effort.

### Phase 5 — Generalize to a "smarter NPC"
Expand the toolbox to the full behavior set — build from blueprint, follow player, chat, reflex-layer combat — per [Architecture and Approach](./Architecture%20and%20Approach.md). Same tool-calling loop, bigger tool menu.

### Phase 6 — Multi-bot scaling test
Run 2+ bots against the shared Ollama instance, tune `OLLAMA_NUM_PARALLEL`, observe decision-latency under concurrent load. See [Hardware and Feasibility](./Hardware%20and%20Feasibility.md).

## Hardware & Feasibility

The host machine (16-core/32-thread desktop CPU, 32GB DDR5, 16GB consumer GPU, headless Linux) comfortably handles this — the LLM only needs to run periodically (not per-tick, and no vision model in the loop at all), and Mineflayer's own game-logic loop is CPU-trivial next to typical dev workloads. The one real caveat, now that the Minecraft server also runs on the same machine: RAM contention between the server's 16GB heap, Ollama, and concurrent dev work. Full math: [Hardware and Feasibility](./Hardware%20and%20Feasibility.md).
