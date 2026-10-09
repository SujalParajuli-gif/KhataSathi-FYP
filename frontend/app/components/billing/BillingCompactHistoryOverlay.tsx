import React from "react";
import Icon from "~/components/ui/Icon";
import { ModalFrame } from "~/components/ui/Modal";
import type { CustomerProductPurchaseHistoryItem } from "~/lib/api/endpoints";
import { formatNpr } from "~/lib/invoices";

interface BillingCompactHistoryOverlayProps {
  open: boolean;
  onClose: () => void;
  onOpenDetailedHistory: () => void;
  customerName?: string | null;
  historyItems: CustomerProductPurchaseHistoryItem[];
  loading: boolean;
  error: string | null;
  cartItemCount: number;
  anchorRef?: React.RefObject<HTMLElement | null>;
}

export default function BillingCompactHistoryOverlay({
  open,
  onClose,
  onOpenDetailedHistory,
  customerName,
  historyItems,
  loading,
  error,
  cartItemCount,
  anchorRef,
}: BillingCompactHistoryOverlayProps) {
  if (!open) return null;

  return (
    <ModalFrame
      open={open}
      title="Recent Cart Item History"
      description={customerName || "Selected Customer"}
      onClose={onClose}
      maxWidthClass="max-w-[480px]"
      compact={true}
      mobileBottomSheet={true}
      desktopAnchored={true}
      anchorRef={anchorRef}
      footer={
        <div className="flex w-full flex-col sm:flex-row items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenDetailedHistory();
            }}
            className="w-full sm:w-auto flex items-center justify-center gap-1.5 rounded-xl border border-[#CFCFD3] bg-[#F3F4F6] px-3.5 py-2 text-[12px] font-bold text-[#11120D] hover:bg-[#E5E7EB]"
          >
            <Icon name="manage_search" className="text-[16px]" />
            <span>Search All Past Purchases</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="w-full sm:w-auto rounded-xl border border-[#CFCFD3] bg-white px-4 py-2 text-[12px] font-bold text-[#565449] hover:bg-[#F3F4F6]"
          >
            Close
          </button>
        </div>
      }
    >
      <div className="space-y-2">
        {error ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-center text-[12px] font-semibold text-rose-700">
            {error}
          </div>
        ) : loading ? (
          <div className="flex flex-col items-center justify-center py-8 text-[#565449]">
            <Icon name="refresh" className="animate-spin text-[24px] text-[#8C8889]" />
            <span className="mt-1 text-[12px]">Checking past purchases…</span>
          </div>
        ) : cartItemCount === 0 ? (
          <div className="py-6 text-center text-[#565449] text-[12px]">
            Cart is empty. Add products to see past prices paid by this customer.
          </div>
        ) : historyItems.length === 0 ? (
          <div className="py-6 text-center text-[#565449] text-[12px]">
            No past purchases recorded for the items currently in this cart.
          </div>
        ) : (
          <div className="divide-y divide-[#DADDE3] rounded-lg border border-[#DADDE3]">
            {historyItems.map((item) => (
              <div key={item.id} className="p-2.5 hover:bg-[#F8FAFC] text-[12px]">
                <div className="flex items-center justify-between font-bold text-[#11120D]">
                  <span>{item.productName}</span>
                  <span className="font-mono font-extrabold text-[#11120D]">
                    {formatNpr(item.appliedUnitPrice)}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center justify-between text-[11px] text-[#565449]">
                  <span>Qty: {item.qty} &bull; Inv: {item.invoiceNo}</span>
                  <span>
                    {item.invoiceDate
                      ? new Date(item.invoiceDate).toLocaleDateString()
                      : "—"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </ModalFrame>
  );
}
