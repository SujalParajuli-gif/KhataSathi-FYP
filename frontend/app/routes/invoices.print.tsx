import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import BrandLogo from "~/components/ui/BrandLogo";
import Icon from "~/components/ui/Icon";
import { getInvoiceApi } from "~/lib/api/endpoints";
import { getAuthUser, isLoggedIn } from "~/lib/auth";
import type { AppInvoice } from "~/lib/invoices";
import { formatNpr, getInvoiceReference, normalizeInvoice } from "~/lib/invoices";

function statusClass(status: AppInvoice["status"]) {
  if (status === "Paid") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (status === "Partial") return "bg-amber-50 text-amber-800 border-amber-200";
  if (status === "Cancelled") return "bg-slate-100 text-slate-600 border-slate-200";
  return "bg-rose-50 text-rose-700 border-rose-200";
}

export default function InvoicePrintPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const printedRef = useRef(false);
  const [invoice, setInvoice] = useState<AppInvoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadInvoice() {
      if (!id) {
        setError("Invoice not found.");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError("");
      try {
        const data = await getInvoiceApi(id);
        setInvoice(normalizeInvoice(data));
      } catch {
        setInvoice(null);
        setError("Failed to load invoice for printing.");
      } finally {
        setLoading(false);
      }
    }

    loadInvoice();
  }, [id]);

  useEffect(() => {
    if (!invoice || printedRef.current) return;

    printedRef.current = true;
    const timer = window.setTimeout(() => window.print(), 150);
    return () => window.clearTimeout(timer);
  }, [invoice]);

  if (!isLoggedIn() || !getAuthUser()) {
    return <Navigate to="/login" replace />;
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
                  <div className="mt-4 overflow-hidden rounded-[14px] border border-slate-200">
                    <table className="w-full">
                      <thead>
                        <tr className="bg-slate-50 text-left text-[10px] font-extrabold uppercase  text-slate-500">
                          <th className="px-3 py-2">Method</th>
                          <th className="px-3 py-2">Reference</th>
                          <th className="px-3 py-2 text-right">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {invoice.payments.map((payment) => (
                          <tr key={payment.id} className="border-t border-slate-100 text-[12px]">
                            <td className="px-3 py-2 text-slate-700">{payment.method}</td>
                            <td className="px-3 py-2 text-slate-700">
                              {payment.reference || "-"}
                            </td>
                            <td className="px-3 py-2 text-right font-mono font-semibold text-slate-900">
                              {formatNpr(payment.amount)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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

