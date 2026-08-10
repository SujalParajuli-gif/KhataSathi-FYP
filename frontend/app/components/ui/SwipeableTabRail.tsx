import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from "react";

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export type SwipeableTabItem<T extends string> = {
  value: T;
  label: string;
  count?: number;
};

export type SwipeableTabRailController = {
  setGestureProgress: (direction: -1 | 1, progress: number) => void;
  settle: () => void;
};

export default function SwipeableTabRail<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  className,
  railClassName,
  buttonClassName,
  activeClassName = "text-[#11120D]",
  inactiveClassName = "text-[#565449] hover:text-black",
  gestureProgress,
  controllerRef,
}: {
  items: Array<SwipeableTabItem<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  railClassName?: string;
  buttonClassName?: string;
  activeClassName?: string;
  inactiveClassName?: string;
  gestureProgress?: { direction: -1 | 1; progress: number } | null;
  controllerRef?: MutableRefObject<SwipeableTabRailController | null>;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);

  function indicatorPosition(direction?: -1 | 1, rawProgress = 0) {
    const track = trackRef.current;
    if (!track) return null;
    const currentIndex = items.findIndex((item) => item.value === value);
    const current = track.querySelector<HTMLElement>(`[data-tab-value="${CSS.escape(value)}"]`);
    if (!current) return null;
    const targetItem = direction ? items[currentIndex + direction] : null;
    const target = targetItem
      ? track.querySelector<HTMLElement>(`[data-tab-value="${CSS.escape(targetItem.value)}"]`)
      : null;
    const progress = target ? Math.max(0, Math.min(1, rawProgress)) : 0;
    return {
      left: current.offsetLeft + ((target?.offsetLeft ?? current.offsetLeft) - current.offsetLeft) * progress,
      width: current.offsetWidth + ((target?.offsetWidth ?? current.offsetWidth) - current.offsetWidth) * progress,
    };
  }

  function paintIndicator(direction?: -1 | 1, progress = 0, animate = true) {
    const indicator = indicatorRef.current;
    const position = indicatorPosition(direction, progress);
    if (!indicator || !position) return;
    indicator.style.transition = animate ? "" : "none";
    indicator.style.width = `${position.width}px`;
    indicator.style.transform = `translate3d(${position.left}px,0,0)`;
  }

  useEffect(() => {
    const activeTab = railRef.current?.querySelector<HTMLElement>(
      `[data-tab-value="${CSS.escape(value)}"]`,
    );
    if (!activeTab) return;
    activeTab.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "nearest",
      inline: "center",
    });
  }, [value]);

  useLayoutEffect(() => {
    paintIndicator(
      gestureProgress?.direction,
      gestureProgress?.progress ?? 0,
      !gestureProgress,
    );
    const observer = new ResizeObserver(() => paintIndicator());
    if (trackRef.current) observer.observe(trackRef.current);
    return () => observer.disconnect();
  }, [gestureProgress, items, value]);

  useLayoutEffect(() => {
    if (!controllerRef) return undefined;
    controllerRef.current = {
      setGestureProgress: (direction, progress) => paintIndicator(direction, progress, false),
      settle: () => paintIndicator(undefined, 0, true),
    };
    return () => {
      controllerRef.current = null;
    };
  }, [controllerRef, items, value]);

  return (
    <div
      ref={railRef}
      role="tablist"
      aria-label={ariaLabel}
      data-horizontal-scroll
      className={cn(
        "max-w-full overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      <div ref={trackRef} className={cn("relative flex min-w-max", railClassName)}>
        {items.map((item) => {
          const active = item.value === value;
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={active}
              data-tab-value={item.value}
              onClick={() => onChange(item.value)}
              className={cn(
                "shrink-0 transition-colors duration-200",
                buttonClassName,
                active ? activeClassName : inactiveClassName,
              )}
            >
              {item.label}
              {item.count !== undefined ? (
                <span className={cn("ml-1 text-[11px]", active ? "opacity-75" : "text-slate-400")}>
                  {item.count}
                </span>
              ) : null}
            </button>
          );
        })}
        <span
          ref={indicatorRef}
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 h-[3px] rounded-t-full bg-[#11120D] transition-[transform,width] duration-[240ms] ease-[cubic-bezier(0.22,0.8,0.24,1)] will-change-transform"
        />
      </div>
    </div>
  );
}
