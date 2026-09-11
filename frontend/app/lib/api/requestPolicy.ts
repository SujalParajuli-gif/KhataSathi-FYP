export const ORDINARY_API_TIMEOUT_MS = 30_000;
export const LONG_API_TIMEOUT_MS = 120_000;

export function isCurrentRequestIdentity(input: {
  requestId: number;
  currentRequestId: number;
  filterIdentity: string;
  currentFilterIdentity: string;
}) {
  return (
    input.requestId === input.currentRequestId &&
    input.filterIdentity === input.currentFilterIdentity
  );
}

export async function refreshAfterSuccessfulMutation(refresh: () => Promise<unknown>) {
  try {
    await refresh();
    return "refreshed" as const;
  } catch {
    return "saved_refresh_failed" as const;
  }
}
