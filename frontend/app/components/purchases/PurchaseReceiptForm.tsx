import { useEffect, useRef, useState } from "react";
import { ModalFrame } from "~/components/ui/Modal";
import ProjectSelect from "~/components/ui/ProjectSelect";
import ProjectDateInput from "~/components/ui/ProjectDateInput";
import { listProductsApi } from "~/lib/api/endpoints";
import { postReceipt, purchaseError, ambiguousPurchaseError, type PurchaseReceipt, type ReceiptInput, type Supplier } from "~/lib/api/purchases";
import { decimalUnits, formatUnits, purchaseLineAmounts } from "~/lib/domain/products/purchaseAmounts";
import PurchaseDocuments from "./PurchaseDocuments";

type Product = { id: string; name: string; sku: string; saleUnit: string; packageUnit: string; packageQuantity: number | null };
type Line = { key: string; product: Product; inputUnit: string; inputQty: string; conversionFactor: string; unitAcquisitionCost: string };
const field = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm";
export default function PurchaseReceiptForm({ supplier, onClose, onSaved }: { supplier: Supplier; onClose: () => void; onSaved: (receipt: PurchaseReceipt) => void }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [q, setQ] = useState(""); const [page, setPage] = useState(1); const [pages, setPages] = useState(1);
  const [products, setProducts] = useState<Product[]>([]);
  const [payable, setPayable] = useState(""); const [billNumber, setBillNumber] = useState("");
  const [billDate, setBillDate] = useState(""); const [remarks, setRemarks] = useState("");
  const [documentIds, setDocumentIds] = useState<string[]>([]);
  const [review, setReview] = useState<ReceiptInput | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const frozen = useRef<ReceiptInput | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    listProductsApi({ search: q, active: "true", page, pageSize: 10 }, { signal: c.signal }).then(r => { if (!c.signal.aborted) { setProducts(r.products); setPages(r.totalPages || Math.ceil(r.total / 10)); } }).catch(e => { if (!c.signal.aborted) setError(purchaseError(e)); });
    return () => c.abort();
  }, [q, page]);
  function preview() {
    try {
      if (!lines.length) throw new Error("Add at least one purchase line.");
      const total = lines.reduce((sum, l) => sum + purchaseLineAmounts(l.inputQty, l.unitAcquisitionCost, l.conversionFactor).cents, 0n);
      if (decimalUnits(payable, 2) !== total) throw new Error(`Reviewed payable must equal the rounded line total: NPR ${formatUnits(total, 2)}.`);
      setReview({ supplierId: supplier.id, payable, billNumber, billDate: billDate || null, remarks, documentIds,
        lines: lines.map(({ product, inputUnit, inputQty, conversionFactor, unitAcquisitionCost }) => ({ productId: product.id, inputUnit, inputQty, conversionFactor, unitAcquisitionCost })), operationKey: "" });
      setError("");
    } catch (e) { setError(purchaseError(e)); }
  }
  async function confirm() {
    if (busy) return;
    const payload = frozen.current || (review && { ...review, operationKey: crypto.randomUUID() });
    if (!payload) return;
    frozen.current = payload; setBusy(true); setPending(true); setError("");
    try { const saved = await postReceipt(payload); frozen.current = null; setPending(false); onSaved(saved); }
    catch (e) { setError(purchaseError(e)); if (!ambiguousPurchaseError(e)) { frozen.current = null; setPending(false); } }
    finally { setBusy(false); }
  }
  return <ModalFrame open title={`New purchase · ${supplier.name}`} maxWidthClass="max-w-[960px]" mobileFullScreen onClose={() => { if (!busy && !pending) onClose(); }} footer={<div className="flex flex-wrap justify-end gap-3"><button type="button" disabled={busy || pending} onClick={() => review ? setReview(null) : onClose()} className="rounded border border-line px-4 py-2">{review ? "Edit lines" : "Cancel"}</button><button type="button" disabled={busy} onClick={review ? confirm : preview} className="rounded bg-action px-4 py-2 text-white">{busy ? "Confirming…" : pending ? "Retry same confirmation" : review ? "Confirm receipt" : "Review purchase"}</button></div>}>
    <p className="mb-4 text-sm text-muted">Record reviewed acquisition amounts. Saved selling prices and product costs stay unchanged. No tax is inferred.</p>
    {error && <p role="alert" className="mb-3 rounded border border-line p-3">{error}</p>}
    {pending && <p role="status" className="mb-3">Confirmation may have reached the server. Retry the same operation; inputs are locked to prevent duplicate stock.</p>}
    {review ? <div className="space-y-3"><p>Supplier: <strong>{supplier.name}</strong> · Bill: {billNumber || "No reference"} · Date: {billDate || "Not recorded"}</p>
      {lines.map(l => { const amounts = purchaseLineAmounts(l.inputQty, l.unitAcquisitionCost, l.conversionFactor); return <div key={l.key} className="rounded border border-line p-3"><strong>{l.product.name}</strong><p>{l.inputQty} {l.inputUnit} × NPR {l.unitAcquisitionCost} = NPR {amounts.money}</p><p className="text-sm text-muted">Conversion {l.conversionFactor}; stock +{amounts.stock} {l.product.saleUnit}</p></div>; })}
      <p className="text-lg font-semibold">Known payable: NPR {payable}</p><p>{documentIds.length} staged attachments</p></div> : <fieldset disabled={busy || pending} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2"><label>Bill reference<input className={field} value={billNumber} maxLength={100} onChange={e => setBillNumber(e.target.value)} /></label><label>Bill date<ProjectDateInput value={billDate} onChange={e => setBillDate(e.target.value)} /></label></div>
      <label className="block">Find product<input className={field} value={q} maxLength={160} onChange={e => { setQ(e.target.value); setPage(1); }} /></label>
      <div className="flex flex-wrap gap-2">{products.map(p => <button key={p.id} type="button" className="rounded border border-line px-3 py-2 text-sm" disabled={lines.length >= 200} onClick={() => setLines(ls => [...ls, { key: crypto.randomUUID(), product: p, inputUnit: p.saleUnit, inputQty: "1", conversionFactor: "1", unitAcquisitionCost: "" }])}>Add {p.name}</button>)}</div>
      <div className="flex gap-3 text-sm"><button type="button" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous products</button><span>{page} / {Math.max(1, pages)}</span><button type="button" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next products</button></div>
      {lines.map((l, i) => <div key={l.key} className="rounded-lg border border-line bg-inset p-3"><div className="mb-2 flex justify-between gap-2"><strong>{i + 1}. {l.product.name}</strong><button type="button" aria-label={`Remove line ${i + 1}`} onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))}>Remove</button></div>
        <div className="grid gap-3 sm:grid-cols-3"><label>Quantity<input aria-label={`Quantity line ${i + 1}`} inputMode="decimal" className={field} value={l.inputQty} onChange={e => setLines(ls => ls.map(x => x.key === l.key ? { ...x, inputQty: e.target.value } : x))} /></label>
          <label>Input unit<ProjectSelect aria-label={`Unit line ${i + 1}`} value={l.inputUnit} onChange={e => setLines(ls => ls.map(x => x.key === l.key ? { ...x, inputUnit: e.target.value, conversionFactor: e.target.value === x.product.saleUnit ? "1" : String(x.product.packageQuantity) } : x))}><option value={l.product.saleUnit}>{l.product.saleUnit}</option>{l.product.packageUnit !== l.product.saleUnit && (l.product.packageQuantity || 0) > 0 && <option value={l.product.packageUnit}>{l.product.packageUnit}</option>}</ProjectSelect></label>
          <label>Cost per input unit<input aria-label={`Acquisition cost line ${i + 1}`} inputMode="decimal" className={field} value={l.unitAcquisitionCost} onChange={e => setLines(ls => ls.map(x => x.key === l.key ? { ...x, unitAcquisitionCost: e.target.value } : x))} /></label></div>
        <p className="mt-2 text-sm text-muted">{(() => { try { const a = purchaseLineAmounts(l.inputQty, l.unitAcquisitionCost, l.conversionFactor); return `NPR ${a.money} · stock +${a.stock} ${l.product.saleUnit}`; } catch { return "Enter valid quantity, conversion and acquisition cost."; } })()}</p></div>)}
      <label className="block">Reviewed known payable (NPR)<input aria-label="Known payable" inputMode="decimal" className={field} value={payable} onChange={e => setPayable(e.target.value)} /></label>
      <label className="block">Remarks<input className={field} value={remarks} maxLength={500} onChange={e => setRemarks(e.target.value)} /></label>
      <PurchaseDocuments ids={documentIds} onChange={setDocumentIds} />
    </fieldset>}
  </ModalFrame>;
}
