import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
import prisma from "../db/prisma";
import { postFinancialPurchaseReceipt, recordPurchaseInstallment, voidPurchaseInstallment, attachDocumentsToPurchaseReceipt, getFinancialPurchaseReceiptById } from "../modules/inventory/purchases";

test("MySQL purchase receipt/payment/claim races, replay and real rollback preserve stock and legacy authority", {
  skip: process.env.KHATASATHI_PHASE4_MYSQL_TEST !== "1", timeout: 90000,
}, async () => {
  const url = new URL(process.env.DATABASE_URL || "");
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
  assert.match(url.pathname, /^\/ks_verify_phase4_[a-z0-9_]+$/);
  const suffix = randomUUID();
  const actor = await prisma.user.create({ data: { name: "Owned purchase fixture", phone: `+97798${randomInt(10000000, 99999999)}`, passwordHash: "unusable", role: "ADMIN" } });
  const supplier = await prisma.supplier.create({ data: { name: `Owned supplier ${suffix}` } });
  const otherSupplier = await prisma.supplier.create({ data: { name: `Other owned supplier ${suffix}` } });
  const brand = await prisma.brand.create({ data: { name: `Owned purchase brand ${suffix}` } });
  const product = await prisma.product.create({ data: { name: "Owned purchase product", sku: `P4-${suffix}`, brandId: brand.id, saleUnit: "PIECE", packageUnit: "BOX", packageQuantity: 2, stock: 0 } });
  const otherProduct = await prisma.product.create({ data: { name: "Other owned product", sku: `P4B-${suffix}`, brandId: brand.id, saleUnit: "PIECE", packageUnit: "PIECE", stock: 0 } });
  const input = (extra: Record<string, unknown> = {}) => ({ supplierId: supplier.id, operationKey: randomUUID(), payable: "10.00", billDate: "2026-10-09",
    lines: [{ productId: product.id, inputUnit: "PIECE", inputQty: "1", conversionFactor: "1", unitAcquisitionCost: "10" }], ...extra });
  const doc = async () => prisma.document.create({ data: { documentType: "STOCK_BILL", title: "Owned staged bill", fileName: "owned.pdf", storedFileName: "owned.pdf", storedPath: "documents/owned", mimeType: "application/pdf", fileSize: 0, visibility: "ADMIN_MANAGER", uploadedById: actor.id } });
  const originalTransaction = prisma.$transaction.bind(prisma);
  async function race(table: string, first: () => Promise<unknown>, second: () => Promise<unknown>) {
    let held!: () => void, waiting!: () => void, release!: () => void; let calls = 0;
    const firstHeld = new Promise<void>(r => { held = r; }); const secondWaiting = new Promise<void>(r => { waiting = r; }); const gate = new Promise<void>(r => { release = r; });
    (prisma as any).$transaction = (work: any, opts: any) => originalTransaction(async tx => {
      const raw = tx.$queryRaw.bind(tx);
      return work(new Proxy(tx, { get(target, key) {
        if (key !== "$queryRaw") return Reflect.get(target, key);
        return async (query: TemplateStringsArray, ...values: any[]) => {
          const matches = query.join(" ").includes(`FROM ${table}`) && query.join(" ").includes("FOR UPDATE");
          const call = matches ? ++calls : 0;
          if (call === 2) waiting();
          const result = await raw(query, ...values);
          if (call === 1) { held(); await gate; }
          return result;
        };
      } }));
    }, { ...opts, timeout: 15000 });
    const operations: Promise<unknown>[] = [];
    try {
      operations.push(first()); await firstHeld;
      operations.push(second()); await secondWaiting; release();
      const results = await Promise.allSettled(operations); assert.ok(calls >= 2, "competing callers entered the actual locking branch"); return results;
    } finally { release(); await Promise.allSettled(operations); (prisma as any).$transaction = originalTransaction; }
  }
  try {
    const same = input();
    const sameRace = await race("Supplier", () => postFinancialPurchaseReceipt(same, actor.id, "ADMIN"), () => postFinancialPurchaseReceipt(same, actor.id, "ADMIN"));
    assert.ok(sameRace.every(r => r.status === "fulfilled"));
    assert.equal((sameRace[0] as PromiseFulfilledResult<any>).value.id, (sameRace[1] as PromiseFulfilledResult<any>).value.id);
    assert.equal(await prisma.stockReceiveBatch.count({ where: { operationKey: same.operationKey } }), 1);
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock, 1);
    await assert.rejects(postFinancialPurchaseReceipt({ ...same, payable: "11", lines: [{ ...same.lines[0], unitAcquisitionCost: "11" }] }, actor.id, "ADMIN"), /conflict/i);

    const receipt = (sameRace[0] as PromiseFulfilledResult<any>).value;
    const payment = () => recordPurchaseInstallment(receipt.id, { amount: "6", method: "CASH", paidAt: "2026-10-09", operationKey: randomUUID() }, actor.id);
    const overpayment = await race("StockReceiveBatch", payment, payment);
    assert.equal(overpayment.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(overpayment.filter(r => r.status === "rejected").length, 1);
    assert.equal((await getFinancialPurchaseReceiptById(receipt.id, "ADMIN")).paidTotal, "6.00");
    const successfulPayment = (overpayment.find(r => r.status === "fulfilled") as PromiseFulfilledResult<any>).value;
    await voidPurchaseInstallment(successfulPayment.id, { voidReason: "Owned fixture correction" }, actor.id);
    await voidPurchaseInstallment(successfulPayment.id, { voidReason: "No repeated financial effect" }, actor.id);
    assert.equal((await getFinancialPurchaseReceiptById(receipt.id, "ADMIN")).dueAmount, "10.00");

    const shared = await doc();
    const claimantA = input({ documentIds: [shared.id] });
    const claimantB = input({ supplierId: otherSupplier.id, documentIds: [shared.id], lines: [{ productId: otherProduct.id, inputUnit: "PIECE", inputQty: "1", conversionFactor: "1", unitAcquisitionCost: "10" }] });
    const claims = await race("Document", () => postFinancialPurchaseReceipt(claimantA, actor.id, "ADMIN"), () => postFinancialPurchaseReceipt(claimantB, actor.id, "ADMIN"));
    assert.equal(claims.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(claims.filter(r => r.status === "rejected").length, 1);
    assert.equal(await prisma.stockReceiveBatch.count({ where: { operationKey: { in: [claimantA.operationKey, claimantB.operationKey] } } }), 1);
    const linked = await prisma.document.findUniqueOrThrow({ where: { id: shared.id } });
    assert.equal(linked.documentType, "PURCHASE_BILL"); assert.equal(linked.visibility, "ADMIN_MANAGER");
    assert.ok(linked.linkedEntityId);
    const stock = (await prisma.product.findMany({ where: { id: { in: [product.id, otherProduct.id] } } })).reduce((s, p) => s + p.stock, 0);
    assert.equal(stock, 2, "losing document claim rolls back its stock increment");
    const attachedAgain = await attachDocumentsToPurchaseReceipt(linked.linkedEntityId!, [shared.id], actor.id, "ADMIN");
    assert.equal(attachedAgain.id, linked.linkedEntityId);

    const rollbackInput = input(); let stagedAudit = 0;
    const beforeStock = (await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock;
    const beforeAudits = await prisma.auditLog.count();
    (prisma as any).$transaction = (work: any, opts: any) => originalTransaction(async tx => work(new Proxy(tx, { get(target, key) {
      if (key !== "auditLog") return Reflect.get(target, key);
      return { ...tx.auditLog, create: async (args: any) => { await tx.auditLog.create(args); stagedAudit++; throw new Error("Owned injected audit rollback"); } };
    } })), opts);
    await assert.rejects(postFinancialPurchaseReceipt(rollbackInput, actor.id, "ADMIN"), /injected audit rollback/);
    assert.equal(stagedAudit, 1); (prisma as any).$transaction = originalTransaction;
    assert.equal(await prisma.stockReceiveBatch.count({ where: { operationKey: rollbackInput.operationKey } }), 0);
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock, beforeStock);
    assert.equal(await prisma.auditLog.count(), beforeAudits);

    const rollbackDoc = await doc(); const attachAuditCount = await prisma.auditLog.count(); let stagedClaim = 0;
    (prisma as any).$transaction = (work: any, opts: any) => originalTransaction(async tx => work(new Proxy(tx, { get(target, key) {
      if (key !== "document") return Reflect.get(target, key);
      return { ...tx.document, updateMany: async (args: any) => { const result = await tx.document.updateMany(args); stagedClaim += result.count; throw new Error("Owned injected claim rollback"); } };
    } })), opts);
    await assert.rejects(attachDocumentsToPurchaseReceipt(receipt.id, [rollbackDoc.id], actor.id, "ADMIN"), /injected claim rollback/);
    assert.equal(stagedClaim, 1); (prisma as any).$transaction = originalTransaction;
    assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: rollbackDoc.id } })).linkedEntityId, null);
    assert.equal(await prisma.auditLog.count(), attachAuditCount);
    await attachDocumentsToPurchaseReceipt(receipt.id, [rollbackDoc.id], actor.id, "ADMIN");
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock, beforeStock);

    const legacy = await getFinancialPurchaseReceiptById("phase4_migration_legacy_batch", "ADMIN");
    assert.equal(legacy.isFinancial, false); assert.equal(legacy.payable, null); assert.equal(legacy.paidTotal, null); assert.equal(legacy.dueAmount, null);
  } finally { (prisma as any).$transaction = originalTransaction; await prisma.$disconnect(); }
});
