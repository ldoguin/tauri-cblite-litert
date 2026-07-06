/**
 * DatabaseAdapter — the contract both the Tauri plugin and the web adapter
 * must satisfy.  Application code imports only from this interface; the
 * concrete implementation is injected at build time via the @cblite Vite alias.
 */

export const COLLECTION_CHANGED_EVENT = "cblite://collection-changed";
export const REPLICATION_STATUS_EVENT  = "cblite://replication-status";

export interface DatabaseAdapter {
  openDatabase(
    path: string,
    name: string,
    encryptionPassword?: string,
    collections?: string[],
  ): Promise<void>;

  closeDatabase(): Promise<void>;

  getDocument(collection: string, docId: string): Promise<unknown>;

  saveDocument(
    collection: string,
    docId: string,
    body: unknown,
    encryptedFields?: string[],
  ): Promise<void>;

  executeQuery(
    language: "N1QL" | "JSON",
    queryStr: string,
    parameters?: Record<string, unknown>,
  ): Promise<unknown[]>;

  startReplication(
    url: string,
    collection: string,
    direction: "push" | "pull" | "both",
    auth?:
      | { username: string; password: string }
      | { sessionId: string; cookieName?: string },
    fieldEncryption?: { password: string; salt: string },
    extraCollections?: string[],
  ): Promise<void>;

  stopReplication(): Promise<void>;

  saveBlob(dataB64: string, contentType: string): Promise<string>;

  getBlobData(digest: string): Promise<string>;

  onCollectionChanged(
    handler: (docIds: string[]) => void,
  ): Promise<() => void>;

  onReplicationStatus(
    handler: (activity: string, error?: string) => void,
  ): Promise<() => void>;

  registerPredictiveModel(
    name: string,
    options?: { onnxPath?: string; inputField?: string; outputField?: string },
  ): Promise<void>;

  unregisterPredictiveModel(name: string): Promise<void>;

  createFtsIndex(
    collection: string,
    indexName: string,
    field: string,
    language?: string,
  ): Promise<void>;

  listIndexes(collection: string): Promise<string[]>;
}
