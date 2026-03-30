/**
 * File operations skill — read, write, search, and list files.
 *
 * All operations are scoped to an allowed base directory
 * to prevent accidental access outside the workspace.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import type { Skill, SkillInput, SkillResult } from './registry.js';

/**
 * Validates that a path is within the allowed base directory.
 * Prevents path traversal attacks.
 */
function safePath(inputPath: string, baseDir: string): string {
  const resolved = resolve(baseDir, inputPath);
  if (!resolved.startsWith(resolve(baseDir))) {
    throw new Error(`Path "${inputPath}" is outside the allowed directory`);
  }
  return resolved;
}

/** Read a file's contents */
export const fileRead: Skill = {
  name: 'file-read',
  description: 'Read the contents of a file',
  params: [
    { name: 'path', description: 'File path to read', type: 'string', required: true },
  ],
  async execute(input: SkillInput): Promise<SkillResult> {
    const filePath = String(input.params.path ?? input.raw ?? '');
    if (!filePath) {
      return { success: false, output: 'No file path provided' };
    }

    const baseDir = process.cwd();
    const safe = safePath(filePath, baseDir);

    if (!existsSync(safe)) {
      return { success: false, output: `File not found: ${filePath}` };
    }

    const stat = statSync(safe);
    if (stat.size > 1_000_000) {
      return { success: false, output: `File too large (${stat.size} bytes). Max 1MB.` };
    }

    const content = readFileSync(safe, 'utf-8');
    return {
      success: true,
      output: content,
      data: { path: relative(baseDir, safe), size: stat.size },
    };
  },
};

/** Write content to a file */
export const fileWrite: Skill = {
  name: 'file-write',
  description: 'Write content to a file (creates or overwrites)',
  params: [
    { name: 'path', description: 'File path to write', type: 'string', required: true },
    { name: 'content', description: 'Content to write', type: 'string', required: true },
  ],
  async execute(input: SkillInput): Promise<SkillResult> {
    const filePath = String(input.params.path ?? '');
    const content = String(input.params.content ?? '');
    if (!filePath) {
      return { success: false, output: 'No file path provided' };
    }

    const baseDir = process.cwd();
    const safe = safePath(filePath, baseDir);

    writeFileSync(safe, content, 'utf-8');
    return {
      success: true,
      output: `Wrote ${content.length} bytes to ${relative(baseDir, safe)}`,
    };
  },
};

/** Search for files matching a pattern (simple glob-like) */
export const fileSearch: Skill = {
  name: 'file-search',
  description: 'Search for files by name pattern in a directory (recursive)',
  params: [
    { name: 'pattern', description: 'Substring to match in file names', type: 'string', required: true },
    { name: 'dir', description: 'Directory to search (default: current)', type: 'string' },
  ],
  async execute(input: SkillInput): Promise<SkillResult> {
    const pattern = String(input.params.pattern ?? input.raw ?? '');
    if (!pattern) {
      return { success: false, output: 'No search pattern provided' };
    }

    const baseDir = process.cwd();
    const searchDir = input.params.dir
      ? safePath(String(input.params.dir), baseDir)
      : baseDir;

    const matches: string[] = [];
    const maxResults = 50;
    const maxDepth = 6;

    function walk(dir: string, depth: number): void {
      if (depth > maxDepth || matches.length >= maxResults) return;

      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (matches.length >= maxResults) break;
        if (entry.startsWith('.') || entry === 'node_modules') continue;

        const full = join(dir, entry);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) {
            walk(full, depth + 1);
          } else if (entry.toLowerCase().includes(pattern.toLowerCase())) {
            matches.push(relative(baseDir, full));
          }
        } catch {
          continue;
        }
      }
    }

    walk(searchDir, 0);

    if (matches.length === 0) {
      return { success: true, output: `No files matching "${pattern}" found` };
    }

    const truncated = matches.length >= maxResults ? ` (limited to ${maxResults})` : '';
    return {
      success: true,
      output: `Found ${matches.length} file(s)${truncated}:\n${matches.join('\n')}`,
      data: matches,
    };
  },
};

/** List files in a directory */
export const fileList: Skill = {
  name: 'file-list',
  description: 'List files and directories in a path',
  params: [
    { name: 'dir', description: 'Directory to list (default: current)', type: 'string' },
  ],
  async execute(input: SkillInput): Promise<SkillResult> {
    const baseDir = process.cwd();
    const targetDir = input.params.dir
      ? safePath(String(input.params.dir), baseDir)
      : baseDir;

    if (!existsSync(targetDir)) {
      return { success: false, output: `Directory not found: ${input.params.dir}` };
    }

    const entries = readdirSync(targetDir);
    const listing = entries
      .filter((e) => !e.startsWith('.'))
      .map((entry) => {
        try {
          const stat = statSync(join(targetDir, entry));
          const type = stat.isDirectory() ? 'dir' : 'file';
          const size = stat.isDirectory() ? '' : ` (${stat.size}B)`;
          return `  ${type === 'dir' ? '📁' : '📄'} ${entry}${size}`;
        } catch {
          return `  ❓ ${entry}`;
        }
      });

    return {
      success: true,
      output: `${relative(baseDir, targetDir) || '.'}:\n${listing.join('\n')}`,
    };
  },
};
