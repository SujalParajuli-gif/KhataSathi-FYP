import { formatBillingMoney } from "~/lib/billingWorkspace";
import React from "react";
import Icon from "~/components/ui/Icon";
import type { CustomerProductPurchaseHistoryItem } from "~/lib/api/endpoints";


interface CartLineSummary {
  productId: string;
  name: string;
  unitPrice: number;
}

interface BillingCompactCartHistoryProps {
  selectedCustomerName?: string | null;
  selectedCustomerId?: string | null;
  cartItems: CartLineSummary[];
  historyItems: CustomerProductPurchaseHistoryItem[];
  loading: boolean;
  error?: string | null;
  onOpenDetailedHistory: () => void;
  onOpenInvoice: (id: string) => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}

export default function BillingCompactCartHistory({
  selectedCustomerName,
  selectedCustomerId,
  cartItems,
  historyItems,
  loading,
  error,
  onOpenDetailedHistory,
  onOpenInvoice,
}: BillingCompactCartHistoryProps) {
  // Map of product ID to cart price for quick comparison
  const cartPriceMap = new Map<string, number>();
  cartItems.forEach((it) => cartPriceMap.set(it.productId, it.unitPrice));

  // Determine which history items have a price difference from current cart
  const itemsWithDiff = historyItems.filter(h => cartPriceMap.has(h.productId)).map((h) => {
    const currentPrice = cartPriceMap.get(h.productId);
    const hasDiff = currentPrice !== undefined && currentPrice !== h.appliedUnitPrice;
    return {
      ...h,
      currentPrice,
      hasDiff,
    };
  }).sort((a, b) => Number(b.hasDiff) - Number(a.hasDiff) || Date.parse(b.invoiceDate || "1970-01-01") - Date.parse(a.invoiceDate || "1970-01-01"));

  return (
    <div className="billing-compact-history">
      {/* Header matching mockup: "Cart Item History" + "View All Cart History →" */}
      <div className="border-b border-line bg-white px-3 py-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[14px] font-semibold text-ink">Cart Item History</h3>
          <button
            type="button"
            onClick={onOpenDetailedHistory}
            className="flex items-center gap-1 text-[12px] font-medium text-blue-600 hover:text-blue-800 hover:underline transition"
          >
            <span>View All Cart History</span>
            <Icon name="arrow_forward" className="text-[13px]" />
          </button>
        </div>
        <p className="mt-0.5 text-[12px] text-muted">
          History for selected customer and products currently in cart.
        </p>
      </div>

      {/* Table Body */}
      <div className="billing-history-preview">
        {!selectedCustomerId ? (
          <div className="py-3 text-center text-[12px] text-muted">
            Select a customer to view past prices paid for cart items.
          </div>
        ) : cartItems.length === 0 ? (
          <div className="py-3 text-center text-[12px] text-muted">
            Cart is empty. Add products to see past purchase prices.
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center py-3 gap-2 text-muted text-[12px]">
            <Icon name="refresh" className="animate-spin text-[16px] text-muted" />
            <span>Checking past purchases…</span>
          </div>
        ) : error ? (
          <div className="p-2.5 text-center text-[12px] font-medium text-rose-700 bg-rose-50">
            {error}
          </div>
        ) : itemsWithDiff.length === 0 ? (
          <div className="py-3 text-center text-[12px] text-muted">
            No past purchases recorded for items currently in cart.
          </div>
        ) : (
          <div>{itemsWithDiff.map(item => <div key={item.id} className={`billing-history-preview-row ${item.hasDiff ? "bg-amber-50" : ""}`}>
            <span className="billing-history-name">{item.productName}{item.hasDiff && <span className="ml-2 text-xs text-amber-800">Differ</span>}</span>
            <span className="text-right whitespace-nowrap">{formatBillingMoney(item.appliedUnitPrice)}</span>
            <small>{item.invoiceDate ? new Date(item.invoiceDate).toLocaleDateString("en-GB",{timeZone:"Asia/Kathmandu"}) : "Date unavailable"} · Qty {item.qty}</small>
            {item.invoiceId ? <button type="button" onClick={() => onOpenInvoice(item.invoiceId)} className="text-right text-xs">{item.invoiceNo || "View invoice"}</button> : <small>Reference unavailable</small>}
          </div>)}</div>
        )}
      </div>
    </div>
  );
}
