import React from "react";
import GoogleIcon from "~/components/ui/GIcon";
import PreviewableImage from "~/components/ui/PreviewableImage";
import ProjectSelect from "~/components/ui/ProjectSelect";
import type { Product } from "~/lib/domain/products/products.types";
import {
  cn,
  formatNpr,
  getStockFlag,
} from "~/lib/domain/products/products.helpers";

type ProductStatus = "Active" | "Inactive";
type StockFlag = "In Stock" | "Low Stock" | "Out of Stock";

// simple card wrapper for the table section
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[18px] border border-[#DADDE3] bg-white shadow-sm">
      {children}
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

function StockPill({ flag }: { flag: StockFlag }) {
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

function IconButton({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="inline-flex h-[40px] w-[40px] items-center justify-center rounded-[12px] border border-[#CFCFD3] bg-white hover:bg-[#F3F4F6] active:scale-[0.98]"
    >
      <GoogleIcon name={icon} className="text-[#565449]" />
    </button>
  );
}

function formatQty(value: number) {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function formatSize(product: Product) {
  if (!product.sizeValue || product.sizeUnit === "STANDARD") return "Standard";
  return `${formatQty(product.sizeValue)} ${product.sizeUnit}`;
}

function formatPackage(product: Product) {
  return `${formatQty(product.packageQuantity || 1)} ${product.packageUnit || "PIECE"}`;
}

function buildPaginationItems(page: number, totalPages: number) {
  const items: Array<number | "ellipsis-start" | "ellipsis-end"> = [];
  const safeTotalPages = Math.max(1, totalPages);
  const safePage = Math.min(safeTotalPages, Math.max(1, page));
  const windowStart = Math.max(2, safePage - 2);
  const windowEnd = Math.min(safeTotalPages - 1, safePage + 2);

  items.push(1);

  if (windowStart > 2) {
    items.push("ellipsis-start");
  }

  for (let pageNumber = windowStart; pageNumber <= windowEnd; pageNumber += 1) {
    items.push(pageNumber);
  }

  if (windowEnd < safeTotalPages - 1) {
    items.push("ellipsis-end");
  }

  if (safeTotalPages > 1) {
    items.push(safeTotalPages);
  }

  return items;
}

// data table for displaying products
// supports row selection via checkboxes, sorting (conceptually), and pagination controls at the bottom
export default function ProductsTableCard({
  rows,
  loading,
  loadError,
  selected,
  toggleAllOnPage,
  toggleOne,
  onView,
  onEdit,
  onDelete,
  total,
  start,
  end,
  page,
  totalPages,
  pageSize,
  onPageChange,
  onPageSizeChange,
  onClearFilters,
  onRetry,
}: {
  rows: Product[];
  loading?: boolean;
  loadError?: string;
  selected: Record<string, boolean>;
  toggleAllOnPage: (checked: boolean) => void;
  toggleOne: (id: string, checked: boolean) => void;
  onView: (p: Product) => void;
  onEdit: (p: Product) => void;
  onDelete: (p: Product) => void;
  total: number;
  start: number;
  end: number;
  page: number;
  totalPages: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onClearFilters: () => void;
  onRetry: () => void;
}) {
  const paginationItems = buildPaginationItems(page, totalPages);
  const [mobilePaginationOpen, setMobilePaginationOpen] = React.useState(false);
  const [mobileActionProduct, setMobileActionProduct] = React.useState<Product | null>(null);
  const [mobileGoPage, setMobileGoPage] = React.useState(String(page));
  const longPressTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressedProductId = React.useRef<string | null>(null);
  const longPressOrigin = React.useRef<{ x: number; y: number } | null>(null);
  const selectionMode = Object.values(selected).some(Boolean);

  React.useEffect(() => {
    setMobileGoPage(String(page));
  }, [page]);

  React.useEffect(() => () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  }, []);

  function startLongPress(productId: string, x: number, y: number) {
    if (selectionMode) return;
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressedProductId.current = null;
    longPressOrigin.current = { x, y };
    longPressTimer.current = setTimeout(() => {
      longPressedProductId.current = productId;
      toggleOne(productId, true);
      if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(18);
    }, 450);
  }

  function cancelLongPress() {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
    longPressOrigin.current = null;
  }

  return (
    <>
      <section className="space-y-3 lg:hidden" aria-label="Products catalog">
        {loading && rows.length === 0 ? (
          <div className="space-y-3">
            {[0, 1, 2].map((item) => (
              <div key={item} className="h-[136px] animate-pulse rounded-[14px] border border-[#E5E7EB] bg-[#F8FAFC]" />
            ))}
          </div>
        ) : null}

        {!loading && rows.length === 0 ? (
          <div className="flex min-h-[52dvh] flex-col items-center justify-center px-5 py-10 text-center">
            <div className="inline-flex h-28 w-28 items-center justify-center rounded-full bg-[#F8FAFC] text-[#A3A3A3]">
              <GoogleIcon name={loadError ? "error_outline" : "inventory_2"} className="text-[58px]" />
            </div>
            <h2 className="mt-6 text-[21px] font-extrabold text-[#11120d]">
              {loadError || "No products match your filters."}
            </h2>
            <p className="mt-2 max-w-[320px] text-[14px] leading-6 text-[#6B7280]">
              {loadError ? "Check your connection and try loading the catalog again." : "Try removing some filters or clearing your search."}
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              {!loadError ? (
                <button type="button" onClick={onClearFilters} className="inline-flex h-12 items-center justify-center gap-2 rounded-[12px] border border-[#CFCFD3] bg-white px-4 text-[14px] font-bold text-[#11120d]">
                  <GoogleIcon name="filter_alt_off" className="text-[20px]" />
                  Clear all filters
                </button>
              ) : null}
              <button type="button" onClick={onRetry} className="h-12 rounded-[12px] px-4 text-[14px] font-bold text-[#11120d]">Retry</button>
            </div>
          </div>
        ) : null}

        {rows.map((product) => {
          const flag = getStockFlag(product);
          const isSelected = !!selected[product.id];
          return (
            <article
              key={product.id}
              role="button"
              tabIndex={0}
              onPointerDown={(event) => {
                if (event.button === 0) startLongPress(product.id, event.clientX, event.clientY);
              }}
              onPointerMove={(event) => {
                const origin = longPressOrigin.current;
                if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 8) cancelLongPress();
              }}
              onPointerUp={cancelLongPress}
              onPointerCancel={cancelLongPress}
              onPointerLeave={cancelLongPress}
              onContextMenu={(event) => {
                event.preventDefault();
                cancelLongPress();
                longPressedProductId.current = product.id;
                if (!isSelected) toggleOne(product.id, true);
              }}
              onClick={() => {
                if (longPressedProductId.current === product.id) {
                  longPressedProductId.current = null;
                  return;
                }
                selectionMode ? toggleOne(product.id, !isSelected) : onView(product);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  selectionMode ? toggleOne(product.id, !isSelected) : onView(product);
                }
              }}
              className={cn(
                "relative grid min-h-[132px] grid-cols-[92px_minmax(0,1fr)] gap-3 rounded-[14px] border bg-white p-3 transition active:scale-[0.995]",
                isSelected ? "border-[#179B4D] bg-[#F3FBF6]" : "border-[#E5E7EB]",
                selectionMode && "pl-10",
              )}
            >
              {selectionMode ? (
                <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); toggleOne(product.id, !isSelected); }}
                  className={cn(
                    "absolute left-2.5 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-[7px] border",
                    isSelected ? "border-[#179B4D] bg-[#179B4D] text-white" : "border-[#9CA3AF] bg-white text-transparent",
                  )}
                  aria-label={`${isSelected ? "Deselect" : "Select"} ${product.name}`}
                >
                  <GoogleIcon name="check" className="text-[16px]" />
                </button>
              ) : null}

              <PreviewableImage
                src={product.imageUrl}
                alt={product.name}
                title={product.name}
                subtitle={`SKU: ${product.sku}`}
                enablePreview="desktop"
                imgClassName="h-full w-full object-contain p-1.5"
                className="flex h-[104px] w-[92px] items-center justify-center overflow-hidden rounded-[12px] border border-[#E5E7EB] bg-white"
                fallback={<GoogleIcon name="inventory_2" sizePx={32} className="text-[#8C8889]" />}
              />

              <div className="min-w-0 pr-8">
                <div className="line-clamp-2 text-[17px] font-extrabold leading-6 text-[#11120d]">{product.name}</div>
                <div className="mt-1 truncate font-mono text-[12px] font-medium text-[#6B7280]">SKU: {product.sku}</div>
                <div className="mt-3 text-[18px] font-extrabold text-[#11120d]">{formatNpr(product.retailPrice)}</div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-[13px] font-semibold text-[#565449]">
                    <span className={cn("h-2.5 w-2.5 rounded-full", flag === "In Stock" ? "bg-emerald-500" : flag === "Low Stock" ? "bg-amber-500" : "bg-red-500")} />
                    {formatQty(product.stock)} {product.saleUnit || "PIECE"}
                  </div>
                  <StatusPill status={product.status} />
                </div>
              </div>

              {!selectionMode ? (
                <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); setMobileActionProduct(product); }}
                  className="absolute right-2 top-2 inline-flex h-10 w-10 items-center justify-center rounded-full text-[#565449]"
                  aria-label={`Actions for ${product.name}`}
                >
                  <GoogleIcon name="more_vert" className="text-[23px]" />
                </button>
              ) : null}
            </article>
          );
        })}

        {rows.length > 0 ? (
          <div className="flex items-center justify-between gap-3 px-1 py-2">
            <button type="button" onClick={() => setMobilePaginationOpen(true)} className="min-h-11 text-left text-[13px] text-[#565449]">
              Showing <strong className="text-[#11120d]">{total === 0 ? 0 : start + 1}–{end}</strong> of <strong className="text-[#11120d]">{total}</strong> products
            </button>
            <div className="flex gap-2">
              <button type="button" disabled={page <= 1} onClick={() => onPageChange(Math.max(1, page - 1))} className="inline-flex h-11 w-11 items-center justify-center rounded-[11px] border border-[#CFCFD3] bg-white disabled:opacity-35" aria-label="Previous page"><GoogleIcon name="chevron_left" /></button>
              <button type="button" disabled={page >= totalPages} onClick={() => onPageChange(Math.min(totalPages, page + 1))} className="inline-flex h-11 w-11 items-center justify-center rounded-[11px] border border-[#CFCFD3] bg-white disabled:opacity-35" aria-label="Next page"><GoogleIcon name="chevron_right" /></button>
            </div>
          </div>
        ) : null}
      </section>

      {mobileActionProduct ? (
        <div className="fixed inset-0 z-[130] lg:hidden">
          <button type="button" className="absolute inset-0 bg-slate-950/50" onClick={() => setMobileActionProduct(null)} aria-label="Close product actions" />
          <section role="dialog" aria-modal="true" aria-label={`${mobileActionProduct.name} actions`} className="absolute inset-x-0 bottom-0 rounded-t-[26px] bg-white px-4 pb-0 pt-3 shadow-2xl">
            <div className="mx-auto h-1.5 w-14 rounded-full bg-[#CFCFD3]" />
            <div className="mt-4 flex items-center gap-3 border-b border-[#E5E7EB] pb-4">
              <PreviewableImage src={mobileActionProduct.imageUrl} alt={mobileActionProduct.name} title={mobileActionProduct.name} enablePreview="desktop" imgClassName="h-full w-full object-contain p-1" className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-[12px] border border-[#E5E7EB] bg-white" fallback={<GoogleIcon name="inventory_2" className="text-[#8C8889]" />} />
              <div className="min-w-0 flex-1"><div className="truncate text-[17px] font-extrabold">{mobileActionProduct.name}</div><div className="mt-1 truncate font-mono text-[12px] text-[#6B7280]">SKU: {mobileActionProduct.sku}</div></div>
              <button type="button" onClick={() => setMobileActionProduct(null)} className="h-11 w-11" aria-label="Close actions"><GoogleIcon name="close" className="text-[25px]" /></button>
            </div>
            {[
              { icon: "visibility", label: "View details", action: () => onView(mobileActionProduct) },
              { icon: "edit", label: "Edit product", action: () => onEdit(mobileActionProduct) },
              { icon: "check_box", label: "Select product", action: () => toggleOne(mobileActionProduct.id, true) },
              { icon: "do_not_disturb_on", label: mobileActionProduct.status === "Active" ? "Deactivate product" : "Product options", action: () => onDelete(mobileActionProduct), danger: true },
            ].map((item) => (
              <button key={item.label} type="button" onClick={() => { setMobileActionProduct(null); item.action(); }} className={cn("flex min-h-[58px] w-full items-center gap-3 border-b border-[#E5E7EB] text-left last:min-h-[calc(58px+env(safe-area-inset-bottom))] last:border-0 last:pb-[env(safe-area-inset-bottom)]", item.danger ? "text-[#BE123C]" : "text-[#11120d]")}><GoogleIcon name={item.icon} className="text-[21px]" /><span className="flex-1 text-[15px] font-bold">{item.label}</span><GoogleIcon name="chevron_right" /></button>
            ))}
          </section>
        </div>
      ) : null}

      {mobilePaginationOpen ? (
        <div className="fixed inset-0 z-[130] lg:hidden">
          <button type="button" className="absolute inset-0 bg-slate-950/50" onClick={() => setMobilePaginationOpen(false)} aria-label="Close pagination" />
          <section role="dialog" aria-modal="true" aria-label="Pagination" className="absolute inset-x-0 bottom-0 rounded-t-[26px] bg-white px-4 pb-0 pt-3 shadow-2xl">
            <div className="mx-auto h-1.5 w-14 rounded-full bg-[#CFCFD3]" />
            <div className="mt-3 flex items-center justify-between"><h2 className="text-[22px] font-extrabold">Pagination</h2><button type="button" onClick={() => setMobilePaginationOpen(false)} className="h-11 w-11" aria-label="Close pagination"><GoogleIcon name="close" className="text-[26px]" /></button></div>
            <div className="mt-5 text-[14px] font-bold">Rows per page</div>
            <div className="mt-2 grid grid-cols-3 overflow-hidden rounded-[12px] border border-[#CFCFD3]">
              {[20, 50, 100].map((value) => <button key={value} type="button" onClick={() => onPageSizeChange(value)} className={cn("h-[52px] border-r border-[#CFCFD3] text-[15px] font-bold last:border-0", pageSize === value ? "bg-[#11120d] text-white" : "bg-white")}>{value}</button>)}
            </div>
            <div className="mt-6 text-[14px] font-bold">Page</div>
            <div className="mt-3 flex items-center justify-between"><button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)} className="inline-flex h-14 w-14 items-center justify-center rounded-full border border-[#CFCFD3] disabled:opacity-35"><GoogleIcon name="chevron_left" className="text-[30px]" /></button><div className="text-[22px] font-extrabold">Page {page} of {totalPages}</div><button type="button" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} className="inline-flex h-14 w-14 items-center justify-center rounded-full border border-[#CFCFD3] disabled:opacity-35"><GoogleIcon name="chevron_right" className="text-[30px]" /></button></div>
            <label className="mt-6 block text-[14px] font-bold">Go to page</label>
            <div className="mt-2 flex overflow-hidden rounded-[12px] border border-[#CFCFD3]"><input type="number" min={1} max={totalPages} value={mobileGoPage} onChange={(event) => setMobileGoPage(event.target.value)} className="h-[52px] min-w-0 flex-1 px-3 text-[15px] font-semibold outline-none" /><button type="button" onClick={() => { const next = Math.min(totalPages, Math.max(1, Number(mobileGoPage) || 1)); onPageChange(next); setMobilePaginationOpen(false); }} className="w-24 bg-[#11120d] text-[15px] font-bold text-white">Go</button></div>
            <div className="mt-5 pb-[env(safe-area-inset-bottom)] text-center text-[13px] text-[#6B7280]">Showing {total === 0 ? 0 : start + 1}–{end} of {total} products</div>
          </section>
        </div>
      ) : null}

      <div className="hidden lg:block">
      <Card>
      <div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] border-collapse text-left">
            <thead>
              <tr className="border-b border-[#DADDE3] bg-[#F8FAFC] text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                <th className="w-[44px] px-3 py-3">
                  <input
                    type="checkbox"
                    checked={rows.length > 0 && rows.every((product) => selected[product.id])}
                    onChange={(event) => toggleAllOnPage(event.target.checked)}
                    aria-label="Select all rows on this page"
                    className="h-[16px] w-[16px]"
                  />
                </th>
                <th className="px-3 py-3">Product</th>
                <th className="px-3 py-3">Source</th>
                <th className="px-3 py-3">Group / Variant</th>
                <th className="px-3 py-3">Size</th>
                <th className="px-3 py-3">Package</th>
                <th className="px-3 py-3">Rate / Piece</th>
                <th className="px-3 py-3">Qty Wholesale</th>
                <th className="px-3 py-3">Stock</th>
                <th className="px-3 py-3">Status</th>
                <th className="w-[120px] px-3 py-3 text-right">Action</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-[#E5E7EB]">
              {rows.map((product) => {
                const flag = getStockFlag(product);
                const isSelected = !!selected[product.id];

                return (
                  <tr
                    key={product.id}
                    className={cn(
                      "text-[13px] transition-colors hover:bg-[#ECEFF3]",
                      isSelected && "bg-[#F3F4F6]/80 hover:bg-[#E4E8EE]",
                    )}
                  >
                    <td className="px-3 py-3 align-top">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(event) => toggleOne(product.id, event.target.checked)}
                        aria-label={`Select ${product.name}`}
                        className="h-[16px] w-[16px]"
                      />
                    </td>

                    <td className="px-3 py-3 align-top">
                      <div className="flex items-center gap-[12px]">
                        <PreviewableImage
                          src={product.imageUrl}
                          alt={product.name}
                          title={product.name}
                          subtitle={`SKU: ${product.sku}`}
                          enablePreview="desktop"
                          imgClassName="h-full w-full object-contain p-1"
                          className="flex h-[48px] w-[48px] items-center justify-center overflow-hidden rounded-[12px] border border-[#CFCFD3] bg-[#F3F4F6]"
                          fallback={
                            <GoogleIcon
                              name="inventory_2"
                              sizePx={24}
                              className="text-[#8C8889]"
                            />
                          }
                        />

                        <div className="min-w-0">
                          <div className="max-w-[240px] truncate font-extrabold text-[#000000]">
                            {product.name}
                          </div>
                          <div className="text-[12px] text-[#8C8889]">
                            SKU: {product.sku}
                            {product.barcode ? (
                              <span className="ml-[10px]">Barcode: {product.barcode}</span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td className="px-3 py-3 align-top text-[#565449]">
                      <div className="font-semibold text-[#000000]">
                        {product.vendorSource || product.brand}
                      </div>
                      <div className="mt-[4px] text-[11px] text-[#8C8889]">
                        {product.category || "Uncategorized"}
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top text-[#565449]">
                      <div className="max-w-[150px] truncate font-semibold text-[#000000]">
                        {product.categoryGroup || product.category || "-"}
                      </div>
                      <div className="mt-[4px] max-w-[150px] truncate text-[11px] text-[#8C8889]">
                        {product.productCodeVariant || "No variant"}
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top text-[#565449]">
                      <div className="font-semibold text-[#000000]">
                        {formatSize(product)}
                      </div>
                      <div className="mt-[4px] text-[11px] text-[#8C8889]">
                        Sale unit: {product.saleUnit || "PIECE"}
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top text-[#565449]">
                      <div className="font-semibold text-[#000000]">
                        {formatPackage(product)}
                      </div>
                      <div className="mt-[4px] text-[11px] text-[#8C8889]">
                        Step {formatQty(product.quantityStep || 1)}
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top font-semibold text-[#000000]">
                      {formatNpr(product.ratePerPiece || product.retailPrice)}
                    </td>
                    <td className="px-3 py-3 align-top text-[#565449]">
                      <div className="font-semibold text-[#000000]">
                        {product.wholesaleEligible ? formatNpr(product.wholesalePrice) : "Qty pricing off"}
                      </div>
                      <div className="mt-[4px] text-[11px] text-[#8C8889]">
                        Qty threshold {formatQty(product.thresholdQty)}
                      </div>
                    </td>

                    <td className="px-3 py-3 align-top">
                      <div className="flex max-w-[170px] flex-wrap items-center gap-2">
                        <span
                          className={cn(
                            "h-[8px] w-[8px] rounded-full",
                            flag === "In Stock"
                              ? "bg-emerald-500"
                              : flag === "Low Stock"
                                ? "bg-orange-500"
                                : "bg-rose-500",
                          )}
                          title={`Low stock threshold: ${product.lowStockThreshold}`}
                        />
                        <div className="font-semibold text-[#000000]">
                          {formatQty(product.stock)} {product.saleUnit || "PIECE"}
                        </div>
                        <StockPill flag={flag} />
                      </div>
                    </td>

                    <td className="px-3 py-3 align-top">
                      <StatusPill status={product.status} />
                    </td>

                    <td className="px-3 py-3 align-top">
                      <div className="flex items-center justify-end gap-[8px]">
                        <IconButton
                          icon="visibility"
                          label="View product"
                          onClick={() => onView(product)}
                        />
                        <IconButton
                          icon="edit"
                          label="Edit product"
                          onClick={() => onEdit(product)}
                        />
                        <IconButton
                          icon="delete"
                          label="Delete options"
                          onClick={() => onDelete(product)}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}

              {rows.length === 0 && loading ? (
                <tr>
                  <td colSpan={11} className="px-[14px] py-[22px] text-[14px] font-semibold text-[#565449]">
                    <div className="flex items-center gap-2">
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#CFCFD3] border-t-[#11120d]" />
                      Loading products...
                    </div>
                  </td>
                </tr>
              ) : null}

              {rows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={11} className="px-[14px] py-[22px] text-[14px] text-[#8C8889]">
                    {loadError || "No products match your filters."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-3 border-t border-[#E5E7EB] bg-white px-4 py-3 text-[13px] text-[#565449] lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[8px]">
            <div>
              Showing <span className="font-semibold text-[#000000]">{total === 0 ? 0 : start + 1}</span>
              -<span className="font-semibold text-[#000000]">{end}</span> of{" "}
              <span className="font-semibold text-[#000000]">{total}</span> products
            </div>

            <label className="flex items-center gap-[8px] text-[12px] font-semibold text-[#8C8889]">
              Rows
              <ProjectSelect
                value={pageSize}
                onChange={(event) => onPageSizeChange(Number(event.target.value))}
                className="h-[34px] rounded-[10px] border border-[#CFCFD3] bg-white px-[10px] text-[12px] font-bold text-[#565449] outline-none"
              >
                {[20, 50, 100].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </ProjectSelect>
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-[8px] lg:justify-end">
            <button
              type="button"
              onClick={() => onPageChange(Math.max(1, page - 1))}
              disabled={page <= 1}
              className="inline-flex h-[32px] w-[32px] items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-white text-[#565449] transition hover:bg-[#F3F4F6]"
              aria-label="Previous page"
            >
              <GoogleIcon name="chevron_left" className="text-inherit" />
            </button>

            {paginationItems.map((item) => {
              if (typeof item !== "number") {
                return (
                  <span
                    key={item}
                    className="inline-flex h-[32px] min-w-[24px] items-center justify-center text-[12px] font-extrabold text-[#8C8889]"
                  >
                    ...
                  </span>
                );
              }

              const active = item === page;

              return (
                <button
                  key={item}
                  type="button"
                  onClick={() => onPageChange(item)}
                  className={cn(
                    "inline-flex h-[32px] min-w-[32px] items-center justify-center rounded-[10px] border px-[8px] text-[12px] font-extrabold transition",
                    active
                      ? "border-[#11120d] bg-[#11120d] text-white"
                      : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6]",
                  )}
                >
                  {item}
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => onPageChange(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages}
              className="inline-flex h-[32px] w-[32px] items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-white text-[#565449] transition hover:bg-[#F3F4F6]"
              aria-label="Next page"
            >
              <GoogleIcon name="chevron_right" className="text-inherit" />
            </button>

            <label className="ml-[4px] flex items-center gap-[8px] text-[12px] font-semibold text-[#8C8889]">
              Go
              <input
                type="number"
                min={1}
                max={totalPages}
                value={page}
                onChange={(event) => {
                  const nextPage = Number(event.target.value);
                  if (Number.isFinite(nextPage)) {
                    onPageChange(Math.min(totalPages, Math.max(1, nextPage)));
                  }
                }}
                className="h-[34px] w-[74px] rounded-[10px] border border-[#CFCFD3] bg-white px-[10px] text-center text-[12px] font-bold text-[#565449] outline-none"
                aria-label="Go to page"
              />
              <span>of {totalPages}</span>
            </label>
          </div>
        </div>
      </div>
      </Card>
      </div>
    </>
  );
}

