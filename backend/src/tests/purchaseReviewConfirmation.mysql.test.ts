import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
import prisma from "../db/prisma";
import { confirmPurchaseReview, savePurchaseReview, getPurchaseReview, type ReviewState } from "../modules/inventory/purchaseReview";
import { postFinancialPurchaseReceipt } from "../modules/inventory/purchases";

test("MySQL reviewed purchase confirmation stock-once, competing decisions/save and real outcome rollback", { skip: process.env.KHATASATHI_PHASE5_CONFIRM_MYSQL_TEST !== "1", timeout: 90000 }, async () => {
  const url = new URL(process.env.DATABASE_URL || ""); assert.ok(["localhost", "127.0.0.1"].includes(url.hostname)); assert.equal(Number(url.port || 3306), 3306); assert.equal(url.pathname, "/ks_verify_phase4_20261009");
  const suffix = randomUUID();
  const actor = await prisma.user.create({ data: { name: "Owned confirmation fixture", phone: `+97798${randomInt(10000000,99999999)}`, passwordHash: "unusable", role: "ADMIN" } });
  const supplier = await prisma.supplier.create({ data: { name: `Owned review supplier ${suffix}` } });
  const brand = await prisma.brand.create({ data: { name: `Owned review brand ${suffix}` } });
  const product = await prisma.product.create({ data: { name: "Owned reviewed product", sku: `P5-${suffix}`, brandId: brand.id, saleUnit: "PIECE", packageUnit: "BOX", packageQuantity: 3, stock: 0 } });
  const facts = { supplierName: supplier.name, supplierId: supplier.id, billDate: "2026-10-09", billNumber: "Owned B25", payable: "25.00", lines: [{ name: product.name, code: product.sku, unit: "BOX", quantity: "2", cost: "10", conversionFactor: "3", productId: product.id }, { name: product.name, code: product.sku, unit: "PIECE", quantity: "1", cost: "5", conversionFactor: "1", productId: product.id }] };
  async function document(extra: any = {}) {
    const review: ReviewState = { version: 1, revision: randomUUID(), extractionId: randomUUID(), operationKey: randomUUID(), sourceSha256: "owned-source", model: "stub", extractedAt: new Date().toISOString(), observations: { supplierName: null, billNumber: null, billDate: null, payable: null, lines: [] }, warnings: ["Human corrected uncertain source"], corrected: facts };
    return prisma.document.create({ data: { documentType: "PURCHASE_BILL", uploadedById: actor.id, visibility: "ADMIN_MANAGER", fileName: "owned.png", storedFileName: "owned.png", storedPath: "documents/owned", mimeType: "image/png", fileSize: 0, purchaseReview: review as any, ...extra } });
  }
  const create = (doc: any) => ({ action: "create" as const, expectedRevision: doc.purchaseReview.revision, reason: "Reviewed duplicates; distinct purchase" });
  const original = prisma.$transaction.bind(prisma);
  async function race(first: () => Promise<any>, second: () => Promise<any>) {
    let held!: () => void, waiting!: () => void, release!: () => void; let locks = 0;
    const firstHeld = new Promise<void>(r => held = r), secondWaiting = new Promise<void>(r => waiting = r), gate = new Promise<void>(r => release = r);
    (prisma as any).$transaction = (work: any, opts: any) => original(async tx => { const raw = tx.$queryRaw.bind(tx); return work(new Proxy(tx, { get(target, key) { if (key !== "$queryRaw") return Reflect.get(target, key); return async (query: TemplateStringsArray, ...values: any[]) => {
      const call = /FROM Document.*FOR UPDATE/.test(query.join(" ")) ? ++locks : 0; if (call === 2) waiting(); const result = await raw(query, ...values); if (call === 1) { held(); await gate; } return result;
    }; } })); }, { ...opts, timeout: 15000 });
    const operations: Promise<any>[] = [];
    try { operations.push(first()); await firstHeld; operations.push(second()); await secondWaiting; release(); const result = await Promise.allSettled(operations); assert.ok(locks >= 2); return result; }
    finally { release(); await Promise.allSettled(operations); (prisma as any).$transaction = original; }
  }
  try {
    const doc: any = await document(); const input = create(doc);
    const first = await confirmPurchaseReview(doc.id, "ADMIN", actor.id, input); const receiptId = first.review!.resolution!.receiptId;
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock, 7);
    assert.equal(await prisma.stockReceiveBatchItem.count({ where: { batchId: receiptId } }), 2, "different acquisition lines remain distinct");
    await confirmPurchaseReview(doc.id, "ADMIN", actor.id, input); assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock, 7);
    await assert.rejects(confirmPurchaseReview(doc.id, "ADMIN", actor.id, { ...input, reason: "Changed decision" }), (e: any) => e.status === 409);
    assert.ok((await getPurchaseReview(doc.id, "MANAGER")).review!.resolution);
    await prisma.document.update({ where: { id: doc.id }, data: { visibility: "ADMIN_ONLY" } }); await assert.rejects(getPurchaseReview(doc.id, "MANAGER"), (e: any) => e.status === 404);
    const linked: any = await document(); const before = { stock: (await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock, movements: await prisma.stockTransaction.count(), payments: await prisma.supplierPayment.count(), receipts: await prisma.stockReceiveBatch.count() };
    const attachInput = { action: "attach" as const, expectedRevision: linked.purchaseReview.revision, receiptId, reason: "Inspected matching purchase" };
    await confirmPurchaseReview(linked.id, "MANAGER", actor.id, attachInput); await confirmPurchaseReview(linked.id, "MANAGER", actor.id, attachInput);
    assert.deepEqual({ stock: (await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock, movements: await prisma.stockTransaction.count(), payments: await prisma.supplierPayment.count(), receipts: await prisma.stockReceiveBatch.count() }, before);
    const contested: any = await document(); const choices = await race(() => confirmPurchaseReview(contested.id, "ADMIN", actor.id, create(contested)), () => confirmPurchaseReview(contested.id, "ADMIN", actor.id, { ...attachInput, expectedRevision: contested.purchaseReview.revision }));
    assert.equal(choices.filter(r => r.status === "fulfilled").length, 1); assert.equal(choices.filter(r => r.status === "rejected").length, 1); assert.equal(await prisma.auditLog.count({ where: { entityId: contested.id, action: "PURCHASE_OCR_CONFIRMED" } }), 1);
    const saveRace: any = await document(); const outcomes = await race(() => savePurchaseReview(saveRace.id, "ADMIN", actor.id, { expectedRevision: saveRace.purchaseReview.revision, corrected: { ...facts, payable: "26" } }), () => confirmPurchaseReview(saveRace.id, "ADMIN", actor.id, create(saveRace)));
    assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1); assert.equal(outcomes.filter(r => r.status === "rejected").length, 1); assert.equal((outcomes.find(r => r.status === "rejected") as PromiseRejectedResult).reason.status, 409);
    const manualRace: any = await document(); const manual = { supplierId: supplier.id, payable: "25", operationKey: randomUUID(), documentIds: [manualRace.id], lines: facts.lines.map(l => ({ productId: l.productId, inputUnit: l.unit, inputQty: l.quantity, conversionFactor: l.conversionFactor, unitAcquisitionCost: l.cost })) };
    const manualOutcomes = await race(() => confirmPurchaseReview(manualRace.id, "ADMIN", actor.id, { ...attachInput, expectedRevision: manualRace.purchaseReview.revision }), () => postFinancialPurchaseReceipt(manual, actor.id, "ADMIN")); assert.equal(manualOutcomes.filter(r => r.status === "fulfilled").length, 1);
    const rollbackAttachment: any = await document();
    const rollback: any = await document(); const beforeRollback = { stock: (await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock, receipts: await prisma.stockReceiveBatch.count(), audits: await prisma.auditLog.count() }; let written = 0; let audited = 0;
    (prisma as any).$transaction = (work: any, opts: any) => original(async tx => work(new Proxy(tx, { get(target, key) {
      if (key === "document") return new Proxy(target.document, { get(delegate, member) { if (member !== "update") return Reflect.get(delegate, member); return async (args: any) => { const result = await delegate.update(args); if (args.data.purchaseReview?.resolution) written++; return result; }; } });
      if (key === "auditLog") return new Proxy(target.auditLog, { get(delegate, member) { if (member !== "create") return Reflect.get(delegate, member); return async (args: any) => { const result = await delegate.create(args); if (args.data.action === "PURCHASE_OCR_CONFIRMED") { audited++; throw Error("Owned outcome audit rollback"); } return result; }; } });
      return Reflect.get(target, key);
    } })), opts);
    await assert.rejects(confirmPurchaseReview(rollback.id, "ADMIN", actor.id, create(rollback)), /Owned outcome audit rollback/); assert.equal(written, 1); assert.equal(audited, 1);
    await assert.rejects(confirmPurchaseReview(rollbackAttachment.id, "ADMIN", actor.id, { ...attachInput, expectedRevision: rollbackAttachment.purchaseReview.revision }), /Owned outcome audit rollback/); assert.equal(written, 2); assert.equal(audited, 2);
    assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: rollbackAttachment.id } })).linkedEntityId, null);
    (prisma as any).$transaction = original;
    assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: rollback.id } })).linkedEntityId, null); assert.deepEqual((await prisma.document.findUniqueOrThrow({ where: { id: rollback.id } })).purchaseReview, rollback.purchaseReview);
    assert.deepEqual({ stock: (await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock, receipts: await prisma.stockReceiveBatch.count(), audits: await prisma.auditLog.count() }, beforeRollback);
    await confirmPurchaseReview(rollback.id, "ADMIN", actor.id, create(rollback)); assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock, beforeRollback.stock + 7);
  } finally {
    (prisma as any).$transaction = original;
    // Exact owned fixture actor and catalog IDs only; no shared/configured data cleanup.
    await prisma.auditLog.deleteMany({ where: { actorId: actor.id } }); await prisma.document.deleteMany({ where: { uploadedById: actor.id } });
    await prisma.stockTransaction.deleteMany({ where: { createdById: actor.id } });
    await prisma.stockReceiveBatchItem.deleteMany({ where: { batch: { createdById: actor.id } } }); await prisma.stockReceiveBatch.deleteMany({ where: { createdById: actor.id } });
    await prisma.product.delete({ where: { id: product.id } }); await prisma.brand.delete({ where: { id: brand.id } }); await prisma.supplier.delete({ where: { id: supplier.id } }); await prisma.user.delete({ where: { id: actor.id } }); await prisma.$disconnect();
  }
});
