#!/usr/bin/env node
/**
 * Benchmarks the live /api/estimate endpoint against a labeled CSV of menu items.
 *
 * WHERE TO PUT THIS FILE
 *   scripts/benchmark_estimator.mjs, inside the actual rx-restaurant-calorie-portal
 *   project (not a standalone folder), so it can reuse the project's already
 *   installed "papaparse" dependency and sit next to app-data/.
 *
 * BEFORE RUNNING
 *   1. Terminal 1, from the project root: npm run dev
 *      (needs OPENAI_API_KEY set in .env.local)
 *   2. Terminal 2, from the project root:
 *      node scripts/benchmark_estimator.mjs path/to/menu_sections_1_50.csv
 *
 * WHAT THIS ASSUMES ABOUT YOUR CSV
 *   Built against columns: SECTION_NO, ITEM_NAME, ITEM_DESCRIPTION,
 *   RESTAURANT_ID, PROTEIN_GM, ENERGY_KCAL, ITEM_PRICE, ITEM_GRAMMAGE.
 *   RESTAURANT_ID is mapped to RID below. If your real dataset uses a
 *   different header for grammage, ground truth protein, or ground truth
 *   calories, add it to the arrays in the CONFIG section, first match wins.
 */

import fs from "node:fs";
import path from "node:path";
import Papa from "papaparse";
import * as XLSX from "xlsx";

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

// Maps your CSV's column names to what the app's API expects. Left side is
// your CSV's header, right side is the app's field name.
const COLUMN_OVERRIDES = {
  RESTAURANT_ID: "RID",
  REST_ID: "RID",
  RX_CLASIFIER: "RX_CLASSIFIER",
};

// Column(s) the app reads for plated weight. The app itself already accepts
// a few common spellings via its own aliasing, this list is only for names
// outside that, first match wins.
const GRAMMAGE_KEYS = ["ITEM_GRAMMAGE", "item_grammage", "GRAMMAGE", "grammage"];

// Ground truth columns, confirmed against the actual test file. First match wins.
const GROUND_TRUTH_PROTEIN_KEYS = [
  "PROTEIN_GM",
  "PROTEIN_G",
  "PROTEIN_VALUE_IN_GRAM",
  "protein_gm",
  "protein_g",
];
const GROUND_TRUTH_ENERGY_KEYS = [
  "ENERGY_KCAL",
  "energy_kcal",
  "CALORIES",
  "CALORIE_VALUE_IN_KCAL",
  "calories",
];

const API_URL = process.env.BENCHMARK_API_URL || "http://localhost:3000/api/estimate";
const BATCH_SIZE = 50; // matches the API's hard per-request cap, do not raise this
const OUTPUT_CSV = process.env.BENCHMARK_OUTPUT_CSV || "benchmark_results.csv";
const STRIP_BENCHMARK_NUTRITION = process.env.BENCHMARK_STRIP_NUTRITION_FROM_DESCRIPTION === "1";
const REFERENCE_CORPUS_PATH = path.resolve("app-data/genai-reference-records.json");

// ---------------------------------------------------------------------------

function firstMatch(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return null;
}

function firstNumericMatch(row, keys) {
  const raw = firstMatch(row, keys);
  if (raw == null) return null;
  const numeric = Number(String(raw).replace(/[^\d.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

function serializeReferenceItems(items) {
  if (!Array.isArray(items) || !items.length) return "";
  return JSON.stringify(items.map((item, index) => ({
    rank: index + 1,
    name: item.ITEM_NAME ?? null,
    dish_type: item.DISH_TYPE ?? null,
    dish_family: item.DISH_FAMILY ?? null,
    classifier: item.RX_CLASSIFIER ?? null,
    item_price: item.ITEM_PRICE ?? null,
    protein_g: item.PROTEIN_GM ?? null,
    energy_kcal: item.ENERGY_KCAL ?? null,
    semantic_score: item.retrieval_score ?? null,
    reranked_score: item.final_score ?? null,
    price_boost: item.price_rerank_boost ?? null,
    category_boost: item.category_rerank_boost ?? null,
  })));
}

function applyColumnOverrides(row) {
  const mapped = { ...row };
  for (const [from, to] of Object.entries(COLUMN_OVERRIDES)) {
    if (row[from] !== undefined) {
      mapped[to] = row[from];
    }
  }
  return mapped;
}

function normalizeName(value = "") {
  return String(value).trim().toLowerCase().replace(/\s+/g, " ");
}

function stripExplicitNutrition(description = "") {
  return String(description)
    .replace(/\b\d+(?:\.\d+)?\s*(?:g|gm|grams?)\s*(?:of\s*)?protein\b/gi, "")
    .replace(/\bprotein\b[^\d\n]{0,16}\d+(?:\.\d+)?\s*(?:g|gm|grams?)?\b/gi, "")
    .replace(/\b\d+(?:\.\d+)?\s*(?:kcal|kcals|calories?)\b/gi, "")
    .replace(/\b(?:energy|calories?)\b[^\d\n]{0,16}\d+(?:\.\d+)?\s*(?:kcal|kcals)?\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function loadReferenceNameSet() {
  try {
    const raw = fs.readFileSync(REFERENCE_CORPUS_PATH, "utf-8");
    const records = JSON.parse(raw);
    return new Set(records.map((record) => normalizeName(record.ITEM_NAME)));
  } catch (error) {
    console.warn(
      `Could not load ${REFERENCE_CORPUS_PATH} for the overlap check (${error.message}). ` +
        `Run this script from the project root to enable it. Continuing without it.`
    );
    return null;
  }
}

function mean(list) {
  return list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null;
}

function rmse(list) {
  if (!list.length) return null;
  return Math.sqrt(list.reduce((sum, value) => sum + value ** 2, 0) / list.length);
}

// MAPE: skips entries where actual is 0 to avoid division by zero.
// Returns a percentage (e.g. 15.3 means 15.3%).
function mape(absErrors, actuals) {
  const pctErrors = absErrors
    .map((absErr, index) => (actuals[index] !== 0 ? (absErr / Math.abs(actuals[index])) * 100 : null))
    .filter((value) => value !== null);
  return pctErrors.length ? mean(pctErrors) : null;
}

async function postBatch(items) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    return { ok: false, status: response.status, error: parsed || text };
  }
  return { ok: true, payload: parsed };
}

function loadRowsFromFile(filePath) {
  const resolved = path.resolve(filePath);
  const extension = path.extname(resolved).toLowerCase();

  if (extension === ".xlsx" || extension === ".xls") {
    const buffer = fs.readFileSync(resolved);
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      throw new Error(`No sheets found in ${resolved}.`);
    }
    const sheet = workbook.Sheets[sheetName];
    // raw: false so numbers/dates come through as strings, same shape the
    // rest of this script already expects from CSV parsing.
    return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  }

  const raw = fs.readFileSync(resolved, "utf-8");
  const parsedCsv = Papa.parse(raw, { header: true, skipEmptyLines: true });
  if (parsedCsv.errors.length) {
    console.warn(`CSV parse warnings (${parsedCsv.errors.length}), continuing anyway.`);
  }
  return parsedCsv.data;
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error("Usage: node scripts/benchmark_estimator.mjs path/to/dataset.csv (or .xlsx)");
    process.exit(1);
  }

  const loadedRows = loadRowsFromFile(csvPath).map(applyColumnOverrides);
  console.log(`Loaded ${loadedRows.length} rows from ${csvPath}.`);
  console.log(`Explicit nutrition text stripped from descriptions: ${STRIP_BENCHMARK_NUTRITION ? "yes" : "no"}`);

  // Tag every row with its original file position before any filtering, so
  // row_number in the final output always traces back to the source file,
  // even after rows get skipped or deduped below.
  const withOriginalRowNumber = loadedRows.map((row, index) => ({
    ...row,
    __originalRowNumber: index + 1,
  }));

  // Skip (don't hard-fail on) rows missing required fields. Reported in full
  // to skipped_missing_fields.csv, since the API rejects the whole batch a
  // bad row is in, but there's no reason to lose the rest of a 1000+ row
  // file over a handful of bad rows.
  const missingFieldIssues = [];
  const withRequiredFields = [];
  withOriginalRowNumber.forEach((row) => {
    const missing = [];
    if (!row.RID) missing.push("RID");
    if (!row.ITEM_NAME) missing.push("ITEM_NAME");
    if (!row.ITEM_PRICE) missing.push("ITEM_PRICE");
    // ITEM_GRAMMAGE intentionally not checked, no longer a required field.
    if (missing.length) {
      missingFieldIssues.push({ rowNumber: row.__originalRowNumber, missing: missing.join("; ") });
    } else {
      withRequiredFields.push(row);
    }
  });
  if (missingFieldIssues.length) {
    console.warn(
      `\nSkipping ${missingFieldIssues.length} of ${withOriginalRowNumber.length} rows missing required ` +
        `fields, not sent to the API. Full list in skipped_missing_fields.csv. First few:`
    );
    missingFieldIssues.slice(0, 10).forEach((issue) => {
      console.warn(`  Row ${issue.rowNumber}: missing ${issue.missing}`);
    });
    fs.writeFileSync("skipped_missing_fields.csv", Papa.unparse(missingFieldIssues), "utf-8");
  }

  // Dedupe on normalized ITEM_NAME + RID, same dish at the same restaurant
  // listed twice (e.g. across two menu sections) is the same data point for
  // benchmarking purposes, keeping both just double-counts it. Keeps the
  // first occurrence, drops the rest.
  const seenKeys = new Set();
  const duplicateRowNumbers = [];
  const rows = [];
  withRequiredFields.forEach((row) => {
    const key = `${normalizeName(row.ITEM_NAME)}::${String(row.RID).trim()}`;
    if (seenKeys.has(key)) {
      duplicateRowNumbers.push(row.__originalRowNumber);
      return;
    }
    seenKeys.add(key);
    rows.push(row);
  });
  if (duplicateRowNumbers.length) {
    console.warn(
      `\nDropped ${duplicateRowNumbers.length} duplicate rows (same item name + RID as an earlier row). ` +
        `Row numbers: ${duplicateRowNumbers.slice(0, 20).join(", ")}${
          duplicateRowNumbers.length > 20 ? ", ..." : ""
        }`
    );
  }

  if (!rows.length) {
    console.error("\nNo valid rows left after filtering. Nothing to send.");
    process.exit(1);
  }

  console.log(
    `\nProceeding with ${rows.length} rows (of ${loadedRows.length} loaded, ` +
      `${missingFieldIssues.length} skipped for missing fields, ${duplicateRowNumbers.length} duplicates dropped).`
  );

  // Reference corpus overlap check. If test dishes are also in the retrieval
  // corpus, the model can retrieve near-duplicates of the exact answer it's
  // being scored against, which inflates the benchmark.
  const referenceNames = loadReferenceNameSet();
  let overlapCount = 0;

  // Ground truth lookup, keyed by a rowId we control, so results still match
  // up correctly even if a batch partially fails. Uses the original file row
  // number, not the post-filter position, so row_number in the output always
  // means "row N in your source file."
  const groundTruthById = new Map();
  const itemsToSend = rows.map((row) => {
    const rowId = `bench-${row.__originalRowNumber}`;
    const actualProteinG = firstNumericMatch(row, GROUND_TRUTH_PROTEIN_KEYS);
    const actualEnergyKcal = firstNumericMatch(row, GROUND_TRUTH_ENERGY_KEYS);
    const itemName = row.ITEM_NAME || "";

    if (referenceNames && referenceNames.has(normalizeName(itemName))) {
      overlapCount += 1;
    }

    groundTruthById.set(rowId, {
      rowNumber: row.__originalRowNumber,
      itemName,
      actualProteinG,
      actualEnergyKcal,
    });

    return {
      ...row,
      ITEM_DESCRIPTION: STRIP_BENCHMARK_NUTRITION ? stripExplicitNutrition(row.ITEM_DESCRIPTION || "") : row.ITEM_DESCRIPTION,
      rowId,
    };
  });

  const missingGroundTruth = [...groundTruthById.values()].filter(
    (g) => g.actualProteinG == null && g.actualEnergyKcal == null
  ).length;
  if (missingGroundTruth) {
    console.warn(
      `Warning: ${missingGroundTruth} of ${rows.length} rows had no ground truth matched. ` +
        `Check GROUND_TRUTH_PROTEIN_KEYS / GROUND_TRUTH_ENERGY_KEYS at the top of this script.`
    );
  }
  if (referenceNames) {
    console.log(
      `Reference corpus overlap check: ${overlapCount} of ${rows.length} item names exactly ` +
        `match a name already in the retrieval corpus (genai-reference-records.json).`
    );
  }

  console.log(`Sending to ${API_URL} in batches of ${BATCH_SIZE}...`);

  const allResults = [];
  const failedRowIds = [];
  let icmrMatchModeSeen = null;
  const retrievalModesSeen = new Set();
  const totalBatches = Math.ceil(itemsToSend.length / BATCH_SIZE);

  for (let i = 0; i < itemsToSend.length; i += BATCH_SIZE) {
    const batch = itemsToSend.slice(i, i + BATCH_SIZE);
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    console.log(`Batch ${batchNumber}/${totalBatches} (${batch.length} items)...`);

    const result = await postBatch(batch);
    if (!result.ok) {
      console.error(`Batch ${batchNumber} failed (status ${result.status}):`, result.error);
      failedRowIds.push(...batch.map((item) => item.rowId));
      continue;
    }

    allResults.push(...(result.payload?.results || []));
    if (result.payload?.estimator?.icmrMatchMode) {
      icmrMatchModeSeen = result.payload.estimator.icmrMatchMode;
    }
    if (result.payload?.estimator?.retrievalMode) {
      retrievalModesSeen.add(result.payload.estimator.retrievalMode);
    }
  }

  if (failedRowIds.length) {
    console.warn(`${failedRowIds.length} rows failed at the batch level and are excluded from scoring.`);
  }

  console.log(`Received ${allResults.length} results. Scoring against ground truth...`);

  const retrievalModeLabel = [...retrievalModesSeen].join(", ") || "not reported by API";
  console.log(`Retrieval mode reported by API: ${retrievalModeLabel}`);
  const nutrientSpecificReferenceRows = allResults.filter((result) =>
    Array.isArray(result.explainability?.retrieval?.protein_neighbors) &&
    Array.isArray(result.explainability?.retrieval?.energy_neighbors)
  ).length;
  console.log(`Rows with separate protein and energy reference lists: ${nutrientSpecificReferenceRows} of ${allResults.length}`);
  const expectedRetrievalMode = process.env.BENCHMARK_EXPECT_RETRIEVAL_MODE;
  if (expectedRetrievalMode && (
    retrievalModesSeen.size !== 1 ||
    !retrievalModesSeen.has(expectedRetrievalMode)
  )) {
    console.error(
      `Benchmark stopped: expected retrieval mode "${expectedRetrievalMode}" but API reported "${retrievalModeLabel}". ` +
      `Check the Terminal 1 server, its port, and RID_RX_CATEGORY_MODE.`
    );
    process.exit(1);
  }

  // Rows that came back with a 200 but individually failed estimation look
  // structurally different, no estimated_protein_g, no confidence_band, no
  // explainability, just estimation_status/error_code/error_message. Surface
  // that here instead of letting it silently show up as "n/a" everywhere.
  const rowLevelFailures = allResults.filter((r) => r.estimation_status === "failed");
  if (rowLevelFailures.length) {
    console.error(
      `\n${rowLevelFailures.length} of ${allResults.length} rows came back with estimation_status: "failed". ` +
        `Sample error from row ${rowLevelFailures[0].result_key}:`
    );
    console.error(`  error_code: ${rowLevelFailures[0].error_code}`);
    console.error(`  error_message: ${rowLevelFailures[0].error_message}`);
    if (rowLevelFailures.length === allResults.length) {
      console.error(
        "  Every row failed identically, which usually means the batched embeddings call or the OpenAI " +
          "client itself is failing before any per-item work happens (bad or missing OPENAI_API_KEY, no " +
          "quota, or the dev server wasn't restarted after adding .env.local). Check the error_message above first."
      );
    }
  }

  const scored = allResults.map((result) => {
    const truth = groundTruthById.get(result.result_key) || {};
    const predictedProteinG = result.estimated_protein_g;
    const predictedEnergyKcal = result.estimated_energy_kcal;

    const proteinAbsError =
      truth.actualProteinG != null && predictedProteinG != null
        ? Math.abs(predictedProteinG - truth.actualProteinG)
        : null;
    const energyAbsError =
      truth.actualEnergyKcal != null && predictedEnergyKcal != null
        ? Math.abs(predictedEnergyKcal - truth.actualEnergyKcal)
        : null;

    // Per-row percentage errors (null if actual is 0 or either value is missing).
    const proteinPctError =
      proteinAbsError != null && truth.actualProteinG !== 0
        ? (proteinAbsError / Math.abs(truth.actualProteinG)) * 100
        : null;
    const energyPctError =
      energyAbsError != null && truth.actualEnergyKcal !== 0
        ? (energyAbsError / Math.abs(truth.actualEnergyKcal)) * 100
        : null;

    return {
      row_number: truth.rowNumber ?? null,
      rid: result.row_id,
      item_name: result.input_name,
      estimation_status: result.estimation_status ?? "ok",
      error_code: result.error_code ?? null,
      error_message: result.error_message ?? null,
      actual_protein_g: truth.actualProteinG ?? null,
      predicted_protein_g: predictedProteinG ?? null,
      protein_abs_error: proteinAbsError,
      protein_pct_error: proteinPctError != null ? parseFloat(proteinPctError.toFixed(2)) : null,
      actual_energy_kcal: truth.actualEnergyKcal ?? null,
      predicted_energy_kcal: predictedEnergyKcal ?? null,
      energy_abs_error: energyAbsError,
      energy_pct_error: energyPctError != null ? parseFloat(energyPctError.toFixed(2)) : null,
      confidence_band: result.confidence_band ?? null,
      protein_confidence_band: result.output?.confidence_detail?.protein_confidence?.band ?? null,
      energy_confidence_band: result.output?.confidence_detail?.energy_confidence?.band ?? null,
      similar_items_found: result.explainability?.retrieval?.neighbors?.length ?? 0,
      nutrient_specific_reference_status: Array.isArray(result.explainability?.retrieval?.protein_neighbors) &&
        Array.isArray(result.explainability?.retrieval?.energy_neighbors) ? "available" : "not_enabled",
      selected_reference_items: serializeReferenceItems(result.explainability?.retrieval?.neighbors),
      protein_reference_items: serializeReferenceItems(result.explainability?.retrieval?.protein_neighbors),
      energy_reference_items: serializeReferenceItems(result.explainability?.retrieval?.energy_neighbors),
      active_menu_hits: result.explainability?.retrieval?.active_menu_context?.length ?? 0,
      icmr_hits: result.explainability?.retrieval?.icmr_matches?.length ?? 0,
      top_similarity_percent: result.explainability?.scoring_snapshot?.top_neighbor_similarity ?? null,
    };
  });

  const withProteinError = scored.filter((r) => r.protein_abs_error != null).map((r) => r.protein_abs_error);
  const withProteinActual = scored.filter((r) => r.protein_abs_error != null).map((r) => r.actual_protein_g);
  const withEnergyError = scored.filter((r) => r.energy_abs_error != null).map((r) => r.energy_abs_error);
  const withEnergyActual = scored.filter((r) => r.energy_abs_error != null).map((r) => r.actual_energy_kcal);

  const proteinMape = mape(withProteinError, withProteinActual);
  const energyMape = mape(withEnergyError, withEnergyActual);

  const zeroHitRate = (key) =>
    scored.length ? (scored.filter((r) => r[key] === 0).length / scored.length) * 100 : null;

  const bandCounts = scored.reduce((acc, r) => {
    const band = r.confidence_band || "unknown";
    acc[band] = (acc[band] || 0) + 1;
    return acc;
  }, {});

  console.log("\n=== Benchmark summary ===");
  if (icmrMatchModeSeen) {
    console.log(`ICMR match mode for this run: ${icmrMatchModeSeen}`);
  }
  console.log(`Rows scored: ${scored.length} (of ${rows.length} loaded, ${failedRowIds.length} failed to estimate)`);
  console.log(
    `Protein: MAE ${mean(withProteinError)?.toFixed(2) ?? "n/a"} g, RMSE ${
      rmse(withProteinError)?.toFixed(2) ?? "n/a"
    } g, MAPE ${proteinMape?.toFixed(2) ?? "n/a"}%, n=${withProteinError.length}`
  );
  console.log(
    `Energy:  MAE ${mean(withEnergyError)?.toFixed(2) ?? "n/a"} kcal, RMSE ${
      rmse(withEnergyError)?.toFixed(2) ?? "n/a"
    } kcal, MAPE ${energyMape?.toFixed(2) ?? "n/a"}%, n=${withEnergyError.length}`
  );
  console.log(`Rows with zero active menu retrieval hits: ${zeroHitRate("active_menu_hits")?.toFixed(1) ?? "n/a"}%`);
  console.log(`Rows with zero ICMR retrieval hits: ${zeroHitRate("icmr_hits")?.toFixed(1) ?? "n/a"}%`);
  console.log("Confidence band distribution:", bandCounts);
  if (referenceNames) {
    console.log(`Reference corpus name overlap: ${overlapCount} of ${rows.length} rows`);
  }

  const outputPath = icmrMatchModeSeen
    ? OUTPUT_CSV.replace(/\.csv$/, `_${icmrMatchModeSeen}.csv`)
    : OUTPUT_CSV;
  const csvOut = Papa.unparse(scored);
  fs.writeFileSync(outputPath, csvOut, "utf-8");
  console.log(`\nPer-row results written to ${outputPath}`);
}

main().catch((error) => {
  console.error("Benchmark run failed:", error);
  process.exit(1);
});
