import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import { bulkUpdateProductPrices } from "../modules/products/pricingService";

const baseProduct = {
  id: "product-1",
  name: "Test Product",
  sku: "TEST-1",
  ratePerPiece: 100,
  retailPrice: null,
  wholesalePrice: 120,
  availabilityStatus: "CATALOG_LISTED",
};

function installPricingMocks(options?: {
  digestFails?: boolean;
  product?: Partial<Omit<typeof baseProduct, "ratePerPiece"> & { ratePerPiece: number | null }>;
}) {
  const originalTransaction = prisma.$transaction;
  const originalAuditCreate = prisma.auditLog.create;
  let savedData: Record<string, unknown> | null = null;
  let rowAuditCount = 0;

  const productData = { ...baseProduct, ...(options?.product || {}) };
  const tx = {
    product: {
      findUnique: async () => ({ ...productData }),
      update: async ({ data }: any) => {
        savedData = data;
        return { id: baseProduct.id, name: baseProduct.name, sku: baseProduct.sku };
      },
    },
    auditLog: {
      create: async () => {
        rowAuditCount += 1;
        return {};
      },
    },
  };

  (prisma as any).$transaction = async (callback: any) => callback(tx);
  (prisma.auditLog as any).create = async () => {
    if (options?.digestFails) throw new Error("digest unavailable");
    return {};
  };

  return {
    get savedData() { return savedData; },
    get rowAuditCount() { return rowAuditCount; },
    restore() {
      (prisma as any).$transaction = originalTransaction;
      (prisma.auditLog as any).create = originalAuditCreate;
    },
  };
}

test("fill-empty policy preserves a selling price added before confirmation", async () => {
  const mock = installPricingMocks();
  try {
    const result = await bulkUpdateProductPrices({
      scope: "IDS",
      updates: [{ productId: baseProduct.id, wholesalePrice: 150, retailPrice: 140 }],
      existingPricePolicy: "FILL_EMPTY",
      reason: "Supplier update",
      actorId: "actor-1",
    });

    assert.equal(result.updatedCount, 1);
    assert.deepEqual(mock.savedData, {
      retailPrice: 140,
      sellingPriceStatus: "READY",
    });
    assert.equal(mock.rowAuditCount, 1);
  } finally {
    mock.restore();
  }
});

test("preview-only requests do not write products or audit records", async () => {
  const originalFindUnique = prisma.product.findUnique;
  const originalUpdate = prisma.product.update;
  const originalAuditCreate = prisma.auditLog.create;
  let updateCalled = false;
  let auditCalled = false;
  (prisma.product as any).findUnique = async () => ({ ...baseProduct });
  (prisma.product as any).update = async () => { updateCalled = true; return {}; };
  (prisma.auditLog as any).create = async () => { auditCalled = true; return {}; };
  try {
    const result = await bulkUpdateProductPrices({
      scope: "IDS",
      updates: [{ productId: baseProduct.id, retailPrice: 140 }],
      existingPricePolicy: "REPLACE",
      previewOnly: true,
      previewPage: 1,
      previewPageSize: 10,
      reason: "Preview only",
      actorId: "actor-1",
    });
    assert.equal(updateCalled, false);
    assert.equal(auditCalled, false);
    assert.equal(result.previewCount, 1);
    assert.equal(result.preview.length, 1);
  } finally {
    (prisma.product as any).findUnique = originalFindUnique;
    (prisma.product as any).update = originalUpdate;
    (prisma.auditLog as any).create = originalAuditCreate;
  }
});

test("fill-empty preview keeps already-priced products searchable for exact adjustments", async () => {
  const originalFindMany = prisma.product.findMany;
  const originalCount = prisma.product.count;
  (prisma.product as any).findMany = async () => [{ ...baseProduct }];
  (prisma.product as any).count = async () => 1;
  try {
    const result = await bulkUpdateProductPrices({
      scope: "FILTERED",
      filters: { isActive: true },
      wholesalePercent: 18,
      existingPricePolicy: "FILL_EMPTY",
      previewOnly: true,
      previewSearch: "test-1",
      reason: "Preview only",
      actorId: "actor-1",
    });

    assert.equal(result.matchedCount, 1);
    assert.equal(result.previewCount, 0);
    assert.equal(result.skippedExisting, 1);
    assert.equal(result.previewMatchedCount, 1);
    assert.equal(result.preview.length, 1);
    assert.equal(result.preview[0]?.willChange, false);
    assert.equal(result.preview[0]?.sku, "TEST-1");
  } finally {
    (prisma.product as any).findMany = originalFindMany;
    (prisma.product as any).count = originalCount;
  }
});

test("filtered bulk-price preview can be searched by a product alias", async () => {
  const originalFindMany = prisma.product.findMany;
  const originalCount = prisma.product.count;
  (prisma.product as any).findMany = async () => [{
    ...baseProduct,
    name: "Basin",
    searchAliases: [{ alias: "bata" }],
  }];
  (prisma.product as any).count = async () => 1;
  try {
    const result = await bulkUpdateProductPrices({
      scope: "FILTERED",
      filters: { isActive: true },
      wholesalePercent: 18,
      existingPricePolicy: "FILL_EMPTY",
      previewOnly: true,
      previewSearch: "bata",
      reason: "Preview only",
      actorId: "actor-1",
    });

    assert.equal(result.previewMatchedCount, 1);
    assert.equal(result.preview[0]?.name, "Basin");
  } finally {
    (prisma.product as any).findMany = originalFindMany;
    (prisma.product as any).count = originalCount;
  }
});

test("filtered preview sorts the complete result before applying pagination", async () => {
  const originalFindMany = prisma.product.findMany;
  const originalCount = prisma.product.count;
  (prisma.product as any).findMany = async () => [
    { ...baseProduct, id: "low", name: "Low", sku: "LOW", ratePerPiece: 50, wholesalePrice: null },
    { ...baseProduct, id: "high", name: "High", sku: "HIGH", ratePerPiece: 200, wholesalePrice: null },
    { ...baseProduct, id: "middle", name: "Middle", sku: "MIDDLE", ratePerPiece: 100, wholesalePrice: null },
  ];
  (prisma.product as any).count = async () => 3;
  try {
    const result = await bulkUpdateProductPrices({
      scope: "FILTERED",
      filters: { isActive: true },
      wholesalePercent: 10,
      existingPricePolicy: "FILL_EMPTY",
      previewOnly: true,
      previewPage: 1,
      previewPageSize: 2,
      previewSort: "rate_desc",
      reason: "Preview only",
      actorId: "actor-1",
    });

    assert.deepEqual(result.preview.map((item) => item.productId), ["high", "middle"]);
    assert.equal(result.previewMatchedCount, 3);
    assert.equal(result.previewTotalPages, 2);
  } finally {
    (prisma.product as any).findMany = originalFindMany;
    (prisma.product as any).count = originalCount;
  }
});

test("a failed digest reports a warning without reporting committed rows as failed", async () => {
  const mock = installPricingMocks({ digestFails: true });
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    const result = await bulkUpdateProductPrices({
      scope: "IDS",
      updates: [{ productId: baseProduct.id, retailPrice: 140 }],
      existingPricePolicy: "REPLACE",
      reason: "Supplier update",
      actorId: "actor-1",
    });
    assert.equal(result.updatedCount, 1);
    assert.match(result.auditWarning || "", /Prices were saved/);
    assert.equal(result.errorCount, 0);
  } finally {
    console.error = originalConsoleError;
    mock.restore();
  }
});

test("manual price updates can change Rate and selling prices together", async () => {
  const mock = installPricingMocks();
  try {
    const result = await bulkUpdateProductPrices({
      scope: "IDS",
      updates: [{ productId: baseProduct.id, ratePerPiece: 110, wholesalePrice: 135, retailPrice: 150 }],
      existingPricePolicy: "REPLACE",
      reason: "Manual price review",
      actorId: "actor-1",
    });

    assert.equal(result.updatedCount, 1);
    assert.deepEqual(mock.savedData, {
      ratePerPiece: 110,
      rateUpdatedAt: mock.savedData?.rateUpdatedAt,
      retailPrice: 150,
      wholesalePrice: 135,
      sellingPriceStatus: "READY",
    });
    assert.ok(mock.savedData?.rateUpdatedAt instanceof Date);
  } finally {
    mock.restore();
  }
});

test("retail-only products can update their announced selling price", async () => {
  const mock = installPricingMocks({ product: { ratePerPiece: null } });
  try {
    const result = await bulkUpdateProductPrices({
      scope: "IDS",
      updates: [{ productId: baseProduct.id, retailPrice: 150 }],
      existingPricePolicy: "REPLACE",
      reason: "Manual price review",
      actorId: "actor-1",
    });

    assert.equal(result.updatedCount, 1);
    assert.equal(result.errorCount, 0);
    assert.equal(mock.savedData?.retailPrice, 150);
    assert.equal(mock.savedData?.rateUpdatedAt, undefined);
  } finally {
    mock.restore();
  }
});

test("a changed explicit price preview rejects before any product is written", async () => {
  const originalFindUnique = prisma.product.findUnique;
  const originalFindMany = prisma.product.findMany;
  const originalTransaction = prisma.$transaction;
  let transactions = 0;
  (prisma.product as any).findUnique = async () => ({ ...baseProduct });
  (prisma.product as any).findMany = async () => [{ ...baseProduct, ratePerPiece: 125 }];
  (prisma as any).$transaction = async () => { transactions += 1; throw new Error("Unexpected write"); };
  try {
    const input = {
      scope: "IDS" as const,
      updates: [{ productId: baseProduct.id, retailPrice: 140 }],
      existingPricePolicy: "REPLACE" as const,
      reason: "Supplier update",
      actorId: "actor-1",
    };
    const preview = await bulkUpdateProductPrices({ ...input, previewOnly: true });
    assert.match(preview.previewRevision || "", /^[a-f0-9]{64}$/);
    await assert.rejects(
      bulkUpdateProductPrices({ ...input, expectedPreviewRevision: preview.previewRevision! }),
      /changed since the preview/,
    );
    assert.equal(transactions, 0);
  } finally {
    (prisma.product as any).findUnique = originalFindUnique;
    (prisma.product as any).findMany = originalFindMany;
    (prisma as any).$transaction = originalTransaction;
  }
});

test("a filtered preview revision includes the complete matching scope", async () => {
  const originalFindMany = prisma.product.findMany;
  const originalCount = prisma.product.count;
  const originalTransaction = prisma.$transaction;
  let products = [{ ...baseProduct, wholesalePrice: null }];
  let transactions = 0;
  (prisma.product as any).findMany = async () => products;
  (prisma.product as any).count = async () => products.length;
  (prisma as any).$transaction = async () => { transactions += 1; throw new Error("Unexpected write"); };
  try {
    const input = {
      scope: "FILTERED" as const,
      filters: { isActive: true },
      wholesalePercent: 18,
      existingPricePolicy: "FILL_EMPTY" as const,
      reason: "Supplier update",
      actorId: "actor-1",
    };
    const preview = await bulkUpdateProductPrices({ ...input, previewOnly: true, previewPageSize: 1 });
    products = [...products, { ...baseProduct, id: "product-2", sku: "TEST-2", wholesalePrice: null }];
    await assert.rejects(
      bulkUpdateProductPrices({ ...input, expectedPreviewRevision: preview.previewRevision! }),
      /changed since the preview/,
    );
    assert.equal(transactions, 0);
  } finally {
    (prisma.product as any).findMany = originalFindMany;
    (prisma.product as any).count = originalCount;
    (prisma as any).$transaction = originalTransaction;
  }
});

test("a price change during a protected update is reported per row without overwriting it", async () => {
  const originalFindUnique = prisma.product.findUnique;
  const originalFindMany = prisma.product.findMany;
  const originalTransaction = prisma.$transaction;
  let updateCalls = 0;
  (prisma.product as any).findUnique = async () => ({ ...baseProduct });
  (prisma.product as any).findMany = async () => [{ ...baseProduct }];
  (prisma as any).$transaction = async (callback: any) => callback({
    product: {
      findUnique: async () => ({ ...baseProduct, retailPrice: 135 }),
      updateMany: async () => { updateCalls += 1; return { count: 1 }; },
    },
    auditLog: { create: async () => ({}) },
  });
  try {
    const input = {
      scope: "IDS" as const,
      updates: [{ productId: baseProduct.id, retailPrice: 140 }],
      existingPricePolicy: "REPLACE" as const,
      reason: "Supplier update",
      actorId: "actor-1",
    };
    const preview = await bulkUpdateProductPrices({ ...input, previewOnly: true });
    const result = await bulkUpdateProductPrices({ ...input, expectedPreviewRevision: preview.previewRevision! });
    assert.equal(result.updatedCount, 0);
    assert.equal(result.errorCount, 1);
    assert.equal(result.errors[0]?.code, "PRICE_PREVIEW_STALE");
    assert.equal(updateCalls, 0);
  } finally {
    (prisma.product as any).findUnique = originalFindUnique;
    (prisma.product as any).findMany = originalFindMany;
    (prisma as any).$transaction = originalTransaction;
  }
});

test("a protected price update compares current prices at the write boundary", async () => {
  const originalFindUnique = prisma.product.findUnique;
  const originalFindMany = prisma.product.findMany;
  const originalTransaction = prisma.$transaction;
  let rowAuditCalls = 0;
  (prisma.product as any).findUnique = async () => ({ ...baseProduct });
  (prisma.product as any).findMany = async () => [{ ...baseProduct }];
  (prisma as any).$transaction = async (callback: any) => callback({
    product: {
      findUnique: async () => ({ ...baseProduct }),
      updateMany: async ({ where }: any) => {
        assert.equal(where.ratePerPiece, 100);
        assert.equal(where.wholesalePrice, 120);
        return { count: 0 }; // Another writer changed a price after our read.
      },
    },
    auditLog: { create: async () => { rowAuditCalls += 1; return {}; } },
  });
  try {
    const input = {
      scope: "IDS" as const,
      updates: [{ productId: baseProduct.id, retailPrice: 140 }],
      existingPricePolicy: "REPLACE" as const,
      reason: "Supplier update",
      actorId: "actor-1",
    };
    const preview = await bulkUpdateProductPrices({ ...input, previewOnly: true });
    const result = await bulkUpdateProductPrices({ ...input, expectedPreviewRevision: preview.previewRevision! });
    assert.equal(result.updatedCount, 0);
    assert.equal(result.errors[0]?.code, "PRICE_PREVIEW_STALE");
    assert.equal(rowAuditCalls, 0);
  } finally {
    (prisma.product as any).findUnique = originalFindUnique;
    (prisma.product as any).findMany = originalFindMany;
    (prisma as any).$transaction = originalTransaction;
  }
});

test("a protected multi-product update reports committed and stale rows separately", async () => {
  const originalFindUnique = prisma.product.findUnique;
  const originalFindMany = prisma.product.findMany;
  const originalTransaction = prisma.$transaction;
  const originalAuditCreate = prisma.auditLog.create;
  const products = [
    { ...baseProduct },
    { ...baseProduct, id: "product-2", sku: "TEST-2" },
  ];
  let rowAuditCalls = 0;
  (prisma.product as any).findUnique = async ({ where }: any) => products.find((p) => p.id === where.id);
  (prisma.product as any).findMany = async () => products;
  (prisma as any).$transaction = async (callback: any) => callback({
    product: {
      findUnique: async ({ where }: any) => where.id === "product-2"
        ? { ...products[1], ratePerPiece: 125 }
        : { ...products[0] },
      updateMany: async () => ({ count: 1 }),
    },
    auditLog: { create: async () => { rowAuditCalls += 1; return {}; } },
  });
  (prisma.auditLog as any).create = async () => ({});
  try {
    const input = {
      scope: "IDS" as const,
      updates: products.map((product) => ({ productId: product.id, retailPrice: 140 })),
      existingPricePolicy: "REPLACE" as const,
      reason: "Supplier update",
      actorId: "actor-1",
    };
    const preview = await bulkUpdateProductPrices({ ...input, previewOnly: true });
    const result = await bulkUpdateProductPrices({ ...input, expectedPreviewRevision: preview.previewRevision! });
    assert.equal(result.updatedCount, 1);
    assert.deepEqual(result.products.map((product) => product.id), ["product-1"]);
    assert.equal(result.errorCount, 1);
    assert.equal(result.errors[0]?.productId, "product-2");
    assert.equal(result.errors[0]?.code, "PRICE_PREVIEW_STALE");
    assert.equal(result.partialSuccess, true);
    assert.equal(rowAuditCalls, 1);
  } finally {
    (prisma.product as any).findUnique = originalFindUnique;
    (prisma.product as any).findMany = originalFindMany;
    (prisma as any).$transaction = originalTransaction;
    (prisma.auditLog as any).create = originalAuditCreate;
  }
});
