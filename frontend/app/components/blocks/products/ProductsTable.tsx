import React from "react";
import GoogleIcon from "~/components/ui/GIcon";
import PreviewableImage from "~/components/ui/PreviewableImage";
import ProjectSelect from "~/components/ui/ProjectSelect";
import MobilePaginationFooter from "~/components/ui/MobilePaginationFooter";
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

function ProductRowActionMenu({
  product,
  onView,
  onEdit,
  onDelete,
}: {
  product: Product;
  onView: (p: Product) => void;
  onEdit: (p: Product) => void;
  onDelete: (p: Product) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent | TouchEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("touchstart", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={menuRef} className="relative inline-block text-left">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((curr) => !curr);
        }}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`Actions for ${product.name}`}
        className={cn(
          "inline-flex h-9 w-9 items-center justify-center rounded-[10px] border transition active:scale-95",
          open
            ? "border-[#11120D] bg-[#11120D] text-white shadow-xs"
            : "border-[#D4D7DC] bg-white text-[#565449] hover:border-[#8C8889] hover:bg-[#F3F4F6]",
        )}
      >
        <GoogleIcon name="more_vert" className="text-[19px]" />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-[70] mt-1.5 w-44 origin-top-right rounded-[14px] border border-[#E2E8F0] bg-white p-1.5 shadow-xl animate-in fade-in zoom-in-95 duration-150"
        >
          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onView(product);
            }}
            className="flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-[12.5px] font-bold text-[#1E293B] transition hover:bg-[#F1F5F9] active:bg-[#E2E8F0]"
          >
            <GoogleIcon name="visibility" className="text-[17px] text-[#64748B]" />
            <span>View details</span>
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onEdit(product);
            }}
            className="flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-[12.5px] font-bold text-[#1E293B] transition hover:bg-[#F1F5F9] active:bg-[#E2E8F0]"
          >
            <GoogleIcon name="edit" className="text-[17px] text-[#64748B]" />
            <span>Edit product</span>
          </button>

          <div className="my-1 border-t border-[#F1F5F9]" />

          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onDelete(product);
            }}
            className="flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-[12.5px] font-bold text-[#BE123C] transition hover:bg-rose-50 active:bg-rose-100"
          >
            <GoogleIcon name="delete" className="text-[17px] text-[#BE123C]" />
            <span>{product.status === "Active" ? "Deactivate" : "Delete options"}</span>
          </button>
        </div>
      ) : null}
    </div>
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
  if (product.packageQuantity === null) return "Package unknown";
  return `${formatQty(product.packageQuantity)} ${product.packageUnit || "PIECE"}`;
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
  selectionModeActive,
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
  stockTracked,
  purchaseCostVisible,
}: {
  rows: Product[];
  loading?: boolean;
  loadError?: string;
  selected: Record<string, boolean>;
  selectionModeActive?: boolean;
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
  stockTracked: boolean;
  purchaseCostVisible: boolean;
}) {
  const paginationItems = buildPaginationItems(page, totalPages);
  const [mobileActionProduct, setMobileActionProduct] = React.useState<Product | null>(null);
  const longPressTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressedProductId = React.useRef<string | null>(null);
  const longPressOrigin = React.useRef<{ x: number; y: number } | null>(null);
  const lastSelectedIndex = React.useRef<number | null>(null);
  const selectAllRef = React.useRef<HTMLInputElement>(null);
  const selectionMode = selectionModeActive ?? Object.values(selected).some(Boolean);
  const selectedOnPageCount = rows.filter((product) => selected[product.id]).length;

  React.useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedOnPageCount > 0 && selectedOnPageCount < rows.length;
    }
  }, [rows.length, selectedOnPageCount]);

  function toggleDesktopRow(index: number, checked: boolean, shiftKey: boolean) {
    if (shiftKey && lastSelectedIndex.current !== null) {
      const start = Math.min(index, lastSelectedIndex.current);
      const end = Math.max(index, lastSelectedIndex.current);
      rows.slice(start, end + 1).forEach((product) => toggleOne(product.id, checked));
    } else {
      toggleOne(rows[index].id, checked);
    }
    lastSelectedIndex.current = index;
  }

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
          const flag = stockTracked ? getStockFlag(product) : null;
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
                "relative flex items-start gap-3 rounded-[14px] border bg-white p-3 transition active:scale-[0.995]",
                isSelected ? "border-[#11120D] bg-[#F3F4F6]" : "border-[#E5E7EB]",
              )}
            >
              {selectionMode ? (
                <button
                  type="button"
                  style={{ width: 18, height: 18, minWidth: 18, minHeight: 18 }}
                  onClick={(event) => { event.stopPropagation(); toggleOne(product.id, !isSelected); }}
                  className={cn(
                    "mt-1 inline-flex p-0 shrink-0 items-center justify-center rounded-[5px] border-[1.5px] transition active:scale-95",
                    isSelected ? "border-[#11120D] bg-[#11120D] text-white shadow-xs" : "border-[#CFCFD3] bg-white text-transparent hover:border-[#8C8889]",
                  )}
                  aria-label={`${isSelected ? "Deselect" : "Select"} ${product.name}`}
                >
                  <GoogleIcon name="check" className="text-[11px]" />
                </button>
              ) : null}

              <div className="flex flex-col items-center shrink-0 w-[72px]">
                <PreviewableImage
                  src={product.thumbnailUrl || product.imageUrl}
                  fallbackSrc={product.thumbnailUrl ? product.imageUrl : undefined}
                  previewSrc={product.imageUrl}
                  alt={product.name}
                  title={product.name}
                  subtitle={`SKU: ${product.sku}`}
                  enablePreview="desktop"
                  imgClassName="h-full w-full object-contain p-1"
                  className="flex h-[68px] w-[68px] shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-[#E5E7EB] bg-[#F8FAFC]"
                  fallback={<GoogleIcon name="inventory_2" sizePx={26} className="text-[#8C8889]" />}
                />
                <div className="mt-1 text-center text-[9.5px] font-bold text-[#64748B] leading-tight">
                  Sale unit: <span className="uppercase text-[#11120D] font-extrabold">{product.saleUnit || "PIECE"}</span>
                </div>
              </div>

              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 text-[17px] font-black leading-snug text-[#000000]">{product.name}</div>
                <div className="mt-0.5 truncate text-[11.5px] font-semibold text-[#64748B]">{product.brand || "Unbranded"}</div>

                <div className="mt-1.5 h-[42px] flex flex-col justify-between overflow-hidden">
                  {purchaseCostVisible ? (
                    <div className="space-y-0.5 text-[#000000]">
                      <div className="flex flex-wrap items-center gap-x-2 text-[15.5px] font-black leading-tight">
                        <span className="inline-flex items-baseline gap-1">
                          <span className="text-[10.5px] font-bold text-[#64748B]">Purchase:</span>
                          <span className="text-[15px] font-black text-[#000000]">
                            {product.ratePerPiece === null ? (
                              "—"
                            ) : (
                              <>
                                <span className="text-[11px] font-bold text-[#64748B] mr-0.5">रु.</span>
                                <span>{Number(product.ratePerPiece).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                              </>
                            )}
                          </span>
                        </span>
                        <span className="text-[#CBD5E1]">|</span>
                        <span className="inline-flex items-baseline gap-1">
                          <span className="text-[10.5px] font-bold text-[#64748B]">Retail:</span>
                          <span className="text-[15px] font-black text-[#000000]">
                            {product.retailPrice !== null ? (
                              <>
                                <span className="text-[11px] font-bold text-[#64748B] mr-0.5">रु.</span>
                                <span>{Number(product.retailPrice).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                              </>
                            ) : (
                              "—"
                            )}
                          </span>
                        </span>
                      </div>
                      <div className="text-[10.5px] font-bold text-[#64748B] leading-tight">
                        {product.wholesaleEligible ? (
                          <span className="inline-flex items-baseline gap-1">
                            <span>Wholesale:</span>
                            <span className="text-[14px] font-black text-[#11120D]">
                              {product.wholesalePrice !== null ? (
                                <>
                                  <span className="text-[10.5px] font-bold text-[#64748B] mr-0.5">रु.</span>
                                  <span>{Number(product.wholesalePrice).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                                </>
                              ) : (
                                "—"
                              )}
                            </span>
                          </span>
                        ) : (
                          <span className="font-semibold text-[#8C8889]">Standard retail pricing</span>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-0.5">
                      <div className="h-[20px] flex items-center">
                        {product.availabilityStatus === "COMING_SOON" ? (
                          <div className="text-[12.5px] font-semibold italic text-rose-500 leading-none">
                            Price coming soon
                          </div>
                        ) : product.retailPrice === null ? (
                          <div className="text-[12.5px] font-semibold italic text-rose-500 leading-none">
                            Retail price pending
                          </div>
                        ) : (
                          <div className="text-[16px] font-black leading-none text-[#000000]">
                            <span className="text-[12px] font-bold text-[#64748B] mr-0.5">रु.</span>
                            <span>{Number(product.retailPrice).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                          </div>
                        )}
                      </div>
                      <div className="h-[18px] flex items-center text-[10.5px] font-bold text-[#64748B]">
                        {product.wholesaleEligible && product.wholesalePrice !== null ? (
                          <div className="inline-flex items-baseline gap-1">
                            <span>Wholesale:</span>
                            <span className="text-[14px] font-black text-[#11120D]">
                              <span className="text-[10.5px] font-bold text-[#64748B] mr-0.5">रु.</span>
                              <span>{Number(product.wholesalePrice).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                            </span>
                          </div>
                        ) : (
                          <span className="font-semibold text-[#8C8889]">Standard retail pricing</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {stockTracked ? (
                  <div className="mt-1 flex items-center gap-1.5 text-[11px] font-semibold text-[#565449]">
                    <span className={cn("h-2 w-2 rounded-full", flag === "In Stock" ? "bg-emerald-500" : flag === "Low Stock" ? "bg-amber-500" : "bg-red-500")} />
                    {formatQty(product.stock)} {product.saleUnit || "PIECE"}
                  </div>
                ) : null}
              </div>

              <div className="flex flex-col items-end justify-between shrink-0 self-stretch pl-1">
                {!selectionMode ? (
                  <button
                    type="button"
                    onClick={(event) => { event.stopPropagation(); setMobileActionProduct(product); }}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-full text-[#565449] transition hover:bg-[#F3F4F6]"
                    aria-label={`Actions for ${product.name}`}
                  >
                    <GoogleIcon name="more_vert" className="text-[20px]" />
                  </button>
                ) : (
                  <div className="h-11 w-11" />
                )}

                <div className="flex flex-col items-end gap-1 pb-0.5">
                  <AvailabilityPill product={product} />
                  <StatusPill status={product.status} />
                </div>
              </div>
            </article>
          );
        })}

        {rows.length > 0 ? (
          <MobilePaginationFooter page={page} totalPages={totalPages} total={total} start={start} end={end} label="products" pageSize={pageSize} pageSizeOptions={[20, 50, 100]} onPageChange={onPageChange} onPageSizeChange={onPageSizeChange} />
        ) : null}
      </section>

      {mobileActionProduct ? (
        <div className="fixed inset-0 z-[130] lg:hidden">
          <button type="button" className="absolute inset-0 bg-slate-950/50" onClick={() => setMobileActionProduct(null)} aria-label="Close product actions" />
          <section role="dialog" aria-modal="true" aria-label={`${mobileActionProduct.name} actions`} className="absolute inset-x-0 bottom-0 rounded-t-[26px] bg-white px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-3 shadow-2xl">
            <div className="mx-auto h-1.5 w-14 rounded-full bg-[#CFCFD3]" />
            <div className="mt-4 flex items-center gap-3 border-b border-[#E5E7EB] pb-4">
              <PreviewableImage src={mobileActionProduct.thumbnailUrl || mobileActionProduct.imageUrl} fallbackSrc={mobileActionProduct.thumbnailUrl ? mobileActionProduct.imageUrl : undefined} previewSrc={mobileActionProduct.imageUrl} alt={mobileActionProduct.name} title={mobileActionProduct.name} enablePreview="desktop" imgClassName="h-full w-full object-contain p-1" className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-[12px] border border-[#E5E7EB] bg-white" fallback={<GoogleIcon name="inventory_2" className="text-[#8C8889]" />} />
              <div className="min-w-0 flex-1"><div className="truncate text-[17px] font-extrabold">{mobileActionProduct.name}</div><div className="mt-1 truncate font-mono text-[12px] text-[#6B7280]">SKU: {mobileActionProduct.sku}</div></div>
              <button type="button" onClick={() => setMobileActionProduct(null)} className="flex h-11 w-11 items-center justify-center rounded-full transition active:bg-[#F3F4F6]" aria-label="Close actions"><GoogleIcon name="close" className="text-[25px]" /></button>
            </div>
            <div className="mt-2 space-y-1">
              {[
                { icon: "visibility", label: "View details", action: () => onView(mobileActionProduct) },
                { icon: "edit", label: "Edit product", action: () => onEdit(mobileActionProduct) },
                { icon: "do_not_disturb_on", label: mobileActionProduct.status === "Active" ? "Deactivate product" : "Product options", action: () => onDelete(mobileActionProduct), danger: true },
              ].map((item) => (
                <button key={item.label} type="button" onClick={() => { setMobileActionProduct(null); item.action(); }} className={cn("flex min-h-[56px] w-full items-center gap-3.5 rounded-[14px] px-2 text-left transition active:scale-[0.98] active:bg-[#F3F4F6]", item.danger ? "text-[#BE123C]" : "text-[#11120d]")}><span className={cn("inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px]", item.danger ? "bg-rose-50 text-[#BE123C]" : "bg-[#F3F4F6] text-[#565449]")}><GoogleIcon name={item.icon} className="text-[20px]" /></span><span className="flex-1 text-[15px] font-bold">{item.label}</span><GoogleIcon name="chevron_right" className="text-[#94A3B8]" /></button>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      <div className="hidden lg:block">
        <Card>
          <div>
            <div className="overflow-x-auto">
              <table
                className={cn(
                  "w-full border-collapse text-left",
                  stockTracked ? "min-w-[1230px]" : "min-w-[1120px]",
                )}
              >
                <thead>
                  <tr className="border-b border-[#DADDE3] bg-[#F8FAFC] text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                    <th className="w-[52px] p-0">
                      <label className="flex min-h-[48px] cursor-pointer items-center justify-center" title="Select every product on this page">
                        <input
                          ref={selectAllRef}
                          type="checkbox"
                          checked={rows.length > 0 && rows.every((product) => selected[product.id])}
                          onChange={(event) => toggleAllOnPage(event.target.checked)}
                          aria-label="Select all rows on this page"
                          className="h-5 w-5 cursor-pointer accent-[#11120D]"
                        />
                      </label>
                    </th>
                    <th className="px-3 py-3">Product</th>
                    <th className="px-3 py-3">Source</th>
                    <th className="px-3 py-3">Group / Variant</th>
                    <th className="px-3 py-3">Size</th>
                    <th className="px-3 py-3">Package</th>
                    <th className="px-3 py-3">खरिद / Cost</th>
                    <th className="px-3 py-3">Retail / खुद्रा</th>
                    <th className="px-3 py-3">Wholesale / थोक</th>
                    {stockTracked ? <th className="px-3 py-3">Stock</th> : null}
                    <th className="px-3 py-3">Status</th>
                    <th className="w-[80px] px-3 py-3 text-right">Action</th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-[#E5E7EB]">
                  {rows.map((product, productIndex) => {
                    const flag = stockTracked ? getStockFlag(product) : null;
                    const isSelected = !!selected[product.id];

                    return (
                      <tr
                        key={product.id}
                        className={cn(
                          "text-[13px] transition-colors hover:bg-[#ECEFF3]",
                          isSelected && "bg-[#F3F4F6]/80 hover:bg-[#E4E8EE]",
                        )}
                      >
                        <td className="w-[52px] p-0 align-top">
                          <label className="flex min-h-[72px] cursor-pointer items-start justify-center pt-4" title={`Select ${product.name}`}>
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={(event) =>
                                toggleDesktopRow(
                                  productIndex,
                                  event.target.checked,
                                  (event.nativeEvent as MouseEvent).shiftKey,
                                )
                              }
                              aria-label={`Select ${product.name}`}
                              className="h-5 w-5 cursor-pointer accent-[#11120D]"
                            />
                          </label>
                        </td>

                        <td className="px-3 py-3 align-top">
                          <div className="flex items-center gap-[12px]">
                            <PreviewableImage
                              src={product.thumbnailUrl || product.imageUrl}
                              fallbackSrc={product.thumbnailUrl ? product.imageUrl : undefined}
                              previewSrc={product.imageUrl}
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
                              <div className="mt-0.5 truncate text-[11px] font-semibold text-[#8C8889]">
                                {product.brand || "Unbranded"}
                              </div>
                            </div>
                          </div>
                        </td>

                        <td className="px-3 py-3 align-top">
                          <div className="text-[11.5px] font-bold uppercase tracking-tight text-[#1E293B]">
                            {product.vendorSource || product.brand}
                          </div>
                          <div className="mt-0.5 text-[10px] font-medium text-[#64748B]">
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
                          {!purchaseCostVisible ? (
                            <span className="font-mono text-[13px] tracking-widest text-[#94A3B8]">••••</span>
                          ) : product.ratePerPiece === null ? (
                            product.availabilityStatus === "COMING_SOON" ? "Coming soon" : "Not entered"
                          ) : (
                            formatNpr(product.ratePerPiece)
                          )}
                        </td>
                        <td className="px-3 py-3 align-top font-semibold text-[#000000]">
                          {product.availabilityStatus === "COMING_SOON"
                            ? "Coming soon"
                            : product.retailPrice === null
                              ? "Not entered"
                              : formatNpr(product.retailPrice)}
                        </td>
                        <td className="px-3 py-3 align-top text-[#565449]">
                          <div className="font-semibold text-[#000000]">
                            {product.wholesaleEligible
                              ? product.wholesalePrice === null
                                ? "Not entered"
                                : formatNpr(product.wholesalePrice)
                              : "Qty pricing off"}
                          </div>
                          <div className="mt-[4px] text-[11px] text-[#8C8889]">
                            Qty threshold {formatQty(product.thresholdQty)}
                          </div>
                        </td>

                        {stockTracked ? <td className="px-3 py-3 align-top">
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
                            <StockPill flag={flag!} />
                          </div>
                        </td> : null}

                        <td className="px-3 py-3 align-top">
                          <div className="flex flex-wrap gap-1.5">
                            <AvailabilityPill product={product} />
                            <StatusPill status={product.status} />
                          </div>
                        </td>

                        <td className="px-3 py-3 align-top">
                          <div className="flex items-center justify-end">
                            <ProductRowActionMenu
                              product={product}
                              onView={onView}
                              onEdit={onEdit}
                              onDelete={onDelete}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}

                  {rows.length === 0 && loading ? (
                    <tr>
                      <td colSpan={stockTracked ? 12 : 11} className="px-[14px] py-[22px] text-[14px] font-semibold text-[#565449]">
                        <div className="flex items-center gap-2">
                          <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#CFCFD3] border-t-[#11120d]" />
                          Loading products...
                        </div>
                      </td>
                    </tr>
                  ) : null}

                  {rows.length === 0 && !loading ? (
                    <tr>
                      <td colSpan={(stockTracked ? 11 : 10) + (purchaseCostVisible ? 1 : 0)} className="px-[14px] py-[22px] text-[14px] text-[#8C8889]">
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

function AvailabilityPill({ product }: { product: Product }) {
  if (product.availabilityStatus !== "COMING_SOON") return null;
  return (
    <span className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[11px] font-bold text-sky-800">
      Price coming soon
    </span>
  );
}
