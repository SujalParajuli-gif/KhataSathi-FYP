export function importBatchStatus(batch: {
  status?: string | null;
  totalRows?: number;
  importedRows?: number;
  failedRows?: number;
  fileName?: string | null;
  sourceType?: string | null;
}) {
  const total = Math.max(0, Number(batch.totalRows) || 0);
  const applied = Math.max(0, Number(batch.importedRows) || 0);
  const failed = Math.max(0, Number(batch.failedRows) || 0);
  const status = batch.status || "";
  const processing = ["QUEUED", "PROCESSING", "CANCELLING", "COMMITTING"].includes(status);
  const tier = processing ? "processing" : status === "IMPORTED" ? "completed"
    : ["FAILED", "INTERRUPTED"].includes(status) || failed > 0 ? "failed"
    : applied > 0 ? "partial" : "pending";
  const labels = {
    processing: status === "CANCELLING" ? "Stopping" : status === "COMMITTING" ? "Applying changes" : "Processing",
    completed: "Completed",
    failed: "Needs attention",
    partial: "Partially applied",
    pending: "Saved draft",
  };
  const colors = { processing: "blue", completed: "emerald", failed: "rose", partial: "blue", pending: "amber" } as const;
  const tones = {
    blue: "border-blue-200 bg-blue-50 text-blue-800",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
    rose: "border-rose-200 bg-rose-50 text-rose-800",
    amber: "border-amber-200 bg-amber-50 text-amber-900",
  };
  const label = labels[tier];
  const summary = tier === "completed" ? `${applied.toLocaleString()} created, updated or kept · ${Math.max(0, total - applied).toLocaleString()} ignored`
    : tier === "failed" ? `${failed ? `${failed.toLocaleString()} row issues` : "Job interrupted or failed"} · ${applied.toLocaleString()} applied`
    : tier === "partial" ? `${applied.toLocaleString()} applied · ${total.toLocaleString()} total rows`
    : `${total.toLocaleString()} rows`;

  const type = String(batch.sourceType || "").toUpperCase();
  const name = (batch.fileName || "").toLowerCase();
  const isPdf = type === "PDF" || name.endsWith(".pdf");
  const isSheet = ["CSV", "XLSX", "XLS"].includes(type) || /\.(csv|xlsx?)$/.test(name);
  const fileIcon = isPdf ? "picture_as_pdf" : isSheet ? "table_chart" : "image";
  const fileIconBoxClass = isPdf
    ? "border-rose-200 bg-rose-50 text-rose-600"
    : isSheet
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : "border-sky-200 bg-sky-50 text-sky-700";

  return {
    tier, statusLabel: label, badgeLabel: label,
    badgeIcon: ({ processing: "progress_activity", completed: "check_circle", failed: "warning", partial: "sync", pending: "pending_actions" })[tier],
    badgeClass: tones[colors[tier]],
    iconBoxClass: fileIconBoxClass,
    fileIcon,
    fileIconBoxClass,
    rowClass: tier === "completed" ? "bg-emerald-50/40 border-l-[3px] border-l-emerald-500" : "",
    spinning: processing, cardHoverClass: "hover:bg-slate-50",
    rowHoverClass: tier === "completed" ? "hover:bg-emerald-100/40" : "hover:bg-slate-50",
    buttonText: ({ processing: "View progress", completed: "View", failed: "Resolve", partial: "Resume", pending: "Resume review" })[tier],
    buttonIcon: processing ? "progress_activity" : "arrow_forward",
    buttonClass: "bg-[#11120d] text-white hover:bg-[#2a2c27]",
    statsText: summary, processedText: label, processedSubtext: summary,
  };
}

export function importTerminalSummary(batch: {
  status?: string | null;
  totalRows?: number;
  importedRows?: number;
  failedRows?: number;
}) {
  const total = Math.max(0, Number(batch.totalRows) || 0);
  const applied = Math.max(0, Number(batch.importedRows) || 0);
  const failed = Math.max(0, Number(batch.failedRows) || 0);
  const status = batch.status || "";

  switch (status) {
    case "DRAFT":
      if (failed > 0) {
        return `Extraction completed. Review ${total} extracted row${total === 1 ? '' : 's'}; ${failed} need${failed === 1 ? 's' : ''} attention.`;
      }
      return `Extraction completed. ${total} row${total === 1 ? '' : 's'} ready for review.`;
    case "IMPORTED":
      const ignored = Math.max(0, total - applied - failed);
      return `${applied} applied, ${ignored} ignored, ${failed} failed.`;
    case "FAILED":
    case "INTERRUPTED":
      return `Saved work remains available for review or retry.`;
    default:
      return "";
  }
}
