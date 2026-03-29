import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import GIcon from "~/components/ui/GIcon";
import navData from "~/config/ui.nav.json";
import { alertColor, alertIcon } from "~/lib/alerts/alerts";
import { useAlerts } from "~/lib/alerts/alerts-context";

type Props = {
  pageTitle: string;
  greetingText?: string;
  onOpenMobileSidebar: () => void;
  onToggleCollapse: () => void;
  isCollapsed: boolean;
  userName?: string;
  roleLabel?: string;
  profileImage?: string | null;
  profileHref?: string;
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
  profileHref = "/profile",
}: Props) {
  const API_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";
  const [bellOpen, setBellOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);
  const { alerts, loading, refreshAlerts, unreadCount } = useAlerts();

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (bellRef.current && !bellRef.current.contains(event.target as Node)) {
        setBellOpen(false);
      }
    }

    if (bellOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [bellOpen]);

  function toggleBell() {
    const nextOpen = !bellOpen;
    setBellOpen(nextOpen);
    if (nextOpen) {
      refreshAlerts(100);
    }
  }

  const previewAlerts = alerts.slice(0, 4);

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--app-border)] bg-white/90 backdrop-blur-md">
      <div className="px-5 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex items-center gap-4">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onOpenMobileSidebar}
                className="flex h-10 w-10 items-center justify-center rounded-[14px] border border-[var(--app-border)] bg-white text-[var(--app-text-soft)] shadow-sm transition hover:bg-[var(--app-surface-muted)] hover:text-[var(--app-text)] active:scale-95 lg:hidden"
                aria-label="Open sidebar"
              >
                <GIcon name="menu" />
              </button>

              <button
                type="button"
                onClick={onToggleCollapse}
                className="hidden h-10 w-10 items-center justify-center rounded-[14px] border border-[var(--app-border)] bg-white text-[var(--app-text-soft)] shadow-sm transition hover:bg-[var(--app-surface-muted)] hover:text-[var(--app-text)] active:scale-95 lg:flex"
                aria-label="Toggle sidebar collapse"
              >
                <GIcon name={isCollapsed ? "menu" : "menu_open"} />
              </button>

              <div className="min-w-0">
                <h1 className="truncate text-[16px] font-bold tracking-tight text-[var(--app-text)]">
                  {pageTitle}
                </h1>
                <p className="truncate text-[12px] font-medium text-[var(--app-text-muted)] opacity-90">
                  {greetingText}
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="relative" ref={bellRef}>
              <button
                type="button"
                onClick={toggleBell}
                className="relative flex h-10 w-10 items-center justify-center rounded-[14px] border border-[var(--app-border)] bg-white text-[var(--app-text-soft)] shadow-sm transition hover:bg-[var(--app-surface-muted)] hover:text-[var(--app-text)] active:scale-95"
                aria-label="Notifications"
              >
                <GIcon name="notifications" />
                {unreadCount > 0 ? (
                  <span className="absolute -right-1 -top-1 min-w-[18px] rounded-full bg-[#11120d] px-1 text-center text-[10px] font-extrabold leading-[18px] text-white shadow-sm">
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </span>
                ) : null}
              </button>

              {bellOpen ? (
                <div className="absolute right-0 top-12 z-50 w-[360px] overflow-hidden rounded-[22px] border border-[var(--app-border)] bg-white shadow-[0_26px_70px_-38px_rgba(17,18,13,0.55)]">
                  <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3">
                    <span className="text-[13px] font-bold text-[var(--app-text)]">
                      Notifications
                    </span>
                    {unreadCount > 0 ? (
                      <span className="rounded-full border border-[var(--app-border)] bg-[var(--app-surface-muted)] px-2 py-0.5 text-[11px] font-bold text-[var(--app-text-soft)]">
                        {unreadCount} unread
                      </span>
                    ) : null}
                  </div>

                  <div className="max-h-[320px] overflow-y-auto">
                    {loading && previewAlerts.length === 0 ? (
                      <div className="p-6 text-center text-[13px] text-slate-400">
                        Loading...
                      </div>
                    ) : null}

                    {!loading && previewAlerts.length === 0 ? (
                      <div className="p-6 text-center text-[13px] text-slate-400">
                        No notifications
                      </div>
                    ) : null}

                    {previewAlerts.map((alert) => (
                      <Link
                        key={alert.key}
                        to="/alerts"
                        onClick={() => setBellOpen(false)}
                        className={`flex items-start gap-3 border-b border-[var(--app-border)]/40 px-4 py-3 last:border-0 hover:bg-[var(--app-surface-muted)] ${
                          alert.read ? "" : "bg-[var(--app-surface-muted)]"
                        }`}
                      >
                        <div
                          className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${alertColor(alert)}`}
                        >
                          <GIcon
                            name={alertIcon(alert)}
                            className="text-[18px]"
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-3">
                            <div className="truncate text-[13px] font-semibold text-[var(--app-text)]">
                              {alert.title}
                            </div>
                            <div className="shrink-0 text-[10px] font-medium text-[var(--app-text-muted)]">
                              {alert.timeLabel}
                            </div>
                          </div>
                          <div className="mt-1 text-[11px] leading-5 text-[var(--app-text-muted)]">
                            {alert.message}
                          </div>
                        </div>
                        {!alert.read ? (
                          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[#11120d]" />
                        ) : null}
                      </Link>
                    ))}
                  </div>

                  <Link
                    to="/alerts"
                    onClick={() => setBellOpen(false)}
                    className="block border-t border-[var(--app-border)] px-4 py-3 text-center text-[12px] font-bold text-[var(--app-text)] transition-colors hover:bg-[var(--app-surface-muted)]"
                  >
                    View all notifications
                  </Link>
                </div>
              ) : null}
            </div>

            <Link
              to={profileHref}
              className="flex items-center gap-3 rounded-[16px] border border-[var(--app-border)] bg-white p-1.5 pr-3 shadow-sm transition hover:border-[var(--app-border-strong)] hover:bg-[var(--app-surface-muted)] active:scale-[0.98]"
              aria-label="Open profile"
            >
              <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-[12px] border border-[var(--app-border)] bg-[var(--app-surface-muted)] shadow-inner">
                {profileImage ? (
                  <img
                    src={`${API_URL}${profileImage}`}
                    alt="Profile"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <GIcon
                    name="person"
                    className="text-[var(--app-text-soft)]"
                  />
                )}
              </div>
              <div className="hidden text-left leading-tight sm:block">
                <div className="whitespace-nowrap text-[13px] font-bold text-[var(--app-text)]">
                  {userName}
                </div>
                <div className="text-[10px] font-extrabold uppercase tracking-wider text-[var(--app-text-muted)]">
                  {roleLabel}
                </div>
              </div>
            </Link>
          </div>
        </div>

        <div className="mt-3 md:hidden">
          <div className="flex items-center gap-3 rounded-[16px] border border-[var(--app-border)] bg-[var(--app-surface-muted)]/90 px-4 py-2.5">
            <GIcon name="search" className="text-[var(--app-text-muted)]" />
            <input
              className="w-full bg-transparent text-sm font-medium text-[var(--app-text-soft)] outline-none placeholder:text-[var(--app-text-muted)]"
              placeholder={navData.topbar.searchPlaceholder}
            />
          </div>
        </div>
      </div>
    </header>
  );
}
