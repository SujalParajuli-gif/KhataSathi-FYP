import { confirmCustomerCreditPayout, confirmCustomerCreditRecovery } from "../modules/customers/cashPayouts";
import { getCurrentCashDrawer, closeCashDrawer, addCashDrawerEvent } from "../modules/cash-drawers/service";
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

test("MySQL confirmed credit payouts and real cash recoveries serialize source/drawer decisions and roll back staged writes", { skip: process.env.KHATASATHI_CREDIT_PAYOUT_MYSQL_TEST !== "1", timeout: 120000 }, async () => {
  const url = new URL(process.env.DATABASE_URL || "");
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname) && (url.port || "3306") === "3306" && url.pathname === "/ks_verify_credit_payout_20261011", "Owned exact target required");
  const original = prisma.$transaction.bind(prisma), suffix = randomUUID();
  await prisma.businessSettings.upsert({ where: { id: 1 }, create: { id: 1, businessMode: "FULL_POS", loyaltyDiscountPercent: 0 }, update: { businessMode: "FULL_POS", loyaltyDiscountPercent: 0 } });
  const actor = await prisma.user.create({ data: { name: "Owned credit actor", phone: `+97798${randomInt(10000000,99999999)}`, passwordHash: "unusable", role: "MANAGER" } });
  const cashier = await prisma.user.create({ data: { name: "Owned credit cashier", phone: `+97797${randomInt(10000000,99999999)}`, passwordHash: "unusable", role: "CASHIER" } });
  const customer = await prisma.customer.create({ data: { name: `Owned credit ${suffix}`, loyaltyPercent: 0, wholesalePercent: 0 } });
  const other = await prisma.customer.create({ data: { name: `Owned other ${suffix}` } });
  const brand = await prisma.brand.create({ data: { name: `Owned credit ${suffix}` } });
  const product = await prisma.product.create({ data: { name: "Owned credit item", sku: `CREDIT-${suffix}`, brandId: brand.id, stock: 1000, retailPrice: 100, wholesalePrice: 100, wholesaleEligible: false } });
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
  async function correctionSource(paid = 400, replacement = false, customerId: string | null = customer.id) {
    const i = await sale(1000, paid, customerId);
    if (replacement) {
      const result = await modifyFinalizedInvoice(i.id, actor.id, { operationKey: randomUUID(), items: [{ productId: product.id, qty: 6 }], reason: "Owned residual source" });
      invoices.push(result.replacementInvoice.id);
    } else await cancelInvoice(i.id, actor.id, randomUUID());
    const record = await prisma.invoiceCorrectionSettlement.findUniqueOrThrow({ where: { sourceInvoiceId: i.id } });
    return { i, record };
  }
  const correctionInput = (s: any, target: any, amount = 150, operationKey = randomUUID()) => ({ sourceCorrectionId: s.record.id, targetInvoiceId: target.id, amount, reason: "Apply captured original-owner credit", operationKey });
  const input = (s: any, target: any, amount = 150, operationKey = randomUUID()) => ({ sourceReturnId: s.r.id, targetInvoiceId: target.id, amount, reason: "Apply original customer credit", operationKey });
  async function balance(id: string) { return (await listCustomerReceivables({ q: customer.name }, "MANAGER")).items[0].invoices.find(i => i.invoiceId === id)!; }
  // First transaction owns every affected invoice before the second decision starts.
  async function race(first: () => Promise<any>, second: () => Promise<any>, firstLocks = 2, contended = "Invoice") {
    let held!: () => void, attempted!: () => void, release!: () => void, transactions = 0, firstCount = 0, attempts = 0;
    const a = new Promise<void>(r => held = r), b = new Promise<void>(r => attempted = r), gate = new Promise<void>(r => release = r);
    prisma.$transaction = ((work: any, opts: any) => original(async (tx: any) => {
      const ordinal = ++transactions;
      return work(new Proxy(tx, { get(target, key) {
        if (key === "$queryRaw") return async (query: TemplateStringsArray, ...values: any[]) => {
          const isLock = query.join(" ").includes("FOR UPDATE");
          const competing = query.join(" ").includes(`FROM ${contended} `);
          if (isLock && competing && ordinal === 2) { attempts++; attempted(); }
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
  const drawers: string[] = [];
  async function drawer() { const d = await prisma.cashDrawer.create({ data: { cashierId: actor.id, openingFloat: 1000, expectedTotal: 1000 } }); drawers.push(d.id); return d; }
  const own = await drawer();
  const pay = (s: any, d = own, amount = 100, operationKey = randomUUID()) => ({ ...(s.record ? { sourceCorrectionId: s.record.id } : { sourceReturnId: s.r.id }), drawerId: d.id, amount, reason: "Confirmed new customer cash payout", operationKey, cashConfirmed: true as const, newPayoutConfirmed: true as const });
  const recover = (d = own, operationKey = randomUUID()) => ({ drawerId: d.id, operationKey, reason: "Customer actually returned all cash", cashReceivedConfirmed: true as const });
  async function drawerRow(d = own) { return prisma.cashDrawer.findUniqueOrThrow({ where: { id: d.id } }); }
  try {
    const cs = await correctionSource(), ct = await sale(300, 0);
    await applyCustomerCredit(actor.id, correctionInput(cs, ct, 150));
    const counts = async () => ({ payments: await prisma.payment.count(), stock: await prisma.stockTransaction.count(), expenses: await prisma.expense.count() });
    const before = await counts(), packet = pay(cs), out = await confirmCustomerCreditPayout(actor.id, packet);
    assert.equal((await balance(cs.i.id)).retainedCredit, 150); assert.equal((await balance(cs.i.id)).paidOutCredit, 100);
    assert.equal((await balance(ct.id)).due, 150); assert.equal((await balance(ct.id)).recordedReceipts, 0);
    assert.equal((await prisma.invoiceCorrectionSettlement.findUniqueOrThrow({ where: { id: cs.record.id } })).retainedCredit, 400);
    assert.equal((await drawerRow()).cashOutTotal, 100); assert.equal((await drawerRow()).expectedTotal, 1300);
    assert.deepEqual(await confirmCustomerCreditPayout(actor.id, packet), out); assert.equal(await prisma.cashDrawerEvent.count({ where: { id: out.payoutEventId } }), 1);
    assert.deepEqual(await counts(), before); assert.equal("operationKey" in out, false); assert.equal("payloadHash" in out, false);
    assert.equal((await listAuditLogs({ action: "CUSTOMER_CREDIT_PAYOUT" })).total, 0); assert.equal((await listCategorizedHistory({ q: out.id, action: "CUSTOMER_CREDIT_" })).total, 0);
    await assert.rejects(confirmCustomerCreditPayout(actor.id, { ...packet, amount: 101 }), /conflict/);
    await assert.rejects(confirmCustomerCreditPayout(cashier.id, packet), /access/);
    await assert.rejects(confirmCustomerCreditPayout(actor.id, { ...pay(cs), cashConfirmed: false }));
    await assert.rejects(confirmCustomerCreditPayout(actor.id, { ...pay(cs), newPayoutConfirmed: false }));
    await assert.rejects(confirmCustomerCreditPayout(actor.id, { ...pay(cs), sourceReturnId: "both" }), /Exactly one/);
    await assert.rejects(confirmCustomerCreditPayout(actor.id, pay(cs, own, 151)), /available/);
    await assert.rejects(confirmCustomerCreditPayout(actor.id, { ...pay(cs), amount: 0.001 }));
    const recovery = recover(), restored = await confirmCustomerCreditRecovery(actor.id, out.id, recovery);
    assert.equal((await balance(cs.i.id)).retainedCredit, 250); assert.equal((await drawerRow()).cashInTotal, 100); assert.equal((await drawerRow()).expectedTotal, 1400);
    assert.deepEqual(await confirmCustomerCreditRecovery(actor.id, out.id, recovery), restored);
    await assert.rejects(confirmCustomerCreditRecovery(actor.id, out.id, recover()), /already/);
    await assert.rejects(confirmCustomerCreditRecovery(actor.id, out.id, { ...recover(), cashReceivedConfirmed: false }));
    await assert.rejects(confirmCustomerCreditRecovery(actor.id, out.id, recover(own, packet.operationKey)), /conflict/);
    assert.deepEqual(await confirmCustomerCreditPayout(actor.id, packet), out); assert.deepEqual(await counts(), before);

    const rs = await source(), retPayout = await confirmCustomerCreditPayout(actor.id, pay(rs, own, 200));
    assert.equal((await balance(rs.i.id)).retainedCredit, 0);
    await assert.rejects(reverseApprovedReturnRequest(rs.r.id, actor.id, "Cannot undo paid out", randomUUID()), /Recover paid-out/);
    await confirmCustomerCreditRecovery(actor.id, retPayout.id, recover());
    await reverseApprovedReturnRequest(rs.r.id, actor.id, "Cash actually recovered", randomUUID());
    assert.equal((await balance(rs.i.id)).due, 600); assert.deepEqual(await confirmCustomerCreditPayout(actor.id, pay(rs, own, 200, (await prisma.customerCreditPayoutOperation.findFirstOrThrow({ where: { payoutId: retPayout.id, action: "PAYOUT" } })).operationKey)), retPayout);

    const fractional = await correctionSource(400.55); await confirmCustomerCreditPayout(actor.id, pay(fractional, own, 100.25));
    await applyCustomerCredit(actor.id, correctionInput(fractional, await sale(300, 0), 150.1)); assert.equal((await balance(fractional.i.id)).retainedCredit, 150.2);
    const walk = await correctionSource(400, false, null); await assert.rejects(confirmCustomerCreditPayout(actor.id, pay(walk)), /named original/);
    const malformed = await correctionSource(); await prisma.invoiceCorrectionSettlement.update({ where: { id: malformed.record.id }, data: { retainedCredit: 401 } }); await assert.rejects(confirmCustomerCreditPayout(actor.id, pay(malformed)), /reconcile/);
    const pending = await source(); await prisma.payment.create({ data: { invoiceId: pending.i.id, method: "ESEWA", kind: "CHARGE", status: "PENDING", amount: 1, createdById: actor.id } }); await assert.rejects(confirmCustomerCreditPayout(actor.id, pay(pending)), /pending/);
    const foreign = await prisma.cashDrawer.create({ data: { cashierId: cashier.id, openingFloat: 1000 } }); drawers.push(foreign.id);
    await assert.rejects(confirmCustomerCreditPayout(actor.id, pay(await correctionSource(), foreign)), /own open/);
    await addCashDrawerEvent(own.id, actor.id, "MANAGER", "CASH_OUT", 25, "Prior manual cash movement");
    const manualBefore = await prisma.cashDrawerEvent.count({ where: { drawerId: own.id } }); const manualSource = await correctionSource();
    await confirmCustomerCreditPayout(actor.id, pay(manualSource, own, 25)); assert.equal(await prisma.cashDrawerEvent.count({ where: { drawerId: own.id } }), manualBefore + 1);
    assert.equal((await balance(manualSource.i.id)).retainedCredit, 375); // No inferred claim on the old manual event.

    const raceSource = await correctionSource(), raceTarget = await sale(500, 0);
    const spending = await race(() => confirmCustomerCreditPayout(actor.id, pay(raceSource, own, 300)), () => applyCustomerCredit(actor.id, correctionInput(raceSource, raceTarget, 300)));
    assert.equal(spending[0].status, "fulfilled"); assert.equal(spending[1].status, "rejected"); assert.equal((await balance(raceSource.i.id)).retainedCredit, 100);
    const appSource = await correctionSource(), appTarget = await sale(500, 0);
    const appFirst = await race(() => applyCustomerCredit(actor.id, correctionInput(appSource, appTarget, 300)), () => confirmCustomerCreditPayout(actor.id, pay(appSource, own, 300)));
    assert.equal(appFirst[0].status, "fulfilled"); assert.equal(appFirst[1].status, "rejected"); assert.equal((await balance(appSource.i.id)).retainedCredit, 100);
    const sameSource = await correctionSource(), same = pay(sameSource);
    const duplicates = await race(() => confirmCustomerCreditPayout(actor.id, same), () => confirmCustomerCreditPayout(actor.id, same)); assert.ok(duplicates.every(r => r.status === "fulfilled")); assert.deepEqual((duplicates[0] as any).value, (duplicates[1] as any).value);
    const twice = (duplicates[0] as PromiseFulfilledResult<any>).value;
    const recoveries = await race(() => confirmCustomerCreditRecovery(actor.id, twice.id, recover()), () => confirmCustomerCreditRecovery(actor.id, twice.id, recover())); assert.equal(recoveries[0].status, "fulfilled"); assert.equal(recoveries[1].status, "rejected"); assert.equal((await balance(sameSource.i.id)).retainedCredit, 400);
    for (const payoutFirst of [true, false]) {
      const src = await source(); const result = payoutFirst
        ? await race(() => confirmCustomerCreditPayout(actor.id, pay(src)), () => reverseApprovedReturnRequest(src.r.id, actor.id, "Undo", randomUUID()))
        : await race(() => reverseApprovedReturnRequest(src.r.id, actor.id, "Undo", randomUUID()), () => confirmCustomerCreditPayout(actor.id, pay(src)), 1);
      assert.equal(result[0].status, "fulfilled"); assert.equal(result[1].status, "rejected");
    }
    // Source correction attempts reach the same invoice lock and active-payout guard.
    for (const action of ["CANCEL", "MODIFY"]) {
      const src = await source(), packet = pay(src);
      const result = await race(() => confirmCustomerCreditPayout(actor.id, packet), () => action === "CANCEL"
        ? cancelInvoice(src.i.id, actor.id, randomUUID())
        : modifyFinalizedInvoice(src.i.id, actor.id, { operationKey: randomUUID(), items: [{ productId: product.id, qty: 6 }], reason: "Competing source correction" }));
      assert.equal(result[0].status, "fulfilled"); assert.equal(result[1].status, "rejected");
      assert.match((result[1] as PromiseRejectedResult).reason.message, /Recover paid-out credit/);
      assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: src.i.id } })).status, "FINALIZED");
      assert.equal((await balance(src.i.id)).retainedCredit, 100);
      assert.equal(await prisma.invoiceCorrectionSettlement.count({ where: { sourceInvoiceId: src.i.id } }), 0);
    }
    for (const payoutFirst of [true, false]) {
      const d = await drawer(), src = await correctionSource(), packet = pay(src, d);
      const result = payoutFirst ? await race(() => confirmCustomerCreditPayout(actor.id, packet), () => closeCashDrawer(d.id, actor.id, "MANAGER", 900), 2, "CashDrawer")
        : await race(() => closeCashDrawer(d.id, actor.id, "MANAGER", 1000), () => confirmCustomerCreditPayout(actor.id, packet), 1, "CashDrawer");
      assert.equal(result[0].status, "fulfilled"); assert.equal(result[1].status, payoutFirst ? "fulfilled" : "rejected");
      assert.equal((await drawerRow(d)).cashOutTotal, payoutFirst ? 100 : 0);
      if (payoutFirst) {
        const out = (result[0] as PromiseFulfilledResult<any>).value, closed = await drawerRow(d);
        assert.deepEqual(await confirmCustomerCreditPayout(actor.id, packet), out);
        await confirmCustomerCreditRecovery(actor.id, out.id, recover(own)); assert.deepEqual(await drawerRow(d), closed);
      }
    }
    for (const recoveryFirst of [true, false]) {
      const d = await drawer(), src = await correctionSource(), out = await confirmCustomerCreditPayout(actor.id, pay(src, d)), packet = recover(d);
      const result = recoveryFirst ? await race(() => confirmCustomerCreditRecovery(actor.id, out.id, packet), () => closeCashDrawer(d.id, actor.id, "MANAGER", 1000), 2, "CashDrawer")
        : await race(() => closeCashDrawer(d.id, actor.id, "MANAGER", 900), () => confirmCustomerCreditRecovery(actor.id, out.id, packet), 1, "CashDrawer");
      assert.equal(result[0].status, "fulfilled"); assert.equal(result[1].status, recoveryFirst ? "fulfilled" : "rejected");
      assert.equal((await drawerRow(d)).cashInTotal, recoveryFirst ? 100 : 0); if (recoveryFirst) assert.deepEqual(await confirmCustomerCreditRecovery(actor.id, out.id, packet), (result[0] as any).value);
    }
    // Disjoint source+drawer locks overlap actual UNIQUE operation insert attempts.
    const u1 = await correctionSource(), u2 = await correctionSource(), d1 = await drawer(), d2 = await drawer(), uniqueKey = randomUUID();
    let inserted!: () => void, attempted!: () => void, release!: () => void, writes = 0;
    const insertedGate = new Promise<void>(r => inserted = r), attemptedGate = new Promise<void>(r => attempted = r), gate = new Promise<void>(r => release = r);
    prisma.$transaction = ((work: any, options: any) => original(async (tx: any) => work(new Proxy(tx, { get(target, field) {
      if (field === "customerCreditPayoutOperation") return { ...tx.customerCreditPayoutOperation, create: async (args: any) => {
        const ordinal = ++writes; if (ordinal === 2) attempted(); const row = await tx.customerCreditPayoutOperation.create(args); if (ordinal === 1) { inserted(); await gate; } return row;
      } }; return Reflect.get(target, field);
    } })), { ...options, timeout: 20000 })) as any;
    const winner = confirmCustomerCreditPayout(actor.id, pay(u1, d1, 100, uniqueKey)); await insertedGate;
    const loser = confirmCustomerCreditPayout(actor.id, pay(u2, d2, 100, uniqueKey)); await attemptedGate; release();
    const collision = await Promise.allSettled([winner, loser]); prisma.$transaction = original;
    assert.equal(writes, 2); assert.equal(collision[0].status, "fulfilled"); assert.equal(collision[1].status, "rejected");
    assert.equal(await prisma.customerCreditPayout.count({ where: { sourceInvoiceId: u2.i.id } }), 0); assert.equal((await drawerRow(d2)).cashOutTotal, 0); assert.equal(await prisma.cashDrawerEvent.count({ where: { drawerId: d2.id } }), 0);
    assert.equal((await balance(u2.i.id)).retainedCredit, 400);

    for (const action of ["PAYOUT", "RECOVER"]) {
      const src = await correctionSource(), d = await drawer(), packet = pay(src, d), out = action === "RECOVER" ? await confirmCustomerCreditPayout(actor.id, packet) : null, recovery = recover(d);
      const beforeDrawer = await drawerRow(d), beforeSource = await balance(src.i.id), beforeEvents = await prisma.cashDrawerEvent.count(), beforePayouts = await prisma.customerCreditPayout.count(), beforeAudit = await prisma.auditLog.count(); let staged = 0;
      // Fail after the real event+payout+audit and drawer update have been staged.
      prisma.$transaction = ((work: any, options: any) => original(async (tx: any) => work(new Proxy(tx, { get(target, field) {
        if (field === "customerCreditPayoutOperation") return { ...tx.customerCreditPayoutOperation, create: async (args: any) => {
          assert.equal(await tx.cashDrawerEvent.count(), beforeEvents + 1); assert.notDeepEqual(await tx.cashDrawer.findUniqueOrThrow({ where: { id: d.id } }), beforeDrawer);
          await tx.customerCreditPayoutOperation.create(args); staged++; throw Error("Injected after staged payout event drawer audit operation");
        } }; return Reflect.get(target, field);
      } })), options)) as any;
      await assert.rejects(action === "PAYOUT" ? confirmCustomerCreditPayout(actor.id, packet) : confirmCustomerCreditRecovery(actor.id, out!.id, recovery), /staged payout/); prisma.$transaction = original;
      assert.equal(staged, 1); assert.deepEqual(await drawerRow(d), beforeDrawer); assert.deepEqual(await balance(src.i.id), beforeSource);
      assert.equal(await prisma.cashDrawerEvent.count(), beforeEvents); assert.equal(await prisma.customerCreditPayout.count(), beforePayouts); assert.equal(await prisma.auditLog.count(), beforeAudit);
      assert.equal(await prisma.customerCreditPayoutOperation.count({ where: { operationKey: action === "PAYOUT" ? packet.operationKey : recovery.operationKey } }), 0);
      if (action === "PAYOUT") await confirmCustomerCreditPayout(actor.id, packet); else await confirmCustomerCreditRecovery(actor.id, out!.id, recovery);
    }
  } finally {
    prisma.$transaction = original;
    await prisma.customerCreditPayoutOperation.deleteMany({ where: { actorId: actor.id } }); await prisma.customerCreditPayout.deleteMany({ where: { actorId: actor.id } });
    await prisma.customerCreditOperation.deleteMany({ where: { actorId: actor.id } }); await prisma.customerCreditApplication.deleteMany({ where: { actorId: actor.id } });
    await prisma.cashDrawerEvent.deleteMany({ where: { drawerId: { in: drawers } } }); await prisma.cashDrawer.deleteMany({ where: { id: { in: drawers } } });
    await prisma.returnOperation.deleteMany({ where: { actorId: actor.id } }); await prisma.returnItem.deleteMany({ where: { returnRequest: { invoiceId: { in: invoices } } } }); await prisma.returnRequest.deleteMany({ where: { invoiceId: { in: invoices } } });
    await prisma.invoiceCorrectionSettlement.deleteMany({ where: { actorId: actor.id } }); await prisma.creditNote.deleteMany({ where: { createdById: actor.id } });
    await prisma.stockTransaction.deleteMany({ where: { createdById: actor.id } }); await prisma.payment.deleteMany({ where: { invoiceId: { in: invoices } } }); await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: invoices } } }); await prisma.invoice.deleteMany({ where: { id: { in: invoices } } });
    await prisma.auditLog.deleteMany({ where: { actorId: actor.id } }); await prisma.product.delete({ where: { id: product.id } }); await prisma.brand.delete({ where: { id: brand.id } }); await prisma.customer.deleteMany({ where: { id: { in: [customer.id, other.id] } } }); await prisma.user.deleteMany({ where: { id: { in: [actor.id, cashier.id] } } }); await prisma.$disconnect();
  }
});
