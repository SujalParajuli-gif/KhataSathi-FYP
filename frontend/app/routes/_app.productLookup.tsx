import { useEffect, useMemo, useState } from "react";
import Icon from "~/components/ui/Icon";
import PaginationBar from "~/components/ui/PaginationBar";
import ProductImage from "~/components/ui/ProductImage";
import {
  fetchProducts,
  fetchProductsMeta,
} from "~/lib/domain/products/products.api";
import type { Product } from "~/lib/domain/products/products.types";
import { formatNpr } from "~/lib/invoices";

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function formatQty(value: number) {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function formatSize(product: Product) {
  if (!product.sizeValue || product.sizeUnit === "STANDARD") return "Standard";
  return `${formatQty(product.sizeValue)} ${product.sizeUnit}`;
}

function stockTone(product: Product) {
  if (product.stock <= 0) return "border-rose-200 bg-rose-50 text-rose-700";
  if (product.stock <= product.lowStockThreshold) {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  return "border-emerald-200 bg-emerald-50 text-emerald-700";
}

function stockLabel(product: Product) {
  if (product.stock <= 0) return "Out of Stock";
  if (product.stock <= product.lowStockThreshold) return "Low Stock";
  return "In Stock";
}

function formatPackage(product: Product) {
  return `${formatQty(product.packageQuantity || 1)} ${product.packageUnit || "PIECE"}`;
}

export default function ProductLookupPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [brands, setBrands] = useState<string[]>(["All Brands"]);
  const [categories, setCategories] = useState<string[]>(["All Categories"]);
  const [query, setQuery] = useState("");
  const [brand, setBrand] = useState("All Brands");
  const [category, setCategory] = useState("All Categories");
  const [stockStatus, setStockStatus] = useState<"all" | "in" | "low" | "out">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  async function loadMeta() {
    const meta = await fetchProductsMeta();
    setBrands(["All Brands", ...meta.brands]);
    setCategories(["All Categories", ...meta.categories]);
  }

  async function loadProducts() {
    setLoading(true);
    try {
      const result = await fetchProducts({
        q: query,
        brand,
        category,
        stockStatus,
        status: "active",
        page,
        pageSize,
      });
      setProducts(result.items);
      setTotal(result.total);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadMeta();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadProducts();
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query, brand, category, stockStatus, page, pageSize]);

  useEffect(() => {
    setPage(1);
  }, [query, brand, category, stockStatus]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageStart = total === 0 ? 0 : (page - 1) * pageSize;
  const pageEnd = total === 0 ? 0 : Math.min(total, pageStart + products.length);

  const activeFilters = useMemo(
    () =>
      Boolean(
        query.trim() ||
          brand !== "All Brands" ||
          category !== "All Categories" ||
          stockStatus !== "all",
      ),
    [query, brand, category, stockStatus],
  );

  function clearFilters() {
    setQuery("");
    setBrand("All Brands");
    setCategory("All Categories");
    setStockStatus("all");
    setPage(1);
  }

  return (
    <div className="min-h-full bg-[#F1F1F1] p-[16px] text-[#000000]">
      <div className="space-y-[14px]">
        <div className="rounded-[14px] border border-[#CFCFD3] bg-white">
          <div className="space-y-[14px] p-[16px]">
            <div className="flex flex-col gap-[12px] lg:flex-row lg:items-center">
              <div className="flex-1">
                <div className="flex items-center gap-[8px] rounded-[12px] border border-[#CFCFD3] bg-white px-[12px] py-[10px]">
                <Icon name="search" className="text-slate-400" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search by product name / SKU / barcode / supplier..."
                    className="min-w-0 flex-1 bg-transparent text-[14px] font-medium text-[#000000] outline-none placeholder:text-[#8C8889]"
                />
              </div>
              </div>

              <div className="rounded-full border border-[#CFCFD3] bg-white px-[14px] py-[10px] text-[12px] font-extrabold text-[#565449]">
                {total.toLocaleString()} active products
              </div>
            </div>

            <div className="grid grid-cols-1 gap-[12px] md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_auto]">
            <label className="space-y-2">
                <div className="text-[12px] font-semibold text-[#8C8889]">
                Brand
              </div>
              <select
                value={brand}
                onChange={(event) => setBrand(event.target.value)}
                  className="h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-[12px] text-[14px] text-[#000000] outline-none"
              >
                {brands.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-2">
                <div className="text-[12px] font-semibold text-[#8C8889]">
                Category
              </div>
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                  className="h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-[12px] text-[14px] text-[#000000] outline-none"
              >
                {categories.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-2">
                <div className="text-[12px] font-semibold text-[#8C8889]">
                Stock
              </div>
              <select
                value={stockStatus}
                onChange={(event) => setStockStatus(event.target.value as any)}
                  className="h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-[12px] text-[14px] text-[#000000] outline-none"
              >
                  <option value="all">All</option>
                  <option value="in">In Stock</option>
                  <option value="low">Low Stock</option>
                  <option value="out">Out of Stock</option>
              </select>
            </label>

            <button
              type="button"
              onClick={clearFilters}
              disabled={!activeFilters}
                className="mt-auto inline-flex h-[44px] items-center justify-center gap-[8px] rounded-[12px] border border-[#CFCFD3] bg-white px-[14px] text-[13px] font-semibold text-[#565449] transition hover:bg-[#F3F4F6] disabled:pointer-events-none disabled:opacity-40"
            >
              <Icon name="close" />
              Clear
            </button>
            </div>
          </div>
        </div>

        <div className="rounded-[14px] border border-[#CFCFD3] bg-white">
          <div className="p-[10px]">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1120px] text-left">
                <thead>
                  <tr className="border-b border-[#CFCFD3] text-[12px] font-semibold text-[#8C8889]">
                    <th className="px-[10px] py-[12px]">Product</th>
                    <th className="px-[10px] py-[12px]">Source</th>
                    <th className="px-[10px] py-[12px]">Group / Variant</th>
                    <th className="px-[10px] py-[12px]">Size</th>
                    <th className="px-[10px] py-[12px]">Package</th>
                    <th className="px-[10px] py-[12px]">Retail</th>
                    <th className="px-[10px] py-[12px]">Wholesale</th>
                    <th className="px-[10px] py-[12px]">Stock</th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-[#CFCFD3]">
                  {loading ? (
                    Array.from({ length: 8 }).map((_, index) => (
                      <tr key={index}>
                        <td colSpan={8} className="px-[10px] py-[10px]">
                          <div className="h-[46px] animate-pulse rounded-[10px] bg-slate-100" />
                        </td>
                      </tr>
                    ))
                  ) : products.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-[14px] py-[22px] text-[14px] text-[#8C8889]">
                        No products match your filters.
                      </td>
                    </tr>
                  ) : (
                    products.map((product) => (
                      <tr key={product.id} className="text-[14px]">
                        <td className="px-[10px] py-[14px]">
                          <div className="flex items-center gap-[12px]">
                            <ProductImage
                              src={product.imageUrl}
                              alt={product.name}
                              className="flex h-[48px] w-[48px] items-center justify-center overflow-hidden rounded-[12px] border border-[#CFCFD3] bg-[#F3F4F6]"
                              iconClassName="text-[#8C8889]"
                            />

                            <div className="min-w-0">
                              <div className="max-w-[340px] whitespace-normal break-words font-semibold leading-5 text-[#000000]">
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

                        <td className="px-[10px] py-[14px] text-[#565449]">
                          <div className="max-w-[180px] break-words font-semibold text-[#000000]">
                            {product.vendorSource || product.brand}
                          </div>
                          <div className="mt-[4px] text-[11px] text-[#8C8889]">
                            {product.category || "Uncategorized"}
                          </div>
                        </td>

                        <td className="px-[10px] py-[14px] text-[#565449]">
                          <div className="max-w-[220px] break-words font-semibold text-[#000000]">
                            {product.categoryGroup || product.category || "-"}
                          </div>
                          <div className="mt-[4px] max-w-[220px] break-words text-[11px] text-[#8C8889]">
                            {product.productCodeVariant || "No variant"}
                          </div>
                        </td>

                        <td className="px-[10px] py-[14px] text-[#565449]">
                          <div className="font-semibold text-[#000000]">
                            {formatSize(product)}
                          </div>
                          <div className="mt-[4px] text-[11px] text-[#8C8889]">
                            Sale unit: {product.saleUnit || "PIECE"}
                          </div>
                        </td>

                        <td className="px-[10px] py-[14px] text-[#565449]">
                          <div className="font-semibold text-[#000000]">
                            {formatPackage(product)}
                          </div>
                          <div className="mt-[4px] text-[11px] text-[#8C8889]">
                            Step {formatQty(product.quantityStep || 1)}
                          </div>
                        </td>

                        <td className="px-[10px] py-[14px] font-mono text-[14px] font-semibold text-[#000000]">
                          {formatNpr(product.retailPrice)}
                        </td>

                        <td className="px-[10px] py-[14px] text-[#565449]">
                          <div className="font-mono text-[14px] font-semibold text-[#000000]">
                            {product.wholesaleEligible ? formatNpr(product.wholesalePrice) : "Off"}
                          </div>
                          <div className="mt-[4px] text-[11px] text-[#8C8889]">
                            Qty threshold {formatQty(product.thresholdQty)}
                          </div>
                        </td>

                        <td className="px-[10px] py-[14px]">
                          <div className="flex flex-wrap items-center gap-[8px]">
                            <span
                              className={cn(
                                "h-[8px] w-[8px] rounded-full",
                                product.stock <= 0
                                  ? "bg-rose-500"
                                  : product.stock <= product.lowStockThreshold
                                    ? "bg-orange-500"
                                    : "bg-emerald-500",
                              )}
                            />
                            <div className="font-semibold text-[#000000]">
                              {formatQty(product.stock)} {product.saleUnit || "PIECE"}
                            </div>
                            <span className={`inline-flex rounded-full border px-[10px] py-[4px] text-[12px] font-semibold ${stockTone(product)}`}>
                              {stockLabel(product)}
                            </span>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <PaginationBar
              page={page}
              totalPages={totalPages}
              total={total}
              start={pageStart}
              end={pageEnd}
              label="products"
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPageSize(nextPageSize);
                setPage(1);
              }}
              className="px-[10px]"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
