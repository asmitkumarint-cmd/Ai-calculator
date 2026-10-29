import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decodeRidClassifierAsset } from "../lib/rid-rx-mapping.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("packaged RID asset resolves restaurant IDs and safely misses unknown IDs", async () => {
  const compressed = await readFile(path.join(root, "app-data/rid-rx-classifier.bin.gz"));
  const lookup = decodeRidClassifierAsset(compressed);
  assert.equal(lookup("21141"), "PS");
  assert.equal(lookup("1127371"), "National - Non Premium");
  assert.equal(lookup("999999999"), null);
  assert.equal(lookup("not-an-id"), null);
});
