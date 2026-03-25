import React, { useEffect, useMemo, useState } from "react";
import Icon from "~/components/ui/Icon";
import { getLowStockApi, listAuditLogsApi, getReadAlertsApi, markAlertReadApi, markAllAlertsReadApi, markAlertUnreadApi } from "~/lib/api/endpoints";

type AlertLevel = "CRITICAL" | "LOW" | "INFO" | "SYSTEM";
type AlertType = "Stock" | "Invoice" | "Security" | "Backup" | "User";

type AlertItem = {
  id: string;
  title: string;
  desc?: string;
  level: AlertLevel;
  type: AlertType;
  timeLabel: string;
  read: boolean;
};

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function Card({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl bg-white border border-slate-200/60 shadow-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}

function AlertIcon({ type, level }: { type: AlertType; level: AlertLevel }) {
  const iconMap: Record<AlertType, string> = {
    Stock: "inventory_2",
    Invoice: "receipt_long",
    Security: "security",
    Backup: "cloud_sync",
    User: "person",
  };
  const colorMap = {
    CRITICAL: "bg-rose-100 text-rose-600",
    LOW: "bg-amber-100 text-amber-600",
    INFO: "bg-blue-100 text-blue-600",
    SYSTEM: "bg-slate-100 text-slate-600",
  };

  return (
    <div
      className={cn(
        "h-10 w-10 rounded-xl flex items-center justify-center shrink-0",
        colorMap[level],
      )}
    >
      <Icon name={iconMap[type]} className="text-[20px]" />
    </div>
  );
}

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState<"all" | AlertType>("all");
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const [lowStockData, auditData, readData] = await Promise.allSettled([
          getLowStockApi(),
          listAuditLogsApi({ pageSize: 10 }),
          getReadAlertsApi(),
        ]);

        const readKeys = new Set<string>(
          readData.status === "fulfilled" && readData.value ? readData.value.readKeys : []
        );

        const builtAlerts: AlertItem[] = [];

        if (lowStockData.status === "fulfilled" && lowStockData.value) {
          const items = Array.isArray(lowStockData.value)
            ? lowStockData.value
            : [];
          items.forEach((item: any) => {
            const stock = item.stock ?? 0;
            const alertId = `stock-${item.id}`;
            builtAlerts.push({
              id: alertId,
              title:
                stock <= 0
                  ? `Out of stock: ${item.name || "Unknown"}`
                  : `Low stock: ${item.name || "Unknown"}`,
              desc: `${stock} items remaining (Threshold: ${item.lowStockThreshold ?? 10}).`,
              level: stock <= 0 ? "CRITICAL" : "LOW",
              type: "Stock",
              timeLabel: "Now",
              read: readKeys.has(alertId),
            });
          });
        }

        if (auditData.status === "fulfilled" && auditData.value) {
          const logs = auditData.value.logs || [];
          logs.slice(0, 5).forEach((log: any) => {
            const alertId = `audit-${log.id}`;
            builtAlerts.push({
              id: alertId,
              title: log.action || "System activity",
              desc: (function formatMeta(action: string, meta: any) {
                if (!meta) return undefined;
                if (typeof meta === "string") return meta;
                if (action === "INVOICE_FINALIZED" && meta.invoiceNo) {
                  return `Invoice ${meta.invoiceNo} finalized. ${meta.itemCount} items, Net: Rs ${meta.netTotal}.`;
                }
                // Fallback for other objects
                return Object.entries(meta)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(", ");
              })(log.action, log.meta),
              level: "INFO",
              type: (log.action || "").toUpperCase().includes("INVOICE") ? "Invoice" : "User",
              timeLabel: new Date(log.createdAt).toLocaleDateString(),
              read: readKeys.has(alertId),
            });
          });
        }

        setAlerts(builtAlerts);
      } catch {
        // silently fail
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const filtered = useMemo(() => {
    return alerts.filter((a) => {
      const typeMatch = filterType === "all" || a.type === filterType;
      const readMatch = showUnreadOnly ? !a.read : true;
      return typeMatch && readMatch;
    });
  }, [alerts, filterType, showUnreadOnly]);

  const unreadCount = alerts.filter((a) => !a.read).length;

  const handleMarkRead = async (id: string) => {
    setAlerts((prev) =>
      prev.map((a) => (a.id === id ? { ...a, read: true } : a)),
    );
    try {
      await markAlertReadApi(id);
    } catch {}
  };

  const markAllRead = async () => {
    const unreadIds = alerts.filter((a) => !a.read).map((a) => a.id);
    if (unreadIds.length === 0) return;
    setAlerts((prev) => prev.map((a) => ({ ...a, read: true })));
    try {
      await markAllAlertsReadApi(unreadIds);
    } catch {}
  };

  const handleMarkUnread = async (id: string) => {
    setAlerts((prev) =>
      prev.map((a) => (a.id === id ? { ...a, read: false } : a)),
    );
    try {
      await markAlertUnreadApi(id);
    } catch {}
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-slate-400 font-semibold">Loading alerts...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50/50 p-6 space-y-6 font-sans text-slate-900">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 flex items-center gap-3">
            Notifications
            {unreadCount > 0 && (
              <span className="bg-rose-500 text-white text-[12px] font-bold px-2 py-0.5 rounded-full shadow-sm shadow-rose-200">
                {unreadCount} new
              </span>
            )}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            System alerts and activity logs.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={markAllRead}
            className="text-xs font-semibold text-slate-600 hover:text-blue-600 bg-white border border-slate-200 px-3 py-2 rounded-lg shadow-sm transition-colors"
          >
            Mark all as read
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <div className="lg:col-span-1 space-y-4">
          <Card className="p-2 flex flex-col gap-1">
            {["all", "Stock", "Invoice", "Security", "User"].map((type) => (
              <button
                key={type}
                onClick={() => setFilterType(type as any)}
                className={cn(
                  "w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-between group",
                  filterType === type
                    ? "bg-slate-800 text-white shadow-md shadow-slate-200"
                    : "text-slate-600 hover:bg-slate-100",
                )}
              >
                <span>{type === "all" ? "All Alerts" : type}</span>
                {type === "all" && unreadCount > 0 && (
                  <span className="h-2 w-2 rounded-full bg-rose-500" />
                )}
              </button>
            ))}
          </Card>

          <Card className="p-4">
            <label className="flex items-center gap-3 cursor-pointer group">
              <div
                className={cn(
                  "w-10 h-6 rounded-full p-1 transition-colors duration-200",
                  showUnreadOnly ? "bg-blue-600" : "bg-slate-200",
                )}
              >
                <div
                  className={cn(
                    "bg-white w-4 h-4 rounded-full shadow-sm transform transition-transform duration-200",
                    showUnreadOnly ? "translate-x-4" : "translate-x-0",
                  )}
                />
              </div>
              <input
                type="checkbox"
                className="hidden"
                checked={showUnreadOnly}
                onChange={() => setShowUnreadOnly(!showUnreadOnly)}
              />
              <span className="text-sm font-medium text-slate-700 group-hover:text-slate-900">
                Unread Only
              </span>
            </label>
          </Card>
        </div>

        <div className="lg:col-span-3 space-y-3">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-slate-400">
              <Icon
                name="notifications_off"
                className="text-4xl mb-2 opacity-50"
              />
              <p>No notifications found.</p>
            </div>
          ) : (
            filtered.map((alert) => (
              <div
                key={alert.id}
                className={cn(
                  "group relative flex items-start gap-4 p-4 rounded-xl border transition-all duration-200",
                  alert.read
                    ? "bg-white border-slate-200/60"
                    : "bg-white border-blue-200 shadow-sm shadow-blue-50 ring-1 ring-blue-100/50",
                )}
              >
                {!alert.read && (
                  <span className="absolute top-4 right-4 h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
                )}
                <AlertIcon type={alert.type} level={alert.level} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between pr-4">
                    <h3
                      className={cn(
                        "text-sm font-semibold truncate",
                        alert.read ? "text-slate-700" : "text-slate-900",
                      )}
                    >
                      {alert.title}
                    </h3>
                    <span className="text-[11px] text-slate-400 shrink-0">
                      {alert.timeLabel}
                    </span>
                  </div>
                  <p className="text-[13px] text-slate-500 mt-0.5 leading-relaxed">
                    {alert.desc}
                  </p>
                  {!alert.read && (
                    <div className="mt-3 flex gap-3 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => handleMarkRead(alert.id)}
                        className="text-[11px] font-medium text-blue-600 hover:text-blue-700 hover:underline"
                      >
                        Mark as read
                      </button>
                    </div>
                  )}
                  {alert.read && (
                    <div className="mt-3 flex gap-3 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => handleMarkUnread(alert.id)}
                        className="text-[11px] font-medium text-slate-500 hover:text-slate-700 hover:underline"
                      >
                        Mark as unread
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
