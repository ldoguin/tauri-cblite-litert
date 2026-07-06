/**
 * db.ts — Storage layer backed by Couchbase Lite on all platforms.
 *
 * The @cblite module alias is resolved at build time by Vite:
 *   Tauri build  → src/lib/cblite/tauri.ts  (tauri-plugin-cblite guest JS)
 *   Web build    → src/lib/cblite/web.ts    (@couchbase/lite-js adapter)
 *
 * No isTauri() branches here — platform selection is a build-time concern.
 * The only remaining isTauri() calls are for Tauri-exclusive APIs that have
 * no web equivalent: invoke("read_config_import") and writeExportFile().
 */

import type {
  Conversation,
  Message,
  KnowledgeChunk,
  ModelConfig,
  Agent,
  Product,
  InspectionRecord,
  ClinicalNote,
  PhotoDoc,
  PersonRecord,
  AnnotationRecord,
  SyncConfig,
  CropDiseaseRecord,
  DiseaseKbDoc,
} from "./types";
import { DEFAULT_MODEL_CONFIG, DEFAULT_SYNC_CONFIG } from "./types";
import {
  openDatabase,
  closeDatabase,
  getDocument,
  saveDocument,
  executeQuery,
  saveBlob,
  getBlobData,
  createFtsIndex,
  listIndexes,
} from "@cblite";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const COL_CONVERSATIONS = "_default.conversations";
const COL_MESSAGES      = "_default.messages";
const COL_KNOWLEDGE     = "_default.knowledge";
const COL_CONFIG        = "_default.config";
const COL_AGENTS        = "_default.agents";
const COL_PDFS          = "_default.pdfs";
const COL_PRODUCTS      = "_default.products";
const COL_INSPECTIONS   = "_default.inspections";
const COL_CLINICAL      = "_default.clinical";
const COL_PHOTOS        = "_default.photos";
const COL_PEOPLE        = "_default.people";
const COL_ANNOTATIONS   = "_default.annotations";
const COL_SYNC          = "_default.sync_config";
const COL_CROP_DISEASE  = "_default.crop_disease";
const COL_DISEASE_KB    = "_default.disease_kb";

export const SYNC_COLLECTIONS = {
  photos:       { primary: COL_PHOTOS,       extra: [COL_PEOPLE] },
  inspections:  { primary: COL_INSPECTIONS,  extra: [] },
  annotations:  { primary: COL_ANNOTATIONS,  extra: [] },
  clinical:     { primary: COL_CLINICAL,     extra: [] },
  cropDisease:  { primary: COL_CROP_DISEASE, extra: [] },
} as const;

// ── Blob storage ───────────────────────────────────────────────────────────
//
// On Tauri, images are stored as CouchbaseLite blobs (binary, deduplicated by
// content hash). The document field stores a "cbl-blob:<digest>:<mimeType>"
// reference string instead of the full base64 data URL.
//
// On web, blobs are not supported — the data URL is stored as-is.

/** Sentinel prefix used to identify CBL blob references in message fields. */
export const CBL_BLOB_PREFIX = "cbl-blob:";

/**
 * Save a base64 data URL as a CBL blob.
 * Returns a reference string "cbl-blob:<digest>:<mimeType>" for storage.
 */
export async function saveImageAsBlob(dataUrl: string): Promise<string> {
  // Extract mime type and raw base64 from "data:<mime>;base64,<data>"
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) return dataUrl; // not a valid data URL — store as-is
  const [, mimeType, dataB64] = match;
  const digest = await saveBlob(dataB64, mimeType);
  return `${CBL_BLOB_PREFIX}${digest}:${mimeType}`;
}

/**
 * Resolve a stored image field back to a data URL.
 * If the value is a CBL blob reference, fetches the bytes from the database.
 * If it's already a data URL, returns it unchanged.
 * Returns null if the blob cannot be loaded.
 */
export async function loadImageFromBlob(stored: string): Promise<string | null> {
  if (!stored.startsWith(CBL_BLOB_PREFIX)) return stored; // plain data URL
  // Parse "cbl-blob:<digest>:<mimeType>"
  const rest = stored.slice(CBL_BLOB_PREFIX.length);
  const colonIdx = rest.indexOf(":");
  if (colonIdx === -1) return null;
  const digest = rest.slice(0, colonIdx);
  const mimeType = rest.slice(colonIdx + 1);
  try {
    const dataB64 = await getBlobData(digest);
    return `data:${mimeType};base64,${dataB64}`;
  } catch {
    return null;
  }
}

/** True if a stored image field is a CBL blob reference (not a data URL). */
export function isBlobRef(value: string): boolean {
  return value.startsWith(CBL_BLOB_PREFIX);
}

// ── Init progress events ───────────────────────────────────────────────────
//
// Dispatched on window so the splash screen can display progress without
// needing a direct reference to db internals. Useful on Android where
// DevTools is unavailable.

export const DB_PROGRESS_EVENT = "rag-chatbot:db-progress";

export function dispatchDbProgress(message: string): void {
  console.log("[db]", message);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DB_PROGRESS_EVENT, { detail: { message } }));
  }
}

// ── RAG pool version counter ───────────────────────────────────────────────
//
// Incremented whenever knowledge chunks or embedded messages are written or
// deleted. rag.ts reads this to decide whether its cached candidate pool is
// still valid, avoiding repeated full DB scans on every retrieval call.

let _ragPoolVersion = 0;
export function getRagPoolVersion(): number { return _ragPoolVersion; }
export function bumpRagPoolVersion(): void { _ragPoolVersion++; }

// ── Schema versioning ──────────────────────────────────────────────────────
//
// Increment DB_SCHEMA_VERSION whenever a breaking schema change is made.
// runMigrations() applies any pending migrations in order on every startup.

const DB_SCHEMA_VERSION = 4;
const SCHEMA_VERSION_DOC = "schema-version";

/** Delete every document in the products collection using a raw ID scan. */
async function nukeAllProducts(): Promise<number> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id FROM \`_default\`.products`,
    {},
  ) as Array<{ id: string }>;
  if (rows.length > 0) {
    await Promise.all(rows.map((r) => saveDocument(COL_PRODUCTS, r.id, { __deleted: true })));
  }
  return rows.length;
}

async function runMigrations(): Promise<void> {
  const doc = await getDocument(COL_CONFIG, SCHEMA_VERSION_DOC)
    .catch((e: unknown) => {
      if (String(e).toLowerCase().includes("not found")) return null;
      throw e;
    }) as { version?: number } | null;
  const currentVersion = doc?.version ?? 0;

  dispatchDbProgress(`DB schema: current v${currentVersion}, target v${DB_SCHEMA_VERSION}`);

  if (currentVersion >= DB_SCHEMA_VERSION) return;

  // ── Migration v1 → v2 → v3 → v4 ─────────────────────────────────────────
  // Clear all products so they re-seed with latest schema (blob images, gender field).
  if (currentVersion < 4) {
    dispatchDbProgress("Migration: clearing all product documents…");
    const count = await nukeAllProducts();
    dispatchDbProgress(`Migration: removed ${count} product docs — will re-seed`);
  }

  await saveDocument(COL_CONFIG, SCHEMA_VERSION_DOC, { version: DB_SCHEMA_VERSION });
  dispatchDbProgress(`DB schema updated to v${DB_SCHEMA_VERSION}`);
}

/**
 * Force-clear all products and re-seed from products-seed.json.
 * Called from the UI "Reset catalog" button.
 */
export async function resetProductCatalog(): Promise<void> {
  dispatchDbProgress("Resetting product catalog…");
  const count = await nukeAllProducts();
  dispatchDbProgress(`Cleared ${count} products`);
  await seedProductsIfEmpty();
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

export async function initDatabase(dbDir: string, ftsLanguage = "en"): Promise<void> {
  await openDatabase(dbDir, "rag-chatbot", undefined, [
    COL_CONVERSATIONS, COL_MESSAGES, COL_KNOWLEDGE, COL_CONFIG, COL_AGENTS, COL_PDFS, COL_PRODUCTS, COL_INSPECTIONS, COL_CLINICAL, COL_PHOTOS, COL_PEOPLE, COL_ANNOTATIONS, COL_SYNC, COL_CROP_DISEASE, COL_DISEASE_KB,
  ]);
  // Create FTS indexes. Failures are logged but don't abort init.
  // The web adapter stubs these as no-ops; FTS queries fall back to JS filtering.
  for (const [col, name, field] of [
    [COL_KNOWLEDGE,    "knowledgeFts",    "text"],
    [COL_MESSAGES,     "messagesFts",     "content"],
    [COL_PRODUCTS,     "productsFts",     "name"],
    [COL_INSPECTIONS,  "inspectionsFts",  "notes"],
    [COL_CLINICAL,     "clinicalFts",     "rawNotes"],
    [COL_PHOTOS,       "photosFts",       "caption"],
    [COL_ANNOTATIONS,  "annotationsFts",  "labels"],
    [COL_CROP_DISEASE, "cropDiseaseFts",  "notes"],
    [COL_DISEASE_KB,   "diseaseKbFts",    "searchText"],
  ] as Array<[string, string, string]>) {
    try {
      await createFtsIndex(col, name, field, ftsLanguage);
      dispatchDbProgress(`FTS ${name}: ✓ created`);
    } catch (e) {
      dispatchDbProgress(`FTS ${name} FAILED: ${String(e)}`);
    }
    try {
      const existing = await listIndexes(col);
      if (existing.length > 0 && !existing.includes(name)) {
        dispatchDbProgress(`FTS ${name}: ✗ NOT FOUND in index list — ${existing.join(", ")}`);
      }
    } catch { /* listIndexes not critical */ }
  }
  await runMigrations();
  await seedProductsIfEmpty();
  await seedDiseaseKbIfEmpty();
}

export async function shutdownDatabase(): Promise<void> {
  await closeDatabase();
}

// ── Config ─────────────────────────────────────────────────────────────────

export async function loadConfig(): Promise<ModelConfig> {
  // On Tauri desktop: check for a config.json import file first.
  // (On Android this is handled by the Kotlin openDatabase hook before we run.)
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const { platform } = await import("@tauri-apps/plugin-os");
      if ((await platform()) !== "android") {
        const raw = await invoke<string | null>("read_config_import");
        if (raw) {
          const imported = JSON.parse(raw) as Partial<ModelConfig>;
          const merged = { ...DEFAULT_MODEL_CONFIG, ...imported };
          await saveConfig(merged);
          return merged;
        }
      }
    } catch { /* ignore */ }
  }

  const doc = await getDocument(COL_CONFIG, "app-config")
    .catch((e: unknown) => {
      if (String(e).toLowerCase().includes("not found")) return null;
      throw e;
    });
  if (!doc) return { ...DEFAULT_MODEL_CONFIG };
  const { _id: _, ...rest } = doc as Record<string, unknown>;
  return { ...DEFAULT_MODEL_CONFIG, ...(rest as Partial<ModelConfig>) };
}

export async function saveConfig(config: ModelConfig): Promise<void> {
  await saveDocument(COL_CONFIG, "app-config", config as unknown as Record<string, unknown>);
}

// ── Sync config ────────────────────────────────────────────────────────────

export async function loadSyncConfig(): Promise<SyncConfig> {
  const doc = await getDocument(COL_SYNC, "sync-config").catch(() => null);
  if (!doc) return { ...DEFAULT_SYNC_CONFIG };
  const { _id: _unused, ...rest } = doc as Record<string, unknown>;
  return { ...DEFAULT_SYNC_CONFIG, ...(rest as Partial<SyncConfig>) };
}

export async function saveSyncConfig(config: SyncConfig): Promise<void> {
  await saveDocument(COL_SYNC, "sync-config", config as unknown as Record<string, unknown>);
}

// ── Conversations ──────────────────────────────────────────────────────────

export async function listConversations(limit = 200, offset = 0): Promise<Conversation[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, title, createdAt, updatedAt, systemInstruction, modelPath
     FROM \`_default\`.conversations
     WHERE __deleted IS MISSING
     ORDER BY updatedAt DESC
     LIMIT ${limit} OFFSET ${offset}`,
    {},
  );
  return rows as Conversation[];
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const doc = await getDocument(COL_CONVERSATIONS, id)
    .catch((e: unknown) => {
      if (String(e).toLowerCase().includes("not found")) return null;
      throw e;
    });
  return doc ? { id, ...(doc as Omit<Conversation, "id">) } : null;
}

export async function saveConversation(conv: Conversation): Promise<void> {
  const { id, ...body } = conv;
  await saveDocument(COL_CONVERSATIONS, id, body as Record<string, unknown>);
}

export async function deleteConversation(id: string): Promise<void> {
  bumpRagPoolVersion();
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id FROM \`_default\`.messages WHERE conversationId = $cid`,
    { cid: id },
  ) as Array<{ id: string }>;
  await Promise.all(rows.map((r) => saveDocument(COL_MESSAGES, r.id, { __deleted: true })));
  await saveDocument(COL_CONVERSATIONS, id, { __deleted: true });
}

// ── Messages ───────────────────────────────────────────────────────────────

// Default limit of 200 covers realistic conversation lengths without loading
// the entire history into memory. LLM context truncation is handled by
// truncateToFitTokens() in llm.ts — not by this limit.
export async function listMessages(conversationId: string, limit = 200, offset = 0): Promise<Message[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, conversationId, role, content, createdAt, latencyMs, ragSourceIds, bookmarked, stopped, imageDataUrl, chunkIds, isChunk
     FROM \`_default\`.messages
     WHERE conversationId = $cid AND (isChunk IS MISSING OR isChunk = false) AND __deleted IS MISSING
     ORDER BY createdAt ASC
     LIMIT ${limit} OFFSET ${offset}`,
    { cid: conversationId },
  );
  return rows as Message[];
}

export async function saveMessage(msg: Message): Promise<void> {
  const { id, ...body } = msg;
  bumpRagPoolVersion();
  await saveDocument(COL_MESSAGES, id, body as Record<string, unknown>);
}

/** Returns all bookmarked messages across all conversations, newest first. */
export async function listBookmarkedMessages(limit = 500): Promise<Message[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, conversationId, role, content, createdAt, latencyMs, ragSourceIds, bookmarked, stopped
     FROM \`_default\`.messages
     WHERE bookmarked = true AND (isChunk IS MISSING OR isChunk = false)
     ORDER BY createdAt DESC
     LIMIT ${limit}`,
    {},
  );
  return rows as Message[];
}

export async function deleteMessage(id: string): Promise<void> {
  bumpRagPoolVersion();
  const parent = await getDocument(COL_MESSAGES, id)
    .catch((e: unknown) => {
      if (String(e).toLowerCase().includes("not found")) return null;
      throw e;
    }) as { chunkIds?: string[] } | null;
  if (parent?.chunkIds?.length) {
    await Promise.all(
      parent.chunkIds.map((cid) => saveDocument(COL_MESSAGES, cid, { __deleted: true })),
    );
  }
  await saveDocument(COL_MESSAGES, id, { __deleted: true });
}

// ── Knowledge base ─────────────────────────────────────────────────────────

export async function saveKnowledgeChunk(chunk: KnowledgeChunk): Promise<void> {
  const { id, ...body } = chunk;
  bumpRagPoolVersion();
  await saveDocument(COL_KNOWLEDGE, id, body as Record<string, unknown>);
}

export async function listKnowledgeChunks(limit = 2000, offset = 0): Promise<KnowledgeChunk[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, source, text, embedding, createdAt, imageRef, pageNumber
     FROM \`_default\`.knowledge
     WHERE __deleted IS MISSING
     ORDER BY createdAt DESC
     LIMIT ${limit} OFFSET ${offset}`,
    {},
  );
  return rows as KnowledgeChunk[];
}

/**
 * Full-text search over knowledge chunks using the CBL FTS index (Tauri) or
 * an in-memory case-insensitive substring filter (web).
 *
 * Requires the `knowledgeFts` index to exist on the `knowledge` collection,
 * which is created by `initDatabase` via `createFtsIndex` after `openDatabase`.
 */
export async function searchKnowledgeText(
  query: string,
  limit = 20,
): Promise<KnowledgeChunk[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, source, text, createdAt, imageRef, pageNumber
     FROM _default.knowledge
     WHERE MATCH(knowledge.knowledgeFts, $query) AND __deleted IS MISSING
     ORDER BY RANK() DESC
     LIMIT ${limit}`,
    { query },
  );
  return rows as KnowledgeChunk[];
}

/**
 * Returns all messages that have been vectorised (embedding field present),
 * across all conversations. Used by the RAG retrieval path so that past
 * conversation turns are searchable alongside knowledge-base chunks.
 */
// 50k is a practical upper bound for the RAG pool — beyond this, cosine
// search over Float32 vectors becomes the bottleneck, not the DB query.
// Callers that need exhaustive retrieval should paginate via offset.
export async function listEmbeddedMessages(limit = 50_000): Promise<Message[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, conversationId, role, content, createdAt, embedding
     FROM \`_default\`.messages
     WHERE embedding IS NOT MISSING AND (isChunk IS MISSING OR isChunk = false)
     ORDER BY createdAt DESC
     LIMIT ${limit}`,
    {},
  );
  return rows as Message[];
}

/** Fetch specific knowledge chunks by their IDs (for RAG source viewer). */
export async function getKnowledgeChunksByIds(ids: string[]): Promise<KnowledgeChunk[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map((_, i) => `$id${i}`).join(", ");
  const params = Object.fromEntries(ids.map((id, i) => [`id${i}`, id]));
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, source, text, createdAt, imageRef, pageNumber FROM \`_default\`.knowledge WHERE META().id IN [${placeholders}]`,
    params,
  );
  return rows as KnowledgeChunk[];
}

/** Fetch specific messages by their IDs (for RAG source viewer). */
export async function getMessagesByIds(ids: string[]): Promise<Message[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map((_, i) => `$id${i}`).join(", ");
  const params = Object.fromEntries(ids.map((id, i) => [`id${i}`, id]));
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, conversationId, role, content, createdAt,
            ragSourceIds, bookmarked, stopped, imageDataUrl
     FROM \`_default\`.messages
     WHERE META().id IN [${placeholders}] AND (isChunk IS MISSING OR isChunk = false)`,
    params,
  );
  return rows as Message[];
}

export async function deleteKnowledgeChunk(id: string): Promise<void> {
  bumpRagPoolVersion();
  // Use a non-CBL-reserved tombstone field so CBL 4.x accepts the document.
  // `listKnowledgeChunks` filters these out via `WHERE __deleted IS MISSING`.
  // On APK rebuild, the Kotlin/Rust plugin will intercept `__deleted: true`
  // and call `purge()` to permanently remove the document.
  await saveDocument(COL_KNOWLEDGE, id, { __deleted: true });
}

/** Delete all chunks whose source label matches exactly. */
export async function deleteKnowledgeBySource(source: string): Promise<void> {
  bumpRagPoolVersion();
  // CBL N1QL is read-only — DELETE statements are not supported.
  // Fetch matching IDs first, then purge each document individually.
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id FROM \`_default\`.knowledge WHERE source = $source`,
    { source },
  ) as Array<{ id: string }>;
  await Promise.all(rows.map((r) => saveDocument(COL_KNOWLEDGE, r.id, { __deleted: true })));
}

// ── Agents ─────────────────────────────────────────────────────────────────

export async function listAgents(): Promise<Agent[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, name, systemPrompt, description, toolIds, createdAt, updatedAt
     FROM \`_default\`.agents ORDER BY name ASC`,
  );
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    ...(row as unknown as Agent),
    toolIds: (row.toolIds as string[] | undefined) ?? [],
  }));
}

export async function saveAgent(agent: Agent): Promise<void> {
  const { id, ...body } = agent;
  await saveDocument(COL_AGENTS, id, body as Record<string, unknown>);
}

export async function deleteAgent(id: string): Promise<void> {
  await saveDocument(COL_AGENTS, id, { __deleted: true });
}

// ── PDF records ────────────────────────────────────────────────────────────
//
// Maps PDF filenames to their on-disk paths. The actual bytes live at
// {app_local_data_dir}/pdfs/<filename> (written by the `save_pdf` Rust command).
// CBL stores the filename → path mapping so PDF tools can locate files by name.

export interface PdfRecord {
  filename: string;
  path: string;
  createdAt: string;
}

export async function savePdfRecord(filename: string, filePath: string): Promise<void> {
  const doc = { filename, path: filePath, createdAt: new Date().toISOString() };
  await saveDocument(COL_PDFS, filename, doc);
}

export async function getPdfPath(filename: string): Promise<string | null> {
  const doc = await getDocument(COL_PDFS, filename)
    .catch((e: unknown) => {
      if (String(e).toLowerCase().includes("not found")) return null;
      throw e;
    }) as { path?: string } | null;
  return doc?.path ?? null;
}

export async function listPdfRecords(): Promise<PdfRecord[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, filename, path, createdAt FROM \`_default\`.pdfs WHERE __deleted IS MISSING ORDER BY createdAt DESC`,
    {},
  );
  return rows as PdfRecord[];
}


// ── Products ───────────────────────────────────────────────────────────────

export async function listProducts(): Promise<Product[]> {
  // Omit `embedding` — 384 floats per product overflows Tauri IPC for large catalogs.
  // Use `hasEmbedding` (boolean) to know which products already have a persisted vector.
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, name, description, category, price, imageRef, thumb, hasEmbedding, createdAt
     FROM \`_default\`.products
     WHERE __deleted IS MISSING AND name IS NOT MISSING
     ORDER BY name ASC`,
    {},
  );
  return (rows as Product[]).filter((p) => !!p.name);
}

/**
 * Search products using CBL FTS (MATCH) for text, returning up to 50 candidates
 * ordered by FTS relevance.  Includes the `embedding` field so the caller can
 * do a cosine re-rank without a second round-trip.
 *
 * When query is empty, falls back to listProducts() filtered by category.
 */
export async function searchProducts(query: string, category: string): Promise<Product[]> {
  // Web fallback: simple in-memory filter

  // No query → return the catalogue without embeddings (display only)
  if (!query.trim()) {
    const all = await listProducts();
    return category === "All" ? all : all.filter((p) => p.category === category);
  }


  const catClause = category === "All" ? "" : "AND category = $cat";
  const params: Record<string, unknown> = { query };
  if (category !== "All") params.cat = category;

  try {
    // Use unquoted scope name — CBL 4.x MATCH() resolves FTS indexes differently
    // with backtick-quoted vs unquoted scope identifiers.
    const rows = await executeQuery(
      "N1QL",
      `SELECT META().id AS id, name, description, category, price, imageRef, thumb, hasEmbedding, embedding, createdAt
       FROM _default.products
       WHERE MATCH(products.productsFts, $query) AND __deleted IS MISSING ${catClause}
       LIMIT 50`,
      params,
    );
    return (rows as Product[]).filter((p) => !!p.name);
  } catch (e) {
    dispatchDbProgress(`FTS unavailable (${String(e).slice(0, 80)}), using LIKE`);
    const likeParams: Record<string, unknown> = { pattern: `%${query.toLowerCase()}%` };
    if (category !== "All") likeParams.cat = category;
    const rows = await executeQuery(
      "N1QL",
      `SELECT META().id AS id, name, description, category, price, imageRef, thumb, hasEmbedding, embedding, createdAt
       FROM _default.products
       WHERE __deleted IS MISSING AND name IS NOT MISSING
         AND (LOWER(name) LIKE $pattern OR LOWER(description) LIKE $pattern)
         ${catClause}
       LIMIT 50`,
      likeParams,
    );
    return (rows as Product[]).filter((p) => !!p.name);
  }
}

/**
 * Load all products that have a stored embedding, including the embedding vector.
 * Used for pure vector search (image search) without a keyword pre-filter.
 */
export async function listProductsWithEmbeddings(): Promise<Product[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, name, description, category, price, imageRef, thumb, hasEmbedding, embedding, createdAt
     FROM \`_default\`.products
     WHERE hasEmbedding = true AND __deleted IS MISSING AND name IS NOT MISSING`,
    {},
  );
  return (rows as Product[]).filter((p) => !!p.name && p.embedding?.length);
}

/**
 * Load all products that have a stored imageEmbedding (from LLM image description).
 * Used for image-to-image vector search — higher cross-modal alignment than text embeddings.
 */
export async function listProductsWithImageEmbeddings(): Promise<Product[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, name, description, category, price, imageRef, thumb, hasImageEmbedding, imageEmbedding, createdAt
     FROM _default.products
     WHERE hasImageEmbedding = true AND __deleted IS MISSING AND name IS NOT MISSING`,
    {},
  );
  return (rows as Product[]).filter((p) => !!p.name && p.imageEmbedding?.length);
}

/**
 * Returns products that have a thumbnail but no imageEmbedding yet.
 * Used by the bulk image embedding job.
 */
export async function listProductsNeedingImageEmbedding(): Promise<Product[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, name, description, category, imageRef, createdAt
     FROM _default.products
     WHERE __deleted IS MISSING AND name IS NOT MISSING
       AND imageRef IS NOT MISSING
       AND (hasImageEmbedding IS MISSING OR hasImageEmbedding = false)
     LIMIT 500`,
    {},
  );
  return rows as Product[];
}

/**
 * Persist an imageEmbedding for a product without touching its other fields.
 */
export async function saveProductImageEmbedding(id: string, embedding: number[], description?: string): Promise<void> {
  const existing = await getDocument(COL_PRODUCTS, id) as Record<string, unknown> | null;
  if (!existing) return;
  await saveDocument(COL_PRODUCTS, id, {
    ...existing,
    imageEmbedding: embedding,
    hasImageEmbedding: true,
    ...(description ? { imageDescription: description } : {}),
  });
}

/** Resolve a product's imageRef to a displayable data URL. */
export async function getProductImage(id: string): Promise<string | null> {
  try {
    const doc = await getDocument(COL_PRODUCTS, id)
      .catch((e: unknown) => {
        if (String(e).toLowerCase().includes("not found")) return null;
        throw e;
      }) as { imageRef?: string } | null;
    if (!doc?.imageRef) {
      dispatchDbProgress(`[img] no imageRef for ${id}`);
      return null;
    }
    const result = await loadImageFromBlob(doc.imageRef);
    if (!result) dispatchDbProgress(`[img] blob load failed for ${id} (ref: ${doc.imageRef.slice(0, 40)})`);
    return result;
  } catch (e) {
    dispatchDbProgress(`[img] error for ${id}: ${String(e).slice(0, 80)}`);
    return null;
  }
}

/**
 * Infer gender audience from product name + description.
 * Order matters: check "women" before "men" (since "men" is a substring of "women").
 */
export function inferGender(name: string, description: string): "Men" | "Women" | "Kids" | "Unisex" {
  const text = `${name} ${description}`.toLowerCase();
  if (/\bwom[ae]n\b/.test(text) || /\bfemale\b/.test(text) || /\bladies\b/.test(text)) return "Women";
  if (/\bgirls?\b/.test(text)) return "Kids";
  if (/\bmen\b/.test(text) || /\bmale\b/.test(text)) return "Men";
  if (/\bboys?\b/.test(text) || /\bkids?\b/.test(text) || /\bchildren\b/.test(text)) return "Kids";
  return "Unisex";
}

export async function saveProduct(product: Product): Promise<void> {
  const { id, embedding, ...body } = product;
  // Convert base64 data URLs to CBL blob attachments so documents stay small.
  if (body.imageRef?.startsWith("data:")) {
    body.imageRef = await saveImageAsBlob(body.imageRef);
  }
  // Store the embedding array only if provided; mark hasEmbedding for listProducts queries.
  const docBody: Record<string, unknown> = { ...body };
  if (embedding && embedding.length > 0) {
    docBody.embedding = embedding;
    docBody.hasEmbedding = true;
  }
  await saveDocument(COL_PRODUCTS, id, docBody);
}

export async function deleteProduct(id: string): Promise<void> {
  await saveDocument(COL_PRODUCTS, id, { __deleted: true });
}

type EmbeddingEntry = { embedding?: number[]; imageEmbedding?: number[]; imageDescription?: string };

/**
 * Export all product embeddings to a user-accessible file via Rust.
 * On Android: /sdcard/Android/data/<pkg>/files/embeddings.json (ADB pull from there)
 * On desktop: ~/Downloads/embeddings.json
 * Returns the number of products exported.
 */
export async function exportProductEmbeddings(): Promise<number> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, embedding, imageEmbedding, imageDescription
     FROM _default.products
     WHERE __deleted IS MISSING AND name IS NOT MISSING
       AND (hasEmbedding = true OR hasImageEmbedding = true)`,
    {},
  ) as Array<{ id: string; embedding?: number[]; imageEmbedding?: number[]; imageDescription?: string }>;

  const map: Record<string, EmbeddingEntry> = {};
  for (const row of rows) {
    const entry: EmbeddingEntry = {};
    if (row.imageEmbedding?.length) {
      entry.imageEmbedding = row.imageEmbedding;
      if (row.imageDescription) entry.imageDescription = row.imageDescription;
    } else if (row.embedding?.length) {
      entry.embedding = row.embedding;
    }
    if (Object.keys(entry).length) map[row.id] = entry;
  }

  if (!isTauri()) {
    dispatchDbProgress("Export not supported in the browser");
    return 0;
  }
  const { writeExportFile } = await import("tauri-plugin-cblite");
  const savedPath = await writeExportFile("embeddings.json", JSON.stringify(map));
  dispatchDbProgress(`Embeddings saved → ${savedPath}`);
  return Object.keys(map).length;
}

async function seedProductsIfEmpty(): Promise<void> {
  const existing = await listProducts();
  if (existing.length > 0) {
    dispatchDbProgress(`Product catalog: ${existing.length} items`);
    return;
  }

  dispatchDbProgress("Fetching product catalog…");
  try {
    const res = await fetch("/products-seed.json");
    if (!res.ok) {
      dispatchDbProgress(`Product seed not found (HTTP ${res.status}) — skipping`);
      return;
    }
    const seed = await res.json() as Product[];

    // Pre-baked embeddings: if public/embeddings.json exists, merge them in at seed time
    // so products start with their vectors and don't need recomputation.
    let embeddingsMap: Record<string, EmbeddingEntry> = {};
    try {
      const er = await fetch("/embeddings.json");
      if (er.ok) {
        embeddingsMap = await er.json() as Record<string, EmbeddingEntry>;
        dispatchDbProgress(`Pre-baked embeddings: ${Object.keys(embeddingsMap).length}`);
      }
    } catch { /* embeddings.json optional */ }

    const now   = new Date().toISOString();
    // Small batch size to avoid overwhelming the Android IPC channel (each product
    // sends ~40 KB of base64 image data to the native side via saveBlob).
    const BATCH = 5;
    const total = seed.length;
    let saved = 0;
    let failed = 0;
    for (let i = 0; i < total; i += BATCH) {
      const results = await Promise.allSettled(
        seed.slice(i, i + BATCH).map((p) => {
          const e = embeddingsMap[p.id];
          const product: Product = {
            ...p,
            createdAt: p.createdAt ?? now,
            gender: p.gender ?? inferGender(p.name, p.description),
          };
          if (e?.embedding?.length)      { product.embedding = e.embedding; }
          if (e?.imageEmbedding?.length) { product.imageEmbedding = e.imageEmbedding; product.hasImageEmbedding = true; }
          if (e?.imageDescription)       { product.imageDescription = e.imageDescription; }
          return saveProduct(product);
        }),
      );
      saved  += results.filter((r) => r.status === "fulfilled").length;
      failed += results.filter((r) => r.status === "rejected").length;
      dispatchDbProgress(`Saving products… ${Math.min(i + BATCH, total)}/${total}${failed > 0 ? ` (${failed} errors)` : ""}`);
    }
    dispatchDbProgress(`Product catalog ready — ${saved}/${total} saved${failed > 0 ? `, ${failed} failed` : ""}`);
  } catch (e) {
    dispatchDbProgress(`Product seed error: ${String(e)}`);
  }
}

// ── Disease Knowledge Base ───────────────────────────────────────────────────
//
// Reference documents only — seeded once from public/disease-profiles.ndjson
// (generated by the plantkb/ pipeline, see plantkb/README.md) and never
// written to from the UI. To pick up updated plantkb data, regenerate the
// seed file (node scripts/copy-disease-profiles.mjs) and bump DB_SCHEMA_VERSION
// so runMigrations() clears the collection and re-seeds — see resetProductCatalog
// for the analogous product-catalog pattern.

async function saveDiseaseKbDoc(id: string, body: Record<string, unknown>): Promise<void> {
  await saveDocument(COL_DISEASE_KB, id, body);
}

function diseaseSearchText(doc: DiseaseKbDoc): string {
  const parts: string[] = [doc.crop, doc.type === "disease_profile" ? doc.disease : "healthy"];
  if (doc.type === "disease_profile") {
    parts.push(doc.taxonomy.scientific_name.value, doc.taxonomy.pathogen_type.value);
    parts.push(...doc.symptoms.map((s) => s.description));
    parts.push(...doc.treatment.organic.map((t) => t.name));
    parts.push(...doc.treatment.chemical.map((t) => t.name));
    parts.push(...doc.treatment.cultural.map((t) => t.name));
    parts.push(...doc.prevention.map((p) => p.description));
  } else {
    parts.push(...doc.visual_traits.map((v) => v.description));
  }
  return parts.filter(Boolean).join(" ");
}

async function seedDiseaseKbIfEmpty(): Promise<void> {
  const existing = await listDiseaseProfiles();
  if (existing.length > 0) {
    dispatchDbProgress(`Disease knowledge base: ${existing.length} profiles`);
    return;
  }

  dispatchDbProgress("Fetching disease knowledge base…");
  try {
    const res = await fetch("/disease-profiles.ndjson");
    if (!res.ok) {
      dispatchDbProgress(`Disease KB seed not found (HTTP ${res.status}) — skipping`);
      return;
    }
    const text = await res.text();
    const docs = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as DiseaseKbDoc);

    const BATCH = 10;
    const total = docs.length;
    let saved = 0;
    let failed = 0;
    for (let i = 0; i < total; i += BATCH) {
      const results = await Promise.allSettled(
        docs.slice(i, i + BATCH).map((doc) => {
          const { id, ...body } = doc;
          return saveDiseaseKbDoc(id, { ...body, searchText: diseaseSearchText(doc) });
        }),
      );
      saved  += results.filter((r) => r.status === "fulfilled").length;
      failed += results.filter((r) => r.status === "rejected").length;
      dispatchDbProgress(`Seeding disease KB… ${Math.min(i + BATCH, total)}/${total}${failed > 0 ? ` (${failed} errors)` : ""}`);
    }
    dispatchDbProgress(`Disease KB ready — ${saved}/${total} saved${failed > 0 ? `, ${failed} failed` : ""}`);
  } catch (e) {
    dispatchDbProgress(`Disease KB seed error: ${String(e)}`);
  }
}

export async function listDiseaseProfiles(): Promise<DiseaseKbDoc[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, d.*
     FROM \`_default\`.disease_kb AS d
     WHERE __deleted IS MISSING
     ORDER BY crop, disease
     LIMIT 1000`,
    {},
  );
  return rows as DiseaseKbDoc[];
}

/** Look up a single reference profile by its plantkb id, e.g. "tomato_late_blight". */
export async function getDiseaseProfile(id: string): Promise<DiseaseKbDoc | null> {
  const doc = await getDocument(COL_DISEASE_KB, id).catch((e: unknown) => {
    if (String(e).toLowerCase().includes("not found")) return null;
    throw e;
  });
  return doc ? ({ id, ...(doc as Omit<DiseaseKbDoc, "id">) } as DiseaseKbDoc) : null;
}

export async function searchDiseaseProfiles(query: string): Promise<DiseaseKbDoc[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, d.*
     FROM \`_default\`.disease_kb AS d
     WHERE MATCH(diseaseKbFts, $query) ORDER BY RANK(diseaseKbFts)`,
    { query },
  );
  return rows as DiseaseKbDoc[];
}

// ── Inspections ────────────────────────────────────────────────────────────

export async function listInspections(): Promise<InspectionRecord[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, createdAt, updatedAt, location, assetId, category, severity,
            notes, photoRef, detections, aiReport, synced
     FROM \`_default\`.inspections
     WHERE __deleted IS MISSING
     ORDER BY createdAt DESC
     LIMIT 500`,
    {},
  );
  return (rows as InspectionRecord[]).map((r) => ({ ...r, detections: r.detections ?? [] }));
}

export async function getInspection(id: string): Promise<InspectionRecord | null> {
  const doc = await getDocument(COL_INSPECTIONS, id)
    .catch((e: unknown) => {
      if (String(e).toLowerCase().includes("not found")) return null;
      throw e;
    });
  return doc ? { id, ...(doc as Omit<InspectionRecord, "id">) } : null;
}

export async function saveInspection(rec: InspectionRecord): Promise<void> {
  const { id, ...body } = rec;
  await saveDocument(COL_INSPECTIONS, id, body as Record<string, unknown>);
}

export async function deleteInspection(id: string): Promise<void> {
  await saveDocument(COL_INSPECTIONS, id, { __deleted: true });
}

export async function searchInspections(query: string): Promise<InspectionRecord[]> {
  try {
    const rows = await executeQuery(
      "N1QL",
      `SELECT META().id AS id, createdAt, updatedAt, location, assetId, category, severity,
              notes, photoRef, detections, aiReport, synced
       FROM _default.inspections
       WHERE MATCH(inspections.inspectionsFts, $query) AND __deleted IS MISSING
       LIMIT 100`,
      { query },
    );
    return rows as InspectionRecord[];
  } catch {
    return listInspections();
  }
}

// ── Clinical Notes ─────────────────────────────────────────────────────────

function hydrateClinicalNote(raw: Record<string, unknown>): ClinicalNote {
  const note = raw as unknown as ClinicalNote;
  if (typeof note.soapJson === "string" && note.soapJson) {
    try { note.soap = JSON.parse(note.soapJson); } catch { note.soap = null; }
  } else {
    note.soap = null;
  }
  return note;
}

export async function listClinicalNotes(): Promise<ClinicalNote[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, createdAt, updatedAt, patientRef, encounter, noteType,
            rawNotes, photoRef, soapJson, synced
     FROM \`_default\`.clinical
     WHERE __deleted IS MISSING
     ORDER BY createdAt DESC
     LIMIT 500`,
    {},
  );
  return (rows as Record<string, unknown>[]).map(hydrateClinicalNote);
}

/** Load one note including its embedding vector. */
export async function getClinicalNote(id: string): Promise<ClinicalNote | null> {
  const doc = await getDocument(COL_CLINICAL, id)
    .catch((e: unknown) => {
      if (String(e).toLowerCase().includes("not found")) return null;
      throw e;
    });
  return doc ? hydrateClinicalNote({ id, ...(doc as Record<string, unknown>) }) : null;
}

/** Fields that contain PHI — marked as CBL Encryptable for FLE on Tauri/EE. */
const CLINICAL_ENCRYPTED_FIELDS = ["rawNotes", "soapJson", "photoRef"];

export async function saveClinicalNote(note: ClinicalNote): Promise<void> {
  const { id, soap, ...rest } = note;
  // Serialise the structured SOAP object to a string so it can be field-encrypted.
  const body = { ...rest, soapJson: soap ? JSON.stringify(soap) : "" };
  await saveDocument(COL_CLINICAL, id, body as Record<string, unknown>, CLINICAL_ENCRYPTED_FIELDS);
}

export async function deleteClinicalNote(id: string): Promise<void> {
  await saveDocument(COL_CLINICAL, id, { __deleted: true });
}

export async function searchClinicalNotes(query: string): Promise<ClinicalNote[]> {
  try {
    const rows = await executeQuery(
      "N1QL",
      `SELECT META().id AS id, createdAt, updatedAt, patientRef, encounter, noteType,
              rawNotes, photoRef, soapJson, synced
       FROM _default.clinical
       WHERE MATCH(clinical.clinicalFts, $query) AND __deleted IS MISSING
       LIMIT 100`,
      { query },
    );
    return (rows as Record<string, unknown>[]).map(hydrateClinicalNote);
  } catch {
    return listClinicalNotes();
  }
}

/** Load all notes that have an embedding vector (for similarity search). */
export async function listClinicalNotesWithEmbeddings(): Promise<ClinicalNote[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, createdAt, patientRef, encounter, noteType, soapJson, embedding
     FROM \`_default\`.clinical
     WHERE __deleted IS MISSING AND embedding IS NOT MISSING
     LIMIT 500`,
    {},
  );
  return (rows as Record<string, unknown>[]).map(hydrateClinicalNote).filter((r) => r.embedding?.length);
}

// ── Photo Library ───────────────────────────────────────────────────────────

export async function savePhoto(photo: PhotoDoc): Promise<void> {
  const { id, ...rest } = photo;
  await saveDocument(COL_PHOTOS, id, rest as Record<string, unknown>);
}

export async function listPhotos(): Promise<PhotoDoc[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, createdAt, caption, labels, scores, photoRef, thumb, synced
     FROM \`_default\`.photos
     WHERE __deleted IS MISSING ORDER BY createdAt DESC`,
    {},
  );
  return (rows as unknown as PhotoDoc[]).map((r) => ({ ...r, embedding: [] }));
}

export async function listPhotosWithEmbeddings(): Promise<PhotoDoc[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, createdAt, caption, labels, scores, embedding, photoRef, thumb, synced
     FROM \`_default\`.photos
     WHERE __deleted IS MISSING AND embedding IS NOT MISSING
     LIMIT 500`,
    {},
  );
  return (rows as unknown as PhotoDoc[]).filter((r) => r.embedding?.length);
}

export async function getPhoto(id: string): Promise<PhotoDoc | null> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, createdAt, caption, labels, scores, embedding, faces, photoRef, thumb, synced
     FROM \`_default\`.photos WHERE META().id = $id`,
    { id },
  );
  return rows.length ? (rows[0] as unknown as PhotoDoc) : null;
}

export async function listPhotosWithFaces(): Promise<PhotoDoc[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, createdAt, caption, thumb, faces
     FROM \`_default\`.photos
     WHERE __deleted IS MISSING ORDER BY createdAt DESC`,
    {},
  );
  return (rows as unknown as PhotoDoc[]).map((r) => ({ ...r, labels: [], scores: [], embedding: [], photoRef: "", synced: false }));
}

export async function deletePhoto(id: string): Promise<void> {
  await saveDocument(COL_PHOTOS, id, { __deleted: true });
}

// ── People (face identity records) ─────────────────────────────────────────

export async function savePerson(person: PersonRecord): Promise<void> {
  const { id, ...rest } = person;
  await saveDocument(COL_PEOPLE, id, rest as Record<string, unknown>);
}

export async function listPeople(): Promise<PersonRecord[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, name, faceThumb, createdAt
     FROM \`_default\`.people WHERE __deleted IS MISSING ORDER BY name ASC`,
    {},
  );
  return rows as unknown as PersonRecord[];
}

export async function deletePerson(id: string): Promise<void> {
  await saveDocument(COL_PEOPLE, id, { __deleted: true });
}

export async function searchPhotos(query: string): Promise<PhotoDoc[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, createdAt, caption, labels, scores, photoRef, thumb, synced
     FROM \`_default\`.photos
     WHERE MATCH(photosFts, $query) ORDER BY RANK(photosFts)`,
    { query },
  );
  return (rows as unknown as PhotoDoc[]).map((r) => ({ ...r, embedding: [] }));
}

// ── Dataset Annotations ────────────────────────────────────────────────────

export async function saveAnnotation(rec: AnnotationRecord): Promise<void> {
  const { id, ...rest } = rec;
  await saveDocument(COL_ANNOTATIONS, id, rest as Record<string, unknown>);
}

export async function listAnnotations(status?: string): Promise<AnnotationRecord[]> {
  const where = status
    ? "WHERE __deleted IS MISSING AND status = $status ORDER BY createdAt DESC"
    : "WHERE __deleted IS MISSING ORDER BY createdAt DESC";
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, createdAt, updatedAt, imageRef, thumb, labels, boxes, status, annotatorId, synced
     FROM \`_default\`.annotations ${where}`,
    status ? { status } : {},
  );
  return (rows as unknown as AnnotationRecord[]).map((r) => ({ ...r, embedding: [] }));
}

export async function listAnnotationsWithEmbeddings(): Promise<AnnotationRecord[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, createdAt, thumb, labels, status, embedding
     FROM \`_default\`.annotations
     WHERE __deleted IS MISSING AND embedding IS NOT MISSING LIMIT 500`,
    {},
  );
  return rows as unknown as AnnotationRecord[];
}

export async function deleteAnnotation(id: string): Promise<void> {
  await saveDocument(COL_ANNOTATIONS, id, { __deleted: true });
}

export async function searchAnnotations(query: string): Promise<AnnotationRecord[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, createdAt, updatedAt, imageRef, thumb, labels, boxes, status, annotatorId, synced
     FROM \`_default\`.annotations
     WHERE MATCH(annotationsFts, $query) ORDER BY RANK(annotationsFts)`,
    { query },
  );
  return (rows as unknown as AnnotationRecord[]).map((r) => ({ ...r, embedding: [] }));
}

// ── Crop Disease ──────────────────────────────────────────────────────────────

export async function listCropDiseases(): Promise<CropDiseaseRecord[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, createdAt, updatedAt, photoRef, cropType, location, notes, leaves, synced
     FROM \`_default\`.crop_disease
     WHERE __deleted IS MISSING
     ORDER BY createdAt DESC
     LIMIT 500`,
    {},
  );
  return rows as CropDiseaseRecord[];
}

export async function getCropDisease(id: string): Promise<CropDiseaseRecord | null> {
  const doc = await getDocument(COL_CROP_DISEASE, id).catch((e: unknown) => {
    if (String(e).toLowerCase().includes("not found")) return null;
    throw e;
  });
  return doc ? { id, ...(doc as Omit<CropDiseaseRecord, "id">) } : null;
}

export async function saveCropDisease(rec: CropDiseaseRecord): Promise<void> {
  const { id, ...body } = rec;
  await saveDocument(COL_CROP_DISEASE, id, body as Record<string, unknown>);
}

export async function deleteCropDisease(id: string): Promise<void> {
  await saveDocument(COL_CROP_DISEASE, id, { __deleted: true });
}

export async function searchCropDiseases(query: string): Promise<CropDiseaseRecord[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, createdAt, updatedAt, photoRef, cropType, location, notes, leaves, synced
     FROM \`_default\`.crop_disease
     WHERE MATCH(cropDiseaseFts, $query) ORDER BY RANK(cropDiseaseFts)`,
    { query },
  );
  return rows as CropDiseaseRecord[];
}
