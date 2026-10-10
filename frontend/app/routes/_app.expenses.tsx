import { useEffect, useState } from "react";
import CardShell from "~/components/ui/CardShell";
import ProjectSelect from "~/components/ui/ProjectSelect";
import PaginationBar from "~/components/ui/PaginationBar";
import ExpenseEditor from "~/components/expenses/ExpenseEditor";
import { getAuthUser } from "~/lib/auth";
import { expenses, expense, expenseError, type Expense, type ExpenseDetail } from "~/lib/api/expenses";

export default function ExpensesRoute() {
  const role = getAuthUser()?.role, allowed = role === "admin" || role === "manager";
  const [q, setQ] = useState(""), [status, setStatus] = useState("ALL"), [page, setPage] = useState(1), [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<string | null>(null), [editor, setEditor] = useState<"CREATE" | "CORRECT" | "VOID" | null>(null);
  const [result, setResult] = useState<{ key: string; items: Expense[]; total: number; totalPages: number; error?: string } | null>(null);
  const [detail, setDetail] = useState<{ key: string; expense?: ExpenseDetail; error?: string } | null>(null);
  const key = JSON.stringify([q, status, page, refresh]), detailKey = JSON.stringify([selected, refresh]);
  useEffect(() => {
    if (!allowed) return; const c = new AbortController();
    expenses({ q, status, page }, c.signal).then(r => { if (!c.signal.aborted) setResult({ ...r, key }); }).catch(e => { if (!c.signal.aborted) setResult({ key, items: [], total: 0, totalPages: 0, error: expenseError(e) }); });
    return () => c.abort();
  }, [allowed, key]);
  useEffect(() => {
    if (!allowed || !selected) return; const c = new AbortController();
    expense(selected, c.signal).then(value => { if (!c.signal.aborted) setDetail({ key: detailKey, expense: value }); }).catch(e => { if (!c.signal.aborted) setDetail({ key: detailKey, error: expenseError(e) }); });
    return () => c.abort();
  }, [allowed, detailKey]);
  const current = result?.key === key ? result : null, currentDetail = detail?.key === detailKey ? detail : null, value = currentDetail?.expense;
  if (!allowed) return <p role="alert" className="p-6">Expense records require administrator or manager access.</p>;
  return <div className="space-y-5 p-4 sm:p-6 text-ink">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold">Expenses</h1><p className="mt-1 max-w-2xl text-sm text-muted">Recorded operational expenses in NPR. These entries do not move drawer cash or record payments, sales, or refunds.</p></div><button type="button" className="min-h-10 rounded-xl bg-action px-4 text-sm text-white" onClick={() => setEditor("CREATE")}>Record expense</button></header>
    <CardShell className="p-4 sm:p-5"><section aria-label="Expense history">
      <h2 className="mb-3 font-semibold">Expense history</h2><div className="mb-4 flex flex-wrap gap-3"><input aria-label="Search expenses" className="min-w-0 flex-1 rounded-xl border border-line px-3 py-2 text-sm" maxLength={160} placeholder="Search category or description" value={q} onChange={e => { setQ(e.target.value); setPage(1); }} /><ProjectSelect aria-label="Expense status" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="ALL">All records</option><option value="RECORDED">Recorded</option><option value="VOIDED">Voided</option></ProjectSelect></div>
      {!current && <p role="status">Loading expensesâ€¦</p>}{current?.error && <div><p role="alert">{current.error}</p><button type="button" className="min-h-10 underline" onClick={() => setRefresh(v => v + 1)}>Retry expenses</button></div>}
      {current && !current.error && <><ul className="divide-y divide-line sm:hidden">{current.items.map(row => <li key={row.id} className="py-3"><button type="button" className="w-full space-y-2 text-left" onClick={() => setSelected(row.id)}><span className="flex flex-wrap justify-between gap-2 text-xs text-muted"><span>{row.occurredOn}</span><span>{row.status === "VOIDED" ? "Voided" : "Recorded"} | Revision {row.revision}</span></span><span className="block break-words font-semibold underline">{row.category}</span><span className="block line-clamp-2 break-words">{row.description}</span><span className="block break-all font-mono">NPR {row.amount}</span></button></li>)}</ul><div className="hidden overflow-x-auto sm:block"><table className="w-full text-left text-sm"><caption className="sr-only">Current recorded expense revisions</caption><thead><tr><th className="py-2 pr-4">Date / category</th><th className="pr-4">Description</th><th className="pr-4 text-right">Amount (NPR)</th><th>Status</th></tr></thead><tbody>{current.items.map(row => <tr key={row.id} className="border-t border-line"><td className="py-3 pr-4"><button type="button" className="min-h-10 text-left underline" onClick={() => setSelected(row.id)}>{row.occurredOn}<span className="block max-w-48 break-words">{row.category}</span></button></td><td className="min-w-32 max-w-80 break-words pr-4">{row.description}</td><td className="whitespace-nowrap pr-4 text-right font-mono">{row.amount}</td><td>{row.status === "VOIDED" ? "Voided" : "Recorded"}<span className="block text-muted">Revision {row.revision}</span></td></tr>)}</tbody></table></div>{!current.items.length && <p className="py-6 text-center text-sm text-muted">No expense records match these filters.</p>}<PaginationBar page={page} totalPages={current.totalPages} total={current.total} start={(page - 1) * 20} end={Math.min(page * 20, current.total)} pageSize={20} pageSizeOptions={[20]} onPageChange={setPage} onPageSizeChange={() => {}} label="expenses" /></>}
    </section></CardShell>
    {selected && <CardShell className="p-4 sm:p-5"><section aria-label="Expense detail">
      {!currentDetail && <p role="status">Loading expense historyâ€¦</p>}{currentDetail?.error && <div><p role="alert">{currentDetail.error}</p><button type="button" className="min-h-10 underline" onClick={() => setRefresh(v => v + 1)}>Retry expense history</button></div>}
      {value && <><div className="flex flex-wrap justify-between gap-3"><div className="min-w-0"><h2 className="break-words text-lg font-semibold">{value.category}</h2><p className="text-sm text-muted">{value.occurredOn} Â· Revision {value.revision} Â· {value.status === "VOIDED" ? "Voided" : "Recorded"}</p></div><p className="break-all font-mono font-semibold">NPR {value.amount}</p></div><p className="my-3 break-words text-sm">{value.description}</p>{value.status === "RECORDED" && <div className="mb-4 flex flex-wrap gap-2"><button type="button" className="min-h-10 rounded-xl border border-line px-3 text-sm" onClick={() => setEditor("CORRECT")}>Correct expense</button><button type="button" className="min-h-10 rounded-xl border border-line px-3 text-sm" onClick={() => setEditor("VOID")}>Void expense</button></div>}<h3 className="font-semibold">Retained revisions</h3><ol className="mt-3 space-y-3">{value.revisions.map(r => <li key={r.revision} className="space-y-1 border-t border-line pt-3 text-sm"><p>Revision {r.revision} Â· {r.action} Â· {r.status}</p><p className="break-words font-mono">NPR {r.amount} Â· {r.occurredOn}</p><p className="break-words">{r.category} Â· {r.description}</p><p className="break-words text-muted">Recorded by {r.actor.name} Â· {new Date(r.createdAt).toLocaleString()}</p>{r.reason && <p className="break-words">Reason: {r.reason}</p>}</li>)}</ol></>}
    </section></CardShell>}
    {editor && (editor === "CREATE" || value) && <ExpenseEditor key={editor === "CREATE" ? "CREATE" : `${editor}:${value?.id}:${value?.revision}`} action={editor} value={editor === "CREATE" ? undefined : value} onClose={() => setEditor(null)} onSaved={id => { setEditor(null); setSelected(id); setRefresh(v => v + 1); }} onReload={() => { setEditor(null); setRefresh(v => v + 1); }} />}
  </div>;
}
