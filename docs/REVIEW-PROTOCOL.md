# Cross-instance review protocol

> **Status: PROPOSED.** Not binding on either side until Ricky and Dorel have both agreed on the PR that introduces it. Until then Track B works exactly as it did before. When it is adopted, this line changes to **ADOPTED <date>, PR #<n>**, and that is the only signal either Claude instance should act on.

Track B's author works in one Claude Code instance, and Track B's reviewer works in a different instance on a different person's plan. They hand work across through **files committed to the PR branch**, with a short PR comment each time as the notification.

Read this whole document once, then read the section for your role. **[§4 Author](#4-the-author--rickys-instance)** is for Ricky's instance. **[§5 Reviewer](#5-the-reviewer--dorels-instance)** is for Dorel's instance. Everything else applies to both.

---

## 1. Why this exists

Three reasons, in order of weight:

1. **Token budgets are unequal, and review is the expensive part.** Ricky is on Max 5; Dorel is on Max 10. On this repo, reviewing has routinely cost more than writing: parallel reviewer bundles, fix rounds, then a re-review. Phase 5's plan took three independent reviews before it was executable, and its Task 7 took three fix rounds after that. When the author also reviews, most of the author's budget goes on review. Moving review to Dorel's plan leaves Ricky's budget for the work only Ricky can do: deciding what Track B should be, and building it.
2. **A reviewer that did not write the work does not share the author's blind spots.** The author has absorbed the plan's assumptions and cannot see what was assumed. A reviewer starting from the committed files alone can.
3. **The reviewer runs on the machine the work is ultimately tested on.** The reviewer's instance runs on **bellatrix**, where the dev server and Ollama (`qwen3:30b-a3b`) live. Ricky's instance runs on his laptop and reaches bellatrix over Tailscale. Ollama listens on every interface, so `agent:probe` works from the laptop. The backend is loopback-only (`127.0.0.1:25566`), and the integration suite drives the server console through a local `tmux` session. So `test:integration`, `smoke` and the `demo:*` scripts only run **on** bellatrix itself. A Track B change that reaches the seam can therefore be verified against the real executor during review, without Ricky having to run the server-side checks.

What it costs, stated plainly so nobody is surprised:

- **Latency.** Every round waits for whichever side is out of tokens or away. [§6.6](#66-waiting-is-not-idling--stacked-branches) is how the author keeps moving meanwhile.
- **Dorel's budget.** The review cost moves rather than disappearing, and Track A slows by about that much. That is the intended trade.
- **Ceremony.** Files, IDs, comments. The templates in [`docs/reviews/_templates/`](reviews/_templates/) exist so that neither side writes this structure from memory.

## 2. Scope

**Applies to:** every PR whose work Ricky directed. That means Track B, and any joint-phase work Ricky authors.

**Roles follow the human, not the machine.** Ricky's work is reviewed by an instance **Dorel** directs, and never by one Ricky directs, even if Ricky's session happens to run on bellatrix. An instance works out its role from **who is directing it**. `gh api user --jq .login` gives a default: `rickyzam` for Ricky and `onetruezman` for Dorel. **That is only a default.** It reports whose account the session is logged into, which is not necessarily who is typing: Ricky in a shell on bellatrix would show as `onetruezman`. **A person working in someone else's session says so, and the named person decides the role.** Never infer the role from the hostname or from how the request was phrased.

| Directed by | Asked to | Role |
|---|---|---|
| `rickyzam` | brainstorm, spec, plan, implement, respond, fix | **Author** |
| `onetruezman` | review a PR Ricky directed | **Reviewer** |
| `rickyzam` | review his own PR | **Refuse, and say why.** A self-review is exactly what this protocol replaces. |
| `onetruezman` | author Track B work | **Out of scope.** Reviewed in-session like Track A, unless the humans decide otherwise for that unit. |

**Does not apply to:**

- **Track A work.** Dorel's instance keeps reviewing its own work in-session, as it does today. The roles are not symmetric, because the token budgets are not.
- **Trivial PRs.** A typo, a broken link, or a comment-only change, where nothing behavioural moves. Ricky merges these without a cycle. **If in doubt, it is not trivial.** Prompt text (`prompt.ts`, `ACTION_MENU`, system rules) is **never** trivial, however small the diff, because it is behavioural code that no unit test covers (see CLAUDE.md, "Testing discipline").

**Never trivial, whatever the diff size:** anything touching `packages/contract/` or `packages/mock-executor/`, the shared surface that CLAUDE.md's "one rule that matters" protects.

## 3. Vocabulary

| Term | Meaning |
|---|---|
| **Author** | Ricky's Claude Code instance. Writes specs, plans and code; responds to findings; makes fixes. |
| **Reviewer** | Dorel's Claude Code instance. Runs reviewer bundles, writes findings, confirms fix proposals, verifies fixes, runs the gates the author cannot. |
| **Humans** | Ricky and Dorel. Decide escalations and contract changes. **Ricky merges**, since he owns the repository. |
| **Unit** | One piece of work that goes spec → plan → implementation, e.g. "Phase 4 retry policy". |
| **Cycle** | All review activity for one unit. It lives in one folder: `docs/reviews/<YYYY-MM-DD>-<slug>/`. |
| **Stage** | `spec`, `plan` or `impl`. Each stage converges on its own before the next one starts. |
| **Round** | One reviewer pass over one stage: one request, one findings file, one response. **At most 3 per stage.** |
| **Finding** | One defect, with a stable ID, a severity, an origin, a fix class and a recommended fix. |

---

## 4. The author — Ricky's instance

### 4.1 What you do

Brainstorm, write the spec, write the plan, implement, respond to findings, fix. **You do not review your own work with subagents.** That is the part this protocol moves off your plan.

### 4.2 Skills: keep, and skip

Several skills you would normally use launch reviewer subagents by themselves. Each one spends your tokens on work the reviewer is about to repeat.

| Skill | Use? | Why |
|---|---|---|
| `superpowers:brainstorming` | **Yes.** Its "spec self-review" is an inline checklist, not a subagent, so keep it. Both it and `writing-plans` ship a document-reviewer *prompt* file. superpowers 6.3.0 does not dispatch either, but **if your version launches a spec or plan reviewer subagent, skip that step.** | Specs are your work. |
| `superpowers:writing-plans` | **Yes.** Keep its inline self-review. When it offers an execution mode, it labels subagent-driven "(recommended)". **Choose inline execution** (`superpowers:executing-plans`) anyway. | |
| `superpowers:executing-plans` | **Yes, as the default way to implement.** | Runs tasks in your own context with no per-task reviewer. |
| `superpowers:subagent-driven-development` | **No.** | Every task gets a spec-compliance and quality reviewer, up to 5 fix rounds, and a final whole-branch review. That duplicates this protocol and is probably the largest avoidable cost on your plan. |
| `superpowers:test-driven-development`, `superpowers:systematic-debugging`, `superpowers:verification-before-completion` | **Yes.** | Cheap, and they stop red work reaching the reviewer at all. |
| `superpowers:receiving-code-review` | **Yes, when writing a response.** | It is about checking feedback before agreeing with it, which is exactly what §4.5 asks. |
| `superpowers:requesting-code-review`, `/code-review`, `/simplify`, `compound-engineering:ce-code-review`, `compound-engineering:ce-doc-review` | **No.** | Review bundles. The reviewer runs these. |
| `superpowers:finishing-a-development-branch` | **Yes, but choose "push and open a PR".** Never merge locally. | Merging happens after convergence, §6.5. |

### 4.3 Before requesting review

Requesting review with red gates wastes a round, and rounds are capped.

1. Commit everything the stage produced. **Once a request is open, never rewrite pushed history:** no amend, rebase or force-push (§8 rule 2). Findings cite commit SHAs, and a rewritten history turns every citation into a dangling reference.
2. Run the author gates and record the result of each in the request:
   - `npm test`
   - `npm run typecheck`
   - `node scripts/check-invariants.mjs`
   - **If the diff changes prompt text:** `OLLAMA_HOST=http://<bellatrix's Tailscale address>:11434 npm run agent:probe -- <replicates> <attempts>`. It costs no Claude tokens, so run it rather than leaving it to the reviewer. Check §6.7 before starting. **Never claim a prompt change works from a single run** (CLAUDE.md: the same byte-identical prompt split 9 / 5 across processes).
   - **You do not need to run** `test:integration`, `smoke` or `demo:*`. They only run on bellatrix, and the reviewer runs them (§5.3). Write "server gates: left to reviewer" in the request.
3. Write `<stage>-r<N>-request.md` from [`_templates/request.md`](reviews/_templates/request.md). The request must include:
   - the head SHA,
   - what is in scope,
   - what you want looked at hardest,
   - gaps you already know about,
   - and, from round 2 on, the disposition table (§4.6).
4. Commit the request, push, and post the notification comment (§6.3).

**Round 1 of a stage** opens the PR as a **draft** if there is none yet. A spec and plan can share a PR ("design PR", like #22), with the implementation in a second one (like #23). The cycle folder is keyed by unit, not by PR, so one folder can span both.

### 4.4 The fold rule — the reason this protocol has a fix class

**Do not fix anything on the fly.** A fix made while reading findings, without a decision behind it, is the classic source of new defects. Every "while I'm in here" repair creates something the next round has to review. Dorel's `_starter` project measured exactly this, in a review process outside this repo: in one cycle, **every** blocking finding in rounds 2 and 3 was a defect in a previous round's repair. None were defects in the original work, and roughly half the review spend went on reviewing repairs.

Every finding carries a **fix class** set by the reviewer, and the class decides what you may do:

| Fix class | What you do |
|---|---|
| `mechanical` | The findings file specifies the exact change: a wrong count, a stale reference, a missing `.js` extension, a typo in an identifier. **Apply exactly that change and nothing more.** One commit, message `review(<stage>-r<N>): <ID> <summary>`. Several mechanical fixes may share one commit if the message lists every ID. |
| `design` | The fix needs a decision. **Write no code.** In your response, do one of the following: **accept the reviewer's recommended fix as written** (no confirmation round needed); **propose a different fix** (the reviewer must confirm it before you implement); or **dispute** the finding, with evidence. |

**Labels can be appealed in both directions, cheaply.**

- If a `mechanical` label is wrong, because the change is not actually self-contained, say so in the response. The finding is then treated as `design`.
- If a `design` finding is really a one-line change, `propose` that literal change. Confirming it is a reading pass, not a round (§5.6).
- You may likewise dispute a finding's **severity** or **origin** with evidence. For example, `git show main:<path>` shows the defect predates your unit, so it is `inherited`, not `original`.

**If you notice a new problem while fixing,** do not fix it. List it under "Author-found issues" in your response. The reviewer classifies it like any other finding.

**Forbidden during a fold:**

- changing anything not named by a finding ID,
- refactoring,
- editing a test so that it passes,
- touching `packages/contract/` or `packages/mock-executor/` without the humans' recorded agreement,
- editing any file the reviewer wrote.

### 4.5 Writing a response

`<stage>-r<N>-response.md`, from [`_templates/response.md`](reviews/_templates/response.md). Every finding ID from the round gets exactly one row. None may be skipped, and "noted" is not a disposition.

| Disposition | Use when |
|---|---|
| `fixed <sha>` | `mechanical`, applied. |
| `accept-recommended` | `design`, and the reviewer's recommended fix is right. You then implement it, and the next request cites its SHA. |
| `propose` | `design`, and you have a better fix. Describe it, plus the file and test it changes, **without writing it**. Wait for confirmation. |
| `dispute` | You believe the finding is wrong. Give evidence: a file:line, a test, a measurement, a spec section. "I don't think so" is not evidence. |
| `register` | Only for `origin: inherited` findings (§7.3). Name where it is registered. |
| `needs-human` | The finding is really a product or scope question that neither instance should decide. |
| `leave` | **Minor only.** Not worth changing. One sentence saying why. |

**Verify before agreeing.** A reviewer finding is a claim, not a fact. Before you accept one, read the code it cites. A wrong finding that you accept costs a fix and then a revert.

Push the response and post the notification. Then:

1. **Implement every `accept-recommended` fix now**, whatever else the response contains. Those are decided.
2. **If any row is `propose`, `dispute` or `needs-human`,** wait for the reviewer's confirmation (§5.6). Wait on **those rows only**: touch no code for them until the confirmation arrives.
3. **When the confirmation arrives,** act on each answer:

   | Reviewer's answer | What you do |
   |---|---|
   | `confirmed` | Implement your proposal. |
   | `confirmed-with-change` | Implement your proposal, with the stated change. |
   | `withdrawn` | Nothing. The finding is closed. |
   | `rejected` or `upheld` | **Exactly one exchange per finding, then it ends.** Either implement the reviewer's recommended fix (or the alternative the rejection named as acceptable), or record the ID as `escalated` and the reviewer adds it to `ESCALATION.md`. **No second proposal and no second dispute on the same finding.** Two instances arguing costs rounds and settles nothing. |
   | `escalated` (`needs-human`) | Nothing, until the humans decide. |

4. **Write the next round's request** once every row is fixed, closed, registered, left or escalated. Escalated items wait for the humans; everything else carries on.

### 4.6 Round 2 and 3 requests

Same as §4.3, plus a table carrying every prior blocking finding forward to its state: `fixed <sha>` · `closed` (withdrawn) · `registered` · `escalated` (pending, or decided, with the date). **The reviewer verifies that table.** A finding marked fixed that the reviewer cannot see fixed comes back as a **fold escape** (§7.5).

---

## 5. The reviewer — Dorel's instance

### 5.1 What you do

Review what was requested, at the SHA requested. Write findings that the author can act on without extra context. Confirm or reject fix proposals. Verify fixes. Run the gates the author cannot. Decide convergence and draft escalations.

**You never write or edit the author's work.** No specs, no plans, no code, not even a one-character fix. The only files you create or change are in the cycle folder. The one rule on the author's side, not fixing on the fly, depends on the one rule on yours: every change to the work is the author's.

### 5.2 Setting up a round

1. Review in a **worktree** on the PR branch, so any Track A work in the main checkout stays untouched. Then move it to the requested SHA:

   ```bash
   git fetch origin
   git worktree add ../minebot-review-<slug> <branch>    # first round; later rounds: cd there and `git switch <branch> && git pull --ff-only`
   cd ../minebot-review-<slug> && git switch --detach <sha>
   ```

   Review with HEAD detached at the SHA, so reviewer subagents read exactly what was requested. **Write the findings file while detached.** It is untracked, so it survives the switch back in §5.5.
2. If the branch head has moved past the requested SHA, review **the requested SHA** anyway. Say in the findings header that newer commits exist and were not reviewed.
3. Read, in this order:
   1. the request,
   2. CLAUDE.md,
   3. every prior file in the cycle folder,
   4. the specs the unit cites.

   Refresh against what is actually on disk. Do not trust memory of what a file said.

### 5.3 The bundle, by stage

Reviewers are `general-purpose` subagents seeded with a persona file. Pass `model: "sonnet"`. Run **at most 5 in parallel**: larger waves have been seen returning truncated results. Every recorded finding names the lens that found it.

Persona files live in the `compound-engineering` plugin: doc lenses under `skills/ce-doc-review/references/personas/`, code lenses under `skills/ce-code-review/references/personas/`.

| Stage | Always | Add when |
|---|---|---|
| `spec` | coherence · feasibility · scope-guardian · adversarial-document | **contract lens** if the spec touches or implies a change to `packages/contract/` or `packages/mock-executor/`. It checks that the change is identified as needing agreement, and that the mock, the suite and the doc comments move together. |
| `plan` | coherence · feasibility · adversarial-document · **spec conformance** (every spec requirement has a task; every step is executable as written; no `[...]` placeholders) | contract lens, as above |
| `impl` | correctness · testing · maintainability · project-standards (CLAUDE.md) · **plan conformance** (plan + prior findings vs the diff; scope drift) | adversarial if the diff is ≥ 50 lines or touches the loop · reliability if it touches abort signals, timeouts or async · api-contract if it touches the shared surface |

**Rounds 2 and 3 are not full bundles.**

- **Round 2:** plan conformance against the fix commits, plus **the lenses whose ground the fixes touched**, at most two: a changed test means `testing`; changed logic means `correctness`; changed abort, timeout or async code means `reliability`; a changed spec or plan means `coherence`. A fix is never reviewed by fewer lenses than the kind of defect it could introduce. Reviewer gates re-run in every `impl` round, not just round 1.
- **Round 3:** plan conformance, plus one **fresh-eyes whole-stage read** by a subagent given **no prior round**, briefed to find places where two separately sound decisions jointly break the default path. A scoped look at the fix commits cannot, by construction, find a defect that lives between two decisions it was not shown. In `_starter`'s longest review cycle, five scoped passes each found only defects in the previous pass's fixes. A whole-document fresh-eyes pass is what ended the cycle.

**Gates the reviewer runs, `impl` stage only:**

- **Always:** the author gates again, at the reviewed SHA.
- **If the diff reaches `packages/bot/`, `packages/executor/`, or anything run against the server:** `npm run smoke`, then `npm run test:integration`, and the relevant `demo:*`. Follow CLAUDE.md's dev-server rules. Never start or stop the backend without Dorel's say-so.
- **If prompt text changed:** `npm run agent:probe` with several replicates, even when the author already ran it. It is token-free, and a second set of processes is exactly the cross-process evidence CLAUDE.md asks for. **Report both sets of numbers. Do not assert on them.**
- **Check §6.7 before any of these.**

### 5.4 Verify before recording

Subagents produce false positives. **Check every finding against the code or document before writing it down.** A false finding costs Ricky tokens to read, check and dispute. That is the exact cost this protocol exists to remove. A finding you could not verify is either dropped, or recorded as `Minor` with "unverified" in its body. It is never recorded as blocking.

**You classify, not the subagents.** A persona's severity is an estimate. You set the final severity, origin and fix class with §7.

### 5.5 Writing findings

`<stage>-r<N>-findings.md`, from [`_templates/findings.md`](reviews/_templates/findings.md).

- **Blocking findings (Critical, Material) come first, in full.** Each has:
  - an ID and a location (`file:line`),
  - **the cited lines quoted inline**, at most ~10. The author's instance usually starts cold each round, and an excerpt lets it check a straightforward finding without opening and re-reading the file. That reading is the cost this protocol is meant to remove.
  - a concrete failure scenario,
  - the lens, the origin and the fix class,
  - and a **recommended fix**, specific enough that the author can accept it as written. That saves a confirmation exchange.
- **For a `mechanical` finding, the recommended fix is the literal change.** If you cannot state it literally, it is not mechanical.
- **Mark any finding where Track A code is implicated `Seam: Track A`.** That covers a fix that belongs on the executor side, or Track B being right and Track A wrong. You wrote Track A, so you are not a neutral judge of that seam. The mark makes the conflict visible instead of leaving it to your self-restraint. Seam findings are never quietly made `inherited` or Minor, and the PR comment names them, so Ricky sees them without opening the file. **Their fix on the Track A side is Dorel's work, not the author's.**
- **Minor findings go in one compact table.** They never block.
- **End with the verdict and the budget line** (§6.4).

Commit the findings **only** to the cycle folder, then push and post the notification:

```bash
git switch <branch> && git pull --ff-only        # the untracked findings file comes along
git add docs/reviews/<cycle>/ && git commit -m "review(<stage>-r<N>): findings"
git push                                          # if rejected because the author pushed meanwhile:
                                                  # git pull --rebase && git push
```

That `--rebase` only replays your own unpushed commit onto the author's, so no published SHA changes and §8 rule 2 is not broken.

**Findings files are append-only history.** Never rewrite a previous round's file. A correction goes in the next file, quoting what it corrects.

### 5.6 Confirming a response

Only needed when a response contains `propose`, `dispute` or `needs-human` rows. Write `<stage>-r<N>-confirmation.md`. This is a reading task, not a bundle, and **it is not a round**: the round counter only moves when the author writes the next request. Answer only those rows:

| Row | Your answer |
|---|---|
| `propose` | `confirmed` · `confirmed-with-change` (state the change) · `rejected` (why, and what would be acceptable) |
| `dispute` | `withdrawn` (the author is right; the finding closes) · `upheld` (with the evidence that answers the author's) |
| `needs-human` | `escalated`: agree it belongs to the humans and add it to `ESCALATION.md` now. Or explain why it is not a human question, which the author then treats as `upheld`. |

**That is the only exchange a finding gets.** After a `rejected` or `upheld`, the author either takes your fix or escalates (§4.5). You never answer a second proposal or a second dispute on the same finding. If the author's next request marks the ID `escalated`, add it to `ESCALATION.md` before reviewing anything else.

---

## 6. Mechanics common to both

### 6.1 Files and layout

```
docs/reviews/
  _templates/                        request · findings · response · confirmation · escalation
  2026-09-20-phase-4-retry-policy/   one folder per unit; date = first request
    spec-r1-request.md               author
    spec-r1-findings.md              reviewer
    spec-r1-response.md              author
    spec-r1-confirmation.md          reviewer, only if needed
    spec-r2-request.md               author
    ...
    plan-r1-request.md
    ...
    impl-r1-request.md
    ...
    ESCALATION.md                    reviewer drafts, humans decide; only if needed
```

**One author per file, and neither side ever edits the other's.** That is what makes pushing to the same branch safe. The author commits code and cycle files; the reviewer commits only new cycle files. So the two histories never touch the same path, and a push rejected because the other side got there first is fixed by `git pull --rebase && git push`. That replays only your own unpushed commits, so it never rewrites anything already cited.

### 6.2 Finding IDs

`<S><round>-<severity><n>`:

- `S` is the stage: `S` spec, `P` plan, `I` impl.
- `severity` is `C` Critical, `M` Material or `m` Minor.

Examples: `S1-C1`, `P2-M3`, `I1-m4`. **IDs never change and are never reused.** A finding raised in round 1 and still open in round 3 is still `S1-C1`.

### 6.3 Notifications

Every file push is followed by **one** PR comment in this exact shape. Keep it short: the file is the content, and the comment only rings the bell.

```
[review] <stage> r<N> <kind> @ <sha7> — <counts or state> — <path>
@<other side's GitHub login>
```

Examples:

```
[review] impl r1 request @ 3fa91c2 — ready for review — docs/reviews/2026-09-20-phase-4-retry-policy/impl-r1-request.md
@onetruezman

[review] impl r1 findings @ 3fa91c2 — 1 critical · 2 material · 4 minor — FOLD AND RE-REVIEW — docs/reviews/…/impl-r1-findings.md
@rickyzam
```

GitHub logins: Ricky is `rickyzam`, Dorel is `onetruezman`. The humans still start each instance themselves, e.g. "review round 1 is up." **Neither instance polls GitHub on a timer.** Waiting costs tokens and returns nothing.

### 6.4 The round's verdict and budget line

Every findings file ends with exactly one verdict:

- **FOLD AND RE-REVIEW.** Blocking findings exist, and this is round 1 or 2.
- **CONVERGED.** Zero open blocking findings with origin `original` or `fold`, every prior blocking finding verified fixed or closed, and **no escalation still waiting on the humans**. This can happen at any round, including round 1. A round 3 with only Minor findings left is CONVERGED.
- **ESCALATE.** Round 3, and blocking findings remain.

**Escalated items do not stop the other findings.** A single finding can go to the humans at any round, through `needs-human` or an exchange that ended in `escalated` (§4.5). When that happens, the verdict for everything else is still FOLD AND RE-REVIEW or CONVERGED. Add a line `Escalated, awaiting humans: <IDs>`. A stage cannot be CONVERGED while that line lists anything undecided; it stays open until the humans record a decision.

And one budget line with bare counts, so the protocol itself can be judged later (§9):

```
Round budget — 5 dispatches · blocking 3 (original 2 · fold 1) · minor 4 · registered 1 inherited · false positives dropped 2
```

### 6.5 Convergence, escalation, merge

**When a stage has CONVERGED,** the author moves to the next stage. After `impl` converges, the author marks the PR ready. **Ricky merges.**

**Use a merge commit, never squash or rebase.** Findings cite SHAs from the branch. A squash deletes them from history, and the whole review record becomes unverifiable.

**When a stage hits ESCALATE, or a single finding is escalated,** the reviewer writes or appends to `ESCALATION.md`. For each open item it gives:

- the finding ID,
- the author's position and the reviewer's position, each in two or three sentences with evidence,
- the options, with what each costs,
- the reviewer's recommendation.

Push it and notify **both** humans. **The humans decide, and the decision is recorded in that file**: who decided, the date, and what was decided. No fourth round runs unless the humans ask for one. The author then acts on the decision. The reviewer verifies it only if the humans say to.

**When an `impl` finding shows the converged spec or plan was wrong,** do not reopen the earlier stage, and do not reset its round counter. Handle it inside the `impl` round:

- The reviewer marks the finding `Amends: spec §<n>` (or `plan Task <n>`), fix class `design`.
- The author proposes the spec or plan edit **and** the code change together.
- The reviewer checks both in the same round, running `coherence` over the amended document.

**One exception:** if the amendment changes something agreed between the tracks, the humans decide it (`needs-human`). That covers the contract, a recorded decision such as Phase 5 spec §7, or an assumption Track A built on. This is a finding-sized repair, not a new cycle. A spec that is wrong everywhere is an escalation, not an amendment.

### 6.6 Waiting is not idling — stacked branches

- **`spec` and `plan` reviews block.** Planning against an unconverged spec, or implementing an unconverged plan, is building on work that may change.
- **`impl` review does not block.** While it runs, the author may start the next unit on a branch **based on the branch under review**. Only a **Critical** finding on the lower branch should stop work on the stacked one.
- **Bring the lower branch's fixes and merge up with `git merge`, never `git rebase`.** Merge `main` into the stacked branch after the lower branch lands, and merge the lower branch in whenever its fixes matter. That way the stacked branch can have its own open review request at the same time without rewriting a single cited SHA, and it is consistent with merge-commit-only (§8).

### 6.7 Shared live resources on bellatrix

Both instances, and both humans, use **one** backend, **one** arena and **one** GPU. The integration suite runs `fileParallelism: false` because concurrent bots fight each other, but that only serialises tests *within* one run. **Two runs started from two instances collide in exactly the way that setting exists to prevent**:

- both rebuild the same arena under each other,
- teleports land a bot on a platform the other run just cleared,
- and every failure looks like a code bug.

The same applies to `bench:*`, which moves bots across the benchmark world. Two `agent:probe` runs share the GPU. That slows both, but nobody has measured whether it changes answers. The probe sets no timeout of its own, so it should only lose time, not results.

The rule:

1. **One live-server job at a time**, across both instances: `test:integration`, `smoke`, any `demo:*`, `bench:*`.
2. **Before starting one, check nobody else is mid-run.** Run `list` in the server console (`tmux send-keys -t mc 'list' Enter`, then `tmux capture-pane -p -t mc | tail -3`). Any connected bot name means someone else is running: wait. A connected **player** is a person, not a run. Tests don't need to wait for them, but do not stop or restart the server while they are on (CLAUDE.md).
3. **A red integration run while another job may have overlapped proves nothing.** Re-run it alone before recording any finding from it.
4. **Prefer not to overlap `agent:probe` with the other side's `agent:probe` or `demo:*` runs** that call the model. This rule is looser than 1–3, because a shared GPU costs time, not correctness, as far as anyone knows.

If this rule proves too loose in practice, the next step is a lock file on bellatrix, not more prose. Ricky should say in the adoption PR if he wants that from the start.

---

## 7. Classifying a finding

### 7.1 Severity

| Severity | Blocks? | Examples on this repo |
|---|---|---|
| 🔴 **Critical** | Yes | Wrong behaviour on the default path. A shared-surface change without recorded agreement. `runContractSuite` weakened. A red gate. `packages/agent` gaining a Mineflayer or executor dependency. A plan that cannot be executed as written. A spec that contradicts an agreed contract decision. |
| 🟡 **Material** | Yes | A real defect on an edge path (abort, timeout, reconnect). A test that cannot fail, or a spec-promised behaviour with no test. A **claim presented as measured that nothing measured** (this repo's docs distinguish MEASURED from assumed, and a false MEASURED misleads every later reader). A spec ambiguity an implementer would have to guess at. A prompt change with no probe numbers. A per-`FailureReason` retry branch added to the loop outside its agreed phase. |
| 🟢 **Minor** | No | Naming, clarity, comment accuracy, a cheaper equivalent. Anything the author may fix mechanically or leave. |

### 7.2 The location test: what may block

**A finding blocks only if an implementer following the work as written would produce different code, different tests or different behaviour than intended.** Name the line of code, the test assertion or the file that would come out wrong. If you cannot name it, the finding does not block, whatever label it arrived with.

A mistake **inside the review record itself** never blocks. That covers a miscounted tally, a stale link in a findings file, or a wrong round number. It gets fixed in the next file. `_starter` watched this class of finding drive five review passes on its own: a record generating findings about itself is not evidence the work needs more review.

### 7.3 Origin

| Origin | Meaning | What happens |
|---|---|---|
| `original` | A defect in what this unit set out to produce. | Fixed in this cycle. |
| `fold` | A defect introduced by a previous round's fix. | Fixed in this cycle. **Two consecutive rounds whose blocking findings are all `fold`** means the work has stopped improving and the fixes are generating their own findings. The reviewer says so in the verdict and recommends escalating early. |
| `inherited` | Already on `main` before the unit began: Track A code, or older Track B. | **Registered, not fixed here, and never blocking.** Repairing inherited code inside a unit silently turns the unit into a redesign that nobody reviewed as one. Track A defects go to Dorel. Track B defects become a GitHub issue. |

**`inherited` must be shown, not asserted, and the check runs both ways.** The reviewer cites it on `main`, e.g. `git show main:<path>` at the line. A defect that cannot be shown to predate the unit is `original`. But before recording a finding against code the unit only *touched*, the reviewer runs that same check. The author may also dispute an `original` label with that evidence (§4.4). Otherwise pre-existing debt quietly becomes the author's to fix.

### 7.4 Fix class

Set by the reviewer, for the author's fold rule (§4.4):

- **`mechanical`** — the change is fully specified, touches nothing else, and needs no judgement.
- **`design`** — everything else.

### 7.5 Fold escapes

A prior-round finding marked `fixed` or `accept-recommended` whose fix the reviewer cannot find at the cited SHA is re-raised under **its original ID** as **Material, fold escape**. It counts as blocking.

---

## 8. Hard rules, in one place

For both instances. If one of these conflicts with a skill's default behaviour, **this document wins**.

1. **One author per file.** The author never edits reviewer files; the reviewer never edits anything outside the cycle folder.
2. **Never rewrite a pushed commit on a branch with an open review request.** No amend, no rebase of pushed history, no force-push, and stacked branches take `main` by merge. `git pull --rebase` of your own *unpushed* commit is fine.
3. **The author fixes nothing that has no finding ID, and nothing `design`-class without a confirmed or accepted fix.**
4. **The reviewer fixes nothing at all.**
5. **At most 3 rounds per stage.** Then ESCALATE, and the humans decide.
6. **Merge commits only.**
7. **The shared-surface rule outranks everything here.** No review verdict authorises a change to `packages/contract/` or `packages/mock-executor/`. Only the humans' recorded agreement does.
8. **Neither instance polls.** The humans start each turn.
9. **One live-server job at a time on bellatrix** (§6.7).

## 9. Judging whether this works

The protocol is itself an experiment. After the **first three cycles**, Dorel's instance writes a short retrospective at `docs/reviews/RETROSPECTIVE-<date>.md`, built from the budget lines and PR timestamps and nothing else:

- rounds per stage,
- blocking findings by origin,
- false positives dropped,
- how many disputes the author won,
- escalations,
- elapsed days from request to convergence,
- and — the real question — **Track B's commits and units landed per week, before and after**.

Pre-registered, so the result cannot be argued into shape afterwards:

- **If most cycles hit the round cap with mostly `fold` findings,** the fold rule is not doing its job. Revise §4.4.
- **If the author wins more than a third of disputes,** the reviewer is recording unverified findings. Revise §5.4.
- **If Track B's throughput has not improved,** the budget was never the bottleneck. Say so, and stop the ceremony.

## 10. Where this came from

This adapts Dorel's `_starter` project review machinery to two people and two instances:

- **The receiver-side peer review, its sibling findings files and its convergence check** come from the `peer-review-cycle` skill.
- **The location test, origin classification, fix-induced churn, the fresh-eyes final pass and the parallel-dispatch cap** come from `_starter/docs/PLAN-REVIEW-PROCESS.md` §§4, 12–14.

What is new here is the split of *who* folds from *who* reviews, and the fix-class rule that makes that split safe.
