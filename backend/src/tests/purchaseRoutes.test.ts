import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Prisma } from "@prisma/client";
import prisma from "../db/prisma";
import inventoryRoutes from "../modules/inventory/routes";
import {
  requireBusinessCapability,
  type BusinessCapabilities,
} from "../modules/settings/capabilities";
import {
  signSessionToken,
  hashSessionSecret,
  SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "../modules/auth/session";
import { FinancialPurchaseConflictError, getStockReceiveBatchById } from "../modules/inventory/service";

/* =========================================================================
   TEST FIXTURES & HELPERS
   ========================================================================= */

function createTestSession(user: {
  id: string;
  role: string;
  isActive?: boolean;
  mustChangePassword?: boolean;
}) {
  const rawToken = "test-token-" + Math.random().toString(36).slice(2);
  const tokenHash = hashSessionSecret(rawToken);
  const csrfToken = "test-csrf-" + Math.random().toString(36).slice(2);
  const csrfTokenHash = hashSessionSecret(csrfToken);
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
    csrfToken,
    signedCookie,
    sessionRecord,
  };
}

const defaultEnabledCapabilities: BusinessCapabilities = {
  businessMode: "FULL_POS",
  catalogEnabled: true,
  inventoryEnabled: true,
  posEnabled: true,
  staffDraftRequestsEnabled: true,
  stockTracked: true,
};

async function postJson(url: string, body: unknown, session?: ReturnType<typeof createTestSession>) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (session) {
    headers.cookie = session.signedCookie;
    headers[CSRF_HEADER_NAME] = session.csrfToken;
  }
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function patchJson(url: string, body: unknown, session?: ReturnType<typeof createTestSession>) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (session) {
    headers.cookie = session.signedCookie;
    headers[CSRF_HEADER_NAME] = session.csrfToken;
  }
  return fetch(url, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
}

async function getJson(url: string, session?: ReturnType<typeof createTestSession>) {
  const headers: Record<string, string> = {};
  if (session) {
    headers.cookie = session.signedCookie;
  }
  return fetch(url, { method: "GET", headers });
}

/* =========================================================================
   TEST 1: AUTHENTICATION, ROLE DENIALS & CAPABILITY GATING
   ========================================================================= */

test("HTTP access matrix: unauthenticated (401), CASHIER (403), STAFF (403), and disabled INVENTORY (403 FEATURE_DISABLED) denied before effects", async () => {
  let currentCapabilities = { ...defaultEnabledCapabilities };

  const app = express();
  app.use(express.json());
  app.use(
    "/api/inventory",
    requireBusinessCapability("INVENTORY", async () => currentCapabilities),
    inventoryRoutes
  );

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const adminSession = createTestSession({ id: "admin-1", role: "ADMIN" });
  const managerSession = createTestSession({ id: "mgr-1", role: "MANAGER" });
  const cashierSession = createTestSession({ id: "cashier-1", role: "CASHIER" });
  const staffSession = createTestSession({ id: "staff-1", role: "STAFF" });

  const sessionsMap = new Map<string, any>([
    [adminSession.sessionRecord.tokenHash, adminSession.sessionRecord],
    [managerSession.sessionRecord.tokenHash, managerSession.sessionRecord],
    [cashierSession.sessionRecord.tokenHash, cashierSession.sessionRecord],
    [staffSession.sessionRecord.tokenHash, staffSession.sessionRecord],
  ]);

  const originalAuthFindUnique = prisma.authSession.findUnique;
  let effectsCalled = false;

  try {
    prisma.authSession.findUnique = (async ({ where }: any) => {
      return sessionsMap.get(where.tokenHash) || null;
    }) as any;

    // Spy to ensure no database effect occurs during denied attempts
    const originalSupplierCreate = (prisma as any).supplier?.create;
    if (!(prisma as any).supplier) (prisma as any).supplier = {};
    (prisma as any).supplier.create = async () => {
      effectsCalled = true;
      return { id: "supp-leak" };
    };

    // 1. Unauthenticated requests -> 401
    const unauthGetSuppliers = await getJson(`${baseUrl}/api/inventory/suppliers`);
    assert.equal(unauthGetSuppliers.status, 401);

    const unauthPostSuppliers = await postJson(`${baseUrl}/api/inventory/suppliers`, { name: "Test" });
    assert.equal(unauthPostSuppliers.status, 401);

    const unauthGetPurchases = await getJson(`${baseUrl}/api/inventory/purchases`);
    assert.equal(unauthGetPurchases.status, 401);

    const unauthPostPurchases = await postJson(`${baseUrl}/api/inventory/purchases`, { payable: "100.00" });
    assert.equal(unauthPostPurchases.status, 401);

    const unauthGetDetail = await getJson(`${baseUrl}/api/inventory/purchases/batch-1`);
    assert.equal(unauthGetDetail.status, 401);

    const unauthInstallment = await postJson(`${baseUrl}/api/inventory/purchases/batch-1/installments`, { amount: "50" });
    assert.equal(unauthInstallment.status, 401);

    const unauthAttachment = await postJson(`${baseUrl}/api/inventory/purchases/batch-1/attachments`, { documentIds: ["d1"] });
    assert.equal(unauthAttachment.status, 401);

    const unauthVoid = await postJson(`${baseUrl}/api/inventory/purchase-installments/pay-1/void`, { voidReason: "test" });
    assert.equal(unauthVoid.status, 401);

    // 2. Denied roles: CASHIER and STAFF -> 403
    for (const deniedSession of [cashierSession, staffSession]) {
      const resGetSupp = await getJson(`${baseUrl}/api/inventory/suppliers`, deniedSession);
      assert.equal(resGetSupp.status, 403, `GET /suppliers must be 403 for ${deniedSession.sessionRecord.user.role}`);

      const resPostSupp = await postJson(`${baseUrl}/api/inventory/suppliers`, { name: "Test" }, deniedSession);
      assert.equal(resPostSupp.status, 403, `POST /suppliers must be 403 for ${deniedSession.sessionRecord.user.role}`);

      const resGetPurch = await getJson(`${baseUrl}/api/inventory/purchases`, deniedSession);
      assert.equal(resGetPurch.status, 403, `GET /purchases must be 403 for ${deniedSession.sessionRecord.user.role}`);

      const resPostPurch = await postJson(`${baseUrl}/api/inventory/purchases`, { payable: "100.00" }, deniedSession);
      assert.equal(resPostPurch.status, 403, `POST /purchases must be 403 for ${deniedSession.sessionRecord.user.role}`);

      const resDetail = await getJson(`${baseUrl}/api/inventory/purchases/batch-1`, deniedSession);
      assert.equal(resDetail.status, 403, `GET /purchases/:id must be 403 for ${deniedSession.sessionRecord.user.role}`);

      const resInstallment = await postJson(`${baseUrl}/api/inventory/purchases/batch-1/installments`, { amount: "50" }, deniedSession);
      assert.equal(resInstallment.status, 403, `POST /installments must be 403 for ${deniedSession.sessionRecord.user.role}`);

      const resAttachment = await postJson(`${baseUrl}/api/inventory/purchases/batch-1/attachments`, { documentIds: ["d1"] }, deniedSession);
      assert.equal(resAttachment.status, 403, `POST /attachments must be 403 for ${deniedSession.sessionRecord.user.role}`);

      const resVoid = await postJson(`${baseUrl}/api/inventory/purchase-installments/pay-1/void`, { voidReason: "test" }, deniedSession);
      assert.equal(resVoid.status, 403, `POST /void must be 403 for ${deniedSession.sessionRecord.user.role}`);
    }

    // 3. Disabled INVENTORY capability -> 403 with code FEATURE_DISABLED even for ADMIN
    currentCapabilities = {
      ...defaultEnabledCapabilities,
      businessMode: "CATALOG_ONLY",
      inventoryEnabled: false,
      stockTracked: false,
    };

    const disabledGetSupp = await getJson(`${baseUrl}/api/inventory/suppliers`, adminSession);
    assert.equal(disabledGetSupp.status, 403);
    const disabledJson = await disabledGetSupp.json();
    assert.equal(disabledJson.code, "FEATURE_DISABLED");

    const disabledPostPurch = await postJson(`${baseUrl}/api/inventory/purchases`, { payable: "100.00" }, adminSession);
    assert.equal(disabledPostPurch.status, 403);
    const disabledPurchJson = await disabledPostPurch.json();
    assert.equal(disabledPurchJson.code, "FEATURE_DISABLED");

    assert.equal(effectsCalled, false, "Zero database effects must occur during denied requests");
  } finally {
    prisma.authSession.findUnique = originalAuthFindUnique;
    await new Promise((resolve) => server.close(resolve));
  }
});

/* =========================================================================
   TEST 2: ALLOWED DISPATCH, TRUSTED ROLE, NO BODY ESCALATION & SINGLE RESPONSES
   ========================================================================= */

test("controller dispatch: trusted actor role from session, body escalation rejected, single responses {supplier}/{receipt}/{payment}", async () => {
  const currentCapabilities = { ...defaultEnabledCapabilities };

  const app = express();
  app.use(express.json());
  app.use(
    "/api/inventory",
    requireBusinessCapability("INVENTORY", async () => currentCapabilities),
    inventoryRoutes
  );

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const adminSession = createTestSession({ id: "admin-1", role: "ADMIN" });
  const managerSession = createTestSession({ id: "mgr-1", role: "MANAGER" });

  const sessionsMap = new Map<string, any>([
    [adminSession.sessionRecord.tokenHash, adminSession.sessionRecord],
    [managerSession.sessionRecord.tokenHash, managerSession.sessionRecord],
  ]);

  const originalAuthFindUnique = prisma.authSession.findUnique;
  const originalTx = prisma.$transaction;
  const originalSupplier = (prisma as any).supplier;
  const originalBatch = (prisma as any).stockReceiveBatch;
  const originalPayment = (prisma as any).supplierPayment;

  try {
    prisma.authSession.findUnique = (async ({ where }: any) => {
      return sessionsMap.get(where.tokenHash) || null;
    }) as any;

    let capturedActorRole: string | undefined;
    let capturedActorId: string | undefined;

    // 1. Body escalation attempt: extra actorRole / user fields rejected by strict schema before effects
    const escalationAttempt = await postJson(
      `${baseUrl}/api/inventory/purchases`,
      {
        supplierId: "supp-1",
        payable: "100.00",
        operationKey: "op-esc-1",
        actorRole: "ADMIN", // Forbidden extra field
        lines: [
          {
            productId: "prod-1",
            inputUnit: "PIECE",
            inputQty: "1",
            unitAcquisitionCost: "100.00",
          },
        ],
      },
      managerSession
    );
    assert.equal(escalationAttempt.status, 400, "Extra actorRole field in body must be rejected with 400");
    const escJson = await escalationAttempt.json();
    assert.ok(escJson.error || escJson.details);

    // 2. Extra user field in supplier create rejected
    const supplierEscalation = await postJson(
      `${baseUrl}/api/inventory/suppliers`,
      {
        name: "Test Supplier",
        user: { role: "ADMIN" }, // Forbidden extra field
      },
      managerSession
    );
    assert.equal(supplierEscalation.status, 400, "Extra user field in supplier body must be rejected with 400");

    // 3. Allowed supplier creation: returns single response { supplier } with status 201
    (prisma as any).$transaction = async (fn: any) => {
      return fn({
        supplier: {
          create: async ({ data }: any) => ({
            id: "supp-100",
            ...data,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        auditLog: {
          create: async ({ data }: any) => {
            capturedActorId = data.actorId;
            return { id: "audit-1", ...data };
          },
        },
      });
    };

    const suppCreateRes = await postJson(
      `${baseUrl}/api/inventory/suppliers`,
      {
        name: "Valid Supplier",
        contact: "Contact Person",
        phone: "9800000000",
      },
      managerSession
    );
    assert.equal(suppCreateRes.status, 201);
    const suppJson = await suppCreateRes.json();
    assert.ok(suppJson.supplier, "Response must be { supplier }");
    assert.equal(suppJson.supplier.id, "supp-100");
    assert.equal(capturedActorId, "mgr-1", "Actor ID must be taken strictly from req.user.id");

    // 4. Allowed purchase creation: dispatches with trusted role from session (MANAGER)
    let purchaseTxExecuted = false;
    (prisma as any).$transaction = async (fn: any) => {
      purchaseTxExecuted = true;
      return fn({
        $queryRaw: async () => [],
        stockReceiveBatch: {
          findUnique: async () => null,
          create: async ({ data }: any) => ({
            id: "batch-100",
            ...data,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        supplier: {
          findUnique: async () => ({ id: "supp-1", name: "Supplier", isActive: true }),
        },
        product: {
          findMany: async () => [
            { id: "prod-1", name: "P1", sku: "SKU1", saleUnit: "PIECE", isActive: true, stock: 10 },
          ],
          update: async () => ({ id: "prod-1" }),
        },
        stockReceiveBatchItem: { create: async () => ({ id: "item-1" }) },
        stockTransaction: { create: async () => ({ id: "stx-1" }) },
        auditLog: { create: async () => ({ id: "audit-1" }) },
        document: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
      });
    };

    (prisma as any).stockReceiveBatch = {
      findUnique: async ({ where }: any) => {
        if (where?.operationKey) return null;
        return {
          id: "batch-100",
          supplierId: "supp-1",
          payable: new Prisma.Decimal("100.00"),
          postedAt: new Date(),
          supplierName: "Supplier",
          createdAt: new Date(),
          updatedAt: new Date(),
          items: [],
          payments: [],
          transactions: [],
          createdBy: { id: "admin-1", name: "Admin" },
          supplier: { id: "supp-1", name: "Supplier" },
        };
      },
    };
    (prisma as any).document = { findMany: async () => [] };

    const validPurchRes = await postJson(
      `${baseUrl}/api/inventory/purchases`,
      {
        supplierId: "supp-1",
        payable: "100.00",
        operationKey: "op-mgr-100",
        lines: [
          {
            productId: "prod-1",
            inputUnit: "PIECE",
            inputQty: "2",
            conversionFactor: "1",
            unitAcquisitionCost: "50.00",
          },
        ],
      },
      managerSession
    );
    assert.equal(validPurchRes.status, 201);
    assert.equal(purchaseTxExecuted, true, "Transaction must be executed for authorized MANAGER purchase receipt");
    const purchJson = await validPurchRes.json();
    assert.ok(purchJson.receipt, "Response must be { receipt }");
    assert.equal(purchJson.receipt.id, "batch-100");
    assert.equal(purchJson.receipt.payable, "100.00");

    // 5. GET /purchases/:id returns single response { receipt }
    const getDetailRes = await getJson(`${baseUrl}/api/inventory/purchases/batch-100`, adminSession);
    assert.equal(getDetailRes.status, 200);
    const detailJson = await getDetailRes.json();
    assert.ok(detailJson.receipt, "Response must be { receipt }");
    assert.equal(detailJson.receipt.id, "batch-100");

    // 6. POST /purchases/:id/installments returns single response { payment } with status 201
    let installmentTxExecuted = false;
    (prisma as any).$transaction = async (fn: any) => {
      installmentTxExecuted = true;
      return fn({
        $queryRaw: async () => [],
        stockReceiveBatch: {
          findUnique: async () => ({
            id: "batch-100",
            supplierId: "supp-1",
            payable: new Prisma.Decimal("100.00"),
            postedAt: new Date(),
          }),
        },
        supplierPayment: {
          findUnique: async () => null,
          findMany: async () => [],
          create: async ({ data }: any) => ({
            id: "pay-100",
            ...data,
            createdAt: new Date(),
            voidedAt: null,
            voidedById: null,
            voidReason: null,
          }),
        },
        auditLog: { create: async () => ({ id: "audit-pay-1" }) },
      });
    };
    (prisma as any).supplierPayment = {
      findUnique: async ({ where }: any) => {
        // Pre-transaction replay check queries by operationKey -> returns null before create
        if (where?.operationKey) return null;
        // Post-transaction DTO resolution queries by id -> returns synthetic committed payment
        if (where?.id === "pay-100") {
          return {
            id: "pay-100",
            batchId: "batch-100",
            amount: new Prisma.Decimal("50.00"),
            method: "CASH",
            reference: null,
            paidAt: new Date(),
            createdById: "mgr-1",
            createdAt: new Date(),
            voidedAt: null,
            voidedById: null,
            voidReason: null,
          };
        }
        return null;
      },
    };

    const instRes = await postJson(
      `${baseUrl}/api/inventory/purchases/batch-100/installments`,
      {
        amount: "50.00",
        method: "CASH",
        paidAt: "2026-10-09",
        operationKey: "op-pay-100",
      },
      managerSession
    );
    assert.equal(instRes.status, 201);
    assert.equal(installmentTxExecuted, true, "Transaction must be executed for authorized installment");
    const instJson = await instRes.json();
    assert.ok(instJson.payment, "Response must be { payment }");
    assert.equal(instJson.payment.id, "pay-100");
    assert.equal(instJson.payment.amount, "50.00");

    // 7. POST /purchase-installments/:id/void returns single response { payment }
    (prisma as any).$transaction = async (fn: any) => {
      return fn({
        $queryRaw: async () => [],
        stockReceiveBatch: {
          findUnique: async () => ({
            id: "batch-100",
            supplierId: "supp-1",
            payable: new Prisma.Decimal("100.00"),
            postedAt: new Date(),
          }),
        },
        supplierPayment: {
          findUnique: async () => ({
            id: "pay-100",
            batchId: "batch-100",
            amount: new Prisma.Decimal("50.00"),
            method: "CASH",
            reference: null,
            paidAt: new Date(),
            createdById: "admin-1",
            createdAt: new Date(),
            voidedAt: null,
            voidedById: null,
            voidReason: null,
          }),
          update: async ({ data }: any) => ({
            id: "pay-100",
            batchId: "batch-100",
            amount: new Prisma.Decimal("50.00"),
            method: "CASH",
            reference: null,
            paidAt: new Date(),
            createdById: "admin-1",
            createdAt: new Date(),
            voidedAt: new Date(),
            voidedById: "admin-1",
            voidReason: data.voidReason,
          }),
        },
        auditLog: { create: async () => ({ id: "audit-void-1" }) },
      });
    };

    const voidRes = await postJson(
      `${baseUrl}/api/inventory/purchase-installments/pay-100/void`,
      { voidReason: "Entered by mistake" },
      adminSession
    );
    assert.equal(voidRes.status, 200);
    const voidJson = await voidRes.json();
    assert.ok(voidJson.payment, "Response must be { payment }");
    assert.equal(voidJson.payment.isVoided, true);
    assert.equal(voidJson.payment.voidReason, "Entered by mistake");

    // 8. PATCH /suppliers/:id and POST /suppliers/:id/deactivate return { supplier }
    (prisma as any).$transaction = async (fn: any) => {
      return fn({
        $queryRaw: async () => [],
        supplier: {
          findUnique: async () => ({
            id: "supp-1",
            name: "Supplier",
            contact: "Old Contact",
            phone: "9800000000",
            panNo: null,
            address: null,
            isActive: true,
          }),
          update: async ({ data }: any) => ({
            id: "supp-1",
            name: "Supplier",
            contact: data.contact ?? "Old Contact",
            phone: "9800000000",
            panNo: null,
            address: null,
            isActive: data.isActive ?? true,
          }),
        },
        auditLog: { create: async () => ({ id: "audit-supp-upd" }) },
      });
    };

    const patchSuppRes = await patchJson(
      `${baseUrl}/api/inventory/suppliers/supp-1`,
      { contact: "Updated Contact" },
      adminSession
    );
    assert.equal(patchSuppRes.status, 200);
    const patchSuppJson = await patchSuppRes.json();
    assert.ok(patchSuppJson.supplier, "Response must be { supplier }");
    assert.equal(patchSuppJson.supplier.contact, "Updated Contact");

    const deactSuppRes = await postJson(
      `${baseUrl}/api/inventory/suppliers/supp-1/deactivate`,
      {},
      adminSession
    );
    assert.equal(deactSuppRes.status, 200);
    const deactSuppJson = await deactSuppRes.json();
    assert.ok(deactSuppJson.supplier, "Response must be { supplier }");
  } finally {
    prisma.authSession.findUnique = originalAuthFindUnique;
    prisma.$transaction = originalTx;
    (prisma as any).supplier = originalSupplier;
    (prisma as any).stockReceiveBatch = originalBatch;
    (prisma as any).supplierPayment = originalPayment;
    await new Promise((resolve) => server.close(resolve));
  }
});

/* =========================================================================
   TEST 3: MALFORMED BODY & QUERY REJECTED BEFORE EFFECTS (400)
   ========================================================================= */

test("malformed requests: invalid dates, negative amounts, scientific notation, short void reasons, and invalid queries rejected with 400 before effects", async () => {
  const currentCapabilities = { ...defaultEnabledCapabilities };

  const app = express();
  app.use(express.json());
  app.use(
    "/api/inventory",
    requireBusinessCapability("INVENTORY", async () => currentCapabilities),
    inventoryRoutes
  );

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const adminSession = createTestSession({ id: "admin-1", role: "ADMIN" });
  const sessionsMap = new Map<string, any>([
    [adminSession.sessionRecord.tokenHash, adminSession.sessionRecord],
  ]);

  const originalAuthFindUnique = prisma.authSession.findUnique;
  let effectsTriggered = false;

  try {
    prisma.authSession.findUnique = (async ({ where }: any) => {
      return sessionsMap.get(where.tokenHash) || null;
    }) as any;

    (prisma as any).$transaction = async () => {
      effectsTriggered = true;
      throw new Error("Should not enter transaction on invalid inputs");
    };

    // 1. Invalid calendar date (Feb 31st)
    const badDateRes = await postJson(
      `${baseUrl}/api/inventory/purchases`,
      {
        supplierId: "supp-1",
        billDate: "2026-02-31", // Non-existent date
        payable: "100.00",
        operationKey: "op-bad-date",
        lines: [{ productId: "p1", inputUnit: "PIECE", inputQty: "1", conversionFactor: "1", unitAcquisitionCost: "100.00" }],
      },
      adminSession
    );
    assert.equal(badDateRes.status, 400);

    // 2. Scientific notation in payable
    const badPayableRes = await postJson(
      `${baseUrl}/api/inventory/purchases`,
      {
        supplierId: "supp-1",
        payable: "1e5", // Scientific notation
        operationKey: "op-sci",
        lines: [{ productId: "p1", inputUnit: "PIECE", inputQty: "1", conversionFactor: "1", unitAcquisitionCost: "100.00" }],
      },
      adminSession
    );
    assert.equal(badPayableRes.status, 400);

    // 3. Negative quantity in lines
    const badQtyRes = await postJson(
      `${baseUrl}/api/inventory/purchases`,
      {
        supplierId: "supp-1",
        payable: "100.00",
        operationKey: "op-neg-qty",
        lines: [{ productId: "p1", inputUnit: "PIECE", inputQty: "-5", conversionFactor: "1", unitAcquisitionCost: "100.00" }],
      },
      adminSession
    );
    assert.equal(badQtyRes.status, 400);

    // 4. Empty lines array
    const emptyLinesRes = await postJson(
      `${baseUrl}/api/inventory/purchases`,
      {
        supplierId: "supp-1",
        payable: "100.00",
        operationKey: "op-empty-lines",
        lines: [],
      },
      adminSession
    );
    assert.equal(emptyLinesRes.status, 400);

    // 5. Short void reason (< 3 chars)
    const shortVoidRes = await postJson(
      `${baseUrl}/api/inventory/purchase-installments/pay-1/void`,
      { voidReason: "no" },
      adminSession
    );
    assert.equal(shortVoidRes.status, 400);

    // 6. Invalid query parameter (pageSize > 50)
    const badQueryRes = await getJson(`${baseUrl}/api/inventory/purchases?pageSize=100`, adminSession);
    assert.equal(badQueryRes.status, 400);

    // 7. Invalid boolean parameter for suppliers
    const badBoolQueryRes = await getJson(`${baseUrl}/api/inventory/suppliers?includeInactive=maybe`, adminSession);
    assert.equal(badBoolQueryRes.status, 400);

    // 8. Missing required conversionFactor in line
    const missingFactorRes = await postJson(
      `${baseUrl}/api/inventory/purchases`,
      {
        supplierId: "supp-1",
        payable: "100.00",
        operationKey: "op-missing-factor",
        lines: [{ productId: "p1", inputUnit: "PIECE", inputQty: "1", unitAcquisitionCost: "100.00" }],
      },
      adminSession
    );
    assert.equal(missingFactorRes.status, 400);

    // 9. Numeric type coercion rejection (must be bounded decimal string)
    const numPayableRes = await postJson(
      `${baseUrl}/api/inventory/purchases`,
      {
        supplierId: "supp-1",
        payable: 100.0,
        operationKey: "op-num-payable",
        lines: [{ productId: "p1", inputUnit: "PIECE", inputQty: "1", conversionFactor: "1", unitAcquisitionCost: "100.00" }],
      },
      adminSession
    );
    assert.equal(numPayableRes.status, 400);

    // 10. Huge page number query parameter (> 100000)
    const hugePageRes = await getJson(`${baseUrl}/api/inventory/purchases?page=99999999999`, adminSession);
    assert.equal(hugePageRes.status, 400);

    // 11. Locale date & invalid calendar date for paidAt rejected before effects
    const localeDateRes = await postJson(
      `${baseUrl}/api/inventory/purchases/batch-1/installments`,
      {
        amount: "50.00",
        method: "CASH",
        paidAt: "10/09/2026",
        operationKey: "op-locale-date",
      },
      adminSession
    );
    assert.equal(localeDateRes.status, 400);

    const nonExistentDateRes = await postJson(
      `${baseUrl}/api/inventory/purchases/batch-1/installments`,
      {
        amount: "50.00",
        method: "CASH",
        paidAt: "2026-02-31",
        operationKey: "op-bad-cal-date",
      },
      adminSession
    );
    assert.equal(nonExistentDateRes.status, 400);

    assert.equal(effectsTriggered, false, "Database transactions must not be entered for malformed requests");
  } finally {
    prisma.authSession.findUnique = originalAuthFindUnique;
    await new Promise((resolve) => server.close(resolve));
  }
});

/* =========================================================================
   TEST 4: ERROR MAPPING (503 SCHEMA, 409 CONFLICT, 404 NOT FOUND, 500 SAFE)
   ========================================================================= */

test("error mapping: P2021/P2022 mapped to 503 PURCHASE_SCHEMA_UNAVAILABLE, conflict to 409, notfound to 404, unexpected sanitized to 500", async () => {
  const currentCapabilities = { ...defaultEnabledCapabilities };

  const app = express();
  app.use(express.json());
  app.use(
    "/api/inventory",
    requireBusinessCapability("INVENTORY", async () => currentCapabilities),
    inventoryRoutes
  );

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const adminSession = createTestSession({ id: "admin-1", role: "ADMIN" });
  const sessionsMap = new Map<string, any>([
    [adminSession.sessionRecord.tokenHash, adminSession.sessionRecord],
  ]);

  const originalAuthFindUnique = prisma.authSession.findUnique;
  const originalTx = prisma.$transaction;
  const originalBatch = (prisma as any).stockReceiveBatch;

  try {
    prisma.authSession.findUnique = (async ({ where }: any) => {
      return sessionsMap.get(where.tokenHash) || null;
    }) as any;

    const validPayload = {
      supplierId: "supp-1",
      payable: "100.00",
      operationKey: "op-err-test",
      lines: [{ productId: "p1", inputUnit: "PIECE", inputQty: "1", conversionFactor: "1", unitAcquisitionCost: "100.00" }],
    };

    // 1. Prisma P2021 (table does not exist pending migration) -> 503
    (prisma as any).stockReceiveBatch = {
      findUnique: async () => {
        const err: any = new Error("Table khatasathi.StockReceiveBatch doesn't exist");
        err.code = "P2021";
        throw err;
      },
    };

    const schema503Res = await postJson(`${baseUrl}/api/inventory/purchases`, validPayload, adminSession);
    assert.equal(schema503Res.status, 503);
    const schema503Json = await schema503Res.json();
    assert.equal(schema503Json.code, "PURCHASE_SCHEMA_UNAVAILABLE");

    // 2. FinancialPurchaseConflictError -> 409
    (prisma as any).stockReceiveBatch = {
      findUnique: async () => {
        throw new FinancialPurchaseConflictError("Operation key conflict: duplicate key used with different payload");
      },
    };

    const conflict409Res = await postJson(`${baseUrl}/api/inventory/purchases`, validPayload, adminSession);
    assert.equal(conflict409Res.status, 409);
    const conflict409Json = await conflict409Res.json();
    assert.equal(conflict409Json.code, "FINANCIAL_PURCHASE_CONFLICT");

    // 3. Not found -> 404
    (prisma as any).stockReceiveBatch = {
      findUnique: async () => null,
    };
    const notFoundRes = await getJson(`${baseUrl}/api/inventory/purchases/non-existent-batch`, adminSession);
    assert.equal(notFoundRes.status, 404);

    // 4. Unexpected internal error containing raw SQL or credentials -> sanitized to generic 500
    (prisma as any).stockReceiveBatch = {
      findUnique: async () => {
        throw new Error("SELECT * FROM passwords WHERE secret='internal_leak'; internal file path C:/db/secrets.ts");
      },
    };

    const err500Res = await getJson(`${baseUrl}/api/inventory/purchases/batch-crash`, adminSession);
    assert.equal(err500Res.status, 500);
    const err500Json = await err500Res.json();
    assert.equal(err500Json.error, "An unexpected error occurred");
    assert.equal(JSON.stringify(err500Json).includes("SELECT"), false, "SQL must never leak in error response");
    assert.equal(JSON.stringify(err500Json).includes("secret"), false, "Secrets must never leak in error response");

    // 5. Unexpected SQL error containing "not found" or "conflict" keywords -> must NOT leak via 404 or 409, sanitized to 500
    (prisma as any).stockReceiveBatch = {
      findUnique: async () => {
        throw new Error("SELECT * FROM not_found_table WHERE conflict_hash = '123'; path /db/secrets.ts");
      },
    };

    const errLeakRes = await getJson(`${baseUrl}/api/inventory/purchases/batch-leak`, adminSession);
    assert.equal(errLeakRes.status, 500);
    const errLeakJson = await errLeakRes.json();
    assert.equal(errLeakJson.error, "An unexpected error occurred");
    assert.equal(JSON.stringify(errLeakJson).includes("SELECT"), false, "SQL containing not found must never leak");
    assert.equal(JSON.stringify(errLeakJson).includes("secrets"), false, "Path containing conflict must never leak");
  } finally {
    prisma.authSession.findUnique = originalAuthFindUnique;
    prisma.$transaction = originalTx;
    (prisma as any).stockReceiveBatch = originalBatch;
    await new Promise((resolve) => server.close(resolve));
  }
});

/* =========================================================================
   TEST 5: BOUNDED LIST, SAME-WHERE COUNT & NO HASH/COST LEAKS
   ========================================================================= */

test("bounded list: returns {items,total,page,pageSize,totalPages}, preserves legacy unknown nulls, and leaks no hashes or raw costs", async () => {
  const currentCapabilities = { ...defaultEnabledCapabilities };

  const app = express();
  app.use(express.json());
  app.use(
    "/api/inventory",
    requireBusinessCapability("INVENTORY", async () => currentCapabilities),
    inventoryRoutes
  );

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const adminSession = createTestSession({ id: "admin-1", role: "ADMIN" });
  const sessionsMap = new Map<string, any>([
    [adminSession.sessionRecord.tokenHash, adminSession.sessionRecord],
  ]);

  const originalAuthFindUnique = prisma.authSession.findUnique;
  const originalBatch = (prisma as any).stockReceiveBatch;
  const originalSupplier = (prisma as any).supplier;

  try {
    prisma.authSession.findUnique = (async ({ where }: any) => {
      return sessionsMap.get(where.tokenHash) || null;
    }) as any;

    let capturedWhereFindMany: any;
    let capturedWhereCount: any;

    const mockBatches = [
      {
        id: "batch-fin-1",
        supplierId: "supp-1",
        supplierName: "Alpha Supplier",
        billNumber: "BILL-001",
        billDate: new Date("2026-10-09"),
        payable: new Prisma.Decimal("1000.00"),
        postedAt: new Date("2026-10-09T08:00:00Z"),
        operationKey: "secret-op-key-1",
        payloadHash: "secret-hash-111111111111111111111111111111111111111111111111111111111111",
        createdAt: new Date("2026-10-09T08:00:00Z"),
        supplier: { id: "supp-1", name: "Alpha Supplier" },
        payments: [
          { id: "p1", amount: new Prisma.Decimal("400.00"), voidedAt: null },
          { id: "p2", amount: new Prisma.Decimal("100.00"), voidedAt: new Date() }, // Voided payment
        ],
      },
      {
        id: "batch-leg-2",
        supplierId: null, // Legacy batch: no supplier association, no payable authority
        supplierName: "Legacy Vendor",
        billNumber: "LEG-002",
        billDate: null,
        payable: null,
        postedAt: null,
        operationKey: null,
        payloadHash: null,
        createdAt: new Date("2026-10-08T08:00:00Z"),
        supplier: null,
        payments: [],
      },
      {
        id: "batch-renamed-3",
        supplierId: "supp-1",
        supplierName: "Alpha Original Stored", // Stored snapshot name
        billNumber: "BILL-003",
        billDate: new Date("2026-10-09"),
        payable: new Prisma.Decimal("300.00"),
        postedAt: new Date("2026-10-09T08:00:00Z"),
        operationKey: "secret-op-key-3",
        payloadHash: "secret-hash-333333333333333333333333333333333333333333333333333333333333",
        createdAt: new Date("2026-10-09T08:00:00Z"),
        supplier: { id: "supp-1", name: "Renamed Mutable Supplier" }, // Later renamed supplier
        payments: [],
      },
      {
        id: "batch-partial-4",
        supplierId: "supp-1",
        supplierName: "Partial Vendor",
        billNumber: "PART-004",
        billDate: null,
        payable: new Prisma.Decimal("500.00"),
        postedAt: null, // Incomplete/partial: postedAt is null
        operationKey: null,
        payloadHash: null,
        createdAt: new Date("2026-10-08T08:00:00Z"),
        supplier: { id: "supp-1", name: "Partial Vendor" },
        payments: [],
      },
    ];

    (prisma as any).stockReceiveBatch = {
      findMany: async ({ where, skip, take, orderBy }: any) => {
        capturedWhereFindMany = where;
        return mockBatches;
      },
      count: async ({ where }: any) => {
        capturedWhereCount = where;
        return mockBatches.length;
      },
    };

    const listRes = await getJson(`${baseUrl}/api/inventory/purchases?page=1&pageSize=20&kind=ALL`, adminSession);
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();

    // Verify response envelope: { items, total, page, pageSize, totalPages }
    assert.ok(Array.isArray(listJson.items));
    assert.equal(listJson.total, 4);
    assert.equal(listJson.page, 1);
    assert.equal(listJson.pageSize, 20);
    assert.equal(listJson.totalPages, 1);

    // Verify exact same where clause used for count and findMany
    assert.deepEqual(capturedWhereFindMany, capturedWhereCount, "Exact same where clause must be used for count and list");

    // Inspect Financial item
    const finItem = listJson.items[0];
    assert.equal(finItem.id, "batch-fin-1");
    assert.equal(finItem.supplierId, "supp-1");
    assert.equal(finItem.capturedSupplierName, "Alpha Supplier");
    assert.equal(finItem.payable, "1000.00");
    assert.equal(finItem.paid, "400.00", "Voided payment must not be included in paid sum");
    assert.equal(finItem.due, "600.00");
    assert.equal(finItem.paymentStatus, "PARTIAL");
    assert.equal(finItem.isFinancial, true);
    assert.equal(finItem.knownPayable, true);

    // Inspect Legacy item: unknown balances are null, NEVER 0
    const legItem = listJson.items[1];
    assert.equal(legItem.id, "batch-leg-2");
    assert.equal(legItem.isFinancial, false);
    assert.equal(legItem.knownPayable, false);
    assert.equal(legItem.payable, null);
    assert.equal(legItem.paid, null, "Legacy paid balance must be null, never 0");
    assert.equal(legItem.due, null, "Legacy due balance must be null, never 0");
    assert.equal(legItem.paymentStatus, "LEGACY");

    // Inspect Changed supplier item: capturedSupplierName uses stored batch.supplierName first, not mutable supplier.name
    const renamedItem = listJson.items[2];
    assert.equal(renamedItem.id, "batch-renamed-3");
    assert.equal(renamedItem.capturedSupplierName, "Alpha Original Stored", "capturedSupplierName must prefer stored batch.supplierName");

    // Inspect Partial posted item: postedAt is null -> classified as LEGACY, unknown balances null
    const partialItem = listJson.items[3];
    assert.equal(partialItem.id, "batch-partial-4");
    assert.equal(partialItem.isFinancial, false, "Batch with null postedAt must not be classified as financial");
    assert.equal(partialItem.knownPayable, false);
    assert.equal(partialItem.payable, null);
    assert.equal(partialItem.paid, null);
    assert.equal(partialItem.due, null);
    assert.equal(partialItem.paymentStatus, "LEGACY");

    // Verify privacy: no raw hashes, operation keys, or internal storage paths leaked
    const jsonStr = JSON.stringify(listJson);
    assert.equal(jsonStr.includes("secret-op-key-1"), false, "Operation keys must not leak in list DTO");
    assert.equal(jsonStr.includes("secret-hash-1111111"), false, "Payload hashes must not leak in list DTO");
    assert.equal(jsonStr.includes("storedPath"), false, "Storage paths must not leak in list DTO");

    // 2. Test legacy projection: strip ONLY new financial authority scalars from legacy service returns
    (prisma as any).stockReceiveBatch = {
      findUnique: async () => ({
        id: "batch-legacy-row",
        supplierName: "Legacy Warehouse",
        billNumber: "LEG-WH-1",
        billDate: null,
        billAmount: null,
        remarks: "Old receipt",
        supplierId: "supp-leak-check",
        payable: new Prisma.Decimal("999.00"),
        postedAt: new Date(),
        operationKey: "op-leak-check",
        payloadHash: "hash-leak-check",
        createdById: "admin-1",
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: { id: "admin-1", name: "Admin" },
        transactions: [],
      }),
    };
    (prisma as any).auditLog = {
      findFirst: async () => null,
    };

    const legacyDetail = await getStockReceiveBatchById("batch-legacy-row");
    assert.equal((legacyDetail as any).supplierId, undefined, "supplierId stripped from legacy batch return");
    assert.equal((legacyDetail as any).payable, undefined, "payable stripped from legacy batch return");
    assert.equal((legacyDetail as any).postedAt, undefined, "postedAt stripped from legacy batch return");
    assert.equal((legacyDetail as any).operationKey, undefined, "operationKey stripped from legacy batch return");
    assert.equal((legacyDetail as any).payloadHash, undefined, "payloadHash stripped from legacy batch return");
    assert.equal(legacyDetail.supplierName, "Legacy Warehouse", "legacy fields preserved");

    // 3. Test Supplier list envelope: { suppliers, total, page, pageSize, totalPages }
    (prisma as any).supplier = {
      findMany: async () => [{ id: "s1", name: "Supp 1", isActive: true }],
      count: async () => 1,
    };
    const suppListRes = await getJson(`${baseUrl}/api/inventory/suppliers?includeInactive=false`, adminSession);
    assert.equal(suppListRes.status, 200);
    const suppListJson = await suppListRes.json();
    assert.ok(Array.isArray(suppListJson.suppliers));
    assert.equal(suppListJson.total, 1);
    assert.equal(suppListJson.pageSize, 20);
    assert.equal(suppListJson.totalPages, 1);
  } finally {
    prisma.authSession.findUnique = originalAuthFindUnique;
    (prisma as any).stockReceiveBatch = originalBatch;
    (prisma as any).supplier = originalSupplier;
    await new Promise((resolve) => server.close(resolve));
  }
});
