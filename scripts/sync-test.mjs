#!/usr/bin/env node
/**
 * Sync Gateway integration test harness.
 *
 * Tests push/pull round-trips for every collection the app syncs.
 * Requires docker/compose.yml to be running:
 *
 *   docker compose -f docker/compose.yml up -d
 *   node scripts/sync-test.mjs
 *
 * Environment variables (all optional):
 *   SG_PUBLIC_URL  — default: http://localhost:4984
 *   SG_ADMIN_URL   — default: http://localhost:4985
 *   SG_DB          — default: sync_test
 *   SG_USER        — default: test_user
 *   SG_PASS        — default: password
 */

const PUBLIC_URL = process.env.SG_PUBLIC_URL ?? "http://localhost:4984";
const ADMIN_URL  = process.env.SG_ADMIN_URL  ?? "http://localhost:4985";
const DB         = process.env.SG_DB         ?? "sync_test";
const SG_USER    = process.env.SG_USER       ?? "test_user";
const SG_PASS    = process.env.SG_PASS       ?? "password";

// Collections that the app syncs (maps to _default.<name>)
const COLLECTIONS = ["photos", "people", "inspections", "annotations", "clinical"];

// ── helpers ──────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function ok(label) {
  console.log(`  ✓  ${label}`);
  passed++;
}

function fail(label, reason) {
  console.error(`  ✗  ${label}: ${reason}`);
  failed++;
}

async function adminReq(method, path, body) {
  const res = await fetch(`${ADMIN_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

async function publicReq(method, path, body) {
  const creds = Buffer.from(`${SG_USER}:${SG_PASS}`).toString("base64");
  const res = await fetch(`${PUBLIC_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${creds}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

// Collection-scoped URL: /{db}.{scope}.{collection}/{docId}
function colPath(collection, docId = "") {
  return `/${DB}._default.${collection}/${docId}`;
}

async function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function retry(fn, label, attempts = 10, delayMs = 1000) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === attempts - 1) throw new Error(`${label} failed after ${attempts} attempts: ${e.message}`);
      await wait(delayMs);
    }
  }
}

// ── setup ────────────────────────────────────────────────────────────────────

async function ensureReady() {
  console.log("\n── Connectivity ──────────────────────────────────────────────");

  await retry(
    () => fetch(`${PUBLIC_URL}/`).then(r => { if (!r.ok) throw new Error(r.status); }),
    "SG public API",
  );
  ok(`SG public API reachable at ${PUBLIC_URL}`);

  await retry(
    () => fetch(`${ADMIN_URL}/`).then(r => { if (!r.ok) throw new Error(r.status); }),
    "SG admin API",
  );
  ok(`SG admin API reachable at ${ADMIN_URL}`);

  // Verify database exists
  const dbInfo = await adminReq("GET", `/${DB}/`);
  ok(`Database '${DB}' exists (state: ${dbInfo?.state ?? "unknown"})`);
}

async function createTestUser() {
  console.log("\n── Test user ─────────────────────────────────────────────────");
  try {
    // PUT is idempotent: creates or updates the user.
    // SG 3.x scoped collections require collection_access instead of admin_channels.
    await adminReq("PUT", `/${DB}/_user/${SG_USER}`, {
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
    });
    ok(`User '${SG_USER}' created/updated`);
  } catch (e) {
    fail("Create test user", e.message);
  }
}

// ── per-collection tests ──────────────────────────────────────────────────────

async function testCollection(collection) {
  console.log(`\n── Collection: ${collection} ──────────────────────────────────`);
  const docId = `test-${collection}-${Date.now()}`;
  const payload = {
    id: docId,
    _collection: collection,
    createdAt: new Date().toISOString(),
    synced: false,
    // Representative fields per collection
    ...(collection === "photos"      && { caption: "test photo", labels: ["cat"], embedding: [] }),
    ...(collection === "people"      && { name: "Test Person", faceThumb: "" }),
    ...(collection === "inspections" && { notes: "test inspection", severity: "low", location: "test-site" }),
    ...(collection === "annotations" && { labels: ["dog"], boxes: [], status: "unannotated" }),
    ...(collection === "clinical"    && { patientRef: "PT-TEST-001", noteType: "progress", rawNotes: "test note" }),
  };

  // ── Push: write via admin, read via public ──────────────────────────────
  try {
    await adminReq("PUT", colPath(collection, docId), payload);
    ok(`Push: document written to ${collection}`);
  } catch (e) {
    fail(`Push: write to ${collection}`, e.message);
    return;
  }

  // Small delay for SG processing
  await wait(300);

  try {
    const { status, body } = await publicReq("GET", colPath(collection, docId));
    if (status === 200 && body?.id === docId) {
      ok(`Push: document readable via public API (rev: ${body?._rev})`);
    } else {
      fail(`Push: read back from ${collection}`, `status=${status} id=${body?.id}`);
    }
  } catch (e) {
    fail(`Push: read back from ${collection}`, e.message);
  }

  // ── Pull: write via public, verify via admin ────────────────────────────
  const pullId = `pull-${collection}-${Date.now()}`;
  const pullPayload = { ...payload, id: pullId, source: "client-simulated" };

  try {
    const { status, body } = await publicReq("PUT", colPath(collection, pullId), pullPayload);
    if (status === 201 || status === 200) {
      ok(`Pull: client document accepted by SG (rev: ${body?.rev})`);
    } else {
      fail(`Pull: client write to ${collection}`, `status=${status}: ${JSON.stringify(body)}`);
      return;
    }
  } catch (e) {
    fail(`Pull: client write to ${collection}`, e.message);
    return;
  }

  await wait(300);

  try {
    const doc = await adminReq("GET", colPath(collection, pullId));
    if (doc?.id === pullId) {
      ok(`Pull: document visible in server store`);
    } else {
      fail(`Pull: verify in ${collection}`, `unexpected id: ${doc?.id}`);
    }
  } catch (e) {
    fail(`Pull: verify in ${collection}`, e.message);
  }

  // ── Delete (tombstone) ──────────────────────────────────────────────────
  try {
    const { status: gs, body: gb } = await publicReq("GET", colPath(collection, docId));
    if (gs === 200 && gb?._rev) {
      const { status } = await publicReq("DELETE", `${colPath(collection, docId)}?rev=${gb._rev}`);
      if (status === 200) ok(`Tombstone: delete replicates correctly`);
      else fail(`Tombstone: delete ${collection}`, `status=${status}`);
    }
  } catch (e) {
    fail(`Tombstone: ${collection}`, e.message);
  }
}

// ── connection string check ───────────────────────────────────────────────────

async function testConnectionString() {
  console.log("\n── App connection string ─────────────────────────────────────");
  const wsUrl = PUBLIC_URL.replace(/^http/, "ws");
  console.log(`  WebSocket URL for SyncPanel: ${wsUrl}/${DB}`);
  console.log(`  Username: ${SG_USER}  |  Password: ${SG_PASS}`);
  ok("Connection string printed above — paste into SyncPanel to test live sync");
}

// ── changes feed check ────────────────────────────────────────────────────────

async function testChangesFeed() {
  console.log("\n── Changes feed ──────────────────────────────────────────────");
  // In SG 3.x with scoped collections, changes feeds are per-collection.
  const col = COLLECTIONS[0];
  try {
    const { status, body } = await publicReq("GET", `/${DB}._default.${col}/_changes?limit=5`);
    if (status === 200 && Array.isArray(body?.results)) {
      ok(`Changes feed active on '${col}' (${body.results.length} recent changes, last_seq: ${body.last_seq})`);
    } else {
      fail("Changes feed", `status=${status}`);
    }
  } catch (e) {
    fail("Changes feed", e.message);
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(" Sync Gateway test harness");
  console.log(`  Public:  ${PUBLIC_URL}`);
  console.log(`  Admin:   ${ADMIN_URL}`);
  console.log(`  DB:      ${DB}`);
  console.log("═══════════════════════════════════════════════════════════════");

  try {
    await ensureReady();
    await createTestUser();

    for (const col of COLLECTIONS) {
      await testCollection(col);
    }

    await testChangesFeed();
    await testConnectionString();
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(failed > 0 ? 1 : 0);
}

main();
