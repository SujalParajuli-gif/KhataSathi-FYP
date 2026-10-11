import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ModalFrame } from "~/components/ui/Modal";
import { getCurrentCashDrawerApi, type CashDrawer } from "~/lib/api/endpoints";
import { confirmCashPayout, confirmCashRecovery, type CashPayout, type CreditSource } from "~/lib/api/receivables";
import { formatNpr } from "~/lib/invoices";

export type CashAction = { customerName: string; invoiceNo: string; source?: CreditSource; payout?: CashPayout };
export default function CashPayoutDialog({ action, onClose, onSuccess }: { action: CashAction; onClose: () => void; onSuccess: () => void }) {
  const [drawer, setDrawer] = useState<CashDrawer | null>(null), [loading, setLoading] = useState(true), [loadError, setLoadError] = useState("");
  const [amount, setAmount] = useState(""), [reason, setReason] = useState(""), [cashConfirmed, setCashConfirmed] = useState(false), [newOnly, setNewOnly] = useState(false);
  const [busy, setBusy] = useState(false), [unknown, setUnknown] = useState(false), [error, setError] = useState("");
  const pending = useRef<Parameters<typeof confirmCashPayout>[0] | Parameters<typeof confirmCashRecovery>[1] | null>(null), active = useRef(false);
  const locked = busy || unknown;
  useEffect(() => { let live = true; getCurrentCashDrawerApi().then(r => { if (live) setDrawer(r.drawer); }).catch(() => { if (live) setLoadError("Your cash drawer could not be loaded. Close and retry before recording cash."); }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, []);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (active.current) return;
    if (!pending.current) {
      const n = Number(amount);
      if (!drawer || drawer.status !== "OPEN" || !reason.trim() || !cashConfirmed || (!action.payout && (!newOnly || !Number.isFinite(n) || n <= 0 || Math.round((n + Number.EPSILON) * 100) / 100 !== n || n > (action.source?.availableCredit || 0)))) {
        setError("Use your open drawer, enter a valid amount and reason, and confirm the actual cash movement."); return;
      }
      const common = { drawerId: drawer.id, reason: reason.trim(), operationKey: crypto.randomUUID() };
      pending.current = action.payout ? { ...common, cashReceivedConfirmed: true } : { ...common,
        ...(action.source!.correctionId ? { sourceCorrectionId: action.source!.correctionId } : { sourceReturnId: action.source!.returnId }), amount: n, cashConfirmed: true, newPayoutConfirmed: true };
    }
    active.current = true; setBusy(true); setError("");
    try {
      if (action.payout) await confirmCashRecovery(action.payout.id, pending.current as Parameters<typeof confirmCashRecovery>[1]);
      else await confirmCashPayout(pending.current as Parameters<typeof confirmCashPayout>[0]);
      onSuccess();
    } catch (err: any) {
      const status = err?.response?.status;
      if (!status || status >= 500) { setUnknown(true); setError("Cash outcome unconfirmed. Keep this dialog open and retry the same cash operation; do not record another manual cash event."); }
      else { pending.current = null; setUnknown(false); setError(err?.response?.data?.error || "Cash confirmation was rejected. Reload balances and your drawer before correcting it."); }
    } finally { active.current = false; setBusy(false); }
  }
  return <ModalFrame open title={action.payout ? "Confirm cash recovery" : "Confirm customer-credit cash payout"} mobileBottomSheet onClose={() => { if (!locked) onClose(); }}>
    <form onSubmit={submit} className="space-y-4">
      <p className="break-words">{action.customerName}. Source {action.invoiceNo}</p>
      {loading ? <p role="status">Loading your open drawer...</p> : loadError ? <p role="alert">{loadError}</p> : !drawer || drawer.status !== "OPEN" ? <p role="alert">Open your own cash drawer in <Link className="underline" to="/settings">Settings</Link> before recording a payout or cash recovery.</p> : <p className="break-all">Your open drawer: {drawer.id}</p>}
      {action.payout ? <p>Confirm receipt of the full {formatNpr(action.payout.amount)} previously paid out. This creates one CASH_IN in your current drawer and restores the original credit. It does not change the original payout or closed drawer.</p> : <>
        <p>Available source credit: {formatNpr(action.source!.availableCredit)}. This records a new CASH_OUT and reduces held credit; original sale receipts stay unchanged.</p>
        <label className="block text-sm font-medium">Cash payout amount (NPR)<input type="number" required step="0.01" min="0.01" max={action.source!.availableCredit} value={amount} disabled={locked} onChange={e => setAmount(e.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-line px-3" /></label>
      </>}
      <label className="block text-sm font-medium">Cash reason<textarea required maxLength={500} value={reason} disabled={locked} onChange={e => setReason(e.target.value)} className="mt-2 min-h-24 w-full rounded-xl border border-line p-3" /></label>
      <label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" required checked={cashConfirmed} disabled={locked} onChange={e => setCashConfirmed(e.target.checked)} className="mt-1 size-5 shrink-0" /><span>{action.payout ? "I have actually received the full cash amount from this customer." : "I have actually handed this cash amount to the original customer."}</span></label>
      {!action.payout && <label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" required checked={newOnly} disabled={locked} onChange={e => setNewOnly(e.target.checked)} className="mt-1 size-5 shrink-0" /><span>This is a new payout and has not already been recorded as a manual cash-out.</span></label>}
      {error && <p role="alert">{error}</p>}
      <div className="flex flex-wrap justify-end gap-3"><button type="button" disabled={locked} onClick={onClose} className="min-h-11 rounded-xl border border-line px-4">Cancel</button><button type="submit" disabled={busy || loading || (!unknown && (!drawer || drawer.status !== "OPEN" || Boolean(loadError)))} className="min-h-11 rounded-xl bg-ink px-4 text-white">{busy ? "Recording..." : unknown ? "Retry same cash operation" : action.payout ? "Confirm actual cash received" : "Confirm new cash payout"}</button></div>
    </form>
  </ModalFrame>;
}
