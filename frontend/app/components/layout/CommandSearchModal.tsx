import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import GIcon from "~/components/ui/GIcon";
import type { NavItemConfig } from "~/config/navigation";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  items: NavItemConfig[];
};

export default function CommandSearchModal({ isOpen, onClose, items }: Props) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const resultRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Filter out logout/destructive from quick search list
  const searchableItems = items.filter((item) => !item.danger);

  const filtered = query.trim()
    ? searchableItems.filter((item) => {
        const text = `${item.label} ${item.group} ${item.description}`.toLowerCase();
        return text.includes(query.trim().toLowerCase());
      })
    : searchableItems;

  useEffect(() => {
    if (!isOpen) return undefined;

    returnFocusRef.current = document.activeElement as HTMLElement | null;
    setQuery("");
    setSelectedIndex(0);

    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 40);

    return () => {
      window.clearTimeout(timer);
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    };
  }, [isOpen]);

  // Synchronize ref array length and keep selected index within bounds
  useEffect(() => {
    resultRefs.current.length = filtered.length;
    setSelectedIndex((current) =>
      filtered.length === 0 ? 0 : Math.min(current, filtered.length - 1)
    );
  }, [filtered.length]);

  // Auto-scroll active item into view during keyboard navigation
  useEffect(() => {
    if (selectedIndex === 0 && listContainerRef.current) {
      listContainerRef.current.scrollTop = 0;
      return;
    }
    const activeResult = resultRefs.current[selectedIndex];
    activeResult?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, filtered.length]);

  function handleSelect(item: NavItemConfig) {
    onClose();
    navigate(item.to);
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (filtered.length === 0) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = filtered[selectedIndex];
      if (item) handleSelect(item);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  // Focus trapping in modal
  function handleContainerKeyDown(event: React.KeyboardEvent) {
    if (event.key !== "Tab" || !containerRef.current) return;
    const focusable = containerRef.current.querySelectorAll<HTMLElement>(
      'input, button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable.length) return;
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

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/50 p-4 sm:p-6 backdrop-blur-[3px] transition-opacity duration-200"
      onClick={onClose}
      onKeyDown={handleContainerKeyDown}
      role="presentation"
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Find a page"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[680px] overflow-hidden rounded-[20px] border border-[#D8DDE5] bg-white shadow-2xl animate-in fade-in-0 zoom-in-95 duration-150"
      >
        {/* Header Search Field */}
        <div className="flex h-[66px] sm:h-[70px] items-center gap-3.5 border-b border-[#E2E8F0] px-5 bg-white">
          <GIcon name="search" sizePx={22} className="shrink-0 text-slate-400" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search a page or workspace..."
            aria-label="Search navigation pages"
            className="h-full flex-1 bg-transparent text-[15px] sm:text-[16px] font-medium text-slate-900 outline-none placeholder:text-slate-400"
          />
          <button
            type="button"
            onClick={onClose}
            className="rounded-[7px] border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-slate-500 transition hover:bg-slate-100"
            aria-label="Close search dialog"
          >
            Esc
          </button>
        </div>

        {/* Results List */}
        <div
          ref={listContainerRef}
          className="max-h-[min(460px,calc(100dvh-200px))] overflow-y-auto p-3 sm:p-3.5 [scrollbar-width:thin]"
        >
          {filtered.length === 0 ? (
            <div className="p-10 text-center text-[14px] text-slate-500">
              No permitted pages match &ldquo;{query}&rdquo;
            </div>
          ) : (
            <div className="flex flex-col gap-1" role="listbox">
              {filtered.map((item, index) => {
                const isSelected = index === selectedIndex;
                const groupTitle =
                  item.group === "quick"
                    ? "Quick Access"
                    : item.group === "sales"
                      ? "Sales & Customers"
                      : item.group === "inventory"
                        ? "Inventory & Purchasing"
                        : item.group === "operations"
                          ? "Business Operations"
                          : "System & Tools";

                return (
                  <button
                    key={item.id}
                    ref={(element) => {
                      resultRefs.current[index] = element;
                    }}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => handleSelect(item)}
                    onMouseEnter={() => setSelectedIndex(index)}
                    className={[
                      "group flex w-full items-center gap-3.5 rounded-[12px] px-3.5 py-3 text-left transition-colors",
                      isSelected
                        ? "bg-slate-100 text-slate-950 font-semibold ring-1 ring-slate-200/90 shadow-2xs"
                        : "text-slate-700 hover:bg-slate-50",
                    ].join(" ")}
                  >
                    <div
                      className={[
                        "flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] transition-colors",
                        isSelected
                          ? "bg-[#11120D] text-white"
                          : "bg-slate-100 text-slate-600 group-hover:bg-slate-200",
                      ].join(" ")}
                    >
                      <GIcon name={item.icon} sizePx={20} />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[14px] sm:text-[14.5px] font-semibold text-slate-900">
                          {item.label}
                        </span>
                        <span
                          className={[
                            "shrink-0 rounded-[6px] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
                            isSelected
                              ? "bg-slate-900 text-white"
                              : "bg-slate-100 text-slate-500",
                          ].join(" ")}
                        >
                          {groupTitle}
                        </span>
                      </div>
                      <p
                        className={[
                          "truncate text-[12px] leading-tight mt-1",
                          isSelected ? "text-slate-600" : "text-slate-400",
                        ].join(" ")}
                      >
                        {item.description}
                      </p>
                    </div>

                    <GIcon
                      name="chevron_right"
                      sizePx={18}
                      className={[
                        "transition-transform",
                        isSelected ? "text-slate-900 translate-x-0.5" : "text-slate-300",
                      ].join(" ")}
                    />
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50/80 px-5 py-2.5 text-[12px] text-slate-500 font-medium">
          <span>↑ ↓ Navigate · Enter Open</span>
          <span>{filtered.length} permitted pages</span>
        </div>
      </div>
    </div>
  );
}
