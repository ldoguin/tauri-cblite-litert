/**
 * rag.ts — Retrieval-Augmented Generation pipeline.
 *
 * Flow:
 *   1. Embed the user query with the embedding model (LiteRT).
 *   2. Cosine-similarity search over all stored KnowledgeChunks.
 *   3. Return the top-K chunks to inject into the LLM prompt.
 *
 * Text chunking for ingestion:
 *   splitIntoChunks() splits raw text into overlapping windows so that
 *   context is not lost at chunk boundaries.
 */

import { createEmbedding } from "tauri-plugin-litert-api";
import { listKnowledgeChunks } from "./db";
import type { KnowledgeChunk } from "./types";

// ── Chunking ───────────────────────────────────────────────────────────────

const CHUNK_SIZE = 400;   // characters per chunk
const CHUNK_OVERLAP = 80; // overlap between consecutive chunks

/**
 * Splits `text` into overlapping character-window chunks.
 * Returns an array of chunk strings.
 */
export function splitIntoChunks(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end).trim());
    if (end === text.length) break;
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks.filter((c) => c.length > 20);
}

// ── Embedding ──────────────────────────────────────────────────────────────

/**
 * Tokenises text with a simple whitespace tokeniser and returns token IDs
 * as a flat number array suitable for the embedding model.
 *
 * For production use, replace this with a proper BPE/WordPiece tokeniser
 * that matches the embedding model's vocabulary.
 */
function naiveTokenise(text: string, maxLen = 128): number[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxLen)
    .map((w) => {
      // Deterministic hash → token ID in [1, 30000]
      let h = 0;
      for (let i = 0; i < w.length; i++) {
        h = (Math.imul(31, h) + w.charCodeAt(i)) | 0;
      }
      return (Math.abs(h) % 29999) + 1;
    });
  // Pad to maxLen
  while (tokens.length < maxLen) tokens.push(0);
  return tokens;
}

/** Embeds a single text string using the loaded LiteRT embedding model. */
export async function embedText(
  modelId: string,
  text: string,
): Promise<number[]> {
  const tokens = naiveTokenise(text);
  const { embedding } = await createEmbedding({ modelId, input: tokens });
  return embedding;
}

// ── Similarity ─────────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Retrieval ──────────────────────────────────────────────────────────────

export interface RetrievedChunk {
  chunk: KnowledgeChunk;
  score: number;
}

/**
 * Retrieves the top-K knowledge chunks most similar to `queryEmbedding`.
 * All chunks are loaded from CouchbaseLite and ranked in-memory.
 */
export async function retrieveTopK(
  queryEmbedding: number[],
  topK: number,
): Promise<RetrievedChunk[]> {
  const chunks = await listKnowledgeChunks();
  if (chunks.length === 0) return [];

  const scored = chunks
    .filter((c) => c.embedding && c.embedding.length > 0)
    .map((chunk) => ({
      chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored;
}

// ── Prompt building ────────────────────────────────────────────────────────

/**
 * Builds the final prompt string injected into the LLM.
 *
 * Structure:
 *   [System instruction]
 *   --- Retrieved context ---
 *   [chunk 1]
 *   [chunk 2]
 *   ...
 *   --- End of context ---
 *   User: <query>
 */
export function buildRagPrompt(
  query: string,
  retrievedChunks: RetrievedChunk[],
  systemInstruction: string,
): string {
  const contextBlock =
    retrievedChunks.length > 0
      ? [
          "--- Retrieved context ---",
          ...retrievedChunks.map(
            ({ chunk, score }, i) =>
              `[${i + 1}] (source: ${chunk.source}, score: ${score.toFixed(3)})\n${chunk.text}`,
          ),
          "--- End of context ---",
          "",
        ].join("\n")
      : "";

  return [systemInstruction, contextBlock, `User: ${query}`]
    .filter(Boolean)
    .join("\n\n");
}
