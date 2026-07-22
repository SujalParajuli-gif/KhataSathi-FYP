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
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const touchStartRef = useRef<number | null>(null);

  // Constants for swipe
  const THRESHOLD_LEFT = -160;
  const THRESHOLD_RIGHT = 80;

  const handleTouchStart = (e: React.TouchEvent) => {
    if (window.innerWidth >= 768) return;
    touchStartRef.current = e.touches[0].clientX;
    setIsSwiping(true);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isSwiping || touchStartRef.current === null || window.innerWidth >= 768) return;
    const currentX = e.touches[0].clientX - touchStartRef.current;
    
    let offset = currentX;
    // Add resistance if pulling past threshold
    if (offset < 0) { // Left swipe
      if (offset < THRESHOLD_LEFT - 40) {
        offset = (THRESHOLD_LEFT - 40) + (offset - (THRESHOLD_LEFT - 40)) * 0.2;
      }
    } else { // Right swipe
      if (offset > THRESHOLD_RIGHT + 40) {
        offset = (THRESHOLD_RIGHT + 40) + (offset - (THRESHOLD_RIGHT + 40)) * 0.2;
      }
    }
    
    setSwipeOffset(offset);
  };

  const handleTouchEnd = () => {
    if (!isSwiping || window.innerWidth >= 768) return;
    setIsSwiping(false);
    touchStartRef.current = null;
    
    if (swipeOffset < -90) {
      setSwipeOffset(THRESHOLD_LEFT);
    } else if (swipeOffset > 45) {
      setSwipeOffset(THRESHOLD_RIGHT);
    } else {
      setSwipeOffset(0);
    }
  };

  const isUnread = !alert.read;
  
  return (
    <div className="relative group overflow-hidden md:overflow-visible border-b border-slate-100 last:border-b-0">
      {/* Background Action Buttons (Revealed on Swipe) */}
      <div className="absolute inset-0 flex justify-between z-0 md:hidden bg-slate-100">
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
        className={cn(
          "relative z-10 flex flex-col md:grid md:grid-cols-12 gap-4 md:gap-4 px-5 py-6 md:px-6 md:py-5 transition-transform items-start w-full",
          isUnread ? tone.pageUnread : "bg-white hover:bg-[#ECEFF3]",
          isSwiping ? "transition-none" : "transition-transform duration-300"
        )}
        style={{ transform: `translateX(${swipeOffset}px)` }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
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
  
  const [filterType, setFilterType] = useState<"all" | AppAlertType>("all");
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

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
  const typeFilters: AppAlertType[] = ["Invoice", "Stock", "Product", "Payment", "Return", "System"];
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

  return (
    <div className="min-h-full rounded-[28px] bg-white p-6 text-slate-900">
      <div className="w-full">
        
        {/* Header Section */}
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-6 md:mb-8 gap-4">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Alerts</h1>
            <p className="text-sm md:text-base text-slate-500 mt-1">Stay updated on stock changes, price updates, and your system alerts.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 md:gap-3">
            <button 
              onClick={() => refreshAlerts(500)}
              className="flex-1 md:flex-none inline-flex items-center justify-center px-4 py-2.5 md:py-2 bg-white border border-[#CFCFD3] rounded-lg text-sm font-extrabold text-[#565449] hover:bg-slate-50 transition-colors shadow-sm"
            >
              <Icon name="refresh" className="text-[16px] mr-2" />
              Refresh
            </button>
            <button 
              onClick={handleMarkAllRead}
              disabled={unreadCount === 0}
              className="flex-1 md:flex-none inline-flex items-center justify-center px-4 py-2.5 md:py-2 bg-white border border-[#CFCFD3] rounded-lg text-sm font-extrabold text-[#565449] hover:bg-slate-50 transition-colors shadow-sm disabled:opacity-50 disabled:pointer-events-none"
            >
              <Icon name="done_all" className="text-[16px] mr-2" />
              Mark all read
            </button>
          </div>
        </div>

        {/* Global Stats Banner */}
        <div className="bg-white rounded-[18px] border border-[#CFCFD3] p-5 md:p-6 mb-6 md:mb-8 shadow-sm">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-5 md:gap-6">
            <div className="flex flex-col">
              <span className="text-xl md:text-2xl font-extrabold">
                {globalStats.total} <span className="text-xs md:text-sm font-semibold text-slate-400 ml-1 uppercase tracking-wider">Total</span>
              </span>
              <div className="h-1 w-12 bg-slate-200 mt-2 rounded-full"></div>
            </div>
            <div className="flex flex-col">
              <span className="text-xl md:text-2xl font-extrabold text-blue-600">
                {globalStats.unread} <span className="text-xs md:text-sm font-semibold text-slate-400 ml-1 uppercase tracking-wider">Unread</span>
              </span>
              <div className="h-1 w-12 bg-blue-500 mt-2 rounded-full"></div>
            </div>
            <div className="flex flex-col">
              <span className="text-xl md:text-2xl font-extrabold text-rose-600">
                {globalStats.critical} <span className="text-xs md:text-sm font-semibold text-slate-400 ml-1 uppercase tracking-wider">Critical</span>
              </span>
              <div className="h-1 w-12 bg-rose-500 mt-2 rounded-full"></div>
            </div>
            <div className="flex flex-col">
              <span className="text-xl md:text-2xl font-extrabold text-emerald-600">
                {globalStats.resolved} <span className="text-xs md:text-sm font-semibold text-slate-400 ml-1 uppercase tracking-wider">Resolved</span>
              </span>
              <div className="h-1 w-12 bg-emerald-500 mt-2 rounded-full"></div>
            </div>
          </div>
        </div>

        {/* Filters and Search */}
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-5 md:gap-6 mb-6">
          <MobileFilterTabs
            className="lg:hidden"
            ariaLabel="Alert type"
            value={filterType}
            onChange={setFilterType}
            items={[{ value: "all" as const, label: "All", count: alerts.length }, ...typeFilters.map((type) => ({ value: type, label: type, count: typeCounts[type] }))]}
          />
          <div className="hidden overflow-x-auto pb-1 -mx-4 px-4 sm:mx-0 sm:px-0 sm:pb-0 sm:flex-wrap gap-2 hide-scrollbar w-full xl:w-auto lg:flex">
            <button 
              onClick={() => setFilterType("all")}
              className={cn(
                "flex-shrink-0 px-4 py-1.5 rounded-full text-[13px] font-extrabold shadow-sm transition-colors",
                filterType === "all" ? "bg-[#11120d] text-white" : "bg-white border border-[#CFCFD3] text-[#565449] hover:bg-[#F3F4F6]"
              )}
            >
              All <span className={cn("ml-1 rounded-full px-2 py-0.5 text-[11px]", filterType === "all" ? "bg-white/15 text-white" : "bg-slate-100 text-slate-600")}>{alerts.length}</span>
            </button>
            {typeFilters.map((type) => (
              <button 
                key={type}
                onClick={() => setFilterType(type)}
                className={cn(
                  "flex-shrink-0 px-4 py-1.5 rounded-full text-[13px] font-extrabold shadow-sm transition-colors",
                  filterType === type ? "bg-[#11120d] text-white" : "bg-white border border-[#CFCFD3] text-[#565449] hover:bg-[#F3F4F6]"
                )}
              >
                {type} <span className={cn("ml-1 rounded-full px-2 py-0.5 text-[11px]", filterType === type ? "bg-white/15 text-white" : "bg-slate-100 text-slate-600")}>{typeCounts[type]}</span>
              </button>
            ))}
          </div>
          
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4 w-full xl:w-auto">
            <div className="relative flex-1 sm:min-w-[240px]">
              <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 text-[16px] text-slate-400" />
              <input 
                type="text" 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search alerts..." 
                className="w-full pl-9 pr-4 py-2 bg-white border border-[#CFCFD3] rounded-[14px] text-[13px] font-medium focus:outline-none focus:border-[#11120d] transition-all"
              />
            </div>
            <label className="flex items-center justify-between sm:justify-start gap-3 cursor-pointer group bg-white sm:bg-transparent border border-[#CFCFD3] sm:border-0 rounded-[14px] px-4 py-2 sm:p-0">
              <span className="text-[13px] font-extrabold text-[#565449] group-hover:text-[#11120d] transition-colors">Unread only</span>
              <div className="relative">
                <input 
                  type="checkbox" 
                  className="hidden"
                  checked={showUnreadOnly}
                  onChange={() => setShowUnreadOnly(!showUnreadOnly)}
                />
                <div className={cn("flex h-6 w-11 items-center rounded-full border p-1 transition", showUnreadOnly ? "border-[#11120d] bg-[#11120d]" : "border-[#CFCFD3] bg-[#F3F4F6]")}>
                  <div className={cn("h-4 w-4 rounded-full bg-white transition", showUnreadOnly ? "translate-x-5" : "translate-x-0")} />
                </div>
              </div>
            </label>
          </div>
        </div>

        {/* Alerts List */}
        <div className="bg-white rounded-[20px] border border-[#CFCFD3] shadow-sm overflow-hidden relative">
          
          {/* Desktop Table Header */}
          <div className="hidden md:grid grid-cols-12 gap-4 px-6 py-4 bg-slate-50 border-b border-[#CFCFD3] text-[11px] font-extrabold text-slate-500 uppercase tracking-widest">
            <div className="col-span-2">TYPE</div>
            <div className="col-span-6">SEV. ALERT</div>
            <div className="col-span-2">TIME</div>
            <div className="col-span-2 text-right">ACTIONS</div>
          </div>

          <div className="flex flex-col">
            {filteredAlerts.length === 0 ? (
              <div className="flex min-h-[280px] flex-col items-center justify-center bg-white text-slate-400 p-6 text-center">
                <Icon name="notifications_off" className="text-[40px] mb-3 text-[#CFCFD3]" />
                <div className="text-[14px] font-extrabold text-slate-600">No alerts found.</div>
                <p className="text-[13px] mt-1 text-slate-500">Try adjusting your filters or search query.</p>
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
              onPageChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPageSize(nextPageSize);
                setPage(1);
              }}
              className="rounded-[18px] border border-[#CFCFD3] bg-white"
            />
          </div>
        ) : null}

      </div>
    </div>
  );
}
