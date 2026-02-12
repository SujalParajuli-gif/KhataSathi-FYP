// frontend/app/routes/_app.products.tsx
import React, { useMemo, useState } from "react";
import type { Product, ToastKind } from "~/lib/domain/products/products.types";
import { cn, getStockFlag } from "~/lib/domain/products/products.helpers";
import {
  bulkSetStatus,
  createProduct,
  fetchProducts,
  fetchProductsMeta,
  setProductStatus,
  updateProduct,
} from "~/lib/domain/products/products.api";
import ProductsFiltersCard from "~/components/blocks/products/ProductsFilters";
import ProductsTableCard from "~/components/blocks/products/ProductsTable";
import ProductsModals from "~/components/blocks/products/ProductsModals";

export default function ProductsPage() {
  const [brands, setBrands] = useState<string[]>(["All Brands"]);
  const [categories, setCategories] = useState<string[]>(["All Categories"]);

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

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(6);

  const [openAddEdit, setOpenAddEdit] = useState(false);
  const [openImport, setOpenImport] = useState(false);
  const [openView, setOpenView] = useState(false);
  const [openConfirmDelete, setOpenConfirmDelete] = useState(false);

  const [activeProductId, setActiveProductId] = useState<string | null>(null);

  const [toast, setToast] = useState<{
    open: boolean;
    kind: ToastKind;
    message: string;
  }>({ open: false, kind: "info", message: "" });

  const activeProduct = useMemo(
    () => products.find((p) => p.id === activeProductId) || null,
    [products, activeProductId],
  );

  const [form, setForm] = useState<Product>(() => ({
    id: "new",
    name: "",
    sku: "",
    barcode: "",
    imageUrl: "",
    brand: "CG Foods",
    category: "Groceries",
    retailPrice: 0,
    wholesalePrice: 0,
    thresholdQty: 1,
    stock: 0,
    lowStockThreshold: 5,
    status: "Active",
  }));

  function toastMsg(kind: ToastKind, message: string) {
    setToast({ open: true, kind, message });
  }

  async function loadMeta() {
    const meta = await fetchProductsMeta();
    setBrands(["All Brands", ...meta.brands]);
    setCategories(["All Categories", ...meta.categories]);
  }

  async function loadProducts(nextPage = page, nextPageSize = pageSize) {
    const res = await fetchProducts({
      q: q.trim() || undefined,
      brand: brand === "All Brands" ? undefined : brand,
      category: category === "All Categories" ? undefined : category,
      stockStatus,
      status,
      lowOnly,
      page: nextPage,
      pageSize: nextPageSize,
    });
    setProducts(res.items);
    setTotal(res.total);
  }

  React.useEffect(() => {
    (async () => {
      try {
        await loadMeta();
        await loadProducts(1, pageSize);
        setPage(1);
      } catch (e: any) {
        toastMsg("danger", e?.message || "Failed to load products.");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    (async () => {
      try {
        await loadProducts(1, pageSize);
        setPage(1);
      } catch (e: any) {
        toastMsg("danger", e?.message || "Failed to load products.");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, brand, category, stockStatus, status, lowOnly, pageSize]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);

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
    products.forEach((p) => {
      next[p.id] = checked;
    });
    setSelected(next);
  }

  function toggleOne(id: string, checked: boolean) {
    setSelected((prev) => ({ ...prev, [id]: checked }));
  }

  function openAdd() {
    setActiveProductId(null);
    setForm({
      id: "new",
      name: "",
      sku: "",
      barcode: "",
      imageUrl: "",
      brand: brands[1] ?? "CG Foods",
      category: categories[1] ?? "Groceries",
      retailPrice: 0,
      wholesalePrice: 0,
      thresholdQty: 1,
      stock: 0,
      lowStockThreshold: 5,
      status: "Active",
    });
    setOpenAddEdit(true);
  }

  function openEdit(p: Product) {
    setActiveProductId(p.id);
    setForm({ ...p });
    setOpenAddEdit(true);
  }

  function openViewProduct(p: Product) {
    setActiveProductId(p.id);
    setOpenView(true);
  }

  function requestDelete(p: Product) {
    setActiveProductId(p.id);
    setOpenConfirmDelete(true);
  }

  async function saveProduct() {
    if (!form.name.trim() || !form.sku.trim()) {
      toastMsg("danger", "Name and SKU are required.");
      return;
    }

    try {
      const payload = { ...form };
      delete (payload as any).id;

      if (activeProductId) {
        await updateProduct(activeProductId, payload as any);
        toastMsg("success", "Product updated.");
      } else {
        await createProduct(payload as any);
        toastMsg("success", "Product added.");
      }

      setOpenAddEdit(false);
      setActiveProductId(null);
      await loadProducts(1, pageSize);
      setPage(1);
      setSelected({});
    } catch (e: any) {
      toastMsg("danger", e?.message || "Failed to save product.");
    }
  }

  async function activateSelected() {
    if (selectedIds.length === 0) return;
    try {
      await bulkSetStatus(selectedIds, "Active");
      toastMsg("success", "Selected products activated.");
      setSelected({});
      await loadProducts(safePage, pageSize);
    } catch (e: any) {
      toastMsg("danger", e?.message || "Failed to activate selected.");
    }
  }

  async function deactivateSelected() {
    if (selectedIds.length === 0) return;
    try {
      await bulkSetStatus(selectedIds, "Inactive");
      toastMsg("success", "Selected products deactivated.");
      setSelected({});
      await loadProducts(safePage, pageSize);
    } catch (e: any) {
      toastMsg("danger", e?.message || "Failed to deactivate selected.");
    }
  }

  async function deleteSelectedSoft() {
    if (selectedIds.length === 0) return;
    try {
      await bulkSetStatus(selectedIds, "Inactive");
      toastMsg("info", "Selected products set to Inactive.");
      setSelected({});
      await loadProducts(safePage, pageSize);
    } catch (e: any) {
      toastMsg("danger", e?.message || "Failed to update selected.");
    }
  }

  async function confirmDeleteOne() {
    if (!activeProductId) return;
    try {
      await setProductStatus(activeProductId, "Inactive");
      toastMsg("info", "Product set to Inactive.");
      setOpenConfirmDelete(false);
      setActiveProductId(null);
      await loadProducts(safePage, pageSize);
    } catch (e: any) {
      toastMsg("danger", e?.message || "Failed to update product.");
    }
  }

  async function exportCsv() {
    toastMsg("info", "Export started.");
  }

  function prevPage() {
    const next = Math.max(1, safePage - 1);
    setPage(next);
    loadProducts(next, pageSize).catch((e: any) =>
      toastMsg("danger", e?.message || "Failed to load products."),
    );
  }

  function nextPage() {
    const next = Math.min(totalPages, safePage + 1);
    setPage(next);
    loadProducts(next, pageSize).catch((e: any) =>
      toastMsg("danger", e?.message || "Failed to load products."),
    );
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
        onImport={() => setOpenImport(true)}
        onExport={exportCsv}
        onActivate={activateSelected}
        onDeactivate={deactivateSelected}
        onSoftDelete={deleteSelectedSoft}
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
        start={total === 0 ? 0 : (safePage - 1) * pageSize}
        end={Math.min(total, (safePage - 1) * pageSize + products.length)}
        page={safePage}
        totalPages={totalPages}
        pageSize={pageSize}
        setPageSize={(n) => setPageSize(n)}
        prevPage={prevPage}
        nextPage={nextPage}
      />

      <ProductsModals
        brands={brands}
        categories={categories}
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
        onSave={saveProduct}
        onConfirmDelete={confirmDeleteOne}
        onUploadCsvClick={() => {
          setOpenImport(false);
          toastMsg("info", "Import started.");
        }}
        toast={toast}
        setToast={setToast}
      />
    </div>
  );
}
