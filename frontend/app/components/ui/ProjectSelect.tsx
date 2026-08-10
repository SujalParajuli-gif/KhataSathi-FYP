import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import Icon from "~/components/ui/Icon";

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

type SelectOption = {
  value: string;
  label: ReactNode;
  disabled: boolean;
};

type NativeOptionProps = {
  value?: string | number;
  disabled?: boolean;
  children?: ReactNode;
};

function collectOptions(children: ReactNode): SelectOption[] {
  const options: SelectOption[] = [];

  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;

    if (child.type === React.Fragment) {
      options.push(...collectOptions((child.props as { children?: ReactNode }).children));
      return;
    }

    if (child.type === "option") {
      const props = (child as ReactElement<NativeOptionProps>).props;
      const fallbackValue = typeof props.children === "string" || typeof props.children === "number"
        ? String(props.children)
        : "";
      options.push({
        value: props.value == null ? fallbackValue : String(props.value),
        label: props.children,
        disabled: Boolean(props.disabled),
      });
      return;
    }

    const nestedChildren = (child.props as { children?: ReactNode }).children;
    if (nestedChildren) options.push(...collectOptions(nestedChildren));
  });

  return options;
}

function layoutClasses(className?: string) {
  if (!className) return "";
  const layoutPattern = /^(?:(?:[a-z]+):)*(?:w-|min-w-|max-w-|flex-|grow|shrink|basis-|self-|justify-self-|place-self-|m[trblxy]?-|hidden$|block$|inline-block$)/;
  return className
    .split(/\s+/)
    .filter((token) => layoutPattern.test(token))
    .join(" ");
}

export type ProjectSelectProps = Omit<
  React.SelectHTMLAttributes<HTMLSelectElement>,
  "multiple" | "size"
> & {
  children: ReactNode;
};

export default function ProjectSelect({
  children,
  value,
  defaultValue,
  onChange,
  onBlur,
  onFocus,
  disabled,
  className,
  id,
  name,
  required,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  title,
  tabIndex,
}: ProjectSelectProps) {
  const generatedId = useId();
  const controlId = id || `project-select-${generatedId.replace(/:/g, "")}`;
  const options = useMemo(() => collectOptions(children), [children]);
  const initialValue = value ?? defaultValue ?? options[0]?.value ?? "";
  const [uncontrolledValue, setUncontrolledValue] = useState(String(initialValue));
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const controlled = value !== undefined;
  const currentValue = controlled ? String(value ?? "") : uncontrolledValue;
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === currentValue));
  const selectedOption = options.find((option) => option.value === currentValue);
  const compact = Boolean(className && /(?:h-8\b|h-9\b|h-\[(?:3[0-9])px\])/.test(className));
  const hasError = Boolean(
    ariaInvalid || (className && /border-(?:rose|red)-/.test(className)),
  );

  function positionMenu() {
    const button = buttonRef.current;
    if (!button || typeof window === "undefined") return;
    const rect = button.getBoundingClientRect();
    const viewportPadding = 8;
    const mobileViewport = window.matchMedia("(max-width: 1023px)").matches;
    const menuHeightLimit = mobileViewport
      ? Math.min(264, Math.max(176, window.innerHeight * 0.34))
      : 320;
    const estimatedHeight = Math.min(
      menuHeightLimit,
      options.length * (compact ? 37 : 43) + 12,
    );
    const availableBelow = window.innerHeight - rect.bottom - viewportPadding;
    const availableAbove = rect.top - viewportPadding;
    const openAbove =
      availableBelow < estimatedHeight && availableAbove > availableBelow;
    const availableHeight = openAbove ? availableAbove - 4 : availableBelow - 4;
    const maxHeight = Math.max(112, Math.min(menuHeightLimit, availableHeight));
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
      ...(openAbove
        ? { bottom: window.innerHeight - rect.top + 4 }
        : { top: rect.bottom + 4 }),
    });
  }

  useEffect(() => {
    if (!controlled) return;
    setUncontrolledValue(String(value ?? ""));
  }, [controlled, value]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    setActiveIndex(selectedIndex);
    positionMenu();
    let positionFrame: number | null = null;

    function closeOnOutside(event: MouseEvent | PointerEvent) {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    }

    function schedulePosition(event?: Event) {
      const eventTarget = event?.target;
      if (eventTarget instanceof Node && menuRef.current?.contains(eventTarget)) return;
      if (positionFrame !== null) window.cancelAnimationFrame(positionFrame);
      positionFrame = window.requestAnimationFrame(() => {
        positionFrame = null;
        const button = buttonRef.current;
        if (!button) return;
        const rect = button.getBoundingClientRect();
        const outsideViewport = rect.bottom <= 0
          || rect.top >= window.innerHeight
          || rect.right <= 0
          || rect.left >= window.innerWidth;
        if (outsideViewport) {
          setOpen(false);
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
  }, [compact, open, options.length, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const activeOption = menuRef.current?.querySelectorAll<HTMLElement>("[role='option']")[activeIndex];
    activeOption?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  function selectValue(nextValue: string) {
    if (!controlled) setUncontrolledValue(nextValue);
    const syntheticEvent = {
      target: { value: nextValue },
      currentTarget: { value: nextValue },
    } as unknown as React.ChangeEvent<HTMLSelectElement>;
    onChange?.(syntheticEvent);
    setOpen(false);
    requestAnimationFrame(() => buttonRef.current?.focus());
  }

  function moveActive(direction: 1 | -1) {
    if (options.length === 0) return;
    let next = activeIndex;
    for (let attempt = 0; attempt < options.length; attempt += 1) {
      next = (next + direction + options.length) % options.length;
      if (!options[next]?.disabled) break;
    }
    setActiveIndex(next);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(selectedIndex);
      } else {
        moveActive(event.key === "ArrowDown" ? 1 : -1);
      }
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && open) {
      event.preventDefault();
      const option = options[activeIndex];
      if (option && !option.disabled) selectValue(option.value);
    }
  }

  return (
    <div className={cn("relative min-w-0", layoutClasses(className) || "w-full")}>
      {name ? <input type="hidden" name={name} value={currentValue} required={required} /> : null}
      <button
        ref={buttonRef}
        id={controlId}
        type="button"
        role="combobox"
        disabled={disabled}
        tabIndex={tabIndex}
        title={title}
        aria-label={ariaLabel || "Select an option"}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        aria-required={required}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${controlId}-listbox`}
        aria-activedescendant={open ? `${controlId}-option-${activeIndex}` : undefined}
        onBlur={(event) => onBlur?.(event as unknown as React.FocusEvent<HTMLSelectElement>)}
        onFocus={(event) => onFocus?.(event as unknown as React.FocusEvent<HTMLSelectElement>)}
        onKeyDown={handleKeyDown}
        onClick={() => {
          if (!disabled) setOpen((current) => !current);
        }}
        className={cn(
          "flex w-full items-center justify-between gap-3 rounded-lg border bg-white text-left font-semibold text-slate-900 outline-none transition-all",
          compact ? "h-[34px] px-3 text-[12px]" : "h-11 px-4 text-sm",
          open
            ? hasError
              ? "border-transparent ring-2 ring-rose-400"
              : "border-transparent ring-2 ring-slate-900"
            : hasError
              ? "border-rose-300 hover:border-rose-400"
              : "border-slate-200 hover:border-slate-300",
          disabled && "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-500 opacity-70",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{selectedOption?.label ?? "Select..."}</span>
        <Icon name={open ? "expand_less" : "expand_more"} sizePx={18} className="shrink-0 text-slate-400" />
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              id={`${controlId}-listbox`}
              ref={menuRef}
              role="listbox"
              aria-labelledby={controlId}
              style={menuStyle}
              onWheel={(event) => event.stopPropagation()}
              onTouchMove={(event) => event.stopPropagation()}
              className="z-[240] overflow-y-auto overscroll-contain rounded-xl border border-slate-200 bg-white py-1.5 shadow-xl [scrollbar-width:thin] [scrollbar-color:#A1A1AA_transparent]"
            >
              {options.map((option, index) => {
                const selected = option.value === currentValue;
                const active = index === activeIndex;
                return (
                  <button
                    key={`${option.value}-${index}`}
                    id={`${controlId}-option-${index}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    disabled={option.disabled}
                    onPointerEnter={() => setActiveIndex(index)}
                    onClick={() => selectValue(option.value)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 px-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                      compact ? "min-h-[36px] text-[12px]" : "min-h-[42px] text-sm",
                      selected ? "bg-slate-50 font-bold text-slate-900" : "font-medium text-slate-700",
                      active && !selected && "bg-slate-50",
                    )}
                  >
                    <span
                      className="min-w-0 flex-1 truncate"
                      title={
                        typeof option.label === "string" || typeof option.label === "number"
                          ? String(option.label)
                          : undefined
                      }
                    >
                      {option.label}
                    </span>
                    {selected ? <Icon name="check" sizePx={16} className="shrink-0 text-[#11120d]" /> : null}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
