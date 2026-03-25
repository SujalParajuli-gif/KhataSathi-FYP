import React, { useEffect, useMemo, useState } from "react";
import Icon from "~/components/ui/Icon";
import { listInvoicesApi, getInvoiceApi } from "~/lib/api/endpoints";

type InvoiceStatus = "Paid" | "Partial" | "Unpaid" | "Cancelled";
type PaymentMethod = "Cash" | "eSewa" | "None";

type InvoiceItem = {
  name: string;
  qty: number;
  unitPrice: number;
  appliedUnitPrice: number;
};

type Invoice = {
  id: string;
  invoiceNo: string;
  createdAtLabel: string;
  customerName: string;
  customerLabel: string;
  cashierName: string;
  status: InvoiceStatus;
  method: PaymentMethod;
  items: InvoiceItem[];
  subtotal: number;
  discount: number;
  total: number;
  netTotal: number;
  paidAmount: number;
  dueAmount: number;
};

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function formatNpr(n: number) {
  const s = Math.round(n).toString();
  const withComma = s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `NPR ${withComma}`;
}

function mapStatus(raw: string): InvoiceStatus {
  const upper = (raw || "").toUpperCase();
  if (upper === "PAID") return "Paid";
  if (upper === "PARTIAL" || upper === "PARTIALLY_PAID") return "Partial";
  if (upper === "CANCELLED" || upper === "CANCELED") return "Cancelled";
  return "Unpaid";
}

function mapMethod(payments: any[]): PaymentMethod {
  if (!payments || payments.length === 0) return "None";
  const first = payments[0];
  const m = (first.method || "").toUpperCase();
  if (m === "ESEWA") return "eSewa";
  if (m === "CASH") return "Cash";
  return "Cash";
}

function normalizeInvoice(raw: any): Invoice {
  const items: InvoiceItem[] = (raw.items || []).map((it: any) => ({
    name: it.product?.name || it.name || "Unknown",
    qty: it.qty || 0,
    unitPrice: it.appliedUnitPrice || it.unitPrice || 0,
  }));

  const subtotal = raw.subTotal || items.reduce((acc, it) => acc + it.qty * it.unitPrice, 0);
  const discount = raw.loyaltyDiscountAmount || raw.discount || 0;
  const createdAt = new Date(raw.createdAt);

  return {
    id: raw.id,
    invoiceNo: raw.invoiceNo || raw.id,
    createdAtLabel: createdAt.toLocaleDateString(),
    customerName: raw.customer?.name || "Walk-in",
    customerLabel: raw.customer?.phone || "General Customer",
    cashierName: raw.cashier?.name || "—",
    status: mapStatus(raw.paymentStatus || raw.status),
    method: mapMethod(raw.payments),
    items,
    subtotal: raw.subTotal || 0,
    discount: raw.loyaltyDiscountAmount || 0,
    total: raw.netTotal || raw.subTotal || 0,
    netTotal: raw.netTotal || raw.subTotal || 0,
    paidAmount: raw.paidAmount || raw.paidTotal || 0,
    dueAmount: raw.dueAmount || Math.max(0, (raw.netTotal || raw.total || 0) - (raw.paidAmount || raw.paidTotal || 0)),
  };
}

function statusPill(status: InvoiceStatus) {
  const map: Record<InvoiceStatus, { label: string; cls: string }> = {
    Paid: {
      label: "PAID",
      cls: "bg-emerald-50 text-emerald-700 border-emerald-200",
    },
    Partial: {
      label: "PARTIAL",
      cls: "bg-amber-50 text-amber-800 border-amber-200",
    },
    Unpaid: {
      label: "UNPAID",
      cls: "bg-rose-50 text-rose-700 border-rose-200",
    },
    Cancelled: {
      label: "CANCELLED",
      cls: "bg-slate-100 text-slate-600 border-slate-200",
    },
  };

  return (
    <span
      className={cn(
        "px-[10px] py-[4px] rounded-[999px] text-[11px] font-extrabold border",
        map[status].cls,
      )}
    >
      {map[status].label}
    </span>
  );
}

function methodChip(method: PaymentMethod) {
  const base =
    "inline-flex items-center gap-1.5 px-[8px] py-[4px] rounded-[10px] text-[11px] font-bold border";
  if (method === "Cash") {
    return (
      <span className={cn(base, "bg-white text-slate-700 border-slate-200")}>
        <Icon name="payments" className="text-[14px]" />
        Cash
      </span>
    );
  }
  if (method === "eSewa") {
    return (
      <span
        className={cn(
          base,
          "bg-emerald-50 text-emerald-800 border-emerald-200",
        )}
      >
        <Icon name="qr_code_2" className="text-[14px]" />
        eSewa
      </span>
    );
  }
  return (
    <span className={cn(base, "bg-slate-50 text-slate-500 border-slate-200")}>
      <Icon name="block" className="text-[14px]" />
      No Payment
    </span>
  );
}

function calcSummary(invoices: Invoice[]) {
  const generated = invoices.length;
  const paid = invoices.filter((x) => x.status === "Paid").length;
  const partial = invoices.filter((x) => x.status === "Partial").length;
  const unpaid = invoices.filter((x) => x.status === "Unpaid").length;
  const totalSales = invoices.reduce(
    (a, x) => a + (x.status !== "Cancelled" ? x.netTotal : 0),
    0,
  );
  return { generated, paid, partial, unpaid, totalSales };
}

function clampPage(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function InvoiceModal({
  open,
  onClose,
  invoice,
}: {
  open: boolean;
  onClose: () => void;
  invoice: Invoice | null;
}) {
  if (!open || !invoice) return null;

  return (
    <div className="fixed inset-0 z-[60]">
      <button
        type="button"
        className="absolute inset-0 bg-black/30"
        onClick={onClose}
        aria-label="Close"
      />
      <div className="absolute left-1/2 top-1/2 w-[920px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-[20px] border-2 border-slate-200 bg-white shadow-2xl overflow-hidden">
        <div className="p-5 border-b-2 border-slate-100 flex items-start justify-between gap-3">
          <div>
            <div className="text-[12px] text-slate-500 font-bold">Invoice</div>
            <div className="text-[18px] font-extrabold text-slate-900">
              {invoice.invoiceNo} • {invoice.customerName}
            </div>
            <div className="text-[12px] text-slate-500 mt-1">
              Cashier: <span className="font-bold">{invoice.cashierName}</span>{" "}
              • <span className="font-bold">{invoice.createdAtLabel}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {statusPill(invoice.status)}
            <button
              type="button"
              onClick={onClose}
              className="w-[38px] h-[38px] rounded-[12px] border-2 border-slate-200 bg-white hover:bg-slate-50 flex items-center justify-center"
              aria-label="Close"
            >
              <Icon name="close" />
            </button>
          </div>
        </div>

        <div className="p-5 grid grid-cols-12 gap-5">
          <div className="col-span-7">
            <div className="rounded-[16px] border-2 border-slate-200 overflow-hidden">
              <div className="px-4 py-3 bg-slate-50 border-b-2 border-slate-200 flex items-center justify-between">
                <div className="text-[12px] font-extrabold text-slate-700 uppercase tracking-wider">
                  Items
                </div>
                <div className="text-[12px] text-slate-500 font-bold">
                  {invoice.items.length} line(s)
                </div>
              </div>
              <div className="p-2">
                {invoice.items.map((it, idx) => (
                  <div
                    key={`${it.name}-${idx}`}
                    className="px-3 py-2 rounded-[12px] hover:bg-slate-50 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="font-bold text-slate-900 truncate">
                        {it.name}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {formatNpr(it.appliedUnitPrice)} / unit
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <div className="text-[12px] font-extrabold text-slate-700 bg-slate-100 border border-slate-200 px-2 py-1 rounded-[10px]">
                        x{it.qty}
                      </div>
                      <div className="font-mono font-extrabold text-slate-900">
                        {formatNpr(it.qty * it.unitPrice)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 rounded-[16px] border-2 border-slate-200 p-4 bg-white">
              <div className="flex items-center justify-between text-[13px]">
                <span className="text-slate-500 font-bold">Payment</span>
                <span className="text-slate-700 font-extrabold">
                  {methodChip(invoice.method)}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-3 text-[12px]">
                <div className="rounded-[14px] border border-slate-200 bg-slate-50 p-3">
                  <div className="text-slate-500 font-bold">Paid</div>
                  <div className="font-mono font-extrabold text-slate-900 mt-1">
                    {formatNpr(invoice.paidAmount)}
                  </div>
                </div>
                <div className="rounded-[14px] border border-slate-200 bg-slate-50 p-3">
                  <div className="text-slate-500 font-bold">Due</div>
                  <div className="font-mono font-extrabold text-slate-900 mt-1">
                    {formatNpr(invoice.dueAmount)}
                  </div>
                </div>
                <div className="rounded-[14px] border border-slate-200 bg-slate-50 p-3">
                  <div className="text-slate-500 font-bold">Status</div>
                  <div className="mt-1">{statusPill(invoice.status)}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="col-span-5">
            <div className="rounded-[16px] border-2 border-slate-200 p-5 bg-gradient-to-br from-slate-50 to-white">
              <div className="text-[12px] font-extrabold text-slate-600 uppercase tracking-wider">
                Summary
              </div>
              <div className="mt-4 space-y-3 text-[13px]">
                <div className="flex justify-between">
                  <span className="text-slate-500 font-bold">Subtotal</span>
                  <span className="font-mono font-extrabold text-slate-900">
                    {formatNpr(invoice.subtotal)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500 font-bold">Discount</span>
                  <span className="font-mono font-extrabold text-rose-700">
                    -{formatNpr(invoice.discount)}
                  </span>
                </div>
                <div className="border-t border-dashed border-slate-300 my-2" />
                <div className="flex justify-between items-end">
                  <span className="text-slate-900 font-extrabold text-[16px]">
                    Total
                  </span>
                  <span className="font-mono font-extrabold text-[26px] text-slate-900">
                    {formatNpr(invoice.netTotal)}
                  </span>
                </div>
                <div className="mt-4 rounded-[14px] border border-slate-200 bg-white p-3">
                  <div className="text-[12px] font-bold text-slate-600">
                    Customer
                  </div>
                  <div className="font-extrabold text-slate-900 mt-1">
                    {invoice.customerName}
                  </div>
                  <div className="text-[12px] text-slate-500 mt-1">
                    {invoice.customerLabel}
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => window.print()}
                    className="h-[44px] rounded-[14px] border-2 border-slate-200 bg-white hover:bg-slate-50 font-extrabold text-slate-700 flex items-center justify-center gap-2"
                  >
                    <Icon name="print" />
                    Print
                  </button>
                  <button
                    type="button"
                    onClick={() => window.print()}
                    className="h-[44px] rounded-[14px] border-2 border-slate-200 bg-white hover:bg-slate-50 font-extrabold text-slate-700 flex items-center justify-center gap-2"
                  >
                    <Icon name="picture_as_pdf" />
                    PDF
                  </button>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="mt-3 w-full h-[46px] rounded-[14px] bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white font-extrabold border border-slate-700 hover:from-slate-800 hover:via-slate-700 hover:to-slate-800"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function CashierInvoicesPage() {
  const [activeTab, setActiveTab] = useState<
    "All" | "Paid" | "Partial" | "Unpaid" | "Cancelled"
  >("All");
  const [query, setQuery] = useState("");
  const [isFilterOpen, setFilterOpen] = useState(false);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(
    null,
  );
  const [onlyMine, setOnlyMine] = useState(false);
  const [methodFilter, setMethodFilter] = useState<"All" | PaymentMethod>(
    "All",
  );
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailInvoice, setDetailInvoice] = useState<Invoice | null>(null);

  const currentCashierName = "Cashier User";

  useEffect(() => {
    async function load() {
      try {
        const data = await listInvoicesApi({ pageSize: 100 });
        const raw = data.invoices || [];
        setInvoices(raw.map(normalizeInvoice));
      } catch {
        // silently fail
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return invoices
      .filter((x) => (activeTab === "All" ? true : x.status === activeTab))
      .filter((x) => {
        if (!q) return true;
        return (x.invoiceNo + " " + x.customerName + " " + x.cashierName)
          .toLowerCase()
          .includes(q);
      })
      .filter((x) => (onlyMine ? x.cashierName === currentCashierName : true))
      .filter((x) =>
        methodFilter === "All" ? true : x.method === methodFilter,
      );
  }, [invoices, activeTab, query, onlyMine, methodFilter, currentCashierName]);

  const summary = useMemo(() => calcSummary(filtered), [filtered]);

  const pageSize = 6;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const [page, setPage] = useState(1);
  const pageClamped = clampPage(page, 1, totalPages);

  const pageItems = useMemo(() => {
    const start = (pageClamped - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, pageClamped]);

  async function openInvoice(id: string) {
    const cached = invoices.find((x) => x.id === id);
    if (cached) {
      setDetailInvoice(cached);
      setSelectedInvoiceId(id);
    }
    try {
      const data = await getInvoiceApi(id);
      const detailed = normalizeInvoice(data);
      setDetailInvoice(detailed);
      setSelectedInvoiceId(id);
    } catch {
      // use cached
    }
  }

  function closeInvoice() {
    setSelectedInvoiceId(null);
    setDetailInvoice(null);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-slate-400 font-semibold">Loading invoices...</div>
      </div>
    );
  }

  return (
    <div className="w-full">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[22px] font-extrabold text-slate-900">
            Invoices
          </div>
          <div className="text-[12px] text-slate-500 mt-1">
            {new Date().toLocaleDateString(undefined, {
              weekday: "long",
              day: "2-digit",
              month: "long",
              year: "numeric",
            })}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-[360px] max-w-[70vw]">
            <div className="flex items-center gap-2 rounded-[14px] border-2 border-slate-200 bg-white px-[14px] py-[12px] shadow-sm">
              <Icon name="search" className="text-slate-400" />
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(1);
                }}
                placeholder="Search invoice no, customer..."
                className="w-full outline-none text-[13px] font-semibold text-slate-900 placeholder:text-slate-400 bg-transparent"
              />
            </div>
          </div>
          <button
            type="button"
            onClick={() => setFilterOpen((v) => !v)}
            className="h-[44px] px-[14px] rounded-[14px] border-2 border-slate-200 bg-white hover:bg-slate-50 font-extrabold text-slate-700 flex items-center gap-2"
          >
            <Icon name="filter_list" />
            Filter
          </button>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2 flex-wrap">
        {(["All", "Paid", "Partial", "Unpaid", "Cancelled"] as const).map(
          (t) => {
            const active = t === activeTab;
            return (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setActiveTab(t);
                  setPage(1);
                }}
                className={cn(
                  "px-[14px] py-[8px] rounded-[999px] border-2 text-[12px] font-extrabold transition",
                  active
                    ? "bg-orange-500 text-white border-orange-500 shadow-md"
                    : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50",
                )}
              >
                {t === "All" ? "All Invoices" : t}
              </button>
            );
          },
        )}
      </div>

      {isFilterOpen ? (
        <div className="mt-4 rounded-[18px] border-2 border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[12px] font-extrabold text-slate-600 uppercase tracking-wider">
              Filters
            </div>
            <button
              type="button"
              onClick={() => setFilterOpen(false)}
              className="w-[36px] h-[36px] rounded-[12px] border-2 border-slate-200 bg-white hover:bg-slate-50 flex items-center justify-center"
              aria-label="Close filters"
            >
              <Icon name="close" />
            </button>
          </div>
          <div className="mt-3 grid grid-cols-12 gap-3">
            <div className="col-span-4 rounded-[16px] border border-slate-200 bg-slate-50 p-3">
              <div className="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider">
                Cashier
              </div>
              <label className="mt-2 flex items-center gap-2 text-[13px] font-bold text-slate-700">
                <input
                  type="checkbox"
                  checked={onlyMine}
                  onChange={(e) => setOnlyMine(e.target.checked)}
                />
                Only my invoices
              </label>
            </div>
            <div className="col-span-8 rounded-[16px] border border-slate-200 bg-slate-50 p-3">
              <div className="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider">
                Payment Method
              </div>
              <div className="mt-2 flex gap-2 flex-wrap">
                {(["All", "Cash", "eSewa", "None"] as const).map((m) => {
                  const active = m === methodFilter;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMethodFilter(m)}
                      className={cn(
                        "px-[12px] py-[8px] rounded-[14px] border font-extrabold text-[12px]",
                        active
                          ? "bg-slate-900 text-white border-slate-900"
                          : "bg-white text-slate-600 border-slate-200 hover:bg-slate-100",
                      )}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="mt-5 grid grid-cols-12 gap-5">
        <div className="col-span-9">
          <div className="grid grid-cols-2 gap-4">
            {pageItems.map((inv) => {
              const moreCount = Math.max(0, inv.items.length - 3);
              return (
                <div
                  key={inv.id}
                  className="rounded-[18px] border-2 border-slate-200 bg-white shadow-sm hover:shadow-md transition overflow-hidden"
                >
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-[40px] h-[40px] rounded-[14px] bg-slate-100 border border-slate-200 flex items-center justify-center font-extrabold text-slate-700">
                          {inv.customerName
                            .split(" ")
                            .slice(0, 2)
                            .map((x) => x[0])
                            .join("")
                            .toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="font-extrabold text-slate-900 truncate">
                            {inv.customerName}
                          </div>
                          <div className="text-[12px] text-slate-500 truncate mt-0.5">
                            {inv.customerLabel}
                          </div>
                        </div>
                      </div>
                      <div className="shrink-0">{statusPill(inv.status)}</div>
                    </div>
                    <div className="mt-3 flex items-center justify-between text-[12px] text-slate-500">
                      <div className="font-bold">{inv.invoiceNo}</div>
                      <div>
                        Cashier:{" "}
                        <span className="font-bold">{inv.cashierName}</span>
                      </div>
                      <div className="font-bold">{inv.createdAtLabel}</div>
                    </div>
                    <div className="mt-3 rounded-[14px] border border-slate-200 bg-slate-50 p-3">
                      <div className="space-y-2 text-[12px] text-slate-700">
                        {inv.items.slice(0, 3).map((it, idx) => (
                          <div
                            key={idx}
                            className="flex items-center justify-between gap-3"
                          >
                            <span className="truncate font-semibold">
                              {it.name}
                            </span>
                            <span className="font-extrabold text-slate-500">
                              x{it.qty}
                            </span>
                          </div>
                        ))}
                        {moreCount > 0 ? (
                          <div className="text-[12px] text-orange-600 font-extrabold">
                            +{moreCount} more items
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-3 flex items-center justify-between">
                      <div className="text-[12px] text-slate-500 font-bold">
                        Total Amount
                      </div>
                      <div className="font-mono font-extrabold text-slate-900">
                        {formatNpr(inv.netTotal)}
                      </div>
                    </div>
                    <div className="mt-3 flex items-center justify-between">
                      <div>{methodChip(inv.method)}</div>
                      {inv.status !== "Paid" && inv.status !== "Cancelled" ? (
                        <span className="text-[11px] font-extrabold text-rose-700 bg-rose-50 border border-rose-200 px-2 py-1 rounded-[12px]">
                          Due {formatNpr(inv.dueAmount)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="p-4 pt-0 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openInvoice(inv.id)}
                      className="h-[40px] flex-1 rounded-[14px] bg-orange-500 hover:bg-orange-600 text-white font-extrabold shadow-md"
                    >
                      View Invoice
                    </button>
                    <button
                      type="button"
                      onClick={() => window.print()}
                      className="h-[40px] w-[44px] rounded-[14px] border-2 border-slate-200 bg-white hover:bg-slate-50 flex items-center justify-center"
                      aria-label="Print"
                    >
                      <Icon name="print" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {pageItems.length === 0 ? (
            <div className="h-[200px] flex items-center justify-center text-slate-400 font-semibold">
              No invoices found
            </div>
          ) : null}

          <div className="mt-5 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => clampPage(p - 1, 1, totalPages))}
              className="w-[36px] h-[36px] rounded-[10px] border-2 border-slate-200 bg-white hover:bg-slate-50 flex items-center justify-center"
              aria-label="Prev"
            >
              <Icon name="chevron_left" />
            </button>
            {Array.from({ length: totalPages })
              .slice(0, 8)
              .map((_, i) => {
                const n = i + 1;
                const active = n === pageClamped;
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setPage(n)}
                    className={cn(
                      "w-[36px] h-[36px] rounded-[10px] border-2 font-extrabold text-[12px]",
                      active
                        ? "bg-orange-500 text-white border-orange-500"
                        : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50",
                    )}
                  >
                    {n}
                  </button>
                );
              })}
            <button
              type="button"
              onClick={() => setPage((p) => clampPage(p + 1, 1, totalPages))}
              className="w-[36px] h-[36px] rounded-[10px] border-2 border-slate-200 bg-white hover:bg-slate-50 flex items-center justify-center"
              aria-label="Next"
            >
              <Icon name="chevron_right" />
            </button>
          </div>
        </div>

        <div className="col-span-3">
          <div className="rounded-[18px] border-2 border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-[13px] font-extrabold text-slate-900">
              Summary
            </div>
            <div className="mt-4 rounded-[16px] border border-slate-200 bg-slate-50 p-4 text-center">
              <div className="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider">
                Total Sales
              </div>
              <div className="mt-2 text-[22px] font-extrabold text-orange-600">
                {formatNpr(summary.totalSales)}
              </div>
            </div>
            <div className="mt-4 space-y-2 text-[12px]">
              <div className="flex justify-between text-slate-600">
                <span>Invoices Generated</span>
                <span className="font-extrabold">{summary.generated}</span>
              </div>
              <div className="flex justify-between text-slate-600">
                <span>Paid Invoices</span>
                <span className="font-extrabold">{summary.paid}</span>
              </div>
              <div className="flex justify-between text-slate-600">
                <span>Partial Payments</span>
                <span className="font-extrabold">{summary.partial}</span>
              </div>
              <div className="flex justify-between text-slate-600">
                <span>Unpaid / Due</span>
                <span className="font-extrabold">{summary.unpaid}</span>
              </div>
            </div>
          </div>

          <div className="mt-4 rounded-[18px] border-2 border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-[12px] font-extrabold text-slate-600 uppercase tracking-wider">
              Tips
            </div>
            <div className="mt-2 text-[12px] text-slate-500">
              Use search to quickly find an invoice by number or customer name.
              "View Invoice" opens full details and print actions.
            </div>
          </div>
        </div>
      </div>

      <InvoiceModal
        open={!!selectedInvoiceId}
        invoice={detailInvoice}
        onClose={closeInvoice}
      />
    </div>
  );
}
