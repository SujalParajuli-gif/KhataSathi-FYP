import test from "node:test";
import assert from "node:assert/strict";
import {
  PRODUCT_SEARCH_NORMALIZER_VERSION,
  buildProductSearchDocument,
  normalizeProductSearchQuery,
  normalizeProductSearchText,
  tokenizeNormalizedProductSearchText,
} from "../modules/products/searchNormalization";

test("product search normalization has an explicit persisted-document version", () => {
  assert.equal(PRODUCT_SEARCH_NORMALIZER_VERSION, 2);
});

test("normalizes Unicode width, Latin case, and whitespace with NFKC", () => {
  assert.equal(
    normalizeProductSearchText("  ＥＣＯ\u3000ＢＵＣＫＥＴ\t１２  "),
    "eco bucket 12",
  );
});

test("converts supported Devanagari digits without changing Devanagari words", () => {
  assert.equal(normalizeProductSearchText("चस्मा १२३"), "चस्मा 123");
  assert.equal(normalizeProductSearchText("१२.५ लिटर"), "12.5 लिटर");
});

test("treats punctuation, hyphens, and separators as consistent boundaries", () => {
  const expected = "eco bucket blue 12 pack";
  assert.equal(
    normalizeProductSearchText("ECO—BUCKET / Blue_12+Pack"),
    expected,
  );
  assert.equal(
    normalizeProductSearchText("eco / bucket-blue:12,pack"),
    expected,
  );
});

test("splits safe attached number-unit forms while retaining their spelling", () => {
  assert.equal(
    normalizeProductSearchText("12lit 1.5LTR 500ml 2Pieces"),
    "12 lit 1.5 ltr 500 ml 2 pieces",
  );
});

test("does not split alphanumeric product-code tokens that merely end like units", () => {
  assert.equal(
    normalizeProductSearchText("AB12ML MODEL500PCS KS-000001"),
    "ab12ml model500pcs ks 000001",
  );
});

test("preserves significant decimals, leading zeros, numeric values, and code tokens", () => {
  assert.equal(
    normalizeProductSearchText("SKU AB12 / 00125 / SIZE 1.50"),
    "sku ab12 00125 size 1.50",
  );
});

test("keeps conservative short and stop words", () => {
  assert.equal(normalizeProductSearchText("A can of The Tea"), "a can of the tea");
});

test("query and indexed document use the same normalizer", () => {
  const document = buildProductSearchDocument({
    name: "ECO—BUCKET 12lit",
    productName: "Eco Bucket",
    sku: "KS-000001",
    barcode: "0012345",
    brand: "Home & More",
    category: "Plastic Goods",
    aliases: ["Balti"],
  });

  assert.equal(
    document,
    "eco bucket 12 ltr eco bucket ks 000001 0012345 home more plastic goods balti",
  );
  assert.equal(normalizeProductSearchQuery("ＥＣＯ bucket १२lit"), "eco bucket 12 ltr");
});

test("tokenization is stable and returns no empty tokens", () => {
  assert.deepEqual(tokenizeNormalizedProductSearchText("  ECO--12lit  "), [
    "eco",
    "12",
    "lit",
  ]);
  assert.deepEqual(tokenizeNormalizedProductSearchText(""), []);
});

test("normalization is idempotent for representative catalog input", () => {
  const samples = [
    "ECO—BUCKET 12lit",
    "चस्मा १२.५ लिटर",
    "KS-000001 / AB12ML",
    "  A can\tof   tea  ",
    "500ml + 2Pieces",
    "ＦＲＯＳＴＹ＿ＢＵＣＫＥＴ",
  ];

  samples.forEach((sample) => {
    const once = normalizeProductSearchText(sample);
    assert.equal(normalizeProductSearchText(once), once, sample);
  });
});
