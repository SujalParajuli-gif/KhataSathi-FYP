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
test("MySQL mixed replacement restoration conserves parent and application sources under actual races and rollback", { skip: process.env.KHATASATHI_MIXED_RELEASE_MYSQL_TEST !== "1", timeout: 120000 }, async () => {
  const url = new URL(process.env.DATABASE_URL || "");
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname) && (url.port || "3306") === "3306" && url.pathname === "/ks_verify_mixed_credit_20261011");
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

  async function funded(aAmount=150,bAmount=100,itemProduct=product.id) {
    const origin=await sale(200,customer.id,itemProduct);
    const replaced=await modifyFinalizedInvoice(origin.id,actor.id,{operationKey:randomUUID(),items:[{productId:itemProduct,qty:10}]});
    invoices.push(replaced.replacementInvoice.id);
    await addPayment(replaced.replacementInvoice.id,"CASH",350,"SUCCESS",actor.id);
    const child=await prisma.invoice.findUniqueOrThrow({where:{id:replaced.replacementInvoice.id},include:{items:true}});
    const parent=await prisma.invoiceCorrectionSettlement.findUniqueOrThrow({where:{sourceInvoiceId:origin.id}});
    const a=await sale(aAmount,customer.id,itemProduct),b=await sale(bAmount,customer.id,itemProduct);
    await cancelInvoice(a.id,actor.id,randomUUID());await cancelInvoice(b.id,actor.id,randomUUID());
    const ca=await prisma.invoiceCorrectionSettlement.findUniqueOrThrow({where:{sourceInvoiceId:a.id}}),cb=await prisma.invoiceCorrectionSettlement.findUniqueOrThrow({where:{sourceInvoiceId:b.id}});
    const ap=await applyCustomerCredit(actor.id,{sourceCorrectionId:ca.id,targetInvoiceId:child.id,amount:aAmount,reason:"Older original source",operationKey:randomUUID()});
    const bp=await applyCustomerCredit(actor.id,{sourceCorrectionId:cb.id,targetInvoiceId:child.id,amount:bAmount,reason:"Newer original source",operationKey:randomUUID()});
    return {origin,parent,a,b,ca,cb,child,ap,bp};
  }
  async function request(child:any,qty:number) {return createReturnRequest(actor.id,{invoiceId:child.id,operationKey:randomUUID(),reason:"CUSTOMER_REQUEST",items:[{invoiceItemId:child.items[0].id,qty}]});}
  async function approve(f:any,qty:number) {const r=await request(f.child,qty);await approveReturnRequest(r.id,actor.id,randomUUID());return r;}
  async function balance(id:string) {return (await listCustomerReceivables({q:customer.name},"ADMIN")).items[0].invoices.find(i=>i.invoiceId===id)!;}
  const spend=(f:any,target:any,amount:number)=>applyCustomerCredit(actor.id,{sourceCorrectionId:f.cb.id,targetInvoiceId:target.id,amount,reason:"Spend restored source",operationKey:randomUUID()});
  const reverse=(r:any)=>reverseApprovedReturnRequest(r.id,actor.id,"Restore all original funding",randomUUID());
  try {
    const f=await funded(),beforeApps=await prisma.customerCreditApplication.findMany({where:{targetInvoiceId:f.child.id},orderBy:{id:"asc"}}),beforeReceipts=await prisma.payment.findMany({where:{invoiceId:{in:[f.origin.id,f.a.id,f.b.id,f.child.id]}},orderBy:{id:"asc"}}),cash=await prisma.cashDrawerEvent.count();
    const r=await request(f.child,4),key=randomUUID(),result=await approveReturnRequest(r.id,actor.id,key);
    assert.deepEqual([result.settlement.version,result.settlement.debtReduction,result.settlement.restoredCredit,result.settlement.retainedCredit],[5,200,0,0]);
    assert.deepEqual(result.settlement.applications.map((a:any)=>[a.applicationId,a.released]),[[f.bp.id,100],[f.ap.id,100]]);
    assert.deepEqual([(await balance(f.child.id)).appliedCredit,(await balance(f.child.id)).correctionCredit,(await balance(f.child.id)).due,(await balance(f.a.id)).retainedCredit,(await balance(f.b.id)).retainedCredit],[50,200,0,100,100]);
    assert.deepEqual((await prisma.customerCreditApplication.findMany({where:{targetInvoiceId:f.child.id},orderBy:{id:"asc"}})).map(({amountReleased,...a})=>a),beforeApps.map(({amountReleased,...a})=>a));
    assert.equal(await prisma.cashDrawerEvent.count(),cash);assert.deepEqual(await prisma.payment.findMany({where:{invoiceId:{in:[f.origin.id,f.a.id,f.b.id,f.child.id]}},orderBy:{id:"asc"}}),beforeReceipts);
    await assert.rejects(reverseCustomerCredit(actor.id,f.ap.id,{reason:"Double restoration blocked",operationKey:randomUUID()}),/application-funded returns/);
    const used=await spend(f,await sale(0),50);await assert.rejects(reverse(r),/every original credit source/);await reverseCustomerCredit(actor.id,used.id,{reason:"Restore consumed credit",operationKey:randomUUID()});await reverse(r);assert.deepEqual(await approveReturnRequest(r.id,actor.id,key),result);
    const full=await funded(),fullR=await approve(full,7);assert.deepEqual([(await balance(full.origin.id)).retainedCredit,(await balance(full.a.id)).retainedCredit,(await balance(full.b.id)).retainedCredit,(await balance(full.child.id)).retainedCredit],[200,150,100,50]);
    const ownRow=await prisma.returnRequest.findUniqueOrThrow({where:{id:fullR.id}});assert.equal((ownRow.settlement as any).restoredCredit,200);
    const parentSpend=await applyCustomerCredit(actor.id,{sourceCorrectionId:full.parent.id,targetInvoiceId:(await sale(0)).id,amount:100,reason:"Spend restored inherited credit",operationKey:randomUUID()});await assert.rejects(reverse(fullR),/every original credit source/);await reverseCustomerCredit(actor.id,parentSpend.id,{reason:"Restore fixed source",operationKey:randomUUID()});
    const out=await confirmCustomerCreditPayout(actor.id,{sourceCorrectionId:full.parent.id,drawerId:drawer.id,amount:100,reason:"Actual parent payout",operationKey:randomUUID(),cashConfirmed:true,newPayoutConfirmed:true});await assert.rejects(reverse(fullR),/every original credit source/);await confirmCustomerCreditRecovery(actor.id,out.id,{drawerId:drawer.id,reason:"Cash received",operationKey:randomUUID(),cashReceivedConfirmed:true});await reverse(fullR);
    await assert.rejects(applyCustomerCredit(actor.id,{sourceReturnId:fullR.id,targetInvoiceId:(await sale(0)).id,amount:1,reason:"Reversed source cannot be nested",operationKey:randomUUID()}));
    const nested=await funded(),nestedR=await approve(nested,7);await assert.rejects(applyCustomerCredit(actor.id,{sourceReturnId:nestedR.id,targetInvoiceId:(await sale(0)).id,amount:10,reason:"Nested mixed source withheld",operationKey:randomUUID()}),/Nested/);
    const frac=await funded(150.55,99.45);const fracR=await request(frac.child,4.01),fracA=await approveReturnRequest(fracR.id,actor.id,randomUUID());assert.deepEqual(fracA.settlement.applications.map((a:any)=>a.released),[99.45,101.55]);
    const multiple=await funded(),m1=await approve(multiple,4),m2=await approve(multiple,3);assert.equal((await balance(multiple.child.id)).appliedCredit,0);assert.equal((await balance(multiple.child.id)).retainedCredit,50);await assert.rejects(reverse(m1),/later approved/);await reverse(m2);await reverse(m1);
    const zero=await funded(),z1=await approve(zero,5),z2=await approve(zero,2);assert.equal((await balance(zero.child.id)).appliedCredit,0);assert.equal((await balance(zero.origin.id)).retainedCredit,200);await reverse(z2);await reverse(z1);
    const cf=await funded(),ck=randomUUID(),cancelled=await cancelInvoice(cf.child.id,actor.id,ck);assert.deepEqual([(await balance(cf.origin.id)).retainedCredit,(await balance(cf.a.id)).retainedCredit,(await balance(cf.b.id)).retainedCredit,(await balance(cf.child.id)).retainedCredit],[200,150,100,350]);
    const capture=await prisma.invoiceCorrectionSettlement.findUniqueOrThrow({where:{sourceInvoiceId:cf.child.id}});assert.equal((capture.inheritedFunding as any).version,3);await spend(cf,await sale(0),50);assert.deepEqual(await cancelInvoice(cf.child.id,actor.id,ck),cancelled);await assert.rejects(reverseCustomerCredit(actor.id,cf.ap.id,{reason:"Cancelled cannot double release",operationKey:randomUUID()}));
    const malformed=await funded();await prisma.invoice.update({where:{id:malformed.child.id},data:{correctionCreditReleased:1}});await assert.rejects(request(malformed.child,4),/reconcile/);
    const malformedParent=await funded();await approve(malformedParent,7);await prisma.invoice.update({where:{id:malformedParent.origin.id},data:{paidTotal:201}});assert.ok((await balance(malformedParent.a.id)).reason);await assert.rejects(applyCustomerCredit(actor.id,{sourceCorrectionId:malformedParent.ca.id,targetInvoiceId:(await sale(0)).id,amount:1,reason:"Unresolved fixed-parent receipts",operationKey:randomUUID()}),/reconcile/);
    const pending=await funded(),pend=await request(pending.child,4);await reverseCustomerCredit(actor.id,pending.bp.id,{reason:"Changed funding",operationKey:randomUUID()});await assert.rejects(approveReturnRequest(pend.id,actor.id,randomUUID()),/source changed/);
    // Both actual decision orders for either restored fixed-parent or application source.
    for(const parentSource of [true,false])for(const firstReverse of [true,false])for(const cashPayout of [true,false]) {
      const rf=await funded(),rr=await approve(rf,7),sink=await sale(0),sourceId=parentSource ? rf.parent.id : rf.cb.id;
      const consume=()=>cashPayout ? confirmCustomerCreditPayout(actor.id,{sourceCorrectionId:sourceId,drawerId:drawer.id,amount:50,reason:"Actual source payout",operationKey:randomUUID(),cashConfirmed:true,newPayoutConfirmed:true}) : applyCustomerCredit(actor.id,{sourceCorrectionId:sourceId,targetInvoiceId:sink.id,amount:50,reason:"Consume exact source",operationKey:randomUUID()});
      const decisions=firstReverse ? await race(()=>reverse(rr),consume,4) : await race(consume,()=>reverse(rr));assert.equal(decisions[0].status,"fulfilled");assert.equal(decisions[1].status,"rejected");
    }
    for(const paymentFirst of [true,false]) {
      const pf=await funded(),pr=await request(pf.child,4);const pay=()=>addPayment(pf.child.id,"CASH",100,"SUCCESS",actor.id),approveIt=()=>approveReturnRequest(pr.id,actor.id,randomUUID());const decisions=paymentFirst ? await race(pay,approveIt) : await race(approveIt,pay,4);assert.equal(decisions[0].status,"fulfilled");assert.equal(decisions[1].status,paymentFirst ? "fulfilled" : "rejected");
    }
    const cancelFirst=await funded();const cancelRace=await race(()=>cancelInvoice(cancelFirst.child.id,actor.id,randomUUID()),()=>request(cancelFirst.child,4),4);assert.equal(cancelRace[0].status,"fulfilled");assert.equal(cancelRace[1].status,"rejected");
    const approvalFirst=await funded(),cr=await request(approvalFirst.child,4);const approvalRace=await race(()=>approveReturnRequest(cr.id,actor.id,randomUUID()),()=>cancelInvoice(approvalFirst.child.id,actor.id,randomUUID()),4);assert.equal(approvalRace[0].status,"fulfilled");assert.equal(approvalRace[1].status,"rejected");
    const duplicate=await funded(),dr=await request(duplicate.child,7),dk=randomUUID();const duplicates=await race(()=>approveReturnRequest(dr.id,actor.id,dk),()=>approveReturnRequest(dr.id,actor.id,dk),4);assert.ok(duplicates.every(r=>r.status === "fulfilled"));assert.deepEqual((duplicates[0] as PromiseFulfilledResult<any>).value,(duplicates[1] as PromiseFulfilledResult<any>).value);
    const changed=await funded(),extra=await sale(50);await cancelInvoice(extra.id,actor.id,randomUUID());const ec=await prisma.invoiceCorrectionSettlement.findUniqueOrThrow({where:{sourceInvoiceId:extra.id}});let entered=0;prisma.$transaction=(async(work:any,opts:any)=>{prisma.$transaction=original;entered++;await applyCustomerCredit(actor.id,{sourceCorrectionId:ec.id,targetInvoiceId:changed.child.id,amount:50,reason:"New origin after discovery",operationKey:randomUUID()});return original(work,opts);}) as any;await assert.rejects(request(changed.child,4),/funding changed/);prisma.$transaction=original;assert.equal(entered,1);assert.equal(await prisma.returnRequest.count({where:{invoiceId:changed.child.id}}),0);

    await assert.rejects(applyCustomerCredit(actor.id,{sourceCorrectionId:f.parent.id,targetInvoiceId:f.child.id,amount:1,reason:"No extra parent residue",operationKey:randomUUID()}),/available credit/);
    for(const approvalWins of [true,false]) {
      const af=await funded(),ar=await request(af.child,7);const approveIt=()=>approveReturnRequest(ar.id,actor.id,randomUUID()),reverseApplication=()=>reverseCustomerCredit(actor.id,af.bp.id,{reason:"Whole funding changed",operationKey:randomUUID()});const decisions=approvalWins ? await race(approveIt,reverseApplication,4) : await race(reverseApplication,approveIt);assert.equal(decisions[0].status,"fulfilled");assert.equal(decisions[1].status,"rejected");
    }
    // An original version2 return source is eligible, including its full-release reversal race.
    for(const targetFirst of [true,false]) {
      const rf=await funded(),origin=await sale(400),originR=await request(origin,8);await approveReturnRequest(originR.id,actor.id,randomUUID());
      await applyCustomerCredit(actor.id,{sourceReturnId:originR.id,targetInvoiceId:rf.child.id,amount:100,reason:"Extra original return credit",operationKey:randomUUID()});const rr=await request(rf.child,7);
      const approveIt=()=>approveReturnRequest(rr.id,actor.id,randomUUID()),reverseOrigin=()=>reverse(originR);const decisions=targetFirst ? await race(approveIt,reverseOrigin,5) : await race(reverseOrigin,approveIt);assert.equal(decisions[0].status,targetFirst ? "fulfilled" : "rejected");assert.equal(decisions[1].status,"fulfilled");
      if(targetFirst)await assert.rejects(reverse(rr),/every original credit source/);
    }
    const secondProduct=await prisma.product.create({data:{name:"Disjoint mixed item",sku:randomUUID(),brandId:brand.id,stock:100,retailPrice:100,wholesalePrice:100,wholesaleEligible:false}});
    const left=await funded(),right=await funded(150,100,secondProduct.id),lr=await request(left.child,7),rr=await request(right.child,7),collisionKey=randomUUID();
    let inserted!:()=>void,attempted!:()=>void,releaseUnique!:()=>void,entries=0;const firstInserted=new Promise<void>(r=>inserted=r),secondAttempted=new Promise<void>(r=>attempted=r),uniqueGate=new Promise<void>(r=>releaseUnique=r);
    prisma.$transaction=((work:any,opts:any)=>original(async(tx:any)=>work(new Proxy(tx,{get(target,field){if(field === "returnOperation")return {...tx.returnOperation,create:async(args:any)=>{const n=++entries;if(n === 2)attempted();const row=await tx.returnOperation.create(args);if(n === 1){inserted();await uniqueGate;}return row;}};return Reflect.get(target,field);}})),{...opts,timeout:20000})) as any;
    const winner=approveReturnRequest(lr.id,actor.id,collisionKey);await firstInserted;const loser=approveReturnRequest(rr.id,actor.id,collisionKey);await secondAttempted;releaseUnique();const collision=await Promise.allSettled([winner,loser]);prisma.$transaction=original;
    assert.equal(entries,2);assert.equal(collision[0].status,"fulfilled");assert.equal(collision[1].status,"rejected");assert.equal((await prisma.returnRequest.findUniqueOrThrow({where:{id:rr.id}})).status,"PENDING");assert.equal((await prisma.invoice.findUniqueOrThrow({where:{id:right.child.id}})).correctionCreditReleased,0);assert.equal((await balance(right.child.id)).appliedCredit,250);assert.equal((await balance(right.b.id)).retainedCredit,0);assert.equal(await prisma.stockTransaction.count({where:{refInvoiceId:right.child.id,type:"RESTOCK"}}),0);

    for(const action of ["APPROVE","REVERSE","CANCEL"]) {
      const ff=await funded(),fr=action === "CANCEL" ? null : await request(ff.child,7);if(action === "REVERSE")await approveReturnRequest(fr!.id,actor.id,randomUUID());const invoiceBefore=await prisma.invoice.findUniqueOrThrow({where:{id:ff.child.id}}),appsBefore=await prisma.customerCreditApplication.findMany({where:{targetInvoiceId:ff.child.id},orderBy:{id:"asc"}}),stockBefore=await prisma.product.findUniqueOrThrow({where:{id:product.id}}),auditBefore=await prisma.auditLog.count();let staged=0;const op=randomUUID();
      prisma.$transaction=((work:any,opts:any)=>original(async(tx:any)=>work(new Proxy(tx,{get(target,field){if(field === "auditLog")return {...tx.auditLog,create:async(args:any)=>{const row=await tx.auditLog.create(args);if(args.data.action === (action === "CANCEL" ? "INVOICE_CANCELLED" : "RETURN_REQUEST_"+action+"D")){assert.notEqual((await tx.invoice.findUniqueOrThrow({where:{id:ff.child.id}})).correctionCreditReleased,invoiceBefore.correctionCreditReleased);assert.notDeepEqual(await tx.customerCreditApplication.findMany({where:{targetInvoiceId:ff.child.id},orderBy:{id:"asc"}}),appsBefore);assert.notDeepEqual(await tx.product.findUniqueOrThrow({where:{id:product.id}}),stockBefore);staged++;throw Error("Injected both-cache mixed rollback");}return row;}};return Reflect.get(target,field);}})),opts)) as any;
      const invoke=()=>action === "CANCEL" ? cancelInvoice(ff.child.id,actor.id,op) : action === "APPROVE" ? approveReturnRequest(fr!.id,actor.id,op) : reverseApprovedReturnRequest(fr!.id,actor.id,"Retry same mixed operation",op);await assert.rejects(invoke(),/both-cache mixed/);prisma.$transaction=original;assert.equal(staged,1);assert.deepEqual(await prisma.invoice.findUniqueOrThrow({where:{id:ff.child.id}}),invoiceBefore);assert.deepEqual(await prisma.customerCreditApplication.findMany({where:{targetInvoiceId:ff.child.id},orderBy:{id:"asc"}}),appsBefore);assert.deepEqual(await prisma.product.findUniqueOrThrow({where:{id:product.id}}),stockBefore);assert.equal(await prisma.auditLog.count(),auditBefore);assert.equal(await prisma.returnOperation.count({where:{operationKey:op}}),0);assert.equal(await prisma.invoiceCorrectionSettlement.count({where:{operationKey:op}}),0);await invoke();
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
