import { useEffect, useRef, useState } from "react";
import { receipt, receipts, purchaseError, ambiguousPurchaseError, type PurchaseReceipt, type ReceiptSummary } from "~/lib/api/purchases";
import { confirmBillReview, type Confirmation, type ReviewResponse } from "~/lib/api/purchaseReview";
import { decimalUnits, formatUnits, purchaseLineAmounts } from "~/lib/domain/products/purchaseAmounts";
import ProjectSelect from "~/components/ui/ProjectSelect";

export default function PurchaseReviewConfirmation({ source, value, clean, locked, onPending, onConfirmed }: {
  source: string; value: ReviewResponse; clean: boolean; locked: boolean; onPending: (v: boolean) => void; onConfirmed: (v: ReviewResponse) => void;
}) {
  const [reason, setReason] = useState(""); const [acknowledged, setAcknowledged] = useState(false);
  const [target, setTarget] = useState(""); const [q, setQ] = useState(""); const [rows, setRows] = useState<ReceiptSummary[]>([]);
  const [detail, setDetail] = useState<PurchaseReceipt | null>(null); const [inspected, setInspected] = useState(false);
  const [busy, setBusy] = useState(false); const [pending, setPending] = useState(false); const [error, setError] = useState("");
  const frozen = useRef<Confirmation | null>(null); const mounted = useRef(true);
  const review = value.review; const resolution = review?.resolution;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { const c = new AbortController(); if (!resolution) receipts({ q, page: 1, kind: "FINANCIAL" }, c.signal).then(r => { if (!c.signal.aborted) setRows(r.items); }).catch(e => { if (!c.signal.aborted) setError(purchaseError(e)); }); return () => c.abort(); }, [q, resolution]);
  useEffect(() => { const c = new AbortController(); setDetail(null); setInspected(false); const id = resolution?.receiptId || target;
    if (id) receipt(id, c.signal).then(r => { if (!c.signal.aborted) setDetail(r); }).catch(e => { if (!c.signal.aborted) setError(purchaseError(e)); }); return () => c.abort();
  }, [target, resolution?.receiptId]);
  const facts = review?.corrected;
  let validation = "Save the corrected review before confirmation.";
  let amounts: ReturnType<typeof purchaseLineAmounts>[] = [];
  if (facts) { try {
    if (!facts.supplierId || facts.payable === null || !facts.lines.length) throw new Error("Resolve supplier, payable and lines before creating a receipt.");
    amounts = facts.lines.map(l => { if (!l.productId || !l.unit || l.quantity === null || l.cost === null || l.conversionFactor === null) throw new Error("Resolve every product, unit, quantity, conversion factor and acquisition cost."); return purchaseLineAmounts(l.quantity, l.cost, l.conversionFactor ?? "1"); });
    const total = amounts.reduce((sum, a) => sum + a.cents, 0n);
    if (total !== decimalUnits(facts.payable, 2)) throw new Error(`Payable must reconcile to NPR ${formatUnits(total, 2)}.`);
    validation = "";
  } catch (e) { validation = purchaseError(e); } }
  async function confirm(action: "create" | "attach") {
    if (busy || locked || !review) return;
    const payload = frozen.current || (action === "create" ? { action, expectedRevision: review.revision, reason: reason.trim() } : { action, expectedRevision: review.revision, reason: reason.trim(), receiptId: target });
    frozen.current = payload; setBusy(true); setPending(true); onPending(true); setError("");
    try { const result = await confirmBillReview(source, payload); if (mounted.current) { frozen.current = null; setPending(false); onPending(false); onConfirmed(result); } }
    catch (e) { if (mounted.current) { setError(purchaseError(e)); if (!ambiguousPurchaseError(e)) { frozen.current = null; setPending(false); onPending(false); } } }
    finally { if (mounted.current) setBusy(false); }
  }
  const field = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm";
  return <section className="space-y-3 rounded-lg border border-line p-3" aria-label="Purchase confirmation">
    <h4 className="font-semibold">{resolution ? "Confirmed purchase outcome" : "Confirm saved review"}</h4>
    {resolution ? <p role="status">{resolution.action === "create" ? "Receipt created and stock posted once." : "Source attached to existing receipt. Stock and payments unchanged."} Receipt {resolution.receiptId}. Decision: {resolution.reason}</p> : <>
      <p className="text-sm text-muted">Missing bill dates remain unknown on the receipt. Save edits first. Creating a receipt posts stock. Attaching only retains this source with an existing receipt.</p>
      {!clean && <p role="status">Unsaved edits: save this review before confirming.</p>}
      {!!validation && <p className="text-sm">{validation}</p>}
      {facts && amounts.map((a, i) => <p key={i} className="text-sm font-mono">Line {i + 1}: NPR {a.money} · stock +{a.stock} ({facts.lines[i].unit}; factor {facts.lines[i].conversionFactor ?? "1"})</p>)}
      <fieldset disabled={busy || pending || locked || !clean} className="space-y-3">
        <label className="block text-sm">Decision reason<input aria-label="Purchase decision reason" className={field} value={reason} maxLength={500} onChange={e => setReason(e.target.value)} /></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} />I reviewed the source, corrected values and possible duplicates. This is a new purchase that has not been posted.</label>
        <button type="button" disabled={!!validation || !acknowledged || reason.trim().length < 3} className="rounded-lg bg-action px-4 py-2 text-white disabled:opacity-50" onClick={() => void confirm("create")}>Create reviewed receipt</button>
        <label className="block text-sm">Find existing receipt<input aria-label="Find existing purchase receipt" className={field} value={q} maxLength={160} onChange={e => setQ(e.target.value)} /></label>
        <ProjectSelect aria-label="Existing purchase receipt" value={target} onChange={e => setTarget(e.target.value)}><option value="">Choose receipt to inspect</option>{rows.filter(r => r.isFinancial).map(r => <option key={r.id} value={r.id}>{r.billNumber || "No reference"} · {r.capturedSupplierName || "Supplier unknown"} · {r.id}</option>)}</ProjectSelect>
      </fieldset>
    </>}
    {detail && <div className="space-y-2 rounded-lg bg-inset p-3 text-sm"><p>Existing receipt {detail.id} · {detail.supplierName} · {detail.billNumber || "No reference"} · {detail.billDate?.slice(0, 10) || "Date unknown"}</p><p className="font-mono">Payable NPR {detail.payable ?? "unknown"} · Paid NPR {detail.paidTotal ?? "unknown"} · Due NPR {detail.dueAmount ?? "unknown"}</p>
      {detail.items.map(l => <p key={l.id}>{l.productName}: {l.inputQty} {l.inputUnit} × NPR {l.unitAcquisitionCost} = NPR {l.lineAmount}</p>)}
      {!resolution && <><label className="flex gap-2"><input type="checkbox" checked={inspected} disabled={busy || pending || locked || !clean} onChange={e => setInspected(e.target.checked)} />I inspected this receipt and confirm this source belongs to it.</label><button type="button" disabled={!inspected || detail.id !== target || !detail.isFinancial || !clean || reason.trim().length < 3 || busy || pending || locked} className="rounded-lg border border-line px-4 py-2 disabled:opacity-50" onClick={() => void confirm("attach")}>Attach to inspected receipt</button></>}
    </div>}
    {pending && <><p role="status">Confirmation may have reached the server. Inputs are locked; retry the same decision or reopen this source to inspect its outcome.</p><button type="button" disabled={busy} className="rounded-lg border border-line px-4 py-2" onClick={() => void confirm(frozen.current!.action)}>{busy ? "Confirming…" : "Retry same confirmation"}</button></>}
    {error && <p role="alert" className="text-error text-sm">{error}</p>}
  </section>;
}
