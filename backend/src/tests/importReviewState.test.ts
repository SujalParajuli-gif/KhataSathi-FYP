import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import { importReviewChanges, mergeReviewedImportEvidence, pendingImportWarnings, importReviewIssues } from "../modules/products/importReviewState";
import { prepareReviewedImportRowDraft, saveReviewedProductImportRows, setProductImportPriceMapping, refreshExtractedImportComparisons, getProductImportReview } from "../modules/products/importService";

function source(overrides: Record<string, any> = {}): Record<string, any> {
  return { name: "Container", productName: "Container", brand: "Example", sku: "AUTO-1", skuWasGenerated: true,
    barcode: "", category: "", productCodeVariant: "", ratePerPiece: 100, availabilityStatus: "CATALOG_LISTED",
    sourceType: "PDF_TEXT_TABLE_ROW", ...overrides };
}
function saveEvidence(stored: Record<string, any>, original = stored, overrides: Record<string, any> = {}, ack = false) {
  return mergeReviewedImportEvidence(stored, original, prepareReviewedImportRowDraft({ ...stored, rowId: "row-1", ...overrides }), ack);
}

for (const sourceType of ["PDF_TEXT_TABLE_ROW", "PDF_SCANNED_AI_ROW", "IMAGE_AI_ROW", "CSV_ROW"]) {
  test(`unchanged ${sourceType} save with upload brand is not a user correction`, () => {
    const original = source({ sourceType, brand: "Brand entered at upload" });
    const saved = saveEvidence(original);
    assert.deepEqual(importReviewChanges(saved, original), []);
    assert.deepEqual(importReviewChanges(saveEvidence(saved, original), original), []);
  });
}
test("legacy missing aliases and blank optional values do not mark every field", () => {
  const original = source({ brand: "" });
  const saved = { name: "Container", sku: "AUTO-1", brand: "Confirmed brand", ratePerPiece: 100, availabilityStatus: "CATALOG_LISTED" };
  assert.deepEqual(importReviewChanges(saved, original), []);
});
test("brand confirmation is setup; changing a confirmed brand is a correction; reverting clears it", () => {
  const original = source({ brand: "" });
  const confirmed = saveEvidence(original, original, { brand: "Example" });
  assert.deepEqual(importReviewChanges(confirmed, original), []);
  const corrected = saveEvidence(confirmed, original, { brand: "Another brand" });
  assert.deepEqual(importReviewChanges(corrected, original), ["Brand"]);
  assert.deepEqual(importReviewChanges(saveEvidence(corrected, original, { brand: "Example" }), original), []);
});
test("correcting a legacy confirmed brand is not silently treated as new setup", () => {
  const original = source({ brand: "" });
  const legacy = { ...original, brand: "Confirmed earlier", sourceType: "REVIEWED_ROW_DRAFT" };
  const corrected = saveEvidence(legacy, original, { brand: "Corrected brand" });
  assert.deepEqual(importReviewChanges(corrected, original), ["Brand"]);
});
test("generating a missing internal SKU is setup, not a manual product correction", () => {
  const original = source({ sku: "" });
  const saved = saveEvidence(original);
  assert.ok(saved.sku);
  assert.equal(saved.skuWasGenerated, true);
  assert.deepEqual(importReviewChanges(saved, original), []);
});
for (const [field, value, label] of [
  ["name", "Another container", "Product name"], ["barcode", "123", "Barcode"], ["sku", "MANUAL", "SKU"],
  ["vendorSource", "Other supplier", "Supplier"], ["ratePerPiece", 110, "Rate"],
  ["packageQuantity", 24, "Package quantity"], ["quantityStep", 0.5, "Quantity step"],
  ["allowFractionalQty", true, "Fractional quantity"], ["wholesaleEligible", false, "Wholesale eligibility"],
  ["searchAliases", ["storage"], "Search terms"],
] as const) {
  test(`actual ${field} corrections are reported and revert cleanly`, () => {
    const original = source();
    const saved = saveEvidence(original, original, { [field]: value });
    assert.deepEqual(importReviewChanges(saved, original), [label]);
    assert.deepEqual(importReviewChanges(saveEvidence(saved, original, { [field]: original[field] }), original), []);
    if (field === "sku") assert.equal(saved.skuWasGenerated, false);
  });
}
test("saving preserves original prices, coordinates and warnings until explicitly confirmed", () => {
  const original = source({ warnings: ["Check unreadable fields: packageQuantity."], uncertainFields: ["packageQuantity"],
    extractedPrices: [{ key: "mrp", label: "MRP", value: 100 }], pageNumber: 3 });
  const saved = saveEvidence(original);
  assert.deepEqual(saved.extractedPrices, original.extractedPrices);
  assert.equal(saved.pageNumber, 3);
  assert.deepEqual(pendingImportWarnings(saved), original.warnings);
  assert.equal(importReviewIssues({ parsed: saved })[0].field, "packageQuantity");
  const checked = saveEvidence(saved, original, {}, true);
  assert.deepEqual(pendingImportWarnings(checked), []);
  assert.deepEqual(importReviewChanges(checked, original), []);
  assert.deepEqual(pendingImportWarnings(saveEvidence(checked, original, { packageQuantity: 20 })), original.warnings);
});
test("filled brand warning clears without hiding other extraction warnings", () => {
  const saved = saveEvidence(source({ brand: "", warnings: ["Confirm the product brand before importing.", "Check source price."] }), undefined, { brand: "Example" });
  assert.deepEqual(pendingImportWarnings(saved), ["Check source price."]);
  assert.deepEqual(importReviewIssues({ parsed: saved, resolution: "IGNORE" }), []);
});

// In-memory persistence exercises the actual save/mapping/classification services without touching a shop DB.
function installBatchMocks(t: any, sources: Record<string, any>[], catalog: any[] = [], mapping: any = null) {
  const mockMethod = (object: any, key: string, implementation: any) => {
    const original = object[key];
    object[key] = implementation;
    t.after(() => { object[key] = original; });
  };
  const rows = sources.map((parsed, index) => ({ id: `row-${index + 1}`, batchId: "batch", rowNumber: index + 1,
    rawText: parsed.name, parsed: structuredClone(parsed), extracted: structuredClone(parsed), status: "READY",
    comparisonStatus: "READY_NEW", resolution: null, error: null, matchedProductId: null, changeSet: [] }));
  const batch: any = { id: "batch", rows, status: "DRAFT", deletedAt: null, priceMapping: mapping,
    extractionMeta: { priceColumns: [{ key: "mrp", label: "MRP" }] } };
  mockMethod(prisma.productImportBatch, "findFirst", async () => batch);
  mockMethod(prisma.product, "findMany", async () => catalog);
  mockMethod(prisma.productImportRow, "findMany", async () => rows);
  const update = async ({ where, data }: any) => {
    const row = rows.find(row => row.id === where.id)!;
    Object.assign(row, data);
    return { ...row };
  };
  mockMethod(prisma.productImportRow, "update", update);
  mockMethod(prisma, "$transaction", async (callback: any) => typeof callback === "function" ? callback({
    $queryRaw: async () => [],
    productImportBatch: { findUnique: async () => batch, update: async ({ data }: any) => Object.assign(batch, data) },
    productImportRow: { update, findMany: async () => rows }, auditLog: { create: async () => ({}) },
  }) : Promise.all(callback));
  return { rows, batch, mockMethod };
}
test("saving one page compares other pending pages and chunks too", async t => {
  const { rows } = installBatchMocks(t, [source(), source({ sku: "AUTO-2", ratePerPiece: 110 })]);
  const result = await saveReviewedProductImportRows("batch", [{ ...rows[1].parsed, rowId: rows[1].id }], "actor");
  assert.equal(result.savedCount, 1);
  assert.equal(result.rows[0].id, rows[1].id);
  assert.equal(rows[1].comparisonStatus, "IDENTIFIER_CONFLICT");
  assert.equal(rows[1].resolution, null);
  assert.deepEqual(importReviewChanges(rows[1].parsed, rows[1].extracted), []);
});
test("terminal extraction analysis detects cross-page repetitions", async t => {
  const { rows } = installBatchMocks(t, [source(), source({ sku: "AUTO-2" })]);
  await refreshExtractedImportComparisons("batch");
  assert.equal(rows[1].comparisonStatus, "IN_FILE_DUPLICATE");
  assert.equal(rows[1].resolution, "IGNORE");
});
test("warning acknowledgement is explicit and never suppresses an identifier conflict", async t => {
  const original = source({ warnings: ["Check source price."], barcode: "BAR-B" });
  const { rows } = installBatchMocks(t, [original], [
    { ...source(), id: "A", brand: { name: "Example" } },
    { ...source({ name: "Other", barcode: "BAR-B" }), id: "B", brand: { name: "Example" } },
  ]);
  await saveReviewedProductImportRows("batch", [{ ...original, rowId: "row-1", acknowledgeWarnings: true }], "actor");
  assert.equal(rows[0].comparisonStatus, "IDENTIFIER_CONFLICT");
  assert.equal(rows[0].resolution, null);
  assert.ok(importReviewIssues(rows[0]).some(issue => issue.field === "barcode"));
});
test("mapping after a saved brand confirmation preserves source prices and does not mark edits", async t => {
  const original = source({ brand: "", ratePerPiece: null, availabilityStatus: "COMING_SOON", extractedPrices: [{ key: "mrp", label: "MRP", value: 132 }] });
  const { rows } = installBatchMocks(t, [original]);
  await saveReviewedProductImportRows("batch", [{ ...original, rowId: "row-1", brand: "Example" }], "actor");
  await setProductImportPriceMapping({ batchId: "batch", actorId: "actor", mapping: { mrp: "retailPrice" } });
  assert.equal(rows[0].parsed.retailPrice, 132);
  assert.equal(rows[0].parsed.availabilityStatus, "CATALOG_LISTED");
  assert.deepEqual(importReviewChanges(rows[0].parsed, rows[0].extracted), []);
});

test("a stale full-batch save cannot overwrite a concurrent review edit", async t => {
  const { rows, mockMethod } = installBatchMocks(t, [source()]);
  mockMethod(prisma.product, "findMany", async () => {
    rows[0].parsed.name = "Concurrent correction";
    return [];
  });
  await assert.rejects(saveReviewedProductImportRows("batch", [{ ...source(), rowId: "row-1", ratePerPiece: 120 }], "actor"), /changed in another operation/);
  assert.equal(rows[0].parsed.name, "Concurrent correction");
  assert.equal(rows[0].parsed.ratePerPiece, 100);
});
test("unchanged rows in the rest of the batch are compared without unnecessary writes", async t => {
  const { rows, mockMethod } = installBatchMocks(t, [source(), source({ name: "Other", sku: "AUTO-2" })]);
  await saveReviewedProductImportRows("batch", [{ ...rows[0].parsed, rowId: "row-1" }], "actor");
  const original = prisma.$transaction;
  const writes: string[] = [];
  mockMethod(prisma, "$transaction", async (callback: any) => (original as any)(async (tx: any) => {
    const update = tx.productImportRow.update;
    tx.productImportRow.update = async (input: any) => { writes.push(input.where.id); return update(input); };
    return callback(tx);
  }));
  await saveReviewedProductImportRows("batch", [{ ...rows[0].parsed, rowId: "row-1", ratePerPiece: 120 }], "actor");
  assert.deepEqual(writes, ["row-1"]);
});
test("legacy warnings are visible and unresolved in the review response before commit", async t => {
  const { rows, mockMethod } = installBatchMocks(t, [source({ warnings: ["Check source price."] })]);
  delete rows[0].parsed.warnings;
  rows[0].resolution = "CREATE_NEW" as any;
  mockMethod(prisma.productImportRow, "count", async () => rows.length);
  mockMethod(prisma.productImportRow, "groupBy", async () => []);
  const result = await getProductImportReview({ batchId: "batch" });
  assert.deepEqual(result.rows[0].pendingWarnings, ["Check source price."]);
  assert.equal(result.reviewCounts.attention, 1);
  assert.equal(result.decisionCounts.unresolved, 1);
  assert.equal(result.decisionCounts.create, 0);
});
test("a plain save cannot silently approve an extraction warning", async t => {
  const { rows } = installBatchMocks(t, [source({ warnings: ["Check source price."] })]);
  await saveReviewedProductImportRows("batch", [{ ...rows[0].parsed, rowId: "row-1", resolution: "CREATE_NEW" }], "actor");
  assert.equal(rows[0].resolution, null);
  assert.equal(rows[0].error, "Check source price.");
  await saveReviewedProductImportRows("batch", [{ ...rows[0].parsed, rowId: "row-1", acknowledgeWarnings: true }], "actor");
  assert.equal(rows[0].resolution, "CREATE_NEW");
  assert.equal(rows[0].error, null);
});
test("changing price mapping for a subset is rejected instead of changing other rows silently", async t => {
  installBatchMocks(t, [source({ extractedPrices: [{ key: "mrp", value: 100, label: "MRP" }] })]);
  await assert.rejects(setProductImportPriceMapping({ batchId: "batch", actorId: "actor", mapping: { mrp: "retailPrice" }, rowIds: ["row-1"] }), /whole file/);
});
test("price mapping does not hide unrelated manual price corrections", async t => {
  const { rows } = installBatchMocks(t, [source({ extractedPrices: [{ key: "mrp", label: "MRP", value: 200 }] })]);
  await saveReviewedProductImportRows("batch", [{ ...rows[0].parsed, rowId: "row-1", ratePerPiece: 110 }], "actor");
  await setProductImportPriceMapping({ batchId: "batch", actorId: "actor", mapping: { mrp: "retailPrice" } });
  assert.equal(rows[0].parsed.ratePerPiece, 110);
  assert.deepEqual(importReviewChanges(rows[0].parsed, rows[0].extracted), ["Rate"]);
});
test("catalog differences and uncertainty highlight the specific retail field", () => {
  const issues = importReviewIssues({ parsed: source(), comparisonStatus: "MATCHED_WITH_CHANGES", resolution: null,
    changeSet: [{ field: "retailPrice", currentValue: 100, incomingValue: 120 }] });
  assert.equal(issues[0].field, "retailPrice");
  assert.match(issues[0].message, /100.*120/);
  assert.equal(importReviewIssues({ parsed: source({ warnings: ["Check unreadable fields: retailPrice."], uncertainFields: ["retailPrice"] }) })[0].field, "retailPrice");
});
