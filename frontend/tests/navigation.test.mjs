import assert from "node:assert/strict";
import test from "node:test";
import {
  NAV_ITEMS,
  WORKSPACE_GROUPS,
  getAuthorizedNavItems,
  getMobileBottomNavItems,
  getMobileDrawerItems,
  partitionNavItems,
  isRouteActive,
} from "../app/config/navigation.ts";

const fullPosCapabilities = {
  businessMode: "FULL_POS",
  catalogEnabled: true,
  inventoryEnabled: true,
  posEnabled: true,
  staffDraftRequestsEnabled: true,
  stockTracked: true,
};

const catalogOnlyCapabilities = {
  businessMode: "CATALOG_ONLY",
  catalogEnabled: true,
  inventoryEnabled: false,
  posEnabled: false,
  staffDraftRequestsEnabled: false,
  stockTracked: false,
};

const inventoryOnlyCapabilities = {
  businessMode: "INVENTORY_ONLY",
  catalogEnabled: true,
  inventoryEnabled: true,
  posEnabled: false,
  staffDraftRequestsEnabled: false,
  stockTracked: true,
};

test("Product Lookup is accessible to every role in every business mode", () => {
  const roles = ["admin", "manager", "cashier", "staff"];
  const modes = [fullPosCapabilities, catalogOnlyCapabilities, inventoryOnlyCapabilities];

  for (const mode of modes) {
    for (const role of roles) {
      const items = getAuthorizedNavItems(role, mode);
      const lookup = items.find((item) => item.to === "/product-lookup");
      assert.ok(lookup, `Role ${role} in ${mode.businessMode} must have Product Lookup`);
      assert.equal(lookup.label, "Product Lookup");
    }
  }
});

test("Mobile bottom navigation returns authorized destinations and More trigger", () => {
  const roles = ["admin", "manager", "cashier", "staff"];

  for (const role of roles) {
    const bottomItems = getMobileBottomNavItems(role, fullPosCapabilities);
    assert.ok(bottomItems.length >= 2, `${role} should have at least 2 primary bottom items`);
    assert.ok(bottomItems.length <= 4, `${role} should have at most 4 primary bottom items`);

    // Verify all returned items are authorized for this role
    for (const item of bottomItems) {
      assert.ok(
        item.roles.includes(role),
        `Item ${item.to} must be authorized for role ${role}`,
      );
    }
  }
});

test("CRITICAL DEDUPLICATION: No destination appears in both bottom nav and mobile drawer", () => {
  const roles = ["admin", "manager", "cashier", "staff"];
  const modes = [fullPosCapabilities, catalogOnlyCapabilities, inventoryOnlyCapabilities];

  for (const mode of modes) {
    for (const role of roles) {
      const bottomItems = getMobileBottomNavItems(role, mode);
      const drawerItems = getMobileDrawerItems(role, mode, bottomItems);

      const bottomRoutes = new Set(bottomItems.map((item) => item.to));
      const drawerRoutes = new Set(drawerItems.map((item) => item.to));

      for (const route of bottomRoutes) {
        assert.equal(
          drawerRoutes.has(route),
          false,
          `Route ${route} in bottom nav must NOT appear in mobile drawer for ${role} in ${mode.businessMode}`,
        );
      }

      // Check completeness: union of bottom items and drawer items must equal all authorized items
      const allAuthorized = getAuthorizedNavItems(role, mode);
      const combinedRoutes = new Set([...bottomRoutes, ...drawerRoutes]);

      for (const item of allAuthorized) {
        assert.ok(
          combinedRoutes.has(item.to),
          `Authorized route ${item.to} must be present in either bottom nav or drawer for ${role}`,
        );
      }
    }
  }
});

test("Role and capability filtering correctly restricts restricted routes", () => {
  // Staff cannot see Billing or Settings
  const staffItems = getAuthorizedNavItems("staff", fullPosCapabilities);
  assert.equal(staffItems.some((item) => item.to === "/billing"), false);
  assert.equal(staffItems.some((item) => item.to === "/settings"), false);

  // Cashier cannot see Expenses or Settings
  const cashierItems = getAuthorizedNavItems("cashier", fullPosCapabilities);
  assert.equal(cashierItems.some((item) => item.to === "/expenses"), false);
  assert.equal(cashierItems.some((item) => item.to === "/settings"), false);

  // In Catalog mode, POS routes (Billing, Invoices, Receivables) are not permitted
  const catalogAdminItems = getAuthorizedNavItems("admin", catalogOnlyCapabilities);
  assert.equal(catalogAdminItems.some((item) => item.to === "/billing"), false);
  assert.equal(catalogAdminItems.some((item) => item.to === "/invoices"), false);
  assert.equal(catalogAdminItems.some((item) => item.to === "/receivables"), false);

  // In Inventory mode, Purchases is permitted, but Billing is not
  const invAdminItems = getAuthorizedNavItems("admin", inventoryOnlyCapabilities);
  assert.equal(invAdminItems.some((item) => item.to === "/purchases"), true);
  assert.equal(invAdminItems.some((item) => item.to === "/billing"), false);
});

test("partitionNavItems hides empty workspace groups after role/capability filtering", () => {
  // Staff only has Requests in operations group, so sales, inventory, and system groups must be omitted
  const staffItems = getAuthorizedNavItems("staff", fullPosCapabilities);
  const { groups } = partitionNavItems(staffItems);

  for (const group of groups) {
    assert.ok(group.items.length > 0, `Group ${group.name} must not be empty`);
  }

  const groupIds = groups.map((g) => g.id);
  assert.equal(groupIds.includes("sales"), false);
  assert.equal(groupIds.includes("inventory"), false);
  assert.equal(groupIds.includes("system"), false);
  assert.equal(groupIds.includes("operations"), true);
});

test("isRouteActive properly matches exact and nested sub-paths", () => {
  assert.equal(isRouteActive("/", "/", true), true);
  assert.equal(isRouteActive("/billing", "/", true), false);
  assert.equal(isRouteActive("/invoices", "/invoices"), true);
  assert.equal(isRouteActive("/invoices/123", "/invoices"), true);
  assert.equal(isRouteActive("/invoices-archive", "/invoices"), false);
  assert.equal(isRouteActive("/products/imports/abc", "/products"), true);
});
