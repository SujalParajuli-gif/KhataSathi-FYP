import React, { useEffect, useState, useRef } from "react";
import { getProductImportReviewApi } from "~/lib/api/endpoints";

export interface ImportFloatingPillProps {
  batchId?: string;
  fileName?: string;
  progressPercent?: number;
  completedPages?: number;
  totalPages?: number;
  onClick: () => void;
  onComplete?: (batchId: string) => void;
  onError?: (error: string) => void;
}

export function ImportFloatingPill({
  batchId,
  fileName: propFileName,
  progressPercent: propProgressPercent,
  completedPages: propCompletedPages,
  totalPages: propTotalPages,
  onClick,
  onComplete,
  onError,
}: ImportFloatingPillProps) {
  const [polledPercent, setPolledPercent] = useState(propProgressPercent ?? 15);
  const [polledPages, setPolledPages] = useState(propCompletedPages ?? 0);
  const [polledTotalPages, setPolledTotalPages] = useState(propTotalPages ?? 0);
  const [polledFileName, setPolledFileName] = useState(propFileName || "Supplier Rate List");
  const [statusMessage, setStatusMessage] = useState("");
  const completedRef = useRef(false);

  useEffect(() => {
    if (!batchId || propProgressPercent !== undefined || completedRef.current) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const result = await getProductImportReviewApi(batchId, { page: 1, pageSize: 1 });
        if (stopped) return;
        setStatusMessage("");

        if (result.batch.fileName) {
          setPolledFileName(result.batch.fileName);
        }

        const comp = result.coverage?.completed || 0;
        const tot = typeof result.coverage?.total === "number" ? result.coverage.total : 0;
        setPolledPages(comp);
        setPolledTotalPages(tot);

        const pct = tot > 0
          ? Math.min(100, Math.max(8, Math.round((comp / tot) * 100)))
          : 22;
        setPolledPercent(pct);

        if (result.batch.status === "DRAFT") {
          completedRef.current = true;
          onComplete?.(batchId);
          return;
        }

        if (["FAILED", "INTERRUPTED", "CANCELLING"].includes(result.batch.status)) {
          completedRef.current = true;
          onError?.(result.batch.status === "INTERRUPTED"
            ? "Extraction was interrupted; completed pages are saved."
            : "Extraction failed or was cancelled.");
          return;
        }
      } catch (err: any) {
        if (!stopped && err?.response?.status === 404) {
          completedRef.current = true;
          onError?.("Import session expired.");
          return;
        }
        if (!stopped) setStatusMessage("Status connection lost; retrying…");
      }

      if (!stopped && !completedRef.current) {
        timer = setTimeout(poll, 2500);
      }
    };

    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [batchId, propProgressPercent, onComplete, onError]);

  const displayPercent = propProgressPercent ?? polledPercent;
  const displayFileName = propFileName || polledFileName;
  const displayCompletedPages = propCompletedPages ?? polledPages;
  const displayTotalPages = propTotalPages ?? polledTotalPages;

  return (
    <button
      type="button"
      onClick={onClick}
      className="fixed bottom-5 right-5 z-[80] flex items-center gap-3 rounded-full border border-slate-200 bg-white/95 px-4 py-2.5 shadow-2xl backdrop-blur-md transition-all hover:scale-105 hover:border-slate-300 active:scale-95 text-left group"
      title="Click to view extraction progress"
    >
      <div className="relative flex h-8 w-8 shrink-0 items-center justify-center">
        {/* Continuous ambient rotating track */}
        <div className="absolute inset-0 rounded-full animate-spin [animation-duration:2.2s]">
          <div className="h-full w-full rounded-full border-2 border-slate-200 border-t-[#11120d]" />
        </div>
        <span className="text-[10.5px] font-black tabular-nums text-[#11120d]">
          {displayPercent}%
        </span>
      </div>

      <div className="min-w-0 pr-1">
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-blue-600 animate-ping" />
          <span className="truncate max-w-[140px] text-[12px] font-extrabold text-slate-900">
            {displayFileName}
          </span>
        </div>
        <div className="text-[10.5px] font-medium text-slate-500">
          {statusMessage || (displayTotalPages > 0 ? `${displayCompletedPages} of ${displayTotalPages} pages complete` : "Extracting…")} • Click to view
        </div>
      </div>
    </button>
  );
}
