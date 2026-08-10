import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProductSearchQuery } from "../modules/products/searchNormalization";
import { expandNormalizedProductSearchSynonyms } from "../modules/products/searchSynonyms";

const rules = [
  { normalizedAlias: "balti", normalizedCanonicalTerm: "bucket" },
  { normalizedAlias: "gamala", normalizedCanonicalTerm: "planter" },
  { normalizedAlias: "गमला", normalizedCanonicalTerm: "planter" },
  { normalizedAlias: "lunch carrier", normalizedCanonicalTerm: "lunch box" },
  { normalizedAlias: "carrier", normalizedCanonicalTerm: "container" },
];

function normalizeAndExpand(value: string) {
  return expandNormalizedProductSearchSynonyms(
    normalizeProductSearchQuery(value),
    rules,
  );
}

test("reviewed local-name aliases add their canonical concept", () => {
  assert.equal(normalizeAndExpand("plastic balti 12lit"), "plastic balti bucket 12 ltr");
  assert.equal(normalizeAndExpand("gamala"), "gamala planter");
  assert.equal(normalizeAndExpand("गमला"), "गमला planter");
});

test("longest phrase alias wins without recursively expanding inserted terms", () => {
  assert.equal(
    normalizeAndExpand("Everest lunch carrier"),
    "everest lunch carrier lunch box",
  );
});

test("expansion preserves original alias tokens for explainable matching", () => {
  assert.equal(normalizeAndExpand("balti"), "balti bucket");
  assert.notEqual(normalizeAndExpand("balti"), "bucket");
});

test("expansion does not duplicate a canonical phrase already beside its alias", () => {
  assert.equal(normalizeAndExpand("balti bucket"), "balti bucket");
  assert.equal(
    normalizeAndExpand("lunch carrier lunch box"),
    "lunch carrier lunch box",
  );
});

test("synonym expansion is deterministic and idempotent", () => {
  const once = normalizeAndExpand("BALTI and गमला");
  assert.equal(once, "balti bucket and गमला planter");
  assert.equal(expandNormalizedProductSearchSynonyms(once, rules), once);
});

test("empty and unrelated searches remain unchanged", () => {
  assert.equal(normalizeAndExpand(""), "");
  assert.equal(normalizeAndExpand("steel bottle"), "steel bottle");
});
