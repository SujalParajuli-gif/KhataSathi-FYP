import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import { getProductImportStatus } from "../modules/products/importStatus";

test("status reads only batch summary and does not expose extraction metadata", async (t) => {
  const original = prisma.productImportBatch.findFirst;
  t.after(() => { prisma.productImportBatch.findFirst = original; });
  prisma.productImportBatch.findFirst = (async (query: any) => {
    assert.deepEqual(query.where, { id: "batch", deletedAt: null });
    assert.equal(query.select.rows, undefined);
    assert.equal(query.select.sourceStoredPath, undefined);
    return { id: "batch", status: "CANCELLING", totalRows: 2,
      extractionMeta: { totalPages: 2, privatePrompt: "never expose",
        pages: [{ pageNumber: 1, status: "DONE", rows: 2, extractor: "AI" }] } };
  }) as any;
  const result = await getProductImportStatus("batch");
  assert.equal(result?.coverage.completed, 1);
  assert.equal(result?.coverage.visited, 1);
  assert.equal(result?.coverage.canRetry, true);
  assert.equal(result?.batch.status, "CANCELLING");
  assert.equal("extractionMeta" in result!.batch, false);
  assert.equal(JSON.stringify(result).includes("privatePrompt"), false);
});

test("missing or deleted imports return no status", async (t) => {
  const original = prisma.productImportBatch.findFirst;
  t.after(() => { prisma.productImportBatch.findFirst = original; });
  prisma.productImportBatch.findFirst = (async () => null) as any;
  assert.equal(await getProductImportStatus("missing"), null);
});
