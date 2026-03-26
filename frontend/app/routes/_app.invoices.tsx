import React, { useEffect, useMemo, useState } from "react";
import Icon from "~/components/ui/Icon";
import InvoiceDetailModal from "~/components/invoices/InvoiceDetailModal";
import {
  addPaymentApi,
  cancelInvoiceApi,
  getInvoiceApi,
  initiateEsewaPaymentApi,
  listInvoicesApi,
} from "~/lib/api/endpoints";
import { getAuthUser } from "~/lib/auth";
import { submitEsewaForm } from "~/lib/esewa";
import type {
  AppInvoice,
  InvoiceStatusLabel,
  PaymentMethodLabel,
} from "~/lib/invoices";
import { formatNpr, normalizeInvoice, openInvoicePrint } from "~/lib/invoices";

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function statusPill(status: InvoiceStatusLabel) {
  const map: Record<InvoiceStatusLabel, { label: string; cls: string }> = {
    Paid: {
      label: "PAID",
      cls: "bg-[#CFCFD3] text-[#000000] border-[#8C8889]", // Clouded Pearl
    },
    Partial: {
      label: "PARTIAL",
      cls: "bg-[#FFFFFF] text-[#8C8889] border-[#8C8889]", // Pure Snow / Silver Slate
    },
    Unpaid: {
      label: "UNPAID",
      cls: "bg-rose-50 text-rose-700 border-rose-200", // Red for critical importance
    },
    Cancelled: {
      label: "CANCELLED",
      cls: "bg-[#CFCFD3] text-[#8C8889] border-[#CFCFD3]", // Clouded Pearl
    },
  };

  return (
    <span
      className={cn(
        "px-[10px] py-[4px] rounded-[999px] text-[11px] font-extrabold border tracking-wider",
        map[status].cls,
      )}
    >
      {map[status].label}
    </span>
  );
}

function methodChip(method: PaymentMethodLabel) {
  const base =
    "inline-flex items-center gap-1.5 px-[8px] py-[4px] rounded-[10px] text-[11px] font-bold border";
  if (method === "Cash") {
    return (
      <span
        className={cn(base, "bg-[#FFFFFF] text-[#000000] border-[#8C8889]")}
      >
        <Icon name="payments" className="text-[13px]" />
        Cash
      </span>
    );
  }
  if (method === "eSewa" || method === "Khalti") {
    return (
      <span
        className={cn(base, "bg-[#CFCFD3] text-[#000000] border-[#8C8889]")}
      >
        <Icon
          name={method === "eSewa" ? "qr_code_2" : "account_balance_wallet"}
          className="text-[13px]"
        />
        {method}
      </span>
    );
  }
  return (
    <span className={cn(base, "bg-[#CFCFD3] text-[#8C8889] border-[#CFCFD3]")}>
      <Icon name="block" className="text-[13px]" />
      No Payment
    </span>
  );
}

function calcSummary(invoices: AppInvoice[]) {
  const generated = invoices.length;
  const paid = invoices.filter((invoice) => invoice.status === "Paid").length;
  const partial = invoices.filter(
    (invoice) => invoice.status === "Partial",
  ).length;
  const unpaid = invoices.filter(
    (invoice) => invoice.status === "Unpaid",
  ).length;
  const cancelled = invoices.filter(
    (invoice) => invoice.status === "Cancelled",
  ).length;
  const totalSales = invoices.reduce(
    (sum, invoice) =>
      sum + (invoice.status !== "Cancelled" ? invoice.netTotal : 0),
    0,
  );

  return { generated, paid, partial, unpaid, cancelled, totalSales };
}

function clampPage(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

type InvoiceEditPaymentMethod = "Cash" | "eSewa";

function InvoiceEditModal({
  invoice,
  paymentMethod,
  paymentAmount,
  paymentError,
  busy,
  onChangePaymentMethod,
  onChangePaymentAmount,
  onClose,
  onAddPayment,
  onMarkPaid,
  onCancelInvoice,
}: {
  invoice: AppInvoice | null;
  paymentMethod: InvoiceEditPaymentMethod;
  paymentAmount: string;
  paymentError: string;
  busy: boolean;
  onChangePaymentMethod: (value: InvoiceEditPaymentMethod) => void;
  onChangePaymentAmount: (value: string) => void;
  onClose: () => void;
  onAddPayment: () => void;
  onMarkPaid: () => void;
  onCancelInvoice: () => void;
}) {
  if (!invoice) return null;

  const paymentLocked =
    invoice.status === "Paid" || invoice.status === "Cancelled";
  const canSettle = !paymentLocked && invoice.dueAmount > 0;

  return (
    <div className="fixed inset-0 z-[65]">
      {/* Backdrop blur overlay with Midnight Mist opacity */}
      <button
        type="button"
        className="absolute inset-0 bg-[#000000]/40 backdrop-blur-sm transition-all"
        onClick={onClose}
        aria-label="Close"
      />
      <div className="absolute left-1/2 top-1/2 w-[560px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 rounded-[20px] border-2 border-[#CFCFD3] bg-[#FFFFFF] shadow-2xl overflow-hidden">
        <div className="p-5 border-b border-[#CFCFD3] flex items-center justify-between">
          <div>
            <div className="text-[12px] font-extrabold text-[#8C8889] uppercase tracking-wider">
              Edit invoice
            </div>
            <div className="text-[18px] font-extrabold text-[#000000] mt-1">
              {invoice.invoiceNo}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-[38px] h-[38px] rounded-[12px] border-2 border-[#CFCFD3] bg-[#FFFFFF] hover:bg-[#CFCFD3] flex items-center justify-center text-[#000000] transition"
            aria-label="Close"
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <div className="block text-[12px] font-extrabold text-[#8C8889] uppercase tracking-wider mb-2">
              Payment method
            </div>
            <div className="grid grid-cols-2 gap-3">
              {(["Cash", "eSewa"] as const).map((method) => (
                <button
                  key={method}
                  type="button"
                  onClick={() => onChangePaymentMethod(method)}
                  className={cn(
                    "h-[44px] rounded-[14px] border-2 font-extrabold transition",
                    paymentMethod === method
                      ? method === "Cash"
                        ? "bg-[#000000] text-[#FFFFFF] border-[#000000]"
                        : "bg-emerald-600 text-white border-emerald-600"
                      : "bg-[#FFFFFF] text-[#000000] border-[#CFCFD3] hover:bg-[#CFCFD3]",
                  )}
                >
                  {method === "Cash" ? "Cash" : "eSewa"}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 text-[13px]">
            <div className="rounded-[14px] border border-[#CFCFD3] bg-[#CFCFD3]/20 p-3">
              <div className="text-[#8C8889] font-bold">Customer</div>
              <div className="text-[#000000] font-extrabold mt-1">
                {invoice.customerName}
              </div>
              <div className="text-[12px] text-[#8C8889] mt-1">
                {invoice.customerSubtitle}
              </div>
            </div>
            <div className="rounded-[14px] border border-[#CFCFD3] bg-[#CFCFD3]/20 p-3">
              <div className="text-[#8C8889] font-bold">Status</div>
              <div className="mt-2">{statusPill(invoice.status)}</div>
            </div>
            <div className="rounded-[14px] border border-[#CFCFD3] bg-[#CFCFD3]/20 p-3">
              <div className="text-[#8C8889] font-bold">Total</div>
              <div className="font-mono font-extrabold text-[#000000] mt-1">
                {formatNpr(invoice.netTotal)}
              </div>
            </div>
            <div className="rounded-[14px] border border-[#CFCFD3] bg-[#CFCFD3]/20 p-3">
              <div className="text-[#8C8889] font-bold">Paid / Due</div>
              <div className="font-mono font-extrabold text-[#000000] mt-1">
                {formatNpr(invoice.paidAmount)} / {formatNpr(invoice.dueAmount)}
              </div>
            </div>
          </div>

          <div>
            <label className="block text-[12px] font-extrabold text-[#8C8889] uppercase tracking-wider mb-2">
              Add payment amount
            </label>
            <input
              value={paymentAmount}
              onChange={(e) =>
                onChangePaymentAmount(e.target.value.replace(/[^\d.]/g, ""))
              }
              placeholder="e.g. 500"
              className={cn(
                "w-full rounded-[14px] border-2 bg-[#FFFFFF] px-4 py-3 text-[14px] font-semibold text-[#000000] outline-none transition",
                paymentError
                  ? "border-rose-500"
                  : "border-[#CFCFD3] focus:border-[#000000]",
              )}
            />
            {paymentError ? (
              <div className="mt-2 text-[12px] font-extrabold text-rose-600">
                {paymentError}
              </div>
            ) : (
              <div className="mt-2 text-[12px] text-[#8C8889]">
                Enter an amount greater than 0 and not more than the remaining
                due.
              </div>
            )}
          </div>

          {paymentMethod === "eSewa" && canSettle ? (
            <div className="rounded-[14px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-[12px] text-emerald-800">
              This will create a pending eSewa attempt for the exact amount and
              redirect to the official sandbox form.
            </div>
          ) : null}

          {paymentLocked ? (
            <div className="rounded-[14px] border border-[#CFCFD3] bg-[#CFCFD3]/40 px-4 py-3 text-[13px] text-[#000000] font-semibold">
              {invoice.status === "Paid"
                ? "This invoice is already fully paid."
                : "This invoice has been cancelled and can no longer be updated."}
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-3">
            <button
              type="button"
              onClick={onAddPayment}
              disabled={busy || !canSettle}
              className="h-[46px] rounded-[14px] bg-[#000000] text-[#FFFFFF] font-extrabold hover:bg-[#8C8889] disabled:opacity-50 disabled:pointer-events-none transition"
            >
              {busy
                ? "Saving..."
                : paymentMethod === "eSewa"
                  ? "Continue to eSewa"
                  : "Add Payment"}
            </button>
            <button
              type="button"
              onClick={onMarkPaid}
              disabled={busy || !canSettle}
              className="h-[46px] rounded-[14px] border-2 border-[#CFCFD3] bg-[#FFFFFF] text-[#000000] font-extrabold hover:bg-[#CFCFD3] disabled:opacity-50 disabled:pointer-events-none transition"
            >
              Mark Fully Paid (Cash)
            </button>
            <button
              type="button"
              onClick={onCancelInvoice}
              disabled={busy || invoice.status === "Cancelled"}
              className="h-[46px] rounded-[14px] border-2 border-rose-200 bg-rose-50 text-rose-700 font-extrabold hover:bg-rose-100 disabled:opacity-50 disabled:pointer-events-none transition"
            >
              Cancel Invoice
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function CashierInvoicesPage() {
  const authUser = getAuthUser();
  const [activeTab, setActiveTab] = useState<"All" | InvoiceStatusLabel>("All");
  const [query, setQuery] = useState("");
  const [isFilterOpen, setFilterOpen] = useState(false);
  const [onlyMine, setOnlyMine] = useState(false);
  const [methodFilter, setMethodFilter] = useState<"All" | PaymentMethodLabel>(
    "All",
  );
  const [invoices, setInvoices] = useState<AppInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(
    null,
  );
  const [detailInvoice, setDetailInvoice] = useState<AppInvoice | null>(null);
  const [editInvoice, setEditInvoice] = useState<AppInvoice | null>(null);
  const [editPaymentMethod, setEditPaymentMethod] =
    useState<InvoiceEditPaymentMethod>("Cash");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentError, setPaymentError] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  async function loadInvoices() {
    const data = await listInvoicesApi({ pageSize: 100 });
    const raw = Array.isArray(data?.invoices) ? data.invoices : [];
    setInvoices(raw.map(normalizeInvoice));
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
      .filter((invoice) =>
        onlyMine && authUser?.id ? invoice.cashierId === authUser.id : true,
      )
      .filter((invoice) =>
        methodFilter === "All" ? true : invoice.paymentMethod === methodFilter,
      )
      .filter((invoice) => {
        if (!loweredQuery) return true;
        return [
          invoice.invoiceNo,
          invoice.customerName,
          invoice.cashierName,
          invoice.itemSummary,
        ]
          .join(" ")
          .toLowerCase()
          .includes(loweredQuery);
      });
  }, [activeTab, authUser?.id, invoices, methodFilter, onlyMine, query]);

  const summary = useMemo(() => calcSummary(filtered), [filtered]);

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const [page, setPage] = useState(1);
  const pageClamped = clampPage(page, 1, totalPages);

  const pageItems = useMemo(() => {
    const start = (pageClamped - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, pageClamped]);

  async function openInvoice(id: string) {
    const cached = invoices.find((invoice) => invoice.id === id) || null;
    setSelectedInvoiceId(id);
    setDetailInvoice(cached);
    try {
      const detailed = await hydrateInvoice(id);
      setDetailInvoice(detailed);
    } catch {
      setDetailInvoice(cached);
    }
  }

  function closeInvoice() {
    setSelectedInvoiceId(null);
    setDetailInvoice(null);
  }

  function openEditInvoice(invoice: AppInvoice) {
    setEditInvoice(invoice);
    setEditPaymentMethod("Cash");
    setPaymentAmount(invoice.dueAmount > 0 ? String(invoice.dueAmount) : "");
    setPaymentError("");
  }

  function closeEditInvoice() {
    setEditInvoice(null);
    setEditPaymentMethod("Cash");
    setPaymentAmount("");
    setPaymentError("");
  }

  function validatePaymentAmount(invoice: AppInvoice, overrideAmount?: number) {
    const nextAmount = overrideAmount ?? Number(paymentAmount);
    if (!Number.isFinite(nextAmount)) {
      setPaymentError("Enter a valid payment amount.");
      return null;
    }
    if (nextAmount <= 0) {
      setPaymentError("Payment amount must be greater than 0.");
      return null;
    }
    if (nextAmount > invoice.dueAmount) {
      setPaymentError("Payment amount cannot exceed the remaining due.");
      return null;
    }
    setPaymentError("");
    return nextAmount;
  }

  async function refreshInvoiceState(invoiceId: string) {
    await loadInvoices();
    const updated = await hydrateInvoice(invoiceId);
    setDetailInvoice((current) =>
      current?.id === invoiceId ? updated : current,
    );
    return updated;
  }

  async function handleAddPayment() {
    if (!editInvoice) return;
    const amount = validatePaymentAmount(editInvoice);
    if (amount === null) return;

    try {
      setSavingEdit(true);
      if (editPaymentMethod === "Cash") {
        await addPaymentApi(editInvoice.id, {
          method: "CASH",
          amount,
          status: "SUCCESS",
        });
        await refreshInvoiceState(editInvoice.id);
        closeEditInvoice();
      } else {
        const initiated = await initiateEsewaPaymentApi(editInvoice.id, amount);
        closeEditInvoice();
        submitEsewaForm(initiated.formAction, initiated.fields || {});
        return;
      }
    } catch (error: any) {
      setPaymentError(
        error.response?.data?.error || "Failed to update invoice.",
      );
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleMarkFullyPaid() {
    if (!editInvoice) return;
    const amount = validatePaymentAmount(editInvoice, editInvoice.dueAmount);
    if (amount === null) return;

    try {
      setSavingEdit(true);
      await addPaymentApi(editInvoice.id, {
        method: "CASH",
        amount,
        status: "SUCCESS",
      });
      await refreshInvoiceState(editInvoice.id);
      closeEditInvoice();
    } catch (error: any) {
      setPaymentError(
        error.response?.data?.error || "Failed to mark invoice as paid.",
      );
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleCancelInvoice() {
    if (!editInvoice) return;

    try {
      setSavingEdit(true);
      await cancelInvoiceApi(editInvoice.id);
      await refreshInvoiceState(editInvoice.id);
      closeEditInvoice();
    } catch (error: any) {
      setPaymentError(
        error.response?.data?.error || "Failed to cancel invoice.",
      );
    } finally {
      setSavingEdit(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-[#8C8889] font-semibold">Loading invoices...</div>
      </div>
    );
  }

  return (
    <div className="w-full">
      {/* HEADER SECTION */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[24px] font-extrabold text-[#000000]">
            Invoices Management
          </div>
          <div className="text-[13px] text-[#8C8889] mt-1 font-bold">
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
            <div className="flex items-center gap-2 rounded-[12px] border-2 border-[#CFCFD3] bg-[#FFFFFF] px-[14px] py-[10px] shadow-sm focus-within:border-[#000000] transition-colors">
              <Icon name="search" className="text-[#8C8889]" />
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(1);
                }}
                placeholder="Search invoice no, customer, or item..."
                className="w-full outline-none text-[13px] font-semibold text-[#000000] placeholder:text-[#8C8889] bg-transparent"
              />
            </div>
          </div>
          <button
            type="button"
            onClick={() => setFilterOpen((value) => !value)}
            className="h-[44px] px-[16px] rounded-[12px] border-2 border-[#CFCFD3] bg-[#FFFFFF] hover:bg-[#CFCFD3] font-extrabold text-[#000000] flex items-center gap-2 transition shadow-sm"
          >
            <Icon name="filter_list" />
            Filter
          </button>
        </div>
      </div>

      {/* RESTRUCTURED SUMMARY METRICS ROW */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-6">
        <div className="bg-[#FFFFFF] rounded-2xl border border-[#CFCFD3] p-5 shadow-sm">
          <div className="text-[11px] font-extrabold text-[#8C8889] uppercase tracking-wider">
            Total Sales
          </div>
          <div className="text-2xl font-extrabold text-[#000000] mt-1">
            {formatNpr(summary.totalSales)}
          </div>
        </div>

        <div className="bg-[#FFFFFF] rounded-2xl border border-[#CFCFD3] p-5 shadow-sm">
          <div className="text-[11px] font-extrabold text-[#8C8889] uppercase tracking-wider">
            Invoices Generated
          </div>
          <div className="text-2xl font-extrabold text-[#000000] mt-1">
            {summary.generated}
          </div>
        </div>

        <div className="bg-[#FFFFFF] rounded-2xl border border-[#CFCFD3] p-5 shadow-sm">
          <div className="text-[11px] font-extrabold text-[#8C8889] uppercase tracking-wider">
            Paid Invoices
          </div>
          <div className="text-2xl font-extrabold text-[#000000] mt-1">
            {summary.paid}
          </div>
          <div className="text-[12px] font-medium text-[#8C8889] mt-2 border-t border-[#CFCFD3]/50 pt-2">
            <span className="font-extrabold text-[#000000]">
              {summary.partial}
            </span>{" "}
            partially paid
          </div>
        </div>

        <div className="bg-[#FFFFFF] rounded-2xl border border-[#CFCFD3] p-5 shadow-sm">
          <div className="text-[11px] font-extrabold text-[#8C8889] uppercase tracking-wider">
            Unpaid / Due
          </div>
          <div
            className={cn(
              "text-2xl font-extrabold mt-1",
              summary.unpaid > 0 ? "text-rose-600" : "text-[#000000]",
            )}
          >
            {summary.unpaid}
          </div>
          <div className="text-[12px] font-medium text-[#8C8889] mt-2 border-t border-[#CFCFD3]/50 pt-2">
            <span className="font-extrabold text-[#000000]">
              {summary.cancelled}
            </span>{" "}
            cancelled
          </div>
        </div>
      </div>

      {/* TABS & FILTERS */}
      <div className="mt-6 flex items-center gap-2 flex-wrap">
        {(["All", "Paid", "Partial", "Unpaid", "Cancelled"] as const).map(
          (tab) => {
            const active = tab === activeTab;
            return (
              <button
                key={tab}
                type="button"
                onClick={() => {
                  setActiveTab(tab);
                  setPage(1);
                }}
                className={cn(
                  "px-[16px] py-[8px] rounded-[999px] border-2 text-[12px] font-extrabold transition shadow-sm",
                  active
                    ? "bg-[#000000] text-[#FFFFFF] border-[#000000]"
                    : "bg-[#FFFFFF] text-[#8C8889] border-[#CFCFD3] hover:bg-[#CFCFD3]",
                )}
              >
                {tab === "All" ? "All Invoices" : tab}
              </button>
            );
          },
        )}
      </div>

      {isFilterOpen ? (
        <div className="mt-4 rounded-[18px] border-2 border-[#CFCFD3] bg-[#FFFFFF] p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b border-[#CFCFD3] pb-4">
            <div className="text-[12px] font-extrabold text-[#8C8889] uppercase tracking-wider">
              Filter Options
            </div>
            <button
              type="button"
              onClick={() => setFilterOpen(false)}
              className="w-[32px] h-[32px] rounded-lg border border-[#CFCFD3] bg-[#FFFFFF] hover:bg-[#CFCFD3] flex items-center justify-center text-[#000000] transition"
            >
              <Icon name="close" className="text-[18px]" />
            </button>
          </div>
          <div className="mt-4 grid grid-cols-12 gap-5">
            <div className="col-span-4">
              <div className="text-[11px] font-extrabold text-[#8C8889] uppercase tracking-wider">
                Cashier Match
              </div>
              <label className="mt-3 flex items-center gap-2 text-[13px] font-bold text-[#000000] cursor-pointer">
                <input
                  type="checkbox"
                  checked={onlyMine}
                  onChange={(e) => setOnlyMine(e.target.checked)}
                  className="w-4 h-4 accent-[#000000]"
                />
                Show only my invoices
              </label>
            </div>
            <div className="col-span-8">
              <div className="text-[11px] font-extrabold text-[#8C8889] uppercase tracking-wider">
                Payment Method
              </div>
              <div className="mt-3 flex gap-2 flex-wrap">
                {(["All", "Cash", "eSewa", "Khalti", "None"] as const).map(
                  (method) => {
                    const active = method === methodFilter;
                    return (
                      <button
                        key={method}
                        type="button"
                        onClick={() => setMethodFilter(method)}
                        className={cn(
                          "px-[14px] py-[6px] rounded-lg border font-extrabold text-[12px] transition",
                          active
                            ? "bg-[#000000] text-[#FFFFFF] border-[#000000]"
                            : "bg-[#FFFFFF] text-[#8C8889] border-[#CFCFD3] hover:bg-[#CFCFD3]",
                        )}
                      >
                        {method}
                      </button>
                    );
                  },
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* FULL-WIDTH DATA TABLE WITH UPDATED SUMMARY COLUMN */}
      <div className="mt-6 bg-[#FFFFFF] border-2 border-[#CFCFD3] rounded-[20px] overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[800px]">
            <thead>
              <tr className="bg-[#CFCFD3]/40 border-b-2 border-[#CFCFD3]">
                <th className="px-5 py-4 text-[11px] font-extrabold text-[#8C8889] uppercase tracking-wider">
                  Invoice / Date
                </th>
                <th className="px-5 py-4 text-[11px] font-extrabold text-[#8C8889] uppercase tracking-wider">
                  Customer
                </th>
                <th className="px-5 py-4 text-[11px] font-extrabold text-[#8C8889] uppercase tracking-wider">
                  Summary
                </th>
                <th className="px-5 py-4 text-[11px] font-extrabold text-[#8C8889] uppercase tracking-wider">
                  Status & Method
                </th>
                <th className="px-5 py-4 text-[11px] font-extrabold text-[#8C8889] uppercase tracking-wider text-right">
                  Net Total
                </th>
                <th className="px-5 py-4 text-[11px] font-extrabold text-[#8C8889] uppercase tracking-wider text-center">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#CFCFD3]">
              {pageItems.map((invoice) => (
                <tr
                  key={invoice.id}
                  className="hover:bg-[#CFCFD3]/20 transition-colors group"
                >
                  {/* Invoice & Date */}
                  <td className="px-5 py-4 align-top">
                    <div className="font-bold text-[#000000]">
                      {invoice.invoiceNo}
                    </div>
                    <div className="text-[12px] text-[#8C8889] mt-1">
                      {invoice.createdDateLabel}
                    </div>
                    <div className="text-[11px] text-[#8C8889] mt-0.5 opacity-80">
                      By {invoice.cashierName}
                    </div>
                  </td>

                  {/* Customer */}
                  <td className="px-5 py-4 align-top">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-[#CFCFD3] border border-[#CFCFD3] flex items-center justify-center font-extrabold text-[#000000] text-xs shrink-0">
                        {invoice.customerName
                          .split(" ")
                          .slice(0, 2)
                          .map((part) => part[0])
                          .join("")
                          .toUpperCase()}
                      </div>
                      <div>
                        <div className="font-extrabold text-[#000000]">
                          {invoice.customerName}
                        </div>
                        <div className="text-[12px] text-[#8C8889] font-medium">
                          {invoice.customerSubtitle}
                        </div>
                      </div>
                    </div>
                  </td>

                  {/* INTERACTIVE ORDER BADGE SUMMARY */}
                  <td className="px-5 py-4 align-top max-w-[260px]">
                    <div
                      className="inline-flex items-center gap-2 bg-[#CFCFD3]/30 border border-[#CFCFD3] px-3 py-1.5 rounded-[10px] w-full cursor-help hover:bg-[#CFCFD3]/60 transition-colors"
                      title={invoice.itemSummary}
                    >
                      <Icon
                        name="shopping_bag"
                        className="text-[14px] text-[#8C8889] shrink-0"
                      />
                      <span className="text-[12px] font-medium text-[#000000] truncate">
                        {invoice.itemSummary || "No items"}
                      </span>
                    </div>
                  </td>

                  {/* Status & Method */}
                  <td className="px-5 py-4 align-top">
                    <div className="flex flex-col items-start gap-2">
                      <div className="flex items-center gap-2">
                        {statusPill(invoice.status)}
                        {methodChip(invoice.paymentMethod)}
                      </div>
                      {invoice.status !== "Paid" &&
                        invoice.status !== "Cancelled" &&
                        invoice.dueAmount > 0 && (
                          <div className="text-[11px] font-extrabold text-white bg-rose-600 border border-rose-600 px-2 py-0.5 rounded-md">
                            Due: {formatNpr(invoice.dueAmount)}
                          </div>
                        )}
                    </div>
                  </td>

                  {/* Net Total */}
                  <td className="px-5 py-4 align-top text-right">
                    <div className="font-mono font-extrabold text-[#000000] text-[15px]">
                      {formatNpr(invoice.netTotal)}
                    </div>
                  </td>

                  {/* Actions */}
                  <td className="px-5 py-4 align-top">
                    <div className="flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity focus-within:opacity-100">
                      <button
                        onClick={() => openInvoice(invoice.id)}
                        className="w-8 h-8 rounded-lg bg-[#CFCFD3]/50 hover:bg-[#000000] text-[#8C8889] hover:text-[#FFFFFF] flex items-center justify-center transition-colors"
                        title="View"
                      >
                        <Icon name="visibility" className="text-[16px]" />
                      </button>
                      <button
                        onClick={() => openEditInvoice(invoice)}
                        className="w-8 h-8 rounded-lg bg-[#CFCFD3]/50 hover:bg-[#000000] text-[#8C8889] hover:text-[#FFFFFF] flex items-center justify-center transition-colors"
                        title="Edit"
                      >
                        <Icon name="edit" className="text-[16px]" />
                      </button>
                      <button
                        onClick={() => openInvoicePrint(invoice.id)}
                        className="w-8 h-8 rounded-lg bg-[#CFCFD3]/50 hover:bg-[#000000] text-[#8C8889] hover:text-[#FFFFFF] flex items-center justify-center transition-colors"
                        title="Print"
                      >
                        <Icon name="print" className="text-[16px]" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {pageItems.length === 0 ? (
          <div className="h-[150px] flex items-center justify-center text-[#8C8889] font-semibold">
            No invoices match your criteria.
          </div>
        ) : null}

        {/* PAGINATION FOOTER */}
        <div className="border-t-2 border-[#CFCFD3] bg-[#FFFFFF] p-4 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() =>
              setPage((current) => clampPage(current - 1, 1, totalPages))
            }
            className="w-[32px] h-[32px] rounded-lg border-2 border-[#CFCFD3] bg-[#FFFFFF] hover:bg-[#CFCFD3] flex items-center justify-center text-[#000000] transition"
          >
            <Icon name="chevron_left" className="text-[18px]" />
          </button>
          {Array.from({ length: totalPages })
            .slice(0, 8)
            .map((_, index) => {
              const pageNumber = index + 1;
              const active = pageNumber === pageClamped;
              return (
                <button
                  key={pageNumber}
                  type="button"
                  onClick={() => setPage(pageNumber)}
                  className={cn(
                    "w-[32px] h-[32px] rounded-lg border-2 font-extrabold text-[12px] transition",
                    active
                      ? "bg-[#000000] text-[#FFFFFF] border-[#000000]"
                      : "bg-[#FFFFFF] text-[#8C8889] border-[#CFCFD3] hover:bg-[#CFCFD3]",
                  )}
                >
                  {pageNumber}
                </button>
              );
            })}
          <button
            type="button"
            onClick={() =>
              setPage((current) => clampPage(current + 1, 1, totalPages))
            }
            className="w-[32px] h-[32px] rounded-lg border-2 border-[#CFCFD3] bg-[#FFFFFF] hover:bg-[#CFCFD3] flex items-center justify-center text-[#000000] transition"
          >
            <Icon name="chevron_right" className="text-[18px]" />
          </button>
        </div>
      </div>

      <InvoiceDetailModal
        open={!!selectedInvoiceId}
        invoice={detailInvoice}
        onClose={closeInvoice}
        extraActions={
          detailInvoice ? (
            <button
              type="button"
              onClick={() => openEditInvoice(detailInvoice)}
              className="h-[44px] rounded-[14px] border-2 border-[#CFCFD3] bg-[#FFFFFF] hover:bg-[#CFCFD3] font-extrabold text-[#000000] flex items-center justify-center gap-2 transition px-4"
            >
              <Icon name="edit" />
              Edit Invoice
            </button>
          ) : null
        }
      />

      <InvoiceEditModal
        invoice={editInvoice}
        paymentMethod={editPaymentMethod}
        paymentAmount={paymentAmount}
        paymentError={paymentError}
        busy={savingEdit}
        onChangePaymentMethod={setEditPaymentMethod}
        onChangePaymentAmount={setPaymentAmount}
        onClose={closeEditInvoice}
        onAddPayment={handleAddPayment}
        onMarkPaid={handleMarkFullyPaid}
        onCancelInvoice={handleCancelInvoice}
      />
    </div>
  );
}
