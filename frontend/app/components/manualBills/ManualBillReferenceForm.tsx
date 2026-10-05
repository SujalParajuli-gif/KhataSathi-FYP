import React, { useState } from "react";
import type {
  ExpectedManualBillRecord,
  ExternalDocumentType,
  ManualBillRecord,
} from "~/lib/api/manualBills";
import { recordManualBillReference } from "~/lib/api/manualBills";
import GIcon from "~/components/ui/GIcon";

interface Props {
  invoiceId: string;
  currentRecord?: ManualBillRecord | null;
  onSuccess: (updated: ManualBillRecord) => void;
  onCancel?: () => void;
  isReviewer?: boolean;
}

const DOCUMENT_TYPE_LABELS: Record<ExternalDocumentType, string> = {
  PAN_INVOICE: "PAN Manual Bill / Invoice",
  VAT_TAX_INVOICE: "VAT Tax Invoice",
  ABBREVIATED_TAX_INVOICE: "Abbreviated Tax Invoice",
  OTHER_MANUAL_SALES_DOCUMENT: "Other Manual Sales Document",
};

export default function ManualBillReferenceForm({
  invoiceId,
  currentRecord,
  onSuccess,
  onCancel,
  isReviewer = false,
}: Props) {
  const [billNo, setBillNo] = useState(currentRecord?.externalBillNo || "");
  const [externalDocumentType, setExternalDocumentType] =
    useState<ExternalDocumentType>(
      currentRecord?.externalDocumentType || "PAN_INVOICE",
    );
  const [externalBillDate, setExternalBillDate] = useState(
    currentRecord?.externalBillDate ||
      new Date().toISOString().slice(0, 10),
  );
  const [reason, setReason] = useState("");
  const [duplicateOverrideReason, setDuplicateOverrideReason] = useState("");
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);

  const [activeExpected, setActiveExpected] = useState<ExpectedManualBillRecord>({
    billingChannel: currentRecord?.billingChannel ?? null,
    externalDocumentType: currentRecord?.externalDocumentType ?? null,
    externalBillNo: currentRecord?.externalBillNo ?? null,
    externalBillDate: currentRecord?.externalBillDate ?? null,
    billRecordStatus: currentRecord?.billRecordStatus ?? null,
  });
  const [conflictRecord, setConflictRecord] = useState<ManualBillRecord | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEditing = Boolean(
    activeExpected.billRecordStatus === "RECORDED" ||
      activeExpected.billRecordStatus === "VERIFIED",
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setConflictRecord(null);

    const trimmedNo = billNo.trim();
    if (!trimmedNo) {
      setError("Paper bill number is required.");
      return;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(externalBillDate)) {
      setError("Paper bill date must be in YYYY-MM-DD format.");
      return;
    }

    setLoading(true);
    try {
      const res = await recordManualBillReference(invoiceId, {
        reference: {
          billNo: trimmedNo,
          externalDocumentType,
          externalBillDate,
        },
        expected: activeExpected,
        reason: reason.trim() || undefined,
        duplicateOverrideReason: duplicateOverrideReason.trim() || undefined,
      });
      onSuccess(res);
    } catch (err: any) {
      const responseData = err?.response?.data;
      if (responseData?.code === "DUPLICATE_REVIEW_REQUIRED") {
        setDuplicateWarning(
          responseData.error ||
            "Duplicate paper reference detected. Reviewer justification is required to override.",
        );
      } else if (responseData?.code === "STALE_RECORD_CONFLICT") {
        const current = responseData?.currentRecord as ManualBillRecord | undefined;
        if (current) {
          setConflictRecord(current);
          setError(
            responseData.error ||
              "The record was modified by another operator. Review the current values below.",
          );
        } else {
          setError(
            responseData.error ||
              "This record was modified by another operator. Please refresh.",
          );
        }
      } else {
        setError(
          responseData?.error || err.message || "Failed to record paper bill reference.",
        );
      }
    } finally {
      setLoading(false);
    }
  }

  function handleAcceptCurrentAndKeepInput() {
    if (!conflictRecord) return;
    setActiveExpected({
      billingChannel: conflictRecord.billingChannel ?? null,
      externalDocumentType: conflictRecord.externalDocumentType ?? null,
      externalBillNo: conflictRecord.externalBillNo ?? null,
      externalBillDate: conflictRecord.externalBillDate ?? null,
      billRecordStatus: conflictRecord.billRecordStatus ?? null,
    });
    setConflictRecord(null);
    setError(null);
  }

  function handleResetFormToCurrent() {
    if (!conflictRecord) return;
    setBillNo(conflictRecord.externalBillNo || "");
    if (conflictRecord.externalDocumentType) {
      setExternalDocumentType(conflictRecord.externalDocumentType);
    }
    if (conflictRecord.externalBillDate) {
      setExternalBillDate(conflictRecord.externalBillDate);
    }
    setActiveExpected({
      billingChannel: conflictRecord.billingChannel ?? null,
      externalDocumentType: conflictRecord.externalDocumentType ?? null,
      externalBillNo: conflictRecord.externalBillNo ?? null,
      externalBillDate: conflictRecord.externalBillDate ?? null,
      billRecordStatus: conflictRecord.billRecordStatus ?? null,
    });
    setConflictRecord(null);
    setError(null);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 text-left">
      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-[13px] font-medium text-rose-700 flex items-start gap-2">
          <GIcon name="error" className="shrink-0 text-rose-600 text-[18px] mt-0.5" />
          <div>{error}</div>
        </div>
      )}

      {conflictRecord && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-[13px] text-amber-900 space-y-2">
          <div className="flex items-center gap-2 font-bold text-amber-950">
            <GIcon name="swap_horiz" className="text-amber-700" />
            <span>Latest Committed State</span>
          </div>
          <div className="text-[12px] bg-white/80 rounded-lg p-2 border border-amber-200 font-mono">
            <div>Status: {conflictRecord.billRecordStatus || "UNTRACKED"}</div>
            <div>Bill No: {conflictRecord.externalBillNo || "—"}</div>
            <div>Date: {conflictRecord.externalBillDate || "—"}</div>
            <div>Type: {conflictRecord.externalDocumentType || "—"}</div>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={handleAcceptCurrentAndKeepInput}
              className="rounded-lg bg-amber-800 text-white px-3 py-1 text-[12px] font-bold hover:bg-amber-900"
            >
              Acknowledge & Keep My Input
            </button>
            <button
              type="button"
              onClick={handleResetFormToCurrent}
              className="rounded-lg border border-amber-400 bg-white px-3 py-1 text-[12px] font-bold text-amber-900 hover:bg-amber-100"
            >
              Reset Form to Latest
            </button>
          </div>
        </div>
      )}

      {duplicateWarning && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[13px] font-medium text-amber-800 space-y-2">
          <div className="flex items-start gap-2">
            <GIcon name="warning" className="shrink-0 text-amber-600 text-[18px] mt-0.5" />
            <div>{duplicateWarning}</div>
          </div>
          {isReviewer ? (
            <div>
              <label className="block text-[12px] font-bold text-amber-900 mb-1">
                Reviewer Override Justification *
              </label>
              <textarea
                value={duplicateOverrideReason}
                onChange={(e) => setDuplicateOverrideReason(e.target.value)}
                placeholder="Explain why this duplicate paper reference is authorized..."
                rows={2}
                className="w-full rounded-lg border border-amber-300 bg-white p-2 text-[13px] text-black focus:outline-none focus:ring-2 focus:ring-amber-500"
                required
              />
            </div>
          ) : (
            <p className="text-[12px] text-amber-700 font-normal">
              A supervisor or manager must review and authorize duplicate reference overrides.
            </p>
          )}
        </div>
      )}

      <div>
        <label className="block text-[13px] font-bold text-[#11120d] mb-1">
          Paper Document Type *
        </label>
        <select
          value={externalDocumentType}
          onChange={(e) =>
            setExternalDocumentType(e.target.value as ExternalDocumentType)
          }
          className="w-full rounded-xl border border-[#CFCFD3] bg-white px-3 py-2 text-[14px] text-[#11120d] focus:border-[#11120d] focus:outline-none focus:ring-1 focus:ring-[#11120d]"
        >
          {Object.entries(DOCUMENT_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-[13px] font-bold text-[#11120d] mb-1">
          Paper Bill Number *
        </label>
        <input
          type="text"
          value={billNo}
          onChange={(e) => setBillNo(e.target.value)}
          placeholder="e.g. PB-2081-0042"
          maxLength={100}
          required
          className="w-full rounded-xl border border-[#CFCFD3] bg-white px-3 py-2 text-[14px] font-mono text-[#11120d] placeholder:text-[#8C8889] focus:border-[#11120d] focus:outline-none focus:ring-1 focus:ring-[#11120d]"
        />
      </div>

      <div>
        <label className="block text-[13px] font-bold text-[#11120d] mb-1">
          Paper Bill Date *
        </label>
        <input
          type="date"
          value={externalBillDate}
          onChange={(e) => setExternalBillDate(e.target.value)}
          required
          className="w-full rounded-xl border border-[#CFCFD3] bg-white px-3 py-2 text-[14px] text-[#11120d] focus:border-[#11120d] focus:outline-none focus:ring-1 focus:ring-[#11120d]"
        />
      </div>

      {isEditing && (
        <div>
          <label className="block text-[13px] font-bold text-[#11120d] mb-1">
            Correction Note / Reason
          </label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for modifying this paper reference..."
            maxLength={2000}
            className="w-full rounded-xl border border-[#CFCFD3] bg-white px-3 py-2 text-[14px] text-[#11120d] placeholder:text-[#8C8889] focus:border-[#11120d] focus:outline-none focus:ring-1 focus:ring-[#11120d]"
          />
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="rounded-xl border border-[#CFCFD3] px-4 py-2 text-[13px] font-bold text-[#565449] hover:bg-[#F3F4F6] disabled:opacity-50"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={loading}
          className="flex items-center gap-2 rounded-xl bg-[#11120d] px-5 py-2 text-[13px] font-bold text-white hover:bg-black disabled:opacity-50"
        >
          {loading ? (
            <>
              <GIcon name="refresh" className="animate-spin text-[18px]" />
              <span>Saving…</span>
            </>
          ) : (
            <>
              <GIcon name="save" className="text-[18px]" />
              <span>{isEditing ? "Update Reference" : "Record Reference"}</span>
            </>
          )}
        </button>
      </div>
    </form>
  );
}
