import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
import prisma from "../db/prisma";
import { applyCustomerCredit, reverseCustomerCredit } from "../modules/customers/creditApplications";
import { listCustomerReceivables } from "../modules/customers/receivables";
import { createReturnRequest, approveReturnRequest, reverseApprovedReturnRequest } from "../modules/returns/service";
import { addPayment, voidPayment } from "../modules/payments/service";
import { cancelInvoice, modifyFinalizedInvoice } from "../modules/invoices/service";
import { listAuditLogs, listCategorizedHistory } from "../modules/audit/service";

test("MySQL credit applications preserve receipts, serialize spending/payment/reversal and roll back actual writes", { skip: process.env.KHATASATHI_CREDIT_MYSQL_TEST !== "1", timeout: 120000 }, async () => {
  const url = new URL(process.env.DATABASE_URL || "");
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname) && (url.port || "3306") === "3306" && url.pathname === "/ks_verify_credit_application_20261010", "Owned exact target required");
  const original = prisma.$transaction.bind(prisma), suffix = randomUUID();
  const actor = await prisma.user.create({ data: { name: "Owned credit actor", phone: `+97798${randomInt(10000000,99999999)}`, passwordHash: "unusable", role: "MANAGER" } });
  const cashier = await prisma.user.create({ data: { name: "Owned credit cashier", phone: `+97797${randomInt(10000000,99999999)}`, passwordHash: "unusable", role: "CASHIER" } });
  const customer = await prisma.customer.create({ data: { name: `Owned credit ${suffix}` } });
  const other = await prisma.customer.create({ data: { name: `Owned other ${suffix}` } });
  const brand = await prisma.brand.create({ data: { name: `Owned credit ${suffix}` } });
  const product = await prisma.product.create({ data: { name: "Owned credit item", sku: `CREDIT-${suffix}`, brandId: brand.id, stock: 100, retailPrice: 100 } });
  const invoices: string[] = [];
  async function sale(netTotal = 1000, paid = 400, customerId: string | null = customer.id) {
    const i = await prisma.invoice.create({ data: { invoiceNo: `CREDIT-${randomUUID()}`, cashierId: actor.id, customerId, status: "FINALIZED", finalizedAt: new Date(), netTotal, subTotal: netTotal,
      paidTotal: paid, paymentStatus: paid >= netTotal ? "PAID" : paid > 0 ? "PARTIALLY_PAID" : "UNPAID",
      items: { create: { productId: product.id, qty: 10, appliedUnitPrice: netTotal/10, lineTotal: netTotal, productNameSnapshot: "Owned credit item", snapshotCapturedAt: new Date() } },
      ...(paid ? { payments: { create: { method: "CASH", amount: paid, kind: "CHARGE", status: "SUCCESS", createdById: actor.id } } } : {}) }, include: { items: true } });
    invoices.push(i.id); return i;
  }
  async function source(paid = 400) {
    const i = await sale(1000, paid);
    const r = await createReturnRequest(actor.id, { invoiceId: i.id, reason: "CUSTOMER_REQUEST", items: [{ invoiceItemId: i.items[0].id, qty: 8 }], operationKey: randomUUID() });
    await approveReturnRequest(r.id, actor.id, randomUUID()); return { i, r };
  }
  const input = (s: any, target: any, amount = 150, operationKey = randomUUID()) => ({ sourceReturnId: s.r.id, targetInvoiceId: target.id, amount, reason: "Apply original customer credit", operationKey });
  async function balance(id: string) { return (await listCustomerReceivables({ q: customer.name }, "MANAGER")).items[0].invoices.find(i => i.invoiceId === id)!; }
  // First transaction owns every affected invoice before the second decision starts.
  async function race(first: () => Promise<any>, second: () => Promise<any>, firstLocks = 2) {
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
    const s = await source(), target = await sale(300, 0), initialPayments = await prisma.payment.count(), initialStock = await prisma.stockTransaction.count(), initialCash = await prisma.cashDrawerEvent.count();
    const payload = input(s, target), applied = await applyCustomerCredit(actor.id, payload);
    assert.equal((await balance(target.id)).due, 150); assert.equal((await balance(target.id)).recordedReceipts, 0); assert.equal((await balance(s.i.id)).retainedCredit, 50);
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: target.id } })).paidTotal, 0);
    assert.equal(await prisma.auditLog.count({ where: { action: "CUSTOMER_CREDIT_APPLIED", entityId: applied.id } }), 1);
    const hidden = await listAuditLogs({ action: "CUSTOMER_CREDIT_" }); assert.equal(hidden.total, 0); assert.equal(hidden.logs.length, 0);
    const hiddenSearch = await listCategorizedHistory({ action: "CUSTOMER_CREDIT_", q: applied.id }); assert.equal(hiddenSearch.total, 0); assert.equal(hiddenSearch.events.length, 0);
    assert.equal((await balance(s.i.id)).applications.find(a => a.id === applied.id)?.reason, payload.reason);
    assert.equal(await prisma.payment.count(), initialPayments); assert.equal(await prisma.stockTransaction.count(), initialStock); assert.equal(await prisma.cashDrawerEvent.count(), initialCash);
    assert.deepEqual(await applyCustomerCredit(actor.id, payload), applied);
    await assert.rejects(applyCustomerCredit(actor.id, { ...payload, amount: 151 }), /conflict/);
    await assert.rejects(applyCustomerCredit(cashier.id, payload), /access/);
    await prisma.user.update({ where: { id: cashier.id }, data: { role: "MANAGER" } });
    await assert.rejects(applyCustomerCredit(cashier.id, payload), /conflict/);
    await prisma.user.update({ where: { id: cashier.id }, data: { role: "CASHIER" } });
    await assert.rejects(reverseCustomerCredit(actor.id, applied.id, { reason: "Undo", operationKey: payload.operationKey }), /conflict/);
    await assert.rejects(reverseApprovedReturnRequest(s.r.id, actor.id, "Undo", randomUUID()), /active credit/);
    await assert.rejects(createReturnRequest(actor.id, { invoiceId: target.id, reason: "CUSTOMER_REQUEST", items: [{ invoiceItemId: target.items[0].id, qty: 1 }], operationKey: randomUUID() }), /incoming credit/);
    await assert.rejects(cancelInvoice(target.id, actor.id, randomUUID()), /active credit/);
    await assert.rejects(modifyFinalizedInvoice(target.id, actor.id, { operationKey: randomUUID(), items: [{ productId: product.id, qty: 3 }], reason: "Correction" }), /active credit/);
    await assert.rejects(addPayment(target.id, "CASH", 151, "SUCCESS", actor.id), /Overpayment/);
    const reversal = { reason: "Wrong target selected", operationKey: randomUUID() }, reversed = await reverseCustomerCredit(actor.id, applied.id, reversal);
    assert.equal((await balance(target.id)).due, 300); assert.equal((await balance(s.i.id)).retainedCredit, 200);
    assert.deepEqual(await reverseCustomerCredit(actor.id, applied.id, reversal), reversed);
    assert.equal(await prisma.auditLog.count({ where: { action: "CUSTOMER_CREDIT_REVERSED", entityId: applied.id } }), 1);
    assert.equal((await listAuditLogs({ action: "CUSTOMER_CREDIT_REVERSED" })).total, 0);
    assert.deepEqual(await applyCustomerCredit(actor.id, payload), applied);
    await assert.rejects(reverseCustomerCredit(actor.id, applied.id, { ...reversal, operationKey: randomUUID() }), /already reversed/);

    const fractional = await source(400.55), fractionalTarget = await sale(300, 0);
    const fractionalApp = await applyCustomerCredit(actor.id, input(fractional, fractionalTarget, 150.55));
    assert.equal((await balance(fractionalTarget.id)).due, 149.45); assert.equal((await balance(fractional.i.id)).retainedCredit, 50);
    await assert.rejects(applyCustomerCredit(actor.id, input(fractional, fractionalTarget, 1.001)), /Invalid input|custom/);
    await reverseCustomerCredit(actor.id, fractionalApp.id, { reason: "Fraction correction", operationKey: randomUUID() });

    const competing = await source(), left = await sale(300, 0), right = await sale(300, 0);
    const spendRace = await race(() => applyCustomerCredit(actor.id, input(competing, left)), () => applyCustomerCredit(actor.id, input(competing, right)));
    assert.equal(spendRace[0].status, "fulfilled"); assert.equal(spendRace[1].status, "rejected"); assert.match((spendRace[1] as PromiseRejectedResult).reason.message, /available credit/);
    const sameSource = await source(), sameTarget = await sale(300, 0), same = input(sameSource, sameTarget);
    const replayRace = await race(() => applyCustomerCredit(actor.id, same), () => applyCustomerCredit(actor.id, same));
    assert.ok(replayRace.every(r => r.status === "fulfilled")); assert.deepEqual((replayRace[0] as any).value, (replayRace[1] as any).value);

    const paySource = await source(), payTarget = await sale(300, 0);
    const applyFirst = await race(() => applyCustomerCredit(actor.id, input(paySource, payTarget, 200)), () => addPayment(payTarget.id, "CASH", 150, "SUCCESS", actor.id));
    assert.equal(applyFirst[0].status, "fulfilled"); assert.equal(applyFirst[1].status, "rejected"); assert.match((applyFirst[1] as PromiseRejectedResult).reason.message, /Overpayment/);
    const actualCharge = await addPayment(payTarget.id, "CASH", 100, "SUCCESS", actor.id);
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: payTarget.id } })).paymentStatus, "PAID");
    await voidPayment(payTarget.id, actualCharge.id, actor.id);
    const afterVoid = await prisma.invoice.findUniqueOrThrow({ where: { id: payTarget.id } });
    assert.equal(afterVoid.creditApplied, 200); assert.equal(afterVoid.paidTotal, 0); assert.equal(afterVoid.paymentStatus, "PARTIALLY_PAID");
    assert.equal((await balance(payTarget.id)).due, 100);
    const paySource2 = await source(), payTarget2 = await sale(300, 0);
    const paymentFirst = await race(() => addPayment(payTarget2.id, "CASH", 150, "SUCCESS", actor.id), () => applyCustomerCredit(actor.id, input(paySource2, payTarget2, 200)), 1);
    assert.equal(paymentFirst[0].status, "fulfilled"); assert.equal(paymentFirst[1].status, "rejected"); assert.match((paymentFirst[1] as PromiseRejectedResult).reason.message, /remaining due/);
    const reverseSource = await source(), reverseTarget = await sale(300, 0);
    const reverseRace = await race(() => applyCustomerCredit(actor.id, input(reverseSource, reverseTarget)), () => reverseApprovedReturnRequest(reverseSource.r.id, actor.id, "Undo", randomUUID()));
    assert.equal(reverseRace[0].status, "fulfilled"); assert.equal(reverseRace[1].status, "rejected"); assert.match((reverseRace[1] as PromiseRejectedResult).reason.message, /active credit/);

    const failSource = await source(), failTarget = await sale(300, 0), fail = input(failSource, failTarget);
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: failTarget.id } }), audits = await prisma.auditLog.count(), applications = await prisma.customerCreditApplication.count(); let staged = 0;
    prisma.$transaction = ((work: any, opts: any) => original(async (tx: any) => work(new Proxy(tx, { get(target, key) {
      if (key === "auditLog") return { ...tx.auditLog, create: async (args: any) => { await tx.auditLog.create(args); staged++; throw Error("Injected staged audit rollback"); } };
      return Reflect.get(target, key);
    } })), opts)) as any;
    await assert.rejects(applyCustomerCredit(actor.id, fail), /staged audit rollback/); prisma.$transaction = original;
    assert.equal(staged, 1); assert.deepEqual(await prisma.invoice.findUniqueOrThrow({ where: { id: failTarget.id } }), before);
    assert.equal(await prisma.auditLog.count(), audits); assert.equal(await prisma.customerCreditApplication.count(), applications);
    assert.equal(await prisma.customerCreditOperation.count({ where: { operationKey: fail.operationKey } }), 0);
    const retry = await applyCustomerCredit(actor.id, fail);
    const reverseTwice = await race(() => reverseCustomerCredit(actor.id, retry.id, { reason: "Undo", operationKey: randomUUID() }), () => reverseCustomerCredit(actor.id, retry.id, { reason: "Undo", operationKey: randomUUID() }));
    assert.equal(reverseTwice[0].status, "fulfilled"); assert.equal(reverseTwice[1].status, "rejected"); assert.equal((await balance(failSource.i.id)).retainedCredit, 200);

    const wrong = await sale(300, 0, other.id), walkin = await sale(300, 0, null);
    await assert.rejects(applyCustomerCredit(actor.id, input(s, wrong)), /same named customer/); await assert.rejects(applyCustomerCredit(actor.id, input(s, walkin)), /same named customer/);
    const gateway = await sale(300, 0); await prisma.payment.create({ data: { invoiceId: gateway.id, amount: 100, method: "ESEWA", kind: "CHARGE", status: "PENDING", createdById: actor.id } });
    await assert.rejects(applyCustomerCredit(actor.id, input(s, gateway)), /pending verification/);
    const malformed = await sale(300, 0); await prisma.invoice.update({ where: { id: malformed.id }, data: { creditApplied: 20 } });
    await assert.rejects(applyCustomerCredit(actor.id, input(s, malformed)), /projection/);
    const legacy = await sale(300, 0); await prisma.payment.create({ data: { invoiceId: legacy.id, amount: -20, method: "CASH", kind: "REFUND", status: "SUCCESS", createdById: actor.id } });
    await assert.rejects(applyCustomerCredit(actor.id, input(s, legacy)), /Legacy/);

    // Disjoint invoice locks cannot serialize a shared operation identity. The first
    // real UNIQUE INSERT is held open while the other transaction attempts its INSERT.
    const uniqueSource1 = await source(), uniqueSource2 = await source(), uniqueTarget1 = await sale(300, 0), uniqueTarget2 = await sale(300, 0), uniqueKey = randomUUID();
    let inserted!: () => void, attempted!: () => void, release!: () => void, inserts = 0;
    const firstInserted = new Promise<void>(r => inserted = r), secondAttempted = new Promise<void>(r => attempted = r), gate = new Promise<void>(r => release = r);
    prisma.$transaction = ((work: any, opts: any) => original(async (tx: any) => work(new Proxy(tx, { get(target, key) {
      if (key === "customerCreditOperation") return { ...tx.customerCreditOperation, create: async (args: any) => {
        const ordinal = ++inserts; if (ordinal === 2) attempted();
        const row = await tx.customerCreditOperation.create(args); if (ordinal === 1) { inserted(); await gate; } return row;
      } }; return Reflect.get(target, key);
    } })), { ...opts, timeout: 15000 })) as any;
    const winner = applyCustomerCredit(actor.id, input(uniqueSource1, uniqueTarget1, 150, uniqueKey)); await firstInserted;
    const loser = applyCustomerCredit(actor.id, input(uniqueSource2, uniqueTarget2, 150, uniqueKey)); await secondAttempted; release();
    const collision = await Promise.allSettled([winner, loser]); prisma.$transaction = original;
    assert.equal(inserts, 2); assert.equal(collision[0].status, "fulfilled"); assert.equal(collision[1].status, "rejected"); assert.match((collision[1] as PromiseRejectedResult).reason.message, /conflict/);
    assert.equal(await prisma.customerCreditApplication.count({ where: { targetInvoiceId: uniqueTarget2.id } }), 0);
    assert.equal(await prisma.auditLog.count({ where: { action: "CUSTOMER_CREDIT_APPLIED", meta: { path: "$.targetInvoiceId", equals: uniqueTarget2.id } } }), 0);
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: uniqueTarget2.id } })).creditApplied, 0);

    const reversible = (collision[0] as PromiseFulfilledResult<any>).value, reversalKey = randomUUID(); staged = 0;
    prisma.$transaction = ((work: any, opts: any) => original(async (tx: any) => work(new Proxy(tx, { get(target, key) {
      if (key === "auditLog") return { ...tx.auditLog, create: async (args: any) => { await tx.auditLog.create(args); staged++; throw Error("Injected reversal audit rollback"); } };
      return Reflect.get(target, key);
    } })), opts)) as any;
    await assert.rejects(reverseCustomerCredit(actor.id, reversible.id, { reason: "Undo", operationKey: reversalKey }), /reversal audit rollback/); prisma.$transaction = original;
    assert.equal(staged, 1); assert.equal((await prisma.customerCreditApplication.findUniqueOrThrow({ where: { id: reversible.id } })).reversedAt, null);
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: uniqueTarget1.id } })).creditApplied, 150);
    assert.equal(await prisma.customerCreditOperation.count({ where: { operationKey: reversalKey } }), 0);
    await reverseCustomerCredit(actor.id, reversible.id, { reason: "Undo", operationKey: reversalKey });

    const returnFirstSource = await source(), returnFirstTarget = await sale(300, 0);
    const returnFirst = await race(() => reverseApprovedReturnRequest(returnFirstSource.r.id, actor.id, "Undo", randomUUID()), () => applyCustomerCredit(actor.id, input(returnFirstSource, returnFirstTarget)), 1);
    assert.equal(returnFirst[0].status, "fulfilled"); assert.equal(returnFirst[1].status, "rejected");
    assert.equal(await prisma.customerCreditApplication.count({ where: { sourceInvoiceId: returnFirstSource.i.id } }), 0);
  } finally {
    prisma.$transaction = original;
    await prisma.customerCreditOperation.deleteMany({ where: { actorId: actor.id } }); await prisma.customerCreditApplication.deleteMany({ where: { actorId: actor.id } });
    await prisma.returnOperation.deleteMany({ where: { actorId: actor.id } }); await prisma.returnItem.deleteMany({ where: { returnRequest: { invoiceId: { in: invoices } } } }); await prisma.returnRequest.deleteMany({ where: { invoiceId: { in: invoices } } });
    await prisma.stockTransaction.deleteMany({ where: { createdById: actor.id } }); await prisma.payment.deleteMany({ where: { invoiceId: { in: invoices } } }); await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: invoices } } }); await prisma.invoice.deleteMany({ where: { id: { in: invoices } } });
    await prisma.auditLog.deleteMany({ where: { actorId: actor.id } }); await prisma.product.delete({ where: { id: product.id } }); await prisma.brand.delete({ where: { id: brand.id } }); await prisma.customer.deleteMany({ where: { id: { in: [customer.id, other.id] } } }); await prisma.user.deleteMany({ where: { id: { in: [actor.id, cashier.id] } } }); await prisma.$disconnect();
  }
});
