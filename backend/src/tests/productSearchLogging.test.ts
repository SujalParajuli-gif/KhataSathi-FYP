import assert from "node:assert/strict";
import test from "node:test";
import prisma from "../db/prisma";
import {
  fingerprintProductSearchFilters,
  hashProductSearchSession,
  productSearchLogExpiry,
  PRODUCT_SEARCH_LOG_RETENTION_DAYS,
  recordProductSearchQuery,
  recordProductSearchSelection,
  sanitizeLoggedProductSearchQuery,
  excludeReviewedNoResultQueries,
} from "../modules/products/searchLogging";

test("logged product queries are whitespace-safe and storage-bounded", () => {
  assert.equal(
    sanitizeLoggedProductSearchQuery("  bucket\u0000  20   ltr  "),
    "bucket 20 ltr",
  );
  assert.equal(sanitizeLoggedProductSearchQuery("x".repeat(300)).length, 160);
});

test("filter and session fingerprints are stable without storing the raw session id", () => {
  const left = fingerprintProductSearchFilters({
    category: "Plastic",
    brand: "brand-1",
    lowStockOnly: true,
  });
  const right = fingerprintProductSearchFilters({
    lowStockOnly: true,
    brand: "brand-1",
    category: "Plastic",
  });
  assert.equal(left, right);
  assert.equal(left.length, 64);
  assert.equal(hashProductSearchSession("tab-secret", "user-1")?.length, 64);
  assert.notEqual(
    hashProductSearchSession("tab-secret", "user-1"),
    hashProductSearchSession("tab-secret", "user-2"),
  );
});

test("search log expiry uses the documented retention period", () => {
  const now = new Date("2026-08-05T00:00:00.000Z");
  const expiry = productSearchLogExpiry(now);
  assert.equal(
    expiry.getTime() - now.getTime(),
    PRODUCT_SEARCH_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
});

test("short or non-first-page queries are not logged", async () => {
  assert.equal(
    await recordProductSearchQuery({
      rawQuery: "a",
      source: "PRODUCTS",
      filters: {},
      resultCount: 0,
      durationMs: 10,
      page: 1,
    }),
    null,
  );
  assert.equal(
    await recordProductSearchQuery({
      rawQuery: "bucket",
      source: "PRODUCTS",
      filters: {},
      resultCount: 10,
      durationMs: 10,
      page: 2,
    }),
    null,
  );
});

test("repeated no-result searches in one tab update the existing log", async () => {
  const model = (prisma as any).productSearchQueryLog;
  const originalFindFirst = model.findFirst;
  const originalUpdate = model.update;
  const originalCreate = model.create;
  const calls: any[] = [];
  model.findFirst = async (args: any) => {
    calls.push({ type: "find", args });
    return { id: "search-1" };
  };
  model.update = async (args: any) => {
    calls.push({ type: "update", args });
    return { id: "search-1" };
  };
  model.create = async () => {
    throw new Error("deduplicated search must not create a new row");
  };

  try {
    const result = await recordProductSearchQuery({
      rawQuery: "not found bucket",
      source: "PRODUCT_LOOKUP",
      filters: { category: "Plastic" },
      resultCount: 0,
      durationMs: 12,
      actorId: "user-1",
      sessionId: "tab-1",
      page: 1,
      now: new Date("2026-08-05T00:00:00.000Z"),
    });
    assert.deepEqual(result, { id: "search-1" });
    assert.equal(calls[0].args.where.resultCount, 0);
    assert.deepEqual(calls[1].args.data.occurrenceCount, { increment: 1 });
  } finally {
    model.findFirst = originalFindFirst;
    model.update = originalUpdate;
    model.create = originalCreate;
  }
});

test("invalid result-selection actions are rejected before database access", async () => {
  await assert.rejects(
    recordProductSearchSelection({
      searchLogId: "search-1",
      productId: "product-1",
      action: "AUTO_CREATE_ALIAS",
      actorId: "user-1",
    }),
    /valid search, product, and selection action/i,
  );
});

test("reviewed aliases are removed from the unmatched-search queue", () => {
  const insights = [
    { normalizedQuery: "water jug", searches: 5 },
    { normalizedQuery: "unknown item", searches: 2 },
  ];
  assert.deepEqual(
    excludeReviewedNoResultQueries(insights, new Set(["water jug"])),
    [{ normalizedQuery: "unknown item", searches: 2 }],
  );
});
