import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import GIcon from "~/components/ui/GIcon";
import UserAvatar from "~/components/ui/UserAvatar";
import navData from "~/config/ui.nav.json";
import { API_BASE_URL } from "~/lib/api/baseUrl";
import { alertColor, alertIcon, alertTone } from "~/lib/alerts/alerts";
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

// the top navigation bar — shows the page title, greeting, notification bell, and user profile link
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
  const [bellOpen, setBellOpen] = useState(false); // whether the notification dropdown is visible
  const bellRef = useRef<HTMLDivElement>(null);
  const { alerts, loading, refreshAlerts, unreadCount } = useAlerts();

  // closing the notification dropdown when the user clicks outside of it
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

  // toggling the bell dropdown — refreshing alerts when opening
  function toggleBell() {
    const nextOpen = !bellOpen;
    setBellOpen(nextOpen);
    if (nextOpen) {
      refreshAlerts(100); // fetching fresh alerts when the dropdown opens
    }
  }

  // only showing the 4 most recent alerts in the dropdown preview
  const previewAlerts = alerts.slice(0, 4);

  return (
    <header className="sticky top-0 z-30 border-b border-[#CFCFD3] bg-[rgba(255,255,255,0.9)] backdrop-blur-md">
      <div className="px-[20px] py-[12px]">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex items-center gap-4">
            <div className="flex items-center gap-3">
              {/* mobile hamburger menu button — only visible on small screens */}
              <button
                type="button"
                onClick={onOpenMobileSidebar}
                className="flex h-[40px] w-[40px] items-center justify-center rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] text-[#565449]  transition hover:bg-[#F3F4F6] hover:text-[#000000] active:scale-95 lg:hidden"
                aria-label="Open sidebar"
              >
                <GIcon name="menu" />
              </button>

              {/* desktop sidebar collapse toggle button */}
              <button
                type="button"
                onClick={onToggleCollapse}
                className="hidden h-[40px] w-[40px] items-center justify-center rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] text-[#565449]  transition hover:bg-[#F3F4F6] hover:text-[#000000] active:scale-95 lg:flex"
                aria-label="Toggle sidebar collapse"
              >
                <GIcon name={isCollapsed ? "menu" : "menu_open"} />
              </button>

              {/* page title and greeting text */}
              <div className="min-w-0">
                <h1 className="truncate text-[16px] font-bold  text-[#000000]">
                  {pageTitle}
                </h1>
                <p className="truncate text-[12px] font-medium text-[#8C8889] opacity-90">
                  {greetingText}
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* notification bell with dropdown */}
            <div className="relative" ref={bellRef}>
              <button
                type="button"
                onClick={toggleBell}
                className="relative flex h-[40px] w-[40px] items-center justify-center rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] text-[#565449]  transition hover:bg-[#F3F4F6] hover:text-[#000000] active:scale-95"
                aria-label="Notifications"
              >
                <GIcon name="notifications" />
                {/* showing unread count badge on the bell icon */}
                {unreadCount > 0 ? (
                  <span className="absolute -right-1 -top-1 min-w-[18px] rounded-full bg-[#2F67D8] px-1 text-center text-[10px] font-extrabold leading-[18px] text-white ">
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </span>
                ) : null}
              </button>

              {/* notification dropdown panel — shows a preview of recent alerts */}
              {bellOpen ? (
                <div className="absolute right-0 top-[48px] z-50 w-[360px] overflow-hidden rounded-[22px] border border-[#CFCFD3] bg-[#FFFFFF] ">
                  <div className="flex items-center justify-between border-b border-[#CFCFD3] px-[16px] py-[12px]">
                    <span className="text-[13px] font-bold text-[#000000]">
                      Notifications
                    </span>
                    {unreadCount > 0 ? (
                      <span className="rounded-full border border-[#C5D7FF] bg-[#EEF4FF] px-[8px] py-[2px] text-[11px] font-bold text-[#2F67D8]">
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

                    {/* rendering each alert preview row with the appropriate color theme */}
                    {previewAlerts.map((alert) => {
                      const tone = alertTone(alert);

                      return (
                        <Link
                          key={alert.key}
                          to="/alerts"
                          onClick={() => setBellOpen(false)}
                          className={`flex items-start gap-3 border-b border-[rgba(207,207,211,0.4)] px-[16px] py-[12px] last:border-0 ${tone.previewHover} ${
                            alert.read ? "bg-white" : tone.previewUnread
                          }`}
                        >
                          <div
                            className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${alertColor(
                              alert,
                            )}`}
                          >
                            <GIcon
                              name={alertIcon(alert)}
                              className="text-[18px]"
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-3">
                              <div className="truncate text-[13px] font-semibold text-[#000000]">
                                {alert.title}
                              </div>
                              <div
                                className={`shrink-0 text-[10px] font-medium ${
                                  alert.read ? "text-[#8C8889]" : tone.time
                                }`}
                              >
                                {alert.timeLabel}
                              </div>
                            </div>
                            <div className="mt-[4px] text-[11px] leading-[20px] text-[#8C8889]">
                              {alert.message}
                            </div>
                          </div>
                          {/* showing a small colored dot for unread alerts */}
                          {!alert.read ? (
                            <span
                              className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${tone.unreadDot}`}
                            />
                          ) : null}
                        </Link>
                      );
                    })}
                  </div>

                  {/* link to the full alerts page */}
                  <Link
                    to="/alerts"
                    onClick={() => setBellOpen(false)}
                    className="block border-t border-[#CFCFD3] px-[16px] py-[12px] text-center text-[12px] font-bold text-[#000000] transition-colors hover:bg-[#F3F4F6]"
                  >
                    View all notifications
                  </Link>
                </div>
              ) : null}
            </div>

            {/* user profile link — shows avatar, name, and role badge */}
            <Link
              to={profileHref}
              className="flex items-center gap-3 rounded-[16px] border border-[#CFCFD3] bg-[#FFFFFF] p-[6px] pr-[12px]  transition hover:border-[#8C8889] hover:bg-[#F3F4F6] active:scale-[0.98]"
              aria-label="Open profile"
            >
              <UserAvatar
                src={profileImage ? `${API_BASE_URL}${profileImage}` : undefined}
                alt="Profile"
                className="flex h-[32px] w-[32px] items-center justify-center overflow-hidden rounded-[12px] border border-[#CFCFD3] bg-[#F3F4F6]"
                fallback={<GIcon name="person" className="text-[#565449]" />}
              />
              <div className="hidden text-left leading-tight sm:block">
                <div className="whitespace-nowrap text-[13px] font-bold text-[#000000]">
                  {userName}
                </div>
                <div className="text-[10px] font-extrabold uppercase  text-[#8C8889]">
                  {roleLabel}
                </div>
              </div>
            </Link>
          </div>
        </div>

        {/* mobile search bar — only visible on small screens */}
        <div className="mt-3 md:hidden">
          <div className="flex items-center gap-3 rounded-[16px] border border-[#CFCFD3] bg-[rgba(243,244,246,0.9)] px-[16px] py-[10px]">
            <GIcon name="search" className="text-[#8C8889]" />
            <input
              className="w-full bg-transparent text-[14px] font-medium text-[#565449] outline-none placeholder:text-[#8C8889]"
              placeholder={navData.topbar.searchPlaceholder}
            />
          </div>
        </div>
      </div>
    </header>
  );
}

