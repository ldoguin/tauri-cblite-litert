/**
 * rag.ts — Retrieval-Augmented Generation pipeline.
 *
 * Embedding backends (in priority order):
 *   1. LiteRT (.tflite via tauri-plugin-litert on desktop/Android, @litertjs/core on web)
 *   2. TensorFlow.js Universal Sentence Encoder (web fallback, no model file needed)
 *   3. Bag-of-Words djb2 hash (offline fallback, no network required)
 *
 * Retrieval:
 *   - Cosine similarity over all stored KnowledgeChunks
 *   - Configurable topK and minimum score threshold
 *   - Can exclude chunks from a specific conversation (cross-conversation RAG)
 */

import { createEmbedding } from "tauri-plugin-litert-api";
import { listKnowledgeChunks } from "./db";
import type { KnowledgeChunk } from "./types";

// ── Embedding backend state ────────────────────────────────────────────────

export type EmbeddingBackend = "litert" | "use" | "bow";

export type EmbeddingStatus =
  | { backend: "litert"; modelUrl: string }
  | { backend: "use" }
  | { backend: "bow"; reason: string };

type UseModel = {
  embed(sentences: string[]): Promise<{ arraySync(): number[][] }>;
};

let activeBackend: EmbeddingBackend = "bow";
let useModel: UseModel | null = null;
let initPromise: Promise<EmbeddingStatus> | null = null;

// ── Initialisation ─────────────────────────────────────────────────────────

/**
 * Initialise the embedding engine.
 * On Tauri (desktop/Android) the plugin handles LiteRT directly via IPC —
 * no JS-side init needed. On web, tries LiteRT → USE → BoW in order.
 *
 * Call once at app startup. Re-call with a new URL to switch models.
 */
export function initEmbeddings(liteRtModelUrl?: string): Promise<EmbeddingStatus> {
  if (initPromise && !(liteRtModelUrl && activeBackend !== "litert")) return initPromise;
  initPromise = _init(liteRtModelUrl);
  return initPromise;
}

async function _init(liteRtModelUrl?: string): Promise<EmbeddingStatus> {
  // On Tauri the plugin owns the LiteRT runtime — no JS init needed.
  if (isTauri()) {
    activeBackend = "litert";
    return { backend: "litert", modelUrl: liteRtModelUrl ?? "" };
  }

  // Web: try LiteRT via @litertjs/core
  if (liteRtModelUrl) {
    try {
      const { loadLiteRt, loadAndCompile } = await import("@litertjs/core");
      await loadLiteRt("https://cdn.jsdelivr.net/npm/@litertjs/core/wasm/");
      await loadAndCompile(liteRtModelUrl, { accelerator: "wasm" });
      activeBackend = "litert";
      return { backend: "litert", modelUrl: liteRtModelUrl };
    } catch (err) {
      console.warn("[rag] LiteRT init failed, falling back to USE:", err);
    }
  }

  // Web: try TF.js Universal Sentence Encoder
  try {
    const tf = await import("@tensorflow/tfjs");
    await tf.ready();
    const use = await import("@tensorflow-models/universal-sentence-encoder");
    useModel = (await use.load()) as UseModel;
    activeBackend = "use";
    return { backend: "use" };
  } catch (err) {
    console.warn("[rag] USE init failed, using bag-of-words fallback:", err);
    activeBackend = "bow";
    return { backend: "bow", reason: String(err) };
  }
}

export function getEmbeddingBackend(): EmbeddingBackend {
  return activeBackend;
}

// ── Embedding ──────────────────────────────────────────────────────────────

/**
 * Embed a single text string using the active backend.
 * On Tauri, delegates to the loaded LiteRT model via the plugin.
 * On web, uses USE or BoW depending on what initialised successfully.
 */
export async function embed(
  text: string,
  /** Only used on Tauri — the model ID registered with tauri-plugin-litert */
  liteRtModelId?: string,
): Promise<number[]> {
  if (!initPromise) await initEmbeddings();

  if (isTauri() && liteRtModelId) {
    return embedWithLiteRtPlugin(text, liteRtModelId);
  }
  if (activeBackend === "use" && useModel) {
    return embedWithUse(text);
  }
  return bowEmbed(text);
}

async function embedWithLiteRtPlugin(text: string, modelId: string): Promise<number[]> {
  const tokens = tokenise(text);
  const { embedding } = await createEmbedding({ modelId, input: tokens });
  return l2Normalise(embedding);
}

async function embedWithUse(text: string): Promise<number[]> {
  if (!useModel) throw new Error("USE model not loaded");
  const embeddings = await useModel.embed([text]);
  return l2Normalise(embeddings.arraySync()[0]);
}

// ── Tokeniser (djb2 hash, matches plugin example) ──────────────────────────

/**
 * Maps text → int32[seqLen] token IDs using a djb2 character hash.
 * For production, replace with a BPE/WordPiece tokeniser matching your model.
 */
function tokenise(text: string, seqLen = 128): number[] {
  const tokens = new Array<number>(seqLen).fill(0);
  const words = text.toLowerCase().split(/\s+/).slice(0, seqLen);
  for (let i = 0; i < words.length; i++) {
    let h = 5381;
    for (let j = 0; j < words[i].length; j++)
      h = ((h << 5) + h) ^ words[i].charCodeAt(j);
    tokens[i] = Math.abs(h) % 30000;
  }
  return tokens;
}

// ── Bag-of-Words fallback ──────────────────────────────────────────────────

function bowEmbed(text: string, dim = 512): number[] {
  const vec = new Float32Array(dim);
  const words = text.toLowerCase().split(/\s+/);
  for (const w of words) {
    let h = 5381;
    for (let i = 0; i < w.length; i++) h = ((h << 5) + h) ^ w.charCodeAt(i);
    vec[Math.abs(h) % dim] += 1;
  }
  return l2Normalise(Array.from(vec));
}

// ── Helpers ────────────────────────────────────────────────────────────────

function l2Normalise(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
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

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// ── Chunking ───────────────────────────────────────────────────────────────

const CHUNK_SIZE = 400;
const CHUNK_OVERLAP = 80;

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

// ── Retrieval ──────────────────────────────────────────────────────────────

export interface RetrievedChunk {
  chunk: KnowledgeChunk;
  score: number;
}

/**
 * Retrieves the top-K knowledge chunks most similar to `queryEmbedding`.
 *
 * @param queryEmbedding         Embedding of the user query
 * @param topK                   Maximum number of chunks to return
 * @param threshold              Minimum cosine similarity (default 0.3)
 * @param excludeConversationId  Skip chunks whose source matches this ID
 */
export async function retrieveTopK(
  queryEmbedding: number[],
  topK: number,
  threshold = 0.3,
  excludeConversationId?: string,
): Promise<RetrievedChunk[]> {
  const chunks = await listKnowledgeChunks();
  if (chunks.length === 0) return [];

  return chunks
    .filter((c) => {
      if (!c.embedding || c.embedding.length === 0) return false;
      if (excludeConversationId && c.source === excludeConversationId) return false;
      return true;
    })
    .map((chunk) => ({ chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
    .filter(({ score }) => score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ── Prompt building ────────────────────────────────────────────────────────

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
