import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
import prisma from "../db/prisma";
import { createReturnRequest, approveReturnRequest, reverseApprovedReturnRequest, rejectReturnRequest } from "../modules/returns/service";
import { addPayment, voidPayment } from "../modules/payments/service";
import { cancelInvoice } from "../modules/invoices/service";
import { listCustomerReceivables } from "../modules/customers/receivables";

test("MySQL original-sale returns: overlapping decisions, replay, debt/credit, real audit rollback and reversal guards", { skip: process.env.KHATASATHI_RETURN_MYSQL_TEST !== "1", timeout: 90000 }, async () => {
  const url = new URL(process.env.DATABASE_URL || "");
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname)); assert.equal(url.port || "3306", "3306"); assert.equal(url.pathname, "/ks_verify_customer_returns_20261010");
  const originalTransaction = prisma.$transaction.bind(prisma), suffix = randomUUID();
  const actor = await prisma.user.create({ data: { name: "Owned return actor", phone: `+97798${randomInt(10000000,99999999)}`, passwordHash: "unusable", role: "ADMIN" } });
  const customer = await prisma.customer.create({ data: { name: `Owned return ${suffix}` } });
  const brand = await prisma.brand.create({ data: { name: `Owned return ${suffix}` } });
  const product = await prisma.product.create({ data: { name: "Owned return item", sku: `RET-${suffix}`, brandId: brand.id, stock: 100, retailPrice: 100 } });
  const invoices: string[] = [];
  const cashEvents = await prisma.cashDrawerEvent.count();
  async function sale(paid=400, netTotal=1000, subTotal=1000) {
    const i = await prisma.invoice.create({ data: { invoiceNo: `RET-${randomUUID()}`, cashierId: actor.id, customerId: customer.id, status: "FINALIZED", finalizedAt: new Date(), netTotal, subTotal, paidTotal: paid, paymentStatus: paid >= netTotal ? "PAID" : paid > 0 ? "PARTIALLY_PAID" : "UNPAID",
      items: { create: { productId: product.id, qty: 10, appliedUnitPrice: subTotal/10, lineTotal: subTotal, productNameSnapshot: "Owned return item", snapshotCapturedAt: new Date() } },
      ...(paid ? { payments: { create: { method: "CASH", amount: paid, kind: "CHARGE", status: "SUCCESS", createdById: actor.id } } } : {}) }, include: { items: true } });
    invoices.push(i.id); return i;
  }
  const request = (i: any, qty: number, key=randomUUID()) => createReturnRequest(actor.id, { invoiceId: i.id, reason: "CUSTOMER_REQUEST", items: [{ invoiceItemId: i.items[0].id, qty }], operationKey: key });
  async function race(first: () => Promise<any>, second: () => Promise<any>) {
    let held!: () => void, waiting!: () => void, release!: () => void, calls=0;
    const a=new Promise<void>(r=>held=r),b=new Promise<void>(r=>waiting=r),gate=new Promise<void>(r=>release=r);
    prisma.$transaction=((work: any,opts: any)=>originalTransaction(async (tx: any)=>work(new Proxy(tx,{get(target,key){
      if(key==="$queryRaw")return async (query: TemplateStringsArray,...values: any[])=>{
        const match=/FROM Invoice\s/.test(query.join(" "))&&query.join(" ").includes("FOR UPDATE"),call=match?++calls:0;
        if(call===2)waiting(); const result=await tx.$queryRaw(query,...values);
        if(call===1){held();await gate;} return result;
      }; return Reflect.get(target,key);
    }})),{...opts,timeout:15000})) as any;
    const ops: Promise<any>[]=[];
    try{ops.push(first());await a;ops.push(second());await b;release();const result=await Promise.allSettled(ops);assert.ok(calls>=2);return result;}
    finally{release();await Promise.allSettled(ops);prisma.$transaction=originalTransaction;}
  }
  try {
    const i=await sale(), key=randomUUID();
    const dup=await race(()=>request(i,3,key),()=>request(i,3,key));
    assert.ok(dup.every(r=>r.status==="fulfilled"));const pending=(dup[0] as PromiseFulfilledResult<any>).value;
    assert.deepEqual((dup[1] as PromiseFulfilledResult<any>).value,pending);
    assert.equal(await prisma.returnRequest.count({where:{invoiceId:i.id}}),1);
    await assert.rejects(request(i,2,key),/conflict/);
    // Different invoice locks cannot serialize a shared operation key. Stage the
    // winner's actual INSERT while the other transaction attempts its UNIQUE insert.
    const left=await sale(0),right=await sale(0),collisionKey=randomUUID();
    let inserted!:()=>void,blocked!:()=>void,releaseInsert!:()=>void,inserts=0;
    const firstInserted=new Promise<void>(r=>inserted=r),secondBlocked=new Promise<void>(r=>blocked=r),insertGate=new Promise<void>(r=>releaseInsert=r);
    prisma.$transaction=((work: any,opts: any)=>originalTransaction(async (tx: any)=>work(new Proxy(tx,{get(target,key){
      if(key==="returnOperation")return {...tx.returnOperation,create:async(args: any)=>{
        const call=++inserts;if(call===2)blocked();const row=await tx.returnOperation.create(args);
        if(call===1){inserted();await insertGate;}return row;
      }};return Reflect.get(target,key);
    }})),{...opts,timeout:15000})) as any;
    const winner=request(left,1,collisionKey);await firstInserted;const loser=request(right,1,collisionKey);await secondBlocked;releaseInsert();
    const collision=await Promise.allSettled([winner,loser]);prisma.$transaction=originalTransaction;
    assert.equal(inserts,2);assert.equal(collision[0].status,"fulfilled");assert.equal(collision[1].status,"rejected");assert.match((collision[1] as PromiseRejectedResult).reason.message,/conflict/);
    assert.equal(await prisma.returnRequest.count({where:{invoiceId:right.id}}),0);assert.equal(await prisma.returnOperation.count({where:{operationKey:collisionKey}}),1);
    assert.equal(await prisma.auditLog.count({where:{action:"RETURN_REQUEST_CREATED",meta:{path:"$.invoiceId",equals:right.id}}}),0);
    const approvalKey=randomUUID(), approved=await approveReturnRequest(pending.id,actor.id,approvalKey);
    assert.equal(approved.settlement.debtReduction,300);assert.equal(approved.settlement.retainedCredit,0);
    assert.equal((await prisma.invoice.findUniqueOrThrow({where:{id:i.id}})).returnAdjustment,300);
    assert.equal(await prisma.payment.count({where:{invoiceId:i.id}}),1);
    const charge=await prisma.payment.findFirstOrThrow({where:{invoiceId:i.id,kind:"CHARGE"}});
    await assert.rejects(voidPayment(i.id,charge.id,actor.id),/audited credit correction/);
    await assert.rejects(cancelInvoice(i.id,actor.id),/return/i);
    const second=await request(i,5), secondApproved=await approveReturnRequest(second.id,actor.id,randomUUID());
    assert.equal(secondApproved.settlement.debtReduction,300);assert.equal(secondApproved.settlement.retainedCredit,200);
    await assert.rejects(reverseApprovedReturnRequest(pending.id,actor.id,undefined,randomUUID()),/later approved/);
    const reversalKey=randomUUID(),beforeStock=(await prisma.product.findUniqueOrThrow({where:{id:product.id}})).stock;
    await prisma.product.update({where:{id:product.id},data:{stock:0}});
    await assert.rejects(reverseApprovedReturnRequest(second.id,actor.id,undefined,reversalKey),/only 0/);
    assert.equal((await prisma.invoice.findUniqueOrThrow({where:{id:i.id}})).returnAdjustment,800);
    assert.equal(await prisma.returnOperation.count({where:{operationKey:reversalKey}}),0);
    await prisma.product.update({where:{id:product.id},data:{stock:beforeStock}});
    await reverseApprovedReturnRequest(second.id,actor.id,undefined,reversalKey);
    await reverseApprovedReturnRequest(pending.id,actor.id,undefined,randomUUID());
    assert.deepEqual(await approveReturnRequest(pending.id,actor.id,approvalKey),approved);
    assert.deepEqual(await request(i,3,key),pending);
    assert.equal((await prisma.invoice.findUniqueOrThrow({where:{id:i.id}})).returnAdjustment,0);

    const unpaid=await sale(0),unpaidRequest=await request(unpaid,3);await approveReturnRequest(unpaidRequest.id,actor.id,randomUUID());
    const zero=await sale(0,0,0),zeroRequest=await request(zero,10);await approveReturnRequest(zeroRequest.id,actor.id,randomUUID());
    assert.equal((await prisma.invoice.findUniqueOrThrow({where:{id:zero.id}})).paymentStatus,"PAID");
    const due=await listCustomerReceivables({q:customer.name},"MANAGER");assert.equal(due.items[0].due,3300);assert.equal(due.items[0].retainedCredit,0);
    await assert.rejects(listCustomerReceivables({},"CASHIER"),/access/);

    const failing=await sale(),failRequest=await request(failing,8),failedKey=randomUUID();
    const state=await prisma.invoice.findUniqueOrThrow({where:{id:failing.id}}), stock=(await prisma.product.findUniqueOrThrow({where:{id:product.id}})).stock, audits=await prisma.auditLog.count(), stocks=await prisma.stockTransaction.count();
    let staged=0;
    prisma.$transaction=((work: any,opts: any)=>originalTransaction(async (tx: any)=>work(new Proxy(tx,{get(target,key){
      if(key==="auditLog")return {...tx.auditLog,create:async(args: any)=>{await tx.auditLog.create(args);staged++;throw Error("Injected actual audit rollback");}};
      return Reflect.get(target,key);
    }})),opts)) as any;
    await assert.rejects(approveReturnRequest(failRequest.id,actor.id,failedKey),/audit rollback/);prisma.$transaction=originalTransaction;
    assert.equal(staged,1);assert.deepEqual(await prisma.invoice.findUniqueOrThrow({where:{id:failing.id}}),state);
    assert.equal((await prisma.product.findUniqueOrThrow({where:{id:product.id}})).stock,stock);assert.equal(await prisma.auditLog.count(),audits);assert.equal(await prisma.stockTransaction.count(),stocks);
    assert.equal((await prisma.returnRequest.findUniqueOrThrow({where:{id:failRequest.id}})).status,"PENDING");assert.equal(await prisma.returnOperation.count({where:{operationKey:failedKey}}),0);
    await approveReturnRequest(failRequest.id,actor.id,failedKey);
    const finalRemainder=await request(failing,2);const fullyReturned=await approveReturnRequest(finalRemainder.id,actor.id,randomUUID());
    assert.equal(fullyReturned.settlement.retainedCredit,200);assert.equal((await prisma.invoice.findUniqueOrThrow({where:{id:failing.id}})).returnAdjustment,1000);

    const competing=await sale(0),r=await request(competing,8);
    const overlap=await race(()=>approveReturnRequest(r.id,actor.id,randomUUID()),()=>addPayment(competing.id,"CASH",300,"SUCCESS",actor.id));
    assert.equal(overlap[0].status,"fulfilled");assert.equal(overlap[1].status,"rejected");assert.match((overlap[1] as PromiseRejectedResult).reason.message,/Overpayment/);
    const paymentFirst=await sale(0),rp=await request(paymentFirst,8);
    const opposite=await race(()=>addPayment(paymentFirst.id,"CASH",400,"SUCCESS",actor.id),()=>approveReturnRequest(rp.id,actor.id,randomUUID()));
    assert.ok(opposite.every(x=>x.status==="fulfilled"));assert.equal((opposite[1] as PromiseFulfilledResult<any>).value.settlement.retainedCredit,200);
    const gateway=await sale(0),rg=await request(gateway,3);await prisma.payment.create({data:{invoiceId:gateway.id,method:"ESEWA",kind:"CHARGE",status:"PENDING",amount:1000,createdById:actor.id}});
    await assert.rejects(approveReturnRequest(rg.id,actor.id,randomUUID()),/pending gateway/);
    const legacy=await sale();await prisma.returnRequest.create({data:{invoiceId:legacy.id,reason:"OTHER",status:"APPROVED",createdById:actor.id,refundAmount:0}});
    await assert.rejects(request(legacy,1),/legacy/);
    const rejected=await request(unpaid,1),rejectKey=randomUUID();const result=await rejectReturnRequest(rejected.id,actor.id,"No goods",rejectKey);
    assert.deepEqual(await rejectReturnRequest(rejected.id,actor.id,"No goods",rejectKey),result);
    assert.equal(await prisma.cashDrawerEvent.count(),cashEvents);assert.equal(await prisma.payment.count({where:{invoiceId:{in:invoices},kind:"REFUND"}}),0);
  } finally {
    prisma.$transaction=originalTransaction;
    await prisma.returnOperation.deleteMany({where:{actorId:actor.id}});await prisma.returnItem.deleteMany({where:{returnRequest:{invoiceId:{in:invoices}}}});await prisma.returnRequest.deleteMany({where:{invoiceId:{in:invoices}}});
    await prisma.stockTransaction.deleteMany({where:{createdById:actor.id}});await prisma.payment.deleteMany({where:{invoiceId:{in:invoices}}});await prisma.invoiceItem.deleteMany({where:{invoiceId:{in:invoices}}});await prisma.invoice.deleteMany({where:{id:{in:invoices}}});
    await prisma.auditLog.deleteMany({where:{actorId:actor.id}});await prisma.product.delete({where:{id:product.id}});await prisma.brand.delete({where:{id:brand.id}});await prisma.customer.delete({where:{id:customer.id}});await prisma.user.delete({where:{id:actor.id}});await prisma.$disconnect();
  }
});
