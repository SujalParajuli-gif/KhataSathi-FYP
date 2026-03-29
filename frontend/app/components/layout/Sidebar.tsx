import type { CSSProperties } from "react";
import { NavLink } from "react-router";
import BrandLogo from "~/components/ui/BrandLogo";
import GIcon from "~/components/ui/GIcon";
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
  const items = navData.sidebar.items.filter((item) =>
    item.roles.includes(role),
  );

  const mainItems = items.filter((item) => item.section !== "bottom");
  const bottomItems = items.filter((item) => item.section === "bottom");

  return (
    <>
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
            "--sidebar-w": isCollapsed ? "80px" : "260px",
          } as CSSProperties
        }
        className={[
          "fixed left-0 top-0 z-50 h-full bg-white",
          "border-r border-[var(--app-border)] shadow-[0_24px_70px_-42px_rgba(17,18,13,0.55)] lg:shadow-none",
          "w-[var(--sidebar-w)]",
          "transition-[width,transform] duration-300 ease-in-out",
          isMobileOpen ? "translate-x-0" : "-translate-x-full",
          "lg:translate-x-0",
        ].join(" ")}
      >
        <div className="flex items-center gap-3 overflow-hidden border-b border-[var(--app-border)] px-4 py-6">
          {isCollapsed ? (
            <BrandLogo
              variant="icon"
              className="h-10 w-10 border border-[var(--app-border)] bg-white p-1 shadow-[0_16px_34px_-24px_rgba(17,18,13,0.28)]"
            />
          ) : (
            <BrandLogo className="h-10 w-[174px]" />
          )}
        </div>

        {!isCollapsed && (
          <div className="mb-2 px-6 pt-4">
            <div className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-[var(--app-text-muted)]">
              {navData.sidebar.mainLabel}
            </div>
          </div>
        )}

        <nav className="flex flex-col gap-1 px-3">
          {mainItems.map((item) => (
            <NavLink
              key={item.key}
              to={item.to}
              end={item.to === "/"}
              onClick={onCloseMobile}
              title={isCollapsed ? item.label : undefined}
              className={({ isActive }) =>
                [
                  "group relative flex items-center rounded-[16px] border transition-all duration-200",
                  isCollapsed
                    ? "justify-center px-0 py-2.5"
                    : "gap-3 px-3 py-2.5",
                  "text-[14px] font-semibold",
                  isActive
                    ? "border-[#11120d] bg-[#11120d] text-white shadow-[0_18px_36px_-26px_rgba(17,18,13,0.78)]"
                    : "border-transparent text-[var(--app-text-soft)] hover:border-[var(--app-border)] hover:bg-[var(--app-surface-muted)] hover:text-[var(--app-text)]",
                ].join(" ")
              }
            >
              {({ isActive }) => (
                <>
                  <GIcon
                    name={item.icon}
                    className={[
                      "transition-colors duration-200",
                      isActive
                        ? "text-white"
                        : "text-[var(--app-text-muted)] group-hover:text-[var(--app-text)]",
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

        <div className="absolute bottom-0 left-0 w-full px-3 pb-6">
          <div className="mx-3 mb-4 h-px bg-[var(--app-border)]" />

          <div className="flex flex-col gap-1">
            {bottomItems.map((item) => (
              <NavLink
                key={item.key}
                to={item.to}
                end
                onClick={onCloseMobile}
                title={isCollapsed ? item.label : undefined}
                className={({ isActive }) =>
                  [
                    "group flex items-center rounded-[16px] border transition-all duration-200",
                    isCollapsed
                      ? "justify-center px-0 py-2.5"
                      : "gap-3 px-3 py-2.5",
                    "text-[14px] font-semibold",
                    item.danger
                      ? "border-transparent text-rose-600 hover:border-rose-200 hover:bg-rose-50"
                      : isActive
                        ? "border-[#11120d] bg-[#11120d] text-white"
                        : "border-transparent text-[var(--app-text-soft)] hover:border-[var(--app-border)] hover:bg-[var(--app-surface-muted)] hover:text-[var(--app-text)]",
                  ].join(" ")
                }
              >
                {({ isActive }) => (
                  <>
                    <GIcon
                      name={item.icon}
                      className={
                        item.danger
                          ? "text-inherit"
                          : isActive
                            ? "text-white"
                            : "text-[var(--app-text-muted)] group-hover:text-[var(--app-text)]"
                      }
                    />

                    {!isCollapsed && (
                      <span className="whitespace-nowrap">{item.label}</span>
                    )}
                  </>
                )}
              </NavLink>
            ))}
          </div>
        </div>
      </aside>
    </>
  );
}
