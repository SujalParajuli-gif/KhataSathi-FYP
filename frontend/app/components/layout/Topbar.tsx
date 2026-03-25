import { useState, useRef, useEffect } from "react";
import { Link } from "react-router";
import GIcon from "~/components/ui/GIcon";
import navData from "~/config/ui.nav.json";
import { getLowStockApi, getReadAlertsApi } from "~/lib/api/endpoints";

type Props = {
  pageTitle: string;
  greetingText?: string;
  onOpenMobileSidebar: () => void;
  onToggleCollapse: () => void;
  isCollapsed: boolean;
  userName?: string;
  roleLabel?: string;
  profileImage?: string | null;
};

type AlertItem = {
  key: string;
  title: string;
  subtitle: string;
  icon: string;
  color: string;
  isRead: boolean;
};

export default function Topbar({
  pageTitle,
  greetingText = "Welcome back",
  onOpenMobileSidebar,
  onToggleCollapse,
  isCollapsed,
  userName = "User",
  roleLabel = "Admin",
  profileImage,
}: Props) {
  const API_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";
  const [bellOpen, setBellOpen] = useState(false);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [loadingAlerts, setLoadingAlerts] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) {
        setBellOpen(false);
      }
    }
    if (bellOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [bellOpen]);

  async function loadAlerts() {
    if (loadingAlerts) return;
    setLoadingAlerts(true);
    try {
      const [lowStockData, readData] = await Promise.all([
        getLowStockApi().catch(() => []),
        getReadAlertsApi().catch(() => ({ readKeys: [] })),
      ]);
      const readKeys: string[] = readData.readKeys || [];
      const items: AlertItem[] = [];

      const lowStockProducts = Array.isArray(lowStockData) ? lowStockData : lowStockData?.products || [];
      for (const p of lowStockProducts.slice(0, 4)) {
        const key = `low-stock-${p.id}`;
        items.push({
          key,
          title: p.name || "Product",
          subtitle: `Stock: ${p.stock ?? 0} (low)`,
          icon: "inventory_2",
          color: "text-amber-600 bg-amber-50",
          isRead: readKeys.includes(key),
        });
      }

      setAlerts(items.slice(0, 4));
    } catch {
      setAlerts([]);
    } finally {
      setLoadingAlerts(false);
    }
  }

  function toggleBell() {
    const next = !bellOpen;
    setBellOpen(next);
    if (next) loadAlerts();
  }

  const unreadCount = alerts.filter((a) => !a.isRead).length;

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200/60 bg-white/80 backdrop-blur-md">
      <div className="px-5 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex items-center gap-4">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onOpenMobileSidebar}
                className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm transition-all hover:bg-slate-50 active:scale-95 lg:hidden"
                aria-label="Open sidebar"
              >
                <GIcon name="menu" />
              </button>

              <button
                type="button"
                onClick={onToggleCollapse}
                className="hidden h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm transition-all hover:bg-slate-50 active:scale-95 lg:flex"
                aria-label="Toggle sidebar collapse"
              >
                <GIcon name={isCollapsed ? "menu" : "menu_open"} />
              </button>

              <div className="min-w-0">
                <h1 className="truncate text-[16px] font-bold tracking-tight text-slate-900">
                  {pageTitle}
                </h1>
                <p className="truncate text-[12px] font-medium text-slate-500 opacity-80">
                  {greetingText}
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="group hidden w-[400px] items-center gap-3 rounded-full border border-slate-200 bg-slate-50/50 px-4 py-2 transition-all focus-within:border-orange-500/50 focus-within:bg-white focus-within:ring-4 focus-within:ring-orange-500/10 md:flex xl:w-[500px]">
              <GIcon
                name="search"
                className="text-slate-400 transition-colors group-focus-within:text-orange-500"
              />
              <input
                className="w-full bg-transparent text-sm font-medium text-slate-700 outline-none placeholder:text-slate-400"
                placeholder={navData.topbar.searchPlaceholder}
              />
            </div>

            <div className="relative" ref={bellRef}>
              <button
                type="button"
                onClick={toggleBell}
                className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm transition-all hover:bg-slate-50 active:scale-95"
                aria-label="Notifications"
              >
                <GIcon name="notifications" />
                {unreadCount > 0 && (
                  <span className="absolute right-[10px] top-[10px] h-2.5 w-2.5 rounded-full border-2 border-white bg-rose-500 shadow-sm" />
                )}
              </button>

              {bellOpen && (
                <div className="absolute right-0 top-12 w-[360px] rounded-2xl border border-slate-200 bg-white shadow-2xl overflow-hidden z-50">
                  <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                    <span className="text-[13px] font-bold text-slate-900">Notifications</span>
                    {unreadCount > 0 && (
                      <span className="text-[11px] font-bold text-orange-600 bg-orange-50 px-2 py-0.5 rounded-full">
                        {unreadCount} new
                      </span>
                    )}
                  </div>
                  <div className="max-h-[280px] overflow-y-auto">
                    {loadingAlerts && alerts.length === 0 && (
                      <div className="p-6 text-center text-[13px] text-slate-400">Loading...</div>
                    )}
                    {!loadingAlerts && alerts.length === 0 && (
                      <div className="p-6 text-center text-[13px] text-slate-400">No notifications</div>
                    )}
                    {alerts.map((a) => (
                      <div
                        key={a.key}
                        className={`px-4 py-3 flex items-start gap-3 border-b border-slate-50 last:border-0 transition-colors ${a.isRead ? "opacity-60" : "bg-orange-50/30"}`}
                      >
                        <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${a.color}`}>
                          <GIcon name={a.icon} className="text-[16px]" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-[13px] font-semibold text-slate-800 truncate">{a.title}</div>
                          <div className="text-[11px] text-slate-500 mt-0.5">{a.subtitle}</div>
                        </div>
                        {!a.isRead && (
                          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-orange-500" />
                        )}
                      </div>
                    ))}
                  </div>
                  <Link
                    to="/alerts"
                    onClick={() => setBellOpen(false)}
                    className="block px-4 py-3 text-center text-[12px] font-bold text-orange-600 hover:bg-orange-50 border-t border-slate-100 transition-colors"
                  >
                    View all notifications
                  </Link>
                </div>
              )}
            </div>

            <button
              type="button"
              className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-1.5 pr-3 shadow-sm transition-all hover:border-slate-300 hover:bg-slate-50 active:scale-[0.98]"
              aria-label="User menu"
            >
              <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-lg border border-orange-200/50 bg-gradient-to-br from-orange-100 to-orange-200 shadow-inner">
                {profileImage ? (
                  <img src={`${API_URL}${profileImage}`} alt="Profile" className="h-full w-full object-cover" />
                ) : (
                  <GIcon name="person" className="text-orange-700" />
                )}
              </div>
              <div className="hidden text-left leading-tight sm:block">
                <div className="whitespace-nowrap text-[13px] font-bold text-slate-900">
                  {userName}
                </div>
                <div className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400">
                  {roleLabel}
                </div>
              </div>
            </button>
          </div>
        </div>

        <div className="mt-3 md:hidden">
          <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50/50 px-4 py-2.5">
            <GIcon name="search" className="text-slate-400" />
            <input
              className="w-full bg-transparent text-sm font-medium text-slate-700 outline-none placeholder:text-slate-400"
              placeholder={navData.topbar.searchPlaceholder}
            />
          </div>
        </div>
      </div>
    </header>
  );
}
