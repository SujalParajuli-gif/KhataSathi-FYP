import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import { runDueBinPurge } from "../modules/bin/service";

test("runDueBinPurge purges only safe due records and writes a digest audit log", async () => {
  const now = new Date("2026-07-11T02:00:00.000Z");
  const originals = {
    findMany: prisma.softDeleteRecord.findMany,
    update: prisma.softDeleteRecord.update,
    rowDeleteMany: prisma.productImportRow.deleteMany,
    batchDeleteMany: prisma.productImportBatch.deleteMany,
    alertDeleteMany: prisma.userAlertRead.deleteMany,
    userFindFirst: prisma.user.findFirst,
    auditCreate: prisma.auditLog.create,
    transaction: prisma.$transaction,
  };
  const calls: any[] = [];
  let auditMeta: any = null;

  (prisma.softDeleteRecord as any).findMany = async (args: any) => {
    calls.push({ op: "softDeleteRecord.findMany", args });
    return [
      {
        id: "bin-1",
        entityType: "ProductImportBatch",
        entityId: "batch-1",
        entityLabel: "supplier.csv",
        purgeAfter: now,
        purgedAt: null,
      },
    ];
  };
  (prisma.productImportRow as any).deleteMany = (args: any) => {
    calls.push({ op: "productImportRow.deleteMany", args });
    return Promise.resolve({ count: 2 });
  };
  (prisma.productImportBatch as any).deleteMany = (args: any) => {
    calls.push({ op: "productImportBatch.deleteMany", args });
    return Promise.resolve({ count: 1 });
  };
  (prisma.softDeleteRecord as any).update = (args: any) => {
    calls.push({ op: "softDeleteRecord.update", args });
    return Promise.resolve(args.data);
  };
  (prisma as any).$transaction = async (operations: Array<Promise<unknown>>) =>
    Promise.all(operations);
  (prisma.userAlertRead as any).deleteMany = async (args: any) => {
    calls.push({ op: "userAlertRead.deleteMany", args });
    return { count: 3 };
  };
  (prisma.user as any).findFirst = async () => ({ id: "admin-1" });
  (prisma.auditLog as any).create = async ({ data }: any) => {
    auditMeta = data.meta;
    calls.push({ op: "auditLog.create", data });
    return data;
  };

  try {
    const result = await runDueBinPurge(now);

    assert.equal(result.productImportBatches, 1);
    assert.equal(result.documents, 0);
    assert.equal(result.alerts, 3);
    assert.equal(result.failed, 0);

    const findCall = calls.find((call) => call.op === "softDeleteRecord.findMany");
    assert.deepEqual(findCall.args.where.entityType.in, ["Document", "ProductImportBatch"]);
    assert.deepEqual(findCall.args.where.purgeAfter, { lte: now });
    assert.equal(findCall.args.where.purgedAt, null);

    assert.ok(calls.some((call) => call.op === "productImportRow.deleteMany"));
    assert.ok(calls.some((call) => call.op === "productImportBatch.deleteMany"));
    assert.ok(calls.some((call) => call.op === "softDeleteRecord.update"));
    assert.equal(auditMeta.purgedProductImportBatches, 1);
    assert.equal(auditMeta.purgedAlerts, 3);
    assert.equal(auditMeta.failedCount, 0);
  } finally {
    (prisma.softDeleteRecord as any).findMany = originals.findMany;
    (prisma.softDeleteRecord as any).update = originals.update;
    (prisma.productImportRow as any).deleteMany = originals.rowDeleteMany;
    (prisma.productImportBatch as any).deleteMany = originals.batchDeleteMany;
    (prisma.userAlertRead as any).deleteMany = originals.alertDeleteMany;
    (prisma.user as any).findFirst = originals.userFindFirst;
    (prisma.auditLog as any).create = originals.auditCreate;
    (prisma as any).$transaction = originals.transaction;
  }
});
