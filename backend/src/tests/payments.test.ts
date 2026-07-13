import test from "node:test";
import assert from "node:assert/strict";
import { getSuccessfulChargePaidTotal } from "../modules/payments/service";

test("getSuccessfulChargePaidTotal ignores refunds and non-success rows", () => {
  const total = getSuccessfulChargePaidTotal([
    { id: "cash-1", amount: 500, status: "SUCCESS", kind: "CHARGE" },
    { id: "pending-1", amount: 200, status: "PENDING", kind: "CHARGE" },
    { id: "refund-1", amount: -150, status: "SUCCESS", kind: "REFUND" },
    { id: "legacy-1", amount: 300, status: "SUCCESS" },
  ]);

  assert.equal(total, 800);
});

test("getSuccessfulChargePaidTotal can exclude a pending eSewa row being verified", () => {
  const total = getSuccessfulChargePaidTotal(
    [
      { id: "cash-1", amount: 500, status: "SUCCESS", kind: "CHARGE" },
      { id: "esewa-1", amount: 250, status: "SUCCESS", kind: "CHARGE" },
    ],
    "esewa-1",
  );

  assert.equal(total, 500);
});
