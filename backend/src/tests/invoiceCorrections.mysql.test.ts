import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
import prisma from "../db/prisma";
import { modifyFinalizedInvoice, cancelInvoice } from "../modules/invoices/service";
import { addPayment, voidPayment, createEsewaPaymentIntentTx } from "../modules/payments/service";
import { listCustomerReceivables } from "../modules/customers/receivables";
import { getCurrentCashDrawer } from "../modules/cash-drawers/service";
import { createReturnRequest, approveReturnRequest } from "../modules/returns/service";
import { applyCustomerCredit, reverseCustomerCredit } from "../modules/customers/creditApplications";
import { listAuditLogs } from "../modules/audit/service";

// Opt-in only: every mutation is restricted to this newly owned disposable target.
test("MySQL corrections preserve cash/ownership and atomically serialize replay, stock and payment decisions", { skip: process.env.KHATASATHI_CORRECTION_MYSQL_TEST !== "1", timeout: 120000 }, async () => {
  const url = new URL(process.env.DATABASE_URL || "");
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname) && (url.port || "3306") === "3306" && url.pathname === "/ks_verify_correction_settlement_20261010");
  const original = prisma.$transaction.bind(prisma), suffix = randomUUID();
  await prisma.businessSettings.upsert({ where: { id: 1 }, create: { id: 1, businessMode: "FULL_POS", loyaltyDiscountPercent: 0 }, update: { businessMode: "FULL_POS", loyaltyDiscountPercent: 0 } });
  const actor = await prisma.user.create({ data: { name: "Owned correction actor", phone: `+97798${randomInt(10000000,99999999)}`, passwordHash: "unusable", role: "ADMIN" } });
  const cashier = await prisma.user.create({ data: { name: "Owned correction cashier", phone: `+97797${randomInt(10000000,99999999)}`, passwordHash: "unusable", role: "CASHIER" } });
  const customer = await prisma.customer.create({ data: { name: `Owned correction ${suffix}`, loyaltyPercent: 0, wholesalePercent: 0 } });
  const other = await prisma.customer.create({ data: { name: `Owned other ${suffix}`, loyaltyPercent: 0, wholesalePercent: 0 } });
  const brand = await prisma.brand.create({ data: { name: `Owned correction ${suffix}` } });
  const product = await prisma.product.create({ data: { name: "Owned correction item", sku: `CORRECT-${suffix}`, brandId: brand.id, stock: 1000, retailPrice: 100, wholesalePrice: 100, wholesaleEligible: false } });
  const invoices: string[] = [];
  const drawer = await prisma.cashDrawer.create({ data: { cashierId: actor.id, openingFloat: 0, status: "OPEN" } });
  async function sale(paid = 400, customerId: string | null = customer.id) {
    const i = await prisma.invoice.create({ data: { invoiceNo: `CORRECT-${randomUUID()}`, cashierId: actor.id, customerId, status: "FINALIZED", finalizedAt: new Date(), netTotal: 1000, subTotal: 1000,
      paidTotal: paid, paymentStatus: paid >= 1000 ? "PAID" : paid > 0 ? "PARTIALLY_PAID" : "UNPAID",
      items: { create: { productId: product.id, qty: 10, appliedUnitPrice: 100, lineTotal: 1000, productNameSnapshot: "Historical correction item", productSkuSnapshot: "HIST-CORRECT", snapshotCapturedAt: new Date() } },
      ...(paid ? { payments: { create: { method: "CASH", amount: paid, kind: "CHARGE", status: "SUCCESS", createdById: actor.id } } } : {}) }, include: { items: true } });
    invoices.push(i.id); return i;
  }
  function input(qty = 7, operationKey = randomUUID(), customerId: string | null = customer.id) { return { customerId, reason: "Owned correction", operationKey, items: [{ productId: product.id, qty }] }; }
  async function replace(i: any, data = input()) { const r = await modifyFinalizedInvoice(i.id, actor.id, data); invoices.push(r.replacementInvoice.id); return r; }
  async function balance(id: string, name = customer.name) { return (await listCustomerReceivables({ q: name }, "ADMIN")).items[0].invoices.find(i => i.invoiceId === id)!; }
  async function race(first: () => Promise<any>, second: () => Promise<any>, firstLocks = 1) {
    let held!: () => void, attempted!: () => void, release!: () => void, transactions = 0, firstCount = 0, attempts = 0;
    const a = new Promise<void>(r => held = r), b = new Promise<void>(r => attempted = r), gate = new Promise<void>(r => release = r);
    prisma.$transaction = ((work: any, opts: any) => original(async (tx: any) => {
      const ordinal = ++transactions;
      return work(new Proxy(tx, { get(target, key) {
        if (key === "$queryRaw") return async (query: TemplateStringsArray, ...values: any[]) => {
          const isLock = /FROM Invoice\s/.test(query.join(" ")) && query.join(" ").includes("FOR UPDATE");
          if (isLock && ordinal === 2) { attempts++; attempted(); }
          const result = await tx.$queryRaw(query, ...values);
          if (isLock && ordinal === 1 && ++firstCount === firstLocks) { held(); await gate; }
          return result;
        };
        return Reflect.get(target, key);
      } }));
    }, { ...opts, timeout: 20000 })) as any;
    const ops: Promise<any>[] = [];
    try { ops.push(first()); await a; ops.push(second()); await b; release(); const result = await Promise.allSettled(ops); assert.ok(attempts > 0); return result; }
    finally { release(); await Promise.allSettled(ops); prisma.$transaction = original; }
  }
  try {
    const full = await sale(1000), payload = input(6), beforeCount = await prisma.payment.count(), beforeCash = await getCurrentCashDrawer(actor.id);
    const first = await replace(full, payload);
    assert.equal(first.replacementInvoice.paidTotal, 0); assert.equal(first.replacementInvoice.correctionCredit, 600); assert.equal(first.replacementInvoice.paymentStatus, "PAID");
    assert.equal(await prisma.payment.count(), beforeCount); assert.equal((await getCurrentCashDrawer(actor.id))!.cashSalesTotal, beforeCash!.cashSalesTotal);
    assert.equal((await balance(full.id)).retainedCredit, 400); assert.equal((await balance(full.id)).due, 0); assert.equal((await balance(first.replacementInvoice.id)).due, 0);
    assert.equal((await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: first.replacementInvoice.id } })).productNameSnapshot, "Historical correction item"); assert.equal("costAtSale" in first.replacementInvoice.items[0], false);
    assert.deepEqual(await modifyFinalizedInvoice(full.id, actor.id, payload), first);
    await assert.rejects(modifyFinalizedInvoice(full.id, actor.id, { ...payload, reason: "Changed" }), /conflict/);
    await assert.rejects(modifyFinalizedInvoice(full.id, cashier.id, payload), /conflict/);
    await assert.rejects(cancelInvoice(full.id, actor.id, payload.operationKey), /conflict/);
    await assert.rejects(cancelInvoice(first.replacementInvoice.id, actor.id, randomUUID()), /receipt basis/);
    await assert.rejects(modifyFinalizedInvoice(first.replacementInvoice.id, actor.id, input()), /receipt basis/);
    assert.equal((await listAuditLogs({ action: "CUSTOMER_CREDIT_CORRECTION" })).total, 0);

    const partial = await sale(400.55), p = await replace(partial);
    assert.equal((await balance(p.replacementInvoice.id)).due, 299.45); assert.equal((await balance(partial.id)).retainedCredit, 0);
    let intentWrites = 0;
    const gatewayTarget = await prisma.invoice.findUniqueOrThrow({ where: { id: p.replacementInvoice.id }, include: { payments: true } });
    await assert.rejects(createEsewaPaymentIntentTx({ payment: { create: async () => { intentWrites++; } } }, gatewayTarget, 299.46, actor.id), /remaining due/);
    assert.equal(intentWrites, 0);
    await assert.rejects(addPayment(p.replacementInvoice.id, "CASH", 299.46, "SUCCESS", actor.id), /Overpayment/);
    const receipt = await addPayment(p.replacementInvoice.id, "CASH", 299.45, "SUCCESS", actor.id);
    assert.equal((await balance(p.replacementInvoice.id)).due, 0); assert.equal((await balance(p.replacementInvoice.id)).recordedReceipts, 299.45);
    await voidPayment(p.replacementInvoice.id, receipt.id, actor.id); assert.equal((await balance(p.replacementInvoice.id)).due, 299.45);
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: p.replacementInvoice.id } })).paymentStatus, "PARTIALLY_PAID");

    const centSource = await sale(699.7), centTarget = await replace(centSource);
    await addPayment(centTarget.replacementInvoice.id, "CASH", 0.1, "SUCCESS", actor.id);
    await addPayment(centTarget.replacementInvoice.id, "CASH", 0.2, "SUCCESS", actor.id);
    assert.equal((await balance(centTarget.replacementInvoice.id)).due, 0);
    assert.equal((await balance(centTarget.replacementInvoice.id)).recordedReceipts, 0.3);
    const integrationOriginal = await sale(), integrationTarget = await replace(integrationOriginal), returnOriginal = await sale();
    const request = await createReturnRequest(actor.id, { invoiceId: returnOriginal.id, reason: "CUSTOMER_REQUEST", operationKey: randomUUID(), items: [{ invoiceItemId: returnOriginal.items[0].id, qty: 8 }] });
    await approveReturnRequest(request.id, actor.id, randomUUID());
    const application = await applyCustomerCredit(actor.id, { sourceReturnId: request.id, targetInvoiceId: integrationTarget.replacementInvoice.id, amount: 150, reason: "Separate approved return credit", operationKey: randomUUID() });
    assert.equal((await balance(integrationTarget.replacementInvoice.id)).due, 150);
    assert.equal((await balance(integrationTarget.replacementInvoice.id)).recordedReceipts, 0);
    assert.equal((await balance(integrationTarget.replacementInvoice.id)).correctionCredit, 400);
    await assert.rejects(cancelInvoice(integrationTarget.replacementInvoice.id, actor.id, randomUUID()), /active credit/);
    await reverseCustomerCredit(actor.id, application.id, { reason: "Restore original available return credit", operationKey: randomUUID() });
    assert.equal((await balance(integrationTarget.replacementInvoice.id)).due, 300);
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: integrationTarget.replacementInvoice.id } })).paymentStatus, "PARTIALLY_PAID");
    const longReasonSource = await sale(0), longReasonInput = { ...input(), reason: "R".repeat(500) };
    const longReasonResult = await replace(longReasonSource, longReasonInput);
    assert.equal(longReasonResult.creditNote.reason.length, 80);
    assert.equal((await prisma.invoiceCorrectionSettlement.findUniqueOrThrow({ where: { sourceInvoiceId: longReasonSource.id } })).reason.length, 500);
    await assert.rejects(modifyFinalizedInvoice(longReasonSource.id, actor.id, { ...longReasonInput, reason: "R".repeat(499) + "S" }), /conflict/);
    const mixed = await sale(400);
    await prisma.payment.create({ data: { invoiceId: mixed.id, method: "BANK_TRANSFER", kind: "CHARGE", status: "SUCCESS", amount: 300, createdById: actor.id } });
    await prisma.invoice.update({ where: { id: mixed.id }, data: { paidTotal: 700 } });
    const mixedResult = await replace(mixed, input(6));
    const mixedRecord = await prisma.invoiceCorrectionSettlement.findUniqueOrThrow({ where: { sourceInvoiceId: mixed.id } });
    assert.equal(mixedRecord.transferredCredit, 600); assert.equal(mixedRecord.retainedCredit, 100);
    assert.deepEqual((mixedRecord.receipts as any[]).map(p => p.method).sort(), ["BANK_TRANSFER", "CASH"]);
    assert.equal(await prisma.payment.count({ where: { invoiceId: mixedResult.replacementInvoice.id } }), 0);
    const changed = await sale(), changedResult = await replace(changed, input(7, randomUUID(), other.id));
    assert.equal(changedResult.replacementInvoice.correctionCredit, 0); assert.equal((await balance(changed.id)).retainedCredit, 400); assert.equal((await balance(changedResult.replacementInvoice.id, other.name)).due, 700);
    const walk = await sale(400, null), walkResult = await replace(walk, input(7, randomUUID(), null));
    assert.equal(walkResult.replacementInvoice.correctionCredit, 0); assert.equal((await prisma.invoiceCorrectionSettlement.findUniqueOrThrow({ where: { sourceInvoiceId: walk.id } })).retainedCredit, 400);
    const cancelled = await sale(), cancelKey = randomUUID(), cancelResult = await cancelInvoice(cancelled.id, actor.id, cancelKey);
    assert.equal((await balance(cancelled.id)).retainedCredit, 400); assert.equal((await balance(cancelled.id)).due, 0); assert.deepEqual(await cancelInvoice(cancelled.id, actor.id, cancelKey), cancelResult);
    await prisma.invoice.update({ where: { id: cancelled.id }, data: { deletedAt: new Date() } }); assert.equal((await balance(cancelled.id)).retainedCredit, 400);

    const raceSource = await sale(), racePayload = input();
    const duplicate = await race(() => replace(raceSource, racePayload), () => modifyFinalizedInvoice(raceSource.id, actor.id, racePayload));
    assert.ok(duplicate.every(r => r.status === "fulfilled")); assert.deepEqual((duplicate[0] as any).value, (duplicate[1] as any).value);
    const decision = await sale(); const decisions = await race(() => cancelInvoice(decision.id, actor.id, randomUUID()), () => replace(decision));
    assert.equal(decisions[0].status, "fulfilled"); assert.equal(decisions[1].status, "rejected");
    const payFirstSource = await sale(); const payFirst = await race(() => addPayment(payFirstSource.id, "CASH", 100, "SUCCESS", actor.id), () => cancelInvoice(payFirstSource.id, actor.id, randomUUID()));
    assert.ok(payFirst.every(r => r.status === "fulfilled")); assert.equal((await balance(payFirstSource.id)).retainedCredit, 500);
    const correctionFirstSource = await sale(); const correctionFirst = await race(() => cancelInvoice(correctionFirstSource.id, actor.id, randomUUID()), () => addPayment(correctionFirstSource.id, "CASH", 100, "SUCCESS", actor.id));
    assert.equal(correctionFirst[0].status, "fulfilled"); assert.equal(correctionFirst[1].status, "rejected"); assert.equal((await balance(correctionFirstSource.id)).retainedCredit, 400);

    for (const action of ["REPLACE", "CANCEL"]) {
      const failed = await sale(), key = randomUUID(), invoiceBefore = await prisma.invoice.findUnique({ where: { id: failed.id } }), stockBefore = await prisma.product.findUnique({ where: { id: product.id } });
      const countBefore = { invoices: await prisma.invoice.count(), notes: await prisma.creditNote.count(), audits: await prisma.auditLog.count(), stocks: await prisma.stockTransaction.count(), settlements: await prisma.invoiceCorrectionSettlement.count() }; let staged = 0;
      prisma.$transaction = ((work: any, opts: any) => original(async (tx: any) => work(new Proxy(tx, { get(target, field) {
        if (field === "auditLog") return { ...tx.auditLog, create: async (args: any) => { const row = await tx.auditLog.create(args); if (args.data.action === "CUSTOMER_CREDIT_CORRECTION_RECORDED") { staged++; throw Error("Injected correction audit rollback"); } return row; } };
        return Reflect.get(target, field);
      } })), opts)) as any;
      await assert.rejects(action === "REPLACE" ? replace(failed, input(7, key)) : cancelInvoice(failed.id, actor.id, key), /audit rollback/); prisma.$transaction = original;
      assert.equal(staged, 1); assert.deepEqual(await prisma.invoice.findUnique({ where: { id: failed.id } }), invoiceBefore); assert.deepEqual(await prisma.product.findUnique({ where: { id: product.id } }), stockBefore);
      assert.deepEqual({ invoices: await prisma.invoice.count(), notes: await prisma.creditNote.count(), audits: await prisma.auditLog.count(), stocks: await prisma.stockTransaction.count(), settlements: await prisma.invoiceCorrectionSettlement.count() }, countBefore);
      assert.equal(await prisma.invoiceCorrectionSettlement.count({ where: { operationKey: key } }), 0);
      if (action === "REPLACE") await replace(failed, input(7, key)); else await cancelInvoice(failed.id, actor.id, key);
    }

    const left = await sale(), right = await sale(), sharedKey = randomUUID();
    const distinctProduct = await prisma.product.create({ data: { name: "Owned distinct correction", sku: `DISTINCT-${suffix}`, brandId: brand.id, stock: 100, retailPrice: 100 } });
    await prisma.invoiceItem.updateMany({ where: { invoiceId: right.id }, data: { productId: distinctProduct.id } });
    let inserted!: () => void, attempted!: () => void, release!: () => void, entries = 0;
    const a = new Promise<void>(r => inserted = r), b = new Promise<void>(r => attempted = r), gate = new Promise<void>(r => release = r);
    prisma.$transaction = ((work: any, opts: any) => original(async (tx: any) => work(new Proxy(tx, { get(target, field) {
      if (field === "invoiceCorrectionSettlement") return { ...tx.invoiceCorrectionSettlement, create: async (args: any) => {
        const n = ++entries; if (n === 2) attempted(); const result = await tx.invoiceCorrectionSettlement.create(args); if (n === 1) { inserted(); await gate; } return result;
      } }; return Reflect.get(target, field);
    } })), { ...opts, timeout: 20000 })) as any;
    const winner = cancelInvoice(left.id, actor.id, sharedKey); await a; const loser = cancelInvoice(right.id, actor.id, sharedKey); await b; release();
    const collision = await Promise.allSettled([winner, loser]); prisma.$transaction = original;
    assert.equal(entries, 2); assert.equal(collision[0].status, "fulfilled"); assert.equal(collision[1].status, "rejected"); assert.match((collision[1] as PromiseRejectedResult).reason.message, /conflict/);
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: right.id } })).paymentStatus, "PARTIALLY_PAID"); assert.equal(await prisma.invoiceCorrectionSettlement.count({ where: { sourceInvoiceId: right.id } }), 0);
    assert.equal(await prisma.stockTransaction.count({ where: { refInvoiceId: right.id } }), 0);

    const pending = await sale(); await prisma.payment.create({ data: { invoiceId: pending.id, method: "ESEWA", kind: "CHARGE", amount: 100, status: "PENDING", createdById: actor.id } });
    await assert.rejects(cancelInvoice(pending.id, actor.id, randomUUID()), /receipt basis/);
    const corrupt = await sale(); await prisma.invoice.update({ where: { id: corrupt.id }, data: { paidTotal: 401 } }); await assert.rejects(replace(corrupt), /receipt basis/);
  } finally {
    prisma.$transaction = original;
    const ownedInvoices = await prisma.invoice.findMany({ where: { cashierId: actor.id }, select: { id: true } }); const ids = ownedInvoices.map(i => i.id);
    await prisma.customerCreditOperation.deleteMany({ where: { actorId: actor.id } }); await prisma.customerCreditApplication.deleteMany({ where: { actorId: actor.id } });
    await prisma.returnOperation.deleteMany({ where: { actorId: actor.id } }); await prisma.returnItem.deleteMany({ where: { returnRequest: { invoiceId: { in: ids } } } }); await prisma.returnRequest.deleteMany({ where: { invoiceId: { in: ids } } });
    await prisma.invoiceCorrectionSettlement.deleteMany({ where: { actorId: actor.id } }); await prisma.creditNote.deleteMany({ where: { createdById: actor.id } });
    await prisma.stockTransaction.deleteMany({ where: { createdById: actor.id } }); await prisma.payment.deleteMany({ where: { invoiceId: { in: ids } } }); await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: ids } } }); await prisma.invoice.deleteMany({ where: { id: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: actor.id } }); await prisma.cashDrawer.delete({ where: { id: drawer.id } }); await prisma.product.deleteMany({ where: { brandId: brand.id } }); await prisma.brand.delete({ where: { id: brand.id } }); await prisma.customer.deleteMany({ where: { id: { in: [customer.id, other.id] } } }); await prisma.user.deleteMany({ where: { id: { in: [actor.id, cashier.id] } } }); await prisma.$disconnect();
  }
});
