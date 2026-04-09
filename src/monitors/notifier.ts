/**
 * Discord notification sender for monitor alerts.
 *
 * Sends milestone alerts, DJ support notifications, and daily briefings
 * to a Discord channel. Auto-detects the target channel from the first
 * DM the bot receives — no user ID or channel ID config needed.
 */

import type { Client, DMChannel, TextChannel, NewsChannel, ThreadChannel } from 'discord.js';

type SendableChannel = DMChannel | TextChannel | NewsChannel | ThreadChannel;

// ── Types ───────────────────────────────────────────────────────

export interface NotifierConfig {
  target_user_id?: string;
  target_channel_id?: string;
  rate_limit_ms: number;
  follower_milestone_step: number;
  popularity_milestone_step: number;
}

// ── Notifier ────────────────────────────────────────────────────

export class DiscordNotifier {
  private client: Client;
  private targetUserId?: string;
  private targetChannelId?: string;
  private rateLimitMs: number;
  private lastSentAt = 0;

  constructor(client: Client, config: NotifierConfig) {
    this.client = client;
    this.targetUserId = config.target_user_id || undefined;
    this.targetChannelId = config.target_channel_id || undefined;
    this.rateLimitMs = config.rate_limit_ms;
  }

  /**
   * Auto-detect: set the target channel from an incoming DM.
   * Called by the Discord bot when it first receives a DM.
   */
  setTargetChannel(channelId: string): void {
    if (!this.targetChannelId) {
      this.targetChannelId = channelId;
      console.log(`  [notifier] Auto-detected target channel: ${channelId}`);
    }
  }

  /**
   * Returns true if the notifier has a valid delivery target.
   */
  isReady(): boolean {
    return !!(this.targetChannelId || this.targetUserId);
  }

  /**
   * Sends a milestone notification.
   */
  async sendMilestone(message: string): Promise<void> {
    await this.send(`🎉 **Milestone** — ${message}`);
  }

  /**
   * Sends a DJ support alert.
   */
  async sendDJAlert(message: string): Promise<void> {
    await this.send(`🎧 **DJ Support** — ${message}`);
  }

  /**
   * Sends a general monitor alert.
   */
  async sendAlert(message: string): Promise<void> {
    await this.send(`\uD83D\uDCCA **Monitor** — ${message}`);
  }

  /**
   * Sends a job listing alert.
   */
  async sendJobAlert(message: string): Promise<void> {
    await this.send(`\uD83D\uDCBC **Job Alert** — ${message}`);
  }

  /**
   * Sends the daily briefing.
   * Bypasses the normal emoji prefix since briefings have their own formatting.
   * Also bypasses rate limiting — briefings should always go through.
   */
  async sendBriefing(message: string): Promise<void> {
    try {
      const channel = await this.resolveChannel();
      if (!channel) {
        console.log('  [notifier] No target channel — briefing not sent. Send me a DM on Discord first!');
        return;
      }

      const chunks = this.splitMessage(message, 2000);
      for (const chunk of chunks) {
        await channel.send(chunk);
      }

      this.lastSentAt = Date.now();
      console.log(`  [notifier] Sent daily briefing (${chunks.length} message${chunks.length === 1 ? '' : 's'})`);
    } catch (err) {
      console.error(
        '  [notifier] Failed to send briefing:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Splits a long message into chunks at line boundaries.
   */
  private splitMessage(content: string, maxLength: number): string[] {
    if (content.length <= maxLength) return [content];

    const chunks: string[] = [];
    const lines = content.split('\n');
    let current = '';

    for (const line of lines) {
      if (current.length + line.length + 1 > maxLength) {
        chunks.push(current.trimEnd());
        current = line + '\n';
      } else {
        current += line + '\n';
      }
    }

    if (current.trim()) {
      chunks.push(current.trimEnd());
    }

    return chunks;
  }

  // ── Internal ────────────────────────────────────────────────

  /**
   * Resolves the target channel — prefers channel ID, falls back to user DM.
   */
  private async resolveChannel(): Promise<SendableChannel | null> {
    // Option 1: Direct channel ID (auto-detected or configured)
    if (this.targetChannelId) {
      try {
        const channel = await this.client.channels.fetch(this.targetChannelId);
        if (channel && 'send' in channel) {
          return channel as SendableChannel;
        }
      } catch {
        console.error(`  [notifier] Failed to fetch channel ${this.targetChannelId}`);
      }
    }

    // Option 2: User ID → create DM
    if (this.targetUserId) {
      try {
        const user = await this.client.users.fetch(this.targetUserId);
        return await user.createDM();
      } catch {
        console.error(`  [notifier] Failed to create DM for user ${this.targetUserId}`);
      }
    }

    return null;
  }

  private async send(content: string): Promise<void> {
    const now = Date.now();

    if (now - this.lastSentAt < this.rateLimitMs) {
      console.log(
        `  [notifier] Rate limited, skipping: ${content.slice(0, 80)}...`,
      );
      return;
    }

    try {
      const channel = await this.resolveChannel();
      if (!channel) {
        console.log('  [notifier] No target channel — message not sent. Send me a DM on Discord first!');
        return;
      }

      await channel.send(content);
      this.lastSentAt = Date.now();
      console.log(`  [notifier] Sent: ${content.slice(0, 80)}`);
    } catch (err) {
      console.error(
        '  [notifier] Failed to send:',
        err instanceof Error ? err.message : err,
      );
    }
  }
}
