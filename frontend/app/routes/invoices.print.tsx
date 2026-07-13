import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import BrandLogo from "~/components/ui/BrandLogo";
import Icon from "~/components/ui/Icon";
import { getInvoiceApi } from "~/lib/api/endpoints";
import { getAuthUser, isLoggedIn } from "~/lib/auth";
import type { AppInvoice } from "~/lib/invoices";
import { formatNpr, getInvoiceReference, normalizeInvoice } from "~/lib/invoices";

// mapping the invoice status to different colors for the print layout
function statusClass(status: AppInvoice["status"]) {
  // returning a simple class string here keeps the JSX cleaner when we show the status badge later
  if (status === "Paid") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (status === "Partial") return "bg-amber-50 text-amber-800 border-amber-200";
  if (status === "Cancelled") return "bg-slate-100 text-slate-600 border-slate-200";
  return "bg-rose-50 text-rose-700 border-rose-200";
}

function formatReceiptQty(value: number) {
  return Number.isInteger(value)
    ? value.toLocaleString()
    : value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function getReceiptHeightMm(invoice: AppInvoice) {
  const baseMm = 78;
  const itemMm = invoice.items.reduce((sum, item) => {
    const wrappedNameLines = Math.max(1, Math.ceil(item.name.length / 28));
    return sum + 11 + wrappedNameLines * 4;
  }, 0);
  const paymentMm = invoice.payments.length > 0 ? 10 + invoice.payments.length * 8 : 0;
  const notesMm = invoice.notes ? 12 + Math.ceil(invoice.notes.length / 32) * 4 : 0;
  return Math.min(600, Math.max(120, Math.ceil(baseMm + itemMm + paymentMm + notesMm)));
}

function ReceiptPrintLayout({ invoice }: { invoice: AppInvoice }) {
  const receiptHeightMm = getReceiptHeightMm(invoice);

  return (
    <div className="mx-auto w-[80mm] bg-white px-2 py-3 font-mono text-[11px] leading-4 text-black print:m-0 print:w-[80mm] print:px-1 print:py-0">
      <style>{`
        html, body {
          background: #fff !important;
        }
        @media print {
          @page { size: 80mm ${receiptHeightMm}mm; margin: 3mm; }
          html, body, #root {
            width: 80mm !important;
            min-height: 0 !important;
            margin: 0 !important;
            padding: 0 !important;
            background: #fff !important;
          }
        }
      `}</style>
      <div className="text-center">
        <BrandLogo className="mx-auto h-9 w-[150px]" />
        <div className="mt-2 text-[13px] font-black">KhataSathi</div>
        <div className="text-[10px] font-bold">Retail / Wholesale Receipt</div>
      </div>

      <div className="my-2 border-t border-dashed border-black" />

      <div className="space-y-1">
        <div className="flex justify-between gap-2">
          <span>Invoice</span>
          <span className="text-right font-bold">{invoice.invoiceNo}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span>Date</span>
          <span className="text-right">{invoice.createdDateLabel} {invoice.createdTimeLabel}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span>Cashier</span>
          <span className="text-right">{invoice.cashierName}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span>Customer</span>
          <span className="text-right">{invoice.customerName}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span>Status</span>
          <span className="text-right font-bold">{invoice.status}</span>
        </div>
      </div>

      <div className="my-2 border-t border-dashed border-black" />

      <div className="space-y-2">
        {invoice.items.map((item) => (
          <div key={item.id}>
            <div className="break-words font-bold">{item.name}</div>
            {item.sku ? <div className="text-[10px]">SKU: {item.sku}</div> : null}
            <div className="flex justify-between gap-2">
              <span>
                {formatReceiptQty(item.qty)} x {formatNpr(item.unitPrice)}
                {item.overrideUnitPrice !== undefined ? " *" : ""}
              </span>
              <span className="font-bold">{formatNpr(item.lineTotal)}</span>
            </div>
            {item.overrideUnitPrice !== undefined ? (
              <div className="text-[10px]">* price override</div>
            ) : null}
          </div>
        ))}
      </div>

      <div className="my-2 border-t border-dashed border-black" />

      <div className="space-y-1">
        <div className="flex justify-between">
          <span>Subtotal</span>
          <span>{formatNpr(invoice.subtotal)}</span>
        </div>
        <div className="flex justify-between">
          <span>Discount</span>
          <span>-{formatNpr(invoice.discount)}</span>
        </div>
        <div className="flex justify-between text-[14px] font-black">
          <span>Total</span>
          <span>{formatNpr(invoice.netTotal)}</span>
        </div>
        <div className="flex justify-between">
          <span>Paid</span>
          <span>{formatNpr(invoice.paidAmount)}</span>
        </div>
        <div className="flex justify-between">
          <span>Due</span>
          <span>{formatNpr(invoice.dueAmount)}</span>
        </div>
      </div>

      {invoice.payments.length > 0 ? (
        <>
          <div className="my-2 border-t border-dashed border-black" />
          <div className="space-y-1">
            <div className="font-black">Payments</div>
            {invoice.payments.map((payment) => (
              <div key={payment.id}>
                <div className="flex justify-between gap-2">
                  <span>
                    {payment.kind === "REFUND" ? "Refund " : ""}
                    {payment.method}
                  </span>
                  <span>{formatNpr(payment.amount)}</span>
                </div>
                {payment.cashTendered !== undefined ? (
                  <div className="text-[10px]">
                    Tendered {formatNpr(payment.cashTendered)} | Change{" "}
                    {formatNpr(payment.changeAmount || 0)}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </>
      ) : null}

      {invoice.notes ? (
        <>
          <div className="my-2 border-t border-dashed border-black" />
          <div>
            <div className="font-black">Note</div>
            <div className="whitespace-pre-wrap break-words">{invoice.notes}</div>
          </div>
        </>
      ) : null}

      <div className="my-2 border-t border-dashed border-black" />
      <div className="pb-3 text-center text-[10px] font-bold">
        Thank you for shopping with us.
      </div>
    </div>
  );
}

// standalone printable invoice page — designed to look good on A4 paper
// it uses 'print:' tailwind classes to hide UI buttons when actually printing
export default function InvoicePrintPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const printMode = searchParams.get("mode") === "receipt" ? "receipt" : "a4";
  const printedRef = useRef(false); // stops the automatic print dialog from opening more than once
  const [invoice, setInvoice] = useState<AppInvoice | null>(null); // stores the normalized invoice used by the print layout
  const [loading, setLoading] = useState(true); // tracks the first fetch for the requested invoice
  const [error, setError] = useState(""); // holds a user-facing message when the invoice cannot be loaded

  useEffect(() => {
    // fetching the full invoice data whenever the route id changes
    // we keep this inside the page because the print layout needs the normalized invoice shape before rendering
    async function loadInvoice() {
      // this handles when the route is opened without an invoice id
      // without this guard, the API call would fail with an invalid path
      if (!id) {
        setError("Invoice not found.");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError("");
      try {
        // requesting the invoice again from the backend so the print page always shows fresh detail data
        const data = await getInvoiceApi(id);
        setInvoice(normalizeInvoice(data));
      } catch {
        // this handles when the invoice request fails, like a missing record or a network issue
        setInvoice(null);
        setError("Failed to load invoice for printing.");
      } finally {
        // ending the loading state after either success or failure
        setLoading(false);
      }
    }

    loadInvoice();
  }, [id]);

  // triggers the browser's native print dialog automatically once the invoice finishes loading
  // we add a tiny timeout so React finishes painting the DOM first
  useEffect(() => {
    // this handles when the invoice is not ready yet or we already opened the print dialog once
    if (!invoice || printedRef.current) return;

    printedRef.current = true;
    const timer = window.setTimeout(() => window.print(), 150);
    return () => window.clearTimeout(timer);
  }, [invoice]);

  // requiring the user to be logged in to view invoices
  if (!isLoggedIn() || !getAuthUser()) {
    return <Navigate to="/login" replace />;
  }

  if (printMode === "receipt") {
    return (
      <div className="min-h-screen bg-white p-4 text-black print:min-h-0 print:w-[80mm] print:p-0">
        <div className="mb-4 flex items-center justify-between gap-3 rounded-[18px] border border-slate-200 bg-white px-4 py-3 text-slate-900 print:hidden">
          <div>
            <div className="text-[12px] font-extrabold uppercase text-slate-500">
              Print Receipt
            </div>
            <div className="mt-1 text-[16px] font-extrabold">
              {invoice?.invoiceNo || "Loading..."}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.print()}
              className="flex h-[40px] items-center justify-center gap-2 rounded-[12px] bg-slate-900 px-3 text-[12px] font-extrabold text-white hover:bg-slate-800"
            >
              <Icon name="print" />
              Print
            </button>
            <button
              type="button"
              onClick={() => navigate("/invoices", { replace: true })}
              className="flex h-[40px] items-center justify-center gap-2 rounded-[12px] border-2 border-slate-200 bg-white px-3 text-[12px] font-extrabold text-slate-700 hover:bg-slate-50"
            >
              <Icon name="arrow_back" />
              Back
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex min-h-[220px] items-center justify-center font-semibold text-slate-400 print:hidden">
            Loading invoice...
          </div>
        ) : error || !invoice ? (
          <div className="flex min-h-[220px] items-center justify-center text-center print:hidden">
            <div className="text-[16px] font-extrabold text-slate-900">{error}</div>
          </div>
        ) : (
          <ReceiptPrintLayout invoice={invoice} />
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 p-6 text-slate-900 print:bg-white print:p-0">
      <div className="mx-auto max-w-4xl rounded-[24px] border border-slate-200 bg-white  print:max-w-none print:rounded-none print:border-0 ">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-6 py-4 print:hidden">
          <div>
            <div className="text-[12px] font-extrabold uppercase  text-slate-500">
              Print Invoice
            </div>
            <div className="mt-1 text-[18px] font-extrabold text-slate-900">
              {invoice?.invoiceNo || "Loading..."}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.print()}
              className="flex h-[42px] items-center justify-center gap-2 rounded-[14px] bg-slate-900 px-4 text-[13px] font-extrabold text-white hover:bg-slate-800"
            >
              <Icon name="print" />
              Print
            </button>
            <button
              type="button"
              onClick={() => navigate("/invoices", { replace: true })}
              className="flex h-[42px] items-center justify-center gap-2 rounded-[14px] border-2 border-slate-200 bg-white px-4 text-[13px] font-extrabold text-slate-700 hover:bg-slate-50"
            >
              <Icon name="arrow_back" />
              Back
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex min-h-[60vh] items-center justify-center px-6 py-16">
            <div className="font-semibold text-slate-400">Loading invoice...</div>
          </div>
        ) : error || !invoice ? (
          /* this handles when the invoice could not be loaded, so we show a centered error message instead of empty markup */
          <div className="flex min-h-[60vh] items-center justify-center px-6 py-16">
            <div className="text-center">
              <div className="text-[16px] font-extrabold text-slate-900">{error}</div>
            </div>
          </div>
        ) : (
          <div className="px-6 py-6 print:px-8 print:py-8">
            <div className="flex items-start justify-between gap-6 border-b border-slate-200 pb-6">
              <div>
                <BrandLogo className="h-12 w-[220px] max-w-full" />
                <div className="mt-4 text-[22px] font-extrabold  text-slate-900">
                  Invoice
                </div>
                <div className="mt-2 text-[13px] leading-6 text-slate-500">
                  Invoice No: <span className="font-bold text-slate-700">{invoice.invoiceNo}</span>
                  <br />
                  Date:{" "}
                  <span className="font-bold text-slate-700">
                    {invoice.createdDateLabel} {invoice.createdTimeLabel}
                  </span>
                  <br />
                  Cashier: <span className="font-bold text-slate-700">{invoice.cashierName}</span>
                </div>
              </div>

              <div className="text-right">
                <div
                  className={`inline-flex rounded-full border px-3 py-1 text-[11px] font-extrabold ${statusClass(
                    invoice.status,
                  )}`}
                >
                  {invoice.status.toUpperCase()}
                </div>
                <div className="mt-3 text-[13px] text-slate-500">
                  Customer: <span className="font-bold text-slate-700">{invoice.customerName}</span>
                </div>
                <div className="mt-1 text-[12px] text-slate-500">{invoice.customerSubtitle}</div>
              </div>
            </div>

            <div className="mt-6 overflow-hidden rounded-[18px] border border-slate-200">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 text-left text-[11px] font-extrabold uppercase  text-slate-500">
                    <th className="px-4 py-3">Item</th>
                    <th className="px-4 py-3 text-right">Qty</th>
                    <th className="px-4 py-3 text-right">Unit Price</th>
                    <th className="px-4 py-3 text-right">Line Total</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.items.map((item) => (
                    <tr key={item.id} className="border-t border-slate-100 text-[13px]">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-slate-900">{item.name}</div>
                        {item.sku ? (
                          <div className="mt-1 text-[11px] text-slate-500">SKU: {item.sku}</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-slate-700">
                        {item.qty}
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-semibold text-slate-700">
                        {formatNpr(item.unitPrice)}
                        {item.overrideUnitPrice !== undefined ? (
                          <div className="mt-1 text-[10px] font-bold text-amber-700">
                            Override
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-extrabold text-slate-900">
                        {formatNpr(item.lineTotal)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-[380px_260px]">
              <div className="rounded-[18px] border border-slate-200 p-4">
                <div className="text-[12px] font-extrabold uppercase  text-slate-500">
                  Payment Details
                </div>
                <div className="mt-3 space-y-3">
                  <div className="flex justify-between text-[13px]">
                    <span className="font-bold text-slate-500">Method</span>
                    <span className="font-semibold text-slate-900">{invoice.paymentMethod}</span>
                  </div>
                  <div className="flex justify-between text-[13px]">
                    <span className="font-bold text-slate-500">Reference</span>
                    <span className="font-semibold text-slate-900">
                      {getInvoiceReference(invoice) || "-"}
                    </span>
                  </div>
                  <div className="flex justify-between text-[13px]">
                    <span className="font-bold text-slate-500">Payments Recorded</span>
                    <span className="font-semibold text-slate-900">{invoice.payments.length}</span>
                  </div>
                </div>

                {invoice.payments.length > 0 ? (
                  /* only showing the payment rows when the invoice actually has recorded payments */
                  <div className="mt-4 overflow-hidden rounded-[14px] border border-slate-200">
                    <table className="w-full">
                      <thead>
                        <tr className="bg-slate-50 text-left text-[10px] font-extrabold uppercase  text-slate-500">
                          <th className="px-3 py-2">Method</th>
                          <th className="px-3 py-2">Type / Reference</th>
                          <th className="px-3 py-2 text-right">Amount</th>
                          <th className="px-3 py-2 text-right">Tendered</th>
                          <th className="px-3 py-2 text-right">Change</th>
                        </tr>
                      </thead>
                      <tbody>
                        {invoice.payments.map((payment) => (
                          <tr key={payment.id} className="border-t border-slate-100 text-[12px]">
                            <td className="px-3 py-2 text-slate-700">{payment.method}</td>
                            <td className="px-3 py-2 text-slate-700">
                              {payment.kind === "REFUND" ? (
                                <span className="mr-2 font-extrabold text-rose-700">
                                  Refund
                                </span>
                              ) : null}
                              {payment.reference || "-"}
                            </td>
                            <td
                              className={`px-3 py-2 text-right font-mono font-semibold ${
                                payment.kind === "REFUND"
                                  ? "text-rose-700"
                                  : "text-slate-900"
                              }`}
                            >
                              {formatNpr(payment.amount)}
                            </td>
                            <td className="px-3 py-2 text-right font-mono font-semibold text-slate-900">
                              {payment.cashTendered !== undefined
                                ? formatNpr(payment.cashTendered)
                                : "-"}
                            </td>
                            <td className="px-3 py-2 text-right font-mono font-semibold text-slate-900">
                              {payment.changeAmount !== undefined
                                ? formatNpr(payment.changeAmount)
                                : "-"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}

                {invoice.notes ? (
                  <div className="mt-4 rounded-[14px] border border-slate-200 bg-slate-50 p-3">
                    <div className="text-[11px] font-extrabold uppercase text-slate-500">
                      Note
                    </div>
                    <div className="mt-2 whitespace-pre-wrap text-[12px] font-semibold leading-5 text-slate-700">
                      {invoice.notes}
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="rounded-[18px] border border-slate-200 bg-slate-50 p-4">
                <div className="text-[12px] font-extrabold uppercase  text-slate-500">
                  Summary
                </div>
                <div className="mt-4 space-y-3 text-[13px]">
                  <div className="flex justify-between">
                    <span className="font-bold text-slate-500">Subtotal</span>
                    <span className="font-mono font-semibold text-slate-900">
                      {formatNpr(invoice.subtotal)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-bold text-slate-500">Discount</span>
                    <span className="font-mono font-semibold text-slate-900">
                      -{formatNpr(invoice.discount)}
                    </span>
                  </div>
                  <div className="flex justify-between border-t border-slate-200 pt-3">
                    <span className="font-extrabold text-slate-700">Net Total</span>
                    <span className="font-mono font-extrabold text-slate-900">
                      {formatNpr(invoice.netTotal)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-bold text-slate-500">Paid</span>
                    <span className="font-mono font-semibold text-slate-900">
                      {formatNpr(invoice.paidAmount)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-bold text-slate-500">Due</span>
                    <span className="font-mono font-semibold text-slate-900">
                      {formatNpr(invoice.dueAmount)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

