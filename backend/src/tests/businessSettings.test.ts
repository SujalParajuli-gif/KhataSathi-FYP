import test from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import prisma from "../db/prisma";
import {
  BusinessSettingsValidationError,
  getBusinessSettings,
  invalidateBusinessSettingsCache,
  normalizeBusinessSettingsInput,
  normalizeBusinessSettingsPatch,
  updateBusinessSettings,
  type BusinessSettingsSnapshot,
} from "../modules/settings/service";
import {
  getBusinessDefaults,
  updateBusinessDefaults,
} from "../modules/settings/controller";
import { denyStaff, requireRole } from "../middleware/rbac";

test("business defaults patch preserves omitted values instead of recreating defaults", () => {
  assert.deepEqual(normalizeBusinessSettingsPatch({ returnWindowDays: 14 }), {
    returnWindowDays: 14,
  });
});

test("business defaults accept fractional stock quantities and bounded loyalty", () => {
  assert.deepEqual(
    normalizeBusinessSettingsPatch({
      defaultInitialStock: 2.5,
      defaultLowStockThreshold: 0.5,
      defaultWholesaleQtyThreshold: 12.5,
      loyaltyDiscountPercent: 10,
    }),
    {
      defaultInitialStock: 2.5,
      defaultLowStockThreshold: 0.5,
      defaultWholesaleQtyThreshold: 12.5,
      loyaltyDiscountPercent: 10,
    },
  );
});

test("business defaults reject silent clamping and fractional duration values", () => {
  assert.throws(
    () => normalizeBusinessSettingsPatch({ loyaltyDiscountPercent: 101 }),
    BusinessSettingsValidationError,
  );
  assert.throws(
    () => normalizeBusinessSettingsPatch({ parkedBillExpiryHours: 1.5 }),
    /whole number/,
  );
});

test("complete business defaults still receive safe creation defaults", () => {
  assert.deepEqual(normalizeBusinessSettingsInput({}), {
    defaultInitialStock: 30,
    defaultLowStockThreshold: 5,
    defaultWholesaleQtyThreshold: 15,
    loyaltyDiscountPercent: 2,
    returnWindowDays: 7,
    parkedBillExpiryHours: 8,
    draftRequestExpiryMinutes: 30,
  });
});

test("business defaults patch normalizes and trims all five identity fields", () => {
  const result = normalizeBusinessSettingsPatch({
    businessName: "  KhataSathi Retail Store  ",
    legalName: "  KhataSathi Enterprises Pvt. Ltd.  ",
    panNo: "  123456789  ",
    businessAddress: "  Ward 4, New Road, Kathmandu, Nepal  ",
    businessPhone: "  +977-1-4234567  ",
  });

  assert.deepEqual(result, {
    businessName: "KhataSathi Retail Store",
    legalName: "KhataSathi Enterprises Pvt. Ltd.",
    panNo: "123456789",
    businessAddress: "Ward 4, New Road, Kathmandu, Nepal",
    businessPhone: "+977-1-4234567",
  });
});

test("business defaults patch preserves leading zeros on PAN without numeric coercion", () => {
  const result = normalizeBusinessSettingsPatch({
    panNo: "  001234567  ",
  });

  assert.equal(result.panNo, "001234567");
  assert.notEqual(result.panNo, "1234567");
});

test("business defaults patch normalizes empty strings and whitespace-only text to null", () => {
  const result = normalizeBusinessSettingsPatch({
    businessName: "",
    legalName: "   ",
    panNo: "\t\n  ",
    businessAddress: "  ",
    businessPhone: "",
  });

  assert.deepEqual(result, {
    businessName: null,
    legalName: null,
    panNo: null,
    businessAddress: null,
    businessPhone: null,
  });
});

test("business defaults patch accepts explicit null to clear identity fields", () => {
  const result = normalizeBusinessSettingsPatch({
    businessName: null,
    legalName: null,
    panNo: null,
    businessAddress: null,
    businessPhone: null,
  });

  assert.deepEqual(result, {
    businessName: null,
    legalName: null,
    panNo: null,
    businessAddress: null,
    businessPhone: null,
  });
});

test("business defaults patch omits unsupplied identity fields to preserve existing values", () => {
  const result = normalizeBusinessSettingsPatch({
    businessName: "Updated Name",
  });

  assert.equal(result.businessName, "Updated Name");
  assert.equal("legalName" in result, false);
  assert.equal("panNo" in result, false);
  assert.equal("businessAddress" in result, false);
  assert.equal("businessPhone" in result, false);
});

test("business defaults patch rejects non-text values with field-specific validation errors", () => {
  assert.throws(
    () => normalizeBusinessSettingsPatch({ panNo: 123456789 as any }),
    (err: any) => err instanceof BusinessSettingsValidationError && err.field === "panNo" && /text/.test(err.message),
  );

  assert.throws(
    () => normalizeBusinessSettingsPatch({ businessPhone: 9841234567 as any }),
    (err: any) => err instanceof BusinessSettingsValidationError && err.field === "businessPhone" && /text/.test(err.message),
  );

  assert.throws(
    () => normalizeBusinessSettingsPatch({ businessName: true as any }),
    (err: any) => err instanceof BusinessSettingsValidationError && err.field === "businessName" && /text/.test(err.message),
  );

  assert.throws(
    () => normalizeBusinessSettingsPatch({ legalName: ["Acme"] as any }),
    (err: any) => err instanceof BusinessSettingsValidationError && err.field === "legalName" && /text/.test(err.message),
  );

  assert.throws(
    () => normalizeBusinessSettingsPatch({ businessAddress: { street: "Road" } as any }),
    (err: any) => err instanceof BusinessSettingsValidationError && err.field === "businessAddress" && /text/.test(err.message),
  );
});

test("business defaults patch rejects oversized VARCHAR(191) fields", () => {
  const oversized192 = "a".repeat(192);

  for (const field of ["businessName", "legalName", "panNo", "businessPhone"] as const) {
    assert.throws(
      () => normalizeBusinessSettingsPatch({ [field]: oversized192 }),
      (err: any) =>
        err instanceof BusinessSettingsValidationError &&
        err.field === field &&
        /cannot exceed 191 characters/.test(err.message),
    );
  }

  // Exact 191 ASCII chars is allowed
  const exact191 = "a".repeat(191);
  const result = normalizeBusinessSettingsPatch({ businessName: exact191 });
  assert.equal(result.businessName, exact191);
});

test("business defaults patch handles supplementary Unicode characters respecting VARCHAR(191) character limits (B-1)", () => {
  // Supplementary characters (e.g. 🌐) are 2 UTF-16 code units each in JS but 1 character in MySQL utf8mb4.
  // 191 supplementary characters = 382 JS code units, but 191 Unicode code points (characters).
  const exact191Supplementary = "🌐".repeat(191);
  const oversized192Supplementary = "🌐".repeat(192);

  for (const field of ["businessName", "legalName", "panNo", "businessPhone"] as const) {
    // 191 characters should pass
    const passResult = normalizeBusinessSettingsPatch({ [field]: exact191Supplementary });
    assert.equal(passResult[field], exact191Supplementary);

    // 192 characters should fail with field-specific 400 validation error
    assert.throws(
      () => normalizeBusinessSettingsPatch({ [field]: oversized192Supplementary }),
      (err: any) =>
        err instanceof BusinessSettingsValidationError &&
        err.field === field &&
        /cannot exceed 191 characters/.test(err.message),
    );
  }
});

test("business defaults patch rejects oversized TEXT businessAddress exceeding 65535 bytes", () => {
  // 65536 bytes of ASCII
  const oversizedAddress = "a".repeat(65_536);
  assert.throws(
    () => normalizeBusinessSettingsPatch({ businessAddress: oversizedAddress }),
    (err: any) =>
      err instanceof BusinessSettingsValidationError &&
      err.field === "businessAddress" &&
      /cannot exceed 65535 bytes/.test(err.message),
  );

  // Multi-byte characters exceeding byte limit even if character count is smaller
  // 20,000 characters of 4-byte emoji = 80,000 bytes
  const multibyteOversized = "🌐".repeat(20_000);
  assert.throws(
    () => normalizeBusinessSettingsPatch({ businessAddress: multibyteOversized }),
    (err: any) =>
      err instanceof BusinessSettingsValidationError &&
      err.field === "businessAddress" &&
      /cannot exceed 65535 bytes/.test(err.message),
  );

  // Exact 65535 bytes is allowed
  const exact65535 = "a".repeat(65_535);
  const result = normalizeBusinessSettingsPatch({ businessAddress: exact65535 });
  assert.equal(result.businessAddress, exact65535);
});

// Helper for mocking Prisma for service tests
async function withPrismaMocks(
  initialRow: Record<string, unknown>,
  run: (ctx: { getRow: () => any; getAuditLogs: () => any[] }) => Promise<void>,
) {
  invalidateBusinessSettingsCache();
  const bsDelegate = prisma.businessSettings as any;
  const auditDelegate = prisma.auditLog as any;
  const originalUpsert = bsDelegate.upsert;
  const originalAuditCreate = auditDelegate.create;
  const originalTransaction = prisma.$transaction;

  let row = {
    id: 1,
    businessMode: "FULL_POS",
    staffDraftRequestsEnabled: true,
    defaultInitialStock: 30,
    defaultLowStockThreshold: 5,
    defaultWholesaleQtyThreshold: 15,
    loyaltyDiscountPercent: 2,
    returnWindowDays: 7,
    parkedBillExpiryHours: 8,
    draftRequestExpiryMinutes: 30,
    overridePinHash: "$2a$10$abcdefg1234567890",
    overridePinUpdatedAt: new Date("2026-01-01"),
    businessName: null,
    legalName: null,
    panNo: null,
    businessAddress: null,
    businessPhone: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...initialRow,
  };
  const auditLogs: any[] = [];

  const mockTx = {
    businessSettings: {
      upsert: async ({ update }: any) => {
        row = { ...row, ...update };
        return { ...row };
      },
    },
    auditLog: {
      create: async ({ data }: any) => {
        auditLogs.push(data);
        return { id: "audit-1", ...data };
      },
    },
  };

  bsDelegate.upsert = async ({ update }: any) => {
    row = { ...row, ...update };
    return { ...row };
  };
  auditDelegate.create = async ({ data }: any) => {
    auditLogs.push(data);
    return { id: "audit-1", ...data };
  };
  (prisma as any).$transaction = async (fn: any) => {
    return fn(mockTx);
  };

  try {
    await run({ getRow: () => row, getAuditLogs: () => auditLogs });
  } finally {
    bsDelegate.upsert = originalUpsert;
    auditDelegate.create = originalAuditCreate;
    (prisma as any).$transaction = originalTransaction;
    invalidateBusinessSettingsCache();
  }
}

test("getBusinessSettings returns identity fields as nullable strings and excludes override PIN internals", async () => {
  await withPrismaMocks(
    {
      businessName: "KhataSathi Store",
      legalName: null,
      panNo: "300123456",
      businessAddress: "Kathmandu",
      businessPhone: null,
      overridePinHash: "$2a$10$supersecretpin",
      overridePinUpdatedAt: new Date("2026-01-01"),
    },
    async () => {
      const settings = await getBusinessSettings();

      assert.equal(settings.businessName, "KhataSathi Store");
      assert.equal(settings.legalName, null);
      assert.equal(settings.panNo, "300123456");
      assert.equal(settings.businessAddress, "Kathmandu");
      assert.equal(settings.businessPhone, null);

      // Verify restricted PIN internals are excluded
      assert.equal("overridePinHash" in settings, false);
      assert.equal("overridePinUpdatedAt" in settings, false);
    },
  );
});

test("getBusinessSettings serves cached snapshot and invalidateBusinessSettingsCache forces reload", async () => {
  let dbReads = 0;
  await withPrismaMocks(
    { businessName: "Initial Business" },
    async (ctx) => {
      const originalUpsert = (prisma.businessSettings as any).upsert;
      (prisma.businessSettings as any).upsert = async (args: any) => {
        dbReads++;
        return originalUpsert(args);
      };

      const first = await getBusinessSettings();
      assert.equal(first.businessName, "Initial Business");
      assert.equal(dbReads, 1);

      // Second read hits cache
      const second = await getBusinessSettings();
      assert.equal(second.businessName, "Initial Business");
      assert.equal(dbReads, 1);

      // Invalidate cache forces re-read
      invalidateBusinessSettingsCache();
      const third = await getBusinessSettings();
      assert.equal(third.businessName, "Initial Business");
      assert.equal(dbReads, 2);
    },
  );
});

test("updateBusinessSettings updates identity fields and preserves numeric defaults and businessMode", async () => {
  await withPrismaMocks(
    {
      businessMode: "FULL_POS",
      defaultInitialStock: 50,
      defaultLowStockThreshold: 10,
      businessName: "Old Shop",
      legalName: "Old Legal Name",
    },
    async (ctx) => {
      const updated = await updateBusinessSettings(
        {
          businessName: "New Shop Name",
          panNo: "009876543",
        },
        "admin-user-1",
      );

      // Identity fields updated
      assert.equal(updated.businessName, "New Shop Name");
      assert.equal(updated.panNo, "009876543");
      // Unspecified fields preserved
      assert.equal(updated.legalName, "Old Legal Name");
      assert.equal(updated.businessMode, "FULL_POS");
      assert.equal(updated.defaultInitialStock, 50);
      assert.equal(updated.defaultLowStockThreshold, 10);

      // Verify DB row
      const row = ctx.getRow();
      assert.equal(row.businessName, "New Shop Name");
      assert.equal(row.panNo, "009876543");
      assert.equal(row.legalName, "Old Legal Name");
      assert.equal(row.defaultInitialStock, 50);

      // Cache should be updated with new values
      const cached = await getBusinessSettings();
      assert.equal(cached.businessName, "New Shop Name");
      assert.equal(cached.panNo, "009876543");
    },
  );
});

test("updateBusinessSettings records only changed fields in auditLog without exposing overridePinHash", async () => {
  await withPrismaMocks(
    {
      businessName: "Original Name",
      legalName: "Original Legal",
      panNo: null,
      overridePinHash: "$2a$10$supersecretpin",
    },
    async (ctx) => {
      await updateBusinessSettings(
        {
          businessName: "Updated Name",
          panNo: "123456789",
        },
        "admin-user-42",
      );

      const logs = ctx.getAuditLogs();
      assert.equal(logs.length, 1);
      assert.equal(logs[0].action, "BUSINESS_DEFAULTS_CHANGED");
      assert.equal(logs[0].actorId, "admin-user-42");
      assert.equal(logs[0].entityType, "BusinessSettings");
      assert.equal(logs[0].entityId, "1");

      const changes = logs[0].meta.changes;
      assert.deepEqual(changes.businessName, {
        before: "Original Name",
        after: "Updated Name",
      });
      assert.deepEqual(changes.panNo, {
        before: null,
        after: "123456789",
      });
      assert.equal("legalName" in changes, false);
      assert.equal("overridePinHash" in changes, false);
      assert.equal("overridePinUpdatedAt" in changes, false);
    },
  );
});

test("updateBusinessSettings performs no write and leaves cache intact when validation fails", async () => {
  await withPrismaMocks(
    { businessName: "Original Business" },
    async (ctx) => {
      // Prime the cache
      const initial = await getBusinessSettings();
      assert.equal(initial.businessName, "Original Business");

      // Attempt invalid update
      await assert.rejects(
        () =>
          updateBusinessSettings(
            {
              businessName: "New Business",
              panNo: 999999 as any, // Invalid non-text PAN
            },
            "admin-1",
          ),
        BusinessSettingsValidationError,
      );

      // Verify database row was NOT modified
      assert.equal(ctx.getRow().businessName, "Original Business");

      // Verify cache was NOT modified
      const cached = await getBusinessSettings();
      assert.equal(cached.businessName, "Original Business");

      // Verify no audit log created
      assert.equal(ctx.getAuditLogs().length, 0);
    },
  );
});

// Helper for controller mocking
type MockResponse = Response & {
  statusCodeValue: number;
  jsonBody?: any;
};

function makeMockResponse(): MockResponse {
  const res: any = {
    statusCodeValue: 200,
    jsonBody: undefined,
    status(code: number) {
      res.statusCodeValue = code;
      return res;
    },
    json(body: unknown) {
      res.jsonBody = body;
      return res;
    },
  };
  return res as MockResponse;
}

function makeMockRequest(user?: { id: string; role: string }, body?: any): Request {
  return {
    user: user || { id: "admin-1", role: "ADMIN" },
    body: body || {},
  } as unknown as Request;
}

test("updateBusinessDefaults controller extracts identity fields and ignores unknown request fields", async () => {
  await withPrismaMocks(
    { businessName: "Old Store" },
    async (ctx) => {
      const req = makeMockRequest(
        { id: "admin-1", role: "ADMIN" },
        {
          businessName: "  Brand New Store  ",
          panNo: "001234567",
          unknownField: "malicious_payload",
          overridePinHash: "cannot_overwrite",
          id: 999,
        },
      );
      const res = makeMockResponse();

      await updateBusinessDefaults(req, res);

      assert.equal(res.statusCodeValue, 200);
      assert.equal(res.jsonBody.businessName, "Brand New Store");
      assert.equal(res.jsonBody.panNo, "001234567");

      // Ensure unknown fields did not mutate anything
      const row = ctx.getRow();
      assert.equal(row.id, 1);
      assert.equal("unknownField" in row, false);
      assert.notEqual(row.overridePinHash, "cannot_overwrite");
    },
  );
});

test("updateBusinessDefaults controller returns 400 with field on validation error", async () => {
  await withPrismaMocks({}, async () => {
    const req = makeMockRequest(
      { id: "admin-1", role: "ADMIN" },
      { panNo: 123456 }, // non-text PAN
    );
    const res = makeMockResponse();

    await updateBusinessDefaults(req, res);

    assert.equal(res.statusCodeValue, 400);
    assert.equal(res.jsonBody.field, "panNo");
    assert.match(res.jsonBody.error, /must be text/);
  });
});

test("business settings routes enforce ADMIN mutation and deny STAFF reads", () => {
  // Test denyStaff blocks STAFF on GET
  const staffReq = makeMockRequest({ id: "staff-1", role: "STAFF" });
  const staffRes = makeMockResponse();
  let staffNextCalled = false;

  denyStaff(staffReq, staffRes, (() => {
    staffNextCalled = true;
  }) as NextFunction);

  assert.equal(staffNextCalled, false);
  assert.equal(staffRes.statusCodeValue, 403);

  // Test denyStaff allows MANAGER and CASHIER
  for (const role of ["ADMIN", "MANAGER", "CASHIER"]) {
    const roleReq = makeMockRequest({ id: "user-1", role });
    const roleRes = makeMockResponse();
    let nextCalled = false;

    denyStaff(roleReq, roleRes, (() => {
      nextCalled = true;
    }) as NextFunction);

    assert.equal(nextCalled, true);
  }

  // Test requireRole("ADMIN") blocks non-ADMIN on PUT
  const requireAdmin = requireRole("ADMIN");

  for (const role of ["MANAGER", "CASHIER", "STAFF"]) {
    const nonAdminReq = makeMockRequest({ id: "user-1", role });
    const nonAdminRes = makeMockResponse();
    let nextCalled = false;

    requireAdmin(nonAdminReq, nonAdminRes, (() => {
      nextCalled = true;
    }) as NextFunction);

    assert.equal(nextCalled, false);
    assert.equal(nonAdminRes.statusCodeValue, 403);
  }

  // Test requireRole("ADMIN") allows ADMIN
  const adminReq = makeMockRequest({ id: "admin-1", role: "ADMIN" });
  const adminRes = makeMockResponse();
  let adminNextCalled = false;

  requireAdmin(adminReq, adminRes, (() => {
    adminNextCalled = true;
  }) as NextFunction);

  assert.equal(adminNextCalled, true);
});
