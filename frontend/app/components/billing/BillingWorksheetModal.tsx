import React from "react";
import { ModalFrame } from "~/components/ui/Modal";
import Icon from "~/components/ui/Icon";

export type WorksheetLineItem = {
  productId: string;
  name: string;
  sku?: string | null;
  saleUnit?: string;
  qty: number;
  appliedUnitPrice: number;
  lineTotal: number;
  overrideUnitPrice?: number;
  overrideReason?: string;
};

export type WorksheetCustomer = {
  id?: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  panNo?: string | null;
  address?: string | null;
  loyaltyPercent?: number | null;
  wholesalePercent?: number | null;
} | null;

interface BillingWorksheetModalProps {
  open: boolean;
  onClose: () => void;
  onContinueToPayment: () => void;
  onOpenCustomerHistory?: () => void;
  items: WorksheetLineItem[];
  customer: WorksheetCustomer;
  subTotal: number;
  discountPercent: number;
  discountAmount: number;
  payableTotal: number;
  formatNpr: (n: number) => string;
  formatQtyWithUnit: (qty: number, unit?: string) => string;
}

export default function BillingWorksheetModal({
  open,
  onClose,
  onContinueToPayment,
  onOpenCustomerHistory,
  items,
  customer,
  subTotal,
  discountPercent,
  discountAmount,
  payableTotal,
  formatNpr,
  formatQtyWithUnit,
}: BillingWorksheetModalProps) {
  const isWalkIn = !customer || !customer.id;
  const totalQty = items.reduce((sum, item) => sum + item.qty, 0);

  return (
    <ModalFrame
      open={open}
      title="Sales Worksheet"
      description="Provisional line-item summary for customer review before final payment."
      onClose={onClose}
      maxWidthClass="max-w-[840px]"
      mobileFullScreen={true}
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={onClose}
            className="flex h-[42px] items-center justify-center gap-2 rounded-xl border border-[#CFCFD3] bg-white px-5 text-[13px] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6]"
          >
            <Icon name="arrow_back" className="text-[18px]" />
            <span>Back to Cart</span>
          </button>
          <button
            type="button"
            onClick={onContinueToPayment}
            className="flex h-[42px] items-center justify-center gap-2 rounded-xl bg-[#11120d] px-6 text-[13px] font-extrabold text-white transition hover:bg-black"
          >
            <span>Continue to Payment</span>
            <Icon name="arrow_forward" className="text-[18px]" />
          </button>
        </div>
      }
    >
      <div className="space-y-4 text-left">
        {/* Provisional Banner */}
        <div className="rounded-xl border border-amber-300 bg-amber-50/80 p-3 text-amber-950">
          <div className="flex items-center gap-2 font-extrabold text-[12px] tracking-wide uppercase text-amber-800">
            <Icon name="info" className="text-[16px] text-amber-600" />
            <span>Internal Sales Worksheet &bull; Provisional &bull; Not a Tax Invoice</span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-amber-900/90">
            This provisional worksheet is for cashier-customer pricing reference only. It does not reserve inventory, calculate government tax, or constitute a legal tax bill.
          </p>
        </div>

        {/* Customer Identity Context */}
        <div className="rounded-xl border border-[#DADDE3] bg-[#F8FAFC] p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-[#565449]">
                Customer Information
              </div>
              <div className="mt-0.5 flex items-center gap-2">
                <span className="text-[15px] font-extrabold text-[#11120d]">
                  {customer?.name || "Walk-in Customer"}
                </span>
                {customer?.phone && (
                  <span className="text-[12px] font-medium text-[#565449]">
                    ({customer.phone})
                  </span>
                )}
                {!isWalkIn && customer?.loyaltyPercent && customer.loyaltyPercent > 0 ? (
                  <span className="rounded-md bg-purple-100 px-1.5 py-0.5 text-[10px] font-bold text-purple-800">
                    Loyalty {customer.loyaltyPercent}%
                  </span>
                ) : null}
                {!isWalkIn && customer?.wholesalePercent && customer.wholesalePercent > 0 ? (
                  <span className="rounded-md bg-blue-100 px-1.5 py-0.5 text-[10px] font-bold text-blue-800">
                    Wholesale {customer.wholesalePercent}%
                  </span>
                ) : null}
              </div>
            </div>

            {!isWalkIn && onOpenCustomerHistory && (
              <button
                type="button"
                onClick={onOpenCustomerHistory}
                className="flex items-center gap-1.5 rounded-lg border border-[#CFCFD3] bg-white px-2.5 py-1 text-[11px] font-bold text-[#565449] hover:bg-slate-100"
              >
                <Icon name="history" className="text-[14px]" />
                <span>Customer History</span>
              </button>
            )}
          </div>

          <div className="mt-2 grid grid-cols-1 gap-2 border-t border-[#E2E8F0] pt-2 text-[12px] sm:grid-cols-2">
            <div>
              <span className="font-bold text-[#565449]">PAN / Tax ID: </span>
              <span className="font-mono text-[#11120d]">
                {customer?.panNo || (isWalkIn ? "Not recorded" : "Not set")}
              </span>
            </div>
            <div>
              <span className="font-bold text-[#565449]">Billing Address: </span>
              <span className="text-[#11120d]">
                {customer?.address || (isWalkIn ? "Not recorded" : "Not set")}
              </span>
            </div>
          </div>
        </div>

        {/* Line Items Table */}
        <div className="overflow-hidden rounded-xl border border-[#DADDE3] bg-white">
          <div className="max-h-[320px] overflow-y-auto">
            <table className="w-full text-left text-[12px]">
              <thead className="sticky top-0 border-b border-[#DADDE3] bg-[#F1F5F9] font-extrabold text-[#565449]">
                <tr>
                  <th className="px-3 py-2 text-center w-[40px]">#</th>
                  <th className="px-3 py-2">Item Description</th>
                  <th className="px-3 py-2 text-right">Quantity</th>
                  <th className="px-3 py-2 text-right">Unit Price</th>
                  <th className="px-3 py-2 text-right">Line Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E2E8F0]">
                {items.map((item, index) => (
                  <tr key={item.productId} className="hover:bg-slate-50">
                    <td className="px-3 py-2 text-center font-mono text-[#8C8889]">
                      {index + 1}
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-bold text-[#11120d]">{item.name}</div>
                      {item.sku && (
                        <div className="text-[10px] font-mono text-[#565449]">
                          SKU: {item.sku}
                        </div>
                      )}
                      {item.overrideUnitPrice !== undefined && (
                        <div className="text-[10px] text-amber-700 font-semibold">
                          Custom price applied: {formatNpr(item.appliedUnitPrice)}
                          {item.overrideReason ? ` (${item.overrideReason})` : ""}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-[#11120d]">
                      {formatQtyWithUnit(item.qty, item.saleUnit)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[#11120d]">
                      {formatNpr(item.appliedUnitPrice)}
                    </td>
                    <td className="px-3 py-2 text-right font-bold text-[#11120d]">
                      {formatNpr(item.lineTotal)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Totals Summary */}
        <div className="rounded-xl border border-[#DADDE3] bg-[#F8FAFC] p-3.5">
          <div className="space-y-1.5 text-[13px]">
            <div className="flex justify-between text-[#565449]">
              <span>Total Items / Quantity:</span>
              <span className="font-bold text-[#11120d]">
                {items.length} item(s) &bull; {totalQty} unit(s)
              </span>
            </div>
            <div className="flex justify-between text-[#565449]">
              <span>Subtotal:</span>
              <span className="font-bold text-[#11120d]">{formatNpr(subTotal)}</span>
            </div>
            {discountAmount > 0 && (
              <div className="flex justify-between text-emerald-700">
                <span>Discount ({discountPercent}%):</span>
                <span className="font-bold">- {formatNpr(discountAmount)}</span>
              </div>
            )}
            <div className="flex justify-between border-t border-[#CBD5E1] pt-2 text-[16px] font-extrabold text-[#11120d]">
              <span>Estimated Payable:</span>
              <span className="text-[#11120d]">{formatNpr(payableTotal)}</span>
            </div>
          </div>
        </div>
      </div>
    </ModalFrame>
  );
}
