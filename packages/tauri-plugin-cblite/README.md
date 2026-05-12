# tauri-plugin-cblite

Tauri plugin for [Couchbase Lite](https://www.couchbase.com/products/lite/) — a lightweight, embedded NoSQL database for multi-platform apps. Provides a unified TypeScript API backed by native Rust (desktop) and Kotlin (Android) implementations.

| Platform | Supported |
| -------- | --------- |
| Linux    | ✓         |
| macOS    | ✓         |
| Windows  | ✓         |
| Android  | ✓         |
| iOS      | Planned   |

## Features

- **Document database** — get and save JSON documents in named collections
- **N1QL queries** — execute parameterized N1QL or JSON queries
- **Sync Gateway replication** — continuous push/pull/bidirectional replication with basic auth or session auth
- **Blob storage** — store and retrieve binary data (images, files) as base64
- **Live change events** — subscribe to collection changes and replication status updates
- **Enterprise features** (optional, `enterprise` feature flag):
  - AES-256 database encryption
  - Document field-level encryption
  - ONNX predictive models for vector/ML queries

## Install

### Rust (Tauri backend)

Add the plugin to `src-tauri/Cargo.toml`:

```toml
[dependencies]
tauri-plugin-cblite = { git = "https://github.com/ldoguin/tauri-plugin-cblilte", features = ["native-cbl"] }
```

Enable enterprise features if needed:

```toml
tauri-plugin-cblite = { git = "https://github.com/ldoguin/tauri-plugin-cblilte", features = ["native-cbl", "enterprise"] }
```

### JavaScript / TypeScript (frontend)

From the `cbliterie/` workspace:

```sh
pnpm add tauri-plugin-cblite
```

Or reference the local guest-js package directly in your `package.json`:

```json
{
  "dependencies": {
    "tauri-plugin-cblite": "workspace:*"
  }
}
```

## Usage

### 1. Register the plugin

In `src-tauri/src/lib.rs`:

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_cblite::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 2. Configure permissions

In `src-tauri/capabilities/default.json`, add the plugin's default permission set:

```json
{
  "permissions": [
    "cblite:default"
  ]
}
```

Or grant individual permissions:

```json
{
  "permissions": [
    "cblite:allow-open-database",
    "cblite:allow-close-database",
    "cblite:allow-get-document",
    "cblite:allow-save-document",
    "cblite:allow-execute-query",
    "cblite:allow-start-replication",
    "cblite:allow-stop-replication",
    "cblite:allow-save-blob",
    "cblite:allow-get-blob-data"
  ]
}
```

### 3. Use from TypeScript

```typescript
import {
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
} from "tauri-plugin-cblite";
```

## API Reference

### Database

#### `openDatabase(path, name, encryptionPassword?, collections?)`

Opens or creates a Couchbase Lite database. Specify collections to create them on open and register change listeners automatically.

```typescript
await openDatabase("/path/to/db/dir", "mydb", undefined, [
  "_default.notes",
  "_default.users",
]);
```

- `path` — directory where the `.cblite2` file is stored
- `name` — database name (without extension)
- `encryptionPassword` — *(Enterprise)* AES-256 encryption password
- `collections` — array of `"scope.collection"` strings (or just `"collection"` to use the `_default` scope)

#### `closeDatabase()`

Closes the database and stops all active listeners and replicators.

```typescript
await closeDatabase();
```

### Documents

#### `getDocument(collection, docId)`

Retrieves a document by ID. Returns the document body as a plain object, or `null` if not found.

```typescript
const doc = await getDocument("_default.notes", "note-123");
```

#### `saveDocument(collection, docId, body, encryptedFields?)`

Saves or updates a document. Merges the provided body into an existing document.

```typescript
await saveDocument("_default.notes", "note-123", {
  title: "My note",
  content: "Hello, world!",
  createdAt: new Date().toISOString(),
});
```

- `encryptedFields` — *(Enterprise)* array of field names to encrypt at the document level

### Queries

#### `executeQuery(language, queryStr, parameters?)`

Executes a N1QL or JSON query and returns an array of result objects.

```typescript
// N1QL
const results = await executeQuery(
  "N1QL",
  "SELECT * FROM _default.notes WHERE type = $type",
  { type: "reminder" }
);

// JSON query language
const results = await executeQuery("JSON", JSON.stringify({
  WHAT: [[".", "title"]],
  FROM: [{ COLLECTION: "notes" }],
}));
```

### Blobs

#### `saveBlob(dataB64, contentType)`

Saves binary data as a Couchbase Lite blob. Returns a digest string you can store in a document.

```typescript
const digest = await saveBlob(base64EncodedData, "image/jpeg");
// Store digest in a document field, retrieve later with getBlobData
```

#### `getBlobData(digest)`

Retrieves blob content by digest. Returns base64-encoded data.

```typescript
const base64 = await getBlobData("sha1-abc123...");
```

### Replication

#### `startReplication(url, collection, direction, auth?, fieldEncryption?)`

Starts continuous replication with a Couchbase Sync Gateway endpoint.

```typescript
// Basic auth
await startReplication(
  "ws://localhost:4984/mydb",
  "_default.notes",
  "both",
  { username: "alice", password: "secret" }
);

// Session auth (Sync Gateway cookie)
await startReplication(
  "wss://sync.example.com/mydb",
  "_default.notes",
  "pull",
  { sessionId: "abc123", cookieName: "SyncGatewaySession" }
);
```

- `direction` — `"push"` | `"pull"` | `"both"`
- `auth` — basic `{username, password}` or session `{sessionId, cookieName?}`
- `fieldEncryption` — *(Enterprise)* `{password, salt}` for PBKDF2-AES-256-GCM field encryption

#### `stopReplication()`

Stops the active replicator.

```typescript
await stopReplication();
```

### Change Events

#### `onCollectionChanged(handler)`

Subscribes to document change events for any collection opened with `openDatabase`. Returns an unsubscribe function.

```typescript
const unsubscribe = await onCollectionChanged((event) => {
  console.log("Changed document IDs:", event.documentIDs);
});

// Later, to stop listening:
unsubscribe();
```

#### `onReplicationStatus(handler)`

Subscribes to replicator activity updates. Returns an unsubscribe function.

```typescript
const unsubscribe = await onReplicationStatus((status) => {
  // status.activity: "Stopped" | "Offline" | "Connecting" | "Idle" | "Busy"
  // status.error?: string
  console.log("Replication:", status.activity);
});
```

### Predictive Models (Enterprise)

#### `registerPredictiveModel(name, options?)`

Registers an ONNX model (or a stub returning a fixed score) for use in N1QL `PREDICTION()` queries. Desktop only.

```typescript
await registerPredictiveModel("sentimentModel", {
  onnxPath: "/path/to/model.onnx",
  inputField: "embedding",
  outputField: "scores",
});
```

#### `unregisterPredictiveModel(name)`

```typescript
await unregisterPredictiveModel("sentimentModel");
```

## Architecture

```
┌──────────────────────────────────────────────┐
│               TypeScript (guest-js)           │
│     Unified API via tauri invoke() calls      │
└─────────────────┬────────────────────────────┘
                  │
      ┌───────────┴────────────┐
      │ Desktop                │ Android
      │ (Rust + native-cbl)   │ (Kotlin + CBL SDK)
      │ commands.rs            │ CblitePlugin.kt
      └───────────────────────┘
```

- **Desktop**: Rust plugin links against the native Couchbase Lite C library via the `couchbase-lite-rust` crate. Plugin state (database, listeners, replicator) is held in `Arc<Mutex<>>` for async safety.
- **Android**: Rust delegates all calls to the Kotlin plugin class (`com.plugin.cblite.CblitePlugin`) via `PluginHandle::run_mobile_plugin()`. The Kotlin code uses the official Couchbase Lite Android SDK.
- **Events**: Desktop emits via `AppHandle::emit()`; Android triggers via the Tauri `Channel` mechanism with `registerListener`/`removeListener`.

## Contributing

Contributions are welcome. Please open issues or pull requests against the [nucblite repository](https://github.com/ldoguin/tauri-plugin-cblilte).

## License

MIT
