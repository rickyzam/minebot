# Hardware and Feasibility — Minecraft AI Agent

The host machine (a 16-core/32-thread desktop CPU, 32GB DDR5, a 16GB consumer GPU, headless Linux) comfortably covers this project. The GPU/CPU aren't the constraint; the one real thing to watch is system RAM.

---

## GPU / VRAM — not the bottleneck

The agent's LLM planning layer only needs to run periodically (whenever the bot needs a new subgoal or hits something unexpected), not per-tick — this is not real-time inference at 20 ticks/sec. And there's no vision model in the loop at all, which is the piece that would have actually stressed the GPU.

- A 14B-class model at Q4 uses roughly **9GB VRAM**, leaving comfortable headroom on the 16GB card.
- One shared model instance serves every bot and every behavior (mining, building, combat judgment, chat) for why specialized per-behavior models aren't needed. VRAM cost stays flat regardless of how many behaviors the toolbox covers.
- The only reason VRAM would become a real constraint is running genuinely *different* models simultaneously (not planned here).

## CPU — essentially free

Mineflayer's own game-logic loop (pathfinding, movement, block interaction) is lightweight JS. A 16-core/32-thread desktop CPU has enormous headroom here — this was never the bottleneck. Minecraft server *tick* performance itself also benefits from strong single-thread performance (the server's world tick loop is largely single-threaded), which should outperform most typical home-hosting hardware.

## Multi-bot scaling

The actual limiter for running more than one bot is **Ollama's request concurrency**, not CPU or VRAM:

| Bot count | What limits you |
|---|---|
| 1–3 | Nothing meaningful — comfortable as-is |
| 4–8 | `OLLAMA_NUM_PARALLEL` tuning becomes the relevant lever, still one shared 14B instance |
| 8+ | Worth benchmarking actual queueing latency under load; consider a smaller model (7–8B) to trade planning quality for parallel throughput |

By default Ollama queues concurrent requests to one model instance rather than parallelizing them — fine when bots aren't all deciding at the same instant, which is the common case. `OLLAMA_NUM_PARALLEL` lets multiple requests run concurrently against the same loaded model; the 16GB card has headroom for this since a single 14B model only uses ~9–10GB.

## RAM — the one real caveat, now that the server is moving here too

The server has **32GB total system RAM**. Once the Minecraft server (Fabric, 1.21.x, currently run with `-Xmx16G`) also runs on the server:

- The server's JVM heap alone claims **16GB**, plus some JVM/off-heap overhead (typically another 1–2GB) — call it **~17–18GB** committed to the server process.
- That leaves roughly **14GB** for the OS, Ollama (mostly VRAM-resident, but some system RAM overhead), and anything else running at the same time.
- **Practical check once the server is running:** watch `free -h` and `htop` on the server during normal server play *and* during a heavy dev sweep at the same time, to see actual headroom rather than guessing from the math above.

This is a genuine thing to monitor, not a reason to expect problems — 14GB of headroom is generally fine for Ollama + OS + light background work, it just means "run a giant Claude Code sweep and expect the Minecraft server to lag" is a real possible interaction to watch for, not a theoretical one.

