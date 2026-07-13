import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import { updateBrand } from "../modules/brands/service";

test("updateBrand does not cascade deactivation to products", async () => {
  const originalTransaction = prisma.$transaction;
  let productUpdateCalled = false;
  let auditMeta: any;

  const tx = {
    brand: {
      findUnique: async () => ({
        id: "brand-1",
        name: "Old Brand",
        isActive: true,
      }),
      update: async () => ({
        id: "brand-1",
        name: "Old Brand",
        isActive: false,
      }),
    },
    product: {
      updateMany: async () => {
        productUpdateCalled = true;
        return { count: 3 };
      },
    },
    auditLog: {
      create: async ({ data }: any) => {
        auditMeta = data.meta;
        return data;
      },
    },
  };

  (prisma as any).$transaction = async (callback: any) => callback(tx);

  try {
    const result = await updateBrand("brand-1", { isActive: false }, "actor-1");

    assert.equal(productUpdateCalled, false);
    assert.equal((result as any).deactivatedProductCount, undefined);
    assert.equal(auditMeta.productCascade, false);
  } finally {
    (prisma as any).$transaction = originalTransaction;
  }
});
