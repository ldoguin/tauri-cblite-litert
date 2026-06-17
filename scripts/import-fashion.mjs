/**
 * import-fashion.mjs
 *
 * Converts the Myntra Fashion Product Images (small) dataset into the
 * Product seed JSON consumed by the retail screen.
 *
 * Usage:
 *   node scripts/import-fashion.mjs [--limit 500] [--out public/products-seed.json]
 *
 * Input:  data/fashionsmall/styles.csv
 *         data/fashionsmall/images/<id>.jpg
 * Output: public/products-seed.json   (array of Product objects)
 */

import fs             from "fs";
import path            from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "..");

// ── CLI args ─────────────────────────────────────────────────────────────────

const args  = process.argv.slice(2);
const LIMIT = parseInt(args[args.indexOf("--limit") + 1] || "500", 10);
const OUT   = path.resolve(ROOT, args[args.indexOf("--out") + 1] || "public/products-seed.json");
const CSV   = path.join(ROOT, "data/fashionsmall/styles.csv");
const IMG   = path.join(ROOT, "data/fashionsmall/images");

// ── Category mapping ──────────────────────────────────────────────────────────

const SUB_TO_CATEGORY = {
  "Topwear":                  "Tops",
  "Bottomwear":               "Bottoms",
  "Dress":                    "Dresses",
  "Loungewear and Nightwear": "Activewear",
  "Innerwear":                "Activewear",
  "Saree":                    "Dresses",
  "Apparel Set":              "Formal",
  "Socks":                    "Activewear",
  "Shoes":                    "Footwear",
  "Flip Flops":               "Footwear",
  "Sandal":                   "Footwear",
};

function mapCategory(masterCategory, subCategory, usage) {
  if (masterCategory === "Footwear") return "Footwear";
  if (usage === "Formal" || usage === "Smart Casual") return "Formal";
  return SUB_TO_CATEGORY[subCategory] ?? "Tops";
}

// ── Price generation (deterministic, plausible) ───────────────────────────────

const BASE_PRICE = {
  Tops:       [19.99, 89.99],
  Bottoms:    [29.99, 99.99],
  Dresses:    [39.99, 129.99],
  Outerwear:  [79.99, 199.99],
  Activewear: [24.99, 69.99],
  Formal:     [59.99, 199.99],
  Footwear:   [29.99, 149.99],
};

function price(id, category) {
  const [lo, hi] = BASE_PRICE[category] ?? [19.99, 99.99];
  const t = (parseInt(id, 10) * 17 % 100) / 100;
  return (lo + t * (hi - lo)).toFixed(2);
}

// ── Description builder ───────────────────────────────────────────────────────

function buildDescription(row) {
  const parts = [];
  if (row.gender && row.gender !== "Unisex") parts.push(`${row.gender}'s`);
  if (row.baseColour)  parts.push(row.baseColour);
  if (row.articleType) parts.push(row.articleType);
  const tail = [];
  if (row.usage)  tail.push(`for ${row.usage.toLowerCase()} wear`);
  if (row.season) tail.push(`(${row.season} collection)`);
  return [parts.join(" "), ...tail].filter(Boolean).join(", ");
}

// ── CSV parser ────────────────────────────────────────────────────────────────

function parseCSV(filePath) {
  const text  = fs.readFileSync(filePath, "utf-8");
  const lines = text.trim().split("\n");
  return lines.slice(1).map((line) => {
    const parts = line.split(",");
    return {
      id:                 parts[0]?.trim(),
      gender:             parts[1]?.trim(),
      masterCategory:     parts[2]?.trim(),
      subCategory:        parts[3]?.trim(),
      articleType:        parts[4]?.trim(),
      baseColour:         parts[5]?.trim(),
      season:             parts[6]?.trim(),
      year:               parts[7]?.trim(),
      usage:              parts[8]?.trim(),
      // productDisplayName may contain commas — join everything after field 9
      productDisplayName: parts.slice(9).join(",").trim(),
    };
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

const rows     = parseCSV(CSV);
const now      = new Date().toISOString();
const products = [];
let   skipped  = 0;

for (const row of rows) {
  if (products.length >= LIMIT) break;

  // Only clothing and footwear
  if (row.masterCategory !== "Apparel" && row.masterCategory !== "Footwear") continue;
  if (!row.productDisplayName) continue;

  const imgPath = path.join(IMG, `${row.id}.jpg`);
  if (!fs.existsSync(imgPath)) { skipped++; continue; }

  const imgBytes  = fs.readFileSync(imgPath);
  const imageRef  = `data:image/jpeg;base64,${imgBytes.toString("base64")}`;
  // Source images in this dataset are already 60×80px — a 32×32 thumb would be
  // negligibly smaller and slow down the import significantly. Skip thumbnails.
  const category  = mapCategory(row.masterCategory, row.subCategory, row.usage);

  products.push({
    id:          `fashion-${row.id}`,
    name:        row.productDisplayName,
    description: buildDescription(row),
    category,
    price:       parseFloat(price(row.id, category)),
    imageRef,
    createdAt:   now,
  });

  if (products.length % 50 === 0) {
    process.stdout.write(`\r  ${products.length}/${LIMIT} products…`);
  }
}

process.stdout.write("\n");
console.log(`Skipped ${skipped} rows (missing image)`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(products));

const sizeKB = Math.round(fs.statSync(OUT).size / 1024);
console.log(`Wrote ${products.length} products → ${OUT} (${sizeKB} KB)`);
