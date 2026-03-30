/**
 * 1001Tracklists scraper for tracking DJ support.
 *
 * Fetches an artist's page on 1001Tracklists and parses it for
 * tracklist entries showing which DJs have played the artist's tracks.
 * No official API exists, so we scrape HTML with regex.
 *
 * Rate-limited to avoid being blocked.
 */

// ── Types ───────────────────────────────────────────────────────

export interface DJSupport {
  trackName: string;
  djName: string;
  tracklistUrl: string;
  tracklistTitle: string;
  spottedAt: Date;
}

export interface TracklistsConfig {
  enabled: boolean;
  artist_url: string;
  rate_limit_ms: number;
  interval_ms: number;
}

// ── Constants ───────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Scraper ─────────────────────────────────────────────────────

export class TracklistsScraper {
  private artistUrl: string;
  private rateLimitMs: number;
  private lastRequestAt = 0;

  constructor(config: TracklistsConfig) {
    this.artistUrl = config.artist_url;
    this.rateLimitMs = config.rate_limit_ms;
  }

  /**
   * Fetches the artist page and parses DJ support entries.
   *
   * @returns Array of DJ support entries found on the page
   */
  async fetchDJSupport(): Promise<DJSupport[]> {
    const html = await this.rateLimitedFetch(this.artistUrl);
    return this.parseArtistPage(html);
  }

  // ── Internal ────────────────────────────────────────────────

  /**
   * Fetches a URL with rate limiting to avoid being blocked.
   */
  private async rateLimitedFetch(url: string): Promise<string> {
    const now = Date.now();
    const wait = this.rateLimitMs - (now - this.lastRequestAt);
    if (wait > 0) {
      await this.delay(wait);
    }

    this.lastRequestAt = Date.now();

    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(
        `1001Tracklists fetch failed (${response.status}): ${response.statusText}`,
      );
    }

    return response.text();
  }

  /**
   * Parses the artist page HTML for tracklist/DJ support entries.
   *
   * 1001Tracklists pages typically contain:
   * - Track entries with links to tracklists
   * - DJ names associated with each tracklist
   * - Track titles
   *
   * This parser is intentionally defensive — HTML scraping is fragile.
   */
  private parseArtistPage(html: string): DJSupport[] {
    const results: DJSupport[] = [];
    const now = new Date();

    try {
      // Pattern 1: Look for tracklist entries with track and DJ info
      // 1001Tracklists typically has structured data in their pages
      // with links to tracklists containing track names and DJ names.

      // Match tracklist links: /tracklist/XXXXX/dj-name-venue-date/index.html
      const tracklistPattern =
        /<a[^>]*href="(\/tracklist\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
      const trackPattern =
        /<span[^>]*class="[^"]*trackValue[^"]*"[^>]*>([^<]+)<\/span>/gi;

      // Try to find tracklist entries with associated track names
      // The page structure varies, so we try multiple patterns

      // Pattern: Look for table rows or div blocks containing both
      // a tracklist link and a track name
      const blockPattern =
        /<(?:tr|div)[^>]*class="[^"]*(?:tlLink|trackRow|tl_entry)[^"]*"[^>]*>([\s\S]*?)<\/(?:tr|div)>/gi;

      let blockMatch: RegExpExecArray | null;
      while ((blockMatch = blockPattern.exec(html)) !== null) {
        const block = blockMatch[1];

        // Extract tracklist URL and title (DJ name is usually in the title)
        const linkMatch = /<a[^>]*href="(\/tracklist\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
        if (!linkMatch) continue;

        const tracklistUrl = `https://www.1001tracklists.com${linkMatch[1]}`;
        const tracklistTitle = this.stripTags(linkMatch[2]).trim();

        // Extract the DJ name from the tracklist title
        // Format is usually "DJ Name - Venue - Date" or "DJ Name @ Event"
        const djName = this.extractDJName(tracklistTitle);

        // Extract track name
        const trackMatch = /<span[^>]*class="[^"]*track[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block);
        const trackName = trackMatch
          ? this.stripTags(trackMatch[1]).trim()
          : 'Unknown Track';

        if (djName && trackName) {
          results.push({
            trackName,
            djName,
            tracklistUrl,
            tracklistTitle,
            spottedAt: now,
          });
        }
      }

      // Fallback: try to find any tracklist references on the page
      if (results.length === 0) {
        let match: RegExpExecArray | null;
        while ((match = tracklistPattern.exec(html)) !== null) {
          const url = `https://www.1001tracklists.com${match[1]}`;
          const title = this.stripTags(match[2]).trim();
          const djName = this.extractDJName(title);

          if (djName && title) {
            results.push({
              trackName: 'Unknown Track',
              djName,
              tracklistUrl: url,
              tracklistTitle: title,
              spottedAt: now,
            });
          }
        }
      }
    } catch (err) {
      console.error('1001Tracklists parse error:', err);
    }

    return results;
  }

  /**
   * Extracts a DJ name from a tracklist title.
   * Common formats: "DJ Name - Venue - Date", "DJ Name @ Event"
   */
  private extractDJName(title: string): string {
    // "DJ Name - Venue" or "DJ Name @ Event" patterns
    const dashSplit = title.split(/\s*[-@]\s*/);
    if (dashSplit.length > 0 && dashSplit[0].trim()) {
      return dashSplit[0].trim();
    }
    return title.trim();
  }

  /** Strips HTML tags from a string */
  private stripTags(html: string): string {
    return html.replace(/<[^>]+>/g, '').trim();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
