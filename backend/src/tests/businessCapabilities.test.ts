import assert from "node:assert/strict";
import test from "node:test";
import {
  isBusinessMode,
  resolveBusinessCapabilities,
} from "../modules/settings/capabilities";

test("CATALOG_ONLY never reports stock, POS, or billing drafts as available", () => {
  assert.deepEqual(
    resolveBusinessCapabilities({
      businessMode: "CATALOG_ONLY",
      staffDraftRequestsEnabled: true,
    }),
    {
      businessMode: "CATALOG_ONLY",
      catalogEnabled: true,
      inventoryEnabled: false,
      posEnabled: false,
      staffDraftRequestsEnabled: false,
      stockTracked: false,
    },
  );
});

test("INVENTORY_ONLY enables stock but keeps POS and billing drafts off", () => {
  assert.deepEqual(
    resolveBusinessCapabilities({
      businessMode: "INVENTORY_ONLY",
      staffDraftRequestsEnabled: true,
    }),
    {
      businessMode: "INVENTORY_ONLY",
      catalogEnabled: true,
      inventoryEnabled: true,
      posEnabled: false,
      staffDraftRequestsEnabled: false,
      stockTracked: true,
    },
  );
});

test("FULL_POS still requires the independent staff draft switch", () => {
  assert.equal(
    resolveBusinessCapabilities({
      businessMode: "FULL_POS",
      staffDraftRequestsEnabled: false,
    }).staffDraftRequestsEnabled,
    false,
  );
  assert.equal(
    resolveBusinessCapabilities({
      businessMode: "FULL_POS",
      staffDraftRequestsEnabled: true,
    }).staffDraftRequestsEnabled,
    true,
  );
});

test("business mode validation rejects unknown or missing values", () => {
  assert.equal(isBusinessMode("CATALOG_ONLY"), true);
  assert.equal(isBusinessMode("INVENTORY_ONLY"), true);
  assert.equal(isBusinessMode("FULL_POS"), true);
  assert.equal(isBusinessMode("BILLING_OFF"), false);
  assert.equal(isBusinessMode(undefined), false);
});
