import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import prisma from "../db/prisma";
const isolatedStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ks-bin-purge-"));
process.env.DOCUMENT_STORAGE_ROOT = isolatedStorageRoot;
const { documentStorageRoot } = require("../lib/storageReadiness") as typeof import("../lib/storageReadiness");
assert.equal(documentStorageRoot, isolatedStorageRoot);
const { runDueBinPurge } = require("../modules/bin/service") as typeof import("../modules/bin/service");
after(() => fs.rmSync(isolatedStorageRoot, { recursive: true, force: true }));

test("runDueBinPurge purges only safe due records and writes a digest audit log", async () => {
  const now = new Date("2026-07-11T02:00:00.000Z");
  const originals = {
    findMany: prisma.softDeleteRecord.findMany,
    update: prisma.softDeleteRecord.update,
    rowDeleteMany: prisma.productImportRow.deleteMany,
    batchFindUnique: prisma.productImportBatch.findUnique,
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
  (prisma.productImportBatch as any).findUnique = async () => null;
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
    assert.equal(result.protectedDocuments, 0);
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
    assert.equal(auditMeta.protectedDocuments, 0);
    assert.equal(auditMeta.purgedAlerts, 3);
    assert.equal(auditMeta.failedCount, 0);
  } finally {
    (prisma.softDeleteRecord as any).findMany = originals.findMany;
    (prisma.softDeleteRecord as any).update = originals.update;
    (prisma.productImportRow as any).deleteMany = originals.rowDeleteMany;
    (prisma.productImportBatch as any).findUnique = originals.batchFindUnique;
    (prisma.productImportBatch as any).deleteMany = originals.batchDeleteMany;
    (prisma.userAlertRead as any).deleteMany = originals.alertDeleteMany;
    (prisma.user as any).findFirst = originals.userFindFirst;
    (prisma.auditLog as any).create = originals.auditCreate;
    (prisma as any).$transaction = originals.transaction;
  }
});

test("runDueBinPurge retains SALE_BILL evidence (snapshot & live), purges safe records, and logs separate protected count", async () => {
  const now = new Date("2026-07-11T02:00:00.000Z");
  const originals = {
    findMany: prisma.softDeleteRecord.findMany,
    update: prisma.softDeleteRecord.update,
    docFindUnique: prisma.document.findUnique,
    docDelete: prisma.document.delete,
    docDeleteMany: prisma.document.deleteMany,
    rowDeleteMany: prisma.productImportRow.deleteMany,
    batchFindUnique: prisma.productImportBatch.findUnique,
    batchDeleteMany: prisma.productImportBatch.deleteMany,
    alertDeleteMany: prisma.userAlertRead.deleteMany,
    userFindFirst: prisma.user.findFirst,
    auditCreate: prisma.auditLog.create,
    transaction: prisma.$transaction,
  };

  const updatedRecordIds: string[] = [];
  let auditMeta: any = null;

  (prisma.softDeleteRecord as any).findMany = async () => [
    // 1. Protected by snapshot
    {
      id: "bin-doc-sale-snap",
      entityType: "Document",
      entityId: "doc-sale-1",
      entityLabel: "Sale Bill 1",
      entitySnapshot: { documentType: "SALE_BILL" },
      purgeAfter: now,
      purgedAt: null,
    },
    // 2. Protected by live row (generic snapshot)
    {
      id: "bin-doc-sale-live",
      entityType: "Document",
      entityId: "doc-sale-2",
      entityLabel: "Sale Bill 2",
      entitySnapshot: { documentType: "GENERAL" },
      purgeAfter: now,
      purgedAt: null,
    },
    // 3. Safe ordinary document
    {
      id: "bin-doc-generic",
      entityType: "Document",
      entityId: "doc-generic-1",
      entityLabel: "Supplier Invoice",
      entitySnapshot: { documentType: "STOCK_BILL" },
      purgeAfter: now,
      purgedAt: null,
    },
    // 4. Safe product import batch
    {
      id: "bin-batch-1",
      entityType: "ProductImportBatch",
      entityId: "batch-1",
      entityLabel: "import.csv",
      purgeAfter: now,
      purgedAt: null,
    },
    // 5. Failing document
    {
      id: "bin-doc-fail",
      entityType: "Document",
      entityId: "doc-fail-1",
      entityLabel: "Failing Document",
      entitySnapshot: { documentType: "GENERAL" },
      purgeAfter: now,
      purgedAt: null,
    },
  ];

  (prisma.document as any).findUnique = async ({ where }: any) => {
    if (where.id === "doc-sale-2") {
      return {
        id: "doc-sale-2",
        documentType: "SALE_BILL",
        storedPath: "documents/2026/10/W40",
        storedFileName: "sale2.jpg",
      };
    }
    if (where.id === "doc-generic-1") {
      return {
        id: "doc-generic-1",
        documentType: "STOCK_BILL",
        storedPath: "documents/2026/10/W40",
        storedFileName: "stock1.pdf",
      };
    }
    if (where.id === "doc-fail-1") {
      throw new Error("Disk I/O error during deletion");
    }
    return null;
  };

  (prisma.document as any).delete = async () => ({});
  (prisma.document as any).deleteMany = async () => ({ count: 1 });
  (prisma.softDeleteRecord as any).update = async ({ where }: any) => {
    updatedRecordIds.push(where.id);
    return {};
  };
  (prisma.productImportBatch as any).findUnique = async () => null;
  (prisma.productImportRow as any).deleteMany = async () => ({ count: 0 });
  (prisma.productImportBatch as any).deleteMany = async () => ({ count: 1 });
  (prisma as any).$transaction = async (ops: any) => Promise.all(ops);
  (prisma.userAlertRead as any).deleteMany = async () => ({ count: 2 });
  (prisma.user as any).findFirst = async () => ({ id: "admin-1" });
  (prisma.auditLog as any).create = async ({ data }: any) => {
    auditMeta = data.meta;
    return data;
  };

  try {
    const result = await runDueBinPurge(now);

    assert.equal(result.protectedDocuments, 2);
    assert.equal(result.documents, 1);
    assert.equal(result.productImportBatches, 1);
    assert.equal(result.alerts, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].recordId, "bin-doc-fail");

    // Only safe generic doc and batch had softDeleteRecord updated to purged
    assert.deepEqual(updatedRecordIds, ["bin-doc-generic", "bin-batch-1"]);

    assert.equal(auditMeta.protectedDocuments, 2);
    assert.equal(auditMeta.purgedDocuments, 1);
    assert.equal(auditMeta.purgedProductImportBatches, 1);
    assert.equal(auditMeta.failedCount, 1);
  } finally {
    (prisma.softDeleteRecord as any).findMany = originals.findMany;
    (prisma.softDeleteRecord as any).update = originals.update;
    (prisma.document as any).findUnique = originals.docFindUnique;
    (prisma.document as any).delete = originals.docDelete;
    (prisma.document as any).deleteMany = originals.docDeleteMany;
    (prisma.productImportRow as any).deleteMany = originals.rowDeleteMany;
    (prisma.productImportBatch as any).findUnique = originals.batchFindUnique;
    (prisma.productImportBatch as any).deleteMany = originals.batchDeleteMany;
    (prisma.userAlertRead as any).deleteMany = originals.alertDeleteMany;
    (prisma.user as any).findFirst = originals.userFindFirst;
    (prisma.auditLog as any).create = originals.auditCreate;
    (prisma as any).$transaction = originals.transaction;
  }
});

test("runDueBinPurge pages past >100 retained records to process later eligible candidates without starvation", async () => {
  const now = new Date("2026-07-11T02:00:00.000Z");
  const originals = {
    findMany: prisma.softDeleteRecord.findMany,
    update: prisma.softDeleteRecord.update,
    rowDeleteMany: prisma.productImportRow.deleteMany,
    batchFindUnique: prisma.productImportBatch.findUnique,
    batchDeleteMany: prisma.productImportBatch.deleteMany,
    alertDeleteMany: prisma.userAlertRead.deleteMany,
    userFindFirst: prisma.user.findFirst,
    auditCreate: prisma.auditLog.create,
    transaction: prisma.$transaction,
  };

  // 105 retained SALE_BILL records + 1 ordinary ProductImportBatch
  const allRecords: any[] = [];
  for (let i = 1; i <= 105; i++) {
    const pad = String(i).padStart(3, "0");
    allRecords.push({
      id: `bin-sale-${pad}`,
      entityType: "Document",
      entityId: `doc-sale-${pad}`,
      entityLabel: `Sale Bill ${pad}`,
      entitySnapshot: { documentType: "SALE_BILL" },
      purgeAfter: now,
      purgedAt: null,
    });
  }
  allRecords.push({
    id: "bin-batch-106",
    entityType: "ProductImportBatch",
    entityId: "batch-106",
    entityLabel: "final_import.csv",
    purgeAfter: now,
    purgedAt: null,
  });

  const queryCalls: any[] = [];
  const purgedRecordIds: string[] = [];

  (prisma.softDeleteRecord as any).findMany = async (args: any) => {
    queryCalls.push(args);
    let startIndex = 0;
    if (args.cursor) {
      const cursorIdx = allRecords.findIndex((r) => r.id === args.cursor.id);
      startIndex = cursorIdx + (args.skip || 0);
    }
    return allRecords.slice(startIndex, startIndex + args.take);
  };

  (prisma.softDeleteRecord as any).update = async ({ where }: any) => {
    purgedRecordIds.push(where.id);
    return {};
  };
  (prisma.productImportBatch as any).findUnique = async () => null;
  (prisma.productImportRow as any).deleteMany = async () => ({ count: 0 });
  (prisma.productImportBatch as any).deleteMany = async () => ({ count: 1 });
  (prisma as any).$transaction = async (ops: any) => Promise.all(ops);
  (prisma.userAlertRead as any).deleteMany = async () => ({ count: 0 });
  (prisma.user as any).findFirst = async () => ({ id: "admin-1" });
  (prisma.auditLog as any).create = async () => ({});

  try {
    const result = await runDueBinPurge(now);

    assert.equal(result.protectedDocuments, 105);
    assert.equal(result.productImportBatches, 1);
    assert.equal(result.failed, 0);
    assert.deepEqual(purgedRecordIds, ["bin-batch-106"]);

    // Must have paged at least twice (page 1: 100 items, page 2: 6 items)
    assert.equal(queryCalls.length, 2);
    assert.equal(queryCalls[0].take, 100);
    assert.equal(queryCalls[0].cursor, undefined);
    assert.deepEqual(queryCalls[1].cursor, { id: "bin-sale-100" });
    assert.equal(queryCalls[1].skip, 1);
  } finally {
    (prisma.softDeleteRecord as any).findMany = originals.findMany;
    (prisma.softDeleteRecord as any).update = originals.update;
    (prisma.productImportRow as any).deleteMany = originals.rowDeleteMany;
    (prisma.productImportBatch as any).findUnique = originals.batchFindUnique;
    (prisma.productImportBatch as any).deleteMany = originals.batchDeleteMany;
    (prisma.userAlertRead as any).deleteMany = originals.alertDeleteMany;
    (prisma.user as any).findFirst = originals.userFindFirst;
    (prisma.auditLog as any).create = originals.auditCreate;
    (prisma as any).$transaction = originals.transaction;
  }
});

test("runDueBinPurge caps destructive attempts at 100", async () => {
  const now = new Date("2026-07-11T02:00:00.000Z");
  const originals = {
    findMany: prisma.softDeleteRecord.findMany,
    update: prisma.softDeleteRecord.update,
    rowDeleteMany: prisma.productImportRow.deleteMany,
    batchFindUnique: prisma.productImportBatch.findUnique,
    batchDeleteMany: prisma.productImportBatch.deleteMany,
    alertDeleteMany: prisma.userAlertRead.deleteMany,
    userFindFirst: prisma.user.findFirst,
    auditCreate: prisma.auditLog.create,
    transaction: prisma.$transaction,
  };

  // 120 ordinary product import batches
  const allRecords: any[] = [];
  for (let i = 1; i <= 120; i++) {
    const pad = String(i).padStart(3, "0");
    allRecords.push({
      id: `bin-batch-${pad}`,
      entityType: "ProductImportBatch",
      entityId: `batch-${pad}`,
      entityLabel: `import_${pad}.csv`,
      purgeAfter: now,
      purgedAt: null,
    });
  }

  (prisma.softDeleteRecord as any).findMany = async (args: any) => {
    let startIndex = 0;
    if (args.cursor) {
      const cursorIdx = allRecords.findIndex((r) => r.id === args.cursor.id);
      startIndex = cursorIdx + (args.skip || 0);
    }
    return allRecords.slice(startIndex, startIndex + args.take);
  };

  (prisma.softDeleteRecord as any).update = async () => ({});
  (prisma.productImportBatch as any).findUnique = async () => null;
  (prisma.productImportRow as any).deleteMany = async () => ({ count: 0 });
  (prisma.productImportBatch as any).deleteMany = async () => ({ count: 1 });
  (prisma as any).$transaction = async (ops: any) => Promise.all(ops);
  (prisma.userAlertRead as any).deleteMany = async () => ({ count: 0 });
  (prisma.user as any).findFirst = async () => ({ id: "admin-1" });
  (prisma.auditLog as any).create = async () => ({});

  try {
    const result = await runDueBinPurge(now);

    // Exactly 100 attempted and processed
    assert.equal(result.productImportBatches, 100);
    assert.equal(result.failed, 0);
    let failedAttempts = 0;
    (prisma.productImportBatch as any).findUnique = async () => {
      failedAttempts += 1;
      throw new Error("Synthetic ordinary purge failure");
    };
    const failures = await runDueBinPurge(now);
    assert.equal(failedAttempts, 100);
    assert.equal(failures.failed, 100);
    assert.equal(failures.failures.length, 100);
    assert.equal(failures.productImportBatches, 0);
  } finally {
    (prisma.softDeleteRecord as any).findMany = originals.findMany;
    (prisma.softDeleteRecord as any).update = originals.update;
    (prisma.productImportRow as any).deleteMany = originals.rowDeleteMany;
    (prisma.productImportBatch as any).findUnique = originals.batchFindUnique;
    (prisma.productImportBatch as any).deleteMany = originals.batchDeleteMany;
    (prisma.userAlertRead as any).deleteMany = originals.alertDeleteMany;
    (prisma.user as any).findFirst = originals.userFindFirst;
    (prisma.auditLog as any).create = originals.auditCreate;
    (prisma as any).$transaction = originals.transaction;
  }
});
