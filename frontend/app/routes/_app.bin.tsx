import { useEffect, useMemo, useState } from "react";
import Icon from "~/components/ui/Icon";
import { ConfirmDialog } from "~/components/ui/Modal";
import PaginationBar from "~/components/ui/PaginationBar";
import { useToast } from "~/components/ui/Toast";
import {
  listBinApi,
  purgeBinRecordApi,
  restoreBinRecordApi,
  type BinRecord,
} from "~/lib/api/endpoints";

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
  const [records, setRecords] = useState<BinRecord[]>([]);
  const [entityType, setEntityType] = useState("ALL");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [busy, setBusy] = useState(false);

  async function loadBin() {
    try {
      setLoading(true);
      const res = await listBinApi({
        entityType: entityType === "ALL" ? undefined : entityType,
        page,
        pageSize,
      });
      setRecords(res.records);
      setTotal(res.total);
      setTotalPages(Math.max(1, res.totalPages));
    } catch (err: any) {
      showToast("danger", err?.message || "Failed to load bin");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadBin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType, page, pageSize]);

  const counts = useMemo(() => {
    return records.reduce<Record<string, number>>((acc, record) => {
      acc[record.entityType] = (acc[record.entityType] || 0) + 1;
      return acc;
    }, {});
  }, [records]);

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
    <div className="min-h-full bg-[#F1F1F1] p-6 text-slate-900">
      <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold">Bin</h1>
          <p className="mt-1 text-sm font-medium text-slate-500">
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

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-[18px] border border-[#CFCFD3] bg-white p-3">
        {["ALL", "Document", "ProductImportBatch"].map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => {
              setEntityType(type);
              setPage(1);
            }}
            className={[
              "rounded-[14px] border px-4 py-2 text-[13px] font-extrabold transition",
              entityType === type
                ? "border-[#11120d] bg-[#11120d] text-white"
                : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6]",
            ].join(" ")}
          >
            {type === "ALL" ? "All" : ENTITY_LABELS[type] || type}
            {type !== "ALL" && counts[type] ? ` (${counts[type]})` : ""}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-[20px] border border-[#CFCFD3] bg-white">
        <div className="grid grid-cols-[1.5fr_1fr_1fr_1fr_220px] border-b border-[#CFCFD3] bg-[#F3F4F6] px-5 py-3 text-[12px] font-extrabold uppercase tracking-wide text-[#77736A]">
          <div>Record</div>
          <div>Type</div>
          <div>Deleted By</div>
          <div>Purge After</div>
          <div className="text-right">Actions</div>
        </div>

        {loading ? (
          <div className="flex h-[260px] items-center justify-center text-sm font-semibold text-slate-400">
            Loading bin...
          </div>
        ) : records.length === 0 ? (
          <div className="flex h-[260px] flex-col items-center justify-center gap-2 text-center">
            <Icon name="delete" sizePx={36} className="text-slate-300" />
            <div className="text-sm font-extrabold">Bin is empty</div>
            <div className="text-xs font-semibold text-slate-400">
              Deleted documents and import reviews will appear here.
            </div>
          </div>
        ) : (
          records.map((record) => (
            <div
              key={record.id}
              className="grid grid-cols-[1.5fr_1fr_1fr_1fr_220px] items-center gap-3 border-b border-[#E5E7EB] px-5 py-4 last:border-b-0"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-extrabold">
                  {record.entityLabel || record.entityId}
                </div>
                <div className="mt-1 text-[12px] font-semibold text-slate-500">
                  Deleted {formatDate(record.createdAt)}
                </div>
              </div>
              <div className="text-sm font-bold text-slate-700">
                {ENTITY_LABELS[record.entityType] || record.entityType}
              </div>
              <div className="text-sm font-semibold text-slate-600">
                {record.deletedBy?.name || "Unknown"}
              </div>
              <div className="text-sm font-semibold text-slate-600">
                {formatDate(record.purgeAfter)}
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPendingAction({ type: "restore", record })}
                  className="inline-flex h-[38px] items-center justify-center gap-2 rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-extrabold hover:bg-[#F3F4F6]"
                >
                  <Icon name="restore" />
                  Restore
                </button>
                <button
                  type="button"
                  onClick={() => setPendingAction({ type: "purge", record })}
                  className="inline-flex h-[38px] items-center justify-center gap-2 rounded-[12px] border border-[#FECDD3] bg-[#FFF1F2] px-3 text-[12px] font-extrabold text-[#BE123C] hover:bg-rose-100"
                >
                  <Icon name="delete" />
                  Delete
                </button>
              </div>
            </div>
          ))
        )}

        <div className="border-t border-[#CFCFD3] px-4 py-3">
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
        </div>
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
