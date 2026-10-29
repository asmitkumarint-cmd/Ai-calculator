import test from "node:test";
import assert from "node:assert/strict";

import { withRestaurantClassifier } from "../lib/retrieval-query.mjs";

test("mapped restaurant category is added using the reference classifier field", () => {
  const parts = withRestaurantClassifier(["item_name: chicken biryani"], "India_1 - Premium");
  assert.deepEqual(parts, ["item_name: chicken biryani", "classifier: India_1 - Premium"]);
});

test("mapped restaurant category replaces a conflicting classifier to mirror reference semantics", () => {
  const parts = withRestaurantClassifier(
    ["item_name: chicken biryani", "classifier: dish-label"],
    "ENAT"
  );
  assert.deepEqual(parts, ["item_name: chicken biryani", "classifier: ENAT"]);
});

test("unmapped RID does not add an empty classifier field", () => {
  const original = ["item_name: chicken biryani"];
  assert.equal(withRestaurantClassifier(original, null), original);
});
