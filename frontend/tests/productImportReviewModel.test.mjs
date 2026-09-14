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
  importRowNeedsAttention,
  importRowPriceLabel,
  validateImportDraft,
  comparisonLabel,
  changeImportDraft,
  draftPayload,
} from "../app/features/product-imports/reviewModel.ts";

test("attention styling indicates unresolved issues, not user corrections", () => {
  const row = { status: "READY", comparisonStatus: "READY_NEW", resolution: "CREATE_NEW", reviewChanges: ["Rate"] };
  assert.equal(importRowNeedsAttention(row), false);
  assert.equal(importRowNeedsAttention({ ...row, comparisonStatus: "MATCHED_WITH_CHANGES", resolution: null }), true);
  assert.equal(importRowNeedsAttention({ ...row, comparisonStatus: "IDENTIFIER_CONFLICT" }), true);
  assert.equal(importRowNeedsAttention({ ...row, comparisonStatus: "IN_FILE_DUPLICATE", resolution: "IGNORE" }), false);
  assert.equal(importRowNeedsAttention({ ...row, status: "IMPORTED", error: "Historical warning" }), false);
});
test("price labels distinguish retail, wholesale, unmapped source and genuinely missing prices", () => {
  assert.equal(importRowPriceLabel({ parsed: { retailPrice: 120 } }), "Retail NPR 120");
  assert.equal(importRowPriceLabel({ parsed: { wholesalePrice: 95 } }), "Wholesale NPR 95");
  assert.equal(importRowPriceLabel({ parsed: { extractedPrices: [{ value: 100 }] } }), "Source NPR 100");
  assert.equal(importRowPriceLabel({ parsed: {} }), "Price missing");
  assert.equal(comparisonLabel("MATCHED_WITH_CHANGES"), "Catalog differences");
});
test("draft validation points to fields and does not confuse unmapped prices with missing prices", () => {
  const draft = { name: "", brand: "", ratePerPiece: null, availabilityStatus: "CATALOG_LISTED" };
  assert.deepEqual(validateImportDraft(draft).map(issue => issue.field), ["name", "brand", "ratePerPiece"]);
  assert.deepEqual(validateImportDraft(draft, true).map(issue => issue.field), ["name", "brand"]);
  assert.deepEqual(validateImportDraft({ ...draft, resolution: "IGNORE" }), []);
  assert.equal(validateImportDraft({ ...draft, name: "Jar", brand: "Example", retailPrice: 100 }).length, 0);
});
test("a supplier is not silently substituted for a missing product brand", () => {
  const draft = importRowToDraft({ fileName: "multi-brand.pdf", supplier: "Distributor", sourceType: "PDF" },
    { id: "row", rowNumber: 1, parsed: { name: "Jar" } });
  assert.equal(draft.brand, "");
});
test("missing extracted identity fields remain empty instead of inventing a product name or SKU", () => {
  const draft = importRowToDraft({ fileName: "catalog.pdf", sourceType: "PDF" },
    { id: "row", rowNumber: 1, rawText: "Unrecognized header text", parsed: {} });
  assert.equal(draft.name, "");
  assert.equal(draft.sku, "");
  assert.ok(validateImportDraft(draft).some(issue => issue.field === "name"));
});

test("focus or unchanged selections do not dirty a row; reverting corrections restores its saved decision", () => {
  const baseline = importRowToDraft({ fileName: "catalog.pdf", sourceType: "PDF" },
    { id: "row", rowNumber: 1, resolution: "KEEP_EXISTING", parsed: { name: "Jar", brand: "Example", ratePerPiece: 100 } });
  assert.equal(changeImportDraft(baseline, baseline, "brand", "Example"), baseline);
  const changed = changeImportDraft(baseline, baseline, "name", "Large Jar");
  assert.equal(changed.resolution, null);
  assert.deepEqual(draftPayload(changeImportDraft(changed, baseline, "name", "Jar")), draftPayload(baseline));
});

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

test("an extracted price stays unmapped until its destination is confirmed", () => {
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

  assert.equal(draft.ratePerPiece, null);
  assert.equal(draft.availabilityStatus, "COMING_SOON");
});

test("a confirmed Rate mapping appears as catalog data", () => {
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
        ratePerPiece: 10,
        extractedPrices: [{ key: "rate", label: "Rate rs.", value: 10 }],
        availabilityStatus: "CATALOG_LISTED",
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
