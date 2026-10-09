import { useEffect, useRef, useState } from "react";
import { ModalFrame } from "~/components/ui/Modal";
import ProjectSelect from "~/components/ui/ProjectSelect";
import PaginationBar from "~/components/ui/PaginationBar";
import { getAuthUser } from "~/lib/auth";
import { useBusinessCapabilities } from "~/lib/businessCapabilities";
import { suppliers, saveSupplier, receipts, receipt, purchaseError, type Supplier, type ReceiptSummary, type PurchaseReceipt } from "~/lib/api/purchases";
import PurchaseReceiptForm from "~/components/purchases/PurchaseReceiptForm";
import PurchaseReceiptDetail from "~/components/purchases/PurchaseReceiptDetail";
import PurchaseBillReview from "~/components/purchases/PurchaseBillReview";

export default function PurchasesRoute() {
  const caps = useBusinessCapabilities(); const role = getAuthUser()?.role;
  const allowed = caps.inventoryEnabled && (role === "admin" || role === "manager");
  const [supplierRows, setSupplierRows] = useState<Supplier[]>([]); const [supplierQ, setSupplierQ] = useState("");
  const [supplierPage, setSupplierPage] = useState(1); const [supplierPages, setSupplierPages] = useState(1);
  const [selectedSupplier, setSelectedSupplier] = useState<Supplier | null>(null);
  const [supplierDraft, setSupplierDraft] = useState<Supplier | null>(null);
  const [supplierBusy, setSupplierBusy] = useState(false); const [supplierError, setSupplierError] = useState("");
  const [creating, setCreating] = useState(false); const [q, setQ] = useState(""); const [kind, setKind] = useState("ALL");
  const [filterSupplier, setFilterSupplier] = useState(""); const [page, setPage] = useState(1);
  const [rows, setRows] = useState<ReceiptSummary[]>([]); const [total, setTotal] = useState(0); const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false); const [error, setError] = useState(""); const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<string | null>(null); const [detail, setDetail] = useState<PurchaseReceipt | null>(null);
  const selection = useRef(0);
  const [reviewingBill, setReviewingBill] = useState(false);
  useEffect(() => {
    if (!allowed) return;
    const c = new AbortController();
    suppliers({ q: supplierQ, page: supplierPage, includeInactive: true }, c.signal).then(r => { if (!c.signal.aborted) { setSupplierRows(r.suppliers); setSupplierPages(r.totalPages); setSupplierError(""); } }).catch(e => { if (!c.signal.aborted) setSupplierError(purchaseError(e)); });
    return () => c.abort();
  }, [allowed, supplierQ, supplierPage, refresh]);
  useEffect(() => {
    if (!allowed) return;
    const c = new AbortController(); setLoading(true);
    receipts({ q, page, kind, supplierId: filterSupplier || undefined }, c.signal).then(r => { if (!c.signal.aborted) { setRows(r.items); setTotal(r.total); setPages(r.totalPages); setError(""); } }).catch(e => { if (!c.signal.aborted) setError(purchaseError(e)); }).finally(() => { if (!c.signal.aborted) setLoading(false); });
    return () => c.abort();
  }, [allowed, q, page, kind, filterSupplier, refresh]);
  useEffect(() => {
    const generation = ++selection.current; const c = new AbortController(); setDetail(null);
    if (allowed && selected) receipt(selected, c.signal).then(r => { if (!c.signal.aborted && generation === selection.current) setDetail(r); }).catch(e => { if (!c.signal.aborted) setError(purchaseError(e)); });
    return () => { c.abort(); selection.current++; };
  }, [allowed, selected, refresh]);
  function updated() { setRefresh(v => v + 1); }
  if (!allowed) return <p role="alert" className="p-6">Purchases require administrator or manager access and enabled inventory.</p>;
  const field = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm";
  return <div className="space-y-6 p-4 sm:p-6 text-ink">
    <button type="button" className="rounded-lg border border-line bg-surface px-4 py-2 text-sm" onClick={() => setReviewingBill(true)}>Review bill scan</button>
    {reviewingBill && <PurchaseBillReview onClose={() => setReviewingBill(false)} />}
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">Purchases</h1><p className="text-sm text-muted">Supplier receipts, stock confirmation and recorded installments</p></div><button type="button" disabled={!selectedSupplier?.isActive} className="rounded-lg bg-action px-4 py-2 text-sm text-white disabled:opacity-50" onClick={() => setCreating(true)}>New purchase</button></header>
    <section className="rounded-xl border border-line bg-surface p-4"><div className="mb-3 flex flex-wrap justify-between gap-3"><h2 className="font-semibold">Suppliers</h2><button type="button" className="text-sm underline" onClick={() => { setSupplierError(""); setSupplierDraft({ id: "", name: "", contact: "", phone: "", panNo: "", address: "", isActive: true }); }}>Create supplier</button></div><input aria-label="Search suppliers" className={field} value={supplierQ} maxLength={160} placeholder="Search name, phone or PAN" onChange={e => { setSupplierQ(e.target.value); setSupplierPage(1); }} />
      <div className="mt-3 flex flex-wrap gap-2">{supplierRows.map(s => <div key={s.id} className="flex rounded-lg border border-line"><button type="button" aria-pressed={selectedSupplier?.id === s.id} className={`px-3 py-2 text-sm ${selectedSupplier?.id === s.id ? "bg-inset font-semibold" : ""}`} onClick={() => setSelectedSupplier(s)}>{s.name}{s.isActive ? "" : " · inactive"}</button><button type="button" className="border-l border-line px-2 text-sm underline" aria-label={`Edit supplier ${s.name}`} onClick={() => { setSupplierError(""); setSupplierDraft(s); }}>Edit</button></div>)}</div>
      {selectedSupplier && <p className="mt-3 text-sm">Selected: <strong>{selectedSupplier.name}</strong> <button type="button" className="ml-2 underline" onClick={() => { setFilterSupplier(selectedSupplier.id); setPage(1); }}>Show this supplier's receipts</button></p>}
      <div className="mt-3 flex gap-3 text-sm"><button type="button" disabled={supplierPage <= 1} onClick={() => setSupplierPage(p => p - 1)}>Previous suppliers</button><span>{supplierPage} / {Math.max(1, supplierPages)}</span><button type="button" disabled={supplierPage >= supplierPages} onClick={() => setSupplierPage(p => p + 1)}>Next suppliers</button></div>{supplierError && <p role="alert">{supplierError}</p>}
    </section>
    <section className="rounded-xl border border-line bg-surface p-4"><h2 className="mb-3 font-semibold">Receipt history</h2><div className="mb-4 flex flex-wrap gap-3"><input aria-label="Search receipts" className="min-w-0 flex-1 rounded border border-line px-3 py-2" placeholder="Search bill or supplier" value={q} maxLength={160} onChange={e => { setQ(e.target.value); setPage(1); }} /><ProjectSelect aria-label="Receipt kind" value={kind} onChange={e => { setKind(e.target.value); setPage(1); }}><option value="ALL">All receipts</option><option value="FINANCIAL">Supplier purchases</option><option value="LEGACY">Legacy stock-only</option></ProjectSelect>{filterSupplier && <button type="button" className="text-sm underline" onClick={() => { setFilterSupplier(""); setPage(1); }}>Clear supplier filter</button>}</div>
      {error && <p role="alert" className="mb-3">{error}</p>}{loading && <p role="status">Loading receipts…</p>}
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Purchase receipt history</caption><thead><tr><th className="py-2">Supplier / bill</th><th>Date</th><th>Payable</th><th>Paid / due</th><th>Status</th></tr></thead><tbody>{rows.map(r => <tr key={r.id} className="border-t border-line"><td className="py-3 pr-3"><button type="button" className="text-left underline" onClick={() => setSelected(r.id)}>{r.capturedSupplierName || "Legacy receipt"} · {r.billNumber || "No reference"}</button></td><td className="pr-3 whitespace-nowrap">{r.billDate || "Unknown"}</td><td className="pr-3">{r.knownPayable ? r.payable : "Unknown"}</td><td className="pr-3 whitespace-nowrap">{r.isFinancial ? `${r.paid} / ${r.due}` : "Not inferred"}</td><td>{r.isFinancial ? r.paymentStatus : "Legacy"}</td></tr>)}</tbody></table></div>
      {!loading && !rows.length && <p className="py-6 text-center text-sm text-muted">No receipts match these filters.</p>}
      <PaginationBar page={page} totalPages={pages} total={total} start={total ? (page - 1) * 20 + 1 : 0} end={Math.min(page * 20, total)} pageSize={20} pageSizeOptions={[20]} onPageChange={setPage} onPageSizeChange={() => {}} label="receipts" />
    </section>
    {detail && <PurchaseReceiptDetail key={detail.id} value={detail} onUpdated={updated} />}
    {creating && selectedSupplier && <PurchaseReceiptForm supplier={selectedSupplier} onClose={() => setCreating(false)} onSaved={r => { setCreating(false); setSelected(r.id); updated(); }} />}
    <ModalFrame open={!!supplierDraft} title={supplierDraft?.id ? "Edit supplier" : "Create supplier"} onClose={() => { if (!supplierBusy) setSupplierDraft(null); }} footer={<button type="button" disabled={supplierBusy || !supplierDraft?.name.trim()} className="rounded bg-action px-4 py-2 text-white" onClick={async () => {
      if (!supplierDraft || supplierBusy) return; setSupplierBusy(true); setSupplierError("");
      try { const { id, ...input } = supplierDraft; const s = await saveSupplier(input, id || undefined); setSelectedSupplier(s); setSupplierDraft(null); updated(); }
      catch (e) { setSupplierError(purchaseError(e)); } finally { setSupplierBusy(false); }
    }}>{supplierBusy ? "Saving…" : "Save supplier"}</button>}>
      {supplierDraft && <fieldset disabled={supplierBusy} className="space-y-3">{([['name','Name',160],['contact','Contact',160],['phone','Phone',40],['panNo','PAN',40],['address','Address',500]] as const).map(([key,label,max]) => <label key={key} className="block">{label}<input className={field} value={supplierDraft[key] || ""} maxLength={max} onChange={e => setSupplierDraft({ ...supplierDraft, [key]: e.target.value })} /></label>)}<label className="flex gap-2"><input type="checkbox" checked={supplierDraft.isActive} onChange={e => setSupplierDraft({ ...supplierDraft, isActive: e.target.checked })} />Active for new purchases</label><p className="text-sm text-muted">Deactivation preserves receipts. Suppliers cannot be deleted.</p>{supplierError && <p role="alert">{supplierError}</p>}</fieldset>}
    </ModalFrame>
  </div>;
}
