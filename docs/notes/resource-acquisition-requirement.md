# Requirement: Resource Acquisition

**Owner:** a Track A phase after Phase 5. **Agreed with Ricky 2026-09-10.**

## What is wanted

When the bot lacks something it needs — no pickaxe, no dirt — the right
response is to go and get more, not to abandon the goal:

1. Check the relevant container first.
2. If it is empty, gather from a **designated** area, never an undesignated one.

## Why it is not in Phase 4B

The actions do not exist. Measured 2026-09-10:

- `packages/contract` has **no container actions at all** — no chest, open,
  withdraw or deposit.
- **"Designated area" exists nowhere** in the repo.

A model told to go and get dirt with nothing that can get dirt will pick an
action, fail, and pick again. Phase 4B therefore fixes only the half that needs
no new actions: `missing_tool` on one target must not end the goal when another
route remains.

## What the phase must deliver

- Contract actions for containers. Shared surface, so it needs agreement before
  it lands.
- A designated-area allowlist, **enforced in the executor**. Not a prompt rule:
  a check the model cannot argue its way past. This repo has measured prompt
  prohibitions failing — the Phase 4A `move_to` rule took four candidates.
- The gathering behaviour on top.

## Why it belongs with Phase 5's build safety

Phase 5 needs to know whether a block in the way is a player's build or a
natural tree. That is **not reliably decidable** — Minecraft's world data carries
no player-placed flag, and crafted block types misfire on villages. The robust
mechanism is the same designated-area allowlist. Designing it once serves both.
