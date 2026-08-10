import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProductSearchDocument,
  normalizeProductSearchText,
  normalizeProductSearchQuery,
} from "../modules/products/searchNormalization";
import {
  PRODUCT_SEARCH_UNIT_DICTIONARY,
  PRODUCT_SEARCH_UNIT_NORMALIZER_VERSION,
  canonicalizeProductSearchUnits,
} from "../modules/products/searchUnitNormalization";

function normalizeWithUnits(input: string) {
  return canonicalizeProductSearchUnits(normalizeProductSearchText(input));
}

test("unit normalization has an explicit, reviewable dictionary version", () => {
  assert.equal(PRODUCT_SEARCH_UNIT_NORMALIZER_VERSION, 1);
  assert.deepEqual(
    PRODUCT_SEARCH_UNIT_DICTIONARY.map((definition) => definition.canonical),
    ["ltr", "ml", "kg", "gram", "piece", "meter", "cm", "mm", "inch", "dozen", "bundle", "box"],
  );
});

test("liter spellings and attached forms produce equivalent tokens", () => {
  const variants = ["12lit", "12 litre", "12 LTR", "12 liters", "१२लिटर"];
  variants.forEach((variant) => {
    assert.equal(normalizeWithUnits(variant), "12 ltr", variant);
  });
});

test("milliliter spellings produce equivalent tokens", () => {
  const variants = ["500ml", "500 milliliter", "500 MILLILITRES", "५००मिलिलिटर"];
  variants.forEach((variant) => {
    assert.equal(normalizeWithUnits(variant), "500 ml", variant);
  });
});

test("kilogram, kilo, gram, and piece variants canonicalize", () => {
  assert.equal(normalizeWithUnits("2 kilos 5KG 250 grams 100gm"), "2 kg 5 kg 250 gram 100 gram");
  assert.equal(normalizeWithUnits("6pc 12 PCS 3 pieces"), "6 piece 12 piece 3 piece");
});

test("catalog size and package units canonicalize", () => {
  assert.equal(
    normalizeWithUnits("3 metres 20cm 5 millimeters 12 inches"),
    "3 meter 20 cm 5 mm 12 inch",
  );
  assert.equal(
    normalizeWithUnits("2 dozens 1 bundles 4 boxes"),
    "2 dozen 1 bundle 4 box",
  );
});

test("supported Nepali unit words map to the stored canonical unit", () => {
  assert.equal(
    normalizeWithUnits("२ किलो ५०० ग्राम ३ वटा ४ मिटर"),
    "2 kg 500 gram 3 piece 4 meter",
  );
  assert.equal(
    normalizeWithUnits("१२ इन्च २ दर्जन १ बन्डल ३ बक्स"),
    "12 inch 2 dozen 1 bundle 3 box",
  );
});

test("ambiguous single-letter units require direct numeric context", () => {
  assert.equal(normalizeWithUnits("12g 2 l 5m 8in"), "12 gram 2 ltr 5 meter 8 inch");
  assert.equal(normalizeWithUnits("brand g model l m in stock"), "brand g model l m in stock");
  assert.equal(normalizeWithUnits("8 in stock"), "8 in stock");
});

test("unit normalization preserves decimals and does not convert quantities", () => {
  assert.equal(normalizeWithUnits("1.5kg 0.25 litre"), "1.5 kg 0.25 ltr");
  assert.notEqual(normalizeWithUnits("1 kg"), normalizeWithUnits("1000 gram"));
});

test("composed query normalization applies token and unit rules", () => {
  assert.equal(
    normalizeProductSearchQuery("  ＥＣＯ—BUCKET १२Litres "),
    "eco bucket 12 ltr",
  );
});

test("indexed documents include normalized structured size and package units", () => {
  assert.equal(
    buildProductSearchDocument({
      name: "Family Water Jar",
      sizeValue: 12,
      sizeUnit: "LITRE",
      packageQuantity: 6,
      packageUnit: "PIECES",
      saleUnit: "PIECE",
    }),
    "family water jar 12 ltr 6 piece piece",
  );
});

test("unit normalization is idempotent", () => {
  const samples = [
    "12lit",
    "500 MILLILITRES",
    "२ किलो ५०० ग्राम",
    "12g 2 l 5m 8in",
    "6 pieces 2 dozen",
    "brand g model l m in stock",
  ];

  samples.forEach((sample) => {
    const once = normalizeWithUnits(sample);
    assert.equal(normalizeWithUnits(once), once, sample);
  });
});
