/**
 * Tauri adapter for @cblite.
 *
 * Re-exports tauri-plugin-cblite verbatim.  This file is what the @cblite
 * Vite alias resolves to when building the desktop (Tauri) target.
 */
export {
  COLLECTION_CHANGED_EVENT,
  REPLICATION_STATUS_EVENT,
  openDatabase,
  closeDatabase,
  getDocument,
  saveDocument,
  executeQuery,
  startReplication,
  stopReplication,
  saveBlob,
  getBlobData,
  onCollectionChanged,
  onReplicationStatus,
  registerPredictiveModel,
  unregisterPredictiveModel,
  createFtsIndex,
  listIndexes,
} from "tauri-plugin-cblite";
