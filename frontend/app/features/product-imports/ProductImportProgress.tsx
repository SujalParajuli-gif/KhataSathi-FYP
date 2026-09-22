import Icon from "~/components/ui/Icon";

const STAGES = ["Upload", "Extract", "Review", "Import"] as const;

type ProductImportProgressProps = {
  activeStage: 0 | 1 | 2 | 3 | 4;
  className?: string;
};

export default function ProductImportProgress({
  activeStage,
  className = "",
}: ProductImportProgressProps) {
  return (
    <nav
      aria-label="Import progress"
      className={`shrink-0 border border-[#D8DBE0] bg-white px-2.5 py-2 sm:px-3 ${className}`}
    >
      <div className="flex items-center justify-between sm:hidden">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#11120d] text-[10px] font-extrabold text-white">
            {Math.min(activeStage + 1, STAGES.length)}
          </span>
          <span className="text-[11px] font-extrabold text-[#11120d]">
            Step {Math.min(activeStage + 1, STAGES.length)} of {STAGES.length}: {STAGES[Math.min(activeStage, STAGES.length - 1)]}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {STAGES.map((label, idx) => (
            <span
              key={label}
              className={`h-1.5 rounded-full transition-all ${
                idx < activeStage
                  ? "w-4 bg-[#179B4D]"
                  : idx === activeStage
                    ? "w-6 bg-[#11120d]"
                    : "w-2 bg-[#ECEFF3]"
              }`}
            />
          ))}
        </div>
      </div>

      <ol className="hidden sm:grid sm:grid-cols-4 sm:gap-1" role="list">
        {STAGES.map((label, index) => {
          const done = index < activeStage;
          const current = index === activeStage;
          return (
            <li
              key={label}
              className="flex min-w-0 items-center gap-1.5"
              aria-current={current ? "step" : undefined}
            >
              <span
                className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-extrabold ${done
                  ? "bg-[#179B4D] text-white"
                  : current
                    ? "bg-[#11120d] text-white"
                    : "bg-[#ECEFF3] text-[#64748B]"
                  }`}
              >
                {done ? <Icon name="check" sizePx={14} /> : index + 1}
              </span>
              <span
                className={`truncate text-[10px] font-bold sm:text-[11px] ${done || current ? "text-[#11120d]" : "text-[#7A7F89]"}`}
              >
                {label}
              </span>
              {index < STAGES.length - 1 ? (
                <span aria-hidden="true" className="hidden h-px min-w-2 flex-1 bg-[#D8DBE0] sm:block" />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
