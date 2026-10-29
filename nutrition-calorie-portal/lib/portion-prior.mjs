const PRICE_BANDS = ["under-100", "100-199", "200-299", "300-499", "500-plus"];

export function getPriceBand(value) {
  if (value == null || value === "") return null;
  const parsed = Number(String(value).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  if (parsed < 100) return PRICE_BANDS[0];
  if (parsed < 200) return PRICE_BANDS[1];
  if (parsed < 300) return PRICE_BANDS[2];
  if (parsed < 500) return PRICE_BANDS[3];
  return PRICE_BANDS[4];
}

const clean = (value) => String(value || "").trim().toLowerCase();
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const logRatio = (value, baseline) => (value > 0 && baseline > 0 ? Math.log(value / baseline) : null);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Fit family-centered, shrunken median effects from labeled reference records. */
export function fitPortionPrior(records = []) {
  const families = new Map();
  for (const row of records) {
    const family = clean(row.DISH_FAMILY);
    const priceBand = getPriceBand(row.ITEM_PRICE);
    const category = clean(row.RX_CLASSIFIER);
    const kcal = Number(row.ENERGY_KCAL);
    const protein = Number(row.PROTEIN_GM);
    if (!family || (!Number.isFinite(kcal) && !Number.isFinite(protein))) continue;
    if (!families.has(family)) families.set(family, { kcal: [], protein: [], price: new Map(), category: new Map() });
    const stats = families.get(family);
    for (const [key, value] of [["kcal", kcal], ["protein", protein]]) {
      if (!Number.isFinite(value) || value <= 0) continue;
      stats[key].push(value);
      if (priceBand) {
        if (!stats.price.has(priceBand)) stats.price.set(priceBand, { kcal: [], protein: [] });
        stats.price.get(priceBand)[key].push(value);
      }
      if (category && category !== "unclassified") {
        if (!stats.category.has(category)) stats.category.set(category, { kcal: [], protein: [] });
        stats.category.get(category)[key].push(value);
      }
    }
  }
  return families;
}

function effectForGroup(values, baseline, minimumCount = 8) {
  if (values.length < minimumCount) return 0;
  const effect = logRatio(median(values), baseline);
  if (effect == null) return 0;
  const shrink = values.length / (values.length + 30);
  return clamp(effect * shrink, -0.10, 0.10);
}

/** Return a conservative relative nutrition adjustment; never claim grams. */
export function estimatePortionAdjustment({ item, neighbors = [], prior, usePrice = true, useCategory = true }) {
  const priceBand = getPriceBand(item.price);
  const category = useCategory ? clean(item.restaurantClassifier) : "";
  const usable = neighbors.filter((neighbor) => clean(neighbor.DISH_FAMILY) && Number(neighbor.retrieval_score) > 0);
  if (!prior || !usable.length) {
    return { applied: false, relative_portion_index: 1, multiplier: 1, calorie_multiplier: 1, protein_multiplier: 1, price_effect: 0, category_effect: 0, reason: "no_supported_family" };
  }

  let weightTotal = 0;
  const priceEffects = { kcal: 0, protein: 0 };
  const categoryEffects = { kcal: 0, protein: 0 };
  for (const neighbor of usable) {
    const weight = Number(neighbor.retrieval_score) ** 2;
    const family = prior.get(clean(neighbor.DISH_FAMILY));
    if (!family) continue;
    weightTotal += weight;
    for (const nutrient of ["kcal", "protein"]) {
      const baseline = median(family[nutrient]);
      const p = usePrice && priceBand ? family.price.get(priceBand)?.[nutrient] || [] : [];
      const c = category && category !== "unclassified" ? family.category.get(category)?.[nutrient] || [] : [];
      priceEffects[nutrient] += weight * effectForGroup(p, baseline);
      categoryEffects[nutrient] += weight * effectForGroup(c, baseline);
    }
  }
  if (!weightTotal) {
    return { applied: false, relative_portion_index: 1, multiplier: 1, calorie_multiplier: 1, protein_multiplier: 1, price_effect: 0, category_effect: 0, reason: "no_supported_family" };
  }

  // Separate price/category effects; bound their combined nutrition multiplier to ±15%.
  for (const nutrient of ["kcal", "protein"]) {
    priceEffects[nutrient] = clamp(priceEffects[nutrient] / weightTotal, -0.08, 0.08);
    categoryEffects[nutrient] = clamp(categoryEffects[nutrient] / weightTotal, -0.08, 0.08);
  }
  const multipliers = Object.fromEntries(["kcal", "protein"].map((nutrient) => [
    nutrient,
    clamp(Math.exp(priceEffects[nutrient] + categoryEffects[nutrient]), 0.85, 1.15),
  ]));
  const multiplier = Math.sqrt(multipliers.kcal * multipliers.protein);
  const missing = [];
  if (!priceBand || !usePrice) missing.push("price");
  if (!category || category === "unclassified") missing.push("category");
  return {
    applied: multiplier !== 1,
    relative_portion_index: Math.round(multiplier * 1000) / 1000,
    multiplier: Math.round(multiplier * 1000) / 1000,
    calorie_multiplier: Math.round(multipliers.kcal * 1000) / 1000,
    protein_multiplier: Math.round(multipliers.protein * 1000) / 1000,
    price_effect: priceBand && usePrice ? Math.round(((priceEffects.kcal + priceEffects.protein) / 2) * 1000) / 1000 : 0,
    category_effect: category && category !== "unclassified" ? Math.round(((categoryEffects.kcal + categoryEffects.protein) / 2) * 1000) / 1000 : 0,
    price_band: priceBand,
    restaurant_classifier: category || null,
    missing_signals: missing,
    reason: "learned_family_medians",
  };
}
