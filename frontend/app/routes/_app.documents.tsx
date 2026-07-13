import { useEffect, useMemo, useState, type ReactNode } from "react";
import Icon from "~/components/ui/Icon";
import PaginationBar from "~/components/ui/PaginationBar";
import { useToast } from "~/components/ui/Toast";
import { ConfirmDialog, DialogButton, ModalFrame } from "~/components/ui/Modal";
import {
  deleteDocumentApi,
  fetchDocumentFileBlobApi,
  getStorageInfoApi,
  listDocumentsApi,
  updateDocumentVisibilityApi,
  uploadDocumentsApi,
  type DocumentRecord,
  type DocumentType,
  type DocumentVisibility,
  type StorageInfo,
} from "~/lib/api/endpoints";
import { getAuthUser } from "~/lib/auth";

type ProcessingStatusFilter = "ALL" | "PROCESSED" | "UNPROCESSED";
type VisibilityFilter = "ALL" | DocumentVisibility;
type WorkspaceMode = "list" | "upload";
type UploadMode = "bill-photo" | "document";

const DOCUMENT_TYPE_OPTIONS: Array<{ value: DocumentType; label: string; icon: string }> = [
  { value: "STOCK_BILL", label: "Stock Bill", icon: "receipt_long" },
  { value: "PRODUCT_IMPORT", label: "Product Import", icon: "upload_file" },
  { value: "RETURN_PROOF", label: "Return Proof", icon: "assignment_return" },
  { value: "PAYMENT_PROOF", label: "Payment Proof", icon: "payments" },
  { value: "DISCOUNT_PROOF", label: "Discount Proof", icon: "loyalty" },
  { value: "GENERAL", label: "General", icon: "description" },
];

const VISIBILITY_OPTIONS: Array<{ value: DocumentVisibility; label: string }> = [
  { value: "ALL_AUTHENTICATED", label: "All roles" },
  { value: "ADMIN_MANAGER", label: "Admin + Manager" },
  { value: "ADMIN_ONLY", label: "Admin only" },
];

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function typeLabel(type: DocumentType) {
  return DOCUMENT_TYPE_OPTIONS.find((option) => option.value === type)?.label || type;
}

function typeIcon(type: DocumentType) {
  return DOCUMENT_TYPE_OPTIONS.find((option) => option.value === type)?.icon || "description";
}

function visibilityLabel(visibility: DocumentVisibility) {
  return VISIBILITY_OPTIONS.find((option) => option.value === visibility)?.label || visibility;
}

function formatBytes(bytes: number, decimals = 1) {
  if (!Number(bytes)) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleDateString();
}

function formatDateTime(value?: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function formatMoney(value?: number | null) {
  if (value === null || value === undefined) return "-";
  return `Rs. ${Number(value || 0).toLocaleString()}`;
}

function fileKindLabel(mimeType: string) {
  if (mimeType.startsWith("image/")) return "Image";
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType.includes("csv")) return "CSV";
  return "File";
}

function fileIconFor(doc: Pick<DocumentRecord, "documentType" | "mimeType">) {
  if (doc.mimeType.startsWith("image/")) return "image";
  if (doc.mimeType === "application/pdf") return "picture_as_pdf";
  return typeIcon(doc.documentType);
}

function processingBadgeClass(doc: DocumentRecord) {
  if (doc.processingStatus === "PROCESSED") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (doc.documentType === "STOCK_BILL" || doc.documentType === "PRODUCT_IMPORT") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  return "border-[#CFCFD3] bg-[#F3F4F6] text-[#565449]";
}

function visibilityBadgeClass(visibility: DocumentVisibility) {
  if (visibility === "ADMIN_ONLY") return "border-rose-200 bg-rose-50 text-rose-700";
  if (visibility === "ADMIN_MANAGER") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-emerald-200 bg-emerald-50 text-emerald-700";
}

function DocumentBadge({
  children,
  className,
}: {
  children: ReactNode;
  className: string;
}) {
  return (
    <span className={cn("inline-flex rounded-full border px-2 py-1 text-[11px] font-extrabold", className)}>
      {children}
    </span>
  );
}

function MetadataItem({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="rounded-[12px] border border-[#E5E7EB] bg-white px-3 py-2">
      <div className="text-[10px] font-extrabold uppercase text-[#8C8889]">{label}</div>
      <div className="mt-1 min-w-0 break-words text-[12px] font-bold text-[#11120d]">{value || "-"}</div>
    </div>
  );
}

function DocumentThumbnail({ doc }: { doc: DocumentRecord }) {
  const [thumbUrl, setThumbUrl] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl = "";

    async function loadThumb() {
      if (!doc.mimeType.startsWith("image/")) {
        setThumbUrl("");
        setFailed(false);
        return;
      }

      try {
        setFailed(false);
        const blob = await fetchDocumentFileBlobApi(doc.id);
        objectUrl = URL.createObjectURL(blob);
        if (active) setThumbUrl(objectUrl);
      } catch {
        if (active) {
          setThumbUrl("");
          setFailed(true);
        }
      }
    }

    void loadThumb();

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [doc.id, doc.mimeType]);

  if (doc.mimeType.startsWith("image/") && thumbUrl) {
    return (
      <img
        src={thumbUrl}
        alt=""
        className="h-full w-full object-cover"
        loading="lazy"
      />
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-[#F3F4F6] text-[#565449]">
      <Icon name={failed ? "broken_image" : fileIconFor(doc)} sizePx={22} />
    </div>
  );
}

export default function DocumentsPage() {
  const { showToast } = useToast();
  const authUser = getAuthUser();
  const isAdmin = authUser?.role === "admin";
  const canManageDocuments = authUser?.role === "admin" || authUser?.role === "manager";

  const [mode, setMode] = useState<WorkspaceMode>("list");
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [selectedDoc, setSelectedDoc] = useState<DocumentRecord | null>(null);
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);

  const [typeFilter, setTypeFilter] = useState<DocumentType | "ALL">("ALL");
  const [processingStatusFilter, setProcessingStatusFilter] =
    useState<ProcessingStatusFilter>("ALL");
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>("ALL");
  const [supplierSearch, setSupplierSearch] = useState("");
  const [billSearch, setBillSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [isLoading, setIsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [visibilitySavingId, setVisibilitySavingId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewError, setPreviewError] = useState("");

  const [uploadMode, setUploadMode] = useState<UploadMode>("document");
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadType, setUploadType] = useState<DocumentType>("STOCK_BILL");
  const [uploadSupplier, setUploadSupplier] = useState("");
  const [uploadSupplierMode, setUploadSupplierMode] = useState<"existing" | "new">("existing");
  const [uploadBillNumber, setUploadBillNumber] = useState("");
  const [uploadBillDate, setUploadBillDate] = useState("");
  const [uploadBillAmount, setUploadBillAmount] = useState("");
  const [uploadRemarks, setUploadRemarks] = useState("");
  const [uploadShowMoreDetails, setUploadShowMoreDetails] = useState(false);
  const [uploadVisibility, setUploadVisibility] =
    useState<DocumentVisibility>("ALL_AUTHENTICATED");
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadResult, setUploadResult] = useState<DocumentRecord[]>([]);
  const [dragActive, setDragActive] = useState(false);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const activeFilters =
    typeFilter !== "ALL" ||
    processingStatusFilter !== "ALL" ||
    visibilityFilter !== "ALL" ||
    supplierSearch ||
    billSearch ||
    dateFrom ||
    dateTo;

  const processedCount = documents.filter((doc) => doc.processingStatus === "PROCESSED").length;
  const unprocessedCount = documents.length - processedCount;
  const supplierOptions = useMemo(
    () =>
      Array.from(
        new Set(
          documents
            .map((doc) => doc.supplierName?.trim())
            .filter((supplier): supplier is string => !!supplier),
        ),
      ).sort((a, b) => a.localeCompare(b)),
    [documents],
  );

  async function loadDocuments() {
    try {
      setIsLoading(true);
      const res = await listDocumentsApi({
        page,
        pageSize,
        documentType: typeFilter === "ALL" ? undefined : typeFilter,
        processingStatus:
          processingStatusFilter === "ALL" ? undefined : processingStatusFilter,
        visibility: visibilityFilter === "ALL" ? undefined : visibilityFilter,
        supplierName: supplierSearch.trim() || undefined,
        billNumber: billSearch.trim() || undefined,
        from: dateFrom ? new Date(dateFrom).toISOString() : undefined,
        to: dateTo ? new Date(`${dateTo}T23:59:59`).toISOString() : undefined,
      });

      setDocuments(res.documents);
      setTotal(res.total);
      setSelectedDoc((current) =>
        current && res.documents.some((doc) => doc.id === current.id) ? current : null,
      );
    } catch (err: any) {
      showToast("danger", err?.message || "Failed to load documents.", {
        persistent: true,
      });
    } finally {
      setIsLoading(false);
    }
  }

  async function loadStorageInfo() {
    if (!isAdmin) return;
    try {
      setStorageInfo(await getStorageInfoApi());
    } catch {
      setStorageInfo(null);
    }
  }

  useEffect(() => {
    void loadDocuments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, typeFilter, processingStatusFilter, visibilityFilter, dateFrom, dateTo]);

  useEffect(() => {
    void loadStorageInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  useEffect(() => {
    let active = true;
    let objectUrl = "";

    async function loadPreview() {
      if (!selectedDoc) {
        setPreviewUrl("");
        setPreviewError("");
        return;
      }

      try {
        setPreviewError("");
        setPreviewUrl("");
        const blob = await fetchDocumentFileBlobApi(selectedDoc.id);
        objectUrl = URL.createObjectURL(blob);
        if (active) setPreviewUrl(objectUrl);
      } catch (err: any) {
        if (active) {
          setPreviewUrl("");
          setPreviewError(err?.message || "Failed to load document preview.");
        }
      }
    }

    void loadPreview();

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [selectedDoc]);

  function resetUploadForm() {
    setUploadFiles([]);
    setUploadType("STOCK_BILL");
    setUploadSupplier("");
    setUploadSupplierMode("existing");
    setUploadBillNumber("");
    setUploadBillDate(new Date().toISOString().slice(0, 10));
    setUploadBillAmount("");
    setUploadRemarks("");
    setUploadShowMoreDetails(false);
    setUploadVisibility("ALL_AUTHENTICATED");
    setUploadError("");
    setUploadResult([]);
    setDragActive(false);
  }

  function openUploadWorkspace(type?: DocumentType, mode: UploadMode = "document") {
    resetUploadForm();
    setUploadMode(mode);
    setUploadType(mode === "bill-photo" ? "STOCK_BILL" : type || "GENERAL");
    setMode("upload");
  }

  function addUploadFiles(files: FileList | File[]) {
    const incoming = Array.from(files);
    setUploadFiles((current) => {
      const next = [...current, ...incoming];
      const seen = new Set<string>();
      return next
        .filter((file) => {
          const key = `${file.name}-${file.size}-${file.lastModified}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 5);
    });
    setUploadError("");
  }

  function removeUploadFile(index: number) {
    setUploadFiles((current) => current.filter((_, idx) => idx !== index));
  }

  async function submitUpload() {
    if (!canManageDocuments) {
      setUploadError("Only admin or manager can upload documents.");
      return;
    }
    if (uploadFiles.length === 0) {
      setUploadError("Choose at least one file to upload.");
      return;
    }

    const billAmount = uploadBillAmount.trim() ? Number(uploadBillAmount) : undefined;
    if (billAmount !== undefined && (!Number.isFinite(billAmount) || billAmount < 0)) {
      setUploadError("Bill amount must be zero or greater.");
      return;
    }

    try {
      setUploadBusy(true);
      setUploadError("");
      const result = await uploadDocumentsApi(uploadFiles, {
        documentType: uploadType,
        supplierName: uploadSupplier.trim() || undefined,
        billNumber: uploadBillNumber.trim() || undefined,
        billDate: uploadBillDate || undefined,
        billAmount,
        remarks: uploadRemarks.trim() || undefined,
        visibility: uploadVisibility,
      });
      const uploaded = Array.isArray(result.documents) ? result.documents : [];
      setUploadResult(uploaded);
      showToast("success", `${uploaded.length} document${uploaded.length === 1 ? "" : "s"} uploaded.`);
      setUploadFiles([]);
      await loadDocuments();
      await loadStorageInfo();
      if (uploaded[0]) {
        setSelectedDoc(uploaded[0]);
      }
    } catch (err: any) {
      setUploadError(err?.message || "Document upload failed.");
    } finally {
      setUploadBusy(false);
    }
  }

  async function handleDelete() {
    if (!deletingId) return;
    if (!canManageDocuments) {
      showToast("danger", "Only admin or manager can move documents to Bin.");
      setDeletingId(null);
      return;
    }

    try {
      const result = await deleteDocumentApi(deletingId);
      showToast("success", result?.message || "Document moved to Bin.");
      setDeletingId(null);
      if (selectedDoc?.id === deletingId) setSelectedDoc(null);
      if (documents.length === 1 && page > 1) {
        setPage(page - 1);
      } else {
        await loadDocuments();
      }
      await loadStorageInfo();
    } catch (err: any) {
      showToast("danger", err?.message || "Failed to move document to Bin.");
    }
  }

  async function handleDownload(doc: DocumentRecord) {
    try {
      const blob = await fetchDocumentFileBlobApi(doc.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = doc.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      showToast("danger", err?.message || "Failed to download document.", {
        persistent: true,
      });
    }
  }

  async function handleVisibilityChange(doc: DocumentRecord, visibility: DocumentVisibility) {
    if (!isAdmin) return;
    if (doc.visibility === visibility) {
      showToast("info", "Document already has this visibility.");
      return;
    }

    try {
      setVisibilitySavingId(doc.id);
      const result = await updateDocumentVisibilityApi(doc.id, visibility);
      setDocuments((current) =>
        current.map((item) => (item.id === doc.id ? result.document : item)),
      );
      setSelectedDoc((current) => (current?.id === doc.id ? result.document : current));
      showToast(
        result.changed ? "success" : "info",
        result.message || (result.changed ? "Document visibility updated." : "Document already has this visibility."),
      );
    } catch (err: any) {
      showToast("danger", err?.message || "Failed to update document visibility.");
    } finally {
      setVisibilitySavingId(null);
    }
  }

  function clearFilters() {
    setSupplierSearch("");
    setBillSearch("");
    setDateFrom("");
    setDateTo("");
    setTypeFilter("ALL");
    setProcessingStatusFilter("ALL");
    setVisibilityFilter("ALL");
    setPage(1);
    void loadDocuments();
  }

  function renderPreview(doc: DocumentRecord) {
    if (previewError) {
      return (
        <div className="flex h-full min-h-[260px] flex-col items-center justify-center text-center text-[#8C8889]">
          <Icon name="error" sizePx={44} className="mb-3 text-rose-500" />
          <div className="text-[13px] font-extrabold text-[#565449]">{previewError}</div>
          <button
            type="button"
            onClick={() => void handleDownload(doc)}
            className="mt-4 inline-flex h-[38px] items-center gap-2 rounded-[12px] border border-[#11120d] bg-[#11120d] px-3 text-[12px] font-extrabold text-white"
          >
            <Icon name="download" sizePx={16} />
            Download
          </button>
        </div>
      );
    }

    if (!previewUrl) {
      return (
        <div className="flex h-full min-h-[260px] flex-col items-center justify-center text-[#8C8889]">
          <Icon name="hourglass_empty" sizePx={44} className="mb-3 text-[#D1D5DB]" />
          <div className="text-[13px] font-extrabold text-[#565449]">Loading preview...</div>
        </div>
      );
    }

    if (doc.mimeType.startsWith("image/")) {
      return (
        <img
          src={previewUrl}
          alt={doc.fileName}
          className="max-h-[62vh] w-full rounded-[12px] object-contain"
        />
      );
    }

    if (doc.mimeType === "application/pdf") {
      return (
        <iframe
          src={previewUrl}
          title={doc.fileName}
          className="h-[62vh] w-full rounded-[12px] border-0 bg-white"
        />
      );
    }

    return (
      <div className="flex h-full min-h-[260px] flex-col items-center justify-center text-center text-[#8C8889]">
        <Icon name="description" sizePx={58} className="mb-3 text-[#D1D5DB]" />
        <div className="text-[14px] font-extrabold text-[#565449]">Preview not available</div>
        <div className="mt-1 text-[12px] font-semibold">Download this file to inspect it.</div>
      </div>
    );
  }

  function renderDocumentActions(doc: DocumentRecord, compact = false) {
    return (
      <div className={cn("flex items-center gap-2", compact ? "justify-start" : "justify-end")}>
        <button
          type="button"
          onClick={() => setSelectedDoc(doc)}
          title="Preview"
          className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-white text-[#565449] transition hover:bg-[#F3F4F6]"
        >
          <Icon name="visibility" sizePx={18} />
        </button>
        <button
          type="button"
          onClick={() => void handleDownload(doc)}
          title="Download"
          className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-white text-[#565449] transition hover:bg-[#F3F4F6]"
        >
          <Icon name="download" sizePx={18} />
        </button>
        {canManageDocuments ? (
          <button
            type="button"
            onClick={() => setDeletingId(doc.id)}
            title="Move to Bin"
            className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] border border-rose-200 bg-rose-50 text-rose-600 transition hover:bg-rose-100"
          >
            <Icon name="delete" sizePx={18} />
          </button>
        ) : null}
      </div>
    );
  }

  function renderDocumentTable() {
    return (
      <div className="hidden min-h-0 flex-1 overflow-auto lg:block">
        <table className="w-full min-w-[1040px] text-left text-[13px]">
          <thead className="sticky top-0 z-10 bg-[#F8FAFC] text-[11px] font-extrabold uppercase text-[#565449] shadow-[0_1px_0_#E5E7EB]">
            <tr>
              <th className="px-4 py-3">Document</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Supplier / Bill</th>
              <th className="px-4 py-3">Amount</th>
              <th className="px-4 py-3">Uploaded</th>
              <th className="px-4 py-3">Visibility</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E5E7EB]">
            {documents.map((doc) => (
              <tr
                key={doc.id}
                className="transition hover:bg-[#F9FAFB]"
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="h-[48px] w-[48px] shrink-0 overflow-hidden rounded-[10px] border border-[#E5E7EB] bg-[#F3F4F6]">
                      <DocumentThumbnail doc={doc} />
                    </div>
                    <div className="min-w-0">
                      <div className="max-w-[260px] truncate font-extrabold text-[#11120d]" title={doc.fileName}>
                        {doc.fileName}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2 text-[11px] font-semibold text-[#8C8889]">
                        <span>{typeLabel(doc.documentType)}</span>
                        <span>{fileKindLabel(doc.mimeType)}</span>
                        <span>{formatBytes(doc.fileSize)}</span>
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <DocumentBadge className={processingBadgeClass(doc)}>
                    {doc.processingStatus === "PROCESSED" ? "Linked" : "Unprocessed"}
                  </DocumentBadge>
                  <div className="mt-1 max-w-[180px] truncate text-[11px] font-semibold text-[#8C8889]" title={doc.processingLabel}>
                    {doc.processingLabel}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="font-extrabold text-[#11120d]">{doc.supplierName || "-"}</div>
                  <div className="mt-1 text-[11px] font-semibold text-[#8C8889]">
                    {doc.billNumber ? `Bill ${doc.billNumber}` : "No bill number"} | {formatDate(doc.billDate)}
                  </div>
                </td>
                <td className="px-4 py-3 font-mono font-extrabold text-[#11120d]">
                  {formatMoney(doc.billAmount)}
                </td>
                <td className="px-4 py-3">
                  <div className="font-semibold text-[#11120d]">{formatDate(doc.createdAt)}</div>
                  <div className="mt-1 text-[11px] font-semibold text-[#8C8889]">
                    by {doc.uploadedBy?.name || "System"}
                  </div>
                </td>
                <td className="px-4 py-3">
                  {isAdmin ? (
                    <select
                      value={doc.visibility}
                      disabled={visibilitySavingId === doc.id}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => void handleVisibilityChange(doc, event.target.value as DocumentVisibility)}
                      className="h-[34px] rounded-[10px] border border-[#CFCFD3] bg-white px-2 text-[12px] font-extrabold text-[#11120d] outline-none disabled:opacity-60"
                    >
                      {VISIBILITY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <DocumentBadge className={visibilityBadgeClass(doc.visibility)}>
                      {visibilityLabel(doc.visibility)}
                    </DocumentBadge>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {renderDocumentActions(doc)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  function renderDocumentCards() {
    return (
      <div className="space-y-3 lg:hidden">
        {documents.map((doc) => (
          <div
            key={doc.id}
            className="w-full rounded-[16px] border border-[#CFCFD3] bg-white p-4 text-left"
          >
            <div className="flex items-start gap-3">
              <div className="h-[54px] w-[54px] shrink-0 overflow-hidden rounded-[12px] border border-[#E5E7EB] bg-[#F3F4F6]">
                <DocumentThumbnail doc={doc} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="max-h-[40px] overflow-hidden break-words text-[13px] font-extrabold leading-5 text-[#11120d]">
                  {doc.fileName}
                </div>
                <div className="mt-1 text-[11px] font-semibold text-[#8C8889]">
                  {typeLabel(doc.documentType)} | {formatBytes(doc.fileSize)}
                </div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <DocumentBadge className={processingBadgeClass(doc)}>
                {doc.processingStatus === "PROCESSED" ? "Linked" : "Unprocessed"}
              </DocumentBadge>
              <DocumentBadge className={visibilityBadgeClass(doc.visibility)}>
                {visibilityLabel(doc.visibility)}
              </DocumentBadge>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[12px]">
              <MetadataItem label="Supplier" value={doc.supplierName || "-"} />
              <MetadataItem label="Bill" value={doc.billNumber || "-"} />
            </div>
            <div className="mt-3">{renderDocumentActions(doc, true)}</div>
          </div>
        ))}
      </div>
    );
  }

  function renderEmptyState() {
    return (
      <div className="flex min-h-[320px] flex-col items-center justify-center rounded-[16px] border border-dashed border-[#CFCFD3] bg-white px-6 py-12 text-center">
        <Icon name="folder_open" sizePx={48} className="text-[#D1D5DB]" />
        <div className="mt-4 text-[15px] font-extrabold text-[#11120d]">No documents found</div>
        <div className="mt-1 max-w-[360px] text-[13px] font-semibold leading-6 text-[#8C8889]">
          Upload supplier bills, product import files, or proofs so they can be linked to shop workflows later.
        </div>
        {canManageDocuments ? (
          <button
            type="button"
            onClick={() => openUploadWorkspace()}
            className="mt-5 inline-flex h-[42px] items-center gap-2 rounded-[12px] border border-[#11120d] bg-[#11120d] px-4 text-[13px] font-extrabold text-white"
          >
            <Icon name="upload_file" sizePx={18} />
            Upload Document
          </button>
        ) : null}
      </div>
    );
  }

  function renderDetailView() {
    if (!selectedDoc) return null;

    return (
      <div className="max-h-[74vh] overflow-y-auto">
        <div className="rounded-[14px] border border-[#E5E7EB] bg-[#F3F4F6] p-3">
          {renderPreview(selectedDoc)}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <DocumentBadge className={processingBadgeClass(selectedDoc)}>
            {selectedDoc.processingLabel}
          </DocumentBadge>
          <DocumentBadge className={visibilityBadgeClass(selectedDoc.visibility)}>
            {visibilityLabel(selectedDoc.visibility)}
          </DocumentBadge>
          {selectedDoc.linkedEntityType && selectedDoc.linkedEntityId ? (
            <DocumentBadge className="border-emerald-200 bg-emerald-50 text-emerald-700">
              Linked to {selectedDoc.linkedEntityType}
            </DocumentBadge>
          ) : null}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <MetadataItem label="Supplier" value={selectedDoc.supplierName || "-"} />
          <MetadataItem label="Bill number" value={selectedDoc.billNumber || "-"} />
          <MetadataItem label="Bill date" value={formatDate(selectedDoc.billDate)} />
          <MetadataItem label="Bill amount" value={formatMoney(selectedDoc.billAmount)} />
          <MetadataItem label="Uploaded by" value={selectedDoc.uploadedBy?.name || "System"} />
          <MetadataItem label="File type" value={selectedDoc.mimeType} />
        </div>

        <div className="mt-3 rounded-[12px] border border-[#E5E7EB] bg-white px-3 py-2">
          <div className="text-[10px] font-extrabold uppercase text-[#8C8889]">Remarks</div>
          <div className="mt-1 whitespace-pre-wrap text-[12px] font-semibold leading-5 text-[#565449]">
            {selectedDoc.remarks || "-"}
          </div>
        </div>

        {isAdmin ? (
          <label className="mt-3 block">
            <span className="text-[10px] font-extrabold uppercase text-[#8C8889]">Visibility</span>
            <select
              value={selectedDoc.visibility}
              disabled={visibilitySavingId === selectedDoc.id}
              onChange={(event) => void handleVisibilityChange(selectedDoc, event.target.value as DocumentVisibility)}
              className="mt-1 h-[38px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-extrabold text-[#11120d] outline-none disabled:opacity-60"
            >
              {VISIBILITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
    );
  }

  function renderUploadWorkspace() {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
        <div className="mx-auto max-w-5xl space-y-4">
          <button
            type="button"
            onClick={() => {
              setMode("list");
              setUploadError("");
            }}
            disabled={uploadBusy}
            className="inline-flex h-[36px] items-center gap-2 rounded-[10px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6] disabled:pointer-events-none disabled:opacity-50"
          >
            <Icon name="arrow_back" sizePx={17} />
            Back
          </button>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
            <section className="rounded-[18px] border border-[#CFCFD3] bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                    {uploadMode === "bill-photo" ? "Bill Photo" : "Upload"}
                  </div>
                  <div className="mt-1 text-[20px] font-extrabold text-[#11120d]">
                    {uploadMode === "bill-photo" ? "Add supplier bill" : "Add document"}
                  </div>
                  <div className="mt-1 text-[12px] font-semibold text-[#8C8889]">
                    {uploadMode === "bill-photo"
                      ? "Capture or upload bill images for stock receive. Date defaults to today."
                      : "Upload product import files, proofs, or general documents."}
                  </div>
                </div>
                <DocumentBadge className="border-[#CFCFD3] bg-[#F3F4F6] text-[#565449]">
                  Max 5 files
                </DocumentBadge>
              </div>

              <div
                onDragEnter={(event) => {
                  event.preventDefault();
                  setDragActive(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setDragActive(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragActive(false);
                  addUploadFiles(event.dataTransfer.files);
                }}
                className={cn(
                  "mt-4 rounded-[16px] border border-dashed px-5 py-8 text-center transition",
                  dragActive ? "border-[#11120d] bg-[#F8FAFC]" : "border-[#CFCFD3] bg-[#F3F4F6]",
                )}
              >
                <Icon name={uploadMode === "bill-photo" ? "photo_camera" : "upload_file"} sizePx={42} className="mx-auto text-[#565449]" />
                <div className="mt-3 text-[14px] font-extrabold text-[#11120d]">
                  {uploadMode === "bill-photo" ? "Take a photo or choose bill images" : "Drop files here or choose files"}
                </div>
                <div className="mt-1 text-[12px] font-semibold text-[#8C8889]">
                  {uploadMode === "bill-photo"
                    ? "Images are prioritized for mobile bill capture; PDFs are still accepted."
                    : "Images and PDFs are supported by the current backend."}
                </div>
                <label className="mt-4 inline-flex h-[40px] cursor-pointer items-center gap-2 rounded-[12px] border border-[#11120d] bg-[#11120d] px-4 text-[12px] font-extrabold text-white">
                  <Icon name="photo_camera" sizePx={17} />
                  {uploadMode === "bill-photo" ? "Open Camera / Photos" : "Choose Files"}
                  <input
                    type="file"
                    multiple
                    accept={uploadMode === "bill-photo" ? "image/jpeg,image/png,image/webp,application/pdf" : "image/jpeg,image/png,image/webp,application/pdf"}
                    capture={uploadMode === "bill-photo" ? "environment" : undefined}
                    className="hidden"
                    onChange={(event) => {
                      if (event.target.files) addUploadFiles(event.target.files);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
              </div>

              {uploadFiles.length > 0 ? (
                <div className="mt-4 space-y-2">
                  {uploadFiles.map((file, index) => (
                    <div key={`${file.name}-${index}`} className="flex items-center justify-between gap-3 rounded-[12px] border border-[#E5E7EB] bg-white px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-[12px] font-extrabold text-[#11120d]">{file.name}</div>
                        <div className="mt-1 text-[11px] font-semibold text-[#8C8889]">
                          {file.type || "Unknown file"} | {formatBytes(file.size)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeUploadFile(index)}
                        className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] border border-[#CFCFD3] text-[#565449] hover:bg-[#F3F4F6]"
                        title="Remove file"
                      >
                        <Icon name="close" sizePx={16} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              {uploadError ? (
                <div className="mt-4 rounded-[12px] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-semibold text-rose-700">
                  {uploadError}
                </div>
              ) : null}

              {uploadResult.length > 0 ? (
                <div className="mt-4 rounded-[14px] border border-emerald-200 bg-emerald-50 px-4 py-3">
                  <div className="text-[12px] font-extrabold uppercase text-emerald-700">Upload complete</div>
                  <div className="mt-1 text-[13px] font-semibold text-emerald-800">
                    {uploadResult.length} document{uploadResult.length === 1 ? "" : "s"} added to the inbox.
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setMode("list")}
                      className="h-[34px] rounded-[10px] border border-emerald-300 bg-white px-3 text-[12px] font-extrabold text-emerald-700"
                    >
                      View Inbox
                    </button>
                    <button
                      type="button"
                      onClick={() => resetUploadForm()}
                      className="h-[34px] rounded-[10px] border border-emerald-300 bg-white px-3 text-[12px] font-extrabold text-emerald-700"
                    >
                      Upload More
                    </button>
                  </div>
                </div>
              ) : null}
            </section>

            <aside className="rounded-[18px] border border-[#CFCFD3] bg-white p-4">
              <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">Metadata</div>
              <div className="mt-3 space-y-3">
                <label className="block">
                  <span className="text-[11px] font-extrabold uppercase text-[#8C8889]">Document type</span>
                  {uploadMode === "bill-photo" ? (
                    <div className="mt-1 flex h-[40px] items-center rounded-[12px] border border-[#CFCFD3] bg-[#F3F4F6] px-3 text-[13px] font-extrabold text-[#11120d]">
                      Stock Bill
                    </div>
                  ) : (
                    <select
                      value={uploadType}
                      onChange={(event) => setUploadType(event.target.value as DocumentType)}
                      className="mt-1 h-[40px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-bold text-[#11120d] outline-none"
                    >
                      {DOCUMENT_TYPE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  )}
                </label>

                <label className="block">
                  <span className="text-[11px] font-extrabold uppercase text-[#8C8889]">Supplier</span>
                  <select
                    value={uploadSupplierMode === "new" ? "__new" : uploadSupplier}
                    onChange={(event) => {
                      if (event.target.value === "__new") {
                        setUploadSupplierMode("new");
                        setUploadSupplier("");
                        return;
                      }
                      setUploadSupplierMode("existing");
                      setUploadSupplier(event.target.value);
                    }}
                    className="mt-1 h-[40px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-bold text-[#11120d] outline-none"
                  >
                    <option value="">Select supplier</option>
                    {supplierOptions.map((supplier) => (
                      <option key={supplier} value={supplier}>
                        {supplier}
                      </option>
                    ))}
                    <option value="__new">+ Add new supplier</option>
                  </select>
                  {uploadSupplierMode === "new" ? (
                    <input
                      value={uploadSupplier}
                      onChange={(event) => setUploadSupplier(event.target.value)}
                      placeholder="New supplier name"
                      className="mt-2 h-[40px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-semibold text-[#11120d] outline-none"
                    />
                  ) : null}
                </label>

                <div className="grid grid-cols-1 gap-2">
                  <label className="block">
                    <span className="text-[11px] font-extrabold uppercase text-[#8C8889]">Bill date</span>
                    <input
                      type="date"
                      value={uploadBillDate}
                      onChange={(event) => setUploadBillDate(event.target.value)}
                      className="mt-1 h-[40px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-semibold text-[#11120d] outline-none"
                    />
                  </label>
                </div>

                <button
                  type="button"
                  onClick={() => setUploadShowMoreDetails((current) => !current)}
                  className="h-[36px] w-full rounded-[10px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-extrabold text-[#565449] hover:bg-[#F3F4F6]"
                >
                  {uploadShowMoreDetails ? "Hide optional bill details" : "Optional bill details"}
                </button>

                {uploadShowMoreDetails ? (
                  <div className="space-y-3 rounded-[12px] border border-[#E5E7EB] bg-[#F8FAFC] p-3">
                    <label className="block">
                      <span className="text-[11px] font-extrabold uppercase text-[#8C8889]">Bill no.</span>
                      <input
                        value={uploadBillNumber}
                        onChange={(event) => setUploadBillNumber(event.target.value)}
                        placeholder="Optional"
                        className="mt-1 h-[40px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-semibold text-[#11120d] outline-none"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[11px] font-extrabold uppercase text-[#8C8889]">Bill amount</span>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={uploadBillAmount}
                        onChange={(event) => setUploadBillAmount(event.target.value)}
                        className="mt-1 h-[40px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-right text-[13px] font-semibold text-[#11120d] outline-none"
                      />
                    </label>
                  </div>
                ) : null}

                <label className="block">
                  <span className="text-[11px] font-extrabold uppercase text-[#8C8889]">Visibility</span>
                  <select
                    value={uploadVisibility}
                    onChange={(event) => setUploadVisibility(event.target.value as DocumentVisibility)}
                    className="mt-1 h-[40px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-bold text-[#11120d] outline-none"
                  >
                    {VISIBILITY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="text-[11px] font-extrabold uppercase text-[#8C8889]">Remarks</span>
                  <textarea
                    value={uploadRemarks}
                    onChange={(event) => setUploadRemarks(event.target.value)}
                    rows={4}
                    placeholder="Short note, supplier context, or processing reminder"
                    className="mt-1 w-full resize-none rounded-[12px] border border-[#CFCFD3] bg-white px-3 py-2 text-[13px] font-semibold text-[#11120d] outline-none"
                  />
                </label>

                <button
                  type="button"
                  onClick={() => void submitUpload()}
                  disabled={uploadBusy || uploadFiles.length === 0}
                  className="flex h-[42px] w-full items-center justify-center gap-2 rounded-[12px] border border-[#11120d] bg-[#11120d] px-4 text-[13px] font-extrabold text-white transition hover:bg-[#2a2c27] disabled:pointer-events-none disabled:opacity-50"
                >
                  <Icon name="upload" sizePx={18} />
                  {uploadBusy ? "Uploading..." : uploadMode === "bill-photo" ? "Save Bill Photo" : "Upload Document"}
                </button>
              </div>
            </aside>
          </div>
        </div>
      </div>
    );
  }

  if (mode === "upload") {
    return (
      <div className="flex h-full flex-col bg-[#F3F4F6] text-[#11120d]">
        {renderUploadWorkspace()}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[#F3F4F6] text-[#11120d]">
      <div className="flex flex-col gap-4 border-b border-[#E5E7EB] bg-[#F3F4F6] p-4 md:flex-row md:items-end md:justify-between md:p-5">
        <div>
          <h1 className="text-[24px] font-extrabold leading-none text-[#11120d]">Documents</h1>
          <p className="mt-2 text-[13px] font-semibold text-[#8C8889]">
            Upload bills, find files, preview details, and stage documents for stock or import work.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManageDocuments ? (
            <>
              <button
                type="button"
                onClick={() => openUploadWorkspace("STOCK_BILL", "bill-photo")}
                className="inline-flex h-[40px] items-center gap-2 rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6]"
              >
                <Icon name="photo_camera" sizePx={17} />
                Bill Photo
              </button>
              <button
                type="button"
                onClick={() => openUploadWorkspace(undefined, "document")}
                className="inline-flex h-[40px] items-center gap-2 rounded-[12px] border border-[#11120d] bg-[#11120d] px-4 text-[12px] font-extrabold text-white transition hover:bg-[#2a2c27]"
              >
                <Icon name="upload_file" sizePx={17} />
                Upload Document
              </button>
            </>
          ) : null}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 p-4 md:p-5">
        <main className="min-h-0 space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <div className="rounded-[16px] border border-[#CFCFD3] bg-white p-4">
              <div className="text-[20px] font-extrabold text-[#11120d]">{total}</div>
              <div className="mt-1 text-[11px] font-extrabold uppercase text-[#8C8889]">Visible documents</div>
            </div>
            <div className="rounded-[16px] border border-[#CFCFD3] bg-white p-4">
              <div className="text-[20px] font-extrabold text-emerald-700">{processedCount}</div>
              <div className="mt-1 text-[11px] font-extrabold uppercase text-[#8C8889]">Linked on page</div>
            </div>
            <div className="rounded-[16px] border border-[#CFCFD3] bg-white p-4">
              <div className="text-[20px] font-extrabold text-amber-700">{unprocessedCount}</div>
              <div className="mt-1 text-[11px] font-extrabold uppercase text-[#8C8889]">Unprocessed on page</div>
            </div>
            <div className="rounded-[16px] border border-[#CFCFD3] bg-white p-4">
              <div className="text-[20px] font-extrabold text-[#11120d]">
                {storageInfo ? formatBytes(storageInfo.totalSizeBytes) : "-"}
              </div>
              <div className="mt-1 text-[11px] font-extrabold uppercase text-[#8C8889]">Storage used</div>
            </div>
          </div>

          <section className="rounded-[14px] border border-[#CFCFD3] bg-white p-3">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
              <div className="flex min-h-[42px] flex-1 items-center gap-2 rounded-[12px] border border-[#CFCFD3] bg-white px-3 focus-within:border-[#11120d]">
                <Icon name="search" sizePx={18} className="shrink-0 text-[#8C8889]" />
                <input
                  value={supplierSearch}
                  onChange={(event) => setSupplierSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      setPage(1);
                      void loadDocuments();
                    }
                  }}
                  placeholder="Search supplier..."
                  className="min-w-[150px] flex-1 bg-transparent text-[13px] font-semibold text-[#11120d] outline-none"
                />
                <input
                  value={billSearch}
                  onChange={(event) => setBillSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      setPage(1);
                      void loadDocuments();
                    }
                  }}
                  placeholder="Bill no."
                  className="hidden w-[130px] border-l border-[#E5E7EB] bg-transparent pl-3 text-[13px] font-semibold text-[#11120d] outline-none md:block"
                />
              </div>

              <div className="flex flex-wrap gap-2">
                <select
                  value={typeFilter}
                  onChange={(event) => {
                    setTypeFilter(event.target.value as DocumentType | "ALL");
                    setPage(1);
                  }}
                  className="h-[40px] rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-extrabold text-[#11120d] outline-none"
                >
                  <option value="ALL">All types</option>
                  {DOCUMENT_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <select
                  value={processingStatusFilter}
                  onChange={(event) => {
                    setProcessingStatusFilter(event.target.value as ProcessingStatusFilter);
                    setPage(1);
                  }}
                  className="h-[40px] rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-extrabold text-[#11120d] outline-none"
                >
                  <option value="ALL">All status</option>
                  <option value="UNPROCESSED">Unprocessed</option>
                  <option value="PROCESSED">Linked</option>
                </select>
                {isAdmin ? (
                  <select
                    value={visibilityFilter}
                    onChange={(event) => {
                      setVisibilityFilter(event.target.value as VisibilityFilter);
                      setPage(1);
                    }}
                    className="h-[40px] rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-extrabold text-[#11120d] outline-none"
                  >
                    <option value="ALL">All visibility</option>
                    {VISIBILITY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : null}
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(event) => {
                    setDateFrom(event.target.value);
                    setPage(1);
                  }}
                  className="h-[40px] rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-bold text-[#11120d] outline-none"
                  title="From"
                />
                <input
                  type="date"
                  value={dateTo}
                  onChange={(event) => {
                    setDateTo(event.target.value);
                    setPage(1);
                  }}
                  className="h-[40px] rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-bold text-[#11120d] outline-none"
                  title="To"
                />
                <button
                  type="button"
                  onClick={() => {
                    setPage(1);
                    void loadDocuments();
                  }}
                  className="h-[40px] rounded-[12px] border border-[#11120d] bg-[#11120d] px-4 text-[12px] font-extrabold text-white"
                >
                  Search
                </button>
                {activeFilters ? (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="h-[40px] rounded-[12px] border border-[#CFCFD3] bg-white px-4 text-[12px] font-extrabold text-[#565449] hover:bg-[#F3F4F6]"
                  >
                    Clear
                  </button>
                ) : null}
              </div>
            </div>
          </section>

          <section className="flex min-h-[420px] flex-col overflow-hidden rounded-[18px] border border-[#CFCFD3] bg-white">
            {isLoading ? (
              <div className="flex min-h-[360px] items-center justify-center text-[13px] font-semibold text-[#8C8889]">
                Loading documents...
              </div>
            ) : documents.length === 0 ? (
              <div className="p-4">{renderEmptyState()}</div>
            ) : (
              <>
                {renderDocumentTable()}
                <div className="overflow-y-auto p-3">{renderDocumentCards()}</div>
                <div className="border-t border-[#E5E7EB] bg-white p-3">
                  <PaginationBar
                    page={page}
                    totalPages={totalPages}
                    total={total}
                    start={(page - 1) * pageSize}
                    end={Math.min(total, page * pageSize)}
                    label="documents"
                    pageSize={pageSize}
                    onPageChange={setPage}
                    onPageSizeChange={(nextPageSize) => {
                      setPageSize(nextPageSize);
                      setPage(1);
                    }}
                  />
                </div>
              </>
            )}
          </section>
        </main>

      </div>

      <ModalFrame
        open={!!selectedDoc}
        title={selectedDoc?.fileName || "Document detail"}
        description={
          selectedDoc
            ? `${typeLabel(selectedDoc.documentType)} | ${fileKindLabel(selectedDoc.mimeType)} | ${formatBytes(selectedDoc.fileSize)}`
            : undefined
        }
        onClose={() => setSelectedDoc(null)}
        maxWidthClass="max-w-[1040px]"
        footer={
          selectedDoc ? (
            <>
              <DialogButton onClick={() => void handleDownload(selectedDoc)} icon="download">
                Download
              </DialogButton>
              <DialogButton variant="primary" onClick={() => setSelectedDoc(null)}>
                Close
              </DialogButton>
            </>
          ) : null
        }
      >
        {renderDetailView()}
      </ModalFrame>

      <ConfirmDialog
        open={!!deletingId}
        title="Move Document to Bin"
        message="This document will move to Bin for the safety window. Permanent deletion belongs in Bin."
        confirmLabel="Move to Bin"
        tone="danger"
        onClose={() => setDeletingId(null)}
        onConfirm={handleDelete}
      />
    </div>
  );
}
