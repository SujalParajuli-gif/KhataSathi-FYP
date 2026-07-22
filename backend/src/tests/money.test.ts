import test from "node:test";
import assert from "node:assert/strict";
import {
  getInvoicePaymentTargetTotal,
  getRemainingPaymentDue,
  roundCurrency,
  roundPayableTotal,
  wouldExceedPaymentTarget,
} from "../lib/money";

test("roundCurrency keeps line-level money at two decimal places", () => {
  assert.equal(roundCurrency(10.005), 10.01);
  assert.equal(roundCurrency(10.004), 10);
});

test("roundPayableTotal uses whole NPR for cashier-facing collection", () => {
  assert.equal(roundPayableTotal(675.6), 676);
  assert.equal(roundPayableTotal(675.4), 675);
});

test("payment target and remaining due match the cashier-facing payable total", () => {
  assert.equal(getInvoicePaymentTargetTotal(675.6), 676);
  assert.equal(getRemainingPaymentDue(675.6, 0), 676);
  assert.equal(getRemainingPaymentDue(675.6, 500), 176);
});

test("payment target check allows exact rounded collection but blocks real overpay", () => {
  assert.equal(
    wouldExceedPaymentTarget({ netTotal: 675.6, paidTotal: 0, nextAmount: 676 }),
    false,
  );
  assert.equal(
    wouldExceedPaymentTarget({ netTotal: 675.6, paidTotal: 0, nextAmount: 677 }),
    true,
  );
});
