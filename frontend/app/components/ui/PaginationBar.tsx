import Icon from "./Icon";
import ProjectSelect from "./ProjectSelect";
import MobilePaginationFooter from "./MobilePaginationFooter";

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function clampPage(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function buildPaginationItems(page: number, totalPages: number) {
  const items: Array<number | "ellipsis-start" | "ellipsis-end"> = [];
  const safeTotalPages = Math.max(1, totalPages);
  const safePage = clampPage(page, 1, safeTotalPages);
  const windowStart = Math.max(2, safePage - 2);
  const windowEnd = Math.min(safeTotalPages - 1, safePage + 2);

  items.push(1);

  if (windowStart > 2) items.push("ellipsis-start");

  for (let pageNumber = windowStart; pageNumber <= windowEnd; pageNumber += 1) {
    items.push(pageNumber);
  }

  if (windowEnd < safeTotalPages - 1) items.push("ellipsis-end");
  if (safeTotalPages > 1) items.push(safeTotalPages);

  return items;
}

export default function PaginationBar({
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
  className,
  variant = "modern",
  showSinglePageControls = false,
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
  className?: string;
  variant?: "classic" | "modern";
  showSinglePageControls?: boolean;
}) {
  const safeTotalPages = Math.max(1, totalPages);
  const safePage = clampPage(page, 1, safeTotalPages);
  const paginationItems = buildPaginationItems(safePage, safeTotalPages);
  const mobileFooter = (
    <MobilePaginationFooter
      page={safePage}
      totalPages={safeTotalPages}
      total={total}
      start={start}
      end={end}
      label={label}
      pageSize={pageSize}
      pageSizeOptions={pageSizeOptions}
      onPageChange={onPageChange}
      onPageSizeChange={onPageSizeChange}
      className={className}
    />
  );

  if (variant === "modern" && safeTotalPages === 1 && !showSinglePageControls) {
    return (
      <>
      {mobileFooter}
      <div
        className={cn(
          "hidden min-h-14 w-full items-center justify-center bg-white px-4 py-3 text-[13px] font-semibold text-slate-500 lg:flex",
          className,
        )}
      >
        {total.toLocaleString()} {total === 1 ? label.replace(/s$/u, "") : label}
      </div>
      </>
    );
  }

  if (variant === "classic") {
    return (
      <>
      {mobileFooter}
      <div
        className={cn(
          "hidden gap-[12px] border-t border-[#CFCFD3] bg-white px-4 py-3 text-[13px] text-[#565449] lg:flex lg:flex-row lg:items-center lg:justify-between",
          className,
        )}
      >
        <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[8px]">
          <div>
            Showing{" "}
            <span className="font-semibold text-[#000000]">
              {total === 0 ? 0 : start + 1}
            </span>
            -<span className="font-semibold text-[#000000]">{end}</span> of{" "}
            <span className="font-semibold text-[#000000]">{total}</span>{" "}
            {label}
          </div>

          <label className="flex items-center gap-[8px] text-[12px] font-semibold text-[#8C8889]">
            Rows
            <ProjectSelect
              value={pageSize}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
              className="h-[34px] rounded-[10px] border border-[#CFCFD3] bg-white px-[10px] text-[12px] font-bold text-[#565449] outline-none"
            >
              {pageSizeOptions.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </ProjectSelect>
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-[8px] lg:justify-end">
          <button
            type="button"
            aria-label="Previous page"
            disabled={safePage <= 1}
            onClick={() => onPageChange(clampPage(safePage - 1, 1, safeTotalPages))}
            className="inline-flex h-[32px] w-[32px] items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-white text-[#565449] transition hover:bg-[#F3F4F6] disabled:pointer-events-none disabled:opacity-40"
          >
            <Icon name="chevron_left" className="text-[18px]" />
          </button>

          {paginationItems.map((item, index) =>
            typeof item !== "number" ? (
              <span
                key={`${item}-${index}`}
                className="inline-flex h-[32px] min-w-[24px] items-center justify-center text-[12px] font-extrabold text-[#8C8889]"
              >
                ...
              </span>
            ) : (
              <button
                key={item}
                type="button"
                onClick={() => onPageChange(item)}
                className={cn(
                  "inline-flex h-[32px] min-w-[32px] items-center justify-center rounded-[10px] border px-[8px] text-[12px] font-extrabold transition",
                  item === safePage
                    ? "border-[#11120d] bg-[#11120d] text-white"
                    : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6]",
                )}
              >
                {item}
              </button>
            ),
          )}

          <button
            type="button"
            aria-label="Next page"
            disabled={safePage >= safeTotalPages}
            onClick={() => onPageChange(clampPage(safePage + 1, 1, safeTotalPages))}
            className="inline-flex h-[32px] w-[32px] items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-white text-[#565449] transition hover:bg-[#F3F4F6] disabled:pointer-events-none disabled:opacity-40"
          >
            <Icon name="chevron_right" className="text-[18px]" />
          </button>

          <label className="ml-[4px] flex items-center gap-[8px] text-[12px] font-semibold text-[#8C8889]">
            Go
            <input
              type="number"
              min={1}
              max={safeTotalPages}
              value={safePage}
              onChange={(event) => {
                const nextPage = Number(event.target.value);
                if (Number.isFinite(nextPage)) {
                  onPageChange(clampPage(nextPage, 1, safeTotalPages));
                }
              }}
              className="h-[34px] w-[74px] rounded-[10px] border border-[#CFCFD3] bg-white px-[10px] text-center text-[12px] font-bold text-[#565449] outline-none"
              aria-label="Go to page"
            />
            <span>of {safeTotalPages}</span>
          </label>
        </div>
      </div>
      </>
    );
  }

  return (
    <>
    {mobileFooter}
    <div
      className={cn(
        "hidden gap-6 bg-white px-6 py-5 text-[13px] text-slate-500 lg:flex lg:flex-row lg:items-center lg:justify-between w-full",
        className,
      )}
    >
      <div className="hidden lg:block flex-1">
        Showing {total === 0 ? 0 : start + 1} to {end} of {total} entries
      </div>

      <div className="flex flex-wrap items-center justify-center gap-1 order-1 lg:order-none">
        {/* First Page */}
        <button
          type="button"
          aria-label="First page"
          disabled={safePage <= 1}
          onClick={() => onPageChange(1)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-[#F3F4F6] text-slate-600 transition hover:bg-slate-200 disabled:opacity-50"
        >
          <Icon name="keyboard_double_arrow_left" className="text-[18px]" />
        </button>

        {/* Prev Page */}
        <button
          type="button"
          aria-label="Previous page"
          disabled={safePage <= 1}
          onClick={() => onPageChange(clampPage(safePage - 1, 1, safeTotalPages))}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-[#F3F4F6] text-slate-600 transition hover:bg-slate-200 disabled:opacity-50"
        >
          <Icon name="chevron_left" className="text-[18px]" />
        </button>

        {paginationItems.map((item, index) =>
          typeof item !== "number" ? (
            <span
              key={`${item}-${index}`}
              className="inline-flex h-8 min-w-[32px] items-center justify-center text-[13px] font-bold text-slate-600"
            >
              ...
            </span>
          ) : (
            <button
              key={item}
              type="button"
              onClick={() => onPageChange(item)}
              className={cn(
                "inline-flex h-8 min-w-[32px] items-center justify-center rounded-md px-2 text-[13px] font-bold transition",
                item === safePage
                  ? "bg-[#11120d] text-white"
                  : "bg-[#F3F4F6] text-slate-700 hover:bg-slate-200",
              )}
            >
              {item}
            </button>
          ),
        )}

        {/* Next Page */}
        <button
          type="button"
          aria-label="Next page"
          disabled={safePage >= safeTotalPages}
          onClick={() => onPageChange(clampPage(safePage + 1, 1, safeTotalPages))}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-[#F3F4F6] text-slate-600 transition hover:bg-slate-200 disabled:opacity-50"
        >
          <Icon name="chevron_right" className="text-[18px]" />
        </button>

        {/* Last Page */}
        <button
          type="button"
          aria-label="Last page"
          disabled={safePage >= safeTotalPages}
          onClick={() => onPageChange(safeTotalPages)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-[#F3F4F6] text-slate-600 transition hover:bg-slate-200 disabled:opacity-50"
        >
          <Icon name="keyboard_double_arrow_right" className="text-[18px]" />
        </button>

        {/* Go to Page */}
        <div className="flex items-center gap-1 ml-2">
          <input
            type="number"
            min={1}
            max={safeTotalPages}
            value={safePage}
            onChange={(event) => {
              const nextPage = Number(event.target.value);
              if (Number.isFinite(nextPage)) {
                onPageChange(clampPage(nextPage, 1, safeTotalPages));
              }
            }}
            className="h-8 w-10 rounded-md border border-[#CFCFD3] bg-white text-center text-[13px] font-bold text-slate-700 outline-none hover:bg-slate-50 appearance-none m-0"
            aria-label="Go to page"
            style={{ MozAppearance: 'textfield' }}
          />
          <button
            type="button"
            className="text-[14px] font-medium text-[#11120d] flex items-center transition hover:opacity-70"
          >
            Go <Icon name="chevron_right" className="text-[18px] ml-0.5" />
          </button>
        </div>
      </div>

      <div className="flex flex-1 justify-center lg:justify-end items-center gap-2 order-2 lg:order-none">
        <span className="lg:hidden text-[14px] text-slate-600 font-medium">showing</span>
        <div className="relative">
          <ProjectSelect
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            className="h-8 rounded-md border border-[#CFCFD3] bg-white pl-3 pr-7 text-[14px] font-bold text-slate-700 outline-none hover:bg-slate-50 cursor-pointer appearance-none"
          >
            {pageSizeOptions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </ProjectSelect>
          <Icon name="arrow_drop_down" className="absolute right-1 top-1/2 -translate-y-1/2 text-[20px] text-slate-600 pointer-events-none" />
        </div>
        <span className="lg:hidden text-[14px] text-slate-600 font-medium">items out of {total}</span>
        <span className="hidden lg:inline-block text-[13px] text-slate-500 font-medium">per page</span>
      </div>
    </div>
    </>
  );
}
