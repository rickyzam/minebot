# Dev server units

The two processes the integration tests, demos and benches depend on, as
**systemd user units**. Copies of what is installed at
`~/.config/systemd/user/`, kept here so a machine rebuild does not lose them and
so a reviewer can see them without shell access to the box.

| | Port | Autostart | tmux |
|---|---|---|---|
| `mc.service` — Fabric backend | `127.0.0.1:25566` | **no, deliberately** | session `mc`, default socket |
| `velocity.service` — Velocity proxy | `0.0.0.0:25565` | yes | session `velocity`, **own socket** |

## Install

No root. User units and self-lingering are both unprivileged.

```bash
cp ops/systemd/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
loginctl enable-linger "$USER"      # so units run at BOOT, not at first login
systemctl --user enable --now velocity
systemctl --user start mc           # `start`, never `enable` — see below
```

## Why the backend is not autostarted

The proxy is stateless: no world, no player data, safe to restart at any time.
A world is not. Bringing one up should stay a deliberate act, and the
integration suite assumes it owns the arena — so `mc.service` has no
`[Install]` section and never starts at boot.

**The unit earns its place at the other end.** systemd stops every *active*
unit during shutdown whether or not it is enabled, and it waits for `ExecStop`
to finish. `mc.service`'s `ExecStop` sends the console `stop` and then waits for
the tmux session to disappear, because the session ending is the evidence the
server exited on its own.

That fixes a measured problem rather than a theoretical one. Three of the seven
runs before this landed — 2026-09-08, -09 and -11 — end mid-activity in the
logs with no `Stopping server`, no `Saving worlds` and no
`All dimensions are saved`. Roughly half of recent runs never flushed, because a
hand-started tmux session gets no ordered shutdown at reboot.

Verified 2026-09-12, `systemctl --user stop mc`:

```
Stopping server → Saving players → Saving worlds
All chunks are saved (×3 dimensions) → All dimensions are saved     [1.06s]
```

## Two details that are easy to get wrong

**The proxy uses its own tmux socket; the backend uses the default one.** Not an
inconsistency. The integration suite drives the backend console with
`tmux send-keys -t mc` and `mc-console.ts` hardcodes that session name, so the
backend has to stay where the tests can reach it. The proxy has no such
constraint, and isolating it means `systemctl --user stop velocity` cannot take
the backend's tmux server down with it — on a shared socket that server sits in
the unit's cgroup, and the backend would die without flushing. Reach the proxy
with `tmux -L velocity attach -t velocity`.

**`mc.service` refuses to start when something already listens on 25566**, and
otherwise clears a leftover `mc` session before starting. Both guards are
measured: the unit failed its own first start with `duplicate session: mc`,
because stopping a hand-started server leaves the session alive at a shell
prompt. The refusal is what stops two servers ever writing one world, and it was
verified firing without touching the live session.

## When the server is down

`requireBackend()` (`packages/executor/src/require-backend.ts`) is the
integration project's `globalSetup` and runs at the top of `smoke` and every
`demo:*`. A stopped backend then produces one actionable line instead of 134
connection failures. It does not start anything — a test run must not bring up
shared infrastructure on its own.
