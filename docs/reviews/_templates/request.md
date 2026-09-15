# <stage> r<N> — review request

<!-- Author writes this. Copy to docs/reviews/<YYYY-MM-DD>-<slug>/<stage>-r<N>-request.md.
     Delete every comment before committing. See docs/REVIEW-PROTOCOL.md §4.3. -->

| | |
|---|---|
| **Unit** | <!-- e.g. Phase 4 retry policy --> |
| **Stage** | spec · plan · impl |
| **Round** | <N> of 3 |
| **Branch / PR** | `<branch>` · #<n> |
| **Head SHA** | `<full sha>` — review exactly this commit |
| **Artifacts** | <!-- spec/plan paths; for impl, `git diff main...<sha>` --> |

## In scope

<!-- What this round covers. For round 2+, name the fix commits. -->

## Look hardest at

<!-- The parts you are least sure of. One line each. -->

## Known gaps

<!-- Anything deliberately left out or unfinished, so it is not reported back as a finding. -->

## Author gates

| Gate | Result |
|---|---|
| `npm test` | <!-- e.g. 437 passed --> |
| `npm run typecheck` | |
| `node scripts/check-invariants.mjs` | |
| `agent:probe` (prompt changes only) | <!-- replicates × attempts, per-scenario numbers, or "n/a" --> |
| Server gates (`test:integration`, `smoke`, `demo:*`) | left to reviewer |

## Prior findings — disposition (round 2+ only)

<!-- Every blocking finding from earlier rounds of this stage, carried to its final state. -->

| ID | Final state | Evidence |
|---|---|---|
| <!-- S1-C1 --> | <!-- fixed <sha> · closed (withdrawn) · registered · escalated (pending / decided YYYY-MM-DD) --> | <!-- sha, file:line, or ESCALATION.md --> |
