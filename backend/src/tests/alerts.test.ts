import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAuditAlert,
  getAllowedAuditActionsForCapabilities,
  isAuditAlertImplicitlyRead,
  shouldIncludeAuditLogForRole,
} from "../modules/alerts/service";

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

test("product creation produces a catalog alert", () => {
  const alert = buildAuditAlert(
    managerLog("PRODUCT_CREATED", {
      productName: "Plastic Bucket",
      sku: "PB-1",
    }),
  );

  assert.equal(alert?.title, "Product added");
  assert.equal(alert?.type, "Product");
  assert.match(alert?.message || "", /Plastic Bucket/);
});

test("product details, activation, and mode changes produce clear alerts", () => {
  const details = buildAuditAlert(managerLog("PRODUCT_UPDATED", {
    productName: "Plastic Bucket",
    changedFields: ["name", "image"],
  }));
  const activation = buildAuditAlert(managerLog("PRODUCT_ACTIVATED", {
    productName: "Plastic Bucket",
  }));
  const mode = buildAuditAlert(managerLog("BUSINESS_MODE_CHANGED", {
    previousMode: "FULL_POS",
    businessMode: "CATALOG_ONLY",
  }));

  assert.equal(details?.title, "Product details updated");
  assert.match(details?.message || "", /name, image/);
  assert.equal(activation?.title, "Product available for sale");
  assert.match(activation?.message || "", /activated product Plastic Bucket/);
  assert.equal(mode?.type, "System");
  assert.match(mode?.message || "", /full pos to catalog only/);
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

test("role alert filter keeps manager activity visible without making it unread", () => {
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

  assert.equal(shouldIncludeAuditLogForRole(ownManagerAction, "manager-1", "MANAGER"), true);
  assert.equal(isAuditAlertImplicitlyRead(ownManagerAction, "manager-1"), true);
  assert.equal(shouldIncludeAuditLogForRole(backupFailure, "manager-1", "MANAGER"), true);
  assert.equal(isAuditAlertImplicitlyRead(backupFailure, "manager-1"), false);
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
  assert.equal(
    shouldIncludeAuditLogForRole(
      { ...priceUpdate, action: "PRODUCT_ACTIVATED" },
      "cashier-1",
      "CASHIER",
    ),
    true,
  );
  assert.equal(
    shouldIncludeAuditLogForRole(priceUpdate, "cashier-1", "CASHIER", {
      posDisabled: true,
    }),
    true,
  );
});

test("business-mode alert matrix exposes only relevant operational events", () => {
  const catalog = getAllowedAuditActionsForCapabilities({
    businessMode: "CATALOG_ONLY",
    posEnabled: false,
  });
  const inventory = getAllowedAuditActionsForCapabilities({
    businessMode: "INVENTORY_ONLY",
    posEnabled: false,
  });
  const fullPos = getAllowedAuditActionsForCapabilities({
    businessMode: "FULL_POS",
    posEnabled: true,
  });

  for (const action of [
    "PRODUCT_CREATED",
    "PRODUCT_UPDATED",
    "PRODUCT_PRICE_UPDATED",
    "PRODUCT_ACTIVATED",
    "PRODUCT_DEACTIVATED",
    "PRODUCT_IMPORT_COMPLETED",
    "BUSINESS_MODE_CHANGED",
  ]) {
    assert.equal(catalog.includes(action as any), true, `${action} should be available in catalog mode`);
    assert.equal(inventory.includes(action as any), true, `${action} should be available in inventory mode`);
    assert.equal(fullPos.includes(action as any), true, `${action} should be available in full POS mode`);
  }

  assert.equal(catalog.includes("STOCK_ADJUSTED" as any), false);
  assert.equal(catalog.includes("INVOICE_FINALIZED" as any), false);
  assert.equal(inventory.includes("STOCK_ADJUSTED" as any), true);
  assert.equal(inventory.includes("INVOICE_FINALIZED" as any), false);
  assert.equal(fullPos.includes("STOCK_ADJUSTED" as any), true);
  assert.equal(fullPos.includes("INVOICE_FINALIZED" as any), true);
  assert.equal(fullPos.includes("PAYMENT_VOIDED" as any), true);
  assert.equal(fullPos.includes("RETURN_REQUEST_CREATED" as any), true);
});
