import assert from "node:assert/strict";
import test from "node:test";
import { normalizePurchaseHistoryProduct } from "../app/lib/invoices.ts";

const row = { productId: "product", productName: "Old API label", productSku: "OLD-SKU" };
test("history preview consumes resolved identity and preserves authoritative nulls", () => {
  const captured = normalizePurchaseHistoryProduct({ ...row, displayProduct: { name: "Sale label", sku: "001", source: "CAPTURED" } });
  assert.equal(captured.name, "Sale label");
  assert.equal(captured.sku, "001");
  assert.equal(captured.productId, "product");
  const unknown = normalizePurchaseHistoryProduct({ ...row, displayProduct: { name: null, sku: null, source: "CAPTURED" } });
  assert.equal(unknown.name, "Unknown item");
  assert.equal(unknown.sku, undefined);
  assert.equal(unknown.identitySource, "CAPTURED");
});

test("history preview explicitly labels old responses and fails closed for malformed resolved data", () => {
  const old = normalizePurchaseHistoryProduct(row);
  assert.equal(old.name, row.productName);
  assert.equal(old.identitySource, "COMPATIBILITY_UNVERIFIED");
  for (const displayProduct of [null, undefined, {}, { source: "INVALID", name: "Untrusted" }]) {
    const invalid = normalizePurchaseHistoryProduct({ ...row, displayProduct });
    assert.equal(invalid.name, "Unknown item");
    assert.equal(invalid.identitySource, "UNRESOLVED");
  }
});
