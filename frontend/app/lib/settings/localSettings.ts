export const LOCAL_SETTINGS_KEYS = {
  defaultLowStockThreshold: "ks_defaultLowStockThreshold",
  wholesaleQtyThreshold: "ks_wholesaleQtyThreshold",
  loyaltyDiscountPercent: "ks_loyaltyDiscountPercent",
} as const;

export function readStoredNumber(key: string, fallback: number) {
  if (typeof window === "undefined") return fallback;

  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;

    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function writeStoredNumber(key: string, value: number) {
  if (typeof window === "undefined") return;

  try {
    localStorage.setItem(key, String(value));
  } catch {
    // ignore storage write failures for local-only admin defaults
  }
}
