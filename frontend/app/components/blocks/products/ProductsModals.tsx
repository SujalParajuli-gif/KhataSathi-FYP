// frontend/app/components/blocks/products/ProductsModals.tsx
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
      ? "bg-orange-600 text-white border-orange-600 hover:bg-orange-700"
      : variant === "danger"
        ? "bg-white text-rose-600 border-rose-200 hover:bg-rose-50"
        : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50";
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
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-[12px] border border-slate-200 bg-white px-[12px] py-[10px] text-[14px] outline-none"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function StatusPill({ status }: { status: ProductStatus }) {
  const cls =
    status === "Active"
      ? "bg-emerald-50 text-emerald-700 border-emerald-100"
      : "bg-slate-50 text-slate-600 border-slate-200";
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
      ? "bg-emerald-50 text-emerald-700 border-emerald-100"
      : flag === "Low Stock"
        ? "bg-orange-50 text-orange-700 border-orange-100"
        : "bg-rose-50 text-rose-700 border-rose-100";
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
        <div className="w-full max-w-[720px] rounded-[16px] bg-white border border-slate-200 shadow-xl overflow-hidden">
          <div className="flex items-center justify-between px-[18px] py-[14px] border-b border-slate-100">
            <div className="text-[15px] font-semibold text-slate-900">
              {title}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="h-[36px] w-[36px] rounded-[12px] border border-slate-200 hover:bg-slate-50 inline-flex items-center justify-center"
              aria-label="Close modal"
            >
              <GoogleIcon name="close" className="text-slate-700" />
            </button>
          </div>

          <div className="px-[18px] py-[16px]">{children}</div>

          {footer ? (
            <div className="px-[18px] py-[14px] border-t border-slate-100 bg-slate-50/40">
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
      ? "bg-emerald-50 border-emerald-200 text-emerald-800"
      : kind === "danger"
        ? "bg-rose-50 border-rose-200 text-rose-800"
        : "bg-slate-50 border-slate-200 text-slate-800";
  return (
    <div className="fixed bottom-[16px] right-[16px] z-50">
      <div
        className={cn(
          "rounded-[14px] border px-[14px] py-[12px] shadow-sm w-[320px]",
          cls,
        )}
      >
        <div className="flex items-start justify-between gap-[10px]">
          <div className="text-[13px] font-semibold">{message}</div>
          <button
            type="button"
            onClick={onClose}
            className="h-[26px] w-[26px] rounded-[10px] border border-transparent hover:border-slate-300 hover:bg-white inline-flex items-center justify-center"
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

  onSave,
  onConfirmDelete,
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

  onSave: () => void;
  onConfirmDelete: () => void;
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-[12px]">
          <div className="space-y-[6px]">
            <div className="text-[12px] font-semibold text-slate-600">
              Product Name
            </div>
            <input
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              className="w-full rounded-[12px] border border-slate-200 bg-white px-[12px] py-[10px] outline-none"
              placeholder="e.g. Wai Wai Noodles (Chicken)"
            />
          </div>

          <div className="space-y-[6px]">
            <div className="text-[12px] font-semibold text-slate-600">SKU</div>
            <input
              value={form.sku}
              onChange={(e) => setForm((p) => ({ ...p, sku: e.target.value }))}
              className="w-full rounded-[12px] border border-slate-200 bg-white px-[12px] py-[10px] outline-none"
              placeholder="e.g. 890123456789"
            />
          </div>

          <div className="space-y-[6px]">
            <div className="text-[12px] font-semibold text-slate-600">
              Barcode
            </div>
            <input
              value={form.barcode || ""}
              onChange={(e) =>
                setForm((p) => ({ ...p, barcode: e.target.value }))
              }
              className="w-full rounded-[12px] border border-slate-200 bg-white px-[12px] py-[10px] outline-none"
              placeholder="Optional"
            />
          </div>

          <div className="space-y-[6px]">
            <div className="text-[12px] font-semibold text-slate-600">
              Status
            </div>
            <Select
              value={form.status}
              onChange={(v) => setForm((p) => ({ ...p, status: v as any }))}
              options={[
                { value: "Active", label: "Active" },
                { value: "Inactive", label: "Inactive" },
              ]}
            />
          </div>

          <div className="space-y-[6px]">
            <div className="text-[12px] font-semibold text-slate-600">
              Brand
            </div>
            <Select
              value={form.brand}
              onChange={(v) => setForm((p) => ({ ...p, brand: v }))}
              options={brands
                .filter((b) => b !== "All Brands")
                .map((b) => ({ value: b, label: b }))}
            />
          </div>

          <div className="space-y-[6px]">
            <div className="text-[12px] font-semibold text-slate-600">
              Category
            </div>
            <Select
              value={form.category}
              onChange={(v) => setForm((p) => ({ ...p, category: v }))}
              options={categories
                .filter((c) => c !== "All Categories")
                .map((c) => ({ value: c, label: c }))}
            />
          </div>

          <div className="space-y-[6px]">
            <div className="text-[12px] font-semibold text-slate-600">
              Retail Price (NPR)
            </div>
            <input
              type="number"
              value={form.retailPrice}
              onChange={(e) =>
                setForm((p) => ({ ...p, retailPrice: Number(e.target.value) }))
              }
              className="w-full rounded-[12px] border border-slate-200 bg-white px-[12px] py-[10px] outline-none"
            />
          </div>

          <div className="space-y-[6px]">
            <div className="text-[12px] font-semibold text-slate-600">
              Wholesale Price (NPR)
            </div>
            <input
              type="number"
              value={form.wholesalePrice}
              onChange={(e) =>
                setForm((p) => ({
                  ...p,
                  wholesalePrice: Number(e.target.value),
                }))
              }
              className="w-full rounded-[12px] border border-slate-200 bg-white px-[12px] py-[10px] outline-none"
            />
          </div>

          <div className="space-y-[6px]">
            <div className="text-[12px] font-semibold text-slate-600">
              Wholesale Threshold Qty
            </div>
            <input
              type="number"
              value={form.thresholdQty}
              onChange={(e) =>
                setForm((p) => ({ ...p, thresholdQty: Number(e.target.value) }))
              }
              className="w-full rounded-[12px] border border-slate-200 bg-white px-[12px] py-[10px] outline-none"
            />
          </div>

          <div className="space-y-[6px]">
            <div className="text-[12px] font-semibold text-slate-600">
              Stock
            </div>
            <input
              type="number"
              value={form.stock}
              onChange={(e) =>
                setForm((p) => ({ ...p, stock: Number(e.target.value) }))
              }
              className="w-full rounded-[12px] border border-slate-200 bg-white px-[12px] py-[10px] outline-none"
            />
          </div>

          <div className="space-y-[6px] md:col-span-2">
            <div className="text-[12px] font-semibold text-slate-600">
              Low Stock Threshold
            </div>
            <input
              type="number"
              value={form.lowStockThreshold}
              onChange={(e) =>
                setForm((p) => ({
                  ...p,
                  lowStockThreshold: Number(e.target.value),
                }))
              }
              className="w-full rounded-[12px] border border-slate-200 bg-white px-[12px] py-[10px] outline-none"
            />
            <div className="text-[12px] text-slate-500">
              Used to mark stock as “Low Stock” and trigger alerts later.
            </div>
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={openImport}
        title="Import Products (CSV)"
        onClose={() => setOpenImport(false)}
        footer={
          <div className="flex items-center justify-end gap-[10px]">
            <Button onClick={() => setOpenImport(false)}>Cancel</Button>
            <Button
              variant="primary"
              icon="upload_file"
              onClick={onUploadCsvClick}
            >
              Upload
            </Button>
          </div>
        }
      >
        <div className="space-y-[12px]">
          <div className="text-[13px] text-slate-700">
            Upload a CSV file to add or update products in bulk.
          </div>

          <div className="rounded-[14px] border border-slate-200 bg-slate-50 p-[12px]">
            <div className="text-[12px] font-semibold text-slate-600 mb-[6px]">
              Expected columns
            </div>
            <div className="text-[12px] text-slate-600 leading-relaxed">
              name, sku, barcode, brand, category, retailPrice, wholesalePrice,
              thresholdQty, stock, lowStockThreshold, status
            </div>
          </div>

          <input
            type="file"
            accept=".csv"
            className="w-full rounded-[12px] border border-slate-200 bg-white px-[12px] py-[10px]"
          />
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
                onClick={() => (setOpenView(false), setOpenAddEdit(true))}
              >
                Edit
              </Button>
            ) : null}
          </div>
        }
      >
        {activeProduct ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-[12px]">
            <div className="space-y-[4px]">
              <div className="text-[12px] font-semibold text-slate-500">
                Name
              </div>
              <div className="text-[14px] font-semibold text-slate-900">
                {activeProduct.name}
              </div>
            </div>

            <div className="space-y-[4px]">
              <div className="text-[12px] font-semibold text-slate-500">
                SKU
              </div>
              <div className="text-[14px] font-semibold text-slate-900">
                {activeProduct.sku}
              </div>
            </div>

            <div className="space-y-[4px]">
              <div className="text-[12px] font-semibold text-slate-500">
                Barcode
              </div>
              <div className="text-[14px] font-semibold text-slate-900">
                {activeProduct.barcode || "-"}
              </div>
            </div>

            <div className="space-y-[4px]">
              <div className="text-[12px] font-semibold text-slate-500">
                Status
              </div>
              <div>
                <StatusPill status={activeProduct.status} />
              </div>
            </div>

            <div className="space-y-[4px]">
              <div className="text-[12px] font-semibold text-slate-500">
                Brand
              </div>
              <div className="text-[14px] font-semibold text-slate-900">
                {activeProduct.brand}
              </div>
            </div>

            <div className="space-y-[4px]">
              <div className="text-[12px] font-semibold text-slate-500">
                Category
              </div>
              <div className="text-[14px] font-semibold text-slate-900">
                {activeProduct.category}
              </div>
            </div>

            <div className="space-y-[4px]">
              <div className="text-[12px] font-semibold text-slate-500">
                Retail Price
              </div>
              <div className="text-[14px] font-semibold text-slate-900">
                {formatNpr(activeProduct.retailPrice)}
              </div>
            </div>

            <div className="space-y-[4px]">
              <div className="text-[12px] font-semibold text-slate-500">
                Wholesale Price
              </div>
              <div className="text-[14px] font-semibold text-slate-900">
                {formatNpr(activeProduct.wholesalePrice)}
              </div>
            </div>

            <div className="space-y-[4px]">
              <div className="text-[12px] font-semibold text-slate-500">
                Threshold Qty
              </div>
              <div className="text-[14px] font-semibold text-slate-900">
                {activeProduct.thresholdQty}
              </div>
            </div>

            <div className="space-y-[4px]">
              <div className="text-[12px] font-semibold text-slate-500">
                Stock
              </div>
              <div className="flex items-center gap-[10px]">
                <div className="text-[14px] font-semibold text-slate-900">
                  {activeProduct.stock.toLocaleString()}
                </div>
                <StockPill flag={getStockFlag(activeProduct)} />
              </div>
            </div>

            <div className="space-y-[4px] md:col-span-2">
              <div className="text-[12px] font-semibold text-slate-500">
                Low Stock Threshold
              </div>
              <div className="text-[14px] font-semibold text-slate-900">
                {activeProduct.lowStockThreshold}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-[14px] text-slate-600">No product selected.</div>
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
          <div className="text-[14px] text-slate-700">
            This will set the product to{" "}
            <span className="font-semibold">Inactive</span> (soft delete).
          </div>
          <div className="text-[12px] text-slate-500">
            Soft delete is safer for invoice history and audit logs.
          </div>
        </div>
      </ModalShell>

      <Toast
        open={toast.open}
        kind={toast.kind}
        message={toast.message}
        onClose={() => setToast((t) => ({ ...t, open: false }))}
      />
    </>
  );
}
