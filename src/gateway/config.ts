/**
 * Configuration loader for Virgil.
 *
 * Loads virgil.yaml (with environment variable interpolation) and
 * parses SOUL.md into structured sections.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';

// ── Config types ────────────────────────────────────────────────

export interface AgentConfig {
  name: string;
  soul: string;
}

export interface OllamaConfig {
  host: string;
  model: string;
  timeout: number;
}

export interface ClaudeConfig {
  max_turns: number;
  permission_mode: string;
  allowed_tools: string[];
}

export interface DiscordChannelConfig {
  enabled: boolean;
  token: string;
  allowed_channels: string[];
  command_prefix: string;
}

export interface ChannelsConfig {
  discord: DiscordChannelConfig;
}

export interface HeartbeatConfig {
  interval_ms: number;
  timeout_ms: number;
}

export interface MemoryConfig {
  database: string;
  max_context_messages: number;
  compaction_threshold: number;
}

export interface SpotifyMonitorConfig {
  enabled: boolean;
  artist_id: string;
  interval_ms: number;
}

export interface TracklistsMonitorConfig {
  enabled: boolean;
  artist_url: string;
  rate_limit_ms: number;
  interval_ms: number;
}

export interface EnvoyJobsMonitorConfig {
  enabled: boolean;
  check_interval_minutes: number;
  keywords: string[];
}

export interface MonitorNotificationConfig {
  target_user_id?: string;
  target_channel_id?: string;
  rate_limit_ms: number;
  follower_milestone_step: number;
  popularity_milestone_step: number;
}

export interface WeatherBriefingConfig {
  enabled: boolean;
  location: string;
  units: 'imperial' | 'metric';
}

export interface GitHubBriefingConfig {
  enabled: boolean;
}

export interface BriefingConfig {
  enabled: boolean;
  hour: number;
  timezone: string;
  weather?: WeatherBriefingConfig;
  github?: GitHubBriefingConfig;
}

export interface MonitorsConfig {
  spotify: SpotifyMonitorConfig;
  tracklists: TracklistsMonitorConfig;
  envoy_jobs?: EnvoyJobsMonitorConfig;
  notifications: MonitorNotificationConfig;
  briefing?: BriefingConfig;
}

export interface VirgilConfig {
  agent: AgentConfig;
  ollama: OllamaConfig;
  claude: ClaudeConfig;
  channels: ChannelsConfig;
  heartbeat: HeartbeatConfig;
  memory: MemoryConfig;
  monitors?: MonitorsConfig;
}

// ── SOUL.md types ───────────────────────────────────────────────

/** A parsed section from SOUL.md */
export interface SoulSection {
  /** Section heading (e.g. "Identity", "Rules") */
  heading: string;
  /** Heading depth (1 = #, 2 = ##, etc.) */
  depth: number;
  /** Raw markdown content of the section */
  content: string;
  /** Parsed bullet points, if the section is a list */
  items: string[];
}

/** Fully parsed SOUL.md */
export interface SoulConfig {
  /** The agent name from the top-level heading */
  name: string;
  /** All parsed sections */
  sections: SoulSection[];
  /** Raw markdown source */
  raw: string;
}

// ── Environment variable interpolation ──────────────────────────

/**
 * Replaces `${VAR_NAME}` patterns in a string with values from `process.env`.
 * Unresolved variables are left as empty strings.
 */
function interpolateEnv(text: string): string {
  return text.replace(/\$\{(\w+)}/g, (_, varName: string) => {
    return process.env[varName] ?? '';
  });
}

// ── SOUL.md parser ──────────────────────────────────────────────

/**
 * Strips optional YAML frontmatter (delimited by `---`) from markdown.
 */
function stripFrontmatter(markdown: string): string {
  const trimmed = markdown.trimStart();
  if (!trimmed.startsWith('---')) return markdown;
  const endIndex = trimmed.indexOf('---', 3);
  if (endIndex === -1) return markdown;
  return trimmed.slice(endIndex + 3).trimStart();
}

/**
 * Extracts bullet items from a markdown section body.
 * Supports both `- item` and `* item` syntax.
 */
function extractItems(content: string): string[] {
  const items: string[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(/^\s*[-*]\s+(.+)/);
    if (match) {
      items.push(match[1].trim());
    }
  }
  return items;
}

/**
 * Parses a SOUL.md file into structured sections.
 *
 * @param filePath - Absolute or relative path to the SOUL.md file
 * @returns Parsed soul configuration
 * @throws If the file cannot be read
 */
export function parseSoulFile(filePath: string): SoulConfig {
  const raw = readFileSync(filePath, 'utf-8');
  const body = stripFrontmatter(raw);
  const lines = body.split('\n');

  let name = 'Virgil';
  const sections: SoulSection[] = [];
  let currentSection: SoulSection | null = null;
  const contentLines: string[] = [];

  const flushSection = () => {
    if (currentSection) {
      currentSection.content = contentLines.join('\n').trim();
      currentSection.items = extractItems(currentSection.content);
      sections.push(currentSection);
      contentLines.length = 0;
    }
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      flushSection();
      const depth = headingMatch[1].length;
      const heading = headingMatch[2].trim();
      if (depth === 1) {
        name = heading;
      }
      currentSection = { heading, depth, content: '', items: [] };
    } else {
      contentLines.push(line);
    }
  }
  flushSection();

  return { name, sections, raw };
}

// ── Config loader ───────────────────────────────────────────────

/**
 * Loads and validates the Virgil configuration.
 *
 * @param configPath - Path to virgil.yaml (default: `./config/virgil.yaml`)
 * @returns Fully resolved configuration with env vars interpolated
 * @throws If the config file cannot be read or is malformed
 */
export function loadConfig(configPath?: string): VirgilConfig {
  const resolvedPath = resolve(configPath ?? './config/virgil.yaml');
  const rawYaml = readFileSync(resolvedPath, 'utf-8');
  const interpolated = interpolateEnv(rawYaml);
  const parsed = parseYaml(interpolated) as VirgilConfig;

  // Resolve the SOUL.md path relative to the config file
  if (parsed.agent?.soul) {
    const configDir = dirname(resolvedPath);
    parsed.agent.soul = resolve(configDir, '..', parsed.agent.soul);
  }

  // Resolve the database path relative to the project root
  if (parsed.memory?.database) {
    const configDir = dirname(resolvedPath);
    parsed.memory.database = resolve(configDir, '..', parsed.memory.database);
  }

  return parsed;
}

/**
 * Loads the full Virgil configuration including the parsed SOUL.md.
 *
 * @param configPath - Path to virgil.yaml
 * @returns Config and soul data
 */
export function loadFullConfig(configPath?: string): {
  config: VirgilConfig;
  soul: SoulConfig;
} {
  const config = loadConfig(configPath);
  const soul = parseSoulFile(config.agent.soul);
  return { config, soul };
}
