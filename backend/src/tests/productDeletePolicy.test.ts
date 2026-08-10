import test from "node:test";
import assert from "node:assert/strict";
import { evaluateProductDeletePolicy } from "../modules/products/deletePolicy";

test("allows direct permanent deletion only when stock and references are empty", () => {
  assert.deepEqual(
    evaluateProductDeletePolicy({ referenceCount: 0, stock: 0, reservedStock: 0 }),
    { canPermanentDelete: true, canDiscardStockAndDelete: false },
  );
});

test("allows stock discard deletion for an unreferenced mistake product", () => {
  assert.deepEqual(
    evaluateProductDeletePolicy({ referenceCount: 0, stock: 30, reservedStock: 0 }),
    { canPermanentDelete: false, canDiscardStockAndDelete: true },
  );
});

test("blocks stock discard deletion when quantity is reserved", () => {
  assert.equal(
    evaluateProductDeletePolicy({ referenceCount: 0, stock: 30, reservedStock: 2 }).canDiscardStockAndDelete,
    false,
  );
});

test("blocks all permanent deletion paths when business history exists", () => {
  assert.deepEqual(
    evaluateProductDeletePolicy({ referenceCount: 1, stock: 30, reservedStock: 0 }),
    { canPermanentDelete: false, canDiscardStockAndDelete: false },
  );
});
