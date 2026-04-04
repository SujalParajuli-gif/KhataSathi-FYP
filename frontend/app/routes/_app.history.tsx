import { useEffect, useMemo, useState } from "react";
import {
  InvoiceStatusChip,
  PaymentMethodChip,
} from "~/components/invoices/InvoiceChips";
import InvoiceDetailModal from "~/components/invoices/InvoiceDetailModal";
import Icon from "~/components/ui/Icon";
import { getInvoiceApi, listInvoicesApi } from "~/lib/api/endpoints";
import type { AppInvoice, InvoiceStatusLabel } from "~/lib/invoices";
import {
  formatNpr,
  getInvoiceReference,
  normalizeInvoice,
} from "~/lib/invoices";

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

export default function HistoryPage() {
  const [invoices, setInvoices] = useState<AppInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"All" | InvoiceStatusLabel>("All");
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(
    null,
  );
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
      .filter((invoice) =>
        activeTab === "All" ? true : invoice.status === activeTab,
      )
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
        (sum, invoice) =>
          sum + (invoice.status === "Cancelled" ? 0 : invoice.netTotal),
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
        (sum, invoice) =>
          sum + (invoice.status === "Cancelled" ? 0 : invoice.dueAmount),
        0,
      ),
    [filtered],
  );
  const walkInRecordCount = useMemo(
    () => filtered.filter((invoice) => !invoice.customerId).length,
    [filtered],
  );
  const esewaRecordCount = useMemo(
    () => filtered.filter((invoice) => invoice.paymentMethod === "eSewa").length,
    [filtered],
  );
  const referenceRecordCount = useMemo(
    () =>
      filtered.filter((invoice) => Boolean(getInvoiceReference(invoice))).length,
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
    <div className="min-h-full rounded-[28px] bg-[#F1F1F1] p-[24px] text-[#0F172A]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold ">History</h1>
          <p className="mt-1 text-sm text-slate-500">
            Real invoice records with payment totals, status, method, and
            reference data.
          </p>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-7">
        <div className="rounded-2xl border border-[#CFCFD3] bg-[#FFFFFF] p-5">
          <div className="text-[11px] font-extrabold uppercase  text-[#8C8889]">
            Net Total
          </div>
          <div className="mt-1 text-2xl font-extrabold text-[#000000]">
            {formatNpr(totalSales)}
          </div>
        </div>

        <div className="rounded-2xl border border-[#CFCFD3] bg-[#FFFFFF] p-5">
          <div className="text-[11px] font-extrabold uppercase  text-[#179B4D]">
            Paid
          </div>
          <div className="mt-1 text-2xl font-extrabold text-[#179B4D]">
            {formatNpr(totalPaid)}
          </div>
        </div>

        <div className="rounded-2xl border border-[#CFCFD3] bg-[#FFFFFF] p-5">
          <div className="text-[11px] font-extrabold uppercase  text-rose-700">
            Due
          </div>
          <div className="mt-1 text-2xl font-extrabold text-rose-700">
            {formatNpr(totalDue)}
          </div>
        </div>

        <div className="rounded-2xl border border-[#CFCFD3] bg-[#FFFFFF] p-5">
          <div className="text-[11px] font-extrabold uppercase  text-[#8C8889]">
            Records
          </div>
          <div className="mt-1 text-2xl font-extrabold text-[#000000]">
            {filtered.length}
          </div>
        </div>

        <div className="rounded-2xl border border-[#CFCFD3] bg-[#FFFFFF] p-5">
          <div className="text-[11px] font-extrabold uppercase  text-[#8C8889]">
            Walk-in Records
          </div>
          <div className="mt-1 text-2xl font-extrabold text-[#000000]">
            {walkInRecordCount}
          </div>
        </div>

        <div className="rounded-2xl border border-[#CFCFD3] bg-[#FFFFFF] p-5">
          <div className="text-[11px] font-extrabold uppercase  text-[#179B4D]">
            eSewa Records
          </div>
          <div className="mt-1 text-2xl font-extrabold text-[#000000]">
            {esewaRecordCount}
          </div>
        </div>

        <div className="rounded-2xl border border-[#CFCFD3] bg-[#FFFFFF] p-5">
          <div className="text-[11px] font-extrabold uppercase  text-[#8C8889]">
            Reference IDs
          </div>
          <div className="mt-1 text-2xl font-extrabold text-[#000000]">
            {referenceRecordCount}
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          {(["All", "Paid", "Partial", "Unpaid", "Cancelled"] as const).map(
            (tab) => {
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
                      : "border-[#CFCFD3] bg-[#FFFFFF] text-[#565449] hover:bg-[#F3F4F6]",
                  )}
                >
                  {tab}
                </button>
              );
            },
          )}
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
            className="h-[46px] w-full rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] pl-[48px] pr-[16px] text-[14px] font-semibold text-[#000000] outline-none focus:border-[#11120D]"
          />
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-[20px] border border-[#CFCFD3] bg-[#FFFFFF] ">
        <div className="overflow-x-auto">
          <table className="min-w-[1200px] w-full">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-[11px] font-extrabold uppercase  text-slate-500">
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
                      <div className="mt-1 text-[12px] text-slate-500">
                        {invoice.itemSummary}
                      </div>
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
                      <div>
                        <PaymentMethodChip method={invoice.paymentMethod} />
                      </div>
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

                    <td className="px-5 py-4">
                      <div className="space-y-1">
                        <InvoiceStatusChip status={invoice.status} />
                        {invoice.status === "Cancelled" &&
                        invoice.cancelledByName ? (
                          <div className="text-[11px] font-semibold text-slate-500">
                            Cancelled by {invoice.cancelledByName}
                            {invoice.cancelledByRole
                              ? ` (${invoice.cancelledByRole})`
                              : ""}
                          </div>
                        ) : null}
                      </div>
                    </td>

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
