import test from "node:test";
import assert from "node:assert/strict";
import { buildAuditAlert, shouldIncludeAuditLogForRole } from "../modules/alerts/service";

function managerLog(action: string, meta: Record<string, unknown> = {}) {
  return {
    action,
    actor: { name: "Mina", role: "MANAGER" },
    actorId: "manager-1",
    entityId: "entity-1",
    meta,
  };
}

test("manager import audit logs produce one admin product alert", () => {
  const alert = buildAuditAlert(
    managerLog("PRODUCT_IMPORT_COMPLETED", {
      createdCount: 8,
      fileName: "supplier.csv",
    }),
  );

  assert.equal(alert?.title, "Manager imported products");
  assert.equal(alert?.level, "INFO");
  assert.equal(alert?.type, "Product");
  assert.match(alert?.message || "", /Mina imported 8 products from supplier\.csv/);
});

test("manager bulk price update audit logs produce a warning digest alert", () => {
  const alert = buildAuditAlert(
    managerLog("MANAGER_PRODUCT_BULK_PRICE_UPDATE", {
      updatedCount: 4,
      reason: "Festival price update",
    }),
  );

  assert.equal(alert?.title, "Manager updated product prices");
  assert.equal(alert?.level, "WARNING");
  assert.match(alert?.message || "", /updated prices for 4 products/);
  assert.match(alert?.message || "", /Festival price update/);
});

test("manager downward stock adjustment includes before-after stock in warning alert", () => {
  const alert = buildAuditAlert(
    managerLog("STOCK_ADJUSTED", {
      productName: "Notebook",
      qtyDelta: -3,
      previousStock: 10,
      nextStock: 7,
      reason: "Damaged",
    }),
  );

  assert.equal(alert?.title, "Manager reduced stock");
  assert.equal(alert?.level, "WARNING");
  assert.match(alert?.message || "", /Notebook: 10 -> 7/);
  assert.match(alert?.message || "", /Damaged/);
});

test("manager payment void and return approval use warning alert messages", () => {
  const paymentAlert = buildAuditAlert(
    managerLog("PAYMENT_VOIDED", {
      invoiceNo: "INV-1",
      voidedAmount: 500,
    }),
  );
  const returnAlert = buildAuditAlert(
    managerLog("RETURN_REQUEST_APPROVED", {
      refundAmount: 250,
    }),
  );

  assert.equal(paymentAlert?.level, "WARNING");
  assert.match(paymentAlert?.message || "", /voided payment NPR 500 on Invoice INV-1/);
  assert.equal(returnAlert?.level, "WARNING");
  assert.match(returnAlert?.message || "", /approved return #entity-1 for NPR 250/);
});

test("manager product and customer deactivation use info alerts", () => {
  const productAlert = buildAuditAlert(
    managerLog("PRODUCT_DEACTIVATED", {
      productName: "Notebook",
      sku: "NB-1",
    }),
  );
  const customerAlert = buildAuditAlert(
    managerLog("CUSTOMER_DEACTIVATED", {
      customerName: "Sita",
    }),
  );

  assert.equal(productAlert?.level, "INFO");
  assert.match(productAlert?.message || "", /deactivated product Notebook/);
  assert.equal(customerAlert?.level, "INFO");
  assert.match(customerAlert?.message || "", /deactivated customer Sita/);
});

test("new operational alert rules render clear messages", () => {
  const backupAlert = buildAuditAlert(
    managerLog("SCHEDULED_BACKUP_FAILED", {
      error: "mysqldump was not found",
    }),
  );
  const uploadAlert = buildAuditAlert(
    managerLog("STOCK_RECEIVE_BILL_UPLOAD_FAILED", {
      supplierName: "ABC Suppliers",
      error: "Document storage root is not writable",
    }),
  );
  const drawerAlert = buildAuditAlert(
    managerLog("CASH_DRAWER_CLOSED", {
      cashierName: "Hari",
      expectedTotal: 1000,
      actualTotal: 950,
      difference: -50,
    }),
  );
  const invoiceAlert = buildAuditAlert(
    managerLog("INVOICE_CANCELLED", {
      invoiceNo: "INV-9",
      netTotal: 1200,
    }),
  );
  const priceAlert = buildAuditAlert(
    managerLog("PRODUCT_PRICE_UPDATED", {
      productName: "Notebook",
      before: { retailPrice: 100 },
      after: { retailPrice: 125 },
    }),
  );

  assert.equal(backupAlert?.title, "Scheduled backup failed");
  assert.equal(backupAlert?.level, "CRITICAL");
  assert.match(backupAlert?.message || "", /mysqldump was not found/);
  assert.equal(uploadAlert?.title, "Stock bill upload failed");
  assert.match(uploadAlert?.message || "", /ABC Suppliers/);
  assert.equal(drawerAlert?.title, "Cash drawer discrepancy");
  assert.match(drawerAlert?.message || "", /Difference NPR -50/);
  assert.equal(invoiceAlert?.level, "WARNING");
  assert.match(invoiceAlert?.message || "", /Manager Mina cancelled invoice INV-9/);
  assert.equal(priceAlert?.title, "Product price changed");
  assert.match(priceAlert?.message || "", /NPR 100 -> NPR 125/);
});

test("role alert filter suppresses routine self-alerts and targets cashier catalog alerts", () => {
  const ownManagerAction = {
    ...managerLog("STOCK_ADJUSTED", { qtyDelta: -1 }),
    actorId: "manager-1",
  };
  const backupFailure = {
    ...managerLog("SCHEDULED_BACKUP_FAILED", { error: "failed" }),
    actorId: "manager-1",
  };
  const priceUpdate = {
    ...managerLog("PRODUCT_PRICE_UPDATED", {}),
    actorId: "admin-1",
    entityType: "Product",
    entityId: "product-1",
  };

  assert.equal(shouldIncludeAuditLogForRole(ownManagerAction, "manager-1", "MANAGER"), false);
  assert.equal(shouldIncludeAuditLogForRole(backupFailure, "manager-1", "MANAGER"), true);
  assert.equal(
    shouldIncludeAuditLogForRole(priceUpdate, "cashier-1", "CASHIER", {
      cashierRecentProductIds: new Set(["product-1"]),
    }),
    true,
  );
  assert.equal(
    shouldIncludeAuditLogForRole(priceUpdate, "cashier-1", "CASHIER", {
      cashierRecentProductIds: new Set(["other-product"]),
    }),
    false,
  );
});
