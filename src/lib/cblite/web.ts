/**
 * Web adapter for @cblite.
 *
 * Implements the same interface as tauri-plugin-cblite, backed by
 * @couchbase/lite-js (https://docs.couchbase.com/couchbase-lite-javascript/).
 *
 * This file is what the @cblite Vite alias resolves to when building the
 * web (browser) target.  The Tauri target resolves to src/lib/cblite/tauri.ts.
 *
 * Notes:
 * - createFtsIndex / listIndexes are not yet exposed by the JS SDK; they are
 *   no-ops here.  FTS queries fall back to N1QL LIKE in db.ts.
 * - registerPredictiveModel / unregisterPredictiveModel are not supported in
 *   the browser; calls are silently ignored.
 */

import {
  Database,
  Replicator,
  DocID,
  NewBlob,
  LastWriteWins,
} from "@couchbase/lite-js";

// ── Module-level state ────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let replicator: any = null;
let _replicationStatusHandler: ((activity: string, error?: string) => void) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const activeListenerTokens: any[] = [];

const NAMED_COLLECTIONS = [
  "conversations", "messages", "knowledge", "config",
  "agents", "pdfs", "products", "inspections", "clinical",
  "photos", "people", "annotations", "sync_config",
  "crop_disease", "disease_kb", "blobs",
] as const;

function resolveCollectionName(name: string): string {
  return name.replace(/^_default\./, "");
}

// ── Public constants ──────────────────────────────────────────────────────────

export const COLLECTION_CHANGED_EVENT = "cblite://collection-changed";
export const REPLICATION_STATUS_EVENT  = "cblite://replication-status";

// ── openDatabase ──────────────────────────────────────────────────────────────

export async function openDatabase(
  _path: string,
  name: string,
  _encryptionPassword?: string,
  _collections?: string[],
): Promise<void> {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
  }
  const collectionsConfig = Object.fromEntries(
    NAMED_COLLECTIONS.map((c) => [c, {}]),
  );
  db = await Database.open({ name, version: 1, collections: collectionsConfig });
}

// ── closeDatabase ─────────────────────────────────────────────────────────────

export async function closeDatabase(): Promise<void> {
  if (!db) return;
  for (const token of activeListenerTokens) {
    try { token.remove(); } catch { /* ignore */ }
  }
  activeListenerTokens.length = 0;
  _replicationStatusHandler = null;
  if (replicator) {
    try { replicator.stop(); } catch { /* ignore */ }
    replicator = null;
  }
  try { db.close(); } catch { /* ignore */ }
  db = null;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function requireDb(): any {
  if (!db) throw new Error("[cblite-web] Database is not open");
  return db;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getCollection(collectionName: string): any {
  return requireDb().getCollection(resolveCollectionName(collectionName));
}

// ── getDocument ───────────────────────────────────────────────────────────────

export async function getDocument(
  collection: string,
  docId: string,
): Promise<unknown> {
  const coll = getCollection(collection);
  const doc = await coll.getDocument(DocID(docId));
  if (!doc) throw new Error(`Document not found: ${docId}`);
  // Spread all enumerable properties into a plain object
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { id: docId, ...Object.fromEntries(Object.keys(doc).map((k: string) => [k, (doc as any)[k]])) };
}

// ── saveDocument ──────────────────────────────────────────────────────────────

export async function saveDocument(
  collection: string,
  docId: string,
  body: unknown,
  _encryptedFields?: string[],
): Promise<void> {
  const coll = getCollection(collection);
  const data = body as Record<string, unknown>;
  const existing = await coll.getDocument(DocID(docId));
  if (existing) {
    for (const [k, v] of Object.entries(data)) existing[k] = v;
    await coll.save(existing, LastWriteWins);
  } else {
    const doc = coll.createDocument(DocID(docId), data);
    await coll.save(doc);
  }
}

// ── executeQuery ──────────────────────────────────────────────────────────────

export async function executeQuery(
  _language: "N1QL" | "JSON",
  queryStr: string,
  parameters?: Record<string, unknown>,
): Promise<unknown[]> {
  const database = requireDb();
  // Strip scope prefix used by the Tauri plugin convention
  const normalized = queryStr
    .replace(/FROM\s+`_default`\./gi, "FROM ")
    .replace(/FROM\s+_default\./gi, "FROM ");
  const query = database.createQuery(normalized);
  if (parameters) {
    for (const [k, v] of Object.entries(parameters)) query[k] = v;
  }
  const results = await query.execute();
  // Collect async iterable into array
  if (results && Symbol.asyncIterator in results) {
    const rows: unknown[] = [];
    for await (const row of results) rows.push(row);
    return rows;
  }
  return Array.isArray(results) ? results : [];
}

// ── startReplication ──────────────────────────────────────────────────────────

export async function startReplication(
  url: string,
  collection: string,
  direction: "push" | "pull" | "both",
  auth?: { username: string; password: string } | { sessionId: string; cookieName?: string },
  _fieldEncryption?: { password: string; salt: string },
  extraCollections?: string[],
): Promise<void> {
  if (replicator) {
    try { replicator.stop(); } catch { /* ignore */ }
    replicator = null;
  }
  const database = requireDb();
  const dirCfg = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg: any = {};
    if (direction === "pull" || direction === "both") cfg.pull = { continuous: true };
    if (direction === "push" || direction === "both") cfg.push = { continuous: true };
    return cfg;
  };
  const collNames = [
    resolveCollectionName(collection),
    ...(extraCollections ?? []).map(resolveCollectionName),
  ];
  const collections = Object.fromEntries(collNames.map((c) => [c, dirCfg()]));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config: any = { database, url, collections };
  if (auth && "username" in auth) {
    config.credentials = { username: auth.username, password: auth.password };
  }
  replicator = new Replicator(config);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  replicator.onStatusChange = (status: any) => {
    if (_replicationStatusHandler) {
      const err: string | undefined = status.error ? String(status.error) : undefined;
      _replicationStatusHandler(status.status ?? "idle", err);
    }
  };
  replicator.run().catch((err: unknown) => {
    console.error("[cblite-web] replicator error:", err);
    if (_replicationStatusHandler) _replicationStatusHandler("stopped", String(err));
  });
}

// ── stopReplication ───────────────────────────────────────────────────────────

export async function stopReplication(): Promise<void> {
  if (replicator) {
    try { replicator.stop(); } catch { /* ignore */ }
    replicator = null;
  }
}

// ── saveBlob ──────────────────────────────────────────────────────────────────

export async function saveBlob(dataB64: string, contentType: string): Promise<string> {
  const buffer = Uint8Array.from(atob(dataB64), (c) => c.charCodeAt(0));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blob = new (NewBlob as any)(buffer, contentType);
  const blobId = "blob-" + crypto.randomUUID();
  const coll = getCollection("blobs");
  const doc = coll.createDocument(DocID(blobId), { data: blob, contentType });
  await coll.save(doc);
  return blobId;
}

// ── getBlobData ───────────────────────────────────────────────────────────────

export async function getBlobData(digest: string): Promise<string> {
  const coll = getCollection("blobs");
  const doc = await coll.getDocument(DocID(digest));
  if (!doc) throw new Error(`[cblite-web] Blob not found: ${digest}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blobData = (doc as any).data;
  if (!blobData) throw new Error(`[cblite-web] Blob document has no data field: ${digest}`);
  const contents: Uint8Array = await blobData.getContents();
  let binary = "";
  for (let i = 0; i < contents.length; i++) binary += String.fromCharCode(contents[i]);
  return btoa(binary);
}

// ── onCollectionChanged ───────────────────────────────────────────────────────

export async function onCollectionChanged(
  handler: (docIds: string[]) => void,
): Promise<() => void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const localTokens: any[] = [];
  for (const collName of ["conversations", "messages", "knowledge"] as const) {
    const coll = getCollection(collName);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = coll.addChangeListener((changes: any) => {
      handler(Array.isArray(changes.documentIDs) ? changes.documentIDs : []);
    });
    localTokens.push(token);
    activeListenerTokens.push(token);
  }
  return () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const token of localTokens) {
      try { token.remove(); } catch { /* ignore */ }
      const idx = activeListenerTokens.indexOf(token);
      if (idx >= 0) activeListenerTokens.splice(idx, 1);
    }
  };
}

// ── onReplicationStatus ───────────────────────────────────────────────────────

export async function onReplicationStatus(
  handler: (activity: string, error?: string) => void,
): Promise<() => void> {
  _replicationStatusHandler = handler;
  if (replicator) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    replicator.onStatusChange = (status: any) => handler(status.status ?? "idle");
  }
  return () => { _replicationStatusHandler = null; };
}

// ── Predictive model stubs ────────────────────────────────────────────────────

export async function registerPredictiveModel(
  _name: string,
  _options?: { onnxPath?: string; inputField?: string; outputField?: string },
): Promise<void> {
  console.warn("[cblite-web] registerPredictiveModel is not supported in the browser");
}

export async function unregisterPredictiveModel(_name: string): Promise<void> {
  console.warn("[cblite-web] unregisterPredictiveModel is not supported in the browser");
}

// ── FTS index stubs ───────────────────────────────────────────────────────────

export async function createFtsIndex(
  _collection: string,
  _indexName: string,
  _field: string,
  _language?: string,
): Promise<void> {
  // no-op: @couchbase/lite-js does not expose FTS index management yet
}

export async function listIndexes(_collection: string): Promise<string[]> {
  return [];
}
