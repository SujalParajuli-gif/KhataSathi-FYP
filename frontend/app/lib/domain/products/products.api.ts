// frontend/app/lib/domain/products/products.api.ts
import type { Product, ProductsQuery, ProductStatus } from "./products.types";

async function api<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Request failed (${res.status})`);
  }

  return (await res.json()) as T;
}

// Assumed endpoints (backend-ready):
// GET    /api/products?...
// POST   /api/products
// PUT    /api/products/:id
// PATCH  /api/products/:id/status
// POST   /api/products/bulk-status
// GET    /api/products/meta (brands, categories)

export async function fetchProducts(q: ProductsQuery) {
  const sp = new URLSearchParams();
  if (q.q) sp.set("q", q.q);
  if (q.brand) sp.set("brand", q.brand);
  if (q.category) sp.set("category", q.category);
  if (q.stockStatus) sp.set("stockStatus", q.stockStatus);
  if (q.status) sp.set("status", q.status);
  if (typeof q.lowOnly === "boolean") sp.set("lowOnly", String(q.lowOnly));
  if (q.page) sp.set("page", String(q.page));
  if (q.pageSize) sp.set("pageSize", String(q.pageSize));

  return api<{ items: Product[]; total: number }>(`/api/products?${sp.toString()}`);
}

export async function fetchProductsMeta() {
  return api<{ brands: string[]; categories: string[] }>(`/api/products/meta`);
}

export async function createProduct(p: Omit<Product, "id">) {
  return api<Product>(`/api/products`, {
    method: "POST",
    body: JSON.stringify(p),
  });
}

export async function updateProduct(id: string, p: Omit<Product, "id">) {
  return api<Product>(`/api/products/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(p),
  });
}

export async function setProductStatus(id: string, status: ProductStatus) {
  return api<{ ok: true }>(`/api/products/${encodeURIComponent(id)}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export async function bulkSetStatus(ids: string[], status: ProductStatus) {
  return api<{ ok: true }>(`/api/products/bulk-status`, {
    method: "POST",
    body: JSON.stringify({ ids, status }),
  });
}
