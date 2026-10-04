import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import express from "express";
import prisma from "../db/prisma";

// Isolated storage root
const isolatedStorageRoot = fsSync.mkdtempSync(
  path.join(os.tmpdir(), "ks-sales-access-storage-"),
);
process.env.DOCUMENT_STORAGE_ROOT = isolatedStorageRoot;

const { documentStorageRoot } = require("../lib/storageReadiness") as typeof import("../lib/storageReadiness");
assert.equal(documentStorageRoot, isolatedStorageRoot);

const {
  listSaleEvidence,
  getSaleEvidenceById,
  getSaleEvidenceFile,
  getSaleEvidenceThumbnail,
} = require("../modules/salesEvidence/service") as typeof import("../modules/salesEvidence/service");
const {
  getSaleEvidenceFileHandler,
  getSaleEvidenceThumbnailHandler,
} = require("../modules/salesEvidence/controller") as typeof import("../modules/salesEvidence/controller");
const {
  listDocuments,
  getDocumentById,
} = require("../modules/documents/service") as typeof import("../modules/documents/service");
const salesEvidenceRoutes = (require("../modules/salesEvidence/routes") as { default: express.Router }).default;
const documentRoutes = (require("../modules/documents/routes") as { default: express.Router }).default;
const {
  signSessionToken,
  hashSessionSecret,
  SESSION_COOKIE_NAME,
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

function buildMockRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "doc-sale-101",
    documentType: "SALE_BILL" as DocumentType,
    title: "Sale Invoice Receipt",
    fileName: "receipt_101.jpg",
    storedFileName: "doc-sale-101_sale-bill.jpg",
    storedPath: "documents/2026/10/W40",
    mimeType: "image/jpeg",
    fileSize: 102400,
    checksum: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    thumbnailFileName: "doc-sale-101.webp",
    thumbnailSize: 4096,
    supplierName: null,
    billNumber: null,
    billDate: null,
    billAmount: null,
    remarks: "Cash register copy",
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
    recoveryCheckoutOperationKey: "secret-opkey-999",
    recoveryCheckoutPayloadHash: "secret-hash-999",
    uploadedBy: {
      id: "user-admin-1",
      name: "Admin User",
    },
    ...overrides,
  };
}

function mockResponse(capabilities = fullPosCapabilities) {
  const res: any = {
    statusCode: 200,
    jsonData: null,
    headers: {},
    sentFile: null,
    locals: {
      businessCapabilities: capabilities,
    },
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
    sendFile(filePath: string) {
      res.sentFile = filePath;
      return res;
    },
  };
  return res;
}

function createTestSession(user: {
  id: string;
  role: string;
  isActive?: boolean;
  mustChangePassword?: boolean;
}) {
  const rawToken = "test-token-" + Math.random().toString(36).slice(2);
  const tokenHash = hashSessionSecret(rawToken);
  const signedCookie = `${SESSION_COOKIE_NAME}=${signSessionToken(rawToken)}`;
  const sessionRecord = {
    id: "session-" + Math.random().toString(36).slice(2),
    tokenHash,
    csrfTokenHash: "dummy-csrf-hash",
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
    signedCookie,
    sessionRecord,
  };
}

test("listSaleEvidence returns paginated sales evidence, masks recovery keys/hashes, and supports status & search filters", async () => {
  const documentDelegate = prisma.document as any;
  const originalFindMany = documentDelegate.findMany;
  const originalCount = documentDelegate.count;

  const row1 = buildMockRow({ id: "doc-1", title: "Counter Receipt A", saleRecoveryStatus: "UNRESOLVED" });
  const row2 = buildMockRow({ id: "doc-2", title: "Counter Receipt B", saleRecoveryStatus: "ATTACHED" });
  const row3 = buildMockRow({ id: "doc-3", title: "Legacy Bill C", saleRecoveryStatus: null });

  try {
    let capturedWhere: any = null;
    let capturedOrderBy: any = null;

    documentDelegate.findMany = async ({ where, orderBy }: any) => {
      capturedWhere = where;
      capturedOrderBy = orderBy;
      return [row1, row2, row3];
    };
    documentDelegate.count = async ({ where }: any) => 3;

    const result = await listSaleEvidence(
      { page: 1, pageSize: 20, q: "Receipt", saleRecoveryStatus: "UNRESOLVED" },
      { id: "admin-1", role: "ADMIN" },
      async () => fullPosCapabilities,
    );

    assert.equal(result.total, 3);
    assert.equal(result.documents.length, 3);

    // Deterministic ordering
    assert.deepEqual(capturedOrderBy, [{ createdAt: "desc" }, { id: "desc" }]);

    // Query filters applied
    assert.equal(capturedWhere.documentType, "SALE_BILL");
    assert.equal(capturedWhere.deletedAt, null);
    assert.equal(capturedWhere.saleRecoveryStatus, "UNRESOLVED");
    assert.deepEqual(capturedWhere.OR, [
      { title: { contains: "Receipt" } },
      { fileName: { contains: "Receipt" } },
    ]);

    // Secret recovery keys/hashes excluded from all items
    for (const item of result.documents) {
      assert.equal("recoveryCheckoutOperationKey" in item, false);
      assert.equal("recoveryCheckoutPayloadHash" in item, false);
      assert.equal("processingStatus" in item, false);
      assert.equal("processingLabel" in item, false);
    }

    // Explicit saleRecoveryStatus projection
    assert.equal(result.documents[0].saleRecoveryStatus, "UNRESOLVED");
    assert.equal(result.documents[1].saleRecoveryStatus, "ATTACHED");
    assert.equal(result.documents[2].saleRecoveryStatus, null);
  } finally {
    documentDelegate.findMany = originalFindMany;
    documentDelegate.count = originalCount;
  }
});

test("listSaleEvidence enforces reviewer visibility: MANAGER cannot see ADMIN_ONLY rows", async () => {
  const documentDelegate = prisma.document as any;
  const originalFindMany = documentDelegate.findMany;
  const originalCount = documentDelegate.count;

  try {
    let capturedWhere: any = null;
    documentDelegate.findMany = async ({ where }: any) => {
      capturedWhere = where;
      return [];
    };
    documentDelegate.count = async () => 0;

    // MANAGER query
    await listSaleEvidence(
      { page: 1, pageSize: 10 },
      { id: "mgr-1", role: "MANAGER" },
      async () => fullPosCapabilities,
    );

    assert.deepEqual(capturedWhere.visibility, {
      in: ["ALL_AUTHENTICATED", "ADMIN_MANAGER"],
    });

    // ADMIN query has no visibility filter
    await listSaleEvidence(
      { page: 1, pageSize: 10 },
      { id: "adm-1", role: "ADMIN" },
      async () => fullPosCapabilities,
    );
    assert.equal("visibility" in capturedWhere, false);
  } finally {
    documentDelegate.findMany = originalFindMany;
    documentDelegate.count = originalCount;
  }
});

test("getSaleEvidenceById returns projected document for active SALE_BILL and hides ADMIN_ONLY from MANAGER", async () => {
  const documentDelegate = prisma.document as any;
  const originalFindFirst = documentDelegate.findFirst;

  const adminOnlyRow = buildMockRow({ id: "doc-admin-only", visibility: "ADMIN_ONLY" });
  const adminManagerRow = buildMockRow({ id: "doc-admin-mgr", visibility: "ADMIN_MANAGER" });

  try {
    documentDelegate.findFirst = async ({ where }: any) => {
      if (where.id === "doc-admin-only") return adminOnlyRow;
      if (where.id === "doc-admin-mgr") return adminManagerRow;
      return null;
    };

    // ADMIN sees ADMIN_ONLY
    const adminView = await getSaleEvidenceById(
      "doc-admin-only",
      { id: "adm-1", role: "ADMIN" },
      async () => fullPosCapabilities,
    );
    assert.ok(adminView);
    assert.equal(adminView.id, "doc-admin-only");
    assert.equal("recoveryCheckoutOperationKey" in adminView, false);

    // MANAGER denied ADMIN_ONLY (returns null -> 404)
    const managerViewAdminOnly = await getSaleEvidenceById(
      "doc-admin-only",
      { id: "mgr-1", role: "MANAGER" },
      async () => fullPosCapabilities,
    );
    assert.equal(managerViewAdminOnly, null);

    // MANAGER sees ADMIN_MANAGER
    const managerViewAdminMgr = await getSaleEvidenceById(
      "doc-admin-mgr",
      { id: "mgr-1", role: "MANAGER" },
      async () => fullPosCapabilities,
    );
    assert.ok(managerViewAdminMgr);
    assert.equal(managerViewAdminMgr.id, "doc-admin-mgr");
  } finally {
    documentDelegate.findFirst = originalFindFirst;
  }
});

test("getSaleEvidenceFile and getSaleEvidenceThumbnail resolve files and serve inline headers; missing file/thumbnail returns 404", async () => {
  const documentDelegate = prisma.document as any;
  const originalFindFirst = documentDelegate.findFirst;

  // Create real files in the isolated storage root
  const subFolder = path.join(isolatedStorageRoot, "documents", "2026", "10", "W40");
  await fs.mkdir(subFolder, { recursive: true });
  const originalFile = path.join(subFolder, "doc-sale-101_sale-bill.jpg");
  const thumbFile = path.join(subFolder, "doc-sale-101.webp");
  await fs.writeFile(originalFile, Buffer.from("fake-jpg-bytes"));
  await fs.writeFile(thumbFile, Buffer.from("fake-webp-bytes"));

  const mockRow = buildMockRow();
  const mockRowMissingThumb = buildMockRow({ id: "doc-no-thumb", thumbnailFileName: null });
  const mockRowMissingFile = buildMockRow({ id: "doc-missing-file", storedFileName: "absent.jpg" });

  try {
    documentDelegate.findFirst = async ({ where }: any) => {
      if (where.id === "doc-sale-101") return mockRow;
      if (where.id === "doc-no-thumb") return mockRowMissingThumb;
      if (where.id === "doc-missing-file") return mockRowMissingFile;
      return null;
    };

    // 1. Test File Handler - Success
    const reqFile: any = {
      params: { id: "doc-sale-101" },
      user: { id: "admin-1", role: "ADMIN" },
    };
    const resFile = mockResponse();
    await getSaleEvidenceFileHandler(reqFile, resFile);
    assert.equal(resFile.statusCode, 200);
    assert.equal(resFile.headers["Content-Type"], "image/jpeg");
    assert.ok(resFile.headers["Content-Disposition"].includes("inline"));
    assert.equal(resFile.sentFile, originalFile);

    // 2. Test File Handler - Missing file on disk -> 404
    const reqMissingFile: any = {
      params: { id: "doc-missing-file" },
      user: { id: "admin-1", role: "ADMIN" },
    };
    const resMissingFile = mockResponse();
    await getSaleEvidenceFileHandler(reqMissingFile, resMissingFile);
    assert.equal(resMissingFile.statusCode, 404);

    // 3. Test Thumbnail Handler - Success
    const reqThumb: any = {
      params: { id: "doc-sale-101" },
      user: { id: "admin-1", role: "ADMIN" },
    };
    const resThumb = mockResponse();
    await getSaleEvidenceThumbnailHandler(reqThumb, resThumb);
    assert.equal(resThumb.statusCode, 200);
    assert.equal(resThumb.headers["Content-Type"], "image/webp");
    assert.equal(resThumb.headers["Cache-Control"], "private, max-age=300, must-revalidate");
    assert.equal(resThumb.sentFile, thumbFile);

    // 4. Test Thumbnail Handler - Missing thumbnail -> 404
    const reqMissingThumb: any = {
      params: { id: "doc-no-thumb" },
      user: { id: "admin-1", role: "ADMIN" },
    };
    const resMissingThumb = mockResponse();
    await getSaleEvidenceThumbnailHandler(reqMissingThumb, resMissingThumb);
    assert.equal(resMissingThumb.statusCode, 404);
  } finally {
    documentDelegate.findFirst = originalFindFirst;
  }
});

test("generic /api/documents list excludes every SALE_BILL for all roles, even with explicit filter attempts", async () => {
  const documentDelegate = prisma.document as any;
  const originalFindMany = documentDelegate.findMany;
  const originalCount = documentDelegate.count;

  try {
    let capturedWhere: any = null;
    documentDelegate.findMany = async ({ where }: any) => {
      capturedWhere = where;
      return [];
    };
    documentDelegate.count = async () => 0;

    // Default generic list
    await listDocuments({ page: 1, pageSize: 20 }, "ADMIN");
    assert.deepEqual(capturedWhere.documentType, { not: "SALE_BILL" });

    // Explicit generic list with standard type
    await listDocuments({ page: 1, pageSize: 20, documentType: "STOCK_BILL" }, "ADMIN");
    assert.equal(capturedWhere.documentType, "STOCK_BILL");

    // Attempted generic list filtering for SALE_BILL is forced to match empty set
    await listDocuments({ page: 1, pageSize: 20, documentType: "SALE_BILL" as any }, "ADMIN");
    assert.deepEqual(capturedWhere.documentType, { in: [] });
  } finally {
    documentDelegate.findMany = originalFindMany;
    documentDelegate.count = originalCount;
  }
});

test("generic getDocumentById returns null for SALE_BILL regardless of visibility (including ALL_AUTHENTICATED) or viewer role", async () => {
  const documentDelegate = prisma.document as any;
  const originalFindFirst = documentDelegate.findFirst;

  const saleBillRow = buildMockRow({ visibility: "ALL_AUTHENTICATED" });
  const stockBillRow = buildMockRow({ id: "doc-stock-1", documentType: "STOCK_BILL" });

  try {
    documentDelegate.findFirst = async ({ where }: any) => {
      if (where.id === "doc-sale-101") return saleBillRow;
      if (where.id === "doc-stock-1") return stockBillRow;
      return null;
    };

    // Generic get for SALE_BILL is denied for ADMIN, MANAGER, CASHIER, STAFF
    assert.equal(await getDocumentById("doc-sale-101", "ADMIN"), null);
    assert.equal(await getDocumentById("doc-sale-101", "MANAGER"), null);
    assert.equal(await getDocumentById("doc-sale-101", "CASHIER"), null);
    assert.equal(await getDocumentById("doc-sale-101", "STAFF"), null);

    // Standard document is returned normally
    const stockDoc = await getDocumentById("doc-stock-1", "ADMIN");
    assert.ok(stockDoc);
    assert.equal(stockDoc.documentType, "STOCK_BILL");
  } finally {
    documentDelegate.findFirst = originalFindFirst;
  }
});

test("HTTP router access matrix: covers collection, detail, file, thumbnail, query bounds, role denials, POS mode and generic exclusion", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/sales-evidence", salesEvidenceRoutes);
  app.use("/api/documents", documentRoutes);

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });

  const originalAuthFindUnique = prisma.authSession.findUnique;
  const originalBusinessSettingsUpsert = (prisma as any).businessSettings?.upsert;
  const originalBusinessSettingsFindUnique = (prisma as any).businessSettings?.findUnique;
  const documentDelegate = prisma.document as any;
  const originalFindMany = documentDelegate.findMany;
  const originalFindFirst = documentDelegate.findFirst;
  const originalCount = documentDelegate.count;

  // Real files on disk for file/thumbnail endpoints
  const subFolder = path.join(isolatedStorageRoot, "documents", "2026", "10", "W40");
  await fs.mkdir(subFolder, { recursive: true });
  const realFile = path.join(subFolder, "doc-sale-101_sale-bill.jpg");
  const realThumb = path.join(subFolder, "doc-sale-101.webp");
  const realStockFile = path.join(subFolder, "stock-1_stock-bill.jpg");
  await fs.writeFile(realFile, Buffer.from("image-content-bytes"));
  await fs.writeFile(realThumb, Buffer.from("thumb-content-bytes"));
  await fs.writeFile(realStockFile, Buffer.from("stock-content-bytes"));

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const adminSession = createTestSession({ id: "admin-1", role: "ADMIN" });
    const managerSession = createTestSession({ id: "mgr-1", role: "MANAGER" });
    const cashierSession = createTestSession({ id: "cashier-1", role: "CASHIER" });
    const staffSession = createTestSession({ id: "staff-1", role: "STAFF" });
    const unknownSession = createTestSession({ id: "unknown-1", role: "UNKNOWN" });

    const sessionsMap = new Map<string, any>([
      [adminSession.sessionRecord.tokenHash, adminSession.sessionRecord],
      [managerSession.sessionRecord.tokenHash, managerSession.sessionRecord],
      [cashierSession.sessionRecord.tokenHash, cashierSession.sessionRecord],
      [staffSession.sessionRecord.tokenHash, staffSession.sessionRecord],
      [unknownSession.sessionRecord.tokenHash, unknownSession.sessionRecord],
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

    const saleBillAdminManager = buildMockRow({ id: "sale-1", visibility: "ADMIN_MANAGER" });
    const saleBillAdminOnly = buildMockRow({ id: "sale-admin-only", visibility: "ADMIN_ONLY" });
    const saleBillLegacyBroad = buildMockRow({
      id: "sale-legacy-broad",
      visibility: "ALL_AUTHENTICATED",
      saleRecoveryStatus: null,
    });
    const saleBillDeleted = buildMockRow({
      id: "sale-deleted",
      deletedAt: new Date("2026-10-04T10:00:00.000Z"),
    });
    const genericStockDoc = buildMockRow({
      id: "stock-1",
      documentType: "STOCK_BILL",
      storedFileName: "stock-1_stock-bill.jpg",
      visibility: "ALL_AUTHENTICATED",
    });

    const allDocuments = [
      saleBillAdminManager,
      saleBillAdminOnly,
      saleBillLegacyBroad,
      saleBillDeleted,
      genericStockDoc,
    ];

    const ordinaryTypes = ["PRODUCT_IMPORT", "RETURN_PROOF", "PAYMENT_PROOF", "DISCOUNT_PROOF", "GENERAL"];
    for (const documentType of ordinaryTypes) {
      allDocuments.push(buildMockRow({ ...genericStockDoc, id: `ordinary-${documentType}`, documentType }));
    }
    allDocuments.push(buildMockRow({ id: "missing-original", storedFileName: "missing.jpg" }));
    allDocuments.push(buildMockRow({ id: "missing-thumbnail", thumbnailFileName: "missing.webp" }));
    allDocuments.push(buildMockRow({ id: "null-thumbnail", thumbnailFileName: null }));

    function matchesWhere(row: any, where: any): boolean {
      if (!where) return true;
      return Object.entries(where).every(([key, value]: [string, any]) => {
        if (key === "AND") return value.every((clause: any) => matchesWhere(row, clause));
        if (key === "OR") return value.some((clause: any) => matchesWhere(row, clause));
        if (value && typeof value === "object") {
          if ("not" in value && row[key] === value.not) return false;
          if ("in" in value && !value.in.includes(row[key])) return false;
          if ("contains" in value && !String(row[key] ?? "").includes(value.contains)) return false;
          return true;
        }
        return row[key] === value;
      });
    }
    documentDelegate.findMany = async ({ where, skip = 0, take }: any) => {
      const rows = allDocuments.filter((d) => matchesWhere(d, where));
      return rows.slice(skip, take === undefined ? undefined : skip + take);
    };
    documentDelegate.count = async ({ where }: any) => allDocuments.filter((d) => matchesWhere(d, where)).length;
    documentDelegate.findFirst = async ({ where }: any) => allDocuments.find((d) => matchesWhere(d, where)) ?? null;

    // 1. Unauthenticated requests -> 401
    assert.equal((await fetch(`${baseUrl}/api/sales-evidence`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/sales-evidence/sale-1`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/sales-evidence/sale-1/file`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/sales-evidence/sale-1/thumbnail`)).status, 401);

    // 2. Role denials: CASHIER, STAFF, UNKNOWN -> 403
    for (const session of [cashierSession, staffSession, unknownSession]) {
      const listRes = await fetch(`${baseUrl}/api/sales-evidence`, {
        headers: { cookie: session.signedCookie },
      });
      assert.equal(listRes.status, 403, `List should return 403 for role ${session.sessionRecord.user.role}`);

      const detailRes = await fetch(`${baseUrl}/api/sales-evidence/sale-1`, {
        headers: { cookie: session.signedCookie },
      });
      assert.equal(detailRes.status, 403, `Detail should return 403 for role ${session.sessionRecord.user.role}`);

      const fileRes = await fetch(`${baseUrl}/api/sales-evidence/sale-1/file`, {
        headers: { cookie: session.signedCookie },
      });
      assert.equal(fileRes.status, 403, `File should return 403 for role ${session.sessionRecord.user.role}`);

      const thumbRes = await fetch(`${baseUrl}/api/sales-evidence/sale-1/thumbnail`, {
        headers: { cookie: session.signedCookie },
      });
      assert.equal(thumbRes.status, 403, `Thumbnail should return 403 for role ${session.sessionRecord.user.role}`);
    }

    // 3. POS capability disabled mode -> 403 FEATURE_DISABLED on all dedicated endpoints
    currentBusinessSettings = { ...currentBusinessSettings, businessMode: "CATALOG_ONLY" };
    invalidateBusinessSettingsCache();
    for (const ep of [
      `${baseUrl}/api/sales-evidence`,
      `${baseUrl}/api/sales-evidence/sale-1`,
      `${baseUrl}/api/sales-evidence/sale-1/file`,
      `${baseUrl}/api/sales-evidence/sale-1/thumbnail`,
    ]) {
      const posRes = await fetch(ep, {
        headers: { cookie: adminSession.signedCookie },
      });
      assert.equal(posRes.status, 403, `Expected 403 for ${ep} when POS is disabled`);
      const posJson = await posRes.json();
      assert.equal(posJson.code, "FEATURE_DISABLED");
    }
    currentBusinessSettings = { ...currentBusinessSettings, businessMode: "FULL_POS" };
    invalidateBusinessSettingsCache();

    // 4. Authorized Collection (GET /api/sales-evidence) for ADMIN and MANAGER
    const adminListRes = await fetch(`${baseUrl}/api/sales-evidence?page=1&pageSize=20`, {
      headers: { cookie: adminSession.signedCookie },
    });
    assert.equal(adminListRes.status, 200);
    const adminListJson = await adminListRes.json();
    assert.ok(adminListJson.documents.length >= 2);
    assert.equal(adminListJson.documents[0].saleRecoveryStatus, "UNRESOLVED");
    assert.equal("recoveryCheckoutOperationKey" in adminListJson.documents[0], false);

    const mgrListRes = await fetch(`${baseUrl}/api/sales-evidence?page=1&pageSize=20`, {
      headers: { cookie: managerSession.signedCookie },
    });
    assert.equal(mgrListRes.status, 200);
    const mgrListJson = await mgrListRes.json();
    // Manager does not see ADMIN_ONLY rows
    assert.equal(
      mgrListJson.documents.some((d: any) => d.id === "sale-admin-only"),
      false,
      "Manager list must not include ADMIN_ONLY evidence",
    );

    // Strict query bounds: pageSize > 100 or page <= 0 -> 400
    const invalidPageSizeRes = await fetch(`${baseUrl}/api/sales-evidence?pageSize=200`, {
      headers: { cookie: adminSession.signedCookie },
    });
    assert.equal(invalidPageSizeRes.status, 400);

    const invalidPageRes = await fetch(`${baseUrl}/api/sales-evidence?page=0`, {
      headers: { cookie: adminSession.signedCookie },
    });
    assert.equal(invalidPageRes.status, 400);

    for (const item of [...adminListJson.documents, ...mgrListJson.documents]) {
      assert.equal("recoveryCheckoutOperationKey" in item, false);
      assert.equal("recoveryCheckoutPayloadHash" in item, false);
    }
    for (const query of ["unknown=value", "saleRecoveryStatus=INVALID", "q=" + "x".repeat(256)]) {
      assert.equal((await fetch(`${baseUrl}/api/sales-evidence?${query}`, {
        headers: { cookie: adminSession.signedCookie },
      })).status, 400);
    }
    const pageResponse = await fetch(`${baseUrl}/api/sales-evidence?page=2&pageSize=1`, {
      headers: { cookie: adminSession.signedCookie },
    });
    const pageJson = await pageResponse.json();
    assert.equal(pageResponse.status, 200);
    assert.equal(pageJson.documents.length, 1);
    assert.equal(pageJson.page, 2);
    assert.equal(pageJson.total, adminListJson.total);
    const filteredResponse = await fetch(`${baseUrl}/api/sales-evidence?saleRecoveryStatus=UNRESOLVED&q=Sale`, {
      headers: { cookie: adminSession.signedCookie },
    });
    const filteredJson = await filteredResponse.json();
    assert.equal(filteredResponse.status, 200);
    assert.ok(filteredJson.documents.length > 0);
    assert.ok(filteredJson.documents.every((d: any) => d.saleRecoveryStatus === "UNRESOLVED" && d.title.includes("Sale")));

    // 5. Authorized Detail (GET /api/sales-evidence/:id)
    const adminDetailRes = await fetch(`${baseUrl}/api/sales-evidence/sale-1`, {
      headers: { cookie: adminSession.signedCookie },
    });
    assert.equal(adminDetailRes.status, 200);
    const adminDetailJson = await adminDetailRes.json();
    assert.equal(adminDetailJson.id, "sale-1");
    assert.equal("recoveryCheckoutOperationKey" in adminDetailJson, false);

    // ADMIN sees ADMIN_ONLY detail
    const adminOnlyRes = await fetch(`${baseUrl}/api/sales-evidence/sale-admin-only`, {
      headers: { cookie: adminSession.signedCookie },
    });
    assert.equal(adminOnlyRes.status, 200);

    // MANAGER receives 404 for ADMIN_ONLY detail, file, and thumbnail
    const mgrAdminOnlyDetailRes = await fetch(`${baseUrl}/api/sales-evidence/sale-admin-only`, {
      headers: { cookie: managerSession.signedCookie },
    });
    assert.equal(mgrAdminOnlyDetailRes.status, 404);

    const mgrAdminOnlyFileRes = await fetch(`${baseUrl}/api/sales-evidence/sale-admin-only/file`, {
      headers: { cookie: managerSession.signedCookie },
    });
    assert.equal(mgrAdminOnlyFileRes.status, 404);

    const mgrAdminOnlyThumbRes = await fetch(`${baseUrl}/api/sales-evidence/sale-admin-only/thumbnail`, {
      headers: { cookie: managerSession.signedCookie },
    });
    assert.equal(mgrAdminOnlyThumbRes.status, 404);

    // Deleted ID, non-existent ID, wrong-type ID -> 404 on dedicated routes
    for (const badId of ["sale-deleted", "non-existent", "stock-1"]) {
      const detailBad = await fetch(`${baseUrl}/api/sales-evidence/${badId}`, {
        headers: { cookie: adminSession.signedCookie },
      });
      assert.equal(detailBad.status, 404, `Detail for ${badId} must return 404`);

      const fileBad = await fetch(`${baseUrl}/api/sales-evidence/${badId}/file`, {
        headers: { cookie: adminSession.signedCookie },
      });
      assert.equal(fileBad.status, 404, `File for ${badId} must return 404`);

      const thumbBad = await fetch(`${baseUrl}/api/sales-evidence/${badId}/thumbnail`, {
        headers: { cookie: adminSession.signedCookie },
      });
      assert.equal(thumbBad.status, 404, `Thumbnail for ${badId} must return 404`);
    }

    // 6. Authorized File and Thumbnail (GET /api/sales-evidence/:id/file, /thumbnail)
    const adminFileRes = await fetch(`${baseUrl}/api/sales-evidence/sale-1/file`, {
      headers: { cookie: adminSession.signedCookie },
    });
    assert.equal(adminFileRes.status, 200);
    assert.equal(adminFileRes.headers.get("content-type"), "image/jpeg");
    assert.ok(adminFileRes.headers.get("content-disposition")?.includes("inline"));

    const mgrFileRes = await fetch(`${baseUrl}/api/sales-evidence/sale-1/file`, {
      headers: { cookie: managerSession.signedCookie },
    });
    assert.equal(mgrFileRes.status, 200);

    const adminThumbRes = await fetch(`${baseUrl}/api/sales-evidence/sale-1/thumbnail`, {
      headers: { cookie: adminSession.signedCookie },
    });
    assert.equal(adminThumbRes.status, 200);
    assert.equal(adminThumbRes.headers.get("content-type"), "image/webp");
    assert.equal(adminThumbRes.headers.get("cache-control"), "private, max-age=300, must-revalidate");

    const mgrThumbRes = await fetch(`${baseUrl}/api/sales-evidence/sale-1/thumbnail`, {
      headers: { cookie: managerSession.signedCookie },
    });
    assert.equal(mgrThumbRes.status, 200);

    // 7. Legacy SALE_BILL with broad ALL_AUTHENTICATED visibility and null status
    // Accessible through dedicated endpoints
    const legacyDedicatedRes = await fetch(`${baseUrl}/api/sales-evidence/sale-legacy-broad`, {
      headers: { cookie: adminSession.signedCookie },
    });
    assert.equal(legacyDedicatedRes.status, 200);
    const legacyDedicatedJson = await legacyDedicatedRes.json();
    assert.equal(legacyDedicatedJson.saleRecoveryStatus, null);

    // 8. Generic /api/documents fallback: SALE_BILL is never returned in list or served by detail/file/thumb
    for (const session of [adminSession, managerSession, cashierSession]) {
      // Generic list excludes SALE_BILL and returns ordinary documents
      const genericListRes = await fetch(`${baseUrl}/api/documents`, {
        headers: { cookie: session.signedCookie },
      });
      assert.equal(genericListRes.status, 200);
      const genericListJson = await genericListRes.json();
      assert.ok(genericListJson.documents.length > 0, "Generic list should contain standard documents");
      assert.equal(
        genericListJson.documents.some((d: any) => d.documentType === "SALE_BILL"),
        false,
        "Generic list must never contain SALE_BILL documents",
      );

      // Attempting to filter generic HTTP list by documentType=SALE_BILL is rejected as invalid document type (400)
      const forcedFilterRes = await fetch(`${baseUrl}/api/documents?documentType=SALE_BILL`, {
        headers: { cookie: session.signedCookie },
      });
      assert.equal(forcedFilterRes.status, 400);

      // Generic detail for SALE_BILL -> 404
      const genericDetailRes = await fetch(`${baseUrl}/api/documents/sale-1`, {
        headers: { cookie: session.signedCookie },
      });
      assert.equal(genericDetailRes.status, 404);

      // Generic detail for legacy broad SALE_BILL -> 404
      const genericLegacyDetailRes = await fetch(`${baseUrl}/api/documents/sale-legacy-broad`, {
        headers: { cookie: session.signedCookie },
      });
      assert.equal(genericLegacyDetailRes.status, 404);

      // Generic file for SALE_BILL -> 404
      const genericFileRes = await fetch(`${baseUrl}/api/documents/sale-1/file`, {
        headers: { cookie: session.signedCookie },
      });
      assert.equal(genericFileRes.status, 404);

      // Generic thumbnail for SALE_BILL -> 404
      const genericThumbRes = await fetch(`${baseUrl}/api/documents/sale-1/thumbnail`, {
        headers: { cookie: session.signedCookie },
      });
      assert.equal(genericThumbRes.status, 404);
    }

    // STAFF is denied from generic /api/documents (denyStaff -> 403)
    const staffGenericRes = await fetch(`${baseUrl}/api/documents`, {
      headers: { cookie: staffSession.signedCookie },
    });
    assert.equal(staffGenericRes.status, 403);

    // Generic detail, file, thumbnail for ordinary document (STOCK_BILL) work for ADMIN
    const genericStockDetailRes = await fetch(`${baseUrl}/api/documents/stock-1`, {
      headers: { cookie: adminSession.signedCookie },
    });
    assert.equal(genericStockDetailRes.status, 200);

    const genericStockFileRes = await fetch(`${baseUrl}/api/documents/stock-1/file`, {
      headers: { cookie: adminSession.signedCookie },
    });
    assert.equal(genericStockFileRes.status, 200);
    for (const [id, suffix] of [["missing-original", "/file"], ["missing-thumbnail", "/thumbnail"], ["null-thumbnail", "/thumbnail"]]) {
      const response = await fetch(`${baseUrl}/api/sales-evidence/${id}${suffix}`, { headers: { cookie: adminSession.signedCookie } });
      assert.equal(response.status, 404);
    }
    for (const session of [adminSession, managerSession]) {
      for (const suffix of ["", "/file", "/thumbnail"]) {
        const response = await fetch(`${baseUrl}/api/sales-evidence/sale-legacy-broad${suffix}`, { headers: { cookie: session.signedCookie } });
        assert.equal(response.status, 200);
        if (!suffix) {
          const body = await response.json();
          assert.equal(body.saleRecoveryStatus, null);
          assert.equal("recoveryCheckoutPayloadHash" in body, false);
        }
      }
      assert.equal((await fetch(`${baseUrl}/api/sales-evidence/sale-1`, { headers: { cookie: session.signedCookie } })).status, 200);
    }
    for (const mode of ["FULL_POS", "CATALOG_ONLY"]) {
      currentBusinessSettings = { ...currentBusinessSettings, businessMode: mode };
      invalidateBusinessSettingsCache();
      for (const session of [adminSession, managerSession, cashierSession, staffSession, unknownSession]) {
        const denied = session === staffSession;
        const listResponse = await fetch(`${baseUrl}/api/documents`, { headers: { cookie: session.signedCookie } });
        assert.equal(listResponse.status, denied ? 403 : 200);
        if (!denied) {
          const body = await listResponse.json();
          assert.equal(body.documents.length, 6);
          assert.equal(body.total, 6);
          assert.ok(body.documents.every((d: any) => d.documentType !== "SALE_BILL"));
        }
        for (const suffix of ["", "/file", "/thumbnail"]) {
          const response = await fetch(`${baseUrl}/api/documents/sale-legacy-broad${suffix}`, { headers: { cookie: session.signedCookie } });
          assert.equal(response.status, denied ? 403 : 404);
        }
      }
    }
    // All six ordinary types retain metadata and private media reads.
    for (const row of allDocuments.filter((d) => d.documentType !== "SALE_BILL")) {
      for (const suffix of ["", "/file", "/thumbnail"]) {
        assert.equal((await fetch(`${baseUrl}/api/documents/${row.id}${suffix}`, { headers: { cookie: adminSession.signedCookie } })).status, 200);
      }
    }
  } finally {
    prisma.authSession.findUnique = originalAuthFindUnique;
    if ((prisma as any).businessSettings) {
      (prisma as any).businessSettings.upsert = originalBusinessSettingsUpsert;
      (prisma as any).businessSettings.findUnique = originalBusinessSettingsFindUnique;
    }
    documentDelegate.findMany = originalFindMany;
    documentDelegate.findFirst = originalFindFirst;
    documentDelegate.count = originalCount;
    invalidateBusinessSettingsCache();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
