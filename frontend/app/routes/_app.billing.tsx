import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Icon from "~/components/ui/Icon";
import ProjectSelect from "~/components/ui/ProjectSelect";
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
  listProductsApi,
  checkoutInvoiceApi,
  listCustomersApi,
  authorizePriceOverrideApi,
  discardParkedDraftApi,
  listParkedDraftsApi,
  parkInvoiceDraftApi,
  resumeParkedDraftApi,
  type CashierPrivilege,
} from "~/lib/api/endpoints";
import { submitEsewaForm } from "~/lib/esewa";
import { getAuthUser } from "~/lib/auth";
import { openInvoicePrint, openInvoiceReceiptPrint } from "~/lib/invoices";
import { isRateLimitError } from "~/lib/api/client";
import { useRateLimitRecovery } from "~/lib/api/useRateLimitRecovery";

const PRODUCT_REFRESH_INTERVAL_MS = 120_000; // refreshing the product catalog every 2 minutes to prevent stale stock and prices while keeping request volume low
const LAST_INVOICE_PRINT_STORAGE_KEY = "khatasathi:lastInvoicePrintId";
const MANUAL_SEARCH_LIMIT = 12;
const BILLING_VIEW_SIZE_STORAGE_KEY = "khatasathi:billingViewSize";
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
const BILLING_VIEW_DENSITY: Record<
  BillingViewSize,
  {
    scaleLabel: string;
    topBar: string;
    searchWidth: string;
    scanWidth: string;
    inputHeight: string;
    topButton: string;
    tableCols: string;
    header: string;
    headerHash: string;
    headerTitle: string;
    headerSub: string;
    row: string;
    rowMain: string;
    rowSub: string;
    qtyControl: string;
    qtyButton: string;
    qtyInput: string;
    rowAction: string;
    rightPanel: string;
    rightPanelInner: string;
    rightTopStack: string;
    rightCheckoutStack: string;
    customerCard: string;
    billSummary: string;
    billSummaryTitle: string;
    billSummaryRows: string;
    statusCard: string;
    grandCard: string;
    grandLabel: string;
    grandTotal: string;
    payButton: string;
    secondaryButton: string;
    footer: string;
  }
> = {
  "85": {
    scaleLabel: "85%",
    topBar: "gap-2.5 px-[14px] py-[10px]",
    searchWidth: "w-[500px] max-w-[38vw]",
    scanWidth: "w-[255px]",
    inputHeight: "h-[36px]",
    topButton:
      "flex h-[36px] items-center gap-1.5 rounded-[12px] border border-[#CFCFD3] bg-[#FFFFFF] px-2.5 text-[12px] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6] disabled:opacity-50",
    tableCols: "grid-cols-[36px_minmax(200px,1fr)_98px_112px_126px_100px_44px]",
    header:
      "gap-2.5 border-b border-[#DADDE3] bg-[#F8FAFC] px-[13px] py-[6px] mt-[2px]",
    headerHash: "text-center text-[15px] font-extrabold",
    headerTitle: "text-[13px] font-extrabold leading-4",
    headerSub: "mt-0.5 text-[10px] font-bold leading-3 text-[#565449]",
    row: "gap-2 px-[13px] py-[4px]",
    rowMain: "truncate text-[12px] font-extrabold leading-4 text-[#11120d]",
    rowSub: "mt-0.5 truncate text-[10px] font-bold leading-3 text-[#565449]",
    qtyControl: "h-[28px]",
    qtyButton: "w-[32px] text-[15px]",
    qtyInput: "w-[46px] text-[12px]",
    rowAction: "h-[28px] w-[28px]",
    rightPanel: "w-[28%] min-w-[280px] max-w-[400px]",
    rightPanelInner: "gap-[9px] px-[12px] py-[10px]",
    rightTopStack: "space-y-[10px] shrink-0",
    rightCheckoutStack: "mt-auto space-y-[10px]",
    customerCard: "p-[11px]",
    billSummary: "py-[16px] px-[18px]",
    billSummaryTitle: "mb-[8px] text-[15px]",
    billSummaryRows: "space-y-[8px] text-[14px]",
    statusCard: "px-[9px] py-[7px]",
    grandCard: "p-[12px]",
    grandLabel: "mb-[4px] text-[12px]",
    grandTotal: "text-[32px]",
    payButton: "h-[48px] text-[13px]",
    secondaryButton: "h-[38px] text-[12px]",
    footer: "px-[16px] py-[6px] text-[10px]",
  },
  "90": {
    scaleLabel: "90%",
    topBar: "gap-3 px-[16px] py-[12px]",
    searchWidth: "w-[520px] max-w-[39vw]",
    scanWidth: "w-[270px]",
    inputHeight: "h-[38px]",
    topButton:
      "flex h-[38px] items-center gap-1.5 rounded-[12px] border border-[#CFCFD3] bg-[#FFFFFF] px-3 text-[12px] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6] disabled:opacity-50",
    tableCols:
      "grid-cols-[38px_minmax(220px,1fr)_104px_118px_132px_106px_46px]",
    header:
      "gap-3 border-b border-[#DADDE3] bg-[#F8FAFC] px-[14px] py-[7px] mt-[2px]",
    headerHash: "text-center text-[16px] font-extrabold",
    headerTitle: "text-[13px] font-extrabold leading-4",
    headerSub: "mt-0.5 text-[10px] font-bold leading-3 text-[#565449]",
    row: "gap-2 px-[14px] py-[5px]",
    rowMain: "truncate text-[12px] font-extrabold leading-4 text-[#11120d]",
    rowSub: "mt-0.5 truncate text-[10px] font-bold leading-3 text-[#565449]",
    qtyControl: "h-[30px]",
    qtyButton: "w-[34px] text-[16px]",
    qtyInput: "w-[48px] text-[12px]",
    rowAction: "h-[30px] w-[30px]",
    rightPanel: "w-[28%] min-w-[280px] max-w-[400px]",
    rightPanelInner: "gap-[10px] px-[14px] py-[11px]",
    rightTopStack: "space-y-[11px] shrink-0",
    rightCheckoutStack: "mt-auto space-y-[11px]",
    customerCard: "p-[12px]",
    billSummary: "py-[18px] px-[20px]",
    billSummaryTitle: "mb-[9px] text-[16px]",
    billSummaryRows: "space-y-[9px] text-[15px]",
    statusCard: "px-[10px] py-[8px]",
    grandCard: "p-[14px]",
    grandLabel: "mb-[5px] text-[13px]",
    grandTotal: "text-[34px]",
    payButton: "h-[50px] text-[14px]",
    secondaryButton: "h-[40px] text-[12px]",
    footer: "px-[18px] py-[7px] text-[11px]",
  },
  "95": {
    scaleLabel: "95%",
    topBar: "gap-3 px-[16px] py-[12px]",
    searchWidth: "w-[540px] max-w-[40vw]",
    scanWidth: "w-[285px]",
    inputHeight: "h-[39px]",
    topButton:
      "flex h-[39px] items-center gap-1.5 rounded-[13px] border border-[#CFCFD3] bg-[#FFFFFF] px-3.5 text-[12px] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6] disabled:opacity-50",
    tableCols:
      "grid-cols-[40px_minmax(230px,1fr)_110px_124px_138px_112px_48px]",
    header:
      "gap-3 border-b border-[#DADDE3] bg-[#F8FAFC] px-[16px] py-[8px] mt-[2px]",
    headerHash: "text-center text-[17px] font-extrabold",
    headerTitle: "text-[14px] font-extrabold leading-5",
    headerSub: "mt-0.5 text-[11px] font-bold leading-4 text-[#565449]",
    row: "gap-2.5 px-[16px] py-[6px]",
    rowMain: "truncate text-[12px] font-extrabold leading-5 text-[#11120d]",
    rowSub: "mt-0.5 truncate text-[10px] font-bold leading-4 text-[#565449]",
    qtyControl: "h-[32px]",
    qtyButton: "w-[36px] text-[17px]",
    qtyInput: "w-[50px] text-[12px]",
    rowAction: "h-[30px] w-[30px]",
    rightPanel: "w-[28%] min-w-[280px] max-w-[400px]",
    rightPanelInner: "gap-[12px] px-[16px] py-[12px]",
    rightTopStack: "space-y-[12px] shrink-0",
    rightCheckoutStack: "mt-auto space-y-[12px]",
    customerCard: "p-[13px]",
    billSummary: "py-[22px] px-[22px]",
    billSummaryTitle: "mb-[10px] text-[17px]",
    billSummaryRows: "space-y-[10px] text-[16px]",
    statusCard: "px-[11px] py-[8px]",
    grandCard: "p-[16px]",
    grandLabel: "mb-[5px] text-[14px]",
    grandTotal: "text-[37px]",
    payButton: "h-[54px] text-[15px]",
    secondaryButton: "h-[42px] text-[12px]",
    footer: "px-[20px] py-[8px] text-[11px]",
  },
  "100": {
    scaleLabel: "100%",
    topBar: "gap-4 px-[18px] py-[15px]",
    searchWidth: "w-[560px] max-w-[42vw]",
    scanWidth: "w-[300px]",
    inputHeight: "h-[40px]",
    topButton:
      "flex h-[40px] items-center gap-2 rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] px-4 text-[13px] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6] disabled:opacity-50",
    tableCols:
      "grid-cols-[44px_minmax(260px,1fr)_118px_132px_150px_120px_54px]",
    header:
      "gap-3 border-b border-[#DADDE3] bg-[#F8FAFC] px-[18px] py-[10px] mt-[3px]",
    headerHash: "text-center text-[18px] font-extrabold",
    headerTitle: "text-[15px] font-extrabold leading-5",
    headerSub: "mt-0.5 text-[12px] font-bold leading-4 text-[#565449]",
    row: "gap-3 px-[18px] py-[7px]",
    rowMain: "truncate text-[13px] font-extrabold leading-5 text-[#11120d]",
    rowSub: "mt-0.5 truncate text-[11px] font-bold leading-4 text-[#565449]",
    qtyControl: "h-[34px]",
    qtyButton: "w-[38px] text-[18px]",
    qtyInput: "w-[54px] text-[13px]",
    rowAction: "h-[32px] w-[32px]",
    rightPanel: "w-[30%] min-w-[300px] max-w-[420px]",
    rightPanelInner: "gap-[14px] px-[20px] py-[15px]",
    rightTopStack: "space-y-[14px] shrink-0",
    rightCheckoutStack: "mt-auto space-y-[14px]",
    customerCard: "p-[14px]",
    billSummary: "py-[28px] px-[30px]",
    billSummaryTitle: "mb-[12px] text-[18px]",
    billSummaryRows: "space-y-[12px] text-[17px]",
    statusCard: "px-[12px] py-[9px]",
    grandCard: "p-[18px]",
    grandLabel: "mb-[6px] text-[15px]",
    grandTotal: "text-[40px]",
    payButton: "h-[58px] text-[16px]",
    secondaryButton: "h-[46px] text-[13px]",
    footer: "px-[24px] py-[10px] text-[12px]",
  },
  "105": {
    scaleLabel: "105%",
    topBar: "gap-3 px-[16px] py-[12px]",
    searchWidth: "w-[560px] max-w-[40vw]",
    scanWidth: "w-[290px]",
    inputHeight: "h-[42px]",
    topButton:
      "flex h-[42px] items-center gap-2 rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] px-3.5 text-[13px] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6] disabled:opacity-50",
    tableCols:
      "grid-cols-[42px_minmax(220px,1fr)_108px_122px_142px_112px_48px]",
    header:
      "gap-3 border-b border-[#DADDE3] bg-[#F8FAFC] px-[16px] py-[10px] mt-[3px]",
    headerHash: "text-center text-[18px] font-extrabold",
    headerTitle: "text-[15px] font-extrabold leading-5",
    headerSub: "mt-0.5 text-[11px] font-bold leading-4 text-[#565449]",
    row: "gap-2.5 px-[16px] py-[8px]",
    rowMain: "truncate text-[14px] font-extrabold leading-5 text-[#11120d]",
    rowSub: "mt-0.5 truncate text-[11px] font-bold leading-4 text-[#565449]",
    qtyControl: "h-[36px]",
    qtyButton: "w-[38px] text-[18px]",
    qtyInput: "w-[54px] text-[14px]",
    rowAction: "h-[32px] w-[32px]",
    rightPanel: "w-[30%] min-w-[300px] max-w-[420px]",
    rightPanelInner: "gap-[13px] px-[18px] py-[14px]",
    rightTopStack: "space-y-[12px] shrink-0",
    rightCheckoutStack: "mt-auto space-y-[12px]",
    customerCard: "p-[14px]",
    billSummary: "py-[22px] px-[24px]",
    billSummaryTitle: "mb-[12px] text-[18px]",
    billSummaryRows: "space-y-[12px] text-[18px]",
    statusCard: "px-[12px] py-[9px]",
    grandCard: "p-[18px]",
    grandLabel: "mb-[6px] text-[15px]",
    grandTotal: "text-[42px]",
    payButton: "h-[58px] text-[16px]",
    secondaryButton: "h-[46px] text-[13px]",
    footer: "px-[20px] py-[9px] text-[11px]",
  },
  "110": {
    scaleLabel: "110%",
    topBar: "gap-3 px-[16px] py-[12px]",
    searchWidth: "w-[545px] max-w-[38vw]",
    scanWidth: "w-[275px]",
    inputHeight: "h-[42px]",
    topButton:
      "flex h-[42px] items-center gap-2 rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] px-3 text-[13px] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6] disabled:opacity-50",
    tableCols:
      "grid-cols-[40px_minmax(200px,1fr)_104px_118px_136px_108px_46px]",
    header:
      "gap-3 border-b border-[#DADDE3] bg-[#F8FAFC] px-[16px] py-[10px] mt-[3px]",
    headerHash: "text-center text-[18px] font-extrabold",
    headerTitle: "text-[15px] font-extrabold leading-5",
    headerSub: "mt-0.5 text-[11px] font-bold leading-4 text-[#565449]",
    row: "gap-2 px-[15px] py-[8px]",
    rowMain: "truncate text-[14px] font-extrabold leading-5 text-[#11120d]",
    rowSub: "mt-0.5 truncate text-[11px] font-bold leading-4 text-[#565449]",
    qtyControl: "h-[36px]",
    qtyButton: "w-[38px] text-[18px]",
    qtyInput: "w-[54px] text-[14px]",
    rowAction: "h-[32px] w-[32px]",
    rightPanel: "w-[30%] min-w-[300px] max-w-[420px]",
    rightPanelInner: "gap-[12px] px-[17px] py-[13px]",
    rightTopStack: "space-y-[12px] shrink-0",
    rightCheckoutStack: "mt-auto space-y-[12px]",
    customerCard: "p-[14px]",
    billSummary: "py-[22px] px-[24px]",
    billSummaryTitle: "mb-[12px] text-[18px]",
    billSummaryRows: "space-y-[12px] text-[18px]",
    statusCard: "px-[12px] py-[9px]",
    grandCard: "p-[18px]",
    grandLabel: "mb-[6px] text-[15px]",
    grandTotal: "text-[42px]",
    payButton: "h-[58px] text-[16px]",
    secondaryButton: "h-[46px] text-[13px]",
    footer: "px-[20px] py-[9px] text-[11px]",
  },
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

type PaymentMethod = "Cash" | "Fonepay" | "eSewa" | "Split";
type PaymentStatus = "Paid" | "Partial" | "Unpaid";
type PendingBillingConfirm = "checkout" | "clear-cart" | "park-cart" | null;
type SplitPaymentDraft = {
  id: string;
  method: "CASH" | "FONEPAY" | "ESEWA";
  amount: string;
  tenderedAmount: string;
  reference?: string;
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
  isLoyalty: boolean;
  loyaltyPercent?: number;
  wholesalePercent?: number;
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

type StoredBillingCart = {
  cart: CartLine[];
  activeDraftInvoiceId?: string | null;
  selectedCustomerId?: string | null;
  savedAt: string;
};

const BILLING_CART_STORAGE_KEY = "khatasathi_billing_cart";

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

    return {
      cart: normalizedCart,
      activeDraftInvoiceId:
        typeof parsed.activeDraftInvoiceId === "string"
          ? parsed.activeDraftInvoiceId
          : null,
      selectedCustomerId:
        typeof parsed.selectedCustomerId === "string"
          ? parsed.selectedCustomerId
          : null,
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
) {
  if (typeof window === "undefined") return;

  window.localStorage.setItem(
    BILLING_CART_STORAGE_KEY,
    JSON.stringify({
      cart,
      activeDraftInvoiceId: activeDraftInvoiceId || null,
      selectedCustomerId: selectedCustomerId || null,
      savedAt: new Date().toISOString(),
    } satisfies StoredBillingCart),
  );
}

// clearing the stored billing cart is used after successful checkout and whenever the cashier intentionally empties the cart
function clearStoredBillingCart() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(BILLING_CART_STORAGE_KEY);
}

// we use this to format numbers as Nepalese Rupees (NPR)
// without this it looks like plain text "1500" instead of "NPR 1,500"
function formatNpr(n: number) {
  const s = Math.round(n).toString();
  const withComma = s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `NPR ${withComma}`;
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
  const billingView = BILLING_VIEW_DENSITY[billingViewSize];
  const isManager = currentUser?.role === "manager";
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
  const [customers, setCustomers] = useState<Customer[]>([]); // full customer list available for billing selection
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

  // fetching products and customers when the page first loads
  // we use Promise.allSettled so one failing API call does not block the other from completing
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const [custData, parkedData, privilegeData] = await Promise.allSettled([
          listCustomersApi(true, { signal: controller.signal }),
          listParkedDraftsApi({ signal: controller.signal }),
          getMyCashierPrivilegesApi({ signal: controller.signal }),
        ]);

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

        const rejected = [custData, parkedData, privilegeData].find(
          (result) => result.status === "rejected" && isRateLimitError(result.reason),
        );
        if (rejected) requestRateLimitRecovery();
      } catch {
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [mapRawCustomers, normalizeParkedDraft, rateLimitRecoveryKey]);

  const [skuInput, setSkuInput] = useState(""); // scanner/manual barcode input
  const [productQuery, setProductQuery] = useState(""); // text search for the product picker
  const [manualSearchProductIds, setManualSearchProductIds] = useState<string[]>([]);
  const [manualSearchTotal, setManualSearchTotal] = useState(0);
  const [manualSearchLoading, setManualSearchLoading] = useState(false);
  const [manualSearchIndex, setManualSearchIndex] = useState(0);
  const [openRowActionProductId, setOpenRowActionProductId] = useState<
    string | null
  >(null);
  const [isCustomerSearchOpen, setCustomerSearchOpen] = useState(false); // controls the customer search modal/dropdown
  const [customerQuery, setCustomerQuery] = useState(""); // search text inside the customer picker
  const [customerSearchIndex, setCustomerSearchIndex] = useState(0);
  const [selectedCartRowIndex, setSelectedCartRowIndex] = useState(-1);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(
    null,
  );
  const [activeDraftInvoiceId, setActiveDraftInvoiceId] = useState<
    string | null
  >(null); // parked draft currently loaded into the billing cart, if any
  const [cart, setCart] = useState<CartLine[]>([]); // raw cart lines before product details and pricing are joined in
  const [priceOverrideTargetId, setPriceOverrideTargetId] = useState<
    string | null
  >(null);
  const [priceOverrideDraftPrice, setPriceOverrideDraftPrice] = useState("");
  const [priceOverrideDraftReason, setPriceOverrideDraftReason] = useState("");
  const [priceOverrideDraftPin, setPriceOverrideDraftPin] = useState("");
  const [priceOverrideError, setPriceOverrideError] = useState("");
  const [priceOverrideBusy, setPriceOverrideBusy] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("Cash"); // current payment method selected in the modal
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>("Paid"); // current paid/partial/unpaid selection
  const [paidAmount, setPaidAmount] = useState<string>(""); // manual partial payment amount typed by the cashier
  const [cashTendered, setCashTendered] = useState<string>(""); // cash received from customer, used to calculate change
  const [fonepayReference, setFonepayReference] = useState<string>(""); // manual Fonepay reference/remarks recorded with the invoice payment
  const [splitCashAmount, setSplitCashAmount] = useState<string>(""); // cash portion when the bill is split between cash and eSewa
  const [splitPayments, setSplitPayments] = useState<SplitPaymentDraft[]>([]);
  const [invoiceNote, setInvoiceNote] = useState("");
  const [paymentError, setPaymentError] = useState(""); // payment modal validation message
  const [billingError, setBillingError] = useState(""); // main billing error shown above the cart or form
  const [cartIssueMessage, setCartIssueMessage] = useState(""); // short-lived product lookup/cart guidance
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

  const visibleParkedDrafts = useMemo(() => {
    if (!activeDraftInvoiceId) return parkedDrafts;
    return parkedDrafts.filter((draft) => draft.id !== activeDraftInvoiceId);
  }, [activeDraftInvoiceId, parkedDrafts]);

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
  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === selectedCustomerId) || null,
    [selectedCustomerId, customers],
  );

  const customerMode = getCustomerDiscountMode(selectedCustomer); // quick label for whether this customer uses loyalty, wholesale, or no special rate
  const subtotalDiscountMeta = useMemo(
    () => getSubtotalDiscountMeta(selectedCustomer),
    [selectedCustomer],
  );

  // filtering the customer list based on the search query
  // we wrap this in useMemo so it only recalculates when the query or customers change
  const customerListFiltered = useMemo(() => {
    const s = customerQuery.trim().toLowerCase();
    if (!s) return customers;
    return customers.filter((c) =>
      (c.name + " " + c.phone).toLowerCase().includes(s),
    );
  }, [customers, customerQuery]);

  const customerOptions = useMemo(() => {
    const opts: Array<
      { type: "CLEAR" } | { type: "CUSTOMER"; customer: Customer }
    > = [];
    if (selectedCustomerId) {
      opts.push({ type: "CLEAR" });
    }
    customerListFiltered.forEach((c) =>
      opts.push({ type: "CUSTOMER", customer: c }),
    );
    return opts;
  }, [selectedCustomerId, customerListFiltered]);

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
        setSelectedCustomerId(null);
      } else {
        setSelectedCustomerId(opt.customer.id);
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
      return undefined;
    }

    const controller = new AbortController();
    setManualSearchProductIds([]);
    setManualSearchTotal(0);
    setManualSearchLoading(true);
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
          // Keep billing usable during a transient failure; the global rate
          // limit banner explains cooldowns without adding duplicate errors.
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

  // restoring the saved cart once on mount keeps billing work intact even after route changes or refreshes
  useEffect(() => {
    const storedCart = readStoredBillingCart();
    if (storedCart?.cart.length) {
      setCart(storedCart.cart);
      setActiveDraftInvoiceId(storedCart.activeDraftInvoiceId || null);
      setSelectedCustomerId(storedCart.selectedCustomerId || null);
    }
    setCartPersistenceReady(true);
  }, []);

  const cartProductIds = useMemo(
    () => [...new Set(cart.map((line) => line.productId).filter(Boolean))],
    [cart],
  );

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

  // once the latest product catalog is available, we reconcile the restored cart against active products and current stock
  useEffect(() => {
    if (products.length === 0 || cart.length === 0) return;

    const normalizedCart = cart
      .map((line) => {
        const product = productsById.get(line.productId);
        if (
          !product ||
          !product.active ||
          product.stock <= 0 ||
          product.stock < getProductMinQty(product)
        ) {
          return null;
        }

        const qty = normalizeProductCartQty(product, line.qty);
        return {
          ...line,
          productId: line.productId,
          qty,
        };
      })
      .filter(Boolean) as CartLine[];

    const cartChanged =
      normalizedCart.length !== cart.length ||
      normalizedCart.some(
        (line, index) =>
          line.productId !== cart[index]?.productId ||
          line.qty !== cart[index]?.qty ||
          line.overrideUnitPrice !== cart[index]?.overrideUnitPrice ||
          line.overrideReason !== cart[index]?.overrideReason,
      );

    if (cartChanged) {
      setCart(normalizedCart);
    }
  }, [cart, products, productsById]);

  // Persisting the cart on every cart change makes route changes safe while still clearing storage when the cart is emptied
  useEffect(() => {
    if (selectedCartRowIndex >= cart.length) {
      setSelectedCartRowIndex(cart.length - 1);
    }
  }, [cart.length, selectedCartRowIndex]);

  useEffect(() => {
    if (!cartPersistenceReady) return;

    if (cart.length === 0) {
      clearStoredBillingCart();
      return;
    }

    writeStoredBillingCart(cart, activeDraftInvoiceId, selectedCustomerId);
  }, [activeDraftInvoiceId, cart, cartPersistenceReady, selectedCustomerId]);

  // joining cart lines with product data here is what gives us unit price, pricing mode, and line totals for each row
  const cartRows = useMemo(() => {
    return cart
      .map((line) => {
        const p = productsById.get(line.productId);
        if (!p) return null;
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
        return {
          ...line,
          product: p,
          unitPrice: unit,
          baseUnitPrice,
          overrideUnitPrice,
          overrideReason: line.overrideReason,
          overrideAuthorizationToken: line.overrideAuthorizationToken,
          priceType: useWholesalePrice ? "Wholesale" : "Retail",
          lineTotal: unit * line.qty,
        };
      })
      .filter(Boolean) as Array<{
      productId: string;
      qty: number;
      product: Product;
      unitPrice: number;
      baseUnitPrice: number;
      overrideUnitPrice?: number;
      overrideReason?: string;
      overrideAuthorizationToken?: string;
      priceType: "Wholesale" | "Retail";
      lineTotal: number;
    }>;
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
  const overrideDiffDisplay = `${overrideDiffIsReduction ? "-" : "+"}${formatNpr(overrideDiffAbs)}`;
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
      return Math.round((subTotal * subtotalDiscountMeta.percent) / 100);
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
  const splitDigitalAmount = splitEsewaAmount + splitFonepayAmount;
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
            : paymentMethod === "eSewa"
            ? "eSewa collection"
            : cashShort > 0
              ? "Cash short"
              : changeDue > 0
                ? "Return change"
                : "Exact cash ready";
  const paymentStateDetail =
    paymentMethod === "Split"
      ? `Cash ${formatNpr(splitCashNum)} + digital ${formatNpr(splitDigitalAmount)}.`
      : paymentStatus === "Unpaid"
        ? "No payment recorded now."
        : paymentStatus === "Partial"
          ? `Balance due ${formatNpr(balanceDue)}.`
          : paymentMethod === "Fonepay"
            ? `Collect ${formatNpr(payableTotal)} by Fonepay.`
            : paymentMethod === "eSewa"
            ? `Collect ${formatNpr(payableTotal)} online.`
            : cashShort > 0
              ? `Need ${formatNpr(cashShort)} more.`
              : changeDue > 0
                ? `Give ${formatNpr(changeDue)} back.`
                : `Cash matches ${formatNpr(payableTotal)}.`;
  const paymentStateTone =
    paymentMethod === "Cash" && paymentStatus === "Paid" && changeDue > 0
      ? "success"
      : paymentMethod === "Fonepay" && paymentStatus === "Paid"
        ? "fonepay"
      : paymentMethod === "eSewa" && paymentStatus === "Paid"
        ? "esewa"
        : paymentStatus === "Partial" ||
            paymentStatus === "Unpaid" ||
            !isSplitBalanced ||
            cashShort > 0
          ? "warning"
          : "info";

  const canConfirm = cartRows.length > 0 && !submitting && !stockRefreshBusy; // final guard for whether checkout can run right now
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
    setCart((prev) => prev.filter((x) => x.productId !== productId));
    clearCartIssue();
    if (priceOverrideTargetId === productId) closePriceOverride();
    setStockConflicts((current) =>
      current.filter((conflict) => conflict.productId !== productId),
    );
  }

  function applyStockConflictSuggestion(conflict: StockConflict) {
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
  function resetBill() {
    clearStoredBillingCart();
    setCart([]);
    setActiveDraftInvoiceId(null);
    setSelectedCustomerId(null);
    setPaymentMethod("Cash");
    setPaymentStatus("Paid");
    setPaidAmount("");
    setCashTendered("");
    setFonepayReference("");
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
    skuRef.current?.focus();
  }

  function requestResetBill() {
    if (!hasBillDraft) return;
    setPendingBillingConfirm("clear-cart");
  }

  function confirmResetBill() {
    resetBill();
  }

  function requestParkBill() {
    if (cart.length === 0) {
      setBillingError("Add at least one item before parking this bill.");
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
    const nextCart = (resumed.items || [])
      .map((item) => ({
        productId: item.productId,
        qty: normalizeQuantityValue(Number(item.qty || 1)),
      }))
      .filter((item) => item.productId);

    setCart(nextCart);
    setActiveDraftInvoiceId(resumed.id);
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

    setParkedBusy(true);
    setParkedError("");
    setBillingError("");

    try {
      if (cart.length > 0) {
        const parked = await parkCurrentBill("auto");
        if (!parked) return;
      }

      const resumed = normalizeParkedDraft(
        await resumeParkedDraftApi(draft.id),
      );
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

  function openPaymentFlow(nextMethod?: PaymentMethod) {
    // this handles when someone tries to open payment without any cart lines
    if (cartRows.length === 0) {
      setBillingError("Add at least one product before opening payment.");
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
      setCashTendered(String(payableTotal));
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
            ? `Split is short by ${formatNpr(splitBalance)}.`
            : `Split exceeds total by ${formatNpr(Math.abs(splitBalance))}.`,
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
          "Use eSewa or Fonepay when the full invoice amount is online.",
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
      { label: "NPR 500", value: 500 },
      { label: "NPR 1,000", value: 1000 },
      { label: "NPR 5,000", value: 5000 },
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
        if (patch.method === "ESEWA" || patch.method === "FONEPAY") {
          next.tenderedAmount = "";
        }
        if (patch.method && patch.method !== "FONEPAY") {
          next.reference = "";
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
    if (!canConfirm) return;
    if (!validatePaymentBeforeConfirm()) return;

    setStockConflicts([]);
    setStockRefreshBusy(true);
    try {
      const latestProducts = await refreshProductsForCheckout();
      const conflicts = buildStockConflictsFromCart(cart, latestProducts);
      if (conflicts.length > 0) {
        showStockConflicts(conflicts);
        return;
      }

      setPendingBillingConfirm("checkout");
    } catch {
      setPaymentError(
        "Could not refresh product stock. Check connection and try again.",
      );
    } finally {
      setStockRefreshBusy(false);
    }
  }

  async function confirmCheckout() {
    // stopping here prevents double submits and blocks invalid partial payment states
    if (!canConfirm) return;
    if (!validatePaymentBeforeConfirm()) return;
    setPendingBillingConfirm(null);
    setSubmitting(true);

    try {
      const checkoutPayments =
        paymentMethod === "Split"
          ? normalizedSplitPayments.map((payment) => ({
              method: payment.method,
              amount: payment.amountNum,
              reference:
                payment.method === "FONEPAY"
                  ? payment.reference?.trim()
                  : undefined,
              tenderedAmount:
                payment.method === "CASH" ? payment.tenderedNum : undefined,
            }))
          : paymentStatus !== "Unpaid" && effectivePaidAmount > 0
            ? [
                {
                  method: (
                    paymentMethod === "eSewa"
                      ? "ESEWA"
                      : paymentMethod === "Fonepay"
                        ? "FONEPAY"
                        : "CASH"
                  ) as
                    | "CASH"
                    | "FONEPAY"
                    | "ESEWA",
                  amount: effectivePaidAmount,
                  reference:
                    paymentMethod === "Fonepay"
                      ? fonepayReference.trim()
                      : undefined,
                  tenderedAmount:
                    paymentMethod === "Cash" && paymentStatus === "Paid"
                      ? cashTenderedNum
                      : undefined,
                },
              ]
            : [];

      // sending everything to the atomic checkout endpoint so invoice creation, item insertion,
      // finalization, stock deduction, and payment recording all happen inside one database transaction
      const result = await checkoutInvoiceApi({
        draftInvoiceId: activeDraftInvoiceId || undefined,
        customerId: selectedCustomerId || undefined,
        discountAmount: subtotalDiscount,
        notes: invoiceNote.trim() || undefined,
        items: cartRows.map((line) => ({
          productId: line.productId,
          qty: line.qty,
          overrideUnitPrice: line.overrideUnitPrice,
          overrideReason: line.overrideReason,
          overrideAuthorizationToken: line.overrideAuthorizationToken,
        })),
        payments: checkoutPayments,
      });

      const invoiceId = result?.invoice?.id;
      if (invoiceId) {
        setLastCreatedInvoiceId(invoiceId);
        window.sessionStorage.setItem(
          LAST_INVOICE_PRINT_STORAGE_KEY,
          invoiceId,
        );
      }

      // when eSewa is chosen, the backend returns a signed payment intent — we redirect to the gateway
      if (result?.esewaPaymentIntent) {
        submitEsewaForm(result.esewaPaymentIntent);
        return;
      }

      // clearing the draft only after the full invoice flow succeeds avoids losing the cart on failure
      setShowPaymentModal(false);
      setPriceOverrideDraftPin("");
      resetBill();
      await loadParkedDrafts();

      setShowSuccess(true);
    } catch (err: any) {
      console.error("Billing confirm error:", err);
      const responseData = err?.response?.data;
      if (responseData?.code === "STOCK_CONFLICT") {
        const conflicts = normalizeApiStockConflicts(responseData.conflicts);
        if (conflicts.length > 0) {
          showStockConflicts(conflicts);
          try {
            await refreshProductsForCheckout();
          } catch {
            // the structured backend conflict is still enough for the cashier to resolve the cart
          }
          return;
        }
      }

      setBillingError(responseData?.error || "Failed to create invoice.");
    } finally {
      // re-enabling billing actions whether checkout succeeded or failed
      setSubmitting(false);
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
        icon: "restart_alt",
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
                {formatNpr(payableTotal)}
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
                {formatNpr(payableTotal)}
              </span>
            </div>
          </div>
        ),
      };
    }

    return {
      title:
        paymentMethod === "Split"
          ? "Confirm split payment?"
          : paymentStatus === "Unpaid"
            ? "Create unpaid invoice?"
            : paymentMethod === "Fonepay"
              ? "Confirm Fonepay payment?"
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
            : paymentMethod === "eSewa"
              ? "Continue to eSewa"
              : `Confirm ${formatNpr(effectivePaidAmount)}`,
      tone: "primary" as const,
      icon:
        paymentMethod === "Split"
          ? "call_split"
          : paymentStatus === "Unpaid"
            ? "receipt_long"
            : paymentMethod === "Fonepay"
              ? "qr_code_2"
            : paymentMethod === "eSewa"
              ? "qr_code_2"
              : "payments",
      onConfirm: confirmCheckout,
      details: (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span>Customer</span>
            <span className="font-extrabold text-slate-900">
              {selectedCustomer ? selectedCustomer.name : "Walk-in Customer"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Invoice total</span>
            <span className="font-extrabold text-slate-900">
              {formatNpr(payableTotal)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Collect now</span>
            <span className="font-extrabold text-slate-900">
              {paymentMethod === "Split"
                ? formatNpr(splitCashNum)
                : formatNpr(effectivePaidAmount)}
            </span>
          </div>
          {paymentMethod === "Split" ? (
            <div className="flex items-center justify-between gap-3">
              <span>eSewa amount</span>
              <span className="font-extrabold text-slate-900">
                {formatNpr(splitEsewaAmount)}
              </span>
            </div>
          ) : null}
          {paymentMethod === "Split" && splitFonepayAmount > 0 ? (
            <div className="flex items-center justify-between gap-3">
              <span>Fonepay amount</span>
              <span className="font-extrabold text-slate-900">
                {formatNpr(splitFonepayAmount)}
              </span>
            </div>
          ) : null}
          {paymentMethod === "Fonepay" && fonepayReference.trim() ? (
            <div className="flex items-center justify-between gap-3">
              <span>Reference</span>
              <span className="max-w-[220px] truncate font-extrabold text-slate-900">
                {fonepayReference.trim()}
              </span>
            </div>
          ) : null}
          {changeDue > 0 ? (
            <div className="flex items-center justify-between gap-3">
              <span>Change due</span>
              <span className="font-extrabold text-emerald-700">
                {formatNpr(changeDue)}
              </span>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <span>Due after bill</span>
            <span className="font-extrabold text-slate-900">
              {formatNpr(balanceDue)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Method</span>
            <span className="font-extrabold text-slate-900">
              {paymentStatus === "Unpaid" ? "None" : paymentMethod}
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
    selectedCustomer,
    splitCashNum,
    splitEsewaAmount,
    splitFonepayAmount,
    fonepayReference,
  ]);

  // setting up global hotkeys (F2, F3, F4, F5, F6, F9, Enter) so the cashier can work fully via keyboard
  useEffect(() => {
    function isTypingTarget(el: EventTarget | null) {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || el.isContentEditable;
    }

    function onKeyDown(e: KeyboardEvent) {
      const isFKey = /^F[2-9]$/.test(e.key);
      const isTyping = isTypingTarget(e.target);

      // We process F-keys, Esc, and Alt/Shift-modifiers universally.
      // If none of those, and they are typing, we ignore global hotkeys.
      const isGlobalAction =
        isFKey ||
        e.key === "Escape" ||
        e.altKey ||
        (e.shiftKey && e.key === "Enter");
      if (isTyping && !isGlobalAction) return;

      if (pendingBillingConfirm === "park-cart" && e.key === "Enter") {
        e.preventDefault();
        confirmParkBill();
        return;
      }

      if (pendingBillingConfirm && e.key !== "Escape") return;

      if (e.key === "F2") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === "F3") {
        e.preventDefault();
        skuRef.current?.focus();
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
        setCustomerSearchOpen(true);
        return;
      }
      if (e.key === "F8") {
        e.preventDefault();
        if (
          selectedCartRowIndex >= 0 &&
          selectedCartRowIndex < cartRows.length
        ) {
          openPriceOverride(cartRows[selectedCartRowIndex]);
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
        } else {
          openPaymentFlow();
        }
        return;
      }

      // Modifier-based Navigation (Alt Key)
      if (e.altKey) {
        const key = e.key.toLowerCase();

        // Cart Navigation
        if (key === "arrowdown") {
          e.preventDefault();
          setSelectedCartRowIndex((prev) =>
            cartRows.length === 0
              ? -1
              : Math.min(Math.max(prev, -1) + 1, cartRows.length - 1),
          );
          return;
        }
        if (key === "arrowup") {
          e.preventDefault();
          setSelectedCartRowIndex((prev) =>
            cartRows.length === 0 ? -1 : Math.max(prev <= 0 ? 0 : prev - 1, 0),
          );
          return;
        }
        if (key === "delete" || key === "backspace") {
          if (
            selectedCartRowIndex >= 0 &&
            selectedCartRowIndex < cartRows.length
          ) {
            e.preventDefault();
            const row = cartRows[selectedCartRowIndex];
            if (row) removeLine(row.productId);
            return;
          }
        }
        if (e.shiftKey && (key === "+" || key === "=")) {
          if (
            selectedCartRowIndex >= 0 &&
            selectedCartRowIndex < cartRows.length
          ) {
            e.preventDefault();
            const row = cartRows[selectedCartRowIndex];
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
            selectedCartRowIndex >= 0 &&
            selectedCartRowIndex < cartRows.length
          ) {
            e.preventDefault();
            const row = cartRows[selectedCartRowIndex];
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
            selectedCartRowIndex >= 0 &&
            selectedCartRowIndex < cartRows.length
          ) {
            e.preventDefault();
            const row = cartRows[selectedCartRowIndex];
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
            selectedCartRowIndex >= 0 &&
            selectedCartRowIndex < cartRows.length
          ) {
            e.preventDefault();
            openPriceOverride(cartRows[selectedCartRowIndex]);
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
            if (paymentStatus === "Paid") setCashTendered(String(payableTotal));
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
  ]);

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
        data-billing-view-size={billingViewSize}
        className="flex h-full w-full flex-col overflow-hidden rounded-[16px] border border-[#CFCFD3] bg-[#FFFFFF] font-sans text-slate-800 shadow-sm"
      >
        {/* TOP BAR */}
        <div
          className={cn(
            "relative z-50 flex shrink-0 items-center justify-between border-b border-[#CFCFD3] bg-[#FFFFFF]",
            billingView.topBar,
          )}
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className={cn("relative", billingView.searchWidth)}>
              <Input
                value={productQuery}
                onChange={(value) => {
                  setProductQuery(value);
                  clearCartIssue();
                }}
                onBlur={clearCartIssue}
                onKeyDown={handleManualSearchKeyDown}
                placeholder="Search product name, SKU, brand... (F2)"
                leftIcon="manage_search"
                inputRef={searchRef}
                className={billingView.inputHeight}
                autoFocus
              />

              {/* SEARCH AUTOCOMPLETE DROPDOWN */}
              {productQuery.trim().length > 0 && (
                <div className="absolute left-0 top-[calc(100%+8px)] z-[60] flex max-h-[62vh] w-[640px] flex-col overflow-hidden rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] shadow-[0_16px_42px_-14px_rgba(0,0,0,0.22)]">
                  <div className="flex items-center justify-between border-b border-[#CFCFD3] bg-[#F8F9FA] px-4 py-2">
                    <div>
                      <div className="text-[10px] font-extrabold uppercase text-[#8C8889]">
                        Quick product search
                      </div>
                      <div className="mt-0.5 text-[11px] font-bold text-[#565449]">
                        {manualSearchLoading
                          ? "Searching active products..."
                          : manualSearchTotal > MANUAL_SEARCH_LIMIT
                            ? `${manualSearchTotal} matches. Keep typing to narrow.`
                            : `${manualSearchTotal} match${manualSearchTotal === 1 ? "" : "es"}. Use arrows and Enter.`}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <a
                        href="/product-lookup"
                        className="rounded-full border border-[#CFCFD3] bg-white px-2 py-1 text-[11px] font-extrabold text-[#565449] hover:bg-[#F3F4F6]"
                      >
                        Product Lookup
                      </a>
                      <button
                        type="button"
                        onClick={() => setProductQuery("")}
                        className="text-[#8C8889] hover:text-[#000000]"
                        aria-label="Close product search results"
                        title="Close search results"
                      >
                        <Icon name="close" className="text-[16px]" />
                      </button>
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto p-2">
                    {manualSearchLoading ? (
                      <div className="py-8 text-center text-[13px] font-medium text-[#8C8889]">
                        Searching products...
                      </div>
                    ) : manualResults.length === 0 ? (
                      <div className="py-8 text-center text-[13px] font-medium text-[#8C8889]">
                        No products found. Try another name, SKU, or brand.
                      </div>
                    ) : (
                      manualResults.map((p, resultIndex) => {
                        const low =
                          p.stock > 0 &&
                          p.stock <= Math.max(0, p.lowStockThreshold || 0);
                        const outOfStock = p.stock <= 0;
                        const selected = resultIndex === manualSearchIndex;
                        return (
                          <button
                            key={p.id}
                            ref={(element) => {
                              manualResultRefs.current[resultIndex] = element;
                            }}
                            type="button"
                            disabled={outOfStock}
                            onClick={() => addToCart(p.id)}
                            className={`grid w-full grid-cols-[minmax(0,1fr)_120px] items-center gap-4 rounded-[10px] border px-3 py-2.5 text-left transition ${outOfStock ? "cursor-not-allowed border-transparent bg-[#FAFAFA]" : selected ? "border-[#8DB6FF] bg-[#E8F2FF] shadow-sm" : "border-transparent hover:bg-[#F3F4F6]"}`}
                          >
                            <div className="min-w-0">
                              <div
                                className={`flex min-w-0 items-center gap-2 truncate text-[13px] font-extrabold ${outOfStock ? "text-[#8C8889]" : "text-[#11120d]"}`}
                              >
                                <span className="truncate">{p.name}</span>
                                {low && !outOfStock && (
                                  <span className="shrink-0 rounded-[4px] bg-rose-100 px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-rose-700">
                                    Low
                                  </span>
                                )}
                                {outOfStock && (
                                  <span className="shrink-0 rounded-[4px] bg-rose-100 px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-rose-700">
                                    Out
                                  </span>
                                )}
                              </div>
                              <div
                                className={`mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-[11px] font-bold ${selected && !outOfStock ? "text-[#334155]" : "text-[#8C8889]"}`}
                              >
                                <span>SKU: {p.sku}</span>
                                <span>|</span>
                                <span>Brand: {p.brand || "N/A"}</span>
                              </div>
                            </div>
                            <div className="shrink-0 text-right">
                              <div
                                className={`font-mono text-[14px] font-extrabold ${outOfStock ? "text-[#8C8889]" : "text-[#11120d]"}`}
                              >
                                {formatNpr(p.retailPrice)}
                              </div>
                              <div
                                className={`mt-1 text-[10px] font-extrabold ${outOfStock ? "text-[#BE123C]" : low ? "text-[#EA580C]" : "text-[#179B4D]"}`}
                              >
                                {formatQtyWithUnit(p.stock, p.saleUnit)} in
                                stock
                              </div>
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>

                  {!manualSearchLoading && manualSearchTotal > MANUAL_SEARCH_LIMIT && (
                    <div className="border-t border-[#CFCFD3] bg-[#F8F9FA] px-4 py-2 text-[11px] font-semibold text-[#8C8889]">
                      Showing first {MANUAL_SEARCH_LIMIT}. Type more letters for
                      faster selection.
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className={billingView.scanWidth}>
              <Input
                value={skuInput}
                onChange={(value) => {
                  setSkuInput(value);
                  clearCartIssue();
                }}
                onBlur={clearCartIssue}
                placeholder="Scan barcode "
                leftIcon="qr_code_scanner"
                onEnter={addBySku}
                className={cn("font-mono", billingView.inputHeight)}
                inputRef={skuRef}
              />
            </div>
          </div>

          <div className="flex items-center gap-5 shrink-0">
            <div className="flex items-center overflow-hidden rounded-[10px] border border-[#CFCFD3] bg-[#FFFFFF] text-[#565449]">
              <button
                type="button"
                onClick={() => stepBillingViewSize(-1)}
                disabled={billingViewSize === BILLING_VIEW_SIZE_OPTIONS[0]}
                className={cn(
                  "flex items-center justify-center border-r border-[#E5E7EB] transition hover:bg-[#F3F4F6] disabled:cursor-not-allowed disabled:opacity-35",
                  billingView.inputHeight,
                  billingViewSize === BILLING_VIEW_SIZE_OPTIONS[0]
                    ? "w-[34px]"
                    : "w-[36px]",
                )}
                title="Make billing view more compact"
                aria-label="Make billing view more compact"
              >
                <Icon name="remove" className="text-[16px]" />
              </button>
              <div className="min-w-[86px] px-2 text-center text-[11px] font-extrabold leading-tight">
                <div className="uppercase text-[#8C8889]">View</div>
                <div className="text-[#11120d]">{billingView.scaleLabel}</div>
              </div>
              <button
                type="button"
                onClick={() => stepBillingViewSize(1)}
                disabled={
                  billingViewSize ===
                  BILLING_VIEW_SIZE_OPTIONS[
                    BILLING_VIEW_SIZE_OPTIONS.length - 1
                  ]
                }
                className={cn(
                  "flex items-center justify-center border-l border-[#E5E7EB] transition hover:bg-[#F3F4F6] disabled:cursor-not-allowed disabled:opacity-35",
                  billingView.inputHeight,
                  billingViewSize ===
                    BILLING_VIEW_SIZE_OPTIONS[
                      BILLING_VIEW_SIZE_OPTIONS.length - 1
                    ]
                    ? "w-[34px]"
                    : "w-[36px]",
                )}
                title="Make billing view larger"
                aria-label="Make billing view larger"
              >
                <Icon name="add" className="text-[16px]" />
              </button>
            </div>
            <button
              type="button"
              onClick={() =>
                lastCreatedInvoiceId && openInvoicePrint(lastCreatedInvoiceId)
              }
              disabled={!lastCreatedInvoiceId}
              title={
                lastCreatedInvoiceId
                  ? "Reprint the last finalized invoice"
                  : "No finalized invoice in this session yet"
              }
              className={billingView.topButton}
            >
              <Icon name="print" className="text-[16px]" />
              Reprint Last
            </button>
            <button
              type="button"
              onClick={() =>
                lastCreatedInvoiceId &&
                openInvoiceReceiptPrint(lastCreatedInvoiceId)
              }
              disabled={!lastCreatedInvoiceId}
              title={
                lastCreatedInvoiceId
                  ? "Print receipt for the last finalized invoice"
                  : "No finalized invoice in this session yet"
              }
              className={billingView.topButton}
            >
              <Icon name="receipt_long" className="text-[16px]" />
              Receipt
            </button>
            <button
              type="button"
              onClick={openHeldBills}
              title={
                visibleParkedDrafts.length > 0
                  ? `${visibleParkedDrafts.length} held bill(s) available`
                  : "Open held bills"
              }
              className={cn(
                billingView.topButton,
                visibleParkedDrafts.length > 0
                  ? "border-[#11120d] bg-[#11120d] text-white hover:bg-[#11120d]"
                  : "",
              )}
            >
              <Icon name="pending_actions" className="text-[16px]" />
              Held Bills{" "}
              {visibleParkedDrafts.length > 0
                ? `(${visibleParkedDrafts.length})`
                : ""}
            </button>
          </div>
        </div>

        {cartAlertMessage ? (
          <div className="shrink-0 border-y border-[#FECDD3] bg-[#FFF1F2] px-[22px] py-[9px] text-[13px] font-extrabold text-[#BE123C]">
            <div className="flex items-center gap-2">
              <Icon name="error" className="text-[18px]" />
              <span className="min-w-0 truncate">{cartAlertMessage}</span>
            </div>
          </div>
        ) : null}

        {/* MAIN CONTENT GRID */}
        <div className="flex flex-1 min-h-0 bg-[#FFFFFF] ">
          {/* LEFT: CART TABLE */}
          <div className="flex min-w-0 flex-1 flex-col border-r border-[#CFCFD3] bg-[#FFFFFF] ">
            <div
              className={cn(
                "grid items-center text-[#11120d]",
                billingView.tableCols,
                billingView.header,
              )}
            >
              <div className={billingView.headerHash}>#</div>
              <div>
                <div className={billingView.headerTitle}>Item Name</div>
                <div className={billingView.headerSub}>SKU / Brand</div>
              </div>
              <div className={cn("text-right", billingView.headerTitle)}>
                Stock
              </div>
              <div className="text-right">
                <div className={billingView.headerTitle}>Unit Price</div>
                <div className={cn(billingView.headerSub, "text-[10px]")}>
                  (Retail/Wholesale)
                </div>
              </div>
              <div className={cn("text-center", billingView.headerTitle)}>
                Quantity
              </div>
              <div className={cn("text-right", billingView.headerTitle)}>
                Total
              </div>
              <div aria-hidden="true" />
            </div>

            <div className="flex-1 overflow-y-auto bg-white">
              {cartRows.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center text-[#8C8889]">
                  <Icon
                    name="shopping_cart_checkout"
                    className="text-6xl mb-4 opacity-20"
                  />
                  <div className="text-[16px] font-extrabold">Cart Empty</div>
                  <div className="text-[13px] font-medium mt-1">
                    Search products with F2, or scan barcode/SKU with F3.
                  </div>
                </div>
              ) : (
                <div className="divide-y divide-[#E5E7EB]">
                  {cartRows.map((row, idx) => {
                    const qtyStep = getProductQtyStep(row.product);
                    const minQty = getProductMinQty(row.product);
                    const qtyMinus = normalizeProductCartQty(
                      row.product,
                      row.qty - qtyStep,
                    );
                    const qtyPlus = normalizeProductCartQty(
                      row.product,
                      row.qty + qtyStep,
                    );
                    const low =
                      row.product.stock > 0 &&
                      row.product.stock <=
                        Math.max(0, row.product.lowStockThreshold || 0);
                    const rowMenuOpen =
                      openRowActionProductId === row.productId;

                    return (
                      <div
                        key={row.productId}
                        ref={(element) => {
                          cartRowRefs.current[idx] = element;
                        }}
                        role="row"
                        aria-selected={idx === selectedCartRowIndex}
                        onClick={() => setSelectedCartRowIndex(idx)}
                        className={cn(
                          "grid items-center text-[#11120d] transition",
                          billingView.tableCols,
                          billingView.row,
                          idx === selectedCartRowIndex
                            ? "bg-[#E8F2FF] shadow-[inset_4px_0_0_0_#2F67D8]"
                            : "hover:bg-[#F8F9FA]",
                        )}
                      >
                        <div className="text-center text-[13px] font-extrabold">
                          {idx + 1}
                        </div>

                        <div className="min-w-0">
                          <div className={billingView.rowMain}>
                            {row.product.name}
                          </div>
                          <div className={billingView.rowSub}>
                            SKU: {row.product.sku}{" "}
                            <span className="mx-1 text-[#8C8889]">/</span>{" "}
                            Brand: {row.product.brand || "N/A"}
                          </div>
                          {row.overrideReason && (
                            <div className="truncate text-[10px] font-bold text-amber-600 mt-0.5">
                              Reason: {row.overrideReason}
                            </div>
                          )}
                        </div>

                        <div className="text-right text-[13px]">
                          <span
                            className={`font-mono font-extrabold ${low ? "text-[#EA580C]" : "text-[#11120d]"}`}
                          >
                            {formatQtyWithUnit(
                              row.product.stock,
                              row.product.saleUnit,
                            )}
                          </span>
                          {low && (
                            <div className="text-[10px] font-bold text-rose-500 uppercase mt-0.5">
                              Low Stock
                            </div>
                          )}
                        </div>

                        <div className="text-right flex flex-col items-end">
                          <div className="font-mono text-[14px] font-extrabold text-[#11120d]">
                            {formatNpr(row.unitPrice)}
                          </div>
                          <div className="flex gap-1 mt-1">
                            {row.overrideUnitPrice !== undefined ? (
                              <span className="rounded bg-amber-100 px-1 py-0.5 text-[9px] font-extrabold text-amber-800 uppercase">
                                Override
                              </span>
                            ) : row.priceType === "Wholesale" ? (
                              <span className="rounded bg-sky-100 px-1 py-0.5 text-[9px] font-extrabold text-sky-800 uppercase">
                                Wholesale
                              </span>
                            ) : (
                              <span className="rounded bg-emerald-100 px-1 py-0.5 text-[9px] font-extrabold text-emerald-800 uppercase">
                                Retail
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex justify-center">
                          <div
                            className={cn(
                              "flex items-center overflow-hidden rounded-[8px] border border-[#CFCFD3] bg-white",
                              billingView.qtyControl,
                            )}
                          >
                            <button
                              type="button"
                              onClick={() => changeQty(row.productId, qtyMinus)}
                              disabled={row.qty <= minQty}
                              className={cn(
                                "flex h-full items-center justify-center text-[#565449] hover:bg-[#F3F4F6] disabled:opacity-30",
                                billingView.qtyButton,
                              )}
                              title={
                                row.qty <= minQty
                                  ? "Minimum quantity reached"
                                  : "Decrease quantity"
                              }
                              aria-label={`Decrease quantity for ${row.product.name}`}
                            >
                              -
                            </button>
                            <input
                              id={`qty-input-${row.productId}`}
                              type="number"
                              min={minQty}
                              max={Math.max(minQty, row.product.stock)}
                              step={qtyStep}
                              value={row.qty}
                              onChange={(e) =>
                                changeQty(
                                  row.productId,
                                  Number(e.target.value || minQty),
                                )
                              }
                              className={cn(
                                "h-full border-x border-[#E5E7EB] bg-transparent text-center font-mono font-extrabold text-[#000000] outline-none",
                                billingView.qtyInput,
                              )}
                              aria-label={`Quantity for ${row.product.name}`}
                            />
                            <button
                              type="button"
                              onClick={() => changeQty(row.productId, qtyPlus)}
                              disabled={row.qty >= row.product.stock}
                              className={cn(
                                "flex h-full items-center justify-center text-[#565449] hover:bg-[#F3F4F6] disabled:opacity-30",
                                billingView.qtyButton,
                              )}
                              title={
                                row.qty >= row.product.stock
                                  ? "No more stock available"
                                  : "Increase quantity"
                              }
                              aria-label={`Increase quantity for ${row.product.name}`}
                            >
                              +
                            </button>
                          </div>
                        </div>

                        <div className="text-right font-mono text-[14px] font-extrabold text-[#11120d]">
                          {formatNpr(row.lineTotal)}
                        </div>

                        <div
                          className="relative flex justify-center"
                          data-row-action-menu-root="true"
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedCartRowIndex(idx);
                              setOpenRowActionProductId(
                                rowMenuOpen ? null : row.productId,
                              );
                            }}
                            onFocus={() => setSelectedCartRowIndex(idx)}
                            className={cn(
                              "flex items-center justify-center rounded-[8px] border transition focus:outline-none focus:ring-2 focus:ring-[#11120d]/20",
                              billingView.rowAction,
                              rowMenuOpen
                                ? "border-[#11120d] bg-[#11120d] text-white"
                                : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6]",
                            )}
                            title="Item actions"
                            aria-label={`Open actions for ${row.product.name}`}
                            aria-expanded={rowMenuOpen}
                          >
                            <Icon name="more_vert" className="text-[18px]" />
                          </button>
                          {rowMenuOpen ? (
                            <div className="absolute right-0 top-[calc(100%+6px)] z-[55] w-[168px] overflow-hidden rounded-[12px] border border-[#CFCFD3] bg-white py-1 shadow-[0_14px_30px_-18px_rgba(0,0,0,0.45)]">
                              {canUsePriceOverride ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOpenRowActionProductId(null);
                                    openPriceOverride(row);
                                  }}
                                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-extrabold text-[#565449] hover:bg-[#F3F4F6] focus:bg-[#F3F4F6] focus:outline-none"
                                >
                                  <Icon name="edit" className="text-[15px]" />
                                  {row.overrideUnitPrice !== undefined
                                    ? "Edit price"
                                    : "Override price"}
                                </button>
                              ) : null}
                              {row.overrideUnitPrice !== undefined ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOpenRowActionProductId(null);
                                    clearPriceOverride(row.productId);
                                  }}
                                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-extrabold text-[#B7791F] hover:bg-[#FFF7E8] focus:bg-[#FFF7E8] focus:outline-none"
                                >
                                  <Icon name="undo" className="text-[15px]" />
                                  Clear override
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => {
                                  setOpenRowActionProductId(null);
                                  removeLine(row.productId);
                                }}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-extrabold text-rose-600 hover:bg-rose-50 focus:bg-rose-50 focus:outline-none"
                              >
                                <Icon name="delete" className="text-[15px]" />
                                Remove item
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* RIGHT: SUMMARY PANEL */}
          <div
            className={cn(
              "flex shrink-0 flex-col border-l border-[#CFCFD3] bg-[#FFFFFF]",
              billingView.rightPanel,
            )}
          >
            <div
              className={cn(
                "flex h-full min-h-0 flex-col overflow-y-auto",
                billingView.rightPanelInner,
              )}
            >
              <div className={billingView.rightTopStack}>
                {/* Customer Card */}
                <div
                  className={cn(
                    "relative border-b border-[#E5E7EB] bg-[#FFFFFF] pb-[12px]",
                    billingView.customerCard,
                  )}
                >
                  <div className="flex items-start justify-between">
                    <button
                      type="button"
                      onClick={() =>
                        setCustomerSearchOpen(!isCustomerSearchOpen)
                      }
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-[10px] text-left transition hover:bg-[#F8F9FA] focus:outline-none focus:ring-2 focus:ring-[#11120d]/10"
                      title="Change customer"
                    >
                      <div className="flex h-[40px] w-[40px] items-center justify-center rounded-[12px] bg-[#F3F4F6] text-[#565449]">
                        <Icon name="person" className="text-[19px]" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                          Customer
                        </div>
                        <div className="truncate text-[15px] font-extrabold text-[#000000]">
                          {selectedCustomer
                            ? selectedCustomer.name
                            : "Walk-in Customer"}
                        </div>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setCustomerSearchOpen(!isCustomerSearchOpen)
                      }
                      className="flex h-[32px] w-[32px] items-center justify-center rounded-[8px] text-[#8C8889] hover:bg-[#F3F4F6] hover:text-[#000000]"
                      title={
                        isCustomerSearchOpen
                          ? "Close customer search"
                          : "Change customer"
                      }
                      aria-label={
                        isCustomerSearchOpen
                          ? "Close customer search"
                          : "Change customer"
                      }
                    >
                      <Icon
                        name={isCustomerSearchOpen ? "close" : "edit"}
                        className="text-[18px]"
                      />
                    </button>
                  </div>

                  {isCustomerSearchOpen ? (
                    <div className="absolute left-0 right-0 top-full z-50 mt-2 rounded-[14px] border border-[#CFCFD3] bg-white p-3 shadow-xl">
                      <Input
                        value={customerQuery}
                        onChange={setCustomerQuery}
                        onKeyDown={handleCustomerSearchKeyDown}
                        placeholder="Find customer..."
                        autoFocus
                        leftIcon="search"
                        className="mb-2"
                      />
                      <div className="max-h-[240px] overflow-y-auto space-y-1">
                        {customerOptions.map((opt, index) => {
                          const selected = index === customerSearchIndex;
                          if (opt.type === "CLEAR") {
                            return (
                              <button
                                key="clear"
                                ref={(el) => {
                                  customerResultRefs.current[index] = el;
                                }}
                                type="button"
                                onClick={() => {
                                  setSelectedCustomerId(null);
                                  setCustomerSearchOpen(false);
                                }}
                                className={`flex w-full items-center justify-between rounded-[8px] px-3 py-2 text-left text-[13px] font-semibold text-rose-600 transition ${selected ? "bg-rose-100" : "hover:bg-rose-50"}`}
                              >
                                Clear Selection
                              </button>
                            );
                          }
                          const c = opt.customer;
                          return (
                            <button
                              key={c.id}
                              ref={(el) => {
                                customerResultRefs.current[index] = el;
                              }}
                              type="button"
                              onClick={() => {
                                setSelectedCustomerId(c.id);
                                setCustomerSearchOpen(false);
                              }}
                              className={`flex w-full items-center justify-between rounded-[8px] border px-3 py-2 text-left text-[13px] transition ${selected ? "border-[#8DB6FF] bg-[#E8F2FF] shadow-sm" : "border-transparent hover:bg-[#F3F4F6]"}`}
                            >
                              <span className="font-extrabold text-[#000000]">
                                {c.name}
                              </span>
                              <span className="font-medium text-[#8C8889]">
                                {c.phone}
                              </span>
                            </button>
                          );
                        })}
                        {customerOptions.length === 0 && (
                          <div className="text-center text-[12px] text-[#8C8889] py-2">
                            No results
                          </div>
                        )}
                      </div>
                    </div>
                  ) : null}

                  <div className="mt-3 flex flex-wrap gap-2 border-t border-[#E5E7EB] pt-3">
                    {selectedCustomer ? (
                      <>
                        <span className="rounded-[8px] border border-[#CFCFD3] bg-[#F8F9FA] px-2 py-1 text-[11px] font-extrabold text-[#565449]">
                          Customer
                        </span>
                        {customerMode === "LOYALTY" && (
                          <span className="rounded-[8px] bg-emerald-100 text-emerald-800 px-2 py-1 text-[11px] font-extrabold">
                            Loyalty {selectedCustomer.loyaltyPercent}%
                          </span>
                        )}
                        {customerMode === "ADMIN_WHOLESALE" && (
                          <span className="rounded-[8px] bg-sky-100 text-sky-800 px-2 py-1 text-[11px] font-extrabold">
                            Wholesale {selectedCustomer.wholesalePercent}%
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="rounded-[8px] border border-[#CFCFD3] bg-[#F8F9FA] px-2 py-1 text-[11px] font-extrabold text-[#565449]">
                        Walk-in
                      </span>
                    )}
                    {customerMode === "LOYALTY" && (
                      <span className="rounded-[8px] bg-indigo-100 text-indigo-800 px-2 py-1 text-[11px] font-extrabold">
                        Qty eligible
                      </span>
                    )}
                  </div>
                </div>

                {/* Bill Summary */}
                <div
                  className={cn(
                    "border-b border-[#E5E7EB] bg-[#FFFFFF] pb-[10px]",
                    billingView.billSummary,
                  )}
                >
                  <div
                    className={cn(
                      "flex items-center gap-2 font-extrabold text-[#000000]",
                      billingView.billSummaryTitle,
                    )}
                  >
                    <Icon name="receipt_long" className="text-[#2F67D8]" /> Bill
                    Summary
                  </div>

                  <div className="mb-3 grid grid-cols-2 gap-2 text-[11px] font-extrabold text-[#565449]">
                    <div className="rounded-[10px] border border-[#E5E7EB] bg-[#F8F9FA] px-2.5 py-2">
                      <div className="text-[9px] uppercase tracking-wide text-[#8C8889]">
                        Date
                      </div>
                      <div className="mt-0.5 truncate text-[#11120d]">
                        {billDateLabel}
                      </div>
                    </div>
                    <div className="rounded-[10px] border border-[#E5E7EB] bg-[#F8F9FA] px-2.5 py-2">
                      <div className="text-[9px] uppercase tracking-wide text-[#8C8889]">
                        Time
                      </div>
                      <div className="mt-0.5 truncate text-[#11120d]">
                        {billTimeLabel}
                      </div>
                    </div>
                  </div>

                  <div
                    className={cn(
                      "font-semibold text-[#565449]",
                      billingView.billSummaryRows,
                    )}
                  >
                    <div className="flex justify-between items-center">
                      <span>Subtotal</span>
                      <span className="font-mono font-extrabold text-[#000000]">
                        {formatNpr(subTotal)}
                      </span>
                    </div>
                    {subtotalDiscount > 0 && (
                      <div className="flex justify-between items-center text-rose-600">
                        <span>Customer Discount</span>
                        <span className="font-mono font-extrabold">
                          (-{formatNpr(subtotalDiscount)})
                        </span>
                      </div>
                    )}
                    {hasPriceOverrides && (
                      <div
                        className={`flex justify-between items-center ${overrideDiffIsReduction ? "text-rose-600" : "text-amber-600"}`}
                      >
                        <span>{overrideDiffLabel}</span>
                        <span className="font-mono font-extrabold">
                          {overrideDiffDisplay}
                        </span>
                      </div>
                    )}
                    {totalVisibleSavings > 0 && (
                      <div className="flex justify-between items-center text-emerald-700">
                        <span>Total Savings</span>
                        <span className="font-mono font-extrabold">
                          {formatNpr(totalVisibleSavings)}
                        </span>
                      </div>
                    )}

                    <div className="my-[10px] border-t border-dashed border-[#CFCFD3]" />

                    <div className="flex justify-between items-center">
                      <span>Total Items</span>
                      <span className="font-mono font-extrabold text-[#000000]">
                        {cartRows.length}
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span>Total Quantity</span>
                      <span className="font-mono font-extrabold text-[#000000]">
                        {formatQty(
                          cartRows.reduce((sum, line) => sum + line.qty, 0),
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <div className={billingView.rightCheckoutStack}>
                <div
                  className={cn(
                    "border-b border-[#E5E7EB] bg-[#FFFFFF]",
                    billingView.statusCard,
                  )}
                >
                  {cartRows.length === 0 ? (
                    <div className="flex items-center gap-3">
                      <span className="flex h-[44px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-[#F3F4F6] text-[#8C8889]">
                        <Icon name="point_of_sale" className="text-[18px]" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-extrabold text-[#000000]">
                          No items in bill
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          <span className="rounded-[8px] border border-[#CFCFD3] bg-[#F8F9FA] px-2 py-1 text-[11px] font-extrabold text-[#565449]">
                            F2 Product Search
                          </span>
                          <span className="rounded-[8px] border border-[#CFCFD3] bg-[#F8F9FA] px-2 py-1 text-[11px] font-extrabold text-[#565449]">
                            F3 Barcode/SKU
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <span className="flex h-[44px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-[#EAF8EF] text-[#179B4D]">
                        <Icon name="task_alt" className="text-[18px]" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-extrabold text-[#000000]">
                          Ready for checkout
                        </div>
                        <div className="mt-0.5 truncate text-[12px] font-semibold text-[#8C8889]">
                          {cartRows.length} line(s) |{" "}
                          {formatQty(
                            cartRows.reduce((sum, line) => sum + line.qty, 0),
                          )}{" "}
                          unit(s) |{" "}
                          {selectedCustomer
                            ? selectedCustomer.name
                            : "Walk-in customer"}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <div
                  className={cn(
                    "rounded-[14px] bg-[#FFFFFF]",
                    billingView.grandCard,
                  )}
                >
                  <div
                    className={cn(
                      "font-extrabold uppercase text-[#2F67D8]",
                      billingView.grandLabel,
                    )}
                  >
                    Grand Total
                  </div>
                  <div
                    className={cn(
                      "font-mono font-extrabold leading-none text-[#000000]",
                      billingView.grandTotal,
                    )}
                  >
                    {formatNpr(payableTotal)}
                  </div>
                </div>

                <button
                  type="button"
                  disabled={!canConfirm}
                  onClick={() => openPaymentFlow()}
                  title={
                    canConfirm
                      ? "Open payment"
                      : "Add at least one item to bill before payment"
                  }
                  className={cn(
                    "flex w-full items-center justify-center gap-2 rounded-[14px] bg-[#11120d] font-extrabold text-white transition hover:bg-[#000000] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100",
                    billingView.payButton,
                  )}
                >
                  <Icon name="payment" className="text-[20px]" /> PAY NOW (Shift
                  + Enter)
                </button>

                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    disabled={cart.length === 0 || parkedBusy}
                    onClick={requestParkBill}
                    title={
                      cart.length === 0
                        ? "Add at least one item before parking a bill"
                        : parkedBusy
                          ? "Held bill action is already running"
                          : "Park current bill"
                    }
                    className={cn(
                      "flex items-center justify-center gap-2 rounded-[12px] border border-[#CFCFD3] bg-[#FFFFFF] font-extrabold text-[#2F67D8] transition hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:opacity-50",
                      billingView.secondaryButton,
                    )}
                  >
                    <Icon name="local_parking" className="text-[18px]" /> Park
                    (F6)
                  </button>
                  <button
                    type="button"
                    disabled={!hasBillDraft}
                    onClick={requestResetBill}
                    title={
                      hasBillDraft
                        ? "Clear current billing draft"
                        : "No billing draft to clear"
                    }
                    className={cn(
                      "flex items-center justify-center gap-2 rounded-[12px] border border-rose-200 bg-[#FFF1F2] font-extrabold text-rose-600 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:border-[#CFCFD3] disabled:bg-[#FFFFFF] disabled:text-[#8C8889] disabled:opacity-50",
                      billingView.secondaryButton,
                    )}
                  >
                    <Icon name="delete_sweep" className="text-[18px]" /> Clear
                    (F9)
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* FOOTER */}
        <div
          className={cn(
            "flex shrink-0 items-center justify-between gap-3 overflow-hidden border-t border-[#CFCFD3] bg-[#F8F9FA] font-extrabold text-[#565449]",
            billingView.footer,
          )}
        >
          <div className="flex min-w-0 items-center gap-3 whitespace-nowrap">
            <span>
              F2 <span className="font-semibold text-[#CFCFD3] mx-1">|</span>{" "}
              Search
            </span>
            <span>
              F3 <span className="font-semibold text-[#CFCFD3] mx-1">|</span>{" "}
              Scanner
            </span>
            <span className="hidden xl:inline">
              F4 <span className="font-semibold text-[#CFCFD3] mx-1">|</span>{" "}
              Cash
            </span>
            <span className="hidden xl:inline">
              F5 <span className="font-semibold text-[#CFCFD3] mx-1">|</span>{" "}
              eSewa
            </span>
            <span>
              F6 <span className="font-semibold text-[#CFCFD3] mx-1">|</span>{" "}
              Park
            </span>
            <span className="hidden 2xl:inline">
              F7 <span className="font-semibold text-[#CFCFD3] mx-1">|</span>{" "}
              Customer
            </span>
            <span className="hidden 2xl:inline">
              Alt+H <span className="font-semibold text-[#CFCFD3] mx-1">|</span>{" "}
              Held
            </span>
            <span>
              F9 <span className="font-semibold text-[#CFCFD3] mx-1">|</span>{" "}
              Clear
            </span>
            <span>
              Shift+Enter{" "}
              <span className="font-semibold text-[#CFCFD3] mx-1">|</span> Pay
            </span>
            <button
              type="button"
              onClick={() => setShowShortcutHelp(true)}
              className="inline-flex items-center gap-1 rounded-[5px] border border-[#CFCFD3] bg-white px-1.5 py-1 text-[10px] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6] focus:outline-none focus:ring-2 focus:ring-[#11120d]/15"
            >
              <Icon name="keyboard" className="text-[14px]" />
              More shortcuts
            </button>
          </div>
          <div className="hidden min-w-0 shrink items-center gap-4 whitespace-nowrap lg:flex">
            <span className="max-w-[260px] truncate">
              Operator: {operatorLabel}
            </span>
            <span className="shrink-0">Terminal: {terminalLabel}</span>
          </div>
        </div>
      </div>

      <ModalFrame
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

      <ModalFrame
        open={showPaymentModal}
        onClose={closePaymentFlow}
        title="Confirm Payment"
        description="Verify transaction details before finalizing."
        maxWidthClass="max-w-[840px]"
        footer={
          <div className="flex w-full items-center justify-between gap-4">
            <button
              type="button"
              onClick={closePaymentFlow}
              className="flex h-[52px] w-[180px] items-center justify-center gap-2 rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] text-[15px] font-extrabold text-[#000000] transition hover:bg-[#F3F4F6]"
            >
              <Icon name="arrow_back" className="text-[20px]" /> Back
            </button>
            <button
              type="button"
              disabled={!canConfirm || submitting || stockRefreshBusy}
              onClick={requestCheckoutConfirm}
              className="flex h-[52px] flex-1 items-center justify-center gap-2 rounded-[14px] bg-[#11120d] text-[16px] font-extrabold text-white transition hover:bg-[#000000] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon name="lock" className="text-[18px]" />
              {submitting
                ? "Creating..."
                : stockRefreshBusy
                  ? "Checking stock..."
                  : paymentMethod === "Split"
                    ? "CONFIRM SPLIT PAYMENT (Shift + Enter)"
                    : paymentStatus === "Partial"
                      ? "SAVE PARTIAL PAYMENT (Shift + Enter)"
                      : paymentStatus === "Unpaid"
                        ? "CREATE UNPAID INVOICE (Shift + Enter)"
                        : paymentMethod === "Fonepay"
                          ? "CONFIRM FONEPAY (Shift + Enter)"
                        : paymentMethod === "eSewa"
                          ? "CONTINUE TO ESEWA (Shift + Enter)"
                          : "FINAL CHECKOUT (Shift + Enter)"}
            </button>
          </div>
        }
      >
        <div className="space-y-[20px] text-slate-900">
          {/* Top Info Cards */}
          <div className="grid gap-4 md:grid-cols-3">
            <div className="flex min-h-[82px] items-center gap-4 rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] p-[16px]">
              <div className="flex h-[48px] w-[48px] shrink-0 items-center justify-center rounded-full bg-[#E8F2FF] text-[#2F67D8]">
                <Icon name="shopping_cart" className="text-[24px]" />
              </div>
              <div>
                <div className="text-[16px] font-extrabold">
                  Items: {cartRows.length}
                </div>
                <div className="mt-1 text-[13px] font-semibold text-[#565449]">
                  Total Qty:{" "}
                  {formatQty(cart.reduce((sum, line) => sum + line.qty, 0))}
                </div>
              </div>
            </div>
            <div className="flex min-h-[82px] items-center gap-4 rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] p-[16px]">
              <div className="flex h-[48px] w-[48px] shrink-0 items-center justify-center rounded-full bg-[#F3F4F6] text-[#2F67D8]">
                <Icon name="person" className="text-[24px]" />
              </div>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-[#565449]">
                  Customer:
                </div>
                <div className="mt-1 w-full truncate text-[16px] font-extrabold">
                  {selectedCustomer
                    ? selectedCustomer.name
                    : "Walk-in Customer"}
                </div>
              </div>
            </div>
            <div className="flex min-h-[82px] items-center gap-4 rounded-[14px] border border-[#2F67D8] bg-[#F8FBFF] p-[16px]">
              <div className="flex h-[48px] w-[48px] shrink-0 items-center justify-center rounded-full bg-[#2F67D8] text-white">
                <span className="text-[16px] font-extrabold">Rs.</span>
              </div>
              <div>
                <div className="text-[13px] font-semibold text-[#565449]">
                  Total:
                </div>
                <div className="mt-1 font-mono text-[20px] font-extrabold text-[#2F67D8]">
                  {formatNpr(payableTotal)}
                </div>
              </div>
            </div>
          </div>

          <div className="grid items-start gap-5 md:grid-cols-[minmax(0,1fr)_380px]">
            {/* Left: Inputs */}
            <div className="space-y-[12px]">
              <div>
                <div className="mb-[8px] text-[14px] font-extrabold text-[#000000]">
                  Payment Method
                </div>
                <div className="grid grid-cols-4 gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setPaymentMethod("Cash");
                      if (paymentStatus === "Paid")
                        setCashTendered(String(payableTotal));
                      setPaymentError("");
                    }}
                    className={`relative flex h-[58px] items-center justify-center gap-2 rounded-[12px] border bg-[#FFFFFF] transition ${paymentMethod === "Cash" ? "border-[#11120d] bg-[#F8F9FA] text-[#11120d]" : "border-[#CFCFD3] text-[#565449] hover:bg-[#F3F4F6]"}`}
                  >
                    <Icon name="payments" className="text-[24px]" />
                    <span className="text-[14px] font-extrabold">Cash</span>
                    {paymentMethod === "Cash" && (
                      <div className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-[#11120d] flex items-center justify-center text-white">
                        <Icon name="check" className="text-[12px]" />
                      </div>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPaymentMethod("Fonepay");
                      setShowEsewaQr(false);
                      setPaymentError("");
                    }}
                    className={`relative flex h-[58px] flex-col items-center justify-center gap-1 rounded-[12px] border bg-[#FFFFFF] transition ${paymentMethod === "Fonepay" ? "border-[#E11D48] bg-[#FFF7F8]" : "border-[#CFCFD3] hover:bg-[#F3F4F6]"}`}
                  >
                    <img
                      src="/assets/images/fonepay.png"
                      alt="Fonepay"
                      className="h-[21px] max-w-[74px] object-contain"
                    />
                    <span
                      className={`text-[13px] font-extrabold ${paymentMethod === "Fonepay" ? "text-[#334155]" : "text-[#565449]"}`}
                    >
                      Fonepay
                    </span>
                    {paymentMethod === "Fonepay" && (
                      <div className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-[#E11D48] flex items-center justify-center text-white">
                        <Icon name="check" className="text-[12px]" />
                      </div>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPaymentMethod("eSewa");
                      setShowEsewaQr(true);
                      setPaymentError("");
                    }}
                    className={`relative flex h-[58px] flex-col items-center justify-center gap-1 rounded-[12px] border bg-[#FFFFFF] transition ${paymentMethod === "eSewa" ? "border-[#60bb46] bg-[#f2faf0]" : "border-[#CFCFD3] hover:bg-[#F3F4F6]"}`}
                  >
                    <img
                      src="/assets/images/esewa/logo.png"
                      alt="eSewa"
                      className="h-[32px] w-[32px] rounded-full object-contain"
                    />
                    <span
                      className={`text-[13px] font-extrabold ${paymentMethod === "eSewa" ? "text-[#334155]" : "text-[#565449]"}`}
                    >
                      eSewa
                    </span>
                    {paymentMethod === "eSewa" && (
                      <div className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-[#60bb46] flex items-center justify-center text-white">
                        <Icon name="check" className="text-[12px]" />
                      </div>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPaymentMethod("Split");
                      setPaymentStatus("Paid");
                      setShowEsewaQr(true);
                      setPaymentError("");
                      ensureDefaultSplitPayments();
                    }}
                    className={`relative flex h-[58px] items-center justify-center gap-2 rounded-[12px] border bg-[#FFFFFF] transition ${paymentMethod === "Split" ? "border-[#2F67D8] bg-[#F8FBFF] text-[#2F67D8]" : "border-[#CFCFD3] text-[#565449] hover:bg-[#F3F4F6]"}`}
                  >
                    <Icon name="call_split" className="text-[24px]" />
                    <span className="text-[14px] font-extrabold">Split</span>
                    {paymentMethod === "Split" && (
                      <div className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-[#2F67D8] flex items-center justify-center text-white">
                        <Icon name="check" className="text-[12px]" />
                      </div>
                    )}
                  </button>
                </div>
              </div>

              {paymentMethod !== "Split" && (
                <div>
                  <div className="mb-[5px] text-[14px] font-extrabold text-[#000000]">
                    Payment Status
                  </div>
                  <div className="flex overflow-hidden rounded-[8px] border border-[#CFCFD3]">
                    {["Paid", "Partial", "Unpaid"].map((status) => (
                      <button
                        key={status}
                        type="button"
                        onClick={() => {
                          const nextStatus = status as PaymentStatus;
                          setPaymentStatus(nextStatus);
                          setBillingError("");
                          if (paymentMethod === "Cash" && nextStatus === "Paid")
                            setCashTendered(String(payableTotal));
                          if (nextStatus !== "Partial") {
                            setPaidAmount("");
                            setPaymentError("");
                          }
                        }}
                        className={`h-[38px] flex-1 text-[13px] font-extrabold transition ${paymentStatus === status ? "bg-[#11120d] text-white" : "bg-white text-[#565449] hover:bg-[#F3F4F6]"}`}
                      >
                        {status}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {paymentMethod === "Fonepay" && paymentStatus !== "Unpaid" ? (
                <Input
                  label="Fonepay reference / remarks"
                  value={fonepayReference}
                  onChange={(v) => {
                    setFonepayReference(v.slice(0, 160));
                    setPaymentError("");
                    setBillingError("");
                  }}
                  placeholder="Transaction ID, payer phone, or cashier note"
                  leftIcon="receipt_long"
                  invalid={!!paymentError && !fonepayReference.trim()}
                  helperText="Required for manual Fonepay collection and invoice history."
                />
              ) : null}

              {paymentMethod === "Split" ? (
                <div className="space-y-2">
                  <div className="rounded-[12px] border border-[#CFCFD3] bg-[#F8F9FA] p-2">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="text-[11px] font-extrabold text-[#000000]">
                          Split payment rows
                        </div>
                        <div className="mt-0.5 text-[10px] font-semibold text-[#8C8889]">
                          Must equal {formatNpr(payableTotal)}.
                        </div>
                      </div>
                      <div
                        className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold ${isSplitBalanced ? "bg-[#EAF8EF] text-[#179B4D]" : "bg-[#FFF7E8] text-[#B7791F]"}`}
                      >
                        {isSplitBalanced
                          ? "Balanced"
                          : splitBalance > 0
                            ? `${formatNpr(splitBalance)} short`
                            : `${formatNpr(Math.abs(splitBalance))} over`}
                      </div>
                    </div>
                    <div className="mt-2 space-y-2">
                      {splitPayments.map((row, index) => {
                        const amountNum = Number(row.amount || 0);
                        const tenderedNum = Number(row.tenderedAmount || 0);
                        const rowChange =
                          row.method === "CASH"
                            ? Math.max(0, tenderedNum - amountNum)
                            : 0;
                        return (
                          <div
                            key={row.id}
                            className="grid gap-2 rounded-[10px] border border-[#CFCFD3] bg-white p-2 md:grid-cols-[80px_minmax(0,1fr)_minmax(0,1fr)_32px]"
                          >
                            <ProjectSelect
                              value={row.method}
                              onChange={(e) =>
                                updateSplitPayment(row.id, {
                                  method: e.target
                                    .value as SplitPaymentDraft["method"],
                                })
                              }
                              className="h-[32px] rounded-[8px] border border-[#CFCFD3] bg-white px-2 text-[11px] font-extrabold text-[#565449] outline-none"
                            >
                              <option value="CASH">Cash</option>
                              <option value="FONEPAY">Fonepay</option>
                              <option value="ESEWA">eSewa</option>
                            </ProjectSelect>
                            <input
                              value={row.amount}
                              onChange={(e) =>
                                updateSplitPayment(row.id, {
                                  amount: e.target.value.replace(/[^\d.]/g, ""),
                                })
                              }
                              inputMode="numeric"
                              placeholder="Amount"
                              className="h-[32px] rounded-[8px] border border-[#CFCFD3] bg-white px-2 text-[11px] font-bold outline-none"
                            />
                            {row.method === "CASH" ? (
                              <input
                                value={row.tenderedAmount}
                                onChange={(e) =>
                                  updateSplitPayment(row.id, {
                                    tenderedAmount: e.target.value.replace(
                                      /[^\d.]/g,
                                      "",
                                    ),
                                  })
                                }
                                inputMode="numeric"
                                placeholder="Tendered"
                                className="h-[32px] rounded-[8px] border border-[#CFCFD3] bg-white px-2 text-[11px] font-bold outline-none"
                              />
                            ) : row.method === "FONEPAY" ? (
                              <input
                                value={row.reference || ""}
                                onChange={(e) =>
                                  updateSplitPayment(row.id, {
                                    reference: e.target.value.slice(0, 160),
                                  })
                                }
                                placeholder="Fonepay ref"
                                className="h-[32px] rounded-[8px] border border-[#CFCFD3] bg-white px-2 text-[11px] font-bold outline-none"
                              />
                            ) : (
                              <div className="flex h-[32px] items-center rounded-[8px] border border-[#CFCFD3] bg-[#F8F9FA] px-2 text-[10px] font-bold text-[#8C8889]">
                                Online intent
                              </div>
                            )}
                            <button
                              type="button"
                              onClick={() => removeSplitPayment(row.id)}
                              disabled={splitPayments.length <= 1}
                              className="flex h-[32px] items-center justify-center rounded-[8px] border border-[#CFCFD3] bg-white text-[#565449] disabled:opacity-40"
                            >
                              <Icon name="close" className="text-[14px]" />
                            </button>
                            {row.method === "CASH" && rowChange > 0 && (
                              <div className="md:col-span-4 text-[10px] font-bold text-[#179B4D]">
                                Return change {formatNpr(rowChange)} for this
                                cash row.
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => addSplitPayment("CASH")}
                        className="h-[28px] rounded-[8px] border border-[#CFCFD3] bg-white px-2 text-[10px] font-extrabold text-[#565449]"
                      >
                        + Cash row
                      </button>
                      <button
                        type="button"
                        onClick={() => addSplitPayment("ESEWA")}
                        disabled={splitPayments.some(
                          (row) => row.method === "ESEWA",
                        )}
                        className="h-[28px] rounded-[8px] border border-[#CFCFD3] bg-white px-2 text-[10px] font-extrabold text-[#565449] disabled:opacity-40"
                      >
                        + eSewa row
                      </button>
                      <button
                        type="button"
                        onClick={() => addSplitPayment("FONEPAY")}
                        disabled={splitPayments.some(
                          (row) => row.method === "FONEPAY",
                        )}
                        className="h-[28px] rounded-[8px] border border-[#CFCFD3] bg-white px-2 text-[10px] font-extrabold text-[#565449] disabled:opacity-40"
                      >
                        + Fonepay row
                      </button>
                    </div>
                  </div>
                </div>
              ) : paymentStatus === "Partial" ? (
                <Input
                  label="Amount paid"
                  autoFocus
                  value={paidAmount}
                  onChange={(v) => {
                    setPaidAmount(v.replace(/[^\d.]/g, ""));
                    setPaymentError("");
                    setBillingError("");
                  }}
                  placeholder="e.g. 500"
                  leftIcon="currency_rupee"
                  inputMode="numeric"
                  invalid={!!paymentError}
                  helperText={
                    paymentError ||
                    `Enter amount greater than 0 and less than ${formatNpr(payableTotal)}.`
                  }
                />
              ) : paymentMethod === "Cash" && paymentStatus === "Paid" ? (
                <div>
                  <div className="mb-[8px] text-[14px] font-extrabold text-[#000000]">
                    Cash Received
                  </div>
                  <div className="flex h-[38px] overflow-hidden rounded-[12px] border border-[#CFCFD3] bg-white">
                    <div className="flex w-[58px] items-center justify-center bg-[#F3F4F6] text-[18px] font-extrabold text-[#565449]">
                      Rs.
                    </div>
                    <input
                      type="text"
                      autoFocus
                      value={cashTendered}
                      onChange={(e) => {
                        setCashTendered(e.target.value.replace(/[^\d.]/g, ""));
                        setPaymentError("");
                        setBillingError("");
                      }}
                      placeholder="0.00"
                      className="flex-1 px-4 font-mono text-[24px] font-extrabold text-[#000000] outline-none"
                    />
                  </div>
                  <div className="mt-[10px] flex gap-3">
                    <button
                      type="button"
                      title="Tender exact cash due"
                      onClick={() => {
                        setCashTendered(String(cashDueAmount));
                        setPaymentError("");
                        setBillingError("");
                      }}
                      className="h-[28px] flex-1 rounded-[8px] border border-[#11120d] text-[12px] font-extrabold text-[#11120d] transition hover:bg-[#F3F4F6]"
                    >
                      Exact
                    </button>
                    <button
                      type="button"
                      disabled={500 < cashDueAmount}
                      title={
                        500 < cashDueAmount
                          ? "NPR 500 is less than the cash due"
                          : "Tender NPR 500"
                      }
                      onClick={() => {
                        setCashTendered("500");
                        setPaymentError("");
                        setBillingError("");
                      }}
                      className="h-[28px] flex-1 rounded-[8px] border border-[#CFCFD3] bg-white text-[12px] font-extrabold text-[#11120d] transition hover:bg-[#F3F4F6] disabled:bg-[#F3F4F6] disabled:opacity-50"
                    >
                      Rs. 500
                    </button>
                    <button
                      type="button"
                      disabled={1000 < cashDueAmount}
                      title={
                        1000 < cashDueAmount
                          ? "NPR 1,000 is less than the cash due"
                          : "Tender NPR 1,000"
                      }
                      onClick={() => {
                        setCashTendered("1000");
                        setPaymentError("");
                        setBillingError("");
                      }}
                      className="h-[28px] flex-1 rounded-[8px] border border-[#CFCFD3] bg-white text-[12px] font-extrabold text-[#11120d] transition hover:bg-[#F3F4F6] disabled:bg-[#F3F4F6] disabled:opacity-50"
                    >
                      Rs. 1,000
                    </button>
                    <button
                      type="button"
                      disabled={5000 < cashDueAmount}
                      title={
                        5000 < cashDueAmount
                          ? "NPR 5,000 is less than the cash due"
                          : "Tender NPR 5,000"
                      }
                      onClick={() => {
                        setCashTendered("5000");
                        setPaymentError("");
                        setBillingError("");
                      }}
                      className="h-[28px] flex-1 rounded-[8px] border border-[#CFCFD3] bg-white text-[12px] font-extrabold text-[#11120d] transition hover:bg-[#F3F4F6] disabled:bg-[#F3F4F6] disabled:opacity-50"
                    >
                      Rs. 5,000
                    </button>
                  </div>
                  {cashShort > 0 && !!cashTendered && (
                    <div className="mt-1 text-[11px] font-bold text-rose-600">
                      Need {formatNpr(cashShort)} more cash.
                    </div>
                  )}
                </div>
              ) : null}

              <div>
                <div className="mb-[6px] flex items-center justify-between">
                  <div className="text-[14px] font-extrabold text-[#000000]">
                    Invoice Note{" "}
                    <span className="text-[11px] font-semibold text-[#8C8889]">
                      (Optional)
                    </span>
                  </div>
                  <div className="text-[11px] font-semibold text-[#8C8889]">
                    {invoiceNote.length} / 120
                  </div>
                </div>
                <input
                  type="text"
                  value={invoiceNote}
                  onChange={(e) => setInvoiceNote(e.target.value.slice(0, 120))}
                  placeholder="Add a short note for this invoice..."
                  className="h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-[#FFFFFF] px-3 text-[13px] font-medium outline-none transition focus:border-[#11120d]"
                />
              </div>
            </div>

            {/* Right: Settlement Summary */}
            <div className="self-start">
              <div className="rounded-[16px] border border-[#CFCFD3] bg-[#F8F9FA] p-[18px] py-[30px] shadow-sm">
                <div className="mb-[15px] text-[17px] font-extrabold text-[#000000]">
                  Settlement Summary
                </div>

                <div className="space-y-[18px] text-[16px] font-semibold text-[#565449]">
                  <div className="flex justify-between items-center">
                    <span>Subtotal</span>
                    <span className="font-mono text-[#000000]">
                      {formatNpr(subTotal)}
                    </span>
                  </div>
                  {subtotalDiscount > 0 && (
                    <div className="flex justify-between items-center text-rose-600">
                      <span>Discount</span>
                      <span className="font-mono">
                        -{formatNpr(subtotalDiscount)}
                      </span>
                    </div>
                  )}
                  {hasPriceOverrides && (
                    <div
                      className={`flex justify-between items-center ${overrideDiffIsReduction ? "text-rose-600" : "text-amber-600"}`}
                    >
                      <span>{overrideDiffLabel}</span>
                      <span className="font-mono">{overrideDiffDisplay}</span>
                    </div>
                  )}

                  <div className="my-[10px] border-t border-[#CFCFD3]" />

                  <div className="flex justify-between items-center text-[15px] font-extrabold text-[#000000]">
                    <span>Total</span>
                    <span className="font-mono">{formatNpr(payableTotal)}</span>
                  </div>

                  {paymentMethod === "Split" ? (
                    <>
                      <div className="flex justify-between items-center text-[#2F67D8]">
                        <span>Cash collected</span>
                        <span className="font-mono font-bold">
                          {formatNpr(splitCashNum)}
                        </span>
                      </div>
                      <div className="flex justify-between items-center text-[#2F67D8]">
                        <span>eSewa amount</span>
                        <span className="font-mono font-bold">
                          {formatNpr(splitEsewaAmount)}
                        </span>
                      </div>
                      {splitFonepayAmount > 0 ? (
                        <div className="flex justify-between items-center text-[#2F67D8]">
                          <span>Fonepay amount</span>
                          <span className="font-mono font-bold">
                            {formatNpr(splitFonepayAmount)}
                          </span>
                        </div>
                      ) : null}
                      <div className="flex justify-between items-center text-[#000000]">
                        <span>Total collected</span>
                        <span className="font-mono font-extrabold">
                          {formatNpr(splitTotal)}
                        </span>
                      </div>
                      {!isSplitBalanced ? (
                        <div className="flex justify-between items-center text-[#B7791F]">
                          <span>Split balance</span>
                          <span className="font-mono font-bold">
                            {splitBalance > 0
                              ? `${formatNpr(splitBalance)} short`
                              : `${formatNpr(Math.abs(splitBalance))} over`}
                          </span>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div className="flex justify-between items-center text-[#2F67D8]">
                      <span>Collected</span>
                      <span className="font-mono font-bold">
                        {formatNpr(effectivePaidAmount)}
                      </span>
                    </div>
                  )}
                </div>

                <div className="mt-[12px] space-y-2">
                  {paymentMethod === "Cash" && paymentStatus === "Paid" ? (
                    <div
                      className={`flex items-center justify-between rounded-[12px] border p-[12px] ${changeDue > 0 ? "bg-[#EAF8EF] border-[#9DD8B2]" : cashShort > 0 ? "bg-[#FFF7E8] border-[#F6D28B]" : "bg-[#FFFFFF] border-[#CFCFD3]"}`}
                    >
                      <div
                        className={`flex items-center gap-2 font-extrabold text-[14px] ${changeDue > 0 ? "text-[#179B4D]" : cashShort > 0 ? "text-[#B7791F]" : "text-[#8C8889]"}`}
                      >
                        <span
                          className={`flex h-[32px] w-[32px] items-center justify-center rounded-[9px] ${changeDue > 0 ? "bg-[#DDF3E6]" : cashShort > 0 ? "bg-[#FFF1D6]" : "bg-[#F3F4F6]"}`}
                        >
                          <Icon name="payments" className="text-[18px]" />
                        </span>
                        {cashShort > 0 ? "Cash Short" : "Change Due"}
                      </div>
                      <div
                        className={`font-mono text-[21px] font-extrabold ${changeDue > 0 ? "text-[#179B4D]" : cashShort > 0 ? "text-[#B7791F]" : "text-[#8C8889]"}`}
                      >
                        {formatNpr(cashShort > 0 ? cashShort : changeDue)}
                      </div>
                    </div>
                  ) : null}

                  {paymentMethod !== "Split" && balanceDue > 0 ? (
                    <div className="flex items-center justify-between rounded-[12px] border border-[#F6D28B] bg-[#FFF7E8] px-3 py-2.5 text-[13px] font-extrabold text-[#B7791F]">
                      <span>Balance Due</span>
                      <span className="font-mono">{formatNpr(balanceDue)}</span>
                    </div>
                  ) : null}

                  <div
                    className={`flex items-center gap-3 rounded-[12px] border px-3 py-2.5 ${
                      paymentStateTone === "success"
                        ? "border-[#9DD8B2] bg-[#EAF8EF]"
                        : paymentStateTone === "warning"
                          ? "border-[#F6D28B] bg-[#FFF7E8]"
                          : paymentStateTone === "fonepay"
                            ? "border-[#F7C6D0] bg-[#FFF7F8]"
                          : paymentStateTone === "esewa"
                            ? "border-[#BDE5B2] bg-[#f2faf0]"
                            : "border-[#CFCFD3] bg-[#FFFFFF]"
                    }`}
                  >
                    <span
                      className={`flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[9px] ${
                        paymentStateTone === "success"
                          ? "bg-[#DDF3E6] text-[#179B4D]"
                          : paymentStateTone === "warning"
                            ? "bg-[#FFF1D6] text-[#B7791F]"
                            : paymentStateTone === "fonepay"
                              ? "bg-white text-[#E11D48]"
                            : paymentStateTone === "esewa"
                              ? "bg-white text-[#60bb46]"
                              : "bg-[#E8F2FF] text-[#2F67D8]"
                      }`}
                    >
                      {paymentStateTone === "fonepay" ? (
                        <img
                          src="/assets/images/fonepay.png"
                          alt="Fonepay"
                          className="h-[18px] w-[26px] object-contain"
                        />
                      ) : paymentStateTone === "esewa" ? (
                        <img
                          src="/assets/images/esewa/logo.png"
                          alt="eSewa"
                          className="h-[22px] w-[22px] object-contain"
                        />
                      ) : (
                        <Icon
                          name={
                            paymentMethod === "Split"
                              ? "call_split"
                              : paymentStatus === "Unpaid"
                                ? "receipt_long"
                                : paymentStatus === "Partial"
                                  ? "pending_actions"
                                  : "task_alt"
                          }
                          className="text-[18px]"
                        />
                      )}
                    </span>
                    <div className="min-w-0">
                      <div className="text-[12px] font-extrabold text-[#000000]">
                        {paymentStateTitle}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] font-semibold text-[#565449]">
                        {paymentStateDetail}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {paymentError || billingError ? (
            <div className="rounded-[10px] border border-[#FECDD3] bg-[#FFF1F2] px-3 py-2 text-[12px] font-bold text-[#BE123C]">
              {paymentError || billingError}
            </div>
          ) : null}
        </div>
      </ModalFrame>
      <ModalFrame
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
                    {formatNpr(priceOverrideTargetRow.baseUnitPrice)}
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
                <div className="relative">
                  <ProjectSelect
                    value={priceOverrideDraftReason}
                    onChange={(event) => {
                      setPriceOverrideDraftReason(event.target.value);
                      setPriceOverrideError("");
                    }}
                    className="h-[44px] w-full appearance-none rounded-[12px] border border-[#CFCFD3] bg-white px-3 pr-10 text-[13px] font-extrabold text-[#11120d] outline-none transition focus:border-[#11120d] focus:ring-2 focus:ring-[#11120d]/10"
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
                  <Icon
                    name="expand_more"
                    className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[18px] text-[#8C8889]"
                  />
                </div>
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
                  <DialogButton
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
                <DialogButton onClick={closePriceOverride}>Cancel</DialogButton>
                <DialogButton
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

      <ModalFrame
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
            <DialogButton
              onClick={() => void refreshStockConflictList()}
              disabled={stockRefreshBusy}
              icon="sync"
            >
              {stockRefreshBusy ? "Refreshing..." : "Refresh Stock"}
            </DialogButton>
            <DialogButton
              onClick={applyAllStockConflictSuggestions}
              variant="primary"
              icon="done_all"
            >
              Apply Suggestions
            </DialogButton>
          </div>
        </div>
      </ModalFrame>

      <ModalFrame
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
                            {formatNpr(Number(draft.subTotal || 0))}
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

      <ModalFrame
        open={!!pendingStaleResume}
        onClose={() => setPendingStaleResume(null)}
        title="Review held bill changes"
        description="Prices or available stock changed since this bill was parked."
        maxWidthClass="max-w-[760px]"
        footer={
          <>
            <DialogButton
              onClick={() => void discardPendingStaleResume()}
              variant="danger"
              icon="delete"
              disabled={parkedBusy}
            >
              Discard Held Bill
            </DialogButton>
            <DialogButton
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
                    {formatNpr(warning.parkedUnitPrice)}
                  </div>
                  <div
                    className={cn(
                      "text-right font-mono font-extrabold",
                      warning.currentUnitPrice !== warning.parkedUnitPrice
                        ? "text-[#B7791F]"
                        : "text-[#565449]",
                    )}
                  >
                    {formatNpr(warning.currentUnitPrice)}
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

      {pendingBillingConfirmConfig ? (
        <ConfirmDialog
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
        <ConfirmDialog
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

      <SuccessDialog
        open={showSuccess}
        title="Invoice created successfully"
        message="The invoice has been finalized and recorded in KhataSathi."
        onClose={() => setShowSuccess(false)}
        actionLabel="Continue Billing"
        secondaryAction={
          lastCreatedInvoiceId ? (
            <div className="flex flex-wrap gap-2">
              <DialogButton
                onClick={() => openInvoicePrint(lastCreatedInvoiceId)}
                icon="print"
              >
                Print Invoice
              </DialogButton>
              <DialogButton
                onClick={() => openInvoiceReceiptPrint(lastCreatedInvoiceId)}
                icon="receipt_long"
              >
                Receipt
              </DialogButton>
            </div>
          ) : null
        }
      />
    </>
  );
}
