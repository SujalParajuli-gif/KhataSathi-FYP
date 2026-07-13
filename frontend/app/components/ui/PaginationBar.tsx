import Icon from "./Icon";

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
  pageSizeOptions = [20, 50, 100],
  onPageChange,
  onPageSizeChange,
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
  className?: string;
}) {
  const safeTotalPages = Math.max(1, totalPages);
  const safePage = clampPage(page, 1, safeTotalPages);
  const paginationItems = buildPaginationItems(safePage, safeTotalPages);

  return (
    <div
      className={cn(
        "flex flex-col gap-[12px] border-t border-[#CFCFD3] bg-white px-4 py-3 text-[13px] text-[#565449] lg:flex-row lg:items-center lg:justify-between",
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
          <select
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            className="h-[34px] rounded-[10px] border border-[#CFCFD3] bg-white px-[10px] text-[12px] font-bold text-[#565449] outline-none"
          >
            {pageSizeOptions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
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

        {paginationItems.map((item) =>
          typeof item !== "number" ? (
            <span
              key={item}
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
  );
}
