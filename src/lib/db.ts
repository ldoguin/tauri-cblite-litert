/**
 * db.ts — CouchbaseLite persistence layer.
 *
 * Collections:
 *   _default.conversations  — Conversation metadata
 *   _default.messages       — Chat messages
 *   _default.knowledge      — RAG knowledge chunks (text + embedding)
 *   _default.config         — App configuration (single doc: "app-config")
 */

import {
  openDatabase,
  closeDatabase,
  getDocument,
  saveDocument,
  executeQuery,
} from "tauri-plugin-cblite";
import type {
  Conversation,
  Message,
  KnowledgeChunk,
  ModelConfig,
} from "./types";
import { DEFAULT_MODEL_CONFIG } from "./types";

// ── Collections ────────────────────────────────────────────────────────────

const COL_CONVERSATIONS = "_default.conversations";
const COL_MESSAGES = "_default.messages";
const COL_KNOWLEDGE = "_default.knowledge";
const COL_CONFIG = "_default.config";

// ── Lifecycle ──────────────────────────────────────────────────────────────

/** Opens (or creates) the application database. */
export async function initDatabase(dbDir: string): Promise<void> {
  await openDatabase(dbDir, "rag-chatbot", undefined, [
    COL_CONVERSATIONS,
    COL_MESSAGES,
    COL_KNOWLEDGE,
    COL_CONFIG,
  ]);
}

export async function shutdownDatabase(): Promise<void> {
  await closeDatabase();
}

// ── Config ─────────────────────────────────────────────────────────────────

export async function loadConfig(): Promise<ModelConfig> {
  const doc = await getDocument(COL_CONFIG, "app-config");
  if (!doc) return { ...DEFAULT_MODEL_CONFIG };
  const { _id: _unused, ...rest } = doc as Record<string, unknown>;
  return { ...DEFAULT_MODEL_CONFIG, ...(rest as Partial<ModelConfig>) };
}

export async function saveConfig(config: ModelConfig): Promise<void> {
  await saveDocument(COL_CONFIG, "app-config", config as unknown as Record<string, unknown>);
}

// ── Conversations ──────────────────────────────────────────────────────────

export async function listConversations(): Promise<Conversation[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, title, createdAt, updatedAt, systemInstruction
     FROM \`_default\`.conversations
     ORDER BY updatedAt DESC`,
  );
  return rows as Conversation[];
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const doc = await getDocument(COL_CONVERSATIONS, id);
  if (!doc) return null;
  return { id, ...(doc as Omit<Conversation, "id">) };
}

export async function saveConversation(conv: Conversation): Promise<void> {
  const { id, ...body } = conv;
  await saveDocument(COL_CONVERSATIONS, id, body as Record<string, unknown>);
}

export async function deleteConversation(id: string): Promise<void> {
  // Mark as deleted — CouchbaseLite soft-deletes via a tombstone.
  await saveDocument(COL_CONVERSATIONS, id, { _deleted: true });
}

// ── Messages ───────────────────────────────────────────────────────────────

export async function listMessages(conversationId: string): Promise<Message[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, conversationId, role, content, createdAt, latencyMs, ragSourceIds
     FROM \`_default\`.messages
     WHERE conversationId = $cid
     ORDER BY createdAt ASC`,
    { cid: conversationId },
  );
  return rows as Message[];
}

export async function saveMessage(msg: Message): Promise<void> {
  const { id, ...body } = msg;
  await saveDocument(COL_MESSAGES, id, body as Record<string, unknown>);
}

// ── Knowledge base ─────────────────────────────────────────────────────────

export async function saveKnowledgeChunk(chunk: KnowledgeChunk): Promise<void> {
  const { id, ...body } = chunk;
  await saveDocument(COL_KNOWLEDGE, id, body as Record<string, unknown>);
}

export async function listKnowledgeChunks(): Promise<KnowledgeChunk[]> {
  const rows = await executeQuery(
    "N1QL",
    `SELECT META().id AS id, source, text, embedding, createdAt
     FROM \`_default\`.knowledge
     ORDER BY createdAt DESC`,
  );
  return rows as KnowledgeChunk[];
}

export async function deleteKnowledgeChunk(id: string): Promise<void> {
  await saveDocument(COL_KNOWLEDGE, id, { _deleted: true });
}

export async function clearKnowledgeBase(): Promise<void> {
  const chunks = await listKnowledgeChunks();
  await Promise.all(chunks.map((c) => deleteKnowledgeChunk(c.id)));
}
