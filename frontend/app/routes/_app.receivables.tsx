import { useEffect, useState } from "react";
import { Link } from "react-router";
import CardShell from "~/components/ui/CardShell";
import PaginationBar from "~/components/ui/PaginationBar";
import { getAuthUser } from "~/lib/auth";
import { customerReceivables, type ReceivableCustomer } from "~/lib/api/receivables";
import { formatNpr } from "~/lib/invoices";

export default function ReceivablesRoute() {
  const role = getAuthUser()?.role, allowed = role === "admin" || role === "manager";
  const [q, setQ] = useState(""), [page, setPage] = useState(1), [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ key: string; items: ReceivableCustomer[]; total: number; totalPages: number; error?: string } | null>(null);
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
    <header><h1 className="text-2xl font-semibold">Customer receivables</h1><p className="mt-2 max-w-3xl text-sm text-muted">Recorded original-sale dues and retained return credit in NPR. Credit stays with its original customer and is shown separately from debt. No automatic application or payout is recorded here.</p></header>
    <CardShell className="p-4 sm:p-5"><label className="block max-w-md text-sm font-medium">Search customer<input type="search" maxLength={100} value={q} onChange={e => { setQ(e.target.value); setPage(1); }} className="mt-2 min-h-11 w-full rounded-xl border border-line bg-surface px-3" /></label>
      <section className="mt-4 space-y-3" aria-label="Customer balances" aria-busy={!current}>
        {!current && <p role="status">Loading recorded balances...</p>}
        {current?.error && <div><p role="alert">{current.error}</p><button type="button" onClick={() => setRefresh(n => n + 1)} className="min-h-11 underline">Retry balances</button></div>}
        {current && !current.error && !current.items.length && <p>No customers match this search.</p>}
        {current && !current.error && current.items.map(c => <details key={c.id} className="rounded-xl border border-line p-3 sm:p-4">
          <summary className="cursor-pointer"><span className="font-semibold break-words">{c.name}{!c.isActive && " (inactive)"}</span><span className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm"><span>Due: <strong className="font-mono">{c.due === null ? "Unresolved" : formatNpr(c.due)}</strong></span><span>Retained credit: <strong className="font-mono">{c.retainedCredit === null ? "Unresolved" : formatNpr(c.retainedCredit)}</strong></span></span></summary>
          {c.unresolvedCount > 0 && <p className="mt-3 text-sm">{c.unresolvedCount} sale(s) need settlement review. Supported subtotal only: due {formatNpr(c.supportedDue)}, held credit {formatNpr(c.supportedCredit)}. These subtotals exclude unresolved sales.</p>}
          {!c.invoices.length && <p className="mt-3 text-sm text-muted">No finalized sale records.</p>}
          <ul className="mt-3 space-y-3">{c.invoices.map(i => <li key={i.invoiceId} className="border-t border-line pt-3 text-sm"><Link to={`/invoices?invoiceId=${encodeURIComponent(i.invoiceId)}`} className="inline-flex min-h-10 items-center font-semibold underline">{i.invoiceNo}</Link>{i.reason ? <p>{i.reason}. Due and credit withheld.</p> : <div className="grid gap-1 sm:grid-cols-2"><p>Original payable: {formatNpr(i.originalPayable)}</p><p>Approved return reduction: {formatNpr(i.returnAdjustment)}</p><p>Successful recorded receipts: {formatNpr(i.recordedReceipts)}</p><p>Due: {formatNpr(i.due!)} | Held credit: {formatNpr(i.retainedCredit!)}</p></div>}</li>)}</ul>
        </details>)}
      </section>
      {current && !current.error && <PaginationBar page={page} totalPages={Math.max(1, current.totalPages)} total={current.total} start={(page - 1) * 20} end={Math.min(page * 20, current.total)} pageSize={20} pageSizeOptions={[20]} onPageChange={setPage} onPageSizeChange={() => {}} label="customers" />}
    </CardShell>
  </div>;
}
