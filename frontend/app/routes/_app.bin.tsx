import { useEffect, useState, useRef } from "react";
import Icon from "~/components/ui/Icon";
import { ConfirmDialog } from "~/components/ui/Modal";
import PaginationBar from "~/components/ui/PaginationBar";
import { MobileFilterTabs } from "~/components/ui/MobileFilters";
import { useToast } from "~/components/ui/Toast";
import {
  listBinApi,
  purgeBinRecordApi,
  restoreBinRecordApi,
  type BinRecord,
} from "~/lib/api/endpoints";
import { isRateLimitError } from "~/lib/api/client";
import { useRateLimitRecovery } from "~/lib/api/useRateLimitRecovery";

type PendingAction =
  | { type: "restore"; record: BinRecord }
  | { type: "purge"; record: BinRecord }
  | null;

const ENTITY_LABELS: Record<string, string> = {
  Document: "Documents",
  ProductImportBatch: "Import Reviews",
};

function formatDate(value?: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

export default function BinPage() {
  const { showToast } = useToast();
  const [rateLimitRecoveryKey, setRateLimitRecoveryKey] = useState(0);
  const requestRateLimitRecovery = useRateLimitRecovery(() => {
    setRateLimitRecoveryKey((current) => current + 1);
  });
  const [records, setRecords] = useState<BinRecord[]>([]);
  const [entityType, setEntityType] = useState("ALL");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [busy, setBusy] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadedParams, setLoadedParams] = useState({ entityType: "ALL", page: 1, pageSize: 20 });
  const requestSequenceRef = useRef(0);

  const queryChanged = page !== loadedParams.page || pageSize !== loadedParams.pageSize || entityType !== loadedParams.entityType;
  const isStale = hasLoaded && (queryChanged || error !== null);

  async function loadBin(options?: { signal?: AbortSignal }) {
    const sequence = ++requestSequenceRef.current;
    try {
      setLoading(true);
      setError(null);
      const res = await listBinApi({
        entityType: entityType === "ALL" ? undefined : entityType,
        page,
        pageSize,
      }, options);

      if (options?.signal?.aborted || requestSequenceRef.current !== sequence) return;

      setRecords(res.records);
      setTotal(res.total);
      setTotalPages(Math.max(1, res.totalPages));
      setLoadedParams({ entityType, page, pageSize });
      setHasLoaded(true);
    } catch (err: any) {
      if (options?.signal?.aborted || err?.code === "ERR_CANCELED" || requestSequenceRef.current !== sequence) return;
      if (isRateLimitError(err)) {
        setError("The request was rate-limited. Please wait a moment, then try again.");
        requestRateLimitRecovery();
        return;
      }
      setError(err?.message || "Failed to load bin");
    } finally {
      if (requestSequenceRef.current === sequence && !options?.signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => void loadBin({ signal: controller.signal }),
      120,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      requestSequenceRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType, page, pageSize, rateLimitRecoveryKey]);

  async function confirmPendingAction() {
    if (!pendingAction) return;
    const label = pendingAction.record.entityLabel || pendingAction.record.entityId;

    try {
      setBusy(true);
      if (pendingAction.type === "restore") {
        await restoreBinRecordApi(pendingAction.record.id);
        showToast("success", `${label} restored.`);
      } else {
        await purgeBinRecordApi(pendingAction.record.id);
        showToast("success", `${label} permanently deleted.`);
      }
      setPendingAction(null);
      await loadBin();
    } catch (err: any) {
      showToast("danger", err?.message || "Action failed");
    } finally {
      setBusy(false);
    }
  }

  const pendingConfig = pendingAction
    ? pendingAction.type === "restore"
      ? {
          title: "Restore record?",
          message: `This will move "${pendingAction.record.entityLabel || pendingAction.record.entityId}" back to its original section.`,
          confirmLabel: "Restore",
          tone: "primary" as const,
          icon: "restore",
        }
      : {
          title: "Permanently delete?",
          message: `This permanently removes "${pendingAction.record.entityLabel || pendingAction.record.entityId}" from the database. This cannot be undone.`,
          confirmLabel: "Delete forever",
          tone: "danger" as const,
          icon: "delete",
        }
    : null;
  const pageStart = total === 0 ? 0 : (page - 1) * pageSize;
  const pageEnd = total === 0 ? 0 : pageStart + records.length;

  return (
    <div className="-mx-2 min-h-full bg-white px-1 pb-6 pt-3 text-slate-900 md:mx-0 md:rounded-[28px] md:p-6">
      <div className="mb-6 flex flex-col gap-4 md:mb-8 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight md:text-3xl">Bin</h1>
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-bold text-slate-600">
              {!hasLoaded ? "Loading" : error && records.length === 0 ? "Unavailable" : isStale ? "Previous results" : `${total} records`}
            </span>
          </div>
          <p className="mt-1 text-sm font-medium text-slate-500 md:text-base">
            Restore or permanently delete records kept for the 30-day safety window.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadBin()}
          className="inline-flex h-[42px] items-center justify-center gap-2 rounded-[14px] border border-[#CFCFD3] bg-white px-4 text-[13px] font-extrabold text-[#565449] hover:bg-[#F3F4F6]"
        >
          <Icon name="refresh" />
          Refresh
        </button>
      </div>

      <div className="mb-4 rounded-[18px] border border-[#CFCFD3] bg-white p-3">
        <MobileFilterTabs className="lg:hidden" ariaLabel="Bin record type" value={entityType} onChange={(type) => { setEntityType(type); setPage(1); }} items={[{ value: "ALL", label: "All" }, { value: "Document", label: "Documents" }, { value: "ProductImportBatch", label: "Import Reviews" }]} />
        <div className="hidden flex-nowrap items-center gap-2 overflow-x-auto md:flex-wrap lg:flex [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        {["ALL", "Document", "ProductImportBatch"].map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => {
              setEntityType(type);
              setPage(1);
            }}
            className={[
              "shrink-0 rounded-[14px] border px-4 py-2 text-[13px] font-extrabold transition",
              entityType === type
                ? "border-[#11120d] bg-[#11120d] text-white"
                : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6]",
            ].join(" ")}
          >
            {type === "ALL" ? "All" : ENTITY_LABELS[type] || type}
          </button>
        ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-[18px] border border-[#DADDE3] bg-white shadow-sm">
        <div className="hidden grid-cols-[1.5fr_1fr_1fr_1fr_190px] border-b border-[#DADDE3] bg-[#F8FAFC] px-4 py-3 text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#64748B] lg:grid">
          <div>Record</div>
          <div>Type</div>
          <div>Deleted By</div>
          <div>Purge After</div>
          <div className="text-right">Actions</div>
        </div>
        <div className="space-y-3 p-3 lg:space-y-0 lg:p-0 lg:[&>*+*]:border-t lg:[&>*+*]:border-[#E5E7EB]">

        {loading && !hasLoaded ? (
          <div role="status" className="flex h-[260px] items-center justify-center text-sm font-semibold text-slate-400">
            Loading bin...
          </div>
        ) : error && (!hasLoaded || records.length === 0) ? (
          <div role="alert" className="flex h-[360px] flex-col items-center justify-center p-6 text-center">
            <div className="flex h-[80px] w-[80px] items-center justify-center rounded-full border border-dashed border-[#CFCFD3] bg-rose-50 text-rose-500">
              <Icon name="error" sizePx={48} />
            </div>
            <div className="mt-4 text-[15px] font-extrabold text-rose-700">Failed to load bin</div>
            <div className="mt-1 max-w-[360px] text-[13px] font-semibold leading-6 text-rose-600">
              {error}
            </div>
            <button type="button" onClick={() => loadBin()} className="mt-4 inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-[#11120d] px-4 text-sm font-bold text-white">
              Try again
            </button>
          </div>
        ) : loading && records.length === 0 ? (
          <div role="status" className="flex h-[260px] items-center justify-center text-sm font-semibold text-slate-500">
            Loading bin...
          </div>
        ) : records.length === 0 ? (
          <div className="flex h-[360px] flex-col items-center justify-center p-6 text-center">
            <div className="flex h-[80px] w-[80px] items-center justify-center rounded-full border border-dashed border-[#CFCFD3] bg-[#F3F4F6] text-slate-300">
              <Icon name="delete" sizePx={48} />
            </div>
            <div className="mt-4 text-[15px] font-extrabold text-[#11120d]">Bin is empty</div>
            <div className="mt-1 max-w-[360px] text-[13px] font-semibold leading-6 text-[#8C8889]">
              Deleted documents and import reviews will appear here. Records are permanently purged after 30 days.
            </div>
          </div>
        ) : (
          <>
          {isStale ? (
            <div role={error ? "alert" : "status"} className="border-b border-amber-200 bg-amber-50 p-3 text-center text-sm font-semibold text-amber-800">
              {error ? "Unable to update this view. Showing previous results." : "Loading new results. Showing previous results."}
              {error ? <button type="button" onClick={() => void loadBin()} className="ml-2 underline underline-offset-2">Try again</button> : null}
            </div>
          ) : loading ? <div role="status" className="border-b border-slate-200 bg-slate-50 p-3 text-center text-sm text-slate-600">Refreshing bin...</div> : null}

          {records.map((record) => (
            <div
              key={record.id}
              className="flex flex-col gap-3 rounded-[16px] border border-[#DADDE3] bg-white px-4 py-4 shadow-sm transition-colors hover:bg-[#ECEFF3] lg:grid lg:grid-cols-[1.5fr_1fr_1fr_1fr_190px] lg:items-center lg:gap-3 lg:rounded-none lg:border-0 lg:py-3 lg:shadow-none"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-extrabold text-slate-900">
                  {record.entityLabel || record.entityId}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] font-semibold text-slate-500">
                  <span>Deleted {formatDate(record.createdAt)}</span>
                  <span className="lg:hidden">•</span>
                  <span className="lg:hidden">{ENTITY_LABELS[record.entityType] || record.entityType}</span>
                  <span className="lg:hidden">•</span>
                  <span className="lg:hidden">By {record.deletedBy?.name || "Unknown"}</span>
                </div>
              </div>
              <div className="hidden text-sm font-bold text-slate-700 lg:block">
                {ENTITY_LABELS[record.entityType] || record.entityType}
              </div>
              <div className="hidden text-sm font-semibold text-slate-600 lg:block">
                {record.deletedBy?.name || "Unknown"}
              </div>
              <div className="hidden text-sm font-semibold text-slate-600 lg:block">
                {formatDate(record.purgeAfter)}
              </div>
              <div className="mt-1 flex justify-end gap-2 lg:mt-0">
                <button
                  type="button"
                  disabled={isStale}
                  onClick={() => setPendingAction({ type: "restore", record })}
                  className="inline-flex h-[38px] w-[38px] items-center justify-center gap-2 rounded-[12px] border border-[#CFCFD3] bg-white text-[12px] font-extrabold hover:bg-[#F3F4F6] disabled:cursor-not-allowed disabled:opacity-50 lg:w-auto lg:px-3"
                  title="Restore"
                >
                  <Icon name="restore" sizePx={18} />
                  <span className="hidden lg:inline">Restore</span>
                </button>
                <button
                  type="button"
                  disabled={isStale}
                  onClick={() => setPendingAction({ type: "purge", record })}
                  className="inline-flex h-[38px] w-[38px] items-center justify-center gap-2 rounded-[12px] border border-[#FECDD3] bg-[#FFF1F2] text-[12px] font-extrabold text-[#BE123C] hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50 lg:w-auto lg:px-3"
                  title="Delete"
                >
                  <Icon name="delete" sizePx={18} />
                  <span className="hidden lg:inline">Delete</span>
                </button>
              </div>
            </div>
          ))}
          </>
        )}
        </div>

        {hasLoaded && !queryChanged && !error ? <div className="border-t border-[#E5E7EB] bg-white px-4 py-3">
          <PaginationBar
            page={page}
            totalPages={totalPages}
            pageSize={pageSize}
            total={total}
            start={pageStart}
            end={pageEnd}
            label="bin records"
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
          />
        </div> : null}
      </div>

      {pendingConfig ? (
        <ConfirmDialog
          open={!!pendingAction}
          title={pendingConfig.title}
          message={pendingConfig.message}
          confirmLabel={pendingConfig.confirmLabel}
          onConfirm={confirmPendingAction}
          onClose={() => setPendingAction(null)}
          tone={pendingConfig.tone}
          icon={pendingConfig.icon}
          busy={busy}
        />
      ) : null}
    </div>
  );
}
