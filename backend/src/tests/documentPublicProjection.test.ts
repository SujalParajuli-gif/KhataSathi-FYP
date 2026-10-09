import test from "node:test";
import assert from "node:assert/strict";
import {
  toPublicDocument,
  getDocumentById,
  listDocuments,
  deleteDocument,
  updateDocumentVisibility,
  updateDocumentMetadata,
  linkDocumentsToEntity,
} from "../modules/documents/service";
import prisma from "../db/prisma";

const sentinelDate = new Date("2026-10-04T10:00:00.000Z");

function buildFullDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "doc-sentinel-123",
    documentType: "GENERAL" as const,
    title: "Supplier Delivery Note",
    fileName: "delivery_note.pdf",
    storedFileName: "doc-sentinel-123_general.pdf",
    storedPath: "documents/2026/10/W40",
    mimeType: "application/pdf",
    fileSize: 102400,
    checksum: "a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890",
    thumbnailFileName: "doc-sentinel-123.webp",
    thumbnailSize: 5120,
    supplierName: "Nepal Trading Suppliers",
    billNumber: "BILL-2083-99",
    billDate: sentinelDate,
    billAmount: 15500.5,
    remarks: "Signed upon delivery",
    linkedEntityType: "StockReceiveBatch",
    linkedEntityId: "srb-001",
    visibility: "ALL_AUTHENTICATED" as const,
    uploadedById: "user-uploader-1",
    createdAt: sentinelDate,
    deletedAt: null,
    deletedById: null,
    deleteReason: null,
    purgeAfter: null,
    saleRecoveryStatus: "UNRESOLVED" as const,
    recoveryCheckoutOperationKey: "recovery-opkey-9999",
    recoveryCheckoutPayloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    uploadedBy: {
      id: "user-uploader-1",
      name: "Suman Uploader",
    },
    ...overrides,
  };
}

test("toPublicDocument excludes recovery scalars while preserving existing API and file fields", () => {
  const row = buildFullDbRow();
  const projected = toPublicDocument(row, { includeProcessing: true });

  // Excluded recovery fields
  assert.equal("saleRecoveryStatus" in projected, false);
  assert.equal("recoveryCheckoutOperationKey" in projected, false);
  assert.equal("recoveryCheckoutPayloadHash" in projected, false);

  // Preserved business and storage fields
  assert.equal(projected.id, "doc-sentinel-123");
  assert.equal(projected.documentType, "GENERAL");
  assert.equal(projected.title, "Supplier Delivery Note");
  assert.equal(projected.fileName, "delivery_note.pdf");
  assert.equal(projected.storedFileName, "doc-sentinel-123_general.pdf");
  assert.equal(projected.storedPath, "documents/2026/10/W40");
  assert.equal(projected.mimeType, "application/pdf");
  assert.equal(projected.fileSize, 102400);
  assert.equal(projected.checksum, "a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890");
  assert.equal(projected.thumbnailFileName, "doc-sentinel-123.webp");
  assert.equal(projected.thumbnailSize, 5120);
  assert.equal(projected.supplierName, "Nepal Trading Suppliers");
  assert.equal(projected.billNumber, "BILL-2083-99");
  assert.equal(projected.billDate?.toISOString(), sentinelDate.toISOString());
  assert.equal(projected.billAmount, 15500.5);
  assert.equal(projected.remarks, "Signed upon delivery");
  assert.equal(projected.linkedEntityType, "StockReceiveBatch");
  assert.equal(projected.linkedEntityId, "srb-001");
  assert.equal(projected.visibility, "ALL_AUTHENTICATED");
  assert.equal(projected.uploadedById, "user-uploader-1");
  assert.equal(projected.createdAt.toISOString(), sentinelDate.toISOString());

  // Preserved selected uploader
  assert.deepEqual(projected.uploadedBy, {
    id: "user-uploader-1",
    name: "Suman Uploader",
  });

  // Processing fields
  assert.equal(projected.processingStatus, "PROCESSED");
  assert.equal(projected.processingLabel, "Linked to stock receive");
});

test("toPublicDocument handles absent uploader and raw delete responses without extra fields", () => {
  const rowWithoutUploader = buildFullDbRow({ uploadedBy: undefined });
  const projectedWithoutUploader = toPublicDocument(rowWithoutUploader);

  assert.equal("uploadedBy" in projectedWithoutUploader, false);
  assert.equal("processingStatus" in projectedWithoutUploader, false);
  assert.equal("processingLabel" in projectedWithoutUploader, false);
  assert.equal("saleRecoveryStatus" in projectedWithoutUploader, false);
  assert.equal("recoveryCheckoutOperationKey" in projectedWithoutUploader, false);
  assert.equal("recoveryCheckoutPayloadHash" in projectedWithoutUploader, false);
});

test("getDocumentById and listDocuments mask recovery fields across query responses", async () => {
  const documentDelegate = prisma.document as any;
  const originalFindFirst = documentDelegate.findFirst;
  const originalFindMany = documentDelegate.findMany;
  const originalCount = documentDelegate.count;

  const mockRow = buildFullDbRow();

  try {
    documentDelegate.findFirst = async () => mockRow;
    documentDelegate.findMany = async () => [mockRow];
    documentDelegate.count = async () => 1;

    const single = await getDocumentById("doc-sentinel-123", "ADMIN");
    assert.ok(single);
    assert.equal("saleRecoveryStatus" in single!, false);
    assert.equal("recoveryCheckoutOperationKey" in single!, false);
    assert.equal("recoveryCheckoutPayloadHash" in single!, false);
    assert.equal(single!.id, "doc-sentinel-123");
    assert.equal(single!.processingStatus, "PROCESSED");
    assert.equal(single!.uploadedBy?.name, "Suman Uploader");

    const list = await listDocuments({ page: 1, pageSize: 10 }, "ADMIN");
    assert.equal(list.total, 1);
    assert.equal(list.documents.length, 1);
    assert.equal("saleRecoveryStatus" in list.documents[0], false);
    assert.equal("recoveryCheckoutOperationKey" in list.documents[0], false);
    assert.equal("recoveryCheckoutPayloadHash" in list.documents[0], false);
    assert.equal(list.documents[0].id, "doc-sentinel-123");
  } finally {
    documentDelegate.findFirst = originalFindFirst;
    documentDelegate.findMany = originalFindMany;
    documentDelegate.count = originalCount;
  }
});

test("updateDocumentVisibility and updateDocumentMetadata protect no-change and changed responses", async () => {
  const documentDelegate = prisma.document as any;
  const auditDelegate = prisma.auditLog as any;

  const originalFindFirst = documentDelegate.findFirst;
  const originalFindUnique = documentDelegate.findUnique;
  const originalUpdate = documentDelegate.update;
  const originalUpdateMany = documentDelegate.updateMany;
  const originalAuditCreate = auditDelegate.create;

  const mockRow = buildFullDbRow();
  let currentRow = { ...mockRow };

  try {
    documentDelegate.findFirst = async () => currentRow;
    documentDelegate.findUnique = async () => currentRow;
    documentDelegate.updateMany = async ({ data }: any) => {
      currentRow = { ...currentRow, ...data };
      return { count: 1 };
    };
    documentDelegate.update = async ({ data }: any) => {
      currentRow = { ...currentRow, ...data };
      return currentRow;
    };
    auditDelegate.create = async () => ({ id: "audit-1" });

    // Visibility: no-change branch
    const visNoChange = await updateDocumentVisibility(
      "doc-sentinel-123",
      "ALL_AUTHENTICATED",
      "admin-1",
    );
    assert.equal(visNoChange.changed, false);
    assert.equal("saleRecoveryStatus" in visNoChange.document, false);
    assert.equal("recoveryCheckoutOperationKey" in visNoChange.document, false);
    assert.equal("recoveryCheckoutPayloadHash" in visNoChange.document, false);

    // Visibility: changed branch
    const visChanged = await updateDocumentVisibility(
      "doc-sentinel-123",
      "ADMIN_ONLY",
      "admin-1",
    );
    assert.equal(visChanged.changed, true);
    assert.equal("saleRecoveryStatus" in visChanged.document, false);
    assert.equal("recoveryCheckoutOperationKey" in visChanged.document, false);
    assert.equal("recoveryCheckoutPayloadHash" in visChanged.document, false);
    assert.equal(visChanged.document.visibility, "ADMIN_ONLY");

    // Metadata: no-change branch
    const metaNoChange = await updateDocumentMetadata(
      "doc-sentinel-123",
      { title: "Supplier Delivery Note" },
      "admin-1",
    );
    assert.equal(metaNoChange.changed, false);
    assert.equal("saleRecoveryStatus" in metaNoChange.document, false);
    assert.equal("recoveryCheckoutOperationKey" in metaNoChange.document, false);
    assert.equal("recoveryCheckoutPayloadHash" in metaNoChange.document, false);

    // Metadata: changed branch
    const metaChanged = await updateDocumentMetadata(
      "doc-sentinel-123",
      { title: "Updated Delivery Note Title" },
      "admin-1",
    );
    assert.equal(metaChanged.changed, true);
    assert.equal("saleRecoveryStatus" in metaChanged.document, false);
    assert.equal("recoveryCheckoutOperationKey" in metaChanged.document, false);
    assert.equal("recoveryCheckoutPayloadHash" in metaChanged.document, false);
    assert.equal(metaChanged.document.title, "Updated Delivery Note Title");
  } finally {
    documentDelegate.findFirst = originalFindFirst;
    documentDelegate.findUnique = originalFindUnique;
    documentDelegate.updateMany = originalUpdateMany;
    documentDelegate.update = originalUpdate;
    auditDelegate.create = originalAuditCreate;
  }
});

test("deleteDocument masks recovery fields and preserves raw delete response shape", async () => {
  const documentDelegate = prisma.document as any;
  const auditDelegate = prisma.auditLog as any;
  const originalFindFirst = documentDelegate.findFirst;
  const originalUpdateMany = documentDelegate.updateMany;
  const originalTransaction = prisma.$transaction;
  const originalAuditCreate = auditDelegate.create;

  const mockRow = buildFullDbRow();

  try {
    documentDelegate.findFirst = async () => mockRow;
    documentDelegate.updateMany = async () => ({ count: 1 });
    prisma.$transaction = (async (ops: any) => [{ count: 1 }, {}]) as any;
    auditDelegate.create = async () => ({ id: "audit-1" });

    const deleted = await deleteDocument("doc-sentinel-123", "admin-1", "ADMIN");
    assert.equal("saleRecoveryStatus" in deleted, false);
    assert.equal("recoveryCheckoutOperationKey" in deleted, false);
    assert.equal("recoveryCheckoutPayloadHash" in deleted, false);
    assert.equal("processingStatus" in deleted, false);
    assert.equal(deleted.id, "doc-sentinel-123");
    assert.equal(deleted.fileName, "delivery_note.pdf");
  } finally {
    documentDelegate.findFirst = originalFindFirst;
    documentDelegate.updateMany = originalUpdateMany;
    prisma.$transaction = originalTransaction;
    auditDelegate.create = originalAuditCreate;
  }
});
