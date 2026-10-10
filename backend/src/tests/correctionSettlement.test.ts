import test from "node:test";
import assert from "node:assert/strict";
import { allocateCorrectionCredit, captureCorrectionBasis, correctionRecordReason } from "../modules/invoices/correctionSettlement";
import { getRemainingPaymentDue } from "../lib/money";
import { projectReceivableInvoice } from "../modules/customers/receivables";

test("replacement credit conserves receipts, uses whole-NPR payable and never changes owner", () => {
  assert.deepEqual(allocateCorrectionCredit(1000, 600, "owner", "owner"), { transferredCredit: 600, retainedCredit: 400 });
  assert.deepEqual(allocateCorrectionCredit(400.55, 700.49, "owner", "owner"), { transferredCredit: 400.55, retainedCredit: 0 });
  assert.equal(getRemainingPaymentDue(700.49, 0, 0, 0, 400.55), 299.45);
  assert.deepEqual(allocateCorrectionCredit(400, 700, "owner", "other"), { transferredCredit: 0, retainedCredit: 400 });
  assert.deepEqual(allocateCorrectionCredit(400, 700, null, null), { transferredCredit: 0, retainedCredit: 400 });
});

test("captured cancellation reconciles original receipts and rejects malformed or legacy balances", () => {
  const original = { id: "source", customerId: "owner", status: "FINALIZED", paymentStatus: "PARTIALLY_PAID", netTotal: 1000, paidTotal: 400,
    payments: [{ id: "receipt", method: "CASH", amount: 400, kind: "CHARGE", status: "SUCCESS" }], creditNotesAsOriginal: [] };
  const basis = captureCorrectionBasis(original);
  const source = { ...original, paymentStatus: "CANCELLED", cancelledAt: new Date() };
  const record = { ...basis, sourceInvoiceId: source.id, targetInvoiceId: null, action: "CANCEL", transferredCredit: 0, retainedCredit: 400 };
  assert.equal(correctionRecordReason(record, source), null);
  const projected = projectReceivableInvoice({ ...source, correctionAsSource: record });
  assert.equal(projected.due, 0); assert.equal(projected.retainedCredit, 400); assert.equal(projected.recordedReceipts, 400);
  assert.equal(projectReceivableInvoice(source).basis, "UNRESOLVED");
  assert.equal(projectReceivableInvoice({ ...source, correctionAsSource: { ...record, retainedCredit: 401 } }).retainedCredit, null);
  assert.ok(correctionRecordReason(record, { ...source, customerId: "other" }));
  assert.throws(() => captureCorrectionBasis({ ...original, correctionCredit: 1 }), /receipt basis/);
  assert.throws(() => captureCorrectionBasis({ ...original, paidTotal: 401 }), /receipt basis/);
  assert.throws(() => captureCorrectionBasis({ ...original, payments: [...original.payments, { kind: "CHARGE", method: "ESEWA", status: "PENDING" }] }), /receipt basis/);
});
