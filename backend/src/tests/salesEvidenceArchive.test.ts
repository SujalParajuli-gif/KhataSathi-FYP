import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import express from "express";
import prisma from "../db/prisma";

// Isolated storage root
const isolatedStorageRoot = fsSync.mkdtempSync(
  path.join(os.tmpdir(), "ks-sales-archive-storage-"),
);
process.env.DOCUMENT_STORAGE_ROOT = isolatedStorageRoot;

const { documentStorageRoot } = require("../lib/storageReadiness") as typeof import("../lib/storageReadiness");
assert.equal(documentStorageRoot, isolatedStorageRoot, "Archive tests must use isolated storage");

const {
  archiveSaleEvidence,
  getSaleEvidenceById,
  getSaleEvidenceFile,
  getSaleEvidenceThumbnail,
  listSaleEvidence,
  SalesEvidenceConflictError,
  SalesEvidenceAuthorizationError,
} = require("../modules/salesEvidence/service") as typeof import("../modules/salesEvidence/service");
const {
  archiveSaleEvidenceHandler,
} = require("../modules/salesEvidence/controller") as typeof import("../modules/salesEvidence/controller");
const {
  archiveSaleEvidenceSchema,
} = require("../modules/salesEvidence/validation") as typeof import("../modules/salesEvidence/validation");
const salesEvidenceRoutes = (require("../modules/salesEvidence/routes") as { default: express.Router }).default;
const {
  signSessionToken,
  hashSessionSecret,
  SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
} = require("../modules/auth/session") as typeof import("../modules/auth/session");
const {
  invalidateBusinessSettingsCache,
} = require("../modules/settings/service") as typeof import("../modules/settings/service");
import type { BusinessCapabilities } from "../modules/settings/capabilities";
import type { DocumentType, DocumentVisibility, SaleRecoveryStatus } from "@prisma/client";

after(() => fs.rm(isolatedStorageRoot, { recursive: true, force: true }));

const fullPosCapabilities: BusinessCapabilities = {
  businessMode: "FULL_POS",
  catalogEnabled: true,
  inventoryEnabled: true,
  posEnabled: true,
  staffDraftRequestsEnabled: true,
  stockTracked: true,
};

const posDisabledCapabilities: BusinessCapabilities = {
  businessMode: "CATALOG_ONLY",
  catalogEnabled: true,
  inventoryEnabled: false,
  posEnabled: false,
  staffDraftRequestsEnabled: false,
  stockTracked: false,
};

async function createStoredFile(
  storedPath: string,
  storedFileName: string,
  content: string | Buffer = "dummy-bill-data",
) {
  const targetDir = path.join(isolatedStorageRoot, storedPath);
  await fs.mkdir(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, storedFileName);
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  await fs.writeFile(targetPath, buffer);
  return targetPath;
}

function buildMockRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "doc-sale-archive-101",
    documentType: "SALE_BILL" as DocumentType,
    title: "Sale Invoice Bill Proof",
    fileName: "bill_proof_101.jpg",
    storedFileName: "doc-sale-archive-101_sale-bill.jpg",
    storedPath: "documents/2026/10/W40",
    mimeType: "image/jpeg",
    fileSize: 10240,
    checksum: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    thumbnailFileName: "doc-sale-archive-101.webp",
    thumbnailSize: 2048,
    supplierName: null,
    billNumber: null,
    billDate: null,
    billAmount: null,
    remarks: "Manual POS register copy",
    linkedEntityType: null,
    linkedEntityId: null,
    visibility: "ADMIN_MANAGER" as DocumentVisibility,
    uploadedById: "user-admin-1",
    createdAt: new Date("2026-10-04T12:00:00.000Z"),
    deletedAt: null,
    deletedById: null,
    deleteReason: null,
    purgeAfter: null,
    saleRecoveryStatus: "UNRESOLVED" as SaleRecoveryStatus,
    recoveryCheckoutOperationKey: null,
    recoveryCheckoutPayloadHash: null,
    uploadedBy: {
      id: "user-admin-1",
      name: "Admin User",
    },
    ...overrides,
  };
}

function createTestSession(user: {
  id: string;
  role: string;
  isActive?: boolean;
  mustChangePassword?: boolean;
}) {
  const rawToken = "test-token-" + Math.random().toString(36).slice(2);
  const tokenHash = hashSessionSecret(rawToken);
  const rawCsrf = "test-csrf-" + Math.random().toString(36).slice(2);
  const csrfTokenHash = hashSessionSecret(rawCsrf);
  const signedCookie = `${SESSION_COOKIE_NAME}=${signSessionToken(rawToken)}`;
  const sessionRecord = {
    id: "session-" + Math.random().toString(36).slice(2),
    tokenHash,
    csrfTokenHash,
    expiresAt: new Date(Date.now() + 3600000),
    revokedAt: null,
    user: {
      id: user.id,
      role: user.role,
      isActive: user.isActive ?? true,
      mustChangePassword: user.mustChangePassword ?? false,
    },
  };
  return {
    rawToken,
    rawCsrf,
    signedCookie,
    sessionRecord,
  };
}

test("archiveSaleEvidenceSchema strictly validates reason input and rejects invalid or unknown fields", () => {
  // Valid reason
  const valid = archiveSaleEvidenceSchema.safeParse({
    reason: "Legitimate physical bill duplicate; no checkout link required.",
  });
  assert.equal(valid.success, true);
  if (valid.success) {
    assert.equal(
      valid.data.reason,
      "Legitimate physical bill duplicate; no checkout link required.",
    );
  }

  // Whitespace trimmed
  const trimmed = archiveSaleEvidenceSchema.safeParse({
    reason: "  Valid reason with padding  ",
  });
  assert.equal(trimmed.success, true);
  if (trimmed.success) {
    assert.equal(trimmed.data.reason, "Valid reason with padding");
  }

  // Too short (<2 chars)
  assert.equal(archiveSaleEvidenceSchema.safeParse({ reason: "a" }).success, false);
  assert.equal(archiveSaleEvidenceSchema.safeParse({ reason: "  " }).success, false);
  assert.equal(archiveSaleEvidenceSchema.safeParse({ reason: "" }).success, false);

  // Missing reason
  assert.equal(archiveSaleEvidenceSchema.safeParse({}).success, false);

  // Too long (>2000 chars)
  assert.equal(
    archiveSaleEvidenceSchema.safeParse({ reason: "x".repeat(2001) }).success,
    false,
  );

  // Unknown / injected fields rejected (strict)
  assert.equal(
    archiveSaleEvidenceSchema.safeParse({
      reason: "Valid reason",
      saleRecoveryStatus: "ARCHIVED",
    }).success,
    false,
  );
  assert.equal(
    archiveSaleEvidenceSchema.safeParse({
      reason: "Valid reason",
      linkedEntityId: "inv-100",
    }).success,
    false,
  );
  assert.equal(
    archiveSaleEvidenceSchema.safeParse({
      reason: "Valid reason",
      recoveryCheckoutOperationKey: "secret-key",
    }).success,
    false,
  );
});

test("archiveSaleEvidence enforces reviewer roles and POS capability", async () => {
  // Cashier role rejected
  await assert.rejects(
    () =>
      archiveSaleEvidence(
        "doc-1",
        { reason: "Reviewer archive note" },
        { id: "cashier-1", role: "CASHIER" },
        async () => fullPosCapabilities,
      ),
    (err: any) =>
      err instanceof SalesEvidenceAuthorizationError &&
      err.statusCode === 403 &&
      err.message.includes("insufficient role"),
  );

  // Unknown role rejected
  await assert.rejects(
    () =>
      archiveSaleEvidence(
        "doc-1",
        { reason: "Reviewer archive note" },
        { id: "unknown-1", role: "STAFF" },
        async () => fullPosCapabilities,
      ),
    (err: any) =>
      err instanceof SalesEvidenceAuthorizationError &&
      err.statusCode === 403,
  );

  // POS disabled rejected
  await assert.rejects(
    () =>
      archiveSaleEvidence(
        "doc-1",
        { reason: "Reviewer archive note" },
        { id: "admin-1", role: "ADMIN" },
        async () => posDisabledCapabilities,
      ),
    (err: any) =>
      err instanceof SalesEvidenceAuthorizationError &&
      err.statusCode === 403 &&
      err.code === "FEATURE_DISABLED",
  );
});

test("archiveSaleEvidence preflight checks: 404 for missing/deleted/wrong type/manager hidden", async () => {
  const documentDelegate = prisma.document as any;
  const originalFindFirst = documentDelegate.findFirst;

  // Realistic mock table simulating Prisma query predicate evaluation
  const documentsTable = [
    buildMockRow({ id: "doc-missing", deletedAt: null }),
    buildMockRow({ id: "doc-deleted", deletedAt: new Date("2026-10-01T00:00:00.000Z") }),
    buildMockRow({ id: "doc-purchase", documentType: "PURCHASE_BILL" as DocumentType }),
    buildMockRow({ id: "doc-admin-only", visibility: "ADMIN_ONLY" as DocumentVisibility }),
  ];

  try {
    documentDelegate.findFirst = async ({ where }: any) => {
      return documentsTable.find((doc) => {
        if (where.id && doc.id !== where.id) return false;
        if (where.documentType && doc.documentType !== where.documentType) return false;
        if (where.deletedAt === null && doc.deletedAt !== null) return false;
        if (where.visibility?.in && !where.visibility.in.includes(doc.visibility)) return false;
        return true;
      }) || null;
    };

    // 1. Missing document -> returns null (404)
    const notFoundResult = await archiveSaleEvidence(
      "nonexistent-id",
      { reason: "Duplicate manual bill proof" },
      { id: "admin-1", role: "ADMIN" },
      async () => fullPosCapabilities,
    );
    assert.equal(notFoundResult, null);

    // 2. Deleted document (deletedAt not null) -> returns null (404)
    const deletedResult = await archiveSaleEvidence(
      "doc-deleted",
      { reason: "Duplicate manual bill proof" },
      { id: "admin-1", role: "ADMIN" },
      async () => fullPosCapabilities,
    );
    assert.equal(deletedResult, null);

    // 3. Wrong document type (PURCHASE_BILL) -> returns null (404)
    const wrongTypeResult = await archiveSaleEvidence(
      "doc-purchase",
      { reason: "Duplicate manual bill proof" },
      { id: "admin-1", role: "ADMIN" },
      async () => fullPosCapabilities,
    );
    assert.equal(wrongTypeResult, null);

    // 4. Manager cannot access ADMIN_ONLY document -> returns null (404)
    const managerHiddenResult = await archiveSaleEvidence(
      "doc-admin-only",
      { reason: "Duplicate manual bill proof" },
      { id: "mgr-1", role: "MANAGER" },
      async () => fullPosCapabilities,
    );
    assert.equal(managerHiddenResult, null);
  } finally {
    documentDelegate.findFirst = originalFindFirst;
  }
});

test("archiveSaleEvidence preflight checks: 409 for missing file on disk, legacy status, attached, or active operation", async () => {
  const documentDelegate = prisma.document as any;
  const originalFindFirst = documentDelegate.findFirst;

  try {
    // 1. Missing original file on disk -> 409 MISSING_EVIDENCE_FILE with public document
    const missingFileRow = buildMockRow({
      storedPath: "documents/nonexistent/dir",
      storedFileName: "file-not-found.jpg",
    });
    documentDelegate.findFirst = async () => missingFileRow;

    await assert.rejects(
      () =>
        archiveSaleEvidence(
          missingFileRow.id,
          { reason: "Valid archive reason" },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) =>
        err instanceof SalesEvidenceConflictError &&
        err.statusCode === 409 &&
        err.code === "MISSING_EVIDENCE_FILE" &&
        err.document?.id === missingFileRow.id,
    );

    // Create a real file on disk for remaining tests
    const validRow = buildMockRow();
    await createStoredFile(validRow.storedPath, validRow.storedFileName);

    // 2. Legacy null saleRecoveryStatus -> 409 LEGACY_STATUS_CONFLICT
    const legacyNullRow = buildMockRow({ saleRecoveryStatus: null });
    documentDelegate.findFirst = async () => legacyNullRow;
    await assert.rejects(
      () =>
        archiveSaleEvidence(
          legacyNullRow.id,
          { reason: "Valid archive reason" },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) =>
        err instanceof SalesEvidenceConflictError &&
        err.statusCode === 409 &&
        err.code === "LEGACY_STATUS_CONFLICT" &&
        err.document?.id === legacyNullRow.id,
    );

    // 3. Attached evidence -> 409 ATTACHED_CONFLICT
    const attachedRow = buildMockRow({ saleRecoveryStatus: "ATTACHED" });
    documentDelegate.findFirst = async () => attachedRow;
    await assert.rejects(
      () =>
        archiveSaleEvidence(
          attachedRow.id,
          { reason: "Valid archive reason" },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) =>
        err instanceof SalesEvidenceConflictError &&
        err.statusCode === 409 &&
        err.code === "ATTACHED_CONFLICT" &&
        err.document?.id === attachedRow.id,
    );

    // 4. Linked entity non-null -> 409 ATTACHED_CONFLICT
    const linkedRow = buildMockRow({
      linkedEntityType: "Invoice",
      linkedEntityId: "inv-999",
    });
    documentDelegate.findFirst = async () => linkedRow;
    await assert.rejects(
      () =>
        archiveSaleEvidence(
          linkedRow.id,
          { reason: "Valid archive reason" },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) =>
        err instanceof SalesEvidenceConflictError &&
        err.statusCode === 409 &&
        err.code === "ATTACHED_CONFLICT" &&
        err.document?.id === linkedRow.id,
    );

    // 5. Active recovery checkout operation key / hash -> 409 ACTIVE_OPERATION_CONFLICT
    const activeOpRow = buildMockRow({
      recoveryCheckoutOperationKey: "active-op-key-123",
      recoveryCheckoutPayloadHash: "hash-456",
    });
    documentDelegate.findFirst = async () => activeOpRow;
    await assert.rejects(
      () =>
        archiveSaleEvidence(
          activeOpRow.id,
          { reason: "Valid archive reason" },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) =>
        err instanceof SalesEvidenceConflictError &&
        err.statusCode === 409 &&
        err.code === "ACTIVE_OPERATION_CONFLICT" &&
        err.document?.id === activeOpRow.id,
    );
  } finally {
    documentDelegate.findFirst = originalFindFirst;
  }
});

test("B-1: Lock failure in transaction aborts execution without modifying status or creating audit", async () => {
  const documentDelegate = prisma.document as any;
  const originalFindFirst = documentDelegate.findFirst;
  const originalTransaction = prisma.$transaction;

  const mockRow = buildMockRow({
    id: "doc-lock-failure-1",
    saleRecoveryStatus: "UNRESOLVED",
  });
  await createStoredFile(mockRow.storedPath, mockRow.storedFileName);

  let updateCalled = false;
  let auditCreated = false;

  try {
    documentDelegate.findFirst = async () => mockRow;

    prisma.$transaction = (async (callback: any) => {
      const tx = {
        $queryRaw: async () => {
          throw new Error("Lock acquisition failed: Deadlock or lock wait timeout");
        },
        document: {
          findFirst: async () => mockRow,
          updateMany: async () => {
            updateCalled = true;
            return { count: 1 };
          },
        },
        auditLog: {
          create: async () => {
            auditCreated = true;
            return { id: "audit-1" };
          },
        },
      };
      return callback(tx);
    }) as any;

    await assert.rejects(
      () =>
        archiveSaleEvidence(
          mockRow.id,
          { reason: "Legitimate reason" },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) => err.message.includes("Lock acquisition failed"),
    );

    assert.equal(updateCalled, false, "Update must not be called when lock fails");
    assert.equal(auditCreated, false, "Audit must not be created when lock fails");
  } finally {
    documentDelegate.findFirst = originalFindFirst;
    prisma.$transaction = originalTransaction;
  }
});

test("archiveSaleEvidence first success: atomic transaction, updates status to ARCHIVED, creates 1 audit log, masks secret fields", async () => {
  const documentDelegate = prisma.document as any;
  const auditLogDelegate = prisma.auditLog as any;
  const originalFindFirst = documentDelegate.findFirst;
  const originalTransaction = prisma.$transaction;
  const originalAuditCreate = auditLogDelegate?.create;

  const mockRow = buildMockRow({
    id: "doc-archive-success-1",
    saleRecoveryStatus: "UNRESOLVED",
  });
  await createStoredFile(mockRow.storedPath, mockRow.storedFileName);

  let capturedUpdateWhere: any = null;
  let capturedUpdateData: any = null;
  let capturedAuditData: any = null;

  try {
    documentDelegate.findFirst = async () => mockRow;

    prisma.$transaction = (async (callback: any) => {
      const tx = {
        $queryRaw: async () => [],
        document: {
          findFirst: async () => mockRow,
          updateMany: async ({ where, data }: any) => {
            capturedUpdateWhere = where;
            capturedUpdateData = data;
            return { count: 1 };
          },
        },
        auditLog: {
          create: async ({ data }: any) => {
            capturedAuditData = data;
            return { id: "audit-arch-1", ...data, createdAt: new Date() };
          },
        },
      };
      return callback(tx);
    }) as any;

    const result = await archiveSaleEvidence(
      mockRow.id,
      { reason: "Customer canceled order; physical receipt retained for audit record." },
      { id: "admin-user-1", role: "ADMIN", name: "Admin" },
      async () => fullPosCapabilities,
    );

    assert.ok(result);
    assert.equal(result.replayed, false);
    assert.equal(result.document.id, mockRow.id);
    assert.equal(result.document.saleRecoveryStatus, "ARCHIVED");

    // Secret recovery keys/hashes excluded
    assert.equal("recoveryCheckoutOperationKey" in result.document, false);
    assert.equal("recoveryCheckoutPayloadHash" in result.document, false);

    // Verify conditional update
    assert.equal(capturedUpdateWhere.id, mockRow.id);
    assert.equal(capturedUpdateWhere.saleRecoveryStatus, "UNRESOLVED");
    assert.equal(capturedUpdateWhere.linkedEntityType, null);
    assert.equal(capturedUpdateWhere.linkedEntityId, null);
    assert.equal(capturedUpdateWhere.recoveryCheckoutOperationKey, null);
    assert.equal(capturedUpdateWhere.recoveryCheckoutPayloadHash, null);
    assert.equal(capturedUpdateData.saleRecoveryStatus, "ARCHIVED");

    // Verify AuditLog record
    assert.ok(capturedAuditData);
    assert.equal(capturedAuditData.action, "SALE_EVIDENCE_ARCHIVED");
    assert.equal(capturedAuditData.actorId, "admin-user-1");
    assert.equal(capturedAuditData.entityType, "Document");
    assert.equal(capturedAuditData.entityId, mockRow.id);
    assert.equal(
      capturedAuditData.meta.reason,
      "Customer canceled order; physical receipt retained for audit record.",
    );
    assert.equal(capturedAuditData.meta.oldSaleRecoveryStatus, "UNRESOLVED");
    assert.equal(capturedAuditData.meta.newSaleRecoveryStatus, "ARCHIVED");
    assert.equal(capturedAuditData.meta.linkedEntityType, null);
    assert.equal(capturedAuditData.meta.linkedEntityId, null);
  } finally {
    documentDelegate.findFirst = originalFindFirst;
    prisma.$transaction = originalTransaction;
    if (originalAuditCreate) auditLogDelegate.create = originalAuditCreate;
  }
});

test("B-3 (Preflight Replay): audit provenance verification during preflight replay (valid, missing link observations, contradictory link observations, mismatched reason with valid/invalid provenance, malformed audit, missing audit)", async () => {
  const documentDelegate = prisma.document as any;
  const originalFindFirst = documentDelegate.findFirst;
  const originalAuditFindFirst = (prisma as any).auditLog?.findFirst;

  const reasonText = "Known test transaction canceled by cashier.";
  const archivedRow = buildMockRow({
    id: "doc-archived-provenance-preflight",
    saleRecoveryStatus: "ARCHIVED",
  });
  await createStoredFile(archivedRow.storedPath, archivedRow.storedFileName);

  try {
    documentDelegate.findFirst = async () => archivedRow;

    // 1. Valid audit provenance (explicitly null link observations) -> replay succeeds
    (prisma as any).auditLog = {
      findFirst: async () => ({
        id: "audit-1",
        action: "SALE_EVIDENCE_ARCHIVED",
        entityType: "Document",
        entityId: archivedRow.id,
        meta: {
          documentId: archivedRow.id,
          reason: reasonText,
          oldSaleRecoveryStatus: "UNRESOLVED",
          newSaleRecoveryStatus: "ARCHIVED",
          linkedEntityType: null,
          linkedEntityId: null,
        },
      }),
    };

    const replayResult = await archiveSaleEvidence(
      archivedRow.id,
      { reason: `  ${reasonText}  ` },
      { id: "mgr-2", role: "MANAGER" },
      async () => fullPosCapabilities,
    );
    assert.ok(replayResult);
    assert.equal(replayResult.replayed, true);
    assert.equal(replayResult.document.saleRecoveryStatus, "ARCHIVED");

    // 2. Audit with missing link observations (undefined fields) -> 409 UNVERIFIED_ARCHIVE
    (prisma as any).auditLog.findFirst = async () => ({
      id: "audit-missing-link-obs",
      action: "SALE_EVIDENCE_ARCHIVED",
      entityType: "Document",
      entityId: archivedRow.id,
      meta: {
        documentId: archivedRow.id,
        reason: reasonText,
        oldSaleRecoveryStatus: "UNRESOLVED",
        newSaleRecoveryStatus: "ARCHIVED",
        // linkedEntityType and linkedEntityId omitted / undefined
      },
    });

    await assert.rejects(
      () =>
        archiveSaleEvidence(
          archivedRow.id,
          { reason: reasonText },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) =>
        err instanceof SalesEvidenceConflictError &&
        err.statusCode === 409 &&
        err.code === "UNVERIFIED_ARCHIVE" &&
        err.document?.id === archivedRow.id,
    );

    // 3. Audit with contradictory link observations (linkedEntityType: 'Invoice') -> 409 UNVERIFIED_ARCHIVE
    (prisma as any).auditLog.findFirst = async () => ({
      id: "audit-contradictory-link",
      action: "SALE_EVIDENCE_ARCHIVED",
      entityType: "Document",
      entityId: archivedRow.id,
      meta: {
        documentId: archivedRow.id,
        reason: reasonText,
        oldSaleRecoveryStatus: "UNRESOLVED",
        newSaleRecoveryStatus: "ARCHIVED",
        linkedEntityType: "Invoice",
        linkedEntityId: "inv-123",
      },
    });

    await assert.rejects(
      () =>
        archiveSaleEvidence(
          archivedRow.id,
          { reason: reasonText },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) =>
        err instanceof SalesEvidenceConflictError &&
        err.statusCode === 409 &&
        err.code === "UNVERIFIED_ARCHIVE" &&
        err.document?.id === archivedRow.id,
    );

    // 4. Different reason with VALID provenance -> 409 DECISION_CONFLICT with public document
    (prisma as any).auditLog.findFirst = async () => ({
      id: "audit-valid-diff-reason",
      action: "SALE_EVIDENCE_ARCHIVED",
      entityType: "Document",
      entityId: archivedRow.id,
      meta: {
        documentId: archivedRow.id,
        reason: "Prior accepted reason",
        oldSaleRecoveryStatus: "UNRESOLVED",
        newSaleRecoveryStatus: "ARCHIVED",
        linkedEntityType: null,
        linkedEntityId: null,
      },
    });

    await assert.rejects(
      () =>
        archiveSaleEvidence(
          archivedRow.id,
          { reason: "A completely different reason" },
          { id: "mgr-2", role: "MANAGER" },
          async () => fullPosCapabilities,
        ),
      (err: any) =>
        err instanceof SalesEvidenceConflictError &&
        err.statusCode === 409 &&
        err.code === "DECISION_CONFLICT" &&
        err.document?.id === archivedRow.id,
    );

    // 5. Different reason with MALFORMED provenance (missing link observations) -> 409 UNVERIFIED_ARCHIVE (NOT DECISION_CONFLICT)
    (prisma as any).auditLog.findFirst = async () => ({
      id: "audit-malformed-diff-reason",
      action: "SALE_EVIDENCE_ARCHIVED",
      entityType: "Document",
      entityId: archivedRow.id,
      meta: {
        documentId: archivedRow.id,
        reason: "Prior accepted reason",
        oldSaleRecoveryStatus: "UNRESOLVED",
        newSaleRecoveryStatus: "ARCHIVED",
        // missing linkedEntityType & linkedEntityId
      },
    });

    await assert.rejects(
      () =>
        archiveSaleEvidence(
          archivedRow.id,
          { reason: "A completely different reason" },
          { id: "mgr-2", role: "MANAGER" },
          async () => fullPosCapabilities,
        ),
      (err: any) =>
        err instanceof SalesEvidenceConflictError &&
        err.statusCode === 409 &&
        err.code === "UNVERIFIED_ARCHIVE" &&
        err.document?.id === archivedRow.id,
    );

    // 6. Malformed audit (oldSaleRecoveryStatus = "ATTACHED") -> 409 UNVERIFIED_ARCHIVE
    (prisma as any).auditLog.findFirst = async () => ({
      id: "audit-bad-old-status",
      action: "SALE_EVIDENCE_ARCHIVED",
      entityType: "Document",
      entityId: archivedRow.id,
      meta: {
        documentId: archivedRow.id,
        reason: reasonText,
        oldSaleRecoveryStatus: "ATTACHED", // invalid!
        newSaleRecoveryStatus: "ARCHIVED",
        linkedEntityType: null,
        linkedEntityId: null,
      },
    });

    await assert.rejects(
      () =>
        archiveSaleEvidence(
          archivedRow.id,
          { reason: reasonText },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) =>
        err instanceof SalesEvidenceConflictError &&
        err.statusCode === 409 &&
        err.code === "UNVERIFIED_ARCHIVE" &&
        err.document?.id === archivedRow.id,
    );

    // 7. Malformed audit (documentId mismatch) -> 409 UNVERIFIED_ARCHIVE
    (prisma as any).auditLog.findFirst = async () => ({
      id: "audit-doc-mismatch",
      action: "SALE_EVIDENCE_ARCHIVED",
      entityType: "Document",
      entityId: archivedRow.id,
      meta: {
        documentId: "other-doc-id",
        reason: reasonText,
        oldSaleRecoveryStatus: "UNRESOLVED",
        newSaleRecoveryStatus: "ARCHIVED",
        linkedEntityType: null,
        linkedEntityId: null,
      },
    });

    await assert.rejects(
      () =>
        archiveSaleEvidence(
          archivedRow.id,
          { reason: reasonText },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) =>
        err instanceof SalesEvidenceConflictError &&
        err.statusCode === 409 &&
        err.code === "UNVERIFIED_ARCHIVE",
    );

    // 8. Missing audit (null) -> 409 UNVERIFIED_ARCHIVE
    (prisma as any).auditLog.findFirst = async () => null;
    await assert.rejects(
      () =>
        archiveSaleEvidence(
          archivedRow.id,
          { reason: reasonText },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) =>
        err instanceof SalesEvidenceConflictError &&
        err.statusCode === 409 &&
        err.code === "UNVERIFIED_ARCHIVE",
    );
  } finally {
    documentDelegate.findFirst = originalFindFirst;
    if (originalAuditFindFirst) {
      (prisma as any).auditLog.findFirst = originalAuditFindFirst;
    }
  }
});

test("B-3 & B-4 (Locked Transaction Replay & State/Access Recheck Denials): locked replay provenance, missing observations, locked state denials, and access recheck", async () => {
  const documentDelegate = prisma.document as any;
  const originalFindFirst = documentDelegate.findFirst;
  const originalTransaction = prisma.$transaction;
  const originalAuditFindFirst = (prisma as any).auditLog?.findFirst;

  const validReason = "Reviewer valid archive decision";
  const mockUnresolved = buildMockRow({
    id: "doc-locked-replay-test",
    saleRecoveryStatus: "UNRESOLVED",
  });
  await createStoredFile(mockUnresolved.storedPath, mockUnresolved.storedFileName);

  try {
    // Preflight returns UNRESOLVED
    documentDelegate.findFirst = async () => mockUnresolved;

    // 1. Locked replay: locked document is ARCHIVED with VALID audit -> succeeds replayed: true
    prisma.$transaction = (async (callback: any) => {
      const lockedArchived = { ...mockUnresolved, saleRecoveryStatus: "ARCHIVED" as const };
      const tx = {
        $queryRaw: async () => [],
        document: {
          findFirst: async () => lockedArchived,
        },
        auditLog: {
          findFirst: async () => ({
            id: "audit-locked-valid",
            action: "SALE_EVIDENCE_ARCHIVED",
            entityType: "Document",
            entityId: lockedArchived.id,
            meta: {
              documentId: lockedArchived.id,
              reason: validReason,
              oldSaleRecoveryStatus: "UNRESOLVED",
              newSaleRecoveryStatus: "ARCHIVED",
              linkedEntityType: null,
              linkedEntityId: null,
            },
          }),
        },
      };
      return callback(tx);
    }) as any;

    const lockedReplayRes = await archiveSaleEvidence(
      mockUnresolved.id,
      { reason: validReason },
      { id: "admin-1", role: "ADMIN" },
      async () => fullPosCapabilities,
    );
    assert.ok(lockedReplayRes);
    assert.equal(lockedReplayRes.replayed, true);
    assert.equal(lockedReplayRes.document.saleRecoveryStatus, "ARCHIVED");

    // 2. Locked replay: locked document is ARCHIVED with MISSING link observations -> 409 UNVERIFIED_ARCHIVE
    prisma.$transaction = (async (callback: any) => {
      const lockedArchived = { ...mockUnresolved, saleRecoveryStatus: "ARCHIVED" as const };
      const tx = {
        $queryRaw: async () => [],
        document: {
          findFirst: async () => lockedArchived,
        },
        auditLog: {
          findFirst: async () => ({
            id: "audit-locked-missing-obs",
            action: "SALE_EVIDENCE_ARCHIVED",
            entityType: "Document",
            entityId: lockedArchived.id,
            meta: {
              documentId: lockedArchived.id,
              reason: validReason,
              oldSaleRecoveryStatus: "UNRESOLVED",
              newSaleRecoveryStatus: "ARCHIVED",
              // linkedEntityType and linkedEntityId omitted
            },
          }),
        },
      };
      return callback(tx);
    }) as any;

    await assert.rejects(
      () =>
        archiveSaleEvidence(
          mockUnresolved.id,
          { reason: validReason },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) =>
        err instanceof SalesEvidenceConflictError &&
        err.statusCode === 409 &&
        err.code === "UNVERIFIED_ARCHIVE",
    );

    // 3. Locked replay: locked document is ARCHIVED with CONTRADICTORY link observations -> 409 UNVERIFIED_ARCHIVE
    prisma.$transaction = (async (callback: any) => {
      const lockedArchived = { ...mockUnresolved, saleRecoveryStatus: "ARCHIVED" as const };
      const tx = {
        $queryRaw: async () => [],
        document: {
          findFirst: async () => lockedArchived,
        },
        auditLog: {
          findFirst: async () => ({
            id: "audit-locked-contradictory",
            action: "SALE_EVIDENCE_ARCHIVED",
            entityType: "Document",
            entityId: lockedArchived.id,
            meta: {
              documentId: lockedArchived.id,
              reason: validReason,
              oldSaleRecoveryStatus: "UNRESOLVED",
              newSaleRecoveryStatus: "ARCHIVED",
              linkedEntityType: "Invoice",
              linkedEntityId: "inv-111",
            },
          }),
        },
      };
      return callback(tx);
    }) as any;

    await assert.rejects(
      () =>
        archiveSaleEvidence(
          mockUnresolved.id,
          { reason: validReason },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) =>
        err instanceof SalesEvidenceConflictError &&
        err.statusCode === 409 &&
        err.code === "UNVERIFIED_ARCHIVE",
    );

    // 4. Locked replay: locked document is ARCHIVED with DIFFERENT reason & valid provenance -> 409 DECISION_CONFLICT
    prisma.$transaction = (async (callback: any) => {
      const lockedArchived = { ...mockUnresolved, saleRecoveryStatus: "ARCHIVED" as const };
      const tx = {
        $queryRaw: async () => [],
        document: {
          findFirst: async () => lockedArchived,
        },
        auditLog: {
          findFirst: async () => ({
            id: "audit-locked-diff-reason",
            action: "SALE_EVIDENCE_ARCHIVED",
            entityType: "Document",
            entityId: lockedArchived.id,
            meta: {
              documentId: lockedArchived.id,
              reason: "Different prior reason",
              oldSaleRecoveryStatus: "UNRESOLVED",
              newSaleRecoveryStatus: "ARCHIVED",
              linkedEntityType: null,
              linkedEntityId: null,
            },
          }),
        },
      };
      return callback(tx);
    }) as any;

    await assert.rejects(
      () =>
        archiveSaleEvidence(
          mockUnresolved.id,
          { reason: validReason },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) =>
        err instanceof SalesEvidenceConflictError &&
        err.statusCode === 409 &&
        err.code === "DECISION_CONFLICT",
    );

    // 5. Locked state denial: document deleted while acquiring lock -> returns null (404)
    prisma.$transaction = (async (callback: any) => {
      const tx = {
        $queryRaw: async () => [],
        document: {
          findFirst: async () => null, // deleted or hidden
        },
      };
      return callback(tx);
    }) as any;

    const deletedLockedRes = await archiveSaleEvidence(
      mockUnresolved.id,
      { reason: validReason },
      { id: "admin-1", role: "ADMIN" },
      async () => fullPosCapabilities,
    );
    assert.equal(deletedLockedRes, null);

    // 6. Locked state denial: document became ATTACHED while acquiring lock -> 409 ATTACHED_CONFLICT
    prisma.$transaction = (async (callback: any) => {
      const lockedAttached = {
        ...mockUnresolved,
        saleRecoveryStatus: "ATTACHED" as const,
        linkedEntityType: "Invoice",
        linkedEntityId: "inv-999",
      };
      const tx = {
        $queryRaw: async () => [],
        document: {
          findFirst: async () => lockedAttached,
        },
      };
      return callback(tx);
    }) as any;

    await assert.rejects(
      () =>
        archiveSaleEvidence(
          mockUnresolved.id,
          { reason: validReason },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) =>
        err instanceof SalesEvidenceConflictError &&
        err.statusCode === 409 &&
        err.code === "ATTACHED_CONFLICT" &&
        err.document?.id === mockUnresolved.id,
    );

    // 7. Locked state denial: document acquired active recovery checkout operation key -> 409 ACTIVE_OPERATION_CONFLICT
    prisma.$transaction = (async (callback: any) => {
      const lockedActiveOp = {
        ...mockUnresolved,
        recoveryCheckoutOperationKey: "op-key-lock",
        recoveryCheckoutPayloadHash: "op-hash-lock",
      };
      const tx = {
        $queryRaw: async () => [],
        document: {
          findFirst: async () => lockedActiveOp,
        },
      };
      return callback(tx);
    }) as any;

    await assert.rejects(
      () =>
        archiveSaleEvidence(
          mockUnresolved.id,
          { reason: validReason },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) =>
        err instanceof SalesEvidenceConflictError &&
        err.statusCode === 409 &&
        err.code === "ACTIVE_OPERATION_CONFLICT",
    );
  } finally {
    documentDelegate.findFirst = originalFindFirst;
    prisma.$transaction = originalTransaction;
    if (originalAuditFindFirst) {
      (prisma as any).auditLog.findFirst = originalAuditFindFirst;
    }
  }
});

test("B-4 (Concurrency): Genuinely overlapping concurrent requests serialized with lock-aware fake and deterministic mutex", async () => {
  const documentDelegate = prisma.document as any;
  const originalFindFirst = documentDelegate.findFirst;
  const originalTransaction = prisma.$transaction;
  const originalAuditFindFirst = (prisma as any).auditLog?.findFirst;

  const mockDoc = buildMockRow({
    id: "doc-concurrency-mutex-1",
    saleRecoveryStatus: "UNRESOLVED",
  });
  await createStoredFile(mockDoc.storedPath, mockDoc.storedFileName);

  // Shared in-memory committed database state
  let committedDoc = { ...mockDoc };
  let committedAudits: any[] = [];

  // Mutex simulating MySQL row-level lock serialization
  let lockHolder: Promise<void> | null = null;
  let releaseLock: (() => void) | null = null;

  async function acquireRowLock() {
    while (lockHolder) {
      await lockHolder;
    }
    let resolveLock!: () => void;
    lockHolder = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    releaseLock = () => {
      lockHolder = null;
      resolveLock();
    };
  }

  try {
    // Outer queries (preflight and reconciliation)
    documentDelegate.findFirst = async ({ where }: any) => {
      if (where.id === committedDoc.id) {
        if (where.visibility?.in && !where.visibility.in.includes(committedDoc.visibility)) {
          return null;
        }
        return { ...committedDoc };
      }
      return null;
    };

    (prisma as any).auditLog = {
      findFirst: async ({ where }: any) => {
        const matching = committedAudits
          .filter(
            (a) =>
              a.entityType === where.entityType &&
              a.entityId === where.entityId &&
              a.action === where.action,
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return matching[0] ? { ...matching[0] } : null;
      },
    };

    // Lock-serialized transaction implementation
    prisma.$transaction = (async (callback: any) => {
      let stagedLocalDoc = { ...committedDoc };
      let stagedLocalAudits: any[] = [];

      const tx = {
        $queryRaw: async () => {
          // Acquire serialized row lock
          await acquireRowLock();
          // Read latest committed state into transaction view
          stagedLocalDoc = { ...committedDoc };
          return [];
        },
        document: {
          findFirst: async ({ where }: any) => {
            if (where.id === stagedLocalDoc.id) {
              if (where.visibility?.in && !where.visibility.in.includes(stagedLocalDoc.visibility)) {
                return null;
              }
              return { ...stagedLocalDoc };
            }
            return null;
          },
          updateMany: async ({ where, data }: any) => {
            if (
              stagedLocalDoc.id === where.id &&
              stagedLocalDoc.saleRecoveryStatus === where.saleRecoveryStatus &&
              stagedLocalDoc.linkedEntityType === (where.linkedEntityType ?? null) &&
              stagedLocalDoc.linkedEntityId === (where.linkedEntityId ?? null) &&
              stagedLocalDoc.recoveryCheckoutOperationKey === (where.recoveryCheckoutOperationKey ?? null) &&
              stagedLocalDoc.recoveryCheckoutPayloadHash === (where.recoveryCheckoutPayloadHash ?? null)
            ) {
              stagedLocalDoc = { ...stagedLocalDoc, ...data };
              return { count: 1 };
            }
            return { count: 0 };
          },
        },
        auditLog: {
          findFirst: async ({ where }: any) => {
            const all = [...committedAudits, ...stagedLocalAudits];
            const matching = all
              .filter(
                (a) =>
                  a.entityType === where.entityType &&
                  a.entityId === where.entityId &&
                  a.action === where.action,
              )
              .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
            return matching[0] ? { ...matching[0] } : null;
          },
          create: async ({ data }: any) => {
            const record = {
              id: "audit-" + (committedAudits.length + stagedLocalAudits.length + 1),
              ...data,
              createdAt: new Date(),
            };
            stagedLocalAudits.push(record);
            return record;
          },
        },
      };

      try {
        const result = await callback(tx);
        // Transaction commit: apply staged changes to committed store
        committedDoc = { ...stagedLocalDoc };
        committedAudits.push(...stagedLocalAudits);
        return result;
      } finally {
        // Release row lock on commit or rollback
        if (releaseLock) {
          releaseLock();
          releaseLock = null;
        }
      }
    }) as any;

    // Sub-test 1: Two concurrent requests with SAME reason
    // Both see UNRESOLVED in preflight simultaneously, but one acquires lock first,
    // updates to ARCHIVED + creates 1 audit, then second acquires lock, enters locked replay -> replayed: true.
    const sharedReason = "Identical concurrent archive reason";
    const [resA, resB] = await Promise.all([
      archiveSaleEvidence(
        mockDoc.id,
        { reason: sharedReason },
        { id: "admin-1", role: "ADMIN" },
        async () => fullPosCapabilities,
      ),
      archiveSaleEvidence(
        mockDoc.id,
        { reason: sharedReason },
        { id: "mgr-1", role: "MANAGER" },
        async () => fullPosCapabilities,
      ),
    ]);

    assert.ok(resA);
    assert.ok(resB);
    // Exactly one is original winner (replayed: false) and one is replay (replayed: true)
    const winners = [resA, resB].filter((r) => r.replayed === false);
    const replays = [resA, resB].filter((r) => r.replayed === true);
    assert.equal(winners.length, 1, "Exactly one concurrent caller must win");
    assert.equal(replays.length, 1, "The second concurrent caller must replay");
    assert.equal(committedAudits.length, 1, "Exactly one audit record must be committed");
    assert.equal(committedDoc.saleRecoveryStatus, "ARCHIVED");

    // Sub-test 2: Reset state and test two concurrent requests with DIFFERENT reasons
    // One wins and archives; the other receives 409 DECISION_CONFLICT with public document.
    committedDoc = { ...mockDoc, id: "doc-concurrency-diff-1" };
    committedAudits = [];
    await createStoredFile(committedDoc.storedPath, committedDoc.storedFileName);

    const reasonWinner = "Reason from winner";
    const reasonContender = "Reason from contending reviewer";

    const results = await Promise.allSettled([
      archiveSaleEvidence(
        committedDoc.id,
        { reason: reasonWinner },
        { id: "admin-1", role: "ADMIN" },
        async () => fullPosCapabilities,
      ),
      archiveSaleEvidence(
        committedDoc.id,
        { reason: reasonContender },
        { id: "mgr-1", role: "MANAGER" },
        async () => fullPosCapabilities,
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

    assert.equal(fulfilled.length, 1, "Exactly one request must succeed");
    assert.equal(rejected.length, 1, "The competing different-reason request must be rejected");

    assert.equal(fulfilled[0].value.replayed, false);
    assert.equal(fulfilled[0].value.document.saleRecoveryStatus, "ARCHIVED");

    const conflictErr = rejected[0].reason;
    assert.ok(conflictErr instanceof SalesEvidenceConflictError);
    assert.equal(conflictErr.statusCode, 409);
    assert.equal(conflictErr.code, "DECISION_CONFLICT");
    assert.ok(conflictErr.document);
    assert.equal(conflictErr.document.id, committedDoc.id);
    assert.equal(conflictErr.document.saleRecoveryStatus, "ARCHIVED");

    assert.equal(committedAudits.length, 1, "Only winner's audit record must exist");
  } finally {
    documentDelegate.findFirst = originalFindFirst;
    prisma.$transaction = originalTransaction;
    if (originalAuditFindFirst) {
      (prisma as any).auditLog.findFirst = originalAuditFindFirst;
    }
  }
});

test("B-4 (Transaction Isolation & Rollback): Transaction-local staged store discards changes on callback error or commit failure", async () => {
  const documentDelegate = prisma.document as any;
  const originalFindFirst = documentDelegate.findFirst;
  const originalTransaction = prisma.$transaction;
  const originalAuditFindFirst = (prisma as any).auditLog?.findFirst;

  const mockDoc = buildMockRow({
    id: "doc-rollback-isolation-1",
    saleRecoveryStatus: "UNRESOLVED",
  });
  await createStoredFile(mockDoc.storedPath, mockDoc.storedFileName);

  let committedDoc = { ...mockDoc };
  let committedAudits: any[] = [];

  try {
    documentDelegate.findFirst = async () => ({ ...committedDoc });
    (prisma as any).auditLog = {
      findFirst: async () => committedAudits[0] || null,
    };

    // Transaction with genuine staged-store isolation
    function createIsolatedTransaction(simulateCommitFailure: boolean = false) {
      return (async (callback: any) => {
        let stagedDoc = { ...committedDoc };
        let stagedAudits: any[] = [];

        const tx = {
          $queryRaw: async () => [],
          document: {
            findFirst: async () => ({ ...stagedDoc }),
            updateMany: async ({ where, data }: any) => {
              if (
                stagedDoc.id === where.id &&
                stagedDoc.saleRecoveryStatus === where.saleRecoveryStatus
              ) {
                stagedDoc = { ...stagedDoc, ...data };
                return { count: 1 };
              }
              return { count: 0 };
            },
          },
          auditLog: {
            create: async ({ data }: any) => {
              const record = { id: "audit-" + Math.random(), ...data, createdAt: new Date() };
              stagedAudits.push(record);
              return record;
            },
          },
        };

        const result = await callback(tx);

        if (simulateCommitFailure) {
          // Discard staged state and throw commit failure
          throw new Error("Simulated database commit failure / socket hang up");
        }

        // Commit: apply staged changes
        committedDoc = { ...stagedDoc };
        committedAudits.push(...stagedAudits);
        return result;
      }) as any;
    }

    // 1. AuditLog creation failure -> callback throws -> staged status mutation discarded -> committed store stays UNRESOLVED
    prisma.$transaction = (async (callback: any) => {
      let stagedDoc = { ...committedDoc };
      let stagedAudits: any[] = [];

      const tx = {
        $queryRaw: async () => [],
        document: {
          findFirst: async () => ({ ...stagedDoc }),
          updateMany: async ({ data }: any) => {
            stagedDoc = { ...stagedDoc, ...data };
            return { count: 1 };
          },
        },
        auditLog: {
          create: async () => {
            throw new Error("Audit log disk write failure");
          },
        },
      };

      await callback(tx);
      // If callback throws, execution never reaches here
      committedDoc = { ...stagedDoc };
    }) as any;

    await assert.rejects(
      () =>
        archiveSaleEvidence(
          mockDoc.id,
          { reason: "Valid reason text" },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) => err.message.includes("Audit log disk write failure"),
    );

    assert.equal(committedDoc.saleRecoveryStatus, "UNRESOLVED", "Document status must remain UNRESOLVED on callback error");
    assert.equal(committedAudits.length, 0, "No audit logs must be committed");

    // 2. Commit failure after callback -> staged state discarded
    prisma.$transaction = createIsolatedTransaction(true);

    await assert.rejects(
      () =>
        archiveSaleEvidence(
          mockDoc.id,
          { reason: "Valid reason text" },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) => err.message.includes("Simulated database commit failure"),
    );

    assert.equal(committedDoc.saleRecoveryStatus, "UNRESOLVED", "Document status must remain UNRESOLVED on commit error");
    assert.equal(committedAudits.length, 0, "No audit logs must be committed");

    // 3. Conditional update count 0 (concurrent modification) -> throws 409 CONCURRENT_MODIFICATION
    prisma.$transaction = (async (callback: any) => {
      const tx = {
        $queryRaw: async () => [],
        document: {
          findFirst: async () => ({ ...committedDoc }),
          updateMany: async () => ({ count: 0 }), // 0 rows updated
        },
        auditLog: {
          create: async () => {
            throw new Error("Should not be called");
          },
        },
      };
      return callback(tx);
    }) as any;

    await assert.rejects(
      () =>
        archiveSaleEvidence(
          mockDoc.id,
          { reason: "Valid reason text" },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) =>
        err instanceof SalesEvidenceConflictError &&
        err.statusCode === 409 &&
        err.code === "CONCURRENT_MODIFICATION" &&
        err.document?.id === mockDoc.id,
    );
  } finally {
    documentDelegate.findFirst = originalFindFirst;
    prisma.$transaction = originalTransaction;
    if (originalAuditFindFirst) {
      (prisma as any).auditLog.findFirst = originalAuditFindFirst;
    }
  }
});

test("B-2 & B-3 (Post-Commit Error Reconciliation Matrix): Preflight UNRESOLVED reaches transaction, catches error, and evaluates committed outcomes vs provenance vs denials vs failures", async () => {
  const documentDelegate = prisma.document as any;
  const originalFindFirst = documentDelegate.findFirst;
  const originalTransaction = prisma.$transaction;
  const originalAuditFindFirst = (prisma as any).auditLog?.findFirst;

  const validReason = "Committed reconcile reason";
  const mockUnresolved = buildMockRow({
    id: "doc-reconcile-matrix-1",
    saleRecoveryStatus: "UNRESOLVED",
    visibility: "ADMIN_MANAGER",
  });
  await createStoredFile(mockUnresolved.storedPath, mockUnresolved.storedFileName);

  try {
    // 1. Transaction error after commit -> outer reconciliation query finds ARCHIVED with valid audit (null link observations) -> returns replayed: true
    let preflightCalled = false;
    documentDelegate.findFirst = async () => {
      if (!preflightCalled) {
        preflightCalled = true;
        return mockUnresolved; // UNRESOLVED during preflight!
      }
      // Reconciliation query after tx error
      return { ...mockUnresolved, saleRecoveryStatus: "ARCHIVED" as const };
    };

    (prisma as any).auditLog = {
      findFirst: async () => ({
        id: "audit-reconcile-valid",
        action: "SALE_EVIDENCE_ARCHIVED",
        entityType: "Document",
        entityId: mockUnresolved.id,
        meta: {
          documentId: mockUnresolved.id,
          reason: validReason,
          oldSaleRecoveryStatus: "UNRESOLVED",
          newSaleRecoveryStatus: "ARCHIVED",
          linkedEntityType: null,
          linkedEntityId: null,
        },
      }),
    };

    prisma.$transaction = (async () => {
      throw new Error("Simulated connection reset right after commit");
    }) as any;

    const res1 = await archiveSaleEvidence(
      mockUnresolved.id,
      { reason: validReason },
      { id: "mgr-1", role: "MANAGER" },
      async () => fullPosCapabilities,
    );
    assert.ok(res1);
    assert.equal(res1.replayed, true);
    assert.equal(res1.document.saleRecoveryStatus, "ARCHIVED");

    // 2. Transaction error -> reconciliation finds ARCHIVED with MISSING link observations -> 409 UNVERIFIED_ARCHIVE
    preflightCalled = false;
    documentDelegate.findFirst = async () => {
      if (!preflightCalled) {
        preflightCalled = true;
        return mockUnresolved;
      }
      return { ...mockUnresolved, saleRecoveryStatus: "ARCHIVED" as const };
    };

    (prisma as any).auditLog.findFirst = async () => ({
      id: "audit-reconcile-missing-obs",
      action: "SALE_EVIDENCE_ARCHIVED",
      entityType: "Document",
      entityId: mockUnresolved.id,
      meta: {
        documentId: mockUnresolved.id,
        reason: validReason,
        oldSaleRecoveryStatus: "UNRESOLVED",
        newSaleRecoveryStatus: "ARCHIVED",
        // missing linked observations
      },
    });

    await assert.rejects(
      () =>
        archiveSaleEvidence(
          mockUnresolved.id,
          { reason: validReason },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) =>
        err instanceof SalesEvidenceConflictError &&
        err.statusCode === 409 &&
        err.code === "UNVERIFIED_ARCHIVE",
    );

    // 3. Transaction error -> reconciliation finds ARCHIVED with CONTRADICTORY link observations -> 409 UNVERIFIED_ARCHIVE
    preflightCalled = false;
    (prisma as any).auditLog.findFirst = async () => ({
      id: "audit-reconcile-contradictory",
      action: "SALE_EVIDENCE_ARCHIVED",
      entityType: "Document",
      entityId: mockUnresolved.id,
      meta: {
        documentId: mockUnresolved.id,
        reason: validReason,
        oldSaleRecoveryStatus: "UNRESOLVED",
        newSaleRecoveryStatus: "ARCHIVED",
        linkedEntityType: "Invoice",
        linkedEntityId: "inv-999",
      },
    });

    await assert.rejects(
      () =>
        archiveSaleEvidence(
          mockUnresolved.id,
          { reason: validReason },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) =>
        err instanceof SalesEvidenceConflictError &&
        err.statusCode === 409 &&
        err.code === "UNVERIFIED_ARCHIVE",
    );

    // 4. Transaction error -> reconciliation finds ARCHIVED with DIFFERENT reason & valid provenance -> 409 DECISION_CONFLICT
    preflightCalled = false;
    (prisma as any).auditLog.findFirst = async () => ({
      id: "audit-reconcile-diff-reason",
      action: "SALE_EVIDENCE_ARCHIVED",
      entityType: "Document",
      entityId: mockUnresolved.id,
      meta: {
        documentId: mockUnresolved.id,
        reason: "Different prior reason",
        oldSaleRecoveryStatus: "UNRESOLVED",
        newSaleRecoveryStatus: "ARCHIVED",
        linkedEntityType: null,
        linkedEntityId: null,
      },
    });

    await assert.rejects(
      () =>
        archiveSaleEvidence(
          mockUnresolved.id,
          { reason: validReason },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) =>
        err instanceof SalesEvidenceConflictError &&
        err.statusCode === 409 &&
        err.code === "DECISION_CONFLICT",
    );

    // 5. Transaction error -> reconciliation finds ADMIN_ONLY doc requested by MANAGER -> returns null (404, no disclosure)
    preflightCalled = false;
    documentDelegate.findFirst = async ({ where }: any) => {
      if (!preflightCalled) {
        preflightCalled = true;
        return { ...mockUnresolved, visibility: "ADMIN_MANAGER" as DocumentVisibility };
      }
      // Reconcile query: manager visibility filter filters out ADMIN_ONLY
      if (where.visibility?.in && !where.visibility.in.includes("ADMIN_ONLY")) {
        return null;
      }
      return { ...mockUnresolved, visibility: "ADMIN_ONLY" as DocumentVisibility, saleRecoveryStatus: "ARCHIVED" as const };
    };

    const hiddenReconcile = await archiveSaleEvidence(
      mockUnresolved.id,
      { reason: validReason },
      { id: "mgr-1", role: "MANAGER" },
      async () => fullPosCapabilities,
    );
    assert.equal(hiddenReconcile, null);

    // 6. Transaction error -> reconciliation finds committed document is ATTACHED -> 409 ATTACHED_CONFLICT
    preflightCalled = false;
    documentDelegate.findFirst = async () => {
      if (!preflightCalled) {
        preflightCalled = true;
        return mockUnresolved;
      }
      return {
        ...mockUnresolved,
        saleRecoveryStatus: "ARCHIVED" as const,
        linkedEntityType: "Invoice",
        linkedEntityId: "inv-888",
      };
    };

    await assert.rejects(
      () =>
        archiveSaleEvidence(
          mockUnresolved.id,
          { reason: validReason },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) =>
        err instanceof SalesEvidenceConflictError &&
        err.statusCode === 409 &&
        err.code === "ATTACHED_CONFLICT",
    );

    // 7. Transaction error -> reconciliation finds committed document has active operation -> 409 ACTIVE_OPERATION_CONFLICT
    preflightCalled = false;
    documentDelegate.findFirst = async () => {
      if (!preflightCalled) {
        preflightCalled = true;
        return mockUnresolved;
      }
      return {
        ...mockUnresolved,
        saleRecoveryStatus: "ARCHIVED" as const,
        recoveryCheckoutOperationKey: "op-key-reconcile",
        recoveryCheckoutPayloadHash: "op-hash-reconcile",
      };
    };

    await assert.rejects(
      () =>
        archiveSaleEvidence(
          mockUnresolved.id,
          { reason: validReason },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) =>
        err instanceof SalesEvidenceConflictError &&
        err.statusCode === 409 &&
        err.code === "ACTIVE_OPERATION_CONFLICT",
    );

    // 8. Transaction error -> document still UNRESOLVED -> propagates original transaction error
    preflightCalled = false;
    documentDelegate.findFirst = async () => mockUnresolved; // stays UNRESOLVED

    await assert.rejects(
      () =>
        archiveSaleEvidence(
          mockUnresolved.id,
          { reason: validReason },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) => err.message.includes("Simulated connection reset right after commit"),
    );

    // 9. Transaction error -> reconciliation query itself fails -> logs error and propagates original transaction error
    preflightCalled = false;
    documentDelegate.findFirst = async () => {
      if (!preflightCalled) {
        preflightCalled = true;
        return mockUnresolved;
      }
      throw new Error("Database network failure during reconciliation lookup");
    };

    await assert.rejects(
      () =>
        archiveSaleEvidence(
          mockUnresolved.id,
          { reason: validReason },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      (err: any) => err.message.includes("Simulated connection reset right after commit"),
    );
  } finally {
    documentDelegate.findFirst = originalFindFirst;
    prisma.$transaction = originalTransaction;
    if (originalAuditFindFirst) {
      (prisma as any).auditLog.findFirst = originalAuditFindFirst;
    }
  }
});

test("B-4: Original proof and thumbnail files on disk are completely preserved without byte modification", async () => {
  const documentDelegate = prisma.document as any;
  const originalFindFirst = documentDelegate.findFirst;
  const originalTransaction = prisma.$transaction;

  const originalContent = Buffer.from("EXACT_ORIGINAL_PROOF_BINARY_BYTES_12345");
  const thumbnailContent = Buffer.from("EXACT_THUMBNAIL_BINARY_BYTES_67890");

  const originalChecksum = crypto.createHash("sha256").update(originalContent).digest("hex");
  const thumbnailChecksum = crypto.createHash("sha256").update(thumbnailContent).digest("hex");

  const mockRow = buildMockRow({
    id: "doc-byte-preservation-1",
    saleRecoveryStatus: "UNRESOLVED",
    fileSize: originalContent.length,
    checksum: originalChecksum,
    thumbnailSize: thumbnailContent.length,
  });

  const originalFilePath = await createStoredFile(mockRow.storedPath, mockRow.storedFileName, originalContent);
  const thumbnailFilePath = await createStoredFile(
    mockRow.storedPath,
    mockRow.thumbnailFileName,
    thumbnailContent,
  );

  try {
    documentDelegate.findFirst = async () => mockRow;

    prisma.$transaction = (async (callback: any) => {
      const tx = {
        $queryRaw: async () => [],
        document: {
          findFirst: async () => mockRow,
          updateMany: async () => ({ count: 1 }),
        },
        auditLog: {
          create: async ({ data }: any) => ({
            id: "audit-byte-1",
            ...data,
            createdAt: new Date(),
          }),
        },
      };
      return callback(tx);
    }) as any;

    const res = await archiveSaleEvidence(
      mockRow.id,
      { reason: "Audit archive preservation test" },
      { id: "admin-1", role: "ADMIN" },
      async () => fullPosCapabilities,
    );
    assert.ok(res);
    assert.equal(res.document.saleRecoveryStatus, "ARCHIVED");

    // Verify disk files
    const onDiskOriginal = await fs.readFile(originalFilePath);
    const onDiskThumbnail = await fs.readFile(thumbnailFilePath);

    assert.equal(
      crypto.createHash("sha256").update(onDiskOriginal).digest("hex"),
      originalChecksum,
      "Original file bytes must remain identical",
    );
    assert.equal(
      crypto.createHash("sha256").update(onDiskThumbnail).digest("hex"),
      thumbnailChecksum,
      "Thumbnail file bytes must remain identical",
    );
  } finally {
    documentDelegate.findFirst = originalFindFirst;
    prisma.$transaction = originalTransaction;
  }
});

test("B-5: HTTP router archive endpoint matrix: session auth, CSRF, roles, attached conflict, conflict payloads with document, and hidden 404", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/sales-evidence", salesEvidenceRoutes);

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });

  const originalAuthFindUnique = prisma.authSession.findUnique;
  const originalBusinessSettingsUpsert = (prisma as any).businessSettings?.upsert;
  const originalBusinessSettingsFindUnique = (prisma as any).businessSettings?.findUnique;
  const originalTransaction = prisma.$transaction;
  const documentDelegate = prisma.document as any;
  const originalFindFirst = documentDelegate.findFirst;
  const originalAuditFindFirst = (prisma as any).auditLog?.findFirst;

  const testRow = buildMockRow({
    id: "doc-http-archive-101",
    saleRecoveryStatus: "UNRESOLVED",
  });
  await createStoredFile(testRow.storedPath, testRow.storedFileName);

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}/api/sales-evidence/${testRow.id}/archive`;

    const adminSession = createTestSession({ id: "admin-1", role: "ADMIN" });
    const managerSession = createTestSession({ id: "mgr-1", role: "MANAGER" });
    const cashierSession = createTestSession({ id: "cashier-1", role: "CASHIER" });

    const sessionsMap = new Map<string, any>([
      [adminSession.sessionRecord.tokenHash, adminSession.sessionRecord],
      [managerSession.sessionRecord.tokenHash, managerSession.sessionRecord],
      [cashierSession.sessionRecord.tokenHash, cashierSession.sessionRecord],
    ]);

    prisma.authSession.findUnique = (async ({ where }: any) => {
      return sessionsMap.get(where.tokenHash) || null;
    }) as any;

    let currentBusinessSettings = {
      id: "default",
      businessName: "KhataSathi Store",
      businessAddress: "Kathmandu, Nepal",
      businessPhone: "9800000000",
      businessPan: null,
      businessVat: null,
      businessMode: "FULL_POS",
      staffDraftRequestsEnabled: true,
      defaultInitialStock: 0,
      defaultLowStockThreshold: 5,
      defaultWholesaleQtyThreshold: 10,
      loyaltyDiscountPercent: 5,
      returnWindowDays: 7,
      parkedBillExpiryHours: 24,
      draftRequestExpiryMinutes: 30,
    };

    if (!(prisma as any).businessSettings) {
      (prisma as any).businessSettings = {};
    }
    (prisma as any).businessSettings.upsert = async () => currentBusinessSettings;
    (prisma as any).businessSettings.findUnique = async () => currentBusinessSettings;
    invalidateBusinessSettingsCache();

    documentDelegate.findFirst = async () => testRow;

    prisma.$transaction = (async (callback: any) => {
      const tx = {
        $queryRaw: async () => [],
        document: {
          findFirst: async () => testRow,
          updateMany: async () => ({ count: 1 }),
        },
        auditLog: {
          create: async ({ data }: any) => ({
            id: "audit-http-1",
            ...data,
            createdAt: new Date(),
          }),
        },
      };
      return callback(tx);
    }) as any;

    // 1. Unauthenticated request -> 401
    const unauthRes = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Valid archive reason text" }),
    });
    assert.equal(unauthRes.status, 401);

    // 2. Missing CSRF on POST -> 403 CSRF_INVALID
    const noCsrfRes = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: adminSession.signedCookie,
      },
      body: JSON.stringify({ reason: "Valid archive reason text" }),
    });
    assert.equal(noCsrfRes.status, 403);
    const noCsrfJson = await noCsrfRes.json();
    assert.equal(noCsrfJson.code, "CSRF_INVALID");

    // 3. Invalid CSRF on POST -> 403 CSRF_INVALID
    const badCsrfRes = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: adminSession.signedCookie,
        [CSRF_HEADER_NAME]: "wrong-csrf-token",
      },
      body: JSON.stringify({ reason: "Valid archive reason text" }),
    });
    assert.equal(badCsrfRes.status, 403);
    const badCsrfJson = await badCsrfRes.json();
    assert.equal(badCsrfJson.code, "CSRF_INVALID");

    // 4. Cashier role -> 403
    const cashierRes = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: cashierSession.signedCookie,
        [CSRF_HEADER_NAME]: cashierSession.rawCsrf,
      },
      body: JSON.stringify({ reason: "Valid archive reason text" }),
    });
    assert.equal(cashierRes.status, 403);

    // 5. Invalid body (<2 chars) -> 400
    const invalidBodyRes = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: adminSession.signedCookie,
        [CSRF_HEADER_NAME]: adminSession.rawCsrf,
      },
      body: JSON.stringify({ reason: "a" }),
    });
    assert.equal(invalidBodyRes.status, 400);

    // 6. Unknown field in body -> 400
    const extraFieldRes = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: adminSession.signedCookie,
        [CSRF_HEADER_NAME]: adminSession.rawCsrf,
      },
      body: JSON.stringify({
        reason: "Valid archive reason text",
        extraField: "not allowed",
      }),
    });
    assert.equal(extraFieldRes.status, 400);

    // 7. Successful first archive -> 200 { document, replayed: false }
    const successRes = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: adminSession.signedCookie,
        [CSRF_HEADER_NAME]: adminSession.rawCsrf,
      },
      body: JSON.stringify({
        reason: "Valid physical bill duplicate archive decision",
      }),
    });
    assert.equal(successRes.status, 200);
    const successJson = await successRes.json();
    assert.equal(successJson.replayed, false);
    assert.equal(successJson.document.id, testRow.id);
    assert.equal(successJson.document.saleRecoveryStatus, "ARCHIVED");
    assert.equal("recoveryCheckoutOperationKey" in successJson.document, false);

    // 8. Conflict response (different reason) -> 409 { code: "DECISION_CONFLICT", error: "...", document: { ... } }
    const archivedRow = buildMockRow({
      id: "doc-http-conflict-1",
      saleRecoveryStatus: "ARCHIVED",
    });
    await createStoredFile(archivedRow.storedPath, archivedRow.storedFileName);
    documentDelegate.findFirst = async () => archivedRow;
    (prisma as any).auditLog = {
      findFirst: async () => ({
        id: "audit-http-archived",
        action: "SALE_EVIDENCE_ARCHIVED",
        entityType: "Document",
        entityId: archivedRow.id,
        meta: {
          documentId: archivedRow.id,
          reason: "Prior accepted reason",
          oldSaleRecoveryStatus: "UNRESOLVED",
          newSaleRecoveryStatus: "ARCHIVED",
          linkedEntityType: null,
          linkedEntityId: null,
        },
      }),
    };

    const conflictRes = await fetch(
      `http://127.0.0.1:${address.port}/api/sales-evidence/${archivedRow.id}/archive`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: adminSession.signedCookie,
          [CSRF_HEADER_NAME]: adminSession.rawCsrf,
        },
        body: JSON.stringify({
          reason: "Different decision explanation",
        }),
      },
    );
    assert.equal(conflictRes.status, 409);
    const conflictJson = await conflictRes.json();
    assert.equal(conflictJson.code, "DECISION_CONFLICT");
    assert.ok(conflictJson.document, "Conflict response must include resolved public document");
    assert.equal(conflictJson.document.id, archivedRow.id);
    assert.equal(conflictJson.document.saleRecoveryStatus, "ARCHIVED");

    // 9. Conflict response for attached evidence -> 409 { code: "ATTACHED_CONFLICT", error: "...", document: { ... } }
    const attachedRow = buildMockRow({
      id: "doc-http-attached-1",
      saleRecoveryStatus: "ATTACHED",
      linkedEntityType: "Invoice",
      linkedEntityId: "inv-12345",
    });
    await createStoredFile(attachedRow.storedPath, attachedRow.storedFileName);
    documentDelegate.findFirst = async () => attachedRow;

    const attachedRes = await fetch(
      `http://127.0.0.1:${address.port}/api/sales-evidence/${attachedRow.id}/archive`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: adminSession.signedCookie,
          [CSRF_HEADER_NAME]: adminSession.rawCsrf,
        },
        body: JSON.stringify({
          reason: "Attempt to archive attached invoice",
        }),
      },
    );
    assert.equal(attachedRes.status, 409);
    const attachedJson = await attachedRes.json();
    assert.equal(attachedJson.code, "ATTACHED_CONFLICT");
    assert.ok(attachedJson.document, "Attached conflict must include resolved public document");
    assert.equal(attachedJson.document.id, attachedRow.id);
    assert.equal(attachedJson.document.saleRecoveryStatus, "ATTACHED");
    assert.equal(attachedJson.document.linkedEntityType, "Invoice");
    assert.equal(attachedJson.document.linkedEntityId, "inv-12345");

    // 10. Hidden ADMIN_ONLY document requested by MANAGER -> 404 without disclosure
    const adminOnlyDoc = buildMockRow({
      id: "doc-http-admin-only",
      visibility: "ADMIN_ONLY",
      saleRecoveryStatus: "UNRESOLVED",
    });
    await createStoredFile(adminOnlyDoc.storedPath, adminOnlyDoc.storedFileName);

    documentDelegate.findFirst = async ({ where }: any) => {
      if (where.visibility?.in && !where.visibility.in.includes(adminOnlyDoc.visibility)) {
        return null;
      }
      return adminOnlyDoc;
    };

    const hiddenRes = await fetch(
      `http://127.0.0.1:${address.port}/api/sales-evidence/${adminOnlyDoc.id}/archive`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: managerSession.signedCookie,
          [CSRF_HEADER_NAME]: managerSession.rawCsrf,
        },
        body: JSON.stringify({
          reason: "Valid reason from manager",
        }),
      },
    );
    assert.equal(hiddenRes.status, 404);
    const hiddenJson = await hiddenRes.json();
    assert.equal(hiddenJson.error, "Sales evidence not found");
    assert.equal("document" in hiddenJson, false);
  } finally {
    prisma.authSession.findUnique = originalAuthFindUnique;
    if ((prisma as any).businessSettings) {
      (prisma as any).businessSettings.upsert = originalBusinessSettingsUpsert;
      (prisma as any).businessSettings.findUnique = originalBusinessSettingsFindUnique;
    }
    documentDelegate.findFirst = originalFindFirst;
    prisma.$transaction = originalTransaction;
    if (originalAuditFindFirst) (prisma as any).auditLog.findFirst = originalAuditFindFirst;
    invalidateBusinessSettingsCache();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("Dedicated read, search, and file retrieval for ARCHIVED evidence", async () => {
  const documentDelegate = prisma.document as any;
  const originalFindFirst = documentDelegate.findFirst;
  const originalFindMany = documentDelegate.findMany;
  const originalCount = documentDelegate.count;

  const archivedDoc = buildMockRow({
    id: "doc-read-archived-1",
    title: "Archived Receipt Copy",
    fileName: "archived_receipt.jpg",
    saleRecoveryStatus: "ARCHIVED",
  });
  await createStoredFile(archivedDoc.storedPath, archivedDoc.storedFileName);
  await createStoredFile(
    archivedDoc.storedPath,
    archivedDoc.thumbnailFileName,
  );

  try {
    documentDelegate.findFirst = async () => archivedDoc;
    documentDelegate.findMany = async () => [archivedDoc];
    documentDelegate.count = async () => 1;

    // 1. Get by ID
    const single = await getSaleEvidenceById(
      archivedDoc.id,
      { id: "admin-1", role: "ADMIN" },
      async () => fullPosCapabilities,
    );
    assert.ok(single);
    assert.equal(single.saleRecoveryStatus, "ARCHIVED");

    // 2. List with filter saleRecoveryStatus = "ARCHIVED"
    const listResult = await listSaleEvidence(
      { saleRecoveryStatus: "ARCHIVED", page: 1, pageSize: 20 },
      { id: "admin-1", role: "ADMIN" },
      async () => fullPosCapabilities,
    );
    assert.equal(listResult.total, 1);
    assert.equal(listResult.documents[0].saleRecoveryStatus, "ARCHIVED");

    // 3. Get file path
    const fileResult = await getSaleEvidenceFile(
      archivedDoc.id,
      { id: "admin-1", role: "ADMIN" },
      async () => fullPosCapabilities,
    );
    assert.ok(fileResult);
    assert.ok(fileResult.filePath);

    // 4. Get thumbnail path
    const thumbResult = await getSaleEvidenceThumbnail(
      archivedDoc.id,
      { id: "admin-1", role: "ADMIN" },
      async () => fullPosCapabilities,
    );
    assert.ok(thumbResult);
    assert.ok(thumbResult.thumbnailPath);
  } finally {
    documentDelegate.findFirst = originalFindFirst;
    documentDelegate.findMany = originalFindMany;
    documentDelegate.count = originalCount;
  }
});
