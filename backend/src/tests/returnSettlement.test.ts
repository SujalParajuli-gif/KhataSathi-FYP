import test from "node:test";
import assert from "node:assert/strict";
import { allocateReturn, parseReturnSettlement } from "../modules/returns/settlement";
import { projectReceivableInvoice, summarizeReceivableCustomer } from "../modules/customers/receivables";
import { getRemainingPaymentDue } from "../lib/money";

test("original-value allocation reduces debt first and holds only excess credit", () => {
  const input = { netTotal: 1000, subTotal: 1000, approvedGross: 0, nextGross: 300, previousAdjustment: 0, paid: 400 };
  assert.deepEqual(allocateReturn(input), { adjustment: 300, approvedReturnValue: 300, debtReduction: 300, retainedCredit: 0 });
  assert.equal(getRemainingPaymentDue(1000, 400, 300), 300);
  assert.deepEqual(allocateReturn({ ...input, nextGross: 800 }), { adjustment: 800, approvedReturnValue: 800, debtReduction: 600, retainedCredit: 200 });
  assert.equal(getRemainingPaymentDue(1000, 0, 300), 700);
  assert.equal(allocateReturn({ ...input, paid: 0 }).retainedCredit, 0);
  assert.deepEqual(allocateReturn({ ...input, netTotal: 0, subTotal: 0, nextGross: 0, paid: 0 }), { adjustment: 0, approvedReturnValue: 0, debtReduction: 0, retainedCredit: 0 });
});
test("cumulative rounding consumes exact original target and rejects corrupt allocation", () => {
  let previousAdjustment = 0, approvedGross = 0, total = 0;
  for (let n = 0; n < 3; n++) {
    const a = allocateReturn({ netTotal: 10.49, subTotal: 12, nextGross: 4, approvedGross, previousAdjustment, paid: 0 });
    total += a.approvedReturnValue; previousAdjustment = a.adjustment; approvedGross += 4;
  }
  assert.equal(total, 10);
  assert.throws(() => allocateReturn({ netTotal: 10, subTotal: 12, nextGross: 13, approvedGross: 0, previousAdjustment: 0, paid: 0 }), /basis/);
  assert.throws(() => allocateReturn({ netTotal: 10, subTotal: 12, nextGross: 1, approvedGross: 0, previousAdjustment: 5, paid: 0 }), /changed/);
  assert.equal(parseReturnSettlement({ version: 2 }), null);
});
test("customer dues and original-owner credit stay separate; legacy or ownership drift withholds authority", () => {
  const invoice = { id: "sale", invoiceNo: "SALE", status: "FINALIZED", netTotal: 1000, customerId: "customer", paidTotal: 400, returnAdjustment: 800,
    payments: [{ kind: "CHARGE", status: "SUCCESS", amount: 400 }], returnRequests: [{ status: "APPROVED", settlement: { version: 2, originalCustomerId: "customer", originalPayable: 1000, approvedReturnValue: 800, debtReduction: 600, retainedCredit: 200, approvalOrder: 1 } }] };
  assert.equal(projectReceivableInvoice(invoice).retainedCredit, 200);
  const owing = { ...invoice, id: "owing", paidTotal: 0, returnAdjustment: 0, payments: [], returnRequests: [] };
  const known = summarizeReceivableCustomer({ id: "customer", name: "Customer", isActive: false, invoices: [invoice, owing] });
  assert.equal(known.due, 1000); assert.equal(known.retainedCredit, 200); assert.equal(known.isActive, false);
  const legacy = { ...invoice, returnRequests: [{ status: "REVERSED", settlement: null }] };
  assert.equal(projectReceivableInvoice(legacy).due, null);
  const unknown = summarizeReceivableCustomer({ id: "customer", invoices: [owing, legacy] });
  assert.equal(unknown.due, null); assert.equal(unknown.supportedDue, 1000);
  assert.equal(projectReceivableInvoice({ ...invoice, customerId: "other" }).retainedCredit, null);
  assert.equal(projectReceivableInvoice({ ...owing, payments: [{ kind: "CHARGE", status: "PENDING", method: "ESEWA", amount: 1000 }] }).due, null);
});
