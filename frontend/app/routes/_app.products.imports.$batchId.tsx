import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import Icon from "~/components/ui/Icon";
import { useToast } from "~/components/ui/Toast";
import CreatableCombobox from "~/components/ui/CreatableCombobox";
import ProjectSelect from "~/components/ui/ProjectSelect";
import Switch from "~/components/ui/Switch";
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
type PendingReviewNavigation = {
  description: string;
  proceed: () => void;
};
type BulkEditPreviewItem = {
  before: ReviewedPdfImportRowPayload;
  after: ReviewedPdfImportRowPayload;
  changedFields: string[];
  skippedOperations: number;
  priceConflict: boolean;
  skipReason?: string;
};

type BulkEditPreview = {
  before: ReviewedPdfImportRowPayload[];
  after: ReviewedPdfImportRowPayload[];
  items: BulkEditPreviewItem[];
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

function rowRate(row: ProductImportRow) {
  const parsed = parsedImportRow(row);
  const value = Number(parsed.ratePerPiece);
  if (Number.isFinite(value) && value > 0) return `NPR ${value.toLocaleString()}`;
  const extracted = Array.isArray(parsed.extractedPrices)
    ? Number((parsed.extractedPrices[0] as any)?.value)
    : Number.NaN;
  return Number.isFinite(extracted) && extracted > 0
    ? `Rate NPR ${extracted.toLocaleString()}`
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

function reviewPrice(value: number | null | undefined) {
  return Number(value) > 0 ? `NPR ${Number(value).toLocaleString()}` : "Empty";
}

function availabilityText(value: ReviewedPdfImportRowPayload["availabilityStatus"]) {
  return value === "COMING_SOON" ? "Coming soon" : "Normal product";
}

function priceFieldLabel(field: ImportPriceField | ""): string {
  if (field === "ratePerPiece") return "Rate";
  if (field === "retailPrice") return "Retail price";
  if (field === "wholesalePrice") return "Wholesale price";
  return "";
}

function priceFieldDescription(field: string): string {
  if (field === "ratePerPiece") return "Rate (Cost price)";
  if (field === "retailPrice") return "Retail price";
  if (field === "wholesalePrice") return "Wholesale price";
  return "Unassigned";
}

function hasPositivePrice(row: ReviewedPdfImportRowPayload, field?: ImportPriceField | ""): boolean {
  if (!field) return false;
  const val = Number(row[field]);
  return Number.isFinite(val) && val > 0;
}

function getPriceColumnDetails(
  columnKey: string,
  rows: ProductImportRow[],
  activeRow: ProductImportRow | null,
  selectedIds?: Set<string>,
) {
  const targetRows = selectedIds && selectedIds.size > 0
    ? rows.filter((r) => selectedIds.has(r.id))
    : activeRow
      ? [activeRow]
      : rows;

  const matchingRows: Array<{ name: string; value: number }> = [];

  for (const row of targetRows) {
    const parsed = parsedImportRow(row);
    let value: number | null = null;

    if (Array.isArray(parsed.extractedPrices)) {
      const found = (parsed.extractedPrices as any[]).find((p) => p && (p.key === columnKey || p.label === columnKey));
      if (found && Number.isFinite(Number(found.value)) && Number(found.value) > 0) {
        value = Number(found.value);
      }
    }

    if (value === null) {
      if (columnKey === "sourceRatePerPiece" || columnKey === "ratePerPiece" || columnKey === "rate") {
        if (Number(parsed.ratePerPiece) > 0) value = Number(parsed.ratePerPiece);
      } else if (columnKey === "sourceRetailPrice" || columnKey === "retailPrice") {
        if (Number(parsed.retailPrice) > 0) value = Number(parsed.retailPrice);
      } else if (columnKey === "sourceWholesalePrice" || columnKey === "wholesalePrice") {
        if (Number(parsed.wholesalePrice) > 0) value = Number(parsed.wholesalePrice);
      } else if (Number((parsed as any)[columnKey]) > 0) {
        value = Number((parsed as any)[columnKey]);
      }
    }

    if (value === null && row.rawText) {
      try {
        const cells = JSON.parse(row.rawText);
        if (cells && typeof cells === "object") {
          const rawVal = Number(cells[columnKey]);
          if (Number.isFinite(rawVal) && rawVal > 0) {
            value = rawVal;
          }
        }
      } catch {
        // ignore parse error
      }
    }

    if (value !== null) {
      const name = String(parsed.name || parsed.productName || `Row ${row.rowNumber}`);
      matchingRows.push({ name, value });
    }
  }

  let activeValue: number | null = null;
  if (activeRow) {
    const parsed = parsedImportRow(activeRow);
    if (Array.isArray(parsed.extractedPrices)) {
      const found = (parsed.extractedPrices as any[]).find((p) => p && (p.key === columnKey || p.label === columnKey));
      if (found && Number.isFinite(Number(found.value))) activeValue = Number(found.value);
    }
    if (activeValue === null) {
      if (columnKey === "sourceRatePerPiece" || columnKey === "ratePerPiece" || columnKey === "rate") {
        if (Number(parsed.ratePerPiece) > 0) activeValue = Number(parsed.ratePerPiece);
      } else if (columnKey === "sourceRetailPrice" || columnKey === "retailPrice") {
        if (Number(parsed.retailPrice) > 0) activeValue = Number(parsed.retailPrice);
      } else if (columnKey === "sourceWholesalePrice" || columnKey === "wholesalePrice") {
        if (Number(parsed.wholesalePrice) > 0) activeValue = Number(parsed.wholesalePrice);
      }
    }
  }

  return {
    totalMatching: matchingRows.length,
    targetCount: targetRows.length,
    sample: matchingRows[0] || null,
    activeValue,
  };
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
  const sourceHighlightRef = useRef<HTMLDivElement>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [priceSetupOpen, setPriceSetupOpen] = useState(false);
  const [exitConfirmOpen, setExitConfirmOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sourceDetailsOpen, setSourceDetailsOpen] = useState(false);
  const [sourceDetailSearch, setSourceDetailSearch] = useState("");
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkTab, setBulkTab] = useState<"catalog" | "percentage" | "reassign" | "extracted">("catalog");
  const [bulkExtractedMapping, setBulkExtractedMapping] = useState<Record<string, ImportPriceField | "">>({});
  const [bulkBrand, setBulkBrand] = useState("");
  const [bulkCategory, setBulkCategory] = useState("");
  const [bulkSupplier, setBulkSupplier] = useState("");
  const [bulkPackageQuantity, setBulkPackageQuantity] = useState("");
  const [bulkPackageUnit, setBulkPackageUnit] = useState("");
  const [bulkAvailability, setBulkAvailability] = useState<"" | "CATALOG_LISTED" | "COMING_SOON">("");
  const [bulkMoveFrom, setBulkMoveFrom] = useState<ImportPriceField | "">("");
  const [bulkMoveTo, setBulkMoveTo] = useState<ImportPriceField | "">("");
  const [bulkConflictPolicy, setBulkConflictPolicy] = useState<"KEEP" | "REPLACE" | "SWAP">("KEEP");
  const [bulkClearSource, setBulkClearSource] = useState(false);
  const [bulkPercentageEnabled, setBulkPercentageEnabled] = useState(false);
  const [bulkPercentageBase, setBulkPercentageBase] = useState<ImportPriceField | "">("");
  const [bulkPercentageTarget, setBulkPercentageTarget] = useState<ImportPriceField | "">("");
  const [bulkPercentageDirection, setBulkPercentageDirection] = useState<"INCREASE" | "DECREASE">("INCREASE");
  const [bulkPercentage, setBulkPercentage] = useState("");
  const [bulkPreview, setBulkPreview] = useState<BulkEditPreview | null>(null);
  const [diffFilter, setDiffFilter] = useState<"all" | "changed" | "skipped" | "conflicts">("all");
  const [diffSearch, setDiffSearch] = useState("");
  const [diffPage, setDiffPage] = useState(1);
  const [bulkSelectedDrafts, setBulkSelectedDrafts] = useState<ReviewedPdfImportRowPayload[]>([]);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkBaseline, setBulkBaseline] = useState("");
  const [bulkDiscardOpen, setBulkDiscardOpen] = useState(false);
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
  const [pendingReviewNavigation, setPendingReviewNavigation] = useState<PendingReviewNavigation | null>(null);
  const [commitResult, setCommitResult] = useState<{
    createdCount: number;
    updatedCount?: number;
    keptCount?: number;
    ignoredCount?: number;
    errorCount: number;
  } | null>(null);
  const pendingPageEdge = useRef<"first" | "last" | null>(null);
  const reviewRequestIdRef = useRef(0);

  const isPriceMappingUnchanged = useMemo(() => {
    if (!review?.priceMapping) return true;
    return review.priceMapping.columns.every(
      (col) => (priceMappingDraft[col.key] || "") === (review.priceMapping.mapping[col.key] || "")
    );
  }, [review?.priceMapping, priceMappingDraft]);

  const hasValidPriceMappingDraft = useMemo(() => {
    if (!review?.priceMapping?.required) return false;
    const columns = review.priceMapping.columns;
    const values = columns.map((col) => priceMappingDraft[col.key] || "");
    if (values.some((v) => !v)) return false;
    return new Set(values).size === values.length;
  }, [review?.priceMapping, priceMappingDraft]);

  useEffect(() => {
    if (priceSetupOpen && review?.priceMapping?.mapping) {
      setPriceMappingDraft({ ...review.priceMapping.mapping });
    }
  }, [priceSetupOpen, review?.priceMapping?.mapping]);

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

  async function loadReview(signal?: AbortSignal) {
    if (!batchId) return;
    const requestId = ++reviewRequestIdRef.current;
    try {
      setLoading(true);
      setError("");
      const result = await getProductImportReviewApi(batchId, {
        page,
        pageSize,
        search: search || undefined,
        comparisonStatus: filter === "ALL" ? undefined : filter,
      }, { signal });
      if (signal?.aborted || requestId !== reviewRequestIdRef.current) return;
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
      if (signal?.aborted || requestId !== reviewRequestIdRef.current) return;
      setError(requestError?.response?.data?.error || requestError?.message || "Import review could not be loaded.");
    } finally {
      if (!signal?.aborted && requestId === reviewRequestIdRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadReview(controller.signal);
    return () => controller.abort();
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
    // Keep the context window centred on the selected source row. Large files
    // intentionally load nearby rows instead of only the first page of source data.
    if (sourceContext?.rows?.some((row) => row.id === activeRowId)) {
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
      targetElement.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    }
  }, [activeRowId, sourceContext]);

  const sourceMimeType = review?.batch.source?.mimeType || "";
  const sourcePageNumber = Number(activeRow?.sourceLocator?.pageNumber || 1);
  const region = displayImportSourceRegion(activeRow?.sourceLocator);
  const regionScale = Number(region?.scale || 1000);

  useEffect(() => {
    if (!activeRowId || !sourcePreviewUrl || !region) return;
    const frame = window.requestAnimationFrame(() => {
      sourceHighlightRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "center",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeRowId, sourcePreviewUrl, region?.top, region?.left, region?.bottom, region?.right]);

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

  const currentDraftFingerprint = useMemo(() => (draft ? JSON.stringify(draftPayload(draft)) : ""), [draft]);
  const dirty = Boolean(draft && currentDraftFingerprint !== savedFingerprint);
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
  const bulkPriceCounts = useMemo(() => {
    let ratePerPiece = 0;
    let retailPrice = 0;
    let wholesalePrice = 0;
    let any = 0;
    for (const row of bulkSelectedDrafts) {
      const hasRate = Number(row.ratePerPiece) > 0;
      const hasRetail = Number(row.retailPrice) > 0;
      const hasWholesale = Number(row.wholesalePrice) > 0;
      if (hasRate) ratePerPiece++;
      if (hasRetail) retailPrice++;
      if (hasWholesale) wholesalePrice++;
      if (hasRate || hasRetail || hasWholesale) any++;
    }
    return { ratePerPiece, retailPrice, wholesalePrice, any };
  }, [bulkSelectedDrafts]);
  const bulkStateFingerprint = useMemo(
    () =>
      JSON.stringify({
        bulkBrand,
        bulkCategory,
        bulkSupplier,
        bulkPackageQuantity,
        bulkPackageUnit,
        bulkAvailability,
        bulkMoveFrom,
        bulkMoveTo,
        bulkConflictPolicy,
        bulkClearSource,
        bulkPercentageEnabled,
        bulkPercentageBase,
        bulkPercentageTarget,
        bulkPercentageDirection,
        bulkPercentage,
        bulkExtractedMapping,
      }),
    [
      bulkBrand,
      bulkCategory,
      bulkSupplier,
      bulkPackageQuantity,
      bulkPackageUnit,
      bulkAvailability,
      bulkMoveFrom,
      bulkMoveTo,
      bulkConflictPolicy,
      bulkClearSource,
      bulkPercentageEnabled,
      bulkPercentageBase,
      bulkPercentageTarget,
      bulkPercentageDirection,
      bulkPercentage,
      bulkExtractedMapping,
    ],
  );
  const bulkDirty = Boolean(bulkOpen && bulkBaseline && bulkStateFingerprint !== bulkBaseline);
  const hasBulkCatalogChanges = Boolean(
    bulkBrand.trim() ||
    bulkCategory.trim() ||
    bulkSupplier.trim() ||
    bulkPackageQuantity.trim() ||
    bulkPackageUnit.trim() ||
    bulkAvailability
  );
  const hasBulkPercentageChanges = Boolean(bulkPercentageEnabled);
  const hasBulkReassignChanges = Boolean(bulkMoveFrom || bulkMoveTo);
  const hasBulkExtractedChanges = Boolean(Object.values(bulkExtractedMapping).some((v) => Boolean(v)));

  function priceFieldCount(field: ImportPriceField | "") {
    return field ? bulkPriceCounts[field] : 0;
  }

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

  function requestReviewNavigation(proceed: () => void, description: string) {
    if (dirty) {
      setPendingReviewNavigation({ proceed, description });
      return;
    }
    proceed();
  }

  function confirmReviewNavigation() {
    const pending = pendingReviewNavigation;
    setPendingReviewNavigation(null);
    pending?.proceed();
  }

  function chooseRow(row: ProductImportRow) {
    requestReviewNavigation(() => {
      setActiveRowId(row.id);
      setMobilePanel("editor");
    }, `Open “${rowName(row)}” and discard the changes to the current product.`);
  }

  function restoreResolution(row: ProductImportRow) {
    if (row.comparisonStatus === "READY_NEW") return "CREATE_NEW" as const;
    if (row.comparisonStatus === "EXACT_DUPLICATE") return "KEEP_EXISTING" as const;
    return null;
  }

  function moveActiveRow(direction: -1 | 1) {
    if (!review || !activeRow) return;
    requestReviewNavigation(() => {
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
    }, `${direction < 0 ? "Open the previous product" : "Open the next product"} and discard the changes to “${rowName(activeRow)}”.`);
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
    if (draft.availabilityStatus !== "COMING_SOON" && !(Number(draft.ratePerPiece) > 0)) {
      showToast("danger", "Enter a Rate or mark this product as Coming soon.");
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

  function defaultBulkStateFingerprint() {
    return JSON.stringify({
      bulkBrand: "",
      bulkCategory: "",
      bulkSupplier: "",
      bulkPackageQuantity: "",
      bulkPackageUnit: "",
      bulkAvailability: "",
      bulkMoveFrom: "",
      bulkMoveTo: "",
      bulkConflictPolicy: "KEEP",
      bulkClearSource: false,
      bulkPercentageEnabled: false,
      bulkPercentageBase: "",
      bulkPercentageTarget: "",
      bulkPercentageDirection: "INCREASE",
      bulkPercentage: "",
      bulkExtractedMapping: {},
    });
  }

  function resetBulkEditState() {
    setBulkTab("catalog");
    setBulkBrand("");
    setBulkCategory("");
    setBulkSupplier("");
    setBulkPackageQuantity("");
    setBulkPackageUnit("");
    setBulkAvailability("");
    setBulkMoveFrom("");
    setBulkMoveTo("");
    setBulkConflictPolicy("KEEP");
    setBulkClearSource(false);
    setBulkPercentageEnabled(false);
    setBulkPercentageBase("");
    setBulkPercentageTarget("");
    setBulkPercentageDirection("INCREASE");
    setBulkPercentage("");
    setBulkExtractedMapping({});
    setBulkPreview(null);
    setDiffFilter("all");
    setDiffSearch("");
    setDiffPage(1);
  }

  async function openBulkEditPanel() {
    if (selectedCount === 0) {
      showToast("info", "Select at least one product before opening Bulk edit.");
      return;
    }
    resetBulkEditState();
    setBulkSelectedDrafts([]);
    setBulkDiscardOpen(false);
    setBulkBaseline(defaultBulkStateFingerprint());
    setBulkOpen(true);
    try {
      setBulkLoading(true);
      const rows = await loadSelectedRowsForBulkEdit();
      setBulkSelectedDrafts(rows.map((row) => draftPayload(importRowToDraft(review!.batch, row))));
      if (rows.length === 0) {
        showToast("info", "The selected products are no longer available in this review.");
        setBulkOpen(false);
      }
    } catch (bulkError: any) {
      setBulkOpen(false);
      showToast("danger", bulkError?.response?.data?.error || bulkError?.message || "Selected products could not be loaded for bulk editing.");
    } finally {
      setBulkLoading(false);
    }
  }

  function closeBulkEditNow() {
    setBulkDiscardOpen(false);
    setBulkOpen(false);
    setBulkPreview(null);
    setBulkSelectedDrafts([]);
  }

  function closeBulkEdit() {
    if (bulkSaving || bulkLoading) return;
    if (bulkDirty) {
      setBulkDiscardOpen(true);
      return;
    }
    closeBulkEditNow();
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
    if (bulkMoveFrom && priceFieldCount(bulkMoveFrom) === 0) {
      showToast("danger", "No selected product has a value in the chosen source price field.");
      return null;
    }

    let percentageConfig: ImportBulkEditConfig["percentage"] = null;
    if (bulkPercentageEnabled) {
      const percent = numberInput(bulkPercentage);
      if (!bulkPercentageBase || !bulkPercentageTarget) {
        showToast("danger", "Choose which price to calculate from and where to save the result.");
        return null;
      }
      if (bulkPercentageBase === bulkPercentageTarget) {
        showToast("danger", "The percentage base and target fields must be different.");
        return null;
      }
      if (priceFieldCount(bulkPercentageBase) === 0) {
        showToast("danger", "No selected product has that starting price. Choose a price that has a value.");
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
      availabilityStatus: bulkAvailability || undefined,
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
      || bulkAvailability
      || config.priceMove || config.percentage
      || hasBulkExtractedChanges
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
      let initialPayloads = before;

      if (hasBulkExtractedChanges) {
        initialPayloads = before.map((original) => {
          const next = { ...original };
          const rowObj = selectedRows.find((r) => r.id === original.rowId);
          const parsed = rowObj ? parsedImportRow(rowObj) : {};
          for (const [colKey, dest] of Object.entries(bulkExtractedMapping)) {
            if (!dest || !["ratePerPiece", "retailPrice", "wholesalePrice"].includes(dest)) continue;
            let val: number | null = null;
            if (Array.isArray((parsed as any).extractedPrices)) {
              const found = ((parsed as any).extractedPrices as any[]).find((p) => p && (p.key === colKey || p.label === colKey));
              if (found && Number.isFinite(Number(found.value)) && Number(found.value) > 0) val = Number(found.value);
            }
            if (val === null) {
              if (colKey === "sourceRatePerPiece" || colKey === "ratePerPiece" || colKey === "rate") {
                if (Number((parsed as any).ratePerPiece) > 0) val = Number((parsed as any).ratePerPiece);
              } else if (colKey === "sourceRetailPrice" || colKey === "retailPrice") {
                if (Number((parsed as any).retailPrice) > 0) val = Number((parsed as any).retailPrice);
              } else if (colKey === "sourceWholesalePrice" || colKey === "wholesalePrice") {
                if (Number((parsed as any).wholesalePrice) > 0) val = Number((parsed as any).wholesalePrice);
              } else if (Number((parsed as any)[colKey]) > 0) {
                val = Number((parsed as any)[colKey]);
              }
            }
            if (val !== null && val > 0) {
              (next as any)[dest] = val;
            }
          }
          return next;
        });
      }

      const results = initialPayloads.map((payload) => applyImportBulkEdit(payload, config));
      const missingRateRows = results.filter((result) =>
        result.payload.availabilityStatus !== "COMING_SOON"
        && !(Number(result.payload.ratePerPiece) > 0),
      ).length;
      if (missingRateRows > 0) {
        showToast(
          "danger",
          `${missingRateRows.toLocaleString()} selected product${missingRateRows === 1 ? " has" : "s have"} no Rate. Add a Rate or mark ${missingRateRows === 1 ? "it" : "them"} Coming soon.`,
        );
        return;
      }

      const previewItems: BulkEditPreviewItem[] = results.map((result, i) => {
        const orig = before[i];
        const changedFields = describeReviewPayloadChanges(orig, result.payload);
        let skipReason: string | undefined = undefined;
        if (result.skippedOperations > 0) {
          if (config.percentage && !hasPositivePrice(orig, config.percentage.base)) {
            skipReason = `Missing ${priceFieldLabel(config.percentage.base)} to calculate percentage`;
          } else if (config.priceMove && !hasPositivePrice(orig, config.priceMove.from)) {
            skipReason = `Missing ${priceFieldLabel(config.priceMove.from)} to move`;
          } else if (config.priceMove && config.priceMove.conflictPolicy === "KEEP" && hasPositivePrice(orig, config.priceMove.to)) {
            skipReason = `Existing ${priceFieldLabel(config.priceMove.to)} kept (conflict policy)`;
          } else {
            skipReason = "Operation skipped for this row";
          }
        }
        return {
          before: orig,
          after: result.payload,
          changedFields,
          skippedOperations: result.skippedOperations,
          priceConflict: result.priceConflict,
          skipReason,
        };
      });

      const changedRows = previewItems.filter((item) => item.changedFields.length > 0).length;
      if (changedRows === 0) {
        showToast("info", "The configured operation would not change any selected product.");
        return;
      }
      setDiffFilter("all");
      setDiffSearch("");
      setDiffPage(1);
      setBulkPreview({
        before,
        after: results.map((result) => result.payload),
        items: previewItems,
        fields: Array.from(new Set(previewItems.flatMap((item) => item.changedFields))),
        changedRows,
        skippedRows: previewItems.filter((item) => item.skippedOperations > 0).length,
        priceConflicts: previewItems.filter((item) => item.priceConflict).length,
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
      if (hasBulkExtractedChanges) {
        const targetIds = bulkPreview.after.map((r) => r.rowId);
        await setProductImportPriceMappingApi(
          review!.batch.id,
          bulkExtractedMapping as Record<string, "ratePerPiece" | "retailPrice" | "wholesalePrice">,
          targetIds,
        );
      }
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
    if (isPriceMappingUnchanged) {
      setPriceSetupOpen(false);
      return;
    }
    try {
      setPriceMappingBusy(true);
      await setProductImportPriceMappingApi(
        review.batch.id,
        mapping as Record<string, "ratePerPiece" | "retailPrice" | "wholesalePrice">,
      );
      await loadReview();
      setPriceSetupOpen(false);
      const changedColumns = columns.filter(
        (col) => (mapping[col.key] || "") !== (review.priceMapping.mapping[col.key] || "")
      );
      const changeSummary = changedColumns.length > 0
        ? changedColumns.map((col) => `${col.label} assigned to ${priceFieldDescription(mapping[col.key])}`).join(", ")
        : "mappings applied";
      showToast("success", `Updated price mapping: ${changeSummary}.`);
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

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (bulkDiscardOpen) {
          event.preventDefault();
          setBulkDiscardOpen(false);
          return;
        }
        if (bulkPreview) {
          event.preventDefault();
          setBulkPreview(null);
          return;
        }
        if (bulkOpen) {
          event.preventDefault();
          closeBulkEdit();
          return;
        }
        if (priceSetupOpen) {
          event.preventDefault();
          if (!priceMappingBusy) setPriceSetupOpen(false);
          return;
        }
        if (mobileMenuOpen) {
          event.preventDefault();
          setMobileMenuOpen(false);
          return;
        }
        return;
      }

      const target = event.target as HTMLElement | null;
      const isInput =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);

      if (isInput) return;

      if (
        bulkOpen ||
        priceSetupOpen ||
        bulkPreview ||
        bulkDiscardOpen ||
        commitOpen ||
        exitConfirmOpen ||
        sourceDetailsOpen ||
        pendingReviewNavigation ||
        mobileMenuOpen
      ) {
        return;
      }

      if (event.key === "ArrowDown" || event.key === "j") {
        event.preventDefault();
        moveActiveRow(1);
      } else if (event.key === "ArrowUp" || event.key === "k") {
        event.preventDefault();
        moveActiveRow(-1);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    bulkDiscardOpen,
    bulkPreview,
    bulkOpen,
    priceSetupOpen,
    priceMappingBusy,
    mobileMenuOpen,
    commitOpen,
    exitConfirmOpen,
    sourceDetailsOpen,
    pendingReviewNavigation,
    review,
    activeRow,
    dirty,
    bulkSaving,
    bulkLoading,
    bulkDirty,
  ]);

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
                className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-[#CFCFD3] bg-white px-2.5 text-[11px] font-bold text-[#11120d] transition hover:bg-[#F3F4F6]"
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
              <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-[#D8DBE0] bg-white">
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
                        <th scope="col" className="sticky left-0 z-20 overflow-hidden border-b border-r border-[#D8DBE0] bg-[#EFF2F5] px-2.5 py-2 font-extrabold">Row</th>
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
                            <td className={`sticky left-0 z-[5] overflow-hidden whitespace-nowrap border-b border-r border-[#E2E4E8] px-2.5 py-2 font-extrabold ${selected ? "bg-amber-100 text-amber-950" : "bg-white text-[#374151]"}`}>
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
            <div className="flex h-full min-h-0 items-center justify-center overflow-auto rounded-[10px] border border-[#D8DBE0] bg-white p-2">
              <div className="relative mx-auto w-[820px] max-w-none">
                <img src={sourcePreviewUrl} alt="Supplier catalog source" className="block h-auto w-full max-w-none object-contain" />
                {region ? (
                  <div
                    ref={sourceHighlightRef}
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
    return (
      <section className={`${mobilePanel === "editor" ? "flex" : "hidden"} h-full min-h-0 flex-col overflow-hidden rounded-[16px] border border-[#D8DBE0] bg-white xl:flex xl:rounded-[18px]`}>
        <div className="shrink-0 border-b border-[#E2E4E8] bg-white px-3.5 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setMobilePanel("list")}
                className="inline-flex h-8.5 w-8.5 shrink-0 items-center justify-center rounded-[8px] border border-[#D4D7DC] bg-white text-[#11120d] transition active:bg-[#F3F4F6] touch-manipulation xl:hidden"
                aria-label="Back to product list"
                title="Back to list"
              >
                <Icon name="arrow_back" sizePx={16} />
              </button>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-[14px] font-extrabold text-[#11120d]">Review item</h2>
                  <span className={`rounded-full border px-2.5 py-0.5 text-[9px] font-extrabold ${statusTone(draft.comparisonStatus)}`}>
                    {comparisonLabel(draft.comparisonStatus)}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-[11px] font-semibold text-[#7A7F89]">
                  {filteredPosition.toLocaleString()} of {review?.pagination.total.toLocaleString() || 0} · source row {draft.sourceLocator?.rowNumber || draft.rowNumber}
                </p>
              </div>
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
            <div className="grid grid-cols-2 gap-2.5">
              <div className="col-span-2">
                <Field label="Product name">
                  <input value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} className={inputClass} />
                </Field>
              </div>
              <div className="col-span-2">
                <Field label="SKU">
                  <input value={draft.sku} onChange={(event) => updateDraft("sku", event.target.value)} className={inputClass} />
                </Field>
              </div>
              <div>
                <Field label="Brand">
                  <CreatableCombobox value={draft.brand} onChange={(value) => updateDraft("brand", value)} options={brandOptions} placeholder="Search or enter brand" ariaLabel="Product brand" selectOnFocus compact showCreateHelp={false} />
                </Field>
              </div>
              <div>
                <Field label="Category">
                  <CreatableCombobox value={draft.category} onChange={(value) => { updateDraft("category", value); updateDraft("categoryGroup", value); }} options={categoryOptions} placeholder="Search or enter category" ariaLabel="Product category" selectOnFocus compact showCreateHelp={false} />
                </Field>
              </div>
              <div className="col-span-2">
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
            <label className="mb-2.5 flex items-center justify-between gap-3 rounded-[9px] border border-[#D4D7DC] bg-[#F8FAFC] px-2.5 py-2">
              <span className="min-w-0">
                <span className="block text-[11px] font-extrabold text-[#11120d]">Coming soon</span>
                <span className="block text-[9px] font-semibold leading-4 text-[#6B7280]">Rate can be added later. This product cannot be sold yet.</span>
              </span>
              <Switch
                checked={draft.availabilityStatus === "COMING_SOON"}
                onChange={(checked) => updateDraft("availabilityStatus", checked ? "COMING_SOON" : "CATALOG_LISTED")}
                ariaLabel="Coming soon"
              />
            </label>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Rate">
                <input type="number" value={draft.ratePerPiece ?? ""} onChange={(event) => updateDraft("ratePerPiece", numberInput(event.target.value))} disabled={Boolean(review?.priceMapping?.required && !review.priceMapping.complete)} className={`${inputClass} disabled:bg-[#F3F4F6] disabled:text-[#8C8889]`} placeholder={draft.availabilityStatus === "COMING_SOON" ? "Later" : "Rate"} />
              </Field>
              <Field label="Retail (opt)">
                <input type="number" value={draft.retailPrice ?? ""} onChange={(event) => updateDraft("retailPrice", numberInput(event.target.value))} disabled={Boolean(review?.priceMapping?.required && !review.priceMapping.complete)} className={`${inputClass} disabled:bg-[#F3F4F6] disabled:text-[#8C8889]`} placeholder="Pending" />
              </Field>
              <Field label="Wholesale (opt)">
                <input type="number" value={draft.wholesalePrice ?? ""} onChange={(event) => updateDraft("wholesalePrice", numberInput(event.target.value))} disabled={Boolean(review?.priceMapping?.required && !review.priceMapping.complete)} className={`${inputClass} disabled:bg-[#F3F4F6] disabled:text-[#8C8889]`} placeholder="Pending" />
              </Field>
            </div>
            {draft.availabilityStatus === "COMING_SOON" && !(review?.priceMapping?.required && !review.priceMapping.complete) ? (
              <div className="mt-2.5 rounded-[9px] border border-sky-200 bg-sky-50 px-2.5 py-2 text-[10px] font-bold text-sky-900">
                This product will remain searchable, but billing stays disabled until it is changed from Coming soon.
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
            className="inline-flex h-10 items-center justify-center gap-2 rounded-[9px] bg-[#11120d] px-5 text-[11px] font-extrabold text-white transition hover:bg-[#2a2c27] disabled:opacity-45"
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
      <header className="flex shrink-0 items-center justify-between gap-2 rounded-[14px] border border-[#D8DBE0] bg-white p-2 sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0">
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
            className="inline-flex h-11 items-center gap-1 rounded-[9px] bg-[#11120d] px-3 text-[11px] font-bold text-white transition hover:bg-[#2a2c27] disabled:opacity-40"
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
                !review.priceMapping.complete
                  ? "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
                  : "border-[#D4D7DC] bg-white text-[#374151] hover:bg-[#F3F4F6]"
              }`}
              title={!review.priceMapping.complete ? "Required: Map extracted price columns before final import" : "View or customize file column mapping definitions"}
            >
              <Icon name={!review.priceMapping.complete ? "warning" : "tune"} sizePx={16} className={!review.priceMapping.complete ? "text-amber-700" : "text-[#64748B]"} />
              <span className="hidden md:inline">{!review.priceMapping.complete ? "Map price columns" : "Column mapping"}</span>
              {!review.priceMapping.complete ? (
                <span className="rounded-full bg-amber-200/80 px-1.5 py-0.2 text-[9.5px] font-extrabold text-amber-900">
                  Required
                </span>
              ) : null}
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
            className="hidden h-10 items-center gap-2 rounded-[10px] bg-[#11120d] px-4 text-[12px] font-bold text-white transition hover:bg-[#2a2c27] disabled:opacity-40 sm:inline-flex"
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
                ? "bg-white text-[#11120d]"
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
                onChange={(event) => {
                  const value = event.target.value;
                  requestReviewNavigation(() => setSearchInput(value), "Change the product search and discard the changes to the current product.");
                }}
                placeholder="Search name, SKU or source row…"
                className="h-9 w-full rounded-[9px] border border-[#D4D7DC] pl-9 pr-9 text-[12px] font-semibold outline-none focus:border-[#11120d] xl:text-[11px]"
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={() => {
                    requestReviewNavigation(() => {
                      setSearchInput("");
                      setSearch("");
                    }, "Clear the product search and discard the changes to the current product.");
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-full text-[#7A7F89] hover:bg-slate-100 hover:text-[#11120d] transition"
                  aria-label="Clear search"
                >
                  <Icon name="close" sizePx={15} />
                </button>
              )}
            </div>

            {/* Clickable Interactive Stat Filter Rail */}
            <div className="flex gap-1.5 overflow-x-auto pb-0.5 touch-pan-x [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
                    onClick={() => requestReviewNavigation(() => { setFilter(item.value as any); setPage(1); }, `Open the ${item.label} list and discard the changes to the current product.`)}
                    className={`inline-flex h-8.5 shrink-0 items-center gap-1.5 rounded-[9px] border px-3 text-[11px] font-extrabold transition touch-manipulation active:scale-[0.97] ${
                      active
                        ? "border-[#11120d] bg-[#11120d] text-white"
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

            <div className="flex min-h-[38px] items-center justify-between gap-2 text-[11px] font-extrabold text-[#5F6570]">
              <label className="inline-flex min-h-[38px] cursor-pointer items-center gap-2 py-1 px-1 -ml-1 rounded-lg transition hover:bg-slate-100 active:bg-slate-200 touch-manipulation select-none">
                <input type="checkbox" checked={allPageRowsSelected} onChange={togglePageSelection} className="h-4.5 w-4.5 rounded accent-[#11120d]" />
                <span>Select page</span>
              </label>
              {review && review.pagination.total > 0 ? (
                allMatchingSelected ? (
                  <button type="button" onClick={clearSelection} className="inline-flex min-h-[38px] items-center px-1.5 font-bold text-[#11120d] hover:underline active:bg-slate-100 touch-manipulation">
                    All {selectedCount.toLocaleString()} selected · Clear
                  </button>
                ) : (
                  <button type="button" onClick={() => { setAllMatchingSelected(true); setSelectedIds(new Set()); setExcludedSelectedIds(new Set()); }} className="inline-flex min-h-[38px] items-center px-1.5 font-bold text-[#11120d] hover:underline active:bg-slate-100 touch-manipulation">
                    Select all {review.pagination.total.toLocaleString()}
                  </button>
                )
              ) : null}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain divide-y divide-[#E8EAED]">
            {loading ? (
              <div className="p-6 text-center text-[12px] font-extrabold text-[#7A7F89]">Loading rows…</div>
            ) : review?.rows.length ? (
              review.rows.map((row) => {
                const selected = allMatchingSelected ? !excludedSelectedIds.has(row.id) : selectedIds.has(row.id);
                const active = row.id === activeRowId;
                const ignored = row.resolution === "IGNORE";
                const rowBgClass = active && selected
                  ? "border-l-[3px] border-l-[#11120d] bg-[#EDF3FA]"
                  : active
                    ? "border-l-[3px] border-l-[#11120d] bg-[#F1F3F5]"
                    : selected
                      ? "border-l-[3px] border-l-blue-400 bg-blue-50/40 hover:bg-blue-50/60"
                      : ignored
                        ? "border-l-[3px] border-l-transparent bg-rose-50/40"
                        : "border-l-[3px] border-l-transparent bg-white hover:bg-[#F8FAFC]";

                return (
                  <div
                    key={row.id}
                    className={`flex min-h-[64px] items-stretch transition ${rowBgClass}`}
                  >
                    {/* Checkbox Tap Zone: Dedicated 48px wide touch target */}
                    <label
                      className="flex w-12 shrink-0 self-stretch cursor-pointer items-center justify-center touch-manipulation select-none active:bg-black/[0.06]"
                      onClick={(e) => e.stopPropagation()}
                      title="Select for bulk editing"
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleRowSelection(row.id)}
                        className="h-5 w-5 rounded-[5px] accent-[#11120d] cursor-pointer"
                        aria-label={`Select ${rowName(row)} for bulk editing`}
                      />
                    </label>

                    {/* Product Row Hit Target: 100% of the rest of the row is a single, continuous button */}
                    <button
                      type="button"
                      onClick={() => chooseRow(row)}
                      className="flex min-w-0 flex-1 items-center justify-between gap-2.5 py-2.5 pr-2.5 text-left touch-manipulation select-none active:bg-black/[0.04] focus:outline-none"
                      aria-label={`Review ${rowName(row)}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className={`truncate text-[13px] font-extrabold leading-snug sm:text-[12px] xl:text-[11.5px] ${ignored ? "text-[#7A7F89] line-through" : "text-[#11120d]"}`}>
                          {rowName(row)}
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[10.5px] font-semibold text-[#7A7F89] xl:text-[9.5px]">
                          {rowSku(row)}
                        </div>
                      </div>

                      <div className="flex shrink-0 flex-col items-end justify-center gap-1 min-w-[76px] text-right">
                        <span className={`text-[12px] font-bold tabular-nums sm:text-[11px] ${ignored ? "text-[#7A7F89] line-through" : "text-[#11120d]"}`}>
                          {rowRate(row)}
                        </span>
                        <div className="flex items-center gap-1">
                          {ignored ? (
                            <span className="inline-flex h-5 items-center justify-center rounded-full border border-rose-200 bg-rose-50 px-1.5 text-[8.5px] font-extrabold text-rose-700" title="Ignored">
                              Ignored
                            </span>
                          ) : (
                            <span className={`inline-flex rounded-full border px-1.5 py-0.2 text-[8.5px] font-extrabold ${statusTone(row.comparisonStatus)}`}>
                              {comparisonLabel(row.comparisonStatus)}
                            </span>
                          )}
                          <Icon name="chevron_right" sizePx={16} className="text-[#9CA3AF]" />
                        </div>
                      </div>
                    </button>
                  </div>
                );
              })
            ) : (
              <div className="p-6 text-center text-[12px] font-bold text-[#7A7F89]">No rows match this filter.</div>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[#E2E4E8] bg-white p-2.5 text-[10px] font-bold text-[#5F6570]">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 whitespace-nowrap text-[10px] sm:text-[11px]">{review ? `${pageRangeStart.toLocaleString()}–${pageRangeEnd.toLocaleString()} of ${review.pagination.total.toLocaleString()}` : "0 rows"}</span>
              <ProjectSelect className="h-9 w-[104px] shrink-0" value={String(pageSize)} onChange={(event) => { const value = Number(event.target.value); requestReviewNavigation(() => { setPage(1); setPageSize(value); }, "Change the number of products shown and discard the current unsaved changes."); }} aria-label="Rows per page">
                <option value="25">25 rows</option>
                <option value="50">50 rows</option>
                <option value="100">100 rows</option>
              </ProjectSelect>
            </div>
            <nav className="flex items-center gap-1.5" aria-label="Import rows pagination">
              <button type="button" disabled={!review || review.pagination.page <= 1} onClick={() => requestReviewNavigation(() => setPage((value) => Math.max(1, value - 1)), "Open the previous product page and discard the current unsaved changes.")} className="inline-flex h-9 w-9 items-center justify-center rounded-[8px] border border-[#D4D7DC] bg-white text-[#11120d] transition active:bg-[#F3F4F6] disabled:opacity-35 touch-manipulation" title="Previous page" aria-label="Previous page"><Icon name="chevron_left" sizePx={18} /></button>
              <span className="min-w-[54px] whitespace-nowrap text-center text-[9.5px] font-extrabold text-[#374151]">Page {review?.pagination.page || 1} of {review?.pagination.totalPages || 1}</span>
              <button type="button" disabled={!review || review.pagination.page >= review.pagination.totalPages} onClick={() => requestReviewNavigation(() => setPage((value) => value + 1), "Open the next product page and discard the current unsaved changes.")} className="inline-flex h-9 w-9 items-center justify-center rounded-[8px] border border-[#D4D7DC] bg-white text-[#11120d] transition active:bg-[#F3F4F6] disabled:opacity-35 touch-manipulation" title="Next page" aria-label="Next page"><Icon name="chevron_right" sizePx={18} /></button>
            </nav>
          </div>
        </section>

        <div className={`${mobilePanel === "editor" ? "block" : "hidden"} h-full min-h-0 xl:block`}>{renderEditor()}</div>
        <div className={`${mobilePanel === "source" ? "block" : "hidden"} h-full min-h-0 xl:block`}>{renderSourcePanel()}</div>
      </main>

      {/* Bulk Selection Bar: Clean Single-Line, Docked without Covering Pagination */}
      {selectedCount > 0 ? (
        <div className="shrink-0 flex items-center justify-between gap-3 rounded-[14px] border border-[#D8DBE0] bg-white px-3.5 py-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-[#11120d] px-1.5 text-[11px] font-extrabold text-white">
              {selectedCount.toLocaleString()}
            </span>
            <span className="truncate text-xs font-bold text-[#11120d]">
              selected{allMatchingSelected ? " across all pages" : ""}
            </span>
            <span className="text-[#C4C8D0]">·</span>
            <button
              type="button"
              onClick={clearSelection}
              className="inline-flex min-h-[36px] items-center px-1.5 text-xs font-bold text-[#64748B] hover:text-[#11120d] hover:underline transition shrink-0 touch-manipulation active:bg-slate-100 rounded-md"
            >
              Clear
            </button>
          </div>
          <button
            type="button"
            onClick={() => void openBulkEditPanel()}
            className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-[#11120d] px-4 text-xs font-extrabold text-white transition hover:bg-[#2a2c27] touch-manipulation active:scale-[0.98]"
          >
            <Icon name="edit" sizePx={15} />
            <span>Bulk edit ({selectedCount.toLocaleString()})</span>
          </button>
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
            {review?.priceMapping.required ? (
              <button
                type="button"
                onClick={() => { setMobileMenuOpen(false); setPriceSetupOpen(true); }}
                className={`flex h-12 w-full items-center justify-between rounded-[10px] border px-3.5 text-[12px] font-bold transition ${
                  !review.priceMapping.complete
                    ? "border-amber-300 bg-amber-50/70 text-amber-950 hover:bg-amber-100/70"
                    : "border-[#E2E4E8] bg-white text-[#11120d] hover:bg-[#F8F9FA]"
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon
                    name={!review.priceMapping.complete ? "warning" : "tune"}
                    sizePx={18}
                    className={!review.priceMapping.complete ? "text-amber-700" : "text-[#64748B]"}
                  />
                  <div className="text-left">
                    <div className="leading-tight">File price column mapping</div>
                    <div className="text-[10px] font-normal text-[#64748B]">
                      {review.priceMapping.complete
                        ? "View or customize price field assignments"
                        : "Map CSV columns to Rate, Retail & Wholesale"}
                    </div>
                  </div>
                </span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold ${review.priceMapping.complete ? "bg-emerald-50 text-emerald-800 border border-emerald-200" : "bg-amber-100 text-amber-900 border border-amber-300"}`}>
                  {review.priceMapping.complete ? "Active" : "Required"}
                </span>
              </button>
            ) : null}

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
          <section className="relative z-10 w-full max-w-[500px] rounded-t-[22px] border border-[#D8DBE0] bg-white p-5 sm:rounded-[20px]">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#F1F3F5] text-[#11120d]"><Icon name={historyPrompt.direction === "undo" ? "undo" : "redo"} sizePx={22} /></span>
              <div className="min-w-0"><h2 className="text-[18px] font-extrabold text-[#11120d]">{historyPrompt.direction === "undo" ? "Undo this saved change?" : "Redo this saved change?"}</h2><p className="mt-1 text-[11px] font-semibold leading-5 text-[#68707C]">{historyPrompt.entry.label}</p></div>
            </div>
            <div className="mt-4 rounded-[11px] border border-[#D8DBE0] bg-[#F8F9FA] px-3 py-2.5 text-[10px] font-semibold leading-4 text-[#5F6570]">This changes {historyPrompt.entry.before.length.toLocaleString()} saved review row{historyPrompt.entry.before.length === 1 ? "" : "s"}. It does not change products that were already final-imported. This undo history lasts only for the current review session.</div>
            <div className="mt-5 grid grid-cols-2 gap-2"><button type="button" onClick={() => setHistoryPrompt(null)} disabled={historyBusy} className="h-11 rounded-[11px] border border-[#D4D7DC] text-[11px] font-extrabold">Cancel</button><button type="button" onClick={() => void applyHistoryAction()} disabled={historyBusy} className="inline-flex h-11 items-center justify-center gap-2 rounded-[11px] bg-[#11120d] text-[11px] font-extrabold text-white disabled:opacity-45"><Icon name={historyPrompt.direction === "undo" ? "undo" : "redo"} sizePx={17} />{historyBusy ? "Applying…" : historyPrompt.direction === "undo" ? "Undo saved change" : "Redo saved change"}</button></div>
          </section>
        </div>
      ) : null}

      {/* File Price Column Mapping Modal */}
      {priceSetupOpen && review?.priceMapping.required ? (
        <div className="fixed inset-0 z-[72] flex items-end justify-center bg-slate-950/40 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="File price column mapping">
          <button type="button" className="absolute inset-0 cursor-default" onClick={() => !priceMappingBusy && setPriceSetupOpen(false)} aria-label="Close column mapping" />
          <section className="relative z-10 w-full max-w-[500px] rounded-t-[20px] sm:rounded-2xl border border-[#D8DBE0] bg-white overflow-hidden">
            <header className="flex items-start justify-between gap-3 border-b border-[#D8DBE0] p-4.5">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-extrabold text-[#11120d]">File Price Column Mapping</h2>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-extrabold ${
                    review.priceMapping.complete
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border-amber-200 bg-amber-50 text-amber-900"
                  }`}>
                    {review.priceMapping.complete ? "Active & Applied" : "Required to import"}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-[#64748B]">
                  Assign extracted columns from your imported file to product price fields (Rate, Retail, Wholesale). Active mappings are applied across all products in this batch.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPriceSetupOpen(false)}
                disabled={priceMappingBusy}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#D4D7DC] text-[#64748B] hover:bg-[#F3F4F6] hover:text-[#11120d] transition"
                aria-label="Close column mapping"
              >
                <Icon name="close" sizePx={16} />
              </button>
            </header>

            <div className="grid gap-3 p-4.5 max-h-[70vh] overflow-y-auto">
              {review.priceMapping.columns.map((column) => {
                const details = getPriceColumnDetails(column.key, review.rows, null);
                const savedDestination = review.priceMapping.mapping[column.key] || "";
                const currentDraftDestination = priceMappingDraft[column.key] || "";
                const isColumnUnchanged = savedDestination === currentDraftDestination && Boolean(savedDestination);

                return (
                  <div key={column.key} className="rounded-xl border border-[#D8DBE0] bg-[#F8F9FA] p-3.5 space-y-2.5">
                    <div className="flex items-start justify-between gap-2 flex-wrap">
                      <div>
                        <div className="text-[10px] font-extrabold uppercase tracking-wider text-[#64748B]">Extracted Column</div>
                        <div className="text-sm font-extrabold text-[#11120d] mt-0.5">{column.label}</div>
                      </div>
                      <div className="text-right">
                        {details.sample ? (
                          <div className="inline-flex items-center gap-1.5 rounded-lg border border-[#D8DBE0] bg-white px-2.5 py-1 text-xs font-semibold text-[#11120d]">
                            <span className="text-[#64748B]">Sample:</span>
                            <strong className="text-[#11120d]">NPR {details.sample.value.toLocaleString()}</strong>
                          </div>
                        ) : (
                          <span className="text-xs text-[#94A3B8]">No values found in batch</span>
                        )}
                      </div>
                    </div>

                    {details.sample && (
                      <div className="text-[11px] text-[#64748B]">
                        Found in imported data{details.sample.name ? ` (e.g. “${details.sample.name}”)` : ""}
                      </div>
                    )}

                    {/* Active / Remap Status Indicator */}
                    {isColumnUnchanged ? (
                      <div className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50/80 px-2.5 py-1.5 text-[11px] font-medium text-emerald-900">
                        <Icon name="check" sizePx={14} className="text-emerald-700 shrink-0" />
                        <span>
                          Currently active as <strong className="font-bold">{priceFieldDescription(savedDestination)}</strong> across all products.
                        </span>
                      </div>
                    ) : currentDraftDestination ? (
                      <div className="flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-[11px] font-medium text-blue-900">
                        <Icon name="swap_horiz" sizePx={14} className="text-blue-700 shrink-0" />
                        <span>
                          Will reassign from <strong>{priceFieldDescription(savedDestination)}</strong> to <strong className="font-bold">{priceFieldDescription(currentDraftDestination)}</strong> across all products.
                        </span>
                      </div>
                    ) : null}

                    <Field label="Assign this column to">
                      <ProjectSelect
                        value={currentDraftDestination}
                        onChange={(event) => setPriceMappingDraft((current) => ({ ...current, [column.key]: event.target.value }))}
                        className="h-10 w-full"
                        aria-label={`Assign ${column.label}`}
                      >
                        <option value="">Choose price type</option>
                        <option value="ratePerPiece">Rate (Cost price)</option>
                        <option value="retailPrice">Retail price</option>
                        <option value="wholesalePrice">Wholesale price</option>
                      </ProjectSelect>
                    </Field>
                  </div>
                );
              })}

              {review.priceMapping.columns.length > 0 && !Object.values(priceMappingDraft).includes("ratePerPiece") ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-xs text-amber-950 flex items-start gap-2.5">
                  <Icon name="warning" sizePx={18} className="text-amber-700 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <div className="font-extrabold text-amber-900">
                      Rate (Cost price) will be unmapped
                    </div>
                    <p className="text-[11.5px] leading-relaxed text-amber-800">
                      {review.priceMapping.columns.length === 1
                        ? `You are mapping your file’s only price column to ${priceFieldDescription(priceMappingDraft[review.priceMapping.columns[0].key] || "")}. Standard products require a Rate (Cost price) before they can be finalized for import.`
                        : "None of your file columns are currently assigned to Rate (Cost price). Standard products require a cost Rate before they can be finalized for import."}
                    </p>
                  </div>
                </div>
              ) : null}
            </div>

            <footer className="grid grid-cols-[auto_1fr] gap-2.5 border-t border-[#D8DBE0] p-4">
              <button
                type="button"
                onClick={() => setPriceSetupOpen(false)}
                disabled={priceMappingBusy}
                className="h-10 rounded-xl border border-[#D4D7DC] px-4 text-xs font-extrabold text-[#374151] hover:bg-[#F3F4F6]"
              >
                {isPriceMappingUnchanged ? "Close" : "Cancel"}
              </button>
              <button
                type="button"
                onClick={() => void savePriceMapping()}
                disabled={priceMappingBusy || isPriceMappingUnchanged || !hasValidPriceMappingDraft}
                className={`inline-flex h-10 items-center justify-center gap-2 rounded-xl px-4 text-xs font-extrabold transition ${
                  isPriceMappingUnchanged
                    ? "border border-[#E2E4E8] bg-[#F1F3F5] text-[#868E96] cursor-not-allowed"
                    : "bg-[#11120d] text-white hover:bg-[#2a2c27] disabled:opacity-45"
                }`}
              >
                <Icon name={isPriceMappingUnchanged ? "check" : "save"} sizePx={16} />
                <span>
                  {priceMappingBusy
                    ? "Saving & applying…"
                    : isPriceMappingUnchanged
                      ? "Mapping is up to date"
                      : "Save & apply new mapping"}
                </span>
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {/* Bulk Edit Drawer */}
      {bulkOpen ? (
        <div className="fixed inset-0 z-[70] flex items-end justify-end bg-slate-950/40 backdrop-blur-[2px] sm:items-stretch" role="dialog" aria-modal="true" aria-label="Bulk edit selected import rows">
          <button type="button" className="absolute inset-0 cursor-default" onClick={closeBulkEdit} aria-label="Close bulk editor" />
          <aside className="relative z-10 flex flex-col h-[92dvh] w-full bg-[#F8F9FA] rounded-t-[20px] sm:h-full sm:max-h-none sm:w-[480px] lg:w-[500px] sm:rounded-none sm:border-l sm:border-[#D8DBE0] overflow-hidden">
            {/* Header */}
            <div className="sticky top-0 z-20 flex items-center justify-between border-b border-[#D8DBE0] bg-white px-5 py-3.5">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-extrabold text-[#11120d]">Bulk Edit</h2>
                  <span className="rounded-full border border-[#D8DBE0] bg-[#F1F3F5] px-2.5 py-0.5 text-[11px] font-bold text-[#11120d]">
                    {selectedCount.toLocaleString()} selected
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-[#64748B]">
                  Apply updates across selection. To update the entire batch, select all products across the catalog.
                </p>
              </div>
              <button
                type="button"
                onClick={closeBulkEdit}
                disabled={bulkSaving}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#D4D7DC] text-[#64748B] hover:bg-[#F3F4F6] hover:text-[#11120d] transition"
                aria-label="Close bulk editor"
              >
                <Icon name="close" sizePx={16} />
              </button>
            </div>

            {/* Inventory Price Presence Bar */}
            <div className="border-b border-[#E2E4E8] bg-white px-5 py-2.5">
              {bulkLoading ? (
                <div className="flex items-center gap-2 text-xs font-bold text-[#334155]">
                  <Icon name="refresh" sizePx={14} className="animate-spin text-[#64748B]" />
                  <span>Loading selection values…</span>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-[#64748B]">Prices present:</span>
                  <span className="inline-flex items-center gap-1 rounded-md border border-[#D8DBE0] bg-[#F8F9FA] px-2 py-0.5 text-xs font-medium text-[#334155]">
                    Rate: <strong className="text-[#11120d] font-bold">{bulkPriceCounts.ratePerPiece}</strong>
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-md border border-[#D8DBE0] bg-[#F8F9FA] px-2 py-0.5 text-xs font-medium text-[#334155]">
                    Retail: <strong className="text-[#11120d] font-bold">{bulkPriceCounts.retailPrice}</strong>
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-md border border-[#D8DBE0] bg-[#F8F9FA] px-2 py-0.5 text-xs font-medium text-[#334155]">
                    Wholesale: <strong className="text-[#11120d] font-bold">{bulkPriceCounts.wholesalePrice}</strong>
                  </span>
                  {bulkPriceCounts.any === 0 ? (
                    <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-900">
                      No prices present
                    </span>
                  ) : null}
                </div>
              )}
            </div>

            {/* Tab Navigation */}
            <div className="border-b border-[#E2E4E8] bg-[#F8F9FA] px-5 py-2.5">
              <nav className="flex rounded-xl border border-[#D8DBE0] bg-white p-1 gap-1" aria-label="Bulk edit tabs">
                <button
                  type="button"
                  onClick={() => setBulkTab("catalog")}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-bold transition ${
                    bulkTab === "catalog"
                      ? "bg-[#11120d] text-white"
                      : "text-[#64748B] hover:text-[#11120d] hover:bg-[#F1F3F5]"
                  }`}
                >
                  <span>Catalog</span>
                  {hasBulkCatalogChanges && (
                    <span className={`h-2 w-2 rounded-full ${bulkTab === "catalog" ? "bg-amber-400" : "bg-blue-600"}`} title="Changes configured" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setBulkTab("percentage")}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-bold transition ${
                    bulkTab === "percentage"
                      ? "bg-[#11120d] text-white"
                      : "text-[#64748B] hover:text-[#11120d] hover:bg-[#F1F3F5]"
                  }`}
                >
                  <span>Calculation</span>
                  {hasBulkPercentageChanges && (
                    <span className={`h-2 w-2 rounded-full ${bulkTab === "percentage" ? "bg-amber-400" : "bg-blue-600"}`} title="Calculation active" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setBulkTab("reassign")}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-bold transition ${
                    bulkTab === "reassign"
                      ? "bg-[#11120d] text-white"
                      : "text-[#64748B] hover:text-[#11120d] hover:bg-[#F1F3F5]"
                  }`}
                >
                  <span>Move / Swap</span>
                  {hasBulkReassignChanges && (
                    <span className={`h-2 w-2 rounded-full ${bulkTab === "reassign" ? "bg-amber-400" : "bg-blue-600"}`} title="Reassignment configured" />
                  )}
                </button>
                {review?.priceMapping.required ? (
                  <button
                    type="button"
                    onClick={() => setBulkTab("extracted")}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-bold transition ${
                      bulkTab === "extracted"
                        ? "bg-[#11120d] text-white"
                        : "text-[#64748B] hover:text-[#11120d] hover:bg-[#F1F3F5]"
                    }`}
                  >
                    <span>Extracted</span>
                    {hasBulkExtractedChanges && (
                      <span className={`h-2 w-2 rounded-full ${bulkTab === "extracted" ? "bg-amber-400" : "bg-blue-600"}`} title="Extracted mapping configured" />
                    )}
                  </button>
                ) : null}
              </nav>
            </div>

            {/* Scrollable Tab Content Body */}
            <div className="flex-1 overflow-y-auto p-5 pb-6 space-y-4">
              {/* Tab 1: Catalog Details */}
              {bulkTab === "catalog" && (
                <div className="space-y-4">
                  {/* Organization Section */}
                  <div className="rounded-xl border border-[#D8DBE0] bg-white p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <div>
                        <h3 className="text-xs font-extrabold uppercase tracking-wider text-[#64748B]">Taxonomy & Organization</h3>
                        <p className="mt-0.5 text-xs font-medium text-[#11120d]">Assign standard brand, category, or supplier to selected products.</p>
                      </div>
                      <span className="rounded-full bg-[#F1F3F5] px-2 py-0.5 text-[10px] font-bold text-[#64748B] border border-[#E2E4E8]">Optional</span>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Brand">
                        <CreatableCombobox
                          value={bulkBrand}
                          onChange={setBulkBrand}
                          options={brandOptions}
                          placeholder="Keep current brand"
                          ariaLabel="Bulk brand"
                          selectOnFocus
                          compact
                          showCreateHelp={false}
                        />
                      </Field>
                      <Field label="Category">
                        <CreatableCombobox
                          value={bulkCategory}
                          onChange={setBulkCategory}
                          options={categoryOptions}
                          placeholder="Keep current category"
                          ariaLabel="Bulk category"
                          selectOnFocus
                          compact
                          showCreateHelp={false}
                        />
                      </Field>
                      <div className="sm:col-span-2">
                        <Field label="Supplier / Vendor">
                          <CreatableCombobox
                            value={bulkSupplier}
                            onChange={setBulkSupplier}
                            options={supplierOptions}
                            placeholder="Keep current supplier"
                            ariaLabel="Bulk supplier"
                            selectOnFocus
                            compact
                            showCreateHelp={false}
                          />
                        </Field>
                      </div>
                    </div>
                  </div>

                  {/* Packaging Section */}
                  <div className="rounded-xl border border-[#D8DBE0] bg-white p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <div>
                        <h3 className="text-xs font-extrabold uppercase tracking-wider text-[#64748B]">Packaging & Units</h3>
                        <p className="mt-0.5 text-xs font-medium text-[#11120d]">Set standard pack sizes across selected items.</p>
                      </div>
                      <span className="rounded-full bg-[#F1F3F5] px-2 py-0.5 text-[10px] font-bold text-[#64748B] border border-[#E2E4E8]">Optional</span>
                    </div>
                    <div className="grid gap-3 grid-cols-2">
                      <Field label="Package quantity">
                        <input
                          type="number"
                          value={bulkPackageQuantity}
                          onChange={(event) => setBulkPackageQuantity(event.target.value)}
                          className={inputClass}
                          placeholder="Keep current"
                        />
                      </Field>
                      <Field label="Package unit">
                        <CreatableCombobox
                          value={bulkPackageUnit}
                          onChange={(value) => setBulkPackageUnit(value.toUpperCase())}
                          options={unitOptions}
                          placeholder="Keep current (e.g. PCS)"
                          ariaLabel="Bulk package unit"
                          selectOnFocus
                          compact
                          showCreateHelp={false}
                        />
                      </Field>
                    </div>
                  </div>

                  {/* Availability Section */}
                  <div className="rounded-xl border border-[#D8DBE0] bg-white p-4">
                    <div className="mb-3">
                      <h3 className="text-xs font-extrabold uppercase tracking-wider text-[#64748B]">Product Availability</h3>
                      <p className="mt-0.5 text-xs font-medium text-[#11120d]">Determine catalog status and whether a Rate is required.</p>
                    </div>
                    <div className="grid gap-2">
                      {([
                        ["", "Keep current", "Leave existing availability status unchanged"],
                        ["CATALOG_LISTED", "Normal product", "Ready for catalog; a valid Rate is required"],
                        ["COMING_SOON", "Coming soon", "Rate added later; product cannot be sold yet"],
                      ] as const).map(([value, label, help]) => (
                        <label
                          key={value || "unchanged"}
                          className={`flex items-start justify-between gap-3 p-3 rounded-xl border cursor-pointer transition ${
                            bulkAvailability === value
                              ? "border-[#11120d] bg-[#F5F6F8] ring-1 ring-[#11120d]"
                              : "border-[#D8DBE0] bg-white hover:border-[#BFC3CB]"
                          }`}
                        >
                          <div>
                            <strong className="text-xs font-bold text-[#11120d] block">{label}</strong>
                            <span className="text-[11px] text-[#64748B] leading-snug">{help}</span>
                          </div>
                          <input
                            type="radio"
                            name="bulk-availability"
                            checked={bulkAvailability === value}
                            onChange={() => setBulkAvailability(value)}
                            className="accent-[#11120d] h-4 w-4 shrink-0 mt-0.5"
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 2: Price Calculation */}
              {bulkTab === "percentage" && (
                <div className="space-y-4">
                  {/* Master Enable Card */}
                  <div className="rounded-xl border border-[#D8DBE0] bg-white p-4">
                    <label className={`flex items-center justify-between gap-3 ${bulkPriceCounts.any === 0 ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}>
                      <div>
                        <h3 className="text-sm font-extrabold text-[#11120d]">Calculate price by percentage</h3>
                        <p className="mt-0.5 text-xs text-[#64748B]">
                          Automatically adjust prices by applying a percentage markup or markdown.
                        </p>
                      </div>
                      <div className="relative inline-flex items-center">
                        <input
                          type="checkbox"
                          disabled={bulkPriceCounts.any === 0 || bulkLoading}
                          checked={bulkPercentageEnabled}
                          onChange={(event) => setBulkPercentageEnabled(event.target.checked)}
                          className="sr-only peer"
                          aria-label="Enable percentage markup or markdown"
                        />
                        <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#11120d]" />
                      </div>
                    </label>

                    {bulkPriceCounts.any === 0 && !bulkLoading && (
                      <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs font-medium text-amber-950">
                        Percentage calculation is unavailable because none of the selected products have any existing prices.
                      </div>
                    )}
                  </div>

                  {/* Form Fields when enabled */}
                  <div className={`rounded-xl border border-[#D8DBE0] bg-white p-4 space-y-4 transition ${bulkPercentageEnabled ? "" : "opacity-40 pointer-events-none"}`}>
                    <div className="grid gap-3 grid-cols-2">
                      <Field label="Calculate from (Base price)">
                        <ProjectSelect
                          disabled={!bulkPercentageEnabled}
                          value={bulkPercentageBase}
                          onChange={(event) => setBulkPercentageBase(event.target.value as ImportPriceField | "")}
                          className="h-10 w-full"
                        >
                          <option value="">Choose base price</option>
                          <option value="ratePerPiece" disabled={bulkPriceCounts.ratePerPiece === 0}>
                            Rate ({bulkPriceCounts.ratePerPiece} available)
                          </option>
                          <option value="retailPrice" disabled={bulkPriceCounts.retailPrice === 0}>
                            Retail price ({bulkPriceCounts.retailPrice} available)
                          </option>
                          <option value="wholesalePrice" disabled={bulkPriceCounts.wholesalePrice === 0}>
                            Wholesale price ({bulkPriceCounts.wholesalePrice} available)
                          </option>
                        </ProjectSelect>
                      </Field>

                      <Field label="Save result to (Target field)">
                        <ProjectSelect
                          disabled={!bulkPercentageEnabled}
                          value={bulkPercentageTarget}
                          onChange={(event) => setBulkPercentageTarget(event.target.value as ImportPriceField | "")}
                          className="h-10 w-full"
                        >
                          <option value="">Choose target field</option>
                          <option value="ratePerPiece">Rate</option>
                          <option value="retailPrice">Retail price</option>
                          <option value="wholesalePrice">Wholesale price</option>
                        </ProjectSelect>
                      </Field>
                    </div>

                    {bulkPercentageEnabled && bulkPercentageBase && priceFieldCount(bulkPercentageBase) === 0 && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs font-medium text-amber-900">
                        No selected product has a value for {priceFieldLabel(bulkPercentageBase)}. Choose a price with values.
                      </div>
                    )}

                    {bulkPercentageEnabled && bulkPercentageBase && priceFieldCount(bulkPercentageBase) > 0 && (
                      <div className="rounded-lg border border-blue-200 bg-blue-50/70 p-2.5 text-xs font-medium text-blue-900">
                        {priceFieldCount(bulkPercentageBase)} product{priceFieldCount(bulkPercentageBase) === 1 ? " has" : "s have"} a {priceFieldLabel(bulkPercentageBase)}. Products without this price will be skipped.
                      </div>
                    )}

                    {/* Adjustment type and Percentage side-by-side with rigid fixed width */}
                    <div className="grid grid-cols-[1fr_115px] gap-2.5 items-end">
                      <Field label="Adjustment type">
                        <div className="grid grid-cols-2 rounded-xl border border-[#D4D7DC] bg-[#F1F3F5] p-1 gap-1">
                          <button
                            type="button"
                            disabled={!bulkPercentageEnabled}
                            onClick={() => setBulkPercentageDirection("INCREASE")}
                            className={`h-9 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 ${
                              bulkPercentageDirection === "INCREASE"
                                ? "bg-white text-emerald-800 border border-emerald-200"
                                : "text-[#64748B] hover:text-[#11120d]"
                            }`}
                          >
                            <Icon name="add" sizePx={15} />
                            <span>Increase</span>
                          </button>
                          <button
                            type="button"
                            disabled={!bulkPercentageEnabled}
                            onClick={() => setBulkPercentageDirection("DECREASE")}
                            className={`h-9 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 ${
                              bulkPercentageDirection === "DECREASE"
                                ? "bg-white text-rose-800 border border-rose-200"
                                : "text-[#64748B] hover:text-[#11120d]"
                            }`}
                          >
                            <Icon name="remove" sizePx={15} />
                            <span>Decrease</span>
                          </button>
                        </div>
                      </Field>

                      <Field label="Percentage">
                        <label className="flex h-11 items-center rounded-xl border border-[#D4D7DC] bg-white px-3 focus-within:border-[#11120d]">
                          <input
                            disabled={!bulkPercentageEnabled}
                            type="number"
                            min="0.01"
                            max="100"
                            step="0.01"
                            value={bulkPercentage}
                            onChange={(event) => setBulkPercentage(event.target.value)}
                            className="min-w-0 flex-1 bg-transparent text-right text-xs font-bold outline-none"
                            placeholder="0"
                          />
                          <span className="ml-1 text-xs font-bold text-[#64748B]">%</span>
                        </label>
                      </Field>
                    </div>

                    {/* Formula Preview Card: Restored Blue & Emerald Theme, No Shadows */}
                    {bulkPercentageBase && bulkPercentageTarget ? (
                      <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-3.5">
                        <div className="flex items-center gap-1.5 text-xs font-bold text-blue-950 mb-2">
                          <Icon name="calculate" sizePx={16} className="text-blue-700" />
                          <span>Formula Preview:</span>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-blue-950 flex-wrap">
                          <span className="rounded-lg bg-white px-2.5 py-1 font-bold border border-blue-200">
                            {priceFieldLabel(bulkPercentageBase)}
                          </span>
                          <span className="font-extrabold text-blue-700">
                            {bulkPercentageDirection === "INCREASE" ? "+" : "−"}
                          </span>
                          <span className="rounded-lg bg-white px-2.5 py-1 font-bold border border-blue-200">
                            {bulkPercentage || "0"}%
                          </span>
                          <span className="font-bold text-slate-400">➔</span>
                          <span className="rounded-lg bg-white px-2.5 py-1 font-extrabold text-emerald-800 border border-emerald-300">
                            Saved to {priceFieldLabel(bulkPercentageTarget)}
                          </span>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              )}

              {/* Tab 3: Move / Swap Prices */}
              {bulkTab === "reassign" && (
                <div className="space-y-4">
                  <div className="rounded-xl border border-[#D8DBE0] bg-white p-4">
                    <div>
                      <h3 className="text-xs font-extrabold uppercase tracking-wider text-[#64748B]">Move or Exchange Prices</h3>
                      <p className="mt-0.5 text-xs font-medium text-[#11120d]">
                        Transfer each product's price value into another field, or exchange values between fields.
                      </p>
                    </div>

                    {bulkPriceCounts.any === 0 && !bulkLoading && (
                      <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs font-medium text-amber-950">
                        Price reassignment is unavailable because none of the selected products have a Rate, Retail price, or Wholesale price.
                      </div>
                    )}

                    <div className="mt-4 grid gap-3 grid-cols-2">
                      <Field label="Source field (Take from)">
                        <ProjectSelect
                          disabled={bulkPriceCounts.any === 0 || bulkLoading}
                          value={bulkMoveFrom}
                          onChange={(event) => setBulkMoveFrom(event.target.value as ImportPriceField | "")}
                          className="h-10 w-full"
                        >
                          <option value="">Choose source price</option>
                          <option value="ratePerPiece" disabled={bulkPriceCounts.ratePerPiece === 0}>
                            Rate ({bulkPriceCounts.ratePerPiece} available)
                          </option>
                          <option value="retailPrice" disabled={bulkPriceCounts.retailPrice === 0}>
                            Retail price ({bulkPriceCounts.retailPrice} available)
                          </option>
                          <option value="wholesalePrice" disabled={bulkPriceCounts.wholesalePrice === 0}>
                            Wholesale price ({bulkPriceCounts.wholesalePrice} available)
                          </option>
                        </ProjectSelect>
                      </Field>

                      <Field label="Destination field (Put into)">
                        <ProjectSelect
                          disabled={bulkPriceCounts.any === 0 || bulkLoading}
                          value={bulkMoveTo}
                          onChange={(event) => setBulkMoveTo(event.target.value as ImportPriceField | "")}
                          className="h-10 w-full"
                        >
                          <option value="">Choose destination field</option>
                          <option value="ratePerPiece">Rate</option>
                          <option value="retailPrice">Retail price</option>
                          <option value="wholesalePrice">Wholesale price</option>
                        </ProjectSelect>
                      </Field>
                    </div>

                    {bulkMoveFrom && bulkMoveTo && bulkMoveFrom === bulkMoveTo && (
                      <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-xs font-bold text-rose-800">
                        Choose two different price fields.
                      </div>
                    )}

                    {bulkMoveFrom && priceFieldCount(bulkMoveFrom) === 0 && (
                      <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs font-bold text-amber-900">
                        None of the selected products has a {priceFieldLabel(bulkMoveFrom)}. Choose another source price.
                      </div>
                    )}

                    {bulkMoveFrom && bulkMoveTo && bulkMoveFrom !== bulkMoveTo && (
                      <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50/70 p-2.5 text-xs font-medium text-blue-900">
                        {priceFieldCount(bulkMoveFrom)} source values found. {priceFieldCount(bulkMoveTo)} products already have a price in the destination.
                      </div>
                    )}
                  </div>

                  {/* Conflict Policy & Source Clear Section */}
                  <div className="rounded-xl border border-[#D8DBE0] bg-white p-4 space-y-3">
                    <div>
                      <div className="text-[10px] font-extrabold uppercase tracking-wider text-[#64748B]">Destination Conflicts</div>
                      <p className="mt-0.5 text-xs font-bold text-[#11120d]">If destination field already has a price:</p>
                    </div>

                    {/* Segmented Control */}
                    <div className="grid grid-cols-3 rounded-xl border border-[#D8DBE0] bg-[#F1F3F5] p-1 gap-1">
                      {([
                        ["KEEP", "Keep existing"],
                        ["REPLACE", "Overwrite"],
                        ["SWAP", "Exchange"],
                      ] as const).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setBulkConflictPolicy(value as "KEEP" | "REPLACE" | "SWAP")}
                          className={`rounded-lg py-1.5 px-2 text-xs font-bold transition text-center ${
                            bulkConflictPolicy === value
                              ? "bg-[#11120d] text-white"
                              : "text-[#5F6570] hover:text-[#11120d] hover:bg-white/60"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {/* Dynamic helper caption */}
                    <div className="text-[11px] font-medium text-[#64748B] min-h-[16px]">
                      {bulkConflictPolicy === "KEEP" && "Skip move for rows where destination already has a price."}
                      {bulkConflictPolicy === "REPLACE" && "Overwrite existing destination price with source price."}
                      {bulkConflictPolicy === "SWAP" && "Swap values between source and destination fields."}
                    </div>

                    {/* Clear source field toggle with Switch component */}
                    <div
                      onClick={() => {
                        if (bulkConflictPolicy !== "SWAP") {
                          setBulkClearSource(!bulkClearSource);
                        }
                      }}
                      className={`pt-3 border-t border-[#E2E4E8] flex items-center justify-between gap-3 transition select-none ${
                        bulkConflictPolicy === "SWAP" ? "opacity-40 pointer-events-none" : "cursor-pointer"
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-[#11120d]">Clear source price after move</div>
                        <div className="text-[11px] text-[#64748B]">Remove price from source field once copied</div>
                      </div>
                      <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
                        <Switch
                          checked={bulkClearSource && bulkConflictPolicy !== "SWAP"}
                          onChange={setBulkClearSource}
                          ariaLabel="Clear source price after moving"
                          disabled={bulkConflictPolicy === "SWAP"}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 4: Extracted Prices */}
              {bulkTab === "extracted" && review?.priceMapping.required && (
                <div className="space-y-4">
                  <div className="rounded-xl border border-[#D8DBE0] bg-white p-4 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-extrabold uppercase tracking-wider text-[#64748B]">
                        Exchange Extracted Columns
                      </h3>
                      <span className="rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
                        {selectedCount.toLocaleString()} selected
                      </span>
                    </div>
                    <p className="text-xs font-medium text-[#11120d] leading-relaxed">
                      Assign source columns from the file into Rate, Retail, or Wholesale for the selected products.
                    </p>
                  </div>

                  <div className="space-y-3">
                    {review.priceMapping.columns.map((column) => {
                      const details = getPriceColumnDetails(column.key, review.rows, activeRow, selectedIds);
                      return (
                        <div key={column.key} className="rounded-xl border border-[#D8DBE0] bg-white p-4 space-y-2.5">
                          <div className="flex items-start justify-between gap-2 flex-wrap">
                            <div>
                              <div className="text-[10px] font-extrabold uppercase tracking-wider text-[#64748B]">Source Column</div>
                              <div className="text-sm font-extrabold text-[#11120d] mt-0.5">{column.label}</div>
                            </div>
                            <div className="text-right">
                              {details.sample ? (
                                <div className="inline-flex items-center gap-1.5 rounded-lg border border-[#D8DBE0] bg-[#F8F9FA] px-2.5 py-1 text-xs font-semibold text-[#11120d]">
                                  <span className="text-[#64748B]">Sample:</span>
                                  <strong className="text-[#11120d]">NPR {details.sample.value.toLocaleString()}</strong>
                                </div>
                              ) : (
                                <span className="text-xs text-[#94A3B8]">No values in selection</span>
                              )}
                            </div>
                          </div>

                          {details.sample && (
                            <div className="text-[11px] text-[#64748B]">
                              Found in {details.totalMatching} of {selectedCount} selected products{details.sample.name ? ` (e.g. “${details.sample.name}”)` : ""}
                            </div>
                          )}

                          <Field label="Assign to price field">
                            <ProjectSelect
                              value={bulkExtractedMapping[column.key] || ""}
                              onChange={(event) => {
                                const val = event.target.value as ImportPriceField | "";
                                setBulkExtractedMapping((curr) => ({ ...curr, [column.key]: val }));
                              }}
                              className="h-10 w-full"
                              aria-label={`Assign ${column.label}`}
                            >
                              <option value="">Leave unassigned (no change)</option>
                              <option value="ratePerPiece">Rate (Cost price)</option>
                              <option value="retailPrice">Retail price</option>
                              <option value="wholesalePrice">Wholesale price</option>
                            </ProjectSelect>
                          </Field>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Bottom Sticky Action Bar */}
            <div className="sticky bottom-0 z-20 flex items-center justify-between gap-3 border-t border-[#D8DBE0] bg-white p-4">
              <button
                type="button"
                onClick={closeBulkEdit}
                disabled={bulkSaving}
                className="h-10 rounded-xl border border-[#D4D7DC] px-4 text-xs font-bold text-[#374151] hover:bg-[#F3F4F6] transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void prepareBulkEditReview()}
                disabled={bulkSaving || selectedCount === 0}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#11120d] px-5 text-xs font-bold text-white transition hover:bg-[#2a2c27] disabled:opacity-45"
              >
                {bulkSaving ? (
                  <>
                    <Icon name="refresh" sizePx={15} className="animate-spin" />
                    <span>Preparing preview…</span>
                  </>
                ) : (
                  <>
                    <span>Review changes</span>
                    <Icon name="chevron_right" sizePx={16} />
                  </>
                )}
              </button>
            </div>

            {/* Final Review & Diff View Overlay: Restored Colors, Zero Shadows, Interactive Filters, Search, Pagination */}
            {bulkPreview ? (() => {
              const allItems = bulkPreview.items && bulkPreview.items.length > 0
                ? bulkPreview.items
                : bulkPreview.before.map((before, index) => {
                    const after = bulkPreview.after[index];
                    const changedFields = describeReviewPayloadChanges(before, after);
                    return {
                      before,
                      after,
                      changedFields,
                      skippedOperations: [],
                      priceConflict: false,
                      skipReason: changedFields.length === 0 ? "No changes applied" : null,
                    };
                  });

              const filteredItems = allItems.filter((item) => {
                if (diffFilter === "changed" && item.changedFields.length === 0) return false;
                if (diffFilter === "skipped" && !item.skipReason && item.changedFields.length > 0) return false;
                if (diffFilter === "conflicts" && !item.priceConflict) return false;

                if (diffSearch.trim()) {
                  const q = diffSearch.trim().toLowerCase();
                  const nameMatch = item.after.name.toLowerCase().includes(q);
                  const skuMatch = item.after.sku.toLowerCase().includes(q);
                  const brandMatch = (item.after.brand || "").toLowerCase().includes(q);
                  if (!nameMatch && !skuMatch && !brandMatch) return false;
                }

                return true;
              });

              const pageSize = 25;
              const totalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
              const currentPage = Math.min(diffPage, totalPages);
              const startIndex = (currentPage - 1) * pageSize;
              const pageItems = filteredItems.slice(startIndex, startIndex + pageSize);
              const pageRangeStart = filteredItems.length === 0 ? 0 : startIndex + 1;
              const pageRangeEnd = Math.min(startIndex + pageSize, filteredItems.length);

              return (
                <div className="absolute inset-0 z-30 flex flex-col bg-[#F8F9FA]">
                  <header className="flex items-center justify-between border-b border-[#D8DBE0] bg-white px-5 py-3.5">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[10px] font-bold text-emerald-800 uppercase tracking-wide">
                          Step 2 of 2
                        </span>
                        <h2 className="text-base font-extrabold text-[#11120d]">Confirm Bulk Changes</h2>
                      </div>
                      <p className="mt-0.5 text-xs text-[#64748B]">
                        Nothing has been saved yet. Review before-and-after values below.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setBulkPreview(null)}
                      disabled={bulkSaving}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#D4D7DC] text-[#64748B] hover:bg-[#F3F4F6] hover:text-[#11120d] transition"
                      aria-label="Close preview"
                    >
                      <Icon name="close" sizePx={16} />
                    </button>
                  </header>

                  <div className="flex-1 min-h-0 flex flex-col p-4 sm:p-5 gap-3 overflow-hidden">
                    {/* Metric Summary Card: Interactive Filter Tabs */}
                    <div className="rounded-xl border border-[#D8DBE0] bg-white p-4 shrink-0">
                      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                        <h3 className="text-xs font-extrabold uppercase tracking-wider text-[#64748B]">Impact Summary (Click to Filter)</h3>
                        <div className="flex flex-wrap gap-1.5">
                          {bulkPreview.fields.map((field) => (
                            <span key={field} className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-[11px] font-bold text-blue-900">
                              {field}
                            </span>
                          ))}
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-2.5">
                        <button
                          type="button"
                          onClick={() => {
                            setDiffFilter(diffFilter === "changed" ? "all" : "changed");
                            setDiffPage(1);
                          }}
                          className={`rounded-xl p-3 text-center border transition text-left sm:text-center ${
                            diffFilter === "changed"
                              ? "bg-emerald-100/80 border-emerald-600 ring-2 ring-emerald-600/30"
                              : "bg-emerald-50/80 border-emerald-200 hover:bg-emerald-100/50"
                          }`}
                        >
                          <div className="text-xl font-extrabold text-emerald-900">{bulkPreview.changedRows.toLocaleString()}</div>
                          <div className="text-[11px] font-bold text-emerald-800">Will change</div>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setDiffFilter(diffFilter === "skipped" ? "all" : "skipped");
                            setDiffPage(1);
                          }}
                          className={`rounded-xl p-3 text-center border transition text-left sm:text-center ${
                            diffFilter === "skipped"
                              ? "bg-amber-100/90 border-amber-600 ring-2 ring-amber-600/30"
                              : bulkPreview.skippedRows > 0
                                ? "bg-amber-50/80 border-amber-200 text-amber-900 hover:bg-amber-100/50"
                                : "bg-[#F8F9FA] border-[#E2E4E8] text-[#64748B]"
                          }`}
                        >
                          <div className={`text-xl font-extrabold ${bulkPreview.skippedRows > 0 ? "text-amber-900" : "text-[#11120d]"}`}>
                            {bulkPreview.skippedRows.toLocaleString()}
                          </div>
                          <div className="text-[11px] font-semibold">Skipped rows</div>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setDiffFilter(diffFilter === "conflicts" ? "all" : "conflicts");
                            setDiffPage(1);
                          }}
                          className={`rounded-xl p-3 text-center border transition text-left sm:text-center ${
                            diffFilter === "conflicts"
                              ? "bg-rose-100/90 border-rose-600 ring-2 ring-rose-600/30"
                              : bulkPreview.priceConflicts > 0
                                ? "bg-amber-50/80 border-amber-200 text-amber-900 hover:bg-amber-100/50"
                                : "bg-[#F8F9FA] border-[#E2E4E8] text-[#64748B]"
                          }`}
                        >
                          <div className={`text-xl font-extrabold ${bulkPreview.priceConflicts > 0 ? "text-amber-900" : "text-[#11120d]"}`}>
                            {bulkPreview.priceConflicts.toLocaleString()}
                          </div>
                          <div className="text-[11px] font-semibold">Conflicts</div>
                        </button>
                      </div>
                    </div>

                    {/* Filter & Search Bar */}
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="relative flex-1">
                        <Icon name="search" sizePx={15} className="absolute left-3 top-2.5 text-[#7A7F89]" />
                        <input
                          value={diffSearch}
                          onChange={(event) => {
                            setDiffSearch(event.target.value);
                            setDiffPage(1);
                          }}
                          placeholder="Search preview by name, SKU, brand…"
                          className="h-9 w-full rounded-xl border border-[#D4D7DC] pl-9 pr-9 text-xs font-medium outline-none focus:border-[#11120d] bg-white"
                        />
                        {diffSearch ? (
                          <button
                            type="button"
                            onClick={() => { setDiffSearch(""); setDiffPage(1); }}
                            className="absolute right-2 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-full text-[#7A7F89] hover:bg-slate-100 hover:text-[#11120d] transition"
                            title="Clear search"
                          >
                            <Icon name="close" sizePx={15} />
                          </button>
                        ) : null}
                      </div>
                      {diffFilter !== "all" ? (
                        <button
                          type="button"
                          onClick={() => { setDiffFilter("all"); setDiffPage(1); }}
                          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-[#D4D7DC] bg-white px-2.5 text-xs font-bold text-[#64748B] hover:text-[#11120d]"
                          title="Reset filter to all rows"
                        >
                          <span>Filter: {diffFilter}</span>
                          <Icon name="close" sizePx={13} />
                        </button>
                      ) : null}
                    </div>

                    {/* Diff Review Table: Expands to fill available height, eliminating empty space */}
                    <div className="flex-1 min-h-0 flex flex-col rounded-xl border border-[#D8DBE0] bg-white overflow-hidden">
                      <div className="shrink-0 border-b border-[#E2E4E8] bg-[#F8F9FA] px-4 py-2.5 flex items-center justify-between">
                        <span className="text-xs font-bold text-[#11120d]">Product Change Preview</span>
                        <span className="text-[11px] font-medium text-[#64748B]">
                          {filteredItems.length.toLocaleString()} product{filteredItems.length === 1 ? "" : "s"}
                        </span>
                      </div>

                      <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-[#E2E4E8]">
                        {pageItems.length > 0 ? (
                          pageItems.map(({ before, after, changedFields, skipReason, priceConflict }) => {
                            const priceChanges = ([
                              ["Rate", before.ratePerPiece, after.ratePerPiece],
                              ["Retail price", before.retailPrice, after.retailPrice],
                              ["Wholesale price", before.wholesalePrice, after.wholesalePrice],
                            ] as const).filter(([, current, next]) => current !== next);
                            const availabilityChanged = before.availabilityStatus !== after.availabilityStatus;
                            const otherChanges = changedFields.filter(
                              (f) => !["Rate", "Retail price", "Wholesale price", "Availability"].includes(f)
                            );

                            return (
                              <div key={before.rowId} className="p-3.5 text-xs hover:bg-[#F8F9FA] transition">
                                <div className="flex items-center justify-between gap-2 mb-1.5">
                                  <div className="font-bold text-[#11120d] truncate">{after.name}</div>
                                  <div className="flex items-center gap-1 shrink-0">
                                    {after.sku && (
                                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">
                                        {after.sku}
                                      </span>
                                    )}
                                    {skipReason ? (
                                      <span className="rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-900">
                                        Skipped: {skipReason}
                                      </span>
                                    ) : null}
                                    {priceConflict ? (
                                      <span className="rounded-md border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-bold text-rose-900">
                                        Conflict resolved
                                      </span>
                                    ) : null}
                                  </div>
                                </div>

                                <div className="space-y-1">
                                  {priceChanges.map(([label, current, next]) => (
                                    <div key={label} className="flex items-center gap-2 text-xs flex-wrap">
                                      <span className="w-28 text-[#64748B] shrink-0 font-medium">{label}:</span>
                                      <span className="text-[#64748B] line-through">{reviewPrice(current)}</span>
                                      <span className="text-[#94A3B8]">→</span>
                                      <span className="font-bold text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200">
                                        {reviewPrice(next)}
                                      </span>
                                    </div>
                                  ))}
                                  {availabilityChanged && (
                                    <div className="flex items-center gap-2 text-xs flex-wrap">
                                      <span className="w-28 text-[#64748B] shrink-0 font-medium">Availability:</span>
                                      <span className="text-[#64748B]">{availabilityText(before.availabilityStatus)}</span>
                                      <span className="text-[#94A3B8]">→</span>
                                      <span className="font-bold text-[#11120d] bg-slate-100 px-2 py-0.5 rounded-md border border-slate-200">
                                        {availabilityText(after.availabilityStatus)}
                                      </span>
                                    </div>
                                  )}
                                  {otherChanges.length > 0 && (
                                    <div className="flex items-center gap-2 text-xs flex-wrap">
                                      <span className="w-28 text-[#64748B] shrink-0 font-medium">Other fields:</span>
                                      <span className="font-medium text-[#11120d] bg-slate-50 px-2 py-0.5 rounded border border-slate-200">
                                        {otherChanges.join(", ")}
                                      </span>
                                    </div>
                                  )}
                                  {!skipReason && changedFields.length === 0 && (
                                    <div className="text-[11px] text-[#7A7F89] italic">
                                      No values modified for this product.
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })
                        ) : (
                          <div className="p-8 text-center text-xs font-semibold text-[#7A7F89]">
                            No preview rows match the current filter or search.
                          </div>
                        )}
                      </div>

                      {/* Pagination Bar */}
                      {filteredItems.length > 0 && (
                        <div className="shrink-0 flex items-center justify-between border-t border-[#E2E4E8] bg-[#F8F9FA] px-4 py-2.5 text-xs font-bold text-[#5F6570]">
                          <span>
                            Showing {pageRangeStart.toLocaleString()}–{pageRangeEnd.toLocaleString()} of {filteredItems.length.toLocaleString()} products
                          </span>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={currentPage <= 1}
                              onClick={() => setDiffPage((p) => Math.max(1, p - 1))}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#D4D7DC] bg-white text-[#11120d] disabled:opacity-30 hover:bg-[#F3F4F6]"
                              aria-label="Previous page"
                            >
                              <Icon name="chevron_left" sizePx={16} />
                            </button>
                            <span className="px-1 text-[11px] text-[#374151]">
                              {currentPage} / {totalPages}
                            </span>
                            <button
                              type="button"
                              disabled={currentPage >= totalPages}
                              onClick={() => setDiffPage((p) => Math.min(totalPages, p + 1))}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#D4D7DC] bg-white text-[#11120d] disabled:opacity-30 hover:bg-[#F3F4F6]"
                              aria-label="Next page"
                            >
                              <Icon name="chevron_right" sizePx={16} />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  <footer className="sticky bottom-0 z-30 flex items-center justify-between gap-3 border-t border-[#D8DBE0] bg-white p-4">
                    <button
                      type="button"
                      onClick={() => setBulkPreview(null)}
                      disabled={bulkSaving}
                      className="h-10 rounded-xl border border-[#D4D7DC] px-4 text-xs font-bold text-[#374151] hover:bg-[#F3F4F6] transition"
                    >
                      Go back
                    </button>
                    <button
                      type="button"
                      onClick={() => void applyReviewedBulkEdit()}
                      disabled={bulkSaving}
                      className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#11120d] px-5 text-xs font-bold text-white transition hover:bg-[#2a2c27] disabled:opacity-45"
                    >
                      <Icon name="check" sizePx={16} />
                      <span>{bulkSaving ? "Applying…" : `Confirm ${bulkPreview.changedRows.toLocaleString()} changes`}</span>
                    </button>
                  </footer>
                </div>
              );
            })() : null}
          </aside>
        </div>
      ) : null}

      <ModalFrame
        open={bulkDiscardOpen}
        onClose={() => setBulkDiscardOpen(false)}
        title="Discard bulk-edit changes?"
        description="The selected products are unchanged until you confirm the final review."
        layer="critical"
        maxWidthClass="max-w-[480px]"
        mobileBottomSheet
        footer={(
          <div className="grid w-full grid-cols-2 gap-3">
            <button type="button" onClick={() => setBulkDiscardOpen(false)} className="h-11 rounded-[11px] border border-[#D4D7DC] bg-white px-4 text-[11px] font-extrabold text-[#374151] hover:bg-[#F3F4F6]">Keep editing</button>
            <button type="button" onClick={closeBulkEditNow} className="h-11 rounded-[11px] border border-rose-200 bg-rose-50 px-4 text-[11px] font-extrabold text-rose-800 hover:bg-rose-100">Discard changes</button>
          </div>
        )}
      >
        <div className="rounded-[12px] border border-amber-200 bg-amber-50 p-3 text-[11px] font-semibold leading-5 text-amber-950">Closing now removes the unsaved field choices and preview. It does not change any product.</div>
      </ModalFrame>

      {/* Final Import Confirmation Modal */}
      {commitOpen && review ? (
        <div className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-950/45 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Confirm final product import">
          <button type="button" className="absolute inset-0 cursor-default" onClick={() => !commitBusy && setCommitOpen(false)} aria-label="Close final import confirmation" />
          <section className="relative z-10 w-full max-w-[560px] rounded-t-[22px] border border-[#D8DBE0] bg-white p-5 sm:rounded-[20px]">
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

      <ModalFrame
        open={Boolean(pendingReviewNavigation)}
        onClose={() => setPendingReviewNavigation(null)}
        title="Unsaved product changes"
        description="Save this product before moving away, or discard only its unsaved edits."
        layer="critical"
        maxWidthClass="max-w-[480px]"
        mobileBottomSheet
        footer={(
          <div className="grid w-full grid-cols-2 gap-3">
            <button type="button" onClick={() => setPendingReviewNavigation(null)} className="h-11 rounded-[11px] border border-[#D4D7DC] bg-white px-4 text-[11px] font-extrabold text-[#374151] hover:bg-[#F3F4F6]">Keep editing</button>
            <button type="button" onClick={confirmReviewNavigation} className="h-11 rounded-[11px] border border-rose-200 bg-rose-50 px-4 text-[11px] font-extrabold text-rose-800 hover:bg-rose-100">Discard and continue</button>
          </div>
        )}
      >
        <div className="rounded-[12px] border border-amber-200 bg-amber-50 p-3 text-[11px] font-semibold leading-5 text-amber-950">
          {pendingReviewNavigation?.description}
        </div>
      </ModalFrame>
    </div>
  );
}
