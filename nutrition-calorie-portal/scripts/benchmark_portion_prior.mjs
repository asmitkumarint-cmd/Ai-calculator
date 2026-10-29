#!/usr/bin/env node
/**
 * Deterministic, grouped holdout evaluation of the similar-reference estimator
 * and price/category prior. Excludes nutrition-bearing descriptions and keeps
 * every normalized item name entirely in either train or test.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { estimatePortionAdjustment, fitPortionPrior, getPriceBand } from "../lib/portion-prior.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const records = JSON.parse(fs.readFileSync(path.join(root, "app-data/genai-reference-records.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "app-data/genai-reference-manifest.json"), "utf8"));
const rawEmbeddings = fs.readFileSync(path.join(root, "app-data/genai-reference-embeddings.f32"));
const embeddings = new Float32Array(rawEmbeddings.buffer, rawEmbeddings.byteOffset, rawEmbeddings.byteLength / 4);
if (records.length !== manifest.count || embeddings.length !== manifest.count * manifest.dimensions) {
  throw new Error("Reference assets do not match their manifest.");
}

const normalizeName = (value = "") => String(value).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const hash = (value) => crypto.createHash("sha256").update(`rid-price-prior-v1:${value}`).digest().readUInt32BE(0);
const containsNutritionLabels = (description = "") =>
  /\b(?:energy|calories?)\D{0,16}\d|\d+(?:\.\d+)?\s*(?:kcal|calories?)\b|\bprotein\D{0,16}\d|\d+(?:\.\d+)?\s*(?:g|gm|grams?)\s*protein\b/i.test(description);
const labels = records.map((row) => ({
  protein: Number(row.PROTEIN_GM),
  kcal: Number(row.ENERGY_KCAL),
}));
const train = [];
const heldout = [];
const excludedNutritionNameGroups = [];
const nameGroups = new Map();
for (let index = 0; index < records.length; index += 1) {
  const name = normalizeName(records[index].ITEM_NAME);
  if (!name || !Number.isFinite(labels[index].protein) || !Number.isFinite(labels[index].kcal)) continue;
  if (!nameGroups.has(name)) nameGroups.set(name, []);
  nameGroups.get(name).push(index);
}
for (const [name, indexes] of nameGroups) {
  if (hash(name) % 5 === 0) {
    if (indexes.some((index) => containsNutritionLabels(records[index].ITEM_DESCRIPTION || ""))) {
      excludedNutritionNameGroups.push(name);
    } else {
      heldout.push(...indexes);
    }
  } else {
    train.push(...indexes);
  }
}
if (!heldout.length || !train.length) throw new Error("Grouped holdout produced an empty split.");
const prior = fitPortionPrior(train.map((index) => records[index]));

function similarity(indexA, indexB) {
  let score = 0;
  const a = indexA * manifest.dimensions;
  const b = indexB * manifest.dimensions;
  for (let k = 0; k < manifest.dimensions; k += 1) score += embeddings[a + k] * embeddings[b + k];
  return score;
}

function predict(index) {
  const row = records[index];
  const name = normalizeName(row.ITEM_NAME);
  const neighbors = train
    .filter((candidateIndex) => normalizeName(records[candidateIndex].ITEM_NAME) !== name)
    .map((candidateIndex) => ({ index: candidateIndex, retrieval_score: similarity(index, candidateIndex) }))
    .sort((a, b) => b.retrieval_score - a.retrieval_score)
    .slice(0, 3)
    .map(({ index: candidateIndex, retrieval_score }) => ({ ...records[candidateIndex], retrieval_score }));
  const weights = neighbors.map((neighbor) => Math.max(0, neighbor.retrieval_score) ** 2);
  const weighted = (key) => {
    const usable = neighbors.map((neighbor, i) => ({ value: Number(neighbor[key]), weight: weights[i] }))
      .filter((entry) => Number.isFinite(entry.value) && entry.value > 0 && entry.weight > 0);
    const denominator = usable.reduce((sum, entry) => sum + entry.weight, 0);
    return denominator ? usable.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / denominator : null;
  };
  const base = { protein: weighted("PROTEIN_GM"), kcal: weighted("ENERGY_KCAL") };
  const item = { price: row.ITEM_PRICE, restaurantClassifier: row.RX_CLASSIFIER };
  const variants = {
    reference: { ...base },
    price_only: estimatePortionAdjustment({ item, neighbors, prior, useCategory: false }),
    category_only: estimatePortionAdjustment({ item, neighbors, prior, usePrice: false }),
    both: estimatePortionAdjustment({ item, neighbors, prior }),
  };
  for (const key of ["price_only", "category_only", "both"]) {
    variants[key] = {
      protein: base.protein == null ? null : base.protein * variants[key].protein_multiplier,
      kcal: base.kcal == null ? null : base.kcal * variants[key].calorie_multiplier,
    };
  }
  return { row, base, variants };
}

const evaluated = heldout.map(predict).filter(({ base }) => base.protein != null && base.kcal != null);
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
function metrics(rows, field) {
  const actuals = rows.map(({ row }) => Number(field === "protein" ? row.PROTEIN_GM : row.ENERGY_KCAL));
  const predictions = rows.map(({ variants }) => variants[field]);
  const errors = predictions.map((value, index) => value == null ? null : value - actuals[index]).filter((value) => value != null);
  const abs = errors.map(Math.abs);
  const actualForErrors = errors.map((_, index) => actuals[index]);
  return {
    n: errors.length,
    mae: mean(abs),
    rmse: errors.length ? Math.sqrt(mean(errors.map((value) => value ** 2))) : null,
    mape: mean(abs.map((error, index) => actualForErrors[index] > 0 ? error / actualForErrors[index] * 100 : null).filter(Number.isFinite)),
  };
}
const systems = Object.fromEntries(["reference", "price_only", "category_only", "both"].map((system) => {
  const rows = evaluated.map(({ row, variants }) => ({ row, variants: { ["protein"]: variants[system].protein, ["kcal"]: variants[system].kcal } }));
  return [system, { calories: metrics(rows, "kcal"), protein: metrics(rows, "protein") }];
}));

function groupMetrics(key, minN = 20) {
  const grouped = new Map();
  for (const result of evaluated) {
    const value = String(result.row[key] || "unknown").trim() || "unknown";
    if (!grouped.has(value)) grouped.set(value, []);
    grouped.get(value).push(result);
  }
  return Object.fromEntries([...grouped].filter(([, rows]) => rows.length >= minN).map(([name, rows]) => [name, {
    n: rows.length,
    referenceCaloriesMae: metrics(rows.map(({ row, variants }) => ({ row, variants: { kcal: variants.reference.kcal } })), "kcal").mae,
    bothCaloriesMae: metrics(rows.map(({ row, variants }) => ({ row, variants: { kcal: variants.both.kcal } })), "kcal").mae,
    referenceProteinMae: metrics(rows.map(({ row, variants }) => ({ row, variants: { protein: variants.reference.protein } })), "protein").mae,
    bothProteinMae: metrics(rows.map(({ row, variants }) => ({ row, variants: { protein: variants.both.protein } })), "protein").mae,
  }]));
}

const missingPriceRows = evaluated.filter(({ row }) => !getPriceBand(row.ITEM_PRICE));
const unknownCategoryRows = evaluated.filter(({ row }) => !row.RX_CLASSIFIER || String(row.RX_CLASSIFIER).toLowerCase() === "unclassified");
console.log(JSON.stringify({
  evaluation: "8,152 reference corpus only; deterministic grouped 80/20 name holdout; no explicit nutrition figures in held-out descriptions; retrieval and prior fitting use train rows only",
  seed: "rid-price-prior-v1",
  counts: { corpus: records.length, trainRecords: train.length, heldoutRecords: heldout.length, heldoutNameGroupsExcludedForNutritionInDescription: excludedNutritionNameGroups.length, evaluated: evaluated.length },
  systems,
  fallback: {
    missingPrice: { n: missingPriceRows.length, referenceCaloriesMae: metrics(missingPriceRows.map(({ row, variants }) => ({ row, variants: { kcal: variants.reference.kcal } })), "kcal").mae, bothCaloriesMae: metrics(missingPriceRows.map(({ row, variants }) => ({ row, variants: { kcal: variants.both.kcal } })), "kcal").mae },
    unknownCategory: { n: unknownCategoryRows.length, bothCaloriesMae: metrics(unknownCategoryRows.map(({ row, variants }) => ({ row, variants: { kcal: variants.both.kcal } })), "kcal").mae },
    ridMappingCoverage: "not measurable on this corpus: reference records contain no restaurant RID",
  },
  byDishFamily: groupMetrics("DISH_FAMILY"),
  byRestaurantCategory: groupMetrics("RX_CLASSIFIER"),
}, null, 2));
