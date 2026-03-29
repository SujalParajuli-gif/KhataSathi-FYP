import React from "react";
import GoogleIcon from "~/components/ui/GIcon";
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

const API_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

type ProductFormErrors = Partial<
  Record<
    "name" | "sku" | "retailPrice" | "wholesalePrice" | "stock" | "lowStockThreshold" | "image",
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

function resolveImageUrl(imageUrl?: string) {
  if (!imageUrl) return "";
  if (imageUrl.startsWith("blob:") || imageUrl.startsWith("http")) return imageUrl;
  return `${API_URL}${imageUrl}`;
}

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
      <div className="text-[12px] font-semibold text-[var(--app-text-soft)]">{label}</div>
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
        ? "border-[var(--app-danger-border)] bg-[var(--app-danger-bg)] text-[var(--app-danger-text)] hover:bg-rose-100"
        : "border-[var(--app-border)] bg-white text-[var(--app-text-soft)] hover:bg-[var(--app-surface-muted)] hover:text-[var(--app-text)]";
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
        "w-full rounded-[12px] border bg-white px-[12px] py-[10px] text-[14px] text-[var(--app-text)] outline-none",
        error ? "border-rose-300" : "border-[var(--app-border)]",
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

function StatusPill({ status }: { status: ProductStatus }) {
  const cls =
    status === "Active"
      ? "bg-[var(--app-success-bg)] text-[var(--app-success-text)] border-[var(--app-success-border)]"
      : "bg-[var(--app-surface-muted)] text-[var(--app-text-soft)] border-[var(--app-border)]";
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
      ? "bg-[var(--app-success-bg)] text-[var(--app-success-text)] border-[var(--app-success-border)]"
      : flag === "Low Stock"
        ? "bg-[var(--app-warning-bg)] text-[var(--app-warning-text)] border-[var(--app-warning-border)]"
        : "bg-[var(--app-danger-bg)] text-[var(--app-danger-text)] border-[var(--app-danger-border)]";
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
        <div className="w-full max-w-[760px] overflow-hidden rounded-[16px] border border-[var(--app-border)] bg-white shadow-[0_30px_90px_-45px_rgba(17,18,13,0.65)]">
          <div className="flex items-center justify-between border-b border-[var(--app-border)] px-[18px] py-[14px]">
            <div className="text-[15px] font-semibold text-[var(--app-text)]">{title}</div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-[36px] w-[36px] items-center justify-center rounded-[12px] border border-[var(--app-border)] hover:bg-[var(--app-surface-muted)]"
              aria-label="Close modal"
            >
              <GoogleIcon name="close" className="text-[var(--app-text-soft)]" />
            </button>
          </div>

          <div className="px-[18px] py-[16px]">{children}</div>

          {footer ? (
            <div className="border-t border-[var(--app-border)] bg-[var(--app-surface-muted)]/75 px-[18px] py-[14px]">
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
      ? "bg-[var(--app-success-bg)] border-[var(--app-success-border)] text-[var(--app-success-text)]"
      : kind === "danger"
        ? "bg-[var(--app-danger-bg)] border-[var(--app-danger-border)] text-[var(--app-danger-text)]"
        : "bg-[var(--app-surface-muted)] border-[var(--app-border)] text-[var(--app-text-soft)]";
  return (
    <div className="fixed bottom-[16px] right-[16px] z-50">
      <div
        className={cn(
          "w-[320px] rounded-[14px] border px-[14px] py-[12px] shadow-sm",
          cls,
        )}
      >
        <div className="flex items-start justify-between gap-[10px]">
          <div className="text-[13px] font-semibold">{message}</div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-[10px] border border-transparent hover:border-[var(--app-border)] hover:bg-white"
            aria-label="Close toast"
          >
            <GoogleIcon name="close" className="text-inherit" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ProductsModals({
  brands,
  categories,

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
  const previewUrl = resolveImageUrl(productImagePreview);
  const activeImageUrl = resolveImageUrl(activeProduct?.imageUrl);

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
              <div className="rounded-[14px] border border-[var(--app-border)] bg-[var(--app-surface-muted)] p-[12px]">
                <div className="flex flex-col gap-[12px] md:flex-row md:items-center">
                  <div className="flex h-[110px] w-[110px] items-center justify-center overflow-hidden rounded-[14px] border border-[var(--app-border)] bg-white">
                    {previewUrl ? (
                      <img
                        src={previewUrl}
                        alt={form.name || "Product preview"}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <GoogleIcon name="inventory_2" className="text-[34px] text-[var(--app-text-muted)]" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1 space-y-[10px]">
                    <div className="text-[13px] text-[var(--app-text-soft)]">
                      Upload an image to save under <span className="font-semibold">uploads/products</span>.
                    </div>

                    <input
                      type="file"
                      accept="image/*"
                      onChange={(event) =>
                        onProductImageChange(event.target.files?.[0] || null)
                      }
                      className="w-full rounded-[12px] border border-[var(--app-border)] bg-white px-[12px] py-[10px] text-[14px] text-[var(--app-text)]"
                    />

                    <div className="flex flex-wrap items-center gap-[10px]">
                      <div className="text-[12px] text-[var(--app-text-muted)]">
                        {productImageName || (form.imageUrl ? "Saved image will be kept." : "No image selected.")}
                      </div>
                      {(productImageName || form.imageUrl) ? (
                        <button
                          type="button"
                          onClick={onClearProductImage}
                          className="text-[12px] font-semibold text-slate-600 hover:text-slate-900"
                        >
                          Clear selection
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
                "w-full rounded-[12px] border bg-white px-[12px] py-[10px] text-[var(--app-text)] outline-none",
                formErrors.name ? "border-rose-300" : "border-[var(--app-border)]",
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
                "w-full rounded-[12px] border bg-white px-[12px] py-[10px] text-[var(--app-text)] outline-none",
                formErrors.sku ? "border-rose-300" : "border-[var(--app-border)]",
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
              className="w-full rounded-[12px] border border-[var(--app-border)] bg-white px-[12px] py-[10px] text-[var(--app-text)] outline-none"
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
                "w-full rounded-[12px] border bg-white px-[12px] py-[10px] text-[var(--app-text)] outline-none",
                formErrors.retailPrice ? "border-rose-300" : "border-[var(--app-border)]",
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
                "w-full rounded-[12px] border bg-white px-[12px] py-[10px] text-[var(--app-text)] outline-none",
                formErrors.wholesalePrice ? "border-rose-300" : "border-[var(--app-border)]",
              )}
            />
          </Field>

          <Field label="Stock" error={formErrors.stock}>
            <input
              type="number"
              value={form.stock}
              onChange={(event) =>
                setForm((product) => ({ ...product, stock: Number(event.target.value) }))
              }
              className={cn(
                "w-full rounded-[12px] border bg-white px-[12px] py-[10px] text-[var(--app-text)] outline-none",
                formErrors.stock ? "border-rose-300" : "border-[var(--app-border)]",
              )}
              />
          </Field>

          <Field
            label="Stock Alert Threshold"
            error={formErrors.lowStockThreshold}
          >
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
                "w-full rounded-[12px] border bg-white px-[12px] py-[10px] text-[var(--app-text)] outline-none",
                formErrors.lowStockThreshold
                  ? "border-rose-300"
                  : "border-[var(--app-border)]",
              )}
            />
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
          <div className="text-[13px] text-[var(--app-text-soft)]">
            Upload a CSV file to create new products in bulk. Existing SKU or
            barcode matches are reported as row errors instead of being
            overwritten.
          </div>

          <div className="rounded-[14px] border border-[var(--app-border)] bg-[var(--app-surface-muted)] p-[12px]">
            <div className="mb-[6px] text-[12px] font-semibold text-[var(--app-text-soft)]">
              Expected columns
            </div>
            <div className="text-[12px] leading-relaxed text-[var(--app-text-soft)]">
              name, sku, barcode, brand, category, retailPrice,
              wholesalePrice, wholesaleQtyThreshold or thresholdQty, stock,
              lowStockThreshold, status
            </div>
            <div className="mt-[8px] text-[12px] text-[var(--app-text-muted)]">
              Brand names from the CSV are matched to existing brands and will
              be created automatically when needed.
            </div>
            <a
              href="/assets/static/sample-products.csv"
              download
              className="mt-[10px] inline-flex items-center gap-[6px] font-semibold text-[var(--app-text)] hover:text-[var(--app-text-soft)]"
            >
              <GoogleIcon name="download" className="text-inherit" />
              Download sample CSV template
            </a>
          </div>

          <div className="rounded-[14px] border border-[var(--app-border)] bg-white p-[12px]">
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => setImportFile(event.target.files?.[0] || null)}
              className="w-full rounded-[12px] border border-[var(--app-border)] bg-white px-[12px] py-[10px] text-[var(--app-text)]"
            />
            <div className="mt-[8px] text-[12px] text-[var(--app-text-muted)]">
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
                <div className="rounded-[14px] border border-[var(--app-border)] bg-[var(--app-surface-muted)]/80 p-[12px]">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--app-text-muted)]">
                    Rows Processed
                  </div>
                  <div className="mt-[6px] text-[22px] font-extrabold text-[var(--app-text)]">
                    {importResult.totalRows}
                  </div>
                </div>
                <div className="rounded-[14px] border border-emerald-200 bg-emerald-50 p-[12px]">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700">
                    Imported
                  </div>
                  <div className="mt-[6px] text-[22px] font-extrabold text-emerald-800">
                    {importResult.createdCount}
                  </div>
                </div>
                <div className="rounded-[14px] border border-rose-200 bg-rose-50 p-[12px]">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-rose-700">
                    Row Errors
                  </div>
                  <div className="mt-[6px] text-[22px] font-extrabold text-rose-800">
                    {importResult.errorCount}
                  </div>
                </div>
              </div>

              {importResult.errors.length > 0 ? (
                <div className="rounded-[14px] border border-[var(--app-border)] bg-white">
                  <div className="border-b border-[var(--app-border)] px-[12px] py-[10px] text-[12px] font-semibold text-[var(--app-text)]">
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
                          {errorItem.sku ? ` • SKU ${errorItem.sku}` : ""}
                          {!errorItem.sku && errorItem.name ? ` • ${errorItem.name}` : ""}
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
              <div className="flex h-[124px] w-[124px] items-center justify-center overflow-hidden rounded-[16px] border border-[var(--app-border)] bg-[var(--app-surface-muted)]">
                {activeImageUrl ? (
                  <img
                    src={activeImageUrl}
                    alt={activeProduct.name}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <GoogleIcon name="inventory_2" className="text-[40px] text-[var(--app-text-muted)]" />
                )}
              </div>

              <div className="grid flex-1 grid-cols-1 gap-[12px] md:grid-cols-2">
                <div className="space-y-[4px]">
                  <div className="text-[12px] font-semibold text-[var(--app-text-muted)]">Name</div>
                  <div className="text-[14px] font-semibold text-[var(--app-text)]">
                    {activeProduct.name}
                  </div>
                </div>

                <div className="space-y-[4px]">
                  <div className="text-[12px] font-semibold text-[var(--app-text-muted)]">SKU</div>
                  <div className="text-[14px] font-semibold text-[var(--app-text)]">
                    {activeProduct.sku}
                  </div>
                </div>

                <div className="space-y-[4px]">
                  <div className="text-[12px] font-semibold text-[var(--app-text-muted)]">
                    Barcode
                  </div>
                  <div className="text-[14px] font-semibold text-[var(--app-text)]">
                    {activeProduct.barcode || "-"}
                  </div>
                </div>

                <div className="space-y-[4px]">
                  <div className="text-[12px] font-semibold text-[var(--app-text-muted)]">Status</div>
                  <div>
                    <StatusPill status={activeProduct.status} />
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-[12px] md:grid-cols-2">
              <div className="space-y-[4px]">
                <div className="text-[12px] font-semibold text-[var(--app-text-muted)]">Brand</div>
                <div className="text-[14px] font-semibold text-[var(--app-text)]">
                  {activeProduct.brand}
                </div>
              </div>

              <div className="space-y-[4px]">
                <div className="text-[12px] font-semibold text-[var(--app-text-muted)]">Category</div>
                <div className="text-[14px] font-semibold text-[var(--app-text)]">
                  {activeProduct.category}
                </div>
              </div>

              <div className="space-y-[4px]">
                <div className="text-[12px] font-semibold text-[var(--app-text-muted)]">
                  Retail Price
                </div>
                <div className="text-[14px] font-semibold text-[var(--app-text)]">
                  {formatNpr(activeProduct.retailPrice)}
                </div>
              </div>

              <div className="space-y-[4px]">
                <div className="text-[12px] font-semibold text-[var(--app-text-muted)]">
                  Wholesale Price
                </div>
                <div className="text-[14px] font-semibold text-[var(--app-text)]">
                  {formatNpr(activeProduct.wholesalePrice)}
                </div>
              </div>

              <div className="space-y-[4px]">
                <div className="text-[12px] font-semibold text-[var(--app-text-muted)]">
                  Threshold Qty
                </div>
                <div className="text-[14px] font-semibold text-[var(--app-text)]">
                  {activeProduct.thresholdQty}
                </div>
              </div>

              <div className="space-y-[4px]">
                <div className="text-[12px] font-semibold text-[var(--app-text-muted)]">Stock</div>
                <div className="flex items-center gap-[10px]">
                  <div className="text-[14px] font-semibold text-[var(--app-text)]">
                    {activeProduct.stock.toLocaleString()}
                  </div>
                  <StockPill flag={getStockFlag(activeProduct)} />
                </div>
              </div>

              <div className="space-y-[4px] md:col-span-2">
                <div className="text-[12px] font-semibold text-[var(--app-text-muted)]">
                  Low Stock Threshold
                </div>
                <div className="text-[14px] font-semibold text-[var(--app-text)]">
                  {activeProduct.lowStockThreshold}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="text-[14px] text-[var(--app-text-muted)]">No product selected.</div>
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
          <div className="text-[14px] text-[var(--app-text-soft)]">
            This will set the product to <span className="font-semibold">Inactive</span> (soft delete).
          </div>
          <div className="text-[12px] text-[var(--app-text-muted)]">
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
          <div className="text-[14px] text-[var(--app-text-soft)]">{bulkAction?.message}</div>
          <div className="text-[12px] text-[var(--app-text-muted)]">
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
