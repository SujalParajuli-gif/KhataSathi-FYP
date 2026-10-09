import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import { getDocumentById, getDocumentForFileAccess, listDocuments, deleteDocument, updateDocumentMetadata, updateDocumentVisibility } from "../modules/documents/service";

const row: any = { id: "purchase-proof", documentType: "PURCHASE_BILL", visibility: "ALL_AUTHENTICATED", deletedAt: null,
  uploadedBy: { id: "admin", name: "Admin" }, storedPath: "documents/private", storedFileName: "secret.pdf", fileName: "bill.pdf", checksum: "private-hash",
  title: "Purchase bill", thumbnailFileName: "private.webp", billAmount: 10, linkedEntityType: null, linkedEntityId: null,
  createdAt: new Date(), uploadedById: "admin" };

test("purchase metadata and file access enforce role/capability despite forged broad visibility", async () => {
  const original = prisma.document.findFirst;
  (prisma.document as any).findFirst = async () => row;
  try {
    for (const read of [getDocumentById, getDocumentForFileAccess]) {
      for (const role of ["STAFF", "CASHIER", undefined]) assert.equal(await read(row.id, role, { capabilities: { inventoryEnabled: true } }), null);
      assert.equal(await read(row.id, "MANAGER", { capabilities: { inventoryEnabled: false } }), null);
    }
    const dto = await getDocumentById(row.id, "MANAGER", { capabilities: { inventoryEnabled: true } });
    assert.ok(dto); assert.equal(dto.storedPath, undefined); assert.equal(dto.storedFileName, undefined); assert.equal(dto.checksum, undefined);
    const file = await getDocumentForFileAccess(row.id, "MANAGER", { capabilities: { inventoryEnabled: true } });
    assert.equal(file?.storedPath, row.storedPath);
    row.visibility = "ADMIN_ONLY";
    assert.equal(await getDocumentById(row.id, "MANAGER", { capabilities: { inventoryEnabled: true } }), null);
    assert.equal(await getDocumentForFileAccess(row.id, "MANAGER", { capabilities: { inventoryEnabled: true } }), null);
  } finally { row.visibility = "ALL_AUTHENTICATED"; prisma.document.findFirst = original; }
});

test("general document query excludes purchase proof before count and pagination", async () => {
  const originals = [prisma.document.findMany, prisma.document.count]; const seen: any[] = [];
  (prisma.document as any).findMany = async (args: any) => { seen.push(args.where); return []; };
  (prisma.document as any).count = async (args: any) => { seen.push(args.where); return 0; };
  try {
    await listDocuments({ page: 1, pageSize: 20 } as any, "CASHIER", { capabilities: { inventoryEnabled: true } });
    assert.equal(seen.length, 2); assert.deepEqual(seen[0], seen[1]);
    assert.match(JSON.stringify(seen[0]), /PURCHASE_BILL/); assert.match(JSON.stringify(seen[0]), /notIn/);
    seen.length = 0;
    await listDocuments({ page: 1, pageSize: 20, documentType: "PURCHASE_BILL" } as any, "MANAGER", { capabilities: { inventoryEnabled: false } });
    assert.deepEqual(seen[0].documentType, { in: [] });
  } finally { [prisma.document.findMany, prisma.document.count] = originals as any; }
});

test("private purchase mutation denies before classification and writes", async () => {
  const original = prisma.document.findFirst; let writes = 0; const update = prisma.document.updateMany;
  (prisma.document as any).findFirst = async () => ({ ...row, visibility: "ADMIN_ONLY" });
  (prisma.document as any).updateMany = async () => { writes++; return { count: 1 }; };
  try {
    await assert.rejects(deleteDocument(row.id, "manager", "MANAGER"), /Document not found/);
    await assert.rejects(updateDocumentMetadata(row.id, { title: "changed" } as any, "manager", "MANAGER"), /Document not found/);
    await assert.rejects(updateDocumentVisibility(row.id, "ALL_AUTHENTICATED", "manager", "MANAGER"), /Document not found/);
    assert.equal(writes, 0);
  } finally { prisma.document.findFirst = original; prisma.document.updateMany = update; }
});

test("conditional delete miss cannot commit a phantom Bin record", async () => {
  const find = prisma.document.findFirst; const transaction = prisma.$transaction;
  let updateCalls = 0; let binCalls = 0; let committed = false;
  (prisma.document as any).findFirst = async () => ({ ...row, documentType: "GENERAL", visibility: "ADMIN_MANAGER" });
  (prisma as any).$transaction = async (callback: (tx: any) => Promise<unknown>) => {
    const result = await callback({ document: { updateMany: async () => { updateCalls++; return { count: 0 }; } },
      softDeleteRecord: { create: async () => { binCalls++; } } });
    committed = true; return result;
  };
  try {
    await assert.rejects(deleteDocument(row.id, "admin", "ADMIN"), /concurrently/);
    assert.equal(updateCalls, 1); assert.equal(binCalls, 0); assert.equal(committed, false);
  } finally { prisma.document.findFirst = find; prisma.$transaction = transaction; }
});
