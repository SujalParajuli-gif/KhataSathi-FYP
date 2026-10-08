import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import { listAuditLogs, listCategorizedHistory } from "../modules/audit/service";
import {
  listPaymentAccountAudit,
  sanitizePaymentAccountAuditMeta,
  PaymentAccountError,
} from "../modules/settings/paymentAccounts/service";

const VALID_ACCOUNT_ID = "550e8400-e29b-41d4-a716-446655440000";

test("generic listAuditLogs unconditionally excludes PAYMENT_ACCOUNT_ prefix outside caller filters", async (t) => {
  const originalFindMany = prisma.auditLog.findMany;
  const originalCount = prisma.auditLog.count;

  let capturedFindManyWhere: any = null;
  let capturedCountWhere: any = null;

  (prisma.auditLog as any).findMany = async (args: any) => {
    capturedFindManyWhere = args?.where;
    return [];
  };
  (prisma.auditLog as any).count = async (args: any) => {
    capturedCountWhere = args?.where;
    return 0;
  };

  t.after(() => {
    prisma.auditLog.findMany = originalFindMany;
    prisma.auditLog.count = originalCount;
  });

  // 1. Basic query with no filters
  await listAuditLogs({});
  assert.ok(capturedFindManyWhere?.AND, "where.AND must exist");
  assert.deepEqual(
    capturedFindManyWhere.AND.find((c: any) => c?.action?.not?.startsWith === "PAYMENT_ACCOUNT_"),
    { action: { not: { startsWith: "PAYMENT_ACCOUNT_" } } },
    "Top-level AND must exclude PAYMENT_ACCOUNT_ prefix",
  );
  assert.deepEqual(
    capturedCountWhere.AND.find((c: any) => c?.action?.not?.startsWith === "PAYMENT_ACCOUNT_"),
    { action: { not: { startsWith: "PAYMENT_ACCOUNT_" } } },
    "Count where.AND must also exclude PAYMENT_ACCOUNT_ prefix",
  );

  // 2. Caller explicitly searches for an action with PAYMENT_ACCOUNT_
  await listAuditLogs({ action: "PAYMENT_ACCOUNT_CREATED", actorId: "user-1", entityType: "PaymentReceivingAccount" });
  assert.ok(capturedFindManyWhere?.AND);
  assert.deepEqual(
    capturedFindManyWhere.AND.find((c: any) => c?.action?.not?.startsWith === "PAYMENT_ACCOUNT_"),
    { action: { not: { startsWith: "PAYMENT_ACCOUNT_" } } },
    "Caller action filter must NOT override the unconditional top-level exclusion",
  );
  assert.deepEqual(
    capturedFindManyWhere.AND.find((c: any) => c?.action?.contains === "PAYMENT_ACCOUNT_CREATED"),
    { action: { contains: "PAYMENT_ACCOUNT_CREATED" } },
  );
  assert.equal(capturedFindManyWhere.actorId, "user-1");
  assert.equal(capturedFindManyWhere.entityType, "PaymentReceivingAccount");
});

test("generic listCategorizedHistory unconditionally excludes PAYMENT_ACCOUNT_ prefix across categories and search", async (t) => {
  const originalFindMany = prisma.auditLog.findMany;
  const originalCount = prisma.auditLog.count;

  let capturedFindManyWhere: any = null;
  let capturedCountWhere: any = null;

  (prisma.auditLog as any).findMany = async (args: any) => {
    capturedFindManyWhere = args?.where;
    return [];
  };
  (prisma.auditLog as any).count = async (args: any) => {
    capturedCountWhere = args?.where;
    return 0;
  };

  t.after(() => {
    prisma.auditLog.findMany = originalFindMany;
    prisma.auditLog.count = originalCount;
  });

  // 1. Payment category query
  await listCategorizedHistory({ category: "payment", q: "PAYMENT_ACCOUNT" });
  assert.ok(capturedFindManyWhere?.AND, "where.AND must exist");
  assert.deepEqual(
    capturedFindManyWhere.AND.find((c: any) => c?.action?.not?.startsWith === "PAYMENT_ACCOUNT_"),
    { action: { not: { startsWith: "PAYMENT_ACCOUNT_" } } },
    "where.AND must exclude PAYMENT_ACCOUNT_ prefix for categorized history",
  );
  assert.deepEqual(
    capturedCountWhere.AND.find((c: any) => c?.action?.not?.startsWith === "PAYMENT_ACCOUNT_"),
    { action: { not: { startsWith: "PAYMENT_ACCOUNT_" } } },
  );

  // 2. All category with specific action
  await listCategorizedHistory({ category: "all", action: "PAYMENT_ACCOUNT_UPDATED", actorId: "actor-1" });
  assert.deepEqual(
    capturedFindManyWhere.AND.find((c: any) => c?.action?.not?.startsWith === "PAYMENT_ACCOUNT_"),
    { action: { not: { startsWith: "PAYMENT_ACCOUNT_" } } },
  );
});

test("listPaymentAccountAudit validates account UUID before query", async () => {
  await assert.rejects(
    async () => {
      await listPaymentAccountAudit("invalid-not-a-uuid");
    },
    (err: any) => {
      assert.ok(err instanceof PaymentAccountError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "INVALID_ACCOUNT_ID");
      return true;
    },
  );
});

const VALID_ASSET_ID = "660e8400-e29b-41d4-a716-446655440000";
const VALID_SHA256 = "a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e";

test("listPaymentAccountAudit passes correct predicates, takes at most 50, and strips sensitive fields", async (t) => {
  const originalFindMany = prisma.auditLog.findMany;
  let capturedArgs: any = null;

  const mockLogs = [
    {
      id: "log-1",
      action: "PAYMENT_ACCOUNT_CREATED",
      entityType: "PaymentReceivingAccount",
      entityId: VALID_ACCOUNT_ID,
      actorId: "actor-1",
      createdAt: new Date("2026-10-07T10:00:00Z"),
      actor: { id: "actor-1", name: "Admin User", role: "ADMIN" },
      meta: {
        providerLabel: "Fonepay Primary",
        accountHolder: "Store Owner",
        accountIdentifier: "9800000000",
        settlementMethod: "FONEPAY",
        confirmationMode: "MANUAL_RECEIPT",
        version: 1,
        enabled: false,
        // Injected dirty/secret fields that must be stripped:
        storedPath: "/var/storage/secret/path",
        fileName: "secret_qr.png",
        sourceChecksum: "abcdef1234567890",
        creationPayloadHash: "hash-secret-value",
        secretToken: "bearer-token-123",
        rawBytes: "0x1234",
      },
    },
    {
      id: "log-2",
      action: "PAYMENT_ACCOUNT_UPDATED",
      entityType: "PaymentReceivingAccount",
      entityId: VALID_ACCOUNT_ID,
      actorId: "actor-1",
      createdAt: new Date("2026-10-07T10:05:00Z"),
      actor: { id: "actor-1", name: "Admin User", role: "ADMIN" },
      meta: {
        previous: {
          providerLabel: "Fonepay Primary",
          accountHolder: "Store Owner",
          accountIdentifier: "9800000000",
          settlementMethod: "FONEPAY",
          confirmationMode: "MANUAL_RECEIPT",
          enabled: false,
          version: 1,
          internalLeak: "leak-1",
        },
        updated: {
          providerLabel: "Fonepay Updated",
          accountHolder: "Store Owner 2",
          accountIdentifier: "9800000001",
          settlementMethod: "FONEPAY",
          confirmationMode: "MANUAL_RECEIPT",
          enabled: true,
          version: 2,
          internalLeak: "leak-2",
        },
        injectedRootField: "should-not-exist",
      },
    },
    {
      id: "log-3",
      action: "PAYMENT_ACCOUNT_QR_PUBLISHED",
      entityType: "PaymentReceivingAccount",
      entityId: VALID_ACCOUNT_ID,
      actorId: "actor-1",
      createdAt: new Date("2026-10-07T10:10:00Z"),
      actor: { id: "actor-1", name: "Admin User", role: "ADMIN" },
      meta: {
        assetId: VALID_ASSET_ID,
        oldActiveAssetId: null,
        version: 2,
        checksum: VALID_SHA256,
        width: 1024,
        height: 1024,
        // Injected dirty fields:
        storedPath: "/var/storage/qr.png",
        thumbnailStoredPath: "/var/storage/thumb.png",
        sourceChecksum: "sha256-source-checksum",
        tempFilePath: "/tmp/scratch.png",
      },
    },
    {
      id: "log-4",
      action: "PAYMENT_ACCOUNT_REORDERED",
      entityType: "PaymentReceivingAccountCollection",
      entityId: "1",
      actorId: "actor-1",
      createdAt: new Date("2026-10-07T10:15:00Z"),
      actor: { id: "actor-1", name: "Admin User", role: "ADMIN" },
      meta: {
        changes: Array.from({ length: 150 }, (_, i) => ({
          id: `550e8400-e29b-41d4-a716-${String(i).padStart(12, "0")}`,
          oldSortOrder: i,
          newSortOrder: i + 1,
          newVersion: 2,
          sensitiveMetadata: "leak",
        })),
        unrelatedSecrets: "secret",
      },
    },
  ];

  (prisma.auditLog as any).findMany = async (args: any) => {
    capturedArgs = args;
    return mockLogs;
  };

  t.after(() => {
    prisma.auditLog.findMany = originalFindMany;
  });

  const result = await listPaymentAccountAudit(VALID_ACCOUNT_ID);

  // Assert query args
  assert.equal(capturedArgs.take, 50, "Must take at most 50 entries");
  assert.deepEqual(capturedArgs.orderBy, { createdAt: "desc" });
  assert.deepEqual(capturedArgs.where, {
    action: { startsWith: "PAYMENT_ACCOUNT_" },
    OR: [
      { entityId: VALID_ACCOUNT_ID },
      { entityType: "PaymentReceivingAccountCollection" },
    ],
  });

  // Assert projected DTO count
  assert.equal(result.length, 4);

  // Check log-1 (CREATED) sanitization
  const createdDto = result[0];
  assert.equal(createdDto.id, "log-1");
  assert.equal(createdDto.action, "PAYMENT_ACCOUNT_CREATED");
  assert.equal(createdDto.actor?.name, "Admin User");
  assert.equal(createdDto.meta.providerLabel, "Fonepay Primary");
  assert.equal(createdDto.meta.accountHolder, "Store Owner");
  assert.equal(createdDto.meta.accountIdentifier, "9800000000");
  assert.equal(createdDto.meta.settlementMethod, "FONEPAY");
  assert.equal(createdDto.meta.confirmationMode, "MANUAL_RECEIPT");
  assert.equal(createdDto.meta.version, 1);
  assert.equal(createdDto.meta.enabled, false);
  // Ensure sensitive fields stripped
  assert.equal(createdDto.meta.storedPath, undefined);
  assert.equal(createdDto.meta.fileName, undefined);
  assert.equal(createdDto.meta.sourceChecksum, undefined);
  assert.equal(createdDto.meta.creationPayloadHash, undefined);
  assert.equal(createdDto.meta.secretToken, undefined);
  assert.equal(createdDto.meta.rawBytes, undefined);

  // Check log-2 (UPDATED) sanitization
  const updatedDto = result[1];
  assert.equal(updatedDto.meta.previous.providerLabel, "Fonepay Primary");
  assert.equal(updatedDto.meta.previous.internalLeak, undefined);
  assert.equal(updatedDto.meta.updated.providerLabel, "Fonepay Updated");
  assert.equal(updatedDto.meta.updated.version, 2);
  assert.equal(updatedDto.meta.updated.internalLeak, undefined);
  assert.equal(updatedDto.meta.injectedRootField, undefined);

  // Check log-3 (QR_PUBLISHED) sanitization
  const publishedDto = result[2];
  assert.equal(publishedDto.meta.assetId, VALID_ASSET_ID);
  assert.equal(publishedDto.meta.checksum, VALID_SHA256);
  assert.equal(publishedDto.meta.width, 1024);
  assert.equal(publishedDto.meta.height, 1024);
  assert.equal(publishedDto.meta.storedPath, undefined);
  assert.equal(publishedDto.meta.thumbnailStoredPath, undefined);
  assert.equal(publishedDto.meta.sourceChecksum, undefined);
  assert.equal(publishedDto.meta.tempFilePath, undefined);

  // Check log-4 (REORDERED) bounded to 100 changes and sanitized
  const reorderedDto = result[3];
  assert.ok(Array.isArray(reorderedDto.meta.changes));
  assert.equal(reorderedDto.meta.changes.length, 100, "Changes array must be bounded to at most 100 items");
  assert.equal(reorderedDto.meta.changes[0].id, "550e8400-e29b-41d4-a716-000000000000");
  assert.equal(reorderedDto.meta.changes[0].oldSortOrder, 0);
  assert.equal(reorderedDto.meta.changes[0].newSortOrder, 1);
  assert.equal(reorderedDto.meta.changes[0].newVersion, 2);
  assert.equal(reorderedDto.meta.changes[0].sensitiveMetadata, undefined);
  assert.equal(reorderedDto.meta.unrelatedSecrets, undefined);
});

test("sanitizePaymentAccountAuditMeta handles corrupt, nested, control-bearing, and nonfinite inputs safely", () => {
  // 1. Unknown action or invalid root
  assert.deepEqual(sanitizePaymentAccountAuditMeta("UNKNOWN_ACTION", { foo: "bar" }), {});
  assert.deepEqual(sanitizePaymentAccountAuditMeta("PAYMENT_ACCOUNT_CREATED", null), {});
  assert.deepEqual(sanitizePaymentAccountAuditMeta("PAYMENT_ACCOUNT_CREATED", "string-not-object"), {});
  assert.deepEqual(sanitizePaymentAccountAuditMeta("PAYMENT_ACCOUNT_CREATED", [1, 2, 3]), {});

  // 2. PAYMENT_ACCOUNT_CREATED with corrupted nested methods, HTML/control text, and nonfinite numbers
  const corruptedCreated = sanitizePaymentAccountAuditMeta("PAYMENT_ACCOUNT_CREATED", {
    providerLabel: "<b>Fonepay</b>\x00\x1f\n" + "A".repeat(200),
    accountHolder: "  Store\tOwner  ",
    accountIdentifier: { nested: "object" },
    settlementMethod: { evil: "payload" },
    confirmationMode: ["INVALID_MODE"],
    version: NaN,
    enabled: "truthy-string",
    extraSecret: "leaked",
  });
  assert.equal(corruptedCreated.providerLabel, "Fonepay" + "A".repeat(113));
  assert.equal(corruptedCreated.providerLabel.length, 120);
  assert.equal(corruptedCreated.accountHolder, "StoreOwner");
  assert.equal(corruptedCreated.accountIdentifier, null);
  assert.equal(corruptedCreated.settlementMethod, null);
  assert.equal(corruptedCreated.confirmationMode, null);
  assert.equal(corruptedCreated.version, 1);
  assert.equal(corruptedCreated.enabled, false);
  assert.equal((corruptedCreated as any).extraSecret, undefined);

  // 3. PAYMENT_ACCOUNT_UPDATED with nested object attacks and non-string injections
  const corruptedUpdated = sanitizePaymentAccountAuditMeta("PAYMENT_ACCOUNT_UPDATED", {
    previous: {
      providerLabel: { attack: "object" },
      accountHolder: 12345,
      accountIdentifier: "<script>alert(1)</script>9800000000",
      settlementMethod: "UNSUPPORTED_METHOD",
      confirmationMode: "MANUAL_RECEIPT",
      enabled: "true",
      version: Infinity,
    },
    updated: {
      providerLabel: "Valid Label",
      accountHolder: "Valid Holder",
      settlementMethod: "BANK_TRANSFER",
      confirmationMode: "DISPLAY_ONLY",
      enabled: true,
      version: 5,
    },
  });
  assert.equal(corruptedUpdated.previous.providerLabel, undefined); // Never String(object)
  assert.equal(corruptedUpdated.previous.accountHolder, undefined); // Never String(number)
  assert.equal(corruptedUpdated.previous.accountIdentifier, "alert(1)9800000000");
  assert.equal(corruptedUpdated.previous.settlementMethod, null);
  assert.equal(corruptedUpdated.previous.confirmationMode, "MANUAL_RECEIPT");
  assert.equal(corruptedUpdated.previous.enabled, undefined);
  assert.equal(corruptedUpdated.previous.version, undefined);

  assert.equal(corruptedUpdated.updated.providerLabel, "Valid Label");
  assert.equal(corruptedUpdated.updated.accountHolder, "Valid Holder");
  assert.equal(corruptedUpdated.updated.settlementMethod, "BANK_TRANSFER");
  assert.equal(corruptedUpdated.updated.confirmationMode, "DISPLAY_ONLY");
  assert.equal(corruptedUpdated.updated.enabled, true);
  assert.equal(corruptedUpdated.updated.version, 5);

  // 4. PAYMENT_ACCOUNT_QR_PUBLISHED with invalid UUIDs, filesystem paths in checksum, and nonfinite dimensions
  const corruptedQr = sanitizePaymentAccountAuditMeta("PAYMENT_ACCOUNT_QR_PUBLISHED", {
    assetId: "not-a-valid-uuid",
    oldActiveAssetId: "/var/storage/evil.png",
    version: -3,
    checksum: "/etc/passwd/or/file/path",
    width: Infinity,
    height: 50, // below MIN_IMAGE_DIMENSION 128
    storedPath: "/var/storage/secret.png",
    sourceChecksum: "original-source",
  });
  assert.equal(corruptedQr.assetId, undefined);
  assert.equal(corruptedQr.oldActiveAssetId, undefined);
  assert.equal(corruptedQr.version, undefined);
  assert.equal(corruptedQr.checksum, undefined);
  assert.equal(corruptedQr.width, undefined);
  assert.equal(corruptedQr.height, undefined);
  assert.equal((corruptedQr as any).storedPath, undefined);
  assert.equal((corruptedQr as any).sourceChecksum, undefined);

  // Valid QR audit meta
  const validQr = sanitizePaymentAccountAuditMeta("PAYMENT_ACCOUNT_QR_PUBLISHED", {
    assetId: VALID_ASSET_ID,
    oldActiveAssetId: null,
    version: 3,
    checksum: VALID_SHA256.toUpperCase(),
    width: 512,
    height: 512,
  });
  assert.equal(validQr.assetId, VALID_ASSET_ID);
  assert.equal(validQr.oldActiveAssetId, null);
  assert.equal(validQr.version, 3);
  assert.equal(validQr.checksum, VALID_SHA256.toLowerCase());
  assert.equal(validQr.width, 512);
  assert.equal(validQr.height, 512);

  // 5. PAYMENT_ACCOUNT_REORDERED with null/array/primitive entries and nonfinite values
  const corruptedReordered = sanitizePaymentAccountAuditMeta("PAYMENT_ACCOUNT_REORDERED", {
    changes: [
      null,
      undefined,
      "invalid-string-entry",
      [1, 2, 3],
      {
        id: "550e8400-e29b-41d4-a716-000000000001",
        oldSortOrder: -1,
        newSortOrder: NaN,
        newVersion: Infinity,
        leak: "sensitive",
      },
      {
        id: "550e8400-e29b-41d4-a716-000000000002",
        oldSortOrder: 2,
        newSortOrder: 0,
        newVersion: 4,
      },
    ],
  });
  assert.equal(corruptedReordered.changes.length, 2);
  assert.deepEqual(corruptedReordered.changes[0], {
    id: "550e8400-e29b-41d4-a716-000000000001",
    oldSortOrder: 0,
    newSortOrder: 0,
    newVersion: 1,
  });
  assert.deepEqual(corruptedReordered.changes[1], {
    id: "550e8400-e29b-41d4-a716-000000000002",
    oldSortOrder: 2,
    newSortOrder: 0,
    newVersion: 4,
  });
});
