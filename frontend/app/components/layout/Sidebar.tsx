import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router";
import BrandLogo from "~/components/ui/BrandLogo";
import GIcon from "~/components/ui/GIcon";
import {
  getAuthorizedNavItems,
  getMobileBottomNavItems,
  getMobileDrawerItems,
  isRouteActive,
  partitionNavItems,
  type NavGroupConfig,
  type NavItemConfig,
} from "~/config/navigation";
import { useHorizontalGesture } from "~/hooks/useHorizontalGesture";
import type { BusinessCapabilities } from "~/lib/api/endpoints";
import type { UserRole } from "~/lib/auth";

type Props = {
  floatingEnabled?: boolean;
  floatingOpen?: boolean;
  onCloseFloating?: () => void;
  role: UserRole;
  capabilities: BusinessCapabilities;
  isMobileOpen: boolean;
  isCollapsed: boolean;
  onOpenMobile: () => void;
  onCloseMobile: () => void;
  onOpenSearch?: () => void;
  userName?: string;
  roleLabel?: string;
};

export default function Sidebar({
  floatingEnabled = false,
  floatingOpen = false,
  onCloseFloating,
  role,
  capabilities,
  isMobileOpen,
  isCollapsed,
  onOpenMobile,
  onCloseMobile,
  onOpenSearch,
  userName = "User",
  roleLabel = "Admin",
}: Props) {
  const location = useLocation();
  const desktopRef = useRef<HTMLElement>(null);
  const floatingTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!floatingEnabled || !floatingOpen) return;
    floatingTrigger.current = document.activeElement as HTMLElement;
    const frame = requestAnimationFrame(() => desktopRef.current?.querySelector<HTMLElement>('a,button')?.focus());
    const close = () => onCloseFloating?.();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); floatingTrigger.current?.focus(); }
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!desktopRef.current?.contains(target) && !target.closest('[aria-controls="app-sidebar"],[data-nav-flyout]')) close();
    };
    const resized = () => { if (innerWidth < 1024) close(); };
    const observer = new MutationObserver(() => { if (document.querySelector('[aria-modal="true"]')) close(); });
    observer.observe(document.body, {childList:true, subtree:true});
    document.addEventListener("keydown", key); document.addEventListener("pointerdown", outside); window.addEventListener("resize", resized);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener("keydown",key); document.removeEventListener("pointerdown",outside); window.removeEventListener("resize",resized); };
  }, [floatingEnabled, floatingOpen, onCloseFloating]);


  // Desktop accordion open group
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  // Collapsed rail floating popover & tooltip state
  const [flyoutGroup, setFlyoutGroup] = useState<NavGroupConfig | null>(null);
  const [flyoutPos, setFlyoutPos] = useState<{ top: number; left: number } | null>(null);
  const [tooltip, setTooltip] = useState<{ label: string; top: number; left: number } | null>(null);

  // Mobile drawer drag & gesture state
  const drawerRef = useRef<HTMLElement>(null);
  const backdropRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [drawerProgress, setDrawerProgress] = useState<number | null>(null);
  const drawerProgressRef = useRef<number | null>(null);
  const [isDraggingDrawer, setIsDraggingDrawer] = useState(false);
  const [allowEdgeGesture, setAllowEdgeGesture] = useState(false);
  const settleTargetRef = useRef<0 | 1 | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const drawerFrameRef = useRef<number | null>(null);
  const pendingDrawerProgressRef = useRef<number | null>(null);

  // All authorized items for Desktop
  const allAuthorizedItems = useMemo(
    () => getAuthorizedNavItems(role, capabilities),
    [role, capabilities],
  );

  // Mobile bottom destinations for this role & capabilities
  const mobileBottomItems = useMemo(
    () => getMobileBottomNavItems(role, capabilities),
    [role, capabilities],
  );

  // Mobile drawer items: DYNAMICALLY FILTERED to guarantee ZERO duplication with bottom nav
  const mobileDrawerItems = useMemo(
    () => getMobileDrawerItems(role, capabilities, mobileBottomItems),
    [role, capabilities, mobileBottomItems],
  );

  // Partitioned sets for Desktop
  const desktopNav = useMemo(
    () => partitionNavItems(allAuthorizedItems),
    [allAuthorizedItems],
  );

  // Partitioned sets for Mobile Drawer
  const mobileNav = useMemo(
    () => partitionNavItems(mobileDrawerItems),
    [mobileDrawerItems],
  );

  // Auto-expand group containing current route on desktop
  useEffect(() => {
    const activeItem = allAuthorizedItems.find((item) =>
      isRouteActive(location.pathname, item.to, item.end),
    );
    if (activeItem && activeItem.group !== "quick" && activeItem.group !== "account") {
      setOpenGroup(activeItem.group);
    }
    setFlyoutGroup(null);
  }, [location.pathname, allAuthorizedItems]);

  // Sync edge gesture detection for mobile
  useEffect(() => {
    const mobileViewport = window.matchMedia("(max-width: 1023px)");
    const syncEdgeGesture = () => setAllowEdgeGesture(mobileViewport.matches);
    syncEdgeGesture();
    mobileViewport.addEventListener("change", syncEdgeGesture);
    return () => mobileViewport.removeEventListener("change", syncEdgeGesture);
  }, []);

  // Cleanup timers & animation frames on unmount
  useEffect(
    () => () => {
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
      if (drawerFrameRef.current !== null) window.cancelAnimationFrame(drawerFrameRef.current);
    },
    [],
  );

  // Close flyout on desktop resize or scroll
  useEffect(() => {
    function handleGlobalClick(event: MouseEvent) {
      if (flyoutGroup) {
        const target = event.target as HTMLElement;
        if (!target.closest("[data-nav-flyout]") && !target.closest("[data-group-toggle]")) {
          setFlyoutGroup(null);
        }
      }
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setFlyoutGroup(null);
        setTooltip(null);
      }
    }
    window.addEventListener("click", handleGlobalClick);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("click", handleGlobalClick);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [flyoutGroup]);

  // Mobile drawer animation painting
  function paintDrawerProgress(progress: number) {
    if (drawerRef.current) {
      drawerRef.current.style.transform = `translate3d(${(progress - 1) * 100}%, 0, 0)`;
    }
    if (backdropRef.current) backdropRef.current.style.opacity = String(progress);
  }

  function settleDrawer(target: 0 | 1) {
    if (drawerFrameRef.current !== null) {
      window.cancelAnimationFrame(drawerFrameRef.current);
      drawerFrameRef.current = null;
    }
    paintDrawerProgress(drawerProgressRef.current ?? target);
    pendingDrawerProgressRef.current = null;
    setIsDraggingDrawer(false);
    drawerProgressRef.current = target;
    setDrawerProgress(target);
    if (target === 1) onOpenMobile();
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      if (target === 0) onCloseMobile();
      drawerProgressRef.current = null;
      setDrawerProgress(null);
      settleTargetRef.current = null;
      settleTimerRef.current = null;
    }, 260);
  }

  function updateDrawerProgress(progress: number) {
    const boundedProgress = Math.max(0, Math.min(1, progress));
    drawerProgressRef.current = boundedProgress;
    pendingDrawerProgressRef.current = boundedProgress;
    if (drawerFrameRef.current !== null) return;
    drawerFrameRef.current = window.requestAnimationFrame(() => {
      drawerFrameRef.current = null;
      const pendingProgress = pendingDrawerProgressRef.current;
      if (pendingProgress !== null) paintDrawerProgress(pendingProgress);
    });
  }

  function beginDrawerDrag(progress: 0 | 1) {
    settleTargetRef.current = null;
    drawerProgressRef.current = progress;
    setDrawerProgress(progress);
    setIsDraggingDrawer(true);
    paintDrawerProgress(progress);
  }

  const closeDrawerGesture = useHorizontalGesture<HTMLElement>({
    enabled: isMobileOpen,
    allowMouse: true,
    onStart: () => beginDrawerDrag(1),
    onMove: (offsetX) => {
      const width = Math.min(window.innerWidth * 0.84, 312);
      updateDrawerProgress(1 + offsetX / width);
    },
    onSwipeLeft: () => {
      settleTargetRef.current = 0;
    },
    onSwipeRight: () => {
      settleTargetRef.current = 1;
    },
    onEnd: () =>
      settleDrawer(
        settleTargetRef.current ?? ((drawerProgressRef.current ?? 1) >= 0.5 ? 1 : 0),
      ),
  });

  const openDrawerGesture = useHorizontalGesture<HTMLDivElement>({
    enabled: !isMobileOpen && allowEdgeGesture,
    threshold: 42,
    edgeGuard: 14,
    allowMouse: true,
    ignoreInteractive: false,
    onStart: () => beginDrawerDrag(0),
    onMove: (offsetX) => {
      const width = Math.min(window.innerWidth * 0.84, 312);
      updateDrawerProgress(offsetX / width);
    },
    onSwipeRight: () => {
      settleTargetRef.current = 1;
    },
    onSwipeLeft: () => {
      settleTargetRef.current = 0;
    },
    onEnd: () =>
      settleDrawer(
        settleTargetRef.current ?? ((drawerProgressRef.current ?? 0) >= 0.5 ? 1 : 0),
      ),
  });

  const effectiveDrawerProgress = drawerProgress ?? (isMobileOpen ? 1 : 0);
  const drawerIsVisible = effectiveDrawerProgress > 0 || isDraggingDrawer;

  // Focus trapping when mobile drawer is open
  useEffect(() => {
    if (!isMobileOpen) return undefined;

    returnFocusRef.current = document.activeElement as HTMLElement | null;
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());

    function keepFocusInDrawer(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseMobile();
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) return;

      const focusable = Array.from(
        drawerRef.current.querySelectorAll<HTMLElement>(
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
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", keepFocusInDrawer);
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    };
  }, [isMobileOpen, onCloseMobile]);

  // Show tooltip on hovering collapsed rail item
  function handleMouseEnterItem(event: React.MouseEvent, label: string) {
    if (!isCollapsed || window.innerWidth < 1024) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setTooltip({
      label,
      top: rect.top + rect.height / 2,
      left: rect.right + 12,
    });
  }

  function handleMouseLeaveItem() {
    setTooltip(null);
  }

  // Toggle group accordion (or open flyout on collapsed rail)
  function handleToggleDesktopGroup(group: NavGroupConfig, event: React.MouseEvent) {
    if (isCollapsed) {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      if (flyoutGroup?.id === group.id) {
        setFlyoutGroup(null);
      } else {
        setFlyoutGroup(group);
        setFlyoutPos({
          top: Math.min(rect.top, Math.max(12, window.innerHeight - 260)),
          left: rect.right + 10,
        });
      }
      return;
    }

    setOpenGroup((current) => (current === group.id ? null : group.id));
  }

  const { style: openDrawerGestureStyle, ...openDrawerGestureProps } = openDrawerGesture;

  const initials =
    userName
      .split(" ")
      .map((n) => n[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "JD";

  return (
    <>
      {/* ─────────────────────────────────────────────────────────────
          1. DESKTOP SIDEBAR (Visible only on lg: >=1024px)
          ───────────────────────────────────────────────────────────── */}
      <aside
        ref={desktopRef}
        id="app-sidebar"
        data-floating-sidebar={floatingEnabled ? String(floatingOpen) : undefined}
        aria-label="Primary desktop sidebar"
        className={[
          "fixed inset-y-0 left-0 hidden flex-col border-r border-[#D8DDE5] bg-white transition-[width] duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] lg:flex",
          isCollapsed ? "lg:w-[80px]" : "lg:w-[260px]",
          floatingEnabled && floatingOpen ? "z-[80] shadow-xl" : "z-[50]",
          floatingEnabled ? "motion-reduce:transition-none" : "",
        ].join(" ")}
      >
        {/* Desktop Brand Area */}
        <div
          className={[
            "flex h-[70px] shrink-0 items-center border-b border-[#D8DDE5]",
            isCollapsed ? "justify-center px-2" : "px-4.5",
          ].join(" ")}
        >
          <BrandLogo
            variant={isCollapsed ? "icon" : "full"}
            className={
              isCollapsed
                ? "h-10 w-10 border border-slate-200 rounded-[12px] bg-white p-1 shadow-2xs"
                : "h-10 w-[172px]"
            }
          />
          {floatingEnabled && floatingOpen && <button type="button" aria-label="Close floating navigation" onClick={() => {onCloseFloating?.();floatingTrigger.current?.focus();}} className="absolute right-2 top-5 flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"><GIcon name="close" sizePx={18}/></button>}
        </div>

        {/* Desktop Scrollable Body */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden p-3 [scrollbar-width:thin]">
          {/* Desktop Search Trigger */}
          {onOpenSearch ? (
            <div className="mb-2.5">
              <button
                type="button"
                onClick={onOpenSearch}
                onMouseEnter={(e) => handleMouseEnterItem(e, "Find a page (Ctrl K)")}
                onMouseLeave={handleMouseLeaveItem}
                title={isCollapsed ? "Find a page (Ctrl K)" : undefined}
                aria-label="Find a page"
                className={[
                  "flex items-center rounded-[11px] border border-slate-200/90 bg-slate-50/80 text-slate-500 transition-colors hover:border-slate-300 hover:bg-slate-100 hover:text-slate-900",
                  isCollapsed
                    ? "mx-auto h-10 w-10 justify-center p-0"
                    : "h-10.5 w-full justify-between px-3 text-[13px] font-medium",
                ].join(" ")}
              >
                <div className="flex items-center gap-2.5">
                  <GIcon name="search" sizePx={19} className="text-slate-400" />
                  {!isCollapsed ? <span>Find a page...</span> : null}
                </div>
                {!isCollapsed ? (
                  <span className="rounded-[5px] bg-slate-200/80 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">
                    Ctrl K
                  </span>
                ) : null}
              </button>
            </div>
          ) : null}

          {/* Quick Access Section */}
          {desktopNav.quick.length > 0 ? (
            <div className="flex flex-col gap-1">
              {!isCollapsed ? (
                <div className="px-3.5 pb-1.5 pt-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  Quick Access
                </div>
              ) : (
                <div className="my-1.5 h-px bg-slate-100" />
              )}
              {desktopNav.quick.map((item) => {
                const active = isRouteActive(location.pathname, item.to, item.end);
                return (
                  <NavLink
                    key={item.id}
                    to={item.to}
                    end={item.end}
                    onMouseEnter={(e) => handleMouseEnterItem(e, item.label)}
                    onMouseLeave={handleMouseLeaveItem}
                    title={isCollapsed ? item.label : undefined}
                    aria-label={isCollapsed ? item.label : undefined}
                    aria-current={active ? "page" : undefined}
                    className={[
                      "group relative flex items-center rounded-[11px] text-[13.5px] font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900",
                      isCollapsed
                        ? "mx-auto h-10 w-10 justify-center px-0"
                        : "h-10.5 gap-3.5 px-3.5",
                      active
                        ? "bg-[#11120D] font-bold text-white shadow-xs"
                        : "text-[#334155] hover:bg-[#F3F5F8] hover:text-slate-950",
                    ].join(" ")}
                  >
                    <div className="flex shrink-0 items-center justify-center">
                      <GIcon
                        name={item.icon}
                        sizePx={20}
                        className={active ? "text-white" : "text-slate-500 group-hover:text-slate-800"}
                      />
                    </div>
                    {!isCollapsed ? <span className="truncate">{item.label}</span> : null}
                  </NavLink>
                );
              })}
            </div>
          ) : null}

          {/* Workspaces Section */}
          {desktopNav.groups.length > 0 ? (
            <div className="mt-2.5 flex flex-col gap-1">
              <div className="my-2 h-px bg-slate-200" />
              {!isCollapsed ? (
                <div className="px-3.5 pb-1.5 pt-1 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  Workspaces
                </div>
              ) : null}
              {desktopNav.groups.map((group) => {
                const isGroupOpen = openGroup === group.id;
                const hasActiveChild = group.items.some((item) =>
                  isRouteActive(location.pathname, item.to, item.end),
                );

                return (
                  <div key={group.id} className="flex flex-col">
                    <button
                      type="button"
                      data-group-toggle={group.id}
                      aria-expanded={isCollapsed ? false : isGroupOpen}
                      onClick={(e) => handleToggleDesktopGroup(group, e)}
                      onMouseEnter={(e) => handleMouseEnterItem(e, group.name)}
                      onMouseLeave={handleMouseLeaveItem}
                      className={[
                        "relative flex items-center rounded-[11px] text-[13.5px] font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900",
                        isCollapsed
                          ? "mx-auto h-10 w-10 justify-center px-0 text-slate-600 hover:bg-[#F3F5F8]"
                          : "h-10.5 w-full justify-between px-3.5 text-[#334155] hover:bg-[#F3F5F8] hover:text-slate-950",
                        hasActiveChild && !isGroupOpen && !isCollapsed ? "text-slate-950 font-bold" : "",
                      ].join(" ")}
                    >
                      <div className="flex items-center gap-3.5 truncate">
                        <GIcon
                          name={group.icon}
                          sizePx={20}
                          className={hasActiveChild ? "text-slate-900" : "text-slate-500"}
                        />
                        {!isCollapsed ? <span className="truncate">{group.name}</span> : null}
                      </div>
                      {!isCollapsed ? (
                        <GIcon
                          name="chevron_right"
                          sizePx={16}
                          className={[
                            "shrink-0 text-slate-400 transition-transform duration-200",
                            isGroupOpen ? "rotate-90" : "rotate-0",
                          ].join(" ")}
                        />
                      ) : null}
                    </button>

                    {!isCollapsed ? (
                      <div
                        className="grid transition-[grid-template-rows,opacity] duration-200 ease-out"
                        style={{
                          gridTemplateRows: isGroupOpen ? "1fr" : "0fr",
                          opacity: isGroupOpen ? 1 : 0,
                        }}
                      >
                        <div className="min-h-0 overflow-hidden" inert={!isGroupOpen ? true : undefined}>
                          <div className="ml-4 mt-1 flex flex-col gap-1 border-l-2 border-slate-200 py-1 pl-2.5">
                            {group.items.map((item) => {
                              const active = isRouteActive(location.pathname, item.to, item.end);
                              return (
                                <NavLink
                                  key={item.id}
                                  to={item.to}
                                  end={item.end}
                                  className={[
                                    "flex h-9 items-center gap-2.5 rounded-[9px] px-2.5 text-[13px] font-semibold transition-colors",
                                    active
                                      ? "bg-slate-900 font-bold text-white shadow-xs"
                                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                                  ].join(" ")}
                                >
                                  <GIcon
                                    name={item.icon}
                                    sizePx={18}
                                    className={active ? "text-white" : "text-slate-400"}
                                  />
                                  <span className="truncate">{item.label}</span>
                                </NavLink>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        {/* Desktop Footer (Account Compartment) */}
        <div className="shrink-0 border-t border-[#D8DDE5] bg-white p-3">
          {desktopNav.account
            .filter((item) => item.id.startsWith("profile"))
            .map((item) => (
              <NavLink
                key={item.id}
                to={item.to}
                onMouseEnter={(e) => handleMouseEnterItem(e, `${userName} (${roleLabel})`)}
                onMouseLeave={handleMouseLeaveItem}
                className={[
                  "flex items-center rounded-[11px] text-left transition-colors hover:bg-slate-100",
                  isCollapsed ? "mx-auto h-10 w-10 justify-center p-0" : "h-12 w-full gap-3 px-2.5",
                ].join(" ")}
              >
                <div className="flex h-8.5 w-8.5 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-slate-100 text-[11.5px] font-bold text-slate-700">
                  {initials}
                </div>
                {!isCollapsed ? (
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-bold text-slate-900 leading-tight">
                      {userName}
                    </div>
                    <div className="truncate text-[10.5px] font-semibold uppercase tracking-wider text-slate-400 mt-0.5">
                      {roleLabel}
                    </div>
                  </div>
                ) : null}
              </NavLink>
            ))}

          {desktopNav.account
            .filter((item) => item.danger)
            .map((item) => (
              <NavLink
                key={item.id}
                to={item.to}
                onMouseEnter={(e) => handleMouseEnterItem(e, "Logout")}
                onMouseLeave={handleMouseLeaveItem}
                className={[
                  "mt-1.5 flex items-center rounded-[10px] text-[12.5px] font-bold text-rose-600 transition-colors hover:bg-rose-50 hover:text-rose-700",
                  isCollapsed ? "mx-auto h-9 w-10 justify-center p-0" : "h-9.5 w-full gap-2.5 px-3",
                ].join(" ")}
              >
                <GIcon name="logout" sizePx={18} className="text-rose-500" />
                {!isCollapsed ? <span>Logout</span> : null}
              </NavLink>
            ))}
        </div>
      </aside>

      {/* Floating Flyout Popover on Collapsed Desktop Rail Click */}
      {isCollapsed && flyoutGroup && flyoutPos ? (
        <div
          data-nav-flyout
          className="fixed z-[100] min-w-[220px] rounded-[14px] border border-[#D8DDE5] bg-white p-2.5 shadow-2xl animate-in fade-in-0 zoom-in-95 duration-150"
          style={{ top: `${flyoutPos.top}px`, left: `${flyoutPos.left}px` }}
        >
          <div className="mb-1 border-b border-slate-100 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
            {flyoutGroup.name}
          </div>
          <div className="flex flex-col gap-1">
            {flyoutGroup.items.map((item) => {
              const active = isRouteActive(location.pathname, item.to, item.end);
              return (
                <NavLink
                  key={item.id}
                  to={item.to}
                  end={item.end}
                  onClick={() => setFlyoutGroup(null)}
                  className={[
                    "flex h-9 items-center gap-2.5 rounded-[9px] px-3 text-[13px] font-semibold transition-colors",
                    active
                      ? "bg-slate-900 font-bold text-white shadow-xs"
                      : "text-slate-700 hover:bg-slate-50 hover:text-slate-900",
                  ].join(" ")}
                >
                  <GIcon
                    name={item.icon}
                    sizePx={18}
                    className={active ? "text-white" : "text-slate-500"}
                  />
                  <span>{item.label}</span>
                </NavLink>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Floating Hover Tooltip on Collapsed Desktop Rail */}
      {isCollapsed && tooltip ? (
        <div
          className="fixed z-[110] -translate-y-1/2 rounded-[7px] bg-[#11120D] px-2.5 py-1.5 text-[11.5px] font-semibold text-white shadow-xl pointer-events-none"
          style={{ top: `${tooltip.top}px`, left: `${tooltip.left}px` }}
        >
          {tooltip.label}
        </div>
      ) : null}

      {/* ─────────────────────────────────────────────────────────────
          2. MOBILE SECONDARY DRAWER (Visible only on lg: <1024px)
          ───────────────────────────────────────────────────────────── */}
      {/* Mobile Backdrop */}
      <button
        ref={backdropRef}
        type="button"
        onClick={onCloseMobile}
        className={[
          "fixed inset-0 z-[80] bg-slate-950/50 backdrop-blur-[2px] lg:hidden",
          isDraggingDrawer ? "transition-none" : "transition-opacity duration-260",
          drawerIsVisible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
        ].join(" ")}
        aria-label="Close navigation drawer"
        tabIndex={isMobileOpen ? 0 : -1}
        style={{ opacity: effectiveDrawerProgress }}
      />

      {/* Left Edge Gesture Sensor for Mobile Open Swipe */}
      {!isMobileOpen && allowEdgeGesture ? (
        <div
          aria-hidden="true"
          className="fixed bottom-0 left-0 top-[68px] z-[40] w-3 touch-pan-y pointer-events-auto lg:hidden"
          style={{ ...openDrawerGestureStyle, overscrollBehaviorX: "none" }}
          {...openDrawerGestureProps}
        />
      ) : null}

      {/* Mobile Drawer Aside */}
      <aside
        ref={drawerRef}
        id="mobile-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Mobile navigation"
        inert={!drawerIsVisible ? true : undefined}
        className={[
          "fixed inset-y-0 left-0 z-[90] flex w-[min(84vw,312px)] flex-col border-r border-[#D8DDE5] bg-white transition-transform duration-260 ease-[cubic-bezier(0.22,1,0.36,1)] lg:hidden",
          drawerProgress === null
            ? isMobileOpen
              ? "translate-x-0"
              : "-translate-x-full"
            : "",
          isDraggingDrawer ? "transition-none" : "",
        ].join(" ")}
        {...closeDrawerGesture}
        style={{
          ...closeDrawerGesture.style,
          ...(drawerProgress !== null
            ? { transform: `translate3d(${(effectiveDrawerProgress - 1) * 100}%, 0, 0)` }
            : {}),
        }}
      >
        {/* Drawer Header with Full Brand and Close Button */}
        <div className="flex h-[70px] shrink-0 items-center justify-between border-b border-[#D8DDE5] px-4.5">
          <BrandLogo variant="full" className="h-10 w-[168px]" />
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onCloseMobile}
            className="flex h-10 w-10 items-center justify-center rounded-[11px] border border-slate-200 text-slate-500 hover:bg-slate-100 hover:text-slate-900 active:scale-95"
            aria-label="Close navigation drawer"
          >
            <GIcon name="close" sizePx={20} />
          </button>
        </div>

        {/* Drawer Scrollable Body (DEDUPLICATED) */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden p-3.5 [scrollbar-width:thin]">
          {/* Quick Access in Drawer (only items not in bottom bar) */}
          {mobileNav.quick.length > 0 ? (
            <div className="flex flex-col gap-1">
              <div className="px-3.5 pb-1.5 pt-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Quick Access
              </div>
              {mobileNav.quick.map((item) => {
                const active = isRouteActive(location.pathname, item.to, item.end);
                return (
                  <NavLink
                    key={item.id}
                    to={item.to}
                    end={item.end}
                    onClick={onCloseMobile}
                    aria-current={active ? "page" : undefined}
                    className={[
                      "group relative flex h-[46px] min-h-[44px] items-center gap-3.5 rounded-[12px] px-3.5 text-[14.5px] font-semibold transition-all",
                      active
                        ? "bg-[#11120D] font-bold text-white shadow-xs"
                        : "text-[#334155] hover:bg-[#F3F5F8] hover:text-slate-950",
                    ].join(" ")}
                  >
                    <GIcon
                      name={item.icon}
                      sizePx={21}
                      className={active ? "text-white" : "text-slate-500"}
                    />
                    <span className="truncate">{item.label}</span>
                  </NavLink>
                );
              })}
            </div>
          ) : null}

          {/* Workspaces in Drawer (only items not in bottom bar) */}
          {mobileNav.groups.length > 0 ? (
            <div className="mt-2 flex flex-col gap-1">
              {mobileNav.quick.length > 0 ? <div className="my-2 h-px bg-slate-200" /> : null}
              <div className="px-3.5 pb-1.5 pt-1 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Workspaces
              </div>
              {mobileNav.groups.map((group) => {
                const isGroupOpen = openGroup === group.id;
                const hasActiveChild = group.items.some((item) =>
                  isRouteActive(location.pathname, item.to, item.end),
                );

                return (
                  <div key={group.id} className="flex flex-col">
                    <button
                      type="button"
                      data-group-toggle={group.id}
                      aria-expanded={isGroupOpen}
                      onClick={() =>
                        setOpenGroup((current) => (current === group.id ? null : group.id))
                      }
                      className={[
                        "flex h-[46px] min-h-[44px] w-full items-center justify-between rounded-[12px] px-3.5 text-[14.5px] font-semibold text-[#334155] transition-all hover:bg-[#F3F5F8]",
                        hasActiveChild && !isGroupOpen ? "text-slate-950 font-bold" : "",
                      ].join(" ")}
                    >
                      <div className="flex items-center gap-3.5 truncate">
                        <GIcon
                          name={group.icon}
                          sizePx={21}
                          className={hasActiveChild ? "text-slate-900" : "text-slate-500"}
                        />
                        <span className="truncate">{group.name}</span>
                      </div>
                      <GIcon
                        name="chevron_right"
                        sizePx={18}
                        className={[
                          "shrink-0 text-slate-400 transition-transform duration-200",
                          isGroupOpen ? "rotate-90" : "rotate-0",
                        ].join(" ")}
                      />
                    </button>

                    <div
                      className="grid transition-[grid-template-rows,opacity] duration-200 ease-out"
                      style={{
                        gridTemplateRows: isGroupOpen ? "1fr" : "0fr",
                        opacity: isGroupOpen ? 1 : 0,
                      }}
                    >
                      <div className="min-h-0 overflow-hidden" inert={!isGroupOpen ? true : undefined}>
                        <div className="ml-4.5 mt-1 flex flex-col gap-1 border-l-2 border-slate-200 py-1 pl-3">
                          {group.items.map((item) => {
                            const active = isRouteActive(location.pathname, item.to, item.end);
                            return (
                              <NavLink
                                key={item.id}
                                to={item.to}
                                end={item.end}
                                onClick={onCloseMobile}
                                aria-current={active ? "page" : undefined}
                                className={[
                                  "flex h-[42px] min-h-[40px] items-center gap-3 rounded-[10px] px-3 text-[14px] font-semibold transition-colors",
                                  active
                                    ? "bg-slate-900 font-bold text-white shadow-xs"
                                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                                ].join(" ")}
                              >
                                <GIcon
                                  name={item.icon}
                                  sizePx={19}
                                  className={active ? "text-white" : "text-slate-400"}
                                />
                                <span className="truncate">{item.label}</span>
                              </NavLink>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        {/* Drawer Footer with Profile (if not in bottom bar) & Logout */}
        <div className="shrink-0 border-t border-[#D8DDE5] bg-white p-3.5 pb-[max(14px,env(safe-area-inset-bottom))]">
          {mobileNav.account
            .filter((item) => item.id.startsWith("profile"))
            .map((item) => (
              <NavLink
                key={item.id}
                to={item.to}
                onClick={onCloseMobile}
                className="flex h-12 w-full items-center gap-3 rounded-[12px] px-2.5 text-left transition-colors hover:bg-slate-100"
              >
                <div className="flex h-8.5 w-8.5 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-slate-100 text-[11.5px] font-bold text-slate-700">
                  {initials}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-bold text-slate-900 leading-tight">
                    {userName}
                  </div>
                  <div className="truncate text-[10.5px] font-semibold uppercase tracking-wider text-slate-400 mt-0.5">
                    {roleLabel}
                  </div>
                </div>
              </NavLink>
            ))}

          {/* Logout is always displayed in mobile drawer footer */}
          <NavLink
            to="/logout"
            onClick={onCloseMobile}
            className="mt-1.5 flex h-[42px] min-h-[40px] w-full items-center gap-3 rounded-[11px] px-3 text-[13px] font-bold text-rose-600 transition-colors hover:bg-rose-50 hover:text-rose-700"
          >
            <GIcon name="logout" sizePx={19} className="text-rose-500" />
            <span>Logout</span>
          </NavLink>
        </div>
      </aside>
    </>
  );
}
