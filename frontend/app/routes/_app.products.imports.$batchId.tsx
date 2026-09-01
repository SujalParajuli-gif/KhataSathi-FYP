import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import Icon from "~/components/ui/Icon";
import { useToast } from "~/components/ui/Toast";
import CreatableCombobox from "~/components/ui/CreatableCombobox";
import ProjectSelect from "~/components/ui/ProjectSelect";
import { ModalFrame } from "~/components/ui/Modal";
import {
  fetchProductImportSourceBlobApi,
  fetchProductImportSourcePageBlobApi,
  commitSavedProductImportBatchApi,
  getProductImportReviewApi,
  getProductImportSourceContextApi,
  getCategoriesApi,
  listBrandsApi,
  saveReviewedProductImportRowsApi,
  setProductImportPriceMappingApi,
  setProductImportRowResolutionApi,
  type ProductImportReviewPage,
  type ProductImportRow,
  type ReviewedPdfImportRowPayload,
} from "~/lib/api/endpoints";
import {
  applyImportBulkEdit,
  comparisonLabel,
  describeReviewPayloadChanges,
  displayImportSourceRegion,
  draftPayload,
  importRowToDraft,
  parsedImportRow,
  readableSourceHeader,
  sourcePreviewColumnWidth,
  sourceCellHasValue,
  type ImportBulkEditConfig,
  type ImportPriceField,
  type ImportReviewDraft,
} from "~/features/product-imports/reviewModel";

type MobilePanel = "list" | "editor" | "source";
type ReviewHistoryEntry = {
  id: string;
  label: string;
  before: ReviewedPdfImportRowPayload[];
  after: ReviewedPdfImportRowPayload[];
};
type HistoryDirection = "undo" | "redo";
type BulkEditPreview = {
  before: ReviewedPdfImportRowPayload[];
  after: ReviewedPdfImportRowPayload[];
  fields: string[];
  changedRows: number;
  skippedRows: number;
  priceConflicts: number;
};

const FILTERS: Array<{
  value: "ALL" | NonNullable<ProductImportRow["comparisonStatus"]>;
  label: string;
}> = [
  { value: "ALL", label: "All" },
  { value: "READY_NEW", label: "New" },
  { value: "MATCHED_WITH_CHANGES", label: "Changed" },
  { value: "EXACT_DUPLICATE", label: "Exact matches" },
  { value: "IDENTIFIER_CONFLICT", label: "Conflicts" },
  { value: "IN_FILE_DUPLICATE", label: "File duplicates" },
  { value: "FAILED", label: "Failed" },
];

function rowName(row: ProductImportRow) {
  const parsed = parsedImportRow(row);
  return String(parsed.name || parsed.productName || row.rawText || `Row ${row.rowNumber}`);
}

function rowSku(row: ProductImportRow) {
  return String(parsedImportRow(row).sku || "No SKU");
}

function rowCost(row: ProductImportRow) {
  const parsed = parsedImportRow(row);
  const value = Number(parsed.ratePerPiece);
  if (Number.isFinite(value) && value > 0) return `NPR ${value.toLocaleString()}`;
  const extracted = Array.isArray(parsed.extractedPrices)
    ? Number((parsed.extractedPrices[0] as any)?.value)
    : Number.NaN;
  return Number.isFinite(extracted) && extracted > 0
    ? `Extracted NPR ${extracted.toLocaleString()} · map price`
    : "Price coming soon";
}

function statusTone(status?: ProductImportRow["comparisonStatus"]) {
  if (status === "READY_NEW") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "MATCHED_WITH_CHANGES" || status === "NEEDS_REVIEW") {
    return "border-amber-200 bg-amber-50 text-amber-800";
  }
  if (status === "FAILED" || status === "IDENTIFIER_CONFLICT") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  if (status === "IN_FILE_DUPLICATE") return "border-violet-200 bg-violet-50 text-violet-800";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function cellsFromRow(row: Pick<ProductImportRow, "rawText" | "sourceLocator">) {
  const located = row.sourceLocator?.cells;
  if (located && typeof located === "object") return located;
  try {
    const parsed = JSON.parse(row.rawText || "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function numberInput(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid min-w-0 gap-1 text-[11px] font-extrabold text-[#4B5563] xl:text-[10px]">
      <span>{label}</span>
      {children}
    </label>
  );
}

const inputClass = "h-9 min-w-0 rounded-[9px] border border-[#D4D7DC] bg-white px-2.5 text-[11px] font-semibold text-[#11120d] outline-none transition focus:border-[#11120d] focus:ring-2 focus:ring-[#11120d]/15";

export default function ProductImportReviewPage() {
  const { batchId = "" } = useParams();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [review, setReview] = useState<ProductImportReviewPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["value"]>("ALL");
  const [activeRowId, setActiveRowId] = useState("");
  const [draft, setDraft] = useState<ImportReviewDraft | null>(null);
  const [savedFingerprint, setSavedFingerprint] = useState("");
  const [saving, setSaving] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [allMatchingSelected, setAllMatchingSelected] = useState(false);
  const [excludedSelectedIds, setExcludedSelectedIds] = useState<Set<string>>(new Set());
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("list");
  const [sourceContext, setSourceContext] = useState<Awaited<ReturnType<typeof getProductImportSourceContextApi>> | null>(null);
  const [sourcePreviewUrl, setSourcePreviewUrl] = useState("");
  const [sourceLoading, setSourceLoading] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [priceSetupOpen, setPriceSetupOpen] = useState(false);
  const [exitConfirmOpen, setExitConfirmOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sourceDetailsOpen, setSourceDetailsOpen] = useState(false);
  const [sourceDetailSearch, setSourceDetailSearch] = useState("");
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkBrand, setBulkBrand] = useState("");
  const [bulkCategory, setBulkCategory] = useState("");
  const [bulkSupplier, setBulkSupplier] = useState("");
  const [bulkPackageQuantity, setBulkPackageQuantity] = useState("");
  const [bulkPackageUnit, setBulkPackageUnit] = useState("");
  const [bulkMoveFrom, setBulkMoveFrom] = useState<ImportPriceField | "">("");
  const [bulkMoveTo, setBulkMoveTo] = useState<ImportPriceField | "">("");
  const [bulkConflictPolicy, setBulkConflictPolicy] = useState<"KEEP" | "REPLACE">("KEEP");
  const [bulkClearSource, setBulkClearSource] = useState(false);
  const [bulkPercentageEnabled, setBulkPercentageEnabled] = useState(false);
  const [bulkPercentageBase, setBulkPercentageBase] = useState<ImportPriceField | "">("");
  const [bulkPercentageTarget, setBulkPercentageTarget] = useState<ImportPriceField | "">("");
  const [bulkPercentageDirection, setBulkPercentageDirection] = useState<"INCREASE" | "DECREASE">("INCREASE");
  const [bulkPercentage, setBulkPercentage] = useState("");
  const [bulkPreview, setBulkPreview] = useState<BulkEditPreview | null>(null);
  const [brandOptions, setBrandOptions] = useState<string[]>([]);
  const [categoryOptions, setCategoryOptions] = useState<string[]>([]);
  const [priceMappingDraft, setPriceMappingDraft] = useState<Record<string, string>>({});
  const [priceMappingBusy, setPriceMappingBusy] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitBusy, setCommitBusy] = useState(false);
  const [undoStack, setUndoStack] = useState<ReviewHistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<ReviewHistoryEntry[]>([]);
  const [historyPrompt, setHistoryPrompt] = useState<{ direction: HistoryDirection; entry: ReviewHistoryEntry } | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [commitResult, setCommitResult] = useState<{
    createdCount: number;
    updatedCount?: number;
    keptCount?: number;
    ignoredCount?: number;
    errorCount: number;
  } | null>(null);
  const pendingPageEdge = useRef<"first" | "last" | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      setSearch(searchInput.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    let active = true;
    Promise.allSettled([listBrandsApi(true), getCategoriesApi()]).then(([brands, categories]) => {
      if (!active) return;
      if (brands.status === "fulfilled") {
        setBrandOptions(brands.value.map((brand: any) => String(brand?.name || "").trim()).filter(Boolean));
      }
      if (categories.status === "fulfilled") {
        setCategoryOptions((Array.isArray(categories.value) ? categories.value : []).map(String).map((value) => value.trim()).filter(Boolean));
      }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setSelectedIds(new Set());
    setExcludedSelectedIds(new Set());
    setAllMatchingSelected(false);
  }, [batchId, search, filter]);

  useEffect(() => {
    setUndoStack([]);
    setRedoStack([]);
    setHistoryPrompt(null);
  }, [batchId]);

  async function loadReview() {
    if (!batchId) return;
    try {
      setLoading(true);
      setError("");
      const result = await getProductImportReviewApi(batchId, {
        page,
        pageSize,
        search: search || undefined,
        comparisonStatus: filter === "ALL" ? undefined : filter,
      });
      setReview(result);
      setPriceMappingDraft(result.priceMapping?.mapping || {});
      const requestedEdge = pendingPageEdge.current;
      pendingPageEdge.current = null;
      setActiveRowId((current) => {
        if (requestedEdge === "last") return result.rows.at(-1)?.id || "";
        if (requestedEdge === "first") return result.rows[0]?.id || "";
        return result.rows.some((row) => row.id === current) ? current : result.rows[0]?.id || "";
      });
    } catch (requestError: any) {
      setError(requestError?.response?.data?.error || requestError?.message || "Import review could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadReview();
  }, [batchId, page, pageSize, search, filter]);

  const activeRow = review?.rows.find((row) => row.id === activeRowId) || null;

  useEffect(() => {
    if (!review || !activeRow) {
      setDraft(null);
      setSavedFingerprint("");
      return;
    }
    const next = importRowToDraft(review.batch, activeRow);
    setDraft(next);
    setSavedFingerprint(JSON.stringify(draftPayload(next)));
  }, [review?.batch.id, activeRow?.id, activeRow?.parsed, activeRow?.resolution]);

  useEffect(() => {
    if (!batchId) {
      setSourceContext(null);
      return;
    }
    // If source context is already loaded with rows for this batch, don't re-fetch on every active row switch
    if (sourceContext?.rows?.length) {
      return;
    }
    let active = true;
    getProductImportSourceContextApi(batchId, activeRowId || undefined)
      .then((result) => {
        if (active) setSourceContext(result);
      })
      .catch((err) => {
        console.error("Failed to load source context:", err);
        if (active) setSourceContext(null);
      });
    return () => { active = false; };
  }, [batchId, activeRowId, sourceContext]);

  useEffect(() => {
    if (!activeRowId) return;
    const targetElement = document.getElementById(`source-row-${activeRowId}`);
    if (targetElement) {
      targetElement.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [activeRowId, sourceContext]);

  const sourceMimeType = review?.batch.source?.mimeType || "";
  const sourcePageNumber = Number(activeRow?.sourceLocator?.pageNumber || 1);

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    async function loadSourcePreview() {
      if (!batchId || !review?.batch.source?.available) {
        setSourcePreviewUrl("");
        return;
      }
      if (!sourceMimeType.startsWith("image/") && sourceMimeType !== "application/pdf") {
        setSourcePreviewUrl("");
        return;
      }
      try {
        setSourceLoading(true);
        const hasRegion = Boolean(activeRow?.sourceLocator?.region);
        const blob = sourceMimeType === "application/pdf" && hasRegion
          ? await fetchProductImportSourcePageBlobApi(batchId, sourcePageNumber)
          : await fetchProductImportSourceBlobApi(batchId);
        objectUrl = URL.createObjectURL(blob);
        if (active) setSourcePreviewUrl(objectUrl);
      } catch {
        if (active) setSourcePreviewUrl("");
      } finally {
        if (active) setSourceLoading(false);
      }
    }
    void loadSourcePreview();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [batchId, review?.batch.source?.available, sourceMimeType, sourcePageNumber, Boolean(activeRow?.sourceLocator?.region)]);

  const dirty = Boolean(draft && JSON.stringify(draftPayload(draft)) !== savedFingerprint);
  const sourceRows = sourceContext?.rows || [];
  const sourceHeaders = useMemo(() => {
    const keys = new Set<string>();
    sourceRows.forEach((row) => Object.keys(cellsFromRow(row)).forEach((key) => keys.add(key)));
    return [...keys].filter((key) =>
      sourceRows.some((row) => sourceCellHasValue(cellsFromRow(row)[key])),
    );
  }, [sourceRows]);
  const sourceTableWidth = useMemo(
    () => 56 + sourceHeaders.reduce((total, header) => total + sourcePreviewColumnWidth(header), 0),
    [sourceHeaders],
  );
  const activeSourceRow = sourceRows.find((row) => row.id === activeRowId) || null;
  const activeSourceEntries = activeSourceRow
    ? sourceHeaders
      .map((header) => [header, cellsFromRow(activeSourceRow)[header]] as const)
      .filter(([, value]) => sourceCellHasValue(value))
    : [];
  const activeExtractedPrices = useMemo(() => {
    const parsed = parsedImportRow(activeRow);
    return Array.isArray(parsed.extractedPrices)
      ? parsed.extractedPrices as Array<{ key?: string; label?: string; value?: number }>
      : [];
  }, [activeRow]);
  const supplierOptions = useMemo(() => Array.from(new Set([
    review?.batch.supplier || "",
    ...brandOptions,
    ...(review?.rows || []).map((row) => String(parsedImportRow(row).vendorSource || "")),
  ].map((value) => value.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b)), [review?.batch.supplier, review?.rows, brandOptions]);
  const unitOptions = ["PIECE", "PACK", "BOX", "SET", "KG", "GRAM", "LITER", "ML", "METER", "STANDARD"];
  const pageRowIds = review?.rows.map((row) => row.id) || [];
  const selectedCount = allMatchingSelected
    ? Math.max(0, (review?.pagination.total || 0) - excludedSelectedIds.size)
    : selectedIds.size;
  const allPageRowsSelected = pageRowIds.length > 0 && pageRowIds.every((id) =>
    allMatchingSelected ? !excludedSelectedIds.has(id) : selectedIds.has(id),
  );
  const pageRangeStart = review && review.pagination.total > 0
    ? (review.pagination.page - 1) * review.pagination.pageSize + 1
    : 0;
  const pageRangeEnd = review
    ? Math.min(review.pagination.total, review.pagination.page * review.pagination.pageSize)
    : 0;

  function toggleRowSelection(rowId: string) {
    if (allMatchingSelected) {
      setExcludedSelectedIds((current) => {
        const next = new Set(current);
        if (next.has(rowId)) next.delete(rowId);
        else next.add(rowId);
        return next;
      });
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }

  function togglePageSelection() {
    if (allMatchingSelected) {
      setExcludedSelectedIds((current) => {
        const next = new Set(current);
        if (allPageRowsSelected) pageRowIds.forEach((id) => next.add(id));
        else pageRowIds.forEach((id) => next.delete(id));
        return next;
      });
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allPageRowsSelected) pageRowIds.forEach((id) => next.delete(id));
      else pageRowIds.forEach((id) => next.add(id));
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
    setExcludedSelectedIds(new Set());
    setAllMatchingSelected(false);
  }

  async function loadSelectedRowsForBulkEdit() {
    if (!review || selectedCount === 0) return [];
    const pageCount = Math.max(1, Math.ceil(review.pagination.total / 100));
    const pages = await Promise.all(Array.from({ length: pageCount }, (_unused, index) =>
      getProductImportReviewApi(review.batch.id, {
        page: index + 1,
        pageSize: 100,
        search: search || undefined,
        comparisonStatus: filter === "ALL" ? undefined : filter,
      }),
    ));
    const matchingRows = pages.flatMap((result) => result.rows);
    return allMatchingSelected
      ? matchingRows.filter((row) => !excludedSelectedIds.has(row.id))
      : matchingRows.filter((row) => selectedIds.has(row.id));
  }

  function chooseRow(row: ProductImportRow) {
    if (dirty && !window.confirm("Discard the unsaved changes to this row?")) return;
    setActiveRowId(row.id);
    setMobilePanel("editor");
  }

  function restoreResolution(row: ProductImportRow) {
    if (row.comparisonStatus === "READY_NEW") return "CREATE_NEW" as const;
    if (row.comparisonStatus === "EXACT_DUPLICATE") return "KEEP_EXISTING" as const;
    return null;
  }

  function moveActiveRow(direction: -1 | 1) {
    if (!review || !activeRow) return;
    if (dirty && !window.confirm("Discard the unsaved changes to this row?")) return;
    const activeIndex = review.rows.findIndex((row) => row.id === activeRow.id);
    const next = review.rows[activeIndex + direction];
    if (next) {
      setActiveRowId(next.id);
      return;
    }
    if (direction < 0 && review.pagination.page > 1) {
      pendingPageEdge.current = "last";
      setPage((value) => value - 1);
    } else if (direction > 0 && review.pagination.page < review.pagination.totalPages) {
      pendingPageEdge.current = "first";
      setPage((value) => value + 1);
    }
  }

  function updateDraft<K extends keyof ImportReviewDraft>(key: K, value: ImportReviewDraft[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  }

  async function saveReviewPayloads(payloads: ReviewedPdfImportRowPayload[]) {
    if (!review) return;
    for (let start = 0; start < payloads.length; start += 200) {
      await saveReviewedProductImportRowsApi(review.batch.id, payloads.slice(start, start + 200));
    }
  }

  function recordReviewHistory(
    label: string,
    before: ReviewedPdfImportRowPayload[],
    after: ReviewedPdfImportRowPayload[],
  ) {
    if (before.length === 0 || after.length === 0) return;
    const entry: ReviewHistoryEntry = {
      id: typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `history-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      label,
      before,
      after,
    };
    setUndoStack((current) => [...current, entry].slice(-20));
    setRedoStack([]);
  }

  function requestHistoryAction(direction: HistoryDirection) {
    if (dirty) {
      showToast("info", "Save or discard the current row changes before using undo or redo.");
      return;
    }
    const stack = direction === "undo" ? undoStack : redoStack;
    const entry = stack.at(-1);
    if (!entry) return;
    setHistoryPrompt({ direction, entry });
  }

  async function applyHistoryAction() {
    if (!historyPrompt || !review) return;
    const { direction, entry } = historyPrompt;
    try {
      setHistoryBusy(true);
      await saveReviewPayloads(direction === "undo" ? entry.before : entry.after);
      if (direction === "undo") {
        setUndoStack((current) => current.filter((candidate) => candidate.id !== entry.id));
        setRedoStack((current) => [...current, entry].slice(-20));
      } else {
        setRedoStack((current) => current.filter((candidate) => candidate.id !== entry.id));
        setUndoStack((current) => [...current, entry].slice(-20));
      }
      setHistoryPrompt(null);
      await loadReview();
      showToast("success", `${direction === "undo" ? "Undone" : "Redone"}: ${entry.label}`);
    } catch (historyError: any) {
      showToast("danger", historyError?.response?.data?.error || historyError?.message || `${direction === "undo" ? "Undo" : "Redo"} failed.`);
    } finally {
      setHistoryBusy(false);
    }
  }

  async function saveDraft() {
    if (!draft || !review || !activeRow) return;
    if (!draft.name.trim() || !draft.sku.trim() || !draft.brand.trim() || !draft.category.trim()) {
      showToast("danger", "Product name, SKU, brand and category are required.");
      return;
    }
    const before = draftPayload(importRowToDraft(review.batch, activeRow));
    const after = draftPayload(draft);
    const changedFields = describeReviewPayloadChanges(before, after);
    try {
      setSaving(true);
      if (draft.resolution === "IGNORE") {
        const result = await setProductImportRowResolutionApi(review.batch.id, draft.rowId, "IGNORE");
        setReview((current) => current ? {
          ...current,
          rows: current.rows.map((row) => row.id === result.row.id ? result.row : row),
        } : current);
        setSavedFingerprint(JSON.stringify(draftPayload(draft)));
        recordReviewHistory(
          `${draft.resolution === "IGNORE" ? "Ignored" : "Updated"} “${draft.name}”${changedFields.length ? ` — ${changedFields.join(", ")}` : ""}`,
          [before],
          [after],
        );
        showToast("success", `Row ${draft.rowNumber} ignored.`);
        await loadReview();
        return;
      }
      const result = await saveReviewedProductImportRowsApi(review.batch.id, [draftPayload(draft)]);
      const saved = result.rows[0];
      if (saved) {
        setReview((current) => current ? {
          ...current,
          rows: current.rows.map((row) => row.id === saved.id ? saved : row),
        } : current);
      }
      setSavedFingerprint(JSON.stringify(draftPayload(draft)));
      recordReviewHistory(
        `Updated “${draft.name}”${changedFields.length ? ` — ${changedFields.join(", ")}` : ""}`,
        [before],
        [after],
      );
      showToast("success", `Row ${draft.rowNumber} saved.`);
    } catch (saveError: any) {
      showToast("danger", saveError?.response?.data?.error || saveError?.message || "Row could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function downloadSource() {
    if (!review?.batch.source?.available) return;
    try {
      const blob = await fetchProductImportSourceBlobApi(review.batch.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = review.batch.source.fileName || review.batch.fileName || "import-source";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (downloadError: any) {
      showToast("danger", downloadError?.message || "Original source could not be downloaded.");
    }
  }

  function closeBulkEdit() {
    if (bulkSaving) return;
    setBulkOpen(false);
    setBulkPreview(null);
  }

  function configuredBulkEdit(): ImportBulkEditConfig | null {
    if ((bulkMoveFrom || bulkMoveTo) && (!bulkMoveFrom || !bulkMoveTo)) {
      showToast("danger", "Choose both the source and destination price fields.");
      return null;
    }
    if (bulkMoveFrom && bulkMoveTo && bulkMoveFrom === bulkMoveTo) {
      showToast("danger", "The source and destination price fields must be different.");
      return null;
    }

    let percentageConfig: ImportBulkEditConfig["percentage"] = null;
    if (bulkPercentageEnabled) {
      const percent = numberInput(bulkPercentage);
      if (!bulkPercentageBase || !bulkPercentageTarget) {
        showToast("danger", "Choose both a base price and target price.");
        return null;
      }
      if (bulkPercentageBase === bulkPercentageTarget) {
        showToast("danger", "The percentage base and target fields must be different.");
        return null;
      }
      if (percent === null || percent <= 0 || percent > 100) {
        showToast("danger", "Enter a percentage greater than 0 and no more than 100.");
        return null;
      }
      if (bulkPercentageDirection === "DECREASE" && percent >= 100) {
        showToast("danger", "A markdown must be less than 100%.");
        return null;
      }
      percentageConfig = {
        base: bulkPercentageBase,
        target: bulkPercentageTarget,
        direction: bulkPercentageDirection,
        percent,
      };
    }

    const packageQuantity = numberInput(bulkPackageQuantity);
    if (bulkPackageQuantity && (packageQuantity === null || packageQuantity <= 0)) {
      showToast("danger", "Package quantity must be greater than zero.");
      return null;
    }

    const config: ImportBulkEditConfig = {
      brand: bulkBrand,
      category: bulkCategory,
      vendorSource: bulkSupplier,
      packageQuantity: bulkPackageQuantity.trim() ? packageQuantity : undefined,
      packageUnit: bulkPackageUnit,
      priceMove: bulkMoveFrom && bulkMoveTo ? {
        from: bulkMoveFrom,
        to: bulkMoveTo,
        conflictPolicy: bulkConflictPolicy,
        clearSource: bulkClearSource,
      } : null,
      percentage: percentageConfig,
    };
    if (!(
      bulkBrand.trim() || bulkCategory.trim() || bulkSupplier.trim()
      || bulkPackageQuantity.trim() || bulkPackageUnit.trim()
      || config.priceMove || config.percentage
    )) {
      showToast("info", "Configure at least one bulk change. Neutral fields leave products unchanged.");
      return null;
    }
    return config;
  }

  async function prepareBulkEditReview() {
    if (!review) return;
    const config = configuredBulkEdit();
    if (!config) return;
    try {
      setBulkSaving(true);
      const selectedRows = await loadSelectedRowsForBulkEdit();
      if (selectedRows.length === 0) {
        showToast("info", "No review rows are selected.");
        return;
      }
      const before = selectedRows.map((row) => draftPayload(importRowToDraft(review.batch, row)));
      const results = before.map((payload) => applyImportBulkEdit(payload, config));
      const changedRows = results.filter((result) => result.changedFields.length > 0).length;
      if (changedRows === 0) {
        showToast("info", "The configured operation would not change any selected product.");
        return;
      }
      setBulkPreview({
        before,
        after: results.map((result) => result.payload),
        fields: Array.from(new Set(results.flatMap((result) => result.changedFields))),
        changedRows,
        skippedRows: results.filter((result) => result.skippedOperations > 0).length,
        priceConflicts: results.filter((result) => result.priceConflict).length,
      });
    } catch (bulkError: any) {
      showToast("danger", bulkError?.response?.data?.error || bulkError?.message || "Bulk changes could not be prepared.");
    } finally {
      setBulkSaving(false);
    }
  }

  async function applyReviewedBulkEdit() {
    if (!bulkPreview) return;
    try {
      setBulkSaving(true);
      await saveReviewPayloads(bulkPreview.after);
      recordReviewHistory(
        `Bulk edit for ${bulkPreview.changedRows.toLocaleString()} products — ${bulkPreview.fields.join(", ")}`,
        bulkPreview.before,
        bulkPreview.after,
      );
      await loadReview();
      const changedRows = bulkPreview.changedRows;
      setBulkOpen(false);
      setBulkPreview(null);
      clearSelection();
      showToast("success", `Bulk changes saved for ${changedRows.toLocaleString()} products.`);
    } catch (bulkError: any) {
      showToast("danger", bulkError?.response?.data?.error || bulkError?.message || "Bulk changes could not be saved.");
    } finally {
      setBulkSaving(false);
    }
  }

  async function savePriceMapping() {
    if (!review?.priceMapping?.required) return;
    const columns = review.priceMapping.columns;
    const mapping = Object.fromEntries(columns.map((column) => [column.key, priceMappingDraft[column.key] || ""]));
    if (Object.values(mapping).some((value) => !value)) {
      showToast("danger", "Choose what every extracted price means before continuing.");
      return;
    }
    if (new Set(Object.values(mapping)).size !== Object.values(mapping).length) {
      showToast("danger", "Two extracted columns cannot be assigned to the same price field.");
      return;
    }
    try {
      setPriceMappingBusy(true);
      await setProductImportPriceMappingApi(review.batch.id, mapping as Record<string, "ratePerPiece" | "retailPrice" | "wholesalePrice">);
      await loadReview();
      setPriceSetupOpen(false);
      showToast("success", "Extracted prices were mapped across the complete import batch.");
    } catch (mappingError: any) {
      showToast("danger", mappingError?.response?.data?.error || mappingError?.message || "Price mapping could not be saved.");
    } finally {
      setPriceMappingBusy(false);
    }
  }

  async function commitBatch() {
    if (!review) return;
    if (dirty) {
      showToast("danger", "Save or discard the current row changes before final commit.");
      return;
    }
    if (review.decisionCounts.unresolved > 0) {
      showToast("danger", `${review.decisionCounts.unresolved} rows still need a decision.`);
      return;
    }
    try {
      setCommitBusy(true);
      const token = typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `commit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const result = await commitSavedProductImportBatchApi(review.batch.id, token);
      setCommitResult(result);
      setCommitOpen(false);
      setUndoStack([]);
      setRedoStack([]);
      await loadReview();
      showToast(
        result.errorCount > 0 ? "info" : "success",
        `Import committed: ${result.createdCount} created, ${result.updatedCount || 0} updated, ${result.errorCount} failed.`,
      );
    } catch (commitError: any) {
      showToast("danger", commitError?.response?.data?.error || commitError?.message || "Import could not be committed.");
    } finally {
      setCommitBusy(false);
    }
  }

  const region = displayImportSourceRegion(activeRow?.sourceLocator);
  const regionScale = Number(region?.scale || 1000);

  function renderSourcePanel() {
    const isSpreadsheet = ["CSV", "XLSX"].includes(review?.batch.sourceType || "");
    return (
      <section className={`${mobilePanel === "source" ? "flex" : "hidden"} h-full min-h-0 flex-col overflow-hidden rounded-[16px] border border-[#D8DBE0] bg-white xl:flex xl:rounded-[18px]`}>
        <div className="flex min-h-[52px] shrink-0 items-center justify-between gap-3 border-b border-[#E2E4E8] bg-white px-3.5 py-2 sm:px-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-[13px] font-extrabold text-[#11120d]">Source document</h2>
              {isSpreadsheet && activeRow ? (
                <span className="rounded-full border border-[#D8DBE0] bg-[#F1F3F5] px-2 py-0.5 text-[9.5px] font-extrabold text-[#11120d]">
                  Row {activeRow.sourceLocator?.rowNumber || activeRow.rowNumber}
                </span>
              ) : null}
            </div>
            <p className="truncate text-[10.5px] font-medium text-[#64748B]">
              {activeRow?.sourceLocator?.sheetName || (sourceMimeType === "application/pdf" ? `Page ${sourcePageNumber}` : isSpreadsheet ? "Spreadsheet context" : review?.batch.fileName)}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {activeSourceEntries.length > 0 ? (
              <button
                type="button"
                onClick={() => setSourceDetailsOpen(true)}
                className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-[#CFCFD3] bg-white px-2.5 text-[11px] font-bold text-[#11120d] shadow-xs transition hover:bg-[#F3F4F6]"
                title="View all extracted raw values for this row"
              >
                <Icon name="visibility" sizePx={15} />
                <span>Row details ({activeSourceEntries.length})</span>
              </button>
            ) : null}
            {isSpreadsheet && sourceRows.length > 0 ? (
              <span className="hidden rounded-full border border-[#D8DBE0] bg-[#F7F8FA] px-2 py-0.5 text-[9px] font-extrabold text-[#5F6570] sm:inline-block">
                {sourceRows.length} rows
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#F7F8FA] p-2 sm:p-2.5">
          {isSpreadsheet ? (
            sourceHeaders.length > 0 ? (
              <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-[#D8DBE0] bg-white shadow-sm">
                <div className="min-h-0 flex-1 overflow-auto overscroll-contain [scrollbar-gutter:stable]">
                  <table
                    aria-label="Original spreadsheet rows"
                    className="table-fixed border-separate border-spacing-0 text-left text-[11px]"
                    style={{ width: `${sourceTableWidth}px`, minWidth: "100%" }}
                  >
                    <colgroup>
                      <col style={{ width: "56px" }} />
                      {sourceHeaders.map((header) => (
                        <col key={header} style={{ width: `${sourcePreviewColumnWidth(header)}px` }} />
                      ))}
                    </colgroup>
                    <thead className="sticky top-0 z-10 bg-[#EFF2F5] text-[#4B5563]">
                      <tr>
                        <th scope="col" className="sticky left-0 z-20 overflow-hidden border-b border-r border-[#D8DBE0] bg-[#EFF2F5] px-2.5 py-2 font-extrabold shadow-[2px_0_0_0_#D8DBE0]">Row</th>
                        {sourceHeaders.map((header) => (
                          <th key={header} scope="col" className="overflow-hidden border-b border-r border-[#D8DBE0] px-2.5 py-2 font-extrabold">
                            <div className="truncate" title={readableSourceHeader(header)}>
                              {readableSourceHeader(header)}
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sourceRows.map((row) => {
                        const cells = cellsFromRow(row);
                        const selected = row.id === activeRowId;
                        return (
                          <tr
                            key={row.id}
                            id={`source-row-${row.id}`}
                            onClick={() => {
                              const match = review?.rows.find((r) => r.id === row.id);
                              if (match) chooseRow(match);
                            }}
                            aria-selected={selected}
                            className={`cursor-pointer transition hover:bg-amber-50/60 ${selected ? "bg-amber-100 outline outline-2 -outline-offset-2 outline-amber-500" : "bg-white"}`}
                          >
                            <td className={`sticky left-0 z-[5] overflow-hidden whitespace-nowrap border-b border-r border-[#E2E4E8] px-2.5 py-2 font-extrabold shadow-[2px_0_0_0_#E2E4E8] ${selected ? "bg-amber-100 text-amber-950" : "bg-white text-[#374151]"}`}>
                              {row.sourceLocator?.rowNumber || row.rowNumber}
                            </td>
                            {sourceHeaders.map((header) => {
                              const value = cells[header];
                              return (
                                <td key={header} className={`overflow-hidden border-b border-r border-[#E2E4E8] px-2.5 py-2 font-semibold ${sourceCellHasValue(value) ? (selected ? "text-amber-950 font-bold" : "text-[#374151]") : "text-[#C4C8CE]"}`}>
                                  <div className="truncate" title={sourceCellHasValue(value) ? String(value) : undefined}>
                                    {sourceCellHasValue(value) ? String(value) : "—"}
                                  </div>
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="rounded-[12px] border border-amber-200 bg-amber-50 p-4 text-[12px] font-semibold text-amber-900">
                This older review has no structured spreadsheet cells. Re-upload the source after the migration to enable exact Excel-row preview.
              </div>
            )
          ) : sourceLoading ? (
            <div className="flex h-full min-h-[320px] items-center justify-center text-[12px] font-extrabold text-[#7A7F89]">
              Rendering source page…
            </div>
          ) : sourcePreviewUrl && sourceMimeType === "application/pdf" && !region ? (
            <iframe
              title="Supplier PDF source"
              src={`${sourcePreviewUrl}#page=${sourcePageNumber}&zoom=page-width&search=${encodeURIComponent(activeRow?.sourceLocator?.searchText || (activeRow ? rowName(activeRow) : ""))}`}
              className="h-full min-h-[420px] w-full rounded-[10px] border border-[#D8DBE0] bg-white"
            />
          ) : sourcePreviewUrl ? (
            <div className="flex h-full min-h-0 items-center justify-center overflow-auto rounded-[10px] border border-[#D8DBE0] bg-white p-2 shadow-sm">
              <div className="relative mx-auto w-fit max-w-full">
                <img src={sourcePreviewUrl} alt="Supplier catalog source" className="block h-auto max-h-[75vh] max-w-full object-contain" />
                {region ? (
                  <div
                    className="pointer-events-none absolute border-2 border-amber-500 bg-amber-300/25 shadow-[0_0_0_9999px_rgba(15,23,42,0.10)]"
                    style={{
                      top: `${(region.top / regionScale) * 100}%`,
                      left: `${(region.left / regionScale) * 100}%`,
                      width: `${((region.right - region.left) / regionScale) * 100}%`,
                      height: `${((region.bottom - region.top) / regionScale) * 100}%`,
                    }}
                  />
                ) : null}
              </div>
            </div>
          ) : (
            <div className="rounded-[12px] border border-amber-200 bg-amber-50 p-4 text-[12px] font-semibold leading-5 text-amber-900">
              The protected original is unavailable for this older review. New uploads retain it automatically.
            </div>
          )}
        </div>
      </section>
    );
  }

  function renderEditor() {
    if (!draft || !activeRow) return <div className="flex h-full items-center justify-center rounded-[18px] border border-[#D8DBE0] bg-white p-6 text-[13px] font-bold text-[#7A7F89]">Select a row to review.</div>;
    const activeIndex = review?.rows.findIndex((row) => row.id === activeRowId) ?? -1;
    const filteredPosition = review && activeIndex >= 0
      ? (review.pagination.page - 1) * review.pagination.pageSize + activeIndex + 1
      : 0;
    const canMovePrevious = Boolean(review && filteredPosition > 1);
    const canMoveNext = Boolean(review && filteredPosition < review.pagination.total);
    const hasAnyPrice = [draft.ratePerPiece, draft.retailPrice, draft.wholesalePrice]
      .some((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
    return (
      <section className={`${mobilePanel === "editor" ? "flex" : "hidden"} h-full min-h-0 flex-col overflow-hidden rounded-[16px] border border-[#D8DBE0] bg-white xl:flex xl:rounded-[18px]`}>
        <div className="shrink-0 border-b border-[#E2E4E8] bg-white px-3.5 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-[14px] font-extrabold text-[#11120d]">Review item</h2>
                <span className={`rounded-full border px-2.5 py-0.5 text-[9px] font-extrabold ${statusTone(draft.comparisonStatus)}`}>
                  {comparisonLabel(draft.comparisonStatus)}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] font-semibold text-[#7A7F89]">
                {filteredPosition.toLocaleString()} of {review?.pagination.total.toLocaleString() || 0} · source row {draft.sourceLocator?.rowNumber || draft.rowNumber}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => moveActiveRow(-1)}
                disabled={!canMovePrevious}
                className="inline-flex h-8.5 items-center justify-center gap-1 rounded-[8px] border border-[#D4D7DC] bg-white px-2.5 text-[11px] font-extrabold text-[#374151] transition hover:bg-[#F3F4F6] disabled:opacity-35"
                aria-label="Previous product row"
              >
                <Icon name="chevron_left" sizePx={16} />
                <span>Prev</span>
              </button>
              <button
                type="button"
                onClick={() => moveActiveRow(1)}
                disabled={!canMoveNext}
                className="inline-flex h-8.5 items-center justify-center gap-1 rounded-[8px] border border-[#D4D7DC] bg-white px-2.5 text-[11px] font-extrabold text-[#374151] transition hover:bg-[#F3F4F6] disabled:opacity-35"
                aria-label="Next product row"
              >
                <span>Next</span>
                <Icon name="chevron_right" sizePx={16} />
              </button>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto overscroll-contain bg-[#FAFAFB] p-3">
          <div className="rounded-[12px] border border-[#D8DBE0] bg-white p-3">
            <div className="mb-2.5 flex items-center gap-2 text-[12px] font-extrabold text-[#11120d]">
              <Icon name="sell" sizePx={16} className="text-[#11120d]" />
              Basic information
            </div>
            <div className="grid gap-2.5 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Field label="Product name">
                  <input value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} className={inputClass} />
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Field label="SKU">
                  <input value={draft.sku} onChange={(event) => updateDraft("sku", event.target.value)} className={inputClass} />
                </Field>
              </div>
              <Field label="Brand">
                <CreatableCombobox value={draft.brand} onChange={(value) => updateDraft("brand", value)} options={brandOptions} placeholder="Search or enter brand" ariaLabel="Product brand" selectOnFocus compact showCreateHelp={false} />
              </Field>
              <Field label="Category">
                <CreatableCombobox value={draft.category} onChange={(value) => { updateDraft("category", value); updateDraft("categoryGroup", value); }} options={categoryOptions} placeholder="Search or enter category" ariaLabel="Product category" selectOnFocus compact showCreateHelp={false} />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Vendor source">
                  <CreatableCombobox value={draft.vendorSource || ""} onChange={(value) => updateDraft("vendorSource", value)} options={supplierOptions} placeholder="Search or enter supplier" ariaLabel="Vendor source" selectOnFocus compact showCreateHelp={false} />
                </Field>
              </div>
            </div>
          </div>

          <div className="rounded-[12px] border border-[#D8DBE0] bg-white p-3">
            <div className="mb-2.5 flex items-center gap-2 text-[12px] font-extrabold text-[#11120d]">
              <Icon name="inventory_2" sizePx={16} className="text-[#11120d]" />
              Packaging and units
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <Field label="Size">
                <input type="number" value={draft.sizeValue ?? ""} onChange={(event) => updateDraft("sizeValue", numberInput(event.target.value))} className={inputClass} placeholder="e.g. 5" />
              </Field>
              <Field label="Size unit">
                <CreatableCombobox value={draft.sizeUnit || ""} onChange={(value) => updateDraft("sizeUnit", value.toUpperCase())} options={unitOptions} placeholder="Unit (Ltr, Kg...)" ariaLabel="Size unit" selectOnFocus compact showCreateHelp={false} />
              </Field>
              <Field label="Package quantity">
                <input type="number" value={draft.packageQuantity ?? ""} onChange={(event) => updateDraft("packageQuantity", numberInput(event.target.value))} className={inputClass} placeholder="Pieces in pack" />
              </Field>
              <Field label="Sale unit">
                <CreatableCombobox value={draft.saleUnit || ""} onChange={(value) => updateDraft("saleUnit", value.toUpperCase())} options={unitOptions} placeholder="Sale unit" ariaLabel="Sale unit" selectOnFocus compact showCreateHelp={false} />
              </Field>
            </div>
          </div>

          <div className="rounded-[12px] border border-[#D8DBE0] bg-white p-3">
            <div className="mb-2.5 flex items-center gap-2 text-[12px] font-extrabold text-[#11120d]">
              <Icon name="payments" sizePx={16} className="text-[#11120d]" />
              Pricing
            </div>
            <div className="grid gap-2.5 sm:grid-cols-3">
              <Field label="Purchase rate">
                <input type="number" value={draft.ratePerPiece ?? ""} onChange={(event) => updateDraft("ratePerPiece", numberInput(event.target.value))} disabled={Boolean(review?.priceMapping?.required && !review.priceMapping.complete)} className={`${inputClass} disabled:bg-[#F3F4F6] disabled:text-[#8C8889]`} placeholder="Coming soon" />
              </Field>
              <Field label="Retail price (optional)">
                <input type="number" value={draft.retailPrice ?? ""} onChange={(event) => updateDraft("retailPrice", numberInput(event.target.value))} disabled={Boolean(review?.priceMapping?.required && !review.priceMapping.complete)} className={`${inputClass} disabled:bg-[#F3F4F6] disabled:text-[#8C8889]`} placeholder="Pending" />
              </Field>
              <Field label="Wholesale price (optional)">
                <input type="number" value={draft.wholesalePrice ?? ""} onChange={(event) => updateDraft("wholesalePrice", numberInput(event.target.value))} disabled={Boolean(review?.priceMapping?.required && !review.priceMapping.complete)} className={`${inputClass} disabled:bg-[#F3F4F6] disabled:text-[#8C8889]`} placeholder="Pending" />
              </Field>
            </div>
            {!hasAnyPrice && !(review?.priceMapping?.required && !review.priceMapping.complete) ? (
              <div className="mt-2.5 rounded-[9px] border border-sky-200 bg-sky-50 px-2.5 py-2 text-[10px] font-bold text-sky-900">
                Coming-soon product: searchable in the catalog, with billing disabled until a price is announced.
              </div>
            ) : null}
          </div>

          {draft.changeSet && draft.changeSet.length > 0 ? (
            <div className="rounded-[12px] border border-amber-200 bg-amber-50 p-3">
              <div className="text-[12px] font-extrabold text-amber-950">Changes from the existing product</div>
              <div className="mt-2 grid gap-2">
                {draft.changeSet.map((change) => (
                  <div key={change.field} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-[9px] bg-white/80 px-3 py-2 text-[10px] font-bold">
                    <span>{String(change.currentValue ?? "Not entered")}</span>
                    <Icon name="arrow_forward" sizePx={15} />
                    <span className="text-amber-900">{String(change.incomingValue ?? "Not entered")}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {draft.comparisonStatus === "MATCHED_WITH_CHANGES" ? (
            <div className="rounded-[12px] border border-[#D8DBE0] bg-white p-3">
              <div className="mb-2 text-[11px] font-extrabold text-[#11120d]">Existing-product decision</div>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => updateDraft("resolution", "KEEP_EXISTING")} className={`h-10 rounded-[9px] border text-[11px] font-extrabold transition ${draft.resolution === "KEEP_EXISTING" ? "border-slate-800 bg-slate-800 text-white" : "border-[#D4D7DC] bg-white hover:bg-slate-50"}`}>Keep existing</button>
                <button type="button" onClick={() => updateDraft("resolution", "UPDATE_MATCHED")} className={`h-10 rounded-[9px] border text-[11px] font-extrabold transition ${draft.resolution === "UPDATE_MATCHED" ? "border-[#11120d] bg-[#11120d] text-white" : "border-[#CFCFD3] bg-white text-[#11120d] hover:bg-[#F3F4F6]"}`}>Apply displayed changes</button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="grid shrink-0 grid-cols-[auto_1fr] items-center gap-2.5 border-t border-[#E2E4E8] bg-white p-3">
          <button
            type="button"
            onClick={() => updateDraft("resolution", draft.resolution === "IGNORE" ? restoreResolution(activeRow) : "IGNORE")}
            className={`inline-flex h-10 items-center justify-center gap-1.5 rounded-[9px] border px-3.5 text-[11px] font-extrabold transition ${draft.resolution === "IGNORE" ? "border-slate-300 bg-slate-100 text-slate-800 hover:bg-slate-200" : "border-rose-200 bg-white text-rose-700 hover:bg-rose-50"}`}
          >
            <Icon name={draft.resolution === "IGNORE" ? "undo" : "close"} sizePx={16} />
            {draft.resolution === "IGNORE" ? "Restore row" : "Ignore row"}
          </button>
          <button
            type="button"
            onClick={() => void saveDraft()}
            disabled={!dirty || saving}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-[9px] bg-[#11120d] px-5 text-[11px] font-extrabold text-white shadow-sm transition hover:bg-[#2a2c27] disabled:opacity-45"
          >
            <Icon name="save" sizePx={17} />
            {saving ? "Saving…" : dirty ? "Save row changes" : "Saved"}
          </button>
        </div>
      </section>
    );
  }

  if (error && !review) {
    return <div className="rounded-[18px] border border-rose-200 bg-rose-50 p-6"><h1 className="text-[18px] font-extrabold text-rose-900">Import review unavailable</h1><p className="mt-2 text-[13px] font-semibold text-rose-800">{error}</p><button type="button" onClick={() => navigate("/products")} className="mt-4 h-11 rounded-[11px] bg-[#11120d] px-4 text-[12px] font-extrabold text-white">Back to products</button></div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden xl:gap-3">
      {/* Universal 1-Row Responsive Header */}
      <header className="flex shrink-0 items-center justify-between gap-2 rounded-[14px] border border-[#D8DBE0] bg-white p-2 shadow-xs sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <button
            type="button"
            onClick={() => setExitConfirmOpen(true)}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-white text-[#11120d] transition hover:bg-[#F3F4F6] sm:h-10 sm:w-10 sm:rounded-[11px]"
            aria-label="Back to products"
          >
            <Icon name="arrow_back" sizePx={18} />
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-[14px] font-extrabold leading-tight text-[#11120d] sm:text-[18px] xl:text-[20px]">
              {review?.batch.fileName || "Product import review"}
            </h1>
            <p className="mt-0.5 truncate text-[10.5px] font-medium text-[#64748B] sm:text-[11px]">
              {review ? `${review.batch.totalRows.toLocaleString()} extracted rows · ${review.batch.supplier || review.batch.sourceType}` : "Loading review…"}
            </p>
          </div>
        </div>

        {/* Mobile Right CTA Actions */}
        <div className="flex shrink-0 items-center gap-1.5 sm:hidden">
          <button
            type="button"
            onClick={() => setCommitOpen(true)}
            disabled={!review || (review.priceMapping.required && !review.priceMapping.complete) || review.decisionCounts.create + review.decisionCounts.update + review.decisionCounts.keep + review.decisionCounts.ignore === 0}
            title={review?.priceMapping.required && !review.priceMapping.complete ? "Map the extracted price columns first" : "Review final import"}
            className="inline-flex h-11 items-center gap-1 rounded-[9px] bg-[#11120d] px-3 text-[11px] font-bold text-white shadow-xs transition hover:bg-[#2a2c27] disabled:opacity-40"
          >
            <Icon name="publish" sizePx={15} />
            <span>Import</span>
          </button>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            className="inline-flex h-11 w-11 items-center justify-center rounded-[9px] border border-[#CFCFD3] bg-white text-[#11120d] transition hover:bg-[#F3F4F6]"
            aria-label="More import actions"
          >
            <Icon name="more_vert" sizePx={19} />
          </button>
        </div>

        {/* Desktop Action Toolbar */}
        <div className="hidden sm:flex sm:items-center sm:gap-2">
          <button
            type="button"
            onClick={() => void downloadSource()}
            disabled={!review?.batch.source?.available}
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[10px] border border-[#CFCFD3] bg-white px-3 text-[11px] font-bold text-[#11120d] transition hover:bg-[#F3F4F6] disabled:opacity-40 xl:px-3.5"
            title="Download original source"
          >
            <Icon name="download" sizePx={16} />
            <span className="hidden md:inline">Source</span>
          </button>

          {review?.priceMapping.required ? (
            <button
              type="button"
              onClick={() => setPriceSetupOpen(true)}
              className={`inline-flex h-10 items-center justify-center gap-1.5 rounded-[10px] border px-3 text-[11px] font-bold transition ${
                review.priceMapping.complete
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                  : "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
              }`}
              title="Classify extracted price columns for this entire batch"
            >
              <Icon name="swap_horiz" sizePx={16} />
              <span>Price setup</span>
            </button>
          ) : null}

          <div className="inline-flex rounded-[10px] border border-[#CFCFD3] bg-white p-0.5">
            <button
              type="button"
              onClick={() => requestHistoryAction("undo")}
              disabled={historyBusy || undoStack.length === 0}
              className="inline-flex h-8.5 w-8.5 items-center justify-center rounded-[8px] text-[#11120d] transition hover:bg-[#F3F4F6] disabled:opacity-30"
              title={undoStack.length ? `Undo: ${undoStack.at(-1)?.label}` : "Nothing to undo"}
              aria-label={undoStack.length ? `Undo ${undoStack.at(-1)?.label}` : "Nothing to undo"}
            >
              <Icon name="undo" sizePx={16} />
            </button>
            <button
              type="button"
              onClick={() => requestHistoryAction("redo")}
              disabled={historyBusy || redoStack.length === 0}
              className="inline-flex h-8.5 w-8.5 items-center justify-center rounded-[8px] text-[#11120d] transition hover:bg-[#F3F4F6] disabled:opacity-30"
              title={redoStack.length ? `Redo: ${redoStack.at(-1)?.label}` : "Nothing to redo"}
              aria-label={redoStack.length ? `Redo ${redoStack.at(-1)?.label}` : "Nothing to redo"}
            >
              <Icon name="redo" sizePx={16} />
            </button>
          </div>

          <button
            type="button"
            onClick={() => setCommitOpen(true)}
            disabled={!review || (review.priceMapping.required && !review.priceMapping.complete) || review.decisionCounts.create + review.decisionCounts.update + review.decisionCounts.keep + review.decisionCounts.ignore === 0}
            title={review?.priceMapping.required && !review.priceMapping.complete ? "Map the extracted price columns first" : "Review final import"}
            className="hidden h-10 items-center gap-2 rounded-[10px] bg-[#11120d] px-4 text-[12px] font-bold text-white shadow-sm transition hover:bg-[#2a2c27] disabled:opacity-40 sm:inline-flex"
          >
            <Icon name="publish" sizePx={16} />
            <span>Final import</span>
          </button>
        </div>
      </header>

      {commitResult ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[14px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-[11px] font-bold text-emerald-900">
          <span>Last commit: {commitResult.createdCount} created · {commitResult.updatedCount || 0} updated · {commitResult.keptCount || 0} kept · {commitResult.ignoredCount || 0} ignored · {commitResult.errorCount} failed</span>
          <button type="button" onClick={() => navigate("/products")} className="rounded-[9px] bg-emerald-800 px-3 py-2 text-white">View products</button>
        </div>
      ) : null}

      {/* Compact Segmented Mobile View Switcher */}
      <div className="flex shrink-0 gap-1 rounded-[10px] border border-[#D8DBE0] bg-[#F1F3F5] p-1 xl:hidden">
        {(["list", "editor", "source"] as MobilePanel[]).map((panel) => (
          <button
            key={panel}
            type="button"
            onClick={() => setMobilePanel(panel)}
            disabled={panel !== "list" && !activeRow}
            className={`h-10 flex-1 rounded-[7px] text-[11px] font-extrabold capitalize transition ${
              mobilePanel === panel
                ? "bg-white text-[#11120d] shadow-xs"
                : "text-[#64748B] hover:text-[#11120d]"
            }`}
          >
            {panel === "list" ? `List (${review?.pagination.total || 0})` : panel === "editor" ? "Item Editor" : "Source Doc"}
          </button>
        ))}
      </div>

      <main className="min-h-0 flex-1 xl:grid xl:grid-cols-[minmax(300px,0.9fr)_minmax(390px,1fr)_minmax(360px,1.05fr)] xl:gap-3">
        {/* Product List Panel */}
        <section className={`${mobilePanel === "list" ? "flex" : "hidden"} h-full min-h-0 flex-col overflow-hidden rounded-[16px] border border-[#D8DBE0] bg-white xl:flex xl:rounded-[18px]`}>
          <div className="shrink-0 space-y-2 border-b border-[#E2E4E8] p-2.5">
            <div className="relative">
              <Icon name="search" sizePx={17} className="absolute left-3 top-2.5 text-[#7A7F89]" />
              <input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search name, SKU or source row…"
                className="h-9 w-full rounded-[9px] border border-[#D4D7DC] pl-9 pr-2.5 text-[12px] font-semibold outline-none focus:border-[#11120d] xl:text-[11px]"
              />
            </div>

            {/* Clickable Interactive Stat Filter Rail */}
            <div className="flex gap-1.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {[
                { value: "ALL", label: "All", count: review?.pagination.total ?? 0, tone: "text-[#11120d]" },
                { value: "READY_NEW", label: "New", count: review?.comparisonCounts.READY_NEW ?? 0, tone: "text-emerald-700" },
                { value: "MATCHED_WITH_CHANGES", label: "Changed", count: review?.comparisonCounts.MATCHED_WITH_CHANGES ?? 0, tone: "text-amber-700" },
                { value: "EXACT_DUPLICATE", label: "Exact", count: review?.comparisonCounts.EXACT_DUPLICATE ?? 0, tone: "text-violet-700" },
                { value: "IN_FILE_DUPLICATE", label: "File dup", count: review?.comparisonCounts.IN_FILE_DUPLICATE ?? 0, tone: "text-violet-700" },
                { value: "IDENTIFIER_CONFLICT", label: "Conflicts", count: (review?.comparisonCounts.IDENTIFIER_CONFLICT ?? 0) + (review?.comparisonCounts.FAILED ?? 0), tone: "text-rose-700" },
              ].map((item) => {
                const active = filter === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => { setFilter(item.value as any); setPage(1); }}
                    className={`inline-flex h-7.5 shrink-0 items-center gap-1.5 rounded-[8px] border px-2.5 text-[11px] font-extrabold transition ${
                      active
                        ? "border-[#11120d] bg-[#11120d] text-white shadow-xs"
                        : "border-[#D4D7DC] bg-white text-[#4B5563] hover:bg-[#F3F4F6]"
                    }`}
                  >
                    <span>{item.label}</span>
                    <span className={`rounded-full px-1.5 py-0.2 text-[9.5px] font-extrabold ${
                      active ? "bg-white/20 text-white" : item.tone
                    }`}>
                      {item.count.toLocaleString()}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex min-h-6 items-center justify-between gap-2 text-[10px] font-extrabold text-[#5F6570]">
              <label className="inline-flex cursor-pointer items-center gap-1.5">
                <input type="checkbox" checked={allPageRowsSelected} onChange={togglePageSelection} className="h-4 w-4 rounded accent-[#11120d]" />
                <span>Select page</span>
              </label>
              {review && review.pagination.total > 0 ? (
                allMatchingSelected ? (
                  <button type="button" onClick={clearSelection} className="font-bold text-[#11120d] hover:underline">
                    All {selectedCount.toLocaleString()} selected · Clear
                  </button>
                ) : (
                  <button type="button" onClick={() => { setAllMatchingSelected(true); setSelectedIds(new Set()); setExcludedSelectedIds(new Set()); }} className="font-bold text-[#11120d] hover:underline">
                    Select all {review.pagination.total.toLocaleString()}
                  </button>
                )
              ) : null}
            </div>
          </div>

          <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${selectedCount > 0 ? "pb-20 xl:pb-0" : ""}`}>
            {loading ? (
              <div className="p-6 text-center text-[12px] font-extrabold text-[#7A7F89]">Loading rows…</div>
            ) : review?.rows.length ? (
              review.rows.map((row) => {
                const selected = allMatchingSelected ? !excludedSelectedIds.has(row.id) : selectedIds.has(row.id);
                const active = row.id === activeRowId;
                const ignored = row.resolution === "IGNORE";
                return (
                  <div
                    key={row.id}
                    className={`grid min-h-[58px] grid-cols-[auto_1fr_auto] items-center gap-2.5 border-b border-[#E8EAED] px-2.5 py-2 transition ${active ? "border-l-[3px] border-l-[#11120d] bg-[#F1F3F5]" : ignored ? "bg-rose-50/40" : "bg-white hover:bg-[#F8FAFC]"}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleRowSelection(row.id)}
                      className="h-4.5 w-4.5 rounded accent-[#11120d]"
                      aria-label={`Select ${rowName(row)} for bulk editing`}
                      title="Select for bulk editing"
                    />
                    <button type="button" onClick={() => chooseRow(row)} className="min-w-0 text-left">
                      <div className={`truncate text-[12px] font-extrabold xl:text-[11.5px] ${ignored ? "text-[#7A7F89] line-through" : "text-[#11120d]"}`}>
                        {rowName(row)}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] font-semibold text-[#7A7F89] xl:text-[9.5px]">
                        <span className="font-mono">{rowSku(row)}</span>
                        <span>·</span>
                        <span className="font-medium text-[#4B5563]">{rowCost(row)}</span>
                      </div>
                    </button>
                    <button type="button" onClick={() => chooseRow(row)} className="flex min-h-11 items-center gap-1.5" aria-label={`Review ${rowName(row)}`}>
                      {ignored ? (
                        <span className="inline-flex h-6.5 w-6.5 items-center justify-center rounded-full border border-rose-200 bg-rose-50 text-rose-700" title="Ignored">
                          <Icon name="close" sizePx={15} />
                        </span>
                      ) : (
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-[8.5px] font-extrabold ${statusTone(row.comparisonStatus)}`}>
                          {comparisonLabel(row.comparisonStatus)}
                        </span>
                      )}
                      <Icon name="chevron_right" sizePx={18} className="text-[#7A7F89]" />
                    </button>
                  </div>
                );
              })
            ) : (
              <div className="p-6 text-center text-[12px] font-bold text-[#7A7F89]">No rows match this filter.</div>
            )}
          </div>

          <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-[#E2E4E8] bg-white p-2.5 text-[10px] font-bold text-[#5F6570]">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 whitespace-nowrap">{review ? `${pageRangeStart.toLocaleString()}–${pageRangeEnd.toLocaleString()} of ${review.pagination.total.toLocaleString()}` : "0 rows"}</span>
              <ProjectSelect className="h-10 w-[104px] shrink-0" value={String(pageSize)} onChange={(event) => { setPage(1); setPageSize(Number(event.target.value)); }} aria-label="Rows per page">
                <option value="25">25 rows</option>
                <option value="50">50 rows</option>
                <option value="100">100 rows</option>
              </ProjectSelect>
            </div>
            <nav className="flex items-center gap-1.5" aria-label="Import rows pagination">
              <button type="button" disabled={!review || review.pagination.page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="inline-flex h-10 w-10 items-center justify-center rounded-[8px] border border-[#D4D7DC] bg-white disabled:opacity-35" title="Previous page" aria-label="Previous page"><Icon name="chevron_left" sizePx={17} /></button>
              <span className="min-w-[58px] whitespace-nowrap text-center text-[9px] font-extrabold text-[#374151]">Page {review?.pagination.page || 1} of {review?.pagination.totalPages || 1}</span>
              <button type="button" disabled={!review || review.pagination.page >= review.pagination.totalPages} onClick={() => setPage((value) => value + 1)} className="inline-flex h-10 w-10 items-center justify-center rounded-[8px] border border-[#D4D7DC] bg-white disabled:opacity-35" title="Next page" aria-label="Next page"><Icon name="chevron_right" sizePx={17} /></button>
            </nav>
          </div>
        </section>

        <div className={`${mobilePanel === "editor" ? "block" : "hidden"} h-full min-h-0 xl:block`}>{renderEditor()}</div>
        <div className={`${mobilePanel === "source" ? "block" : "hidden"} h-full min-h-0 xl:block`}>{renderSourcePanel()}</div>
      </main>

      {/* Bulk Selection Floating Bar */}
      {selectedCount > 0 ? (
        <div className="fixed bottom-3 left-3 right-3 z-30 flex items-center justify-between gap-3 rounded-[16px] border border-[#D8DBE0] bg-white p-3 shadow-[0_12px_35px_rgba(15,23,42,0.18)] xl:static">
          <div>
            <div className="text-[13px] font-extrabold text-[#11120d]">
              {selectedCount.toLocaleString()} product{selectedCount === 1 ? "" : "s"} selected{allMatchingSelected ? " across all matching pages" : ""}
            </div>
            <div className="text-[10px] font-semibold text-[#7A7F89]">Only explicit bulk fields will change.</div>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={clearSelection} className="h-10 rounded-[10px] border border-[#D4D7DC] px-3.5 text-[11px] font-extrabold text-[#374151] transition hover:bg-[#F3F4F6]">
              Clear
            </button>
            <button type="button" onClick={() => setBulkOpen(true)} className="inline-flex h-10 items-center gap-2 rounded-[10px] bg-[#11120d] px-4 text-[11px] font-extrabold text-white shadow-sm transition hover:bg-[#2a2c27]">
              <Icon name="edit" sizePx={16} />
              Bulk edit
            </button>
          </div>
        </div>
      ) : null}

      {/* Mobile 3-Dots Action Sheet Modal */}
      {mobileMenuOpen ? (
        <ModalFrame
          open={mobileMenuOpen}
          onClose={() => setMobileMenuOpen(false)}
          title="Batch Utilities"
          description={review?.batch.fileName || "Import review utilities"}
          maxWidthClass="max-w-[420px]"
          mobileBottomSheet
        >
          <div className="space-y-2 py-1">
            <button
              type="button"
              onClick={() => { setMobileMenuOpen(false); void downloadSource(); }}
              disabled={!review?.batch.source?.available}
              className="flex h-11 w-full items-center justify-between rounded-[10px] border border-[#E2E4E8] bg-white px-3.5 text-[12px] font-bold text-[#11120d] transition hover:bg-[#F8F9FA] disabled:opacity-40"
            >
              <span className="flex items-center gap-2.5">
                <Icon name="download" sizePx={18} className="text-[#64748B]" />
                <span>Download original source</span>
              </span>
              <Icon name="chevron_right" sizePx={17} className="text-[#94A3B8]" />
            </button>

            {review?.priceMapping.required ? (
              <button
                type="button"
                onClick={() => { setMobileMenuOpen(false); setPriceSetupOpen(true); }}
                className="flex h-11 w-full items-center justify-between rounded-[10px] border border-[#E2E4E8] bg-white px-3.5 text-[12px] font-bold text-[#11120d] transition hover:bg-[#F8F9FA]"
              >
                <span className="flex items-center gap-2.5">
                  <Icon name="swap_horiz" sizePx={18} className="text-[#64748B]" />
                  <span>Batch price setup</span>
                </span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold ${review.priceMapping.complete ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900"}`}>
                  {review.priceMapping.complete ? "Configured" : "Required"}
                </span>
              </button>
            ) : null}

            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                type="button"
                onClick={() => { setMobileMenuOpen(false); requestHistoryAction("undo"); }}
                disabled={historyBusy || undoStack.length === 0}
                className="flex h-10 items-center justify-center gap-1.5 rounded-[10px] border border-[#D4D7DC] bg-white text-[11px] font-bold text-[#11120d] transition hover:bg-[#F3F4F6] disabled:opacity-35"
              >
                <Icon name="undo" sizePx={16} />
                <span>Undo ({undoStack.length})</span>
              </button>
              <button
                type="button"
                onClick={() => { setMobileMenuOpen(false); requestHistoryAction("redo"); }}
                disabled={historyBusy || redoStack.length === 0}
                className="flex h-10 items-center justify-center gap-1.5 rounded-[10px] border border-[#D4D7DC] bg-white text-[11px] font-bold text-[#11120d] transition hover:bg-[#F3F4F6] disabled:opacity-35"
              >
                <Icon name="redo" sizePx={16} />
                <span>Redo ({redoStack.length})</span>
              </button>
            </div>
          </div>
        </ModalFrame>
      ) : null}

      {/* Extracted Source Row Details Modal */}
      {sourceDetailsOpen && activeRow ? (
        <ModalFrame
          open={sourceDetailsOpen}
          onClose={() => setSourceDetailsOpen(false)}
          title={`Row ${activeRow.sourceLocator?.rowNumber || activeRow.rowNumber} Details`}
          description={`Product: ${rowName(activeRow)} · ${activeSourceEntries.length} populated fields from original source`}
          maxWidthClass="max-w-[580px]"
          mobileBottomSheet
        >
          <div className="space-y-3 py-1">
            <div className="relative">
              <Icon name="search" sizePx={16} className="absolute left-3 top-2.5 text-[#7A7F89]" />
              <input
                value={sourceDetailSearch}
                onChange={(event) => setSourceDetailSearch(event.target.value)}
                placeholder="Search field names or values…"
                className="h-9 w-full rounded-[9px] border border-[#D4D7DC] pl-9 pr-2.5 text-[11px] font-semibold outline-none focus:border-[#11120d]"
              />
            </div>
            <div className="max-h-[60vh] overflow-y-auto pr-1">
              {activeSourceEntries.filter(([header, val]) =>
                !sourceDetailSearch ||
                readableSourceHeader(header).toLowerCase().includes(sourceDetailSearch.toLowerCase()) ||
                String(val).toLowerCase().includes(sourceDetailSearch.toLowerCase())
              ).length > 0 ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {activeSourceEntries
                    .filter(([header, val]) =>
                      !sourceDetailSearch ||
                      readableSourceHeader(header).toLowerCase().includes(sourceDetailSearch.toLowerCase()) ||
                      String(val).toLowerCase().includes(sourceDetailSearch.toLowerCase())
                    )
                    .map(([header, value]) => (
                      <div key={header} className="rounded-[10px] border border-[#E2E4E8] bg-[#F8F9FA] p-3">
                        <div className="text-[9px] font-extrabold uppercase tracking-wide text-[#64748B]">
                          {readableSourceHeader(header)}
                        </div>
                        <div className="mt-1 select-all break-words text-[12px] font-bold text-[#11120d]">
                          {String(value)}
                        </div>
                      </div>
                    ))}
                </div>
              ) : (
                <div className="py-8 text-center text-[12px] font-bold text-[#7A7F89]">
                  No fields match "{sourceDetailSearch}"
                </div>
              )}
            </div>
          </div>
        </ModalFrame>
      ) : null}

      {/* Undo/Redo Confirmation Dialog */}
      {historyPrompt ? (
        <div className="fixed inset-0 z-[85] flex items-end justify-center bg-slate-950/45 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={`Confirm ${historyPrompt.direction}`}>
          <button type="button" className="absolute inset-0 cursor-default" onClick={() => !historyBusy && setHistoryPrompt(null)} aria-label={`Cancel ${historyPrompt.direction}`} />
          <section className="relative z-10 w-full max-w-[500px] rounded-t-[22px] bg-white p-5 shadow-2xl sm:rounded-[20px]">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#F1F3F5] text-[#11120d]"><Icon name={historyPrompt.direction === "undo" ? "undo" : "redo"} sizePx={22} /></span>
              <div className="min-w-0"><h2 className="text-[18px] font-extrabold text-[#11120d]">{historyPrompt.direction === "undo" ? "Undo this saved change?" : "Redo this saved change?"}</h2><p className="mt-1 text-[11px] font-semibold leading-5 text-[#68707C]">{historyPrompt.entry.label}</p></div>
            </div>
            <div className="mt-4 rounded-[11px] border border-[#D8DBE0] bg-[#F8F9FA] px-3 py-2.5 text-[10px] font-semibold leading-4 text-[#5F6570]">This changes {historyPrompt.entry.before.length.toLocaleString()} saved review row{historyPrompt.entry.before.length === 1 ? "" : "s"}. It does not change products that were already final-imported. This undo history lasts only for the current review session.</div>
            <div className="mt-5 grid grid-cols-2 gap-2"><button type="button" onClick={() => setHistoryPrompt(null)} disabled={historyBusy} className="h-11 rounded-[11px] border border-[#D4D7DC] text-[11px] font-extrabold">Cancel</button><button type="button" onClick={() => void applyHistoryAction()} disabled={historyBusy} className="inline-flex h-11 items-center justify-center gap-2 rounded-[11px] bg-[#11120d] text-[11px] font-extrabold text-white disabled:opacity-45"><Icon name={historyPrompt.direction === "undo" ? "undo" : "redo"} sizePx={17} />{historyBusy ? "Applying…" : historyPrompt.direction === "undo" ? "Undo saved change" : "Redo saved change"}</button></div>
          </section>
        </div>
      ) : null}

      {/* Price Setup Modal */}
      {priceSetupOpen && review?.priceMapping.required ? (
        <div className="fixed inset-0 z-[72] flex items-end justify-center bg-slate-950/40 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Batch price setup">
          <button type="button" className="absolute inset-0 cursor-default" onClick={() => !priceMappingBusy && setPriceSetupOpen(false)} aria-label="Close price setup" />
          <section className="relative z-10 w-full max-w-[560px] rounded-t-[22px] bg-white shadow-2xl sm:rounded-[20px]">
            <header className="flex items-start justify-between gap-3 border-b border-[#D8DBE0] p-5"><div><div className="flex items-center gap-2"><h2 className="text-[18px] font-extrabold text-[#11120d]">Price setup</h2><span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-1 text-[9px] font-extrabold text-emerald-800">Entire batch</span></div><p className="mt-1 text-[11px] font-semibold leading-5 text-[#68707C]">Classify what each extracted supplier price column means. This applies to every row in this import.</p></div><button type="button" onClick={() => setPriceSetupOpen(false)} disabled={priceMappingBusy} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-[#D4D7DC]"><Icon name="close" sizePx={18} /></button></header>
            <div className="grid gap-3 p-5">
              {review.priceMapping.columns.map((column) => {
                const sample = activeExtractedPrices.find((price) => price.key === column.key);
                return <Field key={column.key} label={`${column.label}${typeof sample?.value === "number" ? ` — selected row NPR ${sample.value.toLocaleString()}` : ""}`}><ProjectSelect value={priceMappingDraft[column.key] || ""} onChange={(event) => setPriceMappingDraft((current) => ({ ...current, [column.key]: event.target.value }))} className="h-11 w-full" aria-label={`Assign ${column.label}`}><option value="">Select price type</option><option value="ratePerPiece">Purchase rate</option><option value="retailPrice">Retail price</option><option value="wholesalePrice">Wholesale price</option></ProjectSelect></Field>;
              })}
              <div className="rounded-[11px] border border-blue-200 bg-blue-50 p-3 text-[10px] font-semibold leading-4 text-blue-950">Use this only when the source column has one meaning for the whole catalog. For selected exceptions, use Bulk edit → Price-field reassignment.</div>
            </div>
            <footer className="grid grid-cols-[auto_1fr] gap-2 border-t border-[#D8DBE0] p-4"><button type="button" onClick={() => setPriceSetupOpen(false)} disabled={priceMappingBusy} className="h-11 rounded-[11px] border border-[#D4D7DC] px-5 text-[11px] font-extrabold">Cancel</button><button type="button" onClick={() => void savePriceMapping()} disabled={priceMappingBusy} className="inline-flex h-11 items-center justify-center gap-2 rounded-[11px] bg-[#11120d] px-5 text-[11px] font-extrabold text-white disabled:opacity-45"><Icon name="check" sizePx={17} />{priceMappingBusy ? "Saving…" : "Apply to entire batch"}</button></footer>
          </section>
        </div>
      ) : null}

      {/* Bulk Edit Drawer */}
      {bulkOpen ? (
        <div className="fixed inset-0 z-[70] flex items-end justify-end bg-slate-950/40 sm:items-stretch" role="dialog" aria-modal="true" aria-label="Bulk edit selected import rows">
          <button type="button" className="absolute inset-0 cursor-default" onClick={closeBulkEdit} aria-label="Close bulk editor" />
          <aside className="relative z-10 max-h-[88dvh] w-full overflow-y-auto rounded-t-[22px] bg-[#F8F9FA] shadow-2xl sm:h-full sm:max-h-none sm:max-w-[440px] sm:rounded-none sm:border-l sm:border-[#D8DBE0]">
            <div className="sticky top-0 z-30 flex items-center justify-between border-b border-[#D8DBE0] bg-white px-4.5 py-4 shadow-xs">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-[16px] font-extrabold text-[#11120d]">Bulk edit</h2>
                  <span className="rounded-full bg-[#F1F3F5] px-2.5 py-0.5 text-[10px] font-extrabold text-[#11120d] border border-[#D8DBE0]">
                    {selectedCount.toLocaleString()} product{selectedCount === 1 ? "" : "s"}
                  </span>
                </div>
                <p className="mt-1 text-[11px] font-semibold text-[#7A7F89]">Apply safe, row-specific changes across your selection.</p>
              </div>
              <button type="button" onClick={closeBulkEdit} disabled={bulkSaving} className="inline-flex h-10 w-10 items-center justify-center rounded-[10px] border border-[#D4D7DC] hover:bg-[#F3F4F6]">
                <Icon name="close" sizePx={18} />
              </button>
            </div>

            <div className="flex flex-col gap-3.5 p-4 pb-3">
              {/* 01. Taxonomy */}
              <div className="rounded-[14px] border border-[#D8DBE0] bg-white p-3.5">
                <div className="mb-1 text-[9px] font-extrabold uppercase tracking-[0.12em] text-[#64748B]">01 · Organization</div>
                <h3 className="mb-3 text-[13px] font-extrabold text-[#11120d]">Taxonomy & Categorization</h3>
                <div className="grid gap-3">
                  <Field label="Set brand (blank keeps current)">
                    <CreatableCombobox value={bulkBrand} onChange={setBulkBrand} options={brandOptions} placeholder="Search or enter brand" ariaLabel="Bulk brand" selectOnFocus compact showCreateHelp={false} />
                  </Field>
                  <Field label="Set category (blank keeps current)">
                    <CreatableCombobox value={bulkCategory} onChange={setBulkCategory} options={categoryOptions} placeholder="Search or enter category" ariaLabel="Bulk category" selectOnFocus compact showCreateHelp={false} />
                  </Field>
                  <Field label="Set supplier (blank keeps current)">
                    <CreatableCombobox value={bulkSupplier} onChange={setBulkSupplier} options={supplierOptions} placeholder="Search or enter supplier" ariaLabel="Bulk supplier" selectOnFocus compact showCreateHelp={false} />
                  </Field>
                </div>
              </div>

              {/* 02. Packaging */}
              <div className="rounded-[14px] border border-[#D8DBE0] bg-white p-3.5">
                <div className="mb-1 text-[9px] font-extrabold uppercase tracking-[0.12em] text-[#64748B]">02 · Packaging</div>
                <h3 className="mb-3 text-[13px] font-extrabold text-[#11120d]">Units & Quantities</h3>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Package quantity">
                    <input type="number" value={bulkPackageQuantity} onChange={(event) => setBulkPackageQuantity(event.target.value)} className={inputClass} placeholder="Unchanged" />
                  </Field>
                  <Field label="Package unit">
                    <CreatableCombobox value={bulkPackageUnit} onChange={(value) => setBulkPackageUnit(value.toUpperCase())} options={unitOptions} placeholder="Package unit" ariaLabel="Bulk package unit" selectOnFocus compact showCreateHelp={false} />
                  </Field>
                </div>
                <p className="mt-2 text-[10px] font-semibold text-[#7A7F89]">Blank fields leave the selected rows unchanged. Unknown package quantities remain unknown.</p>
              </div>

              {/* 03. Row-specific prices */}
              <section className="rounded-[14px] border border-[#D8DBE0] bg-white p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[9px] font-extrabold uppercase tracking-[0.12em] text-[#64748B]">03 · Row-specific prices</div>
                    <h3 className="mt-0.5 text-[13px] font-extrabold text-[#11120d]">Price-field reassignment</h3>
                  </div>
                  <span className="rounded-full bg-[#F1F3F5] px-2 py-0.5 text-[9px] font-extrabold text-[#11120d] border border-[#D8DBE0]">Selected only</span>
                </div>
                <p className="mt-2 text-[10.5px] font-semibold leading-4 text-[#4B5563]">Move each product’s own value into another field. No common amount is copied across products.</p>
                <div className="mt-3 space-y-2">
                  <Field label="Move price from (Source)">
                    <ProjectSelect value={bulkMoveFrom} onChange={(event) => setBulkMoveFrom(event.target.value as ImportPriceField | "")} className="h-10 w-full">
                      <option value="">Choose source field</option>
                      <option value="ratePerPiece">Purchase rate</option>
                      <option value="retailPrice">Retail price</option>
                      <option value="wholesalePrice">Wholesale price</option>
                    </ProjectSelect>
                  </Field>
                  <div className="flex justify-center text-[#11120d]">
                    <Icon name="arrow_downward" sizePx={18} />
                  </div>
                  <Field label="Move price to (Destination)">
                    <ProjectSelect value={bulkMoveTo} onChange={(event) => setBulkMoveTo(event.target.value as ImportPriceField | "")} className="h-10 w-full">
                      <option value="">Choose destination field</option>
                      <option value="ratePerPiece">Purchase rate</option>
                      <option value="retailPrice">Retail price</option>
                      <option value="wholesalePrice">Wholesale price</option>
                    </ProjectSelect>
                  </Field>
                </div>
                {bulkMoveFrom && bulkMoveTo && bulkMoveFrom === bulkMoveTo ? (
                  <div className="mt-2.5 rounded-[9px] border border-rose-200 bg-rose-50 p-2 text-[10px] font-bold text-rose-800">Source and destination must be different.</div>
                ) : null}
                <div className="mt-3 rounded-[11px] border border-amber-200 bg-amber-50/80 p-3">
                  <div className="text-[10px] font-extrabold text-amber-950">If the destination already has a price:</div>
                  <label className="mt-2 flex cursor-pointer gap-2 text-[10px] font-semibold">
                    <input type="radio" checked={bulkConflictPolicy === "KEEP"} onChange={() => setBulkConflictPolicy("KEEP")} className="accent-[#11120d]" />
                    <span>
                      <strong className="block text-slate-800">Keep the existing destination</strong>
                      <span className="text-[#68707C]">Skip the move for conflicting rows.</span>
                    </span>
                  </label>
                  <label className="mt-2 flex cursor-pointer gap-2 text-[10px] font-semibold">
                    <input type="radio" checked={bulkConflictPolicy === "REPLACE"} onChange={() => setBulkConflictPolicy("REPLACE")} className="accent-[#11120d]" />
                    <span>
                      <strong className="block text-slate-800">Replace the destination</strong>
                      <span className="text-[#68707C]">Use each row’s source value instead.</span>
                    </span>
                  </label>
                </div>
                <label className="mt-3 flex items-center justify-between gap-3 rounded-[10px] border border-[#D8DBE0] bg-white p-3">
                  <span>
                    <strong className="block text-[10.5px] text-[#11120d]">Clear original source after moving</strong>
                    <span className="text-[9.5px] font-semibold text-[#68707C]">Off keeps values in both fields.</span>
                  </span>
                  <input type="checkbox" checked={bulkClearSource} onChange={(event) => setBulkClearSource(event.target.checked)} className="h-4.5 w-4.5 rounded accent-[#11120d]" />
                </label>
              </section>

              {/* 04. Calculated prices */}
              <section className="rounded-[14px] border border-[#D8DBE0] bg-white p-3.5">
                <label className="flex cursor-pointer items-center justify-between gap-3">
                  <div>
                    <div className="text-[9px] font-extrabold uppercase tracking-[0.12em] text-[#7A7F89]">04 · Calculated prices</div>
                    <h3 className="mt-0.5 text-[13px] font-extrabold text-[#11120d]">Percentage markup / markdown</h3>
                  </div>
                  <input
                    type="checkbox"
                    checked={bulkPercentageEnabled}
                    onChange={(event) => setBulkPercentageEnabled(event.target.checked)}
                    className="h-5 w-5 cursor-pointer rounded accent-[#11120d]"
                    aria-label="Enable percentage markup or markdown"
                  />
                </label>
                <p className="mt-2 text-[10.5px] font-semibold leading-4 text-[#68707C]">Uses each row’s selected base price. Rows with an empty base are skipped.</p>
                <div className={`mt-3 grid grid-cols-2 gap-2.5 ${bulkPercentageEnabled ? "" : "opacity-45"}`}>
                  <Field label="Base price">
                    <ProjectSelect disabled={!bulkPercentageEnabled} value={bulkPercentageBase} onChange={(event) => setBulkPercentageBase(event.target.value as ImportPriceField | "")} className="h-10 w-full">
                      <option value="">Choose base</option>
                      <option value="ratePerPiece">Purchase rate</option>
                      <option value="retailPrice">Retail price</option>
                      <option value="wholesalePrice">Wholesale price</option>
                    </ProjectSelect>
                  </Field>
                  <Field label="Target price">
                    <ProjectSelect disabled={!bulkPercentageEnabled} value={bulkPercentageTarget} onChange={(event) => setBulkPercentageTarget(event.target.value as ImportPriceField | "")} className="h-10 w-full">
                      <option value="">Choose target</option>
                      <option value="ratePerPiece">Purchase rate</option>
                      <option value="retailPrice">Retail price</option>
                      <option value="wholesalePrice">Wholesale price</option>
                    </ProjectSelect>
                  </Field>
                </div>
                <div className={`mt-3 grid grid-cols-[1fr_96px] gap-2 ${bulkPercentageEnabled ? "" : "opacity-45"}`}>
                  <div className="grid grid-cols-2 rounded-[10px] border border-[#D4D7DC] bg-[#F1F3F5] p-1">
                    <button
                      type="button"
                      disabled={!bulkPercentageEnabled}
                      onClick={() => setBulkPercentageDirection("INCREASE")}
                      className={`h-8 rounded-[8px] text-[12px] font-bold transition ${
                        bulkPercentageDirection === "INCREASE"
                          ? "bg-white text-emerald-800 shadow-sm"
                          : "text-[#64748B] hover:text-[#11120d]"
                      }`}
                    >
                      + Increase
                    </button>
                    <button
                      type="button"
                      disabled={!bulkPercentageEnabled}
                      onClick={() => setBulkPercentageDirection("DECREASE")}
                      className={`h-8 rounded-[8px] text-[12px] font-bold transition ${
                        bulkPercentageDirection === "DECREASE"
                          ? "bg-white text-rose-800 shadow-sm"
                          : "text-[#64748B] hover:text-[#11120d]"
                      }`}
                    >
                      − Decrease
                    </button>
                  </div>
                  <label className="flex h-10 items-center rounded-[9px] border border-[#D4D7DC] bg-white px-2">
                    <input disabled={!bulkPercentageEnabled} type="number" min="0.01" max="100" step="0.01" value={bulkPercentage} onChange={(event) => setBulkPercentage(event.target.value)} className="min-w-0 flex-1 bg-transparent text-right text-[11px] font-extrabold outline-none" placeholder="0" />
                    <span className="ml-1 text-[11px] font-extrabold text-[#68707C]">%</span>
                  </label>
                </div>
                <p className="mt-2 text-[9.5px] font-semibold text-[#68707C]">Allowed range: above 0 and up to 100. A markdown must remain below 100.</p>
              </section>
            </div>

            <div className="sticky bottom-0 z-30 grid w-full grid-cols-[auto_1fr] gap-2.5 border-t border-[#D8DBE0] bg-white p-4 shadow-sm">
              <button type="button" onClick={closeBulkEdit} disabled={bulkSaving} className="h-11 rounded-[11px] border border-[#D4D7DC] px-4 text-[11px] font-extrabold text-[#374151] hover:bg-[#F3F4F6]">
                Cancel
              </button>
              <button type="button" onClick={() => void prepareBulkEditReview()} disabled={bulkSaving || selectedCount === 0} className="inline-flex h-11 items-center justify-center gap-2 rounded-[11px] bg-[#11120d] px-4 text-[11px] font-extrabold text-white shadow-sm transition hover:bg-[#2a2c27] disabled:opacity-45">
                {bulkSaving ? "Preparing…" : <>Review changes <Icon name="chevron_right" sizePx={17} /></>}
              </button>
            </div>

            {bulkPreview ? (
              <div className="absolute inset-0 z-30 flex flex-col bg-[#F8F9FA]">
                <header className="flex items-start justify-between gap-3 border-b border-[#D8DBE0] bg-white p-4">
                  <div>
                    <div className="text-[9px] font-extrabold uppercase tracking-[0.12em] text-[#64748B]">Final review</div>
                    <h2 className="mt-1 text-[17px] font-extrabold text-[#11120d]">Confirm these changes?</h2>
                    <p className="mt-1 text-[10px] font-semibold leading-4 text-[#68707C]">Nothing has been written yet. Confirm the exact operation below.</p>
                  </div>
                  <button type="button" onClick={() => setBulkPreview(null)} disabled={bulkSaving} className="inline-flex h-10 w-10 items-center justify-center rounded-[10px] border border-[#D4D7DC] hover:bg-[#F3F4F6]">
                    <Icon name="close" sizePx={18} />
                  </button>
                </header>
                <div className="flex-1 overflow-y-auto p-4 pb-4">
                  <div className="rounded-[14px] border border-[#D8DBE0] bg-white p-4">
                    <h3 className="text-[12px] font-extrabold text-[#11120d]">Change summary</h3>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <div className="rounded-[10px] bg-[#F5F6F8] p-3">
                        <strong className="block text-[18px] text-[#11120d]">{selectedCount.toLocaleString()}</strong>
                        <span className="text-[9px] font-bold text-[#68707C]">Selected products</span>
                      </div>
                      <div className="rounded-[10px] bg-emerald-50 p-3">
                        <strong className="block text-[18px] text-emerald-800">{bulkPreview.changedRows.toLocaleString()}</strong>
                        <span className="text-[9px] font-bold text-emerald-800">Rows that will change</span>
                      </div>
                      <div className="rounded-[10px] bg-amber-50 p-3">
                        <strong className="block text-[18px] text-amber-900">{bulkPreview.skippedRows.toLocaleString()}</strong>
                        <span className="text-[9px] font-bold text-amber-900">Rows with skipped operations</span>
                      </div>
                      <div className="rounded-[10px] bg-amber-50 p-3">
                        <strong className="block text-[18px] text-amber-900">{bulkPreview.priceConflicts.toLocaleString()}</strong>
                        <span className="text-[9px] font-bold text-amber-900">Destination conflicts</span>
                      </div>
                    </div>
                    <div className="mt-3">
                      <div className="text-[9px] font-extrabold uppercase tracking-wide text-[#68707C]">Fields that will change</div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {bulkPreview.fields.map((field) => (
                          <span key={field} className="rounded-full border border-[#D8DBE0] bg-[#F1F3F5] px-2 py-1 text-[9px] font-extrabold text-[#11120d]">
                            {field}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 rounded-[11px] border border-blue-200 bg-blue-50 p-3 text-[10px] font-semibold leading-4 text-blue-950">
                    Every price operation uses each product’s own current value. No single price is copied to all selected products.
                  </div>
                </div>
                <footer className="sticky bottom-0 z-30 grid w-full grid-cols-[auto_1fr] gap-2.5 border-t border-[#D8DBE0] bg-white p-4 shadow-sm">
                  <button type="button" onClick={() => setBulkPreview(null)} disabled={bulkSaving} className="h-11 rounded-[11px] border border-[#D4D7DC] px-4 text-[11px] font-extrabold text-[#374151] hover:bg-[#F3F4F6]">
                    Go back
                  </button>
                  <button type="button" onClick={() => void applyReviewedBulkEdit()} disabled={bulkSaving} className="inline-flex h-11 items-center justify-center gap-2 rounded-[11px] bg-[#11120d] px-4 text-[11px] font-extrabold text-white shadow-sm transition hover:bg-[#2a2c27] disabled:opacity-45">
                    <Icon name="check" sizePx={17} />
                    {bulkSaving ? "Applying…" : `Confirm ${bulkPreview.changedRows.toLocaleString()} changes`}
                  </button>
                </footer>
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}

      {/* Final Import Confirmation Modal */}
      {commitOpen && review ? (
        <div className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-950/45 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Confirm final product import">
          <button type="button" className="absolute inset-0 cursor-default" onClick={() => !commitBusy && setCommitOpen(false)} aria-label="Close final import confirmation" />
          <section className="relative z-10 w-full max-w-[560px] rounded-t-[22px] bg-white p-5 shadow-2xl sm:rounded-[20px]">
            <div className="flex items-start justify-between gap-3"><div><h2 className="text-[18px] font-extrabold text-[#11120d]">Confirm final import</h2><p className="mt-1 text-[11px] font-semibold text-[#7A7F89]">This applies every saved decision in this batch. It is not a preview.</p></div><button type="button" onClick={() => setCommitOpen(false)} disabled={commitBusy} className="h-10 w-10 rounded-[10px] border border-[#D4D7DC]"><Icon name="close" sizePx={18} /></button></div>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {[{ label: "Create", value: review.decisionCounts.create }, { label: "Update", value: review.decisionCounts.update }, { label: "Keep", value: review.decisionCounts.keep }, { label: "Ignore", value: review.decisionCounts.ignore }, { label: "Unresolved", value: review.decisionCounts.unresolved }].map((item) => <div key={item.label} className={`rounded-[11px] border p-3 ${item.label === "Unresolved" && item.value > 0 ? "border-rose-200 bg-rose-50" : "border-[#D8DBE0] bg-[#F8F9FA]"}`}><div className="text-[18px] font-extrabold">{item.value}</div><div className="text-[9px] font-bold text-[#68707C]">{item.label}</div></div>)}
            </div>
            {review.priceMapping.required && !review.priceMapping.complete ? <div className="mt-4 rounded-[11px] border border-rose-200 bg-rose-50 p-3 text-[11px] font-bold leading-5 text-rose-900">Final import is blocked until every extracted price column is classified.</div> : review.decisionCounts.unresolved > 0 ? <div className="mt-4 rounded-[11px] border border-rose-200 bg-rose-50 p-3 text-[11px] font-bold leading-5 text-rose-900">Final import is blocked. Filter conflicts, file duplicates and failed rows; correct them or explicitly ignore them.</div> : <div className="mt-4 rounded-[11px] border border-amber-200 bg-amber-50 p-3 text-[11px] font-bold leading-5 text-amber-950">Create and update decisions change product data. Keep and ignore decisions do not change existing products.</div>}
            <div className="mt-5 grid grid-cols-2 gap-2"><button type="button" onClick={() => setCommitOpen(false)} disabled={commitBusy} className="h-11 rounded-[11px] border border-[#D4D7DC] text-[11px] font-extrabold">Back to review</button><button type="button" onClick={() => void commitBatch()} disabled={commitBusy || review.decisionCounts.unresolved > 0 || (review.priceMapping.required && !review.priceMapping.complete)} className="h-11 rounded-[11px] bg-[#11120d] text-[11px] font-extrabold text-white disabled:opacity-40">{commitBusy ? "Importing…" : "Confirm and import"}</button></div>
          </section>
        </div>
      ) : null}

      {/* Exit Confirmation Modal */}
      {exitConfirmOpen ? (
        <ModalFrame
          open={exitConfirmOpen}
          onClose={() => setExitConfirmOpen(false)}
          title="Leave import review?"
          description="Your imported draft is saved, but products haven't been added to your catalog yet."
          maxWidthClass="max-w-[460px]"
          mobileBottomSheet
        >
          <div className="space-y-4 py-1">
            <div className="rounded-[11px] border border-[#D8DBE0] bg-[#F8F9FA] p-3 text-[11px] font-semibold leading-5 text-[#5F6570]">
              You can return to this review workbench at any time from the Products page to complete and finalize your import.
              {dirty ? <p className="mt-1.5 font-bold text-amber-800">Note: You have unsaved changes on the current row that will be discarded if you leave now without saving.</p> : null}
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => setExitConfirmOpen(false)}
                className="h-10.5 rounded-[10px] border border-[#D4D7DC] bg-white text-[11px] font-extrabold text-[#374151] hover:bg-[#F3F4F6]"
              >
                Stay in review
              </button>
              <button
                type="button"
                onClick={() => { setExitConfirmOpen(false); navigate("/products"); }}
                className="inline-flex h-10.5 items-center justify-center gap-1.5 rounded-[10px] bg-[#11120d] text-[11px] font-extrabold text-white transition hover:bg-[#2a2c27]"
              >
                Leave review
              </button>
            </div>
          </div>
        </ModalFrame>
      ) : null}
    </div>
  );
}
