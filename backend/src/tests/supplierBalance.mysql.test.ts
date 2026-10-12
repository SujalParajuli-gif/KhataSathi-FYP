import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../db/prisma";
import { getSupplierBalance, postFinancialPurchaseReceipt, recordPurchaseInstallment, voidPurchaseInstallment } from "../modules/inventory/purchases";

test("MySQL supplier balances reconcile nonempty sources across committed installments and voids", {
  skip: process.env.KHATASATHI_SUPPLIER_BALANCE_MYSQL_TEST !== "1", timeout: 90000,
}, async () => {
  const url = new URL(process.env.DATABASE_URL || "");
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
  assert.equal(url.port || "3306", "3306");
  assert.equal(url.pathname, "/ks_verify_mixed_credit_20261011");
  const writer = new PrismaClient(), original = prisma.$transaction.bind(prisma);
  const suppliers: string[] = [], batches: string[] = [];
  let actorId: string | undefined, brandId: string | undefined, productId: string | undefined;
  const snapshot = async () => JSON.stringify(await Promise.all([
    prisma.supplier.findMany({ orderBy: { id: "asc" } }),
    prisma.stockReceiveBatch.findMany({ orderBy: { id: "asc" } }),
    prisma.supplierPayment.findMany({ orderBy: { id: "asc" } }),
    prisma.stockTransaction.findMany({ orderBy: { id: "asc" } }),
    prisma.auditLog.findMany({ orderBy: { id: "asc" } }),
    prisma.product.findMany({ select: { id: true, stock: true }, orderBy: { id: "asc" } }),
  ]));
  const baseline = await snapshot();
  async function reconcile(supplierId: string) {
    const [known] = await prisma.$queryRaw<Array<{ payable: Prisma.Decimal; paid: Prisma.Decimal; count: bigint }>>`
      SELECT COALESCE(SUM(b.payable),0) payable, COUNT(*) count,
        COALESCE(SUM((SELECT COALESCE(SUM(p.amount),0) FROM SupplierPayment p WHERE p.batchId=b.id AND p.voidedAt IS NULL)),0) paid
      FROM StockReceiveBatch b WHERE b.supplierId=${supplierId} AND b.postedAt IS NOT NULL AND b.payable IS NOT NULL`;
    const [unknown] = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) count FROM StockReceiveBatch WHERE supplierId=${supplierId} AND (postedAt IS NULL OR payable IS NULL)`;
    const actual = await getSupplierBalance(supplierId, "MANAGER");
    assert.equal(actual.payable, new Prisma.Decimal(known.payable).toFixed(2));
    assert.equal(actual.paid, new Prisma.Decimal(known.paid).toFixed(2));
    assert.equal(actual.due, new Prisma.Decimal(known.payable).sub(known.paid).toFixed(2));
    assert.equal(actual.postedReceiptCount, Number(known.count));
    assert.equal(actual.unknownReceiptCount, Number(unknown.count));
    assert.equal(actual.recordedBalance, Number(unknown.count) ? null : actual.due);
    return actual;
  }
  async function overlap(supplierId: string, commit: () => Promise<void>) {
    let entered = 0, readerConnection = 0, writerConnection = 0;
    prisma.$transaction = ((work: any, opts: any) => {
      if (opts?.isolationLevel !== Prisma.TransactionIsolationLevel.RepeatableRead) {
        return writer.$transaction(async (tx: any) => {
          const [connection] = await tx.$queryRaw`SELECT CONNECTION_ID() id`;
          writerConnection = Number(connection.id);
          return work(tx);
        }, opts);
      }
      return original(async (tx: any) => {
        const [connection] = await tx.$queryRaw`SELECT CONNECTION_ID() id`;
        readerConnection = Number(connection.id);
        return work(new Proxy(tx, { get(target, key) {
          if (key !== "supplier") return Reflect.get(target, key);
          return { ...tx.supplier, findUnique: async (args: any) => {
            const row = await tx.supplier.findUnique(args); // establishes the actual InnoDB snapshot
            assert.equal(args.where.id, supplierId); entered++;
            await commit(); // real owning service commits before reader aggregates
            return row;
          } };
        } }));
      }, opts);
    }) as any;
    try {
      const result = await getSupplierBalance(supplierId, "ADMIN");
      assert.equal(entered, 1);
      assert.ok(readerConnection > 0 && writerConnection > 0);
      assert.notEqual(readerConnection, writerConnection);
      return result;
    } finally { prisma.$transaction = original; }
  }
  try {
    const suffix = randomUUID();
    const actor = await prisma.user.create({ data: { name: "Owned supplier proof", phone: `+97795${randomInt(10000000,99999999)}`, passwordHash: "unusable", role: "ADMIN" } }); actorId = actor.id;
    for (const label of ["Main", "Other", "Empty"]) {
      const supplier = await prisma.supplier.create({ data: { name: `${label} owned supplier ${suffix}` } }); suppliers.push(supplier.id);
    }
    const brand = await prisma.brand.create({ data: { name: `Owned supplier proof ${suffix}` } }); brandId = brand.id;
    const product = await prisma.product.create({ data: { name: "Owned supplier proof item", sku: suffix, brandId, stock: 0, saleUnit: "PIECE", packageUnit: "PIECE" } }); productId = product.id;
    const post = async (supplierId: string, amount: string) => {
      const receipt = await postFinancialPurchaseReceipt({ supplierId, payable: amount, billDate: "2026-10-12", operationKey: randomUUID(),
        lines: [{ productId: product.id, inputUnit: "PIECE", inputQty: "1", conversionFactor: "1", unitAcquisitionCost: amount }] }, actor.id, "ADMIN");
      batches.push(receipt.id); return receipt;
    };
    const first = await post(suppliers[0], "120.50"); await post(suppliers[0], "79.50"); await post(suppliers[1], "42.00");
    const pay = (amount: string) => recordPurchaseInstallment(first.id, { amount, method: "CASH", paidAt: "2026-10-12", operationKey: randomUUID() }, actor.id);
    await pay("30.00"); const voided = await pay("10.00");
    await voidPurchaseInstallment(voided.id, { voidReason: "Owned reconciliation void" }, actor.id);
    const initial = await reconcile(suppliers[0]);
    assert.deepEqual([initial.postedReceiptCount,initial.payable,initial.paid,initial.due,initial.recordedBalance], [2,"200.00","30.00","170.00","170.00"]);
    assert.equal((await reconcile(suppliers[1])).due, "42.00");
    const empty = await reconcile(suppliers[2]); assert.deepEqual([empty.postedReceiptCount,empty.due,empty.recordedBalance], [0,"0.00","0.00"]);
    await prisma.supplier.update({ where: { id: suppliers[0] }, data: { isActive: false } });
    const beforeReads = await snapshot();
    assert.equal((await reconcile(suppliers[0])).supplier.isActive, false);
    assert.equal(await snapshot(), beforeReads, "balance reads must not post stock, alter rows or audit");
    await prisma.supplier.update({ where: { id: suppliers[0] }, data: { isActive: true } });

    let concurrentPaymentId = "";
    const old = await overlap(suppliers[0], async () => {
      const payment = await pay("25.00"); concurrentPaymentId = payment.id;
      assert.equal((await writer.supplierPayment.findUniqueOrThrow({ where: { id: payment.id } })).voidedAt, null);
      assert.equal((await writer.supplierPayment.findUniqueOrThrow({ where: { id: payment.id } })).amount.toFixed(2), "25.00");
    });
    assert.deepEqual([old.paid,old.due], ["30.00","170.00"]);
    const committed = await reconcile(suppliers[0]); assert.deepEqual([committed.paid,committed.due], ["55.00","145.00"]);
    const beforeVoid = await overlap(suppliers[0], async () => {
      await voidPurchaseInstallment(concurrentPaymentId, { voidReason: "Owned snapshot void" }, actor.id);
      assert.ok((await writer.supplierPayment.findUniqueOrThrow({ where: { id: concurrentPaymentId } })).voidedAt);
    });
    assert.deepEqual([beforeVoid.paid,beforeVoid.due], ["55.00","145.00"]);
    const afterVoid = await reconcile(suppliers[0]); assert.deepEqual([afterVoid.paid,afterVoid.due], ["30.00","170.00"]);

    const name = initial.supplier.name;
    for (const data of [
      { supplierId: suppliers[0], payable: null, postedAt: new Date() },
      { supplierId: suppliers[0], payable: new Prisma.Decimal("999"), postedAt: null },
      { supplierId: null, payable: null, postedAt: null },
    ]) {
      const batch = await prisma.stockReceiveBatch.create({ data: { ...data, supplierName: name, billAmount: 999999, createdById: actor.id } }); batches.push(batch.id);
    }
    const unknown = await reconcile(suppliers[0]);
    assert.deepEqual([unknown.unknownReceiptCount,unknown.payable,unknown.paid,unknown.due,unknown.recordedBalance], [2,"200.00","30.00","170.00",null]);
    const finalBeforeReads = await snapshot(); await reconcile(suppliers[0]); await reconcile(suppliers[1]);
    assert.equal(await snapshot(), finalBeforeReads);
  } finally {
    prisma.$transaction = original;
    try {
    // Source IDs and actor belong exclusively to this run; existing rows remain untouched.
    if (actorId) {
      const owned = await prisma.stockReceiveBatch.findMany({ where: { createdById: actorId }, select: { id: true } });
      const ids = Array.from(new Set([...batches,...owned.map(b => b.id)]));
      await prisma.supplierPayment.deleteMany({ where: { batchId: { in: ids } } });
      await prisma.stockReceiveBatchItem.deleteMany({ where: { batchId: { in: ids } } });
      await prisma.stockTransaction.deleteMany({ where: { createdById: actorId } });
      await prisma.stockReceiveBatch.deleteMany({ where: { id: { in: ids } } });
      await prisma.auditLog.deleteMany({ where: { actorId } });
    }
    if (productId) await prisma.product.delete({ where: { id: productId } });
    if (brandId) await prisma.brand.delete({ where: { id: brandId } });
    await prisma.supplier.deleteMany({ where: { id: { in: suppliers } } });
    if (actorId) await prisma.user.delete({ where: { id: actorId } });
    assert.equal(await snapshot(), baseline, "all pre-existing source/stock/audit rows preserved after cleanup");
    } finally { await writer.$disconnect(); await prisma.$disconnect(); }
  }
});
