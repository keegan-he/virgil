# Virgil

Personal AI agent framework with intelligent routing between a local Ollama model and Claude (via Claude Code CLI).

## Architecture

```
Discord / Console
  → Gateway (message bus, session manager)
    → Router (Ollama classifies simple vs complex)
      → Ollama (fast, local, simple tasks)
      → Claude (cloud, complex reasoning + tools)
    → Compaction (summarizes old turns when threshold hit)
    → Response back through channel
  ← Heartbeat (monitors backend health every 30s)
```

## Setup

### Prerequisites

- **Node.js** >= 18 (use `nvm use 20` — `.nvmrc` included)
- **Ollama** installed and running (`brew install ollama && ollama serve`)
- **Claude Code** installed and authenticated with a Max subscription
- A Discord bot token (optional — console mode works without one)

### Install

```bash
cd virgil
npm install
```

### Configure

1. Copy `.env.example` to `.env` and fill in your Discord token:
   ```bash
   cp .env.example .env
   ```

2. Pull the Ollama model:
   ```bash
   ollama pull qwen2.5-coder:1.5b
   ```

3. Edit `config/virgil.yaml` to adjust settings (model, channels, heartbeat, etc.)

4. Edit `config/SOUL.md` to customize Virgil's personality and rules.

### Run

```bash
# Development
npm run dev

# Production
npm run build && npm start
```

### Console Commands

When running in console mode, these built-in commands are available:

- `/status` — Show backend health (Ollama, Claude)
- `/skills` — List all registered skills

## Components

### Gateway (`src/gateway/`)
Central message bus. Receives normalized messages from any channel, orchestrates routing, dispatches to backends, manages sessions, triggers compaction.

### Router (`src/gateway/router.ts`)
Uses Ollama to classify messages as simple (local) or complex (cloud). Falls back to Claude on timeout, low confidence, or Ollama being down.

### Backends (`src/backends/`)
- **Ollama** — HTTP client for local inference via `/api/chat`. Streaming + non-streaming.
- **Claude** — Spawns `claude` CLI with `--output-format stream-json`. Uses Max subscription auth.

### Discord (`src/channels/discord.ts`)
Full discord.js integration: message listening, slash commands (`/ask`, `/status`, `/skill`), threaded conversations, typing indicators, smart message splitting with code fence balancing.

### Skills (`src/skills/`)
Modular capability system. 9 built-in skills:
- `file-read`, `file-write`, `file-search`, `file-list` — path-traversal-safe file operations
- `web-fetch` — URL fetching with HTML stripping
- `system-info`, `process-list`, `disk-usage` — system monitoring
- `shell-exec` — whitelisted safe commands only

### Heartbeat (`src/heartbeat/monitor.ts`)
Periodic health checks (default 30s). When Ollama goes down, router automatically sends all traffic to Claude. State changes logged to SQLite and emitted as events.

### Memory (`src/memory/`)
- **Store** — SQLite with WAL mode. Sessions, conversation turns, health logs.
- **Compaction** — When turns exceed threshold, old history is summarized via Ollama and pruned.

### SOUL.md (`config/SOUL.md`)
Defines Virgil's personality, rules, and identity. Parsed into structured sections and injected into backend system prompts.

## Project Structure

```
virgil/
├── src/
│   ├── index.ts              # Entry point + console REPL
│   ├── gateway/
│   │   ├── gateway.ts        # Core message bus
│   │   ├── session.ts        # Session/conversation manager
│   │   ├── config.ts         # Config + SOUL.md loader
│   │   └── router.ts         # Ollama vs Claude routing
│   ├── backends/
│   │   ├── ollama.ts         # Ollama HTTP client
│   │   └── claude.ts         # Claude Code CLI integration
│   ├── channels/
│   │   ├── discord.ts        # Discord bot
│   │   └── types.ts          # Unified message types
│   ├── skills/
│   │   ├── registry.ts       # Skill registration + discovery
│   │   ├── file-ops.ts       # File operations
│   │   ├── web-search.ts     # Web fetching
│   │   └── system.ts         # System monitoring + safe shell
│   ├── memory/
│   │   ├── store.ts          # SQLite storage
│   │   └── compaction.ts     # Context summarization
│   └── heartbeat/
│       └── monitor.ts        # Health monitoring
├── config/
│   ├── SOUL.md               # Agent personality
│   └── virgil.yaml           # Runtime config
├── data/                     # SQLite database (gitignored)
├── .nvmrc                    # Node 20
├── package.json
└── tsconfig.json
```
