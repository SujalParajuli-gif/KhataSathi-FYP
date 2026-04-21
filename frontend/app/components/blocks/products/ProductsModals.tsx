import React from "react";
import GoogleIcon from "~/components/ui/GIcon";
import ProductImage from "~/components/ui/ProductImage";
import type {
  Product,
  ProductStatus,
  ToastKind,
} from "~/lib/domain/products/products.types";
import {
  cn,
  formatNpr,
  getStockFlag,
} from "~/lib/domain/products/products.helpers";

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

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-[6px]">
      <div className="text-[12px] font-semibold text-[#565449]">{label}</div>
      {children}
      {error ? <div className="text-[12px] font-semibold text-rose-600">{error}</div> : null}
    </div>
  );
}

function Button({
  children,
  variant = "secondary",
  onClick,
  disabled,
  icon,
}: {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "danger";
  onClick?: () => void;
  disabled?: boolean;
  icon?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-[8px] rounded-[12px] px-[14px] py-[10px] text-[13px] font-semibold border active:scale-[0.98] transition";
  const styles =
    variant === "primary"
      ? "border-[#11120d] bg-[#11120d] text-white hover:bg-[#2a2c27]"
      : variant === "danger"
        ? "border-[#FECDD3] bg-[#FFF1F2] text-[#BE123C] hover:bg-rose-100"
        : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6] hover:text-[#000000]";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(base, styles, disabled && "opacity-50 pointer-events-none")}
    >
      {icon ? <GoogleIcon name={icon} className="text-inherit" /> : null}
      {children}
    </button>
  );
}

function Select({
  value,
  onChange,
  options,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  error?: string;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        "w-full rounded-[12px] border bg-white px-[12px] py-[10px] text-[14px] text-[#000000] outline-none",
        error ? "border-rose-300" : "border-[#CFCFD3]",
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function ThresholdModeSwitch({
  mode,
  onChange,
  defaultLabel,
  customLabel,
}: {
  mode: "default" | "custom";
  onChange: (mode: "default" | "custom") => void;
  defaultLabel: string;
  customLabel: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-[8px]">
      <button
        type="button"
        onClick={() => onChange("default")}
        className={cn(
          "rounded-[12px] border px-[12px] py-[10px] text-left text-[12px] font-semibold transition",
          mode === "default"
            ? "border-[#11120d] bg-[#11120d] text-white"
            : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6]",
        )}
      >
        {defaultLabel}
      </button>
      <button
        type="button"
        onClick={() => onChange("custom")}
        className={cn(
          "rounded-[12px] border px-[12px] py-[10px] text-left text-[12px] font-semibold transition",
          mode === "custom"
            ? "border-[#11120d] bg-[#11120d] text-white"
            : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6]",
        )}
      >
        {customLabel}
      </button>
    </div>
  );
}

function StatusPill({ status }: { status: ProductStatus }) {
  const cls =
    status === "Active"
      ? "bg-[#EAF8EF] text-[#179B4D] border-[#9DD8B2]"
      : "bg-[#F3F4F6] text-[#565449] border-[#CFCFD3]";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-[10px] py-[4px] text-[12px] font-semibold border",
        cls,
      )}
    >
      {status}
    </span>
  );
}

function StockPill({
  flag,
}: {
  flag: "In Stock" | "Low Stock" | "Out of Stock";
}) {
  const cls =
    flag === "In Stock"
      ? "bg-[#EAF8EF] text-[#179B4D] border-[#9DD8B2]"
      : flag === "Low Stock"
        ? "bg-[#FFF7E8] text-[#B7791F] border-[#F6D28B]"
        : "bg-[#FFF1F2] text-[#BE123C] border-[#FECDD3]";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-[10px] py-[4px] text-[12px] font-semibold border",
        cls,
      )}
    >
      {flag}
    </span>
  );
}

function ModalShell({
  open,
  title,
  children,
  footer,
  onClose,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="Close modal overlay"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div className="absolute inset-0 flex items-center justify-center p-[14px]">
        <div className="w-full max-w-[760px] overflow-hidden rounded-[16px] border border-[#CFCFD3] bg-white ">
          <div className="flex items-center justify-between border-b border-[#CFCFD3] px-[18px] py-[14px]">
            <div className="text-[15px] font-semibold text-[#000000]">{title}</div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-[36px] w-[36px] items-center justify-center rounded-[12px] border border-[#CFCFD3] hover:bg-[#F3F4F6]"
              aria-label="Close modal"
            >
              <GoogleIcon name="close" className="text-[#565449]" />
            </button>
          </div>

          <div className="px-[18px] py-[16px]">{children}</div>

          {footer ? (
            <div className="border-t border-[#CFCFD3] bg-[#F3F4F6]/75 px-[18px] py-[14px]">
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Toast({
  open,
  kind,
  message,
  onClose,
}: {
  open: boolean;
  kind: ToastKind;
  message: string;
  onClose: () => void;
}) {
  if (!open) return null;
  const cls =
    kind === "success"
      ? "bg-[#EAF8EF] border-[#9DD8B2] text-[#179B4D]"
      : kind === "danger"
        ? "bg-[#FFF1F2] border-[#FECDD3] text-[#BE123C]"
        : "bg-[#F3F4F6] border-[#CFCFD3] text-[#565449]";
  return (
    <div className="fixed bottom-[16px] right-[16px] z-50">
      <div
        className={cn(
          "w-[320px] rounded-[14px] border px-[14px] py-[12px] ",
          cls,
        )}
      >
        <div className="flex items-start justify-between gap-[10px]">
          <div className="text-[13px] font-semibold">{message}</div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-[10px] border border-transparent hover:border-[#CFCFD3] hover:bg-white"
            aria-label="Close toast"
          >
            <GoogleIcon name="close" className="text-inherit" />
          </button>
        </div>
      </div>
    </div>
  );
}

// this component holds all the modals for the products page (Add, Edit, View, Import, Confirm Delete)
// it keeps the main Products page cleaner by separating all modal jsx and state wiring into this file
export default function ProductsModals({
  brands,
  categories,
  businessDefaults,

  openAddEdit,
  setOpenAddEdit,
  openImport,
  setOpenImport,
  openView,
  setOpenView,
  openConfirmDelete,
  setOpenConfirmDelete,

  activeProduct,
  activeProductId,

  form,
  setForm,
  formErrors,
  productImagePreview,
  productImageName,
  onProductImageChange,
  onClearProductImage,

  onSave,
  onConfirmDelete,
  bulkAction,
  onCloseBulkAction,
  onConfirmBulkAction,
  onEditActiveProduct,
  importFile,
  setImportFile,
  importBusy,
  importError,
  importResult,
  onCloseImport,
  onUploadCsvClick,
  toast,
  setToast,
}: {
  brands: string[];
  categories: string[];
  businessDefaults: {
    defaultLowStockThreshold: number;
    defaultWholesaleQtyThreshold: number;
  };

  openAddEdit: boolean;
  setOpenAddEdit: (v: boolean) => void;

  openImport: boolean;
  setOpenImport: (v: boolean) => void;

  openView: boolean;
  setOpenView: (v: boolean) => void;

  openConfirmDelete: boolean;
  setOpenConfirmDelete: (v: boolean) => void;

  activeProduct: Product | null;
  activeProductId: string | null;

  form: Product;
  setForm: React.Dispatch<React.SetStateAction<Product>>;
  formErrors: ProductFormErrors;
  productImagePreview: string;
  productImageName: string;
  onProductImageChange: (file: File | null) => void;
  onClearProductImage: () => void;

  onSave: () => void;
  onConfirmDelete: () => void;
  bulkAction: {
    title: string;
    message: string;
    confirmLabel: string;
  } | null;
  onCloseBulkAction: () => void;
  onConfirmBulkAction: () => void;
  onEditActiveProduct: () => void;
  importFile: File | null;
  setImportFile: (file: File | null) => void;
  importBusy: boolean;
  importError: string;
  importResult: CsvImportResult | null;
  onCloseImport: () => void;
  onUploadCsvClick: () => void;

  toast: { open: boolean; kind: ToastKind; message: string };
  setToast: React.Dispatch<
    React.SetStateAction<{ open: boolean; kind: ToastKind; message: string }>
  >;
}) {
  return (
    <>
      <ModalShell
        open={openAddEdit}
        title={activeProductId ? "Edit Product" : "Add Product"}
        onClose={() => setOpenAddEdit(false)}
        footer={
          <div className="flex items-center justify-end gap-[10px]">
            <Button onClick={() => setOpenAddEdit(false)}>Cancel</Button>
            <Button variant="primary" icon="save" onClick={onSave}>
              Save
            </Button>
          </div>
        }
      >
        <div className="grid grid-cols-1 gap-[12px] md:grid-cols-2">
          <div className="md:col-span-2">
            <Field label="Product Image" error={formErrors.image}>
              <div className="rounded-[14px] border border-[#CFCFD3] bg-[#F3F4F6] p-[12px]">
                <div className="flex flex-col gap-[12px] md:flex-row md:items-center">
                  <ProductImage
                    src={productImagePreview}
                    alt={form.name || "Product preview"}
                    className="flex h-[110px] w-[110px] items-center justify-center overflow-hidden rounded-[14px] border border-[#CFCFD3] bg-white"
                    iconSizePx={34}
                    iconClassName="text-[#8C8889]"
                  />

                  <div className="min-w-0 flex-1 space-y-[10px]">
                    <div className="text-[13px] text-[#565449]">
                      Upload an image to save under <span className="font-semibold">uploads/products</span>.
                    </div>

                    <input
                      type="file"
                      accept="image/*"
                      onChange={(event) =>
                        onProductImageChange(event.target.files?.[0] || null)
                      }
                      className="w-full rounded-[12px] border border-[#CFCFD3] bg-white px-[12px] py-[10px] text-[14px] text-[#000000]"
                    />

                    <div className="flex flex-wrap items-center gap-[10px]">
                      <div className="text-[12px] text-[#8C8889]">
                        {productImageName || (form.imageUrl ? "Saved image will be kept." : "No image selected.")}
                      </div>
                      {(productImageName || form.imageUrl) ? (
                        <button
                          type="button"
                          onClick={onClearProductImage}
                          className="text-[12px] font-semibold text-slate-600 hover:text-slate-900"
                        >
                          {productImageName ? "Clear selection" : "Remove image"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            </Field>
          </div>

          <Field label="Product Name" error={formErrors.name}>
            <input
              value={form.name}
              onChange={(event) =>
                setForm((product) => ({ ...product, name: event.target.value }))
              }
              className={cn(
                "w-full rounded-[12px] border bg-white px-[12px] py-[10px] text-[#000000] outline-none",
                formErrors.name ? "border-rose-300" : "border-[#CFCFD3]",
              )}
              placeholder="e.g. Wai Wai Noodles (Chicken)"
            />
          </Field>

          <Field label="SKU" error={formErrors.sku}>
            <input
              value={form.sku}
              onChange={(event) =>
                setForm((product) => ({ ...product, sku: event.target.value }))
              }
              className={cn(
                "w-full rounded-[12px] border bg-white px-[12px] py-[10px] text-[#000000] outline-none",
                formErrors.sku ? "border-rose-300" : "border-[#CFCFD3]",
              )}
              placeholder="e.g. 890123456789"
            />
          </Field>

          <Field label="Barcode">
            <input
              value={form.barcode || ""}
              onChange={(event) =>
                setForm((product) => ({ ...product, barcode: event.target.value }))
              }
              className="w-full rounded-[12px] border border-[#CFCFD3] bg-white px-[12px] py-[10px] text-[#000000] outline-none"
              placeholder="Optional"
            />
          </Field>

          <Field label="Status">
            <Select
              value={form.status}
              onChange={(value) => setForm((product) => ({ ...product, status: value as any }))}
              options={[
                { value: "Active", label: "Active" },
                { value: "Inactive", label: "Inactive" },
              ]}
            />
          </Field>

          <Field label="Brand">
            <Select
              value={form.brand}
              onChange={(value) => setForm((product) => ({ ...product, brand: value }))}
              options={brands
                .filter((brand) => brand !== "All Brands")
                .map((brand) => ({ value: brand, label: brand }))}
            />
          </Field>

          <Field label="Category">
            <Select
              value={form.category}
              onChange={(value) => setForm((product) => ({ ...product, category: value }))}
              options={categories
                .filter((category) => category !== "All Categories")
                .map((category) => ({ value: category, label: category }))}
            />
          </Field>

          <Field label="Retail Price (NPR)" error={formErrors.retailPrice}>
            <input
              type="number"
              value={form.retailPrice}
              onChange={(event) =>
                setForm((product) => ({
                  ...product,
                  retailPrice: Number(event.target.value),
                }))
              }
              className={cn(
                "w-full rounded-[12px] border bg-white px-[12px] py-[10px] text-[#000000] outline-none",
                formErrors.retailPrice ? "border-rose-300" : "border-[#CFCFD3]",
              )}
            />
          </Field>

          <Field label="Wholesale Price (NPR)" error={formErrors.wholesalePrice}>
            <input
              type="number"
              value={form.wholesalePrice}
              onChange={(event) =>
                setForm((product) => ({
                  ...product,
                  wholesalePrice: Number(event.target.value),
                }))
              }
              className={cn(
                "w-full rounded-[12px] border bg-white px-[12px] py-[10px] text-[#000000] outline-none",
                formErrors.wholesalePrice ? "border-rose-300" : "border-[#CFCFD3]",
              )}
            />
          </Field>

          <div className="md:col-span-2">
            <Field label="Wholesale Quantity Threshold" error={formErrors.thresholdQty}>
              <div className="space-y-[10px] rounded-[14px] border border-[#CFCFD3] bg-[#F3F4F6] p-[12px]">
                <ThresholdModeSwitch
                  mode={form.thresholdQtyMode}
                  onChange={(mode) =>
                    setForm((product) => ({
                      ...product,
                      thresholdQtyMode: mode,
                      thresholdQty:
                        mode === "default"
                          ? businessDefaults.defaultWholesaleQtyThreshold
                          : product.thresholdQty || businessDefaults.defaultWholesaleQtyThreshold,
                    }))
                  }
                  defaultLabel={`Use business default (${businessDefaults.defaultWholesaleQtyThreshold})`}
                  customLabel="Set custom threshold"
                />
                {form.thresholdQtyMode === "default" ? (
                  <div className="rounded-[12px] border border-[#CFCFD3] bg-white px-[12px] py-[10px] text-[12px] font-semibold text-[#565449]">
                    This product will follow future admin wholesale threshold updates.
                  </div>
                ) : (
                  <input
                    type="number"
                    min={1}
                    value={form.thresholdQty}
                    onChange={(event) =>
                      setForm((product) => ({
                        ...product,
                        thresholdQty: Number(event.target.value),
                      }))
                    }
                    className={cn(
                      "w-full rounded-[12px] border bg-white px-[12px] py-[10px] text-[#000000] outline-none",
                      formErrors.thresholdQty
                        ? "border-rose-300"
                        : "border-[#CFCFD3]",
                    )}
                  />
                )}
              </div>
            </Field>
          </div>

          <Field label="Stock" error={formErrors.stock}>
            <input
              type="number"
              value={form.stock}
              onChange={(event) =>
                setForm((product) => ({ ...product, stock: Number(event.target.value) }))
              }
              className={cn(
                "w-full rounded-[12px] border bg-white px-[12px] py-[10px] text-[#000000] outline-none",
                formErrors.stock ? "border-rose-300" : "border-[#CFCFD3]",
              )}
              />
          </Field>

          <Field
            label="Stock Alert Threshold"
            error={formErrors.lowStockThreshold}
          >
            <div className="space-y-[10px] rounded-[14px] border border-[#CFCFD3] bg-[#F3F4F6] p-[12px]">
              <ThresholdModeSwitch
                mode={form.lowStockThresholdMode}
                onChange={(mode) =>
                  setForm((product) => ({
                    ...product,
                    lowStockThresholdMode: mode,
                    lowStockThreshold:
                      mode === "default"
                        ? businessDefaults.defaultLowStockThreshold
                        : product.lowStockThreshold ?? businessDefaults.defaultLowStockThreshold,
                  }))
                }
                defaultLabel={`Use business default (${businessDefaults.defaultLowStockThreshold})`}
                customLabel="Set custom threshold"
              />
              {form.lowStockThresholdMode === "default" ? (
                <div className="rounded-[12px] border border-[#CFCFD3] bg-white px-[12px] py-[10px] text-[12px] font-semibold text-[#565449]">
                  This product will follow future admin stock alert threshold updates.
                </div>
              ) : (
                <input
                  type="number"
                  min={0}
                  value={form.lowStockThreshold}
                  onChange={(event) =>
                    setForm((product) => ({
                      ...product,
                      lowStockThreshold: Number(event.target.value),
                    }))
                  }
                  className={cn(
                    "w-full rounded-[12px] border bg-white px-[12px] py-[10px] text-[#000000] outline-none",
                    formErrors.lowStockThreshold
                      ? "border-rose-300"
                      : "border-[#CFCFD3]",
                  )}
                />
              )}
            </div>
          </Field>
        </div>
      </ModalShell>

      <ModalShell
        open={openImport}
        title="Import Products (CSV)"
        onClose={onCloseImport}
        footer={
          <div className="flex items-center justify-end gap-[10px]">
            <Button onClick={onCloseImport}>Cancel</Button>
            <Button
              variant="primary"
              icon="upload_file"
              onClick={onUploadCsvClick}
              disabled={importBusy}
            >
              {importBusy ? "Uploading..." : "Upload"}
            </Button>
          </div>
        }
      >
        <div className="space-y-[14px]">
          <div className="text-[13px] text-[#565449]">
            Upload a CSV file to create new products in bulk. Existing SKU or
            barcode matches are reported as row errors instead of being
            overwritten.
          </div>

          <div className="rounded-[14px] border border-[#CFCFD3] bg-[#F3F4F6] p-[12px]">
            <div className="mb-[6px] text-[12px] font-semibold text-[#565449]">
              Supported import fields
            </div>
            <div className="text-[12px] leading-relaxed text-[#565449]">
              Use these CSV column names: <span className="font-semibold">name</span>,{" "}
              <span className="font-semibold">sku</span>,{" "}
              <span className="font-semibold">barcode</span>,{" "}
              <span className="font-semibold">brand</span>,{" "}
              <span className="font-semibold">category</span>,{" "}
              <span className="font-semibold">retailPrice</span>,{" "}
              <span className="font-semibold">wholesalePrice</span>,{" "}
              <span className="font-semibold">stock</span>.
            </div>
            <div className="mt-[8px] text-[12px] text-[#8C8889]">
              Required fields are name, sku, brand, retailPrice, wholesalePrice, and stock.
            </div>
            <div className="mt-[6px] text-[12px] text-[#8C8889]">
              Wholesale threshold, stock alert threshold, and status will use
              business defaults. Brands from the CSV are matched to existing
              brands and created automatically when needed.
            </div>
          </div>

          <div className="rounded-[14px] border border-[#CFCFD3] bg-white p-[12px]">
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => setImportFile(event.target.files?.[0] || null)}
              className="w-full rounded-[12px] border border-[#CFCFD3] bg-white px-[12px] py-[10px] text-[#000000]"
            />
            <div className="mt-[8px] text-[12px] text-[#8C8889]">
              {importFile ? importFile.name : "No CSV file selected yet."}
            </div>
          </div>

          {importError ? (
            <div className="rounded-[14px] border border-rose-200 bg-rose-50 px-[12px] py-[10px] text-[12px] font-semibold text-rose-700">
              {importError}
            </div>
          ) : null}

          {importResult ? (
            <div className="space-y-[10px]">
                <div className="grid grid-cols-1 gap-[10px] md:grid-cols-3">
                <div className="rounded-[14px] border border-[#CFCFD3] bg-[#F3F4F6]/80 p-[12px]">
                  <div className="text-[11px] font-semibold uppercase  text-[#8C8889]">
                    Rows Processed
                  </div>
                  <div className="mt-[6px] text-[22px] font-extrabold text-[#000000]">
                    {importResult.totalRows}
                  </div>
                </div>
                <div className="rounded-[14px] border border-emerald-200 bg-emerald-50 p-[12px]">
                  <div className="text-[11px] font-semibold uppercase  text-emerald-700">
                    Imported
                  </div>
                  <div className="mt-[6px] text-[22px] font-extrabold text-emerald-800">
                    {importResult.createdCount}
                  </div>
                </div>
                <div className="rounded-[14px] border border-rose-200 bg-rose-50 p-[12px]">
                  <div className="text-[11px] font-semibold uppercase  text-rose-700">
                    Row Errors
                  </div>
                  <div className="mt-[6px] text-[22px] font-extrabold text-rose-800">
                    {importResult.errorCount}
                  </div>
                </div>
              </div>

              {importResult.errors.length > 0 ? (
                <div className="rounded-[14px] border border-[#CFCFD3] bg-white">
                  <div className="border-b border-[#CFCFD3] px-[12px] py-[10px] text-[12px] font-semibold text-[#000000]">
                    Row-level issues
                  </div>
                  <div className="max-h-[220px] space-y-[8px] overflow-y-auto p-[12px]">
                    {importResult.errors.map((errorItem) => (
                      <div
                        key={`${errorItem.rowNumber}-${errorItem.sku || errorItem.name || errorItem.message}`}
                        className="rounded-[12px] border border-rose-200 bg-rose-50 px-[12px] py-[10px] text-[12px] text-rose-800"
                      >
                        <div className="font-semibold">
                          Row {errorItem.rowNumber}
                          {errorItem.sku ? ` | SKU ${errorItem.sku}` : ""}
                          {!errorItem.sku && errorItem.name ? ` | ${errorItem.name}` : ""}
                        </div>
                        <div className="mt-[4px]">{errorItem.message}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="rounded-[14px] border border-emerald-200 bg-emerald-50 px-[12px] py-[10px] text-[12px] font-semibold text-emerald-800">
                  All rows imported successfully.
                </div>
              )}
            </div>
          ) : null}
        </div>
      </ModalShell>

      <ModalShell
        open={openView}
        title="Product Details"
        onClose={() => setOpenView(false)}
        footer={
          <div className="flex items-center justify-end gap-[10px]">
            <Button onClick={() => setOpenView(false)}>Close</Button>
            {activeProduct ? (
              <Button
                variant="primary"
                icon="edit"
                onClick={onEditActiveProduct}
              >
                Edit
              </Button>
            ) : null}
          </div>
        }
      >
        {activeProduct ? (
          <div className="space-y-[16px]">
            <div className="flex flex-col gap-[14px] md:flex-row md:items-start">
              <ProductImage
                src={activeProduct.imageUrl}
                alt={activeProduct.name}
                className="flex h-[124px] w-[124px] items-center justify-center overflow-hidden rounded-[16px] border border-[#CFCFD3] bg-[#F3F4F6]"
                iconSizePx={40}
                iconClassName="text-[#8C8889]"
              />

              <div className="grid flex-1 grid-cols-1 gap-[12px] md:grid-cols-2">
                <div className="space-y-[4px]">
                  <div className="text-[12px] font-semibold text-[#8C8889]">Name</div>
                  <div className="text-[14px] font-semibold text-[#000000]">
                    {activeProduct.name}
                  </div>
                </div>

                <div className="space-y-[4px]">
                  <div className="text-[12px] font-semibold text-[#8C8889]">SKU</div>
                  <div className="text-[14px] font-semibold text-[#000000]">
                    {activeProduct.sku}
                  </div>
                </div>

                <div className="space-y-[4px]">
                  <div className="text-[12px] font-semibold text-[#8C8889]">
                    Barcode
                  </div>
                  <div className="text-[14px] font-semibold text-[#000000]">
                    {activeProduct.barcode || "-"}
                  </div>
                </div>

                <div className="space-y-[4px]">
                  <div className="text-[12px] font-semibold text-[#8C8889]">Status</div>
                  <div>
                    <StatusPill status={activeProduct.status} />
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-[12px] md:grid-cols-2">
              <div className="space-y-[4px]">
                <div className="text-[12px] font-semibold text-[#8C8889]">Brand</div>
                <div className="text-[14px] font-semibold text-[#000000]">
                  {activeProduct.brand}
                </div>
              </div>

              <div className="space-y-[4px]">
                <div className="text-[12px] font-semibold text-[#8C8889]">Category</div>
                <div className="text-[14px] font-semibold text-[#000000]">
                  {activeProduct.category}
                </div>
              </div>

              <div className="space-y-[4px]">
                <div className="text-[12px] font-semibold text-[#8C8889]">
                  Retail Price
                </div>
                <div className="text-[14px] font-semibold text-[#000000]">
                  {formatNpr(activeProduct.retailPrice)}
                </div>
              </div>

              <div className="space-y-[4px]">
                <div className="text-[12px] font-semibold text-[#8C8889]">
                  Wholesale Price
                </div>
                <div className="text-[14px] font-semibold text-[#000000]">
                  {formatNpr(activeProduct.wholesalePrice)}
                </div>
              </div>

              <div className="space-y-[4px]">
                <div className="text-[12px] font-semibold text-[#8C8889]">
                  Threshold Qty
                </div>
                <div className="flex items-center gap-[8px]">
                  <div className="text-[14px] font-semibold text-[#000000]">
                    {activeProduct.thresholdQty}
                  </div>
                  <span className="rounded-full border border-[#CFCFD3] bg-[#F3F4F6] px-[8px] py-[2px] text-[11px] font-semibold text-[#565449]">
                    {activeProduct.thresholdQtyMode === "default"
                      ? "Business default"
                      : "Custom"}
                  </span>
                </div>
              </div>

              <div className="space-y-[4px]">
                <div className="text-[12px] font-semibold text-[#8C8889]">Stock</div>
                <div className="flex items-center gap-[10px]">
                  <div className="text-[14px] font-semibold text-[#000000]">
                    {activeProduct.stock.toLocaleString()}
                  </div>
                  <StockPill flag={getStockFlag(activeProduct)} />
                </div>
              </div>

              <div className="space-y-[4px] md:col-span-2">
                <div className="text-[12px] font-semibold text-[#8C8889]">
                  Low Stock Threshold
                </div>
                <div className="flex items-center gap-[8px]">
                  <div className="text-[14px] font-semibold text-[#000000]">
                    {activeProduct.lowStockThreshold}
                  </div>
                  <span className="rounded-full border border-[#CFCFD3] bg-[#F3F4F6] px-[8px] py-[2px] text-[11px] font-semibold text-[#565449]">
                    {activeProduct.lowStockThresholdMode === "default"
                      ? "Business default"
                      : "Custom"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="text-[14px] text-[#8C8889]">No product selected.</div>
        )}
      </ModalShell>

      <ModalShell
        open={openConfirmDelete}
        title="Confirm delete"
        onClose={() => setOpenConfirmDelete(false)}
        footer={
          <div className="flex items-center justify-end gap-[10px]">
            <Button onClick={() => setOpenConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" icon="delete" onClick={onConfirmDelete}>
              Set Inactive
            </Button>
          </div>
        }
      >
        <div className="space-y-[10px]">
          <div className="text-[14px] text-[#565449]">
            This will set the product to <span className="font-semibold">Inactive</span> (soft delete).
          </div>
          <div className="text-[12px] text-[#8C8889]">
            Soft delete is safer for invoice history and audit logs.
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={!!bulkAction}
        title={bulkAction?.title || "Confirm action"}
        onClose={onCloseBulkAction}
        footer={
          <div className="flex items-center justify-end gap-[10px]">
            <Button onClick={onCloseBulkAction}>Cancel</Button>
            <Button variant="danger" icon="warning" onClick={onConfirmBulkAction}>
              {bulkAction?.confirmLabel || "Confirm"}
            </Button>
          </div>
        }
      >
        <div className="space-y-[10px]">
          <div className="text-[14px] text-[#565449]">{bulkAction?.message}</div>
          <div className="text-[12px] text-[#8C8889]">
            This keeps invoice history and audit logs intact while removing these products from active selling flows.
          </div>
        </div>
      </ModalShell>

      <Toast
        open={toast.open}
        kind={toast.kind}
        message={toast.message}
        onClose={() => setToast((current) => ({ ...current, open: false }))}
      />
    </>
  );
}

