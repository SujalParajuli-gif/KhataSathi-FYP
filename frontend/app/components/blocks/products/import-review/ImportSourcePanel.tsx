import type { RefObject } from "react";
import Icon from "~/components/ui/Icon";
import type { ProductImportReviewPage, ProductImportRow, getProductImportSourceContextApi } from "~/lib/api/endpoints";
import {
  displayImportSourceRegion,
  readableSourceHeader,
  sourceCellHasValue,
  sourcePreviewColumnWidth,
} from "~/features/product-imports/reviewModel";
import { cellsFromRow, type MobilePanel } from "./shared";

type SourceContextRow = Awaited<ReturnType<typeof getProductImportSourceContextApi>>["rows"][number];

export function ImportSourcePanel({
  mobilePanel,
  review,
  activeRow,
  activeRowId,
  productNameHeader,
  activeSourceEntries,
  setSourceDetailsOpen,
  sourceRows,
  displaySourceHeaders,
  sourceTableWidth,
  chooseRow,
  sourceMimeType,
  sourcePageNumber,
  sourceLoading,
  sourcePreviewUrl,
  region,
  regionScale,
  sourceHighlightRef,
}: {
  mobilePanel: MobilePanel;
  review: ProductImportReviewPage | null;
  activeRow: ProductImportRow | null;
  activeRowId: string;
  productNameHeader: string | null;
  activeSourceEntries: Array<readonly [string, unknown]>;
  setSourceDetailsOpen: (open: boolean) => void;
  sourceRows: SourceContextRow[];
  displaySourceHeaders: string[];
  sourceTableWidth: number;
  chooseRow: (row: ProductImportRow) => void;
  sourceMimeType: string;
  sourcePageNumber: number;
  sourceLoading: boolean;
  sourcePreviewUrl: string;
  region: ReturnType<typeof displayImportSourceRegion>;
  regionScale: number;
  sourceHighlightRef: RefObject<HTMLDivElement | null>;
}) {
  const isSpreadsheet = ["CSV", "XLSX"].includes(review?.batch.sourceType || "");
  return (
    <section className={`${mobilePanel === "source" ? "flex" : "hidden"} h-full min-h-0 flex-col overflow-hidden rounded-[16px] border border-[#D8DBE0] bg-white xl:flex xl:rounded-[18px]`}>
      <div className="flex min-h-[52px] shrink-0 items-center justify-between gap-2 border-b border-[#E2E4E8] bg-white px-3 py-2 sm:px-3.5">
        <div className="min-w-0 shrink-0">
          <div className="flex items-center gap-1.5">
            <h2 className="text-[13px] font-extrabold text-[#11120d] whitespace-nowrap">Source document</h2>
            {isSpreadsheet && activeRow ? (
              <span className="shrink-0 whitespace-nowrap rounded-full border border-[#D8DBE0] bg-[#F1F3F5] px-2 py-0.5 text-[9.5px] font-extrabold text-[#11120d]">
                Row {activeRow.sourceLocator?.rowNumber || activeRow.rowNumber}
              </span>
            ) : null}
          </div>
          <p className="truncate text-[10.5px] font-medium text-[#64748B]">
            {activeRow?.sourceLocator?.sheetName || (sourceMimeType === "application/pdf" ? `Page ${sourcePageNumber}` : isSpreadsheet ? "Spreadsheet context" : review?.batch.fileName)}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          {productNameHeader ? (
            <button
              type="button"
              onClick={() => {
                const nameCell = document.getElementById(`source-cell-name-${activeRowId}`);
                if (nameCell) {
                  nameCell.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
                } else {
                  const rowElem = document.getElementById(`source-row-${activeRowId}`);
                  if (rowElem) {
                    rowElem.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
                  }
                }
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-amber-300/80 bg-amber-50/70 px-2 sm:px-2.5 text-[10.5px] sm:text-[11px] font-bold text-amber-900 transition hover:bg-amber-100 shadow-sm shrink-0 whitespace-nowrap"
              title="Scroll table directly to the Product Name column"
            >
              <Icon name="center_focus_strong" sizePx={14} className="text-amber-600 shrink-0" />
              <span>Snap to Name</span>
            </button>
          ) : null}
          {activeSourceEntries.length > 0 ? (
            <button
              type="button"
              onClick={() => setSourceDetailsOpen(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-[#CFCFD3] bg-white px-2 sm:px-2.5 text-[10.5px] sm:text-[11px] font-bold text-[#11120d] transition hover:bg-[#F3F4F6] shrink-0 whitespace-nowrap"
              title="View all extracted raw values for this row"
            >
              <Icon name="visibility" sizePx={14} className="shrink-0" />
              <span>Details ({activeSourceEntries.length})</span>
            </button>
          ) : null}
          {isSpreadsheet && sourceRows.length > 0 ? (
            <span className="hidden rounded-full border border-[#D8DBE0] bg-[#F7F8FA] px-2 py-0.5 text-[9px] font-extrabold text-[#5F6570] 2xl:inline-block shrink-0 whitespace-nowrap">
              {sourceRows.length} rows
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#F7F8FA] p-2 sm:p-2.5">
        {isSpreadsheet ? (
          displaySourceHeaders.length > 0 ? (
            <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-[#D8DBE0] bg-white">
              <div className="min-h-0 flex-1 overflow-auto overscroll-contain [scrollbar-gutter:stable]">
                <table
                  aria-label="Original spreadsheet rows"
                  className="table-fixed border-separate border-spacing-0 text-left text-[11px]"
                  style={{ width: `${sourceTableWidth}px`, minWidth: "100%" }}
                >
                  <colgroup>
                    <col style={{ width: "56px" }} />
                    {displaySourceHeaders.map((header) => (
                      <col key={header} style={{ width: `${sourcePreviewColumnWidth(header)}px` }} />
                    ))}
                  </colgroup>
                  <thead className="sticky top-0 z-10 bg-[#EFF2F5] text-[#4B5563]">
                    <tr>
                      <th scope="col" className="sticky left-0 z-20 overflow-hidden border-b border-r border-[#D8DBE0] bg-[#EFF2F5] px-2.5 py-2 font-extrabold">Row</th>
                      {displaySourceHeaders.map((header) => (
                        <th
                          key={header}
                          scope="col"
                          className={`overflow-hidden border-b border-r border-[#D8DBE0] px-2.5 py-2 font-extrabold ${header === productNameHeader ? "bg-amber-100/60 text-amber-950 border-b-amber-300" : ""}`}
                        >
                          <div className="truncate flex items-center gap-1" title={readableSourceHeader(header)}>
                            {header === productNameHeader ? <Icon name="star" sizePx={12} className="text-amber-600 shrink-0" /> : null}
                            <span>{readableSourceHeader(header)}</span>
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sourceRows.map((row) => {
                      const cells = cellsFromRow(row);
                      const selected = row.id === activeRowId;
                      return (
                        <tr
                          key={row.id}
                          id={`source-row-${row.id}`}
                          onClick={() => {
                            const match = review?.rows.find((r) => r.id === row.id);
                            if (match) chooseRow(match);
                          }}
                          aria-selected={selected}
                          className={`cursor-pointer transition hover:bg-amber-50/60 ${selected ? "bg-amber-100 outline outline-2 -outline-offset-2 outline-amber-500" : "bg-white"}`}
                        >
                          <td className={`sticky left-0 z-[5] overflow-hidden whitespace-nowrap border-b border-r border-[#E2E4E8] px-2.5 py-2 font-extrabold ${selected ? "bg-amber-100 text-amber-950" : "bg-white text-[#374151]"}`}>
                            {row.sourceLocator?.rowNumber || row.rowNumber}
                          </td>
                          {displaySourceHeaders.map((header) => {
                            const value = cells[header];
                            const isName = header === productNameHeader;
                            return (
                              <td
                                key={header}
                                id={isName && selected ? `source-cell-name-${row.id}` : undefined}
                                className={`overflow-hidden border-b border-r border-[#E2E4E8] px-2.5 py-2 font-semibold ${isName ? (selected ? "bg-amber-200/70 text-amber-950 font-bold" : "bg-amber-50/30 font-semibold text-[#11120d]") : ""
                                  } ${sourceCellHasValue(value) ? (selected ? "text-amber-950 font-bold" : "text-[#374151]") : "text-[#C4C8CE]"}`}
                              >
                                <div className="truncate" title={sourceCellHasValue(value) ? String(value) : undefined}>
                                  {sourceCellHasValue(value) ? String(value) : "—"}
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="rounded-[12px] border border-amber-200 bg-amber-50 p-4 text-[12px] font-semibold text-amber-900">
              This older review has no structured spreadsheet cells. Re-upload the source after the migration to enable exact Excel-row preview.
            </div>
          )
        ) : sourceLoading ? (
          <div className="flex h-full min-h-[320px] items-center justify-center text-[12px] font-extrabold text-[#7A7F89]">
            Rendering source page…
          </div>
        ) : sourcePreviewUrl && sourceMimeType === "application/pdf" && !region ? (
          <iframe
            title="Supplier PDF source"
            src={`${sourcePreviewUrl}#page=${sourcePageNumber}&zoom=page-width&search=${encodeURIComponent(activeRow?.sourceLocator?.searchText || (activeRow ? String((activeRow.rawText || `Row ${activeRow.rowNumber}`)) : ""))}`}
            className="h-full min-h-[420px] w-full rounded-[10px] border border-[#D8DBE0] bg-white"
          />
        ) : sourcePreviewUrl ? (
          <div className="flex h-full min-h-0 items-center justify-center overflow-auto rounded-[10px] border border-[#D8DBE0] bg-white p-2">
            <div className="relative mx-auto w-[820px] max-w-none">
              <img src={sourcePreviewUrl} alt="Supplier catalog source" className="block h-auto w-full max-w-none object-contain" />
              {region ? (
                <div
                  ref={sourceHighlightRef}
                  className="pointer-events-none absolute border-2 border-amber-500 bg-amber-300/25 shadow-[0_0_0_9999px_rgba(15,23,42,0.10)]"
                  style={{
                    top: `${(region.top / regionScale) * 100}%`,
                    left: `${(region.left / regionScale) * 100}%`,
                    width: `${((region.right - region.left) / regionScale) * 100}%`,
                    height: `${((region.bottom - region.top) / regionScale) * 100}%`,
                  }}
                />
              ) : null}
            </div>
          </div>
        ) : (
          <div className="rounded-[12px] border border-amber-200 bg-amber-50 p-4 text-[12px] font-semibold leading-5 text-amber-900">
            The protected original is unavailable for this older review. New uploads retain it automatically.
          </div>
        )}
      </div>
    </section>
  );
}
