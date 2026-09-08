# Memory and Recall — Roadmap Entry

**Date:** 2026-09-08
**Status:** Roadmap. Not scoped, not scheduled, deliberately out of scope for Phase 4.
**Depends on:** [Perception: line of sight](../superpowers/specs/2026-09-08-perception-line-of-sight-design.md). Memory is meaningless until perception is honest.

This document exists so the idea is not lost and so work done before it starts
does not have to be undone. It is written in more detail than a roadmap entry
normally warrants, because the reasoning is the valuable part and it is easy to
lose.

---

## 1. Why memory exists at all

Once perception is limited to line of sight, the bot forgets everything the
moment it turns away. That is correct — but it is not how a player works.

> When I'm playing and walking around I can usually recall things I've seen
> within a certain area I've explored for the last *n* minutes. My focus might
> be looking for coal ore but I take note of lots of other things I see as I
> explore, and if I then decide I need sand and I remember passing some, I can
> wander back and with minimal searching find the sand I remembered seeing
> nearby a little earlier.

Two distinct capabilities fall out of that, and they have different lifetimes,
different representations, and different failure modes:

- **Short-term spatial memory** — fuzzy, local, decaying. "There was sand back
  that way a few minutes ago."
- **Long-term landmark memory** — durable, sparse, coordinate-bearing. "There is
  a swamp at these coordinates; I have been there."

## 2. The thing that will look wrong later, so it is recorded first

We are about to build a *deliberately lossy* memory on top of a *perfect* one.

Mineflayer's client keeps every loaded chunk in full fidelity. The bot could,
at any moment, enumerate every block it has ever streamed. Someone will
eventually ask why we are building a memory system when the world model already
remembers everything, and will propose deleting it as a simplification.

**That perfect memory is the cheat we removed.** Reading it is precisely the
X-ray behaviour the line-of-sight change exists to eliminate. A memory system
that consults it is not a memory system; it is the bug with extra steps.

If this paragraph is ever deleted, the design will regress within a month.

## 3. Two invariants

Everything below follows from these. They are the load-bearing part of this
document.

### 3.1 Memory is written only from perception output

Never from the raw world model, never from chunk data, never from server
telemetry the bot could not have observed. The bot discovers an ancient city by
*seeing* sculk, not by its chunk containing a structure tag.

Violating this reopens the X-ray hole through the back door, and it will be
tempting, because reading the world model is always easier than looking.

### 3.2 Memory produces search hints, never action targets

This is the resolution to a genuine tension. The executor needs coordinates to
act — `moveTo` and `mineBlock` take a `Vec3`. But a memory that hands the
planner an exact block position is a memory that can be acted on without
looking, which is the same cheat again, plus a staleness bug.

So: **recall returns a region to go and look in. Only live perception returns
something you can act on.** You remember roughly where the sand was, you walk
there, and *then* you look.

This is not just philosophically tidy. It closes a bug class this repository has
already been bitten by twice:

| Incident | Shape |
|---|---|
| `goto()` resolving as success on a zero-length path | reported success without checking the world |
| `bot.dig()` applying optimistically to the local world model | reported a change the server never made |

Mining ore the bot *remembers* but which was mined ten minutes ago is the same
failure in a new place. Under §3.2 it cannot happen: memory sends the bot
somewhere, perception decides what is actually there.

---

## 4. Short-term spatial memory

### 4.1 Representation: coarse cells, not points

**The bot must not store block coordinates for remembered materials.** A perfect
index of block positions is indistinguishable from the world model we just
stopped reading.

Instead, quantise the world into cells — chunk-aligned, 16×16 columns is the
natural unit — and record observations at cell granularity:

```
cell (cx, cz) → {
  materials:  Map<blockName, { count: approx, lastSeenAt: timestamp, salience }>
  sweptAt:    timestamp | null      // see §4.4
  observedFrom: approx position     // where the bot was standing
}
```

This satisfies "no coordinates" *structurally* rather than by convention: there
is no block position stored, so there is nothing to cheat with. It is also
naturally fuzzy, bounded in size, trivial to decay, and converts directly into
"go to this cell and look around" — which is exactly what §3.2 requires recall
to produce.

Cell size is a tuning parameter with a real trade-off: larger cells are cheaper
and fuzzier (more re-searching on arrival), smaller cells approach a coordinate
index (and the cheat). 16×16 is the starting proposal because it aligns with
chunks and with the 32-block perception radius, not because it is known correct.

### 4.2 Decay by time

The core of the player analogy. An observation's confidence falls with age and
the entry is dropped below a threshold. `n` minutes is the obvious knob.

### 4.3 Decay by salience, not only time

You do not remember one grass block and a large exposed diamond vein equally
well. A salience weight — driven by rarity, quantity, and goal-relevance —
should modulate the decay rate, so commonplace materials fade fast and notable
ones persist.

This is also the mechanism that unifies the two memory systems; see §6.

### 4.4 Negative memory: remember where you found nothing

**This is as valuable as the positive case and is the piece most likely to be
forgotten.**

"I swept this area and it was empty" is what stops the bot re-searching ground
it has already covered. Without it, every new goal re-walks the same terrain.

`exploreFor` already computes exactly this — `searchedTo` and `exhausted` — and
then throws it away the moment `names` or `maxDistance` changes, because the
search is keyed on the search rather than on the ground. A swept-cell record
would make exploration dramatically cheaper *across* goals, not merely within
one call.

Note the asymmetry in how the two kinds of memory should decay: "there was sand
here" goes stale because the world changes and because recall is imprecise.
"I looked here and saw no exposed coal" goes stale much more slowly, because
terrain does not spontaneously grow ore. Negative memory should probably outlive
positive memory by a wide margin.

### 4.5 Capacity and eviction

Time-based decay alone does not bound memory if the bot explores fast. A cell
budget with least-recently-useful eviction is the likely shape. Worth measuring
against a long run before choosing.

### 4.6 What short-term memory must never do

- Return an exact block position (§3.2).
- Assert that a material *is* present — only that it *was seen*, and when.
- Be consulted in place of perception when deciding an action is complete.
  "I remember seeing coal" must never satisfy "do I have coal."

That last one is the same false-success failure as §3.2's table, and it is worth
an explicit test.

---

## 5. Long-term landmark memory

### 5.1 What it is for

> If it finds a rare biome, or a large cave, or a stronghold, or an ancient
> city, etc… it should have a way to save the 'safe' coordinates and be able to
> report that back to a human player. […] So if he's out performing the specific
> task he's assigned like 'find and mine diamonds' and while he's exploring and
> hunting diamonds he stumbles on an ancient city he should know to record the
> coordinates for that.

And then reason over it later: *tasked with finding clay or slime balls, he
knows he needs a swamp, he found a swamp before and has the coordinates, so he
goes directly there instead of searching.*

Unlike short-term memory, landmarks **do** carry coordinates. That is
appropriate: a landmark is a place, not a material, and "the swamp is at these
coordinates" is knowledge a player genuinely retains for a whole play session
and beyond. The §3.2 rule still applies to what is *found* there — arriving at
the remembered swamp tells you nothing about where the clay is until you look.

### 5.2 Recognition must be rule-based, pure, and passive

If landmark detection is a background process, **it cannot cost a model call**,
or every step of every run doubles in price for a capability the current goal
does not need.

So recognition is a pure function over the world snapshot, living in Track A
beside `harvest.ts` and `explore.ts`. Candidate signals, all derivable from
perception:

| Landmark | Signal |
|---|---|
| Biome transition | biome at the bot's position changes from the last record |
| Ancient city | `sculk_catalyst`, `reinforced_deepslate`, `sculk_shrieker` |
| Stronghold | `end_portal_frame`, `stone_bricks` in quantity underground |
| Village | `bell`, farmland clusters, villager entities |
| Large cave | large contiguous non-solid volume below the surface |
| Ruined portal / fortress | `crying_obsidian`, `nether_bricks` |
| Exposed rare ore | `diamond_ore` / `ancient_debris` seen (i.e. visible, per §3.1) |

This placement is not incidental: `check-invariants.mjs` already enforces that
`packages/agent` may not depend on `mineflayer` or `@minebot/executor`, so game
knowledge of this kind has exactly one correct home.

### 5.3 The record, and the trick for "safe coordinates"

"Safe coordinates" is doing a lot of work in the original sketch and deserves a
sharp definition. For an ancient city the *centre* is the worst possible
coordinate to store — that is where the wardens are.

A landmark record should carry three things:

```
{
  type:        'ancient_city' | 'swamp' | 'village' | …
  seenAt:      timestamp
  represents:  approx position of the feature itself
  approach:    the bot's own position at the moment of recognition
  evidence:    which signal fired, so a bad detector can be diagnosed later
}
```

The trick is `approach`. **The safest available coordinate is where the bot was
actually standing when it saw the thing** — by construction, somewhere it
survived being, reachable by a route it had just walked. No extra verification
needed, and it degrades gracefully: worst case the bot returns to a viewpoint
and has to search from there, which is exactly §3.2's model anyway.

### 5.4 Persistence, and an open question the project has not faced

Landmarks would be this project's **first durable state owned by the bot**.
Everything so far is either in-repo (code, fixtures) or ephemeral (a session's
step log). That raises questions with no current precedent:

- Where does it live? Not in the repo — it is per-world data, not source.
- Per-bot, or shared between bots? Phase 6 is multi-bot; a shared landmark store
  is a plausible and powerful thing, and also a coordination problem.
- What happens on a world reseed? Landmarks silently become lies. They need the
  world's identity (seed and/or a world id) recorded alongside them, and must be
  invalidated when it changes. The repo has already been through one reseed.
- Is it a cheat vector? A landmark file hand-edited to contain a diamond vein
  the bot never saw defeats §3.1. If landmarks are ever authored by anything but
  the bot's own perception, that must be a deliberate, visible decision.

The dev server notes already treat shared state outside the repo carefully
(`forwarding.secret`, the forceloaded arenas). This belongs in that category.

### 5.5 Reporting to a human

Deliberately TBD in the original sketch. The pieces that already exist:
`BotExecutor.chat()` is on the contract, and Phase 5 brings chat properly into
scope. Plausible shapes, in rough order of effort: chat on discovery; answering
a chat query ("where have you seen a swamp?"); a written summary artefact.

Worth noting that "report back to a human" and "reason over it myself" want
different formats, and only the second one has to be in the prompt.

### 5.6 Reasoning over landmarks — the planner's side

The payoff case: *tasked with finding clay, the bot knows it needs a swamp, has
one recorded, and goes straight there.*

That requires two things beyond storage:

1. **A menu action** — `recall` or `travel_to_landmark`. This is Track B surface
   and a contract/menu change; it needs agreement, and it grows the action menu,
   which is already flagged as a risk to a 14B model's tool-selection
   reliability (Phase 4 design §8 risk 3).
2. **Domain knowledge linking goals to landmark types** — "clay implies swamp"
   is Minecraft knowledge. It could come from the model, or from a table. The
   model knowing it is convenient but unmeasured; the table is reliable but
   another thing to maintain. This deserves a probe measurement before being
   assumed either way.

---

## 6. The two systems are one system

Do not build two mechanisms. Build **one observation pipeline with two retention
policies**:

```
perception (line of sight)
        │
        ▼
   observations ──► short-term cell memory ──► decay ──► forgotten
        │                    │
        │                    └── salience above threshold ──► promoted
        ▼                                                        │
   landmark recognition (pure, rule-based) ───────────────────────┤
                                                                  ▼
                                                        durable landmark store
```

"Long-term memory" is then just *short-term memory that was interesting enough
to survive decay* — which is roughly how human memory works, and means one
mechanism to build, test and reason about rather than two that drift apart.

---

## 7. Testing discipline

The repository's existing rules apply, and one is especially relevant:

- **Most value in pure unit tests.** Decay, promotion, eviction, cell
  quantisation and recall-to-region are all pure functions over plain data,
  testable exhaustively in milliseconds — the `harvest.ts` / `explore.ts`
  precedent.
- **Prove the guards fire.** A memory that never forgets, and a memory that
  forgets everything, both pass a naive test. Assert decay actually evicts, and
  that a promoted landmark actually survives.
- **Time must be injectable.** A memory system tested against `Date.now()` is a
  memory system tested at one speed. Take a clock.
- **The anti-cheat invariants need their own tests.** §3.1 and §3.2 are the
  point of the design; assert that recall cannot return a block position, and
  that memory writes reject anything not sourced from a perception result.
- **Integration tests must include the stale case.** See a block, leave, have
  the server remove it, come back. The bot must not report success from memory.

---

## 8. Risks and failure modes

1. **Memory becomes a de-facto coordinate index.** The most likely regression:
   someone shrinks the cell size "for accuracy" until it is a block index. Cell
   size is a design boundary, not a tuning knob.
2. **Recall used as evidence of possession.** "I remember coal" satisfying "get
   coal". §4.6.
3. **Prompt bloat.** Memory has to reach the model somehow, and the prompt is
   already the most expensive part of the loop. Recall is probably an *action*
   the model takes, not state injected into every prompt — otherwise every step
   pays for memory whether it needs it or not.
4. **Landmark detector false positives.** A misfiring detector fills the durable
   store with junk that then misdirects future goals. Hence `evidence` in the
   record (§5.3), so a bad detector is diagnosable after the fact.
5. **Stale landmarks after a world change.** §5.4.
6. **Cost.** Recognition runs every step. It must be cheap enough that a run
   with no landmarks nearby pays almost nothing.

---

## 9. Open questions

- Cell size, decay half-life, and salience weights — all need measurement, none
  can be guessed well.
- Does short-term memory persist across a disconnect? (Probably not: "short-term"
  and "survives a reconnect" are in tension.)
- Is the landmark store per-bot or shared? (§5.4)
- Does goal→landmark-type knowledge come from the model or a table? (§5.6)
- How is memory surfaced to the planner — an action, or prompt state? (§8.3)
- Does the bot record landmarks while executing an unrelated goal *without* it
  affecting the step budget? (It must, or "background" is not true.)

---

## 10. What we are doing now to stay compatible

Nothing in this document is being built yet. Two cheap decisions taken during
Phase 4 keep the door open:

1. **The line-of-sight filter is written as a pure module producing
   observations** — what was perceived, from where, at what time — even though
   the contract's `findBlocks` continues to return plain `BlockInfo[]`. That is
   precisely this design's input. Getting the internal shape right costs nothing
   now; retrofitting it later would mean touching `findBlocks`, `exploreFor` and
   the contract a second time.
2. **`exploreFor` keeps its `visited` waypoint list** rather than collapsing it
   to a radius. That list is proto-memory of "where I have been", and it is the
   seed of §4.4's swept-cell record.

A likely future contract change, flagged early so it is not a surprise:
`BlockInfo` may want `seenFrom` / `seenAt`.
