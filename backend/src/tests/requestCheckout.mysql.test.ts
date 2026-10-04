import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import {
  checkoutInvoice,
  buildCheckoutPayloadHash,
  CheckoutReviewConflictError,
} from "../modules/invoices/service";
import { completeDraftRequest } from "../modules/draft-requests/service";
import { getCustomerProductPurchaseHistory } from "../modules/customers/service";
import { invalidateBusinessSettingsCache } from "../modules/settings/service";

// Opt-in only: the normal suite must never connect to a configured development DB.
const enabled = process.env.KHATASATHI_DISPOSABLE_MYSQL_TEST === "1";
test("MySQL: request checkout race, replay, rollback and historical query invariants", { skip: !enabled }, async () => {
  const target = new URL(process.env.DATABASE_URL || "");
  assert.ok(["127.0.0.1", "localhost"].includes(target.hostname));
  assert.match(target.pathname, /^\/ks_verify_[a-z0-9_]+$/);
  try {
    await prisma.businessSettings.upsert({ where: { id: 1 }, create: { id: 1, loyaltyDiscountPercent: 0 }, update: { loyaltyDiscountPercent: 0 } });
    invalidateBusinessSettingsCache();
    const cashier = await prisma.user.create({ data: { name: "Test cashier", phone: "+9779800000001", passwordHash: "test-unusable-hash", role: "CASHIER" } });
    const other = await prisma.user.create({ data: { name: "Other test cashier", phone: "+9779800000002", passwordHash: "test-unusable-hash", role: "CASHIER" } });
    const customer = await prisma.customer.create({ data: { name: "Test customer", panNo: "00123" } });
    const brand = await prisma.brand.create({ data: { name: "Test brand" } });
    const product = await prisma.product.create({ data: { name: "Sale name", sku: "TEST-SKU", brandId: brand.id, retailPrice: 25, wholesalePrice: 25, stock: 100, wholesaleEligible: false } });
    const request = await prisma.billingDraftRequest.create({ data: { requestNo: "TEST-REQUEST", status: "ACCEPTED", createdById: cashier.id, customerId: customer.id } });
    const payload = {
      draftRequestId: request.id,
      customerId: customer.id,
      items: [{ productId: product.id, qty: 1 }],
      payments: [{ method: "CASH" as const, amount: 25, tenderedAmount: 25 }],
      confirmation: {
        items: [{ productId: product.id, qty: 1, appliedUnitPrice: 25 }],
        payableTotal: 25,
      },
    };
    const attempts = [
      { actor: cashier.id, operationKey: "mysql-request-operation-001" },
      { actor: other.id, operationKey: "mysql-request-operation-002" },
    ];
    const raced = await Promise.allSettled(attempts.map(({ actor, operationKey }) => checkoutInvoice(actor, { ...payload, operationKey })));
    assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(raced.filter((result) => result.status === "rejected").length, 1);
    const winnerIndex = raced.findIndex((result) => result.status === "fulfilled");
    const winner = raced[winnerIndex] as PromiseFulfilledResult<any>;
    const invoiceId = winner.value.invoice.id;
    assert.equal(await prisma.invoice.count(), 1);
    assert.equal(await prisma.invoiceItem.count(), 1);
    assert.equal(await prisma.payment.count(), 1);
    assert.equal(await prisma.stockTransaction.count({ where: { type: "SALE" } }), 1);
    assert.equal(await prisma.checkoutOperation.count(), 1);
    assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 99);
    const linked = await prisma.billingDraftRequest.findUnique({ where: { id: request.id } });
    assert.equal(linked.status, "COMPLETED");
    assert.equal(linked.completedInvoiceId, invoiceId);
    assert.equal(await prisma.auditLog.count({ where: { action: "DRAFT_REQUEST_COMPLETED" } }), 1);
    const before = { invoices: await prisma.invoice.count(), payments: await prisma.payment.count(), stocks: await prisma.stockTransaction.count(), audits: await prisma.auditLog.count(), operations: await prisma.checkoutOperation.count() };
    const replay = await checkoutInvoice(attempts[winnerIndex].actor, { ...payload, operationKey: attempts[winnerIndex].operationKey });
    assert.equal(replay.invoice?.id, invoiceId);
    await assert.rejects(checkoutInvoice(attempts[winnerIndex].actor, { ...payload, draftRequestId: "another-request", operationKey: attempts[winnerIndex].operationKey }), /different bill contents/);
    await assert.rejects(completeDraftRequest("unrelated-request", { id: cashier.id, role: "CASHIER" }, invoiceId), /not found/);
    const rollbackRequest = await prisma.billingDraftRequest.create({ data: { requestNo: "TEST-ROLLBACK", status: "PARTIALLY_ACCEPTED", createdById: cashier.id, assignedCashierId: cashier.id } });
    // Failure after stock/finalization writes: overpayment must roll back all effects.
    await assert.rejects(checkoutInvoice(cashier.id, { ...payload, draftRequestId: rollbackRequest.id, operationKey: "mysql-rollback-operation-001", payments: [{ method: "CASH", amount: 100 }] }), /Overpayment/);
    const after = { invoices: await prisma.invoice.count(), payments: await prisma.payment.count(), stocks: await prisma.stockTransaction.count(), audits: await prisma.auditLog.count(), operations: await prisma.checkoutOperation.count() };
    assert.deepEqual(after, before);
    assert.equal((await prisma.billingDraftRequest.findUnique({ where: { id: rollbackRequest.id } })).completedInvoiceId, null);
    assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 99);
    await assert.rejects(completeDraftRequest(rollbackRequest.id, { id: cashier.id, role: "CASHIER" }, invoiceId), /linked checkout invoice/);

    // Fresh checkout without confirmation must be rejected with zero DB effects
    await assert.rejects(
      checkoutInvoice(cashier.id, {
        operationKey: "mysql-missing-conf-op-001",
        items: [{ productId: product.id, qty: 1 }],
        payments: [{ method: "CASH", amount: 25 }],
      }),
      (err: any) =>
        err instanceof CheckoutReviewConflictError &&
        err.code === "CHECKOUT_REVIEW_REQUIRED" &&
        err.reason === "MISSING_CONFIRMATION",
    );
    assert.deepEqual(
      { invoices: await prisma.invoice.count(), payments: await prisma.payment.count(), stocks: await prisma.stockTransaction.count(), audits: await prisma.auditLog.count(), operations: await prisma.checkoutOperation.count() },
      before,
    );

    // Fresh checkout with price mismatch confirmation must be rejected with zero DB effects
    await assert.rejects(
      checkoutInvoice(cashier.id, {
        operationKey: "mysql-mismatched-price-op-001",
        items: [{ productId: product.id, qty: 1 }],
        payments: [{ method: "CASH", amount: 20 }],
        confirmation: {
          items: [{ productId: product.id, qty: 1, appliedUnitPrice: 20 }],
          payableTotal: 20,
        },
      }),
      (err: any) =>
        err instanceof CheckoutReviewConflictError &&
        err.code === "CHECKOUT_REVIEW_REQUIRED" &&
        err.reason === "PRICE_OR_TOTAL_CHANGED",
    );
    assert.deepEqual(
      { invoices: await prisma.invoice.count(), payments: await prisma.payment.count(), stocks: await prisma.stockTransaction.count(), audits: await prisma.auditLog.count(), operations: await prisma.checkoutOperation.count() },
      before,
    );

    // Fresh checkout with payable total mismatch confirmation must be rejected with zero DB effects
    await assert.rejects(
      checkoutInvoice(cashier.id, {
        operationKey: "mysql-mismatched-payable-op-001",
        items: [{ productId: product.id, qty: 1 }],
        payments: [{ method: "CASH", amount: 25 }],
        confirmation: {
          items: [{ productId: product.id, qty: 1, appliedUnitPrice: 25 }],
          payableTotal: 20,
        },
      }),
      (err: any) =>
        err instanceof CheckoutReviewConflictError &&
        err.code === "CHECKOUT_REVIEW_REQUIRED" &&
        err.reason === "PRICE_OR_TOTAL_CHANGED",
    );
    assert.deepEqual(
      { invoices: await prisma.invoice.count(), payments: await prisma.payment.count(), stocks: await prisma.stockTransaction.count(), audits: await prisma.auditLog.count(), operations: await prisma.checkoutOperation.count() },
      before,
    );
    await prisma.product.update({ where: { id: product.id }, data: { name: "Changed current name", sku: "CHANGED-SKU" } });
    const history = await getCustomerProductPurchaseHistory(customer.id, [product.id]);
    assert.equal(history[0].displayProduct.name, "Sale name");
    assert.equal(history[0].displayProduct.source, "CAPTURED");
    assert.equal(history[0].appliedUnitPrice, 25);
    assert.equal(history[0].qty, 1);
    await prisma.invoiceItem.updateMany({ where: { invoiceId }, data: { productNameSnapshot: null, productSkuSnapshot: null } });
    assert.equal((await getCustomerProductPurchaseHistory(customer.id, [product.id]))[0].displayProduct.name, null);
    await prisma.invoice.update({ where: { id: invoiceId }, data: { cancelledAt: new Date() } });
    assert.deepEqual(await getCustomerProductPurchaseHistory(customer.id, [product.id]), []);
    // Replay of ordinary operations created by either previous hash encoding stays safe.
    const ordinary = {
      operationKey: "mysql-ordinary-operation-001",
      items: [{ productId: product.id, qty: 1 }],
      payments: [],
      confirmation: {
        items: [{ productId: product.id, qty: 1, appliedUnitPrice: 25 }],
        payableTotal: 25,
      },
    };
    const posted = await checkoutInvoice(cashier.id, ordinary);
    const nullHash = buildCheckoutPayloadHash(
      ordinary,
      ordinary.items,
      [],
      true,
      ordinary.confirmation,
    );
    await prisma.checkoutOperation.update({ where: { operationKey: ordinary.operationKey }, data: { payloadHash: nullHash } });
    const ordinaryReplay = await checkoutInvoice(cashier.id, ordinary);
    assert.equal(ordinaryReplay.invoice?.id, posted.invoice?.id);
    assert.equal(await prisma.invoice.count(), 2);
    const historyCustomer = await prisma.customer.create({ data: { name: "History filter fixture" } });
    async function historical(no: string, extra: Record<string, unknown> = {}) {
      return prisma.invoice.create({ data: {
        invoiceNo: no, cashierId: cashier.id, customerId: historyCustomer.id,
        status: "FINALIZED", finalizedAt: new Date("2026-10-01T00:00:00Z"),
        ...extra,
        items: { create: { productId: product.id, qty: 3, appliedUnitPrice: 17, lineTotal: 51 } },
      } });
    }
    await historical("HISTORY-DRAFT", { status: "DRAFT" });
    await historical("HISTORY-CANCELLED", { cancelledAt: new Date() });
    await historical("HISTORY-DELETED", { deletedAt: new Date() });
    await historical("HISTORY-CANCELLED-PAYMENT", { paymentStatus: "CANCELLED" });
    const original = await historical("HISTORY-ORIGINAL");
    const replacement = await historical("HISTORY-REPLACEMENT");
    await prisma.creditNote.create({ data: {
      creditNoteNo: "HISTORY-CREDIT", originalInvoiceId: original.id,
      replacementInvoiceId: replacement.id, originalNetTotal: 51,
      originalPaidTotal: 0, replacementNetTotal: 51, creditedAmount: 0, createdById: cashier.id,
    } });
    const qualifying = await getCustomerProductPurchaseHistory(historyCustomer.id, [product.id]);
    assert.deepEqual(qualifying.map((row) => row.invoiceId), [replacement.id]);
    assert.equal(qualifying[0].appliedUnitPrice, 17);
    assert.equal(qualifying[0].qty, 3);
    assert.equal(qualifying[0].displayProduct.source, "LEGACY_LIVE_FALLBACK");
    for (let index = 0; index < 6; index++) await historical(`HISTORY-BOUND-${index}`, { finalizedAt: new Date(Date.UTC(2026, 9, 2, index)) });
    const bounded = await getCustomerProductPurchaseHistory(historyCustomer.id, [product.id]);
    assert.equal(bounded.length, 5);
    assert.deepEqual(bounded.map((row) => row.invoiceNo), [5, 4, 3, 2, 1].map((index) => `HISTORY-BOUND-${index}`));
  } finally {
    invalidateBusinessSettingsCache();
    await prisma.$disconnect();
  }
});
