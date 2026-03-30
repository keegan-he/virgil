/**
 * Heartbeat monitor — periodic health checks for Virgil's backends.
 *
 * Pings Ollama (and optionally Claude) on a configurable interval.
 * When Ollama goes down, the router is notified to route all traffic
 * to Claude. Health state is logged to SQLite for observability.
 */

import type { OllamaClient } from '../backends/ollama.js';
import type { ClaudeClient } from '../backends/claude.js';
import type { Router } from '../gateway/router.js';
import type { MemoryStore } from '../memory/store.js';
import type { HeartbeatConfig } from '../gateway/config.js';

// ── Types ───────────────────────────────────────────────────────

/** Current health snapshot for all services */
export interface HealthSnapshot {
  ollama: ServiceStatus;
  claude: ServiceStatus;
  timestamp: Date;
}

export interface ServiceStatus {
  status: 'ok' | 'degraded' | 'down';
  latencyMs?: number;
  error?: string;
  lastChecked: Date;
}

/** Listener for health state changes */
export type HealthChangeListener = (
  service: string,
  previous: ServiceStatus['status'],
  current: ServiceStatus['status'],
) => void;

// ── Monitor ─────────────────────────────────────────────────────

export class HeartbeatMonitor {
  private ollama: OllamaClient;
  private claude: ClaudeClient;
  private router: Router;
  private store: MemoryStore;
  private intervalMs: number;
  private timeoutMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners: HealthChangeListener[] = [];

  private ollamaStatus: ServiceStatus = {
    status: 'ok',
    lastChecked: new Date(),
  };
  private claudeStatus: ServiceStatus = {
    status: 'ok',
    lastChecked: new Date(),
  };

  /** Count of consecutive Ollama failures */
  private ollamaFailCount = 0;

  constructor(deps: {
    ollama: OllamaClient;
    claude: ClaudeClient;
    router: Router;
    store: MemoryStore;
    config: HeartbeatConfig;
  }) {
    this.ollama = deps.ollama;
    this.claude = deps.claude;
    this.router = deps.router;
    this.store = deps.store;
    this.intervalMs = deps.config.interval_ms;
    this.timeoutMs = deps.config.timeout_ms;
  }

  /**
   * Starts the heartbeat loop.
   */
  start(): void {
    if (this.timer) return;

    console.log(`Heartbeat: monitoring every ${this.intervalMs / 1000}s`);

    // Run immediately, then on interval
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref(); // Don't prevent process exit
  }

  /**
   * Stops the heartbeat loop.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Returns the current health snapshot.
   */
  getSnapshot(): HealthSnapshot {
    return {
      ollama: { ...this.ollamaStatus },
      claude: { ...this.claudeStatus },
      timestamp: new Date(),
    };
  }

  /**
   * Returns a formatted status string suitable for Discord/console.
   */
  getStatusText(): string {
    const snap = this.getSnapshot();
    const icon = (s: ServiceStatus['status']) =>
      s === 'ok' ? 'OK' : s === 'degraded' ? 'DEGRADED' : 'DOWN';

    const lines = [
      `Ollama: ${icon(snap.ollama.status)}${snap.ollama.latencyMs ? ` (${snap.ollama.latencyMs}ms)` : ''}${snap.ollama.error ? ` — ${snap.ollama.error}` : ''}`,
      `Claude: ${icon(snap.claude.status)}${snap.claude.error ? ` — ${snap.claude.error}` : ''}`,
      `Last check: ${snap.timestamp.toISOString()}`,
    ];

    return lines.join('\n');
  }

  /**
   * Registers a listener for health state changes.
   */
  onChange(listener: HealthChangeListener): void {
    this.listeners.push(listener);
  }

  // ── Internal ────────────────────────────────────────────────

  private async tick(): Promise<void> {
    await Promise.all([this.checkOllama(), this.checkClaude()]);
  }

  private async checkOllama(): Promise<void> {
    const previous = this.ollamaStatus.status;

    try {
      const health = await this.ollama.healthCheck();
      const now = new Date();

      if (health.alive && health.modelLoaded) {
        this.ollamaStatus = {
          status: 'ok',
          latencyMs: health.latencyMs,
          lastChecked: now,
        };
        this.ollamaFailCount = 0;
        this.router.setOllamaAvailable(true);
        this.store.logHealth('ollama', 'ok', health.latencyMs);
      } else if (health.alive && !health.modelLoaded) {
        this.ollamaStatus = {
          status: 'degraded',
          latencyMs: health.latencyMs,
          error: 'model not loaded',
          lastChecked: now,
        };
        this.ollamaFailCount++;
        this.router.setOllamaAvailable(false);
        this.store.logHealth('ollama', 'error', health.latencyMs, 'model not loaded');
      } else {
        this.ollamaFailCount++;
        this.ollamaStatus = {
          status: 'down',
          latencyMs: health.latencyMs,
          error: health.error,
          lastChecked: now,
        };
        this.router.setOllamaAvailable(false);
        this.store.logHealth('ollama', 'error', health.latencyMs, health.error);
      }
    } catch (err) {
      this.ollamaFailCount++;
      this.ollamaStatus = {
        status: 'down',
        error: err instanceof Error ? err.message : String(err),
        lastChecked: new Date(),
      };
      this.router.setOllamaAvailable(false);
      this.store.logHealth(
        'ollama',
        'error',
        undefined,
        this.ollamaStatus.error,
      );
    }

    if (this.ollamaStatus.status !== previous) {
      this.emitChange('ollama', previous, this.ollamaStatus.status);
    }
  }

  private async checkClaude(): Promise<void> {
    const previous = this.claudeStatus.status;

    try {
      const health = await this.claude.healthCheck();
      const now = new Date();

      if (health.available) {
        this.claudeStatus = { status: 'ok', lastChecked: now };
        this.store.logHealth('claude', 'ok');
      } else {
        this.claudeStatus = {
          status: 'down',
          error: health.error,
          lastChecked: now,
        };
        this.store.logHealth('claude', 'error', undefined, health.error);
      }
    } catch (err) {
      this.claudeStatus = {
        status: 'down',
        error: err instanceof Error ? err.message : String(err),
        lastChecked: new Date(),
      };
      this.store.logHealth('claude', 'error', undefined, this.claudeStatus.error);
    }

    if (this.claudeStatus.status !== previous) {
      this.emitChange('claude', previous, this.claudeStatus.status);
    }
  }

  private emitChange(
    service: string,
    previous: ServiceStatus['status'],
    current: ServiceStatus['status'],
  ): void {
    console.log(`  [heartbeat] ${service}: ${previous} → ${current}`);
    for (const listener of this.listeners) {
      try {
        listener(service, previous, current);
      } catch {
        // Don't let listener errors break the monitor
      }
    }
  }
}
