import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ModalFrame } from "~/components/ui/Modal";
import ProjectSelect from "~/components/ui/ProjectSelect";
import ProjectDateInput from "~/components/ui/ProjectDateInput";
import { postPayment, voidPayment, attachDocuments, purchaseError, ambiguousPurchaseError, type PaymentInput, type PurchaseReceipt } from "~/lib/api/purchases";
import { decimalUnits } from "~/lib/domain/products/purchaseAmounts";
import PurchaseDocuments from "./PurchaseDocuments";

export default function PurchaseReceiptDetail({ value, onUpdated }: { value: PurchaseReceipt; onUpdated: () => void }) {
  const [dialog, setDialog] = useState<"payment" | "attachments" | null>(null);
  const [amount, setAmount] = useState(""); const [method, setMethod] = useState<PaymentInput["method"]>("CASH");
  const [reference, setReference] = useState(""); const [paidAt, setPaidAt] = useState(new Date().toLocaleDateString("en-CA"));
  const [ids, setIds] = useState<string[]>([]); const [voidId, setVoidId] = useState<string | null>(null); const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false); const [pending, setPending] = useState(false); const [error, setError] = useState("");
  const frozen = useRef<PaymentInput | null>(null); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function recordPayment() {
    if (busy) return;
    try {
      if (!frozen.current) {
        if (decimalUnits(amount, 2, true) > decimalUnits(value.dueAmount || "0", 2)) throw new Error("Payment exceeds the outstanding amount.");
        if (method !== "CASH" && !reference.trim()) throw new Error("A reference is required for noncash payments.");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(paidAt)) throw new Error("Choose a valid recorded payment date.");
        frozen.current = { amount, method, reference, paidAt, operationKey: crypto.randomUUID() };
      }
      setBusy(true); setPending(true); setError("");
      await postPayment(value.id, frozen.current);
      if (mounted.current) { frozen.current = null; setPending(false); setDialog(null); setAmount(""); onUpdated(); }
    } catch (e) { if (mounted.current) { setError(purchaseError(e)); if (!ambiguousPurchaseError(e)) { frozen.current = null; setPending(false); } } }
    finally { if (mounted.current) setBusy(false); }
  }
  async function mutate(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); if (mounted.current) { setDialog(null); setVoidId(null); setIds([]); onUpdated(); } }
    catch (e) { if (mounted.current) setError(purchaseError(e)); }
    finally { if (mounted.current) setBusy(false); }
  }
  const field = "w-full rounded border border-line px-3 py-2";
  return <section className="space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-6" aria-label="Receipt detail">
    <div className="flex flex-wrap justify-between gap-3"><div><h2 className="text-lg font-semibold">{value.supplierName || "Legacy receipt"}</h2><p className="text-sm text-muted">{value.billNumber || "No bill reference"} · {value.billDate || "Date not recorded"}</p></div><span className="rounded border border-line px-3 py-1 text-sm">{value.isFinancial ? value.paymentStatus : "Legacy · payable unknown"}</span></div>
    {error && <p role="alert">{error}</p>}
    {value.isFinancial ? <div className="grid grid-cols-3 gap-3 rounded-lg bg-inset p-3 text-sm"><div>Payable<strong className="block font-mono">NPR {value.payable}</strong></div><div>Paid<strong className="block font-mono">NPR {value.paidTotal}</strong></div><div>Due<strong className="block font-mono">NPR {value.dueAmount}</strong></div></div> : <p className="text-muted">Historical stock-only receipt. No supplier debt or payment total is inferred.</p>}
    <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Retained purchase lines</caption><thead><tr><th className="py-2">Product</th><th>Quantity / unit</th><th>Stock quantity</th><th>Unit cost</th><th>Line amount</th></tr></thead><tbody>{value.items.map(l => <tr key={l.id} className="border-t border-line"><td className="py-3 pr-3">{l.productName}</td><td className="pr-3 whitespace-nowrap">{l.inputQty} {l.inputUnit} (×{l.conversionFactor})</td><td className="pr-3">{l.stockQty}</td><td className="pr-3">{l.unitAcquisitionCost}</td><td>{l.lineAmount}</td></tr>)}</tbody></table></div>
    {value.isFinancial && <div className="flex flex-wrap gap-2"><button type="button" className="rounded bg-action px-4 py-2 text-sm text-white" disabled={busy || pending || value.dueAmount === "0.00"} onClick={() => { setError(""); setDialog("payment"); }}>Record installment</button><button type="button" disabled={busy || pending} className="rounded border border-line px-4 py-2 text-sm" onClick={() => { setError(""); setDialog("attachments"); }}>Add bill attachments</button></div>}
    <h3 className="font-semibold">Installment history</h3>{!value.payments.length && <p className="text-sm text-muted">No recorded payments.</p>}
    {value.payments.map(p => <div key={p.id} className="flex flex-wrap justify-between gap-3 border-t border-line py-3 text-sm"><div>NPR {p.amount} · {p.method} · {p.paidAt.slice(0, 10)}<p className="text-muted">{p.reference || "No reference"}{p.isVoided ? ` · Voided: ${p.voidReason}` : ""}</p></div>{!p.isVoided && <button type="button" disabled={busy || pending} className="underline" onClick={() => { setVoidId(p.id); setReason(""); }}>Void payment</button>}</div>)}
    <h3 className="font-semibold">Bill evidence</h3>{value.documents.map(d => <Link key={d.id} className="block break-words text-sm underline" to={`/documents/${d.id}/view`} target="_blank" rel="noreferrer">{d.title || d.fileName}</Link>)}
    <ModalFrame open={dialog !== null} title={dialog === "payment" ? "Record supplier installment" : "Add bill attachments"} onClose={() => { if (!busy && !pending) setDialog(null); }} footer={<button type="button" className="rounded bg-action px-4 py-2 text-white" disabled={busy || (dialog === "attachments" && !ids.length)} onClick={dialog === "payment" ? recordPayment : () => mutate(() => attachDocuments(value.id, ids))}>{busy ? "Saving…" : pending ? "Retry same payment" : "Save"}</button>}>
      {error && <p role="alert" className="mb-3">{error}</p>}{pending && <p role="status">Payment may already be recorded. Retry uses the same identity and exact input.</p>}
      {dialog === "payment" ? <fieldset disabled={busy || pending} className="space-y-3"><p className="text-sm text-muted">Manual record only; this does not move cash or call a payment gateway.</p><label className="block">Amount (NPR)<input aria-label="Installment amount" className={field} inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} /></label><label className="block">Method<ProjectSelect value={method} onChange={e => setMethod(e.target.value as PaymentInput["method"])}><option value="CASH">Cash</option><option value="BANK_TRANSFER">Bank transfer</option><option value="OTHER">Other</option></ProjectSelect></label><label className="block">Reference<input className={field} value={reference} maxLength={120} onChange={e => setReference(e.target.value)} /></label><label className="block">Recorded payment date<ProjectDateInput value={paidAt} onChange={e => setPaidAt(e.target.value)} /></label></fieldset> : dialog === "attachments" && <PurchaseDocuments ids={ids} onChange={setIds} disabled={busy} />}
    </ModalFrame>
    <ModalFrame open={!!voidId} title="Void recorded payment" onClose={() => { if (!busy) setVoidId(null); }} footer={<button type="button" disabled={busy || reason.trim().length < 3} className="rounded bg-action px-4 py-2 text-white" onClick={() => mutate(() => voidPayment(voidId!, reason))}>Confirm void</button>}><p className="mb-3 text-sm text-muted">Retains the original entry and recalculates due. Record a corrected payment separately.</p><label>Void reason<input className={field} value={reason} minLength={3} maxLength={500} onChange={e => setReason(e.target.value)} /></label>{error && <p role="alert">{error}</p>}</ModalFrame>
  </section>;
}
