import { useEffect, useMemo, useState } from "react";
import Icon from "~/components/ui/Icon";
import PaginationBar from "~/components/ui/PaginationBar";
import {
  alertColor,
  alertIcon,
  alertTone,
  type AppAlertType,
} from "~/lib/alerts/alerts";
import { useAlerts } from "~/lib/alerts/alerts-context";

// utility to cleanly join tailwind classes
function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

// we use this to keep the current page number inside the valid pagination range
function clampPage(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

// this renders one sidebar filter button with its active state and optional count badge
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
          ? "border-[#11120d] bg-[#11120d] text-white  "
          : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6]",
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

// the standalone alerts page — shows a list of system alerts (low stock, invoice updates)
// connects directly to the global AlertsProvider via useAlerts hook
export default function AlertsPage() {
  const {
    alerts,
    loading,
    unreadCount,
    refreshAlerts,
    markAlertRead,
    markAlertUnread,
    markAllAlertsRead,
    resolveAlert,
    dismissAlert,
  } = useAlerts();
  const [filterType, setFilterType] = useState<"all" | AppAlertType>("all"); // tracks which alert type tab is active
  const [showUnreadOnly, setShowUnreadOnly] = useState(false); // lets the user hide alerts that were already seen
  const [page, setPage] = useState(1); // stores the current alerts page in the list
  const [pageSize, setPageSize] = useState(20);

  useEffect(() => {
    // loading a fresh batch of alerts when the page first opens
    // we ask for a higher limit here so the user can browse more history without another page-level fetch flow
    refreshAlerts(500);
  }, []);

  // resetting the page back to 1 whenever a filter changes
  useEffect(() => {
    setPage(1);
  }, [filterType, showUnreadOnly]);

  // computing the filtered list of alerts based on current selections
  const filteredAlerts = useMemo(() => {
    return alerts.filter((alert) => {
      const matchesType =
        filterType === "all" ? true : alert.type === filterType;
      const matchesUnread = showUnreadOnly ? !alert.read : true;
      return matchesType && matchesUnread;
    });
  }, [alerts, filterType, showUnreadOnly]);

  // calculating counts for the sidebar filter tabs
  const typeFilters: AppAlertType[] = ["Invoice", "Stock", "Product", "Return", "Payment", "System"];
  const typeCounts = useMemo(() => {
    return typeFilters.reduce<Record<AppAlertType, number>>((acc, type) => {
      acc[type] = alerts.filter((alert) => alert.type === type).length;
      return acc;
    }, {} as Record<AppAlertType, number>);
  }, [alerts]);

  // setting up pagination logic
  const totalPages = Math.max(1, Math.ceil(filteredAlerts.length / pageSize));
  const pageClamped = clampPage(page, 1, totalPages);

  // slicing the filtered array to only show the current page
  const pageItems = useMemo(() => {
    const start = (pageClamped - 1) * pageSize;
    return filteredAlerts.slice(start, start + pageSize);
  }, [filteredAlerts, pageClamped, pageSize]);
  const pageStart = filteredAlerts.length === 0 ? 0 : (pageClamped - 1) * pageSize;
  const pageEnd = filteredAlerts.length === 0 ? 0 : pageStart + pageItems.length;

  // this marks one alert as read, and if that request fails we reload the list so the page stays in sync
  async function handleMarkRead(alertKey: string) {
    try {
      await markAlertRead(alertKey);
    } catch {
      await refreshAlerts(500);
    }
  }

  // this does the reverse action so the user can put an alert back into unread state
  async function handleMarkUnread(alertKey: string) {
    try {
      await markAlertUnread(alertKey);
    } catch {
      await refreshAlerts(500);
    }
  }

  // this finds every unread alert and sends them together in one bulk update call
  // we skip the request completely when there is nothing left to mark
  async function handleMarkAllRead() {
    const unreadKeys = alerts
      .filter((alert) => !alert.read)
      .map((alert) => alert.key);
    if (unreadKeys.length === 0) return;

    try {
      await markAllAlertsRead(unreadKeys);
    } catch {
      await refreshAlerts(500);
    }
  }

  // this handles when the alert provider is still fetching data for the first render
  if (loading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <div className="font-semibold text-slate-400">Loading alerts...</div>
      </div>
    );
  }

  return (
    <div className="min-h-full rounded-[28px] bg-[#F1F1F1] p-6 text-slate-900">
      {/* this top bar keeps the page title and the bulk action button aligned while still wrapping cleanly on smaller screens */}
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-extrabold">
              Get Notified About Everything!
            </h1>
            {unreadCount > 0 ? (
              <span className="rounded-full bg-[#2F67D8] px-2.5 py-1 text-[11px] font-extrabold text-white">
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
          className="h-[42px] rounded-[14px] border border-[#CFCFD3] bg-white px-4 text-[13px] font-extrabold text-[#565449] hover:bg-[#F3F4F6] disabled:pointer-events-none disabled:opacity-50"
        >
          Mark all as read
        </button>
      </div>

      <div className="mt-6 grid grid-cols-12 gap-6">
        {/* the left column holds filters, and the right column gives more width to the alert cards because message text needs more space */}
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
              count={typeCounts.Invoice}
              onClick={() => setFilterType("Invoice")}
            />
            {typeFilters.filter((type) => type !== "Invoice").map((type) => (
              <FilterCard
                key={type}
                active={filterType === type}
                title={type}
                count={typeCounts[type]}
                onClick={() => setFilterType(type)}
              />
            ))}
          </div>

          <div className="rounded-[18px] border border-[#CFCFD3] bg-white p-4 ">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <div>
                <div className="text-[13px] font-extrabold text-slate-900">
                  Unread only
                </div>
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
                    "h-5 w-5 rounded-full bg-white  transition",
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
            /* this empty state uses a dashed card so it looks intentionally inactive instead of feeling like missing content */
            <div className="flex min-h-[280px] flex-col items-center justify-center rounded-[20px] border border-dashed border-[#CFCFD3] bg-white text-slate-400">
              <Icon name="notifications_off" className="text-[40px]" />
              <div className="mt-3 text-[14px] font-semibold">
                No alerts found.
              </div>
            </div>
          ) : (
            pageItems.map((alert) => {
              const tone = alertTone(alert); // precomputing the alert color set once so the card classes stay readable

              return (
                <div
                  key={alert.key}
                  className={cn(
                    "rounded-[18px] border-2 p-4 transition",
                    alert.read ? "border-[#D7DEE9] bg-white" : tone.pageUnread,
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
                              <span
                                className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold ${tone.badge}`}
                              >
                                New
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-1 text-[13px] leading-6 text-slate-600">
                            {alert.message}
                          </div>
                        </div>

                        <div
                          className={cn(
                            "shrink-0 text-[11px] font-semibold",
                            alert.read ? "text-slate-400" : tone.time,
                          )}
                        >
                          {alert.timeLabel}
                        </div>
                      </div>

                      <div className="mt-4 flex items-center gap-3">
                        {alert.read ? (
                          <button
                            type="button"
                            onClick={() => handleMarkUnread(alert.key)}
                            className={`text-[12px] font-extrabold ${tone.action}`}
                          >
                            Mark as unread
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleMarkRead(alert.key)}
                            className={`text-[12px] font-extrabold ${tone.action}`}
                          >
                            Mark as read
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => resolveAlert(alert.key)}
                          className="text-[12px] font-extrabold text-emerald-700 hover:text-emerald-900"
                        >
                          Resolve
                        </button>
                        <button
                          type="button"
                          onClick={() => dismissAlert(alert.key)}
                          className="text-[12px] font-extrabold text-slate-500 hover:text-slate-800"
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}

          {filteredAlerts.length > 0 ? (
            <PaginationBar
              page={pageClamped}
              totalPages={totalPages}
              total={filteredAlerts.length}
              start={pageStart}
              end={pageEnd}
              label="alerts"
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPageSize(nextPageSize);
                setPage(1);
              }}
              className="rounded-[18px] border border-[#CFCFD3]"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
