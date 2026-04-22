import { listAlertsApi } from "~/lib/api/endpoints";
import { formatAlertTimeLabel } from "~/lib/invoices";

// the alert severity levels — CRITICAL for out of stock, LOW for below threshold, INFO for invoice activity
export type AppAlertLevel = "CRITICAL" | "LOW" | "INFO";
export type AppAlertType = "Stock" | "Invoice";

// the shape of each alert used across the frontend
export type AppAlert = {
  key: string; // unique identifier used for read/unread tracking
  title: string;
  message: string;
  level: AppAlertLevel;
  type: AppAlertType;
  createdAt: string;
  timeLabel: string; // human-readable time like "5m ago" or "Apr 18"
  read: boolean;
};

// mapping each alert type to a Material Symbols icon name
export function alertIcon(alert: Pick<AppAlert, "type" | "level">) {
  if (alert.type === "Stock") return "inventory_2";
  if (alert.level === "CRITICAL") return "error";
  return "receipt_long"; // default icon for invoice alerts
}

// returning a set of CSS class names based on the alert type and severity
// we use different color palettes for critical (red), stock (amber), and info (blue) alerts
export function alertTone(alert: Pick<AppAlert, "type" | "level">) {
  if (alert.level === "CRITICAL") {
    return {
      icon: "bg-[#FFF1F4] text-[#D63C67]",
      unreadDot: "bg-[#E5486E]",
      previewUnread: "bg-[#FFF8FA]",
      previewHover: "hover:bg-[#FFF1F5]",
      pageUnread: "border-[#F6B8C8] bg-[#FFF9FB]",
      badge: "bg-[#FFE4EA] text-[#C92A57]",
      time: "text-[#CC3A62]",
      action: "text-[#C92A57] hover:text-[#A81F49]",
    };
  }

  if (alert.type === "Stock") {
    return {
      icon: "bg-[#FFF4DD] text-[#C8810A]",
      unreadDot: "bg-[#D18B14]",
      previewUnread: "bg-[#FFFBF3]",
      previewHover: "hover:bg-[#FFF5E6]",
      pageUnread: "border-[#F1CD8B] bg-[#FFFCF6]",
      badge: "bg-[#FFF0D5] text-[#B86E07]",
      time: "text-[#BA730E]",
      action: "text-[#9E6208] hover:text-[#7F4D05]",
    };
  }

  // default blue tones for invoice/info alerts
  return {
    icon: "bg-[#EEF4FF] text-[#2F67D8]",
    unreadDot: "bg-[#2F67D8]",
    previewUnread: "bg-[#F6F9FF]",
    previewHover: "hover:bg-[#EEF4FF]",
    pageUnread: "border-[#C5D7FF] bg-[#FBFCFF]",
    badge: "bg-[#E8F0FF] text-[#2F67D8]",
    time: "text-[#5E7FD1]",
    action: "text-[#275DCC] hover:text-[#1D49A8]",
  };
}

// shortcut to get just the icon color classes for an alert
export function alertColor(alert: Pick<AppAlert, "type" | "level">) {
  return alertTone(alert).icon;
}

// converting a raw alert object from the API into our AppAlert format
// we also compute the human-readable time label here
export function normalizeAlert(raw: any): AppAlert {
  const createdAt = String(raw.createdAt || new Date().toISOString());
  return {
    key: raw.key,
    title: raw.title || "Alert",
    message: raw.message || "",
    level: raw.level || "INFO",
    type: raw.type || "Invoice",
    createdAt,
    timeLabel: formatAlertTimeLabel(createdAt), // converting ISO date to "5m ago" style label
    read: Boolean(raw.read),
  };
}

// fetching alerts from the API and normalizing them into AppAlert objects
export async function fetchAlerts(limit?: number) {
  const response = await listAlertsApi(limit);
  const alerts = Array.isArray(response?.alerts) ? response.alerts : [];
  return alerts.map(normalizeAlert);
}

