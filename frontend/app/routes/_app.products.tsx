import React, { useMemo, useState } from "react";
import type { Product, ToastKind } from "~/lib/domain/products/products.types";
import {
  getBusinessSettingsApi,
  importCsvApi,
  type BusinessSettings,
} from "~/lib/api/endpoints";
import {
  bulkSetStatus,
  createProduct,
  fetchProducts,
  fetchProductsMeta,
  setProductStatus,
  updateProduct,
  uploadProductImage,
} from "~/lib/domain/products/products.api";
import ProductsFiltersCard from "~/components/blocks/products/ProductsFilters";
import ProductsTableCard from "~/components/blocks/products/ProductsTable";
import ProductsModals from "~/components/blocks/products/ProductsModals";
type ProductFormErrors = Partial<
  Record<
    "name" | "sku" | "retailPrice" | "wholesalePrice" | "thresholdQty" | "stock" | "lowStockThreshold" | "image",
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
  errors: CsvImportError[];
};

type BulkActionState =
  | null
  | {
      title: string;
      message: string;
      confirmLabel: string;
      successKind: ToastKind;
      successMessage: string;
    };

// this normalizes business settings into safe numeric defaults before the product form uses them
// we added the clamps here so missing or broken settings data does not produce invalid thresholds in the UI
function normalizeBusinessDefaults(
  settings?: Partial<BusinessSettings> | null,
): BusinessSettings {
  return {
    defaultLowStockThreshold: Math.max(
      0,
      Math.floor(Number(settings?.defaultLowStockThreshold ?? 5)),
    ),
    defaultWholesaleQtyThreshold: Math.max(
      1,
      Math.floor(Number(settings?.defaultWholesaleQtyThreshold ?? 15)),
    ),
    loyaltyDiscountPercent: Math.max(
      0,
      Math.min(100, Number(settings?.loyaltyDiscountPercent ?? 2)),
    ),
  };
}

// keeping pagination inside valid limits prevents the table from landing on empty pages after filters change
function clampPage(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

// this is the main product management page
// it handles searching, filtering, adding, editing, importing, and soft-deleting product records
export default function ProductsPage() {
  // we use this to create a clean form state for new products based on the current brand/category lists and saved defaults
  function buildDefaultProductForm(
    brandOptions: string[],
    categoryOptions: string[],
    settings: BusinessSettings,
  ): Product {
    return {
      id: "new",
      name: "",
      sku: "",
      barcode: "",
      imageUrl: "",
      brand: brandOptions[1] ?? "CG Foods",
      category: categoryOptions[1] ?? "Groceries",
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

  const fetchPageSize = 200; // we keep requesting products in larger chunks so client-side table paging feels instant
  const tablePageSize = 10; // visible rows per table page
  const [page, setPage] = useState(1); // current table page

  const [openAddEdit, setOpenAddEdit] = useState(false); // controls the create/edit modal
  const [openImport, setOpenImport] = useState(false); // controls the CSV import modal
  const [openView, setOpenView] = useState(false); // controls the product detail modal
  const [openConfirmDelete, setOpenConfirmDelete] = useState(false); // controls the single-product soft delete confirmation
  const [bulkAction, setBulkAction] = useState<BulkActionState>(null); // stores the current bulk action confirmation content

  const [activeProductId, setActiveProductId] = useState<string | null>(null); // product currently being viewed, edited, or deleted
  const [formErrors, setFormErrors] = useState<ProductFormErrors>({}); // field-level validation messages for the product form
  const [productImageFile, setProductImageFile] = useState<File | null>(null); // uploaded image file waiting to be sent after save
  const [productImagePreview, setProductImagePreview] = useState(""); // local preview URL or existing product image URL
  const [importFile, setImportFile] = useState<File | null>(null); // selected CSV file for bulk import
  const [importBusy, setImportBusy] = useState(false); // disables repeated import submits while upload is running
  const [importError, setImportError] = useState(""); // import-specific error shown in the modal
  const [importResult, setImportResult] = useState<CsvImportResult | null>(null); // row-by-row result returned after CSV import completes

  const [toast, setToast] = useState<{
    open: boolean;
    kind: ToastKind;
    message: string;
  }>({ open: false, kind: "info", message: "" }); // shared toast feedback for all product actions

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
  function toastMsg(kind: ToastKind, message: string) {
    setToast({ open: true, kind, message });
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
        await loadMeta();
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

  // this prepares the single-product soft delete confirmation dialog
  function requestDelete(product: Product) {
    setActiveProductId(product.id);
    setOpenConfirmDelete(true);
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
        sku: form.sku.trim(),
        barcode: form.barcode?.trim() || "",
        imageUrl: form.imageUrl || null,
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
    try {
      await bulkSetStatus(selectedIds, "Active");
      toastMsg("success", "Selected products activated.");
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
    });
  }

  // this opens the same bulk confirmation modal but with softer wording for a soft delete flow
  function requestSoftDeleteSelected() {
    if (selectedIds.length === 0) return;
    setBulkAction({
      title: "Confirm bulk soft delete",
      message:
        selectedIds.length === 1
          ? "This product will be set inactive as a soft delete. Invoice history and audit logs are preserved."
          : `${selectedIds.length} selected products will be set inactive as a soft delete. Invoice history and audit logs are preserved.`,
      confirmLabel: "Soft delete selected",
      successKind: "info",
      successMessage:
        selectedIds.length === 1
          ? "Selected product set to Inactive."
          : "Selected products set to Inactive.",
    });
  }

  // this runs the inactive bulk status update after the user confirms the current bulk action
  async function confirmBulkAction() {
    if (!bulkAction || selectedIds.length === 0) return;
    if (selectedIds.length === 0) return;
    try {
      await bulkSetStatus(selectedIds, "Inactive");
      toastMsg(bulkAction.successKind, bulkAction.successMessage);
      setSelected({});
      setBulkAction(null);
      await loadProducts();
    } catch (error: any) {
      toastMsg("danger", error?.message || "Failed to update selected.");
    }
  }

  // this soft-deletes one product by setting its status to Inactive
  async function confirmDeleteOne() {
    if (!activeProductId) return;
    try {
      await setProductStatus(activeProductId, "Inactive");
      toastMsg("info", "Product set to Inactive.");
      setOpenConfirmDelete(false);
      setActiveProductId(null);
      await loadProducts();
    } catch (error: any) {
      toastMsg("danger", error?.message || "Failed to update product.");
    }
  }

  // this uploads the selected CSV file and then reloads the metadata + product list so the page reflects the imported rows
  async function handleImportCsv() {
    // requiring a file first avoids sending an empty import request
    if (!importFile) {
      setImportError("Choose a CSV file before uploading.");
      return;
    }

    try {
      setImportBusy(true);
      setImportError("");
      // sending the CSV file to the backend and storing the per-row result summary it returns
      const result = (await importCsvApi(importFile)) as CsvImportResult;
      setImportResult(result);
      await loadMeta();
      await loadProducts();
      setSelected({});

      // showing different toast messages depending on whether the import fully succeeded, partially succeeded, or failed completely
      if (result.createdCount > 0 && result.errorCount === 0) {
        toastMsg("success", `${result.createdCount} product${result.createdCount === 1 ? "" : "s"} imported.`);
      } else if (result.createdCount > 0) {
        toastMsg(
          "info",
          `${result.createdCount} product${result.createdCount === 1 ? "" : "s"} imported with ${result.errorCount} issue${result.errorCount === 1 ? "" : "s"}.`,
        );
      } else {
        toastMsg("danger", "No products were imported. Review the row errors.");
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
          setOpenImport(true);
        }}
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
        onPageChange={setPage}
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
        bulkAction={bulkAction}
        onCloseBulkAction={() => setBulkAction(null)}
        onConfirmBulkAction={confirmBulkAction}
        onEditActiveProduct={openEditFromView}
        importFile={importFile}
        setImportFile={(file) => {
          setImportFile(file);
          setImportError("");
          setImportResult(null);
        }}
        importBusy={importBusy}
        importError={importError}
        importResult={importResult}
        onCloseImport={() => {
          setOpenImport(false);
          resetImportState();
        }}
        onUploadCsvClick={handleImportCsv}
        toast={toast}
        setToast={setToast}
      />
    </div>
  );
}

