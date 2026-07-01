/**
 * copy-disease-profiles.mjs
 *
 * Copies the plantkb pipeline's Couchbase-ready NDJSON export into public/
 * so seedDiseaseKbIfEmpty() (src/lib/db.ts) can fetch and seed it at app
 * startup. Validates every line parses as JSON before writing, so a broken
 * plantkb run fails here instead of silently seeding garbage.
 *
 * Usage:
 *   node scripts/copy-disease-profiles.mjs [--in plantkb/build/couchbase/disease_profiles.ndjson] [--out public/disease-profiles.ndjson]
 *
 * Input:  plantkb/build/couchbase/disease_profiles.ndjson
 *         (generate it first: see plantkb/README.md — `python -m agronomy_pipeline run`)
 * Output: public/disease-profiles.ndjson
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const IN = path.resolve(ROOT, args[args.indexOf("--in") + 1] || "plantkb/build/couchbase/disease_profiles.ndjson");
const OUT = path.resolve(ROOT, args[args.indexOf("--out") + 1] || "public/disease-profiles.ndjson");

if (!fs.existsSync(IN)) {
  console.error(`Input not found: ${IN}`);
  console.error("Generate it first — see plantkb/README.md:");
  console.error("  cd plantkb && python -m agronomy_pipeline run --seed data/seed_index.json --sources data/sources --out build/couchbase");
  process.exit(1);
}

const lines = fs.readFileSync(IN, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);

let diseaseCount = 0;
let healthyCount = 0;
for (const [i, line] of lines.entries()) {
  let doc;
  try {
    doc = JSON.parse(line);
  } catch (e) {
    console.error(`Line ${i + 1} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  if (!doc.id || !doc.type) {
    console.error(`Line ${i + 1} is missing "id" or "type": ${line.slice(0, 100)}`);
    process.exit(1);
  }
  if (doc.type === "disease_profile") diseaseCount++;
  else if (doc.type === "healthy_profile") healthyCount++;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.copyFileSync(IN, OUT);
console.log(`Copied ${lines.length} profiles (${diseaseCount} disease, ${healthyCount} healthy) → ${path.relative(ROOT, OUT)}`);
