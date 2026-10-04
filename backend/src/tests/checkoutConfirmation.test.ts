import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import {
  checkoutInvoice,
  buildCheckoutPayloadHash,
  CheckoutReviewConflictError,
} from "../modules/invoices/service";
import { checkoutBodySchema } from "../modules/invoices/validation.js";
import { invalidateBusinessSettingsCache } from "../modules/settings/service";

type State = {
  invoices: Record<string, any>;
  items: Record<string, any>;
  products: Record<string, any>;
  operations: Record<string, any>;
  payments: any[];
  stock: any[];
  audits: any[];
  requests: Record<string, any>;
};

function harness(options: {
  productPrices?: Record<string, { retailPrice: number; wholesalePrice: number }>;
  customer?: { id: string; isActive: boolean; loyaltyPercent: number; wholesalePercent: number } | null;
} = {}) {
  let state: State = {
    invoices: {},
    items: {},
    products: {
      p1: {
        id: "p1",
        name: "Product One",
        sku: "SKU-1",
        stock: 20,
        reservedStock: 0,
        isActive: true,
        retailPrice: options.productPrices?.p1?.retailPrice ?? 10,
        wholesalePrice: options.productPrices?.p1?.wholesalePrice ?? 10,
        wholesaleEligible: false,
      },
      p2: {
        id: "p2",
        name: "Product Two",
        sku: "SKU-2",
        stock: 20,
        reservedStock: 0,
        isActive: true,
        retailPrice: options.productPrices?.p2?.retailPrice ?? 20,
        wholesalePrice: options.productPrices?.p2?.wholesalePrice ?? 20,
        wholesaleEligible: false,
      },
    },
    operations: {},
    payments: [],
    stock: [],
    audits: [],
    requests: {},
  };

  const originalTransaction = prisma.$transaction;
  const originalOperationFind = prisma.checkoutOperation.findUnique;
  const originalSettings = prisma.businessSettings.upsert;
  let nextInvoice = 0;
  let nextItem = 0;

  invalidateBusinessSettingsCache();
  (prisma.businessSettings as any).upsert = async () => ({
    businessMode: "FULL_POS",
    defaultWholesaleQtyThreshold: 15,
    loyaltyDiscountPercent: 0,
    parkedBillExpiryHours: 8,
    allowCashierDiscount: true,
  });

  (prisma.checkoutOperation as any).findUnique = async ({ where }: any) =>
    state.operations[where.operationKey] ?? null;

  (prisma as any).$transaction = async (work: (tx: any) => Promise<any>) => {
    const staged: State = structuredClone(state);
    const invoiceView = (id: string, args: any) => {
      const invoice = staged.invoices[id];
      if (!invoice) return null;
      const result = structuredClone(invoice);
      if (args?.include?.items) {
        result.items = Object.values(staged.items)
          .filter((item: any) => item.invoiceId === id)
          .map((item: any) => {
            const line = structuredClone(item);
            if (args.include.items.select) {
              const selected: any = {};
              for (const [key, enabled] of Object.entries(args.include.items.select)) {
                if (enabled === true && key in line) selected[key] = line[key];
              }
              const product = staged.products[item.productId];
              selected.product = {
                id: product.id,
                name: product.name,
                sku: product.sku,
                barcode: product.barcode ?? null,
              };
              return selected;
            }
            if (args.include.items.include?.product) {
              line.product = { ...staged.products[item.productId] };
            }
            return line;
          });
      }
      if (args?.include?.customer) {
        result.customer = invoice.customerId
          ? (options.customer ?? {
              id: "customer",
              name: "Selected customer",
              panNo: "001234",
              address: null,
              isActive: true,
              loyaltyPercent: 0,
              wholesalePercent: 0,
            })
          : null;
      }
      if (args?.include?.payments) {
        result.payments = staged.payments.filter((p) => p.invoiceId === id);
      }
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
          const invoice = {
            id: `invoice-${++nextInvoice}`,
            ...data,
            customerSnapshotCapturedAt: null,
          };
          staged.invoices[invoice.id] = invoice;
          return invoice;
        },
        update: async ({ where, data }: any) =>
          Object.assign(staged.invoices[where.id], data),
      },
      invoiceItem: {
        findMany: async ({ where }: any) =>
          Object.values(staged.items).filter(
            (item: any) => item.invoiceId === where.invoiceId,
          ),
        deleteMany: async ({ where }: any) => {
          for (const [id, item] of Object.entries(staged.items)) {
            if (item.invoiceId === where.invoiceId) delete staged.items[id];
          }
        },
        create: async ({ data }: any) => {
          const item = {
            id: `item-${++nextItem}`,
            ...data,
            createdAt: new Date(),
            originalUnitPrice: data.originalUnitPrice ?? null,
            overrideUnitPrice: data.overrideUnitPrice ?? null,
            overrideReason: data.overrideReason ?? null,
            overrideById: data.overrideById ?? null,
            overrideAt: data.overrideAt ?? null,
            snapshotCapturedAt: null,
            costAtSale: null,
          };
          staged.items[item.id] = item;
          return item;
        },
        update: async ({ where, data }: any) =>
          Object.assign(staged.items[where.id], data),
      },
      product: {
        findMany: async ({ where }: any) =>
          where.id.in.map((id: string) => staged.products[id]).filter(Boolean),
        findUnique: async ({ where }: any) => staged.products[where.id] ?? null,
        update: async ({ where, data }: any) => {
          const product = staged.products[where.id];
          product.reservedStock +=
            data.reservedStock?.increment ?? -(data.reservedStock?.decrement ?? 0);
          return product;
        },
        updateMany: async ({ where, data }: any) => {
          const product = staged.products[where.id];
          if (product.stock < where.stock.gte) return { count: 0 };
          product.stock -= data.stock.decrement;
          return { count: 1 };
        },
      },
      customer: {
        findUnique: async () =>
          options.customer ?? {
            id: "customer",
            isActive: true,
            loyaltyPercent: 0,
            wholesalePercent: 0,
          },
      },
      user: {
        findUnique: async () => ({
          id: "cashier",
          name: "Cashier",
          role: "ADMIN",
          isActive: true,
        }),
      },
      billingDraftRequest: {
        findUnique: async ({ where }: any) => staged.requests[where.id] ?? null,
        updateMany: async ({ where, data }: any) => {
          const request = staged.requests[where.id];
          if (
            !request ||
            request.completedInvoiceId !== where.completedInvoiceId ||
            !where.status.in.includes(request.status)
          ) {
            return { count: 0 };
          }
          Object.assign(request, data);
          return { count: 1 };
        },
      },
      stockTransaction: {
        create: async ({ data }: any) => staged.stock.push(data),
      },
      payment: {
        create: async ({ data }: any) => staged.payments.push(data),
      },
      auditLog: {
        create: async ({ data }: any) => staged.audits.push(data),
      },
      priceOverrideAuthorization: {
        findUnique: async ({ where }: any) => (staged as any).overrideAuthorizations?.[where.tokenHash] ?? null,
        update: async ({ where, data }: any) => {
          const auth = Object.values((staged as any).overrideAuthorizations || {}).find((a: any) => a.id === where.id);
          if (auth) Object.assign(auth, data);
          return auth;
        },
      },
      checkoutOperation: {
        create: async ({ data }: any) => {
          if (staged.operations[data.operationKey]) {
            throw { code: "P2002", meta: { target: ["operationKey"] } };
          }
          const operation = { id: data.operationKey, ...data };
          staged.operations[data.operationKey] = operation;
          return operation;
        },
        update: async ({ where, data }: any) =>
          Object.assign(staged.operations[where.id], data),
      },
    };

    const result = await work(tx);
    state = staged;
    return result;
  };

  return {
    get state() {
      return state;
    },
    restore() {
      prisma.$transaction = originalTransaction;
      prisma.checkoutOperation.findUnique = originalOperationFind;
      prisma.businessSettings.upsert = originalSettings;
      invalidateBusinessSettingsCache();
    },
  };
}

const key = "confirm-checkout-test-key-001";

function makeInput(overrides: Partial<any> = {}) {
  return {
    operationKey: key,
    customerId: "customer",
    items: [
      { productId: "p1", qty: 2 },
      { productId: "p2", qty: 1 },
    ],
    payments: [{ method: "CASH" as const, amount: 40 }],
    confirmation: {
      items: [
        { productId: "p1", qty: 2, appliedUnitPrice: 10 },
        { productId: "p2", qty: 1, appliedUnitPrice: 20 },
      ],
      payableTotal: 40,
    },
    ...overrides,
  };
}

test("fresh checkout with matching confirmation succeeds and records all entities", async () => {
  const mock = harness();
  try {
    const input = makeInput();
    const result = await checkoutInvoice("cashier", input);
    assert.ok(result.invoice);
    assert.equal(mock.state.stock.length, 2);
    assert.equal(mock.state.payments.length, 1);
    assert.equal(mock.state.payments[0].amount, 40);
    assert.equal(Object.keys(mock.state.invoices).length, 1);
    const invoice = Object.values(mock.state.invoices)[0];
    assert.equal(invoice.netTotal, 40);
    assert.equal(invoice.paymentStatus, "PAID");
    assert.ok(mock.state.operations[key].completedAt);
  } finally {
    mock.restore();
  }
});

test("fresh checkout without confirmation throws MISSING_CONFIRMATION and leaves zero committed effects", async () => {
  const mock = harness();
  try {
    const input = makeInput({ confirmation: null });
    await assert.rejects(
      checkoutInvoice("cashier", input),
      (err: any) => {
        assert.ok(err instanceof CheckoutReviewConflictError);
        assert.equal(err.code, "CHECKOUT_REVIEW_REQUIRED");
        assert.equal(err.reason, "MISSING_CONFIRMATION");
        return true;
      },
    );
    assert.deepEqual(mock.state.invoices, {});
    assert.deepEqual(mock.state.operations, {});
    assert.equal(mock.state.stock.length, 0);
    assert.equal(mock.state.payments.length, 0);
  } finally {
    mock.restore();
  }
});

test("fresh checkout with price increase throws PRICE_OR_TOTAL_CHANGED with discrepancies and zero committed effects", async () => {
  // Catalog has p1 at 15 instead of reviewed 10
  const mock = harness({
    productPrices: { p1: { retailPrice: 15, wholesalePrice: 15 }, p2: { retailPrice: 20, wholesalePrice: 20 } },
  });
  try {
    const input = makeInput({
      confirmation: {
        items: [
          { productId: "p1", qty: 2, appliedUnitPrice: 10 },
          { productId: "p2", qty: 1, appliedUnitPrice: 20 },
        ],
        payableTotal: 40,
      },
    });
    await assert.rejects(
      checkoutInvoice("cashier", input),
      (err: any) => {
        assert.ok(err instanceof CheckoutReviewConflictError);
        assert.equal(err.code, "CHECKOUT_REVIEW_REQUIRED");
        assert.equal(err.reason, "PRICE_OR_TOTAL_CHANGED");
        assert.ok(err.details?.itemDiscrepancies?.length);
        assert.equal(err.details.itemDiscrepancies[0].productId, "p1");
        assert.equal(err.details.itemDiscrepancies[0].confirmedUnitPrice, 10);
        assert.equal(err.details.itemDiscrepancies[0].currentUnitPrice, 15);
        return true;
      },
    );
    assert.deepEqual(mock.state.invoices, {});
    assert.deepEqual(mock.state.operations, {});
    assert.equal(mock.state.stock.length, 0);
  } finally {
    mock.restore();
  }
});

test("fresh checkout with price decrease throws PRICE_OR_TOTAL_CHANGED with zero committed effects", async () => {
  // Catalog has p2 at 12 instead of reviewed 20
  const mock = harness({
    productPrices: { p1: { retailPrice: 10, wholesalePrice: 10 }, p2: { retailPrice: 12, wholesalePrice: 12 } },
  });
  try {
    const input = makeInput({
      confirmation: {
        items: [
          { productId: "p1", qty: 2, appliedUnitPrice: 10 },
          { productId: "p2", qty: 1, appliedUnitPrice: 20 },
        ],
        payableTotal: 40,
      },
    });
    await assert.rejects(
      checkoutInvoice("cashier", input),
      (err: any) => {
        assert.ok(err instanceof CheckoutReviewConflictError);
        assert.equal(err.code, "CHECKOUT_REVIEW_REQUIRED");
        assert.equal(err.reason, "PRICE_OR_TOTAL_CHANGED");
        return true;
      },
    );
    assert.deepEqual(mock.state.invoices, {});
    assert.deepEqual(mock.state.operations, {});
    assert.equal(mock.state.stock.length, 0);
  } finally {
    mock.restore();
  }
});

test("offsetting line price changes with same total still throws PRICE_OR_TOTAL_CHANGED", async () => {
  // p1 was 10, now 15 (+5/item -> +10 for 2 items)
  // p2 was 20, now 10 (-10)
  // total is still 2*15 + 1*10 = 40!
  const mock = harness({
    productPrices: { p1: { retailPrice: 15, wholesalePrice: 15 }, p2: { retailPrice: 10, wholesalePrice: 10 } },
  });
  try {
    const input = makeInput({
      confirmation: {
        items: [
          { productId: "p1", qty: 2, appliedUnitPrice: 10 },
          { productId: "p2", qty: 1, appliedUnitPrice: 20 },
        ],
        payableTotal: 40,
      },
    });
    await assert.rejects(
      checkoutInvoice("cashier", input),
      (err: any) => {
        assert.ok(err instanceof CheckoutReviewConflictError);
        assert.equal(err.code, "CHECKOUT_REVIEW_REQUIRED");
        assert.equal(err.reason, "PRICE_OR_TOTAL_CHANGED");
        assert.equal(err.details?.itemDiscrepancies?.length, 2);
        return true;
      },
    );
    assert.deepEqual(mock.state.invoices, {});
    assert.deepEqual(mock.state.operations, {});
    assert.equal(mock.state.stock.length, 0);
  } finally {
    mock.restore();
  }
});

test("payable total mismatch due to discount/rounding difference throws PRICE_OR_TOTAL_CHANGED", async () => {
  const mock = harness();
  try {
    // Confirmed payableTotal says 35, but server computes 2*10 + 1*20 = 40 (no discount)
    const input = makeInput({
      confirmation: {
        items: [
          { productId: "p1", qty: 2, appliedUnitPrice: 10 },
          { productId: "p2", qty: 1, appliedUnitPrice: 20 },
        ],
        payableTotal: 35,
      },
    });
    await assert.rejects(
      checkoutInvoice("cashier", input),
      (err: any) => {
        assert.ok(err instanceof CheckoutReviewConflictError);
        assert.equal(err.code, "CHECKOUT_REVIEW_REQUIRED");
        assert.equal(err.reason, "PRICE_OR_TOTAL_CHANGED");
        assert.equal(err.details?.confirmedPayableTotal, 35);
        assert.equal(err.details?.currentPayableTotal, 40);
        return true;
      },
    );
    assert.deepEqual(mock.state.invoices, {});
    assert.deepEqual(mock.state.operations, {});
    assert.equal(mock.state.stock.length, 0);
  } finally {
    mock.restore();
  }
});

test("duplicate product ID in confirmation is rejected by validation schema", async () => {
  const parsed = checkoutBodySchema.safeParse({
    operationKey: "valid-operation-key-12345",
    items: [{ productId: "p1", qty: 1 }],
    confirmation: {
      items: [
        { productId: "p1", qty: 1, appliedUnitPrice: 10 },
        { productId: "p1", qty: 1, appliedUnitPrice: 10 },
      ],
      payableTotal: 20,
    },
  });
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    assert.match(parsed.error.issues[0].message, /duplicate product IDs/i);
  }
});

test("fractional payableTotal in confirmation is rejected by validation schema", async () => {
  const parsed = checkoutBodySchema.safeParse({
    operationKey: "valid-operation-key-12345",
    items: [{ productId: "p1", qty: 1 }],
    confirmation: {
      items: [{ productId: "p1", qty: 1, appliedUnitPrice: 10.5 }],
      payableTotal: 10.5,
    },
  });
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    assert.match(parsed.error.issues[0].message, /integer/i);
  }
});

test("duplicate product ID in confirmation is rejected by service normalization", async () => {
  const mock = harness();
  try {
    const input = makeInput({
      confirmation: {
        items: [
          { productId: "p1", qty: 1, appliedUnitPrice: 10 },
          { productId: "p1", qty: 1, appliedUnitPrice: 10 },
        ],
        payableTotal: 20,
      },
    });
    await assert.rejects(
      checkoutInvoice("cashier", input),
      /Duplicate confirmation product ID/,
    );
  } finally {
    mock.restore();
  }
});

test("legacy completed operation replay without confirmation succeeds without reposting", async () => {
  const mock = harness();
  try {
    const freshInput = makeInput();
    const first = await checkoutInvoice("cashier", freshInput);

    // Now pretend the stored operation in DB was completed under legacy format without confirmation
    const legacyInputWithoutConf = makeInput({ confirmation: null });
    const legacyHash = buildCheckoutPayloadHash(
      legacyInputWithoutConf,
      legacyInputWithoutConf.items.map((i: any) => ({
        productId: i.productId,
        qty: i.qty,
        overrideUnitPrice: undefined,
        overrideReason: undefined,
        overrideAuthorizationToken: undefined,
      })),
      legacyInputWithoutConf.payments.map((p: any) => ({
        method: p.method,
        amount: p.amount,
        reference: undefined,
        tenderedAmount: undefined,
      })),
    );
    mock.state.operations[key].payloadHash = legacyHash;

    const replay = await checkoutInvoice("cashier", legacyInputWithoutConf);
    assert.deepEqual(
      JSON.parse(JSON.stringify(replay)),
      JSON.parse(JSON.stringify(first)),
    );
    assert.equal(mock.state.stock.length, 2);
    assert.equal(mock.state.payments.length, 1);
  } finally {
    mock.restore();
  }
});

test("replay with changed confirmation is rejected as different bill contents", async () => {
  const mock = harness();
  try {
    const freshInput = makeInput();
    await checkoutInvoice("cashier", freshInput);

    // Replay with different confirmed price
    const alteredInput = makeInput({
      confirmation: {
        items: [
          { productId: "p1", qty: 2, appliedUnitPrice: 12 },
          { productId: "p2", qty: 1, appliedUnitPrice: 20 },
        ],
        payableTotal: 44,
      },
    });
    await assert.rejects(
      checkoutInvoice("cashier", alteredInput),
      /different bill contents/,
    );
  } finally {
    mock.restore();
  }
});

test("fresh checkout with deliberate partial payment succeeds with confirmed payable total and PARTIAL status", async () => {
  const mock = harness();
  try {
    // Total is 40, customer deliberately pays 15
    const input = makeInput({
      payments: [{ method: "CASH" as const, amount: 15, tenderedAmount: 20 }],
    });
    const result = await checkoutInvoice("cashier", input);
    assert.ok(result.invoice);
    const invoice = mock.state.invoices[result.invoice.id];
    assert.equal(invoice.netTotal, 40);
    assert.equal(invoice.paidTotal, 15);
    assert.equal(invoice.paymentStatus, "PARTIALLY_PAID");
    assert.equal(mock.state.payments.length, 1);
    assert.equal(mock.state.payments[0].amount, 15);
  } finally {
    mock.restore();
  }
});

test("fresh checkout with deliberate unpaid payment succeeds with confirmed payable total and UNPAID status", async () => {
  const mock = harness();
  try {
    // Total is 40, unpaid (payments empty)
    const input = makeInput({
      payments: [],
    });
    const result = await checkoutInvoice("cashier", input);
    assert.ok(result.invoice);
    const invoice = mock.state.invoices[result.invoice.id];
    assert.equal(invoice.netTotal, 40);
    assert.equal(invoice.paidTotal, 0);
    assert.equal(invoice.paymentStatus, "UNPAID");
    assert.equal(mock.state.payments.length, 0);
  } finally {
    mock.restore();
  }
});

test("fresh checkout with deliberate split payment succeeds matching confirmed payable total", async () => {
  const mock = harness();
  try {
    // Total is 40: 25 Cash + 15 Fonepay
    const input = makeInput({
      payments: [
        { method: "CASH" as const, amount: 25, tenderedAmount: 30 },
        { method: "FONEPAY" as const, amount: 15, reference: "FP-12345" },
      ],
    });
    const result = await checkoutInvoice("cashier", input);
    assert.ok(result.invoice);
    const invoice = mock.state.invoices[result.invoice.id];
    assert.equal(invoice.netTotal, 40);
    assert.equal(invoice.paidTotal, 40);
    assert.equal(invoice.paymentStatus, "PAID");
    assert.equal(mock.state.payments.length, 2);
  } finally {
    mock.restore();
  }
});

test("fresh checkout with 100% discount and zero payable total succeeds", async () => {
  const mock = harness();
  try {
    // 100% discount -> payableTotal 0
    const input = makeInput({
      discountAmount: 40,
      payments: [],
      confirmation: {
        items: [
          { productId: "p1", qty: 2, appliedUnitPrice: 10 },
          { productId: "p2", qty: 1, appliedUnitPrice: 20 },
        ],
        payableTotal: 0,
      },
    });
    const result = await checkoutInvoice("cashier", input);
    assert.ok(result.invoice);
    const invoice = mock.state.invoices[result.invoice.id];
    assert.equal(invoice.netTotal, 0);
    assert.equal(invoice.paymentStatus, "PAID");
  } finally {
    mock.restore();
  }
});

test("fresh checkout with authorized price override and matching confirmation succeeds", async () => {
  const mock = harness();
  try {
    const token = "valid-override-token-123";
    const crypto = await import("crypto");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    (mock.state as any).overrideAuthorizations = {
      [tokenHash]: {
        id: "auth-1",
        tokenHash,
        cashierId: "cashier",
        productId: "p1",
        customerId: "customer",
        qty: 2,
        originalUnitPrice: 10,
        overrideUnitPrice: 8,
        overrideReason: "Manager discount",
        expiresAt: new Date(Date.now() + 60000),
        usedAt: null,
      },
    };

    // Override p1 price from 10 to 8 (reduction)
    const input = makeInput({
      items: [
        { productId: "p1", qty: 2, overrideUnitPrice: 8, overrideReason: "Manager discount", overrideAuthorizationToken: token },
        { productId: "p2", qty: 1 },
      ],
      payments: [{ method: "CASH" as const, amount: 36 }],
      confirmation: {
        items: [
          { productId: "p1", qty: 2, appliedUnitPrice: 8 },
          { productId: "p2", qty: 1, appliedUnitPrice: 20 },
        ],
        payableTotal: 36,
      },
    });
    const result = await checkoutInvoice("cashier", input);
    assert.ok(result.invoice);
    const invoice = mock.state.invoices[result.invoice.id];
    assert.equal(invoice.netTotal, 36);
    assert.equal(invoice.paymentStatus, "PAID");
    const item1 = Object.values(mock.state.items).find((i: any) => i.productId === "p1");
    assert.equal(item1.appliedUnitPrice, 8);
    assert.equal(item1.overrideUnitPrice, 8);
    assert.equal(item1.originalUnitPrice, 10);
  } finally {
    mock.restore();
  }
});

test("fresh checkout with price override but mismatching confirmation throws PRICE_OR_TOTAL_CHANGED", async () => {
  const mock = harness();
  try {
    // Input specifies overrideUnitPrice 8, but confirmation still expects 10
    const input = makeInput({
      items: [
        { productId: "p1", qty: 2, overrideUnitPrice: 8, overrideReason: "Manager discount" },
        { productId: "p2", qty: 1 },
      ],
      payments: [{ method: "CASH" as const, amount: 36 }],
      confirmation: {
        items: [
          { productId: "p1", qty: 2, appliedUnitPrice: 10 },
          { productId: "p2", qty: 1, appliedUnitPrice: 20 },
        ],
        payableTotal: 40,
      },
    });
    await assert.rejects(
      checkoutInvoice("cashier", input),
      (err: any) => {
        assert.ok(err instanceof CheckoutReviewConflictError);
        assert.equal(err.code, "CHECKOUT_REVIEW_REQUIRED");
        assert.equal(err.reason, "PRICE_OR_TOTAL_CHANGED");
        return true;
      },
    );
  } finally {
    mock.restore();
  }
});
