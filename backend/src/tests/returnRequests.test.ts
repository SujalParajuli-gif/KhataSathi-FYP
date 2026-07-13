import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReturnReversalStockMessage,
  calculateRefundReversalAmount,
  calculateRefundAmount,
  calculateRemainingReturnQty,
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
