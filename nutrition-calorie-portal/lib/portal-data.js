import { cache } from "react";
import fs from "node:fs/promises";
import path from "node:path";

import { tryEstimateMenuItemsWithGenAI } from "@/lib/genai-estimator";
import { hasMenuInputContent, normalizeMenuInput } from "@/lib/menu-input-schema";


const APP_DATA_DIR = path.join(process.cwd(), "app-data");
const OUTPUT_CONTRACT_VERSION = "gen-ai-forward-compatible-v1";


const readJson = cache(async (fileName) => {
  const filePath = path.join(APP_DATA_DIR, fileName);
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw);
});


export const getOverview = () => readJson("overview.json");
export const getFeaturedItems = () => readJson("featured.json");


let catalogPromise;
let exactMapPromise;


export async function getCatalog() {
  if (!catalogPromise) {
    catalogPromise = readJson("catalog.json");
  }
  return catalogPromise;
}


async function getExactMap() {
  if (!exactMapPromise) {
    exactMapPromise = getCatalog().then((catalog) => {
      const map = new Map();
      for (const item of catalog) {
        map.set(item.normalized_name, item);
      }
      return map;
    });
  }
  return exactMapPromise;
}


export function normalizeText(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}


function parseNumericValue(value, { allowZero = true } = {}) {
  if (value == null || value === "") {
    return null;
  }

  const normalized = String(value).replace(/[^0-9.]/g, "");
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  if (allowZero ? parsed < 0 : parsed <= 0) {
    return null;
  }

  return parsed;
}


function formatPrice(value) {
  const numeric = parseNumericValue(value, { allowZero: false });
  if (!numeric) {
    return null;
  }
  return `Rs ${Math.round(numeric)}`;
}


function roundValue(value, digits = 1) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}


function extractFirstNumericMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) {
      continue;
    }

    const parsed = Number(match[1]);
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
    /(?:^|[\s(:,;])(\d+(?:\.\d+)?)\s*(?:g|gm|grams?)\s*(?:of\s*)?protein\b/i,
    /\bprotein\b[^0-9]{0,12}(\d+(?:\.\d+)?)\s*(?:g|gm|grams?)\b/i,
  ];
  const energyPatterns = [
    /(?:^|[\s(:,;])(\d+(?:\.\d+)?)\s*(?:kcal|kcals|calories?)\b/i,
    /\b(?:energy|calories?)\b[^0-9]{0,12}(\d+(?:\.\d+)?)\s*(?:kcal|kcals|calories?)?\b/i,
  ];

  const extractedProtein = extractFirstNumericMatch(normalized, proteinPatterns);
  const extractedEnergy = extractFirstNumericMatch(normalized, energyPatterns);

  return {
    extracted_protein_g: extractedProtein,
    extracted_energy_kcal: extractedEnergy,
    source_field: extractedProtein != null || extractedEnergy != null ? "ITEM_DESCRIPTION" : null,
  };
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


function buildInputContextText(input) {
  return [
    input.mainIngredient1,
    input.mainIngredient2,
    input.mainIngredient3,
    input.compulsoryComponents,
    input.optionalComponents,
  ]
    .filter(Boolean)
    .join(" ");
}


function buildCandidateContextText(candidate) {
  return [
    candidate.display_name,
    candidate.description,
    candidate.train_dish_type,
    candidate.train_dish_family,
    candidate.reference_dish_type,
    candidate.reference_dish_family,
  ]
    .filter(Boolean)
    .join(" ");
}


function evaluatePriceSignal(input, candidate, identityScore, sharedTokenCount) {
  const inputPrice = parseNumericValue(input.price, { allowZero: false });
  const medianPrice = parseNumericValue(candidate.train_median_price, { allowZero: false });
  const bandLow = parseNumericValue(candidate.train_price_band_low);
  const bandHigh = parseNumericValue(candidate.train_price_band_high);
  const priceCount = parseNumericValue(candidate.train_price_count);
  const spreadRatioValue = Number(candidate.train_price_spread_ratio);
  const spreadRatio = Number.isFinite(spreadRatioValue) && spreadRatioValue >= 0 ? spreadRatioValue : null;

  if (!inputPrice) {
    return {
      boost: 0,
      status: "missing_input",
      note: "Item price was not available, so price could not be used as a dish-level tie-breaker.",
    };
  }

  if (!medianPrice || bandLow == null || bandHigh == null || priceCount == null || priceCount < 5) {
    return {
      boost: 0,
      status: "missing_history",
      note: "Price was ignored because this dish does not yet have enough item-level price history.",
    };
  }

  if (sharedTokenCount < 1 || identityScore < 0.58) {
    return {
      boost: 0,
      status: "weak_identity",
      note: "Price was ignored because the dish identity was not strong enough yet; name and description stayed primary.",
    };
  }

  const halfBandWidth = Math.max(medianPrice - bandLow, bandHigh - medianPrice, 1);
  const distanceFromMedian = Math.abs(inputPrice - medianPrice);
  const closeness = clamp(1 - distanceFromMedian / halfBandWidth, 0, 1);

  if (closeness <= 0) {
    return {
      boost: 0,
      status: "outside_band",
      note: `Item price sat outside this dish's usual band around ${formatPrice(medianPrice)}, so price was ignored.`,
    };
  }

  const supportFactor = clamp(priceCount / 24, 0, 1);
  const spreadFactor =
    spreadRatio == null ? 0.6 : clamp(1 / (1 + spreadRatio * 1.5), 0.35, 0.85);
  const boost = closeness * supportFactor * spreadFactor * 0.035;

  if (boost < 0.006) {
    return {
      boost: 0,
      status: "too_weak",
      note: `Item price was available, but the dish's historical price spread around ${formatPrice(medianPrice)} was broad enough that price stayed a negligible signal.`,
    };
  }

  const nearMedian = distanceFromMedian <= halfBandWidth * 0.35;
  return {
    boost,
    status: "applied",
    note: nearMedian
      ? `Item price sat near the dish median of ${formatPrice(medianPrice)}, so it added a small tie-break nudge.`
      : `Item price stayed within this dish's usual band around ${formatPrice(medianPrice)}, so it added only a slight tie-break nudge.`,
  };
}


function scoreCandidate(input, candidate) {
  const normalizedName = normalizeText(input.name);
  const normalizedDescription = normalizeText(input.description);
  const candidateName = candidate.normalized_name;
  const candidateDescription = normalizeText(candidate.description || "");
  const inputContext = buildInputContextText(input);
  const candidateContext = buildCandidateContextText(candidate);

  if (!normalizedName || !candidateName) {
    return {
      score: 0,
      queryCoverage: 0,
      candidateCoverage: 0,
      nameDiceScore: 0,
      descriptionScore: 0,
      contextScore: 0,
      cuisineScore: 0,
      identityScore: 0,
      contextUsed: false,
      priceSignal: { boost: 0, status: "missing_name", note: "Price was not considered because dish identity was missing." },
    };
  }

  const exact = normalizedName === candidateName ? 1 : 0;
  const contains = normalizedName.includes(candidateName) || candidateName.includes(normalizedName) ? 1 : 0;
  const inputTokens = uniqueTokens(normalizedName);
  const candidateTokens = uniqueTokens(candidateName);
  const candidateTokenSet = new Set(candidateTokens);
  let sharedTokenCount = 0;
  for (const token of inputTokens) {
    if (candidateTokenSet.has(token)) {
      sharedTokenCount += 1;
    }
  }
  const queryCoverage = inputTokens.length ? sharedTokenCount / inputTokens.length : 0;
  const candidateCoverage = candidateTokens.length ? sharedTokenCount / candidateTokens.length : 0;
  const nameDiceScore = diceScore(normalizedName, candidateName);
  const descriptionScore = normalizedDescription ? tokenScore(normalizedDescription, candidateDescription) : 0;
  const contextScore = inputContext ? tokenScore(inputContext, candidateContext) : 0;
  const cuisineScore =
    input.cuisine && candidate.top_cuisine && normalizeText(input.cuisine) === normalizeText(candidate.top_cuisine) ? 1 : 0;

  if (exact) {
    return {
      score: 1,
      queryCoverage,
      candidateCoverage,
      nameDiceScore,
      descriptionScore,
      contextScore,
      cuisineScore,
      identityScore: 1,
      contextUsed: Boolean(inputContext),
      priceSignal: {
        boost: 0,
        status: "exact",
        note: "Price was not allowed to override the exact dish identity.",
      },
    };
  }

  const structuralBoost = contains || queryCoverage >= 0.99 ? 0.3 : 0;
  const baseScore =
    structuralBoost +
    queryCoverage * 0.3 +
    candidateCoverage * 0.08 +
    nameDiceScore * 0.12 +
    descriptionScore * 0.03 +
    contextScore * 0.05 +
    cuisineScore * 0.02;
  const identityScore = Math.max(
    contains ? 1 : 0,
    queryCoverage,
    candidateCoverage,
    nameDiceScore,
    descriptionScore,
    contextScore * 0.85
  );
  const priceSignal = evaluatePriceSignal(input, candidate, identityScore, sharedTokenCount);

  return {
    score: Math.min(0.96, baseScore + priceSignal.boost),
    queryCoverage,
    candidateCoverage,
    nameDiceScore,
    descriptionScore,
    contextScore,
    cuisineScore,
    identityScore,
    contextUsed: Boolean(inputContext),
    priceSignal,
  };
}


function confidenceFromMatch(candidate, matchScore, matchType) {
  let score = candidate?.data_confidence || 30;
  score += Math.round(matchScore * 28);

  if (matchType === "fuzzy") {
    score -= 8;
  }

  score = Math.min(96, Math.max(18, score));

  let band = "Low";
  if (score >= 80) {
    band = "High";
  } else if (score >= 60) {
    band = "Medium";
  }

  return { score, band };
}


function formatExtractionNote(extractedValues) {
  const parts = [];

  if (extractedValues?.extracted_protein_g != null) {
    parts.push(`${extractedValues.extracted_protein_g} g protein`);
  }
  if (extractedValues?.extracted_energy_kcal != null) {
    parts.push(`${extractedValues.extracted_energy_kcal} kcal`);
  }

  if (!parts.length) {
    return "";
  }

  return `Explicit nutrition values in the description were captured separately (${parts.join(", ")}) and did not override the V1 estimate.`;
}


function buildExactRationale(match, extractedValues) {
  const parts = [
    `Matched directly to ${match.display_name} using ${match.support_count} modeled Swiggy rows.`,
    "Price was not allowed to override the exact dish identity.",
  ];
  const extractionNote = formatExtractionNote(extractedValues);
  if (extractionNote) {
    parts.push(extractionNote);
  }
  return parts.join(" ");
}


function buildFuzzyRationale(candidate, evaluation, extractedValues) {
  const parts = [`Matched to ${candidate.display_name} as the nearest modeled analogue with ${candidate.support_count} historical rows.`];

  if ((evaluation?.descriptionScore || 0) >= 0.08) {
    parts.push("Description text helped narrow the analogue.");
  }

  if (evaluation?.cuisineScore) {
    parts.push("Cuisine aligned with the matched catalog group.");
  }

  if (evaluation?.contextUsed && evaluation.contextScore >= 0.16) {
    parts.push("Ingredient or add-on details supported this analogue.");
  }

  if (evaluation?.priceSignal?.note) {
    parts.push(evaluation.priceSignal.note);
  }

  const extractionNote = formatExtractionNote(extractedValues);
  if (extractionNote) {
    parts.push(extractionNote);
  }

  return parts.join(" ");
}


function buildNoMatchRationale(candidate, evaluation, extractedValues) {
  if (!candidate) {
    const extractionNote = formatExtractionNote(extractedValues);
    return [
      "No stable catalog analogue was found in the current V1 lookup layer.",
      "Item price is intentionally too light to rescue a weak text match.",
      extractionNote,
    ]
      .filter(Boolean)
      .join(" ");
  }

  const parts = [`Nearest analogue was ${candidate.display_name}, but the text and context evidence stayed below the confidence bar.`];

  if ((evaluation?.descriptionScore || 0) >= 0.08) {
    parts.push("Description text was checked but still was not strong enough.");
  }

  if (evaluation?.contextUsed && evaluation.contextScore >= 0.12) {
    parts.push("Ingredient or add-on context was present but still did not clear the match bar.");
  }

  if (evaluation?.priceSignal?.note) {
    parts.push(evaluation.priceSignal.note);
  } else {
    parts.push("Item price stayed a secondary signal only.");
  }

  const extractionNote = formatExtractionNote(extractedValues);
  if (extractionNote) {
    parts.push(extractionNote);
  }

  return parts.join(" ");
}


function buildReasoningTrace(matchType, candidate, extractedValues) {
  let base = "No stable catalog analogue crossed the V1 threshold, so this row should be reviewed manually.";

  if (matchType === "Exact catalog match" && candidate) {
    base = `Exact dish-name match to ${candidate.display_name} in the modeled catalog.`;
  } else if (matchType === "Closest catalog analogue" && candidate) {
    base = `Closest catalog analogue was ${candidate.display_name} based on dish identity and supporting context.`;
  }

  const extractionNote = formatExtractionNote(extractedValues);
  return extractionNote ? `${base} ${extractionNote}` : base;
}


function buildInputPayload(item) {
  return {
    RID: item.rid || null,
    ITEM_NAME: item.name || null,
    ITEM_DESCRIPTION: item.description || null,
    RX_CUISINE: item.cuisine || null,
    ITEM_PRICE: item.price || null,
    ITEM_GRAMMAGE: item.grammage || null,
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


function buildInputUsage(item, evaluation, extractedValues) {
  const providedOptionalFields = [];
  if (item.description) {
    providedOptionalFields.push("ITEM_DESCRIPTION");
  }
  if (item.cuisine) {
    providedOptionalFields.push("RX_CUISINE");
  }
  if (item.grammage) {
    providedOptionalFields.push("ITEM_GRAMMAGE");
  }
  if (item.mainIngredient1 || item.mainIngredient2 || item.mainIngredient3) {
    providedOptionalFields.push("MAIN_INGREDIENTS");
  }
  if (item.mainIngredient1Grammage || item.mainIngredient2Grammage || item.mainIngredient3Grammage) {
    providedOptionalFields.push("MAIN_INGREDIENT_GRAMMAGES");
  }
  if (item.compulsoryComponents) {
    providedOptionalFields.push("COMPULSORY_COMPONENTS");
  }
  if (item.optionalComponents) {
    providedOptionalFields.push("OPTIONAL_COMPONENTS");
  }

  const signalsCheckedByV1 = ["ITEM_NAME"];
  if (item.description) {
    signalsCheckedByV1.push("ITEM_DESCRIPTION");
  }
  if (item.cuisine) {
    signalsCheckedByV1.push("RX_CUISINE");
  }
  if (item.mainIngredient1 || item.mainIngredient2 || item.mainIngredient3 || item.compulsoryComponents || item.optionalComponents) {
    signalsCheckedByV1.push("MAIN_INGREDIENTS_OR_COMPONENTS");
  }
  if (item.price && evaluation?.priceSignal?.status !== "exact") {
    signalsCheckedByV1.push("ITEM_PRICE");
  }

  const signalsThatHelpedThisMatch = ["ITEM_NAME"];
  if ((evaluation?.descriptionScore || 0) >= 0.08 && item.description) {
    signalsThatHelpedThisMatch.push("ITEM_DESCRIPTION");
  }
  if (evaluation?.cuisineScore && item.cuisine) {
    signalsThatHelpedThisMatch.push("RX_CUISINE");
  }
  if ((evaluation?.contextScore || 0) >= 0.16 && (item.mainIngredient1 || item.mainIngredient2 || item.mainIngredient3 || item.compulsoryComponents || item.optionalComponents)) {
    signalsThatHelpedThisMatch.push("MAIN_INGREDIENTS_OR_COMPONENTS");
  }
  if (evaluation?.priceSignal?.status === "applied") {
    signalsThatHelpedThisMatch.push("ITEM_PRICE");
  }

  const capturedButNotUsedByV1 = [];
  if (item.grammage) {
    capturedButNotUsedByV1.push("ITEM_GRAMMAGE");
  }
  if (item.mainIngredient1Grammage || item.mainIngredient2Grammage || item.mainIngredient3Grammage) {
    capturedButNotUsedByV1.push("MAIN_INGREDIENT_GRAMMAGES");
  }

  return {
    required_partner_inputs: ["RID", "ITEM_NAME", "ITEM_PRICE"],
    provided_optional_fields: providedOptionalFields,
    signals_checked_by_v1: signalsCheckedByV1,
    signals_that_helped_this_match: signalsThatHelpedThisMatch,
    captured_but_not_used_by_v1: capturedButNotUsedByV1,
    explicit_values_found_in_description: {
      available: extractedValues?.extracted_protein_g != null || extractedValues?.extracted_energy_kcal != null,
      extracted_protein_g: extractedValues?.extracted_protein_g ?? null,
      extracted_energy_kcal: extractedValues?.extracted_energy_kcal ?? null,
      source_field: extractedValues?.source_field ?? null,
    },
  };
}


function buildOutputPayload(reasoningTrace, estimatedProtein, estimatedEnergy, confidence, extractedValues) {
  return {
    reasoning_trace: reasoningTrace,
    estimated_protein_g: estimatedProtein,
    estimated_energy_kcal: estimatedEnergy,
    estimation_confidence: confidence.band,
    confidence_percent: confidence.score,
    extracted_protein_g: extractedValues.extracted_protein_g,
    extracted_energy_kcal: extractedValues.extracted_energy_kcal,
    confidence_detail: {
      protein_confidence: {
        band: null,
        percent: null,
        available: false,
        note: "Not available yet in deterministic V1. The future GenAI backend is expected to return this separately.",
      },
      energy_confidence: {
        band: null,
        percent: null,
        available: false,
        note: "Not available yet in deterministic V1. The future GenAI backend is expected to return this separately.",
      },
      final_confidence: {
        band: confidence.band,
        percent: confidence.score,
        source: "shared_match_confidence_v1",
        derived_from_minimum_rule: false,
        note: "Current deterministic V1 exposes one shared match confidence from catalog match strength. Final confidence will use the minimum of protein and energy confidences once they are available separately.",
      },
    },
  };
}


function buildExplainabilityPayload({
  item,
  candidate,
  evaluation,
  matchType,
  matchScore,
  matchedCuisine,
  supportCount,
  sourceLineage,
  reasoningTrace,
  rationale,
  extractedValues,
}) {
  return {
    reasoning_trace: reasoningTrace,
    detailed_rationale: rationale,
    match: {
      matched_name: candidate?.display_name || null,
      matched_cuisine: matchedCuisine,
      match_type: matchType,
      match_score_percent: matchScore,
      support_count: supportCount,
      source_lineage: sourceLineage,
    },
    inputs: buildInputUsage(item, evaluation, extractedValues),
    price_signal: evaluation?.priceSignal || {
      boost: 0,
      status: "not_checked",
      note: "Price was not checked for this row.",
    },
    scoring_snapshot: evaluation
      ? {
          query_coverage: roundValue(evaluation.queryCoverage, 2),
          candidate_coverage: roundValue(evaluation.candidateCoverage, 2),
          name_dice_score: roundValue(evaluation.nameDiceScore, 2),
          description_score: roundValue(evaluation.descriptionScore, 2),
          context_score: roundValue(evaluation.contextScore, 2),
          cuisine_score: roundValue(evaluation.cuisineScore, 2),
          identity_score: roundValue(evaluation.identityScore, 2),
        }
      : null,
    estimator_note:
      "This V1 is deterministic and lookup-based. Separate protein and energy confidences are not available yet, so the current final confidence is a shared match-strength score.",
  };
}


function buildResultRecord({
  item,
  candidate,
  evaluation,
  matchType,
  matchScore,
  confidence,
  estimatedProtein,
  estimatedEnergy,
  supportCount,
  matchedCuisine,
  sourceLineage,
  rationale,
  extractedValues,
}) {
  const reasoningTrace = buildReasoningTrace(matchType, candidate, extractedValues);
  const inputPayload = buildInputPayload(item);
  const outputPayload = buildOutputPayload(
    reasoningTrace,
    estimatedProtein,
    estimatedEnergy,
    confidence,
    extractedValues
  );

  return {
    row_id: item.rid,
    result_key: item.rowId,
    input_name: item.name,
    input_description: item.description,
    input_cuisine: item.cuisine,
    input_item_price: item.price,
    input_item_grammage: item.grammage,
    input_main_ingredient_1: item.mainIngredient1,
    input_main_ingredient_2: item.mainIngredient2,
    input_main_ingredient_3: item.mainIngredient3,
    input_main_ingredient_1_grammage: item.mainIngredient1Grammage,
    input_main_ingredient_2_grammage: item.mainIngredient2Grammage,
    input_main_ingredient_3_grammage: item.mainIngredient3Grammage,
    input_compulsory_components: item.compulsoryComponents,
    input_optional_components: item.optionalComponents,
    matched_name: candidate?.display_name || null,
    matched_cuisine: matchedCuisine,
    estimated_energy_kcal: estimatedEnergy,
    estimated_protein_g: estimatedProtein,
    support_count: supportCount,
    match_type: matchType,
    match_score: matchScore,
    confidence_score: confidence.score,
    confidence_band: confidence.band,
    estimation_confidence: outputPayload.estimation_confidence,
    confidence_percent: outputPayload.confidence_percent,
    extracted_protein_g: outputPayload.extracted_protein_g,
    extracted_energy_kcal: outputPayload.extracted_energy_kcal,
    reasoning_trace: reasoningTrace,
    rationale,
    source_lineage: sourceLineage,
    input: inputPayload,
    output: outputPayload,
    explainability: buildExplainabilityPayload({
      item,
      candidate,
      evaluation,
      matchType,
      matchScore,
      matchedCuisine,
      supportCount,
      sourceLineage,
      reasoningTrace,
      rationale,
      extractedValues,
    }),
  };
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


async function estimateMenuItemsDeterministic(items = []) {
  const cleanItems = items
    .map((item, index) => normalizeMenuInput(item, index))
    .filter(hasMenuInputContent);

  const limitedItems = cleanItems.slice(0, 80);
  const catalog = await getCatalog();
  const exactMap = await getExactMap();

  const results = limitedItems.map((item) => {
    const extractedValues = extractExplicitNutritionFromDescription(item.description);
    const normalizedName = normalizeText(item.name);
    const exactMatch = exactMap.get(normalizedName);

    if (exactMatch) {
      const confidence = confidenceFromMatch(exactMatch, 1, "exact");
      const exactEvaluation = {
        queryCoverage: 1,
        candidateCoverage: 1,
        nameDiceScore: 1,
        descriptionScore: 0,
        contextScore: 0,
        cuisineScore: 0,
        identityScore: 1,
        contextUsed: false,
        priceSignal: {
          boost: 0,
          status: "exact",
          note: "Price was not allowed to override the exact dish identity.",
        },
      };

      return buildResultRecord({
        item,
        candidate: exactMatch,
        evaluation: exactEvaluation,
        matchType: "Exact catalog match",
        matchScore: 100,
        confidence,
        estimatedProtein: exactMatch.predicted_protein_g,
        estimatedEnergy: exactMatch.predicted_energy_kcal,
        supportCount: exactMatch.support_count,
        matchedCuisine:
          exactMatch.top_cuisine || exactMatch.reference_cuisine || exactMatch.train_cuisine || "Unknown",
        sourceLineage: exactMatch.top_parent || exactMatch.train_restaurant || "Swiggy catalog model",
        rationale: buildExactRationale(exactMatch, extractedValues),
        extractedValues,
      });
    }

    let bestCandidate = null;
    let bestEvaluation = null;

    for (const candidate of catalog) {
      if (!candidate.normalized_name) {
        continue;
      }

      const evaluation = scoreCandidate(item, candidate);
      if (!bestEvaluation || evaluation.score > bestEvaluation.score) {
        bestEvaluation = evaluation;
        bestCandidate = candidate;
      }
    }

    const bestScore = bestEvaluation?.score || 0;

    if (!bestCandidate || bestScore < 0.58) {
      const confidence = { score: 24, band: "Low" };
      return buildResultRecord({
        item,
        candidate: bestCandidate,
        evaluation: bestEvaluation,
        matchType: "No confident match",
        matchScore: Math.round(bestScore * 100),
        confidence,
        estimatedProtein: null,
        estimatedEnergy: null,
        supportCount: 0,
        matchedCuisine: null,
        sourceLineage: "Manual review required",
        rationale: buildNoMatchRationale(bestCandidate, bestEvaluation, extractedValues),
        extractedValues,
      });
    }

    const confidence = confidenceFromMatch(bestCandidate, bestScore, "fuzzy");
    return buildResultRecord({
      item,
      candidate: bestCandidate,
      evaluation: bestEvaluation,
      matchType: "Closest catalog analogue",
      matchScore: Math.round(bestScore * 100),
      confidence,
      estimatedProtein: bestCandidate.predicted_protein_g,
      estimatedEnergy: bestCandidate.predicted_energy_kcal,
      supportCount: bestCandidate.support_count,
      matchedCuisine:
        bestCandidate.top_cuisine || bestCandidate.reference_cuisine || bestCandidate.train_cuisine || "Unknown",
      sourceLineage: bestCandidate.top_parent || bestCandidate.train_restaurant || "Swiggy catalog model",
      rationale: buildFuzzyRationale(bestCandidate, bestEvaluation, extractedValues),
      extractedValues,
    });
  });

  return {
    generatedAt: new Date().toISOString(),
    estimator: {
      engine: "deterministic_catalog_lookup_v1",
      contract_version: OUTPUT_CONTRACT_VERSION,
      extracted_values_from_description_available: true,
      separate_protein_confidence_available: false,
      separate_energy_confidence_available: false,
      fallback: {
        active: false,
        reasonCode: null,
        detail: null,
      },
      notes: [
        "V1 returns one shared match-strength confidence for the estimate.",
        "Separate protein and energy confidences are reserved for a later GenAI backend.",
      ],
    },
    summary: summarizeResults(results),
    results,
  };
}


export async function estimateMenuItems(items = []) {
  const genAiAttempt = await tryEstimateMenuItemsWithGenAI(items);
  if (genAiAttempt.available) {
    return genAiAttempt.payload;
  }

  throw new Error(
    genAiAttempt.detail ||
      "GenAI estimation is currently unavailable. Restore the OpenAI configuration and reference assets before running this workflow."
  );
}
