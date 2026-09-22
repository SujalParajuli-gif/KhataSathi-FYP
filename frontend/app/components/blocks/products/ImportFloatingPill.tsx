import { useEffect } from "react";
import { importTaskLabel, isImportActive, useImportTask } from "~/lib/importTaskStore";

export function ImportFloatingPill({ batchId, onClick, onDismiss, hidden = false }: {
  batchId: string; onClick: () => void; onDismiss: () => void; hidden?: boolean;
}) {
  // Keep the subscriber mounted while the expanded presentation is visible.
  const { data, error, unavailable } = useImportTask(batchId);
  const active = !unavailable && isImportActive(data?.batch.status);
  useEffect(() => {
    if (hidden) return;
    document.body.dataset.importNotification = "visible";
    return () => { delete document.body.dataset.importNotification; };
  }, [hidden]);
  if (hidden) return null;
  return (
    <aside aria-label="Import task" className="fixed bottom-3 right-3 z-[80] flex max-w-[calc(100vw-24px)] items-center gap-2 rounded-xl border border-slate-200 bg-white p-2 shadow-lg">
      <button type="button" onClick={onClick} className="min-h-12 min-w-0 px-2 text-left">
        <span className="block truncate text-sm font-semibold">{data?.batch.fileName || "Product import"}</span>
        <span role="status" className="block text-xs text-slate-600">{error || importTaskLabel(data?.batch.status)}</span>
        {active && data?.coverage.total ? <span className="block text-xs text-slate-500">{data.coverage.visited} of {data.coverage.total} pages inspected</span> : null}
        <span className="block text-xs font-semibold text-blue-700">{active ? "View progress" : "View details"}</span>
      </button>
      {!active ? <button type="button" aria-label="Dismiss import notification" onClick={onDismiss} className="min-h-11 min-w-11 rounded-lg border border-slate-200 text-xl">×</button> : null}
    </aside>
  );
}
