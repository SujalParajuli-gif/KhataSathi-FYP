export type InvoiceStatusLabel = "Paid" | "Partial" | "Unpaid" | "Cancelled";
export type PaymentMethodLabel = "Cash" | "eSewa" | "None";

export type InvoiceItemSummary = {
  id: string;
  name: string;
  sku?: string;
  barcode?: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
};

export type InvoicePaymentSummary = {
  id: string;
  method: PaymentMethodLabel;
  status: string;
  amount: number;
  reference?: string;
  createdAt: string;
  createdByName?: string;
};

export type AppInvoice = {
  id: string;
  invoiceNo: string;
  cashierId?: string;
  customerId?: string | null;
  customerName: string;
  customerSubtitle: string;
  cashierName: string;
  createdAt: string;
  createdDateLabel: string;
  createdTimeLabel: string;
  status: InvoiceStatusLabel;
  paymentMethod: PaymentMethodLabel;
  subtotal: number;
  discount: number;
  netTotal: number;
  paidAmount: number;
  dueAmount: number;
  items: InvoiceItemSummary[];
  itemSummary: string;
  payments: InvoicePaymentSummary[];
};

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

export function formatNpr(value: number) {
  const normalized = Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
  return `NPR ${normalized.toLocaleString(undefined, {
    minimumFractionDigits: normalized % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatDateLabel(isoDate: string) {
  return new Date(isoDate).toLocaleDateString(undefined, {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

export function formatTimeLabel(isoDate: string) {
  return new Date(isoDate).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatAlertTimeLabel(isoDate: string) {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));

  if (diffMinutes < 1) return "Just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "2-digit",
  });
}

export function mapInvoiceStatus(rawStatus?: string, rawPaymentStatus?: string): InvoiceStatusLabel {
  const paymentUpper = String(rawPaymentStatus || "").toUpperCase();
  const statusUpper = String(rawStatus || "").toUpperCase();
  const effective = paymentUpper || statusUpper;

  if (effective === "CANCELLED" || effective === "CANCELED") return "Cancelled";
  if (effective === "PAID") return "Paid";
  if (effective === "PARTIAL" || effective === "PARTIALLY_PAID") return "Partial";
  return "Unpaid";
}

export function mapPaymentMethod(payments: any[]): PaymentMethodLabel {
  if (!payments || payments.length === 0) return "None";

  const preferred =
    payments.find((payment) => String(payment.status || "").toUpperCase() === "SUCCESS") ||
    payments[0];

  const upper = String(preferred?.method || "").toUpperCase();
  if (upper === "ESEWA") return "eSewa";
  if (upper === "CASH") return "Cash";
  return "None";
}

export function buildInvoiceItemSummary(items: InvoiceItemSummary[]) {
  if (items.length === 0) return "No items";
  const preview = items.slice(0, 2).map((item) => `${item.name} x${item.qty}`);
  const moreCount = items.length - preview.length;
  return moreCount > 0 ? `${preview.join(", ")} +${moreCount} more` : preview.join(", ");
}

export function getInvoiceReference(invoice: Pick<AppInvoice, "payments">) {
  return invoice.payments.find((payment) => payment.reference)?.reference || "";
}

export function normalizeInvoice(raw: any): AppInvoice {
  const createdAt = String(raw.createdAt || new Date().toISOString());
  const items: InvoiceItemSummary[] = (raw.items || []).map((item: any) => ({
    id:
      item.id ||
      `${item.productId || item.product?.id || item.product?.sku || item.product?.name}-${item.qty}`,
    name: item.product?.name || item.name || "Unknown item",
    sku: item.product?.sku || undefined,
    barcode: item.product?.barcode || undefined,
    qty: Number(item.qty || 0),
    unitPrice: Number(item.appliedUnitPrice || item.unitPrice || 0),
    lineTotal: Number(
      item.lineTotal ||
        Number(item.qty || 0) * Number(item.appliedUnitPrice || item.unitPrice || 0),
    ),
  }));
  const payments: InvoicePaymentSummary[] = (raw.payments || []).map((payment: any) => ({
    id: payment.id || `${payment.method}-${payment.createdAt}`,
    method: mapPaymentMethod([payment]),
    status: String(payment.status || "").toUpperCase() || "PENDING",
    amount: Number(payment.amount || 0),
    reference: payment.reference || undefined,
    createdAt: String(payment.createdAt || createdAt),
    createdByName: payment.createdBy?.name || undefined,
  }));

  const subtotal =
    Number(raw.subTotal ?? raw.subtotal ?? 0) ||
    items.reduce((sum, item) => sum + item.lineTotal, 0);
  const discount = Number(raw.loyaltyDiscountAmount ?? raw.discount ?? 0);
  const netTotal = Number(raw.netTotal ?? raw.total ?? subtotal - discount);
  const paidAmount = Number(raw.paidTotal ?? raw.paidAmount ?? 0);
  const status = mapInvoiceStatus(raw.status, raw.paymentStatus);
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
    items,
    itemSummary: buildInvoiceItemSummary(items),
    payments,
  };
}

export function openInvoicePrint(invoiceId: string) {
  if (typeof window === "undefined") return;
  window.open(`/invoices/${invoiceId}/print`, "_blank", "noopener,noreferrer");
}

