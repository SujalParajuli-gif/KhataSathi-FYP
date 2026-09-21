import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import Icon from "~/components/ui/Icon";

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export interface OptionSelectorProps {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  ariaLabel: string;
  allowManual?: boolean;
  compact?: boolean;
  disabled?: boolean;
  hasError?: boolean;
  className?: string;
  id?: string;
  matchTriggerWidth?: boolean;
  minMenuWidth?: number;
}

/**
 * Unified Popover Combobox:
 * - Single-line trigger button (no external clutter).
 * - Floating portal popover whose width dynamically matches the trigger component.
 * - Selection-first: existing items are filtered and chosen cleanly.
 * - Explicit manual creation: "+ Use <value>" appears when allowManual=true and text is new.
 */
export default function OptionSelector({
  value,
  onChange,
  options,
  placeholder = "Select…",
  ariaLabel,
  allowManual = true,
  compact = false,
  disabled = false,
  hasError = false,
  className,
  id,
  matchTriggerWidth = true,
  minMenuWidth,
}: OptionSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});

  const generatedId = useId();
  const controlId = id || `selector-${generatedId}`;
  const listboxId = `${controlId}-listbox`;

  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Deduplicate and filter choices
  const uniqueOptions = useMemo(
    () => Array.from(new Set(options.map((opt) => opt.trim()).filter(Boolean))),
    [options]
  );

  const trimmedSearch = search.trim();
  const filteredOptions = useMemo(() => {
    if (!trimmedSearch) return uniqueOptions;
    const query = trimmedSearch.toLocaleLowerCase();
    return uniqueOptions.filter((opt) =>
      opt.toLocaleLowerCase().includes(query)
    );
  }, [uniqueOptions, trimmedSearch]);

  const exactMatch = uniqueOptions.some(
    (opt) => opt.toLocaleLowerCase() === trimmedSearch.toLocaleLowerCase()
  );

  const showCustomOption =
    allowManual && trimmedSearch.length > 0 && !exactMatch;

  // Total selectable items count: filtered options + (1 if custom option is displayed)
  const totalItems = filteredOptions.length + (showCustomOption ? 1 : 0);

  const positionMenu = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === "undefined") return;

    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 10;
    const menuMaxHeight = 280;
    const availableBelow = window.innerHeight - rect.bottom - viewportPadding;
    const availableAbove = rect.top - viewportPadding;
    const openAbove = availableBelow < 200 && availableAbove > availableBelow;

    const maxHeight = Math.max(
      120,
      Math.min(menuMaxHeight, openAbove ? availableAbove - 8 : availableBelow - 8)
    );
    const width = matchTriggerWidth
      ? Math.min(
          Math.max(rect.width, minMenuWidth ?? 0),
          window.innerWidth - viewportPadding * 2
        )
      : Math.min(
          Math.max(rect.width, 240),
          window.innerWidth - viewportPadding * 2
        );
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      window.innerWidth - width - viewportPadding
    );

    setMenuStyle({
      position: "fixed",
      left,
      width,
      maxHeight,
      scrollbarGutter: "stable",
      zIndex: 260,
      ...(openAbove
        ? {
            bottom: Math.max(viewportPadding, window.innerHeight - rect.top + 4),
            top: "auto",
          }
        : {
            top: Math.min(
              rect.bottom + 4,
              window.innerHeight - maxHeight - viewportPadding
            ),
            bottom: "auto",
          }),
    });
  }, []);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setSearch("");
    setActiveIndex(-1);
    requestAnimationFrame(() => {
      triggerRef.current?.focus();
    });
  }, []);

  const selectValue = useCallback(
    (val: string) => {
      onChange(val);
      closeMenu();
    },
    [onChange, closeMenu]
  );

  // Reposition on open / resize / scroll
  useLayoutEffect(() => {
    if (!open) return;
    positionMenu();

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        closeMenu();
      }
    }

    function onScrollOrResize() {
      positionMenu();
    }

    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
    };
  }, [open, positionMenu, closeMenu]);

  // Focus search input on open (if desktop / fine pointer)
  useEffect(() => {
    if (open) {
      const isFinePointer = window.matchMedia("(pointer: fine)").matches;
      if (isFinePointer) {
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
        });
      }
    }
  }, [open]);

  // Reset activeIndex when search changes
  useEffect(() => {
    setActiveIndex(totalItems > 0 ? 0 : -1);
  }, [search, totalItems]);

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(true);
    }
  }

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % Math.max(1, totalItems));
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((prev) => (prev <= 0 ? totalItems - 1 : prev - 1));
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (activeIndex >= 0 && activeIndex < filteredOptions.length) {
        selectValue(filteredOptions[activeIndex]);
      } else if (showCustomOption && (activeIndex === filteredOptions.length || activeIndex === -1)) {
        selectValue(trimmedSearch);
      } else if (filteredOptions.length === 1) {
        selectValue(filteredOptions[0]);
      } else if (showCustomOption) {
        selectValue(trimmedSearch);
      }
    }
  }

  return (
    <div className={cn("relative min-w-0 w-full", className)}>
      {/* Trigger Button */}
      <button
        id={controlId}
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => {
          if (!disabled) {
            if (open) closeMenu();
            else setOpen(true);
          }
        }}
        onKeyDown={handleTriggerKeyDown}
        className={cn(
          "flex w-full items-center justify-between rounded-[9px] border bg-white text-left font-medium text-[#11120d] outline-none transition focus-visible:ring-2 focus-visible:ring-[#11120d] focus-visible:ring-offset-1 touch-manipulation select-none",
          compact ? "h-9 px-2.5 text-[12.5px]" : "h-10 px-3 text-sm",
          hasError
            ? "border-rose-400 ring-1 ring-rose-400 bg-rose-50/20"
            : open
            ? "border-[#11120d] ring-1 ring-[#11120d]"
            : "border-[#CFCFD3] hover:border-slate-400",
          disabled && "cursor-not-allowed bg-slate-50 text-slate-400 opacity-60"
        )}
      >
        <span className={cn("min-w-0 flex-1 truncate", !value && "text-slate-400")}>
          {value || placeholder}
        </span>
        <Icon
          name="expand_more"
          sizePx={compact ? 16 : 18}
          className={cn("shrink-0 text-slate-400 transition-transform duration-150", open && "rotate-180")}
        />
      </button>

      {/* Floating Popover Menu */}
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              id={listboxId}
              ref={menuRef}
              role="listbox"
              aria-label={ariaLabel}
              style={menuStyle}
              onWheel={(e) => e.stopPropagation()}
              onTouchMove={(e) => e.stopPropagation()}
              className="flex flex-col rounded-[11px] border border-slate-200 bg-white shadow-xl overflow-hidden animate-in fade-in-0 zoom-in-95 duration-100"
            >
              {/* Sticky Search Header */}
              <div className="shrink-0 border-b border-slate-100 bg-[#F8FAFC] p-1.5 sm:p-2">
                <div className="relative flex items-center">
                  <Icon
                    name="search"
                    sizePx={15}
                    className="absolute left-2.5 text-slate-400 pointer-events-none"
                  />
                  <input
                    ref={searchInputRef}
                    type="text"
                    role="searchbox"
                    aria-label={`Search ${ariaLabel}`}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={handleSearchKeyDown}
                    placeholder={allowManual ? "Search or add…" : "Search options…"}
                    className="h-8 w-full rounded-[7px] border border-slate-200 bg-white pl-8 pr-7 text-[12px] font-medium text-slate-900 outline-none placeholder:text-slate-400 focus:border-[#11120d] focus:ring-1 focus:ring-[#11120d]"
                  />
                  {search ? (
                    <button
                      type="button"
                      onClick={() => {
                        setSearch("");
                        searchInputRef.current?.focus();
                      }}
                      className="absolute right-1.5 flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:text-slate-700 transition"
                      aria-label="Clear search"
                    >
                      <Icon name="close" sizePx={13} />
                    </button>
                  ) : null}
                </div>
              </div>

              {/* Scrollable Options List */}
              <div className="flex-1 overflow-y-auto overscroll-contain py-1 [scrollbar-width:thin] [scrollbar-color:#CBD5E1_transparent]">
                {filteredOptions.length > 0 ? (
                  filteredOptions.map((opt, index) => {
                    const isSelected = opt === value;
                    const isActive = index === activeIndex;

                    return (
                      <button
                        key={opt}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        tabIndex={-1}
                        onPointerEnter={() => setActiveIndex(index)}
                        onClick={() => selectValue(opt)}
                        className={cn(
                          "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12px] font-medium transition-colors touch-manipulation select-none",
                          isActive && "bg-slate-100 text-slate-900",
                          isSelected && "bg-slate-50 font-bold text-[#11120d]",
                          !isActive && !isSelected && "text-slate-700 hover:bg-slate-50"
                        )}
                      >
                        <span className="truncate">{opt}</span>
                        {isSelected ? (
                          <Icon name="check" sizePx={14} className="shrink-0 text-[#16753A]" />
                        ) : null}
                      </button>
                    );
                  })
                ) : !showCustomOption ? (
                  <div className="p-3 text-center text-[11.5px] font-medium text-slate-500">
                    No matching options.
                  </div>
                ) : null}

                {/* Integrated Custom Value / Manual Entry Option */}
                {showCustomOption ? (
                  <div className={cn(filteredOptions.length > 0 && "border-t border-slate-100 pt-1 mt-1")}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={false}
                      tabIndex={-1}
                      onPointerEnter={() => setActiveIndex(filteredOptions.length)}
                      onClick={() => selectValue(trimmedSearch)}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12px] font-semibold transition-colors touch-manipulation select-none",
                        activeIndex === filteredOptions.length
                          ? "bg-[#EAF8EF] text-[#16753A]"
                          : "text-[#16753A] hover:bg-[#F3FBF6]"
                      )}
                    >
                      <span className="flex items-center gap-1.5 truncate">
                        <Icon name="add" sizePx={14} className="shrink-0 text-[#16753A]" />
                        <span className="truncate">Use “{trimmedSearch}”</span>
                      </span>
                      <span className="shrink-0 rounded-full border border-[#BBD7C5] bg-white px-1.5 py-0.2 text-[9.5px] font-extrabold uppercase text-[#16753A]">
                        New
                      </span>
                    </button>
                  </div>
                ) : null}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
