import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import { cancelInvoice as cancelService, modifyFinalizedInvoice as modifyService, publicInvoiceItemSelect } from "../modules/invoices/service";
import { invalidateBusinessSettingsCache } from "../modules/settings/service";

const modifyFinalizedInvoice = (id: string, actor: string, input: Parameters<typeof modifyService>[2]) => modifyService(id, actor, { ...input, operationKey: randomUUID() });
const cancelInvoice = (id: string, actor: string) => cancelService(id, actor, randomUUID());

interface InMemState {
  invoices: Map<string, any>;
  invoiceItems: Map<string, any>;
  products: Map<string, any>;
  customers: Map<string, any>;
  users: Map<string, any>;
  creditNotes: Map<string, any>;
  corrections?: Map<string, any>;
  payments: any[];
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
    creditNotes: new Map(Array.from(state.creditNotes.entries()).map(([k, v]) => [k, structuredClone(v)])),
    corrections: new Map(Array.from(state.corrections?.entries() || []).map(([k,v]) => [k, structuredClone(v)])),
    payments: structuredClone(state.payments),
    stockTransactions: structuredClone(state.stockTransactions),
    auditLogs: structuredClone(state.auditLogs),
  };
}

function createTransactionalPrismaHarness(initialState: InMemState) {
  let committedState = cloneState(initialState);
  let activeTransactionState: InMemState | null = null;

  const originalTransaction = prisma.$transaction;
  const originalUser = prisma.user.findUnique;
  const originalCorrection = prisma.invoiceCorrectionSettlement.findUnique;
  const originalInvoiceFindUnique = prisma.invoice.findUnique;
  const originalBusinessSettingsUpsert = prisma.businessSettings.upsert;

  function createTxClient(
    stagedState: InMemState,
    options?: { failOnItemUpdate?: boolean; failOnAuditLog?: boolean },
  ) {
    let invoiceSeq = 100;
    let creditNoteSeq = 50;
    let itemSeq = 500;

    return {
      invoiceCorrectionSettlement: {
        findUnique: async (args: any) => [...stagedState.corrections!.values()].find(r => r.operationKey === args.where.operationKey) || null,
        create: async (args: any) => { const row = { id: randomUUID(), ...args.data }; stagedState.corrections!.set(row.id, row); return row; },
      },
      businessSettings: { findUnique: async () => ({ defaultBillingChannel: "MANUAL_EXTERNAL" }) },
      $queryRaw: async (_query: TemplateStringsArray, ...values: unknown[]) => {
        const queryStr = String(_query);
        if (/FROM\s+InvoiceItem/i.test(queryStr)) {
          const invoiceId = values[0] as string;
          const items = Array.from(stagedState.invoiceItems.values()).filter(
            (it) => it.invoiceId === invoiceId,
          );
          return items.map((it) => ({ productId: it.productId }));
        }
        return [];
      },
      invoiceSequence: {
        upsert: async () => {
          invoiceSeq += 1;
          return { lastNumber: invoiceSeq };
        },
      },
      creditNoteSequence: {
        upsert: async () => {
          creditNoteSeq += 1;
          return { lastNumber: creditNoteSeq };
        },
      },
      customerCreditApplication: { findFirst: async () => null, findMany: async () => [] },
      customerCreditPayout: { count: async () => 0 },
      returnRequest: {
        findFirst: async () => null,
      },
      invoice: {
        findFirst: async () => null,
        findUnique: async (args: any) => {
          const inv = stagedState.invoices.get(args.where.id);
          if (!inv) return null;
          const result = structuredClone(inv);
          if (args.include?.items) {
            const items = Array.from(stagedState.invoiceItems.values()).filter(
              (it) => it.invoiceId === inv.id,
            );
            result.items = items.map((it) => {
              const itemCopy = structuredClone(it);
              if (args.include.items.include?.product) {
                const prod = stagedState.products.get(it.productId);
                itemCopy.product = prod
                  ? { id: prod.id, name: prod.name, sku: prod.sku, barcode: prod.barcode ?? null }
                  : null;
              }
              if (args.include.items.select) {
                const selected: Record<string, any> = {};
                for (const [key, val] of Object.entries(args.include.items.select)) {
                  if (val === true && key in itemCopy) {
                    selected[key] = itemCopy[key];
                  }
                }
                if (args.include.items.select.product) {
                  const prod = stagedState.products.get(it.productId);
                  selected.product = prod
                    ? { id: prod.id, name: prod.name, sku: prod.sku, barcode: prod.barcode ?? null }
                    : null;
                }
                return selected;
              }
              return itemCopy;
            });
          }
          if (args.include?.payments) {
            result.payments = stagedState.payments.filter((p) => p.invoiceId === inv.id);
          }
          if (args.include?.customer) {
            result.customer = inv.customerId
              ? stagedState.customers.get(inv.customerId) || null
              : null;
          }
          result.cashier = inv.cashierId ? stagedState.users.get(inv.cashierId) : null;
          result.cancelledBy = inv.cancelledById ? stagedState.users.get(inv.cancelledById) : null;
          return result;
        },
        create: async (args: any) => {
          const id = `inv-repl-${++invoiceSeq}`;
          const newInv = {
            id,
            invoiceNo: args.data.invoiceNo,
            status: args.data.status || "DRAFT",
            cashierId: args.data.cashierId,
            customerId: args.data.customerId,
            subTotal: 0,
            netTotal: 0,
            paidTotal: 0,
            paymentStatus: "UNPAID",
            customerNameSnapshot: null,
            customerPanSnapshot: null,
            customerAddressSnapshot: null,
            customerSnapshotCapturedAt: null,
            finalizedAt: null,
            cancelledAt: null,
            cancelledById: null,
          };
          stagedState.invoices.set(id, newInv);
          return newInv;
        },
        update: async (args: any) => {
          const inv = stagedState.invoices.get(args.where.id);
          if (!inv) throw new Error("Invoice not found for update");
          Object.assign(inv, args.data);
          return inv;
        },
      },
      invoiceItem: {
        findMany: async (args: any) => {
          const invoiceId = args.where.invoiceId;
          const items = Array.from(stagedState.invoiceItems.values()).filter(
            (it) => it.invoiceId === invoiceId,
          );
          return items.map((it) => {
            const itemCopy = structuredClone(it);
            if (args.include?.product) {
              itemCopy.product = stagedState.products.get(it.productId) || null;
            }
            return itemCopy;
          });
        },
        create: async (args: any) => {
          const id = `item-repl-${++itemSeq}`;
          const newItem = {
            id,
            invoiceId: args.data.invoiceId,
            productId: args.data.productId,
            qty: args.data.qty,
            appliedUnitPrice: args.data.appliedUnitPrice,
            originalUnitPrice: args.data.appliedUnitPrice,
            overrideUnitPrice: null,
            overrideReason: null,
            overrideById: null,
            overrideAt: null,
            lineTotal: args.data.lineTotal,
            productNameSnapshot: null,
            productSkuSnapshot: null,
            costAtSale: null,
            snapshotCapturedAt: null,
            createdAt: new Date(),
          };
          stagedState.invoiceItems.set(id, newItem);
          return newItem;
        },
        update: async (args: any) => {
          if (options?.failOnItemUpdate) {
            throw new Error("Simulated database failure during replacement item update");
          }
          const item = stagedState.invoiceItems.get(args.where.id);
          if (!item) throw new Error("InvoiceItem not found for update");
          Object.assign(item, args.data);
          return item;
        },
      },
      product: {
        findMany: async (args: any) => {
          const ids = args.where?.id?.in || [];
          const prods = ids
            .map((id: string) => stagedState.products.get(id))
            .filter(Boolean);
          return structuredClone(prods);
        },
        findUnique: async (args: any) => {
          const prod = stagedState.products.get(args.where.id);
          return prod ? structuredClone(prod) : null;
        },
        update: async (args: any) => {
          const prod = stagedState.products.get(args.where.id);
          if (!prod) throw new Error("Product not found");
          if (args.data?.stock?.increment) {
            prod.stock += args.data.stock.increment;
          }
          return prod;
        },
        updateMany: async (args: any) => {
          const prod = stagedState.products.get(args.where.id);
          if (!prod) return { count: 0 };
          const minStock = args.where.stock?.gte ?? 0;
          if (prod.stock < minStock) return { count: 0 };
          const dec = args.data?.stock?.decrement ?? 0;
          prod.stock -= dec;
          return { count: 1 };
        },
      },
      customer: {
        findUnique: async (args: any) => {
          const cust = stagedState.customers.get(args.where.id);
          if (!cust) return null;
          const result: Record<string, any> = {};
          if (args.select) {
            for (const [key, val] of Object.entries(args.select)) {
              if (val === true && key in cust) result[key] = cust[key];
            }
            return result;
          }
          return structuredClone(cust);
        },
      },
      user: {
        findUnique: async (args: any) => {
          const user = stagedState.users.get(args.where.id);
          return user ? structuredClone(user) : null;
        },
      },
      creditNote: {
        findFirst: async () => null,
        create: async (args: any) => {
          const cn = {
            id: `cn-${++creditNoteSeq}`,
            creditNoteNo: args.data.creditNoteNo,
            originalInvoiceId: args.data.originalInvoiceId,
            replacementInvoiceId: args.data.replacementInvoiceId,
            reason: args.data.reason,
            originalNetTotal: args.data.originalNetTotal,
            originalPaidTotal: args.data.originalPaidTotal,
            replacementNetTotal: args.data.replacementNetTotal,
            creditedAmount: args.data.creditedAmount,
            createdById: args.data.createdById,
            originalInvoice: stagedState.invoices.get(args.data.originalInvoiceId),
            replacementInvoice: stagedState.invoices.get(args.data.replacementInvoiceId),
            createdBy: stagedState.users.get(args.data.createdById),
          };
          stagedState.creditNotes.set(cn.id, cn);
          return cn;
        },
      },
      payment: {
        create: async (args: any) => {
          stagedState.payments.push(args.data);
          return args.data;
        },
      },
      stockTransaction: {
        create: async (args: any) => {
          stagedState.stockTransactions.push(args.data);
          return args.data;
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
      invalidateBusinessSettingsCache();
      (prisma.user as any).findUnique = async (args: any) => ({ ...committedState.users.get(args.where.id), isActive: true });
      (prisma.invoiceCorrectionSettlement as any).findUnique = async (args: any) => [...committedState.corrections!.values()].find(r => r.operationKey === args.where.operationKey) || null;
      (prisma.businessSettings as any).upsert = async () => ({
        id: 1,
        businessMode: "FULL_POS",
        staffDraftRequestsEnabled: true,
        defaultInitialStock: 30,
        defaultLowStockThreshold: 5,
        defaultWholesaleQtyThreshold: 15,
        loyaltyDiscountPercent: 0,
        returnWindowDays: 7,
        parkedBillExpiryHours: 8,
        draftRequestExpiryMinutes: 30,
      });

      (prisma as any).$transaction = async (work: (tx: any) => Promise<any>) => {
        const stagedState = cloneState(committedState);
        activeTransactionState = stagedState;
        try {
          const tx = createTxClient(stagedState, options);
          const result = await work(tx);
          committedState = stagedState;
          activeTransactionState = null;
          return result;
        } catch (err) {
          activeTransactionState = null;
          throw err;
        }
      };

      (prisma.invoice as any).findUnique = async (args: any) => {
        const state = activeTransactionState || committedState;
        const inv = state.invoices.get(args.where.id);
        if (!inv) return null;
        const result = structuredClone(inv);
        if (args.include?.items) {
          const items = Array.from(state.invoiceItems.values()).filter(
            (it) => it.invoiceId === inv.id,
          );
          result.items = items.map((it) => {
            const itemCopy = structuredClone(it);
            if (args.include.items.select) {
              const selected: Record<string, any> = {};
              for (const [key, val] of Object.entries(args.include.items.select)) {
                if (val === true && key in itemCopy) selected[key] = itemCopy[key];
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
        return result;
      };
    },
    teardown: () => {
      prisma.user.findUnique = originalUser;
      prisma.invoiceCorrectionSettlement.findUnique = originalCorrection;
      prisma.$transaction = originalTransaction;
      prisma.invoice.findUnique = originalInvoiceFindUnique;
      prisma.businessSettings.upsert = originalBusinessSettingsUpsert;
      invalidateBusinessSettingsCache();
    },
  };
}

function buildBaseCorrectionState(): InMemState {
  const users = new Map<string, any>([
    ["user-admin", { id: "user-admin", name: "Admin User", role: "ADMIN" }],
    ["user-cashier", { id: "user-cashier", name: "Cashier One", role: "CASHIER" }],
  ]);

  const customers = new Map<string, any>([
    [
      "cust-orig",
      {
        id: "cust-orig",
        name: "Original Customer",
        panNo: "123456789",
        address: "Kathmandu",
        isActive: true,
        loyaltyPercent: 0,
        wholesalePercent: 0,
      },
    ],
    [
      "cust-new",
      {
        id: "cust-new",
        name: "New Customer",
        panNo: "987654321",
        address: "Lalitpur",
        isActive: true,
        loyaltyPercent: 0,
        wholesalePercent: 0,
      },
    ],
    [
      "cust-null-pan",
      {
        id: "cust-null-pan",
        name: "Customer No PAN",
        panNo: null,
        address: null,
        isActive: true,
        loyaltyPercent: 0,
        wholesalePercent: 0,
      },
    ],
  ]);

  const products = new Map<string, any>([
    [
      "prod-retained",
      {
        id: "prod-retained",
        name: "Mustard Oil 1L (Catalog Updated)", // Current catalog name changed
        sku: "OIL-1L-NEW-SKU", // Current catalog SKU changed
        stock: 50,
        isActive: true,
        retailPrice: 200,
        wholesalePrice: 190,
        wholesaleEligible: true,
      },
    ],
    [
      "prod-new",
      {
        id: "prod-new",
        name: "Sunflower Oil 1L",
        sku: "SUN-1L",
        stock: 30,
        isActive: true,
        retailPrice: 220,
        wholesalePrice: 210,
        wholesaleEligible: true,
      },
    ],
    [
      "prod-removed",
      {
        id: "prod-removed",
        name: "Salt 1kg",
        sku: "SALT-1K",
        stock: 40,
        isActive: true,
        retailPrice: 30,
        wholesalePrice: 25,
        wholesaleEligible: true,
      },
    ],
  ]);

  const originalTime = new Date("2026-09-15T10:00:00.000Z");

  const invoices = new Map<string, any>([
    [
      "inv-orig-1",
      {
        id: "inv-orig-1",
        invoiceNo: "INV-20260915-0001",
        status: "FINALIZED",
        paymentStatus: "PAID",
        cashierId: "user-cashier",
        customerId: "cust-orig",
        subTotal: 430,
        netTotal: 430,
        paidTotal: 430,
        customerNameSnapshot: "Original Customer",
        customerPanSnapshot: "123456789",
        customerAddressSnapshot: "Kathmandu",
        customerSnapshotCapturedAt: originalTime,
        finalizedAt: originalTime,
        cancelledAt: null,
        cancelledById: null,
      },
    ],
  ]);

  const invoiceItems = new Map<string, any>([
    [
      "item-orig-retained",
      {
        id: "item-orig-retained",
        invoiceId: "inv-orig-1",
        productId: "prod-retained",
        qty: 2,
        appliedUnitPrice: 200,
        lineTotal: 400,
        productNameSnapshot: "Mustard Oil 1L (Historical)",
        productSkuSnapshot: "OIL-1L-HIST",
        costAtSale: null,
        snapshotCapturedAt: originalTime,
        createdAt: originalTime,
      },
    ],
    [
      "item-orig-removed",
      {
        id: "item-orig-removed",
        invoiceId: "inv-orig-1",
        productId: "prod-removed",
        qty: 1,
        appliedUnitPrice: 30,
        lineTotal: 30,
        productNameSnapshot: "Salt 1kg (Historical)",
        productSkuSnapshot: "SALT-1K-HIST",
        costAtSale: null,
        snapshotCapturedAt: originalTime,
        createdAt: originalTime,
      },
    ],
  ]);

  const payments = [
    {
      id: "receipt-original",
      createdById: "user-cashier",
      createdAt: new Date("2026-09-15T10:00:00Z"),
      invoiceId: "inv-orig-1",
      method: "CASH",
      amount: 430,
      status: "SUCCESS",
      kind: "CHARGE",
    },
  ];

  return {
    invoices,
    invoiceItems,
    products,
    customers,
    users,
    creditNotes: new Map(),
    payments,
    stockTransactions: [],
    auditLogs: [],
  };
}

test("AC-1: Retained lines inherit identical original snapshot tuple for unchanged and changed quantity", async () => {
  const base = buildBaseCorrectionState();
  const harness = createTransactionalPrismaHarness(base);
  harness.setup();

  try {
    // Retain prod-retained with modified quantity (was 2, now 3)
    const result = await modifyFinalizedInvoice("inv-orig-1", "user-cashier", {
      reason: "Customer wanted 3 units instead of 2",
      items: [{ productId: "prod-retained", qty: 3 }],
    });

    assert.ok(result);
    const state = harness.getState();

    // Verify original invoice was cancelled and its snapshots were NOT modified
    const originalInv = state.invoices.get("inv-orig-1");
    assert.equal(originalInv.paymentStatus, "CANCELLED");
    assert.equal(originalInv.customerNameSnapshot, "Original Customer");
    assert.equal(originalInv.customerPanSnapshot, "123456789");
    assert.equal(originalInv.customerSnapshotCapturedAt.toISOString(), "2026-09-15T10:00:00.000Z");

    const originalItem = state.invoiceItems.get("item-orig-retained");
    assert.equal(originalItem.productNameSnapshot, "Mustard Oil 1L (Historical)");
    assert.equal(originalItem.productSkuSnapshot, "OIL-1L-HIST");
    assert.equal(originalItem.snapshotCapturedAt.toISOString(), "2026-09-15T10:00:00.000Z");

    // Verify replacement line inherited original tuple exactly (NOT current catalog name/SKU)
    const replInv = result.replacementInvoice;
    assert.ok(replInv);
    const replItems = Array.from(state.invoiceItems.values()).filter(
      (it) => it.invoiceId === replInv.id,
    );
    assert.equal(replItems.length, 1);
    const replItem = replItems[0];
    assert.equal(replItem.qty, 3);
    assert.equal(replItem.productNameSnapshot, "Mustard Oil 1L (Historical)");
    assert.equal(replItem.productSkuSnapshot, "OIL-1L-HIST");
    assert.equal(replItem.costAtSale, null);
    assert.equal(replItem.snapshotCapturedAt.toISOString(), "2026-09-15T10:00:00.000Z");
  } finally {
    harness.teardown();
  }
});

test("AC-2: New products capture current identity, null cost, and correction marker; removed products are omitted", async () => {
  const base = buildBaseCorrectionState();
  const harness = createTransactionalPrismaHarness(base);
  harness.setup();

  try {
    // Modify: keep prod-retained, remove prod-removed, add prod-new
    const result = await modifyFinalizedInvoice("inv-orig-1", "user-cashier", {
      reason: "Replaced salt with sunflower oil",
      items: [
        { productId: "prod-retained", qty: 2 },
        { productId: "prod-new", qty: 1 },
      ],
    });

    const state = harness.getState();
    const replInv = result.replacementInvoice;
    assert.ok(replInv);
    const replItems = Array.from(state.invoiceItems.values()).filter(
      (it) => it.invoiceId === replInv.id,
    );
    assert.equal(replItems.length, 2);

    // Retained line inherited
    const retainedLine = replItems.find((it) => it.productId === "prod-retained");
    assert.ok(retainedLine);
    assert.equal(retainedLine.productNameSnapshot, "Mustard Oil 1L (Historical)");
    assert.equal(retainedLine.productSkuSnapshot, "OIL-1L-HIST");
    assert.equal(retainedLine.snapshotCapturedAt.toISOString(), "2026-09-15T10:00:00.000Z");

    // New product line captured current catalog values
    const newLine = replItems.find((it) => it.productId === "prod-new");
    assert.ok(newLine);
    assert.equal(newLine.productNameSnapshot, "Sunflower Oil 1L");
    assert.equal(newLine.productSkuSnapshot, "SUN-1L");
    assert.equal(newLine.costAtSale, null);
    assert.ok(newLine.snapshotCapturedAt instanceof Date);
    assert.notEqual(newLine.snapshotCapturedAt.toISOString(), "2026-09-15T10:00:00.000Z");

    // Removed line has no replacement line
    const removedLine = replItems.find((it) => it.productId === "prod-removed");
    assert.equal(removedLine, undefined);
  } finally {
    harness.teardown();
  }
});

test("AC-2: Invalid new product identity aborts correction with zero mutations", async () => {
  const base = buildBaseCorrectionState();
  base.products.set("prod-bad-new", {
    id: "prod-bad-new",
    name: "   ", // Blank name
    sku: "BAD-SKU",
    stock: 10,
    isActive: true,
    retailPrice: 50,
    wholesalePrice: 45,
    wholesaleEligible: true,
  });

  const harness = createTransactionalPrismaHarness(base);
  harness.setup();

  try {
    await assert.rejects(
      modifyFinalizedInvoice("inv-orig-1", "user-cashier", {
        reason: "Adding bad product",
        items: [{ productId: "prod-bad-new", qty: 1 }],
      }),
      /product name and SKU are required for new line item/,
    );

    // Verify zero mutations committed: original invoice remains PAID/FINALIZED, stock unchanged
    const state = harness.getState();
    const orig = state.invoices.get("inv-orig-1");
    assert.equal(orig.paymentStatus, "PAID");
    assert.equal(state.creditNotes.size, 0);
  } finally {
    harness.teardown();
  }
});

test("AC-3: Customer inheritance handles same customer, changed customer, and walk-in transition", async () => {
  // Case A: Same customer preserves original snapshot and marker
  {
    const base = buildBaseCorrectionState();
    const harness = createTransactionalPrismaHarness(base);
    harness.setup();

    try {
      const result = await modifyFinalizedInvoice("inv-orig-1", "user-cashier", {
        customerId: "cust-orig",
        items: [{ productId: "prod-retained", qty: 1 }],
      });
      assert.ok(result.replacementInvoice);
      const state = harness.getState();
      const repl = state.invoices.get(result.replacementInvoice.id);
      assert.equal(repl.customerNameSnapshot, "Original Customer");
      assert.equal(repl.customerPanSnapshot, "123456789");
      assert.equal(repl.customerAddressSnapshot, "Kathmandu");
      assert.equal(repl.customerSnapshotCapturedAt.toISOString(), "2026-09-15T10:00:00.000Z");
    } finally {
      harness.teardown();
    }
  }

  // Case B: Changed to another registered customer captures current fields and new marker
  {
    const base = buildBaseCorrectionState();
    const harness = createTransactionalPrismaHarness(base);
    harness.setup();

    try {
      const result = await modifyFinalizedInvoice("inv-orig-1", "user-cashier", {
        customerId: "cust-new",
        items: [{ productId: "prod-retained", qty: 1 }],
      });
      assert.ok(result.replacementInvoice);
      const state = harness.getState();
      const repl = state.invoices.get(result.replacementInvoice.id);
      assert.equal(repl.customerNameSnapshot, "New Customer");
      assert.equal(repl.customerPanSnapshot, "987654321");
      assert.equal(repl.customerAddressSnapshot, "Lalitpur");
      assert.ok(repl.customerSnapshotCapturedAt instanceof Date);
      assert.notEqual(repl.customerSnapshotCapturedAt.toISOString(), "2026-09-15T10:00:00.000Z");
    } finally {
      harness.teardown();
    }
  }

  // Case C: Changed to walk-in captures null customer values with new marker
  {
    const base = buildBaseCorrectionState();
    const harness = createTransactionalPrismaHarness(base);
    harness.setup();

    try {
      const result = await modifyFinalizedInvoice("inv-orig-1", "user-cashier", {
        customerId: null, // Walk-in
        items: [{ productId: "prod-retained", qty: 1 }],
      });
      assert.ok(result.replacementInvoice);
      const state = harness.getState();
      const repl = state.invoices.get(result.replacementInvoice.id);
      assert.equal(repl.customerNameSnapshot, null);
      assert.equal(repl.customerPanSnapshot, null);
      assert.equal(repl.customerAddressSnapshot, null);
      assert.ok(repl.customerSnapshotCapturedAt instanceof Date);
      assert.notEqual(repl.customerSnapshotCapturedAt.toISOString(), "2026-09-15T10:00:00.000Z");
    } finally {
      harness.teardown();
    }
  }
});

test("AC-3: Legacy original with null markers inherits null markers without fabricating snapshots", async () => {
  const base = buildBaseCorrectionState();
  const orig = base.invoices.get("inv-orig-1");
  orig.customerNameSnapshot = null;
  orig.customerPanSnapshot = null;
  orig.customerAddressSnapshot = null;
  orig.customerSnapshotCapturedAt = null;

  const item = base.invoiceItems.get("item-orig-retained");
  item.productNameSnapshot = null;
  item.productSkuSnapshot = null;
  item.costAtSale = null;
  item.snapshotCapturedAt = null;

  const harness = createTransactionalPrismaHarness(base);
  harness.setup();

  try {
    const result = await modifyFinalizedInvoice("inv-orig-1", "user-cashier", {
      reason: "Correction of legacy invoice",
      items: [{ productId: "prod-retained", qty: 1 }],
    });

    assert.ok(result.replacementInvoice);
    const state = harness.getState();
    const repl = state.invoices.get(result.replacementInvoice.id);
    assert.equal(repl.customerNameSnapshot, null);
    assert.equal(repl.customerSnapshotCapturedAt, null);

    const replItem = Array.from(state.invoiceItems.values()).find(
      (it) => it.invoiceId === repl.id,
    );
    assert.ok(replItem);
    assert.equal(replItem.productNameSnapshot, null);
    assert.equal(replItem.productSkuSnapshot, null);
    assert.equal(replItem.costAtSale, null);
    assert.equal(replItem.snapshotCapturedAt, null);
  } finally {
    harness.teardown();
  }
});

test("AC-4: Conflicting duplicate original lines reject safely before financial mutation", async () => {
  const base = buildBaseCorrectionState();
  // Add a second original line for prod-retained with DIFFERENT historical snapshot name
  base.invoiceItems.set("item-orig-retained-dup", {
    id: "item-orig-retained-dup",
    invoiceId: "inv-orig-1",
    productId: "prod-retained",
    qty: 1,
    appliedUnitPrice: 200,
    lineTotal: 200,
    productNameSnapshot: "Mustard Oil 1L (Old 2025 Batch)", // Conflicting name
    productSkuSnapshot: "OIL-1L-HIST",
    costAtSale: null,
    snapshotCapturedAt: new Date("2026-09-15T10:00:00.000Z"),
  });

  const harness = createTransactionalPrismaHarness(base);
  harness.setup();

  try {
    await assert.rejects(
      modifyFinalizedInvoice("inv-orig-1", "user-cashier", {
        reason: "Modifying invoice with conflicting lines",
        items: [{ productId: "prod-retained", qty: 2 }],
      }),
      /conflicting historical snapshots found for retained product/,
    );

    // Verify zero mutations committed
    const state = harness.getState();
    assert.equal(state.creditNotes.size, 0);
    assert.equal(state.invoices.get("inv-orig-1").paymentStatus, "PAID");
  } finally {
    harness.teardown();
  }
});

test("AC-4: Identical duplicate original lines inherit safely and record matching source line IDs in audit", async () => {
  const base = buildBaseCorrectionState();
  // Add a second original line for prod-retained with IDENTICAL historical snapshot tuple
  base.invoiceItems.set("item-orig-retained-dup", {
    id: "item-orig-retained-dup",
    invoiceId: "inv-orig-1",
    productId: "prod-retained",
    qty: 1,
    appliedUnitPrice: 200,
    lineTotal: 200,
    productNameSnapshot: "Mustard Oil 1L (Historical)", // Identical
    productSkuSnapshot: "OIL-1L-HIST", // Identical
    costAtSale: null, // Identical
    snapshotCapturedAt: new Date("2026-09-15T10:00:00.000Z"), // Identical
  });

  const harness = createTransactionalPrismaHarness(base);
  harness.setup();

  try {
    const result = await modifyFinalizedInvoice("inv-orig-1", "user-cashier", {
      reason: "Merging duplicate lines into single replacement line",
      items: [{ productId: "prod-retained", qty: 3 }],
    });

    assert.ok(result.replacementInvoice);
    const replId = result.replacementInvoice.id;
    const state = harness.getState();
    const replItem = Array.from(state.invoiceItems.values()).find(
      (it) => it.invoiceId === replId,
    );
    assert.ok(replItem);
    assert.equal(replItem.productNameSnapshot, "Mustard Oil 1L (Historical)");
    assert.equal(replItem.productSkuSnapshot, "OIL-1L-HIST");
    assert.equal(replItem.snapshotCapturedAt.toISOString(), "2026-09-15T10:00:00.000Z");

    // Verify audit log includes lineage with both source item IDs
    const audit = state.auditLogs.find(
      (a) => a.action === "INVOICE_MODIFIED_WITH_CREDIT_NOTE",
    );
    assert.ok(audit);
    assert.ok(audit.meta.lineInheritance);
    const lineInfo = audit.meta.lineInheritance.find(
      (l: any) => l.productId === "prod-retained",
    );
    assert.ok(lineInfo);
    assert.deepEqual(
      lineInfo.sourceOriginalItemIds.sort(),
      ["item-orig-retained", "item-orig-retained-dup"].sort(),
    );
  } finally {
    harness.teardown();
  }
});

test("AC-4: Failure during item snapshot update rolls back entire transaction", async () => {
  const base = buildBaseCorrectionState();
  const harness = createTransactionalPrismaHarness(base);
  harness.setup({ failOnItemUpdate: true });

  try {
    await assert.rejects(
      modifyFinalizedInvoice("inv-orig-1", "user-cashier", {
        reason: "Testing item update failure rollback",
        items: [{ productId: "prod-retained", qty: 1 }],
      }),
      /Simulated database failure during replacement item update/,
    );

    // Verify complete rollback: original invoice remains PAID, no credit notes, no replacement
    const state = harness.getState();
    assert.equal(state.invoices.get("inv-orig-1").paymentStatus, "PAID");
    assert.equal(state.invoices.get("inv-orig-1").cancelledAt, null);
    assert.equal(state.creditNotes.size, 0);
  } finally {
    harness.teardown();
  }
});

test("AC-4: Failure during audit log creation rolls back entire transaction", async () => {
  const base = buildBaseCorrectionState();
  const harness = createTransactionalPrismaHarness(base);
  harness.setup({ failOnAuditLog: true });

  try {
    await assert.rejects(
      modifyFinalizedInvoice("inv-orig-1", "user-cashier", {
        reason: "Testing audit log failure rollback",
        items: [{ productId: "prod-retained", qty: 1 }],
      }),
      /Simulated database failure during audit log creation/,
    );

    const state = harness.getState();
    assert.equal(state.invoices.get("inv-orig-1").paymentStatus, "PAID");
    assert.equal(state.invoices.get("inv-orig-1").cancelledAt, null);
    assert.equal(state.creditNotes.size, 0);
  } finally {
    harness.teardown();
  }
});

test("AC-5: Public response boundary continues to exclude costAtSale from replacement items", async () => {
  const base = buildBaseCorrectionState();
  const harness = createTransactionalPrismaHarness(base);
  harness.setup();

  try {
    const result = await modifyFinalizedInvoice("inv-orig-1", "user-cashier", {
      reason: "Testing privacy boundary",
      items: [
        { productId: "prod-retained", qty: 1 },
        { productId: "prod-new", qty: 1 },
      ],
    });

    assert.ok(result.replacementInvoice);
    for (const item of result.replacementInvoice.items) {
      assert.equal("costAtSale" in item, false);
      assert.equal((item as any).costAtSale, undefined);
    }

    assert.equal("costAtSale" in publicInvoiceItemSelect, false);
  } finally {
    harness.teardown();
  }
});

test("AC-6: Correction audit lineage contains no PAN, address, or cost values", async () => {
  const base = buildBaseCorrectionState();
  const harness = createTransactionalPrismaHarness(base);
  harness.setup();

  try {
    await modifyFinalizedInvoice("inv-orig-1", "user-cashier", {
      reason: "Checking audit privacy",
      items: [{ productId: "prod-retained", qty: 1 }],
    });

    const state = harness.getState();
    const audit = state.auditLogs.find(
      (a) => a.action === "INVOICE_MODIFIED_WITH_CREDIT_NOTE",
    );
    assert.ok(audit);
    const metaStr = JSON.stringify(audit.meta);
    assert.equal(metaStr.includes("123456789"), false); // No PAN
    assert.equal(metaStr.includes("Kathmandu"), false); // No address
    assert.equal(metaStr.includes("costAtSale"), false); // No cost
  } finally {
    harness.teardown();
  }
});

for (const status of ["PENDING", "MISSING", "RECORDED", "VERIFIED"] as const) {
  test(`manual replacement retains original ${status} proof/reference and starts its own obligation`, async () => {
    const base = buildBaseCorrectionState();
    const original = base.invoices.get("inv-orig-1");
    original.billingChannel = "MANUAL_EXTERNAL";
    original.billRecordStatus = status;
    original.externalBillNo = status === "RECORDED" || status === "VERIFIED" ? "ORIGINAL-PAPER" : null;
    const mock = createTransactionalPrismaHarness(base);
    mock.setup();
    try {
      const result = await modifyFinalizedInvoice(original.id, "user-cashier", {
        reason: "Correct original sale", items: [{ productId: "prod-retained", qty: 1 }],
      });
      const state = mock.getState();
      const retained = state.invoices.get(original.id);
      const replacement = state.invoices.get(result.replacementInvoice!.id);
      assert.equal(retained.billRecordStatus, status === "PENDING" || status === "MISSING" ? null : status);
      assert.equal(retained.externalBillNo, original.externalBillNo);
      assert.equal(replacement.billingChannel, "MANUAL_EXTERNAL");
      assert.equal(replacement.billRecordStatus, "PENDING");
      assert.ok(replacement.externalBillNo == null);
      assert.equal(state.auditLogs.filter((a: any) => a.action === "MANUAL_BILL_OBLIGATION_CLEARED").length,
        status === "PENDING" || status === "MISSING" ? 1 : 0);
    } finally { mock.teardown(); }
  });
}

for (const status of ["PENDING", "MISSING", "RECORDED", "VERIFIED"] as const) {
  test(`cancelInvoice clears only ${status} obligation and keeps financial reversal unchanged`, async () => {
    const base = buildBaseCorrectionState();
    const original = base.invoices.get("inv-orig-1");
    original.billingChannel = "MANUAL_EXTERNAL";
    original.billRecordStatus = status;
    original.externalBillNo = status === "RECORDED" || status === "VERIFIED" ? "RETAIN-PAPER" : null;
    const before = structuredClone(base);
    const mock = createTransactionalPrismaHarness(base); mock.setup();
    try {
      await cancelInvoice(original.id, "user-cashier");
      const state = mock.getState(); const cancelled = state.invoices.get(original.id);
      assert.equal(cancelled.paymentStatus, "CANCELLED");
      assert.equal(cancelled.billRecordStatus, status === "PENDING" || status === "MISSING" ? null : status);
      assert.equal(cancelled.externalBillNo, original.externalBillNo);
      assert.equal(cancelled.netTotal, original.netTotal);
      assert.deepEqual(state.payments, before.payments);
      const items = [...before.invoiceItems.values()].filter((i: any) => i.invoiceId === original.id);
      for (const item of items) {
        assert.equal(state.products.get(item.productId).stock, before.products.get(item.productId).stock + item.qty);
      }
      assert.equal(state.stockTransactions.length - before.stockTransactions.length, items.length);
      assert.equal(state.auditLogs.filter((a: any) => a.action === "MANUAL_BILL_OBLIGATION_CLEARED").length,
        status === "PENDING" || status === "MISSING" ? 1 : 0);
    } finally { mock.teardown(); }
  });
}
