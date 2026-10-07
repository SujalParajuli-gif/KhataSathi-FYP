import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import { getCustomerPurchaseHistory } from "../modules/customers/service";
import { getCustomerPurchaseHistory as getCustomerPurchaseHistoryController } from "../modules/customers/controller";

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

test("getCustomerPurchaseHistory controller rejects missing customerId with 400", async () => {
  const req: any = { params: { customerId: "" }, query: {} };
  const res = createMockResponse();

  await getCustomerPurchaseHistoryController(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Customer ID is required/i);
});

test("getCustomerPurchaseHistory controller rejects non-string q with 400", async () => {
  const req: any = { params: { customerId: "cust_1" }, query: { q: 12345 } };
  const res = createMockResponse();

  await getCustomerPurchaseHistoryController(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /must be a string/i);
});

test("getCustomerPurchaseHistory controller rejects query exceeding 191 chars with 400", async () => {
  const req: any = { params: { customerId: "cust_1" }, query: { q: "x".repeat(192) } };
  const res = createMockResponse();

  await getCustomerPurchaseHistoryController(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /cannot exceed 191 characters/i);
});

test("getCustomerPurchaseHistory controller rejects invalid page numbers with 400", async () => {
  for (const invalidPage of ["0", "-1", "1001", "xyz", "2.5"]) {
    const req: any = { params: { customerId: "cust_1" }, query: { page: invalidPage } };
    const res = createMockResponse();

    await getCustomerPurchaseHistoryController(req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /Page must be an integer between 1 and 1000/i);
  }
});

test("getCustomerPurchaseHistory controller rejects invalid pageSize with 400", async () => {
  for (const invalidSize of ["0", "-5", "51", "100", "abc"]) {
    const req: any = { params: { customerId: "cust_1" }, query: { pageSize: invalidSize } };
    const res = createMockResponse();

    await getCustomerPurchaseHistoryController(req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /Page size must be an integer between 1 and 50/i);
  }
});

test("getCustomerPurchaseHistory controller rejects array or object page/pageSize with 400", async () => {
  for (const invalidPage of [["1"], ["1", "2"], { val: 1 }, 123]) {
    const req: any = { params: { customerId: "cust_1" }, query: { page: invalidPage } };
    const res = createMockResponse();

    await getCustomerPurchaseHistoryController(req, res);
    assert.equal(res.statusCode, 400, "Non-scalar page should be rejected");
    assert.match(res.body.error, /Page must be an integer between 1 and 1000/i);
  }

  for (const invalidSize of [["20"], ["10", "20"], { size: 20 }, 20]) {
    const req: any = { params: { customerId: "cust_1" }, query: { pageSize: invalidSize } };
    const res = createMockResponse();

    await getCustomerPurchaseHistoryController(req, res);
    assert.equal(res.statusCode, 400, "Non-scalar pageSize should be rejected");
    assert.match(res.body.error, /Page size must be an integer between 1 and 50/i);
  }
});

// --- Service Unit Tests ---

test("getCustomerPurchaseHistory throws 404 when customer does not exist", async () => {
  const originalFindUnique = prisma.customer.findUnique;

  try {
    (prisma.customer as any).findUnique = async () => null;

    await assert.rejects(
      async () => {
        await getCustomerPurchaseHistory({
          customerId: "nonexistent_cust",
          q: "",
          page: 1,
          pageSize: 20,
        });
      },
      /Customer not found/i,
    );
  } finally {
    (prisma.customer as any).findUnique = originalFindUnique;
  }
});

test("getCustomerPurchaseHistory applies snapshot-correct historical name search predicate and excludes costAtSale", async () => {
  const originalFindUnique = prisma.customer.findUnique;
  const originalTransaction = prisma.$transaction;

  try {
    (prisma.customer as any).findUnique = async () => ({ id: "cust_10" });

    let capturedWhere: any = null;
    let capturedSelect: any = null;
    let capturedOrderBy: any = null;

    (prisma as any).$transaction = async (fn: any) => {
      const mockTx = {
        invoiceItem: {
          count: async (args: any) => {
            capturedWhere = args.where;
            return 1;
          },
          findMany: async (args: any) => {
            capturedSelect = args.select;
            capturedOrderBy = args.orderBy;
            return [
              {
                id: "item_1",
                productId: "prod_1",
                qty: 2,
                appliedUnitPrice: 250,
                productNameSnapshot: "Wai Wai Noodles",
                productSkuSnapshot: "WAI-01",
                snapshotCapturedAt: new Date("2026-09-01T10:00:00Z"),
                product: {
                  name: "Wai Wai Quick Noodles",
                  sku: "WAI-01",
                },
                invoice: {
                  id: "inv_1",
                  invoiceNo: "INV-1001",
                  finalizedAt: new Date("2026-09-01T10:00:00Z"),
                  createdAt: new Date("2026-09-01T09:55:00Z"),
                },
              },
            ];
          },
        },
      };
      return fn(mockTx);
    };

    const result = await getCustomerPurchaseHistory({
      customerId: "cust_10",
      q: "Wai",
      page: 1,
      pageSize: 20,
    });

    assert.equal(result.total, 1);
    assert.equal(result.items.length, 1);
    const item = result.items[0];
    assert.equal(item.id, "item_1");
    assert.equal(item.invoiceNo, "INV-1001");
    assert.equal(item.productName, "Wai Wai Noodles");
    assert.equal(item.displayProduct.source, "CAPTURED");

    // Invariants: Cost must NEVER be selected or present
    assert.equal((capturedSelect as any).costAtSale, undefined);
    assert.equal((item as any).costAtSale, undefined);

    // Verify invoice eligibility where predicate
    assert.equal(capturedWhere.invoice.customerId, "cust_10");
    assert.equal(capturedWhere.invoice.status, "FINALIZED");
    assert.equal(capturedWhere.invoice.cancelledAt, null);
    assert.equal(capturedWhere.invoice.deletedAt, null);
    assert.deepEqual(capturedWhere.invoice.paymentStatus, { not: "CANCELLED" });
    assert.deepEqual(capturedWhere.invoice.creditNotesAsOriginal, {
      none: { replacementInvoiceId: { not: null } },
    });

    // Verify snapshot-correct search predicate
    assert.deepEqual(capturedWhere.OR, [
      {
        snapshotCapturedAt: { not: null },
        productNameSnapshot: { contains: "Wai" },
      },
      {
        snapshotCapturedAt: null,
        product: {
          name: { contains: "Wai" },
        },
      },
    ]);

    // Verify stable ordering: finalizedAt desc, createdAt desc, id desc
    assert.deepEqual(capturedOrderBy, [
      { invoice: { finalizedAt: "desc" } },
      { invoice: { createdAt: "desc" } },
      { id: "desc" },
    ]);
  } finally {
    (prisma.customer as any).findUnique = originalFindUnique;
    (prisma as any).$transaction = originalTransaction;
  }
});
