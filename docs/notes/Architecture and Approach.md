# Architecture and Approach — Minecraft AI Agent

How the agent is actually put together, and why **one generic model with a tool library** is enough — no need for a specialized model per behavior (mining, building, combat, chat).

---

## Telemetry over vision

Vision+LLM game agents spend most of their difficulty budget on perception — turning pixels into "there's a tree 4 blocks northwest, partially occluded" — and that's the hard, unreliable part, not the planning. Skipping straight to structured state via a bot API (block coordinates, inventory contents, entity positions) eliminates that failure mode entirely. What's left is much closer to classical game-AI: pathfinding + a task queue + an LLM doing the high-level "what should I do next" reasoning — exactly what LLMs are actually decent at.

**Mineflayer** (a Node.js bot API over the Minecraft protocol) provides this directly: full world state, inventory, entity list, and a pathfinding plugin (`mineflayer-pathfinder`) built in. **Voyager** (2023, Microsoft/Stanford) used GPT-4 + Mineflayer in this exact shape — the LLM writes/calls JS "skill" functions (e.g. `mineBlock('coal_ore', 3)`), the game engine handles the actual pathing and interaction, and the LLM's job is curriculum/skill composition, not motor control.

## Three-layer architecture

1. **Reflex/safety layer** (plain code, no LLM, runs constantly) — health checks, immediate danger response. This layer always wins and can interrupt whatever the LLM's current plan is.
2. **LLM planning layer** (invoked periodically or on state changes) — picks the next goal/tool call from the full toolbox given current state.
3. **Execution layer** (Mineflayer + pathfinder, plain code) — carries out whatever the LLM decided.

This split matters because LLM latency (multi-second) is fine for "decide to go mine coal" but actively wrong for "dodge this incoming hit." Survival-critical reactions belong in layer 1, not layer 2.

## The shared toolbox

One model, one tool-calling loop, a menu of composable actions:

| Tool | Behavior it covers |
|---|---|
| `moveTo(coords)` | Walking around |
| `followPlayer(name)` | Following a player |
| `mineBlock(type)` | Mining a specific resource |
| `placeBlock(type, position)` | Building, at the primitive level |
| `attack(entity)` / `flee()` | Combat — reflex layer handles the immediate case, LLM only makes the judgment call ("worth fighting or not") |
| `chat(message)` | Talking to other players |

A 14B-class instruct model is genuinely fine at "look at this situation, pick the right tool" across all of these — it's the same tool-calling loop already needed for mining, just with a bigger menu. This is why one shared model is enough: the reasoning task is identical across behaviors, only the tool being called changes.

## Notes on the harder cases

### Building
"Build a house" needs either a pre-made blueprint (a schematic file the bot places block-by-block) or genuine 3D spatial planning, which small local models are weaker at than a frontier API-tier model. Practical approach: give the LLM a **library of pre-made structures** to select/place ("build a small house," "build a wall here") rather than asking it to invent structures from scratch. This is a data/tooling problem, not a reason to reach for a different model.

### Combat
Staying alive against a mob needs sub-second reactions — multi-second LLM latency is wrong for that. This is exactly what the reflex layer is for: low health → flee, mob in range → attack-or-flee by a simple hardcoded rule, running independently of and able to interrupt the LLM's current plan. The LLM only gets involved for judgment calls above that ("is it worth finishing this mining trip at low health").

### Chat and following/walking
The easiest cases. Chat is squarely in an LLM's comfort zone — generating a plausible in-character response needs no special tooling. Following and walking are pure pathfinding, effectively zero LLM involvement beyond "follow that player" as a standing instruction.

## Why not specialized models per behavior

Splitting mining/building/combat/chat across separate models would mean juggling multiple model loads in 16GB of VRAM for no real benefit — the reasoning task ("pick the right tool given this state") doesn't actually change shape between behaviors, so there's nothing for a specialized model to specialize *in*. The complexity that does vary (building needs a blueprint library, combat needs a reflex layer) is solved with more tooling around a single model, not more models.

