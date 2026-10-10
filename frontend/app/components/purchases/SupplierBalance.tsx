import { useEffect, useState } from "react";
import { supplierBalance, purchaseError, type SupplierBalance as Balance } from "~/lib/api/purchases";

export default function SupplierBalance({ supplierId, refresh, onReceipts }: {
  supplierId: string; refresh: number; onReceipts: () => void;
}) {
  const [result, setResult] = useState<{ refresh: number; retry: number; balance?: Balance; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    setResult(null);
    supplierBalance(supplierId, c.signal).then(balance => {
      if (!c.signal.aborted) setResult({ refresh, retry, balance });
    }).catch(error => {
      if (!c.signal.aborted) setResult({ refresh, retry, error: purchaseError(error) });
    });
    return () => c.abort();
  }, [supplierId, refresh, retry]);
  const current = result?.refresh === refresh && result?.retry === retry ? result : null;
  const balance = current?.balance;
  return <section aria-label="Supplier balance" className="mt-4 space-y-3 rounded-[20px] border border-line bg-inset p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="font-semibold">Recorded supplier balance</h3>
      <button type="button" className="min-h-10 rounded-xl border border-line bg-surface px-3 text-sm" onClick={onReceipts}>View source receipts</button>
    </div>
    <p className="text-sm text-muted">All posted receipts linked to this supplier, less recorded installments that have not been voided. Opening balances and unlinked historical receipts are not established here.</p>
    {!current && <p role="status" className="text-sm">Loading supplier balance…</p>}
    {current?.error && <div><p role="alert" className="text-sm">{current.error}</p><button type="button" className="mt-2 min-h-10 rounded-xl border border-line bg-surface px-3 text-sm" onClick={() => setRetry(v => v + 1)}>Retry balance</button></div>}
    {balance && <>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3 text-sm">
        {([['Known payable', balance.payable], ['Recorded paid', balance.paid], ['Known due', balance.due]] as const).map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-muted">{label}</dt><dd className="break-words font-mono font-semibold">NPR {value}</dd></div>)}
      </dl>
      <p className="text-sm">{balance.postedReceiptCount} posted {balance.postedReceiptCount === 1 ? 'receipt' : 'receipts'} with known payable.{!balance.supplier.isActive && ' Supplier is inactive; historical receipts remain available.'}</p>
      {balance.recordedBalance === null && <p role="status" className="text-sm">Recorded balance is unknown: {balance.unknownReceiptCount} linked {balance.unknownReceiptCount === 1 ? 'receipt has' : 'receipts have'} unknown payable or posting status. Known due above is a subtotal.</p>}
      {!balance.postedReceiptCount && !balance.unknownReceiptCount && <p className="text-sm text-muted">No linked receipts recorded. These zero subtotals do not establish historical debt.</p>}
    </>}
  </section>;
}
