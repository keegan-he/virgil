/**
 * Discord channel integration for Virgil.
 *
 * Handles incoming messages and slash commands from Discord,
 * normalizes them into InboundMessages, sends them through the
 * gateway, and delivers responses back to the channel.
 *
 * Features:
 * - Message listening in configured channels + DMs
 * - Slash commands (/ask, /status, /skill)
 * - Threaded conversation support
 * - Typing indicator while processing
 * - Smart message splitting for Discord's 2000-char limit
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import { v4 as uuid } from 'uuid';
import type { Gateway } from '../gateway/gateway.js';
import type { DiscordChannelConfig } from '../gateway/config.js';
import type { InboundMessage } from './types.js';

// ── Constants ───────────────────────────────────────────────────

/** Discord's hard limit on message length */
const MAX_MESSAGE_LENGTH = 2000;

/** Typing indicator refresh interval (Discord typing lasts ~10s) */
const TYPING_INTERVAL_MS = 8000;

// ── Discord Bot ─────────────────────────────────────────────────

export class DiscordBot {
  private client: Client;
  private gateway: Gateway;
  private config: DiscordChannelConfig;
  private allowedChannels: Set<string>;
  private onDMChannel: ((channelId: string) => void) | null = null;
  private dmChannelDetected = false;
  private commandHandlers = new Map<string, (msg: Message) => Promise<void>>();

  constructor(gateway: Gateway, config: DiscordChannelConfig) {
    this.gateway = gateway;
    this.config = config;
    this.allowedChannels = new Set(config.allowed_channels);

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });
  }

  /**
   * Register a callback to be called when the bot first receives a DM.
   * Used to auto-detect the notification channel.
   */
  onFirstDM(callback: (channelId: string) => void): void {
    this.onDMChannel = callback;
  }

  /**
   * Register a !command handler. Commands are intercepted before
   * the message is routed through the gateway.
   */
  registerCommand(name: string, handler: (msg: Message) => Promise<void>): void {
    this.commandHandlers.set(name.toLowerCase(), handler);
  }

  /**
   * Starts the Discord bot: logs in, registers slash commands,
   * and begins listening for messages.
   */
  async start(): Promise<void> {
    this.setupEventHandlers();

    await this.client.login(this.config.token);
    console.log(`Discord: logged in as ${this.client.user?.tag}`);

    await this.registerSlashCommands();
  }

  /**
   * Returns the underlying Discord.js Client instance.
   * Used by the notifier to send DMs.
   */
  getClient(): Client {
    return this.client;
  }

  /**
   * Gracefully shuts down the Discord bot.
   */
  async stop(): Promise<void> {
    this.client.destroy();
    console.log('Discord: disconnected');
  }

  // ── Event handlers ──────────────────────────────────────────

  private setupEventHandlers(): void {
    this.client.on(Events.MessageCreate, (msg) => {
      this.handleMessage(msg).catch((err) => {
        console.error('Discord message handler error:', err);
      });
    });

    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      this.handleSlashCommand(interaction).catch((err) => {
        console.error('Discord slash command error:', err);
      });
    });
  }

  /**
   * Handles an incoming Discord message.
   */
  private async handleMessage(msg: Message): Promise<void> {
    // Ignore bot messages (including our own)
    if (msg.author.bot) return;

    // Check channel allowlist (empty = all channels allowed)
    if (this.allowedChannels.size > 0 && !this.allowedChannels.has(msg.channelId)) {
      return;
    }

    // Auto-detect DM channel for notifications (fires once)
    if (!this.dmChannelDetected && msg.channel.isDMBased()) {
      this.dmChannelDetected = true;
      if (this.onDMChannel) {
        this.onDMChannel(msg.channelId);
      }
    }

    // Check for !commands or /commands before routing to gateway
    if (msg.content.startsWith('!') || msg.content.startsWith('/')) {
      const cmd = msg.content.slice(1).split(/\s+/)[0].toLowerCase();
      const handler = this.commandHandlers.get(cmd);
      if (handler) {
        await handler(msg);
        return;
      }
    }

    // Normalize to InboundMessage
    const inbound = this.normalizeMessage(msg);

    // Start typing indicator
    const stopTyping = this.startTyping(msg.channel as TextChannel | ThreadChannel);

    try {
      const response = await this.gateway.process(inbound);
      stopTyping();
      await this.sendResponse(msg, response.content);
    } catch (err) {
      stopTyping();
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.sendResponse(msg, `Error: ${errorMsg}`);
    }
  }

  /**
   * Handles a slash command interaction.
   */
  private async handleSlashCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    switch (interaction.commandName) {
      case 'ask':
        await this.handleAskCommand(interaction);
        break;
      case 'status':
        await this.handleStatusCommand(interaction);
        break;
      case 'skill':
        await this.handleSkillCommand(interaction);
        break;
      default:
        await interaction.reply({ content: 'Unknown command.', ephemeral: true });
    }
  }

  /**
   * /ask <prompt> — sends a message through the gateway.
   */
  private async handleAskCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const prompt = interaction.options.getString('prompt', true);

    await interaction.deferReply();

    const inbound: InboundMessage = {
      id: uuid(),
      channel: 'discord',
      channelMessageId: interaction.id,
      userId: interaction.user.id,
      userName: interaction.user.username,
      content: prompt,
      timestamp: new Date(),
      threadId: interaction.channel?.isThread()
        ? interaction.channel.id
        : undefined,
    };

    try {
      const response = await this.gateway.process(inbound);
      const chunks = splitMessage(response.content);
      await interaction.editReply(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp(chunks[i]);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await interaction.editReply(`Error: ${errorMsg}`);
    }
  }

  /**
   * /status — reports Virgil's health status from the heartbeat monitor.
   */
  private async handleStatusCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const status = this.gateway.getHealthStatus();
    await interaction.reply({ content: status, ephemeral: true });
  }

  /**
   * /skill <name> [args] — invokes a registered skill directly.
   */
  private async handleSkillCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const skillName = interaction.options.getString('name', true);
    const argsRaw = interaction.options.getString('args') ?? '';

    // Show available skills if name is "list"
    if (skillName === 'list') {
      const skills = this.gateway.getSkills().list();
      const listing = skills
        .map((s) => `\`${s.name}\` — ${s.description}`)
        .join('\n');
      await interaction.reply({
        content: listing || 'No skills registered.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    try {
      const output = await this.gateway.executeSkill(
        skillName,
        {},
        argsRaw || undefined,
      );
      const chunks = splitMessage(output);
      await interaction.editReply(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp(chunks[i]);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await interaction.editReply(`Error: ${errorMsg}`);
    }
  }

  // ── Slash command registration ────────────────────────────────

  private async registerSlashCommands(): Promise<void> {
    const commands = [
      new SlashCommandBuilder()
        .setName('ask')
        .setDescription('Ask Virgil a question')
        .addStringOption((opt) =>
          opt
            .setName('prompt')
            .setDescription('Your question or request')
            .setRequired(true),
        ),
      new SlashCommandBuilder()
        .setName('status')
        .setDescription('Check Virgil system status'),
      new SlashCommandBuilder()
        .setName('skill')
        .setDescription('Invoke a Virgil skill (use "list" to see all)')
        .addStringOption((opt) =>
          opt
            .setName('name')
            .setDescription('Skill name (or "list" to see available skills)')
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('args')
            .setDescription('Arguments for the skill'),
        ),
    ];

    const rest = new REST().setToken(this.config.token);
    const clientId = this.client.user?.id;
    if (!clientId) return;

    try {
      await rest.put(Routes.applicationCommands(clientId), {
        body: commands.map((c) => c.toJSON()),
      });
      console.log('Discord: slash commands registered');
    } catch (err) {
      console.error('Discord: failed to register slash commands:', err);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────

  /**
   * Converts a Discord message into a normalized InboundMessage.
   */
  private normalizeMessage(msg: Message): InboundMessage {
    // Resolve thread context
    let threadId: string | undefined;
    if (msg.channel.isThread()) {
      threadId = msg.channel.id;
    }

    // Resolve reply context
    let replyToId: string | undefined;
    if (msg.reference?.messageId) {
      replyToId = msg.reference.messageId;
    }

    return {
      id: uuid(),
      channel: 'discord',
      channelMessageId: msg.id,
      userId: msg.author.id,
      userName: msg.author.username,
      content: msg.content,
      timestamp: msg.createdAt,
      threadId,
      replyToId,
      attachments: msg.attachments.map((a) => ({
        name: a.name,
        mimeType: a.contentType ?? 'application/octet-stream',
        url: a.url,
        size: a.size,
      })),
    };
  }

  /**
   * Sends a response, splitting if needed, as a reply to the original message.
   */
  private async sendResponse(original: Message, content: string): Promise<void> {
    const chunks = splitMessage(content);
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        await original.reply(chunks[i]);
      } else if ('send' in original.channel) {
        await original.channel.send(chunks[i]);
      }
    }
  }

  /**
   * Starts a typing indicator that refreshes until stopped.
   * Returns a function to stop the indicator.
   */
  private startTyping(
    channel: TextChannel | ThreadChannel,
  ): () => void {
    let stopped = false;

    const pulse = () => {
      if (stopped) return;
      channel.sendTyping().catch(() => {});
    };

    pulse();
    const interval = setInterval(pulse, TYPING_INTERVAL_MS);
    interval.unref();

    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }
}

// ── Message splitting ───────────────────────────────────────────

/**
 * Splits a message into chunks that fit within Discord's character limit.
 * Preserves code block integrity where possible.
 */
function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Find a good split point
    let splitAt = MAX_MESSAGE_LENGTH;

    // Try to split at a newline
    const lastNewline = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (lastNewline > MAX_MESSAGE_LENGTH * 0.5) {
      splitAt = lastNewline;
    } else {
      // Try to split at a space
      const lastSpace = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
      if (lastSpace > MAX_MESSAGE_LENGTH * 0.5) {
        splitAt = lastSpace;
      }
    }

    const chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt).trimStart();

    // Balance code fences: if chunk has an odd number of ```, close/reopen
    const fenceCount = (chunk.match(/```/g) || []).length;
    if (fenceCount % 2 !== 0) {
      chunks.push(chunk + '\n```');
      remaining = '```\n' + remaining;
    } else {
      chunks.push(chunk);
    }
  }

  return chunks;
}
