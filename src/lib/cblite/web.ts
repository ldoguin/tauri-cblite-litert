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
 * - @couchbase/lite-js does not expose the built-in _default collection via
 *   getCollection('_default'), so we map "_default" → "config" internally.
 * - createFtsIndex / listIndexes are not yet exposed by the JS SDK; they are
 *   no-ops here.  FTS queries will fall back to a JS-side filter in db.ts.
 * - registerPredictiveModel / unregisterPredictiveModel are not supported in
 *   the browser; calls are silently ignored.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

// Lazily resolved @couchbase/lite-js exports
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _cbl: any = null;
async function cbl(): Promise<AnyRecord> {
  if (!_cbl) _cbl = await import("@couchbase/lite-js");
  return _cbl;
}

// Module-level state
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let replicator: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const activeListenerTokens: Array<{ coll: any; token: any }> = [];
let _replicationStatusHandler: ((activity: string, error?: string) => void) | null = null;

// All collections used by this app.  "_default" is mapped to "config" because
// @couchbase/lite-js does not expose the built-in _default collection.
const NAMED_COLLECTIONS = [
  "conversations", "messages", "knowledge", "config",
  "agents", "pdfs", "products", "inspections", "clinical",
  "photos", "people", "annotations", "sync_config",
  "crop_disease", "disease_kb", "blobs",
] as const;

function resolveCollectionName(name: string): string {
  // Strip the "_default." scope prefix used by the Tauri plugin convention.
  const bare = name.replace(/^_default\./, "");
  // The built-in _default collection is not accessible by name in the JS SDK.
  return bare === "_default" ? "config" : bare;
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
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  const { Database } = await cbl();

  const collectionsConfig: AnyRecord = {};
  for (const c of NAMED_COLLECTIONS) collectionsConfig[c] = {};

  db = await Database.open({ name, version: 1, collections: collectionsConfig });
}

// ── closeDatabase ─────────────────────────────────────────────────────────────

export async function closeDatabase(): Promise<void> {
  if (!db) return;
  for (const { coll, token } of activeListenerTokens) {
    try { coll.removeChangeListener(token); } catch { /* ignore */ }
  }
  activeListenerTokens.length = 0;
  _replicationStatusHandler = null;
  try { await db.close(); } catch { /* ignore */ }
  db = null;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function requireDb(): void {
  if (!db) throw new Error("[cblite-web] Database is not open");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getCollection(collectionName: string): any {
  requireDb();
  return db.getCollection(resolveCollectionName(collectionName));
}

// ── getDocument ───────────────────────────────────────────────────────────────

export async function getDocument(
  collection: string,
  docId: string,
): Promise<unknown> {
  const { DocID } = await cbl();
  const coll = getCollection(collection);
  const doc = await coll.getDocument(DocID(docId));
  return doc ?? null;
}

// ── saveDocument ──────────────────────────────────────────────────────────────

export async function saveDocument(
  collection: string,
  docId: string,
  body: unknown,
  _encryptedFields?: string[],
): Promise<void> {
  const { DocID } = await cbl();
  const coll = getCollection(collection);
  const data = body as AnyRecord;

  const existing = await coll.getDocument(DocID(docId));
  if (existing) {
    for (const [k, v] of Object.entries(data)) existing[k] = v;
    await coll.save(existing);
  } else {
    await coll.save(coll.createDocument(DocID(docId), data));
  }
}

// ── executeQuery ──────────────────────────────────────────────────────────────

export async function executeQuery(
  _language: "N1QL" | "JSON",
  queryStr: string,
  parameters?: Record<string, unknown>,
): Promise<unknown[]> {
  requireDb();
  // Strip scope prefix: "FROM `_default`.X" or "FROM _default.X" → "FROM X"
  const normalized = queryStr
    .replace(/FROM\s+`_default`\./gi, "FROM ")
    .replace(/FROM\s+_default\./gi, "FROM ");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query: any = db.createQuery(normalized);
  if (parameters && Object.keys(parameters).length > 0) {
    query.parameters = parameters;
  }
  return query.execute();
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

  const { Replicator } = await cbl();

  function dirCfg() {
    const d: AnyRecord = {};
    if (direction === "pull" || direction === "both") d.pull = { continuous: true };
    if (direction === "push" || direction === "both") d.push = { continuous: true };
    return d;
  }

  const collNames = [
    resolveCollectionName(collection),
    ...(extraCollections ?? []).map(resolveCollectionName),
  ];
  const collectionsConfig: AnyRecord = {};
  for (const c of collNames) collectionsConfig[c] = dirCfg();

  const config: AnyRecord = { database: db, url, collections: collectionsConfig };
  if (auth && "username" in auth) {
    config.credentials = { username: auth.username, password: auth.password };
  }

  replicator = new Replicator(config);
  replicator.onStatusChange = (status: AnyRecord) => {
    if (_replicationStatusHandler) {
      const err: string | undefined = status.error ? String(status.error) : undefined;
      _replicationStatusHandler(mapActivity(status.status ?? status), err);
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
  const { DocID, NewBlob } = await cbl();
  const buffer = Uint8Array.from(atob(dataB64), (c) => c.charCodeAt(0));
  const blob = new NewBlob(buffer, contentType);
  const blobId = "blob-" + crypto.randomUUID();
  const coll = getCollection("blobs");
  await coll.save(coll.createDocument(DocID(blobId), { data: blob, contentType }));
  return blobId;
}

// ── getBlobData ───────────────────────────────────────────────────────────────

export async function getBlobData(digest: string): Promise<string> {
  const { DocID } = await cbl();
  const coll = getCollection("blobs");
  const doc = await coll.getDocument(DocID(digest));
  if (!doc) throw new Error(`[cblite-web] Blob not found: ${digest}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blob: any = doc.data;
  if (!blob) throw new Error(`[cblite-web] Blob document has no 'data' field: ${digest}`);
  const contents: Uint8Array = await blob.getContents();
  let binary = "";
  for (let i = 0; i < contents.length; i++) binary += String.fromCharCode(contents[i]);
  return btoa(binary);
}

// ── onCollectionChanged ───────────────────────────────────────────────────────

export async function onCollectionChanged(
  handler: (docIds: string[]) => void,
): Promise<() => void> {
  const localTokens: Array<{ coll: unknown; token: unknown }> = [];

  // Listen on the collections most likely to drive UI updates.
  for (const collName of ["conversations", "messages", "knowledge"] as const) {
    const coll = getCollection(collName);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = coll.addChangeListener((changes: any) => {
      handler(Array.isArray(changes.documentIDs) ? changes.documentIDs : []);
    });
    const entry = { coll, token };
    localTokens.push(entry);
    activeListenerTokens.push(entry);
  }

  return () => {
    for (const { coll, token } of localTokens) {
      try { (coll as AnyRecord).removeChangeListener(token); } catch { /* ignore */ }
      const idx = activeListenerTokens.findIndex((t) => t.token === token);
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
    replicator.onStatusChange = (status: AnyRecord) => {
      handler(mapActivity(status.status ?? status));
    };
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
// @couchbase/lite-js does not yet expose FTS index management.  db.ts falls
// back to JS-side filtering for FTS queries when running in the browser.

export async function createFtsIndex(
  _collection: string,
  _indexName: string,
  _field: string,
  _language?: string,
): Promise<void> {
  console.warn("[cblite-web] createFtsIndex is not supported in the browser — FTS queries will use JS-side filtering");
}

export async function listIndexes(_collection: string): Promise<string[]> {
  return [];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function mapActivity(status: string | undefined): string {
  if (!status) return "idle";
  const s = String(status).toLowerCase();
  if (s.includes("stop") || s.includes("offline")) return "stopped";
  if (s.includes("connect")) return "connecting";
  if (s.includes("busy") || s.includes("activ")) return "busy";
  return "idle";
}
