import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import { listCategorizedHistory, listAuditLogs } from "../modules/audit/service";
import { buildBusinessDateRange } from "../lib/businessDate";

test("categorized history combines search, action, actor, and Nepal business dates", async (t) => {
  const originalFindMany = prisma.auditLog.findMany;
  const originalCount = prisma.auditLog.count;
  t.after(() => {
    prisma.auditLog.findMany = originalFindMany;
    prisma.auditLog.count = originalCount;
  });

  let capturedWhere: any;
  prisma.auditLog.findMany = (async (args: any) => {
    capturedWhere = args.where;
    return [];
  }) as any;
  prisma.auditLog.count = (async (args: any) => {
    assert.deepEqual(args.where, capturedWhere);
    return 0;
  }) as any;

  await listCategorizedHistory({
    category: "product",
    q: "Jar",
    action: "PRICE",
    actorId: "staff-1",
    from: "2026-09-22",
    to: "2026-09-22",
  });

  assert.deepEqual(capturedWhere.createdAt, buildBusinessDateRange({
    from: "2026-09-22", to: "2026-09-22",
  }));
  assert.equal(capturedWhere.actorId, "staff-1");
  assert.deepEqual(capturedWhere.AND[3], { action: { not: { startsWith: "SALES_OCR_" } } });
  assert.deepEqual(capturedWhere.AND[5], { action: { not: { startsWith: "PURCHASE_" } } });
  assert.equal(capturedWhere.AND.length, 11);
  assert.deepEqual(capturedWhere.AND[6], { action: { not: { startsWith: "CUSTOMER_CREDIT_" } } });
  assert.deepEqual(capturedWhere.AND[0], {
    action: { not: { startsWith: "SALE_RECOVERY_" } },
  });
  assert.deepEqual(capturedWhere.AND[4], {
    action: { not: { startsWith: "PAYMENT_ACCOUNT_" } },
  });
  assert.deepEqual(capturedWhere.AND[1], { action: { not: { startsWith: "SALE_EVIDENCE_" } } });
  assert.deepEqual(capturedWhere.AND[2], { action: { not: { startsWith: "SALES_EVIDENCE_" } } });
  assert.deepEqual(capturedWhere.AND[7], { action: { not: { equals: "MANUAL_BILL_ATTACHED" } } });
  assert.deepEqual(capturedWhere.AND[8], {
    OR: [
      {
        action: {
          in: [
            "PRODUCT_PRICE_UPDATED",
            "PRODUCT_PRICE_UPDATE_DIGEST",
            "PRODUCT_BULK_PRICE_UPDATE",
            "MANAGER_PRODUCT_BULK_PRICE_UPDATE",
            "PRODUCT_DEACTIVATED",
          ],
        },
      },
      { entityType: { in: ["Product", "Brand"] } },
    ],
  });
  assert.deepEqual(capturedWhere.AND[9], {
    action: { contains: "PRICE" },
  });
  assert.deepEqual(capturedWhere.AND[10], {
    OR: [
      { action: { contains: "Jar" } },
      { entityType: { contains: "Jar" } },
      { entityId: { contains: "Jar" } },
      { actor: { name: { contains: "Jar" } } },
    ],
  });
});

test("listAuditLogs excludes restricted proof and PAYMENT_ACCOUNT_ audit actions from general history", async (t) => {
  const originalFindMany = prisma.auditLog.findMany;
  const originalCount = prisma.auditLog.count;
  t.after(() => {
    prisma.auditLog.findMany = originalFindMany;
    prisma.auditLog.count = originalCount;
  });

  let capturedWhere: any;
  prisma.auditLog.findMany = (async (args: any) => {
    capturedWhere = args.where;
    return [];
  }) as any;
  prisma.auditLog.count = (async (args: any) => {
    assert.deepEqual(args.where, capturedWhere);
    return 0;
  }) as any;

  await listAuditLogs({ entityType: "Document" });

  assert.equal(capturedWhere.entityType, "Document");
  assert.deepEqual(capturedWhere.AND, [
    { action: { not: { startsWith: "SALE_RECOVERY_" } } },
    { action: { not: { startsWith: "SALE_EVIDENCE_" } } },
    { action: { not: { startsWith: "SALES_EVIDENCE_" } } },
    { action: { not: { startsWith: "SALES_OCR_" } } },
    { action: { not: { startsWith: "PAYMENT_ACCOUNT_" } } },
    { action: { not: { startsWith: "PURCHASE_" } } },
    { action: { not: { startsWith: "CUSTOMER_CREDIT_" } } },
    { action: { not: { equals: "MANUAL_BILL_ATTACHED" } } },
  ]);
});
