import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import Sidebar from "~/components/layout/Sidebar";
import Topbar from "~/components/layout/Topbar";
import { ToastProvider } from "~/components/ui/Toast";
import navData from "~/config/ui.nav.json";
import { AlertsProvider } from "~/lib/alerts/alerts-context";
import { getAuthUser } from "~/lib/auth";

type Props = {
  children: ReactNode;
};

const SIDEBAR_STATE_STORAGE_KEY = "khatasathi_sidebar_state";

// converting a URL pathname like "/customer-discounts" into a readable title like "Customer Discounts"
// we use this as a fallback when no matching nav item has a pageTitle defined
function prettifyPathname(pathname: string) {
  if (pathname === "/") return "Dashboard";

  const segment = pathname.split("/").filter(Boolean).pop() ?? "Dashboard";
  return segment
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

// the main layout wrapper for all authenticated pages — provides the sidebar, topbar, and content area
// it also handles sidebar collapse state and responsive mobile sidebar behavior
export default function AppShell({ children }: Props) {
  const location = useLocation();
  const [isMobileOpen, setIsMobileOpen] = useState(false); // whether the mobile sidebar overlay is visible
  const [isCollapsed, setIsCollapsed] = useState(() => {
    if (typeof window === "undefined") return true;
    const saved = window.localStorage.getItem(SIDEBAR_STATE_STORAGE_KEY);
    return saved ? saved === "collapsed" : true;
  }); // whether the desktop sidebar is in collapsed (icon-only) mode

  // reading the current user from localStorage and updating when auth_change events fire
  const [user, setUser] = useState(() => getAuthUser());

  useEffect(() => {
    const handleReauth = () => setUser(getAuthUser());
    window.addEventListener("auth_change", handleReauth);
    return () => window.removeEventListener("auth_change", handleReauth);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      SIDEBAR_STATE_STORAGE_KEY,
      isCollapsed ? "collapsed" : "expanded",
    );
  }, [isCollapsed]);
  const role = user?.role ?? "admin";
  // adjusting the main content left margin based on sidebar width
  const contentOffsetClass = isCollapsed ? "lg:ml-[80px]" : "lg:ml-[260px]";
  // filtering sidebar nav items to only show the ones the current role has access to
  const visibleItems = useMemo(
    () => navData.sidebar.items.filter((item) => item.roles.includes(role)),
    [role],
  );

  // determining the page title — first checking if there is a matching nav item, otherwise prettifying the URL
  const pageTitle = useMemo(() => {
    const matched = visibleItems.find((item) => item.to === location.pathname);
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
    <AlertsProvider>
      <ToastProvider>
        <div className="min-h-screen bg-[#F1F1F1] text-slate-900">
          <Sidebar
            role={role}
            isMobileOpen={isMobileOpen}
            isCollapsed={isCollapsed}
            onCloseMobile={() => setIsMobileOpen(false)}
          />

          {/* the main content area — its left margin transitions smoothly when the sidebar collapses */}
          <div
            className={`transition-[margin] duration-300 ${contentOffsetClass}`}
          >
            <Topbar
              pageTitle={pageTitle}
              onOpenMobileSidebar={() => setIsMobileOpen(true)}
              onToggleCollapse={() => setIsCollapsed((value) => !value)}
              isCollapsed={isCollapsed}
              userName={user?.name ?? "User"}
              roleLabel={roleLabel}
              profileImage={user?.profileImage}
              profileHref={profileHref}
              greetingText={`Welcome back, ${user?.name?.split(" ")[0] ?? roleLabel}`}
            />

            <main
              className={
                isBillingRoute
                  ? "h-[calc(100dvh-72px)] overflow-hidden bg-[#F1F1F1] p-[12px]"
                  : "bg-[#F1F1F1] p-[20px] lg:p-[24px]"
              }
            >
              {children}
            </main>
          </div>
        </div>
      </ToastProvider>
    </AlertsProvider>
  );
}
