import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReturnReversalStockMessage,
  calculateDiscountAdjustedReturnAmount,
  calculateRefundReversalAmount,
  calculateRefundAmount,
  calculateRemainingReturnQty,
  mapReturnRequestDisplayIdentity,
} from "../modules/returns/service";

test("calculateRemainingReturnQty reserves pending and approved quantities", () => {
  assert.equal(calculateRemainingReturnQty(5, 0), 5);
  assert.equal(calculateRemainingReturnQty(5, 2), 3);
  assert.equal(calculateRemainingReturnQty(5, 5), 0);
  assert.equal(calculateRemainingReturnQty(5, 8), 0);
});

test("calculateRefundAmount caps refunds by remaining paid total", () => {
  assert.equal(calculateRefundAmount(1000, 0, 250), 250);
  assert.equal(calculateRefundAmount(1000, 700, 500), 300);
  assert.equal(calculateRefundAmount(1000, 1000, 500), 0);
  assert.equal(calculateRefundAmount(0, 0, 500), 0);
});

test("calculateDiscountAdjustedReturnAmount allocates invoice discount to partial returns", () => {
  assert.equal(calculateDiscountAdjustedReturnAmount(1000, 900, 500), 450);
  assert.equal(calculateDiscountAdjustedReturnAmount(1000, 1000, 250), 250);
});

test("calculateDiscountAdjustedReturnAmount allocates whole rupee payable rounding", () => {
  assert.equal(calculateDiscountAdjustedReturnAmount(675.6, 676, 675.6), 676);
});

test("calculateRefundReversalAmount reverses the successful refund ledger", () => {
  assert.equal(
    calculateRefundReversalAmount(
      [
        { amount: -250, status: "SUCCESS", kind: "REFUND" },
        { amount: 250, status: "PENDING", kind: "REFUND" },
        { amount: 100, status: "SUCCESS", kind: "CHARGE" },
      ],
      300,
    ),
    250,
  );
  assert.equal(calculateRefundReversalAmount([], 300), 300);
});

test("buildReturnReversalStockMessage explains inventory reversal blocks", () => {
  assert.equal(
    buildReturnReversalStockMessage("Notebook", 1, 3),
    'Cannot reverse return because "Notebook" has only 1 unit(s) in stock; 3 unit(s) must be removed.',
  );
});

test("mapReturnRequestDisplayIdentity resolves captured snapshots, sanitizes raw snapshot fields, and omits costAtSale", () => {
  const rawRequest = {
    id: "ret-1",
    invoiceId: "inv-1",
    status: "PENDING",
    refundAmount: 500,
    items: [
      {
        id: "ret-item-1",
        productId: "prod-1",
        qtyReturned: 2,
        unitPrice: 250,
        lineTotal: 500,
        product: { id: "prod-1", name: "Current Renamed Brand", sku: "SKU-LIVE-99", barcode: "12345" },
        invoiceItem: {
          id: "inv-item-1",
          qty: 5,
          appliedUnitPrice: 250,
          productNameSnapshot: "Historical Brand Item 500g",
          productSkuSnapshot: "00SKU-HIST-01",
          snapshotCapturedAt: new Date("2026-09-30T10:00:00Z"),
          product: { id: "prod-1", name: "Current Renamed Brand", sku: "SKU-LIVE-99" },
        },
      },
    ],
  };

  const mapped = mapReturnRequestDisplayIdentity(rawRequest);

  // 1. Line item has resolved displayProduct matching original snapshot
  assert.deepEqual(mapped.items[0].displayProduct, {
    name: "Historical Brand Item 500g",
    sku: "00SKU-HIST-01",
    source: "CAPTURED",
  });

  // 2. InvoiceItem is sanitized — raw snapshot fields and internal fields are stripped
  assert.deepEqual(mapped.items[0].invoiceItem, {
    id: "inv-item-1",
    qty: 5,
    appliedUnitPrice: 250,
  });

  // 3. Raw snapshot properties and costAtSale are NOT on the return item or invoiceItem
  assert.equal((mapped.items[0] as any).productNameSnapshot, undefined);
  assert.equal((mapped.items[0] as any).productSkuSnapshot, undefined);
  assert.equal((mapped.items[0] as any).snapshotCapturedAt, undefined);
  assert.equal((mapped.items[0] as any).costAtSale, undefined);
  assert.equal((mapped.items[0].invoiceItem as any).productNameSnapshot, undefined);
  assert.equal((mapped.items[0].invoiceItem as any).productSkuSnapshot, undefined);
  assert.equal((mapped.items[0].invoiceItem as any).snapshotCapturedAt, undefined);
  assert.equal((mapped.items[0].invoiceItem as any).costAtSale, undefined);
});

test("mapReturnRequestDisplayIdentity handles captured blank snapshots without live fallback", () => {
  const rawRequest = {
    id: "ret-blank",
    items: [
      {
        id: "ret-item-blank",
        productId: "prod-1",
        qtyReturned: 1,
        unitPrice: 100,
        lineTotal: 100,
        product: { id: "prod-1", name: "Live Fallback Avoided", sku: "LIVE-SKU" },
        invoiceItem: {
          id: "inv-item-blank",
          qty: 2,
          appliedUnitPrice: 100,
          productNameSnapshot: "   ",
          productSkuSnapshot: null,
          snapshotCapturedAt: new Date("2026-09-30T10:00:00Z"),
          product: { id: "prod-1", name: "Live Fallback Avoided", sku: "LIVE-SKU" },
        },
      },
    ],
  };

  const mapped = mapReturnRequestDisplayIdentity(rawRequest);
  assert.deepEqual(mapped.items[0].displayProduct, {
    name: null,
    sku: null,
    source: "CAPTURED",
  });
});

test("mapReturnRequestDisplayIdentity handles legacy invoice items and unavailable products", () => {
  const rawRequest = {
    id: "ret-legacy",
    items: [
      {
        id: "ret-item-legacy-live",
        productId: "prod-legacy",
        qtyReturned: 1,
        unitPrice: 150,
        lineTotal: 150,
        product: { id: "prod-legacy", name: "Legacy Wai Wai", sku: "WAI-01" },
        invoiceItem: {
          id: "inv-item-legacy-live",
          qty: 4,
          appliedUnitPrice: 150,
          productNameSnapshot: null,
          productSkuSnapshot: null,
          snapshotCapturedAt: null,
          product: { id: "prod-legacy", name: "Legacy Wai Wai", sku: "WAI-01" },
        },
      },
      {
        id: "ret-item-legacy-unavailable",
        productId: "prod-deleted",
        qtyReturned: 1,
        unitPrice: 200,
        lineTotal: 200,
        product: null,
        invoiceItem: {
          id: "inv-item-legacy-unavail",
          qty: 1,
          appliedUnitPrice: 200,
          productNameSnapshot: null,
          productSkuSnapshot: null,
          snapshotCapturedAt: null,
          product: null,
        },
      },
      {
        id: "ret-item-missing-invoice-item",
        productId: "prod-standalone",
        qtyReturned: 1,
        unitPrice: 300,
        lineTotal: 300,
        product: { id: "prod-standalone", name: "Standalone Product", sku: "ST-01" },
        invoiceItem: null,
      },
    ],
  };

  const mapped = mapReturnRequestDisplayIdentity(rawRequest);

  // 1. Legacy item with live product -> LEGACY_LIVE_FALLBACK
  assert.deepEqual(mapped.items[0].displayProduct, {
    name: "Legacy Wai Wai",
    sku: "WAI-01",
    source: "LEGACY_LIVE_FALLBACK",
  });

  // 2. Legacy item without live product -> LEGACY_UNAVAILABLE
  assert.deepEqual(mapped.items[1].displayProduct, {
    name: null,
    sku: null,
    source: "LEGACY_UNAVAILABLE",
  });

  // 3. Item without invoiceItem relation -> falls back to item.product with LEGACY_LIVE_FALLBACK
  assert.deepEqual(mapped.items[2].displayProduct, {
    name: "Standalone Product",
    sku: "ST-01",
    source: "LEGACY_LIVE_FALLBACK",
  });
});
