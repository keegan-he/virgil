/**
 * Message router — decides whether to send a message to Ollama or Claude.
 *
 * Uses the local Ollama model to classify incoming messages as "simple"
 * (handled locally) or "complex" (routed to Claude). Defaults to Claude
 * when confidence is low or Ollama is unavailable.
 */

import type { OllamaClient } from '../backends/ollama.js';
import type { RouteDecision, RouteTarget } from '../channels/types.js';

// ── Classification prompt ───────────────────────────────────────

const CLASSIFICATION_SYSTEM_PROMPT = `You are a message classifier. Your job is to decide whether a user message is SIMPLE or COMPLEX.

SIMPLE messages can be answered by a small local model:
- Greetings and casual chat ("hi", "how are you", "thanks")
- Simple factual questions ("what time is it", "what's 2+2")
- Status checks ("are you there", "ping")
- Short summaries of provided text
- Simple formatting or rephrasing requests

COMPLEX messages need a powerful cloud model:
- Multi-step reasoning or analysis
- Code generation, debugging, or review
- Research questions requiring deep knowledge
- Tool use (file operations, web search, system commands)
- Long-form writing or creative tasks
- Questions about code, architecture, or technical topics
- Anything ambiguous or that you're unsure about

Respond with ONLY a JSON object, no other text:
{"classification": "simple" | "complex", "confidence": 0.0-1.0, "reason": "brief explanation"}`;

// ── Fast-path patterns (skip Ollama entirely) ───────────────────

/**
 * Messages matching these patterns are instantly routed without
 * waiting for Ollama classification. Saves 0.5–2s per match.
 */
const SIMPLE_FAST_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^(hi|hey|hello|yo|sup|howdy|hiya|hola|what'?s up)\b/i, reason: 'Greeting detected' },
  { pattern: /^(thanks|thank you|thx|ty|cheers|appreciated)\b/i, reason: 'Thanks detected' },
  { pattern: /^(bye|goodbye|see ya|later|gn|good night|cya)\b/i, reason: 'Farewell detected' },
  { pattern: /^(yes|no|yep|nope|yeah|nah|ok|okay|sure|yea)\b/i, reason: 'Short affirmation/negation' },
  { pattern: /^(ping|status|health|are you there|you there)\b/i, reason: 'Status check detected' },
];

const COMPLEX_FAST_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /```/,                          reason: 'Code block detected' },
  { pattern: /\b(write|create|build|implement|refactor|debug|fix)\b.*\b(code|function|class|file|component|script|app)\b/i, reason: 'Code task detected' },
  { pattern: /\b(search|find|look up|research|fetch|download)\b/i, reason: 'Tool use likely' },
  { pattern: /\b(analyze|explain|compare|review)\b.{20,}/i, reason: 'Complex analysis detected' },
];

// ── Router ──────────────────────────────────────────────────────

/** Threshold below which we escalate to Claude regardless of classification */
const CONFIDENCE_THRESHOLD = 0.7;

/** Maximum time to wait for classification before defaulting to Claude */
const CLASSIFICATION_TIMEOUT_MS = 2000;

export class Router {
  private ollama: OllamaClient;
  private ollamaAvailable: boolean = true;

  constructor(ollama: OllamaClient) {
    this.ollama = ollama;
  }

  /**
   * Classifies a message and returns a routing decision.
   *
   * If Ollama is unavailable or classification fails, defaults to Claude.
   * If confidence is below the threshold, escalates to Claude.
   *
   * @param message - The user's message text
   * @returns Where to route the message and why
   */
  async classify(message: string): Promise<RouteDecision> {
    // ── Fast-path: skip Ollama for obvious patterns ──────────
    const fastResult = this.fastClassify(message);
    if (fastResult) return fastResult;

    // If Ollama is known to be down, skip classification
    if (!this.ollamaAvailable) {
      return {
        target: 'claude',
        confidence: 1.0,
        reason: 'Ollama unavailable — routing to Claude',
      };
    }

    try {
      const result = await Promise.race([
        this.runClassification(message),
        this.timeout(CLASSIFICATION_TIMEOUT_MS),
      ]);

      if (!result) {
        return {
          target: 'claude',
          confidence: 1.0,
          reason: 'Classification timed out — defaulting to Claude',
        };
      }

      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        target: 'claude',
        confidence: 1.0,
        reason: `Classification error: ${errorMsg} — defaulting to Claude`,
      };
    }
  }

  /**
   * Updates whether Ollama is considered available.
   * Called by the heartbeat monitor.
   */
  setOllamaAvailable(available: boolean): void {
    this.ollamaAvailable = available;
  }

  /**
   * Returns current Ollama availability status.
   */
  isOllamaAvailable(): boolean {
    return this.ollamaAvailable;
  }

  // ── Internal ────────────────────────────────────────────────

  /**
   * Attempts instant classification using regex patterns.
   * Returns null if no pattern matches (falls through to Ollama).
   */
  private fastClassify(message: string): RouteDecision | null {
    const trimmed = message.trim();

    for (const { pattern, reason } of SIMPLE_FAST_PATTERNS) {
      if (pattern.test(trimmed)) {
        return { target: 'ollama', confidence: 0.95, reason: `[fast-path] ${reason}` };
      }
    }

    for (const { pattern, reason } of COMPLEX_FAST_PATTERNS) {
      if (pattern.test(trimmed)) {
        return { target: 'claude', confidence: 0.95, reason: `[fast-path] ${reason}` };
      }
    }

    return null;
  }

  /**
   * Asks Ollama to classify the message and parses the JSON response.
   */
  private async runClassification(message: string): Promise<RouteDecision> {
    const response = await this.ollama.complete(
      `Classify this message:\n\n"${message}"`,
      CLASSIFICATION_SYSTEM_PROMPT,
    );

    const parsed = this.parseClassification(response);

    // If confidence is below threshold, escalate to Claude
    if (parsed.target === 'ollama' && parsed.confidence < CONFIDENCE_THRESHOLD) {
      return {
        target: 'claude',
        confidence: parsed.confidence,
        reason: `Low confidence (${parsed.confidence.toFixed(2)}) — escalating to Claude. Original: ${parsed.reason}`,
      };
    }

    return parsed;
  }

  /**
   * Parses the JSON classification response from Ollama.
   * Falls back to Claude if parsing fails.
   */
  private parseClassification(response: string): RouteDecision {
    try {
      // Extract JSON from the response (model might wrap it in markdown)
      const jsonMatch = response.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) {
        return {
          target: 'claude',
          confidence: 0.5,
          reason: 'Could not parse classification — defaulting to Claude',
        };
      }

      const parsed = JSON.parse(jsonMatch[0]) as {
        classification: string;
        confidence: number;
        reason: string;
      };

      const target: RouteTarget =
        parsed.classification === 'simple' ? 'ollama' : 'claude';
      const confidence = Math.max(0, Math.min(1, parsed.confidence ?? 0.5));

      return { target, confidence, reason: parsed.reason ?? 'classified' };
    } catch {
      return {
        target: 'claude',
        confidence: 0.5,
        reason: 'Failed to parse classification JSON — defaulting to Claude',
      };
    }
  }

  /**
   * Returns undefined after a timeout (used in Promise.race).
   */
  private timeout(ms: number): Promise<undefined> {
    return new Promise((resolve) => setTimeout(() => resolve(undefined), ms));
  }
}
