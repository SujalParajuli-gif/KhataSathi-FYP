// frontend/app/components/layout/Sidebar.tsx
import { NavLink } from "react-router";
import GoogleIcon from "~/components/ui/GoogleIcon";
import navData from "~/config/ui.nav.json";
import type { UserRole } from "~/lib/auth";

type Props = {
  role: UserRole;
  isMobileOpen: boolean;
  isCollapsed: boolean;
  onCloseMobile: () => void;
};

export default function Sidebar({
  role,
  isMobileOpen,
  isCollapsed,
  onCloseMobile,
}: Props) {
  // role-based items from JSON
  const items = navData.sidebar.items.filter((item) =>
    item.roles.includes(role),
  );

  // split into main and bottom groups
  const mainItems = items.filter(
    (x) => !["settings", "profile", "logout"].includes(x.key),
  );
  const bottomItems = items.filter((x) =>
    ["settings", "profile", "logout"].includes(x.key),
  );

  // only dashboard should require exact match
  const isExact = (to: string) => to === "/dashboard";

  return (
    <>
      {/* Mobile overlay */}
      <button
        type="button"
        onClick={onCloseMobile}
        className={[
          "fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm transition-opacity duration-300",
          isMobileOpen ? "opacity-100 block" : "opacity-0 hidden",
          "lg:hidden",
        ].join(" ")}
        aria-label="Close sidebar overlay"
      />

      <aside
        style={
          {
            // collapsed width vs expanded width
            // AppShell should use the same logic for its left margin (var(--sidebar-w))
            "--sidebar-w": isCollapsed ? "80px" : "260px",
          } as React.CSSProperties
        }
        className={[
          "fixed left-0 top-0 z-50 h-full bg-white",
          "border-r border-slate-200/60 shadow-xl lg:shadow-none",
          "w-[var(--sidebar-w)]",
          "transition-[width,transform] duration-300 ease-in-out",
          isMobileOpen ? "translate-x-0" : "-translate-x-full",
          "lg:translate-x-0",
        ].join(" ")}
      >
        {/* Brand */}
        <div className="flex items-center gap-3 px-4 py-6 overflow-hidden">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-orange-400 to-orange-600 font-bold text-white shadow-lg shadow-orange-200/50">
            {navData.brand.logoText}
          </div>

          {!isCollapsed && (
            <div className="truncate text-lg font-bold tracking-tight text-slate-900">
              {navData.brand.name}
            </div>
          )}
        </div>

        {/* Section label */}
        {!isCollapsed && (
          <div className="px-6 mb-2">
            <div className="text-[10px] font-extrabold uppercase tracking-[0.15em] text-slate-400/80">
              {navData.sidebar.mainLabel}
            </div>
          </div>
        )}

        {/* Main nav */}
        <nav className="flex flex-col gap-1 px-3">
          {mainItems.map((item) => (
            <NavLink
              key={item.key}
              to={item.to}
              end={isExact(item.to)}
              onClick={onCloseMobile}
              title={isCollapsed ? item.label : undefined}
              className={({ isActive }) =>
                [
                  "group relative flex items-center rounded-xl transition-all duration-200",
                  isCollapsed
                    ? "justify-center px-0 py-2.5"
                    : "gap-3 px-3 py-2.5",
                  "text-[14px] font-semibold",
                  isActive
                    ? "bg-orange-50 text-orange-600 shadow-sm shadow-orange-100/50"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                ].join(" ")
              }
            >
              {({ isActive }) => (
                <>
                  {/* active indicator */}
                  {isActive && (
                    <div className="absolute left-0 h-5 w-1 rounded-r-full bg-orange-600" />
                  )}

                  <GoogleIcon
                    name={item.icon}
                    className={[
                      "transition-transform duration-200 group-hover:scale-110",
                      isActive
                        ? "text-orange-600"
                        : "text-slate-400 group-hover:text-slate-600",
                    ].join(" ")}
                  />

                  {!isCollapsed && (
                    <span className="whitespace-nowrap">{item.label}</span>
                  )}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Bottom nav */}
        <div className="absolute bottom-0 left-0 w-full px-3 pb-6">
          <div className="mx-3 mb-4 h-px bg-slate-100" />

          <div className="flex flex-col gap-1">
            {bottomItems.map((item) => (
              <NavLink
                key={item.key}
                to={item.to}
                end={isExact(item.to)}
                onClick={onCloseMobile}
                title={isCollapsed ? item.label : undefined}
                className={({ isActive }) =>
                  [
                    "group flex items-center rounded-xl transition-all duration-200",
                    isCollapsed
                      ? "justify-center px-0 py-2.5"
                      : "gap-3 px-3 py-2.5",
                    "text-[14px] font-semibold",
                    item.danger
                      ? "text-rose-500 hover:bg-rose-50 hover:text-rose-600"
                      : isActive
                        ? "bg-orange-50 text-orange-600"
                        : "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                  ].join(" ")
                }
              >
                <GoogleIcon
                  name={item.icon}
                  className={
                    item.danger
                      ? "text-inherit"
                      : "text-slate-400 group-hover:text-slate-600"
                  }
                />

                {!isCollapsed && (
                  <span className="whitespace-nowrap">{item.label}</span>
                )}
              </NavLink>
            ))}
          </div>
        </div>
      </aside>
    </>
  );
}
