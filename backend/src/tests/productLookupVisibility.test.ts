import test from "node:test";
import assert from "node:assert/strict";
import {
  redactInventoryFromProduct,
  redactProductForLookup,
  resolveProductLookupVisibility,
} from "../modules/products/lookupVisibility";

test("catalog redaction removes inventory facts while preserving catalog identity and sale unit", () => {
  const product = redactInventoryFromProduct({
    id: "product-1",
    name: "Bucket",
    imageUrl: "/uploads/products/bucket.webp",
    thumbnailUrl: "/uploads/products/bucket-thumb.webp",
    saleUnit: "PIECE",
    stock: 30,
    availableStock: 28,
    pendingDraftQty: 2,
    lowStockThreshold: 5,
    usesDefaultLowStockThreshold: true,
  });

  assert.equal(product.saleUnit, "PIECE");
  assert.equal(product.imageUrl, "/uploads/products/bucket.webp");
  assert.equal(product.thumbnailUrl, "/uploads/products/bucket-thumb.webp");
  assert.equal("stock" in product, false);
  assert.equal("availableStock" in product, false);
  assert.equal("pendingDraftQty" in product, false);
  assert.equal("lowStockThreshold" in product, false);
});

test("admin always receives purchase cost and wholesale prices", () => {
  assert.deepEqual(resolveProductLookupVisibility("ADMIN", false), {
    canViewPurchaseCost: true,
    canViewWholesalePrice: true,
  });
});

test("VIEW WHOLESALE controls wholesale visibility for every non-admin role", () => {
  for (const role of ["MANAGER", "CASHIER", "STAFF"]) {
    assert.equal(
      resolveProductLookupVisibility(role, false).canViewWholesalePrice,
      false,
    );
    assert.equal(
      resolveProductLookupVisibility(role, true).canViewWholesalePrice,
      true,
    );
    assert.equal(
      resolveProductLookupVisibility(role, true).canViewPurchaseCost,
      false,
    );
  }
});

test("lookup redaction removes protected prices instead of merely hiding them", () => {
  const product = {
    id: "product-1",
    retailPrice: 150,
    wholesalePrice: 125,
    ratePerPiece: 100,
    wholesaleEligible: true,
    wholesaleQtyThreshold: 12,
    usesDefaultWholesaleQtyThreshold: false,
  };

  const retailOnly = redactProductForLookup(product, {
    canViewPurchaseCost: false,
    canViewWholesalePrice: false,
  });
  assert.equal(retailOnly.retailPrice, 150);
  assert.equal("ratePerPiece" in retailOnly, false);
  assert.equal("wholesalePrice" in retailOnly, false);
  assert.equal("wholesaleQtyThreshold" in retailOnly, false);

  const wholesaleViewer = redactProductForLookup(product, {
    canViewPurchaseCost: false,
    canViewWholesalePrice: true,
  });
  assert.equal(wholesaleViewer.wholesalePrice, 125);
  assert.equal("ratePerPiece" in wholesaleViewer, false);
});
