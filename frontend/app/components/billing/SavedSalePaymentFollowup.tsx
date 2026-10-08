import { useEffect, useRef, useState } from "react";
import { DialogButton, ModalFrame } from "~/components/ui/Modal";
import ProjectSelect from "~/components/ui/ProjectSelect";
import { addPaymentApi, getInvoiceApi } from "~/lib/api/endpoints";
import { getEnabledPaymentAccountsApi, type EnabledPaymentAccountDto } from "~/lib/api/paymentAccounts";
import { getAuthUser } from "~/lib/auth";
import { normalizeInvoice } from "~/lib/invoices";
import {
  clearMatchingManualPaymentFollowup, readManualPaymentFollowups, retainManualPaymentFollowup,
  type ManualPaymentFollowup,
} from "~/lib/manualPaymentFollowup";

export default function SavedSalePaymentFollowup({ actorId, invoiceId, onClose }: {
  actorId: string; invoiceId: string | null; onClose: () => void;
}) {
  const [pending, setPending] = useState<ManualPaymentFollowup[]>([]);
  const [selectedInvoice, setSelectedInvoice] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<EnabledPaymentAccountDto[]>([]);
  const [accountId, setAccountId] = useState("");
  const [method, setMethod] = useState<"FONEPAY" | "BANK_TRANSFER">("FONEPAY");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [due, setDue] = useState<number | null>(null);
  const [gatewayPending, setGatewayPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const editorScope = useRef("");
  const [authCurrent, setAuthCurrent] = useState(true);

  useEffect(() => {
    const syncAuth = () => {
      const user = getAuthUser();
      const valid = user?.id === actorId && (user.role === "cashier" || user.role === "manager" || user.role === "admin");
      setAuthCurrent(valid);
      if (!valid) {
        generation.current++;
        setSelectedInvoice(null); setAccounts([]); setPending([]); setNotice(""); setError("");
      }
    };
    syncAuth();
    window.addEventListener("storage", syncAuth);
    window.addEventListener("focus", syncAuth);
    document.addEventListener("visibilitychange", syncAuth);
    return () => {
      generation.current++;
      window.removeEventListener("storage", syncAuth);
      window.removeEventListener("focus", syncAuth);
      document.removeEventListener("visibilitychange", syncAuth);
    };
  }, [actorId]);

  function refreshPending() {
    try { setPending(readManualPaymentFollowups(window.sessionStorage, actorId)); }
    catch { setError("Receipt recovery storage is unavailable. No new payment will be sent."); }
  }
  useEffect(() => {
    generation.current++;
    setSelectedInvoice(null); setNotice(""); setError(""); setPending([]);
    if (actorId) refreshPending();
  }, [actorId]);
  useEffect(() => { if (invoiceId) setSelectedInvoice(invoiceId); }, [invoiceId]);
  const retained = pending.find((item) => item.invoiceId === selectedInvoice);
  const retainedIdentity = retained ? JSON.stringify(retained) : "";

  useEffect(() => {
    const turn = ++generation.current;
    const controller = new AbortController();
    const scope = `${actorId}:${selectedInvoice || ""}`;
    if (editorScope.current !== scope) {
      editorScope.current = scope;
      setAmount(""); setReference(""); setError("");
    }
    setAccounts([]); setAccountId(""); setConfirmed(false);
    setDue(null); setGatewayPending(false);
    if (!selectedInvoice) return;
    setLoading(true);
    // A retained request must replay even if its destination is now disabled or the invoice is paid.
    if (retained) {
      setMethod(retained.payload.method); setAmount(String(retained.payload.amount));
      setReference(retained.payload.reference); setAccountId(retained.payload.receivingAccountId); setConfirmed(true);
      setLoading(false);
      return () => { controller.abort(); };
    }
    void Promise.all([getInvoiceApi(selectedInvoice), getEnabledPaymentAccountsApi({ signal: controller.signal })])
      .then(([raw, list]) => {
        if (controller.signal.aborted || turn !== generation.current) return;
        const invoice = normalizeInvoice(raw.invoice || raw);
        setDue(invoice.dueAmount);
        setGatewayPending(invoice.payments.some((p) => p.method === "eSewa" && p.status === "PENDING" && p.kind === "CHARGE"));
        setAccounts(list.filter((a) => a.supportedSettlement && a.confirmationMode === "MANUAL_RECEIPT"));
      }).catch(() => {
        if (!controller.signal.aborted && turn === generation.current) setError("Could not load invoice and receiving accounts. Close and reopen to retry.");
      }).finally(() => { if (!controller.signal.aborted && turn === generation.current) setLoading(false); });
    return () => { controller.abort(); };
  }, [selectedInvoice, actorId, retainedIdentity]);

  async function submit() {
    const liveUser = getAuthUser();
    if (busyRef.current || !selectedInvoice || liveUser?.id !== actorId || !["cashier", "manager", "admin"].includes(liveUser.role)) return;
    let item = retained;
    setError(""); setNotice("");
    busyRef.current = true; setBusy(true);
    try {
      if (!item) {
        const value = Number(amount);
        const account = accounts.find((a) => a.id === accountId && a.settlementMethod === method);
        if (!account || !confirmed || !Number.isFinite(value) || value <= 0 || value !== Math.round(value * 100) / 100 || due === null || value > due || gatewayPending || !reference.trim() || reference.trim().length > 160) {
          throw new Error("Check destination, actual received amount, reference and receipt confirmation. Amount cannot exceed the remaining due.");
        }
        item = { actorId, invoiceId: selectedInvoice, payload: {
          method, amount: value, reference: reference.trim(), status: "SUCCESS",
          receivingAccountId: account.id, receivingAccountVersion: account.version,
          manualReceiptConfirmed: true, manualOperationKey: crypto.randomUUID(),
        } };
      }
      // Persist before dispatch; failures retain the original body and operation identity.
      retainManualPaymentFollowup(window.sessionStorage, item);
      refreshPending();
      const payment = await addPaymentApi(item.invoiceId, item.payload);
      const responseUser = getAuthUser();
      if (responseUser?.id !== actorId || !["cashier", "manager", "admin"].includes(responseUser.role)) return;
      if (!payment?.id || payment.invoiceId !== item.invoiceId || payment.method !== item.payload.method || payment.reference !== item.payload.reference || payment.receivingAccountId !== item.payload.receivingAccountId || Number(payment.amount) !== item.payload.amount || payment.receivingDestinationSnapshot?.accountVersion !== item.payload.receivingAccountVersion || payment.receivingDestinationSnapshot?.confirmedById !== actorId || !["SUCCESS", "FAILED"].includes(payment.status)) {
        throw new Error("Payment response could not be reconciled. Recover the original receipt request.");
      }
      const cleared = clearMatchingManualPaymentFollowup(window.sessionStorage, item);
      refreshPending();
      if (!cleared) throw new Error("The receipt slot changed during submission. The newer request remains retained.");
      setNotice(`Receipt recorded for invoice ${item.invoiceId}. Status: ${payment.status}.`);
      setSelectedInvoice(null); onClose();
    } catch (err: any) {
      const responseUser = getAuthUser();
      if (responseUser?.id !== actorId || !["cashier", "manager", "admin"].includes(responseUser.role)) return;
      // These explicit transaction-rejection codes prove no receipt committed.
      // Permit a new, manually reviewed intent; unknown/conflicting outcomes stay frozen.
      if (item && ["RECEIVING_ACCOUNT_CHANGED", "GATEWAY_OUTCOME_UNRESOLVED", "OVERPAYMENT"].includes(err?.response?.data?.code)) {
        clearMatchingManualPaymentFollowup(window.sessionStorage, item);
      }
      refreshPending();
      setError(err?.response?.data?.error || err?.message || "Outcome unknown. Recover the exact original receipt; do not record another payment.");
    } finally { busyRef.current = false; setBusy(false); }
  }

  if (!authCurrent) return null;
  return <>
    {notice ? <p role="status" className="m-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm">{notice}</p> : null}
    {pending.length ? <div className="m-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
      <p className="font-semibold">Unresolved manual receipts — recover the original request before collecting again.</p>
      {pending.map((item) => <button key={item.invoiceId} disabled={busy} className="mt-2 block underline focus-visible:outline" onClick={() => setSelectedInvoice(item.invoiceId)}>Recover receipt for {item.invoiceId}</button>)}
    </div> : null}
    <ModalFrame open={Boolean(selectedInvoice)} onClose={() => { if (!busyRef.current) { setSelectedInvoice(null); onClose(); } }} title="Record received payment" maxWidthClass="max-w-lg">
      <div className="space-y-4 p-5 text-sm">
        <p>Saved invoice <span className="font-mono break-all">{selectedInvoice}</span></p>
        {retained ? <p className="rounded-xl border border-amber-300 bg-amber-50 p-3">Recovering the exact original receipt request. Details are locked; this can reconcile an already recorded payment after response loss.</p> : <p>Remaining due: <span className="font-mono">{due === null ? "Loading…" : `NPR ${due.toFixed(2)}`}</span>. Waiting for cashier confirmation.</p>}
        {gatewayPending ? <p role="alert">An eSewa outcome is pending. Resolve gateway verification before recording a manual receipt.</p> : null}
        {error ? <p role="alert" className="text-rose-700">{error}</p> : null}
        <label className="block">Payment method<ProjectSelect aria-label="Saved receipt method" value={method} disabled={Boolean(retained) || busy || loading} onChange={(e) => { setMethod(e.target.value as typeof method); setAccountId(""); setConfirmed(false); }}><option value="FONEPAY">Fonepay</option><option value="BANK_TRANSFER">Bank transfer</option></ProjectSelect></label>
        {retained ? <p>Original receiving account: <span className="font-mono break-all">{retained.payload.receivingAccountId}</span> (version {retained.payload.receivingAccountVersion})</p> : <label className="block">Receiving destination<ProjectSelect aria-label="Saved receipt destination" value={accountId} disabled={busy || loading} onChange={(e) => { setAccountId(e.target.value); setConfirmed(false); }}><option value="">Select receiving account</option>{accounts.filter((a) => a.settlementMethod === method).map((a) => <option key={a.id} value={a.id}>{a.providerLabel} — {a.accountHolder} — {a.accountIdentifier || "No identifier"}</option>)}</ProjectSelect></label>}
        <label className="block">Actual received amount (NPR)<input className="mt-1 w-full rounded-xl border border-[#cfcfd3] p-3 font-mono" aria-label="Saved receipt amount" inputMode="decimal" value={amount} disabled={Boolean(retained) || busy || loading} onChange={(e) => { setAmount(e.target.value); setConfirmed(false); }} /></label>
        <label className="block">Receipt reference<input className="mt-1 w-full rounded-xl border border-[#cfcfd3] p-3" aria-label="Saved receipt reference" maxLength={160} value={reference} disabled={Boolean(retained) || busy || loading} onChange={(e) => { setReference(e.target.value); setConfirmed(false); }} /></label>
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={Boolean(retained) || busy || loading} onChange={(e) => setConfirmed(e.target.checked)} />I checked this receiving account and received NPR {amount || "0"}.</label>
        <div className="flex flex-wrap justify-end gap-2"><DialogButton disabled={busy} onClick={() => { setSelectedInvoice(null); onClose(); }}>Close</DialogButton><DialogButton disabled={busy || loading || (!retained && (gatewayPending || !confirmed || !accountId || due === null || due <= 0))} onClick={() => void submit()}>{busy ? "Recording…" : retained ? "Recover Original Receipt" : "Record Received Payment"}</DialogButton></div>
      </div>
    </ModalFrame>
  </>;
}
