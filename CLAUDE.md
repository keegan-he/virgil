# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Run in development (tsx src/index.ts)
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled output (node dist/index.js)
```

There is no test framework configured. No linter or formatter is set up.

## Prerequisites

- Node.js >= 20 (see `.nvmrc`)
- Ollama running locally (`ollama serve`) with `qwen2.5-coder:1.5b` pulled
- `claude` CLI on PATH (used as a subprocess, not an API)
- Discord bot token in `.env` (optional — console mode works without it)

## Architecture

Virgil is a personal AI agent that runs as a Discord bot (or console REPL). It routes conversations between a local Ollama model (fast, simple tasks) and Claude CLI (complex tasks via subprocess). ~2,500 lines of TypeScript, single SQLite database, no Docker.

### Message flow

```
Channel (Discord/Console) → Gateway.process() → Router.classify() → Backend (Ollama or Claude) → Response
```

1. **Channels** (`src/channels/`) normalize platform messages into `InboundMessage` (defined in `types.ts`)
2. **Gateway** (`src/gateway/gateway.ts`) orchestrates the full pipeline: session resolution → context building → routing → backend dispatch → turn recording → response
3. **Router** (`src/gateway/router.ts`) decides the backend target using a 2-tier system:
   - Tier 1: Regex fast-path patterns (0ms) for obvious simple/complex messages
   - Tier 2: Ollama classification with 2s timeout; low confidence (<0.7) or timeout → Claude
4. **Backends** (`src/backends/`):
   - `OllamaClient` — HTTP client talking to localhost:11434 REST API, supports streaming
   - `ClaudeClient` — spawns `claude` CLI as a subprocess with `--output-format stream-json`, parses NDJSON. Runs with `cwd: homedir()` for process isolation (cannot read its own source)
5. **Sessions** (`src/gateway/session.ts`) — per-user, per-thread isolation backed by SQLite
6. **Memory** (`src/memory/`) — SQLite with WAL mode. `ContextCompactor` summarizes old turns via Ollama when sessions exceed 40 turns, then prunes

### Key design patterns

- **Automatic failover**: Ollama dispatch failures fall back to Claude transparently (`Gateway.dispatchToOllama` catches and redirects)
- **Heartbeat** (`src/heartbeat/monitor.ts`): pings backends every 30s, updates router availability, fires state change events
- **Skills** (`src/skills/`): modular tool system with `SkillRegistry`. 9 built-in skills (file ops, web fetch, shell exec). All file ops enforce path-traversal safety. Shell commands use `execFile()` with a whitelist — no shell string eval
- **Monitors** (`src/monitors/`): scheduled background tasks (Spotify metrics, 1001Tracklists scraping, Envoy jobs, daily briefing). All zero-auth, scrape public pages. Notifications auto-detect Discord DM channel on first message

### Configuration

- `config/virgil.yaml` — runtime config with `${ENV_VAR}` interpolation (parsed in `src/gateway/config.ts`)
- `config/SOUL.md` — agent personality, parsed into structured sections (`SoulConfig`) used as system prompt for both backends
- All config types are defined in `src/gateway/config.ts`

### SQLite schema

Defined inline in `src/memory/store.ts`. Tables: `sessions`, `turns`, `health_logs`, `artist_metrics`, `dj_support`, `daily_briefings`, `envoy_jobs`. Database lives at `data/virgil.db` (gitignored).

### Process safety

- PID lockfile (`data/virgil.pid`) prevents multiple instances
- Claude subprocess tracking: all spawned processes are tracked in `ClaudeClient.activeProcesses` and killed on shutdown
- Graceful shutdown handler cleans up Discord, heartbeat, monitors, SQLite, and lockfile
