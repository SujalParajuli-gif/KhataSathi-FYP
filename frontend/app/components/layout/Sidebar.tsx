import { useEffect, useRef } from "react";
import { NavLink } from "react-router";
import BrandLogo from "~/components/ui/BrandLogo";
import GIcon from "~/components/ui/GIcon";
import navData from "~/config/ui.nav.json";
import type { UserRole } from "~/lib/auth";

type Props = {
  role: UserRole;
  isMobileOpen: boolean;
  isCollapsed: boolean;
  mobileEnabled?: boolean;
  onCloseMobile: () => void;
};

function SidebarLink({
  item,
  isCollapsed,
  onNavigate,
}: {
  item: (typeof navData.sidebar.items)[number];
  isCollapsed: boolean;
  onNavigate: () => void;
}) {
  return (
    <NavLink
      to={item.to}
      end={item.to === "/"}
      onClick={onNavigate}
      title={isCollapsed ? item.label : undefined}
      className={({ isActive }) =>
        [
          "group flex h-11 items-center gap-3 rounded-[10px] border text-[14px] font-semibold transition-colors",
          isCollapsed
            ? "px-3 lg:mx-auto lg:w-11 lg:justify-center lg:gap-0 lg:px-0"
            : "px-3",
          item.danger
            ? "border-transparent text-rose-600 hover:border-rose-200 hover:bg-rose-50"
            : isActive
              ? "border-[#11120d] bg-[#11120d] text-white"
              : "border-transparent text-[#565449] hover:border-[#CFCFD3] hover:bg-[#E7E8EA] hover:text-black",
        ].join(" ")
      }
    >
      {({ isActive }) => (
        <>
          <GIcon
            name={item.icon}
            className={[
              "shrink-0 text-[22px]",
              item.danger
                ? "text-inherit"
                : isActive
                  ? "text-white"
                  : "text-[#8C8889] group-hover:text-black",
            ].join(" ")}
          />
          <span className={isCollapsed ? "lg:hidden" : ""}>{item.label}</span>
        </>
      )}
    </NavLink>
  );
}

export default function Sidebar({
  role,
  isMobileOpen,
  isCollapsed,
  mobileEnabled = true,
  onCloseMobile,
}: Props) {
  const sidebarRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const items = navData.sidebar.items.filter((item) =>
    item.roles.includes(role),
  );
  const mainItems = items.filter((item) => item.section !== "bottom");
  const bottomItems = items.filter((item) => item.section === "bottom");
  const sectionLabel = role === "staff" ? "STAFF MENU" : navData.sidebar.mainLabel;

  useEffect(() => {
    if (!isMobileOpen) return undefined;

    returnFocusRef.current = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();

    function keepFocusInDrawer(event: KeyboardEvent) {
      if (event.key !== "Tab" || !sidebarRef.current) return;

      const focusable = Array.from(
        sidebarRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("disabled"));

      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", keepFocusInDrawer);
    return () => {
      document.removeEventListener("keydown", keepFocusInDrawer);
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    };
  }, [isMobileOpen]);

  return (
    <>
      <button
        type="button"
        onClick={onCloseMobile}
        className={[
          "fixed inset-0 z-[40] bg-slate-950/45 backdrop-blur-[2px] transition-opacity duration-200 lg:hidden",
          mobileEnabled && isMobileOpen
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0",
        ].join(" ")}
        aria-label="Close navigation drawer"
        tabIndex={isMobileOpen ? 0 : -1}
      />

      <aside
        ref={sidebarRef}
        id="app-sidebar"
        aria-label="Primary navigation"
        className={[
          "fixed inset-y-0 left-0 z-[50] flex w-[min(88vw,320px)] flex-col border-r border-[#CFCFD3] bg-white transition-[width,transform] duration-200 ease-out",
          isCollapsed ? "lg:w-[80px]" : "lg:w-[260px]",
          mobileEnabled && isMobileOpen ? "translate-x-0" : "-translate-x-full",
          "lg:translate-x-0",
        ].join(" ")}
      >
        <div className="flex h-[68px] shrink-0 items-center justify-between gap-3 border-b border-[#CFCFD3] px-4 lg:hidden">
          <BrandLogo className="h-[40px] w-[174px]" />
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onCloseMobile}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-[#CFCFD3] bg-white text-[#565449] transition hover:bg-[#E7E8EA] hover:text-black"
            aria-label="Close navigation drawer"
          >
            <GIcon name="close" />
          </button>
        </div>

        <div
          className={[
            "hidden h-[68px] shrink-0 items-center overflow-hidden border-b border-[#CFCFD3] lg:flex",
            isCollapsed ? "justify-center px-3" : "px-4",
          ].join(" ")}
        >
          <BrandLogo
            variant={isCollapsed ? "icon" : "full"}
            className={
              isCollapsed
                ? "h-10 w-10 border border-[#CFCFD3] bg-white p-1"
                : "h-10 w-[174px]"
            }
          />
        </div>

        <div
          className={[
            "px-5 pb-2 pt-4 text-[10px] font-extrabold uppercase text-[#8C8889]",
            isCollapsed ? "lg:hidden" : "",
          ].join(" ")}
        >
          {sectionLabel}
        </div>

        <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 py-2 [scrollbar-width:thin]">
          {mainItems.map((item) => (
            <SidebarLink
              key={item.key}
              item={item}
              isCollapsed={isCollapsed}
              onNavigate={onCloseMobile}
            />
          ))}
        </nav>

        <div className="shrink-0 bg-white px-3 pb-[max(16px,env(safe-area-inset-bottom))] pt-2">
          <div
            className={[
              "mb-2 h-px bg-[#CFCFD3]",
              isCollapsed ? "lg:mx-auto lg:w-10" : "",
            ].join(" ")}
          />
          <div className="flex flex-col gap-1">
            {bottomItems.map((item) => (
              <SidebarLink
                key={item.key}
                item={item}
                isCollapsed={isCollapsed}
                onNavigate={onCloseMobile}
              />
            ))}
          </div>
        </div>
      </aside>
    </>
  );
}
