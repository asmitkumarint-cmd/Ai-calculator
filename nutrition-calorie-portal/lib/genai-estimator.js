import { cache } from "react";
import fs from "node:fs/promises";
import path from "node:path";

import OpenAI from "openai";
import Papa from "papaparse";
import { estimatePortionAdjustment, fitPortionPrior } from "@/lib/portion-prior.mjs";
import { decodeRidClassifierAsset } from "@/lib/rid-rx-mapping.mjs";
import { scoreNeighbor } from "@/lib/retrieval-priority.mjs";

const APP_DATA_DIR = path.join(process.cwd(), "app-data");
// Defaults to the original 41-row file. Point this at a larger reference
// file (same column format) to benchmark it without losing the original,
// same pattern as ICMR_MATCH_MODE and RETRIEVAL_DISH_METADATA.
const ICMR_FILENAME = process.env.ICMR_REFERENCE_FILE || "icmr-reference.csv";
const ICMR_PATH = path.join(APP_DATA_DIR, ICMR_FILENAME);
const RECORDS_PATH = path.join(APP_DATA_DIR, "genai-reference-records.json");
const EMBEDDINGS_PATH = path.join(APP_DATA_DIR, "genai-reference-embeddings.f32");
const MANIFEST_PATH = path.join(APP_DATA_DIR, "genai-reference-manifest.json");
const ACTIVE_MENU_CATALOG_PATH = path.join(APP_DATA_DIR, "active-menu-catalog.json");
const RID_RX_MAPPING_PATH = path.join(APP_DATA_DIR, "rid-rx-classifier.bin.gz");
const requestedPortionPriorMode = (process.env.PORTION_PRIOR_MODE || "off").toLowerCase();
const PORTION_PRIOR_MODE = ["off", "on", "reference"].includes(requestedPortionPriorMode)
  ? requestedPortionPriorMode
  : "off";
// RID-RX category preference is enabled by default on top of ICMR embedding
// retrieval; set RID_RX_CATEGORY_MODE=0 to explicitly disable it.
const RID_RX_CATEGORY_MODE_ENABLED = process.env.RID_RX_CATEGORY_MODE !== "0";
const RID_PRICE_RERANK_ENABLED = true;
const RID_CATEGORY_RERANK_ENABLED = RID_RX_CATEGORY_MODE_ENABLED;
const ITEM_PRICE_RERANK_ENABLED = true;
const PORTION_NUTRITION_ADJUSTMENT_ENABLED = process.env.PORTION_NUTRITION_ADJUSTMENT == null
  ? PORTION_PRIOR_MODE === "on"
  : process.env.PORTION_NUTRITION_ADJUSTMENT === "1";
const RID_CATEGORY_CONTEXT_ENABLED = RID_RX_CATEGORY_MODE_ENABLED;
const RID_MAPPING_REQUIRED = RID_CATEGORY_RERANK_ENABLED || PORTION_NUTRITION_ADJUSTMENT_ENABLED;
const EXCLUDE_EXACT_REFERENCE_NAMES = process.env.GENAI_EXCLUDE_EXACT_REFERENCE_NAMES === "1";
const CATEGORY_RERANK_BOOST = Number(process.env.CATEGORY_RERANK_BOOST ?? 0.04);

const DEFAULT_RESPONSES_MODEL = process.env.OPENAI_RESPONSES_MODEL || "gpt-4.1-mini";
const DEFAULT_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const DEFAULT_BACKEND_MODE = process.env.OPENAI_NUTRITION_BACKEND || "auto";
// "keyword" (default) uses the existing token/dice-score ICMR matcher.
// "embedding" uses the new similarity-search matcher below. Both stay in the
// code so results can be benchmarked against each other.
const ICMR_MATCH_MODE = (process.env.ICMR_MATCH_MODE || "embedding").toLowerCase();
// Starting guess, not a verified value. Embedding similarity scores aren't on
// the same scale as the 0.55 threshold used for the keyword matcher, this
// needs tuning against real benchmark runs, don't treat it as calibrated.
const ICMR_EMBEDDING_THRESHOLD = Number(process.env.ICMR_EMBEDDING_THRESHOLD) || 0.3;
// "off" (default) keeps the original query embedding text, unchanged since
// before step 1. "on" enriches it with dish_type, dish_family,
// preparation_style, classifier, and segment, mirroring exactly what the
// reference corpus itself was embedded with (see buildTextBlob in
// scripts/build_genai_assets.mjs). Step 1 found 4 of these 5 fields actively
// hurt when shown directly to the model in the prompt, that doesn't
// necessarily mean they hurt retrieval too, but don't assume it helps either,
// benchmark both settings the same way step 1 was benchmarked.
const RETRIEVAL_DISH_METADATA_MODE = (process.env.RETRIEVAL_DISH_METADATA || "off").toLowerCase();
const TOP_K_NEIGHBORS = 3;
const TOP_K_ACTIVE_MENU_CANDIDATES = 5;
// Both supported modes use the recorded top-eight candidate window.
const RERANK_CANDIDATES = 8;
const MAX_CONCURRENCY = 3;
const ESTIMATE_CACHE_LIMIT = 300;
const TRANSIENT_RETRY_DELAYS_MS = [300, 900];
const portionPriorExclusionCache = new Map();

const HELPER_RULES = [
  {
    id: "traditional-dosa",
    text: "Traditional rice-lentil dosas with potato masala are carb-forward, not high-protein dishes. A standard masala dosa usually stays around 6-10 g protein and 300-430 kcal per serving unless paneer, cheese, egg, meat, keto, protein, ghee, butter, or other rich add-ons are explicit.",
    keywords: ["dosa", "masala dosa", "mysore masala dosa", "rava dosa", "paper dosa", "uthappam", "uttapam"],
  },
  {
    id: "paneer-curries",
    text: "Paneer curries often land around 15-20 g protein and 500-700 kcal per serving, depending on gravy richness and portion size.",
    keywords: ["paneer", "butter masala", "tikka masala", "kadhai", "curry"],
  },
  {
    id: "chicken-biryani",
    text: "Chicken biryani often lands around 25-35 g protein and 650-800 kcal per serving, depending on rice quantity and oil or ghee use.",
    keywords: ["biryani", "chicken"],
  },
  {
    id: "dal-lentil",
    text: "Dal and lentil bowls often land around 10-15 g protein and 300-450 kcal per serving, depending on tempering fat and serving size.",
    keywords: ["dal", "lentil", "rajma", "chole"],
  },
  {
    id: "fried-snacks",
    text: "Fried snack portions often land around 4-8 g protein and 200-350 kcal per serving, depending on filling and fry medium.",
    keywords: ["fried", "pakoda", "samosa", "roll", "snack"],
  },
  {
    id: "fried-rice-noodles",
    text: "Fried rice and noodle mains usually depend on rice or noodle volume, added oil, and protein mix, so calories can rise quickly even when protein stays moderate.",
    keywords: ["fried rice", "noodles", "hakka", "rice", "schezwan"],
  },
];

const DEFAULT_HELPER_RULES = [
  {
    id: "generic-portion-context",
    text: "When no dish-family helper matches, rely on the item name, description, grammage, ingredient grams, retrieved references, and ICMR ingredients. Do not borrow protein or calorie ranges from unrelated dish families.",
    keywords: [],
  },
];

const TRADITIONAL_MASALA_DOSA_EXCLUSION_TERMS = [
  "paneer",
  "cheese",
  "chicken",
  "egg",
  "mutton",
  "fish",
  "prawn",
  "shrimp",
  "keto",
  "protein",
  "tofu",
  "soya",
  "soy",
  "bhurji",
  "curry",
  "meal",
  "combo",
  "idli",
  "vada",
  "upma",
  "butter",
  "ghee",
];

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reasoning_trace: { type: "string" },
    estimated_protein_g: { anyOf: [{ type: "number" }, { type: "null" }] },
    estimated_energy_kcal: { anyOf: [{ type: "number" }, { type: "null" }] },
    protein_confidence_percent: { anyOf: [{ type: "number" }, { type: "null" }] },
    protein_confidence_band: {
      anyOf: [{ type: "string", enum: ["High", "Medium", "Low"] }, { type: "null" }],
    },
    energy_confidence_percent: { anyOf: [{ type: "number" }, { type: "null" }] },
    energy_confidence_band: {
      anyOf: [{ type: "string", enum: ["High", "Medium", "Low"] }, { type: "null" }],
    },
    extracted_protein_g: { anyOf: [{ type: "number" }, { type: "null" }] },
    extracted_energy_kcal: { anyOf: [{ type: "number" }, { type: "null" }] },
    source_usage: {
      type: "object",
      additionalProperties: false,
      properties: {
        used_similar_items: { type: "boolean" },
        used_active_menu_context: { type: "boolean" },
        used_icmr: { type: "boolean" },
        used_helper_rules: { type: "boolean" },
        price_considered_lightly: { type: "boolean" },
      },
      required: [
        "used_similar_items",
        "used_active_menu_context",
        "used_icmr",
        "used_helper_rules",
        "price_considered_lightly",
      ],
    },
  },
  required: [
    "reasoning_trace",
    "estimated_protein_g",
    "estimated_energy_kcal",
    "protein_confidence_percent",
    "protein_confidence_band",
    "energy_confidence_percent",
    "energy_confidence_band",
    "extracted_protein_g",
    "extracted_energy_kcal",
    "source_usage",
  ],
};

let assetsPromise;
let openAiClient;
let ridClassifierLookupPromise;
const estimateCache = new Map();
const pendingEstimateCache = new Map();


function normalizeText(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


function buildItemCorpus(item) {
  return normalizeText(
    [
      item.name,
      item.description,
      item.cuisine,
      ...(item.ingredients || []).map((ingredient) => ingredient.name),
      item.compulsoryComponents,
      item.optionalComponents,
    ]
      .filter(Boolean)
      .join(" ")
  );
}


function includesAnyTerm(corpus, terms = []) {
  return terms.some((term) => {
    const normalizedTerm = normalizeText(term);
    if (!normalizedTerm) {
      return false;
    }

    if (normalizedTerm.includes(" ")) {
      return corpus.includes(normalizedTerm);
    }

    return corpus.split(" ").includes(normalizedTerm);
  });
}


function uniqueTokens(value) {
  return Array.from(new Set(normalizeText(value).split(" ").filter(Boolean)));
}


function tokenScore(a, b) {
  const tokensA = uniqueTokens(a);
  const tokensB = uniqueTokens(b);
  if (!tokensA.length || !tokensB.length) {
    return 0;
  }

  const setB = new Set(tokensB);
  let shared = 0;
  for (const token of tokensA) {
    if (setB.has(token)) {
      shared += 1;
    }
  }

  return shared / Math.max(tokensA.length, tokensB.length);
}


function bigrams(value) {
  const normalized = normalizeText(value);
  if (normalized.length < 2) {
    return new Set(normalized ? [normalized] : []);
  }

  const output = new Set();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    output.add(normalized.slice(index, index + 2));
  }
  return output;
}


function diceScore(a, b) {
  const gramsA = bigrams(a);
  const gramsB = bigrams(b);
  if (!gramsA.size || !gramsB.size) {
    return 0;
  }

  let shared = 0;
  for (const gram of gramsA) {
    if (gramsB.has(gram)) {
      shared += 1;
    }
  }

  return (2 * shared) / (gramsA.size + gramsB.size);
}


function parseNumericValue(value) {
  if (value == null || value === "") {
    return null;
  }

  const parsed = Number(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}


function roundValue(value, digits = 1) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}


function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}


function confidenceBandFromPercent(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  if (value >= 80) {
    return "High";
  }
  if (value >= 60) {
    return "Medium";
  }
  return "Low";
}

function confidenceSupportFromEvidence({ item, neighbors, activeMenuCandidates, icmrMatches, nutrient }) {
  const topSimilarity = Number(neighbors[0]?.similarity_percent) || 0;
  let support = 20 + Math.round(topSimilarity * 0.35);

  if (neighbors.length > 1) support += Math.min(8, (neighbors.length - 1) * 4);

  const ingredientNames = (item.ingredients || []).map((ingredient) => normalizeText(ingredient.name)).filter(Boolean);
  const relevantIcmrMatches = (icmrMatches || []).filter((match) =>
    ingredientNames.some((name) => tokenScore(name, match.name) >= 0.5 || normalizeText(match.name).includes(name))
  );
  if (relevantIcmrMatches.length >= 2) support += 12;
  else if (relevantIcmrMatches.length === 1) support += 7;

  if (ingredientNames.length) support += 6;
  if ((item.ingredients || []).some((ingredient) => parseNumericValue(ingredient.grammage) != null)) support += 10;
  if (parseNumericValue(item.grammage) != null) support += 7;
  if (String(item.description || "").trim().length >= 40) support += 3;

  if ((Number(activeMenuCandidates[0]?.similarity_percent) || 0) >= 85) support += 7;
  if (nutrient === "energy" && /\b(fried|grilled|steamed|baked|roasted|boiled|sauteed|sautéed)\b/i.test(item.description || "")) {
    support += 4;
  }

  return Math.round(clamp(support, 20, 95));
}

function adjustConfidenceForEvidence(modelPercent, supportPercent) {
  if (modelPercent == null) return null;
  return Math.round(clamp(modelPercent * 0.6 + supportPercent * 0.4, 0, 96));
}


function normalizePercent(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.round(clamp(value, 0, 100));
}


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function isTransientOpenAiError(error) {
  const status = Number(error?.status || error?.code || error?.response?.status);
  if ([408, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("fetch") ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("json") ||
    message.includes("parse")
  );
}


function classifyRowError(error) {
  const message = String(error?.message || "");
  if (message.toLowerCase().includes("json") || message.toLowerCase().includes("parse")) {
    return "parse_error";
  }
  if (message.toLowerCase().includes("guardrail")) {
    return "guardrail_error";
  }
  return "openai_error";
}


function buildErrorResultRow(item, error) {
  return {
    row_id: item.rid,
    result_key: item.rowId,
    input_name: item.name,
    input_description: item.description,
    input_cuisine: item.cuisine,
    input_item_price: item.price,
    input_item_grammage: item.grammage,
    input_ingredients: item.ingredients || [],
    estimation_status: "failed",
    error_code: classifyRowError(error),
    error_message: error instanceof Error ? error.message : "Unknown estimation error",
    retryable: true,
  };
}


async function withTransientRetries(operation) {
  let lastError;
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= TRANSIENT_RETRY_DELAYS_MS.length || !isTransientOpenAiError(error)) {
        throw error;
      }
      await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt]);
    }
  }

  throw lastError;
}


function getTraditionalMasalaDosaGuardrail(item) {
  const normalizedName = normalizeText(item.name);
  if (!/\bmasala dosa\b/.test(normalizedName)) {
    return null;
  }

  const corpus = buildItemCorpus(item);
  if (includesAnyTerm(corpus, TRADITIONAL_MASALA_DOSA_EXCLUSION_TERMS)) {
    return null;
  }

  const grams = parseNumericValue(item.grammage);
  const servingGrams = grams && grams >= 80 && grams <= 450 ? grams : 230;
  const estimatedProtein = clamp(servingGrams * 0.032, 4, 10);
  const estimatedEnergy = clamp(servingGrams * 1.55, 180, 430);

  return {
    id: "traditional-masala-dosa",
    servingGrams,
    estimatedProtein: roundValue(estimatedProtein),
    estimatedEnergy: roundValue(estimatedEnergy),
    maxProtein: 11,
    maxEnergy: 440,
    confidencePercent: 72,
  };
}


function applyNutritionGuardrails(item, parsed) {
  const guardrail = getTraditionalMasalaDosaGuardrail(item);
  if (!guardrail) {
    return { parsed, applied: null };
  }

  let applied = false;
  const originalProtein = parsed.estimated_protein_g;
  const originalEnergy = parsed.estimated_energy_kcal;

  if (parsed.estimated_protein_g == null || parsed.estimated_protein_g > guardrail.maxProtein) {
    parsed.estimated_protein_g = guardrail.estimatedProtein;
    applied = true;
  }

  if (parsed.estimated_energy_kcal == null || parsed.estimated_energy_kcal > guardrail.maxEnergy) {
    parsed.estimated_energy_kcal = guardrail.estimatedEnergy;
    applied = true;
  }

  if (!applied) {
    return { parsed, applied: null };
  }

  parsed.protein_confidence_percent = Math.min(
    parsed.protein_confidence_percent ?? guardrail.confidencePercent,
    guardrail.confidencePercent
  );
  parsed.energy_confidence_percent = Math.min(
    parsed.energy_confidence_percent ?? guardrail.confidencePercent,
    guardrail.confidencePercent
  );
  parsed.protein_confidence_band = confidenceBandFromPercent(parsed.protein_confidence_percent);
  parsed.energy_confidence_band = confidenceBandFromPercent(parsed.energy_confidence_percent);
  parsed.reasoning_trace =
    "Traditional masala dosa guardrail applied because the retrieved references over-indexed high-protein or rich dosa variants.";
  parsed.source_usage.used_helper_rules = true;

  return {
    parsed,
    applied: {
      ...guardrail,
      originalProtein,
      originalEnergy,
    },
  };
}


function normalizeVector(vector) {
  const norm = Math.hypot(...vector);
  if (!norm) {
    return vector.map(() => 0);
  }
  return vector.map((value) => value / norm);
}


function dotProduct(matrix, rowIndex, vector, dimensions) {
  let total = 0;
  const offset = rowIndex * dimensions;
  for (let index = 0; index < dimensions; index += 1) {
    total += matrix[offset + index] * vector[index];
  }
  return total;
}


function extractFirstNumericMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.slice(1).find((part) => part != null);
    if (!value) {
      continue;
    }

    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return roundValue(parsed);
    }
  }

  return null;
}


function extractExplicitNutritionFromDescription(description) {
  const normalized = String(description || "").trim();
  if (!normalized) {
    return {
      extracted_protein_g: null,
      extracted_energy_kcal: null,
      source_field: null,
    };
  }

  const proteinPatterns = [
    /\b(\d+(?:\.\d+)?)\s*(?:g|gm|grams?)\s*(?:of\s*)?protein\b/i,
    /\bprotein\s*(?::|=)?\s*(?:(?:is|around|about|approximately|approx\.?|content)\s+)?(\d+(?:\.\d+)?)\s*(?:g|gm|grams?)\b/i,
  ];
  const energyPatterns = [
    /\b(\d+(?:\.\d+)?)\s*(?:kcal|kcals|calories?)\b/i,
    /\b(?:energy|calories?)\s*(?::|=)?\s*(?:(?:is|around|about|approximately|approx\.?)\s+)?(\d+(?:\.\d+)?)\s*(?:kcal|kcals|calories?)\b/i,
  ];

  const extractedProtein = extractFirstNumericMatch(normalized, proteinPatterns);
  const extractedEnergy = extractFirstNumericMatch(normalized, energyPatterns);

  return {
    extracted_protein_g: extractedProtein,
    extracted_energy_kcal: extractedEnergy,
    source_field: extractedProtein != null || extractedEnergy != null ? "ITEM_DESCRIPTION" : null,
  };
}


function priceBand(value) {
  const numeric = parseNumericValue(value);
  if (numeric == null) {
    return null;
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


function formatIngredientEntries(ingredients = []) {
  return (ingredients || [])
    .filter((ingredient) => ingredient?.name || ingredient?.grammage)
    .map((ingredient) => {
      if (ingredient.name && ingredient.grammage) {
        return `${ingredient.name} (${ingredient.grammage} g)`;
      }
      return ingredient.name || `${ingredient.grammage} g`;
    })
    .join(", ");
}


function buildQueryBlob(item) {
  const parts =
    RETRIEVAL_DISH_METADATA_MODE === "on"
      ? [
        `item_name: ${item.name || ""}`,
        `item_description: ${item.description || ""}`,
        `dish_type: ${item.dishType || ""}`,
        `dish_family: ${item.dishFamily || ""}`,
        `preparation_style: ${item.preparationStyle || ""}`,
        `cuisine: ${item.cuisine || ""}`,
        `classifier: ${item.classifier || ""}`,
        `segment: ${item.segment || ""}`,
        `item_grammage: ${item.grammage || ""}`,
        `key_ingredients: ${formatIngredientEntries(item.ingredients)}`,
        `compulsory_components: ${item.compulsoryComponents || ""}`,
        `optional_components: ${item.optionalComponents || ""}`,
        `item_price_band: ${priceBand(item.price) || ""}`,
      ]
      : [
        `item_name: ${item.name || ""}`,
        `item_description: ${item.description || ""}`,
        `cuisine: ${item.cuisine || ""}`,
        `item_grammage: ${item.grammage || ""}`,
        `key_ingredients: ${formatIngredientEntries(item.ingredients)}`,
        `compulsory_components: ${item.compulsoryComponents || ""}`,
        `optional_components: ${item.optionalComponents || ""}`,
        `item_price_band: ${priceBand(item.price) || ""}`,
      ];

  return normalizeText(parts.filter(Boolean).join(" | "));
}


function buildInputPayload(item) {
  return {
    RID: item.rid || null,
    ITEM_NAME: item.name || null,
    ITEM_DESCRIPTION: item.description || null,
    RX_CUISINE: item.cuisine || null,
    DISH_TYPE: item.dishType || null,
    DISH_FAMILY: item.dishFamily || null,
    DISH_PREPARATION_STYLE: item.preparationStyle || null,
    RX_CLASSIFIER: item.classifier || null,
    RX_RESTAURANT_CLASSIFIER: item.restaurantClassifier || null,
    RID_RX_MAPPING_STATUS: item.restaurantClassifierMappingStatus || null,
    RX_SEGMENTS: item.segment || null,
    ITEM_PRICE: item.price || null,
    ITEM_GRAMMAGE: item.grammage || null,
    INGREDIENTS_LIST: formatIngredientEntries(item.ingredients) || null,
    INGREDIENTS: (item.ingredients || []).map((ingredient) => ({
      name: ingredient.name || null,
      grammage: ingredient.grammage || null,
    })),
    MAIN_INGREDIENT_1: item.mainIngredient1 || null,
    MAIN_INGREDIENT_2: item.mainIngredient2 || null,
    MAIN_INGREDIENT_3: item.mainIngredient3 || null,
    MAIN_INGREDIENT_1_GRAMMAGE: item.mainIngredient1Grammage || null,
    MAIN_INGREDIENT_2_GRAMMAGE: item.mainIngredient2Grammage || null,
    MAIN_INGREDIENT_3_GRAMMAGE: item.mainIngredient3Grammage || null,
    COMPULSORY_COMPONENTS: item.compulsoryComponents || null,
    OPTIONAL_COMPONENTS: item.optionalComponents || null,
  };
}

function normalizeCacheIngredient(ingredient = {}) {
  return {
    name: normalizeText(ingredient.name || ""),
    grammage: parseNumericValue(ingredient.grammage) ?? normalizeText(ingredient.grammage || ""),
  };
}

function buildNutritionCacheKey(item) {
  return JSON.stringify({
    name: normalizeText(item.name || ""),
    description: normalizeText(item.description || ""),
    cuisine: normalizeText(item.cuisine || ""),
    // These five now appear directly in the prompt (buildPrompt), so two
    // items identical everywhere else but differing in one of these would
    // previously have shared a cache entry incorrectly. Including them here
    // keeps the cache correct now that they affect the actual model input.
    dishType: normalizeText(item.dishType || ""),
    dishFamily: normalizeText(item.dishFamily || ""),
    preparationStyle: normalizeText(item.preparationStyle || ""),
    classifier: normalizeText(item.classifier || ""),
    restaurantClassifier: normalizeText(item.restaurantClassifier || ""),
    segment: normalizeText(item.segment || ""),
    price: parseNumericValue(item.price),
    grammage: parseNumericValue(item.grammage),
    ingredients: (item.ingredients || []).map(normalizeCacheIngredient).filter((ingredient) => ingredient.name || ingredient.grammage),
    compulsoryComponents: normalizeText(item.compulsoryComponents || ""),
    optionalComponents: normalizeText(item.optionalComponents || ""),
  });
}

function rememberEstimate(cacheKey, row) {
  estimateCache.set(cacheKey, JSON.parse(JSON.stringify(row)));
  if (estimateCache.size > ESTIMATE_CACHE_LIMIT) {
    const oldestKey = estimateCache.keys().next().value;
    estimateCache.delete(oldestKey);
  }
}

function cloneEstimateForItem(cachedRow, item) {
  const row = JSON.parse(JSON.stringify(cachedRow));
  row.row_id = item.rid;
  row.result_key = item.rowId;
  row.input = buildInputPayload(item);
  return row;
}

async function loadRidClassifierMap() {
  if (ridClassifierLookupPromise) return ridClassifierLookupPromise;
  ridClassifierLookupPromise = (async () => {
  try {
    const compressed = await fs.readFile(RID_RX_MAPPING_PATH);
    return decodeRidClassifierAsset(compressed);
  } catch {
    return () => null;
  }
  })();
  return ridClassifierLookupPromise;
}


function summarizeResults(results) {
  const matched = results.filter((item) => item.estimated_energy_kcal != null);
  const highConfidence = matched.filter((item) => item.confidence_band === "High").length;
  const mediumConfidence = matched.filter((item) => item.confidence_band === "Medium").length;
  const lowConfidence = matched.filter((item) => item.confidence_band === "Low").length;
  const extractedProteinCount = results.filter((item) => item.extracted_protein_g != null).length;
  const extractedEnergyCount = results.filter((item) => item.extracted_energy_kcal != null).length;

  const averageCalories = matched.length
    ? Math.round(matched.reduce((sum, item) => sum + item.estimated_energy_kcal, 0) / matched.length)
    : 0;
  const averageProtein = matched.length
    ? Math.round((matched.reduce((sum, item) => sum + item.estimated_protein_g, 0) / matched.length) * 10) / 10
    : 0;

  const highestCalorieItem = matched
    .slice()
    .sort((a, b) => (b.estimated_energy_kcal || 0) - (a.estimated_energy_kcal || 0))[0];

  return {
    uploadedCount: results.length,
    matchedCount: matched.length,
    unmatchedCount: results.length - matched.length,
    highConfidence,
    mediumConfidence,
    lowConfidence,
    averageCalories,
    averageProtein,
    extractedProteinCount,
    extractedEnergyCount,
    highestCalorieItem: highestCalorieItem
      ? {
        name: highestCalorieItem.input_name,
        calories: highestCalorieItem.estimated_energy_kcal,
      }
      : null,
  };
}


function formatNeighbor(neighbor, index) {
  const lines = [
    `${index + 1}. ITEM_NAME: ${neighbor.ITEM_NAME || "Unknown"}`,
    `ITEM_DESCRIPTION: ${neighbor.ITEM_DESCRIPTION || "Not available"}`,
    `PROTEIN_GM: ${neighbor.PROTEIN_GM ?? "Unknown"}`,
    `ENERGY_KCAL: ${neighbor.ENERGY_KCAL ?? "Unknown"}`,
    `DISH_TYPE: ${neighbor.DISH_TYPE || "Unknown"}`,
    `DISH_FAMILY: ${neighbor.DISH_FAMILY || "Unknown"}`,
    `RX_CUISINE: ${neighbor.RX_CUISINE || "Unknown"}`,
    `ITEM_PRICE: ${neighbor.ITEM_PRICE ?? "Unknown"}`,
    `SIMILARITY: ${roundValue(neighbor.retrieval_score, 3) ?? "Unknown"}`,
  ];
  if (RID_CATEGORY_CONTEXT_ENABLED) {
    lines.splice(8, 0, `RX_CLASSIFIER: ${neighbor.RX_CLASSIFIER || "Unknown"}`);
    lines.splice(9, 0, `RX_SEGMENTS: ${neighbor.RX_SEGMENTS || "Unknown"}`);
  }
  return lines.join(" | ");
}

function formatActiveMenuNeighbor(candidate, index) {
  return [
    `${index + 1}. ITEM_NAME: ${candidate.display_name || "Unknown"}`,
    `TOP_PARENT_NAME: ${candidate.top_parent_name || "Unknown"}`,
    `DISH_TYPE: ${candidate.top_dish_type || "Unknown"}`,
    `DISH_FAMILY: ${candidate.top_dish_family || "Unknown"}`,
    `MEDIAN_PRICE: ${candidate.median_price ?? "Unknown"}`,
    `ACTIVE_SUPPORT_COUNT: ${candidate.active_support_count ?? "Unknown"}`,
    `SIMILARITY: ${candidate.similarity_percent ?? "Unknown"}`,
  ].join(" | ");
}


function buildHelperRules(item) {
  const corpus = buildItemCorpus(item);

  const rules = HELPER_RULES.filter((rule) => includesAnyTerm(corpus, rule.keywords));

  return rules.length ? rules : DEFAULT_HELPER_RULES;
}


function buildPrompt({ item, neighbors, activeMenuCandidates, icmrMatches, helperRules, extractedValues }) {
  const itemBlock = [
    "NEW ITEM TO ESTIMATE",
    `ITEM_NAME: ${item.name || ""}`,
    `ITEM_DESCRIPTION: ${item.description || ""}`,
    `RX_CUISINE: ${item.cuisine || ""}`,
    `DISH_PREPARATION_STYLE: ${item.preparationStyle || ""}`,
    `ITEM_PRICE: ${item.price || ""}`,
    ...(RID_CATEGORY_CONTEXT_ENABLED ? [`RESTAURANT_CLASSIFIER: ${item.restaurantClassifier || "Unknown"}`] : []),
    `ITEM_GRAMMAGE: ${item.grammage || ""}`,
    `KEY_INGREDIENTS: ${formatIngredientEntries(item.ingredients) || ""}`,
    `COMPULSORY_COMPONENTS: ${item.compulsoryComponents || ""}`,
    `OPTIONAL_COMPONENTS: ${item.optionalComponents || ""}`,
    "ITEM_PRICE_HINT: Use only as a weak dish-level signal. Do not infer premium restaurant pricing as higher calories by itself.",
  ].join("\n");

  const neighborBlock = neighbors.length
    ? neighbors.map((neighbor, index) => formatNeighbor(neighbor, index)).join("\n")
    : "No retrieved similar items were available.";
  const activeMenuBlock = activeMenuCandidates.length
    ? activeMenuCandidates.map((candidate, index) => formatActiveMenuNeighbor(candidate, index)).join("\n")
    : "No active menu context matches were available.";

  const icmrBlock = icmrMatches.length
    ? icmrMatches
      .map(
        (match, index) =>
          `${index + 1}. ${match.name} | Protein ${match.protein_per_100g} g/100g | Energy ${match.energy_per_100g} kcal/100g | Similarity ${match.similarity_percent}`
      )
      .join("\n")
    : "No reliable ICMR ingredient matches were found.";

  const helperBlock = helperRules.map((rule, index) => `${index + 1}. ${rule.text}`).join("\n");

  const extractionBlock =
    extractedValues.extracted_protein_g != null || extractedValues.extracted_energy_kcal != null
      ? `EXPLICIT VALUES FOUND IN ITEM_DESCRIPTION\nextracted_protein_g: ${extractedValues.extracted_protein_g ?? "null"}\nextracted_energy_kcal: ${extractedValues.extracted_energy_kcal ?? "null"}\nThese values must be copied into extracted_* output fields but should not override the independent estimate.`
      : "EXPLICIT VALUES FOUND IN ITEM_DESCRIPTION\nNo explicit protein or calorie values were detected by preprocessing.";
  const ingredientExtractionBlock = item.ingredients?.length
    ? `INGREDIENT QUANTITIES PROVIDED OR EXTRACTED FROM EXPLICIT GRAM AMOUNTS\n${formatIngredientEntries(item.ingredients)}\nUse these quantities as input evidence. Do not infer additional ingredients or reinterpret unrelated numbers as gram amounts.`
    : "INGREDIENT QUANTITIES PROVIDED OR EXTRACTED FROM EXPLICIT GRAM AMOUNTS\nNo ingredient names with explicit gram amounts were found.";

  const systemPrompt = [
    "You are an expert food nutritionist and data analyst.",
    "Estimate protein and energy for the NEW ITEM using the retrieved nutrition references, active menu context, the ICMR ingredient references, and helper rules.",
    "Use active menu context to understand dish identity and market prevalence, not as direct nutrition truth.",
    "Use ingredient grams and total dish grammage whenever they are available.",
    "Treat extracted description ingredients as evidence only when a gram unit and ingredient name are explicit. Never treat nutrition claims or unrelated numbers as ingredient weights.",
    "DISH_PREPARATION_STYLE materially affects calorie density (e.g. deep fried vs steamed), factor it in directly rather than relying only on the dish name.",
    "Treat ITEM_PRICE as a weak contextual tie-breaker only. It is item price, not restaurant price, and must never dominate dish identity.",
    "Return only valid JSON matching the schema.",
    "Give separate confidence percentages and bands for protein and energy.",
    "Keep reasoning_trace to one sentence.",
  ].join(" ");

  const userPrompt = [
    itemBlock,
    "",
    "RETRIEVED SIMILAR ITEMS",
    neighborBlock,
    "",
    "ACTIVE MENU CONTEXT FROM APRIL 20 DATASET",
    activeMenuBlock,
    "",
    "ICMR INGREDIENT REFERENCES",
    icmrBlock,
    "",
    "HELPER RULES",
    helperBlock,
    "",
    ingredientExtractionBlock,
    "",
    extractionBlock,
    "",
    "TASK",
    "Produce unbiased estimates for estimated_protein_g and estimated_energy_kcal, plus separate confidence fields.",
    "If evidence is weak, lower the confidence instead of guessing with high confidence.",
    "Use null only if the estimate truly cannot be supported.",
  ].join("\n");

  return { systemPrompt, userPrompt };
}


function parseResponseOutput(response) {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }

  const collected = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.text) {
        collected.push(content.text);
      }
    }
  }

  return collected.join("").trim();
}


function formatFallbackReason(code) {
  switch (code) {
    case "backend_disabled":
      return "GenAI mode is disabled by configuration.";
    case "missing_api_key":
      return "OPENAI_API_KEY is not configured.";
    case "missing_assets":
      return "GenAI reference assets are missing.";
    case "asset_load_failed":
      return "GenAI reference assets could not be loaded.";
    case "openai_error":
      return "The OpenAI request failed.";
    default:
      return "The GenAI backend was unavailable.";
  }
}


const readIcmr = cache(async () => {
  const raw = await fs.readFile(ICMR_PATH, "utf-8");
  const parsed = Papa.parse(raw, {
    header: true,
    skipEmptyLines: true,
  });

  return parsed.data.map((row) => ({
    name: row.Ingredient_name || row.ingredient_name || "",
    protein_per_100g: parseNumericValue(row.protein_per_100g),
    energy_per_100g: parseNumericValue(row.energy_per_100g),
    carbs_per_100g: parseNumericValue(row.carbs_per_100g),
    fat_per_100g: parseNumericValue(row.fat_per_100g),
  }));
});


const readActiveMenuCatalog = cache(async () => {
  const raw = await fs.readFile(ACTIVE_MENU_CATALOG_PATH, "utf-8");
  const records = JSON.parse(raw);
  const exactMap = new Map();
  const tokenIndex = new Map();

  records.forEach((record, index) => {
    if (record.normalized_name) {
      exactMap.set(record.normalized_name, index);
    }

    for (const token of uniqueTokens(record.search_blob || record.display_name || "")) {
      if (!tokenIndex.has(token)) {
        tokenIndex.set(token, []);
      }
      tokenIndex.get(token).push(index);
    }
  });

  return { records, exactMap, tokenIndex };
});


async function loadGenAiAssets() {
  if (assetsPromise) {
    return assetsPromise;
  }

  assetsPromise = (async () => {
    const [manifestRaw, recordsRaw, embeddingsRaw] = await Promise.all([
      fs.readFile(MANIFEST_PATH, "utf-8"),
      fs.readFile(RECORDS_PATH, "utf-8"),
      fs.readFile(EMBEDDINGS_PATH),
    ]);

    const manifest = JSON.parse(manifestRaw);
    const records = JSON.parse(recordsRaw);
    const embeddings = new Float32Array(
      embeddingsRaw.buffer,
      embeddingsRaw.byteOffset,
      embeddingsRaw.byteLength / Float32Array.BYTES_PER_ELEMENT
    );

    if (manifest.count !== records.length) {
      throw new Error("GenAI asset manifest count does not match record count.");
    }
    if (manifest.count * manifest.dimensions !== embeddings.length) {
      throw new Error("GenAI asset manifest dimensions do not match embedding matrix length.");
    }

    return {
      manifest,
      records,
      embeddings,
      portionPrior: fitPortionPrior(records),
    };
  })();

  try {
    return await assetsPromise;
  } catch (error) {
    assetsPromise = null;
    throw error;
  }
}


function getOpenAIClient() {
  if (!openAiClient) {
    openAiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      organization: process.env.OPENAI_ORGANIZATION || undefined,
      project: process.env.OPENAI_PROJECT || process.env.OPENAI_PROJECT_ID || undefined,
    });
  }

  return openAiClient;
}


function getGenAiReadiness() {
  if (DEFAULT_BACKEND_MODE === "v1" || DEFAULT_BACKEND_MODE === "off") {
    return {
      enabled: false,
      reasonCode: "backend_disabled",
      detail: formatFallbackReason("backend_disabled"),
    };
  }

  if (!process.env.OPENAI_API_KEY) {
    return {
      enabled: false,
      reasonCode: "missing_api_key",
      detail: formatFallbackReason("missing_api_key"),
    };
  }

  return { enabled: true };
}


function retrieveNeighbors(queryVector, assets, item, options = {}) {
  const candidateLimit = options.candidateLimit ?? RERANK_CANDIDATES;
  const useCategoryRerank = options.useCategoryRerank ?? RID_CATEGORY_RERANK_ENABLED;
  const usePriceRerank = options.usePriceRerank ?? ITEM_PRICE_RERANK_ENABLED;
  const useAnyRerank = useCategoryRerank || usePriceRerank;
  const ranked = [];
  const normalizedQueryName = normalizeText(item.name);
  for (let index = 0; index < assets.manifest.count; index += 1) {
    if (EXCLUDE_EXACT_REFERENCE_NAMES && normalizeText(assets.records[index].ITEM_NAME) === normalizedQueryName) {
      continue;
    }
    const baseScore = dotProduct(assets.embeddings, index, queryVector, assets.manifest.dimensions);
    const categoryMatch = Boolean(
      useCategoryRerank &&
      item.restaurantClassifier &&
      normalizeText(assets.records[index].RX_CLASSIFIER) === normalizeText(item.restaurantClassifier)
    );
    ranked.push({
      ...assets.records[index],
      retrieval_score: baseScore,
      price_rerank_boost: 0,
      category_rerank_boost: 0,
      category_match: categoryMatch,
      final_score: baseScore,
    });
  }

  ranked.sort((a, b) => b.retrieval_score - a.retrieval_score);
  const topCandidates = ranked.slice(0, candidateLimit).map((candidate) => {
    const itemPrice = parseNumericValue(item.price);
    const candidatePrice = parseNumericValue(candidate.ITEM_PRICE);
    const scoredPriority = scoreNeighbor({
      retrievalScore: candidate.retrieval_score,
      itemPrice,
      candidatePrice,
      categoryMatch: candidate.category_match,
      categoryBoost: CATEGORY_RERANK_BOOST,
    });
    const priority = {
      ...scoredPriority,
      priceRerankBoost: usePriceRerank ? scoredPriority.priceRerankBoost : 0,
      categoryRerankBoost: useCategoryRerank ? scoredPriority.categoryRerankBoost : 0,
    };
    priority.finalScore = candidate.retrieval_score + priority.priceRerankBoost + priority.categoryRerankBoost;
    // Semantic similarity remains the candidate gate; category is a preference,
    // with an additional smaller price-similarity bonus.
    return {
      ...candidate,
      price_rerank_boost: priority.priceRerankBoost,
      category_rerank_boost: priority.categoryRerankBoost,
      category_price_match: priority.categoryPriceMatch,
      final_score: priority.finalScore,
    };
  });

  topCandidates.sort((a, b) => b.final_score - a.final_score);

  return topCandidates.slice(0, TOP_K_NEIGHBORS).map((candidate) => ({
    ...candidate,
    similarity_percent: Math.round(clamp(
      useAnyRerank ? candidate.retrieval_score : candidate.final_score,
      0,
      1
    ) * 100),
  }));
}

function priceRerankBoost(itemPrice, candidatePrice) {
  if (itemPrice == null || candidatePrice == null) return 0;
  const width = Math.max(candidatePrice * 0.35, 60);
  const closeness = clamp(1 - Math.abs(itemPrice - candidatePrice) / width, 0, 1);
  return roundValue(closeness * 0.02, 4) || 0;
}

function portionPriorForItem(assets, itemName) {
  if (!EXCLUDE_EXACT_REFERENCE_NAMES) return assets.portionPrior;
  const normalizedName = normalizeText(itemName);
  if (!portionPriorExclusionCache.has(normalizedName)) {
    portionPriorExclusionCache.set(
      normalizedName,
      fitPortionPrior(assets.records.filter((record) => normalizeText(record.ITEM_NAME) !== normalizedName))
    );
  }
  return portionPriorExclusionCache.get(normalizedName);
}


async function retrieveActiveMenuCandidates(item) {
  const catalog = await readActiveMenuCatalog();
  const exactIndex = catalog.exactMap.get(normalizeText(item.name));
  const candidateIndices = new Set(exactIndex != null ? [exactIndex] : []);
  const queryTokens = uniqueTokens(
    [
      item.name,
      item.description,
      item.cuisine,
      item.compulsoryComponents,
      item.optionalComponents,
      formatIngredientEntries(item.ingredients),
    ]
      .filter(Boolean)
      .join(" ")
  );

  for (const token of queryTokens) {
    const indices = catalog.tokenIndex.get(token) || [];
    for (const index of indices.slice(0, 250)) {
      candidateIndices.add(index);
    }
  }

  const scored = Array.from(candidateIndices).map((index) => {
    const candidate = catalog.records[index];
    const nameScore = Math.max(
      tokenScore(item.name, candidate.display_name),
      diceScore(item.name, candidate.display_name),
      normalizeText(item.name) === candidate.normalized_name ? 1 : 0
    );
    const detailScore = Math.max(
      tokenScore(item.description, candidate.search_blob),
      tokenScore(formatIngredientEntries(item.ingredients), candidate.search_blob),
      tokenScore(item.compulsoryComponents, candidate.search_blob)
    );
    const priceBoost = priceRerankBoost(parseNumericValue(item.price), candidate.median_price);
    const score = nameScore * 0.75 + detailScore * 0.2 + priceBoost;

    return {
      ...candidate,
      retrieval_score: roundValue(score, 4),
      similarity_percent: Math.round(clamp(score, 0, 1) * 100),
    };
  });

  return scored
    .filter((candidate) => candidate.retrieval_score >= 0.18)
    .sort((a, b) => b.retrieval_score - a.retrieval_score)
    .slice(0, TOP_K_ACTIVE_MENU_CANDIDATES);
}


async function lookupIcmrMatches(item) {
  const icmr = await readIcmr();
  const candidateTexts = [
    item.name,
    item.description,
    ...(item.ingredients || []).flatMap((ingredient) => [ingredient.name, ingredient.grammage && `${ingredient.name} ${ingredient.grammage}`]),
    item.compulsoryComponents,
    item.optionalComponents,
  ].filter(Boolean);

  const matches = icmr
    .map((reference) => {
      const score = candidateTexts.reduce((best, text) => {
        const normalizedIngredient = normalizeText(reference.name);
        const exact = normalizeText(text).includes(normalizedIngredient) ? 1 : 0;
        return Math.max(best, exact, tokenScore(text, reference.name), diceScore(text, reference.name));
      }, 0);

      return {
        ...reference,
        similarity_score: score,
        similarity_percent: Math.round(score * 100),
      };
    })
    .filter((match) => match.similarity_score >= 0.55)
    .sort((a, b) => b.similarity_score - a.similarity_score)
    .slice(0, 5);

  return matches;
}


// Kept alongside lookupIcmrMatches (keyword/token matching) rather than
// replacing it, so both retrieval strategies can be benchmarked against each
// other. Controlled by ICMR_MATCH_MODE=keyword (default) or =embedding.
let icmrEmbeddingsPromise;

async function loadIcmrEmbeddings(embeddingModel, dimensions) {
  if (icmrEmbeddingsPromise) {
    return icmrEmbeddingsPromise;
  }

  icmrEmbeddingsPromise = (async () => {
    const icmr = await readIcmr();
    const texts = icmr.map((reference) => reference.name || "");
    const vectors = await getQueryEmbeddings(texts, embeddingModel, dimensions);
    return icmr.map((reference, index) => ({ reference, vector: vectors[index] }));
  })();

  try {
    return await icmrEmbeddingsPromise;
  } catch (error) {
    icmrEmbeddingsPromise = null;
    throw error;
  }
}

async function lookupIcmrMatchesEmbedding(queryVector, embeddingModel, dimensions) {
  const embedded = await loadIcmrEmbeddings(embeddingModel, dimensions);

  const matches = embedded
    .map(({ reference, vector }) => {
      let score = 0;
      for (let i = 0; i < vector.length; i += 1) {
        score += vector[i] * queryVector[i];
      }
      return {
        ...reference,
        similarity_score: score,
        similarity_percent: Math.round(Math.max(0, Math.min(1, score)) * 100),
      };
    })
    .filter((match) => match.similarity_score >= ICMR_EMBEDDING_THRESHOLD)
    .sort((a, b) => b.similarity_score - a.similarity_score)
    .slice(0, 5);

  return matches;
}


async function getQueryEmbeddings(queryBlobs, embeddingModel, dimensions) {
  const client = getOpenAIClient();
  const params = {
    model: embeddingModel || DEFAULT_EMBEDDING_MODEL,
    input: queryBlobs,
  };
  if (dimensions) {
    params.dimensions = dimensions;
  }

  const response = await client.embeddings.create(params);
  return response.data.map((item) => normalizeVector(item.embedding));
}

function buildExplainability(item, row, neighbors, activeMenuCandidates, icmrMatches, helperRules, extractedValues, parsed, nutrientSpecificReferences = null) {
  const signalsChecked = ["ITEM_NAME"];
  if (item.description) {
    signalsChecked.push("ITEM_DESCRIPTION");
  }
  if (item.cuisine) {
    signalsChecked.push("RX_CUISINE");
  }
  if (item.ingredients?.length) {
    signalsChecked.push("MAIN_INGREDIENTS");
  }
  if (item.compulsoryComponents || item.optionalComponents) {
    signalsChecked.push("DISH_COMPONENTS");
  }
  if (item.price) {
    signalsChecked.push("ITEM_PRICE");
  }
  if (item.grammage) {
    signalsChecked.push("ITEM_GRAMMAGE");
  }
  if (activeMenuCandidates.length) {
    signalsChecked.push("ACTIVE_MENU_DATASET");
  }

  const signalsHelped = ["ITEM_NAME"];
  if (parsed.source_usage.used_similar_items) {
    signalsHelped.push("RETRIEVED_SIMILAR_ITEMS");
  }
  if (parsed.source_usage.used_active_menu_context) {
    signalsHelped.push("ACTIVE_MENU_DATASET");
  }
  if (parsed.source_usage.used_icmr) {
    signalsHelped.push("ICMR_REFERENCES");
  }
  if (parsed.source_usage.used_helper_rules) {
    signalsHelped.push("HELPER_RULES");
  }
  if (parsed.source_usage.price_considered_lightly) {
    signalsHelped.push("ITEM_PRICE");
  }
  if (item.description) {
    signalsHelped.push("ITEM_DESCRIPTION");
  }

  return {
    reasoning_trace: row.reasoning_trace,
    detailed_rationale: row.rationale,
    match: {
      matched_name: row.matched_name,
      matched_cuisine: row.matched_cuisine,
      match_type: row.match_type,
      match_score_percent: row.match_score,
      support_count: row.support_count,
      source_lineage: row.source_lineage,
    },
    inputs: {
      required_partner_inputs: ["RID", "ITEM_NAME", "ITEM_PRICE"],
      provided_optional_fields: Object.entries(buildInputPayload(item))
        .filter(([key, value]) => !["RID", "ITEM_NAME", "ITEM_PRICE", "ITEM_GRAMMAGE"].includes(key) && value)
        .map(([key]) => key),
      signals_checked_by_v1: [],
      signals_checked_by_genai: signalsChecked,
      signals_that_helped_this_match: Array.from(new Set(signalsHelped)),
      captured_but_not_used_by_v1: [],
      explicit_values_found_in_description: {
        available: extractedValues.extracted_protein_g != null || extractedValues.extracted_energy_kcal != null,
        extracted_protein_g: extractedValues.extracted_protein_g,
        extracted_energy_kcal: extractedValues.extracted_energy_kcal,
        source_field: extractedValues.source_field,
      },
    },
    price_signal: {
      boost: row.retrieval?.price_rerank_boost ?? 0,
      status: parsed.source_usage.price_considered_lightly ? "applied_lightly" : "ignored_or_negligible",
      note: parsed.source_usage.price_considered_lightly
        ? "Item price was only used as a weak dish-level tie-breaker after retrieval."
        : "Item price did not materially affect the estimate.",
    },
    retrieval: {
      neighbors,
      protein_neighbors: nutrientSpecificReferences?.protein ?? null,
      energy_neighbors: nutrientSpecificReferences?.energy ?? null,
      active_menu_context: activeMenuCandidates,
      icmr_matches: icmrMatches,
      helper_rules: helperRules.map((rule) => rule.text),
      applied_guardrail: row.retrieval?.applied_guardrail ?? null,
    },
    scoring_snapshot: {
      top_neighbor_similarity: neighbors[0]?.similarity_percent ?? null,
      top_neighbor_price_rerank_boost: row.retrieval?.price_rerank_boost ?? 0,
      active_menu_match_count: activeMenuCandidates.length,
    },
    estimator_note:
      "This row was estimated by the GenAI retrieval backend using labeled nutrition references, the April 20 active menu dataset, ICMR ingredient references, helper rules, and a structured OpenAI response.",
  };
}


function buildOutputDetail(parsed, extractedValues, finalConfidencePercent, finalConfidenceBand, confidenceEvidence) {
  return {
    reasoning_trace: parsed.reasoning_trace,
    estimated_protein_g: parsed.estimated_protein_g,
    estimated_energy_kcal: parsed.estimated_energy_kcal,
    estimation_confidence: finalConfidenceBand,
    confidence_percent: finalConfidencePercent,
    extracted_protein_g:
      extractedValues.extracted_protein_g ?? parsed.extracted_protein_g ?? null,
    extracted_energy_kcal:
      extractedValues.extracted_energy_kcal ?? parsed.extracted_energy_kcal ?? null,
    confidence_detail: {
      protein_confidence: {
        band: parsed.protein_confidence_band,
        percent: parsed.protein_confidence_percent,
        model_percent: confidenceEvidence.protein.modelPercent,
        evidence_support_percent: confidenceEvidence.protein.supportPercent,
        available: parsed.protein_confidence_percent != null,
        note: "Model confidence adjusted toward available protein evidence support.",
      },
      energy_confidence: {
        band: parsed.energy_confidence_band,
        percent: parsed.energy_confidence_percent,
        model_percent: confidenceEvidence.energy.modelPercent,
        evidence_support_percent: confidenceEvidence.energy.supportPercent,
        available: parsed.energy_confidence_percent != null,
        note: "Model confidence adjusted toward available energy evidence support.",
      },
      final_confidence: {
        band: finalConfidenceBand,
        percent: finalConfidencePercent,
        source: "minimum_of_evidence_adjusted_protein_and_energy_confidence",
        derived_from_minimum_rule: true,
        note: "Evidence adjustment uses similar references, explicit ingredient quantities, serving grammage, and available context. This is a heuristic, not a benchmark-calibrated probability.",
      },
    },
  };
}


async function estimateOneItem(item, assets, queryVector, queryBlob) {
  const cacheKey = buildNutritionCacheKey(item);
  const cachedRow = estimateCache.get(cacheKey);
  if (cachedRow) {
    return cloneEstimateForItem(cachedRow, item);
  }

  const pendingRow = pendingEstimateCache.get(cacheKey);
  if (pendingRow) {
    return cloneEstimateForItem(await pendingRow, item);
  }

  const pendingEstimate = estimateOneItemUncached(item, assets, queryVector, queryBlob);
  pendingEstimateCache.set(cacheKey, pendingEstimate);

  try {
    const row = await pendingEstimate;
    rememberEstimate(cacheKey, row);
    return row;
  } finally {
    pendingEstimateCache.delete(cacheKey);
  }
}

function buildReferenceBaseline(neighbors) {
  const weights = neighbors.map((row) => Math.max(0, Number(row.retrieval_score) || 0) ** 2);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const weighted = (field) => {
    if (!totalWeight) return null;
    const entries = neighbors.map((row, index) => ({ value: Number(row[field]), weight: weights[index] }))
      .filter(({ value, weight }) => Number.isFinite(value) && value > 0 && weight > 0);
    const denominator = entries.reduce((sum, entry) => sum + entry.weight, 0);
    return denominator ? roundValue(entries.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / denominator) : null;
  };
  return {
    reasoning_trace: "Estimate is the similarity-weighted nutrition average of retrieved labeled dishes.",
    estimated_protein_g: weighted("PROTEIN_GM"),
    estimated_energy_kcal: weighted("ENERGY_KCAL"),
    protein_confidence_percent: neighbors.length ? Math.round((neighbors[0].similarity_percent || 0) * 0.7) : 0,
    protein_confidence_band: "Low",
    energy_confidence_percent: neighbors.length ? Math.round((neighbors[0].similarity_percent || 0) * 0.7) : 0,
    energy_confidence_band: "Low",
    extracted_protein_g: null,
    extracted_energy_kcal: null,
    source_usage: {
      used_similar_items: neighbors.length > 0,
      used_active_menu_context: false,
      used_icmr: false,
      used_helper_rules: false,
      price_considered_lightly: false,
    },
  };
}


async function estimateOneItemUncached(item, assets, queryVector, queryBlob) {
  const extractedValues = extractExplicitNutritionFromDescription(item.description);
  const nutrientSpecificReferences = null;
  const neighbors = retrieveNeighbors(queryVector, assets, item);
  const portionAdjustment = PORTION_NUTRITION_ADJUSTMENT_ENABLED
    ? estimatePortionAdjustment({ item, neighbors, prior: portionPriorForItem(assets, item.name) })
    : null;
  const activeMenuCandidates = await retrieveActiveMenuCandidates(item);
  const icmrMatches =
    ICMR_MATCH_MODE === "embedding"
      ? await lookupIcmrMatchesEmbedding(
        queryVector,
        assets.manifest.embeddingModel || DEFAULT_EMBEDDING_MODEL,
        assets.manifest.dimensions || undefined
      )
      : await lookupIcmrMatches(item);
  const helperRules = buildHelperRules(item);
  const { systemPrompt, userPrompt } = buildPrompt({
    item,
    neighbors,
    activeMenuCandidates,
    icmrMatches,
    helperRules,
    extractedValues,
  });

  const client = PORTION_PRIOR_MODE === "reference" ? null : getOpenAIClient();
  const parsed = PORTION_PRIOR_MODE === "reference" ? buildReferenceBaseline(neighbors) : await withTransientRetries(async () => {
    const response = await client.responses.create({
      model: DEFAULT_RESPONSES_MODEL,
      temperature: 0,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "nutrition_estimate",
          strict: true,
          schema: RESPONSE_SCHEMA,
        },
      },
    });

    const rawText = parseResponseOutput(response);
    if (!rawText) {
      throw new Error("The OpenAI response did not contain structured JSON output.");
    }

    try {
      return JSON.parse(rawText);
    } catch (error) {
      throw new Error(`Failed to parse structured OpenAI JSON: ${error instanceof Error ? error.message : "Unknown parse error"}`);
    }
  });
  parsed.protein_confidence_percent = normalizePercent(parsed.protein_confidence_percent);
  parsed.energy_confidence_percent = normalizePercent(parsed.energy_confidence_percent);
  parsed.protein_confidence_band =
    parsed.protein_confidence_band || confidenceBandFromPercent(parsed.protein_confidence_percent);
  parsed.energy_confidence_band =
    parsed.energy_confidence_band || confidenceBandFromPercent(parsed.energy_confidence_percent);
  parsed.estimated_protein_g = roundValue(parsed.estimated_protein_g);
  parsed.estimated_energy_kcal = roundValue(parsed.estimated_energy_kcal);
  if (portionAdjustment?.applied) {
    parsed.estimated_protein_g = roundValue(parsed.estimated_protein_g * portionAdjustment.protein_multiplier);
    parsed.estimated_energy_kcal = roundValue(parsed.estimated_energy_kcal * portionAdjustment.calorie_multiplier);
    parsed.reasoning_trace = `${parsed.reasoning_trace} Applied a conservative relative portion adjustment from price and restaurant category.`;
  }
  const confidenceEvidence = {
    protein: {
      modelPercent: parsed.protein_confidence_percent,
      supportPercent: confidenceSupportFromEvidence({ item, neighbors, activeMenuCandidates, icmrMatches, nutrient: "protein" }),
    },
    energy: {
      modelPercent: parsed.energy_confidence_percent,
      supportPercent: confidenceSupportFromEvidence({ item, neighbors, activeMenuCandidates, icmrMatches, nutrient: "energy" }),
    },
  };
  parsed.protein_confidence_percent = adjustConfidenceForEvidence(
    confidenceEvidence.protein.modelPercent,
    confidenceEvidence.protein.supportPercent
  );
  parsed.energy_confidence_percent = adjustConfidenceForEvidence(
    confidenceEvidence.energy.modelPercent,
    confidenceEvidence.energy.supportPercent
  );
  parsed.protein_confidence_band = confidenceBandFromPercent(parsed.protein_confidence_percent);
  parsed.energy_confidence_band = confidenceBandFromPercent(parsed.energy_confidence_percent);

  const guardrailResult = applyNutritionGuardrails(item, parsed);
  const appliedGuardrail = guardrailResult.applied;

  const finalConfidencePercent =
    parsed.protein_confidence_percent != null && parsed.energy_confidence_percent != null
      ? Math.min(parsed.protein_confidence_percent, parsed.energy_confidence_percent)
      : null;
  const finalConfidenceBand =
    finalConfidencePercent != null ? confidenceBandFromPercent(finalConfidencePercent) : "Low";

  const output = buildOutputDetail(
    parsed,
    extractedValues,
    finalConfidencePercent,
    finalConfidenceBand,
    confidenceEvidence
  );
  const topNeighbor = neighbors[0] || null;
  const rationaleParts = [
    parsed.reasoning_trace,
    neighbors.length ? `Retrieved ${neighbors.length} similar item references.` : "No similar item references were retrieved.",
    activeMenuCandidates.length
      ? `Checked ${activeMenuCandidates.length} active menu context matches from the April 20 dataset.`
      : "No strong active menu context match was found.",
    icmrMatches.length ? `Found ${icmrMatches.length} ICMR ingredient references.` : "No strong ICMR ingredient reference was found.",
    appliedGuardrail
      ? `Applied ${appliedGuardrail.id} guardrail for a ${appliedGuardrail.servingGrams} g serving after the raw response returned ${appliedGuardrail.originalProtein ?? "null"} g protein and ${appliedGuardrail.originalEnergy ?? "null"} kcal.`
      : "",
    parsed.source_usage.price_considered_lightly
      ? "Item price was considered lightly after dish identity was established."
      : "Item price did not materially affect the estimate.",
    portionAdjustment?.applied
      ? `Applied a learned relative adjustment (index ${portionAdjustment.relative_portion_index}) from ${portionAdjustment.price_band || "missing price"} and ${portionAdjustment.restaurant_classifier || "unknown restaurant category"}; this index does not represent serving grams.`
      : "",
  ];

  const row = {
    row_id: item.rid,
    result_key: item.rowId,
    input_name: item.name,
    input_description: item.description,
    input_cuisine: item.cuisine,
    input_item_price: item.price,
    input_item_grammage: item.grammage,
    input_ingredients: item.ingredients || [],
    input_main_ingredient_1: item.mainIngredient1,
    input_main_ingredient_2: item.mainIngredient2,
    input_main_ingredient_3: item.mainIngredient3,
    input_main_ingredient_1_grammage: item.mainIngredient1Grammage,
    input_main_ingredient_2_grammage: item.mainIngredient2Grammage,
    input_main_ingredient_3_grammage: item.mainIngredient3Grammage,
    input_compulsory_components: item.compulsoryComponents,
    input_optional_components: item.optionalComponents,
    matched_name: topNeighbor?.ITEM_NAME || null,
    matched_cuisine: topNeighbor?.RX_CUISINE || null,
    estimated_energy_kcal: output.estimated_energy_kcal,
    estimated_protein_g: output.estimated_protein_g,
    support_count: neighbors.length,
    match_type: PORTION_PRIOR_MODE === "reference"
      ? "Similarity-weighted labeled reference baseline"
      : "GenAI estimate with full retrieval context",
    match_score: topNeighbor?.similarity_percent || 0,
    confidence_score: output.confidence_percent,
    confidence_band: output.estimation_confidence || "Low",
    estimation_confidence: output.estimation_confidence,
    confidence_percent: output.confidence_percent,
    extracted_protein_g: output.extracted_protein_g,
    extracted_energy_kcal: output.extracted_energy_kcal,
    reasoning_trace: output.reasoning_trace,
    rationale: rationaleParts.filter(Boolean).join(" "),
    source_lineage: "OpenAI + labeled nutrition refs + April 20 active menu context + ICMR",
    input: buildInputPayload(item),
    output,
    retrieval: {
      query_blob: queryBlob,
      price_rerank_boost: topNeighbor?.price_rerank_boost || 0,
      nutrient_specific_retrieval: nutrientSpecificReferences,
      active_menu_match_count: activeMenuCandidates.length,
      applied_guardrail: appliedGuardrail,
      portion_adjustment: portionAdjustment,
      rid_category_mapping: RID_CATEGORY_RERANK_ENABLED || PORTION_NUTRITION_ADJUSTMENT_ENABLED
        ? { status: item.restaurantClassifierMappingStatus || "unknown", classifier: item.restaurantClassifier || null }
        : null,
    },
  };

  row.explainability = buildExplainability(
    item,
    row,
    neighbors,
    activeMenuCandidates,
    icmrMatches,
    helperRules,
    extractedValues,
    parsed,
    nutrientSpecificReferences
  );
  return row;
}


async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}


export async function tryEstimateMenuItemsWithGenAI(items = []) {
  const readiness = getGenAiReadiness();
  if (!readiness.enabled) {
    return {
      available: false,
      reasonCode: readiness.reasonCode,
      detail: readiness.detail,
    };
  }

  let assets;
  try {
    assets = await loadGenAiAssets();
  } catch (error) {
    return {
      available: false,
      reasonCode: "missing_assets",
      detail: `${formatFallbackReason("missing_assets")} ${error instanceof Error ? error.message : ""}`.trim(),
    };
  }

  if (RID_MAPPING_REQUIRED) {
    const ridClassifierMap = await loadRidClassifierMap();
    items = items.map((item) => {
      const restaurantClassifier = ridClassifierMap(item.rid);
      return {
        ...item,
        restaurantClassifier,
        restaurantClassifierMappingStatus: restaurantClassifier ? "matched" : "unknown",
      };
    });
  }

  const buildPayload = (results) => ({
    generatedAt: new Date().toISOString(),
    estimator: {
      engine: "openai_retrieval_llm_v2",
      contract_version: "genai-rag-v2",
      mode: "genai",
      model: DEFAULT_RESPONSES_MODEL,
      embeddingModel: assets.manifest.embeddingModel || DEFAULT_EMBEDDING_MODEL,
      icmrMatchMode: ICMR_MATCH_MODE,
      portionPriorMode: RID_PRICE_RERANK_ENABLED && PORTION_NUTRITION_ADJUSTMENT_ENABLED
        ? "retrieval_and_nutrition_adjustment"
        : RID_PRICE_RERANK_ENABLED
          ? "rid_price_retrieval_priority"
          : PORTION_NUTRITION_ADJUSTMENT_ENABLED
            ? "rid_price_nutrition_adjustment"
        : PORTION_PRIOR_MODE === "reference"
          ? "similar_dish_reference_baseline"
          : "off",
      vectorAsset: {
        available: true,
        createdAt: assets.manifest.createdAt || null,
        count: assets.manifest.count,
        dimensions: assets.manifest.dimensions,
      },
      separate_protein_confidence_available: true,
      separate_energy_confidence_available: true,
      extracted_values_from_description_available: true,
      fallback: {
        active: false,
        reasonCode: null,
        detail: null,
      },
      retrievalMode: RID_RX_CATEGORY_MODE_ENABLED
        ? "rid_rx_category_and_price_top8"
        : "price_top8",
      notes: PORTION_PRIOR_MODE === "reference"
        ? ["Each row is estimated as a similarity-weighted average of the retrieved labeled references; the OpenAI response model is bypassed."]
        : [
          "Each row uses labeled nutrition references, April 20 active menu context, ICMR ingredient references, helper rules, and a structured OpenAI response.",
          "Final confidence is the lower of the evidence-adjusted protein and energy confidence percentages. The evidence adjustment is heuristic and has not been benchmark-calibrated.",
          RID_RX_CATEGORY_MODE_ENABLED
            ? "RID selects the restaurant RX category; references are retrieved from the semantic top eight and reranked by category and item price. The category is not added to the embedding query.":
              "References are retrieved from the semantic top eight and reranked by item price.",
          ...(PORTION_NUTRITION_ADJUSTMENT_ENABLED ? ["A conservative price/category prior adjusts nutrition; its relative portion index is not serving weight in grams."] : []),
        ],
    },
    summary: summarizeResults(results),
    results,
  });

  const queryBlobs = items.map((item) => buildQueryBlob(item));
  let queryVectors;
  try {
    queryVectors = await getQueryEmbeddings(
      queryBlobs,
      assets.manifest.embeddingModel || DEFAULT_EMBEDDING_MODEL,
      assets.manifest.dimensions || undefined
    );
  } catch (error) {
    const results = items.map((item) => buildErrorResultRow(item, error));
    return {
      available: true,
      payload: buildPayload(results),
    };
  }

  const results = await mapWithConcurrency(items, MAX_CONCURRENCY, async (item, index) => {
    try {
      return await estimateOneItem(item, assets, queryVectors[index], queryBlobs[index]);
    } catch (error) {
      return buildErrorResultRow(item, error);
    }
  });

  return {
    available: true,
    payload: buildPayload(results),
  };
}
