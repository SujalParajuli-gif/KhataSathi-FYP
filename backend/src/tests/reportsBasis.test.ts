import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import { exportAnalyticsCsv, getAnalyticsReport, INVOICE_SALES_BASIS, salesSummary } from "../modules/reports/service";

test("invoice report basis matches rounding, discounts, lifetime charge/cache recognition and excluded cancellations", async () => {
  const findInvoices = prisma.invoice.findMany;
  const findUsers = prisma.user.findMany;
  const query = prisma.$queryRaw;
  let selections = 0;
  const invoice = {
    id: "discounted", status: "FINALIZED", paymentStatus: "PARTIALLY_PAID",
    finalizedAt: new Date("2026-10-12T04:00:00Z"), subTotal: 1000,
    loyaltyDiscountAmount: 100, netTotal: 900.4, paidTotal: 350,
    customer: { id: "customer", name: "Customer", phone: null },
    cashier: { id: "cashier", name: "Cashier" },
    items: [{ productId: "product", qty: 10, lineTotal: 1000, product: { id: "product", name: "Product", sku: "sku", brand: { id: "brand", name: "Brand" } } }],
    payments: [
      { id: "old-charge", method: "CASH", amount: 300, kind: "CHARGE", status: "SUCCESS", createdAt: new Date("2026-09-01") },
      { id: "refund", method: "CASH", amount: 200, kind: "REFUND", status: "SUCCESS" },
      { id: "pending", method: "CASH", amount: 600, kind: "CHARGE", status: "PENDING" },
    ],
  };
  try {
    prisma.user.findMany = (async () => []) as any;
    prisma.invoice.findMany = (async (args: any) => {
      selections++;
      assert.equal(args.where.status, "FINALIZED");
      assert.equal(args.where.cashierId, "cashier");
      assert.equal(args.where.finalizedAt.gte.toISOString(), "2026-10-11T18:15:00.000Z");
      assert.equal(args.where.finalizedAt.lte.toISOString(), "2026-10-12T18:14:59.999Z");
      assert.equal(args.include.payments.select.kind, true);
      return [invoice, { ...invoice, id: "cancelled-original", paymentStatus: "CANCELLED", netTotal: 5000 },
        { ...invoice, id: "replacement", netTotal: 200, subTotal: 200, loyaltyDiscountAmount: 0, paidTotal: 999, payments: [], items: [{ ...invoice.items[0], lineTotal: 200 }] }];
    }) as any;
    const filters = { from: "2026-10-12", to: "2026-10-12", cashierId: "cashier" };
    const report = await getAnalyticsReport(filters, { viewerRole: "MANAGER" });
    assert.equal(selections, 1);
    assert.deepEqual(report.meta.salesBasis, INVOICE_SALES_BASIS);
    assert.equal(report.summary.netSales, 1100);
    assert.equal(report.summary.grossSales, 1200);
    assert.equal(report.summary.discountTotal, 100);
    assert.equal(report.summary.collectedTotal, 550); // greater cache350 + capped replacement200
    assert.equal(report.summary.dueTotal, 550);
    assert.equal(report.summary.invoiceCount, 2);
    assert.equal(report.summary.cancelledInvoiceCount, 1);
    assert.equal(report.paymentDistribution.find(p => p.method === "CASH")?.amount, 300);
    assert.equal(report.topProducts[0].revenue, 1100);
    assert.equal(report.topProducts[0].qty, 20); // recorded quantities, not return-adjusted
    const csv = await exportAnalyticsCsv(filters);
    assert.ok(csv.includes('"Invoice sales (after discounts, before returns)",1100'));
    assert.ok(csv.includes("Recorded collections,550"));
    assert.ok(csv.includes("Invoice-basis due,550"));
    for (const description of Object.values(INVOICE_SALES_BASIS)) {
      assert.ok(csv.includes(description.replace(/"/g, '""')));
    }
    assert.ok(!csv.includes("\nNet sales,") && !csv.includes(",Revenue,"));
    prisma.$queryRaw = (async (sql: any) => {
      assert.match(sql.strings.join("?"), /paymentStatus <> 'CANCELLED'/);
      assert.match(sql.strings.join("?"), /ROUND\(i.netTotal, 0\)/);
      assert.match(sql.strings.join("?"), /p.kind <> 'REFUND'/);
      return [{ invoiceCount: 2n, totalSales: 1100, totalDiscount: 100, totalCollected: 550 }];
    }) as any;
    const summary = await salesSummary(filters.from, filters.to);
    assert.equal(summary.totalRevenue, 1100); // compatibility alias preserved
    assert.equal(summary.totalPaid, 550);
    assert.deepEqual(summary.salesBasis, report.meta.salesBasis);
    prisma.invoice.findMany = (async () => { throw new Error("source unavailable"); }) as any;
    await assert.rejects(getAnalyticsReport(filters), /source unavailable/);
    await assert.rejects(exportAnalyticsCsv(filters), /source unavailable/);
  } finally {
    prisma.invoice.findMany = findInvoices;
    prisma.user.findMany = findUsers;
    prisma.$queryRaw = query;
  }
});
