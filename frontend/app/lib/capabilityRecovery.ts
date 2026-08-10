import type { BusinessCapabilities, BusinessMode } from "./api/endpoints";

export type CapabilityIssueKind =
  | "offline"
  | "timeout"
  | "unauthenticated"
  | "forbidden"
  | "rate_limited"
  | "server_unavailable"
  | "unknown";

export type CapabilityIssue = {
  kind: CapabilityIssueKind;
  title: string;
  message: string;
  icon: string;
};

const CACHE_PREFIX = "khatasathi:business-capabilities";
const CACHE_MAX_AGE_MS = 8 * 60 * 60 * 1000;

function errorStatus(error: unknown) {
  return Number((error as { response?: { status?: number } } | undefined)?.response?.status || 0);
}

function errorCode(error: unknown) {
  return String((error as { code?: string } | undefined)?.code || "").toUpperCase();
}

export function classifyCapabilityIssue(error: unknown, online = true): CapabilityIssue {
  const status = errorStatus(error);
  const code = errorCode(error);

  if (!online) {
    return {
      kind: "offline",
      title: "You're offline",
      message: "Reconnect to the internet to refresh this shop's access settings.",
      icon: "wifi_off",
    };
  }
  if (status === 401) {
    return {
      kind: "unauthenticated",
      title: "Your session has expired",
      message: "Sign in again to continue securely.",
      icon: "lock_clock",
    };
  }
  if (status === 403) {
    return {
      kind: "forbidden",
      title: "Shop settings are unavailable",
      message: "Your account is signed in but cannot read the shop's access settings.",
      icon: "lock",
    };
  }
  if (status === 429 || code === "ERR_RATE_LIMIT_COOLDOWN") {
    return {
      kind: "rate_limited",
      title: "Refresh temporarily paused",
      message: "KhataSathi will retry automatically after the request limit clears.",
      icon: "hourglass_top",
    };
  }
  if (code === "ECONNABORTED" || code === "ETIMEDOUT" || code === "ERR_TIMEOUT") {
    return {
      kind: "timeout",
      title: "The server is taking longer than expected",
      message: "Your current screen is safe. KhataSathi will try the connection again.",
      icon: "schedule",
    };
  }
  if (status >= 500 || code === "ERR_NETWORK" || code === "ECONNREFUSED") {
    return {
      kind: "server_unavailable",
      title: "KhataSathi server is unavailable",
      message: "The server may be restarting. Your current screen will stay open while we reconnect.",
      icon: "cloud_off",
    };
  }
  return {
    kind: "unknown",
    title: "Shop access couldn't be refreshed",
    message: "Your current screen is safe. Try refreshing the shop settings again.",
    icon: "sync_problem",
  };
}

export function businessModeLabel(mode: BusinessMode) {
  if (mode === "CATALOG_ONLY") return "Catalog only";
  if (mode === "INVENTORY_ONLY") return "Catalog + inventory";
  return "Full POS";
}

export function capabilityFailureSurface(hasConfirmedCapabilities: boolean) {
  return hasConfirmedCapabilities ? "banner" : "startup";
}

function isBusinessCapabilities(value: unknown): value is BusinessCapabilities {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BusinessCapabilities>;
  return (
    ["CATALOG_ONLY", "INVENTORY_ONLY", "FULL_POS"].includes(String(candidate.businessMode)) &&
    candidate.catalogEnabled === true &&
    typeof candidate.inventoryEnabled === "boolean" &&
    typeof candidate.posEnabled === "boolean" &&
    typeof candidate.staffDraftRequestsEnabled === "boolean" &&
    typeof candidate.stockTracked === "boolean"
  );
}

export function readCachedCapabilities(userId: string, now = Date.now()) {
  if (typeof window === "undefined") return null;
  const key = `${CACHE_PREFIX}:${userId}`;
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(key) || "null") as {
      savedAt?: number;
      capabilities?: unknown;
    } | null;
    if (
      !parsed?.savedAt ||
      now - parsed.savedAt > CACHE_MAX_AGE_MS ||
      !isBusinessCapabilities(parsed.capabilities)
    ) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    return parsed.capabilities;
  } catch {
    window.sessionStorage.removeItem(key);
    return null;
  }
}

export function writeCachedCapabilities(userId: string, capabilities: BusinessCapabilities) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(
    `${CACHE_PREFIX}:${userId}`,
    JSON.stringify({ savedAt: Date.now(), capabilities }),
  );
}

export function capabilityRetryDelay(attempt: number) {
  if (attempt <= 1) return 2_000;
  if (attempt === 2) return 5_000;
  return 15_000;
}
