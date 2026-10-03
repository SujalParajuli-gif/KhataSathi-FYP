import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import { getCustomerProductPurchaseHistory } from "../modules/customers/service";
import { getProductPurchaseHistory } from "../modules/customers/controller";

test("history uses capture markers, preserves nulls, and labels legacy/current identity", async () => {
  const originalCustomer = prisma.customer.findUnique;
  const originalItems = prisma.invoiceItem.findMany;
  try {
    prisma.customer.findUnique = async () => ({ id: "customer" });
    const base = {
      id: "line", productId: "product", qty: 2, appliedUnitPrice: 0,
      invoice: { id: "invoice", invoiceNo: "SALE-1", finalizedAt: new Date(), createdAt: new Date() },
      product: { name: "Current name", sku: "CURRENT-SKU" },
    };
    prisma.invoiceItem.findMany = async () => [
      { ...base, snapshotCapturedAt: new Date(), productNameSnapshot: null, productSkuSnapshot: " " },
      { ...base, id: "legacy", snapshotCapturedAt: null, productNameSnapshot: "Unverified snapshot", productSkuSnapshot: "UNVERIFIED" },
      { ...base, id: "absent", product: null },
    ];
    const rows = await getCustomerProductPurchaseHistory("customer", ["product"]);
    assert.deepEqual(rows.map((row) => row.displayProduct), [
      { name: null, sku: null, source: "CAPTURED" },
      { name: "Current name", sku: "CURRENT-SKU", source: "LEGACY_LIVE_FALLBACK" },
      { name: null, sku: null, source: "LEGACY_UNAVAILABLE" },
    ]);
    assert.equal(rows[0].productName, "Unknown item");
    assert.equal(rows[0].productSku, null);
    assert.equal(rows[0].appliedUnitPrice, 0);
    assert.equal(JSON.stringify(rows).includes("snapshotCapturedAt"), false);
    assert.equal(JSON.stringify(rows).includes("costAtSale"), false);
  } finally {
    prisma.customer.findUnique = originalCustomer;
    prisma.invoiceItem.findMany = originalItems;
  }
});

test("history rejects malformed product query values before database access", async () => {
  const originalCustomer = prisma.customer.findUnique;
  let reads = 0;
  try {
    prisma.customer.findUnique = async () => { reads++; throw new Error("Unexpected DB access"); };
    for (const productIds of [{ id: "product" }, ["product", {}], 123, "a".repeat(192), "two ids"]) {
      const response: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; }, json(body: any) { this.body = body; } };
      await getProductPurchaseHistory({ params: { customerId: "customer" }, query: { productIds } } as any, response);
      assert.equal(response.statusCode, 400);
    }
    assert.equal(reads, 0);
  } finally { prisma.customer.findUnique = originalCustomer; }
});
