## What this changes

<!-- What and why. If it changes behaviour, say what a reader would observe differently. -->

## Verification

CI runs the typecheck, the 50 unit tests, and the structural invariants. It **cannot** run the integration suite — that needs a live Minecraft server and a tmux session to drive its console — so green CI does not mean the Mineflayer side works.

If this PR touches `packages/executor/`, `scripts/`, or anything that talks to the game, run the integration suite locally and confirm:

- [ ] `npm run test:integration` passes against the dev server
- [ ] Re-ran it at least twice — bot behaviour against real terrain can vary between runs
- [ ] No bots left connected afterwards (`list` in the server console)

Not applicable for docs-only or planning-track changes.

## Contract changes

- [ ] This PR does **not** change `packages/contract/` or `packages/mock-executor/`

If it does, both tracks build against those, so say what changed and confirm it has been agreed. See [spec §9](docs/superpowers/specs/2026-09-07-minecraft-agent-design.md) for changes already proposed and pending agreement.

## Notes

<!-- Anything a reviewer would otherwise have to discover: deviations from the plan,
     things you measured, known gaps you deliberately left. -->
