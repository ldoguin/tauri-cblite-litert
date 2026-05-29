// Tauri v2 plugin guest API
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const COLLECTION_CHANGED_EVENT = "cblite://collection-changed";
export const REPLICATION_STATUS_EVENT = "cblite://replication-status";

/**
 * True when running on Android/iOS. On mobile, plugin events come through
 * Tauri Channels (registerListener) rather than the global event bus (listen).
 *
 * Uses @tauri-apps/plugin-os for reliable platform detection instead of
 * user-agent sniffing, which is unreliable on desktop browsers with mobile
 * emulation enabled.
 */
let _isMobileCache: boolean | null = null;

async function isMobileAsync(): Promise<boolean> {
  if (_isMobileCache !== null) return _isMobileCache;
  try {
    const { platform } = await import("@tauri-apps/plugin-os");
    const p = await platform();
    _isMobileCache = p === "android" || p === "ios";
  } catch {
    // plugin-os not available — fall back to UA sniff as last resort
    _isMobileCache = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
  }
  return _isMobileCache;
}

// Synchronous helper used in non-async contexts; resolved on first async call.
function isMobile(): boolean {
  if (_isMobileCache !== null) return _isMobileCache;
  // Warm the cache asynchronously; first call before resolution falls back to UA.
  isMobileAsync().catch(() => {});
  return /android|iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function openDatabase(
  path: string,
  name: string,
  encryptionPassword?: string,
  collections?: string[]
): Promise<void> {
  return invoke("plugin:cblite|open_database", {
    path,
    name,
    encryptionPassword: encryptionPassword ?? null,
    collections: collections ?? null,
  });
}

export function closeDatabase(): Promise<void> {
  return invoke("plugin:cblite|close_database");
}

export function getDocument(
  collection: string,
  docId: string
): Promise<unknown> {
  return invoke("plugin:cblite|get_document", {
    collection,
    docId,
  });
}

export function saveDocument(
  collection: string,
  docId: string,
  body: unknown,
  encryptedFields?: string[]
): Promise<void> {
  return invoke("plugin:cblite|save_document", {
    collection,
    docId,
    body,
    encryptedFields: encryptedFields ?? null,
  });
}

export function startReplication(
  url: string,
  collection: string,
  direction: "push" | "pull" | "both",
  auth?: { username: string; password: string } | { sessionId: string; cookieName?: string },
  fieldEncryption?: { password: string; salt: string },
  extraCollections?: string[]
): Promise<void> {
  const isSession = auth && "sessionId" in auth;
  return invoke("plugin:cblite|start_replication", {
    url,
    collection,
    direction,
    username: !isSession && auth ? (auth as { username: string }).username : null,
    password: !isSession && auth ? (auth as { password: string }).password : null,
    sessionId: isSession ? (auth as { sessionId: string }).sessionId : null,
    cookieName: isSession ? ((auth as { cookieName?: string }).cookieName ?? null) : null,
    fieldEncryptionPassword: fieldEncryption?.password ?? null,
    fieldEncryptionSalt: fieldEncryption?.salt ?? null,
    extraCollections: extraCollections ?? null,
  });
}

export function stopReplication(): Promise<void> {
  return invoke("plugin:cblite|stop_replication");
}

export function executeQuery(
  language: "N1QL" | "JSON",
  queryStr: string,
  parameters?: Record<string, unknown>
): Promise<unknown[]> {
  return invoke("plugin:cblite|execute_query", {
    language,
    queryStr,
    parameters: parameters ?? null,
  });
}

/** Create (or idempotently ensure) a full-text search index on a collection field. */
export function createFtsIndex(
  collection: string,
  indexName: string,
  field: string
): Promise<void> {
  return invoke("plugin:cblite|create_fts_index", { collection, indexName, field });
}

/**
 * Register a predictive model for use in PREDICTION() queries.
 */
export function registerPredictiveModel(
  name: string,
  options?: {
    onnxPath?: string;
    inputField?: string;
    outputField?: string;
  }
): Promise<void> {
  return invoke("plugin:cblite|register_predictive_model", {
    name,
    onnxPath: options?.onnxPath ?? null,
    inputField: options?.inputField ?? null,
    outputField: options?.outputField ?? null,
  });
}

/** Unregister a previously registered predictive model. */
export function unregisterPredictiveModel(name: string): Promise<void> {
  return invoke("plugin:cblite|unregister_predictive_model", { name });
}

/**
 * Save binary data as a CBL blob. `dataB64` is the base64-encoded content.
 * Returns the blob's digest string (e.g. "sha1-abc123...") for later retrieval.
 */
export function saveBlob(dataB64: string, contentType: string): Promise<string> {
  return invoke("plugin:cblite|save_blob", { dataB64, contentType });
}

/**
 * Retrieve blob bytes by digest. Returns base64-encoded content.
 */
export function getBlobData(digest: string): Promise<string> {
  return invoke("plugin:cblite|get_blob_data", { digest });
}

export function onCollectionChanged(
  handler: (docIds: string[]) => void
): Promise<() => void> {
  if (isMobile()) {
    // Android: plugin events go through Tauri Channels, not the global event bus.
    const ch = new Channel<{ docIds: string[] }>();
    ch.onmessage = (payload: { docIds: string[] }) => handler(payload.docIds ?? []);
    return invoke("plugin:cblite|registerListener", {
      event: COLLECTION_CHANGED_EVENT,
      handler: ch,
    }).then(() => () => {
      invoke("plugin:cblite|removeListener", {
        event: COLLECTION_CHANGED_EVENT,
        channelId: ch.id,
      }).catch(() => {/* ignore */});
    });
  }
  // Desktop: emitted via Rust app_handle.emit()
  return listen<string[]>(COLLECTION_CHANGED_EVENT, (event: { payload: string[] }) => {
    handler(event.payload);
  });
}

export function onReplicationStatus(
  handler: (activity: string, error?: string) => void
): Promise<() => void> {
  if (isMobile()) {
    // Android: plugin events go through Tauri Channels.
    const ch = new Channel<{ activity: string; error?: string }>();
    ch.onmessage = (payload: { activity: string; error?: string }) => handler(payload.activity ?? "", payload.error);
    return invoke("plugin:cblite|registerListener", {
      event: REPLICATION_STATUS_EVENT,
      handler: ch,
    }).then(() => () => {
      invoke("plugin:cblite|removeListener", {
        event: REPLICATION_STATUS_EVENT,
        channelId: ch.id,
      }).catch(() => {/* ignore */});
    });
  }
  // Desktop: emitted via Rust app_handle.emit()
  return listen<string>(REPLICATION_STATUS_EVENT, (event: { payload: string }) => {
    handler(event.payload);
  });
}
