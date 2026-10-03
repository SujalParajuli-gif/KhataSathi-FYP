import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import prisma from "../db/prisma";
import { update } from "../modules/products/controller";
import {
  ProductTaxCategoryMutationError,
  updateProductTaxCategory,
} from "../modules/products/service";

async function withProductMocks(
  run: (ctx: { getProduct: () => any; getAuditLogs: () => any[] }) => Promise<void>,
) {
  const productDelegate = prisma.product as any;
  const auditDelegate = prisma.auditLog as any;
  const originalFindUnique = productDelegate.findUnique;
  const originalUpdate = productDelegate.update;
  const originalAuditCreate = auditDelegate.create;
  const originalTransaction = prisma.$transaction;
  let product = {
    id: "product-1",
    name: "Rice",
    sku: "RICE-1",
    taxCategory: "UNSPECIFIED",
  };
  const auditLogs: any[] = [];
  const tx = {
    product: {
      findUnique: async () => ({ ...product }),
      update: async ({ data }: any) => {
        product = { ...product, ...data };
        return { ...product, brand: { id: "brand-1", name: "Brand" } };
      },
    },
    auditLog: {
      create: async ({ data }: any) => {
        auditLogs.push(data);
        return { id: "audit-1", ...data };
      },
    },
  };
  productDelegate.findUnique = async () => ({ ...product });
  productDelegate.update = async ({ data }: any) => {
    product = { ...product, ...data };
    return { ...product };
  };
  auditDelegate.create = async ({ data }: any) => {
    auditLogs.push(data);
    return { id: "audit-1", ...data };
  };
  (prisma as any).$transaction = async (fn: any) => fn(tx);
  try {
    await run({ getProduct: () => product, getAuditLogs: () => auditLogs });
  } finally {
    productDelegate.findUnique = originalFindUnique;
    productDelegate.update = originalUpdate;
    auditDelegate.create = originalAuditCreate;
    (prisma as any).$transaction = originalTransaction;
  }
}

test("ADMIN can change a product tax category and the change is audited", async () => {
  await withProductMocks(async (ctx) => {
    const result = await updateProductTaxCategory(
      "product-1",
      "STANDARD_VAT",
      { id: "admin-1", role: "ADMIN" },
    );
    assert.equal(result.taxCategory, "STANDARD_VAT");
    assert.equal(ctx.getProduct().taxCategory, "STANDARD_VAT");
    assert.deepEqual(ctx.getAuditLogs()[0], {
      actorId: "admin-1",
      action: "PRODUCT_TAX_CATEGORY_CHANGED",
      entityType: "Product",
      entityId: "product-1",
      meta: {
        productName: "Rice",
        sku: "RICE-1",
        before: "UNSPECIFIED",
        after: "STANDARD_VAT",
      },
    });
  });
});

test("non-ADMIN product tax-category changes are rejected before a transaction", async () => {
  const originalTransaction = prisma.$transaction;
  let transactions = 0;
  (prisma as any).$transaction = async () => {
    transactions++;
    throw new Error("transaction must not run");
  };
  try {
    await assert.rejects(
      updateProductTaxCategory("product-1", "VAT_EXEMPT", {
        id: "manager-1",
        role: "MANAGER",
      }),
      (error: any) => error instanceof ProductTaxCategoryMutationError && error.code === "FORBIDDEN",
    );
    assert.equal(transactions, 0);
  } finally {
    (prisma as any).$transaction = originalTransaction;
  }
});

test("invalid product tax categories are rejected before a transaction", async () => {
  const originalTransaction = prisma.$transaction;
  let transactions = 0;
  (prisma as any).$transaction = async () => {
    transactions++;
    throw new Error("transaction must not run");
  };
  try {
    await assert.rejects(
      updateProductTaxCategory("product-1", "NOT_A_CATEGORY", {
        id: "admin-1",
        role: "ADMIN",
      }),
      (error: any) => error instanceof ProductTaxCategoryMutationError && error.code === "INVALID_TAX_CATEGORY",
    );
    assert.equal(transactions, 0);
  } finally {
    (prisma as any).$transaction = originalTransaction;
  }
});

test("ordinary product edit rejects an attempted tax-category write without applying other fields", async () => {
  const responses: Array<{ status: number; body: unknown }> = [];
  const response = {
    status(code: number) {
      responses.push({ status: code, body: null });
      return this;
    },
    json(body: unknown) {
      if (responses.length === 0) responses.push({ status: 200, body });
      else responses[responses.length - 1].body = body;
      return this;
    },
  } as unknown as Response;

  await update({
    params: { id: "product-1" },
    body: { taxCategory: "VAT_EXEMPT", name: "Changed name" },
    user: { id: "manager-1", role: "MANAGER" },
  } as unknown as Request, response);

  assert.equal(responses[0]?.status, 403);
  assert.match(String((responses[0]?.body as any)?.error), /administrator/i);
});
