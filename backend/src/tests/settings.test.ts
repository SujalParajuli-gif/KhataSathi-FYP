import test from "node:test";
import assert from "node:assert/strict";
import { buildOverridePinLockedMessage } from "../modules/settings/service";

test("buildOverridePinLockedMessage explains temporary lockout", () => {
  const lockedUntil = new Date(Date.now() + 90_000);
  const message = buildOverridePinLockedMessage(lockedUntil);

  assert.match(message, /Too many invalid override PIN attempts/);
  assert.match(message, /Try again in 2 minutes/);
});
