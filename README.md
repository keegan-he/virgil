```
                    ___      ___ ___  ________  ________  ___  ___
                   |\  \    /  /|\  \|\   __  \|\   ____\|\  \|\  \
                   \ \  \  /  / | \  \ \  \|\  \ \  \___|\ \  \ \  \
                    \ \  \/  / / \ \  \ \   _  _\ \  \  __\ \  \ \  \
                     \ \    / /   \ \  \ \  \\  \\ \  \|\  \ \  \ \  \____
                      \ \__/ /     \ \__\ \__\\ _\\ \_______\ \__\ \_______\
                       \|__|/       \|__|\|__|\|__|\|_______|\|__|\|_______|

              ┌─────────────────────────────────────────────────────┐
              │  "I am he who guides you through the dark places."  │
              │                    — Virgil, The Inferno            │
              └─────────────────────────────────────────────────────┘
```

**Your personal AI agent.** Always on. Always watching. Lives in Discord. Thinks with two brains.

Virgil is a self-hosted AI agent framework that intelligently routes conversations between a fast local model (Ollama) and a powerful cloud model (Claude). Simple questions get instant local answers. Complex reasoning gets escalated to the cloud. You never have to think about which model to use — Virgil decides for you.

Named after the guide in Dante's *Divine Comedy* — knowledgeable, steady, and purposeful.

---

## What can Virgil do?

**Talk to you on Discord** — full conversational AI with threaded replies, typing indicators, slash commands, and smart message splitting that respects code fences.

**Think with two brains** — a local Ollama model handles quick tasks at blazing speed. When things get complex, Virgil seamlessly routes to Claude for deep reasoning and tool use. If Ollama goes down, Claude catches everything. Zero downtime.

**Monitor what matters to you** — Virgil watches things in the background and DMs you when something changes:
- **Spotify** — track artist follower counts and popularity milestones
- **1001Tracklists** — catch new tracklist appearances
- **Job boards** — scan for AI/ML roles on Envoy
- **Daily briefing** — wake up to weather, GitHub activity, and a summary of what happened overnight

**Use tools** — file operations, web fetching, system monitoring, shell commands (whitelisted for safety). Skills are modular and easy to extend.

**Remember conversations** — SQLite-backed memory with automatic context compaction. When conversations get long, Virgil summarizes older turns so context stays sharp.

**Stay healthy** — a heartbeat monitor pings backends every 30 seconds. If something goes down, Virgil reroutes traffic automatically and logs the event.

---

## Standing on the shoulders of giants

Virgil didn't emerge from thin air. Its architecture draws directly from two projects that shaped how personal AI agents are built and secured: [OpenClaw](https://github.com/openclaw/openclaw) and [NVIDIA NemoClaw](https://github.com/NVIDIA/NemoClaw).

If you've worked with either, you'll recognize the DNA immediately. If you haven't — here's why that matters.

### The gateway pattern (from OpenClaw)

OpenClaw established the definitive architecture for personal AI assistants: a **gateway-centric message bus** that normalizes input from any channel, routes it through an agent runtime, and dispatches responses back. It connects to 24+ messaging platforms, runs a skills/plugin ecosystem, and manages multi-agent sessions — all through a single WebSocket control plane.

Virgil inherits this core pattern wholesale:

| OpenClaw Pattern | Virgil Implementation |
|---|---|
| Gateway control plane | `src/gateway/gateway.ts` — central message bus that receives, routes, dispatches, and records |
| Channel adapters (WhatsApp, Telegram, Slack, etc.) | `src/channels/` — unified `InboundMessage`/`OutboundMessage` normalization across Discord + console |
| Skills platform (ClawHub registry) | `src/skills/registry.ts` — modular `Skill` interface with `register()`, `execute()`, `toPromptSummary()` |
| Multi-agent routing | `src/gateway/router.ts` — two-tier classification (fast-path regex + Ollama ML) to route between backends |
| Session management | `src/gateway/session.ts` — per-user, per-thread session isolation with context windowing |
| Event-driven observability | `GatewayEvent` system — `message_received`, `route_decided`, `response_ready`, `error` |
| Pi Agent runtime (RPC) | Claude backend spawns `claude` CLI as a managed subprocess with stream-json output parsing |

The gateway is the heart. Every message — whether it comes from a Discord thread, a slash command, or the console REPL — gets normalized into the same `InboundMessage` shape, processed through the same pipeline, and recorded in the same store. Adding a new channel means implementing one adapter. The gateway doesn't care where messages come from.

### The security model (from NemoClaw)

NemoClaw is NVIDIA's answer to the question every agent builder eventually hits: *"How do I give an AI agent access to my system without giving it the keys to the kingdom?"*

NemoClaw wraps OpenClaw inside NVIDIA's OpenShell sandbox — Landlock LSM for filesystem control, seccomp for syscall filtering, network namespaces for isolation, deny-by-default policies for both filesystem and network, per-binary network rules, credential stripping, and inference proxying so the agent never touches raw API keys.

That's the right approach for enterprise deployments with Docker and dedicated infrastructure. But for a personal agent running on your laptop? You need the same *philosophy* without the operational overhead. Virgil distills NemoClaw's security principles into application-level guardrails:

| NemoClaw Security Layer | Virgil Equivalent |
|---|---|
| Landlock filesystem policies (deny-by-default, read-only mounts) | `safePath()` in `file-ops.ts` — every file operation resolves against a base directory and rejects path traversal (`../../../etc/passwd` → blocked) |
| Per-binary network rules (only specific executables can reach specific endpoints) | Command whitelisting in `system.ts` — only 20 safe commands (`ls`, `cat`, `grep`, `df`, etc.) can execute. Everything else is rejected. Uses `execFile()` with explicit arg arrays, not shell string eval — no injection possible |
| Credential separation (agent never sees API keys; gateway injects at proxy time) | Claude CLI runs as a subprocess with `cwd` set to `$HOME`, not the project directory — the agent cannot read its own source, config, or `.env`. Credentials live in environment variables, never in agent-accessible state |
| Inference proxy (all LLM calls routed through gateway) | All inference flows through the Gateway's `process()` pipeline — backends are never exposed directly to channels |
| Sandbox process isolation (non-root user, capability drops) | Claude subprocess lifecycle tracking with `activeProcesses` set and `killAll()` on shutdown — no zombie processes, no orphaned CLI sessions |
| State integrity verification | SQLite with WAL mode, foreign keys enforced, transactional turn recording — atomic writes prevent partial state corruption |

The principle is the same: **the agent should have the minimum access it needs to do its job, and nothing more.** NemoClaw enforces this at the OS/container level. Virgil enforces it at the application level — path validation, command whitelisting, process isolation, credential separation.

### Why this matters — and where Virgil goes further

OpenClaw is a phenomenal project. 341K+ stars. 24+ messaging platforms. A full plugin ecosystem. It is the Swiss Army knife of personal AI agents.

NemoClaw adds enterprise-grade security to that foundation — sandboxing, policy engines, managed inference. It's the right choice when you're deploying agents in production environments with compliance requirements.

But here's the thing: **most people don't need a Swiss Army knife. They need a scalpel.**

OpenClaw's power comes with proportional complexity — a massive TypeScript monorepo, WebSocket control planes, plugin registries, multi-device node systems, and a dependency tree that would make your `node_modules` weep. NemoClaw adds Docker, Landlock, seccomp, and an NVIDIA inference stack on top — and that last part is the kicker.

### No NVIDIA hardware required. Seriously.

NemoClaw is built on NVIDIA's OpenShell runtime. Its default inference model is `nvidia/nemotron-3-super-120b-a12b` running on NVIDIA endpoints. The entire security sandbox — Landlock LSM, seccomp filters, network namespaces — is designed for Linux containers running on NVIDIA infrastructure. It's powerful, but it's also a commitment: you're buying into a hardware and cloud ecosystem just to run a personal AI agent.

Virgil doesn't care what's in your machine.

Ollama runs on **any hardware** — Apple Silicon, Intel, AMD, even CPU-only. There's no CUDA dependency, no GPU driver matrix to debug, no container runtime to configure. A MacBook Air runs `qwen2.5-coder:1.5b` comfortably. Your five-year-old Linux box can handle it. The cloud backend is Claude via a CLI subprocess — no GPU allocation, no inference endpoint provisioning, no NVIDIA API keys.

This isn't a compromise. It's a design choice. The local model handles classification and simple tasks — workloads that don't need 120B parameters on an A100. The cloud model handles the heavy lifting — and you're paying for intelligence on demand, not GPU hours by the minute. You get the same dual-brain architecture, the same security principles, the same gateway pattern — running on whatever hardware you already own.

NemoClaw is the right answer if you have NVIDIA infrastructure and enterprise compliance requirements. Virgil is the right answer if you have a laptop and a weekend.

### Where Virgil goes further

Virgil takes a different bet:

**Dual-brain routing that neither project offers.** OpenClaw routes messages to different agents. Virgil routes to different *intelligence tiers* — a fast local model for simple tasks, a powerful cloud model for complex reasoning. The Router uses a two-tier classification system: instant regex fast-path matching for obvious patterns (0ms latency), then Ollama-based ML classification with confidence scoring for everything else. If confidence drops below 0.7, if the classifier times out (2s), or if Ollama is down entirely — Claude catches it. You get local speed when it's sufficient and cloud intelligence when it matters, with automatic failover at every layer. No other personal agent framework does this.

**Context compaction built into the memory layer.** As conversations grow, Virgil automatically summarizes older turns via Ollama, prunes the database, and injects the summary as a synthetic turn — keeping the context window sharp without losing long-term memory. This runs non-blocking after every message. OpenClaw leaves context management to the model provider's window limits.

**Zero-key monitoring.** Spotify metrics scraped from public pages. Weather from wttr.in. GitHub activity from your already-authenticated `gh` CLI. DJ support tracking from 1001Tracklists. Job alerts from public career pages. Daily briefings assembled from all of the above and delivered to your Discord DMs at 8am. No API keys, no OAuth flows, no billing dashboards. Virgil auto-detects your DM channel from the first message you send it — zero configuration for notifications.

**Single-file deployment.** `npm install && npm run dev`. No Docker. No containers. No sandbox runtimes. No infrastructure. Virgil runs on your machine as a single Node.js process with a SQLite database. Fork it, hack it, make it yours. The entire codebase is ~2,500 lines of TypeScript across 20 files.

**A soul, not just a system prompt.** `config/SOUL.md` defines Virgil's identity, personality, and rules as structured markdown — parsed into discrete sections and injected into backend system prompts. Change who Virgil *is* by editing a markdown file. The config loader handles heading hierarchy, bullet extraction, and section-level injection. Your agent, your personality.

---

## Architecture deep dive

```
 ┌──────────────────────────────────────────────────────────────────┐
 │                        INPUT CHANNELS                            │
 │                                                                  │
 │   Discord Messages    Slash Commands    Console REPL             │
 │   (threads, DMs,      (/ask, /status,   (readline,              │
 │    attachments)        /skill)           /status, /skills)       │
 └────────────────────────────┬─────────────────────────────────────┘
                              │
                    InboundMessage normalization
                              │
 ┌────────────────────────────▼─────────────────────────────────────┐
 │                         GATEWAY                                  │
 │                     (central message bus)                         │
 │                                                                  │
 │  1. Session resolution (find or create by user+channel+thread)   │
 │  2. Context assembly (recent turns from SQLite, up to 30)        │
 │  3. Route classification (fast-path → Ollama ML → fallback)      │
 │  4. Backend dispatch (with full conversation context)             │
 │  5. Turn recording (atomic SQLite transaction)                   │
 │  6. Compaction check (non-blocking, triggers if threshold met)   │
 │  7. Event emission (route_decided, response_ready, error)        │
 │                                                                  │
 └──────────┬──────────────────┬──────────────────┬─────────────────┘
            │                  │                  │
            ▼                  ▼                  ▼
 ┌─────────────────┐ ┌────────────────┐ ┌──────────────────┐
 │     ROUTER      │ │    SESSION     │ │     SKILLS       │
 │                 │ │    MANAGER     │ │    REGISTRY      │
 │ Tier 1: Regex   │ │                │ │                  │
 │  fast-path      │ │ Per-user,      │ │ 9 built-in:      │
 │  (0ms, 0.95     │ │ per-thread     │ │ file-read/write  │
 │  confidence)    │ │ isolation      │ │ file-search/list │
 │                 │ │                │ │ web-fetch        │
 │ Tier 2: Ollama  │ │ Context        │ │ system-info      │
 │  classification │ │ windowing      │ │ process-list     │
 │  (JSON output,  │ │ (last N turns) │ │ shell-exec       │
 │  2s timeout)    │ │                │ │ disk-usage       │
 │                 │ │ Compaction     │ │                  │
 │ Fallback: if    │ │ flagging       │ │ Path traversal   │
 │  timeout, low   │ │                │ │ protection +     │
 │  confidence,    │ │                │ │ command          │
 │  or Ollama down │ │                │ │ whitelisting     │
 │  → Claude       │ │                │ │                  │
 └────────┬────────┘ └────────────────┘ └──────────────────┘
          │
 ┌────────┴────────────────────┐
 │                             │
 ▼                             ▼
 ┌──────────────────┐ ┌──────────────────┐
 │     OLLAMA       │ │     CLAUDE       │
 │    (local)       │ │    (cloud)       │
 │                  │ │                  │
 │ REST API client  │ │ CLI subprocess   │
 │ /api/chat        │ │ stream-json      │
 │ Streaming +      │ │ output parsing   │
 │ non-streaming    │ │                  │
 │                  │ │ System prompt    │
 │ Temperature 0.1  │ │ from SOUL.md     │
 │ for classifying  │ │                  │
 │                  │ │ cwd = $HOME      │
 │ 15s max timeout  │ │ (not project     │
 │                  │ │  directory)      │
 └──────────────────┘ └──────────────────┘
          │                    │
          └────────┬───────────┘
                   │
          OutboundMessage
                   │
 ┌─────────────────▼────────────────────────────────────────────────┐
 │                       OUTPUT CHANNELS                            │
 │                                                                  │
 │   Discord Reply         Console Output       Monitor Alerts      │
 │   (2000-char split,     (stdout)              (DM notifications, │
 │    code fence balance,                         rate-limited)      │
 │    typing indicators)                                            │
 └──────────────────────────────────────────────────────────────────┘


 ┌──────────────────────────────────────────────────────────────────┐
 │                     BACKGROUND SERVICES                          │
 │                                                                  │
 │  HEARTBEAT (30s)          MONITORS (scheduled)                   │
 │  ├─ Ollama health check   ├─ Spotify metrics ········ hourly     │
 │  ├─ Claude health check   ├─ 1001Tracklists ········· 6 hours   │
 │  ├─ Router state update   ├─ Envoy job alerts ······· 2 hours   │
 │  ├─ SQLite health log     └─ Daily briefing ········· 8:00 AM   │
 │  └─ State change events        ├─ Weather (wttr.in)             │
 │                                 ├─ Spotify snapshot              │
 │  COMPACTION (per-turn)          ├─ DJ support (24h)              │
 │  ├─ Threshold check             └─ GitHub notifications          │
 │  ├─ Ollama summarization                                         │
 │  ├─ Turn pruning            NOTIFIER (auto-detect)               │
 │  └─ Synthetic turn insert   ├─ Milestone alerts                  │
 │                              ├─ DJ support alerts                │
 │  MEMORY (SQLite + WAL)      ├─ Job alerts                       │
 │  ├─ sessions                ├─ Rate limiting (60s)               │
 │  ├─ turns                   └─ Message splitting (2000 char)     │
 │  ├─ health_logs                                                  │
 │  ├─ artist_metrics                                               │
 │  ├─ dj_support                                                   │
 │  ├─ daily_briefings                                              │
 │  └─ envoy_jobs                                                   │
 └──────────────────────────────────────────────────────────────────┘
```

### The routing engine

The Router is the decision-making core. It runs a two-tier classification pipeline on every inbound message:

**Tier 1 — Fast-path pattern matching (0ms).** Regex patterns catch obvious cases instantly. Greetings, thanks, farewells, and status checks route to Ollama at 0.95 confidence. Code blocks, analysis requests, research tasks, and explicit tool use route to Claude at 0.95 confidence. No model invocation needed.

**Tier 2 — Ollama ML classification (50-500ms).** If no fast-path matches, the Router sends the message to Ollama with a classification prompt. Ollama returns structured JSON: `{"classification": "simple|complex", "confidence": 0.0-1.0, "reason": "..."}`. If confidence falls below 0.7 on a "simple" classification, the Router escalates to Claude. If Ollama doesn't respond within 2 seconds, Claude catches it.

**Fallback chain.** Ollama unavailable (flagged by Heartbeat) → Claude. Classification timeout → Claude. Low confidence → Claude. JSON parse error → Claude. The system always errs on the side of quality.

### Session isolation

Every unique combination of (channel, userId, threadId) gets its own session. Two threads with the same user? Two separate sessions. No context bleed. Each session maintains its own turn history, compaction state, and context window — up to 30 recent turns assembled into the prompt on every message.

### Process lifecycle

Virgil prevents multiple instances via a PID lockfile (`data/virgil.pid`). On startup, it checks if an existing PID is still alive and removes stale locks. On shutdown (`SIGINT`/`SIGTERM`), it tears down in order: close readline → stop heartbeat → kill all Claude subprocesses → stop monitor tasks → close database → release lockfile. No orphaned processes, no dangling connections.

---

## Getting started

### Prerequisites

- **Node.js** >= 18 (`.nvmrc` included — just run `nvm use`)
- **Ollama** installed and running (`brew install ollama && ollama serve`)
- A **Discord bot token** (optional — console mode works without one)

### Install

```bash
git clone https://github.com/keegan-he/virgil.git
cd virgil
npm install
```

### Configure

1. Copy the example env and add your Discord token:
   ```bash
   cp .env.example .env
   ```

2. Pull the local model:
   ```bash
   ollama pull qwen2.5-coder:1.5b
   ```

3. Tweak `config/virgil.yaml` for your setup (models, channels, monitors, etc.)

4. Edit `config/SOUL.md` to give Virgil your own personality and rules.

### Run

```bash
# Development (hot reload)
npm run dev

# Production
npm run build && npm start
```

### Console commands

When running locally, you can chat directly in the terminal:

- `/status` — backend health check
- `/skills` — list registered skills
- `/briefing` — trigger a daily briefing on demand

---

## Project structure

```
virgil/
├── src/
│   ├── index.ts              # Entry point, bootstrap, console REPL, shutdown
│   ├── gateway/
│   │   ├── gateway.ts        # Central message bus + event system
│   │   ├── router.ts         # Two-tier classification (regex + Ollama ML)
│   │   ├── session.ts        # Per-user, per-thread session isolation
│   │   └── config.ts         # YAML + SOUL.md loader with env var interpolation
│   ├── backends/
│   │   ├── ollama.ts         # REST client — streaming + non-streaming + health
│   │   └── claude.ts         # CLI subprocess — stream-json parsing + lifecycle
│   ├── channels/
│   │   ├── discord.ts        # Full discord.js integration + slash commands
│   │   └── types.ts          # Unified InboundMessage / OutboundMessage types
│   ├── skills/
│   │   ├── registry.ts       # Modular skill interface + registration + discovery
│   │   ├── file-ops.ts       # Path-traversal-safe file operations (1MB limit)
│   │   ├── web-search.ts     # URL fetching with HTML stripping
│   │   └── system.ts         # Whitelisted shell + system monitoring
│   ├── memory/
│   │   ├── store.ts          # SQLite (WAL mode) — 7 tables, indexed queries
│   │   └── compaction.ts     # Automatic context summarization + pruning
│   ├── monitors/
│   │   ├── scheduler.ts      # Interval-based task runner (unref'd timers)
│   │   ├── notifier.ts       # Auto-detecting Discord DM notifier
│   │   ├── spotify.ts        # Public page scraping — followers, popularity
│   │   ├── tracklists.ts     # 1001Tracklists DJ support tracking
│   │   ├── envoy-jobs.ts     # AI/ML job alert scraping
│   │   ├── briefing.ts       # Daily digest assembly (weather + spotify + DJ + GH)
│   │   ├── weather.ts        # wttr.in client (no auth)
│   │   └── github-activity.ts # gh CLI integration (no token needed)
│   └── heartbeat/
│       └── monitor.ts        # 30s health checks + state change events
├── config/
│   ├── SOUL.md               # Agent personality (parsed into structured sections)
│   └── virgil.yaml           # Runtime config (env var interpolation supported)
├── data/                     # SQLite database + PID lockfile (gitignored)
├── .nvmrc                    # Node 20
├── package.json
└── tsconfig.json
```

---

## Notifications

Virgil auto-detects your Discord DM channel — no user ID config needed. Just DM the bot once and it remembers. Notifications are rate-limited so you don't get spammed.

**Zero API keys required** for monitoring — Spotify uses public pages, weather uses wttr.in, GitHub uses the `gh` CLI you already have authenticated.

---

*"Consider your origin; you were not born to live like brutes, but to follow virtue and knowledge."*
— Dante, guided by Virgil
