import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import {
  detailInvoiceItemSelect,
  getInvoice,
  listInvoices,
  publicInvoiceItemSelect,
  resolveDisplayCustomer,
  resolveDisplayProduct,
  resolveInvoiceDisplayIdentity,
} from "../modules/invoices/service";

test("resolveDisplayCustomer and resolveDisplayProduct: unit edge cases", () => {
  // 1. Captured finalized customer with snapshots
  const capturedCust = resolveDisplayCustomer({
    status: "FINALIZED",
    customerSnapshotCapturedAt: new Date("2026-09-30T10:00:00Z"),
    customerNameSnapshot: "Historical Customer Ltd",
    customerPanSnapshot: "001234567",
    customerAddressSnapshot: "Patan, Lalitpur",
    customer: { name: "Current Edited Name" },
  });
  assert.deepEqual(capturedCust, {
    name: "Historical Customer Ltd",
    panNo: "001234567", // preserves leading zero
    address: "Patan, Lalitpur",
    source: "CAPTURED",
  });

  // 2. Captured walk-in / null snapshots stay null, never fallback to live
  const capturedWalkIn = resolveDisplayCustomer({
    status: "FINALIZED",
    customerId: null,
    customerSnapshotCapturedAt: new Date("2026-09-30T10:00:00Z"),
    customerNameSnapshot: null,
    customerPanSnapshot: null,
    customerAddressSnapshot: null,
    customer: { name: "Should Never Use This" },
  });
  assert.deepEqual(capturedWalkIn, {
    name: null,
    panNo: null,
    address: null,
    source: "CAPTURED",
  });

  // 3. Captured whitespace/malformed snapshot string normalizes to null, never fallback
  const capturedWhitespace = resolveDisplayCustomer({
    status: "FINALIZED",
    customerSnapshotCapturedAt: new Date("2026-09-30T10:00:00Z"),
    customerNameSnapshot: "   ",
    customerPanSnapshot: "",
    customerAddressSnapshot: null,
    customer: { name: "Live Fallback Avoided" },
  });
  assert.deepEqual(capturedWhitespace, {
    name: null,
    panNo: null,
    address: null,
    source: "CAPTURED",
  });

  // 4. Legacy finalized customer with live name: fallback used, PAN/address stay null
  const legacyCustWithLive = resolveDisplayCustomer({
    status: "FINALIZED",
    customerSnapshotCapturedAt: null,
    customer: { name: "Live Customer Corp" },
  });
  assert.deepEqual(legacyCustWithLive, {
    name: "Live Customer Corp",
    panNo: null,
    address: null,
    source: "LEGACY_LIVE_FALLBACK",
  });

  // 5. Legacy finalized customer without live relation: LEGACY_UNAVAILABLE
  const legacyCustNoLive = resolveDisplayCustomer({
    status: "FINALIZED",
    customerId: "cust-deleted",
    customerSnapshotCapturedAt: null,
    customer: null,
  });
  assert.deepEqual(legacyCustNoLive, {
    name: null,
    panNo: null,
    address: null,
    source: "LEGACY_UNAVAILABLE",
  });

  // 6. Draft customer: source DRAFT_CURRENT, panNo and address always null on public read
  const draftCust = resolveDisplayCustomer({
    status: "DRAFT",
    customerSnapshotCapturedAt: null,
    customer: { name: "Draft Customer" },
  });
  assert.deepEqual(draftCust, {
    name: "Draft Customer",
    panNo: null,
    address: null,
    source: "DRAFT_CURRENT",
  });

  // 7. Draft customer without relation: source DRAFT_CURRENT with null name
  const draftWalkIn = resolveDisplayCustomer({
    status: "DRAFT",
    customerSnapshotCapturedAt: null,
    customer: null,
  });
  assert.deepEqual(draftWalkIn, {
    name: null,
    panNo: null,
    address: null,
    source: "DRAFT_CURRENT",
  });

  // 8. Captured finalized item: snapshot name & SKU used, live edits ignored
  const capturedItem = resolveDisplayProduct(
    {
      snapshotCapturedAt: new Date("2026-09-30T10:00:00Z"),
      productNameSnapshot: "Aalo 1kg",
      productSkuSnapshot: "00VEG-01",
      product: { name: "Potato Premium 1kg", sku: "VEG-99" },
    },
    "FINALIZED",
  );
  assert.deepEqual(capturedItem, {
    name: "Aalo 1kg",
    sku: "00VEG-01",
    source: "CAPTURED",
  });

  // 9. Captured item with null/whitespace snapshot does NOT fallback to live
  const capturedItemBlank = resolveDisplayProduct(
    {
      snapshotCapturedAt: new Date("2026-09-30T10:00:00Z"),
      productNameSnapshot: "   ",
      productSkuSnapshot: null,
      product: { name: "Live Fallback Forbidden", sku: "LIVE-SKU" },
    },
    "FINALIZED",
  );
  assert.deepEqual(capturedItemBlank, {
    name: null,
    sku: null,
    source: "CAPTURED",
  });

  // 10. Legacy finalized item with live product
  const legacyItemWithLive = resolveDisplayProduct(
    {
      snapshotCapturedAt: null,
      product: { name: "Wai Wai Noodles", sku: "NOODLE-01" },
    },
    "FINALIZED",
  );
  assert.deepEqual(legacyItemWithLive, {
    name: "Wai Wai Noodles",
    sku: "NOODLE-01",
    source: "LEGACY_LIVE_FALLBACK",
  });

  // 11. Legacy finalized item without live product relation: LEGACY_UNAVAILABLE
  const legacyItemNoLive = resolveDisplayProduct(
    {
      snapshotCapturedAt: null,
      product: null,
    },
    "FINALIZED",
  );
  assert.deepEqual(legacyItemNoLive, {
    name: null,
    sku: null,
    source: "LEGACY_UNAVAILABLE",
  });

  // 12. Draft item uses live product with DRAFT_CURRENT
  const draftItem = resolveDisplayProduct(
    {
      snapshotCapturedAt: null,
      product: { name: "Current Item", sku: "CURR-1" },
    },
    "DRAFT",
  );
  assert.deepEqual(draftItem, {
    name: "Current Item",
    sku: "CURR-1",
    source: "DRAFT_CURRENT",
  });

  // 13. Draft item without relation
  const draftItemNoRel = resolveDisplayProduct(
    {
      snapshotCapturedAt: null,
      product: null,
    },
    "DRAFT",
  );
  assert.deepEqual(draftItemNoRel, {
    name: null,
    sku: null,
    source: "DRAFT_CURRENT",
  });
});

test("resolveInvoiceDisplayIdentity handles independent customer and line-item markers", () => {
  // Scenario: Captured customer, but mixed line items (line 1 captured, line 2 legacy)
  const invoice = {
    id: "inv-mixed-1",
    status: "FINALIZED",
    customerSnapshotCapturedAt: new Date("2026-09-30T10:00:00Z"),
    customerNameSnapshot: "Captured Customer",
    customerPanSnapshot: "987654321",
    customerAddressSnapshot: "Thamel, Kathmandu",
    customer: { id: "c1", name: "Current Customer Edited" },
    items: [
      {
        id: "item-1",
        productId: "p1",
        snapshotCapturedAt: new Date("2026-09-30T10:00:00Z"),
        productNameSnapshot: "Historical Tea 500g",
        productSkuSnapshot: "TEA-500",
        product: { id: "p1", name: "Current Tea Blend", sku: "TEA-MODERN" },
      },
      {
        id: "item-2",
        productId: "p2",
        snapshotCapturedAt: null,
        productNameSnapshot: null,
        productSkuSnapshot: null,
        product: { id: "p2", name: "Current Sugar 1kg", sku: "SUG-001" },
      },
    ],
  };

  const resolved = resolveInvoiceDisplayIdentity(invoice);

  // Customer is captured
  assert.equal(resolved.displayCustomer.name, "Captured Customer");
  assert.equal(resolved.displayCustomer.panNo, "987654321");
  assert.equal(resolved.displayCustomer.address, "Thamel, Kathmandu");
  assert.equal(resolved.displayCustomer.source, "CAPTURED");

  // Line 1 is captured
  assert.equal(resolved.items[0].displayProduct.name, "Historical Tea 500g");
  assert.equal(resolved.items[0].displayProduct.sku, "TEA-500");
  assert.equal(resolved.items[0].displayProduct.source, "CAPTURED");

  // Line 2 is legacy fallback
  assert.equal(resolved.items[1].displayProduct.name, "Current Sugar 1kg");
  assert.equal(resolved.items[1].displayProduct.sku, "SUG-001");
  assert.equal(resolved.items[1].displayProduct.source, "LEGACY_LIVE_FALLBACK");

  // Original relations and IDs remain intact
  assert.equal(resolved.customer.name, "Current Customer Edited");
  assert.equal(resolved.items[0].product.name, "Current Tea Blend");
  assert.equal(resolved.items[1].product.name, "Current Sugar 1kg");
});

test("getInvoice: verifies detail query select excludes costAtSale and maps display identity", async () => {
  let capturedArgs: any = null;
  const originalFindUnique = prisma.invoice.findUnique;

  try {
    (prisma.invoice as any).findUnique = async (args: any) => {
      capturedArgs = args;
      return {
        id: "inv-detail-1",
        invoiceNo: "INV-20261002-0001",
        status: "FINALIZED",
        customerId: "cust-1",
        customerNameSnapshot: "Frozen Store Pvt Ltd",
        customerPanSnapshot: "102938475",
        customerAddressSnapshot: "Jawalakhel",
        customerSnapshotCapturedAt: new Date("2026-10-01T12:00:00Z"),
        customer: {
          id: "cust-1",
          name: "Live Store Name Changed",
          phone: "9841000000",
          email: "store@example.com",
          loyaltyPercent: 0,
          wholesalePercent: 0,
        },
        items: [
          {
            id: "line-1",
            invoiceId: "inv-detail-1",
            productId: "prod-1",
            qty: 5,
            appliedUnitPrice: 200,
            originalUnitPrice: 200,
            overrideUnitPrice: null,
            overrideReason: null,
            overrideById: null,
            overrideAt: null,
            lineTotal: 1000,
            productNameSnapshot: "Himalayan Pink Salt 1kg",
            productSkuSnapshot: "SALT-PINK-01",
            snapshotCapturedAt: new Date("2026-10-01T12:00:00Z"),
            createdAt: new Date("2026-10-01T12:00:00Z"),
            product: {
              id: "prod-1",
              name: "New Salt Label",
              sku: "SALT-NEW",
              barcode: "1234567890",
            },
          },
        ],
        payments: [],
        creditNotesAsOriginal: [],
        creditNoteAsReplacement: null,
        returnRequests: [],
      };
    };

    const invoice = await getInvoice("inv-detail-1");
    assert.ok(invoice);

    // Verify detail select used in findUnique
    assert.deepEqual(capturedArgs?.include?.items?.select, detailInvoiceItemSelect);
    assert.equal("costAtSale" in capturedArgs.include.items.select, false);

    // Verify costAtSale is NOT in response item
    assert.equal("costAtSale" in invoice.items[0], false);

    // Verify displayCustomer uses captured snapshot, not live customer name
    assert.deepEqual(invoice.displayCustomer, {
      name: "Frozen Store Pvt Ltd",
      panNo: "102938475",
      address: "Jawalakhel",
      source: "CAPTURED",
    });

    // Verify displayProduct uses captured item snapshot, not live product
    assert.deepEqual(invoice.items[0].displayProduct, {
      name: "Himalayan Pink Salt 1kg",
      sku: "SALT-PINK-01",
      source: "CAPTURED",
    });

    // Verify original relations and IDs remain accessible
    assert.equal(invoice.customer.name, "Live Store Name Changed");
    assert.equal(invoice.items[0].product.name, "New Salt Label");
    assert.equal(invoice.customerId, "cust-1");
    assert.equal(invoice.items[0].productId, "prod-1");
  } finally {
    prisma.invoice.findUnique = originalFindUnique;
  }
});

test("listInvoices: item select includes snapshot fields, excludes costAtSale, and maps display identity with full pagination/summary parity", async () => {
  let capturedFindManyArgs: any = null;
  const originalFindMany = prisma.invoice.findMany;
  const originalCount = prisma.invoice.count;
  const originalGroupBy = prisma.invoice.groupBy;
  const originalAggregate = prisma.invoice.aggregate;

  try {
    (prisma.invoice as any).findMany = async (args: any) => {
      capturedFindManyArgs = args;
      return [
        {
          id: "inv-list-1",
          invoiceNo: "INV-20261002-0002",
          status: "FINALIZED",
          customerId: "cust-legacy-1",
          customerNameSnapshot: null,
          customerPanSnapshot: null,
          customerAddressSnapshot: null,
          customerSnapshotCapturedAt: null,
          customer: {
            id: "cust-legacy-1",
            name: "Legacy Hardware",
            phone: "9800000000",
            loyaltyPercent: 0,
            wholesalePercent: 0,
          },
          items: [
            {
              id: "line-list-1",
              qty: 1,
              appliedUnitPrice: 500,
              lineTotal: 500,
              productNameSnapshot: null,
              productSkuSnapshot: null,
              snapshotCapturedAt: null,
              product: {
                id: "prod-leg-1",
                name: "Steel Hammer",
                sku: "HAM-01",
                barcode: null,
              },
            },
          ],
          payments: [],
          _count: { items: 1, payments: 0 },
        },
      ];
    };

    (prisma.invoice as any).count = async () => 1;
    (prisma.invoice as any).groupBy = async () => [{ paymentStatus: "PAID", _count: { _all: 1 } }];
    (prisma.invoice as any).aggregate = async () => ({ _sum: { netTotal: 500, paidTotal: 500 }, _count: { _all: 1 } });

    const result = await listInvoices({ page: 1, pageSize: 20 });
    assert.ok(result);
    assert.equal(result.total, 1);
    assert.equal(result.invoices.length, 1);
    assert.equal(result.summary.totalSales, 500);
    assert.equal(result.summary.paid, 1);

    // Verify item select excludes costAtSale and includes item snapshot fields
    const itemSelect = capturedFindManyArgs?.include?.items?.select;
    assert.equal(itemSelect.id, true);
    assert.equal(itemSelect.productNameSnapshot, true);
    assert.equal(itemSelect.productSkuSnapshot, true);
    assert.equal(itemSelect.snapshotCapturedAt, true);
    assert.equal("costAtSale" in itemSelect, false);

    // Verify mapped invoice
    const inv = result.invoices[0];
    assert.equal("costAtSale" in inv.items[0], false);
    assert.deepEqual(inv.displayCustomer, {
      name: "Legacy Hardware",
      panNo: null,
      address: null,
      source: "LEGACY_LIVE_FALLBACK",
    });
    assert.deepEqual(inv.items[0].displayProduct, {
      name: "Steel Hammer",
      sku: "HAM-01",
      source: "LEGACY_LIVE_FALLBACK",
    });

    // Verify stable relations preserved
    assert.equal(inv.customer.id, "cust-legacy-1");
    assert.equal(inv.items[0].product.id, "prod-leg-1");
  } finally {
    prisma.invoice.findMany = originalFindMany;
    prisma.invoice.count = originalCount;
    prisma.invoice.groupBy = originalGroupBy;
    prisma.invoice.aggregate = originalAggregate;
  }
});
