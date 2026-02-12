// frontend/app/lib/domain/products/products.types.ts
export type ProductStatus = "Active" | "Inactive";
export type StockFlag = "In Stock" | "Low Stock" | "Out of Stock";

export type Product = {
  id: string;
  name: string;
  sku: string;
  barcode?: string;
  imageUrl?: string;

  brand: string;
  category: string;

  retailPrice: number;
  wholesalePrice: number;
  thresholdQty: number;

  stock: number;
  lowStockThreshold: number;

  status: ProductStatus;
};

export type ToastKind = "info" | "success" | "danger";

export type ProductsQuery = {
  q?: string;
  brand?: string;
  category?: string;
  stockStatus?: "all" | "in" | "low" | "out";
  status?: "all" | "active" | "inactive";
  lowOnly?: boolean;
  page?: number;
  pageSize?: number;
};
