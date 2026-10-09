import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import BrandLogo from "~/components/ui/BrandLogo";
import Icon from "~/components/ui/Icon";
import { getBusinessSettingsApi, getInvoiceApi } from "~/lib/api/endpoints";
import { getAuthUser, isLoggedIn } from "~/lib/auth";
import type { AppInvoice, PrintBusinessIdentity } from "~/lib/invoices";
import {
  formatNpr,
  getIdentitySourceLabel,
  getInvoiceReference,
  normalizeInvoice,
  resolvePrintBusinessIdentity,
} from "~/lib/invoices";

// mapping the invoice status to different colors for the print layout
function statusClass(status: AppInvoice["status"]) {
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

function getReceiptHeightMm(
  invoice: AppInvoice,
  businessIdentity?: PrintBusinessIdentity | null,
) {
  let baseMm = 80;

  // Add height for configured business identity details
  if (businessIdentity) {
    if (businessIdentity.legalName) baseMm += 4;
    if (businessIdentity.panNo) baseMm += 4;
    if (businessIdentity.address) {
      baseMm += Math.max(1, Math.ceil(businessIdentity.address.length / 28)) * 4;
    }
    if (businessIdentity.phone) baseMm += 4;
  }

  // Add height for customer provenance, captured PAN, and address
  let customerMm = 10;
  if (invoice.customerPanNo) customerMm += 4;
  if (invoice.customerAddress) {
    customerMm += Math.max(1, Math.ceil(invoice.customerAddress.length / 28)) * 4;
  }

  const itemMm = invoice.items.reduce((sum, item) => {
    const wrappedNameLines = Math.max(1, Math.ceil(item.name.length / 28));
    const provenanceLines = 1;
    const skuLines = item.sku ? Math.max(1, Math.ceil(item.sku.length / 28)) : 0;
    const overrideLines = item.overrideUnitPrice !== undefined ? 1 : 0;
    return sum + 10 + (wrappedNameLines + provenanceLines + skuLines + overrideLines) * 4;
  }, 0);

  const paymentMm = invoice.payments.length > 0 ? 12 + invoice.payments.length * 8 : 0;
  const notesMm = invoice.notes ? 12 + Math.ceil(invoice.notes.length / 30) * 4 : 0;

  return Math.min(1000, Math.max(130, Math.ceil(baseMm + customerMm + itemMm + paymentMm + notesMm)));
}

function ReceiptPrintLayout({
  invoice,
  businessIdentity,
}: {
  invoice: AppInvoice;
  businessIdentity: PrintBusinessIdentity | null;
}) {
  const receiptHeightMm = getReceiptHeightMm(invoice, businessIdentity);
  const business = businessIdentity || resolvePrintBusinessIdentity(null);

  return (
    <div className="mx-auto w-[80mm] max-w-[80mm] bg-white px-[3mm] py-3 font-mono text-[11px] leading-4 text-black break-words [overflow-wrap:anywhere] print:m-0 print:w-[74mm] print:max-w-[74mm] print:p-0">
      <style>{`
        html, body {
          background: #fff !important;
        }
        @media print {
          @page { size: 80mm ${receiptHeightMm}mm; margin: 3mm; }
          html, body, #root {
            width: 74mm !important;
            max-width: 74mm !important;
            min-height: 0 !important;
            margin: 0 !important;
            padding: 0 !important;
            background: #fff !important;
          }
        }
      `}</style>
      <div className="text-center min-w-0">
        <BrandLogo className="mx-auto h-9 w-[150px]" />
        <div className="mt-1 text-[12px] font-black uppercase tracking-wide">
          INTERNAL SALES WORKSHEET
        </div>
        <div className="text-[10px] font-bold text-slate-700">
          NOT A TAX INVOICE
        </div>
        <div className="mt-2 text-[13px] font-black break-words [overflow-wrap:anywhere]">{business.displayName}</div>
        {business.legalName ? (
          <div className="text-[10px] break-words [overflow-wrap:anywhere] text-slate-700">{business.legalName}</div>
        ) : null}
        {business.address ? (
          <div className="text-[10px] break-words [overflow-wrap:anywhere]">{business.address}</div>
        ) : null}
        {business.phone ? (
          <div className="text-[10px]">Tel: {business.phone}</div>
        ) : null}
        {business.panNo ? (
          <div className="text-[10px] font-semibold">Business PAN: {business.panNo}</div>
        ) : null}
        <div className="text-[9px] text-slate-500">(Current business details)</div>
      </div>

      <div className="my-2 border-t border-dashed border-black" />

      <div className="space-y-1 min-w-0">
        <div className="flex justify-between gap-2 min-w-0">
          <span className="shrink-0">Sale Ref</span>
          <span className="text-right font-bold break-all min-w-0">{invoice.invoiceNo}</span>
        </div>
        <div className="flex justify-between gap-2 min-w-0">
          <span className="shrink-0">Date</span>
          <span className="text-right min-w-0">{invoice.createdDateLabel} {invoice.createdTimeLabel}</span>
        </div>
        <div className="flex justify-between gap-2 min-w-0">
          <span className="shrink-0">Cashier</span>
          <span className="text-right min-w-0 break-words [overflow-wrap:anywhere]">{invoice.cashierName}</span>
        </div>
        <div className="flex justify-between gap-2 min-w-0">
          <span className="shrink-0">Customer</span>
          <span className="text-right font-bold break-words [overflow-wrap:anywhere] min-w-0">{invoice.customerName}</span>
        </div>
        <div className="flex justify-between gap-2 text-[10px] text-slate-600 min-w-0">
          <span className="shrink-0">Cust. Identity</span>
          <span className="text-right break-words [overflow-wrap:anywhere] min-w-0">[{getIdentitySourceLabel(invoice.customerIdentitySource)}]</span>
        </div>
        {invoice.customerPanNo ? (
          <div className="flex justify-between gap-2 min-w-0">
            <span className="shrink-0">Customer PAN</span>
            <span className="text-right font-bold min-w-0">{invoice.customerPanNo}</span>
          </div>
        ) : null}
        {invoice.customerAddress ? (
          <div className="flex justify-between gap-2 text-[10px] min-w-0">
            <span className="shrink-0">Cust. Address</span>
            <span className="text-right break-words [overflow-wrap:anywhere] min-w-0">{invoice.customerAddress}</span>
          </div>
        ) : null}
        <div className="flex justify-between gap-2 min-w-0">
          <span className="shrink-0">Status</span>
          <span className="text-right font-bold min-w-0">{invoice.status}</span>
        </div>
      </div>

      <div className="my-2 border-t border-dashed border-black" />

      <div className="space-y-2 min-w-0">
        {invoice.items.map((item) => (
          <div key={item.id} className="min-w-0">
            <div className="break-words [overflow-wrap:anywhere] font-bold">{item.name}</div>
            <div className="text-[10px] text-slate-600 break-words [overflow-wrap:anywhere]">
              [{getIdentitySourceLabel(item.identitySource)}]
            </div>
            {item.sku ? <div className="text-[10px] break-all [overflow-wrap:anywhere]">SKU: {item.sku}</div> : null}
            <div className="flex justify-between gap-2 min-w-0">
              <span className="min-w-0">
                {formatReceiptQty(item.qty)} x {formatNpr(item.unitPrice)}
                {item.overrideUnitPrice !== undefined ? " *" : ""}
              </span>
              <span className="font-bold shrink-0">{formatNpr(item.lineTotal)}</span>
            </div>
            {item.overrideUnitPrice !== undefined ? (
              <div className="text-[10px]">* price override</div>
            ) : null}
          </div>
        ))}
      </div>

      <div className="my-2 border-t border-dashed border-black" />

      <div className="space-y-1 min-w-0">
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
          <div className="space-y-1 min-w-0">
            <div className="font-black">Payments</div>
            {invoice.payments.map((payment) => (
              <div key={payment.id} className="min-w-0">
                <div className="flex justify-between gap-2 min-w-0">
                  <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                    {payment.kind === "REFUND" ? "Refund " : ""}
                    {payment.method}
                  </span>
                  <span className="shrink-0">{formatNpr(payment.amount)}</span>
                </div>
                {payment.cashTendered !== undefined ? (
                  <div className="text-[10px] break-words [overflow-wrap:anywhere]">
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
          <div className="min-w-0">
            <div className="font-black">Note</div>
            <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{invoice.notes}</div>
          </div>
        </>
      ) : null}

      <div className="my-2 border-t border-dashed border-black" />
      <div className="pb-3 text-center text-[10px] font-bold">
        Internal Record — Not a Tax Invoice
      </div>
    </div>
  );
}

// standalone printable invoice page — designed for internal sales worksheet printing
export default function InvoicePrintPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const printMode = searchParams.get("mode") === "receipt" ? "receipt" : "a4";
  const printTargetRef = useRef<string | null>(null);
  const currentPrintKey = `${id || ""}:${printMode}`;
  const [invoice, setInvoice] = useState<AppInvoice | null>(null);
  const [businessIdentity, setBusinessIdentity] = useState<PrintBusinessIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let active = true;
    setIsReady(false);
    printTargetRef.current = null;

    async function loadData() {
      if (!id) {
        if (active) {
          setError("Invoice not found.");
          setLoading(false);
        }
        return;
      }

      setLoading(true);
      setError("");

      try {
        // Parallel fetch for invoice and business settings
        const [invoiceData, settingsData] = await Promise.all([
          getInvoiceApi(id),
          getBusinessSettingsApi().catch(() => null),
        ]);

        if (!active) return;

        const normalized = normalizeInvoice(invoiceData);
        const resolvedBusiness = resolvePrintBusinessIdentity(settingsData);

        setInvoice(normalized);
        setBusinessIdentity(resolvedBusiness);
        setIsReady(true);
      } catch {
        if (!active) return;
        setInvoice(null);
        setBusinessIdentity(null);
        setError("Failed to load invoice for printing.");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    loadData();

    return () => {
      active = false;
    };
  }, [id]);

  // triggers the browser's native print dialog automatically once invoice and settings are settled for the active ID and mode
  useEffect(() => {
    if (!isReady || !invoice || !id) return;
    if (printTargetRef.current === currentPrintKey) return;

    const timer = window.setTimeout(() => {
      printTargetRef.current = currentPrintKey;
      window.print();
    }, 150);

    return () => {
      window.clearTimeout(timer);
    };
  }, [isReady, invoice, id, currentPrintKey]);

  // requiring the user to be logged in to view invoices
  if (!isLoggedIn() || !getAuthUser()) {
    return <Navigate to="/login" replace />;
  }

  const business = businessIdentity || resolvePrintBusinessIdentity(null);

  if (printMode === "receipt") {
    return (
      <div className="min-h-screen bg-white p-4 text-black print:min-h-0 print:w-[74mm] print:max-w-[74mm] print:p-0 print:m-0">
        <div className="mb-4 flex items-center justify-between gap-3 rounded-[18px] border border-slate-200 bg-white px-4 py-3 text-slate-900 print:hidden">
          <div>
            <div className="text-[12px] font-extrabold uppercase text-slate-500">
              Print Worksheet Receipt
            </div>
            <div className="mt-1 text-[16px] font-extrabold">
              {invoice?.invoiceNo || "Loading..."}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.print()}
              disabled={!isReady || loading || !!error}
              className="flex h-[40px] items-center justify-center gap-2 rounded-[12px] bg-slate-900 px-3 text-[12px] font-extrabold text-white hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
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
          <ReceiptPrintLayout invoice={invoice} businessIdentity={businessIdentity} />
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 p-6 text-slate-900 print:bg-white print:p-0">
      <div className="mx-auto max-w-4xl rounded-[24px] border border-slate-200 bg-white print:max-w-none print:rounded-none print:border-0">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-6 py-4 print:hidden">
          <div>
            <div className="text-[12px] font-extrabold uppercase text-slate-500">
              Print Internal Sales Worksheet
            </div>
            <div className="mt-1 text-[18px] font-extrabold text-slate-900">
              {invoice?.invoiceNo || "Loading..."}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.print()}
              disabled={!isReady || loading || !!error}
              className="flex h-[42px] items-center justify-center gap-2 rounded-[14px] bg-slate-900 px-4 text-[13px] font-extrabold text-white hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
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
            <div className="flex items-start justify-between gap-6 border-b border-slate-200 pb-6 min-w-0">
              <div className="min-w-0 max-w-[55%]">
                <BrandLogo className="h-12 w-[220px] max-w-full" />
                <div className="mt-4 text-[20px] font-black uppercase tracking-wide text-slate-900">
                  INTERNAL SALES WORKSHEET
                </div>
                <div className="text-[12px] font-bold text-rose-600">
                  NOT A TAX INVOICE
                </div>

                <div className="mt-3 text-[13px] leading-6 text-slate-700 min-w-0">
                  <div className="text-[15px] font-extrabold text-slate-900 break-words [overflow-wrap:anywhere]">
                    {business.displayName}
                  </div>
                  {business.legalName ? (
                    <div className="text-[12px] text-slate-600 break-words [overflow-wrap:anywhere]">
                      Legal Name: <span className="font-semibold text-slate-800">{business.legalName}</span>
                    </div>
                  ) : null}
                  {business.address ? (
                    <div className="text-[12px] text-slate-600 break-words [overflow-wrap:anywhere]">
                      Address: <span className="font-semibold text-slate-800">{business.address}</span>
                    </div>
                  ) : null}
                  {business.phone ? (
                    <div className="text-[12px] text-slate-600">
                      Phone: <span className="font-semibold text-slate-800">{business.phone}</span>
                    </div>
                  ) : null}
                  {business.panNo ? (
                    <div className="text-[12px] text-slate-600">
                      Business PAN: <span className="font-bold text-slate-900">{business.panNo}</span>
                    </div>
                  ) : null}
                  <div className="text-[11px] text-slate-400 italic">
                    (Current business configuration)
                  </div>
                </div>
              </div>

              <div className="min-w-0 max-w-[45%] text-right">
                <div
                  className={`inline-flex rounded-full border px-3 py-1 text-[11px] font-extrabold ${statusClass(
                    invoice.status,
                  )}`}
                >
                  {invoice.status.toUpperCase()}
                </div>
                <div className="mt-3 text-[13px] leading-6 text-slate-600 min-w-0">
                  Sale Ref: <span className="font-bold text-slate-900 break-all">{invoice.invoiceNo}</span>
                  <br />
                  Date:{" "}
                  <span className="font-semibold text-slate-800">
                    {invoice.createdDateLabel} {invoice.createdTimeLabel}
                  </span>
                  <br />
                  Cashier: <span className="font-semibold text-slate-800 break-words [overflow-wrap:anywhere]">{invoice.cashierName}</span>
                </div>

                <div className="mt-4 border-t border-slate-100 pt-3 text-[13px] leading-5 text-slate-600 min-w-0">
                  <div>
                    Customer: <span className="font-bold text-slate-900 break-words [overflow-wrap:anywhere]">{invoice.customerName}</span>
                  </div>
                  <div className="text-[11px] font-medium text-slate-500 break-words [overflow-wrap:anywhere]">
                    Identity: [{getIdentitySourceLabel(invoice.customerIdentitySource)}]
                  </div>
                  {invoice.customerPanNo ? (
                    <div className="mt-1 text-[12px]">
                      Customer PAN: <span className="font-bold text-slate-900">{invoice.customerPanNo}</span>
                    </div>
                  ) : null}
                  {invoice.customerAddress ? (
                    <div className="mt-1 text-[12px] break-words [overflow-wrap:anywhere]">
                      Address: <span className="font-semibold text-slate-800">{invoice.customerAddress}</span>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="mt-6 overflow-hidden rounded-[18px] border border-slate-200">
              <table className="w-full table-fixed">
                <colgroup>
                  <col className="w-[45%]" />
                  <col className="w-[15%]" />
                  <col className="w-[20%]" />
                  <col className="w-[20%]" />
                </colgroup>
                <thead>
                  <tr className="bg-slate-50 text-left text-[11px] font-extrabold uppercase text-slate-500">
                    <th className="px-4 py-3">Item</th>
                    <th className="px-4 py-3 text-right">Qty</th>
                    <th className="px-4 py-3 text-right">Unit Price</th>
                    <th className="px-4 py-3 text-right">Line Total</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.items.map((item) => (
                    <tr key={item.id} className="border-t border-slate-100 text-[13px]">
                      <td className="px-4 py-3 min-w-0 break-words [overflow-wrap:anywhere]">
                        <div className="font-semibold text-slate-900 break-words [overflow-wrap:anywhere]">{item.name}</div>
                        <div className="text-[11px] text-slate-500 break-words [overflow-wrap:anywhere]">
                          [{getIdentitySourceLabel(item.identitySource)}]
                        </div>
                        {item.sku ? (
                          <div className="mt-0.5 text-[11px] text-slate-500 break-all [overflow-wrap:anywhere]">SKU: {item.sku}</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-slate-700 whitespace-nowrap">
                        {item.qty}
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-semibold text-slate-700 whitespace-nowrap">
                        {formatNpr(item.unitPrice)}
                        {item.overrideUnitPrice !== undefined ? (
                          <div className="mt-1 text-[10px] font-bold text-amber-700">
                            Override
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-extrabold text-slate-900 whitespace-nowrap">
                        {formatNpr(item.lineTotal)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-[380px_260px]">
              <div className="rounded-[18px] border border-slate-200 p-4 min-w-0">
                <div className="text-[12px] font-extrabold uppercase text-slate-500">
                  Payment Details
                </div>
                <div className="mt-3 space-y-3">
                  <div className="flex justify-between text-[13px] min-w-0">
                    <span className="font-bold text-slate-500">Method</span>
                    <span className="font-semibold text-slate-900">{invoice.paymentMethod}</span>
                  </div>
                  <div className="flex justify-between text-[13px] min-w-0">
                    <span className="font-bold text-slate-500">Reference</span>
                    <span className="font-semibold text-slate-900 break-all">
                      {getInvoiceReference(invoice) || "-"}
                    </span>
                  </div>
                  <div className="flex justify-between text-[13px] min-w-0">
                    <span className="font-bold text-slate-500">Payments Recorded</span>
                    <span className="font-semibold text-slate-900">{invoice.payments.length}</span>
                  </div>
                </div>

                {invoice.payments.length > 0 ? (
                  <div className="mt-4 overflow-hidden rounded-[14px] border border-slate-200">
                    <table className="w-full">
                      <thead>
                        <tr className="bg-slate-50 text-left text-[10px] font-extrabold uppercase text-slate-500">
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
                  <div className="mt-4 rounded-[14px] border border-slate-200 bg-slate-50 p-3 min-w-0">
                    <div className="text-[11px] font-extrabold uppercase text-slate-500">
                      Note
                    </div>
                    <div className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[12px] font-semibold leading-5 text-slate-700">
                      {invoice.notes}
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="rounded-[18px] border border-slate-200 bg-slate-50 p-4">
                <div className="text-[12px] font-extrabold uppercase text-slate-500">
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
