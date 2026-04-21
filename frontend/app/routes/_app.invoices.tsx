import React, { useEffect, useMemo, useState } from "react";
import {
  InvoiceStatusChip,
  PaymentMethodChip,
} from "~/components/invoices/InvoiceChips";
import { ConfirmDialog } from "~/components/ui/Modal";
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

// we use this helper function to easily join multiple tailwind class strings
function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

// this function loops through all invoices to calculate totals for the dashboard-style summary cards
// we filter out cancelled invoices when summing up sales and due amounts so the numbers are accurate
function calcSummary(invoices: AppInvoice[]) {
  const generated = invoices.length;
  const paid = invoices.filter((invoice) => invoice.status === "Paid").length;
  const partial = invoices.filter(
    (invoice) => invoice.status === "Partial",
  ).length;
  const unpaid = invoices.filter(
    (invoice) => invoice.status === "Unpaid",
  ).length;
  const due = invoices.filter(
    (invoice) => invoice.status !== "Cancelled" && invoice.dueAmount > 0,
  ).length;
  const cancelled = invoices.filter(
    (invoice) => invoice.status === "Cancelled",
  ).length;

  const totalSales = invoices.reduce(
    (sum, invoice) =>
      sum + (invoice.status !== "Cancelled" ? invoice.netTotal : 0),
    0,
  );

  const outstandingDue = invoices.reduce(
    (sum, invoice) =>
      sum + (invoice.status !== "Cancelled" ? invoice.dueAmount : 0),
    0,
  );

  return {
    generated,
    paid,
    partial,
    unpaid,
    due,
    cancelled,
    totalSales,
    outstandingDue,
  };
}

// we use this to keep the pagination page number between 1 and the max pages available
function clampPage(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

// this builds a short string summarizing the items in the invoice (e.g., "Apple x2 + 3 more")
// we use it in the invoice list table to show a quick preview without needing too much space
function getCompactInvoiceSummary(invoice: AppInvoice) {
  const rawItems = (invoice as any)?.items;

  if (Array.isArray(rawItems) && rawItems.length > 0) {
    const firstItem = rawItems[0];
    const firstName =
      firstItem?.productName || firstItem?.name || firstItem?.title || "Item";

    const quantity =
      firstItem?.quantity ?? firstItem?.qty ?? firstItem?.count ?? null;

    const firstLabel = quantity
      ? `${firstName} x${quantity}`
      : String(firstName);

    if (rawItems.length === 1) return firstLabel;

    return `${firstLabel} + ${rawItems.length - 1} more`;
  }

  const raw = invoice.itemSummary?.trim();
  if (!raw) return "No items";

  const parts = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (parts.length <= 1) {
    return parts[0] || "No items";
  }

  return `${parts[0]} + ${parts.length - 1} more`;
}

// keeping customer type checks in one place makes the invoice and history filters easier to read
function getInvoiceCustomerType(invoice: Pick<AppInvoice, "customerId">) {
  return invoice.customerId ? "Registered" : "Walk-in";
}

type InvoiceEditPaymentMethod = "Cash" | "eSewa";
type InvoiceCustomerTypeFilter = "All" | "Walk-in" | "Registered";
type PendingInvoiceAction =
  | { kind: "cash-payment"; amount: number }
  | { kind: "esewa-payment"; amount: number }
  | { kind: "mark-paid"; amount: number }
  | { kind: "cancel-invoice" }
  | null;

// this modal handles invoice follow-up actions like adding payments, marking fully paid, and cancelling
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
  const canSettle = !paymentLocked && invoice.dueAmount > 0; // only unpaid or partial invoices with due left can be updated

  return (
    <div className="fixed inset-0 z-[65]">
      <button
        type="button"
        className="absolute inset-0 bg-[#000000]/40 backdrop-blur-sm transition-all"
        onClick={onClose}
        aria-label="Close"
      />
      <div className="absolute left-1/2 top-1/2 w-[560px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 rounded-[20px] border-2 border-[#CFCFD3] bg-[#FFFFFF]  overflow-hidden">
        <div className="p-5 border-b border-[#CFCFD3] flex items-center justify-between">
          <div>
            <div className="text-[12px] font-extrabold text-[#8C8889] uppercase ">
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
            <div className="block text-[12px] font-extrabold text-[#8C8889] uppercase  mb-2">
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
                        : "bg-[#EAF8EF] text-[#179B4D] border-[#9DD8B2]"
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
              <div className="mt-2">
                <InvoiceStatusChip status={invoice.status} />
              </div>
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
            <label className="block text-[12px] font-extrabold text-[#8C8889] uppercase  mb-2">
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
            <div className="rounded-[14px] border border-[#9DD8B2] bg-[#EAF8EF] px-4 py-3 text-[12px] text-[#179B4D]">
              This will redirect to the eSewa test page for the exact amount
              entered here.
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

// this is the main invoices page
// here, cashiers and admins can view their generated invoices, search them, and open them to see details or add payments
export default function CashierInvoicesPage() {
  const authUser = getAuthUser();
  const isAdminView = authUser?.role === "admin";
  const [activeTab, setActiveTab] = useState<"All" | InvoiceStatusLabel>("All"); // active status tab at the top of the page
  const [query, setQuery] = useState(""); // invoice search text
  const [isFilterOpen, setFilterOpen] = useState(false); // mobile/tablet filter drawer toggle
  const [onlyMine, setOnlyMine] = useState(false); // optional filter to show only invoices created by the logged-in cashier
  const [cashierFilter, setCashierFilter] = useState("All"); // admin-facing cashier selector for narrowing invoices to one cashier
  const [customerTypeFilter, setCustomerTypeFilter] =
    useState<InvoiceCustomerTypeFilter>("All"); // lets the page combine cashier and walk-in/registered filters together
  const [methodFilter, setMethodFilter] = useState<"All" | PaymentMethodLabel>(
    "All",
  );
  const [invoices, setInvoices] = useState<AppInvoice[]>([]); // full normalized invoice list before tab and page slicing
  const [loading, setLoading] = useState(true); // first-load state for the page
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(
    null,
  );
  const [detailInvoice, setDetailInvoice] = useState<AppInvoice | null>(null); // invoice shown in the read-only detail modal
  const [editInvoice, setEditInvoice] = useState<AppInvoice | null>(null); // invoice currently being edited in the payment modal
  const [editPaymentMethod, setEditPaymentMethod] =
    useState<InvoiceEditPaymentMethod>("Cash");
  const [paymentAmount, setPaymentAmount] = useState(""); // amount typed into the edit modal
  const [paymentError, setPaymentError] = useState(""); // edit modal validation or API error
  const [savingEdit, setSavingEdit] = useState(false); // blocks repeated edit actions while an invoice update is running
  const [pendingInvoiceAction, setPendingInvoiceAction] =
    useState<PendingInvoiceAction>(null); // stores the next payment or cancellation action waiting for confirmation

  // fetching a larger invoice list here lets the page search and filter on the client without constant reloads
  async function loadInvoices() {
    const data = await listInvoicesApi({ pageSize: 100 });
    const raw = Array.isArray(data?.invoices) ? data.invoices : [];
    setInvoices(raw.map(normalizeInvoice));
  }

  // this fetches one full invoice record before showing detailed data in either modal
  async function hydrateInvoice(id: string) {
    const data = await getInvoiceApi(id);
    return normalizeInvoice(data);
  }

  useEffect(() => {
    // loading the invoice list once when the page first opens
    async function load() {
      try {
        await loadInvoices();
      } catch {
        // this handles when the invoice list request fails, so we fall back to an empty state instead of stale data
        setInvoices([]);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // deriving the cashier dropdown from the loaded invoice data keeps the filter in sync without extra API calls
  const cashierOptions = useMemo(() => {
    const options = new Map<string, string>();

    invoices.forEach((invoice) => {
      if (!invoice.cashierId) return;
      if (!options.has(invoice.cashierId)) {
        options.set(invoice.cashierId, invoice.cashierName);
      }
    });

    return Array.from(options.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [invoices]);

  // computing the list of invoices after applying the search query and filters
  // we wrap this in useMemo so it only recalculates when the query or invoices change
  const scopedInvoices = useMemo(() => {
    const loweredQuery = query.trim().toLowerCase();

    return invoices
      .filter((invoice) =>
        isAdminView
          ? cashierFilter === "All"
            ? true
            : invoice.cashierId === cashierFilter
          : true,
      )
      .filter((invoice) =>
        !isAdminView && onlyMine && authUser?.id
          ? invoice.cashierId === authUser.id
          : true,
      )
      .filter((invoice) =>
        customerTypeFilter === "All"
          ? true
          : getInvoiceCustomerType(invoice) === customerTypeFilter,
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
  }, [
    authUser?.id,
    cashierFilter,
    customerTypeFilter,
    invoices,
    isAdminView,
    methodFilter,
    onlyMine,
    query,
  ]);

  const filtered = useMemo(() => {
    return scopedInvoices.filter((invoice) =>
      activeTab === "All" ? true : invoice.status === activeTab,
    );
  }, [activeTab, scopedInvoices]);

  const summary = useMemo(() => calcSummary(scopedInvoices), [scopedInvoices]); // summary cards always reflect the current search and filter scope

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const [page, setPage] = useState(1);
  const pageClamped = clampPage(page, 1, totalPages);
  const hasExtraFilters = isAdminView
    ? cashierFilter !== "All" ||
      customerTypeFilter !== "All" ||
      methodFilter !== "All"
    : onlyMine || customerTypeFilter !== "All" || methodFilter !== "All";

  const pageItems = useMemo(() => {
    const start = (pageClamped - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, pageClamped]);

  // clearing the secondary filters lets the user get back to the full invoice list quickly without disturbing search or tabs
  function clearExtraFilters() {
    setOnlyMine(false);
    setCashierFilter("All");
    setCustomerTypeFilter("All");
    setMethodFilter("All");
    setPage(1);
  }

  // fetching the full invoice details when the user clicks to view it
  async function openInvoice(id: string) {
    // we show the cached preview version first so the modal opens instantly
    const cached = invoices.find((invoice) => invoice.id === id) || null;
    setSelectedInvoiceId(id);
    setDetailInvoice(cached);

    // then we fetch the detailed version from the backend inside a try block
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

  // this opens the edit modal with the invoice's due amount prefilled so cashiers can settle it faster
  function openEditInvoice(invoice: AppInvoice) {
    setEditInvoice(invoice);
    setEditPaymentMethod("Cash");
    setPaymentAmount(invoice.dueAmount > 0 ? String(invoice.dueAmount) : "");
    setPaymentError("");
  }

  // clearing the edit state here makes sure each invoice starts with a clean payment form
  function closeEditInvoice() {
    setEditInvoice(null);
    setEditPaymentMethod("Cash");
    setPaymentAmount("");
    setPaymentError("");
    setPendingInvoiceAction(null);
  }

  // we use this to validate the payment input before submitting
  // making sure they typed a number that is greater than 0 and less than or equal to the due amount
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

  // reloading both the list and the specific invoice keeps the table and whichever modal is open perfectly in sync
  async function refreshInvoiceState(invoiceId: string) {
    await loadInvoices();
    const updated = await hydrateInvoice(invoiceId);

    setDetailInvoice((current) =>
      current?.id === invoiceId ? updated : current,
    );

    return updated;
  }

  // we validate first, then open a confirmation modal so the cashier can double-check before we save anything
  function handleAddPayment() {
    if (!editInvoice) return;

    const amount = validatePaymentAmount(editInvoice);
    if (amount === null) return;

    setPaymentError("");
    setPendingInvoiceAction(
      editPaymentMethod === "eSewa"
        ? { kind: "esewa-payment", amount }
        : { kind: "cash-payment", amount },
    );
  }

  // marking fully paid is also confirmed first because it immediately records the whole remaining due as cash
  function handleMarkFullyPaid() {
    if (!editInvoice) return;

    const amount = validatePaymentAmount(editInvoice, editInvoice.dueAmount);
    if (amount === null) return;

    setPaymentError("");
    setPendingInvoiceAction({ kind: "mark-paid", amount });
  }

  // invoice cancellation affects stock and payment state, so we always ask for explicit confirmation first
  function handleCancelInvoice() {
    if (!editInvoice) return;
    setPaymentError("");
    setPendingInvoiceAction({ kind: "cancel-invoice" });
  }

  // all confirmed invoice follow-up actions funnel through one executor so success and error handling stay consistent
  async function confirmPendingInvoiceAction() {
    if (!editInvoice || !pendingInvoiceAction) return;

    try {
      setSavingEdit(true);

      // eSewa uses its existing redirect-based flow after confirmation
      if (pendingInvoiceAction.kind === "esewa-payment") {
        const paymentIntent = await initiateEsewaPaymentApi({
          invoiceId: editInvoice.id,
          amount: pendingInvoiceAction.amount,
        });

        setPendingInvoiceAction(null);
        submitEsewaForm(paymentIntent);
        return;
      }

      // cancellations keep their own endpoint because they reverse stock and mark the invoice as cancelled
      if (pendingInvoiceAction.kind === "cancel-invoice") {
        await cancelInvoiceApi(editInvoice.id);
        await refreshInvoiceState(editInvoice.id);
        closeEditInvoice();
        return;
      }

      // both cash actions reuse the same payment endpoint and differ only in which amount was confirmed
      await addPaymentApi(editInvoice.id, {
        method: "CASH",
        amount: pendingInvoiceAction.amount,
        status: "SUCCESS",
      });

      await refreshInvoiceState(editInvoice.id);
      closeEditInvoice();
    } catch (error: any) {
      const fallbackMessage =
        pendingInvoiceAction.kind === "mark-paid"
          ? "Failed to mark invoice as paid."
          : pendingInvoiceAction.kind === "cancel-invoice"
            ? "Failed to cancel invoice."
            : "Failed to update invoice.";

      setPendingInvoiceAction(null);
      setPaymentError(error?.response?.data?.error || fallbackMessage);
    } finally {
      setSavingEdit(false);
    }
  }

  const pendingInvoiceActionConfig = useMemo(() => {
    if (!editInvoice || !pendingInvoiceAction) return null;

    if (pendingInvoiceAction.kind === "cash-payment") {
      return {
        title: "Add this payment?",
        message:
          "This cash payment will be recorded immediately on the selected invoice.",
        confirmLabel: "Add Payment",
        tone: "primary" as const,
        icon: "payments",
        details: (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span>Invoice</span>
              <span className="font-extrabold text-slate-900">
                {editInvoice.invoiceNo}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Customer</span>
              <span className="font-extrabold text-slate-900">
                {editInvoice.customerName}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Amount to add</span>
              <span className="font-extrabold text-slate-900">
                {formatNpr(pendingInvoiceAction.amount)}
              </span>
            </div>
          </div>
        ),
      };
    }

    if (pendingInvoiceAction.kind === "esewa-payment") {
      return {
        title: "Continue to eSewa?",
        message:
          "KhataSathi will create a pending payment and redirect you to the eSewa payment page.",
        confirmLabel: "Continue to eSewa",
        tone: "primary" as const,
        icon: "payments",
        details: (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span>Invoice</span>
              <span className="font-extrabold text-slate-900">
                {editInvoice.invoiceNo}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Customer</span>
              <span className="font-extrabold text-slate-900">
                {editInvoice.customerName}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>eSewa amount</span>
              <span className="font-extrabold text-slate-900">
                {formatNpr(pendingInvoiceAction.amount)}
              </span>
            </div>
          </div>
        ),
      };
    }

    if (pendingInvoiceAction.kind === "mark-paid") {
      return {
        title: "Mark this invoice fully paid?",
        message:
          "The full remaining due will be recorded as a successful cash payment.",
        confirmLabel: "Mark Fully Paid",
        tone: "primary" as const,
        icon: "check_circle",
        details: (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span>Invoice</span>
              <span className="font-extrabold text-slate-900">
                {editInvoice.invoiceNo}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Remaining due</span>
              <span className="font-extrabold text-slate-900">
                {formatNpr(pendingInvoiceAction.amount)}
              </span>
            </div>
          </div>
        ),
      };
    }

    return {
      title: "Cancel this invoice?",
      message:
        "This will cancel the invoice, restore the sold stock, and keep the payment history for audit review.",
      confirmLabel: "Cancel Invoice",
      tone: "danger" as const,
      icon: "warning",
      details: (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span>Invoice</span>
            <span className="font-extrabold text-slate-900">
              {editInvoice.invoiceNo}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Net total</span>
            <span className="font-extrabold text-slate-900">
              {formatNpr(editInvoice.netTotal)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Paid / Due</span>
            <span className="font-extrabold text-slate-900">
              {formatNpr(editInvoice.paidAmount)} /{" "}
              {formatNpr(editInvoice.dueAmount)}
            </span>
          </div>
        </div>
      ),
    };
  }, [editInvoice, pendingInvoiceAction]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-[#8C8889] font-semibold">Loading invoices...</div>
      </div>
    );
  }

  return (
    <div className="w-full">
      {/* we keep the date line separate from the cards so the page opens with a quick sense of "today" before the heavier data blocks */}
      <div className="text-[13px] text-[#8C8889] font-bold">
        {new Date().toLocaleDateString(undefined, {
          weekday: "long",
          day: "2-digit",
          month: "long",
          year: "numeric",
        })}
      </div>

      {/* these summary cards give a quick invoice health overview before the user starts filtering the table */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-7 gap-4 mt-4">
        <div className="bg-[#FFFFFF] rounded-2xl border border-[#CFCFD3] p-5 ">
          <div className="text-[11px] font-extrabold text-[#8C8889] uppercase ">
            Total Sales
          </div>
          <div className="text-2xl font-extrabold text-[#000000] mt-1">
            {formatNpr(summary.totalSales)}
          </div>
        </div>

        <div className="bg-[#FFFFFF] rounded-2xl border border-[#CFCFD3] p-5 ">
          <div className="text-[11px] font-extrabold text-[#8C8889] uppercase ">
            Invoices Generated
          </div>
          <div className="text-2xl font-extrabold text-[#000000] mt-1">
            {summary.generated}
          </div>
        </div>

        <div className="rounded-2xl border border-[#CFCFD3] bg-[#FFFFFF] p-5 ">
          <div className="text-[11px] font-extrabold text-[#8C8889] uppercase ">
            Paid Invoices
          </div>
          <div className="text-2xl font-extrabold text-[#179B4D] mt-1">
            {summary.paid}
          </div>
        </div>

        <div className="rounded-2xl border border-[#CFCFD3] bg-[#FFFFFF] p-5 ">
          <div className="text-[11px] font-extrabold text-[#B7791F] uppercase ">
            Partial Invoices
          </div>
          <div className="text-2xl font-extrabold text-[#B7791F] mt-1">
            {summary.partial}
          </div>
        </div>

        <div className="rounded-2xl border border-[#CFCFD3] bg-[#FFFFFF] p-5 ">
          <div className="text-[11px] font-extrabold text-rose-700 uppercase ">
            Unpaid Invoices
          </div>
          <div className="text-2xl font-extrabold text-rose-700 mt-1">
            {summary.unpaid}
          </div>
        </div>

        <div className="rounded-2xl border border-[#CFCFD3] bg-[#FFFFFF] p-5 ">
          <div className="text-[11px] font-extrabold text-slate-500 uppercase ">
            Cancelled Invoices
          </div>
          <div className="text-2xl font-extrabold text-slate-900 mt-1">
            {summary.cancelled}
          </div>
        </div>

        <div className="bg-[#FFFFFF] rounded-2xl border border-[#CFCFD3] p-5 ">
          <div className="text-[11px] font-extrabold text-[#8C8889] uppercase ">
            Outstanding Due
          </div>
          <div className="text-2xl font-extrabold text-[#000000] mt-1">
            {formatNpr(summary.outstandingDue)}
          </div>
        </div>
      </div>

      {/* this filter card keeps tabs and search together because both change the same invoice list below */}
      <div className="mt-6 rounded-[20px] border border-[#CFCFD3] bg-[#FFFFFF] p-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-[#8C8889]">
              Browse Invoices
            </div>
            <div className="mt-3 flex items-center gap-2 flex-wrap">
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
                        "px-[16px] py-[8px] rounded-[999px] border-2 text-[12px] font-extrabold transition ",
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
          </div>

          <div className="flex w-full flex-col gap-3 sm:flex-row xl:w-auto xl:min-w-[520px] xl:justify-end">
            <div className="w-full xl:w-[360px]">
              <div className="flex items-center gap-2 rounded-[12px] border-2 border-[#CFCFD3] bg-[#FFFFFF] px-[14px] py-[10px] focus-within:border-[#000000] transition-colors">
                <Icon name="search" className="text-[#8C8889]" />
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(1);
                  }}
                  placeholder="Search invoice no, customer, or item..."
                  className="w-full bg-transparent text-[13px] font-semibold text-[#000000] outline-none placeholder:text-[#8C8889]"
                />
              </div>
            </div>

            <button
              type="button"
              onClick={() => setFilterOpen((value) => !value)}
              className="h-[44px] px-[16px] rounded-[12px] border-2 border-[#CFCFD3] bg-[#FFFFFF] hover:bg-[#CFCFD3] font-extrabold text-[#000000] flex items-center justify-center gap-2 transition sm:self-start"
            >
              <Icon name={isFilterOpen ? "close" : "filter_list"} />
              {isFilterOpen ? "Hide Filters" : "Filter"}
            </button>
          </div>
        </div>

        {isFilterOpen ? (
          <div className="mt-4 rounded-[18px] border border-[#E5E7EB] bg-[#F8FAFC]/80 p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-[#8C8889]">
                  Filter Options
                </div>
                <div className="mt-1 text-[12px] font-medium text-[#8C8889]">
                  Refine the visible invoices using cashier, customer type, and payment method.
                </div>
              </div>

              <button
                type="button"
                onClick={clearExtraFilters}
                disabled={!hasExtraFilters}
                className={cn(
                  "rounded-[12px] border px-[14px] py-[9px] text-[12px] font-extrabold transition",
                  hasExtraFilters
                    ? "border-[#CFCFD3] bg-[#FFFFFF] text-[#000000] hover:bg-[#F3F4F6]"
                    : "cursor-not-allowed border-[#E5E7EB] bg-[#F8FAFC] text-[#94A3B8]",
                )}
              >
                Clear filters
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-12">
              <div className="rounded-[16px] border border-[#CFCFD3] bg-[#FFFFFF] p-4 lg:col-span-4">
                <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                  {isAdminView ? "Cashier" : "Cashier Match"}
                </div>

                {isAdminView ? (
                  <select
                    value={cashierFilter}
                    onChange={(event) => {
                      setCashierFilter(event.target.value);
                      setPage(1);
                    }}
                    className="mt-3 h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-[#FFFFFF] px-3 text-[13px] font-bold text-[#000000] outline-none focus:border-[#000000]"
                  >
                    <option value="All">All cashiers</option>
                    {cashierOptions.map((cashier) => (
                      <option key={cashier.id} value={cashier.id}>
                        {cashier.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <label className="mt-3 flex cursor-pointer items-center gap-3 rounded-[12px] border border-[#CFCFD3] bg-[#FFFFFF] px-3 py-3 text-[13px] font-bold text-[#000000]">
                    <input
                      type="checkbox"
                      checked={onlyMine}
                      onChange={(event) => {
                        setOnlyMine(event.target.checked);
                        setPage(1);
                      }}
                      className="h-4 w-4 accent-[#000000]"
                    />
                    Show only my invoices
                  </label>
                )}
              </div>

              <div className="rounded-[16px] border border-[#CFCFD3] bg-[#FFFFFF] p-4 lg:col-span-4">
                <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                  Customer Type
                </div>
                <div className="mt-3 flex gap-2 flex-wrap">
                  {(["All", "Walk-in", "Registered"] as const).map((type) => {
                    const active = type === customerTypeFilter;
                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() => {
                          setCustomerTypeFilter(type);
                          setPage(1);
                        }}
                        className={cn(
                          "rounded-[12px] border px-[14px] py-[8px] text-[12px] font-extrabold transition",
                          active
                            ? "border-[#000000] bg-[#000000] text-[#FFFFFF]"
                            : "border-[#CFCFD3] bg-[#FFFFFF] text-[#8C8889] hover:bg-[#F3F4F6] hover:text-[#000000]",
                        )}
                      >
                        {type}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-[16px] border border-[#CFCFD3] bg-[#FFFFFF] p-4 lg:col-span-4">
                <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                  Payment Method
                </div>
                <div className="mt-3 flex gap-2 flex-wrap">
                  {(["All", "Cash", "eSewa", "None"] as const).map((method) => {
                    const active = method === methodFilter;
                    return (
                      <button
                        key={method}
                        type="button"
                        onClick={() => {
                          setMethodFilter(method);
                          setPage(1);
                        }}
                        className={cn(
                          "rounded-[12px] border px-[14px] py-[8px] text-[12px] font-extrabold transition",
                          active
                            ? "border-[#000000] bg-[#000000] text-[#FFFFFF]"
                            : "border-[#CFCFD3] bg-[#FFFFFF] text-[#8C8889] hover:bg-[#F3F4F6] hover:text-[#000000]",
                        )}
                      >
                        {method}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* the table uses its own card and horizontal overflow because invoice rows carry a lot of fields on one line */}
      <div className="mt-6 bg-[#FFFFFF] border-2 border-[#CFCFD3] rounded-[20px] overflow-hidden ">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[800px]">
            <thead>
              <tr className="bg-[#CFCFD3]/40 border-b-2 border-[#CFCFD3]">
                <th className="px-5 py-4 text-[11px] font-extrabold text-[#8C8889] uppercase ">
                  Invoice / Date
                </th>
                <th className="px-5 py-4 text-[11px] font-extrabold text-[#8C8889] uppercase ">
                  Customer
                </th>
                <th className="px-5 py-4 text-[11px] font-extrabold text-[#8C8889] uppercase ">
                  Summary
                </th>
                <th className="px-5 py-4 text-[11px] font-extrabold text-[#8C8889] uppercase ">
                  Status & Method
                </th>
                <th className="px-5 py-4 text-[11px] font-extrabold text-[#8C8889] uppercase  text-right">
                  Net Total
                </th>
                <th className="px-5 py-4 text-[11px] font-extrabold text-[#8C8889] uppercase  text-center">
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

                  <td className="px-5 py-4 align-top max-w-[260px]">
                    <div className="inline-flex items-center gap-2 bg-[#CFCFD3]/30 border border-[#CFCFD3] px-3 py-1.5 rounded-[10px] w-full hover:bg-[#CFCFD3]/60 transition-colors">
                      <Icon
                        name="shopping_bag"
                        className="text-[14px] text-[#8C8889] shrink-0"
                      />
                      <span className="text-[12px] font-medium text-[#000000] truncate">
                        {getCompactInvoiceSummary(invoice)}
                      </span>
                    </div>
                  </td>

                  <td className="px-5 py-4 align-top">
                    <div className="flex flex-col items-start gap-2">
                      <div className="flex items-center gap-2">
                        <InvoiceStatusChip status={invoice.status} />
                        <PaymentMethodChip
                          method={invoice.paymentMethod}
                          showIcon
                        />
                      </div>

                      {invoice.status !== "Paid" &&
                        invoice.status !== "Cancelled" &&
                        invoice.dueAmount > 0 && (
                          <div className="text-[11px] font-extrabold text-white bg-rose-600 border border-rose-600 px-2 py-0.5 rounded-md">
                            Due: {formatNpr(invoice.dueAmount)}
                          </div>
                        )}
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

                  <td className="px-5 py-4 align-top text-right">
                    <div className="font-mono font-extrabold text-[#000000] text-[15px]">
                      {formatNpr(invoice.netTotal)}
                    </div>
                  </td>

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

      {pendingInvoiceActionConfig ? (
        <ConfirmDialog
          open={!!pendingInvoiceActionConfig}
          title={pendingInvoiceActionConfig.title}
          message={pendingInvoiceActionConfig.message}
          confirmLabel={pendingInvoiceActionConfig.confirmLabel}
          onConfirm={confirmPendingInvoiceAction}
          onClose={() => setPendingInvoiceAction(null)}
          tone={pendingInvoiceActionConfig.tone}
          icon={pendingInvoiceActionConfig.icon}
          details={pendingInvoiceActionConfig.details}
          busy={savingEdit}
        />
      ) : null}
    </div>
  );
}
