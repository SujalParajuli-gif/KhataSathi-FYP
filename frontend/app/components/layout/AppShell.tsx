import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import Sidebar from "~/components/layout/Sidebar";
import StaffBottomNav from "~/components/layout/StaffBottomNav";
import Topbar from "~/components/layout/Topbar";
import Icon from "~/components/ui/Icon";
import { ToastProvider } from "~/components/ui/Toast";
import navData from "~/config/ui.nav.json";
import { useBodyScrollLock } from "~/hooks/useBodyScrollLock";
import { isRateLimited } from "~/lib/api/client";
import { touchUserPresenceApi } from "~/lib/api/endpoints";
import { AlertsProvider } from "~/lib/alerts/alerts-context";
import { getAuthUser } from "~/lib/auth";
import { useBusinessCapabilities } from "~/lib/businessCapabilities";
import { hasCapabilityRouteAccess } from "~/lib/routeAccess";

type Props = {
  children: ReactNode;
  statusBanner?: ReactNode;
};

const SIDEBAR_STATE_STORAGE_KEY = "khatasathi_sidebar_state";

function prettifyPathname(pathname: string) {
  if (pathname === "/") return "Dashboard";

  const segment = pathname.split("/").filter(Boolean).pop() ?? "Dashboard";
  return segment
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function RateLimitBanner() {
  const [secondsLeft, setSecondsLeft] = useState(0);
  const endTimeRef = useRef(0);

  useEffect(() => {
    function onRateLimited(event: Event) {
      const retryAfterMs =
        (event as CustomEvent<{ retryAfterMs: number }>).detail?.retryAfterMs ??
        15_000;
      endTimeRef.current = Date.now() + retryAfterMs;
      setSecondsLeft(Math.ceil(retryAfterMs / 1000));
    }

    function onCleared() {
      setSecondsLeft(0);
      endTimeRef.current = 0;
    }

    window.addEventListener("rate_limited", onRateLimited);
    window.addEventListener("rate_limit_cleared", onCleared);
    return () => {
      window.removeEventListener("rate_limited", onRateLimited);
      window.removeEventListener("rate_limit_cleared", onCleared);
    };
  }, []);

  useEffect(() => {
    if (secondsLeft <= 0) return undefined;

    const timer = window.setInterval(() => {
      setSecondsLeft(
        Math.max(0, Math.ceil((endTimeRef.current - Date.now()) / 1000)),
      );
    }, 1000);

    return () => window.clearInterval(timer);
  }, [secondsLeft > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  if (secondsLeft <= 0) return null;

  return (
    <div className="fixed inset-x-0 top-0 z-[150] flex items-center justify-center gap-2 bg-amber-500 px-4 py-2 text-[13px] font-semibold text-white shadow-md">
      <Icon name="hourglass_top" className="animate-pulse text-[18px]" />
      <span>
        Too many requests - pausing for {secondsLeft}s, then resuming
        automatically...
      </span>
    </div>
  );
}

export default function AppShell({ children, statusBanner }: Props) {
  const location = useLocation();
  const capabilities = useBusinessCapabilities();
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [user, setUser] = useState(() => getAuthUser());

  const role = user?.role ?? "staff";
  const isStaff = role === "staff";
  const usesCompactDesktopRail = role === "cashier" || role === "staff";
  const sidebarStorageKey = `${SIDEBAR_STATE_STORAGE_KEY}:${user?.id ?? role}`;
  const effectiveCollapsed = usesCompactDesktopRail ? true : isCollapsed;

  useBodyScrollLock(!isStaff && isMobileOpen);

  useEffect(() => {
    const handleReauth = () => setUser(getAuthUser());
    window.addEventListener("auth_change", handleReauth);
    return () => window.removeEventListener("auth_change", handleReauth);
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem(sidebarStorageKey);
    setIsCollapsed(saved ? saved === "collapsed" : true);
  }, [sidebarStorageKey]);

  useEffect(() => {
    setIsMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setIsMobileOpen(false);
    }

    function closeAtDesktop(event: MediaQueryListEvent) {
      if (event.matches) setIsMobileOpen(false);
    }

    const desktopQuery = window.matchMedia("(min-width: 1024px)");
    window.addEventListener("keydown", closeOnEscape);
    desktopQuery.addEventListener("change", closeAtDesktop);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      desktopQuery.removeEventListener("change", closeAtDesktop);
    };
  }, []);

  useEffect(() => {
    if (!user?.id || isStaff) return undefined;

    let stopped = false;
    async function pingPresence() {
      if (isRateLimited()) return;

      try {
        await touchUserPresenceApi();
      } catch {
        // Presence is best-effort and should never block navigation.
      }
    }

    void pingPresence();
    const timer = window.setInterval(() => {
      if (!stopped) void pingPresence();
    }, 60_000);

    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [user?.id, isStaff]);

  function toggleDesktopSidebar() {
    if (usesCompactDesktopRail) return;

    setIsCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(
        sidebarStorageKey,
        next ? "collapsed" : "expanded",
      );
      return next;
    });
  }

  const contentOffsetClass = effectiveCollapsed
    ? "lg:ml-[80px]"
    : "lg:ml-[260px]";
  const visibleItems = useMemo(
    () =>
      navData.sidebar.items.filter(
        (item) =>
          item.roles.includes(role) &&
          hasCapabilityRouteAccess(item.to, capabilities),
      ),
    [role, capabilities],
  );
  const pageTitle = useMemo(() => {
    const matched = visibleItems
      .filter(
        (item) =>
          item.to === location.pathname ||
          (item.to !== "/" && location.pathname.startsWith(`${item.to}/`)),
      )
      .sort((left, right) => right.to.length - left.to.length)[0];
    return matched?.pageTitle ?? prettifyPathname(location.pathname);
  }, [visibleItems, location.pathname]);

  const roleLabel =
    role === "cashier"
      ? "Cashier"
      : role === "manager"
        ? "Manager"
        : role === "staff"
          ? "Staff"
          : "Admin";
  const profileHref = role === "admin" ? "/profile" : "/cashier-profile";
  const isBillingRoute = location.pathname === "/billing";

  return (
    <AlertsProvider
      enabled={!isStaff && capabilities.catalogEnabled}
      identityKey={user?.id}
    >
      <ToastProvider>
        <RateLimitBanner />
        <div className="h-dvh overflow-hidden bg-white text-slate-900">
          <Sidebar
            role={role}
            capabilities={capabilities}
            isMobileOpen={isMobileOpen}
            isCollapsed={effectiveCollapsed}
            mobileEnabled={!isStaff}
            onOpenMobile={() => setIsMobileOpen(true)}
            onCloseMobile={() => setIsMobileOpen(false)}
          />

          <div
            className={`flex h-dvh min-w-0 flex-col transition-[margin] duration-200 ${contentOffsetClass}`}
          >
            <Topbar
              pageTitle={pageTitle}
              onOpenMobileSidebar={() => {
                if (!isStaff) setIsMobileOpen(true);
              }}
              onToggleCollapse={toggleDesktopSidebar}
              isMobileSidebarOpen={isMobileOpen}
              isCollapsed={effectiveCollapsed}
              userName={user?.name ?? "User"}
              roleLabel={roleLabel}
              profileImage={user?.profileImage}
              profileHref={profileHref}
              greetingText={`Welcome back, ${user?.name?.split(" ")[0] ?? roleLabel}`}
              showNotifications={!isStaff}
              staffMode={isStaff}
              showDesktopCollapseToggle={!usesCompactDesktopRail}
            />

            {statusBanner}

            <main
              id="app-main-content"
              data-app-scroll-container
              className={[
                "min-h-0 flex-1 overscroll-contain bg-white",
                isBillingRoute
                  ? "overflow-hidden p-[12px]"
                  : "overflow-y-auto p-[12px] sm:p-[20px] lg:p-[24px]",
                isStaff && !isBillingRoute
                  ? "pb-[calc(84px+env(safe-area-inset-bottom))] lg:pb-[24px]"
                  : "",
              ].join(" ")}
            >
              {children}
            </main>
          </div>

          {isStaff ? <StaffBottomNav capabilities={capabilities} /> : null}
        </div>
      </ToastProvider>
    </AlertsProvider>
  );
}
