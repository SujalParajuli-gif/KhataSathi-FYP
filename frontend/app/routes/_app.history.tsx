import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  InvoiceStatusChip,
  PaymentMethodChip,
} from "~/components/invoices/InvoiceChips";
import InvoiceDetailModal from "~/components/invoices/InvoiceDetailModal";
import Icon from "~/components/ui/Icon";
import ProjectSelect from "~/components/ui/ProjectSelect";
import ProjectDateInput from "~/components/ui/ProjectDateInput";
import {
  ActiveFilterChips,
  MobileFilterButton,
  MobileFilterSheet,
  MobileFilterTabs,
  type MobileFilterChip,
} from "~/components/ui/MobileFilters";
import { DialogButton, ModalFrame } from "~/components/ui/Modal";
import PaginationBar from "~/components/ui/PaginationBar";
import SwipeableTabRail, { type SwipeableTabRailController } from "~/components/ui/SwipeableTabRail";
import { getAuthUser } from "~/lib/auth";
import {
  getInvoiceApi,
  getStockReceiveBatchApi,
  listCategorizedHistoryApi,
  listInvoicesApi,
  listUsersApi,
  type StockReceiveBatchDetail,
} from "~/lib/api/endpoints";
import type { AppInvoice, InvoiceStatusLabel } from "~/lib/invoices";
import {
  formatNpr,
  getInvoiceReference,
  normalizeInvoice,
} from "~/lib/invoices";
import { isRateLimitError } from "~/lib/api/client";
import { useRateLimitRecovery } from "~/lib/api/useRateLimitRecovery";
import { useBusinessCapabilities } from "~/lib/businessCapabilities";
import { useHorizontalGesture } from "~/hooks/useHorizontalGesture";
import {
  getVisibleHistoryCategoryKeys,
  type HistoryCategoryKey as HistoryCategory,
} from "~/lib/routeAccess";

// we use this helper function to easily join multiple tailwind class strings
function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

// this converts an HTML date picker string (e.g., "2024-03-12") into a local timezone
// Date object. We added endOfDay boolean so "to date" filters can include all time up to 11:59 PM.
function buildLocalDateBoundary(value: string, endOfDay = false) {
  if (!value) return null;

  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;

  return new Date(
    year,
    month - 1,
    day,
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0,
  );
}

// we use this to keep the pagination page number between 1 and the max pages available
function clampPage(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

// reusing the same walk-in vs registered rule keeps filtering consistent with the invoice page
function getInvoiceCustomerType(invoice: Pick<AppInvoice, "customerId">) {
  return invoice.customerId ? "Registered" : "Walk-in";
}

type HistoryCustomerTypeFilter = "All" | "Walk-in" | "Registered";
const HISTORY_CATEGORIES: Array<{ key: HistoryCategory; label: string }> = [
  { key: "sales", label: "Sales" },
  { key: "product", label: "Products" },
  { key: "stock", label: "Stock" },
  { key: "import", label: "Imports" },
  { key: "document", label: "Documents" },
  { key: "return", label: "Returns" },
  { key: "payment", label: "Payments" },
  { key: "system", label: "System" },
];

const HISTORY_CATEGORY_INFO: Record<
  HistoryCategory,
  { title: string; subtitle: string; icon: string }
> = {
  sales: {
    title: "Sales History",
    subtitle: "Invoice records with payment totals, status, method, and reference data.",
    icon: "receipt_long",
  },
  product: {
    title: "Product Activity",
    subtitle: "Catalog changes, price updates, activation changes, and product maintenance.",
    icon: "inventory_2",
  },
  stock: {
    title: "Stock Movement",
    subtitle: "Receives, adjustments, billing movement, returns, and stock corrections.",
    icon: "sync_alt",
  },
  import: {
    title: "Import History",
    subtitle: "CSV, PDF, image, and document import reviews with captured results.",
    icon: "upload_file",
  },
  document: {
    title: "Document History",
    subtitle: "Uploaded, linked, moved, restored, and deleted document activity.",
    icon: "description",
  },
  return: {
    title: "Return History",
    subtitle: "Return requests, approvals, rejections, reversals, and refund flow.",
    icon: "assignment_return",
  },
  payment: {
    title: "Payment History",
    subtitle: "Payment updates, voids, cash drawer events, and settlement references.",
    icon: "payments",
  },
  system: {
    title: "System Activity",
    subtitle: "Settings, backup, restore, security, and background maintenance events.",
    icon: "admin_panel_settings",
  },
};

type HistoryEventRow = {
  id: string;
  category?: string;
  action: string;
  entityType: string;
  entityId: string;
  title?: string;
  description?: string;
  detailType?: string | null;
  detailId?: string | null;
  actionLabel?: string | null;
  actor?: { id: string; name?: string | null; email?: string | null; role?: string | null };
  meta?: unknown;
  createdAt: string;
};

function formatEventTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function humanizeAction(value: string) {
  return String(value || "Event")
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getEventMeta(event: HistoryEventRow) {
  return event.meta && typeof event.meta === "object"
    ? (event.meta as Record<string, any>)
    : {};
}

function formatMetaMoney(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? formatNpr(amount) : null;
}

function compactText(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function getEventHighlights(event: HistoryEventRow, category: HistoryCategory) {
  const meta = getEventMeta(event);
  const highlights: Array<{ label: string; value: string; tone?: string }> = [];
  const add = (label: string, value: unknown, tone?: string) => {
    const text = compactText(value);
    if (text) highlights.push({ label, value: text, tone });
  };
  const addMoney = (label: string, value: unknown, tone?: string) => {
    const text = formatMetaMoney(value);
    if (text) highlights.push({ label, value: text, tone });
  };

  if (category === "product") {
    add("Product", meta.productName || meta.sku || event.entityId);
    add("SKU", meta.sku);
    addMoney("Retail before", meta.before?.retailPrice);
    addMoney("Retail after", meta.after?.retailPrice, "text-[#B7791F]");
    add("Reason", meta.reason);
  } else if (category === "stock") {
    add("Product", meta.productName || event.entityId);
    add("Qty", meta.qty ?? meta.qtyDelta, "text-[#2F67D8]");
    if (meta.previousStock !== undefined || meta.nextStock !== undefined) {
      add("Stock", `${meta.previousStock ?? "?"} -> ${meta.nextStock ?? "?"}`);
    }
    add("Supplier", meta.supplierName);
    add("Lines", meta.lineCount);
  } else if (category === "import") {
    add("File", meta.fileName || event.entityId);
    add("Source", meta.sourceType);
    add("Created", meta.createdCount, "text-[#179B4D]");
    add("Errors", meta.errorCount, "text-rose-700");
  } else if (category === "document") {
    add("Document", meta.fileName || event.entityId);
    add("Type", meta.documentType);
    add("Count", meta.count);
  } else if (category === "return") {
    add("Invoice", meta.invoiceNo);
    addMoney("Refund", meta.refundAmount, "text-[#B7791F]");
    add("Reason", meta.reason);
  } else if (category === "payment") {
    add("Invoice", meta.invoiceNo || event.entityId);
    addMoney("Amount", meta.amountAdded ?? meta.voidedAmount, "text-[#179B4D]");
    addMoney("Remaining due", meta.remainingDue, "text-rose-700");
    add("Reference", meta.reference || meta.referenceId || meta.transactionCode);
  } else if (category === "system") {
    add("File", meta.filename);
    add("Changed", meta.setting || meta.permission || meta.actionLabel);
    add("Failed", meta.failedCount, "text-rose-700");
  }

  if (highlights.length === 0) {
    add("Entity", event.entityType);
    add("Record", event.entityId);
  }

  return highlights.slice(0, 5);
}

function getEventIcon(category: HistoryCategory, event: HistoryEventRow) {
  const action = event.action.toUpperCase();
  if (action.includes("DELETED") || action.includes("CANCELLED") || action.includes("REJECTED")) {
    return "block";
  }
  if (action.includes("APPROVED") || action.includes("COMPLETED") || action.includes("RESTORED")) {
    return "check_circle";
  }
  if (action.includes("PRICE")) return "sell";
  if (action.includes("PAYMENT")) return "payments";
  if (action.includes("STOCK")) return "sync_alt";
  return HISTORY_CATEGORY_INFO[category].icon;
}

function getEventActionTone(event: HistoryEventRow) {
  const action = event.action.toUpperCase();
  if (action.includes("FAILED") || action.includes("REJECTED") || action.includes("DELETED")) {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }
  if (action.includes("APPROVED") || action.includes("COMPLETED") || action.includes("RESTORED")) {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (action.includes("PRICE") || action.includes("ADJUSTED") || action.includes("VOIDED")) {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  return "border-[#DADDE3] bg-[#F8FAFC] text-[#565449]";
}

function getSectionAction(category: HistoryCategory, isAdminView: boolean) {
  if (category === "product" || category === "stock" || category === "import") {
    return { label: "Open products", route: "/products" };
  }
  if (category === "document") return { label: "Open documents", route: "/documents" };
  if (category === "return") return { label: "Open requests", route: "/requests" };
  if (category === "payment") return { label: "Open invoices", route: "/invoices" };
  if (category === "system" && isAdminView) return { label: "Open settings", route: "/settings" };
  return null;
}

// this handles the "Invoice History" page 
// where admins and cashiers can browse, filter, search, and review all past invoices in the system
export default function HistoryPage() {
  const authUser = getAuthUser();
  const navigate = useNavigate();
  const capabilities = useBusinessCapabilities();
  const isAdminView = authUser?.role === "admin";
  const visibleHistoryCategories = useMemo(
    () => {
      const visibleKeys = new Set(getVisibleHistoryCategoryKeys(capabilities));
      return HISTORY_CATEGORIES.filter((category) => visibleKeys.has(category.key));
    },
    [capabilities.inventoryEnabled, capabilities.posEnabled],
  );
  const [invoices, setInvoices] = useState<AppInvoice[]>([]); // stores the normalized invoice list used by all filters and summary cards
  const [invoiceTotal, setInvoiceTotal] = useState(0);
  const [invoiceSummary, setInvoiceSummary] = useState({
    totalSales: 0,
    totalPaid: 0,
    outstandingDue: 0,
    generated: 0,
    walkIn: 0,
    esewa: 0,
    withReference: 0,
  });
  const [loading, setLoading] = useState(capabilities.posEnabled); // tracks whether the initial data fetch is still running
  const [historyCategory, setHistoryCategory] = useState<HistoryCategory>(
    capabilities.posEnabled ? "sales" : "product",
  );
  const historyTabRailRef = useRef<SwipeableTabRailController | null>(null);
  const [eventRows, setEventRows] = useState<HistoryEventRow[]>([]);
  const [eventLoading, setEventLoading] = useState(false);
  const [eventTotal, setEventTotal] = useState(0);
  const [eventTotalPages, setEventTotalPages] = useState(1);
  const [stockBatchDetail, setStockBatchDetail] = useState<StockReceiveBatchDetail | null>(null);
  const [stockDetailLoading, setStockDetailLoading] = useState(false);
  const [stockDetailError, setStockDetailError] = useState("");
  const [contextNotice, setContextNotice] = useState("");
  const [query, setQuery] = useState(""); // free text search across invoice number, customer, cashier, items, and reference
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"All" | InvoiceStatusLabel>("All"); // main status tab selection
  const [fromDate, setFromDate] = useState(""); // lower date boundary from the filter controls
  const [toDate, setToDate] = useState(""); // upper date boundary from the filter controls
  const [cashierFilter, setCashierFilter] = useState("All"); // admin-facing cashier selector for narrowing history records to one cashier
  const [customerTypeFilter, setCustomerTypeFilter] =
    useState<HistoryCustomerTypeFilter>("All"); // lets admins combine customer type and cashier filters together
  const [methodFilter, setMethodFilter] = useState<
    "All" | AppInvoice["paymentMethod"]
  >("All"); // payment method filter from the dropdown
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [draftFromDate, setDraftFromDate] = useState("");
  const [draftToDate, setDraftToDate] = useState("");
  const [draftCashierFilter, setDraftCashierFilter] = useState("All");
  const [draftCustomerTypeFilter, setDraftCustomerTypeFilter] = useState<HistoryCustomerTypeFilter>("All");
  const [draftMethodFilter, setDraftMethodFilter] = useState<"All" | AppInvoice["paymentMethod"]>("All");
  const [page, setPage] = useState(1); // current page inside the filtered results list
  const [pageSize, setPageSize] = useState(20);
  const [cashierOptions, setCashierOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(
    null,
  );
  const [detailInvoice, setDetailInvoice] = useState<AppInvoice | null>(null); // invoice shown inside the detail modal
  const [rateLimitRecoveryKey, setRateLimitRecoveryKey] = useState(0);
  const requestRateLimitRecovery = useRateLimitRecovery(() => {
    setRateLimitRecoveryKey((current) => current + 1);
  });

  async function loadInvoices(options?: { signal?: AbortSignal }) {
    const paymentStatus =
      activeTab === "Paid"
        ? "PAID"
        : activeTab === "Partial"
          ? "PARTIALLY_PAID"
          : activeTab === "Unpaid"
            ? "UNPAID"
            : activeTab === "Cancelled"
              ? "CANCELLED"
              : undefined;
    const paymentMethod =
      methodFilter === "All"
        ? undefined
        : methodFilter === "Bank Transfer"
          ? "BANK_TRANSFER"
          : methodFilter === "eSewa"
            ? "ESEWA"
            : methodFilter.toUpperCase();
    const data = await listInvoicesApi(
      {
        status: "FINALIZED",
        paymentStatus,
        cashierId:
          isAdminView && cashierFilter !== "All" ? cashierFilter : undefined,
        customerType:
          customerTypeFilter === "Walk-in"
            ? "WALK_IN"
            : customerTypeFilter === "Registered"
              ? "REGISTERED"
              : undefined,
        paymentMethod,
        search: debouncedQuery || undefined,
        from: fromDate || undefined,
        to: toDate || undefined,
        page,
        pageSize,
      },
      options,
    );
    setInvoices(
      (Array.isArray(data?.invoices) ? data.invoices : []).map(normalizeInvoice),
    );
    setInvoiceTotal(Number(data?.total || 0));
    if (data?.summary) setInvoiceSummary(data.summary);
  }

  // we use this helper to fetch one invoice with its full detail data right before opening the modal
  async function hydrateInvoice(id: string) {
    const data = await getInvoiceApi(id);
    return normalizeInvoice(data);
  }

  useEffect(() => {
    if (!isAdminView || !capabilities.posEnabled) return;
    void listUsersApi({ role: "CASHIER" })
      .then((users) => {
        const rows = Array.isArray(users) ? users : [];
        setCashierOptions(
          rows
            .filter((user: any) => user?.isActive !== false)
            .map((user: any) => ({
              id: String(user.id),
              name: String(user.name || user.email || "Cashier"),
            }))
            .sort((left: any, right: any) => left.name.localeCompare(right.name)),
        );
      })
      .catch(() => {});
  }, [capabilities.posEnabled, isAdminView]);

  useEffect(() => {
    if (visibleHistoryCategories.some((category) => category.key === historyCategory)) return;
    setHistoryCategory(visibleHistoryCategories[0]?.key || "product");
    setPage(1);
    setLoading(false);
    setContextNotice("");
  }, [historyCategory, visibleHistoryCategories]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (historyCategory !== "sales" || !capabilities.posEnabled) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      void loadInvoices({ signal: controller.signal })
        .catch((error: any) => {
          if (controller.signal.aborted || error?.code === "ERR_CANCELED") return;
          if (isRateLimitError(error)) requestRateLimitRecovery();
          // Preserve the last successful page during transient failures.
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    activeTab,
    capabilities.posEnabled,
    cashierFilter,
    customerTypeFilter,
    debouncedQuery,
    fromDate,
    historyCategory,
    isAdminView,
    methodFilter,
    page,
    pageSize,
    rateLimitRecoveryKey,
    toDate,
  ]);

  const filtered = invoices;

  const hasExtraFilters =
    fromDate.length > 0 ||
    toDate.length > 0 ||
    methodFilter !== "All" ||
    customerTypeFilter !== "All" ||
    (isAdminView && cashierFilter !== "All"); // decides whether the clear button should be enabled

  // this resets only the secondary filters and leaves the main search + status tab untouched
  function clearExtraFilters() {
    setFromDate("");
    setToDate("");
    setCashierFilter("All");
    setCustomerTypeFilter("All");
    setMethodFilter("All");
    setPage(1);
  }

  const mobileFilterCount = [
    Boolean(fromDate || toDate),
    isAdminView && cashierFilter !== "All",
    customerTypeFilter !== "All",
    methodFilter !== "All",
  ].filter(Boolean).length;
  const mobileFilterChips: MobileFilterChip[] = [
    ...(fromDate || toDate ? [{ id: "dates", label: `${fromDate || "Any"} – ${toDate || "Any"}`, onRemove: () => { setFromDate(""); setToDate(""); setPage(1); } }] : []),
    ...(isAdminView && cashierFilter !== "All" ? [{ id: "cashier", label: cashierOptions.find((cashier) => cashier.id === cashierFilter)?.name || "Cashier", onRemove: () => { setCashierFilter("All"); setPage(1); } }] : []),
    ...(customerTypeFilter !== "All" ? [{ id: "customer", label: customerTypeFilter, onRemove: () => { setCustomerTypeFilter("All"); setPage(1); } }] : []),
    ...(methodFilter !== "All" ? [{ id: "method", label: methodFilter, onRemove: () => { setMethodFilter("All"); setPage(1); } }] : []),
  ];

  function openMobileFilters() {
    setDraftFromDate(fromDate);
    setDraftToDate(toDate);
    setDraftCashierFilter(cashierFilter);
    setDraftCustomerTypeFilter(customerTypeFilter);
    setDraftMethodFilter(methodFilter);
    setMobileFiltersOpen(true);
  }

  function applyMobileFilters() {
    setFromDate(draftFromDate);
    setToDate(draftToDate);
    setCashierFilter(draftCashierFilter);
    setCustomerTypeFilter(draftCustomerTypeFilter);
    setMethodFilter(draftMethodFilter);
    setPage(1);
    setMobileFiltersOpen(false);
  }

  useEffect(() => {
    if (historyCategory === "sales") return;

    const controller = new AbortController();
    async function loadEvents() {
      try {
        setEventLoading(true);
        const data = await listCategorizedHistoryApi(
          {
            category: historyCategory,
            q: debouncedQuery || undefined,
            from: fromDate || undefined,
            to: toDate || undefined,
            page,
            pageSize,
          },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setEventRows(data.events);
        setEventTotal(data.total);
        setEventTotalPages(Math.max(1, data.totalPages));
      } catch (error: any) {
        if (controller.signal.aborted || error?.code === "ERR_CANCELED") return;
        if (isRateLimitError(error)) requestRateLimitRecovery();
        // Keep the last successful page visible during a transient failure or
        // rate-limit cooldown. A failed refresh must not look like no history.
      } finally {
        if (!controller.signal.aborted) setEventLoading(false);
      }
    }

    const timer = window.setTimeout(() => void loadEvents(), 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    debouncedQuery,
    fromDate,
    historyCategory,
    page,
    pageSize,
    rateLimitRecoveryKey,
    toDate,
  ]);

  const totalPages = Math.max(1, Math.ceil(invoiceTotal / pageSize));
  const pageClamped = clampPage(page, 1, totalPages); // protecting against stale page numbers after filters shrink the result set

  const pageItems = invoices;
  const pageStart = invoiceTotal === 0 ? 0 : (pageClamped - 1) * pageSize;
  const pageEnd = invoiceTotal === 0 ? 0 : pageStart + pageItems.length;
  const totalSales = Number(invoiceSummary.totalSales || 0);
  const totalPaid = Number(invoiceSummary.totalPaid || 0);
  const totalDue = Number(invoiceSummary.outstandingDue || 0);
  const walkInRecordCount = Number(invoiceSummary.walkIn || 0);
  const esewaRecordCount = Number(invoiceSummary.esewa || 0);
  const referenceRecordCount = Number(invoiceSummary.withReference || 0);

  useEffect(() => {
    if (page !== pageClamped) setPage(pageClamped);
  }, [page, pageClamped]);

  // fetching the full invoice details when the user clicks the "visibility" icon
  // the main list doesn't have detailed relations, so we fetch it fresh by its ID
  async function openInvoice(id: string) {
    // start by showing whatever cached basic info we have in the array so the modal opens instantly
    const cached = invoices.find((invoice) => invoice.id === id) || null;
    setContextNotice("");
    setSelectedInvoiceId(id);
    setDetailInvoice(cached);
    // then fetch real data over the network
    try {
      setDetailInvoice(await hydrateInvoice(id));
    } catch {
      if (cached) {
        setDetailInvoice(cached);
        setContextNotice("The full invoice details could not be loaded, so the available history preview is shown.");
      } else {
        closeInvoice();
        setContextNotice("This invoice is no longer available or you do not have permission to open it.");
      }
    }
  }

  // closing the detail modal also clears the last selected invoice so the next open starts fresh
  function closeInvoice() {
    setSelectedInvoiceId(null);
    setDetailInvoice(null);
  }

  async function openStockReceiveDetail(batchId: string) {
    setContextNotice("");
    setStockBatchDetail(null);
    setStockDetailError("");
    setStockDetailLoading(true);
    try {
      setStockBatchDetail(await getStockReceiveBatchApi(batchId));
    } catch (error: any) {
      setStockDetailError(
        error?.response?.data?.error ||
        error?.message ||
        "Failed to load stock receive details.",
      );
    } finally {
      setStockDetailLoading(false);
    }
  }

  function closeStockReceiveDetail() {
    setStockBatchDetail(null);
    setStockDetailError("");
    setStockDetailLoading(false);
  }

  function handleHistoryEventAction(event: HistoryEventRow) {
    if (!event.detailType || !event.detailId) return;

    setContextNotice("");

    if (event.detailType === "invoice") {
      void openInvoice(event.detailId);
      return;
    }

    if (event.detailType === "stockReceiveBatch") {
      void openStockReceiveDetail(event.detailId);
      return;
    }

    if (event.detailType === "importBatch") {
      navigate(`/products?importBatch=${encodeURIComponent(event.detailId)}`);
      return;
    }

    if (event.detailType === "document") {
      navigate(`/documents/${encodeURIComponent(event.detailId)}/view`);
      return;
    }
  }

  function openHistoryEventContext(event: HistoryEventRow) {
    if (event.detailType && event.detailId) {
      handleHistoryEventAction(event);
      return;
    }

    const sectionAction = getSectionAction(historyCategory, isAdminView);
    if (sectionAction) navigate(sectionAction.route);
  }

  const stockBatchRows = useMemo(() => {
    if (!stockBatchDetail) return [];
    const historyByProductId = new Map(
      (stockBatchDetail.historyItems || []).map((item) => [item.productId, item]),
    );

    return stockBatchDetail.transactions.map((tx) => {
      const historyItem = historyByProductId.get(tx.productId);
      return {
        id: tx.id,
        productName: historyItem?.productName || tx.product?.name || "Product",
        sku: historyItem?.sku || tx.product?.sku || "-",
        qty: Number(historyItem?.qty ?? tx.qtyDelta ?? 0),
        previousStock: historyItem?.previousStock,
        nextStock: historyItem?.nextStock,
        currentStock: tx.product?.stock,
      };
    });
  }, [stockBatchDetail]);

  const activeHistoryInfo = HISTORY_CATEGORY_INFO[historyCategory];

  function moveHistoryCategory(direction: -1 | 1) {
    const currentIndex = visibleHistoryCategories.findIndex(
      (category) => category.key === historyCategory,
    );
    const nextCategory = visibleHistoryCategories[currentIndex + direction];
    if (!nextCategory) return;
    setHistoryCategory(nextCategory.key);
    setPage(1);
  }

  const historySwipeGesture = useHorizontalGesture<HTMLDivElement>({
    enabled: !mobileFiltersOpen && !selectedInvoiceId && !stockBatchDetail,
    threshold: 72,
    edgeGuard: 24,
    allowMouse: true,
    maxViewportWidth: 1023,
    onMove: (offsetX) => {
      const direction: -1 | 1 = offsetX < 0 ? 1 : -1;
      const currentIndex = visibleHistoryCategories.findIndex(
        (category) => category.key === historyCategory,
      );
      if (!visibleHistoryCategories[currentIndex + direction]) {
        historyTabRailRef.current?.settle();
        return;
      }
      historyTabRailRef.current?.setGestureProgress(
        direction,
        Math.min(1, Math.abs(offsetX) / 140),
      );
    },
    onSwipeLeft: () => moveHistoryCategory(1),
    onSwipeRight: () => moveHistoryCategory(-1),
    onEnd: () => window.requestAnimationFrame(() => historyTabRailRef.current?.settle()),
  });

  const categoryTabs = (
    <div className="border-b border-slate-200 bg-white shadow-sm">
      <SwipeableTabRail
        items={visibleHistoryCategories.map((category) => ({
          value: category.key,
          label: category.label,
        }))}
        value={historyCategory}
        controllerRef={historyTabRailRef}
        onChange={(category) => {
          setHistoryCategory(category);
          setPage(1);
        }}
        ariaLabel="History categories"
        className="px-5 sm:px-7"
        railClassName="gap-6 sm:gap-8"
        buttonClassName="px-1 py-4 text-[14px] font-extrabold sm:text-[15px]"
        activeClassName="text-[#11120D]"
        inactiveClassName="text-slate-500 hover:text-slate-800"
      />
    </div>
  );

  // this handles when the invoice list is still loading on the first page visit
  if (loading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <div className="font-semibold text-slate-400">Loading history...</div>
      </div>
    );
  }

  if (historyCategory !== "sales") {
    const eventPageStart = eventTotal === 0 ? 0 : (page - 1) * pageSize;
    const eventPageEnd = eventTotal === 0 ? 0 : eventPageStart + eventRows.length;

    return (
      <div {...historySwipeGesture} className="-m-[12px] min-h-[calc(100dvh-72px)] bg-white text-slate-900 sm:-m-[20px] lg:-m-[24px]">
        {categoryTabs}

        <main className="px-4 py-5 sm:px-7 sm:py-7">
          <div className="text-[13px] font-bold text-[#8C8889]">
            {new Date().toLocaleDateString(undefined, {
              weekday: "long",
              day: "2-digit",
              month: "long",
              year: "numeric",
            })}
          </div>

          {contextNotice ? (
            <div className="mt-4 flex items-start justify-between gap-3 rounded-[14px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] font-semibold leading-5 text-amber-800">
              <div className="flex items-start gap-2">
                <Icon name="info" className="mt-[1px] text-[18px]" />
                <span>{contextNotice}</span>
              </div>
              <button
                type="button"
                onClick={() => setContextNotice("")}
                className="shrink-0 text-amber-700 hover:text-amber-950"
                aria-label="Dismiss message"
              >
                <Icon name="close" className="text-[16px]" />
              </button>
            </div>
          ) : null}


          <div className="mt-6 overflow-hidden rounded-[18px] border border-[#CFCFD3] bg-[#FFFFFF] shadow-sm">
            <div className="flex flex-col gap-3 border-b border-[#E5E7EB] p-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-[#64748B]">
                Browse {visibleHistoryCategories.find((item) => item.key === historyCategory)?.label || "records"}
              </div>
              <div className="flex w-full gap-2 lg:w-[520px]">
                <div className="relative min-w-0 flex-1">
                <Icon
                  name="search"
                  className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#8C8889]"
                />
                <input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setPage(1);
                  }}
                  placeholder="Search action, entity, actor..."
                  className="h-[42px] w-full rounded-[12px] border border-[#CFCFD3] bg-[#FFFFFF] pl-[44px] pr-4 text-[13px] font-semibold text-[#000000] outline-none placeholder:text-[#8C8889] focus:border-[#11120d]"
                />
                </div>
                <MobileFilterButton activeCount={fromDate || toDate ? 1 : 0} onClick={openMobileFilters} className="lg:hidden" />
              </div>
              <ActiveFilterChips items={mobileFilterChips.filter((chip) => chip.id === "dates")} className="lg:hidden" />
            </div>

            <div className="hidden grid-cols-1 gap-3 bg-[#FAFBFC] p-4 lg:grid-cols-[minmax(160px,1fr)_minmax(160px,1fr)_auto] lg:items-end lg:grid">
              <label className="space-y-2">
                <div className="text-[10px] font-extrabold uppercase tracking-[0.07em] text-[#64748B]">
                  From date
                </div>
                <ProjectDateInput
                  value={fromDate}
                  max={toDate || undefined}
                  onChange={(event) => {
                    setFromDate(event.target.value);
                    setPage(1);
                  }}
                  className="h-[42px] w-full rounded-[12px] border border-[#CFCFD3] bg-[#FFFFFF] px-3 text-[13px] font-bold text-[#000000] outline-none focus:border-[#11120d]"
                />
              </label>

              <label className="space-y-2">
                <div className="text-[10px] font-extrabold uppercase tracking-[0.07em] text-[#64748B]">
                  To date
                </div>
                <ProjectDateInput
                  value={toDate}
                  min={fromDate || undefined}
                  onChange={(event) => {
                    setToDate(event.target.value);
                    setPage(1);
                  }}
                  className="h-[42px] w-full rounded-[12px] border border-[#CFCFD3] bg-[#FFFFFF] px-3 text-[13px] font-bold text-[#000000] outline-none focus:border-[#11120d]"
                />
              </label>

              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setFromDate("");
                  setToDate("");
                  setPage(1);
                }}
                className="h-[42px] rounded-[12px] border border-[#CFCFD3] bg-white px-4 text-[12px] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6] hover:text-[#000000]"
              >
                Clear filters
              </button>
            </div>
          </div>

          <div className="mt-5 overflow-hidden rounded-[18px] border border-[#DADDE3] bg-white shadow-sm">
            <div className="hidden grid-cols-[minmax(0,1.35fr)_minmax(260px,0.95fr)_minmax(180px,0.55fr)_150px] border-b border-[#DADDE3] bg-[#F8FAFC] px-5 py-3 text-left text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#64748B] lg:grid">
              <div>Activity</div>
              <div>Business detail</div>
              <div>Actor / Time</div>
              <div className="text-right">Context</div>
            </div>

            {eventLoading ? (
              <div className="flex h-[260px] items-center justify-center text-sm font-semibold text-slate-400">
                Loading history...
              </div>
            ) : eventRows.length === 0 ? (
              <div className="flex h-[260px] flex-col items-center justify-center text-center text-slate-400">
                <Icon name="history" className="text-[36px]" />
                <div className="mt-3 text-[14px] font-semibold">
                  No category history found.
                </div>
              </div>
            ) : (
              eventRows.map((event) => {
                const highlights = getEventHighlights(event, historyCategory);
                const sectionAction = getSectionAction(historyCategory, isAdminView);
                const canOpen = Boolean(event.detailType && event.detailId) || Boolean(sectionAction);
                const actionLabel =
                  event.actionLabel || sectionAction?.label || "Open context";

                return (
                  <div
                    key={event.id}
                    className="border-b border-[#E5E7EB] px-4 py-4 transition-colors last:border-b-0 hover:bg-[#ECEFF3] lg:grid lg:grid-cols-[minmax(0,1.35fr)_minmax(260px,0.95fr)_minmax(180px,0.55fr)_150px] lg:items-center lg:gap-4 lg:px-5"
                  >
                    <div className="flex min-w-0 gap-3">
                      <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-[#F3F4F6] text-[#11120d]">
                        <Icon
                          name={getEventIcon(historyCategory, event)}
                          className="text-[20px]"
                        />
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="min-w-0 truncate text-[14px] font-extrabold text-slate-900">
                            {event.title || humanizeAction(event.action)}
                          </div>
                          <span
                            className={cn(
                              "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-extrabold uppercase",
                              getEventActionTone(event),
                            )}
                          >
                            {humanizeAction(event.action)}
                          </span>
                        </div>
                        <div className="mt-1 line-clamp-2 text-[12px] font-semibold leading-5 text-slate-500">
                          {event.description || event.id}
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2 lg:mt-0">
                      {highlights.map((item) => (
                        <div
                          key={`${event.id}-${item.label}-${item.value}`}
                          className="rounded-[10px] border border-[#E5E7EB] bg-[#FFFFFF] px-3 py-2"
                        >
                          <div className="text-[10px] font-extrabold uppercase tracking-[0.06em] text-[#8C8889]">
                            {item.label}
                          </div>
                          <div
                            className={cn(
                              "mt-0.5 max-w-[220px] truncate text-[12px] font-extrabold text-[#000000]",
                              item.tone,
                            )}
                          >
                            {item.value}
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="mt-3 min-w-0 text-[13px] font-semibold text-slate-700 lg:mt-0">
                      <div className="truncate font-extrabold text-[#000000]">
                        {event.actor?.name || "System"}
                      </div>
                      <div className="mt-1 truncate text-[12px] text-slate-500">
                        {formatEventTime(event.createdAt)}
                      </div>
                    </div>

                    <div className="mt-3 flex justify-start lg:mt-0 lg:justify-end">
                      {canOpen ? (
                        <button
                          type="button"
                          onClick={() => openHistoryEventContext(event)}
                          className="inline-flex h-[36px] items-center justify-center gap-2 rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-extrabold text-[#565449] transition hover:bg-[#11120d] hover:text-white"
                        >
                          <Icon name="open_in_new" className="text-[15px]" />
                          {actionLabel}
                        </button>
                      ) : (
                        <span className="inline-flex h-[32px] items-center rounded-[10px] border border-[#E5E7EB] bg-[#F8FAFC] px-3 text-[11px] font-extrabold text-slate-400">
                          No linked record
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}

            <PaginationBar
              page={clampPage(page, 1, eventTotalPages)}
              totalPages={eventTotalPages}
              total={eventTotal}
              start={eventPageStart}
              end={eventPageEnd}
              label="history records"
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPageSize(nextPageSize);
                setPage(1);
              }}
              className="border-t border-[#E5E7EB]"
            />
          </div>
        </main>

        <MobileFilterSheet
          open={mobileFiltersOpen}
          onClose={() => setMobileFiltersOpen(false)}
          onClear={() => { setDraftFromDate(""); setDraftToDate(""); }}
          onApply={() => { setFromDate(draftFromDate); setToDate(draftToDate); setPage(1); setMobileFiltersOpen(false); }}
        >
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-2"><span className="text-[13px] font-bold">From date</span><ProjectDateInput value={draftFromDate} max={draftToDate || undefined} onChange={(event) => setDraftFromDate(event.target.value)} /></label>
            <label className="space-y-2"><span className="text-[13px] font-bold">To date</span><ProjectDateInput value={draftToDate} min={draftFromDate || undefined} onChange={(event) => setDraftToDate(event.target.value)} /></label>
          </div>
        </MobileFilterSheet>

        <ModalFrame
          open={stockDetailLoading || !!stockBatchDetail || !!stockDetailError}
          title="Stock Receive Detail"
          description={
            stockBatchDetail
              ? `${stockBatchDetail.supplierName} - ${formatEventTime(stockBatchDetail.createdAt)}`
              : "Loading stock receive details"
          }
          onClose={closeStockReceiveDetail}
          maxWidthClass="max-w-[860px]"
          footer={
            <DialogButton onClick={closeStockReceiveDetail}>Close</DialogButton>
          }
        >
          {stockDetailLoading ? (
            <div className="flex h-[180px] items-center justify-center text-[13px] font-semibold text-slate-500">
              Loading stock receive details...
            </div>
          ) : stockDetailError ? (
            <div className="rounded-[14px] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] font-bold text-rose-700">
              {stockDetailError}
            </div>
          ) : stockBatchDetail ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                <div className="rounded-[14px] border border-[#E5E7EB] p-3">
                  <div className="text-[11px] font-extrabold uppercase text-slate-500">
                    Supplier
                  </div>
                  <div className="mt-1 truncate text-[13px] font-extrabold text-slate-900">
                    {stockBatchDetail.supplierName}
                  </div>
                </div>
                <div className="rounded-[14px] border border-[#E5E7EB] p-3">
                  <div className="text-[11px] font-extrabold uppercase text-slate-500">
                    Bill
                  </div>
                  <div className="mt-1 truncate text-[13px] font-extrabold text-slate-900">
                    {stockBatchDetail.billNumber || "-"}
                  </div>
                </div>
                <div className="rounded-[14px] border border-[#E5E7EB] p-3">
                  <div className="text-[11px] font-extrabold uppercase text-slate-500">
                    Amount
                  </div>
                  <div className="mt-1 text-[13px] font-extrabold text-slate-900">
                    {stockBatchDetail.billAmount ? formatNpr(stockBatchDetail.billAmount) : "-"}
                  </div>
                </div>
                <div className="rounded-[14px] border border-[#E5E7EB] p-3">
                  <div className="text-[11px] font-extrabold uppercase text-slate-500">
                    Received by
                  </div>
                  <div className="mt-1 truncate text-[13px] font-extrabold text-slate-900">
                    {stockBatchDetail.createdBy?.name || "Unknown"}
                  </div>
                </div>
              </div>

              <div className="overflow-hidden rounded-[16px] border border-[#E5E7EB]">
                <div className="grid grid-cols-[minmax(0,1fr)_90px_110px_110px_110px] gap-3 bg-slate-50 px-4 py-3 text-[11px] font-extrabold uppercase text-slate-500">
                  <div>Product</div>
                  <div className="text-right">Qty</div>
                  <div className="text-right">Before</div>
                  <div className="text-right">After</div>
                  <div className="text-right">Current</div>
                </div>
                {stockBatchRows.map((row) => (
                  <div
                    key={row.id}
                    className="grid grid-cols-[minmax(0,1fr)_90px_110px_110px_110px] gap-3 border-t border-[#E5E7EB] px-4 py-3 text-[13px]"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-extrabold text-slate-900">
                        {row.productName}
                      </div>
                      <div className="mt-1 truncate text-[12px] font-semibold text-slate-500">
                        {row.sku}
                      </div>
                    </div>
                    <div className="text-right font-mono font-extrabold text-slate-900">
                      {row.qty}
                    </div>
                    <div className="text-right font-mono font-semibold text-slate-700">
                      {row.previousStock ?? "-"}
                    </div>
                    <div className="text-right font-mono font-semibold text-slate-700">
                      {row.nextStock ?? "-"}
                    </div>
                    <div className="text-right font-mono font-semibold text-slate-700">
                      {row.currentStock ?? "-"}
                    </div>
                  </div>
                ))}
              </div>

              {stockBatchDetail.remarks ? (
                <div className="rounded-[14px] border border-[#E5E7EB] bg-slate-50 px-4 py-3 text-[13px] font-semibold text-slate-600">
                  {stockBatchDetail.remarks}
                </div>
              ) : null}
            </div>
          ) : null}
        </ModalFrame>
      </div>
    );
  }

  return (
    <div {...historySwipeGesture} className="-m-[12px] min-h-[calc(100dvh-72px)] bg-white text-slate-900 sm:-m-[20px] lg:-m-[24px]">
      {categoryTabs}

      <main className="px-4 py-5 sm:px-7 sm:py-7">
        <div className="text-[13px] font-bold text-[#8C8889]">
          {new Date().toLocaleDateString(undefined, {
            weekday: "long",
            day: "2-digit",
            month: "long",
            year: "numeric",
          })}
        </div>

        {contextNotice ? (
          <div className="mt-4 flex items-start justify-between gap-3 rounded-[14px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] font-semibold leading-5 text-amber-800">
            <div className="flex items-start gap-2">
              <Icon name="info" className="mt-[1px] text-[18px]" />
              <span>{contextNotice}</span>
            </div>
            <button
              type="button"
              onClick={() => setContextNotice("")}
              className="shrink-0 text-amber-700 hover:text-amber-950"
              aria-label="Dismiss message"
            >
              <Icon name="close" className="text-[16px]" />
            </button>
          </div>
        ) : null}


        {/* these summary cards mirror the invoice page card rhythm so totals are fast to scan before filtering records */}
        <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3">
          {[
            {
              label: "Net Total",
              value: formatNpr(totalSales),
              icon: "monitoring",
              tone: "text-[#2F67D8]",
              sub: "Excluding cancelled",
            },
            {
              label: "Paid",
              value: formatNpr(totalPaid),
              icon: "payments",
              tone: "text-[#179B4D]",
              sub: "Collected amount",
            },
            {
              label: "Due",
              value: formatNpr(totalDue),
              icon: "account_balance_wallet",
              tone: "text-rose-700",
              sub: "Still receivable",
            },
            {
              label: "Records",
              value: invoiceTotal,
              icon: "receipt_long",
              tone: "text-[#11120d]",
              sub: `${pageStart}-${pageEnd} visible`,
            },
            {
              label: "Walk-in Records",
              value: walkInRecordCount,
              icon: "person",
              tone: "text-slate-600",
              sub: "No registered customer",
            },
            {
              label: "eSewa Records",
              value: esewaRecordCount,
              icon: "account_balance",
              tone: "text-[#179B4D]",
              sub: "Digital payments",
            },

          ].map((card) => (
            <div
              key={card.label}
              className="min-h-[108px] rounded-[16px] border border-[#DADDE3] bg-[#FFFFFF] p-4 shadow-sm [container-type:inline-size]"
            >
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <div
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-[#F3F4F6]",
                    card.tone,
                  )}
                >
                  <Icon name={card.icon} className="text-[16px]" />
                </div>
                <div className="min-w-0 flex-1 truncate text-[10px] font-extrabold uppercase leading-snug tracking-[0.08em] text-[#64748B]">
                  {card.label}
                </div>
              </div>
              <div
                className="mt-3 truncate font-mono text-[clamp(20px,12cqi,32px)] font-extrabold leading-none tracking-tight text-[#000000]"
                title={String(card.value)}
              >
                {card.value}
              </div>
            </div>
              <div className="mt-2 truncate text-[11px] font-semibold text-[#8C8889]">
                {card.sub}
              </div>
            </div>
          ))}
        </div>

        {/* this filter card groups tabs, search, and extra filters into one compact browsing surface */}
        <div className="mt-6 overflow-hidden rounded-[18px] border border-[#CFCFD3] bg-[#FFFFFF] shadow-sm">
          <div className="flex flex-col gap-3 border-b border-[#E5E7EB] p-4 xl:flex-row xl:items-center xl:justify-between">
            <div className="min-w-0">
              <div className="mb-2 text-[11px] font-extrabold uppercase tracking-[0.08em] text-[#64748B]">
                Browse records
              </div>
              <MobileFilterTabs
                className="lg:hidden"
                ariaLabel="History status"
                value={activeTab}
                onChange={(tab) => { setActiveTab(tab); setPage(1); }}
                items={(['All', 'Paid', 'Partial', 'Unpaid', 'Cancelled'] as const).map((tab) => ({ value: tab, label: tab }))}
              />
              <div className="hidden max-w-full gap-1 overflow-x-auto rounded-[14px] bg-[#F3F5F8] p-1 lg:inline-flex">
                {(["All", "Paid", "Partial", "Unpaid", "Cancelled"] as const).map(
                  (tab) => {
                    const active = tab === activeTab;
                    return (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => {
                          setActiveTab(tab);
                          setPage(1);
                        }}
                        className={cn(
                          "h-[34px] shrink-0 rounded-[10px] px-4 text-[12px] font-extrabold transition",
                          active
                            ? "bg-[#11120d] text-white shadow-sm"
                            : "text-[#565449] hover:bg-[#FFFFFF]",
                        )}
                      >
                        {tab}
                      </button>
                    );
                  },
                )}
              </div>
            </div>

            <div className="flex w-full gap-2 xl:w-[500px] xl:min-w-[500px]">
              <div className="relative min-w-0 flex-1">
                <Icon name="search" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#8C8889]" />
                <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search invoice, customer, cashier, reference..." className="h-[42px] w-full rounded-[12px] border border-[#CFCFD3] bg-[#FFFFFF] pl-[44px] pr-4 text-[13px] font-semibold text-[#000000] outline-none placeholder:text-[#8C8889] focus:border-[#11120d]" />
              </div>
              <MobileFilterButton activeCount={mobileFilterCount} onClick={openMobileFilters} className="lg:hidden" />
            </div>
            <ActiveFilterChips items={mobileFilterChips} className="lg:hidden" />
          </div>

          <div className="hidden bg-[#FAFBFC] p-4 lg:block">
            <div
              className={cn(
                "grid grid-cols-1 gap-3 md:grid-cols-2 xl:items-end",
                isAdminView
                  ? "xl:grid-cols-[minmax(140px,0.8fr)_minmax(140px,0.8fr)_minmax(170px,1fr)_minmax(170px,1fr)_minmax(190px,1fr)_auto]"
                  : "xl:grid-cols-[minmax(140px,0.9fr)_minmax(140px,0.9fr)_minmax(170px,1fr)_minmax(190px,1fr)_auto]",
              )}
            >
              <label className="space-y-2">
                <div className="text-[10px] font-extrabold uppercase tracking-[0.07em] text-[#64748B]">
                  From date
                </div>
                <ProjectDateInput
                  value={fromDate}
                  max={toDate || undefined}
                  onChange={(event) => {
                    setFromDate(event.target.value);
                    setPage(1);
                  }}
                  className="h-[42px] w-full rounded-[12px] border border-[#CFCFD3] bg-[#FFFFFF] px-3 text-[13px] font-bold text-[#000000] outline-none focus:border-[#11120d]"
                />
              </label>

              <label className="space-y-2">
                <div className="text-[10px] font-extrabold uppercase tracking-[0.07em] text-[#64748B]">
                  To date
                </div>
                <ProjectDateInput
                  value={toDate}
                  min={fromDate || undefined}
                  onChange={(event) => {
                    setToDate(event.target.value);
                    setPage(1);
                  }}
                  className="h-[42px] w-full rounded-[12px] border border-[#CFCFD3] bg-[#FFFFFF] px-3 text-[13px] font-bold text-[#000000] outline-none focus:border-[#11120d]"
                />
              </label>

              {isAdminView ? (
                <label className="space-y-2">
                  <div className="text-[10px] font-extrabold uppercase tracking-[0.07em] text-[#64748B]">
                    Cashier
                  </div>
                  <ProjectSelect
                    value={cashierFilter}
                    onChange={(event) => {
                      setCashierFilter(event.target.value);
                      setPage(1);
                    }}
                    className="h-[42px] w-full rounded-[12px] border border-[#CFCFD3] bg-[#FFFFFF] px-3 text-[13px] font-bold text-[#000000] outline-none focus:border-[#11120d]"
                  >
                    <option value="All">All cashiers</option>
                    {cashierOptions.map((cashier) => (
                      <option key={cashier.id} value={cashier.id}>
                        {cashier.name}
                      </option>
                    ))}
                  </ProjectSelect>
                </label>
              ) : null}

              <label className="space-y-2">
                <div className="text-[10px] font-extrabold uppercase tracking-[0.07em] text-[#64748B]">
                  Customer type
                </div>
                <ProjectSelect
                  value={customerTypeFilter}
                  onChange={(event) => {
                    setCustomerTypeFilter(
                      event.target.value as HistoryCustomerTypeFilter,
                    );
                    setPage(1);
                  }}
                  className="h-[42px] w-full rounded-[12px] border border-[#CFCFD3] bg-[#FFFFFF] px-3 text-[13px] font-bold text-[#000000] outline-none focus:border-[#11120d]"
                >
                  <option value="All">All customers</option>
                  <option value="Walk-in">Walk-in</option>
                  <option value="Registered">Registered</option>
                </ProjectSelect>
              </label>

              <label className="space-y-2">
                <div className="text-[10px] font-extrabold uppercase tracking-[0.07em] text-[#64748B]">
                  Payment method
                </div>
                <ProjectSelect
                  value={methodFilter}
                  onChange={(event) => {
                    setMethodFilter(
                      event.target.value as "All" | AppInvoice["paymentMethod"],
                    );
                    setPage(1);
                  }}
                  className="h-[42px] w-full rounded-[12px] border border-[#CFCFD3] bg-[#FFFFFF] px-3 text-[13px] font-bold text-[#000000] outline-none focus:border-[#11120d]"
                >
                  <option value="All">All methods</option>
                  <option value="Cash">Cash</option>
                  <option value="eSewa">eSewa</option>
                  <option value="Fonepay">Fonepay</option>
                  <option value="Bank Transfer">Bank Transfer</option>
                  <option value="Mixed">Mixed</option>
                  <option value="None">None</option>
                </ProjectSelect>
              </label>

              <button
                type="button"
                onClick={clearExtraFilters}
                disabled={!hasExtraFilters}
                className={cn(
                  "h-[42px] rounded-[12px] border px-4 text-[12px] font-extrabold whitespace-nowrap transition",
                  hasExtraFilters
                    ? "border-[#CFCFD3] bg-[#FFFFFF] text-[#565449] hover:bg-[#F3F4F6] hover:text-[#000000]"
                    : "cursor-not-allowed border-[#E5E7EB] bg-[#F8FAFC] text-[#94A3B8]",
                )}
              >
                Clear filters
              </button>
            </div>
          </div>
        </div>

        <MobileFilterSheet
          open={mobileFiltersOpen}
          onClose={() => setMobileFiltersOpen(false)}
          onClear={() => { setDraftFromDate(""); setDraftToDate(""); setDraftCashierFilter("All"); setDraftCustomerTypeFilter("All"); setDraftMethodFilter("All"); }}
          onApply={applyMobileFilters}
        >
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-2"><span className="text-[13px] font-bold">From date</span><ProjectDateInput value={draftFromDate} max={draftToDate || undefined} onChange={(event) => setDraftFromDate(event.target.value)} /></label>
              <label className="space-y-2"><span className="text-[13px] font-bold">To date</span><ProjectDateInput value={draftToDate} min={draftFromDate || undefined} onChange={(event) => setDraftToDate(event.target.value)} /></label>
            </div>
            {isAdminView ? <label className="block space-y-2"><span className="text-[13px] font-bold">Cashier</span><ProjectSelect value={draftCashierFilter} onChange={(event) => setDraftCashierFilter(event.target.value)}><option value="All">All cashiers</option>{cashierOptions.map((cashier) => <option key={cashier.id} value={cashier.id}>{cashier.name}</option>)}</ProjectSelect></label> : null}
            <label className="block space-y-2"><span className="text-[13px] font-bold">Customer type</span><ProjectSelect value={draftCustomerTypeFilter} onChange={(event) => setDraftCustomerTypeFilter(event.target.value as HistoryCustomerTypeFilter)}><option value="All">All customers</option><option value="Walk-in">Walk-in</option><option value="Registered">Registered</option></ProjectSelect></label>
            <label className="block space-y-2"><span className="text-[13px] font-bold">Payment method</span><ProjectSelect value={draftMethodFilter} onChange={(event) => setDraftMethodFilter(event.target.value as "All" | AppInvoice["paymentMethod"])}><option value="All">All methods</option><option value="Cash">Cash</option><option value="eSewa">eSewa</option><option value="Fonepay">Fonepay</option><option value="Bank Transfer">Bank Transfer</option><option value="Mixed">Mixed</option><option value="None">None</option></ProjectSelect></label>
          </div>
        </MobileFilterSheet>

        <div className="mt-5 overflow-hidden rounded-[18px] border border-[#DADDE3] bg-[#FFFFFF] shadow-sm">
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full min-w-[1200px]">
              <thead>
                <tr className="border-b border-[#DADDE3] bg-[#F8FAFC] text-left text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                  <th className="px-4 py-3">Invoice</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Method</th>
                  <th className="px-4 py-3">Reference</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3 text-right">Paid</th>
                  <th className="px-4 py-3 text-right">Due</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>

              <tbody>
                {pageItems.map((invoice) => {
                  const reference = getInvoiceReference(invoice);

                  return (
                    <tr
                      key={invoice.id}
                      className="border-b border-[#E5E7EB] align-top transition-colors last:border-0 hover:bg-[#ECEFF3]"
                    >
                      <td className="px-4 py-3">
                        <div className="font-mono text-[13px] font-extrabold text-slate-900">
                          {invoice.invoiceNo}
                        </div>
                        <div className="mt-1 text-[12px] text-slate-500">
                          {invoice.itemSummary}
                        </div>
                      </td>

                      <td className="px-4 py-3">
                        <div className="text-[13px] font-extrabold text-slate-900">
                          {invoice.customerName}
                        </div>
                        <div className="mt-1 text-[12px] text-slate-500">
                          {invoice.customerSubtitle}
                        </div>
                      </td>

                      <td className="px-4 py-3">
                        <div className="text-[13px] font-semibold text-slate-900">
                          {invoice.createdDateLabel}
                        </div>
                        <div className="mt-1 text-[12px] text-slate-500">
                          {invoice.createdTimeLabel}
                        </div>
                      </td>

                      <td className="px-4 py-3">
                        <div>
                          <PaymentMethodChip method={invoice.paymentMethod} />
                        </div>
                        <div className="mt-1 text-[12px] text-slate-500">
                          Cashier: {invoice.cashierName}
                        </div>
                      </td>

                      <td className="px-4 py-3 text-[13px] font-semibold text-slate-700">
                        {reference || "-"}
                      </td>

                      <td className="px-4 py-3 text-right font-mono text-[13px] font-extrabold text-slate-900">
                        {formatNpr(invoice.netTotal)}
                      </td>

                      <td className="px-4 py-3 text-right font-mono text-[13px] font-extrabold text-slate-900">
                        {formatNpr(invoice.paidAmount)}
                      </td>

                      <td className="px-4 py-3 text-right font-mono text-[13px] font-extrabold text-slate-900">
                        {formatNpr(invoice.dueAmount)}
                      </td>

                      <td className="px-4 py-3">
                        <div className="space-y-1">
                          <InvoiceStatusChip status={invoice.status} />
                          {invoice.status === "Cancelled" &&
                            invoice.cancelledByName ? (
                            <div className="text-[11px] font-semibold text-slate-500">
                              Cancelled by {invoice.cancelledByName}
                              {invoice.cancelledByRole
                                ? ` (${invoice.cancelledByRole})`
                                : ""}
                            </div>
                          ) : null}
                        </div>
                      </td>

                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => openInvoice(invoice.id)}
                            className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-white text-[#565449] transition hover:bg-[#11120d] hover:text-white"
                            aria-label="View invoice"
                          >
                            <Icon name="visibility" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {pageItems.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-5 py-16 text-center">
                      <div className="flex flex-col items-center justify-center text-slate-400">
                        <Icon name="search_off" className="text-[36px]" />
                        <div className="mt-3 text-[14px] font-semibold">
                          No invoice history found for the selected filters.
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="space-y-3 p-3 lg:hidden">
            {pageItems.map((invoice) => {
              const reference = getInvoiceReference(invoice);

              return (
                <article
                  key={invoice.id}
                  className="min-w-0 rounded-[16px] border border-[#DADDE3] bg-[#FFFFFF] p-4 shadow-sm"
                >
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="break-all font-mono text-[14px] font-extrabold leading-5 text-[#000000]">
                        {invoice.invoiceNo}
                      </div>
                      <div className="mt-1 text-[12px] font-semibold leading-5 text-[#8C8889]">
                        {invoice.createdDateLabel} | {invoice.createdTimeLabel}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="whitespace-nowrap font-mono text-[16px] font-extrabold text-[#000000]">
                        {formatNpr(invoice.netTotal)}
                      </div>
                      <div className="mt-1 text-[10px] font-extrabold uppercase tracking-[0.06em] text-[#8C8889]">
                        Total
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 min-w-0 border-t border-[#E5E7EB] pt-3">
                    <div className="break-words text-[14px] font-extrabold leading-5 text-[#000000]">
                      {invoice.customerName}
                    </div>
                    <div className="mt-1 break-words text-[12px] font-semibold leading-5 text-[#8C8889]">
                      {invoice.customerSubtitle} | Cashier: {invoice.cashierName}
                    </div>
                  </div>

                  <div className="mt-3 break-words rounded-[12px] border border-[#E5E7EB] bg-[#F8FAFC] px-3 py-2 text-[13px] font-bold leading-5 text-[#565449]">
                    {invoice.itemSummary}
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <div className="min-w-0 rounded-[11px] border border-[#E5E7EB] bg-[#FFFFFF] px-3 py-2">
                      <div className="text-[10px] font-extrabold uppercase tracking-[0.06em] text-[#8C8889]">
                        Paid
                      </div>
                      <div className="mt-1 truncate font-mono text-[13px] font-extrabold text-[#000000]">
                        {formatNpr(invoice.paidAmount)}
                      </div>
                    </div>
                    <div className="min-w-0 rounded-[11px] border border-[#E5E7EB] bg-[#FFFFFF] px-3 py-2">
                      <div className="text-[10px] font-extrabold uppercase tracking-[0.06em] text-[#8C8889]">
                        Due
                      </div>
                      <div
                        className={cn(
                          "mt-1 truncate font-mono text-[13px] font-extrabold",
                          invoice.dueAmount > 0 && invoice.status !== "Cancelled"
                            ? "text-rose-700"
                            : "text-[#000000]",
                        )}
                      >
                        {formatNpr(invoice.dueAmount)}
                      </div>
                    </div>
                  </div>

                  {reference ? (
                    <div className="mt-3 min-w-0 rounded-[11px] border border-[#E5E7EB] bg-[#FFFFFF] px-3 py-2">
                      <div className="text-[10px] font-extrabold uppercase tracking-[0.06em] text-[#8C8889]">
                        Reference
                      </div>
                      <div className="mt-1 break-all text-[12px] font-bold leading-5 text-[#565449]">
                        {reference}
                      </div>
                    </div>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <InvoiceStatusChip status={invoice.status} />
                      <PaymentMethodChip
                        method={invoice.paymentMethod}
                        showIcon
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => openInvoice(invoice.id)}
                      className="flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-[10px] border border-[#CFCFD3] bg-[#FFFFFF] px-3 text-[12px] font-extrabold text-[#565449] transition active:bg-[#F3F4F6]"
                      aria-label={`View invoice ${invoice.invoiceNo}`}
                    >
                      <Icon name="visibility" className="text-[17px]" />
                      <span>View</span>
                    </button>
                  </div>

                  {invoice.status === "Cancelled" &&
                  invoice.cancelledByName ? (
                    <div className="mt-3 break-words border-t border-[#E5E7EB] pt-3 text-[11px] font-semibold leading-5 text-slate-500">
                      Cancelled by {invoice.cancelledByName}
                      {invoice.cancelledByRole
                        ? ` (${invoice.cancelledByRole})`
                        : ""}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>

          {pageItems.length === 0 ? (
            <div className="flex min-h-[160px] items-center justify-center px-4 py-10 text-center lg:hidden">
              <div className="flex flex-col items-center justify-center text-slate-400">
                <Icon name="search_off" className="text-[36px]" />
                <div className="mt-3 text-[14px] font-semibold">
                  No invoice history found for the selected filters.
                </div>
              </div>
            </div>
          ) : null}

          <PaginationBar
            page={pageClamped}
            totalPages={totalPages}
            total={invoiceTotal}
            start={pageStart}
            end={pageEnd}
            label="history records"
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(nextPageSize) => {
              setPageSize(nextPageSize);
              setPage(1);
            }}
            className="border-t border-[#E5E7EB]"
          />
        </div>
      </main>

      <InvoiceDetailModal
        open={!!selectedInvoiceId}
        invoice={detailInvoice}
        onClose={closeInvoice}
      />
    </div>
  );
}
