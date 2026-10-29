const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function similarPrice(itemPrice, candidatePrice) {
  if (!Number.isFinite(itemPrice) || !Number.isFinite(candidatePrice)) return false;
  return Math.abs(itemPrice - candidatePrice) <= Math.max(candidatePrice * 0.35, 60);
}

/** Keep semantic retrieval primary; category is a preference and close price adds a smaller preference. */
export function scoreNeighbor({ retrievalScore, itemPrice, candidatePrice, categoryMatch, categoryBoost = 0.04 }) {
  const closeness = itemPrice == null || candidatePrice == null
    ? 0
    : clamp(1 - Math.abs(itemPrice - candidatePrice) / Math.max(candidatePrice * 0.35, 60), 0, 1);
  const priceBoost = Math.round(closeness * 0.02 * 10000) / 10000;
  const categoryPriceMatch = Boolean(categoryMatch && similarPrice(itemPrice, candidatePrice));
  const categoryRerankBoost = categoryMatch ? categoryBoost : 0;
  return {
    priceRerankBoost: priceBoost,
    categoryRerankBoost,
    categoryPriceMatch,
    finalScore: retrievalScore + priceBoost + categoryRerankBoost,
  };
}
