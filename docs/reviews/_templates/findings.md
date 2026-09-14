# <stage> r<N> — findings

<!-- Reviewer writes this. Copy to docs/reviews/<YYYY-MM-DD>-<slug>/<stage>-r<N>-findings.md.
     Delete every comment before committing. See docs/REVIEW-PROTOCOL.md §5.5 and §7. -->

| | |
|---|---|
| **Reviewed SHA** | `<full sha>` <!-- add: "branch head is now <sha>; later commits not reviewed" if so --> |
| **Request** | [`<stage>-r<N>-request.md`](<stage>-r<N>-request.md) |
| **Lenses** | <!-- e.g. correctness · testing · maintainability · project-standards · plan-conformance --> |
| **Reviewer gates** | <!-- e.g. unit 437 ✓ · typecheck ✓ · invariants 2/2 ✓ · integration 141/141 ✓ (alone, §6.7) · probe 3×5 → see below --> |

## 🔴 Critical

<!-- or "None." -->

### S1-C1 — <one-line claim>

- **Where:** `path/to/file.ts:123`
- **Excerpt:**
  ```ts
  // the cited lines, ≤ ~10, so the author can check this without opening the file
  ```
- **Failure scenario:** <!-- concrete input/state → wrong output. For docs: which line an implementer would write differently. -->
- **Found by:** <!-- lens --> · **Origin:** original · fold · inherited <!-- inherited: cite `git show main:<path>` --> · **Fix class:** mechanical · design
- <!-- only if applicable, else delete: --> **Seam: Track A** — <!-- how Track A code is implicated --> · **Amends:** spec §<n> / plan Task <n>
- **Recommended fix:** <!-- mechanical: the literal change. design: specific enough to accept as written. -->

## 🟡 Material

<!-- same shape as Critical, or "None." -->

## 🟢 Minor

<!-- Never blocking. The author may fix mechanical ones directly or leave them. -->

| ID | Where | Finding | Fix class | Suggested change |
|---|---|---|---|---|
| | | | | |

## Prior-round verification (round 2+ only)

| ID | Author's state | Verified? |
|---|---|---|
| | | <!-- ✅ at <sha> · ❌ fold escape → re-raised above under the same ID --> |

## Verdict

**FOLD AND RE-REVIEW** · **CONVERGED** · **ESCALATE** <!-- keep exactly one, with one sentence why -->

Escalated, awaiting humans: <!-- IDs, or "none". CONVERGED is not allowed while this lists anything undecided. -->

Round budget — <n> dispatches · blocking <n> (original <n> · fold <n>) · minor <n> · registered <n> inherited · false positives dropped <n>
