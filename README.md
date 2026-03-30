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

## How it works

```
                         ┌──────────────┐
                         │   Discord    │
                         │   Console    │
                         └──────┬───────┘
                                │
                         ┌──────▼───────┐
                         │   Gateway    │
                         │  (msg bus)   │
                         └──────┬───────┘
                                │
                    ┌───────────▼───────────┐
                    │       Router          │
                    │  (classify intent)    │
                    └───┬───────────────┬───┘
                        │               │
                 ┌──────▼──────┐ ┌──────▼──────┐
                 │   Ollama    │ │   Claude    │
                 │  (local)    │ │  (cloud)    │
                 │  fast, lean │ │  deep, rich │
                 └─────────────┘ └─────────────┘

         ┌────────────┐  ┌────────────┐  ┌────────────┐
         │  Heartbeat │  │   Memory   │  │  Monitors  │
         │  (health)  │  │  (SQLite)  │  │ (scheduled)│
         └────────────┘  └────────────┘  └────────────┘
```

The **Router** uses Ollama to classify each message as simple or complex. Simple messages (greetings, quick lookups, casual chat) stay local. Complex messages (multi-step reasoning, code analysis, research) go to Claude. If the classifier times out or has low confidence, it defaults to Claude — always erring on the side of quality.

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

---

## Project structure

```
virgil/
├── src/
│   ├── index.ts              # Entry point + console REPL
│   ├── gateway/              # Message bus, routing, sessions, config
│   ├── backends/             # Ollama + Claude integrations
│   ├── channels/             # Discord bot + unified message types
│   ├── skills/               # Modular tool system (files, web, system)
│   ├── memory/               # SQLite store + context compaction
│   ├── monitors/             # Spotify, jobs, tracklists, briefings
│   └── heartbeat/            # Backend health monitoring
├── config/
│   ├── SOUL.md               # Agent personality
│   └── virgil.yaml           # Runtime config
└── data/                     # SQLite database (gitignored)
```

---

## Notifications

Virgil auto-detects your Discord DM channel — no user ID config needed. Just DM the bot once and it remembers. Notifications are rate-limited so you don't get spammed.

**Zero API keys required** for monitoring — Spotify uses public pages, weather uses wttr.in, GitHub uses the `gh` CLI you already have authenticated.

---

*"Consider your origin; you were not born to live like brutes, but to follow virtue and knowledge."*
— Dante, guided by Virgil
