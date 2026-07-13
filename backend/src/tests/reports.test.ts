import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeManagerAnalyticsReport } from "../modules/reports/service";

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
