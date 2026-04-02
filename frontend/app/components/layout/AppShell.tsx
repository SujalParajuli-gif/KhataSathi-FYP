import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import Sidebar from "~/components/layout/Sidebar";
import Topbar from "~/components/layout/Topbar";
import navData from "~/config/ui.nav.json";
import { AlertsProvider } from "~/lib/alerts/alerts-context";
import { getAuthUser } from "~/lib/auth";

type Props = {
  children: ReactNode;
};

function prettifyPathname(pathname: string) {
  if (pathname === "/") return "Dashboard";

  const segment = pathname.split("/").filter(Boolean).pop() ?? "Dashboard";
  return segment
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export default function AppShell({ children }: Props) {
  const location = useLocation();
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);

  const [user, setUser] = useState(() => getAuthUser());

  useEffect(() => {
    const handleReauth = () => setUser(getAuthUser());
    window.addEventListener("auth_change", handleReauth);
    return () => window.removeEventListener("auth_change", handleReauth);
  }, []);
  const role = user?.role ?? "admin";
  const contentOffsetClass = isCollapsed ? "lg:ml-[80px]" : "lg:ml-[260px]";

  const visibleItems = useMemo(
    () => navData.sidebar.items.filter((item) => item.roles.includes(role)),
    [role],
  );

  const pageTitle = useMemo(() => {
    const matched = visibleItems.find((item) => item.to === location.pathname);
    return matched?.pageTitle ?? prettifyPathname(location.pathname);
  }, [visibleItems, location.pathname]);

  const roleLabel = role === "cashier" ? "Cashier" : "Admin";
  const profileHref = role === "cashier" ? "/cashier-profile" : "/profile";

  return (
    <AlertsProvider>
      <div className="min-h-screen bg-[#F1F1F1] text-slate-900">
        <Sidebar
          role={role}
          isMobileOpen={isMobileOpen}
          isCollapsed={isCollapsed}
          onCloseMobile={() => setIsMobileOpen(false)}
        />

        <div className={`transition-[margin] duration-300 ${contentOffsetClass}`}>
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

          <main className="bg-[#F1F1F1] p-[20px] lg:p-[24px]">
            {children}
          </main>
        </div>
      </div>
    </AlertsProvider>
  );
}

