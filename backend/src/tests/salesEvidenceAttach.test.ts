import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import prisma from "../db/prisma";
import {
  candidatesQuerySchema,
  attachSaleEvidenceSchema,
} from "../modules/salesEvidence/validation";
import {
  attachSaleEvidence,
  getSaleEvidenceCandidates,
} from "../modules/salesEvidence/service";
import { documentStorageRoot } from "../lib/storageReadiness";
import type { ManualBillActor } from "../modules/invoices/manualBill/types";
import type { BusinessCapabilities } from "../modules/settings/capabilities";

const mockCapabilities = async (): Promise<BusinessCapabilities> => ({
  businessMode: "FULL_POS",
  catalogEnabled: true,
  inventoryEnabled: true,
  posEnabled: true,
  staffDraftRequestsEnabled: true,
  stockTracked: true,
});

const cashierActor: ManualBillActor = {
  id: "user_cashier_1",
  name: "Cashier One",
  role: "CASHIER",
};

const managerActor: ManualBillActor = {
  id: "user_manager_1",
  name: "Manager One",
  role: "MANAGER",
};

const adminActor: ManualBillActor = {
  id: "user_admin_1",
  name: "Admin One",
  role: "ADMIN",
};

function buildMockDocument(overrides: Record<string, any> = {}) {
  return {
    id: "doc-attach-001",
    documentType: "SALE_BILL",
    title: "Counter handwritten bill",
    description: null,
    storedPath: "documents/2026/10",
    storedFileName: "sale_bill_001.jpg",
    fileName: "sale_bill_001.jpg",
    fileSize: 1024,
    mimeType: "image/jpeg",
    visibility: "STAFF_READ",
    linkedEntityType: null,
    linkedEntityId: null,
    documentRole: null,
    processingStatus: "COMPLETED",
    uploadedById: "user_manager_1",
    notes: null,
    ocrText: null,
    ocrConfidence: null,
    saleRecoveryStatus: "UNRESOLVED",
    salesEvidenceInvoiceId: null,
    checkoutOperationId: null,
    recoveryCheckoutOperationKey: null,
    recoveryCheckoutPayloadHash: null,
    recoveryArchiveReason: null,
    recoveryResolvedAt: null,
    createdAt: new Date("2026-10-04T10:00:00Z"),
    updatedAt: new Date("2026-10-04T10:00:00Z"),
    uploadedBy: { name: "Manager One" },
    salesEvidenceInvoice: null,
    ...overrides,
  };
}

function buildMockCandidateInvoice(overrides: Record<string, any> = {}) {
  return {
    id: "inv-candidate-001",
    invoiceNo: "INV-2026-0001",
    status: "FINALIZED",
    paymentStatus: "PAID",
    billingChannel: "MANUAL_EXTERNAL",
    externalDocumentType: null,
    externalBillNo: null,
    externalBillDate: null,
    billRecordStatus: "PENDING",
    subtotal: 500,
    discountTotal: 0,
    netTotal: 500,
    paidAmount: 500,
    changeAmount: 0,
    paymentMethod: "CASH",
    customerId: null,
    customerSnapshotName: null,
    customerSnapshotPan: null,
    customerSnapshotPhone: null,
    customerSnapshotCapturedAt: null,
    notes: null,
    createdBy: "user_cashier_1",
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    deletedAt: null,
    finalizedAt: new Date("2026-10-04T10:00:00Z"),
    createdAt: new Date("2026-10-04T10:00:00Z"),
    updatedAt: new Date("2026-10-04T10:00:00Z"),
    customer: null,
    user: { name: "Cashier One" },
    replacementFor: null,
    replacedBy: null,
    proofDocuments: [],
    ...overrides,
  };
}

test("Schema validation: candidatesQuerySchema and attachSaleEvidenceSchema", () => {
  const validCandidateQuery = candidatesQuerySchema.safeParse({
    search: "INV-2026-001",
    limit: "15",
  });
  assert.ok(validCandidateQuery.success);
  if (validCandidateQuery.success) {
    assert.equal(validCandidateQuery.data.search, "INV-2026-001");
    assert.equal(validCandidateQuery.data.limit, 15);
  }

  const invalidLimit = candidatesQuerySchema.safeParse({
    limit: "100", // max is 20
  });
  assert.ok(!invalidLimit.success);

  const validAttach = attachSaleEvidenceSchema.safeParse({
    invoiceId: "inv_123456789012345678901234",
    reference: {
      billNo: "PB-99901",
      externalDocumentType: "VAT_TAX_INVOICE",
      externalBillDate: "2026-10-04",
    },
    expectedInvoice: {
      billingChannel: "MANUAL_EXTERNAL",
      externalDocumentType: null,
      externalBillNo: null,
      externalBillDate: null,
      billRecordStatus: "PENDING",
    },
    reason: "Matched scanned receipt with finalized invoice",
  });
  assert.ok(validAttach.success);

  const missingReason = attachSaleEvidenceSchema.safeParse({
    invoiceId: "inv_123456789012345678901234",
    reference: {
      billNo: "PB-99901",
      externalDocumentType: "VAT_TAX_INVOICE",
      externalBillDate: "2026-10-04",
    },
    expectedInvoice: {
      billingChannel: "MANUAL_EXTERNAL",
      externalDocumentType: null,
      externalBillNo: null,
      externalBillDate: null,
      billRecordStatus: "PENDING",
    },
    reason: "   ",
  });
  assert.ok(!missingReason.success);
});

test("attachSalesEvidence: Verifies completed file existence on disk before transaction", async () => {
  const doc = buildMockDocument({
    id: "doc-missing-file",
    storedPath: "documents/2026/10",
    storedFileName: "non_existent.jpg",
  });

  const originalPrismaFind = prisma.document.findFirst;

  try {
    (prisma as any).document.findFirst = async () => doc;

    await assert.rejects(
      async () => {
        await attachSaleEvidence(
          "doc-missing-file",
          {
            invoiceId: "inv-cand-1",
            reference: {
              billNo: "PB-001",
              externalDocumentType: "PAN_INVOICE",
              externalBillDate: "2026-10-04",
            },
            expectedInvoice: {
              billingChannel: "MANUAL_EXTERNAL",
              externalDocumentType: null,
              externalBillNo: null,
              externalBillDate: null,
              billRecordStatus: "PENDING",
            },
            reason: "Attach proof",
          },
          managerActor,
          mockCapabilities,
        );
      },
      {
        name: "SalesEvidenceConflictError",
        code: "INVALID_FILE",
      },
    );
  } finally {
    (prisma as any).document.findFirst = originalPrismaFind;
  }
});

test("attachSalesEvidence: Rejects 0-byte empty file on disk (B-5 preflight validation)", async () => {
  const relDir = "documents/2026/10";
  const fileName = "empty_zero_byte.jpg";
  const absPath = path.join(documentStorageRoot, relDir, fileName);
  fsSync.mkdirSync(path.dirname(absPath), { recursive: true });
  fsSync.writeFileSync(absPath, ""); // 0 bytes

  const doc = buildMockDocument({
    id: "doc-zero-byte",
    storedPath: relDir,
    storedFileName: fileName,
    fileName,
    fileSize: 0,
  });

  const originalPrismaFind = prisma.document.findFirst;

  try {
    (prisma as any).document.findFirst = async () => doc;

    await assert.rejects(
      async () => {
        await attachSaleEvidence(
          "doc-zero-byte",
          {
            invoiceId: "inv-cand-1",
            reference: {
              billNo: "PB-001",
              externalDocumentType: "PAN_INVOICE",
              externalBillDate: "2026-10-04",
            },
            expectedInvoice: {
              billingChannel: "MANUAL_EXTERNAL",
              externalDocumentType: null,
              externalBillNo: null,
              externalBillDate: null,
              billRecordStatus: "PENDING",
            },
            reason: "Attach proof",
          },
          managerActor,
          mockCapabilities,
        );
      },
      {
        name: "SalesEvidenceConflictError",
        code: "INVALID_FILE",
      },
    );
  } finally {
    try { fsSync.unlinkSync(absPath); } catch {}
    (prisma as any).document.findFirst = originalPrismaFind;
  }
});

test("attachSaleEvidence: Successfully attaches valid evidence to candidate invoice with locking (B-5)", async () => {
  const relDir = "documents/2026/10";
  const fileName = "sale_valid_test.jpg";
  const absPath = path.join(documentStorageRoot, relDir, fileName);
  fsSync.mkdirSync(path.dirname(absPath), { recursive: true });
  fsSync.writeFileSync(absPath, "dummy file content for test");

  const doc = buildMockDocument({
    id: "doc-valid-001",
    storedPath: relDir,
    storedFileName: fileName,
    fileName,
  });

  const inv = buildMockCandidateInvoice({
    id: "inv-target-001",
  });

  const docUpdates: any[] = [];
  const invUpdates: any[] = [];
  const auditLogs: any[] = [];
  const rawQueries: string[] = [];

  const fakeTx: any = {
    document: {
      findFirst: async () => doc,
      findMany: async () => [doc],
      count: async () => 1,
      findUnique: async () => ({
        ...doc,
        ...docUpdates[0]?.data,
        uploadedBy: { name: "Manager One" },
      }),
      update: async (args: any) => {
        docUpdates.push(args);
        return { ...doc, ...args.data };
      },
      updateMany: async (args: any) => {
        docUpdates.push(args);
        return { count: 1 };
      },
    },
    invoice: {
      findFirst: async (args: any) => {
        if (args.where?.externalBillNo) return null; // No duplicate
        return inv;
      },
      findMany: async () => [],
      findUnique: async () => ({
        ...inv,
        ...invUpdates[0]?.data,
      }),
      update: async (args: any) => {
        invUpdates.push(args);
        return { ...inv, ...args.data };
      },
    },
    auditLog: {
      create: async (args: any) => {
        auditLogs.push(args);
        return { id: "audit-attach-1", ...args.data };
      },
      findMany: async () => [],
    },
    user: {
      findUnique: async () => ({ name: "Manager One", role: "MANAGER" }),
    },
    $queryRaw: async (strings: TemplateStringsArray) => {
      rawQueries.push(strings.join(""));
      return [];
    },
  };

  const originalDocFindFirst = prisma.document.findFirst;
  const originalTx = prisma.$transaction;

  try {
    (prisma as any).document.findFirst = async () => doc;
    (prisma as any).$transaction = async (fn: any) => fn(fakeTx);

    const result = await attachSaleEvidence(
      "doc-valid-001",
      {
        invoiceId: "inv-target-001",
        reference: {
          billNo: "PB-VALID-001",
          externalDocumentType: "PAN_INVOICE",
          externalBillDate: "2026-10-04",
        },
        expectedInvoice: {
          billingChannel: "MANUAL_EXTERNAL",
          externalDocumentType: null,
          externalBillNo: null,
          externalBillDate: null,
          billRecordStatus: "PENDING",
        },
        reason: "Reviewer verified physical receipt and matched invoice",
      },
      managerActor,
      mockCapabilities,
    );

    assert.equal(docUpdates.length, 1);
    assert.equal(docUpdates[0].data.saleRecoveryStatus, "ATTACHED");
    assert.equal(docUpdates[0].data.linkedEntityId, "inv-target-001");

    assert.equal(invUpdates.length, 1);
    assert.equal(invUpdates[0].data.externalBillNo, "PB-VALID-001");
    assert.equal(invUpdates[0].data.billRecordStatus, "RECORDED");

    assert.equal(auditLogs.length, 2);
    assert.equal(auditLogs[0].data.action, "SALES_EVIDENCE_ATTACHED");
    assert.equal(auditLogs[1].data.action, "MANUAL_BILL_ATTACHED");

    // Verify Document lock query was performed
    assert.ok(rawQueries.some((q) => q.includes("Document") && q.includes("FOR UPDATE")));
  } finally {
    try { fsSync.unlinkSync(absPath); } catch {}
    (prisma as any).document.findFirst = originalDocFindFirst;
    (prisma as any).$transaction = originalTx;
  }
});

test("attachSalesEvidence: Restricted ADMIN_ONLY document returns NOT_FOUND to MANAGER (existence hiding)", async () => {
  const restrictedDoc = buildMockDocument({
    id: "doc-restricted-admin",
    visibility: "ADMIN_ONLY",
  });

  const originalDocFindFirst = prisma.document.findFirst;

  try {
    (prisma as any).document.findFirst = async (args: any) => {
      if (args.where?.visibility?.in && !args.where.visibility.in.includes("ADMIN_ONLY")) {
        return null;
      }
      return restrictedDoc;
    };

    await assert.rejects(
      async () => {
        await attachSaleEvidence(
          "doc-restricted-admin",
          {
            invoiceId: "inv-cand-1",
            reference: {
              billNo: "PB-001",
              externalDocumentType: "PAN_INVOICE",
              externalBillDate: "2026-10-04",
            },
            expectedInvoice: {
              billingChannel: "MANUAL_EXTERNAL",
              externalDocumentType: null,
              externalBillNo: null,
              externalBillDate: null,
              billRecordStatus: "PENDING",
            },
            reason: "Attempt by manager",
          },
          managerActor,
          mockCapabilities,
        );
      },
      (err: any) => {
        return (
          err.name === "SalesEvidenceConflictError" &&
          (err.code === "NOT_FOUND" || err.message.includes("not found"))
        );
      },
    );
  } finally {
    (prisma as any).document.findFirst = originalDocFindFirst;
  }
});

test("attachSaleEvidence: Duplicate bill number triggers conflict when unapproved, allows with override (B-3)", async () => {
  const relDir = "documents/2026/10";
  const fileName = "sale_dup_test.jpg";
  const absPath = path.join(documentStorageRoot, relDir, fileName);
  fsSync.mkdirSync(path.dirname(absPath), { recursive: true });
  fsSync.writeFileSync(absPath, "dummy file content for test");

  const doc = buildMockDocument({
    id: "doc-dup-001",
    storedPath: relDir,
    storedFileName: fileName,
  });

  const inv = buildMockCandidateInvoice({ id: "inv-target-002" });
  const existingDupInvoice = { id: "inv-other-001", invoiceNo: "INV-OTHER-1" };
  const invUpdates: any[] = [];

  const fakeTx: any = {
    document: {
      findFirst: async () => doc,
      findMany: async () => [doc],
      count: async () => 1,
      findUnique: async () => doc,
      update: async (args: any) => ({ ...doc, ...args.data }),
      updateMany: async () => ({ count: 1 }),
    },
    invoice: {
      findFirst: async (args: any) => {
        return {
          ...inv,
          ...(invUpdates[invUpdates.length - 1]?.data || {}),
        };
      },
      findMany: async (args: any) => {
        if (args.where?.externalBillNo) return [existingDupInvoice];
        return [];
      },
      findUnique: async () => ({
        ...inv,
        ...(invUpdates[invUpdates.length - 1]?.data || {}),
      }),
      update: async (args: any) => {
        invUpdates.push(args);
        return { ...inv, ...args.data };
      },
    },
    auditLog: {
      create: async (args: any) => ({ id: "audit-1", ...args.data }),
      findMany: async () => [],
    },
    user: { findUnique: async () => ({ name: "Manager One", role: "MANAGER" }) },
    $queryRaw: async () => [],
  };

  const originalDocFindFirst = prisma.document.findFirst;
  const originalTx = prisma.$transaction;

  try {
    (prisma as any).document.findFirst = async () => doc;
    (prisma as any).$transaction = async (fn: any) => fn(fakeTx);

    // 1. Without duplicateOverrideReason, throws DUPLICATE_BILL_NO
    await assert.rejects(
      async () => {
        await attachSaleEvidence(
          "doc-dup-001",
          {
            invoiceId: "inv-target-002",
            reference: {
              billNo: "PB-DUP-001",
              externalDocumentType: "PAN_INVOICE",
              externalBillDate: "2026-10-04",
            },
            expectedInvoice: {
              billingChannel: "MANUAL_EXTERNAL",
              externalDocumentType: null,
              externalBillNo: null,
              externalBillDate: null,
              billRecordStatus: "PENDING",
            },
            reason: "Attempt attach duplicate without override",
          },
          managerActor,
          mockCapabilities,
        );
      },
      {
        name: "SalesEvidenceConflictError",
        code: "DUPLICATE_REVIEW_REQUIRED",
      },
    );

    // 2. With duplicateOverrideReason, succeeds
    const result = await attachSaleEvidence(
      "doc-dup-001",
      {
        invoiceId: "inv-target-002",
        reference: {
          billNo: "PB-DUP-001",
          externalDocumentType: "PAN_INVOICE",
          externalBillDate: "2026-10-04",
        },
        duplicateOverrideReason: "Approved duplicate serial from vendor restart",
        expectedInvoice: {
          billingChannel: "MANUAL_EXTERNAL",
          externalDocumentType: null,
          externalBillNo: null,
          externalBillDate: null,
          billRecordStatus: "PENDING",
        },
        reason: "Manager approved duplicate serial",
      },
      managerActor,
      mockCapabilities,
    );

    assert.ok(result.document);
    assert.equal(result.invoice.billRecordStatus, "RECORDED");
  } finally {
    try { fsSync.unlinkSync(absPath); } catch {}
    (prisma as any).document.findFirst = originalDocFindFirst;
    (prisma as any).$transaction = originalTx;
  }
});

test("attachSaleEvidence: Idempotent replay with matching audit provenance succeeds (B-3)", async () => {
  const relDir = "documents/2026/10";
  const fileName = "sale_replay_test.jpg";
  const absPath = path.join(documentStorageRoot, relDir, fileName);
  fsSync.mkdirSync(path.dirname(absPath), { recursive: true });
  fsSync.writeFileSync(absPath, "dummy file content for test");

  const attachedDoc = buildMockDocument({
    id: "doc-replayed-001",
    storedPath: relDir,
    storedFileName: fileName,
    saleRecoveryStatus: "ATTACHED",
    salesEvidenceInvoiceId: "inv-replayed-001",
    linkedEntityType: "Invoice",
    linkedEntityId: "inv-replayed-001",
  });

  const recordedInv = buildMockCandidateInvoice({
    id: "inv-replayed-001",
    externalBillNo: "PB-REPLAY-001",
    externalDocumentType: "PAN_INVOICE",
    externalBillDate: new Date("2026-10-04T00:00:00Z"),
    billRecordStatus: "RECORDED",
  });

  const matchingAudit = {
    id: "audit-prev-1",
    action: "SALES_EVIDENCE_ATTACHED",
    entityType: "Document",
    entityId: "doc-replayed-001",
    meta: {
      documentId: "doc-replayed-001",
      invoiceId: "inv-replayed-001",
      reason: "Verified physical receipt",
      reference: {
        billNo: "PB-REPLAY-001",
        externalDocumentType: "PAN_INVOICE",
        externalBillDate: "2026-10-04",
      },
      previousDocument: {
        id: attachedDoc.id, documentType: "SALE_BILL", visibility: attachedDoc.visibility,
        saleRecoveryStatus: "UNRESOLVED", linkedEntityType: null, linkedEntityId: null,
        recoveryCheckoutOperationKey: null, recoveryCheckoutPayloadHash: null,
      },
      previousInvoice: {
        billingChannel: "MANUAL_EXTERNAL",
        externalDocumentType: null,
        externalBillNo: null,
        externalBillDate: null,
        billRecordStatus: "PENDING",
      },
      duplicateOverrideReason: null,
    },
    createdAt: new Date("2026-10-04T10:00:00Z"),
  };

  const fakeTx: any = {
    document: {
      findFirst: async () => attachedDoc,
      findMany: async () => [attachedDoc],
      count: async () => 1,
      findUnique: async () => attachedDoc,
    },
    invoice: {
      findFirst: async (args: any) => {
        if (args.where?.externalBillNo) return null;
        return recordedInv;
      },
      findUnique: async () => recordedInv,
    },
    auditLog: {
      findFirst: async () => matchingAudit,
      findMany: async () => [matchingAudit],
    },
    user: { findUnique: async () => ({ name: "Manager One", role: "MANAGER" }) },
    $queryRaw: async () => [],
  };

  const originalDocFindFirst = prisma.document.findFirst;
  const originalTx = prisma.$transaction;

  try {
    (prisma as any).document.findFirst = async () => attachedDoc;
    (prisma as any).$transaction = async (fn: any) => fn(fakeTx);

    const result = await attachSaleEvidence(
      "doc-replayed-001",
      {
        invoiceId: "inv-replayed-001",
        reference: {
          billNo: "PB-REPLAY-001",
          externalDocumentType: "PAN_INVOICE",
          externalBillDate: "2026-10-04",
        },
        expectedInvoice: {
          billingChannel: "MANUAL_EXTERNAL",
          externalDocumentType: null,
          externalBillNo: null,
          externalBillDate: null,
          billRecordStatus: "PENDING",
        },
        reason: "Verified physical receipt",
      },
      managerActor,
      mockCapabilities,
    );

    assert.equal(result.replayed, true);
    assert.equal(result.document.id, "doc-replayed-001");
    assert.equal(result.invoice.id, "inv-replayed-001");
  } finally {
    try { fsSync.unlinkSync(absPath); } catch {}
    (prisma as any).document.findFirst = originalDocFindFirst;
    (prisma as any).$transaction = originalTx;
  }
});
