import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
import prisma from "../db/prisma";
import { savePurchaseReview, type ReviewState } from "../modules/inventory/purchaseReview";

test("MySQL purchase review locks competing saves and rolls back actual JSON/audit writes", { skip: process.env.KHATASATHI_PHASE5_MYSQL_TEST !== "1", timeout: 60000 }, async () => {
  const url = new URL(process.env.DATABASE_URL || ""); assert.ok(["localhost", "127.0.0.1"].includes(url.hostname)); assert.equal(url.pathname, "/ks_verify_phase4_20261009");
  const actor = await prisma.user.create({ data: { name: "Owned OCR review fixture", phone: `+97798${randomInt(10000000, 99999999)}`, passwordHash: "unusable", role: "ADMIN" } });
  const observations = { supplierName: "Owned source", billNumber: null, billDate: null, payable: "40", lines: [{ name: "Unresolved printed product", code: null, unit: null, quantity: null, cost: null }] };
  const review: ReviewState = { version: 1, revision: randomUUID(), extractionId: randomUUID(), operationKey: randomUUID(), sourceSha256: "test-source", model: "test-reader", extractedAt: new Date().toISOString(), observations, warnings: ["Product unresolved"], corrected: null };
  const document = await prisma.document.create({ data: { uploadedById: actor.id, documentType: "PURCHASE_BILL", visibility: "ADMIN_MANAGER", fileName: "owned.png", storedFileName: "owned.png", storedPath: "documents/owned", mimeType: "image/png", fileSize: 0, purchaseReview: review as any } });
  const corrected = { ...observations, supplierId: null, lines: observations.lines.map(l => ({ ...l, productId: null })) };
  const original = prisma.$transaction.bind(prisma);
  const businessCounts = { stock: await prisma.stockTransaction.count(), receipts: await prisma.stockReceiveBatch.count(), payments: await prisma.supplierPayment.count() };
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let held!: () => void; const firstHeld = new Promise<void>(r => { held = r; }); let waiting!: () => void; const secondWaiting = new Promise<void>(r => { waiting = r; }); let lockCalls = 0;
  (prisma as any).$transaction = (work: any) => original(async tx => {
    const raw = tx.$queryRaw.bind(tx);
    return work(new Proxy(tx, { get(target, key) { if (key !== "$queryRaw") return Reflect.get(target, key);
      return async (query: any, ...values: any[]) => { const call = ++lockCalls; if (call === 2) waiting(); const result = await raw(query, ...values); if (call === 1) { held(); await gate; } return result; };
    } }));
  }, { timeout: 15000 });
  const operations: Promise<any>[] = [];
  try {
    operations.push(savePurchaseReview(document.id, "ADMIN", actor.id, { expectedRevision: review.revision, corrected: { ...corrected, payable: "41" } })); await firstHeld;
    operations.push(savePurchaseReview(document.id, "MANAGER", actor.id, { expectedRevision: review.revision, corrected: { ...corrected, payable: "42" } })); await secondWaiting; release();
    const results = await Promise.allSettled(operations); assert.equal(lockCalls, 2); assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(results.filter(r => r.status === "rejected").length, 1);
    assert.equal((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason.status, 409);
    assert.equal(await prisma.auditLog.count({ where: { entityId: document.id, action: "PURCHASE_OCR_REVIEW_SAVED" } }), 1);
    (prisma as any).$transaction = original;
    const before = await prisma.document.findUniqueOrThrow({ where: { id: document.id } }); const saved = before.purchaseReview as unknown as ReviewState;
    const replay = await savePurchaseReview(document.id, "ADMIN", actor.id, { expectedRevision: review.revision, corrected: saved.corrected! });
    assert.equal(replay.review!.revision, saved.revision, "MySQL canonical JSON key ordering retains exact-save replay");
    assert.equal(await prisma.auditLog.count({ where: { entityId: document.id, action: "PURCHASE_OCR_REVIEW_SAVED" } }), 1);
    let staged = 0; let inserted = 0;
    (prisma as any).$transaction = (work: any) => original(async tx => work(new Proxy(tx, { get(target, key) {
      if (key === "document") return new Proxy(target.document, { get(delegate, member) { if (member !== "update") return Reflect.get(delegate, member); return async (args: any) => { const value = await delegate.update(args); staged++; return value; }; } });
      if (key === "auditLog") return new Proxy(target.auditLog, { get(delegate, member) { if (member !== "create") return Reflect.get(delegate, member); return async (args: any) => { await delegate.create(args); inserted++; throw Error("Owned audit rollback injection"); }; } });
      return Reflect.get(target, key);
    } })));
    await assert.rejects(savePurchaseReview(document.id, "ADMIN", actor.id, { expectedRevision: saved.revision, corrected: { ...corrected, payable: "43" } }), /Owned audit rollback/);
    assert.equal(staged, 1); assert.equal(inserted, 1); assert.deepEqual((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).purchaseReview, before.purchaseReview);
    assert.equal(await prisma.auditLog.count({ where: { entityId: document.id, action: "PURCHASE_OCR_REVIEW_SAVED" } }), 1);
    assert.deepEqual({ stock: await prisma.stockTransaction.count(), receipts: await prisma.stockReceiveBatch.count(), payments: await prisma.supplierPayment.count() }, businessCounts);
  } finally {
    release(); await Promise.allSettled(operations); (prisma as any).$transaction = original;
    await prisma.auditLog.deleteMany({ where: { entityId: document.id } }); await prisma.document.delete({ where: { id: document.id } }); await prisma.user.delete({ where: { id: actor.id } }); await prisma.$disconnect();
  }
});
