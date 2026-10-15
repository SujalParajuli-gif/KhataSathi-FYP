import { getInvoiceApi } from "~/lib/api/endpoints";
import type { CartTableItem } from "~/components/billing/BillingCartTable";
import BillingOcrComparisonModal from "~/components/billing/BillingOcrComparisonModal";
import type { BillScanObservations } from "~/lib/api/manualBills";
import ProjectDateInput from "~/components/ui/ProjectDateInput";
import ProjectSelect from "~/components/ui/ProjectSelect";
import React, { useEffect, useRef, useState } from "react";
import type {
  ExternalDocumentType,
  PublicSaleCandidate,
  SalesEvidenceRecord,
  SaleRecoveryStatus,
} from "~/lib/api/manualBills";
import {
  archiveSalesEvidence,
  attachSalesEvidence,
  reassociateSalesEvidence,
  voidSalesEvidence,
  getSalesEvidenceHistory,
  getManualBillRecord,
  type ManualBillRecord,
  type ExpectedManualBillRecord,
  type ManualBillAuditEntry,
  fetchSalesEvidenceBlob,
  getSalesEvidenceCandidates,
  getSalesEvidence,
  getSalesEvidenceFileUrl,
  getSalesEvidenceThumbnailUrl,
  listSalesEvidence,
  uploadSalesEvidence,
} from "~/lib/api/manualBills";
import GIcon from "~/components/ui/GIcon";
import { ModalFrame as Modal } from "~/components/ui/Modal";
import PaginationBar from "~/components/ui/PaginationBar";
import ManualBillRecoveryModal from "./ManualBillRecoveryModal";
import SalesBillReview from "./SalesBillReview";
import type { CorrectedSale } from "~/lib/api/salesReview";

interface Props {
  onRefreshParent?: () => void;
}

const DOCUMENT_TYPE_LABELS: Record<ExternalDocumentType, string> = {
  PAN_INVOICE: "PAN Manual Bill / Invoice",
  VAT_TAX_INVOICE: "VAT Tax Invoice",
  ABBREVIATED_TAX_INVOICE: "Abbreviated Tax Invoice",
  OTHER_MANUAL_SALES_DOCUMENT: "Other Manual Sales Document",
};

export default function ManualBillEvidenceWorkspace({ onRefreshParent }: Props) {
  const [reviewDoc, setReviewDoc] = useState<SalesEvidenceRecord | null>(null);
  const [recoveryReview, setRecoveryReview] = useState<CorrectedSale | null>(null);
  const [documents, setDocuments] = useState<SalesEvidenceRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [statusFilter, setStatusFilter] = useState<SaleRecoveryStatus | "ALL">(
    "UNRESOLVED",
  );
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Upload modal state
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [comparisonMode, setComparisonMode] = useState<"UPLOAD" | "SAVED">("UPLOAD");
  const [savedComparisonFile, setSavedComparisonFile] = useState<File | null>(null);
  const [savedComparisonObservations, setSavedComparisonObservations] = useState<BillScanObservations | null>(null);
  const [savedComparisonCart, setSavedComparisonCart] = useState<CartTableItem[]>([]);
  const [savedComparisonTotal, setSavedComparisonTotal] = useState(0);
  const [comparisonPreparing, setComparisonPreparing] = useState(false);

  const [uploadObservations, setUploadObservations] = useState<BillScanObservations | null>(null);
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadRemarks, setUploadRemarks] = useState("");
  const [uploading, setUploading] = useState(false);

  // Attach modal state
  const [attachOpen, setAttachOpen] = useState(false);
  const [sourceInvoice, setSourceInvoice] = useState<ManualBillRecord | null>(null);
  const [voidDoc, setVoidDoc] = useState<SalesEvidenceRecord | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidError, setVoidError] = useState<string | null>(null);
  const [voidReceipt, setVoidReceipt] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [history, setHistory] = useState<ManualBillAuditEntry[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  function expected(record: ManualBillRecord): ExpectedManualBillRecord {
    return { billingChannel: record.billingChannel, externalDocumentType: record.externalDocumentType,
      externalBillNo: record.externalBillNo, externalBillDate: record.externalBillDate, billRecordStatus: record.billRecordStatus };
  }
  async function openHistory(id: string) {
    setHistoryId(id); setHistory([]); setHistoryError(null); setHistoryBusy(true);
    try { setHistory((await getSalesEvidenceHistory(id)).history); }
    catch (err: any) { setHistoryError(err?.response?.data?.error || "Unable to load retained proof history."); }
    finally { setHistoryBusy(false); }
  }
  async function submitVoid(e: React.FormEvent) {
    e.preventDefault();
    if (!voidDoc || !["UNRESOLVED", "ARCHIVED"].includes(voidDoc.saleRecoveryStatus || "")) return;
    setVoidBusy(true); setVoidError(null);
    try {
      await voidSalesEvidence(voidDoc.id, { expectedStatus: voidDoc.saleRecoveryStatus as "UNRESOLVED" | "ARCHIVED", reason: voidReason.trim() });
      setVoidReceipt(voidDoc.id); setVoidDoc(null); await loadDocuments(); onRefreshParent?.();
    } catch (err: any) { setVoidError(err?.response?.data?.error || "Unable to void this upload. Your reason has been kept."); }
    finally { setVoidBusy(false); }
  }
  const [selectedDoc, setSelectedDoc] = useState<SalesEvidenceRecord | null>(null);
  const [candidateSearch, setCandidateSearch] = useState("");
  const [candidates, setCandidates] = useState<PublicSaleCandidate[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<PublicSaleCandidate | null>(null);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const comparisonTarget = useRef("");
  comparisonTarget.current = `${attachOpen}:${selectedDoc?.id}:${selectedCandidate?.id}`;
  useEffect(() => () => { comparisonTarget.current = ""; }, []);

  async function compareSelectedSavedSale() {
    if (!selectedDoc || !selectedCandidate || comparisonPreparing) return;
    const target = comparisonTarget.current;
    setComparisonPreparing(true); setAttachError(null);
    try {
      const [blob, result] = await Promise.all([fetchSalesEvidenceBlob(selectedDoc.id, "file"), getInvoiceApi(selectedCandidate.id)]);
      if (comparisonTarget.current !== target) return;
      const invoice = result.invoice || result;
      setSavedComparisonFile(new File([blob], selectedDoc.fileName, { type: blob.type || selectedDoc.mimeType }));
      setSavedComparisonObservations(null);
      setSavedComparisonCart((invoice.items || []).map((line: any) => ({ id: line.id, productId: line.productId,
        name: line.displayProduct ? (line.displayProduct.name || "Historical identity unavailable") : line.snapshotCapturedAt ? (line.productNameSnapshot || "Historical identity unavailable") : (line.product?.name || "Historical identity unavailable"),
        sku: line.displayProduct ? line.displayProduct.sku : line.snapshotCapturedAt ? line.productSkuSnapshot : line.product?.sku,
        saleUnit: line.saleUnit || null, qty: line.qty, stock: 0, appliedUnitPrice: line.appliedUnitPrice, originalUnitPrice: line.appliedUnitPrice, lineTotal: line.lineTotal })));
      setSavedComparisonTotal(invoice.netTotal); setComparisonMode("SAVED"); setComparisonOpen(true);
    } catch (error: any) { if (comparisonTarget.current === target) setAttachError(error?.message || "Could not open the original bill and saved sale for comparison."); }
    finally { setComparisonPreparing(false); }
  }

  // Attach reference form
  const [attachBillNo, setAttachBillNo] = useState("");
  const [attachDocType, setAttachDocType] = useState<ExternalDocumentType>("PAN_INVOICE");
  const [attachBillDate, setAttachBillDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [attachReason, setAttachReason] = useState("");
  const [attachDuplicateReason, setAttachDuplicateReason] = useState("");
  const [attachDuplicateWarning, setAttachDuplicateWarning] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);

  // Archive modal state
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveDoc, setArchiveDoc] = useState<SalesEvidenceRecord | null>(null);
  const [archiveReason, setArchiveReason] = useState("");
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [attachConflict, setAttachConflict] = useState<{ document?: SalesEvidenceRecord } | null>(null);
  const [archiveConflict, setArchiveConflict] = useState<{ document?: SalesEvidenceRecord } | null>(null);
  const [refreshingDecision, setRefreshingDecision] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryDoc, setRecoveryDoc] = useState<SalesEvidenceRecord | null>(null);

  async function refreshDecision(kind: "attach" | "archive") {
    const source = kind === "attach" ? selectedDoc : archiveDoc;
    if (!source) return;
    setRefreshingDecision(true);
    try {
      const current = await getSalesEvidence(source.id);
      if (kind === "attach") {
        setSelectedDoc(current);
        setSelectedCandidate(null);
        if (current.saleRecoveryStatus === "UNRESOLVED" || current.saleRecoveryStatus === "ATTACHED") {
          setSourceInvoice(current.saleRecoveryStatus === "ATTACHED" && current.linkedEntityId ? await getManualBillRecord(current.linkedEntityId) : null);
          const result = await getSalesEvidenceCandidates(current.id, candidateSearch.trim());
          setCandidates(result.candidates);
          setAttachConflict(null);
          setAttachError("Review and select the refreshed sale before submitting. Your input has been kept.");
        } else {
          setAttachConflict({ document: current });
        }
      } else {
        setArchiveDoc(current);
        setArchiveConflict(current.saleRecoveryStatus === "UNRESOLVED" ? null : { document: current });
      }
      await loadDocuments();
    } catch (err: any) {
      const message = err?.response?.data?.error || "Unable to refresh the current outcome. Your input has been kept.";
      if (kind === "attach") setAttachError(message);
      else setArchiveError(message);
    } finally {
      setRefreshingDecision(false);
    }
  }

  function conflictNotice(kind: "attach" | "archive") {
    const conflict = kind === "attach" ? attachConflict : archiveConflict;
    if (!conflict) return null;
    return <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm space-y-2">
      <p>This decision changed. Your entered reference and reason have been kept.</p>
      {conflict.document && <p>Current outcome: {conflict.document.saleRecoveryStatus}
        {conflict.document.linkedEntityId && <> · Sale {conflict.document.linkedEntityId}</>}</p>}
      <button type="button" disabled={refreshingDecision} onClick={() => refreshDecision(kind)}
        className="rounded-lg border border-amber-600 px-3 py-2 font-semibold focus-visible:ring-2">
        {refreshingDecision ? "Refreshing…" : "Refresh and review outcome"}
      </button>
    </div>;
  }

  // Preview modal state
  const [previewDoc, setPreviewDoc] = useState<SalesEvidenceRecord | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  async function loadDocuments() {
    setLoading(true);
    setError(null);
    try {
      const res = await listSalesEvidence({
        page,
        pageSize,
        q: search.trim() || undefined,
        saleRecoveryStatus: statusFilter === "ALL" ? undefined : statusFilter,
      });
      setDocuments(res.documents);
      setTotal(res.total);
    } catch (err: any) {
      setError(err?.response?.data?.error || err.message || "Failed to load sales evidence.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDocuments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, statusFilter]);

  // Load preview blob
  useEffect(() => {
    if (!previewDoc) {
      setPreviewUrl(null);
      return;
    }

    let isSubscribed = true;
    let createdUrl: string | null = null;
    setPreviewLoading(true);

    fetchSalesEvidenceBlob(previewDoc.id, "file")
      .then((blob) => {
        if (!isSubscribed) return;
        const url = URL.createObjectURL(blob);
        createdUrl = url;
        setPreviewUrl(url);
      })
      .catch((err) => {
        console.error("Failed to fetch sales evidence blob:", err);
      })
      .finally(() => {
        if (isSubscribed) setPreviewLoading(false);
      });

    return () => {
      isSubscribed = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewDoc]);

  async function handleDownload(doc: SalesEvidenceRecord) {
    try {
      const blob = await fetchSalesEvidenceBlob(doc.id, "file");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.fileName || `sales-evidence-${doc.id}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to download file:", err);
    }
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    loadDocuments();
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!uploadFile) return;

    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", uploadFile);
      if (uploadTitle.trim()) formData.append("title", uploadTitle.trim());
      if (uploadRemarks.trim()) formData.append("remarks", uploadRemarks.trim());

      await uploadSalesEvidence(formData);
      setUploadOpen(false);
      setUploadFile(null);
      setUploadTitle("");
      setUploadRemarks("");
      loadDocuments();
      onRefreshParent?.();
    } catch (err: any) {
      setError(err?.response?.data?.error || err.message || "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function openAttachModal(doc: SalesEvidenceRecord) {
    setSourceInvoice(null);
    setAttachConflict(null);
    setSelectedDoc(doc);
    setSelectedCandidate(null);
    setCandidateSearch("");
    setCandidates([]);
    setAttachBillNo("");
    setAttachDocType("PAN_INVOICE");
    setAttachBillDate(new Date().toISOString().slice(0, 10));
    setAttachReason("");
    setAttachDuplicateReason("");
    setAttachDuplicateWarning(null);
    setAttachError(null);
    setAttachOpen(true);

    // Initial candidate search
    setCandidateLoading(true);
    try {
      if (doc.saleRecoveryStatus === "ATTACHED" && doc.linkedEntityId) setSourceInvoice(await getManualBillRecord(doc.linkedEntityId));
      const res = await getSalesEvidenceCandidates(doc.id);
      setCandidates(res.candidates);
    } catch (err: any) {
      setAttachError(err?.response?.data?.error || "Unable to load the current sale and correction candidates.");
    } finally {
      setCandidateLoading(false);
    }
  }

  async function searchCandidates(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!selectedDoc) return;
    setCandidateLoading(true);
    try {
      const res = await getSalesEvidenceCandidates(selectedDoc.id, candidateSearch.trim());
      setCandidates(res.candidates);
    } catch (err: any) {
      setAttachError(err?.response?.data?.error || err.message || "Failed to search candidates.");
    } finally {
      setCandidateLoading(false);
    }
  }

  async function handleAttachSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedDoc || !selectedCandidate || attachConflict || refreshingDecision) return;

    const trimmedNo = attachBillNo.trim();
    if (!trimmedNo) {
      setAttachError("Paper bill number is required.");
      return;
    }

    const trimmedReason = attachReason.trim();
    if (!trimmedReason || trimmedReason.length < 3) {
      setAttachError("A valid reason (at least 3 characters) is required to attach sales evidence.");
      return;
    }

    setAttaching(true);
    setAttachError(null);
    try {
      const payload = {
        invoiceId: selectedCandidate.id,
        reference: {
          billNo: trimmedNo,
          externalDocumentType: attachDocType,
          externalBillDate: attachBillDate,
        },
        expectedInvoice: {
          billingChannel: selectedCandidate.billingChannel as any,
          externalDocumentType: selectedCandidate.externalDocumentType as any,
          externalBillNo: selectedCandidate.externalBillNo,
          externalBillDate: selectedCandidate.externalBillDate,
          billRecordStatus: selectedCandidate.billRecordStatus as any,
        },
        reason: trimmedReason,
        duplicateOverrideReason: attachDuplicateReason.trim() || undefined,
      };
      if (selectedDoc.saleRecoveryStatus === "ATTACHED") {
        if (!sourceInvoice || sourceInvoice.id !== selectedDoc.linkedEntityId) throw new Error("Refresh the original sale before correcting this proof.");
        await reassociateSalesEvidence(selectedDoc.id, { ...payload, expectedSourceInvoiceId: sourceInvoice.id, expectedSourceInvoice: expected(sourceInvoice) });
      } else { await attachSalesEvidence(selectedDoc.id, payload); }

      setAttachOpen(false);
      loadDocuments();
      onRefreshParent?.();
    } catch (err: any) {
      const resData = err?.response?.data;
      if (resData?.code === "DUPLICATE_REVIEW_REQUIRED") {
        setAttachDuplicateWarning(
          resData.error || "Duplicate reference warning. Reviewer justification required.",
        );
      } else if (err?.response?.status === 409) {
        setAttachConflict({ document: resData?.document });
        setAttachError(resData?.error || "Another reviewer changed this decision.");
      } else {
        setAttachError(resData?.error || err.message || "Failed to attach proof to sale.");
      }
    } finally {
      setAttaching(false);
    }
  }

  async function handleArchiveSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!archiveDoc || archiveConflict || refreshingDecision) return;
    if (!archiveReason.trim()) {
      setArchiveError("Archive reason is required.");
      return;
    }

    setArchiving(true);
    setArchiveError(null);
    try {
      await archiveSalesEvidence(archiveDoc.id, {
        reason: archiveReason.trim(),
      });
      setArchiveOpen(false);
      setArchiveDoc(null);
      setArchiveReason("");
      loadDocuments();
      onRefreshParent?.();
    } catch (err: any) {
      if (err?.response?.status === 409) setArchiveConflict({ document: err.response.data?.document });
      setArchiveError(err?.response?.data?.error || err.message || "Failed to archive proof.");
    } finally {
      setArchiving(false);
    }
  }

  const totalPages = Math.ceil(total / pageSize);
  const start = (page - 1) * pageSize;
  const end = Math.min(total, page * pageSize);

  return (
    <div className="space-y-4">
      <BillingOcrComparisonModal open={comparisonOpen} onClose={() => setComparisonOpen(false)}
        cart={comparisonMode === "SAVED" ? savedComparisonCart : []} payableTotal={comparisonMode === "SAVED" ? savedComparisonTotal : null}
        currentBillNo={comparisonMode === "SAVED" ? attachBillNo : ""} currentBillDate={comparisonMode === "SAVED" ? attachBillDate : ""}
        savedSale={comparisonMode === "SAVED"} sourceFile={comparisonMode === "SAVED" ? savedComparisonFile : uploadFile}
        sourceObservations={comparisonMode === "SAVED" ? savedComparisonObservations : uploadObservations}
        onRetainSource={(file, observations) => { if (comparisonMode === "SAVED") { setSavedComparisonFile(file); setSavedComparisonObservations(observations); } else { setUploadFile(file); setUploadObservations(observations); } }}
        onApplyReference={(billNo) => { if (comparisonMode === "UPLOAD" && billNo) setUploadTitle(`Manual bill ${billNo}`); }} />
      {/* Informational Banner on Deferred Recovery */}
      <div className="rounded-2xl border border-control-line bg-control-hover p-4 text-[13px] text-action flex items-start gap-3">
        <GIcon name="info" className="text-secondary text-[20px] shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="font-bold">Sales Evidence & Paper Bill Workflow</p>
          <p className="text-[12px] text-secondary leading-relaxed">
            Attach uploaded paper receipts and manual bills to existing finalized POS invoices to complete audit verification.
            Physical receipts for which no operational POS checkout exists remain saved as <span className="font-semibold">UNRESOLVED</span> evidence and will be processed via the Phase 2 missing-sale recovery workflow.
          </p>
        </div>
      </div>

      {/* Action Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-control-line bg-white p-4 shadow-sm">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setUploadOpen(true)}
            className="flex items-center gap-2 rounded-xl bg-[#11120d] px-4 py-2 text-[13px] font-bold text-white hover:bg-black shadow-sm"
          >
            <GIcon name="upload_file" className="text-[18px]" />
            Upload Bill Proof
          </button>
          <div className="text-[12px] text-secondary">
            Supports JPG, PNG, WEBP, and PDF up to 10MB
          </div>
        </div>

        {/* Filter / Search */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-xl bg-[#F3F4F6] p-1 text-[12px] font-bold">
            {(["UNRESOLVED", "ATTACHED", "ARCHIVED", "ALL"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setStatusFilter(s);
                  setPage(1);
                }}
                className={`rounded-lg px-3 py-1 transition ${
                  statusFilter === s
                    ? "bg-white text-[#11120d] shadow-sm"
                    : "text-secondary hover:text-black"
                }`}
              >
                {s}
              </button>
            ))}
          </div>

          <form onSubmit={handleSearch} className="relative">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search filename / title..."
              className="rounded-xl border border-control-line bg-control-hover py-1.5 pl-3 pr-8 text-[13px] text-black placeholder:text-[#8C8889] focus:bg-white focus:outline-none focus:ring-1 focus:ring-black"
            />
            <button
              type="submit"
              aria-label="Search sales evidence"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-secondary hover:text-black"
            >
              <GIcon name="search" className="text-[16px]" />
            </button>
          </form>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-[13px] text-rose-700">
          {error}
        </div>
      )}
      {voidReceipt && <div role="status" className="rounded-xl border border-control-line bg-control-hover p-3 text-sm">
        Mistaken upload voided. Its file and audit history are retained.
        <button type="button" onClick={() => openHistory(voidReceipt)} className="ml-2 min-h-10 underline">View retained history</button>
      </div>}

      {/* Documents Grid / Table */}
      {loading ? (
        <div className="flex h-48 items-center justify-center rounded-2xl border border-control-line bg-white text-[13px] text-secondary">
          <GIcon name="refresh" className="animate-spin text-[20px] mr-2" />
          Loading sales evidence documents…
        </div>
      ) : documents.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center rounded-2xl border border-control-line bg-white text-center p-6">
          <GIcon name="folder_open" className="text-[36px] text-placeholder mb-2" />
          <p className="text-[14px] font-bold text-[#11120d]">No sales evidence found</p>
          <p className="text-[12px] text-secondary mt-1">
            Upload physical paper bill photos or scans to begin reviewer verification.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {documents.map((doc) => {
              const isUnresolved = doc.saleRecoveryStatus === "UNRESOLVED";
              const isAttached = doc.saleRecoveryStatus === "ATTACHED";
              const isArchived = doc.saleRecoveryStatus === "ARCHIVED";

              return (
                <div
                  key={doc.id}
                  className="flex flex-col justify-between rounded-2xl border border-control-line bg-white p-4 shadow-sm hover:border-[#CFCFD3] transition"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold ${
                          isUnresolved
                            ? "bg-amber-100 text-amber-800"
                            : isAttached
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-control-hover text-secondary"
                        }`}
                      >
                        {doc.saleRecoveryStatus || "UNRESOLVED"}
                      </span>
                      <span className="text-[11px] text-secondary">
                        {new Date(doc.createdAt).toLocaleDateString()}
                      </span>
                    </div>

                    {/* Thumbnail / file view */}
                    <button
                      type="button"
                      aria-label={`Preview ${doc.title || doc.fileName}`}
                      onClick={() => setPreviewDoc(doc)}
                      className="group relative cursor-pointer overflow-hidden rounded-xl bg-control-hover border border-control-line h-36 flex items-center justify-center mb-3"
                    >
                      {doc.thumbnailFileName ? (
                        <img
                          src={getSalesEvidenceThumbnailUrl(doc.id)}
                          alt={doc.title || doc.fileName}
                          className="h-full w-full object-cover group-hover:scale-105 transition"
                        />
                      ) : (
                        <div className="flex flex-col items-center text-secondary">
                          <GIcon name="description" className="text-[36px]" />
                          <span className="text-[11px] font-medium mt-1">
                            {doc.mimeType.includes("pdf") ? "PDF Document" : "File"}
                          </span>
                        </div>
                      )}
                      <div className="absolute inset-0 bg-action/20 opacity-0 group-hover:opacity-100 transition flex items-center justify-center text-white font-bold text-[12px] gap-1">
                        <GIcon name="visibility" className="text-[18px]" />
                        Preview
                      </div>
                    </button>

                    <h3 className="font-bold text-[13px] text-[#11120d] truncate" title={doc.title || doc.fileName}>
                      {doc.title || doc.fileName}
                    </h3>
                    <div className="text-[11px] text-secondary mt-0.5">
                      Uploaded by: {doc.uploadedBy?.name || "Reviewer"}
                    </div>

                    {doc.remarks && (
                      <p className="mt-2 text-[12px] text-secondary bg-control-hover rounded-lg p-2 italic line-clamp-2">
                        {doc.remarks}
                      </p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="mt-4 pt-3 border-t border-control-line flex flex-wrap items-center justify-end gap-2">
                    <button type="button" onClick={() => setReviewDoc(doc)} className="min-h-10 rounded-xl border border-control-line px-3 py-1 text-[11px] font-bold hover:bg-control-hover">Review bill and matches</button>
                    <button
                      type="button"
                      onClick={() => handleDownload(doc)}
                      className="inline-flex min-h-10 items-center gap-1 rounded-xl border border-control-line px-2.5 py-1 text-[11px] font-bold text-secondary hover:bg-control-hover"
                    >
                      <GIcon name="download" className="text-[14px]" />
                      Download
                    </button>

                    {isUnresolved && (
                      <>
                        <button
                          type="button"
                          onClick={() => openAttachModal(doc)}
                          className="inline-flex min-h-10 items-center gap-1 rounded-xl bg-action px-2.5 py-1 text-[11px] font-bold text-white hover:bg-black"
                        >
                          <GIcon name="link" className="text-[14px]" />
                          Attach
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRecoveryDoc(doc);
                            setRecoveryReview(null);
                            setRecoveryOpen(true);
                          }}
                          className="inline-flex min-h-10 items-center gap-1 rounded-xl bg-action px-2.5 py-1 text-[11px] font-bold text-white hover:bg-black"
                        >
                          <GIcon name="post_add" className="text-[14px]" />
                          Create Missing Sale
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setArchiveDoc(doc);
                            setArchiveReason("");
                            setArchiveError(null);
                            setArchiveConflict(null);
                            setArchiveOpen(true);
                          }}
                          className="inline-flex min-h-10 items-center gap-1 rounded-xl border border-control-line px-2.5 py-1 text-[11px] font-bold text-secondary hover:bg-control-hover"
                        >
                          <GIcon name="archive" className="text-[14px]" />
                          Archive
                        </button>
                      </>
                    )}
                    {isAttached && <button type="button" onClick={() => openAttachModal(doc)}
                      className="min-h-10 rounded-xl border border-control-line px-2.5 py-1 text-[11px] font-bold hover:bg-control-hover">Correct association</button>}
                    {(isUnresolved || isArchived) && <button type="button" disabled={doc.canVoidMistakenUpload === false}
                      title={doc.canVoidMistakenUpload === false ? "A prepared recovery attempt must retain this proof" : undefined}
                      onClick={() => { setVoidDoc(doc); setVoidReason(""); setVoidError(null); }}
                      className="min-h-10 rounded-xl border border-control-line px-2.5 py-1 text-[11px] font-bold hover:bg-control-hover">Void mistaken upload</button>}
                    <button type="button" onClick={() => openHistory(doc.id)} className="min-h-10 rounded-xl border border-control-line px-2.5 py-1 text-[11px] font-bold hover:bg-control-hover">Proof history</button>
                  </div>
                </div>
              );
            })}
          </div>

          <PaginationBar
            page={page}
            totalPages={totalPages}
            total={total}
            start={start}
            end={end}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(newSize) => {
              setPageSize(newSize);
              setPage(1);
            }}
            label="documents"
          />
        </>
      )}

      {/* Upload Modal */}
      {reviewDoc && <SalesBillReview document={reviewDoc} onClose={() => setReviewDoc(null)} onDecision={async (kind, doc, corrected, candidate) => {
        setReviewDoc(null);
        if (kind === "attach") {
          await openAttachModal(doc);
          setAttachBillNo(corrected.billNumber || "");
          if (corrected.billDate) setAttachBillDate(corrected.billDate);
          if (candidate) { setCandidates(v => v.some(c => c.id === candidate.id) ? v : [candidate, ...v]); setSelectedCandidate(candidate); }
        } else if (kind === "create") { setRecoveryDoc(doc); setRecoveryReview(corrected); setRecoveryOpen(true); }
        else { setArchiveDoc(doc); setArchiveReason(""); setArchiveError(null); setArchiveConflict(null); setArchiveOpen(true); }
      }} />}
      {uploadOpen && (
        <Modal
          open={uploadOpen}
          onClose={() => setUploadOpen(false)}
          title="Upload Physical Sales Proof"
        >
          <form onSubmit={handleUpload} className="space-y-4 text-left">
            <div>
              <label className="block text-[13px] font-bold text-[#11120d] mb-1">
                Select Photo or PDF File *
              </label>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                onChange={(e) => { setUploadFile(e.target.files?.[0] || null); setUploadObservations(null); setComparisonMode("UPLOAD"); setComparisonOpen(Boolean(e.target.files?.[0])); }}
                required
                className="w-full text-[13px] file:mr-4 file:rounded-xl file:border-0 file:bg-[#11120d] file:px-4 file:py-2 file:text-[13px] file:font-bold file:text-white hover:file:bg-black"
              />
            </div>

            <div>
              <label className="block text-[13px] font-bold text-[#11120d] mb-1">
                Document Title (Optional)
              </label>
              <input
                type="text"
                value={uploadTitle}
                onChange={(e) => setUploadTitle(e.target.value)}
                placeholder="e.g. Counter handwritten bill scan"
                maxLength={160}
                className="w-full rounded-xl border border-[#CFCFD3] bg-white p-2.5 text-[13px] text-black focus:outline-none focus:ring-1 focus:ring-black"
              />
            </div>

            <div>
              <label className="block text-[13px] font-bold text-[#11120d] mb-1">
                Remarks / Notes
              </label>
              <textarea
                value={uploadRemarks}
                onChange={(e) => setUploadRemarks(e.target.value)}
                placeholder="Any notes about this physical bill..."
                rows={2}
                maxLength={2000}
                className="w-full rounded-xl border border-[#CFCFD3] bg-white p-2.5 text-[13px] text-black focus:outline-none focus:ring-1 focus:ring-black"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setUploadOpen(false)}
                disabled={uploading}
                className="rounded-xl border border-control-line px-4 py-2 text-[13px] font-bold text-secondary hover:bg-control-hover"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={uploading || !uploadFile}
                className="flex items-center gap-2 rounded-xl bg-[#11120d] px-4 py-2 text-[13px] font-bold text-white hover:bg-black disabled:opacity-50"
              >
                {uploading ? (
                  <>
                    <GIcon name="refresh" className="animate-spin text-[16px]" />
                    Uploading…
                  </>
                ) : (
                  <>
                    <GIcon name="upload" className="text-[16px]" />
                    Upload Proof
                  </>
                )}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Attach Modal */}
      {attachOpen && selectedDoc && (
        <Modal
          open={attachOpen}
          onClose={() => setAttachOpen(false)}
          title={selectedDoc.saleRecoveryStatus === "ATTACHED" ? "Correct Proof Association" : "Attach Proof to Existing Sale"}
        >
          {selectedCandidate && <button type="button" disabled={comparisonPreparing} onClick={compareSelectedSavedSale} className="mb-3 rounded-lg border border-control-line px-3 py-2 text-sm">{comparisonPreparing ? "Opening comparison…" : "Compare original proof with this recorded sale"}</button>}
          <div className="space-y-4 text-left max-h-[80vh] overflow-y-auto pr-1">
            {selectedDoc.saleRecoveryStatus === "ATTACHED" && <div className="rounded-xl border border-control-line bg-control-hover p-3 text-sm">
              <p>Current sale: {sourceInvoice?.invoiceNo || "Loading…"} · {sourceInvoice?.externalBillNo || "No paper reference"} · {sourceInvoice?.billRecordStatus}</p>
              <p>Correction moves this proof to the selected sale and requires re-verification. Existing sale amounts and payments remain intact.</p>
              {sourceInvoice?.replacementInvoiceId || sourceInvoice?.originalInvoiceId || sourceInvoice?.cancelledAt ?
                <p role="alert">This original or replacement sale retains its proof. Association correction is unavailable.</p> : null}
            </div>}
            {conflictNotice("attach")}
            {attachError && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-[13px] text-rose-700">
                {attachError}
              </div>
            )}

            {attachDuplicateWarning && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[13px] text-amber-800 space-y-2">
                <div className="flex items-start gap-2 font-bold">
                  <GIcon name="warning" className="text-amber-600 text-[18px]" />
                  {attachDuplicateWarning}
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-amber-900 mb-1">
                    Reviewer Duplicate Override Reason *
                  </label>
                  <textarea
                    value={attachDuplicateReason}
                    onChange={(e) => setAttachDuplicateReason(e.target.value)}
                    placeholder="State reason why this duplicate reference is verified..."
                    rows={2}
                    className="w-full rounded-lg border border-amber-300 p-2 text-[13px] text-black"
                  />
                </div>
              </div>
            )}

            {/* Step 1: Select Candidate Invoice */}
            <div>
              <h4 className="text-[13px] font-bold text-[#11120d] mb-2">
                1. Select Target Finalized Invoice
              </h4>
              <form onSubmit={searchCandidates} className="flex gap-2 mb-3">
                <input
                  type="text"
                  value={candidateSearch}
                  onChange={(e) => setCandidateSearch(e.target.value)}
                  placeholder="Search invoice no, customer name..."
                  className="flex-1 rounded-xl border border-[#CFCFD3] bg-white px-3 py-1.5 text-[13px] text-black focus:outline-none focus:ring-1 focus:ring-black"
                />
                <button
                  type="submit"
                  disabled={candidateLoading}
                  className="rounded-xl bg-control-hover px-3 py-1.5 text-[13px] font-bold text-black hover:bg-gray-200"
                >
                  {candidateLoading ? "Searching…" : "Search"}
                </button>
              </form>

              <div className="max-h-40 overflow-y-auto space-y-1.5 border border-control-line rounded-xl p-2 bg-control-hover">
                {candidates.length === 0 ? (
                  <div className="text-[12px] text-secondary text-center py-4">
                    {candidateLoading ? "Loading candidates…" : "No active finalized invoices matched."}
                  </div>
                ) : (
                  candidates.map((cand) => {
                    const isSelected = selectedCandidate?.id === cand.id;
                    return (
                      <button
                        type="button"
                        key={cand.id}
                        onClick={() => {
                          setSelectedCandidate(cand);
                          if (!attachBillNo && cand.externalBillNo) setAttachBillNo(cand.externalBillNo);
                          if (!attachBillNo && cand.externalDocumentType)
                            setAttachDocType(cand.externalDocumentType as ExternalDocumentType);
                          if (!attachBillNo && cand.externalBillDate) setAttachBillDate(cand.externalBillDate);
                        }}
                        className={`cursor-pointer rounded-lg p-2 text-[12px] flex items-center justify-between transition ${
                          isSelected
                            ? "bg-action text-white"
                            : "bg-white text-black hover:bg-control-hover border border-control-line"
                        }`}
                      >
                        <div>
                          <div className="font-mono font-bold">{cand.invoiceNo}</div>
                          <div className={isSelected ? "text-gray-300" : "text-secondary"}>
                            {cand.customerName || "Walk-in"} • Rs. {cand.netTotal} •{" "}
                            {cand.finalizedAt
                              ? new Date(cand.finalizedAt).toLocaleDateString()
                              : "—"}
                          </div>
                        </div>
                        <div className="text-right">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                              isSelected
                                ? "bg-white/20 text-white"
                                : "bg-control-hover text-secondary"
                            }`}
                          >
                            {cand.billRecordStatus || "PENDING"}
                          </span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* Step 2: Reference Form */}
            {selectedCandidate && (
              <form onSubmit={handleAttachSubmit} className="space-y-3 border-t border-control-line pt-3">
                <h4 className="text-[13px] font-bold text-[#11120d]">
                  2. Confirm Paper Bill Reference
                </h4>

                <div>
                  <label className="block text-[12px] font-bold text-[#11120d] mb-1">
                    Document Type *
                  </label>
                  <ProjectSelect
                    aria-label="Document type"
                    value={attachDocType}
                    onChange={(e) =>
                      setAttachDocType(e.target.value as ExternalDocumentType)
                    }
                    className="w-full rounded-xl border border-[#CFCFD3] bg-white p-2 text-[13px] text-black focus:outline-none focus:ring-1 focus:ring-black"
                  >
                    {Object.entries(DOCUMENT_TYPE_LABELS).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </ProjectSelect>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[12px] font-bold text-[#11120d] mb-1">
                      Paper Bill Number *
                    </label>
                    <input
                      type="text"
                      value={attachBillNo}
                      onChange={(e) => setAttachBillNo(e.target.value)}
                      placeholder="e.g. PB-2081-0042"
                      required
                      className="w-full rounded-xl border border-[#CFCFD3] bg-white p-2 text-[13px] font-mono text-black focus:outline-none focus:ring-1 focus:ring-black"
                    />
                  </div>
                  <div>
                    <label className="block text-[12px] font-bold text-[#11120d] mb-1">
                      Paper Bill Date *
                    </label>
                    <ProjectDateInput
                    aria-label="Paper bill date"
                      value={attachBillDate}
                      onChange={(e) => setAttachBillDate(e.target.value)}
                      required
                      className="w-full rounded-xl border border-[#CFCFD3] bg-white p-2 text-[13px] text-black focus:outline-none focus:ring-1 focus:ring-black"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[12px] font-bold text-[#11120d] mb-1">
                    Attachment Reason *
                  </label>
                  <input
                    type="text"
                    value={attachReason}
                    onChange={(e) => setAttachReason(e.target.value)}
                    placeholder="Note for attaching this proof..."
                    className="w-full rounded-xl border border-[#CFCFD3] bg-white p-2 text-[13px] text-black focus:outline-none focus:ring-1 focus:ring-black"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setAttachOpen(false)}
                    disabled={attaching}
                    className="rounded-xl border border-control-line px-4 py-2 text-[13px] font-bold text-secondary hover:bg-control-hover"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={attaching || !!attachConflict || refreshingDecision || !selectedCandidate || !attachBillNo.trim() ||
                      (selectedDoc.saleRecoveryStatus === "ATTACHED" && (!sourceInvoice || !!sourceInvoice.cancelledAt || !!sourceInvoice.replacementInvoiceId || !!sourceInvoice.originalInvoiceId))}
                    className="flex items-center gap-1.5 rounded-xl bg-action px-4 py-2 text-[13px] font-bold text-white hover:bg-black disabled:opacity-50"
                  >
                    {attaching ? "Saving…" : selectedDoc.saleRecoveryStatus === "ATTACHED" ? "Confirm Correction" : "Confirm Attachment"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </Modal>
      )}

      {/* Archive Modal */}
      {archiveOpen && archiveDoc && (
        <Modal
          open={archiveOpen}
          onClose={() => setArchiveOpen(false)}
          title="Archive Sales Evidence"
        >
          <form onSubmit={handleArchiveSubmit} className="space-y-4 text-left">
            {conflictNotice("archive")}
            {archiveError && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-[13px] text-rose-700">
                {archiveError}
              </div>
            )}
            <p className="text-[13px] text-[#565449]">
              Archive proof <span className="font-bold text-black">{archiveDoc.title || archiveDoc.fileName}</span> without associating it with any operational sale.
            </p>
            <div>
              <label className="block text-[13px] font-bold text-[#11120d] mb-1">
                Archive Reason *
              </label>
              <textarea
                value={archiveReason}
                onChange={(e) => setArchiveReason(e.target.value)}
                placeholder="Reason for archiving (e.g. Mistaken upload, illegible scan, duplicate photo)..."
                rows={3}
                required
                className="w-full rounded-xl border border-[#CFCFD3] bg-white p-2.5 text-[13px] text-black focus:outline-none focus:ring-1 focus:ring-black"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setArchiveOpen(false)}
                disabled={archiving}
                className="rounded-xl border border-control-line px-4 py-2 text-[13px] font-bold text-secondary hover:bg-control-hover"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={archiving || !!archiveConflict || refreshingDecision || !archiveReason.trim()}
                className="rounded-xl bg-[#11120d] px-4 py-2 text-[13px] font-bold text-white hover:bg-black disabled:opacity-50"
              >
                {archiving ? "Archiving…" : "Confirm Archive"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {voidDoc && <Modal open onClose={() => { if (!voidBusy) setVoidDoc(null); }} title="Void Mistaken Upload">
        <form onSubmit={submitVoid} className="space-y-4 text-left">
          <p className="text-sm">Remove {voidDoc.title || voidDoc.fileName} from actionable evidence. The original file and audit remain retained; its {voidDoc.saleRecoveryStatus} outcome will not be reset.</p>
          {voidError && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm">
            {voidError}
            <button type="button" disabled={voidBusy} className="block min-h-10 underline" onClick={async () => {
              try { setVoidDoc(await getSalesEvidence(voidDoc.id)); setVoidError("Review the refreshed outcome before confirming. Your reason has been kept."); }
              catch { setVoidError("This upload is no longer actionable. Close this dialog and refresh the list."); }
            }}>Refresh and review outcome</button>
          </div>}
          <label className="block text-sm font-bold">Void reason
            <textarea aria-label="Void reason" required minLength={2} maxLength={2000} rows={3} value={voidReason} onChange={(e) => setVoidReason(e.target.value)}
              className="mt-1 w-full rounded-xl border border-control-line p-3 text-sm font-normal" />
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" disabled={voidBusy} onClick={() => setVoidDoc(null)} className="min-h-10 rounded-xl border border-control-line px-4">Cancel</button>
            <button type="submit" disabled={voidBusy || voidReason.trim().length < 2 || voidDoc.canVoidMistakenUpload === false || !["UNRESOLVED", "ARCHIVED"].includes(voidDoc.saleRecoveryStatus || "")}
              className="min-h-10 rounded-xl bg-action px-4 text-white disabled:opacity-50">{voidBusy ? "Saving…" : "Confirm Retained Void"}</button>
          </div>
        </form>
      </Modal>}
      {historyId && <Modal open onClose={() => setHistoryId(null)} title="Retained Proof History">
        <div className="max-h-[70vh] space-y-3 overflow-y-auto text-left text-sm">
          {historyBusy ? <p role="status">Loading proof history…</p> : historyError ? <p role="alert">{historyError}</p> : history.length === 0 ? <p>No retained review events.</p> : history.map((entry) =>
            <article key={entry.id} className="rounded-xl border border-control-line p-3">
              <p className="font-bold">{entry.action.replaceAll("_", " ")}</p>
              <p className="text-secondary">{entry.actorName || entry.actorRole || "Reviewer"} · {new Date(entry.createdAt).toLocaleString()}</p>
              {!!entry.meta?.reason && <p>{String(entry.meta.reason)}</p>}
              {!!entry.meta?.sourceInvoiceId && <p className="break-all">Sale {String(entry.meta.sourceInvoiceId)} → {String(entry.meta.targetInvoiceId)}</p>}
              {!!entry.meta?.reference && <p>Paper reference: {String((entry.meta.reference as any).billNo || "")}</p>}
              {entry.meta?.retained === true && <p>Original file retained.</p>}
            </article>)}
        </div>
      </Modal>}
      {/* Preview Modal */}
      {previewDoc && (
        <Modal
          open={Boolean(previewDoc)}
          onClose={() => setPreviewDoc(null)}
          title={previewDoc.title || previewDoc.fileName}
        >
          <div className="flex flex-col items-center justify-center p-2">
            {previewLoading ? (
              <div className="flex h-64 w-full items-center justify-center text-secondary text-[13px]">
                <GIcon name="refresh" className="animate-spin text-[24px] mr-2" />
                Loading preview…
              </div>
            ) : previewUrl ? (
              previewDoc.mimeType.startsWith("image/") ? (
                <img
                  src={previewUrl}
                  alt={previewDoc.title || previewDoc.fileName}
                  className="max-h-[70vh] w-auto rounded-xl object-contain"
                />
              ) : (
                <iframe
                  src={previewUrl}
                  title={previewDoc.title || previewDoc.fileName}
                  className="h-[70vh] w-full rounded-xl border border-control-line"
                />
              )
            ) : (
              <div className="flex h-64 w-full flex-col items-center justify-center text-secondary text-[13px]">
                <GIcon name="error" className="text-rose-500 text-[24px] mb-2" />
                Preview unavailable
              </div>
            )}
            <div className="mt-4 flex justify-between w-full text-[12px] text-secondary">
              <span>Status: {previewDoc.saleRecoveryStatus || "UNRESOLVED"}</span>
              <button
                type="button"
                onClick={() => handleDownload(previewDoc)}
                className="font-bold text-black hover:underline inline-flex items-center gap-1"
              >
                <GIcon name="download" className="text-[14px]" />
                Download file
              </button>
            </div>
          </div>
        </Modal>
      )}
      {recoveryOpen && (
        <ManualBillRecoveryModal
          open={recoveryOpen}
          onClose={() => {
            setRecoveryOpen(false);
            setRecoveryDoc(null);
          }}
          document={recoveryDoc}
          reviewedFacts={recoveryReview}
          onSuccess={() => {
            loadDocuments();
            onRefreshParent?.();
          }}
        />
      )}
    </div>
  );
}
