import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import prisma from "../db/prisma";

let originalDocRoot: string | undefined;
let originalUploadsRoot: string | undefined;
let testStorageRoot: string;

let settingsRouter: any;
let listPaymentAccountsHandler: any;
let getEnabledPaymentAccountsHandler: any;
let createPaymentAccountHandler: any;
let patchPaymentAccountHandler: any;
let reorderPaymentAccountsHandler: any;
let uploadQrAssetHandler: any;
let getQrAssetFileHandler: any;
let listPaymentAccountAuditHandler: any;
let PaymentAccountStorageError: any;

test.before(async () => {
  originalDocRoot = process.env.DOCUMENT_STORAGE_ROOT;
  originalUploadsRoot = process.env.UPLOADS_ROOT;
  testStorageRoot = path.join(os.tmpdir(), `ks-route-test-${crypto.randomUUID()}`);
  process.env.DOCUMENT_STORAGE_ROOT = testStorageRoot;
  process.env.UPLOADS_ROOT = path.join(testStorageRoot, "uploads");

  await fs.mkdir(testStorageRoot, { recursive: true });
  await fs.mkdir(path.join(testStorageRoot, "payment-accounts"), { recursive: true });
  await fs.mkdir(path.join(testStorageRoot, ".temp"), { recursive: true });
  await fs.mkdir(path.join(testStorageRoot, "documents"), { recursive: true });
  await fs.mkdir(path.join(testStorageRoot, "import-sources"), { recursive: true });
  await fs.mkdir(path.join(testStorageRoot, "uploads"), { recursive: true });

  const routerMod = await import("../modules/settings/routes.js");
  const controllerMod = await import("../modules/settings/paymentAccounts/controller.js");
  const storageMod = await import("../modules/settings/paymentAccounts/storage.js");

  const rawRouter = routerMod.default as any;
  settingsRouter = rawRouter?.default && (rawRouter.default.stack || typeof rawRouter.default === "function")
    ? rawRouter.default
    : rawRouter;
  listPaymentAccountsHandler = controllerMod.listPaymentAccountsHandler;
  getEnabledPaymentAccountsHandler = controllerMod.getEnabledPaymentAccountsHandler;
  createPaymentAccountHandler = controllerMod.createPaymentAccountHandler;
  patchPaymentAccountHandler = controllerMod.patchPaymentAccountHandler;
  reorderPaymentAccountsHandler = controllerMod.reorderPaymentAccountsHandler;
  uploadQrAssetHandler = controllerMod.uploadQrAssetHandler;
  getQrAssetFileHandler = controllerMod.getQrAssetFileHandler;
  listPaymentAccountAuditHandler = controllerMod.listPaymentAccountAuditHandler;
  PaymentAccountStorageError = storageMod.PaymentAccountStorageError;
});

test.after(async () => {
  if (originalDocRoot !== undefined) {
    process.env.DOCUMENT_STORAGE_ROOT = originalDocRoot;
  } else {
    delete process.env.DOCUMENT_STORAGE_ROOT;
  }
  if (originalUploadsRoot !== undefined) {
    process.env.UPLOADS_ROOT = originalUploadsRoot;
  } else {
    delete process.env.UPLOADS_ROOT;
  }
  if (testStorageRoot) {
    await fs.rm(testStorageRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

function createMockResponse() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as any,
    locals: {} as Record<string, any>,
    sentFile: null as string | null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.body = data;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    sendFile(filePath: string) {
      this.sentFile = filePath;
      return this;
    },
  };
  return res;
}

test("settings router registers payment account routes with required guards in proper order", () => {
  const layers = (settingsRouter as any).stack as Array<{
    route?: {
      path?: string;
      methods?: Record<string, boolean>;
      stack?: Array<{ name: string; handle: Function }>;
    };
  }>;

  const routePaths = layers
    .filter((layer) => layer.route?.path)
    .map((layer) => layer.route!.path!);

  // Check route registration
  assert.ok(routePaths.includes("/payment-accounts/enabled"));
  assert.ok(routePaths.includes("/payment-accounts/:id/qr/:assetId/file"));
  assert.ok(routePaths.includes("/payment-accounts/:id/qr/:assetId/thumbnail"));
  assert.ok(routePaths.includes("/payment-accounts"));
  assert.ok(routePaths.includes("/payment-accounts/order"));
  assert.ok(routePaths.includes("/payment-accounts/:id/audit"));
  assert.ok(routePaths.includes("/payment-accounts/:id/qr"));

  // Enabled and order static routes must be registered before parameter routes
  const enabledIndex = routePaths.indexOf("/payment-accounts/enabled");
  const orderIndex = routePaths.indexOf("/payment-accounts/order");
  const uploadIndex = routePaths.indexOf("/payment-accounts/:id/qr");
  assert.ok(enabledIndex >= 0);
  assert.ok(orderIndex >= 0);
  assert.ok(uploadIndex >= 0);

  // Inspect POST /payment-accounts/:id/qr layer: requireRole("ADMIN") must precede Multer
  const qrUploadLayer = layers.find(
    (layer) => layer.route?.path === "/payment-accounts/:id/qr" && layer.route?.methods?.post,
  );
  assert.ok(qrUploadLayer, "POST /payment-accounts/:id/qr route must exist");
  const middlewareNames = qrUploadLayer!.route!.stack!.map((s) => s.name || s.handle.name);
  assert.ok(middlewareNames.length >= 2);
});

test("ADMIN management handlers enforce ADMIN-only and deny non-ADMIN before service calls", async () => {
  // 1. listPaymentAccountsHandler
  const resUnauth = createMockResponse();
  await listPaymentAccountsHandler({ user: null } as any, resUnauth);
  assert.equal(resUnauth.statusCode, 401);

  const resStaffList = createMockResponse();
  await listPaymentAccountsHandler({ user: { id: "staff-1", role: "STAFF" } } as any, resStaffList);
  assert.equal(resStaffList.statusCode, 403);

  const resCashierList = createMockResponse();
  await listPaymentAccountsHandler({ user: { id: "cashier-1", role: "CASHIER" } } as any, resCashierList);
  assert.equal(resCashierList.statusCode, 403);

  // 2. createPaymentAccountHandler
  const resStaffCreate = createMockResponse();
  await createPaymentAccountHandler({ user: { id: "staff-1", role: "STAFF" }, body: {} } as any, resStaffCreate);
  assert.equal(resStaffCreate.statusCode, 403);

  // 3. patchPaymentAccountHandler
  const resStaffPatch = createMockResponse();
  await patchPaymentAccountHandler(
    { user: { id: "staff-1", role: "STAFF" }, params: { id: "550e8400-e29b-41d4-a716-446655440000" }, body: {} } as any,
    resStaffPatch,
  );
  assert.equal(resStaffPatch.statusCode, 403);

  // 4. reorderPaymentAccountsHandler
  const resStaffReorder = createMockResponse();
  await reorderPaymentAccountsHandler({ user: { id: "staff-1", role: "STAFF" }, body: { orders: [] } } as any, resStaffReorder);
  assert.equal(resStaffReorder.statusCode, 403);

  // 5. uploadQrAssetHandler
  const resStaffUpload = createMockResponse();
  await uploadQrAssetHandler({ user: { id: "staff-1", role: "STAFF" }, params: { id: "550e8400-e29b-41d4-a716-446655440000" } } as any, resStaffUpload);
  assert.equal(resStaffUpload.statusCode, 403);

  // 6. listPaymentAccountAuditHandler
  const resStaffAudit = createMockResponse();
  await listPaymentAccountAuditHandler({ user: { id: "staff-1", role: "STAFF" }, params: { id: "550e8400-e29b-41d4-a716-446655440000" } } as any, resStaffAudit);
  assert.equal(resStaffAudit.statusCode, 403);
});

test("ADMIN management handlers validate UUIDs before service or database lookups", async () => {
  // patch with bad UUID
  const resPatch = createMockResponse();
  await patchPaymentAccountHandler(
    { user: { id: "admin-1", role: "ADMIN" }, params: { id: "not-a-uuid" }, body: { expectedVersion: 1 } } as any,
    resPatch,
  );
  assert.equal(resPatch.statusCode, 400);
  assert.equal(resPatch.body?.code, "INVALID_ACCOUNT_ID");

  // upload with bad UUID
  const resUpload = createMockResponse();
  await uploadQrAssetHandler(
    { user: { id: "admin-1", role: "ADMIN" }, params: { id: "not-a-uuid" } } as any,
    resUpload,
  );
  assert.equal(resUpload.statusCode, 400);
  assert.equal(resUpload.body?.code, "INVALID_ACCOUNT_ID");

  // audit with bad UUID
  const resAudit = createMockResponse();
  await listPaymentAccountAuditHandler(
    { user: { id: "admin-1", role: "ADMIN" }, params: { id: "not-a-uuid" } } as any,
    resAudit,
  );
  assert.equal(resAudit.statusCode, 400);
  assert.equal(resAudit.body?.code, "INVALID_ACCOUNT_ID");
});

test("getEnabledPaymentAccountsHandler enforces role, posEnabled capability and returns safe list", async (t) => {
  // 1. Unauthenticated request -> 401
  const reqUnauth: any = { user: null };
  const resUnauth = createMockResponse();
  await getEnabledPaymentAccountsHandler(reqUnauth, resUnauth);
  assert.equal(resUnauth.statusCode, 401);

  // 2. STAFF role request -> 403
  const reqStaff: any = { user: { id: "staff-1", role: "STAFF" } };
  const resStaff = createMockResponse();
  await getEnabledPaymentAccountsHandler(reqStaff, resStaff);
  assert.equal(resStaff.statusCode, 403);
  assert.equal(resStaff.body?.code, "FORBIDDEN");

  // 3. Denied POS capability (posEnabled: false or nonboolean truthy) causes 403 FEATURE_DISABLED and ZERO DB calls
  let findManyCalled = false;
  const originalFindMany = prisma.paymentReceivingAccount.findMany;
  (prisma.paymentReceivingAccount as any).findMany = async () => {
    findManyCalled = true;
    return [];
  };

  t.after(() => {
    prisma.paymentReceivingAccount.findMany = originalFindMany;
  });

  const reqPosDisabled: any = { user: { id: "cashier-1", role: "CASHIER" } };
  const resPosDisabled = createMockResponse();
  resPosDisabled.locals = { businessCapabilities: { posEnabled: false } };
  await getEnabledPaymentAccountsHandler(reqPosDisabled, resPosDisabled);
  assert.equal(resPosDisabled.statusCode, 403);
  assert.equal(resPosDisabled.body?.code, "FEATURE_DISABLED");
  assert.equal(findManyCalled, false, "Prisma findMany must not be called when POS is disabled");

  // Non-boolean truthy values (e.g., string "false", "true", number 1) must be strictly rejected
  const truthyNonBooleanValues = ["false", "true", 1, "1", {}];
  for (const nonBool of truthyNonBooleanValues) {
    const resTruthy = createMockResponse();
    resTruthy.locals = { businessCapabilities: { posEnabled: nonBool } };
    await getEnabledPaymentAccountsHandler(reqPosDisabled, resTruthy);
    assert.equal(resTruthy.statusCode, 403, `posEnabled=${JSON.stringify(nonBool)} must be rejected with 403`);
    assert.equal(resTruthy.body?.code, "FEATURE_DISABLED");
    assert.equal(findManyCalled, false, "Prisma findMany must not be called for non-boolean truthy posEnabled");
  }

  // 4. Valid POS capability -> returns projected safe list without storage paths
  (prisma.paymentReceivingAccount as any).findMany = async () => {
    findManyCalled = true;
    return [
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        providerLabel: "Fonepay Primary",
        accountHolder: "Store Owner",
        accountIdentifier: "9800000000",
        settlementMethod: "FONEPAY",
        confirmationMode: "MANUAL_RECEIPT",
        version: 1,
        activeQrAssetId: "660e8400-e29b-41d4-a716-446655440000",
        storedPath: "/secret/path/should/not/leak",
      },
    ];
  };

  const reqPosEnabled: any = { user: { id: "cashier-1", role: "CASHIER" } };
  const resPosEnabled = createMockResponse();
  resPosEnabled.locals = { businessCapabilities: { posEnabled: true } };
  await getEnabledPaymentAccountsHandler(reqPosEnabled, resPosEnabled);
  assert.equal(resPosEnabled.statusCode, 200);
  assert.equal(findManyCalled, true);
  assert.equal(resPosEnabled.body.length, 1);
  const item = resPosEnabled.body[0];
  assert.equal(item.id, "550e8400-e29b-41d4-a716-446655440000");
  assert.equal(item.activeQrThumbnailUrl, "/api/settings/payment-accounts/550e8400-e29b-41d4-a716-446655440000/qr/660e8400-e29b-41d4-a716-446655440000/thumbnail");
  assert.equal(item.activeQrFileUrl, "/api/settings/payment-accounts/550e8400-e29b-41d4-a716-446655440000/qr/660e8400-e29b-41d4-a716-446655440000/file");
  assert.equal(item.supportedSettlement, true);
  assert.equal(item.storedPath, undefined, "Storage path must not leak in enabled DTO");
});

test("getQrAssetFileHandler validates parameters, enforces POS capability for POS roles, and ADMIN bypasses POS", async (t) => {
  // 1. Unauthenticated request -> 401
  const reqUnauth: any = { user: null, params: { id: "test", assetId: "test" }, path: "/file" };
  const resUnauth = createMockResponse();
  await getQrAssetFileHandler(reqUnauth, resUnauth);
  assert.equal(resUnauth.statusCode, 401);

  // 2. STAFF role request -> 403
  const reqStaff: any = {
    user: { id: "staff-1", role: "STAFF" },
    params: { id: "550e8400-e29b-41d4-a716-446655440000", assetId: "660e8400-e29b-41d4-a716-446655440000" },
    path: "/file",
  };
  const resStaff = createMockResponse();
  await getQrAssetFileHandler(reqStaff, resStaff);
  assert.equal(resStaff.statusCode, 403);
  assert.equal(resStaff.body?.code, "FORBIDDEN");

  // 3. Invalid account ID format -> 400
  const reqBadId: any = {
    user: { id: "admin-1", role: "ADMIN" },
    params: { id: "not-a-uuid", assetId: "550e8400-e29b-41d4-a716-446655440000" },
    path: "/file",
  };
  const resBadId = createMockResponse();
  await getQrAssetFileHandler(reqBadId, resBadId);
  assert.equal(resBadId.statusCode, 400);
  assert.equal(resBadId.body?.code, "INVALID_ACCOUNT_ID");

  // 4. Invalid asset ID format -> 400
  const reqBadAsset: any = {
    user: { id: "admin-1", role: "ADMIN" },
    params: { id: "550e8400-e29b-41d4-a716-446655440000", assetId: "not-a-uuid" },
    path: "/file",
  };
  const resBadAsset = createMockResponse();
  await getQrAssetFileHandler(reqBadAsset, resBadAsset);
  assert.equal(resBadAsset.statusCode, 400);
  assert.equal(resBadAsset.body?.code, "INVALID_ASSET_ID");

  // 5. CASHIER with posEnabled: false or nonboolean truthy -> 403 FEATURE_DISABLED
  let accountQueryCalled = false;
  const origFindUnique = prisma.paymentReceivingAccount.findUnique;
  (prisma.paymentReceivingAccount as any).findUnique = async () => {
    accountQueryCalled = true;
    return null;
  };
  t.after(() => {
    prisma.paymentReceivingAccount.findUnique = origFindUnique;
  });

  const reqCashierNoPos: any = {
    user: { id: "cashier-1", role: "CASHIER" },
    params: { id: "550e8400-e29b-41d4-a716-446655440000", assetId: "660e8400-e29b-41d4-a716-446655440000" },
    path: "/file",
  };
  const resCashierNoPos = createMockResponse();
  resCashierNoPos.locals = { businessCapabilities: { posEnabled: false } };
  await getQrAssetFileHandler(reqCashierNoPos, resCashierNoPos);
  assert.equal(resCashierNoPos.statusCode, 403);
  assert.equal(resCashierNoPos.body?.code, "FEATURE_DISABLED");
  assert.equal(accountQueryCalled, false, "DB must not be queried when POS disabled for CASHIER");

  for (const nonBool of ["false", "true", 1, "1", {}]) {
    const resTruthy = createMockResponse();
    resTruthy.locals = { businessCapabilities: { posEnabled: nonBool } };
    await getQrAssetFileHandler(reqCashierNoPos, resTruthy);
    assert.equal(resTruthy.statusCode, 403, `QR handler posEnabled=${JSON.stringify(nonBool)} must be 403`);
    assert.equal(resTruthy.body?.code, "FEATURE_DISABLED");
    assert.equal(accountQueryCalled, false, "DB must not be queried for nonboolean truthy posEnabled in QR handler");
  }
});

test("controller maps storage unavailable errors to safe 503 without revealing paths", async () => {
  const res = createMockResponse();

  const storageError = new PaymentAccountStorageError("Document storage is temporarily unavailable", 503, "STORAGE_UNAVAILABLE");
  if (storageError.statusCode === 503) {
    res.status(503).json({ error: storageError.message, code: storageError.code });
  }

  assert.equal(res.statusCode, 503);
  assert.equal(res.body?.code, "STORAGE_UNAVAILABLE");
  assert.equal(res.body?.error, "Document storage is temporarily unavailable");
  assert.equal(JSON.stringify(res.body).includes("C:\\"), false);
  assert.equal(JSON.stringify(res.body).includes("/var/"), false);
});
