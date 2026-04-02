import {
  createProductApi,
  deactivateProductApi,
  getCategoriesApi,
  listBrandsApi,
  listProductsApi,
  uploadProductImageApi,
  updateProductApi,
} from "~/lib/api/endpoints";
import type { Product, ProductsQuery, ProductStatus } from "./products.types";

type BackendBrand = { id: string; name: string; isActive?: boolean };
type BackendProduct = {
  id: string;
  name: string;
  sku: string;
  barcode?: string | null;
  brandId?: string;
  brand?: { id: string; name: string } | null;
  category?: string | null;
  retailPrice: number;
  wholesalePrice: number;
  wholesaleQtyThreshold?: number;
  stock: number;
  lowStockThreshold: number;
  imageUrl?: string | null;
  isActive: boolean;
};

let brandsCache: BackendBrand[] = [];

function toFrontendProduct(product: BackendProduct): Product {
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    barcode: product.barcode ?? "",
    imageUrl: product.imageUrl ?? "",
    brand: product.brand?.name ?? "Unknown",
    category: product.category ?? "Uncategorized",
    retailPrice: Number(product.retailPrice ?? 0),
    wholesalePrice: Number(product.wholesalePrice ?? 0),
    thresholdQty: Number(product.wholesaleQtyThreshold ?? 1),
    stock: Number(product.stock ?? 0),
    lowStockThreshold: Number(product.lowStockThreshold ?? 0),
    status: product.isActive ? "Active" : "Inactive",
  };
}

function getBrandIdByName(name?: string): string | undefined {
  if (!name) return undefined;
  return brandsCache.find((brand) => brand.name === name)?.id;
}

function mapStatusToActive(status?: ProductsQuery["status"]): string | undefined {
  if (status === "active") return "true";
  if (status === "inactive") return "false";
  return undefined;
}

function applyClientSideStockFilter(
  products: Product[],
  stockStatus?: ProductsQuery["stockStatus"],
): Product[] {
  switch (stockStatus) {
    case "in":
      return products.filter((product) => product.stock > product.lowStockThreshold);
    case "low":
      return products.filter(
        (product) => product.stock > 0 && product.stock <= product.lowStockThreshold,
      );
    case "out":
      return products.filter((product) => product.stock <= 0);
    default:
      return products;
  }
}

export async function fetchProducts(q: ProductsQuery) {
  const response = await listProductsApi({
    search: q.q,
    brand: getBrandIdByName(q.brand),
    category: q.category,
    active: mapStatusToActive(q.status),
    lowStock: q.lowOnly || q.stockStatus === "low" ? "true" : undefined,
    page: q.page,
    pageSize: q.pageSize,
  });

  const mapped = (response.products ?? []).map(toFrontendProduct);
  const filtered = applyClientSideStockFilter(mapped, q.stockStatus);

  return {
    items: filtered,
    total:
      q.stockStatus && q.stockStatus !== "all"
        ? filtered.length
        : Number(response.total ?? filtered.length),
  };
}

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

function toBackendPayload(product: Omit<Product, "id">) {
  const brandId = getBrandIdByName(product.brand);
  if (!brandId) {
    throw new Error(`Brand not found: ${product.brand}`);
  }

  return {
    name: product.name,
    sku: product.sku,
    barcode: product.barcode || undefined,
    imageUrl: product.imageUrl || null,
    brandId,
    category: product.category || undefined,
    retailPrice: Number(product.retailPrice),
    wholesalePrice: Number(product.wholesalePrice),
    wholesaleQtyThreshold: Number(product.thresholdQty ?? 1),
    stock: Number(product.stock ?? 0),
    lowStockThreshold: Number(product.lowStockThreshold ?? 0),
    isActive: product.status === "Active",
  };
}

export async function createProduct(product: Omit<Product, "id">) {
  const created = await createProductApi(toBackendPayload(product));
  return toFrontendProduct(created);
}

export async function updateProduct(id: string, product: Omit<Product, "id">) {
  const updated = await updateProductApi(id, toBackendPayload(product));
  return toFrontendProduct(updated);
}

export async function uploadProductImage(id: string, file: File) {
  const updated = await uploadProductImageApi(id, file);
  return toFrontendProduct(updated);
}

export async function setProductStatus(id: string, status: ProductStatus) {
  if (status === "Inactive") {
    await deactivateProductApi(id);
    return { ok: true };
  }

  await updateProductApi(id, { isActive: true });
  return { ok: true };
}

export async function bulkSetStatus(ids: string[], status: ProductStatus) {
  await Promise.all(ids.map((id) => setProductStatus(id, status)));
  return { ok: true };
}

