import type { ReactNode } from "react";
import {
  InvoiceStatusChip,
  PaymentMethodChip,
} from "~/components/invoices/InvoiceChips";
import Icon from "~/components/ui/Icon";
import type { AppInvoice } from "~/lib/invoices";
import { formatNpr, openInvoicePrint } from "~/lib/invoices";

export default function InvoiceDetailModal({
  open,
  invoice,
  onClose,
  extraActions,
}: {
  open: boolean;
  invoice: AppInvoice | null;
  onClose: () => void;
  extraActions?: ReactNode;
}) {
  if (!open || !invoice) return null;

  return (
    <div className="fixed inset-0 z-[60]">
      <button
        type="button"
        className="absolute inset-0 bg-[rgba(0,0,0,0.3)]"
        onClick={onClose}
        aria-label="Close"
      />

      <div className="absolute left-1/2 top-1/2 max-h-[92vh] w-[980px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[20px] border-[2px] border-[#CFCFD3] bg-[#FFFFFF] ">
        <div className="flex items-start justify-between gap-[12px] border-b-[2px] border-[#E5E7EB] p-[20px]">
          <div>
            <div className="text-[12px] font-bold text-[#8C8889]">Invoice</div>
            <div className="text-[18px] font-extrabold text-[#000000]">
              {invoice.invoiceNo} | {invoice.customerName}
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
              className="flex h-[38px] w-[38px] items-center justify-center rounded-[12px] border-[2px] border-[#CFCFD3] bg-[#FFFFFF] text-[#000000] transition hover:bg-[#F3F4F6]"
              aria-label="Close"
            >
              <Icon name="close" />
            </button>
          </div>
        </div>

        <div className="grid max-h-[80vh] grid-cols-12 gap-[20px] overflow-y-auto p-[20px]">
          <div className="col-span-12 space-y-[16px] xl:col-span-7">
            <div className="overflow-hidden rounded-[16px] border-[2px] border-[#CFCFD3]">
              <div className="flex items-center justify-between border-b-[2px] border-[#CFCFD3] bg-[#F3F4F6] px-[16px] py-[12px]">
                <div className="text-[12px] font-extrabold uppercase  text-[#565449]">
                  Items
                </div>
                <div className="text-[12px] font-bold text-[#8C8889]">
                  {invoice.items.length} line(s)
                </div>
              </div>

              <div className="p-[8px]">
                {invoice.items.length === 0 ? (
                  <div className="px-[12px] py-[20px] text-[13px] text-[#8C8889]">
                    No items recorded for this invoice.
                  </div>
                ) : (
                  invoice.items.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-[12px] rounded-[12px] px-[12px] py-[8px] transition hover:bg-[#F3F4F6]"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-bold text-[#000000]">
                          {item.name}
                        </div>
                        <div className="mt-[2px] text-[11px] text-[#8C8889]">
                          {formatNpr(item.unitPrice)} / unit
                        </div>
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

            <div className="rounded-[16px] border-[2px] border-[#CFCFD3] bg-[#FFFFFF] p-[16px]">
              <div className="flex items-center justify-between text-[13px]">
                <span className="font-bold text-[#8C8889]">Payment summary</span>
                <PaymentMethodChip method={invoice.paymentMethod} showIcon />
              </div>

              <div className="mt-[12px] grid grid-cols-1 gap-[12px] md:grid-cols-3">
                <div className="rounded-[14px] border border-[#CFCFD3] bg-[#F3F4F6] p-[12px]">
                  <div className="font-bold text-[#8C8889]">Paid</div>
                  <div className="mt-[4px] font-mono font-extrabold text-[#000000]">
                    {formatNpr(invoice.paidAmount)}
                  </div>
                </div>
                <div className="rounded-[14px] border border-[#CFCFD3] bg-[#F3F4F6] p-[12px]">
                  <div className="font-bold text-[#8C8889]">Due</div>
                  <div className="mt-[4px] font-mono font-extrabold text-[#000000]">
                    {formatNpr(invoice.dueAmount)}
                  </div>
                </div>
                <div className="rounded-[14px] border border-[#CFCFD3] bg-[#F3F4F6] p-[12px]">
                  <div className="font-bold text-[#8C8889]">Status</div>
                  <div className="mt-[8px]">
                    <InvoiceStatusChip status={invoice.status} />
                  </div>
                </div>
              </div>
            </div>

            {invoice.status === "Cancelled" ? (
              <div className="rounded-[16px] border-[2px] border-rose-200 bg-rose-50 p-[16px]">
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

            <div className="overflow-hidden rounded-[16px] border-[2px] border-[#CFCFD3]">
              <div className="flex items-center justify-between border-b-[2px] border-[#CFCFD3] bg-[#F3F4F6] px-[16px] py-[12px]">
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
                      className="grid grid-cols-1 gap-[12px] px-[16px] py-[12px] text-[12px] md:grid-cols-[280px_150px_160px_190px]"
                    >
                      <div>
                        <div className="font-bold text-[#000000]">
                          <PaymentMethodChip method={payment.method} showIcon />
                        </div>
                        <div className="mt-[4px] text-[#8C8889]">
                          {payment.createdByName || "System"} |{" "}
                          {new Date(payment.createdAt).toLocaleString()}
                        </div>
                      </div>
                      <div>
                        <div className="font-bold text-[#8C8889]">Amount</div>
                        <div className="mt-[4px] font-mono font-extrabold text-[#000000]">
                          {formatNpr(payment.amount)}
                        </div>
                      </div>
                      <div>
                        <div className="font-bold text-[#8C8889]">Status</div>
                        <div className="mt-[4px] font-bold text-[#000000]">
                          {payment.status}
                        </div>
                      </div>
                      <div>
                        <div className="font-bold text-[#8C8889]">Reference</div>
                        <div className="mt-[4px] break-all font-semibold text-[#000000]">
                          {payment.reference || "-"}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="col-span-12 xl:col-span-5">
            <div className="rounded-[16px] border-[2px] border-[#CFCFD3] bg-[#FFFFFF] p-[20px]">
              <div className="text-[12px] font-extrabold uppercase  text-[#565449]">
                Summary
              </div>

              <div className="mt-[16px] space-y-[12px] text-[13px]">
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
                <div className="flex justify-between">
                  <span className="font-bold text-[#8C8889]">Net total</span>
                  <span className="font-mono font-extrabold text-[#000000]">
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

                <div className="rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] p-[12px]">
                  <div className="text-[12px] font-bold text-[#565449]">
                    Customer
                  </div>
                  <div className="mt-[4px] font-extrabold text-[#000000]">
                    {invoice.customerName}
                  </div>
                  <div className="mt-[4px] text-[12px] text-[#8C8889]">
                    {invoice.customerSubtitle}
                  </div>
                </div>

                <div className="mt-[16px] grid grid-cols-1 gap-[12px]">
                  <button
                    type="button"
                    onClick={() => openInvoicePrint(invoice.id)}
                    className="flex h-[44px] items-center justify-center gap-[8px] rounded-[14px] border-[2px] border-[#CFCFD3] bg-[#FFFFFF] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6]"
                  >
                    <Icon name="print" />
                    Print Invoice
                  </button>
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
    </div>
  );
}

