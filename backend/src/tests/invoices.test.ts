import test from "node:test";
import assert from "node:assert/strict";
import {
  buildActiveReturnBlockMessage,
  shouldAssignFinalInvoiceNo,
} from "../modules/invoices/service";

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
