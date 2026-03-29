import { useEffect, useMemo, useState } from "react";
import Icon from "~/components/ui/Icon";
import {
  alertColor,
  alertIcon,
  type AppAlertType,
} from "~/lib/alerts/alerts";
import { useAlerts } from "~/lib/alerts/alerts-context";

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function FilterCard({
  active,
  title,
  count,
  onClick,
}: {
  active: boolean;
  title: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
        className={cn(
          "w-full rounded-[16px] border px-4 py-3 text-left transition",
          active
            ? "border-[#11120d] bg-[#11120d] text-white shadow-lg shadow-slate-200"
            : "border-[var(--app-border)] bg-white text-[var(--app-text-soft)] hover:bg-[var(--app-surface-muted)]",
        )}
      >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-extrabold">{title}</span>
        {typeof count === "number" ? (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-extrabold",
              active ? "bg-white/15 text-white" : "bg-slate-100 text-slate-600",
            )}
          >
            {count}
          </span>
        ) : null}
      </div>
    </button>
  );
}

export default function AlertsPage() {
  const {
    alerts,
    loading,
    unreadCount,
    refreshAlerts,
    markAlertRead,
    markAlertUnread,
    markAllAlertsRead,
  } = useAlerts();
  const [filterType, setFilterType] = useState<"all" | AppAlertType>("all");
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);

  useEffect(() => {
    refreshAlerts(100);
  }, []);

  const filteredAlerts = useMemo(() => {
    return alerts.filter((alert) => {
      const matchesType = filterType === "all" ? true : alert.type === filterType;
      const matchesUnread = showUnreadOnly ? !alert.read : true;
      return matchesType && matchesUnread;
    });
  }, [alerts, filterType, showUnreadOnly]);

  const invoiceCount = alerts.filter((alert) => alert.type === "Invoice").length;
  const stockCount = alerts.filter((alert) => alert.type === "Stock").length;

  async function handleMarkRead(alertKey: string) {
    try {
      await markAlertRead(alertKey);
    } catch {
      await refreshAlerts(100);
    }
  }

  async function handleMarkUnread(alertKey: string) {
    try {
      await markAlertUnread(alertKey);
    } catch {
      await refreshAlerts(100);
    }
  }

  async function handleMarkAllRead() {
    const unreadKeys = alerts.filter((alert) => !alert.read).map((alert) => alert.key);
    if (unreadKeys.length === 0) return;

    try {
      await markAllAlertsRead(unreadKeys);
    } catch {
      await refreshAlerts(100);
    }
  }

  if (loading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <div className="font-semibold text-slate-400">Loading alerts...</div>
      </div>
    );
  }

  return (
    <div className="min-h-full rounded-[28px] bg-[var(--app-page-bg)] p-6 text-slate-900">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-extrabold tracking-tight">Alerts</h1>
            {unreadCount > 0 ? (
              <span className="rounded-full bg-rose-500 px-2.5 py-1 text-[11px] font-extrabold text-white">
                {unreadCount} unread
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-slate-500">
            Real stock and invoice activity alerts with persisted read state.
          </p>
        </div>

        <button
          type="button"
          onClick={handleMarkAllRead}
          disabled={unreadCount === 0}
          className="h-[42px] rounded-[14px] border border-[var(--app-border)] bg-white px-4 text-[13px] font-extrabold text-[var(--app-text-soft)] hover:bg-[var(--app-surface-muted)] disabled:pointer-events-none disabled:opacity-50"
        >
          Mark all as read
        </button>
      </div>

      <div className="mt-6 grid grid-cols-12 gap-6">
        <div className="col-span-12 space-y-4 lg:col-span-3">
          <div className="space-y-2">
            <FilterCard
              active={filterType === "all"}
              title="All alerts"
              count={alerts.length}
              onClick={() => setFilterType("all")}
            />
            <FilterCard
              active={filterType === "Invoice"}
              title="Invoice"
              count={invoiceCount}
              onClick={() => setFilterType("Invoice")}
            />
            <FilterCard
              active={filterType === "Stock"}
              title="Stock"
              count={stockCount}
              onClick={() => setFilterType("Stock")}
            />
          </div>

          <div className="rounded-[18px] border border-[var(--app-border)] bg-white p-4 shadow-sm">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <div>
                <div className="text-[13px] font-extrabold text-slate-900">Unread only</div>
                <div className="mt-1 text-[12px] text-slate-500">
                  Hide alerts that are already marked as read.
                </div>
              </div>
              <div
                className={cn(
                  "flex h-7 w-12 items-center rounded-full border p-1 transition",
                  showUnreadOnly
                    ? "border-[#11120d] bg-[#11120d]"
                    : "border-slate-300 bg-slate-200",
                )}
              >
                <div
                  className={cn(
                    "h-5 w-5 rounded-full bg-white shadow-sm transition",
                    showUnreadOnly ? "translate-x-5" : "translate-x-0",
                  )}
                />
              </div>
              <input
                type="checkbox"
                className="hidden"
                checked={showUnreadOnly}
                onChange={() => setShowUnreadOnly((value) => !value)}
              />
            </label>
          </div>
        </div>

        <div className="col-span-12 space-y-3 lg:col-span-9">
          {filteredAlerts.length === 0 ? (
            <div className="flex min-h-[280px] flex-col items-center justify-center rounded-[20px] border border-dashed border-[var(--app-border)] bg-white text-slate-400">
              <Icon name="notifications_off" className="text-[40px]" />
              <div className="mt-3 text-[14px] font-semibold">No alerts found.</div>
            </div>
          ) : (
            filteredAlerts.map((alert) => (
              <div
                key={alert.key}
                className={cn(
                  "rounded-[18px] border-2 bg-white p-4 shadow-sm transition",
                  alert.read
                    ? "border-[var(--app-border)]"
                    : "border-[var(--app-warning-border)] shadow-orange-100/50",
                )}
              >
                <div className="flex items-start gap-4">
                  <div
                    className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] ${alertColor(
                      alert,
                    )}`}
                  >
                    <Icon name={alertIcon(alert)} className="text-[20px]" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="truncate text-[14px] font-extrabold text-slate-900">
                            {alert.title}
                          </h3>
                          {!alert.read ? (
                              <span className="rounded-full bg-[var(--app-warning-bg)] px-2 py-0.5 text-[10px] font-extrabold text-[var(--app-warning-text)]">
                                New
                              </span>
                          ) : null}
                        </div>
                        <div className="mt-1 text-[13px] leading-6 text-slate-600">
                          {alert.message}
                        </div>
                      </div>

                      <div className="shrink-0 text-[11px] font-semibold text-slate-400">
                        {alert.timeLabel}
                      </div>
                    </div>

                    <div className="mt-4 flex items-center gap-3">
                      {alert.read ? (
                        <button
                          type="button"
                          onClick={() => handleMarkUnread(alert.key)}
                          className="text-[12px] font-extrabold text-slate-500 hover:text-slate-700"
                        >
                          Mark as unread
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleMarkRead(alert.key)}
                          className="text-[12px] font-extrabold text-[var(--app-text)] hover:text-[var(--app-text-soft)]"
                        >
                          Mark as read
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
