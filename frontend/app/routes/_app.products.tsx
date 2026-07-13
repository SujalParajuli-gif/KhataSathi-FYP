import React, { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import type { Product, ProductStatus, ToastKind } from "~/lib/domain/products/products.types";
import {
  deleteProductImportBatchApi,
  getBusinessSettingsApi,
  getProductImportBatchApi,
  importCsvApi,
  importImageRateListApi,
  importProductDocumentApi,
  importPdfApi,
  importReviewedPdfRowsApi,
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
} from "~/lib/api/endpoints";
import {
  bulkSetStatus,
  createProduct,
  fetchProducts,
  fetchProductsMeta,
  getProductDeleteSafety,
  permanentlyDeleteProduct,
  setProductStatus,
  updateProduct,
  uploadProductImage,
} from "~/lib/domain/products/products.api";
import { getAuthUser } from "~/lib/auth";
import type { ProductDeleteSafety } from "~/lib/api/endpoints";
import ProductsFiltersCard from "~/components/blocks/products/ProductsFilters";
import ProductsTableCard from "~/components/blocks/products/ProductsTable";
import ProductsModals from "~/components/blocks/products/ProductsModals";
import { useToast } from "~/components/ui/Toast";
import { DialogButton, ModalFrame } from "~/components/ui/Modal";
import Icon from "~/components/ui/Icon";
type ProductFormErrors = Partial<
  Record<
    | "name"
    | "sku"
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

type QuickStockProductForm = {
  name: string;
  sku: string;
  brand: string;
  category: string;
  ratePerPiece: string;
  retailPrice: string;
  saleUnit: string;
};

// this normalizes business settings into safe numeric defaults before the product form uses them
// we added the clamps here so missing or broken settings data does not produce invalid thresholds in the UI
function normalizeBusinessDefaults(
  settings?: Partial<BusinessSettings> | null,
): BusinessSettings {
  return {
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

function roundMoney(value: number) {
  return Math.round(Number(value || 0) * 100) / 100;
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

function buildQuickProductSku(name: string) {
  const normalized = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 18);
  const prefix = normalized || "PRODUCT";
  return `${prefix}-${Date.now().toString(36).toUpperCase().slice(-5)}`;
}

// this is the main product management page
// it handles searching, filtering, adding, editing, importing, and soft-deleting product records
export default function ProductsPage() {
  const { showToast } = useToast();
  const isAdmin = getAuthUser()?.role === "admin";
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedImportBatchId = searchParams.get("importBatch");
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
      brand: brandOptions[1] ?? "CG Foods",
      category: categoryOptions[1] ?? "Groceries",
      categoryGroup: "",
      vendorSource: "",
      productCodeVariant: "",
      sizeValue: null,
      sizeUnit: "STANDARD",
      ratePerPiece: 0,
      packageQuantity: 1,
      packageUnit: "PIECE",
      saleUnit: "PIECE",
      allowFractionalQty: false,
      quantityStep: 1,
      wholesaleEligible: true,
      sourceCitation: "",
      retailPrice: 0,
      wholesalePrice: 0,
      thresholdQty: settings.defaultWholesaleQtyThreshold,
      thresholdQtyMode: "default",
      stock: 0,
      lowStockThreshold: settings.defaultLowStockThreshold,
      lowStockThresholdMode: "default",
      status: "Active",
    };
  }

  const [brands, setBrands] = useState<string[]>(["All Brands"]);
  const [categories, setCategories] = useState<string[]>(["All Categories"]);
  const [businessDefaults, setBusinessDefaults] = useState<BusinessSettings>(
    () => normalizeBusinessDefaults(),
  );

  const [products, setProducts] = useState<Product[]>([]); // stores the full fetched product list before table pagination is applied
  const [total, setTotal] = useState(0); // backend-reported total matching the current filters

  const [q, setQ] = useState(""); // text search across product data
  const [brand, setBrand] = useState("All Brands"); // brand dropdown filter
  const [category, setCategory] = useState("All Categories"); // category dropdown filter
  const [stockStatus, setStockStatus] = useState<"all" | "in" | "low" | "out">(
    "all",
  );
  const [status, setStatus] = useState<"all" | "active" | "inactive">("all"); // active vs inactive filter
  const [lowOnly, setLowOnly] = useState(false); // quick toggle for low stock products only

  const [selected, setSelected] = useState<Record<string, boolean>>({}); // checkbox state for bulk actions across the current dataset
  // converting the selection object into an id list makes the bulk action handlers much easier to work with
  const selectedIds = useMemo(
    () => Object.keys(selected).filter((id) => selected[id]),
    [selected],
  );
  const selectedProducts = useMemo(
    () => products.filter((product) => selectedIds.includes(product.id)),
    [products, selectedIds],
  );

  const fetchPageSize = 200; // we keep requesting products in larger chunks so client-side table paging feels instant
  const [tablePageSize, setTablePageSize] = useState(20); // visible rows per table page
  const [page, setPage] = useState(1); // current table page

  const [openAddEdit, setOpenAddEdit] = useState(false); // controls the create/edit modal
  const [openImport, setOpenImport] = useState(false); // controls the CSV import modal
  const [openView, setOpenView] = useState(false); // controls the product detail modal
  const [openConfirmDelete, setOpenConfirmDelete] = useState(false); // controls the single-product soft delete confirmation
  const [deleteSafety, setDeleteSafety] = useState<ProductDeleteSafety | null>(null);
  const [deleteSafetyLoading, setDeleteSafetyLoading] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [bulkAction, setBulkAction] = useState<BulkActionState>(null); // stores the current bulk action confirmation content
  const [openStockManager, setOpenStockManager] = useState(false);
  const [openBulkPrice, setOpenBulkPrice] = useState(false);
  const [stockMode, setStockMode] = useState<"receive" | "correct">("receive");
  const [stockDirection, setStockDirection] = useState<"add" | "remove">("add");
  const [stockProductIds, setStockProductIds] = useState<string[]>([]);
  const [stockProductQuery, setStockProductQuery] = useState("");
  const [stockLookupResults, setStockLookupResults] = useState<Product[]>([]);
  const [stockLookupBusy, setStockLookupBusy] = useState(false);
  const [stockLineError, setStockLineError] = useState("");
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
    retailPrice: "",
    saleUnit: "PIECE",
  });
  const [quickStockError, setQuickStockError] = useState("");
  const [quickStockBusy, setQuickStockBusy] = useState(false);
  const [priceRows, setPriceRows] = useState<
    Record<string, { retailPrice: number; wholesalePrice: number; ratePerPiece: number }>
  >({});
  const [wholesaleMarginPercent, setWholesaleMarginPercent] = useState(18);
  const [retailMarginPercent, setRetailMarginPercent] = useState(30);
  const [priceReason, setPriceReason] = useState("");
  const [priceBusy, setPriceBusy] = useState(false);

  const [activeProductId, setActiveProductId] = useState<string | null>(null); // product currently being viewed, edited, or deleted
  const [formErrors, setFormErrors] = useState<ProductFormErrors>({}); // field-level validation messages for the product form
  const [productImageFile, setProductImageFile] = useState<File | null>(null); // uploaded image file waiting to be sent after save
  const [productImagePreview, setProductImagePreview] = useState(""); // local preview URL or existing product image URL
  const [importFile, setImportFile] = useState<File | null>(null); // selected CSV file for bulk import
  const [importBusy, setImportBusy] = useState(false); // disables repeated import submits while upload is running
  const [importError, setImportError] = useState(""); // import-specific error shown in the modal
  const [importResult, setImportResult] = useState<CsvImportResult | null>(null); // row-by-row result returned after CSV import completes
  const [pdfReviewBatch, setPdfReviewBatch] = useState<ProductImportBatch | null>(null); // selected supplier import preview batch for row review
  const [pdfReviewBusy, setPdfReviewBusy] = useState(false); // disables review submit while selected import rows are importing
  const [importBatches, setImportBatches] = useState<ProductImportBatch[]>([]); // recent CSV/PDF/image review batches shown in the import modal
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
    serial: "",
    variant: "",
    packageQuantity: "",
    retailPrice: "",
    wholesalePrice: "",
    stock: "",
  });

  const productsById = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products],
  );
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
    () => products.find((product) => product.id === activeProductId) || null,
    [products, activeProductId],
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
    setImportFile(null);
    setImportBusy(false);
    setImportError("");
    setImportResult(null);
    setPdfReviewBatch(null);
    setPdfReviewBusy(false);
    setLastImportedProducts([]);
    setLastImportSupplier("");
  }

  // loading product meta and saved business defaults together keeps the filters and form defaults in sync
  async function loadMeta() {
    const [meta, settings] = await Promise.all([
      fetchProductsMeta(),
      getBusinessSettingsApi(),
    ]);
    setBrands(["All Brands", ...meta.brands]);
    setCategories(["All Categories", ...meta.categories]);
    setBusinessDefaults(normalizeBusinessDefaults(settings));
  }

  async function loadImportBatches() {
    const result = await listProductImportBatchesApi();
    setImportBatches(Array.isArray(result.batches) ? result.batches : []);
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
      setStockBillDocuments([]);
      toastMsg(
        "danger",
        error?.response?.data?.error || error?.message || "Failed to load uploaded stock bills.",
      );
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
      setImportDocuments([]);
      toastMsg(
        "danger",
        error?.response?.data?.error || error?.message || "Failed to load product import documents.",
      );
    } finally {
      setImportDocumentsLoading(false);
    }
  }

  async function openImportBatchById(batchId: string) {
    try {
      setOpenImport(true);
      setImportBusy(true);
      setImportError("");
      const batch = await getProductImportBatchApi(batchId);
      setPdfReviewBatch(batch);
      setImportResult(null);
    } catch (error: any) {
      const message =
        error?.response?.data?.error ||
        error?.message ||
        "Failed to open import batch.";
      setImportError(message);
      toastMsg("danger", message);
    } finally {
      setImportBusy(false);
    }
  }

  // this fetches every product page that matches the current filters
  // we collect them into one array because the UI table uses its own smaller client-side pagination
  async function loadProducts() {
    let nextPage = 1;
    let nextTotal = 0;
    const collected: Product[] = [];

    do {
      // sending the current filter state to the backend for each paged request
      const res = await fetchProducts({
        q: q.trim() || undefined,
        brand: brand === "All Brands" ? undefined : brand,
        category: category === "All Categories" ? undefined : category,
        stockStatus,
        status,
        lowOnly,
        page: nextPage,
        pageSize: fetchPageSize,
      });

      collected.push(...res.items);
      nextTotal = res.total; // backend tells us how many matching rows exist in total
      nextPage += 1;

      // this handles when the backend returns an empty page early, so we stop instead of looping forever
      if (res.items.length === 0) break;
    } while (collected.length < nextTotal);

    setProducts(collected);
    setTotal(nextTotal);
  }

  React.useEffect(() => {
    // cleaning up the last blob preview when the component unmounts or the preview url changes
    return () => revokePreview(productImagePreview);
  }, [productImagePreview]);

  React.useEffect(() => {
    // fetching metadata and the initial product list when the page first loads
    (async () => {
      try {
        await Promise.all([loadMeta(), loadImportBatches(), loadImportTemplates()]);
        await loadProducts();
      } catch (error: any) {
        toastMsg("danger", error?.message || "Failed to load products.");
      }
    })();
  }, []);

  React.useEffect(() => {
    // reloading products whenever one of the filter values changes
    (async () => {
      try {
        await loadProducts();
      } catch (error: any) {
        toastMsg("danger", error?.message || "Failed to load products.");
      }
    })();
  }, [q, brand, category, stockStatus, status, lowOnly, fetchPageSize]);

  React.useEffect(() => {
    // sending the table back to page 1 after any filter change avoids landing on empty later pages
    setPage(1);
  }, [q, brand, category, stockStatus, status, lowOnly]);

  React.useEffect(() => {
    if (!requestedImportBatchId) return;
    void openImportBatchById(requestedImportBatchId);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("importBatch");
      return next;
    }, { replace: true });
  }, [requestedImportBatchId]);

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

    const timer = window.setTimeout(async () => {
      try {
        setStockLookupBusy(true);
        setStockLineError("");
        const result = await fetchProducts({
          q: query,
          status: "active",
          page: 1,
          pageSize: 20,
        });
        setStockLookupResults(
          result.items.filter((product) => !stockProductIds.includes(product.id)),
        );
      } catch (error: any) {
        setStockLookupResults([]);
        setStockLineError(error?.message || "Failed to search products.");
      } finally {
        setStockLookupBusy(false);
      }
    }, 250);

    return () => window.clearTimeout(timer);
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

  const totalPages = Math.max(1, Math.ceil(products.length / tablePageSize)); // client-side total page count for the visible table
  const pageClamped = clampPage(page, 1, totalPages); // protecting against stale page numbers after the dataset changes
  const pageItems = useMemo(() => {
    const start = (pageClamped - 1) * tablePageSize;
    return products.slice(start, start + tablePageSize);
  }, [pageClamped, products, tablePageSize]);
  const pageStart = products.length === 0 ? 0 : (pageClamped - 1) * tablePageSize; // zero-based starting index for the current page
  const pageEnd = products.length === 0 ? 0 : pageStart + pageItems.length; // ending index used by the table footer summary

  // this resets every filter control back to its default value
  function clearFilters() {
    setQ("");
    setBrand("All Brands");
    setCategory("All Categories");
    setStockStatus("all");
    setStatus("all");
    setLowOnly(false);
  }

  // toggling every checkbox on the current visible page is used by the bulk action buttons above the table
  function toggleAllOnPage(checked: boolean) {
    const next = { ...selected };
    pageItems.forEach((product) => {
      next[product.id] = checked;
    });
    setSelected(next);
  }

  // this updates one checkbox inside the selected map without losing the rest of the selected rows
  function toggleOne(id: string, checked: boolean) {
    setSelected((prev) => ({ ...prev, [id]: checked }));
  }

  // this opens the add product modal with a brand-new form based on the latest business defaults
  function openAdd() {
    setActiveProductId(null);
    setForm(buildDefaultProductForm(brands, categories, businessDefaults));
    clearFormValidation();
    resetImageState("");
    setOpenAddEdit(true);
  }

  // this opens the edit modal using the selected product's current values
  function openEdit(product: Product) {
    setActiveProductId(product.id);
    setForm({ ...product });
    clearFormValidation();
    resetImageState(product.imageUrl || "");
    setOpenAddEdit(true);
  }

  // this keeps the view modal and edit modal connected so the user can jump straight from one into the other
  function openEditFromView() {
    if (!activeProduct) return;
    setOpenView(false);
    openEdit(activeProduct);
  }

  // storing the product id before opening the view modal lets the shared modal read the right product record
  function openViewProduct(product: Product) {
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
  function validateForm() {
    const errors: ProductFormErrors = {};

    if (!form.name.trim()) {
      errors.name = "Product name is required.";
    }
    if (!form.sku.trim()) {
      errors.sku = "SKU is required.";
    }
    if (!Number.isFinite(form.retailPrice) || form.retailPrice <= 0) {
      errors.retailPrice = "Retail price must be greater than 0.";
    }
    if (!Number.isFinite(form.wholesalePrice) || form.wholesalePrice <= 0) {
      errors.wholesalePrice = "Wholesale price must be greater than 0.";
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
    if (!Number.isFinite(form.packageQuantity) || form.packageQuantity <= 0) {
      errors.packageQuantity = "Package quantity must be greater than 0.";
    }
    if (!Number.isFinite(form.quantityStep) || form.quantityStep <= 0) {
      errors.quantityStep = "Quantity step must be greater than 0.";
    }
    if (!form.allowFractionalQty && form.quantityStep !== 1) {
      errors.quantityStep = "Piece-based products must use a step of 1.";
    }

    setFormErrors(errors); // pushing every collected validation message into state at once
    return Object.keys(errors).length === 0;
  }

  // this saves either a new product or edits an existing one, then optionally uploads its image
  async function saveProduct() {
    // stopping here keeps invalid form data from reaching the backend
    if (!validateForm()) return;

    try {
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
        ratePerPiece: Math.max(0, Number(form.ratePerPiece || form.retailPrice || 0)),
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
      const savedProduct = activeProductId
        ? await updateProduct(activeProductId, payload as any)
        : await createProduct(payload as any);

      let imageUploadFailed = false;
      // uploading the image after the product save gives us the real saved product id to attach it to
      if (productImageFile) {
        try {
          await uploadProductImage(savedProduct.id, productImageFile);
        } catch {
          // this handles when the image upload fails after the product itself was already saved
          imageUploadFailed = true;
        }
      }

      // resetting the editor state after a successful save keeps the next open modal clean
      setOpenAddEdit(false);
      setActiveProductId(null);
      clearFormValidation();
      resetImageState("");
      await loadProducts();
      setSelected({});

      // we still show a partial-success message if the product save worked but the image upload did not
      if (imageUploadFailed) {
        toastMsg(
          "danger",
          activeProductId
            ? "Product saved, but image upload failed."
            : "Product added, but image upload failed.",
        );
        return;
      }

      toastMsg("success", activeProductId ? "Product updated." : "Product added.");
    } catch (error: any) {
      // this handles any create or update failure from the product API
      toastMsg("danger", error?.message || "Failed to save product.");
    }
  }

  // this bulk action turns every selected product back to Active state
  async function activateSelected() {
    if (selectedIds.length === 0) return;
    const idsToActivate = selectedProducts
      .filter((product) => product.status !== "Active")
      .map((product) => product.id);
    const skippedCount = selectedIds.length - idsToActivate.length;
    if (idsToActivate.length === 0) {
      toastMsg("info", formatStatusOutcome("Active", 0, skippedCount));
      setSelected({});
      return;
    }
    try {
      const result = await bulkSetStatus(idsToActivate, "Active");
      toastMsg(
        result.changedCount > 0 ? "success" : "info",
        formatStatusOutcome("Active", result.changedCount, skippedCount + result.skippedCount),
      );
      setSelected({});
      await loadProducts();
    } catch (error: any) {
      toastMsg("danger", error?.message || "Failed to activate selected.");
    }
  }

  // this opens the shared bulk confirmation modal for deactivating selected products
  function requestDeactivateSelected() {
    if (selectedIds.length === 0) return;
    setBulkAction({
      title: "Confirm bulk deactivate",
      message:
        selectedIds.length === 1
          ? "This product will be marked inactive and removed from active selling flows."
          : `${selectedIds.length} selected products will be marked inactive and removed from active selling flows.`,
      confirmLabel: "Deactivate selected",
      successKind: "success",
      successMessage:
        selectedIds.length === 1
          ? "Selected product deactivated."
          : "Selected products deactivated.",
      targetStatus: "Inactive",
    });
  }

  // this opens the same bulk confirmation modal for setting selected products inactive
  function requestSoftDeleteSelected() {
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
      setSelected({});
      setBulkAction(null);
      return;
    }
    try {
      const result = await bulkSetStatus(idsToUpdate, targetStatus);
      toastMsg(
        result.changedCount > 0 ? bulkAction.successKind : "info",
        formatStatusOutcome(targetStatus, result.changedCount, skippedCount + result.skippedCount),
      );
      setSelected({});
      setBulkAction(null);
      await loadProducts();
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
      await loadProducts();
    } catch (error: any) {
      toastMsg("danger", error?.message || "Failed to update product.");
    }
  }

  async function toggleProductStatus(product: Product) {
    const newStatus = product.status === "Active" ? "Inactive" : "Active";
    try {
      const result = await setProductStatus(product.id, newStatus);
      toastMsg(result.changed ? "success" : "info", result.message || `Product set to ${newStatus}.`);
      await loadProducts();
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
      setSelected({});
      await loadProducts();
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
  async function handleImportCsv() {
    // requiring a file first avoids sending an empty import request
    if (!importFile) {
      setImportError("Choose a CSV, PDF, or image rate list before uploading.");
      return;
    }

    try {
      setImportBusy(true);
      setImportError("");
      const lowerName = importFile.name.toLowerCase();
      const isPdf =
        importFile.type === "application/pdf" ||
        lowerName.endsWith(".pdf");
      const isImage =
        importFile.type.startsWith("image/") ||
        /\.(png|jpe?g|webp)$/i.test(lowerName);
      const result = (await (isPdf
        ? importPdfApi(importFile)
        : isImage
          ? importImageRateListApi(importFile)
          : importCsvApi(importFile, {
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
            }))) as CsvImportResult;
      setImportResult(result);
      setLastImportedProducts([]);
      setLastImportSupplier("");
      setSelected({});

      if (result.batchId) {
        const batch = await getProductImportBatchApi(result.batchId);
        setPdfReviewBatch(batch);
        await loadImportBatches();
        toastMsg(
          result.errorCount > 0 ? "info" : "success",
          result.message || "Import review is ready.",
        );
      } else {
        toastMsg("danger", result.message || "No import review was created.");
      }
    } catch (error: any) {
      // preferring backend error text here helps the user understand row format issues more clearly
      const message =
        error?.response?.data?.error ||
        error?.message ||
        "Failed to import products.";
      setImportError(message);
      toastMsg("danger", message);
    } finally {
      setImportBusy(false);
    }
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
      setSelected({});

      if (result.batchId) {
        const batch = await getProductImportBatchApi(result.batchId);
        setPdfReviewBatch(batch);
        await loadImportBatches();
        await loadImportDocuments();
        toastMsg(
          result.errorCount > 0 ? "info" : "success",
          result.message || "Import review is ready.",
        );
      } else {
        toastMsg("danger", result.message || "No import review was created.");
      }
    } catch (error: any) {
      const message =
        error?.response?.data?.error ||
        error?.message ||
        "Failed to open uploaded import document.";
      setImportError(message);
      toastMsg("danger", message);
    } finally {
      setImportBusy(false);
      setImportDocumentBusyId(null);
    }
  }

  function openStockManagerForSelection() {
    const selectedStockIds = selectedProducts.map((product) => product.id);
    setStockProductIds(selectedStockIds);
    setStockRows(
      Object.fromEntries(selectedStockIds.map((productId) => [productId, 0])),
    );
    setStockApplyQty(0);
    setStockProductQuery("");
    setStockLookupResults([]);
    setStockLineError("");
    setStockReason("");
    setStockMode("receive");
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
    setStockReason("Received after product import");
    setStockMode("receive");
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

  function openBulkPriceForSelection() {
    if (selectedProducts.length === 0) return;
    setPriceRows(
      Object.fromEntries(
        selectedProducts.map((product) => [
          product.id,
          {
            retailPrice: Number(product.retailPrice || 0),
            wholesalePrice: Number(product.wholesalePrice || 0),
            ratePerPiece: Number(product.ratePerPiece || product.wholesalePrice || 0),
          },
        ]),
      ),
    );
    setPriceReason("");
    setOpenBulkPrice(true);
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
      sku: name ? buildQuickProductSku(name) : "",
      brand: firstBrand,
      category: firstCategory,
      ratePerPiece: "",
      retailPrice: "",
      saleUnit: "PIECE",
    });
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
      retailPrice: "",
      saleUnit: "PIECE",
    });
  }

  async function saveQuickStockProduct(addAnother = false) {
    const name = quickStockProduct.name.trim();
    const brandName = quickStockProduct.brand.trim();
    const categoryName = quickStockProduct.category.trim();
    const ratePerPiece = Number(quickStockProduct.ratePerPiece || 0);
    const retailPrice = Number(quickStockProduct.retailPrice || 0);
    const saleUnit = quickStockProduct.saleUnit || "PIECE";
    const sku = quickStockProduct.sku.trim() || buildQuickProductSku(name);

    if (!name) {
      setQuickStockError("Product name is required.");
      return;
    }
    if (!brandName) {
      setQuickStockError("Choose a brand before saving.");
      return;
    }
    if (!categoryName) {
      setQuickStockError("Choose a category before saving.");
      return;
    }
    if (!Number.isFinite(ratePerPiece) || ratePerPiece <= 0) {
      setQuickStockError("Rate/base price must be greater than 0.");
      return;
    }
    if (!Number.isFinite(retailPrice) || retailPrice <= 0) {
      setQuickStockError("Retail price must be greater than 0.");
      return;
    }

    try {
      setQuickStockBusy(true);
      setQuickStockError("");
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
        retailPrice,
        wholesalePrice: ratePerPiece,
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

  function applyPriceMarginsToSelected() {
    setPriceRows((current) =>
      Object.fromEntries(
        selectedProducts.map((product) => {
          const row = current[product.id] || {
            retailPrice: product.retailPrice,
            wholesalePrice: product.wholesalePrice,
            ratePerPiece: product.ratePerPiece,
          };
          const rate = Number(row.ratePerPiece || 0);
          return [
            product.id,
            {
              ...row,
              wholesalePrice: roundMoney(rate * (1 + Number(wholesaleMarginPercent || 0) / 100)),
              retailPrice: roundMoney(rate * (1 + Number(retailMarginPercent || 0) / 100)),
            },
          ];
        }),
      ),
    );
  }

  async function confirmStockManager() {
    const rows = stockManagerProducts
      .map((product) => ({ product, qty: Math.abs(Number(stockRows[product.id] || 0)) }))
      .filter((row) => row.qty > 0);
    if (rows.length === 0) {
      setStockLineError("Add at least one product and enter a quantity.");
      return;
    }
    if (!stockReason.trim()) {
      setStockLineError("Reason is required for stock changes.");
      return;
    }
    if (stockMode === "receive" && !stockSupplierName.trim()) {
      setStockLineError("Supplier name is required when receiving stock.");
      return;
    }

    try {
      setStockBusy(true);
      setStockLineError("");
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
      setSelected({});
      setStockProductIds([]);
      setStockRows({});
      setStockProductQuery("");
      setStockLookupResults([]);
      setStockLineError("");
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

  function closeStockManager() {
    if (stockBusy || quickStockBusy) return;
    setOpenStockQuickAdd(false);
    setQuickStockError("");
    setStockSelectedBillIds([]);
    setStockShowDocumentPicker(false);
    setOpenStockManager(false);
  }

  function returnToStockMovementList() {
    if (quickStockBusy) return;
    setOpenStockQuickAdd(false);
    setQuickStockError("");
  }

  function renderQuickStockProductForm() {
    return (
      <div className="space-y-[14px]">
        <div className="grid grid-cols-1 gap-[10px] md:grid-cols-2">
          <label className="md:col-span-2">
            <div className="mb-[6px] text-[12px] font-extrabold uppercase text-[#8C8889]">
              Product name
            </div>
            <input
              value={quickStockProduct.name}
              onChange={(event) => {
                setQuickStockProduct((current) => ({
                  ...current,
                  name: event.target.value,
                }));
                setQuickStockError("");
              }}
              placeholder="e.g. Sauce Bottle Big 570"
              className="h-[42px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-[12px] text-[13px] font-semibold text-[#000000] outline-none"
            />
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
            <select
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
            </select>
          </label>

          <label>
            <div className="mb-[6px] text-[12px] font-extrabold uppercase text-[#8C8889]">
              Brand
            </div>
            <select
              value={quickStockProduct.brand}
              onChange={(event) => {
                setQuickStockProduct((current) => ({
                  ...current,
                  brand: event.target.value,
                }));
                setQuickStockError("");
              }}
              className="h-[42px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-[12px] text-[13px] font-bold text-[#000000] outline-none"
            >
              <option value="">Choose brand</option>
              {brands
                .filter((item) => item !== "All Brands")
                .map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
            </select>
          </label>

          <label>
            <div className="mb-[6px] text-[12px] font-extrabold uppercase text-[#8C8889]">
              Category
            </div>
            <select
              value={quickStockProduct.category}
              onChange={(event) => {
                setQuickStockProduct((current) => ({
                  ...current,
                  category: event.target.value,
                }));
                setQuickStockError("");
              }}
              className="h-[42px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-[12px] text-[13px] font-bold text-[#000000] outline-none"
            >
              <option value="">Choose category</option>
              {categories
                .filter((item) => item !== "All Categories")
                .map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
            </select>
          </label>

          <label>
            <div className="mb-[6px] text-[12px] font-extrabold uppercase text-[#8C8889]">
              Rate / base price
            </div>
            <input
              type="number"
              min={0}
              step="0.01"
              value={quickStockProduct.ratePerPiece}
              onChange={(event) => {
                const value = event.target.value;
                setQuickStockProduct((current) => ({
                  ...current,
                  ratePerPiece: value,
                  retailPrice:
                    current.retailPrice || !value
                      ? current.retailPrice
                      : String(roundMoney(Number(value) * 1.18)),
                }));
                setQuickStockError("");
              }}
              className="h-[42px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-[12px] text-right text-[13px] font-semibold text-[#000000] outline-none"
            />
          </label>

          <label>
            <div className="mb-[6px] text-[12px] font-extrabold uppercase text-[#8C8889]">
              Retail price
            </div>
            <input
              type="number"
              min={0}
              step="0.01"
              value={quickStockProduct.retailPrice}
              onChange={(event) => {
                setQuickStockProduct((current) => ({
                  ...current,
                  retailPrice: event.target.value,
                }));
                setQuickStockError("");
              }}
              className="h-[42px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-[12px] text-right text-[13px] font-semibold text-[#000000] outline-none"
            />
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

  async function confirmBulkPriceUpdate() {
    if (!priceReason.trim()) {
      toastMsg("danger", "Reason is required for bulk price changes.");
      return;
    }

    const updates = selectedProducts.map((product) => ({
      productId: product.id,
      retailPrice: Number(priceRows[product.id]?.retailPrice || 0),
      wholesalePrice: Number(priceRows[product.id]?.wholesalePrice || 0),
      ratePerPiece: Number(priceRows[product.id]?.ratePerPiece || priceRows[product.id]?.wholesalePrice || 0),
    }));

    if (updates.some((row) => row.retailPrice <= 0 || row.wholesalePrice <= 0)) {
      toastMsg("danger", "Retail and wholesale prices must be greater than 0.");
      return;
    }

    try {
      setPriceBusy(true);
      const result = await bulkUpdateProductPricesApi({
        reason: priceReason.trim(),
        updates,
      });
      toastMsg(
        result.errorCount > 0 ? "info" : "success",
        result.errorCount > 0
          ? `${result.updatedCount} prices updated with ${result.errorCount} issue(s).`
          : "Selected product prices updated.",
      );
      setOpenBulkPrice(false);
      setSelected({});
      await loadProducts();
    } catch (error: any) {
      toastMsg(
        "danger",
        error?.response?.data?.error || error?.message || "Failed to update prices.",
      );
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
      setSelected({});
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
      toastMsg("danger", message);
    } finally {
      setPdfReviewBusy(false);
    }
  }

  return (
    <div className="space-y-[14px]">
      {/* handing all current filter state and bulk action callbacks into the shared filter/header card */}
      <ProductsFiltersCard
        q={q}
        setQ={setQ}
        brands={brands}
        brand={brand}
        setBrand={setBrand}
        categories={categories}
        category={category}
        setCategory={setCategory}
        stockStatus={stockStatus}
        setStockStatus={setStockStatus}
        status={status}
        setStatus={setStatus}
        lowOnly={lowOnly}
        setLowOnly={setLowOnly}
        onClear={clearFilters}
        selectedCount={selectedIds.length}
        onAdd={openAdd}
        onImport={() => {
          resetImportState();
          void Promise.all([loadImportBatches(), loadImportTemplates()]);
          setOpenImport(true);
        }}
        onManageStock={openStockManagerForSelection}
        onBulkPrice={openBulkPriceForSelection}
        onActivate={activateSelected}
        onDeactivate={requestDeactivateSelected}
        onSoftDelete={requestSoftDeleteSelected}
      />

      {/* this table only receives the current client-side page slice, not the full product array */}
      <ProductsTableCard
        rows={pageItems}
        selected={selected}
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
        onPageChange={setPage}
        onPageSizeChange={(nextPageSize) => {
          setTablePageSize(nextPageSize);
          setPage(1);
        }}
      />

      {/* centralizing modal state here keeps add/edit/view/import/delete flows coordinated from one page component */}
      <ProductsModals
        brands={brands}
        categories={categories}
        businessDefaults={businessDefaults}
        openAddEdit={openAddEdit}
        setOpenAddEdit={setOpenAddEdit}
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
        onProductImageChange={handleProductImageChange}
        onClearProductImage={() => handleProductImageChange(null)}
        onSave={saveProduct}
        onConfirmDelete={confirmDeleteOne}
        isAdmin={isAdmin}
        deleteSafety={deleteSafety}
        deleteSafetyLoading={deleteSafetyLoading}
        deleteBusy={deleteBusy}
        onConfirmPermanentDelete={confirmPermanentDeleteOne}
        bulkAction={bulkAction}
        onCloseBulkAction={() => setBulkAction(null)}
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
            toastMsg("danger", "Supplier name is required to save a template.");
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
            await loadImportBatches();
            toastMsg("success", result.message || "Import review deleted.");
          } catch (error: any) {
            const message =
              error?.response?.data?.error ||
              error?.message ||
              "Failed to delete import review.";
            setImportError(message);
            toastMsg("danger", message);
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
          setOpenImport(false);
          resetImportState();
        }}
        onUploadCsvClick={handleImportCsv}
      />

      <ModalFrame
        open={openStockManager}
        title="Stock Movement"
        description={
          openStockQuickAdd
            ? "Create a product as a step inside stock receive, then return to the receive list."
            : "Receive supplier stock or correct counted stock. Start empty, search existing products, or create new products while receiving."
        }
        onClose={closeStockManager}
        maxWidthClass="max-w-[1040px]"
      >
        <div className="space-y-[20px]">
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
          {/* Top Controls: Mode & Reason */}
          <div className="flex flex-col gap-[16px] md:flex-row md:items-start md:justify-between bg-[#F8FAFC] p-[16px] rounded-[16px] border border-[#E5E7EB]">
            <div className="flex flex-col gap-[12px] md:flex-row md:items-center">
              {/* Segmented Toggle for Mode */}
              <div className="flex h-[42px] rounded-[12px] bg-[#E5E7EB] p-[4px]">
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
                <div className="flex h-[42px] rounded-[12px] border border-[#CFCFD3] bg-white p-[4px]">
                  {(["add", "remove"] as const).map((direction) => (
                    <button
                      key={direction}
                      type="button"
                      onClick={() => setStockDirection(direction)}
                      className={`flex items-center justify-center rounded-[8px] px-[16px] text-[12px] font-bold transition-colors ${
                        stockDirection === direction ? "bg-[#3B82F6] text-white" : "text-[#565449] hover:bg-[#F3F4F6]"
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
                value={stockReason}
                onChange={(event) => {
                  setStockReason(event.target.value);
                  setStockLineError("");
                }}
                placeholder="Reason or stock note (required)"
                className="h-[42px] w-full rounded-[10px] border border-[#CFCFD3] bg-white px-[14px] text-[13px] font-semibold text-[#11120d] outline-none placeholder-[#8C8889] focus:border-[#3B82F6] focus:ring-1 focus:ring-[#3B82F6]"
              />
            </div>
          </div>

          {/* Bill Attachment Section (Only for Receive Mode) */}
          {stockMode === "receive" && (
            <div className="rounded-[16px] border border-[#E5E7EB] bg-white p-[16px] shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-[10px] mb-[16px]">
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

              <div className="grid grid-cols-1 gap-[12px] md:grid-cols-2 lg:grid-cols-3 items-end">
                <div className="space-y-[6px]">
                  <label className="text-[12px] font-bold text-[#565449]">Supplier</label>
                  <select
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
                    }}
                    className="h-[40px] w-full rounded-[8px] border border-[#CFCFD3] bg-[#F8FAFC] px-[12px] text-[13px] font-bold text-[#11120d] outline-none focus:border-[#3B82F6]"
                  >
                    <option value="">Select supplier</option>
                    {stockSupplierOptions.map((supplier) => (
                      <option key={supplier} value={supplier}>{supplier}</option>
                    ))}
                    <option value="__new">+ Add new supplier</option>
                  </select>
                </div>

                {stockSupplierMode === "new" && (
                  <div className="space-y-[6px]">
                    <label className="text-[12px] font-bold text-[#565449]">New Supplier Name</label>
                    <input
                      value={stockSupplierName}
                      onChange={(e) => {
                        setStockSupplierName(e.target.value);
                        setStockLineError("");
                      }}
                      placeholder="e.g. Acme Corp"
                      className="h-[40px] w-full rounded-[8px] border border-[#CFCFD3] bg-white px-[12px] text-[13px] font-semibold text-[#11120d] outline-none focus:border-[#3B82F6]"
                    />
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
                                <div className="truncate text-[13px] font-bold text-[#11120d]">{document.fileName}</div>
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
                      <input type="date" value={stockBillDate} onChange={(e) => setStockBillDate(e.target.value)} className="h-[40px] w-full rounded-[8px] border border-[#CFCFD3] bg-white px-[12px] text-[13px] font-semibold outline-none focus:border-[#3B82F6]" />
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
          <div className="rounded-[16px] border border-[#E5E7EB] bg-white p-[16px] shadow-sm space-y-[16px]">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-[12px]">
              <div className="relative flex-1 max-w-[400px]">
                <div className="flex h-[42px] items-center gap-[8px] rounded-[10px] border border-[#CFCFD3] bg-[#F8FAFC] px-[12px] focus-within:border-[#3B82F6] focus-within:ring-1 focus-within:ring-[#3B82F6] transition">
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
                      <div
                        key={product.id}
                        onClick={() => addProductToStockManager(product)}
                        className="flex cursor-pointer items-center justify-between gap-[12px] px-[16px] py-[12px] transition hover:bg-[#F8FAFC] border-b border-[#E5E7EB] last:border-0"
                      >
                        <div>
                          <div className="text-[13px] font-bold text-[#11120d]">{product.name}</div>
                          <div className="text-[11px] font-medium text-[#565449] mt-[2px]">SKU {product.sku || "-"} | Stock: {product.stock}</div>
                        </div>
                        <button className="rounded-[6px] bg-[#EFF6FF] px-[10px] py-[4px] text-[11px] font-bold text-[#2563EB]">Add</button>
                      </div>
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
                  className="h-[36px] w-[80px] rounded-[8px] border border-[#CFCFD3] bg-[#F8FAFC] px-[10px] text-right text-[13px] font-bold outline-none focus:border-[#3B82F6]"
                />
                <button
                  type="button"
                  onClick={applyStockQtyToAllSelected}
                  disabled={stockManagerProducts.length === 0}
                  className="h-[36px] rounded-[8px] bg-[#E5E7EB] px-[12px] text-[12px] font-bold text-[#11120d] transition hover:bg-[#D1D5DB] disabled:opacity-50"
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

            <div className="overflow-hidden rounded-[12px] border border-[#E5E7EB]">
              <table className="w-full text-left">
                <thead className="bg-[#F8FAFC] border-b border-[#E5E7EB]">
                  <tr>
                    <th className="px-[16px] py-[10px] text-[11px] font-extrabold uppercase text-[#8C8889]">Product</th>
                    <th className="px-[16px] py-[10px] text-right text-[11px] font-extrabold uppercase text-[#8C8889]">Change Qty</th>
                    <th className="px-[16px] py-[10px] text-right text-[11px] font-extrabold uppercase text-[#8C8889]">Resulting Stock</th>
                    <th className="w-[60px] px-[16px] py-[10px]"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E5E7EB]">
                  {stockManagerProducts.map((product) => {
                    const qty = Math.abs(Number(stockRows[product.id] || 0));
                    const delta = stockMode === "receive" || stockDirection === "add" ? qty : -qty;
                    const nextStock = product.stock + delta;

                    return (
                      <tr key={product.id} className="transition hover:bg-[#F8FAFC]">
                        <td className="px-[16px] py-[12px]">
                          <div className="text-[13px] font-bold text-[#11120d]">{product.name}</div>
                          <div className="text-[11px] font-medium text-[#8C8889] mt-[2px]">SKU: {product.sku}</div>
                        </td>
                        <td className="px-[16px] py-[12px] text-right">
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
                              className="h-[36px] w-[90px] rounded-[8px] border border-[#CFCFD3] bg-white px-[10px] text-right text-[13px] font-bold outline-none focus:border-[#3B82F6]"
                            />
                          </div>
                        </td>
                        <td className="px-[16px] py-[12px] text-right">
                          <div className="flex items-center justify-end gap-[6px] text-[13px] font-bold">
                            <span className="text-[#8C8889]">{product.stock}</span>
                            <Icon name="arrow_forward" sizePx={14} className="text-[#8C8889]" />
                            <span className={nextStock < 0 ? "text-rose-600" : "text-[#11120d]"}>{nextStock}</span>
                          </div>
                        </td>
                        <td className="px-[16px] py-[12px] text-right">
                          <button
                            type="button"
                            onClick={() => removeProductFromStockManager(product.id)}
                            className="flex h-[32px] w-[32px] items-center justify-center rounded-[8px] text-[#8C8889] hover:bg-[#FEF2F2] hover:text-[#DC2626] transition"
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

          <div className="flex justify-end gap-[12px] pt-[8px]">
            <DialogButton onClick={closeStockManager}>Cancel</DialogButton>
            <DialogButton
              variant="primary"
              icon="inventory_2"
              onClick={confirmStockManager}
              disabled={stockBusy}
            >
              {stockBusy ? "Updating..." : "Confirm Movement"}
            </DialogButton>
          </div>
            </>
          )}
        </div>
      </ModalFrame>

      <ModalFrame
        open={openBulkPrice}
        title="Bulk Price Update"
        description="Update pricing and margins for selected products simultaneously."
        onClose={() => setOpenBulkPrice(false)}
        maxWidthClass="max-w-[1000px]"
      >
        <div className="space-y-[20px]">
          {/* Reason Input */}
          <div className="rounded-[16px] border border-[#E5E7EB] bg-[#F8FAFC] p-[16px]">
            <label className="text-[12px] font-bold text-[#565449] mb-[8px] block">Reason for Update</label>
            <input
              value={priceReason}
              onChange={(event) => setPriceReason(event.target.value)}
              placeholder="e.g. Supplier rate changes, seasonal discount..."
              className="h-[44px] w-full rounded-[10px] border border-[#CFCFD3] bg-white px-[14px] text-[13px] font-semibold text-[#11120d] outline-none placeholder-[#8C8889] focus:border-[#3B82F6] focus:ring-1 focus:ring-[#3B82F6]"
            />
          </div>

          {/* Margin Application */}
          <div className="rounded-[16px] border border-[#E5E7EB] bg-white p-[16px] shadow-sm">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-[16px]">
              <div className="flex-1">
                <div className="flex items-center gap-[8px]">
                  <Icon name="percent" sizePx={18} className="text-[#3B82F6]" />
                  <div className="text-[14px] font-extrabold text-[#11120d]">
                    Apply Margins from Rate/Cost
                  </div>
                </div>
                <div className="mt-[4px] text-[12px] font-medium text-[#565449]">
                  Set global margin percentages to automatically calculate wholesale and retail prices based on each product's base rate.
                </div>
              </div>
              <div className="flex items-end gap-[12px]">
                <div className="space-y-[6px]">
                  <label className="block text-[11px] font-bold text-[#8C8889] uppercase tracking-wider">
                    Wholesale %
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      value={wholesaleMarginPercent}
                      onChange={(event) => setWholesaleMarginPercent(Number(event.target.value))}
                      className="h-[40px] w-[100px] rounded-[8px] border border-[#CFCFD3] bg-white px-[12px] pr-[28px] text-right text-[14px] font-bold text-[#11120d] outline-none focus:border-[#3B82F6]"
                    />
                    <span className="absolute right-[10px] top-[10px] text-[13px] font-bold text-[#8C8889]">%</span>
                  </div>
                </div>
                <div className="space-y-[6px]">
                  <label className="block text-[11px] font-bold text-[#8C8889] uppercase tracking-wider">
                    Retail %
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      value={retailMarginPercent}
                      onChange={(event) => setRetailMarginPercent(Number(event.target.value))}
                      className="h-[40px] w-[100px] rounded-[8px] border border-[#CFCFD3] bg-white px-[12px] pr-[28px] text-right text-[14px] font-bold text-[#11120d] outline-none focus:border-[#3B82F6]"
                    />
                    <span className="absolute right-[10px] top-[10px] text-[13px] font-bold text-[#8C8889]">%</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={applyPriceMarginsToSelected}
                  className="h-[40px] rounded-[8px] bg-[#EFF6FF] px-[16px] text-[13px] font-bold text-[#2563EB] transition hover:bg-[#DBEAFE]"
                >
                  Apply Margins
                </button>
              </div>
            </div>
          </div>

          {/* Pricing Table */}
          <div className="overflow-hidden rounded-[16px] border border-[#E5E7EB] bg-white shadow-sm">
            <div className="grid grid-cols-[minmax(0,1fr)_130px_130px_130px] gap-[12px] border-b border-[#E5E7EB] bg-[#F8FAFC] px-[16px] py-[12px] text-[11px] font-extrabold uppercase tracking-wider text-[#8C8889]">
              <div>Product</div>
              <div className="text-right">Base Rate</div>
              <div className="text-right">Wholesale</div>
              <div className="text-right">Retail</div>
            </div>
            <div className="max-h-[380px] overflow-y-auto">
              {selectedProducts.map((product) => {
                const row = priceRows[product.id] || {
                  retailPrice: product.retailPrice,
                  wholesalePrice: product.wholesalePrice,
                  ratePerPiece: product.ratePerPiece,
                };
                return (
                  <div
                    key={product.id}
                    className="grid grid-cols-[minmax(0,1fr)_130px_130px_130px] items-center gap-[12px] border-b border-[#E5E7EB] px-[16px] py-[12px] last:border-0 hover:bg-[#F8FAFC] transition"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-bold text-[#11120d]">
                        {product.name}
                      </div>
                      <div className="mt-[2px] text-[11px] font-medium text-[#565449]">
                        SKU: {product.sku || "-"}
                      </div>
                    </div>
                    {(["ratePerPiece", "wholesalePrice", "retailPrice"] as const).map((key) => (
                      <div key={key} className="relative">
                        <span className="absolute left-[10px] top-[10px] text-[12px] font-bold text-[#8C8889]">Rs</span>
                        <input
                          type="number"
                          value={row[key]}
                          onChange={(event) =>
                            setPriceRows((current) => ({
                              ...current,
                              [product.id]: {
                                ...(current[product.id] || row),
                                [key]: Number(event.target.value),
                              },
                            }))
                          }
                          className="h-[38px] w-full rounded-[8px] border border-[#CFCFD3] bg-white px-[10px] pl-[30px] text-right text-[13px] font-bold text-[#11120d] outline-none focus:border-[#3B82F6]"
                        />
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex justify-end gap-[12px] pt-[8px]">
            <DialogButton onClick={() => setOpenBulkPrice(false)}>Cancel</DialogButton>
            <DialogButton
              variant="primary"
              icon="sell"
              onClick={confirmBulkPriceUpdate}
              disabled={priceBusy}
            >
              {priceBusy ? "Updating..." : "Confirm Price Update"}
            </DialogButton>
          </div>
        </div>
      </ModalFrame>
    </div>
  );
}

