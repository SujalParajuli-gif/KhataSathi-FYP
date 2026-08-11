import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Icon from "~/components/ui/Icon";
import ProjectSelect from "~/components/ui/ProjectSelect";
import ProjectDateInput from "~/components/ui/ProjectDateInput";
import {
  ActiveFilterChips,
  MobileFilterButton,
  MobileFilterSheet,
  type MobileFilterChip,
} from "~/components/ui/MobileFilters";
import PaginationBar from "~/components/ui/PaginationBar";
import { useToast } from "~/components/ui/Toast";
import { ConfirmDialog, DialogButton, ModalFrame } from "~/components/ui/Modal";
import {
  deleteDocumentApi,
  fetchDocumentFileBlobApi,
  fetchDocumentThumbnailBlobApi,
  getStorageInfoApi,
  listDocumentsApi,
  updateDocumentMetadataApi,
  updateDocumentVisibilityApi,
  uploadDocumentsApi,
  type DocumentRecord,
  type DocumentType,
  type DocumentVisibility,
  type StorageInfo,
} from "~/lib/api/endpoints";
import { getAuthUser } from "~/lib/auth";
import { isRateLimitError } from "~/lib/api/client";
import { useRateLimitRecovery } from "~/lib/api/useRateLimitRecovery";
import { focusInvalidField } from "~/lib/forms/focusInvalidField";

type ProcessingStatusFilter = "ALL" | "PROCESSED" | "UNPROCESSED";
type VisibilityFilter = "ALL" | DocumentVisibility;
type WorkspaceMode = "list" | "upload";

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

function visibilityFromRoles(roles: { manager: boolean; cashier: boolean }): DocumentVisibility {
  if (roles.cashier) return "ALL_AUTHENTICATED";
  if (roles.manager) return "ADMIN_MANAGER";
  return "ADMIN_ONLY";
}

function rolesFromVisibility(visibility: DocumentVisibility) {
  return {
    admin: true,
    manager: visibility === "ADMIN_MANAGER" || visibility === "ALL_AUTHENTICATED",
    cashier: visibility === "ALL_AUTHENTICATED",
  };
}

function dateInputValue(value?: string | null) {
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 10);
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

function documentDisplayTitle(doc: Pick<DocumentRecord, "title" | "fileName">) {
  return doc.title?.trim() || doc.fileName;
}

function uploadFileKey(file: File) {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

function suggestedDocumentTitle(fileName: string) {
  const baseName = fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (/^(whatsapp (image|document)|screenshot|img[ _-]?\d|image[ _-]?\d)/i.test(baseName)) return "";
  return baseName.slice(0, 160);
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

function DocumentThumbnail({ doc }: { doc: DocumentRecord }) {
  const [thumbUrl, setThumbUrl] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl = "";

    async function loadThumb() {
      if (!doc.mimeType.startsWith("image/") || !doc.thumbnailFileName) {
        setThumbUrl("");
        setFailed(false);
        return;
      }

      try {
        setFailed(false);
        const blob = await fetchDocumentThumbnailBlobApi(doc.id);
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
  }, [doc.id, doc.mimeType, doc.thumbnailFileName]);

  if (doc.mimeType.startsWith("image/") && thumbUrl) {
    return (
      <img
        src={thumbUrl}
        alt=""
        className="h-full w-full bg-white object-contain p-1"
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

function LocalFilePreview({ file }: { file: File }) {
  const [previewUrl, setPreviewUrl] = useState("");

  useEffect(() => {
    let objectUrl = URL.createObjectURL(file);
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  if (!previewUrl) return null;

  if (file.type.startsWith("image/")) {
    return (
      <img
        src={previewUrl}
        alt={file.name}
        className="block max-h-[60vh] w-full object-contain rounded-[12px] bg-[#E5E7EB]"
      />
    );
  }

  if (file.type === "application/pdf") {
    const pdfUrl = previewUrl.includes("#") ? previewUrl : `${previewUrl}#view=FitH`;
    return (
      <iframe
        src={pdfUrl}
        title={file.name}
        className="block h-[60vh] w-full border-0 rounded-[12px] bg-white"
      />
    );
  }

  return (
    <div className="flex h-[260px] flex-col items-center justify-center rounded-[12px] bg-[#F3F4F6] text-center text-[#8C8889]">
      <Icon name="description" sizePx={58} className="mb-3 text-[#D1D5DB]" />
      <div className="text-[14px] font-extrabold text-[#565449]">Preview not available</div>
      <div className="mt-1 text-[12px] font-semibold">{file.name}</div>
    </div>
  );
}

export default function DocumentsPage() {
  const { showToast } = useToast();
  const [rateLimitRecoveryKey, setRateLimitRecoveryKey] = useState(0);
  const requestRateLimitRecovery = useRateLimitRecovery(() => {
    setRateLimitRecoveryKey((current) => current + 1);
  });
  const authUser = getAuthUser();
  const isAdmin = authUser?.role === "admin";
  const canManageDocuments = authUser?.role === "admin" || authUser?.role === "manager";

  const [mode, setMode] = useState<WorkspaceMode>("list");
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const documentListRef = useRef<HTMLElement>(null);
  const [selectedDoc, setSelectedDoc] = useState<DocumentRecord | null>(null);
  const [mobileActionDoc, setMobileActionDoc] = useState<DocumentRecord | null>(null);
  const [mobileFullPreview, setMobileFullPreview] = useState(false);
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);

  const [typeFilter, setTypeFilter] = useState<DocumentType | "ALL">("ALL");
  const [processingStatusFilter, setProcessingStatusFilter] =
    useState<ProcessingStatusFilter>("ALL");
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>("ALL");
  const [supplierSearch, setSupplierSearch] = useState("");
  const [billSearch, setBillSearch] = useState("");
  const [documentQuery, setDocumentQuery] = useState("");
  const [debouncedDocumentQuery, setDebouncedDocumentQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [mobileFilterApplyKey, setMobileFilterApplyKey] = useState(0);
  const [draftTypeFilter, setDraftTypeFilter] = useState<DocumentType | "ALL">("ALL");
  const [draftProcessingStatusFilter, setDraftProcessingStatusFilter] = useState<ProcessingStatusFilter>("ALL");
  const [draftVisibilityFilter, setDraftVisibilityFilter] = useState<VisibilityFilter>("ALL");
  const [draftBillSearch, setDraftBillSearch] = useState("");
  const [draftDateFrom, setDraftDateFrom] = useState("");
  const [draftDateTo, setDraftDateTo] = useState("");

  const [isLoading, setIsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [visibilitySavingId, setVisibilitySavingId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [detailExpanded, setDetailExpanded] = useState(false);
  const [editingDoc, setEditingDoc] = useState<DocumentRecord | null>(null);
  const [editType, setEditType] = useState<DocumentType>("GENERAL");
  const [editTitle, setEditTitle] = useState("");
  const [editTitleError, setEditTitleError] = useState("");
  const editTitleRef = useRef<HTMLInputElement>(null);
  const [editSupplier, setEditSupplier] = useState("");
  const [editBillNumber, setEditBillNumber] = useState("");
  const [editBillDate, setEditBillDate] = useState("");
  const [editBillAmount, setEditBillAmount] = useState("");
  const [editBillAmountError, setEditBillAmountError] = useState("");
  const editBillAmountRef = useRef<HTMLInputElement>(null);
  const [editRemarks, setEditRemarks] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [visibilityDoc, setVisibilityDoc] = useState<DocumentRecord | null>(null);
  const [visibilityRoles, setVisibilityRoles] = useState({ admin: true, manager: true, cashier: true });

  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadTitles, setUploadTitles] = useState<Record<string, string>>({});
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
    documentQuery ||
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

  async function loadDocuments(options?: { signal?: AbortSignal }) {
    try {
      setIsLoading(true);
      const res = await listDocumentsApi({
        page,
        pageSize,
        q: debouncedDocumentQuery.trim() || undefined,
        documentType: typeFilter === "ALL" ? undefined : typeFilter,
        processingStatus:
          processingStatusFilter === "ALL" ? undefined : processingStatusFilter,
        visibility: visibilityFilter === "ALL" ? undefined : visibilityFilter,
        supplierName: supplierSearch.trim() || undefined,
        billNumber: billSearch.trim() || undefined,
        from: dateFrom ? new Date(dateFrom).toISOString() : undefined,
        to: dateTo ? new Date(`${dateTo}T23:59:59`).toISOString() : undefined,
      }, options);

      setDocuments(res.documents);
      setTotal(res.total);
      setSelectedDoc((current) =>
        current && res.documents.some((doc) => doc.id === current.id) ? current : null,
      );
    } catch (err: any) {
      if (options?.signal?.aborted || err?.code === "ERR_CANCELED") return;
      if (isRateLimitError(err)) {
        requestRateLimitRecovery();
        return;
      }
      showToast("danger", err?.message || "Failed to load documents.", {
        persistent: true,
      });
    } finally {
      if (!options?.signal?.aborted) setIsLoading(false);
    }
  }

  async function loadStorageInfo(options?: { signal?: AbortSignal }) {
    if (!isAdmin) return;
    try {
      setStorageInfo(await getStorageInfoApi(options));
    } catch (error: any) {
      if (options?.signal?.aborted || error?.code === "ERR_CANCELED") return;
      if (isRateLimitError(error)) {
        requestRateLimitRecovery();
        return;
      }
      setStorageInfo(null);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedDocumentQuery(documentQuery.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [documentQuery]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => void loadDocuments({ signal: controller.signal }),
      120,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, debouncedDocumentQuery, typeFilter, processingStatusFilter, visibilityFilter, dateFrom, dateTo, mobileFilterApplyKey, rateLimitRecoveryKey]);

  useEffect(() => {
    const controller = new AbortController();
    void loadStorageInfo({ signal: controller.signal });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, rateLimitRecoveryKey]);

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
    setUploadTitles({});
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

  function openUploadWorkspace(type?: DocumentType) {
    resetUploadForm();
    setUploadType(type || "STOCK_BILL");
    setMode("upload");
  }

  function addUploadFiles(files: FileList | File[]) {
    const incoming = Array.from(files);
    setUploadTitles((currentTitles) => {
      const nextTitles = { ...currentTitles };
      for (const file of incoming) {
        const key = uploadFileKey(file);
        if (!(key in nextTitles)) nextTitles[key] = suggestedDocumentTitle(file.name);
      }
      return nextTitles;
    });
    setUploadFiles((current) => {
      const next = [...current, ...incoming];
      const seen = new Set<string>();
      return next
        .filter((file) => {
          const key = uploadFileKey(file);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 5);
    });
    setUploadError("");
  }

  function removeUploadFile(index: number) {
    const removed = uploadFiles[index];
    if (removed) {
      setUploadTitles((titles) => {
        const next = { ...titles };
        delete next[uploadFileKey(removed)];
        return next;
      });
    }
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

    const titles = uploadFiles.map((file) => uploadTitles[uploadFileKey(file)]?.trim() || "");
    const missingTitleIndex = titles.findIndex((title) => title.length < 2);
    if (missingTitleIndex >= 0) {
      setUploadError(`Add a clear, searchable title for ${uploadFiles[missingTitleIndex].name}.`);
      document.getElementById(`upload-document-title-${missingTitleIndex}`)?.focus();
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
        titles,
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
      setUploadTitles({});
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

  function openEditDetails(doc: DocumentRecord) {
    setEditingDoc(doc);
    setEditTitle(documentDisplayTitle(doc));
    setEditTitleError("");
    setEditType(doc.documentType);
    setEditSupplier(doc.supplierName || "");
    setEditBillNumber(doc.billNumber || "");
    setEditBillDate(dateInputValue(doc.billDate));
    setEditBillAmount(doc.billAmount === null || doc.billAmount === undefined ? "" : String(doc.billAmount));
    setEditBillAmountError("");
    setEditRemarks(doc.remarks || "");
  }

  async function submitEditDetails() {
    if (!editingDoc) return;

    const title = editTitle.trim();
    if (title.length < 2) {
      setEditTitleError("Enter a clear document title with at least 2 characters.");
      focusInvalidField(editTitleRef);
      return;
    }

    const billAmount = editBillAmount.trim() ? Number(editBillAmount) : null;
    if (billAmount !== null && (!Number.isFinite(billAmount) || billAmount < 0)) {
      setEditBillAmountError("Enter zero or a positive bill amount.");
      focusInvalidField(editBillAmountRef);
      return;
    }

    try {
      setEditBusy(true);
      const result = await updateDocumentMetadataApi(editingDoc.id, {
        title,
        documentType: editType,
        supplierName: editSupplier.trim() || null,
        billNumber: editBillNumber.trim() || null,
        billDate: editBillDate || null,
        billAmount,
        remarks: editRemarks.trim() || null,
      });
      setDocuments((current) =>
        current.map((item) => (item.id === editingDoc.id ? result.document : item)),
      );
      setSelectedDoc((current) => (current?.id === editingDoc.id ? result.document : current));
      setEditingDoc(null);
      showToast(result.changed ? "success" : "info", result.message || "Document details saved.");
    } catch (err: any) {
      showToast("danger", err?.message || "Failed to update document details.");
    } finally {
      setEditBusy(false);
    }
  }

  function openVisibilityDialog(doc: DocumentRecord) {
    setVisibilityDoc(doc);
    setVisibilityRoles(rolesFromVisibility(doc.visibility));
  }

  async function confirmVisibilityChange() {
    if (!visibilityDoc) return;
    const nextVisibility = visibilityFromRoles(visibilityRoles);
    await handleVisibilityChange(visibilityDoc, nextVisibility);
    setVisibilityDoc(null);
  }

  function openFullView(doc: DocumentRecord) {
    if (window.matchMedia("(max-width: 1023px)").matches) {
      setSelectedDoc(doc);
      setMobileActionDoc(null);
      setMobileFullPreview(true);
      return;
    }
    window.open(`/documents/${doc.id}/view`, "_blank", "noopener,noreferrer");
  }

  function clearFilters() {
    setDocumentQuery("");
    setDebouncedDocumentQuery("");
    setSupplierSearch("");
    setBillSearch("");
    setDateFrom("");
    setDateTo("");
    setTypeFilter("ALL");
    setProcessingStatusFilter("ALL");
    setVisibilityFilter("ALL");
    setPage(1);
    setMobileFilterApplyKey((key) => key + 1);
  }

  const mobileFilterCount = [
    Boolean(billSearch.trim()),
    typeFilter !== "ALL",
    processingStatusFilter !== "ALL",
    isAdmin && visibilityFilter !== "ALL",
    Boolean(dateFrom || dateTo),
  ].filter(Boolean).length;
  const mobileFilterChips: MobileFilterChip[] = [
    ...(billSearch.trim() ? [{ id: "bill", label: `Bill: ${billSearch.trim()}`, onRemove: () => { setBillSearch(""); setPage(1); setMobileFilterApplyKey((key) => key + 1); } }] : []),
    ...(typeFilter !== "ALL" ? [{ id: "type", label: typeLabel(typeFilter), onRemove: () => { setTypeFilter("ALL"); setPage(1); } }] : []),
    ...(processingStatusFilter !== "ALL" ? [{ id: "processing", label: processingStatusFilter === "PROCESSED" ? "Linked" : "Unprocessed", onRemove: () => { setProcessingStatusFilter("ALL"); setPage(1); } }] : []),
    ...(isAdmin && visibilityFilter !== "ALL" ? [{ id: "visibility", label: visibilityLabel(visibilityFilter), onRemove: () => { setVisibilityFilter("ALL"); setPage(1); } }] : []),
    ...(dateFrom || dateTo ? [{ id: "dates", label: `${dateFrom || "Any"} – ${dateTo || "Any"}`, onRemove: () => { setDateFrom(""); setDateTo(""); setPage(1); } }] : []),
  ];

  function openMobileFilters() {
    setDraftBillSearch(billSearch);
    setDraftTypeFilter(typeFilter);
    setDraftProcessingStatusFilter(processingStatusFilter);
    setDraftVisibilityFilter(visibilityFilter);
    setDraftDateFrom(dateFrom);
    setDraftDateTo(dateTo);
    setMobileFiltersOpen(true);
  }

  function applyMobileFilters() {
    setBillSearch(draftBillSearch);
    setTypeFilter(draftTypeFilter);
    setProcessingStatusFilter(draftProcessingStatusFilter);
    setVisibilityFilter(draftVisibilityFilter);
    setDateFrom(draftDateFrom);
    setDateTo(draftDateTo);
    setPage(1);
    setMobileFilterApplyKey((key) => key + 1);
    setMobileFiltersOpen(false);
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
        <div className="flex h-full w-full items-center justify-center overflow-hidden bg-[#F3F4F6] p-2">
          <img
            src={previewUrl}
            alt={doc.fileName}
            className="block max-h-full max-w-full object-contain"
          />
        </div>
      );
    }

    if (doc.mimeType === "application/pdf") {
      // Append #view=FitH to force the PDF viewer to fit to width, 
      // preventing massive empty grey space when the modal is expanded.
      const pdfUrl = previewUrl.includes('#') ? previewUrl : `${previewUrl}#view=FitH`;
      
      return (
        <iframe
          src={pdfUrl}
          title={doc.fileName}
          className="h-full w-full border-0 bg-white"
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
      <div className={cn("flex items-center gap-2", compact ? "justify-start" : "justify-center")}>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setSelectedDoc(doc); }}
          title="Preview"
          className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-white text-[#565449] transition hover:bg-[#F3F4F6]"
        >
          <Icon name="visibility" sizePx={18} />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); void handleDownload(doc); }}
          title="Download"
          className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-white text-[#565449] transition hover:bg-[#F3F4F6]"
        >
          <Icon name="download" sizePx={18} />
        </button>
        {canManageDocuments ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setDeletingId(doc.id); }}
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
        <table className="w-full min-w-[1040px] border-collapse text-left text-[13px]">
          <thead className="sticky top-0 z-10 bg-[#F8FAFC]">
            <tr className="border-b border-[#DADDE3] text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
              <th className="px-4 py-3">Document</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Supplier / Bill</th>
              <th className="px-4 py-3">Amount</th>
              <th className="px-4 py-3">Uploaded</th>
              <th className="px-4 py-3">Visibility</th>
              <th className="px-4 py-3 text-center">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E5E7EB]">
            {documents.map((doc) => (
              <tr
                key={doc.id}
                onClick={() => setSelectedDoc(doc)}
                className="cursor-pointer transition-colors hover:bg-[#ECEFF3]"
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="h-[48px] w-[48px] shrink-0 overflow-hidden rounded-[10px] border border-[#E5E7EB] bg-[#F3F4F6]">
                      <DocumentThumbnail doc={doc} />
                    </div>
                    <div className="min-w-0">
                      <div className="max-w-[260px] truncate font-extrabold text-[#11120d]" title={documentDisplayTitle(doc)}>
                        {documentDisplayTitle(doc)}
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
                  {doc.supplierName || doc.billNumber || doc.billDate ? (
                    <>
                      {doc.supplierName ? <div className="font-extrabold text-[#11120d]">{doc.supplierName}</div> : null}
                      <div className={cn("text-[11px] font-semibold text-[#64748B]", doc.supplierName && "mt-1")}>
                        {[doc.billNumber ? `Bill ${doc.billNumber}` : "", doc.billDate ? formatDate(doc.billDate) : ""].filter(Boolean).join(" · ")}
                      </div>
                    </>
                  ) : (
                    <span className="text-[11px] font-semibold text-[#8C8889]">No business details</span>
                  )}
                </td>
                <td className="px-4 py-3 font-mono font-extrabold text-[#11120d]">
                  {doc.billAmount != null ? formatMoney(doc.billAmount) : <span className="font-sans text-[11px] font-semibold text-[#8C8889]">Not recorded</span>}
                </td>
                <td className="px-4 py-3">
                  <div className="font-semibold text-[#11120d]">{formatDate(doc.createdAt)}</div>
                  <div className="mt-1 text-[11px] font-semibold text-[#8C8889]">
                    by {doc.uploadedBy?.name || "System"}
                  </div>
                </td>
                <td className="px-4 py-3">
                  {isAdmin ? (
                    <button
                      type="button"
                      disabled={visibilitySavingId === doc.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        openVisibilityDialog(doc);
                      }}
                      onDoubleClick={(event) => event.stopPropagation()}
                      onMouseDown={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                      className="group inline-flex items-center rounded-full outline-none transition disabled:opacity-60"
                      title="Change visibility"
                    >
                      <DocumentBadge className={cn("transition group-hover:shadow-[0_0_0_2px_rgba(17,18,13,0.1)] group-active:scale-95", visibilityBadgeClass(doc.visibility))}>
                        <span className="flex items-center gap-1">
                          {visibilityLabel(doc.visibility)}
                          <Icon name="edit" sizePx={12} className="opacity-0 transition-opacity group-hover:opacity-100" />
                        </span>
                      </DocumentBadge>
                    </button>
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
        {documents.map((doc) => {
          const businessReference = [
            doc.supplierName?.trim(),
            doc.billNumber?.trim() ? `Bill ${doc.billNumber.trim()}` : "",
          ].filter(Boolean).join(" · ");

          return (
            <article
              key={doc.id}
              role="button"
              tabIndex={0}
              onClick={() => {
                setMobileFullPreview(false);
                setSelectedDoc(doc);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setMobileFullPreview(false);
                  setSelectedDoc(doc);
                }
              }}
              className="w-full rounded-[16px] border border-[#DADDE3] bg-white p-3 text-left shadow-sm transition active:bg-[#F3F4F6]"
            >
              <div className="flex items-start gap-3">
                <div className="h-[68px] w-[68px] shrink-0 overflow-hidden rounded-[13px] border border-[#E5E7EB] bg-[#F8FAFC]">
                  <DocumentThumbnail doc={doc} />
                </div>
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="break-words text-[14px] font-extrabold leading-5 text-[#11120d]">
                    {documentDisplayTitle(doc)}
                  </div>
                  <div className="mt-1.5 text-[11px] font-bold text-[#64748B]">
                    {typeLabel(doc.documentType)} · {formatBytes(doc.fileSize)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setMobileActionDoc(doc);
                  }}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] border border-[#E5E7EB] bg-white text-[#565449] active:bg-[#ECEFF3]"
                  aria-label={`Actions for ${documentDisplayTitle(doc)}`}
                >
                  <Icon name="more_vert" sizePx={22} />
                </button>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <DocumentBadge className={processingBadgeClass(doc)}>
                  {doc.processingStatus === "PROCESSED" ? "Linked" : "Needs review"}
                </DocumentBadge>
                <DocumentBadge className={visibilityBadgeClass(doc.visibility)}>
                  {visibilityLabel(doc.visibility)}
                </DocumentBadge>
              </div>

              <div className="mt-3 border-t border-[#E5E7EB] pt-3 text-[12px] font-semibold text-[#565449]">
                {businessReference ? (
                  <div className="flex items-start gap-2">
                    <Icon name="receipt_long" sizePx={16} className="mt-0.5 shrink-0 text-[#8C8889]" />
                    <span className="min-w-0 break-words">{businessReference}</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Icon name="person" sizePx={16} className="shrink-0 text-[#8C8889]" />
                    <span>Uploaded by {doc.uploadedBy?.name || "System"}</span>
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    );
  }

  function changeDocumentPage(nextPage: number) {
    setPage(nextPage);
    window.requestAnimationFrame(() => {
      documentListRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
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

type DocumentTouchViewerProps = {
  doc: DocumentRecord;
  previewUrl: string | null;
  previewError?: string | null;
  onTapToEnlarge?: () => void;
  interactive?: boolean;
};

function DocumentTouchViewer({
  doc,
  previewUrl,
  previewError,
  onTapToEnlarge,
  interactive = false,
}: DocumentTouchViewerProps) {
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  const containerRef = useRef<HTMLDivElement>(null);
  const startDistanceRef = useRef<number>(0);
  const startScaleRef = useRef<number>(1);
  const startTouchRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const startPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const lastTapRef = useRef<number>(0);

  const isPDF = doc.mimeType === "application/pdf";
  const isImage = doc.mimeType.startsWith("image/");

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      startDistanceRef.current = dist;
      startScaleRef.current = scale;
    } else if (e.touches.length === 1) {
      startTouchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      startPosRef.current = { ...position };

      const now = Date.now();
      if (now - lastTapRef.current < 300) {
        if (scale > 1) {
          setScale(1);
          setPosition({ x: 0, y: 0 });
        } else {
          setScale(2);
        }
      }
      lastTapRef.current = now;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && startDistanceRef.current > 0) {
      const currentDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const newScale = Math.min(
        Math.max(1, startScaleRef.current * (currentDist / startDistanceRef.current)),
        4
      );
      setScale(newScale);
      if (newScale === 1) setPosition({ x: 0, y: 0 });
    } else if (e.touches.length === 1 && scale > 1) {
      const dx = e.touches[0].clientX - startTouchRef.current.x;
      const dy = e.touches[0].clientY - startTouchRef.current.y;
      setPosition({
        x: startPosRef.current.x + dx,
        y: startPosRef.current.y + dy,
      });
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length < 2) {
      startDistanceRef.current = 0;
    }
  };

  const zoomIn = () => setScale((prev) => Math.min(4, Math.round((prev + 0.5) * 10) / 10));
  const zoomOut = () =>
    setScale((prev) => {
      const next = Math.max(1, Math.round((prev - 0.5) * 10) / 10);
      if (next === 1) setPosition({ x: 0, y: 0 });
      return next;
    });
  const resetZoom = () => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  if (previewError) {
    return (
      <div className="flex h-full min-h-[260px] flex-col items-center justify-center text-center text-[#8C8889]">
        <Icon name="error" sizePx={44} className="mb-3 text-rose-500" />
        <div className="text-[13px] font-extrabold text-[#565449]">{previewError}</div>
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

  const pdfUrl = previewUrl.includes("#") ? previewUrl : `${previewUrl}#view=FitH`;

  return (
    <div
      ref={containerRef}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      className="relative flex h-full w-full flex-col overflow-hidden bg-[#F3F4F6] touch-manipulation select-none"
    >
      <div className="relative flex-1 min-h-0 w-full overflow-auto overscroll-contain">
        <div
          className="flex h-full w-full items-center justify-center transition-transform duration-75 origin-center"
          style={{
            transform: `translate3d(${position.x}px, ${position.y}px, 0) scale(${scale})`,
          }}
        >
          {isImage ? (
            <img
              src={previewUrl}
              alt={doc.fileName}
              className="block max-h-full max-w-full object-contain pointer-events-none"
            />
          ) : isPDF ? (
            <iframe
              src={pdfUrl}
              title={doc.fileName}
              className="h-full w-full border-0 bg-white"
            />
          ) : (
            <div className="flex h-full min-h-[260px] flex-col items-center justify-center text-center text-[#8C8889]">
              <Icon name="description" sizePx={58} className="mb-3 text-[#D1D5DB]" />
              <div className="text-[14px] font-extrabold text-[#565449]">Preview not available</div>
              <div className="mt-1 text-[12px] font-semibold">Download this file to inspect it.</div>
            </div>
          )}
        </div>
      </div>

      <div className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-slate-700/30 bg-[#11120D]/85 px-3 py-1.5 text-white shadow-xl backdrop-blur-md">
        <button
          type="button"
          onClick={zoomOut}
          disabled={scale <= 1}
          className="flex h-8 w-8 items-center justify-center rounded-full transition hover:bg-white/20 active:scale-95 disabled:opacity-40"
          title="Zoom out (-)"
        >
          <Icon name="zoom_out" sizePx={18} />
        </button>
        <button
          type="button"
          onClick={resetZoom}
          className="px-2 text-[11px] font-extrabold tracking-wider text-slate-200 transition hover:text-white"
          title="Reset zoom to 100%"
        >
          {Math.round(scale * 100)}%
        </button>
        <button
          type="button"
          onClick={zoomIn}
          disabled={scale >= 4}
          className="flex h-8 w-8 items-center justify-center rounded-full transition hover:bg-white/20 active:scale-95 disabled:opacity-40"
          title="Zoom in (+)"
        >
          <Icon name="zoom_in" sizePx={18} />
        </button>
        {onTapToEnlarge && !interactive ? (
          <>
            <span className="h-4 w-px bg-white/20" />
            <button
              type="button"
              onClick={onTapToEnlarge}
              className="flex h-8 items-center gap-1.5 rounded-full bg-white/15 px-2.5 text-[11px] font-extrabold text-white transition hover:bg-white/25 active:scale-95"
            >
              <Icon name="fullscreen" sizePx={16} />
              Enlarge
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

  function renderDetailView() {
    if (!selectedDoc) return null;

    if (mobileFullPreview) {
      return (
        <div className="flex h-[calc(100dvh-130px)] min-h-[420px] flex-col lg:hidden">
          <div className="mb-3 flex items-center justify-between gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setMobileFullPreview(false)}
              className="inline-flex h-11 items-center gap-2 rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-extrabold text-[#11120d]"
            >
              <Icon name="arrow_back" sizePx={18} />
              Details
            </button>
            <button
              type="button"
              onClick={() => void handleDownload(selectedDoc)}
              className="inline-flex h-11 items-center gap-2 rounded-[12px] bg-[#11120d] px-4 text-[12px] font-extrabold text-white"
            >
              <Icon name="download" sizePx={18} />
              Download
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden rounded-[14px] border border-[#DADDE3] bg-[#F3F4F6]">
            <DocumentTouchViewer
              doc={selectedDoc}
              previewUrl={previewUrl}
              previewError={previewError}
              interactive
            />
          </div>
        </div>
      );
    }

    return (
      <>
        <div className="space-y-4 lg:hidden">
          <div
            className="group relative block h-[380px] sm:h-[480px] w-full overflow-hidden rounded-[16px] border border-[#DADDE3] bg-[#F3F4F6] text-left"
            aria-label={`Open ${documentDisplayTitle(selectedDoc)} full screen`}
          >
            <DocumentTouchViewer
              doc={selectedDoc}
              previewUrl={previewUrl}
              previewError={previewError}
              onTapToEnlarge={() => openFullView(selectedDoc)}
            />
          </div>

          <button
            type="button"
            onClick={() => void handleDownload(selectedDoc)}
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-[13px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-extrabold text-[#11120d]"
          >
            <Icon name="download" sizePx={18} />
            Download original file
          </button>

          <div className="flex flex-wrap gap-2">
            <DocumentBadge className={processingBadgeClass(selectedDoc)}>
              {selectedDoc.processingStatus === "PROCESSED" ? "Linked" : "Needs review"}
            </DocumentBadge>
            <DocumentBadge className={visibilityBadgeClass(selectedDoc.visibility)}>
              {visibilityLabel(selectedDoc.visibility)}
            </DocumentBadge>
          </div>

          <section className="rounded-[16px] border border-[#DADDE3] bg-white p-4">
            <h2 className="text-[13px] font-extrabold text-[#11120d]">Document information</h2>
            <div className="mt-3 divide-y divide-[#E5E7EB]">
              {[
                selectedDoc.supplierName ? ["Supplier", selectedDoc.supplierName] : null,
                selectedDoc.billNumber ? ["Bill number", selectedDoc.billNumber] : null,
                selectedDoc.billDate ? ["Bill date", formatDate(selectedDoc.billDate)] : null,
                selectedDoc.billAmount != null ? ["Bill amount", formatMoney(selectedDoc.billAmount)] : null,
                ["Uploaded by", selectedDoc.uploadedBy?.name || "System"],
                ["Uploaded", formatDateTime(selectedDoc.createdAt)],
                ["File", selectedDoc.mimeType === "application/pdf" ? "PDF" : selectedDoc.mimeType.startsWith("image/") ? "Image" : typeLabel(selectedDoc.documentType)],
                ["Size", formatBytes(selectedDoc.fileSize)],
                documentDisplayTitle(selectedDoc) !== selectedDoc.fileName ? ["Original file", selectedDoc.fileName] : null,
              ].filter((item): item is string[] => Boolean(item)).map(([label, value]) => (
                <div key={label} className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
                  <span className="text-[11px] font-extrabold uppercase tracking-wide text-[#64748B]">{label}</span>
                  <span className="min-w-0 text-right text-[13px] font-bold text-[#11120d]">{value}</span>
                </div>
              ))}
            </div>
          </section>

          {selectedDoc.remarks ? (
            <section className="rounded-[16px] border border-[#E5E7EB] bg-[#F8FAFC] p-4">
              <div className="text-[11px] font-extrabold uppercase tracking-wide text-[#64748B]">Remarks</div>
              <div className="mt-2 whitespace-pre-wrap text-[13px] font-semibold leading-6 text-[#565449]">{selectedDoc.remarks}</div>
            </section>
          ) : null}

          <div className="space-y-2 pb-2">
            {canManageDocuments ? (
              <button
                type="button"
                onClick={() => openEditDetails(selectedDoc)}
                className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-[13px] border border-[#CFCFD3] bg-white px-4 text-[12px] font-extrabold text-[#11120d]"
              >
                <Icon name="edit" sizePx={18} />
                Edit details
              </button>
            ) : null}
            {isAdmin ? (
              <button
                type="button"
                onClick={() => openVisibilityDialog(selectedDoc)}
                className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-[13px] border border-[#CFCFD3] bg-white px-4 text-[12px] font-extrabold text-[#11120d]"
              >
                <Icon name="admin_panel_settings" sizePx={18} />
                Change visibility
              </button>
            ) : null}
          </div>
        </div>

      <div
        className={cn(
          "hidden min-h-0 grid-cols-1 gap-5 lg:grid lg:h-[75vh]",
          detailExpanded ? "lg:h-[calc(100dvh-170px)] lg:grid-cols-[1fr_320px]" : "lg:grid-cols-[1fr_360px]",
        )}
      >
        <div className="grid grid-cols-2 gap-2 lg:hidden">
          <button type="button" onClick={() => openEditDetails(selectedDoc)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#CFCFD3] bg-white px-3 text-[12px] font-extrabold text-[#565449]">
            <Icon name="edit" sizePx={17} />
            Edit details
          </button>
          <button type="button" onClick={() => openFullView(selectedDoc)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#CFCFD3] bg-white px-3 text-[12px] font-extrabold text-[#565449]">
            <Icon name="open_in_new" sizePx={17} />
            Open file
          </button>
        </div>

        {/* Left side: Document Viewer (full height, no scrollbars outside viewer) */}
        <div className="flex h-[240px] flex-col overflow-hidden rounded-[16px] border border-[#E5E7EB] bg-[#F3F4F6] sm:h-[320px] lg:h-full">
 
          <div className="flex-1 overflow-hidden">
            <DocumentTouchViewer
              doc={selectedDoc}
              previewUrl={previewUrl}
              previewError={previewError}
              interactive
            />
          </div>
        </div>

        {/* Right side: Metadata Sidebar */}
        <div className="flex flex-col lg:h-full lg:overflow-y-auto lg:pr-2">
          <div className="flex flex-wrap gap-2">
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

          {selectedDoc.supplierName || selectedDoc.billNumber || selectedDoc.billDate || selectedDoc.billAmount != null ? (
            <section className="mt-6 rounded-[14px] border border-[#E5E7EB] bg-white p-4">
              <div className="text-[11px] font-extrabold uppercase tracking-wide text-[#565449]">Business details</div>
              <div className="mt-2 divide-y divide-[#E5E7EB]">
                {[
                  selectedDoc.supplierName ? ["Supplier", selectedDoc.supplierName] : null,
                  selectedDoc.billNumber ? ["Bill number", selectedDoc.billNumber] : null,
                  selectedDoc.billDate ? ["Bill date", formatDate(selectedDoc.billDate)] : null,
                  selectedDoc.billAmount != null ? ["Bill amount", formatMoney(selectedDoc.billAmount)] : null,
                ].filter((item): item is string[] => Boolean(item)).map(([label, value]) => (
                  <div key={label} className="flex items-start justify-between gap-4 py-3 first:pt-1 last:pb-1">
                    <span className="text-[10px] font-extrabold uppercase tracking-wide text-[#64748B]">{label}</span>
                    <span className="min-w-0 text-right text-[13px] font-bold text-[#11120d]">{value}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="mt-6 rounded-[14px] border border-[#E5E7EB] bg-[#F8FAFC] p-4">
            <div className="text-[11px] font-extrabold uppercase tracking-wide text-[#565449]">File information</div>
            <div className="mt-2 divide-y divide-[#E5E7EB]">
              {[
                ["Uploaded by", selectedDoc.uploadedBy?.name || "System"],
                ["Uploaded", formatDateTime(selectedDoc.createdAt)],
                ["Format", fileKindLabel(selectedDoc.mimeType)],
                ["Size", formatBytes(selectedDoc.fileSize)],
                documentDisplayTitle(selectedDoc) !== selectedDoc.fileName ? ["Original file", selectedDoc.fileName] : null,
              ].filter((item): item is string[] => Boolean(item)).map(([label, value]) => (
                <div key={label} className="flex items-start justify-between gap-4 py-3 first:pt-1 last:pb-1">
                  <span className="text-[10px] font-extrabold uppercase tracking-wide text-[#64748B]">{label}</span>
                  <span className="min-w-0 max-w-[190px] break-words text-right text-[13px] font-bold text-[#11120d]">{value}</span>
                </div>
              ))}
            </div>
          </section>

          {selectedDoc.remarks ? (
            <div className="mt-6 rounded-[14px] border border-[#E5E7EB] bg-[#F8FAFC] p-4">
              <div className="text-[10px] font-extrabold uppercase tracking-widest text-[#565449]">Remarks</div>
              <div className="mt-2 whitespace-pre-wrap text-[13px] font-medium leading-relaxed text-[#565449]">{selectedDoc.remarks}</div>
            </div>
          ) : null}

          {isAdmin ? (
            <div className="mt-6">
              <div className="text-[10px] font-extrabold uppercase tracking-widest text-[#8C8889]">Visibility</div>
              <button
                type="button"
                onClick={() => openVisibilityDialog(selectedDoc)}
                disabled={visibilitySavingId === selectedDoc.id}
                className="mt-2 flex h-[44px] w-full items-center justify-between rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-extrabold text-[#11120d] outline-none transition hover:bg-[#F3F4F6] disabled:opacity-60"
              >
                <span>{visibilityLabel(selectedDoc.visibility)}</span>
                <Icon name="admin_panel_settings" sizePx={18} />
              </button>
            </div>
          ) : null}

          {/* Actions at bottom of sidebar */}
          <div className="mt-8 mb-2 flex flex-col gap-3">
            <button
              onClick={() => void handleDownload(selectedDoc)}
              className="flex h-[44px] items-center justify-center gap-2 rounded-[14px] border border-[#11120d] bg-[#11120d] px-4 text-[13px] font-extrabold text-white transition hover:bg-[#2a2c27]"
            >
              <Icon name="download" sizePx={18} />
              Download Document
            </button>
            <button
              onClick={() => setSelectedDoc(null)}
              className="flex h-[44px] items-center justify-center gap-2 rounded-[14px] border border-[#CFCFD3] bg-white px-4 text-[13px] font-extrabold text-[#11120d] transition hover:bg-[#F3F4F6]"
            >
              Close
            </button>
          </div>
        </div>
      </div>
      </>
    );
  }

  function renderUploadWorkspace() {
    const hasFiles = uploadFiles.length > 0;

    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6 lg:p-8 bg-white">
        <div className={cn("mx-auto", hasFiles ? "max-w-7xl" : "max-w-3xl")}>
          <div className="mb-6 flex items-center gap-4">
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
            <div>
              <h1 className="text-xl font-bold tracking-tight text-[#11120d] md:text-2xl">
                Add Document
              </h1>
              <p className="mt-1 text-xs font-medium text-slate-500 md:text-sm">
                Capture bill images, upload files, or store general documents. Date defaults to today.
              </p>
            </div>
          </div>

          <div className={cn(hasFiles ? "grid items-start gap-8 lg:grid-cols-[1fr_360px]" : "space-y-6")}>
            
            {/* Left Column (or full width if no files): Dropzone + Previews */}
            <div className="space-y-6 min-w-0">
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
                  "rounded-[20px] border-2 border-dashed text-center transition",
                  dragActive ? "border-[#11120d] bg-[#F8FAFC]" : "border-[#CFCFD3] bg-[#F3F4F6]",
                  hasFiles ? "px-5 py-6" : "px-5 py-12"
                )}
              >
                {!hasFiles && <Icon name="upload_file" sizePx={48} className="mx-auto mb-4 text-[#8C8889]" />}
                
                <div className="text-[15px] font-extrabold text-[#11120d]">
                  {hasFiles ? "Add more files" : "Drop files here or choose below"}
                </div>
                
                {!hasFiles && (
                  <div className="mt-2 text-[13px] font-semibold text-[#8C8889]">
                    Images and PDFs are supported by the backend.
                  </div>
                )}

                <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                  <label className="inline-flex h-[40px] cursor-pointer items-center gap-2 rounded-[12px] border border-[#11120d] bg-[#11120d] px-4 text-[13px] font-extrabold text-white transition hover:bg-[#2a2c27]">
                    <Icon name="photo_camera" sizePx={18} />
                    Take Photo
                    <input
                      type="file"
                      multiple
                      accept="image/jpeg,image/png,image/webp,application/pdf"
                      capture="environment"
                      className="hidden"
                      onChange={(event) => {
                        if (event.target.files) addUploadFiles(event.target.files);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                  <label className="inline-flex h-[40px] cursor-pointer items-center gap-2 rounded-[12px] border border-[#CFCFD3] bg-white px-4 text-[13px] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6]">
                    <Icon name="folder_open" sizePx={18} />
                    Choose File(s)
                    <input
                      type="file"
                      multiple
                      accept="image/jpeg,image/png,image/webp,application/pdf"
                      className="hidden"
                      onChange={(event) => {
                        if (event.target.files) addUploadFiles(event.target.files);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                </div>
              </div>

              {hasFiles ? (
                <div className="space-y-4">
                  {uploadFiles.map((file, index) => (
                    <div key={`${file.name}-${index}`} className="relative rounded-[16px] border border-[#E5E7EB] bg-[#F8FAFC] p-4 shadow-sm">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-[14px] font-extrabold text-[#11120d]">{file.name}</div>
                          <div className="mt-1 text-[12px] font-semibold text-[#8C8889]">
                            {file.type || "Unknown"} • {formatBytes(file.size)}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeUploadFile(index)}
                          className="flex h-[36px] items-center gap-2 rounded-[10px] border border-[#FECDD3] bg-[#FFF1F2] px-3 text-[12px] font-extrabold text-[#BE123C] transition hover:bg-rose-100"
                          title="Remove file"
                        >
                          <Icon name="delete" sizePx={16} />
                          Remove
                        </button>
                      </div>
                      <label className="mb-3 block">
                        <span className="text-[11px] font-extrabold uppercase tracking-wide text-[#565449]">
                          Document title <span className="text-rose-600">*</span>
                        </span>
                        <input
                          id={`upload-document-title-${index}`}
                          value={uploadTitles[uploadFileKey(file)] || ""}
                          maxLength={160}
                          onChange={(event) => {
                            const key = uploadFileKey(file);
                            setUploadTitles((current) => ({ ...current, [key]: event.target.value }));
                            setUploadError("");
                          }}
                          placeholder="e.g. Household supplier price list - July 2026"
                          className="mt-1 h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-semibold text-[#11120d] outline-none transition focus:border-[#11120d] focus:ring-2 focus:ring-slate-100"
                        />
                        <span className="mt-1.5 block text-[11px] font-semibold leading-4 text-[#64748B]">
                          Used in lists and search. Original file: {file.name}
                        </span>
                      </label>
                      <div className="overflow-hidden rounded-[12px] border border-[#E5E7EB] bg-white">
                        <LocalFilePreview file={file} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            {/* Right Column: Metadata Form (only shows if files are selected) */}
            {hasFiles ? (
              <div className="sticky top-6 rounded-[24px] border border-[#E5E7EB] bg-[#F8FAFC] p-6 shadow-sm min-w-0">
                
                {uploadError ? (
                  <div className="mb-6 rounded-[12px] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] font-semibold text-rose-700">
                    {uploadError}
                  </div>
                ) : null}

                {uploadResult.length > 0 ? (
                  <div className="mb-6 rounded-[14px] border border-emerald-200 bg-emerald-50 px-5 py-4">
                    <div className="text-[13px] font-extrabold uppercase text-emerald-700">Upload complete</div>
                    <div className="mt-1 text-[14px] font-semibold text-emerald-800">
                      {uploadResult.length} document{uploadResult.length === 1 ? "" : "s"} added to the inbox.
                    </div>
                    <div className="mt-4 flex flex-wrap gap-3">
                      <button
                        type="button"
                        onClick={() => setMode("list")}
                        className="h-[40px] rounded-[12px] border border-emerald-300 bg-white px-4 text-[13px] font-extrabold text-emerald-700 hover:bg-emerald-50"
                      >
                        View Inbox
                      </button>
                      <button
                        type="button"
                        onClick={() => resetUploadForm()}
                        className="h-[40px] rounded-[12px] border border-emerald-300 bg-white px-4 text-[13px] font-extrabold text-emerald-700 hover:bg-emerald-50"
                      >
                        Upload More
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="mb-5 text-[12px] font-extrabold uppercase tracking-wide text-[#8C8889]">Metadata</div>
                
                <div className="space-y-4">
                  <label className="block">
                    <span className="text-[11px] font-extrabold uppercase text-[#8C8889]">Document type</span>
                    <ProjectSelect
                      value={uploadType}
                      onChange={(event) => setUploadType(event.target.value as DocumentType)}
                      className="mt-1 h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-bold text-[#11120d] outline-none transition focus:border-[#11120d]"
                    >
                      {DOCUMENT_TYPE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </ProjectSelect>
                  </label>

                  <label className="block">
                    <span className="text-[11px] font-extrabold uppercase text-[#8C8889]">Supplier</span>
                    <ProjectSelect
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
                      className="mt-1 h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-bold text-[#11120d] outline-none transition focus:border-[#11120d]"
                    >
                      <option value="">Select supplier</option>
                      {supplierOptions.map((supplier) => (
                        <option key={supplier} value={supplier}>
                          {supplier}
                        </option>
                      ))}
                      <option value="__new">+ Add new supplier</option>
                    </ProjectSelect>
                    {uploadSupplierMode === "new" ? (
                      <input
                        value={uploadSupplier}
                        onChange={(event) => setUploadSupplier(event.target.value)}
                        placeholder="New supplier name"
                        className="mt-2 h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-semibold text-[#11120d] outline-none transition focus:border-[#11120d]"
                      />
                    ) : null}
                  </label>

                  <label className="block">
                    <span className="text-[11px] font-extrabold uppercase text-[#8C8889]">Bill date</span>
                    <ProjectDateInput
                      value={uploadBillDate}
                      onChange={(event) => setUploadBillDate(event.target.value)}
                      className="mt-1 h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-semibold text-[#11120d] outline-none transition focus:border-[#11120d]"
                    />
                  </label>

                  {uploadShowMoreDetails ? (
                    <>
                      <label className="block">
                        <span className="text-[11px] font-extrabold uppercase text-[#8C8889]">Bill no.</span>
                        <input
                          value={uploadBillNumber}
                          onChange={(event) => setUploadBillNumber(event.target.value)}
                          placeholder="Optional"
                          className="mt-1 h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-semibold text-[#11120d] outline-none transition focus:border-[#11120d]"
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
                          className="mt-1 h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-right text-[13px] font-semibold text-[#11120d] outline-none transition focus:border-[#11120d]"
                        />
                      </label>
                    </>
                  ) : (
                    <div className="flex items-end">
                      <button
                        type="button"
                        onClick={() => setUploadShowMoreDetails(true)}
                        className="h-[44px] w-full rounded-[12px] border border-dashed border-[#CFCFD3] bg-white px-3 text-[12px] font-extrabold text-[#565449] transition hover:border-[#11120d] hover:text-[#11120d]"
                      >
                        + Add optional bill details
                      </button>
                    </div>
                  )}

                  <label className="block">
                    <span className="text-[11px] font-extrabold uppercase text-[#8C8889]">Visibility</span>
                    <ProjectSelect
                      value={uploadVisibility}
                      onChange={(event) => setUploadVisibility(event.target.value as DocumentVisibility)}
                      className="mt-1 h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-bold text-[#11120d] outline-none transition focus:border-[#11120d]"
                    >
                      {VISIBILITY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </ProjectSelect>
                  </label>

                  <label className="block">
                    <span className="text-[11px] font-extrabold uppercase text-[#8C8889]">Remarks</span>
                    <textarea
                      value={uploadRemarks}
                      onChange={(event) => setUploadRemarks(event.target.value)}
                      rows={3}
                      placeholder="Short note, supplier context, or processing reminder"
                      className="mt-1 w-full resize-none rounded-[12px] border border-[#CFCFD3] bg-white px-4 py-3 text-[13px] font-semibold text-[#11120d] outline-none transition focus:border-[#11120d]"
                    />
                  </label>

                  <div className="mt-6 pt-6 border-t border-[#E5E7EB]">
                    <button
                      type="button"
                      onClick={() => void submitUpload()}
                      disabled={uploadBusy || uploadFiles.length === 0}
                      className="flex h-[48px] w-full items-center justify-center gap-2 rounded-[14px] border border-[#11120d] bg-[#11120d] px-6 text-[14px] font-extrabold text-white transition hover:bg-[#2a2c27] disabled:pointer-events-none disabled:opacity-50"
                    >
                      <Icon name="upload" sizePx={20} />
                      {uploadBusy ? "Uploading..." : "Upload Document"}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  if (mode === "upload") {
    return (
      <div className="flex h-full flex-col bg-white text-[#11120d]">
        {renderUploadWorkspace()}
      </div>
    );
  }

  return (
    <div className="-mx-2 flex min-h-full flex-col bg-white px-1 pb-6 pt-4 text-[#11120d] md:mx-0 md:rounded-[28px] md:p-6">
      <div className="mb-8 hidden flex-col gap-4 md:flex md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#11120d] md:text-3xl">Documents</h1>
          <p className="mt-1 text-sm font-medium text-[#8C8889] md:text-base">
            Upload bills, find files, preview details, and stage documents for stock or import work.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManageDocuments ? (
            <button
              type="button"
              onClick={() => openUploadWorkspace()}
              className="inline-flex h-[40px] items-center gap-2 rounded-[12px] border border-[#11120d] bg-[#11120d] px-4 text-[12px] font-extrabold text-white transition hover:bg-[#2a2c27]"
            >
              <Icon name="upload_file" sizePx={17} />
              Upload Document
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col w-full">
        <main className="flex min-h-0 flex-col w-full">
          <div className="mb-8 hidden grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3 md:grid">
            {[
              { label: "Visible documents", value: total, icon: "folder_open", tone: "text-[#2F67D8]" },
              { label: "Linked on page", value: processedCount, icon: "link", tone: "text-[#179B4D]" },
              { label: "Unprocessed on page", value: unprocessedCount, icon: "pending_actions", tone: "text-[#B7791F]" },
              { label: "Storage used", value: storageInfo ? formatBytes(storageInfo.totalSizeBytes) : "-", icon: "database", tone: "text-[#565449]" },
            ].map((card) => (
              <div
                key={card.label}
                className="min-h-[108px] rounded-[16px] border border-[#DADDE3] bg-white p-4 shadow-sm [container-type:inline-size]"
              >
                <div className="flex items-center gap-2">
                  <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-[#F3F4F6]", card.tone)}>
                    <Icon name={card.icon} sizePx={16} />
                  </div>
                  <div className="min-w-0 flex-1 truncate text-[10px] font-extrabold uppercase leading-snug tracking-[0.08em] text-[#64748B]">
                    {card.label}
                  </div>
                </div>
                <div className="mt-3 truncate font-mono text-[clamp(20px,12cqi,32px)] font-extrabold leading-none tracking-tight text-[#11120d]" title={String(card.value)}>
                  {card.value}
                </div>
              </div>
            ))}
          </div>

          <div className="mb-4 grid grid-cols-3 divide-x divide-[#E5E7EB] rounded-[14px] border border-[#DADDE3] bg-[#F8FAFC] py-3 md:hidden">
            <div className="px-2 text-center">
              <div className="font-mono text-[18px] font-extrabold text-[#11120d]">{total}</div>
              <div className="mt-1 text-[9px] font-extrabold uppercase tracking-wide text-[#64748B]">Documents</div>
            </div>
            <div className="px-2 text-center">
              <div className="font-mono text-[18px] font-extrabold text-[#B7791F]">{unprocessedCount}</div>
              <div className="mt-1 text-[9px] font-extrabold uppercase tracking-wide text-[#64748B]">To review here</div>
            </div>
            <div className="min-w-0 px-2 text-center">
              <div className="truncate font-mono text-[18px] font-extrabold text-[#11120d]">
                {storageInfo ? formatBytes(storageInfo.totalSizeBytes) : processedCount}
              </div>
              <div className="mt-1 text-[9px] font-extrabold uppercase tracking-wide text-[#64748B]">
                {storageInfo ? "Storage" : "Linked here"}
              </div>
            </div>
          </div>

          <div className="mb-4 bg-white md:mb-6 md:rounded-[18px] md:border md:border-[#CFCFD3] md:p-4 md:shadow-sm">
            <div className="space-y-3 lg:hidden">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <div className="flex h-[48px] min-w-0 items-center gap-2 rounded-[13px] border border-[#CFCFD3] bg-white px-3 focus-within:border-[#11120d]">
                  <Icon name="search" sizePx={18} className="shrink-0 text-[#8C8889]" />
                  <input
                    value={documentQuery}
                    onChange={(event) => setDocumentQuery(event.target.value)}
                    placeholder="Title, filename, supplier or bill…"
                    className="min-w-0 flex-1 bg-transparent text-[13px] font-semibold text-[#11120d] outline-none"
                  />
                </div>
                <MobileFilterButton activeCount={mobileFilterCount} onClick={openMobileFilters} />
              </div>
              {canManageDocuments ? (
                <button
                  type="button"
                  onClick={() => openUploadWorkspace()}
                  className="inline-flex h-[48px] w-full items-center justify-center gap-2 rounded-[13px] bg-[#11120d] px-4 text-[13px] font-extrabold text-white active:bg-[#2a2c27]"
                >
                  <Icon name="upload_file" sizePx={19} />
                  Upload Document
                </button>
              ) : null}
              <ActiveFilterChips items={mobileFilterChips} />
            </div>

            <div className="hidden space-y-4 lg:block">
              <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-end gap-3">
                <label className="space-y-1.5"><span className="text-[10px] font-extrabold uppercase tracking-wide text-[#64748B]">Search documents</span><div className="flex h-11 min-w-0 items-center gap-2 rounded-xl border border-[#CFCFD3] px-3 focus-within:border-[#11120d]"><Icon name="search" sizePx={18} className="text-[#8C8889]" /><input value={documentQuery} onChange={(event) => setDocumentQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { setPage(1); void loadDocuments(); } }} placeholder="Title, filename or supplier" className="min-w-0 flex-1 bg-transparent text-[13px] font-semibold outline-none" /><input value={billSearch} onChange={(event) => setBillSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { setPage(1); void loadDocuments(); } }} placeholder="Bill number" className="w-[170px] border-l border-[#E5E7EB] bg-transparent pl-3 text-[13px] font-semibold outline-none" /></div></label>
                <button type="button" onClick={() => { setPage(1); void loadDocuments(); }} className="h-11 rounded-xl bg-[#11120d] px-5 text-[12px] font-extrabold text-white">Search</button>
                <button type="button" onClick={clearFilters} disabled={!activeFilters} className="h-11 rounded-xl border border-[#CFCFD3] bg-white px-5 text-[12px] font-extrabold text-[#565449] disabled:cursor-not-allowed disabled:opacity-40">Clear</button>
              </div>
              <div className={cn("grid gap-3", isAdmin ? "grid-cols-3 2xl:grid-cols-5" : "grid-cols-2 2xl:grid-cols-4")}>
                <label className="space-y-1.5"><span className="text-[10px] font-extrabold uppercase tracking-wide text-[#64748B]">Document type</span><ProjectSelect value={typeFilter} onChange={(event) => { setTypeFilter(event.target.value as DocumentType | "ALL"); setPage(1); }}><option value="ALL">All types</option>{DOCUMENT_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</ProjectSelect></label>
                <label className="space-y-1.5"><span className="text-[10px] font-extrabold uppercase tracking-wide text-[#64748B]">Processing</span><ProjectSelect value={processingStatusFilter} onChange={(event) => { setProcessingStatusFilter(event.target.value as ProcessingStatusFilter); setPage(1); }}><option value="ALL">All statuses</option><option value="UNPROCESSED">Unprocessed</option><option value="PROCESSED">Linked</option></ProjectSelect></label>
                {isAdmin ? <label className="space-y-1.5"><span className="text-[10px] font-extrabold uppercase tracking-wide text-[#64748B]">Visibility</span><ProjectSelect value={visibilityFilter} onChange={(event) => { setVisibilityFilter(event.target.value as VisibilityFilter); setPage(1); }}><option value="ALL">All visibility</option>{VISIBILITY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</ProjectSelect></label> : null}
                <label className="space-y-1.5"><span className="text-[10px] font-extrabold uppercase tracking-wide text-[#64748B]">From date</span><ProjectDateInput value={dateFrom} max={dateTo || undefined} onChange={(event) => { setDateFrom(event.target.value); setPage(1); }} /></label>
                <label className="space-y-1.5"><span className="text-[10px] font-extrabold uppercase tracking-wide text-[#64748B]">To date</span><ProjectDateInput value={dateTo} min={dateFrom || undefined} onChange={(event) => { setDateTo(event.target.value); setPage(1); }} /></label>
              </div>
            </div>
          </div>

          <MobileFilterSheet
            open={mobileFiltersOpen}
            onClose={() => setMobileFiltersOpen(false)}
            onClear={() => { setDraftBillSearch(""); setDraftTypeFilter("ALL"); setDraftProcessingStatusFilter("ALL"); setDraftVisibilityFilter("ALL"); setDraftDateFrom(""); setDraftDateTo(""); }}
            onApply={applyMobileFilters}
          >
            <div className="space-y-5">
              <label className="block space-y-2"><span className="text-[13px] font-bold">Bill number</span><input value={draftBillSearch} onChange={(event) => setDraftBillSearch(event.target.value)} placeholder="Enter bill number" className="h-11 w-full rounded-xl border border-slate-200 px-3 text-[13px] font-semibold outline-none focus:border-slate-900" /></label>
              <label className="block space-y-2"><span className="text-[13px] font-bold">Document type</span><ProjectSelect value={draftTypeFilter} onChange={(event) => setDraftTypeFilter(event.target.value as DocumentType | "ALL")}><option value="ALL">All types</option>{DOCUMENT_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</ProjectSelect></label>
              <label className="block space-y-2"><span className="text-[13px] font-bold">Processing status</span><ProjectSelect value={draftProcessingStatusFilter} onChange={(event) => setDraftProcessingStatusFilter(event.target.value as ProcessingStatusFilter)}><option value="ALL">All status</option><option value="UNPROCESSED">Unprocessed</option><option value="PROCESSED">Linked</option></ProjectSelect></label>
              {isAdmin ? <label className="block space-y-2"><span className="text-[13px] font-bold">Visibility</span><ProjectSelect value={draftVisibilityFilter} onChange={(event) => setDraftVisibilityFilter(event.target.value as VisibilityFilter)}><option value="ALL">All visibility</option>{VISIBILITY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</ProjectSelect></label> : null}
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-2"><span className="text-[13px] font-bold">From date</span><ProjectDateInput value={draftDateFrom} max={draftDateTo || undefined} onChange={(event) => setDraftDateFrom(event.target.value)} /></label>
                <label className="space-y-2"><span className="text-[13px] font-bold">To date</span><ProjectDateInput value={draftDateTo} min={draftDateFrom || undefined} onChange={(event) => setDraftDateTo(event.target.value)} /></label>
              </div>
            </div>
          </MobileFilterSheet>

          <section ref={documentListRef} className="flex min-h-[420px] scroll-mt-4 flex-col overflow-hidden bg-white lg:rounded-[18px] lg:border lg:border-[#CFCFD3] lg:shadow-sm">
            {isLoading ? (
              <div className="flex min-h-[360px] items-center justify-center text-[13px] font-semibold text-[#8C8889]">
                Loading documents...
              </div>
            ) : documents.length === 0 ? (
              <div className="p-4">{renderEmptyState()}</div>
            ) : (
              <>
                {renderDocumentTable()}
                <div className="lg:hidden">{renderDocumentCards()}</div>
                <div className="mt-4 border-y border-[#E5E7EB] bg-white lg:mt-0 lg:border-x-0 lg:border-b-0 lg:p-3">
                  <PaginationBar
                    page={page}
                    totalPages={totalPages}
                    total={total}
                    start={(page - 1) * pageSize}
                    end={Math.min(total, page * pageSize)}
                    label="documents"
                    pageSize={pageSize}
                    pageSizeOptions={[10, 20, 50]}
                    showSinglePageControls
                    onPageChange={changeDocumentPage}
                    onPageSizeChange={(nextPageSize) => {
                      setPageSize(nextPageSize);
                      setPage(1);
                      window.requestAnimationFrame(() => {
                        documentListRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                      });
                    }}
                  />
                </div>
              </>
            )}
          </section>
        </main>

      </div>

      <ModalFrame
        open={!!mobileActionDoc}
        title="Document actions"
        description={mobileActionDoc ? documentDisplayTitle(mobileActionDoc) : undefined}
        onClose={() => setMobileActionDoc(null)}
        maxWidthClass="max-w-[520px]"
        mobileBottomSheet
      >
        {mobileActionDoc ? (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => {
                setSelectedDoc(mobileActionDoc);
                setMobileFullPreview(false);
                setMobileActionDoc(null);
              }}
              className="flex h-[52px] w-full items-center gap-3 rounded-[13px] border border-[#E5E7EB] bg-white px-4 text-left text-[13px] font-extrabold text-[#11120d]"
            >
              <Icon name="visibility" sizePx={20} />
              View details
            </button>
            <button
              type="button"
              onClick={() => openFullView(mobileActionDoc)}
              className="flex h-[52px] w-full items-center gap-3 rounded-[13px] border border-[#E5E7EB] bg-white px-4 text-left text-[13px] font-extrabold text-[#11120d]"
            >
              <Icon name="open_in_full" sizePx={20} />
              Open file
            </button>
            <button
              type="button"
              onClick={() => {
                const doc = mobileActionDoc;
                setMobileActionDoc(null);
                void handleDownload(doc);
              }}
              className="flex h-[52px] w-full items-center gap-3 rounded-[13px] border border-[#E5E7EB] bg-white px-4 text-left text-[13px] font-extrabold text-[#11120d]"
            >
              <Icon name="download" sizePx={20} />
              Download
            </button>
            {canManageDocuments ? (
              <button
                type="button"
                onClick={() => {
                  const doc = mobileActionDoc;
                  setMobileActionDoc(null);
                  openEditDetails(doc);
                }}
                className="flex h-[52px] w-full items-center gap-3 rounded-[13px] border border-[#E5E7EB] bg-white px-4 text-left text-[13px] font-extrabold text-[#11120d]"
              >
                <Icon name="edit" sizePx={20} />
                Edit details
              </button>
            ) : null}
            {isAdmin ? (
              <button
                type="button"
                onClick={() => {
                  const doc = mobileActionDoc;
                  setMobileActionDoc(null);
                  openVisibilityDialog(doc);
                }}
                className="flex h-[52px] w-full items-center gap-3 rounded-[13px] border border-[#E5E7EB] bg-white px-4 text-left text-[13px] font-extrabold text-[#11120d]"
              >
                <Icon name="admin_panel_settings" sizePx={20} />
                Change visibility
              </button>
            ) : null}
            {canManageDocuments ? (
              <button
                type="button"
                onClick={() => {
                  setDeletingId(mobileActionDoc.id);
                  setMobileActionDoc(null);
                }}
                className="flex h-[52px] w-full items-center gap-3 rounded-[13px] border border-rose-200 bg-rose-50 px-4 text-left text-[13px] font-extrabold text-rose-700"
              >
                <Icon name="delete" sizePx={20} />
                Move to Bin
              </button>
            ) : null}
          </div>
        ) : null}
      </ModalFrame>

      <ModalFrame
        open={!!selectedDoc}
        title={selectedDoc ? documentDisplayTitle(selectedDoc) : "Document detail"}
        description={
          selectedDoc
            ? `${typeLabel(selectedDoc.documentType)} | ${formatBytes(selectedDoc.fileSize)}`
            : undefined
        }
        onClose={() => {
          setSelectedDoc(null);
          setDetailExpanded(false);
          setMobileFullPreview(false);
        }}
        headerActions={
          selectedDoc ? (
            <div className="hidden items-center gap-2 lg:flex">
              <button
                type="button"
                onClick={() => openEditDetails(selectedDoc)}
                className="inline-flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] text-[#8C8889] transition hover:bg-[#F3F4F6] hover:text-[#000000]"
                title="Edit details"
              >
                <Icon name="edit" sizePx={18} />
              </button>
              <button
                type="button"
                onClick={() => openFullView(selectedDoc)}
                className="inline-flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] text-[#8C8889] transition hover:bg-[#F3F4F6] hover:text-[#000000]"
                title="Open in new tab"
              >
                <Icon name="open_in_new" sizePx={18} />
              </button>
              <button
                type="button"
                onClick={() => setDetailExpanded((current) => !current)}
                className="inline-flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] text-[#8C8889] transition hover:bg-[#F3F4F6] hover:text-[#000000]"
                title={detailExpanded ? "Restore down" : "Maximize"}
              >
                <Icon name={detailExpanded ? "filter_none" : "crop_square"} sizePx={18} />
              </button>
            </div>
          ) : null
        }
        maxWidthClass={detailExpanded ? "max-w-[calc(100vw-32px)]" : "max-w-[1200px]"}
        mobileFullScreen
      >
        {renderDetailView()}
      </ModalFrame>

      <ModalFrame
        open={!!editingDoc}
        title="Edit document details"
        description="Update missing supplier, bill, or processing details without changing the stored file."
        onClose={() => {
          if (!editBusy) setEditingDoc(null);
        }}
        maxWidthClass="max-w-[760px]"
      >
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block md:col-span-2">
            <span className="text-[11px] font-extrabold uppercase text-[#565449]">
              Document title <span className="text-rose-600">*</span>
            </span>
            <input
              ref={editTitleRef}
              value={editTitle}
              maxLength={160}
              aria-invalid={Boolean(editTitleError)}
              aria-describedby={editTitleError ? "edit-document-title-error" : "edit-document-title-help"}
              onChange={(event) => {
                setEditTitle(event.target.value);
                setEditTitleError("");
              }}
              placeholder="e.g. Household supplier price list - July 2026"
              className={cn("mt-1 h-[44px] w-full rounded-[12px] bg-white px-3 text-[13px] font-semibold text-[#11120d] outline-none transition focus:ring-2", editTitleError ? "border-2 border-[#DC2626] bg-[#FFF1F2] focus:ring-red-100" : "border border-[#CFCFD3] focus:border-[#11120d] focus:ring-slate-100")}
            />
            {editTitleError ? (
              <span id="edit-document-title-error" role="alert" className="mt-1 block text-[12px] font-semibold text-[#BE123C]">{editTitleError}</span>
            ) : (
              <span id="edit-document-title-help" className="mt-1 block text-[11px] font-semibold text-[#64748B]">
                Searchable name shown to users. The original file remains {editingDoc?.fileName}.
              </span>
            )}
          </label>

          <label className="block">
            <span className="text-[11px] font-extrabold uppercase text-[#8C8889]">Document type</span>
            <ProjectSelect
              value={editType}
              onChange={(event) => setEditType(event.target.value as DocumentType)}
              className="mt-1 h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-bold text-[#11120d] outline-none transition focus:border-[#11120d]"
            >
              {DOCUMENT_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </ProjectSelect>
          </label>

          <label className="block">
            <span className="text-[11px] font-extrabold uppercase text-[#8C8889]">Supplier</span>
            <input
              value={editSupplier}
              onChange={(event) => setEditSupplier(event.target.value)}
              placeholder="Supplier name"
              className="mt-1 h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-semibold text-[#11120d] outline-none transition focus:border-[#11120d]"
            />
          </label>

          <label className="block">
            <span className="text-[11px] font-extrabold uppercase text-[#8C8889]">Bill number</span>
            <input
              value={editBillNumber}
              onChange={(event) => setEditBillNumber(event.target.value)}
              placeholder="Optional"
              className="mt-1 h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-semibold text-[#11120d] outline-none transition focus:border-[#11120d]"
            />
          </label>

          <label className="block">
            <span className="text-[11px] font-extrabold uppercase text-[#8C8889]">Bill date</span>
            <ProjectDateInput
              value={editBillDate}
              onChange={(event) => setEditBillDate(event.target.value)}
              className="mt-1 h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-semibold text-[#11120d] outline-none transition focus:border-[#11120d]"
            />
          </label>

          <label className="block">
            <span className="text-[11px] font-extrabold uppercase text-[#8C8889]">Bill amount</span>
            <input
              ref={editBillAmountRef}
              type="number"
              min={0}
              step="0.01"
              value={editBillAmount}
              aria-invalid={Boolean(editBillAmountError)}
              aria-describedby={editBillAmountError ? "edit-bill-amount-error" : undefined}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                setEditBillAmount(event.target.value);
                setEditBillAmountError("");
              }}
              placeholder="0.00"
              className={cn("mt-1 h-[44px] w-full rounded-[12px] bg-white px-3 text-right text-[13px] font-semibold text-[#11120d] outline-none transition focus:ring-2", editBillAmountError ? "border-2 border-[#DC2626] bg-[#FFF1F2] focus:ring-red-100" : "border border-[#CFCFD3] focus:border-[#11120d] focus:ring-slate-100")}
            />
            {editBillAmountError ? <span id="edit-bill-amount-error" role="alert" className="mt-1 block text-[12px] font-semibold text-[#BE123C]">{editBillAmountError}</span> : null}
          </label>

          <label className="block md:col-span-2">
            <span className="text-[11px] font-extrabold uppercase text-[#8C8889]">Remarks</span>
            <textarea
              value={editRemarks}
              onChange={(event) => setEditRemarks(event.target.value)}
              rows={4}
              placeholder="Processing note, supplier reminder, or document context"
              className="mt-1 w-full resize-none rounded-[12px] border border-[#CFCFD3] bg-white px-4 py-3 text-[13px] font-semibold text-[#11120d] outline-none transition focus:border-[#11120d]"
            />
          </label>
        </div>

        <div className="mt-6 flex justify-end gap-3 border-t border-[#E5E7EB] pt-4">
          <DialogButton onClick={() => setEditingDoc(null)} disabled={editBusy}>
            Cancel
          </DialogButton>
          <DialogButton onClick={() => void submitEditDetails()} variant="primary" icon="save" disabled={editBusy}>
            {editBusy ? "Saving..." : "Save details"}
          </DialogButton>
        </div>
      </ModalFrame>

      <ModalFrame
        open={!!visibilityDoc}
        title="Confirm document visibility"
        description="Choose which roles can open or download this document."
        onClose={() => {
          if (!visibilitySavingId) setVisibilityDoc(null);
        }}
        maxWidthClass="max-w-[620px]"
        compact
      >
        <div className="space-y-4">
          <div className="rounded-[14px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] font-semibold leading-6 text-amber-800">
            Users without selected access will not see this file in Documents and cannot open its preview or download URL.
          </div>

          {[
            { key: "admin" as const, label: "Admin", description: "Always allowed for document governance.", locked: true },
            { key: "manager" as const, label: "Manager", description: "Can use supplier bills and operational documents.", locked: false },
            { key: "cashier" as const, label: "Cashier", description: "Can view shared proofs and general documents.", locked: false },
          ].map((role) => {
            const active = visibilityRoles[role.key];
            return (
              <button
                key={role.key}
                type="button"
                disabled={role.locked}
                onClick={() => {
                  setVisibilityRoles((current) => {
                    if (role.key === "manager") {
                      const nextManager = !current.manager;
                      return {
                        ...current,
                        manager: nextManager,
                        cashier: nextManager ? current.cashier : false,
                      };
                    }
                    if (role.key === "cashier") {
                      return {
                        ...current,
                        cashier: !current.cashier,
                        manager: true,
                      };
                    }
                    return current;
                  });
                }}
                className="flex w-full items-center justify-between gap-4 rounded-[14px] border border-[#E5E7EB] bg-white px-4 py-3 text-left disabled:cursor-not-allowed"
              >
                <span>
                  <span className="block text-[14px] font-extrabold text-[#11120d]">{role.label}</span>
                  <span className="mt-0.5 block text-[12px] font-semibold text-[#8C8889]">{role.description}</span>
                </span>
                <span
                  className={cn(
                    "relative h-[28px] w-[52px] rounded-full border transition",
                    active ? "border-blue-500 bg-blue-600" : "border-[#CFCFD3] bg-[#E5E7EB]",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-[3px] h-[20px] w-[20px] rounded-full bg-white shadow-sm transition",
                      active ? "left-[26px]" : "left-[4px]",
                    )}
                  />
                </span>
              </button>
            );
          })}

          <div className="rounded-[14px] border border-[#E5E7EB] bg-[#F8FAFC] px-4 py-3">
            <div className="text-[10px] font-extrabold uppercase tracking-widest text-[#8C8889]">New visibility</div>
            <div className="mt-1 text-[15px] font-extrabold text-[#11120d]">
              {visibilityLabel(visibilityFromRoles(visibilityRoles))}
            </div>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-3">
          <DialogButton onClick={() => setVisibilityDoc(null)} disabled={!!visibilitySavingId}>
            Cancel
          </DialogButton>
          <DialogButton
            onClick={() => void confirmVisibilityChange()}
            variant="primary"
            icon="admin_panel_settings"
            disabled={!!visibilitySavingId}
          >
            Confirm visibility
          </DialogButton>
        </div>
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
