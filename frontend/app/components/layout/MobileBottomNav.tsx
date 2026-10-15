import { useLocation, NavLink } from "react-router";
import GIcon from "~/components/ui/GIcon";
import type { UserRole } from "~/lib/auth";
import type { BusinessCapabilities } from "~/lib/api/endpoints";
import {
  getMobileBottomNavItems,
  isRouteActive,
  type NavItemConfig,
} from "~/config/navigation";

type Props = {
  role: UserRole;
  capabilities: BusinessCapabilities;
  isDrawerOpen: boolean;
  onOpenDrawer: () => void;
};

export default function MobileBottomNav({
  role,
  capabilities,
  isDrawerOpen,
  onOpenDrawer,
}: Props) {
  const location = useLocation();
  const bottomItems = getMobileBottomNavItems(role, capabilities);

  // Check if current page is one of the bottom bar destinations
  const isBottomRouteActive = bottomItems.some((item) =>
    isRouteActive(location.pathname, item.to, item.end),
  );

  // If the current route is not in the bottom tabs, then it's in the secondary drawer
  const isSecondaryRouteActive = !isBottomRouteActive;

  return (
    <nav
      aria-label="Mobile navigation"
      className="fixed inset-x-0 bottom-0 z-[40] border-t border-[#D8DDE5] bg-white/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_24px_rgba(15,23,42,0.06)] backdrop-blur lg:hidden"
    >
      <div
        className="grid h-[64px]"
        style={{
          gridTemplateColumns: `repeat(${bottomItems.length + 1}, minmax(0, 1fr))`,
        }}
      >
        {bottomItems.map((item: NavItemConfig) => {
          const active = isRouteActive(location.pathname, item.to, item.end);

          return (
            <NavLink
              key={item.id}
              to={item.to}
              end={item.end}
              className={[
                "relative flex min-w-0 flex-col items-center justify-center gap-1 px-1 text-[10.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:bg-slate-50",
                active
                  ? "text-slate-950 font-bold"
                  : "text-slate-500 hover:text-slate-900",
              ].join(" ")}
              aria-current={active ? "page" : undefined}
            >
              {/* Top Accent Indicator */}
              <span
                aria-hidden="true"
                className={[
                  "absolute inset-x-[22%] top-0 h-[3px] rounded-b-full transition-colors",
                  active ? "bg-slate-900" : "bg-transparent",
                ].join(" ")}
              />
              <GIcon
                name={item.icon}
                sizePx={21}
                className={active ? "text-slate-950" : "text-slate-500"}
              />
              <span className="truncate">{item.label}</span>
            </NavLink>
          );
        })}

        {/* More Button: opens secondary drawer */}
        <button
          type="button"
          onClick={onOpenDrawer}
          aria-expanded={isDrawerOpen}
          aria-label="Open more navigation options"
          className={[
            "relative flex min-w-0 flex-col items-center justify-center gap-1 px-1 text-[10.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:bg-slate-50",
            isSecondaryRouteActive || isDrawerOpen
              ? "text-slate-950 font-bold"
              : "text-slate-500 hover:text-slate-900",
          ].join(" ")}
        >
          {/* Top Accent Indicator for secondary route active or drawer open */}
          <span
            aria-hidden="true"
            className={[
              "absolute inset-x-[22%] top-0 h-[3px] rounded-b-full transition-colors",
              isSecondaryRouteActive || isDrawerOpen ? "bg-slate-900" : "bg-transparent",
            ].join(" ")}
          />
          <GIcon
            name="more_horiz"
            sizePx={22}
            className={
              isSecondaryRouteActive || isDrawerOpen ? "text-slate-950" : "text-slate-500"
            }
          />
          <span className="truncate">More</span>
        </button>
      </div>
    </nav>
  );
}
