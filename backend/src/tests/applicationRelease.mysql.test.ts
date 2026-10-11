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
test("MySQL application-funded restoration conserves exact sources and serializes partial release, spending, reversal and cancellation", { skip: process.env.KHATASATHI_APPLICATION_RELEASE_MYSQL_TEST !== "1", timeout: 120000 }, async () => {
  const url = new URL(process.env.DATABASE_URL || "");
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname) && (url.port || "3306") === "3306" && url.pathname === "/ks_verify_multi_credit_20261011");
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

  async function funded(aAmount=300,bAmount=200,itemProduct=product.id) {
    const a=await sale(aAmount,customer.id,itemProduct), b=await sale(bAmount,customer.id,itemProduct);
    await cancelInvoice(a.id,actor.id,randomUUID());await cancelInvoice(b.id,actor.id,randomUUID());
    const ca=await prisma.invoiceCorrectionSettlement.findUniqueOrThrow({where:{sourceInvoiceId:a.id}}),cb=await prisma.invoiceCorrectionSettlement.findUniqueOrThrow({where:{sourceInvoiceId:b.id}});
    const child=await sale(300,customer.id,itemProduct);
    const ap=await applyCustomerCredit(actor.id,{sourceCorrectionId:ca.id,targetInvoiceId:child.id,amount:aAmount,reason:"Older credit",operationKey:randomUUID()});
    const bp=await applyCustomerCredit(actor.id,{sourceCorrectionId:cb.id,targetInvoiceId:child.id,amount:bAmount,reason:"Newer credit",operationKey:randomUUID()});
    return {a,b,ca,cb,child,ap,bp};
  }
  async function request(child:any,qty:number) {return createReturnRequest(actor.id,{invoiceId:child.id,operationKey:randomUUID(),reason:"CUSTOMER_REQUEST",items:[{invoiceItemId:child.items[0].id,qty}]});}
  async function approve(f:any,qty:number) {const r=await request(f.child,qty);await approveReturnRequest(r.id,actor.id,randomUUID());return r;}
  async function balance(id:string) {return (await listCustomerReceivables({q:customer.name},"ADMIN")).items[0].invoices.find(i=>i.invoiceId===id)!;}
  const spend=(f:any,target:any,amount:number)=>applyCustomerCredit(actor.id,{sourceCorrectionId:f.cb.id,targetInvoiceId:target.id,amount,reason:"Spend restored source",operationKey:randomUUID()});
  const reverse=(r:any)=>reverseApprovedReturnRequest(r.id,actor.id,"Restore all original funding",randomUUID());
  try {
    const f=await funded(),originalRows=await prisma.customerCreditApplication.findMany({where:{targetInvoiceId:f.child.id},orderBy:{id:"asc"}}),receipts=await prisma.payment.findMany({where:{invoiceId:{in:[f.a.id,f.b.id,f.child.id]}},orderBy:{id:"asc"}}),cash=await prisma.cashDrawerEvent.count();
    const r=await request(f.child,4),key=randomUUID(),result=await approveReturnRequest(r.id,actor.id,key);
    assert.deepEqual([result.settlement.version,result.settlement.debtReduction,result.settlement.retainedCredit],[4,200,0]);
    assert.deepEqual(result.settlement.applications.map((a:any)=>[a.applicationId,a.released]),[[f.bp.id,200],[f.ap.id,0]]);
    assert.deepEqual([(await balance(f.a.id)).retainedCredit,(await balance(f.b.id)).retainedCredit,(await balance(f.child.id)).appliedCredit,(await balance(f.child.id)).due],[0,200,300,0]);
    assert.equal(await prisma.cashDrawerEvent.count(),cash);assert.deepEqual(await prisma.payment.findMany({where:{invoiceId:{in:[f.a.id,f.b.id,f.child.id]}},orderBy:{id:"asc"}}),receipts);
    const afterRows=await prisma.customerCreditApplication.findMany({where:{targetInvoiceId:f.child.id},orderBy:{id:"asc"}});assert.deepEqual(afterRows.map(({amountReleased,...a})=>a),originalRows.map(({amountReleased,...a})=>a));
    await assert.rejects(reverseCustomerCredit(actor.id,f.bp.id,{operationKey:randomUUID(),reason:"Avoid double restore"}),/application-funded returns/);
    const app=await spend(f,await sale(0),150);await assert.rejects(reverse(r),/every original credit source/);
    await reverseCustomerCredit(actor.id,app.id,{reason:"Release restored budget",operationKey:randomUUID()});
    const out=await confirmCustomerCreditPayout(actor.id,{sourceCorrectionId:f.cb.id,drawerId:drawer.id,amount:100,reason:"Actual payout",operationKey:randomUUID(),cashConfirmed:true,newPayoutConfirmed:true});await assert.rejects(reverse(r),/every original credit source/);
    await confirmCustomerCreditRecovery(actor.id,out.id,{drawerId:drawer.id,reason:"Actual cash recovered",operationKey:randomUUID(),cashReceivedConfirmed:true});await reverse(r);
    assert.equal((await balance(f.child.id)).due,200);assert.equal((await balance(f.b.id)).retainedCredit,0);assert.deepEqual(await approveReturnRequest(r.id,actor.id,key),result);

    const full=await funded(),fullR=await approve(full,8);assert.deepEqual([(await balance(full.a.id)).retainedCredit,(await balance(full.b.id)).retainedCredit,(await balance(full.child.id)).retainedCredit],[300,200,100]);
    await assert.rejects(applyCustomerCredit(actor.id,{sourceReturnId:fullR.id,targetInvoiceId:(await sale(0)).id,amount:50,reason:"Nested source withheld",operationKey:randomUUID()}),/Nested/);
    const frac=await funded(300.55,199.45); // Whole-rupee returned value with cent-exact credit.
    const fracRequest=await request(frac.child,4.01);const fracApproved=await approveReturnRequest(fracRequest.id,actor.id,randomUUID());assert.deepEqual(fracApproved.settlement.applications.map((a:any)=>a.released),[199.45,1.55]);
    const multi=await funded(),m1=await approve(multi,3),m2=await approve(multi,5);await assert.rejects(reverse(m1),/later approved/);await reverse(m2);assert.equal((await balance(multi.b.id)).retainedCredit,100);await reverse(m1);
    const cancelled=await funded(),cancelKey=randomUUID(),cancelledResponse=await cancelInvoice(cancelled.child.id,actor.id,cancelKey);assert.deepEqual([(await balance(cancelled.a.id)).retainedCredit,(await balance(cancelled.b.id)).retainedCredit,(await balance(cancelled.child.id)).retainedCredit],[300,200,300]);await spend(cancelled,await sale(0),100);assert.deepEqual(await cancelInvoice(cancelled.child.id,actor.id,cancelKey),cancelledResponse);
    const malformed=await funded();await prisma.customerCreditApplication.update({where:{id:malformed.ap.id},data:{amountReleased:1}});await assert.rejects(request(malformed.child,4),/does not reconcile/);
    const pending=await funded(),pendingR=await request(pending.child,4);await reverseCustomerCredit(actor.id,pending.bp.id,{reason:"Funding changed before approval",operationKey:randomUUID()});await assert.rejects(approveReturnRequest(pendingR.id,actor.id,randomUUID()),/source changed/);

    const rf=await funded(),rr=await approve(rf,4),rt=await sale(0);
    const reversalFirst=await race(()=>reverse(rr),()=>spend(rf,rt,100),3);assert.equal(reversalFirst[0].status,"fulfilled");assert.equal(reversalFirst[1].status,"rejected");
    const sf=await funded(),sr=await approve(sf,4),st=await sale(0);
    const spendFirst=await race(()=>spend(sf,st,100),()=>reverse(sr));assert.equal(spendFirst[0].status,"fulfilled");assert.equal(spendFirst[1].status,"rejected");
    const pf=await funded(),pr=await approve(pf,4);
    const payout=()=>confirmCustomerCreditPayout(actor.id,{sourceCorrectionId:pf.cb.id,drawerId:drawer.id,amount:100,reason:"Actual payout wins",operationKey:randomUUID(),cashConfirmed:true,newPayoutConfirmed:true});
    const payoutFirst=await race(payout,()=>reverse(pr));assert.equal(payoutFirst[0].status,"fulfilled");assert.equal(payoutFirst[1].status,"rejected");
    const pay=await funded(),payR=await request(pay.child,4);const paymentFirst=await race(()=>addPayment(pay.child.id,"CASH",100,"SUCCESS",actor.id),()=>approveReturnRequest(payR.id,actor.id,randomUUID()));assert.equal(paymentFirst[0].status,"fulfilled");assert.equal(paymentFirst[1].status,"fulfilled");assert.deepEqual([(await balance(pay.a.id)).retainedCredit,(await balance(pay.b.id)).retainedCredit],[100,200]);
    const ret=await funded(),retR=await request(ret.child,4);const returnFirst=await race(()=>approveReturnRequest(retR.id,actor.id,randomUUID()),()=>addPayment(ret.child.id,"CASH",100,"SUCCESS",actor.id),3);assert.equal(returnFirst[0].status,"fulfilled");assert.equal(returnFirst[1].status,"rejected");
    const cf=await funded();const cancelFirst=await race(()=>cancelInvoice(cf.child.id,actor.id,randomUUID()),()=>request(cf.child,4),3);assert.equal(cancelFirst[0].status,"fulfilled");assert.equal(cancelFirst[1].status,"rejected");
    const duplicate=await funded(),dupR=await request(duplicate.child,4),dupKey=randomUUID();const dup=await race(()=>approveReturnRequest(dupR.id,actor.id,dupKey),()=>approveReturnRequest(dupR.id,actor.id,dupKey),3);assert.equal(dup[0].status,"fulfilled");assert.equal(dup[1].status,"fulfilled");assert.deepEqual((dup[0] as PromiseFulfilledResult<any>).value,(dup[1] as PromiseFulfilledResult<any>).value);


    const sameSource=await sale(500);await cancelInvoice(sameSource.id,actor.id,randomUUID());const sameCorrection=await prisma.invoiceCorrectionSettlement.findUniqueOrThrow({where:{sourceInvoiceId:sameSource.id}}),sameTarget=await sale(300);
    for(const amount of [300,200])await applyCustomerCredit(actor.id,{sourceCorrectionId:sameCorrection.id,targetInvoiceId:sameTarget.id,amount,reason:"Two applications same source",operationKey:randomUUID()});
    const sameReturn=await request(sameTarget,8);await approveReturnRequest(sameReturn.id,actor.id,randomUUID());assert.equal((await balance(sameSource.id)).retainedCredit,500);
    await applyCustomerCredit(actor.id,{sourceCorrectionId:sameCorrection.id,targetInvoiceId:(await sale(0)).id,amount:100,reason:"Source aggregate spend",operationKey:randomUUID()});await assert.rejects(reverse(sameReturn),/every original credit source/);
    const originalReturnSource=await sale(400),originRequest=await request(originalReturnSource,8);await approveReturnRequest(originRequest.id,actor.id,randomUUID());
    const originalTarget=await sale(300);await applyCustomerCredit(actor.id,{sourceReturnId:originRequest.id,targetInvoiceId:originalTarget.id,amount:200,reason:"Original return funding",operationKey:randomUUID()});
    const originalTargetRequest=await request(originalTarget,8);await approveReturnRequest(originalTargetRequest.id,actor.id,randomUUID());await reverse(originRequest);
    assert.equal((await balance(originalTarget.id)).reason,null);await assert.rejects(reverse(originalTargetRequest),/every original credit source/);


    const reverseWins=await funded(),reverseWinsR=await approve(reverseWins,4);const reverseBeforePayout=await race(()=>reverse(reverseWinsR),()=>confirmCustomerCreditPayout(actor.id,{sourceCorrectionId:reverseWins.cb.id,drawerId:drawer.id,amount:100,reason:"Actual payout loses",operationKey:randomUUID(),cashConfirmed:true,newPayoutConfirmed:true}),3);assert.equal(reverseBeforePayout[0].status,"fulfilled");assert.equal(reverseBeforePayout[1].status,"rejected");
    const approvedFirst=await funded(),approvedFirstR=await request(approvedFirst.child,4);const approvalBeforeCancel=await race(()=>approveReturnRequest(approvedFirstR.id,actor.id,randomUUID()),()=>cancelInvoice(approvedFirst.child.id,actor.id,randomUUID()),3);assert.equal(approvalBeforeCancel[0].status,"fulfilled");assert.equal(approvalBeforeCancel[1].status,"rejected");
    for(const targetFirst of [true,false]) {
      const origin=await sale(400),originR=await request(origin,8);await approveReturnRequest(originR.id,actor.id,randomUUID());const fundedTarget=await sale(300);await applyCustomerCredit(actor.id,{sourceReturnId:originR.id,targetInvoiceId:fundedTarget.id,amount:200,reason:"Origin reversal race",operationKey:randomUUID()});const targetR=await request(fundedTarget,8);
      const approveTarget=()=>approveReturnRequest(targetR.id,actor.id,randomUUID());const reverseOrigin=()=>reverse(originR);
      const outcome=targetFirst ? await race(approveTarget,reverseOrigin,2) : await race(reverseOrigin,approveTarget);
      assert.equal(outcome[1].status,"fulfilled");assert.equal(outcome[0].status,targetFirst ? "fulfilled" : "rejected");
    }
    const fullyUnwound=await funded(),unwindR=await approve(fullyUnwound,4);await reverse(unwindR);for(const app of [fullyUnwound.ap,fullyUnwound.bp])await reverseCustomerCredit(actor.id,app.id,{reason:"Whole funding reversal after return reversal",operationKey:randomUUID()});const originalAgain=await request(fullyUnwound.child,3);const originalAgainResult=await approveReturnRequest(originalAgain.id,actor.id,randomUUID());assert.equal(originalAgainResult.settlement.version,2);

    const secondProduct=await prisma.product.create({data:{name:"Disjoint multi-source item",sku:randomUUID(),brandId:brand.id,stock:100,retailPrice:100,wholesalePrice:100,wholesaleEligible:false}});
    const left=await funded(),right=await funded(300,200,secondProduct.id),leftReturn=await request(left.child,4),rightReturn=await request(right.child,4),collisionKey=randomUUID();
    let inserted!:()=>void,attempted!:()=>void,releaseUnique!:()=>void,entries=0;const firstInserted=new Promise<void>(r=>inserted=r),secondAttempted=new Promise<void>(r=>attempted=r),uniqueGate=new Promise<void>(r=>releaseUnique=r);
    prisma.$transaction=((work:any,opts:any)=>original(async(tx:any)=>work(new Proxy(tx,{get(target,field){if(field === "returnOperation")return {...tx.returnOperation,create:async(args:any)=>{const n=++entries;if(n === 2)attempted();const row=await tx.returnOperation.create(args);if(n === 1){inserted();await uniqueGate;}return row;}};return Reflect.get(target,field);}})),{...opts,timeout:20000})) as any;
    const winner=approveReturnRequest(leftReturn.id,actor.id,collisionKey);await firstInserted;const loser=approveReturnRequest(rightReturn.id,actor.id,collisionKey);await secondAttempted;releaseUnique();const collision=await Promise.allSettled([winner,loser]);prisma.$transaction=original;
    assert.equal(entries,2);assert.equal(collision[0].status,"fulfilled");assert.equal(collision[1].status,"rejected");assert.equal((await prisma.returnRequest.findUniqueOrThrow({where:{id:rightReturn.id}})).status,"PENDING");assert.equal((await balance(right.b.id)).retainedCredit,0);assert.equal((await balance(right.child.id)).due,200);assert.equal(await prisma.stockTransaction.count({where:{refInvoiceId:right.child.id,type:"RESTOCK"}}),0);

    // Commit an added source precisely after discovery but before target lock;
    // the transaction must reject missing source coverage without touching stock.
    const changed=await funded(),extraSource=await sale(100);await cancelInvoice(extraSource.id,actor.id,randomUUID());const extraCorrection=await prisma.invoiceCorrectionSettlement.findUniqueOrThrow({where:{sourceInvoiceId:extraSource.id}});
    let discoveryBranch=0;
    prisma.$transaction=(async(work:any,opts:any)=>{prisma.$transaction=original;discoveryBranch++;await applyCustomerCredit(actor.id,{sourceCorrectionId:extraCorrection.id,targetInvoiceId:changed.child.id,amount:100,reason:"New source after discovery",operationKey:randomUUID()});return original(work,opts);}) as any;
    await assert.rejects(request(changed.child,4),/funding changed/);prisma.$transaction=original;assert.equal(discoveryBranch,1);assert.equal(await prisma.returnRequest.count({where:{invoiceId:changed.child.id}}),0);assert.equal((await balance(extraSource.id)).retainedCredit,0);

    for(const action of ["APPROVE","REVERSE","CANCEL"]) {
      const fault=await funded(),faultR=action === "CANCEL" ? null : await request(fault.child,4);if(action === "REVERSE")await approveReturnRequest(faultR!.id,actor.id,randomUUID());
      const beforeInvoice=await prisma.invoice.findUniqueOrThrow({where:{id:fault.child.id}}),beforeApps=await prisma.customerCreditApplication.findMany({where:{targetInvoiceId:fault.child.id},orderBy:{id:"asc"}}),beforeStock=await prisma.product.findUniqueOrThrow({where:{id:product.id}}),audit=await prisma.auditLog.count();let staged=0;const operationKey=randomUUID();
      prisma.$transaction=((work:any,opts:any)=>original(async(tx:any)=>work(new Proxy(tx,{get(target,field){if(field === "auditLog")return {...tx.auditLog,create:async(args:any)=>{const row=await tx.auditLog.create(args);if(args.data.action === (action === "CANCEL" ? "INVOICE_CANCELLED" : "RETURN_REQUEST_"+action+"D")){assert.notDeepEqual(await tx.invoice.findUniqueOrThrow({where:{id:fault.child.id}}),beforeInvoice);assert.notDeepEqual(await tx.product.findUniqueOrThrow({where:{id:product.id}}),beforeStock);assert.notDeepEqual(await tx.customerCreditApplication.findMany({where:{targetInvoiceId:fault.child.id},orderBy:{id:"asc"}}),beforeApps);staged++;throw Error("Injected staged multi-source rollback");}return row;}};return Reflect.get(target,field);}})),opts)) as any;
      const invoke=()=>action === "CANCEL" ? cancelInvoice(fault.child.id,actor.id,operationKey) : action === "APPROVE" ? approveReturnRequest(faultR!.id,actor.id,operationKey) : reverseApprovedReturnRequest(faultR!.id,actor.id,"Retry rollback",operationKey);
      await assert.rejects(invoke(),/staged multi-source/);prisma.$transaction=original;assert.equal(staged,1);assert.deepEqual(await prisma.invoice.findUniqueOrThrow({where:{id:fault.child.id}}),beforeInvoice);assert.deepEqual(await prisma.customerCreditApplication.findMany({where:{targetInvoiceId:fault.child.id},orderBy:{id:"asc"}}),beforeApps);assert.deepEqual(await prisma.product.findUniqueOrThrow({where:{id:product.id}}),beforeStock);assert.equal(await prisma.auditLog.count(),audit);assert.equal(await prisma.returnOperation.count({where:{operationKey}}),0);assert.equal(await prisma.invoiceCorrectionSettlement.count({where:{operationKey}}),0);await invoke();
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
