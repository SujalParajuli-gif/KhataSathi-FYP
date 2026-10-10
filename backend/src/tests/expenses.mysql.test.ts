import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
import prisma from "../db/prisma";
import { createExpense, correctExpense, voidExpense, getExpense } from "../modules/expenses/service";

test("MySQL expenses: duplicate-create and locked corrections overlap; actual revision/audit rollback and unrelated finance stay intact", {
  skip: process.env.KHATASATHI_EXPENSE_MYSQL_TEST !== "1", timeout: 90000,
}, async () => {
  const url = new URL(process.env.DATABASE_URL || "");
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname)); assert.equal(Number(url.port || 3306), 3306); assert.equal(url.pathname, "/ks_verify_expenses_20261010");
  const actors = await Promise.all(["ADMIN", "MANAGER"].map(role => prisma.user.create({ data: { name: "Owned expense fixture", phone: `+97798${randomInt(10000000, 99999999)}`, passwordHash: "unusable", role } })));
  const originalTransaction = prisma.$transaction.bind(prisma);
  const input = (extra: any = {}) => ({ amount: "10.20", occurredOn: "2026-10-10", category: "Utilities", description: "Owned fixture", operationKey: randomUUID(), ...extra });
  const finance = async () => Promise.all([prisma.payment.count(), prisma.supplierPayment.count(), prisma.stockTransaction.count(), prisma.cashDrawerEvent.count(), prisma.invoice.count()]);
  const beforeFinance = await finance();
  async function race(first: () => Promise<any>, second: () => Promise<any>, locking: boolean) {
    let held!: () => void, waiting!: () => void, release!: () => void, calls = 0;
    const firstHeld = new Promise<void>(r => held = r), secondWaiting = new Promise<void>(r => waiting = r), gate = new Promise<void>(r => release = r);
    prisma.$transaction = ((work: any, opts: any) => originalTransaction(async (tx: any) => work(new Proxy(tx, { get(target, key) {
      if (locking && key === "$queryRaw") return async (query: TemplateStringsArray, ...values: any[]) => {
        const call = ++calls; if (call === 2) waiting(); const result = await tx.$queryRaw(query, ...values);
        if (call === 1) { held(); await gate; } return result;
      };
      if (!locking && key === "expenseRevision") return { ...tx.expenseRevision, findUnique: async (args: any) => {
        const row = await tx.expenseRevision.findUnique(args), call = ++calls;
        if (call === 1) { held(); await gate; } else if (call === 2) waiting(); return row;
      } };
      return Reflect.get(target, key);
    } })), { ...opts, timeout: 15000 })) as any;
    const operations: Promise<any>[] = [];
    try { operations.push(first()); await firstHeld; operations.push(second()); await secondWaiting; release(); const result = await Promise.allSettled(operations); assert.ok(calls >= 2); return result; }
    finally { release(); await Promise.allSettled(operations); prisma.$transaction = originalTransaction; }
  }
  try {
    const same = input({ amount: "999999999999999999.99" });
    const duplicates = await race(() => createExpense(same, actors[0].id, "ADMIN"), () => createExpense(same, actors[0].id, "ADMIN"), false);
    assert.ok(duplicates.every(r => r.status === "fulfilled"));
    const created = (duplicates[0] as PromiseFulfilledResult<any>).value; assert.deepEqual((duplicates[1] as PromiseFulfilledResult<any>).value, created);
    assert.equal(await prisma.expense.count({ where: { id: created.expenseId } }), 1);
    assert.equal(await prisma.expenseRevision.count({ where: { expenseId: created.expenseId } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { entityId: created.expenseId } }), 1);
    assert.equal((await getExpense(created.expenseId, "MANAGER")).amount, "999999999999999999.99");
    await assert.rejects(createExpense(same, actors[1].id, "MANAGER"), /conflict/);
    await assert.rejects(createExpense({ ...same, amount: "1" }, actors[0].id, "ADMIN"), /conflict/);
    const correction = input({ amount: "20.01", expectedRevision: 1, reason: "Corrected receipt" });
    const competing = await race(() => correctExpense(created.expenseId, correction, actors[0].id, "ADMIN"), () => correctExpense(created.expenseId, { ...correction, operationKey: randomUUID(), amount: "30" }, actors[1].id, "MANAGER"), true);
    assert.equal(competing.filter(r => r.status === "fulfilled").length, 1); assert.equal(competing.filter(r => r.status === "rejected").length, 1);
    assert.match((competing.find(r => r.status === "rejected") as PromiseRejectedResult).reason.message, /reload/);
    assert.equal((await getExpense(created.expenseId, "ADMIN")).revision, 2);
    let stagedAudit = 0; const before = await getExpense(created.expenseId, "ADMIN"), auditCount = await prisma.auditLog.count();
    prisma.$transaction = ((work: any, opts: any) => originalTransaction(async (tx: any) => work(new Proxy(tx, { get(target, key) {
      if (key === "auditLog") return { ...tx.auditLog, create: async (args: any) => { await tx.auditLog.create(args); stagedAudit++; throw new Error("Injected expense audit rollback"); } };
      return Reflect.get(target, key);
    } })), opts)) as any;
    const failed = input({ amount: "22", expectedRevision: 2, reason: "Rollback fixture" });
    await assert.rejects(correctExpense(created.expenseId, failed, actors[0].id, "ADMIN"), /audit rollback/);
    await assert.rejects(createExpense(input({ operationKey: "owned-rollback-create" }), actors[0].id, "ADMIN"), /audit rollback/);
    assert.equal(stagedAudit, 2); prisma.$transaction = originalTransaction;
    assert.deepEqual(await getExpense(created.expenseId, "ADMIN"), before); assert.equal(await prisma.auditLog.count(), auditCount);
    assert.equal(await prisma.expenseRevision.count({ where: { operationKey: { in: [failed.operationKey, "owned-rollback-create"] } } }), 0);
    assert.equal(await prisma.expense.count({ where: { createdById: actors[0].id } }), 1);
    const voidInput = { operationKey: randomUUID(), expectedRevision: 2, reason: "Duplicate receipt void" };
    const voidRace = await race(() => voidExpense(created.expenseId, voidInput, actors[0].id, "ADMIN"), () => correctExpense(created.expenseId, failed, actors[1].id, "MANAGER"), true);
    assert.equal(voidRace.filter(r => r.status === "fulfilled").length, 1); assert.equal(voidRace.filter(r => r.status === "rejected").length, 1);
    const final = await getExpense(created.expenseId, "MANAGER"); assert.equal(final.status, "VOIDED"); assert.equal(final.revisions.length, 3);
    assert.equal(final.revisions[0].amount, same.amount); assert.equal(final.revisions[1].amount, "20.01"); assert.equal(final.revisions[2].reason, voidInput.reason);
    assert.deepEqual(await createExpense(same, actors[0].id, "ADMIN"), created);
    assert.deepEqual(await correctExpense(created.expenseId, correction, actors[0].id, "ADMIN"), { expenseId: created.expenseId, revision: 2, action: "CORRECT" });
    await assert.rejects(correctExpense(created.expenseId, { ...failed, expectedRevision: 3 }, actors[0].id, "ADMIN"), /reload/);
    await assert.rejects(voidExpense("different-target", voidInput, actors[0].id, "ADMIN"), /conflict/);
    await assert.rejects(voidExpense(created.expenseId, { ...voidInput, operationKey: same.operationKey }, actors[0].id, "ADMIN"), /conflict/);
    assert.deepEqual(await finance(), beforeFinance);
  } finally {
    prisma.$transaction = originalTransaction;
    const actorIds = actors.map(a => a.id), rows = await prisma.expense.findMany({ where: { createdById: { in: actorIds } }, select: { id: true } });
    await prisma.expenseRevision.deleteMany({ where: { expenseId: { in: rows.map(r => r.id) } } });
    await prisma.expense.deleteMany({ where: { id: { in: rows.map(r => r.id) } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: actorIds } } });
    await prisma.user.deleteMany({ where: { id: { in: actorIds } } }); await prisma.$disconnect();
  }
});
