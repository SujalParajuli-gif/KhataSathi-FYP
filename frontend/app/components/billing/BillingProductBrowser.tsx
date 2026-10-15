import { formatBillingMoney } from "~/lib/billingWorkspace";
import GoogleIcon from "~/components/ui/GIcon";
import PreviewableImage from "~/components/ui/PreviewableImage";
import BillingOverflowMenu from "./BillingOverflowMenu";
import React, { useEffect, useState, useRef } from "react";
import Icon from "~/components/ui/Icon";
import ProjectSelect from "~/components/ui/ProjectSelect";


export interface BillingProductItem {
  quantityStep?: number;
  id: string;
  name: string;
  sku?: string | null;
  barcode?: string | null;
  retailPrice: number;
  sellingPriceStatus?: "READY" | "PENDING";
  wholesalePrice?: number | null;
  stock: number;
  lowStockThreshold?: number | null;
  imageUrl?: string | null;
  category?: string | null;
  saleUnit?: string | null;
}

interface BillingProductBrowserProps {
  products: BillingProductItem[];
  loading: boolean;
  error?: string | null;
  onRetry: () => void;
  customerName?: string | null;
  searchTerm: string;
  onSearchChange: (value: string) => void;
  selectedCategory: string;
  onSelectCategory: (cat: string) => void;
  categories: string[];
  sortBy: string;
  onSortByChange: (sort: string) => void;
  page: number;
  pageSize: number;
  totalProducts: number;
  onPageChange: (newPage: number) => void;
  onAddToCart: (product: BillingProductItem) => void;
  getAddDisabledReason?: (product: BillingProductItem) => string | null;
  canViewWholesalePrice?: boolean;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  barcodeInputRef?: React.RefObject<HTMLInputElement | null>;
  onBarcodeScan?: (barcode: string) => boolean | void | Promise<boolean | void>;
  activeCustomerId?: string | null;
}

const SORT_OPTIONS = [
  { value: "popularity", label: "Popularity (Best First)" },
  { value: "photos_first", label: "Photos First" },
  { value: "name_asc", label: "Name (A to Z)" },
  { value: "name_desc", label: "Name (Z to A)" },
  { value: "price_asc", label: "Price (Low to High)" },
  { value: "price_desc", label: "Price (High to Low)" },
  { value: "newest", label: "Recently Added" },
];

export default function BillingProductBrowser({
  products,
  loading,
  error,
  onRetry,
  customerName,
  searchTerm,
  onSearchChange,
  selectedCategory,
  onSelectCategory,
  categories,
  sortBy,
  onSortByChange,
  page,
  pageSize,
  totalProducts,
  onPageChange,
  onAddToCart,
  getAddDisabledReason,
  canViewWholesalePrice = false,
  searchInputRef,
  barcodeInputRef,
  onBarcodeScan,
}: BillingProductBrowserProps) {
  const categoryRailRef = useRef<HTMLDivElement>(null);
  const categoryMeasureRef = useRef<HTMLDivElement>(null);
  const [visibleCategoryCount, setVisibleCategoryCount] = useState(0);
  useEffect(() => {
    const rail = categoryRailRef.current;
    if (!rail) return;
    const update = () => {
      const widths = Array.from(categoryMeasureRef.current?.children || []).map(el => el.getBoundingClientRect().width);
      const available = rail.clientWidth - 24;
      let used = widths[0] || 0;
      let count = 0;
      for (let i = 1; i < widths.length && count < 4; i++) {
        const next = used + 6 + widths[i];
        const reserve = i < categories.length ? 80 : 0;
        if (next + reserve > available) break;
        used = next;
        count++;
      }
      setVisibleCategoryCount(count);
    };
    const observer = new ResizeObserver(update);
    observer.observe(rail);
    document.fonts.ready.then(update);
    update();
    return () => observer.disconnect();
  }, [categories]);
  const [barcodeValue, setBarcodeValue] = useState("");
  const [showBarcodeScanInput, setShowBarcodeScanInput] = useState(false);
  const totalPages = Math.max(1, Math.ceil(totalProducts / pageSize));
  const [searchIndex, setSearchIndex] = useState(0);
  const [searchFocused, setSearchFocused] = useState(false);
  const resultRows = useRef<Array<HTMLTableRowElement | null>>([]);
  const activeSearch = Boolean(searchFocused && searchTerm.trim() && !loading && !error && products.length);
  useEffect(() => { setSearchIndex(0); }, [searchTerm, selectedCategory, sortBy, page, products]);
  useEffect(() => {
    if (!activeSearch) return;
    const row = resultRows.current[searchIndex];
    const container = row?.closest<HTMLElement>(".billing-list");
    if (!row || !container) return;
    const rowBox = row.getBoundingClientRect();
    const box = container.getBoundingClientRect();
    const headerHeight = container.querySelector("thead")?.getBoundingClientRect().height || 0;
    if (rowBox.top < box.top + headerHeight) container.scrollTop -= box.top + headerHeight - rowBox.top;
    else if (rowBox.bottom > box.bottom) container.scrollTop += rowBox.bottom - box.bottom;
  }, [searchIndex, activeSearch]);
  function unavailableReason(product: BillingProductItem) {
    return product.sellingPriceStatus === "PENDING" ? "Price required" : product.stock <= 0 ? "Out of stock" : getAddDisabledReason?.(product) || null;
  }
  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onSearchChange("");
      return;
    }
    if (!activeSearch) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setSearchIndex(index => Math.max(0, Math.min(products.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const selected = products[searchIndex];
      if (selected && !unavailableReason(selected)) onAddToCart(selected);
    }
  }
  useEffect(() => {
    const open = () => setShowBarcodeScanInput(true);
    window.addEventListener("billing-open-scanner", open);
    return () => window.removeEventListener("billing-open-scanner", open);
  }, []);
  useEffect(() => { if (showBarcodeScanInput) barcodeInputRef?.current?.focus(); }, [showBarcodeScanInput, barcodeInputRef]);

  const handleBarcodeKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && barcodeValue.trim()) {
      e.preventDefault();
      if (onBarcodeScan) {
        const result = await onBarcodeScan(barcodeValue.trim());
        if (result === false) return;
      }
      setBarcodeValue("");
    }
  };

  return (
    <div className="billing-card">
      {/* Header matching Mockup: "Products" + "Search or scan to add" */}
      <div className="flex items-center justify-between border-b border-line bg-white px-4 py-3">
        <h2 className="text-[15px] font-semibold text-ink">Products</h2>
        <span className="text-[12px] font-medium text-muted">{loading && customerName ? `Loading products for ${customerName}` : "Search or scan to add"}</span>
      </div>


      {/* Search Input Row with F2 tag + Barcode Scanner Trigger */}
      <div className="border-b border-line bg-white px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-muted">
              <Icon name="search" className="text-[17px]" />
            </span>
            <input
              ref={searchInputRef}
              type="text"
              value={searchTerm}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              role="combobox"
              aria-label="Search products"
              aria-autocomplete="none"
              aria-haspopup="grid"
              aria-expanded={activeSearch}
              aria-controls={products.length && !loading && !error ? "billing-product-results" : undefined}
              aria-activedescendant={activeSearch ? `catalog-result-${products[searchIndex]?.id}` : undefined}
              placeholder="Search product name, SKU or brand..."
              className="w-full rounded-lg border border-line bg-white py-1.5 pl-9 pr-14 text-[13px] font-medium text-ink placeholder-[#8C8889] focus:border-[#102043] focus:outline-none focus:ring-1 focus:ring-[#102043]"
            />
            <div className="absolute inset-y-0 right-0 flex items-center pr-2.5 gap-1">
              {searchTerm ? (
                <button
                  type="button"
                  onClick={() => onSearchChange("")}
                  className="text-muted hover:text-ink"
                  aria-label="Clear search"
                >
                  <Icon name="close" className="text-[14px]" />
                </button>
              ) : (
                <span className="rounded border border-line bg-[#F8FAFC] px-1.5 py-0.5 text-[12px] font-sans font-medium text-muted">
                  F2
                </span>
              )}
            </div>
          </div>

          {/* Barcode scanner button */}
          <button
            type="button"
            onClick={() => setShowBarcodeScanInput((v) => !v)}
            title="Toggle Barcode Scanner Input (F3)"
            className={`flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg border transition ${
              showBarcodeScanInput
                ? "border-[#102043] bg-[#102043] text-white"
                : "border-line bg-white text-muted hover:bg-inset"
            }`}
          >
            <Icon name="barcode_scanner" className="text-[18px]" />
          </button>
        </div>

        {/* Expandable Barcode Scan Input */}
        {showBarcodeScanInput && (
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-line bg-inset p-2 animate-in fade-in duration-150">
            <Icon name="qr_code_scanner" className="text-[16px] text-muted" />
            <input
              ref={barcodeInputRef}
              type="text"
              autoFocus
              value={barcodeValue}
              onChange={(e) => setBarcodeValue(e.target.value)}
              onKeyDown={handleBarcodeKeyDown}
              placeholder="Scan or enter barcode & press Enter (F3)"
              className="flex-1 bg-transparent font-sans text-[12px] text-ink placeholder-[#8C8889] focus:outline-none"
            />
            {barcodeValue && (
              <button
                type="button"
                onClick={() => setBarcodeValue("")}
                className="text-muted hover:text-ink"
              >
                <Icon name="close" className="text-[13px]" />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="billing-category-chips" ref={categoryRailRef}><div ref={categoryMeasureRef} className="billing-category-measure" aria-hidden="true">{["All",...categories].map((cat,index)=><span key={`${index}-${cat}`}>{cat}</span>)}</div><button type="button" aria-pressed={selectedCategory==="ALL"} onClick={()=>onSelectCategory("ALL")}>All</button>{categories.slice(0,visibleCategoryCount).map(cat=><button key={cat} type="button" title={cat} aria-pressed={selectedCategory===cat} onClick={()=>onSelectCategory(cat)}>{cat}</button>)}{categories.length>visibleCategoryCount&&<BillingOverflowMenu searchable label={categories.slice(visibleCategoryCount).includes(selectedCategory)?`More · ${selectedCategory}`:"More categories"} options={categories.slice(visibleCategoryCount).map(cat=>({value:cat,label:cat}))} selected={selectedCategory} onSelect={onSelectCategory}/>}</div>
      {/* Product List Table */}
      <div className="billing-list">
        {error ? <div role="alert" className="p-4 text-sm text-rose-700">{error}<button type="button" onClick={onRetry} className="ml-2 underline">Retry</button></div> : loading ? (
          <div className="divide-y divide-[#e4edf6]">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 p-3 animate-pulse">
                <div className="h-10 w-10 shrink-0 rounded-lg bg-[#e4edf6]" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-3/4 rounded bg-[#e4edf6]" />
                  <div className="h-2.5 w-1/3 rounded bg-inset" />
                </div>
                <div className="h-4 w-14 rounded bg-[#e4edf6]" />
                <div className="h-4 w-10 rounded bg-[#e4edf6]" />
              </div>
            ))}
          </div>
        ) : products.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center p-8 text-center text-muted">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-inset text-muted">
              <Icon name="inventory_2" className="text-[24px]" />
            </div>
            <p className="mt-3 text-[13px] font-medium text-ink">No items found</p>
            <p className="mt-1 text-[12px] text-muted">
              Try clearing filters or search by a different term.
            </p>
            {(searchTerm || selectedCategory !== "ALL") && (
              <button
                type="button"
                onClick={() => {
                  onSearchChange("");
                  onSelectCategory("ALL");
                }}
                className="mt-3 rounded-lg border border-line bg-white px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-inset"
              >
                Clear Filters
              </button>
            )}
          </div>
        ) : (
          <table id="billing-product-results" role="grid" aria-label="Product results" className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-10 border-b border-line bg-inset text-[12px] font-medium  text-muted">
              <tr>
                <th className="py-2.5 pl-3 pr-2">Product / SKU</th>
                <th className="py-2.5 px-2 text-right">Rate (रु)</th>
                <th className="py-2.5 px-2 text-center w-16">Stock</th>
                <th className="py-2.5 pr-3 pl-2 text-center w-11"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#e4edf6]">
              {products.map((p, index) => {
                const isOutOfStock = p.stock <= 0;
                const isUnpriced = p.sellingPriceStatus === "PENDING";
                const isLowStock = !isOutOfStock && (p.lowStockThreshold || 0) > 0 && p.stock <= (p.lowStockThreshold || 0);
                const disabledReason = unavailableReason(p);
                const stockNotice = disabledReason || (isLowStock ? "Low stock" : null);
                const catStyle = { bg: "bg-inset border-line", text: "text-muted", icon: "inventory_2" };

                return (
                  <tr
                    key={p.id}
                    id={`catalog-result-${p.id}`}
                    ref={element => { resultRows.current[index] = element; }}
                    aria-selected={activeSearch && searchIndex === index}
                    onClick={() => { if (!disabledReason) onAddToCart(p); }}
                    className={`transition group ${activeSearch && searchIndex === index ? "bg-inset outline outline-1 -outline-offset-1 outline-line" : ""} ${disabledReason ? "billing-product-unavailable" : "cursor-pointer hover:bg-[#F8FAFC] active:bg-inset"}`}
                  >
                    {/* Thumbnail + Name & SKU */}
                    <td className="pl-3 pr-2 align-middle">
                      <div className="flex items-center gap-2.5">
                        <div onClick={e=>e.stopPropagation()} className={`flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border ${catStyle.bg}`}>
                          <PreviewableImage presentation="billing" src={p.imageUrl} alt={p.name} title={p.name} className="flex h-full w-full items-center justify-center bg-inset" fallback={<GoogleIcon name="inventory_2" sizePx={22} className="text-[#8C8889]"/>}/>
                        </div>
                        <div className="min-w-0">
                          <div title={p.name} className="font-semibold text-black line-clamp-2">
                            {p.name}
                          </div>
                          <div className="flex items-center gap-1.5 text-[12px] text-muted">
                            {p.sku ? (
                              <span title={p.sku || undefined} className="block max-w-[180px] truncate text-muted">{p.sku}</span>
                            ) : null}
                            {p.category && (
                              <span className="text-muted">
                                &bull; {p.category}
                              </span>
                            )}
                          </div>
                          {stockNotice && <span id={`catalog-stock-${p.id}`} className={`billing-stock-notice ${disabledReason ? "is-unavailable" : ""}`}>{stockNotice}</span>}
                        </div>
                      </div>
                    </td>

                    {/* Rate (रु) */}
                    <td className="px-2 align-middle whitespace-nowrap font-sans font-semibold text-black">
                      <div>{isUnpriced ? "Rate needed" : formatBillingMoney(p.retailPrice)}</div>

                    </td>

                    {/* Stock Status (matching vibrant green in mockup) */}
                    <td className="px-2 align-middle font-sans text-[12px]">
                      <span
                        className={`font-medium ${
                          isOutOfStock
                            ? "text-rose-600 font-semibold"
                            : isLowStock
                            ? "text-amber-600 font-medium"
                            : "text-green-700 font-medium"
                        }`}
                      >
                        {p.stock}
                      </span>
                    </td>

                    {/* Add Button: Square with + icon */}
                    <td className="pr-3 pl-1 align-middle">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onAddToCart(p);
                        }}
                        disabled={!!disabledReason}
                        title={disabledReason || `Add ${p.name}`}
                        aria-describedby={stockNotice ? `catalog-stock-${p.id}` : undefined}
                        aria-label={`Add ${p.name} to cart`}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-line bg-white text-ink shadow-2xs transition hover:border-[#102043] hover:bg-[#102043] hover:text-white"
                      >
                        <Icon name="add" className="text-[16px]" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

      {/* Pagination Footer matching mockup: "< 1 2 3 ... Showing 1-X of Y products" */}
      <div className="billing-products-footer">
        <div className="billing-products-page-buttons flex items-center">
          <button
            type="button"
            disabled={page <= 1 || loading}
            onClick={() => onPageChange(page - 1)}
            className="flex h-6 w-6 items-center justify-center rounded border border-line bg-white text-muted hover:enabled:bg-inset disabled:opacity-30"
            aria-label="Previous page"
          >
            <Icon name="chevron_left" className="text-[14px]" />
          </button>
          {Array.from({ length: Math.min(5, totalPages) }).map((_, idx) => {
            const pageNum = Math.max(1,Math.min(page-2,totalPages-4))+idx;
            const isActive = pageNum === page;
            return (
              <button
                key={pageNum}
                aria-current={isActive ? "page" : undefined}
                type="button"
                onClick={() => onPageChange(pageNum)}
                className={`flex h-6 w-6 items-center justify-center rounded text-[12px] font-medium transition ${
                  isActive
                    ? "bg-[#102043] text-white"
                    : "text-muted hover:bg-inset"
                }`}
              >
                {pageNum}
              </button>
            );
          })}
          {totalPages > 5 && page < totalPages - 2 && (
            <>
              <span className="text-muted px-0.5">...</span>
              <button
                type="button"
                onClick={() => onPageChange(totalPages)}
                className={`flex h-6 w-6 items-center justify-center rounded text-[12px] font-medium transition ${
                  page === totalPages
                    ? "bg-[#102043] text-white"
                    : "text-muted hover:bg-inset"
                }`}
              >
                {totalPages}
              </button>
            </>
          )}
          <button
            type="button"
            disabled={page >= totalPages || loading}
            onClick={() => onPageChange(page + 1)}
            className="flex h-6 w-6 items-center justify-center rounded border border-line bg-white text-muted hover:enabled:bg-inset disabled:opacity-30"
            aria-label="Next page"
          >
            <Icon name="chevron_right" className="text-[14px]" />
          </button>
        </div>

        <span className="billing-products-range text-[12px] text-muted font-medium">
          Showing {products.length > 0 ? (page - 1) * pageSize + 1 : 0}-{Math.min(page * pageSize, totalProducts)} of {totalProducts} products
        </span>
      </div></div>
    </div>
  );
}
