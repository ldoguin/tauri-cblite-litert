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
import { isTauri, listKnowledgeChunks, listEmbeddedMessages, getRagPoolVersion } from "./db";


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
// Track the model URL that produced the current vectors so we can detect
// backend switches and warn that existing embeddings are stale.
let _activeModelUrl: string | undefined;

// Compiled LiteRT model for the web build (@litertjs/core)
type CompiledModel = { run(inputs: Record<string, unknown>): Promise<Record<string, unknown>> };
let webLiteRtModel: CompiledModel | null = null;

// ── Initialisation ─────────────────────────────────────────────────────────

/**
 * Initialise the embedding engine.
 * On Tauri (desktop/Android) the plugin handles LiteRT directly via IPC —
 * no JS-side init needed. On web, tries LiteRT → USE → BoW in order.
 *
 * Call once at app startup. Re-call with a new URL to switch models.
 * Returns `embeddingBackendChanged: true` when the active backend or model
 * URL changed — callers should prompt the user to re-embed all content.
 */
export function initEmbeddings(liteRtModelUrl?: string): Promise<EmbeddingStatus> {
  // Return cached promise only when no URL is given AND the backend hasn't
  // changed — passing undefined after a LiteRT load must re-init to USE/BoW.
  if (initPromise && liteRtModelUrl === undefined && activeBackend !== "litert") {
    return initPromise;
  }
  // Also deduplicate identical LiteRT URL re-requests
  if (initPromise && liteRtModelUrl !== undefined && activeBackend === "litert" && liteRtModelUrl === _activeModelUrl) {
    return initPromise;
  }
  const previousBackend = activeBackend;
  const previousModelUrl = _activeModelUrl;
  initPromise = _init(liteRtModelUrl).then((status) => {
    // Warn when the backend or model changed — existing stored vectors are
    // incompatible with the new model and retrieval quality will degrade.
    const backendChanged = previousBackend !== activeBackend;
    const urlChanged = status.backend === "litert" && previousModelUrl !== undefined && previousModelUrl !== liteRtModelUrl;
    if (backendChanged || urlChanged) {
      console.warn(
        `[rag] Embedding backend changed from "${previousBackend}" to "${activeBackend}". ` +
        "Stored vectors are stale — use Re-embed All to rebuild the index.",
      );
    }
    return status;
  }).catch((err) => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

async function _init(liteRtModelUrl?: string): Promise<EmbeddingStatus> {
  // On Tauri the plugin owns the LiteRT runtime — no JS init needed.
  if (isTauri()) {
    activeBackend = "litert";
    _activeModelUrl = liteRtModelUrl;
    return { backend: "litert", modelUrl: liteRtModelUrl ?? "" };
  }

  // Web: try LiteRT via @litertjs/core.
  // @litertjs/core does not yet support kTfLiteEmbedder (.tflite sentence
  // embedding) models — skip entirely and fall through to USE/BoW.
  const canUseLiteRtWeb = liteRtModelUrl && !liteRtModelUrl.endsWith(".tflite");
  if (canUseLiteRtWeb) {
    try {
      const { loadLiteRt, loadAndCompile } = await import("@litertjs/core");
      if (!liteRtLoaded) {
        try {
          await loadLiteRt("https://cdn.jsdelivr.net/npm/@litertjs/core/wasm/");
          liteRtLoaded = true;
        } catch (err) {
          liteRtLoaded = false;
          console.warn("[rag] LiteRT WASM load failed:", err);
          // fall through to USE
        }
      }
      // Release the previous model's WASM heap allocation before loading a new one.
      if (webLiteRtModel) {
        try { (webLiteRtModel as unknown as { delete?: () => void }).delete?.(); } catch { /* ignore */ }
        webLiteRtModel = null;
      }
      webLiteRtModel = await loadAndCompile(liteRtModelUrl, { accelerator: "wasm" }) as CompiledModel;
      activeBackend = "litert";
      _activeModelUrl = liteRtModelUrl;
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
    _activeModelUrl = undefined;
    return { backend: "use" };
  } catch (err) {
    console.warn("[rag] USE init failed, using bag-of-words fallback:", err);
    activeBackend = "bow";
    _activeModelUrl = undefined;
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
  if (activeBackend === "litert" && webLiteRtModel) {
    return embedWithWebLiteRt(text, webLiteRtModel);
  }
  if (activeBackend === "use" && useModel) {
    return embedWithUse(text);
  }
  return bowEmbed(text);
}

async function embedWithWebLiteRt(text: string, model: CompiledModel): Promise<number[]> {
  const { input_word_ids, input_mask, input_type_ids } = await tokeniseBert(text);
  const outputs = await model.run({
    input_word_ids: new Int32Array(input_word_ids),
    input_mask:     new Int32Array(input_mask),
    input_type_ids: new Int32Array(input_type_ids),
  });
  // The output tensor name varies by model export; try common names
  const raw = (outputs["output_0"] ?? outputs["embeddings"] ?? Object.values(outputs)[0]) as Float32Array | number[];
  return l2Normalise(Array.from(raw));
}

async function embedWithLiteRtPlugin(text: string, modelId: string): Promise<number[]> {
  const { input_word_ids, input_mask, input_type_ids } = await tokeniseBert(text);
  // runInference accepts one flat array per input tensor — BERT needs three.
  const { outputs } = await runInference({
    modelId,
    inputs: [input_word_ids, input_mask, input_type_ids],
    inputTypes: ["int32", "int32", "int32"],
  });
  // First output tensor is the embedding vector
  return l2Normalise(outputs[0] ?? []);
}

async function embedWithUse(text: string): Promise<number[]> {
  if (!useModel) throw new Error("USE model not loaded");
  const embeddings = await useModel.embed([text]);
  return l2Normalise(embeddings.arraySync()[0]);
}

// ── WordPiece tokeniser ────────────────────────────────────────────────────
//
// Implements the standard BERT WordPiece algorithm against the
// bert-base-uncased vocabulary (30,522 tokens). The vocab is fetched once
// from the HuggingFace CDN and cached in memory for the lifetime of the page.
//
// Special tokens match bert-base-uncased:
//   [PAD]=0  [UNK]=100  [CLS]=101  [SEP]=102  [MASK]=103
//
// The MediaPipe bert_embedder.tflite uses this exact vocabulary, so token IDs
// produced here will match what the model expects.

const SEQ_LEN = 128;
const CLS_ID = 101, SEP_ID = 102, PAD_ID = 0, UNK_ID = 100;

// Bundled vocab shipped with the app — no network required on first load.
const VOCAB_LOCAL_URL = "/bert-vocab.txt";
// CDN fallback used only when the bundled asset is unavailable (e.g. custom
// deployments that strip public/ assets).
const VOCAB_CDN_URL =
  "https://huggingface.co/bert-base-uncased/resolve/main/vocab.txt";

let _vocab: Map<string, number> | null = null;
let _vocabPromise: Promise<Map<string, number>> | null = null;

async function loadVocab(): Promise<Map<string, number>> {
  if (_vocab) return _vocab;
  if (_vocabPromise) return _vocabPromise;

  _vocabPromise = (async () => {
    let text: string | null = null;

    // 1. Try the bundled asset — works offline, no CDN dependency.
    try {
      const res = await fetch(VOCAB_LOCAL_URL);
      if (res.ok) text = await res.text();
    } catch { /* bundled asset unavailable — fall through */ }

    // 2. CDN fallback with Cache API caching to avoid repeated downloads.
    if (!text) {
      if (typeof caches !== "undefined") {
        try {
          const cache = await caches.open("bert-vocab-v1");
          const cached = await cache.match(VOCAB_CDN_URL);
          if (cached) {
            text = await cached.text();
          } else {
            const res = await fetch(VOCAB_CDN_URL);
            if (res.ok) {
              text = await res.text();
              try {
                await cache.put(VOCAB_CDN_URL, new Response(text, {
                  headers: { "content-type": "text/plain" },
                }));
              } catch { /* cache quota exceeded — continue with in-memory text */ }
            }
          }
        } catch { /* Cache API unavailable — fall through to direct fetch */ }
      }
      if (!text) {
        const res = await fetch(VOCAB_CDN_URL);
        if (!res.ok) throw new Error(`Failed to fetch BERT vocab: ${res.status}`);
        text = await res.text();
      }
    }

    const map = new Map<string, number>();
    text.split("\n").forEach((token, idx) => {
      const t = token.trim();
      if (t) map.set(t, idx);
    });
    _vocab = map;
    return map;
  })().catch((err) => {
    // Clear so callers can retry after a transient network failure
    _vocabPromise = null;
    throw err;
  });

  return _vocabPromise;
}

/**
 * WordPiece tokenisation matching bert-base-uncased.
 * Falls back to character-level [UNK] if a subword is not in the vocabulary.
 */
function wordPieceTokenize(word: string, vocab: Map<string, number>): number[] {
  if (word.length > 200) return [UNK_ID]; // guard against pathological input

  const ids: number[] = [];
  let start = 0;
  while (start < word.length) {
    let end = word.length;
    let found = false;
    while (start < end) {
      const substr = (start === 0 ? "" : "##") + word.slice(start, end);
      if (vocab.has(substr)) {
        ids.push(vocab.get(substr)!);
        start = end;
        found = true;
        break;
      }
      end--;
    }
    if (!found) {
      ids.push(UNK_ID);
      start++;
    }
  }
  return ids.length > 0 ? ids : [UNK_ID];
}

/**
 * Produces the three int32 input arrays expected by BERT-family .tflite
 * embedding models (e.g. MediaPipe bert_embedder):
 *   input_word_ids  — real WordPiece token IDs, [CLS] prepended, [SEP] appended
 *   input_mask      — 1 for real tokens, 0 for padding
 *   input_type_ids  — all zeros (single-segment)
 *
 * Loads the bert-base-uncased vocabulary on first call (cached in memory and
 * Cache API). Falls back to the djb2 hash approach if the vocab cannot be
 * fetched (e.g. offline with no cache).
 */
async function tokeniseBert(text: string): Promise<{
  input_word_ids: number[];
  input_mask: number[];
  input_type_ids: number[];
}> {
  let vocab: Map<string, number> | null = null;
  try {
    vocab = await loadVocab();
  } catch {
    // Network unavailable and no cache — fall back to djb2 hashing
  }

  // Normalise: lowercase, strip accents, split on whitespace/punctuation
  const cleaned = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics
    .replace(/[^a-z0-9\s]/g, " ")
    .trim();

  const words = cleaned.split(/\s+/).filter(Boolean);

  const ids: number[] = [CLS_ID];

  if (vocab) {
    for (const word of words) {
      if (ids.length >= SEQ_LEN - 1) break; // leave room for [SEP]
      const subIds = wordPieceTokenize(word, vocab);
      for (const id of subIds) {
        if (ids.length >= SEQ_LEN - 1) break;
        ids.push(id);
      }
    }
  } else {
    // djb2 fallback when vocab is unavailable.
    // Start at 1000 to avoid the reserved BERT special token range (0–999).
    for (const w of words.slice(0, SEQ_LEN - 2)) {
      let h = 5381;
      for (let i = 0; i < w.length; i++) h = ((h << 5) + h) ^ w.charCodeAt(i);
      ids.push((Math.abs(h) % 29522) + 1000); // 1000–30521, avoids 0–999
    }
  }

  ids.push(SEP_ID);

  const mask = new Array<number>(SEQ_LEN).fill(0);
  const wordIds = new Array<number>(SEQ_LEN).fill(PAD_ID);
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



// ── Chunking ───────────────────────────────────────────────────────────────

// BERT-base-uncased has a 128-token limit. At ~4 chars/token, 300 chars is a
// conservative ceiling that avoids silent truncation inside the tokenizer.
// The overlap preserves cross-boundary context without duplicating too much text.
export const DEFAULT_CHUNK_SIZE = 300;
export const DEFAULT_CHUNK_OVERLAP = 60;

export function splitIntoChunks(
  text: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
  chunkOverlap = DEFAULT_CHUNK_OVERLAP,
): string[] {
  const overlap = Math.min(chunkOverlap, Math.floor(chunkSize / 2));
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end).trim());
    if (end === text.length) break;
    start += chunkSize - overlap;
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
  /** CBL blob ref or data URL for image knowledge chunks */
  imageRef?: string;
  /** 1-based PDF page number this chunk was extracted from */
  pageNumber?: number;
}

// ── BM25 ───────────────────────────────────────────────────────────────────
//
// Okapi BM25 scoring for a single document against a query.
// k1 and b are standard defaults from the original paper.

const BM25_K1 = 1.5;
const BM25_B  = 0.75;

function termFrequencies(text: string): Map<string, number> {
  const tf = new Map<string, number>();
  for (const w of text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
    if (w.length > 1) tf.set(w, (tf.get(w) ?? 0) + 1);
  }
  return tf;
}

function bm25Score(
  queryTerms: string[],
  docTf: Map<string, number>,
  docLen: number,
  avgDocLen: number,
  idf: Map<string, number>,
): number {
  let score = 0;
  for (const term of queryTerms) {
    const tf = docTf.get(term) ?? 0;
    if (tf === 0) continue;
    const idfVal = idf.get(term) ?? 0;
    score += idfVal * (tf * (BM25_K1 + 1)) /
      (tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgDocLen)));
  }
  return score;
}

function buildIdf(queryTerms: string[], corpus: Map<string, number>[]): Map<string, number> {
  const N = corpus.length;
  const idf = new Map<string, number>();
  for (const term of queryTerms) {
    const df = corpus.filter((tf) => tf.has(term)).length;
    // Smoothed IDF: ln((N - df + 0.5) / (df + 0.5) + 1)
    idf.set(term, Math.log((N - df + 0.5) / (df + 0.5) + 1));
  }
  return idf;
}

// ── Reciprocal Rank Fusion ─────────────────────────────────────────────────
//
// Combines two ranked lists without requiring score normalisation.
// RRF(d) = Σ 1 / (k + rank_i(d))  where k=60 is the standard constant.

const RRF_K = 60;

function rrfFuse(
  vectorRanked: RetrievedChunk[],
  bm25Ranked:   RetrievedChunk[],
  bm25Weight: number, // 0 = pure vector, 1 = pure BM25
): RetrievedChunk[] {
  const vectorWeight = 1 - bm25Weight;
  const scores = new Map<string, number>();
  const byId   = new Map<string, RetrievedChunk>();

  vectorRanked.forEach((c, i) => {
    scores.set(c.id, (scores.get(c.id) ?? 0) + vectorWeight / (RRF_K + i + 1));
    byId.set(c.id, c);
  });
  bm25Ranked.forEach((c, i) => {
    scores.set(c.id, (scores.get(c.id) ?? 0) + bm25Weight / (RRF_K + i + 1));
    byId.set(c.id, c);
  });

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ ...byId.get(id)!, score }));
}

// ── Candidate pool cache ───────────────────────────────────────────────────
//
// Fetching all chunks + messages from the DB on every retrieval call is
// expensive when the knowledge base is large. We cache the raw DB results
// and only re-fetch when the pool version counter (bumped by db.ts on every
// write/delete) has changed since the last fetch.

type RawPool = {
  chunks: import("./types").KnowledgeChunk[];
  messages: import("./types").Message[];
};

// Pre-computed TF maps are cached alongside the raw pool so BM25 scoring
// doesn't recompute termFrequencies() for every document on every query.
type TfCache = {
  chunkTf: Map<string, Map<string, number>>;
  msgTf:   Map<string, Map<string, number>>;
};

let _poolCache: RawPool | null = null;
let _tfCache: TfCache | null = null;
let _poolCacheVersion = -1;
// Serialised sourceTypes used when the pool was last fetched.
// A different sourceTypes set must bust the cache even if the DB version
// hasn't changed — otherwise a knowledge-only fetch poisons the cache for
// a subsequent knowledge+message fetch (and vice-versa).
let _poolCacheSourceKey = "";

function sourceKey(types: RetrievedItemType[]): string {
  return [...types].sort().join(",");
}

async function fetchPool(
  sourceTypes: RetrievedItemType[],
): Promise<RawPool & TfCache> {
  // Capture version BEFORE the async fetch so any write that races with the
  // fetch bumps the counter and forces a re-fetch on the next call.
  const versionAtStart = getRagPoolVersion();
  const sk = sourceKey(sourceTypes);
  if (_poolCache && _tfCache && versionAtStart === _poolCacheVersion && sk === _poolCacheSourceKey) {
    return { ..._poolCache, ..._tfCache };
  }

  const [chunks, messages] = await Promise.all([
    sourceTypes.includes("knowledge") ? listKnowledgeChunks() : Promise.resolve([]),
    sourceTypes.includes("message")   ? listEmbeddedMessages() : Promise.resolve([]),
  ]);

  // Pre-compute TF maps once per pool refresh — O(n) amortised over all queries.
  const chunkTf = new Map(chunks.map((c) => [c.id, termFrequencies(c.text)]));
  const msgTf   = new Map(messages.map((m) => [m.id, termFrequencies(m.content)]));

  // Only cache if no write raced with the fetch — if the version advanced,
  // leave the cache invalid so the next call re-fetches fresh data.
  if (getRagPoolVersion() === versionAtStart) {
    _poolCache = { chunks, messages };
    _tfCache   = { chunkTf, msgTf };
    _poolCacheVersion = versionAtStart;
    _poolCacheSourceKey = sk;
  }
  return { chunks, messages, chunkTf, msgTf };
}

/** Invalidate the pool cache (e.g. after a bulk re-embed completes). */
export function invalidateRagPoolCache(): void {
  _poolCache = null;
  _tfCache   = null;
  _poolCacheVersion = -1;
  _poolCacheSourceKey = "";
}

/**
 * Retrieves the top-K items from both knowledge chunks and conversation
 * messages using hybrid search: vector cosine similarity fused with BM25
 * keyword scoring via Reciprocal Rank Fusion.
 *
 * @param queryEmbedding         Embedding of the user query
 * @param queryText              Raw query string (for BM25)
 * @param topK                   Maximum number of results to return
 * @param threshold              Minimum cosine similarity for vector candidates
 * @param excludeConversationId  Skip messages from this conversation
 * @param sourceTypes            Which collections to search
 * @param bm25Weight             0 = pure vector, 1 = pure BM25 (default 0.3)
 */
export async function retrieveTopK(
  queryEmbedding: number[],
  queryText: string,
  topK: number,
  threshold = 0.3,
  excludeConversationId?: string,
  sourceTypes: RetrievedItemType[] = ["knowledge", "message"],
  bm25Weight = 0.3,
): Promise<RetrievedChunk[]> {
  const { chunks, messages, chunkTf, msgTf } = await fetchPool(sourceTypes);

  // Pre-build embedding lookup maps — O(n) instead of O(n²) find() in the loop
  const chunkEmbMap = new Map(chunks.map((c) => [c.id, c.embedding]));
  const msgEmbMap   = new Map(messages.map((m) => [m.id, m.embedding]));

  // Build candidate pool with metadata.
  // TF maps come from the pool cache — no per-call recomputation.
  type Candidate = RetrievedChunk & { tf: Map<string, number>; len: number };
  const pool: Candidate[] = [];

  for (const c of chunks) {
    const tf = chunkTf.get(c.id) ?? new Map<string, number>();
    pool.push({ id: c.id, source: c.source, text: c.text, imageRef: c.imageRef, pageNumber: c.pageNumber, score: 0, type: "knowledge", tf, len: c.text.length });
  }
  for (const m of messages) {
    // Always add to pool so BM25 can score un-embedded messages.
    // The vector ranking step below skips items without an embedding.
    if (excludeConversationId && m.conversationId === excludeConversationId) continue;
    const tf = msgTf.get(m.id) ?? new Map<string, number>();
    const label = `${m.role} · ${new Date(m.createdAt).toLocaleDateString()}`;
    pool.push({
      id: m.id, source: label, text: m.content, score: 0,
      type: "message", conversationId: m.conversationId, tf, len: m.content.length,
    });
  }

  if (pool.length === 0) return [];

  // ── Vector ranking ──────────────────────────────────────────────────────
  const vectorRanked: RetrievedChunk[] = [];
  if (bm25Weight < 1) {
    for (const c of pool) {
      const emb = c.type === "knowledge" ? chunkEmbMap.get(c.id) : msgEmbMap.get(c.id);
      if (!emb?.length) continue;
      const score = cosineSimilarity(queryEmbedding, emb);
      if (score < threshold) continue;
      vectorRanked.push({ ...c, score });
    }
    vectorRanked.sort((a, b) => b.score - a.score);
  }

  // ── BM25 ranking ────────────────────────────────────────────────────────
  const bm25Ranked: RetrievedChunk[] = [];
  if (bm25Weight > 0) {
    const queryTerms = Array.from(termFrequencies(queryText).keys());
    const allTfs = pool.map((c) => c.tf);
    const avgLen = pool.length > 0 ? pool.reduce((s, c) => s + c.len, 0) / pool.length : 1;
    const idf = buildIdf(queryTerms, allTfs);

    for (const c of pool) {
      const score = bm25Score(queryTerms, c.tf, c.len, avgLen, idf);
      if (score <= 0) continue;
      bm25Ranked.push({ ...c, score });
    }
    bm25Ranked.sort((a, b) => b.score - a.score);
  }

  // ── Fuse and return ─────────────────────────────────────────────────────
  const fused = bm25Weight === 0
    ? vectorRanked
    : bm25Weight === 1
    ? bm25Ranked
    : rrfFuse(vectorRanked, bm25Ranked, bm25Weight);

  return fused.slice(0, topK);
}

// ── Re-ranking ─────────────────────────────────────────────────────────────
//
// Lightweight lexical re-ranker applied after vector retrieval.
// Computes term-overlap (Jaccard) between the query and each chunk, then
// combines it with the cosine score using a weighted sum.
// This boosts chunks that contain exact query terms without requiring a
// second model.

function tokenise(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function jaccardOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Re-rank retrieved chunks by combining cosine similarity with lexical
 * term overlap against the query.
 *
 * @param query     Original user query string
 * @param chunks    Candidates from vector retrieval (already filtered by threshold)
 * @param alpha     Weight for cosine score (1 - alpha = weight for lexical score)
 */
export function rerank(
  query: string,
  chunks: RetrievedChunk[],
  alpha = 0.7,
): RetrievedChunk[] {
  const queryTokens = tokenise(query);
  return chunks
    .map((c) => {
      const lexical = jaccardOverlap(queryTokens, tokenise(c.text));
      const combined = alpha * c.score + (1 - alpha) * lexical;
      return { ...c, score: combined };
    })
    .sort((a, b) => b.score - a.score);
}


