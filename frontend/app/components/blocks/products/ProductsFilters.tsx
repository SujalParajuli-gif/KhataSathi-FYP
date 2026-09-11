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
import type {
  ProductSortBy,
  ProductPricingStatus,
  ProductPhotoStatus,
} from "~/lib/domain/products/products.types";

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
    <div className="relative flex h-10 w-full min-w-0 items-center gap-[8px] rounded-[10px] border border-[#CFCFD3] bg-white px-3 transition focus-within:border-[#11120d] focus-within:ring-2 focus-within:ring-[#11120d]/10">
      {leftIcon ? (
        <GoogleIcon name={leftIcon} className="shrink-0 text-[#8C8889] text-[18px]" />
      ) : null}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full min-w-0 bg-transparent text-[12px] font-semibold text-[#000000] outline-none placeholder:text-[#8C8889]"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          className="shrink-0 text-[#8C8889] hover:text-[#11120d]"
          aria-label="Clear search"
        >
          <GoogleIcon name="close" className="text-[16px]" />
        </button>
      ) : null}
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  className?: string;
}) {
  return (
    <ProjectSelect
      value={value}
      onChange={(e) => onChange(e.target.value)}
      compact
      className={cn(
        "h-10 w-full rounded-[10px] border border-[#CFCFD3] bg-white px-2.5 text-[12px] font-semibold text-[#000000] outline-none",
        className,
      )}
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
  sortBy = "photos_first",
  setSortBy,
  pricingStatus = "all",
  setPricingStatus,
  photoStatus = "all",
  setPhotoStatus,
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

  sortBy?: ProductSortBy;
  setSortBy?: (v: ProductSortBy) => void;

  pricingStatus?: ProductPricingStatus;
  setPricingStatus?: (v: ProductPricingStatus) => void;

  photoStatus?: ProductPhotoStatus;
  setPhotoStatus?: (v: ProductPhotoStatus) => void;

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
  const [draftSortBy, setDraftSortBy] = React.useState<ProductSortBy>(sortBy);
  const [draftPricingStatus, setDraftPricingStatus] = React.useState<ProductPricingStatus>(pricingStatus);
  const [draftPhotoStatus, setDraftPhotoStatus] = React.useState<ProductPhotoStatus>(photoStatus);

  const brandOptions = React.useMemo(() => {
    const list = brands.filter((b) => b !== "All Brands");
    return [
      { value: "All Brands", label: `All Brands (${list.length})` },
      ...list.map((b) => ({ value: b, label: b })),
    ];
  }, [brands]);

  const sortOptions = [
    { value: "photos_first", label: "Sort: Photos First" },
    { value: "name_asc", label: "Sort: Name (A-Z)" },
    { value: "name_desc", label: "Sort: Name (Z-A)" },
    { value: "brand_asc", label: "Sort: Brand (A-Z)" },
    { value: "price_asc", label: "Sort: Price (Low-High)" },
    { value: "price_desc", label: "Sort: Price (High-Low)" },
    { value: "newest", label: "Sort: Newest First" },
  ];

  const pricingOptions = [
    { value: "all", label: "Pricing: All" },
    { value: "ready", label: "Pricing: Ready" },
    { value: "pending", label: "Pricing: Pending" },
  ];

  const photoOptions = [
    { value: "all", label: "Photos: All" },
    { value: "with_photo", label: "Photos: With Photo" },
    { value: "without_photo", label: "Photos: Missing" },
  ];

  const filterCount = [
    brand !== "All Brands",
    category !== "All Categories",
    stockTracked && stockStatus !== "all",
    status !== "all",
    sortBy !== "photos_first",
    pricingStatus !== "all",
    photoStatus !== "all",
  ].filter(Boolean).length;

  function openMobileFilters() {
    setDraftBrand(brand);
    setDraftCategory(category);
    setDraftStockStatus(stockStatus);
    setDraftStatus(status);
    setDraftSortBy(sortBy);
    setDraftPricingStatus(pricingStatus);
    setDraftPhotoStatus(photoStatus);
    setMobileFiltersOpen(true);
  }

  function applyMobileFilters() {
    setBrand(draftBrand);
    setCategory(draftCategory);
    setStockStatus(draftStockStatus);
    setStatus(draftStatus);
    setSortBy?.(draftSortBy);
    setPricingStatus?.(draftPricingStatus);
    setPhotoStatus?.(draftPhotoStatus);
    setMobileFiltersOpen(false);
  }

  function clearMobileFilters() {
    setDraftBrand("All Brands");
    setDraftCategory("All Categories");
    setDraftStockStatus("all");
    setDraftStatus("all");
    setDraftSortBy("photos_first");
    setDraftPricingStatus("all");
    setDraftPhotoStatus("all");
  }

  const filterChips: MobileFilterChip[] = [
    ...(brand !== "All Brands" ? [{ id: "brand", label: `Brand: ${brand}`, onRemove: () => setBrand("All Brands") }] : []),
    ...(category !== "All Categories" ? [{ id: "category", label: `Category: ${category}`, onRemove: () => setCategory("All Categories") }] : []),
    ...(sortBy !== "photos_first" ? [{ id: "sort", label: `Sort: ${sortOptions.find((s) => s.value === sortBy)?.label || sortBy}`, onRemove: () => setSortBy?.("photos_first") }] : []),
    ...(pricingStatus !== "all" ? [{ id: "pricing", label: pricingStatus === "ready" ? "Price Ready" : "Price Pending", onRemove: () => setPricingStatus?.("all") }] : []),
    ...(photoStatus !== "all" ? [{ id: "photo", label: photoStatus === "with_photo" ? "With Photos" : "Missing Photos", onRemove: () => setPhotoStatus?.("all") }] : []),
    ...(stockTracked && stockStatus !== "all" ? [{
      id: "stock",
      label: stockStatus === "low" ? "Low Stock" : stockStatus === "in" ? "In Stock" : "Out of Stock",
      onRemove: () => setStockStatus("all"),
    }] : []),
    ...(status !== "all" ? [{ id: "status", label: status === "active" ? "Active" : "Inactive", onRemove: () => setStatus("all") }] : []),
  ];

  return (
    <>
      {/* Mobile Search & Controls: Sleek and Minimal */}
      <section className="space-y-3 lg:hidden" aria-label="Product search and actions">
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <Input
              value={q}
              onChange={setQ}
              placeholder="Search name, SKU, barcode..."
              leftIcon="search"
            />
          </div>
          <MobileFilterButton activeCount={filterCount} onClick={openMobileFilters} />
        </div>

        {filterChips.length > 0 ? (
          <ActiveFilterChips items={filterChips} />
        ) : null}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onAdd}
            className="inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-[12px] bg-[#11120d] px-4 text-[13px] font-extrabold text-white transition active:scale-[0.99]"
          >
            <GoogleIcon name="add_circle" className="text-[20px]" />
            Add Product
          </button>
          {onTogglePurchaseCost ? (
            <button
              type="button"
              onClick={onTogglePurchaseCost}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] border border-[#CFCFD3] bg-white text-[#565449] transition hover:bg-[#F3F4F6]"
              aria-label={purchaseCostVisible ? "Hide Rate" : "Show Rate"}
              title={purchaseCostVisible ? "Hide Rate" : "Show Rate"}
              aria-pressed={purchaseCostVisible}
            >
              <GoogleIcon name={purchaseCostVisible ? "visibility" : "visibility_off"} className="text-[21px]" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setMobileActionsOpen(true)}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] border border-[#CFCFD3] bg-white text-[#565449] transition hover:bg-[#F3F4F6]"
            aria-label="More product actions"
          >
            <GoogleIcon name="more_horiz" className="text-[22px]" />
          </button>
        </div>
      </section>

      {/* Mobile Filter Sheet: Compact and Easy to Navigate */}
      <MobileFilterSheet
        open={mobileFiltersOpen}
        onClose={() => setMobileFiltersOpen(false)}
        onClear={clearMobileFilters}
        onApply={applyMobileFilters}
      >
        <div className="space-y-4">
          {/* Brand */}
          <div className="block space-y-1.5">
            <label className="text-[13px] font-bold text-slate-900">Brand</label>
            <Select
              value={draftBrand}
              onChange={setDraftBrand}
              options={brandOptions}
            />
          </div>

          {/* Category */}
          <div className="block space-y-1.5">
            <label className="text-[13px] font-bold text-slate-900">Category</label>
            <CreatableCombobox
              value={draftCategory}
              onChange={setDraftCategory}
              options={categories}
              placeholder="Search categories"
              ariaLabel="Filter products by category"
              allowCreate={false}
              selectOnFocus
            />
          </div>

          {/* Sort By */}
          <div className="block space-y-1.5">
            <label className="text-[13px] font-bold text-slate-900">Sort Catalog By</label>
            <Select
              value={draftSortBy}
              onChange={(v) => setDraftSortBy(v as any)}
              options={sortOptions}
            />
          </div>

          {/* Pricing Status */}
          <fieldset className="space-y-1.5">
            <legend className="text-[13px] font-bold text-slate-900">Pricing Status</legend>
            <div className="grid grid-cols-3 overflow-hidden rounded-[12px] border border-[#CFCFD3]">
              {([["all", "All"], ["ready", "Ready"], ["pending", "Pending"]] as const).map(([val, lbl]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setDraftPricingStatus(val)}
                  className={cn(
                    "min-h-[46px] border-r border-[#CFCFD3] px-1 text-[12px] font-bold last:border-r-0",
                    draftPricingStatus === val ? "bg-[#11120d] text-white" : "bg-white text-[#11120d]",
                  )}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </fieldset>

          {/* Photo Status */}
          <fieldset className="space-y-1.5">
            <legend className="text-[13px] font-bold text-slate-900">Photo Status</legend>
            <div className="grid grid-cols-3 overflow-hidden rounded-[12px] border border-[#CFCFD3]">
              {([["all", "All"], ["with_photo", "With Photo"], ["without_photo", "Missing"]] as const).map(([val, lbl]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setDraftPhotoStatus(val)}
                  className={cn(
                    "min-h-[46px] border-r border-[#CFCFD3] px-1 text-[12px] font-bold last:border-r-0",
                    draftPhotoStatus === val ? "bg-[#11120d] text-white" : "bg-white text-[#11120d]",
                  )}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </fieldset>

          {/* Stock Status (if tracked) */}
          {stockTracked ? (
            <fieldset className="space-y-1.5">
              <legend className="text-[13px] font-bold text-slate-900">Stock Status</legend>
              <div className="grid grid-cols-4 overflow-hidden rounded-[12px] border border-[#CFCFD3]">
                {([["all", "All"], ["in", "In Stock"], ["low", "Low"], ["out", "Out"]] as const).map(([val, lbl]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setDraftStockStatus(val)}
                    className={cn(
                      "min-h-[46px] border-r border-[#CFCFD3] px-1 text-[11px] font-bold last:border-r-0",
                      draftStockStatus === val ? "bg-[#238A32] text-white" : "bg-white text-[#11120d]",
                    )}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}

          {/* Product Status */}
          <fieldset className="space-y-1.5">
            <legend className="text-[13px] font-bold text-slate-900">Product Status</legend>
            <div className="grid grid-cols-3 overflow-hidden rounded-[12px] border border-[#CFCFD3]">
              {([["all", "All"], ["active", "Active"], ["inactive", "Inactive"]] as const).map(([val, lbl]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setDraftStatus(val)}
                  className={cn(
                    "min-h-[46px] border-r border-[#CFCFD3] text-[12px] font-bold last:border-r-0",
                    draftStatus === val ? "bg-[#11120d] text-white" : "bg-white text-[#11120d]",
                  )}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      </MobileFilterSheet>

      {/* Mobile Actions Drawer */}
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

      {/* Desktop Search & Filters Toolbar */}
      <div className="hidden lg:block">
        <Card>
          <div className="p-[16px] space-y-[12px]">
            {/* Row 1: Search (Left, replacing Product Catalog) + Action Buttons (Right) */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#F0F1F3] pb-3">
              <div className="min-w-[220px] flex-1">
                <Input
                  value={q}
                  onChange={setQ}
                  placeholder="Search name, SKU, barcode..."
                  leftIcon="search"
                />
              </div>

              <div className="flex items-center gap-2 flex-wrap justify-end shrink-0">
                <Button variant="primary" icon="add" onClick={onAdd}>
                  Add Product
                </Button>
                <Button icon="upload_file" onClick={onImport}>
                  Import
                </Button>
                {stockTracked ? (
                  <Button icon="inventory_2" onClick={onManageStock}>
                    Stock Movement
                  </Button>
                ) : null}
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
                      "inline-flex items-center justify-center gap-[8px] rounded-[12px] px-[14px] py-[10px] text-[13px] font-semibold border active:scale-[0.98] transition shrink-0",
                      purchaseCostVisible
                        ? "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                        : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6] hover:text-[#000000]",
                    )}
                  >
                    <GoogleIcon
                      name={purchaseCostVisible ? "visibility" : "visibility_off"}
                      className={purchaseCostVisible ? "text-emerald-700 text-[18px]" : "text-inherit text-[18px]"}
                    />
                    <span>{purchaseCostVisible ? "Hide Rate" : "Show Rate"}</span>
                  </button>
                ) : null}
              </div>
            </div>

            {/* Row 2: Full-Width Desktop Filter Toolbar (Smart proportional widths, zero dead space) */}
            <div className="flex flex-wrap items-center gap-2 xl:gap-2.5">
              {/* Brand Selector */}
              <div className="min-w-[130px] flex-[1.1]">
                <Select
                  value={brand}
                  onChange={setBrand}
                  options={brandOptions}
                />
              </div>

              {/* Category */}
              <div className="min-w-[130px] flex-[1.1]">
                <CreatableCombobox
                  value={category}
                  onChange={setCategory}
                  options={categories}
                  placeholder="All Categories"
                  ariaLabel="Filter products by category"
                  allowCreate={false}
                  selectOnFocus
                  compact
                  className="!h-10 !rounded-[10px] px-2.5 text-[12px] font-semibold"
                />
              </div>

              {/* Sort By */}
              <div className="min-w-[135px] flex-[1.1]">
                <Select
                  value={sortBy}
                  onChange={(v) => setSortBy?.(v as any)}
                  options={sortOptions}
                />
              </div>

              {/* Pricing Status */}
              <div className="min-w-[110px] flex-1">
                <Select
                  value={pricingStatus}
                  onChange={(v) => setPricingStatus?.(v as any)}
                  options={pricingOptions}
                />
              </div>

              {/* Photo Status */}
              <div className="min-w-[110px] flex-1">
                <Select
                  value={photoStatus}
                  onChange={(v) => setPhotoStatus?.(v as any)}
                  options={photoOptions}
                />
              </div>

              {/* Product Status */}
              <div className="inline-flex shrink-0 items-center rounded-[10px] border border-[#CFCFD3] bg-white p-0.5">
                {(
                  [
                    ["all", "All"],
                    ["active", "Active"],
                    ["inactive", "Inactive"],
                  ] as const
                ).map(([val, lbl]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setStatus(val)}
                    className={cn(
                      "rounded-[7px] px-2.5 py-1 text-[12px] font-bold transition",
                      status === val
                        ? "bg-[#11120d] text-white"
                        : "text-[#565449] hover:bg-[#F3F4F6]",
                    )}
                  >
                    {lbl}
                  </button>
                ))}
              </div>

              {/* Stock Status */}
              {stockTracked ? (
                <div className="inline-flex shrink-0 items-center rounded-[10px] border border-[#CFCFD3] bg-white p-0.5">
                  {(
                    [
                      ["all", "All"],
                      ["in", "In Stock"],
                      ["low", "Low"],
                      ["out", "Out"],
                    ] as const
                  ).map(([val, lbl]) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setStockStatus(val)}
                      className={cn(
                        "rounded-[7px] px-2 py-1 text-[11.5px] font-bold transition",
                        stockStatus === val
                          ? "bg-[#238A32] text-white"
                          : "text-[#565449] hover:bg-[#F3F4F6]",
                      )}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
              ) : null}

              {/* Clear Button */}
              {filterCount > 0 || q.trim() ? (
                <button
                  type="button"
                  onClick={onClear}
                  className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-[10px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6] hover:text-[#000000]"
                >
                  <GoogleIcon name="filter_alt_off" className="text-[16px] text-[#8C8889]" />
                  <span>Clear</span>
                  {filterCount > 0 ? (
                    <span className="rounded-full bg-[#11120d] px-1.5 py-0.2 text-[10px] font-black text-white">
                      {filterCount}
                    </span>
                  ) : null}
                </button>
              ) : null}
            </div>

            {/* Desktop Active Filter Chips */}
            {filterChips.length > 0 ? (
              <ActiveFilterChips items={filterChips} className="pt-1" />
            ) : null}
          </div>
        </Card>
      </div>
    </>
  );
}
