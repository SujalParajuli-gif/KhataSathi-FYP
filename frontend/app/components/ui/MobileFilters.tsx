import React, { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import GoogleIcon from "~/components/ui/GIcon";
import { useBodyScrollLock } from "~/hooks/useBodyScrollLock";

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export type MobileFilterChip = {
  id: string;
  label: ReactNode;
  onRemove: () => void;
};

export function MobileFilterButton({
  activeCount,
  onClick,
  className,
  label = "Filter",
}: {
  activeCount: number;
  onClick: () => void;
  className?: string;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative inline-flex h-[42px] shrink-0 items-center justify-center gap-1.5 rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-extrabold text-[#11120d] transition-colors hover:border-[#11120d] active:bg-slate-50",
        className,
      )}
      aria-label={`Open ${label.toLowerCase()}${activeCount ? `, ${activeCount} active` : ""}`}
    >
      <GoogleIcon name="filter_alt" className="text-[17px] text-[#565449]" />
      <span>{label}</span>
      <span
        className={cn(
          "inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1.5 text-[10px] font-extrabold text-white",
          activeCount ? "bg-[#179B4D]" : "bg-[#565449]",
        )}
      >
        {activeCount}
      </span>
    </button>
  );
}

export function ActiveFilterChips({
  items,
  className,
}: {
  items: MobileFilterChip[];
  className?: string;
}) {
  if (items.length === 0) return null;

  return (
    <div
      className={cn(
        "flex max-w-full gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
      aria-label="Active filters"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={item.onRemove}
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 text-[12px] font-bold text-emerald-800 transition-colors hover:bg-emerald-100"
          aria-label={`Remove filter: ${typeof item.label === "string" ? item.label : item.id}`}
        >
          <span>{item.label}</span>
          <GoogleIcon name="close" className="text-[16px]" />
        </button>
      ))}
    </div>
  );
}

export type MobileFilterTab<T extends string> = {
  value: T;
  label: ReactNode;
  count?: number;
};

export function MobileFilterTabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel = "Filters",
  className,
}: {
  items: Array<MobileFilterTab<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  const tabListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const activeTab = tabListRef.current?.querySelector<HTMLElement>(
      `[data-mobile-tab-value="${CSS.escape(value)}"]`,
    );
    activeTab?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "nearest",
      inline: "center",
    });
  }, [value]);

  return (
    <div
      ref={tabListRef}
      role="group"
      aria-label={ariaLabel}
      data-horizontal-scroll
      className={cn(
        "flex max-w-full gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            aria-pressed={selected}
            data-mobile-tab-value={item.value}
            onClick={() => onChange(item.value)}
            className={cn(
              "inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl border px-4 text-[13px] font-bold transition-colors",
              selected
                ? "border-[#11120d] bg-[#11120d] text-white"
                : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
            )}
          >
            <span>{item.label}</span>
            {item.count !== undefined ? (
              <span className={cn("text-[11px]", selected ? "text-white/75" : "text-slate-400")}>
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function MobileFilterSheet({
  open,
  onClose,
  onClear,
  onApply,
  children,
  title = "Filters",
  clearLabel = "Clear",
  applyLabel = "Apply",
  applyDisabled = false,
  footerMessage,
}: {
  open: boolean;
  onClose: () => void;
  onClear: () => void;
  onApply: () => void;
  children: ReactNode;
  title?: string;
  clearLabel?: string;
  applyLabel?: string;
  applyDisabled?: boolean;
  footerMessage?: ReactNode;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useBodyScrollLock(open);

  useEffect(() => {
    if (!open) return undefined;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());

    const focusableSelector = [
      "button:not([disabled])",
      "input:not([disabled]):not([type='hidden'])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "a[href]",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab" || !sheetRef.current) return;

      const controls = Array.from(
        sheetRef.current.querySelectorAll<HTMLElement>(focusableSelector),
      ).filter((element) => element.offsetParent !== null);

      if (controls.length === 0) {
        event.preventDefault();
        sheetRef.current.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown);
      window.requestAnimationFrame(() => restoreFocusRef.current?.focus());
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[130] lg:hidden">
      <button
        type="button"
        className="absolute inset-0 bg-slate-950/50"
        aria-label={`Close ${title.toLowerCase()}`}
        onClick={onClose}
      />
      <section
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 flex max-h-[88dvh] flex-col overflow-hidden rounded-t-[26px] bg-white shadow-2xl outline-none"
      >
        <div className="shrink-0 px-4 pt-3">
          <div className="mx-auto h-1.5 w-14 rounded-full bg-slate-300" />
          <div className="mt-2 grid min-h-12 grid-cols-[44px_1fr_44px] items-center border-b border-slate-100">
            <span aria-hidden="true" />
            <h2 className="text-center text-[21px] font-extrabold text-[#11120d]">{title}</h2>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              className="inline-flex h-11 w-11 items-center justify-center rounded-full text-[#11120d] transition-colors hover:bg-slate-100"
              aria-label={`Close ${title.toLowerCase()}`}
            >
              <GoogleIcon name="close" className="text-[25px]" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4 pb-5">
          {children}
        </div>

        <div className="shrink-0 border-t border-slate-200 bg-white px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] shadow-[0_-8px_20px_rgba(15,23,42,0.06)]">
          {footerMessage ? <div className="mb-2 text-[12px] font-semibold text-rose-600">{footerMessage}</div> : null}
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={onClear}
              className="h-[50px] rounded-xl border border-red-600 bg-white text-[14px] font-bold text-red-600 transition-colors hover:bg-red-50"
            >
              {clearLabel}
            </button>
            <button
              type="button"
              onClick={onApply}
              disabled={applyDisabled}
              className="h-[50px] rounded-xl bg-[#11120d] text-[14px] font-bold text-white transition-colors hover:bg-[#292a25] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {applyLabel}
            </button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
