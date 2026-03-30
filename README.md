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

**Your personal AI agent.** Always on. Always watching. Lives in Discord. Thinks with two brains. Doesn't need a data center to do it.

Named after the guide in Dante's *Divine Comedy* — because every journey through the circles of modern AI infrastructure needs a steady hand.

---

## The pitch

Virgil routes conversations between a fast local model (Ollama) and a cloud model (Claude). Simple stuff stays local. Hard stuff goes to the cloud. You never pick which model to use — Virgil figures it out. If the local model goes down, Claude catches everything. No config change, no restart, no panic.

~2,500 lines of TypeScript. One SQLite database. `npm install && npm run dev`. That's it. No Docker, no Kubernetes, no "please configure your NVIDIA runtime." Just a Node.js process on your laptop that happens to be smarter than it looks.

---

## What it does

- **Discord bot** — threaded conversations, slash commands, typing indicators, smart message splitting that won't butcher your code fences
- **Dual-brain routing** — Ollama for speed, Claude for depth, automatic failover at every layer
- **Background monitors** — Spotify metrics, 1001Tracklists DJ support, Envoy job alerts, daily briefings with weather and GitHub activity. Zero API keys. Seriously — it scrapes public pages like Dante wandered through Hell: methodically.
- **9 built-in skills** — file ops (path-traversal-safe), web fetching, system monitoring, whitelisted shell commands
- **Persistent memory** — SQLite with automatic context compaction. When conversations get long, Virgil summarizes the old stuff so it doesn't forget where you left off. Like a guide who actually remembers which circle you're in.
- **Heartbeat monitor** — pings backends every 30s, reroutes traffic on failure, logs everything

---

## Lineage

Virgil's architecture has two parents:

### From [OpenClaw](https://github.com/openclaw/openclaw): the gateway pattern

OpenClaw proved that a gateway-centric message bus — normalize input from any channel, route through an agent, dispatch back — is the right architecture for personal AI agents. Virgil inherits this wholesale: a central Gateway that doesn't care where messages come from, unified message types, modular skills, per-user session isolation, and event-driven observability.

OpenClaw connects to 24+ messaging platforms and runs a full plugin ecosystem. Virgil connects to Discord and a terminal. Sometimes the ninth circle is just one channel deep.

### From [NemoClaw](https://github.com/NVIDIA/NemoClaw): the security philosophy

NemoClaw wraps OpenClaw in NVIDIA's OpenShell sandbox — Landlock, seccomp, network namespaces, credential stripping, inference proxying. Enterprise-grade. Also enterprise-weight.

Virgil distills the same principles into application-level guardrails:
- **Path traversal protection** — every file op resolves against a base dir. `../../../etc/passwd` gets you a polite rejection, not your secrets.
- **Command whitelisting** — 20 safe commands via `execFile()`. No shell string eval. No injection. The agent runs `ls`, not `rm -rf /`.
- **Process isolation** — Claude runs as a subprocess with `cwd` set to `$HOME`. It can't read its own source, config, or `.env`. Virgil doesn't trust Virgil with Virgil's keys.
- **Credential separation** — secrets live in environment variables, never in agent-accessible state. All inference flows through the Gateway.

Same philosophy. No Docker. No GPU. No vendor lock-in.

### No NVIDIA hardware required

NemoClaw needs OpenShell, Linux containers, and `nvidia/nemotron-3-super-120b-a12b` on NVIDIA endpoints. Virgil runs Ollama on whatever you've got — Apple Silicon, Intel, AMD, CPU-only. A MacBook Air handles `qwen2.5-coder:1.5b` without breaking a sweat. Cloud reasoning goes through Claude's CLI, not a GPU you're renting by the minute.

Dante didn't need a supercomputer to write the *Commedia*. You don't need one to run your agent.

### Why the Claude Agent SDK (Python) shaped the backend

Virgil is TypeScript, but its Claude integration is modeled after the [Claude Agent SDK for Python](https://docs.anthropic.com/en/docs/agents/agent-sdk)'s **SubprocessCLITransport** pattern. Three options existed:

1. **Direct API calls** — you own the tool loop, context management, session state, token counting. A lot of work to get wrong.
2. **The Python Agent SDK** — spawns `claude` as a subprocess, reads stream-json. The agent loop is battle-tested. You just consume it.
3. **Virgil's approach** — option 2, reimplemented in ~200 lines of TypeScript. Same subprocess pattern, same streaming protocol, zero Python dependency.

The Python SDK proved that subprocess-based agent integration works. Virgil ported the pattern into the same language as the rest of the stack. The subprocess runs with `cwd` set to `$HOME` (not the project directory), processes are tracked and killed on shutdown, and output is parsed as typed NDJSON. Process-level isolation for free — the simplest way to run an agent safely, and the SDK team figured that out first.

---

## Architecture

```
  Discord / Console
         │
    ┌────▼────┐
    │ Gateway │──→ normalize → route → dispatch → record → respond
    └────┬────┘
         │
    ┌────▼────┐    ┌──────────┐
    │ Router  │    │ Sessions │  per-user, per-thread isolation
    └──┬───┬──┘    └──────────┘
       │   │
   ┌───▼┐ ┌▼────┐  ┌──────────┐
   │ 🏠 │ │ ☁️  │  │  Skills  │  9 built-in, path-safe, whitelisted
   │Olla│ │Clau │  └──────────┘
   │ ma │ │ de  │
   └────┘ └─────┘  ┌──────────┐  ┌──────────┐  ┌──────────┐
                    │Heartbeat │  │  Memory  │  │ Monitors │
                    │  (30s)   │  │ (SQLite) │  │(scheduled│
                    └──────────┘  └──────────┘  └──────────┘
```

**Router**: Tier 1 regex fast-path (0ms) catches obvious patterns. Tier 2 Ollama classification (2s timeout) handles the rest. Low confidence, timeout, or Ollama down → Claude. Always errs toward quality.

**Memory**: SQLite with WAL mode. Up to 30 recent turns in context. When sessions exceed 40 turns, older history gets summarized by Ollama and pruned. The agent forgets gracefully — unlike most people in the second circle.

**Monitors**: Spotify (hourly), 1001Tracklists (6h), Envoy jobs (2h), daily briefing (8am). All zero-auth. Rate-limited notifications auto-delivered to your Discord DMs.

---

## Getting started

### Prerequisites

- **Node.js** >= 18 (`nvm use` — `.nvmrc` included)
- **Ollama** running (`brew install ollama && ollama serve`)
- **Discord bot token** (optional — console works without one)

### Setup

```bash
git clone https://github.com/keegan-he/virgil.git
cd virgil
npm install
cp .env.example .env          # add your Discord token
ollama pull qwen2.5-coder:1.5b
```

Customize `config/virgil.yaml` for your setup. Edit `config/SOUL.md` to give Virgil a personality — or keep the default one, which is already pretty good at being direct and not wasting your time.

### Run

```bash
npm run dev       # development
npm run build && npm start  # production
```

### Console commands

- `/status` — backend health
- `/skills` — list skills
- `/briefing` — daily briefing on demand

---

## Project structure

```
virgil/
├── src/
│   ├── index.ts           # Bootstrap, console REPL, graceful shutdown
│   ├── gateway/           # Message bus, router, sessions, config loader
│   ├── backends/          # Ollama REST client, Claude CLI subprocess
│   ├── channels/          # Discord bot, unified message types
│   ├── skills/            # File ops, web fetch, system tools (all sandboxed)
│   ├── memory/            # SQLite store, context compaction
│   ├── monitors/          # Spotify, tracklists, jobs, briefings, weather, GitHub
│   └── heartbeat/         # Health checks, state change events
├── config/
│   ├── SOUL.md            # Agent personality and rules
│   └── virgil.yaml        # Runtime config
└── data/                  # SQLite + PID lockfile (gitignored)
```

---

*"Consider your origin; you were not born to live like brutes, but to follow virtue and knowledge."*
*— Dante, guided by Virgil*

*Also you were not born to mass-provision A100s for a Discord bot. Keep it simple.*
