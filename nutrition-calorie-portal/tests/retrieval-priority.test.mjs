import test from "node:test";
import assert from "node:assert/strict";

import { scoreNeighbor } from "../lib/retrieval-priority.mjs";

test("same category receives a preference and similar price adds a further boost", () => {
  const same = scoreNeighbor({
    retrievalScore: 0.70,
    itemPrice: 250,
    candidatePrice: 260,
    categoryMatch: true,
  });
  const otherCategory = scoreNeighbor({
    retrievalScore: 0.70,
    itemPrice: 250,
    candidatePrice: 260,
    categoryMatch: false,
  });
  assert.equal(same.categoryPriceMatch, true);
  assert.equal(same.categoryRerankBoost, 0.04);
  assert.ok(same.finalScore > otherCategory.finalScore);
  const categoryOnly = scoreNeighbor({
    retrievalScore: 0.70,
    itemPrice: 120,
    candidatePrice: 500,
    categoryMatch: true,
  });
  assert.equal(categoryOnly.categoryPriceMatch, false);
  assert.equal(categoryOnly.categoryRerankBoost, 0.04);
  assert.ok(same.finalScore > categoryOnly.finalScore);
});

test("category preference does not require price to be similar", () => {
  const result = scoreNeighbor({
    retrievalScore: 0.70,
    itemPrice: 120,
    candidatePrice: 500,
    categoryMatch: true,
  });
  assert.equal(result.categoryPriceMatch, false);
  assert.equal(result.categoryRerankBoost, 0.04);
});

test("missing price or category safely avoids the joint priority boost", () => {
  const missingPrice = scoreNeighbor({ retrievalScore: 0.7, itemPrice: null, candidatePrice: 200, categoryMatch: true });
  const missingCategory = scoreNeighbor({ retrievalScore: 0.7, itemPrice: 200, candidatePrice: 200, categoryMatch: false });
  assert.equal(missingPrice.categoryRerankBoost, 0.04);
  assert.equal(missingCategory.categoryRerankBoost, 0);
});
