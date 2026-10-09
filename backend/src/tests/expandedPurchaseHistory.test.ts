import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import {
  getCustomerPurchaseHistory,
  getCustomerProductPurchaseHistory,
  getEligibleCustomerInvoiceWhere,
} from "../modules/customers/service";
import {
  getCustomerPurchaseHistory as getCustomerPurchaseHistoryController,
  getProductPurchaseHistory as getProductPurchaseHistoryController,
} from "../modules/customers/controller";
import customerRouter from "../modules/customers/routes";
import {
  SESSION_COOKIE_NAME,
  signSessionToken,
  hashSessionSecret,
} from "../modules/auth/session";
import { invalidateBusinessSettingsCache } from "../modules/settings/service";

function createMockResponse() {
  let onFinish: (() => void) | null = null;
  const res: any = {
    statusCode: 200,
    body: null,
    headers: {} as Record<string, string>,
    locals: {} as Record<string, any>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.body = data;
      if (onFinish) onFinish();
      return this;
    },
    send(data: any) {
      this.body = data;
      if (onFinish) onFinish();
      return this;
    },
    end() {
      if (onFinish) onFinish();
      return this;
    },
    setHeader(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
    getHeader(key: string) {
      return this.headers[key];
    },
    cookie() {
      return this;
    },
    clearCookie() {
      return this;
    },
    _setOnFinish(cb: () => void) {
      onFinish = cb;
    },
  };
  return res;
}

function createMockRequest(options: {
  method?: string;
  url?: string;
  originalUrl?: string;
  params?: Record<string, string>;
  query?: Record<string, any>;
  headers?: Record<string, string>;
  token?: string;
}) {
  const method = options.method || "GET";
  const url = options.url || "/";
  const headers: Record<string, string> = { ...(options.headers || {}) };
  if (options.token) {
    headers.cookie = `${SESSION_COOKIE_NAME}=${signSessionToken(options.token)}`;
  }
  const req: any = {
    method,
    url,
    originalUrl: options.originalUrl || url,
    params: options.params || {},
    query: options.query || {},
    headers,
    get(name: string) {
      return this.headers[name.toLowerCase()] || this.headers[name];
    },
    header(name: string) {
      return this.get(name);
    },
  };
  return req;
}

function invokeRouter(router: any, req: any, res: any, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`Router invocation timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    if (typeof res._setOnFinish === "function") {
      res._setOnFinish(finish);
    }

    router(req, res, (err: any) => {
      if (err) {
        res.status(500).json({ error: err.message || "Internal server error" });
      }
      finish();
    });
  });
}

// --- Controller Validation Tests for Expanded Filters ---

test("getCustomerPurchaseHistory controller rejects customerId exceeding 191 characters with 400", async () => {
  const req: any = { params: { customerId: "c".repeat(192) }, query: {} };
  const res = createMockResponse();

  await getCustomerPurchaseHistoryController(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Customer ID cannot exceed 191 characters/i);
});

test("getCustomerPurchaseHistory controller rejects invalid productId with 400", async () => {
  for (const invalidId of [123, ["prod_1"], "   ", "prod,1", "prod 1", "p".repeat(192)]) {
    const req: any = { params: { customerId: "cust_1" }, query: { productId: invalidId } };
    const res = createMockResponse();

    await getCustomerPurchaseHistoryController(req, res);
    assert.equal(res.statusCode, 400, `Expected 400 for productId: ${JSON.stringify(invalidId)}`);
  }
});

test("getCustomerPurchaseHistory controller validates 'from' and 'to' Nepal business dates", async () => {
  // Non-string or empty date
  for (const invalidDate of [12345, ["2026-09-01"], "   ", ""]) {
    const req: any = { params: { customerId: "cust_1" }, query: { from: invalidDate } };
    const res = createMockResponse();

    await getCustomerPurchaseHistoryController(req, res);
    assert.equal(res.statusCode, 400);
  }

  // Malformed date strings
  for (const malformed of ["2026/09/01", "01-09-2026", "2026-9-1", "invalid-date"]) {
    const req: any = { params: { customerId: "cust_1" }, query: { from: malformed } };
    const res = createMockResponse();

    await getCustomerPurchaseHistoryController(req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /YYYY-MM-DD/i);
  }

  // Non-existent calendar dates (e.g. Feb 30, April 31)
  for (const fakeDate of ["2026-02-30", "2026-04-31", "2026-13-01", "2026-00-10"]) {
    const req: any = { params: { customerId: "cust_1" }, query: { to: fakeDate } };
    const res = createMockResponse();

    await getCustomerPurchaseHistoryController(req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /valid calendar date|YYYY-MM-DD/i);
  }

  // Inverted date range (from > to)
  const invertedReq: any = {
    params: { customerId: "cust_1" },
    query: { from: "2026-09-15", to: "2026-09-01" },
  };
  const invertedRes = createMockResponse();
  await getCustomerPurchaseHistoryController(invertedReq, invertedRes);
  assert.equal(invertedRes.statusCode, 400);
  assert.match(invertedRes.body.error, /cannot be after/i);
});

test("getCustomerPurchaseHistory controller validates 'state' filter enum and types (HIST-4)", async () => {
  // Non-string state inputs return 400 "State must be a string."
  for (const nonStringState of [123, ["eligible"], { state: "all" }]) {
    const req: any = { params: { customerId: "cust_1" }, query: { state: nonStringState } };
    const res = createMockResponse();

    await getCustomerPurchaseHistoryController(req, res);
    assert.equal(res.statusCode, 400, `Expected 400 for non-string state: ${JSON.stringify(nonStringState)}`);
    assert.equal(res.body.error, "State must be a string.");
  }

  // Invalid string state values return 400 "Invalid state filter..."
  for (const invalidState of ["UNKNOWN", "active", "draft", "deleted", "other"]) {
    const req: any = { params: { customerId: "cust_1" }, query: { state: invalidState } };
    const res = createMockResponse();

    await getCustomerPurchaseHistoryController(req, res);
    assert.equal(res.statusCode, 400, `Expected 400 for invalid state enum: ${invalidState}`);
    assert.match(res.body.error, /Invalid state filter/i);
  }
});

// --- Service Logic, Predicates and Safe DTO Mapping Tests ---

test("getEligibleCustomerInvoiceWhere helper ensures predicate parity between compact and expanded real queries (HIST-2)", async () => {
  const predicate = getEligibleCustomerInvoiceWhere("cust_test_100");
  assert.deepEqual(predicate, {
    customerId: "cust_test_100",
    status: "FINALIZED",
    cancelledAt: null,
    deletedAt: null,
    paymentStatus: { not: "CANCELLED" },
    creditNotesAsOriginal: {
      none: {
        replacementInvoiceId: { not: null },
      },
    },
  });

  const originalFindUnique = prisma.customer.findUnique;
  const originalFindMany = prisma.invoiceItem.findMany;
  const originalTransaction = prisma.$transaction;

  try {
    (prisma.customer as any).findUnique = async () => ({ id: "cust_test_100" });

    let compactCapturedInvoiceWhere: any = null;
    let expandedCapturedInvoiceWhere: any = null;

    (prisma.invoiceItem as any).findMany = async (args: any) => {
      compactCapturedInvoiceWhere = args.where.invoice;
      return [];
    };

    (prisma as any).$transaction = async (fn: any) => {
      const mockTx = {
        invoiceItem: {
          count: async (args: any) => {
            expandedCapturedInvoiceWhere = args.where.invoice;
            return 0;
          },
          findMany: async () => [],
        },
      };
      return fn(mockTx);
    };

    // Invoke compact service
    await getCustomerProductPurchaseHistory("cust_test_100", ["prod_1"]);

    // Invoke expanded service with default/eligible state
    await getCustomerPurchaseHistory({
      customerId: "cust_test_100",
      state: "eligible",
    });

    // Assert both real service invocations produce the exact same invoice predicate
    assert.deepEqual(compactCapturedInvoiceWhere, predicate);
    assert.deepEqual(expandedCapturedInvoiceWhere, predicate);
    assert.deepEqual(compactCapturedInvoiceWhere, expandedCapturedInvoiceWhere);
  } finally {
    prisma.customer.findUnique = originalFindUnique;
    prisma.invoiceItem.findMany = originalFindMany;
    (prisma as any).$transaction = originalTransaction;
  }
});

test("getCustomerPurchaseHistory applies exact productId and inclusive Nepal date range filters", async () => {
  const originalFindUnique = prisma.customer.findUnique;
  const originalTransaction = prisma.$transaction;

  try {
    (prisma.customer as any).findUnique = async () => ({ id: "cust_10" });

    let capturedWhere: any = null;
    let capturedSelect: any = null;

    (prisma as any).$transaction = async (fn: any) => {
      const mockTx = {
        invoiceItem: {
          count: async (args: any) => {
            capturedWhere = args.where;
            return 1;
          },
          findMany: async (args: any) => {
            capturedSelect = args.select;
            return [
              {
                id: "item_p1",
                productId: "prod_target_1",
                qty: 5,
                appliedUnitPrice: 100,
                originalUnitPrice: 120,
                overrideUnitPrice: 100,
                overrideReason: "Customer negotiated bulk rate",
                lineTotal: 500,
                productNameSnapshot: "Historical Product X",
                productSkuSnapshot: "PROD-X-01",
                snapshotCapturedAt: new Date("2026-09-10T10:00:00Z"),
                product: { name: "Current Product X", sku: "PROD-X-01" },
                returnItems: [],
                invoice: {
                  id: "inv_1",
                  invoiceNo: "INV-2026-100",
                  status: "FINALIZED",
                  paymentStatus: "PAID",
                  finalizedAt: new Date("2026-09-10T10:00:00Z"),
                  createdAt: new Date("2026-09-10T09:50:00Z"),
                  cancelledAt: null,
                  billingChannel: "MANUAL_EXTERNAL",
                  externalDocumentType: "VAT_TAX_INVOICE",
                  externalBillNo: "BILL-2026-99",
                  externalBillDate: new Date("2026-09-10"),
                  billRecordStatus: "RECORDED",
                  creditNotesAsOriginal: [],
                  creditNoteAsReplacement: null,
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
      productId: "prod_target_1",
      from: "2026-09-01",
      to: "2026-09-15",
      state: "eligible",
    });

    assert.equal(result.total, 1);
    assert.equal(result.items.length, 1);
    const item = result.items[0];

    // Assert exact product filter
    assert.equal(capturedWhere.productId, "prod_target_1");

    // Assert date filter applied in AND clause with finalizedAt / createdAt fallback
    assert.ok(capturedWhere.invoice.AND, "Expected AND clause for date range");
    const dateClause = capturedWhere.invoice.AND[1];
    assert.ok(dateClause.OR, "Expected OR clause for finalizedAt and createdAt");

    // Assert DTO correctness
    assert.equal(item.state, "ELIGIBLE");
    assert.equal(item.productId, "prod_target_1");
    assert.equal(item.productName, "Historical Product X");
    assert.equal(item.originalUnitPrice, 120);
    assert.equal(item.overrideUnitPrice, 100);
    assert.equal(item.overrideReason, "Customer negotiated bulk rate");
    assert.equal(item.lineTotal, 500);
    assert.equal(item.returnedQty, 0);
    assert.equal(item.returnSummary.hasReturns, false);

    // External bill reference DTO
    assert.deepEqual(item.externalReference, {
      billingChannel: "MANUAL_EXTERNAL",
      externalDocumentType: "VAT_TAX_INVOICE",
      externalBillNo: "BILL-2026-99",
      externalBillDate: "2026-09-10",
      billRecordStatus: "RECORDED",
      isRecorded: true,
    });

    // Invariants: costAtSale NEVER selected or in output
    assert.equal((capturedSelect as any).costAtSale, undefined);
    assert.equal((item as any).costAtSale, undefined);
  } finally {
    prisma.customer.findUnique = originalFindUnique;
    (prisma as any).$transaction = originalTransaction;
  }
});

test("getCustomerPurchaseHistory handles state filters, cancellation+replacement precedence and line returns breakdown with REVERSED (HIST-4)", async () => {
  const originalFindUnique = prisma.customer.findUnique;
  const originalTransaction = prisma.$transaction;

  try {
    (prisma.customer as any).findUnique = async () => ({ id: "cust_20" });

    // Test 1: SUPERSEDED state precedence over cancellation flag
    (prisma as any).$transaction = async (fn: any) => {
      const mockTx = {
        invoiceItem: {
          count: async () => 1,
          findMany: async () => [
            {
              id: "item_sup",
              productId: "prod_1",
              qty: 2,
              appliedUnitPrice: 300,
              lineTotal: 600,
              productNameSnapshot: "Product Super",
              productSkuSnapshot: null,
              snapshotCapturedAt: new Date("2026-08-01T10:00:00Z"),
              product: { name: "Product Super Live", sku: null },
              returnItems: [],
              invoice: {
                id: "inv_orig",
                invoiceNo: "INV-ORIG-01",
                status: "FINALIZED",
                paymentStatus: "CANCELLED", // Has cancellation flag
                finalizedAt: new Date("2026-08-01T10:00:00Z"),
                createdAt: new Date("2026-08-01T09:00:00Z"),
                cancelledAt: new Date("2026-08-02T10:00:00Z"),
                creditNotesAsOriginal: [
                  {
                    id: "cn_1",
                    creditNoteNo: "CN-2026-001",
                    replacementInvoiceId: "inv_repl_02",
                    reason: "Price correction",
                    createdAt: new Date("2026-08-02T10:00:00Z"),
                    replacementInvoice: {
                      id: "inv_repl_02",
                      invoiceNo: "INV-REPL-02",
                    },
                  },
                ],
                creditNoteAsReplacement: null,
              },
            },
          ],
        },
      };
      return fn(mockTx);
    };

    const supersededResult = await getCustomerPurchaseHistory({
      customerId: "cust_20",
      state: "superseded",
    });

    assert.equal(supersededResult.items.length, 1);
    const supItem = supersededResult.items[0];
    assert.equal(supItem.state, "SUPERSEDED", "Precedence: SUPERSEDED wins even if cancelledAt is set");
    assert.deepEqual(supItem.supersededBy, {
      creditNoteNo: "CN-2026-001",
      replacementInvoiceId: "inv_repl_02",
      replacementInvoiceNo: "INV-REPL-02",
      createdAt: "2026-08-02T10:00:00.000Z",
      reason: "Price correction",
    });
    assert.equal(supItem.replaces, null);

    // Test 2: CANCELLED state (no replacement)
    (prisma as any).$transaction = async (fn: any) => {
      const mockTx = {
        invoiceItem: {
          count: async () => 1,
          findMany: async () => [
            {
              id: "item_canc",
              productId: "prod_2",
              qty: 1,
              appliedUnitPrice: 150,
              lineTotal: 150,
              productNameSnapshot: "Product Cancelled",
              productSkuSnapshot: null,
              snapshotCapturedAt: new Date("2026-08-05T10:00:00Z"),
              product: { name: "Product Live", sku: null },
              returnItems: [],
              invoice: {
                id: "inv_canc",
                invoiceNo: "INV-CANC-01",
                status: "FINALIZED",
                paymentStatus: "CANCELLED",
                finalizedAt: new Date("2026-08-05T10:00:00Z"),
                createdAt: new Date("2026-08-05T09:00:00Z"),
                cancelledAt: new Date("2026-08-06T10:00:00Z"),
                creditNotesAsOriginal: [],
                creditNoteAsReplacement: null,
              },
            },
          ],
        },
      };
      return fn(mockTx);
    };

    const cancelledResult = await getCustomerPurchaseHistory({
      customerId: "cust_20",
      state: "cancelled",
    });
    assert.equal(cancelledResult.items.length, 1);
    assert.equal(cancelledResult.items[0].state, "CANCELLED");
    assert.equal(cancelledResult.items[0].isCancelled, true);

    // Test 3: Replacement invoice pointing to original (replaces link)
    (prisma as any).$transaction = async (fn: any) => {
      const mockTx = {
        invoiceItem: {
          count: async () => 1,
          findMany: async () => [
            {
              id: "item_repl",
              productId: "prod_1",
              qty: 2,
              appliedUnitPrice: 280,
              lineTotal: 560,
              productNameSnapshot: "Product Corrected",
              productSkuSnapshot: null,
              snapshotCapturedAt: new Date("2026-08-02T10:00:00Z"),
              product: { name: "Product Live", sku: null },
              returnItems: [],
              invoice: {
                id: "inv_repl_02",
                invoiceNo: "INV-REPL-02",
                status: "FINALIZED",
                paymentStatus: "PAID",
                finalizedAt: new Date("2026-08-02T10:00:00Z"),
                createdAt: new Date("2026-08-02T09:55:00Z"),
                cancelledAt: null,
                creditNotesAsOriginal: [],
                creditNoteAsReplacement: {
                  id: "cn_1",
                  creditNoteNo: "CN-2026-001",
                  originalInvoiceId: "inv_orig",
                  reason: "Price correction",
                  createdAt: new Date("2026-08-02T10:00:00Z"),
                  originalInvoice: {
                    id: "inv_orig",
                    invoiceNo: "INV-ORIG-01",
                  },
                },
              },
            },
          ],
        },
      };
      return fn(mockTx);
    };

    const replResult = await getCustomerPurchaseHistory({
      customerId: "cust_20",
      state: "eligible",
    });
    assert.equal(replResult.items.length, 1);
    const replItem = replResult.items[0];
    assert.equal(replItem.state, "ELIGIBLE");
    assert.deepEqual(replItem.replaces, {
      creditNoteNo: "CN-2026-001",
      originalInvoiceId: "inv_orig",
      originalInvoiceNo: "INV-ORIG-01",
      createdAt: "2026-08-02T10:00:00.000Z",
      reason: "Price correction",
    });

    // Test 4: Line returns breakdown including REVERSED, REJECTED, PENDING and APPROVED
    (prisma as any).$transaction = async (fn: any) => {
      const mockTx = {
        invoiceItem: {
          count: async () => 1,
          findMany: async () => [
            {
              id: "item_ret",
              productId: "prod_ret",
              qty: 10,
              appliedUnitPrice: 50,
              lineTotal: 500,
              productNameSnapshot: "Returned Item Sample",
              productSkuSnapshot: null,
              snapshotCapturedAt: new Date("2026-08-10T10:00:00Z"),
              product: { name: "Returned Item Live", sku: null },
              returnItems: [
                {
                  id: "ri_1",
                  returnRequestId: "rr_app",
                  qtyReturned: 2,
                  unitPrice: 50,
                  lineTotal: 100,
                  returnRequest: {
                    id: "rr_app",
                    status: "APPROVED",
                    reason: "DAMAGED",
                    createdAt: new Date("2026-08-11T10:00:00Z"),
                  },
                },
                {
                  id: "ri_2",
                  returnRequestId: "rr_pend",
                  qtyReturned: 1,
                  unitPrice: 50,
                  lineTotal: 50,
                  returnRequest: {
                    id: "rr_pend",
                    status: "PENDING",
                    reason: "CUSTOMER_REQUEST",
                    createdAt: new Date("2026-08-12T10:00:00Z"),
                  },
                },
                {
                  id: "ri_3",
                  returnRequestId: "rr_rej",
                  qtyReturned: 1,
                  unitPrice: 50,
                  lineTotal: 50,
                  returnRequest: {
                    id: "rr_rej",
                    status: "REJECTED",
                    reason: "EXPIRED_POLICY",
                    createdAt: new Date("2026-08-13T10:00:00Z"),
                  },
                },
                {
                  id: "ri_4",
                  returnRequestId: "rr_rev",
                  qtyReturned: 1,
                  unitPrice: 50,
                  lineTotal: 50,
                  returnRequest: {
                    id: "rr_rev",
                    status: "REVERSED",
                    reason: "CANCELLED_BY_ADMIN",
                    createdAt: new Date("2026-08-14T10:00:00Z"),
                  },
                },
              ],
              invoice: {
                id: "inv_ret",
                invoiceNo: "INV-RET-01",
                status: "FINALIZED",
                paymentStatus: "PAID",
                finalizedAt: new Date("2026-08-10T10:00:00Z"),
                createdAt: new Date("2026-08-10T09:00:00Z"),
                cancelledAt: null,
                creditNotesAsOriginal: [],
                creditNoteAsReplacement: null,
              },
            },
          ],
        },
      };
      return fn(mockTx);
    };

    const retResult = await getCustomerPurchaseHistory({
      customerId: "cust_20",
      state: "returned",
    });
    assert.equal(retResult.items.length, 1);
    const retItem = retResult.items[0];
    assert.equal(retItem.qty, 10, "Historic sold quantity must not be altered");
    assert.equal(retItem.returnedQty, 2, "returnedQty must only sum APPROVED returns");
    assert.equal(retItem.returnSummary.approvedQty, 2);
    assert.equal(retItem.returnSummary.pendingQty, 1);
    assert.equal(retItem.returnSummary.rejectedQty, 1);
    assert.equal(retItem.returnSummary.reversedQty, 1, "reversedQty must count REVERSED returns");
    assert.equal(retItem.returnSummary.hasReturns, true);
    assert.equal(retItem.returnSummary.entries.length, 4);
    assert.equal(retItem.returnSummary.entries[3].status, "REVERSED");
  } finally {
    prisma.customer.findUnique = originalFindUnique;
    (prisma as any).$transaction = originalTransaction;
  }
});

test("getCustomerPurchaseHistory preserves historical timestamps/values and optional null context without fabrication (HIST-1)", async () => {
  const originalFindUnique = prisma.customer.findUnique;
  const originalTransaction = prisma.$transaction;

  try {
    (prisma.customer as any).findUnique = async () => ({ id: "cust_hist_1" });

    (prisma as any).$transaction = async (fn: any) => {
      const mockTx = {
        invoiceItem: {
          count: async () => 2,
          findMany: async () => [
            // Item 1: Multiple actual prices/qty, optional context missing (no finalizedAt, no externalBillDate, no cn createdAt)
            {
              id: "item_multi_1",
              productId: "prod_1",
              qty: 7,
              appliedUnitPrice: 149.5,
              originalUnitPrice: 175,
              overrideUnitPrice: 149.5,
              overrideReason: "Bulk discount agreement",
              lineTotal: 1046.5,
              productNameSnapshot: "Item 1 Captured",
              productSkuSnapshot: "SKU-01",
              snapshotCapturedAt: new Date("2026-07-01T12:00:00Z"),
              product: { name: "Live Item 1", sku: "SKU-01" },
              returnItems: [
                {
                  id: "ri_no_date",
                  returnRequestId: "rr_no_date",
                  qtyReturned: 1,
                  unitPrice: 149.5,
                  lineTotal: 149.5,
                  returnRequest: {
                    id: "rr_no_date",
                    status: "PENDING",
                    reason: "DEFECTIVE",
                    createdAt: null, // missing optional timestamp
                  },
                },
              ],
              invoice: {
                id: "inv_no_fin",
                invoiceNo: "INV-2026-NF1",
                status: "FINALIZED",
                paymentStatus: "PAID",
                finalizedAt: null, // missing finalizedAt; must use createdAt exactly, not new Date()
                createdAt: new Date("2026-07-01T11:30:00Z"),
                cancelledAt: null,
                billingChannel: null,
                externalDocumentType: null,
                externalBillNo: null,
                externalBillDate: null,
                billRecordStatus: null,
                creditNotesAsOriginal: [
                  {
                    id: "cn_no_date",
                    creditNoteNo: "CN-NO-DATE",
                    replacementInvoiceId: "inv_repl_nd",
                    reason: null,
                    createdAt: null, // missing optional timestamp
                    replacementInvoice: null,
                  },
                ],
                creditNoteAsReplacement: null,
              },
            },
            // Item 2: Second item with different price/qty and plain values
            {
              id: "item_multi_2",
              productId: "prod_2",
              qty: 15,
              appliedUnitPrice: 20,
              originalUnitPrice: null,
              overrideUnitPrice: null,
              overrideReason: null,
              lineTotal: 300,
              productNameSnapshot: null,
              productSkuSnapshot: null,
              snapshotCapturedAt: null,
              product: { name: "Live Item 2", sku: "SKU-02" },
              returnItems: [],
              invoice: {
                id: "inv_multi_2",
                invoiceNo: "INV-2026-NF2",
                status: "FINALIZED",
                paymentStatus: "PAID",
                finalizedAt: new Date("2026-07-02T15:00:00Z"),
                createdAt: new Date("2026-07-02T14:45:00Z"),
                cancelledAt: null,
                billingChannel: null,
                externalDocumentType: null,
                externalBillNo: null,
                externalBillDate: null,
                billRecordStatus: null,
                creditNotesAsOriginal: [],
                creditNoteAsReplacement: null,
              },
            },
          ],
        },
      };
      return fn(mockTx);
    };

    const result = await getCustomerPurchaseHistory({
      customerId: "cust_hist_1",
      state: "all",
    });

    assert.equal(result.items.length, 2);

    const item1 = result.items[0];
    // Exact invoiceDate from createdAt without fabricating new Date()
    assert.equal(item1.invoiceDate, "2026-07-01T11:30:00.000Z");
    assert.equal(item1.qty, 7);
    assert.equal(item1.appliedUnitPrice, 149.5);
    assert.equal(item1.lineTotal, 1046.5);
    assert.equal(item1.cancelledAt, null);

    // Missing return createdAt must remain null
    assert.equal(item1.returnSummary.entries[0].createdAt, null);

    // Missing supersededBy createdAt must remain null
    assert.equal(item1.supersededBy?.createdAt, null);
    assert.equal(item1.supersededBy?.replacementInvoiceNo, null);
    assert.equal(item1.supersededBy?.reason, null);

    // Item 2 asserts
    const item2 = result.items[1];
    assert.equal(item2.qty, 15);
    assert.equal(item2.appliedUnitPrice, 20);
    assert.equal(item2.lineTotal, 300);
    assert.equal(item2.originalUnitPrice, null);
    assert.equal(item2.overrideUnitPrice, null);
    assert.equal(item2.overrideReason, null);
    assert.equal(item2.supersededBy, null);
    assert.equal(item2.replaces, null);
  } finally {
    prisma.customer.findUnique = originalFindUnique;
    (prisma as any).$transaction = originalTransaction;
  }
});

test("getCustomerPurchaseHistory applies manual-bill verification semantics for isRecorded (HIST-3)", async () => {
  const originalFindUnique = prisma.customer.findUnique;
  const originalTransaction = prisma.$transaction;

  try {
    (prisma.customer as any).findUnique = async () => ({ id: "cust_bills" });

    (prisma as any).$transaction = async (fn: any) => {
      const mockTx = {
        invoiceItem: {
          count: async () => 4,
          findMany: async () => [
            // Case 1: RECORDED with valid bill number -> isRecorded: true
            {
              id: "item_b1",
              productId: "prod_1",
              qty: 1,
              appliedUnitPrice: 100,
              lineTotal: 100,
              productNameSnapshot: "P1",
              productSkuSnapshot: null,
              snapshotCapturedAt: null,
              product: { name: "P1", sku: null },
              returnItems: [],
              invoice: {
                id: "inv_b1",
                invoiceNo: "INV-B1",
                status: "FINALIZED",
                paymentStatus: "PAID",
                finalizedAt: new Date("2026-09-01T10:00:00Z"),
                createdAt: new Date("2026-09-01T09:00:00Z"),
                cancelledAt: null,
                billingChannel: "MANUAL_EXTERNAL",
                externalDocumentType: "VAT_TAX_INVOICE",
                externalBillNo: "BILL-001",
                externalBillDate: new Date("2026-09-01"),
                billRecordStatus: "RECORDED",
                creditNotesAsOriginal: [],
                creditNoteAsReplacement: null,
              },
            },
            // Case 2: VERIFIED with valid bill number -> isRecorded: true
            {
              id: "item_b2",
              productId: "prod_2",
              qty: 1,
              appliedUnitPrice: 200,
              lineTotal: 200,
              productNameSnapshot: "P2",
              productSkuSnapshot: null,
              snapshotCapturedAt: null,
              product: { name: "P2", sku: null },
              returnItems: [],
              invoice: {
                id: "inv_b2",
                invoiceNo: "INV-B2",
                status: "FINALIZED",
                paymentStatus: "PAID",
                finalizedAt: new Date("2026-09-02T10:00:00Z"),
                createdAt: new Date("2026-09-02T09:00:00Z"),
                cancelledAt: null,
                billingChannel: "MANUAL_EXTERNAL",
                externalDocumentType: "VAT_TAX_INVOICE",
                externalBillNo: "BILL-002",
                externalBillDate: new Date("2026-09-02"),
                billRecordStatus: "VERIFIED",
                creditNotesAsOriginal: [],
                creditNoteAsReplacement: null,
              },
            },
            // Case 3: MISSING status with only documentType and no bill number -> isRecorded: false
            {
              id: "item_b3",
              productId: "prod_3",
              qty: 1,
              appliedUnitPrice: 300,
              lineTotal: 300,
              productNameSnapshot: "P3",
              productSkuSnapshot: null,
              snapshotCapturedAt: null,
              product: { name: "P3", sku: null },
              returnItems: [],
              invoice: {
                id: "inv_b3",
                invoiceNo: "INV-B3",
                status: "FINALIZED",
                paymentStatus: "PAID",
                finalizedAt: new Date("2026-09-03T10:00:00Z"),
                createdAt: new Date("2026-09-03T09:00:00Z"),
                cancelledAt: null,
                billingChannel: "MANUAL_EXTERNAL",
                externalDocumentType: "VAT_TAX_INVOICE",
                externalBillNo: null,
                externalBillDate: null,
                billRecordStatus: "MISSING",
                creditNotesAsOriginal: [],
                creditNoteAsReplacement: null,
              },
            },
            // Case 4: Retained historical billNo with PENDING/MISSING status -> isRecorded: false
            {
              id: "item_b4",
              productId: "prod_4",
              qty: 1,
              appliedUnitPrice: 400,
              lineTotal: 400,
              productNameSnapshot: "P4",
              productSkuSnapshot: null,
              snapshotCapturedAt: null,
              product: { name: "P4", sku: null },
              returnItems: [],
              invoice: {
                id: "inv_b4",
                invoiceNo: "INV-B4",
                status: "FINALIZED",
                paymentStatus: "PAID",
                finalizedAt: new Date("2026-09-04T10:00:00Z"),
                createdAt: new Date("2026-09-04T09:00:00Z"),
                cancelledAt: null,
                billingChannel: "MANUAL_EXTERNAL",
                externalDocumentType: "PAN_INVOICE",
                externalBillNo: "BILL-HIST-99",
                externalBillDate: new Date("2026-09-04"),
                billRecordStatus: "PENDING",
                creditNotesAsOriginal: [],
                creditNoteAsReplacement: null,
              },
            },
          ],
        },
      };
      return fn(mockTx);
    };

    const result = await getCustomerPurchaseHistory({
      customerId: "cust_bills",
      state: "all",
    });

    assert.equal(result.items.length, 4);

    // Case 1: RECORDED + billNo -> isRecorded: true
    assert.equal(result.items[0].externalReference.isRecorded, true);
    assert.equal(result.items[0].externalReference.billRecordStatus, "RECORDED");

    // Case 2: VERIFIED + billNo -> isRecorded: true
    assert.equal(result.items[1].externalReference.isRecorded, true);
    assert.equal(result.items[1].externalReference.billRecordStatus, "VERIFIED");

    // Case 3: MISSING with only documentType -> isRecorded: false
    assert.equal(result.items[2].externalReference.isRecorded, false);
    assert.equal(result.items[2].externalReference.externalDocumentType, "VAT_TAX_INVOICE");
    assert.equal(result.items[2].externalReference.externalBillNo, null);
    assert.equal(result.items[2].externalReference.billRecordStatus, "MISSING");

    // Case 4: PENDING with retained billNo -> isRecorded: false (must not claim verification)
    assert.equal(result.items[3].externalReference.isRecorded, false);
    assert.equal(result.items[3].externalReference.externalBillNo, "BILL-HIST-99");
    assert.equal(result.items[3].externalReference.billRecordStatus, "PENDING");
  } finally {
    prisma.customer.findUnique = originalFindUnique;
    (prisma as any).$transaction = originalTransaction;
  }
});

// --- Mounted Route Chain & Authorization Tests (HIST-4) ---

test("customer router enforces denyStaff on purchase-history and product-history endpoints and prevents queries", async () => {
  const originalFindUniqueSession = prisma.authSession.findUnique;
  const originalFindUniqueCustomer = prisma.customer.findUnique;
  const originalTransaction = prisma.$transaction;
  const originalFindMany = prisma.invoiceItem.findMany;

  let customerQueried = false;
  let historyQueried = false;

  try {
    (prisma.authSession as any).findUnique = async () => ({
      id: "sess_staff",
      expiresAt: new Date(Date.now() + 3600000),
      revokedAt: null,
      csrfTokenHash: hashSessionSecret("test-csrf"),
      user: {
        id: "u_staff",
        role: "STAFF",
        isActive: true,
        mustChangePassword: false,
      },
    });

    (prisma.customer as any).findUnique = async () => {
      customerQueried = true;
      return { id: "cust_1" };
    };

    (prisma.invoiceItem as any).findMany = async () => {
      historyQueried = true;
      return [];
    };

    (prisma as any).$transaction = async () => {
      historyQueried = true;
      return { items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 };
    };

    // 1. Test purchase-history path with STAFF user
    const purchaseReq = createMockRequest({
      method: "GET",
      url: "/cust_1/purchase-history",
      token: "staff-raw-token",
    });
    const purchaseRes = createMockResponse();

    await invokeRouter(customerRouter, purchaseReq, purchaseRes);
    assert.equal(purchaseRes.statusCode, 403);
    assert.match(purchaseRes.body.error, /Staff access is limited/i);
    assert.equal(customerQueried, false, "Customer query must not be reached for STAFF");
    assert.equal(historyQueried, false, "History query must not be reached for STAFF");

    // 2. Test product-history path with STAFF user
    const productReq = createMockRequest({
      method: "GET",
      url: "/cust_1/product-history?productIds=prod_1",
      token: "staff-raw-token",
    });
    const productRes = createMockResponse();

    await invokeRouter(customerRouter, productReq, productRes);
    assert.equal(productRes.statusCode, 403);
    assert.match(productRes.body.error, /Staff access is limited/i);
    assert.equal(customerQueried, false, "Customer query must not be reached for STAFF");
    assert.equal(historyQueried, false, "History query must not be reached for STAFF");
  } finally {
    prisma.authSession.findUnique = originalFindUniqueSession;
    prisma.customer.findUnique = originalFindUniqueCustomer;
    (prisma as any).$transaction = originalTransaction;
    prisma.invoiceItem.findMany = originalFindMany;
    invalidateBusinessSettingsCache();
  }
});

test("customer router enforces requirePos on purchase-history and product-history for ADMIN/MANAGER/CASHIER when POS is disabled", async () => {
  const originalFindUniqueSession = prisma.authSession.findUnique;
  const originalFindUniqueCustomer = prisma.customer.findUnique;
  const originalTransaction = prisma.$transaction;
  const originalFindMany = prisma.invoiceItem.findMany;
  const originalUpsertSettings = prisma.businessSettings.upsert;

  let customerQueried = false;
  let historyQueried = false;

  try {
    // Mock settings in INVENTORY_ONLY mode (POS disabled)
    invalidateBusinessSettingsCache();
    (prisma.businessSettings as any).upsert = async () => ({
      id: 1,
      businessMode: "INVENTORY_ONLY",
      staffDraftRequestsEnabled: false,
      defaultInitialStock: 30,
      defaultLowStockThreshold: 5,
      defaultWholesaleQtyThreshold: 15,
      loyaltyDiscountPercent: 2,
      returnWindowDays: 7,
      parkedBillExpiryHours: 8,
      draftRequestExpiryMinutes: 30,
      taxCalculationMode: "UNKNOWN",
      defaultBillingChannel: null,
    });

    (prisma.customer as any).findUnique = async () => {
      customerQueried = true;
      return { id: "cust_1" };
    };

    (prisma.invoiceItem as any).findMany = async () => {
      historyQueried = true;
      return [];
    };

    (prisma as any).$transaction = async () => {
      historyQueried = true;
      return { items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 };
    };

    for (const role of ["ADMIN", "MANAGER", "CASHIER"]) {
      (prisma.authSession as any).findUnique = async () => ({
        id: `sess_${role.toLowerCase()}`,
        expiresAt: new Date(Date.now() + 3600000),
        revokedAt: null,
        csrfTokenHash: hashSessionSecret("test-csrf"),
        user: {
          id: `u_${role.toLowerCase()}`,
          role,
          isActive: true,
          mustChangePassword: false,
        },
      });

      // 1. Test purchase-history path with POS disabled
      const purchaseReq = createMockRequest({
        method: "GET",
        url: "/cust_1/purchase-history",
        token: `${role.toLowerCase()}-raw-token`,
      });
      const purchaseRes = createMockResponse();

      await invokeRouter(customerRouter, purchaseReq, purchaseRes);
      assert.equal(purchaseRes.statusCode, 403, `Role ${role} should receive 403 when POS is disabled`);
      assert.equal(purchaseRes.body.code, "FEATURE_DISABLED");
      assert.match(purchaseRes.body.error, /POS is disabled in INVENTORY_ONLY mode/i);
      assert.equal(customerQueried, false, `Customer query must not be reached for ${role} when POS is disabled`);
      assert.equal(historyQueried, false, `History query must not be reached for ${role} when POS is disabled`);

      // 2. Test product-history path with POS disabled
      const productReq = createMockRequest({
        method: "GET",
        url: "/cust_1/product-history?productIds=prod_1",
        token: `${role.toLowerCase()}-raw-token`,
      });
      const productRes = createMockResponse();

      await invokeRouter(customerRouter, productReq, productRes);
      assert.equal(productRes.statusCode, 403, `Role ${role} should receive 403 when POS is disabled`);
      assert.equal(productRes.body.code, "FEATURE_DISABLED");
      assert.match(productRes.body.error, /POS is disabled in INVENTORY_ONLY mode/i);
      assert.equal(customerQueried, false, `Customer query must not be reached for ${role} when POS is disabled`);
      assert.equal(historyQueried, false, `History query must not be reached for ${role} when POS is disabled`);
    }
  } finally {
    prisma.authSession.findUnique = originalFindUniqueSession;
    prisma.customer.findUnique = originalFindUniqueCustomer;
    (prisma as any).$transaction = originalTransaction;
    prisma.invoiceItem.findMany = originalFindMany;
    prisma.businessSettings.upsert = originalUpsertSettings;
    invalidateBusinessSettingsCache();
  }
});
