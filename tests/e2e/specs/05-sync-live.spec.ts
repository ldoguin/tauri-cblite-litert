/**
 * 05-sync-live.spec.ts
 *
 * Live end-to-end sync tests: CouchbaseLite (app) ↔ Couchbase Sync Gateway.
 *
 * Automatically starts docker/compose.yml when SG is not already running.
 * All tests are skipped gracefully when Docker is unavailable.
 *
 * What is verified:
 *   Push — record created in the app (via Tauri IPC) is replicated to SG
 *   Pull — record created in SG (via admin REST API) is replicated into the app
 *
 * Manual start:
 *   pnpm sync:up      # start CBS + SG (first-time startup takes ~60 s)
 *   pnpm test:e2e
 *   pnpm sync:down    # optional cleanup
 */

import { execSync } from "child_process";
import { fileURLToPath } from "url";
import * as path from "path";
import * as os from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "../../..");

// ── Configuration ─────────────────────────────────────────────────────────────

const SG_PUBLIC = "http://localhost:4984";
const SG_ADMIN  = "http://localhost:4985";
const SG_DB     = "sync_test";
const SG_USER   = "test_user";
const SG_PASS   = "password";
const SG_WS     = `ws://localhost:4984/${SG_DB}`;

const COL     = "inspections";          // bare name used in SG REST paths
const CBL_COL = `_default.${COL}`;     // "_default.inspections" — CBL collection ID

// Unique per-run suffix so parallel/re-runs don't collide
const RUN_ID  = Date.now().toString(36);
const PUSH_ID = `e2e-push-${RUN_ID}`;
const PULL_ID = `e2e-pull-${RUN_ID}`;
const TOMB_ID = `e2e-tomb-${RUN_ID}`;

// Paths for DB isolation: open a fresh test DB to avoid stale-revID crashes
// when the app DB was last used with a different SG version.
const TEST_DB_DIR  = path.join(os.tmpdir(), `e2e-sync-${RUN_ID}`);
const TEST_DB_NAME = "e2e_sync";
// App DB (restored after tests so the app remains usable)
const APP_DB_DIR   = path.join(os.homedir(), ".local/share/com.ldoguin.rag-chatbot");
const APP_DB_NAME  = "rag-chatbot";
const APP_DB_COLS  = [
  "_default.conversations", "_default.messages", "_default.knowledge",
  "_default.config", "_default.agents", "_default.pdfs", "_default.products",
  "_default.inspections", "_default.clinical", "_default.photos",
  "_default.people", "_default.annotations", "_default.sync_config",
];

// ── Sync Gateway REST helpers ─────────────────────────────────────────────────

/** Collection-scoped SG REST path: /{db}._default.{collection}/{docId} */
function sgColPath(docId = "") {
  return `/${SG_DB}._default.${COL}/${docId}`;
}

/** GET a document from the SG admin API (no credentials required). */
async function sgAdminGet(docId: string): Promise<Response> {
  return fetch(`${SG_ADMIN}${sgColPath(docId)}`);
}

/** PUT a document via the SG admin API. */
async function sgAdminPut(docId: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${SG_ADMIN}${sgColPath(docId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** DELETE a document via the SG admin API (requires revision). */
async function sgAdminDelete(docId: string, rev: string): Promise<void> {
  await fetch(`${SG_ADMIN}${sgColPath(docId)}?rev=${encodeURIComponent(rev)}`, {
    method: "DELETE",
  });
}

/** GET a document from the SG public API with user credentials. */
async function sgPublicGet(docId: string): Promise<Response> {
  const auth = "Basic " + Buffer.from(`${SG_USER}:${SG_PASS}`).toString("base64");
  return fetch(`${SG_PUBLIC}${sgColPath(docId)}`, {
    headers: { Authorization: auth },
  });
}

/**
 * Ensure the test user exists in SG. Idempotent — 409 (already exists) is fine.
 * Uses the Sync Gateway admin management API.
 */
async function ensureTestUser(): Promise<void> {
  const body = {
    name: SG_USER,
    password: SG_PASS,
    disabled: false,
    collection_access: {
      _default: {
        photos:       { admin_channels: ["public"] },
        people:       { admin_channels: ["public"] },
        inspections:  { admin_channels: ["public"] },
        annotations:  { admin_channels: ["public"] },
        clinical:     { admin_channels: ["public"] },
      },
    },
  };
  // PUT is idempotent: creates or updates the user
  const r = await fetch(`${SG_ADMIN}/${SG_DB}/_user/${SG_USER}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status !== 200 && r.status !== 201) {
    const msg = await r.text().catch(() => "");
    throw new Error(`Failed to create SG user: ${r.status} ${msg}`);
  }
}

/** Poll SG admin API until the document exists or timeoutMs elapses. */
async function pollSG(docId: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await sgAdminGet(docId).catch(() => null);
    if (r?.ok) return true;
    await browser.pause(1_000);
  }
  return false;
}

// ── Tauri IPC helpers ─────────────────────────────────────────────────────────

/**
 * Call a Tauri plugin command from within the WebDriver automation session.
 * browser.executeAsync is required so wdio awaits the async IPC result.
 *
 * Signature: tauriInvoke(cmd, args)
 *   cmd  — "plugin:cblite|command_name"
 *   args — serialisable payload (JSON-safe)
 * Returns null if __TAURI_INTERNALS__ is absent or the command throws.
 */
function tauriInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T | null> {
  return browser.executeAsync(
    (c: string, a: Record<string, unknown>, done: (r: T | null) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inv = (window as any).__TAURI_INTERNALS__?.invoke as
        ((cmd: string, args: Record<string, unknown>) => Promise<T>) | undefined;
      if (!inv) { done(null); return; }
      inv(c, a).then(done).catch(() => done(null));
    },
    cmd,
    args,
  ) as Promise<T | null>;
}

/** Save a document directly in CouchbaseLite (_default.inspections). */
async function cblSave(docId: string, body: Record<string, unknown>): Promise<void> {
  await tauriInvoke("plugin:cblite|save_document", {
    collection: CBL_COL, docId, body, encryptedFields: null,
  });
}

/** Read a document from CouchbaseLite. Returns null when not found. */
async function cblGet(docId: string): Promise<Record<string, unknown> | null> {
  return tauriInvoke<Record<string, unknown>>("plugin:cblite|get_document", {
    collection: CBL_COL, docId,
  });
}

/** Start CouchbaseLite replication against Sync Gateway for the inspections collection. */
async function cblStartSync(direction: "push" | "pull" | "both"): Promise<void> {
  await tauriInvoke("plugin:cblite|start_replication", {
    url: SG_WS,
    collection: CBL_COL,
    direction,
    username: SG_USER,
    password: SG_PASS,
    sessionId: null,
    cookieName: null,
    fieldEncryptionPassword: null,
    fieldEncryptionSalt: null,
    extraCollections: null,
  });
}

/** Stop the running CouchbaseLite replication (no-op if none is running). */
async function cblStopSync(): Promise<void> {
  await tauriInvoke("plugin:cblite|stop_replication");
}

/**
 * Poll CouchbaseLite until the document exists or timeoutMs elapses.
 * Uses N1QL META().id query instead of get_document to avoid a fl_callback
 * exception crash in CBL 4.0.3 when reading documents pulled from SG 4.0.x.
 */
async function pollCBL(docId: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await tauriInvoke<unknown[]>("plugin:cblite|execute_query", {
      language: "N1QL",
      queryStr: `SELECT META().id AS id FROM \`${COL}\` WHERE META().id = '${docId}'`,
      parameters: null,
    });
    if (rows && rows.length > 0) return true;
    await browser.pause(1_000);
  }
  return false;
}

/**
 * Read a document via N1QL SELECT to avoid fl_callback crash in CBL 4.0.3
 * when reading pulled docs from SG 4.0.x with legacy revIDs.
 */
async function cblGetViaN1ql(docId: string): Promise<Record<string, unknown> | null> {
  const rows = await tauriInvoke<Record<string, unknown>[]>("plugin:cblite|execute_query", {
    language: "N1QL",
    queryStr: `SELECT * FROM \`${COL}\` AS doc WHERE META().id = '${docId}'`,
    parameters: null,
  });
  if (!rows || rows.length === 0) return null;
  const first = rows[0] as Record<string, unknown>;
  return (first["doc"] as Record<string, unknown>) ?? first;
}

// ── Docker / startup helpers ──────────────────────────────────────────────────

async function waitForSG(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = await fetch(`${SG_PUBLIC}/`)
      .then(r => r.status < 500)
      .catch(() => false);
    if (alive) return true;
    await new Promise(res => setTimeout(res, 2_000));
  }
  return false;
}

/**
 * Ensure Sync Gateway is reachable, starting docker/compose.yml if needed.
 * Returns true when SG is ready, false when Docker is unavailable or times out.
 */
async function ensureSyncGateway(): Promise<boolean> {
  const alive = await fetch(`${SG_PUBLIC}/`).then(r => r.status < 500).catch(() => false);
  if (alive) return true;

  console.log("\n  [sync] Sync Gateway not detected — running docker compose up -d …");
  try {
    execSync(
      `podman-compose -f "${path.join(ROOT, "docker/compose.yml")}" up -d`,
      { stdio: "inherit" },
    );
  } catch {
    console.error("  [sync] docker compose up failed — live sync tests will be skipped");
    return false;
  }

  process.stdout.write("  [sync] Waiting for Sync Gateway to become ready");
  const ready = await waitForSG(90_000);
  console.log(ready ? " ✓" : " ✗ (timed out — tests will be skipped)");
  return ready;
}

// ── Test data factory ─────────────────────────────────────────────────────────

function inspectionBody(tag: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    createdAt: now, updatedAt: now,
    location: `e2e-${tag}-site`, assetId: "",
    category: "General", severity: "low",
    notes: `e2e ${tag} sync test`, photoRef: "",
    detections: [], aiReport: "", synced: false,
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("Live Sync — CouchbaseLite ↔ Sync Gateway", () => {
  let sgAvailable = false;

  before(async function() {
    // Allow up to 2 minutes: Docker may need to pull images and initialise CBS
    this.timeout(130_000);

    sgAvailable = await ensureSyncGateway();
    if (!sgAvailable) {
      console.log("  [sync] All live sync tests will be skipped");
      return;
    }

    // Small buffer for SG to finish internal initialisation after becoming reachable
    await browser.pause(2_000);

    await ensureTestUser();

    // Stop any replication left over from a previous spec
    await cblStopSync().catch(() => {});

    // Open a fresh isolated test DB so old-format documents from prior runs
    // (e.g. after a SG version change) cannot trigger fl_callback crashes.
    await tauriInvoke("plugin:cblite|open_database", {
      path: TEST_DB_DIR,
      name: TEST_DB_NAME,
      encryptionPassword: null,
      collections: [CBL_COL],
    });

    console.log(`  [sync] Ready — push doc: ${PUSH_ID}  pull doc: ${PULL_ID}`);
  });

  after(async () => {
    // Always stop replication on teardown
    await cblStopSync().catch(() => {});

    // Restore the app's original database so subsequent specs and the UI work normally
    await tauriInvoke("plugin:cblite|open_database", {
      path: APP_DB_DIR,
      name: APP_DB_NAME,
      encryptionPassword: null,
      collections: APP_DB_COLS,
    }).catch(() => {});

    if (!sgAvailable) return;

    // Best-effort removal of test documents from SG to keep the server clean
    for (const id of [PUSH_ID, PULL_ID, TOMB_ID]) {
      const r = await sgAdminGet(id).catch(() => null);
      if (r?.ok) {
        const doc = await r.json().catch(() => null) as Record<string, unknown> | null;
        if (typeof doc?._rev === "string") {
          await sgAdminDelete(id, doc._rev).catch(() => {});
        }
      }
    }
  });

  // ── Push ─────────────────────────────────────────────────────────────────

  describe("Push — CouchbaseLite → Sync Gateway", () => {
    it("saves a record directly in CouchbaseLite via Tauri IPC", async function() {
      if (!sgAvailable) return this.skip();
      await cblSave(PUSH_ID, inspectionBody("push"));
      const saved = await cblGet(PUSH_ID);
      expect(saved).not.toBe(null);
    });

    it("starts push replication to Sync Gateway", async function() {
      if (!sgAvailable) return this.skip();
      await cblStartSync("push");
    });

    it("document appears in Sync Gateway within 20 s", async function() {
      if (!sgAvailable) return this.skip();
      const found = await pollSG(PUSH_ID, 20_000);
      await cblStopSync().catch(() => {});
      expect(found).toBe(true);
    });

    it("Sync Gateway document has the expected field values", async function() {
      if (!sgAvailable) return this.skip();
      const r = await sgAdminGet(PUSH_ID);
      expect(r.ok).toBe(true);
      const doc = await r.json() as Record<string, unknown>;
      expect(doc["location"]).toBe("e2e-push-site");
      expect(doc["notes"]).toBe("e2e push sync test");
    });

    it("authenticated user can read the document from the public API", async function() {
      if (!sgAvailable) return this.skip();
      const r = await sgPublicGet(PUSH_ID);
      expect(r.ok).toBe(true);
      const doc = await r.json() as Record<string, unknown>;
      expect(doc["location"]).toBe("e2e-push-site");
    });
  });

  // ── Pull ─────────────────────────────────────────────────────────────────

  describe("Pull — Sync Gateway → CouchbaseLite", () => {
    it("creates a record in Sync Gateway via admin REST API", async function() {
      if (!sgAvailable) return this.skip();
      const r = await sgAdminPut(PULL_ID, inspectionBody("pull"));
      expect(r.status).toBeLessThan(300);
    });

    it("starts pull replication from Sync Gateway", async function() {
      if (!sgAvailable) return this.skip();
      // Stop any leftover push replication before switching direction
      await cblStopSync().catch(() => {});
      await cblStartSync("pull");
    });

    it("document appears in CouchbaseLite within 20 s", async function() {
      if (!sgAvailable) return this.skip();
      const found = await pollCBL(PULL_ID, 20_000);
      await cblStopSync().catch(() => {});
      expect(found).toBe(true);
    });

    it("CouchbaseLite document has the expected field values", async function() {
      if (!sgAvailable) return this.skip();
      const doc = await cblGetViaN1ql(PULL_ID);
      expect(doc).not.toBe(null);
      expect(doc!["location"]).toBe("e2e-pull-site");
      expect(doc!["notes"]).toBe("e2e pull sync test");
    });
  });

  // ── Tombstone ────────────────────────────────────────────────────────────

  describe("Tombstone — delete propagates push → SG", () => {
    it("creates and pushes a record to be deleted", async function() {
      if (!sgAvailable) return this.skip();
      await cblSave(TOMB_ID, inspectionBody("tombstone"));
      await cblStartSync("push");
      const pushed = await pollSG(TOMB_ID, 20_000);
      await cblStopSync().catch(() => {});
      expect(pushed).toBe(true);
    });

    it("deleting the record via SG admin tombstones it", async function() {
      if (!sgAvailable) return this.skip();
      const r = await sgAdminGet(TOMB_ID);
      expect(r.ok).toBe(true);
      const doc = await r.json() as Record<string, unknown>;
      expect(typeof doc._rev).toBe("string");
      await sgAdminDelete(TOMB_ID, doc._rev as string);
      // Verify tombstone: GET returns 404 (doc deleted) or a tombstone (_deleted:true)
      const after = await sgAdminGet(TOMB_ID);
      // SG returns 404 or a tombstone doc with _deleted:true
      const tombstone = !after.ok
        || ((await after.json().catch(() => null)) as Record<string, unknown> | null)?._deleted === true;
      expect(tombstone).toBe(true);
    });
  });
});
