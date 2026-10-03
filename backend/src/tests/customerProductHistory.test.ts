import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import { getCustomerProductPurchaseHistory } from "../modules/customers/service";
import { getProductPurchaseHistory } from "../modules/customers/controller";
import { denyStaff } from "../middleware/rbac";

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

// --- Controller Unit & Validation Tests ---

test("getProductPurchaseHistory controller rejects missing customerId with 400", async () => {
  const req: any = { params: {}, query: { productIds: "prod_1" } };
  const res = createMockResponse();

  await getProductPurchaseHistory(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Customer ID is required/i);
});

test("getProductPurchaseHistory controller rejects missing product query with 400", async () => {
  const req: any = { params: { customerId: "cust_1" }, query: {} };
  const res = createMockResponse();

  await getProductPurchaseHistory(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /At least one product ID is required/i);
});

test("getProductPurchaseHistory controller rejects whitespace-only product IDs with 400", async () => {
  const req: any = { params: { customerId: "cust_1" }, query: { productIds: " , , " } };
  const res = createMockResponse();

  await getProductPurchaseHistory(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /At least one valid product ID is required/i);
});

test("getProductPurchaseHistory controller rejects requests exceeding 20 unique products with 400", async () => {
  const ids = Array.from({ length: 21 }, (_, i) => `prod_${i + 1}`).join(",");
  const req: any = { params: { customerId: "cust_1" }, query: { productIds: ids } };
  const res = createMockResponse();

  await getProductPurchaseHistory(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /more than 20 products/i);
});

test("getProductPurchaseHistory controller deduplicates product IDs and parses array format", async () => {
  const originalFindUnique = prisma.customer.findUnique;
  const originalFindMany = prisma.invoiceItem.findMany;

  try {
    (prisma.customer as any).findUnique = async () => ({ id: "cust_1" });
    const queriedProductIds: string[] = [];
    (prisma.invoiceItem as any).findMany = async (args: any) => {
      queriedProductIds.push(args.where.productId);
      return [];
    };

    const req: any = {
      params: { customerId: "cust_1" },
      query: { productIds: ["prod_1,prod_2", "prod_1", "prod_3", "prod_2"] },
    };
    const res = createMockResponse();

    await getProductPurchaseHistory(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { history: [] });
    assert.deepEqual(queriedProductIds.sort(), ["prod_1", "prod_2", "prod_3"]);
  } finally {
    prisma.customer.findUnique = originalFindUnique;
    prisma.invoiceItem.findMany = originalFindMany;
  }
});

test("getProductPurchaseHistory returns 404 when customer does not exist", async () => {
  const originalFindUnique = prisma.customer.findUnique;
  try {
    (prisma.customer as any).findUnique = async () => null;
    const req: any = {
      params: { customerId: "unknown_cust" },
      query: { productIds: "prod_1" },
    };
    const res = createMockResponse();

    await getProductPurchaseHistory(req, res);
    assert.equal(res.statusCode, 404);
    assert.match(res.body.error, /Customer not found/i);
  } finally {
    prisma.customer.findUnique = originalFindUnique;
  }
});

// --- Service Logic & Scoping / Exclusion Tests ---

test("getCustomerProductPurchaseHistory throws 'Customer not found' for non-existent customer", async () => {
  const originalFindUnique = prisma.customer.findUnique;
  try {
    (prisma.customer as any).findUnique = async () => null;
    await assert.rejects(
      () => getCustomerProductPurchaseHistory("non_existent", ["prod_1"]),
      /Customer not found/,
    );
  } finally {
    prisma.customer.findUnique = originalFindUnique;
  }
});

test("getCustomerProductPurchaseHistory queries with correct scoping and filters", async () => {
  const originalFindUnique = prisma.customer.findUnique;
  const originalFindMany = prisma.invoiceItem.findMany;

  try {
    (prisma.customer as any).findUnique = async (args: any) => {
      assert.equal(args.where.id, "cust_test_1");
      return { id: "cust_test_1" };
    };

    let capturedWhere: any = null;
    let capturedTake: number | null = null;
    let capturedSelect: any = null;

    (prisma.invoiceItem as any).findMany = async (args: any) => {
      capturedWhere = args.where;
      capturedTake = args.take;
      capturedSelect = args.select;
      return [
        {
          id: "item_1",
          productId: "prod_1",
          qty: 3,
          appliedUnitPrice: 250,
          productNameSnapshot: "Snapshot Product Name",
          productSkuSnapshot: "SKU-SNAP-01",
          product: { name: "Live Catalog Name", sku: "SKU-LIVE-01" },
          invoice: {
            id: "inv_1",
            invoiceNo: "INV-2026-0001",
            finalizedAt: new Date("2026-09-15T10:00:00.000Z"),
            createdAt: new Date("2026-09-15T09:55:00.000Z"),
          },
        },
      ];
    };

    const history = await getCustomerProductPurchaseHistory("cust_test_1", ["prod_1"]);

    assert.equal(capturedTake, 5);
    assert.equal(capturedWhere.productId, "prod_1");
    assert.equal(capturedWhere.invoice.customerId, "cust_test_1");
    assert.equal(capturedWhere.invoice.status, "FINALIZED");
    assert.equal(capturedWhere.invoice.cancelledAt, null);
    assert.equal(capturedWhere.invoice.deletedAt, null);
    assert.deepEqual(capturedWhere.invoice.paymentStatus, { not: "CANCELLED" });
    assert.deepEqual(capturedWhere.invoice.creditNotesAsOriginal, {
      none: { replacementInvoiceId: { not: null } },
    });

    // Verify security/privacy: costAtSale, payment info, override internal IDs are not selected
    assert.equal(capturedSelect.costAtSale, undefined);
    assert.equal(capturedSelect.overrideById, undefined);
    assert.equal(capturedSelect.invoice.select.cashierId, undefined);

    // Verify output shape
    assert.equal(history.length, 1);
    assert.deepEqual(history[0], {
      id: "item_1",
      invoiceId: "inv_1",
      invoiceNo: "INV-2026-0001",
      invoiceDate: "2026-09-15T10:00:00.000Z",
      productId: "prod_1",
      productName: "Snapshot Product Name",
      productSku: "SKU-SNAP-01",
      qty: 3,
      appliedUnitPrice: 250,
    });
  } finally {
    prisma.customer.findUnique = originalFindUnique;
    prisma.invoiceItem.findMany = originalFindMany;
  }
});

test("getCustomerProductPurchaseHistory falls back to live product name if snapshot is null", async () => {
  const originalFindUnique = prisma.customer.findUnique;
  const originalFindMany = prisma.invoiceItem.findMany;

  try {
    (prisma.customer as any).findUnique = async () => ({ id: "cust_1" });
    (prisma.invoiceItem as any).findMany = async () => [
      {
        id: "item_2",
        productId: "prod_2",
        qty: 1,
        appliedUnitPrice: 500,
        productNameSnapshot: null,
        productSkuSnapshot: null,
        product: { name: "Catalog Fallback Name", sku: "CAT-SKU-02" },
        invoice: {
          id: "inv_2",
          invoiceNo: "INV-2026-0002",
          finalizedAt: null,
          createdAt: new Date("2026-09-20T12:00:00.000Z"),
        },
      },
    ];

    const history = await getCustomerProductPurchaseHistory("cust_1", ["prod_2"]);
    assert.equal(history.length, 1);
    assert.equal(history[0].productName, "Catalog Fallback Name");
    assert.equal(history[0].productSku, "CAT-SKU-02");
    assert.equal(history[0].invoiceDate, "2026-09-20T12:00:00.000Z");
  } finally {
    prisma.customer.findUnique = originalFindUnique;
    prisma.invoiceItem.findMany = originalFindMany;
  }
});

test("getCustomerProductPurchaseHistory returns empty array when customer has no purchase history", async () => {
  const originalFindUnique = prisma.customer.findUnique;
  const originalFindMany = prisma.invoiceItem.findMany;

  try {
    (prisma.customer as any).findUnique = async () => ({ id: "cust_empty" });
    (prisma.invoiceItem as any).findMany = async () => [];

    const history = await getCustomerProductPurchaseHistory("cust_empty", ["prod_1", "prod_2"]);
    assert.deepEqual(history, []);
  } finally {
    prisma.customer.findUnique = originalFindUnique;
    prisma.invoiceItem.findMany = originalFindMany;
  }
});

// --- Auth & RBAC Middleware Boundary Tests ---

test("customer product history route enforces denyStaff", () => {
  let nextCalled = false;
  let statusSent = 0;
  let responseBody: any = null;

  const staffReq: any = { user: { id: "u_staff", role: "STAFF" } };
  const res: any = {
    status(code: number) {
      statusSent = code;
      return this;
    },
    json(data: any) {
      responseBody = data;
      return this;
    },
  };
  const next = () => {
    nextCalled = true;
  };

  denyStaff(staffReq, res, next);
  assert.equal(nextCalled, false);
  assert.equal(statusSent, 403);
  assert.match(responseBody.error, /Staff access is limited/i);

  // Cashier, Manager, and Admin pass denyStaff
  for (const role of ["CASHIER", "MANAGER", "ADMIN"]) {
    let allowed = false;
    denyStaff({ user: { id: "u_1", role } } as any, res, () => {
      allowed = true;
    });
    assert.equal(allowed, true, `Role ${role} should be allowed past denyStaff`);
  }
});
