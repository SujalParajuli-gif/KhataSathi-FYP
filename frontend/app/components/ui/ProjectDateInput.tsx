import React, {
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

function parseDate(value?: string) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateValue(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, amount: number) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function formatDisplayDate(value: string) {
  const date = parseDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function buildCalendarDays(month: Date) {
  const first = startOfMonth(month);
  const gridStart = new Date(
    first.getFullYear(),
    first.getMonth(),
    1 - first.getDay(),
  );
  return Array.from({ length: 42 }, (_, index) =>
    new Date(
      gridStart.getFullYear(),
      gridStart.getMonth(),
      gridStart.getDate() + index,
    ),
  );
}

export type ProjectDateInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "defaultValue" | "onChange" | "min" | "max"
> & {
  value: string;
  min?: string;
  max?: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
};

export default function ProjectDateInput({
  value,
  min,
  max,
  onChange,
  className,
  placeholder = "Select date",
  disabled,
  required,
  name,
  id,
  title,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
}: ProjectDateInputProps) {
  const generatedId = useId();
  const controlId = id || `project-date-${generatedId.replace(/:/g, "")}`;
  const selectedDate = parseDate(value);
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() =>
    startOfMonth(selectedDate || new Date()),
  );
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const days = useMemo(() => buildCalendarDays(visibleMonth), [visibleMonth]);
  const todayValue = toDateValue(new Date());
  const todayAllowed = (!min || todayValue >= min) && (!max || todayValue <= max);

  function positionPanel() {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === "undefined") return;
    const mobile = window.matchMedia("(max-width: 1023px)").matches;
    if (mobile) {
      setPanelStyle({
        position: "fixed",
        left: "50%",
        right: "auto",
        bottom: 0,
        width: "min(100vw, 390px)",
        transform: "translateX(-50%)",
      });
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 16;
    const width = 320;
    const estimatedHeight = Math.min(
      panelRef.current?.offsetHeight || 400,
      window.innerHeight - viewportPadding * 2,
    );
    const availableBelow = window.innerHeight - rect.bottom - viewportPadding;
    const openAbove = availableBelow < estimatedHeight && rect.top > availableBelow;
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      Math.max(viewportPadding, window.innerWidth - width - viewportPadding),
    );
    setPanelStyle({
      position: "fixed",
      left,
      width,
      top: openAbove
        ? Math.max(viewportPadding, rect.top - estimatedHeight - 8)
        : Math.min(
            rect.bottom + 8,
            window.innerHeight - estimatedHeight - viewportPadding,
          ),
    });
  }

  useEffect(() => {
    if (!open) return;
    setVisibleMonth(startOfMonth(selectedDate || new Date()));
  }, [open, value]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    positionPanel();
    let positionFrame: number | null = window.requestAnimationFrame(() => {
      positionFrame = null;
      positionPanel();
    });

    function schedulePosition(event?: Event) {
      const target = event?.target;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      if (positionFrame !== null) window.cancelAnimationFrame(positionFrame);
      positionFrame = window.requestAnimationFrame(() => {
        positionFrame = null;
        const trigger = triggerRef.current;
        if (!trigger) return;
        const rect = trigger.getBoundingClientRect();
        if (
          rect.bottom <= 0 ||
          rect.top >= window.innerHeight ||
          rect.right <= 0 ||
          rect.left >= window.innerWidth
        ) {
          setOpen(false);
          return;
        }
        positionPanel();
      });
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
    }

    window.addEventListener("resize", schedulePosition);
    window.addEventListener("scroll", schedulePosition, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      if (positionFrame !== null) window.cancelAnimationFrame(positionFrame);
      window.removeEventListener("resize", schedulePosition);
      window.removeEventListener("scroll", schedulePosition, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, value]);

  function emitValue(nextValue: string) {
    const syntheticEvent = {
      target: { value: nextValue },
      currentTarget: { value: nextValue },
    } as unknown as React.ChangeEvent<HTMLInputElement>;
    onChange(syntheticEvent);
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function isDisabled(dayValue: string) {
    return Boolean((min && dayValue < min) || (max && dayValue > max));
  }

  const monthLabel = new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).format(visibleMonth);

  return (
    <>
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <button
        ref={triggerRef}
        id={controlId}
        type="button"
        title={title}
        disabled={disabled}
        aria-label={ariaLabel || (value ? `Selected date: ${formatDisplayDate(value)}` : "Choose date")}
        aria-describedby={ariaDescribedBy}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-required={required}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "project-date-trigger flex h-11 w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 text-left text-[13px] font-bold text-slate-900 outline-none transition hover:border-slate-300 focus-visible:border-slate-900 focus-visible:ring-2 focus-visible:ring-slate-900/10 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400",
          open && "border-slate-900 ring-2 ring-slate-900/10",
          className,
        )}
      >
        <span className={cn("min-w-0 flex-1 truncate", !value && "text-slate-400")}>
          {value ? formatDisplayDate(value) : placeholder}
        </span>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-50 text-slate-500">
          <Icon name="calendar_month" sizePx={17} />
        </span>
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fixed inset-0 z-[260] touch-none overscroll-none bg-black/35 lg:bg-transparent"
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) setOpen(false);
              }}
              onWheel={(event) => {
                if (event.target === event.currentTarget) event.preventDefault();
              }}
              onTouchMove={(event) => {
                if (event.target === event.currentTarget) event.preventDefault();
              }}
            >
              <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-label="Choose date"
                style={panelStyle}
                className="project-calendar-panel max-h-[min(520px,100dvh)] touch-pan-y overflow-y-auto overscroll-contain rounded-t-[24px] border border-x-0 border-b-0 border-slate-200 bg-white p-3 shadow-2xl lg:max-h-[calc(100dvh-32px)] lg:rounded-[16px] lg:border"
                onPointerDown={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
              >
                <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-300 lg:hidden" />
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-slate-400">
                      Choose date
                    </div>
                    <div className="mt-0.5 text-[17px] font-extrabold text-slate-950">
                      {monthLabel}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setVisibleMonth((current) => addMonths(current, -1))}
                      className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
                      aria-label="Previous month"
                    >
                      <Icon name="chevron_left" sizePx={22} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setVisibleMonth((current) => addMonths(current, 1))}
                      className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
                      aria-label="Next month"
                    >
                      <Icon name="chevron_right" sizePx={22} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setOpen(false)}
                      className="ml-1 inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 lg:hidden"
                      aria-label="Close calendar"
                    >
                      <Icon name="close" sizePx={20} />
                    </button>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-7 text-center text-[11px] font-extrabold uppercase text-slate-400" aria-hidden="true">
                  {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((day) => (
                    <span key={day} className="py-2">{day}</span>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-0.5 lg:gap-1" role="grid" aria-label={monthLabel}>
                  {days.map((day) => {
                    const dayValue = toDateValue(day);
                    const outsideMonth = day.getMonth() !== visibleMonth.getMonth();
                    const selected = dayValue === value;
                    const today = dayValue === todayValue;
                    const unavailable = isDisabled(dayValue);
                    return (
                      <button
                        key={dayValue}
                        type="button"
                        role="gridcell"
                        disabled={unavailable}
                        aria-selected={selected}
                        aria-current={today ? "date" : undefined}
                        onClick={() => emitValue(dayValue)}
                        className={cn(
                          "relative flex aspect-square min-h-10 items-center justify-center rounded-xl text-[13px] font-bold transition focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 lg:aspect-auto lg:h-9 lg:min-h-9 lg:rounded-lg lg:text-[12px]",
                          selected
                            ? "bg-slate-950 text-white shadow-sm"
                            : outsideMonth
                              ? "text-slate-300 hover:bg-slate-50"
                              : "text-slate-700 hover:bg-slate-100",
                          today && !selected && "border border-emerald-500 text-emerald-700",
                          unavailable && "cursor-not-allowed opacity-25",
                        )}
                      >
                        {day.getDate()}
                      </button>
                    );
                  })}
                </div>

                <div className="mt-4 flex items-center justify-between border-t border-slate-200 pt-3">
                  <button
                    type="button"
                    onClick={() => emitValue("")}
                    disabled={!value || required}
                    className="h-10 rounded-xl px-3 text-[12px] font-extrabold text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    onClick={() => emitValue(todayValue)}
                    disabled={!todayAllowed}
                    className="h-10 rounded-xl bg-slate-950 px-4 text-[12px] font-extrabold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    Today
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
