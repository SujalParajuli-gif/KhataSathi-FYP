import test from "node:test";
import assert from "node:assert/strict";
import {
  assertProductCatalogIdentityAvailable,
  productCatalogIdentityHash,
  ProductCatalogIdentityConflictError,
} from "../modules/products/catalogIdentity";

test("catalog identity hashes normalize equivalent product names within one brand", () => {
  assert.equal(
    productCatalogIdentityHash("brand-1", "Bucket  10-LTR"),
    productCatalogIdentityHash("brand-1", " bucket 10 ltr "),
  );
  assert.notEqual(
    productCatalogIdentityHash("brand-1", "Bucket 10 LTR"),
    productCatalogIdentityHash("brand-2", "Bucket 10 LTR"),
  );
});

test("catalog identity guard reports the existing same-brand product", async () => {
  const client = {
    product: {
      findMany: async () => [{
        id: "product-1",
        name: "Bucket 10-LTR",
        brand: { name: "Bagmati" },
      }],
    },
  };
  await assert.rejects(
    () => assertProductCatalogIdentityAvailable(client as never, {
      brandId: "brand-1",
      productName: " bucket 10 ltr ",
    }),
    (error: unknown) => error instanceof ProductCatalogIdentityConflictError
      && error.existingProductId === "product-1",
  );
});
