import { formatBillingMoney } from "~/lib/billingWorkspace";
import "~/styles/billing-workspace.css";
import { paperReviewIssue, shopToday, type PaperReview } from "~/lib/billingWorkspace";
import { getBusinessSettingsApi, getCategoriesApi } from "~/lib/api/endpoints";
import { resolvePrintBusinessIdentity } from "~/lib/invoices";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useSearchParams } from "react-router";
import Icon from "~/components/ui/Icon";
import ProjectSelect from "~/components/ui/ProjectSelect";
import ProjectDateInput from "~/components/ui/ProjectDateInput";
import { useToast } from "~/components/ui/Toast";
import {
  ConfirmDialog,
  DialogButton,
  ModalFrame,
  SuccessDialog,
} from "~/components/ui/Modal";
import {
  getMyCashierPrivilegesApi,
  getProductByCodeApi,
  getProductsByIdsApi,
  getInvoiceApi,
  listProductsApi,
  checkoutInvoiceApi,
  listCustomersApi,
  lookupCustomersApi,
  getCustomerProductHistoryApi,
  getPaymentGatewayDisplayApi,
  type CustomerProductPurchaseHistoryItem,
  type GatewayDisplayResponse,
  createQuickCustomerApi,
  authorizePriceOverrideApi,
  discardParkedDraftApi,
  listParkedDraftsApi,
  parkInvoiceDraftApi,
  resumeParkedDraftApi,
  acceptDraftRequestApi,
  getDraftRequestApi,
  listDraftRequestsApi,
  markDraftRequestViewedApi,
  rejectDraftRequestApi,
  resolveAcceptedDraftRequestApi,
  type BillingDraftRequest,
  type CashierPrivilege,
  type CheckoutInvoiceInput,
  type DraftRequestReviewItem,
} from "~/lib/api/endpoints";
import {
  getManualBillRecord,
  uploadInvoiceProofApi,
  type BillScanObservations,
  recordManualBillReference,
  type ExpectedManualBillRecord,
  type ExternalDocumentType,
  type ManualBillRecord,
} from "~/lib/api/manualBills";
import BillingCalculatorModal from "~/components/billing/BillingCalculatorModal";
import BillingCustomerHistoryModal from "~/components/billing/BillingCustomerHistoryModal";
import BillingCompactHistoryOverlay from "~/components/billing/BillingCompactHistoryOverlay";
import CashierQrGalleryModal from "~/components/billing/CashierQrGalleryModal";
import SavedSalePaymentFollowup from "~/components/billing/SavedSalePaymentFollowup";
import ConfirmPaymentModal from "~/components/billing/ConfirmPaymentModal";
import BillingProductBrowser from "~/components/billing/BillingProductBrowser";
import BillingCompactCartHistory from "~/components/billing/BillingCompactCartHistory";
import BillingCartTable, { type CartTableItem } from "~/components/billing/BillingCartTable";
import BillingInvoicePreview from "~/components/billing/BillingInvoicePreview";
import BillingCustomerSummary from "~/components/billing/BillingCustomerSummary";
import BillingToolsMenu from "~/components/billing/BillingToolsMenu";
import BillingWorksheetView from "~/components/billing/BillingWorksheetView";
import BillingPurchaseHistoryV2, { type HistoryNavigation } from "~/components/billing/BillingPurchaseHistoryV2";
import BillingOcrComparisonModal from "~/components/billing/BillingOcrComparisonModal";
import BillingPriceDifferPopover from "~/components/billing/BillingPriceDifferPopover";
import {
  getEnabledPaymentAccountsApi,
  type EnabledPaymentAccountDto,
} from "~/lib/api/paymentAccounts";
import { submitEsewaForm } from "~/lib/esewa";
import { getAuthUser } from "~/lib/auth";
import { getIdentitySourceLabel, normalizePurchaseHistoryProduct, openInvoicePrint, openInvoiceReceiptPrint, parseReceivingDestinationSnapshot, type ReceivingDestinationSnapshotV1 } from "~/lib/invoices";
import { isRateLimitError } from "~/lib/api/client";
import { useRateLimitRecovery } from "~/lib/api/useRateLimitRecovery";
import { focusInvalidField } from "~/lib/forms/focusInvalidField";
import {
  resolvePendingCheckoutSnapshot,
  deriveCandidateCheckoutState,
  computeReviewFingerprint,
  isQuantityStepCompliant,
  type ReviewedCheckoutCandidate,
} from "~/lib/billingCheckout";

const PRODUCT_REFRESH_INTERVAL_MS = 120_000; // refreshing the product catalog every 2 minutes to prevent stale stock and prices while keeping request volume low
const LAST_INVOICE_PRINT_STORAGE_KEY = "khatasathi:lastInvoicePrintId";
const MANUAL_SEARCH_LIMIT = 12;
const BILLING_VIEW_SIZE_STORAGE_KEY = "khatasathi:billingViewSize";
function createCheckoutOperationKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `checkout-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
const PRICE_OVERRIDE_REASONS = [
  "Wrong shelf/tag price",
  "Customer-specific agreed rate",
  "Bulk purchase exception",
  "Damaged item or packaging issue",
  "Clearance or old stock",
  "Promotion not configured",
  "Competitor price match",
  "Rounding or billing correction",
  "Supplier printed rate mismatch",
  "Manager-approved goodwill adjustment",
  "Other manager-approved correction",
];
const BILLING_VIEW_SIZE_OPTIONS = [
  "85",
  "90",
  "95",
  "100",
  "105",
  "110",
] as const;
type BillingViewSize = (typeof BILLING_VIEW_SIZE_OPTIONS)[number];
const BILLING_VIEW_SIZE_LABELS: Record<BillingViewSize, string> = {
  "85": "85%",
  "90": "90%",
  "95": "95%",
  "100": "100%",
  "105": "105%",
  "110": "110%",
};
function readStoredBillingViewSize(): BillingViewSize {
  if (typeof window === "undefined") return "100";
  const stored = window.localStorage.getItem(BILLING_VIEW_SIZE_STORAGE_KEY);
  if (stored === "compact") return "90";
  if (stored === "normal") return "100";
  if (stored === "large") return "110";
  return BILLING_VIEW_SIZE_OPTIONS.includes(stored as BillingViewSize)
    ? (stored as BillingViewSize)
    : "100";
}

type PaymentMethod = "Cash" | "Fonepay" | "eSewa" | "Split" | "Bank Transfer";
type PaymentStatus = "Paid" | "Partial" | "Unpaid";
type PendingBillingConfirm = "checkout" | "clear-cart" | "park-cart" | null;
type SplitPaymentDraft = {
  id: string;
  method: "CASH" | "FONEPAY" | "ESEWA" | "BANK_TRANSFER";
  amount: string;
  tenderedAmount: string;
  reference?: string;
  receivingAccountId?: string;
  receivingAccountVersion?: number;
  receivingAccountLabel?: string;
  manualReceiptConfirmed?: boolean;
};
type StockConflictReason =
  | "NOT_FOUND"
  | "INACTIVE"
  | "OUT_OF_STOCK"
  | "INSUFFICIENT_STOCK";
type StockConflict = {
  productId: string;
  productName: string;
  sku?: string | null;
  requestedQty: number;
  availableStock: number;
  reason: StockConflictReason;
};

type Customer = {
  id: string;
  name: string;
  phone: string;
  email?: string;
  panNo?: string | null;
  address?: string | null;
  isActive?: boolean;
  isLoyalty: boolean;
  loyaltyPercent?: number;
  wholesalePercent?: number;
};

type QuickCustomerDraft = {
  name: string;
  phone: string;
  email: string;
  panNo: string;
  address: string;
};

type Product = {
  id: string;
  name: string;
  sku: string;
  barcode?: string;
  brand: string;
  categoryGroup?: string;
  productCodeVariant?: string;
  sizeValue?: number | null;
  sizeUnit?: string;
  packageQuantity?: number;
  packageUnit?: string;
  saleUnit: string;
  allowFractionalQty: boolean;
  quantityStep: number;
  wholesaleEligible: boolean;
  retailPrice: number;
  sellingPriceStatus?: "READY" | "PENDING";
  wholesalePrice: number;
  wholesaleQtyThreshold?: number;
  stock: number;
  reservedStock?: number;
  actualStock?: number;
  lowStockThreshold?: number;
  active: boolean;
  imageUrl?: string;
  imageColor?: string;
};

type CartLine = {
  productId: string;
  qty: number;
  overrideUnitPrice?: number;
  overrideReason?: string;
  overrideAuthorizationToken?: string;
};

type ParkedDraft = {
  id: string;
  invoiceNo?: string;
  parkedLabel?: string | null;
  parkedAt?: string | null;
  customerId?: string | null;
  customer?: {
    id?: string;
    name?: string;
    phone?: string;
  } | null;
  subTotal?: number;
  staleWarnings?: ParkedResumeWarning[];
  items?: Array<{
    productId: string;
    qty: number;
    product?: {
      id?: string;
      name?: string;
      sku?: string;
    } | null;
  }>;
};

type ParkedResumeWarning = {
  productId: string;
  productName: string;
  sku?: string | null;
  qty: number;
  parkedUnitPrice: number;
  currentUnitPrice: number;
  availableStock: number;
  warnings: string[];
};

type DraftReviewDecision = {
  action: "ACCEPT" | "REJECT";
  acceptedQty: number;
  reason: string;
};

type StoredBillingCart = {
  cart: CartLine[];
  activeDraftInvoiceId?: string | null;
  activeDraftRequestId?: string | null;
  selectedCustomerId?: string | null;
  pendingCheckout?: PendingCheckoutSnapshot | null;
  savedAt: string;
};

type PendingCheckoutPayload = Omit<
  CheckoutInvoiceInput,
  "operationKey" | "overridePin"
>;

type PendingCheckoutSnapshot = {
  operationKey: string;
  payload: PendingCheckoutPayload;
  activeDraftRequestId?: string | null;
};

const BILLING_CART_STORAGE_KEY = "khatasathi_billing_cart";
const DRAFT_REQUEST_NOTICE_ACK_STORAGE_KEY =
  "khatasathi_billing_draft_request_notice_ack";
const BILLING_PAPER_FOLLOWUP_STORAGE_KEY = "khatasathi_billing_paper_followup_v1";
const BILLING_PAPER_FOLLOWUP_STORAGE_PREFIX = "khatasathi_billing_paper_followup_v2:";
const BILLING_PENDING_PAPER_DRAFT_KEY = "khatasathi_billing_pending_paper_draft_v1";

type StoredPaperFollowup = {
  version: 1;
  actorId: string;
  invoiceId: string;
  invoiceNo?: string;
  draft: {
    billNo: string;
    externalDocumentType: ExternalDocumentType;
    externalBillDate: string;
  };
  expected?: ExpectedManualBillRecord | null;
  duplicateOverrideReason?: string;
  error?: string;
  savedAt: string;
  expiresAt: string;
};

type StoredPendingPaperDraft = {
  version: 1;
  actorId: string;
  operationKey: string;
  draft: {
    billNo: string;
    externalDocumentType: ExternalDocumentType;
    externalBillDate: string;
    choice: "RECORD_AFTER_SAVE" | "LATER";
  };
  savedAt: string;
  expiresAt: string;
};

function parseStoredPaperFollowup(raw: string | null, actorId: string): StoredPaperFollowup | null {
  try {
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.version !== 1 ||
      typeof parsed.actorId !== "string" ||
      !parsed.actorId.trim() ||
      typeof parsed.invoiceId !== "string" ||
      !parsed.invoiceId.trim() ||
      typeof parsed.savedAt !== "string" ||
      isNaN(Date.parse(parsed.savedAt)) ||
      typeof parsed.expiresAt !== "string" ||
      isNaN(Date.parse(parsed.expiresAt)) ||
      !parsed.draft ||
      typeof parsed.draft !== "object" ||
      typeof parsed.draft.billNo !== "string" ||
      !parsed.draft.billNo.trim() ||
      !["PAN_INVOICE", "VAT_TAX_INVOICE", "ABBREVIATED_TAX_INVOICE", "OTHER_MANUAL_SALES_DOCUMENT"].includes(parsed.draft.externalDocumentType) ||
      typeof parsed.draft.externalBillDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(parsed.draft.externalBillDate) ||
      isNaN(Date.parse(parsed.draft.externalBillDate))
    ) {
      return null;
    }
    if (actorId && parsed.actorId !== actorId) {
      return null;
    }
    return parsed as StoredPaperFollowup;
  } catch {
    return null;
  }
}

function paperFollowupStorageKey(actorId: string, invoiceId: string) {
  return `${BILLING_PAPER_FOLLOWUP_STORAGE_PREFIX}${encodeURIComponent(actorId)}:${encodeURIComponent(invoiceId)}`;
}

function readStoredPaperFollowup(actorId: string, invoiceId?: string): StoredPaperFollowup | null {
  if (typeof window === "undefined" || !actorId) return null;
  try {
    const storage = window.sessionStorage;
    const legacy = parseStoredPaperFollowup(storage.getItem(BILLING_PAPER_FOLLOWUP_STORAGE_KEY), actorId);
    if (invoiceId) {
      const stored = parseStoredPaperFollowup(storage.getItem(paperFollowupStorageKey(actorId, invoiceId)), actorId);
      return stored?.invoiceId === invoiceId ? stored : legacy?.invoiceId === invoiceId ? legacy : null;
    }
    const pending: StoredPaperFollowup[] = [];
    const actorPrefix = `${BILLING_PAPER_FOLLOWUP_STORAGE_PREFIX}${encodeURIComponent(actorId)}:`;
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key?.startsWith(actorPrefix)) continue;
      const stored = parseStoredPaperFollowup(storage.getItem(key), actorId);
      if (stored && key === paperFollowupStorageKey(actorId, stored.invoiceId)) pending.push(stored);
    }
    if (legacy && !pending.some((stored) => stored.invoiceId === legacy.invoiceId)) pending.push(legacy);
    // Recover one at a time, oldest first. Other invoices remain independently durable.
    return pending.sort((a, b) => a.savedAt.localeCompare(b.savedAt) || a.invoiceId.localeCompare(b.invoiceId))[0] || null;
  } catch {
    return null;
  }
}

function writeStoredPaperFollowup(
  data: Omit<StoredPaperFollowup, "savedAt" | "expiresAt" | "version">,
): boolean {
  if (typeof window === "undefined") return false;
  try {
    const now = Date.now();
    const expiresAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    const payload: StoredPaperFollowup = {
      ...data,
      version: 1,
      savedAt: new Date(now).toISOString(),
      expiresAt,
    };
    window.sessionStorage.setItem(
      paperFollowupStorageKey(data.actorId, data.invoiceId),
      JSON.stringify(payload),
    );
    // Upgrade this invoice's legacy slot only after its replacement is durable.
    const legacy = parseStoredPaperFollowup(window.sessionStorage.getItem(BILLING_PAPER_FOLLOWUP_STORAGE_KEY), data.actorId);
    if (legacy?.invoiceId === data.invoiceId) {
      window.sessionStorage.removeItem(BILLING_PAPER_FOLLOWUP_STORAGE_KEY);
    }
    return true;
  } catch {
    return false;
  }
}

function clearStoredPaperFollowup(
  invoiceId: string,
  draft: StoredPaperFollowup["draft"],
  reconciledIntent: StoredPaperFollowup | null,
) {
  if (typeof window === "undefined" || !reconciledIntent) return;
  try {
    const current = readStoredPaperFollowup(reconciledIntent.actorId, invoiceId);
    if (JSON.stringify(current) !== JSON.stringify(reconciledIntent)) return;
    if (
      current?.invoiceId !== invoiceId ||
      current.draft.billNo !== draft.billNo ||
      current.draft.externalDocumentType !== draft.externalDocumentType ||
      current.draft.externalBillDate !== draft.externalBillDate
    ) return;
    window.sessionStorage.removeItem(paperFollowupStorageKey(reconciledIntent.actorId, invoiceId));
  } catch {}
}

function readStoredPendingPaperDraft(
  operationKey: string,
  actorId?: string,
): StoredPendingPaperDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(BILLING_PENDING_PAPER_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.version !== 1 ||
      typeof parsed.actorId !== "string" ||
      !parsed.actorId.trim() ||
      typeof parsed.operationKey !== "string" ||
      parsed.operationKey !== operationKey ||
      typeof parsed.savedAt !== "string" ||
      isNaN(Date.parse(parsed.savedAt)) ||
      typeof parsed.expiresAt !== "string" ||
      isNaN(Date.parse(parsed.expiresAt)) ||
      new Date(parsed.expiresAt).getTime() <= Date.now() ||
      !parsed.draft ||
      typeof parsed.draft !== "object" ||
      typeof parsed.draft.billNo !== "string" ||
      !parsed.draft.billNo.trim() ||
      !["PAN_INVOICE", "VAT_TAX_INVOICE", "ABBREVIATED_TAX_INVOICE", "OTHER_MANUAL_SALES_DOCUMENT"].includes(parsed.draft.externalDocumentType) ||
      typeof parsed.draft.externalBillDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(parsed.draft.externalBillDate) ||
      isNaN(Date.parse(parsed.draft.externalBillDate)) ||
      !["RECORD_AFTER_SAVE", "LATER"].includes(parsed.draft.choice)
    ) {
      return null;
    }
    if (actorId && parsed.actorId !== actorId) {
      return null;
    }
    return parsed as StoredPendingPaperDraft;
  } catch {
    return null;
  }
}

function writeStoredPendingPaperDraft(
  data: Omit<StoredPendingPaperDraft, "version" | "savedAt" | "expiresAt">,
): boolean {
  if (typeof window === "undefined") return false;
  try {
    const now = Date.now();
    const expiresAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    window.sessionStorage.setItem(
      BILLING_PENDING_PAPER_DRAFT_KEY,
      JSON.stringify({ ...data, version: 1, savedAt: new Date(now).toISOString(), expiresAt }),
    );
    return true;
  } catch {
    return false;
  }
}

function clearStoredPendingPaperDraft(operationKey?: string) {
  if (typeof window === "undefined") return;
  try {
    if (!operationKey) {
      window.sessionStorage.removeItem(BILLING_PENDING_PAPER_DRAFT_KEY);
      return;
    }
    const current = readStoredPendingPaperDraft(operationKey);
    if (current && current.operationKey === operationKey) {
      window.sessionStorage.removeItem(BILLING_PENDING_PAPER_DRAFT_KEY);
    }
  } catch {}
}

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

// reading the saved billing cart from localStorage lets us restore the cashier's cart after route changes
// invalid or corrupted payloads are discarded so they do not break the billing screen
function readStoredBillingCart() {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(BILLING_CART_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<StoredBillingCart> | null;
    if (!parsed || !Array.isArray(parsed.cart)) {
      window.localStorage.removeItem(BILLING_CART_STORAGE_KEY);
      return null;
    }

    const normalizedCart = parsed.cart
      .map((line) => {
        const productId = String(line?.productId || "").trim();
        const qty = normalizeQuantityValue(Number(line?.qty || 0));

        if (!productId || !Number.isFinite(qty) || qty < 1) {
          return null;
        }

        const overrideUnitPrice =
          line?.overrideUnitPrice === undefined ||
          line?.overrideUnitPrice === null
            ? undefined
            : Number(line.overrideUnitPrice);
        const overrideReason =
          typeof line?.overrideReason === "string"
            ? line.overrideReason.trim().slice(0, 240)
            : undefined;
        const overrideAuthorizationToken =
          typeof line?.overrideAuthorizationToken === "string"
            ? line.overrideAuthorizationToken.trim()
            : undefined;

        return {
          productId,
          qty,
          ...(typeof overrideUnitPrice === "number" &&
          Number.isFinite(overrideUnitPrice) &&
          overrideUnitPrice > 0
            ? { overrideUnitPrice }
            : {}),
          ...(overrideReason ? { overrideReason } : {}),
          ...(overrideAuthorizationToken ? { overrideAuthorizationToken } : {}),
        };
      })
      .filter(Boolean) as CartLine[];

    if (normalizedCart.length === 0) {
      window.localStorage.removeItem(BILLING_CART_STORAGE_KEY);
      return null;
    }

    const pendingCheckout =
      parsed.pendingCheckout &&
      /^[A-Za-z0-9_-]{16,120}$/.test(parsed.pendingCheckout.operationKey || "") &&
      parsed.pendingCheckout.payload &&
      Array.isArray(parsed.pendingCheckout.payload.items)
        ? parsed.pendingCheckout
        : null;

    return {
      cart: pendingCheckout
        ? (pendingCheckout.payload.items.map((item) => ({ ...item })) as CartLine[])
        : normalizedCart,
      activeDraftInvoiceId:
        typeof pendingCheckout?.payload.draftInvoiceId === "string"
          ? pendingCheckout.payload.draftInvoiceId
          : typeof parsed.activeDraftInvoiceId === "string"
          ? parsed.activeDraftInvoiceId
          : null,
      activeDraftRequestId:
        typeof parsed.activeDraftRequestId === "string"
          ? parsed.activeDraftRequestId
          : null,
      selectedCustomerId:
        typeof pendingCheckout?.payload.customerId === "string"
          ? pendingCheckout.payload.customerId
          : typeof parsed.selectedCustomerId === "string"
          ? parsed.selectedCustomerId
          : null,
      pendingCheckout,
      savedAt:
        typeof parsed.savedAt === "string"
          ? parsed.savedAt
          : new Date().toISOString(),
    };
  } catch {
    window.localStorage.removeItem(BILLING_CART_STORAGE_KEY);
    return null;
  }
}

// saving the cart plus its active draft link keeps resumed held bills safe across refreshes
function writeStoredBillingCart(
  cart: CartLine[],
  activeDraftInvoiceId?: string | null,
  selectedCustomerId?: string | null,
  activeDraftRequestId?: string | null,
  pendingCheckout?: PendingCheckoutSnapshot | null,
) {
  if (typeof window === "undefined") return;

  window.localStorage.setItem(
    BILLING_CART_STORAGE_KEY,
    JSON.stringify({
      cart,
      activeDraftInvoiceId: activeDraftInvoiceId || null,
      activeDraftRequestId: activeDraftRequestId || null,
      selectedCustomerId: selectedCustomerId || null,
      pendingCheckout: pendingCheckout || null,
      savedAt: new Date().toISOString(),
    } satisfies StoredBillingCart),
  );
}

// clearing the stored billing cart is used after successful checkout and whenever the cashier intentionally empties the cart
function clearStoredBillingCart() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(BILLING_CART_STORAGE_KEY);
}

function isDraftRequestNoticeAcknowledged(
  userId: string | undefined,
  draftRequestId: string,
) {
  if (typeof window === "undefined" || !userId || !draftRequestId) return false;

  try {
    const raw = window.localStorage.getItem(
      DRAFT_REQUEST_NOTICE_ACK_STORAGE_KEY,
    );
    if (!raw) return false;
    const parsed = JSON.parse(raw) as {
      userId?: string;
      draftRequestId?: string;
    };
    return (
      parsed.userId === userId && parsed.draftRequestId === draftRequestId
    );
  } catch {
    window.localStorage.removeItem(DRAFT_REQUEST_NOTICE_ACK_STORAGE_KEY);
    return false;
  }
}

function acknowledgeDraftRequestNotice(
  userId: string | undefined,
  draftRequestId: string | null,
) {
  if (typeof window === "undefined" || !userId || !draftRequestId) return;

  try {
    window.localStorage.setItem(
      DRAFT_REQUEST_NOTICE_ACK_STORAGE_KEY,
      JSON.stringify({
        userId,
        draftRequestId,
        acknowledgedAt: new Date().toISOString(),
      }),
    );
  } catch {
    // A blocked or full storage area must never interrupt Billing.
  }
}



// we use this to keep percentages between 0 and 100
// so an admin can't accidentally type a 200% discount and break the math
function clampPercent(v: number) {
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

// same idea as clampPercent but for random minimums and maximums
function clampNumber(v: number, min: number, max: number) {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function normalizeQuantityValue(value: number, fallback = 1) {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.round(value * 1000) / 1000;
}

function formatQty(value: number) {
  const rounded = normalizeQuantityValue(value, 0);
  return Number.isInteger(rounded)
    ? rounded.toLocaleString()
    : rounded.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function formatQtyWithUnit(value: number, unit?: string) {
  const label = String(unit || "PIECE").toLowerCase();
  return `${formatQty(value)} ${label}`;
}

function formatRequestDateTime(value?: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getRequestCustomerLabel(request: BillingDraftRequest) {
  return (
    request.customer?.name ||
    request.customerName ||
    (request.customerPhone ? `Phone ${request.customerPhone}` : "") ||
    "Walk-in customer"
  );
}

function getRequestItemCount(request: BillingDraftRequest) {
  return request.itemCount ?? request.items?.length ?? 0;
}

function getRequestTotalQty(request: BillingDraftRequest) {
  if (typeof request.totalQty === "number") return request.totalQty;
  return (request.items || []).reduce(
    (sum, item) => sum + Number(item.acceptedQty ?? item.qty ?? 0),
    0,
  );
}

function getRequestEstimatedTotal(request: BillingDraftRequest) {
  if (typeof request.estimatedTotal === "number") {
    return request.estimatedTotal;
  }
  return (request.items || []).reduce((sum, item) => {
    const qty = Number(item.acceptedQty ?? item.qty ?? 0);
    return sum + qty * Number(item.product?.retailPrice || 0);
  }, 0);
}

function getRequestStatusLabel(request: BillingDraftRequest) {
  if (
    (request.status === "PENDING" || request.status === "MODIFIED") &&
    !request.firstViewedAt
  ) {
    return "Queued";
  }
  if (request.status === "PENDING") return "Viewed";
  if (request.status === "MODIFIED") return "Changed";
  if (request.status === "ACCEPTED") return "Accepted";
  if (request.status === "PARTIALLY_ACCEPTED") return "Partially accepted";
  return request.status
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function getProductQtyStep(product?: Product | null) {
  if (!product) return 1;
  const step = Number(product.quantityStep || 1);
  return product.allowFractionalQty ? normalizeQuantityValue(step, 0.001) : 1;
}

function getProductMinQty(product?: Product | null) {
  return getProductQtyStep(product);
}

function normalizeProductCartQty(product: Product, value: number) {
  const minQty = getProductMinQty(product);
  const maxQty = Math.max(minQty, product.stock || minQty);
  const clamped = clampNumber(
    normalizeQuantityValue(value, minQty),
    minQty,
    maxQty,
  );

  if (!product.allowFractionalQty) {
    return Math.max(minQty, Math.min(maxQty, Math.round(clamped)));
  }

  const step = getProductQtyStep(product);
  const stepped = Math.round(clamped / step) * step;
  return normalizeQuantityValue(clampNumber(stepped, minQty, maxQty), minQty);
}

function formatProductSize(product: Product) {
  if (
    !product.sizeValue ||
    !product.sizeUnit ||
    product.sizeUnit === "STANDARD"
  ) {
    return "";
  }
  return `${formatQty(product.sizeValue)} ${product.sizeUnit.toLowerCase()}`;
}

// this checks what kind of discount the selected customer gets
// we prioritize admin wholesale first, then fallback to loyalty
function getCustomerDiscountMode(c: Customer | null) {
  if (!c) return "NONE" as const;
  if ((c.wholesalePercent || 0) > 0) return "ADMIN_WHOLESALE" as const;
  if ((c.loyaltyPercent || 0) > 0) return "LOYALTY" as const;
  return "NONE" as const;
}

// wholesale pricing has two modes that cannot both be active at the same time:
// 1. customer-level wholesale % — admin assigns a discount percent to the customer
// 2. qty-based wholesale — the product switches to wholesale price if quantity meets the threshold
// this function only handles case 2, and it returns false when case 1 is active
// because both modes applying together would give a double discount
function shouldUseQuantityWholesalePrice(
  customer: Customer | null,
  product: Product,
  qty: number,
) {
  const hasCustomerWholesale =
    clampPercent(customer?.wholesalePercent || 0) > 0;
  if (hasCustomerWholesale) return false;
  if (!product.wholesaleEligible) return false;
  return qty >= Math.max(1, product.wholesaleQtyThreshold || 1);
}

function getSubtotalDiscountMeta(customer: Customer | null) {
  // this decides which subtotal-level discount label and helper text should be shown in the billing summary
  const wholesalePercent = clampPercent(customer?.wholesalePercent || 0);
  if (wholesalePercent > 0) {
    return {
      mode: "ADMIN_WHOLESALE" as const,
      percent: wholesalePercent,
      label: `Customer Wholesale (${wholesalePercent}%)`,
      helper:
        "Customer wholesale discount is applied on subtotal and disables quantity-based wholesale pricing.",
    };
  }

  const loyaltyPercent = clampPercent(customer?.loyaltyPercent || 0);
  if (loyaltyPercent > 0) {
    return {
      mode: "LOYALTY" as const,
      percent: loyaltyPercent,
      label: `Loyalty Discount (${loyaltyPercent}%)`,
      helper:
        "Quantity-based wholesale pricing can still apply on items before loyalty is deducted from subtotal.",
    };
  }

  return {
    mode: "NONE" as const,
    percent: 0,
    label: "Discount",
    helper: "No customer-specific subtotal discount is active.",
  };
}

// this is the shared button component used across the billing page and payment modal
function Button({
  children,
  variant = "secondary",
  onClick,
  disabled,
  icon,
  className,
  size = "md",
  title,
  fullWidth,
}: {
  children?: React.ReactNode;
  variant?: "primary" | "secondary" | "danger" | "ghost" | "success";
  onClick?: () => void;
  disabled?: boolean;
  icon?: string;
  className?: string;
  size?: "sm" | "md" | "lg" | "xl";
  title?: string;
  fullWidth?: boolean;
}) {
  const base =
    "inline-flex items-center justify-center gap-[8px] rounded-[14px] border font-bold transition active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-offset-2";
  const sizes = {
    sm: "px-[12px] py-[8px] text-[12px]",
    md: "px-[16px] py-[11px] text-[13px]",
    lg: "px-[20px] py-[13px] text-[15px]",
    xl: "px-[24px] py-[17px] text-[17px]",
  };
  const styles = {
    primary:
      "border-[#11120d] bg-[#11120d] text-white hover:bg-[#2a2c27] focus:ring-slate-300",
    secondary:
      "border-[#CFCFD3] bg-[#FFFFFF] text-[#565449] hover:bg-[#F3F4F6] hover:text-[#000000] focus:ring-slate-200",
    success:
      "border-[#9DD8B2] bg-[#179B4D] text-white hover:bg-[#138441] focus:ring-emerald-200",
    danger:
      "border-[#FECDD3] bg-[#FFF1F2] text-[#BE123C] hover:bg-rose-100 focus:ring-rose-200",
    ghost:
      "border-transparent bg-transparent text-[#565449] hover:bg-[#F3F4F6] hover:text-[#000000]",
  };

  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        base,
        sizes[size],
        styles[variant],
        fullWidth && "w-full",
        className,
        disabled && "opacity-40 pointer-events-none grayscale",
      )}
    >
      {icon ? (
        <Icon name={icon} className={children ? "" : "-mx-[2px]"} />
      ) : null}
      {children}
    </button>
  );
}

// this is the shared text input used for scanner input, search, and payment amount fields
function Input({
  value,
  onChange,
  placeholder,
  leftIcon,
  rightIcon,
  className,
  autoFocus,
  onEnter,
  onKeyDown,
  label,
  inputMode,
  inputRef,
  invalid,
  helperText,
  onBlur,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  leftIcon?: string;
  rightIcon?: string;
  className?: string;
  autoFocus?: boolean;
  onEnter?: () => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  label?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  inputRef?: React.RefObject<HTMLInputElement | null>;
  invalid?: boolean;
  helperText?: string;
  onBlur?: () => void;
}) {
  return (
    <div className={className}>
      {label ? (
        <label className="block text-[11px] font-extrabold text-slate-600 uppercase  mb-2 ml-1">
          {label}
        </label>
      ) : null}
      <div
        className={cn(
          "flex items-center gap-[10px] rounded-[10px] border bg-white px-[14px] py-[8px] transition",
          invalid
            ? "border-rose-300 focus-within:border-rose-400 focus-within:ring-2 focus-within:ring-rose-100"
            : "border-[#CFCFD3] focus-within:border-[#11120d] focus-within:ring-2 focus-within:ring-black/5",
        )}
      >
        {leftIcon ? (
          <Icon name={leftIcon} className="text-slate-400 transition-colors" />
        ) : null}
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
          aria-label={label || placeholder || "Input"}
          inputMode={inputMode}
          onKeyDown={(e) => {
            onKeyDown?.(e);
            if (e.defaultPrevented) return;
            // this handles Enter for fields that should trigger an immediate billing action
            if (e.key === "Enter" && onEnter) onEnter();
          }}
          className="w-full text-[14px] outline-none placeholder:text-slate-400 bg-transparent text-slate-900 font-semibold"
        />
        {rightIcon ? (
          <Icon name={rightIcon} className="text-slate-400 transition-colors" />
        ) : null}
      </div>
      {helperText ? (
        <div
          className={cn(
            "mt-2 ml-1 text-[12px] font-semibold",
            invalid ? "text-rose-600" : "text-slate-500",
          )}
        >
          {helperText}
        </div>
      ) : null}
    </div>
  );
}

// this renders the small status badges used for customer mode, payment hints, and stock indicators
function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "green" | "orange" | "sky" | "rose" | "purple";
}) {
  const map = {
    neutral: "bg-[#F3F4F6] text-[#565449] border-[#CFCFD3]",
    green: "bg-[#EAF8EF] text-[#179B4D] border-[#9DD8B2]",
    orange: "bg-[#FFF7E8] text-[#B7791F] border-[#F6D28B]",
    sky: "bg-slate-100 text-slate-700 border-slate-200",
    rose: "bg-[#FFF1F2] text-[#BE123C] border-[#FECDD3]",
    purple: "bg-slate-100 text-slate-700 border-slate-200",
  };

  return (
    <span
      className={cn(
        "rounded-[10px] border px-[10px] py-[4px] text-[11px] font-extrabold whitespace-nowrap",
        map[tone],
      )}
    >
      {children}
    </span>
  );
}

// this segmented control is used for payment method and payment status switches inside the modal
function Segmented({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="flex gap-2 rounded-[14px] border border-[#CFCFD3] bg-[#F3F4F6] p-[6px]">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "flex-1 rounded-[11px] py-2.5 text-[12px] font-extrabold transition",
              active
                ? "bg-[#FFFFFF] text-[#000000] "
                : "text-[#8C8889] hover:bg-[rgba(255,255,255,0.8)] hover:text-[#000000]",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// the POS billing module
// we wrote this to handle adding items to a cart, selecting customers, applying discounts, and generating invoices
export default function BillingPage() {
  const { showToast } = useToast();
  const [rateLimitRecoveryKey, setRateLimitRecoveryKey] = useState(0);
  const requestRateLimitRecovery = useRateLimitRecovery(() => {
    setRateLimitRecoveryKey((current) => current + 1);
  });
  const currentUser = useMemo(() => getAuthUser(), []);
  const [billingViewSize, setBillingViewSize] = useState<BillingViewSize>(() =>
    readStoredBillingViewSize(),
  );

  const isManager = currentUser?.role === "manager";
  const isCashier = currentUser?.role === "cashier";
  const operatorLabel = currentUser
    ? `${currentUser.name} (${currentUser.role.toUpperCase()})`
    : "Unknown operator";
  const terminalLabel = useMemo(() => {
    const configuredTerminal = (
      import.meta.env as Record<string, string | undefined>
    ).VITE_TERMINAL_LABEL;
    if (typeof window !== "undefined") {
      return (
        window.localStorage.getItem("khatasathi_terminal_label") ||
        configuredTerminal ||
        "POS-01"
      );
    }
    return configuredTerminal || "POS-01";
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(BILLING_VIEW_SIZE_STORAGE_KEY, billingViewSize);
  }, [billingViewSize]);

  function stepBillingViewSize(direction: -1 | 1) {
    setBillingViewSize((current) => {
      const index = BILLING_VIEW_SIZE_OPTIONS.indexOf(current);
      const nextIndex = clampNumber(
        index + direction,
        0,
        BILLING_VIEW_SIZE_OPTIONS.length - 1,
      );
      return BILLING_VIEW_SIZE_OPTIONS[nextIndex];
    });
  }
  const [searchParams] = useSearchParams();
  function setIsWorksheetOpen(open: boolean) { if (open) setActiveWorkspaceTab("worksheet"); }
  const [isCalculatorOpen, setIsCalculatorOpen] = useState(false);
  const [isCompactHistoryOpen, setIsCompactHistoryOpen] = useState(false);
  const [isDetailedHistoryOpen, setIsDetailedHistoryOpen] = useState(false);
  const [customerLookupLoading, setCustomerLookupLoading] = useState(false);
  const [customerLookupResults, setCustomerLookupResults] = useState<Customer[]>([]);
  const [customerLookupTotal, setCustomerLookupTotal] = useState(0);
  const [customerLookupError, setCustomerLookupError] = useState<string | null>(null);
  const [customerPanConflictWarning, setCustomerPanConflictWarning] = useState<string | null>(null);
  const [customerPanConflictMatches, setCustomerPanConflictMatches] = useState<Customer[]>([]);
  const [customerPanConflictPage, setCustomerPanConflictPage] = useState(1);
  const [customerPanConflictTotal, setCustomerPanConflictTotal] = useState(0);
  const [customerPanConflictServerTotal, setCustomerPanConflictServerTotal] = useState(0);
  const [customerPanConflictError, setCustomerPanConflictError] = useState<string | null>(null);
  const [customerPanConflictLoading, setCustomerPanConflictLoading] = useState(false);
  const [gatewayDisplay, setGatewayDisplay] = useState<GatewayDisplayResponse | null>(null);
  const [paperDraftBillNo, setPaperDraftBillNo] = useState("");
  const [paperDraftDocumentType, setPaperDraftDocumentType] = useState<ExternalDocumentType>("PAN_INVOICE");
  const [paperDraftBillDate, setPaperDraftBillDate] = useState(shopToday);
  const [paperDraftChoice, setPaperDraftChoice] = useState<"RECORD_AFTER_SAVE" | "LATER">("RECORD_AFTER_SAVE");
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<"billing" | "worksheet" | "history">("billing");
  const worksheetReviewRef = useRef<string | null>(null);
  const cartSessionRef = useRef(0);
  const [businessIdentity, setBusinessIdentity] = useState(() => ({ ...resolvePrintBusinessIdentity(), displayName: "Loading business information…" }));
  useEffect(() => {
    let live = true;
    getBusinessSettingsApi().then(settings => { if (live) setBusinessIdentity({ ...resolvePrintBusinessIdentity(settings), displayName: settings.businessName?.trim() || settings.legalName?.trim() || "Business name not configured" }); }).catch(() => { if (live) setBusinessIdentity({ ...resolvePrintBusinessIdentity(), displayName: "Business information unavailable" }); });
    return () => { live = false; };
  }, []);
  const [cartHistoryInvoiceId, setCartHistoryInvoiceId] = useState<string | null>(null);
  const [historyNavigation, setHistoryNavigation] = useState<HistoryNavigation>({ scope: "INVOICES", payment: "ALL", revision: 0 });
  function openWorkspaceHistory(scope: "INVOICES" | "CART_ITEMS" = "INVOICES", payment: "ALL" | "OUTSTANDING" = "ALL", invoiceId?: string) {
    setHistoryNavigation(current => ({ scope, payment, invoiceId, revision: current.revision + 1 }));
    setActiveWorkspaceTab("history");
  }
  const [mobileBillingPane, setMobileBillingPane] = useState<"cart" | "products" | "customer">("cart");
  const [isPaperException, setIsPaperException] = useState(false);
  const [paperExceptionReason, setPaperExceptionReason] = useState("");
  const [isOcrComparisonOpen, setIsOcrComparisonOpen] = useState(false);
  const [ocrSourceFile, setOcrSourceFile] = useState<File | null>(null);
  const [ocrSourceObservations, setOcrSourceObservations] = useState<BillScanObservations | null>(null);
  const [ocrCheckedFingerprint, setOcrCheckedFingerprint] = useState<string | null>(null);
  const [proofFollowup, setProofFollowup] = useState<{ invoiceId: string; invoiceNo?: string; file: File | null; error: string } | null>(() => {
    try { const actor = getAuthUser()?.id; const raw = window.sessionStorage.getItem(`khatasathi:pendingProof:${actor}`); const saved = raw ? JSON.parse(raw) : null;
      return saved && typeof saved.invoiceId === "string" ? { ...saved, file: null, error: "The original file did not survive reload. Select it again to attach to this saved sale." } : null;
    } catch { return null; }
  });
  const [proofRetrying, setProofRetrying] = useState(false);
  useEffect(() => {
    try { const key = `khatasathi:pendingProof:${getAuthUser()?.id}`;
      if (proofFollowup) window.sessionStorage.setItem(key, JSON.stringify({ invoiceId: proofFollowup.invoiceId, invoiceNo: proofFollowup.invoiceNo }));
      else window.sessionStorage.removeItem(key);
    } catch { /* Visible follow-up stays available even if browser storage is restricted. */ }
  }, [proofFollowup]);
  async function retryProofAttachment() {
    if (!proofFollowup?.file || proofRetrying) return;
    setProofRetrying(true);
    try { await uploadInvoiceProofApi(proofFollowup.invoiceId, proofFollowup.file); setProofFollowup(null); showToast("success", "Original proof attached to the saved sale."); }
    catch (error: any) { setProofFollowup(current => current ? { ...current, error: error?.message || "Proof upload failed; the sale is already saved. Retry attachment only." } : null); }
    finally { setProofRetrying(false); }
  }

  const [priceDifferItem, setPriceDifferItem] = useState<{
    item: CartTableItem;
    past: CustomerProductPurchaseHistoryItem[];
    anchor?: HTMLElement;
  } | null>(null);
  const [catalogCategory, setCatalogCategory] = useState("ALL");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogSort, setCatalogSort] = useState("popularity");
  const [catalogPage, setCatalogPage] = useState(1);
  const catalogPageSize = 15;
  const [fonepayConfirmed, setFonepayConfirmed] = useState(false);
  const [storageLimitationWarning, setStorageLimitationWarning] = useState<string | null>(null);
  const [manualPaymentInvoiceId, setManualPaymentInvoiceId] = useState<string | null>(null);
  const [savedSaleResult, setSavedSaleResult] = useState<{
    invoiceId: string;
    invoiceNo?: string;
    total: number;
    effectivePaidAmount: number;
    balanceDue: number;
    paymentMethod: PaymentMethod | string;
    paymentStatus: PaymentStatus;
    pendingGatewayAmount?: number;
    paperRecorded?: boolean;
    paperBillNo?: string;
    receivingDestinations?: ReceivingDestinationSnapshotV1[];
  } | null>(null);
  const [paperFollowup, setPaperFollowup] = useState<{
    status: "NONE" | "SUCCESS" | "FAILED_RETRYABLE" | "PENDING";
    invoiceId?: string;
    invoiceNo?: string;
    error?: string;
    draft?: {
      billNo: string;
      externalDocumentType: ExternalDocumentType;
      externalBillDate: string;
    };
    expected?: ExpectedManualBillRecord | null;
    conflictRecord?: ManualBillRecord | null;
    duplicateRequired?: boolean;
    duplicateOverrideReason?: string;
  }>({ status: "NONE" });
  const [paperFollowupBusy, setPaperFollowupBusy] = useState(false);
  const [isBannerEditing, setIsBannerEditing] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]); // full customer list available for billing selection
  const [quickCustomerDraft, setQuickCustomerDraft] = useState<QuickCustomerDraft>(
    { name: "", phone: "", email: "", panNo: "", address: "" },
  );
  const [quickCustomerOpen, setQuickCustomerOpen] = useState(false);
  const [quickCustomerPanAck, setQuickCustomerPanAck] = useState(false);
  const [quickCustomerBusy, setQuickCustomerBusy] = useState(false);
  const [quickCustomerError, setQuickCustomerError] = useState("");
  const quickCustomerBusyRef = useRef(false);
  const checkoutReviewBusyRef = useRef(false);
  const checkoutInputRevisionRef = useRef(0);
  const prevPanToCheckRef = useRef("");
  const currentUserRef = useRef(currentUser);
  currentUserRef.current = currentUser;
  const compactHistoryTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [products, setProducts] = useState<Product[]>([]); // active product list loaded for cart and search
  const [loading, setLoading] = useState(true); // tracks whether the initial data fetch is still running
  const [submitting, setSubmitting] = useState(false); // blocks repeated invoice creation while checkout is running
  const [showSuccess, setShowSuccess] = useState(false); // controls the success dialog after a bill is created
  const [lastCreatedInvoiceId, setLastCreatedInvoiceId] = useState<
    string | null
  >(() =>
    typeof window === "undefined"
      ? null
      : window.sessionStorage.getItem(LAST_INVOICE_PRINT_STORAGE_KEY),
  ); // saved so the cashier can reprint the most recent invoice in this browser session
  const [parkedDrafts, setParkedDrafts] = useState<ParkedDraft[]>([]); // cashier's held bills that can be resumed later
  const [showParkedBills, setShowParkedBills] = useState(false); // controls the parked bill drawer/modal
  const [incomingRequests, setIncomingRequests] = useState<BillingDraftRequest[]>([]);
  const [incomingRequestsTotal, setIncomingRequestsTotal] = useState(0);
  const [incomingRequestsLoading, setIncomingRequestsLoading] = useState(false);
  const [incomingRequestsError, setIncomingRequestsError] = useState("");
  const [showIncomingRequests, setShowIncomingRequests] = useState(false);
  const [selectedIncomingRequest, setSelectedIncomingRequest] =
    useState<BillingDraftRequest | null>(null);
  const [draftReviewDecisions, setDraftReviewDecisions] = useState<
    Record<string, DraftReviewDecision>
  >({});
  const [draftReviewErrors, setDraftReviewErrors] = useState<
    Record<string, string>
  >({});
  const [draftRejectNote, setDraftRejectNote] = useState("");
  const [draftRequestBusy, setDraftRequestBusy] = useState(false);
  const [acceptedResolution, setAcceptedResolution] = useState<{
    requestId: string;
    requestNo: string;
    clearCartAfter: boolean;
  } | null>(null);
  const [acceptedResolutionReason, setAcceptedResolutionReason] = useState("");
  const [acceptedResolutionError, setAcceptedResolutionError] = useState("");
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [parkedBusy, setParkedBusy] = useState(false); // prevents duplicate park/resume/discard requests
  const [parkedError, setParkedError] = useState(""); // parked bill API or validation errors
  const [pendingDiscardParked, setPendingDiscardParked] =
    useState<ParkedDraft | null>(null); // parked bill waiting for discard confirmation
  const [pendingStaleResume, setPendingStaleResume] =
    useState<ParkedDraft | null>(null); // parked bill waiting for stale price/stock confirmation
  const [cashierPrivilege, setCashierPrivilege] =
    useState<CashierPrivilege | null>(null); // controls cashier-only price override actions

  // this fetches every page of active products because the billing screen needs the full active catalog for search and barcode scans
  // extracted as a reusable callback so it can also be called by the periodic refresh interval
  // mapping the raw API product response into the exact shape the billing cart logic expects
  const mapRawProducts = useCallback((raw: any[]) => {
    return raw.map((p: any) => ({
      id: p.id,
      name: p.name,
      sku: p.sku || "",
      barcode: p.barcode || "",
      brand: p.brand?.name || "",
      categoryGroup: p.categoryGroup || p.category || "",
      productCodeVariant: p.productCodeVariant || "",
      sizeValue:
        p.sizeValue === null || p.sizeValue === undefined
          ? null
          : Number(p.sizeValue),
      sizeUnit: p.sizeUnit || "STANDARD",
      packageQuantity: Number(p.packageQuantity ?? 1),
      packageUnit: p.packageUnit || "PIECE",
      saleUnit: p.saleUnit || "PIECE",
      allowFractionalQty: Boolean(p.allowFractionalQty),
      quantityStep: Number(p.quantityStep ?? 1),
      wholesaleEligible: p.wholesaleEligible !== false,
      retailPrice: p.retailPrice || 0,
      sellingPriceStatus: p.sellingPriceStatus,
      wholesalePrice: p.wholesalePrice || 0,
      wholesaleQtyThreshold: p.wholesaleQtyThreshold || 1,
      stock: Number(p.availableStock ?? p.stock ?? 0),
      actualStock: Number(p.stock ?? 0),
      reservedStock: Number(p.reservedStock ?? 0),
      lowStockThreshold: p.lowStockThreshold || 0,
      active: p.isActive !== false,
      imageUrl: p.imageUrl || "",
    }));
  }, []);

  const mergeProducts = useCallback((incoming: Product[]) => {
    if (incoming.length === 0) return;
    setProducts((current) => {
      const merged = new Map(current.map((product) => [product.id, product]));
      incoming.forEach((product) => merged.set(product.id, product));
      return [...merged.values()];
    });
  }, []);

  const fetchProductsByIds = useCallback(
    async (ids: string[], options?: { signal?: AbortSignal }) => {
      const uniqueIds = [...new Set(ids.filter(Boolean))];
      const collected: any[] = [];
      for (let index = 0; index < uniqueIds.length; index += 50) {
        const response = await getProductsByIdsApi(
          uniqueIds.slice(index, index + 50),
          options,
        );
        collected.push(
          ...(Array.isArray(response?.products) ? response.products : []),
        );
      }
      return collected;
    },
    [],
  );

  const mapRawCustomers = useCallback((raw: any[]) => {
    return raw.map((c: any) => ({
      id: c.id,
      name: c.name,
      phone: c.phone || "",
      email: c.email,
      panNo: c.panNo || c.panNumber || null,
      address: c.address || null,
      isActive: c.isActive !== false,
      isLoyalty: (c.loyaltyPercent || 0) > 0,
      loyaltyPercent: c.loyaltyPercent,
      wholesalePercent: c.wholesalePercent,
    }));
  }, []);

  const normalizeParkedDraft = useCallback((raw: any): ParkedDraft => {
    return {
      id: String(raw?.id || ""),
      invoiceNo: raw?.invoiceNo || "",
      parkedLabel: raw?.parkedLabel || null,
      parkedAt: raw?.parkedAt || null,
      customerId: raw?.customerId || raw?.customer?.id || null,
      customer: raw?.customer || null,
      subTotal: Number(raw?.subTotal || 0),
      staleWarnings: Array.isArray(raw?.staleWarnings)
        ? raw.staleWarnings.map((warning: any) => ({
            productId: String(warning?.productId || ""),
            productName: String(warning?.productName || "Unknown product"),
            sku: warning?.sku || null,
            qty: normalizeQuantityValue(Number(warning?.qty || 0), 0),
            parkedUnitPrice: Number(warning?.parkedUnitPrice || 0),
            currentUnitPrice: Number(warning?.currentUnitPrice || 0),
            availableStock: normalizeQuantityValue(
              Number(warning?.availableStock || 0),
              0,
            ),
            warnings: Array.isArray(warning?.warnings)
              ? warning.warnings.map((item: unknown) => String(item))
              : [],
          }))
        : [],
      items: Array.isArray(raw?.items)
        ? raw.items
            .map((item: any) => ({
              productId: String(item?.productId || item?.product?.id || ""),
              qty: normalizeQuantityValue(Number(item?.qty || 1)),
              product: item?.product || null,
            }))
            .filter((item: { productId: string }) => item.productId)
        : [],
    };
  }, []);

  const loadParkedDrafts = useCallback(async () => {
    const data = await listParkedDraftsApi();
    const drafts = Array.isArray(data?.drafts) ? data.drafts : [];
    setParkedDrafts(drafts.map(normalizeParkedDraft));
  }, [normalizeParkedDraft]);

  const loadIncomingRequests = useCallback(
    async (options?: { signal?: AbortSignal }) => {
      if (!isCashier) return;
      setIncomingRequestsLoading(true);
      setIncomingRequestsError("");
      try {
        const data = await listDraftRequestsApi(
          {
            status: "ACTIONABLE",
            mode: "list",
            page: 1,
            pageSize: 50,
          },
          options,
        );
        const requests = Array.isArray(data.requests) ? data.requests : [];
        setIncomingRequests(requests);
        setIncomingRequestsTotal(Number(data.total ?? requests.length));
      } catch (error: any) {
        if (options?.signal?.aborted || error?.code === "ERR_CANCELED") return;
        if (isRateLimitError(error)) requestRateLimitRecovery();
        setIncomingRequestsError(
          error?.response?.data?.error ||
            "Incoming requests could not be refreshed.",
        );
      } finally {
        if (!options?.signal?.aborted) setIncomingRequestsLoading(false);
      }
    },
    [isCashier],
  );

  useEffect(() => {
    if (!isCashier) return undefined;
    const controller = new AbortController();
    void loadIncomingRequests({ signal: controller.signal });
    const interval = window.setInterval(
      () => void loadIncomingRequests(),
      45_000,
    );
    function refreshOnFocus() {
      if (document.visibilityState === "visible") {
        void loadIncomingRequests();
      }
    }
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnFocus);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnFocus);
    };
  }, [isCashier, loadIncomingRequests]);

  // Keep legacy pending-completion evidence for manual reconciliation. It cannot
  // prove checkout origin and must never trigger an automatic association.

  // fetching products and customers when the page first loads
  // we use Promise.allSettled so one failing API call does not block the other from completing
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const [prodData, custData, parkedData, privilegeData] = await Promise.allSettled([
          listProductsApi({ active: "true", page: 1, pageSize: 100, sortBy: "popularity" }, { signal: controller.signal }),
          listCustomersApi(true, { signal: controller.signal }),
          listParkedDraftsApi({ signal: controller.signal }),
          getMyCashierPrivilegesApi({ signal: controller.signal }),
        ]);

        if (prodData.status === "fulfilled" && prodData.value) {
          const raw = Array.isArray(prodData.value) ? prodData.value : (prodData.value.products || []);
          mergeProducts(mapRawProducts(raw));
        }

        if (custData.status === "fulfilled" && custData.value) {
          // mapping customers into a lighter billing shape keeps the rest of the page simpler
          const raw = Array.isArray(custData.value)
            ? custData.value
            : custData.value.customers || [];
          setCustomers(mapRawCustomers(raw));
        }

        if (parkedData.status === "fulfilled" && parkedData.value) {
          const drafts = Array.isArray(parkedData.value?.drafts)
            ? parkedData.value.drafts
            : [];
          setParkedDrafts(drafts.map(normalizeParkedDraft));
        }

        if (privilegeData.status === "fulfilled") {
          setCashierPrivilege(privilegeData.value.privilege);
        }

        const rejected = [custData, parkedData, privilegeData, prodData].find(
          (result) => result.status === "rejected" && isRateLimitError(result.reason),
        );
        if (rejected) requestRateLimitRecovery();
      } catch {
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();

    function refreshCustomersOnFocus() {
      if (document.visibilityState === "visible") {
        void listCustomersApi(true)
          .then((custData) => {
            if (custData) {
              const raw = Array.isArray(custData)
                ? custData
                : custData.customers || [];
              setCustomers(mapRawCustomers(raw));
            }
          })
          .catch(() => {});
      }
    }

    window.addEventListener("focus", refreshCustomersOnFocus);
    document.addEventListener("visibilitychange", refreshCustomersOnFocus);

    return () => {
      controller.abort();
      window.removeEventListener("focus", refreshCustomersOnFocus);
      document.removeEventListener("visibilitychange", refreshCustomersOnFocus);
    };
  }, [mapRawCustomers, normalizeParkedDraft, rateLimitRecoveryKey]);

  const [skuInput, setSkuInput] = useState(""); // scanner/manual barcode input
  const [productQuery, setProductQuery] = useState(""); // text search for the product picker
  const [manualSearchProductIds, setManualSearchProductIds] = useState<string[]>([]);
  const [manualSearchTotal, setManualSearchTotal] = useState(0);
  const [manualSearchLoading, setManualSearchLoading] = useState(false);
  const [manualSearchError, setManualSearchError] = useState("");
  const [manualSearchIndex, setManualSearchIndex] = useState(0);
  const [openRowActionProductId, setOpenRowActionProductId] = useState<
    string | null
  >(null);
  const [isCustomerSearchOpen, setCustomerSearchOpen] = useState(false); // controls the customer search modal/dropdown
  const [customerQuery, setCustomerQuery] = useState(""); // search text inside the customer picker
  const [customerSearchIndex, setCustomerSearchIndex] = useState(0);
  const [selectedCartRowIndex, setSelectedCartRowIndex] = useState(-1);
  const cartNavigationFrameRef = useRef<number | null>(null);
  const queuedCartNavigationRef = useRef<Array<(index: number) => number>>([]);
  useEffect(() => () => { if (cartNavigationFrameRef.current !== null) cancelAnimationFrame(cartNavigationFrameRef.current); }, []);
  function queueCartNavigation(change: (index: number) => number) {
    queuedCartNavigationRef.current.push(change);
    if (cartNavigationFrameRef.current !== null) return;
    cartNavigationFrameRef.current = requestAnimationFrame(() => {
      cartNavigationFrameRef.current = null;
      const changes = queuedCartNavigationRef.current.splice(0);
      setSelectedCartRowIndex(index => changes.reduce((value, apply) => apply(value), index));
    });
  }

  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(
    null,
  );
  const [activeDraftInvoiceId, setActiveDraftInvoiceId] = useState<
    string | null
  >(null); // parked draft currently loaded into the billing cart, if any
  const [activeDraftRequestId, setActiveDraftRequestId] = useState<
    string | null
  >(null); // accepted staff request currently loaded into the billing cart
  const [cart, setCart] = useState<CartLine[]>([]); // raw cart lines before product details and pricing are joined in
  const [customerHistory, setCustomerHistory] = useState<CustomerProductPurchaseHistoryItem[]>([]);
  const [customerHistoryLoading, setCustomerHistoryLoading] = useState(false);
  const [customerHistoryError, setCustomerHistoryError] = useState<string | null>(null);
  const [pendingCheckout, setPendingCheckout] =
    useState<PendingCheckoutSnapshot | null>(null);
  const pendingCheckoutRef = useRef<PendingCheckoutSnapshot | null>(null);
  pendingCheckoutRef.current = pendingCheckout;
  const [reviewedCandidate, setReviewedCandidate] =
    useState<ReviewedCheckoutCandidate | null>(null);
  const [priceOverrideTargetId, setPriceOverrideTargetId] = useState<
    string | null
  >(null);
  const [priceOverrideDraftPrice, setPriceOverrideDraftPrice] = useState("");
  const [priceOverrideDraftReason, setPriceOverrideDraftReason] = useState("");
  const [priceOverrideDraftPin, setPriceOverrideDraftPin] = useState("");
  const [priceOverrideError, setPriceOverrideError] = useState("");
  const [priceOverrideBusy, setPriceOverrideBusy] = useState(false);
  const [isQrGalleryOpen, setIsQrGalleryOpen] = useState(false);
  const [enabledPaymentAccounts, setEnabledPaymentAccounts] = useState<EnabledPaymentAccountDto[]>([]);
  const [enabledAccountsLoading, setEnabledAccountsLoading] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("Cash"); // current payment method selected in the modal
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>("Paid"); // current paid/partial/unpaid selection
  const [paidAmount, setPaidAmount] = useState<string>(""); // manual partial payment amount typed by the cashier
  const [cashTendered, setCashTendered] = useState<string>(""); // cash received from customer, used to calculate change
  const [fonepayReference, setFonepayReference] = useState<string>(""); // manual Fonepay reference/remarks recorded with the invoice payment
  const [bankTransferReference, setBankTransferReference] = useState<string>("");
  const [receivingAccountId, setReceivingAccountId] = useState<string>("");
  const [receivingAccountVersion, setReceivingAccountVersion] = useState<number | null>(null);
  const [receivingAccountLabel, setReceivingAccountLabel] = useState<string>("");
  const [manualReceiptConfirmed, setManualReceiptConfirmed] = useState<boolean>(false);
  const [splitCashAmount, setSplitCashAmount] = useState<string>(""); // cash portion when the bill is split between cash and eSewa
  const [splitPayments, setSplitPayments] = useState<SplitPaymentDraft[]>([]);

  const loadEnabledPaymentAccounts = useCallback(async (options?: { force?: boolean; signal?: AbortSignal }) => {
    setEnabledAccountsLoading(true);
    try {
      const list = await getEnabledPaymentAccountsApi({ signal: options?.signal });
      const safeList = Array.isArray(list) ? list : [];
      setEnabledPaymentAccounts(safeList);
      return safeList;
    } catch {
      return [];
    } finally {
      setEnabledAccountsLoading(false);
    }
  }, []);
  const [invoiceNote, setInvoiceNote] = useState("");
  const [paymentError, setPaymentError] = useState(""); // payment modal validation message
  const [billingError, setBillingError] = useState(""); // main billing error shown above the cart or form
  const [cartIssueMessage, setCartIssueMessage] = useState(""); // short-lived product lookup/cart guidance
  const [draftRequestNoticeVisible, setDraftRequestNoticeVisible] =
    useState(false);
  const [stockRefreshBusy, setStockRefreshBusy] = useState(false); // blocks final confirmation while the latest catalog is being checked
  const [stockConflicts, setStockConflicts] = useState<StockConflict[]>([]); // product rows that need cashier resolution after stale stock is detected
  const [showPaymentModal, setShowPaymentModal] = useState(false); // controls the final payment confirmation modal
  const [pendingBillingConfirm, setPendingBillingConfirm] =
    useState<PendingBillingConfirm>(null); // stores billing actions that need one last confirmation click
  const [showEsewaQr, setShowEsewaQr] = useState(true); // keeps the eSewa QR panel visible when that method is chosen
  const [cartPersistenceReady, setCartPersistenceReady] = useState(false); // prevents the autosave effect from clearing storage before the first restore pass finishes
  const manualResultRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const customerResultRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const cartRowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const pendingCartFocusProductIdRef = useRef<string | null>(null);
  const scannerLookupBusyRef = useRef(false);
  const cartAlertMessage = billingError || cartIssueMessage;

  async function handleQuickCustomerSubmit(
    event: React.FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    if (quickCustomerBusyRef.current) return;
    quickCustomerBusyRef.current = true;
    setQuickCustomerBusy(true);
    setQuickCustomerError("");
    try {
      const created = await createQuickCustomerApi({
        name: quickCustomerDraft.name,
        ...(quickCustomerDraft.phone.trim()
          ? { phone: quickCustomerDraft.phone }
          : {}),
        ...(quickCustomerDraft.email.trim()
          ? { email: quickCustomerDraft.email }
          : {}),
        ...(quickCustomerDraft.panNo.trim()
          ? { panNo: quickCustomerDraft.panNo }
          : {}),
        ...(quickCustomerDraft.address.trim()
          ? { address: quickCustomerDraft.address }
          : {}),
      });
      const customer = mapRawCustomers([created])[0];
      setCustomers((current) => [
        ...current.filter((item) => item.id !== customer.id),
        customer,
      ]);
      setSelectedCustomerId(customer.id);
      setCustomerSearchOpen(false);
      setCustomerQuery("");
      setQuickCustomerOpen(false);
      setQuickCustomerDraft({
        name: "",
        phone: "",
        email: "",
        panNo: "",
        address: "",
      });
      showToast("success", "Customer added and selected.");
    } catch (error: any) {
      setQuickCustomerError(
        error?.response?.data?.error || "Could not add customer. Your entries are still here; check them and try again.",
      );
    } finally {
      quickCustomerBusyRef.current = false;
      setQuickCustomerBusy(false);
    }
  }

  const visibleParkedDrafts = useMemo(() => {
    if (!activeDraftInvoiceId) return parkedDrafts;
    return parkedDrafts.filter((draft) => draft.id !== activeDraftInvoiceId);
  }, [activeDraftInvoiceId, parkedDrafts]);
  const unseenIncomingRequestCount = useMemo(
    () =>
      incomingRequests.filter(
        (request) =>
          (request.status === "PENDING" || request.status === "MODIFIED") &&
          !request.firstViewedAt,
      ).length,
    [incomingRequests],
  );

  const skuRef = useRef<HTMLInputElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const priceOverridePinRef = useRef<HTMLInputElement | null>(null);
  const [billClock, setBillClock] = useState(() => new Date());

  useEffect(() => {
    if (!cartIssueMessage) return undefined;
    const timer = window.setTimeout(() => setCartIssueMessage(""), 5000);
    return () => window.clearTimeout(timer);
  }, [cartIssueMessage]);

  useEffect(() => {
    if (!billingError || stockConflicts.length > 0) return undefined;
    const timer = window.setTimeout(() => setBillingError(""), 7000);
    return () => window.clearTimeout(timer);
  }, [billingError, stockConflicts.length]);

  useEffect(() => {
    if (!activeDraftRequestId) {
      setDraftRequestNoticeVisible(false);
      return undefined;
    }

    if (
      isDraftRequestNoticeAcknowledged(currentUser?.id, activeDraftRequestId)
    ) {
      setDraftRequestNoticeVisible(false);
      return undefined;
    }

    setDraftRequestNoticeVisible(true);
    const timer = window.setTimeout(() => {
      acknowledgeDraftRequestNotice(currentUser?.id, activeDraftRequestId);
      setDraftRequestNoticeVisible(false);
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [activeDraftRequestId, currentUser?.id]);

  useEffect(() => {
    const timer = window.setInterval(() => setBillClock(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const billDateLabel = useMemo(
    () =>
      billClock.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
    [billClock],
  );

  const billTimeLabel = useMemo(
    () =>
      billClock.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    [billClock],
  );

  // finding the selected customer object once here keeps discount and label logic simple below
  const selectedCustomer = useMemo(() => {
    if (!selectedCustomerId) return null;
    const inList = customers.find((c) => c.id === selectedCustomerId);
    if (inList) return inList;
    const inLookup = customerLookupResults.find((c) => c.id === selectedCustomerId);
    return inLookup || null;
  }, [selectedCustomerId, customers, customerLookupResults]);

  function handleSelectCustomer(customer: Customer | null) {
    if (!customer) {
      setSelectedCustomerId(null);
      setReviewedCandidate(null);
      return;
    }
    setCustomers((prev) => {
      const idx = prev.findIndex((c) => c.id === customer.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], ...customer };
        return next;
      }
      return [customer, ...prev];
    });
    setSelectedCustomerId(customer.id);
    setReviewedCandidate(null);
  }

  const handleCloseCompactHistory = useCallback(() => {
    setIsCompactHistoryOpen(false);
  }, []);

  const handleOpenDetailedHistoryFromCompact = useCallback(() => {
    setIsCompactHistoryOpen(false);
    setIsDetailedHistoryOpen(true);
  }, []);

  const customerMode = getCustomerDiscountMode(selectedCustomer); // quick label for whether this customer uses loyalty, wholesale, or no special rate
  const subtotalDiscountMeta = useMemo(
    () => getSubtotalDiscountMeta(selectedCustomer),
    [selectedCustomer],
  );

  useEffect(() => {
    getPaymentGatewayDisplayApi()
      .then((res) => {
        if (res) setGatewayDisplay(res);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const resumeId = searchParams.get("resumePaperInvoiceId");
    if (!currentUser?.id) return;
    const stored = readStoredPaperFollowup(currentUser.id, resumeId || undefined);
    const invoiceIdToCheck = resumeId || stored?.invoiceId;

    if (!invoiceIdToCheck) {
      setPaperFollowup({ status: "NONE" });
      return;
    }

    const matchingStored =
      resumeId && stored && stored.invoiceId === resumeId
        ? stored
        : !resumeId
          ? stored
          : null;

    let cancelled = false;
    Promise.allSettled([
      getManualBillRecord(invoiceIdToCheck),
      getInvoiceApi(invoiceIdToCheck),
    ]).then(([recordResult, invoiceResult]) => {
      if (cancelled) return;
      if (getAuthUser()?.id !== currentUser.id) return;
      // A newer stored intent must not be replaced by this reconciliation read.
      if (matchingStored && JSON.stringify(readStoredPaperFollowup(currentUser.id, invoiceIdToCheck)) !== JSON.stringify(matchingStored)) return;
      const existing =
        recordResult.status === "fulfilled" ? recordResult.value : null;
      const invoiceData =
        invoiceResult.status === "fulfilled"
          ? ((invoiceResult.value as any)?.invoice || invoiceResult.value)
          : null;

      const isRecorded =
        existing &&
        (existing.billRecordStatus === "RECORDED" ||
          existing.billRecordStatus === "VERIFIED");

      if (invoiceData && invoiceData.id) {
        const paymentsList: any[] = Array.isArray(invoiceData.payments) ? invoiceData.payments : [];
        const successfulPayments = paymentsList.filter(
          (p: any) => p.status === "SUCCESS" || p.status === "COMPLETED" || (!p.status && p.method),
        );
        const pendingPayments = paymentsList.filter(
          (p: any) => p.status === "PENDING" || p.status === "INITIATED" || p.status === "IN_PROGRESS",
        );
        const pendingGatewayAmount = pendingPayments.reduce(
          (sum: number, p: any) => sum + Number(p.amount || 0),
          0,
        );

        let derivedMethod = (invoiceData.paymentMethod as string) || "";
        if (!derivedMethod && paymentsList.length > 0) {
          const uniqueMethods = Array.from(new Set(paymentsList.map((p: any) => p.method).filter(Boolean)));
          if (uniqueMethods.length === 1) {
            derivedMethod = uniqueMethods[0];
          } else if (uniqueMethods.length > 1) {
            derivedMethod = `Split (${uniqueMethods.join(" + ")})`;
          }
        }
        if (!derivedMethod) {
          derivedMethod = "Cash";
        }

        const netTotal = Number(invoiceData.netTotal ?? invoiceData.total ?? 0);
        const paidTotal = Number(
          invoiceData.paidTotal ??
          successfulPayments.reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0),
        );
        const balDue = Math.max(0, netTotal - paidTotal);

        const derivedStatus: PaymentStatus =
          (invoiceData.paymentStatus as PaymentStatus) ||
          (paidTotal >= netTotal && netTotal > 0 ? "Paid" : paidTotal > 0 ? "Partial" : "Unpaid");

        setLastCreatedInvoiceId(invoiceData.id);
        setSavedSaleResult({
          invoiceId: invoiceData.id,
          invoiceNo: invoiceData.invoiceNo,
          total: netTotal,
          effectivePaidAmount: paidTotal,
          balanceDue: balDue,
          paymentMethod: derivedMethod,
          paymentStatus: derivedStatus,
          pendingGatewayAmount: pendingGatewayAmount > 0 ? pendingGatewayAmount : undefined,
          paperRecorded: Boolean(isRecorded),
          paperBillNo: existing?.externalBillNo || matchingStored?.draft?.billNo,
          receivingDestinations: successfulPayments.map((p: any) => parseReceivingDestinationSnapshot(p.receivingDestinationSnapshot)).filter((snapshot): snapshot is ReceivingDestinationSnapshotV1 => snapshot !== null),
        });
        if (resumeId) {
          setShowSuccess(true);
        }
      }

      if (matchingStored) {
        // A recorded tuple alone cannot acknowledge a lost reference response:
        // replay the original expected intent through the audited endpoint.
        setPaperFollowup({
          status: matchingStored.error ? "FAILED_RETRYABLE" : "PENDING",
          invoiceId: matchingStored.invoiceId,
          invoiceNo: matchingStored.invoiceNo || invoiceData?.invoiceNo,
          error: matchingStored.error,
          draft: matchingStored.draft,
          expected: matchingStored.expected,
          duplicateOverrideReason: matchingStored.duplicateOverrideReason,
        });
      } else if (existing) {
        if (isRecorded && existing.externalBillNo) {
          setPaperFollowup({
            status: "SUCCESS",
            invoiceId: invoiceIdToCheck,
            invoiceNo: existing.invoiceNo || invoiceData?.invoiceNo,
            draft: {
              billNo: existing.externalBillNo,
              externalDocumentType:
                existing.externalDocumentType || "PAN_INVOICE",
              externalBillDate: existing.externalBillDate
                ? new Date(existing.externalBillDate).toLocaleDateString("en-CA")
                : new Date().toLocaleDateString("en-CA"),
            },
          });
        } else {
          // No stored intent: establish a new follow-up from authoritative state.
          const expected: ExpectedManualBillRecord = {
            billingChannel: existing.billingChannel,
            externalDocumentType: existing.externalDocumentType,
            externalBillNo: existing.externalBillNo,
            externalBillDate: existing.externalBillDate,
            billRecordStatus: existing.billRecordStatus,
          };
          setPaperFollowup({
            status: "PENDING",
            invoiceId: invoiceIdToCheck,
            invoiceNo:
              existing.invoiceNo ||
              invoiceData?.invoiceNo,
            draft: {
              billNo: existing.externalBillNo || "",
              externalDocumentType:
                existing.externalDocumentType || "PAN_INVOICE",
              externalBillDate: existing.externalBillDate
                ? new Date(existing.externalBillDate).toLocaleDateString("en-CA")
                : new Date().toLocaleDateString("en-CA"),
            },
            expected,
          });
        }
      } else {
          setPaperFollowup({
            status: "PENDING",
            invoiceId: invoiceIdToCheck,
            invoiceNo: invoiceData?.invoiceNo,
            error: "Unable to reach server to fetch manual bill record.",
            draft: {
              billNo: "",
              externalDocumentType: "PAN_INVOICE",
              externalBillDate: new Date().toLocaleDateString("en-CA"),
            },
            expected: null,
          });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [searchParams, currentUser?.id]);

  useEffect(() => {
    const query = customerQuery.trim();
    if (query.length < 2) {
      setCustomerLookupResults([]);
      setCustomerLookupTotal(0);
      setCustomerLookupLoading(false);
      setCustomerLookupError(null);
      return undefined;
    }

    const controller = new AbortController();
    setCustomerLookupLoading(true);
    setCustomerLookupError(null);

    const timer = window.setTimeout(async () => {
      try {
        const res = await lookupCustomersApi(
          { q: query, pageSize: 12 },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;

        const mapped = mapRawCustomers(res.items || []);
        setCustomerLookupResults(mapped);
        setCustomerLookupTotal(res.total || 0);
        setCustomerLookupError(null);
      } catch (err: any) {
        if (!controller.signal.aborted) {
          setCustomerLookupResults([]);
          setCustomerLookupTotal(0);
          setCustomerLookupError(
            "Customer lookup service unavailable. Please check connection.",
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setCustomerLookupLoading(false);
        }
      }
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [customerQuery, mapRawCustomers]);

  // Comprehensive PAN Conflict Check for search query, quick-create, or selected customer
  useEffect(() => {
    const panToCheck = (
      (quickCustomerOpen && quickCustomerDraft.panNo.trim())
        ? quickCustomerDraft.panNo.trim()
        : (isCustomerSearchOpen && /^\d{3,}$/.test(customerQuery.trim().replace(/\s+/g, "")))
          ? customerQuery.trim().replace(/\s+/g, "")
          : (selectedCustomer?.panNo?.trim() || "")
    ).replace(/\s+/g, "");

    if (!panToCheck || panToCheck.length < 3) {
      prevPanToCheckRef.current = "";
      setCustomerPanConflictWarning(null);
      setCustomerPanConflictMatches([]);
      setCustomerPanConflictTotal(0);
      setCustomerPanConflictServerTotal(0);
      setCustomerPanConflictError(null);
      setCustomerPanConflictLoading(false);
      return undefined;
    }

    const panTargetKey = `${quickCustomerOpen ? "quick" : isCustomerSearchOpen ? "search" : "selected"}:${selectedCustomerId || ""}:${panToCheck}`;
    let pageToFetch = customerPanConflictPage;
    if (prevPanToCheckRef.current !== panTargetKey) {
      prevPanToCheckRef.current = panTargetKey;
      pageToFetch = 1;
      setCustomerPanConflictPage(1);
    }

    const controller = new AbortController();
    setCustomerPanConflictLoading(true);
    setCustomerPanConflictError(null);

    const timer = window.setTimeout(async () => {
      try {
        const panRes = await lookupCustomersApi(
          { q: panToCheck, match: "pan", page: pageToFetch, pageSize: 20 },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;

        const rawItems = panRes.items || [];
        const mappedMatches = mapRawCustomers(rawItems);
        const isSelfMatch = !quickCustomerOpen && Boolean(
          selectedCustomerId && (
            rawItems.some((i) => i.id === selectedCustomerId) ||
            (selectedCustomer && selectedCustomer.id === selectedCustomerId && selectedCustomer.panNo?.replace(/\s+/g, "") === panToCheck)
          ),
        );
        const conflicts = quickCustomerOpen
          ? mappedMatches
          : mappedMatches.filter((item) => item.id !== selectedCustomerId);

        const serverTotal = typeof panRes.total === "number" ? panRes.total : rawItems.length;
        const reportedTotal = Math.max(0, serverTotal - (isSelfMatch ? 1 : 0));

        setCustomerPanConflictMatches(conflicts);
        setCustomerPanConflictTotal(reportedTotal);
        setCustomerPanConflictServerTotal(serverTotal);
        setCustomerPanConflictError(null);

        if (conflicts.length > 0 || reportedTotal > 0) {
          if (conflicts.length === 1 && reportedTotal === 1) {
            const m = conflicts[0];
            setCustomerPanConflictWarning(
              `PAN "${panToCheck}" is registered to customer "${m.name}" (${m.phone || "No phone"})${!m.isActive ? " [INACTIVE]" : ""}.`,
            );
          } else if (conflicts.length > 0) {
            const names = conflicts
              .slice(0, 3)
              .map(
                (m) =>
                  `"${m.name}" (${m.phone || "No phone"})${!m.isActive ? " [INACTIVE]" : ""}`,
              )
              .join(", ");
            const extra = reportedTotal > 3 ? ` and ${reportedTotal - 3} more` : "";
            setCustomerPanConflictWarning(
              `PAN "${panToCheck}" matches ${reportedTotal} customer(s): ${names}${extra}.`,
            );
          } else {
            setCustomerPanConflictWarning(
              `PAN "${panToCheck}" matches ${reportedTotal} customer(s) across other pages.`,
            );
          }
        } else {
          setCustomerPanConflictWarning(null);
        }
      } catch {
        if (!controller.signal.aborted) {
          setCustomerPanConflictWarning(
            "Unable to verify PAN conflicts (lookup service unavailable).",
          );
          setCustomerPanConflictError(
            "Unable to verify PAN conflicts (lookup service unavailable).",
          );
          setCustomerPanConflictMatches([]);
          setCustomerPanConflictTotal(0);
          setCustomerPanConflictServerTotal(0);
        }
      } finally {
        if (!controller.signal.aborted) {
          setCustomerPanConflictLoading(false);
        }
      }
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [customerQuery, quickCustomerDraft.panNo, quickCustomerOpen, selectedCustomer?.panNo, selectedCustomerId, isCustomerSearchOpen, customerPanConflictPage, mapRawCustomers]);

  // filtering the customer list based on the search query
  // we wrap this in useMemo so it only recalculates when the query or customers change
  const customerListFiltered = useMemo(() => {
    const s = customerQuery.trim().toLowerCase();
    if (!s) return customers;
    return customers.filter((c) =>
      (c.name + " " + c.phone + " " + (c.panNo || "")).toLowerCase().includes(s),
    );
  }, [customers, customerQuery]);

  const customerOptions = useMemo(() => {
    const opts: Array<
      { type: "CLEAR" } | { type: "CUSTOMER"; customer: Customer }
    > = [];
    if (selectedCustomerId) {
      opts.push({ type: "CLEAR" });
    }
    const seen = new Set<string>();
    customerListFiltered.forEach((c) => {
      seen.add(c.id);
      opts.push({ type: "CUSTOMER", customer: c });
    });
    customerLookupResults.forEach((c) => {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        opts.push({ type: "CUSTOMER", customer: c });
      }
    });
    customerPanConflictMatches.forEach((c) => {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        opts.push({ type: "CUSTOMER", customer: c });
      }
    });
    return opts;
  }, [selectedCustomerId, customerListFiltered, customerLookupResults, customerPanConflictMatches]);

  useEffect(() => {
    setCustomerSearchIndex(0);
  }, [customerQuery, isCustomerSearchOpen]);

  useEffect(() => {
    customerResultRefs.current.length = customerOptions.length;
    setCustomerSearchIndex((current) =>
      customerOptions.length === 0
        ? 0
        : Math.min(current, customerOptions.length - 1),
    );
  }, [customerOptions.length]);

  useEffect(() => {
    if (!isCustomerSearchOpen) return;
    const activeResult = customerResultRefs.current[customerSearchIndex];
    activeResult?.scrollIntoView({ block: "nearest" });
  }, [customerSearchIndex, customerOptions.length, isCustomerSearchOpen]);

  function handleCustomerSearchKeyDown(
    e: React.KeyboardEvent<HTMLInputElement>,
  ) {
    if (customerOptions.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCustomerSearchIndex((prev) =>
        Math.min(prev + 1, customerOptions.length - 1),
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCustomerSearchIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = customerOptions[customerSearchIndex];
      if (!opt) return;
      if (opt.type === "CLEAR") {
        handleSelectCustomer(null);
      } else {
        handleSelectCustomer(opt.customer);
      }
      setCustomerSearchOpen(false);
    }
  }

  useEffect(() => {
    const search = productQuery.trim();
    setManualSearchIndex(0);
    if (!search) {
      setManualSearchProductIds([]);
      setManualSearchTotal(0);
      setManualSearchLoading(false);
      setManualSearchError("");
      return undefined;
    }

    const controller = new AbortController();
    setManualSearchProductIds([]);
    setManualSearchTotal(0);
    setManualSearchLoading(true);
    setManualSearchError("");
    const timer = window.setTimeout(() => {
      void listProductsApi(
        { search, active: "true", page: 1, pageSize: MANUAL_SEARCH_LIMIT },
        { signal: controller.signal },
      )
        .then((response) => {
          if (controller.signal.aborted) return;
          const mapped = mapRawProducts(
            Array.isArray(response?.products) ? response.products : [],
          );
          mergeProducts(mapped);
          setManualSearchProductIds(mapped.map((product) => product.id));
          setManualSearchTotal(Number(response?.total ?? mapped.length));
        })
        .catch((error: any) => {
          if (controller.signal.aborted || error?.code === "ERR_CANCELED") return;
          if (isRateLimitError(error)) requestRateLimitRecovery();
          else setManualSearchError("Product search failed. Check the connection and try again.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setManualSearchLoading(false);
        });
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [mapRawProducts, mergeProducts, productQuery, rateLimitRecoveryKey]);

  const manualResults = useMemo(() => {
    const byId = new Map(products.map((product) => [product.id, product]));
    return manualSearchProductIds.flatMap((id) => {
      const product = byId.get(id);
      return product ? [product] : [];
    });
  }, [manualSearchProductIds, products]);

  useEffect(() => {
    setManualSearchIndex(0);
  }, [productQuery]);

  useEffect(() => {
    manualResultRefs.current.length = manualResults.length;
    setManualSearchIndex((current) =>
      manualResults.length === 0
        ? 0
        : Math.min(current, manualResults.length - 1),
    );
  }, [manualResults.length]);

  useEffect(() => {
    const activeResult = manualResultRefs.current[manualSearchIndex];
    activeResult?.scrollIntoView({ block: "nearest" });
  }, [manualSearchIndex, manualResults.length]);

  // this lookup table lets cart calculations find products by id without scanning the full products array every time
  const productsById = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products],
  );

  // Ref tracking live checkout inputs across renders
  const liveCheckoutInputsRef = useRef({
    cart,
    productsById,
    selectedCustomerId,
    selectedCustomer,
    discountPercent: subtotalDiscountMeta.percent,
    paymentMethod,
    paymentStatus,
    paidAmount,
    cashTendered,
    fonepayReference,
    bankTransferReference,
    receivingAccountId,
    receivingAccountVersion,
    receivingAccountLabel,
    manualReceiptConfirmed,
    splitPayments,
    activeDraftInvoiceId,
    activeDraftRequestId,
    invoiceNote,
  });
  liveCheckoutInputsRef.current = {
    cart,
    productsById,
    selectedCustomerId,
    selectedCustomer,
    discountPercent: subtotalDiscountMeta.percent,
    paymentMethod,
    paymentStatus,
    paidAmount,
    cashTendered,
    fonepayReference,
    bankTransferReference,
    receivingAccountId,
    receivingAccountVersion,
    receivingAccountLabel,
    manualReceiptConfirmed,
    splitPayments,
    activeDraftInvoiceId,
    activeDraftRequestId,
    invoiceNote,
  };

  // Tracking live changes to cart, customer, pricing metadata, or payments for fresh checkout validation
  useEffect(() => {
    checkoutInputRevisionRef.current++;
  }, [
    cart,
    selectedCustomerId,
    selectedCustomer,
    subtotalDiscountMeta.percent,
    paymentMethod,
    paymentStatus,
    paidAmount,
    cashTendered,
    fonepayReference,
    bankTransferReference,
    receivingAccountId,
    receivingAccountVersion,
    receivingAccountLabel,
    manualReceiptConfirmed,
    splitPayments,
    activeDraftInvoiceId,
    activeDraftRequestId,
    invoiceNote,
  ]);

  // restoring the saved cart once on mount keeps billing work intact even after route changes or refreshes
  useEffect(() => {
    const storedCart = readStoredBillingCart();
    if (storedCart?.cart.length) {
      setCart(storedCart.cart);
      setActiveDraftInvoiceId(storedCart.activeDraftInvoiceId || null);
      setActiveDraftRequestId(storedCart.activeDraftRequestId || null);
      setSelectedCustomerId(storedCart.selectedCustomerId || null);
      setPendingCheckout(storedCart.pendingCheckout || null);
      if (storedCart.pendingCheckout?.operationKey) {
        const storedDraft = readStoredPendingPaperDraft(
          storedCart.pendingCheckout.operationKey,
          currentUser?.id,
        );
        if (storedDraft) {
          setPaperDraftBillNo(storedDraft.draft.billNo);
          setPaperDraftDocumentType(storedDraft.draft.externalDocumentType);
          setPaperDraftBillDate(storedDraft.draft.externalBillDate);
          setPaperDraftChoice(storedDraft.draft.choice);
        }
      }
    }
    setCartPersistenceReady(true);
  }, [currentUser?.id]);

  const cartProductIds = useMemo(
    () => [...new Set(cart.map((line) => line.productId).filter(Boolean))],
    [cart],
  );

  useEffect(() => {
    if (!selectedCustomerId || cartProductIds.length === 0) {
      setCustomerHistory([]);
      setCustomerHistoryLoading(false);
      setCustomerHistoryError(null);
      return;
    }

    const controller = new AbortController();
    setCustomerHistory([]);
    setCustomerHistoryLoading(true);
    setCustomerHistoryError(null);

    const boundedProductIds = cartProductIds.slice(0, 20);

    getCustomerProductHistoryApi(selectedCustomerId, boundedProductIds, {
      signal: controller.signal,
    })
      .then((data) => {
        if (controller.signal.aborted) return;
        setCustomerHistory(data.history || []);
        setCustomerHistoryLoading(false);
        setCustomerHistoryError(null);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setCustomerHistory([]);
        setCustomerHistoryLoading(false);
        setCustomerHistoryError("Unable to load recent purchase history");
      });

    return () => {
      controller.abort();
    };
  }, [selectedCustomerId, cartProductIds]);

  // Restored and resumed carts may contain products that are not in the small
  // search cache yet. Hydrate just those rows in one focused request.
  useEffect(() => {
    const missingIds = cartProductIds.filter((id) => !productsById.has(id));
    if (missingIds.length === 0) return undefined;
    const controller = new AbortController();
    void fetchProductsByIds(missingIds, { signal: controller.signal })
      .then((raw) => {
        if (!controller.signal.aborted) {
          mergeProducts(mapRawProducts(raw));
        }
      })
      .catch((error: any) => {
        if (isRateLimitError(error)) requestRateLimitRecovery();
        // Checkout performs a final authoritative refresh and will surface any
        // missing or inactive product as a stock conflict.
      });
    return () => controller.abort();
  }, [cartProductIds, fetchProductsByIds, mapRawProducts, mergeProducts, productsById, rateLimitRecoveryKey]);

  // Keep only the active cart fresh. Search results are fetched on demand and
  // checkout performs another authoritative refresh before finalization.
  useEffect(() => {
    if (cartProductIds.length === 0) return undefined;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      void fetchProductsByIds(cartProductIds, { signal: controller.signal })
        .then((raw) => {
          if (!controller.signal.aborted) mergeProducts(mapRawProducts(raw));
        })
        .catch(() => {});
    }, PRODUCT_REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [cartProductIds, fetchProductsByIds, mapRawProducts, mergeProducts]);

  // Persisting the cart on every cart change makes route changes safe while still clearing storage when the cart is emptied
  useEffect(() => {
    if (selectedCartRowIndex >= cart.length) {
      setSelectedCartRowIndex(cart.length - 1);
    }
  }, [cart.length, selectedCartRowIndex]);

  useEffect(() => {
    if (!cartPersistenceReady) return;

    if (cart.length === 0 && !pendingCheckout) {
      clearStoredBillingCart();
      return;
    }

    writeStoredBillingCart(
      cart,
      activeDraftInvoiceId,
      selectedCustomerId,
      activeDraftRequestId,
      pendingCheckout,
    );
  }, [
    activeDraftInvoiceId,
    activeDraftRequestId,
    cart,
    cartPersistenceReady,
    pendingCheckout,
    selectedCustomerId,
  ]);

  const reviewFingerprint = useMemo(() => {
    return computeReviewFingerprint({
      cart,
      productsById,
      selectedCustomerId,
      selectedCustomer,
      discountPercent: subtotalDiscountMeta.percent,
      paymentMethod,
      paymentStatus,
      paidAmount,
      cashTendered,
      fonepayReference,
      bankTransferReference,
      receivingAccountId,
      receivingAccountVersion,
      receivingAccountLabel,
      manualReceiptConfirmed,
      splitPayments,
      activeDraftInvoiceId,
      activeDraftRequestId,
      invoiceNote,
    });
  }, [
    cart,
    productsById,
    selectedCustomerId,
    selectedCustomer,
    subtotalDiscountMeta.percent,
    paymentMethod,
    paymentStatus,
    paidAmount,
    cashTendered,
    fonepayReference,
    bankTransferReference,
    receivingAccountId,
    receivingAccountVersion,
    receivingAccountLabel,
    manualReceiptConfirmed,
    splitPayments,
    activeDraftInvoiceId,
    activeDraftRequestId,
    invoiceNote,
  ]);

  useEffect(() => {
    if (
      reviewedCandidate &&
      reviewedCandidate.fingerprint &&
      reviewedCandidate.fingerprint !== reviewFingerprint
    ) {
      setReviewedCandidate(null);
      if (pendingBillingConfirm === "checkout" && !pendingCheckout) {
        setPendingBillingConfirm(null);
      }
    }
  }, [reviewFingerprint, reviewedCandidate, pendingBillingConfirm, pendingCheckout]);

  // joining cart lines with product data here is what gives us unit price, pricing mode, and line totals for each row
  const cartRows = useMemo(() => {
    return cart.map((line) => {
      const p = productsById.get(line.productId);
      if (!p) {
        return {
          ...line,
          product: {
            id: line.productId,
            name: "Product unavailable",
            sku: "",
            barcode: "",
            stock: 0,
            reservedStock: 0,
            retailPrice: 0,
            wholesalePrice: 0,
            wholesaleEligible: false,
            unit: "PIECE" as const,
            active: false,
            quantityStep: 1,
          } as unknown as Product,
          isUnresolved: true,
          unresolvedReason: "UNAVAILABLE" as const,
          unitPrice: line.overrideUnitPrice ?? 0,
          baseUnitPrice: 0,
          overrideUnitPrice: line.overrideUnitPrice,
          overrideReason: line.overrideReason,
          overrideAuthorizationToken: line.overrideAuthorizationToken,
          priceType: "Retail" as const,
          lineTotal: (line.overrideUnitPrice ?? 0) * line.qty,
        };
      }
      const useWholesalePrice = shouldUseQuantityWholesalePrice(
        selectedCustomer,
        p,
        line.qty,
      );
      const baseUnitPrice = useWholesalePrice
        ? p.wholesalePrice
        : p.retailPrice;
      const overrideUnitPrice =
        line.overrideUnitPrice !== undefined &&
        Number.isFinite(line.overrideUnitPrice) &&
        line.overrideUnitPrice > 0
          ? line.overrideUnitPrice
          : undefined;
      const unit = overrideUnitPrice ?? baseUnitPrice;

      const isInactive = !p.active;
      const isInsufficientStock = line.qty > p.stock;
      const isInvalidStep = !isQuantityStepCompliant(line.qty, p.quantityStep);
      const isUnpriced = p.sellingPriceStatus === "PENDING";
      const isUnresolved = isInactive || isInsufficientStock || isInvalidStep || isUnpriced;
      const unresolvedReason = isUnpriced ? ("UNPRICED" as const) : isInactive
        ? ("INACTIVE" as const)
        : isInsufficientStock
          ? ("INSUFFICIENT_STOCK" as const)
          : isInvalidStep
            ? ("INVALID_STEP" as const)
            : null;

      return {
        ...line,
        product: p,
        isUnresolved,
        unresolvedReason,
        unitPrice: unit,
        baseUnitPrice,
        overrideUnitPrice,
        overrideReason: line.overrideReason,
        overrideAuthorizationToken: line.overrideAuthorizationToken,
        priceType: useWholesalePrice ? ("Wholesale" as const) : ("Retail" as const),
        lineTotal: unit * line.qty,
      };
    });
  }, [cart, productsById, selectedCustomer]);

  const subTotal = cartRows.reduce((a, r) => a + r.lineTotal, 0); // total before any customer-level subtotal discount is applied
  const priceOverrideRows = cartRows.filter(
    (row) => row.overrideUnitPrice !== undefined,
  );
  const hasPriceOverrides = priceOverrideRows.length > 0;
  const priceOverrideDifference = priceOverrideRows.reduce(
    (sum, row) => sum + (row.unitPrice - row.baseUnitPrice) * row.qty,
    0,
  );
  const overrideDiffAbs = Math.abs(priceOverrideDifference);
  const overrideDiffIsReduction = priceOverrideDifference < 0;
  const overrideDiffLabel = overrideDiffIsReduction
    ? "Price reduction"
    : "Price increase";
  const overrideDiffDisplay = `${overrideDiffIsReduction ? "-" : "+"}${formatBillingMoney(overrideDiffAbs)}`;
  const canUsePriceOverride =
    isManager || cashierPrivilege?.canOverrideBillingPrice === true;
  const priceOverrideTargetRow = priceOverrideTargetId
    ? cartRows.find((row) => row.productId === priceOverrideTargetId) || null
    : null;

  useEffect(() => {
    cartRowRefs.current.length = cartRows.length;
    const pendingProductId = pendingCartFocusProductIdRef.current;
    if (!pendingProductId) return;

    const nextIndex = cartRows.findIndex(
      (row) => row.productId === pendingProductId,
    );
    if (nextIndex >= 0) {
      setSelectedCartRowIndex(nextIndex);
      pendingCartFocusProductIdRef.current = null;
    }
  }, [cartRows]);

  useEffect(() => {
    if (selectedCartRowIndex < 0) return;
    cartRowRefs.current[selectedCartRowIndex]?.scrollIntoView({
      block: "nearest",
    });
  }, [cartRows.length, selectedCartRowIndex]);

  useEffect(() => {
    if (
      openRowActionProductId &&
      !cartRows.some((row) => row.productId === openRowActionProductId)
    ) {
      setOpenRowActionProductId(null);
    }
  }, [cartRows, openRowActionProductId]);

  useEffect(() => {
    if (!openRowActionProductId) return undefined;

    function handlePointerDown(event: PointerEvent) {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('[data-row-action-menu-root="true"]')) return;
      setOpenRowActionProductId(null);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [openRowActionProductId]);

  useEffect(() => {
    if (!priceOverrideTargetRow) return;
    const timer = window.setTimeout(() => {
      priceOverridePinRef.current?.focus();
    }, 80);
    return () => window.clearTimeout(timer);
  }, [priceOverrideTargetRow]);

  // we calculate the subtotal discount amount before grand total
  const subtotalDiscount = useMemo(() => {
    if (subtotalDiscountMeta.percent > 0) {
      return (
        Math.round(
          ((subTotal * subtotalDiscountMeta.percent) / 100 +
            Number.EPSILON) *
            100,
        ) / 100
      );
    }
    return 0;
  }, [subTotal, subtotalDiscountMeta.percent]);
  const totalVisibleSavings =
    subtotalDiscount + (overrideDiffIsReduction ? overrideDiffAbs : 0);

  const grandTotal = Math.max(0, subTotal - subtotalDiscount); // raw invoice total before cashier-facing NPR rounding
  const payableTotal = Math.round(grandTotal); // cashier-facing collection amount; keeps total, exact cash, and split suggestions consistent

  const paidNum = useMemo(() => {
    const n = Number(paidAmount);
    if (!Number.isFinite(n)) return 0;
    return n;
  }, [paidAmount]);

  const cashTenderedNum = useMemo(() => {
    const n = Number(cashTendered);
    if (!Number.isFinite(n)) return 0;
    return n;
  }, [cashTendered]);

  const normalizedSplitPayments = useMemo(() => {
    return splitPayments
      .map((payment) => {
        const amount = Number(payment.amount);
        const tenderedAmount = Number(payment.tenderedAmount);
        return {
          ...payment,
          amountNum: Number.isFinite(amount) ? amount : 0,
          tenderedNum: Number.isFinite(tenderedAmount) ? tenderedAmount : 0,
        };
      })
      .filter((payment) => payment.amountNum > 0);
  }, [splitPayments]);

  const splitTotal = useMemo(
    () =>
      normalizedSplitPayments.reduce(
        (sum, payment) => sum + payment.amountNum,
        0,
      ),
    [normalizedSplitPayments],
  );

  const splitCashNum = useMemo(() => {
    if (normalizedSplitPayments.length > 0) {
      return normalizedSplitPayments
        .filter((payment) => payment.method === "CASH")
        .reduce((sum, payment) => sum + payment.amountNum, 0);
    }
    const n = Number(splitCashAmount);
    if (!Number.isFinite(n)) return 0;
    return clampNumber(n, 0, payableTotal);
  }, [splitCashAmount, payableTotal, normalizedSplitPayments]);

  const splitEsewaAmount =
    normalizedSplitPayments.length > 0
      ? normalizedSplitPayments
          .filter((payment) => payment.method === "ESEWA")
          .reduce((sum, payment) => sum + payment.amountNum, 0)
      : Math.max(0, payableTotal - splitCashNum);
  const splitFonepayAmount =
    normalizedSplitPayments.length > 0
      ? normalizedSplitPayments
          .filter((payment) => payment.method === "FONEPAY")
          .reduce((sum, payment) => sum + payment.amountNum, 0)
      : 0;
  const splitBankTransferAmount =
    normalizedSplitPayments.length > 0
      ? normalizedSplitPayments
          .filter((payment) => payment.method === "BANK_TRANSFER")
          .reduce((sum, payment) => sum + payment.amountNum, 0)
      : 0;
  const splitDigitalAmount = splitEsewaAmount + splitFonepayAmount + splitBankTransferAmount;
  const splitBalance = Math.round((payableTotal - splitTotal) * 100) / 100;

  // payment status controls the real paid amount:
  // 1. Paid means the full grand total is treated as received
  // 2. Unpaid means nothing is received yet
  // 3. Partial uses the typed amount, clamped so it never goes below 0 or above the grand total
  const effectivePaidAmount =
    paymentMethod === "Split"
      ? payableTotal
      : paymentStatus === "Paid"
        ? payableTotal
        : paymentStatus === "Unpaid"
          ? 0
          : clampNumber(paidNum, 0, payableTotal);

  const balanceDue = Math.max(0, payableTotal - effectivePaidAmount); // remaining amount still due after the chosen payment state is applied
  const cashDueAmount =
    paymentMethod === "Split"
      ? splitCashNum
      : paymentMethod === "Cash" && paymentStatus === "Paid"
        ? payableTotal
        : 0;
  const changeDue =
    cashDueAmount > 0 ? Math.max(0, cashTenderedNum - cashDueAmount) : 0;
  const cashShort =
    cashDueAmount > 0 ? Math.max(0, cashDueAmount - cashTenderedNum) : 0;

  const showEsewaDetails =
    (paymentMethod === "eSewa" ||
      (paymentMethod === "Split" && splitEsewaAmount > 0)) &&
    paymentStatus !== "Unpaid";
  const isSplitBalanced = Math.abs(splitBalance) <= 0.01;
  const paymentStateTitle =
    paymentMethod === "Split"
      ? isSplitBalanced
        ? "Split balanced"
        : "Split needs review"
      : paymentStatus === "Unpaid"
        ? "Saved without payment"
        : paymentStatus === "Partial"
          ? "Partial payment"
          : paymentMethod === "Fonepay"
            ? "Fonepay collection"
            : paymentMethod === "Bank Transfer"
            ? "Bank Transfer collection"
            : paymentMethod === "eSewa"
            ? "eSewa collection"
            : cashShort > 0
              ? "Cash short"
              : changeDue > 0
                ? "Return change"
                : "Exact cash ready";
  const paymentStateDetail =
    paymentMethod === "Split"
      ? `Cash ${formatBillingMoney(splitCashNum)} + digital ${formatBillingMoney(splitDigitalAmount)}.`
      : paymentStatus === "Unpaid"
        ? "No payment recorded now."
        : paymentStatus === "Partial"
          ? `Balance due ${formatBillingMoney(balanceDue)}.`
          : paymentMethod === "Fonepay"
            ? `Collect ${formatBillingMoney(payableTotal)} by Fonepay.`
            : paymentMethod === "Bank Transfer"
            ? `Collect ${formatBillingMoney(payableTotal)} by Bank Transfer.`
            : paymentMethod === "eSewa"
            ? `Collect ${formatBillingMoney(payableTotal)} online.`
            : cashShort > 0
              ? `Need ${formatBillingMoney(cashShort)} more.`
              : changeDue > 0
                ? `Give ${formatBillingMoney(changeDue)} back.`
                : `Cash matches ${formatBillingMoney(payableTotal)}.`;
  const paymentStateTone =
    paymentMethod === "Cash" && paymentStatus === "Paid" && changeDue > 0
      ? "success"
      : paymentMethod === "Fonepay" && paymentStatus === "Paid"
        ? "fonepay"
      : paymentMethod === "Bank Transfer" && paymentStatus === "Paid"
        ? "bank_transfer"
      : paymentMethod === "eSewa" && paymentStatus === "Paid"
        ? "esewa"
        : paymentStatus === "Partial" ||
            paymentStatus === "Unpaid" ||
            !isSplitBalanced ||
            cashShort > 0
          ? "warning"
          : "info";

  const hasUnresolvedCartLines = useMemo(() => {
    return cartRows.some(
      (row) =>
        Boolean((row as any).isUnresolved) ||
        !row.product ||
        !row.product.active ||
        row.product.stock <= 0 ||
        row.qty > row.product.stock ||
        !isQuantityStepCompliant(row.qty, row.product.quantityStep),
    );
  }, [cartRows]);

  const canConfirm = pendingCheckout
    ? !submitting
    : cartRows.length > 0 &&
      !hasUnresolvedCartLines &&
      !submitting &&
      !stockRefreshBusy &&
      !parkedBusy &&
      !draftRequestBusy &&
      paperFollowup.status !== "FAILED_RETRYABLE" &&
      paperFollowup.status !== "PENDING"; // final guard for whether checkout can run right now
  const hasBillDraft =
    cartRows.length > 0 || !!selectedCustomer || !!skuInput || !!productQuery;

  // we use this helper so every cart-related validation message goes through one consistent state update
  function showCartIssue(message: string) {
    setCartIssueMessage(message);
  }

  function clearCartIssue() {
    setCartIssueMessage("");
  }

  function openPriceOverride(row: {
    productId: string;
    unitPrice: number;
    overrideReason?: string;
  }) {
    if (pendingCheckout) {
      setBillingError(
        "A submitted checkout is pending recovery. Retry checkout to recover the bill, or resolve it before modifying price overrides.",
      );
      return;
    }
    if (!canUsePriceOverride) {
      showToast(
        "danger",
        "Admin has not enabled price override for this cashier.",
      );
      return;
    }

    setPriceOverrideTargetId(row.productId);
    setPriceOverrideDraftPrice(String(row.unitPrice));
    setPriceOverrideDraftReason(
      row.overrideReason && PRICE_OVERRIDE_REASONS.includes(row.overrideReason)
        ? row.overrideReason
        : row.overrideReason
          ? "Other manager-approved correction"
          : "",
    );
    setPriceOverrideDraftPin("");
    setPriceOverrideError("");
    setBillingError("");
  }

  function closePriceOverride(force = false) {
    if (priceOverrideBusy && !force) return;
    setPriceOverrideTargetId(null);
    setPriceOverrideDraftPrice("");
    setPriceOverrideDraftReason("");
    setPriceOverrideDraftPin("");
    setPriceOverrideError("");
  }

  async function applyPriceOverride() {
    if (pendingCheckout) {
      setPriceOverrideError(
        "A submitted checkout is pending recovery. Complete retry before modifying price overrides.",
      );
      return;
    }
    if (!priceOverrideTargetId) return;

    const price = Math.round(Number(priceOverrideDraftPrice) * 100) / 100;
    const reason = priceOverrideDraftReason.trim();
    const pin = priceOverrideDraftPin.trim();
    setPriceOverrideError("");

    if (!Number.isFinite(price) || price <= 0) {
      setPriceOverrideError("Override price must be greater than zero.");
      return;
    }
    if (!reason) {
      setPriceOverrideError("Add a reason for the price override.");
      return;
    }
    if (!isManager && !/^\d{4}$/.test(pin)) {
      setPriceOverrideError("Enter the 4-digit override PIN.");
      return;
    }

    if (
      priceOverrideTargetRow &&
      Math.abs(price - priceOverrideTargetRow.baseUnitPrice) < 0.001
    ) {
      clearPriceOverride(priceOverrideTargetId);
      closePriceOverride(true);
      showToast("success", "Price matches the normal rate. Override cleared.");
      return;
    }

    try {
      setPriceOverrideBusy(true);
      const authorization = await authorizePriceOverrideApi({
        productId: priceOverrideTargetId,
        customerId: selectedCustomerId || undefined,
        qty: priceOverrideTargetRow?.qty || 1,
        overrideUnitPrice: price,
        overrideReason: reason.slice(0, 240),
        pin: isManager ? undefined : pin,
      });

      setCart((current) =>
        current.map((line) =>
          line.productId === priceOverrideTargetId
            ? {
                ...line,
                overrideUnitPrice: authorization.overrideUnitPrice,
                overrideReason: authorization.overrideReason,
                overrideAuthorizationToken: authorization.token,
              }
            : line,
        ),
      );
      closePriceOverride();
      showToast(
        "success",
        isManager
          ? "Manager price override applied."
          : "Price override verified.",
      );
    } catch (error: any) {
      setPriceOverrideError(
        error?.response?.data?.error ||
          error?.message ||
          "Could not verify the override PIN.",
      );
      setPriceOverrideDraftPin("");
      priceOverridePinRef.current?.focus();
    } finally {
      setPriceOverrideBusy(false);
    }
  }

  function clearPriceOverride(productId: string) {
    if (pendingCheckout) {
      setBillingError(
        "A submitted checkout is pending recovery. Retry checkout to recover the bill, or resolve it before modifying price overrides.",
      );
      return;
    }
    setCart((current) =>
      current.map((line) => {
        if (line.productId !== productId) return line;
        const {
          overrideUnitPrice: _price,
          overrideReason: _reason,
          overrideAuthorizationToken: _token,
          ...rest
        } = line;
        return rest;
      }),
    );
    setBillingError("");
  }

  function buildStockConflictsFromCart(
    cartLines: CartLine[],
    nextProducts: Product[],
  ) {
    const nextProductsById = new Map(
      nextProducts.map((product) => [product.id, product]),
    );
    const conflicts: StockConflict[] = [];

    cartLines.forEach((line) => {
      const product = nextProductsById.get(line.productId);

      if (!product) {
        conflicts.push({
          productId: line.productId,
          productName: "Unknown product",
          requestedQty: line.qty,
          availableStock: 0,
          reason: "NOT_FOUND",
        });
        return;
      }

      if (!product.active) {
        conflicts.push({
          productId: line.productId,
          productName: product.name,
          sku: product.sku,
          requestedQty: line.qty,
          availableStock: 0,
          reason: "INACTIVE",
        });
        return;
      }

      if (product.stock <= 0) {
        conflicts.push({
          productId: line.productId,
          productName: product.name,
          sku: product.sku,
          requestedQty: line.qty,
          availableStock: 0,
          reason: "OUT_OF_STOCK",
        });
        return;
      }

      if (line.qty > product.stock) {
        conflicts.push({
          productId: line.productId,
          productName: product.name,
          sku: product.sku,
          requestedQty: line.qty,
          availableStock: product.stock,
          reason: "INSUFFICIENT_STOCK",
        });
      }
    });

    return conflicts;
  }

  function normalizeApiStockConflicts(rawConflicts: unknown) {
    if (!Array.isArray(rawConflicts)) return [];

    return rawConflicts.map((raw: any) => {
      const fallbackProduct = productsById.get(String(raw?.productId || ""));
      return {
        productId: String(raw?.productId || fallbackProduct?.id || ""),
        productName: String(
          raw?.productName || fallbackProduct?.name || "Unknown product",
        ),
        sku: raw?.sku || fallbackProduct?.sku || null,
        requestedQty: Math.max(
          0,
          normalizeQuantityValue(Number(raw?.requestedQty || 0), 0),
        ),
        availableStock: Math.max(
          0,
          normalizeQuantityValue(Number(raw?.availableStock || 0), 0),
        ),
        reason:
          raw?.reason === "NOT_FOUND" ||
          raw?.reason === "INACTIVE" ||
          raw?.reason === "OUT_OF_STOCK" ||
          raw?.reason === "INSUFFICIENT_STOCK"
            ? raw.reason
            : "INSUFFICIENT_STOCK",
      } satisfies StockConflict;
    });
  }

  function showStockConflicts(nextConflicts: StockConflict[]) {
    setStockConflicts(nextConflicts);
    setPendingBillingConfirm(null);
    setBillingError(
      nextConflicts.length === 1
        ? `"${nextConflicts[0].productName}" no longer has enough stock.`
        : `${nextConflicts.length} cart items need stock review before checkout.`,
    );
  }

  async function refreshProductsForCheckout() {
    const raw = await fetchProductsByIds(cart.map((line) => line.productId));
    const mapped = mapRawProducts(raw);
    mergeProducts(mapped);
    return mapped;
  }

  // this checks how many units of one product are already in the current cart
  function getCurrentQty(productId: string) {
    return cart.find((line) => line.productId === productId)?.qty || 0;
  }

  // this adds one product into the cart while checking stock, active status, and current quantity first
  function addToCart(productId: string, qty = 1, explicitProduct?: Product) {
    if (pendingCheckout) {
      setBillingError(
        "A submitted checkout is pending recovery. Please retry checkout or resolve before adding items.",
      );
      return;
    }
    const product = explicitProduct || productsById.get(productId);
    // this handles when the product is inactive or missing from the lookup table
    if (!product || !product.active) {
      showCartIssue("That product is not available for billing.");
      return;
    }
    if (product.stock <= 0) {
      showCartIssue(`"${product.name}" is out of stock.`);
      return;
    }
    if (product.stock < getProductMinQty(product)) {
      showCartIssue(
        `"${product.name}" has only ${formatQtyWithUnit(product.stock, product.saleUnit)} in stock.`,
      );
      return;
    }

    const stepQty = normalizeProductCartQty(product, qty);
    const currentQty = getCurrentQty(productId);
    // we block adding more once the cart quantity would pass the live stock count
    if (currentQty >= product.stock) {
      showCartIssue(
        `"${product.name}" has only ${formatQtyWithUnit(product.stock, product.saleUnit)} in stock.`,
      );
      return;
    }

    // updating the cart either bumps an existing line or adds a new one for the scanned/searched product
    pendingCartFocusProductIdRef.current = productId;
    setCart((prev) => {
      const idx = prev.findIndex((x) => x.productId === productId);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = {
          ...copy[idx],
          qty: normalizeProductCartQty(product, copy[idx].qty + stepQty),
          overrideUnitPrice: undefined,
          overrideReason: undefined,
          overrideAuthorizationToken: undefined,
        };
        return copy;
      }
      return [
        ...prev,
        { productId, qty: normalizeProductCartQty(product, stepQty) },
      ];
    });
    setProductQuery("");
    setBillingError("");
    clearCartIssue();
    setStockConflicts((current) =>
      current.filter((conflict) => conflict.productId !== productId),
    );
    searchRef.current?.focus();
  }

  // this changes the quantity of an item already in the cart
  // and validates that we don't exceed the available stock
  function changeQty(productId: string, val: number) {
    if (pendingCheckout) {
      setBillingError(
        "A submitted checkout is pending recovery. Please retry checkout or resolve before changing quantity.",
      );
      return;
    }
    const product = productsById.get(productId);
    const maxQty = Math.max(getProductMinQty(product), product?.stock || 1);
    if (product && val > product.stock) {
      showCartIssue(
        `"${product.name}" has only ${formatQtyWithUnit(product.stock, product.saleUnit)} in stock.`,
      );
    } else {
      clearCartIssue();
    }
    setCart((prev) =>
      prev.map((x) =>
        x.productId === productId
          ? {
              ...x,
              qty: product
                ? normalizeProductCartQty(product, val)
                : clampNumber(normalizeQuantityValue(val), 1, maxQty),
              overrideUnitPrice: undefined,
              overrideReason: undefined,
              overrideAuthorizationToken: undefined,
            }
          : x,
      ),
    );
    const index = cartRows.findIndex((row) => row.productId === productId);
    if (index >= 0) setSelectedCartRowIndex(index);
    if (!product || val <= product.stock) {
      setStockConflicts((current) =>
        current.filter((conflict) => conflict.productId !== productId),
      );
    }
  }

  function removeLine(productId: string) {
    if (pendingCheckout) {
      setBillingError(
        "A submitted checkout is pending recovery. Please retry checkout or resolve before removing items.",
      );
      return;
    }
    setCart((prev) => prev.filter((x) => x.productId !== productId));
    clearCartIssue();
    if (priceOverrideTargetId === productId) closePriceOverride();
    setStockConflicts((current) =>
      current.filter((conflict) => conflict.productId !== productId),
    );
  }

  function applyStockConflictSuggestion(conflict: StockConflict) {
    if (pendingCheckout) {
      setBillingError(
        "A submitted checkout is pending recovery. Please retry checkout or resolve before changing items.",
      );
      return;
    }
    if (conflict.availableStock <= 0) {
      removeLine(conflict.productId);
      return;
    }

    const product = productsById.get(conflict.productId);
    setCart((prev) =>
      prev.map((line) =>
        line.productId === conflict.productId
          ? {
              ...line,
              qty: product
                ? normalizeProductCartQty(
                    product,
                    Math.min(line.qty, conflict.availableStock),
                  )
                : Math.min(line.qty, conflict.availableStock),
              overrideUnitPrice: undefined,
              overrideReason: undefined,
              overrideAuthorizationToken: undefined,
            }
          : line,
      ),
    );
    setStockConflicts((current) =>
      current.filter((item) => item.productId !== conflict.productId),
    );
    setBillingError("");
  }

  function applyAllStockConflictSuggestions() {
    if (pendingCheckout) {
      setBillingError(
        "A submitted checkout is pending recovery. Please retry checkout or resolve before changing items.",
      );
      return;
    }
    const conflictsByProductId = new Map(
      stockConflicts.map((conflict) => [conflict.productId, conflict]),
    );

    setCart(
      (prev) =>
        prev
          .map((line) => {
            const conflict = conflictsByProductId.get(line.productId);
            if (!conflict) return line;
            if (conflict.availableStock <= 0) return null;
            const product = productsById.get(line.productId);
            return {
              ...line,
              qty: product
                ? normalizeProductCartQty(
                    product,
                    Math.min(line.qty, conflict.availableStock),
                  )
                : Math.min(line.qty, conflict.availableStock),
              overrideUnitPrice: undefined,
              overrideReason: undefined,
              overrideAuthorizationToken: undefined,
            };
          })
          .filter(Boolean) as CartLine[],
    );
    setStockConflicts([]);
    setBillingError("");
  }

  async function refreshStockConflictList() {
    setStockRefreshBusy(true);
    try {
      const latestProducts = await refreshProductsForCheckout();
      const conflicts = buildStockConflictsFromCart(cart, latestProducts);
      if (conflicts.length > 0) {
        showStockConflicts(conflicts);
      } else {
        setStockConflicts([]);
        setBillingError("");
      }
    } catch {
      setBillingError(
        "Could not refresh product stock. Check connection and try again.",
      );
    } finally {
      setStockRefreshBusy(false);
    }
  }

  async function addBySku() {
    const s = skuInput.trim();
    if (!s || scannerLookupBusyRef.current) return;
    scannerLookupBusyRef.current = true;
    try {
      const raw = await getProductByCodeApi(s);
      const product = mapRawProducts([raw])[0];
      if (!product) {
        showCartIssue(`No active product found for "${s}".`);
        return;
      }
      mergeProducts([product]);
      addToCart(
        product.id,
        getProductQtyStep(product),
        product,
      );
      setSkuInput("");
      skuRef.current?.focus();
    } catch (error: any) {
      if (error?.response?.status === 404) {
        showCartIssue(`No active product found for "${s}".`);
      } else if (
        error?.code !== "ERR_CANCELED" &&
        error?.code !== "ERR_RATE_LIMIT_COOLDOWN" &&
        error?.response?.status !== 429
      ) {
        showCartIssue("Product lookup failed. Check the connection and try again.");
      }
    } finally {
      scannerLookupBusyRef.current = false;
    }
  }

  function handleManualSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!productQuery.trim() || manualResults.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setManualSearchIndex((current) =>
        Math.min(current + 1, manualResults.length - 1),
      );
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setManualSearchIndex((current) => Math.max(current - 1, 0));
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      setProductQuery("");
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const selected = manualResults[manualSearchIndex];
      if (!selected) return;
      if (selected.stock <= 0) {
        showCartIssue(`"${selected.name}" is out of stock.`);
        return;
      }
      addToCart(selected.id);
    }
  }

  // we use this to clear all current cart data when a transaction finishes or is cancelled manually
  // the stored cart is cleared here too so the next visit starts fresh on purpose
  function resetBill(options?: { forceClearPending?: boolean; preserveStorageWarning?: boolean }) {
    cartSessionRef.current++;
    if (pendingCheckoutRef.current && !options?.forceClearPending) {
      writeStoredBillingCart([], null, null, null, pendingCheckoutRef.current);
    } else {
      clearStoredBillingCart();
      setPendingCheckout(null);
    }
    setCart([]);
    setActiveDraftInvoiceId(null);
    setActiveDraftRequestId(null);
    setSelectedCustomerId(null);
    setPaymentMethod("Cash");
    setPaymentStatus("Paid");
    setPaidAmount("");
    setCashTendered("");
    setFonepayReference("");
    setBankTransferReference("");
    setReceivingAccountId("");
    setReceivingAccountVersion(null);
    setReceivingAccountLabel("");
    setManualReceiptConfirmed(false);
    setSplitCashAmount("");
    setSplitPayments([]);
    setInvoiceNote("");
    setSkuInput("");
    setProductQuery("");
    setPaymentError("");
    setBillingError("");
    clearCartIssue();
    setPriceOverrideDraftPin("");
    closePriceOverride();
    setStockConflicts([]);
    setCustomerSearchOpen(false);
    setCustomerQuery("");
    setShowPaymentModal(false);
    setPendingBillingConfirm(null);
    setShowEsewaQr(true);
    setPaperDraftBillNo("");
    setPaperDraftDocumentType("PAN_INVOICE");
    setPaperDraftBillDate(new Date().toLocaleDateString("en-CA"));
    setPaperDraftChoice("RECORD_AFTER_SAVE");
    setFonepayConfirmed(false);
    if (!options?.preserveStorageWarning) {
      setStorageLimitationWarning(null);
    }
    skuRef.current?.focus();
  }

  function requestResetBill() {
    if (pendingCheckout) {
      setBillingError(
        "A submitted checkout is pending recovery. Retry checkout to recover the bill, or resolve it before clearing.",
      );
      return;
    }
    if (!hasBillDraft) return;
    setPendingBillingConfirm("clear-cart");
  }

  function confirmResetBill() {
    if (pendingCheckoutRef.current || pendingCheckout) return;
    if (activeDraftRequestId) {
      const linkedRequest = incomingRequests.find(
        (request) => request.id === activeDraftRequestId,
      );
      setPendingBillingConfirm(null);
      setAcceptedResolution({
        requestId: activeDraftRequestId,
        requestNo: linkedRequest?.requestNo || "Loaded staff request",
        clearCartAfter: true,
      });
      setAcceptedResolutionReason("");
      setAcceptedResolutionError("");
      return;
    }
    resetBill({ forceClearPending: true });
  }

  function requestParkBill() {
    if (pendingCheckout) {
      setBillingError(
        "A submitted checkout is pending recovery. Complete retry before parking.",
      );
      return;
    }
    if (cart.length === 0) {
      setBillingError("Add at least one item before parking this bill.");
      return;
    }
    if (activeDraftRequestId) {
      setBillingError(
        "This bill is linked to a staff request. Complete checkout or clear it before opening another bill.",
      );
      return;
    }
    if (parkedBusy) return;
    setPendingBillingConfirm("park-cart");
  }

  function confirmParkBill() {
    setPendingBillingConfirm(null);
    void parkCurrentBill("manual");
  }

  function openHeldBills() {
    setShowParkedBills(true);
    setParkedError("");
    void loadParkedDrafts();
  }

  async function openIncomingRequest(request: BillingDraftRequest) {
    if (draftRequestBusy) return;
    setDraftRequestBusy(true);
    setIncomingRequestsError("");
    try {
      const data =
        request.status === "PENDING" || request.status === "MODIFIED"
          ? await markDraftRequestViewedApi(request.id)
          : await getDraftRequestApi(request.id);
      const detailed = data.request;
      setSelectedIncomingRequest(detailed);
      setDraftRejectNote("");
      setDraftReviewErrors({});
      setDraftReviewDecisions(
        Object.fromEntries(
          (detailed.items || []).map((item) => [
            item.id,
            {
              action:
                item.reviewStatus === "REJECTED" ? "REJECT" : "ACCEPT",
              acceptedQty: Number(item.acceptedQty ?? item.qty ?? 1),
              reason: item.rejectionReason || "",
            } satisfies DraftReviewDecision,
          ]),
        ),
      );
      setIncomingRequests((current) =>
        current.map((item) =>
          item.id === detailed.id ? { ...item, ...detailed } : item,
        ),
      );
    } catch (error: any) {
      const message =
        error?.response?.data?.error ||
        error?.message ||
        "Could not open this request.";
      setIncomingRequestsError(message);
      showToast("danger", message);
      void loadIncomingRequests();
    } finally {
      setDraftRequestBusy(false);
    }
  }

  function updateDraftReviewDecision(
    itemId: string,
    patch: Partial<DraftReviewDecision>,
  ) {
    setDraftReviewDecisions((current) => {
      const previous: DraftReviewDecision = current[itemId] || {
        action: "ACCEPT",
        acceptedQty: 1,
        reason: "",
      };
      return {
        ...current,
        [itemId]: { ...previous, ...patch },
      };
    });
    if (patch.action === "ACCEPT" || patch.reason?.trim()) {
      setDraftReviewErrors((current) => {
        if (!current[itemId]) return current;
        const next = { ...current };
        delete next[itemId];
        return next;
      });
    }
  }

  async function rejectIncomingRequest() {
    if (!selectedIncomingRequest || draftRequestBusy) return;
    if (
      selectedIncomingRequest.status !== "PENDING" &&
      selectedIncomingRequest.status !== "MODIFIED"
    ) {
      return;
    }
    setDraftRequestBusy(true);
    try {
      await rejectDraftRequestApi(
        selectedIncomingRequest.id,
        draftRejectNote.trim() || null,
      );
      showToast(
        "success",
        `${selectedIncomingRequest.requestNo} rejected.`,
      );
      setSelectedIncomingRequest(null);
      setDraftRejectNote("");
      await loadIncomingRequests();
    } catch (error: any) {
      showToast(
        "danger",
        error?.response?.data?.error ||
          error?.message ||
          "Could not reject this request.",
      );
    } finally {
      setDraftRequestBusy(false);
    }
  }

  function openAcceptedResolution(request: BillingDraftRequest) {
    setAcceptedResolution({
      requestId: request.id,
      requestNo: request.requestNo,
      clearCartAfter: activeDraftRequestId === request.id,
    });
    setAcceptedResolutionReason("");
    setAcceptedResolutionError("");
  }

  async function resolveAcceptedRequest(
    action: "RETURN_TO_QUEUE" | "CANCEL",
  ) {
    if (pendingCheckoutRef.current || pendingCheckout) {
      setBillingError(
        "A submitted checkout is pending recovery. Complete retry before resolving staff requests.",
      );
      return;
    }
    if (!acceptedResolution || draftRequestBusy) return;
    const reason = acceptedResolutionReason.trim();
    if (reason.length < 3) {
      setAcceptedResolutionError(
        "Add a short reason so staff can understand what happened.",
      );
      window.setTimeout(() => {
        focusInvalidField(document.getElementById("accepted-request-resolution-reason"));
      }, 0);
      return;
    }

    setDraftRequestBusy(true);
    try {
      const result = await resolveAcceptedDraftRequestApi(
        acceptedResolution.requestId,
        { action, reason },
      );
      if (pendingCheckoutRef.current) {
        return;
      }
      if (
        acceptedResolution.clearCartAfter ||
        activeDraftRequestId === acceptedResolution.requestId
      ) {
        resetBill();
      }
      setAcceptedResolution(null);
      setAcceptedResolutionReason("");
      setAcceptedResolutionError("");
      setSelectedIncomingRequest(null);
      await loadIncomingRequests();
      showToast(
        "success",
        action === "RETURN_TO_QUEUE"
          ? `${result.request.requestNo} returned to the waiting queue.`
          : `${result.request.requestNo} cancelled and kept in request history.`,
      );
    } catch (error: any) {
      showToast(
        "danger",
        error?.response?.data?.error ||
          error?.message ||
          "Could not resolve this request.",
      );
    } finally {
      setDraftRequestBusy(false);
    }
  }

  async function reviewAndLoadIncomingRequest() {
    if (pendingCheckoutRef.current || pendingCheckout) {
      showToast(
        "warning",
        "A submitted checkout is pending recovery. Complete retry before switching requests.",
      );
      return;
    }
    if (!selectedIncomingRequest || draftRequestBusy) return;
    if (activeDraftRequestId) {
      showToast(
        "warning",
        "Complete or clear the request already loaded in Billing first.",
      );
      return;
    }

    const request = selectedIncomingRequest;
    const isAlreadyAccepted =
      request.status === "ACCEPTED" ||
      request.status === "PARTIALLY_ACCEPTED";
    const reviewItems: DraftRequestReviewItem[] = (request.items || []).map(
      (item) => {
        const decision = draftReviewDecisions[item.id] || {
          action: "ACCEPT" as const,
          acceptedQty: Number(item.qty || 1),
          reason: "",
        };
        return {
          itemId: item.id,
          action: decision.action,
          ...(decision.action === "ACCEPT"
            ? { acceptedQty: Number(decision.acceptedQty) }
            : { reason: decision.reason.trim() || null }),
        };
      },
    );

    const missingRejectReasonIds = !isAlreadyAccepted
      ? reviewItems
          .filter((item) => item.action === "REJECT" && !item.reason?.trim())
          .map((item) => item.itemId)
      : [];
    if (missingRejectReasonIds.length > 0) {
      setDraftReviewErrors(
        Object.fromEntries(
          missingRejectReasonIds.map((itemId) => [
            itemId,
            "Add a reason for rejecting this item.",
          ]),
        ),
      );
      window.setTimeout(() => {
        focusInvalidField(
          document.getElementById(
            `draft-reject-reason-${missingRejectReasonIds[0]}`,
          ),
        );
      }, 0);
      return;
    }
    setDraftReviewErrors({});
    if (
      !isAlreadyAccepted &&
      reviewItems.every((item) => item.action === "REJECT")
    ) {
      showToast(
        "warning",
        "Use Reject request when no items should be loaded into Billing.",
      );
      return;
    }

    setDraftRequestBusy(true);
    try {
      if (cart.length > 0) {
        const parked = await parkCurrentBill("auto");
        if (!parked) return;
      }

      if (pendingCheckoutRef.current) {
        showToast(
          "warning",
          "A submitted checkout is pending recovery. Complete retry before switching requests.",
        );
        return;
      }

      const accepted = isAlreadyAccepted
        ? request
        : (await acceptDraftRequestApi(request.id, reviewItems)).request;

      if (pendingCheckoutRef.current) {
        showToast(
          "warning",
          "A submitted checkout is pending recovery. Complete retry before switching requests.",
        );
        return;
      }

      const acceptedLines = (accepted.items || [])
        .filter((item) => item.reviewStatus !== "REJECTED")
        .map((item) => ({
          productId: item.productId,
          qty: normalizeQuantityValue(
            Number(item.acceptedQty ?? item.qty ?? 1),
          ),
        }))
        .filter((line) => line.productId && line.qty > 0);

      if (acceptedLines.length === 0) {
        throw new Error("This request has no accepted items to load.");
      }

      cartSessionRef.current++;
      setCart(acceptedLines);
      setActiveDraftInvoiceId(null);
      setActiveDraftRequestId(accepted.id);
      setSelectedCustomerId(accepted.customerId || null);
      const requestContext = [
        `Staff request ${accepted.requestNo}`,
        accepted.customerName
          ? `Customer: ${accepted.customerName}${accepted.customerPhone ? ` (${accepted.customerPhone})` : ""}`
          : "",
        accepted.notes || "",
      ]
        .filter(Boolean)
        .join(" · ");
      setInvoiceNote(requestContext);
      setSelectedIncomingRequest(null);
      setShowIncomingRequests(false);
      setDraftReviewDecisions({});
      await loadIncomingRequests();
      showToast(
        "success",
        `${accepted.requestNo} loaded into Billing. Review stock and payment before checkout.`,
      );
      searchRef.current?.focus();
    } catch (error: any) {
      showToast(
        "danger",
        error?.response?.data?.error ||
          error?.message ||
          "Could not load this request into Billing.",
      );
    } finally {
      setDraftRequestBusy(false);
    }
  }

  function buildParkedBillLabel(kind: "manual" | "auto") {
    const time = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    if (selectedCustomer?.name) {
      return `${kind === "auto" ? "Auto-parked" : "Parked"} ${selectedCustomer.name} ${time}`;
    }
    return `${kind === "auto" ? "Auto-parked" : "Parked"} bill ${time}`;
  }

  function getParkedDraftUnitCount(draft: ParkedDraft) {
    return (draft.items || []).reduce((sum, item) => sum + item.qty, 0);
  }

  function getParkedDraftTitle(draft: ParkedDraft) {
    return (
      draft.parkedLabel ||
      draft.customer?.name ||
      draft.invoiceNo ||
      "Parked bill"
    );
  }

  async function loadResumedParkedDraft(resumed: ParkedDraft) {
    if (pendingCheckoutRef.current || pendingCheckout) {
      setParkedError(
        "A submitted checkout is pending recovery. Complete retry before resuming another bill.",
      );
      setBillingError(
        "A submitted checkout is pending recovery. Complete retry before resuming another bill.",
      );
      return;
    }
    const nextCart = (resumed.items || [])
      .map((item) => ({
        productId: item.productId,
        qty: normalizeQuantityValue(Number(item.qty || 1)),
      }))
      .filter((item) => item.productId);

    cartSessionRef.current++;
    setCart(nextCart);
    setActiveDraftInvoiceId(resumed.id);
    setActiveDraftRequestId(null);
    setSelectedCustomerId(resumed.customerId || null);
    setPaymentMethod("Cash");
    setPaymentStatus("Paid");
    setPaidAmount("");
    setCashTendered("");
    setFonepayReference("");
    setSplitCashAmount("");
    setSplitPayments([]);
    setInvoiceNote("");
    setPaymentError("");
    setBillingError("");
    setStockConflicts([]);
    setShowPaymentModal(false);
    setPendingBillingConfirm(null);
    setPendingStaleResume(null);
    setShowParkedBills(false);
    await loadParkedDrafts();
    showToast("success", "Parked bill resumed.");
    searchRef.current?.focus();
  }

  async function parkCurrentBill(kind: "manual" | "auto" = "manual") {
    if (pendingCheckoutRef.current || pendingCheckout) {
      const message =
        "A submitted checkout is pending recovery. Complete retry before parking.";
      setParkedError(message);
      setBillingError(message);
      return null;
    }
    if (cart.length === 0) {
      setParkedError("Add at least one item before parking this bill.");
      return null;
    }
    if (hasPriceOverrides) {
      const message =
        "Remove price overrides before parking this bill. Overrides require final checkout PIN approval.";
      setParkedError(message);
      setBillingError(message);
      return null;
    }

    const draftToReplaceId = activeDraftInvoiceId;
    setParkedBusy(true);
    setParkedError("");
    setBillingError("");

    try {
      const parked = await parkInvoiceDraftApi({
        replaceDraftInvoiceId: draftToReplaceId || undefined,
        customerId: selectedCustomerId || undefined,
        label: buildParkedBillLabel(kind),
        items: cart.map((line) => ({
          productId: line.productId,
          qty: line.qty,
        })),
      });
      if (pendingCheckoutRef.current) {
        return normalizeParkedDraft(parked);
      }
      resetBill();
      await loadParkedDrafts();
      showToast(
        "success",
        kind === "auto"
          ? "Current bill auto-parked before switching."
          : "Bill parked. You can resume it from Held Bills.",
      );
      return normalizeParkedDraft(parked);
    } catch (err: any) {
      const responseData = err?.response?.data;
      if (responseData?.code === "STOCK_CONFLICT") {
        const conflicts = normalizeApiStockConflicts(responseData.conflicts);
        if (conflicts.length > 0) {
          showStockConflicts(conflicts);
          setShowParkedBills(false);
          return null;
        }
      }

      const message =
        responseData?.error || err?.message || "Failed to park bill.";
      setParkedError(message);
      setBillingError(message);
      return null;
    } finally {
      setParkedBusy(false);
    }
  }

  async function resumeParkedBill(draft: ParkedDraft) {
    if (parkedBusy) return;
    if (pendingCheckoutRef.current || pendingCheckout) {
      const message =
        "A submitted checkout is pending recovery. Complete retry before resuming another bill.";
      setParkedError(message);
      setBillingError(message);
      return;
    }

    setParkedBusy(true);
    setParkedError("");
    setBillingError("");

    try {
      if (cart.length > 0) {
        const parked = await parkCurrentBill("auto");
        if (!parked) return;
      }

      if (pendingCheckoutRef.current) {
        const message =
          "A submitted checkout is pending recovery. Complete retry before resuming another bill.";
        setParkedError(message);
        setBillingError(message);
        return;
      }

      const resumed = normalizeParkedDraft(
        await resumeParkedDraftApi(draft.id),
      );
      if (pendingCheckoutRef.current) {
        const message =
          "A submitted checkout is pending recovery. Complete retry before resuming another bill.";
        setParkedError(message);
        setBillingError(message);
        return;
      }
      if ((resumed.staleWarnings || []).length > 0) {
        setPendingStaleResume(resumed);
        setShowParkedBills(false);
        return;
      }

      await loadResumedParkedDraft(resumed);
    } catch (err: any) {
      const message =
        err?.response?.data?.error ||
        err?.message ||
        "Failed to resume parked bill.";
      setParkedError(message);
      setBillingError(message);
    } finally {
      setParkedBusy(false);
    }
  }

  async function confirmDiscardParkedBill() {
    if (!pendingDiscardParked || parkedBusy) return;

    setParkedBusy(true);
    setParkedError("");

    try {
      await discardParkedDraftApi(pendingDiscardParked.id);
      setPendingDiscardParked(null);
      await loadParkedDrafts();
      showToast("success", "Parked bill discarded.");
    } catch (err: any) {
      setParkedError(
        err?.response?.data?.error ||
          err?.message ||
          "Failed to discard parked bill.",
      );
    } finally {
      setParkedBusy(false);
    }
  }

  async function discardPendingStaleResume() {
    if (!pendingStaleResume || parkedBusy) return;

    setParkedBusy(true);
    setParkedError("");
    try {
      await discardParkedDraftApi(pendingStaleResume.id);
      setPendingStaleResume(null);
      await loadParkedDrafts();
      showToast("success", "Stale parked bill discarded.");
    } catch (err: any) {
      setParkedError(
        err?.response?.data?.error ||
          err?.message ||
          "Failed to discard parked bill.",
      );
    } finally {
      setParkedBusy(false);
    }
  }

  function currentPaperReview(): PaperReview {
    return isPaperException ? { kind: "EXCEPTION", reason: paperExceptionReason.trim() } : { kind: "REFERENCE", billNo: paperDraftBillNo.trim(), billDate: paperDraftBillDate, documentType: paperDraftDocumentType };
  }

  function currentWorksheetFingerprint() {
    return JSON.stringify([cart, cartRows.map(row => [row.productId, row.qty, row.unitPrice]), selectedCustomerId, invoiceNote, payableTotal, currentPaperReview()]);
  }

  function openPaymentFlow(nextMethod?: PaymentMethod) {
    if (pendingCheckout) {
      setPendingBillingConfirm("checkout");
      return;
    }
    if (nextMethod) setPaymentMethod(nextMethod);
    if (worksheetReviewRef.current !== currentWorksheetFingerprint()) {
      setActiveWorkspaceTab("worksheet");
      return;
    }
    // this handles when someone tries to open payment without any cart lines
    if (cartRows.length === 0) {
      setBillingError("Add at least one product before opening payment.");
      return;
    }
    if (!canConfirm) {
      if (hasUnresolvedCartLines) {
        showCartIssue(
          "Some cart items are unresolved, inactive, or have insufficient stock. Please resolve them before checkout.",
        );
      }
      return;
    }
    // when a shortcut button passes a payment method, we switch the modal into that method before opening it
    if (nextMethod) {
      setPaymentMethod(nextMethod);
      if (nextMethod === "Fonepay") setShowEsewaQr(false);
      if (nextMethod === "eSewa") setShowEsewaQr(true);
      if (nextMethod === "Split") ensureDefaultSplitPayments();
    }
    if ((nextMethod || paymentMethod) === "Cash" && paymentStatus === "Paid") {
      if (!cashTendered.trim()) setCashTendered(String(payableTotal));
    }
    if ((nextMethod || paymentMethod) === "Split") ensureDefaultSplitPayments();
    setBillingError("");
    setPaymentError("");
    setShowPaymentModal(true);
  }

  function closePaymentFlow() {
    setShowPaymentModal(false);
    setPaymentError("");
    setPendingBillingConfirm(null);
  }

  // partial payments need extra validation because the cashier types the received amount manually
  function validatePaymentBeforeConfirm() {
    setPaymentError("");
    setBillingError("");

    if (paymentMethod === "Split") {
      if (normalizedSplitPayments.length < 2) {
        setPaymentError("Split payment needs at least two payment rows.");
        return false;
      }

      if (
        normalizedSplitPayments.filter((row) => row.method === "ESEWA").length >
        1
      ) {
        setPaymentError("Only one eSewa row can be used in one split payment.");
        return false;
      }

      if (
        normalizedSplitPayments.filter((row) => row.method === "FONEPAY")
          .length > 1
      ) {
        setPaymentError(
          "Only one Fonepay row can be used in one split payment.",
        );
        return false;
      }

      if (Math.abs(splitBalance) > 0.01) {
        setPaymentError(
          splitBalance > 0
            ? `Split is short by ${formatBillingMoney(splitBalance)}.`
            : `Split exceeds total by ${formatBillingMoney(Math.abs(splitBalance))}.`,
        );
        return false;
      }

      const invalidCashRow = normalizedSplitPayments.find(
        (row) => row.method === "CASH" && row.tenderedNum < row.amountNum,
      );
      if (invalidCashRow) {
        setPaymentError(
          "Cash tendered cannot be less than its cash split amount.",
        );
        return false;
      }

      if (normalizedSplitPayments.every((row) => row.method !== "CASH")) {
        setPaymentError(
          "Use eSewa, Fonepay, or Bank Transfer when the full invoice amount is non-cash.",
        );
        return false;
      }

      const missingFonepayReference = normalizedSplitPayments.find(
        (row) => row.method === "FONEPAY" && !row.reference?.trim(),
      );
      if (missingFonepayReference) {
        setPaymentError("Enter the Fonepay reference for the split payment.");
        return false;
      }

      const missingBankTransferReference = normalizedSplitPayments.find(
        (row) => row.method === "BANK_TRANSFER" && !row.reference?.trim(),
      );
      if (missingBankTransferReference) {
        setPaymentError("Enter the Bank Transfer reference for the split payment.");
        return false;
      }

      if (normalizedSplitPayments.some((row) => row.method === "FONEPAY") && !fonepayConfirmed) {
        setPaymentError("Please confirm that the Fonepay merchant payment confirmation was verified.");
        return false;
      }

      const unconfirmedSplitManual = normalizedSplitPayments.find(
        (row) =>
          (row.method === "FONEPAY" || row.method === "BANK_TRANSFER") &&
          row.receivingAccountId &&
          !row.manualReceiptConfirmed,
      );
      if (unconfirmedSplitManual) {
        setPaymentError("Please confirm that you checked the receiving account and received the funds for all linked split rows.");
        return false;
      }

      return true;
    }

    if (paymentMethod === "Cash" && paymentStatus === "Paid") {
      if (!cashTendered.trim()) {
        setPaymentError("Enter the cash received from the customer.");
        return false;
      }
      if (cashTenderedNum < payableTotal) {
        setPaymentError("Cash received is less than the invoice total.");
        return false;
      }
      return true;
    }

    if (paymentMethod === "Fonepay" && paymentStatus !== "Unpaid") {
      if (!fonepayReference.trim()) {
        setPaymentError("Enter the Fonepay reference or remarks.");
        return false;
      }
      if (!fonepayConfirmed) {
        setPaymentError("Please confirm that the Fonepay merchant payment confirmation was verified.");
        return false;
      }
      if (receivingAccountId && !manualReceiptConfirmed) {
        setPaymentError("Please confirm that you checked this receiving account and received the funds.");
        return false;
      }
    }

    if (paymentMethod === "Bank Transfer" && paymentStatus !== "Unpaid") {
      if (!bankTransferReference.trim()) {
        setPaymentError("Enter the Bank Transfer reference or remarks.");
        return false;
      }
      if (receivingAccountId && !manualReceiptConfirmed) {
        setPaymentError("Please confirm that you checked this receiving account and received the funds.");
        return false;
      }
    }

    if (paymentStatus !== "Partial") {
      return true;
    }

    const amount = Number(paidAmount);
    if (!paidAmount.trim()) {
      setPaymentError("Enter the amount received for a partial payment.");
      return false;
    }
    if (!Number.isFinite(amount)) {
      setPaymentError("Enter a valid payment amount.");
      return false;
    }
    if (amount <= 0) {
      setPaymentError("Payment amount must be greater than 0.");
      return false;
    }
    if (amount >= payableTotal) {
      setPaymentError("Use Paid when the full invoice amount is received.");
      return false;
    }

    return true;
  }

  function renderCashTenderShortcuts() {
    if (cashDueAmount <= 0) return null;
    const options = [
      { label: "Exact", value: cashDueAmount },
      { label: formatBillingMoney(500), value: 500 },
      { label: formatBillingMoney(1000), value: 1000 },
      { label: formatBillingMoney(5000), value: 5000 },
    ];

    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {options.map((option) => {
          const disabled = option.value < cashDueAmount;
          return (
            <button
              key={option.label}
              type="button"
              disabled={disabled}
              onClick={() => {
                setCashTendered(String(option.value));
                setPaymentError("");
                setBillingError("");
              }}
              className={cn(
                "h-[34px] rounded-[11px] border px-3 text-[11px] font-extrabold transition",
                disabled
                  ? "cursor-not-allowed border-[#E5E7EB] bg-[#F3F4F6] text-[#C0BDBA]"
                  : "border-[#CFCFD3] bg-[#FFFFFF] text-[#565449] hover:border-[#000000] hover:text-[#000000]",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    );
  }

  function createSplitPaymentDraft(
    method: SplitPaymentDraft["method"],
    amount = "",
  ): SplitPaymentDraft {
    return {
      id: `${method}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      method,
      amount,
      tenderedAmount: method === "CASH" ? amount : "",
    };
  }

  function ensureDefaultSplitPayments() {
    const half = payableTotal > 0 ? String(Math.floor(payableTotal / 2)) : "";
    const remainder =
      payableTotal > 0
        ? String(Math.max(0, payableTotal - Number(half || 0)))
        : "";
    setSplitPayments((current) =>
      current.length > 0
        ? current
        : [
            createSplitPaymentDraft("CASH", half),
            createSplitPaymentDraft("ESEWA", remainder),
          ],
    );
  }

  function updateSplitPayment(
    id: string,
    patch: Partial<Omit<SplitPaymentDraft, "id">>,
  ) {
    setSplitPayments((current) =>
      current.map((payment) => {
        if (payment.id !== id) return payment;
        const next = { ...payment, ...patch };
        if (patch.method === "ESEWA" || patch.method === "FONEPAY" || patch.method === "BANK_TRANSFER") {
          next.tenderedAmount = "";
        }
        if (patch.method && patch.method !== "FONEPAY" && patch.method !== "BANK_TRANSFER") {
          next.reference = "";
          next.receivingAccountId = undefined;
          next.receivingAccountVersion = undefined;
          next.receivingAccountLabel = undefined;
          next.manualReceiptConfirmed = false;
        }
        if (
          patch.amount !== undefined ||
          patch.method !== undefined ||
          patch.reference !== undefined ||
          patch.receivingAccountId !== undefined ||
          patch.receivingAccountVersion !== undefined
        ) {
          if (patch.manualReceiptConfirmed === undefined) {
            next.manualReceiptConfirmed = false;
          }
        }
        return next;
      }),
    );
    setPaymentError("");
    setBillingError("");
  }

  function addSplitPayment(method: SplitPaymentDraft["method"]) {
    setSplitPayments((current) => [
      ...current,
      createSplitPaymentDraft(method),
    ]);
  }

  function removeSplitPayment(id: string) {
    setSplitPayments((current) =>
      current.length <= 1
        ? current
        : current.filter((payment) => payment.id !== id),
    );
  }

  async function requestCheckoutConfirm() {
    if (checkoutReviewBusyRef.current) return;
    checkoutReviewBusyRef.current = true;
    try {
      if (pendingCheckout) {
        setPendingBillingConfirm("checkout");
        return;
      }
      if (!canConfirm) {
        if (hasUnresolvedCartLines) {
          setPaymentError("Some cart items are unresolved, inactive, or have insufficient stock. Please resolve them before checkout.");
        } else if (paperFollowup.status === "FAILED_RETRYABLE" || paperFollowup.status === "PENDING") {
          setPaymentError(
            "There is an outstanding paper bill reference for invoice " +
              (paperFollowup.invoiceNo || paperFollowup.invoiceId) +
              ". Please retry or dismiss it before confirming checkout.",
          );
        }
        return;
      }
      if (!validatePaymentBeforeConfirm()) return;

      const initialActor = getAuthUser();
      const startRevision = checkoutInputRevisionRef.current;
      const startFingerprint = computeReviewFingerprint(liveCheckoutInputsRef.current);

      // Refresh and verify payment receiving account metadata when destination is linked
      const liveBeforeReceiving = liveCheckoutInputsRef.current;
      const hasLinkedReceivingSelections =
        ((liveBeforeReceiving.paymentMethod === "Fonepay" || liveBeforeReceiving.paymentMethod === "Bank Transfer") &&
          liveBeforeReceiving.paymentStatus !== "Unpaid" &&
          Boolean(liveBeforeReceiving.receivingAccountId)) ||
        (liveBeforeReceiving.paymentMethod === "Split" &&
          liveBeforeReceiving.splitPayments.some(
            (row) =>
              (row.method === "FONEPAY" || row.method === "BANK_TRANSFER") &&
              Boolean(row.receivingAccountId),
          ));

      if (hasLinkedReceivingSelections) {
        try {
          const freshAccounts = await getEnabledPaymentAccountsApi();
          const currentActor = getAuthUser();
          if (
            !currentActor ||
            currentActor.id !== initialActor?.id ||
            currentActor.role !== initialActor?.role
          ) {
            setPaymentError("Cashier session changed during review. Please review and confirm again.");
            return;
          }

          if (
            checkoutInputRevisionRef.current !== startRevision ||
            computeReviewFingerprint(liveCheckoutInputsRef.current) !== startFingerprint
          ) {
            setPaymentError(
              "Cart, customer, or payment details changed during receiving account verification. Please review and confirm again.",
            );
            return;
          }

          const freshList = Array.isArray(freshAccounts) ? freshAccounts : [];
          setEnabledPaymentAccounts(freshList);

          const liveInputs = liveCheckoutInputsRef.current;
          if (
            (liveInputs.paymentMethod === "Fonepay" || liveInputs.paymentMethod === "Bank Transfer") &&
            liveInputs.paymentStatus !== "Unpaid" &&
            liveInputs.receivingAccountId
          ) {
            const matching = freshList.find((acc) => acc.id === liveInputs.receivingAccountId);
            const requiredMethod = liveInputs.paymentMethod === "Fonepay" ? "FONEPAY" : "BANK_TRANSFER";
            const isCompatible =
              matching &&
              matching.supportedSettlement === true &&
              matching.confirmationMode === "MANUAL_RECEIPT" &&
              matching.settlementMethod === requiredMethod;
            const isVersionCurrent = matching && matching.version === liveInputs.receivingAccountVersion;

            if (!matching || !isCompatible || !isVersionCurrent) {
              setManualReceiptConfirmed(false);
              setReviewedCandidate(null);
              setPaymentError(
                "The selected receiving account was updated or is no longer available. Please select a receiving account and re-verify receipt.",
              );
              return;
            }
          }

          if (liveInputs.paymentMethod === "Split") {
            let splitStale = false;
            for (const row of liveInputs.splitPayments) {
              if (
                (row.method === "FONEPAY" || row.method === "BANK_TRANSFER") &&
                row.receivingAccountId
              ) {
                const matching = freshList.find((acc) => acc.id === row.receivingAccountId);
                const isCompatible =
                  matching &&
                  matching.supportedSettlement === true &&
                  matching.confirmationMode === "MANUAL_RECEIPT" &&
                  matching.settlementMethod === row.method;
                const isVersionCurrent = matching && matching.version === row.receivingAccountVersion;

                if (!matching || !isCompatible || !isVersionCurrent) {
                  splitStale = true;
                  break;
                }
              }
            }

            if (splitStale) {
              setSplitPayments((current) =>
                current.map((row) => ({
                  ...row,
                  manualReceiptConfirmed: false,
                })),
              );
              setReviewedCandidate(null);
              setPaymentError(
                "One or more selected receiving accounts were updated or are no longer available. Please review split destinations and re-verify receipt.",
              );
              return;
            }
          }
        } catch {
          setPaymentError(
            "Could not verify payment receiving accounts. Check connection and try again.",
          );
          return;
        }
      }

      setStockConflicts([]);
      setStockRefreshBusy(true);
      try {
        const latestProducts = await refreshProductsForCheckout();
        const postStockActor = getAuthUser();
        if (
          !postStockActor ||
          postStockActor.id !== initialActor?.id ||
          postStockActor.role !== initialActor?.role
        ) {
          setPaymentError("Cashier session changed during catalog refresh. Please review and confirm again.");
          return;
        }

        const latestProductsById = new Map(latestProducts.map((p) => [p.id, p]));

        if (
          checkoutInputRevisionRef.current !== startRevision ||
          computeReviewFingerprint({ ...liveCheckoutInputsRef.current, productsById }) !== startFingerprint
        ) {
          setPaymentError(
            "Cart, customer, or payment details changed during catalog refresh. Please review and confirm again.",
          );
          return;
        }
        const liveCurrent = liveCheckoutInputsRef.current;
        const conflicts = buildStockConflictsFromCart(liveCurrent.cart, latestProducts);
        if (conflicts.length > 0) {
          showStockConflicts(conflicts);
          return;
        }

        const effectivePaidStr =
          liveCurrent.paymentStatus === "Paid"
            ? (liveCurrent.paidAmount.trim() || String(payableTotal))
            : liveCurrent.paidAmount;

        const result = deriveCandidateCheckoutState({
          cart: liveCurrent.cart,
          latestProductsById,
          selectedCustomer: liveCurrent.selectedCustomer,
          subtotalDiscountPercent: liveCurrent.discountPercent,
          paymentMethod: liveCurrent.paymentMethod,
          paymentStatus: liveCurrent.paymentStatus,
          paidAmountStr: effectivePaidStr,
          cashTenderedStr: liveCurrent.cashTendered,
          fonepayReference: liveCurrent.fonepayReference,
          bankTransferReference: liveCurrent.bankTransferReference,
          receivingAccountId: liveCurrent.receivingAccountId || undefined,
          receivingAccountVersion: liveCurrent.receivingAccountVersion ?? undefined,
          receivingAccountLabel: liveCurrent.receivingAccountLabel || undefined,
          manualReceiptConfirmed: liveCurrent.manualReceiptConfirmed || undefined,
          splitPayments: liveCurrent.splitPayments,
          splitCashAmountStr: splitCashAmount,
          activeDraftInvoiceId: liveCurrent.activeDraftInvoiceId,
          activeDraftRequestId: liveCurrent.activeDraftRequestId,
          selectedCustomerId: liveCurrent.selectedCustomerId,
          invoiceNote: liveCurrent.invoiceNote,
          shouldUseQuantityWholesalePrice,
        });

        if (!result.success) {
          setPaymentError(result.error);
          return;
        }

        const candidateFingerprint = computeReviewFingerprint({
          ...liveCheckoutInputsRef.current,
          productsById: latestProductsById,
        });

        setReviewedCandidate({
          ...result.candidate,
          fingerprint: candidateFingerprint,
        });
        setPendingBillingConfirm("checkout");
      } catch {
        setPaymentError(
          "Could not refresh product stock. Check connection and try again.",
        );
      } finally {
        setStockRefreshBusy(false);
      }
    } finally {
      checkoutReviewBusyRef.current = false;
    }
  }

  async function confirmCheckout() {
    // stopping here prevents double submits and blocks invalid partial payment states
    if (!pendingCheckout && worksheetReviewRef.current !== currentWorksheetFingerprint()) {
      setShowPaymentModal(false);
      setPendingBillingConfirm(null);
      setActiveWorkspaceTab("worksheet");
      setBillingError("The worksheet changed. Review it again before payment.");
      return;
    }
    if (!pendingCheckout && !canConfirm) return;
    if (!pendingCheckout && !validatePaymentBeforeConfirm()) return;
    if (!pendingCheckout && !reviewedCandidate) return;

    if (paperFollowup.status === "FAILED_RETRYABLE" || paperFollowup.status === "PENDING") {
      setBillingError(
        "There is an outstanding paper bill reference for invoice " +
          (paperFollowup.invoiceNo || paperFollowup.invoiceId) +
          ". Please retry or dismiss it before confirming checkout.",
      );
      return;
    }

    if (!pendingCheckout) {
      const currentLiveFingerprint = computeReviewFingerprint({
        ...liveCheckoutInputsRef.current,
        productsById: new Map(products.map((p) => [p.id, p])),
      });

      if (reviewedCandidate?.fingerprint !== currentLiveFingerprint) {
        setBillingError(
          "Cart, customer, or payment details changed since review. Please review and confirm again.",
        );
        setReviewedCandidate(null);
        setPendingBillingConfirm(null);
        return;
      }
    }

    setPendingBillingConfirm(null);
    setSubmitting(true);

    try {
      const checkoutPayload: PendingCheckoutPayload = pendingCheckout
        ? pendingCheckout.payload
        : {
            draftInvoiceId: reviewedCandidate!.draftInvoiceId,
            customerId: reviewedCandidate!.customerId,
            draftRequestId: reviewedCandidate!.draftRequestId,
            notes: reviewedCandidate!.notes,
            paperReview: currentPaperReview(),
            items: reviewedCandidate!.items.map((line) => ({
              productId: line.productId,
              qty: line.qty,
              overrideUnitPrice: line.overrideUnitPrice,
              overrideReason: line.overrideReason,
              overrideAuthorizationToken: line.overrideAuthorizationToken,
            })),
            payments: reviewedCandidate!.payments,
            confirmation: reviewedCandidate!.confirmation,
          };

      const candidateDraftRequestId =
        reviewedCandidate !== null && reviewedCandidate !== undefined
          ? (reviewedCandidate.draftRequestId || null)
          : activeDraftRequestId;

      const checkoutSnapshot = resolvePendingCheckoutSnapshot(
        pendingCheckout,
        createCheckoutOperationKey(),
        checkoutPayload,
        candidateDraftRequestId,
      );

      if (!pendingCheckout) {
        setPendingCheckout(checkoutSnapshot);
        writeStoredBillingCart(
          cart,
          activeDraftInvoiceId,
          selectedCustomerId,
          activeDraftRequestId,
          checkoutSnapshot,
        );
        if (paperDraftBillNo.trim()) {
          const ok = writeStoredPendingPaperDraft({
            actorId: currentUser?.id || "unknown",
            operationKey: checkoutSnapshot.operationKey,
            draft: {
              billNo: paperDraftBillNo.trim(),
              externalDocumentType: paperDraftDocumentType,
              externalBillDate: paperDraftBillDate,
              choice: paperDraftChoice,
            },
          });
          if (!ok) {
            setStorageLimitationWarning("Browser storage is full or restricted. Unsaved paper drafts may not survive page reload.");
          }
        }
      }

      // The key and exact non-secret payload survive a lost response and reload.
      const result = await checkoutInvoiceApi({
        ...checkoutSnapshot.payload,
        operationKey: checkoutSnapshot.operationKey,
      });

      const invoiceId = result?.invoice?.id;
      const invoiceNo = result?.invoice?.invoiceNo;
      if (invoiceId) {
        setLastCreatedInvoiceId(invoiceId);
        window.sessionStorage.setItem(
          LAST_INVOICE_PRINT_STORAGE_KEY,
          invoiceId,
        );
      }

      if (invoiceId && ocrSourceFile) {
        const original = ocrSourceFile;
        try { await uploadInvoiceProofApi(invoiceId, original); }
        catch (error: any) { setProofFollowup({ invoiceId, invoiceNo, file: original, error: error?.message || "Sale saved; original proof attachment needs retry." }); }
        setOcrSourceFile(null); setOcrSourceObservations(null); setOcrCheckedFingerprint(null);
      }

      let paperRecordedSuccessfully = false;
      const initialLiveUser = getAuthUser();
      const initialActorId = initialLiveUser?.id || currentUser?.id || "unknown";
      const pendingStoredPaper = readStoredPendingPaperDraft(checkoutSnapshot.operationKey, initialActorId);
      const effectivePaperBillNo = paperDraftBillNo.trim() || pendingStoredPaper?.draft?.billNo?.trim() || "";
      const effectivePaperDocType = paperDraftBillNo.trim() ? paperDraftDocumentType : (pendingStoredPaper?.draft?.externalDocumentType || paperDraftDocumentType);
      const effectivePaperBillDate = paperDraftBillNo.trim() ? paperDraftBillDate : (pendingStoredPaper?.draft?.externalBillDate || paperDraftBillDate);
      const effectivePaperChoice = paperDraftBillNo.trim() ? paperDraftChoice : (pendingStoredPaper?.draft?.choice || paperDraftChoice);
      const hasPaperDraft = Boolean(effectivePaperBillNo);

      if (hasPaperDraft && invoiceId) {
        const paperDraftToRecord = {
          billNo: effectivePaperBillNo,
          externalDocumentType: effectivePaperDocType,
          externalBillDate: effectivePaperBillDate,
        };
        const ok = writeStoredPaperFollowup({
          actorId: initialActorId,
          invoiceId,
          invoiceNo,
          draft: paperDraftToRecord,
          expected: null,
        });
        if (!ok) {
          setStorageLimitationWarning(
            "Browser storage is full or restricted. Outstanding paper followup may not survive page reload.",
          );
        }
        clearStoredPendingPaperDraft(checkoutSnapshot.operationKey);

        setPaperFollowup({
          status: "PENDING",
          invoiceId,
          invoiceNo,
          draft: paperDraftToRecord,
          expected: null,
        });

        if (effectivePaperChoice === "RECORD_AFTER_SAVE") {
          let initialExpected: ExpectedManualBillRecord | null = null;
          try {
            const existing = await getManualBillRecord(invoiceId);
            const liveUserAfterRead = getAuthUser();
            if ((liveUserAfterRead?.id || "unknown") !== initialActorId) return;
            const currentSlotAfterRead = readStoredPaperFollowup(initialActorId, invoiceId);
            if (
              currentSlotAfterRead &&
              (currentSlotAfterRead.invoiceId !== invoiceId ||
                currentSlotAfterRead.actorId !== initialActorId ||
                currentSlotAfterRead.draft?.billNo !== paperDraftToRecord.billNo ||
                currentSlotAfterRead.draft?.externalDocumentType !== paperDraftToRecord.externalDocumentType ||
                currentSlotAfterRead.draft?.externalBillDate !== paperDraftToRecord.externalBillDate)
            ) {
              return;
            }

            initialExpected = {
              billingChannel: existing.billingChannel,
              externalDocumentType: existing.externalDocumentType,
              externalBillNo: existing.externalBillNo,
              externalBillDate: existing.externalBillDate,
              billRecordStatus: existing.billRecordStatus,
            };
          } catch {
            const liveUserCatch = getAuthUser();
            if ((liveUserCatch?.id || "unknown") !== initialActorId) return;
            const currentSlotCatch = readStoredPaperFollowup(initialActorId, invoiceId);
            if (
              currentSlotCatch &&
              (currentSlotCatch.invoiceId !== invoiceId ||
                currentSlotCatch.actorId !== initialActorId ||
                currentSlotCatch.draft?.billNo !== paperDraftToRecord.billNo ||
                currentSlotCatch.draft?.externalDocumentType !== paperDraftToRecord.externalDocumentType ||
                currentSlotCatch.draft?.externalBillDate !== paperDraftToRecord.externalBillDate)
            ) {
              return;
            }
            setPaperFollowup((current) => {
              if (
                current.invoiceId &&
                (current.invoiceId !== invoiceId ||
                  (current.draft &&
                    (current.draft.billNo !== paperDraftToRecord.billNo ||
                      current.draft.externalDocumentType !== paperDraftToRecord.externalDocumentType ||
                      current.draft.externalBillDate !== paperDraftToRecord.externalBillDate)))
              ) {
                return current;
              }
              return {
                status: "FAILED_RETRYABLE",
                invoiceId,
                invoiceNo,
                error:
                  "Unable to reach server to fetch current manual bill record before recording.",
                draft: paperDraftToRecord,
                expected: null,
              };
            });
            const rawStored = readStoredPaperFollowup(initialActorId, invoiceId);
            if (
              !rawStored ||
              (rawStored.invoiceId === invoiceId &&
                rawStored.actorId === initialActorId &&
                rawStored.draft?.billNo === paperDraftToRecord.billNo &&
                rawStored.draft?.externalDocumentType === paperDraftToRecord.externalDocumentType &&
                rawStored.draft?.externalBillDate === paperDraftToRecord.externalBillDate)
            ) {
              writeStoredPaperFollowup({
                actorId: initialActorId,
                invoiceId,
                invoiceNo,
                draft: paperDraftToRecord,
                expected: null,
                error:
                  "Unable to reach server to fetch current manual bill record before recording.",
              });
            }
            showToast(
              "warning",
              "Invoice finalized, but paper bill reference needs attention.",
            );
          }

          if (initialExpected) {
            const liveUserBeforeWrite = getAuthUser();
            if ((liveUserBeforeWrite?.id || "unknown") !== initialActorId) return;
            const currentSlotBeforeWrite = readStoredPaperFollowup(initialActorId, invoiceId);
            if (
              currentSlotBeforeWrite &&
              (currentSlotBeforeWrite.invoiceId !== invoiceId ||
                currentSlotBeforeWrite.actorId !== initialActorId ||
                currentSlotBeforeWrite.draft?.billNo !== paperDraftToRecord.billNo ||
                currentSlotBeforeWrite.draft?.externalDocumentType !== paperDraftToRecord.externalDocumentType ||
                currentSlotBeforeWrite.draft?.externalBillDate !== paperDraftToRecord.externalBillDate)
            ) {
              return;
            }

            writeStoredPaperFollowup({
              actorId: initialActorId,
              invoiceId,
              invoiceNo,
              draft: paperDraftToRecord,
              expected: initialExpected,
            });
            const submittedIntent = readStoredPaperFollowup(initialActorId, invoiceId);

            try {
              await recordManualBillReference(invoiceId, {
                reference: {
                  billNo: paperDraftToRecord.billNo,
                  externalDocumentType: paperDraftToRecord.externalDocumentType,
                  externalBillDate: paperDraftToRecord.externalBillDate,
                },
                expected: initialExpected,
              });

              const liveUserAfterWrite = getAuthUser();
              if ((liveUserAfterWrite?.id || "unknown") !== initialActorId) return;
              if (JSON.stringify(readStoredPaperFollowup(initialActorId, invoiceId)) !== JSON.stringify(submittedIntent)) return;

              paperRecordedSuccessfully = true;
              setPaperFollowup((current) => {
                if (
                  current.invoiceId &&
                  (current.invoiceId !== invoiceId ||
                    (current.draft &&
                      (current.draft.billNo !== paperDraftToRecord.billNo ||
                        current.draft.externalDocumentType !== paperDraftToRecord.externalDocumentType ||
                        current.draft.externalBillDate !== paperDraftToRecord.externalBillDate)))
                ) {
                  return current;
                }
                return {
                  status: "SUCCESS",
                  invoiceId,
                  invoiceNo,
                  draft: paperDraftToRecord,
                };
              });
              const rawStored = readStoredPaperFollowup(initialActorId, invoiceId);
              if (
                rawStored &&
                rawStored.invoiceId === invoiceId &&
                rawStored.actorId === initialActorId &&
                rawStored.draft?.billNo === paperDraftToRecord.billNo &&
                rawStored.draft?.externalDocumentType === paperDraftToRecord.externalDocumentType &&
                rawStored.draft?.externalBillDate === paperDraftToRecord.externalBillDate
              ) {
                clearStoredPaperFollowup(invoiceId, paperDraftToRecord, submittedIntent);
              }
            } catch (followupErr: any) {
              const liveUserCatch = getAuthUser();
              if ((liveUserCatch?.id || "unknown") !== initialActorId) return;
              if (JSON.stringify(readStoredPaperFollowup(initialActorId, invoiceId)) !== JSON.stringify(submittedIntent)) return;
              const currentSlotCatch = readStoredPaperFollowup(initialActorId, invoiceId);
              if (
                currentSlotCatch &&
                (currentSlotCatch.invoiceId !== invoiceId ||
                  currentSlotCatch.actorId !== initialActorId ||
                  currentSlotCatch.draft?.billNo !== paperDraftToRecord.billNo ||
                  currentSlotCatch.draft?.externalDocumentType !== paperDraftToRecord.externalDocumentType ||
                  currentSlotCatch.draft?.externalBillDate !== paperDraftToRecord.externalBillDate)
              ) {
                return;
              }

              const errCode = followupErr?.response?.data?.code;
              const errorMsg =
                followupErr?.response?.data?.error ||
                "Paper bill reference could not be saved. You can retry below.";
              const isReviewer =
                liveUserCatch?.role === "admin" || liveUserCatch?.role === "manager";
              const isDuplicate =
                errCode === "DUPLICATE_REVIEW_REQUIRED" ||
                errCode === "DUPLICATE_PAPER_BILL";
              const isStale = errCode === "STALE_RECORD_CONFLICT";

              setPaperFollowup((current) => {
                if (
                  current.invoiceId &&
                  (current.invoiceId !== invoiceId ||
                    (current.draft &&
                      (current.draft.billNo !== paperDraftToRecord.billNo ||
                        current.draft.externalDocumentType !== paperDraftToRecord.externalDocumentType ||
                        current.draft.externalBillDate !== paperDraftToRecord.externalBillDate)))
                ) {
                  return current;
                }
                return {
                  status: "FAILED_RETRYABLE",
                  invoiceId,
                  invoiceNo,
                  error:
                    isDuplicate && !isReviewer
                      ? "Duplicate paper bill number. Only managers or administrators can approve duplicate paper bills."
                      : errorMsg,
                  draft: paperDraftToRecord,
                  expected: initialExpected,
                  conflictRecord: isStale
                    ? followupErr?.response?.data?.currentRecord || null
                    : null,
                  duplicateRequired: isDuplicate && isReviewer,
                };
              });
              const rawStored = readStoredPaperFollowup(initialActorId, invoiceId);
              if (
                !rawStored ||
                (rawStored.invoiceId === invoiceId &&
                  rawStored.actorId === initialActorId &&
                  rawStored.draft?.billNo === paperDraftToRecord.billNo &&
                  rawStored.draft?.externalDocumentType === paperDraftToRecord.externalDocumentType &&
                  rawStored.draft?.externalBillDate === paperDraftToRecord.externalBillDate)
              ) {
                writeStoredPaperFollowup({
                  actorId: initialActorId,
                  invoiceId,
                  invoiceNo,
                  draft: paperDraftToRecord,
                  expected: initialExpected,
                  error: errorMsg,
                });
              }
              showToast(
                "warning",
                "Invoice finalized, but paper bill reference needs attention.",
              );
            }
          }
        } else if (effectivePaperChoice === "LATER") {
          setPaperFollowup({
            status: "PENDING",
            invoiceId,
            invoiceNo,
            draft: paperDraftToRecord,
          });
        }
      } else {
        clearStoredPendingPaperDraft(checkoutSnapshot.operationKey);
      }

      // when eSewa is chosen, the backend returns a signed payment intent — we redirect to the gateway
      if (result?.esewaPaymentIntent) {
        setPendingCheckout(null);
        resetBill({ preserveStorageWarning: true });
        submitEsewaForm(result.esewaPaymentIntent);
        return;
      }

      // clearing the draft only after the full invoice flow succeeds avoids losing the cart on failure
      setShowPaymentModal(false);
      setPriceOverrideDraftPin("");
      setReviewedCandidate(null);
      setPendingCheckout(null);
      setSavedSaleResult({
        invoiceId: invoiceId || "",
        invoiceNo: invoiceNo || result?.invoice?.invoiceNo,
        total: result?.invoice?.netTotal ?? payableTotal,
        effectivePaidAmount: result?.invoice?.paidTotal ?? effectivePaidAmount,
        balanceDue: (result?.invoice?.netTotal ?? payableTotal) - (result?.invoice?.paidTotal ?? effectivePaidAmount),
        paymentMethod,
        paymentStatus: result?.invoice?.paymentStatus ?? paymentStatus,
        paperRecorded: paperRecordedSuccessfully,
        paperBillNo: paperDraftBillNo.trim() || undefined,
        receivingDestinations: (result?.invoice?.payments || []).filter((p: any) => p.status === "SUCCESS" && p.kind !== "REFUND").map((p: any) => parseReceivingDestinationSnapshot(p.receivingDestinationSnapshot)).filter(Boolean),
      });
      resetBill({ preserveStorageWarning: true });
      setShowSuccess(true);
      try {
        await loadParkedDrafts();
      } catch {
        showToast(
          "warning",
          "Invoice created successfully; held bills could not refresh.",
        );
      }
    } catch (err: any) {
      console.error("Billing confirm error:", err);
      const responseData = err?.response?.data;
      const responseCode = responseData?.code;

      if (responseCode === "CHECKOUT_PAPER_REVIEW_REQUIRED") {
        // This code is emitted only after the fresh transaction rolled back; unknown errors keep their frozen payload.
        setPendingCheckout(null); setReviewedCandidate(null); worksheetReviewRef.current = null;
        writeStoredBillingCart(cart, activeDraftInvoiceId, selectedCustomerId, activeDraftRequestId, null);
        setShowPaymentModal(false); setActiveWorkspaceTab("worksheet");
        setBillingError("Checkout was not posted. Review the physical reference or an explicit exception before retrying.");
        return;
      }
      if (responseCode === "CHECKOUT_REVIEW_REQUIRED") {
        setPendingCheckout(null);
        setReviewedCandidate(null);
        writeStoredBillingCart(
          cart,
          activeDraftInvoiceId,
          selectedCustomerId,
          activeDraftRequestId,
          null,
        );
        const paperGuidance = paperDraftBillNo.trim()
          ? ` Note: Paper bill "${paperDraftBillNo.trim()}" was prepared. Because bill totals changed, please void or revise the physical paper bill before finalizing.`
          : "";
        setBillingError(
          (responseData?.error ||
            "Items, prices, or payable total changed since review. Please review the updated bill and confirm again.") + paperGuidance,
        );
        try {
          await refreshProductsForCheckout();
        } catch {}
        return;
      }

      if (responseCode === "STOCK_CONFLICT") {
        setPendingCheckout(null);
        setReviewedCandidate(null);
        writeStoredBillingCart(
          cart,
          activeDraftInvoiceId,
          selectedCustomerId,
          activeDraftRequestId,
          null,
        );
        const conflicts = normalizeApiStockConflicts(responseData.conflicts);
        if (conflicts.length > 0) {
          showStockConflicts(conflicts);
          const paperGuidance = paperDraftBillNo.trim()
            ? ` Note: Paper bill "${paperDraftBillNo.trim()}" was prepared. Because available stock changed, please void or revise the physical paper bill before finalizing.`
            : "";
          if (paperGuidance) {
            setBillingError(paperGuidance);
          }
          try {
            await refreshProductsForCheckout();
          } catch {
            // the structured backend conflict is still enough for the cashier to resolve the cart
          }
          return;
        }
      }

      if (
        responseCode === "RECEIVING_ACCOUNT_CHANGED" ||
        responseCode === "RECEIVING_ACCOUNT_VERSION_MISMATCH" ||
        responseCode === "RECEIVING_ACCOUNT_INACTIVE" ||
        responseCode === "RECEIVING_ACCOUNT_NOT_FOUND" ||
        responseCode === "RECEIVING_ACCOUNT_METHOD_UNSUPPORTED"
      ) {
        setPendingCheckout(null);
        setReviewedCandidate(null);
        setManualReceiptConfirmed(false);
        setSplitPayments((current) =>
          current.map((row) => ({
            ...row,
            manualReceiptConfirmed: false,
          })),
        );
        writeStoredBillingCart(
          cart,
          activeDraftInvoiceId,
          selectedCustomerId,
          activeDraftRequestId,
          null,
        );
        setBillingError(
          responseData?.error ||
            "The receiving account configuration changed on the server. Please select the account again, verify receipt, and confirm checkout.",
        );
        try {
          await loadEnabledPaymentAccounts({ force: true });
        } catch {}
        return;
      }

      setActiveWorkspaceTab("billing");
      setShowPaymentModal(false);
      setBillingError(
        responseData?.error ||
          "Checkout outcome is unknown. Your bill is saved; retry to recover the same invoice.",
      );
    } finally {
      // re-enabling billing actions whether checkout succeeded or failed
      setSubmitting(false);
    }
  }

  async function handleRetryPaperFollowup() {
    if (
      !paperFollowup.invoiceId ||
      !paperFollowup.draft?.billNo ||
      paperFollowupBusy
    ) {
      return;
    }
    setPaperFollowupBusy(true);
    const invoiceId = paperFollowup.invoiceId;
    const draft = paperFollowup.draft;
    const initialLiveUser = getAuthUser();
    const retryActorId = initialLiveUser?.id || currentUser?.id || "unknown";
    const startingIntent = readStoredPaperFollowup(retryActorId, invoiceId);
    const duplicateOverrideReason = paperFollowup.duplicateOverrideReason?.trim() || undefined;
    let expectedToUse: ExpectedManualBillRecord | undefined | null = paperFollowup.expected;
    let submittedIntent: StoredPaperFollowup | null = null;
    try {
      if (initialLiveUser?.id !== currentUser?.id) return;
      if (startingIntent && (startingIntent.actorId !== retryActorId || startingIntent.invoiceId !== invoiceId)) return;
      // Retain original expected intent across retries; only fetch if expected was not yet established
      if (!expectedToUse) {
        let existing: ManualBillRecord | null = null;
        try {
          existing = await getManualBillRecord(invoiceId);
        } catch {
          const liveUser = getAuthUser();
          if ((liveUser?.id || "unknown") !== retryActorId) return;
          setPaperFollowup((current) => {
            if (current.invoiceId !== invoiceId) return current;
            return {
              ...current,
              error: "Unable to reach server to read current manual bill record. Retry suspended.",
            };
          });
          return;
        }

        const liveUserAfterRead = getAuthUser();
        if ((liveUserAfterRead?.id || "unknown") !== retryActorId) return;
        const currentSlotAfterRead = readStoredPaperFollowup(retryActorId, invoiceId);
        if (
          currentSlotAfterRead &&
          (currentSlotAfterRead.invoiceId !== invoiceId ||
            currentSlotAfterRead.actorId !== retryActorId ||
            currentSlotAfterRead.draft?.billNo !== draft.billNo ||
            currentSlotAfterRead.draft?.externalDocumentType !== draft.externalDocumentType ||
            currentSlotAfterRead.draft?.externalBillDate !== draft.externalBillDate)
        ) {
          return;
        }

        if (!existing) {
          const liveUserNoRecord = getAuthUser();
          if ((liveUserNoRecord?.id || "unknown") !== retryActorId) return;
          setPaperFollowup((current) => {
            if (current.invoiceId !== invoiceId) return current;
            return {
              ...current,
              error: "Unable to read manual bill record for this invoice.",
            };
          });
          return;
        }
        expectedToUse = {
          billingChannel: existing.billingChannel,
          externalDocumentType: existing.externalDocumentType,
          externalBillNo: existing.externalBillNo,
          externalBillDate: existing.externalBillDate,
          billRecordStatus: existing.billRecordStatus,
        };
      }

      if (JSON.stringify(readStoredPaperFollowup(retryActorId, invoiceId)) !== JSON.stringify(startingIntent)) return;
      // Persist the exact retry payload before the request can commit or lose its response.
      const stored = writeStoredPaperFollowup({
        actorId: retryActorId,
        invoiceId,
        invoiceNo: paperFollowup.invoiceNo,
        draft,
        expected: expectedToUse,
        duplicateOverrideReason,
      });
      if (!stored) {
        setStorageLimitationWarning("Browser storage is full or restricted. Outstanding paper followup may not survive page reload.");
      }
      submittedIntent = readStoredPaperFollowup(retryActorId, invoiceId);

      // Verify live actor and slot before issuing reference write
      const liveUserBeforeWrite = getAuthUser();
      if ((liveUserBeforeWrite?.id || "unknown") !== retryActorId) return;
      const currentSlotBeforeWrite = readStoredPaperFollowup(retryActorId, invoiceId);
      if (
        currentSlotBeforeWrite &&
        (currentSlotBeforeWrite.invoiceId !== invoiceId ||
          currentSlotBeforeWrite.actorId !== retryActorId ||
          currentSlotBeforeWrite.draft?.billNo !== draft.billNo ||
          currentSlotBeforeWrite.draft?.externalDocumentType !== draft.externalDocumentType ||
          currentSlotBeforeWrite.draft?.externalBillDate !== draft.externalBillDate)
      ) {
        return;
      }

      await recordManualBillReference(invoiceId, {
        reference: {
          billNo: draft.billNo,
          externalDocumentType: draft.externalDocumentType,
          externalBillDate: draft.externalBillDate,
        },
        expected: expectedToUse,
        ...(duplicateOverrideReason
          ? {
              duplicateOverrideReason,
            }
          : {}),
      });

      const liveUserAfterWrite = getAuthUser();
      if ((liveUserAfterWrite?.id || "unknown") !== retryActorId) return;
      if (JSON.stringify(readStoredPaperFollowup(retryActorId, invoiceId)) !== JSON.stringify(submittedIntent)) return;

      setPaperFollowup((current) => {
        if (
          current.invoiceId !== invoiceId ||
          current.draft?.billNo !== draft.billNo ||
          current.draft?.externalDocumentType !== draft.externalDocumentType ||
          current.draft?.externalBillDate !== draft.externalBillDate
        ) {
          return current;
        }
        return {
          status: "SUCCESS",
          invoiceId: current.invoiceId,
          invoiceNo: current.invoiceNo,
          draft: current.draft,
        };
      });
      const rawStored = readStoredPaperFollowup(retryActorId, invoiceId);
      if (
        rawStored &&
        rawStored.invoiceId === invoiceId &&
        rawStored.actorId === retryActorId &&
        rawStored.draft?.billNo === draft.billNo &&
        rawStored.draft?.externalDocumentType === draft.externalDocumentType &&
        rawStored.draft?.externalBillDate === draft.externalBillDate
      ) {
        clearStoredPaperFollowup(invoiceId, draft, submittedIntent);
      }
      setIsBannerEditing(false);
      showToast("success", "Manual bill reference recorded successfully.");
    } catch (err: any) {
      const liveUserCatch = getAuthUser();
      if ((liveUserCatch?.id || "unknown") !== retryActorId) return;
      if (JSON.stringify(readStoredPaperFollowup(retryActorId, invoiceId)) !== JSON.stringify(submittedIntent)) return;
      const errCode = err?.response?.data?.code;
      const errorMsg =
        err?.response?.data?.error ||
        "Retry failed. Check the details or permissions.";
      const isReviewer =
        liveUserCatch?.role === "admin" || liveUserCatch?.role === "manager";
      const isDuplicate =
        errCode === "DUPLICATE_REVIEW_REQUIRED" ||
        errCode === "DUPLICATE_PAPER_BILL";
      const isStale = errCode === "STALE_RECORD_CONFLICT";

      setPaperFollowup((current) => {
        if (
          current.invoiceId !== invoiceId ||
          current.draft?.billNo !== draft.billNo ||
          current.draft?.externalDocumentType !== draft.externalDocumentType ||
          current.draft?.externalBillDate !== draft.externalBillDate
        ) {
          return current;
        }
        return {
          ...current,
          status: "FAILED_RETRYABLE",
          error:
            isDuplicate && !isReviewer
              ? "Duplicate paper bill number. Only managers or administrators can approve duplicate paper bills."
              : errorMsg,
          expected: expectedToUse,
          conflictRecord: isStale
            ? err?.response?.data?.currentRecord || null
            : null,
          duplicateRequired: isDuplicate && isReviewer,
        };
      });
      const rawStored = readStoredPaperFollowup(retryActorId, invoiceId);
      if (
        !rawStored ||
        (rawStored.invoiceId === invoiceId &&
          rawStored.actorId === retryActorId &&
          rawStored.draft?.billNo === draft.billNo &&
          rawStored.draft?.externalDocumentType === draft.externalDocumentType &&
          rawStored.draft?.externalBillDate === draft.externalBillDate)
      ) {
        const ok = writeStoredPaperFollowup({
          actorId: retryActorId,
          invoiceId,
          invoiceNo: paperFollowup.invoiceNo,
          draft,
          expected: expectedToUse,
          duplicateOverrideReason,
          error: errorMsg,
        });
        if (!ok) {
          setStorageLimitationWarning(
            "Browser storage is full or restricted. Outstanding paper followup may not survive page reload.",
          );
        }
      }
      showToast("danger", errorMsg);
    } finally {
      setPaperFollowupBusy(false);
    }
  }

  const pendingBillingConfirmConfig = useMemo(() => {
    if (!pendingBillingConfirm) return null;

    if (pendingBillingConfirm === "clear-cart") {
      return {
        title: "Clear this cart?",
        message:
          "This will remove the current billing draft, selected customer, and payment selections from this screen.",
        confirmLabel: "Clear Cart",
        tone: "danger" as const,
        icon: "delete",
        onConfirm: confirmResetBill,
        details: (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span>Items</span>
              <span className="font-extrabold text-slate-900">
                {cartRows.length} line(s),{" "}
                {formatQty(cartRows.reduce((sum, line) => sum + line.qty, 0))}{" "}
                total qty
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Customer</span>
              <span className="font-extrabold text-slate-900">
                {selectedCustomer ? selectedCustomer.name : "Walk-in Customer"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Total</span>
              <span className="font-extrabold text-slate-900">
                {formatBillingMoney(payableTotal)}
              </span>
            </div>
          </div>
        ),
      };
    }

    if (pendingBillingConfirm === "park-cart") {
      return {
        title: "Park this bill?",
        message:
          "This saves the current cart in Held Bills so you can serve another customer and resume it later.",
        confirmLabel: "Park Bill",
        tone: "primary" as const,
        icon: "local_parking",
        onConfirm: confirmParkBill,
        details: (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span>Items</span>
              <span className="font-extrabold text-slate-900">
                {cartRows.length} line(s),{" "}
                {formatQty(cartRows.reduce((sum, line) => sum + line.qty, 0))}{" "}
                total qty
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Customer</span>
              <span className="font-extrabold text-slate-900">
                {selectedCustomer ? selectedCustomer.name : "Walk-in Customer"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Total</span>
              <span className="font-extrabold text-slate-900">
                {formatBillingMoney(payableTotal)}
              </span>
            </div>
          </div>
        ),
      };
    }

    if (pendingCheckout) {
      const p = pendingCheckout.payload as any;
      const pItems = Array.isArray(p.items) ? p.items : [];
      const pPayable =
        p.confirmation?.payableTotal ??
        (typeof p.payableTotal === "number" ? p.payableTotal : undefined);
      return {
        title: "Retry submitted checkout?",
        message:
          "This bill was previously submitted and its outcome was interrupted. Confirming will recover the existing invoice without creating duplicate transactions.",
        confirmLabel: "Retry Submission",
        tone: "primary" as const,
        icon: "sync",
        onConfirm: confirmCheckout,
        details: (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span>Items</span>
              <span className="font-extrabold text-slate-900">
                {pItems.length} line(s), {formatQty(pItems.reduce((s: number, i: any) => s + (Number(i.qty) || 0), 0))} total qty
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Payable total</span>
              <span className="font-extrabold text-slate-900">
                {pPayable !== undefined
                  ? formatBillingMoney(pPayable)
                  : "Not recorded (legacy submission)"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Operation Key</span>
              <span className="font-mono text-[11px] font-extrabold text-slate-600 truncate max-w-[180px]">
                {pendingCheckout.operationKey}
              </span>
            </div>
          </div>
        ),
      };
    }

    const disp = reviewedCandidate?.display;
    const dispCustomer = disp?.customerName ?? (selectedCustomer ? selectedCustomer.name : "Walk-in Customer");
    const dispTotal = disp?.payableTotal ?? payableTotal;
    const dispCollect = disp?.effectivePaidAmount ?? (paymentMethod === "Split" ? splitCashNum : effectivePaidAmount);
    const dispMethod = disp?.paymentMethod ?? (paymentStatus === "Unpaid" ? "None" : paymentMethod);
    const dispEsewa = disp?.splitEsewaAmount ?? splitEsewaAmount;
    const dispFonepay = disp?.splitFonepayAmount ?? splitFonepayAmount;
    const dispFonepayRef = disp?.fonepayReference ?? (fonepayReference.trim() || undefined);
    const dispBankTransfer = disp?.splitBankTransferAmount ?? splitBankTransferAmount;
    const dispBankTransferRef = disp?.bankTransferReference ?? (bankTransferReference.trim() || undefined);
    const dispReceivingAccountLabel = disp?.receivingAccountLabel ?? receivingAccountLabel;
    const dispReceivingAccountId = disp?.receivingAccountId ?? receivingAccountId;
    const dispChange = disp?.changeDue ?? changeDue;
    const dispBalance = disp?.balanceDue ?? balanceDue;

    return {
      title:
        paymentMethod === "Split"
          ? "Confirm split payment?"
          : paymentStatus === "Unpaid"
            ? "Create unpaid invoice?"
            : paymentMethod === "Fonepay"
              ? "Confirm Fonepay payment?"
            : paymentMethod === "Bank Transfer"
              ? "Confirm Bank Transfer?"
            : paymentMethod === "eSewa"
              ? "Continue to eSewa?"
              : "Finalize this invoice?",
      message:
        paymentMethod === "Split"
          ? "This will record the cash portion now and attach the selected digital payment row."
          : paymentStatus === "Unpaid"
            ? "This will create the invoice without recording a payment."
            : paymentMethod === "Fonepay"
              ? "This will finalize the invoice and record this Fonepay reference."
            : paymentMethod === "Bank Transfer"
              ? "This will finalize the invoice and record this Bank Transfer reference."
            : paymentMethod === "eSewa"
              ? "KhataSathi will create the invoice and send this payment to eSewa."
              : "This will finalize the invoice and record the selected payment immediately.",
      confirmLabel:
        paymentMethod === "Split"
          ? "Confirm Split"
          : paymentStatus === "Unpaid"
            ? "Create Invoice"
            : paymentMethod === "Fonepay"
              ? "Confirm Fonepay"
            : paymentMethod === "Bank Transfer"
              ? "Confirm Bank Transfer"
            : paymentMethod === "eSewa"
              ? "Continue to eSewa"
              : `Confirm ${formatBillingMoney(dispCollect)}`,
      tone: "primary" as const,
      icon:
        paymentMethod === "Split"
          ? "call_split"
          : paymentStatus === "Unpaid"
            ? "receipt_long"
            : paymentMethod === "Fonepay"
              ? "qr_code_2"
            : paymentMethod === "Bank Transfer"
              ? "account_balance"
            : paymentMethod === "eSewa"
              ? "qr_code_2"
              : "payments",
      onConfirm: confirmCheckout,
      details: (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span>Customer</span>
            <span className="font-extrabold text-slate-900">
              {dispCustomer}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Invoice total</span>
            <span className="font-extrabold text-slate-900">
              {formatBillingMoney(dispTotal)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Collect now</span>
            <span className="font-extrabold text-slate-900">
              {formatBillingMoney(dispCollect)}
            </span>
          </div>
          {paymentMethod === "Split" ? (
            <div className="flex items-center justify-between gap-3">
              <span>eSewa amount</span>
              <span className="font-extrabold text-slate-900">
                {formatBillingMoney(dispEsewa)}
              </span>
            </div>
          ) : null}
          {paymentMethod === "Split" && dispFonepay > 0 ? (
            <div className="flex items-center justify-between gap-3">
              <span>Fonepay amount</span>
              <span className="font-extrabold text-slate-900">
                {formatBillingMoney(dispFonepay)}
              </span>
            </div>
          ) : null}
          {paymentMethod === "Split" && dispBankTransfer > 0 ? (
            <div className="flex items-center justify-between gap-3">
              <span>Bank Transfer amount</span>
              <span className="font-extrabold text-slate-900">
                {formatBillingMoney(dispBankTransfer)}
              </span>
            </div>
          ) : null}
          {paymentMethod === "Fonepay" && dispFonepayRef ? (
            <div className="flex items-center justify-between gap-3">
              <span>Reference</span>
              <span className="max-w-[220px] truncate font-extrabold text-slate-900">
                {dispFonepayRef}
              </span>
            </div>
          ) : null}
          {paymentMethod === "Bank Transfer" && dispBankTransferRef ? (
            <div className="flex items-center justify-between gap-3">
              <span>Reference</span>
              <span className="max-w-[220px] truncate font-extrabold text-slate-900">
                {dispBankTransferRef}
              </span>
            </div>
          ) : null}
          {(paymentMethod === "Fonepay" || paymentMethod === "Bank Transfer") && paymentStatus !== "Unpaid" ? (
            <div className="flex items-center justify-between gap-3">
              <span>Receiving Destination</span>
              <span className="max-w-[220px] truncate font-extrabold text-slate-900">
                {dispReceivingAccountId ? (dispReceivingAccountLabel || "Recorded account") : "Not recorded"}
              </span>
            </div>
          ) : null}
          {dispChange > 0 ? (
            <div className="flex items-center justify-between gap-3">
              <span>Change due</span>
              <span className="font-extrabold text-emerald-700">
                {formatBillingMoney(dispChange)}
              </span>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <span>Due after bill</span>
            <span className="font-extrabold text-slate-900">
              {formatBillingMoney(dispBalance)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Method</span>
            <span className="font-extrabold text-slate-900">
              {dispMethod}
            </span>
          </div>
        </div>
      ),
    };
  }, [
    balanceDue,
    changeDue,
    cartRows,
    effectivePaidAmount,
    payableTotal,
    paymentMethod,
    paymentStatus,
    pendingBillingConfirm,
    reviewedCandidate,
    selectedCustomer,
    splitCashNum,
    splitEsewaAmount,
    splitFonepayAmount,
    splitBankTransferAmount,
    fonepayReference,
    bankTransferReference,
    receivingAccountId,
    receivingAccountLabel,
  ]);

  // setting up global hotkeys (F2, F3, F4, F5, F6, F9, Enter) so the cashier can work fully via keyboard
  useEffect(() => {
    function isTypingTarget(el: EventTarget | null) {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || el.isContentEditable;
    }

    function onKeyDown(e: KeyboardEvent) {
      const activeCartRowIndex = queuedCartNavigationRef.current.reduce((index, apply) => apply(index), selectedCartRowIndex);
      if (e.defaultPrevented) return;

      // Overlay keyboard isolation: When any modal or tool overlay is open, suppress global billing shortcuts
      if (
        isCalculatorOpen ||
        isDetailedHistoryOpen ||
        isCompactHistoryOpen ||
        Boolean(typeof document !== "undefined" && document.querySelector('[data-modal-frame="true"], .app-modal-layer [aria-modal="true"]') && !(() => {
          const dialogs=document.querySelectorAll<HTMLElement>('[aria-modal="true"]');
          const top=dialogs[dialogs.length-1];
          const title=top?.getAttribute("aria-labelledby");
          const isPayment=title && document.getElementById(title)?.textContent === "Confirm Payment";
          return showPaymentModal && isPayment && ((e.shiftKey && e.key === "Enter") || (e.altKey && /^[1-4a]$/i.test(e.key)));
        })())
      ) {
        return;
      }

      const isFKey = /^F[2-9]$/.test(e.key);
      const isTyping = isTypingTarget(e.target);

      const isCtrlK = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k";
      const isGlobalAction =
        isFKey ||
        e.key === "Escape" ||
        e.altKey ||
        (e.shiftKey && e.key === "Enter") ||
        isCtrlK;
      if (isTyping && !isGlobalAction) return;

      if (pendingBillingConfirm === "park-cart" && e.key === "Enter") {
        e.preventDefault();
        confirmParkBill();
        return;
      }

      if (pendingBillingConfirm && e.key !== "Escape") return;

      if (e.key === "F2" || isCtrlK) {
        e.preventDefault();
        setActiveWorkspaceTab("billing");
        setMobileBillingPane("products");
        requestAnimationFrame(() => { searchRef.current?.focus(); searchRef.current?.select(); });
        return;
      }
      if (e.key === "F3") {
        e.preventDefault();
        setActiveWorkspaceTab("billing");
        setMobileBillingPane("products");
        requestAnimationFrame(() => window.dispatchEvent(new Event("billing-open-scanner")));
        return;
      }
      if (e.key === "F4") {
        e.preventDefault();
        openPaymentFlow("Cash");
        return;
      }
      if (e.key === "F5") {
        e.preventDefault();
        openPaymentFlow("eSewa");
        return;
      }
      if (e.key === "F6") {
        e.preventDefault();
        requestParkBill();
        return;
      }
      if (e.key === "F9") {
        e.preventDefault();
        requestResetBill();
        return;
      }
      if (e.key === "F7") {
        e.preventDefault();
        setActiveWorkspaceTab("billing");
        setCustomerSearchOpen(true);
        return;
      }
      if (e.key === "F8") {
        e.preventDefault();
        if (
          activeCartRowIndex >= 0 &&
          activeCartRowIndex < cartRows.length
        ) {
          openPriceOverride(cartRows[activeCartRowIndex]);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (pendingBillingConfirm) {
          setPendingBillingConfirm(null);
        } else if (showShortcutHelp) {
          setShowShortcutHelp(false);
        } else if (priceOverrideTargetId) {
          closePriceOverride();
        } else if (showPaymentModal) {
          closePaymentFlow();
        } else if (showParkedBills) {
          setShowParkedBills(false);
        } else if (pendingDiscardParked) {
          setPendingDiscardParked(null);
        } else if (showSuccess) {
          setShowSuccess(false);
        } else if (pendingStaleResume) {
          setPendingStaleResume(null);
        } else if (openRowActionProductId) {
          setOpenRowActionProductId(null);
        } else if (isCustomerSearchOpen) {
          setCustomerSearchOpen(false);
          searchRef.current?.focus();
        } else if (productQuery.trim()) {
          setProductQuery("");
          searchRef.current?.focus();
        } else {
          searchRef.current?.focus();
        }
        return;
      }
      if (pendingBillingConfirm) return;
      if (e.key === "Enter" && e.shiftKey) {
        if (!canConfirm) return;
        e.preventDefault();
        if (showPaymentModal) {
          requestCheckoutConfirm();
        } else if (activeWorkspaceTab === "worksheet" && !pendingCheckoutRef.current) {
          handleContinueToPaymentFromWorksheet();
        } else {
          openPaymentFlow();
        }
        return;
      }

      // Modifier-based Navigation (Alt Key)
      if (e.altKey) {
        const key = e.key.toLowerCase();

        // Cart Navigation
        if (activeWorkspaceTab !== "billing" && ["arrowup","arrowdown","delete","backspace","p","q","+","=","-","_"].includes(key)) return;
        if (key === "arrowdown") {
          e.preventDefault();
          queueCartNavigation((prev) =>
            cartRows.length === 0
              ? -1
              : Math.min(Math.max(prev, -1) + 1, cartRows.length - 1),
          );
          return;
        }
        if (key === "arrowup") {
          e.preventDefault();
          queueCartNavigation((prev) =>
            cartRows.length === 0 ? -1 : Math.max(prev <= 0 ? 0 : prev - 1, 0),
          );
          return;
        }
        if (key === "delete" || key === "backspace") {
          if (
            activeCartRowIndex >= 0 &&
            activeCartRowIndex < cartRows.length
          ) {
            e.preventDefault();
            const row = cartRows[activeCartRowIndex];
            if (row) removeLine(row.productId);
            return;
          }
        }
        if (e.shiftKey && (key === "+" || key === "=")) {
          if (
            activeCartRowIndex >= 0 &&
            activeCartRowIndex < cartRows.length
          ) {
            e.preventDefault();
            const row = cartRows[activeCartRowIndex];
            if (row)
              changeQty(
                row.productId,
                row.qty + getProductQtyStep(row.product),
              );
            return;
          }
        }
        if (e.shiftKey && (key === "-" || key === "_")) {
          if (
            activeCartRowIndex >= 0 &&
            activeCartRowIndex < cartRows.length
          ) {
            e.preventDefault();
            const row = cartRows[activeCartRowIndex];
            if (row)
              changeQty(
                row.productId,
                row.qty - getProductQtyStep(row.product),
              );
            return;
          }
        }
        if (e.shiftKey && key === "q") {
          if (
            activeCartRowIndex >= 0 &&
            activeCartRowIndex < cartRows.length
          ) {
            e.preventDefault();
            const row = cartRows[activeCartRowIndex];
            if (row) {
              const input = document.getElementById(
                `qty-input-${row.productId}`,
              ) as HTMLInputElement | null;
              if (input) {
                input.focus();
                input.select();
              }
            }
            return;
          }
        }
        if (key === "p") {
          if (
            activeCartRowIndex >= 0 &&
            activeCartRowIndex < cartRows.length
          ) {
            e.preventDefault();
            openPriceOverride(cartRows[activeCartRowIndex]);
            return;
          }
        }
        if (!showPaymentModal && key === "h") {
          e.preventDefault();
          openHeldBills();
          return;
        }

        // Payment Modal Shortcuts
        if (showPaymentModal) {
          if (key === "1") {
            e.preventDefault();
            setPaymentMethod("Cash");
            if (paymentStatus === "Paid" && !cashTendered.trim()) setCashTendered(String(payableTotal));
            return;
          }
          if (key === "2") {
            e.preventDefault();
            setPaymentMethod("Fonepay");
            setShowEsewaQr(false);
            return;
          }
          if (key === "3") {
            e.preventDefault();
            setPaymentMethod("eSewa");
            setShowEsewaQr(true);
            return;
          }
          if (key === "4") {
            e.preventDefault();
            setPaymentMethod("Split");
            setPaymentStatus("Paid");
            setShowEsewaQr(true);
            ensureDefaultSplitPayments();
            return;
          }
          if (key === "a" && paymentMethod === "Split") {
            e.preventDefault();
            addSplitPayment("CASH");
            return;
          }
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeWorkspaceTab,
    paperDraftBillNo,
    paperDraftBillDate,
    paperDraftDocumentType,
    isPaperException,
    paperExceptionReason,
    invoiceNote,
    reviewedCandidate,
    cashTendered,
    canConfirm,
    grandTotal,
    paymentMethod,
    paymentStatus,
    balanceDue,
    effectivePaidAmount,
    pendingBillingConfirm,
    productQuery,
    isCustomerSearchOpen,
    openRowActionProductId,
    showEsewaDetails,
    showPaymentModal,
    showParkedBills,
    pendingDiscardParked,
    showSuccess,
    pendingStaleResume,
    showEsewaQr,
    showShortcutHelp,
    cartRows,
    selectedCartRowIndex,
    priceOverrideTargetId,
    payableTotal,
    isCalculatorOpen,
    isDetailedHistoryOpen,
    isCompactHistoryOpen,
  ]);

  const cartTableItems: CartTableItem[] = useMemo(() => {
    return cartRows.map((r) => ({
      id: r.productId,
      productId: r.productId,
      name: r.product.name,
      brand: r.product.brand,
      sku: r.product.sku,
      saleUnit: r.product.saleUnit,
      imageUrl: r.product.imageUrl,
      qty: r.qty,
      stock: r.product.stock,
      appliedUnitPrice: r.unitPrice,
      originalUnitPrice: r.baseUnitPrice,
      priceType: r.priceType,
      overrideUnitPrice: r.overrideUnitPrice,
      overrideReason: r.overrideReason,
      lineTotal: r.lineTotal,
      unresolvedReason: r.unresolvedReason,
      quantityStep: r.product.quantityStep,
    }));
  }, [cartRows]);

  const [workspaceCustomerResults, setWorkspaceCustomerResults] = useState<Customer[] | null>(null);
  const [workspaceCustomerLoading, setWorkspaceCustomerLoading] = useState(false);
  const [workspaceCustomerError, setWorkspaceCustomerError] = useState<string | null>(null);
  const workspaceCustomerRequest = useRef<AbortController | null>(null);
  useEffect(() => () => workspaceCustomerRequest.current?.abort(), []);
  async function searchWorkspaceCustomers(query: string) {
    workspaceCustomerRequest.current?.abort();
    if (!query.trim()) { setWorkspaceCustomerResults(null); setWorkspaceCustomerLoading(false); setWorkspaceCustomerError(null); return; }
    const controller = new AbortController(); workspaceCustomerRequest.current = controller;
    setWorkspaceCustomerResults([]); setWorkspaceCustomerLoading(true); setWorkspaceCustomerError(null);
    await new Promise(resolve => setTimeout(resolve, 150));
    if (controller.signal.aborted) return;
    try { const result = await lookupCustomersApi({ q: query.trim(), page: 1, pageSize: 15 }, { signal: controller.signal });
      if (!controller.signal.aborted) setWorkspaceCustomerResults(result.items as Customer[]);
    } catch (error: any) { if (!controller.signal.aborted) setWorkspaceCustomerError(error?.message || "Could not search customers."); }
    finally { if (!controller.signal.aborted) setWorkspaceCustomerLoading(false); }
  }
  useEffect(() => { setPriceDifferItem(null); }, [activeWorkspaceTab, selectedCustomerId, mobileBillingPane]);
  const [catalogReload, setCatalogReload] = useState(0);
  const [catalogProducts, setCatalogProducts] = useState<Product[]>([]);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [availableCategories, setAvailableCategories] = useState<string[]>([]);
  const catalogRequestRef = useRef(0);
  useEffect(() => {
    let live = true;
    getCategoriesApi().then(data => { if (live) setAvailableCategories(Array.isArray(data) ? data.map((c: any) => typeof c === "string" ? c : c.name).filter(Boolean) : []); }).catch(() => {});
    return () => { live = false; };
  }, []);
  useEffect(() => { setCatalogPage(1); }, [selectedCustomerId]);
  useEffect(() => {
    const controller = new AbortController();
    const request = ++catalogRequestRef.current;
    setCatalogLoading(true);
    setCatalogError(null);
    const timer = setTimeout(async () => {
      try {
        const result = await listProductsApi({ active: "true", page: catalogPage, pageSize: catalogPageSize,
          search: catalogSearch.trim() || undefined, category: catalogCategory === "ALL" ? undefined : catalogCategory,
          customerId: selectedCustomerId || undefined, sortBy: catalogSort as any }, { signal: controller.signal });
        if (controller.signal.aborted || request !== catalogRequestRef.current) return;
        setCatalogProducts(mapRawProducts(result.products || []));
        setCatalogTotal(result.total || 0);
        mergeProducts(mapRawProducts(result.products || []));
      } catch (error: any) {
        if (!controller.signal.aborted && request === catalogRequestRef.current) setCatalogError(error?.message || "Could not load products. Try again.");
      } finally {
        if (!controller.signal.aborted && request === catalogRequestRef.current) setCatalogLoading(false);
      }
    }, catalogSearch ? 180 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [selectedCustomerId, catalogSearch, catalogCategory, catalogSort, catalogPage, catalogReload, mapRawProducts, mergeProducts]);
  const scanBlockedRef = useRef(false);
  scanBlockedRef.current = submitting || parkedBusy || draftRequestBusy || Boolean(pendingBillingConfirm);
  function blockScanEntry() {
    if (pendingCheckoutRef.current || scanBlockedRef.current || checkoutReviewBusyRef.current) {
      showCartIssue("Finish the active review, recovery or bill operation before scanning.");
      return true;
    }
    return false;
  }
  const handleBarcodeScan = async (barcode: string) => {
    if (blockScanEntry()) return false;
    const session = cartSessionRef.current;
    try {
      const raw = await getProductByCodeApi(barcode);
      const product = mapRawProducts([raw.product || raw])[0];
      if (!product?.id) throw new Error("No product found for that barcode.");
      if (session !== cartSessionRef.current) { showCartIssue("The bill changed while scanning. Scan again for the current sale."); return false; }
      if (blockScanEntry()) return false;
      if (!product.active || product.sellingPriceStatus === "PENDING" || product.stock <= 0) throw new Error("This product is inactive, unpriced or out of stock.");
      mergeProducts([product]);
      addToCart(product.id, product.quantityStep || 1, product);
      return true;
    } catch (error: any) { showCartIssue(error?.message || "Could not look up barcode."); return false; }
  };

  const handleContinueToPaymentFromWorksheet = () => {
    if (!cart.length) return;
    const issue = paperReviewIssue(currentPaperReview());
    if (issue) { const target=document.querySelector<HTMLElement>(isPaperException ? "#worksheet-exception-details, #worksheet-exception-reason" : "#worksheet-bill-number"); target?.focus();target?.scrollIntoView({block:"nearest"});showToast("danger", issue); return; }
    if (ocrSourceFile && ocrCheckedFingerprint !== currentWorksheetFingerprint() && !isPaperException) {
      setIsOcrComparisonOpen(true);
      showToast("info", "Compare the original bill manually before continuing, or record an explicit exception.");
      return;
    }
    worksheetReviewRef.current = currentWorksheetFingerprint();
    openPaymentFlow();
  };

  const applyDirectPriceOverride = (productId: string, newRate: number) => {
    const row = cartRows.find(line => line.productId === productId);
    if (!row) return;
    openPriceOverride(row);
    setPriceOverrideDraftPrice(String(newRate));
    setPriceOverrideDraftReason("Matched customer past purchase rate");
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-slate-400 font-semibold">
          Loading billing data...
        </div>
      </div>
    );
  }

  return (
    <>
            <div
        data-workspace-tab={activeWorkspaceTab}
        data-billing-view-size={billingViewSize}
        style={{ "--billing-text": `${Math.max(13, 14 * Number(billingViewSize) / 100)}px`, "--billing-row-space": `${8 * Number(billingViewSize) / 100}px`, "--billing-control-height": `${Math.max(36, 38 * Number(billingViewSize) / 100)}px` } as React.CSSProperties}
        className="billing-workspace"
      >
        {/* Top Workspace Tab Coordinator Bar */}
        <div className="billing-toolbar">
          <div className="billing-workflow-tabs">
            <button
              type="button"
              onClick={() => setActiveWorkspaceTab("billing")}
              className={`billing-workflow-tab ${activeWorkspaceTab === "billing" ? "is-active" : ""}`} aria-pressed={activeWorkspaceTab === "billing"}
            >
              <Icon name="point_of_sale" className="text-[20px]" />
              <span>Billing</span>
              {cart.length > 0 && (
                <span
                  className={`ml-1 rounded-full px-1.5 py-0.2 text-[10px] font-mono font-bold ${
                    activeWorkspaceTab === "billing"
                      ? "bg-white text-[#11120D]"
                      : "bg-[#11120D] text-white"
                  }`}
                >
                  {cart.length}
                </span>
              )}
            </button>

            <button
              type="button"
              id="billing-worksheet-trigger"
              onClick={() => {
                setActiveWorkspaceTab("worksheet");
                setIsWorksheetOpen(true);
              }}
              className={`billing-workflow-tab ${activeWorkspaceTab === "worksheet" ? "is-active" : ""}`} aria-pressed={activeWorkspaceTab === "worksheet"}
            >
              <Icon name="description" className="text-[20px]" />
              <span>Worksheet ({cart.length})</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveWorkspaceTab("history")}
              className={`billing-workflow-tab ${activeWorkspaceTab === "history" ? "is-active" : ""}`} aria-pressed={activeWorkspaceTab === "history"}
            >
              <Icon name="history" className="text-[20px]" />
              <span>Purchase History</span>

            </button>
          </div>

          {/* Operator, Terminal, Tools and persisted view density */}
          <div className="billing-toolbar-utilities">
            <span className="hidden sm:inline font-medium">
              {operatorLabel} &bull; <span className="font-mono">{terminalLabel}</span>
            </span>
            {isCashier && <button type="button" className="billing-toolbar-button" aria-haspopup="dialog" aria-label={`Requests (${incomingRequestsTotal} pending, ${unseenIncomingRequestCount} unseen)`} onClick={() => {
              setShowIncomingRequests(true);
              setSelectedIncomingRequest(null);
              setIncomingRequestsError("");
              void loadIncomingRequests();
            }}>
              <Icon name="forward_to_inbox" sizePx={18}/><span>Requests</span>
              <span className="rounded bg-inset px-1.5 text-xs font-semibold">{incomingRequestsTotal}</span>
              {unseenIncomingRequestCount > 0 && <span className="rounded bg-emerald-50 px-1.5 text-xs font-semibold text-emerald-800">{unseenIncomingRequestCount} unseen</span>}
            </button>}
            <BillingToolsMenu onOpenCalculator={() => setIsCalculatorOpen(true)} lastInvoiceId={lastCreatedInvoiceId}/>
            <div className="billing-density" aria-label="View density"><span>Density</span>
              <button
                type="button"
                onClick={() => stepBillingViewSize(-1)}
                className="billing-density-step"
                title="Decrease density" aria-label="Decrease density" disabled={billingViewSize === "85"}
              >
                -
              </button>
              <span className="billing-density-label">
                {BILLING_VIEW_SIZE_LABELS[billingViewSize]}
              </span>
              <button
                type="button"
                onClick={() => stepBillingViewSize(1)}
                className="billing-density-step"
                title="Increase density" aria-label="Increase density" disabled={billingViewSize === "110"}
              >
                +
              </button>
            </div>
          </div>
        </div>

        {cartAlertMessage ? (
          <div className="shrink-0 border-y border-[#FECDD3] bg-[#FFF1F2] px-[22px] py-[9px] text-[13px] font-extrabold text-[#BE123C]">
            <div className="flex items-center gap-2">
              <Icon name="error" className="text-[18px]" />
              <span className="min-w-0 truncate">{cartAlertMessage}</span>
              <button
                type="button"
                onClick={() => {
                  setBillingError("");
                  clearCartIssue();
                }}
                className="ml-auto text-[11px] underline"
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}

        {activeDraftRequestId && draftRequestNoticeVisible && <div role="status" className="flex shrink-0 items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          <Icon name="assignment_turned_in" sizePx={18}/>
          <span>Staff request loaded. Finalizing this bill completes the request automatically.</span>
          <button type="button" aria-label="Dismiss staff request notice" className="ml-auto rounded p-1" onClick={() => {
            acknowledgeDraftRequestNotice(currentUser?.id, activeDraftRequestId);
            setDraftRequestNoticeVisible(false);
          }}><Icon name="close" sizePx={18}/></button>
        </div>}
        {proofFollowup && <div className="mx-3 mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="status"><p className="font-medium">Sale {proofFollowup.invoiceNo || proofFollowup.invoiceId} is saved. Original proof is pending.</p><p className="mt-1">{proofFollowup.error}</p><div className="mt-2 flex flex-wrap items-center gap-2">{!proofFollowup.file && <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" aria-label="Reselect original saved-sale proof" onChange={e => { const file = e.target.files?.[0]; if (file) setProofFollowup(current => current ? { ...current, file } : null); }} />}<button type="button" disabled={!proofFollowup.file || proofRetrying} onClick={retryProofAttachment} className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 disabled:opacity-40">{proofRetrying ? "Attaching…" : "Retry proof attachment"}</button><button type="button" onClick={() => { setProofFollowup(null); showToast("info", "Proof remains pending. Attach it later in Manual Bills."); }} className="px-3 py-1.5 underline">Attach later in Manual Bills</button></div></div>}
        {activeWorkspaceTab === "billing" && <div className="flex shrink-0 gap-2 border-b border-line bg-white p-3 md:hidden" role="tablist" aria-label="Billing panel">{(["cart", "products", "customer"] as const).map(pane => <button type="button" key={pane} role="tab" aria-selected={mobileBillingPane === pane} onClick={() => setMobileBillingPane(pane)} className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium ${mobileBillingPane === pane ? "bg-action text-white" : "bg-inset"}`}>{({cart:"Current sale",products:"Products",customer:"Customer"})[pane]}</button>)}</div>}
        {/* WORKSPACE CONTENT BODY */}
        <div className="billing-body">
          <div className="billing-columns" style={{ display: activeWorkspaceTab === "billing" ? undefined : "none" }}>
            {activeWorkspaceTab === "billing" && <>

              {/* Column 1: Catalog Browser + Compact History (4 cols = ~33%) */}
              <div className={`billing-products-column ${mobileBillingPane === "products" ? "" : "hidden md:flex"}`}>
                <div className="billing-catalog-slot">
                  <BillingProductBrowser
                    products={catalogProducts}
                    loading={catalogLoading}
                    error={catalogError}
                    onRetry={() => setCatalogReload(value => value + 1)}
                    customerName={selectedCustomer?.name}
                    searchTerm={catalogSearch}
                    onSearchChange={(s) => {
                      setCatalogSearch(s);
                      setCatalogPage(1);
                    }}
                    selectedCategory={catalogCategory}
                    onSelectCategory={(c) => {
                      setCatalogCategory(c);
                      setCatalogPage(1);
                    }}
                    categories={availableCategories}
                    sortBy={catalogSort}
                    onSortByChange={(s) => {
                      setCatalogSort(s);
                      setCatalogPage(1);
                    }}
                    page={catalogPage}
                    pageSize={catalogPageSize}
                    totalProducts={catalogTotal}
                    onPageChange={setCatalogPage}
                    getAddDisabledReason={(p) => normalizeQuantityValue(p.stock - getCurrentQty(p.id), 0) < getProductMinQty(p as Product)
                      ? getCurrentQty(p.id) >= p.stock ? "All stock in cart" : "Insufficient stock"
                      : null}
                    onAddToCart={(p) => addToCart(p.id, p.quantityStep || 1, p as any)}
                    canViewWholesalePrice={isManager || isCashier}
                    searchInputRef={searchRef}
                    barcodeInputRef={skuRef}
                    onBarcodeScan={handleBarcodeScan}
                    activeCustomerId={selectedCustomer?.id}
                  />
                </div>

                <div className="shrink-0">
                  <BillingCompactCartHistory
                    selectedCustomerName={selectedCustomer?.name}
                    selectedCustomerId={selectedCustomer?.id}
                    cartItems={cartTableItems.map((it) => ({
                      productId: it.productId,
                      name: it.name,
                      unitPrice: it.appliedUnitPrice,
                    }))}
                    historyItems={customerHistory}
                    loading={customerHistoryLoading}
                    error={customerHistoryError}
                    onOpenDetailedHistory={() => openWorkspaceHistory("CART_ITEMS")}
                    onOpenInvoice={setCartHistoryInvoiceId}
                  />
                </div>
              </div>

              {/* Column 2: Central Cart (5 cols = ~42%) */}
              <div className={`billing-cart-column ${mobileBillingPane === "cart" ? "" : "hidden md:flex"}`}>
                <BillingCartTable
                  cart={cartTableItems}
                  note={invoiceNote}
                  onChangeNote={setInvoiceNote}
                  selectedRowIndex={selectedCartRowIndex}
                  onSelectRow={index => { queuedCartNavigationRef.current = []; if (cartNavigationFrameRef.current !== null) cancelAnimationFrame(cartNavigationFrameRef.current); cartNavigationFrameRef.current = null; setSelectedCartRowIndex(index); }}
                  onUpdateQty={(productId, newQty) => changeQty(productId, newQty)}
                  onRemoveItem={(productId) => removeLine(productId)}
                  onClearCart={requestResetBill}
                  canClearDraft={hasBillDraft}
                  onOpenPriceOverride={(item) => {
                    const row = cartRows.find((r) => r.productId === item.productId);
                    if (row) openPriceOverride(row);
                  }}
                  onParkBill={requestParkBill}
                  parkedCount={parkedDrafts.length}
                  onOpenParkedModal={() => setShowParkedBills(true)}
                  customerHistoryItems={customerHistory}
                  selectedCustomerId={selectedCustomer?.id}
                  onOpenDifferPopover={(item, past, anchor) => setPriceDifferItem({ item, past, anchor })}
                />
              </div>

            </>}
              {/* Column 3: Customer & Payment Summary + Quick Actions (3 cols = ~25%) */}
              <div className={`billing-summary-column ${mobileBillingPane === "customer" ? "" : "hidden md:flex"}`}>
                <BillingCustomerSummary searchOpen={isCustomerSearchOpen} onChangeSearchOpen={setCustomerSearchOpen}
                  onOpenQrGallery={() => setIsQrGalleryOpen(true)}
                  selectedCustomer={selectedCustomer as any}
                  recentPurchase={[...customerHistory].sort((a, b) => Date.parse(b.invoiceDate || "1970-01-01") - Date.parse(a.invoiceDate || "1970-01-01"))[0]}
                  onSelectCustomer={(c) => { if (c) setCustomers(current => { const exists = current.some(customer => customer.id === c.id); return exists ? current.map(customer => customer.id === c.id ? { ...customer, ...c } as Customer : customer) : [...current, c as Customer]; }); setSelectedCustomerId(c?.id || null); }}
                  customers={customers as any}
                  searchResults={workspaceCustomerResults}
                  searchLoading={workspaceCustomerLoading}
                  searchError={workspaceCustomerError}
                  onSearchCustomers={searchWorkspaceCustomers}
                  subTotal={subTotal}
                  discountLabel={subtotalDiscountMeta.label}
                  discountPercent={subtotalDiscountMeta.percent || 0}
                  discountAmount={subtotalDiscount}
                  payableTotal={payableTotal}
                  onReviewInWorksheet={() => setActiveWorkspaceTab("worksheet")}
                  onOpenCustomerHistory={() => openWorkspaceHistory()}
                  onOpenDueHistory={() => openWorkspaceHistory("INVOICES", "OUTSTANDING")}
                  cartItemCount={cart.length}
                  canReviewWorksheet={cart.length > 0}
                  canConfirm={canConfirm}
                  pendingCheckout={pendingCheckout}
                  onPayNow={() => openPaymentFlow()}
                  paymentMethod={paymentMethod === "Cash" ? "CASH" : paymentMethod === "Fonepay" ? "FONEPAY" : paymentMethod === "Bank Transfer" ? "BANK" : "OTHER"}
                  onChangePaymentMethod={value => setPaymentMethod(value === "CASH" ? "Cash" : value === "FONEPAY" ? "Fonepay" : "Bank Transfer")}
                  amountReceived={cashTendered}
                  onChangeAmountReceived={setCashTendered}
                />


              </div>
            </div>

          {activeWorkspaceTab === "worksheet" && (
            <BillingWorksheetView
              cart={cartTableItems}
              customer={selectedCustomer as any}
              subTotal={subTotal}
              discountLabel={subtotalDiscountMeta.label}
                  discountPercent={subtotalDiscountMeta.percent || 0}
              discountAmount={subtotalDiscount}
              payableTotal={payableTotal}
              cashReceived={paymentMethod === "Cash" ? cashTendered : ""}
              onChooseCustomer={() => setCustomerSearchOpen(true)}
              cashierName={currentUser?.name || operatorLabel}
              business={businessIdentity}
              note={invoiceNote}
              onChangeNote={setInvoiceNote}
              paperDocumentType={paperDraftDocumentType}
              onChangePaperDocumentType={setPaperDraftDocumentType}
              paperBillNo={paperDraftBillNo}
              onChangePaperBillNo={setPaperDraftBillNo}
              paperBillDate={paperDraftBillDate}
              onChangePaperBillDate={setPaperDraftBillDate}
              isPaperException={isPaperException}
              onTogglePaperException={setIsPaperException}
              paperExceptionReason={paperExceptionReason}
              onChangePaperExceptionReason={setPaperExceptionReason}
              onUpdateQty={(productId, newQty) => changeQty(productId, newQty)}
              onRemoveItem={(productId) => removeLine(productId)}
              onBackToBilling={() => setActiveWorkspaceTab("billing")}
              onContinueToPayment={handleContinueToPaymentFromWorksheet}
              onOpenOcrComparison={() => setIsOcrComparisonOpen(true)}
            />
          )}

          <div className={activeWorkspaceTab === "history" ? "h-full min-h-0" : "hidden"}>
            <BillingPurchaseHistoryV2 selectedCustomer={selectedCustomer as any} cart={cartTableItems}
              visible={activeWorkspaceTab === "history"} navigation={historyNavigation}
              onChangeCustomer={() => setCustomerSearchOpen(true)}
              onReturnToBilling={() => setActiveWorkspaceTab("billing")} />
          </div>
        </div>
      <div className={`billing-shortcut-footer ${activeWorkspaceTab === "billing" ? "hidden md:flex" : "hidden"}`}><span>Shortcuts</span>{[["F2","Search"],["F3","Scanner"],["F4","Cash"],["F5","eSewa"],["F6","Park"],["F7","Customer"],["Alt+H","Held"],["F8","Price"],["F9","Clear"],["Shift+Enter","Review"]].map(([key,label])=><span key={key}><kbd>{key}</kbd> {label}</span>)}<span className="ml-auto">Operator: {operatorLabel} · Terminal: {terminalLabel}</span></div>
      {activeWorkspaceTab === "billing" && <div className="shrink-0 border-t border-line bg-white p-3 md:hidden"><div className="flex items-center justify-between gap-3"><span className="text-sm font-semibold">{pendingCheckout ? typeof pendingCheckout.payload.confirmation?.payableTotal === "number" ? formatBillingMoney(pendingCheckout.payload.confirmation.payableTotal) : "Submitted total not recorded" : formatBillingMoney(payableTotal)}</span><button type="button" disabled={!canConfirm} onClick={() => pendingCheckout ? openPaymentFlow() : setActiveWorkspaceTab("worksheet")} className="rounded-lg bg-action px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40">{pendingCheckout ? "Recover checkout" : "Review in Worksheet"}</button></div></div>}
      </div>

      {/* OCR Comparison Modal */}
      <BillingOcrComparisonModal presentation="billing"
        open={isOcrComparisonOpen}
        onClose={() => setIsOcrComparisonOpen(false)}
        cart={cartTableItems}
        payableTotal={payableTotal}
        currentBillNo={paperDraftBillNo}
        currentBillDate={paperDraftBillDate}
        sourceFile={ocrSourceFile}
        sourceObservations={ocrSourceObservations}
        fingerprint={currentWorksheetFingerprint()}
        onRetainSource={(file, observations, checked, fingerprint) => { setOcrSourceFile(file); setOcrSourceObservations(observations); setOcrCheckedFingerprint(checked ? fingerprint : null); }}
        onApplyReference={(no, date) => {
          setPaperDraftBillNo(no);
          setPaperDraftBillDate(date);
          showToast("success", `Applied reference: ${no}`);
        }}
      />

      {/* Price Differ Popover */}
      <BillingPriceDifferPopover
        open={Boolean(priceDifferItem)}
        onClose={() => setPriceDifferItem(null)}
        item={priceDifferItem ? cartTableItems.find(line => line.productId === priceDifferItem.item.productId) || null : null}
        pastPurchases={priceDifferItem?.past || []}
        anchor={priceDifferItem?.anchor}
        onApplyPastPrice={(price) => {
          if (priceDifferItem) {
            applyDirectPriceOverride(priceDifferItem.item.productId, price);
          }
        }}
      />

<ModalFrame presentation="billing"
        open={showShortcutHelp}
        onClose={() => setShowShortcutHelp(false)}
        title="Billing shortcuts"
        description="Keyboard actions for fast billing."
        maxWidthClass="max-w-[450px]"
        compact
      >
        <div className="grid gap-2 text-[11px] font-bold text-[#565449] sm:grid-cols-2">
          {[
            ["Alt+Up/Down", "Move row"],
            ["Alt+Del", "Remove row"],
            ["Alt+Backspace", "Remove row"],
            ["Alt+Shift++", "Qty up"],
            ["Alt+Shift+-", "Qty down"],
            ["Alt+Shift+Q", "Edit qty"],
            ["Alt+P", "Override"],
            ["Alt+H", "Held bills"],
            ["Alt+1/2/3", "Pay method"],
          ].map(([keys, action]) => (
            <div
              key={keys}
              className="flex h-[36px] items-center justify-between gap-2 rounded-[10px] border border-[#CFCFD3] bg-[#F8F9FA] px-2.5"
            >
              <span className="min-w-0 truncate font-mono text-[11px] font-extrabold text-[#11120d]">
                {keys}
              </span>
              <span className="shrink-0 text-right">{action}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 rounded-[10px] border border-[#CFCFD3] bg-white px-3 py-2 text-[11px] font-semibold leading-[17px] text-[#565449]">
          Destructive keys use the active row. Esc closes the top panel first,
          then returns focus to product search.
        </div>
      </ModalFrame>

      <ConfirmPaymentModal
        open={showPaymentModal}
        onClose={closePaymentFlow}
        onConfirm={requestCheckoutConfirm}
        submitting={submitting}
        stockRefreshBusy={stockRefreshBusy}
        canConfirm={canConfirm}
        cartRows={cartRows}
        cart={cart}
        selectedCustomer={selectedCustomer}
        payableTotal={payableTotal}
        subTotal={subTotal}
        subtotalDiscount={subtotalDiscount}
        hasPriceOverrides={hasPriceOverrides}
        overrideDiffIsReduction={overrideDiffIsReduction}
        overrideDiffLabel={overrideDiffLabel}
        overrideDiffDisplay={overrideDiffDisplay}
        effectivePaidAmount={effectivePaidAmount}
        balanceDue={balanceDue}
        cashDueAmount={cashDueAmount}
        paymentMethod={paymentMethod}
        setPaymentMethod={setPaymentMethod}
        paymentStatus={paymentStatus}
        setPaymentStatus={setPaymentStatus}
        paidAmount={paidAmount}
        setPaidAmount={setPaidAmount}
        cashTendered={cashTendered}
        setCashTendered={setCashTendered}
        changeDue={changeDue}
        cashShort={cashShort}
        fonepayReference={fonepayReference}
        setFonepayReference={setFonepayReference}
        receivingAccountId={receivingAccountId}
        setReceivingAccountId={setReceivingAccountId}
        setReceivingAccountVersion={setReceivingAccountVersion}
        setReceivingAccountLabel={setReceivingAccountLabel}
        manualReceiptConfirmed={manualReceiptConfirmed}
        setManualReceiptConfirmed={setManualReceiptConfirmed}
        fonepayConfirmed={fonepayConfirmed}
        setFonepayConfirmed={setFonepayConfirmed}
        enabledPaymentAccounts={enabledPaymentAccounts}
        bankTransferReference={bankTransferReference}
        setBankTransferReference={setBankTransferReference}
        splitPayments={splitPayments}
        updateSplitPayment={updateSplitPayment}
        removeSplitPayment={removeSplitPayment}
        addSplitPayment={addSplitPayment}
        isSplitBalanced={isSplitBalanced}
        splitBalance={splitBalance}
        splitCashNum={splitCashNum}
        splitEsewaAmount={splitEsewaAmount}
        splitFonepayAmount={splitFonepayAmount}
        splitTotal={splitTotal}
        ensureDefaultSplitPayments={ensureDefaultSplitPayments}
        invoiceNote={invoiceNote}
        setInvoiceNote={setInvoiceNote}
        isPaperException={isPaperException}
        paperExceptionReason={paperExceptionReason}
        paperDraftBillNo={paperDraftBillNo}
        setPaperDraftBillNo={setPaperDraftBillNo}
        paperDraftDocumentType={paperDraftDocumentType}
        setPaperDraftDocumentType={setPaperDraftDocumentType}
        paperDraftBillDate={paperDraftBillDate}
        setPaperDraftBillDate={setPaperDraftBillDate}
        paperDraftChoice={paperDraftChoice}
        setPaperDraftChoice={setPaperDraftChoice}
        storageLimitationWarning={storageLimitationWarning}
        gatewayDisplay={gatewayDisplay}
        setShowEsewaQr={setShowEsewaQr}
        setIsQrGalleryOpen={setIsQrGalleryOpen}
        loadEnabledPaymentAccounts={loadEnabledPaymentAccounts}
        paymentError={paymentError}
        setPaymentError={setPaymentError}
        billingError={billingError}
        setBillingError={setBillingError}
        setReviewedCandidate={setReviewedCandidate}
        paymentStateTone={paymentStateTone}
        paymentStateTitle={paymentStateTitle}
        paymentStateDetail={paymentStateDetail}
        formatBillingMoney={formatBillingMoney}
        formatQty={formatQty}
      />
      <ModalFrame presentation="billing"
        open={!!priceOverrideTargetRow}
        onClose={closePriceOverride}
        title={isManager ? "Approve price override" : "Verify price override"}
        description={
          isManager
            ? "Manager approval will be audited before this changed price becomes active."
            : "Enter the admin PIN before this changed price becomes active in the cart."
        }
        maxWidthClass="max-w-[560px]"
      >
        {priceOverrideTargetRow ? (
          <div className="space-y-5">
            <div className="rounded-[18px] border border-[#CFCFD3] bg-[#F8F9FA] p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[15px] font-extrabold text-[#000000]">
                    {priceOverrideTargetRow.product.name}
                  </div>
                  <div className="mt-1 text-[12px] font-semibold text-[#8C8889]">
                    SKU {priceOverrideTargetRow.product.sku} | Normal{" "}
                    {formatBillingMoney(priceOverrideTargetRow.baseUnitPrice)}
                  </div>
                </div>
                <div className="rounded-[14px] border border-slate-200 bg-white px-3 py-2 text-right">
                  <div className="text-[10px] font-extrabold uppercase text-slate-400">
                    Qty
                  </div>
                  <div className="font-mono text-[16px] font-extrabold text-[#000000]">
                    {formatQty(priceOverrideTargetRow.qty)}
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_1fr]">
              <Input
                label="New price"
                value={priceOverrideDraftPrice}
                onChange={(value) => {
                  setPriceOverrideDraftPrice(value.replace(/[^\d.]/g, ""));
                  setPriceOverrideError("");
                }}
                placeholder="Sale price"
                leftIcon="currency_rupee"
                inputMode="decimal"
              />

              <div>
                <label className="mb-2 block text-[11px] font-extrabold uppercase tracking-wide text-[#64748B]">
                  Reason
                </label>
                <ProjectSelect
                  value={priceOverrideDraftReason}
                  onChange={(event) => {
                    setPriceOverrideDraftReason(event.target.value);
                    setPriceOverrideError("");
                  }}
                  className="h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-extrabold text-[#11120d] outline-none transition focus:border-[#11120d] focus:ring-2 focus:ring-[#11120d]/10"
                  aria-label="Price override reason"
                >
                  <option value="" disabled>
                    Select valid reason
                  </option>
                  {PRICE_OVERRIDE_REASONS.map((reason) => (
                    <option key={reason} value={reason}>
                      {reason}
                    </option>
                  ))}
                </ProjectSelect>
              </div>
            </div>

            {isManager ? (
              <div className="rounded-[18px] border border-sky-200 bg-sky-50 px-4 py-3 text-[12px] font-semibold text-sky-800">
                This manager override will be logged with the item, old price,
                new price, quantity, and reason. Checkout will validate the
                authorization again before final billing.
              </div>
            ) : (
              <>
                <div className="rounded-[24px] border border-[#E3E6EE] bg-white px-5 py-6 text-center shadow-[0_18px_44px_rgba(15,23,42,0.08)]">
                  <div className="text-[24px] font-extrabold tracking-normal text-slate-900">
                    Verification PIN
                  </div>
                  <div className="mt-2 text-[13px] font-semibold text-slate-500">
                    Enter PIN to override the product price.
                  </div>

                  <div
                    className="relative mx-auto mt-6 flex max-w-[300px] justify-center gap-3"
                    onClick={() => priceOverridePinRef.current?.focus()}
                  >
                    {Array.from({ length: 4 }).map((_, index) => {
                      const digit = priceOverrideDraftPin[index] || "";
                      const active =
                        priceOverrideDraftPin.length === index ||
                        (index === 3 && priceOverrideDraftPin.length === 4);
                      return (
                        <div
                          key={index}
                          className={cn(
                            "flex h-[58px] w-[50px] items-center justify-center rounded-[14px] border bg-[#F8FAFC] text-[24px] font-extrabold text-slate-900 transition",
                            active
                              ? "border-blue-500 ring-4 ring-blue-100"
                              : "border-[#D7DCE8]",
                          )}
                        >
                          {digit ? "•" : ""}
                        </div>
                      );
                    })}
                    <input
                      ref={priceOverridePinRef}
                      value={priceOverrideDraftPin}
                      onChange={(event) => {
                        setPriceOverrideDraftPin(
                          event.target.value.replace(/\D/g, "").slice(0, 4),
                        );
                        setPriceOverrideError("");
                      }}
                      inputMode="numeric"
                      autoComplete="off"
                      className="absolute inset-0 h-full w-full cursor-text opacity-0"
                      aria-label="Override PIN"
                    />
                  </div>

                  {priceOverrideError ? (
                    <div className="mx-auto mt-4 max-w-[360px] rounded-[14px] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-semibold text-rose-700">
                      {priceOverrideError}
                    </div>
                  ) : null}
                </div>
              </>
            )}
            {isManager && priceOverrideError ? (
              <div className="rounded-[14px] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-semibold text-rose-700">
                {priceOverrideError}
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-3">
              <div>
                {priceOverrideTargetRow.overrideUnitPrice !== undefined ? (
                  <DialogButton presentation="billing"
                    variant="danger"
                    icon="undo"
                    onClick={() => {
                      clearPriceOverride(priceOverrideTargetRow.productId);
                      closePriceOverride();
                    }}
                  >
                    Remove override
                  </DialogButton>
                ) : null}
              </div>
              <div className="flex items-center gap-3">
                <DialogButton presentation="billing" onClick={closePriceOverride}>Cancel</DialogButton>
                <DialogButton presentation="billing"
                  variant="primary"
                  icon="verified_user"
                  onClick={applyPriceOverride}
                  disabled={priceOverrideBusy}
                >
                  {priceOverrideBusy
                    ? isManager
                      ? "Approving..."
                      : "Verifying..."
                    : isManager
                      ? "Approve & Apply"
                      : "Verify & Apply"}
                </DialogButton>
              </div>
            </div>
          </div>
        ) : null}
      </ModalFrame>

      <ModalFrame presentation="billing"
        open={stockConflicts.length > 0}
        onClose={() => {
          setStockConflicts([]);
          setBillingError("");
        }}
        title="Stock changed"
        description="Some cart quantities are no longer available. Adjust them before checkout."
        maxWidthClass="max-w-[760px]"
      >
        <div className="space-y-5">
          <div className="rounded-[18px] border border-[#F6D28B] bg-[#FFF7E8] px-4 py-3 text-[13px] font-semibold text-[#B7791F]">
            Another sale or product update changed stock while this bill was
            open.
          </div>

          <div className="max-h-[360px] overflow-y-auto rounded-[18px] border border-[#CFCFD3]">
            <div className="grid grid-cols-[minmax(0,1fr)_120px_120px_160px] gap-3 border-b border-[#CFCFD3] bg-[#F3F4F6] px-4 py-3 text-[11px] font-extrabold uppercase text-[#8C8889]">
              <div>Item</div>
              <div className="text-right">Requested</div>
              <div className="text-right">Available</div>
              <div className="text-right">Action</div>
            </div>

            <div className="divide-y divide-[#E5E7EB]">
              {stockConflicts.map((conflict) => {
                const product = productsById.get(conflict.productId);
                const unavailable =
                  conflict.availableStock <= 0 ||
                  conflict.reason === "NOT_FOUND" ||
                  conflict.reason === "INACTIVE" ||
                  conflict.reason === "OUT_OF_STOCK";

                return (
                  <div
                    key={conflict.productId}
                    className="grid grid-cols-[minmax(0,1fr)_120px_120px_160px] items-center gap-3 px-4 py-3 text-[13px]"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-extrabold text-[#000000]">
                        {conflict.productName}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] font-semibold text-[#8C8889]">
                        {conflict.sku || product?.sku ? (
                          <span>SKU {conflict.sku || product?.sku}</span>
                        ) : null}
                        <span>
                          {conflict.reason === "INACTIVE"
                            ? "Inactive"
                            : conflict.reason === "NOT_FOUND"
                              ? "Not found"
                              : unavailable
                                ? "Unavailable"
                                : "Reduce quantity"}
                        </span>
                      </div>
                    </div>
                    <div className="text-right font-mono font-extrabold text-[#000000]">
                      {formatQtyWithUnit(
                        conflict.requestedQty,
                        product?.saleUnit,
                      )}
                    </div>
                    <div
                      className={cn(
                        "text-right font-mono font-extrabold",
                        unavailable ? "text-[#BE123C]" : "text-[#B7791F]",
                      )}
                    >
                      {formatQtyWithUnit(
                        conflict.availableStock,
                        product?.saleUnit,
                      )}
                    </div>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => applyStockConflictSuggestion(conflict)}
                        className={cn(
                          "h-[34px] rounded-[12px] border px-3 text-[12px] font-extrabold transition",
                          unavailable
                            ? "border-[#FECDD3] bg-[#FFF1F2] text-[#BE123C] hover:bg-rose-100"
                            : "border-[#F6D28B] bg-[#FFF7E8] text-[#B7791F] hover:bg-amber-100",
                        )}
                      >
                        {unavailable
                          ? "Remove"
                          : `Reduce to ${formatQty(conflict.availableStock)}`}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
            <DialogButton presentation="billing"
              onClick={() => void refreshStockConflictList()}
              disabled={stockRefreshBusy}
              icon="sync"
            >
              {stockRefreshBusy ? "Refreshing..." : "Refresh Stock"}
            </DialogButton>
            <DialogButton presentation="billing"
              onClick={applyAllStockConflictSuggestions}
              variant="primary"
              icon="done_all"
            >
              Apply Suggestions
            </DialogButton>
          </div>
        </div>
      </ModalFrame>

      <ModalFrame presentation="billing"
        open={showIncomingRequests}
        onClose={() => {
          if (draftRequestBusy) return;
          setShowIncomingRequests(false);
          setSelectedIncomingRequest(null);
          setDraftReviewDecisions({});
          setDraftRejectNote("");
          setIncomingRequestsError("");
          setAcceptedResolution(null);
          setAcceptedResolutionReason("");
          setAcceptedResolutionError("");
        }}
        title={
          selectedIncomingRequest
            ? selectedIncomingRequest.requestNo
            : "Incoming Requests"
        }
        description={
          selectedIncomingRequest
            ? `${getRequestCustomerLabel(selectedIncomingRequest)} · ${getRequestStatusLabel(selectedIncomingRequest)}`
            : "Review staff requests and load accepted items into Billing."
        }
        maxWidthClass="max-w-[780px]"
        mobileBottomSheet
        compact
        headerActions={
          !selectedIncomingRequest ? (
            <button
              type="button"
              onClick={() => void loadIncomingRequests()}
              disabled={incomingRequestsLoading}
              className="inline-flex h-[34px] items-center gap-1 rounded-[10px] border border-[#CFCFD3] bg-white px-2.5 text-[11px] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6] disabled:opacity-50"
            >
              <Icon
                name="sync"
                className={cn(
                  "text-[15px]",
                  incomingRequestsLoading && "animate-spin",
                )}
              />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setSelectedIncomingRequest(null);
                setDraftReviewDecisions({});
                setDraftRejectNote("");
                setAcceptedResolution(null);
                setAcceptedResolutionReason("");
                setAcceptedResolutionError("");
              }}
              disabled={draftRequestBusy}
              className="inline-flex h-[34px] items-center gap-1 rounded-[10px] border border-[#CFCFD3] bg-white px-2.5 text-[11px] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6] disabled:opacity-50"
            >
              <Icon name="arrow_back" className="text-[15px]" />
              <span className="hidden sm:inline">Requests</span>
            </button>
          )
        }
        footer={
          selectedIncomingRequest ? (
            <div className="flex w-full items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => {
                  setSelectedIncomingRequest(null);
                  setDraftReviewDecisions({});
                  setDraftRejectNote("");
                  setAcceptedResolution(null);
                  setAcceptedResolutionReason("");
                  setAcceptedResolutionError("");
                }}
                disabled={draftRequestBusy}
                className="inline-flex h-9 items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-white px-3 text-[11px] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6] disabled:opacity-50"
              >
                Back
              </button>
              <div className="flex min-w-0 items-center justify-end gap-2">
                {acceptedResolution?.requestId === selectedIncomingRequest.id ? (
                  <button
                    type="button"
                    onClick={() => {
                      setAcceptedResolution(null);
                      setAcceptedResolutionReason("");
                      setAcceptedResolutionError("");
                    }}
                    disabled={draftRequestBusy}
                    className="inline-flex h-9 items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-white px-3 text-[11px] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6] disabled:opacity-50"
                  >
                    Keep accepted
                  </button>
                ) : (
                  <>
                    {selectedIncomingRequest.status === "PENDING" ||
                    selectedIncomingRequest.status === "MODIFIED" ? (
                      <button
                        type="button"
                        onClick={() => void rejectIncomingRequest()}
                        disabled={draftRequestBusy}
                        className="inline-flex h-9 items-center justify-center gap-1.5 rounded-[10px] border border-[#FECDD3] bg-[#FFF1F2] px-3 text-[11px] font-extrabold text-[#BE123C] transition hover:bg-rose-100 disabled:opacity-50"
                      >
                        <Icon name="cancel" className="text-[15px]" />
                        {draftRequestBusy ? "Working..." : "Reject request"}
                      </button>
                    ) : null}
                    {selectedIncomingRequest.status === "ACCEPTED" ||
                    selectedIncomingRequest.status === "PARTIALLY_ACCEPTED" ? (
                      <button
                        type="button"
                        onClick={() => openAcceptedResolution(selectedIncomingRequest)}
                        disabled={draftRequestBusy}
                        className="inline-flex h-9 items-center justify-center gap-1.5 rounded-[10px] border border-amber-300 bg-amber-50 px-3 text-[11px] font-extrabold text-amber-800 transition hover:bg-amber-100 disabled:opacity-50"
                      >
                        <Icon name="move_to_inbox" className="text-[15px]" />
                        Resolve
                      </button>
                    ) : null}
                  <button
                    type="button"
                      onClick={() => void reviewAndLoadIncomingRequest()}
                      disabled={draftRequestBusy || Boolean(activeDraftRequestId)}
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-[10px] border border-[#11120d] bg-[#11120d] px-3 text-[11px] font-extrabold text-white transition hover:bg-[#2a2c27] disabled:opacity-50"
                    >
                      <Icon name="add_shopping_cart" className="text-[15px]" />
                      {draftRequestBusy
                        ? "Loading..."
                        : selectedIncomingRequest.status === "ACCEPTED" ||
                            selectedIncomingRequest.status ===
                              "PARTIALLY_ACCEPTED"
                          ? "Load into Billing"
                          : "Review & Load"}
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : undefined
        }
      >
        {!selectedIncomingRequest ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={incomingRequestsTotal > 0 ? "green" : "neutral"}>
                {incomingRequestsTotal} pending
              </Pill>
              {unseenIncomingRequestCount > 0 ? (
                <Pill tone="orange">
                  {unseenIncomingRequestCount} unseen
                </Pill>
              ) : null}
              {activeDraftRequestId ? (
                <Pill tone="sky">A request is loaded</Pill>
              ) : null}
            </div>

            {incomingRequestsError ? (
              <div className="rounded-[14px] border border-[#FECDD3] bg-[#FFF1F2] px-3 py-2.5 text-[12px] font-semibold text-[#BE123C]">
                {incomingRequestsError}
              </div>
            ) : null}

            <div className="overflow-hidden rounded-[16px] border border-[#CFCFD3] bg-white">
              {incomingRequestsLoading && incomingRequests.length === 0 ? (
                <div className="flex min-h-[220px] flex-col items-center justify-center px-5 py-8 text-center">
                  <Icon
                    name="sync"
                    className="mb-3 animate-spin text-[34px] text-slate-300"
                  />
                  <div className="text-[13px] font-extrabold text-slate-700">
                    Checking incoming requests
                  </div>
                </div>
              ) : incomingRequests.length === 0 ? (
                <div className="flex min-h-[220px] flex-col items-center justify-center px-5 py-8 text-center">
                  <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
                    <Icon name="inbox" className="text-[30px]" />
                  </div>
                  <div className="text-[15px] font-extrabold text-slate-800">
                    No incoming requests
                  </div>
                  <div className="mt-1 max-w-[360px] text-[12px] font-semibold leading-5 text-slate-500">
                    Staff requests assigned to you will appear here
                    automatically.
                  </div>
                </div>
              ) : (
                <div className="divide-y divide-[#E5E7EB]">
                  {incomingRequests.map((request) => {
                    const unseen =
                      (request.status === "PENDING" ||
                        request.status === "MODIFIED") &&
                      !request.firstViewedAt;
                    const accepted =
                      request.status === "ACCEPTED" ||
                      request.status === "PARTIALLY_ACCEPTED";
                    return (
                      <button
                        key={request.id}
                        type="button"
                        onClick={() => void openIncomingRequest(request)}
                        disabled={draftRequestBusy}
                        className="grid w-full min-w-0 gap-3 px-3 py-3 text-left transition hover:bg-[#F8FAFC] disabled:opacity-60 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-4"
                      >
                        <div className="min-w-0">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="truncate text-[14px] font-extrabold text-[#11120d]">
                              {request.requestNo}
                            </span>
                            <Pill
                              tone={
                                unseen
                                  ? "orange"
                                  : accepted
                                    ? "green"
                                    : "sky"
                              }
                            >
                              {getRequestStatusLabel(request)}
                            </Pill>
                          </div>
                          <div className="mt-1 truncate text-[12px] font-bold text-[#565449]">
                            {getRequestCustomerLabel(request)}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] font-semibold text-[#8C8889]">
                            <span>
                              From {request.createdBy?.name || "Staff"}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span>
                              {formatRequestDateTime(request.createdAt)}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center justify-between gap-3 sm:justify-end">
                          <div className="text-left sm:text-right">
                            <div className="text-[12px] font-extrabold text-[#11120d]">
                              {getRequestItemCount(request)} item(s) ·{" "}
                              {formatQty(getRequestTotalQty(request))} unit(s)
                            </div>
                            <div className="mt-1 font-mono text-[13px] font-extrabold text-[#11120d]">
                              {formatBillingMoney(getRequestEstimatedTotal(request))}
                            </div>
                          </div>
                          <Icon
                            name="chevron_right"
                            className="shrink-0 text-[20px] text-slate-400"
                          />
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-2.5">
            {activeDraftRequestId === selectedIncomingRequest.id ? (
              <div className="rounded-[11px] border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] font-semibold leading-4 text-emerald-800">
                This request is currently loaded in Billing. Complete checkout
                or use Resolve below if the sale will not continue.
              </div>
            ) : activeDraftRequestId ? (
              <div className="rounded-[11px] border border-[#F6D28B] bg-[#FFF7E8] px-3 py-2 text-[11px] font-semibold leading-4 text-[#B7791F]">
                Another staff request is already loaded in Billing. Complete
                or clear that bill before loading this one.
              </div>
            ) : cart.length > 0 ? (
              <div className="rounded-[11px] border border-sky-200 bg-sky-50 px-3 py-2 text-[11px] font-semibold leading-4 text-sky-800">
                Your current bill will be held safely before accepted request
                items are loaded. It will never be overwritten.
              </div>
            ) : null}

            {acceptedResolution?.requestId === selectedIncomingRequest.id ? (
              <section
                className="rounded-[12px] border-2 border-amber-300 bg-amber-50/70 p-3 shadow-[0_0_0_3px_rgba(251,191,36,0.10)]"
                aria-labelledby="accepted-resolution-heading"
              >
                <div className="flex items-start gap-2.5">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-amber-100 text-amber-800">
                    <Icon name="rule" className="text-[18px]" />
                  </div>
                  <div className="min-w-0">
                    <div
                      id="accepted-resolution-heading"
                      className="text-[13px] font-extrabold text-amber-950"
                    >
                      This accepted request did not reach checkout
                    </div>
                    <p className="mt-0.5 text-[11px] font-semibold leading-4 text-amber-900">
                      Return it when another cashier should continue. Cancel it
                      only when the sale is no longer needed. History is kept.
                    </p>
                  </div>
                </div>

                <label
                  htmlFor="accepted-request-resolution-reason"
                  className="mt-3 block text-[11px] font-extrabold text-slate-800"
                >
                  Reason <span className="text-rose-600">*</span>
                </label>
                <textarea
                  id="accepted-request-resolution-reason"
                  data-modal-initial-focus
                  value={acceptedResolutionReason}
                  onChange={(event) => {
                    setAcceptedResolutionReason(event.target.value);
                    if (event.target.value.trim().length >= 3) {
                      setAcceptedResolutionError("");
                    }
                  }}
                  rows={2}
                  maxLength={500}
                  placeholder="Example: Customer left before payment"
                  aria-invalid={Boolean(acceptedResolutionError)}
                  aria-describedby={
                    acceptedResolutionError
                      ? "accepted-request-resolution-error"
                      : undefined
                  }
                  className={cn(
                    "mt-1 w-full resize-none rounded-[10px] border bg-white px-3 py-2 text-[12px] font-semibold text-slate-900 outline-none transition focus:ring-2",
                    acceptedResolutionError
                      ? "border-rose-500 focus:border-rose-500 focus:ring-rose-100"
                      : "border-amber-300 focus:border-amber-500 focus:ring-amber-100",
                  )}
                />
                {acceptedResolutionError ? (
                  <div
                    id="accepted-request-resolution-error"
                    role="alert"
                    className="mt-1.5 flex items-center gap-1.5 text-[11px] font-bold text-rose-700"
                  >
                    <Icon name="error" className="text-[15px]" />
                    {acceptedResolutionError}
                  </div>
                ) : null}

                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => void resolveAcceptedRequest("RETURN_TO_QUEUE")}
                    disabled={draftRequestBusy}
                    className="inline-flex min-h-10 items-center justify-center gap-2 rounded-[10px] border border-amber-300 bg-white px-3 text-[11px] font-extrabold text-amber-900 transition hover:bg-amber-100 disabled:opacity-50"
                  >
                    <Icon name="move_to_inbox" className="text-[16px]" />
                    Return to queue
                  </button>
                  <button
                    type="button"
                    onClick={() => void resolveAcceptedRequest("CANCEL")}
                    disabled={draftRequestBusy}
                    className="inline-flex min-h-10 items-center justify-center gap-2 rounded-[10px] border border-rose-300 bg-rose-50 px-3 text-[11px] font-extrabold text-rose-700 transition hover:bg-rose-100 disabled:opacity-50"
                  >
                    <Icon name="cancel" className="text-[16px]" />
                    Cancel request
                  </button>
                </div>
              </section>
            ) : null}

            <div className="grid grid-cols-2 gap-1.5 lg:grid-cols-4">
              {[
                {
                  label: "Requested by",
                  value:
                    selectedIncomingRequest.createdBy?.name || "Staff",
                },
                {
                  label: "Customer",
                  value: getRequestCustomerLabel(selectedIncomingRequest),
                },
                {
                  label: "Created",
                  value: formatRequestDateTime(
                    selectedIncomingRequest.createdAt,
                  ),
                },
                {
                  label: "Respond by",
                  value: formatRequestDateTime(
                    selectedIncomingRequest.expiresAt,
                  ),
                },
              ].map((metric) => (
                <div
                  key={metric.label}
                  className="min-w-0 rounded-[10px] border border-[#E5E7EB] bg-[#F8FAFC] px-2.5 py-2"
                >
                  <div className="text-[10px] font-extrabold uppercase tracking-wide text-[#8C8889]">
                    {metric.label}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] font-extrabold text-[#11120d]">
                    {metric.value}
                  </div>
                </div>
              ))}
            </div>

            {selectedIncomingRequest.notes ? (
              <div className="rounded-[11px] border border-[#E5E7EB] bg-white px-3 py-2">
                <div className="text-[10px] font-extrabold uppercase tracking-wide text-[#8C8889]">
                  Staff note
                </div>
                <div className="mt-1 whitespace-pre-wrap text-[11px] font-semibold leading-4 text-[#565449]">
                  {selectedIncomingRequest.notes}
                </div>
              </div>
            ) : null}

            <div className="overflow-hidden rounded-[12px] border border-[#CFCFD3] bg-white">
              <div className="border-b border-[#E5E7EB] bg-[#F8FAFC] px-3 py-2 text-[10px] font-extrabold uppercase tracking-wide text-[#565449]">
                Review {selectedIncomingRequest.items?.length || 0} item(s)
              </div>
              <div className="divide-y divide-[#E5E7EB]">
                {(selectedIncomingRequest.items || []).map((item) => {
                  const product = item.product;
                  const requestedQty = Number(item.qty || 1);
                  const decision = draftReviewDecisions[item.id] || {
                    action:
                      item.reviewStatus === "REJECTED"
                        ? ("REJECT" as const)
                        : ("ACCEPT" as const),
                    acceptedQty: Number(
                      item.acceptedQty ?? item.qty ?? 1,
                    ),
                    reason: item.rejectionReason || "",
                  };
                  const editable =
                    selectedIncomingRequest.status === "PENDING" ||
                    selectedIncomingRequest.status === "MODIFIED";

                  return (
                    <div key={item.id} className="px-3 py-2.5">
                      <div className="flex min-w-0 items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-extrabold text-[#11120d]">
                            {product?.name || "Unavailable product"}
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] font-semibold leading-4 text-[#8C8889]">
                            {product?.sku ? <span>SKU {product.sku}</span> : null}
                            <span>
                              Requested{" "}
                              {formatQtyWithUnit(
                                requestedQty,
                                product?.saleUnit || undefined,
                              )}
                            </span>
                            {typeof product?.stock === "number" ? (
                              <span>
                                Stock{" "}
                                {formatQtyWithUnit(
                                  product.stock,
                                  product.saleUnit || undefined,
                                )}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="shrink-0 font-mono text-[11px] font-extrabold text-[#11120d]">
                          {formatBillingMoney(
                            requestedQty *
                              Number(product?.retailPrice || 0),
                          )}
                        </div>
                      </div>

                      {editable ? (
                        <div
                          className={cn(
                            "mt-2 grid items-end gap-2",
                            decision.action === "ACCEPT"
                              ? "grid-cols-[minmax(0,1fr)_112px]"
                              : "grid-cols-[132px_minmax(0,1fr)]",
                          )}
                        >
                          <div className="grid h-[34px] grid-cols-2 overflow-hidden rounded-[9px] border border-[#CFCFD3]">
                            <button
                              type="button"
                              onClick={() =>
                                updateDraftReviewDecision(item.id, {
                                  action: "ACCEPT",
                                  reason: "",
                                })
                              }
                              className={cn(
                                "border-r border-[#CFCFD3] px-2 text-[10px] font-extrabold transition",
                                decision.action === "ACCEPT"
                                  ? "bg-emerald-50 text-emerald-800"
                                  : "bg-white text-[#565449] hover:bg-[#F3F4F6]",
                              )}
                            >
                              Accept
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                updateDraftReviewDecision(item.id, {
                                  action: "REJECT",
                                })
                              }
                              className={cn(
                                "px-2 text-[10px] font-extrabold transition",
                                decision.action === "REJECT"
                                  ? "bg-rose-50 text-rose-700"
                                  : "bg-white text-[#565449] hover:bg-[#F3F4F6]",
                              )}
                            >
                              Reject
                            </button>
                          </div>

                          {decision.action === "ACCEPT" ? (
                            <label className="block">
                              <span className="mb-0.5 block truncate text-[9px] font-extrabold uppercase tracking-wide text-[#565449]">
                                Qty accepted
                              </span>
                              <input
                                type="number"
                                min={Number(product?.quantityStep || 1)}
                                max={requestedQty}
                                step={Number(product?.quantityStep || 1)}
                                value={decision.acceptedQty}
                                onChange={(event) =>
                                  updateDraftReviewDecision(item.id, {
                                    acceptedQty: Number(event.target.value),
                                  })
                                }
                                className="h-[34px] w-full rounded-[9px] border border-[#CFCFD3] bg-white px-2.5 text-[12px] font-extrabold text-[#11120d] outline-none transition focus:border-[#11120d] focus:ring-2 focus:ring-black/5"
                              />
                            </label>
                          ) : (
                            <label className="block">
                              <span className="mb-0.5 block text-[9px] font-extrabold uppercase tracking-wide text-[#565449]">
                                Reason
                              </span>
                              <input
                                id={`draft-reject-reason-${item.id}`}
                                value={decision.reason}
                                onChange={(event) =>
                                  updateDraftReviewDecision(item.id, {
                                    reason: event.target.value,
                                  })
                                }
                                placeholder="Reason required"
                                aria-invalid={Boolean(draftReviewErrors[item.id])}
                                aria-describedby={
                                  draftReviewErrors[item.id]
                                    ? `draft-reject-reason-error-${item.id}`
                                    : undefined
                                }
                                className={cn(
                                  "h-[34px] w-full rounded-[9px] border bg-white px-2.5 text-[11px] font-semibold text-[#11120d] outline-none transition placeholder:text-slate-400 focus:ring-2",
                                  draftReviewErrors[item.id]
                                    ? "border-rose-500 focus:border-rose-500 focus:ring-rose-100"
                                    : "border-[#CFCFD3] focus:border-[#11120d] focus:ring-black/5",
                                )}
                              />
                              {draftReviewErrors[item.id] ? (
                                <span
                                  id={`draft-reject-reason-error-${item.id}`}
                                  className="mt-1 block text-[10px] font-bold text-rose-600"
                                  role="alert"
                                >
                                  {draftReviewErrors[item.id]}
                                </span>
                              ) : null}
                            </label>
                          )}
                        </div>
                      ) : (
                        <div
                          className={cn(
                            "mt-2 rounded-[9px] border px-2.5 py-1.5 text-[11px] font-semibold",
                            item.reviewStatus === "REJECTED"
                              ? "border-rose-200 bg-rose-50 text-rose-700"
                              : "border-emerald-200 bg-emerald-50 text-emerald-800",
                          )}
                        >
                          {item.reviewStatus === "REJECTED"
                            ? `Rejected: ${item.rejectionReason || "No reason recorded"}`
                            : `Accepted ${formatQtyWithUnit(
                                Number(item.acceptedQty ?? item.qty ?? 0),
                                product?.saleUnit || undefined,
                              )}`}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {selectedIncomingRequest.status === "PENDING" ||
            selectedIncomingRequest.status === "MODIFIED" ? (
              <label className="block">
                <span className="mb-1 block text-[9px] font-extrabold uppercase tracking-wide text-[#565449]">
                  Whole-request rejection note (optional)
                </span>
                <textarea
                  value={draftRejectNote}
                  onChange={(event) => setDraftRejectNote(event.target.value)}
                  rows={1}
                  placeholder="Used only if you reject the entire request"
                  className="min-h-9 w-full resize-none rounded-[9px] border border-[#CFCFD3] bg-white px-2.5 py-2 text-[11px] font-semibold text-[#11120d] outline-none transition placeholder:text-slate-400 focus:border-[#11120d] focus:ring-2 focus:ring-black/5"
                />
              </label>
            ) : null}
          </div>
        )}
      </ModalFrame>

      <ModalFrame presentation="billing"
        open={showParkedBills}
        onClose={() => setShowParkedBills(false)}
        title="Held bills"
        description="Resume a parked bill or discard old drafts."
        maxWidthClass="max-w-[720px]"
        compact
      >
        <div className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <Pill
                tone={visibleParkedDrafts.length > 0 ? "orange" : "neutral"}
              >
                {visibleParkedDrafts.length} held
              </Pill>
              {cart.length > 0 ? (
                <Pill tone="sky">Current cart auto-parks on resume</Pill>
              ) : null}
            </div>
            <Button
              size="sm"
              onClick={() => void loadParkedDrafts()}
              icon="sync"
              disabled={parkedBusy}
            >
              Refresh
            </Button>
          </div>

          {parkedError ? (
            <div className="rounded-[10px] border border-[#FECDD3] bg-[#FFF1F2] px-[10px] py-[7px] text-[12px] font-semibold text-[#BE123C]">
              {parkedError}
            </div>
          ) : null}

          <div className="max-h-[420px] overflow-y-auto rounded-[14px] border border-[#CFCFD3]">
            {visibleParkedDrafts.length === 0 ? (
              <div className="flex min-h-[150px] flex-col items-center justify-center px-5 py-8 text-center">
                <Icon
                  name="pending_actions"
                  className="mb-2 text-[36px] text-slate-300"
                />
                <div className="text-[14px] font-extrabold text-slate-700">
                  No held bills
                </div>
                <div className="mt-1 text-[12px] font-semibold text-slate-400">
                  Park the current cart to serve another customer and resume it
                  later.
                </div>
              </div>
            ) : (
              <div className="divide-y divide-[#E5E7EB]">
                {visibleParkedDrafts.map((draft) => {
                  const units = getParkedDraftUnitCount(draft);
                  const parkedAt = draft.parkedAt
                    ? new Date(draft.parkedAt).toLocaleString()
                    : "Recently parked";
                  const preview = (draft.items || [])
                    .slice(0, 2)
                    .map((item) => item.product?.name || item.productId)
                    .join(", ");

                  return (
                    <div
                      key={draft.id}
                      className="grid gap-3 px-3 py-3 md:grid-cols-[minmax(0,1fr)_190px]"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="truncate text-[14px] font-extrabold text-[#000000]">
                            {getParkedDraftTitle(draft)}
                          </div>
                          {draft.invoiceNo ? (
                            <Pill tone="neutral">{draft.invoiceNo}</Pill>
                          ) : null}
                        </div>
                        <div className="mt-1 text-[12px] font-semibold text-[#8C8889]">
                          {draft.customer?.name || "Walk-in Customer"} |{" "}
                          {parkedAt}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] font-semibold text-[#565449]">
                          <span className="rounded-[7px] border border-[#CFCFD3] bg-[#F3F4F6] px-2 py-0.5">
                            {(draft.items || []).length} line(s)
                          </span>
                          <span className="rounded-[7px] border border-[#CFCFD3] bg-[#F3F4F6] px-2 py-0.5">
                            {formatQty(units)} total qty
                          </span>
                          <span className="rounded-[7px] border border-[#CFCFD3] bg-[#F3F4F6] px-2 py-0.5">
                            {formatBillingMoney(Number(draft.subTotal || 0))}
                          </span>
                        </div>
                        {preview ? (
                          <div className="mt-1.5 truncate text-[12px] font-medium text-[#8C8889]">
                            {preview}
                            {(draft.items || []).length > 2
                              ? ` + ${(draft.items || []).length - 2} more`
                              : ""}
                          </div>
                        ) : null}
                      </div>

                      <div className="flex items-center justify-end gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          icon="delete"
                          disabled={parkedBusy}
                          onClick={() => setPendingDiscardParked(draft)}
                        >
                          Discard
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          icon="open_in_new"
                          disabled={parkedBusy}
                          onClick={() => void resumeParkedBill(draft)}
                        >
                          Resume
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </ModalFrame>

      <ModalFrame presentation="billing"
        open={!!pendingStaleResume}
        onClose={() => setPendingStaleResume(null)}
        title="Review held bill changes"
        description="Prices or available stock changed since this bill was parked."
        maxWidthClass="max-w-[760px]"
        footer={
          <>
            <DialogButton presentation="billing"
              onClick={() => void discardPendingStaleResume()}
              variant="danger"
              icon="delete"
              disabled={parkedBusy}
            >
              Discard Held Bill
            </DialogButton>
            <DialogButton presentation="billing"
              onClick={() => {
                if (pendingStaleResume)
                  void loadResumedParkedDraft(pendingStaleResume);
              }}
              variant="primary"
              icon="check_circle"
              disabled={parkedBusy}
            >
              Continue With Current Data
            </DialogButton>
          </>
        }
      >
        <div className="space-y-4">
          <div className="rounded-[16px] border border-[#F6D28B] bg-[#FFF7E8] px-4 py-3 text-[13px] font-semibold text-[#B7791F]">
            Continuing will use the latest product prices and available stock
            shown in billing. Review any quantity reductions before checkout.
          </div>

          <div className="max-h-[360px] overflow-y-auto rounded-[18px] border border-[#CFCFD3]">
            <div className="grid grid-cols-[minmax(0,1fr)_110px_110px_120px] gap-3 border-b border-[#CFCFD3] bg-[#F3F4F6] px-4 py-3 text-[11px] font-extrabold uppercase text-[#8C8889]">
              <div>Item</div>
              <div className="text-right">Parked</div>
              <div className="text-right">Current</div>
              <div className="text-right">Available</div>
            </div>
            <div className="divide-y divide-[#E5E7EB]">
              {(pendingStaleResume?.staleWarnings || []).map((warning) => (
                <div
                  key={`${warning.productId}-${warning.warnings.join("-")}`}
                  className="grid grid-cols-[minmax(0,1fr)_110px_110px_120px] items-center gap-3 px-4 py-3 text-[13px]"
                >
                  <div className="min-w-0">
                    <div className="truncate font-extrabold text-[#000000]">
                      {warning.productName}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {warning.warnings.map((item) => (
                        <span
                          key={item}
                          className="rounded-full bg-[#E8F2FF] px-2 py-0.5 text-[10px] font-extrabold uppercase text-[#2563EB]"
                        >
                          {item}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="text-right font-mono font-extrabold text-[#565449]">
                    {formatBillingMoney(warning.parkedUnitPrice)}
                  </div>
                  <div
                    className={cn(
                      "text-right font-mono font-extrabold",
                      warning.currentUnitPrice !== warning.parkedUnitPrice
                        ? "text-[#B7791F]"
                        : "text-[#565449]",
                    )}
                  >
                    {formatBillingMoney(warning.currentUnitPrice)}
                  </div>
                  <div
                    className={cn(
                      "text-right font-mono font-extrabold",
                      warning.availableStock < warning.qty
                        ? "text-[#BE123C]"
                        : "text-[#0F766E]",
                    )}
                  >
                    {formatQty(warning.availableStock)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </ModalFrame>

      <ModalFrame presentation="billing"
        open={Boolean(
          acceptedResolution &&
            (!showIncomingRequests ||
              selectedIncomingRequest?.id !== acceptedResolution.requestId),
        )}
        onClose={() => {
          if (draftRequestBusy) return;
          setAcceptedResolution(null);
          setAcceptedResolutionReason("");
          setAcceptedResolutionError("");
        }}
        title="Resolve accepted request"
        description={`${acceptedResolution?.requestNo || "Staff request"} was accepted but has not produced a finalized invoice.`}
        maxWidthClass="max-w-[560px]"
        mobileBottomSheet
        layer="critical"
        footer={
          <div className="grid w-full gap-2 sm:grid-cols-[auto_1fr_1fr]">
            <DialogButton presentation="billing"
              onClick={() => {
                setAcceptedResolution(null);
                setAcceptedResolutionReason("");
                setAcceptedResolutionError("");
              }}
              disabled={draftRequestBusy}
            >
              Keep accepted
            </DialogButton>
            <DialogButton presentation="billing"
              onClick={() => void resolveAcceptedRequest("RETURN_TO_QUEUE")}
              disabled={draftRequestBusy}
              icon="move_to_inbox"
            >
              Return to queue
            </DialogButton>
            <DialogButton presentation="billing"
              onClick={() => void resolveAcceptedRequest("CANCEL")}
              disabled={draftRequestBusy}
              variant="danger"
              icon="cancel"
            >
              Cancel request
            </DialogButton>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="rounded-[14px] border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] font-semibold leading-5 text-amber-900">
            Return to queue when another cashier should continue it. Cancel only
            when the customer or staff no longer needs the sale. Neither action
            deletes request history.
          </div>
          <label
            htmlFor="accepted-request-resolution-reason"
            className="block text-[12px] font-extrabold text-slate-700"
          >
            Reason <span className="text-rose-600">*</span>
          </label>
          <textarea
            id="accepted-request-resolution-reason"
            data-modal-initial-focus
            value={acceptedResolutionReason}
            onChange={(event) => {
              setAcceptedResolutionReason(event.target.value);
              if (event.target.value.trim().length >= 3) {
                setAcceptedResolutionError("");
              }
            }}
            rows={3}
            maxLength={500}
            placeholder="Example: Customer left before payment"
            aria-invalid={Boolean(acceptedResolutionError)}
            aria-describedby={
              acceptedResolutionError
                ? "accepted-request-resolution-modal-error"
                : undefined
            }
            className={cn(
              "w-full resize-none rounded-[12px] border bg-white px-3 py-2.5 text-[13px] font-semibold text-slate-900 outline-none transition focus:ring-2",
              acceptedResolutionError
                ? "border-rose-500 focus:border-rose-500 focus:ring-rose-100"
                : "border-slate-300 focus:border-blue-500 focus:ring-blue-100",
            )}
          />
          {acceptedResolutionError ? (
            <div
              id="accepted-request-resolution-modal-error"
              role="alert"
              className="text-[11px] font-bold text-rose-700"
            >
              {acceptedResolutionError}
            </div>
          ) : null}
        </div>
      </ModalFrame>

      {pendingBillingConfirmConfig ? (
        <ConfirmDialog presentation="billing"
          open={!!pendingBillingConfirmConfig}
          title={pendingBillingConfirmConfig.title}
          message={pendingBillingConfirmConfig.message}
          confirmLabel={pendingBillingConfirmConfig.confirmLabel}
          onConfirm={pendingBillingConfirmConfig.onConfirm}
          onClose={() => setPendingBillingConfirm(null)}
          tone={pendingBillingConfirmConfig.tone}
          icon={pendingBillingConfirmConfig.icon}
          details={pendingBillingConfirmConfig.details}
          busy={submitting || stockRefreshBusy || parkedBusy}
        />
      ) : null}

      {pendingDiscardParked ? (
        <ConfirmDialog presentation="billing"
          open={!!pendingDiscardParked}
          title="Discard held bill?"
          message="This parked draft will be permanently removed from Held Bills."
          confirmLabel="Discard Bill"
          onConfirm={confirmDiscardParkedBill}
          onClose={() => setPendingDiscardParked(null)}
          tone="danger"
          icon="delete"
          details={
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span>Bill</span>
                <span className="font-extrabold text-slate-900">
                  {getParkedDraftTitle(pendingDiscardParked)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Items</span>
                <span className="font-extrabold text-slate-900">
                  {(pendingDiscardParked.items || []).length} line(s),{" "}
                  {formatQty(getParkedDraftUnitCount(pendingDiscardParked))}{" "}
                  total qty
                </span>
              </div>
            </div>
          }
          busy={parkedBusy}
        />
      ) : null}

      <SuccessDialog presentation="billing"
        open={showSuccess}
        title="Invoice created successfully"
        message="The invoice has been finalized and recorded in KhataSathi."
        onClose={() => {
          setShowSuccess(false);
          setSavedSaleResult(null);
        }}
        actionLabel="Continue Billing"
        secondaryAction={
          lastCreatedInvoiceId ? (
            <div className="flex flex-wrap gap-2">
              <DialogButton presentation="billing"
                onClick={() => openInvoicePrint(lastCreatedInvoiceId)}
                icon="print"
              >
                Print Invoice
              </DialogButton>
              <DialogButton presentation="billing"
                onClick={() => openInvoiceReceiptPrint(lastCreatedInvoiceId)}
                icon="receipt_long"
              >
                Receipt
              </DialogButton>
              {savedSaleResult && savedSaleResult.balanceDue > 0 ? (
                <DialogButton presentation="billing" onClick={() => {
                  setShowSuccess(false);
                  setManualPaymentInvoiceId(savedSaleResult.invoiceId);
                }} icon="payments">Record Received Payment</DialogButton>
              ) : null}
              {savedSaleResult && !savedSaleResult.paperRecorded && !savedSaleResult.paperBillNo ? (
                <DialogButton presentation="billing"
                  onClick={() => {
                    setShowSuccess(false);
                    setPaperFollowup({
                      status: "PENDING",
                      invoiceId: lastCreatedInvoiceId,
                      invoiceNo: savedSaleResult.invoiceNo,
                      draft: {
                        billNo: "",
                        externalDocumentType: "PAN_INVOICE",
                        externalBillDate: new Date().toLocaleDateString("en-CA"),
                      },
                    });
                  }}
                  icon="history_edu"
                >
                  Record Paper Details
                </DialogButton>
              ) : null}
            </div>
          ) : null
        }
      >
        {savedSaleResult ? (
          <div className="my-3 rounded-[12px] border border-[#DADDE3] bg-[#F8FAFC] p-3 text-[12px] space-y-1.5">
            <div className="flex justify-between items-center text-[#565449]">
              <span>Invoice No.</span>
              <span className="font-mono font-bold text-[#11120D]">{savedSaleResult.invoiceNo || savedSaleResult.invoiceId}</span>
            </div>
            <div className="flex justify-between items-center text-[#565449]">
              <span>Total Amount</span>
              <span className="font-mono font-bold text-[#11120D]">{formatBillingMoney(savedSaleResult.total)}</span>
            </div>
            <div className="flex justify-between items-center text-[#565449]">
              <span>Collected / Paid</span>
              <span className="font-mono font-bold text-emerald-700">{formatBillingMoney(savedSaleResult.effectivePaidAmount)}</span>
            </div>
            {savedSaleResult.pendingGatewayAmount && savedSaleResult.pendingGatewayAmount > 0 ? (
              <div className="flex justify-between items-center text-amber-800">
                <span>Pending Verification (Gateway)</span>
                <span className="font-mono font-bold">{formatBillingMoney(savedSaleResult.pendingGatewayAmount)}</span>
              </div>
            ) : null}
            {savedSaleResult.balanceDue > 0 ? (
              <div className="flex justify-between items-center text-amber-800">
                <span>Balance Due</span>
                <span className="font-mono font-bold">{formatBillingMoney(savedSaleResult.balanceDue)}</span>
              </div>
            ) : null}
            <div className="flex justify-between items-center text-[#565449] pt-1 border-t border-[#E5E7EB]">
              <span>Payment Status</span>
              <span className="font-bold text-[#11120D] uppercase">
                {savedSaleResult.paymentStatus} ({savedSaleResult.paymentMethod})
                {savedSaleResult.pendingGatewayAmount && savedSaleResult.pendingGatewayAmount > 0
                  ? " · PENDING GATEWAY VERIFICATION"
                  : ""}
              </span>
            </div>
            <div className="flex justify-between items-center text-[#565449]">
              <span>Paper Reference</span>
              <span className={cn("font-bold", savedSaleResult.paperRecorded ? "text-emerald-700" : "text-amber-700")}>
                {savedSaleResult.paperRecorded
                  ? `Recorded (${savedSaleResult.paperBillNo || "Yes"})`
                  : "Pending Recording"}
              </span>
            </div>
            {storageLimitationWarning ? (
              <div className="mt-2 rounded-[8px] border border-amber-300 bg-amber-50 p-2 text-[11px] font-semibold text-amber-900">
                <Icon name="warning" className="mr-1 inline text-[13px] text-amber-700" />
                {storageLimitationWarning}
              </div>
            ) : null}
            {savedSaleResult.receivingDestinations?.map((destination, index) => (
              <div key={`${destination.accountId}-${index}`} className="border-t border-[#cfcfd3] pt-2 text-[#565449]">
                <span className="font-semibold">Recorded receiving destination: </span>
                {destination.providerLabel} — {destination.accountHolder} — {destination.accountIdentifier || "No identifier recorded"}
              </div>
            ))}
          </div>
        ) : null}
      </SuccessDialog>

      <SavedSalePaymentFollowup
        actorId={currentUser?.id || ""}
        invoiceId={manualPaymentInvoiceId}
        onClose={() => setManualPaymentInvoiceId(null)}
      />


      <BillingInvoicePreview invoiceId={cartHistoryInvoiceId} onClose={() => setCartHistoryInvoiceId(null)} />
      <BillingCalculatorModal
        open={isCalculatorOpen}
        onClose={() => setIsCalculatorOpen(false)}
      />

      {selectedCustomer ? (
        <BillingCustomerHistoryModal
          open={isDetailedHistoryOpen}
          onClose={() => setIsDetailedHistoryOpen(false)}
          customerId={selectedCustomer.id}
          customerName={selectedCustomer.name}
        />
      ) : null}

      {selectedCustomer && isCompactHistoryOpen ? (
        <BillingCompactHistoryOverlay
          open={isCompactHistoryOpen}
          onClose={handleCloseCompactHistory}
          onOpenDetailedHistory={handleOpenDetailedHistoryFromCompact}
          customerName={selectedCustomer.name}
          historyItems={customerHistory}
          loading={customerHistoryLoading}
          error={customerHistoryError}
          cartItemCount={cartRows.length}
          anchorRef={compactHistoryTriggerRef}
        />
      ) : null}

      {(paperFollowup.status === "FAILED_RETRYABLE" ||
        paperFollowup.status === "PENDING") && (
        <div className="fixed bottom-4 right-4 z-40 w-full max-w-lg rounded-xl border border-amber-300 bg-amber-50 p-4 shadow-xl text-[13px] text-amber-900 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 font-bold">
              <Icon name="warning" className="text-[18px] text-amber-600" />
              <span>Pending Paper Bill Reference</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setPaperFollowup({ status: "NONE" });
              }}
              className="text-amber-700 hover:text-amber-900"
              aria-label="Dismiss paper reference banner"
            >
              <Icon name="close" className="text-[16px]" />
            </button>
          </div>

          <p className="text-[12px] text-amber-800">
            Invoice <strong>{paperFollowup.invoiceNo || paperFollowup.invoiceId}</strong> is
            finalized in the database. Enter and record the manual paper bill details below.
            {paperFollowup.error ? (
              <span className="block mt-1 font-semibold text-rose-700">Error: {paperFollowup.error}</span>
            ) : null}
          </p>

          {storageLimitationWarning ? (
            <div className="rounded-[8px] border border-amber-300 bg-amber-100 p-2 text-[11px] font-semibold text-amber-900">
              <Icon name="warning" className="mr-1 inline text-[13px] text-amber-700" />
              {storageLimitationWarning}
            </div>
          ) : null}

          {paperFollowup.conflictRecord ? (
            <div className="rounded-lg border border-rose-300 bg-rose-50 p-2.5 text-[11px] text-rose-900 space-y-1.5">
              <div className="font-bold">Record Conflict: Another operator modified this record on the server.</div>
              <div>
                Current Status: <strong>{paperFollowup.conflictRecord.billRecordStatus}</strong> &bull; Bill No: <strong>{paperFollowup.conflictRecord.externalBillNo || "None"}</strong>
              </div>
              <button
                type="button"
                onClick={() => {
                  const conf = paperFollowup.conflictRecord!;
                  setPaperFollowup((prev) => ({
                    ...prev,
                    expected: {
                      billingChannel: conf.billingChannel,
                      externalDocumentType: conf.externalDocumentType,
                      externalBillNo: conf.externalBillNo,
                      externalBillDate: conf.externalBillDate,
                      billRecordStatus: conf.billRecordStatus,
                    },
                    conflictRecord: null,
                    error: undefined,
                  }));
                }}
                className="rounded bg-rose-700 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-rose-800"
              >
                Acknowledge & Update Expected State
              </button>
            </div>
          ) : null}

          {/* Editable paper reference form */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 rounded-lg border border-amber-200 bg-white p-2.5">
            <div>
              <label className="block text-[10px] font-extrabold uppercase text-[#565449] mb-0.5">
                Bill Number
              </label>
              <input
                type="text"
                disabled={paperFollowupBusy}
                value={paperFollowup.draft?.billNo || ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setPaperFollowup((prev) => ({
                    ...prev,
                    draft: {
                      billNo: val,
                      externalDocumentType: prev.draft?.externalDocumentType || "PAN_INVOICE",
                      externalBillDate: prev.draft?.externalBillDate || new Date().toLocaleDateString("en-CA"),
                    },
                  }));
                }}
                placeholder="e.g. PB-2080-001"
                className="h-[32px] w-full rounded border border-[#CFCFD3] px-2 text-[12px] font-bold text-[#11120D] outline-none focus:border-[#11120D] disabled:opacity-60"
              />
            </div>
            <div>
              <label className="block text-[10px] font-extrabold uppercase text-[#565449] mb-0.5">
                Document Type
              </label>
              <ProjectSelect
                disabled={paperFollowupBusy}
                value={paperFollowup.draft?.externalDocumentType || "PAN_INVOICE"}
                onChange={(e) => {
                  const val = e.target.value as ExternalDocumentType;
                  setPaperFollowup((prev) => ({
                    ...prev,
                    draft: {
                      billNo: prev.draft?.billNo || "",
                      externalDocumentType: val,
                      externalBillDate: prev.draft?.externalBillDate || new Date().toLocaleDateString("en-CA"),
                    },
                  }));
                }}
                className="h-[32px] w-full text-[11px] font-bold"
              >
                <option value="PAN_INVOICE">PAN Invoice</option>
                <option value="VAT_TAX_INVOICE">VAT Tax Invoice</option>
                <option value="ABBREVIATED_TAX_INVOICE">Abbreviated Tax Invoice</option>
                <option value="OTHER_MANUAL_SALES_DOCUMENT">Other Manual Sales Document</option>
              </ProjectSelect>
            </div>
            <div>
              <label className="block text-[10px] font-extrabold uppercase text-[#565449] mb-0.5">
                Bill Date
              </label>
              <ProjectDateInput
                disabled={paperFollowupBusy}
                value={paperFollowup.draft?.externalBillDate || new Date().toLocaleDateString("en-CA")}
                onChange={(e) => {
                  const val = e.target.value;
                  setPaperFollowup((prev) => ({
                    ...prev,
                    draft: {
                      billNo: prev.draft?.billNo || "",
                      externalDocumentType: prev.draft?.externalDocumentType || "PAN_INVOICE",
                      externalBillDate: val,
                    },
                  }));
                }}
                className="h-[32px] w-full text-[11px] font-bold"
              >
              </ProjectDateInput>
            </div>
          </div>

          {paperFollowup.duplicateRequired ? (
            <div className="space-y-1">
              <label className="block text-[10px] font-extrabold uppercase text-amber-900">
                Manager Duplicate Override Reason (Min 2 chars) <span className="text-rose-600">*</span>
              </label>
              <input
                type="text"
                disabled={paperFollowupBusy}
                value={paperFollowup.duplicateOverrideReason || ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setPaperFollowup((prev) => ({
                    ...prev,
                    duplicateOverrideReason: val,
                  }));
                }}
                placeholder="Required reviewer authorization justification"
                className="h-[32px] w-full rounded border border-amber-400 bg-white px-2.5 text-[12px] font-semibold outline-none focus:border-amber-700 disabled:opacity-60"
              />
            </div>
          ) : null}

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              disabled={
                paperFollowupBusy ||
                !paperFollowup.draft?.billNo?.trim() ||
                (paperFollowup.duplicateRequired && !(paperFollowup.duplicateOverrideReason?.trim().length && paperFollowup.duplicateOverrideReason.trim().length >= 2))
              }
              onClick={handleRetryPaperFollowup}
              className="rounded-lg bg-amber-600 px-3.5 py-1.5 text-[12px] font-bold text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {paperFollowupBusy ? "Saving..." : "Save Paper Reference"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPaperFollowup({ status: "NONE" });
              }}
              className="rounded-lg border border-amber-300 bg-white px-3.5 py-1.5 text-[12px] font-bold text-amber-800 hover:bg-amber-50"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      <CashierQrGalleryModal presentation="billing"
        open={isQrGalleryOpen}
        onClose={() => setIsQrGalleryOpen(false)}
      />
    </>
  );
}
