import { useEffect, useMemo, useState } from "react";
import InvoiceDetailModal from "~/components/invoices/InvoiceDetailModal";
import Icon from "~/components/ui/Icon";
import { getInvoiceApi, listInvoicesApi } from "~/lib/api/endpoints";
import type { AppInvoice, InvoiceStatusLabel, PaymentMethodLabel } from "~/lib/invoices";
import {
  formatNpr,
  getInvoiceReference,
  normalizeInvoice,
} from "~/lib/invoices";

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function statusPill(status: InvoiceStatusLabel) {
  const styles: Record<InvoiceStatusLabel, string> = {
    Paid: "bg-emerald-50 text-emerald-700 border-emerald-200",
    Partial: "bg-amber-50 text-amber-800 border-amber-200",
    Unpaid: "bg-rose-50 text-rose-700 border-rose-200",
    Cancelled: "bg-slate-100 text-slate-600 border-slate-200",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-extrabold",
        styles[status],
      )}
    >
      {status.toUpperCase()}
    </span>
  );
}

function methodChip(method: PaymentMethodLabel) {
  const styles: Record<PaymentMethodLabel, string> = {
    Cash: "bg-white text-slate-700 border-slate-200",
    eSewa: "bg-emerald-50 text-emerald-800 border-emerald-200",
    Khalti: "bg-indigo-50 text-indigo-700 border-indigo-200",
    None: "bg-slate-50 text-slate-500 border-slate-200",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[10px] border px-2 py-1 text-[11px] font-bold",
        styles[method],
      )}
    >
      {method === "None" ? "No Payment" : method}
    </span>
  );
}

export default function HistoryPage() {
  const [invoices, setInvoices] = useState<AppInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"All" | InvoiceStatusLabel>("All");
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);
  const [detailInvoice, setDetailInvoice] = useState<AppInvoice | null>(null);

  async function loadInvoices() {
    const data = await listInvoicesApi({ pageSize: 100 });
    const rows = Array.isArray(data?.invoices) ? data.invoices : [];
    setInvoices(rows.map(normalizeInvoice));
  }

  async function hydrateInvoice(id: string) {
    const data = await getInvoiceApi(id);
    return normalizeInvoice(data);
  }

  useEffect(() => {
    async function load() {
      try {
        await loadInvoices();
      } catch {
        setInvoices([]);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  const filtered = useMemo(() => {
    const loweredQuery = query.trim().toLowerCase();
    return invoices
      .filter((invoice) => (activeTab === "All" ? true : invoice.status === activeTab))
      .filter((invoice) => {
        if (!loweredQuery) return true;

        return [
          invoice.invoiceNo,
          invoice.customerName,
          invoice.cashierName,
          invoice.itemSummary,
          getInvoiceReference(invoice),
        ]
          .join(" ")
          .toLowerCase()
          .includes(loweredQuery);
      });
  }, [activeTab, invoices, query]);

  const totalSales = useMemo(
    () =>
      filtered.reduce(
        (sum, invoice) => sum + (invoice.status === "Cancelled" ? 0 : invoice.netTotal),
        0,
      ),
    [filtered],
  );
  const totalPaid = useMemo(
    () => filtered.reduce((sum, invoice) => sum + invoice.paidAmount, 0),
    [filtered],
  );
  const totalDue = useMemo(
    () =>
      filtered.reduce(
        (sum, invoice) => sum + (invoice.status === "Cancelled" ? 0 : invoice.dueAmount),
        0,
      ),
    [filtered],
  );

  async function openInvoice(id: string) {
    const cached = invoices.find((invoice) => invoice.id === id) || null;
    setSelectedInvoiceId(id);
    setDetailInvoice(cached);
    try {
      setDetailInvoice(await hydrateInvoice(id));
    } catch {
      setDetailInvoice(cached);
    }
  }

  function closeInvoice() {
    setSelectedInvoiceId(null);
    setDetailInvoice(null);
  }

  if (loading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <div className="font-semibold text-slate-400">Loading history...</div>
      </div>
    );
  }

  return (
    <div className="min-h-full rounded-[28px] bg-[var(--app-page-bg)] p-6 text-slate-900">
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-4">
          <h1 className="text-2xl font-extrabold tracking-tight">History</h1>
          <p className="mt-1 text-sm text-slate-500">
            Real invoice records with payment totals, status, method, and reference data.
          </p>
        </div>

        <div className="col-span-12 rounded-[18px] border-2 border-slate-200 bg-white p-4 shadow-sm sm:col-span-4 lg:col-span-2">
          <div className="text-[11px] font-extrabold uppercase tracking-wider text-slate-500">
            Net Total
          </div>
          <div className="mt-2 text-[22px] font-extrabold text-slate-900">
            {formatNpr(totalSales)}
          </div>
        </div>

        <div className="col-span-12 rounded-[18px] border-2 border-slate-200 bg-white p-4 shadow-sm sm:col-span-4 lg:col-span-2">
          <div className="text-[11px] font-extrabold uppercase tracking-wider text-slate-500">
            Paid
          </div>
          <div className="mt-2 text-[22px] font-extrabold text-emerald-700">
            {formatNpr(totalPaid)}
          </div>
        </div>

        <div className="col-span-12 rounded-[18px] border-2 border-slate-200 bg-white p-4 shadow-sm sm:col-span-4 lg:col-span-2">
          <div className="text-[11px] font-extrabold uppercase tracking-wider text-slate-500">
            Due
          </div>
          <div className="mt-2 text-[22px] font-extrabold text-rose-700">
            {formatNpr(totalDue)}
          </div>
        </div>

        <div className="col-span-12 rounded-[18px] border-2 border-slate-200 bg-white p-4 shadow-sm lg:col-span-2">
          <div className="text-[11px] font-extrabold uppercase tracking-wider text-slate-500">
            Records
          </div>
          <div className="mt-2 text-[22px] font-extrabold text-slate-900">
            {filtered.length}
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          {(["All", "Paid", "Partial", "Unpaid", "Cancelled"] as const).map((tab) => {
            const active = tab === activeTab;
            return (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={cn(
                  "rounded-full border-2 px-4 py-2 text-[12px] font-extrabold transition",
                  active
                    ? "border-[#11120d] bg-[#11120d] text-white"
                    : "border-[var(--app-border)] bg-white text-[var(--app-text-soft)] hover:bg-[var(--app-surface-muted)]",
                )}
              >
                {tab}
              </button>
            );
          })}
        </div>

        <div className="relative w-full xl:w-[360px]">
          <Icon
            name="search"
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search invoice, customer, cashier, reference..."
            className="h-[46px] w-full rounded-[14px] border border-[var(--app-border)] bg-white pl-12 pr-4 text-[14px] font-semibold text-[var(--app-text)] outline-none focus:border-[#11120d]"
          />
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-[20px] border border-[var(--app-border)] bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-[1200px] w-full">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-[11px] font-extrabold uppercase tracking-wider text-slate-500">
                <th className="px-5 py-3">Invoice</th>
                <th className="px-5 py-3">Customer</th>
                <th className="px-5 py-3">Date</th>
                <th className="px-5 py-3">Method</th>
                <th className="px-5 py-3">Reference</th>
                <th className="px-5 py-3 text-right">Total</th>
                <th className="px-5 py-3 text-right">Paid</th>
                <th className="px-5 py-3 text-right">Due</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>

            <tbody>
              {filtered.map((invoice) => {
                const reference = getInvoiceReference(invoice);

                return (
                  <tr
                    key={invoice.id}
                    className="border-b border-slate-100 align-top last:border-0 hover:bg-slate-50/70"
                  >
                    <td className="px-5 py-4">
                      <div className="font-mono text-[13px] font-extrabold text-slate-900">
                        {invoice.invoiceNo}
                      </div>
                      <div className="mt-1 text-[12px] text-slate-500">{invoice.itemSummary}</div>
                    </td>

                    <td className="px-5 py-4">
                      <div className="text-[13px] font-extrabold text-slate-900">
                        {invoice.customerName}
                      </div>
                      <div className="mt-1 text-[12px] text-slate-500">
                        {invoice.customerSubtitle}
                      </div>
                    </td>

                    <td className="px-5 py-4">
                      <div className="text-[13px] font-semibold text-slate-900">
                        {invoice.createdDateLabel}
                      </div>
                      <div className="mt-1 text-[12px] text-slate-500">
                        {invoice.createdTimeLabel}
                      </div>
                    </td>

                    <td className="px-5 py-4">
                      <div>{methodChip(invoice.paymentMethod)}</div>
                      <div className="mt-1 text-[12px] text-slate-500">
                        Cashier: {invoice.cashierName}
                      </div>
                    </td>

                    <td className="px-5 py-4 text-[13px] font-semibold text-slate-700">
                      {reference || "-"}
                    </td>

                    <td className="px-5 py-4 text-right font-mono text-[13px] font-extrabold text-slate-900">
                      {formatNpr(invoice.netTotal)}
                    </td>

                    <td className="px-5 py-4 text-right font-mono text-[13px] font-extrabold text-slate-900">
                      {formatNpr(invoice.paidAmount)}
                    </td>

                    <td className="px-5 py-4 text-right font-mono text-[13px] font-extrabold text-slate-900">
                      {formatNpr(invoice.dueAmount)}
                    </td>

                    <td className="px-5 py-4">{statusPill(invoice.status)}</td>

                    <td className="px-5 py-4">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => openInvoice(invoice.id)}
                          className="flex h-10 w-10 items-center justify-center rounded-[12px] border-2 border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                          aria-label="View invoice"
                        >
                          <Icon name="visibility" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-5 py-16 text-center">
                    <div className="flex flex-col items-center justify-center text-slate-400">
                      <Icon name="search_off" className="text-[36px]" />
                      <div className="mt-3 text-[14px] font-semibold">
                        No invoice history found for the selected filters.
                      </div>
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <InvoiceDetailModal
        open={!!selectedInvoiceId}
        invoice={detailInvoice}
        onClose={closeInvoice}
      />
    </div>
  );
}
