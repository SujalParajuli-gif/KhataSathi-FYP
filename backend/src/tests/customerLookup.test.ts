import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import { lookupCustomers } from "../modules/customers/service";
import { lookupCustomers as lookupCustomersController } from "../modules/customers/controller";

function createMockResponse() {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.body = data;
      return this;
    },
  };
  return res;
}

// --- Controller Validation Tests ---

test("lookupCustomers controller rejects non-string q with 400", async () => {
  const req: any = { query: { q: ["invalid", "array"] } };
  const res = createMockResponse();

  await lookupCustomersController(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /must be a string/i);
});

test("lookupCustomers controller rejects query exceeding 191 chars with 400", async () => {
  const req: any = { query: { q: "a".repeat(192) } };
  const res = createMockResponse();

  await lookupCustomersController(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /cannot exceed 191 characters/i);
});

test("lookupCustomers controller rejects invalid match mode with 400", async () => {
  const req: any = { query: { match: "invalid_mode" } };
  const res = createMockResponse();

  await lookupCustomersController(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Match mode must be 'search' or 'pan'/i);
});

test("lookupCustomers controller rejects match=pan with empty q with 400", async () => {
  const req: any = { query: { match: "pan", q: "   " } };
  const res = createMockResponse();

  await lookupCustomersController(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Query 'q' is required when match is 'pan'/i);
});

test("lookupCustomers controller rejects invalid page numbers with 400", async () => {
  for (const invalidPage of ["0", "-1", "1001", "abc", "1.5"]) {
    const req: any = { query: { page: invalidPage } };
    const res = createMockResponse();

    await lookupCustomersController(req, res);
    assert.equal(res.statusCode, 400, `Page ${invalidPage} should be rejected`);
    assert.match(res.body.error, /Page must be an integer between 1 and 1000/i);
  }
});

test("lookupCustomers controller rejects invalid pageSize with 400", async () => {
  for (const invalidSize of ["0", "-5", "21", "50", "xyz", "10.2"]) {
    const req: any = { query: { pageSize: invalidSize } };
    const res = createMockResponse();

    await lookupCustomersController(req, res);
    assert.equal(res.statusCode, 400, `PageSize ${invalidSize} should be rejected`);
    assert.match(res.body.error, /Page size must be an integer between 1 and 20/i);
  }
});

test("lookupCustomers controller rejects array or object page/pageSize/match with 400", async () => {
  for (const invalidPage of [["1"], ["1", "2"], { val: 1 }, 123]) {
    const req: any = { query: { page: invalidPage } };
    const res = createMockResponse();

    await lookupCustomersController(req, res);
    assert.equal(res.statusCode, 400, `Non-scalar page should be rejected`);
    assert.match(res.body.error, /Page must be an integer between 1 and 1000/i);
  }

  for (const invalidSize of [["20"], ["10", "20"], { size: 20 }, 20]) {
    const req: any = { query: { pageSize: invalidSize } };
    const res = createMockResponse();

    await lookupCustomersController(req, res);
    assert.equal(res.statusCode, 400, `Non-scalar pageSize should be rejected`);
    assert.match(res.body.error, /Page size must be an integer between 1 and 20/i);
  }

  for (const invalidMatch of [["search"], ["pan"], { mode: "pan" }]) {
    const req: any = { query: { match: invalidMatch, q: "123456789" } };
    const res = createMockResponse();

    await lookupCustomersController(req, res);
    assert.equal(res.statusCode, 400, `Non-scalar match should be rejected`);
    assert.match(res.body.error, /Match mode must be 'search' or 'pan'/i);
  }
});

// --- Service Unit Tests ---

test("lookupCustomers service in search mode filters active customers with OR predicate", async () => {
  const originalTransaction = prisma.$transaction;

  try {
    let capturedWhere: any = null;
    let capturedSelect: any = null;
    let capturedOrderBy: any = null;
    let capturedSkip: any = null;
    let capturedTake: any = null;

    (prisma as any).$transaction = async (fn: any) => {
      const mockTx = {
        customer: {
          count: async (args: any) => {
            capturedWhere = args.where;
            return 1;
          },
          findMany: async (args: any) => {
            capturedSelect = args.select;
            capturedOrderBy = args.orderBy;
            capturedSkip = args.skip;
            capturedTake = args.take;
            return [
              {
                id: "cust_1",
                name: "Sujal Test",
                phone: "9800000000",
                email: "test@example.com",
                panNo: "123456789",
                address: "Kathmandu",
                isActive: true,
                loyaltyPercent: 5,
                wholesalePercent: 0,
              },
            ];
          },
        },
      };
      return fn(mockTx);
    };

    const result = await lookupCustomers({
      q: "Sujal",
      match: "search",
      page: 1,
      pageSize: 20,
    });

    assert.equal(result.total, 1);
    assert.equal(result.page, 1);
    assert.equal(result.pageSize, 20);
    assert.equal(result.totalPages, 1);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].name, "Sujal Test");

    // Verify Prisma query structure
    assert.equal(capturedWhere.isActive, true);
    assert.deepEqual(capturedWhere.OR, [
      { name: { contains: "Sujal" } },
      { phone: { contains: "Sujal" } },
      { panNo: { contains: "Sujal" } },
    ]);
    assert.deepEqual(capturedOrderBy, [{ name: "asc" }, { id: "asc" }]);
    assert.equal(capturedSkip, 0);
    assert.equal(capturedTake, 20);

    // Verify explicit select fields
    assert.equal(capturedSelect.id, true);
    assert.equal(capturedSelect.name, true);
    assert.equal(capturedSelect.phone, true);
    assert.equal(capturedSelect.email, true);
    assert.equal(capturedSelect.panNo, true);
    assert.equal(capturedSelect.address, true);
    assert.equal(capturedSelect.isActive, true);
    assert.equal(capturedSelect.loyaltyPercent, true);
    assert.equal(capturedSelect.wholesalePercent, true);
    // Ensure no raw invoice relations or internals
    assert.equal(capturedSelect.invoices, undefined);
  } finally {
    (prisma as any).$transaction = originalTransaction;
  }
});

test("lookupCustomers service in pan mode matches exact panNo and includes inactive records for conflict detection", async () => {
  const originalTransaction = prisma.$transaction;

  try {
    let capturedWhere: any = null;

    (prisma as any).$transaction = async (fn: any) => {
      const mockTx = {
        customer: {
          count: async (args: any) => {
            capturedWhere = args.where;
            return 2;
          },
          findMany: async () => [
            {
              id: "cust_1",
              name: "Active PAN Holder",
              phone: "9800000001",
              email: null,
              panNo: "998877665",
              address: null,
              isActive: true,
              loyaltyPercent: 0,
              wholesalePercent: 0,
            },
            {
              id: "cust_2",
              name: "Inactive Duplicate PAN Holder",
              phone: "9800000002",
              email: null,
              panNo: "998877665",
              address: null,
              isActive: false,
              loyaltyPercent: 0,
              wholesalePercent: 0,
            },
          ],
        },
      };
      return fn(mockTx);
    };

    const result = await lookupCustomers({
      q: "998877665",
      match: "pan",
      page: 1,
      pageSize: 10,
    });

    assert.equal(result.total, 2);
    assert.equal(result.totalPages, 1);
    assert.equal(result.items.length, 2);
    // Exact pan equality without isActive restriction
    assert.equal(capturedWhere.panNo, "998877665");
    assert.equal(capturedWhere.isActive, undefined);
    assert.equal(capturedWhere.OR, undefined);
  } finally {
    (prisma as any).$transaction = originalTransaction;
  }
});

test("lookupCustomers service matches non-nine-digit PAN in pan mode", async () => {
  const originalTransaction = prisma.$transaction;

  try {
    let capturedWhere: any = null;

    (prisma as any).$transaction = async (fn: any) => {
      const mockTx = {
        customer: {
          count: async (args: any) => {
            capturedWhere = args.where;
            return 1;
          },
          findMany: async () => [
            {
              id: "cust_3",
              name: "Short PAN Customer",
              phone: "9800000003",
              email: null,
              panNo: "ABC-123",
              address: null,
              isActive: true,
              loyaltyPercent: 0,
              wholesalePercent: 0,
            },
          ],
        },
      };
      return fn(mockTx);
    };

    const result = await lookupCustomers({
      q: "ABC-123",
      match: "pan",
      page: 1,
      pageSize: 10,
    });

    assert.equal(result.total, 1);
    assert.equal(result.items[0].panNo, "ABC-123");
    assert.equal(capturedWhere.panNo, "ABC-123");
  } finally {
    (prisma as any).$transaction = originalTransaction;
  }
});
