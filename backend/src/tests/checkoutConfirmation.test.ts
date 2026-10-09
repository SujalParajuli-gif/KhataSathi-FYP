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
  paymentAccounts?: Record<string, any>;
  paymentQrAssets?: Record<string, any>;
  overrideAuthorizations?: Record<string, any>;
};

function harness(options: {
  productPrices?: Record<string, { retailPrice: number; wholesalePrice: number }>;
  customer?: { id: string; isActive: boolean; loyaltyPercent: number; wholesalePercent: number } | null;
  paymentAccounts?: Record<string, any>;
  paymentQrAssets?: Record<string, any>;
  failOnAuditAction?: string;
  onAuditCreate?: (data: any, tx: any) => Promise<void> | void;
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
    paymentAccounts: options.paymentAccounts ? structuredClone(options.paymentAccounts) : {},
    paymentQrAssets: options.paymentQrAssets ? structuredClone(options.paymentQrAssets) : {},
  };

  const originalTransaction = prisma.$transaction;
  const originalOperationFind = prisma.checkoutOperation.findUnique;
  const originalSettings = prisma.businessSettings.upsert;
  let nextInvoice = 0;
  let nextItem = 0;
  let lastStaged: State | null = null;
  let destinationQueryCount = 0;

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
      $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
        const sql = strings.join("?");
        if (sql.includes("FROM PaymentReceivingAccount")) {
          destinationQueryCount++;
          const id = values[0];
          const acc =
            Object.values(staged.paymentAccounts || {}).find(
              (a: any) => a.id === id,
            ) || (staged.paymentAccounts as any)?.[id];
          if (!acc) return [];
          return [
            {
              id: acc.id,
              providerLabel: acc.providerLabel,
              accountHolder: acc.accountHolder,
              accountIdentifier: acc.accountIdentifier ?? null,
              settlementMethod: acc.settlementMethod ?? null,
              confirmationMode: acc.confirmationMode,
              enabled: acc.enabled ? 1 : 0,
              sortOrder: acc.sortOrder ?? 0,
              version: acc.version,
              creationPayloadHash: acc.creationPayloadHash ?? "hash-123",
              activeQrAssetId: acc.activeQrAssetId ?? null,
            },
          ];
        }
        if (sql.includes("FROM PaymentReceivingQrAsset")) {
          destinationQueryCount++;
          const id = values[0];
          const asset =
            Object.values(staged.paymentQrAssets || {}).find(
              (a: any) => a.id === id,
            ) || (staged.paymentQrAssets as any)?.[id];
          if (!asset) return [];
          return [
            {
              id: asset.id,
              accountId: asset.accountId,
              publicationExpectedVersion: asset.publicationExpectedVersion ?? 1,
              storedPath: asset.storedPath ?? "payment-accounts/test/qr.png",
              fileName: asset.fileName ?? "qr.png",
              thumbnailFileName: asset.thumbnailFileName ?? "qr-thumb.png",
              mimeType: asset.mimeType ?? "image/png",
              sizeBytes: asset.sizeBytes ?? 1024,
              thumbnailSizeBytes: asset.thumbnailSizeBytes ?? 512,
              width: asset.width ?? 800,
              height: asset.height ?? 800,
              checksum: asset.checksum,
              sourceChecksum: asset.sourceChecksum ?? "source-123",
              createdById: asset.createdById ?? "admin",
              createdAt: asset.createdAt ?? new Date(),
            },
          ];
        }
        return [];
      },
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
        create: async ({ data }: any) => {
          const paymentRow = {
            id: `payment-${staged.payments.length + 1}`,
            kind: "CHARGE",
            status: "SUCCESS",
            reference: null,
            cashTendered: null,
            changeAmount: null,
            receivingAccountId: null,
            receivingDestinationSnapshot: null,
            isVoided: false,
            voidedAt: null,
            voidedById: null,
            voidReason: null,
            createdAt: new Date(),
            ...data,
          };
          staged.payments.push(paymentRow);
          return paymentRow;
        },
      },
      auditLog: {
        create: async ({ data }: any) => {
          if (options.failOnAuditAction && data.action === options.failOnAuditAction) {
            throw new Error(`Simulated audit failure on ${data.action}`);
          }
          if (options.onAuditCreate) {
            await options.onAuditCreate(data, tx);
          }
          staged.audits.push(data);
        },
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

    try {
      const result = await work(tx);
      lastStaged = structuredClone(staged);
      state = staged;
      return result;
    } catch (err) {
      lastStaged = structuredClone(staged);
      throw err;
    }
  };

  return {
    get state() {
      return state;
    },
    get lastStaged() {
      return lastStaged;
    },
    get destinationQueryCount() {
      return destinationQueryCount;
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

test("fresh checkout with valid receiving destination and matching confirmation commits snapshot and completes", async () => {
  const accountId = "c460cfb9-6232-47ef-a0d4-1a3b5ebfb001";
  const assetId = "d571d0ca-7343-48fa-b1e5-2b4c6fcac002";
  const fixtureChecksum = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const mock = harness({
    paymentAccounts: {
      [accountId]: {
        id: accountId,
        providerLabel: "Fonepay Official",
        accountHolder: "KhataSathi Store",
        accountIdentifier: "9800000000",
        settlementMethod: "FONEPAY",
        confirmationMode: "MANUAL_RECEIPT",
        enabled: true,
        version: 1,
        activeQrAssetId: assetId,
      },
    },
    paymentQrAssets: {
      [assetId]: {
        id: assetId,
        accountId: accountId,
        checksum: fixtureChecksum,
      },
    },
  });
  try {
    const input = makeInput({
      payments: [
        {
          method: "FONEPAY" as const,
          amount: 40,
          reference: "FP-123456",
          receivingAccountId: accountId,
          receivingAccountVersion: 1,
          manualReceiptConfirmed: true,
        },
      ],
    });
    const result = await checkoutInvoice("cashier", input);
    assert.ok(result.invoice);
    assert.equal(mock.state.payments.length, 1);
    const payment = mock.state.payments[0];
    assert.equal(payment.method, "FONEPAY");
    assert.equal(payment.amount, 40);
    assert.equal(payment.receivingAccountId, accountId);
    assert.ok(payment.receivingDestinationSnapshot);
    assert.equal(payment.receivingDestinationSnapshot.schemaVersion, 1);
    assert.equal(payment.receivingDestinationSnapshot.accountId, accountId);
    assert.equal(payment.receivingDestinationSnapshot.accountVersion, 1);
    assert.equal(payment.receivingDestinationSnapshot.providerLabel, "Fonepay Official");
    assert.equal(payment.receivingDestinationSnapshot.qrChecksum, fixtureChecksum);
    assert.equal(mock.state.stock.length, 2);
    assert.ok(mock.state.operations[key]?.completedAt);
  } finally {
    mock.restore();
  }
});

test("stale second split row in multi-payment checkout rolls back all staged payment/invoice/stock/audit/CheckoutOperation", async () => {
  const accountId = "c460cfb9-6232-47ef-a0d4-1a3b5ebfb001";
  const assetId = "d571d0ca-7343-48fa-b1e5-2b4c6fcac002";
  const fixtureChecksum = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const mock = harness({
    paymentAccounts: {
      [accountId]: {
        id: accountId,
        providerLabel: "Fonepay Official",
        accountHolder: "KhataSathi Store",
        settlementMethod: "FONEPAY",
        confirmationMode: "MANUAL_RECEIPT",
        enabled: true,
        version: 2, // Live version is 2
        activeQrAssetId: assetId,
      },
    },
    paymentQrAssets: {
      [assetId]: {
        id: assetId,
        accountId: accountId,
        checksum: fixtureChecksum,
      },
    },
  });
  try {
    // Split payment: row 1 Cash 20, row 2 Fonepay 20 with stale version 1
    const input = makeInput({
      payments: [
        { method: "CASH" as const, amount: 20 },
        {
          method: "FONEPAY" as const,
          amount: 20,
          reference: "FP-123456",
          receivingAccountId: accountId,
          receivingAccountVersion: 1, // Stale!
          manualReceiptConfirmed: true,
        },
      ],
    });

    await assert.rejects(
      checkoutInvoice("cashier", input),
      (err: any) => {
        assert.equal(err.code, "RECEIVING_ACCOUNT_CHANGED");
        assert.equal(err.statusCode, 409);
        assert.match(err.message, /version changed/i);
        return true;
      },
    );

    // Verify staged state during transaction execution captured the first split CASH payment, invoice, and stock before failure
    const lastStaged = mock.lastStaged;
    assert.ok(lastStaged, "Transaction work must have executed before rollback");
    assert.equal(Object.keys(lastStaged.invoices).length, 1, "Invoice must be staged before failure");
    assert.equal(lastStaged.payments.length, 1, "First CASH split payment must be staged before stale second row failure");
    assert.equal(lastStaged.payments[0].method, "CASH");
    assert.equal(lastStaged.stock.length, 2, "Stock deductions must be staged before failure");
    assert.ok(lastStaged.operations[key], "Operation must be staged before failure");

    // Verify complete rollback in committed state
    assert.deepEqual(mock.state.invoices, {});
    assert.deepEqual(mock.state.payments, []);
    assert.deepEqual(mock.state.stock, []);
    assert.deepEqual(mock.state.audits, []);
    assert.deepEqual(mock.state.operations, {});
  } finally {
    mock.restore();
  }
});

test("audit failure after staged payment also triggers rollback of all staged entities", async () => {
  const accountId = "c460cfb9-6232-47ef-a0d4-1a3b5ebfb001";
  const assetId = "d571d0ca-7343-48fa-b1e5-2b4c6fcac002";
  const fixtureChecksum = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const mock = harness({
    failOnAuditAction: "INVOICE_PAYMENT_UPDATED",
    paymentAccounts: {
      [accountId]: {
        id: accountId,
        providerLabel: "Fonepay Official",
        accountHolder: "KhataSathi Store",
        settlementMethod: "FONEPAY",
        confirmationMode: "MANUAL_RECEIPT",
        enabled: true,
        version: 1,
        activeQrAssetId: assetId,
      },
    },
    paymentQrAssets: {
      [assetId]: {
        id: assetId,
        accountId: accountId,
        checksum: fixtureChecksum,
      },
    },
  });
  try {
    const input = makeInput({
      payments: [
        {
          method: "FONEPAY" as const,
          amount: 40,
          reference: "FP-123456",
          receivingAccountId: accountId,
          receivingAccountVersion: 1,
          manualReceiptConfirmed: true,
        },
      ],
    });

    await assert.rejects(
      checkoutInvoice("cashier", input),
      /Simulated audit failure on INVOICE_PAYMENT_UPDATED/,
    );

    // Verify staged state captured fault branch: payment already created/staged when audit failed
    const lastStaged = mock.lastStaged;
    assert.ok(lastStaged, "Transaction work must have executed before throw");
    assert.equal(lastStaged.payments.length, 1, "Payment was staged before audit failure");
    assert.equal(lastStaged.payments[0].method, "FONEPAY");
    assert.equal(Object.keys(lastStaged.invoices).length, 1, "Invoice was staged before audit failure");
    assert.equal(lastStaged.stock.length, 2, "Stock was staged before audit failure");

    // Verify complete rollback on audit failure in committed state
    assert.deepEqual(mock.state.invoices, {});
    assert.deepEqual(mock.state.payments, []);
    assert.deepEqual(mock.state.stock, []);
    assert.deepEqual(mock.state.audits, []);
    assert.deepEqual(mock.state.operations, {});
  } finally {
    mock.restore();
  }
});

test("response-loss / completed operation exact replay after account disabled, version edited, and QR replaced returns saved immutable snapshot", async () => {
  const accountId = "c460cfb9-6232-47ef-a0d4-1a3b5ebfb001";
  const assetId1 = "d571d0ca-7343-48fa-b1e5-2b4c6fcac002";
  const assetId2 = "e682e1db-8454-59fb-c2f6-3c5d7adb003";
  const checksum1 = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const checksum2 = "b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1";
  const mock = harness({
    paymentAccounts: {
      [accountId]: {
        id: accountId,
        providerLabel: "Fonepay Official",
        accountHolder: "KhataSathi Store",
        settlementMethod: "FONEPAY",
        confirmationMode: "MANUAL_RECEIPT",
        enabled: true,
        version: 1,
        activeQrAssetId: assetId1,
      },
    },
    paymentQrAssets: {
      [assetId1]: {
        id: assetId1,
        accountId: accountId,
        checksum: checksum1,
      },
      [assetId2]: {
        id: assetId2,
        accountId: accountId,
        checksum: checksum2,
      },
    },
  });
  try {
    const input = makeInput({
      payments: [
        {
          method: "FONEPAY" as const,
          amount: 40,
          reference: "FP-123456",
          receivingAccountId: accountId,
          receivingAccountVersion: 1,
          manualReceiptConfirmed: true,
        },
      ],
    });

    const firstResult = await checkoutInvoice("cashier", input);
    assert.ok(firstResult.invoice);
    assert.equal(mock.state.stock.length, 2);
    assert.equal(mock.state.payments.length, 1);

    // Live account is now disabled, version edited to 99, label changed, and QR replaced with assetId2
    const account = (mock.state as any).paymentAccounts[accountId];
    account.enabled = false;
    account.version = 99;
    account.providerLabel = "Completely Changed Bank Name";
    account.activeQrAssetId = assetId2;

    const initialDestinationQueries = mock.destinationQueryCount;
    const initialAuditsCount = mock.state.audits.length;
    const initialStockCount = mock.state.stock.length;
    const initialPaymentsCount = mock.state.payments.length;

    // Exact replay with same operation key
    const replayResult = await checkoutInvoice("cashier", input);
    assert.ok(replayResult.invoice);
    const replayPayment = replayResult.invoice.payments[0];
    assert.equal(replayPayment.receivingAccountId, accountId);
    assert.ok(replayPayment.receivingDestinationSnapshot);
    assert.equal(replayPayment.receivingDestinationSnapshot.accountVersion, 1);
    assert.equal(replayPayment.receivingDestinationSnapshot.providerLabel, "Fonepay Official", "Snapshot must retain original providerLabel");
    assert.equal(replayPayment.receivingDestinationSnapshot.qrChecksum, checksum1, "Snapshot must retain original asset checksum");

    // Zero additional destination queries on replay
    assert.equal(mock.destinationQueryCount, initialDestinationQueries, "ZERO additional destination queries on replay");
    // Zero new audits, recomputes, or financial posting
    assert.equal(mock.state.audits.length, initialAuditsCount, "ZERO new audit logs on replay");
    assert.equal(mock.state.stock.length, initialStockCount, "ZERO new stock transactions on replay");
    assert.equal(mock.state.payments.length, initialPaymentsCount, "ZERO new payment rows on replay");
  } finally {
    mock.restore();
  }
});

test("changed destination tuple with same checkout key conflicts as different bill contents", async () => {
  const accountId = "c460cfb9-6232-47ef-a0d4-1a3b5ebfb001";
  const assetId = "d571d0ca-7343-48fa-b1e5-2b4c6fcac002";
  const fixtureChecksum = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const mock = harness({
    paymentAccounts: {
      [accountId]: {
        id: accountId,
        providerLabel: "Fonepay Official",
        accountHolder: "KhataSathi Store",
        settlementMethod: "FONEPAY",
        confirmationMode: "MANUAL_RECEIPT",
        enabled: true,
        version: 1,
        activeQrAssetId: assetId,
      },
    },
    paymentQrAssets: {
      [assetId]: {
        id: assetId,
        accountId: accountId,
        checksum: fixtureChecksum,
      },
    },
  });
  try {
    const input = makeInput({
      payments: [
        {
          method: "FONEPAY" as const,
          amount: 40,
          reference: "FP-123456",
          receivingAccountId: accountId,
          receivingAccountVersion: 1,
          manualReceiptConfirmed: true,
        },
      ],
    });

    await checkoutInvoice("cashier", input);

    // Replay with altered version in destination tuple
    const alteredInput = makeInput({
      payments: [
        {
          method: "FONEPAY" as const,
          amount: 40,
          reference: "FP-123456",
          receivingAccountId: accountId,
          receivingAccountVersion: 2,
          manualReceiptConfirmed: true,
        },
      ],
    });

    await assert.rejects(
      checkoutInvoice("cashier", alteredInput),
      /different bill contents/,
    );
  } finally {
    mock.restore();
  }
});
