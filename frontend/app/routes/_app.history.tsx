import React, { useEffect, useMemo, useState } from "react";
import Icon from "~/components/ui/Icon";
import { listInvoicesApi, getInvoiceApi } from "~/lib/api/endpoints";

type InvoiceStatus = "Paid" | "Partial" | "Unpaid" | "Voided";
type PaymentMethod = "Cash" | "eSewa" | "Khalti";

export type Invoice = {
  id: string;
  invoiceNo: string;
  customer: string;
  cashier: string;
  date: string;
  dateLabel: string;
  timeLabel: string;
  total: number;
  netTotal: number;
  discount: number;
  paidAmount: number;
  dueAmount: number;
  status: InvoiceStatus;
  paymentMethod: string;
  itemsCount: number;
};

export type InvoiceItem = {
  name: string;
  qty: number;
  price: number;
};

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function formatNpr(n: number) {
  return `Rs ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function mapStatus(raw: string): InvoiceStatus {
  const upper = (raw || "").toUpperCase();
  if (upper === "PAID") return "Paid";
  if (upper === "PARTIAL" || upper === "PARTIALLY_PAID") return "Partial";
  if (upper === "CANCELLED" || upper === "CANCELED") return "Voided";
  return "Unpaid";
}

function mapPaymentMethod(payments: any[]): PaymentMethod {
  if (!payments || payments.length === 0) return "—" as PaymentMethod;
  const m = (payments[0].method || "").toUpperCase();
  if (m === "ESEWA") return "eSewa";
  if (m === "KHALTI") return "Khalti";
  if (m === "CASH") return "Cash";
  return "—" as PaymentMethod;
}

function Card({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl bg-white border border-slate-200/60 shadow-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}

function Badge({ status }: { status: InvoiceStatus }) {
  const styles = {
    Paid: "bg-emerald-50 text-emerald-700 border-emerald-100",
    Partial: "bg-amber-50 text-amber-700 border-amber-100",
    Unpaid: "bg-rose-50 text-rose-700 border-rose-100",
    Voided:
      "bg-slate-100 text-slate-600 border-slate-200 decoration-slate-400 line-through",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold border",
        styles[status],
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          status === "Voided" ? "bg-slate-400" : "bg-current",
        )}
      />
      {status}
    </span>
  );
}

function Avatar({ name }: { name: string }) {
  const initial = name.charAt(0).toUpperCase();
  const colors = [
    "bg-red-100 text-red-700",
    "bg-orange-100 text-orange-700",
    "bg-emerald-100 text-emerald-700",
    "bg-blue-100 text-blue-700",
    "bg-purple-100 text-purple-700",
    "bg-pink-100 text-pink-700",
  ];
  const colorClass = colors[name.length % colors.length];

  return (
    <div
      className={cn(
        "h-8 w-8 rounded-full flex items-center justify-center text-[12px] font-bold",
        colorClass,
      )}
    >
      {initial}
    </div>
  );
}

export default function HistoryPage() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const data = await listInvoicesApi({ pageSize: 100 });
        const raw = data.invoices || [];
        setInvoices(
          raw.map((inv: any) => {
            const createdAt = new Date(inv.createdAt);
            const now = new Date();
            const diffDays = Math.floor(
              (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24),
            );
            let dateLabel = createdAt.toLocaleDateString(undefined, {
              month: "short",
              day: "2-digit",
            });
            if (diffDays === 0) dateLabel = "Today";
            else if (diffDays === 1) dateLabel = "Yesterday";

            return {
              id: inv.id,
              invoiceNo: inv.invoiceNo || inv.id,
              customer: inv.customer?.name || "Walk-in",
              cashier: inv.cashier?.name || inv.user?.name || "—",
              dateLabel,
              timeLabel: createdAt.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              }),
              total: inv.netTotal || inv.subTotal || 0,
              netTotal: inv.netTotal || inv.subTotal || 0,
              discount: inv.loyaltyDiscountAmount || inv.discount || 0,
              paidAmount: inv.paidAmount || inv.paidTotal || 0,
              dueAmount: inv.dueAmount || Math.max(0, (inv.netTotal || inv.subTotal || 0) - (inv.paidAmount || inv.paidTotal || 0)),
              status: mapStatus(inv.paymentStatus || inv.status),
              paymentMethod: mapPaymentMethod(inv.payments),
              itemsCount: inv._count?.items || (inv.items || []).length,
            };
          }),
        );
      } catch {
        // silently fail
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const [q, setQ] = useState("");
  const [activeTab, setActiveTab] = useState<"all" | InvoiceStatus>("all");
  const [openView, setOpenView] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [invoiceItems, setInvoiceItems] = useState<InvoiceItem[]>([]);

  const filtered = useMemo(() => {
    return invoices.filter((i) => {
      const matchSearch =
        i.customer.toLowerCase().includes(q.toLowerCase()) ||
        i.invoiceNo.toLowerCase().includes(q.toLowerCase());
      const matchTab = activeTab === "all" || i.status === activeTab;
      return matchSearch && matchTab;
    });
  }, [invoices, q, activeTab]);

  const activeInvoice = invoices.find((x) => x.id === activeId);

  const totalSales = useMemo(
    () => invoices.reduce((a, i) => a + (i.status !== "Voided" ? i.netTotal : 0), 0),
    [invoices],
  );
  const unpaidTotal = useMemo(
    () =>
      invoices
        .filter((i) => i.status === "Unpaid")
        .reduce((a, i) => a + (i.netTotal || 0), 0),
    [invoices],
  );

  async function openInvoiceDetail(id: string) {
    setActiveId(id);
    setOpenView(true);
    try {
      const data = await getInvoiceApi(id);
      const items = (data.items || []).map((it: any) => ({
        name: it.product?.name || "Unknown",
        qty: it.qty || 0,
        price: it.appliedUnitPrice || 0,
      }));
      setInvoiceItems(items);
    } catch {
      setInvoiceItems([]);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-slate-400 font-semibold">Loading history...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50/50 p-6 space-y-6 font-sans text-slate-900">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="md:col-span-1 space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            History
          </h1>
          <p className="text-sm text-slate-500">Manage transaction records.</p>
        </div>
        <Card className="p-4 flex flex-col justify-center">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Total Sales
          </span>
          <div className="text-xl font-bold text-slate-900 mt-1">
            {formatNpr(totalSales)}
          </div>
        </Card>
        <Card className="p-4 flex flex-col justify-center">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Transactions
          </span>
          <div className="text-xl font-bold text-slate-900 mt-1">
            {invoices.length}
          </div>
        </Card>
        <Card className="p-4 flex flex-col justify-center">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Unpaid
          </span>
          <div className="text-xl font-bold text-rose-600 mt-1">
            {formatNpr(unpaidTotal)}
          </div>
        </Card>
      </div>

      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-1 bg-white border border-slate-200 rounded-lg">
          {["all", "Paid", "Unpaid", "Voided"].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab as any)}
              className={cn(
                "px-4 py-1.5 text-[13px] font-medium rounded-md transition-all",
                activeTab === tab
                  ? "bg-slate-100 text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-700 hover:bg-slate-50",
              )}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-72 group">
          <Icon
            name="search"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-blue-500 transition-colors"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search invoice or customer..."
            className="w-full h-10 pl-10 pr-4 bg-white border border-slate-200 rounded-lg text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all shadow-sm"
          />
        </div>
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50/80 border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                <th className="pl-6 pr-4 py-3 w-[140px]">Invoice</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((invoice) => (
                <tr
                  key={invoice.id}
                  className="group hover:bg-slate-50/60 transition-colors"
                >
                  <td className="pl-6 pr-4 py-3 align-top">
                    <div className="flex flex-col">
                      <span className="font-mono text-[13px] font-medium text-slate-900 group-hover:text-blue-600 transition-colors">
                        #{invoice.invoiceNo}
                      </span>
                      <span className="text-[11px] text-slate-500 mt-0.5">
                        {invoice.itemsCount} items
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <div className="flex items-center gap-3">
                      <Avatar name={invoice.customer} />
                      <div className="flex flex-col">
                        <span className="text-[13px] font-semibold text-slate-700">
                          {invoice.customer}
                        </span>
                        <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                          <span>via {invoice.paymentMethod}</span>
                          <span>•</span>
                          <span>Cashier: {invoice.cashier}</span>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <div className="flex flex-col">
                      <span className="text-[13px] text-slate-700">
                        {invoice.dateLabel}
                      </span>
                      <span className="text-[11px] text-slate-400">
                        {invoice.timeLabel}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top text-right">
                    <div className="flex flex-col items-end">
                      <span className="text-[13px] font-bold text-slate-900">
                        {formatNpr(invoice.netTotal)}
                      </span>
                      {invoice.discount > 0 && (
                        <span className="text-[10px] text-emerald-600 bg-emerald-50 px-1.5 rounded">
                          -{formatNpr(invoice.discount)}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top text-center">
                    <Badge status={invoice.status} />
                  </td>
                  <td className="px-4 py-3 align-middle text-right">
                    <button
                      onClick={() => openInvoiceDetail(invoice.id)}
                      className="p-2 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-all"
                    >
                      <Icon name="visibility" />
                    </button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-400">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <div className="h-10 w-10 rounded-full bg-slate-100 flex items-center justify-center">
                        <Icon name="search_off" />
                      </div>
                      <p className="text-sm">
                        No invoices found matching your filters.
                      </p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
          <span>Showing {filtered.length} records</span>
        </div>
      </Card>

      {openView && activeInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-slate-900/20 backdrop-blur-sm"
            onClick={() => setOpenView(false)}
          />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <div>
                <h3 className="text-lg font-bold text-slate-900">
                  Invoice Details
                </h3>
                <p className="text-xs text-slate-500">
                  Transaction ID: {activeInvoice.id}
                </p>
              </div>
              <button
                onClick={() => setOpenView(false)}
                className="p-2 hover:bg-slate-50 rounded-lg text-slate-500"
              >
                <Icon name="close" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              <div className="grid grid-cols-2 gap-6 p-4 bg-slate-50 rounded-xl border border-slate-100">
                <div>
                  <span className="text-xs font-semibold text-slate-400 uppercase">
                    Customer
                  </span>
                  <div className="font-semibold text-slate-900 mt-1">
                    {activeInvoice.customer}
                  </div>
                  <div className="text-xs text-slate-500">
                    Method: {activeInvoice.paymentMethod}
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-xs font-semibold text-slate-400 uppercase">
                    Invoice No
                  </span>
                  <div className="font-mono font-semibold text-slate-900 mt-1">
                    #{activeInvoice.invoiceNo}
                  </div>
                  <div className="text-xs text-slate-500">
                    {activeInvoice.dateLabel}, {activeInvoice.timeLabel}
                  </div>
                </div>
              </div>
              <div>
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr className="text-slate-500 border-b border-slate-100">
                      <th className="py-2 font-medium">Item</th>
                      <th className="py-2 font-medium text-center">Qty</th>
                      <th className="py-2 font-medium text-right">Price</th>
                      <th className="py-2 font-medium text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {invoiceItems.map((item, i) => (
                      <tr key={i}>
                        <td className="py-3 text-slate-700">{item.name}</td>
                        <td className="py-3 text-center text-slate-500">
                          {item.qty}
                        </td>
                        <td className="py-3 text-right text-slate-500">
                          {item.price}
                        </td>
                        <td className="py-3 text-right font-medium text-slate-900">
                          {item.price * item.qty}
                        </td>
                      </tr>
                    ))}
                    {invoiceItems.length === 0 && (
                      <tr>
                        <td
                          colSpan={4}
                          className="py-6 text-center text-slate-400"
                        >
                          Loading items...
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-end">
                <div className="w-48 space-y-2">
                  <div className="flex justify-between text-sm text-slate-500">
                    <span>Subtotal</span>
                    <span>
                      {formatNpr(activeInvoice.netTotal + activeInvoice.discount)}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm text-emerald-600">
                    <span>Discount</span>
                    <span>-{formatNpr(activeInvoice.discount)}</span>
                  </div>
                  <div className="pt-2 border-t border-slate-100 flex justify-between text-base font-bold text-slate-900">
                    <span>Total</span>
                    <span>{formatNpr(activeInvoice.netTotal)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-slate-500">
                    <span>Paid</span>
                    <span>{formatNpr(activeInvoice.paidAmount)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-rose-600">
                    <span>Due</span>
                    <span>{formatNpr(activeInvoice.dueAmount)}</span>
                  </div>
                </div>
              </div>
            </div>
            <div className="p-4 border-t border-slate-100 bg-slate-50/50 flex justify-end gap-3">
              <button
                onClick={() => window.print()}
                className="px-4 py-2 rounded-lg border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50 shadow-sm"
              >
                Print Receipt
              </button>
              <button
                onClick={() => window.print()}
                className="px-4 py-2 rounded-lg bg-slate-900 text-sm font-semibold text-white hover:bg-slate-800 shadow-sm"
              >
                Download PDF
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
