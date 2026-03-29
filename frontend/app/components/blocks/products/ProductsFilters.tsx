// frontend/app/components/blocks/products/ProductsFilters.tsx
import React from "react";
import GoogleIcon from "~/components/ui/GIcon";
import { cn } from "~/lib/domain/products/products.helpers";

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[14px] border border-[var(--app-border)] bg-white shadow-[0_18px_45px_-38px_rgba(17,18,13,0.45)]">
      {children}
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

function Input({
  value,
  onChange,
  placeholder,
  leftIcon,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  leftIcon?: string;
}) {
  return (
    <div className="flex items-center gap-[8px] rounded-[12px] border border-[var(--app-border)] bg-white px-[12px] py-[10px]">
      {leftIcon ? (
        <GoogleIcon name={leftIcon} className="text-[var(--app-text-muted)]" />
      ) : null}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-transparent text-[14px] font-medium text-[var(--app-text)] outline-none placeholder:text-[var(--app-text-muted)]"
      />
    </div>
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
      className="w-full rounded-[12px] border border-[var(--app-border)] bg-white px-[12px] py-[10px] text-[14px] text-[var(--app-text)] outline-none"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export default function ProductsFiltersCard({
  q,
  setQ,
  brands,
  brand,
  setBrand,
  categories,
  category,
  setCategory,
  stockStatus,
  setStockStatus,
  status,
  setStatus,
  lowOnly,
  setLowOnly,
  onClear,
  selectedCount,

  onAdd,
  onImport,
  onActivate,
  onDeactivate,
  onSoftDelete,
}: {
  q: string;
  setQ: (v: string) => void;

  brands: string[];
  brand: string;
  setBrand: (v: string) => void;

  categories: string[];
  category: string;
  setCategory: (v: string) => void;

  stockStatus: "all" | "in" | "low" | "out";
  setStockStatus: (v: "all" | "in" | "low" | "out") => void;

  status: "all" | "active" | "inactive";
  setStatus: (v: "all" | "active" | "inactive") => void;

  lowOnly: boolean;
  setLowOnly: (v: boolean) => void;

  onClear: () => void;

  selectedCount: number;

  onAdd: () => void;
  onImport: () => void;
  onActivate: () => void;
  onDeactivate: () => void;
  onSoftDelete: () => void;
}) {
  return (
    <Card>
      <div className="p-[16px] space-y-[14px]">
        <div className="flex flex-col lg:flex-row lg:items-center gap-[12px]">
          <div className="flex-1">
            <Input
              value={q}
              onChange={setQ}
              placeholder="Search by product name / SKU / barcode..."
              leftIcon="search"
            />
          </div>

          <div className="flex items-center gap-[10px] flex-wrap justify-end">
            <Button variant="primary" icon="add" onClick={onAdd}>
              Add Product
            </Button>

            <Button icon="upload_file" onClick={onImport}>
              Import CSV
            </Button>

            <div className="flex items-center gap-[8px]">
              <Button
                disabled={selectedCount === 0}
                icon="check_circle"
                onClick={onActivate}
              >
                Activate
              </Button>
              <Button
                disabled={selectedCount === 0}
                icon="do_not_disturb_on"
                onClick={onDeactivate}
              >
                Deactivate
              </Button>
              <Button
                variant="danger"
                disabled={selectedCount === 0}
                icon="delete"
                onClick={onSoftDelete}
              >
                Soft Delete
              </Button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-[12px]">
            <div className="space-y-[6px]">
            <div className="text-[12px] font-semibold text-[var(--app-text-muted)]">
              Brand
            </div>
            <Select
              value={brand}
              onChange={setBrand}
              options={brands.map((b) => ({ value: b, label: b }))}
            />
          </div>

          <div className="space-y-[6px]">
            <div className="text-[12px] font-semibold text-[var(--app-text-muted)]">
              Category
            </div>
            <Select
              value={category}
              onChange={setCategory}
              options={categories.map((c) => ({ value: c, label: c }))}
            />
          </div>

          <div className="space-y-[6px]">
            <div className="text-[12px] font-semibold text-[var(--app-text-muted)]">
              Stock Status
            </div>
            <Select
              value={stockStatus}
              onChange={(v) => setStockStatus(v as any)}
              options={[
                { value: "all", label: "All" },
                { value: "in", label: "In Stock" },
                { value: "low", label: "Low Stock" },
                { value: "out", label: "Out of Stock" },
              ]}
            />
          </div>

          <div className="space-y-[6px]">
            <div className="text-[12px] font-semibold text-[var(--app-text-muted)]">
              Status
            </div>
            <Select
              value={status}
              onChange={(v) => setStatus(v as any)}
              options={[
                { value: "all", label: "All" },
                { value: "active", label: "Active" },
                { value: "inactive", label: "Inactive" },
              ]}
            />
          </div>

          <div className="flex items-end justify-between gap-[10px]">
            <label className="inline-flex items-center gap-[8px] text-[13px] font-semibold text-[var(--app-text-soft)] select-none">
              <input
                type="checkbox"
                checked={lowOnly}
                onChange={(e) => setLowOnly(e.target.checked)}
                className="h-[16px] w-[16px] accent-[#11120d]"
              />
              Low stock only
            </label>

            <button
              type="button"
              onClick={onClear}
              className="inline-flex items-center gap-[6px] text-[13px] font-semibold text-[var(--app-text-soft)] hover:text-[var(--app-text)]"
            >
              <GoogleIcon name="close" className="text-[var(--app-text-muted)]" />
              Clear filters
            </button>
          </div>
        </div>
      </div>
    </Card>
  );
}
