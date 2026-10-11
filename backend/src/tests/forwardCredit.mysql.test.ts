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
test("MySQL one subsequent replacement preserves original and own funding with actual reconciliation, races and rollback", { skip: process.env.KHATASATHI_FORWARD_CREDIT_MYSQL_TEST !== "1", timeout: 120000 }, async () => {
  const url = new URL(process.env.DATABASE_URL || "");
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname) && (url.port || "3306") === "3306" && url.pathname === "/ks_verify_mixed_credit_20261011");
  const original = prisma.$transaction.bind(prisma), suffix = randomUUID();
  await prisma.businessSettings.upsert({ where: { id: 1 }, create: { id: 1, businessMode: "FULL_POS", loyaltyDiscountPercent: 0 }, update: { businessMode: "FULL_POS", loyaltyDiscountPercent: 0 } });
  const actor = await prisma.user.create({ data: { name: "Owned correction actor", phone: `+97798${randomInt(10000000,99999999)}`, passwordHash: "unusable", role: "ADMIN" } });
  const cashier = await prisma.user.create({ data: { name: "Owned correction cashier", phone: `+97797${randomInt(10000000,99999999)}`, passwordHash: "unusable", role: "CASHIER" } });
  const customer = await prisma.customer.create({ data: { name: `Owned correction ${suffix}`, loyaltyPercent: 0, wholesalePercent: 0 } });
  const other = await prisma.customer.create({ data: { name: `Owned other ${suffix}`, loyaltyPercent: 0, wholesalePercent: 0 } });
  const brand = await prisma.brand.create({ data: { name: `Owned correction ${suffix}` } });
  const product = await prisma.product.create({ data: { name: "Owned correction item", sku: `CORRECT-${suffix}`, brandId: brand.id, stock: 1000, retailPrice: 100, wholesalePrice: 100, wholesaleEligible: false, allowFractionalQty: true, quantityStep: 0.5 } });
  const invoices: string[] = [];
  const drawer = await prisma.cashDrawer.create({ data: { cashierId: actor.id, openingFloat: 0, status: "OPEN" } });
  async function sale(paid = 400, customerId: string | null = customer.id, itemProduct = product.id) {
    const i = await prisma.invoice.create({ data: { invoiceNo: `CORRECT-${randomUUID()}`, cashierId: actor.id, customerId, status: "FINALIZED", finalizedAt: new Date(), netTotal: 1000, subTotal: 1000,
      paidTotal: paid, paymentStatus: paid >= 1000 ? "PAID" : paid > 0 ? "PARTIALLY_PAID" : "UNPAID",
      items: { create: { productId: itemProduct, qty: 10, appliedUnitPrice: 100, lineTotal: 1000, productNameSnapshot: "Historical correction item", productSkuSnapshot: "HIST-CORRECT", snapshotCapturedAt: new Date() } },
      ...(paid ? { payments: { create: { method: "CASH", amount: paid, kind: "CHARGE", status: "SUCCESS", createdById: actor.id } } } : {}) }, include: { items: true } });
    invoices.push(i.id); return i;
  }
  async function race(first: () => Promise<any>, second: () => Promise<any>, firstLocks = 1) {
    let held!: () => void, attempted!: () => void, release!: () => void, transactions = 0, firstCount = 0, attempts = 0;
    const heldInvoices=new Set<string>();
    const a = new Promise<void>(r => held = r), b = new Promise<void>(r => attempted = r), gate = new Promise<void>(r => release = r);
    prisma.$transaction = ((work: any, opts: any) => original(async (tx: any) => {
      const ordinal = ++transactions;
      return work(new Proxy(tx, { get(target, key) {
        if (key === "$queryRaw") return async (query: TemplateStringsArray, ...values: any[]) => {
          const isLock = /FROM Invoice\s/.test(query.join(" ")) && query.join(" ").includes("FOR UPDATE");
          if (isLock && ordinal === 2 && heldInvoices.has(String(values[0]))) { attempts++; attempted(); }
          const result = await tx.$queryRaw(query, ...values);
          if(isLock && ordinal === 1) heldInvoices.add(String(values[0]));
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


  async function initial(inherited=400,own=200) {
    const a=await sale(inherited);
    const first=await modifyFinalizedInvoice(a.id,actor.id,{operationKey:randomUUID(),items:[{productId:product.id,qty:10}]});
    if(own)await addPayment(first.replacementInvoice.id,"CASH",own,"SUCCESS",actor.id);
    const b=await prisma.invoice.findUniqueOrThrow({where:{id:first.replacementInvoice.id},include:{items:true}});
    const parent=await prisma.invoiceCorrectionSettlement.findUniqueOrThrow({where:{sourceInvoiceId:a.id}});
    return {a,b,parent};
  }
  async function forward(f:any,qty=7.5,key=randomUUID()) {
    const input={operationKey:key,items:[{productId:product.id,qty}]};
    const result=await modifyFinalizedInvoice(f.b.id,actor.id,input);
    const c=await prisma.invoice.findUniqueOrThrow({where:{id:result.replacementInvoice.id},include:{items:true}});
    const own=await prisma.invoiceCorrectionSettlement.findUniqueOrThrow({where:{sourceInvoiceId:f.b.id}});
    return {...f,c,own,result,input};
  }
  async function request(c:any,qty:number) {return createReturnRequest(actor.id,{invoiceId:c.id,operationKey:randomUUID(),reason:"CUSTOMER_REQUEST",items:[{invoiceItemId:c.items[0].id,qty}]});}
  async function returned(f:any,qty:number) {const r=await request(f.c,qty);await approveReturnRequest(r.id,actor.id,randomUUID());return r;}
  async function balance(id:string) {const row=(await listCustomerReceivables({q:customer.name},"ADMIN")).items[0].invoices.find(i=>i.invoiceId===id)!;assert.equal(row.reason,null,`${id}: ${row.reason}`);return row;}
  const reverse=(r:any,key=randomUUID())=>reverseApprovedReturnRequest(r.id,actor.id,"Restore forwarded funding",key);
  try {
    const before=await initial(),notes=await prisma.creditNote.findMany({where:{originalInvoiceId:before.a.id}}),receipts=await prisma.payment.findMany({where:{invoiceId:{in:[before.a.id,before.b.id]}},orderBy:{id:"asc"}}),cash=await prisma.cashDrawerEvent.count({where:{createdById:actor.id}});
    const f=await forward(before);
    assert.deepEqual([f.c.creditApplied,f.c.correctionCredit,f.c.paidTotal,f.own.recordedReceipts,f.own.transferredCredit,f.own.retainedCredit],[400,200,0,200,200,0]);
    assert.equal((f.own.inheritedFunding as any).version,4);assert.equal(f.result.creditNote.originalPaidTotal,200);assert.equal(f.result.creditNote.creditedAmount,200);
    assert.deepEqual(f.result.carriedCredit,{ownReceipts:200,originalCredit:400});
    assert.deepEqual(await modifyFinalizedInvoice(f.b.id,actor.id,f.input),f.result);
    await assert.rejects(modifyFinalizedInvoice(f.b.id,actor.id,{...f.input,reason:"Changed replay"}),/conflicts/);
    assert.deepEqual(await prisma.creditNote.findMany({where:{originalInvoiceId:before.a.id}}),notes);
    assert.deepEqual(await prisma.payment.findMany({where:{invoiceId:{in:[before.a.id,before.b.id]}},orderBy:{id:"asc"}}),receipts);
    assert.equal(await prisma.payment.count({where:{invoiceId:f.c.id}}),0);assert.equal(await prisma.cashDrawerEvent.count({where:{createdById:actor.id}}),cash);
    assert.deepEqual([(await balance(f.a.id)).retainedCredit,(await balance(f.b.id)).retainedCredit,(await balance(f.c.id)).due],[0,0,150]);
    const r=await returned(f,5);let settled=(await prisma.returnRequest.findUniqueOrThrow({where:{id:r.id}})).settlement as any;
    assert.deepEqual([settled.version,settled.debtReduction,settled.applications[0].released,settled.restoredCredit,settled.retainedCredit],[5,150,350,0,0]);
    assert.deepEqual([(await balance(f.a.id)).retainedCredit,(await balance(f.b.id)).retainedCredit,(await balance(f.c.id)).due],[350,0,0]);await reverse(r);
    const both=await forward(await initial()),br=await returned(both,7);
    assert.deepEqual([(await balance(both.a.id)).retainedCredit,(await balance(both.b.id)).retainedCredit,(await balance(both.c.id)).due],[400,150,0]);
    const sink=await sale(0),used=await applyCustomerCredit(actor.id,{sourceCorrectionId:both.own.id,targetInvoiceId:sink.id,amount:100,reason:"Use intermediate own receipts",operationKey:randomUUID()});
    await assert.rejects(reverse(br),/every original credit source/);await reverseCustomerCredit(actor.id,used.id,{reason:"Release spending",operationKey:randomUUID()});
    const payout=await confirmCustomerCreditPayout(actor.id,{sourceCorrectionId:both.own.id,drawerId:drawer.id,amount:100,reason:"Actual owned cash payout",operationKey:randomUUID(),cashConfirmed:true,newPayoutConfirmed:true});
    await assert.rejects(reverse(br),/every original credit source/);await confirmCustomerCreditRecovery(actor.id,payout.id,{drawerId:drawer.id,reason:"Actual owned cash recovery",operationKey:randomUUID(),cashReceivedConfirmed:true});await reverse(br);
    const canceled=await forward(await initial());await cancelInvoice(canceled.c.id,actor.id,randomUUID());assert.deepEqual([(await balance(canceled.a.id)).retainedCredit,(await balance(canceled.b.id)).retainedCredit,(await balance(canceled.c.id)).retainedCredit],[400,200,0]);
    const own=await forward(await initial());await addPayment(own.c.id,"CASH",100,"SUCCESS",actor.id);await returned(own,7);assert.deepEqual([(await balance(own.a.id)).retainedCredit,(await balance(own.b.id)).retainedCredit,(await balance(own.c.id)).retainedCredit],[400,200,50]);
    for(const [inherited,ownPaid] of [[400,0],[0,200],[0,0],[400.25,199.5]]) {
      const zero=await forward(await initial(inherited,ownPaid));assert.equal((await balance(zero.c.id)).due,750-inherited-ownPaid);
      assert.equal(await prisma.customerCreditApplication.count({where:{targetInvoiceId:zero.c.id}}),inherited ? 1 : 0);
      await cancelInvoice(zero.c.id,actor.id,randomUUID());assert.equal((await balance(zero.a.id)).retainedCredit,inherited);assert.equal((await balance(zero.b.id)).retainedCredit,ownPaid);
    }
    const reversed=await forward(await initial()),mapping=(reversed.own.inheritedFunding as any);
    await reverseCustomerCredit(actor.id,mapping.applicationId,{reason:"Explicitly reverse original carry",operationKey:randomUUID()});await cancelInvoice(reversed.c.id,actor.id,randomUUID());assert.equal((await balance(reversed.a.id)).retainedCredit,400);assert.equal((await balance(reversed.b.id)).retainedCredit,200);
    const zeroOwn=await forward(await initial(400,0));await returned(zeroOwn,7.5);assert.equal((await balance(zeroOwn.a.id)).retainedCredit,400);assert.equal((await balance(zeroOwn.b.id)).retainedCredit,0);
    await prisma.product.update({where:{id:product.id},data:{retailPrice:100.06,wholesalePrice:100.06}});
    const rounded=await forward(await initial(400.25,199.75),6);assert.equal(rounded.c.subTotal,600.36);assert.equal(rounded.c.netTotal,600);assert.equal(rounded.c.paymentStatus,"PAID");assert.equal((await balance(rounded.c.id)).due,0);
    await cancelInvoice(rounded.c.id,actor.id,randomUUID());assert.equal((await balance(rounded.a.id)).retainedCredit,400.25);assert.equal((await balance(rounded.b.id)).retainedCredit,199.75);
    await prisma.product.update({where:{id:product.id},data:{retailPrice:100,wholesalePrice:100}});
    const residualA=await sale(1000),residualFirst=await modifyFinalizedInvoice(residualA.id,actor.id,{operationKey:randomUUID(),items:[{productId:product.id,qty:5}]}),residualB=await prisma.invoice.findUniqueOrThrow({where:{id:residualFirst.replacementInvoice.id},include:{items:true}}),residualParent=await prisma.invoiceCorrectionSettlement.findUniqueOrThrow({where:{sourceInvoiceId:residualA.id}}),residualSink=await sale(0);
    await applyCustomerCredit(actor.id,{sourceCorrectionId:residualParent.id,targetInvoiceId:residualSink.id,amount:100,reason:"Use original retained portion before forwarding fixed portion",operationKey:randomUUID()});
    const residual=await forward({a:residualA,b:residualB,parent:residualParent});assert.equal((await balance(residual.a.id)).retainedCredit,400);assert.equal((await balance(residual.c.id)).due,250);await returned(residual,7);assert.equal((await balance(residual.a.id)).retainedCredit,850);
    const nestedSource=await forward(await initial()),nr=await returned(nestedSource,7),nestedTarget=await sale(0);
    await applyCustomerCredit(actor.id,{sourceCorrectionId:nestedSource.own.id,targetInvoiceId:nestedTarget.id,amount:100,reason:"Spend restored own source on a returnable sale",operationKey:randomUUID()});
    const nestedReturn=await request(nestedTarget,10);await approveReturnRequest(nestedReturn.id,actor.id,randomUUID());assert.equal((await balance(nestedSource.b.id)).retainedCredit,150);await reverse(nr);
    const canceledSource=await forward(await initial());await cancelInvoice(canceledSource.c.id,actor.id,randomUUID());const cancelTarget=await sale(0);
    await applyCustomerCredit(actor.id,{sourceCorrectionId:canceledSource.own.id,targetInvoiceId:cancelTarget.id,amount:100,reason:"Restored own source on cancelable sale",operationKey:randomUUID()});await cancelInvoice(cancelTarget.id,actor.id,randomUUID());assert.equal((await balance(canceledSource.b.id)).retainedCredit,200);
    const lower=await initial();await assert.rejects(forward(lower,5),/cover all/);assert.equal((await prisma.invoice.findUniqueOrThrow({where:{id:lower.b.id}})).correctionCreditReleased,0);
    await assert.rejects(modifyFinalizedInvoice(lower.b.id,actor.id,{operationKey:randomUUID(),customerId:other.id,items:[{productId:product.id,qty:8}]}),/same named customer/);
    await assert.rejects(modifyFinalizedInvoice(f.c.id,actor.id,{operationKey:randomUUID(),items:[{productId:product.id,qty:8}]}),/credit applications|original credit source/);
    for(const paymentFirst of [true,false]) {
      const pf=await initial(),pay=()=>addPayment(pf.b.id,"CASH",100,"SUCCESS",actor.id),replace=()=>forward(pf);
      const outcomes=paymentFirst ? await race(pay,replace) : await race(replace,pay,2);
      assert.equal(outcomes[0].status,"fulfilled");assert.equal(outcomes[1].status,paymentFirst ? "fulfilled" : "rejected");
      const result=(outcomes[paymentFirst ? 1 : 0] as PromiseFulfilledResult<any>).value;assert.equal((await balance(result.c.id)).due,paymentFirst ? 50 : 150);
    }
    for(const returnFirst of [true,false]) {
      const rf=await initial(),ask=()=>request(rf.b,1),replace=()=>forward(rf);
      const outcomes=returnFirst ? await race(ask,replace,2) : await race(replace,ask,2);
      assert.equal(outcomes[0].status,"fulfilled");assert.equal(outcomes[1].status,"rejected");
    }
    for(const originalSource of [true,false])for(const reverseFirst of [true,false])for(const cashPayout of [true,false]) {
      const rf=await forward(await initial()),rr=await returned(rf,7),sink=await sale(0),sourceCorrectionId=originalSource ? rf.parent.id : rf.own.id;
      const consume=()=>cashPayout ? confirmCustomerCreditPayout(actor.id,{sourceCorrectionId,drawerId:drawer.id,amount:50,reason:"Actual forwarded source payout",operationKey:randomUUID(),cashConfirmed:true,newPayoutConfirmed:true}) : applyCustomerCredit(actor.id,{sourceCorrectionId,targetInvoiceId:sink.id,amount:50,reason:"Use forwarded source",operationKey:randomUUID()});
      const outcomes=reverseFirst ? await race(()=>reverse(rr),consume,3) : await race(consume,()=>reverse(rr),cashPayout ? 1 : 2);
      assert.equal(outcomes[0].status,"fulfilled");assert.equal(outcomes[1].status,"rejected");
    }
    const duplicate=await initial(),duplicateKey=randomUUID();const duplicateResult=await race(()=>forward(duplicate,7.5,duplicateKey),()=>forward(duplicate,7.5,duplicateKey),2);
    assert.ok(duplicateResult.every(r=>r.status==="fulfilled"));assert.deepEqual((duplicateResult[0] as PromiseFulfilledResult<any>).value.result,(duplicateResult[1] as PromiseFulfilledResult<any>).value.result);

    for(const action of ["FORWARD","APPROVE","REVERSE","CANCEL"]) {
      const fixture=action==="FORWARD" ? await initial() : await forward(await initial());const ff=fixture as any;
      const r=action==="APPROVE" || action==="REVERSE" ? await request(ff.c,7) : null;if(action==="REVERSE")await approveReturnRequest(r!.id,actor.id,randomUUID());
      const ids=[ff.a.id,ff.b.id,...(ff.c ? [ff.c.id] : [])];
      const originalInvoices=await prisma.invoice.findMany({where:{id:{in:ids}},orderBy:{id:"asc"}}),originalApps=await prisma.customerCreditApplication.findMany({where:{actorId:actor.id},orderBy:{id:"asc"}}),stock=await prisma.product.findUniqueOrThrow({where:{id:product.id}}),audit=await prisma.auditLog.count({where:{actorId:actor.id}}),invoiceCount=await prisma.invoice.count({where:{cashierId:actor.id}});let staged=0;const op=randomUUID();
      const event=action==="FORWARD" ? "CUSTOMER_CREDIT_CORRECTION_RECORDED" : action==="CANCEL" ? "INVOICE_CANCELLED" : "RETURN_REQUEST_"+action+"D";
      prisma.$transaction=((work:any,opts:any)=>original(async(tx:any)=>work(new Proxy(tx,{get(target,field){if(field==="auditLog")return {...tx.auditLog,create:async(args:any)=>{const row=await tx.auditLog.create(args);if(args.data.action===event){assert.notDeepEqual(await tx.invoice.findMany({where:{id:{in:ids}},orderBy:{id:"asc"}}),originalInvoices);assert.notDeepEqual(await tx.customerCreditApplication.findMany({where:{actorId:actor.id},orderBy:{id:"asc"}}),originalApps);assert.notDeepEqual(await tx.product.findUniqueOrThrow({where:{id:product.id}}),stock);if(action==="FORWARD"){assert.equal((await tx.invoice.findUniqueOrThrow({where:{id:ff.b.id}})).paymentStatus,"CANCELLED");assert.equal(await tx.invoiceCorrectionSettlement.count({where:{operationKey:op}}),1);}staged++;throw Error("Injected staged forwarding rollback");}return row;}};return Reflect.get(target,field);}})),opts)) as any;
      const invoke=()=>action==="FORWARD" ? forward(ff,7.5,op) : action==="CANCEL" ? cancelInvoice(ff.c.id,actor.id,op) : action==="APPROVE" ? approveReturnRequest(r!.id,actor.id,op) : reverse(r,op);
      await assert.rejects(invoke(),/staged forwarding rollback/);prisma.$transaction=original;assert.equal(staged,1);
      assert.deepEqual(await prisma.invoice.findMany({where:{id:{in:ids}},orderBy:{id:"asc"}}),originalInvoices);assert.deepEqual(await prisma.customerCreditApplication.findMany({where:{actorId:actor.id},orderBy:{id:"asc"}}),originalApps);assert.deepEqual(await prisma.product.findUniqueOrThrow({where:{id:product.id}}),stock);assert.equal(await prisma.auditLog.count({where:{actorId:actor.id}}),audit);assert.equal(await prisma.invoice.count({where:{cashierId:actor.id}}),invoiceCount);assert.equal(await prisma.invoiceCorrectionSettlement.count({where:{operationKey:op}}),0);assert.equal(await prisma.returnOperation.count({where:{operationKey:op}}),0);await invoke();
    }
    const changed=await initial(),origin=await sale(50);await cancelInvoice(origin.id,actor.id,randomUUID());const extra=await prisma.invoiceCorrectionSettlement.findUniqueOrThrow({where:{sourceInvoiceId:origin.id}});let entered=0;
    prisma.$transaction=(async(work:any,opts:any)=>{prisma.$transaction=original;entered++;await applyCustomerCredit(actor.id,{sourceCorrectionId:extra.id,targetInvoiceId:changed.b.id,amount:50,reason:"After discovery",operationKey:randomUUID()});return original(work,opts);}) as any;
    await assert.rejects(forward(changed),/funding changed/);prisma.$transaction=original;assert.equal(entered,1);assert.equal((await prisma.invoice.findUniqueOrThrow({where:{id:changed.b.id}})).correctionCreditReleased,0);

    // Disjoint products avoid accidental stock serialization: both real unique
    // correction inserts compete after each forwarding transaction has staged.
    const otherProduct=await prisma.product.create({data:{name:"Disjoint owned forwarding item",sku:randomUUID(),brandId:brand.id,stock:100,retailPrice:100,wholesalePrice:100,allowFractionalQty:true,quantityStep:0.5}});
    const left=await forward(await initial()),rightA=await sale(400,customer.id,otherProduct.id),rightFirst=await modifyFinalizedInvoice(rightA.id,actor.id,{operationKey:randomUUID(),items:[{productId:otherProduct.id,qty:10}]});await addPayment(rightFirst.replacementInvoice.id,"CASH",200,"SUCCESS",actor.id);
    const collisionKey=randomUUID();let inserted!:()=>void,attempted!:()=>void,releaseUnique!:()=>void,entries=0;
    const firstInserted=new Promise<void>(r=>inserted=r),secondAttempted=new Promise<void>(r=>attempted=r),gate=new Promise<void>(r=>releaseUnique=r);
    prisma.$transaction=((work:any,opts:any)=>original(async(tx:any)=>work(new Proxy(tx,{get(target,field){if(field==="invoiceCorrectionSettlement")return {...tx.invoiceCorrectionSettlement,create:async(args:any)=>{const n=++entries;if(n===2)attempted();const row=await tx.invoiceCorrectionSettlement.create(args);if(n===1){inserted();await gate;}return row;}};return Reflect.get(target,field);}})),{...opts,timeout:20000})) as any;
    // Cancellation holds no invoice/credit-note sequence lock, allowing the
    // competing full-forward operation to reach the actual unique INSERT.
    const winner=cancelInvoice(left.c.id,actor.id,collisionKey);await firstInserted;const loser=modifyFinalizedInvoice(rightFirst.replacementInvoice.id,actor.id,{operationKey:collisionKey,items:[{productId:otherProduct.id,qty:7.5}]});await secondAttempted;releaseUnique();const outcomes=await Promise.allSettled([winner,loser]);prisma.$transaction=original;
    assert.equal(entries,2);assert.equal(outcomes[0].status,"fulfilled");assert.equal(outcomes[1].status,"rejected");assert.equal((await prisma.invoice.findUniqueOrThrow({where:{id:rightFirst.replacementInvoice.id}})).correctionCreditReleased,0);assert.equal(await prisma.customerCreditApplication.count({where:{sourceInvoiceId:rightA.id}}),0);

    const pending=await initial();await prisma.payment.create({data:{invoiceId:pending.b.id,method:"ESEWA",kind:"CHARGE",status:"PENDING",amount:10,createdById:actor.id}});await assert.rejects(forward(pending),/original credit source|receipt basis/);
    const history=await initial(),hr=await request(history.b,1);await approveReturnRequest(hr.id,actor.id,randomUUID());await assert.rejects(forward(history),/return|receipt basis/);
    const mixed=await initial(),mixedSource=await sale(50);await cancelInvoice(mixedSource.id,actor.id,randomUUID());const mixedCorrection=await prisma.invoiceCorrectionSettlement.findUniqueOrThrow({where:{sourceInvoiceId:mixedSource.id}});await applyCustomerCredit(actor.id,{sourceCorrectionId:mixedCorrection.id,targetInvoiceId:mixed.b.id,amount:50,reason:"Mixed initial funding remains withheld",operationKey:randomUUID()});await assert.rejects(forward(mixed),/credit applications/);
    const third=await forward(await initial(0,200));await assert.rejects(modifyFinalizedInvoice(third.c.id,actor.id,{operationKey:randomUUID(),items:[{productId:product.id,qty:8}]}),/original credit source/);
    const anonA=await sale(400,null),anonB=await modifyFinalizedInvoice(anonA.id,actor.id,{operationKey:randomUUID(),items:[{productId:product.id,qty:10}]});await assert.rejects(modifyFinalizedInvoice(anonB.replacementInvoice.id,actor.id,{operationKey:randomUUID(),items:[{productId:product.id,qty:8}]}),/original credit source/);
    const changedOwnerA=await sale(400,other.id),changedOwnerB=await modifyFinalizedInvoice(changedOwnerA.id,actor.id,{operationKey:randomUUID(),customerId:customer.id,items:[{productId:product.id,qty:10}]});
    assert.equal(changedOwnerB.replacementInvoice.correctionCredit,0);await assert.rejects(modifyFinalizedInvoice(changedOwnerB.replacementInvoice.id,actor.id,{operationKey:randomUUID(),items:[{productId:product.id,qty:8}]}),/original credit source/);

    const malformed=await forward(await initial());await prisma.invoiceCorrectionSettlement.update({where:{id:malformed.own.id},data:{inheritedFunding:{...(malformed.own.inheritedFunding as any),applicationId:"unknown"}}});
    const bad=(await listCustomerReceivables({q:customer.name},"ADMIN")).items[0].invoices;assert.ok(bad.find(i=>i.invoiceId===malformed.a.id)?.reason);assert.ok(bad.find(i=>i.invoiceId===malformed.b.id)?.reason);assert.ok(bad.find(i=>i.invoiceId===malformed.c.id)?.reason);
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
