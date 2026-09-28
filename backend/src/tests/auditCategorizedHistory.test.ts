import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import { listCategorizedHistory } from "../modules/audit/service";
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
  assert.deepEqual(capturedWhere.action, { contains: "PRICE" });
  assert.equal(capturedWhere.actorId, "staff-1");
  assert.equal(capturedWhere.AND.length, 2);
  assert.deepEqual(capturedWhere.AND[1], { OR: [
    { action: { contains: "Jar" } },
    { entityType: { contains: "Jar" } },
    { entityId: { contains: "Jar" } },
    { actor: { name: { contains: "Jar" } } },
  ] });
});
