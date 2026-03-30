/**
 * Daily Briefing — Assembles data from all sources and sends
 * a formatted morning DM via Discord.
 *
 * Runs on a 1-minute check interval. Fires once per day at
 * the configured hour (in the configured timezone). Tracks
 * the last briefing date in SQLite to prevent duplicates.
 *
 * No API keys required — uses wttr.in, gh CLI, and web scraping.
 */

import type { MemoryStore, ArtistMetricsRow, DJSupportRow } from '../memory/store.js';
import type { DiscordNotifier } from './notifier.js';
import { WeatherClient, type WeatherConfig, type WeatherData } from './weather.js';
import { GitHubClient, type GitHubConfig, type GitHubActivitySummary } from './github-activity.js';
import { SpotifyClient, type SpotifyConfig, type SpotifyArtist } from './spotify.js';

// ── Types ───────────────────────────────────────────────────────

export interface BriefingConfig {
  enabled: boolean;
  /** Hour of day to send briefing (0-23) in local timezone */
  hour: number;
  /** IANA timezone, e.g. "America/Los_Angeles" */
  timezone: string;
  weather?: WeatherConfig;
  github?: GitHubConfig;
}

interface BriefingSection {
  name: string;
  content: string;
}

// ── Constants ───────────────────────────────────────────────────

/** Check every 60 seconds if it's time to send the briefing */
export const BRIEFING_CHECK_INTERVAL_MS = 60_000;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// ── Greeting logic ──────────────────────────────────────────────

function getGreeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function getDateString(timezone: string): { formatted: string; dateKey: string; hour: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = get('weekday');
  const month = get('month');
  const day = get('day');
  const year = get('year');
  const hour = parseInt(get('hour'), 10);

  const monthNum = (MONTH_NAMES.indexOf(month) + 1).toString().padStart(2, '0');
  const dayNum = day.padStart(2, '0');
  const dateKey = `${year}-${monthNum}-${dayNum}`;

  return {
    formatted: `${weekday}, ${month} ${day}, ${year}`,
    dateKey,
    hour,
  };
}

// ── DailyBriefing class ─────────────────────────────────────────

export class DailyBriefing {
  private config: BriefingConfig;
  private store: MemoryStore;
  private notifier: DiscordNotifier;
  private weatherClient: WeatherClient | null = null;
  private githubClient: GitHubClient | null = null;
  private spotifyClient: SpotifyClient | null = null;
  private spotifyArtistId: string | null = null;

  constructor(
    config: BriefingConfig,
    store: MemoryStore,
    notifier: DiscordNotifier,
    spotifyConfig?: SpotifyConfig,
  ) {
    this.config = config;
    this.store = store;
    this.notifier = notifier;

    // Weather — just needs a location, no API key
    if (config.weather?.enabled) {
      this.weatherClient = new WeatherClient(config.weather);
    }

    // GitHub — uses `gh` CLI, no PAT needed
    if (config.github?.enabled && GitHubClient.isAvailable()) {
      this.githubClient = new GitHubClient(config.github);
    }

    // Spotify — scrapes public pages, no client credentials needed
    if (spotifyConfig?.enabled && spotifyConfig.artist_id) {
      this.spotifyClient = new SpotifyClient(spotifyConfig);
      this.spotifyArtistId = spotifyConfig.artist_id;
    }
  }

  /**
   * Checks if it's time to send the briefing and sends it if so.
   * Designed to be called every minute by the scheduler.
   */
  async checkAndSend(): Promise<void> {
    const { formatted, dateKey, hour } = getDateString(this.config.timezone);

    // Only fire at the configured hour
    if (hour !== this.config.hour) return;

    // Check if we already sent today
    if (this.store.isBriefingSent(dateKey)) return;

    console.log(`  [briefing] Sending daily briefing for ${dateKey}...`);

    try {
      const message = await this.buildBriefing(formatted, dateKey);

      // Mark as sent BEFORE sending (prevents race conditions / double-sends)
      this.store.logBriefing(dateKey, message);

      await this.notifier.sendBriefing(message);

      console.log(`  [briefing] Daily briefing sent for ${dateKey}`);
    } catch (err) {
      console.error(
        '  [briefing] Failed to build/send briefing:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Force-sends a briefing immediately, regardless of schedule.
   * Useful for testing or manual triggers.
   */
  async sendNow(): Promise<string> {
    const { formatted, dateKey } = getDateString(this.config.timezone);
    const message = await this.buildBriefing(formatted, dateKey);
    await this.notifier.sendBriefing(message);
    this.store.logBriefing(dateKey, message);
    return message;
  }

  // ── Build the briefing ────────────────────────────────────────

  private async buildBriefing(dateFormatted: string, _dateKey: string): Promise<string> {
    const { hour } = getDateString(this.config.timezone);
    const greeting = getGreeting(hour);
    const sections: BriefingSection[] = [];

    // Gather all sections concurrently
    const [weather, spotify, djSupport, github] = await Promise.allSettled([
      this.gatherWeather(),
      this.gatherSpotify(),
      this.gatherDJSupport(),
      this.gatherGitHub(),
    ]);

    if (weather.status === 'fulfilled' && weather.value) {
      sections.push({ name: 'Weather', content: weather.value });
    }

    if (spotify.status === 'fulfilled' && spotify.value) {
      sections.push({ name: 'Spotify', content: spotify.value });
    }

    if (djSupport.status === 'fulfilled' && djSupport.value) {
      sections.push({ name: 'DJ Support', content: djSupport.value });
    }

    if (github.status === 'fulfilled' && github.value) {
      sections.push({ name: 'GitHub', content: github.value });
    }

    // Assemble the message
    const lines: string[] = [
      `# ${greeting}, Keegan`,
      `*${dateFormatted}*`,
      '',
    ];

    if (sections.length === 0) {
      lines.push('All quiet today. No updates from any monitors.');
    } else {
      for (const section of sections) {
        lines.push(section.content);
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('*Your daily briefing from Virgil*');

    return lines.join('\n');
  }

  // ── Data gatherers ────────────────────────────────────────────

  private async gatherWeather(): Promise<string | null> {
    if (!this.weatherClient) return null;

    try {
      const data = await this.weatherClient.getCurrentWeather();
      return WeatherClient.format(data);
    } catch (err) {
      console.error('  [briefing] Weather fetch failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  private async gatherSpotify(): Promise<string | null> {
    if (!this.spotifyClient || !this.spotifyArtistId) return null;

    try {
      const artist = await this.spotifyClient.getArtist(this.spotifyArtistId);
      const history = this.store.getArtistMetricsHistory(this.spotifyArtistId, 'spotify', 2);

      const lines: string[] = [
        `🎵 **Verbala on Spotify**`,
        `   Followers: **${artist.followers.total.toLocaleString()}**`,
      ];

      if (artist.monthlyListeners != null && artist.monthlyListeners > 0) {
        lines.push(`   Monthly listeners: **${artist.monthlyListeners.toLocaleString()}**`);
      }

      if (artist.popularity > 0) {
        lines.push(`   Popularity: **${artist.popularity}**/100`);
      }

      // Show delta if we have history
      if (history.length >= 2) {
        const prev = history[1];
        const followerDelta = artist.followers.total - prev.followers;

        if (followerDelta !== 0) {
          const sign = followerDelta > 0 ? '+' : '';
          lines.push(`   Followers change: ${sign}${followerDelta.toLocaleString()} since last check`);
        }
      }

      return lines.join('\n');
    } catch (err) {
      console.error('  [briefing] Spotify fetch failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  private async gatherDJSupport(): Promise<string | null> {
    try {
      const recent = this.store.getRecentDJSupport(10);

      // Filter to only entries from the last 24 hours
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentEntries = recent.filter((r) => new Date(r.spotted_at) > oneDayAgo);

      if (recentEntries.length === 0) return null;

      const lines: string[] = [
        `🎧 **DJ Support** (last 24h) — ${recentEntries.length} new play${recentEntries.length === 1 ? '' : 's'}`,
      ];

      for (const entry of recentEntries.slice(0, 5)) {
        lines.push(`   • **${entry.dj_name}** played "${entry.track_name}"${entry.tracklist_title ? ` in *${entry.tracklist_title}*` : ''}`);
      }

      if (recentEntries.length > 5) {
        lines.push(`   _...and ${recentEntries.length - 5} more_`);
      }

      return lines.join('\n');
    } catch (err) {
      console.error('  [briefing] DJ support fetch failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  private async gatherGitHub(): Promise<string | null> {
    if (!this.githubClient) return null;

    try {
      const summary = await this.githubClient.getNotifications();
      return GitHubClient.format(summary);
    } catch (err) {
      console.error('  [briefing] GitHub fetch failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }
}
