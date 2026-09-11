import React, { useEffect, useState, useRef } from "react";
import Icon from "~/components/ui/Icon";
import { CircularProgressRing } from "./CircularProgressRing";
import {
  getProductImportReviewApi,
  controlProductImportApi,
  type ProductImportReviewPage,
} from "~/lib/api/endpoints";

export interface ImportProcessingWidgetProps {
  batchId: string;
  fileName?: string;
  sourceType?: string;
  supplier?: string;
  onComplete: (batchId: string) => void;
  onMinimize?: () => void;
  onCancel?: () => void;
  onError?: (message: string) => void;
}

export function ImportProcessingWidget({
  batchId,
  fileName,
  sourceType = "PDF",
  supplier,
  onComplete,
  onMinimize,
  onCancel,
  onError,
}: ImportProcessingWidgetProps) {
  const [review, setReview] = useState<ProductImportReviewPage | null>(null);
  const [error, setError] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const completedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(onError);

  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  // Live elapsed timer
  useEffect(() => {
    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [batchId]);

  // Polling server background worker status
  useEffect(() => {
    if (!batchId || completedRef.current) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const result = await getProductImportReviewApi(batchId, { page: 1, pageSize: 1 });
        if (stopped) return;
        setReview(result);
        setError("");

        if (result.batch.status === "DRAFT") {
          completedRef.current = true;
          onCompleteRef.current(batchId);
          return;
        }

        if (["FAILED", "INTERRUPTED", "CANCELLING"].includes(result.batch.status)) {
          completedRef.current = true;
          const metaMessage = typeof result.batch.extractionMeta?.jobError === "string"
            ? result.batch.extractionMeta.jobError
            : "";
          const msg = result.coverage?.failedPages?.find((page) => page.message)?.message
            || metaMessage
            || (result.batch.status === "INTERRUPTED"
              ? "Extraction was interrupted. Completed pages are saved; retry the remaining pages."
              : "Extraction failed. Retry it, or check the source document.");
          setError(msg);
          onErrorRef.current?.(msg);
          return;
        }
      } catch (err: any) {
        if (!stopped) {
          if (err?.response?.status === 404) {
            completedRef.current = true;
            const notFoundMsg = "Import session expired or not found.";
            setError(notFoundMsg);
            onErrorRef.current?.(notFoundMsg);
            return;
          }
          setError("Status connection lost. Retrying automatically; this import remains saved on the server.");
        }
      }

      if (!stopped && !completedRef.current) {
        timer = setTimeout(poll, 2200);
      }
    };

    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [batchId, retryVersion]);

  async function handleRetry() {
    try {
      setRetrying(true);
      setError("");
      await controlProductImportApi(batchId, "retry");
      completedRef.current = false;
      setRetryVersion((value) => value + 1);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || "Could not retry extraction.");
    } finally {
      setRetrying(false);
    }
  }

  async function handleStop() {
    try {
      setCancelling(true);
      await controlProductImportApi(batchId, "cancel");
      if (onCancel) onCancel();
    } catch (err: any) {
      setError(err?.response?.data?.error || "Could not cancel import processing.");
    } finally {
      setCancelling(false);
    }
  }

  const completedPages = review?.coverage?.completed || 0;
  const totalPages = typeof review?.coverage?.total === "number" ? review.coverage.total : 0;
  const totalRows = review?.pagination?.total ?? review?.batch?.totalRows ?? 0;
  const progressPercent = totalPages > 0
    ? Math.min(100, Math.max(8, Math.round((completedPages / totalPages) * 100)))
    : review?.batch.status === "COMMITTING" ? 75 : 18;
  const isCommitting = review?.batch.status === "COMMITTING";

  const displayName = fileName || review?.batch?.fileName || "Supplier Rate List";
  const displaySource = sourceType || review?.batch?.sourceType || "PDF";

  return (
    <div className="flex w-full items-center justify-center p-2 sm:p-4" role="status" aria-live="polite">
      <div className="w-full max-w-[540px] rounded-[22px] border border-[#D8DBE0] bg-white p-6 sm:p-8 shadow-sm">
        {/* Header bar */}
        <div className="flex items-center justify-between pb-3.5 border-b border-slate-100">
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-[11px] font-extrabold text-blue-700 uppercase tracking-wide">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-600" />
            </span>
            {isCommitting ? "Applying Reviewed Products" : "Extracting Supplier Rate List"}
          </div>
          <span className="tabular-nums text-[12px] font-bold text-slate-500">
            {Math.floor(elapsedSeconds / 60)}:{String(elapsedSeconds % 60).padStart(2, "0")}
          </span>
        </div>

        {/* Circular Loop Progress Hero */}
        <div className="mt-6 flex flex-col items-center text-center">
          <CircularProgressRing
            progress={progressPercent}
            sizePx={100}
            strokeWidth={7}
            centerText={`${progressPercent}%`}
            subText={totalPages > 0 ? `P. ${completedPages}/${totalPages}` : "Reading"}
          />

          <h3 className="mt-4 text-[17px] font-extrabold text-[#0F172A]">
            {totalPages > 0
              ? `${review?.coverage?.visited || completedPages} of ${totalPages} pages inspected`
              : "Analyzing document structure…"}
          </h3>

          <p className="mt-1 max-w-[380px] text-[12.5px] font-medium leading-5 text-slate-500">
            {totalRows > 0
              ? `${totalRows} catalog products detected and extracted so far.`
              : "Extracting names, variants, and supplier rates safely."}
          </p>
        </div>

        {/* Stepper pills */}
        <div className="mt-6 grid grid-cols-3 gap-2">
          <div className="rounded-[10px] border border-emerald-200 bg-emerald-50/70 p-2 text-center text-[11px] font-bold text-emerald-800">
            ✓ Uploaded
          </div>
          <div className={`rounded-[10px] border p-2 text-center text-[11px] font-bold ${
            completedPages > 0 ? "border-emerald-200 bg-emerald-50/70 text-emerald-800" : "border-blue-200 bg-blue-50/70 text-blue-800"
          }`}>
            {completedPages > 0 ? "✓ Layout Checked" : "● Layout Checked"}
          </div>
          <div className={`rounded-[10px] border p-2 text-center text-[11px] font-bold ${
            totalRows > 0 ? "border-blue-200 bg-blue-50/70 text-blue-800" : "border-slate-200 bg-slate-50 text-slate-400"
          }`}>
            {totalRows > 0 ? `● ${totalRows} Rows` : "○ Extracting Rows"}
          </div>
        </div>

        {/* File pill & background reassurance */}
        <div className="mt-5 space-y-2.5">
          <div className="flex min-w-0 items-center justify-between gap-3 rounded-[12px] border border-[#E5E7EB] bg-[#F8FAFC] px-3.5 py-2.5 text-left">
            <div className="flex items-center gap-2.5 min-w-0">
              <Icon
                name={displaySource === "PDF" ? "picture_as_pdf" : displaySource === "IMAGE" ? "image" : "table_chart"}
                className="text-[18px] text-slate-500 shrink-0"
              />
              <div className="truncate text-[12px] font-bold text-[#1E293B]">
                {displayName}
              </div>
            </div>
            {supplier ? (
              <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] font-extrabold text-slate-600">
                {supplier}
              </span>
            ) : null}
          </div>

          <div className="flex items-start gap-2 rounded-[12px] border border-blue-100 bg-blue-50/60 p-3 text-[11.5px] font-semibold text-blue-900 leading-4 text-left">
            <Icon name="verified_user" className="mt-0.5 text-[15px] text-blue-600 shrink-0" />
            <span>Processing continues on the server. You can minimize this window or switch pages; your review is saved automatically to Import History.</span>
          </div>

          {error ? (
            <div className="rounded-[12px] border border-rose-200 bg-rose-50 p-3 text-left">
              <div className="text-[12px] font-bold text-rose-800">{error}</div>
              {review?.coverage?.canRetry ? <button
                type="button"
                disabled={retrying}
                onClick={() => void handleRetry()}
                className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-[9px] bg-rose-700 px-3 text-[11.5px] font-bold text-white disabled:opacity-50"
              >
                <Icon name="refresh" sizePx={15} />
                {retrying ? "Retrying…" : "Retry extraction"}
              </button> : null}
            </div>
          ) : null}
        </div>

        {/* Actions bar */}
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100">
          {onMinimize ? (
            <button
              type="button"
              onClick={onMinimize}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-[10px] bg-[#11120d] px-4 text-[12px] font-bold text-white transition hover:bg-[#2a2c27] active:scale-[0.98]"
            >
              <Icon name="visibility_off" sizePx={15} />
              Work in Background
            </button>
          ) : <div />}

          {!isCommitting ? <button
            type="button"
            disabled={cancelling}
            onClick={() => {
              if (onCancel) {
                onCancel();
              } else {
                void handleStop();
              }
            }}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-[10px] border border-rose-200 bg-white px-3 text-[11.5px] font-bold text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
          >
            <Icon name="close" sizePx={15} />
            {cancelling ? "Stopping…" : "Stop"}
          </button> : null}
        </div>
      </div>
    </div>
  );
}

export function ImportPreparingWidget({
  fileName,
  sourceType,
}: {
  fileName?: string;
  sourceType?: string;
}) {
  const displaySource = sourceType || "SPREADSHEET";
  return (
    <div className="flex w-full items-center justify-center p-2 sm:p-4" role="status" aria-live="polite" aria-busy="true">
      <div className="w-full max-w-[540px] rounded-[22px] border border-[#D8DBE0] bg-white p-6 text-center shadow-sm sm:p-8">
        <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-[11px] font-extrabold uppercase tracking-wide text-blue-700">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-600" />
          </span>
          Preparing Import Review
        </div>
        <div className="mt-6 flex justify-center">
          <CircularProgressRing progress={18} sizePx={100} strokeWidth={7} centerText="…" subText="Reading" />
        </div>
        <h3 className="mt-4 text-[17px] font-extrabold text-[#0F172A]">Reading and validating the source…</h3>
        <p className="mx-auto mt-1 max-w-[390px] text-[12.5px] font-medium leading-5 text-slate-500">
          The file is being prepared for the same editable review used by every import format.
        </p>
        <div className="mt-5 flex min-w-0 items-center gap-2.5 rounded-[12px] border border-[#E5E7EB] bg-[#F8FAFC] px-3.5 py-2.5 text-left">
          <Icon name={displaySource === "PDF" ? "picture_as_pdf" : displaySource === "IMAGE" ? "image" : "table_chart"} className="shrink-0 text-[18px] text-slate-500" />
          <div className="truncate text-[12px] font-bold text-[#1E293B]">{fileName || "Selected file"}</div>
        </div>
      </div>
    </div>
  );
}
