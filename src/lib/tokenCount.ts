/**
 * tokenCount.ts — lightweight token estimation without a full tokenizer.
 *
 * Uses the GPT-style approximation: ~4 characters per token on average for
 * English prose, with adjustments for:
 *   - Code blocks: ~3 chars/token (more punctuation, shorter tokens)
 *   - CJK text: ~1.5 chars/token (each character is typically its own token)
 *
 * Accurate to ±15% for most inputs. For exact counts a BPE tokenizer
 * (e.g. tiktoken) would be needed, but that adds ~1 MB of WASM.
 */

import type { Message } from "./types";
import type { RetrievedChunk } from "./rag";

// ── Core estimator ─────────────────────────────────────────────────────────

// Matches CJK Unified Ideographs, CJK Extension A/B, Hangul, Hiragana,
// Katakana, and CJK Compatibility blocks — all script ranges where each
// character is typically a single token in BPE tokenizers.
const CJK_RE = /[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff\u3040-\u30ff]/g;

/**
 * Estimate the number of tokens in a string.
 * Accounts for code blocks (higher token density) and CJK scripts.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let tokens = 0;
  // Split on code blocks — they tokenize differently from prose
  const parts = text.split(/(```[\s\S]*?```)/g);

  for (const part of parts) {
    const isCode = part.startsWith("```");
    if (isCode) {
      // Code: ~3 chars/token (more punctuation, shorter tokens)
      tokens += Math.ceil(part.length / 3);
    } else {
      // Count CJK characters separately (~1.5 chars/token each).
      const cjkMatches = part.match(CJK_RE);
      const cjkChars = cjkMatches?.length ?? 0;
      const latinChars = part.length - cjkChars;
      // Latin/prose: ~4 chars/token; CJK: ~1.5 chars/token
      tokens += Math.ceil(latinChars / 4) + Math.ceil(cjkChars / 1.5);
    }
  }

  return tokens;
}

// ── Per-message overhead ───────────────────────────────────────────────────

// ChatML / Gemma turn format adds ~4 tokens of overhead per message
// (<start_of_turn>role\n ... <end_of_turn>\n)
const TOKENS_PER_MESSAGE_OVERHEAD = 4;

// ── Context breakdown ──────────────────────────────────────────────────────

export interface ContextBreakdown {
  /** Tokens used by the system instruction */
  system: number;
  /** Tokens used by conversation history (all messages) */
  history: number;
  /** Tokens used by RAG context injected this turn */
  rag: number;
  /** Tokens used by the current (unsent) user input */
  input: number;
  /** Sum of all above */
  total: number;
  /** Model's maximum context window (0 = unknown) */
  contextLength: number;
  /** Fraction used: total / contextLength (0 if contextLength unknown) */
  fraction: number;
}

/**
 * Compute a full context breakdown for the current chat state.
 *
 * @param messages        All messages in the active conversation
 * @param ragChunks       RAG chunks retrieved for the last query
 * @param systemPrompt    Active system instruction
 * @param currentInput    Text currently in the input box (not yet sent)
 * @param contextLength   Model's max context window in tokens (0 = unknown)
 */
export function computeContextBreakdown(
  messages: Message[],
  ragChunks: RetrievedChunk[],
  systemPrompt: string,
  currentInput: string,
  contextLength: number,
): ContextBreakdown {
  const system = estimateTokens(systemPrompt) + TOKENS_PER_MESSAGE_OVERHEAD;

  const history = messages.reduce((sum, m) => {
    return sum + estimateTokens(m.content) + TOKENS_PER_MESSAGE_OVERHEAD;
  }, 0);

  const ragText = ragChunks
    .map((c) => `[${c.source}]\n${c.text}`)
    .join("\n\n");
  const rag = ragChunks.length > 0
    ? estimateTokens(ragText) + TOKENS_PER_MESSAGE_OVERHEAD
    : 0;

  // Only count the per-message overhead when there is actual input — an empty
  // text field should contribute 0 tokens, not a phantom 4-token overhead.
  const inputTokens = estimateTokens(currentInput);
  const input = inputTokens > 0 ? inputTokens + TOKENS_PER_MESSAGE_OVERHEAD : 0;

  const total = system + history + rag + input;
  // Not clamped — callers use fraction > 1 to detect overflow
  const fraction = contextLength > 0 ? total / contextLength : 0;

  return { system, history, rag, input, total, contextLength, fraction };
}

/** Format a token count as a compact string (e.g. "1.2k"). */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}
