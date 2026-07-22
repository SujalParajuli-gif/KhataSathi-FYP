import React from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  InvoiceStatusChip,
  PaymentMethodChip,
} from "~/components/invoices/InvoiceChips";
import Icon from "~/components/ui/Icon";
import { useBodyScrollLock } from "~/hooks/useBodyScrollLock";
import type { AppInvoice } from "~/lib/invoices";
import {
  formatNpr,
  openInvoicePrint,
  openInvoiceReceiptPrint,
} from "~/lib/invoices";

type Props = {
  open: boolean;
  invoice: AppInvoice | null;
  onClose: () => void;
  // extra actions to show in the summary section (e.g., Pay / Cancel buttons for unpaid invoices)
  extraActions?: ReactNode;
  // optional callback for voiding a payment — only shown when provided (admin-only feature)
  onVoidPayment?: (paymentId: string) => void;
  // the payment currently being voided — shows a loading state on that specific button
  voidingPaymentId?: string | null;
};

// the main invoice detail modal — handles showing everything about a specific invoice
// shows customer info, line items, payment breakdown, cancellation details if any, and overall totals
export default function InvoiceDetailModal({
  open,
  invoice,
  onClose,
  extraActions,
  onVoidPayment,
  voidingPaymentId,
}: Props) {
  useBodyScrollLock(open);

  if (!open || !invoice || typeof document === "undefined") return null;

  const totalUnits = invoice.items.reduce((sum, item) => sum + item.qty, 0);

  return createPortal(
    <div className="fixed inset-0 z-[80]">
      {/* modal backdrop — click to close */}
      <button
        type="button"
        className="absolute inset-0 bg-[rgba(0,0,0,0.3)] backdrop-blur-sm"
        onClick={onClose}
        aria-label="Close"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Invoice ${invoice.invoiceNo}`}
        className="absolute left-1/2 top-1/2 flex max-h-[90vh] w-[1120px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[20px] border border-[#DADDE3] bg-[#FFFFFF] shadow-xl"
      >
        {/* modal header — shows invoice number, customer name, and status */}
        <div className="flex items-start justify-between gap-[12px] border-b border-[#E5E7EB] p-4">
          <div>
            <div className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-[#64748B]">
              Invoice
            </div>
            <div className="text-[18px] font-extrabold text-[#000000]">
              {invoice.invoiceNo}
            </div>
            <div className="mt-[4px] text-[12px] text-[#8C8889]">
              Cashier: <span className="font-bold">{invoice.cashierName}</span> |{" "}
              <span className="font-bold">
                {invoice.createdDateLabel} {invoice.createdTimeLabel}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-[8px]">
            <InvoiceStatusChip status={invoice.status} />
            <button
              type="button"
              onClick={onClose}
              className="flex h-[38px] w-[38px] items-center justify-center rounded-[12px] border border-[#CFCFD3] bg-[#FFFFFF] text-[#000000] transition hover:bg-[#F3F4F6]"
              aria-label="Close"
            >
              <Icon name="close" />
            </button>
          </div>
        </div>

        {/* modal body — grid split into left (items, payments) and right (summary) columns */}
        <div className="grid gap-3 border-b border-[#E5E7EB] bg-[#FFFFFF] p-3 md:grid-cols-3">
          <div className="flex items-center gap-3 rounded-[14px] border border-[#DADDE3] bg-[#F8FAFC] p-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] bg-[#EFF6FF] text-[#2F67D8]">
              <Icon name="shopping_cart" />
            </div>
            <div>
              <div className="text-[13px] font-extrabold text-[#000000]">
                {invoice.items.length} line(s)
              </div>
              <div className="text-[12px] font-bold text-[#8C8889]">
                Total qty: {totalUnits}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-[14px] border border-[#DADDE3] bg-[#F8FAFC] p-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] bg-[#FFFFFF] text-[#2F67D8]">
              <Icon name="person" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-[13px] font-extrabold text-[#000000]">
                {invoice.customerName}
              </div>
              <div className="truncate text-[12px] font-bold text-[#8C8889]">
                {invoice.customerSubtitle}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-[14px] border border-[#2F67D8] bg-[#EFF6FF] p-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#2F67D8] text-white">
              <span className="text-[12px] font-extrabold">Rs.</span>
            </div>
            <div>
              <div className="text-[12px] font-extrabold text-[#565449]">
                Net total
              </div>
              <div className="font-mono text-[18px] font-extrabold text-[#2F67D8]">
                {formatNpr(invoice.netTotal)}
              </div>
            </div>
          </div>
        </div>

        <div className="grid max-h-[calc(90vh-188px)] grid-cols-12 gap-4 overflow-y-auto bg-[#FFFFFF] p-4">
          {/* left column */}
          <div className="col-span-12 space-y-3 xl:col-span-8">
            {/* items table */}
            <div className="overflow-hidden rounded-[16px] border border-[#DADDE3]">
              <div className="flex items-center justify-between border-b border-[#DADDE3] bg-[#F8FAFC] px-[16px] py-[12px]">
                <div className="text-[12px] font-extrabold uppercase  text-[#565449]">
                  Items
                </div>
                <div className="text-[12px] font-bold text-[#8C8889]">
                  {invoice.items.length} line(s)
                </div>
              </div>

              <div className="p-2">
                {invoice.items.length === 0 ? (
                  <div className="px-[12px] py-[20px] text-[13px] text-[#8C8889]">
                    No items recorded for this invoice.
                  </div>
                ) : (
                  invoice.items.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-3 rounded-[12px] px-3 py-3 transition hover:bg-[#F3F4F6]"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-bold text-[#000000]">
                          {item.name}
                        </div>
                        <div className="mt-[2px] text-[11px] text-[#8C8889]">
                          {formatNpr(item.unitPrice)} / unit
                        </div>
                        {item.overrideUnitPrice !== undefined ? (
                          <div className="mt-1 inline-flex max-w-full items-center gap-1 rounded-[8px] border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] font-extrabold text-amber-700">
                            <span>Price override</span>
                            {item.originalUnitPrice !== undefined ? (
                              <span className="font-mono">
                                from {formatNpr(item.originalUnitPrice)}
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                        {item.overrideReason ? (
                          <div className="mt-1 max-w-[260px] truncate text-[10px] font-semibold text-[#8C8889]">
                            Reason: {item.overrideReason}
                          </div>
                        ) : null}
                      </div>

                      <div className="flex shrink-0 items-center gap-[12px]">
                        <div className="rounded-[10px] border border-[#CFCFD3] bg-[#F3F4F6] px-[8px] py-[4px] text-[12px] font-extrabold text-[#565449]">
                          x{item.qty}
                        </div>
                        <div className="font-mono font-extrabold text-[#000000]">
                          {formatNpr(item.lineTotal)}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* brief payment summary block */}
            <div className="rounded-[16px] border border-[#DADDE3] bg-[#FFFFFF] p-3 shadow-sm">
              <div className="flex items-center justify-between text-[13px]">
                <span className="font-bold text-[#8C8889]">Payment summary</span>
                <PaymentMethodChip method={invoice.paymentMethod} showIcon />
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
                <div className="rounded-[14px] border border-[#DADDE3] bg-[#F8FAFC] p-3">
                  <div className="font-bold text-[#8C8889]">Paid</div>
                  <div className="mt-[4px] font-mono font-extrabold text-[#000000]">
                    {formatNpr(invoice.paidAmount)}
                  </div>
                </div>
                <div className="rounded-[14px] border border-[#DADDE3] bg-[#F8FAFC] p-3">
                  <div className="font-bold text-[#8C8889]">Due</div>
                  <div className="mt-[4px] font-mono font-extrabold text-[#000000]">
                    {formatNpr(invoice.dueAmount)}
                  </div>
                </div>
                <div className="rounded-[14px] border border-[#DADDE3] bg-[#F8FAFC] p-3">
                  <div className="font-bold text-[#8C8889]">Status</div>
                  <div className="mt-[8px]">
                    <InvoiceStatusChip status={invoice.status} />
                  </div>
                </div>
              </div>
            </div>

            {/* cancellation details — only shown if the invoice status is Cancelled */}
            {invoice.status === "Cancelled" ? (
              <div className="rounded-[16px] border border-rose-200 bg-rose-50 p-[16px]">
                <div className="text-[12px] font-extrabold uppercase text-rose-700">
                  Cancellation Details
                </div>
                <div className="mt-[12px] grid grid-cols-1 gap-[12px] md:grid-cols-3">
                  <div>
                    <div className="font-bold text-rose-700">Cancelled by</div>
                    <div className="mt-[4px] font-extrabold text-[#000000]">
                      {invoice.cancelledByName || "Unknown user"}
                    </div>
                  </div>
                  <div>
                    <div className="font-bold text-rose-700">Role</div>
                    <div className="mt-[4px] font-extrabold text-[#000000]">
                      {invoice.cancelledByRole || "Unknown"}
                    </div>
                  </div>
                  <div>
                    <div className="font-bold text-rose-700">Cancelled at</div>
                    <div className="mt-[4px] font-semibold text-[#000000]">
                      {invoice.cancelledAt
                        ? new Date(invoice.cancelledAt).toLocaleString()
                        : "Not recorded"}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {invoice.creditNotes.length > 0 ? (
              <div className="overflow-hidden rounded-[16px] border border-[#F6D28B] bg-[#FFFFFF] shadow-sm">
                <div className="flex items-center justify-between border-b border-[#F6D28B] bg-[#FFF7E8] px-[16px] py-[12px]">
                  <div className="text-[12px] font-extrabold uppercase text-[#565449]">
                    Credit note history
                  </div>
                  <div className="text-[12px] font-bold text-[#8C8889]">
                    {invoice.creditNotes.length} note(s)
                  </div>
                </div>

                <div className="divide-y divide-[#E5E7EB]">
                  {invoice.creditNotes.map((note) => (
                    <div key={note.id} className="space-y-[10px] px-[16px] py-[12px]">
                      <div className="flex flex-wrap items-center justify-between gap-[8px]">
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-extrabold text-[#000000]">
                            {note.creditNoteNo}
                          </div>
                          <div className="mt-[2px] text-[11px] font-semibold text-[#8C8889]">
                            {note.direction === "ORIGINAL"
                              ? `Replaced by ${note.replacementInvoiceNo || "-"}`
                              : `Created from ${note.originalInvoiceNo || "-"}`}
                          </div>
                        </div>
                        <div className="rounded-[999px] border border-[#F6D28B] bg-[#FFFFFF] px-[10px] py-[4px] text-[10px] font-extrabold uppercase text-[#B7791F]">
                          {note.direction === "ORIGINAL" ? "Original" : "Replacement"}
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-[8px] text-[12px] sm:grid-cols-2">
                        <div className="flex items-center justify-between gap-[8px]">
                          <span className="font-bold text-[#8C8889]">Original paid</span>
                          <span className="font-mono font-extrabold text-[#000000]">
                            {formatNpr(note.originalPaidTotal)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-[8px]">
                          <span className="font-bold text-[#8C8889]">Credit transferred</span>
                          <span className="font-mono font-extrabold text-[#000000]">
                            {formatNpr(note.creditedAmount)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-[8px]">
                          <span className="font-bold text-[#8C8889]">Replacement total</span>
                          <span className="font-mono font-extrabold text-[#000000]">
                            {formatNpr(note.replacementNetTotal)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-[8px]">
                          <span className="font-bold text-[#8C8889]">Customer credit</span>
                          <span className="font-mono font-extrabold text-[#179B4D]">
                            {formatNpr(note.customerCreditAmount)}
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-[8px] text-[11px] font-semibold text-[#8C8889]">
                        <span>{note.reason || "Invoice modified"}</span>
                        <span>
                          {note.createdByName || "System"} |{" "}
                          {new Date(note.createdAt).toLocaleString()}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* payment history list */}
            <div className="overflow-hidden rounded-[16px] border border-[#DADDE3]">
              <div className="flex items-center justify-between border-b border-[#DADDE3] bg-[#F8FAFC] px-[16px] py-[12px]">
                <div className="text-[12px] font-extrabold uppercase  text-[#565449]">
                  Payment breakdown
                </div>
                <div className="text-[12px] font-bold text-[#8C8889]">
                  {invoice.payments.length} payment(s)
                </div>
              </div>

              <div className="divide-y divide-[#E5E7EB]">
                {invoice.payments.length === 0 ? (
                  <div className="px-[16px] py-[20px] text-[13px] text-[#8C8889]">
                    No payments recorded.
                  </div>
                ) : (
                  invoice.payments.map((payment) => (
                    <div
                      key={payment.id}
                    className="grid grid-cols-1 gap-3 px-4 py-3 text-[12px] md:grid-cols-[minmax(220px,1fr)_130px_110px_minmax(150px,1fr)]"
                    >
                      <div>
                        <div className="font-bold text-[#000000]">
                          <PaymentMethodChip method={payment.method} showIcon />
                        </div>
                        {payment.kind === "REFUND" ? (
                          <div
                            className={`mt-[6px] inline-flex rounded-[8px] border px-[8px] py-[2px] text-[10px] font-extrabold uppercase ${
                              payment.amount < 0
                                ? "border-[#FECDD3] bg-[#FFF1F2] text-[#BE123C]"
                                : "border-[#9DD8B2] bg-[#EAF8EF] text-[#179B4D]"
                            }`}
                          >
                            {payment.amount < 0 ? "Refund payout" : "Refund reversal"}
                          </div>
                        ) : null}
                        <div className="mt-[4px] text-[#8C8889]">
                          {payment.createdByName || "System"} |{" "}
                          {new Date(payment.createdAt).toLocaleString()}
                        </div>
                      </div>
                      <div>
                        <div className="font-bold text-[#8C8889]">Amount</div>
                        <div
                          className={`mt-[4px] font-mono font-extrabold ${
                            payment.kind === "REFUND"
                              ? payment.amount < 0
                                ? "text-[#BE123C]"
                                : "text-[#179B4D]"
                              : "text-[#000000]"
                          }`}
                        >
                          {formatNpr(payment.amount)}
                        </div>
                        {payment.cashTendered !== undefined ? (
                          <div className="mt-[6px] space-y-1 text-[11px] font-semibold text-[#565449]">
                            <div>
                              Tendered:{" "}
                              <span className="font-mono font-extrabold text-[#000000]">
                                {formatNpr(payment.cashTendered)}
                              </span>
                            </div>
                            <div>
                              Change:{" "}
                              <span className="font-mono font-extrabold text-[#179B4D]">
                                {formatNpr(payment.changeAmount || 0)}
                              </span>
                            </div>
                          </div>
                        ) : null}
                      </div>
                      <div>
                        <div className="font-bold text-[#8C8889]">Status</div>
                        <div className="mt-[4px] font-bold text-[#000000]">
                          {payment.status}
                        </div>
                      </div>
                      <div className="flex items-start justify-between gap-[8px]">
                        <div className="min-w-0">
                          <div className="font-bold text-[#8C8889]">Reference</div>
                          <div className="mt-[4px] break-all font-semibold text-[#000000]">
                            {payment.reference || "-"}
                          </div>
                        </div>
                        {/* void button — only shown for successful, non-voided payments when admin */}
                        {onVoidPayment &&
                          payment.status === "SUCCESS" &&
                          payment.kind !== "REFUND" &&
                          invoice.status !== "Cancelled" ? (
                          <button
                            type="button"
                            disabled={voidingPaymentId === payment.id}
                            onClick={() => onVoidPayment(payment.id)}
                            className="mt-[16px] shrink-0 rounded-[10px] border border-[#FECDD3] bg-[#FFF1F2] px-[10px] py-[4px] text-[11px] font-extrabold text-[#BE123C] transition hover:bg-rose-100 disabled:opacity-50"
                          >
                            {voidingPaymentId === payment.id ? "Voiding..." : "Void"}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* right column — financial summary and actions */}
          <div className="col-span-12 xl:col-span-4">
            <div className="sticky top-0 rounded-[16px] border border-[#DADDE3] bg-[#FFFFFF] p-4 shadow-sm">
              <div className="flex items-center gap-2 text-[12px] font-extrabold uppercase tracking-[0.06em] text-[#565449]">
                <Icon name="receipt_long" className="text-[18px] text-[#2F67D8]" />
                Financial summary
              </div>

              {/* financial totals */}
              <div className="mt-4 space-y-3 text-[13px]">
                <div className="flex justify-between">
                  <span className="font-bold text-[#8C8889]">Subtotal</span>
                  <span className="font-mono font-extrabold text-[#000000]">
                    {formatNpr(invoice.subtotal)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="font-bold text-[#8C8889]">Discount</span>
                  <span className="font-mono font-extrabold text-[#BE123C]">
                    -{formatNpr(invoice.discount)}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-[12px] border border-[#DADDE3] bg-[#F8FAFC] px-3 py-2">
                  <span className="font-extrabold text-[#565449]">Net total</span>
                  <span className="font-mono text-[16px] font-extrabold text-[#000000]">
                    {formatNpr(invoice.netTotal)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="font-bold text-[#8C8889]">Total paid</span>
                  <span className="font-mono font-extrabold text-[#000000]">
                    {formatNpr(invoice.paidAmount)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="font-bold text-[#8C8889]">Remaining due</span>
                  <span className="font-mono font-extrabold text-[#000000]">
                    {formatNpr(invoice.dueAmount)}
                  </span>
                </div>

                <div className="my-[8px] border-t border-dashed border-[#CFCFD3]" />

                {invoice.notes ? (
                  <div className="rounded-[14px] border border-[#DADDE3] bg-[#F8FAFC] p-[12px]">
                    <div className="text-[12px] font-bold text-[#565449]">
                      Invoice note
                    </div>
                    <div className="mt-[6px] whitespace-pre-wrap text-[12px] font-semibold leading-5 text-[#565449]">
                      {invoice.notes}
                    </div>
                  </div>
                ) : null}

                {/* modal action buttons */}
                <div className="mt-[16px] grid grid-cols-1 gap-[12px]">
                  {/* printing triggers the native browser print dialogue for the invoice */}
                  <button
                    type="button"
                    onClick={() => openInvoicePrint(invoice.id)}
                    className="flex h-[44px] items-center justify-center gap-[8px] rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6]"
                  >
                    <Icon name="print" />
                    Print Invoice
                  </button>
                  <button
                    type="button"
                    onClick={() => openInvoiceReceiptPrint(invoice.id)}
                    className="flex h-[44px] items-center justify-center gap-[8px] rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6]"
                  >
                    <Icon name="receipt_long" />
                    Receipt Print
                  </button>
                  {/* dynamically rendering extra actions passed from the parent page */}
                  {extraActions}
                </div>

                <button
                  type="button"
                  onClick={onClose}
                  className="mt-[12px] h-[46px] w-full rounded-[14px] border border-[#11120D] bg-[#11120D] font-extrabold text-[#FFFFFF] transition hover:bg-[#2A2C27]"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
