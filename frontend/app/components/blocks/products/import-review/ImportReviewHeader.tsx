import type { Dispatch, SetStateAction } from "react";
import Icon from "~/components/ui/Icon";
import type { ProductImportReviewPage } from "~/lib/api/endpoints";
import type { MobilePanel } from "./shared";

type ReviewHistoryEntrySummary = { label: string };

export function ImportReviewHeader({
  review,
  commitUnknown,
  recoverCommit,
  processingAction,
  dirty,
  changeProcessing,
  fileBrandSuggestion,
  setBatchBrand,
  setBatchBrandOpen,
  setExitConfirmOpen,
  setCommitOpen,
  setMobileMenuOpen,
  downloadSource,
  setPriceSetupOpen,
  requestHistoryAction,
  historyBusy,
  undoStack,
  redoStack,
  commitResult,
  navigate,
  mobilePanel,
  setMobilePanel,
  activeRow,
}: {
  review: ProductImportReviewPage | null;
  commitUnknown: boolean;
  recoverCommit: () => void | Promise<void>;
  processingAction: boolean;
  dirty: boolean;
  changeProcessing: (action: "cancel" | "retry" | "reprocess_empty", pageNumbers?: number[]) => void | Promise<void>;
  fileBrandSuggestion: string;
  setBatchBrand: Dispatch<SetStateAction<string>>;
  setBatchBrandOpen: Dispatch<SetStateAction<boolean>>;
  setExitConfirmOpen: Dispatch<SetStateAction<boolean>>;
  setCommitOpen: Dispatch<SetStateAction<boolean>>;
  setMobileMenuOpen: Dispatch<SetStateAction<boolean>>;
  downloadSource: () => void | Promise<void>;
  setPriceSetupOpen: Dispatch<SetStateAction<boolean>>;
  requestHistoryAction: (direction: "undo" | "redo") => void;
  historyBusy: boolean;
  undoStack: ReviewHistoryEntrySummary[];
  redoStack: ReviewHistoryEntrySummary[];
  commitResult: {
    createdCount: number;
    updatedCount?: number;
    keptCount?: number;
    ignoredCount?: number;
    errorCount: number;
  } | null;
  navigate: (path: string) => void;
  mobilePanel: MobilePanel;
  setMobilePanel: Dispatch<SetStateAction<MobilePanel>>;
  activeRow: unknown;
}) {
  return (
    <>
      {commitUnknown ? <div role="alert" className="shrink-0 rounded-lg bg-amber-50 p-3 text-sm">A previous import attempt needs a status check before another submission. <button className="font-bold underline" onClick={() => void recoverCommit()}>Check saved result</button></div> : null}
      {review?.coverage && (review.coverage.total > 0 || review.coverage.requiresAcknowledgement) ? <div className="shrink-0 rounded-lg border bg-white p-3 text-sm">
        <span>{review.coverage.completed} / {review.coverage.total || "unknown"} source pages processed.</span>
        {review.coverage.requiresAcknowledgement ? <span className="ml-2 text-amber-800">Some source pages remain unread or incomplete. {review.coverage.failedPages.map((entry) => `Page ${entry.pageNumber}`).join(", ")}. {review.coverage.canRetry ? <button disabled={processingAction || dirty} className="font-bold underline" onClick={() => void changeProcessing("retry")}>Retry failed or unvisited pages</button> : <span>Upload a crop or the missing source area as a new import.</span>}</span> : null}
        {review.coverage.canReprocessEmpty ? <button disabled={processingAction || dirty} className="ml-2 font-bold text-amber-800 underline" onClick={() => void changeProcessing("reprocess_empty", review.coverage.emptyPageNumbers)}>Recheck pages marked empty</button> : null}
        {review.coverage.failedPages.map((entry) => entry.message ? <p key={entry.pageNumber} className="mt-1 text-amber-800">Page {entry.pageNumber}: {entry.message}</p> : null)}
        {typeof review.batch.extractionMeta?.jobError === "string" ? <p role="alert" className="mt-1 text-amber-800">{review.batch.extractionMeta.jobError}</p> : null}
      </div> : null}
      {review && Number(review.reviewCounts?.missingBrand || 0) > 0 ? (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-[12px] border border-amber-200 bg-amber-50 px-3 py-2.5 text-[11px] text-amber-950">
          <div><strong className="font-extrabold">Brand confirmation required.</strong> Catalog matching is incomplete until each product has a confirmed brand.</div>
          <button type="button" disabled={dirty} onClick={() => { setBatchBrand(fileBrandSuggestion); setBatchBrandOpen(true); }} className="h-9 rounded-[9px] border border-amber-300 bg-white px-3 font-extrabold transition hover:bg-amber-100 disabled:opacity-40">Fill missing brands</button>
        </div>
      ) : null}

      {/* Universal 1-Row Responsive Header */}
      <header className="flex shrink-0 items-center justify-between gap-2 rounded-[14px] border border-[#D8DBE0] bg-white p-2 sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <button
            type="button"
            onClick={() => setExitConfirmOpen(true)}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-white text-[#11120d] transition hover:bg-[#F3F4F6] sm:h-10 sm:w-10 sm:rounded-[11px]"
            aria-label="Back to products"
          >
            <Icon name="arrow_back" sizePx={18} />
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-[14px] font-extrabold leading-tight text-[#11120d] sm:text-[18px] xl:text-[20px]">
              {review?.batch.fileName || "Product import review"}
            </h1>
            <p className="mt-0.5 truncate text-[10.5px] font-medium text-[#64748B] sm:text-[11px]">
              {review ? `${review.batch.totalRows.toLocaleString()} extracted rows · ${review.batch.supplier || review.batch.sourceType}` : "Loading review…"}
            </p>
          </div>
        </div>

        {/* Mobile Right CTA Actions */}
        <div className="flex shrink-0 items-center gap-1.5 sm:hidden">
          <button
            type="button"
            onClick={() => setCommitOpen(true)}
            disabled={!review || review.batch.status === "IMPORTED" || (review.priceMapping.required && !review.priceMapping.complete) || review.decisionCounts.create + review.decisionCounts.update + review.decisionCounts.keep + review.decisionCounts.ignore === 0}
            title={review?.priceMapping.required && !review.priceMapping.complete ? "Map the extracted price columns first" : "Review final import"}
            className="inline-flex h-11 items-center gap-1 rounded-[9px] bg-[#11120d] px-3 text-[11px] font-bold text-white transition hover:bg-[#2a2c27] disabled:opacity-40"
          >
            <Icon name="publish" sizePx={15} />
            <span>Import</span>
          </button>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            className="inline-flex h-11 w-11 items-center justify-center rounded-[9px] border border-[#CFCFD3] bg-white text-[#11120d] transition hover:bg-[#F3F4F6]"
            aria-label="More import actions"
          >
            <Icon name="more_vert" sizePx={19} />
          </button>
        </div>

        {/* Desktop Action Toolbar */}
        <div className="hidden sm:flex sm:items-center sm:gap-2">
          <button
            type="button"
            onClick={() => void downloadSource()}
            disabled={!review?.batch.source?.available}
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[10px] border border-[#CFCFD3] bg-white px-3 text-[11px] font-bold text-[#11120d] transition hover:bg-[#F3F4F6] disabled:opacity-40 xl:px-3.5"
            title="Download original source"
          >
            <Icon name="download" sizePx={16} />
            <span className="hidden md:inline">Source</span>
          </button>

          {review?.priceMapping.required ? (
            <button
              type="button"
              onClick={() => setPriceSetupOpen(true)}
              className={`inline-flex h-10 items-center justify-center gap-1.5 rounded-[10px] border px-3 text-[11px] font-bold transition ${!review.priceMapping.complete
                  ? "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
                  : "border-[#D4D7DC] bg-white text-[#374151] hover:bg-[#F3F4F6]"
                }`}
              title={!review.priceMapping.complete ? "Required: Map extracted price columns before final import" : "View or customize file column mapping definitions"}
            >
              <Icon name={!review.priceMapping.complete ? "warning" : "tune"} sizePx={16} className={!review.priceMapping.complete ? "text-amber-700" : "text-[#64748B]"} />
              <span className="hidden md:inline">{!review.priceMapping.complete ? "Map price columns" : "Column mapping"}</span>
              {!review.priceMapping.complete ? (
                <span className="rounded-full bg-amber-200/80 px-1.5 py-0.2 text-[9.5px] font-extrabold text-amber-900">
                  Required
                </span>
              ) : null}
            </button>
          ) : null}

          <div className="inline-flex rounded-[10px] border border-[#CFCFD3] bg-white p-0.5">
            <button
              type="button"
              onClick={() => requestHistoryAction("undo")}
              disabled={historyBusy || undoStack.length === 0}
              className="inline-flex h-8.5 w-8.5 items-center justify-center rounded-[8px] text-[#11120d] transition hover:bg-[#F3F4F6] disabled:opacity-30"
              title={undoStack.length ? `Undo: ${undoStack.at(-1)?.label}` : "Nothing to undo"}
              aria-label={undoStack.length ? `Undo ${undoStack.at(-1)?.label}` : "Nothing to undo"}
            >
              <Icon name="undo" sizePx={16} />
            </button>
            <button
              type="button"
              onClick={() => requestHistoryAction("redo")}
              disabled={historyBusy || redoStack.length === 0}
              className="inline-flex h-8.5 w-8.5 items-center justify-center rounded-[8px] text-[#11120d] transition hover:bg-[#F3F4F6] disabled:opacity-30"
              title={redoStack.length ? `Redo: ${redoStack.at(-1)?.label}` : "Nothing to redo"}
              aria-label={redoStack.length ? `Redo ${redoStack.at(-1)?.label}` : "Nothing to redo"}
            >
              <Icon name="redo" sizePx={16} />
            </button>
          </div>

          <button
            type="button"
            onClick={() => setCommitOpen(true)}
            disabled={!review || review.batch.status === "IMPORTED" || (review.priceMapping.required && !review.priceMapping.complete) || review.decisionCounts.create + review.decisionCounts.update + review.decisionCounts.keep + review.decisionCounts.ignore === 0}
            title={review?.priceMapping.required && !review.priceMapping.complete ? "Map the extracted price columns first" : "Review final import"}
            className="hidden h-10 items-center gap-2 rounded-[10px] bg-[#11120d] px-4 text-[12px] font-bold text-white transition hover:bg-[#2a2c27] disabled:opacity-40 sm:inline-flex"
          >
            <Icon name="publish" sizePx={16} />
            <span>Final import</span>
          </button>
        </div>
      </header>

      {commitResult ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[14px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-[11px] font-bold text-emerald-900">
          <span>Last commit: {commitResult.createdCount} created · {commitResult.updatedCount || 0} updated · {commitResult.keptCount || 0} kept · {commitResult.ignoredCount || 0} ignored · {commitResult.errorCount} failed</span>
          <button type="button" onClick={() => navigate("/products")} className="rounded-[9px] bg-emerald-800 px-3 py-2 text-white">View products</button>
        </div>
      ) : null}

      {/* Compact Segmented Mobile View Switcher */}
      <div className="flex shrink-0 gap-1 rounded-[10px] border border-[#D8DBE0] bg-[#F1F3F5] p-1 xl:hidden">
        {(["list", "editor", "source"] as MobilePanel[]).map((panel) => (
          <button
            key={panel}
            type="button"
            onClick={() => setMobilePanel(panel)}
            disabled={panel !== "list" && !activeRow}
            className={`h-10 flex-1 rounded-[7px] text-[11px] font-extrabold capitalize transition ${mobilePanel === panel
                ? "bg-white text-[#11120d]"
                : "text-[#64748B] hover:text-[#11120d]"
              }`}
          >
            {panel === "list" ? `List (${review?.pagination.total || 0})` : panel === "editor" ? "Item Editor" : "Source Doc"}
          </button>
        ))}
      </div>
    </>
  );
}
