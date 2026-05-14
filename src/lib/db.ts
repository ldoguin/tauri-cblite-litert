/**
 * db.ts — Storage layer with two backends:
 *
 *   Tauri (desktop / Android): CouchbaseLite via tauri-plugin-cblite
 *   Web:                       localStorage-backed in-memory store
 *
 * The web backend mirrors the CouchbaseLite API surface so the rest of the
 * app is unaware of which backend is active.
 */

import type {
  Conversation,
  Message,
  KnowledgeChunk,
  ModelConfig,
  Agent,
} from "./types";
import { DEFAULT_MODEL_CONFIG } from "./types";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const COL_CONVERSATIONS = "_default.conversations";
const COL_MESSAGES      = "_default.messages";
const COL_KNOWLEDGE     = "_default.knowledge";
const COL_CONFIG        = "_default.config";
const COL_AGENTS        = "_default.agents";

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
 * Save a base64 data URL as a CBL blob on Tauri.
 * Returns a reference string "cbl-blob:<digest>:<mimeType>" for storage.
 * On web, returns the original data URL unchanged.
 */
export async function saveImageAsBlob(dataUrl: string): Promise<string> {
  if (!isTauri()) return dataUrl;
  // Extract mime type and raw base64 from "data:<mime>;base64,<data>"
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) return dataUrl; // not a valid data URL — store as-is
  const [, mimeType, dataB64] = match;
  const { saveBlob } = await import("tauri-plugin-cblite");
  const digest = await saveBlob(dataB64, mimeType);
  return `${CBL_BLOB_PREFIX}${digest}:${mimeType}`;
}

/**
 * Resolve a stored image field back to a data URL.
 * If the value is a CBL blob reference, fetches the bytes from the plugin.
 * If it's already a data URL (web path), returns it unchanged.
 * Returns null if the blob cannot be loaded.
 */
export async function loadImageFromBlob(stored: string): Promise<string | null> {
  if (!stored.startsWith(CBL_BLOB_PREFIX)) return stored; // plain data URL
  if (!isTauri()) return null; // blob refs only exist on Tauri
  // Parse "cbl-blob:<digest>:<mimeType>"
  const rest = stored.slice(CBL_BLOB_PREFIX.length);
  const colonIdx = rest.indexOf(":");
  if (colonIdx === -1) return null;
  const digest = rest.slice(0, colonIdx);
  const mimeType = rest.slice(colonIdx + 1);
  try {
    const { getBlobData } = await import("tauri-plugin-cblite");
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

const DB_SCHEMA_VERSION = 1;
const SCHEMA_VERSION_DOC = "schema-version";

async function runMigrations(): Promise<void> {
  // Read current version (0 = fresh database)
  let currentVersion = 0;
  if (!isTauri()) {
    const doc = webStore.get(COL_CONFIG, SCHEMA_VERSION_DOC);
    currentVersion = typeof doc?.version === "number" ? doc.version : 0;
  } else {
    const { getDocument } = await import("tauri-plugin-cblite");
    // CouchbaseLite returns a "not found" error for missing documents rather
    // than null — treat it as version 0 (fresh database).
    const doc = await getDocument(COL_CONFIG, SCHEMA_VERSION_DOC)
      .catch((e: unknown) => {
        if (String(e).toLowerCase().includes("not found")) return null;
        throw e;
      }) as { version?: number } | null;
    currentVersion = doc?.version ?? 0;
  }

  if (currentVersion >= DB_SCHEMA_VERSION) return;

  // ── Migration v0 → v1 ────────────────────────────────────────────────────
  // Initial schema — nothing to migrate; just stamp the version.
  // Add future migrations as: if (currentVersion < N) { ... currentVersion = N; }

  // Persist the new version
  if (!isTauri()) {
    webStore.set(COL_CONFIG, SCHEMA_VERSION_DOC, { version: DB_SCHEMA_VERSION });
  } else {
    const { saveDocument } = await import("tauri-plugin-cblite");
    await saveDocument(COL_CONFIG, SCHEMA_VERSION_DOC, { version: DB_SCHEMA_VERSION });
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

export async function initDatabase(dbDir: string): Promise<void> {
  if (!isTauri()) {
    webStore.load();
    await runMigrations();
    return;
  }
  const { openDatabase } = await import("tauri-plugin-cblite");
  await openDatabase(dbDir, "rag-chatbot", undefined, [
    COL_CONVERSATIONS, COL_MESSAGES, COL_KNOWLEDGE, COL_CONFIG, COL_AGENTS,
  ]);
  await runMigrations();
}

export async function shutdownDatabase(): Promise<void> {
  if (!isTauri()) return;
  const { closeDatabase } = await import("tauri-plugin-cblite");
  await closeDatabase();
}

// ── Config ─────────────────────────────────────────────────────────────────

export async function loadConfig(): Promise<ModelConfig> {
  if (!isTauri()) {
    const doc = webStore.get(COL_CONFIG, "app-config");
    return doc ? { ...DEFAULT_MODEL_CONFIG, ...(doc as Partial<ModelConfig>) } : { ...DEFAULT_MODEL_CONFIG };
  }
  const { getDocument } = await import("tauri-plugin-cblite");
  const doc = await getDocument(COL_CONFIG, "app-config")
    .catch((e: unknown) => {
      if (String(e).toLowerCase().includes("not found")) return null;
      throw e;
    });
  if (!doc) return { ...DEFAULT_MODEL_CONFIG };
  const { _id: _unused, ...rest } = doc as Record<string, unknown>;
  return { ...DEFAULT_MODEL_CONFIG, ...(rest as Partial<ModelConfig>) };
}

export async function saveConfig(config: ModelConfig): Promise<void> {
  if (!isTauri()) {
    webStore.set(COL_CONFIG, "app-config", config as unknown as Record<string, unknown>);
    return;
  }
  const { saveDocument } = await import("tauri-plugin-cblite");
  await saveDocument(COL_CONFIG, "app-config", config as unknown as Record<string, unknown>);
}

// ── Conversations ──────────────────────────────────────────────────────────

export async function listConversations(limit = 200, offset = 0): Promise<Conversation[]> {
  if (!isTauri()) {
    return (webStore.list(COL_CONVERSATIONS) as unknown as Conversation[])
      .filter((c) => !(c as unknown as Record<string, unknown>)["_deleted"])
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(offset, offset + limit);
  }
  const { executeQuery } = await import("tauri-plugin-cblite");
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, title, createdAt, updatedAt, systemInstruction
     FROM \`_default\`.conversations
     WHERE (_deleted IS MISSING OR _deleted = false)
     ORDER BY updatedAt DESC
     LIMIT $limit OFFSET $offset`,
    { limit, offset },
  );
  return rows as Conversation[];
}

export async function getConversation(id: string): Promise<Conversation | null> {
  if (!isTauri()) {
    const doc = webStore.get(COL_CONVERSATIONS, id);
    return doc ? ({ id, ...doc } as Conversation) : null;
  }
  const { getDocument } = await import("tauri-plugin-cblite");
  const doc = await getDocument(COL_CONVERSATIONS, id)
    .catch((e: unknown) => {
      if (String(e).toLowerCase().includes("not found")) return null;
      throw e;
    });
  return doc ? { id, ...(doc as Omit<Conversation, "id">) } : null;
}

export async function saveConversation(conv: Conversation): Promise<void> {
  const { id, ...body } = conv;
  if (!isTauri()) { webStore.set(COL_CONVERSATIONS, id, body as Record<string, unknown>); return; }
  const { saveDocument } = await import("tauri-plugin-cblite");
  await saveDocument(COL_CONVERSATIONS, id, body as Record<string, unknown>);
}

export async function deleteConversation(id: string): Promise<void> {
  bumpRagPoolVersion();
  if (!isTauri()) {
    // Web: delete all messages (including chunks) then the conversation doc.
    const all = webStore.list(COL_MESSAGES) as unknown as Message[];
    for (const m of all) {
      if (m.conversationId === id) webStore.delete(COL_MESSAGES, m.id);
    }
    webStore.delete(COL_CONVERSATIONS, id);
    return;
  }
  // Tauri: soft-delete messages (tombstones) then the conversation document.
  // Soft-delete matches the conversation document pattern and ensures
  // deletions replicate correctly as tombstones if sync is ever enabled.
  const { executeQuery, saveDocument } = await import("tauri-plugin-cblite");
  // Fetch message IDs first, then soft-delete each one so CouchbaseLite
  // creates proper tombstone documents for sync replication.
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id FROM \`_default\`.messages WHERE conversationId = $cid`,
    { cid: id },
  ) as Array<{ id: string }>;
  await Promise.all(rows.map((r) => saveDocument(COL_MESSAGES, r.id, { _deleted: true })));
  await saveDocument(COL_CONVERSATIONS, id, { _deleted: true });
}

// ── Messages ───────────────────────────────────────────────────────────────

// Default raised from 500 to 10k — 500 silently truncated LLM history and
// the context-window bar for long conversations. 10k covers realistic usage
// while still bounding memory for pathological cases.
export async function listMessages(conversationId: string, limit = 10_000, offset = 0): Promise<Message[]> {
  if (!isTauri()) {
    return (webStore.list(COL_MESSAGES) as unknown as Message[])
      .filter((m) => m.conversationId === conversationId && !m.isChunk)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(offset, offset + limit);
  }
  const { executeQuery } = await import("tauri-plugin-cblite");
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, conversationId, role, content, createdAt, latencyMs,
            ragSourceIds, embedding, bookmarked, stopped, imageDataUrl, chunkIds, isChunk
     FROM \`_default\`.messages
     WHERE conversationId = $cid AND (isChunk IS MISSING OR isChunk = false)
     ORDER BY createdAt ASC
     LIMIT $limit OFFSET $offset`,
    { cid: conversationId, limit, offset },
  );
  return rows as Message[];
}

export async function saveMessage(msg: Message): Promise<void> {
  const { id, ...body } = msg;
  bumpRagPoolVersion();
  if (!isTauri()) { webStore.set(COL_MESSAGES, id, body as Record<string, unknown>); return; }
  const { saveDocument } = await import("tauri-plugin-cblite");
  await saveDocument(COL_MESSAGES, id, body as Record<string, unknown>);
}

/** Returns all bookmarked messages across all conversations, newest first. */
export async function listBookmarkedMessages(limit = 500): Promise<Message[]> {
  if (!isTauri()) {
    return (webStore.list(COL_MESSAGES) as unknown as Message[])
      .filter((m) => m.bookmarked === true && !m.isChunk)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
  const { executeQuery } = await import("tauri-plugin-cblite");
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, conversationId, role, content, createdAt, latencyMs, ragSourceIds, bookmarked, stopped
     FROM \`_default\`.messages
     WHERE bookmarked = true AND (isChunk IS MISSING OR isChunk = false)
     ORDER BY createdAt DESC
     LIMIT $limit`,
    { limit },
  );
  return rows as Message[];
}

export async function deleteMessage(id: string): Promise<void> {
  bumpRagPoolVersion();
  if (!isTauri()) {
    // Cascade-delete any chunk siblings stored on the parent document
    const parent = webStore.get(COL_MESSAGES, id) as { chunkIds?: string[] } | null;
    if (parent?.chunkIds?.length) {
      for (const cid of parent.chunkIds) webStore.delete(COL_MESSAGES, cid);
    }
    webStore.delete(COL_MESSAGES, id);
    return;
  }
  const { getDocument, saveDocument } = await import("tauri-plugin-cblite");
  // Cascade-delete chunk siblings before removing the parent
  const parent = await getDocument(COL_MESSAGES, id)
    .catch((e: unknown) => {
      if (String(e).toLowerCase().includes("not found")) return null;
      throw e;
    }) as { chunkIds?: string[] } | null;
  if (parent?.chunkIds?.length) {
    await Promise.all(
      parent.chunkIds.map((cid) => saveDocument(COL_MESSAGES, cid, { _deleted: true })),
    );
  }
  await saveDocument(COL_MESSAGES, id, { _deleted: true });
}

// ── Knowledge base ─────────────────────────────────────────────────────────

export async function saveKnowledgeChunk(chunk: KnowledgeChunk): Promise<void> {
  const { id, ...body } = chunk;
  bumpRagPoolVersion();
  if (!isTauri()) { webStore.set(COL_KNOWLEDGE, id, body as Record<string, unknown>); return; }
  const { saveDocument } = await import("tauri-plugin-cblite");
  await saveDocument(COL_KNOWLEDGE, id, body as Record<string, unknown>);
}

export async function listKnowledgeChunks(limit = 2000, offset = 0): Promise<KnowledgeChunk[]> {
  if (!isTauri()) {
    return (webStore.list(COL_KNOWLEDGE) as unknown as KnowledgeChunk[])
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(offset, offset + limit);
  }
  const { executeQuery } = await import("tauri-plugin-cblite");
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, source, text, embedding, createdAt
     FROM \`_default\`.knowledge
     ORDER BY createdAt DESC
     LIMIT $limit OFFSET $offset`,
    { limit, offset },
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
  if (!isTauri()) {
    return (webStore.list(COL_MESSAGES) as unknown as Message[])
      .filter((m) => m.embedding && m.embedding.length > 0 && !m.isChunk)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
  const { executeQuery } = await import("tauri-plugin-cblite");
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, conversationId, role, content, createdAt, embedding
     FROM \`_default\`.messages
     WHERE embedding IS NOT MISSING AND (isChunk IS MISSING OR isChunk = false)
     ORDER BY createdAt DESC
     LIMIT $limit`,
    { limit },
  );
  return rows as Message[];
}

/** Fetch specific knowledge chunks by their IDs (for RAG source viewer). */
export async function getKnowledgeChunksByIds(ids: string[]): Promise<KnowledgeChunk[]> {
  if (ids.length === 0) return [];
  if (!isTauri()) {
    return ids
      .map((id) => {
        const doc = webStore.get(COL_KNOWLEDGE, id);
        return doc ? ({ id, ...doc } as KnowledgeChunk) : null;
      })
      .filter(Boolean) as KnowledgeChunk[];
  }
  const { executeQuery } = await import("tauri-plugin-cblite");
  const placeholders = ids.map((_, i) => `$id${i}`).join(", ");
  const params = Object.fromEntries(ids.map((id, i) => [`id${i}`, id]));
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, source, text, createdAt FROM \`_default\`.knowledge WHERE META().id IN [${placeholders}]`,
    params,
  );
  return rows as KnowledgeChunk[];
}

/** Fetch specific messages by their IDs (for RAG source viewer). */
export async function getMessagesByIds(ids: string[]): Promise<Message[]> {
  if (ids.length === 0) return [];
  if (!isTauri()) {
    return ids
      .map((id) => {
        const doc = webStore.get(COL_MESSAGES, id);
        return doc ? ({ id, ...doc } as Message) : null;
      })
      .filter((m): m is Message => m !== null && !m.isChunk);
  }
  const { executeQuery } = await import("tauri-plugin-cblite");
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
  if (!isTauri()) { webStore.delete(COL_KNOWLEDGE, id); return; }
  const { saveDocument } = await import("tauri-plugin-cblite");
  await saveDocument(COL_KNOWLEDGE, id, { _deleted: true });
}

/** Delete all chunks whose source label matches exactly. */
export async function deleteKnowledgeBySource(source: string): Promise<void> {
  bumpRagPoolVersion();
  if (!isTauri()) {
    const all = webStore.list(COL_KNOWLEDGE) as unknown as KnowledgeChunk[];
    for (const c of all) {
      if (c.source === source) webStore.delete(COL_KNOWLEDGE, c.id);
    }
    return;
  }
  // Single N1QL DELETE — handles any number of chunks regardless of the
  // listKnowledgeChunks() pagination limit.
  const { executeQuery } = await import("tauri-plugin-cblite");
  await executeQuery(
    "N1QL",
    `DELETE FROM \`_default\`.knowledge WHERE source = $source`,
    { source },
  );
}

// ── Agents ─────────────────────────────────────────────────────────────────

export async function listAgents(): Promise<Agent[]> {
  if (!isTauri()) {
    return (webStore.list(COL_AGENTS) as unknown as Agent[])
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const { executeQuery } = await import("tauri-plugin-cblite");
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, name, systemPrompt, description, createdAt, updatedAt
     FROM \`_default\`.agents ORDER BY name ASC`,
  );
  return rows as Agent[];
}

export async function saveAgent(agent: Agent): Promise<void> {
  const { id, ...body } = agent;
  if (!isTauri()) { webStore.set(COL_AGENTS, id, body as Record<string, unknown>); return; }
  const { saveDocument } = await import("tauri-plugin-cblite");
  await saveDocument(COL_AGENTS, id, body as Record<string, unknown>);
}

export async function deleteAgent(id: string): Promise<void> {
  if (!isTauri()) { webStore.delete(COL_AGENTS, id); return; }
  const { saveDocument } = await import("tauri-plugin-cblite");
  await saveDocument(COL_AGENTS, id, { _deleted: true });
}

// ── Web store (localStorage-backed) ───────────────────────────────────────

const LS_KEY = "rag-chatbot:store";
type CollectionMap = Record<string, Record<string, Record<string, unknown>>>;

const webStore = {
  data: {} as CollectionMap,
  _saveTimer: null as ReturnType<typeof setTimeout> | null,

  load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      this.data = raw ? JSON.parse(raw) : {};
    } catch { this.data = {}; }
  },

  /** Persist immediately. */
  save() {
    if (this._saveTimer !== null) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    try { localStorage.setItem(LS_KEY, JSON.stringify(this.data)); }
    catch (e) {
      // QuotaExceededError — data is still in memory but won't survive a reload.
      if (
        e instanceof DOMException &&
        (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED")
      ) {
        console.warn(
          "[db] localStorage quota exceeded — data is in memory only and will be lost on reload. " +
          "Delete old conversations or knowledge chunks to free space.",
        );
        // Dispatch a custom event so the UI can surface a warning banner.
        window.dispatchEvent(new CustomEvent("rag-chatbot:storage-full"));
      }
    }
  },

  /**
   * Persist after a short debounce. Multiple rapid writes (e.g. during
   * re-embed) coalesce into a single serialization instead of one per item.
   */
  scheduleSave() {
    if (this._saveTimer !== null) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save();
    }, 200);
  },

  get(col: string, id: string): Record<string, unknown> | null {
    return this.data[col]?.[id] ?? null;
  },

  set(col: string, id: string, body: Record<string, unknown>) {
    if (!this.data[col]) this.data[col] = {};
    this.data[col][id] = body;
    this.scheduleSave();
  },

  delete(col: string, id: string) {
    delete this.data[col]?.[id];
    this.scheduleSave();
  },

  list(col: string): Array<Record<string, unknown>> {
    return Object.entries(this.data[col] ?? {}).map(([id, body]) => ({ id, ...body }));
  },

  /** Flush any pending debounced save immediately. */
  flush() { this.save(); },
};

// Flush on page unload so the debounce timer never silently drops writes.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => webStore.flush());
}
