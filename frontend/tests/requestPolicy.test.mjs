import assert from "node:assert/strict";
import test from "node:test";
import {
  LONG_API_TIMEOUT_MS,
  ORDINARY_API_TIMEOUT_MS,
  isCurrentRequestIdentity,
  refreshAfterSuccessfulMutation,
} from "../app/lib/api/requestPolicy.ts";

test("ordinary and upload API deadlines are explicit", () => {
  assert.equal(ORDINARY_API_TIMEOUT_MS, 30_000);
  assert.ok(LONG_API_TIMEOUT_MS > ORDINARY_API_TIMEOUT_MS);
});

test("an old request cannot apply after request or filter identity changes", () => {
  assert.equal(isCurrentRequestIdentity({
    requestId: 1,
    currentRequestId: 2,
    filterIdentity: "old",
    currentFilterIdentity: "new",
  }), false);
  assert.equal(isCurrentRequestIdentity({
    requestId: 2,
    currentRequestId: 2,
    filterIdentity: "old",
    currentFilterIdentity: "new",
  }), false);
});

test("a refresh failure remains a saved mutation outcome", async () => {
  const outcome = await refreshAfterSuccessfulMutation(async () => {
    throw new Error("list unavailable");
  });
  assert.equal(outcome, "saved_refresh_failed");
});
