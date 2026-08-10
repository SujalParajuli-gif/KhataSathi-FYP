import test from "node:test";
import assert from "node:assert/strict";
import {
  PRODUCT_SEARCH_MATCH_PRIORITY,
  allowedProductSearchTypoDistance,
  boundedProductSearchEditDistance,
  buildBoundedProductSearchTypoCandidateIndex,
  findProductSearchTypoCorrections,
  findProductSearchTypoMatches,
} from "../modules/products/searchTypoTolerance";

const candidates = [
  { token: "basket", documentFrequency: 26 },
  { token: "bottle", documentFrequency: 45 },
  { token: "bucket", documentFrequency: 114 },
  { token: "container", documentFrequency: 9 },
  { token: "lunch", documentFrequency: 14 },
  { token: "planter", documentFrequency: 20 },
];

test("bounded edit distance counts adjacent transposition as one shop-entry typo", () => {
  assert.equal(boundedProductSearchEditDistance("bukcet", "bucket", 1), 1);
  assert.equal(boundedProductSearchEditDistance("lonch", "lunch", 1), 1);
  assert.equal(boundedProductSearchEditDistance("bucket", "basket", 1), null);
});

test("medium terms allow one edit and long terms allow at most two", () => {
  assert.equal(allowedProductSearchTypoDistance("mug"), 0);
  assert.equal(allowedProductSearchTypoDistance("bucket"), 1);
  assert.equal(allowedProductSearchTypoDistance("container"), 2);
  assert.equal(boundedProductSearchEditDistance("contianxr", "container", 2), 2);
});

test("numeric, normalized unit, and explicitly protected identifier tokens never fuzzy-match", () => {
  assert.equal(allowedProductSearchTypoDistance("1000"), 0);
  assert.equal(allowedProductSearchTypoDistance("bucket20"), 0);
  assert.equal(allowedProductSearchTypoDistance("meter"), 0);
  assert.equal(
    allowedProductSearchTypoDistance("customsku", new Set(["customsku"])),
    0,
  );
  assert.deepEqual(
    findProductSearchTypoMatches("customsku", candidates, {
      protectedTokens: new Set(["customsku"]),
    }),
    [],
  );
});

test("lonch resolves to lunch while unrelated terms remain unmatched", () => {
  assert.equal(findProductSearchTypoMatches("lonch", candidates)[0]?.candidateToken, "lunch");
  assert.deepEqual(findProductSearchTypoMatches("chair", candidates), []);
});

test("typo matches are deterministic and always score below prefix, alias, and exact", () => {
  const result = findProductSearchTypoMatches("botle", [
    { token: "bottle", documentFrequency: 2 },
    { token: "bitle", documentFrequency: 1 },
    { token: "bottle", documentFrequency: 45 },
  ]);
  assert.deepEqual(
    result.map((match) => [match.candidateToken, match.documentFrequency]),
    [
      ["bottle", 45],
      ["bitle", 1],
    ],
  );
  assert.ok(result.every((match) => match.score < PRODUCT_SEARCH_MATCH_PRIORITY.prefix));
  assert.ok(PRODUCT_SEARCH_MATCH_PRIORITY.prefix < PRODUCT_SEARCH_MATCH_PRIORITY.alias);
  assert.ok(PRODUCT_SEARCH_MATCH_PRIORITY.alias < PRODUCT_SEARCH_MATCH_PRIORITY.exact);
});

test("candidate indexing is bounded by documents and unique eligible tokens", () => {
  const index = buildBoundedProductSearchTypoCandidateIndex(
    ["bucket bottle 12 ltr", "basket planter", "container lunch", "ignored token"],
    { maxDocuments: 3, maxCandidateTokens: 4 },
  );
  assert.equal(index.documentsIndexed, 3);
  assert.equal(index.uniqueTokenCount, 4);
  assert.equal(index.truncated, true);
  assert.ok(index.candidates.every((candidate) => !/\d/u.test(candidate.token)));
});

test("multi-token correction work and returned alternatives are capped", () => {
  const query = Array.from({ length: 20 }, () => "lonch").join(" ");
  const matches = findProductSearchTypoCorrections(query, candidates, {
    maxCorrectionsPerToken: 1,
  });
  assert.equal(matches.length, 8);
  assert.ok(matches.every((match) => match.candidateToken === "lunch"));
});
