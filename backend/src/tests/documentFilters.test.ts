import assert from "node:assert/strict";
import test from "node:test";
import {
  createDocumentSchema,
  listDocumentsSchema,
  updateDocumentMetadataSchema,
} from "../modules/documents/validation";

test("document list accepts one bounded mobile search query", () => {
  const parsed = listDocumentsSchema.parse({ q: "  Household MRP  " });
  assert.equal(parsed.q, "Household MRP");
  assert.equal(parsed.page, 1);
  assert.equal(parsed.pageSize, 20);
});

test("document list rejects an oversized search query", () => {
  assert.equal(
    listDocumentsSchema.safeParse({ q: "x".repeat(256) }).success,
    false,
  );
});

test("document upload accepts one searchable title per multipart file", () => {
  const parsed = createDocumentSchema.parse({
    documentType: "GENERAL",
    titles: JSON.stringify(["Household supplier price list", "Signed delivery note"]),
  });
  assert.deepEqual(parsed.titles, ["Household supplier price list", "Signed delivery note"]);
});

test("document metadata requires a meaningful title when title is changed", () => {
  assert.equal(updateDocumentMetadataSchema.safeParse({ title: "x" }).success, false);
  assert.equal(
    updateDocumentMetadataSchema.parse({ title: "Household MRP - July 2026" }).title,
    "Household MRP - July 2026",
  );
});

test("generic document schemas reject SALE_BILL while accepting all 6 standard types", () => {
  const allowedTypes = [
    "STOCK_BILL",
    "PRODUCT_IMPORT",
    "RETURN_PROOF",
    "PAYMENT_PROOF",
    "DISCOUNT_PROOF",
    "GENERAL",
  ] as const;

  for (const docType of allowedTypes) {
    assert.equal(
      createDocumentSchema.safeParse({ documentType: docType }).success,
      true,
      `createDocumentSchema should accept ${docType}`,
    );
    assert.equal(
      listDocumentsSchema.safeParse({ documentType: docType }).success,
      true,
      `listDocumentsSchema should accept ${docType}`,
    );
    assert.equal(
      updateDocumentMetadataSchema.safeParse({ documentType: docType }).success,
      true,
      `updateDocumentMetadataSchema should accept ${docType}`,
    );
  }

  // SALE_BILL is rejected across all generic schemas
  assert.equal(
    createDocumentSchema.safeParse({ documentType: "SALE_BILL" }).success,
    false,
    "createDocumentSchema must reject SALE_BILL",
  );
  assert.equal(
    listDocumentsSchema.safeParse({ documentType: "SALE_BILL" }).success,
    false,
    "listDocumentsSchema must reject SALE_BILL",
  );
  assert.equal(
    updateDocumentMetadataSchema.safeParse({ documentType: "SALE_BILL" }).success,
    false,
    "updateDocumentMetadataSchema must reject SALE_BILL",
  );
});
