/**
 * GitHub activity client for daily briefing — no API key required.
 *
 * Uses the `gh` CLI (already authenticated on the machine) to fetch
 * notifications and activity. No PAT needed in .env.
 */

import { execSync } from 'node:child_process';

// ── Types ───────────────────────────────────────────────────────

export interface GitHubConfig {
  enabled: boolean;
}

export interface GitHubNotification {
  id: string;
  reason: string;
  unread: boolean;
  subject: {
    title: string;
    type: string; // 'Issue', 'PullRequest', 'Release', 'Discussion', etc.
    url: string;
  };
  repository: {
    full_name: string;
    html_url: string;
  };
  updated_at: string;
}

export interface GitHubActivitySummary {
  unreadCount: number;
  notifications: GitHubNotification[];
  /** Grouped counts by type */
  byType: Record<string, number>;
  /** Grouped counts by repo */
  byRepo: Record<string, number>;
}

// ── Type emoji mapping ──────────────────────────────────────────

const TYPE_EMOJI: Record<string, string> = {
  Issue: '📋',
  PullRequest: '🔀',
  Release: '🚀',
  Discussion: '💬',
  CheckSuite: '✅',
  Commit: '🔹',
};

// ── Client ──────────────────────────────────────────────────────

export class GitHubClient {
  constructor(_config: GitHubConfig) {
    // No API key needed — we use `gh` CLI
  }

  /**
   * Checks if `gh` CLI is available and authenticated.
   */
  static isAvailable(): boolean {
    try {
      execSync('gh auth status', { timeout: 5000, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fetches unread GitHub notifications using `gh` CLI.
   */
  async getNotifications(): Promise<GitHubActivitySummary> {
    try {
      const output = execSync(
        'gh api notifications --method GET -q "." 2>/dev/null',
        { timeout: 15_000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );

      const raw = JSON.parse(output || '[]') as Array<{
        id: string;
        reason: string;
        unread: boolean;
        subject: { title: string; type: string; url: string };
        repository: { full_name: string; html_url: string };
        updated_at: string;
      }>;

      const notifications: GitHubNotification[] = raw.map((n) => ({
        id: n.id,
        reason: n.reason,
        unread: n.unread,
        subject: {
          title: n.subject.title,
          type: n.subject.type,
          url: n.subject.url ?? '',
        },
        repository: {
          full_name: n.repository.full_name,
          html_url: n.repository.html_url,
        },
        updated_at: n.updated_at,
      }));

      // Group by type
      const byType: Record<string, number> = {};
      const byRepo: Record<string, number> = {};

      for (const n of notifications) {
        byType[n.subject.type] = (byType[n.subject.type] ?? 0) + 1;
        byRepo[n.repository.full_name] = (byRepo[n.repository.full_name] ?? 0) + 1;
      }

      return {
        unreadCount: notifications.length,
        notifications,
        byType,
        byRepo,
      };
    } catch (err) {
      // If gh fails, return empty summary rather than crashing
      console.error(
        '  [github] gh CLI failed:',
        err instanceof Error ? err.message : err,
      );
      return {
        unreadCount: 0,
        notifications: [],
        byType: {},
        byRepo: {},
      };
    }
  }

  /**
   * Formats GitHub activity into a briefing-friendly string.
   */
  static format(summary: GitHubActivitySummary): string {
    if (summary.unreadCount === 0) {
      return '✅ **GitHub** — No unread notifications. Inbox zero!';
    }

    const lines: string[] = [
      `📦 **GitHub** — ${summary.unreadCount} unread notification${summary.unreadCount === 1 ? '' : 's'}`,
    ];

    // Type breakdown
    for (const [type, count] of Object.entries(summary.byType)) {
      const emoji = TYPE_EMOJI[type] ?? '🔹';
      lines.push(`   ${emoji} ${count} ${type}${count === 1 ? '' : 's'}`);
    }

    // Top 3 repos with activity
    const topRepos = Object.entries(summary.byRepo)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3);

    if (topRepos.length > 0) {
      lines.push('   **Top repos:**');
      for (const [repo, count] of topRepos) {
        lines.push(`   • \`${repo}\` (${count})`);
      }
    }

    // Show first 3 notification titles
    const preview = summary.notifications.slice(0, 3);
    if (preview.length > 0) {
      lines.push('   **Recent:**');
      for (const n of preview) {
        const emoji = TYPE_EMOJI[n.subject.type] ?? '🔹';
        lines.push(`   ${emoji} ${n.subject.title}`);
      }
      if (summary.unreadCount > 3) {
        lines.push(`   _...and ${summary.unreadCount - 3} more_`);
      }
    }

    return lines.join('\n');
  }
}
