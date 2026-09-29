import { useEffect, useRef } from "react";
import { Link } from "react-router";

export type PageSectionItem<T extends string> = {
  value: T;
  label: string;
  to: string;
};

export default function PageSectionRail<T extends string>({
  items,
  value,
  ariaLabel,
}: {
  items: Array<PageSectionItem<T>>;
  value: T;
  ariaLabel: string;
}) {
  const railRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const rail = railRef.current;
    const active = rail?.querySelector<HTMLElement>("[aria-current='page']");
    if (!rail || !active) return;
    const railBounds = rail.getBoundingClientRect();
    const activeBounds = active.getBoundingClientRect();
    if (activeBounds.left < railBounds.left) {
      rail.scrollBy({ left: activeBounds.left - railBounds.left, behavior: "instant" });
    } else if (activeBounds.right > railBounds.right) {
      rail.scrollBy({ left: activeBounds.right - railBounds.right, behavior: "instant" });
    }
  }, [value]);

  return (
    <nav
      ref={railRef}
      aria-label={ariaLabel}
      data-horizontal-scroll
      className="max-w-full overflow-x-auto border-b border-slate-200 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div className="flex w-max min-w-full items-end gap-1 sm:gap-3">
        {items.map((item) => {
          const active = item.value === value;
          return (
            <Link
              key={item.value}
              to={item.to}
              aria-current={active ? "page" : undefined}
              className={`inline-flex min-h-11 shrink-0 items-center border-b-2 px-3 text-sm font-semibold transition-colors focus-visible:rounded-t-md focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-blue-600 ${
                active
                  ? "border-slate-950 text-slate-950"
                  : "border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-950"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
