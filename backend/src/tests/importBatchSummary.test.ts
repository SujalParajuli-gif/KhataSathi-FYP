import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import { listProductImportBatches } from "../modules/products/importService";

test("attention summary is independent of history pagination and excludes completed/deleted batches", async (t) => {
  const queries: any[] = [];
  // Prisma delegates are proxies; use the same reversible stubs as the import service tests.
  const stub = (key: string, implementation: any) => {
    const original = prisma.productImportBatch[key];
    prisma.productImportBatch[key] = implementation;
    t.after(() => { prisma.productImportBatch[key] = original; });
  };
  stub("findMany", async (query: any) => {
    queries.push(query);
    return query.select ? [{ id: "older-pending", status: "DRAFT" }] : [];
  });
  stub("count", async (query: any) => {
    assert.equal(query.where.deletedAt, null);
    assert.equal(query.where.sourceType, "PDF");
    assert.deepEqual(query.where.AND, [{ status: { not: "IMPORTED" } }]);
    return 42;
  });
  const result = await listProductImportBatches({ sourceType: "PDF", page: 2, pageSize: 30 });
  assert.equal(result.attentionCount, 42);
  assert.equal(result.attentionBatches[0]?.id, "older-pending");
  assert.deepEqual(result.batches, []);
  assert.equal(queries[0].skip, 30);
  assert.equal(queries[1].skip, undefined);
  assert.equal(queries[1].take, 3);
  assert.equal(queries[1].select.rows, undefined);
  assert.equal(queries[1].where.sourceType, "PDF");
});
