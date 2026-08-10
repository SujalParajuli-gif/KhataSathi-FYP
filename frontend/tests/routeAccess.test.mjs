import assert from "node:assert/strict";
import test from "node:test";
import {
  getDefaultRoute,
  getVisibleHistoryCategoryKeys,
  hasCapabilityRouteAccess,
  hasRouteAccess,
  normalizeProtectedPath,
} from "../app/lib/routeAccess.ts";

const catalog = {
  businessMode: "CATALOG_ONLY",
  catalogEnabled: true,
  inventoryEnabled: false,
  posEnabled: false,
  staffDraftRequestsEnabled: false,
  stockTracked: false,
};

const inventory = {
  ...catalog,
  businessMode: "INVENTORY_ONLY",
  inventoryEnabled: true,
  stockTracked: true,
};

const fullPos = {
  ...inventory,
  businessMode: "FULL_POS",
  posEnabled: true,
  staffDraftRequestsEnabled: true,
};

test("non-POS modes send every role to a useful catalog landing route", () => {
  for (const capabilities of [catalog, inventory]) {
    assert.equal(getDefaultRoute("admin", capabilities), "/products");
    assert.equal(getDefaultRoute("manager", capabilities), "/products");
    assert.equal(getDefaultRoute("cashier", capabilities), "/product-lookup");
    assert.equal(getDefaultRoute("staff", capabilities), "/product-lookup");
    assert.equal(
      normalizeProtectedPath("/", "cashier", capabilities),
      "/product-lookup",
    );
  }
});

test("Catalog mode permits product work but rejects direct POS and inventory routes", () => {
  assert.equal(hasCapabilityRouteAccess("/products", catalog), true);
  assert.equal(hasCapabilityRouteAccess("/product-lookup", catalog), true);
  assert.equal(hasCapabilityRouteAccess("/settings", catalog), true);
  assert.equal(hasCapabilityRouteAccess("/billing", catalog), false);
  assert.equal(hasCapabilityRouteAccess("/invoices/example", catalog), false);
  assert.equal(hasCapabilityRouteAccess("/alerts", catalog), false);
  assert.equal(hasCapabilityRouteAccess("/staff-requests", catalog), false);
});

test("Inventory mode enables inventory UI without enabling POS or billing drafts", () => {
  assert.equal(hasCapabilityRouteAccess("/alerts", inventory), true);
  assert.equal(hasCapabilityRouteAccess("/billing", inventory), false);
  assert.equal(hasCapabilityRouteAccess("/invoices", inventory), false);
  assert.equal(hasCapabilityRouteAccess("/staff-requests", inventory), false);
});

test("Full POS preserves role permissions while enabling mode-level POS routes", () => {
  assert.equal(getDefaultRoute("cashier", fullPos), "/billing");
  assert.equal(hasRouteAccess("cashier", "/billing", fullPos), true);
  assert.equal(hasRouteAccess("admin", "/invoices", fullPos), true);
  assert.equal(hasRouteAccess("staff", "/staff-requests", fullPos), true);
  assert.equal(hasRouteAccess("staff", "/billing", fullPos), false);
});

test("direct forbidden paths fall back to the correct safe route in Catalog mode", () => {
  assert.equal(hasRouteAccess("admin", "/billing", catalog), false);
  assert.equal(hasRouteAccess("cashier", "/invoices", catalog), false);
  assert.equal(hasRouteAccess("cashier", "/product-lookup", catalog), true);
  assert.equal(hasRouteAccess("staff", "/product-lookup", catalog), true);
});

test("History exposes only workflows supported by the saved shop mode", () => {
  assert.deepEqual(getVisibleHistoryCategoryKeys(catalog), [
    "product",
    "import",
    "document",
    "system",
  ]);
  assert.deepEqual(getVisibleHistoryCategoryKeys(inventory), [
    "product",
    "stock",
    "import",
    "document",
    "system",
  ]);
  assert.deepEqual(getVisibleHistoryCategoryKeys(fullPos), [
    "sales",
    "product",
    "stock",
    "import",
    "document",
    "return",
    "payment",
    "system",
  ]);
});
