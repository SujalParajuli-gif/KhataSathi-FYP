import { confirmCustomerCreditPayout, confirmCustomerCreditRecovery } from "../modules/customers/cashPayouts";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
import prisma from "../db/prisma";
import { modifyFinalizedInvoice, cancelInvoice } from "../modules/invoices/service";
import { addPayment, voidPayment, createEsewaPaymentIntentTx } from "../modules/payments/service";
import { listCustomerReceivables } from "../modules/customers/receivables";
import { getCurrentCashDrawer } from "../modules/cash-drawers/service";
import { createReturnRequest, approveReturnRequest, reverseApprovedReturnRequest } from "../modules/returns/service";
import { applyCustomerCredit, reverseCustomerCredit } from "../modules/customers/creditApplications";
import { listAuditLogs } from "../modules/audit/service";

// Opt-in only: every mutation is restricted to this newly owned disposable target.
test("MySQL inherited credit restoration conserves source/receipts and serializes returns, spend, payout and reversal", { skip: process.env.KHATASATHI_INHERITED_CREDIT_MYSQL_TEST !== "1", timeout: 120000 }, async () => {
  const url = new URL(process.env.DATABASE_URL || "");
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname) && (url.port || "3306") === "3306" && url.pathname === "/ks_verify_inherited_credit_20261011");
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
  async function sale(paid = 400, customerId: string | null = customer.id, itemProduct = product.id) {
    const i = await prisma.invoice.create({ data: { invoiceNo: `CORRECT-${randomUUID()}`, cashierId: actor.id, customerId, status: "FINALIZED", finalizedAt: new Date(), netTotal: 1000, subTotal: 1000,
      paidTotal: paid, paymentStatus: paid >= 1000 ? "PAID" : paid > 0 ? "PARTIALLY_PAID" : "UNPAID",
      items: { create: { productId: itemProduct, qty: 10, appliedUnitPrice: 100, lineTotal: 1000, productNameSnapshot: "Historical correction item", productSkuSnapshot: "HIST-CORRECT", snapshotCapturedAt: new Date() } },
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
  async function funded(paid = 400, itemProduct = product.id) {
    const source = await sale(paid, customer.id, itemProduct);
    const changed = await replace(source, { ...input(10), items: [{ productId: itemProduct, qty: 10 }] });
    await addPayment(changed.replacementInvoice.id, "CASH", 400, "SUCCESS", actor.id);
    const child = await prisma.invoice.findUniqueOrThrow({ where: { id: changed.replacementInvoice.id }, include: { items: true } });
    const correction = await prisma.invoiceCorrectionSettlement.findUniqueOrThrow({ where: { sourceInvoiceId: source.id } });
    return { source, child, correction };
  }
  async function request(child: any, qty: number) {
    return createReturnRequest(actor.id, { invoiceId: child.id, operationKey: randomUUID(), reason: "CUSTOMER_REQUEST", items: [{ invoiceItemId: child.items[0].id, qty }] });
  }
  async function approve(child: any, qty: number) { const r = await request(child, qty); await approveReturnRequest(r.id, actor.id, randomUUID()); return r; }
  const apply = (f: any, target: any, amount: number) => applyCustomerCredit(actor.id, { sourceCorrectionId: f.correction.id, targetInvoiceId: target.id, amount, reason: "Restored inherited credit", operationKey: randomUUID() });
  try {
    const f = await funded(), receiptRows = await prisma.payment.findMany({ where: { invoiceId: { in: [f.source.id, f.child.id] } }, orderBy: { id: "asc" } }), cash = await prisma.cashDrawerEvent.count();
    assert.equal((await balance(f.child.id)).due, 200);
    const r = await request(f.child, 5), key = randomUUID();
    const approved = await approveReturnRequest(r.id, actor.id, key);
    assert.deepEqual([approved.settlement.version, approved.settlement.debtReduction, approved.settlement.restoredCredit, approved.settlement.retainedCredit], [3,200,300,0]);
    assert.deepEqual([(await balance(f.child.id)).due, (await balance(f.child.id)).correctionCredit, (await balance(f.source.id)).retainedCredit], [0,100,300]);
    assert.deepEqual(await prisma.payment.findMany({ where: { invoiceId: { in: [f.source.id, f.child.id] } }, orderBy: { id: "asc" } }), receiptRows);
    assert.equal(await prisma.cashDrawerEvent.count(), cash);
    assert.deepEqual(await prisma.invoiceCorrectionSettlement.findUniqueOrThrow({ where: { id: f.correction.id } }), f.correction);
    assert.deepEqual(await approveReturnRequest(r.id, actor.id, key), approved);
    await assert.rejects(voidPayment(f.child.id, receiptRows.find(p => p.invoiceId === f.child.id)!.id, actor.id), /adjusted return/);
    const target = await sale(0), app = await apply(f, target, 200);
    await assert.rejects(reverseApprovedReturnRequest(r.id, actor.id, "Restore original", randomUUID()), /restored original credit/);
    await reverseCustomerCredit(actor.id, app.id, { reason: "Release source budget", operationKey: randomUUID() });
    const out = await confirmCustomerCreditPayout(actor.id, { sourceCorrectionId: f.correction.id, drawerId: drawer.id, amount: 100, reason: "Actual new cash payout", operationKey: randomUUID(), cashConfirmed: true, newPayoutConfirmed: true });
    await assert.rejects(reverseApprovedReturnRequest(r.id, actor.id, "Restore original", randomUUID()), /restored original credit/);
    await confirmCustomerCreditRecovery(actor.id, out.id, { drawerId: drawer.id, reason: "Actual full cash recovered", operationKey: randomUUID(), cashReceivedConfirmed: true });
    await reverseApprovedReturnRequest(r.id, actor.id, "Restore original", randomUUID());
    assert.equal((await balance(f.source.id)).retainedCredit, 0); assert.equal((await balance(f.child.id)).due, 200);
    assert.deepEqual(await approveReturnRequest(r.id, actor.id, key), approved); // Immutable approved replay after reversal.

    const full = await funded(); const fullReturn = await approve(full.child, 8);
    assert.deepEqual([(await balance(full.source.id)).retainedCredit,(await balance(full.child.id)).retainedCredit,(await balance(full.child.id)).due], [400,200,0]);
    const childCredit = await applyCustomerCredit(actor.id, { sourceReturnId: fullReturn.id, targetInvoiceId: (await sale(0)).id, amount: 100, reason: "Own receipt credit only", operationKey: randomUUID() });
    await assert.rejects(reverseApprovedReturnRequest(fullReturn.id, actor.id, "Reverse", randomUUID()), /active credit/);
    await reverseCustomerCredit(actor.id, childCredit.id, { reason: "Restore own credit", operationKey: randomUUID() });
    await reverseApprovedReturnRequest(fullReturn.id, actor.id, "Reverse", randomUUID());
    const multiple = await funded(); const m1 = await approve(multiple.child, 3), m2 = await approve(multiple.child, 5);
    assert.equal((await balance(multiple.source.id)).retainedCredit, 400); assert.equal((await balance(multiple.child.id)).retainedCredit, 200);
    await assert.rejects(reverseApprovedReturnRequest(m1.id, actor.id, "Order", randomUUID()), /later approved/);
    await reverseApprovedReturnRequest(m2.id, actor.id, "Order", randomUUID()); assert.equal((await balance(multiple.source.id)).retainedCredit, 100);
    await reverseApprovedReturnRequest(m1.id, actor.id, "Order", randomUUID());
    const fraction = await funded(400.55); await approve(fraction.child, 5);
    assert.equal((await balance(fraction.source.id)).retainedCredit, 300.55); assert.equal((await balance(fraction.child.id)).correctionCredit, 100);

    const cancelled = await funded(), cancelKey = randomUUID(), originalCapture = cancelled.correction;
    const result = await cancelInvoice(cancelled.child.id, actor.id, cancelKey);
    assert.equal(result.paymentStatus, "CANCELLED"); assert.deepEqual([(await balance(cancelled.source.id)).retainedCredit,(await balance(cancelled.child.id)).retainedCredit], [400,400]);
    assert.deepEqual(await prisma.invoiceCorrectionSettlement.findUniqueOrThrow({ where: { id: originalCapture.id } }), originalCapture);
    await apply(cancelled, await sale(0), 250); assert.deepEqual(await cancelInvoice(cancelled.child.id, actor.id, cancelKey), result);
    await assert.rejects(modifyFinalizedInvoice(cancelled.child.id, actor.id, input()), /Cancelled/);
    const fundedApplication = await funded(), otherSource = await sale(400); await cancelInvoice(otherSource.id, actor.id, randomUUID());
    const otherCorrection = await prisma.invoiceCorrectionSettlement.findUniqueOrThrow({ where: { sourceInvoiceId: otherSource.id } });
    await applyCustomerCredit(actor.id, { sourceCorrectionId: otherCorrection.id, targetInvoiceId: fundedApplication.child.id, amount: 100, reason: "Extra source", operationKey: randomUUID() });
    await assert.rejects(request(fundedApplication.child, 5), /incoming credit/);
    await assert.rejects(cancelInvoice(fundedApplication.child.id, actor.id, randomUUID()), /active credit/);
    const bad = await funded(); await prisma.invoice.update({ where: { id: bad.child.id }, data: { correctionCreditReleased: 1 } }); await assert.rejects(request(bad.child, 5), /reconcile/);

    const rf = await funded(), rr = await approve(rf.child, 5), rt = await sale(0);
    const reversedFirst = await race(() => reverseApprovedReturnRequest(rr.id, actor.id, "Reverse first", randomUUID()), () => apply(rf, rt, 200));
    assert.equal(reversedFirst[0].status,"fulfilled"); assert.equal(reversedFirst[1].status,"rejected"); assert.equal((await balance(rf.source.id)).retainedCredit,0);
    const sf = await funded(), sr = await approve(sf.child,5), st = await sale(0);
    const spendFirst = await race(() => apply(sf,st,200), () => reverseApprovedReturnRequest(sr.id,actor.id,"Spend first",randomUUID()));
    assert.equal(spendFirst[0].status,"fulfilled"); assert.equal(spendFirst[1].status,"rejected"); assert.equal((await balance(sf.source.id)).retainedCredit,100);
    const pf = await funded(), pr = await approve(pf.child,5);
    const payoutFirst = await race(() => confirmCustomerCreditPayout(actor.id,{sourceCorrectionId:pf.correction.id,drawerId:drawer.id,amount:100,reason:"Actual payout wins",operationKey:randomUUID(),cashConfirmed:true,newPayoutConfirmed:true}), () => reverseApprovedReturnRequest(pr.id,actor.id,"Payout wins",randomUUID()));
    assert.equal(payoutFirst[0].status,"fulfilled"); assert.equal(payoutFirst[1].status,"rejected");
    const cf = await funded(), cr = await request(cf.child,5);
    const approveFirst = await race(() => approveReturnRequest(cr.id,actor.id,randomUUID()), () => cancelInvoice(cf.child.id,actor.id,randomUUID()));
    assert.equal(approveFirst[0].status,"fulfilled"); assert.equal(approveFirst[1].status,"rejected");
    const pay = await funded(), payRequest = await request(pay.child,5);
    const payFirst = await race(() => addPayment(pay.child.id,"CASH",100,"SUCCESS",actor.id), () => approveReturnRequest(payRequest.id,actor.id,randomUUID()));
    assert.equal(payFirst[0].status,"fulfilled"); assert.equal(payFirst[1].status,"fulfilled"); assert.equal((await balance(pay.source.id)).retainedCredit,400);
    const returnFirst = await funded(), returnFirstRequest = await request(returnFirst.child,5);
    const settledFirst = await race(() => approveReturnRequest(returnFirstRequest.id,actor.id,randomUUID()), () => addPayment(returnFirst.child.id,"CASH",100,"SUCCESS",actor.id), 2);
    assert.equal(settledFirst[0].status,"fulfilled"); assert.equal(settledFirst[1].status,"rejected");

    console.log("Scenario const reverseWins");
    const reverseWins = await funded(), reverseWinsReturn = await approve(reverseWins.child,5);
    const restoreBeforePayout = await race(() => reverseApprovedReturnRequest(reverseWinsReturn.id,actor.id,"Reverse before payout",randomUUID()), () => confirmCustomerCreditPayout(actor.id,{sourceCorrectionId:reverseWins.correction.id,drawerId:drawer.id,amount:100,reason:"Payout after reversal",operationKey:randomUUID(),cashConfirmed:true,newPayoutConfirmed:true}));
    assert.equal(restoreBeforePayout[0].status,"fulfilled"); assert.equal(restoreBeforePayout[1].status,"rejected");
    console.log("Scenario const cancelWins");
    const cancelWins = await funded();
    const cancelBeforeReturn = await race(() => cancelInvoice(cancelWins.child.id,actor.id,randomUUID()), () => request(cancelWins.child,5),2);
    assert.equal(cancelBeforeReturn[0].status,"fulfilled"); assert.equal(cancelBeforeReturn[1].status,"rejected");
    console.log("Scenario const duplicate =");
    const duplicate = await funded(), duplicateReturn = await request(duplicate.child,5), duplicateKey=randomUUID();
    const duplicateApproval = await race(() => approveReturnRequest(duplicateReturn.id,actor.id,duplicateKey),()=>approveReturnRequest(duplicateReturn.id,actor.id,duplicateKey),2);
    assert.equal(duplicateApproval[0].status,"fulfilled"); assert.equal(duplicateApproval[1].status,"fulfilled");
    assert.deepEqual((duplicateApproval[0] as PromiseFulfilledResult<any>).value,(duplicateApproval[1] as PromiseFulfilledResult<any>).value);
    assert.equal((await balance(duplicate.source.id)).retainedCredit,300); assert.equal(await prisma.stockTransaction.count({where:{refInvoiceId:duplicate.child.id,type:"RESTOCK"}}),1);
    console.log("Scenario const uniqueLeft");
    const separateProduct=await prisma.product.create({data:{name:"Owned disjoint unique item",sku:randomUUID(),brandId:brand.id,stock:100,retailPrice:100,wholesalePrice:100,wholesaleEligible:false}});
    const uniqueLeft=await funded(), uniqueRight=await funded(400,separateProduct.id), uniqueL=await request(uniqueLeft.child,5), uniqueR=await request(uniqueRight.child,5), sharedKey=randomUUID();
    let inserted!:()=>void,attempted!:()=>void,release!:()=>void,entries=0;
    const firstInserted=new Promise<void>(r=>inserted=r),secondAttempted=new Promise<void>(r=>attempted=r),gate=new Promise<void>(r=>release=r);
    prisma.$transaction=((work:any,opts:any)=>original(async(tx:any)=>work(new Proxy(tx,{get(target,field){
      if(field === "returnOperation")return {...tx.returnOperation,create:async(args:any)=>{const n=++entries;if(n===2)attempted();const result=await tx.returnOperation.create(args);if(n===1){inserted();await gate;}return result;}};
      return Reflect.get(target,field);
    }})),{...opts,timeout:20000})) as any;
    const winner=approveReturnRequest(uniqueL.id,actor.id,sharedKey);await firstInserted;const loser=approveReturnRequest(uniqueR.id,actor.id,sharedKey);await secondAttempted;release();
    const collision=await Promise.allSettled([winner,loser]);prisma.$transaction=original;
    assert.equal(entries,2);assert.equal(collision[0].status,"fulfilled");assert.equal(collision[1].status,"rejected");
    assert.equal((await prisma.returnRequest.findUniqueOrThrow({where:{id:uniqueR.id}})).status,"PENDING");assert.equal((await balance(uniqueRight.source.id)).retainedCredit,0);assert.equal((await balance(uniqueRight.child.id)).due,200);
    assert.equal(await prisma.stockTransaction.count({where:{refInvoiceId:uniqueRight.child.id,type:"RESTOCK"}}),0);

    console.log("Scenario for (const action");
    for (const action of ["APPROVE","REVERSE","CANCEL"]) {
      const fault = await funded(), req = action === "CANCEL" ? null : await request(fault.child,5);
      if(action === "REVERSE") await approveReturnRequest(req!.id,actor.id,randomUUID());
      const beforeChild = await prisma.invoice.findUniqueOrThrow({where:{id:fault.child.id}}), beforeSource=await balance(fault.source.id), beforeStock=await prisma.product.findUniqueOrThrow({where:{id:product.id}}), audit=await prisma.auditLog.count();
      let staged=0; const operationKey=randomUUID();
      prisma.$transaction=((work:any,opts:any)=>original(async(tx:any)=>work(new Proxy(tx,{get(target,field){
        if(field === "auditLog")return {...tx.auditLog,create:async(args:any)=>{const row=await tx.auditLog.create(args); if(args.data.action === (action === "CANCEL" ? "INVOICE_CANCELLED" : "RETURN_REQUEST_"+action+"D")) { assert.notDeepEqual(await tx.invoice.findUniqueOrThrow({where:{id:fault.child.id}}),beforeChild); assert.notDeepEqual(await tx.product.findUniqueOrThrow({where:{id:product.id}}),beforeStock); staged++; throw Error("Injected staged inherited credit audit failure"); } return row;}};
        return Reflect.get(target,field);
      }})),opts)) as any;
      const invoke=()=>action === "CANCEL" ? cancelInvoice(fault.child.id,actor.id,operationKey) : action === "APPROVE" ? approveReturnRequest(req!.id,actor.id,operationKey) : reverseApprovedReturnRequest(req!.id,actor.id,"Fault retry",operationKey);
      await assert.rejects(invoke(),/staged inherited/); prisma.$transaction=original; assert.equal(staged,1);
      assert.deepEqual(await prisma.invoice.findUniqueOrThrow({where:{id:fault.child.id}}),beforeChild); assert.deepEqual(await balance(fault.source.id),beforeSource); assert.deepEqual(await prisma.product.findUniqueOrThrow({where:{id:product.id}}),beforeStock); assert.equal(await prisma.auditLog.count(),audit);
      assert.equal(await prisma.returnOperation.count({where:{operationKey}}),0); assert.equal(await prisma.invoiceCorrectionSettlement.count({where:{operationKey}}),0); await invoke();
    }
  } finally {
    prisma.$transaction = original;
    const ownedInvoices = await prisma.invoice.findMany({ where: { cashierId: actor.id }, select: { id: true } }); const ids = ownedInvoices.map(i => i.id);
    await prisma.customerCreditPayoutOperation.deleteMany({ where: { actorId: actor.id } }); await prisma.customerCreditPayout.deleteMany({ where: { actorId: actor.id } });
    await prisma.cashDrawerEvent.deleteMany({ where: { createdById: actor.id } });
    await prisma.customerCreditOperation.deleteMany({ where: { actorId: actor.id } }); await prisma.customerCreditApplication.deleteMany({ where: { actorId: actor.id } });
    await prisma.returnOperation.deleteMany({ where: { actorId: actor.id } }); await prisma.returnItem.deleteMany({ where: { returnRequest: { invoiceId: { in: ids } } } }); await prisma.returnRequest.deleteMany({ where: { invoiceId: { in: ids } } });
    await prisma.invoiceCorrectionSettlement.deleteMany({ where: { actorId: actor.id } }); await prisma.creditNote.deleteMany({ where: { createdById: actor.id } });
    await prisma.stockTransaction.deleteMany({ where: { createdById: actor.id } }); await prisma.payment.deleteMany({ where: { invoiceId: { in: ids } } }); await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: ids } } }); await prisma.invoice.deleteMany({ where: { id: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: actor.id } }); await prisma.cashDrawer.delete({ where: { id: drawer.id } }); await prisma.product.deleteMany({ where: { brandId: brand.id } }); await prisma.brand.delete({ where: { id: brand.id } }); await prisma.customer.deleteMany({ where: { id: { in: [customer.id, other.id] } } }); await prisma.user.deleteMany({ where: { id: { in: [actor.id, cashier.id] } } }); await prisma.$disconnect();
  }
});

