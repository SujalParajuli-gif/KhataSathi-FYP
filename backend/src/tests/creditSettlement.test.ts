import test from "node:test";
import assert from "node:assert/strict";
import { projectReceivableInvoice } from "../modules/customers/receivables";
import { createEsewaPaymentIntentTx } from "../modules/payments/service";
import { getRemainingPaymentDue } from "../lib/money";

test("credit source reconciliation propagates uncertainty to the receiving sale", () => {
  const returned = { id: "return", invoiceId: "source", status: "APPROVED", settlement: { version: 2, originalCustomerId: "customer", originalPayable: 1000, approvedReturnValue: 800, debtReduction: 600, retainedCredit: 200, approvalOrder: 1 } };
  const application = { id: "allocation", sourceReturnId: "return", sourceInvoiceId: "source", targetInvoiceId: "target", originalCustomerId: "customer", amount: 150, sourceReturn: returned };
  const source = { id: "source", invoiceNo: "SOURCE", customerId: "customer", status: "FINALIZED", netTotal: 1000, paidTotal: 400, returnAdjustment: 800,
    payments: [{ amount: 400, kind: "CHARGE", status: "SUCCESS" }], returnRequests: [returned], creditApplicationsFrom: [{ ...application, targetInvoice: { id: "target", customerId: "customer" } }] };
  const target = { id: "target", invoiceNo: "TARGET", customerId: "customer", status: "FINALIZED", netTotal: 300, paidTotal: 0, creditApplied: 150,
    payments: [], returnRequests: [], creditApplicationsTo: [{ ...application, sourceInvoice: source }] };
  assert.equal(projectReceivableInvoice(source).retainedCredit, 50);
  assert.equal(projectReceivableInvoice(target).due, 150);
  assert.equal(projectReceivableInvoice({ ...target, creditApplicationsTo: [{ ...application, sourceInvoice: { ...source, paidTotal: 300 } }] }).due, null);
  assert.equal(projectReceivableInvoice({ ...source, creditApplicationsFrom: [{ ...application, amount: 201, targetInvoice: { customerId: "customer" } }] }).retainedCredit, null);
  assert.equal(projectReceivableInvoice({ ...target, creditApplied: 151 }).due, null);
});

test("incoming credit limits gateway intent before any pending receipt is written", async () => {
  let writes = 0;
  const tx = { payment: { create: async () => { writes++; throw Error("Unexpected pending payment write"); } } };
  await assert.rejects(createEsewaPaymentIntentTx(tx, { id: "target", invoiceNo: "TARGET", status: "FINALIZED", paymentStatus: "PARTIALLY_PAID", netTotal: 300,
    returnAdjustment: 0, creditApplied: 200, payments: [] }, 101, "actor"), /remaining due/);
  assert.equal(writes, 0);
  assert.equal(getRemainingPaymentDue(300, 0.1, 0, 0.2), 299.7);
});


test("captured correction source applications preserve gross provenance and withhold malformed ownership", () => {
  const receipt = { id: "receipt", method: "CASH", amount: 400, kind: "CHARGE", status: "SUCCESS" };
  const correction = { id: "correction", sourceInvoiceId: "source", targetInvoiceId: null, action: "CANCEL", originalCustomerId: "customer", originalPayable: 1000,
    receipts: [{ id: receipt.id, method: receipt.method, amount: receipt.amount }], recordedReceipts: 400, transferredCredit: 0, retainedCredit: 400 };
  const app = { id: "app", sourceInvoiceId: "source", targetInvoiceId: "target", sourceReturnId: null, sourceCorrectionId: correction.id, sourceCorrection: correction, originalCustomerId: "customer", amount: 150, targetInvoice: { id: "target", customerId: "customer" } };
  const source = { id: "source", customerId: "customer", status: "FINALIZED", paymentStatus: "CANCELLED", cancelledAt: new Date(), deletedAt: new Date(), netTotal: 1000, paidTotal: 400,
    payments: [receipt], correctionAsSource: correction, creditApplicationsFrom: [app] };
  const target = { id: "target", customerId: "customer", status: "FINALIZED", netTotal: 300, paidTotal: 0, creditApplied: 150, payments: [], creditApplicationsTo: [{ ...app, sourceInvoice: source }] };
  assert.equal(projectReceivableInvoice(source).retainedCredit, 250); assert.equal(projectReceivableInvoice(source).usedCredit, 150);
  assert.equal(projectReceivableInvoice(source).creditSources[0].correctionId, correction.id);
  assert.equal(projectReceivableInvoice(target).due, 150); assert.equal(projectReceivableInvoice(target).recordedReceipts, 0);
  assert.equal(projectReceivableInvoice({ ...source, creditApplicationsFrom: [{ ...app, amount: 401 }] }).retainedCredit, null);
  assert.equal(projectReceivableInvoice({ ...source, creditApplicationsFrom: [{ ...app, sourceReturnId: "also-return" }] }).retainedCredit, null);
  assert.equal(projectReceivableInvoice({ ...source, creditApplicationsFrom: [{ ...app, targetInvoice: { id: "target", customerId: "other" } }] }).retainedCredit, null);
  assert.equal(projectReceivableInvoice({ ...target, creditApplicationsTo: [{ ...app, sourceInvoice: { ...source, paidTotal: 399 } }] }).due, null);
  const reversed = { ...app, reversedAt: new Date() }; assert.equal(projectReceivableInvoice({ ...source, creditApplicationsFrom: [reversed] }).retainedCredit, 400);
});
