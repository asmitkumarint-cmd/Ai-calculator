import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

import OpenAI from "openai";
import Papa from "papaparse";


// Load .env.local so the script works outside of Next.js
const APP_ROOT = path.resolve(process.cwd());
for (const envFile of [".env.local", ".env"]) {
  try {
    const raw = readFileSync(path.join(APP_ROOT, envFile), "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex < 1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // file not found, skip
  }
}
const SOURCE_ROOT = path.resolve(APP_ROOT, "..");
const APP_DATA_DIR = path.join(APP_ROOT, "app-data");
const LEGACY_DIR = path.join(SOURCE_ROOT, "High Protein Estimator (version 1)");
const TRAIN_METADATA_PATH = path.join(LEGACY_DIR, "train_metadata.csv");
const TRAIN_EMBEDDING_PATH = path.join(LEGACY_DIR, "embedding_train data.csv");
const RECORDS_PATH = path.join(APP_DATA_DIR, "genai-reference-records.json");
const EMBEDDINGS_PATH = path.join(APP_DATA_DIR, "genai-reference-embeddings.f32");
const MANIFEST_PATH = path.join(APP_DATA_DIR, "genai-reference-manifest.json");

const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = Number(process.env.OPENAI_EMBEDDING_DIMENSIONS) || 512;
const BATCH_SIZE = 100;


function normalizeText(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}


function parseNumber(value) {
  if (value == null || value === "") {
    return null;
  }

  const parsed = Number(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}


function priceBand(value) {
  const numeric = parseNumber(value);
  if (numeric == null) {
    return "";
  }

  if (numeric < 100) {
    return "under-100";
  }
  if (numeric < 200) {
    return "100-199";
  }
  if (numeric < 300) {
    return "200-299";
  }
  if (numeric < 500) {
    return "300-499";
  }
  return "500-plus";
}


function cleanValue(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text && text.toLowerCase() !== "nan" ? text : null;
}


function buildTextBlob(row) {
  const parts = [
    `item_name: ${cleanValue(row.ITEM_NAME) || ""}`,
    `item_description: ${cleanValue(row.ITEM_DESCRIPTION) || ""}`,
    `dish_type: ${cleanValue(row.DISH_TYPE) || ""}`,
    `dish_family: ${cleanValue(row.DISH_FAMILY) || ""}`,
    `preparation_style: ${cleanValue(row.DISH_PREPARATION_STYLE) || ""}`,
    `cuisine: ${cleanValue(row.RX_CUISINE) || ""}`,
    `classifier: ${cleanValue(row.RX_CLASSIFIER) || ""}`,
    `segment: ${cleanValue(row.RX_SEGMENTS) || ""}`,
    `item_price_band: ${priceBand(row.ITEM_PRICE)}`,
  ];

  return normalizeText(parts.filter(Boolean).join(" | "));
}


function normalizeVector(vector) {
  const norm = Math.hypot(...vector);
  if (!norm) {
    return vector.map(() => 0);
  }
  return vector.map((value) => value / norm);
}


async function readCsv(csvPath) {
  const raw = await fs.readFile(csvPath, "utf-8");
  const parsed = Papa.parse(raw, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length) {
    throw new Error(`Failed to parse ${path.basename(csvPath)}: ${parsed.errors[0].message}`);
  }

  return parsed.data;
}


async function resolveTrainingRows() {
  try {
    await fs.access(TRAIN_METADATA_PATH);
    return readCsv(TRAIN_METADATA_PATH);
  } catch {
    return readCsv(TRAIN_EMBEDDING_PATH);
  }
}


async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to build GenAI embedding assets.");
  }

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    organization: process.env.OPENAI_ORGANIZATION || undefined,
    project: process.env.OPENAI_PROJECT || process.env.OPENAI_PROJECT_ID || undefined,
  });

  const rows = await resolveTrainingRows();
  const records = rows.map((row, index) => ({
    id: index,
    ITEM_NAME: cleanValue(row.ITEM_NAME),
    ITEM_DESCRIPTION: cleanValue(row.ITEM_DESCRIPTION),
    PROTEIN_GM: parseNumber(row.PROTEIN_GM),
    ENERGY_KCAL: parseNumber(row.ENERGY_KCAL),
    DISH_TYPE: cleanValue(row.DISH_TYPE),
    DISH_FAMILY: cleanValue(row.DISH_FAMILY),
    DISH_PREPARATION_STYLE: cleanValue(row.DISH_PREPARATION_STYLE),
    RX_CUISINE: cleanValue(row.RX_CUISINE),
    RX_CLASSIFIER: cleanValue(row.RX_CLASSIFIER),
    RX_SEGMENTS: cleanValue(row.RX_SEGMENTS),
    ITEM_PRICE: parseNumber(row.ITEM_PRICE),
    price_band: priceBand(row.ITEM_PRICE) || null,
    embedding_text: buildTextBlob(row),
  }));

  const embeddings = [];
  for (let index = 0; index < records.length; index += BATCH_SIZE) {
    const batch = records.slice(index, index + BATCH_SIZE);
    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch.map((record) => record.embedding_text),
      dimensions: EMBEDDING_DIMENSIONS,
    });

    for (const item of response.data) {
      embeddings.push(normalizeVector(item.embedding));
    }

    console.log(`Embedded ${Math.min(index + BATCH_SIZE, records.length)} / ${records.length}`);
  }

  if (!embeddings.length) {
    throw new Error("No embeddings were generated.");
  }

  const dimensions = embeddings[0].length;
  const flat = new Float32Array(records.length * dimensions);
  embeddings.forEach((vector, rowIndex) => {
    flat.set(vector, rowIndex * dimensions);
  });

  await fs.mkdir(APP_DATA_DIR, { recursive: true });
  await fs.writeFile(RECORDS_PATH, JSON.stringify(records, null, 2), "utf-8");
  await fs.writeFile(EMBEDDINGS_PATH, Buffer.from(flat.buffer));
  await fs.writeFile(
    MANIFEST_PATH,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        source: path.relative(APP_ROOT, TRAIN_METADATA_PATH),
        embeddingModel: EMBEDDING_MODEL,
        count: records.length,
        dimensions,
        batchSize: BATCH_SIZE,
        priceStrategy: "price-band-only",
      },
      null,
      2
    ),
    "utf-8"
  );

  console.log(`Wrote ${records.length} reference records to ${RECORDS_PATH}`);
  console.log(`Wrote normalized embedding matrix to ${EMBEDDINGS_PATH}`);
  console.log(`Wrote manifest to ${MANIFEST_PATH}`);
}


main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
