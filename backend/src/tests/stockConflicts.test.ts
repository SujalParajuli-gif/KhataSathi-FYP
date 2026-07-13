import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStockConflict,
  STOCK_CONFLICT_CODE,
  StockConflictError,
} from "../modules/invoices/stockConflicts";

test("buildStockConflict normalizes stock conflict values", () => {
  const conflict = buildStockConflict({
    productId: "prod-1",
    productName: "Notebook",
    sku: "NB-001",
    requestedQty: 5.9,
    availableStock: -2,
    reason: "INSUFFICIENT_STOCK",
  });

  assert.deepEqual(conflict, {
    productId: "prod-1",
    productName: "Notebook",
    sku: "NB-001",
    barcode: null,
    requestedQty: 5,
    availableStock: 0,
    reason: "INSUFFICIENT_STOCK",
  });
});

test("StockConflictError exposes a stable API error contract", () => {
  const conflicts = [
    buildStockConflict({
      productId: "prod-1",
      productName: "Notebook",
      requestedQty: 3,
      availableStock: 1,
      reason: "INSUFFICIENT_STOCK",
    }),
    buildStockConflict({
      productId: "prod-2",
      productName: "Detergent",
      requestedQty: 2,
      availableStock: 0,
      reason: "OUT_OF_STOCK",
    }),
  ];

  const error = new StockConflictError(conflicts);

  assert.equal(error.name, "StockConflictError");
  assert.equal(error.code, STOCK_CONFLICT_CODE);
  assert.equal(
    error.message,
    'Insufficient stock for "Notebook". Available: 1, Requested: 3',
  );
  assert.deepEqual(error.conflicts, conflicts);
});
