import assert from "node:assert/strict";
import test from "node:test";
import { isHorizontalGestureInteractiveTarget } from "../app/hooks/useHorizontalGesture.ts";
import {
  effectiveStaffDraftRequests,
  isBusinessAccessDraftDirty,
  stageBusinessModeSelection,
} from "../app/lib/settings/businessModeDraft.ts";

test("staff draft requests can only be effective in Full POS", () => {
  assert.equal(effectiveStaffDraftRequests("CATALOG_ONLY", true), false);
  assert.equal(effectiveStaffDraftRequests("INVENTORY_ONLY", true), false);
  assert.equal(effectiveStaffDraftRequests("FULL_POS", true), true);
  assert.equal(effectiveStaffDraftRequests("FULL_POS", false), false);
});

test("changing the Full POS staff toggle creates an access draft", () => {
  assert.equal(
    isBusinessAccessDraftDirty({
      draftMode: "FULL_POS",
      savedMode: "FULL_POS",
      draftStaffRequests: true,
      savedStaffRequests: false,
    }),
    true,
  );
  assert.equal(
    isBusinessAccessDraftDirty({
      draftMode: "CATALOG_ONLY",
      savedMode: "CATALOG_ONLY",
      draftStaffRequests: true,
      savedStaffRequests: false,
    }),
    false,
  );
});

test("reselecting the active draft mode does not reset the staff toggle", () => {
  assert.deepEqual(
    stageBusinessModeSelection({
      currentDraftMode: "FULL_POS",
      currentStaffRequests: true,
      nextMode: "FULL_POS",
      savedMode: "CATALOG_ONLY",
      savedStaffRequests: false,
    }),
    { mode: "FULL_POS", staffDraftRequestsEnabled: true },
  );
});

test("entering Full POS restores the saved staff setting only for a saved Full POS shop", () => {
  assert.deepEqual(
    stageBusinessModeSelection({
      currentDraftMode: "INVENTORY_ONLY",
      currentStaffRequests: false,
      nextMode: "FULL_POS",
      savedMode: "FULL_POS",
      savedStaffRequests: true,
    }),
    { mode: "FULL_POS", staffDraftRequestsEnabled: true },
  );
  assert.deepEqual(
    stageBusinessModeSelection({
      currentDraftMode: "CATALOG_ONLY",
      currentStaffRequests: false,
      nextMode: "FULL_POS",
      savedMode: "CATALOG_ONLY",
      savedStaffRequests: false,
    }),
    { mode: "FULL_POS", staffDraftRequestsEnabled: false },
  );
});

test("page swipe gestures ignore buttons, links, labels and switches", () => {
  let inspectedSelector = "";
  const target = {
    closest(selector) {
      inspectedSelector = selector;
      return {};
    },
  };
  assert.equal(isHorizontalGestureInteractiveTarget(target), true);
  for (const interactiveSelector of [
    "button",
    "a",
    "label",
    "[role='switch']",
  ]) {
    assert.match(inspectedSelector, new RegExp(interactiveSelector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
