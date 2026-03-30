/**
 * Web search skill — fetches content from URLs.
 *
 * Provides basic web fetching for retrieving page content.
 * For full search capabilities, Claude handles this natively
 * via its WebSearch tool — this skill covers direct URL fetching.
 */

import type { Skill, SkillInput, SkillResult } from './registry.js';

/** Maximum response body size to return (100KB) */
const MAX_BODY_SIZE = 100_000;

/** Fetch timeout in milliseconds */
const FETCH_TIMEOUT_MS = 15_000;

/** Fetch the content of a URL */
export const webFetch: Skill = {
  name: 'web-fetch',
  description: 'Fetch the text content of a URL',
  params: [
    { name: 'url', description: 'URL to fetch', type: 'string', required: true },
  ],
  async execute(input: SkillInput): Promise<SkillResult> {
    const url = String(input.params.url ?? input.raw ?? '');
    if (!url) {
      return { success: false, output: 'No URL provided' };
    }

    // Basic URL validation
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { success: false, output: `Invalid URL: ${url}` };
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { success: false, output: `Unsupported protocol: ${parsed.protocol}` };
    }

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Virgil/0.1 (personal-agent)',
          Accept: 'text/html, text/plain, application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
      });

      if (!response.ok) {
        return {
          success: false,
          output: `HTTP ${response.status} ${response.statusText} for ${url}`,
        };
      }

      let body = await response.text();

      // Truncate if too large
      if (body.length > MAX_BODY_SIZE) {
        body = body.slice(0, MAX_BODY_SIZE) + '\n\n[...truncated]';
      }

      // Strip HTML tags for cleaner output
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/html')) {
        body = stripHtml(body);
      }

      return {
        success: true,
        output: body,
        data: {
          url,
          status: response.status,
          contentType,
          size: body.length,
        },
      };
    } catch (err) {
      return {
        success: false,
        output: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

/**
 * Strips HTML tags and collapses whitespace for a rough text extraction.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
