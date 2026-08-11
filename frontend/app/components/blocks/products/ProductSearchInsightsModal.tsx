import React from "react";
import GoogleIcon from "~/components/ui/GIcon";
import { ModalFrame } from "~/components/ui/Modal";
import ProductImage from "~/components/ui/ProductImage";
import { useToast } from "~/components/ui/Toast";
import {
  createProductSearchAliasApi,
  getProductSearchInsightsApi,
  getSearchAliasProductOptionsApi,
  type ProductSearchInsight,
  type SearchAliasProductOption,
} from "~/lib/api/endpoints";

type UnmatchedSearch = Pick<
  ProductSearchInsight,
  "rawQuery" | "normalizedQuery" | "searches" | "lastSearchedAt"
>;

function mergeUnmatchedSearches(items: ProductSearchInsight[]) {
  const grouped = new Map<string, UnmatchedSearch>();
  for (const item of items) {
    const current = grouped.get(item.normalizedQuery);
    if (!current) {
      grouped.set(item.normalizedQuery, {
        rawQuery: item.rawQuery,
        normalizedQuery: item.normalizedQuery,
        searches: item.searches,
        lastSearchedAt: item.lastSearchedAt,
      });
      continue;
    }
    current.searches += item.searches;
    if (new Date(item.lastSearchedAt) > new Date(current.lastSearchedAt)) {
      current.rawQuery = item.rawQuery;
      current.lastSearchedAt = item.lastSearchedAt;
    }
  }
  return [...grouped.values()]
    .sort(
      (left, right) =>
        right.searches - left.searches ||
        new Date(right.lastSearchedAt).getTime() - new Date(left.lastSearchedAt).getTime(),
    )
    .slice(0, 20);
}

function ProductOption({
  product,
  selected,
  onSelect,
}: {
  product: SearchAliasProductOption;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={`flex min-h-[72px] w-full items-center gap-3 rounded-[13px] border p-2.5 text-left transition duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] ${
        selected
          ? "border-[#16A34A] bg-[#F0FDF4] shadow-sm"
          : "border-[#D9DCE1] bg-white hover:border-[#AEB4BE] hover:bg-[#F8FAFC]"
      }`}
    >
      <ProductImage
        src={product.thumbnailUrl || product.imageUrl}
        alt=""
        className="h-12 w-12 shrink-0 overflow-hidden rounded-[10px] border border-[#E5E7EB] bg-[#F8FAFC]"
        iconSizePx={20}
      />
      <span className="min-w-0 flex-1">
        <span className="block break-words text-[13px] font-extrabold leading-5 text-[#11120d]">
          {product.name}
        </span>
        <span className="mt-0.5 block truncate text-[11px] font-semibold text-[#6B7280]">
          {product.brand?.name || product.category || "No brand"} · SKU {product.sku || "—"}
        </span>
      </span>
      <span
        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          selected ? "bg-[#16A34A] text-white" : "border border-[#CFCFD3] bg-white text-transparent"
        }`}
      >
        <GoogleIcon name="check" className="text-[18px]" />
      </span>
    </button>
  );
}

export default function ProductSearchInsightsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { showToast } = useToast();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [items, setItems] = React.useState<UnmatchedSearch[]>([]);
  const [reviewing, setReviewing] = React.useState<UnmatchedSearch | null>(null);
  const [productQuery, setProductQuery] = React.useState("");
  const [productOptions, setProductOptions] = React.useState<SearchAliasProductOption[]>([]);
  const [productLoading, setProductLoading] = React.useState(false);
  const [productError, setProductError] = React.useState("");
  const [selectedProduct, setSelectedProduct] = React.useState<SearchAliasProductOption | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const closeReview = React.useCallback(() => {
    setReviewing(null);
    setProductQuery("");
    setProductOptions([]);
    setProductError("");
    setSelectedProduct(null);
    setConfirmOpen(false);
  }, []);

  React.useEffect(() => {
    if (!open) {
      closeReview();
      return undefined;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void getProductSearchInsightsApi(30, 100)
      .then((result) => setItems(mergeUnmatchedSearches(result.noResults)))
      .catch((reason: any) => {
        if (!controller.signal.aborted) {
          setError(reason?.response?.data?.error || "Unmatched searches could not be loaded.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [closeReview, open]);

  React.useEffect(() => {
    if (!open || !reviewing) return undefined;
    const query = productQuery.trim();
    if (query.length < 2) {
      setProductOptions([]);
      setProductLoading(false);
      setProductError("");
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setProductLoading(true);
      setProductError("");
      void getSearchAliasProductOptionsApi(query, { signal: controller.signal })
        .then(setProductOptions)
        .catch((reason: any) => {
          if (!controller.signal.aborted) {
            setProductOptions([]);
            setProductError(reason?.response?.data?.error || "Products could not be searched.");
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setProductLoading(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, productQuery, reviewing]);

  function beginReview(item: UnmatchedSearch) {
    setReviewing(item);
    setProductQuery("");
    setProductOptions([]);
    setSelectedProduct(null);
    setProductError("");
  }

  async function linkSearchToProduct() {
    if (!reviewing || !selectedProduct || saving) return;
    try {
      setSaving(true);
      await createProductSearchAliasApi({
        productId: selectedProduct.id,
        alias: reviewing.rawQuery,
      });
      setItems((current) =>
        current.filter((item) => item.normalizedQuery !== reviewing.normalizedQuery),
      );
      showToast(
        "success",
        `“${reviewing.rawQuery}” now finds ${selectedProduct.name}.`,
      );
      closeReview();
    } catch (reason: any) {
      setConfirmOpen(false);
      setProductError(
        reason?.response?.data?.error || "This search could not be linked to the product.",
      );
    } finally {
      setSaving(false);
    }
  }

  const footer = reviewing ? (
    <div className="flex w-full items-center justify-between gap-3">
      <button
        type="button"
        onClick={closeReview}
        className="inline-flex min-h-11 items-center gap-2 rounded-[12px] border border-[#CFCFD3] bg-white px-4 text-[13px] font-extrabold text-[#11120d] transition hover:bg-[#F3F4F6]"
      >
        <GoogleIcon name="arrow_back" className="text-[18px]" />
        Back
      </button>
      <button
        type="button"
        disabled={!selectedProduct}
        onClick={() => setConfirmOpen(true)}
        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[12px] bg-[#11120d] px-5 text-[13px] font-extrabold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:bg-[#D1D5DB]"
      >
        Review link
        <GoogleIcon name="arrow_forward" className="text-[18px]" />
      </button>
    </div>
  ) : (
    <button
      type="button"
      onClick={onClose}
      className="min-h-11 rounded-[12px] bg-[#11120d] px-5 text-[13px] font-extrabold text-white transition hover:bg-black"
    >
      Done
    </button>
  );

  return (
    <>
      <ModalFrame
        open={open}
        onClose={reviewing ? closeReview : onClose}
        title={reviewing ? "Link unmatched search" : "Unmatched searches"}
        description={
          reviewing
            ? "Choose the product this phrase should find."
            : "Connect common shop terms that currently find no products."
        }
        maxWidthClass="max-w-[720px]"
        mobileFullScreen
        footer={footer}
      >
        {reviewing ? (
          <div className="space-y-4">
            <div className="rounded-[14px] border border-[#D9DCE1] bg-[#F8FAFC] p-3.5">
              <div className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-[#64748B]">
                Staff searched for
              </div>
              <div className="mt-1 break-words text-[18px] font-extrabold text-[#11120d]">
                “{reviewing.rawQuery}”
              </div>
              <div className="mt-1 text-[11px] font-semibold text-[#6B7280]">
                Searched {reviewing.searches} {reviewing.searches === 1 ? "time" : "times"} in the last 30 days
              </div>
            </div>

            <div>
              <label htmlFor="unmatched-product-search" className="text-[12px] font-extrabold text-[#11120d]">
                Find the intended product
              </label>
              <div className="relative mt-2">
                <GoogleIcon name="search" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[20px] text-[#6B7280]" />
                <input
                  id="unmatched-product-search"
                  data-modal-initial-focus
                  value={productQuery}
                  onChange={(event) => {
                    setProductQuery(event.target.value);
                    setSelectedProduct(null);
                  }}
                  placeholder="Search actual product name, SKU or barcode"
                  autoComplete="off"
                  className="h-12 w-full rounded-[12px] border border-[#CFCFD3] bg-white pl-11 pr-4 text-[13px] font-semibold text-[#11120d] outline-none transition focus:border-[#2563EB] focus:ring-2 focus:ring-blue-100"
                />
              </div>
            </div>

            {productError ? (
              <div role="alert" className="rounded-[12px] border border-rose-200 bg-rose-50 p-3 text-[12px] font-bold text-rose-700">
                {productError}
              </div>
            ) : null}

            <div role="listbox" aria-label="Matching products" className="space-y-2">
              {productLoading ? (
                Array.from({ length: 3 }).map((_, index) => (
                  <div key={index} className="h-[72px] animate-pulse rounded-[13px] bg-slate-200" />
                ))
              ) : productQuery.trim().length < 2 ? (
                <div className="rounded-[14px] border border-dashed border-[#CFCFD3] bg-[#F8FAFC] px-4 py-8 text-center">
                  <GoogleIcon name="inventory_2" className="text-[28px] text-[#94A3B8]" />
                  <div className="mt-2 text-[12px] font-bold text-[#64748B]">Type at least 2 characters to find the correct product.</div>
                </div>
              ) : productOptions.length ? (
                productOptions.map((product) => (
                  <ProductOption
                    key={product.id}
                    product={product}
                    selected={selectedProduct?.id === product.id}
                    onSelect={() => setSelectedProduct(product)}
                  />
                ))
              ) : (
                <div className="rounded-[14px] border border-dashed border-[#CFCFD3] bg-[#F8FAFC] px-4 py-8 text-center text-[12px] font-bold text-[#64748B]">
                  No active product matches this product search.
                </div>
              )}
            </div>
          </div>
        ) : loading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="h-[76px] animate-pulse rounded-[14px] bg-slate-200" />
            ))}
          </div>
        ) : error ? (
          <div role="alert" className="rounded-[14px] border border-rose-200 bg-rose-50 p-4 text-[12px] font-bold text-rose-700">
            {error}
          </div>
        ) : items.length ? (
          <div className="overflow-hidden rounded-[15px] border border-[#D9DCE1] bg-white">
            {items.map((item) => (
              <article
                key={item.normalizedQuery}
                className="flex min-h-[76px] items-center gap-3 border-b border-[#E5E7EB] px-3 py-3 last:border-b-0 sm:px-4"
              >
                <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] bg-amber-50 text-amber-700">
                  <GoogleIcon name="search_off" className="text-[21px]" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-[14px] font-extrabold leading-5 text-[#11120d]">
                    “{item.rawQuery}”
                  </span>
                  <span className="mt-1 block text-[11px] font-semibold text-[#6B7280]">
                    {item.searches} {item.searches === 1 ? "search" : "searches"} · Last used {new Date(item.lastSearchedAt).toLocaleDateString()}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => beginReview(item)}
                  className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-[11px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-extrabold text-[#11120d] transition hover:border-[#11120d] hover:bg-[#F8FAFC]"
                >
                  Link product
                  <GoogleIcon name="chevron_right" className="text-[18px]" />
                </button>
              </article>
            ))}
          </div>
        ) : (
          <div className="rounded-[16px] border border-dashed border-[#CFCFD3] bg-[#F8FAFC] px-5 py-12 text-center">
            <span className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
              <GoogleIcon name="check_circle" className="text-[27px]" />
            </span>
            <h3 className="mt-3 text-[16px] font-extrabold text-[#11120d]">No unmatched searches</h3>
            <p className="mx-auto mt-1 max-w-sm text-[12px] font-medium leading-5 text-[#6B7280]">
              Searches from the last 30 days are finding products, or no searchable terms have been logged yet.
            </p>
          </div>
        )}
      </ModalFrame>

      <ModalFrame
        open={confirmOpen && Boolean(reviewing && selectedProduct)}
        onClose={() => !saving && setConfirmOpen(false)}
        title="Confirm product link"
        description="Check the phrase and product before changing search behaviour."
        maxWidthClass="max-w-[500px]"
        mobileBottomSheet
        layer="critical"
        footer={(
          <div className="flex w-full items-center justify-end gap-3">
            <button
              type="button"
              disabled={saving}
              onClick={() => setConfirmOpen(false)}
              className="min-h-11 rounded-[12px] border border-[#CFCFD3] bg-white px-4 text-[13px] font-extrabold text-[#11120d] disabled:opacity-60"
            >
              Go back
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={linkSearchToProduct}
              className="inline-flex min-h-11 items-center gap-2 rounded-[12px] bg-[#11120d] px-5 text-[13px] font-extrabold text-white disabled:opacity-60"
            >
              {saving ? "Linking…" : "Confirm link"}
            </button>
          </div>
        )}
      >
        <div className="rounded-[14px] border border-amber-200 bg-amber-50 p-4 text-[13px] font-semibold leading-6 text-amber-950">
          Searching for <strong>“{reviewing?.rawQuery}”</strong> will also find <strong>{selectedProduct?.name}</strong>. Product names and prices will not be changed.
        </div>
      </ModalFrame>
    </>
  );
}
