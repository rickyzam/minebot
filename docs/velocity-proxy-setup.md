# Velocity proxy setup

How the dev environment is wired, and how to rebuild it. The proxy lives outside
this repository, so without this file the setup is unreproducible.

## Why

The bots have no Mojang accounts. The obvious fix — set `online-mode=false` on
the server — has two costs on a world anyone cares about:

- Every player's UUID changes (from their Mojang UUID to `MD5("OfflinePlayer:<name>")`),
  so **inventories, ender chests, advancements, statistics, op status and
  whitelist entries are all orphaned**. The world itself is unaffected — blocks,
  builds and chest *contents* are not keyed by UUID — but everything attached to
  a player is.
- Nothing authenticates. Anyone who can reach the port can join claiming any
  username, including an operator's.

A proxy separates the two concerns. Velocity authenticates humans against Mojang
and forwards them with their **real UUID**, so nothing is orphaned and the door
stays locked. The backend runs in offline mode but refuses any login without
forwarding data signed with a shared secret, so "offline" never means "open".

Bots then connect straight to the backend and sign their own forwarding payload.
They cost nothing, there is no bypass hole exposed to the internet, and humans
are unaffected.

## Topology

```
   players ──► Velocity  0.0.0.0:25565   online-mode = true   (session: velocity)
                  │
                  │ modern forwarding, HMAC-SHA256 signed
                  ▼
               backend  127.0.0.1:25566  online-mode = false  (session: mc)
                  ▲
                  │ same signed forwarding, secret read locally
   bots ──────────┘
```

The backend binds to loopback, so only this machine can reach it at all.

## Components

| | Version | Where |
|---|---|---|
| Velocity | 3.5.1 | `~/minecraft/velocity/velocity.jar` |
| FabricProxy-Lite | 2.11.0 | backend `mods/` — teaches a Fabric server Velocity modern forwarding |
| Shared secret | generated | `~/minecraft/velocity/forwarding.secret` |

Velocity 3.x rather than 4.x deliberately: FabricProxy-Lite implements 3.x's
modern-forwarding protocol.

## Rebuilding it

**1. Velocity.** Download the latest 3.x build from
`https://fill.papermc.io/v3/projects/velocity/versions/3.5.1/builds` into
`~/minecraft/velocity/`, run it once to generate `velocity.toml` and
`forwarding.secret`, then set:

```toml
bind = "0.0.0.0:25565"
online-mode = true
player-info-forwarding-mode = "modern"
forwarding-secret-file = "forwarding.secret"

[servers]
minebot = "127.0.0.1:25566"
try = ["minebot"]

[forced-hosts]
# must be empty — the generated samples reference servers that no longer exist
# and Velocity refuses to start with "Your configuration is invalid"
```

**2. Backend.** Put `FabricProxy-Lite` in `mods/`, and write
`config/FabricProxy-Lite.toml` with the *same* secret:

```toml
secret = "<contents of forwarding.secret>"
hackOnlineMode = true
hackEarlySend = false
hackMessageChain = true
```

Then in `server.properties`:

```properties
server-port=25566
server-ip=127.0.0.1
online-mode=false
```

`server-ip` is load-bearing: it is what keeps the offline backend off the
network.

**3. Run both**, each in its own tmux session — `velocity` and `mc`. Start the
backend first so the proxy has somewhere to send people.

## Verifying it

```bash
npm run smoke
```

Reports `velocity: forwarding answered=true (backend wanted v4)`. For the
negative case — proof the backend is genuinely locked, not merely reachable —
`npm run test:integration` includes tests that connect with forwarding disabled
and with a wrong secret, and expect both to be refused.

## Moving the real survival world behind it

The same three steps, plus:

- Keep `online-mode=false` **only** on the backend, never on a directly-reachable
  server.
- Bind the backend to `127.0.0.1`, or firewall its port, before starting it. A
  modern-forwarding backend rejects unsigned logins, but defence in depth is
  cheap here.
- Player UUIDs are preserved, so **no player data migration is needed** — that is
  the whole point of choosing forwarding over a plain offline flip.
- Bots reach it exactly as they do here: directly, on the backend port, with the
  secret.
