import React, { useEffect, useState } from "react";
import { Link } from "react-router";
import { ModalFrame } from "~/components/ui/Modal";
import Icon from "~/components/ui/Icon";
import {
  getCustomerPurchaseHistoryApi,
  type CustomerProductPurchaseHistoryItem,
} from "~/lib/api/endpoints";
import { formatNpr } from "~/lib/invoices";

interface BillingCustomerHistoryModalProps {
  open: boolean;
  onClose: () => void;
  customerId: string | null;
  customerName?: string | null;
}

const PAGE_SIZE = 15;

export default function BillingCustomerHistoryModal({
  open,
  onClose,
  customerId,
  customerName,
}: BillingCustomerHistoryModalProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<CustomerProductPurchaseHistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounce query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  // Fetch purchase history on customer, debounced query, or page change
  useEffect(() => {
    if (!open || !customerId) {
      setItems([]);
      setTotal(0);
      setTotalPages(0);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    getCustomerPurchaseHistoryApi(
      customerId,
      {
        q: debouncedQuery || undefined,
        page,
        pageSize: PAGE_SIZE,
      },
      { signal: controller.signal },
    )
      .then((res) => {
        if (controller.signal.aborted) return;
        setItems(res.items || []);
        setTotal(res.total || 0);
        setTotalPages(res.totalPages || 0);
        setLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted || err?.code === "ERR_CANCELED") return;
        setItems([]);
        setTotal(0);
        setTotalPages(0);
        setLoading(false);
        const status = err?.response?.status;
        if (status === 403) {
          setError("Access denied: You do not have permission to view this customer's purchase history.");
        } else if (status === 404) {
          setError("Customer not found or has been removed.");
        } else {
          setError("Unable to load customer purchase history. Please check the connection.");
        }
      });

    return () => {
      controller.abort();
    };
  }, [open, customerId, debouncedQuery, page]);

  // Reset state when customer changes, whether modal is open or closed
  useEffect(() => {
    setQuery("");
    setDebouncedQuery("");
    setPage(1);
    setItems([]);
    setTotal(0);
    setTotalPages(0);
    setError(null);
  }, [customerId]);

  // Reset state when closing modal
  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebouncedQuery("");
      setPage(1);
      setError(null);
    }
  }, [open]);

  return (
    <ModalFrame
      open={open}
      title={`Purchase History: ${customerName || "Customer"}`}
      description="All past finalized invoice line items for this customer."
      onClose={onClose}
      maxWidthClass="max-w-[880px]"
      mobileFullScreen={true}
      footer={
        <div className="flex w-full items-center justify-between">
          <div className="text-[12px] text-[#565449]">
            {total > 0
              ? `Showing ${items.length} of ${total} purchase record(s)`
              : "No purchase records"}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-[38px] rounded-xl border border-[#CFCFD3] bg-white px-5 text-[13px] font-bold text-[#565449] hover:bg-slate-100"
          >
            Close
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-left">
        {/* Product Search Bar */}
        <div className="relative">
          <Icon
            name="search"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-slate-400"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search past purchased items by product name..."
            className="w-full rounded-xl border border-[#CFCFD3] bg-white py-2 pl-9 pr-8 text-[13px] text-[#11120d] placeholder:text-[#8C8889] focus:border-[#11120d] focus:outline-none focus:ring-1 focus:ring-[#11120d]"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              aria-label="Clear product search"
            >
              <Icon name="close" className="text-[16px]" />
            </button>
          )}
        </div>

        {/* State / Table display */}
        {error ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-center text-[13px] text-rose-700">
            <Icon name="error" className="mx-auto mb-1 text-[24px] text-rose-600" />
            <p>{error}</p>
          </div>
        ) : loading ? (
          <div className="flex flex-col items-center justify-center py-12 text-slate-500">
            <Icon name="refresh" className="animate-spin text-[28px] text-slate-400" />
            <span className="mt-2 text-[13px]">Loading customer purchase history…</span>
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 py-10 text-center text-slate-500">
            <Icon name="history_toggle_off" className="mx-auto mb-1 text-[32px] text-slate-400" />
            <p className="text-[13px] font-semibold text-slate-700">
              {debouncedQuery
                ? `No past purchases found matching "${debouncedQuery}"`
                : "No finalized purchase history found for this customer."}
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-[#DADDE3] bg-white">
            <div className="max-h-[360px] overflow-y-auto">
              <table className="w-full text-left text-[12px]">
                <thead className="sticky top-0 border-b border-[#DADDE3] bg-[#F1F5F9] font-extrabold text-[#565449]">
                  <tr>
                    <th className="px-3 py-2">Date / Invoice</th>
                    <th className="px-3 py-2">Product Name</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Unit Price</th>
                    <th className="px-3 py-2 text-right">Line Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E2E8F0]">
                  {items.map((item) => {
                    const lineTotal = Math.round(item.qty * item.appliedUnitPrice * 100) / 100;
                    const dateFormatted = item.invoiceDate
                      ? new Date(item.invoiceDate).toLocaleDateString(undefined, {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })
                      : "—";

                    return (
                      <tr key={item.id} className="hover:bg-slate-50">
                        <td className="px-3 py-2">
                          <div className="text-[11px] text-slate-500">{dateFormatted}</div>
                          <Link
                            to={`/invoices?search=${encodeURIComponent(item.invoiceNo)}`}
                            className="font-mono text-[12px] font-bold text-blue-600 hover:underline"
                          >
                            {item.invoiceNo}
                          </Link>
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-bold text-[#11120d]">
                            {item.productName}
                          </div>
                          {item.productSku && (
                            <div className="text-[10px] font-mono text-[#565449]">
                              SKU: {item.productSku}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-medium text-[#11120d]">
                          {item.qty}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-[#11120d]">
                          {formatNpr(item.appliedUnitPrice)}
                        </td>
                        <td className="px-3 py-2 text-right font-bold text-[#11120d]">
                          {formatNpr(lineTotal)}
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
          <div className="flex items-center justify-between border-t border-slate-200 pt-2 text-[12px]">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              className="flex items-center gap-1 rounded-lg border border-[#CFCFD3] px-3 py-1 font-bold text-[#565449] hover:bg-slate-100 disabled:opacity-40"
            >
              <Icon name="chevron_left" className="text-[16px]" />
              <span>Previous</span>
            </button>
            <span className="font-medium text-slate-600">
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
              className="flex items-center gap-1 rounded-lg border border-[#CFCFD3] px-3 py-1 font-bold text-[#565449] hover:bg-slate-100 disabled:opacity-40"
            >
              <span>Next</span>
              <Icon name="chevron_right" className="text-[16px]" />
            </button>
          </div>
        )}
      </div>
    </ModalFrame>
  );
}
