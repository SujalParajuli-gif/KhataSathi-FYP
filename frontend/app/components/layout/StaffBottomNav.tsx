import { NavLink } from "react-router";
import GIcon from "~/components/ui/GIcon";

const items = [
  { to: "/product-lookup", label: "Lookup", icon: "search" },
  { to: "/staff-requests", label: "Requests", icon: "receipt_long" },
  { to: "/cashier-profile", label: "Profile", icon: "person" },
] as const;

export default function StaffBottomNav() {
  return (
    <nav
      aria-label="Staff navigation"
      className="fixed inset-x-0 bottom-0 z-[30] border-t border-[#CFCFD3] bg-white/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_24px_rgba(15,23,42,0.08)] backdrop-blur lg:hidden"
    >
      <div className="grid h-[64px] grid-cols-3">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              [
                "relative flex min-w-0 flex-col items-center justify-center gap-1 px-2 text-[11px] font-bold transition-colors",
                isActive
                  ? "text-[#11120d]"
                  : "text-[#8C8889] hover:text-[#565449]",
              ].join(" ")
            }
          >
            {({ isActive }) => (
              <>
                <span
                  aria-hidden="true"
                  className={[
                    "absolute inset-x-[28%] top-0 h-[3px] rounded-b-full transition-colors",
                    isActive ? "bg-[#11120d]" : "bg-transparent",
                  ].join(" ")}
                />
                <GIcon name={item.icon} className="text-[22px]" />
                <span className="truncate">{item.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
