/**
 * Session manager — tracks conversation state per user/channel.
 *
 * Handles session lifecycle (create, find, touch) and builds
 * conversation context from stored history for backend prompts.
 */

import { v4 as uuid } from 'uuid';
import type { MemoryStore } from '../memory/store.js';
import type {
  ChannelType,
  ConversationTurn,
  RouteTarget,
  Session,
} from '../channels/types.js';
import type { MemoryConfig } from './config.js';

// ── Types ───────────────────────────────────────────────────────

/** Conversation context assembled from session history */
export interface ConversationContext {
  /** The session this context belongs to */
  session: Session;
  /** Formatted conversation history string for backend prompts */
  historyText: string;
  /** Raw turns included in the context */
  turns: ConversationTurn[];
  /** Whether the session has exceeded the compaction threshold */
  needsCompaction: boolean;
}

// ── Session Manager ─────────────────────────────────────────────

export class SessionManager {
  private store: MemoryStore;
  private maxContextMessages: number;
  private compactionThreshold: number;

  constructor(store: MemoryStore, memoryConfig: MemoryConfig) {
    this.store = store;
    this.maxContextMessages = memoryConfig.max_context_messages;
    this.compactionThreshold = memoryConfig.compaction_threshold;
  }

  /**
   * Resolves a session for the given channel/user/thread.
   * Creates a new session if none exists.
   *
   * @returns The active session
   */
  resolve(channel: ChannelType, userId: string, threadId?: string): Session {
    const existing = this.store.findSession(channel, userId, threadId);
    if (existing) {
      this.store.touchSession(existing.id);
      return { ...existing, lastActiveAt: new Date() };
    }

    return this.store.createSession(uuid(), channel, userId, threadId);
  }

  /**
   * Builds conversation context for a session.
   * Retrieves recent turns and formats them as a prompt-ready string.
   *
   * @param sessionId - The session to build context for
   * @returns Context with history and compaction flag
   */
  buildContext(sessionId: string): ConversationContext {
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const turns = this.store.getRecentTurns(sessionId, this.maxContextMessages);
    const needsCompaction = session.turnCount >= this.compactionThreshold;

    let historyText = '';
    if (turns.length > 0) {
      historyText = turns
        .map(
          (t) =>
            `User: ${t.userMessage}\nAssistant: ${t.assistantMessage}`,
        )
        .join('\n\n');
    }

    return { session, historyText, turns, needsCompaction };
  }

  /**
   * Records a completed conversation turn.
   */
  recordTurn(
    sessionId: string,
    userMessage: string,
    assistantMessage: string,
    backend: RouteTarget,
  ): void {
    this.store.addTurn(sessionId, userMessage, assistantMessage, backend);
  }

  /**
   * Gets a session by ID.
   */
  getSession(sessionId: string): Session | undefined {
    return this.store.getSession(sessionId);
  }
}
