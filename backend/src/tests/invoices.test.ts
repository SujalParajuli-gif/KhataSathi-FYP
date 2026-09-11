import test from "node:test";
import assert from "node:assert/strict";
import {
  buildActiveReturnBlockMessage,
  buildCheckoutPayloadHash,
  shouldAssignFinalInvoiceNo,
} from "../modules/invoices/service";
import { checkoutBodySchema } from "../modules/invoices/validation";

test("buildActiveReturnBlockMessage explains why invoice edits are blocked", () => {
  const message = buildActiveReturnBlockMessage("modify this invoice", "APPROVED");

  assert.equal(
    message,
    "Cannot modify this invoice because this invoice has an approved return/refund request. Finish or reject returns before changing the invoice.",
  );
});

test("buildActiveReturnBlockMessage covers invoice cancellation too", () => {
  const message = buildActiveReturnBlockMessage("cancel this invoice", "PENDING");

  assert.match(message, /Cannot cancel this invoice/);
  assert.match(message, /pending return\/refund request/);
});

test("parked draft numbers are replaced with final invoice numbers at checkout", () => {
  assert.equal(
    shouldAssignFinalInvoiceNo("PARKED-20260626-AB12CD34"),
    true,
  );
});

test("legacy INV draft numbers are preserved to avoid burning a second number", () => {
  assert.equal(shouldAssignFinalInvoiceNo("INV-20260626-0007"), false);
});

test("checkout requires a bounded operation key", () => {
  const base = { items: [{ productId: "product-1", qty: 1 }] };
  assert.equal(checkoutBodySchema.safeParse(base).success, false);
  assert.equal(
    checkoutBodySchema.safeParse({ ...base, operationKey: "short" }).success,
    false,
  );
  assert.equal(
    checkoutBodySchema.safeParse({
      ...base,
      operationKey: "checkout-operation-123",
    }).success,
    true,
  );
});

test("checkout fingerprint detects bill changes without persisting PINs", () => {
  const items = [{ productId: "product-1", qty: 2 }];
  const payments = [
    {
      method: "CASH" as const,
      amount: 100,
      reference: undefined,
      tenderedAmount: undefined,
    },
  ];
  const first = buildCheckoutPayloadHash(
    {
      operationKey: "checkout-operation-123",
      overridePin: "1111",
      items,
      payments,
    },
    items,
    payments,
  );
  const sameBillDifferentPin = buildCheckoutPayloadHash(
    {
      operationKey: "checkout-operation-123",
      overridePin: "9999",
      items,
      payments,
    },
    items,
    payments,
  );
  const changedBill = buildCheckoutPayloadHash(
    {
      operationKey: "checkout-operation-123",
      items: [{ productId: "product-1", qty: 3 }],
      payments,
    },
    [{ productId: "product-1", qty: 3 }],
    payments,
  );

  assert.equal(first, sameBillDifferentPin);
  assert.notEqual(first, changedBill);
  assert.doesNotMatch(first, /1111|9999/);
});
