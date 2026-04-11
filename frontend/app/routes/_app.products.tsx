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

export default function ProductsPage() {
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

  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);

  const [q, setQ] = useState("");
  const [brand, setBrand] = useState("All Brands");
  const [category, setCategory] = useState("All Categories");
  const [stockStatus, setStockStatus] = useState<"all" | "in" | "low" | "out">(
    "all",
  );
  const [status, setStatus] = useState<"all" | "active" | "inactive">("all");
  const [lowOnly, setLowOnly] = useState(false);

  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const selectedIds = useMemo(
    () => Object.keys(selected).filter((id) => selected[id]),
    [selected],
  );

  const pageSize = 200;

  const [openAddEdit, setOpenAddEdit] = useState(false);
  const [openImport, setOpenImport] = useState(false);
  const [openView, setOpenView] = useState(false);
  const [openConfirmDelete, setOpenConfirmDelete] = useState(false);
  const [bulkAction, setBulkAction] = useState<BulkActionState>(null);

  const [activeProductId, setActiveProductId] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<ProductFormErrors>({});
  const [productImageFile, setProductImageFile] = useState<File | null>(null);
  const [productImagePreview, setProductImagePreview] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const [importResult, setImportResult] = useState<CsvImportResult | null>(null);

  const [toast, setToast] = useState<{
    open: boolean;
    kind: ToastKind;
    message: string;
  }>({ open: false, kind: "info", message: "" });

  const activeProduct = useMemo(
    () => products.find((product) => product.id === activeProductId) || null,
    [products, activeProductId],
  );

  const [form, setForm] = useState<Product>(() =>
    buildDefaultProductForm(
      ["All Brands", "CG Foods"],
      ["All Categories", "Groceries"],
      normalizeBusinessDefaults(),
    ),
  );

  function toastMsg(kind: ToastKind, message: string) {
    setToast({ open: true, kind, message });
  }

  function clearFormValidation() {
    setFormErrors({});
  }

  function revokePreview(url: string) {
    if (url.startsWith("blob:")) {
      URL.revokeObjectURL(url);
    }
  }

  function resetImageState(nextPreview = "") {
    setProductImageFile(null);
    setProductImagePreview((current) => {
      revokePreview(current);
      return nextPreview;
    });
  }

  function resetImportState() {
    setImportFile(null);
    setImportBusy(false);
    setImportError("");
    setImportResult(null);
  }

  async function loadMeta() {
    const [meta, settings] = await Promise.all([
      fetchProductsMeta(),
      getBusinessSettingsApi(),
    ]);
    setBrands(["All Brands", ...meta.brands]);
    setCategories(["All Categories", ...meta.categories]);
    setBusinessDefaults(normalizeBusinessDefaults(settings));
  }

  async function loadProducts() {
    let nextPage = 1;
    let nextTotal = 0;
    const collected: Product[] = [];

    do {
      const res = await fetchProducts({
        q: q.trim() || undefined,
        brand: brand === "All Brands" ? undefined : brand,
        category: category === "All Categories" ? undefined : category,
        stockStatus,
        status,
        lowOnly,
        page: nextPage,
        pageSize,
      });

      collected.push(...res.items);
      nextTotal = res.total;
      nextPage += 1;

      if (res.items.length === 0) break;
    } while (collected.length < nextTotal);

    setProducts(collected);
    setTotal(nextTotal);
  }

  React.useEffect(() => {
    return () => revokePreview(productImagePreview);
  }, [productImagePreview]);

  React.useEffect(() => {
    (async () => {
      try {
        await loadMeta();
        await loadProducts();
      } catch (error: any) {
        toastMsg("danger", error?.message || "Failed to load products.");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    (async () => {
      try {
        await loadProducts();
      } catch (error: any) {
        toastMsg("danger", error?.message || "Failed to load products.");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, brand, category, stockStatus, status, lowOnly, pageSize]);

  function clearFilters() {
    setQ("");
    setBrand("All Brands");
    setCategory("All Categories");
    setStockStatus("all");
    setStatus("all");
    setLowOnly(false);
  }

  function toggleAllOnPage(checked: boolean) {
    const next = { ...selected };
    products.forEach((product) => {
      next[product.id] = checked;
    });
    setSelected(next);
  }

  function toggleOne(id: string, checked: boolean) {
    setSelected((prev) => ({ ...prev, [id]: checked }));
  }

  function openAdd() {
    setActiveProductId(null);
    setForm(buildDefaultProductForm(brands, categories, businessDefaults));
    clearFormValidation();
    resetImageState("");
    setOpenAddEdit(true);
  }

  function openEdit(product: Product) {
    setActiveProductId(product.id);
    setForm({ ...product });
    clearFormValidation();
    resetImageState(product.imageUrl || "");
    setOpenAddEdit(true);
  }

  function openEditFromView() {
    if (!activeProduct) return;
    setOpenView(false);
    openEdit(activeProduct);
  }

  function openViewProduct(product: Product) {
    setActiveProductId(product.id);
    setOpenView(true);
  }

  function requestDelete(product: Product) {
    setActiveProductId(product.id);
    setOpenConfirmDelete(true);
  }

  function handleProductImageChange(file: File | null) {
    if (!file) {
      resetImageState("");
      setForm((current) => ({ ...current, imageUrl: "" }));
      setFormErrors((prev) => ({ ...prev, image: undefined }));
      return;
    }

    if (!file.type.startsWith("image/")) {
      setFormErrors((prev) => ({
        ...prev,
        image: "Select a valid image file.",
      }));
      return;
    }

    const nextPreview = URL.createObjectURL(file);
    setProductImageFile(file);
    setProductImagePreview((current) => {
      revokePreview(current);
      return nextPreview;
    });
    setFormErrors((prev) => ({ ...prev, image: undefined }));
  }

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

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function saveProduct() {
    if (!validateForm()) return;

    try {
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

      const savedProduct = activeProductId
        ? await updateProduct(activeProductId, payload as any)
        : await createProduct(payload as any);

      let imageUploadFailed = false;
      if (productImageFile) {
        try {
          await uploadProductImage(savedProduct.id, productImageFile);
        } catch {
          imageUploadFailed = true;
        }
      }

      setOpenAddEdit(false);
      setActiveProductId(null);
      clearFormValidation();
      resetImageState("");
      await loadProducts();
      setSelected({});

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
      toastMsg("danger", error?.message || "Failed to save product.");
    }
  }

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

  async function handleImportCsv() {
    if (!importFile) {
      setImportError("Choose a CSV file before uploading.");
      return;
    }

    try {
      setImportBusy(true);
      setImportError("");
      const result = (await importCsvApi(importFile)) as CsvImportResult;
      setImportResult(result);
      await loadMeta();
      await loadProducts();
      setSelected({});

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

      <ProductsTableCard
        rows={products}
        selected={selected}
        toggleAllOnPage={toggleAllOnPage}
        toggleOne={toggleOne}
        onView={openViewProduct}
        onEdit={openEdit}
        onDelete={requestDelete}
        total={total}
        start={total === 0 ? 0 : 0}
        end={products.length}
      />

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

