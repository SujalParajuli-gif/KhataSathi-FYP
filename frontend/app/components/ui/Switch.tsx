type SwitchProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
};

export default function Switch({ checked, onChange, ariaLabel, disabled = false }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 !h-6 !w-11 !min-h-[24px] !max-h-[24px] !min-w-[44px] !max-w-[44px] shrink-0 items-center rounded-full border p-0 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45 ${
        checked ? "border-[#11120d] bg-[#11120d]" : "border-slate-300 bg-slate-200"
      }`}
    >
      <span
        className={`pointer-events-none absolute left-[2px] top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-white border border-slate-200 transition-transform duration-150 ${
          checked ? "translate-x-5 border-[#11120d]" : "translate-x-0"
        }`}
      />
    </button>
  );
}
