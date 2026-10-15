import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import { getCustomerInvoiceEvents } from "../modules/customers/service";
import { projectReceivableInvoice } from "../modules/customers/receivables";

test("history filters cart scope before pagination, searches historical identity and projects captured returns", async () => {
  const originalFind = prisma.customer.findUnique;
  const originalTransaction = prisma.$transaction;
  const queries: any[] = [];
  const date = new Date("2026-10-13T08:00:00Z");
  const items = Array.from({ length: 5 }, (_, n) => ({ id: `line-${n}`, productId: `p${n + 1}`, qty: 2,
    appliedUnitPrice: 20, lineTotal: 40, snapshotCapturedAt: date, productNameSnapshot: `Captured ${n}`,
    productSkuSnapshot: `OLD-${n}`, product: { id: `p${n + 1}`, name: "Changed live name", sku: "NEW", imageUrl: null } }));
  const invoice: any = { id: "i", customerId: "c", invoiceNo: "INV-I", status: "FINALIZED", netTotal: 200,
    paidTotal: 123, finalizedAt: date, createdAt: date, cancelledAt: null, paymentStatus: "PARTIALLY_PAID", items,
    returnAdjustment: 0, correctionCredit: 0, correctionCreditReleased: 0, creditPayouts: [],
    correctionAsSource: null, correctionAsTarget: null, returnRequests: [], creditNotesAsOriginal: [],
    creditNoteAsReplacement: null, creditApplicationsFrom: [], creditApplicationsTo: [],
    payments: [{ kind: "CHARGE", status: "SUCCESS", amount: 150, method: "CASH" }] };
  const returned: any = { id: "r", invoiceId: "i", reviewedAt: new Date("2026-10-14T08:00:00Z"), createdAt: date,
    refundAmount: 0, note: "Credit retained", settlement: { version: 2, originalCustomerId: "c", originalPayable: 200,
      approvedReturnValue: 30, debtReduction: 30, retainedCredit: 0, approvalOrder: 1, recordedReceipts: 150, applications: [] },
    invoice, refundPayments: [], items: [{ productId: "p5", qtyReturned: 1, unitPrice: 30, invoiceItem: items[4] }] };
  prisma.customer.findUnique = async () => ({ id: "c" });
  prisma.$transaction = async (work: any) => work({
    invoice: { findMany: async (query: any) => { queries.push(query); return [invoice]; } },
    returnRequest: { findMany: async (query: any) => { queries.push(query); return [returned]; } },
  });
  try {
    const result = await getCustomerInvoiceEvents({ customerId: "c", productIds: ["p5"], q: "Captured", from: "2026-10-13", to: "2026-10-14", page: 1, pageSize: 1 });
    assert.equal(result.total, 2);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].eventType, "RETURN");
    assert.equal(result.events[0].totalAmount, -30, "return uses captured adjustment, not original sale total");
    assert.equal(result.summary.uniqueProducts, 1, "full scope counts the cart product beyond preview position four");
    const saleQuery = queries.find(q => q.where?.customerId === "c");
    assert.deepEqual(saleQuery.where.items.some.productId.in, ["p5"]);
    assert.ok(JSON.stringify(saleQuery.where.AND).includes("productNameSnapshot"));
    assert.equal(saleQuery.where.OR[0].finalizedAt.gte.toISOString(), "2026-10-12T18:15:00.000Z");
    const purchase = await getCustomerInvoiceEvents({ customerId: "c", type: "PURCHASE", pageSize: 15 });
    assert.equal(purchase.events[0].eventType, "PURCHASE");
    assert.equal(purchase.events[0].itemPreviews.length, 5, "details do not silently stop at four items");
    assert.equal(purchase.events[0].itemPreviews[0].name, "Captured 0");
    assert.equal(purchase.events[0].dueAmount, projectReceivableInvoice(invoice).due);
    assert.notEqual(purchase.events[0].dueAmount, invoice.netTotal - invoice.paidTotal);
    returned.settlement = null;
    const legacy = await getCustomerInvoiceEvents({ customerId: "c", type: "RETURN" });
    assert.equal(legacy.events[0].totalAmount, null, "unknown return basis is not invented from refund or current price");
  } finally { prisma.customer.findUnique = originalFind; prisma.$transaction = originalTransaction; }
});
