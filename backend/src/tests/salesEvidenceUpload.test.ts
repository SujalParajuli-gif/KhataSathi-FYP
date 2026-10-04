import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import express from "express";
import { PassThrough } from "node:stream";
import prisma from "../db/prisma";

// Set a temporary isolated storage root before importing storage/services
const isolatedStorageRoot = fsSync.mkdtempSync(
  path.join(os.tmpdir(), "ks-sales-upload-storage-"),
);
process.env.DOCUMENT_STORAGE_ROOT = isolatedStorageRoot;

const { documentStorageRoot } = require("../lib/storageReadiness") as typeof import("../lib/storageReadiness");
assert.equal(documentStorageRoot, isolatedStorageRoot, "Upload tests must use isolated storage");

const {
  createSaleEvidence,
  assertSalesEvidenceReviewer,
} = require("../modules/salesEvidence/service") as typeof import("../modules/salesEvidence/service");
const {
  uploadSaleEvidence,
} = require("../modules/salesEvidence/controller") as typeof import("../modules/salesEvidence/controller");
const {
  getDocumentFilePath,
  getDocumentThumbnailFilePath,
} = require("../modules/documents/service") as typeof import("../modules/documents/service");
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

after(() => fs.rm(isolatedStorageRoot, { recursive: true, force: true }));

const VALID_PDF = Buffer.from(
  "%PDF-1.4\n%äüöß\n1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n",
  "utf8",
);
const VALID_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001010300000025db56ca00000003504c5445000000a77a3dda0000000174524e530040e6d8660000000a4944415408d76360000000020001e221bc330000000049454e44ae426082",
  "hex",
);
const VALID_JPG = Buffer.from(
  "ffd8ffe000104a46494600010101004800480000ffdb004300ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc0000b080001000101011100ffc40014000100000000000000000000000000000000ffda0008010100003f0037ffd9",
  "hex",
);
// Decodable 4x4 WebP fixture for successful thumbnail derivative generation
const VALID_WEBP = Buffer.from(
  "524946463800000057454250565038202c0000009001009d012a0400040001402625a00274ba00039800fee9691f8dd9670e0f7ff6337ff3d1ffe7a3fd430000",
  "hex",
);
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

async function createTempFile(content: Buffer, name = "test-evidence.jpg") {
  const tempDir = path.join(isolatedStorageRoot, ".temp");
  await fs.mkdir(tempDir, { recursive: true });
  const tempPath = path.join(
    tempDir,
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`,
  );
  await fs.writeFile(tempPath, content);
  return tempPath;
}

function mockResponse(capabilities = fullPosCapabilities) {
  const res: any = {
    statusCode: 200,
    jsonData: null,
    headers: {},
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
  const rawCsrf = "test-csrf-" + Math.random().toString(36).slice(2);
  const tokenHash = hashSessionSecret(rawToken);
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

/**
 * Creates a bounded transactional database fake that stages writes during $transaction,
 * commits them only when the transaction callback succeeds, and discards them on failure.
 */
function createTransactionalFake(failure?: "create" | "audit") {
  const committedDocuments: any[] = [];
  const committedAudits: any[] = [];

  let stagedDocuments: any[] = [];
  let stagedAudits: any[] = [];

  const transactionImpl = async (callback: any) => {
    stagedDocuments = [];
    stagedAudits = [];

    const tx = {
      document: {
        create: async ({ data }: any) => {
          if (failure === "create") throw new Error("DB insert deadlock");
          const record = {
            id: data.id,
            ...data,
            createdAt: new Date(),
            uploadedBy: { id: data.uploadedById, name: "Test Reviewer" },
          };
          stagedDocuments.push(record);
          return record;
        },
      },
      auditLog: {
        create: async ({ data }: any) => {
          if (failure === "audit") throw new Error("Audit log insert failed");
          const record = { id: `audit-${stagedAudits.length + 1}`, ...data };
          stagedAudits.push(record);
          return record;
        },
      },
    };

    try {
      const result = await callback(tx);
      committedDocuments.push(...stagedDocuments);
      committedAudits.push(...stagedAudits);
      stagedDocuments = [];
      stagedAudits = [];
      return result;
    } catch (err) {
      stagedDocuments = [];
      stagedAudits = [];
      throw err;
    }
  };

  const findUniqueImpl = async ({ where }: any) => {
    return committedDocuments.find((d) => d.id === where.id) || null;
  };

  return {
    committedDocuments,
    committedAudits,
    transactionImpl,
    findUniqueImpl,
  };
}

test("uploadSaleEvidence accepts supported formats (PDF, JPG, PNG, WEBP), creates exactly 1 UNRESOLVED Document and 1 AuditLog", async () => {
  const formats = [
    { name: "bill.pdf", buffer: VALID_PDF, mime: "application/pdf", hasThumb: false },
    { name: "bill.jpg", buffer: VALID_JPG, mime: "image/jpeg", hasThumb: true },
    { name: "bill.png", buffer: VALID_PNG, mime: "image/png", hasThumb: true },
    { name: "bill.webp", buffer: VALID_WEBP, mime: "image/webp", hasThumb: true },
  ];

  for (const fmt of formats) {
    const tempPath = await createTempFile(fmt.buffer, fmt.name);
    const expectedChecksum = crypto.createHash("sha256").update(fmt.buffer).digest("hex");
    let createdDocData: any = null;
    let createdAuditData: any = null;

    const originalTransaction = prisma.$transaction;
    try {
      prisma.$transaction = (async (callback: any) => {
        const tx = {
          document: {
            create: async ({ data }: any) => {
              createdDocData = data;
              // Verify that stored file exists on disk with exact bytes and checksum before transaction completes
              const finalPath = getDocumentFilePath(data);
              assert.ok(finalPath && fsSync.existsSync(finalPath), "Final file must exist before DB commit");
              const onDiskBytes = await fs.readFile(finalPath);
              assert.ok(onDiskBytes.equals(fmt.buffer), "On-disk bytes must equal original buffer exactly");
              assert.equal(data.checksum, expectedChecksum, "Checksum must match sha256 hash exactly");

              if (fmt.hasThumb) {
                assert.ok(data.thumbnailFileName, "Thumbnail filename must be present for decodable image");
                assert.ok(data.thumbnailSize && data.thumbnailSize > 0, "Thumbnail size must be positive");
                const finalThumbPath = getDocumentThumbnailFilePath(data);
                assert.ok(finalThumbPath && fsSync.existsSync(finalThumbPath), "Thumbnail file must exist on disk");
                const onDiskThumbBytes = await fs.readFile(finalThumbPath);
                assert.equal(onDiskThumbBytes.length, data.thumbnailSize);
              } else {
                assert.equal(data.thumbnailFileName, null);
                assert.equal(data.thumbnailSize, null);
              }

              return {
                id: data.id,
                ...data,
                createdAt: new Date(),
                uploadedBy: { id: "admin-1", name: "Admin Ram" },
              };
            },
          },
          auditLog: {
            create: async ({ data }: any) => {
              createdAuditData = data;
              return { id: "audit-1", ...data };
            },
          },
        };
        return callback(tx);
      }) as any;

      const req: any = {
        user: { id: "admin-1", role: "ADMIN", name: "Admin Ram" },
        file: {
          originalname: fmt.name,
          mimetype: fmt.mime,
          size: fmt.buffer.length,
          path: tempPath,
        },
        body: {
          title: `Sales receipt for ${fmt.name}`,
          remarks: "Physical register backup",
        },
      };
      const res = mockResponse();

      await uploadSaleEvidence(req, res);

      assert.equal(res.statusCode, 201);
      assert.ok(res.jsonData.document);
      const doc = res.jsonData.document;

      // Invariants on DB Document creation
      assert.equal(createdDocData.documentType, "SALE_BILL");
      assert.equal(createdDocData.visibility, "ADMIN_MANAGER");
      assert.equal(createdDocData.saleRecoveryStatus, "UNRESOLVED");
      assert.equal(createdDocData.linkedEntityType, null);
      assert.equal(createdDocData.linkedEntityId, null);
      assert.equal(createdDocData.recoveryCheckoutOperationKey, null);
      assert.equal(createdDocData.recoveryCheckoutPayloadHash, null);
      assert.equal(createdDocData.uploadedById, "admin-1");
      assert.equal(createdDocData.title, `Sales receipt for ${fmt.name}`);
      assert.equal(createdDocData.remarks, "Physical register backup");
      assert.equal(createdDocData.checksum, expectedChecksum);

      // Invariants on Audit Log creation
      assert.equal(createdAuditData.action, "SALE_EVIDENCE_UPLOADED");
      assert.equal(createdAuditData.entityType, "Document");
      assert.equal(createdAuditData.actorId, "admin-1");
      assert.equal(createdAuditData.meta.documentType, "SALE_BILL");
      assert.equal(createdAuditData.meta.saleRecoveryStatus, "UNRESOLVED");
      assert.equal(createdAuditData.meta.checksum, expectedChecksum);

      // Public projection invariants
      assert.equal(doc.documentType, "SALE_BILL");
      assert.equal(doc.saleRecoveryStatus, "UNRESOLVED");
      assert.equal("recoveryCheckoutOperationKey" in doc, false);
      assert.equal("recoveryCheckoutPayloadHash" in doc, false);
      assert.equal("processingStatus" in doc, false);
      assert.equal("processingLabel" in doc, false);

      // File was moved into storage root and exists
      const storedFilePath = getDocumentFilePath(createdDocData);
      assert.ok(storedFilePath && fsSync.existsSync(storedFilePath));
      if (fmt.hasThumb) {
        const thumbPath = getDocumentThumbnailFilePath(createdDocData);
        assert.ok(thumbPath && fsSync.existsSync(thumbPath));
      }
    } finally {
      prisma.$transaction = originalTransaction;
    }
  }
});

test("best-effort thumbnail generation fallback unlinks partial derivative and succeeds with null thumbnail", async (t) => {
  const media = require("../modules/documents/documentMedia") as typeof import("../modules/documents/documentMedia");
  let candidatePath = "";
  t.mock.method(media, "writeDocumentImageThumbnail", async (_original: string, candidate: string) => {
    candidatePath = candidate;
    await fs.writeFile(candidate, "test-partial-derivative");
    throw new Error("test-thumbnail-write-failure");
  });
  const tempPath = await createTempFile(VALID_WEBP, "partial.webp");
  let createdDocData: any = null;

  const originalTransaction = prisma.$transaction;
  try {
    prisma.$transaction = (async (callback: any) => {
      const tx = {
        document: {
          create: async ({ data }: any) => {
            createdDocData = data;
            return {
              id: data.id,
              ...data,
              createdAt: new Date(),
              uploadedBy: { id: "admin-1", name: "Admin Ram" },
            };
          },
        },
        auditLog: {
          create: async () => ({ id: "audit-1" }),
        },
      };
      return callback(tx);
    }) as any;

    const result = await createSaleEvidence(
      {
        originalname: "partial.webp",
        mimetype: "image/webp",
        size: VALID_WEBP.length,
        path: tempPath,
      },
      { title: "Corrupted WebP Test" },
      { id: "admin-1", role: "ADMIN" },
      async () => fullPosCapabilities,
    );

    assert.equal(result.thumbnailFileName, null);
    assert.equal(createdDocData.thumbnailFileName, null);
    assert.equal(createdDocData.thumbnailSize, null);
    assert.equal(result.saleRecoveryStatus, "UNRESOLVED");

    assert.ok(candidatePath, "Fault must create an actual partial derivative");
    assert.equal(fsSync.existsSync(candidatePath), false);
    // Assert that no partial/candidate thumbnail file remains on disk
    if (createdDocData.storedPath) {
      const candidateThumbPath = path.join(
        isolatedStorageRoot,
        createdDocData.storedPath,
        `${createdDocData.id}.webp`,
      );
      assert.equal(fsSync.existsSync(candidateThumbPath), false, "Candidate thumbnail partial must not exist on disk");
    }
  } finally {
    prisma.$transaction = originalTransaction;
  }
});

test("createSaleEvidence derives default document title from fileName when title is omitted", async () => {
  const tempPath = await createTempFile(VALID_JPG, "counter_pos_receipt_101.jpg");
  let createdDocData: any = null;

  const originalTransaction = prisma.$transaction;
  try {
    prisma.$transaction = (async (callback: any) => {
      const tx = {
        document: {
          create: async ({ data }: any) => {
            createdDocData = data;
            return {
              id: data.id,
              ...data,
              createdAt: new Date(),
              uploadedBy: { id: "mgr-1", name: "Manager Sita" },
            };
          },
        },
        auditLog: {
          create: async () => ({ id: "audit-1" }),
        },
      };
      return callback(tx);
    }) as any;

    const result = await createSaleEvidence(
      {
        originalname: "counter_pos_receipt_101.jpg",
        mimetype: "image/jpeg",
        size: VALID_JPG.length,
        path: tempPath,
      },
      {},
      { id: "mgr-1", role: "MANAGER" },
      async () => fullPosCapabilities,
    );

    assert.equal(result.title, "counter pos receipt 101");
    assert.equal(createdDocData.title, "counter pos receipt 101");
    assert.equal(createdDocData.remarks, null);
  } finally {
    prisma.$transaction = originalTransaction;
  }
});

test("strict metadata validation rejects caller attempts to inject prohibited fields at controller and direct service levels", async () => {
  const prohibitedPayloads = [
    { documentType: "SALE_BILL" },
    { documentType: "STOCK_BILL" },
    { visibility: "ALL_AUTHENTICATED" },
    { visibility: "ADMIN_ONLY" },
    { saleRecoveryStatus: "ATTACHED" },
    { linkedEntityType: "Invoice" },
    { linkedEntityId: "inv-123" },
    { recoveryCheckoutOperationKey: "opkey-123" },
    { recoveryCheckoutPayloadHash: "hash-123" },
    { supplierName: "Supplier ABC" },
    { billNumber: "BILL-100" },
    { billAmount: 5000 },
    { unknownField: "bad" },
    { title: "x" }, // title too short (<2 chars)
    { remarks: "r".repeat(2001) }, // remarks too long (>2000 chars)
  ];

  for (const body of prohibitedPayloads) {
    // 1. Controller test
    const tempPathCtrl = await createTempFile(VALID_JPG, "test-ctrl.jpg");
    const req: any = {
      user: { id: "admin-1", role: "ADMIN" },
      file: {
        originalname: "test-ctrl.jpg",
        mimetype: "image/jpeg",
        size: VALID_JPG.length,
        path: tempPathCtrl,
      },
      body,
    };
    const res = mockResponse();
    await uploadSaleEvidence(req, res);
    assert.equal(
      res.statusCode,
      400,
      `Expected 400 for controller payload: ${JSON.stringify(body)}`,
    );
    assert.equal(fsSync.existsSync(tempPathCtrl), false, "Temp file must be unlinked on controller validation error");

    // 2. Direct service test (createSaleEvidence directly)
    const tempPathSvc = await createTempFile(VALID_JPG, "test-svc.jpg");
    await assert.rejects(
      async () => {
        try {
          await createSaleEvidence(
            {
              originalname: "test-svc.jpg",
              mimetype: "image/jpeg",
              size: VALID_JPG.length,
              path: tempPathSvc,
            },
            body as any,
            { id: "admin-1", role: "ADMIN" },
            async () => fullPosCapabilities,
          );
        } finally {
          // Clean up temp file if not cleaned by service
          await fs.unlink(tempPathSvc).catch(() => {});
        }
      },
      (err: any) => {
        assert.ok(err, "Direct service call must throw validation error for prohibited body");
        return true;
      },
    );
  }
});

test("prepareDocumentFile measures actual file size with filesystem metadata and rejects mismatches/empty/oversized", async () => {
  // 1. Mismatched caller-supplied file.size (caller claims size=1 for 42-byte PDF)
  const mismatchPath = await createTempFile(VALID_PDF, "mismatched-size.pdf");
  const originalTransaction = prisma.$transaction;
  let persistedDocData: any = null;
  try {
    prisma.$transaction = (async (callback: any) => {
      const tx = {
        document: {
          create: async ({ data }: any) => {
            persistedDocData = data;
            return {
              id: data.id,
              ...data,
              createdAt: new Date(),
              uploadedBy: { id: "admin-1", name: "Admin Ram" },
            };
          },
        },
        auditLog: { create: async () => ({ id: "audit-1" }) },
      };
      return callback(tx);
    }) as any;

    const result = await createSaleEvidence(
      {
        originalname: "mismatched-size.pdf",
        mimetype: "application/pdf",
        size: 1, // Deliberately misleading caller size
        path: mismatchPath,
      },
      { title: "Mismatched Size Test" },
      { id: "admin-1", role: "ADMIN" },
      async () => fullPosCapabilities,
    );

    // Actual filesystem size (VALID_PDF.length) must be stored and returned
    assert.equal(result.fileSize, VALID_PDF.length);
    assert.equal(persistedDocData.fileSize, VALID_PDF.length);
  } finally {
    prisma.$transaction = originalTransaction;
  }

  // 2. Empty file (0 bytes on disk)
  const emptyPath = await createTempFile(Buffer.alloc(0), "empty.jpg");
  const reqEmpty: any = {
    user: { id: "admin-1", role: "ADMIN" },
    file: { originalname: "empty.jpg", mimetype: "image/jpeg", size: 0, path: emptyPath },
    body: {},
  };
  const resEmpty = mockResponse();
  await uploadSaleEvidence(reqEmpty, resEmpty);
  assert.equal(resEmpty.statusCode, 400);
  assert.equal(fsSync.existsSync(emptyPath), false);

  // 3. Oversized file (>10MB on disk)
  const hugeBuffer = Buffer.alloc(10 * 1024 * 1024 + 1024);
  const hugePath = await createTempFile(hugeBuffer, "huge.jpg");
  const reqHuge: any = {
    user: { id: "admin-1", role: "ADMIN" },
    file: {
      originalname: "huge.jpg",
      mimetype: "image/jpeg",
      size: hugeBuffer.length,
      path: hugePath,
    },
    body: {},
  };
  const resHuge = mockResponse();
  await uploadSaleEvidence(reqHuge, resHuge);
  assert.equal(resHuge.statusCode, 400);
  assert.equal(fsSync.existsSync(hugePath), false);

  // 4. Invalid binary content (random text claimed as jpg)
  const invalidPath = await createTempFile(Buffer.from("not a real image"), "corrupt.jpg");
  const reqInvalid: any = {
    user: { id: "admin-1", role: "ADMIN" },
    file: {
      originalname: "corrupt.jpg",
      mimetype: "image/jpeg",
      size: 16,
      path: invalidPath,
    },
    body: {},
  };
  const resInvalid = mockResponse();
  await uploadSaleEvidence(reqInvalid, resInvalid);
  assert.equal(resInvalid.statusCode, 400);
  assert.equal(fsSync.existsSync(invalidPath), false);

  // 5. MIME mismatch (PDF content claimed as image/png)
  const mimeMismatchPath = await createTempFile(VALID_PDF, "mismatch.png");
  const reqMismatch: any = {
    user: { id: "admin-1", role: "ADMIN" },
    file: {
      originalname: "mismatch.png",
      mimetype: "image/png",
      size: VALID_PDF.length,
      path: mimeMismatchPath,
    },
    body: {},
  };
  const resMismatch = mockResponse();
  await uploadSaleEvidence(reqMismatch, resMismatch);
  assert.equal(resMismatch.statusCode, 400);
  assert.equal(fsSync.existsSync(mimeMismatchPath), false);
});

test("storage, move and checksum failures create no records and clean temporary/final files", async (t) => {
  const storage = require("../lib/storageReadiness") as typeof import("../lib/storageReadiness");
  for (const failure of ["storage", "move", "checksum"] as const) {
    const tempPath = await createTempFile(VALID_PNG);
    const fake = createTransactionalFake();
    const before = await fs.readdir(path.join(isolatedStorageRoot, "documents"), { recursive: true });
    const txMock = t.mock.method(prisma, "$transaction", fake.transactionImpl);
    let fault;
    if (failure === "storage") {
      fault = t.mock.method(storage, "assertDocumentStorageAccessible", () => { throw new storage.StorageUnavailableError(); });
    } else if (failure === "move") {
      fault = t.mock.method(fs, "rename", async () => {
        throw Object.assign(new Error("test-move-failure"), { code: "EACCES" });
      });
    } else {
      fault = t.mock.method(fsSync, "createReadStream", () => {
        const stream = new PassThrough();
        queueMicrotask(() => stream.destroy(Object.assign(new Error("test-checksum-failure"), { code: "EACCES" })));
        return stream;
      });
    }
    try {
      const res = mockResponse();
      await uploadSaleEvidence({ body: {}, user: { id: "admin-1", role: "ADMIN" }, file: {
        originalname: "fault.png", mimetype: "image/png", size: VALID_PNG.length, path: tempPath,
      } } as any, res);
      assert.equal(res.statusCode, 503);
      assert.equal(res.jsonData.code, "STORAGE_UNAVAILABLE");
      assert.equal(JSON.stringify(res.jsonData).includes(isolatedStorageRoot), false);
      assert.equal(txMock.mock.callCount(), 0);
      assert.equal(fake.committedDocuments.length, 0);
      assert.equal(fake.committedAudits.length, 0);
      assert.equal(fsSync.existsSync(tempPath), false);
      const after = await fs.readdir(path.join(isolatedStorageRoot, "documents"), { recursive: true });
      for (const entry of after) {
        if ((await fs.stat(path.join(isolatedStorageRoot, "documents", entry))).isFile()) {
          assert.ok(before.includes(entry), `Unexpected remaining file ${entry}`);
        }
      }
    } finally {
      fault.mock.restore();
      txMock.mock.restore();
    }
  }
});

for (const failure of ["create", "audit"] as const) {
  test(`transaction ${failure} failure rolls back both stores and unlinks original/thumbnail`, async (t) => {
    const tempPath = await createTempFile(VALID_PNG);
    const fake = createTransactionalFake(failure);
    let finalData: any;
    t.mock.method(prisma, "$transaction", async (callback: any) => fake.transactionImpl(async (tx: any) => {
      const originalCreate = tx.document.create;
      tx.document.create = async (args: any) => {
        finalData = args.data;
        assert.deepEqual(await fs.readFile(getDocumentFilePath(finalData)!), VALID_PNG);
        assert.ok(getDocumentThumbnailFilePath(finalData));
        return originalCreate(args);
      };
      return callback(tx);
    }));
    const originalFindUnique = prisma.document.findUnique;
    prisma.document.findUnique = fake.findUniqueImpl as any;
    t.after(() => { prisma.document.findUnique = originalFindUnique; });
    await assert.rejects(() => createSaleEvidence({
      originalname: "rollback.png", mimetype: "image/png", size: VALID_PNG.length, path: tempPath,
    }, {}, { id: "admin-1", role: "ADMIN" }, async () => fullPosCapabilities),
    failure === "create" ? /DB insert deadlock/ : /Audit log insert failed/);
    assert.equal(fake.committedDocuments.length, 0);
    assert.equal(fake.committedAudits.length, 0);
    assert.equal(fsSync.existsSync(tempPath), false);
    assert.ok(finalData.thumbnailFileName);
    assert.equal(fsSync.existsSync(path.join(isolatedStorageRoot, finalData.storedPath, finalData.storedFileName)), false);
    assert.equal(fsSync.existsSync(path.join(isolatedStorageRoot, finalData.storedPath, finalData.thumbnailFileName)), false);
  });
}

test("found committed row after transaction connection drop preserves prepared files, thumbnails, and returns public evidence", async () => {
  const tempPath = await createTempFile(VALID_JPG, "tx-committed.jpg");
  const originalTransaction = prisma.$transaction;
  const originalFindUnique = prisma.document.findUnique;

  const fake = createTransactionalFake();
  let createdDocData: any = null;

  try {
    prisma.$transaction = (async (callback: any) => {
      await fake.transactionImpl(callback);
      createdDocData = fake.committedDocuments[0];
      throw new Error("Connection drop after commit");
    }) as any;

    prisma.document.findUnique = fake.findUniqueImpl as any;

    const result = await createSaleEvidence(
      {
        originalname: "tx-committed.jpg",
        mimetype: "image/jpeg",
        size: VALID_JPG.length,
        path: tempPath,
      },
      { title: "Committed Row Retention Test" },
      { id: "admin-1", role: "ADMIN" },
      async () => fullPosCapabilities,
    );

    assert.equal(result.saleRecoveryStatus, "UNRESOLVED");
    assert.equal(fake.committedDocuments.length, 1);
    assert.equal(fake.committedAudits.length, 1);

    const storedPath = getDocumentFilePath(createdDocData);
    assert.ok(storedPath && fsSync.existsSync(storedPath), "Committed file must be retained on disk");
    const thumbPath = getDocumentThumbnailFilePath(createdDocData);
    assert.ok(thumbPath && fsSync.existsSync(thumbPath), "Committed thumbnail must be retained on disk");
  } finally {
    prisma.$transaction = originalTransaction;
    prisma.document.findUnique = originalFindUnique;
  }
});

test("ambiguous transaction outcome preserves prepared files and thumbnails when row existence cannot be ruled out", async () => {
  const tempPath = await createTempFile(VALID_JPG, "reconcile-ambiguous.jpg");
  const originalTransaction = prisma.$transaction;
  const originalFindUnique = prisma.document.findUnique;

  let stagedDocData: any = null;

  try {
    prisma.$transaction = (async (callback: any) => {
      const tx = {
        document: {
          create: async ({ data }: any) => {
            stagedDocData = data;
            return { id: data.id, ...data };
          },
        },
        auditLog: {
          create: async () => {
            throw new Error("Connection reset by peer");
          },
        },
      };
      return callback(tx);
    }) as any;

    // Database lookup fails (e.g. database unreachable)
    prisma.document.findUnique = (async () => {
      throw new Error("DB still unreachable");
    }) as any;

    await assert.rejects(
      () =>
        createSaleEvidence(
          {
            originalname: "reconcile-ambiguous.jpg",
            mimetype: "image/jpeg",
            size: VALID_JPG.length,
            path: tempPath,
          },
          { title: "Ambiguous test" },
          { id: "admin-1", role: "ADMIN" },
          async () => fullPosCapabilities,
        ),
      /Connection reset by peer/,
    );

    // Both original file and thumbnail must be retained on disk because row existence is uncertain
    assert.ok(stagedDocData);
    const storedPath = getDocumentFilePath(stagedDocData);
    assert.ok(storedPath && fsSync.existsSync(storedPath), "File must be retained when DB status is ambiguous");
    const thumbPath = getDocumentThumbnailFilePath(stagedDocData);
    assert.ok(thumbPath && fsSync.existsSync(thumbPath), "Thumbnail must be retained when DB status is ambiguous");
  } finally {
    prisma.$transaction = originalTransaction;
    prisma.document.findUnique = originalFindUnique;
  }
});

test("role and POS capability gates deny non-reviewer roles and POS-disabled mode", async () => {
  // CASHIER role denial
  await assert.rejects(
    () =>
      assertSalesEvidenceReviewer(
        { id: "c-1", role: "CASHIER" },
        async () => fullPosCapabilities,
      ),
    /Access denied — insufficient role/,
  );

  // STAFF role denial
  await assert.rejects(
    () =>
      assertSalesEvidenceReviewer(
        { id: "s-1", role: "STAFF" },
        async () => fullPosCapabilities,
      ),
    /Access denied — insufficient role/,
  );

  // Unknown role denial
  await assert.rejects(
    () =>
      assertSalesEvidenceReviewer(
        { id: "u-1", role: "UNKNOWN" },
        async () => fullPosCapabilities,
      ),
    /Access denied — insufficient role/,
  );

  // ADMIN/MANAGER accepted when POS enabled
  await assert.doesNotReject(() =>
    assertSalesEvidenceReviewer(
      { id: "a-1", role: "ADMIN" },
      async () => fullPosCapabilities,
    ),
  );
  await assert.doesNotReject(() =>
    assertSalesEvidenceReviewer(
      { id: "m-1", role: "MANAGER" },
      async () => fullPosCapabilities,
    ),
  );

  // POS disabled denial
  await assert.rejects(
    () =>
      assertSalesEvidenceReviewer(
        { id: "a-1", role: "ADMIN" },
        async () => posDisabledCapabilities,
      ),
    (err: any) => {
      assert.equal(err.code, "FEATURE_DISABLED");
      assert.match(err.message, /POS is disabled in CATALOG_ONLY mode/);
      return true;
    },
  );
});

test("HTTP router upload matrix: authSession, CSRF, roles, POS capability, and Multer bounds", async () => {
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

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}/api/sales-evidence`;

    const adminSession = createTestSession({ id: "admin-1", role: "ADMIN" });
    const managerSession = createTestSession({ id: "mgr-1", role: "MANAGER" });
    const cashierSession = createTestSession({ id: "cashier-1", role: "CASHIER" });
    const staffSession = createTestSession({ id: "staff-1", role: "STAFF" });
    const unknownSession = createTestSession({ id: "unknown-1", role: "UNKNOWN" });

    // Mock session lookups
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

    // 1. Unauthenticated request -> 401
    const unauthRes = await fetch(baseUrl, { method: "POST" });
    assert.equal(unauthRes.status, 401);

    // 2. Missing CSRF token on POST -> 403 CSRF_INVALID
    const noCsrfRes = await fetch(baseUrl, {
      method: "POST",
      headers: { cookie: adminSession.signedCookie },
    });
    assert.equal(noCsrfRes.status, 403);
    const noCsrfJson = await noCsrfRes.json();
    assert.equal(noCsrfJson.code, "CSRF_INVALID");

    // 3. Invalid CSRF token on POST -> 403 CSRF_INVALID
    const invalidCsrfRes = await fetch(baseUrl, {
      method: "POST",
      headers: {
        cookie: adminSession.signedCookie,
        [CSRF_HEADER_NAME]: "wrong-csrf-token",
      },
    });
    assert.equal(invalidCsrfRes.status, 403);
    const invalidCsrfJson = await invalidCsrfRes.json();
    assert.equal(invalidCsrfJson.code, "CSRF_INVALID");

    // 4. Role denials: CASHIER, STAFF, UNKNOWN -> 403
    for (const session of [cashierSession, staffSession, unknownSession]) {
      const roleRes = await fetch(baseUrl, {
        method: "POST",
        headers: {
          cookie: session.signedCookie,
          [CSRF_HEADER_NAME]: session.rawCsrf,
        },
      });
      assert.equal(roleRes.status, 403, `Role ${session.sessionRecord.user.role} should be denied`);
    }

    // 5. POS-disabled mode -> 403 FEATURE_DISABLED on POST
    currentBusinessSettings = { ...currentBusinessSettings, businessMode: "CATALOG_ONLY" };
    invalidateBusinessSettingsCache();
    const posDisabledRes = await fetch(baseUrl, {
      method: "POST",
      headers: {
        cookie: adminSession.signedCookie,
        [CSRF_HEADER_NAME]: adminSession.rawCsrf,
      },
    });
    assert.equal(posDisabledRes.status, 403);
    const posDisabledJson = await posDisabledRes.json();
    assert.equal(posDisabledJson.code, "FEATURE_DISABLED");

    // Restore FULL_POS
    currentBusinessSettings = { ...currentBusinessSettings, businessMode: "FULL_POS" };
    invalidateBusinessSettingsCache();

    let transactionCalls = 0;
    // 6. Successful multipart upload as ADMIN
    prisma.$transaction = (async (callback: any) => {
      transactionCalls++;
      const tx = {
        document: {
          create: async ({ data }: any) => ({
            id: data.id,
            ...data,
            createdAt: new Date(),
            uploadedBy: { id: "admin-1", name: "Admin Ram" },
          }),
        },
        auditLog: { create: async () => ({ id: "audit-1" }) },
      };
      return callback(tx);
    }) as any;

    const adminFormData = new FormData();
    adminFormData.append(
      "file",
      new Blob([VALID_JPG], { type: "image/jpeg" }),
      "test-admin-upload.jpg",
    );
    adminFormData.append("title", "Admin HTTP Upload Receipt");
    adminFormData.append("remarks", "Admin HTTP upload remarks");

    const adminUploadRes = await fetch(baseUrl, {
      method: "POST",
      headers: {
        cookie: adminSession.signedCookie,
        [CSRF_HEADER_NAME]: adminSession.rawCsrf,
      },
      body: adminFormData,
    });
    assert.equal(adminUploadRes.status, 201);
    const adminUploadJson = await adminUploadRes.json();
    assert.ok(adminUploadJson.document);
    assert.equal(adminUploadJson.document.documentType, "SALE_BILL");
    assert.equal(adminUploadJson.document.saleRecoveryStatus, "UNRESOLVED");
    assert.equal(adminUploadJson.document.title, "Admin HTTP Upload Receipt");
    assert.equal("recoveryCheckoutOperationKey" in adminUploadJson.document, false);

    // 7. Successful multipart upload as MANAGER
    const mgrFormData = new FormData();
    mgrFormData.append(
      "file",
      new Blob([VALID_PNG], { type: "image/png" }),
      "test-mgr-upload.png",
    );
    mgrFormData.append("title", "Manager HTTP Upload Receipt");

    const mgrUploadRes = await fetch(baseUrl, {
      method: "POST",
      headers: {
        cookie: managerSession.signedCookie,
        [CSRF_HEADER_NAME]: managerSession.rawCsrf,
      },
      body: mgrFormData,
    });
    assert.equal(mgrUploadRes.status, 201);
    const mgrUploadJson = await mgrUploadRes.json();
    assert.ok(mgrUploadJson.document);
    assert.equal(mgrUploadJson.document.documentType, "SALE_BILL");
    assert.equal(mgrUploadJson.document.title, "Manager HTTP Upload Receipt");

    const tempDirectory = path.join(isolatedStorageRoot, ".temp");
    const tempBeforeRejects = (await fs.readdir(tempDirectory)).sort();
    const writesBeforeRejects = transactionCalls;
    // 8. Wrong multipart field name -> 400
    const wrongFieldForm = new FormData();
    wrongFieldForm.append(
      "document", // Wrong field name
      new Blob([VALID_JPG], { type: "image/jpeg" }),
      "test.jpg",
    );
    const wrongFieldRes = await fetch(baseUrl, {
      method: "POST",
      headers: {
        cookie: adminSession.signedCookie,
        [CSRF_HEADER_NAME]: adminSession.rawCsrf,
      },
      body: wrongFieldForm,
    });
    assert.equal(wrongFieldRes.status, 400);

    // 9. Missing file -> 400
    const emptyForm = new FormData();
    emptyForm.append("title", "No file here");
    const noFileRes = await fetch(baseUrl, {
      method: "POST",
      headers: {
        cookie: adminSession.signedCookie,
        [CSRF_HEADER_NAME]: adminSession.rawCsrf,
      },
      body: emptyForm,
    });
    assert.equal(noFileRes.status, 400);

    // 10. Disallowed MIME type (e.g. text/plain) -> 400
    const disallowedForm = new FormData();
    disallowedForm.append(
      "file",
      new Blob(["plain text"], { type: "text/plain" }),
      "notes.txt",
    );
    const disallowedRes = await fetch(baseUrl, {
      method: "POST",
      headers: {
        cookie: adminSession.signedCookie,
        [CSRF_HEADER_NAME]: adminSession.rawCsrf,
      },
      body: disallowedForm,
    });
    assert.equal(disallowedRes.status, 400);

    // 11. Multiple multipart files in request -> 400 with cleanup and no DB writes
    const multiFileForm = new FormData();
    multiFileForm.append(
      "file",
      new Blob([VALID_JPG], { type: "image/jpeg" }),
      "first.jpg",
    );
    multiFileForm.append(
      "extraFile",
      new Blob([VALID_PNG], { type: "image/png" }),
      "second.png",
    );
    const multiFileRes = await fetch(baseUrl, {
      method: "POST",
      headers: {
        cookie: adminSession.signedCookie,
        [CSRF_HEADER_NAME]: adminSession.rawCsrf,
      },
      body: multiFileForm,
    });
    assert.equal(multiFileRes.status, 400);

    // 12. Oversized file (>10MB) -> 413
    const hugeBlob = new Blob([Buffer.alloc(11 * 1024 * 1024)], {
      type: "image/jpeg",
    });
    const oversizedForm = new FormData();
    oversizedForm.append("file", hugeBlob, "oversized.jpg");
    const oversizedRes = await fetch(baseUrl, {
      method: "POST",
      headers: {
        cookie: adminSession.signedCookie,
        [CSRF_HEADER_NAME]: adminSession.rawCsrf,
      },
      body: oversizedForm,
    });
    assert.equal(oversizedRes.status, 413);
    assert.equal(transactionCalls, writesBeforeRejects, "Rejected requests must not invoke DB writes");
    assert.deepEqual((await fs.readdir(tempDirectory)).sort(), tempBeforeRejects, "Multer must remove owned temporary files");
  } finally {
    prisma.authSession.findUnique = originalAuthFindUnique;
    if ((prisma as any).businessSettings) {
      (prisma as any).businessSettings.upsert = originalBusinessSettingsUpsert;
      (prisma as any).businessSettings.findUnique = originalBusinessSettingsFindUnique;
    }
    prisma.$transaction = originalTransaction;
    invalidateBusinessSettingsCache();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
