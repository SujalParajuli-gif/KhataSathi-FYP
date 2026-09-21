export function importBatchStatus(batch: { status?: string | null; totalRows?: number; importedRows?: number; failedRows?: number }) {
  const total = Math.max(0, Number(batch.totalRows) || 0);
  const applied = Math.max(0, Number(batch.importedRows) || 0);
  const failed = Math.max(0, Number(batch.failedRows) || 0);
  const status = batch.status || "";
  const processing = ["QUEUED", "PROCESSING", "CANCELLING", "COMMITTING"].includes(status);
  const tier = processing ? "processing" : status === "IMPORTED" ? "completed"
    : ["FAILED", "INTERRUPTED"].includes(status) || failed > 0 ? "failed"
    : applied > 0 ? "partial" : "pending";
  const labels = { processing: status === "CANCELLING" ? "Stopping" : status === "COMMITTING" ? "Applying changes" : "Processing", completed: "Completed", failed: "Needs attention", partial: "Partially applied", pending: "Ready to review" };
  const colors = { processing: "blue", completed: "emerald", failed: "rose", partial: "blue", pending: "amber" } as const;
  const tones = {
    blue: "border-blue-200 bg-blue-50 text-blue-800",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
    rose: "border-rose-200 bg-rose-50 text-rose-800",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
  };
  const label = labels[tier];
  const summary = tier === "completed" ? `${applied.toLocaleString()} created, updated or kept · ${Math.max(0, total - applied).toLocaleString()} ignored`
    : tier === "failed" ? `${failed ? `${failed.toLocaleString()} row issues` : "Job interrupted or failed"} · ${applied.toLocaleString()} applied`
    : tier === "partial" ? `${applied.toLocaleString()} applied · ${total.toLocaleString()} total rows`
    : `${total.toLocaleString()} rows`;
  return {
    tier, statusLabel: label, badgeLabel: label,
    badgeIcon: ({ processing: "progress_activity", completed: "check_circle", failed: "warning", partial: "sync", pending: "pending_actions" })[tier],
    badgeClass: tones[colors[tier]], iconBoxClass: tones[colors[tier]],
    spinning: processing, cardHoverClass: "hover:bg-slate-50", rowHoverClass: "hover:bg-slate-50",
    buttonText: ({ processing: "View progress", completed: "View", failed: "Resolve", partial: "Resume", pending: "Review" })[tier],
    buttonIcon: processing ? "progress_activity" : "arrow_forward",
    buttonClass: "bg-[#11120d] text-white hover:bg-[#2a2c27]",
    statsText: summary, processedText: label, processedSubtext: summary,
  };
}
