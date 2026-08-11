import {
  createProductApi,
  deactivateProductApi,
  getCategoriesApi,
  getProductsByIdsApi,
  getProductDeleteSafetyApi,
  discardStockAndDeleteProductApi,
  listBrandsApi,
  listPriceLookupProductsApi,
  listProductsApi,
  permanentlyDeleteProductApi,
  uploadProductImageApi,
  updateProductApi,
  type ProductDeleteSafety,
} from "~/lib/api/endpoints";
import type { Product, ProductsQuery, ProductStatus } from "./products.types";

// the raw brand shape from the backend API
type BackendBrand = { id: string; name: string; isActive?: boolean };

// the raw product shape from the backend API — fields may differ from our frontend Product type
type BackendProduct = {
  id: string;
  name: string;
  productName?: string | null;
  sku: string;
  barcode?: string | null;
  brandId?: string;
  brand?: { id: string; name: string } | null;
  category?: string | null;
  categoryGroup?: string | null;
  vendorSource?: string | null;
  productCodeVariant?: string | null;
  sizeValue?: number | null;
  sizeUnit?: string | null;
  ratePerPiece?: number | null;
  packageQuantity?: number | null;
  packageUnit?: string | null;
  saleUnit?: string | null;
  allowFractionalQty?: boolean | null;
  quantityStep?: number | null;
  wholesaleEligible?: boolean | null;
  sourceCitation?: string | null;
  retailPrice: number;
  wholesalePrice: number;
  wholesaleQtyThreshold?: number;
  usesDefaultWholesaleQtyThreshold?: boolean;
  stock: number;
  draftRequestedQty?: number;
  effectiveAvailableStock?: number;
  lowStockThreshold: number;
  usesDefaultLowStockThreshold?: boolean;
  imageUrl?: string | null;
  thumbnailUrl?: string | null;
  isActive: boolean;
};

// caching brands locally so we can look up brand IDs by name without making extra API calls
let brandsCache: BackendBrand[] = [];

// converting a backend product into our frontend Product type
// this maps field names and handles nulls/undefineds so the rest of the frontend
// does not need to worry about the backend response format
function toFrontendProduct(product: BackendProduct): Product {
  return {
    id: product.id,
    name: product.name,
    productName: product.productName ?? product.name,
    sku: product.sku,
    barcode: product.barcode ?? "",
    imageUrl: product.imageUrl ?? "",
    thumbnailUrl: product.thumbnailUrl ?? "",
    brand: product.brand?.name ?? "Unknown",
    category: product.category ?? "Uncategorized",
    categoryGroup: product.categoryGroup ?? product.category ?? "",
    vendorSource: product.vendorSource ?? "",
    productCodeVariant: product.productCodeVariant ?? "",
    sizeValue:
      product.sizeValue === null || product.sizeValue === undefined
        ? null
        : Number(product.sizeValue),
    sizeUnit: product.sizeUnit ?? "STANDARD",
    ratePerPiece: Number(product.ratePerPiece ?? product.retailPrice ?? 0),
    packageQuantity: Number(product.packageQuantity ?? 1),
    packageUnit: product.packageUnit ?? "PIECE",
    saleUnit: product.saleUnit ?? "PIECE",
    allowFractionalQty: Boolean(product.allowFractionalQty),
    quantityStep: Number(product.quantityStep ?? 1),
    wholesaleEligible: product.wholesaleEligible ?? true,
    sourceCitation: product.sourceCitation ?? "",
    retailPrice: Number(product.retailPrice ?? 0),
    wholesalePrice: Number(product.wholesalePrice ?? 0),
    thresholdQty: Number(product.wholesaleQtyThreshold ?? 1),
    thresholdQtyMode: product.usesDefaultWholesaleQtyThreshold
      ? "default"
      : "custom",
    stock: Number(product.stock ?? 0),
    draftRequestedQty: Number(product.draftRequestedQty ?? 0),
    effectiveAvailableStock: Number(product.effectiveAvailableStock ?? product.stock ?? 0),
    lowStockThreshold: Number(product.lowStockThreshold ?? 0),
    lowStockThresholdMode: product.usesDefaultLowStockThreshold
      ? "default"
      : "custom",
    status: product.isActive ? "Active" : "Inactive",
  };
}

/** Resolve products that may no longer be on the visible catalog page. */
export async function fetchProductsByIds(
  ids: string[],
  options?: { signal?: AbortSignal },
) {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (uniqueIds.length === 0) return [];

  const chunks: string[][] = [];
  for (let index = 0; index < uniqueIds.length; index += 50) {
    chunks.push(uniqueIds.slice(index, index + 50));
  }

  const responses = await Promise.all(
    chunks.map((chunk) => getProductsByIdsApi(chunk, options)),
  );
  const products = responses.flatMap((response) =>
    (response?.products ?? response ?? []).map(toFrontendProduct),
  );
  const byId = new Map(products.map((product) => [product.id, product]));
  return uniqueIds.map((id) => byId.get(id)).filter(Boolean) as Product[];
}

// looking up a brand's ID from the cached list by its display name
function getBrandIdByName(name?: string): string | undefined {
  if (!name || name === "All Brands") return undefined;
  return brandsCache.find((brand) => brand.name === name)?.id;
}

function mapCategoryFilter(category?: string): string | undefined {
  if (!category || category === "All Categories") return undefined;
  return category;
}

// converting frontend status filter values to the backend's expected "true"/"false" string
function mapStatusToActive(status?: ProductsQuery["status"]): string | undefined {
  if (status === "active") return "true";
  if (status === "inactive") return "false";
  return undefined;
}

// --

// fetching products from the backend and applying filters
// we map the query filters to the backend format so pagination totals stay accurate
export async function fetchProducts(
  q: ProductsQuery,
  options?: { signal?: AbortSignal },
) {
  const response = await listProductsApi({
    search: q.q,
    brand: getBrandIdByName(q.brand),
    category: mapCategoryFilter(q.category),
    active: mapStatusToActive(q.status),
    lowStock: q.lowOnly || q.stockStatus === "low" ? "true" : undefined,
    stockStatus:
      q.stockStatus && q.stockStatus !== "all" ? q.stockStatus : undefined,
    draftReservations: q.includeDraftReservations ? "true" : undefined,
    page: q.page,
    pageSize: q.pageSize,
  }, options);

  const mapped = (response.products ?? []).map(toFrontendProduct);

  return {
    items: mapped,
    total: Number(response.total ?? mapped.length),
    searchLogId: response.searchLogId ? String(response.searchLogId) : null,
  };
}

export async function fetchPriceLookupProducts(
  q: ProductsQuery,
  options?: { signal?: AbortSignal },
) {
  const response = await listPriceLookupProductsApi({
    search: q.q,
    brand: getBrandIdByName(q.brand),
    category: mapCategoryFilter(q.category),
    active: mapStatusToActive(q.status),
    lowStock: q.lowOnly || q.stockStatus === "low" ? "true" : undefined,
    stockStatus:
      q.stockStatus && q.stockStatus !== "all" ? q.stockStatus : undefined,
    draftReservations: q.includeDraftReservations ? "true" : undefined,
    page: q.page,
    pageSize: q.pageSize,
  }, options);

  const mapped = (response.products ?? []).map(toFrontendProduct);
  return {
    items: mapped,
    total: Number(response.total ?? mapped.length),
    searchLogId: response.searchLogId ? String(response.searchLogId) : null,
    visibility: response.visibility,
  };
}

// fetching brands and categories for the filter dropdowns
// we also cache the brands for the brand name to ID lookup used when creating/editing products
export async function fetchProductsMeta() {
  const [brands, categories] = await Promise.all([
    listBrandsApi(false),
    getCategoriesApi(),
  ]);

  brandsCache = Array.isArray(brands) ? brands : [];

  return {
    brands: brandsCache.map((brand) => brand.name),
    categories: Array.isArray(categories) ? categories.filter(Boolean) : [],
  };
}

// converting a frontend Product object back into the format the backend expects for create/update
function toBackendPayload(product: Omit<Product, "id">) {
  const brandId = getBrandIdByName(product.brand);

  return {
    name: product.name,
    productName: product.productName || product.name,
    sku: product.sku,
    barcode: product.barcode || undefined,
    imageUrl: product.imageUrl || null,
    brandId,
    brandName: brandId ? undefined : product.brand,
    category: product.category || undefined,
    categoryGroup: product.categoryGroup || undefined,
    vendorSource: product.vendorSource || undefined,
    productCodeVariant: product.productCodeVariant || undefined,
    sizeValue: product.sizeValue ?? undefined,
    sizeUnit: product.sizeUnit || "STANDARD",
    ratePerPiece: Number(product.ratePerPiece || product.retailPrice),
    packageQuantity: Number(product.packageQuantity || 1),
    packageUnit: product.packageUnit || "PIECE",
    saleUnit: product.saleUnit || "PIECE",
    allowFractionalQty: Boolean(product.allowFractionalQty),
    quantityStep: Number(product.quantityStep || 1),
    wholesaleEligible: Boolean(product.wholesaleEligible),
    sourceCitation: product.sourceCitation || undefined,
    retailPrice: Number(product.retailPrice),
    wholesalePrice: Number(product.wholesalePrice),
    wholesaleQtyThreshold: Number(product.thresholdQty ?? 1),
    usesDefaultWholesaleQtyThreshold: product.thresholdQtyMode === "default",
    stock: Number(product.stock ?? 0),
    lowStockThreshold: Number(product.lowStockThreshold ?? 0),
    usesDefaultLowStockThreshold:
      product.lowStockThresholdMode === "default",
    isActive: product.status === "Active",
  };
}

// creating a new product and returning the frontend-normalized version
export async function createProduct(product: Omit<Product, "id">) {
  const created = await createProductApi(toBackendPayload(product));
  return toFrontendProduct(created);
}

// updating an existing product and returning the frontend-normalized version
export async function updateProduct(id: string, product: Omit<Product, "id">) {
  const payload = toBackendPayload(product);
  delete (payload as { stock?: number }).stock;
  const updated = await updateProductApi(id, payload);
  return toFrontendProduct(updated);
}

// uploading a product image and returning the updated product
export async function uploadProductImage(id: string, file: File) {
  const updated = await uploadProductImageApi(id, file);
  return toFrontendProduct(updated);
}

// activating or deactivating a product by its ID
export async function setProductStatus(id: string, status: ProductStatus) {
  if (status === "Inactive") {
    const result = await deactivateProductApi(id);
    return {
      ok: true,
      changed: Boolean(result?.changed),
      message: result?.message || "Product set to Inactive.",
    };
  }

  const updated = await updateProductApi(id, { isActive: true });
  return {
    ok: true,
    changed: true,
    product: toFrontendProduct(updated),
    message: "Product activated.",
  };
}

// bulk updating the status of multiple products at once
export async function bulkSetStatus(ids: string[], status: ProductStatus) {
  const results = await Promise.all(ids.map((id) => setProductStatus(id, status)));
  return {
    ok: true,
    changedCount: results.filter((result) => result.changed).length,
    skippedCount: results.filter((result) => !result.changed).length,
  };
}

export async function getProductDeleteSafety(id: string): Promise<ProductDeleteSafety> {
  return getProductDeleteSafetyApi(id);
}

export async function permanentlyDeleteProduct(id: string) {
  return permanentlyDeleteProductApi(id);
}

export async function discardStockAndDeleteProduct(id: string) {
  return discardStockAndDeleteProductApi(id);
}
