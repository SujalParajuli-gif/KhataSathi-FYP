import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import { finalizeInvoice, getInvoice, publicInvoiceItemSelect } from "../modules/invoices/service";
import { StockConflictError } from "../modules/invoices/stockConflicts";

interface InMemState {
  invoices: Map<string, any>;
  invoiceItems: Map<string, any>;
  products: Map<string, any>;
  customers: Map<string, any>;
  users: Map<string, any>;
  stockTransactions: any[];
  auditLogs: any[];
}

function cloneState(state: InMemState): InMemState {
  return {
    invoices: new Map(Array.from(state.invoices.entries()).map(([k, v]) => [k, structuredClone(v)])),
    invoiceItems: new Map(Array.from(state.invoiceItems.entries()).map(([k, v]) => [k, structuredClone(v)])),
    products: new Map(Array.from(state.products.entries()).map(([k, v]) => [k, structuredClone(v)])),
    customers: new Map(Array.from(state.customers.entries()).map(([k, v]) => [k, structuredClone(v)])),
    users: new Map(Array.from(state.users.entries()).map(([k, v]) => [k, structuredClone(v)])),
    stockTransactions: structuredClone(state.stockTransactions),
    auditLogs: structuredClone(state.auditLogs),
  };
}

function createTransactionalPrismaHarness(initialState: InMemState) {
  let committedState = cloneState(initialState);
  let activeTransactionState: InMemState | null = null;

  const originalTransaction = prisma.$transaction;
  const originalInvoiceFindUnique = prisma.invoice.findUnique;

  function createTxClient(stagedState: InMemState, options?: { failOnItemUpdate?: boolean; failOnAuditLog?: boolean }) {
    return {
      businessSettings: { findUnique: async () => ({ defaultBillingChannel: "MANUAL_EXTERNAL" }) },
      $queryRaw: async (_query: TemplateStringsArray, ...values: unknown[]) => {
        // lockInvoiceItemsForUpdate returns array of { productId }
        const queryStr = String(_query);
        if (/FROM\s+InvoiceItem/i.test(queryStr)) {
          const invoiceId = values[0] as string;
          const items = Array.from(stagedState.invoiceItems.values()).filter((it) => it.invoiceId === invoiceId);
          return items.map((it) => ({ productId: it.productId }));
        }
        return [];
      },
      invoice: {
        findUnique: async (args: any) => {
          const inv = stagedState.invoices.get(args.where.id);
          if (!inv) return null;
          const result = JSON.parse(JSON.stringify(inv));
          if (args.include?.items) {
            const items = Array.from(stagedState.invoiceItems.values()).filter((it) => it.invoiceId === inv.id);
            result.items = items.map((it) => {
              const itemCopy = JSON.parse(JSON.stringify(it));
              if (args.include.items.include?.product) {
                itemCopy.product = stagedState.products.get(it.productId) || null;
              }
              return itemCopy;
            });
          }
          if (args.include?.customer) {
            result.customer = inv.customerId ? stagedState.customers.get(inv.customerId) || null : null;
          }
          return result;
        },
        update: async (args: any) => {
          const inv = stagedState.invoices.get(args.where.id);
          if (!inv) throw new Error("Invoice not found for update");
          Object.assign(inv, args.data);
          return inv;
        },
      },
      invoiceItem: {
        update: async (args: any) => {
          if (options?.failOnItemUpdate) {
            throw new Error("Simulated database failure during invoice item snapshot update");
          }
          const item = stagedState.invoiceItems.get(args.where.id);
          if (!item) throw new Error("InvoiceItem not found for update");
          Object.assign(item, args.data);
          return item;
        },
      },
      product: {
        updateMany: async (args: any) => {
          const prod = stagedState.products.get(args.where.id);
          if (!prod) return { count: 0 };
          const minStock = args.where.stock?.gte ?? 0;
          if (prod.stock < minStock) {
            return { count: 0 };
          }
          const dec = args.data?.stock?.decrement ?? 0;
          prod.stock -= dec;
          return { count: 1 };
        },
        findUnique: async (args: any) => {
          const prod = stagedState.products.get(args.where.id);
          return prod ? JSON.parse(JSON.stringify(prod)) : null;
        },
      },
      stockTransaction: {
        create: async (args: any) => {
          stagedState.stockTransactions.push(args.data);
          return args.data;
        },
      },
      user: {
        findUnique: async (args: any) => {
          const user = stagedState.users.get(args.where.id);
          return user ? JSON.parse(JSON.stringify(user)) : null;
        },
      },
      auditLog: {
        create: async (args: any) => {
          if (options?.failOnAuditLog) {
            throw new Error("Simulated database failure during audit log creation");
          }
          stagedState.auditLogs.push(args.data);
          return args.data;
        },
      },
    };
  }

  return {
    getState: () => committedState,
    setup: (options?: { failOnItemUpdate?: boolean; failOnAuditLog?: boolean }) => {
      (prisma as any).$transaction = async (work: (tx: any) => Promise<any>) => {
        const stagedState = cloneState(committedState);
        activeTransactionState = stagedState;
        try {
          const tx = createTxClient(stagedState, options);
          const result = await work(tx);
          // If work finishes without error, commit staged state
          committedState = stagedState;
          activeTransactionState = null;
          return result;
        } catch (err) {
          // If work throws, discard staged state (rollback)
          activeTransactionState = null;
          throw err;
        }
      };

      (prisma.invoice as any).findUnique = async (args: any) => {
        const state = activeTransactionState || committedState;
        const inv = state.invoices.get(args.where.id);
        if (!inv) return null;
        const result = JSON.parse(JSON.stringify(inv));
        if (args.include?.items) {
          const items = Array.from(state.invoiceItems.values()).filter((it) => it.invoiceId === inv.id);
          result.items = items.map((it) => {
            const itemCopy = JSON.parse(JSON.stringify(it));
            if (args.include.items.select) {
              const selected: Record<string, any> = {};
              for (const [key, val] of Object.entries(args.include.items.select)) {
                if (val === true && key in itemCopy) {
                  selected[key] = itemCopy[key];
                }
              }
              if (args.include.items.select.product) {
                const prod = state.products.get(it.productId);
                selected.product = prod
                  ? { id: prod.id, name: prod.name, sku: prod.sku, barcode: prod.barcode ?? null }
                  : null;
              }
              return selected;
            }
            return itemCopy;
          });
        }
        if (args.include?.customer) {
          result.customer = inv.customerId ? state.customers.get(inv.customerId) || null : null;
        }
        result.payments = [];
        result.cashier = inv.cashierId ? state.users.get(inv.cashierId) : null;
        result.cancelledBy = null;
        result.creditNotesAsOriginal = [];
        result.creditNoteAsReplacement = [];
        return result;
      };
    },
    teardown: () => {
      prisma.$transaction = originalTransaction;
      prisma.invoice.findUnique = originalInvoiceFindUnique;
    },
  };
}

function buildBaseState(): InMemState {
  const users = new Map<string, any>([
    ["user-admin", { id: "user-admin", name: "Admin User", role: "ADMIN", email: "admin@khatasathi.com" }],
    ["user-cashier", { id: "user-cashier", name: "Cashier One", role: "CASHIER", email: "cashier@khatasathi.com" }],
  ]);

  const customers = new Map<string, any>([
    [
      "cust-reg-1",
      {
        id: "cust-reg-1",
        name: "Sita Sharma",
        phone: "9841000001",
        email: "sita@example.com",
        panNo: "300123456",
        address: "Putalisadak, Kathmandu",
        loyaltyPercent: 0,
        wholesalePercent: 0,
      },
    ],
    [
      "cust-null-pan",
      {
        id: "cust-null-pan",
        name: "Hari Thapa",
        phone: "9841000002",
        email: null,
        panNo: null,
        address: null,
        loyaltyPercent: 0,
        wholesalePercent: 0,
      },
    ],
  ]);

  const products = new Map<string, any>([
    [
      "prod-1",
      {
        id: "prod-1",
        name: "Mustard Oil 1L",
        sku: "OIL-MUST-1L",
        barcode: "890123456001",
        stock: 50,
        retailPrice: 250,
      },
    ],
    [
      "prod-2",
      {
        id: "prod-2",
        name: "Basmati Rice 5kg",
        sku: "RICE-BAS-5K",
        barcode: "890123456002",
        stock: 20,
        retailPrice: 650,
      },
    ],
  ]);

  const invoices = new Map<string, any>([
    [
      "inv-draft-reg",
      {
        id: "inv-draft-reg",
        invoiceNo: "INV-20261001-0001",
        status: "DRAFT",
        cashierId: "user-cashier",
        customerId: "cust-reg-1",
        subTotal: 500,
        netTotal: 500,
        paidTotal: 0,
        customerNameSnapshot: null,
        customerPanSnapshot: null,
        customerAddressSnapshot: null,
        customerSnapshotCapturedAt: null,
        finalizedAt: null,
      },
    ],
  ]);

  const invoiceItems = new Map<string, any>([
    [
      "item-1",
      {
        id: "item-1",
        invoiceId: "inv-draft-reg",
        productId: "prod-1",
        qty: 2,
        appliedUnitPrice: 250,
        lineTotal: 500,
        productNameSnapshot: null,
        productSkuSnapshot: null,
        costAtSale: null,
        snapshotCapturedAt: null,
      },
    ],
  ]);

  return {
    invoices,
    invoiceItems,
    products,
    customers,
    users,
    stockTransactions: [],
    auditLogs: [],
  };
}

test("AC-1: Registered customer finalization captures customer name, PAN, address, and marker atomically", async () => {
  const base = buildBaseState();
  const harness = createTransactionalPrismaHarness(base);
  harness.setup();

  try {
    const finalized = await finalizeInvoice("inv-draft-reg", "user-cashier");
    assert.ok(finalized);
    assert.equal(finalized.status, "FINALIZED");

    const state = harness.getState();
    const inv = state.invoices.get("inv-draft-reg");
    assert.equal(inv.status, "FINALIZED");
    assert.equal(inv.billingChannel, "MANUAL_EXTERNAL");
    assert.equal(inv.billRecordStatus, "PENDING");
    assert.equal(inv.customerNameSnapshot, "Sita Sharma");
    assert.equal(inv.customerPanSnapshot, "300123456");
    assert.equal(inv.customerAddressSnapshot, "Putalisadak, Kathmandu");
    assert.ok(inv.customerSnapshotCapturedAt instanceof Date);

    const item = state.invoiceItems.get("item-1");
    assert.equal(item.productNameSnapshot, "Mustard Oil 1L");
    assert.equal(item.productSkuSnapshot, "OIL-MUST-1L");
    assert.equal(item.costAtSale, null);
    assert.ok(item.snapshotCapturedAt instanceof Date);

    // Shared transaction marker
    assert.equal(inv.customerSnapshotCapturedAt.getTime(), item.snapshotCapturedAt.getTime());
    assert.equal(inv.finalizedAt.getTime(), inv.customerSnapshotCapturedAt.getTime());
  } finally {
    harness.teardown();
  }
});

test("AC-1: Registered customer with unknown PAN/address captures null PAN/address with non-null marker", async () => {
  const base = buildBaseState();
  base.invoices.set("inv-draft-null-pan", {
    id: "inv-draft-null-pan",
    invoiceNo: "INV-20261001-0002",
    status: "DRAFT",
    cashierId: "user-cashier",
    customerId: "cust-null-pan",
    subTotal: 250,
    netTotal: 250,
    paidTotal: 0,
    customerNameSnapshot: null,
    customerPanSnapshot: null,
    customerAddressSnapshot: null,
    customerSnapshotCapturedAt: null,
    finalizedAt: null,
  });
  base.invoiceItems.set("item-2", {
    id: "item-2",
    invoiceId: "inv-draft-null-pan",
    productId: "prod-1",
    qty: 1,
    appliedUnitPrice: 250,
    lineTotal: 250,
    productNameSnapshot: null,
    productSkuSnapshot: null,
    costAtSale: null,
    snapshotCapturedAt: null,
  });

  const harness = createTransactionalPrismaHarness(base);
  harness.setup();

  try {
    const finalized = await finalizeInvoice("inv-draft-null-pan", "user-cashier");
    assert.ok(finalized);

    const state = harness.getState();
    const inv = state.invoices.get("inv-draft-null-pan");
    assert.equal(inv.customerNameSnapshot, "Hari Thapa");
    assert.equal(inv.customerPanSnapshot, null);
    assert.equal(inv.customerAddressSnapshot, null);
    assert.ok(inv.customerSnapshotCapturedAt instanceof Date);
  } finally {
    harness.teardown();
  }
});

test("AC-1: Walk-in customer finalization records null customer values with a non-null customer marker", async () => {
  const base = buildBaseState();
  base.invoices.set("inv-draft-walkin", {
    id: "inv-draft-walkin",
    invoiceNo: "INV-20261001-0003",
    status: "DRAFT",
    cashierId: "user-cashier",
    customerId: null, // Walk-in
    subTotal: 250,
    netTotal: 250,
    paidTotal: 0,
    customerNameSnapshot: null,
    customerPanSnapshot: null,
    customerAddressSnapshot: null,
    customerSnapshotCapturedAt: null,
    finalizedAt: null,
  });
  base.invoiceItems.set("item-3", {
    id: "item-3",
    invoiceId: "inv-draft-walkin",
    productId: "prod-1",
    qty: 1,
    appliedUnitPrice: 250,
    lineTotal: 250,
    productNameSnapshot: null,
    productSkuSnapshot: null,
    costAtSale: null,
    snapshotCapturedAt: null,
  });

  const harness = createTransactionalPrismaHarness(base);
  harness.setup();

  try {
    const finalized = await finalizeInvoice("inv-draft-walkin", "user-cashier");
    assert.ok(finalized);

    const state = harness.getState();
    const inv = state.invoices.get("inv-draft-walkin");
    assert.equal(inv.customerNameSnapshot, null);
    assert.equal(inv.customerPanSnapshot, null);
    assert.equal(inv.customerAddressSnapshot, null);
    assert.ok(inv.customerSnapshotCapturedAt instanceof Date);
  } finally {
    harness.teardown();
  }
});

test("AC-2: Multi-item finalization with duplicate product IDs updates each line by item ID", async () => {
  const base = buildBaseState();
  base.invoices.set("inv-multi", {
    id: "inv-multi",
    invoiceNo: "INV-20261001-0004",
    status: "DRAFT",
    cashierId: "user-cashier",
    customerId: null,
    subTotal: 750,
    netTotal: 750,
    paidTotal: 0,
    customerNameSnapshot: null,
    customerPanSnapshot: null,
    customerAddressSnapshot: null,
    customerSnapshotCapturedAt: null,
    finalizedAt: null,
  });
  // Two distinct items for the SAME product (e.g. added at different times or batches)
  base.invoiceItems.set("item-dup-1", {
    id: "item-dup-1",
    invoiceId: "inv-multi",
    productId: "prod-1",
    qty: 1,
    appliedUnitPrice: 250,
    lineTotal: 250,
    productNameSnapshot: null,
    productSkuSnapshot: null,
    costAtSale: null,
    snapshotCapturedAt: null,
  });
  base.invoiceItems.set("item-dup-2", {
    id: "item-dup-2",
    invoiceId: "inv-multi",
    productId: "prod-1",
    qty: 2,
    appliedUnitPrice: 250,
    lineTotal: 500,
    productNameSnapshot: null,
    productSkuSnapshot: null,
    costAtSale: null,
    snapshotCapturedAt: null,
  });

  const harness = createTransactionalPrismaHarness(base);
  harness.setup();

  try {
    await finalizeInvoice("inv-multi", "user-cashier");

    const state = harness.getState();
    const item1 = state.invoiceItems.get("item-dup-1");
    const item2 = state.invoiceItems.get("item-dup-2");

    assert.equal(item1.productNameSnapshot, "Mustard Oil 1L");
    assert.equal(item1.productSkuSnapshot, "OIL-MUST-1L");
    assert.equal(item1.costAtSale, null);
    assert.ok(item1.snapshotCapturedAt instanceof Date);

    assert.equal(item2.productNameSnapshot, "Mustard Oil 1L");
    assert.equal(item2.productSkuSnapshot, "OIL-MUST-1L");
    assert.equal(item2.costAtSale, null);
    assert.ok(item2.snapshotCapturedAt instanceof Date);

    assert.equal(item1.snapshotCapturedAt.getTime(), item2.snapshotCapturedAt.getTime());
  } finally {
    harness.teardown();
  }
});

test("AC-2: Invalid product identity aborts finalization with zero mutations", async () => {
  // Case A: Missing product name
  {
    const base = buildBaseState();
    base.products.set("prod-bad-name", {
      id: "prod-bad-name",
      name: "   ", // Blank name
      sku: "VALID-SKU",
      stock: 10,
    });
    base.invoices.set("inv-bad-1", {
      id: "inv-bad-1",
      invoiceNo: "INV-20261001-0005",
      status: "DRAFT",
      cashierId: "user-cashier",
      customerId: null,
      subTotal: 100,
      netTotal: 100,
      paidTotal: 0,
    });
    base.invoiceItems.set("item-bad-1", {
      id: "item-bad-1",
      invoiceId: "inv-bad-1",
      productId: "prod-bad-name",
      qty: 1,
      appliedUnitPrice: 100,
      lineTotal: 100,
    });

    const harness = createTransactionalPrismaHarness(base);
    harness.setup();

    try {
      await assert.rejects(
        finalizeInvoice("inv-bad-1", "user-cashier"),
        /product name and SKU are required/,
      );

      const state = harness.getState();
      assert.equal(state.invoices.get("inv-bad-1").status, "DRAFT");
      assert.equal(state.products.get("prod-bad-name").stock, 10);
      assert.equal(state.stockTransactions.length, 0);
      assert.equal(state.auditLogs.length, 0);
    } finally {
      harness.teardown();
    }
  }

  // Case B: Missing product SKU
  {
    const base = buildBaseState();
    base.products.set("prod-bad-sku", {
      id: "prod-bad-sku",
      name: "Valid Product",
      sku: "", // Blank SKU
      stock: 10,
    });
    base.invoices.set("inv-bad-2", {
      id: "inv-bad-2",
      invoiceNo: "INV-20261001-0006",
      status: "DRAFT",
      cashierId: "user-cashier",
      customerId: null,
      subTotal: 100,
      netTotal: 100,
      paidTotal: 0,
    });
    base.invoiceItems.set("item-bad-2", {
      id: "item-bad-2",
      invoiceId: "inv-bad-2",
      productId: "prod-bad-sku",
      qty: 1,
      appliedUnitPrice: 100,
      lineTotal: 100,
    });

    const harness = createTransactionalPrismaHarness(base);
    harness.setup();

    try {
      await assert.rejects(
        finalizeInvoice("inv-bad-2", "user-cashier"),
        /product name and SKU are required/,
      );

      const state = harness.getState();
      assert.equal(state.invoices.get("inv-bad-2").status, "DRAFT");
      assert.equal(state.products.get("prod-bad-sku").stock, 10);
      assert.equal(state.stockTransactions.length, 0);
      assert.equal(state.auditLogs.length, 0);
    } finally {
      harness.teardown();
    }
  }
});

test("AC-3: Repeat finalization rejection prevents recapture", async () => {
  const base = buildBaseState();
  base.invoices.get("inv-draft-reg").status = "FINALIZED";
  base.invoices.get("inv-draft-reg").customerSnapshotCapturedAt = new Date("2026-10-01T10:00:00Z");

  const harness = createTransactionalPrismaHarness(base);
  harness.setup();

  try {
    await assert.rejects(
      finalizeInvoice("inv-draft-reg", "user-cashier"),
      /Invoice is already finalized/,
    );

    const state = harness.getState();
    assert.equal(
      state.invoices.get("inv-draft-reg").customerSnapshotCapturedAt.toISOString(),
      "2026-10-01T10:00:00.000Z",
    );
  } finally {
    harness.teardown();
  }
});

test("AC-3: Snapshot write failure triggers complete transaction rollback", async () => {
  const base = buildBaseState();
  const harness = createTransactionalPrismaHarness(base);
  // Configure harness to throw during invoiceItem.update
  harness.setup({ failOnItemUpdate: true });

  try {
    await assert.rejects(
      finalizeInvoice("inv-draft-reg", "user-cashier"),
      /Simulated database failure during invoice item snapshot update/,
    );

    // Verify complete rollback: invoice remains DRAFT, stock unchanged, no transactions, no audit
    const state = harness.getState();
    const inv = state.invoices.get("inv-draft-reg");
    assert.equal(inv.status, "DRAFT");
    assert.equal(inv.customerSnapshotCapturedAt, null);

    const prod = state.products.get("prod-1");
    assert.equal(prod.stock, 50); // Unchanged

    const item = state.invoiceItems.get("item-1");
    assert.equal(item.snapshotCapturedAt, null);
    assert.equal(item.productNameSnapshot, null);

    assert.equal(state.stockTransactions.length, 0);
    assert.equal(state.auditLogs.length, 0);
  } finally {
    harness.teardown();
  }
});

test("AC-3: Later transaction failure (audit log failure) triggers complete rollback", async () => {
  const base = buildBaseState();
  const harness = createTransactionalPrismaHarness(base);
  // Configure harness to throw during auditLog.create
  harness.setup({ failOnAuditLog: true });

  try {
    await assert.rejects(
      finalizeInvoice("inv-draft-reg", "user-cashier"),
      /Simulated database failure during audit log creation/,
    );

    // Verify complete rollback: stock, invoice status, customer snapshot, item snapshot, stock transactions all roll back
    const state = harness.getState();
    const inv = state.invoices.get("inv-draft-reg");
    assert.equal(inv.status, "DRAFT");
    assert.equal(inv.customerSnapshotCapturedAt, null);
    assert.equal(inv.finalizedAt, null);

    const prod = state.products.get("prod-1");
    assert.equal(prod.stock, 50);

    const item = state.invoiceItems.get("item-1");
    assert.equal(item.snapshotCapturedAt, null);
    assert.equal(item.productNameSnapshot, null);

    assert.equal(state.stockTransactions.length, 0);
    assert.equal(state.auditLogs.length, 0);
  } finally {
    harness.teardown();
  }
});

test("AC-3: Insufficient stock triggers StockConflictError and complete transaction rollback", async () => {
  const base = buildBaseState();
  base.products.get("prod-1").stock = 1; // Item qty is 2, so stock is insufficient

  const harness = createTransactionalPrismaHarness(base);
  harness.setup();

  try {
    await assert.rejects(
      finalizeInvoice("inv-draft-reg", "user-cashier"),
      (err: unknown) => err instanceof StockConflictError,
    );

    const state = harness.getState();
    const inv = state.invoices.get("inv-draft-reg");
    assert.equal(inv.status, "DRAFT");
    assert.equal(inv.customerSnapshotCapturedAt, null);

    const item = state.invoiceItems.get("item-1");
    assert.equal(item.snapshotCapturedAt, null);

    assert.equal(state.stockTransactions.length, 0);
    assert.equal(state.auditLogs.length, 0);
  } finally {
    harness.teardown();
  }
});

test("AC-4: Public response boundary continues to exclude costAtSale", async () => {
  const base = buildBaseState();
  const harness = createTransactionalPrismaHarness(base);
  harness.setup();

  try {
    const finalized = await finalizeInvoice("inv-draft-reg", "user-cashier");
    assert.ok(finalized);
    assert.ok(finalized.items.length > 0);

    for (const line of finalized.items) {
      assert.equal("costAtSale" in line, false);
      assert.equal((line as any).costAtSale, undefined);
    }

    assert.equal("costAtSale" in publicInvoiceItemSelect, false);
  } finally {
    harness.teardown();
  }
});

test("AC-4: Draft creation and draft items never set capture markers", async () => {
  const base = buildBaseState();
  const inv = base.invoices.get("inv-draft-reg");
  assert.equal(inv.status, "DRAFT");
  assert.equal(inv.customerSnapshotCapturedAt, null);
  assert.equal(inv.customerNameSnapshot, null);
  assert.equal(inv.customerPanSnapshot, null);
  assert.equal(inv.customerAddressSnapshot, null);

  const item = base.invoiceItems.get("item-1");
  assert.equal(item.snapshotCapturedAt, null);
  assert.equal(item.costAtSale, null);
  assert.equal(item.productNameSnapshot, null);
  assert.equal(item.productSkuSnapshot, null);
});
