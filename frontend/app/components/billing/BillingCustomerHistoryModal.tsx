import React, { useEffect, useId, useState } from "react";
import { Link } from "react-router";
import { ModalFrame } from "~/components/ui/Modal";
import Icon from "~/components/ui/Icon";
import ProjectSelect from "~/components/ui/ProjectSelect";
import ProjectDateInput from "~/components/ui/ProjectDateInput";
import {
  getCustomerPurchaseHistoryApi,
  type CustomerPurchaseHistoryItem,
  type CustomerPurchaseHistoryState,
} from "~/lib/api/endpoints";
import { formatNpr, getIdentitySourceLabel } from "~/lib/invoices";

interface BillingCustomerHistoryModalProps {
  open: boolean;
  onClose: () => void;
  customerId: string | null;
  customerName?: string | null;
}

const PAGE_SIZE = 15;

function formatNepalDateTime(isoDate?: string | null): { date: string; time: string } {
  if (!isoDate) return { date: "—", time: "" };
  try {
    const d = new Date(isoDate);
    if (isNaN(d.getTime())) return { date: "—", time: "" };
    const date = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kathmandu",
      year: "numeric",
      month: "short",
      day: "2-digit",
    }).format(d);
    const time = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kathmandu",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).format(d);
    return { date, time };
  } catch {
    return { date: "—", time: "" };
  }
}

interface LoadedData {
  contextKey: string;
  items: CustomerPurchaseHistoryItem[];
  total: number;
  totalPages: number;
}

interface LoadedError {
  contextKey: string;
  message: string;
}

function getModalDescription(state: CustomerPurchaseHistoryState): string {
  switch (state) {
    case "all":
      return "All finalized invoice line items (including cancelled and superseded), return context, and external proof references for this customer.";
    case "returned":
      return "Finalized invoice line items with approved returns, return context, and external proof references for this customer.";
    case "cancelled":
      return "Cancelled invoice records, return context, and external proof references for this customer.";
    case "superseded":
      return "Superseded and replaced invoice records, return context, and external proof references for this customer.";
    case "eligible":
    default:
      return "Eligible finalized invoice line items, return context, and external proof references for this customer.";
  }
}

function BillingCustomerHistoryContent({
  customerId,
  customerName,
  onClose,
}: {
  customerId: string;
  customerName?: string | null;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<{ id: string; name: string } | null>(null);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [stateFilter, setStateFilter] = useState<CustomerPurchaseHistoryState>("eligible");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<LoadedData | null>(null);
  const [error, setError] = useState<LoadedError | null>(null);
  const [loading, setLoading] = useState(true);
  const [retryTrigger, setRetryTrigger] = useState(0);

  const searchInputId = useId();
  const stateSelectId = useId();
  const fromDateId = useId();
  const toDateId = useId();

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const targetContextKey = JSON.stringify([
    customerId,
    selectedProduct?.id || null,
    query.trim(),
    fromDate || null,
    toDate || null,
    stateFilter,
    page,
  ]);
  const requestContextKey = JSON.stringify([
    customerId,
    selectedProduct?.id || null,
    debouncedQuery,
    fromDate || null,
    toDate || null,
    stateFilter,
    page,
  ]);
  const isTransitioningQuery = query.trim() !== debouncedQuery;

  // Fetch purchase history bound to current customer, filter and page context
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);

    if (fromDate && toDate && fromDate > toDate) {
      setLoading(false);
      setError({
        contextKey: requestContextKey,
        message: "The 'From' date cannot be after the 'To' date.",
      });
      return;
    }

    getCustomerPurchaseHistoryApi(
      customerId,
      {
        productId: selectedProduct?.id || undefined,
        q: debouncedQuery || undefined,
        from: fromDate || undefined,
        to: toDate || undefined,
        state: stateFilter,
        page,
        pageSize: PAGE_SIZE,
      },
      { signal: controller.signal },
    )
      .then((res) => {
        if (controller.signal.aborted) return;
        setData({
          contextKey: requestContextKey,
          items: res.items || [],
          total: res.total || 0,
          totalPages: res.totalPages || 0,
        });
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted || err?.code === "ERR_CANCELED" || err?.name === "CanceledError") return;
        const status = err?.response?.status;
        let message = "Unable to load customer purchase history. Please check the connection and try again.";
        if (status === 403) {
          message = "Access denied: You do not have permission to view this customer's purchase history.";
        } else if (status === 404) {
          message = "Customer not found or has been removed.";
        } else if (status === 400) {
          message = err?.response?.data?.error || "Invalid query parameters. Please check your filter criteria.";
        }
        setError({
          contextKey: requestContextKey,
          message,
        });
        setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [
    customerId,
    debouncedQuery,
    selectedProduct?.id,
    fromDate,
    toDate,
    stateFilter,
    page,
    retryTrigger,
    requestContextKey,
  ]);

  const isCurrent = data?.contextKey === targetContextKey;
  const isCurrentError = error?.contextKey === targetContextKey;
  const items = isCurrent ? data.items : [];
  const total = isCurrent ? data.total : 0;
  const totalPages = isCurrent ? data.totalPages : 0;
  const activeError = isCurrentError ? error.message : null;
  const showLoading = loading || isTransitioningQuery || (!isCurrent && !activeError);

  const hasActiveFilters = Boolean(
    debouncedQuery ||
    query.trim() ||
    selectedProduct ||
    fromDate ||
    toDate ||
    stateFilter !== "eligible",
  );

  const clearAllFilters = () => {
    setQuery("");
    setDebouncedQuery("");
    setSelectedProduct(null);
    setFromDate("");
    setToDate("");
    setStateFilter("eligible");
    setPage(1);
  };

  const handleProductFilterSelect = (prodId: string, prodName: string) => {
    setSelectedProduct({ id: prodId, name: prodName });
    setQuery("");
    setDebouncedQuery("");
    setPage(1);
  };

  const handleClearProductFilter = () => {
    setSelectedProduct(null);
    setPage(1);
  };

  return (
    <ModalFrame
      open={true}
      title={`Purchase History: ${customerName || "Customer"}`}
      description={getModalDescription(stateFilter)}
      onClose={onClose}
      maxWidthClass="max-w-[1040px]"
      mobileFullScreen={true}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div className="text-[12px] text-[#565449]">
            {total > 0
              ? `Showing ${items.length} of ${total} record(s)${hasActiveFilters ? " (filtered)" : ""}`
              : "No purchase records"}
          </div>
          <div className="flex items-center gap-2">
            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearAllFilters}
                className="min-h-[38px] rounded-xl border border-slate-300 bg-white px-3.5 text-[12px] font-bold text-slate-700 hover:bg-slate-100"
              >
                Reset filters
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="min-h-[38px] rounded-xl border border-[#CFCFD3] bg-white px-5 text-[13px] font-bold text-[#565449] hover:bg-slate-100"
            >
              Close
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-3.5 text-left">
        {/* Filter Toolbar */}
        <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
            {/* Search Input */}
            <div className="min-w-0">
              <label htmlFor={searchInputId} className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-500">
                Search product name
              </label>
              <div className="relative">
                <Icon
                  name="search"
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-slate-400"
                />
                <input
                  id={searchInputId}
                  type="text"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(1);
                  }}
                  placeholder="Search product name..."
                  aria-label="Search product name"
                  className="h-10 w-full rounded-xl border border-[#CFCFD3] bg-white py-1.5 pl-9 pr-9 text-[13px] text-[#11120d] placeholder:text-[#8C8889] focus:border-[#11120d] focus:outline-none focus:ring-1 focus:ring-[#11120d]"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      setDebouncedQuery("");
                      setPage(1);
                    }}
                    className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 hover:text-slate-600"
                    aria-label="Clear product search"
                  >
                    <Icon name="close" sizePx={16} />
                  </button>
                )}
              </div>
            </div>

            {/* State Selector */}
            <div className="min-w-0">
              <label htmlFor={stateSelectId} className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-500">
                Sale state
              </label>
              <ProjectSelect
                id={stateSelectId}
                aria-label="Sale state"
                value={stateFilter}
                onChange={(e) => {
                  setStateFilter(e.target.value as CustomerPurchaseHistoryState);
                  setPage(1);
                }}
                className="h-10 text-[13px]"
              >
                <option value="eligible">Eligible finalized sales (default)</option>
                <option value="all">All finalized sales (including cancelled / replaced)</option>
                <option value="returned">Items with approved returns</option>
                <option value="cancelled">Cancelled invoices</option>
                <option value="superseded">Superseded / replaced invoices</option>
              </ProjectSelect>
            </div>

            {/* From Date */}
            <div className="min-w-0">
              <label htmlFor={fromDateId} className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-500">
                From date
              </label>
              <ProjectDateInput
                id={fromDateId}
                aria-label="From date"
                value={fromDate}
                max={toDate || undefined}
                onChange={(e) => {
                  setFromDate(e.target.value);
                  setPage(1);
                }}
                className="h-10"
                placeholder="From date (Nepal)"
              />
            </div>

            {/* To Date */}
            <div className="min-w-0">
              <label htmlFor={toDateId} className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-500">
                To date
              </label>
              <ProjectDateInput
                id={toDateId}
                aria-label="To date"
                value={toDate}
                min={fromDate || undefined}
                onChange={(e) => {
                  setToDate(e.target.value);
                  setPage(1);
                }}
                className="h-10"
                placeholder="To date (Nepal)"
              />
            </div>
          </div>

          {/* Active Product Filter Pill */}
          {selectedProduct && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-slate-200/80 pt-2 text-[12px]">
              <span className="text-slate-500">Exact product filter:</span>
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1 font-bold text-blue-800">
                <span>{selectedProduct.name}</span>
                <button
                  type="button"
                  onClick={handleClearProductFilter}
                  className="flex h-7 w-7 items-center justify-center rounded hover:bg-blue-100 text-blue-600"
                  aria-label="Remove exact product filter"
                >
                  <Icon name="close" sizePx={14} />
                </button>
              </span>
            </div>
          )}
        </div>

        {/* State Notice when non-eligible state is selected */}
        {stateFilter !== "eligible" && (
          <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-900">
            <Icon name="info" className="mt-0.5 shrink-0 text-[18px] text-amber-600" />
            <p>
              <strong>Notice:</strong> Showing historical records for {stateFilter} status. Cancelled and superseded invoices are historical reference evidence only and do not represent active finalized sales or current pricing.
            </p>
          </div>
        )}

        {/* State / Table display */}
        {activeError ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-5 text-center text-[13px] text-rose-700">
            <Icon name="error" className="mx-auto mb-1 text-[26px] text-rose-600" />
            <p className="font-semibold">{activeError}</p>
            <div className="mt-3 flex justify-center gap-2">
              <button
                type="button"
                onClick={() => setRetryTrigger((r) => r + 1)}
                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-rose-300 bg-white px-3.5 py-1.5 text-[12px] font-bold text-rose-700 hover:bg-rose-100/50"
              >
                <Icon name="refresh" sizePx={15} />
                <span>Retry</span>
              </button>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={clearAllFilters}
                  className="min-h-[36px] rounded-lg border border-slate-300 bg-white px-3.5 py-1.5 text-[12px] font-bold text-slate-700 hover:bg-slate-50"
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>
        ) : showLoading ? (
          <div className="flex flex-col items-center justify-center py-14 text-slate-500">
            <Icon name="refresh" className="animate-spin text-[28px] text-slate-400" />
            <span className="mt-2 text-[13px] font-medium">Loading customer purchase history…</span>
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 py-12 text-center text-slate-500">
            <Icon name="history_toggle_off" className="mx-auto mb-1.5 text-[34px] text-slate-400" />
            <p className="text-[13px] font-semibold text-slate-700">
              {hasActiveFilters
                ? "No past purchases found matching the selected filter criteria."
                : "No eligible finalized purchase history found for this customer."}
            </p>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearAllFilters}
                className="mt-3 inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-slate-300 bg-white px-3.5 py-1.5 text-[12px] font-bold text-slate-700 hover:bg-slate-100"
              >
                <Icon name="restart_alt" sizePx={15} />
                <span>Reset all filters</span>
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-[#DADDE3] bg-white">
            <div className="max-h-[420px] overflow-y-auto overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-[12px]">
                <thead className="sticky top-0 z-10 border-b border-[#DADDE3] bg-[#F1F5F9] font-extrabold text-[#565449]">
                  <tr>
                    <th className="px-3 py-2.5">Date / Invoice</th>
                    <th className="px-3 py-2.5">Product & Identity</th>
                    <th className="px-3 py-2.5 text-right">Sold Qty</th>
                    <th className="px-3 py-2.5 text-right">Unit Price</th>
                    <th className="px-3 py-2.5 text-right">Line Total</th>
                    <th className="px-3 py-2.5">State & Returns</th>
                    <th className="px-3 py-2.5">External Reference & Proof</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E2E8F0]">
                  {items.map((item) => {
                    const lineTotal =
                      item.lineTotal !== undefined
                        ? item.lineTotal
                        : Math.round(item.qty * item.appliedUnitPrice * 100) / 100;
                    const { date: dateFormatted, time: timeFormatted } = formatNepalDateTime(item.invoiceDate);
                    const stateBadge = item.state || (item.isCancelled ? "CANCELLED" : "UNKNOWN");
                    const isProductFiltered = selectedProduct?.id === item.productId;
                    const identitySource = item.displayProduct?.source;

                    return (
                      <tr key={item.id} className="hover:bg-slate-50/80">
                        {/* Date / Invoice */}
                        <td className="px-3 py-2.5 align-top">
                          <div className="text-[11px] font-semibold text-slate-700">{dateFormatted}</div>
                          {timeFormatted && (
                            <div className="text-[10px] text-slate-400">{timeFormatted}</div>
                          )}
                          <div className="mt-1">
                            {item.invoiceId ? (
                              <Link
                                to={`/invoices?invoiceId=${encodeURIComponent(item.invoiceId)}`}
                                className="font-mono text-[12px] font-bold text-blue-600 hover:underline"
                                title={`View invoice ${item.invoiceNo}`}
                              >
                                {item.invoiceNo || "Invoice link"}
                              </Link>
                            ) : (
                              <span className="font-mono text-[12px] font-bold text-slate-700">
                                {item.invoiceNo || "—"}
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Product & Identity */}
                        <td className="px-3 py-2.5 align-top">
                          <div className="font-bold text-[#11120d]">
                            {item.productName}
                          </div>
                          {item.productSku && (
                            <div className="text-[10px] font-mono text-[#565449]">
                              SKU: {item.productSku}
                            </div>
                          )}
                          {identitySource && identitySource !== "CAPTURED" && (
                            <div className="mt-0.5 text-[10px] font-medium text-amber-700">
                              {getIdentitySourceLabel(identitySource)}
                            </div>
                          )}
                          <div className="mt-1">
                            <button
                              type="button"
                              onClick={() => handleProductFilterSelect(item.productId, item.productName)}
                              disabled={isProductFiltered}
                              className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-700 hover:bg-slate-200 active:bg-slate-300 disabled:opacity-40"
                              title="Filter history for this product only"
                            >
                              <Icon name="filter_alt" sizePx={13} />
                              <span>{isProductFiltered ? "Filtered" : "Filter this product"}</span>
                            </button>
                          </div>
                        </td>

                        {/* Sold Qty */}
                        <td className="px-3 py-2.5 text-right align-top font-semibold text-[#11120d]">
                          {item.qty}
                        </td>

                        {/* Unit Price */}
                        <td className="px-3 py-2.5 text-right align-top font-mono text-[#11120d]">
                          <div className="font-bold">{formatNpr(item.appliedUnitPrice)}</div>
                          {item.overrideUnitPrice != null && item.originalUnitPrice != null && (
                            <div className="text-[10px] text-amber-700" title={item.overrideReason || "Price overridden"}>
                              Orig: {formatNpr(item.originalUnitPrice)}
                            </div>
                          )}
                        </td>

                        {/* Line Total */}
                        <td className="px-3 py-2.5 text-right align-top font-bold text-[#11120d]">
                          {formatNpr(lineTotal)}
                        </td>

                        {/* State & Returns */}
                        <td className="px-3 py-2.5 align-top">
                          <div>
                            {stateBadge === "SUPERSEDED" ? (
                              <span className="inline-flex items-center rounded-md bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800">
                                Superseded
                              </span>
                            ) : stateBadge === "CANCELLED" ? (
                              <span className="inline-flex items-center rounded-md bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-800">
                                Cancelled
                              </span>
                            ) : stateBadge === "ELIGIBLE" ? (
                              <span className="inline-flex items-center rounded-md bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800">
                                Eligible
                              </span>
                            ) : (
                              <span className="inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-700">
                                {item.state || "—"}
                              </span>
                            )}
                          </div>

                          {/* Superseded / Replaced Links */}
                          {item.supersededBy && (
                            <div className="mt-1 text-[11px] text-amber-900">
                              <span>CN #{item.supersededBy.creditNoteNo} → </span>
                              {item.supersededBy.replacementInvoiceId ? (
                                <Link
                                  to={`/invoices?invoiceId=${encodeURIComponent(item.supersededBy.replacementInvoiceId)}`}
                                  className="font-bold text-blue-600 underline"
                                >
                                  Invoice #{item.supersededBy.replacementInvoiceNo || item.supersededBy.replacementInvoiceId}
                                </Link>
                              ) : (
                                <span>Replaced</span>
                              )}
                            </div>
                          )}
                          {item.replaces && (
                            <div className="mt-1 text-[11px] text-blue-900">
                              <span>Replaces </span>
                              {item.replaces.originalInvoiceId ? (
                                <Link
                                  to={`/invoices?invoiceId=${encodeURIComponent(item.replaces.originalInvoiceId)}`}
                                  className="font-bold text-blue-600 underline"
                                >
                                  Invoice #{item.replaces.originalInvoiceNo || item.replaces.originalInvoiceId}
                                </Link>
                              ) : null}
                              <span> via CN #{item.replaces.creditNoteNo}</span>
                            </div>
                          )}

                          {/* Returns info */}
                          {item.returnSummary?.hasReturns && (
                            <div className="mt-1.5 space-y-0.5 text-[11px]">
                              {item.returnSummary.approvedQty > 0 && (
                                <div className="font-semibold text-rose-700">
                                  Returned: {item.returnSummary.approvedQty}
                                </div>
                              )}
                              {item.returnSummary.pendingQty > 0 && (
                                <div className="text-amber-700">
                                  Pending return: {item.returnSummary.pendingQty}
                                </div>
                              )}
                              {item.returnSummary.rejectedQty > 0 && (
                                <div className="text-slate-400">
                                  Rejected return: {item.returnSummary.rejectedQty}
                                </div>
                              )}
                              {item.returnSummary.reversedQty > 0 && (
                                <div className="text-slate-400">
                                  Reversed return: {item.returnSummary.reversedQty}
                                </div>
                              )}
                            </div>
                          )}
                        </td>

                        {/* External Reference & Proof */}
                        <td className="px-3 py-2.5 align-top">
                          {item.externalReference?.externalBillNo ? (
                            <div className="space-y-0.5">
                              <div className="font-medium text-slate-900">
                                {item.externalReference.externalDocumentType || "External bill"} #{item.externalReference.externalBillNo}
                              </div>
                              {item.externalReference.externalBillDate && (
                                <div className="text-[10px] text-slate-500">
                                  Date: {item.externalReference.externalBillDate}
                                </div>
                              )}
                              <div>
                                {item.externalReference.isRecorded ? (
                                  <span className="inline-flex rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 border border-emerald-200">
                                    {item.externalReference.billRecordStatus || "RECORDED"}
                                  </span>
                                ) : item.externalReference.billRecordStatus === "MISSING" ? (
                                  <span className="inline-flex rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold text-rose-700 border border-rose-200">
                                    MISSING
                                  </span>
                                ) : (
                                  <span className="inline-flex rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-700 border border-amber-200">
                                    {item.externalReference.billRecordStatus || "PENDING"}
                                  </span>
                                )}
                              </div>
                            </div>
                          ) : item.externalReference?.externalDocumentType || item.externalReference?.billRecordStatus ? (
                            <div className="space-y-0.5">
                              {item.externalReference.externalDocumentType && (
                                <div className="font-medium text-slate-900">
                                  {item.externalReference.externalDocumentType}
                                </div>
                              )}
                              <div>
                                <span className="inline-flex rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-700 border border-amber-200">
                                  {item.externalReference.billRecordStatus || "PENDING"}
                                </span>
                              </div>
                            </div>
                          ) : (
                            <div className="text-[11px] text-slate-400">None recorded</div>
                          )}

                          {/* View Invoice and Proof Link */}
                          {item.invoiceId && (
                            <div className="mt-1.5">
                              <Link
                                to={`/invoices?invoiceId=${encodeURIComponent(item.invoiceId)}`}
                                className="inline-flex min-h-[32px] items-center gap-1 text-[12px] font-semibold text-blue-600 hover:text-blue-800 hover:underline"
                                title="Open invoice details and authorized proof documents"
                              >
                                <Icon name="visibility" sizePx={15} />
                                <span>View invoice and proof</span>
                              </Link>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Pagination Controls */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-slate-200 pt-2.5 text-[12px]">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || showLoading}
              className="flex min-h-[36px] items-center gap-1 rounded-lg border border-[#CFCFD3] px-3.5 py-1.5 font-bold text-[#565449] hover:bg-slate-100 disabled:opacity-40"
            >
              <Icon name="chevron_left" sizePx={16} />
              <span>Previous</span>
            </button>
            <span className="font-medium text-slate-600">
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || showLoading}
              className="flex min-h-[36px] items-center gap-1 rounded-lg border border-[#CFCFD3] px-3.5 py-1.5 font-bold text-[#565449] hover:bg-slate-100 disabled:opacity-40"
            >
              <span>Next</span>
              <Icon name="chevron_right" sizePx={16} />
            </button>
          </div>
        )}
      </div>
    </ModalFrame>
  );
}

export default function BillingCustomerHistoryModal({
  open,
  onClose,
  customerId,
  customerName,
}: BillingCustomerHistoryModalProps) {
  if (!open || !customerId) {
    return null;
  }

  return (
    <BillingCustomerHistoryContent
      key={`${customerId}-${open ? "open" : "closed"}`}
      customerId={customerId}
      customerName={customerName}
      onClose={onClose}
    />
  );
}
