/**
 * Context compaction — summarizes old conversation turns to save memory.
 *
 * When a session exceeds the compaction threshold, older turns are
 * summarized into a single condensed turn via Ollama (fast, local)
 * and the originals are pruned from the database.
 */

import type { OllamaClient } from '../backends/ollama.js';
import type { MemoryStore } from './store.js';
import type { MemoryConfig } from '../gateway/config.js';
import type { ConversationTurn } from '../channels/types.js';

// ── Types ───────────────────────────────────────────────────────

/** Result of a compaction operation */
export interface CompactionResult {
  /** Whether compaction was performed */
  compacted: boolean;
  /** Number of turns that were summarized */
  turnsSummarized: number;
  /** Number of turns pruned from the database */
  turnsPruned: number;
  /** The generated summary (if compaction occurred) */
  summary?: string;
}

// ── Compactor ───────────────────────────────────────────────────

const COMPACTION_PROMPT = `Summarize the following conversation history into a concise recap. Preserve:
- Key facts and decisions made
- Important context the user shared
- Any ongoing tasks or requests
- The overall tone and direction of the conversation

Be brief but complete. Use bullet points. Start with "Previous conversation summary:"`;

export class ContextCompactor {
  private ollama: OllamaClient;
  private store: MemoryStore;
  private threshold: number;
  private maxContext: number;

  constructor(ollama: OllamaClient, store: MemoryStore, config: MemoryConfig) {
    this.ollama = ollama;
    this.store = store;
    this.threshold = config.compaction_threshold;
    this.maxContext = config.max_context_messages;
  }

  /**
   * Checks if a session needs compaction and performs it if so.
   *
   * Compaction summarizes the oldest turns (keeping the most recent ones
   * intact) and replaces them with a single summary turn. This keeps
   * the context window manageable while preserving important history.
   *
   * @param sessionId - The session to compact
   * @returns Result describing what was done
   */
  async compactIfNeeded(sessionId: string): Promise<CompactionResult> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      return { compacted: false, turnsSummarized: 0, turnsPruned: 0 };
    }

    // Only compact if we've exceeded the threshold
    if (session.turnCount < this.threshold) {
      return { compacted: false, turnsSummarized: 0, turnsPruned: 0 };
    }

    const allTurns = this.store.getAllTurns(sessionId);
    if (allTurns.length < this.threshold) {
      return { compacted: false, turnsSummarized: 0, turnsPruned: 0 };
    }

    // Keep the most recent turns, summarize the rest
    const keepCount = Math.floor(this.maxContext * 0.4); // Keep 40% of max
    const turnsToSummarize = allTurns.slice(0, allTurns.length - keepCount);

    if (turnsToSummarize.length === 0) {
      return { compacted: false, turnsSummarized: 0, turnsPruned: 0 };
    }

    // Build the conversation text to summarize
    const conversationText = this.formatTurnsForSummary(turnsToSummarize);

    // Generate summary via Ollama (fast, local, good enough for summaries)
    let summary: string;
    try {
      summary = await this.ollama.complete(
        `${COMPACTION_PROMPT}\n\n${conversationText}`,
      );
    } catch (err) {
      console.warn(
        `Compaction failed (Ollama error): ${err instanceof Error ? err.message : err}`,
      );
      return { compacted: false, turnsSummarized: 0, turnsPruned: 0 };
    }

    // Replace old turns with the summary as a single turn
    const prunedCount = this.store.pruneTurns(sessionId, keepCount);

    // Insert summary as the first turn so it provides context
    this.store.addTurn(
      sessionId,
      '[system] Conversation history was compacted.',
      summary,
      'ollama',
    );

    console.log(
      `  [compaction] session=${sessionId} summarized=${turnsToSummarize.length} pruned=${prunedCount}`,
    );

    return {
      compacted: true,
      turnsSummarized: turnsToSummarize.length,
      turnsPruned: prunedCount,
      summary,
    };
  }

  /**
   * Formats conversation turns into a readable text block for summarization.
   */
  private formatTurnsForSummary(turns: ConversationTurn[]): string {
    return turns
      .map(
        (t) => `User: ${t.userMessage}\nAssistant: ${t.assistantMessage}`,
      )
      .join('\n\n');
  }
}
