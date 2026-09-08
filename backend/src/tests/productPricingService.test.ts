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
      retailPrice: 150,
      wholesalePrice: 135,
      sellingPriceStatus: "READY",
    });
  } finally {
    mock.restore();
  }
});

test("a normal product cannot receive selling prices without a Rate", async () => {
  const mock = installPricingMocks({ product: { ratePerPiece: null } });
  try {
    const result = await bulkUpdateProductPrices({
      scope: "IDS",
      updates: [{ productId: baseProduct.id, retailPrice: 150 }],
      existingPricePolicy: "REPLACE",
      reason: "Manual price review",
      actorId: "actor-1",
    });

    assert.equal(result.updatedCount, 0);
    assert.equal(result.errorCount, 1);
    assert.match(result.errors[0]?.message || "", /Rate or mark this product as Coming soon/);
  } finally {
    mock.restore();
  }
});
