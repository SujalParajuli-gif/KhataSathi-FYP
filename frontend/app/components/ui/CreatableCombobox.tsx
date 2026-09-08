import React, { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

function normalize(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export default function CreatableCombobox({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  allowCreate = true,
  required = false,
  invalid = false,
  inputRef: externalInputRef,
  selectOnFocus = false,
  createHelpText,
  compact = false,
  showCreateHelp = true,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  ariaLabel: string;
  allowCreate?: boolean;
  required?: boolean;
  invalid?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
  selectOnFocus?: boolean;
  createHelpText?: string;
  compact?: boolean;
  showCreateHelp?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [inputValue, setInputValue] = useState(value);
  const [searchTerm, setSearchTerm] = useState("");
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});

  const rootRef = useRef<HTMLDivElement>(null);
  const internalInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const justSelectedRef = useRef(false);

  const listId = useId();
  const helpId = useId();
  const normalizedValue = normalize(value);
  const normalizedSearch = normalize(searchTerm);
  const uniqueOptions = useMemo(
    () => [...new Set(options.map(normalize).filter(Boolean))],
    [options],
  );
  const matches = normalizedSearch
    ? uniqueOptions
        .filter((option) =>
          option.toLocaleLowerCase().includes(normalizedSearch.toLocaleLowerCase()),
        )
        .slice(0, 10)
    : uniqueOptions.slice(0, 50);
  const exactMatch = uniqueOptions.some(
    (option) =>
      option.toLocaleLowerCase() === (normalizedSearch || normalizedValue).toLocaleLowerCase(),
  );
  const choices = [
    ...matches.map((label) => ({ label, created: false })),
    ...(allowCreate && normalizedSearch && !exactMatch
      ? [{ label: normalizedSearch, created: true }]
      : []),
  ];

  function positionMenu() {
    const input = rootRef.current?.querySelector("input");
    if (!input || typeof window === "undefined") return;
    const rect = input.getBoundingClientRect();
    const viewportPadding = 12;
    const mobileViewport = window.matchMedia("(max-width: 1023px)").matches;
    const menuHeightLimit = mobileViewport
      ? Math.min(280, Math.max(180, window.innerHeight * 0.4))
      : 300;
    const measuredHeight = menuRef.current?.offsetHeight || 0;
    const estimatedHeight = Math.min(
      menuHeightLimit,
      choices.length * (compact ? 38 : 44) + 16,
    );
    const expectedHeight = measuredHeight > 0 ? measuredHeight : estimatedHeight;
    const availableBelow = window.innerHeight - rect.bottom - viewportPadding;
    const availableAbove = rect.top - viewportPadding;

    const openAbove =
      availableBelow < expectedHeight && availableAbove > availableBelow;
    const availableHeight = openAbove ? availableAbove - 8 : availableBelow - 8;
    const maxHeight = Math.max(120, Math.min(menuHeightLimit, availableHeight));
    const width = Math.min(rect.width, window.innerWidth - viewportPadding * 2);
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      Math.max(viewportPadding, window.innerWidth - width - viewportPadding),
    );

    setMenuStyle({
      position: "fixed",
      left,
      width,
      maxHeight,
      scrollbarGutter: "stable",
      zIndex: 240,
      ...(openAbove
        ? {
            bottom: Math.max(viewportPadding, window.innerHeight - rect.top + 6),
            top: "auto",
          }
        : {
            top: Math.min(
              rect.bottom + 6,
              window.innerHeight - maxHeight - viewportPadding,
            ),
            bottom: "auto",
          }),
    });
  }

  React.useEffect(() => {
    if (!open || allowCreate) setInputValue(value);
  }, [allowCreate, open, value]);

  function closeAndRestore() {
    setOpen(false);
    setActiveIndex(-1);
    setSearchTerm("");
    if (!allowCreate) setInputValue(value);
  }

  useLayoutEffect(() => {
    if (!open) return undefined;
    positionMenu();
    let positionFrame: number | null = window.requestAnimationFrame(() => {
      positionFrame = null;
      positionMenu();
    });

    function closeOnOutside(event: MouseEvent | PointerEvent) {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        closeAndRestore();
      }
    }

    function schedulePosition(event?: Event) {
      const eventTarget = event?.target;
      if (eventTarget instanceof Node && menuRef.current?.contains(eventTarget)) return;
      if (positionFrame !== null) window.cancelAnimationFrame(positionFrame);
      positionFrame = window.requestAnimationFrame(() => {
        positionFrame = null;
        const input = rootRef.current?.querySelector("input");
        if (!input) return;
        const rect = input.getBoundingClientRect();
        const outsideViewport =
          rect.bottom <= 0 ||
          rect.top >= window.innerHeight ||
          rect.right <= 0 ||
          rect.left >= window.innerWidth;
        if (outsideViewport) {
          closeAndRestore();
          return;
        }
        positionMenu();
      });
    }

    document.addEventListener("pointerdown", closeOnOutside);
    window.addEventListener("resize", schedulePosition);
    window.addEventListener("scroll", schedulePosition, true);
    return () => {
      if (positionFrame !== null) window.cancelAnimationFrame(positionFrame);
      document.removeEventListener("pointerdown", closeOnOutside);
      window.removeEventListener("resize", schedulePosition);
      window.removeEventListener("scroll", schedulePosition, true);
    };
  }, [open, choices.length, allowCreate, value, compact]);

  function selectChoice(choice: { label: string; created: boolean }) {
    justSelectedRef.current = true;
    onChange(choice.label);
    setInputValue(choice.label);
    setSearchTerm("");
    setOpen(false);
    setActiveIndex(-1);
    setTimeout(() => {
      justSelectedRef.current = false;
    }, 200);
  }

  function toggleList() {
    if (open) {
      closeAndRestore();
      return;
    }

    setSearchTerm("");
    setActiveIndex(-1);
    setOpen(true);
    window.requestAnimationFrame(() => {
      const input = rootRef.current?.querySelector<HTMLInputElement>(
        'input[role="combobox"]',
      );
      input?.focus();
      if (selectOnFocus) input?.select();
    });
  }

  return (
    <div ref={rootRef} className="min-w-0">
      <div className="relative">
        <input
          ref={(node) => {
            (internalInputRef as React.MutableRefObject<HTMLInputElement | null>).current = node;
            if (typeof externalInputRef === "function") externalInputRef(node);
            else if (externalInputRef && "current" in externalInputRef) {
              (externalInputRef as React.MutableRefObject<HTMLInputElement | null>).current = node;
            }
          }}
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={
            open && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined
          }
          aria-describedby={
            allowCreate && normalizedValue && !exactMatch ? helpId : undefined
          }
          aria-autocomplete="list"
          aria-required={required}
          aria-invalid={invalid}
          value={allowCreate ? value : inputValue}
          onFocus={(event) => {
            if (justSelectedRef.current) return;
            if (!allowCreate) {
              setInputValue(value);
            }
            setSearchTerm("");
            setOpen(true);
            if (selectOnFocus) event.currentTarget.select();
          }}
          onChange={(event) => {
            const nextValue = event.target.value;
            setSearchTerm(nextValue);
            if (allowCreate) onChange(nextValue);
            else setInputValue(nextValue);
            setOpen(true);
            setActiveIndex(-1);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) => Math.min(index + 1, choices.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) => index <= 0 ? choices.length - 1 : index - 1);
            } else if (event.key === "Enter" && open && choices[activeIndex]) {
              event.preventDefault();
              selectChoice(choices[activeIndex]);
            } else if (event.key === "Escape") {
              closeAndRestore();
            }
          }}
          placeholder={placeholder}
          className={`${compact ? "h-8.5 rounded-[8px] px-2.5 pr-8 text-[12px]" : "h-[44px] rounded-[11px] px-3 pr-12 text-[13px]"} block w-full min-w-0 bg-white font-semibold text-[#11120d] outline-none transition focus:ring-2 ${invalid ? "border-2 border-[#DC2626] bg-[#FFF1F2] focus:ring-red-100" : "border border-[#CFCFD3] focus:border-[#087F83] focus:ring-[#087F83]/15"} ${className || ""}`}
        />
        <button
          type="button"
          aria-label={`${open ? "Close" : "Open"} ${ariaLabel.toLocaleLowerCase()} options`}
          aria-expanded={open}
          aria-controls={listId}
          onPointerDown={(event) => event.preventDefault()}
          onClick={toggleList}
          className={`absolute right-1 top-1/2 z-[1] inline-flex -translate-y-1/2 items-center justify-center text-[#6B7280] transition hover:bg-[#F3F4F6] hover:text-[#11120d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#11120d] focus-visible:ring-offset-1 ${compact ? "h-6.5 w-6.5 rounded-[6px]" : "h-9 w-9 rounded-[9px]"}`}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="none"
            className={`${compact ? "h-3.5 w-3.5" : "h-5 w-5"} transition-transform ${open ? "rotate-180" : ""}`}
          >
            <path
              d="m6 8 4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {open && typeof document !== "undefined"
          ? createPortal(
              <div
                ref={menuRef}
                id={listId}
                role="listbox"
                style={menuStyle}
                className="overflow-y-auto rounded-[12px] border border-[#DADDE3] bg-white p-1.5 shadow-2xl"
              >
                {choices.length > 0 ? (
                  <>
                    {choices.map((choice, index) => (
                      <button
                      key={`${choice.created ? "new" : "existing"}-${choice.label}`}
                      id={`${listId}-option-${index}`}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={index === activeIndex}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => selectChoice(choice)}
                      className={`flex ${compact ? "min-h-8 py-1.5 px-2.5 text-[11.5px]" : "min-h-10 px-3 text-[13px]"} w-full items-center justify-between gap-2.5 rounded-[8px] text-left font-semibold ${index === activeIndex ? "bg-[#EFF6FF] text-[#1D4ED8]" : "text-[#11120d] hover:bg-[#F3F4F6]"}`}
                    >
                      <span className="truncate">
                        {choice.created ? `Create “${choice.label}”` : choice.label}
                      </span>
                      {choice.created ? (
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-extrabold uppercase text-blue-700">
                          New
                        </span>
                      ) : null}
                      </button>
                    ))}
                    {!normalizedSearch && uniqueOptions.length > matches.length ? (
                      <div className="border-t border-[#E5E7EB] px-3 py-2 text-[11px] font-medium text-[#6B7280]">
                        Type to search all {uniqueOptions.length.toLocaleString()} options.
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="px-3 py-2 text-[12px] font-medium text-[#8C8889]">
                    No matches
                  </div>
                )}
              </div>,
              document.body,
            )
          : null}
      </div>
      {showCreateHelp && allowCreate && normalizedValue && !exactMatch ? (
        <div id={helpId} className="mt-1 text-[11px] font-medium text-[#2563EB]">
          {createHelpText || "New value — created only when the product is saved."}
        </div>
      ) : null}
    </div>
  );
}
