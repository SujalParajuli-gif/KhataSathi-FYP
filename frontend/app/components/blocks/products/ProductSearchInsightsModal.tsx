import React from "react";
import GoogleIcon from "~/components/ui/GIcon";
import { ModalFrame } from "~/components/ui/Modal";
import ProductImage from "~/components/ui/ProductImage";
import { useToast } from "~/components/ui/Toast";
import {
  createProductSearchAliasApi,
  getProductSearchInsightsApi,
  getSearchAliasProductOptionsApi,
  previewSearchSynonymPromotionApi,
  promoteSearchSynonymApi,
  type ProductSearchInsight,
  type SearchAliasProductOption,
  type SearchSynonymPromotionPreview,
} from "~/lib/api/endpoints";

type UnmatchedSearch = Pick<
  ProductSearchInsight,
  "rawQuery" | "normalizedQuery" | "searches" | "lastSearchedAt"
>;

type MatchScope = "TYPE" | "PRODUCT";

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
        fallbackSrc={product.thumbnailUrl ? product.imageUrl : undefined}
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

function ProductMatchPreview({ product }: { product: SearchAliasProductOption }) {
  return (
    <div className="flex min-h-[62px] items-center gap-3 rounded-[12px] border border-[#E5E7EB] bg-white p-2.5">
      <ProductImage
        src={product.thumbnailUrl || product.imageUrl}
        fallbackSrc={product.thumbnailUrl ? product.imageUrl : undefined}
        alt=""
        className="h-10 w-10 shrink-0 overflow-hidden rounded-[9px] border border-[#E5E7EB] bg-[#F8FAFC]"
        iconSizePx={18}
      />
      <span className="min-w-0 flex-1">
        <span className="block break-words text-[12px] font-extrabold leading-5 text-[#11120d]">{product.name}</span>
        <span className="block truncate text-[10px] font-semibold text-[#64748B]">
          {product.brand?.name || product.category || "No brand"} · SKU {product.sku || "—"}
        </span>
      </span>
    </div>
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
  const [matchScope, setMatchScope] = React.useState<MatchScope>("TYPE");
  const [canonicalTerm, setCanonicalTerm] = React.useState("");
  const [synonymPreview, setSynonymPreview] = React.useState<SearchSynonymPromotionPreview | null>(null);
  const [synonymLoading, setSynonymLoading] = React.useState(false);
  const [synonymError, setSynonymError] = React.useState("");
  const [productQuery, setProductQuery] = React.useState("");
  const [productOptions, setProductOptions] = React.useState<SearchAliasProductOption[]>([]);
  const [productLoading, setProductLoading] = React.useState(false);
  const [productError, setProductError] = React.useState("");
  const [selectedProduct, setSelectedProduct] = React.useState<SearchAliasProductOption | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const closeReview = React.useCallback(() => {
    setReviewing(null);
    setMatchScope("TYPE");
    setCanonicalTerm("");
    setSynonymPreview(null);
    setSynonymLoading(false);
    setSynonymError("");
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
    if (!open || !reviewing || matchScope !== "PRODUCT") return undefined;
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
  }, [matchScope, open, productQuery, reviewing]);

  React.useEffect(() => {
    if (!open || !reviewing || matchScope !== "TYPE") return undefined;
    const canonical = canonicalTerm.trim();
    if (canonical.length < 2) {
      setSynonymPreview(null);
      setSynonymLoading(false);
      setSynonymError("");
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSynonymLoading(true);
      setSynonymError("");
      void previewSearchSynonymPromotionApi(
        { alias: reviewing.rawQuery, canonicalTerm: canonical },
        { signal: controller.signal },
      )
        .then(setSynonymPreview)
        .catch((reason: any) => {
          if (!controller.signal.aborted) {
            setSynonymPreview(null);
            setSynonymError(reason?.response?.data?.error || "The product-type rule could not be previewed.");
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setSynonymLoading(false);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [canonicalTerm, matchScope, open, reviewing]);

  function beginReview(item: UnmatchedSearch) {
    setReviewing(item);
    setMatchScope("TYPE");
    setCanonicalTerm("");
    setSynonymPreview(null);
    setSynonymError("");
    setProductQuery("");
    setProductOptions([]);
    setSelectedProduct(null);
    setProductError("");
  }

  function changeScope(scope: MatchScope) {
    setMatchScope(scope);
    setConfirmOpen(false);
    setProductError("");
    setSynonymError("");
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

  async function linkSearchToProductType() {
    if (!reviewing || !synonymPreview || synonymPreview.totalMatches < 1 || saving) return;
    try {
      setSaving(true);
      const result = await promoteSearchSynonymApi({
        alias: reviewing.rawQuery,
        canonicalTerm: synonymPreview.canonicalTerm,
      });
      setItems((current) =>
        current.filter((item) => item.normalizedQuery !== reviewing.normalizedQuery),
      );
      const replacement = result.disabledProductAliasCount
        ? ` Replaced ${result.disabledProductAliasCount} exact-product link${result.disabledProductAliasCount === 1 ? "" : "s"}.`
        : "";
      showToast(
        "success",
        `“${reviewing.rawQuery}” now finds all matching ${synonymPreview.canonicalTerm} products.${replacement}`,
      );
      closeReview();
    } catch (reason: any) {
      setConfirmOpen(false);
      setSynonymError(
        reason?.response?.data?.error || "This product-type rule could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  const synonymConflict = Boolean(
    synonymPreview?.existingSynonym &&
    synonymPreview.existingSynonym.normalizedCanonicalTerm !== synonymPreview.normalizedCanonicalTerm,
  );
  const canReview = matchScope === "TYPE"
    ? Boolean(synonymPreview && synonymPreview.totalMatches > 0 && !synonymConflict)
    : Boolean(selectedProduct);

  const footer = reviewing ? (
    <div className="flex w-full items-center justify-between gap-3">
      <button
        type="button"
        onClick={closeReview}
        className="inline-flex h-11 items-center gap-2 rounded-[12px] border border-[#CFCFD3] bg-white px-4 text-[13.5px] font-extrabold text-[#0F172A] shadow-2xs transition hover:bg-[#F8FAFC]"
      >
        <GoogleIcon name="arrow_back" className="text-[18px]" />
        Back
      </button>
      <button
        type="button"
        disabled={!canReview}
        onClick={() => setConfirmOpen(true)}
        className="inline-flex h-11 items-center justify-center gap-2 rounded-[12px] bg-[#0F172A] px-5 text-[13.5px] font-extrabold text-white shadow-2xs transition hover:bg-black disabled:cursor-not-allowed disabled:bg-[#CBD5E1] disabled:text-[#94A3B8]"
      >
        Review {matchScope === "TYPE" ? "rule" : "link"}
        <GoogleIcon name="arrow_forward" className="text-[18px]" />
      </button>
    </div>
  ) : (
    <div className="flex w-full justify-end">
      <button
        type="button"
        onClick={onClose}
        className="h-11 rounded-[12px] bg-[#0F172A] px-6 text-[13.5px] font-extrabold text-white shadow-2xs transition hover:bg-black"
      >
        Done
      </button>
    </div>
  );

  return (
    <>
      <ModalFrame
        open={open}
        onClose={reviewing ? closeReview : onClose}
        title={reviewing ? "Fix unmatched search" : "Unmatched searches"}
        description={
          reviewing
            ? "Choose whether this phrase means a product type or one exact product."
            : "Connect common shop terms that currently find no products."
        }
        maxWidthClass="max-w-[720px]"
        mobileBottomSheet
        footer={footer}
      >
        {reviewing ? (
          <div className="space-y-4">
            {/* Staff Search Query Card */}
            <div className="rounded-[16px] border border-[#E2E8F0] bg-[#F8FAFC] p-4 shadow-2xs">
              <div className="text-[11px] font-black uppercase tracking-wider text-[#64748B]">
                Staff searched for
              </div>
              <div className="mt-1 break-words text-[22px] font-black leading-tight text-[#0F172A]">
                “{reviewing.rawQuery}”
              </div>
              <div className="mt-1.5 flex items-center gap-2 text-[12px] font-bold text-[#64748B]">
                <span className="rounded-md bg-amber-100/80 px-2 py-0.5 text-amber-900">
                  {reviewing.searches} {reviewing.searches === 1 ? "search" : "searches"}
                </span>
                <span>in the last 30 days</span>
              </div>
            </div>

            {/* Scope Selection Radios */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Search match scope">
              <button
                type="button"
                role="radio"
                aria-checked={matchScope === "TYPE"}
                onClick={() => changeScope("TYPE")}
                className={`min-h-[82px] rounded-[14px] border p-3.5 text-left transition ${
                  matchScope === "TYPE"
                    ? "border-2 border-emerald-500 bg-emerald-50/70 shadow-2xs ring-2 ring-emerald-500/20"
                    : "border-[#E2E8F0] bg-white hover:border-[#CBD5E1] hover:bg-[#F8FAFC]"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-[13.5px] font-extrabold text-[#0F172A]">
                    <GoogleIcon name="category" className="text-[19px] text-emerald-700" />
                    Product type
                  </span>
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-emerald-800">
                    Recommended
                  </span>
                </div>
                <span className="mt-1.5 block text-[12px] font-medium leading-4 text-[#64748B]">
                  Finds every matching product under this category or keyword, including future stock.
                </span>
              </button>

              <button
                type="button"
                role="radio"
                aria-checked={matchScope === "PRODUCT"}
                onClick={() => changeScope("PRODUCT")}
                className={`min-h-[82px] rounded-[14px] border p-3.5 text-left transition ${
                  matchScope === "PRODUCT"
                    ? "border-2 border-emerald-500 bg-emerald-50/70 shadow-2xs ring-2 ring-emerald-500/20"
                    : "border-[#E2E8F0] bg-white hover:border-[#CBD5E1] hover:bg-[#F8FAFC]"
                }`}
              >
                <div className="flex items-center gap-2 text-[13.5px] font-extrabold text-[#0F172A]">
                  <GoogleIcon name="inventory_2" className="text-[19px] text-blue-700" />
                  One exact product
                </div>
                <span className="mt-1.5 block text-[12px] font-medium leading-4 text-[#64748B]">
                  Directly links this query string to a single specific product item.
                </span>
              </button>
            </div>

            {matchScope === "TYPE" ? (
              <div className="space-y-3">
                <div>
                  <label htmlFor="unmatched-canonical-term" className="text-[13px] font-black text-[#0F172A]">
                    What product type or keyword does “{reviewing.rawQuery}” mean?
                  </label>
                  <div className="relative mt-1.5">
                    <GoogleIcon name="search" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[20px] text-[#64748B]" />
                    <input
                      id="unmatched-canonical-term"
                      data-modal-initial-focus
                      value={canonicalTerm}
                      onChange={(event) => {
                        setCanonicalTerm(event.target.value);
                        setSynonymPreview(null);
                      }}
                      placeholder="Example: basin, stool, bottle..."
                      autoComplete="off"
                      className="h-12 w-full rounded-[12px] border border-[#CBD5E1] bg-white pl-11 pr-4 text-[14px] font-semibold text-[#0F172A] outline-none transition focus:border-[#087F83] focus:ring-2 focus:ring-[#087F83]/15"
                    />
                  </div>
                </div>

                {synonymError ? (
                  <div role="alert" className="rounded-[12px] border border-rose-200 bg-rose-50 p-3 text-[12.5px] font-bold text-rose-700">
                    {synonymError}
                  </div>
                ) : null}

                {synonymLoading ? (
                  <div className="h-[112px] animate-pulse rounded-[14px] bg-slate-200" />
                ) : canonicalTerm.trim().length < 2 ? (
                  <div className="rounded-[14px] border border-dashed border-[#CBD5E1] bg-[#F8FAFC] px-4 py-7 text-center text-[12.5px] font-bold text-[#64748B]">
                    Type a common keyword already used in product names (such as <span className="font-extrabold text-[#0F172A]">basin</span> or <span className="font-extrabold text-[#0F172A]">stool</span>).
                  </div>
                ) : synonymPreview ? (
                  <div className={`rounded-[14px] border p-4 shadow-2xs ${
                    synonymConflict || synonymPreview.totalMatches === 0
                      ? "border-amber-200 bg-amber-50"
                      : "border-emerald-200 bg-emerald-50/70"
                  }`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-[15px] font-black text-[#0F172A]">
                          {synonymPreview.totalMatches} matching {synonymPreview.totalMatches === 1 ? "product" : "products"} found
                        </div>
                        <div className="mt-1 text-[12px] font-semibold leading-relaxed text-[#475569]">
                          Searching for <strong className="text-[#0F172A]">“{reviewing.rawQuery}”</strong> will now match any product titled <strong className="text-[#0F172A]">“{synonymPreview.canonicalTerm}”</strong>.
                        </div>
                      </div>
                      <GoogleIcon
                        name={synonymPreview.totalMatches > 0 && !synonymConflict ? "check_circle" : "warning"}
                        className={`text-[24px] ${synonymPreview.totalMatches > 0 && !synonymConflict ? "text-emerald-700" : "text-amber-700"}`}
                      />
                    </div>

                    {synonymPreview.existingSynonym && synonymConflict ? (
                      <div className="mt-3 rounded-[10px] bg-white/90 p-3 text-[12px] font-bold text-amber-900 shadow-2xs">
                        This phrase already maps to “{synonymPreview.existingSynonym.canonicalTerm}”. Edit or disable that rule before changing its meaning.
                      </div>
                    ) : null}

                    {synonymPreview.linkedProductAliases.length ? (
                      <div className="mt-3 rounded-[10px] bg-white/90 p-3 text-[12px] font-bold text-[#334155] shadow-2xs">
                        Saving will replace {synonymPreview.linkedProductAliases.length} existing exact-product link{synonymPreview.linkedProductAliases.length === 1 ? "" : "s"} with this broader rule.
                      </div>
                    ) : null}

                    {synonymPreview.products.length ? (
                      <div className="mt-3.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {synonymPreview.products.slice(0, 4).map((product) => (
                          <ProductMatchPreview key={product.id} product={product} />
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <label htmlFor="unmatched-product-search" className="text-[13px] font-black text-[#0F172A]">
                    Find the intended exact product
                  </label>
                  <div className="relative mt-1.5">
                    <GoogleIcon name="search" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[20px] text-[#64748B]" />
                    <input
                      id="unmatched-product-search"
                      data-modal-initial-focus
                      value={productQuery}
                      onChange={(event) => {
                        setProductQuery(event.target.value);
                        setSelectedProduct(null);
                      }}
                      placeholder="Search product name, SKU or barcode"
                      autoComplete="off"
                      className="h-12 w-full rounded-[12px] border border-[#CBD5E1] bg-white pl-11 pr-4 text-[14px] font-semibold text-[#0F172A] outline-none transition focus:border-[#087F83] focus:ring-2 focus:ring-[#087F83]/15"
                    />
                  </div>
                </div>

                {productError ? (
                  <div role="alert" className="rounded-[12px] border border-rose-200 bg-rose-50 p-3 text-[12.5px] font-bold text-rose-700">
                    {productError}
                  </div>
                ) : null}

                <div role="listbox" aria-label="Matching products" className="space-y-2">
                  {productLoading ? (
                    Array.from({ length: 3 }).map((_, index) => (
                      <div key={index} className="h-[72px] animate-pulse rounded-[13px] bg-slate-200" />
                    ))
                  ) : productQuery.trim().length < 2 ? (
                    <div className="rounded-[14px] border border-dashed border-[#CBD5E1] bg-[#F8FAFC] px-4 py-7 text-center text-[12.5px] font-bold text-[#64748B]">
                      Type at least 2 characters to search and choose the target product.
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
                    <div className="rounded-[14px] border border-dashed border-[#CBD5E1] bg-[#F8FAFC] px-4 py-7 text-center text-[12.5px] font-bold text-[#64748B]">
                      No active products match this query.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : loading ? (
          <div className="space-y-2.5">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-[76px] animate-pulse rounded-[14px] bg-slate-200" />
            ))}
          </div>
        ) : error ? (
          <div role="alert" className="rounded-[14px] border border-rose-200 bg-rose-50 p-4 text-[12.5px] font-bold text-rose-700">
            {error}
          </div>
        ) : items.length ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between px-1 text-[12.5px] font-bold text-[#64748B]">
              <span>Terms staff searched for with zero results</span>
              <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-extrabold text-amber-900">
                {items.length} Pending
              </span>
            </div>

            <div className="overflow-hidden rounded-[16px] border border-[#E2E8F0] divide-y divide-[#F1F5F9] bg-white shadow-2xs">
              {items.map((item) => (
                <article
                  key={item.normalizedQuery}
                  className="flex items-center gap-3.5 p-3.5 transition hover:bg-[#F8FAFC] sm:p-4"
                >
                  <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] border border-amber-200/70 bg-amber-50 text-amber-700">
                    <GoogleIcon name="search_off" className="text-[22px]" />
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="break-words text-[16px] font-black leading-snug text-[#0F172A]">
                      “{item.rawQuery}”
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[11.5px] font-semibold text-[#64748B]">
                      <span className="rounded-md bg-[#F1F5F9] px-2 py-0.5 font-bold text-[#334155]">
                        {item.searches} {item.searches === 1 ? "search" : "searches"}
                      </span>
                      <span>·</span>
                      <span>Last searched {new Date(item.lastSearchedAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => beginReview(item)}
                    className="inline-flex h-9 shrink-0 items-center gap-1 rounded-[10px] bg-[#0F172A] px-3.5 text-[12px] font-extrabold text-white shadow-2xs transition hover:bg-black"
                  >
                    <span>Fix search</span>
                    <GoogleIcon name="chevron_right" className="text-[16px]" />
                  </button>
                </article>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-[16px] border border-dashed border-[#CBD5E1] bg-[#F8FAFC] px-5 py-12 text-center">
            <span className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
              <GoogleIcon name="check_circle" className="text-[28px]" />
            </span>
            <h3 className="mt-3 text-[16px] font-black text-[#0F172A]">No unmatched searches</h3>
            <p className="mx-auto mt-1 max-w-sm text-[12.5px] font-medium leading-relaxed text-[#64748B]">
              All staff search terms in the last 30 days are successfully finding products in your catalog.
            </p>
          </div>
        )}
      </ModalFrame>

      <ModalFrame
        open={confirmOpen && Boolean(reviewing && canReview)}
        onClose={() => !saving && setConfirmOpen(false)}
        title={matchScope === "TYPE" ? "Confirm product-type rule" : "Confirm product link"}
        description={matchScope === "TYPE" ? "Check how broadly this phrase will work before saving." : "Check the phrase and product before changing search behaviour."}
        maxWidthClass="max-w-[500px]"
        mobileBottomSheet
        layer="critical"
        footer={(
          <div className="flex w-full items-center justify-end gap-3">
            <button
              type="button"
              disabled={saving}
              onClick={() => setConfirmOpen(false)}
              className="h-11 rounded-[12px] border border-[#CBD5E1] bg-white px-4 text-[13.5px] font-extrabold text-[#0F172A] shadow-2xs hover:bg-[#F8FAFC] disabled:opacity-60"
            >
              Go back
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={matchScope === "TYPE" ? linkSearchToProductType : linkSearchToProduct}
              className="inline-flex h-11 items-center gap-2 rounded-[12px] bg-[#0F172A] px-5 text-[13.5px] font-extrabold text-white shadow-2xs hover:bg-black disabled:opacity-60"
            >
              {saving ? "Saving…" : matchScope === "TYPE" ? "Save rule" : "Confirm link"}
            </button>
          </div>
        )}
      >
        {matchScope === "TYPE" ? (
          <div className="space-y-3">
            <div className="rounded-[14px] border border-emerald-200 bg-emerald-50 p-4 text-[13px] font-semibold leading-relaxed text-emerald-950 shadow-2xs">
              Searching for <strong>“{reviewing?.rawQuery}”</strong> will behave like <strong>“{synonymPreview?.canonicalTerm}”</strong> and currently find <strong>{synonymPreview?.totalMatches || 0} products</strong>.
            </div>
            {synonymPreview?.linkedProductAliases.length ? (
              <div className="rounded-[14px] border border-amber-200 bg-amber-50 p-4 text-[12px] font-semibold leading-relaxed text-amber-950 shadow-2xs">
                This replaces {synonymPreview.linkedProductAliases.length} exact-product link{synonymPreview.linkedProductAliases.length === 1 ? "" : "s"}, so the phrase is no longer limited to one item.
              </div>
            ) : null}
            <p className="text-[11.5px] font-semibold leading-relaxed text-[#64748B]">
              Product names and prices will not be changed. Newly added products containing this product type will also be searchable through the phrase.
            </p>
          </div>
        ) : (
          <div className="rounded-[14px] border border-amber-200 bg-amber-50 p-4 text-[13px] font-semibold leading-relaxed text-amber-950 shadow-2xs">
            Searching for <strong>“{reviewing?.rawQuery}”</strong> will also find <strong>{selectedProduct?.name}</strong>. Product names and prices will not be changed.
          </div>
        )}
      </ModalFrame>
    </>
  );
}
