import { useEffect, useState } from "react";
import Icon from "./Icon";

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function clampPage(page: number, totalPages: number) {
  return Math.min(Math.max(1, totalPages), Math.max(1, page));
}

export default function MobilePaginationFooter({
  page,
  totalPages,
  total,
  start,
  end,
  label = "records",
  pageSize,
  pageSizeOptions = [10, 20, 50, 100],
  onPageChange,
  onPageSizeChange,
  showPageSize = true,
  className,
}: {
  page: number;
  totalPages: number;
  total: number;
  start: number;
  end: number;
  label?: string;
  pageSize: number;
  pageSizeOptions?: number[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  showPageSize?: boolean;
  className?: string;
}) {
  const safeTotalPages = Math.max(1, totalPages);
  const safePage = clampPage(page, safeTotalPages);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [goPage, setGoPage] = useState(String(safePage));
  const first = total === 0 ? 0 : start + 1;
  const displayLabel = total === 1 ? label.replace(/s$/u, "") : label;

  useEffect(() => setGoPage(String(safePage)), [safePage]);

  function changePage(nextPage: number, closeSheet = false) {
    onPageChange(clampPage(nextPage, safeTotalPages));
    if (closeSheet) setSheetOpen(false);
  }

  return (
    <>
      <div className={cn("flex items-center justify-between gap-3 bg-white px-1 py-2 lg:hidden", className)}>
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className="min-h-11 min-w-0 text-left text-[13px] leading-5 text-[#565449]"
          aria-label={`Open pagination. Page ${safePage} of ${safeTotalPages}`}
        >
          Showing <strong className="text-[#11120D]">{first}–{end}</strong> of{" "}
          <strong className="text-[#11120D]">{total}</strong> {displayLabel}
        </button>

        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={safePage <= 1}
            onClick={() => changePage(safePage - 1)}
            className="inline-flex h-11 w-11 items-center justify-center rounded-[11px] border border-[#CFCFD3] bg-white text-[#11120D] transition active:scale-95 disabled:pointer-events-none disabled:opacity-35"
            aria-label="Previous page"
          >
            <Icon name="chevron_left" className="text-[22px]" />
          </button>
          <button
            type="button"
            disabled={safePage >= safeTotalPages}
            onClick={() => changePage(safePage + 1)}
            className="inline-flex h-11 w-11 items-center justify-center rounded-[11px] border border-[#CFCFD3] bg-white text-[#11120D] transition active:scale-95 disabled:pointer-events-none disabled:opacity-35"
            aria-label="Next page"
          >
            <Icon name="chevron_right" className="text-[22px]" />
          </button>
        </div>
      </div>

      {sheetOpen ? (
        <div className="fixed inset-0 z-[160] lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-slate-950/50"
            onClick={() => setSheetOpen(false)}
            aria-label="Close pagination"
          />
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Pagination"
            className="absolute inset-x-0 bottom-0 rounded-t-[26px] bg-white px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3 shadow-2xl"
          >
            <div className="mx-auto h-1.5 w-14 rounded-full bg-[#CFCFD3]" />
            <div className="mt-3 flex items-center justify-between">
              <h2 className="text-[21px] font-extrabold text-[#11120D]">Pagination</h2>
              <button type="button" onClick={() => setSheetOpen(false)} className="inline-flex h-11 w-11 items-center justify-center" aria-label="Close pagination">
                <Icon name="close" className="text-[26px]" />
              </button>
            </div>

            {showPageSize ? <>
            <div className="mt-4 text-[13px] font-extrabold text-[#11120D]">Items per page</div>
            <div className="mt-2 grid overflow-hidden rounded-[12px] border border-[#CFCFD3]" style={{ gridTemplateColumns: `repeat(${pageSizeOptions.length}, minmax(0, 1fr))` }}>
              {pageSizeOptions.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    onPageSizeChange(value);
                    setGoPage("1");
                  }}
                  className={cn(
                    "h-[52px] border-r border-[#CFCFD3] text-[14px] font-extrabold last:border-r-0",
                    pageSize === value ? "bg-[#11120D] text-white" : "bg-white text-[#11120D]",
                  )}
                >
                  {value}
                </button>
              ))}
            </div>
            </> : null}

            <div className={cn("flex items-center justify-between gap-4", showPageSize ? "mt-5" : "mt-4")}>
              <button type="button" disabled={safePage <= 1} onClick={() => changePage(safePage - 1)} className="inline-flex h-14 w-14 items-center justify-center rounded-full border border-[#CFCFD3] disabled:opacity-35" aria-label="Previous page">
                <Icon name="chevron_left" className="text-[29px]" />
              </button>
              <div className="text-center text-[20px] font-extrabold text-[#11120D]">Page {safePage} of {safeTotalPages}</div>
              <button type="button" disabled={safePage >= safeTotalPages} onClick={() => changePage(safePage + 1)} className="inline-flex h-14 w-14 items-center justify-center rounded-full border border-[#CFCFD3] disabled:opacity-35" aria-label="Next page">
                <Icon name="chevron_right" className="text-[29px]" />
              </button>
            </div>

            <label className="mt-5 block text-[13px] font-extrabold text-[#11120D]" htmlFor="mobile-pagination-page">Go to page</label>
            <div className="mt-2 flex overflow-hidden rounded-[12px] border border-[#CFCFD3]">
              <input id="mobile-pagination-page" type="number" inputMode="numeric" min={1} max={safeTotalPages} value={goPage} onChange={(event) => setGoPage(event.target.value)} className="h-[52px] min-w-0 flex-1 px-3 text-[15px] font-semibold outline-none" />
              <button type="button" onClick={() => changePage(Number(goPage) || 1, true)} className="w-24 bg-[#11120D] text-[15px] font-extrabold text-white">Go</button>
            </div>
            <div className="mt-4 text-center text-[13px] text-[#6B7280]">Showing {first}–{end} of {total} {displayLabel}</div>
          </section>
        </div>
      ) : null}
    </>
  );
}
