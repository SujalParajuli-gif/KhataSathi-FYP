import ProjectSelect from "~/components/ui/ProjectSelect";
import React, { useEffect, useRef, useState } from "react";
import type { AttachedProofSummary, ManualBillRecord } from "~/lib/api/manualBills";
import {
  fetchManualBillProofBlob,
  getManualBillRecord,
  markManualBillMissing,
  verifyManualBillReference,
  withdrawManualBillReference,
} from "~/lib/api/manualBills";
import GIcon from "~/components/ui/GIcon";
import { ModalFrame as Modal } from "~/components/ui/Modal";
import ManualBillReferenceForm from "./ManualBillReferenceForm";
import { getAuthUser } from "~/lib/auth";

interface Props {
  record?: ManualBillRecord | null;
  invoiceId?: string;
  onRefresh?: () => void;
  userRole?: "admin" | "manager" | "cashier" | "staff";
}

export function BillStatusBadge({ status }: { status: string | null }) {
  if (status === "VERIFIED") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-bold text-emerald-800">
        <GIcon name="check_circle" className="text-[13px]" />
        VERIFIED
      </span>
    );
  }
  if (status === "RECORDED") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-[11px] font-bold text-blue-800">
        <GIcon name="description" className="text-[13px]" />
        RECORDED
      </span>
    );
  }
  if (status === "MISSING") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2.5 py-0.5 text-[11px] font-bold text-rose-800">
        <GIcon name="warning" className="text-[13px]" />
        MISSING
      </span>
    );
  }
  if (status === "PENDING") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-bold text-amber-800">
        <GIcon name="schedule" className="text-[13px]" />
        PENDING
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-control-hover px-2.5 py-0.5 text-[11px] font-medium text-secondary">
      UNTRACKED
    </span>
  );
}

export default function ManualBillSummary({
  record: propRecord,
  invoiceId,
  onRefresh,
  userRole: propUserRole,
}: Props) {
  const authUser = getAuthUser();
  const userRole = propUserRole || (authUser?.role ? (authUser.role.toLowerCase() as any) : "cashier");
  const isReviewer = userRole === "admin" || userRole === "manager";

  const [activeRecord, setActiveRecord] = useState<ManualBillRecord | null>(propRecord || null);
  const [fetchingRecord, setFetchingRecord] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [verifyReason, setVerifyReason] = useState("");
  const [missingOpen, setMissingOpen] = useState(false);
  const [missingReason, setMissingReason] = useState("");
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState("");
  const [withdrawTarget, setWithdrawTarget] = useState<"PENDING" | "MISSING">("PENDING");

  const [loading, setLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Proof blob preview state
  const [previewProof, setPreviewProof] = useState<{
    summary: AttachedProofSummary;
    blobUrl: string;
  } | null>(null);
  const [loadingProofId, setLoadingProofId] = useState<string | null>(null);
  const proofRequest = useRef(0);
  useEffect(() => () => { proofRequest.current++; }, []);
  useEffect(() => () => {
    if (previewProof) URL.revokeObjectURL(previewProof.blobUrl);
  }, [previewProof]);

  const loadRecord = async () => {
    if (!invoiceId) return;
    setFetchingRecord(true);
    setFetchError(null);
    try {
      const fetched = await getManualBillRecord(invoiceId);
      setActiveRecord(fetched);
    } catch (err: any) {
      setFetchError(err?.message || "Failed to load manual paper bill details");
    } finally {
      setFetchingRecord(false);
    }
  };

  useEffect(() => {
    if (propRecord) {
      setActiveRecord(propRecord);
    } else if (invoiceId) {
      loadRecord();
    }
  }, [propRecord, invoiceId]);

  const handleUpdated = () => {
    if (invoiceId) loadRecord();
    if (onRefresh) onRefresh();
  };

  const handleOpenProof = async (proof: AttachedProofSummary) => {
    if (!activeRecord) return;
    setLoadingProofId(proof.id);
    const request = ++proofRequest.current;
    try {
      const blob = await fetchManualBillProofBlob(activeRecord.id, proof.id);
      if (request !== proofRequest.current) return;
      const blobUrl = URL.createObjectURL(blob);
      setPreviewProof({ summary: proof, blobUrl });
    } catch (err: any) {
      setActionError(err?.message || "Failed to load attached proof document.");
    } finally {
      setLoadingProofId(null);
    }
  };

  const handleClosePreview = () => {
    proofRequest.current++;
    if (previewProof) {
      setPreviewProof(null);
    }
  };

  if (fetchingRecord) {
    return (
      <div className="flex items-center justify-center p-6 text-sm text-secondary">
        <GIcon name="refresh" className="animate-spin text-lg mr-2" />
        Loading paper bill details...
      </div>
    );
  }

  if (fetchError && !activeRecord) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-xs text-red-700">
        {fetchError}
      </div>
    );
  }

  const record = activeRecord;
  if (!record) {
    return (
      <div className="p-4 text-center text-xs text-placeholder italic">
        No paper bill reference recorded.
      </div>
    );
  }

  const canEdit =
    record.status === "FINALIZED" &&
    record.paymentStatus !== "CANCELLED" &&
    (isReviewer ||
      record.billRecordStatus === "PENDING" ||
      record.billRecordStatus === "MISSING" ||
      record.billRecordStatus === null);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setActionError(null);
    if (!verifyReason.trim()) {
      setActionError("Verification note is required.");
      return;
    }
    setLoading(true);
    try {
      await verifyManualBillReference(record!.id, {
        reason: verifyReason.trim(),
        expected: {
          billingChannel: record!.billingChannel,
          externalDocumentType: record!.externalDocumentType,
          externalBillNo: record!.externalBillNo,
          externalBillDate: record!.externalBillDate,
          billRecordStatus: record!.billRecordStatus,
        },
      });
      setVerifyOpen(false);
      setVerifyReason("");
      handleUpdated();
    } catch (err: any) {
      setActionError(
        err?.response?.data?.error || err.message || "Failed to verify paper bill.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleMarkMissing(e: React.FormEvent) {
    e.preventDefault();
    setActionError(null);
    if (!missingReason.trim()) {
      setActionError("Missing note is required.");
      return;
    }
    setLoading(true);
    try {
      await markManualBillMissing(record!.id, {
        reason: missingReason.trim(),
        expected: {
          billingChannel: record!.billingChannel,
          externalDocumentType: record!.externalDocumentType,
          externalBillNo: record!.externalBillNo,
          externalBillDate: record!.externalBillDate,
          billRecordStatus: record!.billRecordStatus,
        },
      });
      setMissingOpen(false);
      setMissingReason("");
      handleUpdated();
    } catch (err: any) {
      setActionError(
        err?.response?.data?.error || err.message || "Failed to mark paper bill missing.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleWithdraw(e: React.FormEvent) {
    e.preventDefault();
    setActionError(null);
    if (!withdrawReason.trim()) {
      setActionError("Withdrawal reason is required.");
      return;
    }
    setLoading(true);
    try {
      await withdrawManualBillReference(record!.id, {
        targetStatus: withdrawTarget,
        reason: withdrawReason.trim(),
        expected: {
          billingChannel: record!.billingChannel,
          externalDocumentType: record!.externalDocumentType,
          externalBillNo: record!.externalBillNo,
          externalBillDate: record!.externalBillDate,
          billRecordStatus: record!.billRecordStatus,
        },
      });
      setWithdrawOpen(false);
      setWithdrawReason("");
      handleUpdated();
    } catch (err: any) {
      setActionError(
        err?.response?.data?.error || err.message || "Failed to withdraw paper bill.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Top Banner / Summary */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-control-line pb-3">
        <div className="flex items-center gap-2">
          <BillStatusBadge status={record.billRecordStatus} />
          {record.billingChannel === "MANUAL_EXTERNAL" && (
            <span className="rounded bg-control-hover px-2 py-0.5 text-[10px] font-semibold text-action">
              MANUAL EXTERNAL CHANNEL
            </span>
          )}
        </div>

        {canEdit && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setEditOpen(true)}
              className="inline-flex items-center gap-1 rounded border border-control-line bg-white px-2.5 py-1 text-xs font-semibold text-secondary shadow-xs hover:bg-control-hover"
            >
              <GIcon name="edit" className="text-[13px]" />
              {record.externalBillNo ? "Edit / Re-record" : "Record Reference"}
            </button>

            {isReviewer && record.billRecordStatus === "RECORDED" && (
              <button
                type="button"
                onClick={() => setVerifyOpen(true)}
                className="inline-flex items-center gap-1 rounded bg-action px-2.5 py-1 text-xs font-semibold text-white shadow-xs hover:bg-black"
              >
                <GIcon name="verified" className="text-[13px]" />
                Verify
              </button>
            )}

            {isReviewer &&
              (record.billRecordStatus === "RECORDED" ||
                record.billRecordStatus === "VERIFIED") && (
                <button
                  type="button"
                  onClick={() => setWithdrawOpen(true)}
                  className="inline-flex items-center gap-1 rounded border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-100"
                >
                  <GIcon name="undo" className="text-[13px]" />
                  Withdraw
                </button>
              )}

            {isReviewer && record.billRecordStatus !== "MISSING" && (
              <button
                type="button"
                onClick={() => setMissingOpen(true)}
                className="inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100"
              >
                <GIcon name="report_problem" className="text-[13px]" />
                Mark Missing
              </button>
            )}
          </div>
        )}
      </div>

      {actionError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-xs text-rose-700 flex items-center justify-between gap-2">
          <span>{actionError}</span>
          <button
            type="button"
            onClick={() => {
              loadRecord();
              setActionError(null);
            }}
            className="shrink-0 font-bold underline hover:text-rose-900"
          >
            Refresh
          </button>
        </div>
      )}

      {/* Replacement / Original Relations */}
      {(record.originalInvoiceId || record.replacementInvoiceId) && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-2.5 text-xs text-amber-900 space-y-1">
          {record.originalInvoiceId && (
            <div className="flex items-center gap-1.5 font-medium">
              <GIcon name="swap_horiz" className="text-amber-700" />
              <span>
                Replacement invoice created for original sale:{" "}
                <span className="font-mono font-bold">#{record.originalInvoiceId}</span>
              </span>
            </div>
          )}
          {record.replacementInvoiceId && (
            <div className="flex items-center gap-1.5 font-medium">
              <GIcon name="history" className="text-amber-700" />
              <span>
                Superseded by replacement invoice:{" "}
                <span className="font-mono font-bold">#{record.replacementInvoiceId}</span>
              </span>
            </div>
          )}
        </div>
      )}

      {/* Details Grid */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-control-line bg-control-hover/50 p-2.5">
          <div className="text-[11px] font-medium text-secondary">
            Paper Bill Number
          </div>
          <div className="mt-0.5 font-mono text-sm font-bold text-action">
            {record.externalBillNo || (
              <span className="font-sans text-xs text-placeholder italic">
                Not recorded
              </span>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-control-line bg-control-hover/50 p-2.5">
          <div className="text-[11px] font-medium text-secondary">
            Document Type
          </div>
          <div className="mt-0.5 text-xs font-semibold text-action">
            {record.externalDocumentType
              ? record.externalDocumentType.replace(/_/g, " ")
              : "—"}
          </div>
        </div>

        <div className="rounded-lg border border-control-line bg-control-hover/50 p-2.5">
          <div className="text-[11px] font-medium text-secondary">
            Physical Bill Date
          </div>
          <div className="mt-0.5 font-mono text-xs font-semibold text-action">
            {record.externalBillDate || "—"}
          </div>
        </div>
      </div>

      {/* Attached Proofs Summary */}
      {(() => {
        const attachedProofs = Array.isArray(record.attachedProofs) ? record.attachedProofs : [];
        const history = Array.isArray(record.history) ? record.history : [];
        return (
          <>
            <div className="rounded-lg border border-control-line bg-white p-3">
              <div className="flex items-center justify-between text-xs font-bold text-secondary">
                <span className="flex items-center gap-1.5">
                  <GIcon name="attach_file" className="text-secondary" />
                  Attached Proof Documents ({attachedProofs.length})
                </span>
              </div>

              {attachedProofs.length === 0 ? (
                <p className="mt-2 text-xs text-placeholder italic">
                  No scanned proof documents attached to this manual bill reference.
                </p>
              ) : (
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {attachedProofs.map((proof) => (
                    <div
                      key={proof.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-control-line bg-control-hover p-2 text-xs"
                    >
                      <div className="flex items-center gap-2 overflow-hidden">
                        <GIcon name="image" className="shrink-0 text-placeholder" />
                        <div className="truncate">
                          <div className="font-semibold text-action truncate">
                            {proof.title || proof.fileName}
                          </div>
                          <div className="text-[10px] text-placeholder">
                            {(proof.fileSize / 1024).toFixed(1)} KB •{" "}
                            {new Date(proof.createdAt).toLocaleDateString()}
                          </div>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleOpenProof(proof)}
                        disabled={loadingProofId === proof.id}
                        className="shrink-0 rounded bg-white px-2 py-1 text-[11px] font-bold text-secondary shadow-2xs hover:text-action border border-control-line"
                        title="View Document"
                      >
                        {loadingProofId === proof.id ? (
                          <GIcon name="refresh" className="animate-spin text-[13px]" />
                        ) : (
                          <span className="flex items-center gap-1">
                            <GIcon name="visibility" className="text-[13px]" />
                            View
                          </span>
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Audit History */}
            {history.length > 0 && (
              <div className="rounded-lg border border-control-line bg-white p-3">
                <div className="text-xs font-bold text-secondary mb-2 flex items-center gap-1">
                  <GIcon name="history" className="text-secondary text-sm" />
                  Recording & Review History
                </div>
                <div className="space-y-2 max-h-40 overflow-y-auto pr-1">
                  {history.map((entry) => (
                    <div
                      key={entry.id}
                      className="flex items-start justify-between text-xs border-b border-gray-50 pb-1.5 last:border-0"
                    >
                      <div>
                        <span className="font-semibold text-action">
                          {entry.action.replace(/_/g, " ")}
                        </span>
                        {entry.actorName && (
                          <span className="text-secondary text-[11px] ml-1">
                            by {entry.actorName} ({entry.actorRole || "Staff"})
                          </span>
                        )}
                        {Boolean(entry.meta?.reason) ? (
                          <div className="text-secondary text-[11px] italic mt-0.5">
                            "{String(entry.meta?.reason)}"
                          </div>
                        ) : null}
                      </div>
                      <span className="text-[10px] text-placeholder shrink-0 ml-2">
                        {new Date(entry.createdAt).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        );
      })()}

      {/* Edit Reference Modal */}
      {editOpen && (
        <Modal
          open={editOpen}
          onClose={() => setEditOpen(false)}
          title="Record / Edit Manual Paper Bill"
        >
          <ManualBillReferenceForm
            invoiceId={record.id}
            currentRecord={record}
            isReviewer={isReviewer}
            onSuccess={() => {
              setEditOpen(false);
              handleUpdated();
            }}
            onCancel={() => setEditOpen(false)}
          />
        </Modal>
      )}

      {/* Verify Modal */}
      {verifyOpen && (
        <Modal
          open={verifyOpen}
          onClose={() => setVerifyOpen(false)}
          title="Verify Manual Paper Bill Reference"
        >
          <form onSubmit={handleVerify} className="space-y-4">
            <p className="text-xs text-secondary">
              Confirm that the physical paper bill reference{" "}
              <span className="font-mono font-bold text-action">
                {record.externalBillNo}
              </span>{" "}
              matches the paper leaf.
            </p>

            <div>
              <label className="block text-xs font-semibold text-secondary mb-1">
                Verification Note *
              </label>
              <textarea
                value={verifyReason}
                onChange={(e) => setVerifyReason(e.target.value)}
                placeholder="e.g. Physical counter stamp and signature verified"
                rows={3}
                required
                className="w-full rounded-md border border-control-line p-2 text-xs focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setVerifyOpen(false)}
                disabled={loading}
                className="rounded border border-control-line px-3 py-1.5 text-xs font-semibold text-secondary hover:bg-control-hover"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || !verifyReason.trim()}
                className="rounded bg-action px-3 py-1.5 text-xs font-semibold text-white hover:bg-black disabled:opacity-50"
              >
                {loading ? "Verifying..." : "Confirm Verification"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Mark Missing Modal */}
      {missingOpen && (
        <Modal
          open={missingOpen}
          onClose={() => setMissingOpen(false)}
          title="Mark Physical Paper Bill Missing"
        >
          <form onSubmit={handleMarkMissing} className="space-y-4">
            <p className="text-xs text-secondary">
              Mark this manual sale's paper receipt as missing. This clears any recorded paper bill number and flags the invoice for supervisor follow-up.
            </p>

            <div>
              <label className="block text-xs font-semibold text-secondary mb-1">
                Reason for Missing Status *
              </label>
              <textarea
                value={missingReason}
                onChange={(e) => setMissingReason(e.target.value)}
                placeholder="e.g. Paper receipt book lost by cashier"
                rows={3}
                required
                className="w-full rounded-md border border-control-line p-2 text-xs focus:border-rose-500 focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setMissingOpen(false)}
                disabled={loading}
                className="rounded border border-control-line px-3 py-1.5 text-xs font-semibold text-secondary hover:bg-control-hover"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || !missingReason.trim()}
                className="rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {loading ? "Saving..." : "Mark as Missing"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Withdraw Modal */}
      {withdrawOpen && (
        <Modal
          open={withdrawOpen}
          onClose={() => setWithdrawOpen(false)}
          title="Withdraw Paper Bill Reference"
        >
          <form onSubmit={handleWithdraw} className="space-y-4">
            <p className="text-xs text-secondary">
              Withdraw the recorded paper reference{" "}
              <span className="font-mono font-bold text-action">
                {record.externalBillNo}
              </span>
              . Previous details will remain preserved in the audit log.
            </p>

            <div>
              <label className="block text-xs font-semibold text-secondary mb-1">
                Target Status After Withdrawal
              </label>
              <ProjectSelect
                    aria-label="Record status"
                value={withdrawTarget}
                onChange={(e) => setWithdrawTarget(e.target.value as any)}
                className="w-full rounded-md border border-control-line p-2 text-xs focus:outline-none"
              >
                <option value="PENDING">PENDING (Await Re-recording)</option>
                <option value="MISSING">MISSING (Physical Slip Lost)</option>
              </ProjectSelect>
            </div>

            <div>
              <label className="block text-xs font-semibold text-secondary mb-1">
                Withdrawal Reason *
              </label>
              <textarea
                value={withdrawReason}
                onChange={(e) => setWithdrawReason(e.target.value)}
                placeholder="e.g. Typo in bill number, re-recording with correct book series"
                rows={3}
                required
                className="w-full rounded-md border border-control-line p-2 text-xs focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setWithdrawOpen(false)}
                disabled={loading}
                className="rounded border border-control-line px-3 py-1.5 text-xs font-semibold text-secondary hover:bg-control-hover"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || !withdrawReason.trim()}
                className="rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {loading ? "Processing..." : "Confirm Withdrawal"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Proof Preview Modal with Authenticated Blob */}
      {previewProof && (
        <Modal
          open={Boolean(previewProof)}
          onClose={handleClosePreview}
          title={previewProof.summary.title || previewProof.summary.fileName}
        >
          <div className="flex flex-col items-center justify-center p-2">
            {previewProof.summary.mimeType.startsWith("image/") ? (
              <img
                src={previewProof.blobUrl}
                alt={previewProof.summary.title || previewProof.summary.fileName}
                className="max-h-[70vh] w-auto rounded-xl object-contain shadow-xs"
              />
            ) : (
              <iframe
                src={previewProof.blobUrl}
                title={previewProof.summary.title || previewProof.summary.fileName}
                className="h-[70vh] w-full rounded-xl border border-control-line"
              />
            )}
            <div className="mt-4 flex justify-between w-full text-[12px] text-secondary">
              <span>Attached Proof • {(previewProof.summary.fileSize / 1024).toFixed(1)} KB</span>
              <a
                href={previewProof.blobUrl}
                download={previewProof.summary.fileName}
                className="font-bold text-black hover:underline"
              >
                Download File
              </a>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
