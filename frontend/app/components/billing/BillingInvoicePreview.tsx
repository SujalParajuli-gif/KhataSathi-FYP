import { useEffect, useState } from "react";
import InvoiceDetailModal from "~/components/invoices/InvoiceDetailModal";
import { getInvoiceApi } from "~/lib/api/endpoints";
import { normalizeInvoice } from "~/lib/invoices";
import { formatBillingMoney } from "~/lib/billingWorkspace";

// Read-only preview; the caller retains its workspace, selection and return focus.
export default function BillingInvoicePreview({ invoiceId, onClose }: { invoiceId: string | null; onClose: () => void }) {
  const [result, setResult] = useState<{ id: string; invoice?: ReturnType<typeof normalizeInvoice>; error?: string } | null>(null);
  useEffect(() => {
    if (!invoiceId) { setResult(null); return; }
    let live = true;
    setResult(null);
    getInvoiceApi(invoiceId)
      .then(value => { if (live) setResult({ id: invoiceId, invoice: normalizeInvoice(value.invoice || value) }); })
      .catch(error => { if (live) setResult({ id: invoiceId, error: error?.message || "Could not load invoice details." }); });
    return () => { live = false; };
  }, [invoiceId]);
  const current = result?.id === invoiceId ? result : null;
  return <InvoiceDetailModal formatMoney={formatBillingMoney} open={Boolean(invoiceId)} invoice={current?.invoice || null}
    loading={Boolean(invoiceId) && !current} error={current?.error || null} onClose={onClose} />;
}
