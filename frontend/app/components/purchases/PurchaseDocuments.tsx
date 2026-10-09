import { useEffect, useState } from "react";
import ProjectSelect from "~/components/ui/ProjectSelect";
import { listDocumentsApi, uploadDocumentsApi, type DocumentRecord, type DocumentType } from "~/lib/api/endpoints";
import { purchaseError } from "~/lib/api/purchases";

export default function PurchaseDocuments({ ids, onChange, disabled = false, includeLinked = false }: { ids: string[]; onChange: (ids: string[]) => void; disabled?: boolean; includeLinked?: boolean }) {
  const [type, setType] = useState<DocumentType>("PURCHASE_BILL");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [rows, setRows] = useState<DocumentRecord[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    listDocumentsApi({ documentType: type, q, page, pageSize: 20, processingStatus: includeLinked ? undefined : "UNPROCESSED" }, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setRows(result.documents.filter(d => includeLinked || !d.linkedEntityId)); setPages(result.totalPages); setError(""); } })
      .catch(e => { if (!controller.signal.aborted) setError(purchaseError(e)); });
    return () => controller.abort();
  }, [type, q, page, refresh, includeLinked]);
  return <fieldset className="space-y-3 rounded-lg border border-line p-4" disabled={disabled || busy}>
    <legend className="px-1 text-sm font-semibold">Bill attachments ({ids.length}/10)</legend>
    <label className="block text-sm">Upload reviewed bill files<input aria-label="Upload purchase bills" type="file" multiple className="mt-1 block w-full text-sm" onChange={async e => {
      const files = Array.from(e.target.files || []);
      e.target.value = "";
      if (!files.length) return;
      if (files.length + ids.length > 10) { setError("At most ten attachments are allowed."); return; }
      setBusy(true); setError("");
      try { const result = await uploadDocumentsApi(files, { documentType: "PURCHASE_BILL", visibility: "ADMIN_MANAGER" }); onChange([...ids, ...result.documents.map((d: { id: string }) => d.id)]); setRefresh(v => v + 1); }
      catch (e) { setError(purchaseError(e)); } finally { setBusy(false); }
    }} /></label>
    <div className="flex flex-wrap gap-2"><ProjectSelect aria-label="Staged bill type" value={type} onChange={e => { setType(e.target.value as DocumentType); setPage(1); }}><option value="PURCHASE_BILL">Purchase bills</option><option value="STOCK_BILL">Existing stock bills</option></ProjectSelect>
      <input aria-label="Find staged bill" className="min-w-0 flex-1 rounded border border-line px-3 py-2" placeholder="Find staged bill" value={q} maxLength={160} onChange={e => { setQ(e.target.value); setPage(1); }} /></div>
    {rows.map(d => <label key={d.id} className="flex gap-2 text-sm"><input type="checkbox" checked={ids.includes(d.id)} disabled={!ids.includes(d.id) && ids.length >= 10} onChange={e => onChange(e.target.checked ? [...ids, d.id] : ids.filter(id => id !== d.id))} />{d.title || d.fileName}{includeLinked && d.linkedEntityId ? " · Linked source (inspect outcome)" : ""}</label>)}
    {!rows.length && <p className="text-sm text-muted">No available bills on this page.</p>}
    {ids.length > 0 && <button type="button" className="text-sm underline" onClick={() => onChange([])}>Clear selected attachments</button>}
    <div className="flex items-center gap-3 text-sm"><button type="button" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous bills</button><span>{page} / {Math.max(1, pages)}</span><button type="button" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next bills</button></div>
    {busy && <p role="status">Uploading before confirmation…</p>}{error && <p role="alert" className="text-sm">{error}</p>}
  </fieldset>;
}
