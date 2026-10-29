#!/usr/bin/env node
/**
 * Verifies a new ICMR-format CSV parses correctly against the exact columns
 * the app actually reads, BEFORE you spend a benchmark run on it. A header
 * name that's off by casing or spelling will silently produce empty names or
 * null macros for every row, with no error anywhere, this catches that here
 * instead of in a confusing benchmark result.
 *
 * Usage: node scripts/verify_icmr_file.mjs app-data/ifct_icmr_format.csv
 */

import fs from "node:fs";
import path from "node:path";
import Papa from "papaparse";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: node scripts/verify_icmr_file.mjs path/to/your_file.csv");
  process.exit(1);
}

const raw = fs.readFileSync(path.resolve(filePath), "utf-8");
const parsed = Papa.parse(raw, { header: true, skipEmptyLines: true });

if (parsed.errors.length) {
  console.warn(`CSV parse warnings (${parsed.errors.length}):`, parsed.errors.slice(0, 3));
}

console.log(`Headers found: ${parsed.meta.fields.join(", ")}`);
console.log(`Row count: ${parsed.data.length}`);

// Exact columns the app reads, mirrored from readIcmr() in lib/genai-estimator.js
const rows = parsed.data.map((row) => ({
  name: row.Ingredient_name || row.ingredient_name || "",
  protein_per_100g: Number(row.protein_per_100g),
  energy_per_100g: Number(row.energy_per_100g),
  carbs_per_100g: Number(row.carbs_per_100g),
  fat_per_100g: Number(row.fat_per_100g),
}));

const emptyNames = rows.filter((r) => !r.name).length;
const badProtein = rows.filter((r) => !Number.isFinite(r.protein_per_100g)).length;
const badEnergy = rows.filter((r) => !Number.isFinite(r.energy_per_100g)).length;

console.log(`\nRows with empty name: ${emptyNames} of ${rows.length}`);
console.log(`Rows with non-numeric protein_per_100g: ${badProtein} of ${rows.length}`);
console.log(`Rows with non-numeric energy_per_100g: ${badEnergy} of ${rows.length}`);

console.log("\nFirst 3 parsed rows (this is exactly what the app will see):");
console.log(rows.slice(0, 3));

if (emptyNames > 0 || badProtein > 0 || badEnergy > 0) {
  console.error(
    "\nSomething doesn't match the expected format. Check your CSV's header row against: " +
      "Ingredient_name (or ingredient_name), protein_per_100g, energy_per_100g, carbs_per_100g, fat_per_100g."
  );
  process.exit(1);
}

console.log("\nLooks good, columns match what the app expects.");
