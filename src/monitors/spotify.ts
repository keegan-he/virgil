/**
 * Spotify artist data scraper — no API key required.
 *
 * Scrapes publicly available artist data from Spotify's open access
 * endpoint. Falls back to web scraping if the endpoint changes.
 * No client credentials or OAuth needed.
 */

// ── Types ───────────────────────────────────────────────────────

export interface SpotifyArtist {
  id: string;
  name: string;
  popularity: number;
  followers: { total: number };
  genres: string[];
  monthlyListeners: number | null;
}

export interface SpotifyConfig {
  enabled: boolean;
  artist_id: string;
  interval_ms: number;
}

// ── Constants ───────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// ── Client ──────────────────────────────────────────────────────

export class SpotifyClient {
  constructor(_config: SpotifyConfig) {
    // No API key needed — we scrape public data
  }

  /**
   * Fetches artist data by scraping Spotify's public-facing pages.
   *
   * Strategy:
   * 1. Try the open.spotify.com artist page and extract embedded JSON
   * 2. Parse out follower count, monthly listeners, popularity from meta/LD+JSON
   */
  async getArtist(artistId: string): Promise<SpotifyArtist> {
    const url = `https://open.spotify.com/artist/${artistId}`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`Spotify page fetch failed (${response.status}): ${response.statusText}`);
    }

    const html = await response.text();
    return this.parseArtistPage(html, artistId);
  }

  // ── Parsing ─────────────────────────────────────────────────

  private parseArtistPage(html: string, artistId: string): SpotifyArtist {
    // Default values in case parsing fails partially
    let name = 'Unknown Artist';
    let followers = 0;
    let monthlyListeners: number | null = null;
    let popularity = 0;
    const genres: string[] = [];

    // Try to extract from <title> tag: "Artist Name | Spotify"
    const titleMatch = html.match(/<title[^>]*>([^|<]+)/i);
    if (titleMatch) {
      name = titleMatch[1].trim();
    }

    // Try to extract from meta tags
    const descMatch = html.match(
      /<meta[^>]*name="description"[^>]*content="([^"]*)"[^>]*>/i,
    );
    if (descMatch) {
      const desc = descMatch[1];

      // Pattern: "Artist · Song · X monthly listeners"
      const listenersMatch = desc.match(
        /([\d,]+)\s*monthly\s*listener/i,
      );
      if (listenersMatch) {
        monthlyListeners = parseInt(listenersMatch[1].replace(/,/g, ''), 10);
      }
    }

    // Try to extract from Spotify's embedded __NEXT_DATA__ or resource JSON
    const nextDataMatch = html.match(
      /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
    );
    if (nextDataMatch) {
      try {
        const data = JSON.parse(nextDataMatch[1]);
        // Navigate the Next.js data structure for artist info
        const artistData = this.findArtistData(data);
        if (artistData) {
          if (artistData.name) name = artistData.name;
          if (artistData.followers != null) followers = artistData.followers;
          if (artistData.monthlyListeners != null) monthlyListeners = artistData.monthlyListeners;
          if (artistData.popularity != null) popularity = artistData.popularity;
          if (artistData.genres) genres.push(...artistData.genres);
        }
      } catch {
        // JSON parse failed — continue with other methods
      }
    }

    // Try to extract follower count from page content
    if (followers === 0) {
      // Look for patterns like "51,234 followers" or "followers.*51234"
      const followerPatterns = [
        /([\d,]+)\s*(?:total\s*)?followers/i,
        /followers[^"]*?([\d,]+)/i,
        /"followers"[^}]*?"total"\s*:\s*(\d+)/,
      ];
      for (const pattern of followerPatterns) {
        const match = html.match(pattern);
        if (match) {
          followers = parseInt(match[1].replace(/,/g, ''), 10);
          if (followers > 0) break;
        }
      }
    }

    // Try to find monthly listeners from page content
    if (monthlyListeners === null) {
      const mlPatterns = [
        /([\d,]+)\s*monthly\s*listener/i,
        /monthlyListeners['":\s]*([\d,]+)/i,
      ];
      for (const pattern of mlPatterns) {
        const match = html.match(pattern);
        if (match) {
          monthlyListeners = parseInt(match[1].replace(/,/g, ''), 10);
          if (monthlyListeners > 0) break;
        }
      }
    }

    return {
      id: artistId,
      name,
      popularity,
      followers: { total: followers },
      genres,
      monthlyListeners,
    };
  }

  /**
   * Recursively searches __NEXT_DATA__ for artist information.
   */
  private findArtistData(
    obj: unknown,
  ): {
    name?: string;
    followers?: number;
    monthlyListeners?: number;
    popularity?: number;
    genres?: string[];
  } | null {
    if (!obj || typeof obj !== 'object') return null;

    const record = obj as Record<string, unknown>;

    // Look for objects that look like artist data
    if (
      'profile' in record &&
      typeof record.profile === 'object' &&
      record.profile !== null
    ) {
      const profile = record.profile as Record<string, unknown>;
      if ('name' in profile) {
        return {
          name: profile.name as string,
          followers:
            typeof record.followers === 'number'
              ? record.followers
              : undefined,
          monthlyListeners:
            typeof record.monthlyListeners === 'number'
              ? record.monthlyListeners
              : undefined,
          popularity: undefined,
          genres: undefined,
        };
      }
    }

    // Check for stats objects
    if ('followers' in record && 'monthlyListeners' in record) {
      const stats = record as Record<string, unknown>;
      return {
        followers:
          typeof stats.followers === 'number'
            ? stats.followers
            : typeof stats.followers === 'object' && stats.followers !== null
              ? ((stats.followers as Record<string, unknown>).total as number)
              : undefined,
        monthlyListeners:
          typeof stats.monthlyListeners === 'number'
            ? stats.monthlyListeners
            : undefined,
      };
    }

    // Recurse into child objects
    for (const value of Object.values(record)) {
      if (typeof value === 'object' && value !== null) {
        const result = this.findArtistData(value);
        if (result && (result.name || result.followers || result.monthlyListeners)) {
          return result;
        }
      }
    }

    return null;
  }
}
