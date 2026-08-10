import test from "node:test";
import assert from "node:assert/strict";
import { allocateProductIdentifiers } from "../modules/products/service";

function createIdentifierTransaction(existing: {
  skus?: string[];
  barcodes?: string[];
} = {}) {
  let lastNumber = 0;
  let sequenceCalls = 0;
  const skus = new Set(existing.skus || []);
  const barcodes = new Set(existing.barcodes || []);

  const tx = {
    productSequence: {
      upsert: async () => {
        await Promise.resolve();
        sequenceCalls += 1;
        lastNumber += 1;
        return { lastNumber };
      },
    },
    product: {
      findUnique: async ({ where }: any) => {
        if (where?.sku) return skus.has(where.sku) ? { id: "existing-sku" } : null;
        if (where?.barcode) {
          return barcodes.has(where.barcode) ? { id: "existing-barcode" } : null;
        }
        return null;
      },
    },
  };

  return { tx, getSequenceCalls: () => sequenceCalls };
}

test("concurrent blank identifiers receive unique paired SKU and internal barcode values", async () => {
  const { tx } = createIdentifierTransaction();
  const identifiers = await Promise.all(
    Array.from({ length: 100 }, () => allocateProductIdentifiers(tx)),
  );

  assert.equal(new Set(identifiers.map((item) => item.sku)).size, 100);
  assert.equal(new Set(identifiers.map((item) => item.barcode)).size, 100);
  identifiers.forEach((item) => {
    const skuNumber = item.sku.replace("KS-", "");
    const barcodeNumber = item.barcode.replace("KSB", "").slice(-6);
    assert.equal(barcodeNumber, skuNumber);
    assert.equal(item.barcodeOrigin, "INTERNAL");
  });
});

test("manual identifiers are normalized without consuming the product sequence", async () => {
  const { tx, getSequenceCalls } = createIdentifierTransaction();
  const identifiers = await allocateProductIdentifiers(
    tx,
    "  shop-rice-01  ",
    " 8901234567890 ",
  );

  assert.deepEqual(identifiers, {
    sku: "SHOP-RICE-01",
    barcode: "8901234567890",
    barcodeOrigin: "MANUFACTURER",
  });
  assert.equal(getSequenceCalls(), 0);
});

test("generated identifiers skip an existing sequence-derived SKU", async () => {
  const { tx } = createIdentifierTransaction({ skus: ["KS-000001"] });
  const identifiers = await allocateProductIdentifiers(tx);

  assert.equal(identifiers.sku, "KS-000002");
  assert.equal(identifiers.barcode, "KSB0000000002");
});
