import React, { useEffect, useState } from "react";
import Icon from "~/components/ui/Icon";
import { controlProductImportApi } from "~/lib/api/endpoints";
import { importTaskLabel, isImportActive, refreshImportTask, useImportTask } from "~/lib/importTaskStore";

export interface ImportProcessingWidgetProps {
  batchId: string; fileName?: string;
  onComplete: (batchId: string) => void; onMinimize?: () => void;
  onCancel?: () => void;
}

export function ImportProcessingWidget({ batchId, fileName, onComplete, onMinimize, onCancel }: ImportProcessingWidgetProps) {
  const { data, error: connectionError, unavailable, checkedAt } = useImportTask(batchId);
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState(false);
  const active = !unavailable && isImportActive(data?.batch.status);
  const coverage = data?.coverage;
  const status = data?.batch.status;
  useEffect(() => {
    sessionStorage.setItem("active_product_import_batch_id", batchId);
    window.dispatchEvent(new CustomEvent("active_product_import_changed", { detail: { batchId } }));
  }, [batchId]);

  async function control(action: "retry" | "cancel") {
    if (action === "cancel") {
      if (onCancel) { onCancel(); return; }
      if (!window.confirm("Stop extraction? Completed pages will remain saved. You can retry remaining pages later.")) return;
    }
    setPending(true);
    setActionError("");
    try {
      await controlProductImportApi(batchId, action);
      refreshImportTask(batchId);
    } catch (error: any) {
      setActionError(error?.response?.data?.error || "The request could not be completed. Please retry.");
    } finally { setPending(false); }
  }

  return <section aria-label="Import progress" className="mx-auto w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 sm:p-7">
    <p className="truncate text-sm text-slate-600">{fileName || data?.batch.fileName || "Product import"}</p>
    <h2 aria-live="polite" className="mt-2 text-xl font-semibold text-slate-900">{unavailable ? "Import unavailable" : importTaskLabel(status)}</h2>
    {active && status !== "COMMITTING" && coverage && coverage.total > 0 ? <div className="mt-5">
      <progress aria-label="Source pages inspected" value={coverage.visited} max={coverage.total} className="h-2 w-full accent-slate-900" />
      <p className="mt-2 text-sm text-slate-600">{coverage.visited} of {coverage.total} pages inspected · {coverage.completed} processed successfully</p>
    </div> : active ? <div className="mt-5 flex items-center gap-3 text-sm text-slate-600">
      <span aria-hidden="true" className="h-5 w-5 rounded-full border-2 border-slate-200 border-t-slate-900 motion-safe:animate-spin" />
      {status === "COMMITTING" ? "Saving your reviewed decisions. Do not submit again." : "Waiting for the next server update. Large pages can take longer."}
    </div> : null}
    {data ? <p className="mt-3 text-sm text-slate-600">{data.batch.totalRows} extracted rows{status === "IMPORTED" ? " · Reviewed decisions saved to the catalog." : ""}</p> : null}
    {active && checkedAt ? <p className="mt-2 text-xs text-muted">Status checked at {new Date(checkedAt).toLocaleTimeString()}. Page counts update when the server finishes a page.</p> : null}
    {status === "DRAFT" ? <p className="mt-3 text-sm">Extraction has finished. Review the products before applying them to your catalog.</p> : null}
    {!active && coverage?.outcome === "PARTIAL" ? <p className="mt-3 text-sm text-amber-800">Some pages need attention. Review saved products or retry remaining pages.</p> : null}
    {(connectionError || actionError) ? <p role="alert" className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{actionError || connectionError}</p> : null}
    <p className="mt-5 text-sm leading-6 text-slate-600">Processing continues on the server when minimized. Progress and saved results are available in Import History.</p>
    <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4">
      {!active && !unavailable ? <button className="min-h-11 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white" onClick={() => onComplete(batchId)}>{status === "DRAFT" ? "Review products" : "View saved results"}</button> : null}
      {active && onMinimize ? <button className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-medium" onClick={onMinimize}>Work in background</button> : null}
      {!active && !unavailable && status !== "IMPORTED" && coverage?.canRetry ? <button disabled={pending} className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm disabled:opacity-50" onClick={() => void control("retry")}>{pending ? "Requesting…" : "Retry remaining pages"}</button> : null}
      {active && status !== "COMMITTING" ? <button disabled={pending || status === "CANCELLING"} className="min-h-11 rounded-lg px-4 text-sm text-red-700 disabled:opacity-50" onClick={() => void control("cancel")}>{pending || status === "CANCELLING" ? "Stopping…" : "Stop extraction"}</button> : null}
    </div>
  </section>;
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
          <span aria-hidden="true" className="h-10 w-10 rounded-full border-4 border-slate-200 border-t-slate-900 motion-safe:animate-spin" />
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
