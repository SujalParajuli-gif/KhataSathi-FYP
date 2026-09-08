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
  importRowToDraft,
} from "../app/features/product-imports/reviewModel.ts";

test("image highlights keep the extractor's exact source row", () => {
  assert.deepEqual(displayImportSourceRegion({
    kind: "IMAGE",
    region: { top: 512, left: 80, bottom: 542, right: 920, scale: 1000 },
  }), { top: 512, left: 80, bottom: 542, right: 920, scale: 1000 });

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
  assert.deepEqual(describeReviewPayloadChanges(before, after), ["Category", "Rate"]);
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

  const swapped = applyImportBulkEdit(original, {
    priceMove: { from: "retailPrice", to: "wholesalePrice", conflictPolicy: "SWAP", clearSource: false },
  });
  assert.equal(swapped.payload.wholesalePrice, 10);
  assert.equal(swapped.payload.retailPrice, 8);
});

test("a single extracted supplier price appears as Rate instead of Coming soon", () => {
  const draft = importRowToDraft(
    { fileName: "Panas Jars.pdf", supplier: "Panas Jars", sourceType: "PDF" },
    {
      id: "row-1",
      rowNumber: 1,
      rawText: "1 35ml jar 1 10",
      status: "READY",
      parsed: {
        sourceType: "PDF_TEXT_TABLE_ROW",
        name: "35ml jar",
        sku: "PANAS-1",
        brand: "Panas Jars",
        category: "Uncategorized",
        extractedPrices: [{ key: "rate", label: "Rate rs.", value: 10 }],
        availabilityStatus: "COMING_SOON",
      },
    },
  );

  assert.equal(draft.ratePerPiece, 10);
  assert.equal(draft.availabilityStatus, "CATALOG_LISTED");
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

test("bulk edit updates taxonomy, packaging and availability while preserving other fields", () => {
  const original = {
    rowId: "row-3", name: "Mop 8 Inch", sku: "MOP-8", brand: "Generic",
    category: "Cleaning", ratePerPiece: 100, packageQuantity: 1,
    packageUnit: "PIECE", saleUnit: "PIECE", allowFractionalQty: false,
    quantityStep: 1, wholesaleEligible: true, retailPrice: 120,
    wholesalePrice: null, stock: 0, resolution: "CREATE_NEW",
    availabilityStatus: "CATALOG_LISTED",
  };
  const result = applyImportBulkEdit(original, {
    brand: "Bagmati",
    category: "Household",
    vendorSource: "Supplier Alpha",
    packageQuantity: 12,
    packageUnit: "BOX",
    availabilityStatus: "COMING_SOON",
  });
  assert.equal(result.payload.brand, "Bagmati");
  assert.equal(result.payload.category, "Household");
  assert.equal(result.payload.vendorSource, "Supplier Alpha");
  assert.equal(result.payload.packageQuantity, 12);
  assert.equal(result.payload.packageUnit, "BOX");
  assert.equal(result.payload.availabilityStatus, "COMING_SOON");
  assert.equal(result.payload.ratePerPiece, 100);
});

test("percentage decrease correctly applies markdown and skips items without base price", () => {
  const withRate = {
    rowId: "row-4", name: "Plate", sku: "PL-1", brand: "Bagmati",
    category: "Kitchen", ratePerPiece: 200, packageQuantity: null,
    packageUnit: "PIECE", saleUnit: "PIECE", allowFractionalQty: false,
    quantityStep: 1, wholesaleEligible: true, retailPrice: null,
    wholesalePrice: null, stock: 0, resolution: "CREATE_NEW",
  };
  const withoutRate = {
    ...withRate,
    rowId: "row-5",
    ratePerPiece: null,
  };
  const config = {
    percentage: { base: "ratePerPiece", target: "wholesalePrice", direction: "DECREASE", percent: 15 },
  };

  const res1 = applyImportBulkEdit(withRate, config);
  assert.equal(res1.payload.wholesalePrice, 170);
  assert.equal(res1.skippedOperations, 0);

  const res2 = applyImportBulkEdit(withoutRate, config);
  assert.equal(res2.payload.wholesalePrice, null);
  assert.equal(res2.skippedOperations, 1);
});
