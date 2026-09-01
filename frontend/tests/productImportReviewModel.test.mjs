import assert from "node:assert/strict";
import test from "node:test";
import {
  applyImportBulkEdit,
  describeReviewPayloadChanges,
  displayImportSourceRegion,
  parsedImportRow,
  readableSourceHeader,
  sourcePreviewColumnWidth,
  sourceCellHasValue,
} from "../app/features/product-imports/reviewModel.ts";

test("legacy single-column image highlights move from the following row to the selected row", () => {
  assert.deepEqual(displayImportSourceRegion({
    kind: "IMAGE",
    region: { top: 512, left: 80, bottom: 542, right: 920, scale: 1000 },
  }), { top: 475, left: 80, bottom: 505, right: 920, scale: 1000 });

  assert.deepEqual(displayImportSourceRegion({
    kind: "IMAGE",
    regionAdjusted: true,
    region: { top: 475, left: 80, bottom: 505, right: 920, scale: 1000 },
  }), { top: 475, left: 80, bottom: 505, right: 920, scale: 1000 });
});

test("import review parsing tolerates an empty active row during filter and page transitions", () => {
  assert.deepEqual(parsedImportRow(null), {});
  assert.deepEqual(parsedImportRow(undefined), {});
});

test("import review parsing returns structured row data only for objects", () => {
  assert.deepEqual(parsedImportRow({ parsed: { name: "35ml Jar", ratePerPiece: 10 } }), {
    name: "35ml Jar",
    ratePerPiece: 10,
  });
  assert.deepEqual(parsedImportRow({ parsed: null }), {});
  assert.deepEqual(parsedImportRow({ parsed: "not-an-object" }), {});
});

test("spreadsheet preview removes empty columns without hiding zero values", () => {
  assert.equal(sourceCellHasValue(""), false);
  assert.equal(sourceCellHasValue(null), false);
  assert.equal(sourceCellHasValue(0), true);
  assert.equal(sourceCellHasValue("SPL"), true);
  assert.equal(readableSourceHeader("Purchase_Rate"), "Purchase Rate");
  assert.equal(readableSourceHeader("sku"), "SKU");
});

test("spreadsheet preview gives identifiers and product names enough isolated space", () => {
  assert.equal(sourcePreviewColumnWidth("SKU"), 250);
  assert.equal(sourcePreviewColumnWidth("Product_Name"), 240);
  assert.equal(sourcePreviewColumnWidth("Brand"), 150);
  assert.equal(sourcePreviewColumnWidth("Stock"), 105);
  assert.equal(sourcePreviewColumnWidth("Wholesale_Rate"), 120);
  assert.equal(sourcePreviewColumnWidth("Notes"), 150);
});

test("review history describes the exact saved fields that changed", () => {
  const before = {
    rowId: "row-1",
    name: "Bucket 13 Ltr",
    sku: "BAG-13",
    brand: "Bagmati",
    category: "Buckets",
    ratePerPiece: 100,
    packageQuantity: 12,
    packageUnit: "PIECE",
    saleUnit: "PIECE",
    allowFractionalQty: false,
    quantityStep: 1,
    wholesaleEligible: true,
    retailPrice: null,
    wholesalePrice: null,
    stock: 0,
    resolution: "CREATE_NEW",
  };
  const after = { ...before, category: "Buckets & Drums", ratePerPiece: 110 };
  assert.deepEqual(describeReviewPayloadChanges(before, after), ["Category", "Purchase rate"]);
});

test("selected-row price reassignment keeps each product's own price", () => {
  const original = {
    rowId: "row-1", name: "35ml jar", sku: "PANAS-35", brand: "Panas Pet",
    category: "Uncategorized", ratePerPiece: null, packageQuantity: null,
    packageUnit: "PIECE", saleUnit: "PIECE", allowFractionalQty: false,
    quantityStep: 1, wholesaleEligible: true, retailPrice: 10,
    wholesalePrice: 8, stock: 0, resolution: "CREATE_NEW",
  };
  const kept = applyImportBulkEdit(original, {
    priceMove: { from: "retailPrice", to: "wholesalePrice", conflictPolicy: "KEEP", clearSource: false },
  });
  assert.equal(kept.payload.wholesalePrice, 8);
  assert.equal(kept.priceConflict, true);
  assert.equal(kept.skippedOperations, 1);

  const replaced = applyImportBulkEdit(original, {
    priceMove: { from: "retailPrice", to: "wholesalePrice", conflictPolicy: "REPLACE", clearSource: true },
  });
  assert.equal(replaced.payload.wholesalePrice, 10);
  assert.equal(replaced.payload.retailPrice, null);
  assert.deepEqual(replaced.changedFields, ["Retail price", "Wholesale price"]);
});

test("selected-row percentage operations use each row's own base price", () => {
  const original = {
    rowId: "row-2", name: "Bucket", sku: "BUCKET", brand: "Bagmati",
    category: "Bucket", ratePerPiece: 185, packageQuantity: null,
    packageUnit: "PIECE", saleUnit: "PIECE", allowFractionalQty: false,
    quantityStep: 1, wholesaleEligible: true, retailPrice: null,
    wholesalePrice: null, stock: 0, resolution: "CREATE_NEW",
  };
  const result = applyImportBulkEdit(original, {
    percentage: { base: "ratePerPiece", target: "retailPrice", direction: "INCREASE", percent: 20 },
  });
  assert.equal(result.payload.retailPrice, 222);
  assert.deepEqual(result.changedFields, ["Retail price"]);
});
