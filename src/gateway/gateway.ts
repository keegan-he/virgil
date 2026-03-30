/**
 * Gateway — the central message bus for Virgil.
 *
 * Receives normalized InboundMessages from any channel, orchestrates
 * routing, backend dispatch, session management, and returns
 * OutboundMessages. This is the single entry point that all channel
 * integrations talk to.
 */

import type { OllamaClient, OllamaMessage } from '../backends/ollama.js';
import type { ClaudeClient } from '../backends/claude.js';
import type { Router } from './router.js';
import type { SessionManager, ConversationContext } from './session.js';
import type { SoulConfig } from './config.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { ContextCompactor } from '../memory/compaction.js';
import type { HeartbeatMonitor } from '../heartbeat/monitor.js';
import type {
  InboundMessage,
  OutboundMessage,
  RouteDecision,
} from '../channels/types.js';

// ── Types ───────────────────────────────────────────────────────

/** Listener callback for gateway events */
export type GatewayEventListener = (event: GatewayEvent) => void;

/** Events emitted by the gateway for observability */
export type GatewayEvent =
  | { type: 'message_received'; message: InboundMessage }
  | { type: 'route_decided'; messageId: string; decision: RouteDecision }
  | { type: 'response_ready'; messageId: string; response: OutboundMessage }
  | { type: 'error'; messageId: string; error: string };

/** Options for processing a message */
export interface ProcessOptions {
  /** Callback for streaming tokens as they arrive */
  onToken?: (token: string) => void;
}

// ── Gateway ─────────────────────────────────────────────────────

export class Gateway {
  private ollama: OllamaClient;
  private claude: ClaudeClient;
  private router: Router;
  private sessions: SessionManager;
  private soul: SoulConfig;
  private skills: SkillRegistry;
  private compactor: ContextCompactor | null;
  private heartbeat: HeartbeatMonitor | null;
  private listeners: GatewayEventListener[] = [];

  constructor(deps: {
    ollama: OllamaClient;
    claude: ClaudeClient;
    router: Router;
    sessions: SessionManager;
    soul: SoulConfig;
    skills: SkillRegistry;
    compactor?: ContextCompactor;
    heartbeat?: HeartbeatMonitor;
  }) {
    this.ollama = deps.ollama;
    this.claude = deps.claude;
    this.router = deps.router;
    this.sessions = deps.sessions;
    this.soul = deps.soul;
    this.skills = deps.skills;
    this.compactor = deps.compactor ?? null;
    this.heartbeat = deps.heartbeat ?? null;
  }

  /**
   * Executes a skill directly by name.
   */
  async executeSkill(
    skillName: string,
    params: Record<string, string | number | boolean>,
    raw?: string,
  ): Promise<string> {
    const result = await this.skills.execute(skillName, { params, raw });
    return result.output;
  }

  /**
   * Returns the skill registry for direct access (e.g. from Discord commands).
   */
  getSkills(): SkillRegistry {
    return this.skills;
  }

  /**
   * Returns a formatted health status string from the heartbeat monitor.
   */
  getHealthStatus(): string {
    if (!this.heartbeat) return 'Heartbeat monitor not active.';
    return this.heartbeat.getStatusText();
  }

  /**
   * Processes an inbound message end-to-end.
   *
   * Flow: receive → resolve session → build context → route →
   *       dispatch to backend → record turn → return response
   *
   * @param message - Normalized inbound message from any channel
   * @param options - Optional processing options (e.g. streaming callback)
   * @returns Outbound message ready for the channel adapter
   */
  async process(
    message: InboundMessage,
    options?: ProcessOptions,
  ): Promise<OutboundMessage> {
    this.emit({ type: 'message_received', message });

    try {
      // 1. Resolve session
      const session = this.sessions.resolve(
        message.channel,
        message.userId,
        message.threadId,
      );

      // 2. Build conversation context
      const context = this.sessions.buildContext(session.id);

      // 3. Route the message
      const decision = await this.router.classify(message.content);
      this.emit({ type: 'route_decided', messageId: message.id, decision });

      // 4. Dispatch to the appropriate backend
      let responseText: string;
      if (decision.target === 'ollama') {
        responseText = await this.dispatchToOllama(
          message.content,
          context,
          options?.onToken,
        );
      } else {
        responseText = await this.dispatchToClaude(
          message.content,
          context,
          options?.onToken,
        );
      }

      // 5. Record the turn
      this.sessions.recordTurn(
        session.id,
        message.content,
        responseText,
        decision.target,
      );

      // 5b. Trigger compaction if needed (non-blocking)
      if (this.compactor) {
        this.compactor.compactIfNeeded(session.id).catch((err) => {
          console.warn('Compaction error:', err);
        });
      }

      // 6. Build outbound message
      const response: OutboundMessage = {
        content: responseText,
        channel: message.channel,
        replyToId: message.channelMessageId,
        threadId: message.threadId,
      };

      this.emit({ type: 'response_ready', messageId: message.id, response });
      return response;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'error', messageId: message.id, error: errorMsg });

      return {
        content: `Sorry, I encountered an error: ${errorMsg}`,
        channel: message.channel,
        replyToId: message.channelMessageId,
        threadId: message.threadId,
      };
    }
  }

  /**
   * Registers an event listener for gateway events.
   */
  on(listener: GatewayEventListener): void {
    this.listeners.push(listener);
  }

  // ── Backend dispatch ──────────────────────────────────────────

  /**
   * Sends a message to Ollama with conversation context.
   * Falls back to Claude if Ollama fails.
   */
  private async dispatchToOllama(
    userMessage: string,
    context: ConversationContext,
    onToken?: (token: string) => void,
  ): Promise<string> {
    try {
      const messages = this.buildOllamaMessages(userMessage, context);

      if (onToken) {
        return await this.ollama.chatStream(messages, (chunk) => {
          if (chunk.message?.content) {
            onToken(chunk.message.content);
          }
        });
      }

      const response = await this.ollama.chat(messages);
      return response.message.content;
    } catch (err) {
      // Fall back to Claude on Ollama failure
      console.warn(
        `Ollama dispatch failed, falling back to Claude: ${err instanceof Error ? err.message : err}`,
      );
      return this.dispatchToClaude(userMessage, context, onToken);
    }
  }

  /**
   * Sends a message to Claude with conversation context.
   */
  private async dispatchToClaude(
    userMessage: string,
    context: ConversationContext,
    onToken?: (token: string) => void,
  ): Promise<string> {
    const contextText = context.historyText || undefined;
    const result = await this.claude.query(userMessage, contextText, onToken);
    return result.text;
  }

  // ── Helpers ───────────────────────────────────────────────────

  /**
   * Builds the Ollama messages array with system prompt and conversation history.
   */
  private buildOllamaMessages(
    userMessage: string,
    context: ConversationContext,
  ): OllamaMessage[] {
    const messages: OllamaMessage[] = [];

    // System prompt from SOUL.md
    const identitySection = this.soul.sections.find(
      (s) => s.heading === 'Identity',
    );
    const personalitySection = this.soul.sections.find(
      (s) => s.heading === 'Personality',
    );
    const rulesSection = this.soul.sections.find(
      (s) => s.heading === 'Rules',
    );

    let systemPrompt = `You are ${this.soul.name}.`;
    if (identitySection) systemPrompt += `\n${identitySection.content}`;
    if (personalitySection) systemPrompt += `\n${personalitySection.content}`;
    if (rulesSection) systemPrompt += `\n${rulesSection.content}`;
    systemPrompt +=
      '\n\nKeep responses concise. You are a small local model handling simple tasks.';

    messages.push({ role: 'system', content: systemPrompt });

    // Conversation history
    for (const turn of context.turns) {
      messages.push({ role: 'user', content: turn.userMessage });
      messages.push({ role: 'assistant', content: turn.assistantMessage });
    }

    // Current message
    messages.push({ role: 'user', content: userMessage });

    return messages;
  }

  private emit(event: GatewayEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors break the pipeline
      }
    }
  }
}
