/**
 * Generic careers page scraper for keyword-matched job listings.
 *
 * Fetches a public jobs/careers page and parses it for job listings
 * matching configurable keywords. No API key needed — scrapes
 * the public HTML page directly.
 *
 * Works with any company's careers page that uses standard HTML patterns
 * or JSON-LD structured data (schema.org JobPosting).
 *
 * Rate-limited to avoid being blocked.
 */

// ── Types ───────────────────────────────────────────────────────

export interface JobListing {
  title: string;
  url: string;
  department: string;
  location: string;
}

export interface JobsMonitorConfig {
  enabled: boolean;
  /** Human-readable label for this monitor (used in logs and notifications) */
  name: string;
  /** URL of the careers/jobs page to scrape */
  jobs_url: string;
  check_interval_minutes: number;
  keywords: string[];
}

// ── Constants ───────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Scraper ─────────────────────────────────────────────────────

export class JobsScraper {
  private keywords: string[];
  private jobsUrl: string;
  private baseUrl: string;
  private name: string;

  constructor(config: JobsMonitorConfig) {
    this.keywords = config.keywords.map((kw) => kw.toLowerCase());
    this.jobsUrl = config.jobs_url;
    this.name = config.name;

    // Derive base URL for resolving relative links
    try {
      const parsed = new URL(config.jobs_url);
      this.baseUrl = `${parsed.protocol}//${parsed.host}`;
    } catch {
      this.baseUrl = '';
    }
  }

  /**
   * Fetches the jobs page and returns all keyword-matched listings.
   */
  async fetchMatchingJobs(): Promise<JobListing[]> {
    const html = await this.fetchPage(this.jobsUrl);
    const allJobs = this.parseJobsPage(html);
    return this.filterByKeywords(allJobs);
  }

  // ── Internal ────────────────────────────────────────────────

  /**
   * Fetches a URL and returns its HTML content.
   */
  private async fetchPage(url: string): Promise<string> {
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
        `${this.name} jobs fetch failed (${response.status}): ${response.statusText}`,
      );
    }

    return response.text();
  }

  /**
   * Parses a jobs page HTML and extracts job listings.
   *
   * Uses three strategies in order:
   * 1. JSON-LD structured data (schema.org JobPosting)
   * 2. Common job link patterns (/jobs/, /careers/, /positions/)
   * 3. Broad CSS class-based block detection
   *
   * Intentionally defensive — HTML scraping is fragile.
   */
  private parseJobsPage(html: string): JobListing[] {
    const jobs: JobListing[] = [];

    try {
      // Strategy 1: Look for JSON-LD structured data
      const jsonLdPattern =
        /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
      let jsonLdMatch: RegExpExecArray | null;
      while ((jsonLdMatch = jsonLdPattern.exec(html)) !== null) {
        try {
          const data = JSON.parse(jsonLdMatch[1]);
          const extracted = this.extractFromJsonLd(data);
          if (extracted.length > 0) {
            jobs.push(...extracted);
          }
        } catch {
          // JSON parse failed — continue with other strategies
        }
      }

      if (jobs.length > 0) return jobs;

      // Strategy 2: Look for common job listing HTML patterns
      const jobLinkPattern =
        /<a[^>]*href=["']((?:https?:\/\/[^"']*)?\/(?:jobs|careers|positions|openings)\/[^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let linkMatch: RegExpExecArray | null;
      const seenUrls = new Set<string>();

      while ((linkMatch = jobLinkPattern.exec(html)) !== null) {
        let url = linkMatch[1];
        const linkContent = this.stripTags(linkMatch[2]).trim();

        // Skip empty links, navigation links, or overly short text
        if (!linkContent || linkContent.length < 3) continue;

        // Make relative URLs absolute
        if (url.startsWith('/')) {
          url = `${this.baseUrl}${url}`;
        }

        // Deduplicate by URL
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);

        // Try to find department and location from surrounding context
        const context = this.extractJobContext(html, linkMatch.index);

        jobs.push({
          title: linkContent,
          url,
          department: context.department,
          location: context.location,
        });
      }

      if (jobs.length > 0) return jobs;

      // Strategy 3: Broader pattern — look for any structured job-like blocks
      const blockPattern =
        /<(?:div|li|article|section)[^>]*class="[^"]*(?:job|position|opening|role|career|posting)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|li|article|section)>/gi;
      let blockMatch: RegExpExecArray | null;

      while ((blockMatch = blockPattern.exec(html)) !== null) {
        const block = blockMatch[1];

        // Find a link within the block
        const innerLink =
          /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
        if (!innerLink) continue;

        let url = innerLink[1];
        const title = this.stripTags(innerLink[2]).trim();
        if (!title || title.length < 3) continue;

        if (url.startsWith('/')) {
          url = `${this.baseUrl}${url}`;
        }

        if (seenUrls.has(url)) continue;
        seenUrls.add(url);

        // Extract department and location from the block
        const department = this.extractField(block, [
          'department',
          'team',
          'group',
          'category',
        ]);
        const location = this.extractField(block, [
          'location',
          'office',
          'region',
          'place',
        ]);

        jobs.push({
          title,
          url,
          department: department || 'Unknown',
          location: location || 'Unknown',
        });
      }
    } catch (err) {
      console.error(`  [jobs-monitor] ${this.name} parse error:`, err);
    }

    return jobs;
  }

  /**
   * Extracts job listings from JSON-LD structured data.
   */
  private extractFromJsonLd(data: unknown): JobListing[] {
    const jobs: JobListing[] = [];

    if (!data || typeof data !== 'object') return jobs;

    // Handle arrays of job postings
    if (Array.isArray(data)) {
      for (const item of data) {
        jobs.push(...this.extractFromJsonLd(item));
      }
      return jobs;
    }

    const record = data as Record<string, unknown>;

    // Check if this is a JobPosting schema
    if (
      record['@type'] === 'JobPosting' ||
      record.type === 'JobPosting'
    ) {
      const title =
        typeof record.title === 'string'
          ? record.title
          : typeof record.name === 'string'
            ? record.name
            : '';

      let url = '';
      if (typeof record.url === 'string') {
        url = record.url;
      } else if (typeof record.sameAs === 'string') {
        url = record.sameAs;
      }

      let department = 'Unknown';
      if (record.department && typeof record.department === 'object') {
        const dept = record.department as Record<string, unknown>;
        if (typeof dept.name === 'string') department = dept.name;
      } else if (typeof record.department === 'string') {
        department = record.department;
      } else if (typeof record.industry === 'string') {
        department = record.industry;
      }

      let location = 'Unknown';
      if (record.jobLocation && typeof record.jobLocation === 'object') {
        const loc = record.jobLocation as Record<string, unknown>;
        if (loc.address && typeof loc.address === 'object') {
          const addr = loc.address as Record<string, unknown>;
          const parts = [addr.addressLocality, addr.addressRegion].filter(Boolean);
          if (parts.length > 0) location = parts.join(', ') as string;
        } else if (typeof loc.name === 'string') {
          location = loc.name;
        }
      } else if (typeof record.jobLocation === 'string') {
        location = record.jobLocation;
      }

      if (title) {
        jobs.push({ title, url, department, location });
      }
    }

    // Check for @graph array (common LD+JSON pattern)
    if (Array.isArray(record['@graph'])) {
      for (const item of record['@graph']) {
        jobs.push(...this.extractFromJsonLd(item));
      }
    }

    // Check for itemListElement (e.g., search results page)
    if (Array.isArray(record.itemListElement)) {
      for (const item of record.itemListElement) {
        if (typeof item === 'object' && item !== null) {
          const elem = item as Record<string, unknown>;
          if (elem.item) {
            jobs.push(...this.extractFromJsonLd(elem.item));
          }
        }
      }
    }

    return jobs;
  }

  /**
   * Extracts contextual information (department, location) from the HTML
   * surrounding a job link.
   */
  private extractJobContext(
    html: string,
    linkIndex: number,
  ): { department: string; location: string } {
    // Look at a window of text around the link for context
    const start = Math.max(0, linkIndex - 500);
    const end = Math.min(html.length, linkIndex + 1000);
    const context = html.slice(start, end);

    const department = this.extractField(context, [
      'department',
      'team',
      'group',
      'category',
    ]);
    const location = this.extractField(context, [
      'location',
      'office',
      'region',
    ]);

    return {
      department: department || 'Unknown',
      location: location || 'Unknown',
    };
  }

  /**
   * Tries to extract a field value from HTML by looking for common patterns.
   */
  private extractField(html: string, fieldNames: string[]): string {
    for (const name of fieldNames) {
      // Pattern: class containing the field name, with text content
      const classPattern = new RegExp(
        `<[^>]*class="[^"]*${name}[^"]*"[^>]*>([\\s\\S]*?)<\\/`,
        'i',
      );
      const classMatch = classPattern.exec(html);
      if (classMatch) {
        const value = this.stripTags(classMatch[1]).trim();
        if (value && value.length < 100) return value;
      }

      // Pattern: data attribute or aria-label
      const attrPattern = new RegExp(
        `data-${name}=["']([^"']+)["']`,
        'i',
      );
      const attrMatch = attrPattern.exec(html);
      if (attrMatch) {
        return attrMatch[1].trim();
      }
    }

    return '';
  }

  /**
   * Filters jobs by configured keywords, matching against title and department.
   */
  private filterByKeywords(jobs: JobListing[]): JobListing[] {
    return jobs.filter((job) => {
      const searchText =
        `${job.title} ${job.department}`.toLowerCase();
      return this.keywords.some((kw) => searchText.includes(kw));
    });
  }

  /** Strips HTML tags from a string */
  private stripTags(html: string): string {
    return html.replace(/<[^>]+>/g, '').trim();
  }
}
