// type definitions for invoice display labels
export type InvoiceStatusLabel = "Paid" | "Partial" | "Unpaid" | "Cancelled";
export type PaymentMethodLabel = "Cash" | "eSewa" | "None";

// the shape of each item inside an invoice — used for the invoice detail modal
export type InvoiceItemSummary = {
  id: string;
  productId?: string;
  name: string;
  sku?: string;
  barcode?: string;
  qty: number;
  unitPrice: number;
  originalUnitPrice?: number;
  overrideUnitPrice?: number;
  overrideReason?: string;
  overrideByName?: string;
  overrideAt?: string;
  lineTotal: number;
};

// the shape of each payment recorded against an invoice
export type InvoicePaymentSummary = {
  id: string;
  method: PaymentMethodLabel;
  kind: "CHARGE" | "REFUND";
  status: string;
  amount: number;
  cashTendered?: number;
  changeAmount?: number;
  reference?: string;
  createdAt: string;
  createdByName?: string;
};

export type InvoiceCreditNoteSummary = {
  id: string;
  creditNoteNo: string;
  direction: "ORIGINAL" | "REPLACEMENT";
  reason?: string;
  originalInvoiceId?: string;
  originalInvoiceNo?: string;
  replacementInvoiceId?: string;
  replacementInvoiceNo?: string;
  originalNetTotal: number;
  originalPaidTotal: number;
  replacementNetTotal: number;
  creditedAmount: number;
  customerCreditAmount: number;
  createdAt: string;
  createdByName?: string;
};

// the full normalized invoice object used across the frontend
// we transform the raw API response into this shape so every component works with a consistent format
export type AppInvoice = {
  id: string;
  invoiceNo: string;
  cashierId?: string;
  customerId?: string | null;
  customerName: string;
  customerSubtitle: string; // e.g., "Wholesale customer | 9841234567"
  cashierName: string;
  createdAt: string;
  createdDateLabel: string; // formatted date like "Apr 18, 2026"
  createdTimeLabel: string; // formatted time like "02:30 PM"
  status: InvoiceStatusLabel;
  paymentMethod: PaymentMethodLabel;
  subtotal: number;
  discount: number;
  netTotal: number;
  paidAmount: number;
  dueAmount: number;
  notes?: string;
  items: InvoiceItemSummary[];
  itemSummary: string; // short preview like "Product A x2, Product B x1 +3 more"
  payments: InvoicePaymentSummary[];
  creditNotes: InvoiceCreditNoteSummary[];
  cancelledAt?: string;
  cancelledByName?: string;
  cancelledByRole?: string;
};

// building a descriptive subtitle for the customer — shows wholesale/loyalty status and contact info
function buildCustomerSubtitle(rawCustomer: any) {
  if (!rawCustomer) return "Walk-in customer";

  const parts: string[] = [];
  if (Number(rawCustomer.wholesalePercent || 0) > 0) {
    parts.push("Wholesale customer");
  } else if (Number(rawCustomer.loyaltyPercent || 0) > 0) {
    parts.push("Loyalty customer");
  }

  const contact = rawCustomer.phone || rawCustomer.email;
  if (contact) {
    parts.push(String(contact));
  }

  return parts.join(" | ") || "Walk-in customer";
}

// --

// formatting a number as Nepalese Rupees — e.g., "NPR 1,500" or "NPR 1,500.50"
export function formatNpr(value: number) {
  const normalized = Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
  return `NPR ${normalized.toLocaleString(undefined, {
    minimumFractionDigits: normalized % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

// formatting an ISO date string as a short date label like "Apr 18, 2026"
export function formatDateLabel(isoDate: string) {
  return new Date(isoDate).toLocaleDateString(undefined, {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

// formatting an ISO date string as a time label like "02:30 PM"
export function formatTimeLabel(isoDate: string) {
  return new Date(isoDate).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// formatting a date as a relative time label for alerts — "Just now", "5m ago", "3h ago", or a date
export function formatAlertTimeLabel(isoDate: string) {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));

  if (diffMinutes < 1) return "Just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  // for anything older than 24 hours, we show the actual date
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "2-digit",
  });
}

// --

// converting the raw payment status from the API into a display-friendly label
// the backend may send the status directly or we need to check both status and paymentStatus fields
export function mapInvoiceStatus(rawStatus?: string, rawPaymentStatus?: string): InvoiceStatusLabel {
  const paymentUpper = String(rawPaymentStatus || "").toUpperCase();
  const statusUpper = String(rawStatus || "").toUpperCase();
  const effective = paymentUpper || statusUpper;

  if (effective === "CANCELLED" || effective === "CANCELED") return "Cancelled";
  if (effective === "PAID") return "Paid";
  if (effective === "PARTIAL" || effective === "PARTIALLY_PAID") return "Partial";
  return "Unpaid";
}

// determining the primary payment method for an invoice
// we prefer the first successful payment's method, otherwise we fall back to the first payment
export function mapPaymentMethod(payments: any[]): PaymentMethodLabel {
  if (!payments || payments.length === 0) return "None";

  const chargePayments = payments.filter(
    (payment) => String((payment as any).kind || "CHARGE").toUpperCase() !== "REFUND",
  );
  if (chargePayments.length === 0) return "None";

  const preferred =
    chargePayments.find((payment) => String(payment.status || "").toUpperCase() === "SUCCESS") ||
    chargePayments[0];

  const upper = String(preferred?.method || "").toUpperCase();
  if (upper === "ESEWA") return "eSewa";
  if (upper === "CASH") return "Cash";
  return "None";
}

// building a short text summary of invoice items for list views
// shows the first 2 items and a "+N more" suffix if there are additional items
export function buildInvoiceItemSummary(items: InvoiceItemSummary[]) {
  if (items.length === 0) return "No items";
  const preview = items.slice(0, 2).map((item) => `${item.name} x${item.qty}`);
  const moreCount = items.length - preview.length;
  return moreCount > 0 ? `${preview.join(", ")} +${moreCount} more` : preview.join(", ");
}

// extracting the payment reference (e.g., eSewa transaction code) from the first payment that has one
export function getInvoiceReference(invoice: Pick<AppInvoice, "payments">) {
  return (
    invoice.payments.find(
      (payment) => payment.kind !== "REFUND" && payment.reference,
    )?.reference || ""
  );
}

// --

// the main normalization function — converts a raw API invoice response into our AppInvoice format
// this handles all the edge cases where fields might be missing or named differently
export function normalizeInvoice(raw: any): AppInvoice {
  const createdAt = String(raw.createdAt || new Date().toISOString());

  // normalizing each invoice item — handles different field name patterns from the API
  const items: InvoiceItemSummary[] = (raw.items || []).map((item: any) => ({
    id:
      item.id ||
      `${item.productId || item.product?.id || item.product?.sku || item.product?.name}-${item.qty}`,
    productId: item.productId || item.product?.id || undefined,
    name: item.product?.name || item.name || "Unknown item",
    sku: item.product?.sku || undefined,
    barcode: item.product?.barcode || undefined,
    qty: Number(item.qty || 0),
    unitPrice: Number(item.appliedUnitPrice || item.unitPrice || 0),
    originalUnitPrice:
      item.originalUnitPrice === null || item.originalUnitPrice === undefined
        ? undefined
        : Number(item.originalUnitPrice || 0),
    overrideUnitPrice:
      item.overrideUnitPrice === null || item.overrideUnitPrice === undefined
        ? undefined
        : Number(item.overrideUnitPrice || 0),
    overrideReason: item.overrideReason || undefined,
    overrideByName: item.overrideBy?.name || undefined,
    overrideAt: item.overrideAt || undefined,
    lineTotal: Number(
      item.lineTotal ||
        Number(item.qty || 0) * Number(item.appliedUnitPrice || item.unitPrice || 0),
    ),
  }));

  // normalizing each payment record
  const payments: InvoicePaymentSummary[] = (raw.payments || []).map((payment: any) => ({
    id: payment.id || `${payment.method}-${payment.createdAt}`,
    method: mapPaymentMethod([payment]),
    kind: String(payment.kind || "CHARGE").toUpperCase() === "REFUND" ? "REFUND" : "CHARGE",
    status: String(payment.status || "").toUpperCase() || "PENDING",
    amount: Number(payment.amount || 0),
    cashTendered:
      payment.cashTendered === null || payment.cashTendered === undefined
        ? undefined
        : Number(payment.cashTendered || 0),
    changeAmount:
      payment.changeAmount === null || payment.changeAmount === undefined
        ? undefined
        : Number(payment.changeAmount || 0),
    reference: payment.reference || undefined,
    createdAt: String(payment.createdAt || createdAt),
    createdByName: payment.createdBy?.name || undefined,
  }));

  const creditNotesAsOriginal: InvoiceCreditNoteSummary[] = (
    raw.creditNotesAsOriginal || []
  ).map((note: any) => {
    const originalPaidTotal = Number(note.originalPaidTotal || 0);
    const creditedAmount = Number(note.creditedAmount || 0);

    return {
      id: note.id || note.creditNoteNo,
      creditNoteNo: note.creditNoteNo || "Credit note",
      direction: "ORIGINAL",
      reason: note.reason || undefined,
      originalInvoiceId: note.originalInvoiceId || raw.id,
      originalInvoiceNo: raw.invoiceNo || raw.id,
      replacementInvoiceId:
        note.replacementInvoice?.id || note.replacementInvoiceId || undefined,
      replacementInvoiceNo: note.replacementInvoice?.invoiceNo || undefined,
      originalNetTotal: Number(note.originalNetTotal || 0),
      originalPaidTotal,
      replacementNetTotal: Number(note.replacementNetTotal || 0),
      creditedAmount,
      customerCreditAmount: Math.max(0, originalPaidTotal - creditedAmount),
      createdAt: String(note.createdAt || createdAt),
      createdByName: note.createdBy?.name || undefined,
    };
  });
  const creditNoteAsReplacement = raw.creditNoteAsReplacement
    ? (() => {
        const note = raw.creditNoteAsReplacement;
        const originalPaidTotal = Number(note.originalPaidTotal || 0);
        const creditedAmount = Number(note.creditedAmount || 0);

        return {
          id: note.id || note.creditNoteNo,
          creditNoteNo: note.creditNoteNo || "Credit note",
          direction: "REPLACEMENT" as const,
          reason: note.reason || undefined,
          originalInvoiceId:
            note.originalInvoice?.id || note.originalInvoiceId || undefined,
          originalInvoiceNo: note.originalInvoice?.invoiceNo || undefined,
          replacementInvoiceId: note.replacementInvoiceId || raw.id,
          replacementInvoiceNo: raw.invoiceNo || raw.id,
          originalNetTotal: Number(note.originalNetTotal || 0),
          originalPaidTotal,
          replacementNetTotal: Number(note.replacementNetTotal || 0),
          creditedAmount,
          customerCreditAmount: Math.max(0, originalPaidTotal - creditedAmount),
          createdAt: String(note.createdAt || createdAt),
          createdByName: note.createdBy?.name || undefined,
        };
      })()
    : null;
  const creditNotes = [
    ...creditNotesAsOriginal,
    ...(creditNoteAsReplacement ? [creditNoteAsReplacement] : []),
  ];

  // calculating totals — handling different field names the API might use
  const subtotal =
    Number(raw.subTotal ?? raw.subtotal ?? 0) ||
    items.reduce((sum, item) => sum + item.lineTotal, 0);
  const discount = Number(raw.loyaltyDiscountAmount ?? raw.discount ?? 0);
  const netTotal = Number(raw.netTotal ?? raw.total ?? subtotal - discount);
  const paidAmount = Number(raw.paidTotal ?? raw.paidAmount ?? 0);
  const status = mapInvoiceStatus(raw.status, raw.paymentStatus);
  // if the invoice is cancelled, the due amount is always 0
  const dueAmount =
    status === "Cancelled"
      ? 0
      : Math.max(0, Number(raw.dueAmount ?? netTotal - paidAmount));

  return {
    id: raw.id,
    invoiceNo: raw.invoiceNo || raw.id,
    cashierId: raw.cashier?.id || raw.cashierId || undefined,
    customerId: raw.customer?.id || raw.customerId || null,
    customerName: raw.customer?.name || "Walk-in",
    customerSubtitle: buildCustomerSubtitle(raw.customer),
    cashierName: raw.cashier?.name || "Unknown cashier",
    createdAt,
    createdDateLabel: formatDateLabel(createdAt),
    createdTimeLabel: formatTimeLabel(createdAt),
    status,
    paymentMethod: mapPaymentMethod(payments),
    subtotal,
    discount,
    netTotal,
    paidAmount,
    dueAmount,
    notes: raw.notes || undefined,
    items,
    itemSummary: buildInvoiceItemSummary(items),
    payments,
    creditNotes,
    cancelledAt: raw.cancelledAt || undefined,
    cancelledByName: raw.cancelledBy?.name || undefined,
    cancelledByRole: raw.cancelledBy?.role || undefined,
  };
}

// opening the printable invoice view in a new browser tab
export function openInvoicePrint(invoiceId: string) {
  if (typeof window === "undefined") return;
  window.open(`/invoices/${invoiceId}/print`, "_blank", "noopener,noreferrer");
}

export function openInvoiceReceiptPrint(invoiceId: string) {
  if (typeof window === "undefined") return;
  window.open(
    `/invoices/${invoiceId}/print?mode=receipt`,
    "_blank",
    "noopener,noreferrer",
  );
}
