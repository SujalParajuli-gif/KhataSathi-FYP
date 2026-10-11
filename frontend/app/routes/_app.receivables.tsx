import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import CardShell from "~/components/ui/CardShell";
import PaginationBar from "~/components/ui/PaginationBar";
import { getAuthUser } from "~/lib/auth";
import { customerReceivables, applyCredit, reverseCredit, type ReceivableCustomer, type ReceivableInvoice, type CreditApplication } from "~/lib/api/receivables";
import { ModalFrame } from "~/components/ui/Modal";
import ProjectSelect from "~/components/ui/ProjectSelect";
import { formatNpr } from "~/lib/invoices";

import CashPayoutDialog, { type CashAction } from "~/components/receivables/CashPayoutDialog";

export default function ReceivablesRoute() {
  const role = getAuthUser()?.role, allowed = role === "admin" || role === "manager";
  const [q, setQ] = useState(""), [page, setPage] = useState(1), [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ key: string; items: ReceivableCustomer[]; total: number; totalPages: number; error?: string } | null>(null);
  const [action, setAction] = useState<{ customer: ReceivableCustomer; invoice: ReceivableInvoice; source?: { returnId?: string; correctionId?: string; availableCredit: number }; application?: CreditApplication } | null>(null);
  const [cashAction, setCashAction] = useState<CashAction | null>(null);
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const key = JSON.stringify([q, page, refresh]);
  useEffect(() => {
    if (!allowed) return;
    const c = new AbortController();
    const timer = window.setTimeout(() => {
      customerReceivables(q, page, c.signal).then(r => { if (!c.signal.aborted) setResult({ ...r, key }); })
        .catch(() => { if (!c.signal.aborted) setResult({ key, items: [], total: 0, totalPages: 0, error: "Customer balances could not be loaded. Retry to reload the recorded sources." }); });
    }, 200);
    return () => { clearTimeout(timer); c.abort(); };
  }, [allowed, key]);
  const current = result?.key === key ? result : null;
  if (!allowed) return <p role="alert" className="p-6">Customer receivables require administrator or manager access.</p>;
  return <div className="space-y-5 p-4 sm:p-6 text-ink">
    <header><h1 className="text-2xl font-semibold">Customer receivables</h1><p className="mt-2 max-w-3xl text-sm text-muted">Recorded sale dues and retained credit in NPR. Credit stays with its original customer. Approved return or captured correction credit can be applied explicitly to another supported sale; receipts and credit are shown separately.</p></header>
    {notice && <p role="status">{notice}</p>}
    <CardShell className="p-4 sm:p-5"><label className="block max-w-md text-sm font-medium">Search customer<input type="search" maxLength={100} value={q} onChange={e => { setQ(e.target.value); setPage(1); }} className="mt-2 min-h-11 w-full rounded-xl border border-line bg-surface px-3" /></label><button type="button" disabled={Boolean(action || cashAction)} onClick={() => setRefresh(n => n + 1)} className="min-h-11 underline">Refresh balances</button>
      <section className="mt-4 space-y-3" aria-label="Customer balances" aria-busy={!current}>
        {!current && <p role="status">Loading recorded balances...</p>}
        {current?.error && <div><p role="alert">{current.error}</p><button type="button" onClick={() => setRefresh(n => n + 1)} className="min-h-11 underline">Retry balances</button></div>}
        {current && !current.error && !current.items.length && <p>No customers match this search.</p>}
        {current && !current.error && current.items.map(c => <details key={c.id} open={expanded.has(c.id)} onToggle={e => { const open = e.currentTarget.open; setExpanded(previous => { const next = new Set(previous); if (open) next.add(c.id); else next.delete(c.id); return next; }); }} className="rounded-xl border border-line p-3 sm:p-4">
          <summary className="cursor-pointer"><span className="font-semibold break-words">{c.name}{!c.isActive && " (inactive)"}</span><span className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm"><span>Due: <strong className="font-mono">{c.due === null ? "Unresolved" : formatNpr(c.due)}</strong></span><span>Retained credit: <strong className="font-mono">{c.retainedCredit === null ? "Unresolved" : formatNpr(c.retainedCredit)}</strong></span></span></summary>
          {c.unresolvedCount > 0 && <p className="mt-3 text-sm">{c.unresolvedCount} sale(s) need settlement review. Supported subtotal only: due {formatNpr(c.supportedDue)}, held credit {formatNpr(c.supportedCredit)}. These subtotals exclude unresolved sales.</p>}
          {!c.invoices.length && <p className="mt-3 text-sm text-muted">No finalized sale records.</p>}
          <ul className="mt-3 space-y-3">{c.invoices.map(i => <li key={i.invoiceId} className="border-t border-line pt-3 text-sm"><Link to={`/invoices?invoiceId=${encodeURIComponent(i.invoiceId)}`} className="inline-flex min-h-10 items-center font-semibold underline">{i.invoiceNo}</Link>{i.reason ? <p>{i.reason}. Due and credit withheld.</p> : <>
            <div className="grid gap-1 sm:grid-cols-2"><p>Original payable: {formatNpr(i.originalPayable)}</p><p>Approved return reduction: {formatNpr(i.returnAdjustment)}</p><p>Successful recorded receipts: {formatNpr(i.recordedReceipts)}</p><p>Applied credit: {formatNpr(i.appliedCredit || 0)}</p><p>Replacement settlement credit: {formatNpr(i.correctionCredit || 0)} (noncash)</p><p>Due: {formatNpr(i.due!)} | Held credit: {formatNpr(i.retainedCredit!)}</p><p>Retained credit used elsewhere: {formatNpr(i.usedCredit || 0)}</p><p>Confirmed cash paid out, not yet recovered: {formatNpr(i.paidOutCredit || 0)}</p></div>
            {i.correction && <div className="mt-3 space-y-1"><p>{i.correction.action === "CANCEL" ? "Cancellation" : "Replacement"} settlement recorded {new Date(i.correction.createdAt).toLocaleString()} by {i.correction.actorId}.</p><p className="break-words">Reason: {i.correction.reason}</p><p>Source: <Link className="underline" to={`/invoices?invoiceId=${encodeURIComponent(i.correction.sourceInvoiceId)}`}>{i.correction.sourceInvoiceId}</Link>{i.correction.targetInvoiceId && <> &middot; Replacement: <Link className="underline" to={`/invoices?invoiceId=${encodeURIComponent(i.correction.targetInvoiceId)}`}>{i.correction.targetInvoiceId}</Link></>}</p>{i.correction.sourceInvoiceId === i.invoiceId && <p>Residual credit stays with this original customer. Apply available correction credit explicitly to another supported sale. Confirm a new cash payout only after handing cash to the original customer; existing manual cash-outs cannot be linked.</p>}</div>}
            {(i.creditSources || []).filter(s => s.availableCredit > 0).map(s => <div key={s.returnId || s.correctionId} className="mt-3"><p className="break-all">{s.correctionId ? "Correction" : "Return"} {s.correctionId || s.returnId}: {formatNpr(s.availableCredit)} available</p><button type="button" className="min-h-11 underline" disabled={!c.invoices.some(t => t.invoiceId !== i.invoiceId && !t.reason && !t.returnAdjustment && (t.due || 0) > 0)} onClick={() => setAction({ customer: c, invoice: i, source: s })}>Apply credit from {s.correctionId ? "correction" : "return"} {s.correctionId || s.returnId}</button><button type="button" className="ml-4 min-h-11 underline" onClick={() => setCashAction({ customerName: c.name, invoiceNo: i.invoiceNo, source: s })}>Confirm cash payout from {s.correctionId ? "correction" : "return"} {s.correctionId || s.returnId}</button></div>)}
          </>}
            {(i.payouts || []).map(p => <div key={p.id} className="mt-3 rounded-lg bg-surface p-3"><p>Cash payout: {formatNpr(p.amount)}: {p.recoveredAt ? "Cash recovered" : "Paid out"}</p><p className="break-words">Reason: {p.reason}</p><p className="break-all">Recorded {new Date(p.createdAt).toLocaleString()} by {p.actorId}. Drawer {p.drawerId}; CASH_OUT {p.payoutEventId}.</p>{p.recoveredAt ? <p className="break-all">Recovered {new Date(p.recoveredAt).toLocaleString()} by {p.recoveredById}. Drawer {p.recoveryDrawerId}; CASH_IN {p.recoveryEventId}. Reason: {p.recoveryReason}</p> : !i.reason && <button type="button" className="min-h-11 underline" onClick={() => setCashAction({ customerName: c.name, invoiceNo: i.invoiceNo, payout: p })}>Record actual cash recovery</button>}</div>)}
            {(i.applications || []).map(a => <div key={a.id} className="mt-3 rounded-lg bg-surface p-3"><p>Credit {a.sourceInvoiceId === i.invoiceId ? "to" : "from"} <Link className="underline" to={`/invoices?invoiceId=${encodeURIComponent(a.sourceInvoiceId === i.invoiceId ? a.targetInvoiceId : a.sourceInvoiceId)}`}>{a.sourceInvoiceId === i.invoiceId ? a.targetInvoiceNo : a.sourceInvoiceNo}</Link>: {formatNpr(a.amount)} — {a.reversedAt ? "Reversed" : "Applied"}</p><p className="break-words">Reason: {a.reason}</p><p className="text-muted break-all">Recorded {new Date(a.createdAt).toLocaleString()} by {a.actorId}</p>{a.reversedAt && <p className="break-words">Reversal: {a.reversalReason}</p>}{!a.reversedAt && a.sourceInvoiceId === i.invoiceId && <button type="button" className="min-h-11 underline" onClick={() => setAction({ customer: c, invoice: i, application: a })}>Reverse credit application to {a.targetInvoiceNo}</button>}</div>)}
          </li>)}</ul>
        </details>)}
      </section>
      {current && !current.error && <PaginationBar page={page} totalPages={Math.max(1, current.totalPages)} total={current.total} start={(page - 1) * 20} end={Math.min(page * 20, current.total)} pageSize={20} pageSizeOptions={[20]} onPageChange={setPage} onPageSizeChange={() => {}} label="customers" />}
    </CardShell>
    {cashAction && <CashPayoutDialog action={cashAction} onClose={() => setCashAction(null)} onSuccess={() => { setCashAction(null); setNotice(cashAction.payout ? "Cash recovery recorded once; original credit restored." : "New cash payout recorded once; source credit and drawer refreshed."); setRefresh(n => n + 1); }} />}
    {action && <CreditDialog action={action} onClose={() => setAction(null)} onSuccess={() => { setAction(null); setNotice(action.application ? "Credit application reversed. Source availability and target due have been refreshed." : "Credit applied. Recorded receipts are unchanged."); setRefresh(n => n + 1); }} />}
  </div>;
}

function CreditDialog({ action, onClose, onSuccess }: { action: { customer: ReceivableCustomer; invoice: ReceivableInvoice; source?: { returnId?: string; correctionId?: string; availableCredit: number }; application?: CreditApplication }; onClose: () => void; onSuccess: () => void }) {
  const targets = action.customer.invoices.filter(i => i.invoiceId !== action.invoice.invoiceId && !i.reason && !i.returnAdjustment && (i.due || 0) > 0);
  const [target, setTarget] = useState(targets[0]?.invoiceId || ""), [amount, setAmount] = useState(""), [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false), [unknown, setUnknown] = useState(false), [error, setError] = useState("");
  const pending = useRef<Parameters<typeof applyCredit>[0] | { reason: string; operationKey: string } | null>(null);
  const active = useRef(false);
  const due = targets.find(i => i.invoiceId === target)?.due || 0;
  const limit = Math.min(due, action.source?.availableCredit || 0);
  const locked = busy || unknown;
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (active.current) return;
    if (!pending.current) {
      const n = Number(amount);
      if (!reason.trim() || (!action.application && (!target || !Number.isFinite(n) || n <= 0 || Math.round((n + Number.EPSILON) * 100) / 100 !== n || n > limit))) { setError("Enter a reason and an amount within the available credit and target due."); return; }
      pending.current = action.application ? { reason: reason.trim(), operationKey: crypto.randomUUID() } : { ...(action.source!.correctionId ? { sourceCorrectionId: action.source!.correctionId } : { sourceReturnId: action.source!.returnId }), targetInvoiceId: target, amount: n, reason: reason.trim(), operationKey: crypto.randomUUID() };
    }
    active.current = true; setBusy(true); setError("");
    try {
      if (action.application) await reverseCredit(action.application.id, pending.current);
      else await applyCredit(pending.current as Parameters<typeof applyCredit>[0]);
      onSuccess();
    } catch (err: any) {
      const status = err?.response?.status;
      if (!status || status >= 500) { setUnknown(true); setError("Outcome unconfirmed. Retry this exact operation to recover its recorded result."); }
      else { pending.current = null; setUnknown(false); setError(err?.response?.data?.error || "Credit operation was rejected. Reload the balances before correcting it."); }
    } finally { active.current = false; setBusy(false); }
  }
  return <ModalFrame open title={action.application ? "Reverse credit application" : "Apply retained credit"} onClose={() => { if (!locked) onClose(); }} mobileBottomSheet>
    <form onSubmit={submit} className="space-y-4">
      <p className="break-words">{action.customer.name} · Source {action.invoice.invoiceNo}</p>
      {action.application ? <p>Restore {formatNpr(action.application.amount)} to the original credit source and increase the due on {action.application.targetInvoiceNo}. This records no cash movement.</p> : <>
        <p>Source {action.source!.correctionId ? "correction" : "return"} credit available: {formatNpr(action.source!.availableCredit)}</p>
        <label className="block text-sm font-medium">Target sale<ProjectSelect aria-label="Target sale" value={target} disabled={locked} onChange={e => setTarget(e.target.value)}>{targets.map(i => <option key={i.invoiceId} value={i.invoiceId}>{i.invoiceNo} · due {formatNpr(i.due!)}</option>)}</ProjectSelect></label>
        <label className="block text-sm font-medium">Credit amount (NPR)<input type="number" step="0.01" min="0.01" max={limit} required disabled={locked} value={amount} onChange={e => setAmount(e.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-line px-3" /></label>
        <p className="text-sm">Maximum {formatNpr(limit)}. This reduces the target due using existing customer credit; successful receipts stay unchanged.</p>
      </>}
      <label className="block text-sm font-medium">Reason<textarea required maxLength={500} disabled={locked} value={reason} onChange={e => setReason(e.target.value)} className="mt-2 min-h-24 w-full rounded-xl border border-line p-3" /></label>
      {error && <p role="alert">{error}</p>}
      <div className="flex flex-wrap justify-end gap-3"><button type="button" disabled={locked} onClick={onClose} className="min-h-11 rounded-xl border border-line px-4">Cancel</button><button type="submit" disabled={busy} className="min-h-11 rounded-xl bg-ink px-4 text-white">{busy ? "Recording..." : unknown ? "Retry same credit operation" : action.application ? "Confirm reversal" : "Confirm credit application"}</button></div>
    </form>
  </ModalFrame>;
}
