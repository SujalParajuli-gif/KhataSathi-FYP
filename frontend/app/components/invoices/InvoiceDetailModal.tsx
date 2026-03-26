import type { ReactNode } from "react";
import Icon from "~/components/ui/Icon";
import type { AppInvoice, InvoiceStatusLabel, PaymentMethodLabel } from "~/lib/invoices";
import { formatNpr, openInvoicePrint } from "~/lib/invoices";

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function statusPill(status: InvoiceStatusLabel) {
  const styles: Record<InvoiceStatusLabel, string> = {
    Paid: "bg-emerald-50 text-emerald-700 border-emerald-200",
    Partial: "bg-amber-50 text-amber-800 border-amber-200",
    Unpaid: "bg-rose-50 text-rose-700 border-rose-200",
    Cancelled: "bg-slate-100 text-slate-600 border-slate-200",
  };

  return (
    <span
      className={cn(
        "rounded-full border px-[10px] py-[4px] text-[11px] font-extrabold",
        styles[status],
      )}
    >
      {status.toUpperCase()}
    </span>
  );
}

function methodChip(method: PaymentMethodLabel) {
  const base =
    "inline-flex items-center gap-1.5 rounded-[10px] border px-[8px] py-[4px] text-[11px] font-bold";

  if (method === "Cash") {
    return (
      <span className={cn(base, "border-slate-200 bg-white text-slate-700")}>
        <Icon name="payments" className="text-[14px]" />
        Cash
      </span>
    );
  }

  if (method === "eSewa") {
    return (
      <span className={cn(base, "border-emerald-200 bg-emerald-50 text-emerald-800")}>
        <Icon name="qr_code_2" className="text-[14px]" />
        eSewa
      </span>
    );
  }

  if (method === "Khalti") {
    return (
      <span className={cn(base, "border-indigo-200 bg-indigo-50 text-indigo-700")}>
        <Icon name="account_balance_wallet" className="text-[14px]" />
        Khalti
      </span>
    );
  }

  return (
    <span className={cn(base, "border-slate-200 bg-slate-50 text-slate-500")}>
      <Icon name="block" className="text-[14px]" />
      No Payment
    </span>
  );
}

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
        className="absolute inset-0 bg-black/30"
        onClick={onClose}
        aria-label="Close"
      />

      <div className="absolute left-1/2 top-1/2 max-h-[92vh] w-[980px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[20px] border-2 border-slate-200 bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b-2 border-slate-100 p-5">
          <div>
            <div className="text-[12px] font-bold text-slate-500">Invoice</div>
            <div className="text-[18px] font-extrabold text-slate-900">
              {invoice.invoiceNo} | {invoice.customerName}
            </div>
            <div className="mt-1 text-[12px] text-slate-500">
              Cashier: <span className="font-bold">{invoice.cashierName}</span> |{" "}
              <span className="font-bold">
                {invoice.createdDateLabel} {invoice.createdTimeLabel}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {statusPill(invoice.status)}
            <button
              type="button"
              onClick={onClose}
              className="flex h-[38px] w-[38px] items-center justify-center rounded-[12px] border-2 border-slate-200 bg-white hover:bg-slate-50"
              aria-label="Close"
            >
              <Icon name="close" />
            </button>
          </div>
        </div>

        <div className="grid max-h-[calc(92vh-88px)] grid-cols-12 gap-5 overflow-y-auto p-5">
          <div className="col-span-12 space-y-4 xl:col-span-7">
            <div className="overflow-hidden rounded-[16px] border-2 border-slate-200">
              <div className="flex items-center justify-between border-b-2 border-slate-200 bg-slate-50 px-4 py-3">
                <div className="text-[12px] font-extrabold uppercase tracking-wider text-slate-700">
                  Items
                </div>
                <div className="text-[12px] font-bold text-slate-500">
                  {invoice.items.length} line(s)
                </div>
              </div>

              <div className="p-2">
                {invoice.items.length === 0 ? (
                  <div className="px-3 py-5 text-[13px] text-slate-400">
                    No items recorded for this invoice.
                  </div>
                ) : (
                  invoice.items.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-3 rounded-[12px] px-3 py-2 hover:bg-slate-50"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-bold text-slate-900">{item.name}</div>
                        <div className="mt-0.5 text-[11px] text-slate-500">
                          {formatNpr(item.unitPrice)} / unit
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-3">
                        <div className="rounded-[10px] border border-slate-200 bg-slate-100 px-2 py-1 text-[12px] font-extrabold text-slate-700">
                          x{item.qty}
                        </div>
                        <div className="font-mono font-extrabold text-slate-900">
                          {formatNpr(item.lineTotal)}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-[16px] border-2 border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between text-[13px]">
                <span className="font-bold text-slate-500">Payment summary</span>
                {methodChip(invoice.paymentMethod)}
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
                <div className="rounded-[14px] border border-slate-200 bg-slate-50 p-3">
                  <div className="font-bold text-slate-500">Paid</div>
                  <div className="mt-1 font-mono font-extrabold text-slate-900">
                    {formatNpr(invoice.paidAmount)}
                  </div>
                </div>
                <div className="rounded-[14px] border border-slate-200 bg-slate-50 p-3">
                  <div className="font-bold text-slate-500">Due</div>
                  <div className="mt-1 font-mono font-extrabold text-slate-900">
                    {formatNpr(invoice.dueAmount)}
                  </div>
                </div>
                <div className="rounded-[14px] border border-slate-200 bg-slate-50 p-3">
                  <div className="font-bold text-slate-500">Status</div>
                  <div className="mt-1">{statusPill(invoice.status)}</div>
                </div>
              </div>
            </div>

            <div className="overflow-hidden rounded-[16px] border-2 border-slate-200">
              <div className="flex items-center justify-between border-b-2 border-slate-200 bg-slate-50 px-4 py-3">
                <div className="text-[12px] font-extrabold uppercase tracking-wider text-slate-700">
                  Payment breakdown
                </div>
                <div className="text-[12px] font-bold text-slate-500">
                  {invoice.payments.length} payment(s)
                </div>
              </div>

              <div className="divide-y divide-slate-100">
                {invoice.payments.length === 0 ? (
                  <div className="px-4 py-5 text-[13px] text-slate-400">
                    No payments recorded.
                  </div>
                ) : (
                  invoice.payments.map((payment) => (
                    <div
                      key={payment.id}
                      className="grid grid-cols-1 gap-3 px-4 py-3 text-[12px] md:grid-cols-[1.3fr_0.8fr_0.9fr_1fr]"
                    >
                      <div>
                        <div className="font-bold text-slate-900">{methodChip(payment.method)}</div>
                        <div className="mt-1 text-slate-500">
                          {payment.createdByName || "System"} |{" "}
                          {new Date(payment.createdAt).toLocaleString()}
                        </div>
                      </div>
                      <div>
                        <div className="font-bold text-slate-500">Amount</div>
                        <div className="mt-1 font-mono font-extrabold text-slate-900">
                          {formatNpr(payment.amount)}
                        </div>
                      </div>
                      <div>
                        <div className="font-bold text-slate-500">Status</div>
                        <div className="mt-1 font-bold text-slate-900">{payment.status}</div>
                      </div>
                      <div>
                        <div className="font-bold text-slate-500">Reference</div>
                        <div className="mt-1 break-all font-semibold text-slate-900">
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
            <div className="rounded-[16px] border-2 border-slate-200 bg-gradient-to-br from-slate-50 to-white p-5">
              <div className="text-[12px] font-extrabold uppercase tracking-wider text-slate-600">
                Summary
              </div>

              <div className="mt-4 space-y-3 text-[13px]">
                <div className="flex justify-between">
                  <span className="font-bold text-slate-500">Subtotal</span>
                  <span className="font-mono font-extrabold text-slate-900">
                    {formatNpr(invoice.subtotal)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="font-bold text-slate-500">Discount</span>
                  <span className="font-mono font-extrabold text-rose-700">
                    -{formatNpr(invoice.discount)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="font-bold text-slate-500">Net total</span>
                  <span className="font-mono font-extrabold text-slate-900">
                    {formatNpr(invoice.netTotal)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="font-bold text-slate-500">Total paid</span>
                  <span className="font-mono font-extrabold text-slate-900">
                    {formatNpr(invoice.paidAmount)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="font-bold text-slate-500">Remaining due</span>
                  <span className="font-mono font-extrabold text-slate-900">
                    {formatNpr(invoice.dueAmount)}
                  </span>
                </div>

                <div className="my-2 border-t border-dashed border-slate-300" />

                <div className="rounded-[14px] border border-slate-200 bg-white p-3">
                  <div className="text-[12px] font-bold text-slate-600">Customer</div>
                  <div className="mt-1 font-extrabold text-slate-900">{invoice.customerName}</div>
                  <div className="mt-1 text-[12px] text-slate-500">
                    {invoice.customerSubtitle}
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-3">
                  <button
                    type="button"
                    onClick={() => openInvoicePrint(invoice.id)}
                    className="flex h-[44px] items-center justify-center gap-2 rounded-[14px] border-2 border-slate-200 bg-white font-extrabold text-slate-700 hover:bg-slate-50"
                  >
                    <Icon name="print" />
                    Print Invoice
                  </button>
                  {extraActions}
                </div>

                <button
                  type="button"
                  onClick={onClose}
                  className="mt-3 h-[46px] w-full rounded-[14px] border border-slate-700 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 font-extrabold text-white hover:from-slate-800 hover:via-slate-700 hover:to-slate-800"
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
