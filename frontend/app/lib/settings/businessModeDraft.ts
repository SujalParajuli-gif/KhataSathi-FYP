import type { BusinessMode } from "~/lib/api/endpoints";

export function effectiveStaffDraftRequests(
  mode: BusinessMode,
  requested: boolean,
) {
  return mode === "FULL_POS" && requested;
}

export function isBusinessAccessDraftDirty({
  draftMode,
  savedMode,
  draftStaffRequests,
  savedStaffRequests,
}: {
  draftMode: BusinessMode;
  savedMode: BusinessMode;
  draftStaffRequests: boolean;
  savedStaffRequests: boolean;
}) {
  return (
    draftMode !== savedMode ||
    effectiveStaffDraftRequests(draftMode, draftStaffRequests) !==
      savedStaffRequests
  );
}

export function stageBusinessModeSelection({
  currentDraftMode,
  currentStaffRequests,
  nextMode,
  savedMode,
  savedStaffRequests,
}: {
  currentDraftMode: BusinessMode;
  currentStaffRequests: boolean;
  nextMode: BusinessMode;
  savedMode: BusinessMode;
  savedStaffRequests: boolean;
}) {
  if (nextMode === currentDraftMode) {
    return {
      mode: currentDraftMode,
      staffDraftRequestsEnabled: currentStaffRequests,
    };
  }

  return {
    mode: nextMode,
    staffDraftRequestsEnabled:
      nextMode === "FULL_POS" && savedMode === "FULL_POS"
        ? savedStaffRequests
        : false,
  };
}
