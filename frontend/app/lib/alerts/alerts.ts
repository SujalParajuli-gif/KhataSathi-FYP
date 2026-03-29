import { listAlertsApi } from "~/lib/api/endpoints";
import { formatAlertTimeLabel } from "~/lib/invoices";

export type AppAlertLevel = "CRITICAL" | "LOW" | "INFO";
export type AppAlertType = "Stock" | "Invoice";

export type AppAlert = {
  key: string;
  title: string;
  message: string;
  level: AppAlertLevel;
  type: AppAlertType;
  createdAt: string;
  timeLabel: string;
  read: boolean;
};

export function alertIcon(alert: Pick<AppAlert, "type" | "level">) {
  if (alert.type === "Stock") return "inventory_2";
  if (alert.level === "CRITICAL") return "error";
  return "receipt_long";
}

export function alertColor(alert: Pick<AppAlert, "type" | "level">) {
  if (alert.level === "CRITICAL") {
    return "bg-[var(--app-danger-bg)] text-[var(--app-danger-text)]";
  }
  if (alert.type === "Stock") {
    return "bg-[var(--app-warning-bg)] text-[var(--app-warning-text)]";
  }
  return "bg-[var(--app-surface-muted)] text-[var(--app-text-soft)]";
}

export function normalizeAlert(raw: any): AppAlert {
  const createdAt = String(raw.createdAt || new Date().toISOString());
  return {
    key: raw.key,
    title: raw.title || "Alert",
    message: raw.message || "",
    level: raw.level || "INFO",
    type: raw.type || "Invoice",
    createdAt,
    timeLabel: formatAlertTimeLabel(createdAt),
    read: Boolean(raw.read),
  };
}

export async function fetchAlerts(limit?: number) {
  const response = await listAlertsApi(limit);
  const alerts = Array.isArray(response?.alerts) ? response.alerts : [];
  return alerts.map(normalizeAlert);
}
