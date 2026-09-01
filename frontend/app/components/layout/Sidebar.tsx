import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router";
import BrandLogo from "~/components/ui/BrandLogo";
import GIcon from "~/components/ui/GIcon";
import navData from "~/config/ui.nav.json";
import type { UserRole } from "~/lib/auth";
import type { BusinessCapabilities } from "~/lib/api/endpoints";
import { hasCapabilityRouteAccess } from "~/lib/routeAccess";
import { useHorizontalGesture } from "~/hooks/useHorizontalGesture";

type Props = {
  role: UserRole;
  capabilities: BusinessCapabilities;
  isMobileOpen: boolean;
  isCollapsed: boolean;
  mobileEnabled?: boolean;
  onOpenMobile: () => void;
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
  capabilities,
  isMobileOpen,
  isCollapsed,
  mobileEnabled = true,
  onOpenMobile,
  onCloseMobile,
}: Props) {
  const sidebarRef = useRef<HTMLElement>(null);
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
  const items = navData.sidebar.items.filter(
    (item) =>
      item.roles.includes(role) &&
      hasCapabilityRouteAccess(item.to, capabilities),
  );
  const mainItems = items.filter((item) => item.section !== "bottom");
  const bottomItems = items.filter((item) => item.section === "bottom");
  const sectionLabel = role === "staff" ? "STAFF MENU" : navData.sidebar.mainLabel;

  useEffect(() => {
    const mobileViewport = window.matchMedia("(max-width: 1023px)");
    const syncEdgeGesture = () => setAllowEdgeGesture(mobileEnabled && mobileViewport.matches);
    syncEdgeGesture();
    mobileViewport.addEventListener("change", syncEdgeGesture);
    return () => mobileViewport.removeEventListener("change", syncEdgeGesture);
  }, [mobileEnabled]);

  useEffect(() => () => {
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    if (drawerFrameRef.current !== null) window.cancelAnimationFrame(drawerFrameRef.current);
  }, []);

  function paintDrawerProgress(progress: number) {
    if (sidebarRef.current) {
      sidebarRef.current.style.transform = `translate3d(${(progress - 1) * 100}%, 0, 0)`;
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
    enabled: mobileEnabled && isMobileOpen,
    allowMouse: true,
    onStart: () => {
      beginDrawerDrag(1);
    },
    onMove: (offsetX) => {
      const width = Math.min(window.innerWidth * 0.8, 288);
      updateDrawerProgress(1 + offsetX / width);
    },
    onSwipeLeft: () => { settleTargetRef.current = 0; },
    onSwipeRight: () => { settleTargetRef.current = 1; },
    onEnd: () => settleDrawer(
      settleTargetRef.current ?? ((drawerProgressRef.current ?? 1) >= 0.5 ? 1 : 0),
    ),
  });

  const openDrawerGesture = useHorizontalGesture<HTMLDivElement>({
    enabled: mobileEnabled && !isMobileOpen && allowEdgeGesture,
    threshold: 42,
    edgeGuard: 14,
    allowMouse: true,
    ignoreInteractive: false,
    onStart: () => {
      beginDrawerDrag(0);
    },
    onMove: (offsetX) => {
      const width = Math.min(window.innerWidth * 0.8, 288);
      updateDrawerProgress(offsetX / width);
    },
    onSwipeRight: () => { settleTargetRef.current = 1; },
    onSwipeLeft: () => { settleTargetRef.current = 0; },
    onEnd: () => settleDrawer(
      settleTargetRef.current ?? ((drawerProgressRef.current ?? 0) >= 0.5 ? 1 : 0),
    ),
  });
  const {
    style: openDrawerGestureStyle,
    ...openDrawerGestureProps
  } = openDrawerGesture;

  const effectiveDrawerProgress = drawerProgress ?? (isMobileOpen ? 1 : 0);
  const drawerIsVisible = effectiveDrawerProgress > 0 || isDraggingDrawer;

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
        ref={backdropRef}
        type="button"
        onClick={onCloseMobile}
        className={[
          "fixed inset-0 z-[80] bg-slate-950/45 lg:hidden",
          isDraggingDrawer ? "transition-none" : "transition-opacity duration-200",
          mobileEnabled && drawerIsVisible
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0",
        ].join(" ")}
        aria-label="Close navigation drawer"
        tabIndex={isMobileOpen ? 0 : -1}
        style={{ opacity: effectiveDrawerProgress }}
      />

      {mobileEnabled && !isMobileOpen && allowEdgeGesture ? (
        <div
          aria-hidden="true"
          className="fixed bottom-0 left-0 top-[68px] z-[100] w-9 touch-pan-y lg:hidden"
          style={{ ...openDrawerGestureStyle, overscrollBehaviorX: "none" }}
          {...openDrawerGestureProps}
        />
      ) : null}

      <aside
        ref={sidebarRef}
        id="app-sidebar"
        aria-label="Primary navigation"
        className={[
          "fixed inset-y-0 left-0 z-[90] flex w-[min(80vw,288px)] flex-col border-r border-[#CFCFD3] bg-white transition-[width,transform] duration-200 ease-out lg:z-[40]",
          isCollapsed ? "lg:w-[80px]" : "lg:w-[260px]",
          drawerProgress === null
            ? mobileEnabled && isMobileOpen
              ? "translate-x-0"
              : "-translate-x-full"
            : "",
          "lg:translate-x-0",
          isDraggingDrawer
            ? "transition-none"
            : "duration-[260ms] ease-[cubic-bezier(0.22,0.8,0.24,1)]",
        ].join(" ")}
        {...closeDrawerGesture}
        style={{
          ...closeDrawerGesture.style,
          ...(drawerProgress !== null
            ? {
                transform: `translate3d(${(effectiveDrawerProgress - 1) * 100}%, 0, 0)`,
              }
            : {}),
        }}
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
