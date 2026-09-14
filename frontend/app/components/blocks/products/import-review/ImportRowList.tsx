import type { Dispatch, SetStateAction } from "react";
import Icon from "~/components/ui/Icon";
import ProjectSelect from "~/components/ui/ProjectSelect";
import type { ProductImportReviewPage, ProductImportRow } from "~/lib/api/endpoints";
import { comparisonLabel, importRowNeedsAttention, importRowPriceLabel } from "~/features/product-imports/reviewModel";
import { COMPARISON_FILTERS, rowName, rowSku, statusTone, type MobilePanel, type ReviewFilter } from "./shared";

export function ImportRowList({
  review,
  loading,
  mobilePanel,
  searchInput,
  setSearchInput,
  filter,
  setFilter,
  setPage,
  requestReviewNavigation,
  activeRowId,
  chooseRow,
  selectedIds,
  excludedSelectedIds,
  allMatchingSelected,
  selectedCount,
  allPageRowsSelected,
  togglePageSelection,
  toggleRowSelection,
  clearSelection,
  setAllMatchingSelected,
  setSelectedIds,
  setExcludedSelectedIds,
  pageSize,
  setPageSize,
  pageRangeStart,
  pageRangeEnd,
}: {
  review: ProductImportReviewPage | null;
  loading: boolean;
  mobilePanel: MobilePanel;
  searchInput: string;
  setSearchInput: Dispatch<SetStateAction<string>>;
  filter: ReviewFilter;
  setFilter: Dispatch<SetStateAction<ReviewFilter>>;
  setPage: Dispatch<SetStateAction<number>>;
  requestReviewNavigation: (proceed: () => void, description: string) => void;
  activeRowId: string;
  chooseRow: (row: ProductImportRow) => void;
  selectedIds: Set<string>;
  excludedSelectedIds: Set<string>;
  allMatchingSelected: boolean;
  selectedCount: number;
  allPageRowsSelected: boolean;
  togglePageSelection: () => void;
  toggleRowSelection: (rowId: string) => void;
  clearSelection: () => void;
  setAllMatchingSelected: Dispatch<SetStateAction<boolean>>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  setExcludedSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  pageSize: number;
  setPageSize: Dispatch<SetStateAction<number>>;
  pageRangeStart: number;
  pageRangeEnd: number;
}) {
  return (
    <section className={`${mobilePanel === "list" ? "flex" : "hidden"} h-full min-h-0 flex-col overflow-hidden rounded-[16px] border border-[#D8DBE0] bg-white xl:flex xl:rounded-[18px]`}>
      <div className="shrink-0 space-y-2 border-b border-[#E2E4E8] p-2.5">
        <div className="relative">
          <Icon name="search" sizePx={17} className="absolute left-3 top-2.5 text-[#7A7F89]" />
          <input
            value={searchInput}
            onChange={(event) => {
              const value = event.target.value;
              requestReviewNavigation(() => setSearchInput(value), "Change the product search and discard the changes to the current product.");
            }}
            placeholder="Search name, SKU or source row…"
            className="h-9 w-full rounded-[9px] border border-[#D4D7DC] pl-9 pr-9 text-[12px] font-semibold outline-none focus:border-[#11120d] xl:text-[11px]"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => {
                requestReviewNavigation(() => {
                  setSearchInput("");
                }, "Clear the product search and discard the changes to the current product.");
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-full text-[#7A7F89] hover:bg-slate-100 hover:text-[#11120d] transition"
              aria-label="Clear search"
            >
              <Icon name="close" sizePx={15} />
            </button>
          )}
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          {[
            { value: "ALL" as const, label: "All", count: review?.reviewCounts?.all ?? review?.pagination.total ?? 0 },
            { value: "ATTENTION" as const, label: "Attention", count: review?.reviewCounts?.attention ?? 0 },
            { value: "EDITED" as const, label: "User changes", count: review?.reviewCounts?.edited ?? 0 },
          ].map((item) => {
            const active = filter === item.value;
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => requestReviewNavigation(() => { setFilter(item.value); setPage(1); }, `Open the ${item.label} list and discard the changes to the current product.`)}
                className={`inline-flex h-9 min-w-0 items-center justify-center gap-1 rounded-[9px] border px-2 text-[10.5px] font-extrabold transition touch-manipulation active:scale-[0.97] ${active
                    ? "border-[#11120d] bg-[#11120d] text-white"
                    : "border-[#D4D7DC] bg-white text-[#4B5563] hover:bg-[#F3F4F6]"
                  }`}
              >
                <span className="truncate">{item.label}</span>
                <span className={`rounded-full px-1.5 py-0.2 text-[9px] font-extrabold ${active ? "bg-white/20 text-white" : "bg-slate-100 text-[#4B5563]"}`}>
                  {item.count.toLocaleString()}
                </span>
              </button>
            );
          })}
        </div>

        <ProjectSelect
          className="h-9 w-full"
          value={COMPARISON_FILTERS.some((item) => item.value === filter) ? filter : ""}
          onChange={(event) => {
            const value = event.target.value as ReviewFilter;
            requestReviewNavigation(() => {
              setFilter(value || "ALL");
              setPage(1);
            }, "Change the comparison filter and discard the changes to the current product.");
          }}
          aria-label="More product comparison filters"
        >
          <option value="">More filters: product status</option>
          {COMPARISON_FILTERS.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label} ({review?.comparisonCounts[item.value] ?? 0})
            </option>
          ))}
        </ProjectSelect>

        <div className="flex min-h-[38px] items-center justify-between gap-2 text-[11px] font-extrabold text-[#5F6570]">
          <label className="inline-flex min-h-[38px] cursor-pointer items-center gap-2 py-1 px-1 -ml-1 rounded-lg transition hover:bg-slate-100 active:bg-slate-200 touch-manipulation select-none">
            <input type="checkbox" checked={allPageRowsSelected} onChange={togglePageSelection} className="h-4.5 w-4.5 rounded accent-[#11120d]" />
            <span>Select page</span>
          </label>
          {review && review.pagination.total > 0 ? (
            allMatchingSelected ? (
              <button type="button" onClick={clearSelection} className="inline-flex min-h-[38px] items-center px-1.5 font-bold text-[#11120d] hover:underline active:bg-slate-100 touch-manipulation">
                All {selectedCount.toLocaleString()} selected · Clear
              </button>
            ) : (
              <button type="button" onClick={() => { setAllMatchingSelected(true); setSelectedIds(new Set()); setExcludedSelectedIds(new Set()); }} className="inline-flex min-h-[38px] items-center px-1.5 font-bold text-[#11120d] hover:underline active:bg-slate-100 touch-manipulation">
                Select all {review.pagination.total.toLocaleString()}
              </button>
            )
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain divide-y divide-[#E8EAED]">
        {loading ? (
          <div className="p-6 text-center text-[12px] font-extrabold text-[#7A7F89]">Loading rows…</div>
        ) : review?.rows.length ? (
          review.rows.map((row) => {
            const selected = allMatchingSelected ? !excludedSelectedIds.has(row.id) : selectedIds.has(row.id);
            const active = row.id === activeRowId;
            const ignored = row.resolution === "IGNORE";
            const edited = Boolean(row.reviewChanges?.length);
            const rowBgClass = active && selected
              ? "border-l-[3px] border-l-[#11120d] bg-[#EDF3FA]"
              : active
                ? "border-l-[3px] border-l-[#11120d] bg-[#F1F3F5]"
                : selected
                  ? "border-l-[3px] border-l-blue-400 bg-blue-50/40 hover:bg-blue-50/60"
                  : ignored
                    ? "border-l-[3px] border-l-transparent bg-rose-50/40"
                    : importRowNeedsAttention(row)
                      ? "border-l-[3px] border-l-amber-400 bg-amber-50/45 hover:bg-amber-50/70"
                      : "border-l-[3px] border-l-transparent bg-white hover:bg-[#F8FAFC]";

            return (
              <div
                key={row.id}
                className={`flex min-h-[64px] items-stretch transition ${rowBgClass}`}
              >
                {/* Checkbox Tap Zone: Dedicated 48px wide touch target */}
                <label
                  className="flex w-12 shrink-0 self-stretch cursor-pointer items-center justify-center touch-manipulation select-none active:bg-black/[0.06]"
                  onClick={(e) => e.stopPropagation()}
                  title="Select for bulk editing"
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleRowSelection(row.id)}
                    className="h-5 w-5 rounded-[5px] accent-[#11120d] cursor-pointer"
                    aria-label={`Select ${rowName(row)} for bulk editing`}
                  />
                </label>

                {/* Product Row Hit Target: 100% of the rest of the row is a single, continuous button */}
                <button
                  type="button"
                  onClick={() => chooseRow(row)}
                  className="flex min-w-0 flex-1 items-center justify-between gap-2.5 py-2.5 pr-2.5 text-left touch-manipulation select-none active:bg-black/[0.04] focus:outline-none"
                  aria-label={`Review ${rowName(row)}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className={`truncate text-[13px] font-extrabold leading-snug sm:text-[12px] xl:text-[11.5px] ${ignored ? "text-[#7A7F89] line-through" : "text-[#11120d]"}`}>
                      {rowName(row)}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[10.5px] font-semibold text-[#7A7F89] xl:text-[9.5px]">
                      {rowSku(row)}
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-col items-end justify-center gap-1 min-w-[76px] text-right">
                    <span className={`text-[12px] font-bold tabular-nums sm:text-[11px] ${ignored ? "text-[#7A7F89] line-through" : "text-[#11120d]"}`}>
                      {importRowPriceLabel(row)}
                    </span>
                    <div className="flex items-center gap-1">
                      {edited ? (
                        <span
                          className="inline-flex h-5 items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-1.5 text-[8.5px] font-extrabold text-slate-700"
                          title={`Product corrections after import setup: ${row.reviewChanges?.join(", ")}`}
                        >
                          <Icon name="edit" sizePx={10} /> User changed
                        </span>
                      ) : null}
                      {ignored ? (
                        <span className="inline-flex h-5 items-center justify-center rounded-full border border-rose-200 bg-rose-50 px-1.5 text-[8.5px] font-extrabold text-rose-700" title="Ignored">
                          Ignored
                        </span>
                      ) : (
                        <span className={`inline-flex rounded-full border px-1.5 py-0.2 text-[8.5px] font-extrabold ${statusTone(row.comparisonStatus)}`}>
                          {comparisonLabel(row.comparisonStatus)}
                        </span>
                      )}
                      <Icon name="chevron_right" sizePx={16} className="text-[#9CA3AF]" />
                    </div>
                  </div>
                </button>
              </div>
            );
          })
        ) : (
          <div className="p-6 text-center text-[12px] font-bold text-[#7A7F89]">No rows match this filter.</div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[#E2E4E8] bg-white p-2.5 text-[10px] font-bold text-[#5F6570]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 whitespace-nowrap text-[10px] sm:text-[11px]">{review ? `${pageRangeStart.toLocaleString()}–${pageRangeEnd.toLocaleString()} of ${review.pagination.total.toLocaleString()}` : "0 rows"}</span>
          <ProjectSelect className="h-9 w-[104px] shrink-0" value={String(pageSize)} onChange={(event) => { const value = Number(event.target.value); requestReviewNavigation(() => { setPage(1); setPageSize(value); }, "Change the number of products shown and discard the current unsaved changes."); }} aria-label="Rows per page">
            <option value="25">25 rows</option>
            <option value="50">50 rows</option>
            <option value="100">100 rows</option>
          </ProjectSelect>
        </div>
        <nav className="flex items-center gap-1.5" aria-label="Import rows pagination">
          <button type="button" disabled={!review || review.pagination.page <= 1} onClick={() => requestReviewNavigation(() => setPage((value) => Math.max(1, value - 1)), "Open the previous product page and discard the current unsaved changes.")} className="inline-flex h-9 w-9 items-center justify-center rounded-[8px] border border-[#D4D7DC] bg-white text-[#11120d] transition active:bg-[#F3F4F6] disabled:opacity-35 touch-manipulation" title="Previous page" aria-label="Previous page"><Icon name="chevron_left" sizePx={18} /></button>
          <span className="min-w-[54px] whitespace-nowrap text-center text-[9.5px] font-extrabold text-[#374151]">Page {review?.pagination.page || 1} of {review?.pagination.totalPages || 1}</span>
          <button type="button" disabled={!review || review.pagination.page >= review.pagination.totalPages} onClick={() => requestReviewNavigation(() => setPage((value) => value + 1), "Open the next product page and discard the current unsaved changes.")} className="inline-flex h-9 w-9 items-center justify-center rounded-[8px] border border-[#D4D7DC] bg-white text-[#11120d] transition active:bg-[#F3F4F6] disabled:opacity-35 touch-manipulation" title="Next page" aria-label="Next page"><Icon name="chevron_right" sizePx={18} /></button>
        </nav>
      </div>
    </section>
  );
}
