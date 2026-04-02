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
  const sidebarWidthClass = isCollapsed ? "w-[80px]" : "w-[260px]";

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
        className={[
          "fixed left-0 top-0 z-50 h-full bg-[#FFFFFF]",
          "border-r border-[#CFCFD3]  ",
          sidebarWidthClass,
          "transition-[width,transform] duration-300 ease-in-out",
          isMobileOpen ? "translate-x-0" : "-translate-x-full",
          "lg:translate-x-0",
        ].join(" ")}
      >
        <div className="flex items-center gap-3 overflow-hidden border-b border-[#CFCFD3] px-[16px] py-[24px]">
          {isCollapsed ? (
            <BrandLogo
              variant="icon"
              className="h-[40px] w-[40px] border border-[#CFCFD3] bg-[#FFFFFF] p-[4px] "
            />
          ) : (
            <BrandLogo className="h-[40px] w-[174px]" />
          )}
        </div>

        {!isCollapsed && (
          <div className="mb-[8px] px-[24px] pt-[16px]">
            <div className="text-[10px] font-extrabold uppercase  text-[#8C8889]">
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
                    ? "justify-center px-0 py-[10px]"
                    : "gap-[12px] px-[12px] py-[10px]",
                  "text-[14px] font-semibold",
                  isActive
                    ? "border-[#11120d] bg-[#11120d] text-white "
                    : "border-transparent text-[#565449] hover:border-[#CFCFD3] hover:bg-[#F3F4F6] hover:text-[#000000]",
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
                        : "text-[#8C8889] group-hover:text-[#000000]",
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

        <div className="absolute bottom-0 left-0 w-full px-[12px] pb-[24px]">
          <div className="mx-[12px] mb-[16px] h-px bg-[#CFCFD3]" />

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
                      ? "justify-center px-0 py-[10px]"
                      : "gap-[12px] px-[12px] py-[10px]",
                    "text-[14px] font-semibold",
                    item.danger
                      ? "border-transparent text-rose-600 hover:border-rose-200 hover:bg-rose-50"
                      : isActive
                        ? "border-[#11120d] bg-[#11120d] text-white"
                        : "border-transparent text-[#565449] hover:border-[#CFCFD3] hover:bg-[#F3F4F6] hover:text-[#000000]",
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
                            : "text-[#8C8889] group-hover:text-[#000000]"
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

