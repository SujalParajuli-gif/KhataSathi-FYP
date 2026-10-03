import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolvePendingCheckoutSnapshot } from "../app/lib/billingCheckout.ts";

test("new checkout snapshot binds active request identity into persisted payload", () => {
  const snapshot = resolvePendingCheckoutSnapshot(
    null,
    "checkout-operation-123",
    { items: [{ productId: "p1", qty: 1 }] },
    "request-1",
  );
  assert.equal(snapshot.operationKey, "checkout-operation-123");
  assert.equal(snapshot.payload.draftRequestId, "request-1");
  assert.equal(snapshot.activeDraftRequestId, "request-1");
});

test("restored pending checkout preserves exact operation key and request identity", () => {
  const persisted = {
    operationKey: "checkout-operation-123",
    payload: { draftRequestId: "request-1", items: [{ productId: "p1", qty: 1 }] },
    activeDraftRequestId: "request-1",
  };
  assert.deepEqual(
    resolvePendingCheckoutSnapshot(persisted, "new-key", { items: [] }, null),
    persisted,
  );
});

test("billing checkout has no separate post-checkout completion call", async () => {
  const route = await readFile(new URL("../app/routes/_app.billing.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(route, /completeDraftRequestApi/);
  assert.match(route, /resolvePendingCheckoutSnapshot\(/);
  assert.match(route, /if \(result\?\.esewaPaymentIntent\)[\s\S]*?clearStoredBillingCart\(\)[\s\S]*?setActiveDraftRequestId\(null\)/);
});
