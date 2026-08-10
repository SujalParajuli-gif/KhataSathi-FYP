import React from "react";

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
  inputRef,
  selectOnFocus = false,
  createHelpText,
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
}) {
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const [inputValue, setInputValue] = React.useState(value);
  const [searchTerm, setSearchTerm] = React.useState("");
  const rootRef = React.useRef<HTMLDivElement>(null);
  const listId = React.useId();
  const helpId = React.useId();
  const normalizedValue = normalize(value);
  const normalizedSearch = normalize(allowCreate ? value : searchTerm);
  const uniqueOptions = React.useMemo(
    () => [...new Set(options.map(normalize).filter(Boolean))],
    [options],
  );
  const matches = uniqueOptions
    .filter((option) => option.toLocaleLowerCase().includes(normalizedSearch.toLocaleLowerCase()))
    .slice(0, 8);
  const exactMatch = uniqueOptions.some(
    (option) => option.toLocaleLowerCase() === normalizedValue.toLocaleLowerCase(),
  );
  const choices = [
    ...matches.map((label) => ({ label, created: false })),
    ...(allowCreate && normalizedValue && !exactMatch
      ? [{ label: normalizedValue, created: true }]
      : []),
  ];

  React.useEffect(() => {
    if (!open || allowCreate) setInputValue(value);
  }, [allowCreate, open, value]);

  function closeAndRestore() {
    setOpen(false);
    setActiveIndex(-1);
    setSearchTerm("");
    if (!allowCreate) setInputValue(value);
  }

  React.useEffect(() => {
    function closeOnOutsideClick(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) closeAndRestore();
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [allowCreate, value]);

  function selectChoice(choice: { label: string; created: boolean }) {
    onChange(choice.label);
    setInputValue(choice.label);
    setSearchTerm("");
    setOpen(false);
    setActiveIndex(-1);
  }

  function toggleList() {
    if (open) {
      closeAndRestore();
      return;
    }

    if (!allowCreate) {
      setInputValue(value);
      setSearchTerm("");
    }
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
    <div ref={rootRef} className="relative">
      <input
        ref={inputRef}
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
          if (!allowCreate) {
            setInputValue(value);
            setSearchTerm("");
          }
          setOpen(true);
          if (selectOnFocus) event.currentTarget.select();
        }}
        onBlur={(event) => {
          const nextTarget = event.relatedTarget as Node | null;
          if (!nextTarget || !rootRef.current?.contains(nextTarget)) {
            closeAndRestore();
          }
        }}
        onChange={(event) => {
          const nextValue = event.target.value;
          if (allowCreate) onChange(nextValue);
          else setInputValue(nextValue);
          setSearchTerm(nextValue);
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
        className={`h-[44px] w-full rounded-[11px] bg-white px-3 pr-12 text-[13px] font-semibold text-[#11120d] outline-none transition focus:ring-2 ${invalid ? "border-2 border-[#DC2626] bg-[#FFF1F2] focus:ring-red-100" : "border border-[#CFCFD3] focus:border-[#3B82F6] focus:ring-blue-100"}`}
      />
      <button
        type="button"
        aria-label={`${open ? "Close" : "Open"} ${ariaLabel.toLocaleLowerCase()} options`}
        aria-expanded={open}
        aria-controls={listId}
        onPointerDown={(event) => event.preventDefault()}
        onClick={toggleList}
        className="absolute right-1 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-[9px] text-[#6B7280] transition hover:bg-[#F3F4F6] hover:text-[#11120d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3B82F6] focus-visible:ring-offset-1"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="none"
          className={`h-5 w-5 transition-transform ${open ? "rotate-180" : ""}`}
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
      {open ? (
        <div id={listId} role="listbox" className="absolute inset-x-0 top-[calc(100%+6px)] z-30 max-h-56 overflow-y-auto rounded-[12px] border border-[#DADDE3] bg-white p-1.5 shadow-xl">
          {choices.length > 0 ? choices.map((choice, index) => (
            <button
              key={`${choice.created ? "new" : "existing"}-${choice.label}`}
              id={`${listId}-option-${index}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={index === activeIndex}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => selectChoice(choice)}
              className={`flex min-h-10 w-full items-center justify-between gap-3 rounded-[9px] px-3 text-left text-[13px] font-semibold ${index === activeIndex ? "bg-[#EFF6FF] text-[#1D4ED8]" : "text-[#11120d] hover:bg-[#F3F4F6]"}`}
            >
              <span className="truncate">{choice.created ? `Create “${choice.label}”` : choice.label}</span>
              {choice.created ? <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-extrabold uppercase text-blue-700">New</span> : null}
            </button>
          )) : (
            <div className="px-3 py-2 text-[12px] font-medium text-[#8C8889]">No matches</div>
          )}
        </div>
      ) : null}
      {allowCreate && normalizedValue && !exactMatch ? (
        <div id={helpId} className="mt-1 text-[11px] font-medium text-[#2563EB]">
          {createHelpText || "New value — created only when the product is saved."}
        </div>
      ) : null}
    </div>
  );
}
