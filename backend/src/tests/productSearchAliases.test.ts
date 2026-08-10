import test from "node:test";
import assert from "node:assert/strict";
import {
  REVIEWED_PRODUCT_SEARCH_SYNONYM_SEED,
  SearchAliasValidationError,
  compileProductSearchDocument,
  prepareReviewedProductAlias,
  prepareReviewedSearchSynonym,
} from "../modules/products/searchAliasService";

test("reviewed synonym input stores raw and normalized forms", () => {
  assert.deepEqual(
    prepareReviewedSearchSynonym({ alias: "  BALTI  ", canonicalTerm: "Bucket" }),
    {
      alias: "BALTI",
      normalizedAlias: "balti",
      canonicalTerm: "Bucket",
      normalizedCanonicalTerm: "bucket",
    },
  );
  assert.deepEqual(prepareReviewedProductAlias(" १२ LITRE Jar "), {
    alias: "१२ LITRE Jar",
    normalizedAlias: "12 ltr jar",
  });
});

test("reviewed synonyms reject empty, self-mapping, and oversized values", () => {
  assert.throws(
    () => prepareReviewedSearchSynonym({ alias: "", canonicalTerm: "bucket" }),
    SearchAliasValidationError,
  );
  assert.throws(
    () => prepareReviewedSearchSynonym({ alias: "Bucket", canonicalTerm: "bucket" }),
    /different searchable text/,
  );
  assert.throws(
    () => prepareReviewedProductAlias("x".repeat(121)),
    /120 characters or fewer/,
  );
});

const baseProduct = {
  id: "product-1",
  name: "ECO BUCKET",
  productName: "Eco Bucket",
  sku: "KS-000001",
  barcode: "0012345",
  productCodeVariant: null,
  sizeValue: 12,
  sizeUnit: "LTR",
  packageQuantity: 1,
  packageUnit: "PIECE",
  saleUnit: "PIECE",
  category: "Plastic Goods",
  categoryGroup: "Household",
  vendorSource: null,
  brand: { name: "Home Brand" },
};

test("compiled documents combine structured product data and enabled product aliases", () => {
  const document = compileProductSearchDocument(
    {
      ...baseProduct,
      searchAliases: [
        { alias: "balti", isEnabled: true },
        { alias: "old bucket name", isEnabled: false },
      ],
    },
    [{ normalizedAlias: "balti", normalizedCanonicalTerm: "bucket" }],
  );

  assert.match(document, /eco bucket/);
  assert.match(document, /12 ltr/);
  assert.match(document, /balti bucket/);
  assert.doesNotMatch(document, /old bucket name/);
});

test("product-specific aliases do not leak into another product document", () => {
  const first = compileProductSearchDocument(
    { ...baseProduct, searchAliases: [{ alias: "shop special", isEnabled: true }] },
    [],
  );
  const second = compileProductSearchDocument(
    {
      ...baseProduct,
      id: "product-2",
      name: "OTHER BUCKET",
      sku: "KS-000002",
      searchAliases: [],
    },
    [],
  );

  assert.match(first, /shop special/);
  assert.doesNotMatch(second, /shop special/);
});

test("controlled seed contains only the reviewed local concept mappings", () => {
  assert.deepEqual(REVIEWED_PRODUCT_SEARCH_SYNONYM_SEED, [
    { alias: "balti", canonicalTerm: "bucket" },
    { alias: "बाल्टी", canonicalTerm: "bucket" },
    { alias: "tokri", canonicalTerm: "basket" },
    { alias: "टोकरी", canonicalTerm: "basket" },
    { alias: "gamala", canonicalTerm: "planter" },
    { alias: "गमला", canonicalTerm: "planter" },
    { alias: "dabba", canonicalTerm: "box" },
    { alias: "डब्बा", canonicalTerm: "box" },
    { alias: "botal", canonicalTerm: "bottle" },
    { alias: "बोतल", canonicalTerm: "bottle" },
    { alias: "pirka", canonicalTerm: "stool" },
    { alias: "पिर्का", canonicalTerm: "stool" },
  ]);
});
