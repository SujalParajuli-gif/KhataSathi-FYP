import { useRef, useState } from "react";
import { ModalFrame } from "~/components/ui/Modal";
import ProjectDateInput from "~/components/ui/ProjectDateInput";
import { recordExpense, expenseError, type Expense, type ExpenseFields, type ExpenseOperation } from "~/lib/api/expenses";

function today() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kathmandu", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)!.value).join('-');
}
export default function ExpenseEditor({ action, value, onClose, onSaved, onReload }: {
  action: "CREATE" | "CORRECT" | "VOID"; value?: Expense; onClose: () => void; onSaved: (id: string) => void; onReload: () => void;
}) {
  const [draft, setDraft] = useState<ExpenseFields>({ amount: value?.amount || "", occurredOn: value?.occurredOn || today(), category: value?.category || "", description: value?.description || "" });
  const [reason, setReason] = useState(""); const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false); const [pending, setPending] = useState(false); const [error, setError] = useState(""); const [conflict, setConflict] = useState(false);
  const frozen = useRef<ExpenseOperation | null>(null); const sending = useRef(false);
  function validate() {
    if (action !== "VOID") {
      if (!/^\d{1,18}(\.\d{1,2})?$/.test(draft.amount.trim()) || BigInt(draft.amount.trim().replace('.', '')) === 0n) throw new Error("Enter a positive NPR amount with at most 18 whole digits and two decimal places.");
      const date = new Date(draft.occurredOn + "T00:00:00Z");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.occurredOn) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== draft.occurredOn) throw new Error("Choose a real expense date.");
      if (!draft.category.trim() || !draft.description.trim()) throw new Error("Enter a category and description.");
    }
    if (action !== "CREATE" && reason.trim().length < 3) throw new Error("Enter a correction or void reason (at least three characters).");
  }
  async function save() {
    if (sending.current) return; sending.current = true;
    try {
      if (!frozen.current) {
        validate();
        frozen.current = { operationKey: crypto.randomUUID(), ...(action === "VOID" ? {} : { amount: draft.amount.trim(), occurredOn: draft.occurredOn, category: draft.category.trim(), description: draft.description.trim() }),
          ...(action === "CREATE" ? {} : { expectedRevision: value!.revision, reason: reason.trim() }) };
      }
      setBusy(true); setPending(true); setError(""); setConflict(false);
      const result = await recordExpense(action, value?.id ?? null, frozen.current);
      frozen.current = null; setPending(false); onSaved(result.expenseId);
    } catch (e) {
      setError(expenseError(e));
      const response = (e as { response?: { status: number } }).response;
      if (response && response.status < 500 && response.status !== 408) { frozen.current = null; setPending(false); setConflict(response.status === 409); }
    } finally { sending.current = false; setBusy(false); }
  }
  const title = action === "CREATE" ? "Record expense" : action === "CORRECT" ? "Correct expense" : "Void expense";
  const field = "mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm";
  return <ModalFrame open title={title} onClose={() => { if (!busy && !pending) onClose(); }} footer={<div className="flex flex-wrap gap-2">
    {review && !pending && <button type="button" disabled={busy} className="min-h-10 rounded-xl border border-line px-4 text-sm" onClick={() => { setReview(false); setError(""); }}>Edit input</button>}
    <button type="button" disabled={busy || conflict} className="min-h-10 rounded-xl bg-action px-4 text-sm text-white disabled:opacity-50" onClick={() => {
      if (review || pending) { void save(); return; }
      try { validate(); setReview(true); setError(""); } catch (e) { setError(expenseError(e)); }
    }}>{busy ? "Saving…" : pending ? "Retry same operation" : review ? `Confirm ${action === "CREATE" ? "expense" : action === "CORRECT" ? "correction" : "void"}` : "Review expense"}</button>
  </div>}>
    <p className="mb-4 text-sm text-muted">Expense record only. This does not move drawer cash, record a supplier payment, or change a sale or refund.</p>
    {error && <p role="alert" className="mb-3 text-sm">{error}</p>}
    {conflict && <button type="button" className="mb-3 min-h-10 rounded-xl border border-line px-3 text-sm" onClick={onReload}>Reload current expense</button>}
    {pending && <p role="status" className="mb-3 text-sm">This operation may already be saved. Retry keeps the same identity and exact input.</p>}
    {review || pending ? <dl className="space-y-3 text-sm"><div><dt>Amount (NPR)</dt><dd className="break-words font-mono font-semibold">{action === "VOID" ? value?.amount : draft.amount}</dd></div><div><dt>Expense date</dt><dd>{draft.occurredOn}</dd></div><div><dt>Category</dt><dd className="break-words">{draft.category}</dd></div><div><dt>Description</dt><dd className="break-words">{draft.description}</dd></div>{action !== "CREATE" && <><div><dt>Reason</dt><dd className="break-words">{reason}</dd></div><p>Revision {value?.revision} will be retained. {action === "VOID" ? "The record becomes voided and cannot be edited again." : "A new revision will be added."}</p></>}</dl> : <fieldset disabled={busy || pending} className="space-y-3 text-sm">
      {action !== "VOID" && <><label className="block">Amount (NPR)<input className={field} inputMode="decimal" maxLength={21} value={draft.amount} onChange={e => setDraft({ ...draft, amount: e.target.value })} /></label><label className="block">Expense date<ProjectDateInput value={draft.occurredOn} onChange={e => setDraft({ ...draft, occurredOn: e.target.value })} /></label><label className="block">Category<input className={field} maxLength={80} value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value })} /></label><label className="block">Description<textarea className={field} maxLength={500} rows={3} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label></>}
      {action === "VOID" && <p>Void NPR {value?.amount} · {value?.category}? The original entry and all corrections stay in history.</p>}
      {action !== "CREATE" && <label className="block">Reason<textarea className={field} minLength={3} maxLength={500} rows={2} value={reason} onChange={e => setReason(e.target.value)} /></label>}
    </fieldset>}
  </ModalFrame>;
}
