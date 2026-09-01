import React from "react";
import GoogleIcon from "~/components/ui/GIcon";
import ProjectSelect from "~/components/ui/ProjectSelect";
import CreatableCombobox from "~/components/ui/CreatableCombobox";
import {
  ActiveFilterChips,
  MobileFilterButton,
  MobileFilterSheet,
  type MobileFilterChip,
} from "~/components/ui/MobileFilters";
import { cn } from "~/lib/domain/products/products.helpers";

// simple card container for the filters section
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[14px] border border-[#CFCFD3] bg-white ">
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
  ariaPressed,
}: {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "danger";
  onClick?: () => void;
  disabled?: boolean;
  icon?: string;
  ariaPressed?: boolean;
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
      aria-pressed={ariaPressed}
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
    <div className="flex items-center gap-[8px] rounded-[12px] border border-[#CFCFD3] bg-white px-[12px] py-[10px]">
      {leftIcon ? (
        <GoogleIcon name={leftIcon} className="text-[#8C8889]" />
      ) : null}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-transparent text-[14px] font-medium text-[#000000] outline-none placeholder:text-[#8C8889]"
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
    <ProjectSelect
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-[12px] border border-[#CFCFD3] bg-white px-[12px] py-[10px] text-[14px] text-[#000000] outline-none"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </ProjectSelect>
  );
}

// the main filters component for the products page
// contains the search bar, action buttons (add, import, activate/deactivate), and the filter dropdowns (brand, category, stock, status)
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
  onClear,

  onAdd,
  onImport,
  onManageStock,
  onSearchInsights,
  purchaseCostVisible,
  onTogglePurchaseCost,
  stockTracked,
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

  onClear: () => void;

  onAdd: () => void;
  onImport: () => void;
  onManageStock: () => void;
  onSearchInsights?: () => void;
  purchaseCostVisible?: boolean;
  onTogglePurchaseCost?: () => void;
  stockTracked: boolean;
}) {
  const [mobileFiltersOpen, setMobileFiltersOpen] = React.useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = React.useState(false);
  const [draftBrand, setDraftBrand] = React.useState(brand);
  const [draftCategory, setDraftCategory] = React.useState(category);
  const [draftStockStatus, setDraftStockStatus] = React.useState(stockStatus);
  const [draftStatus, setDraftStatus] = React.useState(status);

  const filterCount = [
    brand !== "All Brands",
    category !== "All Categories",
    stockTracked && stockStatus !== "all",
    status !== "all",
  ].filter(Boolean).length;

  function openMobileFilters() {
    setDraftBrand(brand);
    setDraftCategory(category);
    setDraftStockStatus(stockStatus);
    setDraftStatus(status);
    setMobileFiltersOpen(true);
  }

  function applyMobileFilters() {
    setBrand(draftBrand);
    setCategory(draftCategory);
    setStockStatus(draftStockStatus);
    setStatus(draftStatus);
    setMobileFiltersOpen(false);
  }

  function clearMobileFilters() {
    setDraftBrand("All Brands");
    setDraftCategory("All Categories");
    setDraftStockStatus("all");
    setDraftStatus("all");
  }

  const mobileFilterChips: MobileFilterChip[] = [
    ...(brand !== "All Brands" ? [{ id: "brand", label: `Brand: ${brand}`, onRemove: () => setBrand("All Brands") }] : []),
    ...(category !== "All Categories" ? [{ id: "category", label: `Category: ${category}`, onRemove: () => setCategory("All Categories") }] : []),
    ...(stockTracked && stockStatus !== "all" ? [{
      id: "stock",
      label: stockStatus === "low" ? "Low Stock" : stockStatus === "in" ? "In Stock" : "Out of Stock",
      onRemove: () => setStockStatus("all"),
    }] : []),
    ...(status !== "all" ? [{ id: "status", label: status === "active" ? "Active" : "Inactive", onRemove: () => setStatus("all") }] : []),
  ];

  return (
    <>
      <section className="space-y-3 lg:hidden" aria-label="Product search and actions">
        <div className="flex gap-2.5">
          <div className="min-w-0 flex-1">
            <Input
              value={q}
              onChange={setQ}
              placeholder="Search by product name / SKU / barcode..."
              leftIcon="search"
            />
          </div>
          <MobileFilterButton activeCount={filterCount} onClick={openMobileFilters} />
        </div>

        <ActiveFilterChips items={mobileFilterChips} />

        <div className="flex gap-2">
          <button type="button" onClick={onAdd} className="inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-[12px] bg-[#11120d] px-4 text-[13px] font-extrabold text-white transition active:scale-[0.99]">
            <GoogleIcon name="add_circle" className="text-[20px]" />
            Add Product
          </button>
          {onTogglePurchaseCost ? (
            <button
              type="button"
              onClick={onTogglePurchaseCost}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] border border-[#CFCFD3] bg-white text-[#565449] transition hover:bg-[#F3F4F6]"
              aria-label={purchaseCostVisible ? "Hide purchase costs" : "Show purchase costs"}
              title={purchaseCostVisible ? "Hide purchase costs" : "Show purchase costs"}
              aria-pressed={purchaseCostVisible}
            >
              <GoogleIcon name={purchaseCostVisible ? "visibility" : "visibility_off"} className="text-[21px]" />
            </button>
          ) : null}
          <button type="button" onClick={() => setMobileActionsOpen(true)} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] border border-[#CFCFD3] bg-white text-[#565449] transition hover:bg-[#F3F4F6]" aria-label="More product actions">
            <GoogleIcon name="more_horiz" className="text-[22px]" />
          </button>
        </div>
      </section>

      <MobileFilterSheet
        open={mobileFiltersOpen}
        onClose={() => setMobileFiltersOpen(false)}
        onClear={clearMobileFilters}
        onApply={applyMobileFilters}
      >
            <div className="space-y-5">
              <div className="block space-y-2"><span className="text-[14px] font-bold">Brand</span><CreatableCombobox value={draftBrand} onChange={setDraftBrand} options={brands} placeholder="Search brands" ariaLabel="Filter products by brand" allowCreate={false} selectOnFocus /></div>
              <div className="block space-y-2"><span className="text-[14px] font-bold">Category</span><CreatableCombobox value={draftCategory} onChange={setDraftCategory} options={categories} placeholder="Search categories" ariaLabel="Filter products by category" allowCreate={false} selectOnFocus /></div>

              {stockTracked ? <fieldset className="space-y-2">
                <legend className="text-[14px] font-bold">Stock Status</legend>
                <div className="grid grid-cols-4 overflow-hidden rounded-[12px] border border-[#CFCFD3]">
                  {([['all','All'],['in','In Stock'],['low','Low Stock'],['out','Out of Stock']] as const).map(([value, label]) => (
                    <button key={value} type="button" onClick={() => setDraftStockStatus(value)} className={cn("min-h-[52px] border-r border-[#CFCFD3] px-1 text-[11px] font-bold last:border-r-0", draftStockStatus === value ? "bg-[#238A32] text-white" : "bg-white text-[#11120d]")}>{label}</button>
                  ))}
                </div>
              </fieldset> : null}

              <fieldset className="space-y-2">
                <legend className="text-[14px] font-bold">Product Status</legend>
                <div className="grid grid-cols-3 overflow-hidden rounded-[12px] border border-[#CFCFD3]">
                  {([['all','All'],['active','Active'],['inactive','Inactive']] as const).map(([value, label]) => (
                    <button key={value} type="button" onClick={() => setDraftStatus(value)} className={cn("h-[52px] border-r border-[#CFCFD3] text-[13px] font-bold last:border-r-0", draftStatus === value ? "bg-[#11120d] text-white" : "bg-white text-[#11120d]")}>{label}</button>
                  ))}
                </div>
              </fieldset>
            </div>
      </MobileFilterSheet>

      {mobileActionsOpen ? (
        <div className="fixed inset-0 z-[130] lg:hidden">
          <button type="button" className="absolute inset-0 bg-slate-950/50" aria-label="Close actions" onClick={() => setMobileActionsOpen(false)} />
          <section role="dialog" aria-modal="true" aria-label="Product actions" className="absolute inset-x-0 bottom-0 rounded-t-[26px] bg-white px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-3 shadow-2xl">
            <div className="mx-auto h-1.5 w-14 rounded-full bg-[#CFCFD3]" />
            <div className="mt-3 flex items-center justify-between border-b border-[#E5E7EB] pb-3"><h2 className="text-[20px] font-extrabold">Product actions</h2><button type="button" onClick={() => setMobileActionsOpen(false)} className="flex h-11 w-11 items-center justify-center rounded-full transition active:bg-[#F3F4F6]" aria-label="Close actions"><GoogleIcon name="close" className="text-[26px]" /></button></div>
            <div className="mt-2 space-y-1">
            <button type="button" onClick={() => { setMobileActionsOpen(false); onImport(); }} className="flex min-h-[56px] w-full items-center gap-3.5 rounded-[14px] px-2 text-left transition active:scale-[0.98] active:bg-[#F3F4F6]"><span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-[#F3F4F6] text-[#565449]"><GoogleIcon name="upload_file" className="text-[20px]" /></span><span className="flex-1 text-[15px] font-bold">Import products</span><GoogleIcon name="chevron_right" className="text-[#94A3B8]" /></button>
            {onSearchInsights ? <button type="button" onClick={() => { setMobileActionsOpen(false); onSearchInsights(); }} className="flex min-h-[56px] w-full items-center gap-3.5 rounded-[14px] px-2 text-left transition active:scale-[0.98] active:bg-[#F3F4F6]"><span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-[#F3F4F6] text-[#565449]"><GoogleIcon name="search_off" className="text-[20px]" /></span><span className="flex-1 text-[15px] font-bold">Unmatched searches</span><GoogleIcon name="chevron_right" className="text-[#94A3B8]" /></button> : null}
            {stockTracked ? <button type="button" onClick={() => { setMobileActionsOpen(false); onManageStock(); }} className="flex min-h-[56px] w-full items-center gap-3.5 rounded-[14px] px-2 text-left transition active:scale-[0.98] active:bg-[#F3F4F6]"><span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-[#F3F4F6] text-[#565449]"><GoogleIcon name="inventory_2" className="text-[20px]" /></span><span className="flex-1 text-[15px] font-bold">Stock Movement</span><GoogleIcon name="chevron_right" className="text-[#94A3B8]" /></button> : null}
            </div>
          </section>
        </div>
      ) : null}

      <div className="hidden lg:block">
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
              Import
            </Button>

            {stockTracked ? <Button
              icon="inventory_2"
              onClick={onManageStock}
            >
              Stock Movement
            </Button> : null}

            {onSearchInsights ? (
              <Button icon="search_off" onClick={onSearchInsights}>
                Unmatched Searches
              </Button>
            ) : null}
            {onTogglePurchaseCost ? (
              <button
                type="button"
                onClick={onTogglePurchaseCost}
                aria-pressed={purchaseCostVisible}
                className={cn(
                  "inline-flex items-center justify-center gap-[8px] rounded-[12px] px-[14px] py-[10px] text-[13px] font-semibold border active:scale-[0.98] transition",
                  purchaseCostVisible
                    ? "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                    : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6] hover:text-[#000000]",
                )}
              >
                <GoogleIcon
                  name={purchaseCostVisible ? "visibility" : "visibility_off"}
                  className={purchaseCostVisible ? "text-emerald-700 text-[18px]" : "text-inherit text-[18px]"}
                />
                <span>{purchaseCostVisible ? "Hide purchase cost" : "Show purchase cost"}</span>
              </button>
            ) : null}

          </div>
        </div>

        <div className={cn("grid grid-cols-1 gap-[12px] md:grid-cols-2", stockTracked ? "xl:grid-cols-[repeat(4,minmax(0,1fr))_auto]" : "xl:grid-cols-[repeat(3,minmax(0,1fr))_auto]")}>
          <div className="space-y-[6px]">
            <div className="text-[12px] font-semibold text-[#8C8889]">
              Brand
            </div>
            <CreatableCombobox
              value={brand}
              onChange={setBrand}
              options={brands}
              placeholder="Search brands"
              ariaLabel="Filter products by brand"
              allowCreate={false}
              selectOnFocus
            />
          </div>

          <div className="space-y-[6px]">
            <div className="text-[12px] font-semibold text-[#8C8889]">
              Category
            </div>
            <CreatableCombobox
              value={category}
              onChange={setCategory}
              options={categories}
              placeholder="Search categories"
              ariaLabel="Filter products by category"
              allowCreate={false}
              selectOnFocus
            />
          </div>

          {stockTracked ? <div className="space-y-[6px]">
            <div className="text-[12px] font-semibold text-[#8C8889]">
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
          </div> : null}

          <div className="space-y-[6px]">
            <div className="text-[12px] font-semibold text-[#8C8889]">
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

          <div className="flex items-end">
            <button
              type="button"
              onClick={onClear}
              disabled={filterCount === 0 && !q.trim()}
              className="inline-flex h-[42px] w-full items-center justify-center gap-[7px] rounded-[12px] border border-[#CFCFD3] bg-white px-[14px] text-[13px] font-bold text-[#565449] transition hover:bg-[#F3F4F6] hover:text-[#000000] disabled:pointer-events-none disabled:opacity-45 xl:w-auto"
            >
              <GoogleIcon name="filter_alt_off" className="text-[18px] text-[#8C8889]" />
              Clear filters
            </button>
          </div>
        </div>
      </div>
      </Card>
      </div>
    </>
  );
}
