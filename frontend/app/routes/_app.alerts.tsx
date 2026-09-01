import { useEffect, useMemo, useState, useRef } from "react";
import Icon from "~/components/ui/Icon";
import PaginationBar from "~/components/ui/PaginationBar";
import { MobileFilterTabs } from "~/components/ui/MobileFilters";
import {
  alertColor,
  alertIcon,
  alertTone,
  type AppAlert,
  type AppAlertType,
} from "~/lib/alerts/alerts";
import { useAlerts } from "~/lib/alerts/alerts-context";
import { useHorizontalGesture } from "~/hooks/useHorizontalGesture";
import { useBusinessCapabilities } from "~/lib/businessCapabilities";

// utility to cleanly join tailwind classes
function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

// we use this to keep the current page number inside the valid pagination range
function clampPage(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

// AlertRow handles the display and interaction (swipe, actions) for a single alert
function AlertRow({
  alert,
  onMarkRead,
  onMarkUnread,
  onResolve,
  onDismiss,
}: {
  alert: AppAlert;
  onMarkRead: (key: string) => void;
  onMarkUnread: (key: string) => void;
  onResolve: (key: string) => void;
  onDismiss: (key: string) => void;
}) {
  const tone = alertTone(alert);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);

  // Constants for swipe
  const THRESHOLD_LEFT = -160;
  const THRESHOLD_RIGHT = 80;

  const swipeGesture = useHorizontalGesture<HTMLDivElement>({
    enabled: typeof window !== "undefined" && window.innerWidth < 768,
    threshold: 48,
    onStart: () => setIsSwiping(true),
    onMove: (currentX) => {
      let offset = currentX;
    // Add resistance if pulling past threshold
      if (offset < 0) {
        if (offset < THRESHOLD_LEFT - 40) {
          offset = (THRESHOLD_LEFT - 40) + (offset - (THRESHOLD_LEFT - 40)) * 0.2;
        }
      } else if (offset > THRESHOLD_RIGHT + 40) {
        offset = (THRESHOLD_RIGHT + 40) + (offset - (THRESHOLD_RIGHT + 40)) * 0.2;
      }
      setSwipeOffset(offset);
    },
    onSwipeLeft: () => setSwipeOffset(THRESHOLD_LEFT),
    onSwipeRight: () => setSwipeOffset(THRESHOLD_RIGHT),
    onEnd: (completed) => {
      setIsSwiping(false);
      if (!completed) setSwipeOffset(0);
    },
  });

  const isUnread = !alert.read;
  
  return (
    <div className="group relative overflow-hidden rounded-[16px] border border-[#DADDE3] shadow-sm md:overflow-visible md:rounded-none md:border-x-0 md:border-t-0 md:border-b md:border-slate-100 md:shadow-none md:last:border-b-0">
      {/* Background Action Buttons (Revealed on Swipe) */}
      <div className="absolute inset-0 z-0 flex justify-between overflow-hidden rounded-[16px] bg-slate-100 md:hidden">
        {/* Left Side: Right Swipe Action (Read/Unread) */}
        <div className="flex">
          <button
            onClick={() => {
              isUnread ? onMarkRead(alert.key) : onMarkUnread(alert.key);
              setSwipeOffset(0);
            }}
            className="w-[80px] h-full bg-blue-500 text-white flex flex-col items-center justify-center active:bg-blue-600 transition-colors"
          >
            <Icon name={isUnread ? "check" : "mark_email_unread"} className="text-[20px] mb-1" />
            <span className="text-[10px] font-bold uppercase tracking-wider">{isUnread ? "Read" : "Unread"}</span>
          </button>
        </div>
        {/* Right Side: Left Swipe Actions (Resolve/Dismiss) */}
        <div className="flex">
          <button
            onClick={() => { onResolve(alert.key); setSwipeOffset(0); }}
            className="w-[80px] h-full bg-emerald-500 text-white flex flex-col items-center justify-center active:bg-emerald-600 transition-colors"
          >
            <Icon name="check_circle" className="text-[20px] mb-1" />
            <span className="text-[10px] font-bold uppercase tracking-wider">Resolve</span>
          </button>
          <button
            onClick={() => { onDismiss(alert.key); setSwipeOffset(0); }}
            className="w-[80px] h-full bg-rose-500 text-white flex flex-col items-center justify-center active:bg-rose-600 transition-colors"
          >
            <Icon name="delete" className="text-[20px] mb-1" />
            <span className="text-[10px] font-bold uppercase tracking-wider">Dismiss</span>
          </button>
        </div>
      </div>

      {/* Swipeable Content Area */}
      <div
        {...swipeGesture}
        className={cn(
          "relative z-10 flex w-full flex-col items-start gap-3 px-4 py-4 md:grid md:grid-cols-12 md:gap-4 md:px-6 md:py-5",
          isUnread ? tone.pageUnread : "bg-white hover:bg-[#ECEFF3]",
          isSwiping ? "transition-none" : "transition-transform duration-300"
        )}
        style={{ ...swipeGesture.style, transform: `translateX(${swipeOffset}px)` }}
        onClick={() => {
          if (swipeOffset !== 0) setSwipeOffset(0);
        }}
      >
        {/* TYPE Column */}
        <div className="md:col-span-2 flex items-center justify-between w-full md:w-auto">
          <div className="flex items-center gap-3">
            <div className={cn("w-2 h-2 rounded-full flex-shrink-0", isUnread ? cn(tone.unreadDot, "animate-pulse") : "bg-transparent")} />
            <div className={cn("flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-extrabold uppercase tracking-wider", tone.icon)}>
              <Icon name={alertIcon(alert)} className="text-[14px]" />
              {alert.type}
            </div>
          </div>
          <div className="md:hidden text-xs font-semibold text-slate-400">
            {alert.timeLabel}
          </div>
        </div>

        {/* SEV. ALERT Column */}
        <div className="md:col-span-6 space-y-1 w-full">
          <div className="flex items-start gap-2">
            {alert.level === "CRITICAL" && (
              <Icon name="error" className="text-[16px] text-rose-500 flex-shrink-0 mt-0.5" />
            )}
            <h3 className="font-bold text-slate-900 text-sm md:text-base leading-tight">
              {alert.title}
              {alert.resolved && (
                <span className="inline-block ml-2 px-1.5 py-0.5 bg-emerald-100 text-emerald-700 text-[10px] uppercase font-bold rounded">
                  Resolved
                </span>
              )}
            </h3>
          </div>
          <p className="text-sm text-slate-500 leading-relaxed">{alert.message}</p>
        </div>

        {/* TIME Column */}
        <div className="hidden md:block md:col-span-2 text-xs font-semibold text-slate-400 md:pt-1">
          {alert.timeLabel}
        </div>

        {/* ACTIONS Column (Desktop) */}
        <div className="hidden md:flex md:col-span-2 items-center justify-end gap-2 w-full pt-3 mt-1 md:pt-0 md:mt-0 transition-opacity opacity-70 group-hover:opacity-100 focus-within:opacity-100">
          {isUnread ? (
            <button
              onClick={() => onMarkRead(alert.key)}
              title="Mark as read"
              className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-all flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider"
            >
              <Icon name="check" className="text-[14px]" /> Read
            </button>
          ) : (
            <button
              onClick={() => onMarkUnread(alert.key)}
              title="Mark as unread"
              className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-all flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider"
            >
              <Icon name="mark_email_unread" className="text-[14px]" /> Unread
            </button>
          )}
          
          <button
            onClick={() => onResolve(alert.key)}
            title="Resolve = issue handled"
            className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded transition-all flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider"
          >
            <Icon name="check_circle" className="text-[14px]" /> Resolve
          </button>
          <button
            onClick={() => onDismiss(alert.key)}
            title="Dismiss = hide from my view"
            className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition-all flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider"
          >
            <Icon name="close" className="text-[14px]" /> Dismiss
          </button>
        </div>

      </div>
    </div>
  );
}

// the standalone alerts page — shows a list of system alerts (low stock, invoice updates)
// connects directly to the global AlertsProvider via useAlerts hook
export default function AlertsPage() {
  const capabilities = useBusinessCapabilities();
  const {
    alerts,
    loading,
    error,
    unreadCount,
    refreshAlerts,
    markAlertRead,
    markAlertUnread,
    markAllAlertsRead,
    resolveAlert,
    dismissAlert,
  } = useAlerts();
  
  const [filterType, setFilterType] = useState<"all" | AppAlertType>("all");
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const alertsListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    refreshAlerts(500);
  }, []);

  // resetting the page back to 1 whenever a filter changes
  useEffect(() => {
    setPage(1);
  }, [filterType, showUnreadOnly, searchQuery]);

  // compute global stats for the top banner
  const globalStats = useMemo(() => {
    return {
      total: alerts.length,
      unread: alerts.filter((a) => !a.read).length,
      critical: alerts.filter((a) => a.level === "CRITICAL").length,
      resolved: alerts.filter((a) => a.resolved).length,
    };
  }, [alerts]);

  // computing the filtered list of alerts based on current selections
  const filteredAlerts = useMemo(() => {
    return alerts.filter((alert) => {
      const matchesType = filterType === "all" ? true : alert.type === filterType;
      const matchesUnread = showUnreadOnly ? !alert.read : true;
      const matchesSearch = searchQuery === "" || 
        alert.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        alert.message.toLowerCase().includes(searchQuery.toLowerCase()) ||
        alert.type.toLowerCase().includes(searchQuery.toLowerCase()) ||
        alert.level.toLowerCase().includes(searchQuery.toLowerCase());
        
      return matchesType && matchesUnread && matchesSearch;
    });
  }, [alerts, filterType, showUnreadOnly, searchQuery]);

  // calculating counts for the filter pills
  const typeFilters: AppAlertType[] = capabilities.posEnabled
    ? ["Invoice", "Stock", "Product", "Payment", "Return", "System"]
    : capabilities.inventoryEnabled
      ? ["Stock", "Product", "System"]
      : ["Product", "System"];

  useEffect(() => {
    if (filterType !== "all" && !typeFilters.includes(filterType)) {
      setFilterType("all");
    }
  }, [capabilities.businessMode, filterType]);
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

  async function handleMarkRead(alertKey: string) {
    try {
      await markAlertRead(alertKey);
    } catch {
      await refreshAlerts(500);
    }
  }

  async function handleMarkUnread(alertKey: string) {
    try {
      await markAlertUnread(alertKey);
    } catch {
      await refreshAlerts(500);
    }
  }

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

  if (loading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <div className="font-semibold text-slate-400 flex items-center gap-2">
          <Icon name="progress_activity" className="animate-spin text-[24px]" />
          Loading alerts...
        </div>
      </div>
    );
  }

  function changeAlertPage(nextPage: number) {
    setPage(nextPage);
    window.requestAnimationFrame(() => {
      alertsListRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  return (
    <div className="-mx-2 min-h-full bg-white px-1 pb-6 pt-3 text-slate-900 md:mx-0 md:rounded-[28px] md:p-6">
      <div className="w-full">
        
        {/* Header Section */}
        <div className="mb-3 flex flex-col justify-between gap-2.5 md:mb-6 md:flex-row md:items-center md:gap-4">
          <div className="hidden md:block">
            <h1 className="text-2xl font-black tracking-tight text-[#11120d]">Alerts</h1>
            <p className="text-[13px] font-medium text-[#64748B] mt-0.5">
              {capabilities.businessMode === "CATALOG_ONLY"
                ? "Stay updated on catalog, price, product, and essential system changes."
                : capabilities.posEnabled
                  ? "Stay updated on sales, stock, price, payment, and system changes."
                  : "Stay updated on inventory, stock, price, product, and system changes."}
            </p>
          </div>
          <div className="flex w-full items-center gap-2 md:w-auto md:gap-2.5">
            <button 
              onClick={() => refreshAlerts(500)}
              className="inline-flex h-9.5 flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-[#D4D7DC] bg-white px-3 text-[12px] font-extrabold text-[#374151] shadow-2xs transition active:scale-98 hover:bg-[#F3F4F6] md:flex-none md:px-3.5"
            >
              <Icon name="refresh" sizePx={15} />
              <span>Refresh</span>
            </button>
            <button 
              onClick={handleMarkAllRead}
              disabled={unreadCount === 0}
              className="inline-flex h-9.5 flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-[#D4D7DC] bg-white px-3 text-[12px] font-extrabold text-[#374151] shadow-2xs transition active:scale-98 hover:bg-[#F3F4F6] disabled:pointer-events-none disabled:opacity-40 md:flex-none md:px-3.5"
            >
              <Icon name="done_all" sizePx={15} />
              <span>Mark all read</span>
            </button>
          </div>
        </div>

        {error ? (
          <div className="mb-3 flex flex-col gap-2.5 rounded-[14px] border border-amber-300 bg-amber-50 p-3.5 text-amber-950 md:mb-5 md:flex-row md:items-center md:justify-between">
            <div className="flex items-start gap-2.5">
              <Icon name="wifi_off" sizePx={18} className="mt-0.5 text-amber-700" />
              <div>
                <p className="text-[13px] font-extrabold">Unable to refresh alerts</p>
                <p className="mt-0.5 text-[12px] font-medium text-amber-800">{error}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => refreshAlerts(500)}
              className="h-9 rounded-[9px] bg-[#11120d] px-3.5 text-[12px] font-extrabold text-white active:scale-95"
            >
              Try again
            </button>
          </div>
        ) : null}

        {/* Global Stats Banner */}
        <div className="mb-3 grid grid-cols-4 divide-x divide-[#E2E4E8] rounded-[14px] border border-[#D8DBE0] bg-[#F8FAFC] py-2.5 shadow-2xs md:mb-5 md:grid-cols-4 md:divide-x-0 md:gap-3 md:border-0 md:bg-transparent md:p-0 md:shadow-none">
          <div className="px-1 text-center md:rounded-[14px] md:border md:border-[#D8DBE0] md:bg-white md:p-3.5 md:text-left md:shadow-2xs">
            <div className="text-[9.5px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">Total</div>
            <div className="mt-0.5 font-mono text-[17px] font-black text-[#11120d] md:mt-1 md:text-[22px]">
              {globalStats.total}
            </div>
          </div>
          <div className="px-1 text-center md:rounded-[14px] md:border md:border-[#D8DBE0] md:bg-white md:p-3.5 md:text-left md:shadow-2xs">
            <div className="text-[9.5px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">Unread</div>
            <div className={cn("mt-0.5 font-mono text-[17px] font-black md:mt-1 md:text-[22px]", globalStats.unread > 0 ? "text-blue-600" : "text-[#11120d]")}>
              {globalStats.unread}
            </div>
          </div>
          <div className="px-1 text-center md:rounded-[14px] md:border md:border-[#D8DBE0] md:bg-white md:p-3.5 md:text-left md:shadow-2xs">
            <div className="text-[9.5px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">Critical</div>
            <div className={cn("mt-0.5 font-mono text-[17px] font-black md:mt-1 md:text-[22px]", globalStats.critical > 0 ? "text-rose-600" : "text-[#11120d]")}>
              {globalStats.critical}
            </div>
          </div>
          <div className="px-1 text-center md:rounded-[14px] md:border md:border-[#D8DBE0] md:bg-white md:p-3.5 md:text-left md:shadow-2xs">
            <div className="text-[9.5px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">Resolved</div>
            <div className={cn("mt-0.5 font-mono text-[17px] font-black md:mt-1 md:text-[22px]", globalStats.resolved > 0 ? "text-emerald-600" : "text-[#11120d]")}>
              {globalStats.resolved}
            </div>
          </div>
        </div>

        {/* Filters and Search Bar */}
        <div className="mb-3 flex flex-col gap-2.5 md:mb-5 xl:flex-row xl:items-center xl:justify-between">
          <MobileFilterTabs
            className="lg:hidden"
            ariaLabel="Alert type"
            value={filterType}
            onChange={setFilterType}
            items={[{ value: "all" as const, label: "All", count: alerts.length }, ...typeFilters.map((type) => ({ value: type, label: type, count: typeCounts[type] }))]}
          />
          <div className="hidden items-center gap-1.5 lg:flex">
            <button 
              onClick={() => setFilterType("all")}
              className={cn(
                "h-8.5 rounded-full px-3.5 text-[12px] font-extrabold shadow-2xs transition",
                filterType === "all" ? "bg-[#11120d] text-white" : "border border-[#D4D7DC] bg-white text-[#565449] hover:bg-[#F3F4F6]"
              )}
            >
              All <span className={cn("ml-1 rounded-full px-1.5 py-0.2 text-[10.5px]", filterType === "all" ? "bg-white/20 text-white" : "bg-[#F1F3F5] text-[#64748B]")}>{alerts.length}</span>
            </button>
            {typeFilters.map((type) => (
              <button 
                key={type}
                onClick={() => setFilterType(type)}
                className={cn(
                  "h-8.5 rounded-full px-3.5 text-[12px] font-extrabold shadow-2xs transition",
                  filterType === type ? "bg-[#11120d] text-white" : "border border-[#D4D7DC] bg-white text-[#565449] hover:bg-[#F3F4F6]"
                )}
              >
                {type} <span className={cn("ml-1 rounded-full px-1.5 py-0.2 text-[10.5px]", filterType === type ? "bg-white/20 text-white" : "bg-[#F1F3F5] text-[#64748B]")}>{typeCounts[type]}</span>
              </button>
            ))}
          </div>
          
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1 sm:w-[260px] sm:flex-none">
              <Icon name="search" sizePx={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#7A7F89]" />
              <input 
                type="text" 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search alerts..." 
                className="h-9.5 w-full rounded-[10px] border border-[#D4D7DC] bg-white pl-9 pr-3 text-[12.5px] font-semibold text-[#11120d] outline-none transition placeholder:text-[#7A7F89] focus:border-[#11120d]"
              />
            </div>
            <label className="flex h-9.5 shrink-0 cursor-pointer select-none items-center gap-2 rounded-[10px] border border-[#D4D7DC] bg-white px-3 shadow-2xs transition hover:bg-[#F8FAFC]">
              <span className="text-[11.5px] font-bold text-[#4B5563]">Unread only</span>
              <div className="relative">
                <input 
                  type="checkbox" 
                  className="hidden"
                  checked={showUnreadOnly}
                  onChange={() => setShowUnreadOnly(!showUnreadOnly)}
                />
                <div className={cn("flex h-5 w-9 items-center rounded-full p-0.5 transition", showUnreadOnly ? "bg-[#11120d]" : "bg-[#D4D7DC]")}>
                  <div className={cn("h-4 w-4 rounded-full bg-white shadow-xs transition", showUnreadOnly ? "translate-x-4" : "translate-x-0")} />
                </div>
              </div>
            </label>
          </div>
        </div>

        {/* Alerts List */}
        <div ref={alertsListRef} className="relative scroll-mt-4 bg-transparent md:overflow-hidden md:rounded-[20px] md:border md:border-[#CFCFD3] md:bg-white md:shadow-sm">
          
          {/* Desktop Table Header */}
          <div className="hidden md:grid grid-cols-12 gap-4 px-6 py-4 bg-slate-50 border-b border-[#CFCFD3] text-[11px] font-extrabold text-slate-500 uppercase tracking-widest">
            <div className="col-span-2">TYPE</div>
            <div className="col-span-6">SEV. ALERT</div>
            <div className="col-span-2">TIME</div>
            <div className="col-span-2 text-right">ACTIONS</div>
          </div>

          <div className="flex flex-col gap-3 md:gap-0">
            {filteredAlerts.length === 0 ? (
              <div className="flex min-h-[280px] flex-col items-center justify-center bg-white text-slate-400 p-6 text-center">
                <Icon name="notifications_off" className="text-[40px] mb-3 text-[#CFCFD3]" />
                <div className="text-[14px] font-extrabold text-slate-600">
                  {error ? "Alerts are temporarily unavailable." : "No alerts found."}
                </div>
                <p className="text-[13px] mt-1 text-slate-500">
                  {error ? "Use Try again after checking the connection." : "Try adjusting your filters or search query."}
                </p>
              </div>
            ) : (
              pageItems.map((alert) => (
                <AlertRow 
                  key={alert.key} 
                  alert={alert} 
                  onMarkRead={handleMarkRead}
                  onMarkUnread={handleMarkUnread}
                  onResolve={resolveAlert}
                  onDismiss={dismissAlert}
                />
              ))
            )}
          </div>
        </div>

        {/* Pagination */}
        {filteredAlerts.length > 0 ? (
          <div className="mt-6">
            <PaginationBar
              page={pageClamped}
              totalPages={totalPages}
              total={filteredAlerts.length}
              start={pageStart}
              end={pageEnd}
              label="alerts"
              pageSize={pageSize}
              pageSizeOptions={[10, 20, 50]}
              showSinglePageControls
              onPageChange={changeAlertPage}
              onPageSizeChange={(nextPageSize) => {
                setPageSize(nextPageSize);
                setPage(1);
                window.requestAnimationFrame(() => {
                  alertsListRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                });
              }}
              className="border-y border-[#CFCFD3] bg-white md:rounded-[18px] md:border"
            />
          </div>
        ) : null}

      </div>
    </div>
  );
}
