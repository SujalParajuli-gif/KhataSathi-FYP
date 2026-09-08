import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareReviewedImportRowDraft,
  reviewedImportRowToCsvRow,
  normalizeCsvImportRow,
  ReviewedImportRowValidationError,
} from "../modules/products/service";

function validRow(overrides: Record<string, unknown> = {}) {
  return {
    rowId: "row-1",
    name: "  Bucket   15 Ltr  ",
    sku: " BAGMATI-15 ",
    brand: "Bagmati Plastic",
    category: "Plastic",
    ratePerPiece: 100,
    packageQuantity: 1,
    packageUnit: "PIECE",
    saleUnit: "PIECE",
    quantityStep: 1,
    retailPrice: 130,
    wholesalePrice: 118,
    availabilityStatus: "CATALOG_LISTED" as const,
    stock: 0,
    ...overrides,
  };
}

test("review draft normalization produces a durable import payload", () => {
  const prepared = prepareReviewedImportRowDraft(validRow());
  assert.equal(prepared.name, "Bucket 15 Ltr");
  assert.equal(prepared.sku, "BAGMATI-15");
  assert.equal(prepared.ratePerPiece, 100);
  assert.equal(prepared.retailPrice, 130);
  assert.equal(prepared.packageUnit, "PIECE");
});

test("review draft save rejects missing identity fields", () => {
  assert.throws(
    () => prepareReviewedImportRowDraft(validRow({ name: "" })),
    ReviewedImportRowValidationError,
  );
  assert.throws(
    () => prepareReviewedImportRowDraft(validRow({ sku: "" })),
    ReviewedImportRowValidationError,
  );
});

test("review draft save rejects invalid prices, packages, and stock", () => {
  assert.throws(
    () => prepareReviewedImportRowDraft(validRow({ ratePerPiece: 0 })),
    /Rate/,
  );
  assert.throws(
    () => prepareReviewedImportRowDraft(validRow({ packageQuantity: 0 })),
    /Package quantity/,
  );
  assert.throws(
    () => prepareReviewedImportRowDraft(validRow({ stock: -1 })),
    /Stock/,
  );
});

test("review draft keeps an explicit Coming soon Rate empty without copying a selling price", () => {
  const prepared = prepareReviewedImportRowDraft(
    validRow({ ratePerPiece: null, availabilityStatus: "COMING_SOON" }),
  );
  assert.equal(prepared.ratePerPiece, null);
  assert.equal(prepared.retailPrice, 130);
  assert.equal(prepared.wholesalePrice, 118);
});

test("final import conversion preserves the reviewed Coming soon status", () => {
  const converted = reviewedImportRowToCsvRow(
    validRow({ ratePerPiece: null, availabilityStatus: "COMING_SOON" }),
  );
  assert.equal(converted.ratePerPiece, null);
  assert.equal(converted.availabilityStatus, "COMING_SOON");
  const normalized = normalizeCsvImportRow(converted, 2);
  assert.equal(normalized.availabilityStatus, "COMING_SOON");
});

test("review draft keeps unknown selling prices null instead of inventing them", () => {
  const prepared = prepareReviewedImportRowDraft(
    validRow({ retailPrice: null, wholesalePrice: "" }),
  );
  assert.equal(prepared.ratePerPiece, 100);
  assert.equal(prepared.retailPrice, null);
  assert.equal(prepared.wholesalePrice, null);
});

test("review draft keeps an unknown package quantity null", () => {
  const prepared = prepareReviewedImportRowDraft(
    validRow({ packageQuantity: null }),
  );
  assert.equal(prepared.packageQuantity, null);
});

test("optional review fields receive safe import defaults", () => {
  const prepared = prepareReviewedImportRowDraft(
    validRow({ brand: "", category: "", sizeUnit: "", packageUnit: "" }),
  );
  assert.equal(prepared.brand, "Unbranded");
  assert.equal(prepared.category, "Uncategorized");
  assert.equal(prepared.sizeUnit, "STANDARD");
  assert.equal(prepared.packageUnit, "PIECE");
});
