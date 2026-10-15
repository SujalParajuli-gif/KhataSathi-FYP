import test from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import prisma from "../db/prisma";
import {
  CustomerValidationError,
  CUSTOMER_PAN_VARCHAR_LIMIT,
  CUSTOMER_ADDRESS_TEXT_BYTE_LIMIT,
  parseCustomerPan,
  parseCustomerAddress,
  createCustomer,
  approveCustomerDiscountRequest,
  updateCustomer,
  getCustomer,
  listCustomers,
} from "../modules/customers/service";
import {
  create,
  update,
  createDiscountedByCashier,
  createQuick,
} from "../modules/customers/controller";
import { denyStaff, requireRole } from "../middleware/rbac";

// --- Normalization & Validation Unit Tests ---

test("parseCustomerPan normalizes trimmed text and preserves leading zeros without numeric coercion", () => {
  assert.equal(parseCustomerPan("  001234567  "), "001234567");
  assert.equal(parseCustomerPan("987654321"), "987654321");
});

test("parseCustomerPan normalizes empty and whitespace-only text or null/undefined to null", () => {
  assert.equal(parseCustomerPan(undefined), null);
  assert.equal(parseCustomerPan(null), null);
  assert.equal(parseCustomerPan(""), null);
  assert.equal(parseCustomerPan("   "), null);
  assert.equal(parseCustomerPan("\t\n  "), null);
});

test("parseCustomerPan rejects non-text values with CustomerValidationError", () => {
  for (const invalid of [123456789, true, false, {}, [], { pan: "123" }]) {
    assert.throws(
      () => parseCustomerPan(invalid),
      (err: any) =>
        err instanceof CustomerValidationError &&
        err.field === "panNo" &&
        /must be text/.test(err.message),
    );
  }
});

test("parseCustomerPan enforces VARCHAR(191) character limits for ASCII and supplementary Unicode characters", () => {
  // 191 ASCII chars - passes
  const exact191Ascii = "A".repeat(191);
  assert.equal(parseCustomerPan(exact191Ascii), exact191Ascii);

  // 192 ASCII chars - fails
  assert.throws(
    () => parseCustomerPan("A".repeat(192)),
    (err: any) =>
      err instanceof CustomerValidationError &&
      err.field === "panNo" &&
      /cannot exceed 191 characters/.test(err.message),
  );

  // 191 supplementary characters (e.g. 🌐 = 382 JS code units, but 191 Unicode code points) - passes
  const exact191Unicode = "🌐".repeat(191);
  assert.equal(parseCustomerPan(exact191Unicode), exact191Unicode);

  // 192 supplementary characters - fails
  assert.throws(
    () => parseCustomerPan("🌐".repeat(192)),
    (err: any) =>
      err instanceof CustomerValidationError &&
      err.field === "panNo" &&
      /cannot exceed 191 characters/.test(err.message),
  );
});

test("parseCustomerAddress normalizes trimmed text and empty/null values", () => {
  assert.equal(parseCustomerAddress("  Ward 4, Kathmandu, Nepal  "), "Ward 4, Kathmandu, Nepal");
  assert.equal(parseCustomerAddress(undefined), null);
  assert.equal(parseCustomerAddress(null), null);
  assert.equal(parseCustomerAddress(""), null);
  assert.equal(parseCustomerAddress("   "), null);
});

test("parseCustomerAddress rejects non-text values with CustomerValidationError", () => {
  for (const invalid of [12345, true, {}, ["Address"]]) {
    assert.throws(
      () => parseCustomerAddress(invalid),
      (err: any) =>
        err instanceof CustomerValidationError &&
        err.field === "address" &&
        /must be text/.test(err.message),
    );
  }
});

test("parseCustomerAddress enforces MySQL TEXT 65535 byte capacity", () => {
  // Exact 65535 bytes of ASCII - passes
  const exact65535 = "a".repeat(65_535);
  assert.equal(parseCustomerAddress(exact65535), exact65535);

  // 65536 bytes of ASCII - fails
  assert.throws(
    () => parseCustomerAddress("a".repeat(65_536)),
    (err: any) =>
      err instanceof CustomerValidationError &&
      err.field === "address" &&
      /cannot exceed 65535 bytes/.test(err.message),
  );

  // Multi-byte characters exceeding byte limit even with fewer characters
  // 20,000 characters of 4-byte emoji = 80,000 bytes > 65,535 bytes
  assert.throws(
    () => parseCustomerAddress("🌐".repeat(20_000)),
    (err: any) =>
      err instanceof CustomerValidationError &&
      err.field === "address" &&
      /cannot exceed 65535 bytes/.test(err.message),
  );
});

// --- Service & Database Mock Helpers ---

type MockPrismaCustomerContext = {
  getCustomers: () => any[];
  getAuditLogs: () => any[];
};

async function withCustomerDatabaseMocks(
  initialCustomers: any[],
  run: (ctx: MockPrismaCustomerContext) => Promise<void>,
) {
  const custDelegate = prisma.customer as any;
  const auditDelegate = prisma.auditLog as any;
  const originalTransaction = prisma.$transaction;
  const originalCreate = custDelegate.create;
  const originalUpdate = custDelegate.update;
  const originalFindUnique = custDelegate.findUnique;
  const originalFindMany = custDelegate.findMany;
  const originalAuditCreate = auditDelegate.create;

  let customers = initialCustomers.map((c) => ({
    id: c.id || "cust-1",
    name: c.name || "Default Customer",
    phone: c.phone ?? null,
    email: c.email ?? null,
    loyaltyPercent: c.loyaltyPercent ?? 0,
    wholesalePercent: c.wholesalePercent ?? 0,
    isActive: c.isActive ?? true,
    panNo: c.panNo ?? null,
    address: c.address ?? null,
    createdById: c.createdById ?? null,
    createdByRole: c.createdByRole ?? null,
    createdAt: c.createdAt || new Date("2026-01-01"),
    updatedAt: c.updatedAt || new Date("2026-01-01"),
  }));

  const auditLogs: any[] = [];

  const mockTx = {
    customer: {
      create: async ({ data }: any) => {
        if (data.phone && customers.some((customer) => customer.phone === data.phone)) {
          const error: any = new Error("Unique constraint failed on phone");
          error.code = "P2002";
          throw error;
        }
        const created = {
          id: `cust-${customers.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        customers.push(created);
        return created;
      },
    },
    auditLog: {
      create: async ({ data }: any) => {
        auditLogs.push(data);
        return { id: `audit-${auditLogs.length + 1}`, ...data };
      },
    },
  };

  custDelegate.create = mockTx.customer.create;
  custDelegate.update = async ({ where, data }: any) => {
    const idx = customers.findIndex((c) => c.id === where.id);
    if (idx === -1) {
      const err: any = new Error("Record to update not found.");
      err.code = "P2025";
      throw err;
    }
    customers[idx] = { ...customers[idx], ...data, updatedAt: new Date() };
    return customers[idx];
  };
  custDelegate.findUnique = async ({ where }: any) => {
    return customers.find((c) => c.id === where.id) || null;
  };
  custDelegate.findMany = async () => {
    return customers.map((c) => ({ ...c, _count: { invoices: 0 }, invoices: [] }));
  };
  auditDelegate.create = mockTx.auditLog.create;
  (prisma as any).$transaction = async (fn: any) => fn(mockTx);

  try {
    await run({
      getCustomers: () => customers,
      getAuditLogs: () => auditLogs,
    });
  } finally {
    custDelegate.create = originalCreate;
    custDelegate.update = originalUpdate;
    custDelegate.findUnique = originalFindUnique;
    custDelegate.findMany = originalFindMany;
    auditDelegate.create = originalAuditCreate;
    (prisma as any).$transaction = originalTransaction;
  }
}

// --- Service Create & Update Tests ---

test("createCustomer sets panNo and address, preserving leading-zero PAN and audit log", async () => {
  await withCustomerDatabaseMocks([], async (ctx) => {
    const created = await createCustomer({
      name: "Sita Enterprises",
      phone: "+9779811111111",
      panNo: "001234567",
      address: "Biratnagar-3, Morang",
      createdById: "admin-1",
      createdByRole: "ADMIN",
    });

    assert.equal(created.name, "Sita Enterprises");
    assert.equal(created.panNo, "001234567");
    assert.equal(created.address, "Biratnagar-3, Morang");

    const audit = ctx.getAuditLogs();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, "CUSTOMER_CREATED");
    assert.equal(audit[0].actorId, "admin-1");
  });
});

test("createCustomer stores omitted panNo and address as null", async () => {
  await withCustomerDatabaseMocks([], async () => {
    const created = await createCustomer({
      name: "Walk-in Buyer",
      createdById: "admin-1",
      createdByRole: "ADMIN",
    });

    assert.equal(created.panNo, null);
    assert.equal(created.address, null);
  });
});

test("cashier nondiscount customer audit uses the ordinary customer-created action", async () => {
  await withCustomerDatabaseMocks([], async (ctx) => {
    const created = await createCustomer({
      name: "Quick Customer",
      createdById: "cashier-1",
      createdByRole: "CASHIER",
    });
    assert.equal(created.loyaltyPercent, 0);
    assert.equal(created.wholesalePercent, 0);
    assert.equal(ctx.getAuditLogs()[0].action, "CUSTOMER_CREATED");

    await createCustomer({
      name: "Discounted Customer",
      loyaltyPercent: 5,
      createdById: "cashier-1",
      createdByRole: "CASHIER",
    });
    assert.equal(ctx.getAuditLogs()[1].action, "CUSTOMER_DISCOUNT_CREATED_BY_CASHIER");
  });
});

test("updateCustomer updates panNo and address while preserving omitted fields and other state", async () => {
  await withCustomerDatabaseMocks(
    [
      {
        id: "c-100",
        name: "Ram Trading",
        phone: "+9779800000000",
        loyaltyPercent: 5,
        wholesalePercent: 10,
        panNo: "111222333",
        address: "Old Address",
        isActive: true,
      },
    ],
    async (ctx) => {
      // Update panNo only; address and name/discounts omitted
      const updated = await updateCustomer("c-100", {
        panNo: "009988776",
      });

      assert.equal(updated.panNo, "009988776");
      // Omitted address preserved
      assert.equal(updated.address, "Old Address");
      // Other customer state preserved
      assert.equal(updated.name, "Ram Trading");
      assert.equal(updated.phone, "+9779800000000");
      assert.equal(updated.loyaltyPercent, 5);
      assert.equal(updated.wholesalePercent, 10);
      assert.equal(updated.isActive, true);
    },
  );
});

test("updateCustomer explicitly clears panNo and address to null when given empty string or null", async () => {
  await withCustomerDatabaseMocks(
    [
      {
        id: "c-101",
        name: "Gita Store",
        panNo: "123456789",
        address: "Pokhara-8",
      },
    ],
    async () => {
      // Clear panNo with null, address with empty string
      const updated = await updateCustomer("c-101", {
        panNo: null,
        address: "   ",
      });

      assert.equal(updated.panNo, null);
      assert.equal(updated.address, null);
    },
  );
});

// --- Controller HTTP Tests ---

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

function makeMockRequest(user?: { id: string; role: string }, body?: any, params?: any): Request {
  return {
    user: user || { id: "admin-1", role: "ADMIN" },
    body: body || {},
    params: params || {},
    query: {},
  } as unknown as Request;
}

test("create controller sets panNo and address and ignores unknown request fields", async () => {
  await withCustomerDatabaseMocks([], async (ctx) => {
    const req = makeMockRequest(
      { id: "admin-1", role: "ADMIN" },
      {
        name: "Hari Supplies",
        phone: "+9779844444444",
        panNo: "005555555",
        address: "Butwal-5",
        unknownField: "malicious_payload",
        createdById: "injected-id",
      },
    );
    const res = makeMockResponse();

    await create(req, res);

    assert.equal(res.statusCodeValue, 201);
    assert.equal(res.jsonBody.name, "Hari Supplies");
    assert.equal(res.jsonBody.panNo, "005555555");
    assert.equal(res.jsonBody.address, "Butwal-5");
    assert.equal("unknownField" in res.jsonBody, false);

    // Ensure database record has creator from session, not body injection
    const stored = ctx.getCustomers()[0];
    assert.equal(stored.createdById, "admin-1");
  });
});

test("quick create allows identity fields, forces zero discounts, and records ordinary audit", async () => {
  await withCustomerDatabaseMocks([], async (ctx) => {
    const req = makeMockRequest(
      { id: "cashier-1", role: "CASHIER" },
      { name: "  Quick Buyer  ", phone: "+9779811111111", email: "buyer@example.com", panNo: "001234567", address: " Kathmandu " },
    );
    const res = makeMockResponse();
    await createQuick(req, res);

    assert.equal(res.statusCodeValue, 201);
    assert.equal(res.jsonBody.name, "Quick Buyer");
    assert.equal(res.jsonBody.panNo, "001234567");
    assert.equal(res.jsonBody.address, "Kathmandu");
    assert.equal(res.jsonBody.loyaltyPercent, 0);
    assert.equal(res.jsonBody.wholesalePercent, 0);
    assert.equal(ctx.getCustomers()[0].createdById, "cashier-1");
    assert.equal(ctx.getAuditLogs()[0].action, "CUSTOMER_CREATED");
  });
});

test("quick create rejects discount and unknown fields without writing", async () => {
  await withCustomerDatabaseMocks([], async (ctx) => {
    for (const field of ["loyaltyPercent", "wholesalePercent", "discountType", "unknown"]) {
      const res = makeMockResponse();
      await createQuick(makeMockRequest({ id: "cashier-1", role: "CASHIER" }, { name: "Buyer", [field]: 90 }), res);
      assert.equal(res.statusCodeValue, 400, field);
    }
    assert.equal(ctx.getCustomers().length, 0);
  });
});

test("quick create rejects invalid identity and duplicate phone without creating a record", async () => {
  await withCustomerDatabaseMocks([{ id: "existing", name: "Existing", phone: "+9779800000000" }], async (ctx) => {
    const invalid = makeMockResponse();
    await createQuick(makeMockRequest({ id: "manager-1", role: "MANAGER" }, { name: "Buyer", phone: "+9779811111111", address: "Kathmandu", panNo: 123 }), invalid);
    assert.equal(invalid.statusCodeValue, 400);
    assert.equal(invalid.jsonBody.field, "panNo");
    assert.equal(ctx.getCustomers().length, 1);

    const duplicate = makeMockResponse();
    await createQuick(makeMockRequest({ id: "cashier-1", role: "CASHIER" }, { name: "Buyer", phone: "+9779800000000", address: "Kathmandu" }), duplicate);
    assert.equal(duplicate.statusCodeValue, 409);
    assert.equal(ctx.getCustomers().length, 1);
  });
});

test("create controller returns 400 with field when panNo or address validation fails with no write", async () => {
  await withCustomerDatabaseMocks([], async (ctx) => {
    // Non-text PAN
    const req1 = makeMockRequest(
      { id: "admin-1", role: "ADMIN" },
      { name: "Test Store", phone: "+9779811111111", address: "Kathmandu", panNo: 999999 },
    );
    const res1 = makeMockResponse();

    await create(req1, res1);

    assert.equal(res1.statusCodeValue, 400);
    assert.equal(res1.jsonBody.field, "panNo");
    assert.match(res1.jsonBody.error, /must be text/);
    assert.equal(ctx.getCustomers().length, 0); // No record created

    // Oversized address
    const req2 = makeMockRequest(
      { id: "admin-1", role: "ADMIN" },
      { name: "Test Store", phone: "+9779811111111", address: "a".repeat(65_536) },
    );
    const res2 = makeMockResponse();

    await create(req2, res2);

    assert.equal(res2.statusCodeValue, 400);
    assert.equal(res2.jsonBody.field, "address");
    assert.match(res2.jsonBody.error, /cannot exceed 65535 bytes/);
    assert.equal(ctx.getCustomers().length, 0); // No record created
  });
});

test("update controller updates panNo/address and ignores unknown fields", async () => {
  await withCustomerDatabaseMocks(
    [
      {
        id: "c-200",
        name: "Laxmi General",
        panNo: null,
        address: "Lalitpur",
      },
    ],
    async (ctx) => {
      const req = makeMockRequest(
        { id: "manager-1", role: "MANAGER" },
        {
          panNo: "001122334",
          address: "Patan Dhoka, Lalitpur",
          unknownProperty: "ignored",
        },
        { id: "c-200" },
      );
      const res = makeMockResponse();

      await update(req, res);

      assert.equal(res.statusCodeValue, 200);
      assert.equal(res.jsonBody.panNo, "001122334");
      assert.equal(res.jsonBody.address, "Patan Dhoka, Lalitpur");

      const stored = ctx.getCustomers()[0];
      assert.equal(stored.panNo, "001122334");
      assert.equal("unknownProperty" in stored, false);
    },
  );
});

test("update controller returns 400 on invalid input with no database modification", async () => {
  await withCustomerDatabaseMocks(
    [
      {
        id: "c-201",
        name: "Original Store",
        panNo: "111111111",
        address: "Original Address",
      },
    ],
    async (ctx) => {
      const req = makeMockRequest(
        { id: "admin-1", role: "ADMIN" },
        {
          panNo: 12345, // invalid numeric PAN
        },
        { id: "c-201" },
      );
      const res = makeMockResponse();

      await update(req, res);

      assert.equal(res.statusCodeValue, 400);
      assert.equal(res.jsonBody.field, "panNo");

      // Verify no changes made to database record
      const stored = ctx.getCustomers()[0];
      assert.equal(stored.panNo, "111111111");
      assert.equal(stored.address, "Original Address");
    },
  );
});

// --- Role Boundary & RBAC Tests ---

test("customer routes enforce ADMIN and MANAGER role guards and deny CASHIER and STAFF", () => {
  const requireAdminManager = requireRole("ADMIN", "MANAGER");

  // Allowed roles
  for (const role of ["ADMIN", "MANAGER"]) {
    const req = makeMockRequest({ id: "user-1", role });
    const res = makeMockResponse();
    let nextCalled = false;

    requireAdminManager(req, res, (() => {
      nextCalled = true;
    }) as NextFunction);

    assert.equal(nextCalled, true, `Role ${role} should be allowed`);
  }

  // Denied roles
  for (const role of ["CASHIER", "STAFF"]) {
    const req = makeMockRequest({ id: "user-2", role });
    const res = makeMockResponse();
    let nextCalled = false;

    requireAdminManager(req, res, (() => {
      nextCalled = true;
    }) as NextFunction);

    assert.equal(nextCalled, false, `Role ${role} should be denied`);
    assert.equal(res.statusCodeValue, 403);
  }

  // denyStaff blocks STAFF on general authenticated customer routes
  const staffReq = makeMockRequest({ id: "staff-1", role: "STAFF" });
  const staffRes = makeMockResponse();
  let staffNextCalled = false;

  denyStaff(staffReq, staffRes, (() => {
    staffNextCalled = true;
  }) as NextFunction);

  assert.equal(staffNextCalled, false);
  assert.equal(staffRes.statusCodeValue, 403);
});

test("quick-create role gate allows ADMIN, MANAGER, CASHIER and rejects STAFF", () => {
  const quickCreateRoleGuard = requireRole("ADMIN", "MANAGER", "CASHIER");
  for (const role of ["ADMIN", "MANAGER", "CASHIER"]) {
    const req = makeMockRequest({ id: `${role.toLowerCase()}-1`, role });
    const res = makeMockResponse();
    let nextCalled = false;
    quickCreateRoleGuard(req, res, (() => { nextCalled = true; }) as NextFunction);
    assert.equal(nextCalled, true, `${role} should be allowed`);
  }

  const staffReq = makeMockRequest({ id: "staff-1", role: "STAFF" });
  const staffRes = makeMockResponse();
  let staffNextCalled = false;
  denyStaff(staffReq, staffRes, (() => { staffNextCalled = true; }) as NextFunction);
  assert.equal(staffNextCalled, false);
  assert.equal(staffRes.statusCodeValue, 403);
});

test("cashier-discounted customer creation retains optional PAN and requires address", async () => {
  await withCustomerDatabaseMocks([], async (ctx) => {
    // Attempting to send panNo and address to cashier-discounted route
    // Cashier role check
    const req = makeMockRequest(
      { id: "cashier-1", role: "CASHIER" },
      {
        name: "Discounted Customer",
        phone: "+9779899999999",
        discountType: "LOYALTY",
        discountPercent: 5,
        panNo: "001234567",
        address: "Kathmandu",
      },
    );
    const res = makeMockResponse();

    // Mock cashier privilege so cashier-discounted can execute
    const originalFindUnique = prisma.user.findUnique;
    (prisma.user as any).findUnique = async () => ({
      id: "cashier-1",
      role: "CASHIER",
      cashierPrivilege: {
        canCreateDiscountedCustomer: true,
        maxCustomerLoyaltyPercent: 10,
        maxCustomerWholesalePercent: 10,
      },
    });

    try {
      await createDiscountedByCashier(req, res);
      assert.equal(res.statusCodeValue, 201);

      // Verify that panNo and address were NOT saved via cashier-discounted route
      const created = ctx.getCustomers()[0];
      assert.equal(created.name, "Discounted Customer");
      assert.equal(created.panNo, "001234567", "Cashier-discounted creation preserves optional PAN text");
      assert.equal(created.address, "Kathmandu", "Cashier-discounted creation must retain the required address");
    } finally {
      prisma.user.findUnique = originalFindUnique;
    }
  });
});

 test("all customer creation controllers reject missing phone or address before writing", async () => {
 await withCustomerDatabaseMocks([], async ctx => {
  for (const controller of [create, createQuick, createDiscountedByCashier]) {
   for (const field of ["phone", "address"]) {
    const body: any = {name:"Buyer",phone:"9841000000",address:"Kathmandu",discountType:"LOYALTY",discountPercent:5};
    if (controller === createQuick) { delete body.discountType; delete body.discountPercent; }
    delete body[field];
    const response=makeMockResponse();
    await controller(makeMockRequest({id:"cashier-1",role:"CASHIER"},body),response);
    assert.equal(response.statusCodeValue,400);
    assert.equal(response.jsonBody.field,field);
   }
  }
  assert.equal(ctx.getCustomers().length,0); assert.equal(ctx.getAuditLogs().length,0);
 });
});

test("discount approval requires address only for a newly created customer", async () => {
 const original=prisma.$transaction;
 let existing: any=null; const writes: string[]=[];
 const request: any={id:"request",status:"PENDING",phone:"9841000000",customerName:"Buyer",discountPercent:5,discountType:"LOYALTY",requestedById:"cashier",requestedBy:{id:"cashier",name:"Cashier"}};
 const tx: any={customerDiscountRequest:{findUnique:async()=>request,update:async({data}:any)=>{writes.push("approval");return {...request,...data};}},customer:{findUnique:async()=>existing,create:async({data}:any)=>{writes.push("customer");return {id:"customer",...data};},update:async({data}:any)=>{writes.push("update");return {...existing,...data};}},auditLog:{create:async()=>{writes.push("audit");}}};
 prisma.$transaction=async(work:any)=>work(tx);
 try {
  await assert.rejects(approveCustomerDiscountRequest("request","manager"), (e:any)=>e instanceof CustomerValidationError && e.field==="address");
  assert.deepEqual(writes,[]);
  await approveCustomerDiscountRequest("request","manager",{address:"Kathmandu"});
  assert.deepEqual(writes,["customer","approval","audit"]);
  writes.length=0; existing={id:"legacy",phone:request.phone,address:null,name:"Buyer"};
  await approveCustomerDiscountRequest("request","manager");
  assert.deepEqual(writes,["update","approval","audit"]);
 } finally {prisma.$transaction=original;}
});
