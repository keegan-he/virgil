/**
 * System skills — machine info, process listing, and command execution.
 *
 * Provides Virgil with awareness of the host system. Command execution
 * is sandboxed to a limited set of safe commands.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { freemem, totalmem, cpus, uptime, hostname, platform, arch } from 'node:os';
import type { Skill, SkillInput, SkillResult } from './registry.js';

const execFileAsync = promisify(execFile);

/** Commands allowed for direct execution */
const SAFE_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'find', 'grep', 'which',
  'date', 'uptime', 'whoami', 'hostname', 'df', 'du', 'ps',
  'echo', 'pwd', 'uname',
]);

/** Commands that accept file/directory path arguments */
const PATH_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'find', 'grep', 'du', 'wc',
]);

/**
 * Validates that all path-like arguments resolve within the allowed base directory.
 * Prevents shell-exec from bypassing the file-ops sandbox.
 */
function validateArgs(cmd: string, args: string[], baseDir: string): void {
  if (!PATH_COMMANDS.has(cmd)) return;

  for (const arg of args) {
    // Skip flags
    if (arg.startsWith('-')) continue;
    // Skip grep patterns (non-path arguments) — grep's first non-flag arg is a pattern
    if (cmd === 'grep' && !arg.includes('/') && !arg.startsWith('.')) continue;

    const resolved = resolve(baseDir, arg);
    if (!resolved.startsWith(resolve(baseDir))) {
      throw new Error(`Path "${arg}" is outside the allowed directory`);
    }
  }
}

/** Max command execution time */
const EXEC_TIMEOUT_MS = 10_000;

/** System info snapshot */
export const systemInfo: Skill = {
  name: 'system-info',
  description: 'Get host system information (CPU, memory, uptime)',
  params: [],
  async execute(): Promise<SkillResult> {
    const cpuInfo = cpus();
    const memTotal = totalmem();
    const memFree = freemem();
    const memUsed = memTotal - memFree;

    const fmt = (bytes: number) => `${(bytes / 1_073_741_824).toFixed(1)}GB`;

    const info = [
      `Hostname: ${hostname()}`,
      `Platform: ${platform()} ${arch()}`,
      `CPU: ${cpuInfo[0]?.model ?? 'unknown'} (${cpuInfo.length} cores)`,
      `Memory: ${fmt(memUsed)} used / ${fmt(memTotal)} total (${fmt(memFree)} free)`,
      `Uptime: ${formatUptime(uptime())}`,
    ].join('\n');

    return {
      success: true,
      output: info,
      data: {
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        cpuCores: cpuInfo.length,
        memTotalBytes: memTotal,
        memFreeBytes: memFree,
        uptimeSeconds: uptime(),
      },
    };
  },
};

/** List running processes */
export const processList: Skill = {
  name: 'process-list',
  description: 'List running processes sorted by CPU or memory usage',
  params: [
    { name: 'sort', description: 'Sort by "cpu" or "mem" (default: cpu)', type: 'string' },
    { name: 'limit', description: 'Max processes to show (default: 10)', type: 'number' },
  ],
  async execute(input: SkillInput): Promise<SkillResult> {
    const sortBy = String(input.params.sort ?? 'cpu');
    const limit = Number(input.params.limit ?? 10);

    const sortFlag = sortBy === 'mem' ? '-m' : '-r';

    try {
      const { stdout } = await execFileAsync('ps', ['aux'], {
        timeout: EXEC_TIMEOUT_MS,
      });

      const lines = stdout.trim().split('\n');
      const header = lines[0];
      const processes = lines
        .slice(1)
        .sort((a, b) => {
          const colIndex = sortBy === 'mem' ? 3 : 2;
          const valA = parseFloat(a.trim().split(/\s+/)[colIndex] ?? '0');
          const valB = parseFloat(b.trim().split(/\s+/)[colIndex] ?? '0');
          return valB - valA;
        })
        .slice(0, limit);

      return {
        success: true,
        output: [header, ...processes].join('\n'),
      };
    } catch (err) {
      return {
        success: false,
        output: `Failed to list processes: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

/** Run a safe shell command */
export const shellExec: Skill = {
  name: 'shell-exec',
  description: 'Execute a safe shell command (ls, cat, grep, df, ps, etc.)',
  params: [
    { name: 'command', description: 'Command to run', type: 'string', required: true },
    { name: 'args', description: 'Space-separated arguments', type: 'string' },
  ],
  async execute(input: SkillInput): Promise<SkillResult> {
    const command = String(input.params.command ?? '');
    if (!command) {
      return { success: false, output: 'No command provided' };
    }

    // Parse command and args
    let cmd: string;
    let args: string[];

    if (input.params.args) {
      cmd = command;
      args = String(input.params.args).split(/\s+/);
    } else if (input.raw) {
      const parts = input.raw.split(/\s+/);
      cmd = parts[0];
      args = parts.slice(1);
    } else {
      const parts = command.split(/\s+/);
      cmd = parts[0];
      args = parts.slice(1);
    }

    // Safety check
    if (!SAFE_COMMANDS.has(cmd)) {
      return {
        success: false,
        output: `Command "${cmd}" is not allowed. Safe commands: ${Array.from(SAFE_COMMANDS).join(', ')}`,
      };
    }

    // Validate path arguments stay within cwd
    const baseDir = process.cwd();
    try {
      validateArgs(cmd, args, baseDir);
    } catch (err) {
      return {
        success: false,
        output: err instanceof Error ? err.message : String(err),
      };
    }

    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 512_000,
        cwd: baseDir,
      });

      const output = stdout + (stderr ? `\nSTDERR: ${stderr}` : '');
      return { success: true, output: output.trim() || '(no output)' };
    } catch (err) {
      return {
        success: false,
        output: `Command failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

/** Disk usage info */
export const diskUsage: Skill = {
  name: 'disk-usage',
  description: 'Show disk space usage',
  params: [],
  async execute(): Promise<SkillResult> {
    try {
      const { stdout } = await execFileAsync('df', ['-h'], {
        timeout: EXEC_TIMEOUT_MS,
      });
      return { success: true, output: stdout.trim() };
    } catch (err) {
      return {
        success: false,
        output: `Failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(' ');
}
