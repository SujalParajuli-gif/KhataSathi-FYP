import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  InvoiceStatusChip,
  PaymentMethodChip,
} from "~/components/invoices/InvoiceChips";
import InvoiceDetailModal from "~/components/invoices/InvoiceDetailModal";
import Icon from "~/components/ui/Icon";
import { DialogButton, ModalFrame } from "~/components/ui/Modal";
import PaginationBar from "~/components/ui/PaginationBar";
import { getAuthUser } from "~/lib/auth";
import {
  getInvoiceApi,
  getStockReceiveBatchApi,
  listCategorizedHistoryApi,
  listInvoicesApi,
  type StockReceiveBatchDetail,
} from "~/lib/api/endpoints";
import type { AppInvoice, InvoiceStatusLabel } from "~/lib/invoices";
import {
  formatNpr,
  getInvoiceReference,
  normalizeInvoice,
} from "~/lib/invoices";

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

async function fetchAllInvoices(filters?: Record<string, unknown>) {
  const pageSize = 200;
  let page = 1;
  let total = 0;
  const collected: any[] = [];

  do {
    const data = await listInvoicesApi({ ...filters, page, pageSize });
    const batch = Array.isArray(data?.invoices) ? data.invoices : [];
    collected.push(...batch);
    total = Number(data?.total ?? collected.length);
    page += 1;
    if (batch.length === 0) break;
  } while (collected.length < total);

  return collected.map(normalizeInvoice);
}

// reusing the same walk-in vs registered rule keeps filtering consistent with the invoice page
function getInvoiceCustomerType(invoice: Pick<AppInvoice, "customerId">) {
  return invoice.customerId ? "Registered" : "Walk-in";
}

type HistoryCustomerTypeFilter = "All" | "Walk-in" | "Registered";
type HistoryCategory =
  | "sales"
  | "product"
  | "stock"
  | "import"
  | "document"
  | "return"
  | "payment"
  | "system";

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

// this handles the "Invoice History" page 
// where admins and cashiers can browse, filter, search, and review all past invoices in the system
export default function HistoryPage() {
  const authUser = getAuthUser();
  const navigate = useNavigate();
  const isAdminView = authUser?.role === "admin";
  const [invoices, setInvoices] = useState<AppInvoice[]>([]); // stores the normalized invoice list used by all filters and summary cards
  const [loading, setLoading] = useState(true); // tracks whether the initial data fetch is still running
  const [historyCategory, setHistoryCategory] = useState<HistoryCategory>("sales");
  const [eventRows, setEventRows] = useState<HistoryEventRow[]>([]);
  const [eventLoading, setEventLoading] = useState(false);
  const [eventTotal, setEventTotal] = useState(0);
  const [eventTotalPages, setEventTotalPages] = useState(1);
  const [stockBatchDetail, setStockBatchDetail] = useState<StockReceiveBatchDetail | null>(null);
  const [stockDetailLoading, setStockDetailLoading] = useState(false);
  const [stockDetailError, setStockDetailError] = useState("");
  const [query, setQuery] = useState(""); // free text search across invoice number, customer, cashier, items, and reference
  const [activeTab, setActiveTab] = useState<"All" | InvoiceStatusLabel>("All"); // main status tab selection
  const [fromDate, setFromDate] = useState(""); // lower date boundary from the filter controls
  const [toDate, setToDate] = useState(""); // upper date boundary from the filter controls
  const [cashierFilter, setCashierFilter] = useState("All"); // admin-facing cashier selector for narrowing history records to one cashier
  const [customerTypeFilter, setCustomerTypeFilter] =
    useState<HistoryCustomerTypeFilter>("All"); // lets admins combine customer type and cashier filters together
  const [methodFilter, setMethodFilter] = useState<
    "All" | AppInvoice["paymentMethod"]
  >("All"); // payment method filter from the dropdown
  const [page, setPage] = useState(1); // current page inside the filtered results list
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(
    null,
  );
  const [detailInvoice, setDetailInvoice] = useState<AppInvoice | null>(null); // invoice shown inside the detail modal

  // fetching all invoices
  // we do this once so we can easily filter, sort, and search on the client side without needing constant loading states
  async function loadInvoices() {
    setInvoices(await fetchAllInvoices());
  }

  // we use this helper to fetch one invoice with its full detail data right before opening the modal
  async function hydrateInvoice(id: string) {
    const data = await getInvoiceApi(id);
    return normalizeInvoice(data);
  }

  useEffect(() => {
    // loading the first invoice batch when the history page opens
    async function load() {
      try {
        await loadInvoices();
      } catch {
        // this handles when the list request fails, so we fall back to an empty table instead of leaving stale data on screen
        setInvoices([]);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  // deriving cashier options from the loaded invoices avoids extra requests while keeping labels accurate
  const cashierOptions = useMemo(() => {
    const options = new Map<string, string>();

    invoices.forEach((invoice) => {
      if (!invoice.cashierId) return;
      if (!options.has(invoice.cashierId)) {
        options.set(invoice.cashierId, invoice.cashierName);
      }
    });

    return Array.from(options.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [invoices]);

  // filtering the full list of invoices based on the search query, date boundaries, status tab, and payment method selected
  // we wrap this in useMemo so it only recalculates when one of those pieces of state actually changes
  const filtered = useMemo(() => {
    const loweredQuery = query.trim().toLowerCase(); // normalizing search once so we do not repeat trim/lowercase work inside each filter callback
    const fromBoundary = buildLocalDateBoundary(fromDate); // turning the from date into a real Date object for timestamp comparisons
    const toBoundary = buildLocalDateBoundary(toDate, true); // end-of-day mode keeps the selected "to" date fully inclusive

    return invoices
      // filtering by status first because it usually removes the biggest chunk of rows
      .filter((invoice) =>
        activeTab === "All" ? true : invoice.status === activeTab,
      )
      .filter((invoice) =>
        isAdminView
          ? cashierFilter === "All"
            ? true
            : invoice.cashierId === cashierFilter
          : true,
      )
      .filter((invoice) =>
        customerTypeFilter === "All"
          ? true
          : getInvoiceCustomerType(invoice) === customerTypeFilter,
      )
      // then applying the payment method filter if the user chose one
      .filter((invoice) =>
        methodFilter === "All"
          ? true
          : invoice.paymentMethod === methodFilter,
      )
      .filter((invoice) => {
        const createdAtTime = new Date(invoice.createdAt).getTime(); // converting invoice time once so both date boundary checks use the same number
        if (fromBoundary && createdAtTime < fromBoundary.getTime()) {
          return false;
        }
        if (toBoundary && createdAtTime > toBoundary.getTime()) {
          return false;
        }
        return true;
      })
      .filter((invoice) => {
        // when there is no search text, we keep every row that already passed the earlier filters
        if (!loweredQuery) return true;

        // combining searchable text into one string keeps the filter logic short and easy to extend later
        return [
          invoice.invoiceNo,
          invoice.customerName,
          invoice.cashierName,
          invoice.itemSummary,
          getInvoiceReference(invoice),
        ]
          .join(" ")
          .toLowerCase()
          .includes(loweredQuery);
      });
  }, [
    activeTab,
    cashierFilter,
    customerTypeFilter,
    fromDate,
    invoices,
    isAdminView,
    methodFilter,
    query,
    toDate,
  ]);

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

  const [pageSize, setPageSize] = useState(20);
  useEffect(() => {
    if (historyCategory === "sales") return;

    let active = true;
    async function loadEvents() {
      try {
        setEventLoading(true);
        const data = await listCategorizedHistoryApi({
          category: historyCategory,
          q: query.trim() || undefined,
          from: fromDate || undefined,
          to: toDate || undefined,
          page,
          pageSize,
        });
        if (!active) return;
        setEventRows(data.events);
        setEventTotal(data.total);
        setEventTotalPages(Math.max(1, data.totalPages));
      } catch {
        if (!active) return;
        setEventRows([]);
        setEventTotal(0);
        setEventTotalPages(1);
      } finally {
        if (active) setEventLoading(false);
      }
    }

    void loadEvents();

    return () => {
      active = false;
    };
  }, [fromDate, historyCategory, page, pageSize, query, toDate]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize)); // forcing at least 1 page keeps pagination math simple even with zero rows
  const pageClamped = clampPage(page, 1, totalPages); // protecting against stale page numbers after filters shrink the result set

  const pageItems = useMemo(() => {
    const start = (pageClamped - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, pageClamped, pageSize]);
  const pageStart = filtered.length === 0 ? 0 : (pageClamped - 1) * pageSize;
  const pageEnd = filtered.length === 0 ? 0 : pageStart + pageItems.length;

  // these summary values all recalculate from the currently filtered list
  // that way the cards always match exactly what the table below is showing
  const totalSales = useMemo(
    () =>
      filtered.reduce(
        (sum, invoice) =>
          sum + (invoice.status === "Cancelled" ? 0 : invoice.netTotal),
        0,
      ),
    [filtered],
  );
  const totalPaid = useMemo(
    () => filtered.reduce((sum, invoice) => sum + invoice.paidAmount, 0),
    [filtered],
  );
  const totalDue = useMemo(
    () =>
      filtered.reduce(
        (sum, invoice) =>
          sum + (invoice.status === "Cancelled" ? 0 : invoice.dueAmount),
        0,
      ),
    [filtered],
  );
  const walkInRecordCount = useMemo(
    () => filtered.filter((invoice) => !invoice.customerId).length,
    [filtered],
  );
  const esewaRecordCount = useMemo(
    () => filtered.filter((invoice) => invoice.paymentMethod === "eSewa").length,
    [filtered],
  );
  const referenceRecordCount = useMemo(
    () =>
      filtered.filter((invoice) => Boolean(getInvoiceReference(invoice))).length,
    [filtered],
  );

  // fetching the full invoice details when the user clicks the "visibility" icon
  // the main list doesn't have detailed relations, so we fetch it fresh by its ID
  async function openInvoice(id: string) {
    // start by showing whatever cached basic info we have in the array so the modal opens instantly
    const cached = invoices.find((invoice) => invoice.id === id) || null;
    setSelectedInvoiceId(id);
    setDetailInvoice(cached);
    // then fetch real data over the network
    try {
      setDetailInvoice(await hydrateInvoice(id));
    } catch {
      // this handles when the detail fetch fails, and we keep showing the cached invoice preview instead of closing the modal
      setDetailInvoice(cached);
    }
  }

  // closing the detail modal also clears the last selected invoice so the next open starts fresh
  function closeInvoice() {
    setSelectedInvoiceId(null);
    setDetailInvoice(null);
  }

  async function openStockReceiveDetail(batchId: string) {
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

    if (event.detailType === "stockReceiveBatch") {
      void openStockReceiveDetail(event.detailId);
      return;
    }

    if (event.detailType === "importBatch") {
      navigate(`/products?importBatch=${encodeURIComponent(event.detailId)}`);
    }
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

  const categoryTabs = (
    <div className="mt-4 flex flex-wrap gap-2">
      {HISTORY_CATEGORIES.map((category) => (
        <button
          key={category.key}
          type="button"
          onClick={() => {
            setHistoryCategory(category.key);
            setPage(1);
          }}
          className={cn(
            "rounded-[14px] border px-4 py-2 text-[13px] font-extrabold transition",
            historyCategory === category.key
              ? "border-[#11120d] bg-[#11120d] text-white"
              : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6]",
          )}
        >
          {category.label}
        </button>
      ))}
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
      <div className="min-h-full rounded-[28px] bg-[#F1F1F1] p-[24px] text-[#0F172A]">
        <p className="max-w-[720px] text-[13px] font-medium text-slate-500">
          Category-wise business activity for products, stock, imports,
          documents, returns, payments, and system events.
        </p>
        {categoryTabs}

        <div className="mt-6 rounded-[20px] border border-[#CFCFD3] bg-[#FFFFFF] p-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_180px_180px_auto] lg:items-end">
            <label className="space-y-2">
              <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                Search
              </div>
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                placeholder="Search action, entity, actor..."
                className="h-[46px] w-full rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] px-[16px] text-[14px] font-semibold text-[#000000] outline-none focus:border-[#11120D]"
              />
            </label>

            <label className="space-y-2">
              <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                From
              </div>
              <input
                type="date"
                value={fromDate}
                onChange={(event) => {
                  setFromDate(event.target.value);
                  setPage(1);
                }}
                className="h-[46px] w-full rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] px-[16px] text-[14px] font-semibold text-[#000000] outline-none focus:border-[#11120D]"
              />
            </label>

            <label className="space-y-2">
              <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                To
              </div>
              <input
                type="date"
                value={toDate}
                onChange={(event) => {
                  setToDate(event.target.value);
                  setPage(1);
                }}
                className="h-[46px] w-full rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] px-[16px] text-[14px] font-semibold text-[#000000] outline-none focus:border-[#11120D]"
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
              className="h-[46px] rounded-[14px] border border-[#CFCFD3] bg-white px-4 text-[13px] font-extrabold text-[#565449] hover:bg-[#F3F4F6]"
            >
              Clear filters
            </button>
          </div>
        </div>

        <div className="mt-6 overflow-hidden rounded-[20px] border border-[#CFCFD3] bg-white">
          <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(180px,0.7fr)_minmax(170px,0.7fr)_140px] border-b border-[#CFCFD3] bg-slate-50 px-5 py-3 text-left text-[11px] font-extrabold uppercase text-slate-500">
            <div>Event</div>
            <div>Entity</div>
            <div>Actor / Time</div>
            <div className="text-right">Action</div>
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
            eventRows.map((event) => (
              <div
                key={event.id}
                className="grid grid-cols-[minmax(0,1.6fr)_minmax(180px,0.7fr)_minmax(170px,0.7fr)_140px] items-center gap-3 border-b border-slate-100 px-5 py-4 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-extrabold text-slate-900">
                    {event.title || String(event.action).replaceAll("_", " ")}
                  </div>
                  <div className="mt-1 line-clamp-2 text-[12px] font-semibold leading-5 text-slate-500">
                    {event.description || event.id}
                  </div>
                </div>
                <div className="min-w-0 text-[13px] font-semibold text-slate-700">
                  <div className="truncate">{event.entityType}</div>
                  <div className="mt-1 truncate text-[12px] text-slate-500">
                    {event.entityId}
                  </div>
                </div>
                <div className="min-w-0 text-[13px] font-semibold text-slate-700">
                  <div className="truncate">{event.actor?.name || "System"}</div>
                  <div className="mt-1 truncate text-[12px] text-slate-500">
                    {formatEventTime(event.createdAt)}
                  </div>
                </div>
                <div className="flex justify-end">
                  {event.detailType && event.detailId ? (
                    <button
                      type="button"
                      onClick={() => handleHistoryEventAction(event)}
                      className="inline-flex h-[36px] items-center justify-center rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6]"
                    >
                      {event.actionLabel || "Open"}
                    </button>
                  ) : (
                    <span className="text-[12px] font-semibold text-slate-400">-</span>
                  )}
                </div>
              </div>
            ))
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
          />
        </div>

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
    <div className="min-h-full rounded-[28px] bg-[#F1F1F1] p-[24px] text-[#0F172A]">
      {/* this page shell keeps the same rounded admin workspace look used by the other protected route screens */}
      <p className="max-w-[720px] text-[13px] font-medium text-slate-500">
        Real invoice records with payment totals, status, method, and
        reference data.
      </p>
      {categoryTabs}

      {/* these summary cards use a wide responsive grid so the key totals stay visible before the user starts scrolling the table */}
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-7">
        <div className="rounded-2xl border border-[#CFCFD3] bg-[#FFFFFF] p-5">
          <div className="text-[11px] font-extrabold uppercase  text-[#8C8889]">
            Net Total
          </div>
          <div className="mt-1 text-2xl font-extrabold text-[#000000]">
            {formatNpr(totalSales)}
          </div>
        </div>

        <div className="rounded-2xl border border-[#CFCFD3] bg-[#FFFFFF] p-5">
          <div className="text-[11px] font-extrabold uppercase  text-[#179B4D]">
            Paid
          </div>
          <div className="mt-1 text-2xl font-extrabold text-[#179B4D]">
            {formatNpr(totalPaid)}
          </div>
        </div>

        <div className="rounded-2xl border border-[#CFCFD3] bg-[#FFFFFF] p-5">
          <div className="text-[11px] font-extrabold uppercase  text-rose-700">
            Due
          </div>
          <div className="mt-1 text-2xl font-extrabold text-rose-700">
            {formatNpr(totalDue)}
          </div>
        </div>

        <div className="rounded-2xl border border-[#CFCFD3] bg-[#FFFFFF] p-5">
          <div className="text-[11px] font-extrabold uppercase  text-[#8C8889]">
            Records
          </div>
          <div className="mt-1 text-2xl font-extrabold text-[#000000]">
            {filtered.length}
          </div>
        </div>

        <div className="rounded-2xl border border-[#CFCFD3] bg-[#FFFFFF] p-5">
          <div className="text-[11px] font-extrabold uppercase  text-[#8C8889]">
            Walk-in Records
          </div>
          <div className="mt-1 text-2xl font-extrabold text-[#000000]">
            {walkInRecordCount}
          </div>
        </div>

        <div className="rounded-2xl border border-[#CFCFD3] bg-[#FFFFFF] p-5">
          <div className="text-[11px] font-extrabold uppercase  text-[#179B4D]">
            eSewa Records
          </div>
          <div className="mt-1 text-2xl font-extrabold text-[#000000]">
            {esewaRecordCount}
          </div>
        </div>

        <div className="rounded-2xl border border-[#CFCFD3] bg-[#FFFFFF] p-5">
          <div className="text-[11px] font-extrabold uppercase  text-[#8C8889]">
            Reference IDs
          </div>
          <div className="mt-1 text-2xl font-extrabold text-[#000000]">
            {referenceRecordCount}
          </div>
        </div>
      </div>

      {/* this filter card groups tabs, search, and extra filters into one surface so browsing history feels like a single workflow */}
      <div className="mt-6 rounded-[20px] border border-[#CFCFD3] bg-[#FFFFFF] p-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-[#8C8889]">
              Browse Records
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
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
                        "rounded-full border-2 px-4 py-2 text-[12px] font-extrabold transition",
                        active
                          ? "border-[#11120d] bg-[#11120d] text-white"
                          : "border-[#CFCFD3] bg-[#FFFFFF] text-[#565449] hover:bg-[#F3F4F6]",
                      )}
                    >
                      {tab}
                    </button>
                  );
                },
              )}
            </div>
          </div>

          <div className="relative w-full xl:w-[360px] xl:min-w-[360px]">
            <Icon
              name="search"
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              placeholder="Search invoice, customer, cashier, reference..."
              className="h-[46px] w-full rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] pl-[48px] pr-[16px] text-[14px] font-semibold text-[#000000] outline-none focus:border-[#11120D]"
            />
          </div>
        </div>

        <div
          className={cn(
            "mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:items-end",
            isAdminView
              ? "xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
              : "xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]",
          )}
        >
          <label className="space-y-2">
            <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
              From Date
            </div>
            <input
              type="date"
              value={fromDate}
              max={toDate || undefined}
              onChange={(event) => {
                setFromDate(event.target.value);
                setPage(1);
              }}
              className="h-[46px] w-full rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] px-[16px] text-[14px] font-semibold text-[#000000] outline-none focus:border-[#11120D]"
            />
          </label>

          <label className="space-y-2">
            <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
              To Date
            </div>
            <input
              type="date"
              value={toDate}
              min={fromDate || undefined}
              onChange={(event) => {
                setToDate(event.target.value);
                setPage(1);
              }}
              className="h-[46px] w-full rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] px-[16px] text-[14px] font-semibold text-[#000000] outline-none focus:border-[#11120D]"
            />
          </label>

          {isAdminView ? (
            <label className="space-y-2">
              <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                Cashier
              </div>
              <select
                value={cashierFilter}
                onChange={(event) => {
                  setCashierFilter(event.target.value);
                  setPage(1);
                }}
                className="h-[46px] w-full rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] px-[16px] text-[14px] font-semibold text-[#000000] outline-none focus:border-[#11120D]"
              >
                <option value="All">All Cashiers</option>
                {cashierOptions.map((cashier) => (
                  <option key={cashier.id} value={cashier.id}>
                    {cashier.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="space-y-2">
            <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
              Customer Type
            </div>
            <select
              value={customerTypeFilter}
              onChange={(event) => {
                setCustomerTypeFilter(
                  event.target.value as HistoryCustomerTypeFilter,
                );
                setPage(1);
              }}
              className="h-[46px] w-full rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] px-[16px] text-[14px] font-semibold text-[#000000] outline-none focus:border-[#11120D]"
            >
              <option value="All">All Customers</option>
              <option value="Walk-in">Walk-in</option>
              <option value="Registered">Registered</option>
            </select>
          </label>

          <label className="space-y-2">
            <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
              Payment Method
            </div>
            <select
              value={methodFilter}
              onChange={(event) => {
                setMethodFilter(
                  event.target.value as "All" | AppInvoice["paymentMethod"],
                );
                setPage(1);
              }}
              className="h-[46px] w-full rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] px-[16px] text-[14px] font-semibold text-[#000000] outline-none focus:border-[#11120D]"
            >
              <option value="All">All Methods</option>
              <option value="Cash">Cash</option>
              <option value="eSewa">eSewa</option>
              <option value="None">None</option>
            </select>
          </label>

          <div className="flex items-end xl:justify-end">
            <button
              type="button"
              onClick={clearExtraFilters}
              disabled={!hasExtraFilters}
              className={cn(
                "h-[46px] w-full rounded-[14px] border px-4 text-[13px] font-extrabold whitespace-nowrap transition md:w-auto md:min-w-[132px]",
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

      <div className="mt-6 overflow-hidden rounded-[20px] border border-[#CFCFD3] bg-[#FFFFFF] ">
        <div className="overflow-x-auto">
          <table className="min-w-[1200px] w-full">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-[11px] font-extrabold uppercase  text-slate-500">
                <th className="px-5 py-3">Invoice</th>
                <th className="px-5 py-3">Customer</th>
                <th className="px-5 py-3">Date</th>
                <th className="px-5 py-3">Method</th>
                <th className="px-5 py-3">Reference</th>
                <th className="px-5 py-3 text-right">Total</th>
                <th className="px-5 py-3 text-right">Paid</th>
                <th className="px-5 py-3 text-right">Due</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>

            <tbody>
              {pageItems.map((invoice) => {
                const reference = getInvoiceReference(invoice);

                return (
                  <tr
                    key={invoice.id}
                    className="border-b border-slate-100 align-top last:border-0 hover:bg-slate-50/70"
                  >
                    <td className="px-5 py-4">
                      <div className="font-mono text-[13px] font-extrabold text-slate-900">
                        {invoice.invoiceNo}
                      </div>
                      <div className="mt-1 text-[12px] text-slate-500">
                        {invoice.itemSummary}
                      </div>
                    </td>

                    <td className="px-5 py-4">
                      <div className="text-[13px] font-extrabold text-slate-900">
                        {invoice.customerName}
                      </div>
                      <div className="mt-1 text-[12px] text-slate-500">
                        {invoice.customerSubtitle}
                      </div>
                    </td>

                    <td className="px-5 py-4">
                      <div className="text-[13px] font-semibold text-slate-900">
                        {invoice.createdDateLabel}
                      </div>
                      <div className="mt-1 text-[12px] text-slate-500">
                        {invoice.createdTimeLabel}
                      </div>
                    </td>

                    <td className="px-5 py-4">
                      <div>
                        <PaymentMethodChip method={invoice.paymentMethod} />
                      </div>
                      <div className="mt-1 text-[12px] text-slate-500">
                        Cashier: {invoice.cashierName}
                      </div>
                    </td>

                    <td className="px-5 py-4 text-[13px] font-semibold text-slate-700">
                      {reference || "-"}
                    </td>

                    <td className="px-5 py-4 text-right font-mono text-[13px] font-extrabold text-slate-900">
                      {formatNpr(invoice.netTotal)}
                    </td>

                    <td className="px-5 py-4 text-right font-mono text-[13px] font-extrabold text-slate-900">
                      {formatNpr(invoice.paidAmount)}
                    </td>

                    <td className="px-5 py-4 text-right font-mono text-[13px] font-extrabold text-slate-900">
                      {formatNpr(invoice.dueAmount)}
                    </td>

                    <td className="px-5 py-4">
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

                    <td className="px-5 py-4">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => openInvoice(invoice.id)}
                          className="flex h-10 w-10 items-center justify-center rounded-[12px] border-2 border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
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

        <PaginationBar
          page={pageClamped}
          totalPages={totalPages}
          total={filtered.length}
          start={pageStart}
          end={pageEnd}
          label="history records"
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(nextPageSize) => {
            setPageSize(nextPageSize);
            setPage(1);
          }}
        />
      </div>

      <InvoiceDetailModal
        open={!!selectedInvoiceId}
        invoice={detailInvoice}
        onClose={closeInvoice}
      />
    </div>
  );
}
