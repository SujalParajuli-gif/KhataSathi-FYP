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
  const role = currentUser?.role?.toLowerCase();
  const isReviewer = role === "admin" || role === "manager";
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
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200   ">
            <Icon name="check_circle" className="w-3 h-3 text-emerald-500" />
            Verified
          </span>
        );
      case "RECORDED":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200   ">
            <Icon name="schedule" className="w-3 h-3 text-blue-500" />
            Recorded
          </span>
        );
      case "MISSING":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200   ">
            <Icon name="warning" className="w-3 h-3 text-rose-500" />
            Missing Paper Bill
          </span>
        );
      case "PENDING":
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200   ">
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
            <span className="p-2 rounded-xl bg-control-hover text-action   border border-control-line ">
              <Icon name="receipt" className="w-6 h-6" />
            </span>
            <div>
              <h1 className="text-2xl font-bold text-action ">
                Paper Bill Recording & Review
              </h1>
              <p className="text-sm text-secondary ">
                Record manual physical receipts, verify references, and attach scanned proof documents.
              </p>
            </div>
          </div>
        </div>

        {/* Tab switcher */}
        <div className="flex items-center bg-control-hover  p-1 rounded-xl border border-control-line ">
          <button
            type="button"
            onClick={() => {
              setSearchParams({ tab: "queue" });
            }}
            className={cn(
              "flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all",
              activeTab === "queue"
                ? "bg-white  text-action  shadow-sm"
                : "text-secondary  hover:text-action ",
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
                ? "bg-white  text-action  shadow-sm"
                : "text-secondary  hover:text-action ",
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
            <div className="p-4 rounded-xl bg-amber-50/50  border border-amber-200/60 ">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-amber-700 ">
                  Pending Entry
                </span>
                <Icon name="description" className="w-4 h-4 text-amber-500" />
              </div>
              <p className="mt-2 text-2xl font-bold text-amber-900 ">
                {statusMetrics.pending}
              </p>
            </div>

            <div className="p-4 rounded-xl bg-control-hover  border border-blue-200/60 ">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-blue-700 ">
                  Recorded / Review
                </span>
                <Icon name="schedule" className="w-4 h-4 text-blue-500" />
              </div>
              <p className="mt-2 text-2xl font-bold text-blue-900 ">
                {statusMetrics.recorded}
              </p>
            </div>

            <div className="p-4 rounded-xl bg-emerald-50/50  border border-emerald-200/60 ">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-emerald-700 ">
                  Verified
                </span>
                <Icon name="check_circle" className="w-4 h-4 text-emerald-500" />
              </div>
              <p className="mt-2 text-2xl font-bold text-emerald-900 ">
                {statusMetrics.verified}
              </p>
            </div>

            <div className="p-4 rounded-xl bg-rose-50/50  border border-rose-200/60 ">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-rose-700 ">
                  Missing Bills
                </span>
                <Icon name="warning" className="w-4 h-4 text-rose-500" />
              </div>
              <p className="mt-2 text-2xl font-bold text-rose-900 ">
                {statusMetrics.missing}
              </p>
            </div>
          </div>

          {/* Filters Bar */}
          <div className="p-4 rounded-xl bg-white  border border-control-line  shadow-sm space-y-3">
            <form onSubmit={handleSearchSubmit} className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
              <div className="relative flex-1">
                <Icon
                  name="search"
                  className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-placeholder"
                />
                <input
                  type="text"
                  placeholder="Search invoice #, paper bill #, customer..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-9 pr-4 py-2 text-sm rounded-lg border border-control-line  bg-control-hover  text-action  placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-action"
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
                  className="px-4 py-2 rounded-lg bg-action hover:bg-black text-white text-sm font-medium transition-colors"
                >
                  Filter
                </button>

                {(searchQuery || statusFilter !== "ALL") && (
                  <button
                    type="button"
                    onClick={handleResetFilters}
                    className="p-2 rounded-lg text-secondary hover:text-action  hover:bg-control-hover  transition-colors"
                    title="Reset Filters"
                  >
                    <Icon name="restart_alt" className="w-4 h-4" />
                  </button>
                )}
              </div>
            </form>
          </div>

          {/* Queue Table */}
          <div className="rounded-xl border border-control-line  bg-white  shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-control-hover  text-secondary  font-semibold border-b border-control-line ">
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
                <tbody className="divide-y divide-neutral-200  text-action ">
                  {isLoading ? (
                    <tr>
                      <td colSpan={8} className="text-center py-12 text-secondary">
                        <Icon name="refresh" className="w-6 h-6 animate-spin mx-auto text-action" />
                        <span className="block mt-2 text-sm">Loading queue...</span>
                      </td>
                    </tr>
                  ) : items.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="text-center py-12 text-secondary">
                        <Icon name="inbox" className="w-8 h-8 mx-auto text-placeholder mb-2" />
                        <p className="font-medium text-secondary ">
                          No manual paper bills found
                        </p>
                        <p className="text-xs text-placeholder mt-1">
                          Try adjusting search filters.
                        </p>
                      </td>
                    </tr>
                  ) : (
                    items.map((item) => (
                      <tr
                        key={item.id}
                        className="hover:bg-control-hover  transition-colors"
                      >
                        <td className="px-4 py-3 font-medium">
                          <button
                            type="button"
                            onClick={() => handleOpenInvoiceModal(item.id)}
                            className="text-action hover:text-action  hover:underline flex items-center gap-1 font-mono text-xs"
                          >
                            {item.invoiceNo}
                            {loadingInvoiceId === item.id && (
                              <Icon name="refresh" className="w-3 h-3 animate-spin text-action" />
                            )}
                          </button>
                        </td>
                        <td className="px-4 py-3 text-secondary text-xs">
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
                            <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-control-hover  text-action ">
                              {item.externalBillNo}
                            </span>
                          ) : (
                            <span className="text-xs text-placeholder italic">Not recorded</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {renderStatusBadge(item.billRecordStatus)}
                        </td>
                        <td className="px-4 py-3">
                          {item.attachedProofCount > 0 ? (
                            <span className="inline-flex items-center gap-1 text-xs text-emerald-600  font-medium">
                              <Icon name="attach_file" className="w-3.5 h-3.5" />
                              {item.attachedProofCount} proof{item.attachedProofCount > 1 ? "s" : ""}
                            </span>
                          ) : (
                            <span className="text-xs text-placeholder">None</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {/* Record Button */}
                            <button
                              type="button"
                              onClick={() => handleOpenRecordingForm(item)}
                              className="px-2.5 py-1 text-xs font-medium rounded-lg bg-control-hover text-action hover:bg-control-hover    transition-colors"
                            >
                              {item.externalBillNo ? "Edit Ref" : "Record"}
                            </button>

                            {/* Review Button */}
                            <button
                              type="button"
                              onClick={() => setSelectedInvoiceId(item.id)}
                              className="px-2.5 py-1 text-xs font-medium rounded-lg bg-control-hover text-secondary hover:bg-neutral-200    transition-colors"
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
              <div className="p-4 border-t border-control-line ">
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
