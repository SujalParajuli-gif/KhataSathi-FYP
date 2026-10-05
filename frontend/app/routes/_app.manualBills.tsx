import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import Icon from "~/components/ui/Icon";
import ProjectSelect from "~/components/ui/ProjectSelect";
import ProjectDateInput from "~/components/ui/ProjectDateInput";
import PaginationBar from "~/components/ui/PaginationBar";
import { useToast } from "~/components/ui/Toast";
import { ModalFrame } from "~/components/ui/Modal";
import { getAuthUser } from "~/lib/auth";
import {
  getManualBillQueue,
  getManualBillRecord,
  type BillRecordStatus,
  type ManualBillQueueItem,
  type ManualBillRecord,
} from "~/lib/api/manualBills";
import { getInvoiceApi } from "~/lib/api/endpoints";
import type { AppInvoice } from "~/lib/invoices";
import { normalizeInvoice, formatNpr } from "~/lib/invoices";
import ManualBillEvidenceWorkspace from "~/components/manualBills/ManualBillEvidenceWorkspace";
import ManualBillReferenceForm from "~/components/manualBills/ManualBillReferenceForm";
import ManualBillSummary from "~/components/manualBills/ManualBillSummary";
import InvoiceDetailModal from "~/components/invoices/InvoiceDetailModal";

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

export default function ManualBillsRoute() {
  const { showToast } = useToast();
  const currentUser = getAuthUser();
  const [searchParams, setSearchParams] = useSearchParams();

  const isReviewer = currentUser?.role === "admin" || currentUser?.role === "manager";
  const activeTab = isReviewer && searchParams.get("tab") === "evidence" ? "evidence" : "queue";
  const [statusFilter, setStatusFilter] = useState<"ALL" | "PENDING" | "MISSING">(
    (searchParams.get("status") as "ALL" | "PENDING" | "MISSING") || "ALL",
  );
  const [searchQuery, setSearchQuery] = useState(searchParams.get("q") || "");

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);
  const [items, setItems] = useState<ManualBillQueueItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(false);

  // Modals state
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);
  const [recordingInvoice, setRecordingInvoice] = useState<{
    id: string;
    invoiceNo: string;
    currentRecord?: ManualBillRecord | null;
  } | null>(null);
  const [viewInvoice, setViewInvoice] = useState<AppInvoice | null>(null);
  const [loadingInvoiceId, setLoadingInvoiceId] = useState<string | null>(null);

  const loadQueue = async () => {
    setIsLoading(true);
    try {
      const res = await getManualBillQueue({
        page,
        pageSize,
        status: statusFilter,
        search: searchQuery.trim() || undefined,
      });

      setItems(res.items);
      setTotalCount(res.total);
      setTotalPages(res.totalPages || 1);
    } catch (err: any) {
      showToast(
        "danger",
        err.message || "Failed to load paper bill recording queue",
      );
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === "queue") {
      loadQueue();
    }
  }, [activeTab, page, pageSize, statusFilter]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    loadQueue();
  };

  const handleResetFilters = () => {
    setStatusFilter("ALL");
    setSearchQuery("");
    setPage(1);
  };

  const handleOpenInvoiceModal = async (invoiceId: string) => {
    setLoadingInvoiceId(invoiceId);
    try {
      const res = await getInvoiceApi(invoiceId);
      const normalized = normalizeInvoice(res.invoice || res);
      setViewInvoice(normalized);
    } catch (err: any) {
      showToast("danger", err.message || "Invoice details unavailable");
    } finally {
      setLoadingInvoiceId(null);
    }
  };

  const handleOpenRecordingForm = async (item: ManualBillQueueItem) => {
    try {
      const record = await getManualBillRecord(item.id);
      setRecordingInvoice({
        id: item.id,
        invoiceNo: item.invoiceNo,
        currentRecord: record,
      });
    } catch {
      setRecordingInvoice({
        id: item.id,
        invoiceNo: item.invoiceNo,
        currentRecord: null,
      });
    }
  };

  const statusMetrics = useMemo(() => {
    let pending = 0;
    let recorded = 0;
    let verified = 0;
    let missing = 0;

    items.forEach((item) => {
      if (item.billRecordStatus === "PENDING" || !item.billRecordStatus) pending++;
      else if (item.billRecordStatus === "RECORDED") recorded++;
      else if (item.billRecordStatus === "VERIFIED") verified++;
      else if (item.billRecordStatus === "MISSING") missing++;
    });

    return { pending, recorded, verified, missing };
  }, [items]);

  const renderStatusBadge = (status: string | null) => {
    switch (status) {
      case "VERIFIED":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800">
            <Icon name="check_circle" className="w-3 h-3 text-emerald-500" />
            Verified
          </span>
        );
      case "RECORDED":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800">
            <Icon name="schedule" className="w-3 h-3 text-blue-500" />
            Recorded
          </span>
        );
      case "MISSING":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800">
            <Icon name="warning" className="w-3 h-3 text-rose-500" />
            Missing Paper Bill
          </span>
        );
      case "PENDING":
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800">
            <Icon name="description" className="w-3 h-3 text-amber-500" />
            Pending Recording
          </span>
        );
    }
  };

  const startRecord = (page - 1) * pageSize + (items.length > 0 ? 1 : 0);
  const endRecord = (page - 1) * pageSize + items.length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-900/50">
              <Icon name="receipt" className="w-6 h-6" />
            </span>
            <div>
              <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
                Paper Bill Recording & Review
              </h1>
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                Record manual physical receipts, verify references, and attach scanned proof documents.
              </p>
            </div>
          </div>
        </div>

        {/* Tab switcher */}
        <div className="flex items-center bg-neutral-100 dark:bg-neutral-800/80 p-1 rounded-xl border border-neutral-200 dark:border-neutral-700">
          <button
            type="button"
            onClick={() => {
              setSearchParams({ tab: "queue" });
            }}
            className={cn(
              "flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all",
              activeTab === "queue"
                ? "bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 shadow-sm"
                : "text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200",
            )}
          >
            <Icon name="list_alt" className="w-4 h-4" />
            Recording Queue
          </button>
          {isReviewer && <button
            type="button"
            onClick={() => {
              setSearchParams({ tab: "evidence" });
            }}
            className={cn(
              "flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all",
              activeTab === "evidence"
                ? "bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 shadow-sm"
                : "text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200",
            )}
          >
            <Icon name="attach_file" className="w-4 h-4" />
            Proof & Matching Workspace
          </button>}
        </div>
      </div>

      {activeTab === "evidence" ? (
        <ManualBillEvidenceWorkspace />
      ) : (
        <div className="space-y-6">
          {/* Quick Metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="p-4 rounded-xl bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200/60 dark:border-amber-800/40">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
                  Pending Entry
                </span>
                <Icon name="description" className="w-4 h-4 text-amber-500" />
              </div>
              <p className="mt-2 text-2xl font-bold text-amber-900 dark:text-amber-200">
                {statusMetrics.pending}
              </p>
            </div>

            <div className="p-4 rounded-xl bg-blue-50/50 dark:bg-blue-950/20 border border-blue-200/60 dark:border-blue-800/40">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-400">
                  Recorded / Review
                </span>
                <Icon name="schedule" className="w-4 h-4 text-blue-500" />
              </div>
              <p className="mt-2 text-2xl font-bold text-blue-900 dark:text-blue-200">
                {statusMetrics.recorded}
              </p>
            </div>

            <div className="p-4 rounded-xl bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-200/60 dark:border-emerald-800/40">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                  Verified
                </span>
                <Icon name="check_circle" className="w-4 h-4 text-emerald-500" />
              </div>
              <p className="mt-2 text-2xl font-bold text-emerald-900 dark:text-emerald-200">
                {statusMetrics.verified}
              </p>
            </div>

            <div className="p-4 rounded-xl bg-rose-50/50 dark:bg-rose-950/20 border border-rose-200/60 dark:border-rose-800/40">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-rose-700 dark:text-rose-400">
                  Missing Bills
                </span>
                <Icon name="warning" className="w-4 h-4 text-rose-500" />
              </div>
              <p className="mt-2 text-2xl font-bold text-rose-900 dark:text-rose-200">
                {statusMetrics.missing}
              </p>
            </div>
          </div>

          {/* Filters Bar */}
          <div className="p-4 rounded-xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 shadow-sm space-y-3">
            <form onSubmit={handleSearchSubmit} className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
              <div className="relative flex-1">
                <Icon
                  name="search"
                  className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400"
                />
                <input
                  type="text"
                  placeholder="Search invoice #, paper bill #, customer..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-9 pr-4 py-2 text-sm rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <ProjectSelect
                  value={statusFilter}
                  onChange={(e) => {
                    setStatusFilter(e.target.value as "ALL" | "PENDING" | "MISSING");
                    setPage(1);
                  }}
                >
                  <option value="ALL">All Statuses</option>
                  <option value="PENDING">Pending Recording</option>
                  <option value="MISSING">Missing Bill</option>
                </ProjectSelect>

                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium transition-colors"
                >
                  Filter
                </button>

                {(searchQuery || statusFilter !== "ALL") && (
                  <button
                    type="button"
                    onClick={handleResetFilters}
                    className="p-2 rounded-lg text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
                    title="Reset Filters"
                  >
                    <Icon name="restart_alt" className="w-4 h-4" />
                  </button>
                )}
              </div>
            </form>
          </div>

          {/* Queue Table */}
          <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-neutral-50 dark:bg-neutral-800/50 text-neutral-600 dark:text-neutral-400 font-semibold border-b border-neutral-200 dark:border-neutral-800">
                  <tr>
                    <th className="px-4 py-3">Invoice #</th>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Customer</th>
                    <th className="px-4 py-3">Total Amount</th>
                    <th className="px-4 py-3">Paper Bill #</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Proof</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800 text-neutral-800 dark:text-neutral-200">
                  {isLoading ? (
                    <tr>
                      <td colSpan={8} className="text-center py-12 text-neutral-500">
                        <Icon name="refresh" className="w-6 h-6 animate-spin mx-auto text-indigo-500" />
                        <span className="block mt-2 text-sm">Loading queue...</span>
                      </td>
                    </tr>
                  ) : items.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="text-center py-12 text-neutral-500">
                        <Icon name="inbox" className="w-8 h-8 mx-auto text-neutral-400 mb-2" />
                        <p className="font-medium text-neutral-700 dark:text-neutral-300">
                          No manual paper bills found
                        </p>
                        <p className="text-xs text-neutral-400 mt-1">
                          Try adjusting search filters.
                        </p>
                      </td>
                    </tr>
                  ) : (
                    items.map((item) => (
                      <tr
                        key={item.id}
                        className="hover:bg-neutral-50 dark:hover:bg-neutral-800/40 transition-colors"
                      >
                        <td className="px-4 py-3 font-medium">
                          <button
                            type="button"
                            onClick={() => handleOpenInvoiceModal(item.id)}
                            className="text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 hover:underline flex items-center gap-1 font-mono text-xs"
                          >
                            {item.invoiceNo}
                            {loadingInvoiceId === item.id && (
                              <Icon name="refresh" className="w-3 h-3 animate-spin text-indigo-500" />
                            )}
                          </button>
                        </td>
                        <td className="px-4 py-3 text-neutral-500 text-xs">
                          {item.finalizedAt ? new Date(item.finalizedAt).toLocaleDateString() : "—"}
                        </td>
                        <td className="px-4 py-3">
                          <span className="font-medium text-xs block">
                            {item.customerName || "Walk-in Customer"}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-semibold text-xs">
                          {formatNpr(item.netTotal)}
                        </td>
                        <td className="px-4 py-3">
                          {item.externalBillNo ? (
                            <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200">
                              {item.externalBillNo}
                            </span>
                          ) : (
                            <span className="text-xs text-neutral-400 italic">Not recorded</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {renderStatusBadge(item.billRecordStatus)}
                        </td>
                        <td className="px-4 py-3">
                          {item.attachedProofCount > 0 ? (
                            <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                              <Icon name="attach_file" className="w-3.5 h-3.5" />
                              {item.attachedProofCount} proof{item.attachedProofCount > 1 ? "s" : ""}
                            </span>
                          ) : (
                            <span className="text-xs text-neutral-400">None</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {/* Record Button */}
                            <button
                              type="button"
                              onClick={() => handleOpenRecordingForm(item)}
                              className="px-2.5 py-1 text-xs font-medium rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-950/50 dark:text-indigo-300 dark:hover:bg-indigo-900/50 transition-colors"
                            >
                              {item.externalBillNo ? "Edit Ref" : "Record"}
                            </button>

                            {/* Review Button */}
                            <button
                              type="button"
                              onClick={() => setSelectedInvoiceId(item.id)}
                              className="px-2.5 py-1 text-xs font-medium rounded-lg bg-neutral-100 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700 transition-colors"
                            >
                              Review
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="p-4 border-t border-neutral-200 dark:border-neutral-800">
                <PaginationBar
                  page={page}
                  totalPages={totalPages}
                  total={totalCount}
                  start={startRecord}
                  end={endRecord}
                  pageSize={pageSize}
                  onPageChange={setPage}
                  onPageSizeChange={(newSize) => {
                    setPageSize(newSize);
                    setPage(1);
                  }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Record Reference Modal */}
      {recordingInvoice && (
        <ModalFrame
          open={Boolean(recordingInvoice)}
          onClose={() => setRecordingInvoice(null)}
          title="Record Paper Bill Reference"
          description={`Invoice #${recordingInvoice.invoiceNo}`}
          maxWidthClass="max-w-[560px]"
        >
          <ManualBillReferenceForm
            invoiceId={recordingInvoice.id}
            currentRecord={recordingInvoice.currentRecord}
            isReviewer={
              currentUser?.role?.toUpperCase() === "ADMIN" ||
              currentUser?.role?.toUpperCase() === "MANAGER"
            }
            onSuccess={() => {
              setRecordingInvoice(null);
              loadQueue();
            }}
            onCancel={() => setRecordingInvoice(null)}
          />
        </ModalFrame>
      )}

      {/* Review Modal */}
      {selectedInvoiceId && (
        <ModalFrame
          open={Boolean(selectedInvoiceId)}
          onClose={() => setSelectedInvoiceId(null)}
          title="Manual Paper Bill Review"
          maxWidthClass="max-w-[700px]"
        >
          <ManualBillSummary
            invoiceId={selectedInvoiceId}
            onRefresh={() => {
              loadQueue();
            }}
          />
        </ModalFrame>
      )}

      {/* Full Invoice Modal */}
      {viewInvoice && (
        <InvoiceDetailModal
          open={true}
          invoice={viewInvoice}
          onClose={() => setViewInvoice(null)}
        />
      )}
    </div>
  );
}
