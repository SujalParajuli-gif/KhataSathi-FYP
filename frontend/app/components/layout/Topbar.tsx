import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import BrandLogo from "~/components/ui/BrandLogo";
import GIcon from "~/components/ui/GIcon";
import UserAvatar from "~/components/ui/UserAvatar";
import { API_BASE_URL } from "~/lib/api/baseUrl";
import { alertColor, alertIcon, alertTone } from "~/lib/alerts/alerts";
import { useAlerts } from "~/lib/alerts/alerts-context";

type Props = {
  pageTitle: string;
  greetingText?: string;
  onOpenMobileSidebar?: () => void;
  onToggleCollapse: () => void;
  onOpenSearch?: () => void;
  isMobileSidebarOpen?: boolean;
  isCollapsed: boolean;
  userName?: string;
  roleLabel?: string;
  profileImage?: string | null;
  profileHref?: string;
  showNotifications?: boolean;
  staffMode?: boolean;
  showDesktopCollapseToggle?: boolean;
  contextLabel?: string;
};

export default function Topbar({
  pageTitle,
  greetingText = "Welcome back",
  onOpenMobileSidebar,
  onToggleCollapse,
  onOpenSearch,
  isMobileSidebarOpen = false,
  isCollapsed,
  userName = "User",
  roleLabel = "Admin",
  profileImage,
  profileHref = "/profile",
  showNotifications = true,
  staffMode = false,
  showDesktopCollapseToggle = true,
  contextLabel,
}: Props) {
  const [bellOpen, setBellOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);
  const { alerts, loading, refreshAlerts, unreadCount } = useAlerts();

  // Close dropdowns on outside click or Escape
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (bellRef.current && !bellRef.current.contains(event.target as Node)) {
        setBellOpen(false);
      }
      if (accountRef.current && !accountRef.current.contains(event.target as Node)) {
        setAccountOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setBellOpen(false);
        setAccountOpen(false);
      }
    }

    if (bellOpen || accountOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [accountOpen, bellOpen]);

  function toggleBell() {
    if (!showNotifications) return;
    const nextOpen = !bellOpen;
    setBellOpen(nextOpen);
    if (nextOpen) {
      refreshAlerts(100);
    }
  }

  const previewAlerts = alerts.slice(0, 4);

  return (
    <header className="relative z-[60] h-[68px] shrink-0 border-b border-[#D8DDE5] bg-white/95 backdrop-blur-md">
      <div className="flex h-full items-center justify-between px-3 sm:px-6">
        {/* Left Section: Mobile Brand or Toggles + Page Identity */}
        <div className="flex min-w-0 items-center gap-2.5 sm:gap-4">
          {/* Desktop Collapse Toggle */}
          {showDesktopCollapseToggle ? (
            <button
              type="button"
              onClick={onToggleCollapse}
              className="hidden h-9 w-9 items-center justify-center rounded-[10px] border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 active:scale-95 lg:flex"
              aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!isCollapsed}
              aria-controls="app-sidebar"
            >
              <GIcon name={isCollapsed ? "menu" : "menu_open"} sizePx={20} />
            </button>
          ) : null}

          {/* Desktop Page Title */}
          <div className="hidden lg:flex min-w-0 items-center gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-[17px] font-bold text-slate-900 tracking-tight">
                  {pageTitle}
                </h1>
                {contextLabel ? (
                  <span className="inline-block shrink-0 rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[9.5px] font-bold text-slate-600">
                    {contextLabel}
                  </span>
                ) : null}
              </div>
              <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-slate-400">
                <span className="truncate">{greetingText}</span>
              </div>
            </div>
          </div>

          {/* Mobile Page Title with KhataSathi Brand Logo */}
          <div className="flex lg:hidden min-w-0 items-center gap-2.5">
            <Link
              to="/"
              className="shrink-0 flex items-center transition hover:opacity-85 active:scale-95"
              aria-label="KhataSathi Home"
            >
              <BrandLogo
                variant="icon"
                className="h-8 w-8 rounded-[9px] border border-slate-200/90 bg-white shadow-2xs p-0.5"
              />
            </Link>
            <div className="h-6 w-[1px] bg-slate-200 shrink-0" />
            <div className="min-w-0 flex flex-col justify-center">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  KhataSathi
                </span>
                {contextLabel ? (
                  <span className="shrink-0 rounded-full border border-slate-200 bg-slate-100 px-1.5 py-0.2 text-[8.5px] font-bold text-slate-600">
                    {contextLabel}
                  </span>
                ) : null}
              </div>
              <h1 className="truncate text-[15px] sm:text-[16px] font-bold text-slate-900 tracking-tight leading-tight">
                {pageTitle}
              </h1>
            </div>
          </div>
        </div>

        {/* Right Section: Global Actions (Search, Notifications, Profile) */}
        <div className="flex shrink-0 items-center gap-2 sm:gap-2.5">
          {/* Quick Page Search Button */}
          {onOpenSearch ? (
            <button
              type="button"
              onClick={onOpenSearch}
              className="flex h-9 items-center gap-2 rounded-[10px] border border-slate-200 bg-white px-2.5 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 active:scale-95"
              aria-label="Search navigation pages"
              title="Search pages (Ctrl K)"
            >
              <GIcon name="search" sizePx={18} className="text-slate-500" />
              <span className="hidden md:inline text-[12px] font-semibold text-slate-500">
                Search
              </span>
              <kbd className="hidden md:inline rounded bg-slate-100 px-1 py-0.5 text-[9.5px] font-bold text-slate-400">
                ⌘K
              </kbd>
            </button>
          ) : null}

          {/* Notification Bell with Dropdown */}
          {showNotifications ? (
            <div className="relative" ref={bellRef}>
              <button
                type="button"
                onClick={toggleBell}
                className="relative flex h-9 w-9 items-center justify-center rounded-[10px] border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 active:scale-95"
                aria-label="Notifications"
                aria-expanded={bellOpen}
              >
                <GIcon name="notifications" sizePx={19} />
                {unreadCount > 0 ? (
                  <span className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#2563EB] px-1 text-[10px] font-bold text-white shadow-xs">
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </span>
                ) : null}
              </button>

              {/* Notification Dropdown Panel */}
              {bellOpen ? (
                <div className="fixed left-3 right-3 top-[58px] z-50 overflow-hidden rounded-[16px] border border-[#D8DDE5] bg-white shadow-2xl sm:absolute sm:left-auto sm:right-0 sm:top-[44px] sm:w-[360px] sm:max-w-[calc(100vw-24px)] animate-in fade-in-0 zoom-in-95 duration-150">
                  <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 bg-slate-50/70">
                    <span className="text-[13px] font-bold text-slate-900">
                      Notifications
                    </span>
                    {unreadCount > 0 ? (
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10.5px] font-bold text-blue-700">
                        {unreadCount} unread
                      </span>
                    ) : null}
                  </div>

                  <div className="max-h-[min(380px,calc(100dvh-140px))] overflow-y-auto [scrollbar-width:thin]">
                    {loading && previewAlerts.length === 0 ? (
                      <div className="p-6 text-center text-[12.5px] text-slate-400">
                        Loading...
                      </div>
                    ) : null}

                    {!loading && previewAlerts.length === 0 ? (
                      <div className="p-6 text-center text-[12.5px] text-slate-400">
                        No notifications
                      </div>
                    ) : null}

                    {previewAlerts.map((alert) => {
                      const tone = alertTone(alert);

                      return (
                        <Link
                          key={alert.key}
                          to="/alerts"
                          onClick={() => setBellOpen(false)}
                          className={`flex items-start gap-3 border-b border-slate-100 px-4 py-3 last:border-0 transition-colors ${tone.previewHover} ${
                            alert.read ? "bg-white" : tone.previewUnread
                          }`}
                        >
                          <div
                            className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] ${alertColor(
                              alert,
                            )}`}
                          >
                            <GIcon name={alertIcon(alert)} sizePx={17} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-2">
                              <div className="truncate text-[12.5px] font-semibold text-slate-900">
                                {alert.title}
                              </div>
                              <div
                                className={`shrink-0 text-[10px] font-medium ${
                                  alert.read ? "text-slate-400" : tone.time
                                }`}
                              >
                                {alert.timeLabel}
                              </div>
                            </div>
                            <div className="mt-1 break-words text-[11px] leading-snug text-slate-500">
                              {alert.message}
                            </div>
                          </div>
                          {!alert.read ? (
                            <span
                              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tone.unreadDot}`}
                            />
                          ) : null}
                        </Link>
                      );
                    })}
                  </div>

                  <Link
                    to="/alerts"
                    onClick={() => setBellOpen(false)}
                    className="block border-t border-slate-100 bg-slate-50/50 px-4 py-2.5 text-center text-[11.5px] font-bold text-blue-600 transition-colors hover:bg-slate-100"
                  >
                    View all notifications
                  </Link>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* User Profile Card Link */}
          <Link
            to={profileHref}
            className="flex items-center gap-2.5 rounded-[10px] border border-slate-200 bg-white p-1 sm:px-2.5 sm:py-1 transition hover:bg-slate-100 active:scale-95"
            aria-label="Open user profile"
          >
            <UserAvatar
              src={profileImage ? `${API_BASE_URL}${profileImage}` : undefined}
              alt="Profile"
              className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-slate-100 text-[11px] font-bold text-slate-700"
              fallback={<GIcon name="person" sizePx={16} className="text-slate-500" />}
            />
            <div className="hidden sm:block text-left leading-tight">
              <div className="truncate text-[12px] font-bold text-slate-900 max-w-[120px]">
                {userName}
              </div>
              <div className="truncate text-[9.5px] font-semibold uppercase tracking-wider text-slate-400">
                {roleLabel}
              </div>
            </div>
          </Link>
        </div>
      </div>
    </header>
  );
}
