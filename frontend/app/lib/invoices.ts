// type definitions for invoice display labels
export type InvoiceStatusLabel = "Paid" | "Partial" | "Unpaid" | "Cancelled";
export type PaymentMethodLabel =
  | "Cash"
  | "eSewa"
  | "Fonepay"
  | "Bank Transfer"
  | "Mixed"
  | "None";

export type FrontendIdentitySource =
  | "CAPTURED"
  | "LEGACY_LIVE_FALLBACK"
  | "LEGACY_UNAVAILABLE"
  | "DRAFT_CURRENT"
  | "COMPATIBILITY_UNVERIFIED"
  | "UNRESOLVED";

// the shape of each item inside an invoice — used for the invoice detail modal
export type InvoiceItemSummary = {
  id: string;
  productId?: string;
  name: string;
  sku?: string;
  barcode?: string;
  identitySource: FrontendIdentitySource;
  qty: number;
  unitPrice: number;
  originalUnitPrice?: number;
  overrideUnitPrice?: number;
  overrideReason?: string;
  overrideByName?: string;
  overrideAt?: string;
  remainingReturnableQty?: number;
  lineTotal: number;
};

export type ReceivingDestinationSnapshotV1 = {
  schemaVersion: 1;
  accountId: string;
  accountVersion: number;
  providerLabel: string;
  accountHolder: string;
  accountIdentifier: string | null;
  settlementMethod: "FONEPAY" | "BANK_TRANSFER";
  confirmationMode: "MANUAL_RECEIPT";
  qrAssetId: string;
  qrChecksum: string;
  confirmedById: string;
  confirmedAt: string;
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
  receivingAccountId?: string | null;
  receivingDestinationSnapshot?: ReceivingDestinationSnapshotV1 | null;
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
  customerSubtitle: string; // e.g., "Current customer information: Wholesale customer | 9841234567"
  customerIdentitySource: FrontendIdentitySource;
  customerPanNo: string | null;
  customerAddress: string | null;
  cashierName: string;
  createdAt: string;
  createdDateLabel: string; // formatted date like "Apr 18, 2026"
  createdTimeLabel: string; // formatted time like "02:30 PM"
  status: InvoiceStatusLabel;
  paymentMethod: PaymentMethodLabel;
  subtotal: number;
  discount: number;
  netTotal: number;
  returnAdjustment?: number;
  creditApplied?: number;
  correctionCredit?: number;
  retainedReturnCredit?: number;
  paidAmount: number;
  dueAmount: number;
  notes?: string;
  items: InvoiceItemSummary[];
  itemSummary: string; // short preview like "Product A x2, Product B x1 +3 more"
  payments: InvoicePaymentSummary[];
  creditNotes: InvoiceCreditNoteSummary[];
  reservedRefundTotal?: number;
  cancelledAt?: string;
  cancelledByName?: string;
  cancelledByRole?: string;
  billingChannel?: string | null;
  manualBillRecord?: any;
};

export function cleanDisplayString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.trim().length === 0) return null;
  return value;
}

export function isValidBackendIdentitySource(
  source: unknown,
): source is "CAPTURED" | "LEGACY_LIVE_FALLBACK" | "LEGACY_UNAVAILABLE" | "DRAFT_CURRENT" {
  return (
    source === "CAPTURED" ||
    source === "LEGACY_LIVE_FALLBACK" ||
    source === "LEGACY_UNAVAILABLE" ||
    source === "DRAFT_CURRENT"
  );
}

export function getIdentitySourceLabel(source: FrontendIdentitySource): string {
  switch (source) {
    case "CAPTURED":
      return "Captured at sale";
    case "LEGACY_LIVE_FALLBACK":
      return "Legacy identity — current labels";
    case "LEGACY_UNAVAILABLE":
      return "Historical identity unavailable";
    case "DRAFT_CURRENT":
      return "Current draft identity";
    case "COMPATIBILITY_UNVERIFIED":
      return "Historical identity unverified";
    case "UNRESOLVED":
    default:
      return "Identity unavailable";
  }
}

export type PrintBusinessIdentity = {
  displayName: string;
  legalName: string | null;
  panNo: string | null;
  address: string | null;
  phone: string | null;
};

export function resolvePrintBusinessIdentity(settings?: {
  businessName?: string | null;
  legalName?: string | null;
  panNo?: string | null;
  businessAddress?: string | null;
  businessPhone?: string | null;
} | null): PrintBusinessIdentity {
  const cleanBusinessName = cleanDisplayString(settings?.businessName);
  const cleanLegalName = cleanDisplayString(settings?.legalName);
  const cleanPanNo = cleanDisplayString(settings?.panNo);
  const cleanAddress = cleanDisplayString(settings?.businessAddress);
  const cleanPhone = cleanDisplayString(settings?.businessPhone);

  const displayName = cleanBusinessName || cleanLegalName || "KhataSathi";
  const legalName =
    cleanLegalName && cleanLegalName !== displayName ? cleanLegalName : null;

  return {
    displayName,
    legalName,
    panNo: cleanPanNo,
    address: cleanAddress,
    phone: cleanPhone,
  };
}

export function getInvoiceItemProvenanceNotice(
  items: InvoiceItemSummary[],
): string | null {
  if (!items || items.length === 0) return null;
  let hasLegacy = false;
  let hasUnavailable = false;
  let hasCompatibility = false;

  for (const item of items) {
    if (item.identitySource === "LEGACY_LIVE_FALLBACK") {
      hasLegacy = true;
    } else if (
      item.identitySource === "LEGACY_UNAVAILABLE" ||
      item.identitySource === "UNRESOLVED"
    ) {
      hasUnavailable = true;
    } else if (item.identitySource === "COMPATIBILITY_UNVERIFIED") {
      hasCompatibility = true;
    }
  }

  if (hasLegacy) {
    return "Contains items with current catalog labels";
  }
  if (hasUnavailable) {
    return "Contains items with unavailable historical identity";
  }
  if (hasCompatibility) {
    return "Contains items with unverified historical identity";
  }
  return null;
}

// building a descriptive subtitle for the customer — shows wholesale/loyalty status and contact info
export function buildCustomerSubtitle(rawCustomer: any, isRegistered = false): string {
  if (!rawCustomer) {
    return isRegistered ? "" : "Walk-in customer";
  }

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

  if (parts.length === 0) {
    return isRegistered ? "" : "Walk-in customer";
  }

  const joined = parts.join(" | ");
  return `Current customer information: ${joined}`;
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

  const successfulChargePayments = chargePayments.filter(
    (payment) => String(payment.status || "").toUpperCase() === "SUCCESS",
  );
  const successfulMethods = new Set(
    successfulChargePayments.map((payment) =>
      String(payment.method || "").toUpperCase(),
    ),
  );
  if (successfulMethods.size > 1) return "Mixed";

  const preferred = successfulChargePayments[0] || chargePayments[0];

  const upper = String(preferred?.method || "").toUpperCase();
  if (upper === "ESEWA") return "eSewa";
  if (upper === "FONEPAY") return "Fonepay";
  if (upper === "BANK_TRANSFER") return "Bank Transfer";
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
  const ref =
    invoice.payments.find(
      (payment) => payment.kind !== "REFUND" && payment.reference,
    )?.reference || "";
  if (ref.trim().toLowerCase() === "expired pending esewa payment") {
    return "";
  }
  return ref;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_REGEX = /^[0-9a-fA-F]{64}$/;
const HTML_TAG_PATTERN = /<[^>]*>/;
const CONTROL_CHAR_PATTERN = /[\x00-\x1F\x7F]/;

export function parseReceivingDestinationSnapshot(
  raw: unknown,
): ReceivingDestinationSnapshotV1 | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== 1) {
    return null;
  }
  if (
    typeof obj.accountId !== "string" ||
    !UUID_REGEX.test(obj.accountId.trim())
  ) {
    return null;
  }
  if (
    typeof obj.accountVersion !== "number" ||
    !Number.isInteger(obj.accountVersion) ||
    !Number.isFinite(obj.accountVersion) ||
    obj.accountVersion <= 0
  ) {
    return null;
  }
  if (
    typeof obj.providerLabel !== "string" ||
    obj.providerLabel.trim().length === 0 ||
    obj.providerLabel.length > 120 ||
    CONTROL_CHAR_PATTERN.test(obj.providerLabel) ||
    HTML_TAG_PATTERN.test(obj.providerLabel)
  ) {
    return null;
  }
  if (
    typeof obj.accountHolder !== "string" ||
    obj.accountHolder.trim().length === 0 ||
    obj.accountHolder.length > 120 ||
    CONTROL_CHAR_PATTERN.test(obj.accountHolder) ||
    HTML_TAG_PATTERN.test(obj.accountHolder)
  ) {
    return null;
  }
  if (!("accountIdentifier" in obj)) {
    return null;
  }
  let accountIdentifier: string | null = null;
  if (obj.accountIdentifier !== null) {
    if (
      typeof obj.accountIdentifier !== "string" ||
      obj.accountIdentifier.trim().length === 0 ||
      obj.accountIdentifier.length > 120 ||
      CONTROL_CHAR_PATTERN.test(obj.accountIdentifier) ||
      HTML_TAG_PATTERN.test(obj.accountIdentifier)
    ) {
      return null;
    }
    accountIdentifier = obj.accountIdentifier.trim();
  }
  if (
    obj.settlementMethod !== "FONEPAY" &&
    obj.settlementMethod !== "BANK_TRANSFER"
  ) {
    return null;
  }
  if (obj.confirmationMode !== "MANUAL_RECEIPT") {
    return null;
  }
  if (
    typeof obj.qrAssetId !== "string" ||
    !UUID_REGEX.test(obj.qrAssetId.trim())
  ) {
    return null;
  }
  if (
    typeof obj.qrChecksum !== "string" ||
    !SHA256_REGEX.test(obj.qrChecksum.trim())
  ) {
    return null;
  }
  if (
    typeof obj.confirmedById !== "string" ||
    obj.confirmedById.trim().length === 0 ||
    obj.confirmedById.length > 120 ||
    CONTROL_CHAR_PATTERN.test(obj.confirmedById) ||
    HTML_TAG_PATTERN.test(obj.confirmedById)
  ) {
    return null;
  }
  if (
    typeof obj.confirmedAt !== "string" ||
    obj.confirmedAt.trim().length === 0 ||
    isNaN(Date.parse(obj.confirmedAt))
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    accountId: obj.accountId.trim(),
    accountVersion: obj.accountVersion,
    providerLabel: obj.providerLabel.trim(),
    accountHolder: obj.accountHolder.trim(),
    accountIdentifier,
    settlementMethod: obj.settlementMethod,
    confirmationMode: "MANUAL_RECEIPT",
    qrAssetId: obj.qrAssetId.trim(),
    qrChecksum: obj.qrChecksum.trim().toLowerCase(),
    confirmedById: obj.confirmedById.trim(),
    confirmedAt: obj.confirmedAt.trim(),
  };
}

// --

// the main normalization function — converts a raw API invoice response into our AppInvoice format
// this handles all the edge cases where fields might be missing or named differently
export function normalizeInvoice(raw: any): AppInvoice {
  const createdAt = String(raw.createdAt || new Date().toISOString());

  // extracting active return requests if present to calculate remaining returnable items and reserved refunds
  const returnRequests = Array.isArray(raw.returnRequests) ? raw.returnRequests : [];
  const reservedRefundTotal = returnRequests.reduce(
    (sum: number, req: any) => sum + Number(req.refundAmount || 0),
    0,
  );
  const alreadyReturnedByItemId = new Map<string, number>();
  for (const req of returnRequests) {
    for (const item of req.items || []) {
      const invoiceItemId = String(item.invoiceItemId || "");
      if (invoiceItemId) {
        alreadyReturnedByItemId.set(
          invoiceItemId,
          (alreadyReturnedByItemId.get(invoiceItemId) || 0) + Number(item.qtyReturned || 0),
        );
      }
    }
  }

  const rawCustomerId =
    raw.customerId !== undefined
      ? raw.customerId
      : raw.customer?.id !== undefined
        ? raw.customer.id
        : null;
  const isRegistered =
    rawCustomerId !== null &&
    rawCustomerId !== undefined &&
    String(rawCustomerId).trim().length > 0;
  const isInvoiceDraft = String(raw.status || "").toUpperCase() === "DRAFT";

  let customerIdentitySource: FrontendIdentitySource;
  let customerName: string;
  let customerPanNo: string | null = null;
  let customerAddress: string | null = null;

  if (!("displayCustomer" in raw)) {
    if (isInvoiceDraft) {
      customerIdentitySource = "DRAFT_CURRENT";
      customerName =
        cleanDisplayString(raw.customer?.name) ||
        (isRegistered ? "Unknown customer" : "Walk-in");
    } else {
      customerIdentitySource = "COMPATIBILITY_UNVERIFIED";
      const legacyName =
        cleanDisplayString(raw.customer?.name) ||
        cleanDisplayString(raw.customerName);
      customerName =
        legacyName || (isRegistered ? "Unknown customer" : "Walk-in");
    }
  } else {
    const dc = raw.displayCustomer;
    if (
      dc === null ||
      typeof dc !== "object" ||
      !isValidBackendIdentitySource(dc.source)
    ) {
      customerIdentitySource = "UNRESOLVED";
      customerName = isRegistered ? "Unknown customer" : "Walk-in";
    } else {
      customerIdentitySource = dc.source;
      const cleanName = cleanDisplayString(dc.name);
      customerName =
        cleanName !== null
          ? cleanName
          : isRegistered
            ? "Unknown customer"
            : "Walk-in";

      if (customerIdentitySource === "CAPTURED") {
        customerPanNo = cleanDisplayString(dc.panNo);
        customerAddress = cleanDisplayString(dc.address);
      }
    }
  }

  // normalizing each invoice item — handles different field name patterns from the API
  const items: InvoiceItemSummary[] = (raw.items || []).map((item: any) => {
    const qty = Number(item.qty || 0);
    const itemId =
      item.id ||
      `${item.productId || item.product?.id || item.product?.sku || item.product?.name}-${qty}`;
    const alreadyReturned = alreadyReturnedByItemId.get(itemId) || 0;
    const remainingReturnableQty = Math.max(0, qty - alreadyReturned);

    let identitySource: FrontendIdentitySource;
    let name: string;
    let sku: string | undefined = undefined;

    if (!("displayProduct" in item)) {
      if (isInvoiceDraft) {
        identitySource = "DRAFT_CURRENT";
        name =
          cleanDisplayString(item.product?.name) ||
          cleanDisplayString(item.name) ||
          "Unknown item";
        sku =
          cleanDisplayString(item.product?.sku) ||
          cleanDisplayString(item.sku) ||
          undefined;
      } else {
        identitySource = "COMPATIBILITY_UNVERIFIED";
        name =
          cleanDisplayString(item.product?.name) ||
          cleanDisplayString(item.name) ||
          "Unknown item";
        sku =
          cleanDisplayString(item.product?.sku) ||
          cleanDisplayString(item.sku) ||
          undefined;
      }
    } else {
      const dp = item.displayProduct;
      if (
        dp === null ||
        typeof dp !== "object" ||
        !isValidBackendIdentitySource(dp.source)
      ) {
        identitySource = "UNRESOLVED";
        name = "Unknown item";
        sku = undefined;
      } else {
        identitySource = dp.source;
        name = cleanDisplayString(dp.name) || "Unknown item";
        const cleanSku = cleanDisplayString(dp.sku);
        sku = cleanSku !== null ? cleanSku : undefined;
      }
    }

    return {
      id: itemId,
      productId: item.productId || item.product?.id || undefined,
      name,
      sku,
      barcode: item.product?.barcode || item.barcode || undefined,
      identitySource,
      qty,
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
      remainingReturnableQty,
      lineTotal: Number(
        item.lineTotal ||
          qty * Number(item.appliedUnitPrice || item.unitPrice || 0),
      ),
    };
  });

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
    receivingAccountId: payment.receivingAccountId || undefined,
    receivingDestinationSnapshot: parseReceivingDestinationSnapshot(payment.receivingDestinationSnapshot),
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
  const returnAdjustment = Number(raw.returnAdjustment || 0);
  const creditApplied = Number(raw.creditApplied || 0);
  const correctionCredit = Number(raw.correctionCredit || 0);
  const effectivePayable = raw.returnAdjustment !== undefined ? Math.max(0, Math.round(netTotal) - returnAdjustment - creditApplied - correctionCredit) : netTotal;
  const paidAmount = Number(raw.paidTotal ?? raw.paidAmount ?? 0);
  const status = mapInvoiceStatus(raw.status, raw.paymentStatus);
  // if the invoice is cancelled, the due amount is always 0
  const dueAmount =
    status === "Cancelled"
      ? 0
      : Math.round(Math.max(0, Number(raw.dueAmount ?? effectivePayable - paidAmount)) * 100) / 100;

  return {
    id: raw.id,
    invoiceNo: raw.invoiceNo || raw.id,
    cashierId: raw.cashier?.id || raw.cashierId || undefined,
    customerId: rawCustomerId,
    customerName,
    customerSubtitle: buildCustomerSubtitle(raw.customer, isRegistered),
    customerIdentitySource,
    customerPanNo,
    customerAddress,
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
    returnAdjustment,
    creditApplied,
    correctionCredit,
    retainedReturnCredit: returnAdjustment > 0 ? Math.max(0, paidAmount - effectivePayable) : 0,
    dueAmount,
    notes: raw.notes || undefined,
    items,
    itemSummary: buildInvoiceItemSummary(items),
    payments,
    creditNotes,
    reservedRefundTotal,
    cancelledAt: raw.cancelledAt || undefined,
    cancelledByName: raw.cancelledBy?.name || undefined,
    cancelledByRole: raw.cancelledBy?.role || undefined,
    billingChannel: raw.billingChannel || undefined,
    manualBillRecord: raw.manualBillRecord || undefined,
  };
}

// The price-history preview shares the invoice display and old-response policy.
export function normalizePurchaseHistoryProduct(item: {
  productId: string;
  productName: string;
  productSku: string | null;
  displayProduct?: unknown;
}) {
  return normalizeInvoice({
    status: "FINALIZED",
    items: [{ ...item, name: item.productName, sku: item.productSku }],
  }).items[0];
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
