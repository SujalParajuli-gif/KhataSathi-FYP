import test from "node:test";
import assert from "node:assert/strict";
import { normalizeInvoice } from "../app/lib/invoices.ts";

test("invoice balance keeps incoming credit separate and rounds fractional remaining due", () => {
  const invoice = normalizeInvoice({ id: "target", invoiceNo: "TARGET", status: "FINALIZED", paymentStatus: "PARTIALLY_PAID", netTotal: 300, paidTotal: 0.1, returnAdjustment: 0, creditApplied: 0.2, items: [], payments: [] });
  assert.equal(invoice.paidAmount, 0.1); assert.equal(invoice.creditApplied, 0.2); assert.equal(invoice.dueAmount, 299.7); assert.equal(invoice.retainedReturnCredit, 0);
  const original = normalizeInvoice({ id: "source", status: "FINALIZED", netTotal: 1000, paidTotal: 400, returnAdjustment: 800, creditApplied: 0, items: [], payments: [] });
  assert.equal(original.dueAmount, 0); assert.equal(original.retainedReturnCredit, 200);
});

test("replacement settlement reduces due without manufacturing recorded receipts", () => {
  const invoice = normalizeInvoice({ id: "replacement", status: "FINALIZED", paymentStatus: "PARTIALLY_PAID", netTotal: 700.49, paidTotal: 0, returnAdjustment: 0, creditApplied: 0, correctionCredit: 400.55, items: [], payments: [] });
  assert.equal(invoice.correctionCredit, 400.55); assert.equal(invoice.paidAmount, 0); assert.equal(invoice.dueAmount, 299.45);
});
