export declare const COLLECTION_CHANGED_EVENT = "cblite://collection-changed";
export declare const REPLICATION_STATUS_EVENT = "cblite://replication-status";
export declare function openDatabase(path: string, name: string, encryptionPassword?: string, collections?: string[]): Promise<void>;
export declare function closeDatabase(): Promise<void>;
export declare function getDocument(collection: string, docId: string): Promise<unknown>;
export declare function saveDocument(collection: string, docId: string, body: unknown, encryptedFields?: string[]): Promise<void>;
export declare function startReplication(url: string, collection: string, direction: "push" | "pull" | "both", auth?: {
    username: string;
    password: string;
} | {
    sessionId: string;
    cookieName?: string;
}, fieldEncryption?: {
    password: string;
    salt: string;
}, extraCollections?: string[]): Promise<void>;
export declare function stopReplication(): Promise<void>;
export declare function executeQuery(language: "N1QL" | "JSON", queryStr: string, parameters?: Record<string, unknown>): Promise<unknown[]>;
/** Create (or idempotently ensure) a full-text search index on a collection field. */
export declare function createFtsIndex(collection: string, indexName: string, field: string): Promise<void>;
export declare function listIndexes(collection: string): Promise<string[]>;
/**
 * Register a predictive model for use in PREDICTION() queries.
 */
export declare function registerPredictiveModel(name: string, options?: {
    onnxPath?: string;
    inputField?: string;
    outputField?: string;
}): Promise<void>;
/** Unregister a previously registered predictive model. */
export declare function unregisterPredictiveModel(name: string): Promise<void>;
/**
 * Save binary data as a CBL blob. `dataB64` is the base64-encoded content.
 * Returns the blob's digest string (e.g. "sha1-abc123...") for later retrieval.
 */
export declare function saveBlob(dataB64: string, contentType: string): Promise<string>;
/**
 * Retrieve blob bytes by digest. Returns base64-encoded content.
 */
export declare function getBlobData(digest: string): Promise<string>;
export declare function writeExportFile(filename: string, data: string): Promise<string>;
export declare function onCollectionChanged(handler: (docIds: string[]) => void): Promise<() => void>;
export declare function onReplicationStatus(handler: (activity: string, error?: string) => void): Promise<() => void>;
