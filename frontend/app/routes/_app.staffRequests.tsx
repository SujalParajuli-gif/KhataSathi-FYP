import { useEffect, useMemo, useState } from "react";
import GIcon from "~/components/ui/GIcon";
import {
  ActiveFilterChips,
  MobileFilterButton,
  MobileFilterSheet,
  type MobileFilterChip,
} from "~/components/ui/MobileFilters";
import { useToast } from "~/components/ui/Toast";
import {
  cancelDraftRequestApi,
  getDraftRequestApi,
  listDraftRequestsApi,
  type BillingDraftRequest,
} from "~/lib/api/endpoints";
import { formatNpr } from "~/lib/invoices";
import { isRateLimitError } from "~/lib/api/client";
import { useRateLimitRecovery } from "~/lib/api/useRateLimitRecovery";

type RequestFilter =
  | "ALL"
  | "PENDING"
  | "MODIFIED"
  | "ACCEPTED"
  | "PARTIALLY_ACCEPTED"
  | "REJECTED"
  | "COMPLETED"
  | "EXPIRED";

const FILTERS: Array<{ key: RequestFilter; label: string }> = [
  { key: "ALL", label: "All" },
  { key: "PENDING", label: "Waiting" },
  { key: "MODIFIED", label: "Changed" },
  { key: "ACCEPTED", label: "Accepted" },
  { key: "PARTIALLY_ACCEPTED", label: "Partial" },
  { key: "REJECTED", label: "Rejected" },
  { key: "COMPLETED", label: "Completed" },
  { key: "EXPIRED", label: "Expired" },
];

const PAGE_SIZE = 12;

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function errorMessage(error: any, fallback: string) {
  return error?.response?.data?.error || error?.message || fallback;
}

function customerLabel(request: BillingDraftRequest) {
  return (
    request.customer?.name ||
    request.customerName ||
    (request.customerPhone ? `Phone ${request.customerPhone}` : "") ||
    "Walk-in customer"
  );
}

function cashierLabel(request: BillingDraftRequest) {
  return request.assignedCashier?.name || "Any cashier";
}

function formatDateTime(value?: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusLabel(status: string) {
  if (status === "PENDING") return "Waiting";
  if (status === "MODIFIED") return "Changed";
  if (status === "ACCEPTED") return "Accepted";
  if (status === "PARTIALLY_ACCEPTED") return "Some accepted";
  if (status === "REJECTED") return "Rejected";
  if (status === "COMPLETED") return "Completed";
  if (status === "EXPIRED") return "Expired";
  if (status === "CANCELLED_BY_STAFF") return "Cancelled";
  return status;
}

function statusClass(status: string) {
  if (status === "PENDING" || status === "MODIFIED") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  if (status === "ACCEPTED" || status === "PARTIALLY_ACCEPTED" || status === "COMPLETED") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (status === "REJECTED" || status === "EXPIRED" || status === "CANCELLED_BY_STAFF") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }
  return "border-[#D7D7DC] bg-[#F8F8FA] text-[#565449]";
}

function totalQty(request: BillingDraftRequest) {
  if (typeof request.totalQty === "number") return request.totalQty;
  return (request.items || []).reduce(
    (sum, item) => sum + Number(item.acceptedQty ?? item.qty ?? 0),
    0,
  );
}

function estimatedTotal(request: BillingDraftRequest) {
  if (typeof request.estimatedTotal === "number") return request.estimatedTotal;
  return (request.items || []).reduce((sum, item) => {
    const qty = Number(item.acceptedQty ?? item.qty ?? 0);
    const price = Number(item.product?.retailPrice || 0);
    return sum + qty * price;
  }, 0);
}

function itemCount(request: BillingDraftRequest) {
  return request.itemCount ?? request.items?.length ?? 0;
}

function canCancel(request?: BillingDraftRequest | null) {
  return request?.status === "PENDING" || request?.status === "MODIFIED";
}

export default function StaffRequestsPage() {
  const { showToast } = useToast();
  const [filter, setFilter] = useState<RequestFilter>("ALL");
  const [draftFilter, setDraftFilter] = useState<RequestFilter>("ALL");
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [requests, setRequests] = useState<BillingDraftRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState<BillingDraftRequest | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [rateLimitRecoveryKey, setRateLimitRecoveryKey] = useState(0);
  const requestRateLimitRecovery = useRateLimitRecovery(() => {
    setRateLimitRecoveryKey((current) => current + 1);
  });

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const selectedFilterLabel = FILTERS.find((item) => item.key === filter)?.label || "All";
  const mobileFilterChips: MobileFilterChip[] = filter === "ALL" ? [] : [{
    id: "status",
    label: selectedFilterLabel,
    onRemove: () => { setFilter("ALL"); setPage(1); },
  }];

  async function loadRequests(
    nextPage = page,
    nextFilter = filter,
    options?: { signal?: AbortSignal },
  ) {
    setLoading(true);
    setError("");
    try {
      const data = await listDraftRequestsApi(
        {
          mode: "list",
          page: nextPage,
          pageSize: PAGE_SIZE,
          status: nextFilter === "ALL" ? undefined : nextFilter,
        },
        options,
      );
      setRequests(Array.isArray(data.requests) ? data.requests : []);
      setTotal(Number(data.total ?? data.requests?.length ?? 0));
      setPage(Number(data.page || nextPage));
    } catch (err: any) {
      if (options?.signal?.aborted || err?.code === "ERR_CANCELED") return;
      if (isRateLimitError(err)) requestRateLimitRecovery();
      setError(
        isRateLimitError(err)
          ? "Bill request history is temporarily paused and will resume automatically."
          : errorMessage(err, "Could not load your bill requests."),
      );
    } finally {
      if (!options?.signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void loadRequests(1, filter, { signal: controller.signal });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [filter, rateLimitRecoveryKey]);

  async function openDetail(id: string) {
    setSelectedId(id);
    setDetailLoading(true);
    try {
      const data = await getDraftRequestApi(id);
      setSelected(data.request);
    } catch (err: any) {
      setSelectedId("");
      setSelected(null);
      showToast("danger", errorMessage(err, "Could not open this request."));
    } finally {
      setDetailLoading(false);
    }
  }

  function closeDetail() {
    setSelectedId("");
    setSelected(null);
  }

  async function cancelRequest(request: BillingDraftRequest) {
    if (!canCancel(request) || busyId) return;
    const ok = window.confirm(`Cancel ${request.requestNo}? The cashier will no longer see it.`);
    if (!ok) return;

    setBusyId(request.id);
    try {
      const data = await cancelDraftRequestApi(request.id);
      setRequests((current) =>
        current.map((item) => (item.id === data.request.id ? { ...item, ...data.request } : item)),
      );
      setSelected((current) =>
        current?.id === data.request.id ? { ...current, ...data.request } : current,
      );
      showToast("success", `${data.request.requestNo} cancelled.`);
      void loadRequests(page, filter);
    } catch (err: any) {
      showToast("danger", errorMessage(err, "Could not cancel this request."));
    } finally {
      setBusyId("");
    }
  }

  const summary = useMemo(() => {
    const waiting = requests.filter((item) => item.status === "PENDING" || item.status === "MODIFIED").length;
    const completed = requests.filter((item) => item.status === "COMPLETED").length;
    const actionNeeded = requests.filter((item) => item.status === "REJECTED" || item.status === "EXPIRED").length;
    return { waiting, completed, actionNeeded };
  }, [requests]);

  return (
    <div className="min-h-[calc(100vh-76px)] bg-[#F3F4F6] px-4 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-[1280px] space-y-5">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-[#080A05] text-white">
                <GIcon name="receipt_long" sizePx={22} />
              </div>
              <div>
                <h1 className="text-[24px] font-extrabold tracking-[0] text-[#000000]">
                  My Bill Requests
                </h1>
                <p className="mt-1 text-[13px] font-semibold text-[#777275]">
                  Check requests you sent to cashiers.
                </p>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void loadRequests(page, filter)}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-[12px] border border-[#CFCFD3] bg-white px-4 text-[13px] font-extrabold text-[#2F2D28] shadow-sm"
          >
            <GIcon name="refresh" sizePx={18} />
            Refresh
          </button>
        </header>

        <section className="grid gap-3 sm:grid-cols-3">
          {[
            ["Waiting", summary.waiting, "hourglass_top"],
            ["Completed", summary.completed, "task_alt"],
            ["Needs attention", summary.actionNeeded, "error"],
          ].map(([label, value, icon]) => (
            <div key={String(label)} className="rounded-[16px] border border-[#D7D7DC] bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[24px] font-extrabold text-[#000000]">{value}</div>
                  <div className="mt-1 text-[11px] font-extrabold uppercase text-[#8C8889]">
                    {label}
                  </div>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[#F3F4F6] text-[#565449]">
                  <GIcon name={String(icon)} sizePx={20} />
                </div>
              </div>
            </div>
          ))}
        </section>

        <div className="rounded-[16px] border border-[#D7D7DC] bg-white p-2 shadow-sm">
          <div className="flex items-center justify-between gap-3 lg:hidden">
            <div className="min-w-0 px-2"><div className="text-[11px] font-extrabold uppercase tracking-wide text-slate-500">Request status</div><div className="mt-0.5 truncate text-[14px] font-extrabold text-slate-900">{selectedFilterLabel}</div></div>
            <MobileFilterButton activeCount={filter === "ALL" ? 0 : 1} onClick={() => { setDraftFilter(filter); setMobileFiltersOpen(true); }} />
          </div>
          <ActiveFilterChips items={mobileFilterChips} className="mt-2 lg:hidden" />
          <div className="hidden min-w-max gap-2 overflow-x-auto lg:flex">
            {FILTERS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setFilter(item.key)}
                className={cn(
                  "h-10 rounded-[12px] px-4 text-[13px] font-extrabold",
                  filter === item.key
                    ? "bg-[#080A05] text-white"
                    : "bg-white text-[#565449] hover:bg-[#F6F6F7]",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <MobileFilterSheet
          open={mobileFiltersOpen}
          onClose={() => setMobileFiltersOpen(false)}
          onClear={() => setDraftFilter("ALL")}
          onApply={() => { setFilter(draftFilter); setPage(1); setMobileFiltersOpen(false); }}
        >
          <fieldset className="space-y-2">
            <legend className="mb-3 text-[13px] font-bold text-slate-700">Request status</legend>
            {FILTERS.map((item) => {
              const selected = draftFilter === item.key;
              return <button key={item.key} type="button" onClick={() => setDraftFilter(item.key)} className={cn("flex min-h-11 w-full items-center justify-between rounded-xl border px-4 text-left text-[13px] font-bold", selected ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-slate-200 bg-white text-slate-700")}><span>{item.label}</span>{selected ? <GIcon name="check" sizePx={18} className="text-emerald-600" /> : null}</button>;
            })}
          </fieldset>
        </MobileFilterSheet>

        <section className="overflow-hidden rounded-[18px] border border-[#D7D7DC] bg-white shadow-sm">
          <div className="hidden grid-cols-[1.1fr_1fr_.8fr_.8fr_1fr] border-b border-[#E7E7EA] bg-[#F6F7F8] px-5 py-3 text-[11px] font-extrabold uppercase tracking-wide text-[#6D778A] md:grid">
            <div>Request</div>
            <div>Customer</div>
            <div>Items</div>
            <div>Total</div>
            <div className="text-right">Status</div>
          </div>

          {loading ? (
            <div className="px-5 py-12 text-center text-[14px] font-bold text-[#777275]">
              Loading requests...
            </div>
          ) : error ? (
            <div className="px-5 py-12 text-center text-[14px] font-bold text-rose-600">
              {error}
            </div>
          ) : requests.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-[16px] bg-[#F3F4F6] text-[#8C8889]">
                <GIcon name="receipt_long" sizePx={24} />
              </div>
              <div className="mt-3 text-[15px] font-extrabold text-[#000000]">
                No requests found
              </div>
              <div className="mt-1 text-[13px] font-semibold text-[#8C8889]">
                Requests you send from Product Lookup will appear here.
              </div>
            </div>
          ) : (
            <div className="divide-y divide-[#ECECEF]">
              {requests.map((request) => (
                <button
                  key={request.id}
                  type="button"
                  onClick={() => void openDetail(request.id)}
                  className="block w-full px-4 py-4 text-left hover:bg-[#FAFAFB] md:px-5"
                >
                  <div className="grid gap-3 md:grid-cols-[1.1fr_1fr_.8fr_.8fr_1fr] md:items-center">
                    <div>
                      <div className="text-[14px] font-extrabold text-[#000000]">
                        {request.requestNo}
                      </div>
                      <div className="mt-1 text-[12px] font-bold text-[#8C8889]">
                        {formatDateTime(request.createdAt)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[13px] font-extrabold text-[#000000]">
                        {customerLabel(request)}
                      </div>
                      <div className="mt-1 text-[12px] font-bold text-[#8C8889]">
                        {cashierLabel(request)}
                      </div>
                    </div>
                    <div className="text-[13px] font-extrabold text-[#2F2D28]">
                      {itemCount(request)} line(s)
                      <span className="ml-2 text-[#8C8889]">{totalQty(request)} unit(s)</span>
                    </div>
                    <div className="text-[15px] font-extrabold text-[#000000]">
                      {formatNpr(estimatedTotal(request))}
                    </div>
                    <div className="flex items-center justify-between gap-3 md:justify-end">
                      <span className={cn("rounded-full border px-3 py-1 text-[12px] font-extrabold", statusClass(request.status))}>
                        {statusLabel(request.status)}
                      </span>
                      <GIcon name="chevron_right" sizePx={20} />
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between border-t border-[#E7E7EA] px-4 py-3 text-[12px] font-bold text-[#777275]">
            <span>
              Showing {requests.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}-
              {(page - 1) * PAGE_SIZE + requests.length} of {total}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={page <= 1 || loading}
                onClick={() => void loadRequests(page - 1, filter)}
                className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-[#D7D7DC] bg-white disabled:opacity-40"
                aria-label="Previous page"
              >
                <GIcon name="chevron_left" sizePx={18} />
              </button>
              <span className="min-w-[70px] text-center">
                {page} / {totalPages}
              </span>
              <button
                type="button"
                disabled={page >= totalPages || loading}
                onClick={() => void loadRequests(page + 1, filter)}
                className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-[#D7D7DC] bg-white disabled:opacity-40"
                aria-label="Next page"
              >
                <GIcon name="chevron_right" sizePx={18} />
              </button>
            </div>
          </div>
        </section>
      </div>

      {selectedId && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-4">
          <div className="max-h-[92vh] w-full overflow-hidden rounded-t-[24px] border border-[#D7D7DC] bg-white shadow-2xl sm:max-w-[720px] sm:rounded-[20px]">
            <div className="flex items-start justify-between gap-4 border-b border-[#E7E7EA] px-5 py-4">
              <div>
                <h2 className="text-[20px] font-extrabold text-[#000000]">
                  {selected?.requestNo || "Bill request"}
                </h2>
                <p className="mt-1 text-[13px] font-bold text-[#777275]">
                  {selected ? `${customerLabel(selected)} | ${statusLabel(selected.status)}` : "Loading..."}
                </p>
              </div>
              <button
                type="button"
                onClick={closeDetail}
                className="flex h-10 w-10 items-center justify-center rounded-[12px] border border-[#CFCFD3] bg-white text-[#565449]"
                aria-label="Close request detail"
              >
                <GIcon name="close" sizePx={20} />
              </button>
            </div>

            <div className="max-h-[calc(92vh-154px)] overflow-y-auto px-5 py-4">
              {detailLoading || !selected ? (
                <div className="py-10 text-center text-[14px] font-bold text-[#777275]">
                  Loading request...
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="rounded-[14px] border border-[#D7D7DC] bg-[#F8F8FA] p-3">
                      <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">Cashier</div>
                      <div className="mt-1 text-[14px] font-extrabold text-[#000000]">
                        {cashierLabel(selected)}
                      </div>
                    </div>
                    <div className="rounded-[14px] border border-[#D7D7DC] bg-[#F8F8FA] p-3">
                      <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">Created</div>
                      <div className="mt-1 text-[14px] font-extrabold text-[#000000]">
                        {formatDateTime(selected.createdAt)}
                      </div>
                    </div>
                    <div className="rounded-[14px] border border-[#D7D7DC] bg-[#F8F8FA] p-3">
                      <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">Expires</div>
                      <div className="mt-1 text-[14px] font-extrabold text-[#000000]">
                        {formatDateTime(selected.expiresAt)}
                      </div>
                    </div>
                  </div>

                  {selected.notes && (
                    <div className="rounded-[14px] border border-[#D7D7DC] bg-white p-3">
                      <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">Note</div>
                      <div className="mt-1 text-[13px] font-bold text-[#2F2D28]">{selected.notes}</div>
                    </div>
                  )}

                  <div className="overflow-hidden rounded-[16px] border border-[#D7D7DC]">
                    <div className="border-b border-[#E7E7EA] bg-[#F6F7F8] px-4 py-3 text-[12px] font-extrabold uppercase text-[#6D778A]">
                      Items
                    </div>
                    <div className="divide-y divide-[#ECECEF]">
                      {(selected.items || []).map((item) => (
                        <div key={item.id} className="px-4 py-3">
                          <div className="flex items-start justify-between gap-4">
                            <div>
                              <div className="text-[14px] font-extrabold text-[#000000]">
                                {item.product?.name || "Product"}
                              </div>
                              <div className="mt-1 text-[12px] font-bold text-[#8C8889]">
                                SKU: {item.product?.sku || "-"}
                              </div>
                              {item.rejectionReason && (
                                <div className="mt-2 text-[12px] font-bold text-rose-600">
                                  Reason: {item.rejectionReason}
                                </div>
                              )}
                            </div>
                            <div className="text-right">
                              <div className="text-[14px] font-extrabold text-[#000000]">
                                Qty {Number(item.acceptedQty ?? item.qty ?? 0)}
                              </div>
                              <div className={cn("mt-2 inline-flex rounded-full border px-2 py-1 text-[11px] font-extrabold", statusClass(item.reviewStatus || "PENDING"))}>
                                {statusLabel(item.reviewStatus || "PENDING")}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {selected.completedInvoice && (
                    <div className="rounded-[14px] border border-emerald-200 bg-emerald-50 p-3 text-[13px] font-extrabold text-emerald-700">
                      Completed as invoice {selected.completedInvoice.invoiceNo}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-col-reverse gap-3 border-t border-[#E7E7EA] px-5 py-4 sm:flex-row sm:justify-between">
              <button
                type="button"
                onClick={closeDetail}
                className="h-11 rounded-[12px] border border-[#CFCFD3] bg-white px-5 text-[13px] font-extrabold text-[#2F2D28]"
              >
                Close
              </button>
              {canCancel(selected) && (
                <button
                  type="button"
                  disabled={!selected || busyId === selected.id}
                  onClick={() => selected && void cancelRequest(selected)}
                  className="h-11 rounded-[12px] border border-rose-200 bg-rose-50 px-5 text-[13px] font-extrabold text-rose-600 disabled:opacity-50"
                >
                  {busyId === selected?.id ? "Cancelling..." : "Cancel request"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
