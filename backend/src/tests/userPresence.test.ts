import test from "node:test";
import assert from "node:assert/strict";
import { isPresenceActive, PRESENCE_ACTIVE_WINDOW_MS } from "../modules/users/service";

test("isPresenceActive treats users pinged within two minutes as present", () => {
  const now = new Date("2026-07-14T08:00:00.000Z");

  assert.equal(isPresenceActive(now, now), true);
  assert.equal(
    isPresenceActive(new Date(now.getTime() - PRESENCE_ACTIVE_WINDOW_MS), now),
    true,
  );
  assert.equal(
    isPresenceActive(new Date(now.getTime() - PRESENCE_ACTIVE_WINDOW_MS - 1), now),
    false,
  );
  assert.equal(isPresenceActive(null, now), false);
  assert.equal(isPresenceActive("not-a-date", now), false);
});
