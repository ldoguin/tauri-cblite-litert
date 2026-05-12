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

import { runInference } from "tauri-plugin-litert-api";
import { listKnowledgeChunks, listEmbeddedMessages } from "./db";


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
let liteRtLoaded = false; // guard against calling loadLiteRt() more than once

// ── Initialisation ─────────────────────────────────────────────────────────

/**
 * Initialise the embedding engine.
 * On Tauri (desktop/Android) the plugin handles LiteRT directly via IPC —
 * no JS-side init needed. On web, tries LiteRT → USE → BoW in order.
 *
 * Call once at app startup. Re-call with a new URL to switch models.
 */
export function initEmbeddings(liteRtModelUrl?: string): Promise<EmbeddingStatus> {
  // Re-init only when a new model URL is explicitly provided
  if (initPromise && !liteRtModelUrl) return initPromise;
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
      if (!liteRtLoaded) {
        await loadLiteRt("https://cdn.jsdelivr.net/npm/@litertjs/core/wasm/");
        liteRtLoaded = true;
      }
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
  const { input_word_ids, input_mask, input_type_ids } = tokeniseBert(text);
  // runInference accepts one flat array per input tensor — BERT needs three.
  const { outputs } = await runInference({
    modelId,
    inputs: [input_word_ids, input_mask, input_type_ids],
  });
  // First output tensor is the embedding vector
  return l2Normalise(outputs[0] ?? []);
}

async function embedWithUse(text: string): Promise<number[]> {
  if (!useModel) throw new Error("USE model not loaded");
  const embeddings = await useModel.embed([text]);
  return l2Normalise(embeddings.arraySync()[0]);
}

// ── Tokeniser ──────────────────────────────────────────────────────────────

const SEQ_LEN = 128;

/**
 * Produces the three int32 input arrays expected by BERT-family .tflite
 * embedding models (e.g. MediaPipe bert_embedder):
 *   input_word_ids  — djb2-hashed token IDs, [CLS] prepended, [SEP] appended
 *   input_mask      — 1 for real tokens, 0 for padding
 *   input_type_ids  — all zeros (single-segment)
 *
 * djb2 hashing matches the plugin example's tokeniser. For production,
 * replace with a proper WordPiece tokeniser matching the model's vocabulary.
 */
function tokeniseBert(text: string): {
  input_word_ids: number[];
  input_mask: number[];
  input_type_ids: number[];
} {
  const CLS = 101, SEP = 102, PAD = 0;
  const words = text.toLowerCase().split(/\s+/).slice(0, SEQ_LEN - 2);

  const ids: number[] = [CLS];
  for (const w of words) {
    let h = 5381;
    for (let i = 0; i < w.length; i++) h = ((h << 5) + h) ^ w.charCodeAt(i);
    ids.push((Math.abs(h) % 29998) + 1); // keep away from 0/CLS/SEP
  }
  ids.push(SEP);

  const mask = new Array<number>(SEQ_LEN).fill(0);
  const wordIds = new Array<number>(SEQ_LEN).fill(PAD);
  for (let i = 0; i < ids.length && i < SEQ_LEN; i++) {
    wordIds[i] = ids[i];
    mask[i] = 1;
  }

  return {
    input_word_ids: wordIds,
    input_mask: mask,
    input_type_ids: new Array<number>(SEQ_LEN).fill(0),
  };
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

// ── Retrieval ──────────────────────────────────────────────────────────────

export type RetrievedItemType = "knowledge" | "message";

export interface RetrievedChunk {
  /** Unique ID of the source document */
  id: string;
  /** Display label: filename for knowledge chunks, role+timestamp for messages */
  source: string;
  text: string;
  score: number;
  type: RetrievedItemType;
  /** Conversation the message belongs to, if type === "message" */
  conversationId?: string;
}

/**
 * Retrieves the top-K items most similar to `queryEmbedding` from both:
 *   - _default.knowledge  (ingested document chunks)
 *   - _default.messages   (vectorised conversation turns)
 *
 * @param queryEmbedding         Embedding of the user query
 * @param topK                   Maximum number of results to return
 * @param threshold              Minimum cosine similarity (default 0.3)
 * @param excludeConversationId  Skip messages from this conversation (avoids
 *                               the current conversation retrieving itself)
 */
export async function retrieveTopK(
  queryEmbedding: number[],
  topK: number,
  threshold = 0.3,
  excludeConversationId?: string,
): Promise<RetrievedChunk[]> {
  const [chunks, messages] = await Promise.all([
    listKnowledgeChunks(),
    listEmbeddedMessages(),
  ]);

  const candidates: RetrievedChunk[] = [];

  // Knowledge chunks
  for (const c of chunks) {
    if (!c.embedding?.length) continue;
    const score = cosineSimilarity(queryEmbedding, c.embedding);
    if (score < threshold) continue;
    candidates.push({ id: c.id, source: c.source, text: c.text, score, type: "knowledge" });
  }

  // Vectorised messages (exclude current conversation)
  for (const m of messages) {
    if (!m.embedding?.length) continue;
    if (excludeConversationId && m.conversationId === excludeConversationId) continue;
    const score = cosineSimilarity(queryEmbedding, m.embedding);
    if (score < threshold) continue;
    const label = `${m.role} · ${new Date(m.createdAt).toLocaleDateString()}`;
    candidates.push({
      id: m.id,
      source: label,
      text: m.content,
      score,
      type: "message",
      conversationId: m.conversationId,
    });
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ── Prompt building ────────────────────────────────────────────────────────

export function buildRagPrompt(
  query: string,
  retrieved: RetrievedChunk[],
  systemInstruction: string,
): string {
  const contextBlock =
    retrieved.length > 0
      ? [
          "--- Retrieved context ---",
          ...retrieved.map(
            ({ source, text, score, type }, i) =>
              `[${i + 1}] (${type}: ${source}, score: ${score.toFixed(3)})\n${text}`,
          ),
          "--- End of context ---",
          "",
        ].join("\n")
      : "";

  return [systemInstruction, contextBlock, `User: ${query}`]
    .filter(Boolean)
    .join("\n\n");
}
