import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAnalyticsFilters,
  ReportValidationError,
  sanitizeManagerAnalyticsReport,
} from "../modules/reports/service";
import { handleReportError } from "../modules/reports/controller";

test("manager analytics sanitizer removes cost and profit fields but keeps operational revenue", () => {
  const report = sanitizeManagerAnalyticsReport({
    summary: {
      netSales: 1200,
      grossProfit: 300,
      profitMargin: 25,
    },
    topProducts: [
      {
        name: "Notebook",
        revenue: 500,
        ratePerPiece: 75,
        supplierCostHistory: [{ cost: 70 }],
      },
    ],
    operations: {
      recentStockReceives: [
        {
          supplierName: "Supplier A",
          totalQty: 12,
          billAmount: 900,
        },
      ],
    },
  });

  assert.deepEqual(report, {
    summary: {
      netSales: 1200,
    },
    topProducts: [
      {
        name: "Notebook",
        revenue: 500,
      },
    ],
    operations: {
      recentStockReceives: [
        {
          supplierName: "Supplier A",
          totalQty: 12,
        },
      ],
    },
  });
});

test("interactive report ranges allow 366 days and reject longer ranges explicitly", () => {
  assert.equal(
    normalizeAnalyticsFilters({ from: "2024-01-01", to: "2024-12-31" }).rangeDays,
    366,
  );
  assert.throws(
    () => normalizeAnalyticsFilters({ from: "2024-01-01", to: "2025-01-01" }),
    ReportValidationError,
  );
  assert.equal(
    normalizeAnalyticsFilters(
      { from: "2024-01-01", to: "2025-01-01" },
      { allowLongRange: true },
    ).rangeDays,
    367,
  );
});

test("unexpected report failures return a stable safe body with request ID", () => {
  let status = 0;
  let body: any;
  const response = {
    locals: { requestId: "request-safe-1" },
    status(next: number) { status = next; return this; },
    json(next: any) { body = next; return this; },
  } as any;
  const originalError = console.error;
  console.error = () => undefined;
  try {
    handleReportError(response, new Error("database password leaked"), "test");
  } finally {
    console.error = originalError;
  }
  assert.equal(status, 500);
  assert.deepEqual(body, {
    code: "REPORT_UNAVAILABLE",
    error: "The report could not be generated. Please try again.",
    requestId: "request-safe-1",
  });
});
