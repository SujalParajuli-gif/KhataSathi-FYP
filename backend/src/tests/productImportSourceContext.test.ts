import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import { getProductImportSourceContext } from "../modules/products/importService";
import { getImportRowSourceContext, getImportBatchSourceContext } from "../modules/products/controller";

test("active batches still return their source-context rows", async (t) => {
    const originalBatch = prisma.productImportBatch.findFirst;
    const originalRowFirst = prisma.productImportRow.findFirst;
    const originalRowMany = prisma.productImportRow.findMany;
    t.after(() => {
        prisma.productImportBatch.findFirst = originalBatch;
        prisma.productImportRow.findFirst = originalRowFirst;
        prisma.productImportRow.findMany = originalRowMany;
    });

    prisma.productImportBatch.findFirst = (async (query: any) => {
        assert.deepEqual(query.where, { id: "active-batch", deletedAt: null });
        return { id: "active-batch" };
    }) as any;

    prisma.productImportRow.findFirst = (async (query: any) => {
        assert.deepEqual(query.where, { id: "row-1", batchId: "active-batch", batch: { deletedAt: null } });
        return { id: "row-1", batchId: "active-batch", rowNumber: 5 };
    }) as any;

    prisma.productImportRow.findMany = (async (query: any) => {
        return [{ id: "row-1", rowNumber: 5, rawText: "test", sourceLocator: {} }];
    }) as any;

    const result = await getProductImportSourceContext({ batchId: "active-batch", rowId: "row-1" });
    assert.equal(result.activeRowId, "row-1");
    assert.equal(result.rows.length, 1);
});

test("a soft-deleted batch is rejected and returns no row data", async (t) => {
    const originalBatch = prisma.productImportBatch.findFirst;
    const originalRowFirst = prisma.productImportRow.findFirst;
    const originalRowMany = prisma.productImportRow.findMany;
    t.after(() => {
        prisma.productImportBatch.findFirst = originalBatch;
        prisma.productImportRow.findFirst = originalRowFirst;
        prisma.productImportRow.findMany = originalRowMany;
    });

    prisma.productImportBatch.findFirst = (async () => null) as any;
    prisma.productImportRow.findFirst = (async () => { assert.fail("Should not query rows"); }) as any;
    prisma.productImportRow.findMany = (async () => { assert.fail("Should not query rows"); }) as any;

    await assert.rejects(
        async () => await getProductImportSourceContext({ batchId: "deleted-batch" }),
        { message: "Product import batch was not found" }
    );
});

test("a nonexistent batch is rejected with the same public behavior as a deleted batch", async (t) => {
    const originalBatch = prisma.productImportBatch.findFirst;
    const originalRowFirst = prisma.productImportRow.findFirst;
    const originalRowMany = prisma.productImportRow.findMany;
    t.after(() => {
        prisma.productImportBatch.findFirst = originalBatch;
        prisma.productImportRow.findFirst = originalRowFirst;
        prisma.productImportRow.findMany = originalRowMany;
    });

    prisma.productImportBatch.findFirst = (async () => null) as any;
    prisma.productImportRow.findFirst = (async () => { assert.fail("Should not query rows"); }) as any;
    prisma.productImportRow.findMany = (async () => { assert.fail("Should not query rows"); }) as any;

    await assert.rejects(
        async () => await getProductImportSourceContext({ batchId: "missing-batch" }),
        { message: "Product import batch was not found" }
    );
});

test("a row ID from another batch cannot expose or alter source context", async (t) => {
    const originalBatch = prisma.productImportBatch.findFirst;
    const originalRowFirst = prisma.productImportRow.findFirst;
    const originalRowMany = prisma.productImportRow.findMany;
    t.after(() => {
        prisma.productImportBatch.findFirst = originalBatch;
        prisma.productImportRow.findFirst = originalRowFirst;
        prisma.productImportRow.findMany = originalRowMany;
    });

    prisma.productImportBatch.findFirst = (async () => ({ id: "batch-1" })) as any;

    // Simulate input rowId "row-2" which belongs to "batch-2" (not found under batch-1)
    prisma.productImportRow.findFirst = (async (query: any) => {
        assert.equal(query.where.batchId, "batch-1");
        assert.deepEqual(query.where.batch, { deletedAt: null });
        return null;
    }) as any;

    prisma.productImportRow.findMany = (async (query: any) => {
        assert.equal(query.where.batchId, "batch-1");
        assert.deepEqual(query.where.batch, { deletedAt: null });
        // We shouldn't see any bounds related to the external rowId
        assert.equal(query.where.rowNumber, undefined);
        return [{ id: "row-1", rowNumber: 1, rawText: "safe", sourceLocator: {} }];
    }) as any;

    const result = await getProductImportSourceContext({ batchId: "batch-1", rowId: "row-2" });
    assert.equal(result.activeRowId, "row-1");
    assert.equal(result.rows[0].id, "row-1");
});

test("a batch deleted between the initial check and row query returns empty rows instead of exposing data", async (t) => {
    const originalBatch = prisma.productImportBatch.findFirst;
    const originalRowMany = prisma.productImportRow.findMany;
    t.after(() => {
        prisma.productImportBatch.findFirst = originalBatch;
        prisma.productImportRow.findMany = originalRowMany;
    });

    // Pass the initial check
    prisma.productImportBatch.findFirst = (async () => ({ id: "batch-1" })) as any;

    // Simulate batch soft-deleted before row query evaluates.
    // The query enforces batch: { deletedAt: null }, so it returns empty.
    prisma.productImportRow.findMany = (async (query: any) => {
        assert.deepEqual(query.where.batch, { deletedAt: null });
        return []; // Prisma would return empty if batch no longer matches `deletedAt: null`
    }) as any;

    const result = await getProductImportSourceContext({ batchId: "batch-1" });
    assert.deepEqual(result.rows, []);
    assert.equal(result.activeRowId, "");
});

test("both controller paths retain their expected 404 behavior", async (t) => {
    const originalBatch = prisma.productImportBatch.findFirst;
    t.after(() => { prisma.productImportBatch.findFirst = originalBatch; });

    prisma.productImportBatch.findFirst = (async () => null) as any;

    let status1, json1, status2, json2;
    const res1 = { status: (s: number) => ({ json: (j: any) => { status1 = s; json1 = j; return res1; } }) } as any;
    const res2 = { status: (s: number) => ({ json: (j: any) => { status2 = s; json2 = j; return res2; } }) } as any;

    await getImportRowSourceContext({ params: { batchId: "deleted-batch", rowId: "row-1" }, query: {} } as any, res1);
    assert.equal(status1, 404);
    assert.equal(json1.error, "Product import batch was not found");

    await getImportBatchSourceContext({ params: { batchId: "deleted-batch" }, query: {} } as any, res2);
    assert.equal(status2, 404);
    assert.equal(json2.error, "Product import batch was not found");
});
