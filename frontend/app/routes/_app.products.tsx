import { importBatchStatus } from "~/lib/importBatchStatus";
import { refreshImportTask } from "~/lib/importTaskStore";
import type { ProductImportBatchSummary } from "~/lib/api/endpoints";
import React, { useEffect, useMemo, useRef, useState } from "react";
import ProjectSelect from "~/components/ui/ProjectSelect";
import { useQueryControls } from "~/hooks/useQueryControls";
import ProjectDateInput from "~/components/ui/ProjectDateInput";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import type {
  Product,
  ProductLookupSnapshot,
  ProductStatus,
  ToastKind,
} from "~/lib/domain/products/products.types";
import {
  readProductLookupEdit,
  stageProductLookupRestore,
} from "~/lib/domain/products/productLookupHandoff";
import {
  deleteProductImportBatchApi,
  getBusinessSettingsApi,
  getProductImportBatchApi,
  importCsvApi,
  controlProductImportApi,
  importImageRateListApi,
  importProductDocumentApi,
  importPdfApi,
  importReviewedPdfRowsApi,
  saveReviewedProductImportRowsApi,
  listProductSearchAliasesApi,
  replaceProductSearchAliasesApi,
  recordProductSearchSelectionApi,
  listDocumentsApi,
  listProductImportBatchesApi,
  listProductImportTemplatesApi,
  saveProductImportTemplateApi,
  deleteProductImportTemplateApi,
  receiveStockBatchApi,
  adjustStockApi,
  bulkUpdateProductPricesApi,
  type BusinessSettings,
  type DocumentRecord,
  type ImportedProductSummary,
  type ProductImportBatch,
  type ProductImportTemplate,
  type ReviewedPdfImportRowPayload,
  type ProductSearchSelectionAction,
} from "~/lib/api/endpoints";
import {
  bulkSetStatus,
  createProduct,
  fetchProductsByIds,
  fetchProducts,
  fetchProductsMeta,
  getProductDeleteSafety,
  discardStockAndDeleteProduct,
  permanentlyDeleteProduct,
  setProductStatus,
  updateProduct,
  uploadProductImage,
} from "~/lib/domain/products/products.api";
import { getAuthUser } from "~/lib/auth";
import { isRateLimitError } from "~/lib/api/client";
import {
  isCurrentRequestIdentity,
  refreshAfterSuccessfulMutation,
} from "~/lib/api/requestPolicy";
import type { ProductDeleteSafety } from "~/lib/api/endpoints";
import ProductsFiltersCard from "~/components/blocks/products/ProductsFilters";
import type {
  ProductSortBy,
  ProductPricingStatus,
  ProductPhotoStatus,
} from "~/lib/domain/products/products.types";
import ProductsTableCard from "~/components/blocks/products/ProductsTable";
import ProductsModals from "~/components/blocks/products/ProductsModals";
import ProductSearchInsightsModal from "~/components/blocks/products/ProductSearchInsightsModal";
import { useToast } from "~/components/ui/Toast";
import { DialogButton, ModalFrame } from "~/components/ui/Modal";
import MobilePaginationFooter from "~/components/ui/MobilePaginationFooter";
import Icon from "~/components/ui/Icon";
import CreatableCombobox from "~/components/ui/CreatableCombobox";
import { focusInvalidField } from "~/lib/forms/focusInvalidField";
import { useBusinessCapabilities } from "~/lib/businessCapabilities";
import { usePurchaseCostPrivacy } from "~/hooks/usePurchaseCostPrivacy";
type ProductFormErrors = Partial<
  Record<
    | "name"
    | "brand"
    | "category"
    | "sku"
    | "ratePerPiece"
    | "retailPrice"
    | "wholesalePrice"
    | "thresholdQty"
    | "stock"
    | "lowStockThreshold"
    | "packageQuantity"
    | "quantityStep"
    | "image",
    string
  >
>;

type CsvImportError = {
  rowNumber: number;
  sku?: string;
  name?: string;
  message: string;
};

type CsvImportResult = {
  totalRows: number;
  createdCount: number;
  errorCount: number;
  createdProducts?: ImportedProductSummary[];
  errors: CsvImportError[];
  batchId?: string;
  sourceType?: string;
  message?: string;
  repeatedFile?: boolean;
};

type BulkActionState =
  | null
  | {
      title: string;
      message: string;
      confirmLabel: string;
      successKind: ToastKind;
      successMessage: string;
      targetStatus: ProductStatus;
    };

type BulkSelectionScope = "page" | "filtered";

type PendingProductFilterChange =
  | { kind: "search"; value: string }
  | { kind: "brand"; value: string }
  | { kind: "category"; value: string }
  | { kind: "stockStatus"; value: "all" | "in" | "low" | "out" }
  | { kind: "status"; value: "active" | "inactive" }
  | { kind: "sortBy"; value: ProductSortBy }
  | { kind: "pricingStatus"; value: ProductPricingStatus }
  | { kind: "photoStatus"; value: ProductPhotoStatus }
  | { kind: "lowOnly"; value: boolean }
  | { kind: "clear" };

function describeProductFilterChange(change: PendingProductFilterChange | null) {
  if (!change) return "the product filters";
  if (change.kind === "search") return change.value.trim() ? `the search to “${change.value.trim()}”` : "clearing the search";
  if (change.kind === "clear") return "clearing all product filters";
  if (change.kind === "lowOnly") return change.value ? "showing only low-stock products" : "removing the low-stock-only filter";
  if (change.kind === "sortBy") return "the sort order";
  if (change.kind === "pricingStatus") return "the pricing status filter";
  if (change.kind === "photoStatus") return "the photo filter";
  return `the ${change.kind === "stockStatus" ? "stock" : change.kind} filter`;
}

type PriceField = "ratePerPiece" | "wholesalePrice" | "retailPrice";
type PriceDraft = Record<PriceField, string>;
const formatReviewPrice = (value: number | null | undefined) => value == null
  ? "None"
  : `NPR ${Number(value).toLocaleString("en-NP", { maximumFractionDigits: 2 })}`;
type BulkPriceMode = "CALCULATE" | "MANUAL";
type BulkPriceErrors = {
  reason?: string;
  rows?: Record<string, Partial<Record<PriceField, string>>>;
};

type PriceChangeDirection = "INCREASE" | "DECREASE";
type ExistingSellingPricePolicy = "FILL_EMPTY" | "REPLACE";
type BulkPriceNotice = {
  tone: "info" | "success" | "danger";
  message: string;
} | null;

type QuickStockProductForm = {
  name: string;
  sku: string;
  brand: string;
  category: string;
  ratePerPiece: string;
  wholesalePrice: string;
  retailPrice: string;
  saleUnit: string;
};

type QuickStockErrors = Partial<
  Record<"name" | "brand" | "category" | "ratePerPiece" | "wholesalePrice" | "retailPrice", string>
>;

type StockFieldErrors = Partial<Record<"reason" | "supplier", string>>;

// this normalizes business settings into safe numeric defaults before the product form uses them
// we added the clamps here so missing or broken settings data does not produce invalid thresholds in the UI
function normalizeBusinessDefaults(
  settings?: Partial<BusinessSettings> | null,
): BusinessSettings {
  return {
    businessMode: settings?.businessMode ?? "FULL_POS",
    staffDraftRequestsEnabled: settings?.staffDraftRequestsEnabled ?? true,
    defaultInitialStock: Math.max(0, Number(settings?.defaultInitialStock ?? 30)),
    defaultLowStockThreshold: Math.max(
      0,
      Number(settings?.defaultLowStockThreshold ?? 5),
    ),
    defaultWholesaleQtyThreshold: Math.max(
      1,
      Number(settings?.defaultWholesaleQtyThreshold ?? 15),
    ),
    loyaltyDiscountPercent: Math.max(
      0,
      Math.min(100, Number(settings?.loyaltyDiscountPercent ?? 2)),
    ),
    returnWindowDays: Math.max(0, Number(settings?.returnWindowDays ?? 7)),
    parkedBillExpiryHours: Math.max(
      1,
      Number(settings?.parkedBillExpiryHours ?? 8),
    ),
    draftRequestExpiryMinutes: Math.max(
      1,
      Number(settings?.draftRequestExpiryMinutes ?? 30),
    ),
  };
}

// keeping pagination inside valid limits prevents the table from landing on empty pages after filters change
function clampPage(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function positiveQueryNumber(raw: string | null, fallback: number) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function queryChoice<T extends string>(
  raw: string | null,
  choices: readonly T[],
  fallback: T,
) {
  const value = raw as T | null;
  return value && choices.includes(value) ? value : fallback;
}

function roundMoney(value: number) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function priceFromPercentageChange(rate: number, percent: number, direction: PriceChangeDirection) {
  const normalizedRate = Number(rate || 0);
  const normalizedPercent = Number(percent || 0);
  if (!Number.isFinite(normalizedRate) || normalizedRate <= 0) return 0;
  if (!Number.isFinite(normalizedPercent) || normalizedPercent <= 0 || normalizedPercent > 100) return 0;
  const multiplier = direction === "DECREASE" ? 1 - normalizedPercent / 100 : 1 + normalizedPercent / 100;
  return roundMoney(normalizedRate * multiplier);
}

function formatDocumentDate(value?: string | null) {
  if (!value) return "No date";
  return new Date(value).toLocaleDateString();
}

function formatDocumentBytes(bytes?: number | null) {
  if (!Number(bytes)) return "0 Bytes";
  const size = Number(bytes);
  if (size < 1024) return `${size} Bytes`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function todayInputDate() {
  return new Date().toISOString().slice(0, 10);
}

function displaySourceType(sourceType?: string | null) {
  return (sourceType || "IMPORT").replace(/_/g, " ").toUpperCase();
}

function getActionableImportCardMeta(batch: Parameters<typeof importBatchStatus>[0] & { fileName?: string | null; sourceType?: string | null }) {
  const type = String(batch.sourceType || "").toUpperCase();
  const name = (batch.fileName || "").toLowerCase();
  const isPdf = type === "PDF" || name.endsWith(".pdf");
  const isSheet = ["CSV", "XLSX", "XLS"].includes(type) || /\.(csv|xlsx?)$/.test(name);
  return {
    ...importBatchStatus(batch),
    fileIcon: isPdf ? "picture_as_pdf" : isSheet ? "table_chart" : "image",
    fileIconBoxClass: isPdf ? "border-rose-200 bg-rose-50 text-rose-600" : isSheet ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-sky-200 bg-sky-50 text-sky-700",
  };
}

// this is the main product management page
// it handles searching, filtering, adding, editing, importing, and soft-deleting product records
export default function ProductsPage() {
  const { showToast } = useToast();
  const capabilities = useBusinessCapabilities();
  const stockTracked = capabilities.stockTracked;
  const isAdmin = getAuthUser()?.role === "admin";
  const {
    purchaseCostVisible,
    togglePurchaseCostVisibility,
  } = usePurchaseCostPrivacy(isAdmin);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryField = useQueryControls(searchParams, setSearchParams);
  const requestedImportBatchId = searchParams.get("importBatch");
  const requestedEditProductId = searchParams.get("editProduct");
  const requestedEditReturnTo = searchParams.get("returnTo") || "";
  const productLookupEditKey = (
    location.state as { productLookupEditKey?: string } | null
  )?.productLookupEditKey;
  const productLookupEditHandoff = readProductLookupEdit(
    productLookupEditKey,
    requestedEditProductId,
  );
  const handledEditRequestRef = React.useRef<string | null>(null);
  const productAliasRequestRef = React.useRef(0);
  const [returnAfterProductEdit, setReturnAfterProductEdit] = useState("");
  const [returnAfterProductEditSnapshot, setReturnAfterProductEditSnapshot] =
    useState<ProductLookupSnapshot | undefined>(
      productLookupEditHandoff?.snapshot,
    );
  const [openingRequestedEditProduct, setOpeningRequestedEditProduct] = useState(false);
  // we use this to create a clean form state for new products based on the current brand/category lists and saved defaults
  function buildDefaultProductForm(
    brandOptions: string[],
    categoryOptions: string[],
    settings: BusinessSettings,
  ): Product {
    return {
      id: "new",
      name: "",
      productName: "",
      sku: "",
      barcode: "",
      imageUrl: "",
      // Brand and category are user classifications. Starting them with the
      // first database option silently assigns the wrong taxonomy.
      brand: "",
      category: "",
      categoryGroup: "",
      vendorSource: "",
      productCodeVariant: "",
      sizeValue: null,
      sizeUnit: "STANDARD",
      ratePerPiece: null,
      packageQuantity: 1,
      packageUnit: "PIECE",
      saleUnit: "PIECE",
      allowFractionalQty: false,
      quantityStep: 1,
      wholesaleEligible: true,
      sourceCitation: "",
      sellingPriceStatus: "PENDING",
      availabilityStatus: "CATALOG_LISTED",
      retailPrice: null,
      wholesalePrice: null,
      thresholdQty: settings.defaultWholesaleQtyThreshold,
      thresholdQtyMode: "default",
      stock: stockTracked ? settings.defaultInitialStock : 0,
      lowStockThreshold: settings.defaultLowStockThreshold,
      lowStockThresholdMode: "default",
      status: "Active",
    };
  }

  const [brands, setBrands] = useState<string[]>(
    () => productLookupEditHandoff?.snapshot.brands || ["All Brands"],
  );
  const [categories, setCategories] = useState<string[]>(
    () => productLookupEditHandoff?.snapshot.categories || ["All Categories"],
  );
  const [businessDefaults, setBusinessDefaults] = useState<BusinessSettings>(
    () => normalizeBusinessDefaults(),
  );

  const [products, setProducts] = useState<Product[]>([]); // current server-backed table page
  const [total, setTotal] = useState(0); // backend-reported total matching the current filters
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsLoadError, setProductsLoadError] = useState("");
  const [activeSearchLogId, setActiveSearchLogId] = useState<string | null>(null);
  const productLoadRequestRef = React.useRef(0);
  const productFilterIdentityRef = React.useRef("");
  const productMetaRecoveryNeededRef = React.useRef(false);
  const productRowsRecoveryNeededRef = React.useRef(false);
  const [productRecoveryKey, setProductRecoveryKey] = useState(0);

  const [debouncedQ, setDebouncedQ] = queryField("q", "", (value) => value?.trim() || "");
  const [q, setQ] = useState(debouncedQ);
  const [brand, setBrand] = queryField("brand", "All Brands", (value) => value || "All Brands");
  const [category, setCategory] = queryField("category", "All Categories", (value) => value || "All Categories");
  const [stockStatus, setStockStatus] = queryField<"all" | "in" | "low" | "out">(
    "stock", "all", (value) => value === "in" || value === "low" || value === "out" ? value : "all",
  );
  const [status, setStatus] = queryField<"active" | "inactive">(
    "status", "active", (value) => value === "inactive" ? "inactive" : "active",
  );
  const [lowOnly, setLowOnly] = queryField("low", false, (value) => value === "true");
  const [sortBy, setSortBy] = queryField<ProductSortBy>("sort", "photos_first", (value) =>
    queryChoice(value, ["photos_first", "name_asc", "name_desc", "brand_asc", "price_asc", "price_desc", "newest"] as const, "photos_first"));
  const [pricingStatus, setPricingStatus] = queryField<ProductPricingStatus>("pricing", "all", (value) =>
    queryChoice(value, ["all", "ready", "pending"] as const, "all"));
  const [photoStatus, setPhotoStatus] = queryField<ProductPhotoStatus>("photo", "all", (value) =>
    queryChoice(value, ["all", "with_photo", "without_photo"] as const, "all"));

  React.useEffect(() => { setQ(debouncedQ); }, [debouncedQ]);

  React.useEffect(() => {
    if (stockTracked) return;
    setStockStatus("all");
    setLowOnly(false);
    setOpenStockManager(false);
  }, [stockTracked]);

  const [selected, setSelected] = useState<Record<string, boolean>>({}); // checkbox state for bulk actions across the current dataset
  const [selectedProductCache, setSelectedProductCache] = useState<Record<string, Product>>({});
  const [bulkSelectionScope, setBulkSelectionScope] =
    useState<BulkSelectionScope>("page");
  const [filteredSelectionExclusions, setFilteredSelectionExclusions] = useState<
    Record<string, Pick<Product, "id" | "name" | "sku">>
  >({});
  const [pendingProductFilterChange, setPendingProductFilterChange] =
    useState<PendingProductFilterChange | null>(null);
  const productCatalogControlsRef = React.useRef<HTMLDivElement>(null);
  const [isSelectionPinned, setIsSelectionPinned] = useState(false);
  // converting the selection object into an id list makes the bulk action handlers much easier to work with
  const selectedIds = useMemo(
    () => Object.keys(selected).filter((id) => selected[id]),
    [selected],
  );
  const isFilteredSelection = bulkSelectionScope === "filtered";
  const filteredExcludedIds = useMemo(
    () => Object.keys(filteredSelectionExclusions),
    [filteredSelectionExclusions],
  );
  const selectedCount = isFilteredSelection
    ? Math.max(0, total - filteredExcludedIds.length)
    : selectedIds.length;
  const selectedProducts = useMemo(
    () => selectedIds.map((id) => selectedProductCache[id]).filter(Boolean),
    [selectedIds, selectedProductCache],
  );

  React.useEffect(() => {
    if (selectedCount <= 0) {
      setIsSelectionPinned(false);
      return undefined;
    }

    const controls = productCatalogControlsRef.current;
    const scrollContainer = document.querySelector<HTMLElement>(
      "[data-app-scroll-container]",
    );
    if (!controls || !scrollContainer) return undefined;

    const observer = new IntersectionObserver(
      ([entry]) => {
        const scrollTopEdge =
          entry.rootBounds?.top ??
          scrollContainer.getBoundingClientRect().top;
        setIsSelectionPinned(
          !entry.isIntersecting && entry.boundingClientRect.bottom <= scrollTopEdge + 1,
        );
      },
      {
        root: scrollContainer,
        rootMargin: "14px 0px 0px 0px",
        threshold: [0, 0.01],
      },
    );

    observer.observe(controls);
    return () => observer.disconnect();
  }, [selectedCount]);

  const [tablePageSize, setTablePageSize] = queryField("pageSize", 20, (value) => {
    const requested = positiveQueryNumber(value, 20);
    return [20, 50, 100].includes(requested) ? requested : 20;
  }); // visible rows per table page
  const [page, setPage] = queryField("page", 1, (value) => positiveQueryNumber(value, 1));
  productFilterIdentityRef.current = JSON.stringify([
    debouncedQ,
    brand,
    category,
    stockStatus,
    status,
    lowOnly,
    page,
    tablePageSize,
    sortBy,
    pricingStatus,
    photoStatus,
  ]);

  const [openAddEdit, setOpenAddEdit] = useState(false); // controls the create/edit modal
  const [productSaveBusy, setProductSaveBusy] = useState(false);
  const [productEditorBaseline, setProductEditorBaseline] = useState("");
  const [productEditorImageBaseline, setProductEditorImageBaseline] = useState("");
  const [confirmDiscardProductEditor, setConfirmDiscardProductEditor] = useState(false);
  const [productSaveSuccess, setProductSaveSuccess] = useState<{
    product: Product;
    imageUploadError: string;
  } | null>(null);
  const [openImport, setOpenImport] = useState(false); // controls the CSV import modal
  const [actionableImportsExpanded, setActionableImportsExpanded] = useState(false);
  const [openSearchInsights, setOpenSearchInsights] = useState(false);
  const [openView, setOpenView] = useState(false); // controls the product detail modal
  const [openConfirmDelete, setOpenConfirmDelete] = useState(false); // controls the single-product soft delete confirmation
  const [deleteSafety, setDeleteSafety] = useState<ProductDeleteSafety | null>(null);
  const [deleteSafetyLoading, setDeleteSafetyLoading] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [bulkAction, setBulkAction] = useState<BulkActionState>(null); // stores the current bulk action confirmation content
  const [openStockManager, setOpenStockManager] = useState(false);
  const [openBulkPrice, setOpenBulkPrice] = useState(false);
  const [openSelectedProducts, setOpenSelectedProducts] = useState(false);
  const [openMobileBulkActions, setOpenMobileBulkActions] = useState(false);
  const [stockMode, setStockMode] = useState<"receive" | "correct">("receive");
  const [mobileStockStep, setMobileStockStep] = useState<1 | 2 | 3>(1);
  const [stockDirection, setStockDirection] = useState<"add" | "remove">("add");
  const [stockProductIds, setStockProductIds] = useState<string[]>([]);
  const [stockProductQuery, setStockProductQuery] = useState("");
  const [stockLookupResults, setStockLookupResults] = useState<Product[]>([]);
  const [stockLookupBusy, setStockLookupBusy] = useState(false);
  const [stockLineError, setStockLineError] = useState("");
  const [stockFieldErrors, setStockFieldErrors] = useState<StockFieldErrors>({});
  const [stockFocusProductId, setStockFocusProductId] = useState<string | null>(null);
  const [stockRows, setStockRows] = useState<Record<string, number>>({});
  const [stockApplyQty, setStockApplyQty] = useState(0);
  const [stockReason, setStockReason] = useState("");
  // bill attachment fields for restock
  const [stockBillFiles, setStockBillFiles] = useState<File[]>([]);
  const [stockBillDocuments, setStockBillDocuments] = useState<DocumentRecord[]>([]);
  const [stockSelectedBillIds, setStockSelectedBillIds] = useState<string[]>([]);
  const [stockBillsLoading, setStockBillsLoading] = useState(false);
  const [stockShowDocumentPicker, setStockShowDocumentPicker] = useState(false);
  const [stockSupplierName, setStockSupplierName] = useState("");
  const [stockSupplierMode, setStockSupplierMode] = useState<"existing" | "new">("existing");
  const [stockBillNumber, setStockBillNumber] = useState("");
  const [stockBillDate, setStockBillDate] = useState("");
  const [stockBillAmount, setStockBillAmount] = useState("");
  const [stockBillRemarks, setStockBillRemarks] = useState("");
  const [stockShowBillDetails, setStockShowBillDetails] = useState(false);
  const [stockBusy, setStockBusy] = useState(false);
  const [openStockQuickAdd, setOpenStockQuickAdd] = useState(false);
  const [quickStockProduct, setQuickStockProduct] = useState<QuickStockProductForm>({
    name: "",
    sku: "",
    brand: "",
    category: "",
    ratePerPiece: "",
    wholesalePrice: "",
    retailPrice: "",
    saleUnit: "PIECE",
  });
  const [quickStockError, setQuickStockError] = useState("");
  const [quickStockErrors, setQuickStockErrors] = useState<QuickStockErrors>({});
  const [quickStockBusy, setQuickStockBusy] = useState(false);
  const [priceRows, setPriceRows] = useState<
    Record<string, PriceDraft>
  >({});
  const [bulkPriceMode, setBulkPriceMode] = useState<BulkPriceMode>("CALCULATE");
  const [filteredPriceOverrides, setFilteredPriceOverrides] = useState<Record<string, PriceDraft>>({});
  const [wholesaleMarginPercent, setWholesaleMarginPercent] = useState(18);
  const [retailMarginPercent, setRetailMarginPercent] = useState(30);
  const [priceReason, setPriceReason] = useState("");
  const [bulkPriceErrors, setBulkPriceErrors] = useState<BulkPriceErrors>({});
  const priceReasonRef = React.useRef<HTMLInputElement>(null);
  const [priceSearch, setPriceSearch] = useState("");
  const [priceMarginTargetIds, setPriceMarginTargetIds] = useState<Record<string, boolean>>({});
  const [updateWholesalePrice, setUpdateWholesalePrice] = useState(true);
  const [updateRetailPrice, setUpdateRetailPrice] = useState(false);
  const [priceChangeDirection, setPriceChangeDirection] = useState<PriceChangeDirection>("INCREASE");
  const [existingSellingPricePolicy, setExistingSellingPricePolicy] = useState<ExistingSellingPricePolicy>("FILL_EMPTY");
  const [pricePreviewReady, setPricePreviewReady] = useState(false);
  const [bulkPriceNotice, setBulkPriceNotice] = useState<BulkPriceNotice>(null);
  const [bulkPriceTouched, setBulkPriceTouched] = useState(false);
  const [confirmDiscardBulkPrice, setConfirmDiscardBulkPrice] = useState(false);
  const [confirmBulkPriceSave, setConfirmBulkPriceSave] = useState(false);
  const [bulkPriceResult, setBulkPriceResult] = useState<{
    updatedCount: number;
    skippedCount: number;
    errorCount: number;
    errors: Array<{ productId: string; message: string; code?: string; name?: string; sku?: string }>;
    products: Array<{ id: string; name: string; sku: string }>;
    isPartialSuccess: boolean;
    auditWarning: string | null;
  } | null>(null);
  const [mobileStep1Tab, setMobileStep1Tab] = useState<"formula" | "products">("formula");
  const [explicitAdjustedIds, setExplicitAdjustedIds] = useState<Record<string, boolean>>({});
  const [showMobileDetails, setShowMobileDetails] = useState(false);
  const [priceBusy, setPriceBusy] = useState(false);
  type BulkPriceSortOption =
    | "affected_first"
    | "excluded_first"
    | "rate_desc"
    | "rate_asc"
    | "price_desc"
    | "stock_desc";

  const [bulkPriceSort, setBulkPriceSort] = useState<BulkPriceSortOption>("affected_first");
  const [openBulkPriceSortModal, setOpenBulkPriceSortModal] = useState(false);
  const filteredPreviewSort = bulkPriceSort === "rate_desc"
    || bulkPriceSort === "rate_asc"
    || bulkPriceSort === "price_desc"
    ? bulkPriceSort
    : "affected_first";


  const visibleBulkPriceProducts = useMemo(() => {
    const normalized = priceSearch.trim().toLocaleLowerCase();
    let list = !normalized
      ? [...selectedProducts]
      : selectedProducts.filter((product) =>
          [product.name, product.sku, product.barcode, product.brand, ...(product.searchAliases ?? [])]
            .filter(Boolean)
            .some((value) => String(value).toLocaleLowerCase().includes(normalized)),
        );

    const isProductExcluded = (p: typeof selectedProducts[number]) => priceMarginTargetIds[p.id] === false;

    const isProductAffected = (p: typeof selectedProducts[number], isExcluded: boolean) => {
      if (isExcluded) return false;
      if (p.availabilityStatus === "COMING_SOON") return false;
      if (!(Number(p.ratePerPiece) > 0)) return false;

      const row = priceRows[p.id];
      if (bulkPriceMode === "MANUAL") {
        const rate = Number(row?.ratePerPiece || 0);
        const wholesale = Number(row?.wholesalePrice || 0);
        const retail = Number(row?.retailPrice || 0);
        return (
          (Boolean(row?.ratePerPiece?.trim()) && rate !== Number(p.ratePerPiece)) ||
          (Boolean(row?.wholesalePrice?.trim()) && wholesale !== Number(p.wholesalePrice)) ||
          (Boolean(row?.retailPrice?.trim()) && retail !== Number(p.retailPrice))
        );
      }

      if (explicitAdjustedIds[p.id]) {
        const wholesale = Number(row?.wholesalePrice || 0);
        const retail = Number(row?.retailPrice || 0);
        return (wholesale > 0 && wholesale !== Number(p.wholesalePrice)) ||
               (retail > 0 && retail !== Number(p.retailPrice));
      }

      if (row && (Number(row.wholesalePrice || 0) > 0 || Number(row.retailPrice || 0) > 0)) {
        const wholesaleVal = Number(row.wholesalePrice || 0);
        const retailVal = Number(row.retailPrice || 0);
        const wholesaleDiff = updateWholesalePrice && wholesaleVal > 0 && wholesaleVal !== Number(p.wholesalePrice);
        const retailDiff = updateRetailPrice && retailVal > 0 && retailVal !== Number(p.retailPrice);
        if (wholesaleDiff || retailDiff) return true;
      }

      const wholesaleWillChange = updateWholesalePrice &&
        (existingSellingPricePolicy === "REPLACE" || !(Number(p.wholesalePrice) > 0));
      const retailWillChange = updateRetailPrice &&
        (existingSellingPricePolicy === "REPLACE" || !(Number(p.retailPrice) > 0));
      return wholesaleWillChange || retailWillChange;
    };

    return list.sort((a, b) => {
      const aExcluded = isProductExcluded(a);
      const bExcluded = isProductExcluded(b);
      const aAffected = isProductAffected(a, aExcluded);
      const bAffected = isProductAffected(b, bExcluded);

      switch (bulkPriceSort) {
        case "affected_first": {
          const rankA = aAffected ? 0 : aExcluded ? 2 : 1;
          const rankB = bAffected ? 0 : bExcluded ? 2 : 1;
          if (rankA !== rankB) return rankA - rankB;
          return (Number(b.ratePerPiece) || 0) - (Number(a.ratePerPiece) || 0) || a.name.localeCompare(b.name);
        }
        case "excluded_first": {
          const rankA = aExcluded ? 0 : aAffected ? 1 : 2;
          const rankB = bExcluded ? 0 : bAffected ? 1 : 2;
          if (rankA !== rankB) return rankA - rankB;
          return a.name.localeCompare(b.name);
        }
        case "rate_desc":
          return (Number(b.ratePerPiece) || 0) - (Number(a.ratePerPiece) || 0) || a.name.localeCompare(b.name);
        case "rate_asc":
          return (Number(a.ratePerPiece) || 0) - (Number(b.ratePerPiece) || 0) || a.name.localeCompare(b.name);
        case "price_desc":
          return (
            Math.max(Number(b.wholesalePrice) || 0, Number(b.retailPrice) || 0) -
            Math.max(Number(a.wholesalePrice) || 0, Number(a.retailPrice) || 0)
          ) || a.name.localeCompare(b.name);
        case "stock_desc":
          return (Number(b.stock) || 0) - (Number(a.stock) || 0) || a.name.localeCompare(b.name);
        default: {
          const rankA = aAffected ? 0 : aExcluded ? 2 : 1;
          const rankB = bAffected ? 0 : bExcluded ? 2 : 1;
          if (rankA !== rankB) return rankA - rankB;
          return a.name.localeCompare(b.name);
        }
      }
    });
  }, [
    priceSearch,
    selectedProducts,
    bulkPriceSort,
    priceMarginTargetIds,
    priceRows,
    bulkPriceMode,
    explicitAdjustedIds,
    updateWholesalePrice,
    updateRetailPrice,
    existingSellingPricePolicy,
  ]);

  const [filteredPreviewItems, setFilteredPreviewItems] = useState<Array<{
    productId: string;
    name: string;
    sku: string | null;
    currentRate: number | null;
    newRate: number | null;
    rate?: number | null;
    currentRetailPrice: number | null;
    newRetailPrice: number | null;
    currentWholesalePrice: number | null;
    newWholesalePrice: number | null;
    willChange: boolean;
  }>>([]);
  const [filteredPreviewLoaded, setFilteredPreviewLoaded] = useState(false);
  const [filteredPreviewStats, setFilteredPreviewStats] = useState<{
    matchedCount: number;
    previewCount: number;
    previewMatchedCount: number;
    previewPage: number;
    previewPageSize: number;
    previewTotalPages: number;
    skippedMissingRate: number;
    skippedComingSoon: number;
    skippedExisting: number;
  }>({
    matchedCount: 0,
    previewCount: 0,
    previewMatchedCount: 0,
    previewPage: 1,
    previewPageSize: 25,
    previewTotalPages: 1,
    skippedMissingRate: 0,
    skippedComingSoon: 0,
    skippedExisting: 0,
  });
  const [bulkPricePreviewRevision, setBulkPricePreviewRevision] = useState<string | null>(null);
  const [explicitReviewPreview, setExplicitReviewPreview] = useState<Awaited<ReturnType<typeof bulkUpdateProductPricesApi>> | null>(null);
  const [filteredReviewPreview, setFilteredReviewPreview] = useState<Awaited<ReturnType<typeof bulkUpdateProductPricesApi>> | null>(null);
  const [reviewPage, setReviewPage] = useState(1);
  const [reviewLoading, setReviewLoading] = useState(false);
  const reviewRequestIdRef = useRef(0);
  const [retryLoading, setRetryLoading] = useState(false);
  const [saveOutcomeUncertain, setSaveOutcomeUncertain] = useState(false);
  const [pendingInvalidPriceFocus, setPendingInvalidPriceFocus] = useState<{ productId: string; field: PriceField } | null>(null);
  const [invalidFilteredOverrideId, setInvalidFilteredOverrideId] = useState<string | null>(null);
  useEffect(() => { if (!openBulkPrice) reviewRequestIdRef.current += 1; }, [openBulkPrice]);

  const sampleFilteredProducts = useMemo(() => {
    return filteredPreviewItems.map((item) => ({
      id: item.productId,
      name: item.name,
      sku: item.sku || "",
      barcode: "",
      brand: "",
      ratePerPiece: item.rate ?? item.newRate,
      wholesalePrice: item.currentWholesalePrice,
      retailPrice: item.currentRetailPrice,
      availabilityStatus: "CATALOG_LISTED" as const,
      priceRuleWillChange: item.willChange,
    }));
  }, [filteredPreviewItems]);

  const visibleFilteredPreviewItems = useMemo(() => {
    if (!isFilteredSelection) return [];
    return filteredPreviewItems;
  }, [isFilteredSelection, filteredPreviewItems]);
  const lastFilteredPreviewRequestRef = React.useRef("");
  const lastFilteredSampleRequestRef = React.useRef("");
  const filteredPreviewRequestIdRef = React.useRef(0);

  const [bulkPriceStep1Page, setBulkPriceStep1Page] = useState(1);
  const BULK_PRICE_STEP1_PAGE_SIZE = 20;
  const [bulkPriceStep2Page, setBulkPriceStep2Page] = useState(1);
  const [bulkPriceStep2PageSize, setBulkPriceStep2PageSize] = useState(25);
  const [bulkPricePreviewFilter, setBulkPricePreviewFilter] = useState<"ALL" | "READY" | "PRESERVED">("ALL");
  const percentageIsValid = (value: number) =>
    value > 0 && (priceChangeDirection === "DECREASE" ? value < 100 : value <= 100);
  const priceMarginsValid =
    (!updateWholesalePrice || percentageIsValid(wholesaleMarginPercent)) &&
    (!updateRetailPrice || percentageIsValid(retailMarginPercent));

  useEffect(() => {
    setBulkPriceStep1Page(1);
    setBulkPriceStep2Page(1);
    if (isFilteredSelection) setFilteredPreviewLoaded(false);
  }, [priceSearch]);

  useEffect(() => {
    setBulkPriceStep1Page(1);
    setBulkPriceStep2Page(1);
  }, [bulkPriceSort]);

  useEffect(() => {
    setBulkPriceStep2Page(1);
  }, [pricePreviewReady]);

  useEffect(() => {
    if (!pricePreviewReady || !isFilteredSelection) return undefined;
    const requestKey = `${priceSearch.trim()}|${bulkPriceStep2PageSize}|${filteredPreviewSort}`;
    if (lastFilteredPreviewRequestRef.current === requestKey) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setPriceBusy(true);
      void loadFilteredPricePreview(1, priceSearch, bulkPriceStep2PageSize, controller.signal)
        .catch((error: any) => {
          if (controller.signal.aborted) return;
          const message = error?.response?.data?.error || error?.message || "The preview could not be refreshed.";
          setBulkPriceNotice({ tone: "danger", message });
        })
        .finally(() => { if (!controller.signal.aborted) setPriceBusy(false); });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      setPriceBusy(false);
    };
  }, [priceSearch, bulkPriceStep2PageSize, pricePreviewReady, isFilteredSelection, filteredPreviewSort]);

  useEffect(() => {
    if (!openBulkPrice || pricePreviewReady || !isFilteredSelection || bulkPriceMode !== "CALCULATE") return undefined;
    if ((!updateWholesalePrice && !updateRetailPrice) || !priceMarginsValid) return undefined;
    const requestKey = `${priceSearch.trim()}|${bulkPriceStep1Page}|${filteredPreviewSort}|${priceChangeDirection}|${wholesaleMarginPercent}|${retailMarginPercent}|${updateWholesalePrice}|${updateRetailPrice}|${existingSellingPricePolicy}|${filteredExcludedIds.join(",")}|${JSON.stringify(filteredPriceOverrides)}`;
    if (lastFilteredSampleRequestRef.current === requestKey) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setPriceBusy(true);
      void loadFilteredPricePreview(bulkPriceStep1Page, priceSearch, BULK_PRICE_STEP1_PAGE_SIZE, controller.signal)
        .then(() => { lastFilteredSampleRequestRef.current = requestKey; })
        .catch((error: any) => {
          if (controller.signal.aborted) return;
          setBulkPriceNotice({
            tone: "danger",
            message: error?.response?.data?.error || error?.message || "Products could not be loaded.",
          });
        })
        .finally(() => { if (!controller.signal.aborted) setPriceBusy(false); });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      setPriceBusy(false);
    };
  }, [openBulkPrice, pricePreviewReady, isFilteredSelection, bulkPriceMode, priceSearch, bulkPriceStep1Page, filteredPreviewSort, priceChangeDirection, wholesaleMarginPercent, retailMarginPercent, updateWholesalePrice, updateRetailPrice, existingSellingPricePolicy, priceMarginsValid, filteredExcludedIds, filteredPriceOverrides]);

  const step1TotalCount = isFilteredSelection
    ? (filteredPreviewLoaded ? filteredPreviewStats.previewMatchedCount : selectedCount)
    : visibleBulkPriceProducts.length;
  const compactBulkPriceFlow = !isFilteredSelection && selectedProducts.length > 0 && selectedProducts.length <= 5;
  const step1Items = isFilteredSelection ? sampleFilteredProducts : visibleBulkPriceProducts;
  const step1TotalPages = Math.max(1, Math.ceil(step1TotalCount / BULK_PRICE_STEP1_PAGE_SIZE));
  const activeStep1Page = Math.min(bulkPriceStep1Page, step1TotalPages);
  const paginatedStep1Items = useMemo(() => {
    if (isFilteredSelection) {
      if (sampleFilteredProducts.length <= BULK_PRICE_STEP1_PAGE_SIZE) {
        return sampleFilteredProducts;
      }
      const start = (activeStep1Page - 1) * BULK_PRICE_STEP1_PAGE_SIZE;
      return sampleFilteredProducts.slice(start, start + BULK_PRICE_STEP1_PAGE_SIZE);
    }
    const start = (activeStep1Page - 1) * BULK_PRICE_STEP1_PAGE_SIZE;
    return step1Items.slice(start, start + BULK_PRICE_STEP1_PAGE_SIZE);
  }, [isFilteredSelection, sampleFilteredProducts, step1Items, activeStep1Page]);

  const step2FilteredTotalPages = Math.max(1, filteredPreviewStats.previewTotalPages);
  const activeStep2FilteredPage = Math.min(filteredPreviewStats.previewPage, step2FilteredTotalPages);
  const paginatedFilteredPreviewItems = visibleFilteredPreviewItems;

  const explicitPreviewProducts = useMemo(() => visibleBulkPriceProducts.filter((product) => {
    const included = priceMarginTargetIds[product.id] !== false;
    if (bulkPricePreviewFilter === "PRESERVED") return !included;
    if (bulkPricePreviewFilter === "READY") {
      return included && (bulkPriceMode === "MANUAL" || (product.availabilityStatus !== "COMING_SOON" && Number(product.ratePerPiece) > 0));
    }
    return true;
  }), [visibleBulkPriceProducts, priceMarginTargetIds, bulkPricePreviewFilter, bulkPriceMode]);
  const step2ExplicitTotalPages = Math.max(1, Math.ceil(explicitPreviewProducts.length / bulkPriceStep2PageSize));
  const activeStep2ExplicitPage = Math.min(bulkPriceStep2Page, step2ExplicitTotalPages);
  const paginatedExplicitPreviewItems = useMemo(() => {
    const start = (activeStep2ExplicitPage - 1) * bulkPriceStep2PageSize;
    return explicitPreviewProducts.slice(start, start + bulkPriceStep2PageSize);
  }, [explicitPreviewProducts, activeStep2ExplicitPage, bulkPriceStep2PageSize]);

  useEffect(() => {
    if (!pendingInvalidPriceFocus || !pricePreviewReady || confirmBulkPriceSave) return;
    if (!isFilteredSelection) {
      if (bulkPricePreviewFilter !== "ALL") {
        setBulkPricePreviewFilter("ALL");
        return;
      }
      const index = visibleBulkPriceProducts.findIndex((product) => product.id === pendingInvalidPriceFocus.productId);
      if (index < 0) {
        if (priceSearch) setPriceSearch("");
        return;
      }
      const targetPage = Math.floor(index / bulkPriceStep2PageSize) + 1;
      if (activeStep2ExplicitPage !== targetPage) {
        setBulkPriceStep2Page(targetPage);
        return;
      }
    }
    const frame = window.requestAnimationFrame(() => {
      const targets = document.querySelectorAll<HTMLElement>(`[data-price-field="${pendingInvalidPriceFocus.productId}-${pendingInvalidPriceFocus.field}"]`);
      const visible = Array.from(targets).find((target) => target.getClientRects().length > 0);
      if (visible) {
        focusInvalidField(visible);
        setPendingInvalidPriceFocus(null);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingInvalidPriceFocus, pricePreviewReady, confirmBulkPriceSave, isFilteredSelection, visibleBulkPriceProducts, activeStep2ExplicitPage, bulkPriceStep2PageSize, priceSearch, filteredPreviewItems, bulkPricePreviewFilter]);

  const priceMarginTargetCount = selectedProducts.filter((product) => priceMarginTargetIds[product.id]).length;
  const selectedPriceStatus = useMemo(() => selectedProducts.reduce(
    (counts, product) => ({
      withRate: counts.withRate + (Number(product.ratePerPiece) > 0 ? 1 : 0),
      withWholesale: counts.withWholesale + (Number(product.wholesalePrice) > 0 ? 1 : 0),
      withRetail: counts.withRetail + (Number(product.retailPrice) > 0 ? 1 : 0),
      comingSoon: counts.comingSoon + (product.availabilityStatus === "COMING_SOON" ? 1 : 0),
    }),
    { withRate: 0, withWholesale: 0, withRetail: 0, comingSoon: 0 },
  ), [selectedProducts]);

  const [activeProductId, setActiveProductId] = useState<string | null>(null); // product currently being viewed, edited, or deleted
  const [formErrors, setFormErrors] = useState<ProductFormErrors>({}); // field-level validation messages for the product form
  const [productImageFile, setProductImageFile] = useState<File | null>(null); // uploaded image file waiting to be sent after save
  const [productImagePreview, setProductImagePreview] = useState(""); // local preview URL or existing product image URL
  const [productSearchTerms, setProductSearchTerms] = useState<string[]>([]);
  const [productSearchTermsBaseline, setProductSearchTermsBaseline] = useState("[]");
  const [productSearchTermsLoading, setProductSearchTermsLoading] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null); // selected CSV file for bulk import
  const [importBusy, setImportBusy] = useState(false); // disables repeated import submits while upload is running
  const [importProcessingKind, setImportProcessingKind] = useState<"spreadsheet" | "pdf" | "image" | null>(null);
  const importAbortRef = useRef<AbortController | null>(null);
  const [importError, setImportError] = useState(""); // import-specific error shown in the modal
  const [importResult, setImportResult] = useState<CsvImportResult | null>(null); // row-by-row result returned after CSV import completes
  const [pdfReviewBatch, setPdfReviewBatch] = useState<ProductImportBatch | null>(null); // selected supplier import preview batch for row review
  const [pdfReviewBusy, setPdfReviewBusy] = useState(false); // disables review submit while selected import rows are importing
  const [activeImportBatchId, setActiveImportBatchId] = useState<string | null>(null);
  const [importBatches, setImportBatches] = useState<ProductImportBatch[]>([]); // recent CSV/PDF/image review batches shown in the import modal
  const [importAttention, setImportAttention] = useState<{ count: number; batches: ProductImportBatchSummary[] } | null>(null);
  const [importDocuments, setImportDocuments] = useState<DocumentRecord[]>([]);
  const [importDocumentsLoading, setImportDocumentsLoading] = useState(false);
  const [importDocumentBusyId, setImportDocumentBusyId] = useState<string | null>(null);
  const [lastImportedProducts, setLastImportedProducts] = useState<ImportedProductSummary[]>([]);
  const [lastImportSupplier, setLastImportSupplier] = useState("");
  const [importTemplates, setImportTemplates] = useState<ProductImportTemplate[]>([]);
  const [importTemplateId, setImportTemplateId] = useState("");
  const [importSupplier, setImportSupplier] = useState("");
  const [importFieldMap, setImportFieldMap] = useState<Record<string, string>>({
    productName: "",
    sku: "",
    barcode: "",
    brand: "",
    category: "",
    variant: "",
    packageQuantity: "",
    saleUnit: "",
    wholesalePrice: "",
    retailPrice: "",
    ratePerPiece: "",
    stock: "",
  });

  const productsById = useMemo(() => {
    const entries = Object.values(selectedProductCache).map((product) => [product.id, product] as const);
    products.forEach((product) => entries.push([product.id, product]));
    return new Map(entries);
  }, [products, selectedProductCache]);
  const stockManagerProducts = useMemo(
    () =>
      stockProductIds
        .map((productId) => productsById.get(productId))
        .filter(Boolean) as Product[],
    [productsById, stockProductIds],
  );
  const selectedStockBillDocuments = useMemo(
    () => stockBillDocuments.filter((document) => stockSelectedBillIds.includes(document.id)),
    [stockBillDocuments, stockSelectedBillIds],
  );
  const stockSupplierOptions = useMemo(
    () =>
      Array.from(
        new Set(
          [
            ...products.map((product) => product.vendorSource?.trim()),
            ...stockBillDocuments.map((document) => document.supplierName?.trim()),
            ...importDocuments.map((document) => document.supplierName?.trim()),
            importSupplier.trim(),
            lastImportSupplier.trim(),
          ].filter((supplier): supplier is string => !!supplier),
        ),
      ).sort((a, b) => a.localeCompare(b)),
    [products, stockBillDocuments, importDocuments, importSupplier, lastImportSupplier],
  );
  const stockQtyInputRefs = React.useRef<Record<string, HTMLInputElement | null>>({});

  // finding the currently active product object once here keeps the modal and action handlers from repeating the same lookup
  const activeProduct = useMemo(
    () => (activeProductId ? productsById.get(activeProductId) || null : null),
    [productsById, activeProductId],
  );

  // seeding the form with safe defaults lets the add modal open instantly even before real metadata finishes loading
  const [form, setForm] = useState<Product>(() =>
    buildDefaultProductForm(
      ["All Brands", "CG Foods"],
      ["All Categories", "Groceries"],
      normalizeBusinessDefaults(),
    ),
  );

  // this opens the shared toast component with a single helper call
  function toastMsg(
    kind: ToastKind,
    message: string,
    options?: { durationMs?: number | null; persistent?: boolean },
  ) {
    showToast(kind === "danger" ? "danger" : kind, message, options);
  }

  function formatStatusOutcome(
    status: ProductStatus,
    changedCount: number,
    skippedCount: number,
  ) {
    const target = status === "Active" ? "active" : "inactive";
    const changedLabel =
      changedCount === 1
        ? `1 product set to ${target}`
        : `${changedCount} products set to ${target}`;
    const skippedLabel =
      skippedCount === 1
        ? `1 was already ${target}`
        : `${skippedCount} were already ${target}`;

    if (changedCount > 0 && skippedCount > 0) {
      return `${changedLabel}; ${skippedLabel}.`;
    }
    if (changedCount > 0) return `${changedLabel}.`;
    return `No changes made. ${skippedLabel}.`;
  }

  // resetting form validation before opening a fresh add/edit flow avoids showing stale errors from the previous product
  function clearFormValidation() {
    setFormErrors({});
  }

  // blob preview URLs need manual cleanup, otherwise repeated image changes slowly leak memory in the browser
  function revokePreview(url: string) {
    if (url.startsWith("blob:")) {
      URL.revokeObjectURL(url);
    }
  }

  // this clears the current image selection and safely disposes any old blob preview
  function resetImageState(nextPreview = "") {
    setProductImageFile(null);
    setProductImagePreview((current) => {
      revokePreview(current);
      return nextPreview;
    });
  }

  // clearing every import-related field together makes the CSV modal start from a clean state each time it opens
  function resetImportState() {
    importAbortRef.current?.abort();
    importAbortRef.current = null;
    setActiveImportBatchId(null);
    sessionStorage.removeItem("active_product_import_batch_id");
    window.dispatchEvent(
      new CustomEvent("active_product_import_changed", {
        detail: { batchId: null },
      })
    );
    setImportFile(null);
    setImportBusy(false);
    setImportProcessingKind(null);
    setImportError("");
    setImportResult(null);
    setPdfReviewBatch(null);
    setPdfReviewBusy(false);
    setLastImportedProducts([]);
    setLastImportSupplier("");
    setImportSupplier("");
    setImportTemplateId("");
  }

  // loading product meta and saved business defaults together keeps the filters and form defaults in sync
  async function loadMeta() {
    const [metaResult, settingsResult] = await Promise.allSettled([
      fetchProductsMeta(),
      getBusinessSettingsApi(),
    ]);

    if (metaResult.status === "fulfilled") {
      setBrands(["All Brands", ...metaResult.value.brands]);
      setCategories(["All Categories", ...metaResult.value.categories]);
    }
    if (settingsResult.status === "fulfilled") {
      setBusinessDefaults(normalizeBusinessDefaults(settingsResult.value));
    }

    const failure = [metaResult, settingsResult].find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
  }

  async function loadImportBatches() {
    const result = await listProductImportBatchesApi();
    setImportBatches(Array.isArray(result.batches) ? result.batches : []);
    setImportAttention(typeof result.attentionCount === "number" && Array.isArray(result.attentionBatches)
      ? { count: result.attentionCount, batches: result.attentionBatches }
      : null);
  }

  async function loadImportTemplates() {
    const result = await listProductImportTemplatesApi("CSV");
    setImportTemplates(Array.isArray(result.templates) ? result.templates : []);
  }

  async function loadStockBillDocuments() {
    try {
      setStockBillsLoading(true);
      const result = await listDocumentsApi({
        documentType: "STOCK_BILL",
        processingStatus: "UNPROCESSED",
        page: 1,
        pageSize: 20,
      });
      setStockBillDocuments(Array.isArray(result.documents) ? result.documents : []);
    } catch (error: any) {
      if (!isRateLimitError(error)) {
        toastMsg(
          "danger",
          error?.response?.data?.error || error?.message || "Failed to load uploaded stock bills.",
        );
      }
    } finally {
      setStockBillsLoading(false);
    }
  }

  async function loadImportDocuments() {
    try {
      setImportDocumentsLoading(true);
      const result = await listDocumentsApi({
        documentType: "PRODUCT_IMPORT",
        processingStatus: "UNPROCESSED",
        page: 1,
        pageSize: 20,
      });
      setImportDocuments(Array.isArray(result.documents) ? result.documents : []);
    } catch (error: any) {
      setImportError(
        isRateLimitError(error)
          ? "Import documents are temporarily paused and will resume automatically."
          : error?.response?.data?.error || error?.message || "Failed to load product import documents.",
      );
    } finally {
      setImportDocumentsLoading(false);
    }
  }

  async function openImportBatchById(batchId: string) {
    setOpenImport(false);
    navigate(`/products/imports/${encodeURIComponent(batchId)}`);
  }

  async function handleImportBatchCompleted(batchId: string) {
    sessionStorage.removeItem("active_product_import_batch_id");
    window.dispatchEvent(
      new CustomEvent("active_product_import_changed", {
        detail: { batchId: null },
      })
    );
    setActiveImportBatchId(null);
    setImportBusy(false);
    setImportProcessingKind(null);
    setOpenImport(false);
    await loadImportBatches();
    toastMsg("success", "Extraction finished. Review the saved rows and source coverage before importing.");
    navigate(`/products/imports/${encodeURIComponent(batchId)}`);
  }

  async function loadProducts(options?: {
    signal?: AbortSignal;
    requestId?: number;
  }) {
    const requestId =
      options?.requestId ?? productLoadRequestRef.current + 1;
    productLoadRequestRef.current = Math.max(
      productLoadRequestRef.current,
      requestId,
    );
    const filterIdentity = productFilterIdentityRef.current;
    const res = await fetchProducts(
      {
        q: debouncedQ || undefined,
        brand: brand === "All Brands" ? undefined : brand,
        category: category === "All Categories" ? undefined : category,
        stockStatus,
        status,
        lowOnly,
        page,
        pageSize: tablePageSize,
        sortBy,
        pricingStatus,
        photoStatus,
      },
      { signal: options?.signal },
    );

    if (!isCurrentRequestIdentity({
      requestId,
      currentRequestId: productLoadRequestRef.current,
      filterIdentity,
      currentFilterIdentity: productFilterIdentityRef.current,
    })) {
      return false;
    }
    const lastPage = Math.max(1, Math.ceil(res.total / tablePageSize));
    if (page > lastPage) setPage(lastPage);
    setProducts(res.items);
    setTotal(res.total);
    setActiveSearchLogId(res.searchLogId);
    return true;
  }

  async function refreshProductsAfterSavedMutation() {
    const outcome = await refreshAfterSuccessfulMutation(() => loadProducts());
    if (outcome === "saved_refresh_failed") {
      toastMsg("info", "Saved; the product list could not refresh.");
    }
  }

  React.useEffect(() => {
    // cleaning up the last blob preview when the component unmounts or the preview url changes
    return () => revokePreview(productImagePreview);
  }, [productImagePreview]);

  React.useEffect(() => {
    // Product rows are loaded by the filter-driven effect below. A lightweight
    // batch request keeps unfinished import work visible from the catalog;
    // templates still load only when the import workspace opens.
    const timer = window.setTimeout(() => {
      void (async () => {
        void loadImportBatches().catch(() => undefined);
        try {
          await loadMeta();
          productMetaRecoveryNeededRef.current = false;
        } catch (error: any) {
          if (isRateLimitError(error)) {
            productMetaRecoveryNeededRef.current = true;
          } else if (error?.code !== "ERR_CANCELED") {
            toastMsg("danger", error?.message || "Failed to load products.");
          }
        }
      })();
    }, 100);

    return () => window.clearTimeout(timer);
  }, [productRecoveryKey]);

  React.useEffect(() => {
    const recover = () => {
      if (
        !productMetaRecoveryNeededRef.current &&
        !productRowsRecoveryNeededRef.current
      ) {
        return;
      }
      productMetaRecoveryNeededRef.current = false;
      productRowsRecoveryNeededRef.current = false;
      setProductRecoveryKey((current) => current + 1);
    };
    window.addEventListener("rate_limit_cleared", recover);
    return () => window.removeEventListener("rate_limit_cleared", recover);
  }, []);

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      if (q.trim() === debouncedQ) return;
      if (isFilteredSelection) {
        setPendingProductFilterChange({ kind: "search", value: q });
        return;
      }
      setDebouncedQ(q.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [q, debouncedQ, isFilteredSelection]);


  React.useEffect(() => {
    const visibleSelected = products.filter((product) => selected[product.id]);
    if (visibleSelected.length === 0) return;
    setSelectedProductCache((current) => ({
      ...current,
      ...Object.fromEntries(visibleSelected.map((product) => [product.id, product])),
    }));
  }, [products, selected]);

  React.useEffect(() => {
    if (productLookupEditHandoff) return undefined;
    const controller = new AbortController();
    const requestId = productLoadRequestRef.current + 1;
    productLoadRequestRef.current = requestId;
    const filterIdentity = productFilterIdentityRef.current;
    setProductsLoading(true);
    setProductsLoadError("");
    void loadProducts({ signal: controller.signal, requestId })
      .then((applied) => {
        if (applied) productRowsRecoveryNeededRef.current = false;
      })
      .catch((error: any) => {
        if (error?.code === "ERR_CANCELED") return;
        if (
          productLoadRequestRef.current !== requestId ||
          productFilterIdentityRef.current !== filterIdentity
        ) return;
        if (
          error?.code === "ERR_RATE_LIMIT_COOLDOWN" ||
          error?.response?.status === 429
        ) {
          productRowsRecoveryNeededRef.current = true;
          setProductsLoadError(
            "Product data is temporarily paused and will refresh automatically.",
          );
        } else {
          setProductsLoadError("Products could not be loaded. Please try again.");
          toastMsg("danger", error?.message || "Failed to load products.");
        }
      })
      .finally(() => {
        if (
          productLoadRequestRef.current === requestId &&
          productFilterIdentityRef.current === filterIdentity
        ) {
          setProductsLoading(false);
        }
      });
    return () => controller.abort();
  }, [
    debouncedQ,
    brand,
    category,
    stockStatus,
    status,
    lowOnly,
    page,
    tablePageSize,
    sortBy,
    pricingStatus,
    photoStatus,
    productRecoveryKey,
    productLookupEditHandoff,
  ]);

  React.useEffect(() => {
    const savedBatchId = sessionStorage.getItem("active_product_import_batch_id");
    if (savedBatchId) {
      setActiveImportBatchId(savedBatchId);
      window.dispatchEvent(
        new CustomEvent("active_product_import_changed", {
          detail: { batchId: savedBatchId },
        })
      );
    }
  }, []);

  React.useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("active_product_import_modal_state", {
        detail: { open: openImport },
      })
    );
  }, [openImport]);

  React.useEffect(() => {
    function handleReopen() {
      setOpenImport(true);
    }
    window.addEventListener("reopen_product_import_modal", handleReopen);
    return () => window.removeEventListener("reopen_product_import_modal", handleReopen);
  }, []);

  React.useEffect(() => {
    if (searchParams.get("openImport") === "true") {
      setOpenImport(true);
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.delete("openImport");
        return next;
      }, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  React.useEffect(() => {
    if (!requestedImportBatchId) return;
    void openImportBatchById(requestedImportBatchId);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("importBatch");
      return next;
    }, { replace: true });
  }, [requestedImportBatchId]);

  React.useLayoutEffect(() => {
    if (!requestedEditProductId || !isAdmin) return;
    const requestKey = `${requestedEditProductId}:${requestedEditReturnTo}`;
    if (handledEditRequestRef.current === requestKey) return;

    if (productLookupEditHandoff?.product.id === requestedEditProductId) {
      handledEditRequestRef.current = requestKey;
      setReturnAfterProductEdit(
        requestedEditReturnTo.startsWith("/product-lookup")
          ? requestedEditReturnTo
          : "",
      );
      setReturnAfterProductEditSnapshot(productLookupEditHandoff.snapshot);
      openEdit(productLookupEditHandoff.product);
      return;
    }

    const controller = new AbortController();
    let active = true;
    setReturnAfterProductEditSnapshot(undefined);
    setOpeningRequestedEditProduct(true);
    void fetchProductsByIds([requestedEditProductId], {
      signal: controller.signal,
    })
      .then(([product]) => {
        if (!active) return;
        handledEditRequestRef.current = requestKey;
        if (!product) {
          toastMsg("danger", "That product could not be found. It may have been removed.");
          return;
        }
        setSelectedProductCache((current) => ({
          ...current,
          [product.id]: product,
        }));
        setReturnAfterProductEdit(
          requestedEditReturnTo.startsWith("/product-lookup")
            ? requestedEditReturnTo
            : "",
        );
        openEdit(product);
      })
      .catch((error: any) => {
        if (!active || controller.signal.aborted || error?.code === "ERR_CANCELED") return;
        toastMsg("danger", error?.message || "Failed to open the product editor.");
      })
      .finally(() => {
        if (active) setOpeningRequestedEditProduct(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [
    isAdmin,
    productLookupEditHandoff,
    requestedEditProductId,
    requestedEditReturnTo,
  ]);

  React.useEffect(() => {
    if (!openImport || pdfReviewBatch) return;
    void loadImportDocuments();
  }, [openImport, pdfReviewBatch?.id]);

  React.useEffect(() => {
    if (!openStockManager) return;
    const query = stockProductQuery.trim();
    if (query.length < 2) {
      setStockLookupResults([]);
      setStockLookupBusy(false);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        setStockLookupBusy(true);
        setStockLineError("");
        const result = await fetchProducts(
          { q: query, status: "active", page: 1, pageSize: 20 },
          { signal: controller.signal },
        );
        setStockLookupResults(
          result.items.filter((product: Product) => !stockProductIds.includes(product.id)),
        );
      } catch (error: any) {
        if (controller.signal.aborted || error?.code === "ERR_CANCELED") return;
        setStockLookupResults([]);
        setStockLineError(error?.message || "Failed to search products.");
      } finally {
        setStockLookupBusy(false);
      }
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [openStockManager, stockProductIds, stockProductQuery]);

  React.useEffect(() => {
    if (!openStockManager || stockMode !== "receive") return;
    void loadStockBillDocuments();
  }, [openStockManager, stockMode]);

  React.useEffect(() => {
    if (!stockFocusProductId) return;
    const input = stockQtyInputRefs.current[stockFocusProductId];
    if (!input) return;
    input.focus();
    input.select();
    setStockFocusProductId(null);
  }, [stockFocusProductId, stockManagerProducts]);

  const totalPages = Math.max(1, Math.ceil(total / tablePageSize));
  const pageClamped = clampPage(page, 1, totalPages); // protecting against stale page numbers after the dataset changes
  const pageItems = products;
  const pageStart = total === 0 ? 0 : (pageClamped - 1) * tablePageSize;
  const pageEnd = total === 0 ? 0 : pageStart + pageItems.length;
  const actionableImportBatches = useMemo(
    () => importAttention?.batches ?? importBatches
      .filter((batch) => batch.status !== "IMPORTED")
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()),
    [importBatches, importAttention],
  );
  const effectiveSelected = useMemo(
    () =>
      isFilteredSelection
        ? Object.fromEntries(
            pageItems.map((product) => [
              product.id,
              !filteredSelectionExclusions[product.id],
            ]),
          )
        : selected,
    [isFilteredSelection, pageItems, selected, filteredSelectionExclusions],
  );
  const allPageRowsSelected =
    pageItems.length > 0 && pageItems.every((product) => effectiveSelected[product.id]);
  const canSelectAllMatching =
    !isFilteredSelection && allPageRowsSelected && total > pageItems.length;
  const currentProductFilters = useMemo(
    () => ({
      search: debouncedQ || undefined,
      brand: brand === "All Brands" ? undefined : brand,
      category: category === "All Categories" ? undefined : category,
      isActive: status === "active",
      lowStockOnly: lowOnly || stockStatus === "low" ? true : undefined,
      stockStatus: stockStatus !== "all" ? stockStatus : undefined,
    }),
    [debouncedQ, brand, category, status, lowOnly, stockStatus],
  );
  const isProductEditorDirty =
    openAddEdit &&
    (JSON.stringify(form) !== productEditorBaseline ||
      productImagePreview !== productEditorImageBaseline ||
      Boolean(productImageFile) ||
      JSON.stringify(productSearchTerms) !== productSearchTermsBaseline);

  React.useEffect(() => {
    if (!isProductEditorDirty) return undefined;
    function warnBeforeLeaving(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [isProductEditorDirty]);


  function applyProductFilterChange(change: PendingProductFilterChange) {
    setPage(1);
    if (change.kind === "search") {
      setQ(change.value);
      setDebouncedQ(change.value.trim());
    } else if (change.kind === "brand") {
      setBrand(change.value);
    } else if (change.kind === "category") {
      setCategory(change.value);
    } else if (change.kind === "stockStatus") {
      setStockStatus(change.value);
    } else if (change.kind === "status") {
      setStatus(change.value);
    } else if (change.kind === "sortBy") {
      setSortBy(change.value);
    } else if (change.kind === "pricingStatus") {
      setPricingStatus(change.value);
    } else if (change.kind === "photoStatus") {
      setPhotoStatus(change.value);
    } else if (change.kind === "lowOnly") {
      setLowOnly(change.value);
    } else {
      setQ("");
      setDebouncedQ("");
      setBrand("All Brands");
      setCategory("All Categories");
      setStockStatus("all");
      setStatus("active");
      setSortBy("photos_first");
      setPricingStatus("all");
      setPhotoStatus("all");
      setLowOnly(false);
    }
  }

  function requestProductFilterChange(change: PendingProductFilterChange) {
    if (isFilteredSelection) {
      setPendingProductFilterChange(change);
      return;
    }
    applyProductFilterChange(change);
  }

  function confirmProductFilterChange() {
    if (!pendingProductFilterChange) return;
    const change = pendingProductFilterChange;
    setPendingProductFilterChange(null);
    clearBulkSelection();
    applyProductFilterChange(change);
  }

  function cancelProductFilterChange() {
    if (pendingProductFilterChange?.kind === "search") setQ(debouncedQ);
    setPendingProductFilterChange(null);
  }

  function updateBrand(value: string) {
    requestProductFilterChange({ kind: "brand", value });
  }

  function updateCategory(value: string) {
    requestProductFilterChange({ kind: "category", value });
  }

  function updateStockStatus(value: "all" | "in" | "low" | "out") {
    requestProductFilterChange({ kind: "stockStatus", value });
  }

  function updateStatus(value: "active" | "inactive") {
    requestProductFilterChange({ kind: "status", value });
  }

  function updateSortBy(value: ProductSortBy) {
    requestProductFilterChange({ kind: "sortBy", value });
  }

  function updatePricingStatus(value: ProductPricingStatus) {
    requestProductFilterChange({ kind: "pricingStatus", value });
  }

  function updatePhotoStatus(value: ProductPhotoStatus) {
    requestProductFilterChange({ kind: "photoStatus", value });
  }

  function updateLowOnly(value: boolean) {
    requestProductFilterChange({ kind: "lowOnly", value });
  }

  // this resets every filter control back to its default value
  function clearFilters() {
    requestProductFilterChange({ kind: "clear" });
  }

  function clearBulkSelection() {
    setSelected({});
    setSelectedProductCache({});
    setFilteredSelectionExclusions({});
    setBulkSelectionScope("page");
    setOpenSelectedProducts(false);
  }

  function selectAllMatchingProducts() {
    setSelected(Object.fromEntries(products.map((product) => [product.id, true])));
    setSelectedProductCache(
      Object.fromEntries(products.map((product) => [product.id, product])),
    );
    setFilteredSelectionExclusions({});
    setBulkSelectionScope("filtered");
  }

  // toggling every checkbox on the current visible page is used by the bulk action buttons above the table
  function toggleAllOnPage(checked: boolean) {
    if (isFilteredSelection) {
      const nextExcludedCount = new Set([
        ...filteredExcludedIds,
        ...pageItems.map((product) => product.id),
      ]).size;
      if (!checked && nextExcludedCount >= total) {
        clearBulkSelection();
        return;
      }
      setFilteredSelectionExclusions((current) => {
        const next = { ...current };
        pageItems.forEach((product) => {
          if (checked) delete next[product.id];
          else next[product.id] = product;
        });
        return next;
      });
      return;
    }
    const next = { ...selected };
    pageItems.forEach((product) => {
      next[product.id] = checked;
    });
    setSelected(next);
    setSelectedProductCache((current) => {
      const nextCache = { ...current };
      pageItems.forEach((product) => {
        if (checked) nextCache[product.id] = product;
        else delete nextCache[product.id];
      });
      return nextCache;
    });
  }

  // this updates one checkbox inside the selected map without losing the rest of the selected rows
  function toggleOne(id: string, checked: boolean) {
    if (isFilteredSelection) {
      if (!checked && filteredExcludedIds.length + 1 >= total) {
        clearBulkSelection();
        return;
      }
      setFilteredSelectionExclusions((current) => {
        const next = { ...current };
        if (checked) delete next[id];
        else {
          const product = productsById.get(id);
          if (product) next[id] = product;
        }
        return next;
      });
      return;
    }
    setSelected((prev) => ({ ...prev, [id]: checked }));
    setSelectedProductCache((current) => {
      const next = { ...current };
      const product = productsById.get(id);
      if (checked && product) next[id] = product;
      if (!checked) delete next[id];
      return next;
    });
  }

  // this opens the add product modal with a brand-new form based on the latest business defaults
  function openAdd() {
    productAliasRequestRef.current += 1;
    const nextForm = buildDefaultProductForm(brands, categories, businessDefaults);
    setReturnAfterProductEdit("");
    setActiveProductId(null);
    setForm(nextForm);
    setProductEditorBaseline(JSON.stringify(nextForm));
    setProductEditorImageBaseline("");
    setConfirmDiscardProductEditor(false);
    setProductSearchTerms([]);
    setProductSearchTermsBaseline("[]");
    setProductSearchTermsLoading(false);
    clearFormValidation();
    resetImageState("");
    setOpenAddEdit(true);
  }

  function trackSearchSelection(
    product: Product,
    action: ProductSearchSelectionAction,
  ) {
    if (!debouncedQ || !activeSearchLogId) return;
    void recordProductSearchSelectionApi({
      searchLogId: activeSearchLogId,
      productId: product.id,
      action,
    }).catch(() => undefined);
  }

  // this opens the edit modal using the selected product's current values
  function openEdit(product: Product) {
    trackSearchSelection(product, "EDIT_PRODUCT");
    const nextForm = { ...product };
    setActiveProductId(product.id);
    setForm(nextForm);
    setProductEditorBaseline(JSON.stringify(nextForm));
    setProductEditorImageBaseline(product.imageUrl || "");
    setConfirmDiscardProductEditor(false);
    setProductSearchTerms([]);
    setProductSearchTermsBaseline("[]");
    if (isAdmin) {
      const aliasRequestId = productAliasRequestRef.current + 1;
      productAliasRequestRef.current = aliasRequestId;
      setProductSearchTermsLoading(true);
      void listProductSearchAliasesApi(product.id)
        .then((aliases) => {
          if (productAliasRequestRef.current !== aliasRequestId) return;
          const terms = aliases
            .filter((alias) => alias.isEnabled)
            .map((alias) => alias.alias);
          setProductSearchTerms(terms);
          setProductSearchTermsBaseline(JSON.stringify(terms));
        })
        .catch((error: any) => {
          if (productAliasRequestRef.current !== aliasRequestId) return;
          toastMsg("danger", error?.message || "Search terms could not be loaded.");
        })
        .finally(() => {
          if (productAliasRequestRef.current === aliasRequestId) {
            setProductSearchTermsLoading(false);
          }
        });
    }
    clearFormValidation();
    resetImageState(product.imageUrl || "");
    setOpenAddEdit(true);
  }

  function closeProductEditor() {
    productAliasRequestRef.current += 1;
    setOpenAddEdit(false);
    setConfirmDiscardProductEditor(false);
    setActiveProductId(null);
    clearFormValidation();
    resetImageState("");
    setProductSearchTerms([]);
    setProductSearchTermsBaseline("[]");
    setProductSearchTermsLoading(false);
  }

  function closeProductEditorAndReturn() {
    const returnTo = returnAfterProductEdit;
    const returnSnapshot = returnAfterProductEditSnapshot;
    if (returnTo.startsWith("/product-lookup")) {
      setReturnAfterProductEdit("");
      setReturnAfterProductEditSnapshot(undefined);
      const productLookupRestoreKey = returnSnapshot
        ? stageProductLookupRestore(returnSnapshot)
        : undefined;
      navigate(returnTo, {
        replace: true,
        state: productLookupRestoreKey
          ? { productLookupRestoreKey }
          : undefined,
      });
      return;
    }
    closeProductEditor();
  }

  function requestCloseProductEditor() {
    if (productSaveBusy) return;
    if (isProductEditorDirty) {
      setConfirmDiscardProductEditor(true);
      return;
    }
    closeProductEditorAndReturn();
  }

  // this keeps the view modal and edit modal connected so the user can jump straight from one into the other
  function openEditFromView() {
    if (!activeProduct) return;
    setOpenView(false);
    openEdit(activeProduct);
  }

  // storing the product id before opening the view modal lets the shared modal read the right product record
  function openViewProduct(product: Product) {
    trackSearchSelection(product, "VIEW_DETAILS");
    setSelectedProductCache((current) => ({ ...current, [product.id]: product }));
    setActiveProductId(product.id);
    setOpenView(true);
  }

  // this prepares the single-product delete decision dialog
  async function requestDelete(product: Product) {
    setActiveProductId(product.id);
    setDeleteSafety(null);
    setOpenConfirmDelete(true);
    if (!isAdmin) return;

    try {
      setDeleteSafetyLoading(true);
      const safety = await getProductDeleteSafety(product.id);
      setDeleteSafety(safety);
    } catch (error: any) {
      toastMsg("danger", error?.message || "Failed to check product delete safety.");
    } finally {
      setDeleteSafetyLoading(false);
    }
  }

  // this handles image uploads inside the add/edit modal
  // it clears the image, blocks non-image files, and creates a local preview for valid selections
  function handleProductImageChange(file: File | null) {
    if (!file) {
      resetImageState("");
      setForm((current) => ({ ...current, imageUrl: "" }));
      setFormErrors((prev) => ({ ...prev, image: undefined }));
      return;
    }

    // blocking files that are not images avoids sending invalid uploads to the backend later
    if (!file.type.startsWith("image/")) {
      setFormErrors((prev) => ({
        ...prev,
        image: "Select a valid image file.",
      }));
      return;
    }

    const nextPreview = URL.createObjectURL(file); // creating a temporary browser URL so the user can preview the selected image immediately
    setProductImageFile(file);
    setProductImagePreview((current) => {
      revokePreview(current);
      return nextPreview;
    });
    setFormErrors((prev) => ({ ...prev, image: undefined }));
  }

  // validating the product form before save helps us stop obvious bad data before making any API call
  function collectProductFormErrors() {
    const errors: ProductFormErrors = {};

    if (!form.name.trim()) {
      errors.name = "Product name is required.";
    }
    if (!form.brand.trim() || form.brand === "All Brands") {
      errors.brand = "Brand is required.";
    }
    if (!form.category.trim() || form.category === "All Categories") {
      errors.category = "Category is required.";
    }
    if (form.availabilityStatus !== "COMING_SOON" && ![form.ratePerPiece, form.retailPrice, form.wholesalePrice].some((value) => Number(value) > 0)) {
      errors.ratePerPiece = "Enter an announced price or mark this product as Coming soon.";
    } else if (
      form.ratePerPiece !== null &&
      (!Number.isFinite(form.ratePerPiece) || form.ratePerPiece <= 0)
    ) {
      errors.ratePerPiece = "Rate must be greater than 0.";
    }
    if (
      form.retailPrice !== null &&
      (!Number.isFinite(form.retailPrice) || form.retailPrice <= 0)
    ) {
      errors.retailPrice = "Retail price must be greater than 0 or left blank.";
    }
    if (
      form.wholesalePrice !== null &&
      (!Number.isFinite(form.wholesalePrice) || form.wholesalePrice <= 0)
    ) {
      errors.wholesalePrice = "Wholesale price must be greater than 0 or left blank.";
    }
    if (
      form.wholesalePrice !== null &&
      form.retailPrice !== null &&
      form.wholesalePrice > 0 &&
      form.retailPrice > 0 &&
      form.wholesalePrice > form.retailPrice
    ) {
      errors.wholesalePrice = "Wholesale price cannot be higher than retail price.";
    }
    if (
      form.thresholdQtyMode === "custom" &&
      (!Number.isFinite(form.thresholdQty) || form.thresholdQty < 1)
    ) {
      errors.thresholdQty = "Wholesale threshold must be at least 1.";
    }
    if (!Number.isFinite(form.stock) || form.stock < 0) {
      errors.stock = "Stock cannot be negative.";
    }
    if (
      form.lowStockThresholdMode === "custom" &&
      (!Number.isFinite(form.lowStockThreshold) || form.lowStockThreshold < 0)
    ) {
      errors.lowStockThreshold = "Stock alert threshold cannot be negative.";
    }
    if (
      form.packageQuantity !== null &&
      (!Number.isFinite(form.packageQuantity) || form.packageQuantity <= 0)
    ) {
      errors.packageQuantity = "Package quantity must be greater than 0.";
    }
    if (!Number.isFinite(form.quantityStep) || form.quantityStep <= 0) {
      errors.quantityStep = "Quantity step must be greater than 0.";
    }
    if (!form.allowFractionalQty && form.quantityStep !== 1) {
      errors.quantityStep = "Piece-based products must use a step of 1.";
    }

    return errors;
  }

  function validateForm() {
    const errors = collectProductFormErrors();
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }

  function validateProductStep(step: "basic" | "units" | "pricing" | "stock") {
    const errors = collectProductFormErrors();
    const keysByStep: Record<typeof step, Array<keyof ProductFormErrors>> = {
      basic: ["name", "brand", "category", "image", "sku"],
      units: ["packageQuantity", "quantityStep"],
      pricing: ["ratePerPiece", "wholesalePrice", "retailPrice", "thresholdQty"],
      stock: ["stock", "lowStockThreshold"],
    };
    const stepKeys = keysByStep[step];
    const stepErrors = Object.fromEntries(
      stepKeys.filter((key) => errors[key]).map((key) => [key, errors[key]]),
    ) as ProductFormErrors;
    setFormErrors((current) => ({
      ...Object.fromEntries(Object.entries(current).filter(([key]) => !stepKeys.includes(key as keyof ProductFormErrors))),
      ...stepErrors,
    }));
    return Object.keys(stepErrors).length === 0;
  }

  // this saves either a new product or edits an existing one, then optionally uploads its image
  async function saveProduct() {
    if (productSaveBusy) return;
    // stopping here keeps invalid form data from reaching the backend
    if (!validateForm()) return;

    try {
      setProductSaveBusy(true);
      const wasEditing = Boolean(activeProductId);
      const editReturnTo = wasEditing ? returnAfterProductEdit : "";
      const editReturnSnapshot = wasEditing
        ? returnAfterProductEditSnapshot
        : undefined;
      // normalizing user-entered values before save keeps empty strings and default thresholds consistent
      const payload = {
        ...form,
        name: form.name.trim(),
        productName: form.productName?.trim() || form.name.trim(),
        sku: form.sku.trim(),
        barcode: form.barcode?.trim() || "",
        imageUrl: form.imageUrl || null,
        categoryGroup: form.categoryGroup?.trim() || "",
        vendorSource: form.vendorSource?.trim() || "",
        productCodeVariant: form.productCodeVariant?.trim() || "",
        sizeValue:
          form.sizeValue === null || form.sizeValue === undefined
            ? null
            : Math.max(0, Number(form.sizeValue || 0)),
        sizeUnit: form.sizeUnit || "STANDARD",
        ratePerPiece:
          form.ratePerPiece === null
            ? null
            : Math.max(0.01, Number(form.ratePerPiece)),
        packageQuantity: Math.max(0.001, Number(form.packageQuantity || 1)),
        packageUnit: form.packageUnit || "PIECE",
        saleUnit: form.saleUnit || "PIECE",
        allowFractionalQty: Boolean(form.allowFractionalQty),
        quantityStep: form.allowFractionalQty
          ? Math.max(0.001, Number(form.quantityStep || 0.001))
          : 1,
        wholesaleEligible: Boolean(form.wholesaleEligible),
        sourceCitation: form.sourceCitation?.trim() || "",
        category: form.category?.trim() || "",
        wholesalePrice: form.wholesaleEligible
          ? Number(form.wholesalePrice)
          : Number(form.retailPrice),
        thresholdQty:
          form.thresholdQtyMode === "default"
            ? businessDefaults.defaultWholesaleQtyThreshold
            : Math.max(1, Number(form.thresholdQty || 1)),
        stock: Math.max(0, Number(form.stock || 0)),
        lowStockThreshold:
          form.lowStockThresholdMode === "default"
            ? businessDefaults.defaultLowStockThreshold
            : Math.max(0, Number(form.lowStockThreshold || 0)),
      };
      delete (payload as any).id;

      // deciding between create and update based on whether a product is currently active in edit mode
      let savedProduct = activeProductId
        ? await updateProduct(activeProductId, payload as any)
        : await createProduct(payload as any);

      let imageUploadError = "";
      // uploading the image after the product save gives us the real saved product id to attach it to
      if (productImageFile) {
        try {
          savedProduct = await uploadProductImage(savedProduct.id, productImageFile);
        } catch (error: any) {
          // this handles when the image upload fails after the product itself was already saved
          imageUploadError = error?.message || "Image upload failed.";
          setFormErrors((prev) => ({
            ...prev,
            image: imageUploadError,
          }));
        }
      }

      if (isAdmin) {
        try {
          const aliases = await replaceProductSearchAliasesApi({
            productId: savedProduct.id,
            aliases: productSearchTerms,
          });
          const savedTerms = aliases.map((alias) => alias.alias);
          setProductSearchTerms(savedTerms);
          setProductSearchTermsBaseline(JSON.stringify(savedTerms));
        } catch (error: any) {
          toastMsg(
            "danger",
            `Product saved, but its search terms were not updated: ${error?.message || "Unknown error"}`,
            { persistent: true },
          );
        }
      }

      // resetting the editor state after a successful save keeps the next open modal clean
      clearBulkSelection();

      // A lookup-originated edit returns immediately to the preserved lookup
      // context. That page reloads the saved product, so refreshing this hidden
      // catalog first would only leave the user staring at an unrelated page.
      if (wasEditing && editReturnTo.startsWith("/product-lookup")) {
        setReturnAfterProductEdit("");
        setReturnAfterProductEditSnapshot(undefined);
        toastMsg(
          imageUploadError ? "danger" : "success",
          imageUploadError
            ? `Product saved, but image upload failed: ${imageUploadError}`
            : "Product updated.",
        );
        const restoredSnapshot = editReturnSnapshot
          ? {
              ...editReturnSnapshot,
              products: editReturnSnapshot.products.map((product) =>
                product.id === savedProduct.id ? savedProduct : product,
              ),
              mobileProducts: editReturnSnapshot.mobileProducts.map((product) =>
                product.id === savedProduct.id ? savedProduct : product,
              ),
            }
          : undefined;
        const productLookupRestoreKey = restoredSnapshot
          ? stageProductLookupRestore(restoredSnapshot)
          : undefined;
        navigate(editReturnTo, {
          replace: true,
          state: productLookupRestoreKey
            ? { productLookupRestoreKey }
            : undefined,
        });
        return;
      }

      closeProductEditor();
      const [catalogRefresh] = await Promise.allSettled([loadProducts(), loadMeta()]);
      if (catalogRefresh.status === "rejected") {
        toastMsg("info", "Product saved. The catalog list will refresh automatically when the connection recovers.");
      }

      if (!wasEditing) {
        setProductSaveSuccess({ product: savedProduct, imageUploadError });
        return;
      }

      // edits stay lightweight; creation uses the richer next-action dialog
      if (imageUploadError) {
        toastMsg(
          "danger",
          `Product saved, but image upload failed: ${imageUploadError}`,
        );
        return;
      }

      toastMsg("success", "Product updated.");
    } catch (error: any) {
      // this handles any create or update failure from the product API
      toastMsg("danger", error?.message || "Failed to save product.");
    } finally {
      setProductSaveBusy(false);
    }
  }

  // this bulk action turns every selected product back to Active state
  async function activateSelected() {
    if (isFilteredSelection) {
      toastMsg("info", "Activate requires specific product selection. Clear this selection and choose the exact rows you want to change.");
      return;
    }
    if (selectedIds.length === 0) return;
    const idsToActivate = selectedProducts
      .filter((product) => product.status !== "Active")
      .map((product) => product.id);
    const skippedCount = selectedIds.length - idsToActivate.length;
    if (idsToActivate.length === 0) {
      toastMsg("info", formatStatusOutcome("Active", 0, skippedCount));
      clearBulkSelection();
      return;
    }
    try {
      const result = await bulkSetStatus(idsToActivate, "Active");
      toastMsg(
        result.changedCount > 0 ? "success" : "info",
        formatStatusOutcome("Active", result.changedCount, skippedCount + result.skippedCount),
      );
      clearBulkSelection();
      await refreshProductsAfterSavedMutation();
    } catch (error: any) {
      toastMsg("danger", error?.message || "Failed to activate selected.");
    }
  }

  // this opens the bulk confirmation modal for the single reversible inactive action
  function requestSoftDeleteSelected() {
    if (isFilteredSelection) {
      toastMsg("info", "Status changes require specific product selection. Clear this selection and choose the exact rows you want to change.");
      return;
    }
    if (selectedIds.length === 0) return;
    setBulkAction({
      title: "Set selected inactive",
      message:
        selectedIds.length === 1
          ? "This product will be removed from active selling flows. History stays preserved."
          : `${selectedIds.length} selected products will be removed from active selling flows. History stays preserved.`,
      confirmLabel: "Set inactive",
      successKind: "info",
      successMessage:
        selectedIds.length === 1
          ? "Selected product set to Inactive."
          : "Selected products set to Inactive.",
      targetStatus: "Inactive",
    });
  }

  // this runs the inactive bulk status update after the user confirms the current bulk action
  async function confirmBulkAction() {
    if (!bulkAction || selectedIds.length === 0) return;
    if (selectedIds.length === 0) return;
    const targetStatus = bulkAction.targetStatus;
    const idsToUpdate = selectedProducts
      .filter((product) => product.status !== targetStatus)
      .map((product) => product.id);
    const skippedCount = selectedIds.length - idsToUpdate.length;
    if (idsToUpdate.length === 0) {
      toastMsg("info", formatStatusOutcome(targetStatus, 0, skippedCount));
      clearBulkSelection();
      setBulkAction(null);
      return;
    }
    try {
      const result = await bulkSetStatus(idsToUpdate, targetStatus);
      toastMsg(
        result.changedCount > 0 ? bulkAction.successKind : "info",
        formatStatusOutcome(targetStatus, result.changedCount, skippedCount + result.skippedCount),
      );
      clearBulkSelection();
      setBulkAction(null);
      await refreshProductsAfterSavedMutation();
    } catch (error: any) {
      toastMsg("danger", error?.message || "Failed to update selected.");
    }
  }

  // this sets one product inactive while preserving history
  async function confirmDeleteOne() {
    if (!activeProductId) return;
    if (activeProduct?.status === "Inactive") {
      toastMsg("info", "No changes made. Product is already inactive.");
      setOpenConfirmDelete(false);
      setActiveProductId(null);
      return;
    }
    try {
      const result = await setProductStatus(activeProductId, "Inactive");
      toastMsg(result.changed ? "info" : "info", result.message || "Product set to Inactive.");
      setOpenConfirmDelete(false);
      setActiveProductId(null);
      setDeleteSafety(null);
      await refreshProductsAfterSavedMutation();
    } catch (error: any) {
      toastMsg("danger", error?.message || "Failed to update product.");
    }
  }

  async function toggleProductStatus(product: Product) {
    const newStatus = product.status === "Active" ? "Inactive" : "Active";
    try {
      const result = await setProductStatus(product.id, newStatus);
      toastMsg(result.changed ? "success" : "info", result.message || `Product set to ${newStatus}.`);
      await refreshProductsAfterSavedMutation();
    } catch (error: any) {
      toastMsg("danger", error?.message || "Failed to update product status.");
    }
  }

  async function confirmPermanentDeleteOne() {
    if (!activeProductId) return;
    try {
      setDeleteBusy(true);
      const result = await permanentlyDeleteProduct(activeProductId);
      toastMsg("success", result.message || "Product permanently deleted.");
      setOpenConfirmDelete(false);
      setActiveProductId(null);
      setDeleteSafety(null);
      clearBulkSelection();
      await refreshProductsAfterSavedMutation();
    } catch (error: any) {
      const safety = error?.response?.data?.safety as ProductDeleteSafety | undefined;
      if (safety) setDeleteSafety(safety);
      toastMsg(
        "danger",
        error?.response?.data?.error ||
          error?.message ||
          "Product cannot be permanently deleted.",
      );
    } finally {
      setDeleteBusy(false);
    }
  }

  // this uploads a supplier file into a review batch; products are only inserted after the selected rows are approved
  async function handleImportCsv(selection?: { sheetName?: string; headerRowNumber?: number }) {
    // requiring a file first avoids sending an empty import request
    if (!importFile) {
      setImportError("Choose a CSV, Excel, PDF, or image rate list before uploading.");
      return;
    }

    try {
      const abortController = new AbortController();
      importAbortRef.current?.abort();
      importAbortRef.current = abortController;
      setImportBusy(true);
      setImportError("");
      const lowerName = importFile.name.toLowerCase();
      const isPdf =
        importFile.type === "application/pdf" ||
        lowerName.endsWith(".pdf");
      const isImage =
        importFile.type.startsWith("image/") ||
        /\.(png|jpe?g|webp)$/i.test(lowerName);
      const isSpreadsheet =
        /\.(csv|xlsx|xlsm)$/i.test(lowerName) ||
        importFile.type === "text/csv" ||
        importFile.type ===
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
        importFile.type === "application/vnd.ms-excel.sheet.macroenabled.12";
      if (!isPdf && !isImage && !isSpreadsheet) {
        setImportError(
          lowerName.endsWith(".xls")
            ? "Legacy .xls files are not supported. Save the workbook as .xlsx or CSV and try again."
            : "This file type is not supported. Choose CSV, XLSX, XLSM, PDF, PNG, JPG, or WebP.",
        );
        return;
      }
      setImportProcessingKind(isPdf ? "pdf" : isImage ? "image" : "spreadsheet");
      const result = (await (isPdf
        ? importPdfApi(importFile, { signal: abortController.signal, supplier: importSupplier.trim() })
        : isImage
          ? importImageRateListApi(importFile, { signal: abortController.signal, supplier: importSupplier.trim() })
          : importCsvApi(importFile, {
              ...selection,
              supplier: importSupplier.trim() || undefined,
              templateId: importTemplateId || undefined,
              fieldMap: Object.fromEntries(
                Object.entries(importFieldMap).filter(([, value]) => value.trim()),
              ),
              defaults: {
                supplier: importSupplier.trim() || undefined,
                stock: 0,
                retailMarginPercent: 18,
              },
              signal: abortController.signal,
            }))) as CsvImportResult;
      setImportResult(result);
      setLastImportedProducts([]);
      setLastImportSupplier("");
      clearBulkSelection();

      if (result.batchId) {
        setActiveImportBatchId(result.batchId);
        sessionStorage.setItem("active_product_import_batch_id", result.batchId);
        window.dispatchEvent(
          new CustomEvent("active_product_import_changed", {
            detail: { batchId: result.batchId },
          })
        );
        toastMsg(
          "info",
          "Catalog extraction in progress. You can minimize or stay here.",
        );
        void loadImportBatches().catch(() => undefined);
      } else {
        setImportError(result.message || "No import review was created.");
      }
    } catch (error: any) {
      // preferring backend error text here helps the user understand row format issues more clearly
      const message = error?.name === "AbortError"
        ? "Upload stopped. No products were added. Check import history in case the source was already saved."
        :
        error?.response?.data?.error ||
        error?.message ||
        "Failed to import products.";
      setImportError(message);
    } finally {
      importAbortRef.current = null;
      setImportBusy(false);
      setImportProcessingKind(null);
    }
  }

  async function cancelImportProcessing() {
    if (activeImportBatchId) {
      try {
        await controlProductImportApi(activeImportBatchId, "cancel");
        refreshImportTask(activeImportBatchId);
      } catch {
        // Safe fallback - batch may already be draft or spreadsheet
      }
      setActiveImportBatchId(null);
      sessionStorage.removeItem("active_product_import_batch_id");
      window.dispatchEvent(
        new CustomEvent("active_product_import_changed", {
          detail: { batchId: null },
        })
      );
    } else {
      importAbortRef.current?.abort();
    }
    setImportBusy(false);
    setImportProcessingKind(null);
    setOpenImport(false);
  }

  async function handleImportDocument(document: DocumentRecord) {
    try {
      setImportDocumentBusyId(document.id);
      setImportBusy(true);
      setImportError("");
      const result = await importProductDocumentApi(document.id);
      setImportResult(result);
      setLastImportedProducts([]);
      setLastImportSupplier("");
      clearBulkSelection();

      if (result.batchId) {
        await loadImportBatches();
        await loadImportDocuments();
        setActiveImportBatchId(result.batchId);
        sessionStorage.setItem("active_product_import_batch_id", result.batchId);
        window.dispatchEvent(
          new CustomEvent("active_product_import_changed", {
            detail: { batchId: result.batchId },
          })
        );
        toastMsg(
          "info",
          "Catalog extraction in progress. You can minimize or stay here.",
        );
      } else {
        setImportError(result.message || "No import review was created.");
      }
    } catch (error: any) {
      const message =
        error?.response?.data?.error ||
        error?.message ||
        "Failed to open uploaded import document.";
      setImportError(message);
    } finally {
      setImportBusy(false);
      setImportDocumentBusyId(null);
    }
  }

  function openStockManagerForSelection() {
    if (isFilteredSelection) {
      toastMsg("info", "Stock movement requires specific product selection. Clear this selection and choose the exact rows you want to receive or correct.");
      return;
    }
    const selectedStockIds = selectedProducts.map((product) => product.id);
    setStockProductIds(selectedStockIds);
    setStockRows(
      Object.fromEntries(selectedStockIds.map((productId) => [productId, 0])),
    );
    setStockApplyQty(0);
    setStockProductQuery("");
    setStockLookupResults([]);
    setStockLineError("");
    setStockFieldErrors({});
    setStockReason("");
    setStockMode("receive");
    setMobileStockStep(1);
    setStockDirection("add");
    setStockBillFiles([]);
    setStockSelectedBillIds([]);
    setStockShowDocumentPicker(false);
    setStockSupplierName("");
    setStockSupplierMode("existing");
    setStockBillNumber("");
    setStockBillDate(todayInputDate());
    setStockBillAmount("");
    setStockBillRemarks("");
    setStockShowBillDetails(false);
    setOpenStockManager(true);
    if (selectedStockIds[0]) setStockFocusProductId(selectedStockIds[0]);
  }

  function openStockManagerForImportedProducts(
    importedProducts: ImportedProductSummary[],
    supplierName?: string | null,
  ) {
    const importedIds = importedProducts.map((product) => product.id).filter(Boolean);
    if (importedIds.length === 0) return;

    setOpenImport(false);
    setPdfReviewBatch(null);
    setStockProductIds(importedIds);
    setStockRows(Object.fromEntries(importedIds.map((productId) => [productId, 0])));
    setStockApplyQty(0);
    setStockProductQuery("");
    setStockLookupResults([]);
    setStockLineError("");
    setStockFieldErrors({});
    setStockReason("Received after product import");
    setStockMode("receive");
    setMobileStockStep(2);
    setStockDirection("add");
    setStockBillFiles([]);
    setStockSelectedBillIds([]);
    setStockShowDocumentPicker(false);
    setStockSupplierName(supplierName?.trim() || "Imported supplier");
    setStockSupplierMode(supplierName?.trim() ? "existing" : "new");
    setStockBillNumber("");
    setStockBillDate(todayInputDate());
    setStockBillAmount("");
    setStockBillRemarks("");
    setStockShowBillDetails(false);
    setOpenStockManager(true);
    setLastImportedProducts([]);
    setLastImportSupplier("");
    if (importedIds[0]) setStockFocusProductId(importedIds[0]);
  }

  async function openBulkPriceForSelection() {
    if (selectedCount === 0) return;
    const resetPriceWorkspace = () => {
      reviewRequestIdRef.current += 1;
      setExplicitReviewPreview(null);
      setFilteredReviewPreview(null);
      setReviewLoading(false);
      setSaveOutcomeUncertain(false);
      setInvalidFilteredOverrideId(null);
      setBulkPriceMode("CALCULATE");
      setFilteredPriceOverrides({});
      lastFilteredPreviewRequestRef.current = "";
      lastFilteredSampleRequestRef.current = "";
      setPriceReason("");
      setPriceSearch("");
      setBulkPriceErrors({});
      setUpdateWholesalePrice(true);
      setUpdateRetailPrice(false);
      setPriceChangeDirection("INCREASE");
      setExistingSellingPricePolicy("FILL_EMPTY");
      setPricePreviewReady(false);
      setBulkPriceNotice(null);
      setBulkPriceTouched(false);
      setConfirmDiscardBulkPrice(false);
      setConfirmBulkPriceSave(false);
      setExplicitAdjustedIds({});
      setShowMobileDetails(false);
      setMobileStep1Tab("formula");
      setBulkPriceSort("affected_first");
      setBulkPricePreviewFilter("ALL");
    };
    if (isFilteredSelection) {
      setFilteredPreviewItems([]);
      setFilteredPreviewLoaded(false);
      setFilteredPreviewStats({
        matchedCount: 0,
        previewCount: 0,
        previewMatchedCount: 0,
        previewPage: 1,
        previewPageSize: bulkPriceStep2PageSize,
        previewTotalPages: 1,
        skippedMissingRate: 0,
        skippedComingSoon: 0,
        skippedExisting: 0,
      });
      setPriceRows({});
      setPriceMarginTargetIds({});
      resetPriceWorkspace();
      setOpenBulkPrice(true);
      return;
    }

    let resolvedProducts = selectedProducts;
    try {
      setPriceBusy(true);
      resolvedProducts = await fetchProductsByIds(selectedIds);
      const resolvedIds = new Set(resolvedProducts.map((product) => product.id));
      const unavailableCount = selectedIds.filter((id) => !resolvedIds.has(id)).length;
      if (unavailableCount > 0) {
        setSelected(Object.fromEntries(resolvedProducts.map((product) => [product.id, true])));
        toastMsg("info", `${unavailableCount} unavailable product${unavailableCount === 1 ? " was" : "s were"} removed from the selection.`);
      }
      setSelectedProductCache(
        Object.fromEntries(resolvedProducts.map((product) => [product.id, product])),
      );
    } catch (error: any) {
      toastMsg("danger", error?.message || "Selected products could not be loaded.");
      return;
    } finally {
      setPriceBusy(false);
    }
    if (resolvedProducts.length === 0) return;
    setPriceRows(
      Object.fromEntries(
        resolvedProducts.map((product) => [
          product.id,
          {
            retailPrice: String(product.retailPrice || ""),
            wholesalePrice: String(product.wholesalePrice || ""),
            ratePerPiece:
              product.ratePerPiece === null ? "" : String(product.ratePerPiece),
          },
        ]),
      ),
    );
    setPriceMarginTargetIds(Object.fromEntries(resolvedProducts.map((product) => [product.id, true])));
    resetPriceWorkspace();
    setOpenBulkPrice(true);
  }

  function requestCloseBulkPrice() {
    if (priceBusy) return;
    if (bulkPriceTouched) {
      setConfirmDiscardBulkPrice(true);
      return;
    }
    setOpenBulkPrice(false);
  }

  function discardBulkPriceChanges() {
    setConfirmDiscardBulkPrice(false);
    setBulkPriceTouched(false);
    setOpenBulkPrice(false);
  }

  async function confirmDiscardStockAndDeleteOne() {
    if (!activeProductId) return;
    try {
      setDeleteBusy(true);
      const result = await discardStockAndDeleteProduct(activeProductId);
      toastMsg("success", result.message || "Product stock was cleared and the product was permanently deleted.");
      setOpenConfirmDelete(false);
      setActiveProductId(null);
      setDeleteSafety(null);
      clearBulkSelection();
      await refreshProductsAfterSavedMutation();
    } catch (error: any) {
      const safety = error?.response?.data?.safety as ProductDeleteSafety | undefined;
      if (safety) setDeleteSafety(safety);
      toastMsg("danger", error?.response?.data?.error || error?.message || "Stock could not be cleared and the product was not deleted.");
    } finally {
      setDeleteBusy(false);
    }
  }

  function applyStockQtyToAllSelected() {
    const qty = Math.max(0, Number(stockApplyQty || 0));
    setStockRows(
      Object.fromEntries(stockManagerProducts.map((product) => [product.id, qty])),
    );
  }

  function addProductToStockManager(product: Product, qty = 0) {
    setProducts((current) =>
      current.some((item) => item.id === product.id)
        ? current.map((item) => (item.id === product.id ? product : item))
        : [product, ...current],
    );
    setStockProductIds((current) =>
      current.includes(product.id) ? current : [...current, product.id],
    );
    setStockRows((current) => ({
      ...current,
      [product.id]: current[product.id] ?? qty,
    }));
    setStockProductQuery("");
    setStockLookupResults([]);
    setStockLineError("");
    setStockFocusProductId(product.id);
  }

  function removeProductFromStockManager(productId: string) {
    setStockProductIds((current) => current.filter((id) => id !== productId));
    setStockRows((current) => {
      const next = { ...current };
      delete next[productId];
      return next;
    });
    setStockLineError("");
  }

  function openQuickStockAdd() {
    const name = stockProductQuery.trim();
    const firstBrand = brands.find((item) => item !== "All Brands") || "";
    const firstCategory =
      categories.find((item) => item !== "All Categories") || "";
    setQuickStockProduct({
      name,
      sku: "",
      brand: firstBrand,
      category: firstCategory,
      ratePerPiece: "",
      wholesalePrice: "",
      retailPrice: "",
      saleUnit: "PIECE",
    });
    setQuickStockErrors({});
    setQuickStockError("");
    setQuickStockErrors({});
    setQuickStockError("");
    setQuickStockError("");
    setOpenStockQuickAdd(true);
  }

  function resetQuickStockProductForm() {
    const firstBrand = brands.find((item) => item !== "All Brands") || "";
    const firstCategory =
      categories.find((item) => item !== "All Categories") || "";
    setQuickStockProduct({
      name: "",
      sku: "",
      brand: firstBrand,
      category: firstCategory,
      ratePerPiece: "",
      wholesalePrice: "",
      retailPrice: "",
      saleUnit: "PIECE",
    });
  }

  async function saveQuickStockProduct(addAnother = false) {
    const name = quickStockProduct.name.trim();
    const brandName = quickStockProduct.brand.trim();
    const categoryName = quickStockProduct.category.trim();
    const ratePerPiece = quickStockProduct.ratePerPiece.trim()
      ? Number(quickStockProduct.ratePerPiece)
      : null;
    const wholesalePrice = Number(quickStockProduct.wholesalePrice || 0);
    const retailPrice = Number(quickStockProduct.retailPrice || 0);
    const saleUnit = quickStockProduct.saleUnit || "PIECE";
    const sku = quickStockProduct.sku.trim();
    const validationErrors: QuickStockErrors = {};
    if (!name) validationErrors.name = "Product name is required.";
    if (!brandName) validationErrors.brand = "Choose a brand before saving.";
    if (!categoryName) validationErrors.category = "Choose a category before saving.";
    if (ratePerPiece === null || !Number.isFinite(ratePerPiece) || ratePerPiece <= 0) {
      validationErrors.ratePerPiece = "Enter a Rate before receiving stock.";
    }
    if (quickStockProduct.wholesalePrice.trim() && (!Number.isFinite(wholesalePrice) || wholesalePrice <= 0)) {
      validationErrors.wholesalePrice = "Wholesale price must be greater than 0 or left blank.";
    }
    if (quickStockProduct.retailPrice.trim() && (!Number.isFinite(retailPrice) || retailPrice <= 0)) {
      validationErrors.retailPrice = "Retail price must be greater than 0 or left blank.";
    }
    if (wholesalePrice > retailPrice && retailPrice > 0) {
      validationErrors.wholesalePrice = "Wholesale price cannot be higher than retail price.";
    }
    setQuickStockErrors(validationErrors);
    const firstInvalidField = Object.keys(validationErrors)[0] as keyof QuickStockErrors | undefined;
    if (firstInvalidField) {
      window.setTimeout(() => {
        focusInvalidField(document.getElementById(`quick-stock-${firstInvalidField}`));
      }, 0);
      return;
    }

    try {
      setQuickStockBusy(true);
      setQuickStockError("");
      setQuickStockErrors({});
      const created = await createProduct({
        name,
        productName: name,
        sku,
        barcode: "",
        imageUrl: "",
        brand: brandName,
        category: categoryName,
        categoryGroup: categoryName,
        vendorSource: stockSupplierName.trim(),
        productCodeVariant: "",
        sizeValue: null,
        sizeUnit: "STANDARD",
        ratePerPiece,
        packageQuantity: 1,
        packageUnit: "PIECE",
        saleUnit,
        allowFractionalQty: saleUnit !== "PIECE",
        quantityStep: saleUnit === "PIECE" ? 1 : 0.001,
        wholesaleEligible: true,
        sourceCitation: "",
        sellingPriceStatus: wholesalePrice > 0 && retailPrice > 0 ? "READY" : "PENDING",
        availabilityStatus: "CATALOG_LISTED",
        retailPrice,
        wholesalePrice,
        thresholdQty: businessDefaults.defaultWholesaleQtyThreshold,
        thresholdQtyMode: "default",
        stock: 0,
        lowStockThreshold: businessDefaults.defaultLowStockThreshold,
        lowStockThresholdMode: "default",
        status: "Active",
      });
      addProductToStockManager(created, 1);
      toastMsg("success", `${created.name} added to receive list.`);

      if (addAnother) {
        resetQuickStockProductForm();
        return;
      }

      setOpenStockQuickAdd(false);
    } catch (error: any) {
      setQuickStockError(error?.message || "Failed to create product.");
    } finally {
      setQuickStockBusy(false);
    }
  }

  async function calculateBulkPricePreview() {
    setBulkPriceNotice(null);
    setPricePreviewReady(false);
    if (bulkPriceMode === "MANUAL") {
      if (isFilteredSelection) {
        const message = "Manual entry is available only when specific products are selected.";
        setBulkPriceNotice({ tone: "danger", message });
        return;
      }
      if (priceMarginTargetCount === 0) {
        const message = "Select at least one product to edit.";
        setBulkPriceNotice({ tone: "danger", message });
        return;
      }
      setPricePreviewReady(true);
      setBulkPriceTouched(true);
      setBulkPriceNotice({
        tone: "info",
        message: "Enter only the prices you want to change. Current prices remain visible for comparison.",
      });
      return;
    }
    if (!updateWholesalePrice && !updateRetailPrice) {
      const message = "Choose Wholesale price, Retail price, or both.";
      setBulkPriceNotice({ tone: "danger", message });
      toastMsg("info", message);
      return;
    }
    if (!priceMarginsValid) {
      const message = priceChangeDirection === "DECREASE"
        ? "Enter a percentage above 0 and below 100."
        : "Enter a percentage above 0 and up to 100.";
      setBulkPriceNotice({ tone: "danger", message });
      toastMsg("info", message);
      return;
    }
    if (!isFilteredSelection && priceMarginTargetCount === 0) {
      const message = "Select at least one product for this price change.";
      setBulkPriceNotice({ tone: "danger", message });
      toastMsg("info", message);
      return;
    }

    if (isFilteredSelection) {
      try {
        setPriceBusy(true);
        const result = await loadFilteredPricePreview(1, priceSearch);
        setBulkPriceTouched(true);
        if (result.previewCount === 0) {
          const details = [
            result.skippedComingSoon ? `${result.skippedComingSoon} Coming soon` : "",
            result.skippedMissingRate ? `${result.skippedMissingRate} without a Rate` : "",
            result.skippedExisting ? `${result.skippedExisting} already filled` : "",
          ].filter(Boolean).join(", ");
          const message = `No prices can be changed${details ? `: ${details}` : " with these choices"}. ${result.skippedExisting ? "Choose Replace current prices if you want to overwrite them." : ""}`.trim();
          setBulkPriceNotice({ tone: "danger", message });
          toastMsg("info", message);
          return;
        }
        setPricePreviewReady(true);
        setBulkPriceNotice({
          tone: "success",
          message: `${result.previewCount.toLocaleString()} product${result.previewCount === 1 ? " is" : "s are"} ready to review (${result.skippedComingSoon + result.skippedMissingRate} skipped without Rate / Coming soon; ${result.skippedExisting} preserved).`,
        });
      } catch (error: any) {
        const message = error?.response?.data?.error || error?.message || "The price preview could not be prepared.";
        setBulkPriceNotice({ tone: "danger", message });
        toastMsg("danger", message);
      } finally {
        setPriceBusy(false);
      }
      return;
    }

    let preparedCount = 0;
    let missingRateCount = 0;
    let comingSoonCount = 0;
    let alreadyFilledCount = 0;
    const nextPriceRows = { ...priceRows };
    selectedProducts.forEach((product) => {
        if (!priceMarginTargetIds[product.id]) return;
        const row = nextPriceRows[product.id] || {
          retailPrice: product.retailPrice === null ? "" : String(product.retailPrice),
          wholesalePrice: product.wholesalePrice === null ? "" : String(product.wholesalePrice),
          ratePerPiece: product.ratePerPiece === null ? "" : String(product.ratePerPiece),
        };
        if (product.availabilityStatus === "COMING_SOON") {
          comingSoonCount += 1;
          return;
        }
        const rate = Number(row.ratePerPiece || 0);
        if (!Number.isFinite(rate) || rate <= 0) {
          missingRateCount += 1;
          return;
        }
        let changed = false;
        const updated = { ...row };
        if (updateWholesalePrice) {
          if (existingSellingPricePolicy === "REPLACE" || !(Number(product.wholesalePrice) > 0)) {
            updated.wholesalePrice = String(priceFromPercentageChange(rate, wholesaleMarginPercent, priceChangeDirection));
            changed = true;
          } else {
            alreadyFilledCount += 1;
          }
        }
        if (updateRetailPrice) {
          if (existingSellingPricePolicy === "REPLACE" || !(Number(product.retailPrice) > 0)) {
            updated.retailPrice = String(priceFromPercentageChange(rate, retailMarginPercent, priceChangeDirection));
            changed = true;
          } else {
            alreadyFilledCount += 1;
          }
        }
        if (changed) {
          preparedCount += 1;
          nextPriceRows[product.id] = updated;
        }
    });
    setPriceRows(nextPriceRows);

    setBulkPriceTouched(true);
    if (preparedCount === 0) {
      const reasons = [
        comingSoonCount ? `${comingSoonCount} Coming soon` : "",
        missingRateCount ? `${missingRateCount} without a Rate` : "",
        alreadyFilledCount ? `${alreadyFilledCount} price${alreadyFilledCount === 1 ? " is" : "s are"} already filled` : "",
      ].filter(Boolean).join(", ");
      const message = reasons
        ? `No prices can be changed: ${reasons}. ${alreadyFilledCount ? "Choose Replace current prices if you want to overwrite them." : ""}`.trim()
        : "No prices can be changed with these choices.";
      setBulkPriceNotice({ tone: "danger", message });
      toastMsg("info", message);
      return;
    }
    setPricePreviewReady(true);
    const skipped = comingSoonCount + missingRateCount;
    setBulkPriceNotice({
      tone: "success",
      message: `${preparedCount} product${preparedCount === 1 ? " is" : "s are"} ready to review${skipped ? `; ${skipped} cannot be calculated because they are Coming soon or have no Rate` : ""}${alreadyFilledCount ? `; ${alreadyFilledCount} existing price${alreadyFilledCount === 1 ? " was" : "s were"} kept` : ""}.`,
    });
  }

  function buildFilteredPriceOverrides() {
    return Object.entries(filteredPriceOverrides).map(([productId, row]) => ({
      productId,
      ...(row.ratePerPiece.trim() ? { ratePerPiece: Number(row.ratePerPiece) } : {}),
      ...(row.wholesalePrice.trim() ? { wholesalePrice: Number(row.wholesalePrice) } : {}),
      ...(row.retailPrice.trim() ? { retailPrice: Number(row.retailPrice) } : {}),
    }));
  }

  async function loadFilteredPricePreview(
    previewPage = 1,
    previewSearch = priceSearch,
    previewPageSize = bulkPriceStep2PageSize,
    signal?: AbortSignal,
  ) {
    const requestId = ++filteredPreviewRequestIdRef.current;
    const overrides = buildFilteredPriceOverrides();
    const result = await bulkUpdateProductPricesApi({
      reason: "Preview only — not saved",
      scope: "FILTERED",
      filters: currentProductFilters,
      excludedProductIds: filteredExcludedIds,
      overrides,
      ...(updateWholesalePrice ? { wholesalePercent: wholesaleMarginPercent } : {}),
      ...(updateRetailPrice ? { retailPercent: retailMarginPercent } : {}),
      direction: priceChangeDirection,
      existingPricePolicy: existingSellingPricePolicy,
      previewOnly: true,
      previewPage,
      previewPageSize,
      previewSearch: previewSearch.trim() || undefined,
      previewSort: filteredPreviewSort,
    }, { signal });
    // Search requests may finish out of order on slower networks. Only the most
    // recent response may replace the visible catalog preview.
    if (requestId !== filteredPreviewRequestIdRef.current) return result;
    setBulkPricePreviewRevision(result.previewRevision || null);
    setFilteredPreviewItems(result.preview || []);
    setFilteredPreviewLoaded(true);
    setFilteredPreviewStats({
      matchedCount: result.matchedCount ?? selectedCount,
      previewCount: result.previewCount || 0,
      previewMatchedCount: result.previewMatchedCount ?? result.previewCount ?? 0,
      previewPage: result.previewPage || 1,
      previewPageSize: result.previewPageSize || previewPageSize,
      previewTotalPages: result.previewTotalPages || 1,
      skippedMissingRate: result.skippedMissingRate || 0,
      skippedComingSoon: result.skippedComingSoon || 0,
      skippedExisting: result.skippedExisting || 0,
    });
    if (pricePreviewReady) {
      setBulkPriceStep2Page(result.previewPage || 1);
    } else {
      setBulkPriceStep1Page(result.previewPage || 1);
    }
    lastFilteredPreviewRequestRef.current = `${previewSearch.trim()}|${previewPageSize}|${filteredPreviewSort}`;
    return result;
  }

  function excludeFilteredPreviewItem(item: {
    productId: string;
    name: string;
    sku: string | null;
  }) {
    setFilteredSelectionExclusions((current) => ({
      ...current,
      [item.productId]: {
        id: item.productId,
        name: item.name,
        sku: item.sku || "",
      },
    }));
    setPricePreviewReady(false);
    setBulkPriceTouched(true);
    setBulkPriceNotice({
      tone: "info",
      message: `${item.name} was excluded. Calculate the preview again to confirm the updated batch.`,
    });
  }

  function editFilteredPreviewItem(item: {
    productId: string;
    currentRate: number | null;
    newRate: number | null;
    currentRetailPrice: number | null;
    newRetailPrice: number | null;
    currentWholesalePrice: number | null;
    newWholesalePrice: number | null;
  }) {
    if (!filteredPriceOverrides[item.productId] && Object.keys(filteredPriceOverrides).length >= 100) {
      setBulkPriceNotice({ tone: "danger", message: "You can adjust up to 100 products in one catalog-wide price change." });
      return;
    }
    setFilteredPriceOverrides((current) => ({
      ...current,
      [item.productId]: current[item.productId] || {
        ratePerPiece: String(item.newRate ?? item.currentRate ?? ""),
        wholesalePrice: String(item.newWholesalePrice ?? item.currentWholesalePrice ?? ""),
        retailPrice: String(item.newRetailPrice ?? item.currentRetailPrice ?? ""),
      },
    }));
    setBulkPriceTouched(true);
  }

  function useCalculatedPriceForFilteredItem(productId: string) {
    setInvalidFilteredOverrideId((current) => current === productId ? null : current);
    setPendingInvalidPriceFocus((current) => current?.productId === productId ? null : current);
    setFilteredPriceOverrides((current) => {
      const next = { ...current };
      delete next[productId];
      return next;
    });
    setBulkPriceErrors((current) => {
      if (!current.rows?.[productId]) return current;
      const rows = { ...current.rows };
      delete rows[productId];
      return { ...current, rows: Object.keys(rows).length ? rows : undefined };
    });
    setBulkPriceTouched(true);
  }

  function updateFilteredPriceOverride(productId: string, field: PriceField, value: string) {
    setFilteredPriceOverrides((current) => ({
      ...current,
      [productId]: { ...current[productId], [field]: value },
    }));
    setBulkPriceErrors((current) => ({
      ...current,
      rows: current.rows
        ? { ...current.rows, [productId]: { ...current.rows[productId], [field]: undefined } }
        : undefined,
    }));
    setBulkPriceTouched(true);
  }

  function setVisiblePriceMarginTargets(checked: boolean) {
    setPricePreviewReady(false);
    setBulkPriceNotice(null);
    setBulkPriceTouched(true);
    setPriceMarginTargetIds((current) => {
      const next = { ...current };
      visibleBulkPriceProducts.forEach((product) => { next[product.id] = checked; });
      return next;
    });
  }

  function validateStockSetupFields() {
    const errors: StockFieldErrors = {};
    if (!stockReason.trim()) errors.reason = "Reason is required for stock changes.";
    if (stockMode === "receive" && !stockSupplierName.trim()) {
      errors.supplier = "Choose or enter a supplier before continuing.";
    }
    setStockFieldErrors(errors);
    const firstField = Object.keys(errors)[0] as keyof StockFieldErrors | undefined;
    if (!firstField) return true;

    setMobileStockStep(1);
    window.setTimeout(() => {
      const targetId = firstField === "supplier"
        ? stockSupplierMode === "new" ? "stock-supplier-input" : "stock-supplier-select"
        : "stock-reason";
      focusInvalidField(document.getElementById(targetId));
    }, 0);
    return false;
  }

  async function confirmStockManager() {
    if (!validateStockSetupFields()) return;
    const rows = stockManagerProducts
      .map((product) => ({ product, qty: Math.abs(Number(stockRows[product.id] || 0)) }))
      .filter((row) => row.qty > 0);
    if (rows.length === 0) {
      setStockLineError("Add at least one product and enter a quantity.");
      return;
    }
    try {
      setStockBusy(true);
      setStockLineError("");
      setStockFieldErrors({});
      if (stockMode === "receive") {
        const result = await receiveStockBatchApi({
          supplierName: stockSupplierName.trim(),
          reason: stockReason.trim(),
          billNumber: stockBillNumber.trim() || undefined,
          billDate: stockBillDate || undefined,
          billAmount: stockBillAmount ? Number(stockBillAmount) : undefined,
          remarks: stockBillRemarks.trim() || undefined,
          files: stockBillFiles,
          documentIds: stockSelectedBillIds,
          lines: rows.map((row) => ({
            productId: row.product.id,
            qty: row.qty,
          })),
        });
        if (result?.documentWarning) {
          showToast("warning", result.documentWarning, { persistent: true });
        }
      } else {
        for (const row of rows) {
          const delta = stockDirection === "remove" ? -row.qty : row.qty;
          await adjustStockApi(row.product.id, delta, stockReason.trim());
        }
      }
      toastMsg("success", stockMode === "receive" ? "Stock received and batch saved." : "Stock updated.");
      setOpenStockManager(false);
      setOpenStockQuickAdd(false);
      clearBulkSelection();
      setStockProductIds([]);
      setStockRows({});
      setStockProductQuery("");
      setStockLookupResults([]);
      setStockLineError("");
      setStockFieldErrors({});
      setStockBillFiles([]);
      setStockSelectedBillIds([]);
      setStockShowDocumentPicker(false);
      setStockSupplierName("");
      setStockSupplierMode("existing");
      setStockBillNumber("");
      setStockBillDate(todayInputDate());
      setStockBillAmount("");
      setStockBillRemarks("");
      setStockShowBillDetails(false);
      await loadProducts();
    } catch (error: any) {
      toastMsg("danger", error?.message || "Failed to update stock.");
    } finally {
      setStockBusy(false);
    }
  }

  function advanceMobileStockMovement() {
    setStockLineError("");

    if (mobileStockStep === 1) {
      if (!validateStockSetupFields()) return;
      setMobileStockStep(2);
      return;
    }

    if (mobileStockStep === 2) {
      if (stockManagerProducts.length === 0) {
        setStockLineError("Add at least one product to continue.");
        return;
      }
      setMobileStockStep(3);
      return;
    }

    void confirmStockManager();
  }

  function closeStockManager() {
    if (stockBusy || quickStockBusy) return;
    setOpenStockQuickAdd(false);
    setQuickStockError("");
    setQuickStockErrors({});
    setStockSelectedBillIds([]);
    setStockShowDocumentPicker(false);
    setStockFieldErrors({});
    setOpenStockManager(false);
  }

  function returnToStockMovementList() {
    if (quickStockBusy) return;
    setOpenStockQuickAdd(false);
    setQuickStockError("");
    setQuickStockErrors({});
  }

  function renderQuickStockProductForm() {
    function clearQuickStockFieldError(field: keyof QuickStockErrors) {
      setQuickStockErrors((current) => ({ ...current, [field]: undefined }));
      setQuickStockError("");
    }
    const quickStockControlTone = (field: keyof QuickStockErrors) =>
      quickStockErrors[field]
        ? "border-2 border-[#DC2626] bg-[#FFF1F2] focus:ring-2 focus:ring-red-100"
        : "border border-[#CFCFD3] bg-white focus:border-[#3B82F6] focus:ring-2 focus:ring-blue-100";
    return (
      <div className="space-y-[14px]">
        <div className="grid grid-cols-1 gap-[10px] md:grid-cols-2">
          <label className="md:col-span-2">
            <div className="mb-[6px] text-[12px] font-extrabold uppercase text-[#8C8889]">
              Product name
            </div>
            <input
              id="quick-stock-name"
              value={quickStockProduct.name}
              aria-invalid={Boolean(quickStockErrors.name)}
              aria-describedby={quickStockErrors.name ? "quick-stock-name-error" : undefined}
              onChange={(event) => {
                setQuickStockProduct((current) => ({
                  ...current,
                  name: event.target.value,
                }));
                clearQuickStockFieldError("name");
              }}
              placeholder="e.g. Sauce Bottle Big 570"
              className={`h-[42px] w-full rounded-[12px] px-[12px] text-[13px] font-semibold text-[#000000] outline-none ${quickStockControlTone("name")}`}
            />
            {quickStockErrors.name ? <span id="quick-stock-name-error" className="mt-1 block text-[11px] font-bold text-[#BE123C]" role="alert">{quickStockErrors.name}</span> : null}
          </label>

          <label>
            <div className="mb-[6px] text-[12px] font-extrabold uppercase text-[#8C8889]">
              SKU
            </div>
            <input
              value={quickStockProduct.sku}
              onChange={(event) => {
                setQuickStockProduct((current) => ({
                  ...current,
                  sku: event.target.value,
                }));
                setQuickStockError("");
              }}
              placeholder="Auto if left blank"
              className="h-[42px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-[12px] text-[13px] font-semibold text-[#000000] outline-none"
            />
          </label>

          <label>
            <div className="mb-[6px] text-[12px] font-extrabold uppercase text-[#8C8889]">
              Sale unit
            </div>
            <ProjectSelect
              aria-label="Sale unit"
              value={quickStockProduct.saleUnit}
              onChange={(event) =>
                setQuickStockProduct((current) => ({
                  ...current,
                  saleUnit: event.target.value,
                }))
              }
              className="h-[42px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-[12px] text-[13px] font-bold text-[#000000] outline-none"
            >
              <option value="PIECE">Piece</option>
              <option value="KG">KG</option>
              <option value="GRAM">Gram</option>
              <option value="METER">Meter</option>
            </ProjectSelect>
          </label>

          <label>
            <div className="mb-[6px] text-[12px] font-extrabold uppercase text-[#8C8889]">
              Brand
            </div>
            <ProjectSelect
              id="quick-stock-brand"
              aria-label="Brand"
              aria-invalid={Boolean(quickStockErrors.brand)}
              aria-describedby={quickStockErrors.brand ? "quick-stock-brand-error" : undefined}
              value={quickStockProduct.brand}
              onChange={(event) => {
                setQuickStockProduct((current) => ({
                  ...current,
                  brand: event.target.value,
                }));
                clearQuickStockFieldError("brand");
              }}
              className={`h-[42px] w-full rounded-[12px] px-[12px] text-[13px] font-bold text-[#000000] outline-none ${quickStockControlTone("brand")}`}
            >
              <option value="">Choose brand</option>
              {brands
                .filter((item) => item !== "All Brands")
                .map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
            </ProjectSelect>
            {quickStockErrors.brand ? <span id="quick-stock-brand-error" className="mt-1 block text-[11px] font-bold text-[#BE123C]" role="alert">{quickStockErrors.brand}</span> : null}
          </label>

          <label>
            <div className="mb-[6px] text-[12px] font-extrabold uppercase text-[#8C8889]">
              Category
            </div>
            <ProjectSelect
              id="quick-stock-category"
              aria-label="Category"
              aria-invalid={Boolean(quickStockErrors.category)}
              aria-describedby={quickStockErrors.category ? "quick-stock-category-error" : undefined}
              value={quickStockProduct.category}
              onChange={(event) => {
                setQuickStockProduct((current) => ({
                  ...current,
                  category: event.target.value,
                }));
                clearQuickStockFieldError("category");
              }}
              className={`h-[42px] w-full rounded-[12px] px-[12px] text-[13px] font-bold text-[#000000] outline-none ${quickStockControlTone("category")}`}
            >
              <option value="">Choose category</option>
              {categories
                .filter((item) => item !== "All Categories")
                .map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
            </ProjectSelect>
            {quickStockErrors.category ? <span id="quick-stock-category-error" className="mt-1 block text-[11px] font-bold text-[#BE123C]" role="alert">{quickStockErrors.category}</span> : null}
          </label>

          <label>
            <div className="mb-[6px] text-[12px] font-extrabold uppercase text-[#8C8889]">
              Rate
            </div>
            <input
              id="quick-stock-ratePerPiece"
              type="number"
              min={0}
              step="0.01"
              value={quickStockProduct.ratePerPiece}
              aria-invalid={Boolean(quickStockErrors.ratePerPiece)}
              aria-describedby={quickStockErrors.ratePerPiece ? "quick-stock-rate-error" : undefined}
              onChange={(event) => {
                const value = event.target.value;
                setQuickStockProduct((current) => ({
                  ...current,
                  ratePerPiece: value,
                }));
                clearQuickStockFieldError("ratePerPiece");
              }}
              className={`h-[42px] w-full rounded-[12px] px-[12px] text-right text-[13px] font-semibold text-[#000000] outline-none ${quickStockControlTone("ratePerPiece")}`}
            />
            {quickStockErrors.ratePerPiece ? <span id="quick-stock-rate-error" className="mt-1 block text-[11px] font-bold text-[#BE123C]" role="alert">{quickStockErrors.ratePerPiece}</span> : null}
          </label>

          <label>
            <div className="mb-[6px] text-[12px] font-extrabold uppercase text-[#8C8889]">
              Wholesale price
            </div>
            <input
              id="quick-stock-wholesalePrice"
              type="number"
              min={0}
              step="0.01"
              value={quickStockProduct.wholesalePrice}
              aria-invalid={Boolean(quickStockErrors.wholesalePrice)}
              aria-describedby={quickStockErrors.wholesalePrice ? "quick-stock-wholesale-error" : undefined}
              onChange={(event) => {
                setQuickStockProduct((current) => ({
                  ...current,
                  wholesalePrice: event.target.value,
                }));
                clearQuickStockFieldError("wholesalePrice");
              }}
              className={`h-[42px] w-full rounded-[12px] px-[12px] text-right text-[13px] font-semibold text-[#000000] outline-none ${quickStockControlTone("wholesalePrice")}`}
            />
            {quickStockErrors.wholesalePrice ? <span id="quick-stock-wholesale-error" className="mt-1 block text-[11px] font-bold text-[#BE123C]" role="alert">{quickStockErrors.wholesalePrice}</span> : null}
          </label>

          <label>
            <div className="mb-[6px] text-[12px] font-extrabold uppercase text-[#8C8889]">
              Retail price
            </div>
            <input
              id="quick-stock-retailPrice"
              type="number"
              min={0}
              step="0.01"
              value={quickStockProduct.retailPrice}
              aria-invalid={Boolean(quickStockErrors.retailPrice)}
              aria-describedby={quickStockErrors.retailPrice ? "quick-stock-retail-error" : undefined}
              onChange={(event) => {
                setQuickStockProduct((current) => ({
                  ...current,
                  retailPrice: event.target.value,
                }));
                clearQuickStockFieldError("retailPrice");
              }}
              className={`h-[42px] w-full rounded-[12px] px-[12px] text-right text-[13px] font-semibold text-[#000000] outline-none ${quickStockControlTone("retailPrice")}`}
            />
            {quickStockErrors.retailPrice ? <span id="quick-stock-retail-error" className="mt-1 block text-[11px] font-bold text-[#BE123C]" role="alert">{quickStockErrors.retailPrice}</span> : null}
          </label>
        </div>

        {quickStockError ? (
          <div className="rounded-[12px] border border-[#FECDD3] bg-[#FFF1F2] px-3 py-2 text-[12px] font-semibold text-[#BE123C]">
            {quickStockError}
          </div>
        ) : null}

        <div className="flex flex-col gap-[10px] sm:flex-row sm:justify-end">
          <DialogButton
            onClick={() => void saveQuickStockProduct(true)}
            disabled={quickStockBusy}
            icon="add"
          >
            Save & Add Another
          </DialogButton>
          <DialogButton
            variant="primary"
            onClick={() => void saveQuickStockProduct(false)}
            disabled={quickStockBusy}
            icon="inventory_2"
          >
            {quickStockBusy ? "Saving..." : "Save to Receive List"}
          </DialogButton>
        </div>
      </div>
    );
  }

  function buildBulkPriceUpdates() {
    if (isFilteredSelection) return [];
    return selectedProducts.flatMap((product) => {
          if (!priceMarginTargetIds[product.id]) return [];
          if (bulkPriceMode === "CALCULATE" && (product.availabilityStatus === "COMING_SOON" || !(Number(product.ratePerPiece) > 0))) return [];
          const row = priceRows[product.id];
          const update: { productId: string; ratePerPiece?: number; retailPrice?: number; wholesalePrice?: number } = { productId: product.id };
          if (bulkPriceMode === "MANUAL") {
            const rate = Number(row?.ratePerPiece || 0);
            const wholesale = Number(row?.wholesalePrice || 0);
            const retail = Number(row?.retailPrice || 0);
            if (row?.ratePerPiece.trim() && rate !== Number(product.ratePerPiece)) update.ratePerPiece = rate;
            if (row?.wholesalePrice.trim() && wholesale !== Number(product.wholesalePrice)) update.wholesalePrice = wholesale;
            if (row?.retailPrice.trim() && retail !== Number(product.retailPrice)) update.retailPrice = retail;
            return update.ratePerPiece === undefined && update.wholesalePrice === undefined && update.retailPrice === undefined ? [] : [update];
          }
          if (explicitAdjustedIds[product.id]) {
            const rate = Number(row?.ratePerPiece || 0);
            const wholesale = Number(row?.wholesalePrice || 0);
            const retail = Number(row?.retailPrice || 0);
            if (row?.ratePerPiece && row.ratePerPiece.trim() && rate > 0 && rate !== Number(product.ratePerPiece)) {
              update.ratePerPiece = rate;
            }
            if (row?.wholesalePrice && row.wholesalePrice.trim() && wholesale > 0) {
              update.wholesalePrice = wholesale;
            }
            if (row?.retailPrice && row.retailPrice.trim() && retail > 0) {
              update.retailPrice = retail;
            }
            return update.ratePerPiece === undefined && update.wholesalePrice === undefined && update.retailPrice === undefined ? [] : [update];
          }
          if (updateWholesalePrice && (existingSellingPricePolicy === "REPLACE" || !(Number(product.wholesalePrice) > 0))) {
            update.wholesalePrice = Number(row?.wholesalePrice || 0);
          }
          if (updateRetailPrice && (existingSellingPricePolicy === "REPLACE" || !(Number(product.retailPrice) > 0))) {
            update.retailPrice = Number(row?.retailPrice || 0);
          }
          return update.wholesalePrice === undefined && update.retailPrice === undefined ? [] : [update];
        });
  }


  const bulkPriceImpactAnalytics = useMemo(() => {
    if (!isFilteredSelection && confirmBulkPriceSave && explicitReviewPreview) {
      const affectedItems = explicitReviewPreview.preview.filter((item) => item.willChange).map((item) => {
        const oldWholesale = item.currentWholesalePrice === null ? null : Number(item.currentWholesalePrice);
        const newWholesale = item.newWholesalePrice === null ? null : Number(item.newWholesalePrice);
        const oldRetail = item.currentRetailPrice === null ? null : Number(item.currentRetailPrice);
        const newRetail = item.newRetailPrice === null ? null : Number(item.newRetailPrice);
        return {
          id: item.productId,
          name: item.name,
          sku: item.sku,
          rate: Number(item.newRate || 0),
          oldRate: item.currentRate === null ? null : Number(item.currentRate),
          newRate: item.newRate === null ? null : Number(item.newRate),
          oldWholesale,
          newWholesale,
          wholesaleChanged: newWholesale !== oldWholesale,
          wholesaleDelta: newWholesale !== null && oldWholesale !== null ? newWholesale - oldWholesale : null,
          oldRetail,
          newRetail,
          retailChanged: newRetail !== oldRetail,
          retailDelta: newRetail !== null && oldRetail !== null ? newRetail - oldRetail : null,
          stockPieces: 0,
        };
      });
      return {
        affectedCount: explicitReviewPreview.previewCount,
        preservedCount: Math.max(0, selectedProducts.length - explicitReviewPreview.previewCount - explicitReviewPreview.errorCount),
        affectedItems,
        avgWholesaleDelta: null,
        totalStockImpact: 0,
      };
    }
    if (isFilteredSelection) {
      const review = confirmBulkPriceSave ? filteredReviewPreview : null;
      const stats = review || filteredPreviewStats;
      const affectedCount = stats.previewCount || 0;
      const preservedCount = (stats.skippedExisting || 0) + (stats.skippedComingSoon || 0) + (stats.skippedMissingRate || 0);
      const affectedItems = (review?.preview || filteredPreviewItems).filter((item) => item.willChange);
      return {
        affectedCount,
        preservedCount,
        affectedItems: affectedItems.map((item) => {
          const newWholesale = item.newWholesalePrice;
          const newRetail = item.newRetailPrice;
          const oldWholesale = item.currentWholesalePrice;
          const oldRetail = item.currentRetailPrice;
          const wholesaleDelta = newWholesale !== null && oldWholesale !== null ? newWholesale - oldWholesale : null;
          const retailDelta = newRetail !== null && oldRetail !== null ? newRetail - oldRetail : null;
          return {
            id: item.productId,
            name: item.name,
            sku: item.sku,
            rate: item.rate,
            oldRate: item.currentRate,
            newRate: item.newRate,
            oldWholesale,
            newWholesale,
            wholesaleChanged: newWholesale !== oldWholesale,
            wholesaleDelta,
            oldRetail,
            newRetail,
            retailChanged: newRetail !== oldRetail,
            retailDelta,
            stockPieces: 0,
          };
        }),
        avgWholesaleDelta: null,
        totalStockImpact: 0,
      };
    }

    const updates = buildBulkPriceUpdates();
    const updateMap = new Map(updates.map((u) => [u.productId, u]));
    let totalWholesaleDelta = 0;
    let totalWholesaleDeltaCount = 0;
    let totalStockImpact = 0;

    const affectedItems = selectedProducts
      .filter((product) => updateMap.has(product.id))
      .map((product) => {
        const update = updateMap.get(product.id)!;
        const oldWholesale = product.wholesalePrice !== null ? Number(product.wholesalePrice) : null;
        const newWholesale = update.wholesalePrice !== undefined ? Number(update.wholesalePrice) : oldWholesale;
        const wholesaleDelta = newWholesale !== null && oldWholesale !== null ? newWholesale - oldWholesale : null;
        if (wholesaleDelta !== null) {
          totalWholesaleDelta += wholesaleDelta;
          totalWholesaleDeltaCount += 1;
        }

        const oldRetail = product.retailPrice !== null ? Number(product.retailPrice) : null;
        const newRetail = update.retailPrice !== undefined ? Number(update.retailPrice) : oldRetail;
        const retailDelta = newRetail !== null && oldRetail !== null ? newRetail - oldRetail : null;

        const stockPieces = Number(product.stock || 0);
        if (wholesaleDelta !== null && stockPieces > 0) {
          totalStockImpact += wholesaleDelta * stockPieces;
        }

        return {
          id: product.id,
          name: product.name,
          sku: product.sku,
          rate: Number(product.ratePerPiece || 0),
          oldRate: product.ratePerPiece === null ? null : Number(product.ratePerPiece),
          newRate: update.ratePerPiece === undefined ? (product.ratePerPiece === null ? null : Number(product.ratePerPiece)) : Number(update.ratePerPiece),
          oldWholesale,
          newWholesale,
          wholesaleChanged: newWholesale !== oldWholesale,
          wholesaleDelta,
          oldRetail,
          newRetail,
          retailChanged: newRetail !== oldRetail,
          retailDelta,
          stockPieces,
        };
      });

    const affectedCount = updates.length;
    const preservedCount = Math.max(0, selectedProducts.length - affectedCount);
    const avgWholesaleDelta = totalWholesaleDeltaCount > 0 ? totalWholesaleDelta / totalWholesaleDeltaCount : null;

    return {
      affectedCount,
      preservedCount,
      avgWholesaleDelta,
      totalStockImpact,
      affectedItems,
    };
  }, [
    confirmBulkPriceSave,
    explicitReviewPreview,
    filteredReviewPreview,
    isFilteredSelection,
    filteredPreviewStats,
    filteredPreviewItems,
    filteredPriceOverrides,
    selectedProducts,
    priceRows,
    priceMarginTargetIds,
    explicitAdjustedIds,
    updateWholesalePrice,
    updateRetailPrice,
    existingSellingPricePolicy,
    bulkPriceMode,
  ]);

  async function requestBulkPriceUpdate() {
    if (!pricePreviewReady) {
      const message = "Calculate the preview before saving.";
      setBulkPriceNotice({ tone: "danger", message });
      toastMsg("info", message);
      return;
    }
    const updates = buildBulkPriceUpdates();

    const rowErrors: NonNullable<BulkPriceErrors["rows"]> = {};
    if (isFilteredSelection) {
      Object.entries(filteredPriceOverrides).forEach(([productId, row]) => {
        const errors: Partial<Record<PriceField, string>> = {};
        (Object.keys(row) as PriceField[]).forEach((field) => {
          const value = row[field].trim();
          const requiredForOverride = field === "ratePerPiece"
            || (field === "wholesalePrice" && updateWholesalePrice)
            || (field === "retailPrice" && updateRetailPrice);
          if (!value && requiredForOverride) {
            errors[field] = field === "ratePerPiece"
              ? "Enter a Rate or choose Use rule."
              : `Enter the ${field === "wholesalePrice" ? "wholesale" : "retail"} price or choose Use rule.`;
            return;
          }
          if (value && (!Number.isFinite(Number(value)) || Number(value) <= 0)) {
            errors[field] = field === "ratePerPiece"
              ? "Enter a Rate greater than 0."
              : `Enter a ${field === "wholesalePrice" ? "wholesale" : "retail"} price greater than 0.`;
          }
        });
        if (Object.keys(errors).length > 0) rowErrors[productId] = errors;
      });
    } else {
      updates.forEach((row) => {
        const errors: Partial<Record<PriceField, string>> = {};
        const product = selectedProducts.find((item) => item.id === row.productId);
        if (row.ratePerPiece !== undefined && (!Number.isFinite(row.ratePerPiece) || row.ratePerPiece <= 0)) errors.ratePerPiece = "Enter a Rate greater than 0.";
        if (bulkPriceMode === "MANUAL" && product?.availabilityStatus !== "COMING_SOON" && ![row.ratePerPiece ?? product?.ratePerPiece, row.retailPrice ?? product?.retailPrice, row.wholesalePrice ?? product?.wholesalePrice].some((value) => Number(value) > 0)) errors.ratePerPiece = "Enter a Rate greater than 0.";
        if (row.wholesalePrice !== undefined && (!Number.isFinite(row.wholesalePrice) || row.wholesalePrice <= 0)) errors.wholesalePrice = "Enter a wholesale price greater than 0.";
        if (row.retailPrice !== undefined && (!Number.isFinite(row.retailPrice) || row.retailPrice <= 0)) errors.retailPrice = "Enter a retail price greater than 0.";
        if (Object.keys(errors).length > 0) rowErrors[row.productId] = errors;
      });
    }
    const nextErrors: BulkPriceErrors = {
      reason: priceReason.trim() ? undefined : "Enter a reason so this price change has an audit record.",
      rows: Object.keys(rowErrors).length > 0 ? rowErrors : undefined,
    };
    setBulkPriceErrors(nextErrors);
    const firstInvalidRow = Object.entries(rowErrors)[0];
    const firstInvalidField = firstInvalidRow
      ? (Object.keys(firstInvalidRow[1])[0] as PriceField | undefined)
      : undefined;
    if (firstInvalidRow && firstInvalidField) {
      const message = firstInvalidRow?.[1]?.[firstInvalidField!] || "Check the highlighted price.";
      setBulkPriceNotice({ tone: "danger", message });
      setPendingInvalidPriceFocus({ productId: firstInvalidRow[0], field: firstInvalidField });
      if (isFilteredSelection) {
        setInvalidFilteredOverrideId(firstInvalidRow[0]);
        if (!filteredPreviewItems.some((item) => item.productId === firstInvalidRow[0]) && !selectedProductCache[firstInvalidRow[0]]) {
          void fetchProductsByIds([firstInvalidRow[0]]).then((products) => {
            if (products[0]) {
              setSelectedProductCache((current) => ({ ...current, [products[0].id]: products[0] }));
            }
          }).catch(() => {
            // The correction remains available by product ID even when its name cannot load.
          });
        }
      } else if (priceSearch && !visibleBulkPriceProducts.some((product) => product.id === firstInvalidRow[0])) {
        setPriceSearch("");
      }
      return;
    }
    if (nextErrors.reason) {
      focusInvalidField(priceReasonRef);
      setBulkPriceNotice({ tone: "danger", message: nextErrors.reason });
      return;
    }

    if (!isFilteredSelection && updates.length === 0) {
      const message = "No prices are ready to save. Check the preview message above.";
      setBulkPriceNotice({ tone: "danger", message });
      toastMsg("info", message);
      return;
    }

    if (isFilteredSelection) {
      try {
        setPriceBusy(true);
        // The confirmation must show a representative affected sample, not an
        // empty list caused by a temporary search in the editable preview.
        const result = await loadFilteredPricePreview(1, "", bulkPriceStep2PageSize);
        if (result.errorCount > 0) {
          setBulkPriceNotice({ tone: "danger", message: `${result.errorCount} product${result.errorCount === 1 ? "" : "s"} could not be previewed. ${result.errors[0]?.message || "Check the selected products before saving."}` });
          return;
        }
        if (result.previewCount === 0) {
          const message = "No prices are ready to save. Adjust a product or change the pricing choices.";
          setBulkPriceNotice({ tone: "danger", message });
          toastMsg("info", message);
          return;
        }
        setFilteredReviewPreview(result);
      } catch (error: any) {
        const message = error?.response?.data?.error || error?.message || "The latest prices could not be checked.";
        setBulkPriceNotice({ tone: "danger", message });
        toastMsg("danger", message);
        return;
      } finally {
        setPriceBusy(false);
      }
    } else {
      try {
        setPriceBusy(true);
        const result = await bulkUpdateProductPricesApi({
          reason: priceReason.trim() || "Preview",
          scope: "IDS" as const,
          updates,
          existingPricePolicy: bulkPriceMode === "MANUAL" ? "REPLACE" : existingSellingPricePolicy,
          previewOnly: true,
          previewPage: 1,
          previewPageSize: 25,
        });
        if (result.errorCount > 0) {
          setBulkPriceNotice({ tone: "danger", message: `${result.errorCount} product${result.errorCount === 1 ? "" : "s"} could not be previewed. ${result.errors[0]?.message || "Check the selected products before saving."}` });
          return;
        }
        if (!result.previewRevision || result.previewCount === 0) {
          setBulkPriceNotice({ tone: "danger", message: "No products can be updated with these choices. Check the latest prices and try again." });
          return;
        }
        setExplicitReviewPreview(result);
        setReviewPage(1);
        setBulkPricePreviewRevision(result.previewRevision || null);
      } catch (error: any) {
        const message = error?.response?.data?.error || error?.message || "The latest prices could not be checked.";
        setBulkPriceNotice({ tone: "danger", message });
        toastMsg("danger", message);
        return;
      } finally {
        setPriceBusy(false);
      }
    }

    setBulkPriceNotice(null);
    setBulkPriceErrors({});
    setInvalidFilteredOverrideId(null);
    setSaveOutcomeUncertain(false);
    setConfirmBulkPriceSave(true);
  }

  async function loadExplicitReviewPage(nextPage: number) {
    if (!explicitReviewPreview || reviewLoading) return;
    const requestId = ++reviewRequestIdRef.current;
    try {
      setReviewLoading(true);
      const result = await bulkUpdateProductPricesApi({
        reason: priceReason.trim() || "Preview",
        scope: "IDS",
        updates: buildBulkPriceUpdates(),
        existingPricePolicy: bulkPriceMode === "MANUAL" ? "REPLACE" : existingSellingPricePolicy,
        previewOnly: true,
        previewPage: nextPage,
        previewPageSize: 25,
      });
      if (requestId !== reviewRequestIdRef.current) return;
      if (result.previewRevision !== bulkPricePreviewRevision) {
        setConfirmBulkPriceSave(false);
        setBulkPricePreviewRevision(null);
        setBulkPriceNotice({ tone: "danger", message: "Prices changed while you were reviewing. Check a fresh preview before saving." });
        return;
      }
      setExplicitReviewPreview(result);
      setReviewPage(result.previewPage);
    } catch (error: any) {
      if (requestId === reviewRequestIdRef.current) setBulkPriceNotice({ tone: "danger", message: error?.response?.data?.error || error?.message || "The requested review page could not be loaded." });
    } finally {
      if (requestId === reviewRequestIdRef.current) setReviewLoading(false);
    }
  }

  async function confirmBulkPriceUpdate() {
    if (!priceReason.trim()) {
      setBulkPriceErrors((current) => ({ ...current, reason: "Enter a reason so this price change has an audit record." }));
      focusInvalidField(priceReasonRef);
      return;
    }
    const updates = buildBulkPriceUpdates();
    const finalRevision = isFilteredSelection ? filteredReviewPreview?.previewRevision : explicitReviewPreview?.previewRevision;
    if (!finalRevision) {
      const message = "The price preview is no longer available. Preview the latest prices before saving.";
      setBulkPriceNotice({ tone: "danger", message });
      setConfirmBulkPriceSave(false);
      return;
    }
    try {
      setPriceBusy(true);
      const result = await bulkUpdateProductPricesApi({
        reason: priceReason.trim(),
        expectedPreviewRevision: finalRevision,
        ...(isFilteredSelection
          ? {
              scope: "FILTERED" as const,
              filters: currentProductFilters,
              excludedProductIds: filteredExcludedIds,
              overrides: buildFilteredPriceOverrides(),
              ...(updateWholesalePrice ? { wholesalePercent: wholesaleMarginPercent } : {}),
              ...(updateRetailPrice ? { retailPercent: retailMarginPercent } : {}),
              direction: priceChangeDirection,
            }
          : { scope: "IDS" as const, updates }),
        existingPricePolicy: bulkPriceMode === "MANUAL" ? "REPLACE" : existingSellingPricePolicy,
      });
      setConfirmBulkPriceSave(false);
      setBulkPriceTouched(false);
      setOpenBulkPrice(false);
      clearBulkSelection();
      setBulkPriceResult({
        updatedCount: result.updatedCount,
        skippedCount: result.skippedComingSoon + result.skippedMissingRate + result.skippedExisting,
        errorCount: result.errorCount,
        errors: (result.errors || []).map((failure) => {
          const product = selectedProducts.find((item) => item.id === failure.productId)
            || products.find((item) => item.id === failure.productId);
          return { ...failure, name: product?.name, sku: product?.sku };
        }),
        products: result.products || [],
        isPartialSuccess: result.partialSuccess,
        auditWarning: result.auditWarning || null,
      });
      await refreshProductsAfterSavedMutation();
    } catch (error: any) {
      if (error?.response?.status === 409 && error?.response?.data?.code === "PRICE_PREVIEW_STALE") {
        setBulkPriceNotice({ tone: "danger", message: "Prices were updated by another action while you were reviewing. Please preview again with the latest data." });
        setConfirmBulkPriceSave(false);
        setPricePreviewReady(false);
        setExplicitReviewPreview(null);
        setBulkPricePreviewRevision(null);
        await refreshProductsAfterSavedMutation();
        return;
      }
      // The request may have committed some row transactions before the connection
      // failed. Never allow the same preview revision to be submitted again.
      setSaveOutcomeUncertain(true);
      setConfirmBulkPriceSave(false);
      setPricePreviewReady(false);
      setExplicitReviewPreview(null);
      setBulkPricePreviewRevision(null);
      const message = "Save outcome is uncertain. Some prices may already have changed. Check History, then calculate and review a fresh preview before retrying.";
      setBulkPriceNotice({ tone: "danger", message });
      toastMsg("danger", message);
      try {
        if (!isFilteredSelection) {
          const fresh = await fetchProductsByIds(selectedIds);
          const freshIds = new Set(fresh.map((product) => product.id));
          setSelectedProductCache((current) => ({ ...current, ...Object.fromEntries(fresh.map((product) => [product.id, product])) }));
          if (bulkPriceMode === "CALCULATE") {
            setPriceRows((current) => ({
              ...current,
              ...Object.fromEntries(fresh.filter((product) => !explicitAdjustedIds[product.id]).map((product) => [product.id, {
                ratePerPiece: product.ratePerPiece === null ? "" : String(product.ratePerPiece),
                wholesalePrice: product.wholesalePrice === null ? "" : String(product.wholesalePrice),
                retailPrice: product.retailPrice === null ? "" : String(product.retailPrice),
              }])),
            }));
          }
          if (selectedIds.some((id) => !freshIds.has(id))) {
            setBulkPriceNotice({ tone: "danger", message: `${message} Some selected products could not be reloaded; do not retry until they are checked.` });
          }
        }
        await refreshProductsAfterSavedMutation();
      } catch {
        setBulkPriceNotice({ tone: "danger", message: `${message} The latest products could not be loaded; do not retry until connectivity is restored.` });
      }
    } finally {
      setPriceBusy(false);
    }
  }

  async function handleImportReviewedPdfRows(
    rows: ReviewedPdfImportRowPayload[],
    ignoredRowIds: string[],
  ) {
    if (!pdfReviewBatch) return;

    try {
      setPdfReviewBusy(true);
      setImportError("");
      const result = await importReviewedPdfRowsApi(pdfReviewBatch.id, {
        rows,
        ignoredRowIds,
        approved: true,
      });
      setPdfReviewBatch(result.batch);
      setImportResult({
        totalRows: result.totalRows,
        createdCount: result.createdCount,
        errorCount: result.errorCount,
        createdProducts: result.createdProducts || [],
        errors: result.errors,
        batchId: result.batch.id,
        sourceType: result.batch.sourceType,
        message:
          result.errorCount > 0
            ? `${result.createdCount} reviewed row${result.createdCount === 1 ? "" : "s"} imported with ${result.errorCount} issue${result.errorCount === 1 ? "" : "s"}.`
            : `${result.createdCount} reviewed row${result.createdCount === 1 ? "" : "s"} imported into products.`,
      });
      await loadMeta();
      await loadImportBatches();
      await loadProducts();
      clearBulkSelection();
      setLastImportedProducts(result.createdProducts || []);
      setLastImportSupplier(result.batch.supplier || pdfReviewBatch.supplier || importSupplier.trim() || "");
      toastMsg(
        result.errorCount > 0 ? "info" : "success",
        result.errorCount > 0
          ? "Reviewed rows imported with issues."
          : "Reviewed rows imported.",
      );
    } catch (error: any) {
      const message =
        error?.response?.data?.error ||
        error?.message ||
        "Failed to import reviewed rows.";
      setImportError(message);
    } finally {
      setPdfReviewBusy(false);
    }
  }

  async function handleSaveReviewedPdfRows(rows: ReviewedPdfImportRowPayload[]) {
    if (!pdfReviewBatch) throw new Error("Open an import review before saving rows.");
    const result = await saveReviewedProductImportRowsApi(pdfReviewBatch.id, rows);
    const savedById = new Map(result.rows.map((row) => [row.id, row]));
    setPdfReviewBatch((current) =>
      current
        ? {
            ...current,
            rows: current.rows.map((row) => savedById.get(row.id) || row),
          }
        : current,
    );
  }

  return (
    <div className="space-y-[14px]">
      {openingRequestedEditProduct ? (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/25 px-5 backdrop-blur-[2px]"
          role="status"
          aria-live="polite"
          aria-label="Opening product editor"
        >
          <div className="flex min-h-20 items-center gap-3 rounded-[16px] border border-slate-200 bg-white px-5 py-4 shadow-2xl">
            <Icon name="progress_activity" className="animate-spin text-[24px] text-slate-950" />
            <div>
              <div className="text-[14px] font-extrabold text-slate-950">Opening product editor</div>
              <div className="mt-0.5 text-[12px] font-semibold text-slate-500">Loading the selected product…</div>
            </div>
          </div>
        </div>
      ) : null}

      {/* handing all current filter state and bulk action callbacks into the shared filter/header card */}
      <div ref={productCatalogControlsRef}>
        <ProductsFiltersCard
          stockTracked={stockTracked}
          q={q}
          setQ={setQ}
          brands={brands}
          brand={brand}
          setBrand={updateBrand}
          categories={categories}
          category={category}
          setCategory={updateCategory}
          stockStatus={stockStatus}
          setStockStatus={updateStockStatus}
          status={status}
          setStatus={updateStatus}
          sortBy={sortBy}
          setSortBy={updateSortBy}
          pricingStatus={pricingStatus}
          setPricingStatus={updatePricingStatus}
          photoStatus={photoStatus}
          setPhotoStatus={updatePhotoStatus}
          onClear={clearFilters}
          onAdd={openAdd}
          onImport={() => {
            resetImportState();
            setOpenImport(true);
            void Promise.allSettled([
              loadImportBatches(),
              loadImportTemplates(),
            ]);
          }}
          onManageStock={openStockManagerForSelection}
          onSearchInsights={isAdmin ? () => setOpenSearchInsights(true) : undefined}
          purchaseCostVisible={purchaseCostVisible}
          onTogglePurchaseCost={isAdmin ? togglePurchaseCostVisibility : undefined}
        />
      </div>

      {(importAttention?.count ?? actionableImportBatches.length) > 0 ? (
        <section aria-labelledby="import-activity-heading" className="overflow-hidden rounded-[12px] border border-[#CFE1D5] bg-[#F7FBF8] shadow-2xs transition-all">
          <div className="flex items-center justify-between gap-1.5 sm:gap-2.5 px-2.5 py-2 sm:px-4 sm:py-2.5 flex-nowrap min-w-0">
            <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
              <span className="inline-flex h-6 min-w-6 items-center justify-center gap-1 rounded-full bg-amber-100 px-2 text-[11px] font-extrabold text-amber-900 border border-amber-200/90 shrink-0">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-600 animate-pulse" />
                {importAttention?.count ?? actionableImportBatches.length}
              </span>
              <div className="min-w-0">
                <h2 id="import-activity-heading" className="text-[12px] sm:text-[12.5px] font-bold text-[#11120d] truncate">
                  Imports need attention
                </h2>
              </div>
              <span className="hidden xl:inline text-[11px] font-medium text-[#567060] truncate">
                — Resume extraction or review without starting over
              </span>
            </div>

            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  resetImportState();
                  setOpenImport(true);
                  void Promise.allSettled([loadImportBatches(), loadImportTemplates()]).then(() => {
                    setTimeout(() => {
                      const el = document.getElementById("recent-import-history");
                      if (el) {
                        el.scrollIntoView({ behavior: "smooth", block: "start" });
                      }
                    }, 150);
                  });
                }}
                className="inline-flex h-7.5 sm:h-8 items-center gap-1 sm:gap-1.5 rounded-[8px] bg-[#11120d] px-2 sm:px-3 text-[11px] sm:text-[11.5px] font-bold text-white transition hover:bg-[#2a2c27] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#11120d] shrink-0 whitespace-nowrap"
                title="Open recent import history"
              >
                <span className="hidden sm:inline-flex" aria-hidden="true"><Icon name="history" sizePx={14} /></span>
                <span>Recent imports</span>
              </button>

              <button
                type="button"
                onClick={() => setActionableImportsExpanded((current) => !current)}
                className="inline-flex h-7.5 sm:h-8 items-center gap-1 rounded-[8px] border border-[#BBD7C5] bg-white px-2 sm:px-2.5 text-[11px] sm:text-[11.5px] font-bold text-[#16753A] transition hover:bg-[#EAF8EF] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#179B4D] shrink-0 whitespace-nowrap"
                aria-expanded={actionableImportsExpanded}
                title={actionableImportsExpanded ? "Hide the list of pending imports" : "Show the list of pending imports"}
              >
                <span className="hidden sm:inline-flex" aria-hidden="true"><Icon name={actionableImportsExpanded ? "expand_less" : "expand_more"} sizePx={15} /></span>
                <span>{actionableImportsExpanded ? "Hide list" : "Show list"}</span>
              </button>
            </div>
          </div>

          {actionableImportsExpanded ? (
            <div className="border-t border-[#DCE9E0] p-2 sm:p-2.5 grid gap-2 sm:grid-cols-2 xl:grid-cols-3 bg-[#F0F6F2]">
              {actionableImportBatches.slice(0, 3).map((batch) => {
                const meta = getActionableImportCardMeta(batch);
                return (
                  <button
                    key={batch.id}
                    type="button"
                    onClick={() => void openImportBatchById(batch.id)}
                    className={`flex min-w-0 items-center gap-3 rounded-[10px] border border-[#CFE1D5] bg-white p-3 text-left transition shadow-2xs hover:shadow-xs hover:border-[#179B4D]/60 ${meta.cardHoverClass} focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#179B4D]`}
                    aria-label={`${meta.statusLabel}: ${batch.fileName || "Untitled import"}. Open import.`}
                  >
                    <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border ${meta.fileIconBoxClass}`}>
                      <Icon
                        name={meta.fileIcon}
                        sizePx={20}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="truncate text-[12.5px] font-bold text-[#1E293B]">
                          {batch.fileName || "Untitled import"}
                        </span>
                        <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-extrabold shrink-0 ${meta.badgeClass}`}>
                          <Icon name={meta.badgeIcon} sizePx={11} className={meta.spinning ? "animate-spin" : undefined} />
                          <span>{meta.statusLabel}</span>
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[10.5px] font-semibold text-[#64748B]">
                        <span>{meta.statsText}</span>
                        <span>•</span>
                        <span>{formatDocumentDate(batch.createdAt)}</span>
                        <span>•</span>
                        <span className="uppercase">{displaySourceType(batch.sourceType)}</span>
                      </div>
                    </div>
                    <Icon name="chevron_right" sizePx={18} className="shrink-0 text-[#94A3B8]" />
                  </button>
                );
              })}
            </div>
          ) : null}
        </section>
      ) : null}

      {selectedCount > 0 ? (
        <>
        {/* ── mobile selection bar (< lg) ── */}
        <div
          className={`selection-sticky-wrap sticky top-0 z-[30] -mx-3 sm:-mx-5 lg:hidden ${
            isSelectionPinned
              ? "bg-white/95 px-3 pb-2 pt-2 shadow-[0_10px_18px_-16px_rgba(15,23,42,0.7)] backdrop-blur-md sm:px-5"
              : "px-3 pt-0 sm:px-5"
          }`}
        >
          <div
            role="toolbar"
            aria-label="Selected product actions"
            className="animate-selection-bar-enter overflow-hidden rounded-[14px] border border-[#9DD8B2] bg-[#F3FBF6] text-[#11120d] shadow-sm"
          >
            {/* ── main row: always visible, smoothly adapts padding ── */}
            <div
              className="flex items-center gap-2 px-3 py-2 transition-[padding,min-height] duration-[280ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
              style={{ minHeight: 52 }}
            >
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#179B4D] text-white">
                <Icon name="check" sizePx={16} />
              </span>
              <button
                type="button"
                onClick={() => setOpenSelectedProducts(true)}
                className="min-w-0 flex-1 text-left"
              >
                <span className="block truncate text-[13px] font-extrabold text-[#11120d]" aria-live="polite">
                  {isFilteredSelection
                    ? `${selectedCount.toLocaleString()} of ${total.toLocaleString()} matching`
                    : `${selectedIds.length.toLocaleString()} selected`}
                </span>
                <span className="block text-[10px] font-semibold text-[#567060]">Tap to review selection</span>
              </button>
              <button
                type="button"
                onClick={() => setOpenMobileBulkActions(true)}
                className="inline-flex h-9 shrink-0 items-center justify-center rounded-[9px] bg-[#11120d] px-3 text-[11px] font-extrabold text-white transition hover:bg-[#2a2c27]"
              >
                Actions
              </button>
              <button
                type="button"
                onClick={clearBulkSelection}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border border-[#9DD8B2] bg-white text-[#16753A] transition hover:bg-[#EAF8EF]"
                aria-label="Clear product selection"
              >
                <Icon name="close" sizePx={18} />
              </button>
            </div>

            {/* ── sub-row: collapses smoothly via grid-rows animation ── */}
            <div
              className="selection-sub-row"
              data-collapsed={isSelectionPinned ? "true" : "false"}
            >
              <div>
                <div className="grid grid-cols-2 gap-2 border-t border-[#D8EADF] p-2 text-[11px] font-extrabold text-[#16753A]">
                  <button type="button" onClick={() => toggleAllOnPage(true)} className="inline-flex h-9 items-center justify-center rounded-[9px] border border-[#9DD8B2] bg-white px-2 transition hover:bg-[#EAF8EF]">Select page ({pageItems.length})</button>
                  {canSelectAllMatching ? <button type="button" onClick={selectAllMatchingProducts} className="inline-flex h-9 items-center justify-center rounded-[9px] border border-[#9DD8B2] bg-white px-2 transition hover:bg-[#EAF8EF]">Select all {total.toLocaleString()}</button> : <button type="button" onClick={() => setOpenSelectedProducts(true)} className="inline-flex h-9 items-center justify-center rounded-[9px] border border-[#9DD8B2] bg-white px-2 transition hover:bg-[#EAF8EF]">Review selected</button>}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── desktop selection bar (>= lg) ── */}
        <div
          className={`selection-sticky-wrap sticky top-0 z-[30] hidden lg:block ${
            isSelectionPinned
              ? "-mx-6 px-6 pb-3 pt-3 bg-white/95 shadow-[0_10px_18px_-16px_rgba(15,23,42,0.7)] backdrop-blur-md"
              : ""
          }`}
        >
          <div className="animate-selection-bar-enter border-y border-[#D9DCE1] bg-white px-[16px] py-[12px] shadow-[0_8px_18px_-18px_rgba(15,23,42,0.65)]">
            <div className="flex flex-col gap-[10px] lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-start gap-[10px]">
                <span className="mt-[2px] inline-flex h-[28px] w-[28px] items-center justify-center rounded-[8px] bg-[#F3F4F6] text-[#11120d]">
                  <Icon name={isFilteredSelection ? "select_all" : "checklist"} className="text-[17px]" />
                </span>
                <div>
                  <div className="text-[14px] font-bold text-[#11120d]">
                    {isFilteredSelection
                      ? `${selectedCount.toLocaleString()} of ${total.toLocaleString()} matching products selected`
                      : `${selectedIds.length.toLocaleString()} product${selectedIds.length === 1 ? "" : "s"} selected`}
                  </div>
                  <div className="mt-[2px] text-[12px] font-medium text-[#6B7280]">
                    {isFilteredSelection
                      ? filteredExcludedIds.length > 0
                        ? `${filteredExcludedIds.length.toLocaleString()} product${filteredExcludedIds.length === 1 ? " is" : "s are"} excluded. Bulk price changes will skip them.`
                        : "Bulk actions will use the current search and filters."
                      : canSelectAllMatching
                        ? `Only this page is selected. There are ${total.toLocaleString()} products matching your filters.`
                        : "Bulk actions will apply only to the selected rows."}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-[8px]">
                {canSelectAllMatching ? (
                  <button
                    type="button"
                    onClick={selectAllMatchingProducts}
                    className="rounded-[10px] border border-[#11120d] bg-[#11120d] px-[12px] py-[8px] text-[12px] font-bold text-white transition hover:bg-[#2a2c27]"
                  >
                    Select all {total.toLocaleString()} matching products
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setOpenSelectedProducts(true)}
                  className="rounded-[10px] border border-[#CFCFD3] bg-white px-[12px] py-[8px] text-[12px] font-bold text-[#11120d] transition hover:bg-[#F3F4F6]"
                >
                  Review selected
                </button>
                {!isFilteredSelection ? (
                  <>
                    <button type="button" onClick={openBulkPriceForSelection} className="inline-flex min-h-10 items-center gap-2 rounded-[10px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-bold text-[#11120d] transition hover:bg-[#F3F4F6]"><Icon name="sell" className="text-[17px]" />Set Prices</button>
                    {stockTracked ? <button type="button" onClick={openStockManagerForSelection} className="inline-flex min-h-10 items-center gap-2 rounded-[10px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-bold text-[#11120d] transition hover:bg-[#F3F4F6]"><Icon name="inventory_2" className="text-[17px]" />Stock Movement</button> : null}
                    <button type="button" onClick={() => void activateSelected()} className="inline-flex min-h-10 items-center gap-2 rounded-[10px] border border-[#9DD8B2] bg-[#F3FBF6] px-3 text-[12px] font-bold text-[#16753A] transition hover:bg-[#EAF8EF]"><Icon name="toggle_on" className="text-[18px]" />Activate</button>
                    <button type="button" onClick={requestSoftDeleteSelected} className="inline-flex min-h-10 items-center gap-2 rounded-[10px] border border-[#FECDD3] bg-[#FFF1F2] px-3 text-[12px] font-bold text-[#BE123C] transition hover:bg-rose-100"><Icon name="do_not_disturb_on" className="text-[17px]" />Set inactive</button>
                  </>
                ) : (
                  <button type="button" onClick={openBulkPriceForSelection} className="inline-flex min-h-10 items-center gap-2 rounded-[10px] border border-[#11120d] bg-[#11120d] px-3 text-[12px] font-bold text-white transition hover:bg-[#2a2c27]"><Icon name="sell" className="text-[17px]" />Set Prices</button>
                )}
                <button
                  type="button"
                  onClick={clearBulkSelection}
                  className="rounded-[10px] border border-[#CFCFD3] bg-white px-[12px] py-[8px] text-[12px] font-bold text-[#565449] transition hover:bg-[#F3F4F6]"
                >
                  Clear selection
                </button>
              </div>
            </div>
          </div>
        </div>
        </>
      ) : null}

      {openMobileBulkActions && selectedCount > 0 ? (
        <div className="fixed inset-0 z-[125] lg:hidden">
          <button type="button" onClick={() => setOpenMobileBulkActions(false)} className="absolute inset-0 bg-slate-950/55" aria-label="Close selected product actions" />
          <section role="dialog" aria-modal="true" aria-label="Selected product actions" className="absolute inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto rounded-t-[26px] bg-white px-4 pb-0 pt-3 shadow-2xl">
            <div className="mx-auto h-1.5 w-14 rounded-full bg-[#CFCFD3]" />
            <div className="mt-3 flex items-center justify-between border-b border-[#E5E7EB] pb-3"><h2 className="text-[22px] font-extrabold text-[#11120d]">{selectedCount.toLocaleString()} products selected</h2><button type="button" onClick={() => setOpenMobileBulkActions(false)} className="h-11 w-11" aria-label="Close actions"><Icon name="close" className="text-[26px]" /></button></div>
            {isFilteredSelection ? (
              <p className="mt-3 rounded-[12px] border border-[#BFDBFE] bg-[#EFF6FF] p-3 text-[13px] font-medium leading-5 text-[#1D4ED8]">
                This selection represents all current matches. Only Set Prices supports this broad scope; stock and status changes require exact rows.
              </p>
            ) : null}
            {[
              { icon: "toggle_on", label: "Activate selected", tone: "bg-[#EAF8EF] text-[#179B4D]", action: () => void activateSelected() },
              { icon: "do_not_disturb_on", label: "Set inactive", tone: "bg-[#F3F4F6] text-[#565449]", action: requestSoftDeleteSelected },
              { icon: "sell", label: "Set Prices", tone: "bg-[#F3F4F6] text-[#565449]", action: openBulkPriceForSelection },
              { icon: "inventory_2", label: "Stock Movement", tone: "bg-[#F3F4F6] text-[#565449]", action: openStockManagerForSelection },
            ].filter((item) => (stockTracked || item.label !== "Stock Movement") && (!isFilteredSelection || item.label === "Set Prices")).map((item) => (
              <button key={item.label} type="button" onClick={() => { setOpenMobileBulkActions(false); item.action(); }} className="flex min-h-[66px] w-full items-center gap-3 border-b border-[#E5E7EB] text-left"><span className={`inline-flex h-11 w-11 items-center justify-center rounded-[12px] ${item.tone}`}><Icon name={item.icon} className="text-[22px]" /></span><span className="flex-1 text-[15px] font-bold text-[#11120d]">{item.label}</span><Icon name="chevron_right" className="text-[#565449]" /></button>
            ))}
            <button type="button" onClick={() => setOpenMobileBulkActions(false)} className="mt-4 h-[50px] w-full rounded-[12px] bg-[#11120d] text-[14px] font-bold text-white">Done</button>
            <button type="button" onClick={() => { setOpenMobileBulkActions(false); clearBulkSelection(); }} className="mt-2 min-h-[calc(44px+env(safe-area-inset-bottom))] w-full pb-[env(safe-area-inset-bottom)] text-[14px] font-bold text-[#565449]">Cancel selection</button>
          </section>
        </div>
      ) : null}

      {/* this table only receives the current client-side page slice, not the full product array */}
      <ProductsTableCard
        hasActiveCatalogFilters={
          debouncedQ !== "" ||
          brand !== "All Brands" ||
          category !== "All Categories" ||
          (stockTracked && stockStatus !== "all") ||
          (stockTracked && lowOnly) ||
          status !== "active" ||
          pricingStatus !== "all" ||
          photoStatus !== "all"
        }
        stockTracked={stockTracked}
        purchaseCostVisible={purchaseCostVisible}
        rows={pageItems}
        loading={productsLoading}
        loadError={productsLoadError}
        selected={effectiveSelected}
        selectionModeActive={selectedCount > 0}
        toggleAllOnPage={toggleAllOnPage}
        toggleOne={toggleOne}
        onView={openViewProduct}
        onEdit={openEdit}
        onDelete={requestDelete}
        total={total}
        start={pageStart}
        end={pageEnd}
        page={pageClamped}
        totalPages={totalPages}
        pageSize={tablePageSize}
        onPageChange={(nextPage) => {
          setPage(nextPage);
        }}
        onPageSizeChange={(nextPageSize) => {
          setTablePageSize(nextPageSize);
          setPage(1);
        }}
        onClearFilters={clearFilters}
        onRetry={() => void loadProducts()}
      />

      <ModalFrame
        open={openSelectedProducts}
        title="Selected products"
        description={isFilteredSelection
          ? `${selectedCount.toLocaleString()} of ${total.toLocaleString()} products matching the current filters are selected.`
          : `${selectedCount.toLocaleString()} product${selectedCount === 1 ? "" : "s"} selected across the catalog.`}
        onClose={() => setOpenSelectedProducts(false)}
        maxWidthClass="max-w-[620px]"
        mobileBottomSheet
        footer={(
          <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-3">
            <button type="button" onClick={clearBulkSelection} className="min-h-11 px-2 text-[13px] font-bold text-[#BE123C]">
              Clear selection
            </button>
            <DialogButton variant="primary" onClick={() => setOpenSelectedProducts(false)}>Done</DialogButton>
          </div>
        )}
      >
        {isFilteredSelection ? (
          <div className="space-y-4">
            <div className="rounded-[14px] border border-[#BFDBFE] bg-[#EFF6FF] p-4 text-[13px] leading-6 text-[#1D4ED8]">
              This is a filter-based selection, so newly matching products are included. Deselect products on any page to exclude them. Only the supported bulk price action can use this broad scope.
            </div>
            {filteredExcludedIds.length > 0 ? (
              <section aria-labelledby="excluded-products-heading">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h3 id="excluded-products-heading" className="text-[12px] font-extrabold uppercase tracking-wide text-[#565449]">
                    Excluded ({filteredExcludedIds.length})
                  </h3>
                  <button
                    type="button"
                    onClick={() => setFilteredSelectionExclusions({})}
                    className="min-h-11 text-[12px] font-bold text-[#1D4ED8] underline underline-offset-4"
                  >
                    Include all again
                  </button>
                </div>
                <div className="divide-y divide-[#E5E7EB] overflow-hidden rounded-[14px] border border-[#E5E7EB]">
                  {Object.values(filteredSelectionExclusions).map((product) => (
                    <div key={product.id} className="flex min-h-[64px] items-center gap-3 bg-white px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-extrabold text-[#11120d]">{product.name}</div>
                        <div className="mt-1 truncate text-[11px] font-semibold text-[#6B7280]">SKU: {product.sku || "-"}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => toggleOne(product.id, true)}
                        className="min-h-11 rounded-[10px] px-3 text-[12px] font-bold text-[#16753A] transition hover:bg-[#F3FBF6]"
                        aria-label={`Include ${product.name} again`}
                      >
                        Include
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : (
          <div className="divide-y divide-[#E5E7EB] overflow-hidden rounded-[14px] border border-[#E5E7EB]">
            {selectedProducts.map((product) => (
              <div key={product.id} className="flex min-h-[68px] items-center gap-3 bg-white px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-extrabold text-[#11120d]">{product.name}</div>
                  <div className="mt-1 truncate text-[11px] font-semibold text-[#6B7280]">SKU: {product.sku || "-"}</div>
                </div>
                <div className="shrink-0 text-right text-[12px] font-bold text-[#565449]">
                  {product.retailPrice === null ? "Retail pending" : `NPR ${product.retailPrice}`}
                </div>
                <button
                  type="button"
                  onClick={() => toggleOne(product.id, false)}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[11px] text-[#BE123C] transition hover:bg-[#FFF1F2]"
                  aria-label={`Remove ${product.name} from selection`}
                >
                  <Icon name="close" className="text-[20px]" />
                </button>
              </div>
            ))}
          </div>
        )}
      </ModalFrame>

      <ModalFrame
        open={Boolean(pendingProductFilterChange)}
        title="Change filters and clear this selection?"
        description="Filter-wide selection is tied to the current result set."
        onClose={cancelProductFilterChange}
        maxWidthClass="max-w-[500px]"
        mobileBottomSheet
        footer={(
          <div className="flex w-full items-center justify-end gap-3">
            <DialogButton onClick={cancelProductFilterChange}>Keep selection</DialogButton>
            <DialogButton variant="primary" icon="filter_alt" onClick={confirmProductFilterChange}>
              Apply and clear
            </DialogButton>
          </div>
        )}
      >
        <div className="rounded-[14px] border border-amber-200 bg-amber-50 p-4 text-[13px] font-semibold leading-6 text-amber-950">
          You currently have {selectedCount.toLocaleString()} matching products selected
          {filteredExcludedIds.length > 0 ? ` with ${filteredExcludedIds.length.toLocaleString()} exclusion${filteredExcludedIds.length === 1 ? "" : "s"}` : ""}.
          Applying {describeProductFilterChange(pendingProductFilterChange)} will clear that selection so its meaning cannot change silently.
        </div>
      </ModalFrame>

      <ProductSearchInsightsModal
        open={openSearchInsights}
        onClose={() => setOpenSearchInsights(false)}
      />

      {/* centralizing modal state here keeps add/edit/view/import/delete flows coordinated from one page component */}
      <ProductsModals
        stockTracked={stockTracked}
        brands={brands}
        categories={categories}
        supplierOptions={stockSupplierOptions}
        businessDefaults={businessDefaults}
        openAddEdit={openAddEdit}
        setOpenAddEdit={(open) => {
          if (open) setOpenAddEdit(true);
          else requestCloseProductEditor();
        }}
        openImport={openImport}
        setOpenImport={setOpenImport}
        openView={openView}
        setOpenView={setOpenView}
        openConfirmDelete={openConfirmDelete}
        setOpenConfirmDelete={setOpenConfirmDelete}
        activeProduct={activeProduct}
        activeProductId={activeProductId}
        form={form}
        setForm={setForm}
        formErrors={formErrors}
        productImagePreview={productImagePreview}
        productImageName={productImageFile?.name || ""}
        productSearchTerms={productSearchTerms}
        setProductSearchTerms={setProductSearchTerms}
        productSearchTermsLoading={productSearchTermsLoading}
        purchaseCostVisible={purchaseCostVisible}
        onProductImageChange={handleProductImageChange}
        onClearProductImage={() => handleProductImageChange(null)}
        onSave={saveProduct}
        productSaveBusy={productSaveBusy}
        onValidateProductStep={validateProductStep}
        onClearFormError={(field) => setFormErrors((current) => ({ ...current, [field]: undefined }))}
        onConfirmDelete={confirmDeleteOne}
        isAdmin={isAdmin}
        deleteSafety={deleteSafety}
        deleteSafetyLoading={deleteSafetyLoading}
        deleteBusy={deleteBusy}
        onConfirmPermanentDelete={confirmPermanentDeleteOne}
        onDiscardStockAndDelete={confirmDiscardStockAndDeleteOne}
        bulkAction={bulkAction}
        bulkProducts={selectedProducts}
        onCloseBulkAction={() => setBulkAction(null)}
        onRemoveBulkProduct={(productId) => {
          toggleOne(productId, false);
          if (selectedIds.length === 1) setBulkAction(null);
        }}
        onConfirmBulkAction={confirmBulkAction}
        onEditActiveProduct={openEditFromView}
        importFile={importFile}
        setImportFile={(file) => {
          setImportFile(file);
          setImportError("");
          setImportResult(null);
          setPdfReviewBatch(null);
          setLastImportedProducts([]);
          setLastImportSupplier("");
        }}
        importBusy={importBusy}
        importProcessingKind={importProcessingKind}
        importError={importError}
        importResult={importResult}
        pdfReviewBatch={pdfReviewBatch}
        importBatches={importBatches}
        importDocuments={importDocuments}
        importDocumentsLoading={importDocumentsLoading}
        importDocumentBusyId={importDocumentBusyId}
        importTemplates={importTemplates}
        importTemplateId={importTemplateId}
        setImportTemplateId={(templateId) => {
          setImportTemplateId(templateId);
          const template = importTemplates.find((item) => item.id === templateId);
          if (!template) return;
          setImportSupplier(template.supplier);
          const nextMap = { ...importFieldMap };
          Object.entries(template.fieldMap || {}).forEach(([key, value]) => {
            nextMap[key] = Array.isArray(value) ? String(value[0] || "") : String(value || "");
          });
          setImportFieldMap(nextMap);
        }}
        importSupplier={importSupplier}
        setImportSupplier={setImportSupplier}
        importFieldMap={importFieldMap}
        setImportFieldMap={setImportFieldMap}
        onSaveImportTemplate={async () => {
          if (!importSupplier.trim()) {
            return;
          }
          try {
            await saveProductImportTemplateApi({
              id: importTemplateId || undefined,
              supplier: importSupplier.trim(),
              sourceType: "CSV",
              fieldMap: Object.fromEntries(
                Object.entries(importFieldMap).filter(([, value]) => value.trim()),
              ),
              defaults: {
                supplier: importSupplier.trim(),
                stock: 0,
                retailMarginPercent: 18,
              },
            });
            await loadImportTemplates();
            toastMsg("success", "Import template saved.");
          } catch (error: any) {
            toastMsg("danger", error?.response?.data?.error || error?.message || "Failed to save template.");
          }
        }}
        onDeleteImportTemplate={async (templateId) => {
          try {
            await deleteProductImportTemplateApi(templateId);
            if (importTemplateId === templateId) setImportTemplateId("");
            await loadImportTemplates();
            toastMsg("success", "Import template deleted.");
          } catch (error: any) {
            toastMsg("danger", error?.response?.data?.error || error?.message || "Failed to delete template.");
          }
        }}
        pdfReviewBusy={pdfReviewBusy}
        onSaveReviewedPdfRows={handleSaveReviewedPdfRows}
        onImportReviewedPdfRows={handleImportReviewedPdfRows}
        onBackToImportList={() => {
          setPdfReviewBatch(null);
          setImportError("");
          void loadImportBatches();
        }}
        onOpenImportBatch={openImportBatchById}
        onDeleteImportBatch={async (batchId) => {
          try {
            setImportBusy(true);
            setImportError("");
            const result = await deleteProductImportBatchApi(batchId);
            if (pdfReviewBatch?.id === batchId) {
              setPdfReviewBatch(null);
            }
            if (activeImportBatchId === batchId) {
              setActiveImportBatchId(null);
              sessionStorage.removeItem("active_product_import_batch_id");
              window.dispatchEvent(
                new CustomEvent("active_product_import_changed", {
                  detail: { batchId: null },
                })
              );
            }
            await loadImportBatches();
            toastMsg("success", result.message || "Import review deleted.");
          } catch (error: any) {
            const message =
              error?.response?.data?.error ||
              error?.message ||
              "Failed to delete import review.";
            setImportError(message);
          } finally {
            setImportBusy(false);
          }
        }}
        onOpenImportDocument={(document) => void handleImportDocument(document)}
        onRefreshImportDocuments={() => void loadImportDocuments()}
        lastImportedProducts={lastImportedProducts}
        lastImportSupplier={lastImportSupplier}
        onReceiveImportedProducts={openStockManagerForImportedProducts}
        onCloseImport={() => {
          if (importProcessingKind && !activeImportBatchId) {
            cancelImportProcessing();
            return;
          }
          setOpenImport(false);
          if (!activeImportBatchId) {
            resetImportState();
          }
        }}
        onCancelImportProcessing={cancelImportProcessing}
        onUploadCsvClick={handleImportCsv}
        activeImportBatchId={activeImportBatchId}
        onCompleteImportBatch={handleImportBatchCompleted}
        onMinimizeImport={() => setOpenImport(false)}
        onOpenImportModal={() => setOpenImport(true)}
      />

      <ModalFrame
        open={confirmDiscardProductEditor}
        title="Discard product changes?"
        description="Your unsaved product information will be lost."
        onClose={() => setConfirmDiscardProductEditor(false)}
        layer="critical"
        maxWidthClass="max-w-[480px]"
        mobileBottomSheet
        footer={(
          <div className="flex w-full items-center justify-end gap-3">
            <DialogButton onClick={() => setConfirmDiscardProductEditor(false)}>
              Keep editing
            </DialogButton>
            <DialogButton variant="danger" icon="delete" onClick={closeProductEditorAndReturn}>
              Discard changes
            </DialogButton>
          </div>
        )}
      >
        <div className="flex items-start gap-4 rounded-[16px] border border-amber-200 bg-amber-50 p-4 text-amber-900">
          <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] bg-amber-100">
            <Icon name="edit_note" className="text-[24px]" />
          </span>
          <p className="text-[13px] font-semibold leading-6">
            Choose Keep editing to return to the form, or discard only if you no longer need these changes.
          </p>
        </div>
      </ModalFrame>

      <ModalFrame
        open={Boolean(productSaveSuccess)}
        title="Product created"
        description={stockTracked ? "The product is ready in your catalog and stock records." : "The product is ready in your catalog. Stock will be counted when inventory mode is enabled."}
        onClose={() => setProductSaveSuccess(null)}
        maxWidthClass="max-w-[540px]"
        mobileBottomSheet
        footer={productSaveSuccess ? (
          <div className="grid w-full grid-cols-2 gap-3">
            <DialogButton
              icon="add"
              onClick={() => {
                setProductSaveSuccess(null);
                openAdd();
              }}
            >
              Add another
            </DialogButton>
            <DialogButton
              variant="primary"
              icon="visibility"
              onClick={() => {
                const product = productSaveSuccess.product;
                setProductSaveSuccess(null);
                openViewProduct(product);
              }}
            >
              View product
            </DialogButton>
          </div>
        ) : null}
      >
        {productSaveSuccess ? (
          <div className="space-y-4">
            <div className="flex items-start gap-4">
              <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-[18px] border border-emerald-200 bg-emerald-50 text-emerald-600">
                <Icon name="check_circle" className="text-[30px]" />
              </span>
              <div className="min-w-0 pt-1">
                <div className="truncate text-[17px] font-extrabold text-[#11120d]">
                  {productSaveSuccess.product.name}
                </div>
                {stockTracked ? <div className="mt-1 text-[13px] font-semibold text-[#565449]">
                  Initial stock: {productSaveSuccess.product.stock} {productSaveSuccess.product.saleUnit || "PIECE"}
                </div> : <div className="mt-1 text-[13px] font-semibold text-[#565449]">Catalog item · stock not tracked</div>}
              </div>
            </div>
            <dl className="grid grid-cols-1 gap-2 rounded-[14px] border border-[#E5E7EB] bg-[#F8FAFC] p-4 text-[13px] sm:grid-cols-2">
              <div><dt className="font-bold text-[#8C8889]">SKU</dt><dd className="mt-1 break-all font-extrabold tabular-nums text-[#11120d]">{productSaveSuccess.product.sku}</dd></div>
              <div><dt className="font-bold text-[#8C8889]">Barcode</dt><dd className="mt-1 break-all font-extrabold tabular-nums text-[#11120d]">{productSaveSuccess.product.barcode || "Not assigned"}</dd></div>
            </dl>
            {productSaveSuccess.imageUploadError ? (
              <div className="rounded-[14px] border border-amber-200 bg-amber-50 p-3 text-[12px] font-semibold leading-5 text-amber-900" role="status">
                The product was created, but its image could not be uploaded. Open the product to retry the image later. {productSaveSuccess.imageUploadError}
              </div>
            ) : null}
          </div>
        ) : null}
      </ModalFrame>

      <ModalFrame
        open={openStockManager}
        title="Stock Movement"
        description={
          openStockQuickAdd
            ? "Create a product as a step inside stock receive, then return to the receive list."
            : "Receive supplier stock or correct counted stock. Start empty, search existing products, or create new products while receiving."
        }
        onClose={closeStockManager}
        maxWidthClass="max-w-[920px]"
        mobileFullScreen
      >
        <div className="space-y-[14px]">
          {!openStockQuickAdd ? (
            <div className="rounded-[14px] border border-[#E5E7EB] bg-white p-3 lg:hidden">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[16px] font-extrabold text-[#11120d]">Step {mobileStockStep} of 3</div>
                  <div className="mt-0.5 text-[13px] font-semibold text-[#8C8889]">{mobileStockStep === 1 ? "Movement setup" : mobileStockStep === 2 ? "Add products" : "Review movement"}</div>
                </div>
                <div className="flex items-center gap-1.5">
                  {[1, 2, 3].map((step) => <span key={step} className={`h-2.5 rounded-full transition-all ${step === mobileStockStep ? "w-7 bg-[#11120d]" : step < mobileStockStep ? "w-2.5 bg-[#179B4D]" : "w-2.5 bg-[#D1D5DB]"}`} />)}
                </div>
              </div>
              {mobileStockStep > 1 ? (
                <button type="button" onClick={() => setMobileStockStep((mobileStockStep - 1) as 1 | 2)} className="mt-3 inline-flex h-10 items-center gap-2 rounded-[10px] border border-[#CFCFD3] px-3 text-[12px] font-bold text-[#565449]"><Icon name="arrow_back" className="text-[18px]" />Back</button>
              ) : null}
            </div>
          ) : null}
          {openStockQuickAdd ? (
            <div className="space-y-[12px]">
              <button
                type="button"
                onClick={returnToStockMovementList}
                disabled={quickStockBusy}
                className="inline-flex h-[36px] items-center gap-2 rounded-[10px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6] disabled:pointer-events-none disabled:opacity-50"
              >
                <Icon name="arrow_back" className="text-[17px]" />
                Back
              </button>

              <div className="grid grid-cols-1 gap-[14px] lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="rounded-[14px] border border-[#E5E7EB] bg-white p-[16px] shadow-sm">
                <div className="mb-[16px]">
                  <div>
                    <div className="text-[12px] font-extrabold uppercase tracking-wider text-[#3B82F6]">
                      Stock receive / Create product
                    </div>
                    <div className="mt-[4px] text-[18px] font-extrabold text-[#11120d]">
                      Add catalog item
                    </div>
                    <div className="mt-[4px] max-w-[560px] text-[13px] font-semibold text-[#565449]">
                      Save the product here, then receive its quantity from the stock movement list.
                    </div>
                  </div>
                </div>

                <div className="rounded-[12px] border border-[#E5E7EB] bg-[#F8FAFC] p-[16px]">
                  {renderQuickStockProductForm()}
                </div>
              </div>

              <aside className="rounded-[14px] border border-[#E5E7EB] bg-white p-[16px] shadow-sm">
                <div className="flex items-center justify-between gap-3 border-b border-[#E5E7EB] pb-[12px]">
                  <div>
                    <div className="text-[12px] font-extrabold uppercase text-[#8C8889]">
                      Receive list
                    </div>
                    <div className="mt-[2px] text-[16px] font-extrabold text-[#11120d]">
                      {stockManagerProducts.length} item{stockManagerProducts.length === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="rounded-[8px] bg-[#EFF6FF] px-3 py-1.5 text-[12px] font-bold text-[#2563EB]">
                    {stockMode === "receive" ? "Receive" : "Correct"}
                  </div>
                </div>

                <div className="mt-[16px] max-h-[320px] space-y-[8px] overflow-y-auto">
                  {stockManagerProducts.slice(0, 8).map((product) => (
                    <div
                      key={product.id}
                      className="rounded-[10px] border border-[#E5E7EB] bg-[#F8FAFC] px-3 py-2"
                    >
                      <div className="truncate text-[13px] font-bold text-[#11120d]">
                        {product.name}
                      </div>
                      <div className="mt-[2px] text-[11px] font-semibold text-[#565449]">
                        Qty {Math.abs(Number(stockRows[product.id] || 0))} | Current {product.stock} {product.saleUnit || "pcs"}
                      </div>
                    </div>
                  ))}
                  {stockManagerProducts.length === 0 ? (
                    <div className="rounded-[10px] border-2 border-dashed border-[#E5E7EB] px-3 py-8 text-center text-[12px] font-semibold text-[#8C8889]">
                      Products you save will appear here.
                    </div>
                  ) : null}
                  {stockManagerProducts.length > 8 ? (
                    <div className="text-center text-[11px] font-bold text-[#3B82F6]">
                      +{stockManagerProducts.length - 8} more item(s)
                    </div>
                  ) : null}
                </div>

                <button
                  type="button"
                  onClick={returnToStockMovementList}
                  disabled={quickStockBusy}
                  className="mt-[16px] flex h-[40px] w-full items-center justify-center gap-2 rounded-[10px] bg-[#11120d] px-3 text-[13px] font-bold text-white transition hover:bg-[#2a2c27] disabled:pointer-events-none disabled:opacity-50"
                >
                  <Icon name="list_alt" className="text-[18px]" />
                  View Receive List
                </button>
              </aside>
              </div>
            </div>
          ) : (
            <>
          <div className={`${mobileStockStep !== 1 ? "hidden" : "grid"} grid-cols-2 gap-3 lg:hidden`}>
            {([
              { mode: "receive" as const, icon: "inventory_2", title: "Receive Stock", detail: "Add stock received from your supplier" },
              { mode: "correct" as const, icon: "edit_square", title: "Correct Stock", detail: "Adjust quantity to correct inventory" },
            ]).map((option) => {
              const selected = stockMode === option.mode;
              return (
                <button
                  key={option.mode}
                  type="button"
                  onClick={() => {
                    setStockMode(option.mode);
                    if (option.mode === "receive") {
                      setStockDirection("add");
                    } else {
                      setStockBillFiles([]);
                      setStockSelectedBillIds([]);
                      setStockShowDocumentPicker(false);
                    }
                    setStockLineError("");
                  }}
                  className={`relative min-h-[132px] rounded-[14px] border p-3 text-left transition ${selected ? "border-[#179B4D] bg-[#F3FBF6]" : "border-[#E5E7EB] bg-white"}`}
                >
                  {selected ? <span className="absolute right-2.5 top-2.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#179B4D] text-white"><Icon name="check" className="text-[14px]" /></span> : null}
                  <span className={`inline-flex h-9 w-9 items-center justify-center rounded-[10px] ${selected ? "bg-[#EAF8EF] text-[#179B4D]" : "bg-[#F3F4F6] text-[#6B7280]"}`}><Icon name={option.icon} className="text-[20px]" /></span>
                  <span className="mt-3 block text-[14px] font-extrabold text-[#11120d]">{option.title}</span>
                  <span className="mt-1.5 block text-[11px] font-semibold leading-4 text-[#6B7280]">{option.detail}</span>
                </button>
              );
            })}
          </div>

          {/* Top Controls: Mode & Reason */}
          <div className={`${mobileStockStep !== 1 ? "hidden lg:flex" : "flex"} flex-col gap-[12px] rounded-[12px] border border-[#E5E7EB] bg-[#F8FAFC] p-[12px] md:flex-row md:items-center md:justify-between`}>
            <div className="flex flex-col gap-[12px] md:flex-row md:items-center">
              {/* Segmented Toggle for Mode */}
              <div className="hidden h-[38px] rounded-[10px] bg-[#E5E7EB] p-[3px] lg:flex">
                <button
                  type="button"
                  onClick={() => {
                    setStockMode("receive");
                    setStockDirection("add");
                  }}
                  className={`flex items-center justify-center rounded-[8px] px-[16px] text-[13px] font-bold transition-colors ${
                    stockMode === "receive" ? "bg-white text-[#11120d] shadow-sm" : "text-[#565449] hover:text-[#11120d]"
                  }`}
                >
                  Receive Stock
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setStockMode("correct");
                    setStockBillFiles([]);
                    setStockSelectedBillIds([]);
                    setStockShowDocumentPicker(false);
                  }}
                  className={`flex items-center justify-center rounded-[8px] px-[16px] text-[13px] font-bold transition-colors ${
                    stockMode === "correct" ? "bg-white text-[#11120d] shadow-sm" : "text-[#565449] hover:text-[#11120d]"
                  }`}
                >
                  Correct Stock
                </button>
              </div>

              {/* Add/Remove Sub-toggle for Correct Mode */}
              {stockMode === "correct" && (
                <div className="flex h-[38px] rounded-[10px] border border-[#CFCFD3] bg-white p-[3px]">
                  {(["add", "remove"] as const).map((direction) => (
                    <button
                      key={direction}
                      type="button"
                      onClick={() => setStockDirection(direction)}
                      className={`flex items-center justify-center rounded-[8px] px-[16px] text-[12px] font-bold transition-colors ${
                        stockDirection === direction ? "bg-[#11120d] text-white" : "text-[#565449] hover:bg-[#F3F4F6]"
                      }`}
                    >
                      {direction === "add" ? "+ Add" : "- Remove"}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="w-full md:w-[320px]">
              <input
                id="stock-reason"
                value={stockReason}
                aria-label="Reason or stock note"
                aria-invalid={Boolean(stockFieldErrors.reason)}
                aria-describedby={stockFieldErrors.reason ? "stock-reason-error" : undefined}
                onChange={(event) => {
                  setStockReason(event.target.value);
                  setStockLineError("");
                  setStockFieldErrors((current) => ({ ...current, reason: undefined }));
                }}
                placeholder="Reason or stock note (required)"
                className={`h-11 w-full rounded-[9px] px-[12px] text-[13px] font-semibold text-[#11120d] outline-none placeholder-[#8C8889] focus:ring-2 ${stockFieldErrors.reason ? "border-2 border-[#DC2626] bg-[#FFF1F2] focus:ring-red-100" : "border border-[#CFCFD3] bg-white focus:border-[#3B82F6] focus:ring-blue-100"}`}
              />
              {stockFieldErrors.reason ? <div id="stock-reason-error" className="mt-1 text-[11px] font-bold text-[#BE123C]" role="alert">{stockFieldErrors.reason}</div> : null}
            </div>
          </div>

          {mobileStockStep === 1 && stockLineError ? (
            <div className="rounded-[10px] border border-[#FCA5A5] bg-[#FEF2F2] p-3 text-[12px] font-bold text-[#DC2626] lg:hidden">{stockLineError}</div>
          ) : null}

          {mobileStockStep === 1 && stockManagerProducts.length > 0 ? (
            <section className="overflow-hidden rounded-[14px] border border-[#CFCFD3] bg-white shadow-sm lg:hidden" aria-labelledby="stock-selected-summary-title">
              <div className="flex items-center justify-between gap-3 border-b border-[#E5E7EB] bg-[#F8FAFC] px-3 py-3">
                <div>
                  <h3 id="stock-selected-summary-title" className="text-[14px] font-extrabold text-[#11120d]">
                    Selected products
                  </h3>
                  <p className="mt-0.5 text-[11px] font-semibold text-[#6B7280]">
                    {stockManagerProducts.length} product{stockManagerProducts.length === 1 ? "" : "s"} carried into this movement
                  </p>
                </div>
                <button type="button" onClick={() => setMobileStockStep(2)} className="inline-flex min-h-11 items-center gap-1 rounded-[10px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-bold text-[#11120d]">
                  Edit list <Icon name="arrow_forward" className="text-[16px]" />
                </button>
              </div>
              <div className="max-h-[220px] divide-y divide-[#E5E7EB] overflow-y-auto overscroll-contain">
                {stockManagerProducts.map((product) => (
                  <div key={product.id} className="flex min-h-[64px] items-center gap-3 px-3 py-2.5">
                    <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[#F3F4F6] text-[#6B7280]"><Icon name="inventory_2" className="text-[19px]" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-extrabold text-[#11120d]">{product.name}</div>
                      <div className="mt-0.5 truncate text-[10px] font-semibold text-[#8C8889]">SKU: {product.sku || "-"} · Stock {product.stock.toLocaleString(undefined, { maximumFractionDigits: 3 })}</div>
                    </div>
                    <button type="button" onClick={() => removeProductFromStockManager(product.id)} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] text-[#BE123C] transition active:bg-[#FFF1F2]" aria-label={`Remove ${product.name} from stock movement`}><Icon name="close" className="text-[20px]" /></button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* Bill Attachment Section (Only for Receive Mode) */}
          {stockMode === "receive" && (
            <div className={`${mobileStockStep !== 1 ? "hidden lg:block" : "block"} rounded-[12px] border border-[#E5E7EB] bg-white p-[12px] shadow-sm`}>
              <div className="mb-[12px] flex flex-wrap items-center justify-between gap-[10px]">
                <div>
                  <div className="text-[14px] font-extrabold text-[#11120d] flex items-center gap-[8px]">
                    <Icon name="receipt" sizePx={18} className="text-[#3B82F6]" />
                    Supplier Bill Details
                  </div>
                  <div className="mt-[2px] text-[12px] font-semibold text-[#565449]">
                    Attach a bill or enter bill details for this receive.
                  </div>
                </div>
                <div className="flex gap-[8px]">
                  <button
                    type="button"
                    onClick={() => setStockShowDocumentPicker((current) => !current)}
                    className={`flex items-center gap-[6px] rounded-[8px] px-[12px] py-[6px] text-[12px] font-bold transition ${stockShowDocumentPicker ? "bg-[#EFF6FF] text-[#2563EB]" : "bg-[#F3F4F6] text-[#565449] hover:bg-[#E5E7EB]"}`}
                  >
                    <Icon name="folder_open" sizePx={16} />
                    {stockShowDocumentPicker ? "Hide Files" : "Browse Files"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setStockShowBillDetails((current) => !current)}
                    className={`flex items-center gap-[6px] rounded-[8px] px-[12px] py-[6px] text-[12px] font-bold transition ${stockShowBillDetails ? "bg-[#EFF6FF] text-[#2563EB]" : "bg-[#F3F4F6] text-[#565449] hover:bg-[#E5E7EB]"}`}
                  >
                    <Icon name="list_alt" sizePx={16} />
                    {stockShowBillDetails ? "Hide Details" : "Enter Details"}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 items-end gap-[10px] md:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-[6px]">
                  <label className="text-[12px] font-bold text-[#565449]">Supplier</label>
                  <ProjectSelect
                    id="stock-supplier-select"
                    aria-label="Supplier"
                    aria-invalid={Boolean(stockFieldErrors.supplier)}
                    aria-describedby={stockFieldErrors.supplier && stockSupplierMode !== "new" ? "stock-supplier-error" : undefined}
                    value={stockSupplierMode === "new" ? "__new" : stockSupplierName}
                    onChange={(e) => {
                      if (e.target.value === "__new") {
                        setStockSupplierMode("new");
                        setStockSupplierName("");
                      } else {
                        setStockSupplierMode("existing");
                        setStockSupplierName(e.target.value);
                      }
                      setStockLineError("");
                      setStockFieldErrors((current) => ({ ...current, supplier: undefined }));
                    }}
                    className="h-[40px] w-full rounded-[8px] border border-[#CFCFD3] bg-[#F8FAFC] px-[12px] text-[13px] font-bold text-[#11120d] outline-none focus:border-[#3B82F6]"
                  >
                    <option value="">Select supplier</option>
                    {stockSupplierOptions.map((supplier) => (
                      <option key={supplier} value={supplier}>{supplier}</option>
                    ))}
                    <option value="__new">+ Add new supplier</option>
                  </ProjectSelect>
                  {stockFieldErrors.supplier && stockSupplierMode !== "new" ? <div id="stock-supplier-error" className="text-[11px] font-bold text-[#BE123C]" role="alert">{stockFieldErrors.supplier}</div> : null}
                </div>

                {stockSupplierMode === "new" && (
                  <div className="space-y-[6px]">
                    <label className="text-[12px] font-bold text-[#565449]">New Supplier Name</label>
                    <input
                      id="stock-supplier-input"
                      value={stockSupplierName}
                      aria-invalid={Boolean(stockFieldErrors.supplier)}
                      aria-describedby={stockFieldErrors.supplier ? "stock-supplier-input-error" : undefined}
                      onChange={(e) => {
                        setStockSupplierName(e.target.value);
                        setStockLineError("");
                        setStockFieldErrors((current) => ({ ...current, supplier: undefined }));
                      }}
                      placeholder="e.g. Acme Corp"
                      className={`h-11 w-full rounded-[8px] px-[12px] text-[13px] font-semibold text-[#11120d] outline-none focus:ring-2 ${stockFieldErrors.supplier ? "border-2 border-[#DC2626] bg-[#FFF1F2] focus:ring-red-100" : "border border-[#CFCFD3] bg-white focus:border-[#3B82F6] focus:ring-blue-100"}`}
                    />
                    {stockFieldErrors.supplier ? <div id="stock-supplier-input-error" className="text-[11px] font-bold text-[#BE123C]" role="alert">{stockFieldErrors.supplier}</div> : null}
                  </div>
                )}

                <div className="space-y-[6px]">
                  <label className="text-[12px] font-bold text-[#565449]">Upload Bill</label>
                  <input
                    key={stockSelectedBillIds.join(",") || "fresh-stock-bill"}
                    type="file"
                    multiple
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    onChange={(e) => {
                      if (e.target.files) {
                        setStockBillFiles(Array.from(e.target.files));
                        setStockSelectedBillIds([]);
                      }
                    }}
                    className="block w-full text-[12px] text-[#565449] file:mr-3 file:rounded-[8px] file:border-0 file:bg-[#EFF6FF] file:px-[12px] file:py-[6px] file:text-[12px] file:font-bold file:text-[#2563EB] hover:file:bg-[#DBEAFE] cursor-pointer h-[40px]"
                  />
                  {stockBillFiles.length > 0 && (
                    <div className="text-[11px] font-bold text-[#2563EB]">{stockBillFiles.length} file(s) selected</div>
                  )}
                </div>
              </div>

              {/* Accordion content */}
              <div className="space-y-[16px] mt-[16px]">
                {stockShowDocumentPicker && (
                  <div className="rounded-[12px] border border-[#E5E7EB] bg-[#F8FAFC] p-[16px]">
                    {/* (Document picker content kept roughly same, styled nicely) */}
                    <div className="mb-[12px] flex items-center justify-between">
                      <div className="text-[12px] font-bold text-[#565449]">Unprocessed Documents</div>
                      <button type="button" onClick={() => void loadStockBillDocuments()} className="text-[12px] font-bold text-[#3B82F6] hover:underline">Refresh</button>
                    </div>
                    {stockBillsLoading ? (
                      <div className="text-[12px] font-medium text-[#8C8889]">Loading...</div>
                    ) : stockBillDocuments.length === 0 ? (
                      <div className="text-[12px] font-medium text-[#8C8889] italic">No unprocessed bills found.</div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-[12px]">
                        {stockBillDocuments.map((document) => {
                          const selectedBill = stockSelectedBillIds.includes(document.id);
                          return (
                            <div
                              key={document.id}
                              onClick={() => {
                                setStockSelectedBillIds(selectedBill ? [] : [document.id]);
                                setStockBillFiles([]);
                                if (!selectedBill) {
                                  if (document.supplierName) {
                                    setStockSupplierMode("existing");
                                    setStockSupplierName(document.supplierName);
                                  }
                                  setStockBillNumber(document.billNumber || "");
                                  setStockBillDate(document.billDate ? document.billDate.slice(0, 10) : todayInputDate());
                                  setStockBillAmount(document.billAmount == null ? "" : String(document.billAmount));
                                }
                                setStockLineError("");
                              }}
                              className={`flex cursor-pointer items-start gap-[12px] rounded-[10px] border p-[12px] transition ${selectedBill ? "border-[#3B82F6] bg-[#EFF6FF]" : "border-[#E5E7EB] bg-white hover:border-[#3B82F6]"}`}
                            >
                              <Icon name={document.mimeType === "application/pdf" ? "picture_as_pdf" : "image"} sizePx={24} className={selectedBill ? "text-[#3B82F6]" : "text-[#8C8889]"} />
                              <div className="flex-1 min-w-0">
                                <div className="truncate text-[13px] font-bold text-[#11120d]">{document.title?.trim() || document.fileName}</div>
                                <div className="text-[11px] font-medium text-[#565449] mt-[2px]">{document.supplierName || "No supplier"} | {formatDocumentDate(document.billDate)}</div>
                              </div>
                              {selectedBill && <Icon name="check_circle" sizePx={20} className="text-[#3B82F6]" />}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {stockShowBillDetails && (
                  <div className="grid grid-cols-1 gap-[12px] md:grid-cols-4 rounded-[12px] border border-[#E5E7EB] bg-[#F8FAFC] p-[16px]">
                    <div className="space-y-[6px]">
                      <label className="text-[12px] font-bold text-[#565449]">Bill Number</label>
                      <input value={stockBillNumber} onChange={(e) => setStockBillNumber(e.target.value)} placeholder="INV-1024" className="h-[40px] w-full rounded-[8px] border border-[#CFCFD3] bg-white px-[12px] text-[13px] font-semibold outline-none focus:border-[#3B82F6]" />
                    </div>
                    <div className="space-y-[6px]">
                      <label className="text-[12px] font-bold text-[#565449]">Bill Date</label>
                      <ProjectDateInput value={stockBillDate} onChange={(e) => setStockBillDate(e.target.value)} className="h-[40px] rounded-[8px] text-[13px] font-semibold focus-visible:border-[#3B82F6]" />
                    </div>
                    <div className="space-y-[6px]">
                      <label className="text-[12px] font-bold text-[#565449]">Bill Amount</label>
                      <input type="number" min="0" step="0.01" value={stockBillAmount} onChange={(e) => setStockBillAmount(e.target.value)} placeholder="0.00" className="h-[40px] w-full rounded-[8px] border border-[#CFCFD3] bg-white px-[12px] text-[13px] font-semibold outline-none focus:border-[#3B82F6]" />
                    </div>
                    <div className="space-y-[6px] md:col-span-4">
                      <label className="text-[12px] font-bold text-[#565449]">Remarks</label>
                      <textarea value={stockBillRemarks} onChange={(e) => setStockBillRemarks(e.target.value)} placeholder="Any notes regarding this bill..." rows={2} className="w-full rounded-[8px] border border-[#CFCFD3] bg-white p-[12px] text-[13px] font-semibold outline-none focus:border-[#3B82F6] min-h-[60px]" />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Product Selection and Table */}
          <div className={`${mobileStockStep === 1 ? "hidden lg:block" : "block"} space-y-[12px] rounded-[12px] border border-[#E5E7EB] bg-white p-[12px] shadow-sm`}>
            <div className={`${mobileStockStep === 3 ? "hidden lg:flex" : "flex"} flex-col justify-between gap-[10px] md:flex-row md:items-center`}>
              <div className="relative flex-1 md:max-w-[360px]">
                <div className="flex h-[38px] items-center gap-[8px] rounded-[9px] border border-[#CFCFD3] bg-[#F8FAFC] px-[12px] transition focus-within:border-[#3B82F6] focus-within:ring-1 focus-within:ring-[#3B82F6]">
                  <Icon name="search" sizePx={20} className="text-[#8C8889]" />
                  <input
                    value={stockProductQuery}
                    onChange={(event) => {
                      setStockProductQuery(event.target.value);
                      setStockLineError("");
                    }}
                    placeholder="Search product by name, SKU..."
                    className="w-full bg-transparent text-[13px] font-semibold text-[#11120d] outline-none placeholder-[#8C8889]"
                  />
                  {stockLookupBusy && <span className="text-[11px] font-bold text-[#3B82F6]">Searching...</span>}
                </div>

                {stockProductQuery.trim().length >= 2 && (
                  <div className="absolute left-0 right-0 top-full z-20 mt-[4px] max-h-[300px] overflow-y-auto rounded-[12px] border border-[#E5E7EB] bg-white shadow-xl">
                    {stockLookupResults.map((product) => (
                      <button
                        key={product.id}
                        type="button"
                        onClick={() => addProductToStockManager(product)}
                        className="flex w-full cursor-pointer items-center justify-between gap-[12px] border-b border-[#E5E7EB] px-[16px] py-[12px] text-left transition-colors hover:bg-[#ECEFF3] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#2563EB] last:border-0"
                      >
                        <div>
                          <div className="text-[13px] font-bold text-[#11120d]">{product.name}</div>
                          <div className="text-[11px] font-medium text-[#565449] mt-[2px]">SKU {product.sku || "-"} | Stock: {product.stock}</div>
                        </div>
                        <span className="rounded-[6px] bg-[#EFF6FF] px-[10px] py-[4px] text-[11px] font-bold text-[#2563EB]">Add</span>
                      </button>
                    ))}
                    {!stockLookupBusy && stockLookupResults.length === 0 && (
                      <div className="p-[16px] text-center">
                        <div className="text-[12px] font-bold text-[#565449]">No matches found.</div>
                        {stockMode === "receive" && (
                          <button
                            type="button"
                            onClick={openQuickStockAdd}
                            className="mt-[8px] rounded-[8px] bg-[#11120d] px-[12px] py-[6px] text-[12px] font-bold text-white hover:bg-[#2a2c27] transition"
                          >
                            + Create Product
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-[8px]">
                <div className="text-[12px] font-bold text-[#565449]">Apply qty to all:</div>
                <input
                  type="number"
                  min={0}
                  value={stockApplyQty}
                  onChange={(event) => setStockApplyQty(Number(event.target.value))}
                  className="h-[34px] w-[76px] rounded-[8px] border border-[#CFCFD3] bg-[#F8FAFC] px-[10px] text-right text-[13px] font-bold outline-none focus:border-[#3B82F6]"
                />
                <button
                  type="button"
                  onClick={applyStockQtyToAllSelected}
                  disabled={stockManagerProducts.length === 0}
                  className="h-[34px] rounded-[8px] bg-[#E5E7EB] px-[12px] text-[12px] font-bold text-[#11120d] transition hover:bg-[#D1D5DB] disabled:opacity-50"
                >
                  Apply
                </button>
              </div>
            </div>

            {stockLineError && (
              <div className="rounded-[8px] bg-[#FEF2F2] p-[10px] text-[12px] font-bold text-[#DC2626] border border-[#FCA5A5]">
                {stockLineError}
              </div>
            )}

            <div className="space-y-3 lg:hidden">
              {mobileStockStep === 3 ? (
                <div className="rounded-[12px] border border-[#BFDBFE] bg-[#EFF6FF] p-3 text-[13px] font-semibold text-[#1D4ED8]">
                  Review each quantity and resulting stock before confirming this {stockMode === "receive" ? "receive" : "correction"}.
                </div>
              ) : null}
              {stockManagerProducts.map((product) => {
                const qty = Math.abs(Number(stockRows[product.id] || 0));
                const delta = stockMode === "receive" || stockDirection === "add" ? qty : -qty;
                const nextStock = product.stock + delta;
                return (
                  <article key={product.id} className={`rounded-[14px] border bg-white p-3 ${nextStock < 0 ? "border-[#FCA5A5]" : "border-[#E5E7EB]"}`}>
                    <div className="flex items-start gap-3">
                      <div className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-[11px] bg-[#F3F4F6] text-[#8C8889]"><Icon name="inventory_2" /></div>
                      <div className="min-w-0 flex-1"><div className="truncate text-[15px] font-extrabold text-[#11120d]">{product.name}</div><div className="mt-1 truncate text-[11px] font-semibold text-[#8C8889]">SKU: {product.sku || "-"}</div></div>
                      <button type="button" onClick={() => removeProductFromStockManager(product.id)} className="inline-flex h-10 w-10 items-center justify-center rounded-[10px] text-[#BE123C]" aria-label={`Remove ${product.name}`}><Icon name="close" /></button>
                    </div>
                    <div className="mt-3 grid grid-cols-[1fr_118px] gap-3">
                      <div className="rounded-[10px] bg-[#F8FAFC] p-2.5"><div className="text-[10px] font-bold uppercase tracking-wide text-[#8C8889]">Current stock</div><div className="mt-1 text-[16px] font-extrabold text-[#11120d]">{product.stock} {product.saleUnit || "PIECE"}</div></div>
                      <label><span className="text-[11px] font-bold text-[#565449]">Change qty</span><div className="mt-1 flex h-11 items-center overflow-hidden rounded-[10px] border border-[#CFCFD3]"><span className={`px-2 text-[17px] font-extrabold ${delta < 0 ? "text-rose-600" : "text-emerald-600"}`}>{delta < 0 ? "−" : "+"}</span><input ref={(node) => { stockQtyInputRefs.current[product.id] = node; }} type="number" min={0} value={stockRows[product.id] ?? 0} onChange={(event) => { setStockRows((current) => ({ ...current, [product.id]: Number(event.target.value) })); setStockLineError(""); }} className="h-full min-w-0 flex-1 px-2 text-right text-[15px] font-bold outline-none" /></div></label>
                    </div>
                    <div className={`mt-3 flex items-center justify-between rounded-[10px] px-3 py-2.5 ${nextStock < 0 ? "bg-[#FFF1F2] text-[#BE123C]" : "bg-[#F3F4F6] text-[#11120d]"}`}><span className="text-[12px] font-bold">Resulting stock</span><span className="text-[15px] font-extrabold">{product.stock} <Icon name="arrow_forward" className="mx-1 text-[15px] text-[#8C8889]" /> {nextStock}</span></div>
                    {nextStock < 0 ? <div className="mt-2 text-[11px] font-bold text-[#BE123C]">Resulting stock cannot be negative.</div> : null}
                  </article>
                );
              })}
              {stockManagerProducts.length === 0 ? <div className="rounded-[14px] border-2 border-dashed border-[#E5E7EB] px-4 py-10 text-center text-[13px] font-semibold text-[#8C8889]">No products added to this batch yet.</div> : null}
            </div>

            <div className="hidden overflow-hidden rounded-[12px] border border-[#E5E7EB] lg:block">
              <div className="max-h-[min(46vh,430px)] overflow-y-auto">
              <table className="w-full table-fixed text-left">
                <thead className="sticky top-0 z-10 border-b border-[#E5E7EB] bg-[#F8FAFC] shadow-sm">
                  <tr>
                    <th className="w-[44%] px-[14px] py-[9px] text-[11px] font-extrabold uppercase text-[#8C8889]">Product</th>
                    <th className="w-[22%] px-[14px] py-[9px] text-right text-[11px] font-extrabold uppercase text-[#8C8889]">Change Qty</th>
                    <th className="w-[24%] px-[14px] py-[9px] text-right text-[11px] font-extrabold uppercase text-[#8C8889]">Resulting Stock</th>
                    <th className="w-[48px] px-[10px] py-[9px]"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E5E7EB]">
                  {stockManagerProducts.map((product) => {
                    const qty = Math.abs(Number(stockRows[product.id] || 0));
                    const delta = stockMode === "receive" || stockDirection === "add" ? qty : -qty;
                    const nextStock = product.stock + delta;

                    return (
                      <tr key={product.id} className="transition-colors hover:bg-[#ECEFF3]">
                        <td className="px-[14px] py-[10px]">
                          <div className="truncate text-[13px] font-bold text-[#11120d]">{product.name}</div>
                          <div className="mt-[2px] truncate text-[11px] font-medium text-[#8C8889]">SKU: {product.sku || "-"}</div>
                        </td>
                        <td className="px-[14px] py-[10px] text-right">
                          <div className="flex items-center justify-end gap-[8px]">
                            <span className={`text-[14px] font-extrabold ${delta < 0 ? "text-rose-600" : "text-emerald-600"}`}>
                              {delta < 0 ? "-" : "+"}
                            </span>
                            <input
                              ref={(node) => { stockQtyInputRefs.current[product.id] = node; }}
                              type="number"
                              min={0}
                              value={stockRows[product.id] ?? 0}
                              onChange={(event) => {
                                setStockRows((current) => ({ ...current, [product.id]: Number(event.target.value) }));
                                setStockLineError("");
                              }}
                              className="h-[34px] w-[84px] rounded-[8px] border border-[#CFCFD3] bg-white px-[10px] text-right text-[13px] font-bold outline-none focus:border-[#3B82F6]"
                            />
                          </div>
                        </td>
                        <td className="px-[14px] py-[10px] text-right">
                          <div className="flex items-center justify-end gap-[6px] text-[13px] font-bold">
                            <span className="text-[#8C8889]">{product.stock}</span>
                            <Icon name="arrow_forward" sizePx={14} className="text-[#8C8889]" />
                            <span className={nextStock < 0 ? "text-rose-600" : "text-[#11120d]"}>{nextStock}</span>
                          </div>
                        </td>
                        <td className="px-[10px] py-[10px] text-right">
                          <button
                            type="button"
                            onClick={() => removeProductFromStockManager(product.id)}
                            className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] text-[#8C8889] transition hover:bg-[#FEF2F2] hover:text-[#DC2626]"
                            title="Remove"
                          >
                            <Icon name="close" sizePx={18} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {stockManagerProducts.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-[16px] py-[32px] text-center text-[13px] font-semibold text-[#8C8889]">
                        No products added to this batch yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              </div>
            </div>
          </div>

          <div className="sticky bottom-0 z-20 -mx-[4px] border-t border-[#E5E7EB] bg-white/95 px-[4px] pt-[12px] backdrop-blur">
            <div className="grid grid-cols-[auto_1fr] gap-2 lg:hidden">
              <button
                type="button"
                onClick={mobileStockStep === 1 ? closeStockManager : () => setMobileStockStep((mobileStockStep - 1) as 1 | 2)}
                disabled={stockBusy}
                className="h-12 rounded-[12px] border border-[#CFCFD3] bg-white px-4 text-[13px] font-extrabold text-[#565449] disabled:opacity-50"
              >
                {mobileStockStep === 1 ? "Cancel" : "Back"}
              </button>
              <button
                type="button"
                onClick={advanceMobileStockMovement}
                disabled={stockBusy}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-[12px] bg-[#11120d] px-4 text-[14px] font-extrabold text-white disabled:opacity-50"
              >
                {stockBusy ? "Updating..." : mobileStockStep === 1 ? "Next: Add Products" : mobileStockStep === 2 ? "Next: Review Movement" : "Confirm Movement"}
                {!stockBusy ? <Icon name={mobileStockStep === 3 ? "inventory_2" : "arrow_forward"} className="text-[19px]" /> : null}
              </button>
            </div>
            <div className="hidden justify-end gap-[12px] lg:flex">
              <DialogButton onClick={closeStockManager}>Cancel</DialogButton>
              <DialogButton variant="primary" icon="inventory_2" onClick={confirmStockManager} disabled={stockBusy}>
                {stockBusy ? "Updating..." : "Confirm Movement"}
              </DialogButton>
            </div>
          </div>
            </>
          )}
        </div>
      </ModalFrame>

                                                      <ModalFrame
        open={openBulkPrice}
        title={confirmBulkPriceSave ? "Confirm price update" : bulkPriceMode === "MANUAL" ? "Enter exact selling prices" : "Set selling prices"}
        description={
          confirmBulkPriceSave
            ? "Review catalog updates before saving."
            : bulkPriceMode === "MANUAL"
            ? "Select products to edit and review proposed changes before saving."
            : "Calculate selling prices from each product's Rate, then adjust exceptions before saving."
        }
        descriptionClassName="hidden lg:block"
        onClose={requestCloseBulkPrice}
        maxWidthClass="max-w-[1100px]"
        dialogClassName={`flex flex-col lg:max-h-[calc(100vh-32px)] ${compactBulkPriceFlow || (confirmBulkPriceSave && bulkPriceImpactAnalytics.affectedItems.length <= 10) ? "lg:h-auto" : "lg:h-[820px]"}`}
        bodyClassName={confirmBulkPriceSave || compactBulkPriceFlow ? "min-h-0 flex-1 flex flex-col overflow-y-auto overscroll-contain p-3 sm:p-4 lg:p-4" : "flex-1 min-h-0 flex flex-col overflow-y-auto overscroll-contain p-3 sm:p-4 xl:overflow-hidden lg:p-4"}
        mobileFullScreen={!compactBulkPriceFlow}
        mobileBottomSheet={compactBulkPriceFlow}
        footer={
          confirmBulkPriceSave ? (
            <div className="flex w-full flex-col gap-2 lg:flex-row lg:items-center lg:gap-4">
              <div className="flex min-w-0 flex-col lg:flex-1">
                <div className="flex min-w-0 items-center gap-2">
                <label htmlFor="bulk-price-reason-combobox-confirm" className="flex shrink-0 items-center gap-1 text-[12px] font-extrabold text-[#11120d]">
                  <Icon name="verified" sizePx={14} className="text-blue-600" />
                  Audit reason <span className="text-rose-600">*</span>
                </label>
                <div className="min-w-0 flex-1 lg:max-w-[390px]">
                  <CreatableCombobox
                    compact
                    inputRef={priceReasonRef}
                    value={priceReason}
                    onChange={(val) => {
                      setPriceReason(val);
                      setBulkPriceTouched(true);
                      if (bulkPriceErrors.reason) setBulkPriceErrors((current) => ({ ...current, reason: undefined }));
                    }}
                    options={[
                      "Supplier Rate changed",
                      "Market price changed",
                      "Seasonal price adjustment",
                      "Promotion ended",
                      "Correcting an entry mistake",
                      "Management-approved price review",
                    ]}
                    placeholder="Choose or type a reason..."
                    ariaLabel="Price update audit reason"
                    allowCreate
                    required
                    invalid={Boolean(bulkPriceErrors.reason)}
                  />
                </div>
                </div>
                {bulkPriceErrors.reason ? <p role="alert" className="mt-1 text-xs font-semibold text-rose-700">{bulkPriceErrors.reason}</p> : null}
              </div>
              <div className="flex w-full items-center justify-between gap-2 lg:w-auto lg:justify-end">
              <button type="button" onClick={() => setConfirmBulkPriceSave(false)} disabled={priceBusy || reviewLoading} className="inline-flex min-h-11 items-center justify-center rounded-[9px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-bold text-[#11120d] disabled:opacity-50">
                <span className="sm:hidden">← Back</span><span className="hidden sm:inline">← Back to preview</span>
              </button>
              <button
                type="button"
                onClick={confirmBulkPriceUpdate}
                aria-label={priceBusy ? "Updating prices" : `Confirm ${bulkPriceImpactAnalytics.affectedCount.toLocaleString()} updates`}
                disabled={priceBusy || reviewLoading || saveOutcomeUncertain || bulkPriceImpactAnalytics.affectedCount === 0}
                className="inline-flex min-h-11 min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] border border-[#11120d] bg-[#11120d] px-3 text-[12px] font-extrabold text-white transition hover:bg-[#2a2c27] active:scale-[0.99] disabled:opacity-40 sm:min-w-[220px]"
              >
                <Icon name="sell" sizePx={15} />
                <span>{priceBusy ? "Updating..." : <><span className="sm:hidden">Confirm {bulkPriceImpactAnalytics.affectedCount.toLocaleString()}</span><span className="hidden sm:inline">Confirm {bulkPriceImpactAnalytics.affectedCount.toLocaleString()} updates</span></>}</span>
              </button>
              </div>
            </div>
          ) : !pricePreviewReady ? (
            <div className="flex w-full items-center justify-between gap-3">
              <DialogButton onClick={requestCloseBulkPrice}>Cancel</DialogButton>
              <button
                type="button"
                onClick={calculateBulkPricePreview}
                aria-label={bulkPriceMode === "MANUAL" ? "Review selected prices" : `Calculate preview for ${isFilteredSelection ? selectedCount.toLocaleString() : priceMarginTargetCount.toLocaleString()} ${((isFilteredSelection ? selectedCount : priceMarginTargetCount) === 1) ? "product" : "products"}`}
                disabled={priceBusy || (isFilteredSelection ? selectedCount === 0 : priceMarginTargetCount === 0)}
                className="inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[9px] border border-[#11120d] bg-[#11120d] px-3 sm:px-4 text-[12px] font-extrabold text-white transition hover:bg-[#2a2c27] active:scale-[0.99] disabled:opacity-40"
              >
                <Icon name="calculate" sizePx={15} />
                <span>
                  <span className="sm:hidden">{bulkPriceMode === "MANUAL" ? "Preview prices" : `Preview ${(isFilteredSelection ? selectedCount : priceMarginTargetCount).toLocaleString()}`}</span>
                  <span className="hidden sm:inline">{bulkPriceMode === "MANUAL"
                    ? "Review selected prices"
                    : `Calculate preview for ${isFilteredSelection ? selectedCount.toLocaleString() : priceMarginTargetCount.toLocaleString()} ${((isFilteredSelection ? selectedCount : priceMarginTargetCount) === 1) ? "product" : "products"}`} →</span>
                </span>
              </button>
            </div>
          ) : (
            <div className="flex w-full items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setPricePreviewReady(false)}
                aria-label="Modify settings"
                className="inline-flex min-h-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] border border-[#CFCFD3] bg-white px-3.5 text-[12px] font-bold text-[#565449] hover:bg-slate-50 transition touch-manipulation"
              >
                <Icon name="arrow_back" sizePx={15} />
                <span className="sm:hidden">Back</span><span className="hidden sm:inline">Modify settings</span>
              </button>
              <button
                type="button"
                onClick={requestBulkPriceUpdate}
                aria-label="Review changes"
                disabled={priceBusy}
                className="inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[9px] border border-[#11120d] bg-[#11120d] px-3 sm:px-4 text-[12px] font-extrabold text-white transition hover:bg-[#2a2c27] active:scale-[0.99] disabled:opacity-40"
              >
                <Icon name="sell" sizePx={15} />
                <span>{priceBusy ? "Checking..." : <><span className="sm:hidden">Review prices</span><span className="hidden sm:inline">Review changes →</span></>}</span>
              </button>
            </div>
          )
        }
      >
        <div className={`flex flex-col gap-2 max-lg:shrink-0 ${compactBulkPriceFlow || confirmBulkPriceSave ? "min-h-0" : "min-h-0 xl:h-full"}`}>
          {/* TOP BAR: CLEAN STEPPER BREADCRUMB & COMPACT MODE SEGMENT */}
          <div className="flex shrink-0 flex-col items-start gap-2 border-b border-[#E5E7EB] pb-2 lg:flex-row lg:items-center lg:justify-between">
            {/* Minimalist Workflow Stepper (Not buttons!) */}
            <div className="flex items-center gap-2 sm:gap-4 text-[11px] font-bold" aria-label="Workflow steps">
              {/* Step 1 */}
              <button
                type="button"
                onClick={() => { if(pricePreviewReady) { setPricePreviewReady(false); setConfirmBulkPriceSave(false); } }}
                className={`flex items-center gap-1.5 sm:gap-2 transition ${!pricePreviewReady ? "text-[#11120d]" : "text-slate-500 hover:text-slate-700"}`}
              >
                <span className={`flex h-5 w-5 sm:h-6 sm:w-6 items-center justify-center rounded-full text-[10px] sm:text-[11px] font-black ${!pricePreviewReady ? "bg-[#11120d] text-white" : "bg-slate-100"}`}>
                  {!pricePreviewReady ? "1" : "✓"}
                </span>
                <span className="hidden sm:inline">Config</span>
                <span className="sm:hidden">Config</span>
              </button>

              <div className="h-[1px] w-4 sm:w-8 bg-slate-200"></div>

              {/* Step 2 */}
              <button
                type="button"
                disabled={!pricePreviewReady && !confirmBulkPriceSave}
                onClick={() => { if(confirmBulkPriceSave) setConfirmBulkPriceSave(false); }}
                className={`flex items-center gap-1.5 sm:gap-2 transition ${(pricePreviewReady && !confirmBulkPriceSave) ? "text-[#11120d]" : "text-slate-500"} ${confirmBulkPriceSave ? "hover:text-slate-700" : ""}`}
              >
                <span className={`flex h-5 w-5 sm:h-6 sm:w-6 items-center justify-center rounded-full text-[10px] sm:text-[11px] font-black ${(pricePreviewReady && !confirmBulkPriceSave) ? "bg-[#11120d] text-white" : "bg-slate-100"}`}>
                  {confirmBulkPriceSave ? "✓" : "2"}
                </span>
                <span className="hidden sm:inline">Preview</span>
                <span className="sm:hidden">Preview</span>
              </button>

              <div className="h-[1px] w-4 sm:w-8 bg-slate-200"></div>

              {/* Step 3 */}
              <div className={`flex items-center gap-1.5 sm:gap-2 ${confirmBulkPriceSave ? "text-[#11120d]" : "text-slate-400"}`}>
                <span className={`flex h-5 w-5 sm:h-6 sm:w-6 items-center justify-center rounded-full text-[10px] sm:text-[11px] font-black ${confirmBulkPriceSave ? "bg-[#11120d] text-white" : "bg-slate-100 text-slate-400"}`}>
                  3
                </span>
                <span className="hidden sm:inline">Review</span>
                <span className="sm:hidden">Review</span>
              </div>
              </div>

            {/* Mode Segmented Control (Compact capsule, not action buttons!) */}
            {!pricePreviewReady ? (
              <div className="flex w-full items-center justify-between gap-2 lg:w-auto">
                <span className="text-[12px] font-bold text-slate-600 lg:sr-only">Pricing method</span>
                <div className="inline-flex shrink-0 rounded-lg border border-slate-200 bg-slate-100 p-0.5" role="group" aria-label="Pricing method">
                <button
                  type="button"
                  onClick={() => { setBulkPriceMode("CALCULATE"); setBulkPriceNotice(null); setBulkPriceTouched(true); setExplicitAdjustedIds({}); }}
                  aria-pressed={bulkPriceMode === "CALCULATE"}
                  className={`min-h-11 rounded-md px-4 text-[13px] font-bold transition flex items-center gap-1.5 whitespace-nowrap touch-manipulation ${
                    bulkPriceMode === "CALCULATE"
                      ? "bg-white text-[#11120d] shadow-2xs border border-slate-200/80 font-extrabold"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  <Icon name="calculate" sizePx={14} className={bulkPriceMode === "CALCULATE" ? "text-blue-600" : "text-slate-400"} />
                  <span>Formula</span>
                </button>
                <button
                  type="button"
                  disabled={isFilteredSelection}
                  onClick={() => { setBulkPriceMode("MANUAL"); setBulkPriceNotice(null); setBulkPriceTouched(true); setExplicitAdjustedIds({}); }}
                  aria-pressed={bulkPriceMode === "MANUAL"}
                  className={`min-h-11 rounded-md px-4 text-[13px] font-bold transition flex items-center gap-1.5 whitespace-nowrap touch-manipulation disabled:cursor-not-allowed disabled:opacity-40 ${
                    bulkPriceMode === "MANUAL"
                      ? "bg-white text-[#11120d] shadow-2xs border border-slate-200/80 font-extrabold"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                  title={isFilteredSelection ? "Choose specific products to enter every price manually." : undefined}
                >
                  <Icon name="edit" sizePx={14} className={bulkPriceMode === "MANUAL" ? "text-blue-600" : "text-slate-400"} />
                  <span>Manual</span>
                </button>
                </div>
              </div>
            ) : (
              <span className="rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10.5px] font-extrabold text-blue-700">
                {bulkPriceMode === "CALCULATE" ? "Formula calculation" : "Manual review"}
              </span>
            )}
          </div>

          {/* Scope Telemetry Bar */}
          {isFilteredSelection ? (
            <div className="rounded-[8px] border border-blue-200 bg-blue-50/70 px-2.5 py-1 text-[11px] font-medium text-blue-900 shrink-0">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <div className="flex items-center gap-1.5">
                  <Icon name="info" sizePx={14} className="text-blue-600 shrink-0" />
                  <span>
                    Scope: <strong className="font-bold">{selectedCount.toLocaleString()} products</strong> matching current filters.
                  </span>
                </div>
                <div className="flex items-center gap-1 font-bold text-[9.5px]">
                  <span className="rounded bg-white px-1.5 py-0.2 border border-blue-200 text-blue-800">
                    {priceChangeDirection === "INCREASE" ? "+ Markup" : "− Markdown"}
                  </span>
                  {updateWholesalePrice ? <span className="rounded bg-white px-1.5 py-0.2 border border-blue-200 text-blue-800">Wholesale {wholesaleMarginPercent}%</span> : null}
                  {updateRetailPrice ? <span className="rounded bg-white px-1.5 py-0.2 border border-purple-200 text-purple-800">Retail {retailMarginPercent}%</span> : null}
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-[8px] border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-600 shrink-0">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <div className="flex items-center gap-1.5 flex-wrap text-[10.5px]">
                  <span>To edit: <strong className="text-[#11120d] font-bold">{priceMarginTargetCount}</strong> of {selectedCount} in scope</span>
                  <span className="text-slate-300">·</span>
                  <span className="text-emerald-700 font-bold">{selectedPriceStatus.withRate} with Rate</span>
                  <span className="hidden sm:inline text-slate-300">·</span>
                  <span className="hidden sm:inline text-blue-700 font-semibold">{selectedPriceStatus.withWholesale} Wholesale</span>
                  <span className="hidden sm:inline text-slate-300">·</span>
                  <span className="hidden sm:inline text-purple-700 font-semibold">{selectedPriceStatus.withRetail} Retail</span>
                  {selectedPriceStatus.comingSoon > 0 ? (
                    <>
                      <span className="text-slate-300">·</span>
                      <span className="text-amber-700 font-bold">{selectedPriceStatus.comingSoon} Coming soon</span>
                    </>
                  ) : null}
                </div>
                {bulkPriceMode === "CALCULATE" ? (
                  <span className={`rounded px-1.5 py-0.2 text-[9px] font-bold border ${
                    existingSellingPricePolicy === "FILL_EMPTY"
                      ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                      : "bg-amber-50 border-amber-200 text-amber-800"
                  }`}>
                    {existingSellingPricePolicy === "FILL_EMPTY" ? "Fill empty only" : "Replace prices"}
                  </span>
                ) : null}
              </div>
            </div>
          )}

          {/* Notice Alert Banner */}
          {bulkPriceNotice && (!pricePreviewReady || bulkPriceNotice.tone === "danger") && !(!isFilteredSelection && bulkPriceNotice.tone === "success") ? (
            <div role="status" className={`shrink-0 rounded-[8px] border px-2.5 py-1 text-[11px] font-bold leading-5 ${
              bulkPriceNotice.tone === "danger"
                ? "border-rose-200 bg-rose-50 text-rose-800"
                : bulkPriceNotice.tone === "info" ? "border-blue-200 bg-blue-50 text-blue-900" : "border-emerald-200 bg-emerald-50 text-emerald-800"
            }`}>
              {bulkPriceNotice.message}
            </div>
          ) : null}

          {/* STEP 1: CONFIGURE VIEW */}
          {confirmBulkPriceSave ? (
        <div className="flex flex-col gap-3 py-1 text-xs">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[9px] border border-blue-200 bg-blue-50 px-3 py-2 text-[12px]">
            <span className="font-extrabold text-blue-900">To update: <strong className="tabular-nums">{bulkPriceImpactAnalytics.affectedCount.toLocaleString()}</strong></span>
            <span className="font-semibold text-slate-700">Preserved: <strong className="tabular-nums">{bulkPriceImpactAnalytics.preservedCount.toLocaleString()}</strong></span>
            {explicitReviewPreview?.errorCount && !isFilteredSelection ? <span className="font-bold text-rose-800">Cannot preview: {explicitReviewPreview.errorCount}</span> : null}
            <span className="font-medium text-slate-700">
              {bulkPriceMode === "MANUAL" ? "Exact prices" : `Wholesale ${updateWholesalePrice ? `Rate ${priceChangeDirection === "INCREASE" ? "+" : "−"}${wholesaleMarginPercent}%` : "unchanged"} · Retail ${updateRetailPrice ? `Rate ${priceChangeDirection === "INCREASE" ? "+" : "−"}${retailMarginPercent}%` : "unchanged"}`}
              {bulkPriceMode !== "MANUAL" ? ` · ${existingSellingPricePolicy === "FILL_EMPTY" ? "Fill empty only" : "Replace prices"}` : ""}
            </span>
          </div>

          {/* Affected Products Review Table */}
          <div className="flex flex-col rounded-[10px] border border-[#E5E7EB] bg-white">
            <div className="border-b border-[#E5E7EB] bg-[#F8FAFC] px-3 py-1.5 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Icon name="list_alt" sizePx={14} className="text-blue-600" />
                <span className="text-[12px] font-extrabold text-[#11120d]">
                  {isFilteredSelection
                    ? `Preview sample (${bulkPriceImpactAnalytics.affectedItems.length.toLocaleString()} of ${bulkPriceImpactAnalytics.affectedCount.toLocaleString()})`
                    : `Affected products (${bulkPriceImpactAnalytics.affectedCount.toLocaleString()})`}
                </span>
              </div>
            </div>

            <div className="divide-y divide-[#E5E7EB]">
              {bulkPriceImpactAnalytics.affectedItems.map((item) => {
                const changedFieldCount = Number(item.oldRate !== item.newRate)
                  + Number(item.wholesaleChanged && item.newWholesale !== null)
                  + Number(item.retailChanged && item.newRetail !== null);
                return (
                <div key={item.id} className="flex flex-col gap-2 p-3 hover:bg-[#F8FAFC] lg:grid lg:grid-cols-[minmax(0,30%)_minmax(0,1fr)] lg:items-center lg:gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="break-words font-extrabold text-[13px] leading-5 text-[#11120d]">{item.name}</div>
                    <div className="break-all text-[11px] leading-5 text-slate-600">
                      SKU: {item.sku || "None"}
                    </div>
                  </div>

                  <div className={`grid w-full min-w-0 grid-cols-1 gap-2 text-left ${changedFieldCount === 2 ? "lg:grid-cols-2" : changedFieldCount === 3 ? "lg:grid-cols-3" : "lg:grid-cols-1"}`}>
                    {item.oldRate !== item.newRate ? (
                      <div className={`min-w-0 rounded-md bg-slate-50 px-3 py-2 text-[12px] ${changedFieldCount === 1 ? "lg:flex lg:items-center lg:justify-between lg:gap-4" : ""}`}>
                        <span className="block font-bold text-slate-700">Rate</span>
                        <div className="mt-1 flex flex-wrap items-baseline gap-x-2 tabular-nums lg:mt-0 lg:justify-end">
                          <span className="text-slate-600">Current {formatReviewPrice(item.oldRate)}</span>
                          <span className="font-extrabold text-slate-900">→ Proposed {formatReviewPrice(item.newRate)}</span>
                        </div>
                      </div>
                    ) : null}
                    {item.wholesaleChanged && item.newWholesale !== null ? (
                      <div className={`min-w-0 rounded-md bg-blue-50 px-3 py-2 text-[12px] ${changedFieldCount === 1 ? "lg:flex lg:items-center lg:justify-between lg:gap-4" : ""}`}>
                        <span className="block font-bold text-blue-800">Wholesale</span>
                        <div className="mt-1 flex flex-wrap items-baseline gap-x-2 tabular-nums lg:mt-0 lg:justify-end">
                          <span className="text-slate-600">Current {formatReviewPrice(item.oldWholesale)}</span>
                          <span className="font-extrabold text-blue-900">→ Proposed {formatReviewPrice(item.newWholesale)}</span>
                        </div>
                      </div>
                    ) : null}

                    {item.retailChanged && item.newRetail !== null ? (
                      <div className={`min-w-0 rounded-md bg-purple-50 px-3 py-2 text-[12px] ${changedFieldCount === 1 ? "lg:flex lg:items-center lg:justify-between lg:gap-4" : ""}`}>
                        <span className="block font-bold text-purple-800">Retail</span>
                        <div className="mt-1 flex flex-wrap items-baseline gap-x-2 tabular-nums lg:mt-0 lg:justify-end">
                          <span className="text-slate-600">Current {formatReviewPrice(item.oldRetail)}</span>
                          <span className="font-extrabold text-purple-900">→ Proposed {formatReviewPrice(item.newRetail)}</span>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              );})}

              {bulkPriceImpactAnalytics.affectedItems.length === 0 ? (
                <div className="p-5 text-center text-[11px] font-semibold text-[#8C8889]">
                  No products have changed values. Existing prices will be kept.
                </div>
              ) : isFilteredSelection && bulkPriceImpactAnalytics.affectedCount > bulkPriceImpactAnalytics.affectedItems.length ? (
                <div className="p-2 text-center text-[10px] font-bold text-[#8C8889] bg-[#F8FAFC]">
                  Showing {bulkPriceImpactAnalytics.affectedItems.length.toLocaleString()} products from this preview. {bulkPriceImpactAnalytics.affectedCount.toLocaleString()} products will be updated.
                </div>
              ) : null}
            </div>
            {!isFilteredSelection && explicitReviewPreview && explicitReviewPreview.previewTotalPages > 1 ? (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-3 py-2 text-[12px] font-semibold text-slate-700">
                <span>Showing {(reviewPage - 1) * explicitReviewPreview.previewPageSize + 1}–{Math.min(explicitReviewPreview.previewCount, reviewPage * explicitReviewPreview.previewPageSize)} of {explicitReviewPreview.previewCount.toLocaleString()}</span>
                <div className="flex items-center gap-2">
                  <span className="tabular-nums">Page {reviewPage} of {explicitReviewPreview.previewTotalPages}</span>
                  <button type="button" aria-label="Previous review page" disabled={reviewPage <= 1 || reviewLoading} onClick={() => void loadExplicitReviewPage(reviewPage - 1)} className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-300 bg-white disabled:opacity-40"><Icon name="chevron_left" sizePx={20} /></button>
                  <button type="button" aria-label="Next review page" disabled={reviewPage >= explicitReviewPreview.previewTotalPages || reviewLoading} onClick={() => void loadExplicitReviewPage(reviewPage + 1)} className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-300 bg-white disabled:opacity-40"><Icon name="chevron_right" sizePx={20} /></button>
                </div>
              </div>
            ) : null}
          </div>

        </div>
          ) : !pricePreviewReady ? (
            bulkPriceMode === "MANUAL" ? (
              /* MANUAL MODE: FULL-WIDTH CLEAN PRODUCT SELECTOR */
              <div className={`w-full flex flex-col rounded-[12px] border border-[#E5E7EB] bg-white overflow-hidden ${compactBulkPriceFlow ? "shrink-0" : "flex-1 min-h-0"}`}>
                <div className="border-b border-[#E5E7EB] px-3 py-2 bg-[#F8FAFC] shrink-0 space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <h4 className="text-[12.5px] font-extrabold text-[#11120d]">Target Products ({priceMarginTargetCount})</h4>
                      <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.2 text-[9.5px] font-extrabold text-blue-700">Manual</span>
                    </div>
                    <div className="flex w-full items-center gap-2 sm:w-auto">
                      <button
                        type="button"
                        onClick={() => setVisiblePriceMarginTargets(true)}
                        aria-label={`Select all ${visibleBulkPriceProducts.length} ${priceSearch ? "matching" : "visible"} products`}
                        className="inline-flex min-h-11 flex-1 items-center justify-center whitespace-nowrap rounded-[7px] border border-[#CBD5E1] bg-white px-2.5 text-[12px] font-bold text-[#11120d] hover:bg-slate-50 touch-manipulation sm:flex-none"
                      >
                        Select {visibleBulkPriceProducts.length}
                      </button>
                      <button
                        type="button"
                        onClick={() => setVisiblePriceMarginTargets(false)}
                        aria-label={`Clear all ${visibleBulkPriceProducts.length} ${priceSearch ? "matching" : "visible"} products`}
                        className="inline-flex min-h-11 flex-1 items-center justify-center whitespace-nowrap rounded-[7px] border border-[#CBD5E1] bg-white px-2.5 text-[12px] font-bold text-[#565449] hover:bg-slate-50 touch-manipulation sm:flex-none"
                      >
                        Clear {visibleBulkPriceProducts.length}
                      </button>
                    </div>
                  </div>
                  {/* Search Bar + Sort Button Row */}
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1 flex items-center h-10 rounded-[9px] border border-[#CFCFD3] bg-white px-3 transition focus-within:border-blue-600 focus-within:ring-1 focus-within:ring-blue-600">
                      <Icon name="search" sizePx={18} className="text-[#8C8889] shrink-0" />
                      <input
                        value={priceSearch}
                        onChange={(event) => setPriceSearch(event.target.value)}
                        placeholder="Search name, SKU, brand…"
                        className="w-full bg-transparent pl-2.5 pr-2 text-[13px] font-semibold text-[#11120d] outline-none placeholder-[#8C8889]"
                      />
                      {priceSearch ? (
                        <button
                          type="button"
                          onClick={() => setPriceSearch("")}
                          className="!min-h-0 !min-w-0 p-1 text-[#8C8889] hover:text-[#11120d]"
                          aria-label="Clear search"
                        >
                          <Icon name="close" sizePx={14} />
                        </button>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => setOpenBulkPriceSortModal(true)}
                      className={`inline-flex h-10 !min-h-0 items-center justify-center gap-1.5 rounded-[9px] border px-3 text-[12px] font-bold transition shrink-0 ${
                        bulkPriceSort !== "affected_first"
                          ? "border-blue-200 bg-blue-50 text-blue-700"
                          : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-slate-50"
                      }`}
                      aria-label="Sort products"
                      title="Sort products"
                    >
                      <Icon name="swap_vert" sizePx={16} />
                      <span className="hidden sm:inline">Sort</span>
                      {bulkPriceSort !== "affected_first" ? (
                        <span className="flex h-2 w-2 rounded-full bg-blue-600" />
                      ) : null}
                    </button>
                  </div>
                </div>

                {/* Full-width Scrollable Checklist */}
                <div className={`divide-y divide-[#E5E7EB] bg-white ${compactBulkPriceFlow ? "lg:max-h-[400px] lg:overflow-y-auto" : "min-h-0 lg:flex-1 lg:overflow-y-auto"}`}>
                  {paginatedStep1Items.map((product) => {
                    const isChecked = Boolean(priceMarginTargetIds[product.id]);
                    const isComingSoon = product.availabilityStatus === "COMING_SOON";
                    const hasNoRate = !(Number(product.ratePerPiece) > 0);
                    return (
                      <label
                        key={product.id}
                        className={`flex min-h-[48px] cursor-pointer items-center justify-between gap-2.5 px-3 py-3 hover:bg-[#F8FAFC] transition touch-manipulation select-none ${
                          isChecked ? "bg-slate-50/50" : ""
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => {
                              setPriceMarginTargetIds((current) => ({ ...current, [product.id]: !current[product.id] }));
                              setBulkPriceNotice(null);
                              setBulkPriceTouched(true);
                            }}
                            className="h-4.5 w-4.5 rounded-[4px] border-[#CFCFD3] accent-[#11120d] shrink-0 cursor-pointer"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="truncate text-[13px] font-extrabold text-[#11120d]">{product.name}</span>
                              {isComingSoon ? (
                                <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.2 text-[8.5px] font-extrabold text-amber-800">Coming soon</span>
                              ) : hasNoRate ? (
                                <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.2 text-[8.5px] font-extrabold text-amber-800">No Rate</span>
                              ) : null}
                            </div>
                            <div className="text-[10px] text-[#8C8889] truncate">
                              SKU: {product.sku || "None"}{product.brand ? ` · ${product.brand}` : ""}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 shrink-0 text-right">
                          <div className="text-[12.5px] font-bold text-[#565449]">
                            <span className="text-[10px] text-[#8C8889] block">Rate</span>
                            <span className="tabular-nums text-[#11120d]">{product.ratePerPiece ? `NPR ${product.ratePerPiece}` : "None"}</span>
                          </div>
                          <div className="text-[12.5px] font-bold text-blue-700">
                            <span className="text-[10px] text-[#8C8889] block">Wholesale</span>
                            <span className="tabular-nums">{product.wholesalePrice ? `NPR ${product.wholesalePrice}` : "None"}</span>
                          </div>
                          <div className="text-[12.5px] font-bold text-purple-700">
                            <span className="text-[10px] text-[#8C8889] block">Retail</span>
                            <span className="tabular-nums">{product.retailPrice ? `NPR ${product.retailPrice}` : "None"}</span>
                          </div>
                        </div>
                      </label>
                    );
                  })}
                  {paginatedStep1Items.length === 0 ? (
                    <div className="p-6 text-center text-[12px] font-semibold text-[#8C8889]">
                      No selected products match this search.
                    </div>
                  ) : null}

                  {/* Pagination Footer (now scrolls with content) */}
                  <div className="border-t border-[#E5E7EB] bg-[#F8FAFC] px-3 py-1.5 text-[10.5px] font-semibold text-[#6B7280] flex items-center justify-between shrink-0 mt-auto">
                  <span>
                    Showing <strong className="text-[#11120d]">{step1Items.length === 0 ? 0 : (activeStep1Page - 1) * BULK_PRICE_STEP1_PAGE_SIZE + 1}–{Math.min(step1Items.length, activeStep1Page * BULK_PRICE_STEP1_PAGE_SIZE)}</strong> of <strong className="text-[#11120d]">{step1Items.length}</strong>
                  </span>
                  {step1TotalPages > 1 ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-bold text-[#565449] tabular-nums">
                        {activeStep1Page}/{step1TotalPages}
                      </span>
                      <button
                        type="button"
                        disabled={activeStep1Page <= 1}
                        onClick={() => setBulkPriceStep1Page((p) => Math.max(1, p - 1))}
                        className="inline-flex h-6.5 w-6.5 !min-h-0 !min-w-0 items-center justify-center rounded-[5px] border border-[#D8DBE0] bg-white text-[#11120d] transition hover:bg-slate-50 disabled:opacity-30 disabled:pointer-events-none touch-manipulation"
                        aria-label="Previous page"
                      >
                        <Icon name="chevron_left" sizePx={13} />
                      </button>
                      <button
                        type="button"
                        disabled={activeStep1Page >= step1TotalPages}
                        onClick={() => setBulkPriceStep1Page((p) => Math.min(step1TotalPages, p + 1))}
                        className="inline-flex h-6.5 w-6.5 !min-h-0 !min-w-0 items-center justify-center rounded-[5px] border border-[#D8DBE0] bg-white text-[#11120d] transition hover:bg-slate-50 disabled:opacity-30 disabled:pointer-events-none touch-manipulation"
                        aria-label="Next page"
                      >
                        <Icon name="chevron_right" sizePx={13} />
                      </button>
                    </div>
                  ) : null}
                </div>
                </div>
              </div>
            ) : (
              /* CALCULATE MODE: CLEAN UNDERLINE TABS ON MOBILE / 2-COLUMN ON DESKTOP */
              <div className={`flex flex-col xl:grid xl:grid-cols-[360px_1fr] gap-2.5 items-stretch ${compactBulkPriceFlow ? "xl:max-h-[630px]" : "xl:flex-1 xl:min-h-0"}`}>
                {/* Mobile Underline Tab Bar (Clean tab navigation, NOT buttons!) */}
                <div className="flex border-b border-slate-200 text-[12px] font-bold shrink-0 xl:hidden">
                  <button
                    type="button"
                    onClick={() => setMobileStep1Tab("formula")}
                    className={`flex-1 pb-2 text-center border-b-2 transition flex items-center justify-center gap-1.5 touch-manipulation ${
                      mobileStep1Tab === "formula"
                        ? "border-blue-600 text-blue-700 font-extrabold"
                        : "border-transparent text-slate-500 hover:text-slate-800"
                    }`}
                  >
                    <Icon name="tune" sizePx={15} className={mobileStep1Tab === "formula" ? "text-blue-600" : "text-slate-400"} />
                    <span>1. Formula Rules</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setMobileStep1Tab("products")}
                    className={`flex-1 pb-2 text-center border-b-2 transition flex items-center justify-center gap-1.5 touch-manipulation ${
                      mobileStep1Tab === "products"
                        ? "border-blue-600 text-blue-700 font-extrabold"
                        : "border-transparent text-slate-500 hover:text-slate-800"
                    }`}
                  >
                    <Icon name="checklist" sizePx={15} className={mobileStep1Tab === "products" ? "text-blue-600" : "text-slate-400"} />
                    <span>2. Target Items</span>
                    <span className="rounded-full bg-slate-100 px-1.5 py-0.2 text-[10px] text-slate-600 font-extrabold">
                      {isFilteredSelection ? selectedCount : priceMarginTargetCount}
                    </span>
                  </button>
                </div>

                {/* Left Column: Semantic Controls + Summary Card */}
                <div className={`flex-col gap-2 overflow-y-auto pr-0.5 ${mobileStep1Tab === "formula" ? "flex flex-1 min-h-0" : "hidden xl:flex"}`}>
                  {/* 1. Price Direction: Emerald (Markup) vs Amber (Markdown) */}
                  <section className="rounded-[11px] border border-slate-200 bg-slate-50/60 p-2.5 shrink-0">
                    <div className="mb-1.5 flex items-center justify-between gap-1.5">
                      <span className="text-[13px] font-extrabold text-[#11120d] flex items-center gap-1">
                        <Icon name="trending_up" sizePx={14} className="text-slate-500" />
                        1. Price Direction
                      </span>
                      <span className={`rounded-full border px-2 py-0.2 text-[9.5px] font-extrabold ${
                        priceChangeDirection === "INCREASE"
                          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                          : "border-amber-200 bg-amber-50 text-amber-800"
                      }`}>
                        {priceChangeDirection === "INCREASE" ? "Rate × (1 + %)" : "Rate × (1 − %)"}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 rounded-[8px] border border-slate-200 bg-white p-1">
                      <button
                        type="button"
                        onClick={() => { setPriceChangeDirection("INCREASE"); setBulkPriceNotice(null); setBulkPriceTouched(true); }}
                        className={`h-7.5 rounded-[6px] text-[11.5px] font-extrabold transition touch-manipulation flex items-center justify-center gap-1 ${
                          priceChangeDirection === "INCREASE"
                            ? "border border-emerald-600 bg-emerald-600 text-white shadow-2xs"
                            : "border border-transparent text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        <span>+ Markup (Add margin)</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => { setPriceChangeDirection("DECREASE"); setBulkPriceNotice(null); setBulkPriceTouched(true); }}
                        className={`h-7.5 rounded-[6px] text-[11.5px] font-extrabold transition touch-manipulation flex items-center justify-center gap-1 ${
                          priceChangeDirection === "DECREASE"
                            ? "border border-amber-600 bg-amber-600 text-white shadow-2xs"
                            : "border border-transparent text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        <span>− Markdown (Discount)</span>
                      </button>
                    </div>
                  </section>

                  {/* 2. Target Price Tiers: Wholesale (Blue) & Retail (Purple) */}
                  <section className="rounded-[11px] border border-slate-200 bg-slate-50/60 p-2.5 shrink-0">
                    <span className="text-[13px] font-extrabold text-[#11120d] flex items-center gap-1">
                      <Icon name="layers" sizePx={14} className="text-slate-500" />
                      2. Target Tiers
                    </span>
                    <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                      {/* Wholesale (Blue) */}
                      <div className={`rounded-[8px] border p-2 transition ${
                        updateWholesalePrice ? "border-blue-300 bg-blue-50/25 shadow-2xs" : "border-slate-200 bg-white opacity-60"
                      }`}>
                        <label className="flex items-center justify-between cursor-pointer select-none">
                          <span className="flex items-center gap-1.5 text-[13px] font-extrabold text-[#11120d]">
                            <input
                              type="checkbox"
                              checked={updateWholesalePrice}
                              onChange={(e) => { setUpdateWholesalePrice(e.target.checked); setBulkPriceNotice(null); setBulkPriceTouched(true); }}
                              className="h-4 w-4 rounded-[4px] accent-blue-600 cursor-pointer"
                            />
                            Wholesale
                          </span>
                          <span className="rounded border border-blue-200 bg-blue-100 px-1.5 py-0.2 text-[9px] font-extrabold text-blue-700">B2B</span>
                        </label>
                        <div className="relative mt-1.5">
                          <input
                            type="number"
                            value={wholesaleMarginPercent}
                            min={0.01}
                            max={priceChangeDirection === "DECREASE" ? 99.99 : 100}
                            step={0.01}
                            disabled={!updateWholesalePrice}
                            onChange={(e) => { setWholesaleMarginPercent(Number(e.target.value)); setBulkPriceNotice(null); setBulkPriceTouched(true); }}
                            className="h-8 w-full rounded-[6px] border border-slate-300 bg-white px-2.5 pr-7 text-[12px] font-extrabold text-[#11120d] outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600 disabled:bg-slate-100 disabled:text-slate-400"
                          />
                          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] font-bold text-slate-400">%</span>
                        </div>
                      </div>

                      {/* Retail (Purple) */}
                      <div className={`rounded-[8px] border p-2 transition ${
                        updateRetailPrice ? "border-purple-300 bg-purple-50/25 shadow-2xs" : "border-slate-200 bg-white opacity-60"
                      }`}>
                        <label className="flex items-center justify-between cursor-pointer select-none">
                          <span className="flex items-center gap-1.5 text-[13px] font-extrabold text-[#11120d]">
                            <input
                              type="checkbox"
                              checked={updateRetailPrice}
                              onChange={(e) => { setUpdateRetailPrice(e.target.checked); setBulkPriceNotice(null); setBulkPriceTouched(true); }}
                              className="h-4 w-4 rounded-[4px] accent-purple-600 cursor-pointer"
                            />
                            Retail
                          </span>
                          <span className="rounded border border-purple-200 bg-purple-100 px-1.5 py-0.2 text-[9px] font-extrabold text-purple-700">B2C</span>
                        </label>
                        <div className="relative mt-1.5">
                          <input
                            type="number"
                            value={retailMarginPercent}
                            min={0.01}
                            max={priceChangeDirection === "DECREASE" ? 99.99 : 100}
                            step={0.01}
                            disabled={!updateRetailPrice}
                            onChange={(e) => { setRetailMarginPercent(Number(e.target.value)); setBulkPriceNotice(null); setBulkPriceTouched(true); }}
                            className="h-8 w-full rounded-[6px] border border-slate-300 bg-white px-2.5 pr-7 text-[12px] font-extrabold text-[#11120d] outline-none focus:border-purple-600 focus:ring-1 focus:ring-purple-600 disabled:bg-slate-100 disabled:text-slate-400"
                          />
                          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] font-bold text-slate-400">%</span>
                        </div>
                      </div>
                    </div>
                    {!priceMarginsValid ? (
                      <p className="mt-1 text-[10px] font-bold text-[#BE123C]" role="alert">
                        {priceChangeDirection === "DECREASE" ? "Percentage must be > 0 and < 100." : "Percentage must be > 0 and ≤ 100."}
                      </p>
                    ) : null}
                  </section>

                  {/* 3. Existing Price Policy: Emerald (Safe) & Amber (Overwrite) */}
                  <section className="rounded-[11px] border border-slate-200 bg-slate-50/60 p-2.5 shrink-0">
                    <span className="text-[13px] font-extrabold text-[#11120d] flex items-center gap-1">
                      <Icon name="policy" sizePx={14} className="text-slate-500" />
                      3. Existing Price Policy
                    </span>
                    <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
                      <button
                        type="button"
                        onClick={() => { setExistingSellingPricePolicy("FILL_EMPTY"); setBulkPriceNotice(null); setBulkPriceTouched(true); }}
                        className={`rounded-[8px] border p-2 text-left transition touch-manipulation ${
                          existingSellingPricePolicy === "FILL_EMPTY"
                            ? "border-emerald-300 bg-emerald-50/70 shadow-2xs"
                            : "border-slate-200 bg-white hover:bg-slate-50"
                        }`}
                      >
                        <span className="flex items-center gap-1.5 text-[11px] font-extrabold text-[#11120d]">
                          <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-black ${
                            existingSellingPricePolicy === "FILL_EMPTY" ? "bg-emerald-600 text-white" : "border border-slate-300 text-slate-500"
                          }`}>✓</span>
                          Fill empty only
                        </span>
                        <span className="mt-0.5 block text-[9.5px] font-medium text-slate-600">Preserve entered prices.</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => { setExistingSellingPricePolicy("REPLACE"); setBulkPriceNotice(null); setBulkPriceTouched(true); }}
                        className={`rounded-[8px] border p-2 text-left transition touch-manipulation ${
                          existingSellingPricePolicy === "REPLACE"
                            ? "border-amber-300 bg-amber-50/70 shadow-2xs"
                            : "border-slate-200 bg-white hover:bg-slate-50"
                        }`}
                      >
                        <span className="flex items-center gap-1.5 text-[11px] font-extrabold text-[#11120d]">
                          <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-black ${
                            existingSellingPricePolicy === "REPLACE" ? "bg-amber-600 text-white" : "border border-slate-300 text-slate-500"
                          }`}>↻</span>
                          Replace prices
                        </span>
                        <span className="mt-0.5 block text-[9.5px] font-medium text-slate-600">Overwrite selected.</span>
                      </button>
                    </div>
                  </section>

                  {/* 4. Live Rules Summary Card (Blue) */}
                  <section className="rounded-[11px] border border-blue-200 bg-blue-50/70 p-2.5 shrink-0 text-[11px]">
                    <div className="flex items-center gap-1.5 font-extrabold text-blue-900">
                      <Icon name="calculate" sizePx={14} className="text-blue-700" />
                      <span>Live Calculated Rules</span>
                    </div>
                    <div className="mt-1 space-y-0.5 text-[10.5px] font-semibold text-blue-800">
                      {updateWholesalePrice ? (
                        <div className="flex items-center justify-between">
                          <span>Wholesale Rule:</span>
                          <strong className="text-blue-900 font-extrabold">Rate {priceChangeDirection === "INCREASE" ? "+" : "−"} {wholesaleMarginPercent}%</strong>
                        </div>
                      ) : null}
                      {updateRetailPrice ? (
                        <div className="flex items-center justify-between text-purple-900">
                          <span>Retail Rule:</span>
                          <strong className="text-purple-950 font-extrabold">Rate {priceChangeDirection === "INCREASE" ? "+" : "−"} {retailMarginPercent}%</strong>
                        </div>
                      ) : null}
                    </div>
                  </section>

                  {/* Mobile Shortcut to Review Target Items */}
                  <button
                    type="button"
                    onClick={() => setMobileStep1Tab("products")}
                    className="xl:hidden w-full mt-0.5 inline-flex h-8.5 items-center justify-center gap-1.5 rounded-[8px] border border-blue-200 bg-blue-50 text-[11.5px] font-bold text-blue-800 hover:bg-blue-100 touch-manipulation transition"
                  >
                    <Icon name="checklist" sizePx={15} />
                    <span>Review target products ({isFilteredSelection ? selectedCount : priceMarginTargetCount}) →</span>
                  </button>
                </div>

                {/* Right Column: Target Products Checklist */}
                <div className={`${compactBulkPriceFlow ? "min-h-0" : "min-h-0 xl:flex-1"} ${mobileStep1Tab === "products" ? `flex flex-col ${compactBulkPriceFlow ? "" : "xl:h-full"}` : `hidden xl:flex xl:flex-col ${compactBulkPriceFlow ? "" : "xl:h-full"}`}`}>
                  <section className={`flex flex-col rounded-[12px] border border-[#E5E7EB] bg-white overflow-hidden min-h-0 ${compactBulkPriceFlow ? "" : "xl:h-full"}`}>
                    <div className="border-b border-[#E5E7EB] px-3 py-2 bg-[#F8FAFC] shrink-0 space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <h4 className="text-[12px] font-extrabold text-[#11120d] truncate">
                            Target Products <span className="text-blue-700 font-black">({isFilteredSelection ? selectedCount.toLocaleString() : priceMarginTargetCount.toLocaleString()})</span>
                          </h4>
                          {isFilteredSelection ? (
                            <span className="rounded-full border border-blue-200 bg-blue-50 px-1.5 py-0.2 text-[8.5px] font-extrabold text-blue-700 shrink-0">
                              Catalog scope
                            </span>
                          ) : null}
                        </div>
                        <div className="flex w-full items-center gap-2 sm:w-auto">
                          <button
                            type="button"
                            disabled={isFilteredSelection ? filteredExcludedIds.length === 0 : visibleBulkPriceProducts.length === 0}
                            onClick={() => {
                              if (isFilteredSelection) {
                                setFilteredSelectionExclusions({});
                              } else {
                                setVisiblePriceMarginTargets(true);
                              }
                              setBulkPriceNotice(null);
                              setBulkPriceTouched(true);
                            }}
                            className="inline-flex min-h-11 flex-1 items-center justify-center whitespace-nowrap rounded-[7px] border border-[#CBD5E1] bg-white px-2.5 text-[12px] font-bold text-[#11120d] hover:bg-slate-50 touch-manipulation disabled:cursor-default disabled:opacity-55 sm:flex-none"
                            aria-label={isFilteredSelection ? filteredExcludedIds.length === 0 ? `All ${total.toLocaleString()} matching products included` : `Include all ${total.toLocaleString()} matching products` : `Select ${visibleBulkPriceProducts.length} ${priceSearch ? "matching" : "visible"} products`}
                          >
                            {isFilteredSelection ? filteredExcludedIds.length === 0 ? "All included" : "Include all" : `Select ${visibleBulkPriceProducts.length}`}
                          </button>
                          <button
                            type="button"
                            disabled={isFilteredSelection ? step1Items.length === 0 : visibleBulkPriceProducts.length === 0}
                            onClick={() => {
                              if (isFilteredSelection) {
                                const next: Record<string, { id: string; name: string; sku: string }> = { ...filteredSelectionExclusions };
                                step1Items.forEach((p) => { next[p.id] = { id: p.id, name: p.name, sku: p.sku || "" }; });
                                setFilteredSelectionExclusions(next);
                              } else {
                                setVisiblePriceMarginTargets(false);
                              }
                              setBulkPriceNotice(null);
                              setBulkPriceTouched(true);
                            }}
                            className="inline-flex min-h-11 flex-1 items-center justify-center whitespace-nowrap rounded-[7px] border border-[#CBD5E1] bg-white px-2.5 text-[12px] font-bold text-[#565449] hover:bg-slate-50 touch-manipulation disabled:cursor-default disabled:opacity-55 sm:flex-none"
                            aria-label={isFilteredSelection ? `Exclude ${step1Items.length} products shown on this page` : `Clear ${visibleBulkPriceProducts.length} ${priceSearch ? "matching" : "visible"} products`}
                          >
                            {isFilteredSelection ? "Exclude shown" : `Clear ${visibleBulkPriceProducts.length}`}
                          </button>
                        </div>
                      </div>

                      {/* Search Bar + Sort Button Row */}
                      <div className="flex items-center gap-2">
                        <div className="relative flex-1 flex items-center h-10 rounded-[9px] border border-[#CFCFD3] bg-white px-3 transition focus-within:border-blue-600 focus-within:ring-1 focus-within:ring-blue-600">
                          <Icon name="search" sizePx={18} className="text-[#8C8889] shrink-0" />
                          <input
                            value={priceSearch}
                            onChange={(event) => setPriceSearch(event.target.value)}
                            placeholder="Search name, SKU, brand…"
                            className="w-full bg-transparent pl-2.5 pr-2 text-[13px] font-semibold text-[#11120d] outline-none placeholder-[#8C8889]"
                          />
                          {priceSearch ? (
                            <button
                              type="button"
                              onClick={() => setPriceSearch("")}
                              className="!min-h-0 !min-w-0 p-1 text-[#8C8889] hover:text-[#11120d]"
                              aria-label="Clear search"
                            >
                              <Icon name="close" sizePx={14} />
                            </button>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          onClick={() => setOpenBulkPriceSortModal(true)}
                          className={`inline-flex h-10 !min-h-0 items-center justify-center gap-1.5 rounded-[9px] border px-3 text-[12px] font-bold transition shrink-0 ${
                            bulkPriceSort !== "affected_first"
                              ? "border-blue-200 bg-blue-50 text-blue-700"
                              : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-slate-50"
                          }`}
                          aria-label="Sort products"
                          title="Sort products"
                        >
                          <Icon name="swap_vert" sizePx={16} />
                          <span className="hidden sm:inline">Sort</span>
                          {bulkPriceSort !== "affected_first" ? (
                            <span className="flex h-2 w-2 rounded-full bg-blue-600" />
                          ) : null}
                        </button>
                      </div>
                    </div>

                    {/* Scrollable Checklist */}
                    <div className={`divide-y divide-[#E5E7EB] bg-white ${compactBulkPriceFlow ? "xl:max-h-[380px] xl:overflow-y-auto" : "min-h-0 xl:flex-1 xl:overflow-y-auto"}`}>
                      {priceBusy && paginatedStep1Items.length === 0 ? (
                        <div className="flex h-48 flex-col items-center justify-center gap-2 text-[12px] font-semibold text-[#8C8889]">
                          <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
                          <span>Loading catalog products…</span>
                        </div>
                      ) : (
                        paginatedStep1Items.map((product) => {
                          const isChecked = isFilteredSelection
                            ? !filteredExcludedIds.includes(product.id)
                            : Boolean(priceMarginTargetIds[product.id]);
                          const isComingSoon = product.availabilityStatus === "COMING_SOON";
                          const hasNoRate = !(Number(product.ratePerPiece) > 0);
                          const rate = Number(product.ratePerPiece || 0);
                          const calculatedWholesale = rate > 0 && updateWholesalePrice && priceMarginsValid
                            ? priceFromPercentageChange(rate, wholesaleMarginPercent, priceChangeDirection)
                            : null;
                          const calculatedRetail = rate > 0 && updateRetailPrice && priceMarginsValid
                            ? priceFromPercentageChange(rate, retailMarginPercent, priceChangeDirection)
                            : null;

                          return (
                            <label
                              key={product.id}
                              className={`flex min-h-[48px] cursor-pointer items-center justify-between gap-2.5 px-3 py-3 hover:bg-[#F8FAFC] transition touch-manipulation select-none ${
                                isChecked ? "bg-slate-50/50" : "opacity-60 bg-rose-50/20"
                              }`}
                            >
                              <div className="flex items-center gap-2.5 min-w-0 flex-1">
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => {
                                    if (isFilteredSelection) {
                                      if (isChecked) {
                                        setFilteredSelectionExclusions((curr) => ({
                                          ...curr,
                                          [product.id]: { id: product.id, name: product.name, sku: product.sku || "" },
                                        }));
                                      } else {
                                        setFilteredSelectionExclusions((curr) => {
                                          const next = { ...curr };
                                          delete next[product.id];
                                          return next;
                                        });
                                      }
                                    } else {
                                      setPriceMarginTargetIds((current) => ({ ...current, [product.id]: !current[product.id] }));
                                    }
                                    setBulkPriceNotice(null);
                                    setBulkPriceTouched(true);
                                  }}
                                  className="h-4.5 w-4.5 rounded-[4px] border-[#CFCFD3] accent-[#11120d] shrink-0 cursor-pointer"
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="truncate text-[13px] font-extrabold text-[#11120d]">{product.name}</span>
                                    {isComingSoon ? (
                                      <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.2 text-[8.5px] font-extrabold text-amber-800">Coming soon</span>
                                    ) : hasNoRate ? (
                                      <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.2 text-[8.5px] font-extrabold text-amber-800">No Rate</span>
                                    ) : null}
                                  </div>
                                  <div className="text-[10px] text-[#8C8889] truncate">
                                    SKU: {product.sku || "None"}{product.brand ? ` · ${product.brand}` : ""}
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center gap-3 shrink-0 text-right">
                                <div className="text-[12.5px] font-bold text-[#565449]">
                                  <span className="text-[10px] text-[#8C8889] block">Rate</span>
                                  <span className="tabular-nums text-[#11120d]">{product.ratePerPiece ? `NPR ${product.ratePerPiece}` : "None"}</span>
                                </div>
                                <div className="text-[12.5px] font-bold text-blue-700">
                                  <span className="text-[10px] text-[#8C8889] block">Wholesale</span>
                                  <span className="tabular-nums">
                                    {calculatedWholesale && isChecked ? (
                                      <strong className="font-extrabold text-blue-700">NPR {calculatedWholesale}</strong>
                                    ) : product.wholesalePrice ? (
                                      `NPR ${product.wholesalePrice}`
                                    ) : (
                                      "None"
                                    )}
                                  </span>
                                </div>
                                <div className="text-[12.5px] font-bold text-purple-700">
                                  <span className="text-[10px] text-[#8C8889] block">Retail</span>
                                  <span className="tabular-nums">
                                    {calculatedRetail && isChecked ? (
                                      <strong className="font-extrabold text-purple-700">NPR {calculatedRetail}</strong>
                                    ) : product.retailPrice ? (
                                      `NPR ${product.retailPrice}`
                                    ) : (
                                      "None"
                                    )}
                                  </span>
                                </div>
                              </div>
                            </label>
                          );
                        })
                      )}
                      {isFilteredSelection && !filteredPreviewLoaded ? (
                        <div role="status" className="p-6 text-center text-[13px] font-semibold text-slate-600">
                          {bulkPriceNotice?.tone === "danger" ? (
                            <>
                              <p>Matching products could not be loaded.</p>
                              <button type="button" disabled={priceBusy} onClick={() => {
                                setPriceBusy(true);
                                void loadFilteredPricePreview(1, priceSearch, BULK_PRICE_STEP1_PAGE_SIZE)
                                  .then(() => setBulkPriceNotice(null))
                                  .catch((error: any) => setBulkPriceNotice({ tone: "danger", message: error?.response?.data?.error || error?.message || "Products could not be loaded." }))
                                  .finally(() => setPriceBusy(false));
                              }} className="mt-3 min-h-10 rounded-lg border border-slate-300 bg-white px-4 text-sm font-bold text-slate-900 disabled:opacity-50">Retry loading</button>
                            </>
                          ) : "Loading matching products…"}
                        </div>
                      ) : !priceBusy && paginatedStep1Items.length === 0 ? (
                        <div className="p-6 text-center text-[12px] font-semibold text-[#8C8889]">
                          No products match this search.
                        </div>
                      ) : null}

                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#E5E7EB] bg-[#F8FAFC] px-3 py-2 text-[12px] font-semibold text-[#565449]">
                      <span>
                        Showing <strong className="text-[#11120d]">{step1TotalCount === 0 || (isFilteredSelection && !filteredPreviewLoaded) ? 0 : (activeStep1Page - 1) * BULK_PRICE_STEP1_PAGE_SIZE + 1}–{isFilteredSelection && !filteredPreviewLoaded ? 0 : Math.min(step1TotalCount, activeStep1Page * BULK_PRICE_STEP1_PAGE_SIZE)}</strong> of <strong className="text-[#11120d]">{step1TotalCount.toLocaleString()}</strong>
                      </span>
                      {step1TotalPages > 1 && (!isFilteredSelection || filteredPreviewLoaded) ? (
                        <div className="flex items-center gap-1.5">
                          <span className="text-[12px] font-bold text-[#565449] tabular-nums">
                            Page {activeStep1Page} of {step1TotalPages}
                          </span>
                          <button
                            type="button"
                            disabled={activeStep1Page <= 1 || priceBusy}
                            onClick={() => {
                              const prev = Math.max(1, activeStep1Page - 1);
                              if (isFilteredSelection) {
                                setPriceBusy(true);
                                void loadFilteredPricePreview(prev, priceSearch, BULK_PRICE_STEP1_PAGE_SIZE)
                                  .then(() => setBulkPriceStep1Page(prev))
                                  .finally(() => setPriceBusy(false));
                              } else {
                                setBulkPriceStep1Page(prev);
                              }
                            }}
                            className="inline-flex h-10 w-10 items-center justify-center rounded-[7px] border border-[#D8DBE0] bg-white text-[#11120d] transition hover:bg-slate-50 disabled:opacity-30 disabled:pointer-events-none touch-manipulation"
                            aria-label="Previous page"
                          >
                            <Icon name="chevron_left" sizePx={20} />
                          </button>
                          <button
                            type="button"
                            disabled={activeStep1Page >= step1TotalPages || priceBusy}
                            onClick={() => {
                              const next = Math.min(step1TotalPages, activeStep1Page + 1);
                              if (isFilteredSelection) {
                                setPriceBusy(true);
                                void loadFilteredPricePreview(next, priceSearch, BULK_PRICE_STEP1_PAGE_SIZE)
                                  .then(() => setBulkPriceStep1Page(next))
                                  .finally(() => setPriceBusy(false));
                              } else {
                                setBulkPriceStep1Page(next);
                              }
                            }}
                            className="inline-flex h-10 w-10 items-center justify-center rounded-[7px] border border-[#D8DBE0] bg-white text-[#11120d] transition hover:bg-slate-50 disabled:opacity-30 disabled:pointer-events-none touch-manipulation"
                            aria-label="Next page"
                          >
                            <Icon name="chevron_right" sizePx={20} />
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </section>
                </div>
              </div>
            )
          ) : null}

          {/* STEP 2: PREVIEW & EDIT VIEW */}
          {pricePreviewReady && !confirmBulkPriceSave ? (
            <div className={`flex flex-col gap-2 max-lg:shrink-0 ${compactBulkPriceFlow ? "shrink-0" : "lg:flex-1 lg:min-h-0"}`}>
              {isFilteredSelection && invalidFilteredOverrideId && filteredPriceOverrides[invalidFilteredOverrideId] ? (
                <section className="shrink-0 rounded-[10px] border border-rose-300 bg-rose-50 p-3" aria-label="Price needing correction">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h4 className="text-sm font-bold text-rose-900">Correct this price before review</h4>
                      <p className="text-xs text-rose-800">{selectedProductCache[invalidFilteredOverrideId]?.name || filteredPreviewItems.find((item) => item.productId === invalidFilteredOverrideId)?.name || `Product ${invalidFilteredOverrideId}`}</p>
                    </div>
                    <button type="button" onClick={() => useCalculatedPriceForFilteredItem(invalidFilteredOverrideId)} className="min-h-10 rounded-md border border-rose-300 bg-white px-3 text-xs font-bold text-rose-900">Use rule instead</button>
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    {([['ratePerPiece', 'Rate'], ['wholesalePrice', 'Wholesale'], ['retailPrice', 'Retail']] as const).map(([field, label]) => bulkPriceErrors.rows?.[invalidFilteredOverrideId]?.[field] ? (
                      <label key={field} className="block text-xs font-bold text-rose-900">
                        {label}
                        <input type="number" min="0.01" step="0.01" inputMode="decimal" value={filteredPriceOverrides[invalidFilteredOverrideId][field]} onChange={(event) => updateFilteredPriceOverride(invalidFilteredOverrideId, field, event.target.value)} data-price-field={`${invalidFilteredOverrideId}-${field}`} aria-invalid="true" className="mt-1 h-11 w-full rounded-md border border-rose-400 bg-white px-3 text-base tabular-nums text-slate-900" />
                        <span className="mt-1 block font-medium">{bulkPriceErrors.rows[invalidFilteredOverrideId]?.[field]}</span>
                      </label>
                    ) : null)}
                  </div>
                </section>
              ) : null}
              {/* DESKTOP VIEW (lg:flex) */}
              <div className={`hidden lg:flex flex-col gap-2 ${compactBulkPriceFlow ? "shrink-0" : "flex-1 min-h-0"}`}>
                {isFilteredSelection ? (
                  /* Desktop Filtered Selection Preview Table Card */
                  <div className={`flex flex-col rounded-[12px] border border-[#E5E7EB] bg-white overflow-hidden ${compactBulkPriceFlow ? "shrink-0" : "flex-1 min-h-0"}`}>
                    <div className="flex flex-col gap-1.5 border-b border-[#E5E7EB] px-3 py-1.5 bg-[#F8FAFC] sm:flex-row sm:items-center sm:justify-between shrink-0">
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="text-[12.5px] font-extrabold text-[#11120d]">Scope Preview ({filteredPreviewStats.previewMatchedCount.toLocaleString()} items)</h4>
                          <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.2 text-[9.5px] font-extrabold text-blue-700">
                            Page {activeStep2FilteredPage} of {step2FilteredTotalPages}
                          </span>
                        </div>
                      </div>
                      <div className="flex w-full items-center gap-1.5 sm:w-auto">
                        <div className="relative flex-1 sm:w-[180px]">
                          <Icon name="search" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[14px] text-[#8C8889]" />
                          <input
                            value={priceSearch}
                            onChange={(event) => setPriceSearch(event.target.value)}
                            placeholder="Filter preview…"
                            className="h-7.5 w-full rounded-[7px] border border-[#CFCFD3] bg-white pl-7.5 pr-2 text-[11px] font-semibold outline-none focus:border-blue-600"
                          />
                        </div>
                        {/* Sort Button Desktop */}
                        <button
                          type="button"
                          onClick={() => setOpenBulkPriceSortModal(true)}
                          className={`inline-flex h-7.5 items-center justify-center gap-1 rounded-[7px] border px-2.5 text-[11px] font-bold transition shrink-0 ${
                            bulkPriceSort !== "affected_first"
                              ? "border-blue-200 bg-blue-50 text-blue-700"
                              : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-slate-50"
                          }`}
                          title="Sort preview"
                        >
                          <Icon name="swap_vert" sizePx={14} />
                          <span>Sort</span>
                          {bulkPriceSort !== "affected_first" ? <span className="h-1.5 w-1.5 rounded-full bg-blue-600" /> : null}
                        </button>

                      </div>
                    </div>

                    <div className="relative flex-1 min-h-0 overflow-y-auto">
                      <table className="w-full text-[12.5px]">
                        <thead className="bg-[#F8FAFC] sticky top-0 z-10 border-b border-[#E5E7EB]">
                          <tr className="text-[11px] font-extrabold uppercase tracking-wide text-[#8C8889]">
                            {/* Product Name First! */}
                            <th className="text-left py-2 px-3 font-bold min-w-[200px]">Product Name</th>
                            <th className="text-center py-2 px-2.5 font-bold">Rate</th>
                            <th className="text-center py-2 px-2.5 font-bold">Current Wholesale</th>
                            <th className="text-center py-2 px-2.5 font-bold border-r border-[#E5E7EB]">Current Retail</th>
                            <th className="text-center py-2 px-2.5 font-bold text-blue-700">New Rate</th>
                            <th className="text-center py-2 px-2.5 font-bold text-blue-700">New Wholesale</th>
                            <th className="text-center py-2 px-2.5 font-bold text-purple-700">New Retail</th>
                            {/* Action Last! */}
                            <th className="w-[124px] px-2 py-2 text-center font-bold">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#E5E7EB]">
                          {paginatedFilteredPreviewItems.map((item) => {
                            const isOverridden = Boolean(filteredPriceOverrides[item.productId]);
                            const hasChange = item.newWholesalePrice !== null || item.newRetailPrice !== null;
                            return (
                              <tr key={item.productId} className="transition-colors hover:bg-[#F8FAFC]">
                                {/* 1. Product Name */}
                                <td className="py-1.5 px-3">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="font-extrabold text-[#11120d]">{item.name}</span>
                                    {isOverridden ? (
                                      <span className="rounded-full border border-blue-200 bg-blue-50 px-1.5 py-0.2 text-[8.5px] font-extrabold text-blue-700">Custom override</span>
                                    ) : hasChange ? (
                                      <span className="rounded-full border border-blue-200 bg-blue-50 px-1.5 py-0.2 text-[8.5px] font-extrabold text-blue-700">Will change</span>
                                    ) : (
                                      <span className="rounded-full border border-slate-200 bg-slate-50 px-1.5 py-0.2 text-[8.5px] font-extrabold text-slate-600">Kept</span>
                                    )}
                                  </div>
                                  <div className="text-[10px] text-[#8C8889]">SKU: {item.sku || "-"}</div>
                                </td>
                                {/* 2. Rate */}
                                <td className="py-1.5 px-2.5 text-center font-bold tabular-nums text-[#565449] bg-slate-50/40">
                                  {item.rate ? `NPR ${item.rate}` : "None"}
                                </td>
                                {/* 3. Current Wholesale */}
                                <td className="py-1.5 px-2.5 text-center font-bold tabular-nums text-[#565449] bg-slate-50/40">
                                  {item.currentWholesalePrice ? `NPR ${item.currentWholesalePrice}` : "None"}
                                </td>
                                {/* 4. Current Retail */}
                                <td className="py-1.5 px-2.5 text-center font-bold tabular-nums text-[#565449] bg-slate-50/40 border-r border-[#E5E7EB]">
                                  {item.currentRetailPrice ? `NPR ${item.currentRetailPrice}` : "None"}
                                </td>
                                {/* 5. New Rate */}
                                <td className="w-[115px] py-1.5 px-2 text-center">
                                  {isOverridden ? (
                                    <input
                                      type="number"
                                      min="0.01"
                                      step="0.01"
                                      inputMode="decimal"
                                      value={filteredPriceOverrides[item.productId]?.ratePerPiece ?? ""}
                                      data-price-field={`${item.productId}-ratePerPiece`}
                                      aria-label={`New Rate for ${item.name}`}
                                      onChange={(e) => updateFilteredPriceOverride(item.productId, "ratePerPiece", e.target.value)}
                                      className="h-7.5 w-full rounded-[6px] border border-blue-300 bg-blue-50/50 px-2 text-center text-[11.5px] font-bold tabular-nums outline-none focus:border-blue-600"
                                    />
                                  ) : (
                                    <span className="text-[11.5px] font-bold tabular-nums text-[#565449]">Unchanged</span>
                                  )}
                                </td>
                                {/* 6. New Wholesale */}
                                <td className="py-1.5 px-2.5 text-center">
                                  {isOverridden ? (
                                    <input
                                      type="number"
                                      min="0.01"
                                      step="0.01"
                                      inputMode="decimal"
                                      value={filteredPriceOverrides[item.productId]?.wholesalePrice ?? ""}
                                      data-price-field={`${item.productId}-wholesalePrice`}
                                      aria-label={`New wholesale price for ${item.name}`}
                                      onChange={(e) => updateFilteredPriceOverride(item.productId, "wholesalePrice", e.target.value)}
                                      className="h-8 w-[120px] rounded-[6px] border border-blue-300 bg-blue-50/50 px-2 text-center text-[13px] font-bold tabular-nums outline-none focus:border-blue-600"
                                    />
                                  ) : item.newWholesalePrice !== null ? (
                                    <span className="inline-block rounded-[5px] border border-blue-200 bg-blue-50 px-2 py-0.5 text-[13px] font-extrabold text-blue-800 tabular-nums">
                                      NPR {item.newWholesalePrice}
                                    </span>
                                  ) : (
                                    <span className="text-[10.5px] font-bold text-[#6B7280]">Kept</span>
                                  )}
                                </td>
                                {/* 7. New Retail */}
                                <td className="py-1.5 px-2.5 text-center">
                                  {isOverridden ? (
                                    <input
                                      type="number"
                                      min="0.01"
                                      step="0.01"
                                      inputMode="decimal"
                                      value={filteredPriceOverrides[item.productId]?.retailPrice ?? ""}
                                      data-price-field={`${item.productId}-retailPrice`}
                                      aria-label={`New retail price for ${item.name}`}
                                      onChange={(e) => updateFilteredPriceOverride(item.productId, "retailPrice", e.target.value)}
                                      className="h-8 w-[120px] rounded-[6px] border border-purple-300 bg-purple-50/50 px-2 text-center text-[13px] font-bold tabular-nums outline-none focus:border-purple-600"
                                    />
                                  ) : item.newRetailPrice !== null ? (
                                    <span className="inline-block rounded-[5px] border border-purple-200 bg-purple-50 px-2 py-0.5 text-[13px] font-extrabold text-purple-800 tabular-nums">
                                      NPR {item.newRetailPrice}
                                    </span>
                                  ) : (
                                    <span className="text-[10.5px] font-bold text-[#6B7280]">Kept</span>
                                  )}
                                </td>
                                {/* 8. Action Column Last! */}
                                <td className="px-2 py-1.5 text-center">
                                  <div className="flex items-center justify-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() => isOverridden ? useCalculatedPriceForFilteredItem(item.productId) : editFilteredPreviewItem(item)}
                                      className={`inline-flex h-7 items-center justify-center rounded-[6px] border px-2 text-[10px] font-bold ${
                                        isOverridden ? "border-blue-200 bg-blue-50 text-blue-700" : "border-[#CFCFD3] bg-white text-[#11120d] hover:bg-slate-50"
                                      }`}
                                    >
                                      {isOverridden ? "Use rule" : "Adjust"}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => excludeFilteredPreviewItem(item)}
                                      className="inline-flex h-7 items-center justify-center rounded-[6px] border border-rose-200 bg-white px-2 text-[10px] font-bold text-rose-700 hover:bg-rose-50"
                                    >
                                      Exclude
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>

                      {/* Pagination Footer (now scrolls with content) */}
                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#E5E7EB] bg-[#F8FAFC] px-3 py-2 text-[12px] font-medium text-[#565449]">
                      <div className="flex items-center gap-2.5">
                        <span>
                          Showing <strong className="text-[#11120d] font-bold">{(activeStep2FilteredPage - 1) * bulkPriceStep2PageSize + 1}–{Math.min(filteredPreviewStats.previewMatchedCount, activeStep2FilteredPage * bulkPriceStep2PageSize)}</strong> of <strong className="text-[#11120d] font-bold">{filteredPreviewStats.previewMatchedCount.toLocaleString()}</strong>
                        </span>
                        <label className="flex items-center gap-1.5 text-[12px] font-semibold text-[#565449]">
                          <span>Rows:</span>
                          <div className="w-auto">
                            <ProjectSelect
                              value={bulkPriceStep2PageSize}
                              onChange={(e) => {
                                const newSize = Number(e.target.value);
                                setBulkPriceStep2PageSize(newSize);
                                setBulkPriceStep2Page(1);
                                setPriceBusy(true);
                                void loadFilteredPricePreview(1, priceSearch, newSize).finally(() => setPriceBusy(false));
                              }}
                              className="h-10 rounded-[7px] border border-[#CFCFD3] bg-white px-2 text-[12px] font-bold text-[#11120d] outline-none"
                            >
                              <option value={10}>10</option>
                              <option value={25}>25</option>
                              <option value={50}>50</option>
                              <option value={100}>100</option>
                            </ProjectSelect>
                          </div>
                        </label>
                      </div>
                      {step2FilteredTotalPages > 1 ? (
                        <div className="flex items-center gap-1.5">
                          <span className="text-[12px] font-bold text-[#565449]">
                            Page <span className="text-[#11120d]">{activeStep2FilteredPage}</span> of {step2FilteredTotalPages}
                          </span>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              disabled={activeStep2FilteredPage <= 1}
                              onClick={() => {
                                setPriceBusy(true);
                                void loadFilteredPricePreview(activeStep2FilteredPage - 1).finally(() => setPriceBusy(false));
                              }}
                              className="inline-flex h-10 items-center gap-1 rounded-[6px] border border-[#D8DBE0] bg-white px-3 text-[12px] font-bold text-[#11120d] transition hover:bg-slate-50 disabled:opacity-35 disabled:pointer-events-none touch-manipulation"
                              aria-label="Previous preview page"
                            >
                              <Icon name="chevron_left" sizePx={13} />
                              <span>Prev</span>
                            </button>
                            <button
                              type="button"
                              disabled={activeStep2FilteredPage >= step2FilteredTotalPages}
                              onClick={() => {
                                setPriceBusy(true);
                                void loadFilteredPricePreview(activeStep2FilteredPage + 1).finally(() => setPriceBusy(false));
                              }}
                              className="inline-flex h-10 items-center gap-1 rounded-[6px] border border-[#D8DBE0] bg-white px-3 text-[12px] font-bold text-[#11120d] transition hover:bg-slate-50 disabled:opacity-35 disabled:pointer-events-none touch-manipulation"
                              aria-label="Next preview page"
                            >
                              <span>Next</span>
                              <Icon name="chevron_right" sizePx={13} />
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                    </div>
                  </div>
                ) : (
                  /* Desktop Explicit Selection Preview Table Card */
                  <div className={`flex flex-col rounded-[12px] border border-[#E5E7EB] bg-white overflow-hidden ${compactBulkPriceFlow ? "shrink-0" : "flex-1 min-h-0"}`}>
                    <div className="flex flex-col gap-1.5 border-b border-[#E5E7EB] px-3 py-1.5 bg-[#F8FAFC] sm:flex-row sm:items-center sm:justify-between shrink-0">
                      <div className="flex flex-col gap-2 w-full sm:w-auto">
                        <div className="flex items-center gap-2">
                          <h4 className="text-[12.5px] font-extrabold text-[#11120d]">Products in scope ({visibleBulkPriceProducts.length.toLocaleString()})</h4>
                          {Object.values(priceMarginTargetIds).filter((v) => !v).length > 0 ? (
                            <span className="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.2 text-[9.5px] font-extrabold text-rose-700">
                              {Object.values(priceMarginTargetIds).filter((v) => !v).length} excluded
                            </span>
                          ) : null}
                        </div>

                        <div className="flex items-center rounded-lg bg-[#E2E8F0] p-0.5 w-full sm:w-auto self-start" role="group" aria-label="Preview products">
                          <button
                            type="button"
                            onClick={() => { setBulkPricePreviewFilter("ALL"); setBulkPriceStep2Page(1); }}
                            aria-pressed={bulkPricePreviewFilter === "ALL"}
                            className={`flex-1 sm:flex-none min-h-10 whitespace-nowrap px-3 text-[12px] font-bold rounded-md transition ${bulkPricePreviewFilter === "ALL" ? "bg-white shadow-sm text-[#11120d]" : "text-[#64748B] hover:text-[#0F172A]"}`}
                          >
                            All
                          </button>
                          <button
                            type="button"
                            onClick={() => { setBulkPricePreviewFilter("READY"); setBulkPriceStep2Page(1); }}
                            aria-pressed={bulkPricePreviewFilter === "READY"}
                            className={`flex-1 sm:flex-none min-h-10 whitespace-nowrap px-3 text-[12px] font-bold rounded-md transition flex items-center justify-center gap-1 ${bulkPricePreviewFilter === "READY" ? "bg-white shadow-sm text-emerald-700" : "text-[#64748B] hover:text-emerald-700"}`}
                          >
                            <span className="w-1 h-1 rounded-full bg-emerald-500"></span>
                            {bulkPriceMode === "MANUAL" ? "Included" : "Ready"}
                          </button>
                          <button
                            type="button"
                            onClick={() => { setBulkPricePreviewFilter("PRESERVED"); setBulkPriceStep2Page(1); }}
                            aria-pressed={bulkPricePreviewFilter === "PRESERVED"}
                            className={`flex-1 sm:flex-none min-h-10 whitespace-nowrap px-3 text-[12px] font-bold rounded-md transition ${bulkPricePreviewFilter === "PRESERVED" ? "bg-white shadow-sm text-[#11120d]" : "text-[#64748B] hover:text-[#0F172A]"}`}
                          >
                            Excluded
                          </button>
                        </div>
                      </div>
                      <div className="flex w-full items-center gap-1.5 sm:w-auto">
                        <div className="relative flex-1 sm:w-[180px]">
                          <Icon name="search" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[14px] text-[#8C8889]" />
                          <input
                            value={priceSearch}
                            onChange={(event) => setPriceSearch(event.target.value)}
                            placeholder="Filter preview…"
                            className="h-7.5 w-full rounded-[7px] border border-[#CFCFD3] bg-white pl-7.5 pr-2 text-[11px] font-semibold outline-none focus:border-blue-600"
                          />
                        </div>
                        {/* Sort Button Desktop */}
                        <button
                          type="button"
                          onClick={() => setOpenBulkPriceSortModal(true)}
                          className={`inline-flex h-7.5 items-center justify-center gap-1 rounded-[7px] border px-2.5 text-[11px] font-bold transition shrink-0 ${
                            bulkPriceSort !== "affected_first"
                              ? "border-blue-200 bg-blue-50 text-blue-700"
                              : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-slate-50"
                          }`}
                          title="Sort preview"
                        >
                          <Icon name="swap_vert" sizePx={14} />
                          <span>Sort</span>
                          {bulkPriceSort !== "affected_first" ? <span className="h-1.5 w-1.5 rounded-full bg-blue-600" /> : null}
                        </button>

                      </div>
                    </div>

                    <div className={`relative overflow-y-auto ${compactBulkPriceFlow ? "max-h-[min(42dvh,420px)]" : "flex-1 min-h-0"}`}>
                      <table className="w-full text-[12.5px]">
                        <thead className="bg-[#F8FAFC] sticky top-0 z-10 border-b border-[#E5E7EB]">
                          <tr className="text-[11px] font-extrabold uppercase tracking-wide text-[#8C8889]">
                            {/* Product Name First! */}
                            <th className="text-left py-2 px-3 font-bold min-w-[200px]">Product Name</th>
                            <th className="text-center py-2 px-2.5 font-bold">Rate</th>
                            <th className="text-center py-2 px-2.5 font-bold">Current Wholesale</th>
                            <th className="text-center py-2 px-2.5 font-bold border-r border-[#E5E7EB]">Current Retail</th>
                            <th className="text-center py-2 px-2.5 font-bold text-blue-700">New Rate</th>
                            <th className="text-center py-2 px-2.5 font-bold text-blue-700">New Wholesale</th>
                            <th className="text-center py-2 px-2.5 font-bold text-purple-700">New Retail</th>
                            {/* Action Last! */}
                            <th className="w-[124px] px-2 py-2 text-center font-bold">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#E5E7EB]">
                          {paginatedExplicitPreviewItems.map((product) => {
                            const row = priceRows[product.id] || {
                              retailPrice: product.retailPrice === null ? "" : String(product.retailPrice),
                              wholesalePrice: product.wholesalePrice === null ? "" : String(product.wholesalePrice),
                              ratePerPiece: product.ratePerPiece === null ? "" : String(product.ratePerPiece),
                            };
                            const isIncluded = priceMarginTargetIds[product.id] !== false;
                            const isAdjusted = Boolean(explicitAdjustedIds[product.id]);
                            const isComingSoon = product.availabilityStatus === "COMING_SOON";
                            const hasNoRate = !(Number(product.ratePerPiece) > 0);

                            const willChangeWholesale = updateWholesalePrice && (existingSellingPricePolicy === "REPLACE" || !(Number(product.wholesalePrice) > 0));
                            const willChangeRetail = updateRetailPrice && (existingSellingPricePolicy === "REPLACE" || !(Number(product.retailPrice) > 0));
                            const willChange = isIncluded && (bulkPriceMode === "MANUAL"
                              ? (["ratePerPiece", "wholesalePrice", "retailPrice"] as const).some((field) => row[field]?.trim() && Number(row[field]) !== Number(product[field]))
                              : !isComingSoon && !hasNoRate && (willChangeWholesale || willChangeRetail));

                            return (
                              <tr key={product.id} className={`transition-colors ${!isIncluded ? "bg-rose-50/40 opacity-70" : "hover:bg-[#F8FAFC]"}`}>
                                {/* 1. Product Name */}
                                <td className="py-1.5 px-3">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="font-extrabold text-[#11120d]">{product.name}</span>
                                    {!isIncluded ? (
                                      <span className="rounded-full border border-rose-200 bg-rose-50 px-1.5 py-0.2 text-[8.5px] font-extrabold text-rose-700">Excluded</span>
                                    ) : bulkPriceMode === "CALCULATE" && isComingSoon ? (
                                      <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.2 text-[8.5px] font-extrabold text-amber-800">Coming soon</span>
                                    ) : bulkPriceMode === "CALCULATE" && hasNoRate ? (
                                      <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.2 text-[8.5px] font-extrabold text-amber-800">No Rate</span>
                                    ) : isAdjusted ? (
                                      <span className="rounded-full border border-blue-200 bg-blue-50 px-1.5 py-0.2 text-[8.5px] font-extrabold text-blue-700">Adjusted</span>
                                    ) : willChange ? (
                                      <span className="rounded-full border border-blue-200 bg-blue-50 px-1.5 py-0.2 text-[8.5px] font-extrabold text-blue-700">Will change</span>
                                    ) : (
                                      <span className="rounded-full border border-slate-200 bg-slate-50 px-1.5 py-0.2 text-[8.5px] font-extrabold text-slate-600">Kept</span>
                                    )}
                                  </div>
                                  <div className="text-[10px] text-[#8C8889]">SKU: {product.sku || "-"}</div>
                                </td>
                                {/* 2. Rate */}
                                <td className="py-1.5 px-2.5 text-center font-bold tabular-nums text-[#565449] bg-slate-50/40">
                                  {product.ratePerPiece ? `NPR ${product.ratePerPiece}` : "None"}
                                </td>
                                {/* 3. Current Wholesale */}
                                <td className="py-1.5 px-2.5 text-center font-bold tabular-nums text-[#565449] bg-slate-50/40">
                                  {product.wholesalePrice ? `NPR ${product.wholesalePrice}` : "None"}
                                </td>
                                {/* 4. Current Retail */}
                                <td className="py-1.5 px-2.5 text-center font-bold tabular-nums text-[#565449] bg-slate-50/40 border-r border-[#E5E7EB]">
                                  {product.retailPrice ? `NPR ${product.retailPrice}` : "None"}
                                </td>
                                {/* 5. New Rate */}
                                <td className="w-[115px] py-1.5 px-2 text-center">
                                  {bulkPriceMode === "MANUAL" || isAdjusted ? (
                                    <input
                                      type="number"
                                      min="0.01"
                                      step="0.01"
                                      inputMode="decimal"
                                      disabled={!isIncluded}
                                      value={row.ratePerPiece}
                                      data-price-field={`${product.id}-ratePerPiece`}
                                      aria-label={`New Rate for ${product.name}`}
                                      onChange={(e) => {
                                        setPriceRows((c) => ({ ...c, [product.id]: { ...(c[product.id] || row), ratePerPiece: e.target.value } }));
                                        setBulkPriceTouched(true);
                                      }}
                                      className="h-7.5 w-full max-w-[84px] mx-auto rounded-[6px] border border-blue-300 bg-blue-50/50 px-2 text-center text-[12px] font-bold tabular-nums outline-none focus:border-blue-600 disabled:bg-gray-100 disabled:border-gray-200"
                                    />
                                  ) : (
                                    <span className="text-[11.5px] font-bold tabular-nums text-[#565449]">Unchanged</span>
                                  )}
                                </td>
                                {/* 6. New Wholesale */}
                                <td className="py-1.5 px-2.5 text-center">
                                  {bulkPriceMode === "MANUAL" || isAdjusted ? (
                                    <input
                                      type="number"
                                      min="0.01"
                                      step="0.01"
                                      inputMode="decimal"
                                      disabled={!isIncluded}
                                      value={row.wholesalePrice}
                                      data-price-field={`${product.id}-wholesalePrice`}
                                      aria-label={`New wholesale price for ${product.name}`}
                                      onChange={(e) => {
                                        setPriceRows((c) => ({ ...c, [product.id]: { ...(c[product.id] || row), wholesalePrice: e.target.value } }));
                                        setBulkPriceTouched(true);
                                      }}
                                      className="h-7.5 w-full max-w-[84px] mx-auto rounded-[6px] border border-blue-300 bg-blue-50/50 px-2 text-center text-[12px] font-bold tabular-nums outline-none focus:border-blue-600 disabled:bg-gray-100 disabled:border-gray-200"
                                    />
                                  ) : willChangeWholesale && isIncluded && !isComingSoon && !hasNoRate ? (
                                    <span className="inline-block rounded-[5px] border border-blue-200 bg-blue-50 px-2 py-0.5 text-[13px] font-extrabold text-blue-800 tabular-nums">
                                      NPR {row.wholesalePrice || "-"}
                                    </span>
                                  ) : (
                                    <span className="text-[10.5px] font-bold text-[#6B7280]">{!isIncluded ? "Excluded" : "Kept"}</span>
                                  )}
                                </td>
                                {/* 7. New Retail */}
                                <td className="py-1.5 px-2.5 text-center">
                                  {bulkPriceMode === "MANUAL" || isAdjusted ? (
                                    <input
                                      type="number"
                                      min="0.01"
                                      step="0.01"
                                      inputMode="decimal"
                                      disabled={!isIncluded}
                                      value={row.retailPrice}
                                      data-price-field={`${product.id}-retailPrice`}
                                      aria-label={`New retail price for ${product.name}`}
                                      onChange={(e) => {
                                        setPriceRows((c) => ({ ...c, [product.id]: { ...(c[product.id] || row), retailPrice: e.target.value } }));
                                        setBulkPriceTouched(true);
                                      }}
                                      className="h-7.5 w-full max-w-[84px] mx-auto rounded-[6px] border border-purple-300 bg-purple-50/50 px-2 text-center text-[12px] font-bold tabular-nums outline-none focus:border-purple-600 disabled:bg-gray-100 disabled:border-gray-200"
                                    />
                                  ) : willChangeRetail && isIncluded && !isComingSoon && !hasNoRate ? (
                                    <span className="inline-block rounded-[5px] border border-purple-200 bg-purple-50 px-2 py-0.5 text-[13px] font-extrabold text-purple-800 tabular-nums">
                                      NPR {row.retailPrice || "-"}
                                    </span>
                                  ) : (
                                    <span className="text-[10.5px] font-bold text-[#6B7280]">{!isIncluded ? "Excluded" : "Kept"}</span>
                                  )}
                                </td>
                                {/* 8. Action Column Last! */}
                                <td className="px-2 py-1.5 text-center">
                                  <div className="flex items-center justify-center gap-1">
                                    {bulkPriceMode === "CALCULATE" ? (
                                      <button
                                        type="button"
                                        disabled={!isIncluded || isComingSoon || hasNoRate}
                                        onClick={() => {
                                          setExplicitAdjustedIds((c) => ({ ...c, [product.id]: !c[product.id] }));
                                          setBulkPriceTouched(true);
                                        }}
                                        className={`inline-flex h-7 items-center justify-center rounded-[6px] border px-2 text-[10px] font-bold disabled:opacity-35 whitespace-nowrap ${
                                          isAdjusted ? "border-blue-200 bg-blue-50 text-blue-700" : "border-[#CFCFD3] bg-white text-[#11120d] hover:bg-slate-50"
                                        }`}
                                      >
                                        {isAdjusted ? "Use Rule" : "Adjust"}
                                      </button>
                                    ) : null}
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setPriceMarginTargetIds((current) => ({ ...current, [product.id]: !isIncluded }));
                                        setBulkPriceNotice(null);
                                        setBulkPriceTouched(true);
                                      }}
                                      className={`inline-flex h-7 items-center justify-center rounded-[6px] border px-2 text-[10px] font-bold ${
                                        !isIncluded
                                          ? "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                                          : "border-rose-200 bg-white text-rose-700 hover:bg-rose-50"
                                      }`}
                                      aria-label={`${!isIncluded ? "Include" : "Exclude"} ${product.name}`}
                                    >
                                      {!isIncluded ? "Include" : "Exclude"}
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>

                      {/* Pagination Footer (now scrolls with content) */}
                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#E5E7EB] bg-[#F8FAFC] px-3 py-2 text-[12px] font-medium text-[#565449]">
                      <div className="flex items-center gap-2.5">
                        <span>
                          Showing <strong className="text-[#11120d] font-bold">{explicitPreviewProducts.length === 0 ? 0 : (activeStep2ExplicitPage - 1) * bulkPriceStep2PageSize + 1}–{Math.min(explicitPreviewProducts.length, activeStep2ExplicitPage * bulkPriceStep2PageSize)}</strong> of <strong className="text-[#11120d] font-bold">{explicitPreviewProducts.length.toLocaleString()}</strong>
                        </span>
                        <label className="flex items-center gap-1.5 text-[12px] font-semibold text-[#565449]">
                          <span>Rows:</span>
                          <div className="w-auto">
                            <select
                              value={bulkPriceStep2PageSize}
                              onChange={(e) => {
                                setBulkPriceStep2PageSize(Number(e.target.value));
                                setBulkPriceStep2Page(1);
                              }}
                              className="h-10 w-[68px] rounded-[6px] border border-[#CFCFD3] bg-white px-2 text-[12px] font-bold text-[#11120d] outline-none"
                            >
                              <option value={10}>10</option>
                              <option value={25}>25</option>
                              <option value={50}>50</option>
                              <option value={100}>100</option>
                            </select>
                          </div>
                        </label>
                      </div>
                      {step2ExplicitTotalPages > 1 ? (
                        <div className="flex items-center gap-1.5">
                          <span className="text-[12px] font-bold text-[#565449]">
                            Page <span className="text-[#11120d]">{activeStep2ExplicitPage}</span> of {step2ExplicitTotalPages}
                          </span>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              disabled={activeStep2ExplicitPage <= 1}
                              onClick={() => setBulkPriceStep2Page((p) => Math.max(1, p - 1))}
                              className="inline-flex h-10 items-center gap-1 rounded-[6px] border border-[#D8DBE0] bg-white px-3 text-[12px] font-bold text-[#11120d] transition hover:bg-slate-50 disabled:opacity-35 disabled:pointer-events-none touch-manipulation"
                              aria-label="Previous preview page"
                            >
                              <Icon name="chevron_left" sizePx={13} />
                              <span>Prev</span>
                            </button>
                            <button
                              type="button"
                              disabled={activeStep2ExplicitPage >= step2ExplicitTotalPages}
                              onClick={() => setBulkPriceStep2Page((p) => Math.min(step2ExplicitTotalPages, p + 1))}
                              className="inline-flex h-10 items-center gap-1 rounded-[6px] border border-[#D8DBE0] bg-white px-3 text-[12px] font-bold text-[#11120d] transition hover:bg-slate-50 disabled:opacity-35 disabled:pointer-events-none touch-manipulation"
                              aria-label="Next preview page"
                            >
                              <span>Next</span>
                              <Icon name="chevron_right" sizePx={13} />
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                    </div>
                  </div>
                )}

                {/* Desktop Audit Reason Bar */}
                <div className="rounded-[10px] border border-[#E5E7EB] bg-[#F8FAFC] px-3 py-2 shrink-0">
                  <div className="flex items-center justify-between gap-1.5">
                    <label htmlFor="bulk-price-reason-combobox" className="text-[13px] font-extrabold text-[#11120d] flex items-center gap-1 shrink-0">
                      <Icon name="verified" sizePx={14} className="text-blue-600" />
                      Audit reason <span className="text-rose-600">*</span>
                      <span className="text-[10px] font-normal text-[#6B7280] hidden md:inline">— Required for compliance log</span>
                    </label>

                    <div className="w-full sm:max-w-[400px]">
                      <CreatableCombobox
                        compact
                        inputRef={priceReasonRef}
                        value={priceReason}
                        onChange={(val) => {
                          setPriceReason(val);
                          setBulkPriceTouched(true);
                          if (bulkPriceErrors.reason) setBulkPriceErrors((c) => ({ ...c, reason: undefined }));
                          if (bulkPriceNotice?.message?.includes("Enter a reason")) setBulkPriceNotice(null);
                        }}
                        options={[
                          "Supplier Rate changed",
                          "Market price changed",
                          "Seasonal price adjustment",
                          "Promotion ended",
                          "Correcting an entry mistake",
                          "Management-approved price review",
                        ]}
                        placeholder="Choose or type a reason..."
                        ariaLabel="Price update audit reason"
                        allowCreate
                        required
                        invalid={Boolean(bulkPriceErrors.reason)}
                      />
                    </div>
                  </div>
                  {bulkPriceErrors.reason ? (
                    <p className="mt-1 text-[10.5px] font-bold text-[#BE123C] flex items-center gap-1" role="alert">
                      <Icon name="error" sizePx={13} />
                      {bulkPriceErrors.reason}
                    </p>
                  ) : null}
                </div>
              </div>

              {/* MOBILE VIEW (lg:hidden): PROPER FINGER-FRIENDLY SCROLLABLE ARCHITECTURE */}
              <div className="flex shrink-0 flex-col gap-2 lg:hidden">
                {!isFilteredSelection ? (
                  <div className="flex items-center rounded-lg bg-slate-100 p-0.5" role="group" aria-label="Preview products">
                    {(["ALL", "READY", "PRESERVED"] as const).map((filter) => (
                      <button
                        key={filter}
                        type="button"
                        aria-pressed={bulkPricePreviewFilter === filter}
                        onClick={() => { setBulkPricePreviewFilter(filter); setBulkPriceStep2Page(1); }}
                        className={`min-h-11 flex-1 whitespace-nowrap rounded-md px-2 text-[12px] font-bold transition ${bulkPricePreviewFilter === filter ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"}`}
                      >
                        {filter === "ALL" ? "All" : filter === "PRESERVED" ? "Excluded" : bulkPriceMode === "MANUAL" ? "Included" : "Ready"}
                      </button>
                    ))}
                  </div>
                ) : null}
                {/* Search & Modify Bar */}
                <div className="flex items-center gap-2 shrink-0">
                  <div className="relative flex-1 flex items-center h-10 rounded-[9px] border border-[#CFCFD3] bg-[#F8FAFC] px-3 transition focus-within:border-blue-600 focus-within:bg-white focus-within:ring-1 focus-within:ring-blue-600">
                    <Icon name="search" sizePx={18} className="text-[#8C8889] shrink-0" />
                    <input
                      value={priceSearch}
                      onChange={(event) => setPriceSearch(event.target.value)}
                      placeholder="Filter products…"
                      className="w-full bg-transparent pl-2.5 pr-2 text-[13px] font-semibold text-[#11120d] outline-none placeholder-[#8C8889]"
                    />
                    {priceSearch ? (
                      <button
                        type="button"
                        onClick={() => setPriceSearch("")}
                        className="!min-h-0 !min-w-0 p-1 text-[#8C8889] hover:text-[#11120d]"
                        aria-label="Clear filter"
                      >
                        <Icon name="close" sizePx={14} />
                      </button>
                    ) : null}
                  </div>
                  {/* Sort Button Mobile */}
                  <button
                    type="button"
                    onClick={() => setOpenBulkPriceSortModal(true)}
                    className={`inline-flex h-10 !min-h-0 items-center justify-center gap-1 rounded-[9px] border px-2.5 text-[11.5px] font-bold transition shrink-0 ${
                      bulkPriceSort !== "affected_first"
                        ? "border-blue-200 bg-blue-50 text-blue-700"
                        : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-slate-50"
                    }`}
                    aria-label="Sort products"
                    title="Sort products"
                  >
                    <Icon name="swap_vert" sizePx={16} />
                    <span>Sort</span>
                    {bulkPriceSort !== "affected_first" ? <span className="h-1.5 w-1.5 rounded-full bg-blue-600" /> : null}
                  </button>

                </div>

                {/* Mobile Cards List: The primary scrollable container */}
                <div className="divide-y divide-[#E5E7EB] rounded-[10px] border border-[#E5E7EB] bg-white">
                  {isFilteredSelection ? (
                    paginatedFilteredPreviewItems.map((item) => (
                      <article key={item.productId} className="p-2.5 space-y-1.5">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                          <div className="break-words font-extrabold text-[13px] text-[#11120d]">{item.name}</div>
                          <div className="break-all text-[11px] leading-5 text-slate-600">SKU: {item.sku || "-"} · Rate: {formatReviewPrice(item.rate)}</div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => filteredPriceOverrides[item.productId] ? useCalculatedPriceForFilteredItem(item.productId) : editFilteredPreviewItem(item)}
                              className={`inline-flex min-h-10 min-w-[62px] items-center justify-center rounded-[7px] border px-2.5 text-[12px] font-bold active:scale-[0.97] touch-manipulation transition ${
                                filteredPriceOverrides[item.productId]
                                  ? "border-blue-300 bg-blue-50 text-blue-700 shadow-2xs font-extrabold"
                                  : "border-[#CBD5E1] bg-white text-[#11120d] hover:bg-slate-50"
                              }`}
                            >
                              {filteredPriceOverrides[item.productId] ? "Use rule" : "Adjust"}
                            </button>
                            <button
                              type="button"
                              onClick={() => excludeFilteredPreviewItem(item)}
                              className="inline-flex min-h-10 min-w-[62px] items-center justify-center rounded-[7px] border border-rose-200 bg-white px-2.5 text-[12px] font-extrabold text-rose-700 hover:bg-rose-50 active:scale-[0.97] touch-manipulation transition"
                            >
                              Exclude
                            </button>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-1.5 text-xs">
                          <div className="rounded-[6px] bg-[#F8FAFC] border border-[#E5E7EB] p-1.5">
                            <div className="text-[11px] font-bold text-blue-800">Wholesale</div>
                            <div className="mt-0.5 flex items-center gap-1">
                              <span className="text-[#565449]">{item.currentWholesalePrice !== null ? `NPR ${item.currentWholesalePrice}` : "None"}</span>
                              {item.newWholesalePrice !== null ? (
                                <>
                                  <Icon name="arrow_forward" sizePx={10} className="text-[#8C8889]" />
                                  <span className="font-bold text-blue-700">NPR {item.newWholesalePrice}</span>
                                </>
                              ) : null}
                            </div>
                          </div>
                          <div className="rounded-[6px] bg-[#F8FAFC] border border-[#E5E7EB] p-1.5">
                            <div className="text-[11px] font-bold text-purple-800">Retail</div>
                            <div className="mt-0.5 flex items-center gap-1">
                              <span className="text-[#565449]">{item.currentRetailPrice !== null ? `NPR ${item.currentRetailPrice}` : "None"}</span>
                              {item.newRetailPrice !== null ? (
                                <>
                                  <Icon name="arrow_forward" sizePx={10} className="text-[#8C8889]" />
                                  <span className="font-bold text-purple-700">NPR {item.newRetailPrice}</span>
                                </>
                              ) : null}
                            </div>
                          </div>
                        </div>
                        {filteredPriceOverrides[item.productId] ? (
                          <div className="grid grid-cols-2 gap-2 rounded-[7px] border border-blue-200 bg-blue-50/50 p-2">
                            {([['ratePerPiece', 'Rate'], ['wholesalePrice', 'Wholesale'], ['retailPrice', 'Retail']] as const).map(([field, label]) => (
                              <label key={field} className={`min-w-0 ${field === "ratePerPiece" ? "col-span-2" : ""}`}>
                                <span className="block text-[11px] font-bold text-[#475569]">{label}</span>
                                <div className="flex h-11 items-center overflow-hidden rounded-[6px] border border-blue-300 bg-white">
                                  <span className="border-r border-blue-200 px-2 text-[11px] font-bold text-[#6B7280]">NPR</span>
                                  <input type="number" min="0.01" step="0.01" inputMode="decimal" value={filteredPriceOverrides[item.productId][field]} onChange={(event) => updateFilteredPriceOverride(item.productId, field, event.target.value)} data-price-field={`${item.productId}-${field}`} aria-label={`New ${label} for ${item.name}`} className="h-full min-w-0 flex-1 bg-transparent px-2 text-right text-[16px] font-bold tabular-nums outline-none" />
                                </div>
                              </label>
                            ))}
                          </div>
                        ) : null}
                      </article>
                    ))
                  ) : (
                    paginatedExplicitPreviewItems.map((product) => {
                      const row = priceRows[product.id] || {
                        retailPrice: product.retailPrice === null ? "" : String(product.retailPrice),
                        wholesalePrice: product.wholesalePrice === null ? "" : String(product.wholesalePrice),
                        ratePerPiece: product.ratePerPiece === null ? "" : String(product.ratePerPiece),
                      };
                      const isIncluded = priceMarginTargetIds[product.id] !== false;
                      const isAdjusted = Boolean(explicitAdjustedIds[product.id]);
                      const isComingSoon = product.availabilityStatus === "COMING_SOON";
                      const hasNoRate = !(Number(product.ratePerPiece) > 0);

                      return (
                        <article key={product.id} className={`p-2.5 space-y-1.5 ${!isIncluded ? "bg-rose-50/40 opacity-70" : ""}`}>
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                        <div className="break-words font-extrabold text-[13px] text-[#11120d]">{product.name}</div>
                        <div className="break-all text-[11px] leading-5 text-slate-600">SKU: {product.sku || "-"} · Rate: {formatReviewPrice(product.ratePerPiece)}</div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              {bulkPriceMode === "CALCULATE" ? (
                                <button
                                  type="button"
                                  disabled={!isIncluded || isComingSoon || hasNoRate}
                                  onClick={() => setExplicitAdjustedIds((c) => ({ ...c, [product.id]: !c[product.id] }))}
                                  className={`inline-flex min-h-10 min-w-[62px] items-center justify-center rounded-[7px] border px-2.5 text-[12px] font-bold active:scale-[0.97] touch-manipulation transition disabled:opacity-35 ${
                                    isAdjusted
                                      ? "border-blue-300 bg-blue-50 text-blue-700 shadow-2xs font-extrabold"
                                      : "border-[#CBD5E1] bg-white text-[#11120d] hover:bg-slate-50"
                                  }`}
                                >
                                  {isAdjusted ? "Use rule" : "Adjust"}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => {
                                  setPriceMarginTargetIds((current) => ({ ...current, [product.id]: !isIncluded }));
                                  setBulkPriceNotice(null);
                                  setBulkPriceTouched(true);
                                }}
                                className={`inline-flex min-h-10 min-w-[62px] items-center justify-center rounded-[7px] border px-2.5 text-[12px] font-extrabold active:scale-[0.97] touch-manipulation transition ${
                                  !isIncluded
                                    ? "border-emerald-300 bg-emerald-50 text-emerald-800 shadow-2xs"
                                    : "border-rose-200 bg-white text-rose-700 hover:bg-rose-50"
                                }`}
                              >
                                {!isIncluded ? "Include" : "Exclude"}
                              </button>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-1.5 text-xs">
                            <div className="rounded-[6px] bg-[#F8FAFC] border border-[#E5E7EB] p-1.5">
                              <div className="text-[11px] font-bold text-blue-800">Wholesale</div>
                              <div className="mt-0.5 flex items-center gap-1">
                                <span className="text-[#565449]">{product.wholesalePrice ? `NPR ${product.wholesalePrice}` : "None"}</span>
                                {row.wholesalePrice && row.wholesalePrice !== String(product.wholesalePrice) && isIncluded ? (
                                  <>
                                    <Icon name="arrow_forward" sizePx={10} className="text-[#8C8889]" />
                                    <span className="font-bold text-blue-700">NPR {row.wholesalePrice}</span>
                                  </>
                                ) : null}
                              </div>
                            </div>
                            <div className="rounded-[6px] bg-[#F8FAFC] border border-[#E5E7EB] p-1.5">
                              <div className="text-[11px] font-bold text-purple-800">Retail</div>
                              <div className="mt-0.5 flex items-center gap-1">
                                <span className="text-[#565449]">{product.retailPrice ? `NPR ${product.retailPrice}` : "None"}</span>
                                {row.retailPrice && row.retailPrice !== String(product.retailPrice) && isIncluded ? (
                                  <>
                                    <Icon name="arrow_forward" sizePx={10} className="text-[#8C8889]" />
                                    <span className="font-bold text-purple-700">NPR {row.retailPrice}</span>
                                  </>
                                ) : null}
                              </div>
                            </div>
                          </div>

                          {(bulkPriceMode === "MANUAL" || isAdjusted) && isIncluded ? (
                            <div className="grid grid-cols-2 gap-2 rounded-[7px] border border-blue-200 bg-blue-50/50 p-2">
                              {([['ratePerPiece', 'Rate'], ['wholesalePrice', 'Wholesale'], ['retailPrice', 'Retail']] as const).map(([field, label]) => (
                                <label key={field} className={`min-w-0 ${field === "ratePerPiece" ? "col-span-2" : ""}`}>
                                  <span className="block text-[11px] font-bold text-[#475569]">{label}</span>
                                  <div className="flex h-11 items-center overflow-hidden rounded-[6px] border border-blue-300 bg-white">
                                    <span className="border-r border-blue-200 px-2 text-[11px] font-bold text-[#6B7280]">NPR</span>
                                    <input
                                      type="number"
                                      min="0.01"
                                      step="0.01"
                                      inputMode="decimal"
                                      value={row[field]}
                                      data-price-field={`${product.id}-${field}`}
                                      aria-label={`New ${label} for ${product.name}`}
                                      onChange={(e) => {
                                        setPriceRows((c) => ({ ...c, [product.id]: { ...(c[product.id] || row), [field]: e.target.value } }));
                                        setBulkPriceTouched(true);
                                      }}
                                      className="h-full min-w-0 flex-1 bg-transparent px-2 text-right text-[16px] font-bold tabular-nums outline-none"
                                    />
                                  </div>
                                </label>
                              ))}
                            </div>
                          ) : null}
                        </article>
                      );
                    })
                  )}

                  {((isFilteredSelection && paginatedFilteredPreviewItems.length === 0) || (!isFilteredSelection && paginatedExplicitPreviewItems.length === 0)) ? (
                    <div className="p-6 text-center text-[12px] font-semibold text-[#8C8889]">
                      No preview items match this search.
                    </div>
                  ) : null}
                    </div>
                <MobilePaginationFooter
                  page={isFilteredSelection ? activeStep2FilteredPage : activeStep2ExplicitPage}
                  totalPages={isFilteredSelection ? step2FilteredTotalPages : step2ExplicitTotalPages}
                  total={isFilteredSelection ? filteredPreviewStats.previewMatchedCount : explicitPreviewProducts.length}
                  start={((isFilteredSelection ? activeStep2FilteredPage : activeStep2ExplicitPage) - 1) * bulkPriceStep2PageSize}
                  end={Math.min(isFilteredSelection ? filteredPreviewStats.previewMatchedCount : explicitPreviewProducts.length, (isFilteredSelection ? activeStep2FilteredPage : activeStep2ExplicitPage) * bulkPriceStep2PageSize)}
                  label="products"
                  pageSize={bulkPriceStep2PageSize}
                  pageSizeOptions={[10, 20, 50]}
                  onPageChange={(page) => {
                    if (isFilteredSelection) {
                      setPriceBusy(true);
                      void loadFilteredPricePreview(page).finally(() => setPriceBusy(false));
                    } else setBulkPriceStep2Page(page);
                  }}
                  onPageSizeChange={(size) => {
                    setBulkPriceStep2PageSize(size);
                    setBulkPriceStep2Page(1);
                    if (isFilteredSelection) {
                      setPriceBusy(true);
                      void loadFilteredPricePreview(1, priceSearch, size).finally(() => setPriceBusy(false));
                    }
                  }}
                  className="shrink-0 border border-t-0 border-[#E5E7EB] bg-[#F8FAFC] px-2.5"
                />
                {/* Mobile Audit Reason Box */}
                <div className="rounded-[9px] border border-[#E5E7EB] bg-[#F8FAFC] px-2.5 py-1.5 shrink-0">
                  <div className="flex items-center justify-between gap-2">
                    <label htmlFor="bulk-price-reason-combobox-mobile" className="text-[11px] font-extrabold text-[#11120d] flex items-center gap-1 shrink-0">
                      <Icon name="verified" sizePx={13} className="text-blue-600" />
                      Audit reason <span className="text-rose-600">*</span>
                    </label>
                    <div className="w-[190px] min-[400px]:w-[230px]">
                      <CreatableCombobox
                        compact
                        inputRef={priceReasonRef}
                        value={priceReason}
                        onChange={(val) => {
                          setPriceReason(val);
                          setBulkPriceTouched(true);
                          if (bulkPriceErrors.reason) setBulkPriceErrors((c) => ({ ...c, reason: undefined }));
                          if (bulkPriceNotice?.message?.includes("Enter a reason")) setBulkPriceNotice(null);
                        }}
                        options={[
                          "Supplier Rate changed",
                          "Market price changed",
                          "Seasonal price adjustment",
                          "Promotion ended",
                          "Correcting an entry mistake",
                          "Management-approved price review",
                        ]}
                        placeholder="Select reason..."
                        ariaLabel="Price update audit reason"
                        allowCreate
                        required
                        invalid={Boolean(bulkPriceErrors.reason)}
                      />
                    </div>
                  </div>
                  {bulkPriceErrors.reason ? (
                    <p className="mt-1 text-[10px] font-bold text-[#BE123C] flex items-center gap-1" role="alert">
                      <Icon name="error" sizePx={12} />
                      {bulkPriceErrors.reason}
                    </p>
                  ) : null}
                </div>
              </div>

            </div>
          ) : null}
        </div>
      </ModalFrame>

      {/* SORT PRODUCTS POPUP MODAL (Mobile Bottom Sheet & Desktop Modal) */}
      <ModalFrame
        open={openBulkPriceSortModal}
        title="Sort Products"
        description="Choose order to view products in bulk price editor."
        descriptionClassName="hidden sm:block"
        onClose={() => setOpenBulkPriceSortModal(false)}
        layer="critical"
        maxWidthClass="max-w-[440px]"
        mobileBottomSheet
        footer={
          <div className="flex w-full items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => { setBulkPriceSort("affected_first"); setOpenBulkPriceSortModal(false); }}
              className="inline-flex h-9 items-center justify-center rounded-[8px] border border-[#D8DBE0] bg-white px-3.5 text-[12px] font-bold text-[#565449] hover:bg-slate-50 transition"
            >
              Reset default
            </button>
            <button
              type="button"
              onClick={() => setOpenBulkPriceSortModal(false)}
              className="inline-flex h-9 items-center justify-center rounded-[8px] border border-[#11120d] bg-[#11120d] px-4 text-[12px] font-extrabold text-white hover:bg-[#2a2c27] transition"
            >
              Apply
            </button>
          </div>
        }
      >
        <div className="space-y-1.5 py-1">
          {([
            {
              id: "affected_first",
              label: "Changed prices first",
              description: "Review affected products on top, unchanged below",
              icon: "tune",
              tag: "Default",
            },
            {
              id: "excluded_first",
              label: "Excluded products on top",
              description: "Review products excluded from price changes",
              icon: "remove_circle_outline",
              tag: "Review",
            },
            {
              id: "rate_desc",
              label: "Highest Rate",
              description: "Rate: high to low",
              icon: "arrow_downward",
              tag: "Rate",
            },
            {
              id: "rate_asc",
              label: "Lowest Rate",
              description: "Rate: low to high",
              icon: "arrow_upward",
              tag: "Rate",
            },
            {
              id: "price_desc",
              label: "Highest selling price",
              description: "Wholesale & retail: high to low",
              icon: "trending_up",
              tag: "Price",
            },
            {
              id: "stock_desc",
              label: "Highest stock quantity",
              description: "Inventory units: high to low",
              icon: "inventory_2",
              tag: "Stock",
            },
          ] as const)
            .filter((item) => !isFilteredSelection || (item.id !== "excluded_first" && item.id !== "stock_desc"))
            .map((item) => {
            const isSelected = bulkPriceSort === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => { setBulkPriceSort(item.id); setOpenBulkPriceSortModal(false); }}
                className={`flex min-h-[46px] w-full items-center justify-between gap-2.5 rounded-[9px] border p-2.5 sm:px-3 text-left transition touch-manipulation active:scale-[0.99] ${
                  isSelected
                    ? "border-blue-300 bg-blue-50/70 text-blue-900 font-extrabold shadow-2xs"
                    : "border-[#E5E7EB] bg-white text-[#334155] hover:bg-[#F8FAFC] font-semibold"
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className={`flex h-7.5 w-7.5 shrink-0 items-center justify-center rounded-lg ${isSelected ? "bg-blue-100 text-blue-800" : "bg-slate-100 text-slate-500"}`}>
                    <Icon name={item.icon} sizePx={16} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[12px] truncate font-bold text-[#11120d]">{item.label}</div>
                    <div className={`text-[10px] truncate ${isSelected ? "text-blue-700 font-semibold" : "text-slate-400"}`}>{item.description}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${
                    isSelected ? "bg-white text-blue-800 border border-blue-200" : "bg-slate-100 text-slate-500"
                  }`}>
                    {item.tag}
                  </span>
                  <div className={`flex h-4 w-4 items-center justify-center rounded-full border ${
                    isSelected ? "border-blue-600 bg-blue-600 text-white" : "border-[#CBD5E1] bg-white"
                  }`}>
                    {isSelected ? <Icon name="check" sizePx={10} /> : null}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </ModalFrame>

<ModalFrame open={confirmDiscardBulkPrice} title="Discard price changes?" description="Your unsaved price settings and preview will be lost." onClose={() => setConfirmDiscardBulkPrice(false)} layer="critical" maxWidthClass="max-w-[460px]" mobileBottomSheet footer={<div className="grid w-full grid-cols-2 gap-3"><DialogButton onClick={() => setConfirmDiscardBulkPrice(false)}>Keep editing</DialogButton><DialogButton variant="danger" onClick={discardBulkPriceChanges}>Discard changes</DialogButton></div>}>
        <div className="rounded-[14px] border border-amber-200 bg-amber-50 p-4 text-[13px] font-semibold leading-6 text-amber-950">No product prices have been saved yet. Close this panel only if you want to lose these changes.</div>
      </ModalFrame>

      {/* RESULT POPUP MODAL */}
      <ModalFrame
        open={Boolean(bulkPriceResult)}
        title="Bulk price update complete"
        description="Review the results of your price changes."
        onClose={() => {
          setBulkPriceResult(null);
          clearBulkSelection();
        }}
        layer="critical"
        maxWidthClass="max-w-[600px]"
        mobileBottomSheet
        footer={
          <div className="flex w-full flex-col sm:flex-row items-center justify-between gap-3">
            <div className="w-full sm:w-auto">
              <DialogButton onClick={() => {
                setBulkPriceResult(null);
                clearBulkSelection();
              }}>
                Close
              </DialogButton>
            </div>
            {bulkPriceResult?.errorCount ? (
              <button
                type="button"
                disabled={retryLoading}
                onClick={async () => {
                  const failedIds = [...new Set(bulkPriceResult.errors.map(e => e.productId).filter(Boolean))];
                  if (failedIds.length > 0) {
                    try {
                      setRetryLoading(true);
                      const failedProducts = await fetchProductsByIds(failedIds);
                      if (failedProducts.length !== failedIds.length || failedIds.some((id) => !failedProducts.some((product) => product.id === id))) {
                        throw new Error("Not all failed products could be reloaded. The result remains available; check the missing products before retrying.");
                      }
                      const newSelected = Object.fromEntries(failedProducts.map((product) => [product.id, true]));
                      const newCache = Object.fromEntries(failedProducts.map((p: any) => [p.id, p]));

                      setSelected(newSelected);
                      setSelectedProductCache(prev => ({ ...prev, ...newCache }));
                      setBulkSelectionScope("page");
                      setPriceMarginTargetIds(newSelected);

                      // Clear stale preview state to rebuild fresh
                      setPriceRows((current) => Object.fromEntries(failedProducts.map((product) => [product.id,
                        bulkPriceMode === "MANUAL" || explicitAdjustedIds[product.id]
                          ? current[product.id] || {
                              ratePerPiece: product.ratePerPiece === null ? "" : String(product.ratePerPiece),
                              wholesalePrice: product.wholesalePrice === null ? "" : String(product.wholesalePrice),
                              retailPrice: product.retailPrice === null ? "" : String(product.retailPrice),
                            }
                          : {
                              ratePerPiece: product.ratePerPiece === null ? "" : String(product.ratePerPiece),
                              wholesalePrice: product.wholesalePrice === null ? "" : String(product.wholesalePrice),
                              retailPrice: product.retailPrice === null ? "" : String(product.retailPrice),
                            },
                      ])));
                      setPricePreviewReady(false);
                      setBulkPricePreviewRevision(null);
                      setExplicitReviewPreview(null);
                      setSaveOutcomeUncertain(false);
                      setBulkPriceNotice({ tone: "info", message: "Failed products were reloaded. Calculate and review a fresh preview before saving." });

                      setBulkPriceResult(null);
                      setOpenBulkPrice(true);
                    } catch (error: any) {
                      toastMsg("danger", error?.message || "Could not load failed products for retry.");
                    } finally {
                      setRetryLoading(false);
                    }
                  } else {
                    setBulkPriceResult(null);
                    clearBulkSelection();
                  }
                }}
                className="inline-flex min-h-10 flex-1 sm:flex-none items-center justify-center gap-2 rounded-[9px] bg-[#11120d] px-4 text-[12px] font-extrabold text-white transition hover:bg-[#2a2c27] disabled:opacity-50"
              >
                <Icon name="refresh" sizePx={15} />
                {retryLoading ? "Loading failed products..." : `Retry ${bulkPriceResult.errorCount} failed`}
              </button>
            ) : null}
          </div>
        }
      >
        {bulkPriceResult ? (
          <div className="flex flex-col gap-4 text-sm">
            {bulkPriceResult.auditWarning && (
              <div className="rounded-[9px] bg-amber-50 border border-amber-200 p-3 text-amber-900 text-xs font-semibold">
                <Icon name="warning" sizePx={14} className="inline mr-1" />
                {bulkPriceResult.auditWarning}
              </div>
            )}
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-[9px] border border-green-200 bg-green-50 p-3 text-center">
                <div className="text-[11px] font-extrabold uppercase tracking-wide text-green-700">Updated</div>
                <div className="mt-1 text-2xl font-black tabular-nums text-green-800">{bulkPriceResult.updatedCount}</div>
              </div>
              <div className="rounded-[9px] border border-slate-200 bg-slate-50 p-3 text-center">
                <div className="text-[11px] font-extrabold uppercase tracking-wide text-slate-500">Skipped</div>
                <div className="mt-1 text-2xl font-black tabular-nums text-slate-600">{bulkPriceResult.skippedCount}</div>
              </div>
              <div className={`rounded-[9px] border ${bulkPriceResult.errorCount > 0 ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-slate-50'} p-3 text-center`}>
                <div className={`text-[10px] font-extrabold uppercase tracking-wide ${bulkPriceResult.errorCount > 0 ? 'text-rose-700' : 'text-slate-500'}`}>Failed</div>
                <div className={`mt-1 text-2xl font-black tabular-nums ${bulkPriceResult.errorCount > 0 ? 'text-rose-800' : 'text-slate-600'}`}>{bulkPriceResult.errorCount}</div>
              </div>
            </div>

            {bulkPriceResult.errorCount > 0 && (
              <div className="mt-2 flex flex-col gap-2">
                <div className="text-[12px] font-extrabold text-rose-900">Error Details</div>
                <div className="max-h-[200px] overflow-y-auto divide-y divide-rose-100 rounded-[9px] border border-rose-200 bg-white">
                  {bulkPriceResult.errors.map((error, idx) => {
                    return (
                      <div key={idx} className="p-2.5 flex flex-col gap-1 text-xs">
                        <div className="break-all font-bold text-slate-900">{error.name || `Product ${error.productId}`}{error.sku ? ` · ${error.sku}` : ""}</div>
                        <div className="text-rose-700">{error.message} {error.code ? `(${error.code})` : ""}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </ModalFrame>
    </div>
  );
}
