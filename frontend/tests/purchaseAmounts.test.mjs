import test from "node:test";
import assert from "node:assert/strict";
import { decimalUnits, purchaseLineAmounts, formatUnits } from "../app/lib/domain/products/purchaseAmounts.ts";
import { hasRouteAccess } from "../app/lib/routeAccess.ts";

test("purchase rounding and fractional conversion use exact fixed-point arithmetic", () => {
  assert.equal(purchaseLineAmounts("0.005", "1", "1").money, "0.01");
  assert.equal(purchaseLineAmounts("1.5", "10.125", "2").stock, "3.000");
  assert.equal(purchaseLineAmounts("1.5", "10.125", "2").money, "15.19");
  assert.equal(formatUnits(decimalUnits("0", 2), 2), "0.00");
  for (const value of ["1e3", "-1", "NaN", "0.0001"]) assert.throws(() => decimalUnits(value, 3));
  assert.throws(() => purchaseLineAmounts("0.001", "1", "0.001"), /three decimal/);
});
test("purchase route requires privileged role and enabled inventory", () => {
  const caps = { businessMode: "FULL_POS", catalogEnabled: true, inventoryEnabled: true, posEnabled: true, staffDraftRequestsEnabled: true, stockTracked: true };
  assert.equal(hasRouteAccess("admin", "/purchases", caps), true);
  assert.equal(hasRouteAccess("manager", "/purchases", caps), true);
  for (const role of ["cashier", "staff"]) assert.equal(hasRouteAccess(role, "/purchases", caps), false);
  assert.equal(hasRouteAccess("manager", "/purchases", { ...caps, inventoryEnabled: false }), false);
});
