/**
 * Claude backend integration via the Claude Code CLI.
 *
 * Spawns `claude` as a subprocess with `--output-format stream-json`,
 * using the user's Max subscription auth. Inspired by the Claude Agent SDK's
 * SubprocessCLITransport pattern — but implemented from scratch.
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { ClaudeConfig } from '../gateway/config.js';
import type { SoulConfig } from '../gateway/config.js';

// ── Types ───────────────────────────────────────────────────────

/** A content block within a Claude message */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

/** Parsed streaming message from Claude CLI */
export interface ClaudeStreamMessage {
  type: 'assistant' | 'result' | 'system' | 'error';
  /** Available on 'assistant' messages */
  message?: {
    role: string;
    content: ContentBlock[];
  };
  /** Available on 'result' messages */
  result?: {
    text?: string;
    cost_usd?: number;
    duration_ms?: number;
    num_turns?: number;
  };
  /** Error text if type is 'error' */
  error?: string;
  /** Subtype for system messages */
  subtype?: string;
}

/** Result from a Claude query */
export interface ClaudeResult {
  /** The assembled text response */
  text: string;
  /** Cost in USD (if reported) */
  costUsd?: number;
  /** Duration in milliseconds */
  durationMs?: number;
  /** Number of turns used */
  numTurns?: number;
}

// ── Client ──────────────────────────────────────────────────────

export class ClaudeClient {
  private config: ClaudeConfig;
  private systemPrompt: string;
  private cliPath: string;
  /** Active child processes — tracked so we can kill them on shutdown */
  private activeProcesses = new Set<ChildProcess>();

  /**
   * @param config - Claude configuration from virgil.yaml
   * @param soul - Parsed SOUL.md (used to build the system prompt)
   */
  constructor(config: ClaudeConfig, soul: SoulConfig) {
    this.config = config;
    this.systemPrompt = soul.raw;
    this.cliPath = this.findCli();
  }

  /**
   * Kills all active Claude subprocesses.
   * Called during shutdown to prevent orphaned processes.
   */
  killAll(): void {
    for (const proc of this.activeProcesses) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // Process may have already exited
      }
    }
    this.activeProcesses.clear();
  }

  /**
   * Sends a prompt to Claude and returns the full response.
   *
   * Uses `claude -p` for single-shot queries with `--output-format stream-json`
   * so we can parse structured output and extract cost/duration metadata.
   *
   * @param prompt - The user's message
   * @param conversationContext - Optional prior conversation turns for context
   * @param onToken - Optional callback for streaming text tokens
   * @returns Assembled result with text and metadata
   */
  async query(
    prompt: string,
    conversationContext?: string,
    onToken?: (token: string) => void,
  ): Promise<ClaudeResult> {
    const args = this.buildArgs(prompt, conversationContext);
    const proc = spawn(this.cliPath, args, {
      cwd: homedir(), // Run from home dir, NOT the Virgil project dir
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLAUDE_CODE_ENTRYPOINT: 'virgil',
      },
    });

    this.activeProcesses.add(proc);
    proc.on('close', () => this.activeProcesses.delete(proc));
    proc.on('error', () => this.activeProcesses.delete(proc));

    return this.readStreamResponse(proc, onToken);
  }

  /**
   * Checks whether the Claude CLI is available and authenticated.
   */
  async healthCheck(): Promise<{ available: boolean; error?: string }> {
    try {
      const proc = spawn(this.cliPath, ['--version'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10_000,
      });

      const [code] = await once(proc, 'close');
      return { available: code === 0 };
    } catch (err) {
      return {
        available: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── Internal ────────────────────────────────────────────────

  /**
   * Builds the CLI arguments for a query.
   */
  private buildArgs(prompt: string, context?: string): string[] {
    const fullPrompt = context
      ? `${context}\n\nUser: ${prompt}`
      : prompt;

    const args = [
      '-p', fullPrompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--max-turns', String(this.config.max_turns),
    ];

    if (this.systemPrompt) {
      args.push('--system-prompt', this.systemPrompt);
    }

    if (this.config.permission_mode) {
      args.push('--permission-mode', this.config.permission_mode);
    }

    for (const tool of this.config.allowed_tools) {
      args.push('--allowedTools', tool);
    }

    return args;
  }

  /**
   * Reads streaming JSON output from the Claude CLI subprocess.
   * Each line is a JSON object with a `type` field.
   */
  private async readStreamResponse(
    proc: ChildProcess,
    onToken?: (token: string) => void,
  ): Promise<ClaudeResult> {
    let text = '';
    let costUsd: number | undefined;
    let durationMs: number | undefined;
    let numTurns: number | undefined;
    let stderrOutput = '';

    return new Promise<ClaudeResult>((resolve, reject) => {
      let buffer = '';

      proc.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const msg = JSON.parse(trimmed) as ClaudeStreamMessage;
            this.processMessage(msg, (token) => {
              text += token;
              onToken?.(token);
            });

            if (msg.type === 'result' && msg.result) {
              costUsd = msg.result.cost_usd;
              durationMs = msg.result.duration_ms;
              numTurns = msg.result.num_turns;
              // Use result text if we didn't get streaming tokens
              if (!text && msg.result.text) {
                text = msg.result.text;
              }
            }
          } catch {
            // Skip non-JSON lines (e.g. progress indicators)
          }
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderrOutput += data.toString();
      });

      proc.on('close', (code) => {
        // Process any remaining buffer
        if (buffer.trim()) {
          try {
            const msg = JSON.parse(buffer.trim()) as ClaudeStreamMessage;
            this.processMessage(msg, (token) => {
              text += token;
              onToken?.(token);
            });
            if (msg.type === 'result' && msg.result) {
              costUsd = msg.result.cost_usd;
              durationMs = msg.result.duration_ms;
              numTurns = msg.result.num_turns;
              if (!text && msg.result.text) {
                text = msg.result.text;
              }
            }
          } catch {
            // ignore
          }
        }

        if (code !== 0 && !text) {
          reject(new Error(
            `Claude CLI exited with code ${code}: ${stderrOutput.slice(0, 500)}`,
          ));
        } else {
          resolve({ text: text.trim(), costUsd, durationMs, numTurns });
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
      });
    });
  }

  /**
   * Extracts text tokens from a parsed stream message.
   */
  private processMessage(
    msg: ClaudeStreamMessage,
    emit: (token: string) => void,
  ): void {
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) {
          emit(block.text);
        }
      }
    }
  }

  /**
   * Locates the `claude` CLI binary.
   * Checks explicit env var, then common install locations, then falls
   * back to `which claude` for PATH resolution.
   */
  private findCli(): string {
    const candidates = [
      process.env.CLAUDE_CLI_PATH,
      `${process.env.HOME}/.local/bin/claude`,
      '/usr/local/bin/claude',
      `${process.env.HOME}/.npm-global/bin/claude`,
      `${process.env.HOME}/.claude/local/claude`,
      `${process.env.HOME}/node_modules/.bin/claude`,
      `${process.env.HOME}/.yarn/bin/claude`,
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }

    // Fall back to PATH resolution via `which`
    try {
      return execFileSync('which', ['claude'], { encoding: 'utf-8' }).trim();
    } catch {
      return 'claude';
    }
  }
}
