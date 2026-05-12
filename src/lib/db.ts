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
} from "./types";
import { DEFAULT_MODEL_CONFIG } from "./types";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const COL_CONVERSATIONS = "_default.conversations";
const COL_MESSAGES      = "_default.messages";
const COL_KNOWLEDGE     = "_default.knowledge";
const COL_CONFIG        = "_default.config";

// ── Lifecycle ──────────────────────────────────────────────────────────────

export async function initDatabase(dbDir: string): Promise<void> {
  if (!isTauri()) { webStore.load(); return; }
  const { openDatabase } = await import("tauri-plugin-cblite");
  await openDatabase(dbDir, "rag-chatbot", undefined, [
    COL_CONVERSATIONS, COL_MESSAGES, COL_KNOWLEDGE, COL_CONFIG,
  ]);
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
  const doc = await getDocument(COL_CONFIG, "app-config");
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

export async function listConversations(): Promise<Conversation[]> {
  if (!isTauri()) {
    return (webStore.list(COL_CONVERSATIONS) as unknown as Conversation[])
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  const { executeQuery } = await import("tauri-plugin-cblite");
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, title, createdAt, updatedAt, systemInstruction
     FROM \`_default\`.conversations ORDER BY updatedAt DESC`,
  );
  return rows as Conversation[];
}

export async function getConversation(id: string): Promise<Conversation | null> {
  if (!isTauri()) {
    const doc = webStore.get(COL_CONVERSATIONS, id);
    return doc ? ({ id, ...doc } as Conversation) : null;
  }
  const { getDocument } = await import("tauri-plugin-cblite");
  const doc = await getDocument(COL_CONVERSATIONS, id);
  return doc ? { id, ...(doc as Omit<Conversation, "id">) } : null;
}

export async function saveConversation(conv: Conversation): Promise<void> {
  const { id, ...body } = conv;
  if (!isTauri()) { webStore.set(COL_CONVERSATIONS, id, body as Record<string, unknown>); return; }
  const { saveDocument } = await import("tauri-plugin-cblite");
  await saveDocument(COL_CONVERSATIONS, id, body as Record<string, unknown>);
}

export async function deleteConversation(id: string): Promise<void> {
  if (!isTauri()) { webStore.delete(COL_CONVERSATIONS, id); return; }
  const { saveDocument } = await import("tauri-plugin-cblite");
  await saveDocument(COL_CONVERSATIONS, id, { _deleted: true });
}

// ── Messages ───────────────────────────────────────────────────────────────

export async function listMessages(conversationId: string): Promise<Message[]> {
  if (!isTauri()) {
    return (webStore.list(COL_MESSAGES) as unknown as Message[])
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  const { executeQuery } = await import("tauri-plugin-cblite");
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, conversationId, role, content, createdAt, latencyMs, ragSourceIds, embedding
     FROM \`_default\`.messages WHERE conversationId = $cid ORDER BY createdAt ASC`,
    { cid: conversationId },
  );
  return rows as Message[];
}

export async function saveMessage(msg: Message): Promise<void> {
  const { id, ...body } = msg;
  if (!isTauri()) { webStore.set(COL_MESSAGES, id, body as Record<string, unknown>); return; }
  const { saveDocument } = await import("tauri-plugin-cblite");
  await saveDocument(COL_MESSAGES, id, body as Record<string, unknown>);
}

// ── Knowledge base ─────────────────────────────────────────────────────────

export async function saveKnowledgeChunk(chunk: KnowledgeChunk): Promise<void> {
  const { id, ...body } = chunk;
  if (!isTauri()) { webStore.set(COL_KNOWLEDGE, id, body as Record<string, unknown>); return; }
  const { saveDocument } = await import("tauri-plugin-cblite");
  await saveDocument(COL_KNOWLEDGE, id, body as Record<string, unknown>);
}

export async function listKnowledgeChunks(): Promise<KnowledgeChunk[]> {
  if (!isTauri()) {
    return (webStore.list(COL_KNOWLEDGE) as unknown as KnowledgeChunk[])
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  const { executeQuery } = await import("tauri-plugin-cblite");
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, source, text, embedding, createdAt
     FROM \`_default\`.knowledge ORDER BY createdAt DESC`,
  );
  return rows as KnowledgeChunk[];
}

/**
 * Returns all messages that have been vectorised (embedding field present),
 * across all conversations. Used by the RAG retrieval path so that past
 * conversation turns are searchable alongside knowledge-base chunks.
 */
export async function listEmbeddedMessages(): Promise<Message[]> {
  if (!isTauri()) {
    return (webStore.list(COL_MESSAGES) as unknown as Message[])
      .filter((m) => m.embedding && m.embedding.length > 0);
  }
  const { executeQuery } = await import("tauri-plugin-cblite");
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, conversationId, role, content, createdAt, embedding
     FROM \`_default\`.messages
     WHERE embedding IS NOT MISSING
     ORDER BY createdAt DESC`,
  );
  return rows as Message[];
}

export async function deleteKnowledgeChunk(id: string): Promise<void> {
  if (!isTauri()) { webStore.delete(COL_KNOWLEDGE, id); return; }
  const { saveDocument } = await import("tauri-plugin-cblite");
  await saveDocument(COL_KNOWLEDGE, id, { _deleted: true });
}

// ── Web store (localStorage-backed) ───────────────────────────────────────

const LS_KEY = "rag-chatbot:store";
type CollectionMap = Record<string, Record<string, Record<string, unknown>>>;

const webStore = {
  data: {} as CollectionMap,

  load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      this.data = raw ? JSON.parse(raw) : {};
    } catch { this.data = {}; }
  },

  save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(this.data)); }
    catch { /* storage full — continue in-memory */ }
  },

  get(col: string, id: string): Record<string, unknown> | null {
    return this.data[col]?.[id] ?? null;
  },

  set(col: string, id: string, body: Record<string, unknown>) {
    if (!this.data[col]) this.data[col] = {};
    this.data[col][id] = body;
    this.save();
  },

  delete(col: string, id: string) {
    delete this.data[col]?.[id];
    this.save();
  },

  list(col: string): Array<Record<string, unknown>> {
    return Object.entries(this.data[col] ?? {}).map(([id, body]) => ({ id, ...body }));
  },
};
