import test from "node:test";
import assert from "node:assert/strict";

import { estimatePortionAdjustment, fitPortionPrior, getPriceBand } from "../lib/portion-prior.mjs";

const trainingRows = [];
for (let index = 0; index < 20; index += 1) {
  trainingRows.push({
    DISH_FAMILY: "rice bowl",
    ITEM_PRICE: index < 10 ? 150 : 350,
    RX_CLASSIFIER: index % 2 ? "PS" : "ENAT",
    ENERGY_KCAL: index < 10 ? 400 : 480,
    PROTEIN_GM: index < 10 ? 20 : 24,
  });
}

test("price parsing maps valid positive prices to the trained bands", () => {
  assert.equal(getPriceBand("₹250"), "200-299");
  assert.equal(getPriceBand("0"), null);
  assert.equal(getPriceBand("not a price"), null);
});

test("the learned prior returns separate, capped calorie and protein adjustments", () => {
  const prior = fitPortionPrior(trainingRows);
  const result = estimatePortionAdjustment({
    item: { price: "350", restaurantClassifier: "PS" },
    neighbors: [{ DISH_FAMILY: "rice bowl", retrieval_score: 0.9 }],
    prior,
  });
  assert.equal(result.reason, "learned_family_medians");
  assert.ok(result.calorie_multiplier >= 0.85 && result.calorie_multiplier <= 1.15);
  assert.ok(result.protein_multiplier >= 0.85 && result.protein_multiplier <= 1.15);
  assert.ok(result.multiplier >= 0.85 && result.multiplier <= 1.15);
});

test("missing price and category safely produce no adjustment", () => {
  const prior = fitPortionPrior(trainingRows);
  const result = estimatePortionAdjustment({
    item: { price: "", restaurantClassifier: null },
    neighbors: [{ DISH_FAMILY: "rice bowl", retrieval_score: 0.9 }],
    prior,
  });
  assert.equal(result.multiplier, 1);
  assert.deepEqual(result.missing_signals.sort(), ["category", "price"]);
});

test("price-only and category-only ablations do not include the other effect", () => {
  const prior = fitPortionPrior(trainingRows);
  const args = {
    item: { price: "350", restaurantClassifier: "PS" },
    neighbors: [{ DISH_FAMILY: "rice bowl", retrieval_score: 0.9 }],
    prior,
  };
  const priceOnly = estimatePortionAdjustment({ ...args, useCategory: false });
  const categoryOnly = estimatePortionAdjustment({ ...args, usePrice: false });
  assert.equal(priceOnly.category_effect, 0);
  assert.equal(categoryOnly.price_effect, 0);
});

test("unseen dish families safely fall back to the unadjusted estimate", () => {
  const prior = fitPortionPrior(trainingRows);
  const result = estimatePortionAdjustment({
    item: { price: "350", restaurantClassifier: "PS" },
    neighbors: [{ DISH_FAMILY: "unknown", retrieval_score: 0.9 }],
    prior,
  });
  assert.equal(result.applied, false);
  assert.equal(result.multiplier, 1);
});
