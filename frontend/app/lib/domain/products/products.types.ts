// display-friendly product status labels
export type ProductStatus = "Active" | "Inactive";

// stock level flags — used for the stock badge on each product row
export type StockFlag = "In Stock" | "Low Stock" | "Out of Stock";

// whether a threshold uses the global default or a custom per-product value
export type ThresholdMode = "default" | "custom";

// the normalized product type used across the frontend
// we transform the backend response into this shape so every component works with consistent field names
export type Product = {
  id: string;
  name: string;
  sku: string;
  barcode?: string;
  imageUrl?: string;

  brand: string; // brand name (not the ID — we resolve it when saving)
  category: string;

  retailPrice: number;
  wholesalePrice: number;
  thresholdQty: number; // wholesale quantity threshold — above this qty, wholesale pricing kicks in
  thresholdQtyMode: ThresholdMode;

  stock: number;
  lowStockThreshold: number; // when stock falls to or below this number, we show a low stock alert
  lowStockThresholdMode: ThresholdMode;

  status: ProductStatus;
};

// toast notification types used by the products page
export type ToastKind = "info" | "success" | "danger";

// the query parameters for fetching products with filters
export type ProductsQuery = {
  q?: string; // search term
  brand?: string; // filter by brand name
  category?: string;
  stockStatus?: "all" | "in" | "low" | "out"; // client-side stock level filter
  status?: "all" | "active" | "inactive"; // active/inactive filter
  lowOnly?: boolean;
  page?: number;
  pageSize?: number;
};

