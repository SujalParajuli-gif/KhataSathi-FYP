import assert from "node:assert/strict";
import test from "node:test";
import {
  businessModeLabel,
  capabilityFailureSurface,
  capabilityRetryDelay,
  classifyCapabilityIssue,
} from "../app/lib/capabilityRecovery.ts";

test("capability failures are classified into relevant user-facing states", () => {
  assert.equal(classifyCapabilityIssue(new Error("offline"), false).kind, "offline");
  assert.equal(classifyCapabilityIssue({ code: "ECONNABORTED" }).kind, "timeout");
  assert.equal(classifyCapabilityIssue({ response: { status: 401 } }).kind, "unauthenticated");
  assert.equal(classifyCapabilityIssue({ response: { status: 403 } }).kind, "forbidden");
  assert.equal(classifyCapabilityIssue({ response: { status: 429 } }).kind, "rate_limited");
  assert.equal(classifyCapabilityIssue({ response: { status: 503 } }).kind, "server_unavailable");
});

test("capability retries back off without growing beyond the operational interval", () => {
  assert.equal(capabilityRetryDelay(1), 2_000);
  assert.equal(capabilityRetryDelay(2), 5_000);
  assert.equal(capabilityRetryDelay(3), 15_000);
  assert.equal(capabilityRetryDelay(20), 15_000);
});

test("a background capability failure preserves a working application", () => {
  assert.equal(capabilityFailureSurface(true), "banner");
  assert.equal(capabilityFailureSurface(false), "startup");
});

test("saved capability modes use readable shop language", () => {
  assert.equal(businessModeLabel("CATALOG_ONLY"), "Catalog only");
  assert.equal(businessModeLabel("INVENTORY_ONLY"), "Catalog + inventory");
  assert.equal(businessModeLabel("FULL_POS"), "Full POS");
});
