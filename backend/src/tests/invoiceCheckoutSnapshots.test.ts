import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import { checkoutInvoice } from "../modules/invoices/service";
import { invalidateBusinessSettingsCache } from "../modules/settings/service";

type State = {
  invoices: Record<string, any>;
  items: Record<string, any>;
  products: Record<string, any>;
  operations: Record<string, any>;
  payments: any[];
  stock: any[];
  audits: any[];
};

function harness(options: {
  parked?: boolean;
  nullPan?: boolean;
  failAt?: "snapshot" | "payment" | "audit" | "operation";
  invalid?: "name" | "sku";
} = {}) {
  let state: State = {
    invoices: options.parked ? {
      parked: { id: "parked", invoiceNo: "PARK-1", status: "DRAFT", cashierId: "cashier", customerId: null, customerSnapshotCapturedAt: null },
    } : {},
    items: options.parked ? {
      old: { id: "old", invoiceId: "parked", productId: "p1", qty: 1, lineTotal: 10, snapshotCapturedAt: null },
    } : {},
    products: {
      p1: { id: "p1", name: options.invalid === "name" ? "  " : "Current one", sku: options.invalid === "sku" ? "  " : "SKU-1", stock: 20, reservedStock: options.parked ? 1 : 0, isActive: true, retailPrice: 10, wholesalePrice: 10, wholesaleEligible: false },
      p2: { id: "p2", name: "Current two", sku: "SKU-2", stock: 20, reservedStock: 0, isActive: true, retailPrice: 20, wholesalePrice: 20, wholesaleEligible: false },
    },
    operations: {}, payments: [], stock: [], audits: [],
  };
  const originalTransaction = prisma.$transaction;
  const originalOperationFind = prisma.checkoutOperation.findUnique;
  const originalSettings = prisma.businessSettings.upsert;
  let itemWrites = 0;
  let nextInvoice = 0;
  let nextItem = 0;

  invalidateBusinessSettingsCache();
  (prisma.businessSettings as any).upsert = async () => ({
    businessMode: "FULL_POS", defaultWholesaleQtyThreshold: 15,
    loyaltyDiscountPercent: 0, parkedBillExpiryHours: 8,
  });
  (prisma.checkoutOperation as any).findUnique = async ({ where }: any) => state.operations[where.operationKey] ?? null;
  (prisma as any).$transaction = async (work: (tx: any) => Promise<any>) => {
    const staged: State = structuredClone(state);
    const invoiceView = (id: string, args: any) => {
      const invoice = staged.invoices[id];
      if (!invoice) return null;
      const result = structuredClone(invoice);
      if (args.include?.items) {
        result.items = Object.values(staged.items).filter((item: any) => item.invoiceId === id).map((item: any) => {
          const line = structuredClone(item);
          if (args.include.items.select) {
            const selected: any = {};
            for (const [key, enabled] of Object.entries(args.include.items.select)) {
              if (enabled === true && key in line) selected[key] = line[key];
            }
            const product = staged.products[item.productId];
            selected.product = { id: product.id, name: product.name, sku: product.sku, barcode: product.barcode ?? null };
            return selected;
          }
          if (args.include.items.include?.product) line.product = { ...staged.products[item.productId] };
          return line;
        });
      }
      if (args.include?.customer) result.customer = invoice.customerId
        ? { id: "customer", name: "Selected customer", panNo: options.nullPan ? null : "001234", address: null, isActive: true, loyaltyPercent: 0, wholesalePercent: 0 }
        : null;
      if (args.include?.payments) result.payments = staged.payments.filter((p) => p.invoiceId === id);
      return result;
    };
    const tx: any = {
      $queryRaw: async () => [],
      invoiceSequence: { upsert: async () => ({ lastNumber: ++nextInvoice }) },
      invoice: {
        findFirst: async () => null,
        findUnique: async (args: any) => invoiceView(args.where.id, args),
        findUniqueOrThrow: async (args: any) => invoiceView(args.where.id, args),
        create: async ({ data }: any) => {
          const invoice = { id: `invoice-${++nextInvoice}`, ...data, customerSnapshotCapturedAt: null };
          staged.invoices[invoice.id] = invoice;
          return invoice;
        },
        update: async ({ where, data }: any) => Object.assign(staged.invoices[where.id], data),
      },
      invoiceItem: {
        findMany: async ({ where }: any) => Object.values(staged.items).filter((item: any) => item.invoiceId === where.invoiceId),
        deleteMany: async ({ where }: any) => {
          for (const [id, item] of Object.entries(staged.items)) if (item.invoiceId === where.invoiceId) delete staged.items[id];
        },
        create: async ({ data }: any) => {
          const item = {
            id: `item-${++nextItem}`, ...data, createdAt: new Date(),
            originalUnitPrice: data.originalUnitPrice ?? null,
            overrideUnitPrice: data.overrideUnitPrice ?? null,
            overrideReason: data.overrideReason ?? null,
            overrideById: data.overrideById ?? null,
            overrideAt: data.overrideAt ?? null,
            snapshotCapturedAt: null, costAtSale: null,
          };
          staged.items[item.id] = item;
          return item;
        },
        update: async ({ where, data }: any) => {
          if (options.failAt === "snapshot") throw new Error("snapshot write failed");
          itemWrites++;
          return Object.assign(staged.items[where.id], data);
        },
      },
      product: {
        findMany: async ({ where }: any) => where.id.in.map((id: string) => staged.products[id]).filter(Boolean),
        update: async ({ where, data }: any) => {
          const product = staged.products[where.id];
          product.reservedStock += data.reservedStock?.increment ?? -(data.reservedStock?.decrement ?? 0);
          return product;
        },
        updateMany: async ({ where, data }: any) => {
          const product = staged.products[where.id];
          if (product.stock < where.stock.gte) return { count: 0 };
          product.stock -= data.stock.decrement;
          return { count: 1 };
        },
      },
      customer: { findUnique: async () => ({ id: "customer", isActive: true, loyaltyPercent: 0, wholesalePercent: 0 }) },
      user: { findUnique: async () => ({ id: "cashier", name: "Cashier", role: "CASHIER" }) },
      stockTransaction: { create: async ({ data }: any) => staged.stock.push(data) },
      payment: { create: async ({ data }: any) => {
        if (options.failAt === "payment") throw new Error("payment write failed");
        staged.payments.push(data);
      } },
      auditLog: { create: async ({ data }: any) => {
        if (options.failAt === "audit") throw new Error("audit write failed");
        staged.audits.push(data);
      } },
      checkoutOperation: {
        create: async ({ data }: any) => {
          if (staged.operations[data.operationKey]) throw { code: "P2002", meta: { target: ["operationKey"] } };
          const operation = { id: data.operationKey, ...data };
          staged.operations[data.operationKey] = operation;
          return operation;
        },
        update: async ({ where, data }: any) => {
          if (options.failAt === "operation") throw new Error("operation completion failed");
          return Object.assign(staged.operations[where.id], data);
        },
      },
    };
    const result = await work(tx);
    state = staged;
    return result;
  };
  return {
    get state() { return state; },
    get itemWrites() { return itemWrites; },
    restore() {
      prisma.$transaction = originalTransaction;
      prisma.checkoutOperation.findUnique = originalOperationFind;
      prisma.businessSettings.upsert = originalSettings;
      invalidateBusinessSettingsCache();
    },
  };
}

const key = "snapshot-checkout-key-001";
function input(parked = false, payment = false): any {
  return { operationKey: key, draftInvoiceId: parked ? "parked" : undefined,
    customerId: "customer", items: [{ productId: "p1", qty: 1 }, { productId: "p2", qty: 1 }],
    payments: payment ? [{ method: "CASH", amount: 30 }] : [] };
}

test("ordinary checkout captures all final lines and selected customer; replay does not repost", async () => {
  const mock = harness();
  try {
    const request = input();
    const first = await checkoutInvoice("cashier", request);
    const invoice = Object.values(mock.state.invoices)[0];
    const lines = Object.values(mock.state.items);
    assert.equal(invoice.customerNameSnapshot, "Selected customer");
    assert.equal(invoice.customerPanSnapshot, "001234");
    assert.equal(invoice.customerAddressSnapshot, null);
    assert.ok(invoice.customerSnapshotCapturedAt instanceof Date);
    assert.deepEqual(lines.map((line) => line.productNameSnapshot), ["Current one", "Current two"]);
    assert.deepEqual(lines.map((line) => line.productSkuSnapshot), ["SKU-1", "SKU-2"]);
    for (const line of lines) {
      assert.equal(line.costAtSale, null);
      assert.deepEqual(line.snapshotCapturedAt, invoice.customerSnapshotCapturedAt);
    }
    assert.equal(JSON.stringify(first).includes("costAtSale"), false);
    assert.equal(JSON.stringify(mock.state.operations[key].responseJson).includes("costAtSale"), false);
    const stockCount = mock.state.stock.length;
    const writeCount = mock.itemWrites;
    const replay = await checkoutInvoice("cashier", request);
    assert.deepEqual(JSON.parse(JSON.stringify(replay)), JSON.parse(JSON.stringify(first)));
    assert.equal(mock.state.stock.length, stockCount);
    assert.equal(mock.itemWrites, writeCount);
    assert.equal(JSON.stringify(replay).includes("costAtSale"), false);
    await assert.rejects(checkoutInvoice("other", request), /another user/);
    await assert.rejects(checkoutInvoice("cashier", { ...request, items: [{ productId: "p1", qty: 2 }] }), /different bill contents/);
  } finally { mock.restore(); }
});

test("parked checkout replaces uncaptured draft lines and captures current selected identity", async () => {
  const mock = harness({ parked: true });
  try {
    assert.equal(mock.state.items.old.snapshotCapturedAt, null);
    assert.equal(mock.state.invoices.parked.customerSnapshotCapturedAt, null);
    await checkoutInvoice("cashier", input(true));
    assert.equal(mock.state.items.old, undefined);
    assert.equal(mock.state.invoices.parked.status, "FINALIZED");
    assert.equal(mock.state.invoices.parked.customerNameSnapshot, "Selected customer");
    assert.equal(Object.values(mock.state.items).length, 2);
    assert.ok(Object.values(mock.state.items).every((line) => line.snapshotCapturedAt instanceof Date));
    assert.equal(mock.state.products.p1.reservedStock, 0);
  } finally { mock.restore(); }
});

test("walk-in captures authoritative null customer values", async () => {
  const mock = harness();
  try {
    await checkoutInvoice("cashier", { ...input(), customerId: null });
    const invoice = Object.values(mock.state.invoices)[0];
    assert.equal(invoice.customerNameSnapshot, null);
    assert.equal(invoice.customerPanSnapshot, null);
    assert.equal(invoice.customerAddressSnapshot, null);
    assert.ok(invoice.customerSnapshotCapturedAt instanceof Date);
  } finally { mock.restore(); }
});

test("registered customer with unknown PAN keeps captured null", async () => {
  const mock = harness({ nullPan: true });
  try {
    await checkoutInvoice("cashier", input());
    const invoice = Object.values(mock.state.invoices)[0];
    assert.equal(invoice.customerNameSnapshot, "Selected customer");
    assert.equal(invoice.customerPanSnapshot, null);
    assert.equal(invoice.customerAddressSnapshot, null);
    assert.ok(invoice.customerSnapshotCapturedAt instanceof Date);
  } finally { mock.restore(); }
});

test("completed cash checkout replay does not repeat payment", async () => {
  const mock = harness();
  try {
    const request = input(false, true);
    await checkoutInvoice("cashier", request);
    assert.equal(mock.state.payments.length, 1);
    assert.equal(mock.state.invoices[Object.keys(mock.state.invoices)[0]].paymentStatus, "PAID");
    await checkoutInvoice("cashier", request);
    assert.equal(mock.state.payments.length, 1);
    assert.equal(mock.state.stock.length, 2);
    assert.equal(mock.itemWrites, 2);
  } finally { mock.restore(); }
});

for (const invalid of ["name", "sku"] as const) {
  test(`invalid ${invalid} aborts before snapshot and stock writes`, async () => {
    const mock = harness({ invalid });
    try {
      await assert.rejects(checkoutInvoice("cashier", input()), /missing product name or SKU/);
      assert.deepEqual(mock.state.invoices, {});
      assert.deepEqual(mock.state.operations, {});
      assert.equal(mock.state.stock.length, 0);
      assert.equal(mock.itemWrites, 0);
    } finally { mock.restore(); }
  });
}

for (const failAt of ["snapshot", "payment", "audit", "operation"] as const) {
  test(`${failAt} failure rolls back checkout and snapshots`, async () => {
    const mock = harness({ failAt });
    try {
      await assert.rejects(checkoutInvoice("cashier", input(false, failAt === "payment")));
      assert.deepEqual(mock.state.invoices, {});
      assert.deepEqual(mock.state.items, {});
      assert.deepEqual(mock.state.operations, {});
      assert.equal(mock.state.products.p1.stock, 20);
      assert.equal(mock.state.payments.length, 0);
      assert.equal(mock.state.stock.length, 0);
      assert.equal(mock.state.audits.length, 0);
    } finally { mock.restore(); }
  });
}
