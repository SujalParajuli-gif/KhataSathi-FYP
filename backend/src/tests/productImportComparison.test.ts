import test from "node:test";
import assert from "node:assert/strict";
import {
  compareImportRowToCatalog,
  compareImportRowsToCatalog,
  fingerprintImportFile,
  resolveProductAvailability,
  type ComparableCatalogProduct,
} from "../modules/products/importComparison";

const bagmatiBucket: ComparableCatalogProduct = {
  id: "product-1",
  name: "BUCKET 13 LTR",
  brandName: "Bagmati",
  productCodeVariant: "1301",
  category: "BUCKET",
  packageQuantity: 50,
  ratePerPiece: 235,
  availabilityStatus: "CATALOG_LISTED",
};

test("file fingerprints are stable for identical bytes and change with content", () => {
  assert.equal(fingerprintImportFile(Buffer.from("same")), fingerprintImportFile(Buffer.from("same")));
  assert.notEqual(fingerprintImportFile(Buffer.from("same")), fingerprintImportFile(Buffer.from("changed")));
  assert.match(fingerprintImportFile(Buffer.from("same")), /^[a-f0-9]{64}$/);
});

test("a missing Rate needs an explicit Coming soon decision", () => {
  assert.equal(resolveProductAvailability(null), "COMING_SOON");
  const pendingDecision = compareImportRowToCatalog({
    rowKey: "25:173",
    name: "ROYAL PLANTER BIG",
    brand: "Bagmati",
    ratePerPiece: null,
  }, []);
  assert.equal(pendingDecision.comparisonStatus, "NEEDS_REVIEW");
  assert.match(pendingDecision.message || "", /mark this product as Coming soon/);

  const result = compareImportRowToCatalog({
    rowKey: "25:173",
    name: "ROYAL PLANTER BIG",
    brand: "Bagmati",
    ratePerPiece: null,
    availabilityStatus: "COMING_SOON",
  }, []);
  assert.equal(result.comparisonStatus, "READY_NEW");
  assert.equal(result.availabilityStatus, "COMING_SOON");
});

test("an announced retail price can be imported without inventing a purchase rate", () => {
  assert.equal(resolveProductAvailability(null, 299, null), "CATALOG_LISTED");
  const result = compareImportRowToCatalog({
    rowKey: "spl:2",
    name: "Air Tight Container Big",
    brand: "SPL",
    ratePerPiece: null,
    retailPrice: 299,
    wholesalePrice: null,
  }, []);
  assert.equal(result.comparisonStatus, "READY_NEW");
  assert.equal(result.availabilityStatus, "CATALOG_LISTED");
});

test("an ambiguous catalog identity remains a conflict even when the incoming Rate is blank", () => {
  const result = compareImportRowToCatalog({
    rowKey: "duplicate:1",
    name: "BUCKET 13 LTR",
    brand: "Bagmati",
    ratePerPiece: null,
  }, [
    bagmatiBucket,
    { ...bagmatiBucket, id: "product-2" },
  ]);

  assert.equal(result.comparisonStatus, "IDENTIFIER_CONFLICT");
  assert.match(result.message || "", /matches 2 catalog products/);
});

test("same brand and product code produces an exact duplicate", () => {
  const result = compareImportRowToCatalog({
    rowKey: "3:6",
    name: "BUCKET 13 LTR",
    brand: "Bagmati",
    productCodeVariant: "1301",
    category: "BUCKET",
    packageQuantity: 50,
    ratePerPiece: 235,
  }, [bagmatiBucket]);
  assert.equal(result.comparisonStatus, "EXACT_DUPLICATE");
  assert.equal(result.matchedProductId, "product-1");
  assert.deepEqual(result.changes, []);
});

test("a changed supplier price is presented as a matched field change", () => {
  const result = compareImportRowToCatalog({
    rowKey: "3:6",
    name: "BUCKET 13 LTR",
    brand: "Bagmati",
    productCodeVariant: "1301",
    category: "BUCKET",
    packageQuantity: 50,
    ratePerPiece: 245,
  }, [bagmatiBucket]);
  assert.equal(result.comparisonStatus, "MATCHED_WITH_CHANGES");
  assert.deepEqual(result.changes, [{
    field: "ratePerPiece",
    currentValue: 235,
    incomingValue: 245,
  }]);
});

test("reviewed selling-price mappings are detected as matched changes", () => {
  const result = compareImportRowToCatalog({
    rowKey: "3:6",
    name: "BUCKET 13 LTR",
    brand: "Bagmati",
    retailPrice: 260,
    wholesalePrice: 250,
  }, [{
    ...bagmatiBucket,
    retailPrice: 250,
    wholesalePrice: 240,
  }]);
  assert.equal(result.comparisonStatus, "MATCHED_WITH_CHANGES");
  assert.deepEqual(result.changes, [
    { field: "retailPrice", currentValue: 250, incomingValue: 260 },
    { field: "wholesalePrice", currentValue: 240, incomingValue: 250 },
  ]);
});

test("missing optional package data does not erase a known catalog package", () => {
  const result = compareImportRowToCatalog({
    rowKey: "3:6",
    name: "BUCKET 13 LTR",
    brand: "Bagmati",
    productCodeVariant: "1301",
    category: "BUCKET",
    packageQuantity: null,
    ratePerPiece: 235,
  }, [bagmatiBucket]);
  assert.equal(result.comparisonStatus, "EXACT_DUPLICATE");
});

test("the second occurrence of one brand product identity is an in-file duplicate", () => {
  const results = compareImportRowsToCatalog([
    { rowKey: "16:385", name: "PET JAR 2500 ML", brand: "Bagmati", ratePerPiece: 44 },
    { rowKey: "16:386", name: "PET JAR 2500 ML", brand: "Bagmati", ratePerPiece: 44 },
  ], []);
  assert.equal(results[0].comparisonStatus, "READY_NEW");
  assert.equal(results[1].comparisonStatus, "IN_FILE_DUPLICATE");
});

test("a supplier code cannot override a different brand-name identity", () => {
  const result = compareImportRowToCatalog({
    rowKey: "3:6",
    name: "BAGMATI BUCKET 13 LTR",
    brand: "Bagmati",
    productCodeVariant: "1301",
    category: "BUCKET",
    packageQuantity: 50,
    ratePerPiece: 235,
  }, [bagmatiBucket]);
  assert.equal(result.comparisonStatus, "IDENTIFIER_CONFLICT");
  assert.match(result.message || "", /different brand or name/i);
});

test("reused supplier codes do not make different product names in-file duplicates", () => {
  const results = compareImportRowsToCatalog([
    { rowKey: "1", name: "BUCKET 25 LTR WITHOUT LID", brand: "Bagmati", productCodeVariant: "2501", ratePerPiece: 100 },
    { rowKey: "2", name: "BUCKET 25 LTR WITH LID", brand: "Bagmati", productCodeVariant: "2501", ratePerPiece: 120 },
  ], []);
  assert.equal(results[0].comparisonStatus, "READY_NEW");
  assert.equal(results[1].comparisonStatus, "READY_NEW");
});

test("brand and name stay authoritative when an unused incoming code changes", () => {
  const result = compareImportRowToCatalog({
    rowKey: "3:6",
    name: "BUCKET 13 LTR",
    brand: "Bagmati",
    productCodeVariant: "NEW-1301",
    ratePerPiece: 235,
  }, [bagmatiBucket]);
  assert.equal(result.comparisonStatus, "MATCHED_WITH_CHANGES");
  assert.equal(result.matchedProductId, "product-1");
  assert.equal(result.changes[0]?.field, "productCodeVariant");
});

test("an identifier pointing to another product is a conflict", () => {
  const result = compareImportRowToCatalog({
    rowKey: "1",
    name: "BUCKET 13 LTR",
    brand: "Bagmati",
    barcode: "OTHER-1",
    ratePerPiece: 235,
  }, [
    bagmatiBucket,
    { ...bagmatiBucket, id: "product-2", name: "BOTTLE 1 LTR", barcode: "OTHER-1" },
  ]);
  assert.equal(result.comparisonStatus, "IDENTIFIER_CONFLICT");
  assert.match(result.message || "", /belongs to another/i);
});

test("a conflicting size cannot silently become an exact duplicate", () => {
  const result = compareImportRowToCatalog({
    rowKey: "1",
    name: "BUCKET",
    brand: "Bagmati",
    sizeValue: 10,
    sizeUnit: "LTR",
    ratePerPiece: 235,
  }, [{ ...bagmatiBucket, name: "BUCKET", sizeValue: 5, sizeUnit: "LTR" }]);
  assert.equal(result.comparisonStatus, "IDENTIFIER_CONFLICT");
  assert.match(result.message || "", /size differs/i);
});

test("same in-file identity with different prices requires review", () => {
  const results = compareImportRowsToCatalog([
    { rowKey: "1", name: "PET JAR", brand: "Bagmati", ratePerPiece: 44 },
    { rowKey: "2", name: "PET JAR", brand: "Bagmati", ratePerPiece: 45 },
  ], []);
  assert.equal(results[1].comparisonStatus, "IDENTIFIER_CONFLICT");
  assert.match(results[1].message || "", /Rate differ/i);
});

test("one barcode attached to different in-file products is a conflict", () => {
  const results = compareImportRowsToCatalog([
    { rowKey: "1", name: "PET JAR", brand: "Bagmati", barcode: "123", ratePerPiece: 44 },
    { rowKey: "2", name: "WATER BOTTLE", brand: "Bagmati", barcode: "123", ratePerPiece: 44 },
  ], []);
  assert.equal(results[1].comparisonStatus, "IDENTIFIER_CONFLICT");
  assert.match(results[1].message || "", /product name differ/i);
});
