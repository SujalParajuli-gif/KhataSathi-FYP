import { useEffect, useMemo, useState } from "react";
import GIcon from "~/components/ui/GIcon";
import { MobileFilterTabs } from "~/components/ui/MobileFilters";
import { useToast } from "~/components/ui/Toast";
import {
  approveCustomerDiscountRequestApi,
  approveReturnRequestApi,
  listCustomerDiscountRequestsApi,
  listReturnRequestsApi,
  rejectCustomerDiscountRequestApi,
  rejectReturnRequestApi,
  type CustomerDiscountRequest,
  type ReturnReasonCode,
  type ReturnStatusCode,
} from "~/lib/api/endpoints";
import { formatNpr } from "~/lib/invoices";
import { isRateLimitError } from "~/lib/api/client";
import { useRateLimitRecovery } from "~/lib/api/useRateLimitRecovery";

type HubFilter = "all" | "returns" | "discounts";

type ReturnRequestItem = {
  id: string;
  name: string;
  sku?: string;
  qtyReturned: number;
  lineTotal: number;
};

type ReturnRequestRow = {
  id: string;
  invoiceNo: string;
  customerName: string;
  cashierName: string;
  reason: ReturnReasonCode;
  note?: string;
  status: ReturnStatusCode;
  refundAmount: number;
  refundMethod?: "CASH" | "ESEWA";
  createdAt: string;
  createdByName: string;
  items: ReturnRequestItem[];
};

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function errorMessage(error: any, fallback: string) {
  return error?.response?.data?.error || error?.message || fallback;
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function reasonLabel(reason: ReturnReasonCode) {
  if (reason === "WRONG_ITEM") return "Wrong item";
  if (reason === "CUSTOMER_REQUEST") return "Customer request";
  if (reason === "DAMAGED") return "Damaged";
  if (reason === "EXCHANGE") return "Exchange";
  return "Other";
}

function discountTypeLabel(type: string) {
  return type === "WHOLESALE" ? "Wholesale" : "Loyalty";
}

function normalizeReturnRequest(raw: any): ReturnRequestRow {
  return {
    id: String(raw.id),
    invoiceNo: String(raw.invoice?.invoiceNo || raw.invoiceNo || "Return"),
    customerName: String(raw.invoice?.customer?.name || "Walk-in"),
    cashierName: String(raw.invoice?.cashier?.name || "Unknown cashier"),
    reason: String(raw.reason || "OTHER") as ReturnReasonCode,
    note: raw.note ? String(raw.note) : undefined,
    status: String(raw.status || "PENDING") as ReturnStatusCode,
    refundAmount: Number(raw.refundAmount || 0),
    refundMethod: raw.refundMethod ? String(raw.refundMethod) as "CASH" | "ESEWA" : undefined,
    createdAt: String(raw.createdAt || new Date().toISOString()),
    createdByName: String(raw.createdBy?.name || "Unknown user"),
    items: Array.isArray(raw.items)
      ? raw.items.map((item: any) => ({
          id: String(item.id),
          name: String(item.product?.name || "Returned item"),
          sku: item.product?.sku ? String(item.product.sku) : undefined,
          qtyReturned: Number(item.qtyReturned || 0),
          lineTotal: Number(item.lineTotal || 0),
        }))
      : [],
  };
}
function EmptyState({ filter }: { filter: HubFilter }) {
  const label =
    filter === "returns"
      ? "return requests"
      : filter === "discounts"
        ? "discount requests"
        : "requests";

  return (
    <div className="rounded-[20px] border border-dashed border-[#CFCFD3] bg-white px-6 py-12 text-center">
      <div className="mx-auto flex h-[48px] w-[48px] items-center justify-center rounded-[16px] bg-[#F3F4F6] text-[#8C8889]">
        <GIcon name="task_alt" sizePx={24} />
      </div>
      <div className="mt-4 text-[15px] font-extrabold text-[#000000]">
        No pending {label}
      </div>
      <div className="mt-1 text-[13px] font-semibold text-[#8C8889]">
        New approval items will appear here automatically after refresh.
      </div>
    </div>
  );
}

export default function RequestsPage() {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [filter, setFilter] = useState<HubFilter>("all");
  const [returnRequests, setReturnRequests] = useState<ReturnRequestRow[]>([]);
  const [discountRequests, setDiscountRequests] = useState<CustomerDiscountRequest[]>([]);
  const [discountPercents, setDiscountPercents] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState("");
  const [rateLimitRecoveryKey, setRateLimitRecoveryKey] = useState(0);
  const requestRateLimitRecovery = useRateLimitRecovery(() => {
    setRateLimitRecoveryKey((current) => current + 1);
  });

  async function loadRequests() {
    setLoading(true);
    setLoadError("");

    try {
      const [returnData, discountData] = await Promise.all([
        listReturnRequestsApi({ status: "PENDING" }),
        listCustomerDiscountRequestsApi("PENDING"),
      ]);
      const returns = Array.isArray(returnData?.requests)
        ? returnData.requests.map(normalizeReturnRequest)
        : [];
      const discounts = Array.isArray(discountData?.requests)
        ? discountData.requests
        : [];

      setReturnRequests(returns);
      setDiscountRequests(discounts);
      setDiscountPercents(
        Object.fromEntries(
          discounts.map((request: CustomerDiscountRequest) => [
            request.id,
            Number(request.discountPercent || 0),
          ]),
        ),
      );
    } catch (error: any) {
      if (isRateLimitError(error)) requestRateLimitRecovery();
      setLoadError(
        isRateLimitError(error)
          ? "Request data is temporarily paused and will resume automatically."
          : errorMessage(error, "Failed to load pending requests."),
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadRequests();
  }, [rateLimitRecoveryKey]);

  const totalPending = returnRequests.length + discountRequests.length;
  const visibleReturns = filter === "all" || filter === "returns";
  const visibleDiscounts = filter === "all" || filter === "discounts";

  const hasVisibleItems = useMemo(() => {
    return (
      (visibleReturns && returnRequests.length > 0) ||
      (visibleDiscounts && discountRequests.length > 0)
    );
  }, [discountRequests.length, returnRequests.length, visibleDiscounts, visibleReturns]);

  function setNote(id: string, value: string) {
    setNotes((current) => ({ ...current, [id]: value }));
  }

  async function approveReturn(id: string) {
    setBusyKey(`return:${id}`);
    try {
      await approveReturnRequestApi(id);
      setReturnRequests((current) => current.filter((request) => request.id !== id));
      showToast("success", "Return request approved.");
    } catch (error: any) {
      showToast("danger", errorMessage(error, "Failed to approve return request."));
    } finally {
      setBusyKey("");
    }
  }

  async function rejectReturn(id: string) {
    setBusyKey(`return:${id}`);
    try {
      await rejectReturnRequestApi(id, notes[id]?.trim() || undefined);
      setReturnRequests((current) => current.filter((request) => request.id !== id));
      showToast("success", "Return request rejected.");
    } catch (error: any) {
      showToast("danger", errorMessage(error, "Failed to reject return request."));
    } finally {
      setBusyKey("");
    }
  }

  async function approveDiscount(request: CustomerDiscountRequest) {
    setBusyKey(`discount:${request.id}`);
    try {
      await approveCustomerDiscountRequestApi(request.id, {
        discountPercent: discountPercents[request.id] || request.discountPercent,
        adminNote: notes[request.id]?.trim() || undefined,
      });
      setDiscountRequests((current) => current.filter((item) => item.id !== request.id));
      showToast("success", "Discount request approved.");
    } catch (error: any) {
      showToast("danger", errorMessage(error, "Failed to approve discount request."));
    } finally {
      setBusyKey("");
    }
  }

  async function rejectDiscount(request: CustomerDiscountRequest) {
    setBusyKey(`discount:${request.id}`);
    try {
      await rejectCustomerDiscountRequestApi(request.id, {
        adminNote: notes[request.id]?.trim() || undefined,
      });
      setDiscountRequests((current) => current.filter((item) => item.id !== request.id));
      showToast("success", "Discount request rejected.");
    } catch (error: any) {
      showToast("danger", errorMessage(error, "Failed to reject discount request."));
    } finally {
      setBusyKey("");
    }
  }

  return (
    <div className="space-y-[14px] text-[#000000]">
      <div className="space-y-[14px]">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div>
            <h1 className="text-[24px] font-extrabold text-[#000000]">
              Request Hub
            </h1>
            <p className="mt-1 text-[13px] font-medium text-[#8C8889]">
              Review pending returns and customer discount approvals from one queue.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadRequests()}
            disabled={loading}
            className="inline-flex h-[42px] items-center justify-center gap-2 rounded-[14px] border border-[#CFCFD3] bg-white px-4 text-[13px] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6] disabled:opacity-50"
          >
            <GIcon name="refresh" sizePx={18} />
            Refresh
          </button>
        </div>

        {/* Stats Banner */}
        <div className="mb-6 md:mb-8 rounded-[18px] border border-[#CFCFD3] bg-white p-5 md:p-6 shadow-sm">
          <div className="flex snap-x snap-mandatory gap-5 overflow-x-auto pb-2 md:grid md:grid-cols-3 md:gap-6 md:overflow-visible md:pb-0 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
            <div className="flex w-[60vw] shrink-0 snap-start flex-col sm:w-[200px] md:w-auto">
              <span className="text-xl font-extrabold md:text-2xl text-[#11120d]">
                {totalPending} <span className="ml-1 text-xs font-semibold uppercase tracking-wider text-[#8C8889] md:text-sm">Total pending</span>
              </span>
              <div className="mt-2 h-1 w-12 rounded-full bg-slate-200"></div>
            </div>
            <div className="flex w-[60vw] shrink-0 snap-start flex-col sm:w-[200px] md:w-auto">
              <span className="text-xl font-extrabold text-amber-600 md:text-2xl">
                {returnRequests.length} <span className="ml-1 text-xs font-semibold uppercase tracking-wider text-[#8C8889] md:text-sm">Return requests</span>
              </span>
              <div className="mt-2 h-1 w-12 rounded-full bg-amber-500"></div>
            </div>
            <div className="flex w-[60vw] shrink-0 snap-start flex-col sm:w-[200px] md:w-auto">
              <span className="text-xl font-extrabold text-emerald-600 md:text-2xl">
                {discountRequests.length} <span className="ml-1 text-xs font-semibold uppercase tracking-wider text-[#8C8889] md:text-sm">Discount requests</span>
              </span>
              <div className="mt-2 h-1 w-12 rounded-full bg-emerald-500"></div>
            </div>
          </div>
        </div>

        <div className="mb-6 rounded-[18px] border border-[#CFCFD3] bg-white p-4 shadow-sm">
          <MobileFilterTabs className="lg:hidden" ariaLabel="Request type" value={filter} onChange={setFilter} items={[{ value: "all", label: "All" }, { value: "returns", label: "Returns" }, { value: "discounts", label: "Discounts" }]} />
          <div className="hidden flex-wrap gap-2 lg:flex">
            {(["all", "returns", "discounts"] as HubFilter[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={cn(
                  "h-[38px] rounded-full border px-4 text-[12px] font-extrabold capitalize transition",
                  filter === key
                    ? "border-[#11120d] bg-[#11120d] text-white"
                    : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6]",
                )}
              >
                {key}
              </button>
            ))}
          </div>
        </div>

        {loadError ? (
          <div className="rounded-[16px] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] font-bold text-rose-700">
            {loadError}
          </div>
        ) : null}

        {loading ? (
          <div className="flex h-[220px] items-center justify-center rounded-[20px] border border-[#CFCFD3] bg-white text-[13px] font-semibold text-[#8C8889]">
            Loading pending requests...
          </div>
        ) : !hasVisibleItems ? (
          <EmptyState filter={filter} />
        ) : (
          <div className="space-y-[14px]">
            {visibleReturns
              ? returnRequests.map((request) => {
                  const key = `return:${request.id}`;
                  return (
                    <section
                      key={key}
                      className="overflow-hidden rounded-[20px] border border-[#CFCFD3] bg-white"
                    >
                      <div className="grid gap-4 border-b border-[#E5E7EB] bg-[#F3F4F6] px-5 py-4 lg:grid-cols-[minmax(0,1fr)_180px_220px] lg:items-center">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full border border-[#CFCFD3] bg-white px-3 py-1 text-[11px] font-extrabold uppercase text-[#565449]">
                              Return
                            </span>
                            <span className="text-[14px] font-extrabold text-[#000000]">
                              {request.invoiceNo}
                            </span>
                          </div>
                          <div className="mt-2 text-[12px] font-semibold text-[#8C8889]">
                            {request.customerName} - {reasonLabel(request.reason)} - Requested by {request.createdByName}
                          </div>
                        </div>
                        <div className="font-mono text-[16px] font-extrabold text-[#000000] lg:text-right">
                          {formatNpr(request.refundAmount)}
                        </div>
                        <div className="flex flex-wrap gap-2 lg:justify-end">
                          <button
                            type="button"
                            disabled={busyKey === key}
                            onClick={() => void rejectReturn(request.id)}
                            className="h-[36px] rounded-[12px] border border-[#FECDD3] bg-[#FFF1F2] px-3 text-[12px] font-extrabold text-[#BE123C] transition hover:bg-rose-100 disabled:opacity-50"
                          >
                            Reject
                          </button>
                          <button
                            type="button"
                            disabled={busyKey === key}
                            onClick={() => void approveReturn(request.id)}
                            className="h-[36px] rounded-[12px] border border-[#11120d] bg-[#11120d] px-3 text-[12px] font-extrabold text-white transition hover:bg-[#2a2c27] disabled:opacity-50"
                          >
                            Approve
                          </button>
                        </div>
                      </div>
                      <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_280px]">
                        <div className="space-y-2">
                          {request.items.map((item) => (
                            <div
                              key={item.id}
                              className="grid grid-cols-[minmax(0,1fr)_70px_110px] gap-3 rounded-[12px] border border-[#E5E7EB] px-3 py-2 text-[12px]"
                            >
                              <div className="min-w-0">
                                <div className="truncate font-extrabold text-[#000000]">
                                  {item.name}
                                </div>
                                <div className="text-[11px] font-semibold text-[#8C8889]">
                                  {item.sku || "No SKU"}
                                </div>
                              </div>
                              <div className="font-mono font-extrabold">x{item.qtyReturned}</div>
                              <div className="text-right font-mono font-extrabold">
                                {formatNpr(item.lineTotal)}
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="space-y-2">
                          <div className="text-[12px] font-bold text-[#8C8889]">
                            {request.cashierName} - {formatDateTime(request.createdAt)}
                          </div>
                          <textarea
                            value={notes[request.id] || ""}
                            onChange={(event) => setNote(request.id, event.target.value)}
                            placeholder="Optional rejection note"
                            className="h-[86px] w-full resize-none rounded-[14px] border border-[#CFCFD3] bg-white px-3 py-2 text-[13px] font-semibold outline-none focus:border-[#11120d]"
                          />
                        </div>
                      </div>
                    </section>
                  );
                })
              : null}

            {visibleDiscounts
              ? discountRequests.map((request) => {
                  const key = `discount:${request.id}`;
                  return (
                    <section
                      key={key}
                      className="overflow-hidden rounded-[20px] border border-[#CFCFD3] bg-white"
                    >
                      <div className="grid gap-4 border-b border-[#E5E7EB] bg-[#F3F4F6] px-5 py-4 lg:grid-cols-[minmax(0,1fr)_220px_220px] lg:items-center">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full border border-[#CFCFD3] bg-white px-3 py-1 text-[11px] font-extrabold uppercase text-[#565449]">
                              Discount
                            </span>
                            <span className="text-[14px] font-extrabold text-[#000000]">
                              {request.customerName}
                            </span>
                          </div>
                          <div className="mt-2 text-[12px] font-semibold text-[#8C8889]">
                            {request.phone} - Requested by {request.requestedBy?.name || "Cashier"} - {formatDateTime(request.createdAt)}
                          </div>
                        </div>
                        <div className="text-[13px] font-extrabold text-[#000000] lg:text-right">
                          {discountTypeLabel(request.discountType)} {request.discountPercent}%
                        </div>
                        <div className="flex flex-wrap gap-2 lg:justify-end">
                          <button
                            type="button"
                            disabled={busyKey === key}
                            onClick={() => void rejectDiscount(request)}
                            className="h-[36px] rounded-[12px] border border-[#FECDD3] bg-[#FFF1F2] px-3 text-[12px] font-extrabold text-[#BE123C] transition hover:bg-rose-100 disabled:opacity-50"
                          >
                            Reject
                          </button>
                          <button
                            type="button"
                            disabled={busyKey === key}
                            onClick={() => void approveDiscount(request)}
                            className="h-[36px] rounded-[12px] border border-[#11120d] bg-[#11120d] px-3 text-[12px] font-extrabold text-white transition hover:bg-[#2a2c27] disabled:opacity-50"
                          >
                            Approve
                          </button>
                        </div>
                      </div>
                      <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_180px_280px]">
                        <div className="rounded-[14px] border border-[#E5E7EB] bg-white p-3">
                          <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                            Reason
                          </div>
                          <div className="mt-1 text-[13px] font-semibold text-[#565449]">
                            {request.reason || "No reason provided."}
                          </div>
                        </div>
                        <label className="block">
                          <span className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                            Approved percent
                          </span>
                          <input
                            type="number"
                            min={0}
                            max={100}
                            value={discountPercents[request.id] ?? request.discountPercent}
                            onChange={(event) =>
                              setDiscountPercents((current) => ({
                                ...current,
                                [request.id]: Number(event.target.value),
                              }))
                            }
                            className="mt-1 h-[42px] w-full rounded-[14px] border border-[#CFCFD3] px-3 text-[13px] font-bold outline-none focus:border-[#11120d]"
                          />
                        </label>
                        <textarea
                          value={notes[request.id] || ""}
                          onChange={(event) => setNote(request.id, event.target.value)}
                          placeholder="Optional approval or rejection note"
                          className="h-[86px] w-full resize-none rounded-[14px] border border-[#CFCFD3] bg-white px-3 py-2 text-[13px] font-semibold outline-none focus:border-[#11120d]"
                        />
                      </div>
                    </section>
                  );
                })
              : null}
          </div>
        )}
      </div>
    </div>
  );
}
