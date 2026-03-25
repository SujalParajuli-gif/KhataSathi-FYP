import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useLocation } from "react-router";
import Sidebar from "~/components/layout/Sidebar";
import Topbar from "~/components/layout/Topbar";
import navData from "~/config/ui.nav.json";
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

  const visibleItems = useMemo(
    () => navData.sidebar.items.filter((item) => item.roles.includes(role)),
    [role],
  );

  const pageTitle = useMemo(() => {
    const matched = visibleItems.find((item) => item.to === location.pathname);
    return matched?.pageTitle ?? prettifyPathname(location.pathname);
  }, [visibleItems, location.pathname]);

  const roleLabel = role === "cashier" ? "Cashier" : "Admin";
  const contentVars = {
    "--sidebar-offset": isCollapsed ? "80px" : "260px",
  } as CSSProperties;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <Sidebar
        role={role}
        isMobileOpen={isMobileOpen}
        isCollapsed={isCollapsed}
        onCloseMobile={() => setIsMobileOpen(false)}
      />

      <div
        className="min-h-screen transition-[margin] duration-300 lg:ml-[var(--sidebar-offset)]"
        style={contentVars}
      >
        <Topbar
          pageTitle={pageTitle}
          onOpenMobileSidebar={() => setIsMobileOpen(true)}
          onToggleCollapse={() => setIsCollapsed((value) => !value)}
          isCollapsed={isCollapsed}
          userName={user?.name ?? "User"}
          roleLabel={roleLabel}
          profileImage={user?.profileImage}
          greetingText={`Welcome back, ${user?.name?.split(" ")[0] ?? roleLabel}`}
        />

        <main className="p-5 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
