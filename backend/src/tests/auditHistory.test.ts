import test from "node:test";
import assert from "node:assert/strict";
import { buildHistoryDisplay } from "../modules/audit/service";

function log(action: string, meta: Record<string, unknown> = {}) {
  return {
    action,
    actor: { name: "Mina" },
    entityType: "StockReceiveBatch",
    entityId: "batch-1",
    meta,
  };
}

test("stock receive history exposes a readable drilldown action", () => {
  const display = buildHistoryDisplay(
    log("STOCK_RECEIVE_BATCH_CREATED", {
      supplierName: "ABC Suppliers",
      totalQty: 12,
      lineCount: 3,
    }),
    "stock",
  );

  assert.equal(display.title, "Stock received from ABC Suppliers");
  assert.match(display.description, /12 item/);
  assert.equal(display.detailType, "stockReceiveBatch");
  assert.equal(display.detailId, "batch-1");
  assert.equal(display.actionLabel, "View details");
});

test("import history exposes a reopen-review action", () => {
  const display = buildHistoryDisplay(
    {
      action: "PRODUCT_IMPORT_COMPLETED",
      actor: { name: "Mina" },
      entityType: "ProductImportBatch",
      entityId: "import-1",
      meta: {
        fileName: "supplier.csv",
        createdCount: 8,
        errorCount: 1,
      },
    },
    "import",
  );

  assert.equal(display.title, "Import completed: supplier.csv");
  assert.match(display.description, /8 product/);
  assert.equal(display.detailType, "importBatch");
  assert.equal(display.detailId, "import-1");
  assert.equal(display.actionLabel, "Reopen review");
});
