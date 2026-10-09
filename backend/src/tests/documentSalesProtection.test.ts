import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import os from "os";
import fsSync from "node:fs";
import prisma from "../db/prisma";
import {
  SaleEvidenceProtectedError,
  isSaleEvidenceDocumentType,
  isSaleEvidenceSnapshot,
  assertNotSaleEvidenceDocument,
} from "../modules/documents/protection";
const isolatedStorageRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "ks-sales-protection-"));
process.env.DOCUMENT_STORAGE_ROOT = isolatedStorageRoot;
const { documentStorageRoot } = require("../lib/storageReadiness") as typeof import("../lib/storageReadiness");
assert.equal(documentStorageRoot, isolatedStorageRoot);
after(() => fs.rm(isolatedStorageRoot, { recursive: true, force: true }));

const {
  createDocuments,
  deleteDocument,
  updateDocumentVisibility,
  updateDocumentMetadata,
  assertDocumentsCanLinkToEntity,
  linkDocumentsToEntity,
  restoreDocument,
  permanentlyDeleteDocument,
} = require("../modules/documents/service") as typeof import("../modules/documents/service");
const {
  restoreBinRecord,
  permanentlyDeleteBinRecord,
} = require("../modules/bin/service") as typeof import("../modules/bin/service");
const {
  deleteDocumentHandler,
  updateDocumentVisibilityHandler,
  updateDocumentMetadataHandler,
} = require("../modules/documents/controller") as typeof import("../modules/documents/controller");
const {
  restore: binRestoreHandler,
  purge: binPurgeHandler,
} = require("../modules/bin/controller") as typeof import("../modules/bin/controller");
import type { DocumentType, SaleRecoveryStatus } from "@prisma/client";

function buildSaleBillRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "doc-sale-bill-100",
    documentType: "SALE_BILL" as DocumentType,
    title: "Sale Invoice Bill Proof",
    fileName: "sale_receipt_001.jpg",
    storedFileName: "doc-sale-bill-100_sale-bill.jpg",
    storedPath: "documents/2026/10/W40",
    mimeType: "image/jpeg",
    fileSize: 204800,
    checksum: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    thumbnailFileName: "doc-sale-bill-100.webp",
    thumbnailSize: 8192,
    supplierName: null,
    billNumber: "POS-2083-001",
    billDate: new Date("2026-10-04T08:00:00.000Z"),
    billAmount: 4500.0,
    remarks: "Direct register POS bill",
    linkedEntityType: null,
    linkedEntityId: null,
    visibility: "ALL_AUTHENTICATED" as const,
    uploadedById: "user-cashier-1",
    createdAt: new Date("2026-10-04T08:00:00.000Z"),
    deletedAt: null,
    deletedById: null,
    deleteReason: null,
    purgeAfter: null,
    saleRecoveryStatus: "UNRESOLVED" as SaleRecoveryStatus,
    recoveryCheckoutOperationKey: "opkey-pos-001",
    recoveryCheckoutPayloadHash: "hash-pos-001",
    uploadedBy: {
      id: "user-cashier-1",
      name: "Cashier Ram",
    },
    ...overrides,
  };
}

function mockResponse() {
  const res: any = {
    statusCode: 200,
    jsonData: null,
    headers: {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: any) {
      res.jsonData = data;
      return res;
    },
    setHeader(key: string, val: string) {
      res.headers[key] = val;
      return res;
    },
  };
  return res;
}

test("protection helper predicates and error contract", () => {
  assert.equal(isSaleEvidenceDocumentType("SALE_BILL"), true);
  assert.equal(isSaleEvidenceDocumentType("GENERAL"), false);
  assert.equal(isSaleEvidenceDocumentType(null), false);
  assert.equal(isSaleEvidenceDocumentType(undefined), false);

  assert.equal(isSaleEvidenceSnapshot({ documentType: "SALE_BILL" }), true);
  assert.equal(isSaleEvidenceSnapshot({ documentType: "STOCK_BILL" }), false);
  assert.equal(isSaleEvidenceSnapshot(null), false);
  assert.equal(isSaleEvidenceSnapshot("string"), false);
  assert.equal(isSaleEvidenceSnapshot([]), false);

  assert.throws(
    () => assertNotSaleEvidenceDocument("SALE_BILL"),
    (err: any) =>
      err instanceof SaleEvidenceProtectedError &&
      err.code === "SALE_EVIDENCE_PROTECTED" &&
      err.status === 409,
  );

  assert.throws(
    () => assertNotSaleEvidenceDocument({ documentType: "SALE_BILL" }),
    (err: any) =>
      err instanceof SaleEvidenceProtectedError &&
      err.code === "SALE_EVIDENCE_PROTECTED" &&
      err.status === 409,
  );

  assert.doesNotThrow(() => assertNotSaleEvidenceDocument("STOCK_BILL"));
  assert.doesNotThrow(() => assertNotSaleEvidenceDocument({ documentType: "GENERAL" }));
});

test("createDocuments rejects SALE_BILL input before file or storage mutation", async () => {
  const documentDelegate = prisma.document as any;
  const originalCreate = documentDelegate.create;
  let createCalled = false;

  try {
    documentDelegate.create = async () => {
      createCalled = true;
      throw new Error("Should not reach DB create");
    };

    await assert.rejects(
      async () => {
        await createDocuments(
          [
            {
              originalname: "bill.jpg",
              mimetype: "image/jpeg",
              size: 1000,
              path: "/tmp/fake.jpg",
            },
          ],
          {
            documentType: "SALE_BILL" as any,
          },
          "user-1",
        );
      },
      (err: any) =>
        err instanceof SaleEvidenceProtectedError &&
        err.code === "SALE_EVIDENCE_PROTECTED" &&
        err.status === 409,
    );

    assert.equal(createCalled, false);
  } finally {
    documentDelegate.create = originalCreate;
  }
});

test("deleteDocument protects SALE_BILL across all four recovery states (null, UNRESOLVED, ATTACHED, ARCHIVED) and linked/unlinked states", async () => {
  const documentDelegate = prisma.document as any;
  const auditDelegate = prisma.auditLog as any;
  const originalFindFirst = documentDelegate.findFirst;
  const originalTransaction = prisma.$transaction;
  const originalAuditCreate = auditDelegate.create;

  const recoveryStates: Array<SaleRecoveryStatus | null> = [
    null,
    "UNRESOLVED",
    "ATTACHED",
    "ARCHIVED",
  ];

  let txCalled = false;
  let auditCalled = false;

  try {
    prisma.$transaction = (async () => {
      txCalled = true;
      throw new Error("Transaction should not be called");
    }) as any;
    auditDelegate.create = async () => {
      auditCalled = true;
      return {};
    };

    for (const status of recoveryStates) {
      for (const linked of [false, true]) {
        const mockRow = buildSaleBillRow({
          saleRecoveryStatus: status,
          linkedEntityType: linked ? "Invoice" : null,
          linkedEntityId: linked ? "inv-100" : null,
        });

        documentDelegate.findFirst = async () => mockRow;

        await assert.rejects(
          async () => {
            await deleteDocument("doc-sale-bill-100", "admin-1", "ADMIN");
          },
          (err: any) =>
            err instanceof SaleEvidenceProtectedError &&
            err.code === "SALE_EVIDENCE_PROTECTED" &&
            err.status === 409,
        );

        assert.equal(txCalled, false);
        assert.equal(auditCalled, false);
      }
    }
  } finally {
    documentDelegate.findFirst = originalFindFirst;
    prisma.$transaction = originalTransaction;
    auditDelegate.create = originalAuditCreate;
  }
});

test("deleteDocument preserves 404 for hidden or nonexistent SALE_BILL documents before protection check", async () => {
  const documentDelegate = prisma.document as any;
  const originalFindFirst = documentDelegate.findFirst;

  try {
    // Nonexistent
    documentDelegate.findFirst = async () => null;
    await assert.rejects(
      async () => {
        await deleteDocument("doc-missing", "admin-1", "ADMIN");
      },
      /Document not found/,
    );

    // Hidden from Cashier
    const hiddenDoc = buildSaleBillRow({ visibility: "ADMIN_ONLY" });
    documentDelegate.findFirst = async () => hiddenDoc;
    await assert.rejects(
      async () => {
        await deleteDocument("doc-sale-bill-100", "cashier-1", "CASHIER");
      },
      /Document not found/,
    );
  } finally {
    documentDelegate.findFirst = originalFindFirst;
  }
});

test("updateDocumentVisibility rejects SALE_BILL for both changed and no-op updates without DB or audit writes", async () => {
  const documentDelegate = prisma.document as any;
  const auditDelegate = prisma.auditLog as any;
  const originalFindFirst = documentDelegate.findFirst;
  const originalUpdate = documentDelegate.update;
  const originalAuditCreate = auditDelegate.create;

  let updateCalled = false;
  let auditCalled = false;

  try {
    const mockRow = buildSaleBillRow({ visibility: "ALL_AUTHENTICATED" });
    documentDelegate.findFirst = async () => mockRow;
    documentDelegate.update = async () => {
      updateCalled = true;
      return mockRow;
    };
    auditDelegate.create = async () => {
      auditCalled = true;
      return {};
    };

    // No-op visibility update
    await assert.rejects(
      async () => {
        await updateDocumentVisibility("doc-sale-bill-100", "ALL_AUTHENTICATED", "admin-1");
      },
      (err: any) =>
        err instanceof SaleEvidenceProtectedError &&
        err.code === "SALE_EVIDENCE_PROTECTED",
    );

    // Changed visibility update
    await assert.rejects(
      async () => {
        await updateDocumentVisibility("doc-sale-bill-100", "ADMIN_ONLY", "admin-1");
      },
      (err: any) =>
        err instanceof SaleEvidenceProtectedError &&
        err.code === "SALE_EVIDENCE_PROTECTED",
    );

    assert.equal(updateCalled, false);
    assert.equal(auditCalled, false);
  } finally {
    documentDelegate.findFirst = originalFindFirst;
    documentDelegate.update = originalUpdate;
    auditDelegate.create = originalAuditCreate;
  }
});

test("updateDocumentMetadata rejects SALE_BILL edits and prevents generic documents from converting to SALE_BILL", async () => {
  const documentDelegate = prisma.document as any;
  const auditDelegate = prisma.auditLog as any;
  const originalFindFirst = documentDelegate.findFirst;
  const originalUpdate = documentDelegate.update;
  const originalAuditCreate = auditDelegate.create;

  let updateCalled = false;
  let auditCalled = false;

  try {
    const saleBillRow = buildSaleBillRow();
    documentDelegate.findFirst = async () => saleBillRow;
    documentDelegate.update = async () => {
      updateCalled = true;
      return saleBillRow;
    };
    auditDelegate.create = async () => {
      auditCalled = true;
      return {};
    };

    // Attempting edit on existing SALE_BILL (even no-op)
    await assert.rejects(
      async () => {
        await updateDocumentMetadata("doc-sale-bill-100", { title: "Sale Invoice Bill Proof" }, "admin-1");
      },
      (err: any) =>
        err instanceof SaleEvidenceProtectedError &&
        err.code === "SALE_EVIDENCE_PROTECTED",
    );

    // Attempting to convert SALE_BILL into GENERAL
    await assert.rejects(
      async () => {
        await updateDocumentMetadata("doc-sale-bill-100", { documentType: "GENERAL" as any }, "admin-1");
      },
      (err: any) =>
        err instanceof SaleEvidenceProtectedError &&
        err.code === "SALE_EVIDENCE_PROTECTED",
    );

    // Attempting to convert GENERAL into SALE_BILL
    const generalRow = { ...saleBillRow, documentType: "GENERAL" as DocumentType };
    documentDelegate.findFirst = async () => generalRow;

    await assert.rejects(
      async () => {
        await updateDocumentMetadata("doc-general-100", { documentType: "SALE_BILL" as any }, "admin-1");
      },
      (err: any) =>
        err instanceof SaleEvidenceProtectedError &&
        err.code === "SALE_EVIDENCE_PROTECTED",
    );

    assert.equal(updateCalled, false);
    assert.equal(auditCalled, false);
  } finally {
    documentDelegate.findFirst = originalFindFirst;
    documentDelegate.update = originalUpdate;
    auditDelegate.create = originalAuditCreate;
  }
});

test("assertDocumentsCanLinkToEntity and linkDocumentsToEntity reject SALE_BILL input and existing SALE_BILL rows", async () => {
  const documentDelegate = prisma.document as any;
  const originalFindMany = documentDelegate.findMany;

  try {
    // Input documentType is SALE_BILL
    await assert.rejects(
      async () => {
        await assertDocumentsCanLinkToEntity({
          documentIds: ["doc-1"],
          documentType: "SALE_BILL" as any,
          linkedEntityType: "StockReceiveBatch",
        });
      },
      (err: any) =>
        err instanceof SaleEvidenceProtectedError &&
        err.code === "SALE_EVIDENCE_PROTECTED",
    );

    // One of the resolved docs is SALE_BILL
    const saleBillRow = buildSaleBillRow({ id: "doc-1", visibility: "ALL_AUTHENTICATED" });
    documentDelegate.findMany = async () => [saleBillRow];

    await assert.rejects(
      async () => {
        await assertDocumentsCanLinkToEntity({
          documentIds: ["doc-1"],
          documentType: "STOCK_BILL" as any,
          linkedEntityType: "StockReceiveBatch",
          viewerRole: "ADMIN",
        });
      },
      (err: any) =>
        err instanceof SaleEvidenceProtectedError &&
        err.code === "SALE_EVIDENCE_PROTECTED",
    );
  } finally {
    documentDelegate.findMany = originalFindMany;
  }
});

test("restoreDocument and restoreBinRecord reject SALE_BILL evidence and leave DB/bin/audit untouched", async () => {
  const documentDelegate = prisma.document as any;
  const softDeleteDelegate = prisma.softDeleteRecord as any;
  const auditDelegate = prisma.auditLog as any;

  const originalDocFindUnique = documentDelegate.findUnique;
  const originalDocUpdate = documentDelegate.update;
  const originalBinFindFirst = softDeleteDelegate.findFirst;
  const originalBinDelete = softDeleteDelegate.delete;
  const originalAuditCreate = auditDelegate.create;
  const originalTx = prisma.$transaction;

  let docUpdateCalled = false;
  let binDeleteCalled = false;
  let auditCalled = false;

  try {
    documentDelegate.findUnique = async () => ({ id: "doc-1", documentType: "SALE_BILL" });
    documentDelegate.update = async () => {
      docUpdateCalled = true;
      return {};
    };

    // Direct restoreDocument
    await assert.rejects(
      async () => {
        await restoreDocument("doc-1");
      },
      (err: any) =>
        err instanceof SaleEvidenceProtectedError &&
        err.code === "SALE_EVIDENCE_PROTECTED",
    );
    assert.equal(docUpdateCalled, false);

    // Bin restore with SALE_BILL snapshot
    softDeleteDelegate.findFirst = async () => ({
      id: "bin-1",
      entityType: "Document",
      entityId: "doc-1",
      entityLabel: "Sale Bill",
      entitySnapshot: { documentType: "SALE_BILL" },
      purgedAt: null,
      createdAt: new Date(),
    });
    prisma.$transaction = (async () => {
      binDeleteCalled = true;
    }) as any;
    auditDelegate.create = async () => {
      auditCalled = true;
    };

    await assert.rejects(
      async () => {
        await restoreBinRecord("bin-1", "admin-1");
      },
      (err: any) =>
        err instanceof SaleEvidenceProtectedError &&
        err.code === "SALE_EVIDENCE_PROTECTED",
    );

    // Bin restore with generic snapshot but live SALE_BILL row
    softDeleteDelegate.findFirst = async () => ({
      id: "bin-2",
      entityType: "Document",
      entityId: "doc-1",
      entityLabel: "Sale Bill",
      entitySnapshot: { documentType: "GENERAL" },
      purgedAt: null,
      createdAt: new Date(),
    });

    await assert.rejects(
      async () => {
        await restoreBinRecord("bin-2", "admin-1");
      },
      (err: any) =>
        err instanceof SaleEvidenceProtectedError &&
        err.code === "SALE_EVIDENCE_PROTECTED",
    );

    assert.equal(binDeleteCalled, false);
    assert.equal(auditCalled, false);
  } finally {
    documentDelegate.findUnique = originalDocFindUnique;
    documentDelegate.update = originalDocUpdate;
    softDeleteDelegate.findFirst = originalBinFindFirst;
    softDeleteDelegate.delete = originalBinDelete;
    auditDelegate.create = originalAuditCreate;
    prisma.$transaction = originalTx;
  }
});

test("permanentlyDeleteDocument and permanentlyDeleteBinRecord preserve files on disk and retain bin rows for SALE_BILL", async () => {
  const documentDelegate = prisma.document as any;
  const softDeleteDelegate = prisma.softDeleteRecord as any;
  const auditDelegate = prisma.auditLog as any;

  const originalDocFindUnique = documentDelegate.findUnique;
  const originalDocDelete = documentDelegate.delete;
  const originalBinFindFirst = softDeleteDelegate.findFirst;
  const originalBinUpdate = softDeleteDelegate.update;
  const originalAuditCreate = auditDelegate.create;
  const originalTx = prisma.$transaction;

  const tempDir = isolatedStorageRoot;
  const subFolder = path.join(tempDir, "documents", "2026", "10", "W40");
  await fs.mkdir(subFolder, { recursive: true });

  const originalFilePath = path.join(subFolder, "test_sale_orig.jpg");
  const thumbFilePath = path.join(subFolder, "test_sale_thumb.webp");
  await fs.writeFile(originalFilePath, "ORIGINAL_IMAGE_BYTES_12345");
  await fs.writeFile(thumbFilePath, "THUMBNAIL_IMAGE_BYTES_67890");

  let docDeleteCalled = false;
  let binUpdateCalled = false;
  let auditCalled = false;

  try {
    const saleBillRow = buildSaleBillRow({
      id: "doc-sale-file-1",
      storedPath: "documents/2026/10/W40",
      storedFileName: "test_sale_orig.jpg",
      thumbnailFileName: "test_sale_thumb.webp",
    });

    documentDelegate.findUnique = async () => saleBillRow;
    documentDelegate.delete = async () => {
      docDeleteCalled = true;
      return saleBillRow;
    };

    // Direct permanentlyDeleteDocument rejection
    await assert.rejects(
      async () => {
        await permanentlyDeleteDocument("doc-sale-file-1");
      },
      (err: any) =>
        err instanceof SaleEvidenceProtectedError &&
        err.code === "SALE_EVIDENCE_PROTECTED",
    );

    // Check files STILL EXIST and bytes unchanged
    const origBytes = await fs.readFile(originalFilePath, "utf8");
    const thumbBytes = await fs.readFile(thumbFilePath, "utf8");
    assert.equal(origBytes, "ORIGINAL_IMAGE_BYTES_12345");
    assert.equal(thumbBytes, "THUMBNAIL_IMAGE_BYTES_67890");
    assert.equal(docDeleteCalled, false);

    // Bin permanent delete with SALE_BILL snapshot
    softDeleteDelegate.findFirst = async () => ({
      id: "bin-sale-1",
      entityType: "Document",
      entityId: "doc-sale-file-1",
      entityLabel: "Sale Bill",
      entitySnapshot: { documentType: "SALE_BILL" },
      purgedAt: null,
      createdAt: new Date(),
    });
    prisma.$transaction = (async () => {
      binUpdateCalled = true;
    }) as any;
    auditDelegate.create = async () => {
      auditCalled = true;
    };

    await assert.rejects(
      async () => {
        await permanentlyDeleteBinRecord("bin-sale-1", "admin-1");
      },
      (err: any) =>
        err instanceof SaleEvidenceProtectedError &&
        err.code === "SALE_EVIDENCE_PROTECTED",
    );

    // Bin permanent delete with missing live row but protected snapshot
    documentDelegate.findUnique = async () => null;
    await assert.rejects(
      async () => {
        await permanentlyDeleteBinRecord("bin-sale-1", "admin-1");
      },
      (err: any) =>
        err instanceof SaleEvidenceProtectedError &&
        err.code === "SALE_EVIDENCE_PROTECTED",
    );

    assert.equal(binUpdateCalled, false);
    assert.equal(auditCalled, false);
  } finally {
    documentDelegate.findUnique = originalDocFindUnique;
    documentDelegate.delete = originalDocDelete;
    softDeleteDelegate.findFirst = originalBinFindFirst;
    softDeleteDelegate.update = originalBinUpdate;
    auditDelegate.create = originalAuditCreate;
    prisma.$transaction = originalTx;
  }
});

test("controllers map SaleEvidenceProtectedError to HTTP 409 with stable error payload", async () => {
  const documentDelegate = prisma.document as any;
  const softDeleteDelegate = prisma.softDeleteRecord as any;

  const originalDocFindFirst = documentDelegate.findFirst;
  const originalBinFindFirst = softDeleteDelegate.findFirst;

  const saleBillDoc = buildSaleBillRow();

  try {
    documentDelegate.findFirst = async () => saleBillDoc;
    softDeleteDelegate.findFirst = async () => ({
      id: "bin-100",
      entityType: "Document",
      entityId: "doc-sale-bill-100",
      entitySnapshot: { documentType: "SALE_BILL" },
      purgedAt: null,
      createdAt: new Date(),
    });

    // Delete controller
    const resDel = mockResponse();
    await deleteDocumentHandler(
      { params: { id: "doc-sale-bill-100" }, user: { id: "admin-1", role: "ADMIN" } } as any,
      resDel,
    );
    assert.equal(resDel.statusCode, 409);
    assert.equal(resDel.jsonData.code, "SALE_EVIDENCE_PROTECTED");
    assert.ok(resDel.jsonData.error.includes("Sales bill evidence"));

    // Visibility controller
    const resVis = mockResponse();
    await updateDocumentVisibilityHandler(
      {
        params: { id: "doc-sale-bill-100" },
        body: { visibility: "ADMIN_ONLY" },
        user: { id: "admin-1", role: "ADMIN" },
      } as any,
      resVis,
    );
    assert.equal(resVis.statusCode, 409);
    assert.equal(resVis.jsonData.code, "SALE_EVIDENCE_PROTECTED");

    // Metadata controller
    const resMeta = mockResponse();
    await updateDocumentMetadataHandler(
      {
        params: { id: "doc-sale-bill-100" },
        body: { title: "New Title" },
        user: { id: "admin-1", role: "ADMIN" },
      } as any,
      resMeta,
    );
    assert.equal(resMeta.statusCode, 409);
    assert.equal(resMeta.jsonData.code, "SALE_EVIDENCE_PROTECTED");

    // Bin restore controller
    const resBinRestore = mockResponse();
    await binRestoreHandler(
      { params: { id: "bin-100" }, user: { id: "admin-1", role: "ADMIN" } } as any,
      resBinRestore,
    );
    assert.equal(resBinRestore.statusCode, 409);
    assert.equal(resBinRestore.jsonData.code, "SALE_EVIDENCE_PROTECTED");

    // Bin purge controller
    const resBinPurge = mockResponse();
    await binPurgeHandler(
      { params: { id: "bin-100" }, user: { id: "admin-1", role: "ADMIN" } } as any,
      resBinPurge,
    );
    assert.equal(resBinPurge.statusCode, 409);
    assert.equal(resBinPurge.jsonData.code, "SALE_EVIDENCE_PROTECTED");
  } finally {
    documentDelegate.findFirst = originalDocFindFirst;
    softDeleteDelegate.findFirst = originalBinFindFirst;
  }
});

test("six generic document types retain permitted metadata/visibility/delete behavior", async () => {
  const genericTypes: DocumentType[] = [
    "STOCK_BILL",
    "PRODUCT_IMPORT",
    "RETURN_PROOF",
    "PAYMENT_PROOF",
    "DISCOUNT_PROOF",
    "GENERAL",
  ];

  const documentDelegate = prisma.document as any;
  const auditDelegate = prisma.auditLog as any;

  const originalFindFirst = documentDelegate.findFirst;
  const originalUpdate = documentDelegate.update;
  const originalUpdateMany = documentDelegate.updateMany;
  const originalFindUnique = documentDelegate.findUnique;
  const originalAuditCreate = auditDelegate.create;
  const originalTx = prisma.$transaction;

  try {
    prisma.$transaction = (async (ops: any) => typeof ops === "function" ? ops({
      document: { updateMany: async () => ({ count: 1 }) },
      softDeleteRecord: { create: async () => ({ id: "owned-bin-fixture" }) },
    }) : ops) as any;
    auditDelegate.create = async () => ({ id: "audit-1" });

    for (const docType of genericTypes) {
      const mockDoc = {
        id: `doc-${docType}`,
        documentType: docType,
        title: `${docType} Document`,
        fileName: `${docType}.pdf`,
        storedFileName: `${docType}.pdf`,
        storedPath: "documents/2026/10/W40",
        mimeType: "application/pdf",
        fileSize: 1000,
        checksum: null,
        thumbnailFileName: null,
        thumbnailSize: null,
        supplierName: null,
        billNumber: null,
        billDate: null,
        billAmount: null,
        remarks: null,
        linkedEntityType: null,
        linkedEntityId: null,
        visibility: "ALL_AUTHENTICATED" as const,
        uploadedById: "admin-1",
        createdAt: new Date(),
        deletedAt: null,
        deletedById: null,
        deleteReason: null,
        purgeAfter: null,
      };

      let currentDoc = { ...mockDoc };
      documentDelegate.findFirst = async () => currentDoc;
      documentDelegate.findUnique = async () => currentDoc;
      documentDelegate.updateMany = async ({ where, data }: any) => {
        assert.equal(where.documentType, docType);
        currentDoc = { ...currentDoc, ...data };
        return { count: 1 };
      };
      documentDelegate.update = async ({ data }: any) => ({ ...mockDoc, ...data });

      // Visibility update succeeds
      const visRes = await updateDocumentVisibility(`doc-${docType}`, "ADMIN_ONLY", "admin-1");
      assert.equal(visRes.changed, true);

      // Metadata update succeeds
      const metaRes = await updateDocumentMetadata(`doc-${docType}`, { title: "Updated Title" }, "admin-1");
      assert.equal(metaRes.changed, true);

      // Delete succeeds
      const delRes = await deleteDocument(`doc-${docType}`, "admin-1", "ADMIN");
      assert.equal(delRes.id, `doc-${docType}`);
    }
  } finally {
    documentDelegate.findFirst = originalFindFirst;
    documentDelegate.update = originalUpdate;
    documentDelegate.updateMany = originalUpdateMany;
    documentDelegate.findUnique = originalFindUnique;
    auditDelegate.create = originalAuditCreate;
    prisma.$transaction = originalTx;
  }
});

test("protected mutation matrix retains active/deleted evidence and never starts writes", async () => {
  const delegates = [prisma.document, prisma.softDeleteRecord, prisma.auditLog] as any[];
  const saved = delegates.map((delegate) => ({
    findFirst: delegate.findFirst, findUnique: delegate.findUnique, findMany: delegate.findMany,
    update: delegate.update, delete: delegate.delete, create: delegate.create,
  }));
  const originalTransaction = prisma.$transaction;
  let writes = 0;
  const write = async () => { writes += 1; throw new Error("Unexpected protected write"); };
  try {
    for (const delegate of delegates) {
      delegate.update = write; delegate.delete = write; delegate.create = write;
    }
    prisma.$transaction = write as any;
    for (const status of [null, "UNRESOLVED", "ATTACHED", "ARCHIVED"] as const) {
      for (const linked of [false, true]) {
        for (const deleted of [false, true]) {
          const row = buildSaleBillRow({
            saleRecoveryStatus: status,
            linkedEntityType: linked ? "Invoice" : null,
            linkedEntityId: linked ? "invoice-fixture" : null,
            deletedAt: deleted ? new Date("2026-10-01T00:00:00Z") : null,
          });
          const before = structuredClone(row);
          delegates[0].findUnique = async () => row;
          delegates[0].findFirst = async () => deleted ? null : row;
          delegates[0].findMany = async () => deleted ? [] : [row];
          // A stale generic snapshot cannot override the live protected type.
          delegates[1].findFirst = async () => ({
            id: "bin-matrix", entityType: "Document", entityId: row.id,
            entitySnapshot: { documentType: "GENERAL" }, purgedAt: null,
          });
          const calls = [
            () => restoreDocument(row.id), () => permanentlyDeleteDocument(row.id),
            () => restoreBinRecord("bin-matrix", "admin-1"),
            () => permanentlyDeleteBinRecord("bin-matrix", "admin-1"),
          ];
          if (!deleted) {
            calls.push(
              () => deleteDocument(row.id, "admin-1", "ADMIN"),
              () => updateDocumentMetadata(row.id, { title: row.title }, "admin-1"),
              () => updateDocumentMetadata(row.id, { title: "Changed" }, "admin-1"),
              () => updateDocumentMetadata(row.id, { documentType: "GENERAL" }, "admin-1"),
              () => updateDocumentVisibility(row.id, "ALL_AUTHENTICATED", "admin-1"),
              () => updateDocumentVisibility(row.id, "ADMIN_ONLY", "admin-1"),
              () => linkDocumentsToEntity({ documentIds: [row.id], documentType: "GENERAL",
                linkedEntityType: "Invoice", linkedEntityId: "invoice-fixture",
                userId: "admin-1", viewerRole: "ADMIN" }),
            );
          }
          for (const call of calls) {
            await assert.rejects(call, (error: any) => error instanceof SaleEvidenceProtectedError);
            assert.deepEqual(row, before);
            assert.equal(writes, 0);
          }
        }
      }
    }
    await assert.rejects(() => linkDocumentsToEntity({ documentIds: [], documentType: "SALE_BILL",
      linkedEntityType: "Invoice", linkedEntityId: "invoice-fixture", userId: "admin-1" }),
      (error: any) => error instanceof SaleEvidenceProtectedError);
  } finally {
    delegates.forEach((delegate, i) => Object.assign(delegate, saved[i]));
    prisma.$transaction = originalTransaction;
  }
});
