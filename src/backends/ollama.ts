/**
 * Ollama HTTP client for local model inference.
 *
 * Handles chat completions (streaming and non-streaming), health checks,
 * and model availability verification. Talks to the Ollama REST API
 * at localhost:11434 by default.
 */

import type { OllamaConfig } from '../gateway/config.js';

// ── Types ───────────────────────────────────────────────────────

/** A single message in an Ollama chat conversation */
export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Options passed to the Ollama /api/chat endpoint */
export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream?: boolean;
  options?: {
    temperature?: number;
    top_k?: number;
    top_p?: number;
    num_predict?: number;
  };
}

/** Non-streaming response from /api/chat */
export interface OllamaChatResponse {
  model: string;
  message: OllamaMessage;
  done: boolean;
  total_duration?: number;
  eval_count?: number;
}

/** A single streamed chunk from /api/chat */
export interface OllamaStreamChunk {
  model: string;
  message: OllamaMessage;
  done: boolean;
}

/** Model info from /api/tags */
export interface OllamaModel {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
}

/** Health check result */
export interface OllamaHealthStatus {
  alive: boolean;
  modelLoaded: boolean;
  latencyMs: number;
  error?: string;
}

// ── Client ──────────────────────────────────────────────────────

export class OllamaClient {
  private baseUrl: string;
  private model: string;
  private timeout: number;

  constructor(config: OllamaConfig) {
    this.baseUrl = config.host.replace(/\/$/, '');
    this.model = config.model;
    this.timeout = config.timeout;
  }

  /**
   * Returns a shorter timeout for chat requests.
   * On a resource-constrained machine, it's better to fail fast
   * and fall back to Claude than to block for 30s.
   */
  private get chatTimeout(): number {
    return Math.min(this.timeout, 15_000);
  }

  /**
   * Sends a chat completion request and returns the full response.
   *
   * @param messages - Conversation history
   * @param options - Optional inference parameters
   * @returns The assistant's response message
   */
  async chat(
    messages: OllamaMessage[],
    options?: OllamaChatRequest['options'],
  ): Promise<OllamaChatResponse> {
    const body: OllamaChatRequest = {
      model: this.model,
      messages,
      stream: false,
      options,
    };

    const response = await this.fetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify(body),
    }, this.chatTimeout);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama chat failed (${response.status}): ${text}`);
    }

    return (await response.json()) as OllamaChatResponse;
  }

  /**
   * Sends a chat completion request and streams the response chunks.
   *
   * @param messages - Conversation history
   * @param onChunk - Called for each streamed token chunk
   * @param options - Optional inference parameters
   * @returns The complete assembled response text
   */
  async chatStream(
    messages: OllamaMessage[],
    onChunk: (chunk: OllamaStreamChunk) => void,
    options?: OllamaChatRequest['options'],
  ): Promise<string> {
    const body: OllamaChatRequest = {
      model: this.model,
      messages,
      stream: true,
      options,
    };

    const response = await this.fetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify(body),
    }, this.chatTimeout);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama chat stream failed (${response.status}): ${text}`);
    }

    if (!response.body) {
      throw new Error('Ollama returned no response body for stream');
    }

    let assembled = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // Keep the last potentially incomplete line in the buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const chunk = JSON.parse(trimmed) as OllamaStreamChunk;
        if (chunk.message?.content) {
          assembled += chunk.message.content;
        }
        onChunk(chunk);
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      const chunk = JSON.parse(buffer.trim()) as OllamaStreamChunk;
      if (chunk.message?.content) {
        assembled += chunk.message.content;
      }
      onChunk(chunk);
    }

    return assembled;
  }

  /**
   * Checks whether Ollama is running and the configured model is available.
   *
   * @returns Health status with latency
   */
  async healthCheck(): Promise<OllamaHealthStatus> {
    const start = Date.now();

    try {
      const response = await this.fetch('/api/tags', { method: 'GET' });
      const latencyMs = Date.now() - start;

      if (!response.ok) {
        return {
          alive: false,
          modelLoaded: false,
          latencyMs,
          error: `HTTP ${response.status}`,
        };
      }

      const data = (await response.json()) as { models: OllamaModel[] };
      const modelLoaded = data.models.some(
        (m) => m.name === this.model || m.name.startsWith(this.model.split(':')[0]),
      );

      return { alive: true, modelLoaded, latencyMs };
    } catch (err) {
      return {
        alive: false,
        modelLoaded: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Simple completion helper — sends a single user message and returns the text.
   */
  async complete(prompt: string, systemPrompt?: string): Promise<string> {
    const messages: OllamaMessage[] = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const response = await this.chat(messages, { temperature: 0.1 });
    return response.message.content;
  }

  // ── Internal ────────────────────────────────────────────────

  private fetch(path: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    return fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers as Record<string, string>),
      },
      signal: AbortSignal.timeout(timeoutMs ?? this.timeout),
    });
  }
}
