import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import Icon from "~/components/ui/Icon";
import ProjectSelect from "~/components/ui/ProjectSelect";
import {
  ActiveFilterChips,
  MobileFilterButton,
  MobileFilterSheet,
  type MobileFilterChip,
} from "~/components/ui/MobileFilters";
import { ConfirmDialog, SuccessDialog } from "~/components/ui/Modal";
import PaginationBar from "~/components/ui/PaginationBar";
import ProductImage from "~/components/ui/ProductImage";
import { resolveMediaUrl, useResilientImage } from "~/hooks/useResilientImage";
import CreatableCombobox from "~/components/ui/CreatableCombobox";
import { useToast } from "~/components/ui/Toast";
import {
  createDraftRequestApi,
  listCashierPresenceApi,
  listCustomersApi,
  recordProductSearchSelectionApi,
  type ProductSearchSelectionAction,
  type CashierPresence,
} from "~/lib/api/endpoints";
import { getAuthUser } from "~/lib/auth";
import { isRateLimitError } from "~/lib/api/client";
import { useRateLimitRecovery } from "~/lib/api/useRateLimitRecovery";
import {
  fetchPriceLookupProducts,
  fetchProductsMeta,
} from "~/lib/domain/products/products.api";
import type {
  Product,
  ProductLookupEditHandoff,
} from "~/lib/domain/products/products.types";
import {
  readProductLookupRestore,
  stageProductLookupEdit,
} from "~/lib/domain/products/productLookupHandoff";
import { formatNpr } from "~/lib/invoices";
import { useBusinessCapabilities } from "~/lib/businessCapabilities";

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function formatQty(value: number) {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function formatPriceNumber(value: number) {
  const normalized =
    Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
  return normalized.toLocaleString(undefined, {
    minimumFractionDigits: normalized % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function CompactPrice({
  value,
  tone = "default",
  compact = false,
}: {
  value: number;
  tone?: "default" | "retail";
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "mt-1 flex min-w-0 items-baseline gap-1 whitespace-nowrap",
        tone === "retail" ? "text-emerald-950" : "text-[#11120d]",
      )}
      title={formatNpr(value)}
    >
      <span className="shrink-0 text-[13px] font-black leading-none tracking-tight min-[400px]:text-[14px]">
        रु.
      </span>
      <span
        className={cn(
          "min-w-0 font-mono font-black tabular-nums tracking-[-0.035em]",
          compact
            ? "text-[15px] leading-5 min-[400px]:text-[17px]"
            : "text-[16px] leading-5 min-[400px]:text-[18px]",
        )}
      >
        {formatPriceNumber(value)}
      </span>
    </div>
  );
}

function formatSize(product: Product) {
  if (!product.sizeValue || product.sizeUnit === "STANDARD") return "Standard";
  return `${formatQty(product.sizeValue)} ${product.sizeUnit}`;
}

function formatPackage(product: Product) {
  return `${formatQty(product.packageQuantity || 1)} ${product.packageUnit || "PIECE"}`;
}

function stockLabel(product: Product) {
  if (product.stock <= 0) return "Out of stock";
  if (product.stock <= product.lowStockThreshold) return "Low stock";
  return "In stock";
}

function stockTone(product: Product) {
  if (product.stock <= 0) return "border-rose-200 bg-rose-50 text-rose-700";
  if (product.stock <= product.lowStockThreshold) {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  return "border-emerald-200 bg-emerald-50 text-emerald-700";
}

function stockDot(product: Product) {
  if (product.stock <= 0) return "bg-rose-500";
  if (product.stock <= product.lowStockThreshold) return "bg-amber-500";
  return "bg-emerald-500";
}

function cashierAvailable(cashier: CashierPresence) {
  return cashier.isPresent && cashier.hasOpenDrawer;
}

function cashierAvailabilityRank(cashier: CashierPresence) {
  if (cashierAvailable(cashier)) return 0;
  if (cashier.isPresent) return 1;
  return 2;
}

function relativeLastActive(value?: string | null) {
  if (!value) return "Last active time unavailable";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Last active time unavailable";
  const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return `Last active ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last active ${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `Last active ${days} day${days === 1 ? "" : "s"} ago`;
}

function apiError(error: any, fallback: string) {
  return error?.response?.data?.error || error?.message || fallback;
}

function resolvePreviewImageUrl(src?: string | null) {
  return resolveMediaUrl(src);
}

function normalizeLabel(value?: string | null) {
  return String(value || "").trim();
}

function sameLabel(a?: string | null, b?: string | null) {
  const left = normalizeLabel(a).toLowerCase();
  const right = normalizeLabel(b).toLowerCase();
  return Boolean(left && right && left === right);
}

function getCategoryBrandDisplay(product: Product) {
  const brand = normalizeLabel(product.brand);
  const category = normalizeLabel(product.category);
  const source = normalizeLabel(product.vendorSource);
  const primary = category || brand || "Uncategorized";
  const lines: string[] = [];

  if (brand && !sameLabel(brand, primary)) lines.push(brand);
  if (
    source &&
    !sameLabel(source, primary) &&
    !lines.some((line) => sameLabel(line, source))
  ) {
    lines.push(source);
  }

  return { primary, lines };
}

type DraftCartItem = {
  product: Product;
  qty: number;
  note: string;
};

type StoredStaffDraft = {
  version: 1;
  items: DraftCartItem[];
  selectedCashierId: string;
  selectedCustomerId: string;
  customerName: string;
  customerPhone: string;
  notes: string;
  savedAt: string;
};

const STAFF_DRAFT_STORAGE_PREFIX = "khatasathi:staff-draft-request";

function staffDraftStorageKey(userId: string) {
  return `${STAFF_DRAFT_STORAGE_PREFIX}:${userId}`;
}

function readStoredStaffDraft(userId: string): StoredStaffDraft | null {
  if (typeof window === "undefined" || !userId) return null;
  try {
    const raw = window.localStorage.getItem(staffDraftStorageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredStaffDraft>;
    const items = Array.isArray(parsed.items)
      ? parsed.items
          .map((item) => ({
            product: item?.product as Product,
            qty: Number(item?.qty || 0),
            note: String(item?.note || ""),
          }))
          .filter(
            (item) =>
              item.product &&
              typeof item.product.id === "string" &&
              typeof item.product.name === "string" &&
              Number.isFinite(item.qty) &&
              item.qty > 0,
          )
      : [];
    if (items.length === 0) {
      window.localStorage.removeItem(staffDraftStorageKey(userId));
      return null;
    }
    return {
      version: 1,
      items,
      selectedCashierId: String(parsed.selectedCashierId || ""),
      selectedCustomerId: String(parsed.selectedCustomerId || ""),
      customerName: String(parsed.customerName || ""),
      customerPhone: String(parsed.customerPhone || ""),
      notes: String(parsed.notes || ""),
      savedAt: String(parsed.savedAt || ""),
    };
  } catch {
    window.localStorage.removeItem(staffDraftStorageKey(userId));
    return null;
  }
}

function writeStoredStaffDraft(
  userId: string,
  draft: Omit<StoredStaffDraft, "version" | "savedAt">,
) {
  if (typeof window === "undefined" || !userId) return;
  const key = staffDraftStorageKey(userId);
  if (draft.items.length === 0) {
    window.localStorage.removeItem(key);
    return;
  }
  try {
    window.localStorage.setItem(
      key,
      JSON.stringify({
        ...draft,
        version: 1,
        savedAt: new Date().toISOString(),
      } satisfies StoredStaffDraft),
    );
  } catch {
    // A storage quota or privacy-mode failure must not interrupt the request.
  }
}

type LookupCustomer = {
  id: string;
  name: string;
  phone?: string | null;
};

function ProductBadges({ product }: { product: Product }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-extrabold",
          stockTone(product),
        )}
      >
        <span className={cn("h-1.5 w-1.5 rounded-full", stockDot(product))} />
        {stockLabel(product)} · {formatQty(product.stock)}{" "}
        {product.saleUnit || "PIECE"}
      </span>
      <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-extrabold text-slate-600">
        SKU {product.sku}
      </span>
      {product.barcode ? (
        <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-extrabold text-slate-500">
          BC {product.barcode}
        </span>
      ) : null}
      {Number(product.draftRequestedQty || 0) > 0 ? (
        <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-extrabold text-amber-700">
          {formatQty(Number(product.draftRequestedQty || 0))} already requested
        </span>
      ) : null}
    </div>
  );
}

type QtyControlProps = {
  product: Product;
  qty: number;
  onChange: (qty: number) => void;
  compact?: boolean;
};

function QtyControl({ product, qty, onChange, compact }: QtyControlProps) {
  const step = Math.max(0.001, Number(product.quantityStep || 1));
  const max = Math.max(0, Number(product.stock || 0));
  const disabled = max <= 0;

  function setNext(value: number) {
    if (!Number.isFinite(value)) return;
    const rounded = Math.round(Math.max(0, Math.min(max, value)) * 1000) / 1000;
    onChange(rounded);
  }

  return (
    <div
      className={cn(
        "inline-flex overflow-hidden rounded-[12px] border border-slate-300 bg-white",
        compact ? "h-[36px]" : "h-[40px]",
        disabled && "opacity-50",
      )}
    >
      <button
        type="button"
        disabled={disabled || qty <= 0}
        onClick={() => setNext(qty - step)}
        className="flex w-10 items-center justify-center border-r border-slate-200 text-slate-700 transition hover:bg-slate-50 disabled:text-slate-300"
        aria-label={`Decrease ${product.name}`}
      >
        <Icon name="remove" sizePx={18} />
      </button>
      <input
        value={qty ? formatQty(qty) : ""}
        disabled={disabled}
        inputMode="decimal"
        onChange={(event) => setNext(Number(event.target.value || 0))}
        className={cn(
          "w-[58px] border-0 bg-white text-center font-mono text-[14px] font-extrabold outline-none",
          compact && "w-[48px] text-[13px]",
        )}
        aria-label={`${product.name} draft quantity`}
      />
      <button
        type="button"
        disabled={disabled || qty >= max}
        onClick={() => setNext(qty + step)}
        className="flex w-10 items-center justify-center border-l border-slate-200 text-slate-700 transition hover:bg-slate-50 disabled:text-slate-300"
        aria-label={`Increase ${product.name}`}
      >
        <Icon name="add" sizePx={18} />
      </button>
    </div>
  );
}

type ProductActionProps = {
  product: Product;
  draftQty: number;
  onQtyChange: (product: Product, qty: number) => void;
};

function ProductAction({ product, draftQty, onQtyChange }: ProductActionProps) {
  return (
    <QtyControl
      product={product}
      qty={draftQty}
      onChange={(qty) => onQtyChange(product, qty)}
      compact
    />
  );
}

type ProductPreviewThumbProps = {
  product: Product;
  className: string;
  iconClassName?: string;
  onOpen: (product: Product, trigger: HTMLButtonElement) => void;
};

function ProductPreviewThumb({
  product,
  className,
  iconClassName = "text-slate-400",
  onOpen,
}: ProductPreviewThumbProps) {
  const image = useResilientImage(product.imageUrl);

  if (!product.imageUrl) {
    return (
      <ProductImage
        src={product.imageUrl}
        alt={product.name}
        className={className}
        iconClassName={iconClassName}
      />
    );
  }

  return (
    <button
      type="button"
      disabled={!image.ready}
      onClick={(event) => onOpen(product, event.currentTarget)}
      className={cn(
        "group relative outline-none transition focus-visible:ring-4 focus-visible:ring-slate-200",
        image.ready ? "cursor-zoom-in" : "cursor-default",
        className,
      )}
      title={`Preview image for ${product.name}`}
      aria-label={`Preview image for ${product.name}`}
    >
      {!image.ready ? (
        <span className="absolute inset-0 flex items-center justify-center bg-slate-50">
          <Icon name="inventory_2" sizePx={24} className={iconClassName} />
        </span>
      ) : null}
      <img
        src={image.requestUrl}
        alt={product.name}
        loading="lazy"
        decoding="async"
        onLoad={image.markLoaded}
        onError={image.markFailed}
        className={cn(
          "h-full w-full bg-white object-contain p-0.5 transition-opacity",
          image.ready ? "opacity-100" : "opacity-0",
        )}
      />
      {image.ready ? (
        <>
          <span className="pointer-events-none absolute inset-0 rounded-[inherit] bg-slate-950/0 transition group-hover:bg-slate-950/10 group-focus-visible:bg-slate-950/10" />
          <span className="pointer-events-none absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-white/70 bg-slate-950/75 text-white opacity-90 shadow-sm transition md:opacity-0 md:group-hover:opacity-100 md:group-focus-visible:opacity-100">
            <Icon name="open_in_full" sizePx={14} />
          </span>
        </>
      ) : null}
    </button>
  );
}

function ProductImagePreviewModal({
  product,
  onClose,
}: {
  product: Product | null;
  onClose: () => void;
}) {
  if (!product?.imageUrl) return null;

  const imageUrl = resolvePreviewImageUrl(product.imageUrl);

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/55 p-3 backdrop-blur-[2px] sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="product-image-preview-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-[980px] flex-col overflow-hidden rounded-[22px] border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <div
              id="product-image-preview-title"
              className="truncate text-[18px] font-black text-slate-950 sm:text-[20px]"
            >
              {product.name}
            </div>
            <div className="mt-1 truncate text-[12px] font-bold text-slate-500">
              SKU: {product.sku}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <a
              href={imageUrl}
              target="_blank"
              rel="noreferrer"
              className="hidden h-[42px] items-center justify-center gap-2 rounded-[13px] border border-slate-300 bg-white px-3 text-[12px] font-black text-slate-700 transition hover:bg-[#ECEFF3] sm:flex"
            >
              <Icon name="open_in_new" sizePx={17} />
              Open full size
            </a>
            <button
              type="button"
              onClick={onClose}
              className="flex h-[42px] w-[42px] items-center justify-center rounded-[14px] border border-slate-300 bg-white text-slate-600 transition hover:bg-[#ECEFF3]"
              aria-label="Close image preview"
            >
              <Icon name="close" sizePx={24} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 bg-slate-50 p-3 sm:p-5">
          <div className="flex h-full min-h-[360px] max-h-[70vh] items-center justify-center overflow-hidden rounded-[18px] border border-slate-200 bg-white">
            <ProductImage
              src={product.imageUrl}
              alt={product.name}
              loading="eager"
              showRetryOnFailure
              className="flex h-full w-full items-center justify-center"
              imgClassName="max-h-full max-w-full object-contain"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

type DraftPanelProps = {
  items: DraftCartItem[];
  cashiers: CashierPresence[];
  customers: LookupCustomer[];
  selectedCashierId: string;
  selectedCustomerId: string;
  customerName: string;
  customerPhone: string;
  notes: string;
  sending: boolean;
  cashiersLoading: boolean;
  cashierLoadIssue: string;
  onSelectCashier: (id: string) => void;
  onSelectCustomer: (customer: LookupCustomer | null) => void;
  onCustomerName: (value: string) => void;
  onCustomerPhone: (value: string) => void;
  onNotes: (value: string) => void;
  onRemoveItem: (productId: string) => void;
  onQtyChange: (product: Product, qty: number) => void;
  onOpenConfirm: () => void;
};

function DraftPanel({
  items,
  cashiers,
  customers,
  selectedCashierId,
  selectedCustomerId,
  customerName,
  customerPhone,
  notes,
  sending,
  cashiersLoading,
  cashierLoadIssue,
  onSelectCashier,
  onSelectCustomer,
  onCustomerName,
  onCustomerPhone,
  onNotes,
  onRemoveItem,
  onQtyChange,
  onOpenConfirm,
}: DraftPanelProps) {
  const [customerOpen, setCustomerOpen] = useState(false);
  const itemCount = items.length;
  const totalQty = items.reduce((sum, item) => sum + item.qty, 0);
  const estimate = items.reduce(
    (sum, item) => sum + item.qty * item.product.retailPrice,
    0,
  );
  const selectedCashier = cashiers.find(
    (cashier) => cashier.id === selectedCashierId,
  );
  const canSend = itemCount > 0 && Boolean(selectedCashier?.isActive);
  const customerQuery = customerName.trim().toLowerCase();
  const matchingCustomers = customers
    .filter((customer) => {
      if (!customerQuery) return true;
      return (
        customer.name.toLowerCase().includes(customerQuery) ||
        String(customer.phone || "")
          .toLowerCase()
          .includes(customerQuery)
      );
    })
    .slice(0, 6);

  return (
    <aside className="rounded-[20px] border border-slate-200 bg-white shadow-sm lg:sticky lg:top-4 lg:max-h-[calc(100vh-110px)] lg:overflow-auto">
      <div className="border-b border-slate-200 px-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[18px] font-black text-slate-950">
              Draft request
            </div>
            <div className="mt-1 text-[12px] font-bold text-slate-500">
              {itemCount} item(s) · {formatQty(totalQty)} unit(s)
            </div>
          </div>
          <div className="rounded-[14px] bg-slate-950 px-3 py-2 text-right text-white">
            <div className="text-[10px] font-black uppercase text-slate-300">
              Estimate
            </div>
            <div className="font-mono text-[14px] font-black">
              {formatNpr(estimate)}
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-4">
        <section>
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[12px] font-black uppercase tracking-wide text-slate-500">
              Cashier
            </div>
            <span className="text-[11px] font-bold text-slate-400">
              Choose one
            </span>
          </div>
          <div className="space-y-2">
            <ProjectSelect
              value={selectedCashierId}
              onChange={(event) => onSelectCashier(event.target.value)}
              disabled={cashiers.length === 0}
              aria-label="Choose cashier for this request"
            >
              <option value="">
                {cashiersLoading
                  ? "Loading cashiers..."
                  : cashiers.length === 0
                    ? "No active cashiers"
                    : "Choose cashier"}
              </option>
              {cashiers.map((cashier) => {
                const availability = cashierAvailable(cashier)
                  ? "Ready now"
                  : cashier.isPresent
                    ? "Online"
                    : "Offline";
                return (
                  <option key={cashier.id} value={cashier.id}>
                    {cashier.name} — {availability} ·{" "}
                    {cashier.pendingDraftRequestCount} pending
                  </option>
                );
              })}
            </ProjectSelect>

            {cashierLoadIssue ? (
              <div className="rounded-[12px] border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-800">
                {cashierLoadIssue}. Try refreshing before sending.
              </div>
            ) : selectedCashier ? (
              <div className="rounded-[14px] border border-slate-200 bg-slate-50 px-3 py-2.5">
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-black text-slate-900">
                      {selectedCashier.name}
                    </div>
                    <div className="mt-1 truncate text-[11px] font-bold text-slate-500">
                      {cashierAvailable(selectedCashier)
                        ? "Online · cash session open"
                        : selectedCashier.isPresent
                          ? "Online · cash session not open"
                          : relativeLastActive(selectedCashier.lastPresenceAt)}
                    </div>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-full border px-2 py-1 text-[10px] font-black uppercase",
                      cashierAvailable(selectedCashier)
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : selectedCashier.isPresent
                          ? "border-sky-200 bg-sky-50 text-sky-700"
                          : "border-slate-200 bg-white text-slate-600",
                    )}
                  >
                    {cashierAvailable(selectedCashier)
                      ? "Ready now"
                      : selectedCashier.isPresent
                        ? "Online"
                        : "Offline"}
                  </span>
                </div>
                <div className="mt-2 text-[11px] font-bold text-slate-500">
                  {selectedCashier.pendingDraftRequestCount} pending request(s)
                </div>
              </div>
            ) : cashiers.length === 0 && !cashiersLoading ? (
              <div className="rounded-[12px] border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-[12px] font-bold text-slate-500">
                No active cashier accounts found.
              </div>
            ) : null}
          </div>
        </section>

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <label className="relative block">
            <span className="text-[12px] font-black uppercase tracking-wide text-slate-500">
              Customer
            </span>
            <input
              value={customerName}
              onFocus={() => setCustomerOpen(true)}
              onBlur={() =>
                window.setTimeout(() => setCustomerOpen(false), 120)
              }
              onChange={(event) => {
                onSelectCustomer(null);
                onCustomerName(event.target.value);
                setCustomerOpen(true);
              }}
              placeholder="Walk-in customer"
              className="mt-1 h-[42px] w-full rounded-[12px] border border-slate-300 bg-white px-3 text-[14px] font-bold outline-none focus:border-slate-950"
            />
            {selectedCustomerId ? (
              <div className="mt-1 text-[11px] font-extrabold text-emerald-700">
                Existing customer selected
              </div>
            ) : customerName.trim() ? (
              <div className="mt-1 text-[11px] font-extrabold text-slate-500">
                Typed customer for this request only
              </div>
            ) : null}
            {customerOpen ? (
              <div className="absolute left-0 right-0 top-[68px] z-30 overflow-hidden rounded-[14px] border border-slate-200 bg-white shadow-xl">
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onSelectCustomer(null);
                    onCustomerName("");
                    onCustomerPhone("");
                    setCustomerOpen(false);
                  }}
                  className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left hover:bg-slate-50"
                >
                  <span className="text-[13px] font-black text-slate-950">
                    Walk-in customer
                  </span>
                  <span className="text-[11px] font-bold text-slate-400">
                    Default
                  </span>
                </button>
                {matchingCustomers.map((customer) => (
                  <button
                    key={customer.id}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      onSelectCustomer(customer);
                      setCustomerOpen(false);
                    }}
                    className="flex w-full items-center justify-between gap-3 border-t border-slate-100 px-3 py-3 text-left hover:bg-slate-50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-black text-slate-950">
                        {customer.name}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] font-bold text-slate-500">
                        {customer.phone || "No phone"}
                      </span>
                    </span>
                    <span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-black uppercase text-emerald-700">
                      Existing
                    </span>
                  </button>
                ))}
                {customerName.trim() ? (
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setCustomerOpen(false)}
                    className="flex w-full items-center justify-between gap-3 border-t border-slate-100 px-3 py-3 text-left hover:bg-slate-50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-black text-slate-950">
                        Use "{customerName.trim()}"
                      </span>
                      <span className="mt-0.5 block text-[11px] font-bold text-slate-500">
                        Temporary request name
                      </span>
                    </span>
                    <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-black uppercase text-slate-600">
                      Typed
                    </span>
                  </button>
                ) : null}
              </div>
            ) : null}
          </label>
          <label className="block">
            <span className="text-[12px] font-black uppercase tracking-wide text-slate-500">
              Phone
            </span>
            <input
              value={customerPhone}
              onChange={(event) => onCustomerPhone(event.target.value)}
              placeholder="Optional"
              className="mt-1 h-[42px] w-full rounded-[12px] border border-slate-300 bg-white px-3 text-[14px] font-bold outline-none focus:border-slate-950"
            />
          </label>
        </section>

        <section>
          <div className="mb-2 text-[12px] font-black uppercase tracking-wide text-slate-500">
            Items
          </div>
          {items.length === 0 ? (
            <div className="rounded-[16px] border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center">
              <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-[14px] bg-white text-slate-400">
                <Icon name="playlist_add" sizePx={24} />
              </div>
              <div className="mt-3 text-[13px] font-black text-slate-700">
                Add products from lookup
              </div>
              <div className="mt-1 text-[12px] font-bold text-slate-400">
                Quantities appear here before sending.
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {items.map((item) => (
                <div
                  key={item.product.id}
                  className="rounded-[14px] border border-slate-200 bg-slate-50 p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-black text-slate-950">
                        {item.product.name}
                      </div>
                      <div className="mt-1 text-[11px] font-bold text-slate-500">
                        {item.product.sku} ·{" "}
                        {formatNpr(item.product.retailPrice)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemoveItem(item.product.id)}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-rose-200 bg-rose-50 text-rose-600 transition hover:bg-rose-100"
                      aria-label={`Remove ${item.product.name}`}
                    >
                      <Icon name="delete" sizePx={18} />
                    </button>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <QtyControl
                      product={item.product}
                      qty={item.qty}
                      onChange={(qty) => onQtyChange(item.product, qty)}
                      compact
                    />
                    <div className="font-mono text-[13px] font-black text-slate-900">
                      {formatNpr(item.qty * item.product.retailPrice)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <label className="block">
          <span className="text-[12px] font-black uppercase tracking-wide text-slate-500">
            Note
          </span>
          <textarea
            value={notes}
            onChange={(event) => onNotes(event.target.value)}
            placeholder="Optional request note..."
            className="mt-1 h-[82px] w-full resize-none rounded-[14px] border border-slate-300 bg-white px-3 py-2 text-[13px] font-bold outline-none focus:border-slate-950"
          />
        </label>

        <button
          type="button"
          onClick={onOpenConfirm}
          disabled={!canSend || sending}
          className="flex h-[48px] w-full items-center justify-center gap-2 rounded-[14px] bg-slate-950 px-4 text-[14px] font-black text-white transition hover:bg-slate-800 disabled:pointer-events-none disabled:bg-slate-300"
        >
          <Icon name="send" />
          {sending
            ? "Sending..."
            : selectedCashier && !selectedCashier.isPresent
              ? "Queue request"
              : "Send to cashier"}
        </button>

        {selectedCashier?.isPresent && !selectedCashier.hasOpenDrawer ? (
          <div className="rounded-[14px] border border-sky-200 bg-sky-50 px-3 py-2 text-[12px] font-bold text-sky-800">
            {selectedCashier.name} is online, but their cash session is not
            open. The request can still be reviewed; drawer status does not
            prevent delivery.
          </div>
        ) : selectedCashier && !selectedCashier.isPresent ? (
          <div className="rounded-[14px] border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] font-bold text-amber-800">
            {selectedCashier.name} is currently offline. This request will be
            queued and will appear when they return. If it is urgent, contact
            them or choose an online cashier.
          </div>
        ) : null}
      </div>
    </aside>
  );
}

export default function ProductLookupPage() {
  const { showToast } = useToast();
  const capabilities = useBusinessCapabilities();
  const stockTracked = capabilities.stockTracked;
  const navigate = useNavigate();
  const location = useLocation();
  const [lookupSearchParams, setLookupSearchParams] = useSearchParams();
  const currentUser = useMemo(() => getAuthUser(), []);
  const isAdmin = currentUser?.role === "admin";
  const isStaff =
    currentUser?.role === "staff" && capabilities.staffDraftRequestsEnabled;
  const productLookupRestoreKey = (
    location.state as { productLookupRestoreKey?: string } | null
  )?.productLookupRestoreKey;
  const restoredLookupSnapshot = readProductLookupRestore(
    productLookupRestoreKey,
  );
  const restoredLookupSnapshotRef = useRef(restoredLookupSnapshot);
  const skipInitialCriteriaResetRef = useRef(Boolean(restoredLookupSnapshot));
  const [products, setProducts] = useState<Product[]>(
    () => restoredLookupSnapshot?.products || [],
  );
  const [brands, setBrands] = useState<string[]>(
    () => restoredLookupSnapshot?.brands || ["All Brands"],
  );
  const [categories, setCategories] = useState<string[]>(
    () => restoredLookupSnapshot?.categories || ["All Categories"],
  );
  const [productMetaReady, setProductMetaReady] = useState(
    Boolean(restoredLookupSnapshot),
  );
  const [query, setQuery] = useState(() => lookupSearchParams.get("q") || "");
  const [debouncedQuery, setDebouncedQuery] = useState(
    () => lookupSearchParams.get("q") || "",
  );
  const [brand, setBrand] = useState(
    () => lookupSearchParams.get("brand") || "All Brands",
  );
  const [category, setCategory] = useState(
    () => lookupSearchParams.get("category") || "All Categories",
  );
  const [stockStatus, setStockStatus] = useState<"all" | "in" | "low" | "out">(
    () => {
      const value = lookupSearchParams.get("stock");
      return value === "in" || value === "low" || value === "out" ? value : "all";
    },
  );
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [draftBrand, setDraftBrand] = useState("All Brands");
  const [draftCategory, setDraftCategory] = useState("All Categories");
  const [draftStockStatus, setDraftStockStatus] = useState<
    "all" | "in" | "low" | "out"
  >("all");

  useEffect(() => {
    if (stockTracked || stockStatus === "all") return;
    setStockStatus("all");
    setDraftStockStatus("all");
    setLookupSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("stock");
      next.set("page", "1");
      return next;
    }, { replace: true });
  }, [setLookupSearchParams, stockStatus, stockTracked]);
  const [page, setPage] = useState(() => {
    const value = Number(lookupSearchParams.get("page"));
    return Number.isInteger(value) && value > 0 ? value : 1;
  });
  const [pageSize, setPageSize] = useState(() => {
    const value = Number(lookupSearchParams.get("pageSize"));
    return [10, 20, 50, 100].includes(value) ? value : isStaff ? 10 : 20;
  });
  const [total, setTotal] = useState(() => restoredLookupSnapshot?.total || 0);
  const [loading, setLoading] = useState(!restoredLookupSnapshot);
  const [productsLoadIssue, setProductsLoadIssue] = useState("");
  const [mobileProducts, setMobileProducts] = useState<Product[]>(
    () => restoredLookupSnapshot?.mobileProducts || [],
  );
  const [mobileLoadedPage, setMobileLoadedPage] = useState(
    () => restoredLookupSnapshot?.mobileLoadedPage || 1,
  );
  const [mobileLoadingMore, setMobileLoadingMore] = useState(false);
  const [mobileLoadMoreIssue, setMobileLoadMoreIssue] = useState("");
  const [activeSearchLogId, setActiveSearchLogId] = useState<string | null>(
    () => restoredLookupSnapshot?.activeSearchLogId || null,
  );
  const [rateLimitRecoveryKey, setRateLimitRecoveryKey] = useState(0);
  const [cashiers, setCashiers] = useState<CashierPresence[]>([]);
  const [customers, setCustomers] = useState<LookupCustomer[]>([]);
  const [cashiersLoading, setCashiersLoading] = useState(false);
  const [cashierLoadIssue, setCashierLoadIssue] = useState("");
  const [selectedCashierId, setSelectedCashierId] = useState("");
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [draftItems, setDraftItems] = useState<DraftCartItem[]>([]);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [confirmSendOpen, setConfirmSendOpen] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [draftReviewOpen, setDraftReviewOpen] = useState(false);
  const [draftPersistenceReady, setDraftPersistenceReady] = useState(false);
  const [canViewPurchaseCost, setCanViewPurchaseCost] = useState(
    restoredLookupSnapshot?.canViewPurchaseCost ?? isAdmin,
  );
  const [canViewWholesalePrice, setCanViewWholesalePrice] = useState(
    restoredLookupSnapshot?.canViewWholesalePrice ?? isAdmin,
  );
  const [previewProduct, setPreviewProduct] = useState<Product | null>(null);
  const imagePreviewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const productRequestSequenceRef = useRef(0);
  const mobileLoadMoreControllerRef = useRef<AbortController | null>(null);
  const requestRateLimitRecovery = useRateLimitRecovery(() => {
    setRateLimitRecoveryKey((current) => current + 1);
  });

  useEffect(() => {
    if (!isAdmin) return undefined;
    const timer = window.setTimeout(() => {
      void import("./_app.products");
    }, 750);
    return () => window.clearTimeout(timer);
  }, [isAdmin]);

  useEffect(() => {
    if (!isStaff || !currentUser?.id) {
      setDraftPersistenceReady(true);
      return;
    }
    const stored = readStoredStaffDraft(currentUser.id);
    if (stored) {
      setDraftItems(stored.items);
      setSelectedCashierId(stored.selectedCashierId);
      setSelectedCustomerId(stored.selectedCustomerId);
      setCustomerName(stored.customerName);
      setCustomerPhone(stored.customerPhone);
      setNotes(stored.notes);
    }
    setDraftPersistenceReady(true);
  }, [currentUser?.id, isStaff]);

  useEffect(() => {
    if (!draftPersistenceReady || !isStaff || !currentUser?.id) return;
    writeStoredStaffDraft(currentUser.id, {
      items: draftItems,
      selectedCashierId,
      selectedCustomerId,
      customerName,
      customerPhone,
      notes,
    });
  }, [
    currentUser?.id,
    customerName,
    customerPhone,
    draftItems,
    draftPersistenceReady,
    isStaff,
    notes,
    selectedCashierId,
    selectedCustomerId,
  ]);

  const lookupSearchParamKey = lookupSearchParams.toString();

  useEffect(() => {
    const nextQuery = lookupSearchParams.get("q") || "";
    const nextBrand = lookupSearchParams.get("brand") || "All Brands";
    const nextCategory = lookupSearchParams.get("category") || "All Categories";
    const stockParam = lookupSearchParams.get("stock");
    const nextStock =
      stockParam === "in" || stockParam === "low" || stockParam === "out"
        ? stockParam
        : "all";
    const pageParam = Number(lookupSearchParams.get("page"));
    const nextPage = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;
    const pageSizeParam = Number(lookupSearchParams.get("pageSize"));
    const nextPageSize = [10, 20, 50, 100].includes(pageSizeParam)
      ? pageSizeParam
      : isStaff
        ? 10
        : 20;

    setQuery(nextQuery);
    setDebouncedQuery(nextQuery);
    setBrand(nextBrand);
    setCategory(nextCategory);
    setStockStatus(nextStock);
    setPage(nextPage);
    setPageSize(nextPageSize);
  }, [lookupSearchParamKey, isStaff]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const nextQuery = query.trim();
      if (nextQuery === debouncedQuery) return;
      setDebouncedQuery(nextQuery);
      setPage(1);
      writeLookupUrl({ q: nextQuery, page: 1 }, { replace: true });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [
    query,
    debouncedQuery,
    lookupSearchParamKey,
    brand,
    category,
    stockStatus,
    pageSize,
  ]);

  useEffect(() => {
    if (skipInitialCriteriaResetRef.current) {
      skipInitialCriteriaResetRef.current = false;
      return;
    }
    mobileLoadMoreControllerRef.current?.abort();
    setMobileLoadingMore(false);
    setMobileLoadMoreIssue("");
    setMobileProducts([]);
    setMobileLoadedPage(1);
    setLoading(true);
  }, [debouncedQuery, brand, category, stockStatus, pageSize]);

  function openImagePreview(product: Product, trigger: HTMLButtonElement) {
    if (!product.imageUrl) return;
    trackSearchSelection(product, "VIEW_IMAGE");
    imagePreviewTriggerRef.current = trigger;
    setPreviewProduct(product);
  }

  function closeImagePreview() {
    setPreviewProduct(null);
    window.setTimeout(() => {
      imagePreviewTriggerRef.current?.focus();
    }, 0);
  }

  function writeLookupUrl(
    next: {
      q?: string;
      brand?: string;
      category?: string;
      stockStatus?: "all" | "in" | "low" | "out";
      page?: number;
      pageSize?: number;
    },
    options?: { replace?: boolean },
  ) {
    const params = new URLSearchParams(lookupSearchParams);
    const nextQuery = next.q ?? debouncedQuery;
    const nextBrand = next.brand ?? brand;
    const nextCategory = next.category ?? category;
    const nextStock = next.stockStatus ?? stockStatus;
    const nextPage = next.page ?? page;
    const nextPageSize = next.pageSize ?? pageSize;

    if (nextQuery.trim()) params.set("q", nextQuery.trim());
    else params.delete("q");
    if (nextBrand !== "All Brands") params.set("brand", nextBrand);
    else params.delete("brand");
    if (nextCategory !== "All Categories") params.set("category", nextCategory);
    else params.delete("category");
    if (nextStock !== "all") params.set("stock", nextStock);
    else params.delete("stock");
    if (nextPage > 1) params.set("page", String(nextPage));
    else params.delete("page");
    params.set("pageSize", String(nextPageSize));

    if (params.toString() !== lookupSearchParams.toString()) {
      setLookupSearchParams(params, { replace: options?.replace ?? false });
    }
  }

  function applyDesktopBrand(value: string) {
    setBrand(value);
    setPage(1);
    writeLookupUrl({ brand: value, page: 1 });
  }

  function applyDesktopCategory(value: string) {
    setCategory(value);
    setPage(1);
    writeLookupUrl({ category: value, page: 1 });
  }

  function applyDesktopStock(value: "all" | "in" | "low" | "out") {
    setStockStatus(value);
    setPage(1);
    writeLookupUrl({ stockStatus: value, page: 1 });
  }

  function changeDesktopPage(nextPage: number) {
    setPage(nextPage);
    writeLookupUrl({ page: nextPage });
  }

  function editProductFromLookup(product: Product) {
    if (!isAdmin) return;
    trackSearchSelection(product, "EDIT_PRODUCT");

    const returnParams = new URLSearchParams();
    if (debouncedQuery.trim()) returnParams.set("q", debouncedQuery.trim());
    if (brand !== "All Brands") returnParams.set("brand", brand);
    if (category !== "All Categories") returnParams.set("category", category);
    if (stockStatus !== "all") returnParams.set("stock", stockStatus);
    if (page > 1) returnParams.set("page", String(page));
    returnParams.set("pageSize", String(pageSize));

    const returnQuery = returnParams.toString();
    const returnTo = `/product-lookup${returnQuery ? `?${returnQuery}` : ""}`;
    const editorParams = new URLSearchParams({
      editProduct: product.id,
      returnTo,
    });
    const handoff: ProductLookupEditHandoff = {
      product,
      snapshot: {
        products,
        mobileProducts,
        brands,
        categories,
        total,
        mobileLoadedPage,
        activeSearchLogId,
        canViewPurchaseCost,
        canViewWholesalePrice,
      },
    };
    const productLookupEditKey = stageProductLookupEdit(handoff);
    navigate(`/products?${editorParams.toString()}`, {
      state: { productLookupEditKey },
    });
  }

  async function loadMeta() {
    try {
      const meta = await fetchProductsMeta();
      setBrands(["All Brands", ...meta.brands]);
      setCategories(["All Categories", ...meta.categories]);
    } catch (error) {
      if (isRateLimitError(error)) requestRateLimitRecovery();
    } finally {
      setProductMetaReady(true);
    }
  }

  async function loadProducts(
    options?: { signal?: AbortSignal },
    preserveMobileAccumulation = false,
  ) {
    const requestSequence = productRequestSequenceRef.current + 1;
    productRequestSequenceRef.current = requestSequence;
    const result = await fetchPriceLookupProducts(
      {
        q: debouncedQuery,
        brand,
        category,
        stockStatus,
        status: "active",
        page,
        pageSize,
        includeDraftReservations: isStaff,
      },
      options,
    );
    if (
      options?.signal?.aborted ||
      requestSequence !== productRequestSequenceRef.current
    ) {
      return;
    }
    setProducts(result.items);
    setMobileProducts((current) => {
      if (!preserveMobileAccumulation || current.length <= result.items.length) {
        return result.items;
      }
      const byId = new Map(current.map((product) => [product.id, product]));
      for (const product of result.items) byId.set(product.id, product);
      return [...byId.values()];
    });
    if (!preserveMobileAccumulation) setMobileLoadedPage(page);
    setMobileLoadMoreIssue("");
    setTotal(result.total);
    setActiveSearchLogId(result.searchLogId);
    setCanViewPurchaseCost(result.visibility.canViewPurchaseCost);
    setCanViewWholesalePrice(result.visibility.canViewWholesalePrice);
  }

  async function loadMoreMobileProducts() {
    if (mobileLoadingMore || mobileProducts.length >= total) return;
    mobileLoadMoreControllerRef.current?.abort();
    const controller = new AbortController();
    mobileLoadMoreControllerRef.current = controller;
    const nextPage = mobileLoadedPage + 1;
    setMobileLoadingMore(true);
    setMobileLoadMoreIssue("");
    try {
      const result = await fetchPriceLookupProducts(
        {
          q: debouncedQuery,
          brand,
          category,
          stockStatus,
          status: "active",
          page: nextPage,
          pageSize,
          includeDraftReservations: isStaff,
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setMobileProducts((current) => {
        const byId = new Map(current.map((product) => [product.id, product]));
        for (const product of result.items) byId.set(product.id, product);
        return [...byId.values()];
      });
      setMobileLoadedPage(nextPage);
      setTotal(result.total);
    } catch (error: any) {
      if (controller.signal.aborted || error?.code === "ERR_CANCELED") return;
      setMobileLoadMoreIssue("More products could not be loaded. Please try again.");
    } finally {
      if (!controller.signal.aborted) setMobileLoadingMore(false);
    }
  }

  function trackSearchSelection(
    product: Product,
    action: ProductSearchSelectionAction,
  ) {
    if (!debouncedQuery || !activeSearchLogId) return;
    void recordProductSearchSelectionApi({
      searchLogId: activeSearchLogId,
      productId: product.id,
      action,
    }).catch(() => undefined);
  }

  async function loadCashiers(options?: { signal?: AbortSignal }) {
    if (!isStaff) return;
    setCashiersLoading(true);
    setCashierLoadIssue("");
    try {
      const result = await listCashierPresenceApi(options);
      const nextCashiers = [...(result.cashiers || [])]
        .filter((cashier) => cashier.isActive)
        .sort(
          (left, right) =>
            cashierAvailabilityRank(left) - cashierAvailabilityRank(right) ||
            left.pendingDraftRequestCount - right.pendingDraftRequestCount ||
            left.name.localeCompare(right.name),
        );
      setCashiers(nextCashiers);
      setSelectedCashierId((current) => {
        if (current && nextCashiers.some((cashier) => cashier.id === current)) {
          return current;
        }
        if (nextCashiers.length === 1) return nextCashiers[0].id;
        return "";
      });
    } catch (error: any) {
      if (options?.signal?.aborted || error?.code === "ERR_CANCELED") return;
      if (isRateLimitError(error)) requestRateLimitRecovery();
      setCashierLoadIssue("Cashier availability is temporarily unavailable");
    } finally {
      setCashiersLoading(false);
    }
  }

  async function loadCustomers(options?: { signal?: AbortSignal }) {
    if (!isStaff) return;
    try {
      const result = await listCustomersApi(true, options);
      const raw = Array.isArray(result) ? result : result?.customers || [];
      setCustomers(
        raw.map((customer: any) => ({
          id: String(customer.id),
          name: String(customer.name || "Customer"),
          phone: customer.phone ? String(customer.phone) : null,
        })),
      );
    } catch (error: any) {
      if (options?.signal?.aborted || error?.code === "ERR_CANCELED") return;
      if (isRateLimitError(error)) requestRateLimitRecovery();
      // Keep the last successful customer list. A temporary read failure must
      // not make valid customers disappear from a draft in progress.
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void loadMeta();
    }, 100);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [rateLimitRecoveryKey]);

  useEffect(() => {
    if (!productMetaReady) return undefined;
    const controller = new AbortController();
    function refreshLookupVisibility() {
      if (document.visibilityState !== "visible") return;
      void loadProducts({ signal: controller.signal }, true).catch(() => undefined);
    }
    window.addEventListener("focus", refreshLookupVisibility);
    document.addEventListener("visibilitychange", refreshLookupVisibility);
    return () => {
      controller.abort();
      window.removeEventListener("focus", refreshLookupVisibility);
      document.removeEventListener("visibilitychange", refreshLookupVisibility);
    };
  }, [debouncedQuery, brand, category, stockStatus, page, pageSize, productMetaReady]);

  useEffect(() => {
    if (!productMetaReady) return undefined;
    const controller = new AbortController();
    const restoredSnapshot = restoredLookupSnapshotRef.current;
    restoredLookupSnapshotRef.current = undefined;
    const timer = window.setTimeout(() => {
      if (!restoredSnapshot) setLoading(true);
      setProductsLoadIssue("");
      void loadProducts({ signal: controller.signal }, Boolean(restoredSnapshot))
        .catch((error: any) => {
          if (controller.signal.aborted || error?.code === "ERR_CANCELED")
            return;
          const rateLimited = isRateLimitError(error);
          if (rateLimited) requestRateLimitRecovery();
          setProductsLoadIssue(
            rateLimited
              ? "Product data is temporarily paused and will refresh automatically."
              : "Products could not be loaded. Please try again.",
          );
        })
        .finally(() => {
          if (!controller.signal.aborted && !restoredSnapshot) setLoading(false);
        });
    }, restoredSnapshot ? 0 : 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    debouncedQuery,
    brand,
    category,
    stockStatus,
    page,
    pageSize,
    rateLimitRecoveryKey,
    productMetaReady,
  ]);

  useEffect(() => {
    const controller = new AbortController();
    let interval: number | undefined;
    const timer = window.setTimeout(() => {
      void loadCashiers({ signal: controller.signal });
      void loadCustomers({ signal: controller.signal });
      if (isStaff) {
        interval = window.setInterval(
          () => void loadCashiers({ signal: controller.signal }),
          45_000,
        );
      }
    }, 100);
    return () => {
      window.clearTimeout(timer);
      if (interval) window.clearInterval(interval);
      controller.abort();
    };
  }, [isStaff, rateLimitRecoveryKey]);

  useEffect(() => {
    if (!isStaff || !draftReviewOpen) return undefined;
    void loadCashiers();
    function refreshOnFocus() {
      if (document.visibilityState === "visible") void loadCashiers();
    }
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnFocus);
    return () => {
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnFocus);
    };
  }, [draftReviewOpen, isStaff]);

  useEffect(() => {
    if (draftItems.length === 0) {
      setDraftReviewOpen(false);
    }
  }, [draftItems.length]);

  useEffect(() => {
    if (!previewProduct) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeImagePreview();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previewProduct]);

  const draftByProductId = useMemo(() => {
    return new Map(draftItems.map((item) => [item.product.id, item]));
  }, [draftItems]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageStart = total === 0 ? 0 : (page - 1) * pageSize;
  const pageEnd =
    total === 0 ? 0 : Math.min(total, pageStart + products.length);
  const activeFilters = Boolean(
    query.trim() ||
    brand !== "All Brands" ||
    category !== "All Categories" ||
    stockStatus !== "all",
  );
  const mobileFilterCount = [
    brand !== "All Brands",
    category !== "All Categories",
    stockStatus !== "all",
  ].filter(Boolean).length;
  const mobileFilterChips: MobileFilterChip[] = [
    ...(debouncedQuery
      ? [
          {
            id: "query",
            label: `Search: ${debouncedQuery}`,
            onRemove: () => {
              setQuery("");
              setDebouncedQuery("");
              setPage(1);
              writeLookupUrl({ q: "", page: 1 }, { replace: true });
            },
          },
        ]
      : []),
    ...(brand !== "All Brands"
      ? [
          {
            id: "brand",
            label: `Brand: ${brand}`,
            onRemove: () => {
              applyDesktopBrand("All Brands");
            },
          },
        ]
      : []),
    ...(category !== "All Categories"
      ? [
          {
            id: "category",
            label: `Category: ${category}`,
            onRemove: () => {
              applyDesktopCategory("All Categories");
            },
          },
        ]
      : []),
    ...(stockStatus !== "all"
      ? [
          {
            id: "stock",
            label:
              stockStatus === "in"
                ? "In stock"
                : stockStatus === "low"
                  ? "Low stock"
                  : "Out of stock",
            onRemove: () => {
              applyDesktopStock("all");
            },
          },
        ]
      : []),
  ];

  function openMobileFilters() {
    setDraftBrand(brand);
    setDraftCategory(category);
    setDraftStockStatus(stockStatus);
    setMobileFiltersOpen(true);
  }

  function applyMobileFilters() {
    setBrand(draftBrand);
    setCategory(draftCategory);
    setStockStatus(draftStockStatus);
    setPage(1);
    writeLookupUrl({
      brand: draftBrand,
      category: draftCategory,
      stockStatus: draftStockStatus,
      page: 1,
    });
    setMobileFiltersOpen(false);
  }

  function clearFilters() {
    setQuery("");
    setBrand("All Brands");
    setCategory("All Categories");
    setStockStatus("all");
    setPage(1);
    setDebouncedQuery("");
    writeLookupUrl({
      q: "",
      brand: "All Brands",
      category: "All Categories",
      stockStatus: "all",
      page: 1,
    });
  }

  function updateDraftQty(product: Product, qty: number) {
    if (qty > 0) trackSearchSelection(product, "ADD_TO_DRAFT");
    setDraftItems((current) => {
      const nextQty = Math.round(Math.max(0, qty) * 1000) / 1000;
      const existing = current.find((item) => item.product.id === product.id);
      if (nextQty <= 0) {
        return current.filter((item) => item.product.id !== product.id);
      }
      if (product.stock <= 0) {
        showToast("warning", `"${product.name}" is out of stock.`);
        return current;
      }
      if (nextQty > product.stock) {
        showToast(
          "warning",
          `"${product.name}" has only ${formatQty(product.stock)} ${product.saleUnit} in stock.`,
        );
      }
      if (
        Number(product.draftRequestedQty || 0) > 0 &&
        nextQty > Number(product.effectiveAvailableStock ?? product.stock)
      ) {
        showToast(
          "warning",
          `${formatQty(Number(product.draftRequestedQty || 0))} ${product.saleUnit} of "${product.name}" is already requested in pending drafts.`,
        );
      }
      const safeQty = Math.min(nextQty, product.stock);
      if (existing) {
        return current.map((item) =>
          item.product.id === product.id ? { ...item, qty: safeQty } : item,
        );
      }
      return [...current, { product, qty: safeQty, note: "" }];
    });
  }

  async function sendDraftRequest() {
    if (sending) return;
    const selectedCashier = cashiers.find(
      (cashier) => cashier.id === selectedCashierId,
    );
    if (!selectedCashier?.isActive) {
      showToast(
        "warning",
        "Choose an active cashier before sending this request.",
      );
      return;
    }
    if (draftItems.length === 0) {
      showToast("warning", "Add at least one product before sending.");
      return;
    }

    setSending(true);
    try {
      const result = await createDraftRequestApi({
        customerId: selectedCustomerId || null,
        customerName: customerName.trim() || null,
        customerPhone: customerPhone.trim() || null,
        assignedCashierId: selectedCashier.id,
        notes: notes.trim() || null,
        items: draftItems.map((item) => ({
          productId: item.product.id,
          qty: item.qty,
          note: item.note || null,
        })),
      });
      setConfirmSendOpen(false);
      setSuccessMessage(
        selectedCashier.isPresent
          ? `${result.request.requestNo} sent to ${selectedCashier.name}.`
          : `${result.request.requestNo} was queued for ${selectedCashier.name}. Waiting for them to view it.`,
      );
      setDraftItems([]);
      setSelectedCustomerId("");
      setCustomerName("");
      setCustomerPhone("");
      setNotes("");
      setDraftReviewOpen(false);
      await loadCashiers();
    } catch (error: any) {
      showToast("danger", apiError(error, "Could not send draft request."));
    } finally {
      setSending(false);
    }
  }

  const draftCount = draftItems.length;
  const draftQty = draftItems.reduce((sum, item) => sum + item.qty, 0);
  const draftEstimate = draftItems.reduce(
    (sum, item) => sum + item.qty * item.product.retailPrice,
    0,
  );
  const selectedCashier = cashiers.find(
    (cashier) => cashier.id === selectedCashierId,
  );

  return (
    <div className="min-h-full bg-white text-[#000000]">
      <div className="w-full space-y-4">
        <section className="bg-white lg:relative lg:z-20 lg:overflow-visible lg:rounded-[20px] lg:border lg:border-slate-200 lg:shadow-sm">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2.5 bg-white lg:grid-cols-[minmax(0,1fr)_180px] lg:gap-3 lg:border-b lg:border-slate-200 lg:p-3">
            <div className="relative">
              <Icon
                name="barcode_scanner"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                sizePx={22}
              />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Enter name, SKU, barcode, supplier..."
                className="h-[50px] w-full rounded-[12px] border border-[#CFCFD3] bg-white pl-11 pr-3 text-[14px] font-semibold text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-slate-950 focus:ring-4 focus:ring-slate-100 lg:rounded-[15px] lg:border-2 lg:text-[15px] lg:font-bold"
              />
            </div>
            <button
              type="button"
              onClick={clearFilters}
              disabled={!activeFilters}
              className="hidden h-[50px] items-center justify-center gap-2 rounded-[15px] border border-slate-300 bg-white px-4 text-[13px] font-black text-slate-600 transition hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-40 lg:flex"
            >
              <Icon name="close" sizePx={18} />
              Clear filters
            </button>
            <MobileFilterButton
              activeCount={mobileFilterCount}
              onClick={openMobileFilters}
              className="lg:hidden"
            />
            <ActiveFilterChips
              items={mobileFilterChips}
              className="col-span-2 lg:hidden"
            />
          </div>

          <div className="hidden grid-cols-3 gap-3 border-b border-slate-200 bg-slate-50 p-4 lg:grid">
            <FilterFields
              brands={brands}
              categories={categories}
              brand={brand}
              category={category}
              stockStatus={stockStatus}
              onBrand={applyDesktopBrand}
              onCategory={applyDesktopCategory}
              onStock={applyDesktopStock}
              hideStock={!stockTracked}
            />
          </div>
          <ActiveFilterChips
            items={mobileFilterChips}
            className="hidden border-b border-slate-200 bg-white px-4 pb-3 lg:flex"
          />
        </section>

        <MobileFilterSheet
          open={mobileFiltersOpen}
          onClose={() => setMobileFiltersOpen(false)}
          onClear={() => {
            clearFilters();
            setMobileFiltersOpen(false);
          }}
          onApply={applyMobileFilters}
          clearLabel="Clear all"
        >
          <div className="space-y-5">
            <FilterFields
              brands={brands}
              categories={categories}
              brand={draftBrand}
              category={draftCategory}
              stockStatus={draftStockStatus}
              onBrand={setDraftBrand}
              onCategory={setDraftCategory}
              onStock={setDraftStockStatus}
              hideStock
            />
            {stockTracked ? <fieldset className="space-y-2">
              <legend className="text-[12px] font-black uppercase tracking-wide text-slate-500">
                Stock
              </legend>
              <div className="grid grid-cols-4 overflow-hidden rounded-xl border border-slate-200">
                {(
                  [
                    ["all", "All"],
                    ["in", "In stock"],
                    ["low", "Low"],
                    ["out", "Out"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setDraftStockStatus(value)}
                    className={cn(
                      "min-h-[50px] border-r border-slate-200 px-1 text-[11px] font-bold last:border-r-0",
                      draftStockStatus === value
                        ? "bg-emerald-600 text-white"
                        : "bg-white text-slate-700",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </fieldset> : null}
          </div>
        </MobileFilterSheet>

        {productsLoadIssue ? (
          <div
            role="status"
            className="rounded-[14px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] font-bold text-amber-800"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>{productsLoadIssue}</span>
              <button
                type="button"
                onClick={() => setRateLimitRecoveryKey((current) => current + 1)}
                className="min-h-10 rounded-[11px] border border-amber-300 bg-white px-3 text-[12px] font-extrabold text-amber-900"
              >
                Try again
              </button>
            </div>
          </div>
        ) : null}

        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {!loading
            ? `${total.toLocaleString()} product${total === 1 ? "" : "s"} found.`
            : "Loading products."}
        </div>

        <div
          className={cn(
            "grid gap-4",
            isStaff && draftItems.length > 0
              ? "lg:grid-cols-[minmax(0,1fr)_390px]"
              : "lg:grid-cols-1",
          )}
        >
          <main className="min-w-0 space-y-4">
            <section className="flex min-h-[calc(100dvh-176px)] flex-col lg:min-h-0 lg:block lg:overflow-hidden lg:rounded-[20px] lg:border lg:border-slate-200 lg:bg-white lg:shadow-sm">
              <div className="hidden overflow-x-auto lg:block">
                <table className="w-full min-w-[900px] text-left">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-[12px] font-black uppercase tracking-wide text-slate-500">
                      <th className="px-4 py-3">Product info</th>
                      <th className="px-4 py-3">Category / brand</th>
                      <th className="px-4 py-3">Packaging</th>
                      {canViewPurchaseCost ? (
                        <th className="px-4 py-3 text-right">
                          Purchase cost / खरिद दर
                        </th>
                      ) : null}
                      <th className="px-4 py-3 text-right">Retail</th>
                      {canViewWholesalePrice ? (
                        <th className="px-4 py-3 text-right">Wholesale</th>
                      ) : null}
                      {stockTracked ? (
                        <th className="px-4 py-3 text-center">Stock</th>
                      ) : null}
                      {isAdmin ? (
                        <th className="px-4 py-3 text-right">Manage</th>
                      ) : null}
                      {isStaff ? (
                        <th className="px-4 py-3 text-right">Draft qty</th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {loading ? (
                      Array.from({ length: 8 }).map((_, index) => (
                        <tr key={index}>
                          <td
                            colSpan={
                              (stockTracked ? 5 : 4) +
                              (canViewPurchaseCost ? 1 : 0) +
                              (canViewWholesalePrice ? 1 : 0) +
                              (isAdmin ? 1 : 0) +
                              (isStaff ? 1 : 0)
                            }
                            className="px-4 py-3"
                          >
                            <div className="h-[54px] animate-pulse rounded-[12px] bg-slate-100" />
                          </td>
                        </tr>
                      ))
                    ) : productsLoadIssue && products.length === 0 ? (
                      <tr>
                        <td
                          colSpan={
                            (stockTracked ? 5 : 4) +
                            (canViewPurchaseCost ? 1 : 0) +
                            (canViewWholesalePrice ? 1 : 0) +
                            (isAdmin ? 1 : 0) +
                            (isStaff ? 1 : 0)
                          }
                          className="px-6 py-14 text-center text-[13px] font-bold text-slate-500"
                        >
                          Waiting for product data to resume...
                        </td>
                      </tr>
                    ) : products.length === 0 ? (
                      <tr>
                        <td
                          colSpan={
                            (stockTracked ? 5 : 4) +
                            (canViewPurchaseCost ? 1 : 0) +
                            (canViewWholesalePrice ? 1 : 0) +
                            (isAdmin ? 1 : 0) +
                            (isStaff ? 1 : 0)
                          }
                          className="px-6 py-14 text-center"
                        >
                          <EmptyState
                            onClear={clearFilters}
                            filtered={activeFilters}
                            query={debouncedQuery}
                          />
                        </td>
                      </tr>
                    ) : (
                      products.map((product) => {
                        const draftQty =
                          draftByProductId.get(product.id)?.qty || 0;
                        const categoryBrand = getCategoryBrandDisplay(product);
                        return (
                          <tr
                            key={product.id}
                            className="transition-colors hover:bg-[#ECEFF3]"
                          >
                            <td className="px-4 py-4">
                              <div className="flex items-start gap-3">
                                <ProductPreviewThumb
                                  product={product}
                                  className="flex h-[52px] w-[52px] shrink-0 items-center justify-center overflow-hidden rounded-[14px] border border-slate-200 bg-slate-50"
                                  iconClassName="text-slate-400"
                                  onOpen={openImagePreview}
                                />
                                <div className="min-w-0">
                                  <div className="max-w-[340px] truncate text-[14px] font-black text-slate-950">
                                    {product.name}
                                  </div>
                                  <div className="mt-1 text-[12px] font-bold text-slate-500">
                                    SKU: {product.sku}
                                    {product.barcode
                                      ? ` · BC: ${product.barcode}`
                                      : ""}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-4">
                              <div className="text-[13px] font-black text-slate-900">
                                {categoryBrand.primary}
                              </div>
                              {categoryBrand.lines.map((line, index) => (
                                <div
                                  key={line}
                                  className={cn(
                                    "mt-1 max-w-[180px] truncate font-bold",
                                    index === 0
                                      ? "text-[12px] text-slate-500"
                                      : "text-[11px] text-slate-400",
                                  )}
                                >
                                  {line}
                                </div>
                              ))}
                            </td>
                            <td className="px-4 py-4">
                              <div className="text-[13px] font-black text-slate-900">
                                {formatSize(product)}
                              </div>
                              <div className="mt-1 text-[12px] font-bold text-slate-500">
                                Pack {formatPackage(product)}
                              </div>
                              <div className="mt-1 text-[11px] font-bold text-slate-400">
                                Step {formatQty(product.quantityStep || 1)}
                              </div>
                            </td>
                            {canViewPurchaseCost ? (
                              <td className="px-4 py-4 text-right font-mono text-[15px] font-black text-slate-950">
                                {formatNpr(product.ratePerPiece)}
                              </td>
                            ) : null}
                            <td className="px-4 py-4 text-right font-mono text-[15px] font-black text-slate-950">
                              {formatNpr(product.retailPrice)}
                            </td>
                            {canViewWholesalePrice ? (
                              <td className="px-4 py-4 text-right">
                                <>
                                  <div className="font-mono text-[15px] font-black text-slate-950">
                                    {formatNpr(product.wholesalePrice)}
                                  </div>
                                  <div className="mt-1 text-[11px] font-bold text-slate-400">
                                    {product.wholesaleEligible
                                      ? `थोक सीमा ${formatQty(product.thresholdQty)} ${product.saleUnit || "PIECE"}`
                                      : "थोक मूल्य बन्द"}
                                  </div>
                                </>
                              </td>
                            ) : null}
                            {stockTracked ? <td className="px-4 py-4 text-center">
                              <span
                                className={cn(
                                  "inline-flex rounded-full border px-2.5 py-1 text-[11px] font-black",
                                  stockTone(product),
                                )}
                              >
                                {stockLabel(product)}
                              </span>
                              <div className="mt-1 text-[12px] font-black text-slate-700">
                                {formatQty(product.stock)} {product.saleUnit}
                              </div>
                              {Number(product.draftRequestedQty || 0) > 0 ? (
                                <div className="mt-1 text-[11px] font-black text-amber-600">
                                  {formatQty(
                                    Number(product.draftRequestedQty || 0),
                                  )}{" "}
                                  requested
                                </div>
                              ) : null}
                            </td> : null}
                            {isAdmin ? (
                              <td className="px-4 py-4 text-right">
                                <button
                                  type="button"
                                  onClick={() => editProductFromLookup(product)}
                                  className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-[11px] border border-slate-300 bg-white px-3 text-[12px] font-black text-slate-800 transition hover:border-slate-950 hover:bg-slate-950 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950 focus-visible:ring-offset-2"
                                  aria-label={`Edit ${product.name}`}
                                >
                                  <Icon name="edit" sizePx={17} />
                                  Edit
                                </button>
                              </td>
                            ) : null}
                            {isStaff ? (
                              <td className="px-4 py-4 text-right">
                                <ProductAction
                                  product={product}
                                  draftQty={draftQty}
                                  onQtyChange={updateDraftQty}
                                />
                              </td>
                            ) : null}
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              <div className="flex-1 space-y-3 lg:hidden">
                {loading ? (
                  Array.from({ length: 6 }).map((_, index) => (
                    <div
                      key={index}
                      className="h-[164px] animate-pulse rounded-[18px] bg-slate-100"
                    />
                  ))
                ) : productsLoadIssue && products.length === 0 ? (
                  <div className="rounded-[18px] border border-dashed border-slate-300 bg-white px-6 py-14 text-center text-[13px] font-bold text-slate-500">
                    Waiting for product data to resume...
                  </div>
                ) : products.length === 0 ? (
                  <EmptyState
                    onClear={clearFilters}
                    filtered={activeFilters}
                    query={debouncedQuery}
                  />
                ) : (
                  products.map((product) => {
                    const draftQty = draftByProductId.get(product.id)?.qty || 0;
                    const categoryBrand = getCategoryBrandDisplay(product);
                    return (
                      <article
                        key={product.id}
                        data-product-id={product.id}
                        className="rounded-[16px] border border-[#E5E7EB] bg-white p-3 shadow-sm"
                      >
                        <div className="grid grid-cols-[76px_minmax(0,1fr)_124px] items-stretch gap-x-2.5 min-[400px]:grid-cols-[84px_minmax(0,1fr)_136px] min-[400px]:gap-x-3">
                          <div className="flex min-w-0 flex-col items-center">
                            <ProductPreviewThumb
                              product={product}
                              className="flex h-[76px] w-[76px] shrink-0 items-center justify-center overflow-hidden rounded-[12px] border border-[#DDE2E8] bg-[#F8FAFC] min-[400px]:h-[84px] min-[400px]:w-[84px]"
                              iconClassName="text-[#8C8889]"
                              onOpen={openImagePreview}
                            />
                            <div className="mt-2 w-full text-center">
                              <div className="text-[9px] font-extrabold leading-3 text-slate-700">
                                बिक्री एकाइ
                              </div>
                              <div className="mt-1 flex items-center justify-center gap-1 text-[10px] font-black leading-4 text-[#11120d] min-[400px]:text-[11px]">
                                {stockTracked ? <span
                                  className={cn(
                                    "h-2 w-2 shrink-0 rounded-full",
                                    stockDot(product),
                                  )}
                                /> : null}
                                <span className="whitespace-nowrap">
                                  {stockTracked ? `${formatQty(product.stock)} ` : ""}
                                  {product.saleUnit || "PIECE"}
                                </span>
                              </div>
                            </div>
                          </div>
                          <div
                            className={cn(
                              "flex min-h-[126px] min-w-0 flex-col py-1",
                              canViewPurchaseCost
                                ? "justify-between"
                                : "justify-center",
                            )}
                          >
                            <div>
                              <h2 className="break-words text-[16px] font-black leading-5 text-[#11120d] [overflow-wrap:anywhere] min-[400px]:text-[17px] min-[400px]:leading-[21px]">
                                {product.name}
                              </h2>
                              <div className="mt-1 truncate text-[12px] font-bold leading-4 text-[#4B5563] min-[400px]:text-[13px]">
                                {product.brand || "Unbranded"}
                              </div>
                            </div>
                            {canViewPurchaseCost ? (
                              <div className="mt-4 border-t border-slate-200 pt-2.5">
                                <div className="text-[11px] font-black leading-4 text-slate-800 min-[400px]:text-[14px]">
                                  खरिद दर
                                </div>
                                <CompactPrice value={product.ratePerPiece} />
                              </div>
                            ) : null}
                          </div>
                          <div
                            className={cn(
                              "min-h-[112px] self-stretch overflow-hidden rounded-[12px] border border-slate-200 bg-white",
                              canViewWholesalePrice
                                ? "grid grid-rows-2"
                                : "flex flex-col justify-center border-emerald-200 bg-emerald-50",
                            )}
                          >
                            <div
                              className={cn(
                                "flex min-w-0 flex-col justify-center px-2 py-2 min-[400px]:px-2.5",
                                canViewWholesalePrice &&
                                  "border-b border-slate-200 bg-emerald-50",
                              )}
                            >
                              <div className="text-[10px] font-black uppercase leading-3 tracking-[-0.01em] text-emerald-800">
                                Retail / खुद्रा
                              </div>
                              <CompactPrice
                                value={product.retailPrice}
                                tone="retail"
                              />
                            </div>
                            {canViewWholesalePrice ? (
                              <div className="flex min-w-0 flex-col justify-center bg-slate-50 px-2 py-2 min-[400px]:px-2.5">
                                <div className="text-[10px] font-black uppercase leading-3 tracking-[-0.01em] text-slate-700">
                                  Wholesale / थोक
                                </div>
                                <CompactPrice
                                  value={product.wholesalePrice}
                                  compact
                                />
                                <div className="mt-1 text-[9px] font-extrabold leading-3 text-slate-700 min-[400px]:text-[10px]">
                                  {product.wholesaleEligible
                                    ? `थोक सीमा ${formatQty(product.thresholdQty)} ${product.saleUnit || "PIECE"}`
                                    : "थोक मूल्य बन्द"}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        </div>

                        <details
                          className="group mt-3"
                          onToggle={(event) => {
                            if (event.currentTarget.open) {
                              trackSearchSelection(product, "VIEW_DETAILS");
                            }
                          }}
                        >
                          <summary className="flex cursor-pointer list-none items-center justify-center gap-1 rounded-[12px] border border-slate-200 bg-slate-50 py-2 text-[12px] font-black text-slate-600">
                            <span className="group-open:hidden">
                              View details
                            </span>
                            <span className="hidden group-open:inline">
                              Hide details
                            </span>
                            <Icon
                              name="expand_more"
                              sizePx={18}
                              className="transition group-open:rotate-180"
                            />
                          </summary>
                          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 text-[12px]">
                            <Info label="SKU" value={product.sku || "-"} />
                            <Info
                              label="Barcode"
                              value={product.barcode || "-"}
                            />
                            <Info
                              label="Category / brand"
                              value={categoryBrand.primary}
                            />
                            <Info
                              label="Source"
                              value={categoryBrand.lines.join(" / ") || "-"}
                            />
                            <Info
                              label="Package"
                              value={formatPackage(product)}
                            />
                            <Info label="Size" value={formatSize(product)} />
                          </div>
                        </details>

                        {isAdmin ? (
                          <button
                            type="button"
                            onClick={() => editProductFromLookup(product)}
                            className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[12px] border border-slate-300 bg-white px-4 text-[13px] font-black text-slate-800 transition active:scale-[0.99] active:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950 focus-visible:ring-offset-2"
                            aria-label={`Edit ${product.name}`}
                          >
                            <Icon name="edit" sizePx={18} />
                            Edit product
                          </button>
                        ) : null}

                        {isStaff ? (
                          <div className="mt-4 flex items-center justify-between gap-3 rounded-[14px] border border-slate-200 bg-slate-50 p-3">
                            <div>
                              <div className="text-[11px] font-black uppercase text-slate-500">
                                Draft quantity
                              </div>
                              <div className="mt-1 text-[12px] font-bold text-slate-400">
                                Add for cashier request
                              </div>
                            </div>
                            <QtyControl
                              product={product}
                              qty={draftQty}
                              onChange={(qty) => updateDraftQty(product, qty)}
                              compact
                            />
                          </div>
                        ) : null}
                      </article>
                    );
                  })
                )}
              </div>

              {!loading && products.length > 0 ? (
                <PaginationBar
                  page={page}
                  totalPages={totalPages}
                  total={total}
                  start={pageStart}
                  end={pageEnd}
                  label="products"
                  pageSize={pageSize}
                  onPageChange={changeDesktopPage}
                  onPageSizeChange={(nextPageSize) => {
                    setPageSize(nextPageSize);
                    setPage(1);
                    writeLookupUrl({ pageSize: nextPageSize, page: 1 });
                  }}
                  className="border-t border-slate-200 !px-4 !py-5"
                />
              ) : null}
            </section>
          </main>

          {isStaff && draftItems.length > 0 ? (
            <div className="hidden lg:block">
              <DraftPanel
                items={draftItems}
                cashiers={cashiers}
                customers={customers}
                selectedCashierId={selectedCashierId}
                selectedCustomerId={selectedCustomerId}
                customerName={customerName}
                customerPhone={customerPhone}
                notes={notes}
                sending={sending}
                cashiersLoading={cashiersLoading}
                cashierLoadIssue={cashierLoadIssue}
                onSelectCashier={setSelectedCashierId}
                onSelectCustomer={(customer) => {
                  setSelectedCustomerId(customer?.id || "");
                  setCustomerName(customer?.name || "");
                  setCustomerPhone(customer?.phone || "");
                }}
                onCustomerName={setCustomerName}
                onCustomerPhone={setCustomerPhone}
                onNotes={setNotes}
                onRemoveItem={(productId) =>
                  setDraftItems((current) =>
                    current.filter((item) => item.product.id !== productId),
                  )
                }
                onQtyChange={updateDraftQty}
                onOpenConfirm={() => setConfirmSendOpen(true)}
              />
            </div>
          ) : null}
        </div>
      </div>

      {isStaff && draftItems.length > 0 ? (
        <div className="fixed inset-x-0 bottom-[calc(64px+env(safe-area-inset-bottom))] z-40 border-t border-slate-200 bg-white/95 px-3 py-3 shadow-[0_-18px_44px_rgba(15,23,42,0.12)] backdrop-blur lg:hidden">
          <div className="mx-auto flex max-w-[720px] items-center justify-between gap-3">
            <div>
              <div className="text-[13px] font-black text-slate-950">
                {draftCount} item(s) · {formatQty(draftQty)} unit(s)
              </div>
              <div className="font-mono text-[12px] font-black text-slate-500">
                {formatNpr(draftEstimate)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setDraftReviewOpen(true)}
              className="h-[42px] rounded-[13px] bg-slate-950 px-4 text-[13px] font-black text-white"
            >
              Review draft
            </button>
          </div>
        </div>
      ) : null}

      {isStaff && draftReviewOpen ? (
        <div className="app-modal-layer fixed inset-0 flex items-end bg-slate-950/45 lg:hidden">
          <div className="max-h-[92vh] w-full overflow-hidden rounded-t-[24px] bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div>
                <div className="text-[17px] font-black text-slate-950">
                  Review request
                </div>
                <div className="mt-1 text-[12px] font-bold text-slate-500">
                  {draftCount} item(s) Â· {formatQty(draftQty)} unit(s)
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDraftReviewOpen(false)}
                className="flex h-10 w-10 items-center justify-center rounded-[12px] border border-slate-300 bg-white text-slate-600"
                aria-label="Close draft review"
              >
                <Icon name="close" sizePx={20} />
              </button>
            </div>
            <div className="max-h-[calc(92vh-66px)] overflow-y-auto p-3">
              <DraftPanel
                items={draftItems}
                cashiers={cashiers}
                customers={customers}
                selectedCashierId={selectedCashierId}
                selectedCustomerId={selectedCustomerId}
                customerName={customerName}
                customerPhone={customerPhone}
                notes={notes}
                sending={sending}
                cashiersLoading={cashiersLoading}
                cashierLoadIssue={cashierLoadIssue}
                onSelectCashier={setSelectedCashierId}
                onSelectCustomer={(customer) => {
                  setSelectedCustomerId(customer?.id || "");
                  setCustomerName(customer?.name || "");
                  setCustomerPhone(customer?.phone || "");
                }}
                onCustomerName={setCustomerName}
                onCustomerPhone={setCustomerPhone}
                onNotes={setNotes}
                onRemoveItem={(productId) =>
                  setDraftItems((current) =>
                    current.filter((item) => item.product.id !== productId),
                  )
                }
                onQtyChange={updateDraftQty}
                onOpenConfirm={() => setConfirmSendOpen(true)}
              />
            </div>
          </div>
        </div>
      ) : null}

      <ProductImagePreviewModal
        product={previewProduct}
        onClose={closeImagePreview}
      />

      <ConfirmDialog
        open={confirmSendOpen}
        title={
          selectedCashier && !selectedCashier.isPresent
            ? "Queue draft request?"
            : "Send draft request?"
        }
        message={
          selectedCashier
            ? selectedCashier.isPresent
              ? `This will send ${draftCount} item(s) to ${selectedCashier.name} for cashier verification.`
              : `${selectedCashier.name} is offline. The request will be queued until they return.`
            : "Choose a cashier before sending this draft request."
        }
        confirmLabel={
          selectedCashier && !selectedCashier.isPresent
            ? "Queue Request"
            : "Send Request"
        }
        tone="primary"
        icon="send"
        busy={sending}
        onClose={() => setConfirmSendOpen(false)}
        onConfirm={sendDraftRequest}
        details={
          <div className="space-y-2 text-[13px] font-bold">
            <div className="flex justify-between gap-3">
              <span>Items</span>
              <span className="font-black text-slate-950">{draftCount}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span>Total quantity</span>
              <span className="font-black text-slate-950">
                {formatQty(draftQty)}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span>Estimate</span>
              <span className="font-mono font-black text-slate-950">
                {formatNpr(draftEstimate)}
              </span>
            </div>
            {selectedCashier?.isPresent && !selectedCashier.hasOpenDrawer ? (
              <div className="rounded-[12px] border border-sky-200 bg-sky-50 px-3 py-2 text-left text-[12px] text-sky-800">
                Their cash session is not open, but this does not prevent
                delivery or review.
              </div>
            ) : selectedCashier && !selectedCashier.isPresent ? (
              <div className="rounded-[12px] border border-amber-200 bg-amber-50 px-3 py-2 text-left text-[12px] text-amber-800">
                If this request is urgent, contact the cashier or choose someone
                who is online.
              </div>
            ) : null}
          </div>
        }
      />

      <SuccessDialog
        open={Boolean(successMessage)}
        title="Draft request sent"
        message={successMessage}
        onClose={() => setSuccessMessage("")}
      />
    </div>
  );
}

function FilterFields({
  brands,
  categories,
  brand,
  category,
  stockStatus,
  onBrand,
  onCategory,
  onStock,
  hideStock = false,
}: {
  brands: string[];
  categories: string[];
  brand: string;
  category: string;
  stockStatus: "all" | "in" | "low" | "out";
  onBrand: (value: string) => void;
  onCategory: (value: string) => void;
  onStock: (value: "all" | "in" | "low" | "out") => void;
  hideStock?: boolean;
}) {
  return (
    <>
      <div className="block">
        <span className="text-[12px] font-black uppercase tracking-wide text-slate-500">
          Brand
        </span>
        <div className="mt-1">
          <CreatableCombobox
            value={brand}
            onChange={onBrand}
            options={brands}
            placeholder="Search brands"
            ariaLabel="Filter by brand"
            allowCreate={false}
            selectOnFocus
          />
        </div>
      </div>
      <div className="block">
        <span className="text-[12px] font-black uppercase tracking-wide text-slate-500">
          Category
        </span>
        <div className="mt-1">
          <CreatableCombobox
            value={category}
            onChange={onCategory}
            options={categories}
            placeholder="Search categories"
            ariaLabel="Filter by category"
            allowCreate={false}
            selectOnFocus
          />
        </div>
      </div>
      {!hideStock ? (
        <label className="block">
          <span className="text-[12px] font-black uppercase tracking-wide text-slate-500">
            Stock
          </span>
          <ProjectSelect
            value={stockStatus}
            onChange={(event) =>
              onStock(event.target.value as "all" | "in" | "low" | "out")
            }
            className="mt-1 h-[42px] w-full rounded-[12px] border border-slate-300 bg-white px-3 text-[13px] font-bold outline-none focus:border-slate-950"
          >
            <option value="all">All status</option>
            <option value="in">In stock</option>
            <option value="low">Low stock</option>
            <option value="out">Out of stock</option>
          </ProjectSelect>
        </label>
      ) : null}
    </>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-black uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div className="mt-1 truncate font-bold text-slate-700">{value}</div>
    </div>
  );
}

function EmptyState({
  onClear,
  filtered,
  query,
}: {
  onClear: () => void;
  filtered: boolean;
  query: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[18px] border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-[18px] bg-slate-100 text-slate-400">
        <Icon name="package_search" sizePx={30} />
      </div>
      <div className="mt-4 text-[16px] font-black text-slate-950">
        {filtered ? "No matching products" : "No products in the catalog"}
      </div>
      <div className="mt-1 text-[13px] font-bold text-slate-500">
        {filtered
          ? query
            ? `Nothing matched “${query}”. Try another name, SKU, barcode, or remove a filter.`
            : "Try removing a brand, category, or stock filter."
          : "Products will appear here after an Admin adds or imports the catalog."}
      </div>
      {filtered ? (
        <button
          type="button"
          onClick={onClear}
          className="mt-4 min-h-11 rounded-[12px] border border-[#CFCFD3] bg-white px-4 text-[13px] font-black text-[#565449] hover:bg-[#F3F4F6]"
        >
          Clear search and filters
        </button>
      ) : null}
    </div>
  );
}
